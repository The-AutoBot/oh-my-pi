#!/usr/bin/env bun

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	assertAutoBotImportableFile,
	assertAutoBotPrivateDirectory,
	assertAutoBotPrivateFile,
} from "../packages/coding-agent/src/autobot-update/permissions.ts";
import { isRecord } from "../packages/utils/src/type-guards.ts";
import {
	AutoBotReleaseError,
	assertKnownOptions,
	gitOutput,
	parseCliArgs,
	readJson,
	relativeAssetPath,
	requireCommit,
	requireKeyId,
	requireRegularFile,
	requireString,
	requiredOption,
	runCommand,
	writeJsonAtomic,
} from "./autobot-release-common.ts";
import {
	assertCandidateMerge,
	candidateMergeSubject,
	candidateReleaseIdentity,
	exactBunVersion,
	isAncestor,
	latestCandidateMerge,
	requireBranch,
	requireHttpsRepository,
	requireRef,
	resolveRemoteCommit,
	upstreamPackageVersion,
} from "./autobot-release-integrate.ts";
import type { CandidateReleaseIdentity } from "./autobot-release-integrate.ts";
import { runLocalOmp } from "./autobot-local-omp.ts";
import { buildAndPublishLocalRelease, LocalBuildFailure } from "./autobot-local-release.ts";
import type { LocalAutomationConfig, LocalCandidate } from "./autobot-local-types.ts";

const CANONICAL_REPOSITORY = "The-AutoBot/oh-my-pi";
const CONFIG_SCHEMA_VERSION = 1 as const;
const STATE_SCHEMA_VERSION = 1 as const;
const OWNER_SCHEMA_VERSION = 1 as const;
const MAX_OMP_ATTEMPTS = 3;
const BUN_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const DURATION = /^([1-9]\d*(?:\.\d+)?)([smh])$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

const CONFIG_KEYS = [
	"schemaVersion",
	"repository",
	"canonicalBranch",
	"integrationBranch",
	"upstreamRepository",
	"upstreamRef",
	"workRoot",
	"runnerBun",
	"runnerBunVersion",
	"compilerBun",
	"compilerBunVersion",
	"ompExecutable",
	"coordinatorRoot",
	"keyId",
	"privateKeyPath",
	"publicKeyPath",
	"channelRepository",
	"channelBranch",
	"channelPath",
	"allowInitial",
	"maxOmpAttempts",
	"ompMaxTime",
] as const;

const STATE_KEYS = [
	"schemaVersion",
	"phase",
	"producerCommit",
	"canonicalCommit",
	"upstreamCommit",
	"candidateCommit",
	"candidateMergeCommit",
	"integrationRemoteCommit",
	"pendingIntegrationCommit",
	"publishedForkCommit",
	"compatibilityReviewFingerprint",
	"buildFailure",
] as const;

const WORK_ROOT_ENTRY: Record<string, true> = {
	".autobot-local-owner.json": true,
	".autobot-local-state.json": true,
	"repository.git": true,
	worktree: true,
	"cargo-target": true,
};

type LocalPhase =
	| "initialized"
	| "synchronizing"
	| "resolving-conflict"
	| "reviewing-compatibility"
	| "building"
	| "repairing-build"
	| "publishing"
	| "published"
	| "unchanged"
	| "blocked";

interface LocalOwner {
	readonly schemaVersion: typeof OWNER_SCHEMA_VERSION;
	readonly repository: string;
	readonly ownerId: string;
}

interface BuildFailureState {
	readonly fingerprint: string;
	readonly attempts: number;
}

interface LocalState {
	readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
	readonly phase: LocalPhase;
	readonly producerCommit?: string;
	readonly canonicalCommit?: string;
	readonly upstreamCommit?: string;
	readonly candidateCommit?: string;
	readonly candidateMergeCommit?: string;
	readonly integrationRemoteCommit?: string;
	readonly pendingIntegrationCommit?: string;
	readonly publishedForkCommit?: string;
	readonly compatibilityReviewFingerprint?: string;
	readonly buildFailure?: BuildFailureState;
}

interface ManagedWorktree {
	readonly repository: string;
	readonly worktree: string;
	readonly localRef: string;
	readonly initialized: boolean;
}

interface RemoteSnapshot {
	readonly refs: ReadonlyMap<string, string>;
}

interface OmpControllerContext {
	readonly config: LocalAutomationConfig;
	readonly worktree: string;
	readonly localRef: string;
	readonly canonicalRepository: string;
	readonly canonicalRef: string;
	readonly expectedCanonicalCommit: string;
	readonly expectedUpstreamCommit: string;
	readonly expectedIntegrationCommit: string | undefined;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const actual = Object.keys(value);
	if (
		actual.length !== keys.length ||
		keys.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
		actual.some(key => !keys.includes(key))
	) {
		throw new AutoBotReleaseError(`${label} must contain exactly its schema-defined fields`);
	}
}

function recordString(record: Record<string, unknown>, key: string, label: string): string {
	return requireString(record[key], label);
}

function requireAbsolutePath(value: string, label: string): string {
	if (!path.isAbsolute(value)) throw new AutoBotReleaseError(`${label} must be an absolute path`);
	return path.resolve(value);
}

async function requireExistingFile(value: string, label: string, privateFile = false): Promise<string> {
	const absolute = requireAbsolutePath(value, label);
	await requireRegularFile(absolute, label);
	const canonical = privateFile
		? await assertAutoBotPrivateFile(absolute)
		: await assertAutoBotImportableFile(absolute);
	await requireRegularFile(canonical, label);
	return canonical;
}

async function requireExistingDirectory(value: string, label: string): Promise<string> {
	const absolute = requireAbsolutePath(value, label);
	let stat: Stats;
	try {
		stat = await fs.lstat(absolute);
	} catch (error) {
		throw new AutoBotReleaseError(`${label} does not exist: ${absolute}`, { cause: error });
	}
	if (!stat.isDirectory()) throw new AutoBotReleaseError(`${label} must be a directory: ${absolute}`);
	return fs.realpath(absolute);
}

function requireBunVersion(value: string, label: string): string {
	if (!BUN_VERSION.test(value)) throw new AutoBotReleaseError(`${label} must be an exact Bun version`);
	return value;
}

function requireDuration(value: string): string {
	const match = DURATION.exec(value);
	if (!match) throw new AutoBotReleaseError("OMP maximum time must be a positive s, m, or h duration");
	const amount = Number(match[1]);
	const unit = match[2] ?? "";
	const milliseconds = amount * (unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
	if (!Number.isSafeInteger(milliseconds) || milliseconds > 2 * 60 * 60 * 1_000) {
		throw new AutoBotReleaseError("OMP maximum time must not exceed two hours");
	}
	return value;
}

function requireGitHubRepository(value: string, label: string): string {
	if (!GITHUB_REPOSITORY.test(value) || value.includes("..") || value.includes("//")) {
		throw new AutoBotReleaseError(`${label} must be an owner/repository GitHub identifier`);
	}
	return value;
}

function requireMaxOmpAttempts(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_OMP_ATTEMPTS) {
		throw new AutoBotReleaseError(`Maximum OMP attempts must be a safe integer from 0 through ${MAX_OMP_ATTEMPTS}`);
	}
	return value;
}

