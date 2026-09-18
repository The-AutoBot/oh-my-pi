import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import {
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
	parseAutoBotHandoffRecord,
	parseAutoBotRestartTarget,
	parseAutoBotRuntimeReady,
	sameAutoBotRestartTarget,
	type AutoBotHandoffRecord,
	type AutoBotPredecessorFallback,
	type AutoBotRestartCandidate,
	type AutoBotRestartRequest,
	type AutoBotRestartTarget,
	type AutoBotRuntimeReady,
} from "./contract";
import { readAuthenticatedAutoBotEnvironment } from "./identity";
import {
	matchesAutoBotHandoffJournal,
	readAutoBotCommittedRestart,
	readAutoBotCommittedRestartSync,
	readAutoBotPendingRestart,
	readAutoBotPendingRestartSync,
	withAutoBotHandoffLock,
} from "./state";
import { autoBotHandoffPath, autoBotPhasePath, autoBotSignalPath, pathIsInside, type AutoBotPaths } from "./paths";
import { readJsonIfPresent, removeFileIfPresent, writeJsonAtomically } from "./storage";
const HANDOFF_POLL_MS = 100;

export type AutoBotHandoffPhase =
	| "prepared"
	| "candidate-ready"
	| "activation-sent"
	| "activation-acknowledged"
	| "candidate-rejected";

export interface AutoBotHandoffPhaseRecord {
	readonly schemaVersion: 1;
	readonly nonce: string;
	readonly phase: AutoBotHandoffPhase;
	readonly updatedAt: string;
}

export interface AutoBotActivationSignal {
	readonly protocolVersion: typeof AUTO_BOT_HANDOFF_PROTOCOL_VERSION;
	readonly nonce: string;
	readonly releaseSequence: number;
	readonly sentAt: string;
}

export type AutoBotStartupHandoff =
	| { readonly role: "candidate"; readonly candidate: AutoBotRestartCandidate }
	| { readonly role: "fallback"; readonly fallback: AutoBotPredecessorFallback };

export interface AutoBotRuntimePromotion {
	readonly schemaVersion: 1;
	readonly protocolVersion: typeof AUTO_BOT_HANDOFF_PROTOCOL_VERSION;
	readonly nonce: string;
	readonly role: "candidate" | "fallback";
	readonly processId: number;
	readonly runtimePath: string;
	readonly target: AutoBotRestartTarget;
	readonly promotedAt: string;
}

export type AutoBotNormalExitRole = "candidate" | "fallback" | "predecessor";

/**
 * An exact handoff-bound request to stop rather than revive a protected
 * candidate, fallback, or sealed predecessor. The live bootstrap also binds
 * it to the child's PID before honoring it.
 */
export interface AutoBotNormalExitIntent {
	readonly schemaVersion: 1;
	readonly protocolVersion: typeof AUTO_BOT_HANDOFF_PROTOCOL_VERSION;
	readonly nonce: string;
	readonly role: AutoBotNormalExitRole;
	readonly processId: number;
	readonly runtimePath: string;
	readonly target: AutoBotRestartTarget;
	readonly requestedAt: string;
}

export interface AutoBotNormalExitExpectation {
	readonly paths: AutoBotPaths;
	readonly request: AutoBotRestartRequest;
	readonly role: AutoBotNormalExitRole;
	readonly runtimePath: string;
	/** Omit only while recovering a persisted intent after the original child has exited. */
	readonly processId?: number;
}

const PhaseSchema = type({
	schemaVersion: "1",
	nonce: "string > 0",
	phase: "string > 0",
	updatedAt: "string > 0",
});
const ActivationSchema = type({
	protocolVersion: "number.integer > 0",
	nonce: "string > 0",
	releaseSequence: "number.integer > 0",
	sentAt: "string > 0",
});
const AcknowledgementSchema = type({
	protocolVersion: "number.integer > 0",
	nonce: "string > 0",
	releaseSequence: "number.integer > 0",
	acknowledgedAt: "string > 0",
});
const RejectedSchema = type({
	protocolVersion: "number.integer > 0",
	nonce: "string > 0",
	rejectedAt: "string > 0",
});

const RestartExitSchema = type({
	protocolVersion: "number.integer > 0",
	nonce: "string > 0",
	releaseSequence: "number.integer > 0",
	committedAt: "string > 0",
});
const PromotionSchema = type({
	schemaVersion: "1",
	protocolVersion: "number.integer > 0",
	nonce: "string > 0",
	role: "string > 0",
	processId: "number.integer > 0",
	runtimePath: "string > 0",
	target: "unknown",
	promotedAt: "string > 0",
});
const NormalExitSchema = type({
	schemaVersion: "1",
	protocolVersion: "number.integer > 0",
	nonce: "string > 0",
	role: "string > 0",
	processId: "number.integer > 0",
	runtimePath: "string > 0",
	target: "unknown",
	requestedAt: "string > 0",
});

