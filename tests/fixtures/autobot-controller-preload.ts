import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = process.env.AUTOBOT_CONTROLLER_SOURCE_ROOT;
if (!repositoryRoot || !path.isAbsolute(repositoryRoot)) {
	throw new Error("AUTOBOT_CONTROLLER_SOURCE_ROOT is required");
}
const statePath = process.env.AUTOBOT_CONTROLLER_FIXTURE_STATE;
if (!statePath) throw new Error("AUTOBOT_CONTROLLER_FIXTURE_STATE is required");

type FixtureState = {
	builds: number;
	buildEntries: Array<{ phase: string | null; forkCommit: string }>;
	ompReasons: string[];
	producerMutated?: boolean;
	scenario:
		| "reuse"
		| "relevant-invalidation"
		| "pin-invalidation"
		| "budget"
		| "producer-mutation"
		| "producer-pre-mutation"
		| "noop-repair"
		| "out-of-scope";
};

async function readState(): Promise<FixtureState> {
	return JSON.parse(await fs.readFile(statePath, "utf8")) as FixtureState;
}
async function updateState(update: (state: FixtureState) => void): Promise<FixtureState> {
	const state = await readState();
	update(state);
	await fs.writeFile(statePath, JSON.stringify(state));
	return state;
}
async function recordGitInvocation(command: readonly string[]): Promise<void> {
	const logPath = process.env.AUTOBOT_CONTROLLER_GIT_LOG;
	if (!logPath) return;
	const fixtureRoot = process.env.AUTOBOT_CONTROLLER_FIXTURE_ROOT ?? "";
	const sanitized = command.map(argument => {
		const withoutRoot = fixtureRoot ? argument.split(fixtureRoot).join("[fixture-root]") : argument;
		return withoutRoot.replace(/https:\/\/[^/@\s]+@/gi, "https://[redacted]@").slice(0, 1024);
	});
	await fs.appendFile(logPath, `${JSON.stringify(sanitized)}\n`);
}
const modulePath = (relativePath: string): string => path.join(repositoryRoot, relativePath);
const moduleUrl = (relativePath: string): string => pathToFileURL(modulePath(relativePath)).href;
// Capture real implementations before registering absolute-path mocks for the
// relative imports resolved by the public CLI entrypoint.

const commonPath = modulePath("scripts/autobot-release-common.ts");
const commonUrl = moduleUrl("scripts/autobot-release-common.ts");
const actualCommon = await import(`${commonUrl}?controller-fixture-actual`);
const actualCommonExports = { ...actualCommon };
const actualRunCommand = actualCommon.runCommand;
const actualGitOutput = actualCommon.gitOutput;
mock.module(commonPath, () => ({
	...actualCommonExports,
	gitOutput: async (cwd: string, args: readonly string[]) => {
		await recordGitInvocation(["git", "-C", cwd, ...args]);
		return actualGitOutput(cwd, args);
	},
	runCommand: async (command: readonly string[], options?: unknown) => {
		if (command[0] === "git") await recordGitInvocation(command);
		if (command[0] !== "gh") return actualRunCommand(command, options);
		const expectedTag = process.env.AUTOBOT_CONTROLLER_UPSTREAM_TAG;
		const expectedEndpoint = `repos/example/upstream/releases/tags/${encodeURIComponent(expectedTag ?? "")}`;
		if (
			expectedTag === undefined ||
			command.length !== 5 ||
			command[1] !== "api" ||
			command[2] !== "--method" ||
			command[3] !== "GET" ||
			command[4] !== expectedEndpoint
		) {
			throw new Error("Controller fixture refused an unexpected external GitHub command");
		}
		return { stdout: JSON.stringify({ tag_name: expectedTag, draft: false, prerelease: false }), stderr: "" };
	},
}));

const nativeCompatibilityPath = modulePath("packages/natives/scripts/native-compatibility.ts");
mock.module(nativeCompatibilityPath, () => ({
	synchronizeNativeReleaseMetadata: async () => [],
}));

const releasePath = modulePath("scripts/autobot-local-release.ts");
const releaseUrl = moduleUrl("scripts/autobot-local-release.ts");
const actualRelease = await import(`${releaseUrl}?controller-fixture-actual`);
const actualReleaseExports = { ...actualRelease };
const FixtureLocalBuildFailure = actualRelease.LocalBuildFailure;
mock.module(releasePath, () => ({
	...actualReleaseExports,
	admitCandidateNativeInputs: async () => undefined,
	buildAndPublishLocalRelease: async (
		config: { workRoot: string },
		candidate: { forkCommit: string },
		_recorder: unknown,
		options?: { mode?: string },
	) => {
		if (options?.mode === "verify") return { kind: "verified", preservedStageRoot: repositoryRoot };
		let phase: string | null = null;
		try {
			const controllerState = JSON.parse(
				await fs.readFile(path.join(config.workRoot, ".autobot-local-state.json"), "utf8"),
			) as { phase?: unknown };
			phase = typeof controllerState.phase === "string" ? controllerState.phase : null;
		} catch {
			// The controller state assertion below makes a missing state observable.
		}
		const state = await updateState(current => {
			current.builds++;
			current.buildEntries.push({ phase, forkCommit: candidate.forkCommit });
		});
		if (
			state.builds === 1 &&
			(state.scenario === "reuse" ||
				state.scenario === "relevant-invalidation" ||
				state.scenario === "budget" ||
				state.scenario === "noop-repair" ||
				state.scenario === "out-of-scope")
		) {
			throw new FixtureLocalBuildFailure("runtime-compilation", "fixture build failure");
		}
		return { kind: "published" };
	},
}));

const runGit = (cwd: string, ...args: string[]): void => {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`fixture git ${args.join(" ")} failed`);
};

const ompPath = modulePath("scripts/autobot-local-omp.ts");
mock.module(ompPath, () => ({
	runLocalOmp: async (_config: unknown, request: { cwd: string; reason: string }) => {
		const state = await updateState(current => {
			current.ompReasons.push(request.reason);
		});
		if (state.scenario === "producer-mutation") {
			await fs.appendFile(path.join(repositoryRoot, "README.md"), "\nfixture producer mutation\n");
			await updateState(current => {
				current.producerMutated = true;
			});
			return { repairIntent: { paths: [] } };
		}
		if (request.reason === "conflicts") {
			const conflictPath = "packages/coding-agent/src/config.ts";
			runGit(request.cwd, "checkout", "--theirs", "--", conflictPath);
			runGit(request.cwd, "add", "--", conflictPath);
			return { repairIntent: { paths: [conflictPath] } };
		}
		if (request.reason === "compatibility") return { repairIntent: { paths: [] } };
		if (state.scenario === "noop-repair") return { repairIntent: { paths: [] } };
		if (state.scenario === "out-of-scope") {
			await fs.writeFile(path.join(request.cwd, "scripts", "autobot-local.ts"), "forbidden fixture mutation\n");
			return { repairIntent: { paths: ["scripts/autobot-local.ts"] } };
		}
		const repairPath =
			state.scenario === "relevant-invalidation"
				? "packages/coding-agent/src/config/models-config-schema.ts"
				: "packages/coding-agent/src/modes/types.ts";
		await fs.appendFile(path.join(request.cwd, ...repairPath.split("/")), "\n// fixture repair\n");
		return { repairIntent: { paths: [repairPath] } };
	},
}));
