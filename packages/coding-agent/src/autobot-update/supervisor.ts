import { logger } from "@oh-my-pi/pi-utils";
import { randomBytes } from "node:crypto";
import { isAutoBotCustomBuild } from "./build-metadata";
import { withAutoBotFileLock } from "./lock";
import {
	assertJsonValue,
	parseAutoBotRestartRequest,
	type AutoBotLaunchRelease,
	type AutoBotReleaseManifest,
	type AutoBotRestartCandidate,
	type AutoBotRestartAdmission,
	type AutoBotRestartRequest,
	type AutoBotRestartTarget,
	type PreparedAutoBotRestart,
	type AutoBotUpdateHandle,
	type AutoBotUpdateHooks,
	sameAutoBotRestartTarget,
} from "./contract";
import { writeAutoBotUpdateDiagnostic } from "./diagnostics";
import {
	createAutoBotHandoff,
	discardAutoBotHandoff,
	getAutoBotStartupHandoff,
	hasAutoBotStartupHandoffPromotion,
	promoteAutoBotStartupHandoff,
} from "./handoff";
import { readAuthenticatedAutoBotEnvironment, type AuthenticatedAutoBotEnvironment } from "./identity";
import {
	AutoBotInstallationChannelUnavailableError,
	refreshAutoBotInstallation,
	AutoBotInstallationQuarantinedError,
	type AutoBotInstallationRefreshResult,
} from "./installation";
import { autoBotPaths, type AutoBotPaths } from "./paths";
import type { StagedAutoBotRelease } from "./stage";
import {
	advanceAutoBotSequenceHighWater,
	assertAutoBotSequenceAllowed,
	createAutoBotPendingRestart,
	isAutoBotReleaseQuarantined,
	readAutoBotCommittedRestart,
	readAutoBotPendingRestart,
	withAutoBotHandoffLock,
} from "./state";
import { ensurePrivateDirectory } from "./storage";
import { assertAutoBotPrivateDirectory } from "./permissions";
import {
	AUTO_BOT_ACTIVATION_ACK_TIMEOUT_MS,
	AUTO_BOT_CANDIDATE_READY_TIMEOUT_MS,
	AUTO_BOT_FAILED_CANDIDATE_RETIREMENT_TIMEOUT_MS,
	AUTO_BOT_FALLBACK_STARTUP_TIMEOUT_MS,
	AUTO_BOT_FINAL_GUEST_ACK_LEASE_MS,
	AUTO_BOT_FINAL_GUEST_PREPARATION_AND_NETWORK_TIMEOUT_MS,
	AUTO_BOT_PREDECESSOR_TEARDOWN_TIMEOUT_MS,
	AUTO_BOT_UPDATE_INTERVAL_MS,
} from "./timing";
export {
	AUTO_BOT_ACTIVATION_ACK_TIMEOUT_MS,
	AUTO_BOT_CANDIDATE_READY_TIMEOUT_MS,
	AUTO_BOT_FAILED_CANDIDATE_RETIREMENT_TIMEOUT_MS,
	AUTO_BOT_FALLBACK_STARTUP_TIMEOUT_MS,
	AUTO_BOT_FINAL_GUEST_ACK_LEASE_MS,
	AUTO_BOT_FINAL_GUEST_PREPARATION_AND_NETWORK_TIMEOUT_MS,
	AUTO_BOT_POSTMORTEM_CLEANUP_TIMEOUT_MS,
	AUTO_BOT_PREDECESSOR_TEARDOWN_TIMEOUT_MS,
	AUTO_BOT_SESSION_DISPOSE_TIMEOUT_MS,
	AUTO_BOT_STDOUT_DRAIN_TIMEOUT_MS,
	AUTO_BOT_UPDATE_INTERVAL_MS,
} from "./timing";

export const AUTO_BOT_UNMANAGED_CUSTOM_BUILD_MESSAGE =
	"This AutoBot runtime is not running under its verified signed bootstrap; upstream self-update is disabled.";

