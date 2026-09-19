import { isRecord } from "../packages/utils/src/type-guards.ts";
import { AutoBotReleaseError, requireCommit, runCommand } from "./autobot-release-common.ts";

const REPAIR_INTENT_SCHEMA_VERSION = 1 as const;
const MAX_REPAIR_PATHS = 1024;
const MAX_REPAIR_PATH_LENGTH = 1024;
const MAX_CANDIDATE_HISTORY_COMMITS = 2048;

const GENERATED_LOCAL_ROOTS: Record<string, true> = {
	".bun-cache": true,
	".integration-check": true,
	".nyc_output": true,
	coverage: true,
	"verify-out": true,
};
const EXECUTABLE_ARTIFACT_EXTENSIONS = [
	".app",
	".bin",
	".com",
	".deb",
	".dll",
	".dmg",
	".exe",
	".iso",
	".jar",
	".msi",
	".node",
	".pkg",
	".rpm",
	".so",
	".wasm",
];
const SECRET_FILE_EXTENSIONS = [".jks", ".kdbx", ".key", ".p12", ".p8", ".pem", ".pfx", ".pkcs8"];
const SENSITIVE_LOCAL_FILENAMES: Record<string, true> = {
	".git-credentials": true,
	".netrc": true,
	".npmrc": true,
	".pypirc": true,
	credentials: true,
	"credentials.json": true,
	"secrets.json": true,
	"token.json": true,
};

interface PathChange {
	readonly path: string;
}

interface TreeEntry {
	readonly mode: string;
	readonly object: string;
	readonly path: string;
	readonly type: string;
}

export interface RepairIntent {
	readonly paths: readonly string[];
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

function normalizeRepositoryPath(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REPAIR_PATH_LENGTH) {
		throw new AutoBotReleaseError(`${label} is invalid`);
	}
	if (/[\u0000-\u001F\u007F]/.test(value) || value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
		throw new AutoBotReleaseError(`${label} is invalid`);
	}
	const parts = value.split("/");
	if (parts.some(part => part.length === 0 || part === "." || part === ".." || part.includes(":"))) {
		throw new AutoBotReleaseError(`${label} is invalid`);
	}
	return value;
}

function parseNulFields(value: string, label: string): string[] {
	const fields = value.split("\0");
	if (fields.pop() !== "") throw new AutoBotReleaseError(`${label} is malformed`);
	return fields;
}

function parseNameStatus(value: string, label: string): PathChange[] {
	const fields = parseNulFields(value, label);
	const changes: PathChange[] = [];
	for (let index = 0; index < fields.length; index += 2) {
		const status = fields[index];
		const pathname = fields[index + 1];
		if (pathname === undefined || status === undefined || !/[ACDMTUX]/.test(status) || status.length !== 1) {
			throw new AutoBotReleaseError(`${label} is malformed`);
		}
		changes.push({
			path: normalizeRepositoryPath(pathname, `${label} path`),
		});
	}
	return changes;
}

function parseListedPaths(value: string, label: string): string[] {
	return parseNulFields(value, label).map(pathname => {
		const normalized = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
		return normalizeRepositoryPath(normalized, `${label} path`);
	});
}

function assertExactPathSet(actual: Iterable<string>, expected: readonly string[], label: string): void {
	const actualPaths = new Set(actual);
	const expectedPaths = new Set(expected);
	if (actualPaths.size !== expectedPaths.size || [...actualPaths].some(pathname => !expectedPaths.has(pathname))) {
		throw new AutoBotReleaseError(`${label} does not match its declared repair paths`);
	}
}

function pathViolation(pathname: string): string | undefined {
	const lowerPath = pathname.toLowerCase();
	const components = lowerPath.split("/");
	const filename = components.at(-1) ?? "";
	if (components.some(component => GENERATED_LOCAL_ROOTS[component] === true)) {
		return "a generated or local verification path";
	}
	if (components.at(-2) === ".semgrep" && (filename === "guardian.yml" || filename.endsWith(".lock"))) {
		return "a Semgrep Guardian local-state path";
	}
	if (
		filename === ".env" ||
		(filename.startsWith(".env.") && !filename.endsWith(".example") && !filename.endsWith(".sample")) ||
		SENSITIVE_LOCAL_FILENAMES[filename] === true ||
		components.some(component => component === ".aws" || component === ".ssh") ||
		SECRET_FILE_EXTENSIONS.some(extension => filename.endsWith(extension)) ||
		/(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens)(?:[._-](?:local|private))?\.(?:json|ya?ml|toml|ini|conf|txt)$/.test(
			filename,
		)
	) {
		return "a secret or local configuration path";
	}
	if (components.some(component => EXECUTABLE_ARTIFACT_EXTENSIONS.some(extension => component.endsWith(extension)))) {
		return "an executable artifact path";
	}
	return undefined;
}

function assertNoForbiddenPaths(paths: Iterable<string>): void {
	for (const pathname of paths) {
		const violation = pathViolation(pathname);
		if (violation !== undefined) {
			throw new AutoBotReleaseError(`AutoBot publication boundary rejects ${violation}: ${pathname}`);
		}
	}
}

