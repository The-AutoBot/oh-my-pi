import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { logger, postmortem, withTimeout } from "@oh-my-pi/pi-utils";
import type { Args } from "./cli/args";
import { dapSessionManager } from "./dap/session";
import { hasVmContextsForOwner } from "./eval/js/context-manager";
import { hasPythonKernelSessionForOwner } from "./eval/py/executor";
import type { CollabAutoBotFallbackState } from "./collab/controller";
import type { AutoBotUpdateAdmission, InteractiveMode } from "./modes/interactive-mode";
import { listKnownProjectDaemons } from "./launch/client";
import type { AgentSession } from "./session/agent-session";
import { hasTabsForOwner } from "./tools/browser/tab-supervisor";
import { hasLiveComputerSessionForOwner } from "./tools/computer/supervisor";
import {
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_RESTART_EXIT_CODE,
	type AutoBotPredecessorFallback,
	type AutoBotRestartRequest,
	type AutoBotRestartTarget,
	type AutoBotUpdateHooks,
	type JsonValue,
	type PreparedAutoBotRestart,
} from "./autobot-update/contract";
import { AUTO_BOT_FINAL_GUEST_ACK_LEASE_MS, AUTO_BOT_SESSION_DISPOSE_TIMEOUT_MS } from "./autobot-update/supervisor";
import {
	authorizeAutoBotRestartExit,
	getAutoBotStartupHandoff,
	requestAutoBotNormalExit,
} from "./autobot-update/handoff";
import { readAuthenticatedAutoBotEnvironment } from "./autobot-update/identity";
import { pathIsInside } from "./autobot-update/paths";

const AUTO_BOT_RESTART_CONTEXT_VERSION = 1;
const POSTMORTEM_CLEANUP_TIMEOUT_MS = 10_000;
const STDOUT_DRAIN_TIMEOUT_MS = 5_000;

type SafeLaunchFlags = Readonly<{
	autoApprove: boolean;
	approvalMode?: "always-ask" | "write" | "yolo";
	advisor: boolean;
	externalThinking: boolean;
	hideThinking: boolean;
	noExtensions: boolean;
	noLsp: boolean;
	noPrewalk: boolean;
	noPty: boolean;
	noRules: boolean;
	noSkills: boolean;
	noTitle: boolean;
	noTools: boolean;
	prewalk: boolean;
	serviceTier?: Args["serviceTier"];
}>;

export interface AutoBotRestartLaunchContext {
	readonly schemaVersion: typeof AUTO_BOT_RESTART_CONTEXT_VERSION;
	readonly configFiles: readonly string[];
	readonly flags: SafeLaunchFlags;
	readonly coordinator?: AutoBotCoordinatorPreparation;
	/** Browser-owned, token-free policy needed only if the candidate fails. */
	readonly collab?: CollabAutoBotFallbackState;
}

/**
 * extension. The extension retains ownership of its single SessionBusClient;
 * the core runtime never creates a competing client for the same session.
 */
export interface AutoBotCoordinatorService {
	canPrepare(target: AutoBotRestartTarget): Promise<AutoBotCoordinatorPreflight>;
	prepare(request: AutoBotCoordinatorRestartRequest): Promise<AutoBotCoordinatorPreparation>;
	/** Predecessor retirement intent only; it MUST NOT wait for successor readiness. */
	commit(preparation: AutoBotCoordinatorPreparation): Promise<void>;
	/** Candidate-only provisional readiness, barred from user/collaboration work. */
	provisionalReady(preparation: AutoBotCoordinatorPreparation): Promise<void>;
	/** Candidate-only final broker ownership transition after local activation. */
	activate(preparation: AutoBotCoordinatorPreparation): Promise<void>;
	cancel(preparation: AutoBotCoordinatorPreparation): Promise<void>;
	/** Intentional user exit: destroy the exact reservation rather than preserving a fallback claimant. */
	abandon(preparation: Pick<AutoBotCoordinatorPreparation, "reservationId">): Promise<void>;
	/** Fallback-only provisional restoration of the recorded predecessor claimant. */
	restorePredecessorFallback(preparation: AutoBotCoordinatorPreparation): Promise<void>;
}

export type AutoBotCoordinatorPreflight =
	| { readonly canPrepare: true }
	| { readonly canPrepare: false; readonly reason: string };

export interface AutoBotCoordinatorRestartRequest {
	readonly successorInstanceId: string;
	readonly target: AutoBotRestartTarget;
	readonly predecessorTarget: AutoBotRestartTarget;
	readonly handoff: {
		readonly manualRoom: "preserve" | "clear";
		readonly collab: "preserve" | "stop";
	};
	readonly handoffBudgetMs: number;
}

export interface AutoBotCoordinatorPreparation {
	readonly reservationId: string;
	readonly fallbackInstanceId: string;
	readonly predecessorInstanceId: string;
	readonly successorInstanceId: string;
	readonly predecessorTarget: AutoBotRestartTarget;
	readonly expiresAt: string;
	readonly leaseDurationMs: number;
	readonly target: AutoBotRestartTarget;
	readonly handoff: {
		readonly manualRoom: "preserve" | "clear";
		readonly collab: "preserve" | "stop";
	};
}

type PreparedRuntimeRestart = Readonly<{
	admission: NonNullable<AutoBotUpdateAdmission>;
	coordinator: AutoBotCoordinatorPreparation | undefined;
	target: AutoBotRestartTarget;
	predecessorTarget: AutoBotRestartTarget;
}>;