function canonicalTimestamp(value: string, label: string): string {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) {
		throw new Error(`${label} must be a canonical UTC timestamp`);
	}
	return value;
}

function parsePhase(value: unknown, nonce: string): AutoBotHandoffPhaseRecord {
	const phase = PhaseSchema.assert(value);
	if (
		phase.schemaVersion !== 1 ||
		phase.nonce !== nonce ||
		(phase.phase !== "prepared" &&
			phase.phase !== "candidate-ready" &&
			phase.phase !== "activation-sent" &&
			phase.phase !== "activation-acknowledged" &&
			phase.phase !== "candidate-rejected")
	) {
		throw new Error("AutoBot handoff phase is invalid");
	}
	return { schemaVersion: 1, nonce, phase: phase.phase, updatedAt: canonicalTimestamp(phase.updatedAt, "AutoBot handoff phase") };
}

function parseActivation(value: unknown, request: AutoBotRestartRequest): AutoBotActivationSignal {
	const activation = ActivationSchema.assert(value);
	if (
		activation.protocolVersion !== AUTO_BOT_HANDOFF_PROTOCOL_VERSION ||
		activation.nonce !== request.nonce ||
		activation.releaseSequence !== request.target.releaseSequence
	) {
		throw new Error("AutoBot activation signal does not match its handoff");
	}
	return {
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		nonce: request.nonce,
		releaseSequence: request.target.releaseSequence,
		sentAt: canonicalTimestamp(activation.sentAt, "AutoBot activation signal"),
	};
}

function parseRejected(value: unknown, request: AutoBotRestartRequest): void {
	const rejected = RejectedSchema.assert(value);
	if (rejected.protocolVersion !== AUTO_BOT_HANDOFF_PROTOCOL_VERSION || rejected.nonce !== request.nonce) {
		throw new Error("AutoBot rejection signal does not match its handoff");
	}
	canonicalTimestamp(rejected.rejectedAt, "AutoBot rejection signal");
}

function validateHandoffPaths(paths: AutoBotPaths, handoff: AutoBotHandoffRecord): AutoBotHandoffRecord {
	const runtimePath = path.resolve(handoff.runtimePath);
	const previousRuntimePath = path.resolve(handoff.previousRuntimePath);
	if (!pathIsInside(paths.runtimeDir, runtimePath) || !pathIsInside(paths.runtimeDir, previousRuntimePath)) {
		throw new Error("AutoBot handoff references an unmanaged runtime");
	}
	if (!path.isAbsolute(handoff.sessionFile) || !path.isAbsolute(handoff.cwd)) {
		throw new Error("AutoBot handoff contains a non-absolute session path");
	}
	return { ...handoff, runtimePath, previousRuntimePath };
}

