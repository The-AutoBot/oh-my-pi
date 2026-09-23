import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import {
	AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
	AUTO_BOT_RESTART_EXIT_CODE,
	parseAutoBotReleaseManifest,
	sameAutoBotRestartTarget,
	serializeAutoBotReleaseManifest,
	type AutoBotReleaseManifest,
	type AutoBotRestartRequest,
	type AutoBotHandoffRecord,
	type AutoBotHandoffClaim,
} from "./contract";
import { readAutoBotChannelConfigSync } from "./channel";
import {
	createAutoBotHandoff,
	discardAutoBotHandoff,
	readAutoBotHandoff,
	resetAutoBotCandidateHandoffForRecovery,
	hasAutoBotActivationAcknowledgement,
	hasAutoBotCandidateRejection,
	hasAutoBotNormalExitIntent,
	hasAutoBotRestartExitAuthorization,
	hasAutoBotRuntimePromotion,
	readAutoBotCandidateReady,
	writeAutoBotActivation,
	writeAutoBotCandidateRejection,
} from "./handoff";
import {
	autoBotReservedEnvironment,
	readAutoBotInstallationIdentitySync,
	type AutoBotInstallationIdentity,
} from "./identity";
import {
	AutoBotInstallationChannelUnavailableError,
	AutoBotInstallationQuarantinedError,
	recoverAutoBotInstallation,
	refreshAutoBotInstallation,
	type AutoBotInstallationRefreshResult,
} from "./installation";
import { writeAutoBotUpdateDiagnostic, type AutoBotUpdateDiagnosticInput } from "./diagnostics";
import { acquireAutoBotFileLock } from "./lock";
import { autoBotLaunchLeaseLockPath, autoBotPaths, resolveAutoBotBootstrapRoot, type AutoBotPaths } from "./paths";
import {
	advanceAutoBotActivePointer,
	clearAutoBotCommittedRestart,
	clearAutoBotPendingRestartForCommitted,
	clearAutoBotPendingRestart,
	commitAutoBotPendingRestart,
	matchesAutoBotHandoffJournal,
	quarantineAutoBotRelease,
	readAutoBotActivePointer,
	readAutoBotCommittedRestart,
	readAutoBotPendingRestart,
	hasAutoBotPendingRestartOwnership,
	readAutoBotPendingRestartForOwner,
	replaceAutoBotCommittedRestart,
	sameAutoBotHandoffClaim,
	withAutoBotHandoffLock,
	type AutoBotActivePointer,
	type AutoBotCommittedRestart,
	type AutoBotHandoffJournalMatch,
	type AutoBotPendingRestart,
} from "./state";
import { assertAutoBotPrivateDirectory } from "./permissions";
import { sha256File } from "./storage";
import { scrubAutoBotLaunchEnvironment } from "./trust-env";
import {
	AUTO_BOT_ACTIVATION_ACK_TIMEOUT_MS,
	AUTO_BOT_CANDIDATE_READY_TIMEOUT_MS,
	AUTO_BOT_FAILED_CANDIDATE_RETIREMENT_TIMEOUT_MS,
	AUTO_BOT_FALLBACK_STARTUP_TIMEOUT_MS,
} from "./timing";

const BOOTSTRAP_VERSION = 1;
const POLL_MS = 100;

interface RuntimeProcess {
	readonly pid: number;
	readonly exited: Promise<number>;
	kill(): void;
}

interface StagedRuntime {
	readonly slotId: string;
	readonly runtimePath: string;
	readonly runtimeSha256: string;
	readonly manifest: AutoBotReleaseManifest;
}

const SlotMarkerSchema = type({
	schemaVersion: "1",
	payloadSha256: "string > 0",
	manifest: "unknown",
	runtimeSha256: "string > 0",
	bootstrapPath: "string > 0",
	createdAt: "string > 0",
});

function executableName(): string {
	return process.platform === "win32" ? "omp.exe" : "omp";
}

function trustedPortalBase(paths: AutoBotPaths): string | undefined {
	try {
		return readAutoBotChannelConfigSync(paths.channelConfigPath)?.collabPortalUrl;
	} catch {
		return undefined;
	}
}

function validPortalUrl(paths: AutoBotPaths, bundleId: string): string | undefined {
	const configured = trustedPortalBase(paths);
	if (!configured) return undefined;
	try {
		const url = new URL(configured);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/live"
		) {
			return undefined;
		}
		return `${url.origin}/live/${bundleId}`;
	} catch {
		return undefined;
	}
}

async function readStagedRuntime(paths: AutoBotPaths, runtimePath: string): Promise<StagedRuntime> {
	const resolvedRuntimePath = path.resolve(runtimePath);
	const slotPath = path.dirname(resolvedRuntimePath);
	const relative = path.relative(paths.runtimeDir, slotPath);
	if (
		!relative ||
		relative.startsWith("..") ||
		path.isAbsolute(relative) ||
		path.basename(resolvedRuntimePath) !== executableName()
	) {
		throw new Error("Managed runtime path is invalid");
	}
	const markerValue = SlotMarkerSchema.assert(JSON.parse(await Bun.file(path.join(slotPath, "release.json")).text()));
	if (markerValue.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(markerValue.runtimeSha256)) {
		throw new Error("Managed runtime slot marker is invalid");
	}
	const manifest = parseAutoBotReleaseManifest(markerValue.manifest);
	if ((await sha256File(resolvedRuntimePath)) !== markerValue.runtimeSha256) {
		throw new Error("Managed runtime slot integrity check failed");
	}
	return {
		slotId: path.basename(slotPath),
		runtimePath: resolvedRuntimePath,
		runtimeSha256: markerValue.runtimeSha256,
		manifest,
	};
}

function handoffProfileEnvironment(
	environment: NodeJS.ProcessEnv,
	request: Pick<AutoBotRestartRequest, "profile"> | undefined,
): NodeJS.ProcessEnv {
	if (request === undefined) return environment;
	const protectedEnvironment = { ...environment };
	for (const key of Object.keys(protectedEnvironment)) {
		const normalized = key.toUpperCase();
		if (normalized === "OMP_PROFILE" || normalized === "PI_PROFILE") {
			delete protectedEnvironment[key];
		}
	}
	if (request.profile !== undefined) protectedEnvironment.OMP_PROFILE = request.profile;
	return protectedEnvironment;
}

