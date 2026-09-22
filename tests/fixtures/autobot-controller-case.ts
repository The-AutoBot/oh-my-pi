import { Process } from "@oh-my-pi/pi-natives";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureAutoBotPrivateDirectory } from "../../packages/coding-agent/src/autobot-update/permissions";

const scenario = process.argv[2] as
	| "reuse"
	| "relevant-invalidation"
	| "pin-invalidation"
	| "budget"
	| "producer-mutation"
	| "producer-pre-mutation"
	| "noop-repair"
	| "out-of-scope";
if (!scenario) throw new Error("controller fixture scenario is required");

const maintainedRoot = path.resolve(import.meta.dir, "../..");
const preload = path.join(import.meta.dir, "autobot-controller-preload.ts");
const root = process.argv[3];
if (!root || !path.isAbsolute(root)) throw new Error("controller fixture root is required");
let controllerSource = maintainedRoot;
let controller = path.join(controllerSource, "scripts", "autobot-local.ts");
let upstreamTag = "";
const externalBoundaryBin = path.join(root, "external-boundary-bin");
const externalBoundarySentinel = path.join(root, "external-boundary-sentinel.txt");
const ompFallbackPath = path.join(externalBoundaryBin, "omp-fallback.cmd");
const failureDetailPath = path.join(root, "controller-failure-detail.json");
const gitInvocationLog = path.join(root, "controller-git-invocations.log");
const progressPath = path.join(root, "controller-progress.json");
const fixtureStartedAt = performance.now();

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}
function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}
async function commitFile(repository: string, relativePath: string, content: string, message: string): Promise<string> {
	const destination = path.join(repository, ...relativePath.split("/"));
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.writeFile(destination, content);
	git(repository, "add", "--", relativePath);
	git(repository, "commit", "-m", message);
	return git(repository, "rev-parse", "HEAD");
}
async function invoke(configPath: string, statePath: string, gitConfig: string): Promise<RunResult> {
	const startedAt = performance.now();
	const child = Bun.spawn([process.execPath, "--preload", preload, controller, "--config", configPath], {
		cwd: controllerSource,
		env: {
			...process.env,
			AUTOBOT_CONTROLLER_FIXTURE_STATE: statePath,
			AUTOBOT_CONTROLLER_SOURCE_ROOT: controllerSource,
			AUTOBOT_CONTROLLER_UPSTREAM_TAG: upstreamTag,
			AUTOBOT_CONTROLLER_EXTERNAL_SENTINEL: externalBoundarySentinel,
			AUTOBOT_CONTROLLER_FAILURE_DETAIL: failureDetailPath,
			AUTOBOT_CONTROLLER_FIXTURE_ROOT: root,
			AUTOBOT_CONTROLLER_GIT_LOG: gitInvocationLog,
			GIT_ALLOW_PROTOCOL: "file",
			PATH: `${externalBoundaryBin}${path.delimiter}${process.env.PATH ?? ""}`,
			GIT_CONFIG_GLOBAL: gitConfig,
			GIT_CONFIG_NOSYSTEM: "1",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	// This bounds and reaps the public controller process; fake timers cannot terminate an OS child.
	const deadline = setTimeout(() => {
		try {
			const owned = Process.fromPid(child.pid);
			if (owned) owned.killTree();
			else child.kill();
		} catch {
			child.kill();
		}
	}, 120_000);
	deadline.unref();
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return {
			exitCode,
			stdout,
			stderr,
			durationMs: Math.max(0, Math.floor(performance.now() - startedAt)),
		};
	} finally {
		clearTimeout(deadline);
	}
}

try {
	controllerSource = path.join(root, "controller-source");
	git(root, "clone", "--no-local", maintainedRoot, controllerSource);
	git(controllerSource, "config", "user.name", "Controller Fixture");
	git(controllerSource, "config", "user.email", "fixture@invalid");
	for (const relativePath of [
		"scripts/autobot-local.ts",
		"scripts/autobot-local-omp.ts",
		"scripts/autobot-local-release.ts",
		"scripts/autobot-local-types.ts",
		"scripts/bazel-natives.ts",
		"packages/natives/scripts/native-build-provenance.ts",
		"packages/natives/scripts/native-compatibility.ts",
	]) {
		const source = path.join(maintainedRoot, ...relativePath.split("/"));
		if (!(await Bun.file(source).exists())) continue;
		const destination = path.join(controllerSource, ...relativePath.split("/"));
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.copyFile(source, destination);
	}
	const maintainedNodeModules = path.join(maintainedRoot, "node_modules");
	if (
		await fs
			.stat(maintainedNodeModules)
			.then(stat => stat.isDirectory())
			.catch(() => false)
	) {
		await fs.symlink(maintainedNodeModules, path.join(controllerSource, "node_modules"), "junction");
	}
	const controllerSourcePath = path.join(controllerSource, "scripts", "autobot-local.ts");
	const controllerText = await fs.readFile(controllerSourcePath, "utf8");
	const controllerCatch = `\t} catch {\n\t\t// Launcher output is intentionally limited to its exit status. Do not log`;
	if (!controllerText.includes(controllerCatch)) {
		throw new Error("controller fixture could not install isolated failure diagnostics");
	}
	await fs.writeFile(
		controllerSourcePath,
		controllerText.replace(
			controllerCatch,
			`\t} catch (error) {\n\t\tconst fixtureFailurePath = process.env.AUTOBOT_CONTROLLER_FAILURE_DETAIL;\n\t\tif (fixtureFailurePath) {\n\t\t\tconst fixtureRoot = process.env.AUTOBOT_CONTROLLER_FIXTURE_ROOT ?? "";\n\t\t\tconst rawMessage = error instanceof Error ? error.message : "Non-Error controller failure";\n\t\t\tconst message = (fixtureRoot ? rawMessage.split(fixtureRoot).join("[fixture-root]") : rawMessage).slice(0, 512);\n\t\t\tawait fs.writeFile(fixtureFailurePath, JSON.stringify({ name: error instanceof Error ? error.name : "unknown", message })).catch(() => undefined);\n\t\t}\n\t\t// Launcher output is intentionally limited to its exit status. Do not log`,
		),
	);
	git(controllerSource, "add", "--all");
	if (git(controllerSource, "status", "--porcelain") !== "") {
		git(controllerSource, "commit", "-m", "fixture maintained controller source");
	}
	controller = path.join(controllerSource, "scripts", "autobot-local.ts");

	const seed = path.join(root, "seed");
	git(root, "clone", "--no-local", controllerSource, seed);
	git(seed, "config", "user.name", "Controller Fixture");
	git(seed, "config", "user.email", "fixture@invalid");
	git(seed, "branch", "-M", "main");

	const canonicalWork = path.join(root, "canonical-work");
	git(root, "clone", "--no-local", seed, canonicalWork);
	git(canonicalWork, "config", "user.name", "Controller Fixture");
	git(canonicalWork, "config", "user.email", "fixture@invalid");
	git(canonicalWork, "branch", "-M", "main");
	const conflict = scenario === "budget";
	if (conflict) {
		const configSource = await fs.readFile(path.join(canonicalWork, "packages/coding-agent/src/config.ts"), "utf8");
		await commitFile(
			canonicalWork,
			"packages/coding-agent/src/config.ts",
			`export const controllerFixtureConflict = "canonical";\n${configSource}`,
			"canonical conflict",
		);
	}
	const canonicalBare = path.join(root, "canonical.git");
	git(root, "clone", "--bare", canonicalWork, canonicalBare);

	const upstreamWork = path.join(root, "upstream-work");
	git(root, "clone", "--no-local", seed, upstreamWork);
	git(upstreamWork, "config", "user.name", "Controller Fixture");
	git(upstreamWork, "config", "user.email", "fixture@invalid");
	git(upstreamWork, "branch", "-M", "main");
	const sensitivePath = conflict
		? "packages/coding-agent/src/config.ts"
		: "packages/coding-agent/src/config/models-config-schema.ts";
	const sensitiveSource = await fs.readFile(path.join(upstreamWork, ...sensitivePath.split("/")), "utf8");
	const sensitiveContent = conflict
		? `export const controllerFixtureConflict = "upstream";\n${sensitiveSource}`
		: `${sensitiveSource}\n// upstream compatibility change\n`;
	await commitFile(upstreamWork, sensitivePath, sensitiveContent, "upstream sensitive change");
	const packageJson = JSON.parse(
		await fs.readFile(path.join(upstreamWork, "packages/coding-agent/package.json"), "utf8"),
	) as { version: string };
	upstreamTag = packageJson.version;
	git(upstreamWork, "tag", packageJson.version);
	const upstreamBare = path.join(root, "upstream.git");
	git(root, "clone", "--bare", upstreamWork, upstreamBare);

	const gitConfig = path.join(root, "gitconfig");
	await fs.writeFile(
		gitConfig,
		`[url "${canonicalBare.replaceAll("\\", "/")}"]\n\tinsteadOf = https://github.com/The-AutoBot/oh-my-pi.git\n[url "${upstreamBare.replaceAll("\\", "/")}"]\n\tinsteadOf = https://github.com/example/upstream.git\n[user]\n\tname = Controller Fixture\n\temail = fixture@invalid\n`,
	);
	await fs.mkdir(externalBoundaryBin);
	await fs.writeFile(
		path.join(externalBoundaryBin, "gh.cmd"),
		[
			"@echo off",
			`>> "%AUTOBOT_CONTROLLER_EXTERNAL_SENTINEL%" echo gh-fallback`,
			'if not "%~1"=="api" exit /b 97',
			'if not "%~2"=="--method" exit /b 97',
			'if not "%~3"=="GET" exit /b 97',
			`if not "%~4"=="repos/example/upstream/releases/tags/${packageJson.version}" exit /b 97`,
			`echo {"tag_name":"${packageJson.version}","draft":false,"prerelease":false}`,
			"exit /b 0",
		].join("\r\n"),
	);
	await fs.writeFile(
		ompFallbackPath,
		["@echo off", `>> "%AUTOBOT_CONTROLLER_EXTERNAL_SENTINEL%" echo omp-fallback`, "exit /b 97"].join("\r\n"),
	);
	const privateRoot = await ensureAutoBotPrivateDirectory(path.join(root, "private"));
	const workRoot = path.join(privateRoot, "work");
	await ensureAutoBotPrivateDirectory(workRoot);
	const statePath = path.join(privateRoot, "fixture-state.json");
	await fs.writeFile(statePath, JSON.stringify({ builds: 0, buildEntries: [], ompReasons: [], scenario }));
	const privateKeyPath = path.join(privateRoot, "private.key");
	const publicKeyPath = path.join(privateRoot, "public.key");
	await Promise.all([
		fs.writeFile(privateKeyPath, "fixture private key\n"),
		fs.writeFile(publicKeyPath, "fixture public key\n"),
	]);
	const configPath = path.join(privateRoot, "config.json");
	await fs.writeFile(
		configPath,
		JSON.stringify({
			schemaVersion: 1,
			repository: "The-AutoBot/oh-my-pi",
			canonicalBranch: "main",
			integrationBranch: "autobot-local",
			upstreamRepository: "https://github.com/example/upstream.git",
			upstreamRef: `refs/tags/${packageJson.version}`,
			workRoot,
			runnerBun: process.execPath,
			runnerBunVersion: Bun.version,
			compilerBun: process.execPath,
			compilerBunVersion: Bun.version,
			nativeAddonDirectory: privateRoot,
			nativeAddonProvenanceSha256: "a".repeat(64),
			ompExecutable: ompFallbackPath,
			coordinatorRoot: maintainedRoot,
			keyId: "fixture",
			privateKeyPath,
			publicKeyPath,
			channelRepository: "The-AutoBot/channel",
			channelBranch: "main",
			channelPath: "signed-envelope.json",
			allowInitial: true,
			maxOmpAttempts: scenario === "budget" ? 2 : 3,
			ompMaxTime: "30s",
		}),
	);

	const runs: RunResult[] = [];
	const writeProgress = async (): Promise<void> => {
		await fs.writeFile(
			progressPath,
			JSON.stringify({
				fixtureElapsedMs: Math.max(0, Math.floor(performance.now() - fixtureStartedAt)),
				runs,
			}),
		);
	};
	await writeProgress();
	if (scenario === "producer-pre-mutation") {
		await fs.appendFile(path.join(controllerSource, "README.md"), "\nfixture pre-run producer mutation\n");
	}
	runs.push(await invoke(configPath, statePath, gitConfig));
	await writeProgress();
	if (scenario === "pin-invalidation" && runs[0]?.exitCode === 0) {
		await commitFile(
			upstreamWork,
			"fixture-upstream-pin.txt",
			"same relevant content, new upstream pin\n",
			"advance upstream pin",
		);
		git(upstreamWork, "tag", "--force", packageJson.version);
		git(upstreamWork, "push", "--force", upstreamBare, `refs/tags/${packageJson.version}`);
		git(upstreamWork, "push", upstreamBare, "main");
		runs.push(await invoke(configPath, statePath, gitConfig));
		await writeProgress();
		await commitFile(canonicalWork, "fixture-canonical-pin.txt", "new canonical pin\n", "advance canonical pin");
		git(canonicalWork, "push", canonicalBare, "main");
		runs.push(await invoke(configPath, statePath, gitConfig));
		await writeProgress();
	}
	const fixtureState = JSON.parse(await fs.readFile(statePath, "utf8"));
	let controllerState: unknown = null;
	try {
		controllerState = JSON.parse(await fs.readFile(path.join(workRoot, ".autobot-local-state.json"), "utf8"));
	} catch {
		// A setup failure before state creation is reported through the run result.
	}
	let controllerDiagnostics: unknown = null;
	try {
		controllerDiagnostics = JSON.parse(
			await fs.readFile(path.join(workRoot, ".autobot-local-diagnostics.json"), "utf8"),
		);
	} catch {
		// A failure before diagnostics creation is represented by null.
	}
	const externalFallbacks = await fs
		.readFile(externalBoundarySentinel, "utf8")
		.then(contents => contents.split(/\r?\n/).filter(Boolean))
		.catch(() => []);
	const failureDetail = await fs
		.readFile(failureDetailPath, "utf8")
		.then(contents => JSON.parse(contents) as unknown)
		.catch(() => null);
	const allGitInvocations = await fs
		.readFile(gitInvocationLog, "utf8")
		.then(contents =>
			contents
				.split(/\r?\n/)
				.filter(Boolean)
				.map(line => line.split(root).join("[fixture-root]").slice(0, 1024)),
		)
		.catch(() => []);
	const gitInvocations = {
		count: allGitInvocations.length,
		first: allGitInvocations.slice(0, 4),
		last: allGitInvocations.slice(-4),
	};
	console.log(
		JSON.stringify({
			failureDetail,
			runs,
			fixtureState,
			controllerState,
			controllerDiagnostics,
			externalFallbacks,
			gitInvocations,
		}),
	);
} finally {
	await fs.rm(root, { recursive: true, force: true });
}