export function readAutoBotHandoffSync(paths: AutoBotPaths, handoffPath: string): AutoBotHandoffRecord | undefined {
	try {
		const handoff = parseAutoBotHandoffRecord(JSON.parse(fs.readFileSync(handoffPath, "utf8")));
		return validateHandoffPaths(paths, handoff);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export async function readAutoBotHandoff(paths: AutoBotPaths, handoffPath: string): Promise<AutoBotHandoffRecord | undefined> {
	const raw = await readJsonIfPresent(handoffPath);
	return raw === undefined ? undefined : validateHandoffPaths(paths, parseAutoBotHandoffRecord(raw));
}

type AuthenticatedStartupEnvironment = NonNullable<ReturnType<typeof readAuthenticatedAutoBotEnvironment>> & {
	readonly role: "candidate" | "fallback";
	readonly handoffFile: string;
	readonly handoffNonce: string;
};

function isAuthenticatedStartupEnvironment(
	environment: ReturnType<typeof readAuthenticatedAutoBotEnvironment>,
): environment is AuthenticatedStartupEnvironment {
	return (
		environment !== undefined &&
		(environment.role === "candidate" || environment.role === "fallback") &&
		typeof environment.handoffFile === "string" &&
		environment.handoffFile.length > 0 &&
		typeof environment.handoffNonce === "string" &&
		environment.handoffNonce.length > 0
	);
}

type AutoBotHandoffJournalRecord = {
	readonly owner: AutoBotHandoffRecord["owner"];
	readonly claim: { readonly launchId: string; readonly bootstrapProcessId: number };
	readonly request: AutoBotRestartRequest;
	readonly runtimePath: string;
	readonly previousRuntimePath: string;
};

function sameAutoBotRestartRequest(left: AutoBotRestartRequest, right: AutoBotRestartRequest): boolean {
	return (
		left.sessionFile === right.sessionFile &&
		left.sessionId === right.sessionId &&
		left.cwd === right.cwd &&
		left.profile === right.profile &&
		left.expiresAt === right.expiresAt &&
		left.leaseDurationMs === right.leaseDurationMs &&
		left.fallbackInstanceId === right.fallbackInstanceId &&
		left.nonce === right.nonce &&
		JSON.stringify(left.context) === JSON.stringify(right.context) &&
		sameAutoBotRestartTarget(left.target, right.target) &&
		sameAutoBotRestartTarget(left.predecessorTarget, right.predecessorTarget)
	);
}

function journalBindsStartupHandoff(
	record: AutoBotHandoffJournalRecord,
	environment: AuthenticatedStartupEnvironment,
	handoff: AutoBotHandoffRecord,
): boolean {
	return (
		record.owner.launchId === handoff.owner.launchId &&
		record.owner.bootstrapProcessId === handoff.owner.bootstrapProcessId &&
		record.owner.predecessorRuntimeProcessId === handoff.owner.predecessorRuntimeProcessId &&
		record.claim.launchId === environment.launchId &&
		record.claim.bootstrapProcessId === environment.bootstrapProcessId &&
		sameAutoBotRestartRequest(record.request, handoff) &&
		path.resolve(record.runtimePath) === handoff.runtimePath &&
		path.resolve(record.previousRuntimePath) === handoff.previousRuntimePath
	);
}

function handoffMatchesCurrentBootstrap(
	environment: AuthenticatedStartupEnvironment,
	handoff: AutoBotHandoffRecord,
): boolean {
	if (
		handoff.owner.launchId === environment.launchId &&
		handoff.owner.bootstrapProcessId === environment.bootstrapProcessId
	) {
		return true;
	}
	if (environment.role !== "candidate") return false;
	try {
		const pending = readAutoBotPendingRestartSync(environment.paths);
		const committed = readAutoBotCommittedRestartSync(environment.paths);
		return (
			(pending !== undefined && journalBindsStartupHandoff(pending, environment, handoff)) ||
			(committed !== undefined && journalBindsStartupHandoff(committed, environment, handoff))
		);
	} catch {
		return false;
	}
}

async function handoffMatchesCurrentBootstrapAsync(
	environment: AuthenticatedStartupEnvironment,
	handoff: AutoBotHandoffRecord,
): Promise<boolean> {
	if (
		handoff.owner.launchId === environment.launchId &&
		handoff.owner.bootstrapProcessId === environment.bootstrapProcessId
	) {
		return true;
	}
	if (environment.role !== "candidate") return false;
	try {
		const [pending, committed] = await Promise.all([
			readAutoBotPendingRestart(environment.paths),
			readAutoBotCommittedRestart(environment.paths),
		]);
		if (
			(pending !== undefined && journalBindsStartupHandoff(pending, environment, handoff)) ||
			(committed !== undefined && journalBindsStartupHandoff(committed, environment, handoff))
		) {
			return true;
		}
		// A recovered candidate's sealed owner remains intentionally old after
		// journals clear on promotion. Its nonce/PID-bound promotion record is
		// the remaining proof for this authenticated direct child.
		const promoted = await readJsonIfPresent(autoBotSignalPath(environment.paths, handoff.nonce, "promoted"));
		if (promoted === undefined) return false;
		parseRuntimePromotion(promoted, {
			paths: environment.paths,
			handoff,
			role: "candidate",
			runtimePath: environment.runtimePath,
			processId: process.pid,
		});
		return true;
	} catch {
		return false;
	}
}

async function authenticatedStartupHandoff(): Promise<{
	readonly environment: AuthenticatedStartupEnvironment;
	readonly handoff: AutoBotHandoffRecord;
}> {
	const environment = readAuthenticatedAutoBotEnvironment();
	if (!isAuthenticatedStartupEnvironment(environment)) {
		throw new Error("AutoBot promotion requires an authenticated candidate or fallback launch");
	}
	const expectedPath = autoBotHandoffPath(environment.paths, environment.handoffNonce, environment.role);
	const handoff = await readAutoBotHandoff(environment.paths, expectedPath);
	if (path.resolve(environment.handoffFile) !== expectedPath) {
		throw new Error("AutoBot promotion handoff path does not match its authenticated launch");
	}
	if (
		!handoff ||
		handoff.role !== environment.role ||
		handoff.nonce !== environment.handoffNonce ||
		path.resolve(handoff.runtimePath) !== environment.runtimePath
	) {
		throw new Error("AutoBot promotion handoff does not match its authenticated launch");
	}
	if (!(await handoffMatchesCurrentBootstrapAsync(environment, handoff))) {
		throw new Error("AutoBot promotion handoff does not match its current bootstrap claim");
	}
	return { environment, handoff };
}

export interface AutoBotRuntimePromotionExpectation {
	readonly paths: AutoBotPaths;
	readonly handoff: AutoBotHandoffRecord;
	readonly role: "candidate" | "fallback";
	readonly runtimePath: string;
	readonly processId: number;
}

function parseRuntimePromotion(
	value: unknown,
	expected: AutoBotRuntimePromotionExpectation,
): AutoBotRuntimePromotion {
	const promotion = PromotionSchema.assert(value);
	const target = parseAutoBotRestartTarget(promotion.target);
	if (
		promotion.schemaVersion !== 1 ||
		promotion.protocolVersion !== AUTO_BOT_HANDOFF_PROTOCOL_VERSION ||
		promotion.nonce !== expected.handoff.nonce ||
		promotion.role !== expected.role ||
		promotion.processId !== expected.processId ||
		path.resolve(promotion.runtimePath) !== path.resolve(expected.runtimePath) ||
		!sameAutoBotRestartTarget(target, expected.handoff.target)
	) {
		throw new Error("AutoBot promotion does not match this authenticated launch");
	}
	return {
		schemaVersion: 1,
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		nonce: expected.handoff.nonce,
		role: expected.role,
		processId: expected.processId,
		runtimePath: path.resolve(expected.runtimePath),
		target,
		promotedAt: canonicalTimestamp(promotion.promotedAt, "AutoBot promotion"),
	};
}

function normalExitTarget(expected: AutoBotNormalExitExpectation): AutoBotRestartTarget {
	return expected.role === "predecessor" ? expected.request.predecessorTarget : expected.request.target;
}

function parseNormalExit(value: unknown, expected: AutoBotNormalExitExpectation): AutoBotNormalExitIntent {
	const normalExit = NormalExitSchema.assert(value);
	const target = parseAutoBotRestartTarget(normalExit.target);
	if (
		normalExit.schemaVersion !== 1 ||
		normalExit.protocolVersion !== AUTO_BOT_HANDOFF_PROTOCOL_VERSION ||
		normalExit.nonce !== expected.request.nonce ||
		(normalExit.role !== "candidate" && normalExit.role !== "fallback" && normalExit.role !== "predecessor") ||
		normalExit.role !== expected.role ||
		(normalExit.processId !== expected.processId && expected.processId !== undefined) ||
		path.resolve(normalExit.runtimePath) !== path.resolve(expected.runtimePath) ||
		!sameAutoBotRestartTarget(target, normalExitTarget(expected))
	) {
		throw new Error("AutoBot normal exit intent does not match its authenticated handoff");
	}
	return {
		schemaVersion: 1,
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		nonce: expected.request.nonce,
		role: expected.role,
		processId: normalExit.processId,
		runtimePath: path.resolve(expected.runtimePath),
		target,
		requestedAt: canonicalTimestamp(normalExit.requestedAt, "AutoBot normal exit intent"),
	};
}

async function writeAutoBotNormalExitIntent(
	paths: AutoBotPaths,
	request: AutoBotRestartRequest,
	role: AutoBotNormalExitRole,
	runtimePath: string,
	target: AutoBotRestartTarget,
): Promise<void> {
	await writeJsonAtomically(autoBotSignalPath(paths, request.nonce, "normal-exit"), {
		schemaVersion: 1,
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		nonce: request.nonce,
		role,
		processId: process.pid,
		runtimePath: path.resolve(runtimePath),
		target,
		requestedAt: new Date().toISOString(),
	} satisfies AutoBotNormalExitIntent);
}

/** Fail closed unless the intent is bound to this exact handoff/runtime/PID. */
export async function hasAutoBotNormalExitIntent(expected: AutoBotNormalExitExpectation): Promise<boolean> {
	try {
		const raw = await readJsonIfPresent(autoBotSignalPath(expected.paths, expected.request.nonce, "normal-exit"));
		if (raw === undefined) return false;
		parseNormalExit(raw, expected);
		return true;
	} catch {
		return false;
	}
}

/**
 * Persist a user-requested normal exit before protected shutdown. Returns
 * false only for an unmanaged launch. An authenticated active runtime with no
 * sealed handoff is already safe to exit and succeeds as a no-op; a matching
 * pending handoff receives a nonce/PID/runtime-bound intent.
 */
export async function requestAutoBotNormalExit(): Promise<boolean> {
	const environment = readAuthenticatedAutoBotEnvironment();
	if (!environment) return false;
	const wrotePredecessorIntent = await withAutoBotHandoffLock(environment.paths, async () => {
		const pending = await readAutoBotPendingRestart(environment.paths);
		if (
			!pending ||
			!matchesAutoBotHandoffJournal(pending, {
				owner: {
					launchId: environment.launchId,
					bootstrapProcessId: environment.bootstrapProcessId,
					predecessorRuntimeProcessId: process.pid,
				},
				claim: {
					launchId: environment.launchId,
					bootstrapProcessId: environment.bootstrapProcessId,
				},
				request: pending.request,
				runtimePath: pending.runtimePath,
				previousRuntimePath: environment.runtimePath,
			}) ||
			(environment.role !== "active" && !(await hasAutoBotStartupHandoffPromotion()))
		) {
			return false;
		}
		await writeAutoBotNormalExitIntent(
			environment.paths,
			pending.request,
			"predecessor",
			environment.runtimePath,
			pending.request.predecessorTarget,
		);
		return true;
	});
	if (wrotePredecessorIntent || environment.role === "active") return true;
	const startup = await authenticatedStartupHandoff();
	return withAutoBotHandoffLock(startup.environment.paths, async () => {
		// `authenticatedStartupHandoff` bound this nonce and owner to this
		// bootstrap-authenticated child; do not let a global journal select it.
		await writeAutoBotNormalExitIntent(
			startup.environment.paths,
			startup.handoff,
			startup.environment.role,
			startup.environment.runtimePath,
			startup.handoff.target,
		);
		return true;
	});
}

/**
 * Record a promotion only after the caller has completed its authenticated
 * activation/restore boundary. The nonce, PID, runtime path, and full target
 * make a stale record from any other launch unusable.
 */
export async function promoteAutoBotStartupHandoff(): Promise<void> {
	const input = await authenticatedStartupHandoff();
	if (
		input.environment.role === "candidate" &&
		!(await hasAutoBotActivationAcknowledgement(input.environment.paths, input.handoff))
	) {
		throw new Error("AutoBot candidate cannot promote before activation acknowledgement");
	}
	const promotion: AutoBotRuntimePromotion = {
		schemaVersion: 1,
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		nonce: input.handoff.nonce,
		role: input.environment.role,
		processId: process.pid,
		runtimePath: input.environment.runtimePath,
		target: input.handoff.target,
		promotedAt: new Date().toISOString(),
	};
	await withAutoBotHandoffLock(input.environment.paths, async () => {
		const current = await readAutoBotHandoff(
			input.environment.paths,
			autoBotHandoffPath(input.environment.paths, input.handoff.nonce, input.environment.role),
		);
		if (!current || JSON.stringify(current) !== JSON.stringify(input.handoff)) {
			throw new Error("AutoBot promotion handoff no longer matches its sealed record");
		}
		await writeJsonAtomically(autoBotSignalPath(input.environment.paths, input.handoff.nonce, "promoted"), promotion);
	});
}

/** Fail closed unless the supplied process recorded promotion for this exact handoff. */
export async function hasAutoBotRuntimePromotion(expected: AutoBotRuntimePromotionExpectation): Promise<boolean> {
	try {
		const raw = await readJsonIfPresent(autoBotSignalPath(expected.paths, expected.handoff.nonce, "promoted"));
		if (raw === undefined) return false;
		parseRuntimePromotion(raw, expected);
		return expected.role !== "candidate" || (await hasAutoBotActivationAcknowledgement(expected.paths, expected.handoff));
	} catch {
		return false;
	}
}

/** Fail closed unless this exact candidate/fallback process recorded promotion. */
export async function hasAutoBotStartupHandoffPromotion(): Promise<boolean> {
	const input = await authenticatedStartupHandoff().catch(() => undefined);
	if (!input) return false;
	return hasAutoBotRuntimePromotion({
		paths: input.environment.paths,
		handoff: input.handoff,
		role: input.environment.role,
		runtimePath: input.environment.runtimePath,
		processId: process.pid,
	});
}

export async function createAutoBotHandoff(paths: AutoBotPaths, handoff: AutoBotHandoffRecord): Promise<string> {
	const checked = validateHandoffPaths(paths, parseAutoBotHandoffRecord(handoff));
	const handoffPath = autoBotHandoffPath(paths, checked.nonce, checked.role);
	await writeJsonAtomically(handoffPath, checked);
	await writeAutoBotHandoffPhase(paths, checked.nonce, "prepared");
	return handoffPath;
}

/**
 * Remove a pre-activation handoff only when the on-disk sealed owner/nonce
 * still matches. Caller holds handoffLock for journal-related transitions.
 */
export async function discardAutoBotHandoff(paths: AutoBotPaths, expected: AutoBotHandoffRecord): Promise<void> {
	const checked = validateHandoffPaths(paths, parseAutoBotHandoffRecord(expected));
	const current = await readAutoBotHandoff(paths, autoBotHandoffPath(paths, checked.nonce, checked.role));
	if (!current || JSON.stringify(current) !== JSON.stringify(checked)) return;
	await Promise.all([
		removeFileIfPresent(autoBotHandoffPath(paths, checked.nonce, checked.role)),
		removeFileIfPresent(autoBotPhasePath(paths, checked.nonce)),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "candidate-ready")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "activate")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "activation-ack")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "promoted")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "rejected")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "normal-exit")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "restart-exit")),
	]);
}

