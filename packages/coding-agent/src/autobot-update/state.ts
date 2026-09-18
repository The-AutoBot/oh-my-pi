import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { withAutoBotFileLock } from "./lock";
import {
	parseAutoBotHandoffClaim,
	parseAutoBotHandoffOwner,
	parseAutoBotReleaseManifest,
	parseAutoBotRestartRequest,
	type AutoBotHandoffClaim,
	type AutoBotHandoffOwner,
	type AutoBotReleaseManifest,
	type AutoBotRestartRequest,
	type AutoBotRestartTarget,
} from "./contract";
import { pathIsInside, type AutoBotPaths } from "./paths";
import { ensurePrivateDirectory, readJsonIfPresent, removeFileIfPresent, writeJsonAtomically } from "./storage";

export interface AutoBotActivePointer {
	readonly schemaVersion: 1;
	readonly slotId: string;
	readonly runtimePath: string;
	readonly runtimeSha256: string;
	readonly manifest: AutoBotReleaseManifest;
	readonly activatedAt: string;
}

export interface AutoBotSequenceHighWater {
	readonly schemaVersion: 1;
	readonly releaseSequence: number;
	/** SHA-256 of the exact signed payload, preventing equal-sequence equivocation. */
	readonly payloadSha256: string;
	readonly forkCommit: string;
	readonly acceptedAt: string;
}

export interface AutoBotPendingRestart {
	readonly schemaVersion: 1;
	readonly request: AutoBotRestartRequest;
	readonly handoffPath: string;
	readonly runtimePath: string;
	readonly previousRuntimePath: string;
	readonly createdAt: string;
	/** Immutable sealed origin; it never changes during orphan recovery. */
	readonly owner: AutoBotHandoffOwner;
	/** Current bootstrap claimant for this globally singleton journal. */
	readonly claim: AutoBotHandoffClaim;
}

/** Durable irreversible boundary written before bootstrap sends candidate activation. */
export interface AutoBotCommittedRestart {
	readonly schemaVersion: 1;
	readonly request: AutoBotRestartRequest;
	readonly runtimePath: string;
	readonly previousRuntimePath: string;
	readonly committedAt: string;
	/** Immutable sealed origin; it never changes during orphan recovery. */
	readonly owner: AutoBotHandoffOwner;
	/** Current bootstrap claimant for this globally singleton journal. */
	readonly claim: AutoBotHandoffClaim;
	/** Exact child PID eligible for conservative orphan liveness checks. */
	readonly candidateRuntimeProcessId: number;
	/**
	 * `attempt-starting` is deliberately non-adoptable: a bootstrap may have
	 * spawned a child before it could durably record that child's PID.
	 */
	readonly recoveryState: "candidate-running" | "attempt-starting";
}

export interface AutoBotQuarantinedRelease {
	readonly schemaVersion: 1;
	readonly releaseSequence: number;
	readonly forkCommit: string;
	readonly rejectedAt: string;
}

const ActivePointerSchema = type({
	schemaVersion: "1",
	slotId: "string > 0",
	runtimePath: "string > 0",
	runtimeSha256: "string > 0",
	manifest: "unknown",
	activatedAt: "string > 0",
});
const HighWaterSchema = type({
	schemaVersion: "1",
	releaseSequence: "number.integer > 0",
	payloadSha256: "string > 0",
	forkCommit: "string > 0",
	acceptedAt: "string > 0",
});
const PendingRestartSchema = type({
	schemaVersion: "1",
	request: "unknown",
	handoffPath: "string > 0",
	runtimePath: "string > 0",
	previousRuntimePath: "string > 0",
	createdAt: "string > 0",
	owner: "unknown",
	claim: "unknown",
});

/** Stable authority envelope for identifying a foreign pending journal. */
const PendingRestartOwnershipSchema = type({
	owner: "unknown",
	claim: "unknown",
});
const CommittedRestartSchema = type({
	schemaVersion: "1",
	request: "unknown",
	runtimePath: "string > 0",
	previousRuntimePath: "string > 0",
	committedAt: "string > 0",
	owner: "unknown",
	claim: "unknown",
	candidateRuntimeProcessId: "number.integer > 0",
	recoveryState: "string > 0",
});
const QuarantinedReleaseSchema = type({
	schemaVersion: "1",
	releaseSequence: "number.integer > 0",
	forkCommit: "string > 0",
	rejectedAt: "string > 0",
});