/** Test seam for profile precedence at authenticated restart boundaries. */
export function __projectAutoBotHandoffProfileEnvironmentForTests(
	environment: NodeJS.ProcessEnv,
	request: Pick<AutoBotRestartRequest, "profile"> | undefined,
): NodeJS.ProcessEnv {
	return handoffProfileEnvironment(environment, request);
}

function runtimeEnvironment(input: {
	readonly paths: AutoBotPaths;
	readonly identity: AutoBotInstallationIdentity;
	readonly runtime: StagedRuntime;
	readonly role: "active" | "candidate" | "fallback";
	readonly claim: AutoBotHandoffClaim;
	readonly request?: AutoBotRestartRequest;
}): NodeJS.ProcessEnv {
	return {
		...handoffProfileEnvironment(scrubAutoBotLaunchEnvironment(process.env), input.request),
		...autoBotReservedEnvironment({
			paths: input.paths,
			identity: input.identity,
			runtimePath: input.runtime.runtimePath,
			role: input.role,
			launchId: input.claim.launchId,
			bootstrapProcessId: input.claim.bootstrapProcessId,
			...(input.request
				? { handoffFile: path.join(input.paths.handoffDir, `${input.request.nonce}.${input.role}.json`) }
				: {}),
			...(input.request ? { handoffNonce: input.request.nonce } : {}),
			releaseSequence: input.runtime.manifest.releaseSequence,
			releaseVersion: input.runtime.manifest.upstreamVersion,
			forkCommit: input.runtime.manifest.forkCommit,
			sessionFormatVersion: input.runtime.manifest.sessionFormatVersion,
			collabProtocolVersion: input.runtime.manifest.collabProtocolVersion,
			compatibilityEpoch: input.runtime.manifest.compatibilityEpoch,
			webBundleId: input.runtime.manifest.webBundleId,
			...(validPortalUrl(input.paths, input.runtime.manifest.webBundleId)
				? { collabWebUrl: validPortalUrl(input.paths, input.runtime.manifest.webBundleId) }
				: {}),
		}),
	};
}

function startRuntime(input: {
	readonly paths: AutoBotPaths;
	readonly identity: AutoBotInstallationIdentity;
	readonly runtime: StagedRuntime;
	readonly role: "active" | "candidate" | "fallback";
	readonly claim: AutoBotHandoffClaim;
	readonly cwd: string;
	readonly request?: AutoBotRestartRequest;
	readonly argv: readonly string[];
}): RuntimeProcess {
	return Bun.spawn([input.runtime.runtimePath, ...input.argv], {
		cwd: input.cwd,
		env: runtimeEnvironment(input),
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
}

type CandidateReadyWait = "ready" | "normal-exit" | "rejected" | "timed-out" | { readonly exitCode: number };

async function waitForCandidateReady(
	paths: AutoBotPaths,
	request: AutoBotRestartRequest,
	runtimePath: string,
	child: RuntimeProcess,
): Promise<CandidateReadyWait> {
	let exitCode: number | undefined;
	void child.exited.then(code => {
		exitCode = code;
	});
	const normalExit = () =>
		hasAutoBotNormalExitIntent({
			paths,
			request,
			role: "candidate",
			runtimePath,
			processId: child.pid,
		});
	const deadline = Date.now() + AUTO_BOT_CANDIDATE_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await normalExit()) return "normal-exit";
		if (await hasAutoBotCandidateRejection(paths, request)) return "rejected";
		if (await readAutoBotCandidateReady(paths, request)) return "ready";
		if (exitCode !== undefined) return { exitCode };
		await Bun.sleep(POLL_MS);
	}
	if (await normalExit()) return "normal-exit";
	return exitCode === undefined ? "timed-out" : { exitCode };
}

async function retireFailedCandidate(child: RuntimeProcess): Promise<boolean> {
	try {
		child.kill();
	} catch {
		return false;
	}
	return (
		(await Promise.race([
			child.exited.then(() => true),
			Bun.sleep(AUTO_BOT_FAILED_CANDIDATE_RETIREMENT_TIMEOUT_MS).then(() => false),
		])) === true
	);
}

function journalMatch(
	record: Pick<AutoBotPendingRestart, "owner" | "claim" | "request" | "runtimePath" | "previousRuntimePath">,
): AutoBotHandoffJournalMatch {
	return {
		owner: record.owner,
		claim: record.claim,
		request: record.request,
		runtimePath: record.runtimePath,
		previousRuntimePath: record.previousRuntimePath,
	};
}

function isClaimedBy(record: Pick<AutoBotPendingRestart, "claim">, claim: AutoBotHandoffClaim): boolean {
	return sameAutoBotHandoffClaim(record.claim, claim);
}

async function discardAutoBotHandoffIfOwned(paths: AutoBotPaths, expected: AutoBotHandoffRecord): Promise<void> {
	const handoffPath = path.join(paths.handoffDir, `${expected.nonce}.${expected.role}.json`);
	const current = await readAutoBotHandoff(paths, handoffPath);
	if (
		current &&
		current.role === expected.role &&
		current.nonce === expected.nonce &&
		current.owner.launchId === expected.owner.launchId &&
		current.owner.bootstrapProcessId === expected.owner.bootstrapProcessId &&
		current.owner.predecessorRuntimeProcessId === expected.owner.predecessorRuntimeProcessId
	) {
		await discardAutoBotHandoff(paths, expected);
	}
}

type CandidateJournalRecord = Pick<AutoBotPendingRestart, "owner" | "request" | "runtimePath" | "previousRuntimePath">;

function candidateHandoffMatchesJournal(handoff: AutoBotHandoffRecord, record: CandidateJournalRecord): boolean {
	const request = record.request;
	return (
		handoff.role === "candidate" &&
		handoff.nonce === request.nonce &&
		handoff.owner.launchId === record.owner.launchId &&
		handoff.owner.bootstrapProcessId === record.owner.bootstrapProcessId &&
		handoff.owner.predecessorRuntimeProcessId === record.owner.predecessorRuntimeProcessId &&
		path.resolve(handoff.runtimePath) === path.resolve(record.runtimePath) &&
		path.resolve(handoff.previousRuntimePath) === path.resolve(record.previousRuntimePath) &&
		handoff.sessionFile === request.sessionFile &&
		handoff.sessionId === request.sessionId &&
		handoff.cwd === request.cwd &&
		handoff.profile === request.profile &&
		handoff.expiresAt === request.expiresAt &&
		handoff.leaseDurationMs === request.leaseDurationMs &&
		handoff.fallbackInstanceId === request.fallbackInstanceId &&
		JSON.stringify(handoff.context) === JSON.stringify(request.context) &&
		sameAutoBotRestartTarget(handoff.target, request.target) &&
		sameAutoBotRestartTarget(handoff.predecessorTarget, request.predecessorTarget)
	);
}