/**
 * Reset only per-attempt candidate signals after an exact committed-orphan
 * claim. The sealed handoff and committed journal remain irreversible; the
 * recovery claim stays non-adoptable until its caller durably records the new
 * candidate PID. Caller MUST hold handoffLock.
 */
export async function resetAutoBotCandidateHandoffForRecovery(
	paths: AutoBotPaths,
	expected: AutoBotHandoffRecord,
): Promise<void> {
	const checked = validateHandoffPaths(paths, parseAutoBotHandoffRecord(expected));
	if (checked.role !== "candidate") throw new Error("Only a candidate handoff can be reset for recovery");
	const current = await readAutoBotHandoff(paths, autoBotHandoffPath(paths, checked.nonce, "candidate"));
	if (!current || JSON.stringify(current) !== JSON.stringify(checked)) {
		throw new Error("AutoBot candidate handoff no longer matches its committed record");
	}
	await Promise.all([
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "candidate-ready")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "activate")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "activation-ack")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "promoted")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "rejected")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "normal-exit")),
		removeFileIfPresent(autoBotSignalPath(paths, checked.nonce, "restart-exit")),
	]);
	await writeAutoBotHandoffPhase(paths, checked.nonce, "prepared");
}

export async function readAutoBotHandoffPhase(
	paths: AutoBotPaths,
	nonce: string,
): Promise<AutoBotHandoffPhaseRecord | undefined> {
	const raw = await readJsonIfPresent(autoBotPhasePath(paths, nonce));
	return raw === undefined ? undefined : parsePhase(raw, nonce);
}

