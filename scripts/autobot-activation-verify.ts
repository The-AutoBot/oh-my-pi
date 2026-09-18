#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../packages/utils/src/type-guards.ts";
import {
	AutoBotReleaseError,
	assertKnownOptions,
	createEmptyDirectory,
	gitOutput,
	hashFile,
	outputError,
	parseCliArgs,
	readJson,
	requireCommit,
	requirePositiveSafeInteger,
	requireSha256,
	requiredOption,
	runCommand,
	writeJsonAtomic,
} from "./autobot-release-common.ts";

const ACTIVATION_REPOSITORY = "The-AutoBot/oh-my-pi";
const CANONICAL_BRANCH = "autobot/auto-collab";
const HELPER_BRANCH = "autobot/activation-validator";
const RUNNER_BUN_VERSION = "1.3.14";
const COMPILER_BUN_VERSION = "1.4.0";
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_BRANCH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_UPSTREAM_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const SAFE_WEB_BUNDLE_ID = /^web-[0-9a-f]{64}$/;

interface CandidateReleaseIdentity {
	readonly compatibilityEpoch: unknown;
	readonly compatibilityReviewPaths: unknown;
	readonly runtimeTarget: unknown;
}

interface CandidateBuild {
	readonly runtimeFile: string;
	readonly webArchive: string;
	readonly webBundleId: string;
}

interface OperatorIntegrator {
	candidateReleaseIdentity(
		sourceRoot: string,
		canonicalCommit: string,
		candidateCommit: string,
	): Promise<CandidateReleaseIdentity>;
	buildCandidate(
		candidate: string,
		runnerBun: string,
		compilerBun: string,
		forkCommit: string,
		upstreamCommit: string,
		upstreamVersion: string,
		output: string,
	): Promise<CandidateBuild>;
}

interface RetainedCandidateMerge {
	readonly canonicalCommit: string;
	readonly candidateMergeCommit: string;
}

interface RecognizedReleasePlan {
	readonly upstreamVersion: string;
}

function requireBranch(value: string, label: string): string {
	if (
		!SAFE_BRANCH.test(value) ||
		value.includes("..") ||
		value.includes("//") ||
		value.endsWith("/") ||
		value.split("/").some(segment => !SAFE_BRANCH_SEGMENT.test(segment) || segment.endsWith(".lock"))
	) {
		throw new AutoBotReleaseError(`${label} must be a safe explicit branch name`);
	}
	return value;
}

function requireExpectedRepository(value: string): string {
	if (value !== ACTIVATION_REPOSITORY) {
		throw new AutoBotReleaseError(`Activation verification is restricted to ${ACTIVATION_REPOSITORY}`);
	}
	return value;
}

