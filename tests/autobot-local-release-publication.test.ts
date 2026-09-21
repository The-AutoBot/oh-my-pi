import { afterAll, beforeAll, describe, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureAutoBotPrivateDirectory } from "../packages/coding-agent/src/autobot-update/permissions.ts";

const harness = path.join(import.meta.dir, "fixtures", "autobot-publication-case.ts");
const fakeGhSource = path.join(import.meta.dir, "fixtures", "autobot-fake-gh.ts");
const repositoryRoot = path.join(import.meta.dir, "..");
const childTimeoutMilliseconds = 290_000;
const testTimeoutMilliseconds = 300_000;
const compilerTimeoutMilliseconds = 110_000;
const setupTimeoutMilliseconds = 150_000;
const nativeProbeTimeoutMilliseconds = 10_000;

async function runScenario(name: string, ghExecutable: string): Promise<void> {
	const childEnvironment: NodeJS.ProcessEnv = {
		...process.env,
		AUTOBOT_FAKE_GH_EXE: ghExecutable,
	};
	const inheritedPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
	const scrubbedNames: Record<string, true> = {
		GH_TOKEN: true,
		GITHUB_TOKEN: true,
		GH_ENTERPRISE_TOKEN: true,
		GITHUB_ENTERPRISE_TOKEN: true,
		GH_DEBUG: true,
		GITHUB_DEBUG: true,
		ACTIONS_STEP_DEBUG: true,
	};
	for (const key of Object.keys(childEnvironment)) {
		const normalized = key.toUpperCase();
		if (normalized === "PATH" || scrubbedNames[normalized]) delete childEnvironment[key];
	}
	childEnvironment.PATH = `${path.dirname(ghExecutable)}${path.delimiter}${inheritedPath}`;
	const child = Bun.spawn([process.execPath, harness, name], {
		cwd: repositoryRoot,
		env: childEnvironment,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	// This bounds an external integration process; fake timers cannot terminate an OS child.
	const deadline = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, childTimeoutMilliseconds);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const output = (stderr || stdout).trim();
		const diagnostic = output ? output.slice(-8_000) : "no diagnostic";
		if (timedOut) {
			throw new Error(`Publication scenario ${name} exceeded its child deadline:\n${diagnostic}`);
		}
		if (exitCode !== 0) {
			throw new Error(`Publication scenario ${name} failed with exit ${exitCode}:\n${diagnostic}`);
		}
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) {
			child.kill();
			await child.exited;
		}
	}
}
async function runNativeGhProbe(
	executable: string,
	statePath: string,
	args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
	const child = Bun.spawn([executable, ...args], {
		cwd: repositoryRoot,
		env: { ...process.env, AUTOBOT_FAKE_GH_STATE: statePath },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	// This bounds an external fixture process; fake timers cannot terminate an OS child.
	const deadline = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, nativeProbeTimeoutMilliseconds);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (timedOut) {
			const diagnostic = (stderr || stdout).trim().slice(-8_000) || "no diagnostic";
			throw new Error(`Native fake gh self-check exceeded its deadline:\n${diagnostic}`);
		}
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) {
			child.kill();
			await child.exited;
		}
	}
}