export async function writeAutoBotHandoffPhase(paths: AutoBotPaths, nonce: string, phase: AutoBotHandoffPhase): Promise<void> {
	await writeJsonAtomically(autoBotPhasePath(paths, nonce), {
		schemaVersion: 1,
		nonce,
		phase,
		updatedAt: new Date().toISOString(),
	} satisfies AutoBotHandoffPhaseRecord);
}

export async function writeAutoBotCandidateReady(paths: AutoBotPaths, ready: AutoBotRuntimeReady): Promise<void> {
	const checked = parseAutoBotRuntimeReady(ready);
	await writeJsonAtomically(autoBotSignalPath(paths, checked.nonce, "candidate-ready"), checked);
}

export async function readAutoBotCandidateReady(
	paths: AutoBotPaths,
	request: AutoBotRestartRequest,
): Promise<AutoBotRuntimeReady | undefined> {
	const raw = await readJsonIfPresent(autoBotSignalPath(paths, request.nonce, "candidate-ready"));
	if (raw === undefined) return undefined;
	const ready = parseAutoBotRuntimeReady(raw);
	if (
		ready.nonce !== request.nonce ||
		ready.releaseSequence !== request.target.releaseSequence ||
		ready.compatibilityEpoch !== request.target.compatibilityEpoch ||
		ready.sessionFile !== request.sessionFile ||
		ready.sessionId !== request.sessionId
	) {
		throw new Error("AutoBot candidate readiness does not match its handoff");
	}
	return ready;
}