export class AutoBotManagedRuntimeRequiredError extends Error {
	constructor() {
		super(AUTO_BOT_UNMANAGED_CUSTOM_BUILD_MESSAGE);
		this.name = "AutoBotManagedRuntimeRequiredError";
	}
}

/** True only after local identity capability and immutable runtime path verification. */
export function isVerifiedAutoBotManagedRuntime(): boolean {
	return readAuthenticatedAutoBotEnvironment() !== undefined;
}
const SUCCESS_PATH_REMAINING_MS =
	AUTO_BOT_PREDECESSOR_TEARDOWN_TIMEOUT_MS +
	AUTO_BOT_FINAL_GUEST_ACK_LEASE_MS +
	AUTO_BOT_CANDIDATE_READY_TIMEOUT_MS +
	AUTO_BOT_ACTIVATION_ACK_TIMEOUT_MS +
	AUTO_BOT_FINAL_GUEST_PREPARATION_AND_NETWORK_TIMEOUT_MS;
const FALLBACK_PATH_REMAINING_MS =
	AUTO_BOT_PREDECESSOR_TEARDOWN_TIMEOUT_MS +
	AUTO_BOT_FINAL_GUEST_ACK_LEASE_MS +
	AUTO_BOT_CANDIDATE_READY_TIMEOUT_MS +
	AUTO_BOT_FAILED_CANDIDATE_RETIREMENT_TIMEOUT_MS +
	AUTO_BOT_FALLBACK_STARTUP_TIMEOUT_MS +
	AUTO_BOT_ACTIVATION_ACK_TIMEOUT_MS +
	AUTO_BOT_FINAL_GUEST_PREPARATION_AND_NETWORK_TIMEOUT_MS;
/**
 * 270s worst case: predecessor shutdown 60 + final guest 15 + candidate ready
 * 60 + candidate retirement 15 + predecessor fallback ready 30 + activation
 * 45 + final browser/network allowance 45. This is checked in the predecessor
 * monotonic clock before irreversible retirement, never by a successor.
 */
export const AUTO_BOT_MINIMUM_REMAINING_HANDOFF_MS = Math.max(SUCCESS_PATH_REMAINING_MS, FALLBACK_PATH_REMAINING_MS);
/** The broker spends this bounded pre-commit negotiation margin before the 270s floor. */
export const AUTO_BOT_PRE_COMMIT_RESERVATION_MARGIN_MS = 120_000;
/** Fixed broker reservation: 270s worst-case execution + 120s negotiation margin. */
export const AUTO_BOT_HANDOFF_BUDGET_MS =
	AUTO_BOT_MINIMUM_REMAINING_HANDOFF_MS + AUTO_BOT_PRE_COMMIT_RESERVATION_MARGIN_MS;

/**
 * Validate the coordinator-issued duration against elapsed time measured only
 * on the active predecessor's monotonic clock. Successor clocks are never
 * compared with this value.
 */
export function hasAutoBotMinimumRemainingHandoffTime(leaseDurationMs: number, elapsedMs: number): boolean {
	return (
		Number.isFinite(leaseDurationMs) &&
		leaseDurationMs >= 0 &&
		Number.isFinite(elapsedMs) &&
		elapsedMs >= 0 &&
		leaseDurationMs - elapsedMs >= AUTO_BOT_MINIMUM_REMAINING_HANDOFF_MS
	);
}

function restartTarget(manifest: AutoBotLaunchRelease | AutoBotReleaseManifest): AutoBotRestartTarget {
	return {
		releaseSequence: manifest.releaseSequence,
		upstreamVersion: manifest.upstreamVersion,
		forkCommit: manifest.forkCommit,
		sessionFormatVersion: manifest.sessionFormatVersion,
		collabProtocolVersion: manifest.collabProtocolVersion,
		compatibilityEpoch: manifest.compatibilityEpoch,
		webBundleId: manifest.webBundleId,
		handoffBudgetMs: AUTO_BOT_HANDOFF_BUDGET_MS,
	};
}

/**
 * Derive an exact-session upgrade from immutable launch facts, never from the
 * installation-wide preferred pointer that other live sessions may advance.
 */