async function readCandidateHandoffForJournal(
	paths: AutoBotPaths,
	record: CandidateJournalRecord,
): Promise<AutoBotHandoffRecord | undefined> {
	const handoff = await readAutoBotHandoff(
		paths,
		path.join(paths.handoffDir, `${record.request.nonce}.candidate.json`),
	);
	return handoff && candidateHandoffMatchesJournal(handoff, record) ? handoff : undefined;
}

async function discardCandidateHandoffIfOwned(paths: AutoBotPaths, pending: AutoBotPendingRestart): Promise<void> {
	const handoff = await readAutoBotHandoff(paths, pending.handoffPath);
	if (handoff && candidateHandoffMatchesJournal(handoff, pending)) {
		await discardAutoBotHandoffIfOwned(paths, handoff);
	}
}

/** Remove only the exact current bootstrap claimant's candidate ownership. */
async function abandonCandidateRestart(
	paths: AutoBotPaths,
	pending: AutoBotPendingRestart,
	claim: AutoBotHandoffClaim,
): Promise<void> {
	if (!isClaimedBy(pending, claim)) return;
	await withAutoBotHandoffLock(paths, async () => {
		const expected = journalMatch(pending);
		await clearAutoBotPendingRestart(paths, expected);
		await clearAutoBotCommittedRestart(paths, expected);
		await discardCandidateHandoffIfOwned(paths, pending);
	});
}

async function abandonPendingRestart(
	paths: AutoBotPaths,
	pending: AutoBotPendingRestart,
	claim: AutoBotHandoffClaim,
): Promise<void> {
	await abandonCandidateRestart(paths, pending, claim);
}

/** Promotion retains its authenticated handoff, but releases only exact journals. */
async function clearCandidateRestartOwnership(
	paths: AutoBotPaths,
	pending: AutoBotPendingRestart,
	claim: AutoBotHandoffClaim,
): Promise<void> {
	if (!isClaimedBy(pending, claim)) return;
	await withAutoBotHandoffLock(paths, async () => {
		const expected = journalMatch(pending);
		await clearAutoBotPendingRestart(paths, expected);
		await clearAutoBotCommittedRestart(paths, expected);
	});
}

async function clearCommittedRestartOwnership(
	paths: AutoBotPaths,
	committed: AutoBotCommittedRestart,
	claim: AutoBotHandoffClaim,
): Promise<void> {
	if (!isClaimedBy(committed, claim)) return;
	await withAutoBotHandoffLock(paths, async () => {
		if (!(await clearAutoBotPendingRestartForCommitted(paths, committed))) return;
		await clearAutoBotCommittedRestart(paths, journalMatch(committed));
	});
}

async function abandonCommittedRestart(
	paths: AutoBotPaths,
	committed: AutoBotCommittedRestart,
	claim: AutoBotHandoffClaim,
): Promise<void> {
	if (!isClaimedBy(committed, claim)) return;
	await withAutoBotHandoffLock(paths, async () => {
		if (!(await clearAutoBotPendingRestartForCommitted(paths, committed))) return;
		await clearAutoBotCommittedRestart(paths, journalMatch(committed));
		const handoff = await readAutoBotHandoff(
			paths,
			path.join(paths.handoffDir, `${committed.request.nonce}.candidate.json`),
		);
		if (
			handoff &&
			handoff.role === "candidate" &&
			handoff.owner.launchId === committed.owner.launchId &&
			handoff.owner.bootstrapProcessId === committed.owner.bootstrapProcessId &&
			handoff.owner.predecessorRuntimeProcessId === committed.owner.predecessorRuntimeProcessId
		) {
			await discardAutoBotHandoffIfOwned(paths, handoff);
		}
	});
}
type CandidateActivationWait = "acknowledged" | "normal-exit" | "exited" | "timed-out";

async function waitForCandidateActivationAcknowledgement(
	paths: AutoBotPaths,
	request: AutoBotRestartRequest,
	runtimePath: string,
	child: RuntimeProcess,
): Promise<CandidateActivationWait> {
	let exited = false;
	void child.exited.then(() => {
		exited = true;
	});
	const normalExit = () =>
		hasAutoBotNormalExitIntent({
			paths,
			request,
			role: "candidate",
			runtimePath,
			processId: child.pid,
		});
	const deadline = Date.now() + AUTO_BOT_ACTIVATION_ACK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await normalExit()) return "normal-exit";
		if (await hasAutoBotActivationAcknowledgement(paths, request)) return "acknowledged";
		if (exited) return "exited";
		await Bun.sleep(POLL_MS);
	}
	if (await normalExit()) return "normal-exit";
	if (await hasAutoBotActivationAcknowledgement(paths, request)) return "acknowledged";
	return exited ? "exited" : "timed-out";
}

type LateCandidateActivationWait = "acknowledged" | "normal-exit" | "exited";

async function waitForLateCandidateActivationAcknowledgement(
	paths: AutoBotPaths,
	request: AutoBotRestartRequest,
	runtimePath: string,
	child: RuntimeProcess,
): Promise<LateCandidateActivationWait> {
	let exited = false;
	void child.exited.then(() => {
		exited = true;
	});
	const normalExit = () =>
		hasAutoBotNormalExitIntent({
			paths,
			request,
			role: "candidate",
			runtimePath,
			processId: child.pid,
		});
	while (true) {
		if (await normalExit()) return "normal-exit";
		if (await hasAutoBotActivationAcknowledgement(paths, request)) return "acknowledged";
		if (exited) return "exited";
		await Bun.sleep(POLL_MS);
	}
}

type CandidatePromotionWait = "promoted" | "normal-exit" | "exited";

/**
 * ACK only means the candidate accepted activation. Its PID-bound promotion
 * must be durable before moving the active pointer or releasing committed
 * ownership, otherwise recovered children can lose their authentication race.
 */
