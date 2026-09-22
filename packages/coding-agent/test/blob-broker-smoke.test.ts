import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

async function killProcessTree(pid: number): Promise<void> {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot) throw new Error("SystemRoot is required to terminate the Windows smoke process tree");
	const killer = Bun.spawn([path.join(systemRoot, "System32", "taskkill.exe"), "/PID", String(pid), "/T", "/F"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		windowsHide: true,
	});
	await killer.exited;
}

it.skipIf(process.platform !== "win32")(
	"runs the real blob broker smoke with a valid long TEMP",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-blob-smoke-long-temp-"));
		const longTemp = path.join(root, "a".repeat(64));
		await fs.mkdir(longTemp, { recursive: true });
		try {
			// Guard the regression setup: the former filesystem socket endpoint must
			// exceed Bun's 108-byte local-socket limit before the real smoke runs.
			expect(Buffer.byteLength(path.join(longTemp, "omp-blob-smoke-ffff.sock"), "utf8")).toBeGreaterThan(108);

			// Run in a fresh process so the worker and os.tmpdir() both observe
			// the long TEMP from startup; this intentionally exercises module loading.
			const repoRoot = path.resolve(import.meta.dir, "../../..");
			// This is a real cross-process smoke: fake timers in the test runner
			// cannot govern the child, so a native watchdog owns the hard deadline,
			// diagnostics, and descendant-tree cleanup.
			const childEnv: NodeJS.ProcessEnv = {
				...process.env,
				HOME: root,
				USERPROFILE: root,
				XDG_CONFIG_HOME: path.join(root, "xdg-config"),
				XDG_DATA_HOME: path.join(root, "xdg-data"),
				XDG_STATE_HOME: path.join(root, "xdg-state"),
				XDG_CACHE_HOME: path.join(root, "xdg-cache"),
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
				TEMP: longTemp,
				TMP: longTemp,
				BUN_CONFIG_NO_ENV_FILE: "1",
			};
			for (const key of [
				"PI_CONFIG_DIR",
				"OMP_CONFIG_DIR",
				"PI_PROFILE",
				"OMP_PROFILE",
				"PI_CODING_AGENT_DIR",
				"OMP_CODING_AGENT_DIR",
				"BUN_BE_BUN",
				"BUN_OPTIONS",
				"BUN_PRELOAD",
				"BUN_CONFIG_PRELOAD",
				"NODE_OPTIONS",
				"NODE_PATH",
				"TS_NODE_PROJECT",
				"DOTENV_CONFIG_PATH",
			]) {
				delete childEnv[key];
			}
			childEnv.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
			const daemonUrl = pathToFileURL(
				path.join(repoRoot, "packages", "coding-agent", "src", "blob-broker", "daemon.ts"),
			).href;
			const script = [
				'process.stderr.write("entered blob smoke child\\n");',
				'let stage = "module import";',
				'const deadline = setTimeout(() => process.stderr.write("blob broker smoke child still pending at " + stage + " after 35000ms\\n"), 35000);',
				"try {",
				`  const { smokeTestBlobBroker } = await import(${JSON.stringify(daemonUrl)});`,
				'  process.stderr.write("imported blob smoke daemon\\n");',
				"  const originalFetch = globalThis.fetch;",
				"  let observedRoundtrip = false;",
				"  globalThis.fetch = async (input, init) => {",
				'    stage = "fetch request";',
				"    const response = await originalFetch(input, init);",
				'    if (response.status === 200 && response.headers.get("content-type") === "image/png" &&',
				'        (await response.clone().text()) === "smoke-test") observedRoundtrip = true;',
				"    return response;",
				"  };",
				'  stage = "smoke setup";',
				"  await smokeTestBlobBroker();",
				'  if (!observedRoundtrip) throw new Error("blob broker smoke did not fetch the served blob");',
				"} finally {",
				"  clearTimeout(deadline);",
				"}",
			].join("\n");
			const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
				cwd: repoRoot,
				env: childEnv,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			const stdoutPromise = new Response(proc.stdout).text();
			const stderrPromise = new Response(proc.stderr).text();
			const deadline = Promise.withResolvers<void>();
			const timer = setTimeout(deadline.resolve, 45_000);
			let timedOut = false;
			try {
				const outcome = await Promise.race([
					proc.exited.then(exitCode => ({ type: "exit" as const, exitCode })),
					deadline.promise.then(() => ({ type: "timeout" as const })),
				]);
				if (outcome.type === "timeout") {
					timedOut = true;
					await killProcessTree(proc.pid);
				}
				const [, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
				if (timedOut) {
					throw new Error(`blob broker smoke child timed out: ${stderr || "no stderr"}`);
				}
				expect(exitCode, stderr).toBe(0);
			} finally {
				clearTimeout(timer);
				if (proc.exitCode === null) await killProcessTree(proc.pid);
				await proc.exited;
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	60_000,
);
