/**
 * Owns collaboration hosting for one interactive process: manual `/collab`,
 * the opt-in `collab.autoStart` policy, and room rotation when the active
 * session changes.
 *
 * Every room this process hosts shares one random `instanceId` and gets the
 * next `generation`, which is what the local registry keys capabilities by.
 * A session change stops the current room — withdrawing its registry entry
 * and telling guests goodbye — before a replacement room for the new session
 * is started, so a card that names generation N can never reach session N+1.
 */
import { randomBytes } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import type { AutoBotPredecessorFallback, AutoBotRestartTarget, JsonValue } from "../autobot-update/contract";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import type { InteractiveModeContext } from "../modes/types";
import { TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	CollabHost,
	CollabHostStoppedError,
	CollabUnavailableError,
	type CollabConnectionState,
	type CollabPreparedRestart,
	type CollabRestartDeferReason,
	type CollabStopReason,
} from "./host";
import type { CollabAccess } from "./registry";

export type CollabAutoStart = "off" | CollabAccess;

const SESSION_SWITCH_REASON =
	"session switched; prompts not shown in the conversation were not submitted. Rejoin and resend them";

type CollabDiagnosticCode = CollabUnavailableError["code"] | "collab-host-stopped" | "unknown";

function collabDiagnosticCode(error: unknown): CollabDiagnosticCode {
	if (error instanceof CollabUnavailableError) return error.code;
	if (error instanceof CollabHostStoppedError) return "collab-host-stopped";
	return "unknown";
}

function jsonRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Readonly<Record<string, JsonValue>>;
}

function fallbackCollabState(value: JsonValue): CollabAutoBotFallbackState | undefined {
	const root = jsonRecord(value);
	const record = root && jsonRecord(root.collab);
	if (!record || Object.keys(record).some(key => key !== "wasHosting" && key !== "access")) return undefined;
	const wasHosting = record.wasHosting;
	const access = record.access;
	if (typeof wasHosting !== "boolean") return undefined;
	if (wasHosting) {
		if (access !== "view" && access !== "control") return undefined;
		return { wasHosting: true, access };
	}
	if (access !== undefined) return undefined;
	return { wasHosting: false };
}

function sameAutoBotTarget(left: AutoBotRestartTarget, right: AutoBotRestartTarget): boolean {
	return (
		left.releaseSequence === right.releaseSequence &&
		left.upstreamVersion === right.upstreamVersion &&
		left.forkCommit === right.forkCommit &&
		left.sessionFormatVersion === right.sessionFormatVersion &&
		left.collabProtocolVersion === right.collabProtocolVersion &&
		left.compatibilityEpoch === right.compatibilityEpoch &&
		left.webBundleId === right.webBundleId &&
		left.handoffBudgetMs === right.handoffBudgetMs
	);
}

export interface CollabStartOptions {
	/** Highest access the registry may hand out for the new room. */
	access: CollabAccess;
	/** Relay override (`host[:port]` or a full URL); defaults to `collab.relayUrl`. */
	relay?: string;
	/** Web UI override; defaults to `collab.webUrl`. */
	webUrl?: string;
}

/** Result for extension-facing control-hosting requests. */
export interface CollabEnsureResult {
	host: CollabHost;
	reused: boolean;
}

export type CollabUpdateTarget = Pick<
	AutoBotRestartTarget,
	"releaseSequence" | "collabProtocolVersion" | "webBundleId"
>;

/** Signed, token-free browser state needed to re-open a predecessor room after candidate fallback. */
export type CollabAutoBotFallbackState =
	| { readonly wasHosting: false; readonly access?: never }
	| { readonly wasHosting: true; readonly access: CollabAccess };

export type CollabUpdateDeferReason =
	| CollabRestartDeferReason
	| "controller-shutdown"
	| "reservation-active"
	| "target-incompatible";

export type CollabUpdateSafety = { safe: true } | { safe: false; reason: CollabUpdateDeferReason };

const collabUpdateReservation = Symbol("collab-update-reservation");

/** Opaque, in-process admission capability; it must never be serialized into a handoff. */
export interface CollabUpdateReservation {
	readonly [collabUpdateReservation]: true;
}

export type CollabUpdatePreparationResult =
	| { kind: "prepared"; reservation: CollabUpdateReservation }
	| { kind: "deferred"; reason: CollabUpdateDeferReason };