async function waitForCandidatePromotion(
	paths: AutoBotPaths,
	handoff: AutoBotHandoffRecord,
	child: RuntimeProcess,
): Promise<CandidatePromotionWait> {
	let exited = false;
	void child.exited.then(() => {
		exited = true;
	});
	const normalExit = () =>
		hasAutoBotNormalExitIntent({
			paths,
			request: handoff,
			role: "candidate",
			runtimePath: handoff.runtimePath,
			processId: child.pid,
		});
	while (true) {
		if (await normalExit()) return "normal-exit";
		if (
			await hasAutoBotRuntimePromotion({
				paths,
				handoff,
				role: "candidate",
				runtimePath: handoff.runtimePath,
				processId: child.pid,
			})
		) {
			return "promoted";
		}
		if (exited) return "exited";
		await Bun.sleep(POLL_MS);
	}
}

async function writeActiveRuntime(paths: AutoBotPaths, runtime: StagedRuntime): Promise<AutoBotActivePointer> {
	const active: AutoBotActivePointer = {
		schemaVersion: 1,
		slotId: runtime.slotId,
		runtimePath: runtime.runtimePath,
		runtimeSha256: runtime.runtimeSha256,
		manifest: runtime.manifest,
		activatedAt: new Date().toISOString(),
	};
	await advanceAutoBotActivePointer(paths, active);
	return active;
}

async function supervisePromotedRuntime(
	paths: AutoBotPaths,
	identity: AutoBotInstallationIdentity,
	claim: AutoBotHandoffClaim,
	active: AutoBotActivePointer,
	runtime: StagedRuntime,
	child: RuntimeProcess,
	terminationRequested: () => boolean,
): Promise<number> {
	const runtimeExit = await child.exited;
	const owner = {
		launchId: claim.launchId,
		bootstrapProcessId: claim.bootstrapProcessId,
		predecessorRuntimeProcessId: child.pid,
	};
	// The authenticated child is already dead, so no legitimate writer can
	// newly publish its owner tuple. Foreign or absent journals need no
	// cleanup; never let an unrelated transaction turn a normal exit into 1.
	if (runtimeExit === 0 && !(await hasAutoBotPendingRestartOwnership(paths, owner, claim))) {
		return runtimeExit;
	}
	const pending = await withAutoBotHandoffLock(paths, () =>
		readAutoBotPendingRestartForOwner(paths, owner, claim, runtime.runtimePath),
	);
	if (!pending) return runtimeExit;
	if (
		await hasAutoBotNormalExitIntent({
			paths,
			request: pending.request,
			role: "predecessor",
			runtimePath: runtime.runtimePath,
			processId: child.pid,
		})
	) {
		await abandonPendingRestart(paths, pending, claim);
		return runtimeExit === AUTO_BOT_RESTART_EXIT_CODE ? 0 : runtimeExit;
	}

	// Ctrl+C and ordinary exits belong to the foreground runtime. They never
	// become an update merely because a preflight record happens to exist.
	const restartAuthorized =
		runtimeExit === AUTO_BOT_RESTART_EXIT_CODE &&
		!terminationRequested() &&
		(await hasAutoBotRestartExitAuthorization(paths, pending.request));
	if (!restartAuthorized) {
		await abandonPendingRestart(paths, pending, claim);
		return runtimeExit;
	}
	const candidate = await readStagedRuntime(paths, pending.runtimePath);
	const candidateChild = startRuntime({
		paths,
		identity,
		claim,
		runtime: candidate,
		role: "candidate",
		cwd: pending.request.cwd,
		request: pending.request,
		argv: [],
	});
	return activateCandidate(paths, identity, claim, active, pending, candidate, candidateChild, terminationRequested);
}

function runtimeMatchesRestartTarget(runtime: StagedRuntime, target: AutoBotRestartRequest["target"]): boolean {
	const manifest = runtime.manifest;
	return (
		manifest.releaseSequence === target.releaseSequence &&
		manifest.upstreamVersion === target.upstreamVersion &&
		manifest.forkCommit === target.forkCommit &&
		manifest.sessionFormatVersion === target.sessionFormatVersion &&
		manifest.collabProtocolVersion === target.collabProtocolVersion &&
		manifest.compatibilityEpoch === target.compatibilityEpoch &&
		manifest.webBundleId === target.webBundleId
	);
}
export type AutoBotCandidateFailureKind = "runtime-rejected" | "startup-failed";

export function shouldQuarantineAutoBotCandidateFailure(
	preferred: AutoBotActivePointer | undefined,
	target: AutoBotRestartRequest["target"],
	failure: AutoBotCandidateFailureKind,
): boolean {
	if (failure !== "runtime-rejected" || !preferred) return true;
	if (preferred.manifest.releaseSequence > target.releaseSequence) return false;
	const manifest = preferred.manifest;
	return !(
		manifest.releaseSequence === target.releaseSequence &&
		manifest.upstreamVersion === target.upstreamVersion &&
		manifest.forkCommit === target.forkCommit &&
		manifest.sessionFormatVersion === target.sessionFormatVersion &&
		manifest.collabProtocolVersion === target.collabProtocolVersion &&
		manifest.compatibilityEpoch === target.compatibilityEpoch &&
		manifest.webBundleId === target.webBundleId
	);
}

type FallbackPromotionWait = "promoted" | "normal-exit" | "timed-out" | { readonly exitCode: number };

async function waitForFallbackPromotion(
	paths: AutoBotPaths,
	handoff: AutoBotHandoffRecord,
	child: RuntimeProcess,
): Promise<FallbackPromotionWait> {
	let exitCode: number | undefined;
	void child.exited.then(code => {
		exitCode = code;
	});
	const normalExit = () =>
		hasAutoBotNormalExitIntent({
			paths,
			request: handoff,
			role: "fallback",
			runtimePath: handoff.runtimePath,
			processId: child.pid,
		});
	const deadline = Date.now() + AUTO_BOT_FALLBACK_STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await normalExit()) return "normal-exit";
		if (
			await hasAutoBotRuntimePromotion({
				paths,
				handoff,
				role: "fallback",
				runtimePath: handoff.runtimePath,
				processId: child.pid,
			})
		) {
			return "promoted";
		}
		if (exitCode !== undefined) return { exitCode };
		await Bun.sleep(POLL_MS);
	}
	if (await normalExit()) return "normal-exit";
	return exitCode === undefined ? "timed-out" : { exitCode };
}

