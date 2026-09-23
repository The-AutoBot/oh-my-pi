import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureAutoBotPrivateDirectory } from "../packages/coding-agent/src/autobot-update/permissions.ts";
import {
	createLocalCommandRecorder,
	LOCAL_COMMAND_DIAGNOSTICS_FILENAME,
	LOCAL_COMMAND_OUTPUT_FILENAME,
} from "../scripts/autobot-local.ts";
import { candidateReleaseIdentity } from "../scripts/autobot-release-integrate.ts";
import { runLocalOmp } from "../scripts/autobot-local-omp.ts";
import { runQuiet } from "../scripts/autobot-local-release.ts";
import type { LocalAutomationConfig } from "../scripts/autobot-local-types.ts";

const temporaryDirectories: string[] = [];
// These tests exercise real Windows ACL checks, atomic journals, and child
// processes. Bound each by its observed OS-I/O workload without weakening guards.
const FAILED_COMMAND_TIMEOUT_MS = 60_000;
const BOUNDED_OUTPUT_TIMEOUT_MS = 120_000;
const STRUCTURAL_JOURNAL_TIMEOUT_MS = 17 * 15_000 + 45_000;
const OMP_PROCESS_TIMEOUT_MS = 90_000;

async function createPrivateRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.homedir(), "omp-autobot-local-diagnostics-"));
	temporaryDirectories.push(root);
	return ensureAutoBotPrivateDirectory(root);
}

function journalPath(workRoot: string): string {
	return path.join(workRoot, LOCAL_COMMAND_DIAGNOSTICS_FILENAME);
}

