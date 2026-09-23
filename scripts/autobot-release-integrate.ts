#!/usr/bin/env bun

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ts } from "ts-morph";
import { autoBotPathRequiresCompatibilityReview } from "../packages/coding-agent/src/autobot-update/contract.ts";
import { currentAutoBotRuntimeTarget } from "../packages/coding-agent/src/autobot-update/platform.ts";
import { isRecord } from "../packages/utils/src/type-guards.ts";
import {
	AutoBotReleaseError,
	assertKnownOptions,
	createEmptyDirectory,
	gitOutput,
	hashFile,
	outputError,
	parseCliArgs,
	requireCommit,
	requirePositiveSafeInteger,
	requireString,
	requireSha256,
	requiredOption,
	runCommand,
	writeJsonAtomic,
} from "./autobot-release-common.ts";
import { createManagedBundle, deriveManagedBundleId } from "./autobot-release-web.ts";

const FULL_REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const UPSTREAM_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const CANDIDATE_CONTRACT_MAX_BYTES = 1024 * 1024;

function hasSafeRefComponents(value: string): boolean {
	return (
		!value.endsWith(".") &&
		value.split("/").every(component => {
			const normalized = component.toLowerCase();
			return component.length > 0 && !component.startsWith(".") && !normalized.endsWith(".lock");
		})
	);
}

export function requireRef(value: string, label: string): string {
	if (
		!FULL_REF.test(value) ||
		!hasSafeRefComponents(value) ||
		value.includes("..") ||
		value.endsWith("/") ||
		value.includes("//")
	) {
		throw new AutoBotReleaseError(`${label} must be a fully qualified safe refs/heads/... or refs/tags/... ref`);
	}
	return value;
}

export function requireBranch(value: string): string {
	if (
		!BRANCH.test(value) ||
		!hasSafeRefComponents(value) ||
		value.includes("..") ||
		value.endsWith("/") ||
		value.includes("//")
	) {
		throw new AutoBotReleaseError("Branch must be an explicit safe branch name");
	}
	return value;
}
export function requireHttpsRepository(value: string, label: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch (error) {
		throw new AutoBotReleaseError(`${label} must be an HTTPS repository URL`, { cause: error });
	}
	if (
		parsed.protocol !== "https:" ||
		!parsed.hostname ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new AutoBotReleaseError(`${label} must be an HTTPS repository URL without credentials, query, or fragment`);
	}
	return value;
}

export async function resolveRemoteCommit(repository: string, ref: string, label: string): Promise<string> {
	const result = await runCommand(["git", "ls-remote", "--refs", repository, ref], { capture: true });
	const matches = result.stdout
		.split("\n")
		.map(line => line.trim().split(/\s+/, 2))
		.filter(parts => parts.length === 2 && parts[1] === ref);
	if (matches.length !== 1) throw new AutoBotReleaseError(`${label} ref did not resolve to exactly one remote object`);
	return requireCommit(matches[0]?.[0] ?? "", `${label} resolved commit`);
}