async function launchFallback(
	paths: AutoBotPaths,
	identity: AutoBotInstallationIdentity,
	claim: AutoBotHandoffClaim,
	active: AutoBotActivePointer,
	pending: AutoBotPendingRestart,
	failedCandidateProcessId: number,
	terminationRequested: () => boolean,
): Promise<number> {
	const fallbackRuntime = await readStagedRuntime(paths, active.runtimePath);
	const fallbackRequest: AutoBotRestartRequest = {
		...pending.request,
		target: pending.request.predecessorTarget,
		predecessorTarget: pending.request.predecessorTarget,
	};
	if (!runtimeMatchesRestartTarget(fallbackRuntime, fallbackRequest.target)) {
		throw new Error("AutoBot recorded predecessor target does not match its fallback runtime");
	}
	const fallbackHandoff = await withAutoBotHandoffLock(paths, async () => {
		const current = await readAutoBotPendingRestart(paths);
		if (!current || !isClaimedBy(current, claim) || !matchesAutoBotHandoffJournal(current, journalMatch(pending))) {
			return undefined;
		}
		await discardCandidateHandoffIfOwned(paths, current);
		const handoff: AutoBotHandoffRecord = {
			...fallbackRequest,
			protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
			role: "fallback",
			attemptedTarget: pending.request.target,
			owner: {
				launchId: claim.launchId,
				bootstrapProcessId: claim.bootstrapProcessId,
				predecessorRuntimeProcessId: failedCandidateProcessId,
			},
			runtimePath: fallbackRuntime.runtimePath,
			previousRuntimePath: pending.runtimePath,
			createdAt: new Date().toISOString(),
		};
		await createAutoBotHandoff(paths, handoff);
		if (!(await clearAutoBotPendingRestart(paths, journalMatch(current)))) {
			await discardAutoBotHandoffIfOwned(paths, handoff);
			return undefined;
		}
		return handoff;
	});
	if (!fallbackHandoff) return 1;
	const child = startRuntime({
		paths,
		identity,
		claim,
		runtime: fallbackRuntime,
		role: "fallback",
		cwd: fallbackRequest.cwd,
		request: fallbackRequest,
		argv: [],
	});
	const startup = await waitForFallbackPromotion(paths, fallbackHandoff, child);
	if (startup !== "promoted") {
		if (startup === "normal-exit" || (typeof startup === "object" && startup.exitCode === 0)) {
			const exitCode = startup === "normal-exit" ? await child.exited : startup.exitCode;
			await withAutoBotHandoffLock(paths, () => discardAutoBotHandoffIfOwned(paths, fallbackHandoff));
			return exitCode;
		}
		if (await retireFailedCandidate(child)) {
			await withAutoBotHandoffLock(paths, () => discardAutoBotHandoffIfOwned(paths, fallbackHandoff));
		}
		return 1;
	}
	const exitCode = await supervisePromotedRuntime(
		paths,
		identity,
		claim,
		active,
		fallbackRuntime,
		child,
		terminationRequested,
	);
	await withAutoBotHandoffLock(paths, () => discardAutoBotHandoffIfOwned(paths, fallbackHandoff));
	return exitCode;
}

async function activateCandidate(
	paths: AutoBotPaths,
	identity: AutoBotInstallationIdentity,
	claim: AutoBotHandoffClaim,
	active: AutoBotActivePointer,
	pending: AutoBotPendingRestart,
	candidate: StagedRuntime,
	child: RuntimeProcess,
	terminationRequested: () => boolean,
): Promise<number> {
	const normalExit = () =>
		hasAutoBotNormalExitIntent({
			paths,
			request: pending.request,
			role: "candidate",
			runtimePath: candidate.runtimePath,
			processId: child.pid,
		});
	const stopNormally = async (): Promise<number> => {
		const exitCode = await child.exited;
		await abandonCandidateRestart(paths, pending, claim);
		return exitCode;
	};
	const finishExitedCandidate = async (): Promise<number> => child.exited;
	const ready = await waitForCandidateReady(paths, pending.request, candidate.runtimePath, child);
	if (ready !== "ready") {
		if (ready === "normal-exit") return stopNormally();
		if (typeof ready === "object" && ready.exitCode === 0) {
			await abandonCandidateRestart(paths, pending, claim);
			return ready.exitCode;
		}
		if (await retireFailedCandidate(child)) {
			await withAutoBotHandoffLock(paths, async () => {
				const current = await readAutoBotPendingRestart(paths);
				if (current && matchesAutoBotHandoffJournal(current, journalMatch(pending))) {
					await writeAutoBotCandidateRejection(paths, pending.request);
				}
			}).catch(() => undefined);
			let preferred: AutoBotActivePointer | undefined;
			try {
				preferred = await readAutoBotActivePointer(paths);
			} catch {
				// An unreadable preferred pointer is not evidence that this release
				// is healthy; retain the conservative quarantine behavior.
			}
			if (
				shouldQuarantineAutoBotCandidateFailure(
					preferred,
					pending.request.target,
					ready === "rejected" ? "runtime-rejected" : "startup-failed",
				)
			) {
				await quarantineAutoBotRelease(paths, pending.request.target).catch(() => undefined);
			}
			return launchFallback(paths, identity, claim, active, pending, child.pid, terminationRequested);
		}
		return 1;
	}
	if (await normalExit()) return stopNormally();
	const committed: AutoBotCommittedRestart = {
		schemaVersion: 1,
		request: pending.request,
		runtimePath: candidate.runtimePath,
		previousRuntimePath: active.runtimePath,
		committedAt: new Date().toISOString(),
		owner: pending.owner,
		claim: pending.claim,
		candidateRuntimeProcessId: child.pid,
		recoveryState: "candidate-running",
	};
	if (
		!(await withAutoBotHandoffLock(paths, () => commitAutoBotPendingRestart(paths, journalMatch(pending), committed)))
	) {
		return 1;
	}
	await withAutoBotHandoffLock(paths, async () => {
		const current = await readAutoBotCommittedRestart(paths);
		if (!current || !matchesAutoBotHandoffJournal(current, journalMatch(committed))) {
			throw new Error("AutoBot candidate committed owner changed before activation");
		}
		await writeAutoBotActivation(paths, pending.request);
	});
	const acknowledgement = await waitForCandidateActivationAcknowledgement(
		paths,
		pending.request,
		candidate.runtimePath,
		child,
	);
	if (acknowledgement === "normal-exit") return stopNormally();
	if (acknowledgement !== "acknowledged") {
		// Activation was durably sent. Never roll back, kill, or fall back while
		// the candidate might own live work; continue observing it for a late ACK.
		if (acknowledgement !== "timed-out") return finishExitedCandidate();
		const lateAcknowledgement = await waitForLateCandidateActivationAcknowledgement(
			paths,
			pending.request,
			candidate.runtimePath,
			child,
		);
		if (lateAcknowledgement === "normal-exit") return stopNormally();
		if (lateAcknowledgement !== "acknowledged") return finishExitedCandidate();
	}
	const handoff = await readCandidateHandoffForJournal(paths, pending);
	if (!handoff) return finishExitedCandidate();
	const promotion = await waitForCandidatePromotion(paths, handoff, child);
	if (promotion === "normal-exit") return stopNormally();
	if (promotion !== "promoted") return finishExitedCandidate();
	const promoted = await writeActiveRuntime(paths, candidate);
	await clearCandidateRestartOwnership(paths, pending, claim);
	return supervisePromotedRuntime(paths, identity, claim, promoted, candidate, child, terminationRequested);
}

