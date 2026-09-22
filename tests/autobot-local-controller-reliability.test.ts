import { Process } from "@oh-my-pi/pi-natives";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const windowsTest = process.platform === "win32" ? test : test.skip;
const fixture = path.join(import.meta.dir, "fixtures", "autobot-controller-case.ts");
const timeoutMilliseconds = 180_000;
const pinFixtureTimeoutMilliseconds = 420_000;
const pinTimeoutMilliseconds = 450_000;

type Scenario =
	| "reuse"
	| "relevant-invalidation"
	| "pin-invalidation"
	| "budget"
	| "producer-mutation"
	| "producer-pre-mutation"
	| "noop-repair"
	| "out-of-scope";
interface FixtureResult {
	runs: Array<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
	fixtureState: {
		builds: number;
		buildEntries: Array<{ phase: string | null; forkCommit: string }>;
		ompReasons: string[];
		producerMutated?: boolean;
	};
	controllerState: null | {
		phase?: string;
		publishedForkCommit?: string;
		compatibilityReviewFingerprint?: string;
		buildFailure?: { attempts?: number };
	};
	controllerDiagnostics: unknown;
	externalFallbacks: string[];
	failureDetail: unknown;
	gitInvocations: { count: number; first: string[]; last: string[] };
}

async function runScenario(scenario: Scenario): Promise<FixtureResult> {
	const root = await fs.mkdtemp(path.join(os.homedir(), "omp-controller-case-"));
	const child = Bun.spawn([process.execPath, fixture, scenario, root], {
		cwd: path.resolve(import.meta.dir, ".."),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	// This bounds and reaps an external fixture process; fake timers cannot terminate an OS child.
	const deadline = setTimeout(
		() => {
			try {
				const owned = Process.fromPid(child.pid);
				if (owned) owned.killTree();
				else child.kill();
			} catch {
				child.kill();
			}
		},
		scenario === "pin-invalidation" ? pinFixtureTimeoutMilliseconds : timeoutMilliseconds - 5_000,
	);
	deadline.unref();
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) {
			const progress = await fs
				.readFile(path.join(root, "controller-progress.json"), "utf8")
				.then(contents => JSON.parse(contents) as unknown)
				.catch(() => null);
			throw new Error(
				`controller fixture ${scenario} failed: ${JSON.stringify({ exitCode, stderr: stderr.slice(0, 1024), progress })}`,
			);
		}
		return JSON.parse(stdout.trim()) as FixtureResult;
	} finally {
		clearTimeout(deadline);
		await fs.rm(root, { recursive: true, force: true });
	}
}
function assertRunExitCodes(result: FixtureResult, expected: readonly number[]): void {
	const actual = result.runs.map(run => run.exitCode);
	const exitsMatch = actual.length === expected.length && actual.every((code, index) => code === expected[index]);
	if (exitsMatch && result.externalFallbacks.length === 0) return;
	throw new Error(
		`controller fixture boundary mismatch: ${JSON.stringify({
			failureDetail: result.failureDetail,
			expected,
			actual,
			fixtureState: result.fixtureState,
			controllerState: result.controllerState,
			controllerDiagnostics: result.controllerDiagnostics,
			externalFallbacks: result.externalFallbacks,
			runs: result.runs,
			gitInvocations: result.gitInvocations,
		})}`,
	);
}
describe("public local controller reliability transitions", () => {
	windowsTest(
		"reuses review after an irrelevant accepted repair and re-enters the complete release builder",
		async () => {
			const result = await runScenario("reuse");
			assertRunExitCodes(result, [0]);
			expect(result.fixtureState.buildEntries.map(entry => entry.phase)).toEqual(["publishing", "publishing"]);
			expect(new Set(result.fixtureState.buildEntries.map(entry => entry.forkCommit)).size).toBe(2);
			expect(result.fixtureState.ompReasons).toEqual(["compatibility", "build-failure"]);
			expect(result.fixtureState.builds).toBe(2);
			expect(result.controllerState?.phase).toBe("published");
			expect(result.controllerState?.publishedForkCommit).toMatch(/^[0-9a-f]{40}$/);
		},
		timeoutMilliseconds,
	);

	windowsTest(
		"invalidates review after a compatibility-relevant accepted repair",
		async () => {
			const result = await runScenario("relevant-invalidation");
			assertRunExitCodes(result, [0]);
			expect(result.fixtureState.ompReasons).toEqual(["compatibility", "build-failure", "compatibility"]);
			expect(result.fixtureState.builds).toBe(2);
			expect(result.controllerState?.phase).toBe("published");
		},
		timeoutMilliseconds,
	);

	windowsTest(
		"invalidates review when either authoritative source pin changes",
		async () => {
			const result = await runScenario("pin-invalidation");
			assertRunExitCodes(result, [0, 0, 0]);
			expect(result.fixtureState.ompReasons).toEqual(["compatibility", "compatibility", "compatibility"]);
			expect(result.fixtureState.builds).toBe(3);
			expect(result.controllerState?.phase).toBe("published");
		},
		pinTimeoutMilliseconds,
	);

	windowsTest(
		"shares the within-run OMP cap across conflict, review, and repair",
		async () => {
			const result = await runScenario("budget");
			assertRunExitCodes(result, [1]);
			expect(result.fixtureState.ompReasons).toEqual(["conflicts", "compatibility"]);
			expect(result.fixtureState.builds).toBe(1);
			expect(result.controllerState?.phase).toBe("blocked");
			expect(result.controllerState?.publishedForkCommit).toBeUndefined();
		},
		timeoutMilliseconds,
	);

	windowsTest(
		"rejects producer mutation around OMP before build or publication",
		async () => {
			const result = await runScenario("producer-mutation");
			assertRunExitCodes(result, [1]);
			expect(result.fixtureState.ompReasons).toEqual(["compatibility"]);
			expect(result.fixtureState.producerMutated).toBe(true);
			expect(result.fixtureState.builds).toBe(0);
			expect(result.controllerState?.phase).toBe("blocked");
			expect(result.controllerState?.publishedForkCommit).toBeUndefined();
		},
		timeoutMilliseconds,
	);
	windowsTest(
		"rejects an already-dirty tracked producer before OMP, build, or publication",
		async () => {
			const result = await runScenario("producer-pre-mutation");
			assertRunExitCodes(result, [1]);
			expect(result.fixtureState.ompReasons).toEqual([]);
			expect(result.fixtureState.builds).toBe(0);
			expect(result.controllerState).toBeNull();
		},
		timeoutMilliseconds,
	);

	for (const scenario of ["noop-repair", "out-of-scope"] as const) {
		windowsTest(
			`does not publish after a ${scenario === "noop-repair" ? "no-op" : "scope-escaping"} repair`,
			async () => {
				const result = await runScenario(scenario);
				assertRunExitCodes(result, [1]);
				expect(result.fixtureState.ompReasons).toEqual(["compatibility", "build-failure"]);
				expect(result.fixtureState.builds).toBe(1);
				expect(result.controllerState?.phase).toBe("blocked");
				expect(result.controllerState?.publishedForkCommit).toBeUndefined();
			},
			timeoutMilliseconds,
		);
	}
});