function validTimestamp(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}

function parseRestartRequest(value: unknown): AutoBotRestartRequest {
	const request = parseAutoBotRestartRequest(value);
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(request.nonce)) throw new Error("Invalid AutoBot restart nonce");
	if (!path.isAbsolute(request.sessionFile) || !path.isAbsolute(request.cwd)) throw new Error("Invalid AutoBot restart paths");
	return request;
}

function parseActivePointer(value: unknown, paths: AutoBotPaths): AutoBotActivePointer {
	const pointer = ActivePointerSchema.assert(value);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(pointer.slotId)) throw new Error("Invalid AutoBot active slot");
	if (!/^[0-9a-f]{64}$/.test(pointer.runtimeSha256)) throw new Error("Invalid AutoBot runtime digest");
	if (!validTimestamp(pointer.activatedAt)) throw new Error("Invalid AutoBot activation timestamp");
	const runtimePath = path.resolve(pointer.runtimePath);
	if (!pathIsInside(paths.runtimeDir, runtimePath)) throw new Error("AutoBot active runtime escapes managed slots");
	const manifest = parseAutoBotReleaseManifest(pointer.manifest);
	if (!runtimePath.includes(pointer.slotId)) throw new Error("AutoBot active runtime does not match its slot");
	return { ...pointer, runtimePath, manifest };
}

function parseHighWater(value: unknown): AutoBotSequenceHighWater {
	const highWater = HighWaterSchema.assert(value);
	if (!/^[0-9a-f]{64}$/.test(highWater.payloadSha256)) throw new Error("Invalid AutoBot high-water payload digest");
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(highWater.forkCommit)) throw new Error("Invalid AutoBot high-water commit");
	if (!validTimestamp(highWater.acceptedAt)) throw new Error("Invalid AutoBot high-water timestamp");
	return highWater;
}

function autoBotQuarantinePath(paths: AutoBotPaths, releaseSequence: number, forkCommit: string): string {
	if (!Number.isSafeInteger(releaseSequence) || releaseSequence <= 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(forkCommit)) {
		throw new Error("Invalid AutoBot quarantine release identity");
	}
	return path.join(paths.quarantineDir, `${releaseSequence}-${forkCommit}.json`);
}

function parseQuarantinedRelease(value: unknown): AutoBotQuarantinedRelease {
	const quarantined = QuarantinedReleaseSchema.assert(value);
	if (
		quarantined.schemaVersion !== 1 ||
		!Number.isSafeInteger(quarantined.releaseSequence) ||
		quarantined.releaseSequence <= 0 ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(quarantined.forkCommit) ||
		!validTimestamp(quarantined.rejectedAt)
	) {
		throw new Error("Invalid AutoBot quarantined release");
	}
	return quarantined;
}

function parsePendingRestart(value: unknown, paths: AutoBotPaths): AutoBotPendingRestart {
	const pending = PendingRestartSchema.assert(value);
	const request = parseRestartRequest(pending.request);
	const handoffPath = path.resolve(pending.handoffPath);
	const runtimePath = path.resolve(pending.runtimePath);
	const previousRuntimePath = path.resolve(pending.previousRuntimePath);
	if (!pathIsInside(paths.handoffDir, handoffPath)) throw new Error("AutoBot pending handoff escapes its directory");
	if (path.basename(handoffPath) !== `${request.nonce}.candidate.json`) {
		throw new Error("AutoBot pending handoff does not match its request nonce");
	}
	if (!pathIsInside(paths.runtimeDir, runtimePath) || !pathIsInside(paths.runtimeDir, previousRuntimePath)) {
		throw new Error("AutoBot pending restart references an unmanaged runtime");
	}
	if (!validTimestamp(pending.createdAt)) throw new Error("Invalid AutoBot pending restart timestamp");
	return {
		schemaVersion: 1,
		request,
		handoffPath,
		runtimePath,
		previousRuntimePath,
		createdAt: pending.createdAt,
		owner: parseAutoBotHandoffOwner(pending.owner),
		claim: parseAutoBotHandoffClaim(pending.claim),
	};
}