export async function writeAutoBotActivation(paths: AutoBotPaths, request: AutoBotRestartRequest): Promise<void> {
	await writeAutoBotHandoffPhase(paths, request.nonce, "activation-sent");
	await writeJsonAtomically(autoBotSignalPath(paths, request.nonce, "activate"), {
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		nonce: request.nonce,
		releaseSequence: request.target.releaseSequence,
		sentAt: new Date().toISOString(),
	} satisfies AutoBotActivationSignal);
}

export async function readAutoBotActivation(
	paths: AutoBotPaths,
	request: AutoBotRestartRequest,
): Promise<AutoBotActivationSignal | undefined> {
	const raw = await readJsonIfPresent(autoBotSignalPath(paths, request.nonce, "activate"));
	return raw === undefined ? undefined : parseActivation(raw, request);
}

export async function writeAutoBotActivationAcknowledgement(paths: AutoBotPaths, request: AutoBotRestartRequest): Promise<void> {
	await writeAutoBotHandoffPhase(paths, request.nonce, "activation-acknowledged");
	await writeJsonAtomically(autoBotSignalPath(paths, request.nonce, "activation-ack"), {
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		nonce: request.nonce,
		releaseSequence: request.target.releaseSequence,
		acknowledgedAt: new Date().toISOString(),
	});
}