function samePath(left: string, right: string): boolean {
	return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function containsPath(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sha256(value: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return hasher.digest("hex");
}

function localIntegrationRef(integrationBranch: string): string {
	return `refs/heads/autobot-local/${integrationBranch}`;
}

function localIntegrationBranch(integrationBranch: string): string {
	return `autobot-local/${integrationBranch}`;
}

async function trustedProducer(): Promise<{ readonly root: string; readonly commit: string }> {
	const root = await fs.realpath(path.resolve(import.meta.dir, ".."));
	const actual = await fs.realpath(await gitOutput(root, ["rev-parse", "--show-toplevel"]));
	if (!samePath(root, actual)) {
		throw new AutoBotReleaseError("Local controller must run from its trusted producer repository root");
	}
	return {
		root,
		commit: requireCommit(await gitOutput(root, ["rev-parse", "--verify", "HEAD^{commit}"]), "Trusted producer HEAD"),
	};
}

async function loadLocalAutomationConfig(configPath: string, producerRoot: string): Promise<LocalAutomationConfig> {
	const absoluteConfig = requireAbsolutePath(configPath, "Config path");
	const protectedConfig = await assertAutoBotPrivateFile(absoluteConfig);
	const parsed = await readJson(protectedConfig, "local automation config");
	if (!isRecord(parsed)) throw new AutoBotReleaseError("Local automation config must be a JSON object");
	requireExactKeys(parsed, CONFIG_KEYS, "Local automation config");
	if (parsed.schemaVersion !== CONFIG_SCHEMA_VERSION) {
		throw new AutoBotReleaseError("Local automation config schemaVersion must be 1");
	}

	const repository = requireGitHubRepository(recordString(parsed, "repository", "Repository"), "Repository");
	if (repository !== CANONICAL_REPOSITORY) {
		throw new AutoBotReleaseError(`Repository must be ${CANONICAL_REPOSITORY}`);
	}
	const canonicalBranch = requireBranch(recordString(parsed, "canonicalBranch", "Canonical branch"));
	const integrationBranch = requireBranch(recordString(parsed, "integrationBranch", "Integration branch"));
	if (integrationBranch === canonicalBranch) {
		throw new AutoBotReleaseError("Integration branch must differ from the protected canonical branch");
	}
	const upstreamRepository = requireHttpsRepository(
		recordString(parsed, "upstreamRepository", "Upstream repository"),
		"Upstream repository",
	);
	const upstreamRef = requireRef(recordString(parsed, "upstreamRef", "Upstream ref"), "Upstream ref");
	const requestedWorkRoot = requireAbsolutePath(recordString(parsed, "workRoot", "Work root"), "Work root");
	const workRoot = await assertAutoBotPrivateDirectory(requestedWorkRoot);
	if (containsPath(producerRoot, workRoot) || containsPath(workRoot, producerRoot)) {
		throw new AutoBotReleaseError("Work root must be separate from the trusted producer checkout");
	}
	const runnerBun = await requireExistingFile(recordString(parsed, "runnerBun", "Runner Bun"), "Runner Bun");
	const runnerBunVersion = requireBunVersion(
		recordString(parsed, "runnerBunVersion", "Runner Bun version"),
		"Runner Bun version",
	);
	const compilerBun = await requireExistingFile(recordString(parsed, "compilerBun", "Compiler Bun"), "Compiler Bun");
	const compilerBunVersion = requireBunVersion(
		recordString(parsed, "compilerBunVersion", "Compiler Bun version"),
		"Compiler Bun version",
	);
	const ompExecutable = await requireExistingFile(
		recordString(parsed, "ompExecutable", "OMP executable"),
		"OMP executable",
	);
	const coordinatorRoot = await requireExistingDirectory(
		recordString(parsed, "coordinatorRoot", "Coordinator root"),
		"Coordinator root",
	);
	const keyId = requireKeyId(recordString(parsed, "keyId", "Release key ID"), "Release key ID");
	const privateKeyPath = await requireExistingFile(
		recordString(parsed, "privateKeyPath", "Private key path"),
		"Private key path",
		true,
	);
	const publicKeyPath = await requireExistingFile(
		recordString(parsed, "publicKeyPath", "Public key path"),
		"Public key path",
	);
	const channelRepository = requireGitHubRepository(
		recordString(parsed, "channelRepository", "Channel repository"),
		"Channel repository",
	);
	const channelBranch = requireBranch(recordString(parsed, "channelBranch", "Channel branch"));
	if (
		channelRepository.toLowerCase() === repository.toLowerCase() &&
		(channelBranch.toLowerCase() === canonicalBranch.toLowerCase() ||
			channelBranch.toLowerCase() === integrationBranch.toLowerCase())
	) {
		throw new AutoBotReleaseError("Channel branch must differ from protected canonical and integration branches");
	}
	const channelPath = relativeAssetPath(recordString(parsed, "channelPath", "Channel path"));
	if (typeof parsed.allowInitial !== "boolean") throw new AutoBotReleaseError("allowInitial must be a boolean");
	const maxOmpAttempts = requireMaxOmpAttempts(parsed.maxOmpAttempts);
	const ompMaxTime = requireDuration(recordString(parsed, "ompMaxTime", "OMP maximum time"));

	await Promise.all([
		exactBunVersion(runnerBun, runnerBunVersion, "Runner Bun"),
		exactBunVersion(compilerBun, compilerBunVersion, "Compiler Bun"),
	]);

	return {
		schemaVersion: CONFIG_SCHEMA_VERSION,
		repository,
		canonicalBranch,
		integrationBranch,
		upstreamRepository,
		upstreamRef,
		workRoot,
		runnerBun,
		runnerBunVersion,
		compilerBun,
		compilerBunVersion,
		ompExecutable,
		coordinatorRoot,
		keyId,
		privateKeyPath,
		publicKeyPath,
		channelRepository,
		channelBranch,
		channelPath,
		allowInitial: parsed.allowInitial,
		maxOmpAttempts,
		ompMaxTime,
	};
}

function ownerPath(workRoot: string): string {
	return path.join(workRoot, ".autobot-local-owner.json");
}

function statePath(workRoot: string): string {
	return path.join(workRoot, ".autobot-local-state.json");
}

function ownerId(repository: string, producerRoot: string): string {
	return sha256(`${repository}\u0000${path.resolve(producerRoot).toLowerCase()}`);
}

function parseOwner(value: unknown): LocalOwner {
	if (!isRecord(value)) throw new AutoBotReleaseError("Local work root owner record is invalid");
	requireExactKeys(value, ["schemaVersion", "repository", "ownerId"], "Local work root owner record");
	if (value.schemaVersion !== OWNER_SCHEMA_VERSION) {
		throw new AutoBotReleaseError("Local work root owner schema is unsupported");
	}
	const parsedOwnerId = parseOptionalFingerprint(value.ownerId, "Work root owner identity");
	if (!parsedOwnerId) throw new AutoBotReleaseError("Local work root owner identity is missing");
	return {
		schemaVersion: OWNER_SCHEMA_VERSION,
		repository: requireGitHubRepository(
			requireString(value.repository, "Work root owner repository"),
			"Work root owner repository",
		),
		ownerId: parsedOwnerId,
	};
}

async function pathExists(pathname: string): Promise<boolean> {
	return fs
		.lstat(pathname)
		.then(() => true)
		.catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		});
}

async function assertCargoTarget(workRoot: string): Promise<void> {
	const cargoTarget = path.join(workRoot, "cargo-target");
	const stat = await fs.lstat(cargoTarget);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new AutoBotReleaseError("Work root contains an invalid shared native build cache");
	}
	const canonical = await assertAutoBotPrivateDirectory(cargoTarget);
	if (!samePath(canonical, cargoTarget)) {
		throw new AutoBotReleaseError("Work root shared native build cache did not retain its canonical identity");
	}
}