function parseCommittedRestart(value: unknown, paths: AutoBotPaths): AutoBotCommittedRestart {
	const committed = CommittedRestartSchema.assert(value);
	const runtimePath = path.resolve(committed.runtimePath);
	const previousRuntimePath = path.resolve(committed.previousRuntimePath);
	if (!pathIsInside(paths.runtimeDir, runtimePath) || !pathIsInside(paths.runtimeDir, previousRuntimePath)) {
		throw new Error("AutoBot committed restart references an unmanaged runtime");
	}
	if (!validTimestamp(committed.committedAt)) throw new Error("Invalid AutoBot committed restart timestamp");
	if (committed.recoveryState !== "candidate-running" && committed.recoveryState !== "attempt-starting") {
		throw new Error("Invalid AutoBot committed restart recovery state");
	}
	if (!Number.isSafeInteger(committed.candidateRuntimeProcessId)) {
		throw new Error("AutoBot committed restart has an invalid candidate process id");
	}
	return {
		schemaVersion: 1,
		request: parseRestartRequest(committed.request),
		runtimePath,
		previousRuntimePath,
		committedAt: committed.committedAt,
		owner: parseAutoBotHandoffOwner(committed.owner),
		claim: parseAutoBotHandoffClaim(committed.claim),
		candidateRuntimeProcessId: committed.candidateRuntimeProcessId,
		recoveryState: committed.recoveryState,
	};
}

function readJsonSyncIfPresent(filePath: string): unknown | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export async function readAutoBotActivePointer(paths: AutoBotPaths): Promise<AutoBotActivePointer | undefined> {
	const raw = await readJsonIfPresent(paths.activePointerPath);
	return raw === undefined ? undefined : parseActivePointer(raw, paths);
}

/** Bootstrap-safe active pointer read before any normal runtime initialization. */
export function readAutoBotActivePointerSync(paths: AutoBotPaths): AutoBotActivePointer | undefined {
	const raw = readJsonSyncIfPresent(paths.activePointerPath);
	return raw === undefined ? undefined : parseActivePointer(raw, paths);
}

export async function writeAutoBotActivePointer(paths: AutoBotPaths, pointer: AutoBotActivePointer): Promise<void> {
	parseActivePointer(pointer, paths);
	await writeJsonAtomically(paths.activePointerPath, pointer);
}

/**
 * Atomically advance the installation-wide preferred runtime without allowing
 * one older live session to roll it back after another session promoted newer
 * bytes. Equal-sequence conflicts retain the existing pointer.
 */
export async function advanceAutoBotActivePointer(
	paths: AutoBotPaths,
	pointer: AutoBotActivePointer,
): Promise<AutoBotActivePointer> {
	parseActivePointer(pointer, paths);
	await ensurePrivateDirectory(paths.lockDir);
	return withAutoBotFileLock(paths.activePointerLockPath, async () => {
		const current = await readAutoBotActivePointer(paths);
		if (
			current &&
			(current.manifest.releaseSequence > pointer.manifest.releaseSequence ||
				current.manifest.releaseSequence === pointer.manifest.releaseSequence)
		) {
			return current;
		}
		await writeAutoBotActivePointer(paths, pointer);
		return pointer;
	});
}

export async function readAutoBotSequenceHighWater(paths: AutoBotPaths): Promise<AutoBotSequenceHighWater | undefined> {
	const raw = await readJsonIfPresent(paths.highWaterPath);
	return raw === undefined ? undefined : parseHighWater(raw);
}

/** Reject rollback/equivocation before an untrusted staged runtime can execute. */
export async function assertAutoBotSequenceAllowed(
	paths: AutoBotPaths,
	manifest: AutoBotReleaseManifest,
	payloadSha256: string,
): Promise<void> {
	if (!/^[0-9a-f]{64}$/.test(payloadSha256)) throw new Error("Invalid AutoBot signed payload digest");
	const highWater = await readAutoBotSequenceHighWater(paths);
	if (!highWater) return;
	if (manifest.releaseSequence < highWater.releaseSequence) {
		throw new Error("AutoBot release sequence is lower than the accepted high-water mark");
	}
	if (manifest.releaseSequence === highWater.releaseSequence && payloadSha256 !== highWater.payloadSha256) {
		throw new Error("AutoBot release sequence conflicts with the accepted signed payload");
	}
}