function processIsDefinitelyDead(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return false;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ESRCH";
	}
}

type CommittedRecovery =
	| { readonly kind: "none" | "blocked" | "normal-exit" }
	| { readonly kind: "claimed"; readonly committed: AutoBotCommittedRestart };

/**
 * Claim a committed orphan only after proving its originating bootstrap lease
 * and both recorded process identities are dead. The intermediate state is
 * intentionally non-adoptable until the replacement child PID is durable.
 */
async function claimOrphanedCommittedRestart(
	paths: AutoBotPaths,
	claim: AutoBotHandoffClaim,
): Promise<CommittedRecovery> {
	// Never acquire an old lifetime lease while holding handoffLock: an owner
	// holds that lease through supervision and can itself need handoffLock.
	const snapshot = await withAutoBotHandoffLock(paths, () => readAutoBotCommittedRestart(paths));
	if (!snapshot) return { kind: "none" };
	if (snapshot.recoveryState !== "candidate-running") return { kind: "blocked" };
	let previousLease: Awaited<ReturnType<typeof acquireAutoBotFileLock>>;
	try {
		previousLease = await acquireAutoBotFileLock(autoBotLaunchLeaseLockPath(paths, snapshot.claim.launchId), {
			retries: 1,
			retryDelayMs: 0,
			requireExisting: true,
		});
	} catch {
		// Busy, missing, corrupt, or permission-uncertain old lease storage
		// is never evidence that its bootstrap is safely gone.
		return { kind: "blocked" };
	}
	try {
		if (
			!processIsDefinitelyDead(snapshot.candidateRuntimeProcessId) ||
			!processIsDefinitelyDead(snapshot.owner.predecessorRuntimeProcessId)
		) {
			return { kind: "blocked" };
		}
		// Retain the old-owner proof until the locked reread/CAS/reset finishes.
		return await withAutoBotHandoffLock(paths, async () => {
			const committed = await readAutoBotCommittedRestart(paths);
			if (
				!committed ||
				committed.recoveryState !== "candidate-running" ||
				!matchesAutoBotHandoffJournal(committed, journalMatch(snapshot)) ||
				!processIsDefinitelyDead(committed.candidateRuntimeProcessId) ||
				!processIsDefinitelyDead(committed.owner.predecessorRuntimeProcessId)
			) {
				return { kind: "blocked" };
			}
			if (!(await clearAutoBotPendingRestartForCommitted(paths, committed))) return { kind: "blocked" };
			if (
				await hasAutoBotNormalExitIntent({
					paths,
					request: committed.request,
					role: "candidate",
					runtimePath: committed.runtimePath,
					processId: committed.candidateRuntimeProcessId,
				})
			) {
				await clearAutoBotCommittedRestart(paths, journalMatch(committed));
				const handoff = await readAutoBotHandoff(
					paths,
					path.join(paths.handoffDir, `${committed.request.nonce}.candidate.json`),
				);
				if (
					handoff &&
					handoff.role === "candidate" &&
					handoff.owner.launchId === committed.owner.launchId &&
					handoff.owner.bootstrapProcessId === committed.owner.bootstrapProcessId &&
					handoff.owner.predecessorRuntimeProcessId === committed.owner.predecessorRuntimeProcessId
				) {
					await discardAutoBotHandoffIfOwned(paths, handoff);
				}
				return { kind: "normal-exit" };
			}
			const claimed: AutoBotCommittedRestart = {
				...committed,
				claim,
				recoveryState: "attempt-starting",
			};
			if (!(await replaceAutoBotCommittedRestart(paths, journalMatch(committed), claimed))) {
				return { kind: "blocked" };
			}
			const handoff = await readAutoBotHandoff(
				paths,
				path.join(paths.handoffDir, `${committed.request.nonce}.candidate.json`),
			);
			if (
				!handoff ||
				handoff.role !== "candidate" ||
				handoff.owner.launchId !== committed.owner.launchId ||
				handoff.owner.bootstrapProcessId !== committed.owner.bootstrapProcessId ||
				handoff.owner.predecessorRuntimeProcessId !== committed.owner.predecessorRuntimeProcessId
			) {
				throw new Error("AutoBot committed candidate handoff is missing or foreign");
			}
			await resetAutoBotCandidateHandoffForRecovery(paths, handoff);
			return { kind: "claimed", committed: claimed };
		});
	} finally {
		previousLease.release();
	}
}

