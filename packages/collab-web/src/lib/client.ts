/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the relay socket, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * applied frame, so React change detection is reference equality all the way.
 */

import { COLLAB_RESTART_CAPABILITY_UPDATE, COLLAB_RESTART_PREPARATION_CAPABILITY } from "@oh-my-pi/pi-wire";
import type {
	AgentSnapshot,
	AssistantMessage,
	CollabRestartBlockReason,
	CollabUiRequest,
	CollabUiResponseValue,
	GuestFrame,
	HostFrame,
	LiveInput,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import { importRoomKey } from "./codec";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink } from "./link";
import {
	createEditorDraftCapabilityFingerprint,
	createManualDraftScope,
	type RestartDraftScope,
} from "./restart-drafts";
import { CollabSocket } from "./socket";

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export type LiveInputStopReason = Extract<GuestFrame, { t: "live-input-stop" }>["reason"];
export type LiveOutputChunkFrame = Extract<HostFrame, { t: "live-output-chunk" }>;

export type LiveInputLeaseStatus = "idle" | "claiming" | "granted" | "busy" | "read-only" | "unavailable" | "revoked";

export interface LiveInputLeaseState {
	status: LiveInputLeaseStatus;
	requestId: string | null;
	leaseId: string | null;
	message: string | null;
	started: boolean;
}

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** Whether the host's realtime voice mode is currently active. */
	liveActive: boolean;
	/** Input currently feeding live voice; host-local and browser-remote remain distinct. */
	liveInput: LiveInput;
	/** This peer's browser microphone claim/lease state. */
	liveInputLease: LiveInputLeaseState;
	/** True when this guest joined through a read-only (view) link. */
	readOnly: boolean;
	/** Pending host-side UI request (`ask` select/editor) this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Host-confirmed restart preparation freezes guest mutations until resolved. */
	restartPreparing: boolean;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
}

export interface GuestRestartPreparation {
	readonly requestId: string;
	readonly sessionId: string;
	readonly leaseMs: number;
}

export type GuestRestartPreparationResult =
	| { readonly status: "ready" }
	| { readonly status: "blocked"; readonly reason: CollabRestartBlockReason };

export interface GuestRestartPreparationHandler {
	prepare(request: GuestRestartPreparation): GuestRestartPreparationResult | Promise<GuestRestartPreparationResult>;
	/**
	 * `preserve` retains an already-written local backup after a disconnected
	 * old host; `discard` is used for a normal abort, expiry, or manual leave.
	 */
	cancel(requestId: string, disposition: "discard" | "preserve"): void;
}

interface ActiveRestartPreparation {
	readonly request: GuestRestartPreparation;
	cancelDisposition: "discard" | "preserve" | undefined;
	readonly deadline: number;
	readonly handler: GuestRestartPreparationHandler;
	timer: Timer;
}

const MAX_NOTICES = 50;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/** Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk must make progress. */
const MAX_RESTART_PREPARATION_LEASE_MS = 15_000;
const RESTART_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;
const PCM_FRAME_BASE64URL_LENGTH = 854;
const IDLE_LIVE_INPUT_LEASE: LiveInputLeaseState = {
	status: "idle",
	requestId: null,
	leaseId: null,
	message: null,
	started: false,
};