/** Advance the high-water mark only after all release bytes have been verified and staged. */
export async function advanceAutoBotSequenceHighWater(
	paths: AutoBotPaths,
	manifest: AutoBotReleaseManifest,
	payloadSha256: string,
): Promise<void> {
	await assertAutoBotSequenceAllowed(paths, manifest, payloadSha256);
	const highWater = await readAutoBotSequenceHighWater(paths);
	if (highWater?.releaseSequence === manifest.releaseSequence) return;
	await writeJsonAtomically(paths.highWaterPath, {
		schemaVersion: 1,
		releaseSequence: manifest.releaseSequence,
		payloadSha256,
		forkCommit: manifest.forkCommit,
		acceptedAt: new Date().toISOString(),
	} satisfies AutoBotSequenceHighWater);
}

/** Persist a pre-activation candidate failure without blocking newer signed releases. */
export async function quarantineAutoBotRelease(
	paths: AutoBotPaths,
	target: AutoBotRestartTarget,
): Promise<void> {
	const filePath = autoBotQuarantinePath(paths, target.releaseSequence, target.forkCommit);
	await writeJsonAtomically(filePath, {
		schemaVersion: 1,
		releaseSequence: target.releaseSequence,
		forkCommit: target.forkCommit,
		rejectedAt: new Date().toISOString(),
	} satisfies AutoBotQuarantinedRelease);
}

/** True only for the exact signed release that failed before activation. */
export async function isAutoBotReleaseQuarantined(
	paths: AutoBotPaths,
	manifest: AutoBotReleaseManifest,
): Promise<boolean> {
	const raw = await readJsonIfPresent(autoBotQuarantinePath(paths, manifest.releaseSequence, manifest.forkCommit));
	if (raw === undefined) return false;
	const quarantined = parseQuarantinedRelease(raw);
	return quarantined.releaseSequence === manifest.releaseSequence && quarantined.forkCommit === manifest.forkCommit;
}

export interface AutoBotHandoffJournalMatch {
	readonly owner: AutoBotHandoffOwner;
	readonly claim: AutoBotHandoffClaim;
	readonly request: AutoBotRestartRequest;
	readonly runtimePath: string;
	readonly previousRuntimePath: string;
}

function sameOwner(left: AutoBotHandoffOwner, right: AutoBotHandoffOwner): boolean {
	return (
		left.launchId === right.launchId &&
		left.bootstrapProcessId === right.bootstrapProcessId &&
		left.predecessorRuntimeProcessId === right.predecessorRuntimeProcessId
	);
}

export function sameAutoBotHandoffClaim(left: AutoBotHandoffClaim, right: AutoBotHandoffClaim): boolean {
	return left.launchId === right.launchId && left.bootstrapProcessId === right.bootstrapProcessId;
}

/** Compare the full authority tuple before a journal consumer mutates it. */
export function matchesAutoBotHandoffJournal(
	record: Pick<AutoBotPendingRestart, "owner" | "claim" | "request" | "runtimePath" | "previousRuntimePath">,
	expected: AutoBotHandoffJournalMatch,
): boolean {
	return (
		sameOwner(record.owner, expected.owner) &&
		sameAutoBotHandoffClaim(record.claim, expected.claim) &&
		JSON.stringify(record.request) === JSON.stringify(expected.request) &&
		path.resolve(record.runtimePath) === path.resolve(expected.runtimePath) &&
		path.resolve(record.previousRuntimePath) === path.resolve(expected.previousRuntimePath)
	);
}

/**
 * Lock the singleton restart journals. Supervisor callers MUST nest this
 * inside `updateLock`; bootstrap callers take only this lock.
 */
export async function withAutoBotHandoffLock<T>(paths: AutoBotPaths, fn: () => Promise<T>): Promise<T> {
	return withAutoBotFileLock(paths.handoffLockPath, fn);
}