export function planAutoBotLaunchUpdate(
	launchRelease: AutoBotLaunchRelease,
	release: AutoBotReleaseManifest,
): { readonly target: AutoBotRestartTarget; readonly predecessorTarget: AutoBotRestartTarget } | undefined {
	if (
		release.releaseSequence <= launchRelease.releaseSequence ||
		release.compatibilityEpoch !== launchRelease.compatibilityEpoch
	) {
		return undefined;
	}
	return {
		target: restartTarget(release),
		predecessorTarget: restartTarget(launchRelease),
	};
}

function provisionalRestartRequest(
	prepared: PreparedAutoBotRestart,
	target: AutoBotRestartTarget,
	predecessorTarget: AutoBotRestartTarget,
	nonce: string,
): AutoBotRestartRequest {
	assertJsonValue(prepared.context);
	return parseAutoBotRestartRequest({
		sessionFile: prepared.sessionFile,
		sessionId: prepared.sessionId,
		cwd: prepared.cwd,
		...(prepared.profile === undefined ? {} : { profile: prepared.profile }),
		...(prepared.expiresAt === undefined ? {} : { expiresAt: prepared.expiresAt }),
		...(prepared.leaseDurationMs === undefined ? {} : { leaseDurationMs: prepared.leaseDurationMs }),
		...(prepared.fallbackInstanceId === undefined ? {} : { fallbackInstanceId: prepared.fallbackInstanceId }),
		context: prepared.context,
		target,
		predecessorTarget,
		nonce,
	});
}

/**
 * Recheck the reservation immediately before the durable ownership boundary.
 * `preparedAt` is deliberately measured before prepare, so lock/staging delay
 * consumes the predecessor's monotonic reservation rather than a successor's.
 */
function assertMinimumRemainingHandoffTime(request: AutoBotRestartRequest, preparedAt: number): void {
	if (request.expiresAt === undefined) return;
	if (request.leaseDurationMs === undefined) {
		throw new Error("AutoBot collaboration reservation lacks a monotonic duration");
	}
	const elapsed = performance.now() - preparedAt;
	if (!hasAutoBotMinimumRemainingHandoffTime(request.leaseDurationMs, elapsed)) {
		throw new Error("AutoBot collaboration reservation has insufficient locally measured handoff time");
	}
}

function stableDiagnosticReason(reason: string | undefined, fallback: string): string {
	return reason !== undefined && reason.length <= 96 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(reason)
		? reason
		: fallback;
}

function stagedMatchesUpdate(
	staged: StagedAutoBotRelease,
	target: AutoBotRestartTarget,
	payloadSha256: string,
): boolean {
	return staged.payloadSha256 === payloadSha256 && sameAutoBotRestartTarget(restartTarget(staged.manifest), target);
}

async function recordUpdateState(
	paths: AutoBotPaths,
	environment: AuthenticatedAutoBotEnvironment,
	phase: string,
	outcome: "started" | "available" | "unchanged" | "deferred" | "completed" | "failed",
	reason: string | undefined,
	releaseSequence: number,
): Promise<void> {
	try {
		await writeAutoBotUpdateDiagnostic(paths, {
			phase,
			outcome,
			...(reason === undefined ? {} : { reason }),
			releaseSequence,
			launchId: environment.launchId,
		});
	} catch {
		logger.error("AutoBot update diagnostic could not be persisted", { phase, outcome });
	}
}

async function abortPreparedRestart(
	hooks: AutoBotUpdateHooks,
	request: AutoBotRestartRequest,
	reason: "handoff-invalid" | "handoff-write-failed" | "handoff-contended",
): Promise<void> {
	try {
		await hooks.abortRestart?.(request, reason);
	} catch {
		logger.error("AutoBot update preparation cleanup failed", { reason });
	}
}

/**
 * The expensive immutable-byte phase is separately serialized from the short
 * owner journal phase. No network/download work runs while a runtime holds a
 * collaboration reservation, and high-water advances only with final owner
 * admission under updateLock -> handoffLock.
 */
