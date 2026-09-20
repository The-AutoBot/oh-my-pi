import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureAutoBotPrivateDirectory } from "../packages/coding-agent/src/autobot-update/permissions.ts";
import { createLocalCommandRecorder, LOCAL_COMMAND_DIAGNOSTICS_FILENAME } from "../scripts/autobot-local.ts";
import { runLocalOmp } from "../scripts/autobot-local-omp.ts";
import { runQuiet } from "../scripts/autobot-local-release.ts";
import type { LocalAutomationConfig } from "../scripts/autobot-local-types.ts";

const temporaryDirectories: string[] = [];

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
		runQuiet(recorder, "candidate-dependency-installation", "Candidate dependency installation", [
			process.execPath,
			"-e",
			script,
		]),
	).rejects.toThrow();

	const text = await fs.readFile(journalPath(workRoot), "utf8");
	expect(text).not.toContain(secret);
	expect(JSON.parse(text)).toEqual({
		schemaVersion: 1,
		records: [
			{
				stage: "release",
				commandKind: "candidate-dependency-installation",
				outcome: "started",
				timedOut: false,
			},
			{
				stage: "release",
				commandKind: "candidate-dependency-installation",
				outcome: "exited",
				timedOut: false,
				exitCode: 23,
				durationMs: expect.any(Number),
			},
		],
	});
});

test("retains the newest sixteen structural records and rejects malformed or oversized journals", async () => {
	const workRoot = await createPrivateRoot();
	const recorder = await createLocalCommandRecorder(workRoot);

	await Promise.all(
		Array.from({ length: 20 }, (_, exitCode) =>
			recorder.record({
				stage: "release",
				commandKind: "candidate-dependency-installation",
				outcome: "exited",
				timedOut: false,
				exitCode,
				durationMs: exitCode,
			}),
		),
	);

	const retained = JSON.parse(await fs.readFile(journalPath(workRoot), "utf8"));
	expect(retained.records).toHaveLength(16);
	expect(retained.records.map((record: { exitCode: number }) => record.exitCode)).toEqual(
		Array.from({ length: 16 }, (_, index) => index + 4),
	);

	await fs.writeFile(
		journalPath(workRoot),
		JSON.stringify({
			schemaVersion: 1,
			records: [
				{
					stage: "release",
					commandKind: "candidate-dependency-installation",
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
});

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
			upstreamRef: "refs/heads/main",
			workRoot,
			runnerBun: process.execPath,
			runnerBunVersion: "0.0.0",
			compilerBun: process.execPath,
			compilerBunVersion: "0.0.0",
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
	});
}