export async function readAutoBotPendingRestart(paths: AutoBotPaths): Promise<AutoBotPendingRestart | undefined> {
	const raw = await readJsonIfPresent(paths.pendingRestartPath);
	return raw === undefined ? undefined : parsePendingRestart(raw, paths);
}

/**
 * Non-authorizing snapshot of whether the pending journal identifies this
 * exact bootstrap claimant. It intentionally accepts foreign journal
 * versions and fields. A `true` result MUST be rechecked under
 * `withAutoBotHandoffLock` before any mutation or restart decision. A `false`
 * result is stable only after the caller proves no legitimate matching-owner
 * writer can publish after this read, such as an authenticated child exiting.
 */
export async function hasAutoBotPendingRestartOwnership(
	paths: AutoBotPaths,
	expectedOwner: AutoBotHandoffOwner,
	expectedClaim: AutoBotHandoffClaim,
): Promise<boolean> {
	const raw = await readJsonIfPresent(paths.pendingRestartPath);
	if (raw === undefined) return false;
	const ownership = PendingRestartOwnershipSchema.assert(raw);
	const owner = parseAutoBotHandoffOwner(ownership.owner);
	const claim = parseAutoBotHandoffClaim(ownership.claim);
	return sameOwner(owner, expectedOwner) && sameAutoBotHandoffClaim(claim, expectedClaim);
}


/**
 * Read a pending journal only after its stable owner tuple proves that it
 * belongs to this bootstrap. Caller MUST hold `withAutoBotHandoffLock`.
 * A structurally recognizable unowned foreign request is deliberately left
 * unparsed and untouched; an invalid journal claiming this owner fails closed.
 */
export async function readAutoBotPendingRestartForOwner(
	paths: AutoBotPaths,
	expectedOwner: AutoBotHandoffOwner,
	expectedClaim: AutoBotHandoffClaim,
	previousRuntimePath: string,
): Promise<AutoBotPendingRestart | undefined> {
	const raw = await readJsonIfPresent(paths.pendingRestartPath);
	if (raw === undefined) return undefined;
	const ownership = PendingRestartOwnershipSchema.assert(raw);
	const owner = parseAutoBotHandoffOwner(ownership.owner);
	const claim = parseAutoBotHandoffClaim(ownership.claim);
	if (!sameOwner(owner, expectedOwner) || !sameAutoBotHandoffClaim(claim, expectedClaim)) return undefined;
	const pending = parsePendingRestart(raw, paths);
	return path.resolve(pending.previousRuntimePath) === path.resolve(previousRuntimePath) ? pending : undefined;
}

export function readAutoBotPendingRestartSync(paths: AutoBotPaths): AutoBotPendingRestart | undefined {
	const raw = readJsonSyncIfPresent(paths.pendingRestartPath);
	return raw === undefined ? undefined : parsePendingRestart(raw, paths);
}

async function writeAutoBotPendingRestart(paths: AutoBotPaths, pending: AutoBotPendingRestart): Promise<void> {
	parsePendingRestart(pending, paths);
	await writeJsonAtomically(paths.pendingRestartPath, pending);
}

/**
 * Create a pending journal only if neither global handoff journal is owned.
 * The caller MUST hold `withAutoBotHandoffLock`.
 */
export async function createAutoBotPendingRestart(paths: AutoBotPaths, pending: AutoBotPendingRestart): Promise<boolean> {
	parsePendingRestart(pending, paths);
	if ((await readAutoBotPendingRestart(paths)) || (await readAutoBotCommittedRestart(paths))) return false;
	await writeAutoBotPendingRestart(paths, pending);
	return true;
}

/** Clear only the exact claimant's pending journal. Caller holds handoff lock. */
export async function clearAutoBotPendingRestart(
	paths: AutoBotPaths,
	expected: AutoBotHandoffJournalMatch,
): Promise<boolean> {
	const pending = await readAutoBotPendingRestart(paths);
	if (!pending || !matchesAutoBotHandoffJournal(pending, expected)) return false;
	await removeFileIfPresent(paths.pendingRestartPath);
	return true;
}

/**
 * Consume only the crash residue of this committed journal. A pre-commit
 * pending record has the same sealed owner, nonce, and runtime paths but may
 * retain the predecessor claim after committed orphan recovery reclaims it.
 * Caller holds handoffLock.
 */