async function claimWorkRoot(workRoot: string, repository: string, producerRoot: string): Promise<void> {
	const canonicalWorkRoot = await assertAutoBotPrivateDirectory(workRoot);
	if (!samePath(canonicalWorkRoot, workRoot)) {
		throw new AutoBotReleaseError("Work root did not retain its canonical identity");
	}
	const expectedOwnerId = ownerId(repository, producerRoot);
	const markerPath = ownerPath(workRoot);
	const markerExists = await pathExists(markerPath);
	const entries = await fs.readdir(workRoot);
	const allowed = WORK_ROOT_ENTRY;
	if (!markerExists) {
		if (entries.length === 1 && entries[0] === "cargo-target") {
			await assertCargoTarget(workRoot);
		} else if (entries.length !== 0) {
			throw new AutoBotReleaseError("Work root is not an empty owner-private AutoBot directory");
		}
		const owner: LocalOwner = { schemaVersion: OWNER_SCHEMA_VERSION, repository, ownerId: expectedOwnerId };
		await writeJsonAtomic(markerPath, owner);
		await assertAutoBotPrivateFile(markerPath);
		return;
	}
	for (const entry of entries) {
		if (allowed[entry] === true) {
			if (entry === "cargo-target") await assertCargoTarget(workRoot);
			continue;
		}
		if (!/^autobot-release-[A-Za-z0-9._-]+$/.test(entry)) {
			throw new AutoBotReleaseError("Work root contains paths not owned by the local AutoBot controller");
		}
		const stage = await fs.lstat(path.join(workRoot, entry));
		if (!stage.isDirectory() || stage.isSymbolicLink()) {
			throw new AutoBotReleaseError("Work root contains an invalid retained release stage");
		}
	}
	const protectedMarker = await assertAutoBotPrivateFile(markerPath);
	const owner = parseOwner(await readJson(protectedMarker, "local work root owner record"));
	if (owner.repository !== repository || owner.ownerId !== expectedOwnerId) {
		throw new AutoBotReleaseError("Work root belongs to a different local AutoBot controller identity");
	}
}

function parseOptionalCommit(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return requireCommit(requireString(value, label), label);
}

function parseOptionalFingerprint(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	const fingerprint = requireString(value, label);
	if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new AutoBotReleaseError(`${label} must be a SHA-256 digest`);
	return fingerprint;
}

function parseBuildFailure(value: unknown): BuildFailureState | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new AutoBotReleaseError("Local build failure state is invalid");
	requireExactKeys(value, ["fingerprint", "attempts"], "Local build failure state");
	const attempts = value.attempts;
	if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0 || attempts > MAX_OMP_ATTEMPTS) {
		throw new AutoBotReleaseError("Local build failure attempt state is invalid");
	}
	const fingerprint = parseOptionalFingerprint(value.fingerprint, "Build failure fingerprint");
	if (!fingerprint) throw new AutoBotReleaseError("Local build failure fingerprint is invalid");
	return { fingerprint, attempts };
}

function parseLocalState(value: unknown): LocalState {
	if (!isRecord(value)) throw new AutoBotReleaseError("Local automation state is invalid");
	if (
		!Object.prototype.hasOwnProperty.call(value, "schemaVersion") ||
		!Object.prototype.hasOwnProperty.call(value, "phase") ||
		Object.keys(value).some(key => !STATE_KEYS.includes(key as (typeof STATE_KEYS)[number]))
	) {
		throw new AutoBotReleaseError("Local automation state must contain only its schema-defined fields");
	}
	if (value.schemaVersion !== STATE_SCHEMA_VERSION)
		throw new AutoBotReleaseError("Local automation state schema is unsupported");
	const phase = value.phase;
	if (
		phase !== "initialized" &&
		phase !== "synchronizing" &&
		phase !== "resolving-conflict" &&
		phase !== "reviewing-compatibility" &&
		phase !== "building" &&
		phase !== "repairing-build" &&
		phase !== "publishing" &&
		phase !== "published" &&
		phase !== "unchanged" &&
		phase !== "blocked"
	) {
		throw new AutoBotReleaseError("Local automation state phase is invalid");
	}
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		phase,
		producerCommit: parseOptionalCommit(value.producerCommit, "Producer commit"),
		canonicalCommit: parseOptionalCommit(value.canonicalCommit, "Canonical commit"),
		upstreamCommit: parseOptionalCommit(value.upstreamCommit, "Upstream commit"),
		candidateCommit: parseOptionalCommit(value.candidateCommit, "Candidate commit"),
		candidateMergeCommit: parseOptionalCommit(value.candidateMergeCommit, "Candidate merge commit"),
		integrationRemoteCommit: parseOptionalCommit(value.integrationRemoteCommit, "Integration remote commit"),
		pendingIntegrationCommit: parseOptionalCommit(value.pendingIntegrationCommit, "Pending integration commit"),
		publishedForkCommit: parseOptionalCommit(value.publishedForkCommit, "Published fork commit"),
		compatibilityReviewFingerprint: parseOptionalFingerprint(
			value.compatibilityReviewFingerprint,
			"Compatibility review fingerprint",
		),
		buildFailure: parseBuildFailure(value.buildFailure),
	};
}

async function readLocalState(workRoot: string): Promise<LocalState> {
	const localStatePath = statePath(workRoot);
	if (!(await pathExists(localStatePath))) return { schemaVersion: STATE_SCHEMA_VERSION, phase: "initialized" };
	const protectedState = await assertAutoBotPrivateFile(localStatePath);
	return parseLocalState(await readJson(protectedState, "local automation state"));
}

async function writeLocalState(workRoot: string, state: LocalState): Promise<void> {
	const localStatePath = statePath(workRoot);
	await writeJsonAtomic(localStatePath, state);
	await assertAutoBotPrivateFile(localStatePath);
}
async function transition(
	workRoot: string,
	state: LocalState,
	phase: LocalPhase,
	patch: Partial<Omit<LocalState, "schemaVersion" | "phase">> = {},
): Promise<LocalState> {
	const next: LocalState = { ...state, ...patch, schemaVersion: STATE_SCHEMA_VERSION, phase };
	await writeLocalState(workRoot, next);
	console.log(`AutoBot local phase: ${phase}`);
	return next;
}

async function ensureManagedWorktree(
	config: LocalAutomationConfig,
	producerRoot: string,
	producerCommit: string,
): Promise<ManagedWorktree> {
	const repository = path.join(config.workRoot, "repository.git");
	const worktree = path.join(config.workRoot, "worktree");
	const localRef = localIntegrationRef(config.integrationBranch);
	const repositoryExists = await pathExists(repository);
	const worktreeExists = await pathExists(worktree);
	if (!repositoryExists && !worktreeExists) {
		await runCommand(["git", "clone", "--bare", "--no-local", producerRoot, repository], { capture: true });
		// The source checkout is a read-only seed. Remove clone's local origin
		// before exposing the owned worktree to OMP so no shorthand push can
		// mutate the user checkout.
		await runCommand(["git", "-C", repository, "remote", "remove", "origin"], { capture: true });
		await runCommand(["git", "-C", repository, "worktree", "add", "--detach", worktree, producerCommit], {
			capture: true,
		});
		await runCommand(
			["git", "-C", worktree, "checkout", "-B", localIntegrationBranch(config.integrationBranch), producerCommit],
			{
				capture: true,
			},
		);
		return { repository, worktree, localRef, initialized: true };
	}
	if (!repositoryExists || !worktreeExists) {
		throw new AutoBotReleaseError("Owner-private work root has an incomplete persistent repository/worktree pair");
	}
	if ((await gitOutput(repository, ["rev-parse", "--is-bare-repository"])) !== "true") {
		throw new AutoBotReleaseError("Persistent AutoBot repository must remain bare");
	}
	if ((await gitOutput(repository, ["remote"])) !== "") {
		throw new AutoBotReleaseError("Persistent AutoBot repository must not retain Git remotes");
	}
	const actualRoot = await fs.realpath(await gitOutput(worktree, ["rev-parse", "--show-toplevel"]));
	if (!samePath(actualRoot, worktree)) throw new AutoBotReleaseError("Persistent AutoBot worktree path is invalid");
	const commonDirectory = await fs.realpath(await gitOutput(worktree, ["rev-parse", "--git-common-dir"]));
	if (!samePath(commonDirectory, repository))
		throw new AutoBotReleaseError("Persistent AutoBot worktree has an unexpected Git common directory");
	return { repository, worktree, localRef, initialized: false };
}

