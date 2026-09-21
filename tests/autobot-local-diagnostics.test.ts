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

test("records a real failed quiet command without persisting its stream or argument canary", async () => {
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
}, FAILED_COMMAND_TIMEOUT_MS);
test("retains only bounded redacted output for explicitly captured candidate commands", async () => {
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
}, BOUNDED_OUTPUT_TIMEOUT_MS);


test("retains the newest sixteen structural records and rejects malformed or oversized journals", async () => {
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
}, STRUCTURAL_JOURNAL_TIMEOUT_MS);

if (process.platform === "win32" && process.arch === "x64") {
	test("records a provider-free local timeout before rejecting the OMP invocation", async () => {
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
					reason: "compatibility",
					forkCommit: "a".repeat(40),
					upstreamCommit: "b".repeat(40),
					sensitivePaths: [],
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
	}, OMP_PROCESS_TIMEOUT_MS);
}