afterEach(async () => {
	const directories = temporaryDirectories.splice(0);
	await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function runGit(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`);
	return stdout.trim();
}

async function createReleaseIdentityFixture(): Promise<string> {
	const workRoot = await createPrivateRoot();
	const worktree = path.join(workRoot, "worktree");
	await fs.mkdir(worktree);
	await runGit(worktree, "init", "-b", "main");
	await runGit(worktree, "config", "user.name", "fixture");
	await runGit(worktree, "config", "user.email", "fixture@invalid");
	const contractPath = path.join(
		worktree,
		"packages",
		"coding-agent",
		"src",
		"autobot-update",
		"contract.ts",
	);
	await fs.mkdir(path.dirname(contractPath), { recursive: true });
	await fs.copyFile(
		path.join(import.meta.dir, "..", "packages", "coding-agent", "src", "autobot-update", "contract.ts"),
		contractPath,
	);
	return worktree;
}

async function createLargeHistoricalMergeChain(cwd: string, mergeCount: number): Promise<void> {
	const commands = [
		"blob\nmark :1\ndata 5\nbase\n",
		"commit refs/heads/main\nmark :2\ncommitter fixture <fixture@invalid> 1700000000 +0000\ndata 4\nroot\nM 100644 :1 historical.txt\n",
	];
	let mainMark = 2;
	let nextMark = 3;
	for (let index = 0; index < mergeCount; index++) {
		commands.push(
			`commit refs/heads/historical-side\nmark :${nextMark}\ncommitter fixture <fixture@invalid> ${1700000001 + index * 2} +0000\ndata 4\nside\nfrom :${mainMark}\n`,
			`commit refs/heads/main\nmark :${nextMark + 1}\ncommitter fixture <fixture@invalid> ${1700000002 + index * 2} +0000\ndata 5\nmerge\nfrom :${mainMark}\nmerge :${nextMark}\n`,
		);
		mainMark = nextMark + 1;
		nextMark += 2;
	}
	const child = Bun.spawn(["git", "fast-import", "--quiet"], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	child.stdin.write(commands.join(""));
	child.stdin.end();
	const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`git fast-import failed: ${stderr}`);
	await runGit(cwd, "reset", "--hard", "main");
}

test(
	"records a real failed quiet command without persisting its stream or argument canary",
	async () => {
		const workRoot = await createPrivateRoot();
		const recorder = await createLocalCommandRecorder(workRoot);
		const secret = "local-diagnostics-secret-canary";
		const script = [
			`process.stdout.write(${JSON.stringify(secret)});`,
			`process.stderr.write(${JSON.stringify(secret)});`,
			"process.exit(23);",
		].join("");

		await expect(
			runQuiet(recorder, "runtime-compilation", "Candidate application compilation", [
				process.execPath,
				"-e",
				script,
			]),
		).rejects.toThrow();

		const text = await fs.readFile(journalPath(workRoot), "utf8");
		expect(text).not.toContain(secret);
		expect(JSON.parse(text)).toEqual({
			schemaVersion: 2,
			records: [
				{
					stage: "release",
					commandKind: "runtime-compilation",
					outcome: "started",
					timedOut: false,
				},
				{
					stage: "release",
					commandKind: "runtime-compilation",
					outcome: "exited",
					timedOut: false,
					exitCode: 23,
					durationMs: expect.any(Number),
				},
			],
		});
	},
	FAILED_COMMAND_TIMEOUT_MS,
);
test(
	"retains only bounded redacted output for explicitly captured candidate commands",
	async () => {
		const workRoot = await createPrivateRoot();
		const recorder = await createLocalCommandRecorder(workRoot);
		const credential = "github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const failureTail = "FAILURE: compiler exited after final diagnostic";
		await recorder.recordOutput?.({
			commandKind: "runtime-compilation",
			stdout: `download https://example.test/private?q=secret token=${credential}\n${"α".repeat(20_000)}\n${failureTail}`,
			stderr: "password=hunter2",
			truncated: false,
		});

		const text = await fs.readFile(path.join(workRoot, LOCAL_COMMAND_OUTPUT_FILENAME), "utf8");
		expect(text).not.toContain("example.test");
		expect(text).not.toContain(credential);
		expect(text).not.toContain("hunter2");
		expect(text).toContain("...[durable output omitted]...");
		expect(text).toContain(failureTail);
		const parsed = JSON.parse(text);
		expect(parsed.schemaVersion).toBe(2);
		expect(parsed.records).toHaveLength(1);
		expect(parsed.records[0]).toEqual({
			commandKind: "runtime-compilation",
			stdout: expect.any(String),
			stderr: "password=[REDACTED]",
			truncated: true,
		});
		expect(Buffer.byteLength(parsed.records[0].stdout, "utf8")).toBeLessThanOrEqual(
			32 * 1024 + Buffer.byteLength("\n...[durable output omitted]...\n", "utf8"),
		);
		for (let index = 0; index < 8; index++) {
			await recorder.recordOutput?.({
				commandKind: "runtime-compilation",
				stdout: `${index}:${"x".repeat(40_000)}:tail-${index}`,
				stderr: "",
				truncated: false,
			});
		}
		const retainedPath = path.join(workRoot, LOCAL_COMMAND_OUTPUT_FILENAME);
		const retained = JSON.parse(await fs.readFile(retainedPath, "utf8"));
		expect(retained.records).toHaveLength(8);
		expect(retained.records.at(-1).stdout).toContain("tail-7");
		expect((await fs.stat(retainedPath)).size).toBeLessThanOrEqual(1024 * 1024);
		await expect(createLocalCommandRecorder(workRoot)).resolves.toBeDefined();
	},
	BOUNDED_OUTPUT_TIMEOUT_MS,
);

test(
	"retains the newest sixteen structural records and rejects malformed or oversized journals",
	async () => {
		const workRoot = await createPrivateRoot();
		const recorder = await createLocalCommandRecorder(workRoot);

		const writeDurations: number[] = [];
		for (let exitCode = 0; exitCode < 17; exitCode++) {
			const startedAt = performance.now();
			await recorder.record({
				stage: "release",
				commandKind: "runtime-compilation",
				outcome: "exited",
				timedOut: false,
				exitCode,
				durationMs: exitCode,
			});
			writeDurations.push(performance.now() - startedAt);
		}
		console.log(
			`Structural journal ACL writes: total=${Math.round(writeDurations.reduce((sum, value) => sum + value, 0))}ms max=${Math.round(Math.max(...writeDurations))}ms`,
		);

		const retained = JSON.parse(await fs.readFile(journalPath(workRoot), "utf8"));
		expect(retained.records).toHaveLength(16);
		expect(retained.records.map((record: { exitCode: number }) => record.exitCode)).toEqual(
			Array.from({ length: 16 }, (_, index) => index + 1),
		);
		await fs.writeFile(
			journalPath(workRoot),
			JSON.stringify({
				schemaVersion: 1,
				records: [{ stage: "release", commandKind: "retired-command-kind", outcome: "started", timedOut: false }],
			}),
		);
		const migratedRecorder = await createLocalCommandRecorder(workRoot);
		await migratedRecorder.record({
			stage: "release",
			commandKind: "runtime-compilation",
			outcome: "started",
			timedOut: false,
		});
		expect(JSON.parse(await fs.readFile(journalPath(workRoot), "utf8"))).toEqual({
			schemaVersion: 2,
			records: [{ stage: "release", commandKind: "runtime-compilation", outcome: "started", timedOut: false }],
		});

		await fs.writeFile(
			journalPath(workRoot),
			JSON.stringify({
				schemaVersion: 2,
				records: [
					{
						stage: "release",
						commandKind: "runtime-compilation",
						outcome: "exited",
						timedOut: false,
						exitCode: 1,
						durationMs: 1,
						unexpected: true,
					},
				],
			}),
		);
		await expect(createLocalCommandRecorder(workRoot)).rejects.toThrow();

		await fs.writeFile(journalPath(workRoot), "x".repeat(9 * 1024));
		await expect(createLocalCommandRecorder(workRoot)).rejects.toThrow();
	},
	STRUCTURAL_JOURNAL_TIMEOUT_MS,
);