export async function isAncestor(sourceRoot: string, ancestor: string, descendant: string): Promise<boolean> {
	const child = Bun.spawn(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
		cwd: sourceRoot,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (exitCode === 0) return true;
	if (exitCode === 1) return false;
	const detail = stderr.trim();
	throw new AutoBotReleaseError(
		`Could not determine whether pinned upstream is already integrated${detail ? `: ${detail}` : ""}`,
	);
}

export async function exactBunVersion(executable: string, expected: string, label: string): Promise<void> {
	const result = await runCommand([executable, "--version"], { capture: true });
	if (result.stdout.trim() !== expected) {
		throw new AutoBotReleaseError(
			`${label} version must be exactly ${expected}; found ${result.stdout.trim() || "<empty>"}`,
		);
	}
}

async function assertCandidateNativeAddon(candidate: string): Promise<void> {
	const nativeDirectory = path.join(candidate, "packages", "natives", "native");
	const entries = await fs.readdir(nativeDirectory).catch(error => {
		throw new AutoBotReleaseError("Candidate native addon output directory is missing", { cause: error });
	});
	if (!entries.some(entry => entry.endsWith(".node"))) {
		throw new AutoBotReleaseError("Candidate native addon build produced no .node file");
	}
}

export async function upstreamPackageVersion(sourceRoot: string, upstreamCommit: string): Promise<string> {
	const packageJson = await runCommand(["git", "show", `${upstreamCommit}:packages/coding-agent/package.json`], {
		cwd: sourceRoot,
		capture: true,
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(packageJson.stdout);
	} catch (error) {
		throw new AutoBotReleaseError("Pinned upstream coding-agent package.json is invalid JSON", { cause: error });
	}
	if (!isRecord(parsed) || typeof parsed.version !== "string" || !UPSTREAM_VERSION.test(parsed.version)) {
		throw new AutoBotReleaseError("Pinned upstream coding-agent package.json must declare a valid release version");
	}
	return parsed.version;
}

export interface CandidateReleaseIdentity {
	readonly compatibilityEpoch: number;
	readonly compatibilityReviewPaths: readonly string[];
	readonly runtimeTarget: string;
}

export function candidateMergeSubject(upstreamCommit: string): string {
	return `chore(autobot): candidate upstream ${requireCommit(upstreamCommit, "Candidate upstream commit").slice(0, 12)}`;
}

export interface CandidateMerge {
	readonly commit: string;
	readonly firstParent: string;
	readonly upstreamCommit: string;
}

export async function assertCandidateMerge(
	sourceRoot: string,
	candidateCommit: string,
	upstreamCommit: string,
	expectedFirstParent?: string,
): Promise<CandidateMerge> {
	const commit = requireCommit(candidateCommit, "Candidate merge commit");
	const upstream = requireCommit(upstreamCommit, "Candidate upstream parent");
	const parents = (await gitOutput(sourceRoot, ["show", "-s", "--format=%P", commit]))
		.split(" ")
		.filter(Boolean)
		.map((parent, index) => requireCommit(parent, `Candidate merge parent ${index + 1}`));
	if (parents.length !== 2) {
		throw new AutoBotReleaseError(`AutoBot candidate ${commit} must retain its canonical and upstream merge parents`);
	}
	if (parents[1] !== upstream) {
		throw new AutoBotReleaseError(`AutoBot candidate ${commit} must retain the pinned upstream as its second parent`);
	}
	if (expectedFirstParent && parents[0] !== requireCommit(expectedFirstParent, "Candidate canonical parent")) {
		throw new AutoBotReleaseError(`AutoBot candidate ${commit} must retain its expected canonical first parent`);
	}
	const subject = await gitOutput(sourceRoot, ["show", "-s", "--format=%s", commit]);
	if (subject !== candidateMergeSubject(upstream)) {
		throw new AutoBotReleaseError(`AutoBot candidate ${commit} must retain its required subject`);
	}
	return { commit, firstParent: parents[0] ?? "", upstreamCommit: upstream };
}

export async function latestCandidateMerge(
	sourceRoot: string,
	descendant: string,
): Promise<CandidateMerge | undefined> {
	const history = await runCommand(["git", "log", "--topo-order", "--format=%H%x00%s", descendant], {
		cwd: sourceRoot,
		capture: true,
	});
	for (const row of history.stdout.split("\n")) {
		const [candidateCommit, subject] = row.split("\u0000", 2);
		const match = /^chore\(autobot\): candidate upstream ([0-9a-f]{12})$/.exec(subject ?? "");
		if (!match) continue;
		const commit = requireCommit(candidateCommit ?? "", "Candidate merge commit");
		const parents = (await gitOutput(sourceRoot, ["show", "-s", "--format=%P", commit])).split(" ").filter(Boolean);
		if (parents.length !== 2) {
			throw new AutoBotReleaseError(
				`AutoBot candidate ${commit} must retain its canonical and upstream merge parents`,
			);
		}
		const upstream = requireCommit(parents[1] ?? "", "Candidate upstream parent");
		if (!upstream.startsWith(match[1] ?? "")) {
			throw new AutoBotReleaseError(`AutoBot candidate ${commit} subject does not match its upstream merge parent`);
		}
		return assertCandidateMerge(sourceRoot, commit, upstream);
	}
	return undefined;
}

function literalCompatibilityEpoch(expression: ts.Expression | undefined): number | undefined {
	let current = expression;
	while (
		current &&
		(ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isParenthesizedExpression(current))
	) {
		current = current.expression;
	}
	if (!current || !ts.isNumericLiteral(current) || !/^[1-9]\d*$/.test(current.text)) return undefined;
	return requirePositiveSafeInteger(Number(current.text), "Candidate compatibility epoch");
}

function candidateCompatibilityEpoch(source: string): number {
	const sourceFile = ts.createSourceFile(
		"candidate-autobot-contract.ts",
		source,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.TS,
	);
	const parseDiagnostics = Reflect.get(sourceFile, "parseDiagnostics");
	if (!Array.isArray(parseDiagnostics) || parseDiagnostics.length !== 0) {
		throw new AutoBotReleaseError("Candidate AutoBot contract is not valid TypeScript");
	}
	let epoch: number | undefined;
	for (const statement of sourceFile.statements) {
		if (
			!ts.isVariableStatement(statement) ||
			(statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
			!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
		) {
			continue;
		}
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "AUTO_BOT_COMPATIBILITY_EPOCH") continue;
			if (epoch !== undefined) {
				throw new AutoBotReleaseError("Candidate AutoBot contract must declare exactly one compatibility epoch");
			}
			epoch = literalCompatibilityEpoch(declaration.initializer);
			if (epoch === undefined) {
				throw new AutoBotReleaseError("Candidate AutoBot compatibility epoch must be a positive literal");
			}
		}
	}
	if (epoch === undefined) {
		throw new AutoBotReleaseError("Candidate AutoBot contract must declare exactly one compatibility epoch");
	}
	return epoch;
}

interface CandidateContractPolicy {
	readonly compatibilityEpoch: number;
	readonly differsFromProducer: boolean;
}

async function candidateContractPolicy(sourceRoot: string): Promise<CandidateContractPolicy> {
	const candidatePath = path.join(sourceRoot, "packages", "coding-agent", "src", "autobot-update", "contract.ts");
	const producerPath = path.join(
		import.meta.dir,
		"..",
		"packages",
		"coding-agent",
		"src",
		"autobot-update",
		"contract.ts",
	);
	let candidateStat: Stats;
	try {
		candidateStat = await fs.lstat(candidatePath);
	} catch (error) {
		throw new AutoBotReleaseError("Candidate AutoBot contract is unavailable", { cause: error });
	}
	if (!candidateStat.isFile() || candidateStat.size > CANDIDATE_CONTRACT_MAX_BYTES) {
		throw new AutoBotReleaseError("Candidate AutoBot contract must be a bounded regular file");
	}
	let candidateSource: string;
	let producerSource: string;
	try {
		[candidateSource, producerSource] = await Promise.all([
			fs.readFile(candidatePath, "utf8"),
			fs.readFile(producerPath, "utf8"),
		]);
	} catch (error) {
		throw new AutoBotReleaseError("Could not read the declarative AutoBot compatibility contract", { cause: error });
	}
	return {
		compatibilityEpoch: candidateCompatibilityEpoch(candidateSource),
		differsFromProducer: candidateSource !== producerSource,
	};
}

export async function candidateReleaseIdentity(
	sourceRoot: string,
	upstreamCommit: string,
	candidateCommit: string,
): Promise<CandidateReleaseIdentity> {
	const [candidatePolicy, changed] = await Promise.all([
		candidateContractPolicy(sourceRoot),
		runCommand(["git", "diff", "--name-only", "--no-renames", "-z", upstreamCommit, candidateCommit], {
			cwd: sourceRoot,
			capture: true,
		}),
	]);
	return {
		compatibilityEpoch: candidatePolicy.compatibilityEpoch,
		// Candidate policy code is source input, not executable controller code.
		// If it differs from the trusted producer policy, conservatively route
		// every candidate change through compatibility review.
		compatibilityReviewPaths: changed.stdout
			.split("\u0000")
			.filter(Boolean)
			.filter(
				repositoryPath =>
					candidatePolicy.differsFromProducer ||
					autoBotPathRequiresCompatibilityReview(repositoryPath) ||
					repositoryPath === "packages/coding-agent/src/autobot-update/contract.ts",
			),
		runtimeTarget: requireString(currentAutoBotRuntimeTarget(), "Trusted runtime target"),
	};
}

export interface CandidateBuildResult {
	readonly runtimeFile: string;
	readonly webArchive: string;
	readonly webBundleId: string;
}

export async function buildCandidate(
	candidate: string,
	runnerBun: string,
	compilerBun: string,
	forkCommit: string,
	upstreamCommit: string,
	upstreamVersion: string,
	output: string,
): Promise<CandidateBuildResult> {
	const runnerDirectory = path.dirname(runnerBun);
	const commandEnvironment: NodeJS.ProcessEnv = {
		...Bun.env,
		PATH: `${runnerDirectory}${path.delimiter}${Bun.env.PATH ?? ""}`,
	};
	await runCommand([runnerBun, "install", "--frozen-lockfile"], { cwd: candidate, env: commandEnvironment });
	// This must precede compilation: build-extension regenerates the text assets embedded into the runtime.
	await runCommand([runnerBun, "--cwd=packages/browser-relay", "run", "build"], {
		cwd: candidate,
		env: commandEnvironment,
	});
	await Promise.all([
		fs.access(path.join(candidate, "packages", "browser-relay", "dist", "omp-browser-relay-extension.zip")),
		fs.access(
			path.join(
				candidate,
				"packages",
				"coding-agent",
				"src",
				"tools",
				"browser",
				"relay",
				"extension-assets",
				"background.js.txt",
			),
		),
	]);
	await runCommand([runnerBun, "--cwd=packages/collab-web", "run", "build"], {
		cwd: candidate,
		env: commandEnvironment,
	});
	await runCommand([runnerBun, "run", "build:native"], { cwd: candidate, env: commandEnvironment });
	await assertCandidateNativeAddon(candidate);
	// Compile under the pinned compiler itself. Its helper subprocesses still
	// resolve `bun` from commandEnvironment to the separately pinned runner.
	const compilerEnvironment = { ...commandEnvironment };
	delete compilerEnvironment.BUN_COMPILE_EXECUTABLE_PATH;
	await runCommand([compilerBun, "scripts/build-binary.ts"], {
		cwd: path.join(candidate, "packages", "coding-agent"),
		env: compilerEnvironment,
	});
	const runtimeFilename = process.platform === "win32" ? "omp.exe" : "omp";
	const runtime = path.join(candidate, "packages", "coding-agent", "dist", runtimeFilename);
	await fs.access(runtime);
	const smokeHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autobot-runtime-smoke-"));
	try {
		await runCommand([runtime, "--version"], {
			env: { ...commandEnvironment, HOME: smokeHome, XDG_DATA_HOME: path.join(smokeHome, "xdg") },
		});
		await runCommand([runtime, "--smoke-test"], {
			env: { ...commandEnvironment, HOME: smokeHome, XDG_DATA_HOME: path.join(smokeHome, "xdg") },
		});
	} finally {
		await fs.rm(smokeHome, { recursive: true, force: true });
	}
	// Contract tests run under the exact configured runner and after the candidate native build.
	await runCommand([runnerBun, "run", "ci:test:coding-agent:runtime"], { cwd: candidate, env: commandEnvironment });
	await runCommand([runnerBun, "--cwd=packages/collab-web", "test"], { cwd: candidate, env: commandEnvironment });
	// This producer regression covers signing, pinned coordinator provenance, and
	// the complete asset topology before a candidate can be offered for review.
	await runCommand([runnerBun, "test", "scripts/autobot-release-security.test.ts"], {
		cwd: candidate,
		env: commandEnvironment,
	});
	// Installer regression exercises a real child process after the candidate's
	// native binding is available, preserving the live-legacy-process refusal.
	await runCommand([runnerBun, "test", "scripts/autobot-install.test.ts"], {
		cwd: candidate,
		env: commandEnvironment,
	});
	const runtimeOutput = path.join(output, "runtime", runtimeFilename);
	await fs.mkdir(path.dirname(runtimeOutput), { recursive: true });
	await fs.copyFile(runtime, runtimeOutput);
	// The candidate owns the web bytes, but the local controller must not execute
	// candidate source merely to package those bytes.
	const webBundleId = await deriveManagedBundleId(
		path.join(candidate, "packages", "collab-web", "dist"),
		path.join(candidate, "packages", "collab-web", "public"),
	);
	const webArchive = path.join(output, `omp-collab-web-${webBundleId}.tar.gz`);
	await createManagedBundle({
		dist: path.join(candidate, "packages", "collab-web", "dist"),
		publicDirectory: path.join(candidate, "packages", "collab-web", "public"),
		out: webArchive,
		bundleId: webBundleId,
		forkCommit,
		upstreamCommit,
		upstreamVersion,
	});
	return { runtimeFile: runtimeOutput, webArchive, webBundleId };
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	assertKnownOptions(args, [
		"canonical-repository",
		"canonical-branch",
		"upstream-repository",
		"upstream-ref",
		"runner-bun",
		"runner-bun-version",
		"compiler-bun",
		"compiler-bun-version",
		"coordinator-source-sha256",
		"out",
	]);
	const canonicalRepository = requireHttpsRepository(
		requireString(requiredOption(args, "canonical-repository"), "Canonical repository"),
		"Canonical repository",
	);
	const canonicalBranch = requireBranch(requiredOption(args, "canonical-branch"));
	const upstreamRef = requireRef(requiredOption(args, "upstream-ref"), "Upstream ref");
	const upstreamRepository = requireHttpsRepository(
		requireString(requiredOption(args, "upstream-repository"), "Upstream repository"),
		"Upstream repository",
	);
	const runnerBun = path.resolve(requiredOption(args, "runner-bun"));
	const compilerBun = path.resolve(requiredOption(args, "compiler-bun"));
	await exactBunVersion(runnerBun, requiredOption(args, "runner-bun-version"), "Runner Bun");
	await exactBunVersion(compilerBun, requiredOption(args, "compiler-bun-version"), "Compiler Bun");
	const compilerBunHash = await hashFile(compilerBun);
	const coordinatorSourceSha256 = requireSha256(
		requiredOption(args, "coordinator-source-sha256"),
		"Coordinator source provenance SHA-256",
	);
	const output = await createEmptyDirectory(requiredOption(args, "out"), "Candidate output directory");
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autobot-upstream-"));
	const clone = path.join(temporary, "candidate");
	try {
		const canonicalRef = `refs/heads/${canonicalBranch}`;
		const [canonicalObject, upstreamObject] = await Promise.all([
			resolveRemoteCommit(canonicalRepository, canonicalRef, "Canonical"),
			resolveRemoteCommit(upstreamRepository, upstreamRef, "Upstream"),
		]);
		await runCommand(["git", "clone", "--no-checkout", canonicalRepository, clone], { capture: true });
		await runCommand(["git", "fetch", "--no-tags", "origin", canonicalObject], { cwd: clone, capture: true });
		const canonicalCommit = await gitOutput(clone, ["rev-parse", "FETCH_HEAD^{commit}"]);
		await runCommand(["git", "fetch", "--no-tags", upstreamRepository, upstreamObject], {
			cwd: clone,
			capture: true,
		});
		const upstreamCommit = await gitOutput(clone, ["rev-parse", "FETCH_HEAD^{commit}"]);
		const integrationIdentity = {
			schemaVersion: 1,
			canonicalRepository,
			canonicalBranch,
			canonicalCommit,
			upstreamRepository,
			upstreamRef,
			upstreamCommit,
		};
		if (await isAncestor(clone, upstreamCommit, canonicalCommit)) {
			await writeJsonAtomic(path.join(output, "integration-result.json"), {
				...integrationIdentity,
				outcome: "unchanged",
			});
			console.log(
				`Pinned upstream ${upstreamCommit.slice(0, 12)} is already integrated into ${canonicalBranch}; no candidate created`,
			);
			return;
		}
		const upstreamVersion = await upstreamPackageVersion(clone, upstreamCommit);
		await runCommand(["git", "checkout", "--detach", canonicalCommit], { cwd: clone, capture: true });
		try {
			await runCommand(
				[
					"git",
					"-c",
					"user.name=autobot-candidate",
					"-c",
					"user.email=autobot-candidate@invalid",
					"merge",
					"--no-commit",
					"--no-ff",
					upstreamCommit,
				],
				{ cwd: clone, capture: true },
			);
		} catch (error) {
			await runCommand(["git", "merge", "--abort"], { cwd: clone, capture: true }).catch(() => {});
			throw new AutoBotReleaseError("Pinned upstream integration has conflicts; refusing to create a candidate", {
				cause: error,
			});
		}
		await runCommand(
			[
				"git",
				"-c",
				"user.name=autobot-candidate",
				"-c",
				"user.email=autobot-candidate@invalid",
				"commit",
				"--no-gpg-sign",
				"-m",
				candidateMergeSubject(upstreamCommit),
			],
			{ cwd: clone, capture: true },
		);
		const candidateCommit = await gitOutput(clone, ["rev-parse", "HEAD"]);
		const candidateTree = await gitOutput(clone, ["rev-parse", "HEAD^{tree}"]);
		const identity = await candidateReleaseIdentity(clone, upstreamCommit, candidateCommit);
		const built = await buildCandidate(
			clone,
			runnerBun,
			compilerBun,
			candidateCommit,
			upstreamCommit,
			upstreamVersion,
			output,
		);
		await runCommand(
			["git", "bundle", "create", path.join(output, "candidate.bundle"), candidateCommit, `^${canonicalCommit}`],
			{
				cwd: clone,
				capture: true,
			},
		);
		await writeJsonAtomic(path.join(output, "candidate-provenance.json"), {
			schemaVersion: 1,
			upstreamRepository,
			canonicalBranch,
			canonicalCommit,
			upstreamRef,
			upstreamCommit,
			upstreamVersion,
			candidateCommit,
			candidateTree,
			webBundleId: built.webBundleId,
			coordinatorSourceSha256,
			compatibilityEpoch: identity.compatibilityEpoch,
			compatibilityReview: {
				required: identity.compatibilityReviewPaths.length > 0,
				paths: identity.compatibilityReviewPaths,
			},
			runtime: {
				target: identity.runtimeTarget,
				file: path.relative(output, built.runtimeFile).replaceAll("\\", "/"),
			},
			collabWeb: { target: "web", file: path.relative(output, built.webArchive).replaceAll("\\", "/") },
			toolchain: {
				runnerBunVersion: requiredOption(args, "runner-bun-version"),
				compilerBunVersion: requiredOption(args, "compiler-bun-version"),
				compilerBunSha256: compilerBunHash.sha256,
			},
		});
		await writeJsonAtomic(path.join(output, "integration-result.json"), {
			...integrationIdentity,
			outcome: "created",
		});
		console.log(`Created isolated AutoBot candidate ${candidateCommit.slice(0, 12)} for ${canonicalBranch}`);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		outputError(error);
		process.exitCode = 1;
	}
}