interface PreparedCollabUpdate {
	readonly host: CollabHost | undefined;
	readonly hostPreparation: CollabPreparedRestart | undefined;
	readonly sessionId: string;
	readonly target: CollabUpdateTarget;
	readonly deadline: number;
	timer: Timer;
	cancelled: boolean;
	committing: boolean;
}

const COLLAB_UPDATE_RESERVATION_TIMEOUT_MS = 15_000;
const WEB_BUNDLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export class CollabController {
	readonly instanceId: string;
	#ctx: InteractiveModeContext;
	#generation = 0;
	#host: CollabHost | undefined;
	/** Serializes stop/start sequences so a rotation never interleaves with another. */
	#ops: Promise<void> = Promise.resolve();
	/** A bounded, opaque reservation prevents a new room from racing an update handoff. */
	#preparedUpdates = new Map<CollabUpdateReservation, PreparedCollabUpdate>();
	/** Explicit stop invalidates launch requests, not the saved auto-start policy. */
	#stopEpoch = 0;
	/** Installed when the first room starts; a process that never hosts never subscribes. */
	#unsubscribeSessionChange: (() => void) | undefined;
	/** Guests may drive the session only once interactive startup has finished. */
	#startupComplete = false;
	/** Protected replacement startup cannot allocate or publish a room before authorization. */
	#hostCreationFencedUntilStartupComplete = false;
	/** Normal auto-start resumes after a protected startup unless fallback restores a no-host policy. */
	#resumeAutoStartAfterStartupFence = false;
	/** A predecessor fallback restores its captured hosting policy rather than the current setting. */
	#suppressAutoStartAfterStartupFence = false;
	/** A user stop revokes automatic hosting for this session until a manual start or session switch. */
	#hostCreationRevoked = false;
	#shutdown = false;
	#shutdownWake: PromiseWithResolvers<void> | undefined;
	/** Coalesces concurrent extension ensure requests; the first request supplies the URLs. */
	#ensurePromise: Promise<CollabEnsureResult> | undefined;
	/** Hosts that completed startup and therefore owe extension lifecycle events. */
	#startedHosts = new WeakSet<CollabHost>();
	/** Serializes lifecycle emission so stopped follows started for the same host. */
	#lifecycleTail: Promise<void> = Promise.resolve();
	/** Prevents a started handler awaiting host.stop() from deadlocking its stopped event. */
	#lifecycleDispatchDepth = 0;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
		// 64 random bits: unique per process on one machine, short enough for `omp collab link <id>` and socket paths.
		this.instanceId = randomBytes(8).toString("hex");
	}

	/** The live room for the current session; stale or ending rooms are absent. */
	get host(): CollabHost | undefined {
		const host = this.#host;
		return host && !host.ending && host.sessionId === this.#ctx.sessionManager.getSessionId() ? host : undefined;
	}

	/** Registry generation of the most recently started room; 0 before the first. */
	get generation(): number {
		return this.#generation;
	}

	get autoStartMode(): CollabAutoStart {
		return this.#ctx.settings.get("collab.autoStart");
	}

	/**
	 * Hold all new host creation through protected startup. Call this before
	 * extension hooks run; {@link startupComplete} is the sole release point.
	 */
	deferHostCreationUntilStartupComplete(): void {
		if (this.#startupComplete || this.#shutdown) return;
		this.#hostCreationFencedUntilStartupComplete = true;
		this.#resumeAutoStartAfterStartupFence = true;
	}

	/** Capture only the prior room policy; room keys, guest state, and links never leave Browser ownership. */
	captureAutoBotFallbackState(): CollabAutoBotFallbackState {
		const host = this.host;
		return host ? { wasHosting: true, access: host.access } : { wasHosting: false };
	}

	/**
	 * Reopen exactly the predecessor's browser room policy after the protected
	 * coordinator fallback has restored its old owner. The signed launch
	 * context carries only the token-free descriptor created above.
	 */
	async restorePredecessorFallback(fallback: AutoBotPredecessorFallback): Promise<boolean> {
		const state = fallbackCollabState(fallback.request.context);
		if (
			!state ||
			this.#shutdown ||
			this.#ctx.collabGuest ||
			this.#ctx.session.isSessionTransitioning ||
			this.#preparedUpdates.size > 0 ||
			fallback.request.sessionId !== this.#ctx.sessionManager.getSessionId() ||
			!sameAutoBotTarget(fallback.request.target, fallback.request.predecessorTarget) ||
			sameAutoBotTarget(fallback.request.target, fallback.attemptedTarget) ||
			!this.#targetSafety(fallback.request.target).safe
		) {
			return false;
		}
		// The broker has already restored this authenticated predecessor before
		// invoking us. Keep its exact policy when startup later releases the fence.
		this.#suppressAutoStartAfterStartupFence = true;
		const existing = this.host;
		const stopExisting = async (reason: string): Promise<void> => {
			if (!existing) return;
			try {
				await this.#stopHost(existing, reason, "user");
			} catch (error) {
				if (!existing.stopped) throw error;
				logger.warn("Collab predecessor fallback stop completed after lifecycle handler failure", {
					stage: "predecessor-fallback-stop",
					generation: this.#generation,
					code: collabDiagnosticCode(error),
				});
			}
		};
		try {
			if (!state.wasHosting) {
				await stopExisting("restoring predecessor without collaboration");
				return this.host === undefined;
			}
			if (existing?.access === state.access) return true;
			await stopExisting("restoring predecessor collaboration access");
			await this.#start({ access: state.access }, true);
			return this.host?.access === state.access;
		} catch (error) {
			logger.warn("Collab predecessor fallback restoration failed", {
				stage: "predecessor-fallback",
				generation: this.#generation,
				code: collabDiagnosticCode(error),
			});
			return false;
		}
	}

	/**
	 * Browser-owned admission check for an automatic runtime replacement. The
	 * opaque reservation returned by prepareUpdate binds the checked release
	 * facts to the exact live room without exposing guest state to the runtime.
	 */
	canPrepareUpdate(target: CollabUpdateTarget): CollabUpdateSafety {
		if (this.#shutdown) return { safe: false, reason: "controller-shutdown" };
		if (this.#ctx.collabGuest) return { safe: false, reason: "guest-incompatible" };
		if (this.#preparedUpdates.size > 0) return { safe: false, reason: "reservation-active" };
		const targetSafety = this.#targetSafety(target);
		if (!targetSafety.safe) return targetSafety;
		const host = this.host;
		if (host) return host.canPrepareRestart();
		return this.#localRestartSafety();
	}

	async prepareUpdate(
		target: CollabUpdateTarget,
		deadlineMonotonicMs: number,
	): Promise<CollabUpdatePreparationResult> {
		const safety = this.canPrepareUpdate(target);
		if (!safety.safe) return { kind: "deferred", reason: safety.reason };
		const remainingMs = Math.floor(deadlineMonotonicMs - performance.now());
		if (
			!Number.isFinite(deadlineMonotonicMs) ||
			remainingMs <= 0 ||
			remainingMs > COLLAB_UPDATE_RESERVATION_TIMEOUT_MS
		) {
			return { kind: "deferred", reason: "preparation-expired" };
		}

		const host = this.host;
		let hostPreparation: CollabPreparedRestart | undefined;
		if (host) {
			const prepared = await host.prepareRestart(deadlineMonotonicMs);
			if (prepared.kind === "deferred") return prepared;
			hostPreparation = prepared.preparation;
		}

		const localSafety = this.#localRestartSafety();
		if (
			this.#shutdown ||
			this.#preparedUpdates.size > 0 ||
			this.host !== host ||
			performance.now() >= deadlineMonotonicMs ||
			!localSafety.safe ||
			!this.#targetSafety(target).safe
		) {
			hostPreparation && host?.cancelPreparedRestart(hostPreparation, "unsafe");
			if (this.#shutdown) return { kind: "deferred", reason: "controller-shutdown" };
			if (this.#preparedUpdates.size > 0) return { kind: "deferred", reason: "reservation-active" };
			if (this.host !== host) return { kind: "deferred", reason: "host-unavailable" };
			if (performance.now() >= deadlineMonotonicMs) return { kind: "deferred", reason: "preparation-expired" };
			if (!localSafety.safe) return { kind: "deferred", reason: localSafety.reason };
			return { kind: "deferred", reason: "target-incompatible" };
		}

		const reservation = { [collabUpdateReservation]: true } as CollabUpdateReservation;
		const prepared: PreparedCollabUpdate = {
			host,
			hostPreparation,
			sessionId: this.#ctx.sessionManager.getSessionId(),
			target: Object.freeze({
				releaseSequence: target.releaseSequence,
				collabProtocolVersion: target.collabProtocolVersion,
				webBundleId: target.webBundleId,
			}),
			deadline: deadlineMonotonicMs,
			timer: undefined as unknown as Timer,
			cancelled: false,
			committing: false,
		};
		this.#preparedUpdates.set(reservation, prepared);
		prepared.timer = setTimeout(
			() => this.#expirePreparedUpdate(reservation),
			Math.max(1, Math.floor(deadlineMonotonicMs - performance.now())),
		);
		return { kind: "prepared", reservation };
	}

	/** Release an uncommitted reservation and thaw every guest that acknowledged it. */
	cancelPreparedUpdate(reservation: CollabUpdateReservation): void {
		this.#discardPreparedUpdate(reservation, "aborted");
	}

	/**
	 * Commit the exact prior admission after the replacement runtime is ready.
	 * The host rechecks guest state synchronously immediately before teardown.
	 */
	async commitPreparedUpdate(reservation: CollabUpdateReservation, reason: string): Promise<boolean> {
		const prepared = this.#preparedUpdates.get(reservation);
		if (!prepared || prepared.committing) return false;
		prepared.committing = true;
		const stopReason =
			typeof reason === "string" && reason.trim().length > 0 ? reason.trim().slice(0, 160) : "runtime update";
		const committed = this.#ops.then(async () => {
			if (
				prepared.cancelled ||
				this.#preparedUpdates.get(reservation) !== prepared ||
				this.#shutdown ||
				performance.now() >= prepared.deadline ||
				!this.#targetSafety(prepared.target).safe
			) {
				return false;
			}
			const localSafety = this.#localRestartSafety();
			if (!localSafety.safe || this.#ctx.sessionManager.getSessionId() !== prepared.sessionId) return false;

			if (!prepared.host) {
				if (this.host) return false;
				this.#forgetPreparedUpdate(reservation);
				return true;
			}
			if (this.host !== prepared.host || !prepared.hostPreparation) return false;
			if (!prepared.host.commitPreparedRestart(prepared.hostPreparation)) return false;
			this.#forgetPreparedUpdate(reservation);
			try {
				await this.#stopHost(prepared.host, stopReason, "user");
			} catch (error) {
				if (!prepared.host.stopped) throw error;
				logger.warn("Collab update stopped host after lifecycle handler failure", {
					stage: "update-stop-lifecycle",
					generation: this.#generation,
					code: collabDiagnosticCode(error),
				});
			}
			return true;
		});
		this.#ops = committed.then(
			() => {},
			() => {},
		);
		try {
			return await committed;
		} finally {
			if (this.#preparedUpdates.get(reservation) === prepared) this.#discardPreparedUpdate(reservation, "unsafe");
		}
	}

	#targetSafety(target: CollabUpdateTarget): CollabUpdateSafety {
		if (
			typeof target !== "object" ||
			target === null ||
			!Number.isSafeInteger(target.releaseSequence) ||
			target.releaseSequence <= 0 ||
			!Number.isSafeInteger(target.collabProtocolVersion) ||
			target.collabProtocolVersion <= 0 ||
			typeof target.webBundleId !== "string" ||
			!WEB_BUNDLE_ID_PATTERN.test(target.webBundleId)
		) {
			return { safe: false, reason: "target-incompatible" };
		}
		return { safe: true };
	}

	#localRestartSafety(): CollabUpdateSafety {
		if (this.#ctx.collabGuest) return { safe: false, reason: "guest-incompatible" };
		const session = this.#ctx.session;
		if (session.isSessionTransitioning) return { safe: false, reason: "session-transition" };
		if (session.isStreaming || session.isAborting || session.queuedMessageCount > 0)
			return { safe: false, reason: "session-busy" };
		return { safe: true };
	}

	#expirePreparedUpdate(reservation: CollabUpdateReservation): void {
		this.#discardPreparedUpdate(reservation, "expired");
	}

	#forgetPreparedUpdate(reservation: CollabUpdateReservation): void {
		const prepared = this.#preparedUpdates.get(reservation);
		if (!prepared) return;
		clearTimeout(prepared.timer);
		this.#preparedUpdates.delete(reservation);
	}

	#discardPreparedUpdate(
		reservation: CollabUpdateReservation,
		reason: "aborted" | "expired" | "unsafe",
	): void {
		const prepared = this.#preparedUpdates.get(reservation);
		if (!prepared) return;
		prepared.cancelled = true;
		this.#forgetPreparedUpdate(reservation);
		if (prepared.host && prepared.hostPreparation) {
			prepared.host.cancelPreparedRestart(prepared.hostPreparation, reason);
		}
	}

	#cancelAllPreparedUpdates(reason: "aborted" | "unsafe"): void {
		for (const reservation of [...this.#preparedUpdates.keys()]) {
			this.#discardPreparedUpdate(reservation, reason);
		}
	}

	/**
	 * Apply `collab.autoStart` for the current session. The room object is
	 * installed synchronously so dialogs raised before the relay connects are
	 * retained for the first writer; the connection itself proceeds in the
	 * background and a failure is reported without disturbing the session.
	 * Until {@link startupComplete} is called, guests can join and answer
	 * dialogs but cannot prompt, interrupt, or command agents.
	 */
	autoStart(): void {
		// Observe session changes from now on even when auto-start is currently
		// off: the setting is read live, so enabling it later applies to the
		// next `/new`, `/resume`, or branch without restarting omp.
		this.#observeSessionChanges();
		if (this.#hostCreationRevoked) return;
		if (this.#hostCreationFencedUntilStartupComplete) {
			this.#resumeAutoStartAfterStartupFence = true;
			return;
		}
		const access = this.autoStartMode;
		if (access === "off" || this.#shutdown || this.host || this.#ctx.collabGuest || this.#preparedUpdates.size > 0)
			return;
		const started = this.#launchReporting(access, this.#stopEpoch);
		this.#ops = this.#ops.then(() => started);
	}

	/** Admit hosting only for a restored local identity, preserving later stop/shutdown intent. */
	resumeAfterGuest(restoration: Promise<boolean>): void {
		if (this.#shutdown || this.#hostCreationRevoked) return;
		if (this.#hostCreationFencedUntilStartupComplete) {
			this.#resumeAutoStartAfterStartupFence = true;
			return;
		}
		this.#observeSessionChanges();
		const stopEpoch = this.#stopEpoch;
		const shutdown = (this.#shutdownWake ??= Promise.withResolvers<void>()).promise;
		// The guest reports restoration failures to its caller/UI. Observe them
		// here only to prevent hosting; shutdown must not await a stalled hook.
		const restored = Promise.race([restoration.catch(() => false), shutdown]);
		this.#ops = this.#ops.then(async () => {
			if ((await restored) !== true) return;
			if (this.#hostCreationRevoked) return;
			if (this.#hostCreationFencedUntilStartupComplete) {
				this.#resumeAutoStartAfterStartupFence = true;
				return;
			}
			if (
				this.#shutdown ||
				stopEpoch !== this.#stopEpoch ||
				this.host ||
				this.#ctx.collabGuest ||
				this.#preparedUpdates.size > 0
			)
				return;
			const access = this.autoStartMode;
			if (access !== "off") await this.#launchReporting(access, stopEpoch);
		});
	}

	/**
	 * Interactive startup (extension hooks, mode reconciliation) has finished:
	 * from now on guests in any room of this process may drive the session.
	 */
	startupComplete(): void {
		if (this.#startupComplete) return;
		this.#startupComplete = true;
		if (!this.#hostCreationFencedUntilStartupComplete) return;
		this.#hostCreationFencedUntilStartupComplete = false;
		const resumeAutoStart =
			this.#resumeAutoStartAfterStartupFence &&
			!this.#suppressAutoStartAfterStartupFence &&
			!this.#hostCreationRevoked;
		this.#resumeAutoStartAfterStartupFence = false;
		this.#suppressAutoStartAfterStartupFence = false;
		if (resumeAutoStart) this.autoStart();
	}

	#observeSessionChanges(): void {
		this.#unsubscribeSessionChange ??= this.#ctx.session.registerSessionChangeCallback(() =>
			this.#onSessionChanged(),
		);
	}

	#assertHostCreationAllowed(authorizedDuringStartupFence: boolean): void {
		if (this.#hostCreationRevoked) throw new CollabUnavailableError("stopped");
		if (this.#hostCreationFencedUntilStartupComplete && !authorizedDuringStartupFence) {
			throw new CollabUnavailableError("startup-fenced");
		}
	}

	/**
	 * Start (or reuse) a room for `/collab`. A live room already granting at
	 * least the requested access is reused; a view-only room is replaced when
	 * control is requested.
	 */
	async start(options: CollabStartOptions): Promise<CollabHost> {
		// `/collab` is the explicit user override for a prior stop.
		this.#hostCreationRevoked = false;
		return this.#start(options, false);
	}

	/** The authenticated predecessor fallback is the only protected-startup caller that may reopen a room. */
	async #start(options: CollabStartOptions, authorizedDuringStartupFence: boolean): Promise<CollabHost> {
		if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
		if (this.#ctx.collabGuest) throw new CollabHostStoppedError("collab guest owns the session");
		this.#assertHostCreationAllowed(authorizedDuringStartupFence);
		const existing = this.host;
		if (existing && (existing.access === "control" || options.access === "view")) return existing;
		this.#cancelAllPreparedUpdates("unsafe");
		const stopEpoch = this.#stopEpoch;
		// Abort an in-flight or stale room before queuing behind its startup.
		const stopping =
			this.#host &&
			this.#stopHost(this.#host, existing ? "restarting with control access" : SESSION_SWITCH_REASON, "user");
		const started = this.#ops.then(async () => {
			await stopping;
			if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
			if (stopEpoch !== this.#stopEpoch) throw new CollabHostStoppedError("collab controller stopped");
			// A preceding manual start or rotation may have installed a room while
			// this request waited. Reuse or upgrade it rather than racing its launch.
			const current = this.host;
			if (current && (current.access === "control" || options.access === "view")) return current;
			if (current) await this.#stopHost(current, "restarting with control access", "user");
			return this.#launch(
				options.access,
				stopEpoch,
				options.relay,
				options.webUrl,
				authorizedDuringStartupFence,
			);
		});
		// Report manual failures to the caller without poisoning later rotations.
		this.#ops = started.then(
			() => {},
			() => {},
		);
		return started;
	}


	async ensure(options: CollabStartOptions): Promise<CollabEnsureResult> {
		// Extension ensure is automatic authority and must never override `/collab stop`.
		if (this.#hostCreationRevoked) throw new CollabUnavailableError("stopped");
		const existing = this.host;
		if (existing?.access === "control") return { host: existing, reused: true };
		const pending = this.#ensurePromise;
		if (pending) {
			const { host } = await pending;
			return { host, reused: true };
		}
		const started: Promise<CollabEnsureResult> = this.#start({ ...options, access: "control" }, false).then(host => ({
			host,
			reused: false,
		}));
		this.#ensurePromise = started;
		try {
			return await started;
		} finally {
			if (this.#ensurePromise === started) this.#ensurePromise = undefined;
		}
	}

	/** Cancel pending launches and stop the current room, including a stop already in flight. */
	async stop(reason: string, stopReason: CollabStopReason = "user"): Promise<void> {
		if (stopReason === "user") {
			// A no-host stop still needs the next session identity transition to clear this revocation.
			this.#observeSessionChanges();
			// The stop is an authority revocation even when no host was ever created.
			this.#hostCreationRevoked = true;
			this.#resumeAutoStartAfterStartupFence = false;
		}
		this.#cancelAllPreparedUpdates("aborted");
		this.#stopEpoch++;
		if (this.#host) await this.#stopHost(this.#host, reason, stopReason);
	}

	async #stopHost(host: CollabHost, reason: string, stopReason: CollabStopReason = "user"): Promise<void> {
		try {
			await host.stop(reason, stopReason);
		} finally {
			// A completed teardown may reject on its final UI update. Do not
			// make every later operation await that same cached rejection.
			if (host.stopped && this.#host === host) this.#host = undefined;
		}
	}


	/** Resolves once no stop/start sequence is in flight. */
	idle(): Promise<void> {
		return this.#ops;
	}

	/** Stop hosting for good; no further rooms are started for this process. */
	async shutdown(reason: string): Promise<void> {
		this.#cancelAllPreparedUpdates("aborted");
		this.#shutdown = true;
		this.#shutdownWake?.resolve();
		this.#unsubscribeSessionChange?.();
		this.#unsubscribeSessionChange = undefined;
		// Stop before draining the chain: a room still connecting is aborted at
		// once instead of holding shutdown for the relay connect timeout.
		await this.stop(reason, "shutdown");
		await this.#ops;
		if (this.#lifecycleDispatchDepth === 0) await this.#lifecycleTail;
	}

	#resolveRelayUrl(relay?: string): string {
		const input = relay?.trim() || this.#ctx.settings.get("collab.relayUrl") || "";
		if (!input) {
			throw new Error(
				"No relay configured. Set collab.relayUrl in /settings or pass one: /collab relay.example.com",
			);
		}
		// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
		return input.includes("://") ? input : `wss://${input}`;
	}

	/**
	 * Install the next room synchronously at ordinary startup so early dialogs
	 * can be retained. During a session transition, wait for its final identity
	 * and state first. Connect only after the previous room is fully gone.
	 */
	async #launch(
		access: CollabAccess,
		stopEpoch: number,
		relay?: string,
		webUrl?: string,
		authorizedDuringStartupFence = false,
	): Promise<CollabHost> {
		if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
		if (stopEpoch !== this.#stopEpoch) throw new CollabHostStoppedError("collab controller stopped");
		this.#assertHostCreationAllowed(authorizedDuringStartupFence);
		// Identity cleanup callbacks can precede awaited hooks and message replacement.
		// Pin and expose only the session left after commit or rollback.
		if (this.#ctx.session.isSessionTransitioning) {
			const shutdown = (this.#shutdownWake ??= Promise.withResolvers<void>()).promise;
			await Promise.race([this.#ctx.session.waitForSessionTransition(), shutdown]);
		}
		// Manual upgrades may reach this after awaiting the old room's stop.
		// Shutdown or an explicit stop may have overtaken either wait.
		if (this.#shutdown) throw new CollabHostStoppedError("collab controller shut down");
		if (stopEpoch !== this.#stopEpoch) throw new CollabHostStoppedError("collab controller stopped");
		if (this.#ctx.collabGuest) throw new CollabHostStoppedError("collab guest owns the session");
		this.#assertHostCreationAllowed(authorizedDuringStartupFence);
		const relayUrl = this.#resolveRelayUrl(relay);
		const resolvedWebUrl = webUrl ?? this.#ctx.settings.get("collab.webUrl") ?? "";
		this.#observeSessionChanges();
		const previous = this.#host;
		const host = new CollabHost(this.#ctx, {
			instanceId: this.instanceId,
			generation: ++this.#generation,
			access,
			guestActionsReady: () => this.#startupComplete && !this.#ctx.session.isSessionTransitioning,
			onStopped: (stoppedHost, reason) => this.#handleHostStopped(stoppedHost, reason),
			onConnectionState: (changedHost, state) => this.#handleHostConnectionState(changedHost, state),
		});
		this.#host = host;
		this.#ctx.collabHost = host;
		try {
			// A previous room may still be withdrawing subscriptions and registry
			// state after a fatal close. Finish that before installing new taps.
			if (previous) await this.#stopHost(previous, "replaced", "user");
			await host.start(relayUrl, resolvedWebUrl);
			await this.#markHostStarted(host);
		} catch (err) {
			if (!host.stopped) {
				const stopReason: CollabStopReason =
					host.sessionId === this.#ctx.sessionManager.getSessionId() ? "connection-failed" : "session-switch";
				try {
					await this.#stopHost(host, "collab launch failed", stopReason);
				} catch (cleanupError) {
					logger.warn("Collab failed launch cleanup failed", {
						stage: "launch-cleanup",
						generation: this.#generation,
						code: collabDiagnosticCode(cleanupError),
					});
				}
			}
			if (this.#host === host) this.#host = undefined;
			if (this.#ctx.collabHost === host) this.#ctx.collabHost = undefined;
			throw err;
		}
		return host;
	}

	async #markHostStarted(host: CollabHost): Promise<void> {
		if (this.#host !== host || host.ending || host.sessionId !== this.#ctx.sessionManager.getSessionId()) {
			throw new CollabHostStoppedError("collab host stopped before lifecycle startup completed");
		}
		this.#startedHosts.add(host);
		const emission = this.#enqueueLifecycle(async () => {
			await this.#ctx.session.extensionRunner?.emit(
				Object.freeze({
					type: "collab_started" as const,
					link: host.link,
					webLink: host.webLink,
					viewLink: host.viewLink,
					webViewLink: host.webViewLink,
					hostId: host.hostId,
					sessionId: host.sessionId,
				}),
			);
		});
		// A lifecycle handler may synchronously replace this room. Waiting for the
		// successor's queued started event here would make that handler await itself.
		if (this.#lifecycleDispatchDepth > 0) return;
		await emission;
		if (this.#host !== host || host.ending || host.sessionId !== this.#ctx.sessionManager.getSessionId()) {
			await this.#lifecycleTail;
			throw new CollabHostStoppedError("collab host stopped while started handlers were running");
		}
	}

	#handleHostStopped(host: CollabHost, reason: CollabStopReason): void | Promise<void> {
		this.#cancelAllPreparedUpdates("unsafe");
		if (this.#host === host) this.#host = undefined;
		if (!this.#startedHosts.delete(host)) return;
		const emission = this.#enqueueLifecycle(async () => {
			await this.#ctx.session.extensionRunner?.emit(
				Object.freeze({
					type: "collab_stopped" as const,
					link: host.link,
					webLink: host.webLink,
					viewLink: host.viewLink,
					webViewLink: host.webViewLink,
					hostId: host.hostId,
					sessionId: host.sessionId,
					reason,
				}),
			);
		});
		return this.#lifecycleDispatchDepth > 0 ? undefined : emission;
	}

	#handleHostConnectionState(host: CollabHost, state: CollabConnectionState): void {
		if (
			this.#host !== host ||
			host.ending ||
			host.sessionId !== this.#ctx.sessionManager.getSessionId() ||
			!this.#startedHosts.has(host)
		) {
			return;
		}
		void this.#enqueueLifecycle(async () => {
			await this.#ctx.session.extensionRunner?.emit(
				Object.freeze({
					type: "collab_connection_state" as const,
					hostId: host.hostId,
					sessionId: host.sessionId,
					state,
				}),
			);
		});
	}

	#enqueueLifecycle(action: () => Promise<void>): Promise<void> {
		const queued = this.#lifecycleTail.then(async () => {
			this.#lifecycleDispatchDepth++;
			try {
				await action();
			} finally {
				this.#lifecycleDispatchDepth--;
			}
		});
		this.#lifecycleTail = queued.catch(error => {
			logger.warn("Collab lifecycle handler failed", {
				stage: "lifecycle-handler",
				generation: this.#generation,
				code: collabDiagnosticCode(error),
			});
		});
		return queued;
	}

	/**
	 * Background start: a failure is logged and shown, never thrown. A room
	 * that this controller (or `/collab stop`) deliberately stopped while it
	 * was still connecting — session switch, access upgrade, shutdown — is not
	 * a failure; its replacement, if any, is already on its way.
	 */
	async #launchReporting(access: CollabAccess, stopEpoch: number): Promise<void> {
		try {
			await this.#launch(access, stopEpoch);
		} catch (err) {
			if (
				err instanceof CollabUnavailableError &&
				(err.code === "collab-startup-fenced" || err.code === "collab-stopped")
			) {
				if (err.code === "collab-startup-fenced") this.#resumeAutoStartAfterStartupFence = true;
				return;
			}
			this.#reportFailure(err);
		}
	}

	#reportFailure(err: unknown): void {
		if (this.#shutdown || err instanceof CollabHostStoppedError) return;
		logger.warn("Collab auto-start failed", {
			stage: "auto-start",
			generation: this.#generation,
			code: err instanceof CollabUnavailableError ? err.code : "unknown",
		});
		const message = sanitizeDisplayLine(err instanceof Error ? err.message : String(err));
		this.#ctx.showStatus(truncateToWidth(`Collab auto-start failed: ${message}`, TRUNCATE_LENGTHS.LINE), {
			dim: true,
		});
	}

	/**
	 * The session this process drives changed identity (new, resume, fork,
	 * branch). The old room is already inert — the host refuses frames and
	 * queries for a session it never shared — so stop it, then apply the
	 * auto-start policy to the new session.
	 */
	#onSessionChanged(): void {
		// A user stop belongs only to the prior session; the configured auto-start
		// policy applies again after a real session identity transition.
		this.#hostCreationRevoked = false;
		this.#cancelAllPreparedUpdates("unsafe");
		const previous = this.#host;
		if (this.host) return;
		const stopEpoch = this.#stopEpoch;
		// Stop synchronously so a room still connecting is aborted now rather than
		// after the queued start settles; the chain then waits for that stop.
		const stopping = previous && this.#stopHost(previous, SESSION_SWITCH_REASON, "session-switch");
		this.#ops = this.#ops
			.then(async () => {
				await stopping;
				if (
					this.#shutdown ||
					stopEpoch !== this.#stopEpoch ||
					this.host ||
					this.#ctx.collabGuest ||
					this.#preparedUpdates.size > 0
				)
					return;
				if (this.#hostCreationFencedUntilStartupComplete) {
					this.#resumeAutoStartAfterStartupFence = true;
					return;
				}
				const access = this.autoStartMode;
				if (access !== "off") await this.#launchReporting(access, stopEpoch);
			})
			.catch(err => this.#reportFailure(err));
	}
}