function primitiveRecord(
	value: JsonValue | AutoBotRestartLaunchContext | undefined,
): Record<string, JsonValue> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, JsonValue>;
}

function booleanField(value: Record<string, JsonValue>, name: string): boolean | undefined {
	const candidate = value[name];
	return typeof candidate === "boolean" ? candidate : undefined;
}

function stringField(value: Record<string, JsonValue>, name: string): string | undefined {
	const candidate = value[name];
	return typeof candidate === "string" ? candidate : undefined;
}

function stringArrayField(value: Record<string, JsonValue>, name: string): string[] | undefined {
	const candidate = value[name];
	if (!Array.isArray(candidate) || !candidate.every(item => typeof item === "string")) return undefined;
	return [...candidate];
}

function sameTarget(left: AutoBotRestartTarget, right: AutoBotRestartTarget): boolean {
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

function positiveSafeInteger(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseCoordinatorTarget(value: Record<string, JsonValue>): AutoBotRestartTarget | undefined {
	const releaseSequence = positiveSafeInteger(value.releaseSequence);
	const upstreamVersion = stringField(value, "upstreamVersion");
	const forkCommit = stringField(value, "forkCommit");
	const sessionFormatVersion = positiveSafeInteger(value.sessionFormatVersion);
	const collabProtocolVersion = positiveSafeInteger(value.collabProtocolVersion);
	const compatibilityEpoch = positiveSafeInteger(value.compatibilityEpoch);
	const webBundleId = stringField(value, "webBundleId");
	const handoffBudgetMs = positiveSafeInteger(value.handoffBudgetMs);
	if (
		releaseSequence === undefined ||
		!upstreamVersion ||
		!forkCommit ||
		sessionFormatVersion === undefined ||
		collabProtocolVersion === undefined ||
		compatibilityEpoch === undefined ||
		!webBundleId ||
		handoffBudgetMs === undefined
	) {
		return undefined;
	}
	return {
		releaseSequence,
		upstreamVersion,
		forkCommit,
		sessionFormatVersion: sessionFormatVersion as AutoBotRestartTarget["sessionFormatVersion"],
		collabProtocolVersion: collabProtocolVersion as AutoBotRestartTarget["collabProtocolVersion"],
		compatibilityEpoch,
		webBundleId,
		handoffBudgetMs,
	};
}

function safeCoordinatorPreparation(
	value: JsonValue | undefined,
	target: AutoBotRestartTarget,
	predecessorTarget: AutoBotRestartTarget = target,
): AutoBotCoordinatorPreparation | undefined {
	const record = primitiveRecord(value);
	if (!record) return undefined;
	const reservationId = stringField(record, "reservationId");
	const fallbackInstanceId = stringField(record, "fallbackInstanceId");
	const predecessorInstanceId = stringField(record, "predecessorInstanceId");
	const successorInstanceId = stringField(record, "successorInstanceId");
	const expiresAt = stringField(record, "expiresAt");
	const leaseDurationMs = record.leaseDurationMs;
	const handoff = primitiveRecord(record.handoff);
	const storedTarget = primitiveRecord(record.target);
	const storedPredecessorTarget = primitiveRecord(record.predecessorTarget);
	if (
		!reservationId ||
		!fallbackInstanceId ||
		!predecessorInstanceId ||
		!successorInstanceId ||
		!expiresAt ||
		typeof leaseDurationMs !== "number" ||
		!Number.isSafeInteger(leaseDurationMs) ||
		leaseDurationMs <= 0 ||
		!handoff ||
		!storedTarget ||
		!storedPredecessorTarget
	) {
		return undefined;
	}
	if (handoff.manualRoom !== "preserve" && handoff.manualRoom !== "clear") return undefined;
	if (handoff.collab !== "preserve" && handoff.collab !== "stop") return undefined;
	const parsedTarget = parseCoordinatorTarget(storedTarget);
	const parsedPredecessorTarget = parseCoordinatorTarget(storedPredecessorTarget);
	if (
		!parsedTarget ||
		!parsedPredecessorTarget ||
		!sameTarget(parsedTarget, target) ||
		!sameTarget(parsedPredecessorTarget, predecessorTarget) ||
		!canonicalExpiry(expiresAt)
	) {
		return undefined;
	}
	return {
		reservationId,
		fallbackInstanceId,
		predecessorInstanceId,
		successorInstanceId,
		predecessorTarget,
		expiresAt,
		leaseDurationMs,
		target,
		handoff: { manualRoom: handoff.manualRoom, collab: handoff.collab },
	};
}

function safeCollabFallbackState(value: JsonValue | undefined): CollabAutoBotFallbackState | undefined {
	const record = primitiveRecord(value);
	if (!record) return undefined;
	const wasHosting = booleanField(record, "wasHosting");
	const access = stringField(record, "access");
	if (wasHosting === false && access === undefined) return { wasHosting: false };
	if (wasHosting === true && (access === "view" || access === "control")) return { wasHosting: true, access };
	return undefined;
}

function unsafeLaunchOverride(args: Args): string | undefined {
	if (args.apiKey !== undefined) return "a runtime API key override is active";
	if (args.systemPrompt !== undefined || args.appendSystemPrompt !== undefined)
		return "a custom system prompt override is active";
	if (args.provider !== undefined || args.model !== undefined || args.models?.length)
		return "a model launch override is active";
	if (args.smol !== undefined || args.slow !== undefined || args.plan !== undefined || args.thinking !== undefined) {
		return "a model-role launch override is active";
	}
	if (args.providerSessionId !== undefined || args.providerPromptCacheKey !== undefined)
		return "a provider session override is active";
	if (args.extensions?.length || args.hooks?.length || args.trustedExtensions?.length || args.pluginDirs?.length) {
		return "a custom extension launch override is active";
	}
	if (
		args.skills?.length ||
		args.prewalkInto !== undefined ||
		args.planYoloInto !== undefined ||
		args.maxTime !== undefined
	) {
		return "a nonpersistent startup override is active";
	}
	return undefined;
}

function launchFlags(args: Args): SafeLaunchFlags {
	return {
		autoApprove: args.autoApprove === true,
		...(args.approvalMode === undefined ? {} : { approvalMode: args.approvalMode }),
		advisor: args.advisor === true,
		externalThinking: args.externalThinking === true,
		hideThinking: args.hideThinking === true,
		noExtensions: args.noExtensions === true,
		noLsp: args.noLsp === true,
		noPrewalk: args.noPrewalk === true,
		noPty: args.noPty === true,
		noRules: args.noRules === true,
		noSkills: args.noSkills === true,
		noTitle: args.noTitle === true,
		noTools: args.noTools === true,
		prewalk: args.prewalk === true,
		...(args.serviceTier === undefined ? {} : { serviceTier: args.serviceTier }),
	};
}

/** Return only durable, nonsecret launch state suitable for the protected handoff file. */
export function createAutoBotRestartLaunchContext(
	args: Args,
	coordinator?: AutoBotCoordinatorPreparation,
	collab?: CollabAutoBotFallbackState,
): AutoBotRestartLaunchContext | undefined {
	if (unsafeLaunchOverride(args) !== undefined) return undefined;
	return {
		schemaVersion: AUTO_BOT_RESTART_CONTEXT_VERSION,
		configFiles: [...(args.config ?? [])],
		flags: launchFlags(args),
		...(coordinator === undefined ? {} : { coordinator }),
		...(collab === undefined ? {} : { collab }),
	};
}

/** Parse the durable launch capsule without accepting raw argv or mutable object shapes. */
export function parseAutoBotRestartLaunchContext(
	value: JsonValue | AutoBotRestartLaunchContext,
	target: AutoBotRestartTarget,
	expectedCoordinator?: Readonly<{
		readonly target: AutoBotRestartTarget;
		readonly predecessorTarget: AutoBotRestartTarget;
	}>,
): AutoBotRestartLaunchContext | undefined {
	const root = primitiveRecord(value);
	if (!root || root.schemaVersion !== AUTO_BOT_RESTART_CONTEXT_VERSION) return undefined;
	const configFiles = stringArrayField(root, "configFiles");
	const flags = primitiveRecord(root.flags);
	if (!configFiles || !flags) return undefined;
	const boolNames = [
		"autoApprove",
		"advisor",
		"externalThinking",
		"hideThinking",
		"noExtensions",
		"noLsp",
		"noPrewalk",
		"noPty",
		"noRules",
		"noSkills",
		"noTitle",
		"noTools",
		"prewalk",
	] as const;
	const parsedFlags: Record<string, boolean | string | undefined> = {};
	for (const name of boolNames) {
		const parsed = booleanField(flags, name);
		if (parsed === undefined) return undefined;
		parsedFlags[name] = parsed;
	}
	const approvalMode = stringField(flags, "approvalMode");
	if (
		approvalMode !== undefined &&
		approvalMode !== "always-ask" &&
		approvalMode !== "write" &&
		approvalMode !== "yolo"
	)
		return undefined;
	const serviceTier = stringField(flags, "serviceTier");
	const coordinator =
		root.coordinator === undefined
			? undefined
			: safeCoordinatorPreparation(
					root.coordinator,
					expectedCoordinator?.target ?? target,
					expectedCoordinator?.predecessorTarget ?? target,
				);
	const collab = root.collab === undefined ? undefined : safeCollabFallbackState(root.collab);
	if (root.coordinator !== undefined && coordinator === undefined) return undefined;
	if (root.collab !== undefined && collab === undefined) return undefined;
	return {
		schemaVersion: AUTO_BOT_RESTART_CONTEXT_VERSION,
		configFiles,
		flags: {
			...(parsedFlags as SafeLaunchFlags),
			...(approvalMode === undefined ? {} : { approvalMode }),
			...(serviceTier === undefined ? {} : { serviceTier: serviceTier as Args["serviceTier"] }),
		},
		...(coordinator === undefined ? {} : { coordinator }),
		...(collab === undefined ? {} : { collab }),
	};
}

/** Build a fresh candidate Args object; no original argv, prompt, model, or credential is replayed. */
export function createAutoBotCandidateArgs(request: AutoBotRestartRequest, context: AutoBotRestartLaunchContext): Args {
	return {
		cwd: request.cwd,
		...(request.profile === undefined ? {} : { profile: request.profile }),
		config: [...context.configFiles],
		resume: request.sessionFile,
		autoApprove: context.flags.autoApprove,
		approvalMode: context.flags.approvalMode,
		advisor: context.flags.advisor,
		externalThinking: context.flags.externalThinking,
		hideThinking: context.flags.hideThinking,
		noExtensions: context.flags.noExtensions,
		noLsp: context.flags.noLsp,
		noPrewalk: context.flags.noPrewalk,
		noPty: context.flags.noPty,
		noRules: context.flags.noRules,
		noSkills: context.flags.noSkills,
		noTitle: context.flags.noTitle,
		noTools: context.flags.noTools,
		prewalk: context.flags.prewalk,
		serviceTier: context.flags.serviceTier,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};
}

async function liveResourceReason(session: AgentSession, mode: InteractiveMode): Promise<string | undefined> {
	const browserOwnerId = session.sessionManager.getSessionId();
	const evaluatorOwnerId = session.getEvalKernelOwnerId();
	if (hasTabsForOwner(browserOwnerId)) return "a browser tab is still owned by this session";
	if (hasLiveComputerSessionForOwner(evaluatorOwnerId)) return "a computer session is still owned by this session";
	if (hasVmContextsForOwner(evaluatorOwnerId)) return "a JavaScript evaluation context is still owned by this session";
	if (hasPythonKernelSessionForOwner(evaluatorOwnerId)) return "a Python kernel is still owned by this session";
	if (dapSessionManager.listSessions().some(item => item.status !== "terminated"))
		return "a DAP debugger session is still live";

	for (const name of mode.mcpManager?.getConnectedServers() ?? []) {
		const transport = mode.mcpManager?.getConnection(name)?.transport;
		if (!transport || transport.hasStatefulSession !== false) {
			return `the MCP transport "${name}" has state that could not be safely recreated`;
		}
	}

	const sessionId = session.sessionManager.getSessionId();
	if (!sessionId) return undefined;
	try {
		const daemons = await listKnownProjectDaemons(session.sessionManager.getCwd());
		if (
			daemons?.some(daemon => daemon.owner === sessionId && daemon.state !== "exited" && daemon.state !== "failed")
		) {
			return "a user-owned hub service is still running";
		}
	} catch (error) {
		logger.warn("AutoBot update deferred because a session-owned hub service could not be inspected", {
			error: String(error),
		});
		return "a session-owned hub service could not be verified safe";
	}
	return undefined;
}

/**
 * The coordinator accepts an idempotent cancel for an unactivated staged
 * claimant. Retry once to cover a lost acknowledgement; callers never use it
 * after the claimant's activation request begins.
 */
async function cancelStagedCoordinatorClaim(
	service: AutoBotCoordinatorService | undefined,
	preparation: AutoBotCoordinatorPreparation | undefined,
): Promise<void> {
	if (!service || !preparation) return;
	let firstError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await service.cancel(preparation);
			return;
		} catch (error) {
			firstError ??= error;
		}
	}
	throw new AggregateError(
		[firstError],
		"AutoBot coordinator reservation could not be cancelled while predecessor remained authoritative",
	);
}