async function runUpdateCycle(
	paths: AutoBotPaths,
	hooks: AutoBotUpdateHooks,
	permittedRole: "active" | "candidate" | "fallback",
): Promise<boolean> {
	const environment = readAuthenticatedAutoBotEnvironment();
	if (!environment || environment.role !== permittedRole || environment.paths.root !== paths.root) return false;
	await recordUpdateState(
		paths,
		environment,
		"installation-refresh",
		"started",
		undefined,
		environment.launchRelease.releaseSequence,
	);
	let refreshed: AutoBotInstallationRefreshResult;
	try {
		refreshed = await refreshAutoBotInstallation(paths);
	} catch (error) {
		await recordUpdateState(
			paths,
			environment,
			"installation-refresh",
			"failed",
			error instanceof AutoBotInstallationChannelUnavailableError
				? "channel-unavailable"
				: error instanceof AutoBotInstallationQuarantinedError
					? "release-quarantined"
					: "installation-refresh-failed",
			environment.launchRelease.releaseSequence,
		);
		throw error;
	}
	const { release, staged } = refreshed;
	const update = planAutoBotLaunchUpdate(environment.launchRelease, release.manifest);
	if (!update) {
		await recordUpdateState(
			paths,
			environment,
			"installation-refresh",
			"unchanged",
			undefined,
			release.manifest.releaseSequence,
		);
		return false;
	}
	await recordUpdateState(
		paths,
		environment,
		"session-admission",
		"available",
		undefined,
		release.manifest.releaseSequence,
	);
	const { target, predecessorTarget } = update;
	let admission: AutoBotRestartAdmission;
	try {
		admission = await hooks.canPrepareRestart(target, predecessorTarget);
	} catch {
		await recordUpdateState(
			paths,
			environment,
			"session-admission",
			"deferred",
			"preflight-failed",
			release.manifest.releaseSequence,
		);
		return false;
	}
	if (!admission.canPrepare) {
		await recordUpdateState(
			paths,
			environment,
			"session-admission",
			"deferred",
			stableDiagnosticReason(admission.reason, "preflight-deferred"),
			release.manifest.releaseSequence,
		);
		return false;
	}

	const preparedAt = performance.now();
	const prepared = await hooks.prepareRestart(target, predecessorTarget);
	if (!prepared) {
		await recordUpdateState(
			paths,
			environment,
			"restart-preparation",
			"deferred",
			stableDiagnosticReason(hooks.getRestartDeferralReason?.(), "restart-preparation-deferred"),
			release.manifest.releaseSequence,
		);
		return false;
	}
	const provisional: AutoBotRestartRequest = {
		...prepared,
		target,
		predecessorTarget,
		nonce: randomBytes(32).toString("base64url"),
	};
	let request: AutoBotRestartRequest;
	try {
		request = provisionalRestartRequest(prepared, target, predecessorTarget, provisional.nonce);
	} catch (error) {
		await abortPreparedRestart(hooks, provisional, "handoff-invalid");
		await recordUpdateState(
			paths,
			environment,
			"restart-preparation",
			"failed",
			"handoff-invalid",
			release.manifest.releaseSequence,
		);
		throw new Error("AutoBot update preparation returned an invalid restart request", { cause: error });
	}

	type Finalization =
		| "owned"
		| "handoff-contended"
		| "authentication-changed"
		| "sequence-rejected"
		| "release-quarantined"
		| "update-changed"
		| "handoff-budget-expired";
	let finalization: Finalization;
	try {
		finalization = await withAutoBotFileLock(paths.updateLockPath, async () =>
			withAutoBotHandoffLock(paths, async (): Promise<Finalization> => {
				const current = readAuthenticatedAutoBotEnvironment();
				if (
					!current ||
					current.role !== permittedRole ||
					current.paths.root !== paths.root ||
					current.launchId !== environment.launchId ||
					current.bootstrapProcessId !== environment.bootstrapProcessId ||
					current.runtimePath !== environment.runtimePath
				) {
					return "authentication-changed";
				}
				try {
					await assertAutoBotSequenceAllowed(paths, release.manifest, release.payloadSha256);
				} catch {
					return "sequence-rejected";
				}
				if (await isAutoBotReleaseQuarantined(paths, release.manifest)) return "release-quarantined";
				const currentUpdate = planAutoBotLaunchUpdate(current.launchRelease, release.manifest);
				if (
					!currentUpdate ||
					!sameAutoBotRestartTarget(currentUpdate.target, target) ||
					!sameAutoBotRestartTarget(currentUpdate.predecessorTarget, predecessorTarget) ||
					!stagedMatchesUpdate(staged, target, release.payloadSha256)
				) {
					return "update-changed";
				}
				if ((await readAutoBotPendingRestart(paths)) || (await readAutoBotCommittedRestart(paths))) {
					return "handoff-contended";
				}
				try {
					assertMinimumRemainingHandoffTime(request, preparedAt);
				} catch {
					return "handoff-budget-expired";
				}

				// Advancing high-water without an owner journal on a subsequent
				// write failure is safe: the exact payload remains admissible.
				await advanceAutoBotSequenceHighWater(paths, staged.manifest, staged.payloadSha256);
				const owner = {
					launchId: current.launchId,
					bootstrapProcessId: current.bootstrapProcessId,
					predecessorRuntimeProcessId: process.pid,
				} as const;
				const claim = {
					launchId: current.launchId,
					bootstrapProcessId: current.bootstrapProcessId,
				} as const;
				const handoff = {
					...request,
					protocolVersion: 1 as const,
					role: "candidate" as const,
					owner,
					runtimePath: staged.runtimePath,
					previousRuntimePath: current.runtimePath,
					createdAt: new Date().toISOString(),
				};
				const handoffPath = await createAutoBotHandoff(paths, handoff);
				try {
					if (
						!(await createAutoBotPendingRestart(paths, {
							schemaVersion: 1,
							request,
							handoffPath,
							runtimePath: staged.runtimePath,
							previousRuntimePath: current.runtimePath,
							createdAt: new Date().toISOString(),
							owner,
							claim,
						}))
					) {
						await discardAutoBotHandoff(paths, handoff);
						return "handoff-contended";
					}
				} catch (error) {
					await discardAutoBotHandoff(paths, handoff);
					throw error;
				}
				return "owned";
			}),
		);
	} catch (error) {
		await abortPreparedRestart(hooks, request, "handoff-write-failed");
		await recordUpdateState(
			paths,
			environment,
			"handoff",
			"failed",
			"handoff-write-failed",
			release.manifest.releaseSequence,
		);
		throw error;
	}
	if (finalization === "handoff-contended") {
		await abortPreparedRestart(hooks, request, "handoff-contended");
		await recordUpdateState(
			paths,
			environment,
			"handoff",
			"deferred",
			"handoff-contended",
			release.manifest.releaseSequence,
		);
		return false;
	}
	if (finalization !== "owned") {
		await abortPreparedRestart(hooks, request, "handoff-invalid");
		await recordUpdateState(
			paths,
			environment,
			"handoff",
			"deferred",
			finalization,
			release.manifest.releaseSequence,
		);
		return false;
	}

	await recordUpdateState(paths, environment, "handoff", "started", undefined, release.manifest.releaseSequence);
	// Calling commit is the irreversible boundary. Never clean up or fall back
	// after this call begins: a launcher may already have stopped the predecessor.
	await hooks.commitRestart(request);
	await recordUpdateState(paths, environment, "handoff", "completed", undefined, release.manifest.releaseSequence);
	return true;
}