async function stagedPathMatchesInput(worktree: string, inputCommit: string, pathname: string): Promise<boolean> {
	const child = Bun.spawn(
		[
			"git",
			"diff",
			"--cached",
			"--quiet",
			"--no-ext-diff",
			"--no-textconv",
			requireCommit(inputCommit, "Pinned merge input"),
			"--",
			literalPathspec(pathname),
		],
		{ cwd: worktree, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	const exitCode = await child.exited;
	if (exitCode === 0) return true;
	if (exitCode === 1) return false;
	throw new AutoBotReleaseError("Could not compare staged local integration paths with their pinned merge input");
}

async function assertNoForbiddenStagedChanges(
	worktree: string,
	changes: readonly PathChange[],
	allowedInputCommit: string | undefined,
): Promise<void> {
	for (const change of changes) {
		const violation = pathViolation(change.path);
		if (violation === undefined) continue;
		if (
			allowedInputCommit !== undefined &&
			(await stagedPathMatchesInput(worktree, allowedInputCommit, change.path))
		) {
			continue;
		}
		throw new AutoBotReleaseError(`AutoBot publication boundary rejects ${violation}: ${change.path}`);
	}
}

async function workingTreeChanges(worktree: string): Promise<{
	readonly staged: readonly PathChange[];
	readonly unstaged: readonly PathChange[];
	readonly untracked: readonly string[];
}> {
	const [unstaged, staged, untracked] = await Promise.all([
		runCommand(["git", "diff", "--name-status", "--no-renames", "-z"], { cwd: worktree, capture: true }),
		runCommand(["git", "diff", "--cached", "--name-status", "--no-renames", "-z"], {
			cwd: worktree,
			capture: true,
		}),
		runCommand(["git", "ls-files", "--others", "--exclude-standard", "-z"], { cwd: worktree, capture: true }),
	]);
	return {
		unstaged: parseNameStatus(unstaged.stdout, "Unstaged local integration diff"),
		staged: parseNameStatus(staged.stdout, "Staged local integration diff"),
		untracked: parseListedPaths(untracked.stdout, "Untracked local integration paths"),
	};
}

async function stagedChanges(worktree: string, base?: string): Promise<PathChange[]> {
	const args = ["git", "diff", "--cached", "--name-status", "--no-renames", "-z"];
	if (base !== undefined) args.push(requireCommit(base, "Staged diff base"));
	const result = await runCommand(args, { cwd: worktree, capture: true });
	return parseNameStatus(result.stdout, "Staged local integration diff");
}

function literalPathspec(pathname: string): string {
	return `:(literal)${pathname}`;
}

/** Parse the one-time, controller-bound declaration written by local OMP. */
export function parseRepairIntent(value: unknown, expectedNonce: string): RepairIntent {
	if (!isRecord(value)) throw new AutoBotReleaseError("Local OMP repair intent must be a JSON object");
	requireExactKeys(value, ["schemaVersion", "nonce", "paths"], "Local OMP repair intent");
	if (value.schemaVersion !== REPAIR_INTENT_SCHEMA_VERSION) {
		throw new AutoBotReleaseError("Local OMP repair intent schema is unsupported");
	}
	if (typeof value.nonce !== "string" || value.nonce !== expectedNonce) {
		throw new AutoBotReleaseError("Local OMP repair intent does not belong to this invocation");
	}
	if (!Array.isArray(value.paths) || value.paths.length > MAX_REPAIR_PATHS) {
		throw new AutoBotReleaseError("Local OMP repair intent paths are invalid");
	}
	const paths = value.paths.map((pathname, index) =>
		normalizeRepositoryPath(pathname, `Local OMP repair intent path ${index + 1}`),
	);
	if (new Set(paths).size !== paths.length) {
		throw new AutoBotReleaseError("Local OMP repair intent paths contain duplicates");
	}
	return { paths };
}

/** Reject forbidden staged and nonignored worktree residue. */
export async function assertNoForbiddenWorktreeResidue(worktree: string, allowedInputCommit?: string): Promise<void> {
	const changes = await workingTreeChanges(worktree);
	await assertNoForbiddenStagedChanges(worktree, changes.staged, allowedInputCommit);
	assertNoForbiddenPaths([...changes.unstaged.map(change => change.path), ...changes.untracked]);
}

/**
 * Stage only the exact paths declared by OMP. A declaration is a complete
 * commit contract: tracked edits, additions, deletes, and both sides of a
 * rename must all be named before the index can advance.
 */
export async function stageDeclaredRepair(worktree: string, intent: RepairIntent): Promise<void> {
	const before = await workingTreeChanges(worktree);
	assertNoForbiddenPaths([
		...before.unstaged.map(change => change.path),
		...before.staged.map(change => change.path),
		...before.untracked,
	]);
	assertExactPathSet(
		[...before.unstaged.map(change => change.path), ...before.staged.map(change => change.path), ...before.untracked],
		intent.paths,
		"Local integration changes",
	);
	for (const pathname of intent.paths) {
		await runCommand(["git", "add", "--", literalPathspec(pathname)], { cwd: worktree, capture: true });
	}
	const after = await workingTreeChanges(worktree);
	assertNoForbiddenPaths([
		...after.unstaged.map(change => change.path),
		...after.staged.map(change => change.path),
		...after.untracked,
	]);
	assertExactPathSet(
		after.staged.map(change => change.path),
		intent.paths,
		"Staged local integration changes",
	);
	if (after.unstaged.length !== 0 || after.untracked.length !== 0) {
		throw new AutoBotReleaseError("Local integration retained unstaged or untracked changes after declared staging");
	}
}

/** Validate the fully staged resolved merge against the one-time OMP declaration. */
export async function assertDeclaredStagedDiff(
	worktree: string,
	base: string,
	intent: RepairIntent,
	allowedInputCommit?: string,
): Promise<void> {
	const changes = await stagedChanges(worktree, base);
	await assertNoForbiddenStagedChanges(worktree, changes, allowedInputCommit);
	assertExactPathSet(
		changes.map(change => change.path),
		intent.paths,
		"Resolved merge changes",
	);
}

function parseTree(value: string, label: string): Map<string, TreeEntry> {
	const entries = new Map<string, TreeEntry>();
	for (const field of parseNulFields(value, label)) {
		const separator = field.indexOf("\t");
		if (separator <= 0) throw new AutoBotReleaseError(`${label} is malformed`);
		const metadata = field.slice(0, separator).split(" ");
		const pathname = normalizeRepositoryPath(field.slice(separator + 1), `${label} path`);
		const [mode, type, object, extra] = metadata;
		if (
			!mode ||
			!type ||
			!object ||
			extra !== undefined ||
			!/^[0-7]{6}$/.test(mode) ||
			!/^[0-9a-f]{40,64}$/.test(object) ||
			(type !== "blob" && type !== "commit") ||
			entries.has(pathname)
		) {
			throw new AutoBotReleaseError(`${label} is malformed`);
		}
		entries.set(pathname, { mode, type, object, path: pathname });
	}
	return entries;
}

async function treeAt(worktree: string, commit: string, label: string): Promise<Map<string, TreeEntry>> {
	const result = await runCommand(["git", "ls-tree", "-r", "-z", requireCommit(commit, label)], {
		cwd: worktree,
		capture: true,
	});
	return parseTree(result.stdout, `${label} tree`);
}

function inputContainsEntry(inputs: readonly Map<string, TreeEntry>[], entry: TreeEntry): boolean {
	return inputs.some(input => {
		const known = input.get(entry.path);
		return (
			known !== undefined && known.mode === entry.mode && known.type === entry.type && known.object === entry.object
		);
	});
}

function candidateTreeViolation(entry: TreeEntry): string | undefined {
	const violation = pathViolation(entry.path);
	if (violation !== undefined) return violation;
	if (entry.type !== "blob" || entry.mode === "120000" || entry.mode === "160000") {
		return "a non-regular executable artifact";
	}
	return undefined;
}

/**
 * Reject forbidden worktree residue and inspect every non-input commit that
 * would be pushed. Exact blobs inherited from either pinned input remain
 * valid; locally committed generated, secret, or executable artifacts cannot
 * be laundered through a clean worktree.
 */
export async function assertCandidatePublicationBoundary(
	worktree: string,
	candidateCommit: string,
	canonicalCommit: string,
	upstreamCommit: string,
): Promise<void> {
	const candidate = requireCommit(candidateCommit, "Candidate publication commit");
	const canonical = requireCommit(canonicalCommit, "Canonical publication input");
	const upstream = requireCommit(upstreamCommit, "Upstream publication input");
	await assertNoForbiddenWorktreeResidue(worktree);
	const history = await runCommand(["git", "rev-list", "--topo-order", candidate, `^${canonical}`, `^${upstream}`], {
		cwd: worktree,
		capture: true,
	});
	const commits = history.stdout
		.split("\n")
		.filter(Boolean)
		.map((commit, index) => requireCommit(commit, `Candidate publication history commit ${index + 1}`));
	if (commits.length > MAX_CANDIDATE_HISTORY_COMMITS) {
		throw new AutoBotReleaseError("Candidate publication history exceeds the review boundary");
	}
	const inputs = await Promise.all([
		treeAt(worktree, canonical, "Canonical publication input"),
		treeAt(worktree, upstream, "Upstream publication input"),
	]);
	for (const commit of commits) {
		for (const entry of (await treeAt(worktree, commit, "Candidate publication history")).values()) {
			const violation = candidateTreeViolation(entry);
			if (violation !== undefined && !inputContainsEntry(inputs, entry)) {
				throw new AutoBotReleaseError(`Candidate publication boundary rejects ${violation}: ${entry.path}`);
			}
		}
	}
}