/** Destroy the exact reservation for an authenticated user exit; never use this for retryable candidate failure. */
async function abandonAutoBotCoordinatorReservation(
	service: AutoBotCoordinatorService | undefined,
	preparation: AutoBotCoordinatorPreparation | undefined,
): Promise<void> {
	if (!service || !preparation) return;
	let firstError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await service.abandon({ reservationId: preparation.reservationId });
			return;
		} catch (error) {
			firstError ??= error;
		}
	}
	throw new AggregateError(
		[firstError],
		"AutoBot coordinator reservation could not be abandoned for an explicit user exit",
	);
}

function canonicalExpiry(value: string | undefined): string | undefined {
	if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
	return new Date(value).toISOString() === value ? value : undefined;
}
/**
 * Safe, nonsecret paths for the signed coordinator module in this exact,
 * authenticated runtime slot. The module path is never sourced from argv,
 * configuration, or ambient environment.
 */
export function getVerifiedAutoBotCoordinatorPaths():
	| {
			readonly root: string;
			readonly channelConfigPath: string;
			readonly controlDir: string;
			readonly coordinatorClientPath: string;
	  }
	| undefined {
	const environment = readAuthenticatedAutoBotEnvironment();
	if (!environment) return undefined;
	try {
		const root = fs.realpathSync.native(environment.paths.root);
		const runtimeSlot = path.dirname(fs.realpathSync.native(environment.runtimePath));
		const coordinatorClientPath = fs.realpathSync.native(
			path.join(runtimeSlot, "assets", "coordinator-client", "omp-session-coordinator-extension.mjs"),
		);
		if (
			!pathIsInside(root, runtimeSlot) ||
			!pathIsInside(runtimeSlot, coordinatorClientPath) ||
			!fs.statSync(coordinatorClientPath).isFile()
		) {
			return undefined;
		}
		return {
			root: environment.paths.root,
			channelConfigPath: environment.paths.channelConfigPath,
			controlDir: environment.paths.controlDir,
			coordinatorClientPath,
		};
	} catch {
		return undefined;
	}
}