export async function clearAutoBotPendingRestartForCommitted(
	paths: AutoBotPaths,
	committed: AutoBotCommittedRestart,
): Promise<boolean> {
	const pending = await readAutoBotPendingRestart(paths);
	if (!pending) return true;
	if (
		!sameOwner(pending.owner, committed.owner) ||
		JSON.stringify(pending.request) !== JSON.stringify(committed.request) ||
		path.resolve(pending.runtimePath) !== committed.runtimePath ||
		path.resolve(pending.previousRuntimePath) !== committed.previousRuntimePath
	) {
		return false;
	}
	await removeFileIfPresent(paths.pendingRestartPath);
	return true;
}

export async function readAutoBotCommittedRestart(paths: AutoBotPaths): Promise<AutoBotCommittedRestart | undefined> {
	const raw = await readJsonIfPresent(paths.committedRestartPath);
	return raw === undefined ? undefined : parseCommittedRestart(raw, paths);
}

export function readAutoBotCommittedRestartSync(paths: AutoBotPaths): AutoBotCommittedRestart | undefined {
	const raw = readJsonSyncIfPresent(paths.committedRestartPath);
	return raw === undefined ? undefined : parseCommittedRestart(raw, paths);
}

async function writeAutoBotCommittedRestart(paths: AutoBotPaths, committed: AutoBotCommittedRestart): Promise<void> {
	parseCommittedRestart(committed, paths);
	await writeJsonAtomically(paths.committedRestartPath, committed);
}

/**
 * Promote an exact pending journal to committed. It never replaces a
 * concurrently created committed record. Caller holds handoff lock.
 */
export async function commitAutoBotPendingRestart(
	paths: AutoBotPaths,
	expected: AutoBotHandoffJournalMatch,
	committed: AutoBotCommittedRestart,
): Promise<boolean> {
	parseCommittedRestart(committed, paths);
	const pending = await readAutoBotPendingRestart(paths);
	if (!pending || !matchesAutoBotHandoffJournal(pending, expected) || (await readAutoBotCommittedRestart(paths))) {
		return false;
	}
	if (
		!sameOwner(committed.owner, pending.owner) ||
		!sameAutoBotHandoffClaim(committed.claim, pending.claim) ||
		JSON.stringify(committed.request) !== JSON.stringify(pending.request) ||
		path.resolve(committed.runtimePath) !== pending.runtimePath ||
		path.resolve(committed.previousRuntimePath) !== pending.previousRuntimePath
	) {
		throw new Error("AutoBot committed restart does not bind its pending owner");
	}
	await writeAutoBotCommittedRestart(paths, committed);
	await removeFileIfPresent(paths.pendingRestartPath);
	return true;
}

/**
 * CAS a committed claimant (for recovery) or its candidate PID/state. The
 * sealed owner, exact request, and runtime paths cannot change. Caller holds
 * handoff lock.
 */
export async function replaceAutoBotCommittedRestart(
	paths: AutoBotPaths,
	expected: AutoBotHandoffJournalMatch,
	next: AutoBotCommittedRestart,
): Promise<boolean> {
	parseCommittedRestart(next, paths);
	const current = await readAutoBotCommittedRestart(paths);
	if (!current || !matchesAutoBotHandoffJournal(current, expected)) return false;
	if (
		!sameOwner(next.owner, current.owner) ||
		JSON.stringify(next.request) !== JSON.stringify(current.request) ||
		path.resolve(next.runtimePath) !== current.runtimePath ||
		path.resolve(next.previousRuntimePath) !== current.previousRuntimePath
	) {
		throw new Error("AutoBot committed restart cannot change its sealed origin");
	}
	await writeAutoBotCommittedRestart(paths, next);
	return true;
}

/** Clear only the exact claimant's committed journal. Caller holds handoff lock. */
export async function clearAutoBotCommittedRestart(
	paths: AutoBotPaths,
	expected: AutoBotHandoffJournalMatch,
): Promise<boolean> {
	const committed = await readAutoBotCommittedRestart(paths);
	if (!committed || !matchesAutoBotHandoffJournal(committed, expected)) return false;
	await removeFileIfPresent(paths.committedRestartPath);
	return true;
}