test("flushes nested orchestration and prior persistence timings as bounded aggregate records", async () => {
	const workRoot = await createPrivateRoot();
	const recorder = await createLocalCommandRecorder(workRoot);
	if (!recorder.measure || !recorder.flushMeasurements) throw new Error("Recorder timing aggregation is unavailable");
	await recorder.measure("source-synchronization", true, async () => {
		await recorder.record({
			stage: "release",
			commandKind: "release-plan",
			outcome: "started",
			timedOut: false,
		});
	});
	await expect(
		recorder.measure("candidate-admission", true, async () => {
			throw new Error("timed operation failed");
		}),
	).rejects.toThrow();
	await recorder.flushMeasurements();

	const records = JSON.parse(await fs.readFile(journalPath(workRoot), "utf8")).records;
	expect(records).toContainEqual({
		stage: "release",
		commandKind: "source-synchronization",
		outcome: "exited",
		timedOut: false,
		exitCode: 0,
		durationMs: expect.any(Number),
		operationCount: 1,
		failureCount: 0,
		nested: true,
	});
	expect(records).toContainEqual({
		stage: "release",
		commandKind: "diagnostic-persistence",
		outcome: "exited",
		timedOut: false,
		exitCode: 0,
		durationMs: expect.any(Number),
		operationCount: 1,
		failureCount: 0,
		nested: false,
	});
	expect(records).toContainEqual({
		stage: "release",
		commandKind: "candidate-admission",
		outcome: "exited",
		timedOut: false,
		exitCode: 0,
		durationMs: expect.any(Number),
		operationCount: 1,
		failureCount: 1,
		nested: true,
	});
}, FAILED_COMMAND_TIMEOUT_MS);