/**
 * Synchronous, authenticated broker identity for the extension's first
 * SessionBusClient registration. It never trusts raw environment variables.
 */
export interface AutoBotCoordinatorStartupRegistration {
	readonly reservationId: string;
	readonly predecessorInstanceId: string;
	readonly instanceId: string;
	readonly mode: "target" | "predecessor-fallback";
	readonly target: AutoBotRestartTarget;
}

export function getAutoBotCoordinatorStartupRegistration(): AutoBotCoordinatorStartupRegistration | undefined {
	const startup = getAutoBotStartupHandoff();
	if (!startup) return undefined;
	if (startup.role === "candidate") {
		const request = startup.candidate.request;
		const context = parseAutoBotRestartLaunchContext(request.context, request.target, {
			target: request.target,
			predecessorTarget: request.predecessorTarget,
		});
		const coordinator = context?.coordinator;
		if (!coordinator || request.fallbackInstanceId !== coordinator.fallbackInstanceId) return undefined;
		return {
			reservationId: coordinator.reservationId,
			predecessorInstanceId: coordinator.predecessorInstanceId,
			instanceId: coordinator.successorInstanceId,
			mode: "target",
			target: request.target,
		};
	}
	const fallback = startup.fallback;
	const request = fallback.request;
	if (
		!sameTarget(request.target, request.predecessorTarget) ||
		sameTarget(fallback.attemptedTarget, request.target) ||
		!request.fallbackInstanceId
	) {
		return undefined;
	}
	const context = parseAutoBotRestartLaunchContext(request.context, request.target, {
		target: fallback.attemptedTarget,
		predecessorTarget: request.predecessorTarget,
	});
	const coordinator = context?.coordinator;
	if (!coordinator || coordinator.fallbackInstanceId !== request.fallbackInstanceId) return undefined;
	return {
		reservationId: coordinator.reservationId,
		predecessorInstanceId: coordinator.predecessorInstanceId,
		instanceId: coordinator.fallbackInstanceId,
		mode: "predecessor-fallback",
		target: request.target,
	};
}