async function resumeCommittedCandidate(
	paths: AutoBotPaths,
	identity: AutoBotInstallationIdentity,
	claim: AutoBotHandoffClaim,
	committed: AutoBotCommittedRestart,
	terminationRequested: () => boolean,
): Promise<number> {
	const candidate = await readStagedRuntime(paths, committed.runtimePath);
	const child = startRuntime({
		paths,
		identity,
		claim,
		runtime: candidate,
		role: "candidate",
		cwd: committed.request.cwd,
		request: committed.request,
		argv: [],
	});
	const running: AutoBotCommittedRestart = {
		...committed,
		candidateRuntimeProcessId: child.pid,
		recoveryState: "candidate-running",
	};
	if (
		!(await withAutoBotHandoffLock(paths, () =>
			replaceAutoBotCommittedRestart(paths, journalMatch(committed), running),
		))
	) {
		// The PID was not durably recorded. Keep supervising this protected
		// child and leave `attempt-starting` non-adoptable rather than risking a
		// duplicate candidate from a later bootstrap. Even after child exit this
		// irreversible record remains fail-closed for explicit recovery.
		return child.exited;
	}
	const normalExit = () =>
		hasAutoBotNormalExitIntent({
			paths,
			request: running.request,
			role: "candidate",
			runtimePath: candidate.runtimePath,
			processId: child.pid,
		});
	const stopNormally = async (): Promise<number> => {
		const exitCode = await child.exited;
		await abandonCommittedRestart(paths, running, claim);
		return exitCode;
	};
	const finishExitedCandidate = async (): Promise<number> => child.exited;
	const ready = await waitForCandidateReady(paths, running.request, candidate.runtimePath, child);
	if (ready !== "ready") {
		if (ready === "normal-exit") return stopNormally();
		if (typeof ready === "object" && ready.exitCode === 0) return ready.exitCode;
		// This is irrevocably committed recovery. Never take normal
		// pre-activation fallback/quarantine paths after a replacement failure.
		return child.exited;
	}
	if (await normalExit()) return stopNormally();
	await withAutoBotHandoffLock(paths, async () => {
		const current = await readAutoBotCommittedRestart(paths);
		if (!current || !matchesAutoBotHandoffJournal(current, journalMatch(running))) {
			throw new Error("AutoBot recovered candidate committed owner changed before activation");
		}
		if (!(await hasAutoBotActivationAcknowledgement(paths, running.request))) {
			await writeAutoBotActivation(paths, running.request);
		}
	});
	const acknowledgement = await waitForCandidateActivationAcknowledgement(
		paths,
		running.request,
		candidate.runtimePath,
		child,
	);
	if (acknowledgement === "normal-exit") return stopNormally();
	if (acknowledgement !== "acknowledged") {
		if (acknowledgement !== "timed-out") return finishExitedCandidate();
		const lateAcknowledgement = await waitForLateCandidateActivationAcknowledgement(
			paths,
			running.request,
			candidate.runtimePath,
			child,
		);
		if (lateAcknowledgement === "normal-exit") return stopNormally();
		if (lateAcknowledgement !== "acknowledged") return finishExitedCandidate();
	}
	const handoff = await readCandidateHandoffForJournal(paths, running);
	if (!handoff) return finishExitedCandidate();
	const promotion = await waitForCandidatePromotion(paths, handoff, child);
	if (promotion === "normal-exit") return stopNormally();
	if (promotion !== "promoted") return finishExitedCandidate();
	const promoted = await writeActiveRuntime(paths, candidate);
	await clearCommittedRestartOwnership(paths, running, claim);
	return supervisePromotedRuntime(paths, identity, claim, promoted, candidate, child, terminationRequested);
}

export async function resolveFreshLaunchHandoff(
	paths: AutoBotPaths,
	claim: AutoBotHandoffClaim,
): Promise<CommittedRecovery> {
	const recovery = await claimOrphanedCommittedRestart(paths, claim);
	if (recovery.kind === "claimed" || recovery.kind === "normal-exit") return recovery;
	await withAutoBotHandoffLock(paths, async () => {
		// Parse the complete record even though it carries no authority for
		// this claim. Malformed local state remains fail-closed; a valid
		// foreign record remains byte-for-byte untouched.
		await readAutoBotPendingRestart(paths);
	});
	return recovery;
}

export interface AutoBotFreshLaunchPreparationDeps {
	readonly recover: (paths: AutoBotPaths) => Promise<void>;
	readonly refresh: (paths: AutoBotPaths) => Promise<AutoBotInstallationRefreshResult>;
	readonly readActive: (paths: AutoBotPaths) => Promise<AutoBotActivePointer | undefined>;
	readonly verifyActive: (paths: AutoBotPaths, active: AutoBotActivePointer) => Promise<void>;
	readonly writeDiagnostic: (paths: AutoBotPaths, event: AutoBotUpdateDiagnosticInput) => Promise<void>;
	readonly isChannelUnavailable: (error: unknown) => boolean;
}

async function verifyFreshLaunchActivePointer(paths: AutoBotPaths, active: AutoBotActivePointer): Promise<void> {
	if (active.manifest.minimumBootstrapVersion !== BOOTSTRAP_VERSION) {
		throw new Error("Preferred AutoBot runtime requires an unsupported bootstrap protocol");
	}
	const runtime = await readStagedRuntime(paths, active.runtimePath);
	if (
		runtime.slotId !== active.slotId ||
		runtime.runtimePath !== active.runtimePath ||
		runtime.runtimeSha256 !== active.runtimeSha256 ||
		serializeAutoBotReleaseManifest(runtime.manifest) !== serializeAutoBotReleaseManifest(active.manifest)
	) {
		throw new Error("Preferred AutoBot runtime does not match its active pointer");
	}
}

const freshLaunchPreparationDeps: AutoBotFreshLaunchPreparationDeps = {
	recover: recoverAutoBotInstallation,
	refresh: refreshAutoBotInstallation,
	readActive: readAutoBotActivePointer,
	verifyActive: verifyFreshLaunchActivePointer,
	writeDiagnostic: writeAutoBotUpdateDiagnostic,
	isChannelUnavailable: error => error instanceof AutoBotInstallationChannelUnavailableError,
};

async function recordFreshLaunchDiagnostic(
	paths: AutoBotPaths,
	deps: AutoBotFreshLaunchPreparationDeps,
	event: AutoBotUpdateDiagnosticInput,
): Promise<void> {
	try {
		await deps.writeDiagnostic(paths, event);
	} catch (error) {
		process.stderr.write("AutoBot update diagnostic could not be recorded.\n");
		throw error;
	}
}
async function recoverFreshLaunchPublication(
	paths: AutoBotPaths,
	launchId: string,
	deps: AutoBotFreshLaunchPreparationDeps,
): Promise<void> {
	try {
		await deps.recover(paths);
	} catch (error) {
		try {
			await recordFreshLaunchDiagnostic(paths, deps, {
				phase: "fresh-launch-refresh",
				outcome: "failed",
				reason: "publication-recovery-pending",
				launchId,
			});
		} catch {
			// recordFreshLaunchDiagnostic emitted a fixed, non-sensitive error.
		}
		throw error;
	}
}

/**
 * Recover installation publication before consulting the preferred pointer.
 * Transport unavailability may use the reverified installed slot. An exact
 * quarantined channel target may use a different reverified installed slot;
 * every signature, staging, or publication error remains fail-closed.
 */