async function gitExit(
	cwd: string,
	args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
	const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	return { exitCode, stdout };
}

async function currentCommit(worktree: string, label: string): Promise<string> {
	return requireCommit(await gitOutput(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]), label);
}

async function assertManagedBranch(worktree: string, localRef: string): Promise<void> {
	const branch = await gitOutput(worktree, ["symbolic-ref", "--quiet", "HEAD"]);
	if (branch !== localRef)
		throw new AutoBotReleaseError("Local controller worktree is not on its managed integration branch");
}

async function mergeHead(worktree: string): Promise<string | undefined> {
	const result = await gitExit(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
	if (result.exitCode === 1) return undefined;
	if (result.exitCode !== 0) throw new AutoBotReleaseError("Could not inspect local merge state");
	return requireCommit(result.stdout.trim(), "Merge head");
}

async function assertNoUnmergedIndex(worktree: string): Promise<void> {
	const entries = await runCommand(["git", "ls-files", "-u", "-z"], { cwd: worktree, capture: true });
	if (entries.stdout.length !== 0) throw new AutoBotReleaseError("Local integration has unresolved index entries");
}

async function assertDiffCheck(worktree: string, base?: string): Promise<void> {
	await runCommand(["git", "diff", "--check"], { cwd: worktree, capture: true });
	await runCommand(["git", "diff", "--cached", "--check"], { cwd: worktree, capture: true });
	if (base)
		await runCommand(["git", "diff", "--check", requireCommit(base, "Diff base"), "HEAD"], {
			cwd: worktree,
			capture: true,
		});
}

async function assertCleanWorktree(worktree: string, localRef: string, base?: string): Promise<void> {
	await assertManagedBranch(worktree, localRef);
	await assertNoUnmergedIndex(worktree);
	if (await mergeHead(worktree)) throw new AutoBotReleaseError("Local integration retains an unfinished merge");
	await assertDiffCheck(worktree, base);
	const status = await runCommand(["git", "status", "--porcelain=v1", "-z"], { cwd: worktree, capture: true });
	if (status.stdout.length !== 0)
		throw new AutoBotReleaseError("Local integration has retained changes; preserving worktree for inspection");
}

async function snapshotLocalRefs(worktree: string): Promise<ReadonlyMap<string, string>> {
	const result = await runCommand(["git", "for-each-ref", "--format=%(refname)%09%(objectname)"], {
		cwd: worktree,
		capture: true,
	});
	const refs = new Map<string, string>();
	for (const line of result.stdout.split("\n")) {
		if (!line) continue;
		const [ref, object, extra] = line.split("\t");
		if (!ref || !object || extra !== undefined || !ref.startsWith("refs/")) {
			throw new AutoBotReleaseError("Local Git ref snapshot is invalid");
		}
		refs.set(ref, requireCommit(object, "Local Git ref object"));
	}
	return refs;
}

async function assertOnlyManagedRefAdvanced(
	worktree: string,
	before: ReadonlyMap<string, string>,
	localRef: string,
	previousHead: string,
): Promise<void> {
	const after = await snapshotLocalRefs(worktree);
	const names = new Set([...before.keys(), ...after.keys()]);
	for (const name of names) {
		const oldValue = before.get(name);
		const newValue = after.get(name);
		if (oldValue === newValue) continue;
		if (name !== localRef || !newValue || !(await isAncestor(worktree, previousHead, newValue))) {
			throw new AutoBotReleaseError("OMP changed an unauthorized local Git ref");
		}
	}
}

async function snapshotRemoteRefs(repository: string): Promise<RemoteSnapshot> {
	const result = await runCommand(["git", "ls-remote", "--refs", repository], { capture: true });
	const refs = new Map<string, string>();
	for (const line of result.stdout.split("\n")) {
		if (!line.trim()) continue;
		const [object, ref] = line.trim().split(/\s+/, 2);
		if (!object || !ref || !ref.startsWith("refs/"))
			throw new AutoBotReleaseError("Remote Git ref snapshot is invalid");
		if (refs.has(ref)) throw new AutoBotReleaseError("Remote Git ref snapshot has duplicate refs");
		refs.set(ref, requireCommit(object, "Remote Git ref object"));
	}
	return { refs };
}

function assertRemoteSnapshotsEqual(before: RemoteSnapshot, after: RemoteSnapshot): void {
	if (before.refs.size !== after.refs.size)
		throw new AutoBotReleaseError("Remote Git refs changed during local OMP execution");
	for (const [ref, object] of before.refs) {
		if (after.refs.get(ref) !== object)
			throw new AutoBotReleaseError("Remote Git refs changed during local OMP execution");
	}
}

function assertOnlyIntegrationRefChanged(
	before: RemoteSnapshot,
	after: RemoteSnapshot,
	integrationRef: string,
	expectedCommit: string,
): void {
	const refs = new Set([...before.refs.keys(), ...after.refs.keys()]);
	for (const ref of refs) {
		const previous = before.refs.get(ref);
		const next = after.refs.get(ref);
		if (ref === integrationRef) {
			if (next !== expectedCommit)
				throw new AutoBotReleaseError("Integration branch did not resolve to the committed candidate");
			continue;
		}
		if (previous !== next) throw new AutoBotReleaseError("Unexpected remote Git ref changed during integration push");
	}
}

async function fetchPinnedCommit(
	worktree: string,
	repository: string,
	expectedCommit: string,
	label: string,
): Promise<void> {
	const expected = requireCommit(expectedCommit, `${label} pinned commit`);
	await runCommand(["git", "fetch", "--no-tags", repository, expected], { cwd: worktree, capture: true });
	const actual = requireCommit(
		await gitOutput(worktree, ["rev-parse", "FETCH_HEAD^{commit}"]),
		`${label} fetched commit`,
	);
	if (actual !== expected) throw new AutoBotReleaseError(`${label} fetch did not retain its resolved commit`);
}

async function startMerge(worktree: string, target: string): Promise<"ready" | "conflicted" | "already-integrated"> {
	const result = await gitExit(worktree, [
		"-c",
		"user.name=autobot-local",
		"-c",
		"user.email=autobot-local@invalid",
		"merge",
		"--no-commit",
		"--no-ff",
		target,
	]);
	const pending = await mergeHead(worktree);
	if (pending) return result.exitCode === 0 ? "ready" : "conflicted";
	if (result.exitCode === 0) return "already-integrated";
	throw new AutoBotReleaseError("Pinned integration merge failed before entering a resolvable merge state");
}

async function assertExactMerge(
	worktree: string,
	commit: string,
	firstParent: string,
	secondParent: string,
	subject: string,
): Promise<void> {
	const parents = (await gitOutput(worktree, ["show", "-s", "--format=%P", commit])).split(" ").filter(Boolean);
	if (parents.length !== 2 || parents[0] !== firstParent || parents[1] !== secondParent) {
		throw new AutoBotReleaseError("Local integration merge does not retain the expected parent ordering");
	}
	if ((await gitOutput(worktree, ["show", "-s", "--format=%s", commit])) !== subject) {
		throw new AutoBotReleaseError("Local integration merge does not retain its required subject");
	}
}

async function finalizeMerge(
	worktree: string,
	localRef: string,
	base: string,
	other: string,
	subject: string,
	candidate: boolean,
): Promise<string> {
	const pending = await mergeHead(worktree);
	if (pending) {
		if (pending !== other)
			throw new AutoBotReleaseError("Local integration merge head differs from its pinned input");
		await assertNoUnmergedIndex(worktree);
		await assertDiffCheck(worktree, base);
		await runCommand(
			[
				"git",
				"-c",
				"user.name=autobot-local",
				"-c",
				"user.email=autobot-local@invalid",
				"commit",
				"--no-gpg-sign",
				"-m",
				subject,
			],
			{ cwd: worktree, capture: true },
		);
	}
	await assertManagedBranch(worktree, localRef);
	const commit = await currentCommit(worktree, "Local integration merge commit");
	if (candidate) {
		await assertCandidateMerge(worktree, commit, other, base);
	} else {
		await assertExactMerge(worktree, commit, base, other, subject);
	}
	await assertCleanWorktree(worktree, localRef, base);
	return commit;
}

async function createSyntheticCandidateMerge(
	worktree: string,
	localRef: string,
	base: string,
	upstreamCommit: string,
): Promise<string> {
	if (!(await isAncestor(worktree, upstreamCommit, base))) {
		throw new AutoBotReleaseError(
			"Synthetic candidate merge is allowed only when pinned upstream is already retained",
		);
	}
	const tree = await gitOutput(worktree, ["write-tree"]);
	const created = await runCommand(
		[
			"git",
			"-c",
			"user.name=autobot-local",
			"-c",
			"user.email=autobot-local@invalid",
			"commit-tree",
			tree,
			"-p",
			base,
			"-p",
			upstreamCommit,
			"-m",
			candidateMergeSubject(upstreamCommit),
		],
		{ cwd: worktree, capture: true },
	);
	const candidateCommit = requireCommit(created.stdout.trim(), "Synthetic candidate merge commit");
	await runCommand(["git", "update-ref", localRef, candidateCommit, base], { cwd: worktree, capture: true });
	await assertManagedBranch(worktree, localRef);
	await assertCandidateMerge(worktree, candidateCommit, upstreamCommit, base);
	await assertCleanWorktree(worktree, localRef, base);
	return candidateCommit;
}

async function commitPendingChanges(
	worktree: string,
	localRef: string,
	base: string,
	subject: string,
): Promise<string> {
	await assertManagedBranch(worktree, localRef);
	await assertNoUnmergedIndex(worktree);
	await assertDiffCheck(worktree, base);
	const before = await currentCommit(worktree, "Pre-commit integration HEAD");
	const status = await runCommand(["git", "status", "--porcelain=v1", "-z"], { cwd: worktree, capture: true });
	if (status.stdout.length === 0) return before;
	await runCommand(["git", "add", "--all"], { cwd: worktree, capture: true });
	await assertNoUnmergedIndex(worktree);
	await assertDiffCheck(worktree, base);
	await runCommand(
		[
			"git",
			"-c",
			"user.name=autobot-local",
			"-c",
			"user.email=autobot-local@invalid",
			"commit",
			"--no-gpg-sign",
			"-m",
			subject,
		],
		{ cwd: worktree, capture: true },
	);
	const after = await currentCommit(worktree, "Committed local integration HEAD");
	if (!(await isAncestor(worktree, before, after))) {
		throw new AutoBotReleaseError("Committed OMP changes did not preserve the previous integration history");
	}
	await assertCleanWorktree(worktree, localRef, base);
	return after;
}

async function invokeOmpGuarded(
	context: OmpControllerContext,
	reason: "conflicts" | "compatibility" | "build-failure",
	sensitivePaths: readonly string[],
	diagnostics: string | undefined,
): Promise<void> {
	const beforeHead = await currentCommit(context.worktree, "Pre-OMP integration HEAD");
	const localRefs = await snapshotLocalRefs(context.worktree);
	const remoteRefs = await snapshotRemoteRefs(context.canonicalRepository);
	if (remoteRefs.refs.get(context.canonicalRef) !== context.expectedCanonicalCommit) {
		throw new AutoBotReleaseError("Protected canonical branch changed before local OMP execution");
	}
	const integrationRef = `refs/heads/${context.config.integrationBranch}`;
	if (remoteRefs.refs.get(integrationRef) !== context.expectedIntegrationCommit) {
		throw new AutoBotReleaseError("Integration branch changed before local OMP execution");
	}
	let ompError: unknown;
	try {
		await runLocalOmp(context.config, {
			cwd: context.worktree,
			reason,
			forkCommit: beforeHead,
			upstreamCommit: context.expectedUpstreamCommit,
			sensitivePaths,
			diagnostics,
		});
	} catch (error) {
		ompError = error;
	}
	let postconditionError: unknown;
	try {
		await assertManagedBranch(context.worktree, context.localRef);
		if ((await gitOutput(context.worktree, ["remote"])) !== "") {
			throw new AutoBotReleaseError("OMP added a Git remote to the managed integration worktree");
		}
		const afterHead = await currentCommit(context.worktree, "Post-OMP integration HEAD");
		if (!(await isAncestor(context.worktree, beforeHead, afterHead))) {
			throw new AutoBotReleaseError("OMP did not preserve the prior integration ancestry");
		}
		await assertOnlyManagedRefAdvanced(context.worktree, localRefs, context.localRef, beforeHead);
		assertRemoteSnapshotsEqual(remoteRefs, await snapshotRemoteRefs(context.canonicalRepository));
	} catch (error) {
		postconditionError = error;
	}
	if (postconditionError !== undefined) throw postconditionError;
	if (ompError !== undefined) throw ompError;
}

async function mergePinnedInput(
	context: OmpControllerContext,
	target: string,
	subject: string,
	candidate: boolean,
	ompAttempts: { value: number },
): Promise<string> {
	const base = await currentCommit(context.worktree, "Integration merge base");
	const outcome = await startMerge(context.worktree, target);
	if (outcome === "already-integrated") {
		if (candidate) return createSyntheticCandidateMerge(context.worktree, context.localRef, base, target);
		throw new AutoBotReleaseError("Required source synchronization was unexpectedly already integrated");
	}
	if (outcome === "conflicted") {
		if (ompAttempts.value >= context.config.maxOmpAttempts) {
			throw new AutoBotReleaseError("Configured OMP attempt limit reached while resolving an integration conflict");
		}
		ompAttempts.value++;
		await invokeOmpGuarded(context, "conflicts", [], undefined);
	}
	return finalizeMerge(context.worktree, context.localRef, base, target, subject, candidate);
}

async function assertRemoteInputs(
	config: LocalAutomationConfig,
	canonicalRepository: string,
	canonicalRef: string,
	canonicalCommit: string,
	upstreamCommit: string,
	expectedIntegrationCommit: string | undefined,
): Promise<RemoteSnapshot> {
	const snapshot = await snapshotRemoteRefs(canonicalRepository);
	if (snapshot.refs.get(canonicalRef) !== canonicalCommit) {
		throw new AutoBotReleaseError("Protected canonical branch moved after it was pinned");
	}
	if (snapshot.refs.get(`refs/heads/${config.integrationBranch}`) !== expectedIntegrationCommit) {
		throw new AutoBotReleaseError("Integration branch moved after it was pinned");
	}
	const currentUpstream = await resolveRemoteCommit(config.upstreamRepository, config.upstreamRef, "Upstream");
	if (currentUpstream !== upstreamCommit) throw new AutoBotReleaseError("Upstream ref moved after it was pinned");
	return snapshot;
}

async function pushIntegrationBranch(context: OmpControllerContext, candidateCommit: string): Promise<string> {
	const before = await assertRemoteInputs(
		context.config,
		context.canonicalRepository,
		context.canonicalRef,
		context.expectedCanonicalCommit,
		context.expectedUpstreamCommit,
		context.expectedIntegrationCommit,
	);
	if (context.expectedIntegrationCommit) {
		await fetchPinnedCommit(
			context.worktree,
			context.canonicalRepository,
			context.expectedIntegrationCommit,
			"Existing integration branch",
		);
		if (!(await isAncestor(context.worktree, context.expectedIntegrationCommit, candidateCommit))) {
			throw new AutoBotReleaseError("Candidate would discard existing dedicated integration branch history");
		}
	}
	await runCommand(
		["git", "push", context.canonicalRepository, `${candidateCommit}:refs/heads/${context.config.integrationBranch}`],
		{ cwd: context.worktree, capture: true },
	);
	const after = await snapshotRemoteRefs(context.canonicalRepository);
	assertOnlyIntegrationRefChanged(before, after, `refs/heads/${context.config.integrationBranch}`, candidateCommit);
	return candidateCommit;
}

async function compatibilityFingerprint(candidate: LocalCandidate, canonicalCommit: string): Promise<string> {
	// Bind review coverage to exact compatibility-relevant changes, not whole
	// candidate roots: non-sensitive integrations and repairs retain coverage,
	// while a changed sensitive blob or compatibility epoch must re-run review.
	const basis = [String(candidate.compatibilityEpoch), ...candidate.sensitivePaths];
	if (candidate.sensitivePaths.length === 0) return sha256(basis.join("\u0000"));
	const compatibilityDiff = await runCommand(
		[
			"git",
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--raw",
			"-z",
			"--no-abbrev",
			"--no-renames",
			requireCommit(canonicalCommit, "Canonical compatibility base"),
			candidate.forkCommit,
		],
		{ cwd: candidate.sourceRoot, capture: true },
	);
	const fields = compatibilityDiff.stdout.split("\u0000");
	if (fields.at(-1) !== "") throw new AutoBotReleaseError("Compatibility diff metadata is malformed");
	const pending = new Set(candidate.sensitivePaths);
	if (pending.size !== candidate.sensitivePaths.length) {
		throw new AutoBotReleaseError("Candidate compatibility paths contain duplicates");
	}
	const records: string[] = [];
	for (let index = 0; index < fields.length - 1; index += 2) {
		const header = fields[index];
		const pathname = fields[index + 1];
		if (!header?.startsWith(":") || pathname === undefined) {
			throw new AutoBotReleaseError("Compatibility diff metadata is malformed");
		}
		if (pending.delete(pathname)) records.push(header, pathname);
	}
	if (pending.size !== 0) throw new AutoBotReleaseError("Compatibility diff omitted a declared sensitive path");
	return sha256([...basis, ...records].join("\u0000"));
}

function buildFailureFingerprint(candidate: LocalCandidate): string {
	return sha256(`${candidate.forkCommit}\u0000${candidate.upstreamCommit}\u0000${candidate.compatibilityEpoch}`);
}

function candidateFromIdentity(
	worktree: string,
	forkCommit: string,
	upstreamCommit: string,
	upstreamVersion: string,
	identity: CandidateReleaseIdentity,
	changed: boolean,
): LocalCandidate {
	return {
		sourceRoot: worktree,
		forkCommit,
		upstreamCommit,
		upstreamVersion,
		compatibilityEpoch: identity.compatibilityEpoch,
		changed,
		sensitivePaths: identity.compatibilityReviewPaths,
	};
}

async function prepareCandidate(
	config: LocalAutomationConfig,
	managed: ManagedWorktree,
	canonicalRepository: string,
	canonicalRef: string,
	canonicalCommit: string,
	upstreamCommit: string,
	upstreamVersion: string,
	integrationRemoteCommit: string | undefined,
	state: LocalState,
	initialSourceChanged: boolean,
	ompAttempts: { value: number },
	setPhase: (phase: LocalPhase, patch?: Partial<Omit<LocalState, "schemaVersion" | "phase">>) => Promise<void>,
): Promise<{ readonly candidate: LocalCandidate; readonly candidateMergeCommit: string; readonly state: LocalState }> {
	let currentState = state;
	let currentHead = await currentCommit(managed.worktree, "Initial local integration HEAD");
	const initialHead = currentHead;
	const context = (): OmpControllerContext => ({
		config,
		worktree: managed.worktree,
		localRef: managed.localRef,
		canonicalRepository,
		canonicalRef,
		expectedCanonicalCommit: canonicalCommit,
		expectedUpstreamCommit: upstreamCommit,
		expectedIntegrationCommit: integrationRemoteCommit,
	});
	let sourceChanged = initialSourceChanged;

	if (managed.initialized && integrationRemoteCommit) {
		await fetchPinnedCommit(
			managed.worktree,
			canonicalRepository,
			integrationRemoteCommit,
			"Existing integration branch",
		);
	}
	if (
		managed.initialized &&
		integrationRemoteCommit &&
		!(await isAncestor(managed.worktree, integrationRemoteCommit, currentHead))
	) {
		await setPhase("synchronizing");
		const merged = await mergePinnedInput(
			context(),
			integrationRemoteCommit,
			`chore(autobot): resume integration ${integrationRemoteCommit.slice(0, 12)}`,
			false,
			ompAttempts,
		);
		currentHead = merged;
		sourceChanged = true;
	}

	if (currentState.producerCommit && !(await isAncestor(managed.worktree, currentState.producerCommit, currentHead))) {
		throw new AutoBotReleaseError("Persistent integration does not retain its recorded trusted producer commit");
	}

	if (!(await isAncestor(managed.worktree, canonicalCommit, currentHead))) {
		await setPhase("synchronizing");
		currentHead = await mergePinnedInput(
			context(),
			canonicalCommit,
			`chore(autobot): synchronize canonical ${canonicalCommit.slice(0, 12)}`,
			false,
			ompAttempts,
		);
		sourceChanged = true;
	}

	if (!(await isAncestor(managed.worktree, canonicalCommit, currentHead))) {
		throw new AutoBotReleaseError("Local integration does not retain its pinned canonical ancestor");
	}

	let retainedCandidate = await latestCandidateMerge(managed.worktree, currentHead);
	if (sourceChanged || retainedCandidate?.upstreamCommit !== upstreamCommit) {
		await setPhase("synchronizing");
		currentHead = await mergePinnedInput(
			context(),
			upstreamCommit,
			candidateMergeSubject(upstreamCommit),
			true,
			ompAttempts,
		);
		retainedCandidate = await assertCandidateMerge(managed.worktree, currentHead, upstreamCommit);
		sourceChanged = true;
	}
	if (!retainedCandidate || retainedCandidate.upstreamCommit !== upstreamCommit) {
		throw new AutoBotReleaseError(
			"Local integration lacks the required retained candidate merge for pinned upstream",
		);
	}
	if (!(await isAncestor(managed.worktree, retainedCandidate.commit, currentHead))) {
		throw new AutoBotReleaseError("Local integration does not retain its candidate merge ancestry");
	}
	if (!(await isAncestor(managed.worktree, upstreamCommit, currentHead))) {
		throw new AutoBotReleaseError("Local integration does not retain its pinned upstream ancestor");
	}

	let identity = await candidateReleaseIdentity(managed.worktree, canonicalCommit, currentHead);
	let candidate = candidateFromIdentity(
		managed.worktree,
		currentHead,
		upstreamCommit,
		upstreamVersion,
		identity,
		sourceChanged || currentState.publishedForkCommit !== currentHead,
	);
	const reviewKey = await compatibilityFingerprint(candidate, canonicalCommit);
	if (candidate.sensitivePaths.length > 0 && currentState.compatibilityReviewFingerprint !== reviewKey) {
		if (ompAttempts.value >= config.maxOmpAttempts) {
			throw new AutoBotReleaseError("Configured OMP attempt limit reached for compatibility review");
		}
		await setPhase("reviewing-compatibility");
		ompAttempts.value++;
		const beforeReview = currentHead;
		await invokeOmpGuarded(context(), "compatibility", candidate.sensitivePaths, undefined);
		currentHead = await commitPendingChanges(
			managed.worktree,
			managed.localRef,
			beforeReview,
			`chore(autobot): compatibility review ${upstreamCommit.slice(0, 12)}`,
		);
		if (!(await isAncestor(managed.worktree, beforeReview, currentHead))) {
			throw new AutoBotReleaseError("OMP compatibility work did not preserve the candidate ancestry");
		}
		identity = await candidateReleaseIdentity(managed.worktree, canonicalCommit, currentHead);
		candidate = candidateFromIdentity(managed.worktree, currentHead, upstreamCommit, upstreamVersion, identity, true);
		const reviewedFingerprint = await compatibilityFingerprint(candidate, canonicalCommit);
		currentState = {
			...currentState,
			compatibilityReviewFingerprint: reviewedFingerprint,
		};
		await setPhase("synchronizing", { compatibilityReviewFingerprint: reviewedFingerprint });
		sourceChanged = sourceChanged || currentHead !== beforeReview;
	}

	await assertCleanWorktree(managed.worktree, managed.localRef, canonicalCommit);
	const finalHead = await currentCommit(managed.worktree, "Prepared local candidate commit");
	const candidateMerge = await latestCandidateMerge(managed.worktree, finalHead);
	if (!candidateMerge || candidateMerge.upstreamCommit !== upstreamCommit) {
		throw new AutoBotReleaseError("Prepared local candidate no longer retains the pinned upstream merge");
	}
	candidate = candidateFromIdentity(
		managed.worktree,
		finalHead,
		upstreamCommit,
		upstreamVersion,
		await candidateReleaseIdentity(managed.worktree, canonicalCommit, finalHead),
		sourceChanged || finalHead !== initialHead || currentState.publishedForkCommit !== finalHead,
	);
	return { candidate, candidateMergeCommit: candidateMerge.commit, state: currentState };
}

async function runLocalAutomation(configPath: string): Promise<void> {
	if (process.platform !== "win32" || process.arch !== "x64") {
		throw new AutoBotReleaseError("Local AutoBot automation supports Windows x64 only");
	}
	const producer = await trustedProducer();
	const config = await loadLocalAutomationConfig(configPath, producer.root);
	await claimWorkRoot(config.workRoot, config.repository, producer.root);
	let state = await readLocalState(config.workRoot);
	try {
		const managed = await ensureManagedWorktree(config, producer.root, producer.commit);
		await assertCleanWorktree(managed.worktree, managed.localRef);
		const canonicalRepository = requireHttpsRepository(
			`https://github.com/${config.repository}.git`,
			"Canonical repository",
		);
		const canonicalRef = `refs/heads/${config.canonicalBranch}`;
		const [canonicalCommit, upstreamCommit] = await Promise.all([
			resolveRemoteCommit(canonicalRepository, canonicalRef, "Canonical"),
			resolveRemoteCommit(config.upstreamRepository, config.upstreamRef, "Upstream"),
		]);
		const remoteRefs = await snapshotRemoteRefs(canonicalRepository);
		if (remoteRefs.refs.get(canonicalRef) !== canonicalCommit) {
			throw new AutoBotReleaseError("Canonical branch changed while its source was being pinned");
		}
		const integrationRemoteCommit = remoteRefs.refs.get(`refs/heads/${config.integrationBranch}`);
		if (state.pendingIntegrationCommit !== undefined) {
			if (integrationRemoteCommit === state.pendingIntegrationCommit) {
				state = await transition(config.workRoot, state, "synchronizing", {
					integrationRemoteCommit,
					pendingIntegrationCommit: undefined,
				});
			} else if (integrationRemoteCommit === state.integrationRemoteCommit) {
				state = await transition(config.workRoot, state, "synchronizing", {
					pendingIntegrationCommit: undefined,
				});
			} else {
				throw new AutoBotReleaseError(
					"Dedicated integration branch did not reconcile with the interrupted local push",
				);
			}
		}
		if (state.integrationRemoteCommit !== undefined && state.integrationRemoteCommit !== integrationRemoteCommit) {
			throw new AutoBotReleaseError("Dedicated integration branch changed outside the local controller");
		}
		await fetchPinnedCommit(managed.worktree, producer.root, producer.commit, "Trusted producer");
		await fetchPinnedCommit(managed.worktree, canonicalRepository, canonicalCommit, "Canonical");
		await fetchPinnedCommit(managed.worktree, config.upstreamRepository, upstreamCommit, "Upstream");
		const upstreamVersion = await upstreamPackageVersion(managed.worktree, upstreamCommit);
		state = await transition(config.workRoot, state, "synchronizing", {
			producerCommit: producer.commit,
			canonicalCommit,
			upstreamCommit,
			integrationRemoteCommit,
		});
		const ompAttempts = { value: 0 };
		const setPhase = async (
			phase: LocalPhase,
			patch: Partial<Omit<LocalState, "schemaVersion" | "phase">> = {},
		): Promise<void> => {
			state = await transition(config.workRoot, state, phase, patch);
		};

		let currentHead = await currentCommit(managed.worktree, "Persistent integration HEAD");
		let producerMerged = false;
		if (!(await isAncestor(managed.worktree, producer.commit, currentHead))) {
			await setPhase("synchronizing");
			const producerContext: OmpControllerContext = {
				config,
				worktree: managed.worktree,
				localRef: managed.localRef,
				canonicalRepository,
				canonicalRef,
				expectedCanonicalCommit: canonicalCommit,
				expectedUpstreamCommit: upstreamCommit,
				expectedIntegrationCommit: integrationRemoteCommit,
			};
			currentHead = await mergePinnedInput(
				producerContext,
				producer.commit,
				`chore(autobot): synchronize producer ${producer.commit.slice(0, 12)}`,
				false,
				ompAttempts,
			);
			producerMerged = true;
		}
		if (!(await isAncestor(managed.worktree, producer.commit, currentHead))) {
			throw new AutoBotReleaseError("Persistent integration does not retain the committed trusted producer HEAD");
		}

		const prepared = await prepareCandidate(
			config,
			managed,
			canonicalRepository,
			canonicalRef,
			canonicalCommit,
			upstreamCommit,
			upstreamVersion,
			integrationRemoteCommit,
			state,
			producerMerged,
			ompAttempts,
			setPhase,
		);
		state = { ...state, compatibilityReviewFingerprint: prepared.state.compatibilityReviewFingerprint };
		const candidate = prepared.candidate;
		const finalHead = await currentCommit(managed.worktree, "Final local candidate commit");
		if (candidate.forkCommit !== finalHead)
			throw new AutoBotReleaseError("Candidate identity does not match the committed local integration head");
		if (!(await isAncestor(managed.worktree, canonicalCommit, finalHead))) {
			throw new AutoBotReleaseError("Final local candidate does not retain the pinned canonical ancestor");
		}
		if (!(await isAncestor(managed.worktree, upstreamCommit, finalHead))) {
			throw new AutoBotReleaseError("Final local candidate does not retain the pinned upstream ancestor");
		}
		await assertCleanWorktree(managed.worktree, managed.localRef, canonicalCommit);

		if (!candidate.changed && state.publishedForkCommit === candidate.forkCommit) {
			state = await transition(config.workRoot, state, "unchanged", {
				candidateCommit: candidate.forkCommit,
				candidateMergeCommit: prepared.candidateMergeCommit,
			});
			return;
		}
		state = await transition(config.workRoot, state, "synchronizing", {
			candidateCommit: candidate.forkCommit,
			candidateMergeCommit: prepared.candidateMergeCommit,
			pendingIntegrationCommit: candidate.forkCommit,
		});
		let expectedIntegrationCommit = await pushIntegrationBranch(
			{
				config,
				worktree: managed.worktree,
				localRef: managed.localRef,
				canonicalRepository,
				canonicalRef,
				expectedCanonicalCommit: canonicalCommit,
				expectedUpstreamCommit: upstreamCommit,
				expectedIntegrationCommit: integrationRemoteCommit,
			},
			candidate.forkCommit,
		);
		state = await transition(config.workRoot, state, "building", {
			candidateCommit: candidate.forkCommit,
			candidateMergeCommit: prepared.candidateMergeCommit,
			integrationRemoteCommit: expectedIntegrationCommit,
			pendingIntegrationCommit: undefined,
		});

		let publishCandidate = candidate;
		let publishCandidateMerge = prepared.candidateMergeCommit;
		while (true) {
			try {
				await setPhase("publishing");
				const published = await buildAndPublishLocalRelease(config, publishCandidate);
				await assertCleanWorktree(managed.worktree, managed.localRef, canonicalCommit);
				if ((await currentCommit(managed.worktree, "Published candidate HEAD")) !== publishCandidate.forkCommit) {
					throw new AutoBotReleaseError("Publisher changed the committed candidate source");
				}
				state = await transition(
					config.workRoot,
					state,
					published.kind === "published" ? "published" : "unchanged",
					{
						candidateCommit: publishCandidate.forkCommit,
						candidateMergeCommit: publishCandidateMerge,
						integrationRemoteCommit: expectedIntegrationCommit,
						publishedForkCommit: publishCandidate.forkCommit,
						buildFailure: undefined,
					},
				);
				return;
			} catch (error) {
				if (!(error instanceof LocalBuildFailure)) throw error;
				const fingerprint = buildFailureFingerprint(publishCandidate);
				const previousAttempts = state.buildFailure?.fingerprint === fingerprint ? state.buildFailure.attempts : 0;
				if (previousAttempts >= config.maxOmpAttempts || ompAttempts.value >= config.maxOmpAttempts) {
					throw new AutoBotReleaseError(
						"Configured OMP attempt limit reached for unchanged candidate build failure",
					);
				}
				state = await transition(config.workRoot, state, "repairing-build", {
					buildFailure: { fingerprint, attempts: previousAttempts + 1 },
				});
				ompAttempts.value++;
				const repairBase = publishCandidate.forkCommit;
				await invokeOmpGuarded(
					{
						config,
						worktree: managed.worktree,
						localRef: managed.localRef,
						canonicalRepository,
						canonicalRef,
						expectedCanonicalCommit: canonicalCommit,
						expectedUpstreamCommit: upstreamCommit,
						expectedIntegrationCommit: expectedIntegrationCommit,
					},
					"build-failure",
					publishCandidate.sensitivePaths,
					error.diagnostics,
				);
				const repairedHead = await commitPendingChanges(
					managed.worktree,
					managed.localRef,
					repairBase,
					`chore(autobot): repair candidate ${upstreamCommit.slice(0, 12)}`,
				);
				if (repairedHead === repairBase) {
					throw new AutoBotReleaseError("OMP returned without changing the failed candidate");
				}
				if (!(await isAncestor(managed.worktree, repairBase, repairedHead))) {
					throw new AutoBotReleaseError("OMP repair did not preserve the failed candidate ancestry");
				}
				await assertCleanWorktree(managed.worktree, managed.localRef, canonicalCommit);
				const repairedMerge = await latestCandidateMerge(managed.worktree, repairedHead);
				if (!repairedMerge || repairedMerge.upstreamCommit !== upstreamCommit) {
					throw new AutoBotReleaseError("OMP repair removed the required candidate merge ancestry");
				}
				let identity = await candidateReleaseIdentity(managed.worktree, canonicalCommit, repairedHead);
				publishCandidate = candidateFromIdentity(
					managed.worktree,
					repairedHead,
					upstreamCommit,
					upstreamVersion,
					identity,
					true,
				);
				publishCandidateMerge = repairedMerge.commit;
				const repairReviewKey = await compatibilityFingerprint(publishCandidate, canonicalCommit);
				if (
					publishCandidate.sensitivePaths.length > 0 &&
					state.compatibilityReviewFingerprint !== repairReviewKey
				) {
					if (ompAttempts.value >= config.maxOmpAttempts) {
						throw new AutoBotReleaseError(
							"Configured OMP attempt limit reached for compatibility review after build repair",
						);
					}
					state = await transition(config.workRoot, state, "reviewing-compatibility", {
						candidateCommit: publishCandidate.forkCommit,
						candidateMergeCommit: publishCandidateMerge,
					});
					ompAttempts.value++;
					const beforeReview = publishCandidate.forkCommit;
					await invokeOmpGuarded(
						{
							config,
							worktree: managed.worktree,
							localRef: managed.localRef,
							canonicalRepository,
							canonicalRef,
							expectedCanonicalCommit: canonicalCommit,
							expectedUpstreamCommit: upstreamCommit,
							expectedIntegrationCommit: expectedIntegrationCommit,
						},
						"compatibility",
						publishCandidate.sensitivePaths,
						undefined,
					);
					const reviewedHead = await commitPendingChanges(
						managed.worktree,
						managed.localRef,
						beforeReview,
						`chore(autobot): compatibility review ${upstreamCommit.slice(0, 12)}`,
					);
					if (!(await isAncestor(managed.worktree, beforeReview, reviewedHead))) {
						throw new AutoBotReleaseError(
							"OMP compatibility work did not preserve the repaired candidate ancestry",
						);
					}
					await assertCleanWorktree(managed.worktree, managed.localRef, canonicalCommit);
					const reviewedMerge = await latestCandidateMerge(managed.worktree, reviewedHead);
					if (!reviewedMerge || reviewedMerge.upstreamCommit !== upstreamCommit) {
						throw new AutoBotReleaseError("OMP compatibility work removed the required candidate merge ancestry");
					}
					identity = await candidateReleaseIdentity(managed.worktree, canonicalCommit, reviewedHead);
					publishCandidate = candidateFromIdentity(
						managed.worktree,
						reviewedHead,
						upstreamCommit,
						upstreamVersion,
						identity,
						true,
					);
					publishCandidateMerge = reviewedMerge.commit;
					const reviewedFingerprint = await compatibilityFingerprint(publishCandidate, canonicalCommit);
					state = await transition(config.workRoot, state, "building", {
						candidateCommit: publishCandidate.forkCommit,
						candidateMergeCommit: publishCandidateMerge,
						compatibilityReviewFingerprint: reviewedFingerprint,
					});
				}
				state = await transition(config.workRoot, state, "synchronizing", {
					candidateCommit: publishCandidate.forkCommit,
					candidateMergeCommit: publishCandidateMerge,
					pendingIntegrationCommit: publishCandidate.forkCommit,
				});
				expectedIntegrationCommit = await pushIntegrationBranch(
					{
						config,
						worktree: managed.worktree,
						localRef: managed.localRef,
						canonicalRepository,
						canonicalRef,
						expectedCanonicalCommit: canonicalCommit,
						expectedUpstreamCommit: upstreamCommit,
						expectedIntegrationCommit: expectedIntegrationCommit,
					},
					publishCandidate.forkCommit,
				);
				state = await transition(config.workRoot, state, "building", {
					candidateCommit: publishCandidate.forkCommit,
					candidateMergeCommit: publishCandidateMerge,
					integrationRemoteCommit: expectedIntegrationCommit,
					pendingIntegrationCommit: undefined,
				});
			}
		}
	} catch (error) {
		await writeLocalState(config.workRoot, { ...state, phase: "blocked" }).catch(() => {});
		throw error;
	}
}

if (import.meta.main) {
	try {
		const args = parseCliArgs(process.argv.slice(2));
		assertKnownOptions(args, ["config"]);
		await runLocalAutomation(requiredOption(args, "config"));
	} catch {
		// Launcher output is intentionally limited to its exit status. Do not log
		// configuration, prompt, model, or subprocess output from this controller.
		console.error("AutoBot local run failed.");
		process.exitCode = 1;
	}
}
