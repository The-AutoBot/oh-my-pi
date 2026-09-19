import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
} from "../packages/coding-agent/src/autobot-update/contract.ts";
import { isRecord } from "../packages/utils/src/type-guards.ts";
import {
	AutoBotReleaseError,
	hashFile,
	loadTrustedKeys,
	parseAssetIndex,
	readJson,
	readVerifiedEnvelope,
	requireCommit,
	requirePositiveSafeInteger,
	requireRegularFile,
	requireString,
	writeJsonAtomic,
	verifyIndexedAssets,
	type AssetIndex,
	type AssetInput,
	type TrustedKeySet,
	type VerifiedReleaseEnvelope,
} from "./autobot-release-common.ts";
import {
	COORDINATOR_CLIENT_FILENAME,
	parseCoordinatorClientProvenance,
	type CoordinatorClientProvenance,
} from "./autobot-release-coordinator.ts";
import { assertCompleteAutoBotReleaseTopology } from "./autobot-release-topology.ts";
import { createManagedBundle, deriveManagedBundleId } from "./autobot-release-web.ts";
import type { LocalAutomationConfig, LocalCandidate } from "./autobot-local-types.ts";

const RELEASE_REPOSITORY = "The-AutoBot/oh-my-pi";
const RELEASE_TARGET = "win32-x64";
const RELEASE_TAG_PREFIX = "autobot-r";
const MAX_RELEASE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_RELATIVE_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UPSTREAM_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const RELEASE_METADATA_FILES = [
	"manifest.json",
	"asset-index.json",
	"provenance.json",
	"coordinator-source.json",
	"signed-envelope.json",
] as const;

/** A failure in a candidate build or focused candidate check that may be repaired in the isolated candidate worktree. */
export class LocalBuildFailure extends Error {
	public readonly diagnostics: string;

	public constructor(diagnostics: string, options?: ErrorOptions) {
		super(`Local candidate build/check failed: ${diagnostics}`, options);
		this.name = "LocalBuildFailure";
		this.diagnostics = diagnostics;
	}
}
class CommandExitError extends AutoBotReleaseError {}

interface CommandOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
}

interface CandidateReleasePlan {
	readonly forkCommit: string;
	readonly upstreamCommit: string;
	readonly upstreamVersion: string;
	readonly compatibilityEpoch: number;
}

interface GitHubRelease {
	readonly sequence: number;
	readonly tag: string;
	readonly draft: boolean;
	readonly targetCommit: string;
}

interface ChannelEnvelope {
	readonly path: string;
	readonly verified: VerifiedReleaseEnvelope;
}

interface ReleaseChain {
	readonly sequence: number;
	readonly tag: string;
	readonly previous?: ChannelEnvelope;
	readonly previousRelease?: GitHubRelease;
}

interface ReleaseBuildIdentity {
	readonly schemaVersion: number;
	readonly releaseSequence: number;
	readonly upstreamVersion: string;
	readonly forkCommit: string;
	readonly upstreamCommit: string;
	readonly sessionFormatVersion: number;
	readonly collabProtocolVersion: number;
	readonly compatibilityEpoch: number;
}

interface CandidateAssets {
	readonly runtime: string;
	readonly bootstrap: string;
	readonly webArchive: string;
	readonly webBundleId: string;
}

interface CoordinatorAsset {
	readonly artifact: string;
	readonly provenance: string;
	readonly provenanceSha256: string;
}

interface AssembledBundle {
	readonly root: string;
	readonly signedEnvelope: string;
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requireAbsolutePath(value: string, label: string): string {
	if (!path.isAbsolute(value)) throw new AutoBotReleaseError(`${label} must be an absolute path`);
	return path.resolve(value);
}

function requireSafeBranch(value: string, label: string): string {
	if (!SAFE_BRANCH.test(value) || value.includes("..") || value.endsWith("/") || value.includes("//")) {
		throw new AutoBotReleaseError(`${label} must be a safe explicit branch name`);
	}
	return value;
}

function requireSafeRepository(value: string, label: string): string {
	if (!SAFE_REPOSITORY.test(value)) throw new AutoBotReleaseError(`${label} must be an owner/repository identifier`);
	return value;
}

function requireSafeRelativePath(value: string, label: string): string {
	if (!SAFE_RELATIVE_PATH.test(value))
		throw new AutoBotReleaseError(`${label} must be a safe slash-separated relative path`);
	return value;
}

function requireUpstreamVersion(value: string, label: string): string {
	if (!UPSTREAM_VERSION.test(value)) throw new AutoBotReleaseError(`${label} is not a valid release version`);
	return value;
}

function requireReleaseTag(sequence: number): string {
	if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_RELEASE_SEQUENCE) {
		throw new AutoBotReleaseError("Release sequence must be a positive safe integer");
	}
	return `${RELEASE_TAG_PREFIX}${sequence}`;
}

function requireReleaseSequenceTag(value: unknown): { readonly sequence: number; readonly tag: string } | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^autobot-r([1-9][0-9]*)$/.exec(value);
	if (!match) return undefined;
	const sequence = Number(match[1]);
	if (!Number.isSafeInteger(sequence) || sequence < 1) {
		throw new AutoBotReleaseError("Existing AutoBot release tag has an unsafe sequence");
	}
	return { sequence, tag: value };
}

async function requireDirectory(pathname: string, label: string): Promise<string> {
	const absolute = requireAbsolutePath(pathname, label);
	let resolved: string;
	try {
		resolved = await fs.realpath(absolute);
	} catch (error) {
		throw new AutoBotReleaseError(`${label} does not exist`, { cause: error });
	}
	const stat = await fs.stat(resolved).catch(error => {
		throw new AutoBotReleaseError(`${label} cannot be inspected`, { cause: error });
	});
	if (!stat.isDirectory()) throw new AutoBotReleaseError(`${label} must be a directory`);
	return resolved;
}

async function requireConfiguredFile(pathname: string, label: string): Promise<string> {
	const absolute = requireAbsolutePath(pathname, label);
	await requireRegularFile(absolute, label);
	return absolute;
}