export async function hasAutoBotActivationAcknowledgement(paths: AutoBotPaths, request: AutoBotRestartRequest): Promise<boolean> {
	const raw = await readJsonIfPresent(autoBotSignalPath(paths, request.nonce, "activation-ack"));
	if (raw === undefined) return false;
	const acknowledgement = AcknowledgementSchema.assert(raw);
	if (
		acknowledgement.protocolVersion !== AUTO_BOT_HANDOFF_PROTOCOL_VERSION ||
		acknowledgement.nonce !== request.nonce ||
		acknowledgement.releaseSequence !== request.target.releaseSequence
	) {
		throw new Error("AutoBot activation acknowledgement does not match its handoff");
	}
	canonicalTimestamp(acknowledgement.acknowledgedAt, "AutoBot activation acknowledgement");
	return true;
}

export async function writeAutoBotCandidateRejection(paths: AutoBotPaths, request: AutoBotRestartRequest): Promise<void> {
	const phase = await readAutoBotHandoffPhase(paths, request.nonce);
	if (!phase) throw new Error("AutoBot handoff phase is missing");
	if (phase.phase !== "activation-sent" && phase.phase !== "activation-acknowledged") {
		await writeAutoBotHandoffPhase(paths, request.nonce, "candidate-rejected");
	}
	await writeJsonAtomically(autoBotSignalPath(paths, request.nonce, "rejected"), {
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		nonce: request.nonce,
		rejectedAt: new Date().toISOString(),
	});
}

export async function hasAutoBotCandidateRejection(paths: AutoBotPaths, request: AutoBotRestartRequest): Promise<boolean> {
	const raw = await readJsonIfPresent(autoBotSignalPath(paths, request.nonce, "rejected"));
	if (raw === undefined) return false;
	parseRejected(raw, request);
	return true;
}

/**
 * Authenticates the predecessor's one-shot restart intent immediately before
 * its dedicated bootstrap restart exit. The bootstrap never treats a pending
 * record alone as authorization to respawn.
 */
export async function authorizeAutoBotRestartExit(request: AutoBotRestartRequest): Promise<void> {
	const environment = readAuthenticatedAutoBotEnvironment();
	if (
		!environment ||
		(environment.role !== "active" && !(await hasAutoBotStartupHandoffPromotion()))
	) {
		throw new Error("Only an authenticated active or promoted AutoBot runtime can authorize a restart exit");
	}
	await withAutoBotHandoffLock(environment.paths, async () => {
		const pending = await readAutoBotPendingRestart(environment.paths);
		if (
			!pending ||
			!matchesAutoBotHandoffJournal(pending, {
				owner: {
					launchId: environment.launchId,
					bootstrapProcessId: environment.bootstrapProcessId,
					predecessorRuntimeProcessId: process.pid,
				},
				claim: {
					launchId: environment.launchId,
					bootstrapProcessId: environment.bootstrapProcessId,
				},
				request,
				runtimePath: pending.runtimePath,
				previousRuntimePath: environment.runtimePath,
			})
		) {
			throw new Error("AutoBot restart exit does not own this pending handoff");
		}
		await writeJsonAtomically(autoBotSignalPath(environment.paths, request.nonce, "restart-exit"), {
			protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
			nonce: request.nonce,
			releaseSequence: request.target.releaseSequence,
			committedAt: new Date().toISOString(),
		});
	});
}

export async function hasAutoBotRestartExitAuthorization(
	paths: AutoBotPaths,
	request: AutoBotRestartRequest,
): Promise<boolean> {
	const raw = await readJsonIfPresent(autoBotSignalPath(paths, request.nonce, "restart-exit"));
	if (raw === undefined) return false;
	const authorization = RestartExitSchema.assert(raw);
	if (
		authorization.protocolVersion !== AUTO_BOT_HANDOFF_PROTOCOL_VERSION ||
		authorization.nonce !== request.nonce ||
		authorization.releaseSequence !== request.target.releaseSequence
	) {
		throw new Error("AutoBot restart exit authorization does not match its handoff");
	}
	canonicalTimestamp(authorization.committedAt, "AutoBot restart exit authorization");
	return true;
}