function repositoryUrl(repository: string): string {
	return `https://github.com/${repository}.git`;
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSeparateCheckouts(operatorRoot: string, candidateRoot: string): void {
	if (isWithin(operatorRoot, candidateRoot) || isWithin(candidateRoot, operatorRoot)) {
		throw new AutoBotReleaseError("Operator source and candidate source must be separate checkouts");
	}
}

async function exactBunVersion(executable: string, expected: string, label: string): Promise<void> {
	const result = await runCommand([executable, "--version"], { capture: true });
	if (result.stdout.trim() !== expected) {
		throw new AutoBotReleaseError(
			`${label} version must be exactly ${expected}; found ${result.stdout.trim() || "<empty>"}`,
		);
	}
}

async function resolveRemoteBranchHead(repository: string, branch: string, label: string): Promise<string> {
	const ref = `refs/heads/${branch}`;
	const result = await runCommand(["git", "ls-remote", "--refs", repository, ref], { capture: true });
	const matches = result.stdout
		.split("\n")
		.map(line => line.trim().split(/\s+/, 2))
		.filter(parts => parts.length === 2 && parts[1] === ref);
	if (matches.length !== 1) {
		throw new AutoBotReleaseError(`${label} branch did not resolve to exactly one remote commit`);
	}
	return requireCommit(matches[0]?.[0] ?? "", `${label} branch head`);
}

async function readRecognizedReleasePlan(
	pathname: string,
	candidateCommit: string,
	upstreamCommit: string,
): Promise<RecognizedReleasePlan> {
	const parsed = await readJson(pathname, "AutoBot release-plan result");
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== 1 ||
		parsed.ready !== true ||
		typeof parsed.forkCommit !== "string" ||
		typeof parsed.upstreamCommit !== "string" ||
		typeof parsed.upstreamVersion !== "string"
	) {
		throw new AutoBotReleaseError("Release-plan did not recognize a ready retained AutoBot candidate merge");
	}
	const plannedCandidate = requireCommit(parsed.forkCommit, "Release-plan fork commit");
	const plannedUpstream = requireCommit(parsed.upstreamCommit, "Release-plan upstream commit");
	if (plannedCandidate !== candidateCommit || plannedUpstream !== upstreamCommit) {
		throw new AutoBotReleaseError(
			"Release-plan recognition does not match the pinned candidate and upstream commits",
		);
	}
	if (!SAFE_UPSTREAM_VERSION.test(parsed.upstreamVersion)) {
		throw new AutoBotReleaseError("Release-plan upstream version is unsafe");
	}
	return { upstreamVersion: parsed.upstreamVersion };
}

async function findRetainedCandidateMerge(
	sourceRoot: string,
	canonicalCommit: string,
	candidateCommit: string,
	upstreamCommit: string,
): Promise<RetainedCandidateMerge> {
	const expectedSubject = `chore(autobot): candidate upstream ${upstreamCommit.slice(0, 12)}`;
	await runCommand(["git", "merge-base", "--is-ancestor", canonicalCommit, candidateCommit], {
		cwd: sourceRoot,
		capture: true,
	});
	const history = await runCommand(["git", "log", "--topo-order", "--format=%H%x00%s", candidateCommit], {
		cwd: sourceRoot,
		capture: true,
	});
	for (const row of history.stdout.split("\n")) {
		const separator = row.indexOf("\u0000");
		if (separator === -1) continue;
		const commit = requireCommit(row.slice(0, separator), "Candidate history commit");
		if (row.slice(separator + 1) !== expectedSubject) continue;
		const parents = (await gitOutput(sourceRoot, ["show", "-s", "--format=%P", commit])).split(/\s+/).filter(Boolean);
		if (parents.length !== 2) {
			throw new AutoBotReleaseError(`Retained AutoBot candidate ${commit} must have exactly two parents`);
		}
		const firstParent = requireCommit(parents[0] ?? "", "Retained candidate canonical parent");
		const secondParent = requireCommit(parents[1] ?? "", "Retained candidate upstream parent");
		if (firstParent !== canonicalCommit) {
			await runCommand(["git", "merge-base", "--is-ancestor", commit, canonicalCommit], {
				cwd: sourceRoot,
				capture: true,
			});
		}
		if (secondParent !== upstreamCommit) {
			throw new AutoBotReleaseError(
				"Retained AutoBot candidate second parent does not match the pinned upstream commit",
			);
		}
		await runCommand(["git", "merge-base", "--is-ancestor", upstreamCommit, commit], {
			cwd: sourceRoot,
			capture: true,
		});
		await runCommand(["git", "merge-base", "--is-ancestor", commit, candidateCommit], {
			cwd: sourceRoot,
			capture: true,
		});
		return { canonicalCommit, candidateMergeCommit: commit };
	}
	throw new AutoBotReleaseError("Pinned candidate does not retain the required reconciled AutoBot merge commit");
}