if (process.platform === "win32" && process.arch === "x64") {
	test(
		"records a provider-free local timeout before rejecting the OMP invocation",
		async () => {
			const workRoot = await createPrivateRoot();
			const worktree = path.join(workRoot, "worktree");
			await fs.mkdir(worktree);
			const wrapper = path.join(workRoot, "timeout-wrapper.cmd");
			const secret = "local-omp-timeout-canary";
			await fs.writeFile(
				wrapper,
				["@echo off", `echo ${secret}`, `echo ${secret} 1>&2`, "ping 127.0.0.1 -n 6 >nul"].join("\r\n"),
				"utf8",
			);
			const recorder = await createLocalCommandRecorder(workRoot);
			const config: LocalAutomationConfig = {
				schemaVersion: 1,
				repository: "The-AutoBot/oh-my-pi",
				canonicalBranch: "main",
				integrationBranch: "autobot-local",
				upstreamRepository: "https://github.com/example/upstream.git",
				upstreamRef: "latest-release",
				workRoot,
				runnerBun: process.execPath,
				runnerBunVersion: "0.0.0",
				compilerBun: process.execPath,
				compilerBunVersion: "0.0.0",
				nativeAddonDirectory: workRoot,
				nativeAddonProvenanceSha256: "a".repeat(64),
				ompExecutable: wrapper,
				coordinatorRoot: workRoot,
				keyId: "test-key",
				privateKeyPath: wrapper,
				publicKeyPath: wrapper,
				channelRepository: "The-AutoBot/channel",
				channelBranch: "main",
				channelPath: "signed-envelope.json",
				allowInitial: false,
				maxOmpAttempts: 0,
				ompMaxTime: "0.001s",
			};

			await expect(
				runLocalOmp(
					config,
					{
						cwd: worktree,
						reason: "build-failure",
						forkCommit: "a".repeat(40),
						upstreamCommit: "b".repeat(40),
						sensitivePaths: [],
						failedStepContext: {
							stepId: "runtime-compilation",
							permittedSourcePaths: ["packages/coding-agent/src"],
						},
					},
					recorder,
				),
			).rejects.toThrow();

			const text = await fs.readFile(journalPath(workRoot), "utf8");
			expect(text).not.toContain(secret);
			const records = JSON.parse(text).records;
			expect(records.at(-2)).toEqual({
				stage: "omp",
				commandKind: "omp-invocation",
				outcome: "started",
				timedOut: false,
			});
			expect(records.at(-1)).toEqual({
				stage: "omp",
				commandKind: "omp-invocation",
				outcome: "timed-out",
				timedOut: true,
				durationMs: expect.any(Number),
			});
		},
		OMP_PROCESS_TIMEOUT_MS,
	);
	test(
		"reports a successful resolver that omits its mandatory repair intent",
		async () => {
			const workRoot = await createPrivateRoot();
			const worktree = path.join(workRoot, "worktree");
			await fs.mkdir(worktree);
			const wrapper = path.join(workRoot, "omit-repair-intent.cmd");
			await fs.writeFile(wrapper, "@echo off\r\nexit /b 0\r\n", "utf8");
			const recorder = await createLocalCommandRecorder(workRoot);
			const config: LocalAutomationConfig = {
				schemaVersion: 1,
				repository: "The-AutoBot/oh-my-pi",
				canonicalBranch: "main",
				integrationBranch: "autobot-local",
				upstreamRepository: "https://github.com/example/upstream.git",
				upstreamRef: "latest-release",
				workRoot,
				runnerBun: process.execPath,
				runnerBunVersion: "0.0.0",
				compilerBun: process.execPath,
				compilerBunVersion: "0.0.0",
				nativeAddonDirectory: workRoot,
				nativeAddonProvenanceSha256: "a".repeat(64),
				ompExecutable: wrapper,
				coordinatorRoot: workRoot,
				keyId: "test-key",
				privateKeyPath: wrapper,
				publicKeyPath: wrapper,
				channelRepository: "The-AutoBot/channel",
				channelBranch: "main",
				channelPath: "signed-envelope.json",
				allowInitial: false,
				maxOmpAttempts: 1,
				ompMaxTime: "30s",
			};

			await expect(
				runLocalOmp(
					config,
					{
						cwd: worktree,
						reason: "conflicts",
						forkCommit: "a".repeat(40),
						upstreamCommit: "b".repeat(40),
						sensitivePaths: [],
					},
					recorder,
				),
			).rejects.toThrow("Local OMP returned without a repair intent");
			const records = JSON.parse(await fs.readFile(journalPath(workRoot), "utf8")).records;
			expect(records.at(-1)).toEqual({
				stage: "omp",
				commandKind: "omp-invocation",
				outcome: "exited",
				timedOut: false,
				exitCode: 0,
				durationMs: expect.any(Number),
			});
		},
		OMP_PROCESS_TIMEOUT_MS,
	);
	test(
		"rejects invalid failed-step authority before launch and passes only the validated identity and source scope",
		async () => {
			const workRoot = await createPrivateRoot();
			const worktree = path.join(workRoot, "worktree");
			await fs.mkdir(worktree);
			const capturePath = path.join(workRoot, "captured-build-context.json");
			const wrapperScript = path.join(workRoot, "capture-build-context.ts");
			await fs.writeFile(
				wrapperScript,
				[
					'import * as fs from "node:fs/promises";',
					"const contextArgument = process.argv.find(value => value.startsWith('@') && value.endsWith('context.md'));",
					"if (contextArgument === undefined) process.exit(2);",
					"const text = await fs.readFile(contextArgument.slice(1), 'utf8');",
					"const context = JSON.parse(text.slice(text.indexOf('\\n') + 1));",
					`await fs.writeFile(${JSON.stringify(capturePath)}, JSON.stringify(context));`,
					"await fs.writeFile(context.repairIntent.path, JSON.stringify({ schemaVersion: 1, nonce: context.repairIntent.nonce, paths: [] }));",
				].join("\n"),
			);
			const wrapper = path.join(workRoot, "capture-build-context.cmd");
			await fs.writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${wrapperScript}" %*\r\n`, "utf8");
			const recorder = await createLocalCommandRecorder(workRoot);
			const config: LocalAutomationConfig = {
				schemaVersion: 1,
				repository: "The-AutoBot/oh-my-pi",
				canonicalBranch: "main",
				integrationBranch: "autobot-local",
				upstreamRepository: "https://github.com/example/upstream.git",
				upstreamRef: "latest-release",
				workRoot,
				runnerBun: process.execPath,
				runnerBunVersion: "0.0.0",
				compilerBun: process.execPath,
				compilerBunVersion: "0.0.0",
				nativeAddonDirectory: workRoot,
				nativeAddonProvenanceSha256: "a".repeat(64),
				ompExecutable: wrapper,
				coordinatorRoot: workRoot,
				keyId: "test-key",
				privateKeyPath: wrapper,
				publicKeyPath: wrapper,
				channelRepository: "The-AutoBot/channel",
				channelBranch: "main",
				channelPath: "signed-envelope.json",
				allowInitial: false,
				maxOmpAttempts: 1,
				ompMaxTime: "30s",
			};
			const request = {
				cwd: worktree,
				reason: "build-failure" as const,
				forkCommit: "a".repeat(40),
				upstreamCommit: "b".repeat(40),
				sensitivePaths: ["unrelated/general-repair-brief.ts"],
			};
			const invalidContexts: unknown[] = [
				undefined,
				{ stepId: "unknown-step", permittedSourcePaths: ["packages/coding-agent/src"] },
				{ stepId: "runtime-compilation", permittedSourcePaths: ["packages/unknown/src"] },
				{
					stepId: "runtime-compilation",
					permittedSourcePaths: ["packages/coding-agent/src"],
					command: ["bun", "run", "build"],
				},
			];
			for (const failedStepContext of invalidContexts) {
				await expect(
					runLocalOmp(
						config,
						{ ...request, failedStepContext } as Parameters<typeof runLocalOmp>[1],
						recorder,
					),
				).rejects.toThrow();
				await expect(fs.stat(capturePath)).rejects.toThrow();
			}
			await expect(
				runLocalOmp(
					config,
					{
						...request,
						reason: "compatibility",
						failedStepContext: {
							stepId: "runtime-compilation",
							permittedSourcePaths: ["packages/coding-agent/src"],
						},
					},
					recorder,
				),
			).rejects.toThrow();
			await expect(fs.stat(capturePath)).rejects.toThrow();

			await expect(
				runLocalOmp(
					config,
					{
						...request,
						failedStepContext: {
							stepId: "runtime-compilation",
							permittedSourcePaths: ["packages/coding-agent/src"],
						},
					},
					recorder,
				),
			).resolves.toEqual({ repairIntent: { paths: [] } });
			const context = JSON.parse(await fs.readFile(capturePath, "utf8"));
			expect(context.failedStepContext).toEqual({
				stepId: "runtime-compilation",
				permittedSourcePaths: ["packages/coding-agent/src"],
			});
			expect(context.affectedPaths).toEqual([]);
			expect(context.failedStepContext).not.toHaveProperty("command");
			expect(context.failedStepContext).not.toHaveProperty("argv");
			expect(context.failedStepContext).not.toHaveProperty("continuation");
			expect(context.failedStepContext).not.toHaveProperty("skipChecks");
		},
		OMP_PROCESS_TIMEOUT_MS,
	);
	test("selects maintained compatibility changes relative to the pinned upstream release", async () => {
		const worktree = await createReleaseIdentityFixture();
		const maintainedPath = "packages/coding-agent/src/session/maintained.ts";
		const upstreamOnlyPath = "packages/coding-agent/src/config/upstream-only.ts";
		const policyExcludedPath = "packages/unrelated/maintained.ts";
		const maintainedFile = path.join(worktree, ...maintainedPath.split("/"));
		const upstreamOnlyFile = path.join(worktree, ...upstreamOnlyPath.split("/"));
		const policyExcludedFile = path.join(worktree, ...policyExcludedPath.split("/"));
		await fs.mkdir(path.dirname(maintainedFile), { recursive: true });
		await fs.mkdir(path.dirname(upstreamOnlyFile), { recursive: true });
		await fs.mkdir(path.dirname(policyExcludedFile), { recursive: true });
		await fs.writeFile(maintainedFile, "export const maintained = 'base';\n");
		await fs.writeFile(upstreamOnlyFile, "export const upstreamOnly = 'base';\n");
		await fs.writeFile(policyExcludedFile, "export const unrelated = 'base';\n");
		await runGit(worktree, "add", ".");
		await runGit(worktree, "commit", "-m", "base");
		await runGit(worktree, "branch", "upstream");

		await fs.writeFile(maintainedFile, "export const maintained = 'fork';\n");
		await fs.writeFile(policyExcludedFile, "export const unrelated = 'fork';\n");
		await runGit(worktree, "commit", "-am", "maintained fork behavior");
		const canonicalCommit = await runGit(worktree, "rev-parse", "HEAD");

		await runGit(worktree, "checkout", "upstream");
		await fs.writeFile(upstreamOnlyFile, "export const upstreamOnly = 'released';\n");
		await runGit(worktree, "commit", "-am", "released upstream behavior");
		const upstreamCommit = await runGit(worktree, "rev-parse", "HEAD");

		await runGit(worktree, "checkout", "main");
		await runGit(worktree, "merge", "--no-edit", "upstream");
		const candidateCommit = await runGit(worktree, "rev-parse", "HEAD");

		const identity = await candidateReleaseIdentity(worktree, upstreamCommit, candidateCommit);
		expect(identity.compatibilityReviewPaths).toEqual([maintainedPath]);

		const canonicalScopedIdentity = await candidateReleaseIdentity(worktree, canonicalCommit, candidateCommit);
		expect(canonicalScopedIdentity.compatibilityReviewPaths).toEqual([upstreamOnlyPath]);

		const candidateContract = path.join(
			worktree,
			"packages",
			"coding-agent",
			"src",
			"autobot-update",
			"contract.ts",
		);
		await fs.appendFile(candidateContract, "\n// Candidate policy intentionally differs from its producer.\n");
		const conservativeIdentity = await candidateReleaseIdentity(worktree, upstreamCommit, candidateCommit);
		expect(conservativeIdentity.compatibilityReviewPaths).toEqual([maintainedPath, policyExcludedPath]);
	});

	test("selects only merge resolutions whose bytes differ from pinned upstream", async () => {
		const worktree = await createReleaseIdentityFixture();
		const forkResolutionPath = "packages/coding-agent/src/session/resolved-for-fork.ts";
		const upstreamResolutionPath = "packages/coding-agent/src/config/resolved-as-upstream.ts";
		const forkResolutionFile = path.join(worktree, ...forkResolutionPath.split("/"));
		const upstreamResolutionFile = path.join(worktree, ...upstreamResolutionPath.split("/"));
		await fs.mkdir(path.dirname(forkResolutionFile), { recursive: true });
		await fs.mkdir(path.dirname(upstreamResolutionFile), { recursive: true });
		await fs.writeFile(forkResolutionFile, "export const resolution = 'base';\n");
		await fs.writeFile(upstreamResolutionFile, "export const resolution = 'base';\n");
		await runGit(worktree, "add", ".");
		await runGit(worktree, "commit", "-m", "base");
		await runGit(worktree, "branch", "upstream");

		await fs.writeFile(forkResolutionFile, "export const resolution = 'canonical';\n");
		await fs.writeFile(upstreamResolutionFile, "export const resolution = 'canonical';\n");
		await runGit(worktree, "commit", "-am", "canonical conflict sides");

		await runGit(worktree, "checkout", "upstream");
		await fs.writeFile(forkResolutionFile, "export const resolution = 'upstream';\n");
		await fs.writeFile(upstreamResolutionFile, "export const resolution = 'upstream';\n");
		await runGit(worktree, "commit", "-am", "upstream conflict sides");
		const upstreamCommit = await runGit(worktree, "rev-parse", "HEAD");

		await runGit(worktree, "checkout", "main");
		await expect(runGit(worktree, "merge", "--no-edit", "upstream")).rejects.toThrow();
		await fs.writeFile(forkResolutionFile, "export const resolution = 'combined';\n");
		await fs.writeFile(upstreamResolutionFile, "export const resolution = 'upstream';\n");
		await runGit(worktree, "add", forkResolutionPath, upstreamResolutionPath);
		await runGit(worktree, "commit", "-m", "resolve candidate compatibility");
		const candidateCommit = await runGit(worktree, "rev-parse", "HEAD");

		const identity = await candidateReleaseIdentity(worktree, upstreamCommit, candidateCommit);
		expect(identity.compatibilityReviewPaths).toEqual([forkResolutionPath]);
	});

	test("returns an explicit empty compatibility path set for a pure upstream candidate", async () => {
		const worktree = await createReleaseIdentityFixture();
		const upstreamOnlyPath = "packages/coding-agent/src/session/upstream-only.ts";
		const upstreamOnlyFile = path.join(worktree, ...upstreamOnlyPath.split("/"));
		await fs.mkdir(path.dirname(upstreamOnlyFile), { recursive: true });
		await fs.writeFile(upstreamOnlyFile, "export const upstreamOnly = 'base';\n");
		await runGit(worktree, "add", ".");
		await runGit(worktree, "commit", "-m", "base");
		await runGit(worktree, "branch", "upstream");

		await runGit(worktree, "checkout", "upstream");
		await fs.writeFile(upstreamOnlyFile, "export const upstreamOnly = 'released';\n");
		await runGit(worktree, "commit", "-am", "released upstream behavior");
		const upstreamCommit = await runGit(worktree, "rev-parse", "HEAD");

		await runGit(worktree, "checkout", "main");
		await runGit(worktree, "merge", "--no-ff", "--no-edit", "upstream");
		const candidateCommit = await runGit(worktree, "rev-parse", "HEAD");

		const identity = await candidateReleaseIdentity(worktree, upstreamCommit, candidateCommit);
		expect(identity.compatibilityReviewPaths).toEqual([]);
	});

	test(
		"provides exact incoming and maintained compatibility diffs across intervening metadata commits",
		async () => {
			const workRoot = await createPrivateRoot();
			const worktree = path.join(workRoot, "worktree");
			await fs.mkdir(worktree);
			await runGit(worktree, "init", "-b", "main");
			await runGit(worktree, "config", "user.name", "fixture");
			await runGit(worktree, "config", "user.email", "fixture@invalid");
			await createLargeHistoricalMergeChain(worktree, 2_200);
			const historicalMergeInventory = await runGit(
				worktree,
				"rev-list",
				"--first-parent",
				"--merges",
				"--parents",
				"HEAD",
			);
			expect(Buffer.byteLength(historicalMergeInventory, "utf8")).toBeGreaterThan(256 * 1024);
			const incomingPath = "packages/model/schema.ts";
			const maintainedPath = "packages/model/discovery.ts";
			const distantMaintainedPath = "packages/unrelated/fork.ts";
			const incomingFile = path.join(worktree, ...incomingPath.split("/"));
			const maintainedFile = path.join(worktree, ...maintainedPath.split("/"));
			const distantMaintainedFile = path.join(worktree, ...distantMaintainedPath.split("/"));
			await fs.mkdir(path.dirname(incomingFile), { recursive: true });
			await fs.mkdir(path.dirname(distantMaintainedFile), { recursive: true });
			await fs.writeFile(incomingFile, "export const contract = 'base';\n");
			await fs.writeFile(maintainedFile, "export const discoverModels = 'base';\n");
			await fs.writeFile(distantMaintainedFile, "export const unrelated = 'base';\n");
			await runGit(worktree, "add", incomingPath, maintainedPath, distantMaintainedPath);
			await runGit(worktree, "commit", "-m", "base");
			await runGit(worktree, "branch", "upstream");

			await runGit(worktree, "checkout", "upstream");
			await fs.writeFile(
				incomingFile,
				"export const contract = 'base';\nexport const upstreamContract = 'incoming';\n",
			);
			await runGit(worktree, "commit", "-am", "upstream change");
			const upstreamCommit = await runGit(worktree, "rev-parse", "HEAD");
			await fs.writeFile(path.join(worktree, "upstream-metadata.json"), "{}\n");
			await runGit(worktree, "add", "upstream-metadata.json");
			await runGit(worktree, "commit", "-m", "canonical metadata after pin");
			const canonicalSideCommit = await runGit(worktree, "rev-parse", "HEAD");

			await runGit(worktree, "checkout", "main");
			await fs.writeFile(maintainedFile, "export const discoverModels = 'maintained';\n");
			await fs.writeFile(distantMaintainedFile, "export const unrelated = 'maintained elsewhere';\n");
			await runGit(worktree, "commit", "-am", "maintained fork changes");
			const preIntegrationCommit = await runGit(worktree, "rev-parse", "HEAD");
			await runGit(worktree, "merge", "-s", "ours", "--no-edit", canonicalSideCommit);
			const integrationCommit = await runGit(worktree, "rev-parse", "HEAD");
			await fs.writeFile(path.join(worktree, "release-metadata.json"), "{}\n");
			await runGit(worktree, "add", "release-metadata.json");
			await runGit(worktree, "commit", "-m", "metadata after integration");
			const forkCommit = await runGit(worktree, "rev-parse", "HEAD");

			const capturePath = path.join(worktree, "captured-context.json");
			const wrapperScript = path.join(workRoot, "capture-context.ts");
			await fs.writeFile(
				wrapperScript,
				[
					'import * as fs from "node:fs/promises";',
					"const contextArgument = process.argv.find(value => value.startsWith('@') && value.endsWith('context.md'));",
					"if (contextArgument === undefined) process.exit(2);",
					"const text = await fs.readFile(contextArgument.slice(1), 'utf8');",
					"const context = JSON.parse(text.slice(text.indexOf('\\n') + 1));",
					`await fs.writeFile(${JSON.stringify(capturePath)}, JSON.stringify(context));`,
					"await fs.writeFile(context.repairIntent.path, JSON.stringify({ schemaVersion: 1, nonce: context.repairIntent.nonce, paths: [] }));",
				].join("\n"),
			);
			const wrapper = path.join(workRoot, "capture-context.cmd");
			await fs.writeFile(
				wrapper,
				`@echo off\r\n"${process.execPath}" "${wrapperScript}" %*\r\n`,
				"utf8",
			);
			const recorder = await createLocalCommandRecorder(workRoot);
			const config: LocalAutomationConfig = {
				schemaVersion: 1,
				repository: "The-AutoBot/oh-my-pi",
				canonicalBranch: "main",
				integrationBranch: "autobot-local",
				upstreamRepository: "https://github.com/example/upstream.git",
				upstreamRef: "latest-release",
				workRoot,
				runnerBun: process.execPath,
				runnerBunVersion: "0.0.0",
				compilerBun: process.execPath,
				compilerBunVersion: "0.0.0",
				nativeAddonDirectory: workRoot,
				nativeAddonProvenanceSha256: "a".repeat(64),
				ompExecutable: wrapper,
				coordinatorRoot: workRoot,
				keyId: "test-key",
				privateKeyPath: wrapper,
				publicKeyPath: wrapper,
				channelRepository: "The-AutoBot/channel",
				channelBranch: "main",
				channelPath: "signed-envelope.json",
				allowInitial: false,
				maxOmpAttempts: 1,
				ompMaxTime: "30s",
			};

			const ompResult = await runLocalOmp(
				config,
				{
					cwd: worktree,
					reason: "compatibility",
					forkCommit,
					upstreamCommit,
					sensitivePaths: [incomingPath, maintainedPath, distantMaintainedPath],
				},
				recorder,
			);
			expect(ompResult).toEqual({ repairIntent: { paths: [] } });
			const evidence = JSON.parse(await fs.readFile(capturePath, "utf8")).compatibilityEvidence;
			expect(evidence).toMatchObject({
				integrationCommit,
				preIntegrationCommit,
				incomingDiff: { head: upstreamCommit, paths: [incomingPath] },
				maintainedDiff: {
					head: preIntegrationCommit,
					paths: [maintainedPath, distantMaintainedPath],
					scope: {
						strategy: "all-affected-parent-directories",
						directories: ["packages/model", "packages/unrelated"],
						includedAffectedPaths: [maintainedPath, incomingPath, distantMaintainedPath],
						excludedAffectedPaths: [],
					},
				},
			});
			expect(evidence.incomingDiff.patch).toContain("+export const upstreamContract = 'incoming';");
			expect(evidence.incomingDiff.patch).not.toContain("discoverModels");
			expect(evidence.maintainedDiff.patch).toContain("+export const discoverModels = 'maintained';");
			expect(evidence.maintainedDiff.patch).not.toContain("upstreamContract");
			expect(evidence.maintainedDiff.patch).toContain("+export const unrelated = 'maintained elsewhere';");
		},
		OMP_PROCESS_TIMEOUT_MS,
	);
}