if (process.platform === "win32" && process.arch === "x64") {
	describe("prepared local release publication", () => {
		let fixtureBinaryRoot: string | undefined;
		let ghExecutable: string | undefined;

		beforeAll(async () => {
			fixtureBinaryRoot = await fs.mkdtemp(path.join(os.homedir(), "omp-publication-gh-"));
			try {
				await ensureAutoBotPrivateDirectory(fixtureBinaryRoot);
				ghExecutable = path.join(fixtureBinaryRoot, "gh.exe");
				const compiler = Bun.spawn(
					[process.execPath, "build", "--compile", fakeGhSource, "--outfile", ghExecutable],
					{
						cwd: repositoryRoot,
						env: { ...process.env },
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				let compilerTimedOut = false;
				// This bounds an external compiler process; fake timers cannot terminate an OS child.
				const compilerDeadline = setTimeout(() => {
					compilerTimedOut = true;
					compiler.kill();
				}, compilerTimeoutMilliseconds);
				try {
					const [exitCode, stdout, stderr] = await Promise.all([
						compiler.exited,
						new Response(compiler.stdout).text(),
						new Response(compiler.stderr).text(),
					]);
					const diagnostic = (stderr || stdout).trim().slice(-8_000) || "no diagnostic";
					if (compilerTimedOut) {
						throw new Error(`Fake gh compilation exceeded its deadline:\n${diagnostic}`);
					}
					if (exitCode !== 0 || !(await Bun.file(ghExecutable).exists())) {
						throw new Error(`Fake gh compilation failed with exit ${exitCode}:\n${diagnostic}`);
					}
				} finally {
					clearTimeout(compilerDeadline);
					if (compiler.exitCode === null) {
						compiler.kill();
						await compiler.exited;
					}
				}
				const selfCheckState = path.join(fixtureBinaryRoot, "self-check-state.json");
				await fs.writeFile(
					selfCheckState,
					JSON.stringify({
						releases: [],
						releaseGit: path.join(fixtureBinaryRoot, "unused-release.git"),
						channelGit: path.join(fixtureBinaryRoot, "unused-channel.git"),
						channelBranch: "main",
						channelPath: "signed-envelope.json",
						log: [],
					}),
				);
				try {
					const supported = await runNativeGhProbe(ghExecutable, selfCheckState, [
						"api",
						"--paginate",
						"--slurp",
						"repos/The-AutoBot/oh-my-pi/releases?per_page=100",
					]);
					if (supported.exitCode !== 0 || supported.stdout.trim() !== "[[]]") {
						const diagnostic = (supported.stderr || supported.stdout).trim().slice(-8_000) || "no diagnostic";
						throw new Error(`Native fake gh supported-route self-check failed:\n${diagnostic}`);
					}
					const unsupported = await runNativeGhProbe(ghExecutable, selfCheckState, [
						"api",
						"--include",
						"repos/The-AutoBot/wrong",
					]);
					if (unsupported.exitCode === 0) {
						throw new Error("Native fake gh accepted an unsupported API route");
					}
				} finally {
					await fs.rm(selfCheckState, { force: true });
				}
			} catch (error) {
				await fs.rm(fixtureBinaryRoot, { recursive: true, force: true });
				fixtureBinaryRoot = undefined;
				ghExecutable = undefined;
				throw error;
			}
		}, setupTimeoutMilliseconds);

		afterAll(async () => {
			if (fixtureBinaryRoot) await fs.rm(fixtureBinaryRoot, { recursive: true, force: true });
			fixtureBinaryRoot = undefined;
			ghExecutable = undefined;
		}, 60_000);

		const requireGhExecutable = (): string => {
			if (!ghExecutable) throw new Error("Fake gh executable was not prepared");
			return ghExecutable;
		};
		test(
			"creates the exact tag before a fresh draft and promotes byte-exact signed channel state",
			async () => {
				await runScenario("fresh", requireGhExecutable());
			},
			testTimeoutMilliseconds,
		);

		test(
			"finishes an exact retained draft with an absent tag without rebuilding, re-signing, or replacing assets",
			async () => {
				await runScenario("matching", requireGhExecutable());
			},
			testTimeoutMilliseconds,
		);
		test(
			"advances the channel for an exact already-published retained release without replacing its assets",
			async () => {
				await runScenario("published-promotion", requireGhExecutable());
			},
			testTimeoutMilliseconds,
		);
		test(
			"authenticates a channel-complete publication twice without its retained stage or any release mutation",
			async () => {
				await runScenario("recovery-complete", requireGhExecutable());
			},
			testTimeoutMilliseconds,
		);
		test(
			"compares a subsequent signed-channel predecessor as committed bytes when autocrlf rewrites the checkout",
			async () => {
				await runScenario("subsequent-autocrlf", requireGhExecutable());
			},
			testTimeoutMilliseconds,
		);
		test(
			"publishes a third release with contiguous older publication history",
			async () => {
				await runScenario("third-release-history", requireGhExecutable());
			},
			testTimeoutMilliseconds,
		);
		test(
			"rejects an unexpected future publication while preparing a third release",
			async () => {
				await runScenario("third-release-future", requireGhExecutable());
			},
			testTimeoutMilliseconds,
		);


		test.each([
			"conflicting-tag",
			"foreign-draft",
			"tampered-asset",
			"stale-channel",
			"unsafe-stage",
			"foreign-modify-acl",
			"contradictory-manifest",
			"invalid-provenance",
			"recovery-tampered",
			"recovery-invalid-provenance",
			"recovery-bad-signature",
			"recovery-wrong-target",
			"recovery-draft",
			"recovery-foreign-release",
		])(
			"preserves draft, tag, and channel state at the %s boundary",
			async scenario => {
				await runScenario(scenario, requireGhExecutable());
			},
			testTimeoutMilliseconds,
		);
	});
}