/** Runtime-owned hourly update hooks for one already-running interactive session. */
export class AutoBotRuntime {
	#prepared: PreparedRuntimeRestart | undefined;
	#fallbackCoordinatorActivationStarted = false;

	constructor(
		readonly session: AgentSession,
		readonly launchArgs: Args,
		readonly mode: InteractiveMode,
		readonly profile: string | undefined,
	) {}

	/** Once true, fallback broker activation is indeterminate and must not be abandoned. */
	hasAutoBotFallbackCoordinatorActivationStarted(): boolean {
		return this.#fallbackCoordinatorActivationStarted;
	}

	get hooks(): AutoBotUpdateHooks {
		return {
			canPrepareRestart: (target, predecessorTarget) => this.canPrepareRestart(target, predecessorTarget),
			prepareRestart: (target, predecessorTarget) => this.prepareRestart(target, predecessorTarget),
			commitRestart: request => this.commitRestart(request),
			abortRestart: (request, reason) => this.abortRestart(request, reason),
			restorePredecessorFallback: fallback => this.restorePredecessorFallback(fallback),
		};
	}

	/**
	 * Read-only early admission gate for a shared managed installation. It must
	 * not freeze input, flush state, or reserve broker/browser ownership: the
	 * later prepareRestart call repeats these checks at its mutation boundary.
	 */
	async canPrepareRestart(target: AutoBotRestartTarget, predecessorTarget: AutoBotRestartTarget): Promise<boolean> {
		try {
			if (
				target.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH ||
				predecessorTarget.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH
			) {
				return false;
			}
			if (unsafeLaunchOverride(this.launchArgs) !== undefined) return false;
			if (!this.session.sessionManager.isSessionOnDisk()) return false;
			if ((await liveResourceReason(this.session, this.mode)) !== undefined) return false;
			if (this.mode.getAutoBotUpdateDeferralReason() !== undefined) return false;

			const service = this.session.autoBotUpdateCoordinator;
			if (!service || !this.mode.collabController.canPrepareUpdate(target).safe) return false;
			if (!(await service.canPrepare(target)).canPrepare) return false;

			return (
				this.session.sessionManager.isSessionOnDisk() &&
				(await liveResourceReason(this.session, this.mode)) === undefined &&
				this.mode.getAutoBotUpdateDeferralReason() === undefined &&
				this.mode.collabController.canPrepareUpdate(target).safe
			);
		} catch {
			return false;
		}
	}