async function runAutoBotUpdateCycleForPromotedRole(
	hooks: AutoBotUpdateHooks,
	permittedRole: "active" | "candidate" | "fallback",
): Promise<boolean> {
	const environment = readAuthenticatedAutoBotEnvironment();
	if (!environment || environment.role !== permittedRole) {
		if (isAutoBotCustomBuild()) throw new AutoBotManagedRuntimeRequiredError();
		return false;
	}
	if (permittedRole !== "active" && !(await hasAutoBotStartupHandoffPromotion())) return false;
	const paths = autoBotPaths(environment.paths.root);
	const canonicalRoot = await assertAutoBotPrivateDirectory(paths.root);
	if (canonicalRoot !== paths.root) throw new Error("AutoBot managed root is not canonical");
	await ensurePrivateDirectory(paths.lockDir);
	return runUpdateCycle(paths, hooks, permittedRole);
}

/** Run one signed update poll for the current authenticated active runtime. */
export async function runAutoBotUpdateCycle(hooks: AutoBotUpdateHooks): Promise<boolean> {
	return runAutoBotUpdateCycleForPromotedRole(hooks, "active");
}

/**
 * Start an immediate, non-overlapping update loop. The next poll is measured
 * from completion, so lock contention and slow downloads never create a queue.
 */