/**
 * One fetch-transcript round trip.
 * - `rows`: decoded JSONL from `fromByte`; `newSize` is the next offset base.
 * - `error`: terminal read failure reported by the host (unchanged cursor);
 *   callers must surface it and stop polling instead of hot retrying.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: Timer;
}

export class GuestClient {
	readonly #draftScopeLink: string;
	readonly #socket: CollabSocket;
	readonly #name: string;
	/** base64url write token from a full link; absent when joined via a view link. */
	readonly #writeToken: string | undefined;
	readonly #listeners = new Set<() => void>();
	readonly #liveOutputListeners = new Set<(frame: LiveOutputChunkFrame) => void>();
	#hostCapabilityUpdateSupported = false;
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	#reqSeq = 0;
	#liveRequestSeq = 0;
	#hostRestartCapable = false;
	#restartPreparationEnabled = false;
	#restartDirty = false;
	#restartHandler: GuestRestartPreparationHandler | undefined;
	#restartPreparation: ActiveRestartPreparation | undefined;
	#uiRequestEndedHandler: ((reqId: number) => void) | undefined;
	#noticeSeq = 0;
	#everConnected = false;
	#welcomed = false;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;
	readonly #canceledLiveClaims = new Map<string, LiveInputStopReason>();

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	#entries: SessionEntry[] = [];
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#working = false;
	#readOnly = false;
	#liveActive = false;
	#liveInput: LiveInput = "none";
	#liveInputLease: LiveInputLeaseState = IDLE_LIVE_INPUT_LEASE;
	#uiRequest: CollabUiRequest | null = null;
	#uiRequestQueue: CollabUiRequest[] = [];
	#notices: readonly Notice[] = [];
	#snapshot: GuestSnapshot;
	/**
	 * Published entries array, cached across commits: rebuilt only when
	 * `#entries` is mutated (welcome/snapshot-chunk/entry frames). Every
	 * other frame (streaming message_update, state, bus, agents) reuses the
	 * same reference, so entry-identity consumers (Transcript memo,
	 * useSyncExternalStore) skip their O(n) scans per token.
	 */
	#publishedEntries: readonly SessionEntry[] = [];

	/** @throws Error when the link does not parse. */
	constructor(link: string, displayName: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#draftScopeLink = link;
		this.#name = displayName;
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame);
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) {
			this.#welcomeTimer = setTimeout(() => {
				this.#welcomeTimer = null;
				if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
			}, WELCOME_TIMEOUT_MS);
		}
	}

	close(): void {
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#clearRestartPreparation("discard");
		this.#commit();
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Volatile decoded assistant-audio delivery. Unlike {@link subscribe}, this
	 * path never rebuilds the React snapshot for high-frequency PCM chunks.
	 */
	subscribeLiveOutput(listener: (frame: LiveOutputChunkFrame) => void): () => void {
		this.#liveOutputListeners.add(listener);
		return () => {
			this.#liveOutputListeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced (with fresh collection refs) per applied frame. */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	/** Derives a non-reversible local draft scope from this exact manual capability and session. */
	manualDraftScope(sessionId: string): Promise<RestartDraftScope | null> {
		return createManualDraftScope(this.#draftScopeLink, sessionId);
	}

	/** Hashes this exact room capability in memory for editor request-generation isolation. */
	editorDraftCapabilityFingerprint(): Promise<string | null> {
		return createEditorDraftCapabilityFingerprint(this.#draftScopeLink);
	}

	/** Called only for a definitive host `ui-request-end`, never for a re-hello welcome reset. */
	setUiRequestEndedHandler(handler: ((reqId: number) => void) | undefined): () => void {
		this.#uiRequestEndedHandler = handler;
		return () => {
			if (this.#uiRequestEndedHandler === handler) this.#uiRequestEndedHandler = undefined;
		};
	}

	/**
	 * Registers the local-only draft barrier. A capability is never advertised
	 * as ready until this handler has durably preserved every current draft.
	 */
	setRestartPreparationHandler(handler: GuestRestartPreparationHandler | undefined): () => void {
		if (this.#restartHandler && this.#restartHandler !== handler) {
			this.#clearRestartPreparation("discard");
			this.#commit();
		}
		this.#restartHandler = handler;
		return () => {
			if (this.#restartHandler !== handler) return;
			this.#clearRestartPreparation("discard");
			this.#restartHandler = undefined;
			this.#commit();
		};
	}

	/**
	 * Managed discovery is the only authority allowed to enable update ACKs.
	 * Manual capability links retain local drafts but stay restart-incompatible.
	 */
	setRestartPreparationAvailability(enabled: boolean): void {
		if (this.#restartPreparationEnabled === enabled) return;
		this.#restartPreparationEnabled = enabled;
		if (!enabled) {
			this.#clearRestartPreparation("discard");
			this.#commit();
		}
		if (
			this.#welcomed &&
			this.#hostCapabilityUpdateSupported &&
			(this.#phase === "live" || this.#phase === "waiting")
		) {
			this.#socket.send({
				t: "capabilities-update",
				capabilities: enabled ? [COLLAB_RESTART_PREPARATION_CAPABILITY] : [],
			});
		}
	}

	/** Inform a capable host that a local draft changed during its idle admission check. */
	setRestartDirty(dirty: boolean): void {
		const mustInvalidatePreparedAck = dirty && this.#restartPreparation !== undefined;
		if (this.#restartDirty === dirty && !mustInvalidatePreparedAck) return;
		this.#restartDirty = dirty;
		if (this.#restartPreparationEnabled && this.#hostRestartCapable && this.#welcomed && this.#phase !== "ended") {
			this.#socket.send({ t: "restart-dirty", dirty });
		}
	}

	sendPrompt(text: string): boolean {
		if (this.#restartPreparation) return false;
		this.#socket.send({ t: "prompt", text });
		return true;
	}

	sendUiResponse(reqId: number, value?: CollabUiResponseValue): boolean {
		if (this.#restartPreparation) return false;
		this.#socket.send({ t: "ui-response", reqId, value });
		if (this.#uiRequest?.reqId === reqId) {
			this.#showNextUiRequest();
			this.#commit();
		}
		return true;
	}

	sendAbort(): boolean {
		if (this.#restartPreparation) return false;
		this.#socket.send({ t: "abort" });
		return true;
	}

	/**
	 * Requests exclusive browser-microphone ownership. The volatile claim is
	 * never replayed after reconnect, so permission remains click-scoped.
	 */
	claimLiveInput(): string | null {
		if (
			this.#restartPreparation ||
			this.#readOnly ||
			this.#phase !== "live" ||
			this.#liveInputLease.status === "claiming" ||
			this.#liveInputLease.status === "granted"
		) {
			return null;
		}
		const requestId = `live-${Date.now().toString(36)}-${++this.#liveRequestSeq}`;
		this.#liveInputLease = {
			status: "claiming",
			requestId,
			leaseId: null,
			message: null,
			started: false,
		};
		this.#commit();
		void this.#socket.sendRealtime({ t: "live-input-claim", requestId }).then(sent => {
			if (sent) return;
			this.#canceledLiveClaims.delete(requestId);
			if (this.#liveInputLease.requestId !== requestId || this.#liveInputLease.status !== "claiming") return;
			this.#liveInputLease = {
				status: "unavailable",
				requestId,
				leaseId: null,
				message: "The live connection is unavailable.",
				started: false,
			};
			this.#commit();
		});
		return requestId;
	}

	/**
	 * Cancels a claim that has not produced a lease yet. A late grant is
	 * immediately released rather than becoming an orphaned host lease.
	 */
	cancelLiveInputClaim(requestId: string, reason: LiveInputStopReason): void {
		if (this.#liveInputLease.status !== "claiming" || this.#liveInputLease.requestId !== requestId) return;
		this.#canceledLiveClaims.set(requestId, reason);
		this.#liveInputLease = IDLE_LIVE_INPUT_LEASE;
		this.#commit();
	}

	async startLiveInput(leaseId: string): Promise<boolean> {
		const lease = this.#liveInputLease;
		if (
			this.#restartPreparation ||
			this.#readOnly ||
			this.#phase !== "live" ||
			lease.status !== "granted" ||
			lease.leaseId !== leaseId ||
			lease.started
		) {
			return false;
		}
		const sent = await this.#socket.sendRealtime({
			t: "live-input-start",
			leaseId,
			format: "pcm_s16le",
			sampleRate: 16_000,
			channels: 1,
			frameSamples: 320,
		});
		if (
			!sent ||
			this.#liveInputLease.status !== "granted" ||
			this.#liveInputLease.leaseId !== leaseId ||
			this.#phase !== "live"
		) {
			return false;
		}
		this.#liveInputLease = { ...this.#liveInputLease, started: true };
		this.#commit();
		return true;
	}

	sendLiveInputChunk(leaseId: string, seq: number, data: string): Promise<boolean> {
		const lease = this.#liveInputLease;
		if (
			this.#restartPreparation ||
			this.#readOnly ||
			this.#phase !== "live" ||
			lease.status !== "granted" ||
			lease.leaseId !== leaseId ||
			!lease.started ||
			!this.#liveActive ||
			this.#liveInput !== "remote" ||
			!Number.isSafeInteger(seq) ||
			seq < 0 ||
			data.length !== PCM_FRAME_BASE64URL_LENGTH
		) {
			return Promise.resolve(false);
		}
		return this.#socket.sendRealtime({ t: "live-input-chunk", leaseId, seq, data });
	}

	stopLiveInput(leaseId: string, reason: LiveInputStopReason): Promise<boolean> {
		const lease = this.#liveInputLease;
		if (this.#restartPreparation || lease.status !== "granted" || lease.leaseId !== leaseId)
			return Promise.resolve(false);
		this.#liveInputLease = IDLE_LIVE_INPUT_LEASE;
		this.#commit();
		return this.#socket.sendRealtime({ t: "live-input-stop", leaseId, reason });
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): boolean {
		if (this.#restartPreparation) return false;
		this.#socket.send({ t: "agent-cmd", cmd, agentId, text });
		return true;
	}

	/**
	 * Incremental subagent-transcript read. Resolves a {@link TranscriptResult}
	 * (`rows` or terminal `error`), or `null` on transient failure (10s timeout,
	 * session end) where re-polling from the same cursor is correct.
	 */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.#socket.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	/** Test seam: apply a synthetic host frame through the real apply path. */
	applyFrameForTest(frame: HostFrame): void {
		this.#applyFrameSafe(frame);
	}

	#handleOpen(): void {
		this.#sendHello();
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	#sendHello(): void {
		const hello = {
			t: "hello" as const,
			proto: COLLAB_PROTO,
			name: this.#name,
			writeToken: this.#writeToken,
		};
		if (this.#restartPreparationEnabled) {
			this.#socket.send({ ...hello, capabilities: [COLLAB_RESTART_PREPARATION_CAPABILITY] });
		} else {
			this.#socket.send(hello);
		}
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		this.#clearSnapshotProgressTimer();
		this.#hostRestartCapable = false;
		this.#hostCapabilityUpdateSupported = false;
		if (this.#phase === "ended") return;
		if (willReconnect) {
			this.#phase = "reconnecting";
			if (this.#liveInputLease.status !== "idle") {
				this.#liveInputLease = {
					...this.#liveInputLease,
					status: "unavailable",
					leaseId: null,
					message: "The live connection was interrupted.",
					started: false,
				};
			}
			this.#commit();
			return;
		}
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		// A terminal old-host close may be the successful update cutover. Keep
		// the session-scoped local backup until the bounded recovery TTL expires.
		this.#clearRestartPreparation("preserve");
		this.#phase = "ended";
		this.#endedReason = reason;
		for (const [, pending] of this.#pendingTranscripts) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
		this.#commit();
		this.#socket.close();
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#end("timed out waiting for the host's session snapshot");
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: HostFrame): void {
		if (frame.t === "live-output-chunk") {
			for (const listener of this.#liveOutputListeners) {
				try {
					listener(frame);
				} catch {
					// One playback consumer must not break ordered socket delivery.
				}
			}
			return;
		}
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply frame", frame.t, err);
			if (frame.t === "welcome" && !this.#welcomed) {
				this.#end(`failed to apply session snapshot: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			this.#pushNotice("error", `failed to apply ${frame.t} frame`);
			this.#commit();
		}
	}
	#handleRestartPrepare(frame: Extract<HostFrame, { t: "restart-prepare" }>): void {
		if (
			!this.#restartPreparationEnabled ||
			!this.#hostRestartCapable ||
			!RESTART_REQUEST_ID_PATTERN.test(frame.requestId) ||
			!Number.isSafeInteger(frame.leaseMs) ||
			frame.leaseMs <= 0 ||
			frame.leaseMs > MAX_RESTART_PREPARATION_LEASE_MS
		) {
			return;
		}
		const header = this.#header;
		if (!header || this.#phase !== "live") {
			this.#sendRestartReady(frame.requestId, "blocked", "unavailable");
			return;
		}
		if (this.#restartPreparation) {
			if (this.#restartPreparation.request.requestId !== frame.requestId) {
				this.#sendRestartReady(frame.requestId, "blocked", "reservation-conflict");
			}
			return;
		}
		if (
			this.#liveActive ||
			this.#liveInput !== "none" ||
			this.#liveInputLease.status === "claiming" ||
			this.#liveInputLease.status === "granted"
		) {
			this.#sendRestartReady(frame.requestId, "blocked", "microphone-active");
			return;
		}
		const handler = this.#restartHandler;
		if (!handler) {
			this.#sendRestartReady(frame.requestId, "blocked", "unavailable");
			return;
		}
		const request: GuestRestartPreparation = {
			requestId: frame.requestId,
			sessionId: header.id,
			leaseMs: frame.leaseMs,
		};
		const preparation: ActiveRestartPreparation = {
			request,
			handler,
			deadline: performance.now() + frame.leaseMs,
			timer: undefined as unknown as Timer,
			cancelDisposition: undefined,
		};
		this.#restartPreparation = preparation;
		preparation.timer = setTimeout(() => this.#expireRestartPreparation(preparation), frame.leaseMs);
		void this.#finishRestartPreparation(preparation);
	}

	#handleRestartCancel(frame: Extract<HostFrame, { t: "restart-cancel" }>): void {
		if (!RESTART_REQUEST_ID_PATTERN.test(frame.requestId)) return;
		const preparation = this.#restartPreparation;
		if (!preparation || preparation.request.requestId !== frame.requestId) return;
		this.#clearRestartPreparation("discard");
		this.#commit();
	}

	async #finishRestartPreparation(preparation: ActiveRestartPreparation): Promise<void> {
		let result: GuestRestartPreparationResult;
		try {
			result = await preparation.handler.prepare(preparation.request);
		} catch {
			result = { status: "blocked", reason: "draft-storage-unavailable" };
		}
		if (this.#restartPreparation !== preparation) {
			preparation.handler.cancel(preparation.request.requestId, preparation.cancelDisposition ?? "discard");
			return;
		}
		if (performance.now() >= preparation.deadline) {
			this.#expireRestartPreparation(preparation);
			return;
		}
		if (result.status === "ready") {
			this.#sendRestartReady(preparation.request.requestId, "ready");
			return;
		}
		this.#clearRestartPreparation("discard");
		this.#sendRestartReady(preparation.request.requestId, "blocked", result.reason);
		this.#commit();
	}

	#expireRestartPreparation(preparation: ActiveRestartPreparation): void {
		if (this.#restartPreparation !== preparation) return;
		this.#clearRestartPreparation("discard");
		this.#sendRestartReady(preparation.request.requestId, "blocked", "expired");
		this.#commit();
	}

	#clearRestartPreparation(disposition: "discard" | "preserve"): void {
		const preparation = this.#restartPreparation;
		if (!preparation) return;
		clearTimeout(preparation.timer);
		this.#restartPreparation = undefined;
		preparation.cancelDisposition = disposition;
		try {
			preparation.handler.cancel(preparation.request.requestId, disposition);
		} catch {
			// Draft cleanup is best-effort only; a failure must not retain a UI freeze.
		}
	}

	#sendRestartReady(requestId: string, status: "ready" | "blocked", reason?: CollabRestartBlockReason): void {
		if (!this.#restartPreparationEnabled || !this.#hostRestartCapable || this.#phase === "ended") return;
		if (status === "ready" || reason === undefined) {
			this.#socket.send({ t: "restart-ready", requestId, status });
		} else {
			this.#socket.send({ t: "restart-ready", requestId, status, reason });
		}
	}

	#applyFrame(frame: HostFrame): void {
		switch (frame.t) {
			case "welcome":
				// Reset accumulator: a fresh welcome arriving mid-load (reconnect)
				// supersedes any partially-streamed snapshot from the prior session.
				this.#clearRestartPreparation("discard");
				this.#header = frame.header;
				this.#entries = [];
				this.#publishedEntries = [];
				this.#state = frame.state;
				this.#agents = [...frame.agents];
				this.#stream = null;
				this.#streamDone = false;
				this.#activeTools = new Map();
				this.#progress = new Map();
				this.#lifecycle = new Map();
				this.#working = frame.state.isStreaming;
				this.#readOnly = frame.readOnly === true;
				this.#liveActive = frame.liveActive === true;
				this.#liveInput = frame.liveInput;
				this.#liveInputLease = IDLE_LIVE_INPUT_LEASE;
				this.#canceledLiveClaims.clear();
				this.#clearUiRequests();
				this.#welcomed = true;
				this.#hostRestartCapable = frame.capabilities?.includes(COLLAB_RESTART_PREPARATION_CAPABILITY) === true;
				this.#hostCapabilityUpdateSupported =
					frame.capabilities?.includes(COLLAB_RESTART_CAPABILITY_UPDATE) === true;
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				this.#endedReason = null;
				if (this.#restartPreparationEnabled && this.#hostRestartCapable && this.#restartDirty) {
					this.#socket.send({ t: "restart-dirty", dirty: true });
				}
				break;
			case "restart-prepare":
				this.#handleRestartPrepare(frame);
				break;
			case "restart-cancel":
				this.#handleRestartCancel(frame);
				break;
			case "snapshot-chunk": {
				// Stream transcript fragments into the live snapshot. The host
				// always closes the train with `final: true`; that flip is what
				// moves the guest from "waiting" to "live".
				this.#entries.push(...frame.entries);
				this.#publishedEntries = [...this.#entries];
				if (frame.final) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				break;
			}
			case "entry":
				this.#entries.push(frame.entry);
				this.#publishedEntries = [...this.#entries];
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				break;
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				this.#state = frame.state;
				// Host state is authoritative for liveness in both directions: the
				// payload is built at fire time, so `isStreaming` is never stale.
				// This covers a connected guest that misses the discrete `agent_start`
				// without receiving a new `welcome` (for example, mid-stream).
				this.#working = frame.state.isStreaming;
				if (!frame.state.isStreaming) {
					// Host idle implies no tool can be running, so clear any card
					// pinned by a dropped `tool_execution_end` off this signal.
					this.#activeTools = new Map();
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				break;
			case "live-state":
				this.#liveActive = frame.active;
				this.#liveInput = frame.input;
				break;
			case "live-input-lease": {
				const canceledReason = this.#canceledLiveClaims.get(frame.requestId);
				if (canceledReason !== undefined) {
					this.#canceledLiveClaims.delete(frame.requestId);
					if (frame.status === "granted" && frame.leaseId) {
						void this.#socket.sendRealtime({
							t: "live-input-stop",
							leaseId: frame.leaseId,
							reason: canceledReason,
						});
					}
					break;
				}
				if (this.#liveInputLease.requestId !== frame.requestId) break;
				if (frame.status === "granted" && !frame.leaseId) {
					this.#liveInputLease = {
						status: "unavailable",
						requestId: frame.requestId,
						leaseId: null,
						message: "The host returned an invalid microphone lease.",
						started: false,
					};
					break;
				}
				this.#liveInputLease = {
					status: frame.status,
					requestId: frame.requestId,
					leaseId: frame.status === "granted" ? (frame.leaseId ?? null) : null,
					message: frame.message ?? null,
					started: false,
				};
				break;
			}
			case "agents":
				this.#agents = [...frame.agents];
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#progress = new Map(this.#progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "ui-request":
				if (this.#uiRequest) this.#uiRequestQueue = [...this.#uiRequestQueue, frame.request];
				else this.#uiRequest = frame.request;
				break;
			case "ui-request-end":
				this.#uiRequestEndedHandler?.(frame.reqId);
				if (this.#uiRequest?.reqId === frame.reqId) this.#showNextUiRequest();
				else this.#uiRequestQueue = this.#uiRequestQueue.filter(request => request.reqId !== frame.reqId);
				break;
			case "transcript": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error }
							: { kind: "rows", text: frame.text, newSize: frame.newSize },
					);
				}
				break;
			}
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error":
				if (!this.#welcomed) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout.
					this.#end(frame.message);
					return; // #end already committed
				}
				this.#pushNotice("error", frame.message);
				break;
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		this.#commit();
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(event.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				break;
			case "notice":
				this.#pushNotice(event.level, event.message);
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_retry_end":
				if (!event.success) this.#pushNotice("error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				// turn_start/turn_end/thinking_level_changed/unknown — ignore
				break;
		}
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSeq, level, message, at: Date.now() };
		const next = [...this.#notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
	}

	#clearUiRequests(): void {
		this.#uiRequest = null;
		this.#uiRequestQueue = [];
	}

	#showNextUiRequest(): void {
		const [next, ...rest] = this.#uiRequestQueue;
		this.#uiRequest = next ?? null;
		this.#uiRequestQueue = rest;
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			// Publish the cached array: identical reference until an
			// entry-mutating frame replaces it, so non-entry frames
			// (streaming updates, state, bus) don't invalidate entry-identity
			// consumers per token.
			entries: this.#publishedEntries,
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			liveActive: this.#liveActive,
			liveInput: this.#liveInput,
			restartPreparing: this.#restartPreparation !== undefined,
			liveInputLease: this.#liveInputLease,
			readOnly: this.#readOnly,
			uiRequest: this.#uiRequest,
			notices: this.#notices,
		};
	}

	#commit(): void {
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