	async prepareRestart(
		target: AutoBotRestartTarget,
		predecessorTarget: AutoBotRestartTarget,
	): Promise<PreparedAutoBotRestart | undefined> {
		if (
			target.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH ||
			predecessorTarget.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH
		) {
			return undefined;
		}
		if (unsafeLaunchOverride(this.launchArgs) !== undefined) return undefined;
		if (!this.session.sessionManager.isSessionOnDisk()) return undefined;
		if ((await liveResourceReason(this.session, this.mode)) !== undefined) return undefined;
		const admission = this.mode.beginAutoBotUpdateAdmission();
		if (!admission || !this.mode.isAutoBotUpdateAdmissionValid(admission)) return undefined;

		const service = this.session.autoBotUpdateCoordinator;
		let coordinator: AutoBotCoordinatorPreparation | undefined;
		let cancellationAttempted = false;
		if (!service) {
			this.mode.cancelAutoBotUpdateAdmission(admission);
			return undefined;
		}
		let cancellationFailure: unknown;
		const cancel = async (): Promise<undefined> => {
			let abandonedForExit = false;
			if (!cancellationAttempted) {
				cancellationAttempted = true;
				try {
					if (this.mode.isAutoBotUpdateExitRequested(admission)) {
						await abandonAutoBotCoordinatorReservation(service, coordinator);
						abandonedForExit = true;
					} else {
						await cancelStagedCoordinatorClaim(service, coordinator);
					}
				} catch (error) {
					cancellationFailure = error;
				}
			}
			if (cancellationFailure !== undefined) {
				if (!this.mode.isAutoBotUpdateExitRequested(admission)) throw cancellationFailure;
				try {
					await abandonAutoBotCoordinatorReservation(service, coordinator);
					abandonedForExit = true;
					cancellationFailure = undefined;
				} catch (abandonFailure) {
					throw new AggregateError(
						[cancellationFailure, abandonFailure],
						"AutoBot explicit exit could not abandon its coordinator reservation",
					);
				}
			}
			if (this.mode.isAutoBotUpdateExitRequested(admission)) {
				if (!abandonedForExit) await abandonAutoBotCoordinatorReservation(service, coordinator);
				if (!(await requestAutoBotNormalExit())) {
					throw new Error("AutoBot could not authenticate the requested normal exit");
				}
				await this.mode.completeAutoBotUpdateExit(admission);
			} else {
				this.mode.cancelAutoBotUpdateAdmission(admission);
			}
			return undefined;
		};

		try {
			await this.session.sessionManager.flush();
			if (
				!this.mode.isAutoBotUpdateAdmissionValid(admission) ||
				(await liveResourceReason(this.session, this.mode)) !== undefined
			) {
				return await cancel();
			}
			const collabSafety = this.mode.collabController.canPrepareUpdate(target);
			if (!collabSafety.safe) return await cancel();
			const coordinatorSafety = await service.canPrepare(target);
			if (!coordinatorSafety.canPrepare || !this.mode.isAutoBotUpdateAdmissionValid(admission))
				return await cancel();
			coordinator = await service.prepare({
				successorInstanceId: randomUUID(),
				target,
				predecessorTarget,
				handoff: { manualRoom: "preserve", collab: "preserve" },
				handoffBudgetMs: target.handoffBudgetMs,
			});
			if (
				!coordinator.reservationId ||
				!coordinator.fallbackInstanceId ||
				!coordinator.predecessorInstanceId ||
				!coordinator.successorInstanceId ||
				!sameTarget(coordinator.target, target) ||
				!sameTarget(coordinator.predecessorTarget, predecessorTarget) ||
				!canonicalExpiry(coordinator.expiresAt) ||
				!Number.isSafeInteger(coordinator.leaseDurationMs) ||
				coordinator.leaseDurationMs <= 0
			) {
				return await cancel();
			}
			if (
				!this.mode.isAutoBotUpdateAdmissionValid(admission) ||
				(await liveResourceReason(this.session, this.mode)) !== undefined
			) {
				return await cancel();
			}
			const context = createAutoBotRestartLaunchContext(
				this.launchArgs,
				coordinator,
				this.mode.collabController.captureAutoBotFallbackState(),
			);
			if (!context) return await cancel();
			this.#prepared = { admission, coordinator, target, predecessorTarget };
			return {
				sessionFile: this.session.sessionManager.getSessionFile()!,
				sessionId: this.session.sessionManager.getSessionId(),
				cwd: this.session.sessionManager.getCwd(),
				...(this.profile === undefined ? {} : { profile: this.profile }),
				context: context as unknown as JsonValue,
				expiresAt: coordinator.expiresAt,
				leaseDurationMs: coordinator.leaseDurationMs,
				fallbackInstanceId: coordinator.fallbackInstanceId,
			};
		} catch (error) {
			try {
				await cancel();
			} catch (rollbackError) {
				logger.error("AutoBot update preparation rollback could not cancel a coordinator reservation", {
					error: String(error),
					rollbackError: String(rollbackError),
				});
				if (rollbackError === error) throw rollbackError;
				throw new AggregateError(
					[error, rollbackError],
					"AutoBot update preparation failed and its coordinator reservation could not be cancelled",
				);
			}
			logger.warn("AutoBot update preparation deferred", { error: String(error) });
			return undefined;
		}
	}

	async abortRestart(_request: AutoBotRestartRequest, _reason: string): Promise<void> {
		const prepared = this.#prepared;
		this.#prepared = undefined;
		if (!prepared) return;
		let abandonedForExit = false;
		try {
			if (this.mode.isAutoBotUpdateExitRequested(prepared.admission)) {
				await abandonAutoBotCoordinatorReservation(this.session.autoBotUpdateCoordinator, prepared.coordinator);
				abandonedForExit = true;
			} else {
				await cancelStagedCoordinatorClaim(this.session.autoBotUpdateCoordinator, prepared.coordinator);
			}
		} catch (error) {
			if (!this.mode.isAutoBotUpdateExitRequested(prepared.admission)) {
				this.mode.cancelAutoBotUpdateAdmission(prepared.admission);
				throw error;
			}
			try {
				await abandonAutoBotCoordinatorReservation(this.session.autoBotUpdateCoordinator, prepared.coordinator);
				abandonedForExit = true;
			} catch (abandonError) {
				throw new AggregateError(
					[error, abandonError],
					"AutoBot explicit exit could not abandon its coordinator reservation",
				);
			}
		}
		if (this.mode.isAutoBotUpdateExitRequested(prepared.admission)) {
			if (!abandonedForExit) {
				await abandonAutoBotCoordinatorReservation(this.session.autoBotUpdateCoordinator, prepared.coordinator);
			}
			if (!(await requestAutoBotNormalExit())) {
				throw new Error("AutoBot could not authenticate the requested normal exit");
			}
			await this.mode.completeAutoBotUpdateExit(prepared.admission);
			return;
		}
		this.mode.cancelAutoBotUpdateAdmission(prepared.admission);
	}

