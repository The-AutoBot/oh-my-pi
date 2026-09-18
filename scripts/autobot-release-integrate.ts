#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { autoBotPathRequiresCompatibilityReview } from "../packages/coding-agent/src/autobot-update/contract.ts";
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


const FULL_REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const UPSTREAM_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function requireRef(value: string, label: string): string {
	if (!FULL_REF.test(value) || value.includes("..") || value.endsWith("/") || value.includes("//")) {
		throw new AutoBotReleaseError(`${label} must be a fully qualified refs/heads/... or refs/tags/... ref`);
	}
	return value;
}

function requireBranch(value: string): string {
	if (!BRANCH.test(value) || value.includes("..") || value.endsWith("/") || value.includes("//")) {
		throw new AutoBotReleaseError("Canonical branch must be an explicit safe branch name");
	}
	return value;
}
function requireHttpsRepository(value: string, label: string): string {
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


async function resolveRemoteCommit(repository: string, ref: string, label: string): Promise<string> {
	const result = await runCommand(["git", "ls-remote", "--refs", repository, ref], { capture: true });
	const matches = result.stdout
		.split("\n")
		.map(line => line.trim().split(/\s+/, 2))
		.filter(parts => parts.length === 2 && parts[1] === ref);
	if (matches.length !== 1) throw new AutoBotReleaseError(`${label} ref did not resolve to exactly one remote object`);
	return requireCommit(matches[0]?.[0] ?? "", `${label} resolved commit`);
}

async function exactBunVersion(executable: string, expected: string, label: string): Promise<void> {
	const result = await runCommand([executable, "--version"], { capture: true });
	if (result.stdout.trim() !== expected) {
		throw new AutoBotReleaseError(`${label} version must be exactly ${expected}; found ${result.stdout.trim() || "<empty>"}`);
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


async function upstreamPackageVersion(sourceRoot: string, upstreamCommit: string): Promise<string> {
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

interface CandidateReleaseIdentity {
	readonly compatibilityEpoch: number;
	readonly compatibilityReviewPaths: readonly string[];
	readonly runtimeTarget: string;
}

async function candidateReleaseIdentity(
	sourceRoot: string,
	canonicalCommit: string,
	candidateCommit: string,
): Promise<CandidateReleaseIdentity> {
	// Candidate modules are runtime-selected from the detached clone. The producer policy below remains the non-bypassable baseline.
	const contract = await import(
		pathToFileURL(path.join(sourceRoot, "packages", "coding-agent", "src", "autobot-update", "contract.ts")).href,
	);
	const candidatePathPolicy = contract.autoBotPathRequiresCompatibilityReview;
	if (typeof candidatePathPolicy !== "function") {
		throw new AutoBotReleaseError("Candidate AutoBot contract must export autoBotPathRequiresCompatibilityReview");
	}
	const platform = await import(
		pathToFileURL(path.join(sourceRoot, "packages", "coding-agent", "src", "autobot-update", "platform.ts")).href,
	);
	if (typeof platform.currentAutoBotRuntimeTarget !== "function") {
		throw new AutoBotReleaseError("Candidate AutoBot platform module must export currentAutoBotRuntimeTarget");
	}
	const changed = await runCommand(["git", "diff", "--name-only", "--no-renames", "-z", canonicalCommit, candidateCommit], {
		cwd: sourceRoot,
		capture: true,
	});
	return {
		compatibilityEpoch: requirePositiveSafeInteger(contract.AUTO_BOT_COMPATIBILITY_EPOCH, "Candidate compatibility epoch"),
		compatibilityReviewPaths: changed.stdout
			.split("\u0000")
			.filter(Boolean)
			.filter(
				repositoryPath =>
					autoBotPathRequiresCompatibilityReview(repositoryPath) ||
					candidatePathPolicy(repositoryPath) ||
					repositoryPath === "packages/coding-agent/src/autobot-update/contract.ts",
			),
		runtimeTarget: requireString(platform.currentAutoBotRuntimeTarget(), "Candidate runtime target"),
	};
}

async function buildCandidate(
	candidate: string,
	runnerBun: string,
	compilerBun: string,
	forkCommit: string,
	upstreamCommit: string,
	upstreamVersion: string,
	output: string,
): Promise<{ readonly runtimeFile: string; readonly webArchive: string; readonly webBundleId: string }> {
	const runnerDirectory = path.dirname(runnerBun);
	const commandEnvironment: NodeJS.ProcessEnv = {
		...Bun.env,
		PATH: `${runnerDirectory}${path.delimiter}${Bun.env.PATH ?? ""}`,
	};
	await runCommand([runnerBun, "install", "--frozen-lockfile"], { cwd: candidate, env: commandEnvironment });
	// This must precede compilation: build-extension regenerates the text assets embedded into the runtime.
	await runCommand([runnerBun, "--cwd=packages/browser-relay", "run", "build"], { cwd: candidate, env: commandEnvironment });
	await Promise.all([
		fs.access(path.join(candidate, "packages", "browser-relay", "dist", "omp-browser-relay-extension.zip")),
		fs.access(path.join(candidate, "packages", "coding-agent", "src", "tools", "browser", "relay", "extension-assets", "background.js.txt")),
	]);
	await runCommand([runnerBun, "--cwd=packages/collab-web", "run", "build"], { cwd: candidate, env: commandEnvironment });
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
	// Use the candidate's packager so its exact session/collaboration contract controls the archive identity.
	const candidateWeb = await import(pathToFileURL(path.join(candidate, "scripts", "autobot-release-web.ts")).href);
	if (typeof candidateWeb.deriveManagedBundleId !== "function" || typeof candidateWeb.createManagedBundle !== "function") {
		throw new AutoBotReleaseError("Candidate release packager must export web bundle derivation and assembly functions");
	}
	const webBundleId = await candidateWeb.deriveManagedBundleId(
		path.join(candidate, "packages", "collab-web", "dist"),
		path.join(candidate, "packages", "collab-web", "public"),
	);
	const webArchive = path.join(output, `omp-collab-web-${webBundleId}.tar.gz`);
	await candidateWeb.createManagedBundle({
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
		await runCommand(["git", "fetch", "--no-tags", upstreamRepository, upstreamObject], { cwd: clone, capture: true });
		const upstreamCommit = await gitOutput(clone, ["rev-parse", "FETCH_HEAD^{commit}"]);
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
			throw new AutoBotReleaseError("Pinned upstream integration has conflicts; refusing to create a candidate", { cause: error });
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
				`chore(autobot): candidate upstream ${upstreamCommit.slice(0, 12)}`,
			],
			{ cwd: clone, capture: true },
		);
		const candidateCommit = await gitOutput(clone, ["rev-parse", "HEAD"]);
		const candidateTree = await gitOutput(clone, ["rev-parse", "HEAD^{tree}"]);
		const identity = await candidateReleaseIdentity(clone, canonicalCommit, candidateCommit);
		const built = await buildCandidate(
			clone,
			runnerBun,
			compilerBun,
			candidateCommit,
			upstreamCommit,
			upstreamVersion,
			output,
		);
		await runCommand(["git", "bundle", "create", path.join(output, "candidate.bundle"), candidateCommit, `^${canonicalCommit}`], {
			cwd: clone,
			capture: true,
		});
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
			runtime: { target: identity.runtimeTarget, file: path.relative(output, built.runtimeFile).replaceAll("\\", "/") },
			collabWeb: { target: "web", file: path.relative(output, built.webArchive).replaceAll("\\", "/") },
			toolchain: {
				runnerBunVersion: requiredOption(args, "runner-bun-version"),
				compilerBunVersion: requiredOption(args, "compiler-bun-version"),
				compilerBunSha256: compilerBunHash.sha256,
			},
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