async function loadOperatorIntegrator(
	operatorRoot: string,
): Promise<{ readonly integrator: OperatorIntegrator; readonly temporary: string }> {
	const original = path.join(operatorRoot, "scripts", "autobot-release-integrate.ts");
	const temporary = path.join(path.dirname(original), `.autobot-activation-integrate-${crypto.randomUUID()}.ts`);
	const contents = await fs.readFile(original, "utf8");
	await fs.writeFile(
		temporary,
		`${contents}\n\n// Temporary operator-side export seam for activation verification only.\nexport { buildCandidate, candidateReleaseIdentity };\n`,
		{ encoding: "utf8", flag: "wx" },
	);
	try {
		// Dynamic import keeps the copied module's import.meta.main false.
		const imported = await import(`${pathToFileURL(temporary).href}?activation-verify=${crypto.randomUUID()}`);
		if (typeof imported.buildCandidate !== "function" || typeof imported.candidateReleaseIdentity !== "function") {
			throw new AutoBotReleaseError("Operator integrator did not expose the required activation validation helpers");
		}
		return { integrator: imported as OperatorIntegrator, temporary };
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	assertKnownOptions(args, [
		"operator-root",
		"candidate-root",
		"repository",
		"canonical-branch",
		"candidate-branch",
		"candidate-commit",
		"upstream-commit",
		"runner-bun",
		"compiler-bun",
		"compiler-bun-sha256",
		"out",
	]);
	const operatorRoot = await fs.realpath(path.resolve(requiredOption(args, "operator-root")));
	const candidateRoot = await fs.realpath(path.resolve(requiredOption(args, "candidate-root")));
	assertSeparateCheckouts(operatorRoot, candidateRoot);
	const repository = requireExpectedRepository(requiredOption(args, "repository"));
	const canonicalBranch = requireBranch(requiredOption(args, "canonical-branch"), "Canonical branch");
	if (canonicalBranch !== CANONICAL_BRANCH) {
		throw new AutoBotReleaseError(`Activation verification is restricted to canonical branch ${CANONICAL_BRANCH}`);
	}
	const candidateBranch = requireBranch(requiredOption(args, "candidate-branch"), "Candidate branch");
	if (candidateBranch === canonicalBranch || candidateBranch === HELPER_BRANCH) {
		throw new AutoBotReleaseError("Candidate branch must not be the canonical or helper branch");
	}
	const candidateCommit = requireCommit(requiredOption(args, "candidate-commit"), "Pinned candidate commit");
	const upstreamCommit = requireCommit(requiredOption(args, "upstream-commit"), "Pinned upstream commit");
	const runnerBun = path.resolve(requiredOption(args, "runner-bun"));
	const compilerBun = path.resolve(requiredOption(args, "compiler-bun"));
	const expectedCompilerHash = requireSha256(requiredOption(args, "compiler-bun-sha256"), "Compiler Bun SHA-256");
	const output = path.resolve(requiredOption(args, "out"));
	const expectedRepositoryUrl = repositoryUrl(repository);

	await exactBunVersion(runnerBun, RUNNER_BUN_VERSION, "Runner Bun");
	await exactBunVersion(compilerBun, COMPILER_BUN_VERSION, "Compiler Bun");
	const compilerHash = await hashFile(compilerBun);
	if (compilerHash.sha256 !== expectedCompilerHash) {
		throw new AutoBotReleaseError("Compiler Bun SHA-256 does not match the separately captured compiler identity");
	}
	const [operatorIntegratorHash, operatorReleasePlanHash] = await Promise.all([
		hashFile(path.join(operatorRoot, "scripts", "autobot-release-integrate.ts")),
		hashFile(path.join(operatorRoot, "scripts", "autobot-release-plan.ts")),
	]);
	const actualOrigin = await gitOutput(candidateRoot, ["remote", "get-url", "origin"]);
	if (actualOrigin !== expectedRepositoryUrl) {
		throw new AutoBotReleaseError("Candidate checkout origin is not the expected activation repository");
	}
	const actualHead = requireCommit(
		await gitOutput(candidateRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
		"Candidate checkout HEAD",
	);
	if (actualHead !== candidateCommit) {
		throw new AutoBotReleaseError("Candidate checkout HEAD does not match the immutable candidate commit");
	}
	const [remoteCandidateCommit, canonicalCommit] = await Promise.all([
		resolveRemoteBranchHead(expectedRepositoryUrl, candidateBranch, "Candidate"),
		resolveRemoteBranchHead(expectedRepositoryUrl, canonicalBranch, "Canonical"),
	]);
	if (remoteCandidateCommit !== candidateCommit) {
		throw new AutoBotReleaseError("Candidate branch head does not match the immutable candidate commit");
	}

	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autobot-activation-"));
	try {
		const releasePlanPath = path.join(temporary, "release-plan.json");
		await runCommand(
			[
				runnerBun,
				path.join(operatorRoot, "scripts", "autobot-release-plan.ts"),
				"--source-root",
				candidateRoot,
				"--out",
				releasePlanPath,
			],
			{ cwd: operatorRoot },
		);
		const releasePlan = await readRecognizedReleasePlan(releasePlanPath, candidateCommit, upstreamCommit);
		const retainedMerge = await findRetainedCandidateMerge(
			candidateRoot,
			canonicalCommit,
			candidateCommit,
			upstreamCommit,
		);
		const candidateTree = requireCommit(
			await gitOutput(candidateRoot, ["rev-parse", "--verify", `${candidateCommit}^{tree}`]),
			"Candidate tree",
		);

		const loadedIntegrator = await loadOperatorIntegrator(operatorRoot);
		let identity: CandidateReleaseIdentity;
		let built: CandidateBuild;
		try {
			identity = await loadedIntegrator.integrator.candidateReleaseIdentity(
				candidateRoot,
				retainedMerge.canonicalCommit,
				candidateCommit,
			);
			const compatibilityEpoch = requirePositiveSafeInteger(
				identity.compatibilityEpoch,
				"Candidate compatibility epoch",
			);
			if (
				!Array.isArray(identity.compatibilityReviewPaths) ||
				!identity.compatibilityReviewPaths.every(repositoryPath => typeof repositoryPath === "string") ||
				typeof identity.runtimeTarget !== "string"
			) {
				throw new AutoBotReleaseError("Candidate release identity returned an unsafe compatibility result");
			}
			built = await loadedIntegrator.integrator.buildCandidate(
				candidateRoot,
				runnerBun,
				compilerBun,
				candidateCommit,
				upstreamCommit,
				releasePlan.upstreamVersion,
				temporary,
			);
			if (!SAFE_WEB_BUNDLE_ID.test(built.webBundleId)) {
				throw new AutoBotReleaseError("Candidate collab-web bundle ID is unsafe");
			}

			const evidenceDirectory = await createEmptyDirectory(output, "Activation verification evidence directory");
			await writeJsonAtomic(path.join(evidenceDirectory, "verification-provenance.json"), {
				schemaVersion: 1,
				verification: "autobot-manual-upstream-reconciliation",
				repository,
				canonical: { branch: canonicalBranch, commit: canonicalCommit },
				candidate: {
					branch: candidateBranch,
					commit: candidateCommit,
					tree: candidateTree,
					retainedMergeCommit: retainedMerge.candidateMergeCommit,
				},
				upstream: { commit: upstreamCommit, version: releasePlan.upstreamVersion },
				compatibilityReview: {
					required: identity.compatibilityReviewPaths.length > 0,
					pathCount: identity.compatibilityReviewPaths.length,
					compatibilityEpoch,
				},
				webBundleId: built.webBundleId,
				toolchain: {
					runnerBunVersion: RUNNER_BUN_VERSION,
					compilerBunVersion: COMPILER_BUN_VERSION,
					compilerBunSha256: compilerHash.sha256,
				},
				operatorSource: {
					integratorSha256: operatorIntegratorHash.sha256,
					releasePlanSha256: operatorReleasePlanHash.sha256,
				},
			});
			console.log(
				`Validated immutable AutoBot candidate ${candidateCommit.slice(0, 12)} with retained merge ${retainedMerge.candidateMergeCommit.slice(0, 12)}`,
			);
		} finally {
			await fs.rm(loadedIntegrator.temporary, { force: true }).catch(() => {});
		}
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