	/**
	 * Reclaims only the broker-minted old-build claimant after a candidate fails
	 * before activation. Input remains held by main until this returns.
	 */
	async restorePredecessorFallback(fallback: AutoBotPredecessorFallback): Promise<void> {
		this.#fallbackCoordinatorActivationStarted = false;
		const { request, attemptedTarget } = fallback;
		if (
			this.#prepared !== undefined ||
			unsafeLaunchOverride(this.launchArgs) !== undefined ||
			request.target.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH ||
			!sameTarget(request.target, request.predecessorTarget) ||
			sameTarget(attemptedTarget, request.target) ||
			request.fallbackInstanceId === undefined ||
			!this.session.sessionManager.isSessionOnDisk() ||
			this.session.sessionManager.getSessionFile() !== request.sessionFile ||
			this.session.sessionManager.getSessionId() !== request.sessionId ||
			this.session.sessionManager.getCwd() !== request.cwd ||
			this.profile !== request.profile
		) {
			throw new Error("AutoBot predecessor fallback does not match the exact protected session");
		}
		const context = parseAutoBotRestartLaunchContext(request.context, request.target, {
			target: attemptedTarget,
			predecessorTarget: request.predecessorTarget,
		});
		const preparation = context?.coordinator;
		if (
			!context?.collab ||
			!preparation ||
			preparation.fallbackInstanceId !== request.fallbackInstanceId ||
			!sameTarget(preparation.target, attemptedTarget) ||
			!sameTarget(preparation.predecessorTarget, request.predecessorTarget)
		) {
			throw new Error("AutoBot predecessor fallback has no matching signed broker or collaboration state");
		}
		if (this.mode.isAutoBotProtectedStartupExitRequested()) {
			throw new Error("AutoBot predecessor fallback was cancelled by an explicit user exit");
		}
		const coordinator = this.session.autoBotUpdateCoordinator;
		if (!coordinator) throw new Error("AutoBot predecessor fallback coordinator is unavailable");

		let brokerRestored = false;
		let activationStarted = false;
		try {
			await coordinator.restorePredecessorFallback(preparation);
			brokerRestored = true;
			if (this.mode.isAutoBotProtectedStartupExitRequested()) {
				throw new Error("AutoBot predecessor fallback was cancelled by an explicit user exit");
			}
			if (!(await this.mode.collabController.restorePredecessorFallback(fallback))) {
				throw new Error("AutoBot predecessor collaboration state could not be restored");
			}
			if (this.mode.isAutoBotProtectedStartupExitRequested()) {
				throw new Error("AutoBot predecessor fallback was cancelled by an explicit user exit");
			}
			activationStarted = true;
			this.#fallbackCoordinatorActivationStarted = true;
			await coordinator.activate(preparation);
		} catch (error) {
			// A failed activation acknowledgement is indeterminate: never revoke a
			// claimant that may already be active. Before that boundary, retain a
			// fallback only for retryable failure; explicit user exit destroys it.
			const userExitRequested = this.mode.isAutoBotProtectedStartupExitRequested();
			if (activationStarted || (!brokerRestored && !userExitRequested)) throw error;
			try {
				let abandonedForExit = userExitRequested;
				if (abandonedForExit) {
					await abandonAutoBotCoordinatorReservation(coordinator, preparation);
				} else {
					await cancelStagedCoordinatorClaim(coordinator, preparation);
				}
				if (!abandonedForExit && this.mode.isAutoBotProtectedStartupExitRequested()) {
					await abandonAutoBotCoordinatorReservation(coordinator, preparation);
					abandonedForExit = true;
				}
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"AutoBot predecessor fallback could not release its staged coordinator claim",
				);
			}
			throw error;
		}
	}

	/**
	 * Commits the normal candidate only after the reversible broker and browser
	 * reservations are both acknowledged.
	 */
	async commitRestart(request: AutoBotRestartRequest): Promise<void> {
		const prepared = this.#prepared;
		const userExitRequested = prepared !== undefined && this.mode.isAutoBotUpdateExitRequested(prepared.admission);
		if (
			!prepared ||
			!sameTarget(prepared.target, request.target) ||
			!sameTarget(prepared.predecessorTarget, request.predecessorTarget) ||
			(prepared.coordinator !== undefined &&
				request.fallbackInstanceId !== prepared.coordinator.fallbackInstanceId) ||
			!this.mode.isAutoBotUpdateAdmissionValid(prepared.admission) ||
			(await liveResourceReason(this.session, this.mode)) !== undefined
		) {
			await this.abortRestart(request, "restart admission is no longer valid");
			if (userExitRequested) return;
			throw new Error("AutoBot restart admission is no longer valid");
		}
		const coordinator = prepared.coordinator ? this.session.autoBotUpdateCoordinator : undefined;
		if (prepared.coordinator && !coordinator) {
			await this.abortRestart(request, "coordinator handoff is no longer available");
			throw new Error("AutoBot coordinator handoff is no longer available");
		}

		const exitNormally = async (): Promise<void> => {
			this.#prepared = undefined;
			if (!(await requestAutoBotNormalExit())) {
				throw new Error("AutoBot could not authenticate the requested normal exit");
			}
			await this.mode.completeAutoBotUpdateExit(prepared.admission);
		};
		const abandonCoordinatorForExplicitExit = async (): Promise<void> => {
			await abandonAutoBotCoordinatorReservation(coordinator, prepared.coordinator);
		};

		let irreversibleHandoffStarted = false;
		let predecessorStopped = false;
		let collab: Awaited<ReturnType<InteractiveMode["collabController"]["prepareUpdate"]>> | undefined;
		try {
			// The broker authorization remains reversible for the exact, still-live
			// predecessor. Finish it before acquiring the short browser lease, so
			// no broker await consumes the 15-second final guest window.
			if (prepared.coordinator) await coordinator!.commit(prepared.coordinator);
			if (
				!this.mode.isAutoBotUpdateAdmissionValid(prepared.admission) ||
				(await liveResourceReason(this.session, this.mode)) !== undefined
			) {
				throw new Error("AutoBot restart admission changed during coordinator retirement");
			}

			collab = await this.mode.collabController.prepareUpdate(
				request.target,
				Math.ceil(performance.now() + AUTO_BOT_FINAL_GUEST_ACK_LEASE_MS),
			);
			if (
				collab.kind !== "prepared" ||
				!this.mode.isAutoBotUpdateAdmissionValid(prepared.admission) ||
				(await liveResourceReason(this.session, this.mode)) !== undefined
			) {
				throw new Error("AutoBot final collaboration admission was deferred");
			}
			// Seal synchronously before the irreversible host teardown. The sealed
			// identity guarantees the following local stop cannot be invalidated by
			// user input while the final collaboration operation is in flight.
			if (!this.mode.sealAutoBotUpdateAdmission(prepared.admission)) {
				throw new Error("AutoBot local shutdown admission changed before final collaboration teardown");
			}
			if (!(await this.mode.collabController.commitPreparedUpdate(collab.reservation, "autobot-update"))) {
				throw new Error("AutoBot final collaboration teardown was deferred");
			}
			irreversibleHandoffStarted = true;
			if (this.mode.isAutoBotUpdateExitRequested(prepared.admission)) {
				await abandonCoordinatorForExplicitExit();
				await exitNormally();
				return;
			}
			// Keystrokes typed after the final guest acknowledgement must survive
			// the exact-session replacement. The ordinary session draft sidecar is
			// consumed by the candidate; no prompt is replayed through launch args.
			const draft = this.mode.editor.getText();
			if (draft.length > 0) await this.session.sessionManager.saveDraft(draft);
			if (this.mode.isAutoBotUpdateExitRequested(prepared.admission)) {
				await abandonCoordinatorForExplicitExit();
				await exitNormally();
				return;
			}
			if (!this.mode.stopForAutoBotUpdate(prepared.admission)) {
				throw new Error("AutoBot sealed local shutdown admission was lost");
			}
			predecessorStopped = true;
			this.#prepared = undefined;
			await withTimeout(
				this.session.dispose({ reason: postmortem.Reason.MANUAL }),
				AUTO_BOT_SESSION_DISPOSE_TIMEOUT_MS,
				"Timed out disposing predecessor for AutoBot update",
			);
			await withTimeout(
				postmortem.cleanup(),
				POSTMORTEM_CLEANUP_TIMEOUT_MS,
				"Timed out running AutoBot postmortem cleanup",
			);
			await withTimeout(postmortem.drainStdout(), STDOUT_DRAIN_TIMEOUT_MS, "Timed out draining AutoBot stdout");
			if (this.mode.isAutoBotUpdateExitRequested(prepared.admission)) {
				await abandonCoordinatorForExplicitExit();
				await exitNormally();
				return;
			}
			await authorizeAutoBotRestartExit(request);
			if (this.mode.isAutoBotUpdateExitRequested(prepared.admission)) {
				await abandonCoordinatorForExplicitExit();
				await exitNormally();
				return;
			}
			postmortem.exitProcess(AUTO_BOT_RESTART_EXIT_CODE);
		} catch (error) {
			if (!irreversibleHandoffStarted && collab?.kind === "prepared") {
				this.mode.collabController.cancelPreparedUpdate(collab.reservation);
			}
			if (!irreversibleHandoffStarted && !predecessorStopped) {
				let rollbackError: unknown;
				let userExitRequested = this.mode.isAutoBotUpdateExitRequested(prepared.admission);
				try {
					if (userExitRequested) {
						await abandonAutoBotCoordinatorReservation(coordinator, prepared.coordinator);
					} else {
						await cancelStagedCoordinatorClaim(coordinator, prepared.coordinator);
					}
					if (!userExitRequested && this.mode.isAutoBotUpdateExitRequested(prepared.admission)) {
						await abandonAutoBotCoordinatorReservation(coordinator, prepared.coordinator);
						userExitRequested = true;
					}
				} catch (failure) {
					rollbackError = failure;
				}
				this.#prepared = undefined;
				if (userExitRequested) {
					if (rollbackError !== undefined) {
						throw new AggregateError(
							[error, rollbackError],
							"AutoBot explicit exit could not abandon its exact coordinator reservation",
						);
					}
					await exitNormally();
					return;
				}
				this.mode.cancelAutoBotUpdateAdmission(prepared.admission);
				if (rollbackError !== undefined) {
					logger.error("AutoBot restart rollback could not reopen the predecessor coordinator reservation", {
						error: String(error),
						rollbackError: String(rollbackError),
					});
					throw new AggregateError(
						[error, rollbackError],
						"AutoBot restart failed and the predecessor coordinator reservation could not be rolled back",
					);
				}
			}
			throw error;
		}
	}
}