async function runQuiet(label: string, argv: readonly string[], options: CommandOptions = {}): Promise<void> {
	let child: Bun.Subprocess<"ignore", "ignore", "ignore">;
	try {
		child = Bun.spawn([...argv], {
			cwd: options.cwd,
			env: options.env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	} catch (error) {
		throw new AutoBotReleaseError(`${label} could not start`, { cause: error });
	}
	if ((await child.exited) !== 0) throw new CommandExitError(`${label} failed`);
}

async function runText(label: string, argv: readonly string[], options: CommandOptions = {}): Promise<string> {
	let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
	try {
		child = Bun.spawn([...argv], {
			cwd: options.cwd,
			env: options.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
	} catch (error) {
		throw new AutoBotReleaseError(`${label} could not start`, { cause: error });
	}
	const stdoutStream = child.stdout;
	if (typeof stdoutStream === "number" || stdoutStream === undefined || stdoutStream === null) {
		throw new AutoBotReleaseError(`${label} did not expose captured standard output`);
	}
	const output = new Response(stdoutStream).text();
	const [stdout, exitCode] = await Promise.all([output, child.exited]);
	if (exitCode !== 0) throw new CommandExitError(`${label} failed`);
	return stdout;
}

async function runExitCode(argv: readonly string[], options: CommandOptions = {}): Promise<number> {
	let child: Bun.Subprocess<"ignore", "ignore", "ignore">;
	try {
		child = Bun.spawn([...argv], {
			cwd: options.cwd,
			env: options.env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	} catch (error) {
		throw new AutoBotReleaseError("Required Git command could not start", { cause: error });
	}
	return child.exited;
}

async function gitText(sourceRoot: string, label: string, args: readonly string[]): Promise<string> {
	return (await runText(label, ["git", ...args], { cwd: sourceRoot })).trim();
}
async function assertOperatorGitCommitIdentity(cwd: string): Promise<void> {
	let identity: string;
	try {
		identity = (await runText("Local Git author identity check", ["git", "var", "GIT_AUTHOR_IDENT"], { cwd })).trim();
	} catch (error) {
		if (error instanceof CommandExitError) {
			throw new AutoBotReleaseError("Local Git author identity must be configured before publication");
		}
		throw error;
	}
	if (!identity) throw new AutoBotReleaseError("Local Git author identity must be configured before publication");
}

async function assertCleanCommittedCheckout(
	sourceRoot: string,
	label: string,
	expectedCommit?: string,
): Promise<string> {
	const status = await gitText(sourceRoot, `${label} status check`, [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	]);
	if (status !== "") throw new AutoBotReleaseError(`${label} must be a clean committed checkout`);
	const commit = requireCommit(
		await gitText(sourceRoot, `${label} commit check`, ["rev-parse", "--verify", "HEAD^{commit}"]),
		`${label} commit`,
	);
	if (expectedCommit !== undefined && commit !== expectedCommit) {
		throw new AutoBotReleaseError(`${label} HEAD does not match the configured candidate commit`);
	}
	return commit;
}

async function assertExactBun(executable: string, expectedVersion: string, label: string): Promise<void> {
	const actualVersion = (await runText(`${label} version check`, [executable, "--version"])).trim();
	if (actualVersion !== expectedVersion)
		throw new AutoBotReleaseError(`${label} does not match its configured exact version`);
}

function commandEnvironment(config: LocalAutomationConfig): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${path.dirname(config.runnerBun)}${path.delimiter}${process.env.PATH ?? ""}`,
	};
	delete environment.BUN_COMPILE_EXECUTABLE_PATH;
	delete environment.AUTOBOT_COMPILER_BUN;
	return environment;
}

function requirePublisherConfiguration(config: LocalAutomationConfig): void {
	if (config.schemaVersion !== 1) throw new AutoBotReleaseError("Local automation config schemaVersion must be 1");
	if (config.repository !== RELEASE_REPOSITORY) {
		throw new AutoBotReleaseError(`Local publisher is restricted to ${RELEASE_REPOSITORY}`);
	}
	const canonicalBranch = requireSafeBranch(config.canonicalBranch, "Canonical branch");
	const integrationBranch = requireSafeBranch(config.integrationBranch, "Integration branch");
	if (canonicalBranch === integrationBranch) {
		throw new AutoBotReleaseError("Integration branch must be distinct from the protected canonical branch");
	}
	requireSafeRepository(config.repository, "Release repository");
	requireSafeRepository(config.channelRepository, "Channel repository");
	const channelBranch = requireSafeBranch(config.channelBranch, "Channel branch");
	if (
		config.channelRepository.toLowerCase() === config.repository.toLowerCase() &&
		(channelBranch.toLowerCase() === canonicalBranch.toLowerCase() ||
			channelBranch.toLowerCase() === integrationBranch.toLowerCase())
	) {
		throw new AutoBotReleaseError("Signed channel must not be pushed to a protected or integration source branch");
	}
	requireSafeRelativePath(config.channelPath, "Channel path");
	for (const [value, label] of [
		[config.workRoot, "Work root"],
		[config.runnerBun, "Runner Bun"],
		[config.compilerBun, "Compiler Bun"],
		[config.coordinatorRoot, "Coordinator root"],
		[config.privateKeyPath, "Private signing key"],
		[config.publicKeyPath, "Public signing key"],
	] as const) {
		requireAbsolutePath(value, label);
	}
	if (typeof config.allowInitial !== "boolean") throw new AutoBotReleaseError("allowInitial must be boolean");
}

function requireCandidate(candidate: LocalCandidate): void {
	requireAbsolutePath(candidate.sourceRoot, "Candidate source root");
	requireCommit(candidate.forkCommit, "Candidate fork commit");
	requireCommit(candidate.upstreamCommit, "Candidate upstream commit");
	requireUpstreamVersion(candidate.upstreamVersion, "Candidate upstream version");
	requirePositiveSafeInteger(candidate.compatibilityEpoch, "Candidate compatibility epoch");
	if (typeof candidate.changed !== "boolean") throw new AutoBotReleaseError("Candidate changed must be boolean");
	if (
		!Array.isArray(candidate.sensitivePaths) ||
		!candidate.sensitivePaths.every(value => typeof value === "string")
	) {
		throw new AutoBotReleaseError("Candidate sensitive paths must be a string array");
	}
}

async function candidateBuildStage<T>(diagnostics: string, action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof LocalBuildFailure) throw error;
		if (error instanceof CommandExitError) throw new LocalBuildFailure(diagnostics, { cause: error });
		throw error;
	}
}

async function readCandidateReleasePlan(
	config: LocalAutomationConfig,
	sourceRoot: string,
	stageRoot: string,
	environment: NodeJS.ProcessEnv,
): Promise<CandidateReleasePlan> {
	const output = path.join(stageRoot, "release-plan.json");
	const publisherRoot = path.resolve(import.meta.dir, "..");
	await runQuiet(
		"Release plan",
		[
			config.runnerBun,
			path.join(publisherRoot, "scripts", "autobot-release-plan.ts"),
			"--source-root",
			sourceRoot,
			"--out",
			output,
		],
		{ cwd: publisherRoot, env: environment },
	);
	const value = await readJson(output, "local release plan");
	if (!isRecord(value) || value.ready !== true) {
		throw new AutoBotReleaseError("Candidate does not retain a release-eligible AutoBot merge");
	}
	return {
		forkCommit: requireCommit(requireString(value.forkCommit, "Release plan forkCommit"), "Release plan fork commit"),
		upstreamCommit: requireCommit(
			requireString(value.upstreamCommit, "Release plan upstreamCommit"),
			"Release plan upstream commit",
		),
		upstreamVersion: requireUpstreamVersion(
			requireString(value.upstreamVersion, "Release plan upstreamVersion"),
			"Release plan upstream version",
		),
		compatibilityEpoch: requirePositiveSafeInteger(value.compatibilityEpoch, "Release plan compatibility epoch"),
	};
}

function assertPlanMatchesCandidate(plan: CandidateReleasePlan, candidate: LocalCandidate): void {
	if (
		plan.forkCommit !== candidate.forkCommit ||
		plan.upstreamCommit !== candidate.upstreamCommit ||
		plan.upstreamVersion !== candidate.upstreamVersion ||
		plan.compatibilityEpoch !== candidate.compatibilityEpoch
	) {
		throw new AutoBotReleaseError("Release plan does not match the committed local candidate identity");
	}
	if (plan.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH) {
		throw new AutoBotReleaseError("Candidate compatibility epoch does not match the trusted local producer contract");
	}
}
function isPublishedCandidate(manifest: VerifiedReleaseEnvelope["manifest"], candidate: LocalCandidate): boolean {
	return (
		manifest.schemaVersion === AUTO_BOT_RELEASE_SCHEMA_VERSION &&
		manifest.forkCommit === candidate.forkCommit &&
		manifest.upstreamCommit === candidate.upstreamCommit &&
		manifest.upstreamVersion === candidate.upstreamVersion &&
		manifest.sessionFormatVersion === AUTO_BOT_SESSION_FORMAT_VERSION &&
		manifest.collabProtocolVersion === AUTO_BOT_COLLAB_PROTOCOL_VERSION &&
		manifest.compatibilityEpoch === AUTO_BOT_COMPATIBILITY_EPOCH &&
		manifest.compatibilityEpoch === candidate.compatibilityEpoch
	);
}

async function listGitHubReleases(repository: string): Promise<readonly GitHubRelease[]> {
	const output = await runText("GitHub release listing", [
		"gh",
		"api",
		"--paginate",
		"--slurp",
		`repos/${repository}/releases?per_page=100`,
	]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch (error) {
		throw new AutoBotReleaseError("GitHub release listing is not valid JSON", { cause: error });
	}
	const rows = Array.isArray(parsed)
		? parsed.flatMap(page => (Array.isArray(page) ? page : [page]))
		: (() => {
				throw new AutoBotReleaseError("GitHub release listing must be an array");
			})();
	const releases: GitHubRelease[] = [];
	const seenSequences = new Set<number>();
	for (const row of rows) {
		if (!isRecord(row)) throw new AutoBotReleaseError("GitHub release listing contains an invalid entry");
		const parsedTag = requireReleaseSequenceTag(row.tag_name);
		if (!parsedTag) continue;
		if (typeof row.draft !== "boolean") throw new AutoBotReleaseError("AutoBot release draft state is invalid");
		const targetCommit = requireCommit(
			requireString(row.target_commitish, `AutoBot release ${parsedTag.tag} target commit`),
			`AutoBot release ${parsedTag.tag} target commit`,
		);
		if (seenSequences.has(parsedTag.sequence))
			throw new AutoBotReleaseError("GitHub has duplicate AutoBot release sequences");
		seenSequences.add(parsedTag.sequence);
		releases.push({ ...parsedTag, draft: row.draft, targetCommit });
	}
	return releases.sort((left, right) => left.sequence - right.sequence);
}

function parseIncludedGitHubResponse(output: string): { readonly status: number; readonly body: string } {
	const statuses = [...output.matchAll(/(?:^|\n)HTTP\/[^\s]+\s+([0-9]{3})\b/gm)];
	const last = statuses.at(-1);
	if (!last || last.index === undefined) throw new AutoBotReleaseError("GitHub API did not return an HTTP response");
	const status = Number(last[1]);
	const responseStart = last.index + (last[0].startsWith("\n") ? 1 : 0);
	const crlfBoundary = output.indexOf("\r\n\r\n", responseStart);
	const lfBoundary = output.indexOf("\n\n", responseStart);
	const boundary =
		crlfBoundary === -1 ? lfBoundary : lfBoundary === -1 ? crlfBoundary : Math.min(crlfBoundary, lfBoundary);
	if (boundary === -1) throw new AutoBotReleaseError("GitHub API response has no body boundary");
	const boundaryLength = output.startsWith("\r\n\r\n", boundary) ? 4 : 2;
	return { status, body: output.slice(boundary + boundaryLength) };
}

async function readIncludedGitHubApi(
	label: string,
	endpoint: string,
): Promise<{ readonly status: number; readonly body: string; readonly exitCode: number }> {
	let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
	try {
		child = Bun.spawn(["gh", "api", "--include", endpoint], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
	} catch (error) {
		throw new AutoBotReleaseError(`${label} could not start`, { cause: error });
	}
	const stdoutStream = child.stdout;
	if (typeof stdoutStream === "number" || stdoutStream === undefined || stdoutStream === null) {
		throw new AutoBotReleaseError(`${label} did not expose its response body`);
	}
	const output = new Response(stdoutStream).text();
	const [response, exitCode] = await Promise.all([output, child.exited]);
	return { ...parseIncludedGitHubResponse(response), exitCode };
}

async function assertChannelRepositoryAndBranch(config: LocalAutomationConfig): Promise<void> {
	const repository = await readIncludedGitHubApi(
		"Signed channel repository lookup",
		`repos/${config.channelRepository}`,
	);
	if (repository.status !== 200 || repository.exitCode !== 0) {
		throw new AutoBotReleaseError("Signed channel repository is not accessible");
	}
	const branch = await readIncludedGitHubApi(
		"Signed channel branch lookup",
		`repos/${config.channelRepository}/branches/${encodeURIComponent(config.channelBranch)}`,
	);
	if (branch.status !== 200 || branch.exitCode !== 0) {
		throw new AutoBotReleaseError("Signed channel branch is not accessible");
	}
}

async function readChannelEnvelope(
	config: LocalAutomationConfig,
	trusted: TrustedKeySet,
	destination: string,
): Promise<ChannelEnvelope | undefined> {
	const endpoint = `repos/${config.channelRepository}/contents/${config.channelPath}?ref=${encodeURIComponent(config.channelBranch)}`;
	const included = await readIncludedGitHubApi("Signed channel lookup", endpoint);
	if (included.status === 404) {
		await assertChannelRepositoryAndBranch(config);
		return undefined;
	}
	if (included.status !== 200 || included.exitCode !== 0) {
		throw new AutoBotReleaseError("Signed channel lookup failed without a confirmed absence");
	}
	let document: unknown;
	try {
		document = JSON.parse(included.body);
	} catch (error) {
		throw new AutoBotReleaseError("Signed channel content response is not valid JSON", { cause: error });
	}
	if (!isRecord(document) || document.encoding !== "base64" || typeof document.content !== "string") {
		throw new AutoBotReleaseError("Signed channel content response is malformed");
	}
	const bytes = Buffer.from(document.content.replace(/\s/g, ""), "base64");
	if (bytes.byteLength === 0) throw new AutoBotReleaseError("Signed channel envelope is empty");
	await Bun.write(destination, bytes);
	const verified = await readVerifiedEnvelope(destination, trusted);
	return { path: destination, verified };
}

async function establishReleaseChain(
	config: LocalAutomationConfig,
	stageRoot: string,
	trusted: TrustedKeySet,
): Promise<ReleaseChain> {
	const releases = await listGitHubReleases(config.repository);
	if (releases.some(release => release.draft)) {
		throw new AutoBotReleaseError(
			"An existing draft AutoBot release must be resolved before another local publication",
		);
	}
	const channel = await readChannelEnvelope(config, trusted, path.join(stageRoot, "previous-channel-envelope.json"));
	if (!channel) {
		if (!config.allowInitial) {
			throw new AutoBotReleaseError(
				"A verified prior channel envelope is required unless initial publication is explicitly enabled",
			);
		}
		if (releases.length !== 0) {
			throw new AutoBotReleaseError(
				"The signed channel is absent despite existing AutoBot releases; initial publication is not genuine",
			);
		}
		return { sequence: 1, tag: requireReleaseTag(1) };
	}
	if (releases.length === 0) {
		throw new AutoBotReleaseError(
			"The signed channel has a predecessor but GitHub has no corresponding AutoBot release",
		);
	}
	const latest = releases.at(-1)!;
	const previousSequence = channel.verified.manifest.releaseSequence;
	if (latest.sequence !== previousSequence) {
		throw new AutoBotReleaseError("Signed channel predecessor does not match the latest published AutoBot release");
	}
	if (latest.targetCommit !== channel.verified.manifest.forkCommit) {
		throw new AutoBotReleaseError(
			"Latest published AutoBot release target does not match the signed channel predecessor",
		);
	}
	if (latest.sequence >= MAX_RELEASE_SEQUENCE)
		throw new AutoBotReleaseError("AutoBot release sequence exceeds JavaScript safe integer range");
	const sequence = latest.sequence + 1;
	return { sequence, tag: requireReleaseTag(sequence), previous: channel, previousRelease: latest };
}

function githubRepositoryUrl(repository: string): string {
	return `https://github.com/${repository}.git`;
}

async function assertIntegrationRef(
	config: LocalAutomationConfig,
	candidate: LocalCandidate,
	sourceRoot: string,
): Promise<string> {
	const branchRef = `refs/heads/${config.integrationBranch}`;
	const remote = await runText("Integration branch lookup", [
		"git",
		"ls-remote",
		"--refs",
		githubRepositoryUrl(config.repository),
		branchRef,
	]);
	const matches = remote
		.split("\n")
		.map(line => line.trim().split(/\s+/, 2))
		.filter(parts => parts.length === 2 && parts[1] === branchRef);
	if (matches.length !== 1)
		throw new AutoBotReleaseError("Configured integration branch did not resolve exactly once");
	const commit = requireCommit(matches[0]?.[0] ?? "", "Integration branch commit");
	if (commit !== candidate.forkCommit) {
		throw new AutoBotReleaseError("Configured integration branch does not point at the committed candidate");
	}
	const localRef = `refs/remotes/autobot-local-publisher/${config.integrationBranch}`;
	await runQuiet(
		"Integration branch fetch",
		["git", "fetch", "--no-tags", githubRepositoryUrl(config.repository), `${branchRef}:${localRef}`],
		{ cwd: sourceRoot },
	);
	const fetched = requireCommit(
		await gitText(sourceRoot, "Fetched integration branch check", ["rev-parse", "--verify", `${localRef}^{commit}`]),
		"Fetched integration branch commit",
	);
	if (fetched !== candidate.forkCommit)
		throw new AutoBotReleaseError("Fetched integration branch changed during local publication");
	return localRef;
}

async function fetchAndAssertReleaseTag(
	config: LocalAutomationConfig,
	sourceRoot: string,
	tag: string,
	forkCommit: string,
): Promise<void> {
	await runQuiet(
		"Release tag fetch",
		["git", "fetch", "--no-tags", githubRepositoryUrl(config.repository), `refs/tags/${tag}:refs/tags/${tag}`],
		{ cwd: sourceRoot },
	);
	const taggedCommit = requireCommit(
		await gitText(sourceRoot, "Release tag check", ["rev-parse", "--verify", `${tag}^{commit}`]),
		"Release tag commit",
	);
	if (taggedCommit !== forkCommit)
		throw new AutoBotReleaseError("GitHub release tag does not resolve to the signed fork commit");
}

function expectedDownloadedFilenames(assetIndex: AssetIndex): readonly string[] {
	const names = new Set<string>(RELEASE_METADATA_FILES);
	for (const asset of assetIndex.assets) {
		const filename = path.basename(asset.file);
		if (asset.file !== `assets/${filename}` || !filename) {
			throw new AutoBotReleaseError("Published asset index does not use the owned flat assets directory");
		}
		if (names.has(filename)) throw new AutoBotReleaseError("Published release asset collides with release metadata");
		names.add(filename);
	}
	return [...names].sort((left, right) => left.localeCompare(right));
}

async function assertDownloadedFileSet(downloaded: string, expectedNames: readonly string[]): Promise<void> {
	const entries = await fs.readdir(downloaded, { withFileTypes: true });
	const actualNames = entries.map(entry => entry.name).sort((left, right) => left.localeCompare(right));
	if (
		actualNames.length !== expectedNames.length ||
		actualNames.some((name, index) => name !== expectedNames[index]) ||
		entries.some(entry => !entry.isFile() || entry.isSymbolicLink())
	) {
		throw new AutoBotReleaseError(
			"Downloaded GitHub release does not contain exactly the expected payloads and metadata",
		);
	}
}

async function compareExactBytes(left: string, right: string, label: string): Promise<void> {
	const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)]);
	if (leftHash.size !== rightHash.size || leftHash.sha256 !== rightHash.sha256) {
		throw new AutoBotReleaseError(`${label} differs from the locally verified bytes`);
	}
}

async function prepareDownloadedBundle(
	downloaded: string,
	localBundle: string | undefined,
	expectedEnvelope: string | undefined,
	assertCurrentTopology: boolean,
): Promise<void> {
	for (const file of RELEASE_METADATA_FILES)
		await requireRegularFile(path.join(downloaded, file), `Downloaded ${file}`);
	const index = parseAssetIndex(await readJson(path.join(downloaded, "asset-index.json"), "downloaded asset index"));
	if (assertCurrentTopology) assertCompleteAutoBotReleaseTopology(index.assets);
	const expectedNames = expectedDownloadedFilenames(index);
	await assertDownloadedFileSet(downloaded, expectedNames);
	if (localBundle) {
		for (const metadata of RELEASE_METADATA_FILES) {
			await compareExactBytes(
				path.join(localBundle, metadata),
				path.join(downloaded, metadata),
				`Downloaded ${metadata}`,
			);
		}
		for (const asset of index.assets) {
			const filename = path.basename(asset.file);
			await compareExactBytes(
				path.join(localBundle, asset.file),
				path.join(downloaded, filename),
				`Downloaded ${filename}`,
			);
		}
	}
	if (expectedEnvelope) {
		await compareExactBytes(
			expectedEnvelope,
			path.join(downloaded, "signed-envelope.json"),
			"Downloaded signed envelope",
		);
	}
	await fs.mkdir(path.join(downloaded, "assets"));
	for (const asset of index.assets) {
		const filename = path.basename(asset.file);
		await fs.rename(path.join(downloaded, filename), path.join(downloaded, asset.file));
	}
}

async function verifyPublishedRelease(
	config: LocalAutomationConfig,
	candidate: LocalCandidate,
	tag: string,
	stageRoot: string,
	environment: NodeJS.ProcessEnv,
	options: {
		readonly localBundle?: string;
		readonly expectedEnvelope?: string;
		readonly previousEnvelope?: string;
		readonly canonicalRef?: string;
		readonly historicalPredecessor?: boolean;
	},
): Promise<void> {
	if (options.historicalPredecessor && !options.expectedEnvelope) {
		throw new AutoBotReleaseError("Historical predecessor verification requires the exact signed channel envelope");
	}
	const downloaded = await fs.mkdtemp(path.join(stageRoot, "downloaded-release-"));
	await runQuiet("GitHub release download", [
		"gh",
		"release",
		"download",
		tag,
		"--repo",
		config.repository,
		"--dir",
		downloaded,
		"--pattern",
		"*",
	]);
	await prepareDownloadedBundle(
		downloaded,
		options.localBundle,
		options.expectedEnvelope,
		!options.historicalPredecessor,
	);
	const trusted = await loadTrustedKeys([`${config.keyId}=${config.publicKeyPath}`]);
	const verified = await readVerifiedEnvelope(path.join(downloaded, "signed-envelope.json"), trusted);
	await fetchAndAssertReleaseTag(config, candidate.sourceRoot, tag, verified.manifest.forkCommit);
	// A predecessor is authenticated by the exact signed channel envelope and
	// release tag binding; verify its downloaded payloads against that signed manifest,
	// but do not retroactively apply the current producer target policy.
	if (options.historicalPredecessor) {
		await verifyIndexedAssets(verified.manifest, path.join(downloaded, "asset-index.json"));
		return;
	}
	const publisherRoot = path.resolve(import.meta.dir, "..");
	const args = [
		config.runnerBun,
		path.join(publisherRoot, "scripts", "autobot-release-verify.ts"),
		"--envelope",
		path.join(downloaded, "signed-envelope.json"),
		"--asset-index",
		path.join(downloaded, "asset-index.json"),
		"--provenance",
		path.join(downloaded, "provenance.json"),
		"--coordinator-source",
		path.join(downloaded, "coordinator-source.json"),
		"--coordinator-source-sha256",
		(await hashFile(path.join(downloaded, "coordinator-source.json"))).sha256,
		"--trusted-key",
		`${config.keyId}=${config.publicKeyPath}`,
		"--source-root",
		candidate.sourceRoot,
		"--release-tag",
		tag,
	];
	if (options.previousEnvelope) args.push("--previous-envelope", options.previousEnvelope);
	if (options.canonicalRef) args.push("--canonical-ref", options.canonicalRef);
	await runQuiet("Downloaded release verification", args, { cwd: publisherRoot, env: environment });
}

async function buildWindowsBaselineAddon(
	config: LocalAutomationConfig,
	sourceRoot: string,
	environment: NodeJS.ProcessEnv,
): Promise<void> {
	const nativesRoot = path.join(sourceRoot, "packages", "natives");
	const nativeDirectory = path.join(nativesRoot, "native");
	const baseline = path.join(nativeDirectory, "pi_natives.win32-x64-baseline.node");
	const modern = path.join(nativeDirectory, "pi_natives.win32-x64-modern.node");
	// Removal makes the post-build canonical-name check evidence of this invocation,
	// rather than a stale zero-exit script or an earlier host build.
	await fs.rm(baseline, { force: true });
	await fs.rm(modern, { force: true });
	const buildEnvironment: NodeJS.ProcessEnv = {
		...environment,
		CARGO_TARGET_DIR: path.join(config.workRoot, "cargo-target"),
		OMP_NATIVE_CARGO_PROFILE: "ci",
		OMP_NATIVE_TARGET_VARIANT: "baseline",
	};
	delete buildEnvironment.RUSTFLAGS;
	delete buildEnvironment.CARGO_ENCODED_RUSTFLAGS;
	await candidateBuildStage("Windows x64 baseline native addon build failed", () =>
		runQuiet("Windows x64 baseline native addon build", [config.compilerBun, "scripts/build-bindings.ts"], {
			cwd: nativesRoot,
			env: buildEnvironment,
		}),
	);
	await candidateBuildStage("Windows x64 baseline native addon was not produced", async () => {
		await requireRegularFile(baseline, "Windows x64 baseline native addon");
		if (await Bun.file(modern).exists()) {
			throw new AutoBotReleaseError("Baseline native build unexpectedly produced a modern native addon");
		}
	});
}

async function buildCandidateAssets(
	config: LocalAutomationConfig,
	candidate: LocalCandidate,
	identity: ReleaseBuildIdentity,
	stageRoot: string,
	environment: NodeJS.ProcessEnv,
): Promise<CandidateAssets> {
	const sourceRoot = candidate.sourceRoot;
	const inputs = path.join(stageRoot, "release-inputs");
	await fs.mkdir(inputs);
	await runQuiet("Candidate dependency installation", [config.runnerBun, "install", "--frozen-lockfile"], {
		cwd: sourceRoot,
		env: environment,
	});
	await candidateBuildStage("Browser relay build failed", () =>
		runQuiet("Browser relay build", [config.runnerBun, "--cwd=packages/browser-relay", "run", "build"], {
			cwd: sourceRoot,
			env: environment,
		}),
	);
	await candidateBuildStage("Browser relay build did not produce its required embedded assets", async () => {
		await Promise.all([
			requireRegularFile(
				path.join(sourceRoot, "packages", "browser-relay", "dist", "omp-browser-relay-extension.zip"),
				"Browser relay extension archive",
			),
			requireRegularFile(
				path.join(
					sourceRoot,
					"packages",
					"coding-agent",
					"src",
					"tools",
					"browser",
					"relay",
					"extension-assets",
					"background.js.txt",
				),
				"Browser relay embedded background asset",
			),
		]);
	});
	await candidateBuildStage("Collab web build failed", () =>
		runQuiet("Collab web build", [config.runnerBun, "--cwd=packages/collab-web", "run", "build"], {
			cwd: sourceRoot,
			env: environment,
		}),
	);
	await buildWindowsBaselineAddon(config, sourceRoot, environment);
	const compilerEnvironment: NodeJS.ProcessEnv = {
		...environment,
		OMP_AUTOBOT_BUILD_IDENTITY: JSON.stringify(identity),
	};
	await candidateBuildStage("Windows x64 runtime compilation failed", () =>
		runQuiet(
			"Windows x64 runtime compilation",
			[config.compilerBun, "scripts/ci-release-build-binaries.ts", "--targets", RELEASE_TARGET],
			{ cwd: sourceRoot, env: compilerEnvironment },
		),
	);
	const builtRuntime = path.join(sourceRoot, "packages", "coding-agent", "binaries", "omp-windows-x64.exe");
	const runtime = path.join(inputs, "omp-win32-x64.exe");
	await candidateBuildStage("Windows x64 runtime output was not produced", async () => {
		await requireRegularFile(builtRuntime, "Windows x64 runtime");
		await fs.copyFile(builtRuntime, runtime, fsConstants.COPYFILE_EXCL);
	});
	const smokeRoot = await fs.mkdtemp(path.join(stageRoot, "runtime-smoke-"));
	const smokeEnvironment: NodeJS.ProcessEnv = {
		...environment,
		HOME: path.join(smokeRoot, "home"),
		USERPROFILE: path.join(smokeRoot, "home"),
		XDG_DATA_HOME: path.join(smokeRoot, "xdg"),
		APPDATA: path.join(smokeRoot, "appdata"),
		LOCALAPPDATA: path.join(smokeRoot, "localappdata"),
		PI_NATIVE_VARIANT: "baseline",
	};
	try {
		await candidateBuildStage("Windows x64 runtime --version check failed", () =>
			runQuiet("Windows x64 runtime version check", [runtime, "--version"], { env: smokeEnvironment }),
		);
		await candidateBuildStage("Windows x64 runtime fresh-home smoke test failed", () =>
			runQuiet("Windows x64 runtime smoke test", [runtime, "--smoke-test"], { env: smokeEnvironment }),
		);
		const reportedIdentity = await candidateBuildStage("Windows x64 runtime identity check failed", () =>
			runText("Windows x64 runtime identity check", [runtime, "--autobot-build-identity"], {
				env: smokeEnvironment,
			}),
		);
		let parsedIdentity: unknown;
		try {
			parsedIdentity = JSON.parse(reportedIdentity);
		} catch (error) {
			throw new LocalBuildFailure("Windows x64 runtime did not report valid build identity JSON", { cause: error });
		}
		if (
			!isRecord(parsedIdentity) ||
			Object.keys(parsedIdentity).length !== Object.keys(identity).length ||
			Object.entries(identity).some(([key, value]) => parsedIdentity[key] !== value)
		) {
			throw new LocalBuildFailure("Windows x64 runtime build identity does not match the signed candidate identity");
		}
	} finally {
		await fs.rm(smokeRoot, { recursive: true, force: true });
	}
	const bootstrap = path.join(inputs, "omp-bootstrap-win32-x64.exe");
	await candidateBuildStage("Windows x64 bootstrap compilation failed", () =>
		runQuiet(
			"Windows x64 bootstrap compilation",
			[config.runnerBun, "scripts/autobot-build-bootstrap.ts", "--target", RELEASE_TARGET, "--out", bootstrap],
			{
				cwd: sourceRoot,
				env: { ...environment, AUTOBOT_COMPILER_BUN: config.compilerBun },
			},
		),
	);
	await candidateBuildStage("Windows x64 bootstrap output was not produced", () =>
		requireRegularFile(bootstrap, "Windows x64 bootstrap"),
	);
	await candidateBuildStage("Focused coding-agent runtime checks failed", () =>
		runQuiet("Focused coding-agent runtime checks", [config.runnerBun, "run", "ci:test:coding-agent:runtime"], {
			cwd: sourceRoot,
			env: environment,
		}),
	);
	await candidateBuildStage("Focused collab web checks failed", () =>
		runQuiet("Focused collab web checks", [config.runnerBun, "--cwd=packages/collab-web", "test"], {
			cwd: sourceRoot,
			env: environment,
		}),
	);
	await candidateBuildStage("Focused release contract checks failed", () =>
		runQuiet(
			"Focused release contract checks",
			[config.runnerBun, "test", "scripts/autobot-release-security.test.ts"],
			{
				cwd: sourceRoot,
				env: environment,
			},
		),
	);
	await candidateBuildStage("Focused installer contract checks failed", () =>
		runQuiet("Focused installer contract checks", [config.runnerBun, "test", "scripts/autobot-install.test.ts"], {
			cwd: sourceRoot,
			env: environment,
		}),
	);
	const webBundleId = await candidateBuildStage("Collab web bundle identity derivation failed", () =>
		deriveManagedBundleId(
			path.join(sourceRoot, "packages", "collab-web", "dist"),
			path.join(sourceRoot, "packages", "collab-web", "public"),
		),
	);
	const webArchive = path.join(inputs, `omp-collab-web-${webBundleId}.tar.gz`);
	await candidateBuildStage("Collab web release packaging failed", () =>
		createManagedBundle({
			bundleId: webBundleId,
			forkCommit: candidate.forkCommit,
			upstreamCommit: candidate.upstreamCommit,
			upstreamVersion: candidate.upstreamVersion,
			dist: path.join(sourceRoot, "packages", "collab-web", "dist"),
			publicDirectory: path.join(sourceRoot, "packages", "collab-web", "public"),
			out: webArchive,
		}),
	);
	return { runtime, bootstrap, webArchive, webBundleId };
}

async function buildCoordinatorAsset(
	config: LocalAutomationConfig,
	candidate: LocalCandidate,
	stageRoot: string,
	environment: NodeJS.ProcessEnv,
): Promise<CoordinatorAsset> {
	const coordinatorRoot = await requireDirectory(config.coordinatorRoot, "Coordinator source root");
	if (isInside(candidate.sourceRoot, coordinatorRoot) || isInside(coordinatorRoot, candidate.sourceRoot)) {
		throw new AutoBotReleaseError("Coordinator source checkout must be distinct from the candidate checkout");
	}
	const coordinatorCommit = await assertCleanCommittedCheckout(coordinatorRoot, "Coordinator source");
	const repository = await gitText(coordinatorRoot, "Coordinator source origin check", [
		"remote",
		"get-url",
		"origin",
	]);
	let parsedRepository: URL;
	try {
		parsedRepository = new URL(repository);
	} catch (error) {
		throw new AutoBotReleaseError("Coordinator source origin must be an HTTPS repository URL", { cause: error });
	}
	if (
		parsedRepository.protocol !== "https:" ||
		!parsedRepository.hostname ||
		parsedRepository.username ||
		parsedRepository.password ||
		parsedRepository.search ||
		parsedRepository.hash
	) {
		throw new AutoBotReleaseError("Coordinator source origin must be a credential-free HTTPS repository URL");
	}
	const inputs = path.join(stageRoot, "release-inputs");
	const artifact = path.join(inputs, COORDINATOR_CLIENT_FILENAME);
	const coordinatorEnvironment: NodeJS.ProcessEnv = {
		...environment,
		OMP_AUTOBOT_SDK_ROOT: candidate.sourceRoot,
		OMP_AUTOBOT_SDK_COMMIT: candidate.forkCommit,
	};
	await runQuiet("Coordinator SDK preparation", [config.runnerBun, "run", "ci:prepare:autobot-sdk"], {
		cwd: coordinatorRoot,
		env: coordinatorEnvironment,
	});
	await runQuiet(
		"Coordinator extension build",
		[
			config.compilerBun,
			"build",
			"src/extension/index.ts",
			"--target=bun",
			"--format=esm",
			"--external=@oh-my-pi/pi-coding-agent",
			`--outfile=${artifact}`,
		],
		{ cwd: coordinatorRoot, env: coordinatorEnvironment },
	);
	await requireRegularFile(artifact, "Built coordinator extension");
	if (!(await Bun.file(artifact).text()).includes("import.meta.url")) {
		throw new AutoBotReleaseError(
			"Coordinator extension build did not preserve ESM import.meta module-origin semantics",
		);
	}
	await assertCleanCommittedCheckout(coordinatorRoot, "Coordinator source", coordinatorCommit);
	const artifactHash = await hashFile(artifact);
	const provenance: CoordinatorClientProvenance = parseCoordinatorClientProvenance({
		schemaVersion: 1,
		source: { repository, commit: coordinatorCommit },
		artifact: {
			filename: COORDINATOR_CLIENT_FILENAME,
			sha256: artifactHash.sha256,
			size: artifactHash.size,
		},
	});
	const provenancePath = path.join(stageRoot, "coordinator-source.json");
	await writeJsonAtomic(provenancePath, provenance);
	return { artifact, provenance: provenancePath, provenanceSha256: (await hashFile(provenancePath)).sha256 };
}

function releaseAssetUrl(repository: string, tag: string, filename: string): string {
	return `https://github.com/${repository}/releases/download/${tag}/${filename}`;
}

async function assembleBundle(
	config: LocalAutomationConfig,
	candidate: LocalCandidate,
	chain: ReleaseChain,
	assets: CandidateAssets,
	coordinator: CoordinatorAsset,
	stageRoot: string,
	environment: NodeJS.ProcessEnv,
): Promise<AssembledBundle> {
	const inputs: readonly AssetInput[] = [
		{
			kind: "runtime",
			target: RELEASE_TARGET,
			source: assets.runtime,
			url: releaseAssetUrl(config.repository, chain.tag, path.basename(assets.runtime)),
		},
		{
			kind: "bootstrap",
			target: RELEASE_TARGET,
			source: assets.bootstrap,
			url: releaseAssetUrl(config.repository, chain.tag, path.basename(assets.bootstrap)),
		},
		{
			kind: "coordinator-client",
			target: "universal",
			source: coordinator.artifact,
			url: releaseAssetUrl(config.repository, chain.tag, COORDINATOR_CLIENT_FILENAME),
		},
		{
			kind: "collab-web",
			target: "web",
			source: assets.webArchive,
			url: releaseAssetUrl(config.repository, chain.tag, path.basename(assets.webArchive)),
		},
	];
	assertCompleteAutoBotReleaseTopology(inputs);
	if (inputs.length !== 4) throw new AutoBotReleaseError("Windows-only release must have exactly four payload assets");
	const assetInputs = path.join(stageRoot, "asset-inputs.json");
	await writeJsonAtomic(assetInputs, inputs);
	const root = path.join(stageRoot, "bundle");
	const publisherRoot = path.resolve(import.meta.dir, "..");
	await runQuiet(
		"Release assembly",
		[
			config.runnerBun,
			path.join(publisherRoot, "scripts", "autobot-release-assemble.ts"),
			"--out",
			root,
			"--assets",
			assetInputs,
			"--release-sequence",
			String(chain.sequence),
			"--upstream-version",
			candidate.upstreamVersion,
			"--fork-commit",
			candidate.forkCommit,
			"--upstream-commit",
			candidate.upstreamCommit,
			"--web-bundle-id",
			assets.webBundleId,
			"--coordinator-source",
			coordinator.provenance,
			"--coordinator-source-sha256",
			coordinator.provenanceSha256,
		],
		{ cwd: publisherRoot, env: environment },
	);
	return { root, signedEnvelope: path.join(root, "signed-envelope.json") };
}

async function signAndVerifyLocalBundle(
	config: LocalAutomationConfig,
	candidate: LocalCandidate,
	bundle: AssembledBundle,
	coordinator: CoordinatorAsset,
	previous: ChannelEnvelope | undefined,
	integrationRef: string,
	environment: NodeJS.ProcessEnv,
): Promise<void> {
	const publisherRoot = path.resolve(import.meta.dir, "..");
	const signArgs = [
		config.runnerBun,
		path.join(publisherRoot, "scripts", "autobot-release-sign.ts"),
		"--manifest",
		path.join(bundle.root, "manifest.json"),
		"--asset-index",
		path.join(bundle.root, "asset-index.json"),
		"--out",
		bundle.signedEnvelope,
		"--key-id",
		config.keyId,
		"--private-key",
		config.privateKeyPath,
		"--trusted-key",
		`${config.keyId}=${config.publicKeyPath}`,
		"--coordinator-source",
		path.join(bundle.root, "coordinator-source.json"),
		"--coordinator-source-sha256",
		coordinator.provenanceSha256,
	];
	if (previous) signArgs.push("--previous-envelope", previous.path);
	else signArgs.push("--allow-initial");
	await runQuiet("Release signing", signArgs, { cwd: publisherRoot, env: environment });
	const verifyArgs = [
		config.runnerBun,
		path.join(publisherRoot, "scripts", "autobot-release-verify.ts"),
		"--envelope",
		bundle.signedEnvelope,
		"--asset-index",
		path.join(bundle.root, "asset-index.json"),
		"--provenance",
		path.join(bundle.root, "provenance.json"),
		"--coordinator-source",
		path.join(bundle.root, "coordinator-source.json"),
		"--coordinator-source-sha256",
		coordinator.provenanceSha256,
		"--trusted-key",
		`${config.keyId}=${config.publicKeyPath}`,
		"--source-root",
		candidate.sourceRoot,
		"--canonical-ref",
		integrationRef,
	];
	if (previous) verifyArgs.push("--previous-envelope", previous.path);
	await runQuiet("Local signed release verification", verifyArgs, { cwd: publisherRoot, env: environment });
}

async function publishVerifiedDraft(
	config: LocalAutomationConfig,
	candidate: LocalCandidate,
	chain: ReleaseChain,
	bundle: AssembledBundle,
): Promise<void> {
	await runQuiet("GitHub draft release creation", [
		"gh",
		"release",
		"create",
		chain.tag,
		"--repo",
		config.repository,
		"--target",
		candidate.forkCommit,
		"--draft",
		"--title",
		`AutoBot runtime ${chain.sequence}`,
		"--notes",
		"Signed AutoBot Windows x64 runtime release. Channel promotion is the final separate step.",
	]);
	const assetIndex = parseAssetIndex(await readJson(path.join(bundle.root, "asset-index.json"), "local asset index"));
	const payloads = assetIndex.assets.map(asset => path.join(bundle.root, asset.file));
	if (payloads.length !== 4)
		throw new AutoBotReleaseError("Local bundle does not contain exactly four payload assets");
	await runQuiet("GitHub release upload", [
		"gh",
		"release",
		"upload",
		chain.tag,
		"--repo",
		config.repository,
		...payloads,
		...RELEASE_METADATA_FILES.map(file => path.join(bundle.root, file)),
	]);
}

async function advanceChannelLast(
	config: LocalAutomationConfig,
	bundle: AssembledBundle,
	stageRoot: string,
	trusted: TrustedKeySet,
): Promise<void> {
	await runQuiet("GitHub Git credential setup", ["gh", "auth", "setup-git"]);
	const channelRoot = path.join(stageRoot, "channel-repository");
	await runQuiet("Signed channel clone", [
		"git",
		"clone",
		"--depth=1",
		"--branch",
		config.channelBranch,
		githubRepositoryUrl(config.channelRepository),
		channelRoot,
	]);
	const destination = path.resolve(channelRoot, config.channelPath);
	if (!isInside(channelRoot, destination))
		throw new AutoBotReleaseError("Configured channel path escapes its repository");
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.copyFile(bundle.signedEnvelope, destination);
	await runQuiet("Signed channel staging", ["git", "add", "--", config.channelPath], { cwd: channelRoot });
	const stagedNames = await runText(
		"Signed channel staged path check",
		["git", "diff", "--cached", "--name-only", "-z"],
		{
			cwd: channelRoot,
		},
	);
	if (stagedNames !== `${config.channelPath}\0`) {
		throw new AutoBotReleaseError("Signed channel commit would contain paths outside the configured envelope path");
	}
	const diffExitCode = await runExitCode(["git", "diff", "--cached", "--quiet", "--", config.channelPath], {
		cwd: channelRoot,
	});
	if (diffExitCode === 0) {
		throw new AutoBotReleaseError(
			"Configured signed channel already contains this envelope; refusing an ambiguous promotion",
		);
	}
	if (diffExitCode !== 1) throw new AutoBotReleaseError("Signed channel change could not be inspected");
	await runQuiet(
		"Signed channel commit",
		["git", "commit", "--no-gpg-sign", "-m", "chore(autobot): promote signed release", "--", config.channelPath],
		{ cwd: channelRoot },
	);
	await runQuiet("Signed channel push", ["git", "push", "origin", `HEAD:refs/heads/${config.channelBranch}`], {
		cwd: channelRoot,
	});
	const confirmed = await readChannelEnvelope(
		config,
		trusted,
		path.join(stageRoot, "confirmed-channel-envelope.json"),
	);
	if (!confirmed) throw new AutoBotReleaseError("Signed channel disappeared after its promotion push");
	await compareExactBytes(bundle.signedEnvelope, confirmed.path, "Promoted signed channel envelope");
}

/**
 * Build and publish one fully verified Windows x64 AutoBot release.
 *
 * Candidate build/check failures alone use LocalBuildFailure so the controller
 * can route only those failures through the disposable local OMP repair path.
 */
export async function buildAndPublishLocalRelease(
	config: LocalAutomationConfig,
	candidate: LocalCandidate,
): Promise<{
	readonly kind: "published" | "unchanged";
	readonly forkCommit: string;
	readonly releaseSequence?: number;
	readonly tag?: string;
}> {
	requirePublisherConfiguration(config);
	requireCandidate(candidate);
	if (process.platform !== "win32" || process.arch !== "x64") {
		throw new AutoBotReleaseError("Local AutoBot publication is restricted to a Windows x64 host");
	}
	const sourceRoot = await requireDirectory(candidate.sourceRoot, "Candidate source root");
	await assertCleanCommittedCheckout(sourceRoot, "Candidate source", candidate.forkCommit);
	const coordinatorRoot = await requireDirectory(config.coordinatorRoot, "Coordinator source root");
	if (isInside(sourceRoot, coordinatorRoot) || isInside(coordinatorRoot, sourceRoot)) {
		throw new AutoBotReleaseError("Candidate and coordinator source checkouts must be distinct");
	}
	await Promise.all([
		requireConfiguredFile(config.runnerBun, "Runner Bun"),
		requireConfiguredFile(config.compilerBun, "Compiler Bun"),
		requireConfiguredFile(config.privateKeyPath, "Private signing key"),
		requireConfiguredFile(config.publicKeyPath, "Trusted public key"),
		assertExactBun(config.runnerBun, config.runnerBunVersion, "Runner Bun"),
		assertExactBun(config.compilerBun, config.compilerBunVersion, "Compiler Bun"),
	]);
	const workRoot = requireAbsolutePath(config.workRoot, "Work root");
	if (isInside(sourceRoot, workRoot) || isInside(coordinatorRoot, workRoot)) {
		throw new AutoBotReleaseError("Owned release staging root must not be nested inside either source checkout");
	}
	await fs.mkdir(workRoot, { recursive: true });
	const stageRoot = await fs.realpath(await fs.mkdtemp(path.join(workRoot, "autobot-release-")));
	if (isInside(sourceRoot, stageRoot) || isInside(coordinatorRoot, stageRoot)) {
		await fs.rm(stageRoot, { recursive: true, force: true });
		throw new AutoBotReleaseError("Owned release staging directory must be outside both source checkouts");
	}
	let completed = false;
	try {
		const environment = commandEnvironment(config);
		const plan = await readCandidateReleasePlan(config, sourceRoot, stageRoot, environment);
		assertPlanMatchesCandidate(plan, candidate);
		const trusted = await loadTrustedKeys([`${config.keyId}=${config.publicKeyPath}`]);
		const chain = await establishReleaseChain(config, stageRoot, trusted);
		if (chain.previous && chain.previousRelease) {
			await verifyPublishedRelease(config, candidate, chain.previousRelease.tag, stageRoot, environment, {
				expectedEnvelope: chain.previous.path,
				historicalPredecessor: true,
			});
			if (isPublishedCandidate(chain.previous.verified.manifest, candidate)) {
				completed = true;
				return { kind: "unchanged", forkCommit: candidate.forkCommit };
			}
		}
		await assertIntegrationRef(config, candidate, sourceRoot);
		const identity: ReleaseBuildIdentity = {
			schemaVersion: AUTO_BOT_RELEASE_SCHEMA_VERSION,
			releaseSequence: chain.sequence,
			upstreamVersion: candidate.upstreamVersion,
			forkCommit: candidate.forkCommit,
			upstreamCommit: candidate.upstreamCommit,
			sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
			collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
			compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		};
		const assets = await buildCandidateAssets(config, candidate, identity, stageRoot, environment);
		const coordinator = await buildCoordinatorAsset(config, candidate, stageRoot, environment);
		await assertCleanCommittedCheckout(sourceRoot, "Candidate source", candidate.forkCommit);
		const bundle = await assembleBundle(config, candidate, chain, assets, coordinator, stageRoot, environment);
		const integrationRef = await assertIntegrationRef(config, candidate, sourceRoot);
		await signAndVerifyLocalBundle(
			config,
			candidate,
			bundle,
			coordinator,
			chain.previous,
			integrationRef,
			environment,
		);
		await assertOperatorGitCommitIdentity(stageRoot);
		await publishVerifiedDraft(config, candidate, chain, bundle);
		const publishedIntegrationRef = await assertIntegrationRef(config, candidate, sourceRoot);
		await verifyPublishedRelease(config, candidate, chain.tag, stageRoot, environment, {
			localBundle: bundle.root,
			previousEnvelope: chain.previous?.path,
			canonicalRef: publishedIntegrationRef,
		});
		await assertIntegrationRef(config, candidate, sourceRoot);
		await runQuiet("GitHub draft release publication", [
			"gh",
			"release",
			"edit",
			chain.tag,
			"--repo",
			config.repository,
			"--draft=false",
		]);
		await advanceChannelLast(config, bundle, stageRoot, trusted);
		completed = true;
		return { kind: "published", forkCommit: candidate.forkCommit, releaseSequence: chain.sequence, tag: chain.tag };
	} finally {
		if (completed) await fs.rm(stageRoot, { recursive: true, force: true });
	}
}