export async function prepareAutoBotFreshLaunch(
	paths: AutoBotPaths,
	launchId: string,
	deps: AutoBotFreshLaunchPreparationDeps,
): Promise<AutoBotActivePointer> {
	await recoverFreshLaunchPublication(paths, launchId, deps);
	let refreshed: AutoBotInstallationRefreshResult;
	try {
		refreshed = await deps.refresh(paths);
	} catch (error) {
		const channelUnavailable = deps.isChannelUnavailable(error);
		const quarantined = error instanceof AutoBotInstallationQuarantinedError ? error : undefined;
		if (!channelUnavailable && !quarantined) throw error;
		await recoverFreshLaunchPublication(paths, launchId, deps);
		const installed = await deps.readActive(paths);
		if (!installed) throw new Error("AutoBot bootstrap has no verified installed runtime for safe fallback");
		if (
			quarantined &&
			installed.manifest.releaseSequence === quarantined.releaseSequence &&
			installed.manifest.forkCommit === quarantined.forkCommit
		) {
			throw error;
		}
		await deps.verifyActive(paths, installed);
		await recordFreshLaunchDiagnostic(paths, deps, {
			phase: "fresh-launch-refresh",
			outcome: "deferred",
			reason: quarantined ? "update-quarantined" : "offline-installed-fallback",
			releaseSequence: installed.manifest.releaseSequence,
			launchId,
		});
		return installed;
	}
	await deps.verifyActive(paths, refreshed.active);
	await recordFreshLaunchDiagnostic(paths, deps, {
		phase: "fresh-launch-refresh",
		outcome: refreshed.changed ? "completed" : "unchanged",
		reason: "refresh-completed",
		releaseSequence: refreshed.active.manifest.releaseSequence,
		launchId,
	});
	return refreshed.active;
}
export function isAutoBotReadOnlyUpdateStatusInvocation(argv: readonly string[]): boolean {
	let index = 0;
	while (index < argv.length) {
		const argument = argv[index];
		if (argument === "--profile") {
			const profile = argv[index + 1];
			if (!profile || profile.startsWith("-")) return false;
			index += 2;
			continue;
		}
		if (argument.startsWith("--profile=")) {
			if (argument.length === "--profile=".length) return false;
			index++;
			continue;
		}
		break;
	}
	return argv.length - index === 2 && argv[index] === "update" && argv[index + 1] === "--status";
}

export async function selectAutoBotLaunchActive(
	paths: AutoBotPaths,
	launchId: string,
	argv: readonly string[],
	deps: AutoBotFreshLaunchPreparationDeps,
): Promise<{ readonly active: AutoBotActivePointer; readonly readOnlyStatus: boolean }> {
	const readOnlyStatus = isAutoBotReadOnlyUpdateStatusInvocation(argv);
	if (!readOnlyStatus) {
		return { active: await prepareAutoBotFreshLaunch(paths, launchId, deps), readOnlyStatus };
	}
	const active = await deps.readActive(paths);
	if (!active) throw new Error("AutoBot bootstrap active runtime pointer is missing");
	await deps.verifyActive(paths, active);
	return { active, readOnlyStatus };
}

async function runBootstrap(): Promise<number> {
	const root = resolveAutoBotBootstrapRoot();
	const paths = autoBotPaths(root);
	if ((await assertAutoBotPrivateDirectory(paths.root)) !== paths.root) {
		throw new Error("AutoBot bootstrap managed root is not canonical");
	}
	const identity = readAutoBotInstallationIdentitySync(paths);
	if (!identity) throw new Error("AutoBot bootstrap installation identity is missing");
	const claim: AutoBotHandoffClaim = {
		launchId: randomBytes(32).toString("base64url"),
		bootstrapProcessId: process.pid,
	};
	const argv = process.argv.slice(2);
	const selection = await selectAutoBotLaunchActive(paths, claim.launchId, argv, freshLaunchPreparationDeps);
	const active = selection.active;
	// This fresh lease remains held through every child supervision path.
	const lifetimeLease = await acquireAutoBotFileLock(autoBotLaunchLeaseLockPath(paths, claim.launchId));

	let terminationRequested = false;
	const preserveChildTerminalOwnership = () => {
		terminationRequested = true;
	};
	process.on("SIGINT", preserveChildTerminalOwnership);
	process.on("SIGTERM", preserveChildTerminalOwnership);
	process.on("SIGHUP", preserveChildTerminalOwnership);
	try {
		const recovery: CommittedRecovery = selection.readOnlyStatus
			? { kind: "none" }
			: await resolveFreshLaunchHandoff(paths, claim);
		if (recovery.kind === "normal-exit") return 0;
		if (recovery.kind === "claimed") {
			// Await under this try: returning the promise directly would run the
			// finally block and release this bootstrap's lifetime lease early.
			return await resumeCommittedCandidate(paths, identity, claim, recovery.committed, () => terminationRequested);
		}

		// A live/uncertain committed owner or any pre-commit journal remains
		// untouched and unauthorizing. It must not block an independent new
		// session from launching the preferred runtime.

		const activeRuntime = await readStagedRuntime(paths, active.runtimePath);
		const child = startRuntime({
			paths,
			identity,
			claim,
			runtime: activeRuntime,
			role: "active",
			cwd: process.cwd(),
			argv,
		});
		// Await under this try so finally cannot release the lifetime lease while
		// the active child (and any nested handoff supervision) is still live.
		return await supervisePromotedRuntime(
			paths,
			identity,
			claim,
			active,
			activeRuntime,
			child,
			() => terminationRequested,
		);
	} finally {
		process.off("SIGINT", preserveChildTerminalOwnership);
		process.off("SIGTERM", preserveChildTerminalOwnership);
		process.off("SIGHUP", preserveChildTerminalOwnership);
		lifetimeLease.release();
	}
}

/** Stable launcher entrypoint. It never imports ordinary CLI configuration or dotenv. */
export async function runAutoBotBootstrap(): Promise<void> {
	if (process.argv.length === 3 && process.argv[2] === "--autobot-bootstrap-version") {
		process.stdout.write(`${BOOTSTRAP_VERSION}\n`);
		return;
	}
	try {
		process.exitCode = await runBootstrap();
	} catch {
		process.stderr.write("AutoBot bootstrap could not safely launch a managed runtime.\n");
		process.exitCode = 1;
	}
}