export function startAutoBotPollingLoop(
	runCycle: () => Promise<unknown>,
	intervalMs = AUTO_BOT_UPDATE_INTERVAL_MS,
): Pick<AutoBotUpdateHandle, "dispose"> {
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const poll = async (): Promise<void> => {
		if (disposed) return;
		try {
			await runCycle();
		} catch {
			logger.error("AutoBot update poll failed", { reason: "update-cycle-failed" });
		} finally {
			if (!disposed) {
				timer = setTimeout(() => void poll(), intervalMs);
				timer.unref?.();
			}
		}
	};
	void poll();
	return {
		dispose() {
			disposed = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}

/** Start managed polling after the runtime's authenticated role is active. */
export function startAutoBotUpdates(hooks: AutoBotUpdateHooks): AutoBotUpdateHandle {
	if (!isVerifiedAutoBotManagedRuntime() && isAutoBotCustomBuild()) throw new AutoBotManagedRuntimeRequiredError();

	let polling: Pick<AutoBotUpdateHandle, "dispose"> | undefined;
	let disposed = false;
	const dispose = () => {
		disposed = true;
		polling?.dispose();
		polling = undefined;
	};
	const startPollingAfterAuthenticatedPromotion = (role: "active" | "candidate" | "fallback") => {
		if (disposed || polling !== undefined) return;
		polling = startAutoBotPollingLoop(() => runAutoBotUpdateCycleForPromotedRole(hooks, role));
	};
	const handle = (input: Omit<AutoBotUpdateHandle, "dispose">): AutoBotUpdateHandle => ({
		...input,
		dispose,
	});

	const startup = getAutoBotStartupHandoff();
	if (startup?.role === "candidate") {
		const source = startup.candidate;
		const candidate: AutoBotRestartCandidate = {
			request: source.request,
			signalReady: () => source.signalReady(),
			waitForActivation: () => source.waitForActivation(),
			acknowledgeActivation: async () => {
				await source.acknowledgeActivation();
				await promoteAutoBotStartupHandoff();
				// A candidate gets its loop only after both the protected
				// activation acknowledgement and nonce/PID-bound promotion.
				startPollingAfterAuthenticatedPromotion("candidate");
			},
			reject: reason => source.reject(reason),
		};
		return handle({ candidate });
	}
	if (startup?.role === "fallback") {
		const fallbackStartup = (
			hooks.restorePredecessorFallback
				? hooks.restorePredecessorFallback(startup.fallback)
				: Promise.reject(new Error("AutoBot fallback runtime has no protected predecessor restoration handler"))
		).then(async () => {
			// The hook resolves only after Browser/coordinator restores the exact
			// old session. Bind that fact to this nonce/PID before polling.
			await promoteAutoBotStartupHandoff();
			startPollingAfterAuthenticatedPromotion("fallback");
		});
		return handle({ startup: fallbackStartup });
	}
	const environment = readAuthenticatedAutoBotEnvironment();
	if (!environment || environment.role !== "active") return handle({});
	startPollingAfterAuthenticatedPromotion("active");
	return handle({});
}

export { getAutoBotStartupHandoff } from "./handoff";