async function waitForActivation(paths: AutoBotPaths, request: AutoBotRestartRequest): Promise<void> {
	while (true) {
		if (await readAutoBotActivation(paths, request)) return;
		if (await hasAutoBotCandidateRejection(paths, request)) throw new Error("AutoBot candidate handoff was rejected");
		await Bun.sleep(HANDOFF_POLL_MS);
	}
}

class CandidateHandoff implements AutoBotRestartCandidate {
	readonly request: AutoBotRestartRequest;
	readonly #paths: AutoBotPaths;
	readonly #handoff: AutoBotHandoffRecord;
	#activationObserved = false;
	#ready = false;

	constructor(paths: AutoBotPaths, handoff: AutoBotHandoffRecord) {
		this.#paths = paths;
		this.#handoff = handoff;
		this.request = handoff;
	}

	async #withOwnedHandoff<T>(fn: () => Promise<T>): Promise<T> {
		return withAutoBotHandoffLock(this.#paths, async () => {
			const current = await readAutoBotHandoff(
				this.#paths,
				autoBotHandoffPath(this.#paths, this.#handoff.nonce, "candidate"),
			);
			if (!current || JSON.stringify(current) !== JSON.stringify(this.#handoff)) {
				throw new Error("AutoBot candidate handoff no longer matches its sealed record");
			}
			return fn();
		});
	}

	async signalReady(): Promise<void> {
		await this.#withOwnedHandoff(async () => {
			const phase = await readAutoBotHandoffPhase(this.#paths, this.request.nonce);
			if (!phase) throw new Error("AutoBot handoff phase is missing");
			if (phase.phase === "candidate-rejected") throw new Error("AutoBot candidate handoff was rejected");
			if (phase.phase === "prepared") await writeAutoBotHandoffPhase(this.#paths, this.request.nonce, "candidate-ready");
			if (phase.phase === "prepared" || phase.phase === "candidate-ready") {
				await writeAutoBotCandidateReady(this.#paths, {
					protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
					nonce: this.request.nonce,
					releaseSequence: this.request.target.releaseSequence,
					compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
					sessionFile: this.request.sessionFile,
					sessionId: this.request.sessionId,
				});
			}
		});
		this.#ready = true;
	}

	async waitForActivation(): Promise<void> {
		if (!this.#ready) throw new Error("AutoBot candidate must signal readiness before waiting for activation");
		await waitForActivation(this.#paths, this.request);
		this.#activationObserved = true;
	}

	async acknowledgeActivation(): Promise<void> {
		if (!this.#activationObserved) throw new Error("AutoBot candidate may not acknowledge activation before receiving it");
		await this.#withOwnedHandoff(() => writeAutoBotActivationAcknowledgement(this.#paths, this.request));
	}

	async reject(reason: string): Promise<void> {
		void reason;
		await this.#withOwnedHandoff(() => writeAutoBotCandidateRejection(this.#paths, this.request));
	}
}

/**
 * Synchronous, bootstrap-authenticated handoff discovery for runtime startup.
 * The caller may use it before parsing normal CLI/session options; it never
 * treats a raw OMP_AUTOBOT_* value as authority.
 */
export function getAutoBotStartupHandoff(): AutoBotStartupHandoff | undefined {
	const environment = readAuthenticatedAutoBotEnvironment();
	if (!isAuthenticatedStartupEnvironment(environment)) return undefined;
	const expectedPath = autoBotHandoffPath(environment.paths, environment.handoffNonce, environment.role);
	if (path.resolve(environment.handoffFile) !== expectedPath) return undefined;
	let handoff: AutoBotHandoffRecord | undefined;
	try {
		handoff = readAutoBotHandoffSync(environment.paths, expectedPath);
	} catch {
		return undefined;
	}
	if (
		!handoff ||
		handoff.role !== environment.role ||
		handoff.nonce !== environment.handoffNonce ||
		path.resolve(handoff.runtimePath) !== environment.runtimePath ||
		!handoffMatchesCurrentBootstrap(environment, handoff)
	) {
		return undefined;
	}
	if (environment.role === "fallback") {
		if (!handoff.attemptedTarget) return undefined;
		return { role: "fallback", fallback: { request: handoff, attemptedTarget: handoff.attemptedTarget } };
	}
	return { role: "candidate", candidate: new CandidateHandoff(environment.paths, handoff) };
}
