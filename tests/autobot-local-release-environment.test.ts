import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertDeclaredToolingBunSupport,
	createCandidateBuildEnvironment,
	createPinnedBunCommandEnvironment,
	runQuiet,
} from "../scripts/autobot-local-release.ts";

const environmentNames = [
	"HOME",
	"USERPROFILE",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"APPDATA",
	"LOCALAPPDATA",
	"BUN_INSTALL_CACHE_DIR",
	"TEMP",
	"TMP",
	"TMPDIR",
] as const;


function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function runText(
	command: readonly string[],
	options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<string> {
	const child = Bun.spawn([...command], {
		cwd: options.cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr}`);
	return stdout;
}

test("keeps candidate home and Bun cache inside the release stage without changing publisher identity lookup", async () => {
	const root = await fs.mkdtemp(path.join(os.homedir(), "omp-autobot-release-environment-"));
	try {
		const sourceRoot = path.join(root, "candidate-source");
		const stageRoot = path.join(root, "release-stage");
		const publisherHome = path.join(root, "publisher-home");
		const publisherGitConfig = path.join(publisherHome, "empty.gitconfig");
		const preloadMarker = path.join(root, "preload-executed");
		const untrustedPreload = path.join(root, "untrusted-preload.ts");
		const publisherEnvironment: NodeJS.ProcessEnv = {
			PATH: process.env.PATH ?? "",
			HOME: publisherHome,
			USERPROFILE: publisherHome,
			XDG_CONFIG_HOME: path.join(publisherHome, "xdg-config"),
			XDG_DATA_HOME: path.join(publisherHome, "xdg-data"),
			XDG_CACHE_HOME: path.join(publisherHome, "xdg-cache"),
			XDG_STATE_HOME: path.join(publisherHome, "xdg-state"),
			APPDATA: path.join(publisherHome, "appdata"),
			LOCALAPPDATA: path.join(publisherHome, "localappdata"),
			BUN_INSTALL_CACHE_DIR: path.join(publisherHome, "bun-cache"),
			GIT_AUTHOR_NAME: "AutoBot Publisher",
			GIT_AUTHOR_EMAIL: "publisher@example.invalid",
			GIT_COMMITTER_NAME: "AutoBot Publisher",
			GIT_COMMITTER_EMAIL: "publisher@example.invalid",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: publisherGitConfig,
			GITHUB_TOKEN: "candidate-must-not-inherit",
			NPM_TOKEN: "candidate-must-not-inherit",
			BUN_PRELOAD: untrustedPreload,
			NODE_OPTIONS: "--require untrusted",
		};
		for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT"] as const) {
			const value = process.env[name];
			if (value) publisherEnvironment[name] = value;
		}
		await Promise.all([
			fs.mkdir(sourceRoot, { mode: 0o700 }),
			fs.mkdir(stageRoot, { mode: 0o700 }),
			fs.mkdir(publisherHome, { mode: 0o700 }),
		]);
		await Promise.all([
			fs.writeFile(publisherGitConfig, ""),
			fs.writeFile(
				untrustedPreload,
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(preloadMarker)}, "executed");`,
			),
		]);

		const candidateEnvironment = await createCandidateBuildEnvironment(stageRoot, publisherEnvironment);
		const pinnedEnvironment = await createPinnedBunCommandEnvironment(
			path.join(stageRoot, "pinned-bun"),
			process.execPath,
			Bun.version,
			{ ...candidateEnvironment, Path: "" },
		);
		expect((await runText(["bun", "--version"], { cwd: sourceRoot, env: pinnedEnvironment })).trim()).toBe(
			Bun.version,
		);
		const expectedPaths: Record<string, string> = {};
		for (const name of environmentNames) {
			const value = candidateEnvironment[name];
			if (!value) throw new Error(`Candidate command environment omitted ${name}`);
			expectedPaths[name] = value;
		}

		const bunCache = (
			await runText([process.execPath, "pm", "cache"], { cwd: sourceRoot, env: candidateEnvironment })
		).trim();
		expect(path.resolve(bunCache)).toBe(path.resolve(expectedPaths.BUN_INSTALL_CACHE_DIR));

		const observedPaths = JSON.parse(
			await runText(
				[
					process.execPath,
					"-e",
					`import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const names = ${JSON.stringify(environmentNames)};
const sensitiveNames = ["GITHUB_TOKEN", "NPM_TOKEN", "BUN_PRELOAD", "NODE_OPTIONS"];
const environmentValue = name =>
	Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1];
const locations = Object.fromEntries(names.map(name => [name, process.env[name]]));
const sensitive = Object.fromEntries(sensitiveNames.map(name => [name, environmentValue(name) ?? null]));
locations.osHome = os.homedir();
for (const [name, directory] of Object.entries(locations)) {
	if (!directory) throw new Error(\`Missing \${name}\`);
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(path.join(directory, \`\${name}.probe\`), name);
}
process.stdout.write(JSON.stringify({
	locations,
	sensitive,
	noEnvFile: process.env.BUN_CONFIG_NO_ENV_FILE,
}));`,
				],
				{ cwd: sourceRoot, env: candidateEnvironment },
			),
		) as {
			locations: Record<string, string>;
			sensitive: Record<string, string | null>;
			noEnvFile?: string;
		};
		expect(observedPaths.locations).toEqual({ ...expectedPaths, osHome: expectedPaths.HOME });
		expect(observedPaths.sensitive).toEqual({
			GITHUB_TOKEN: null,
			NPM_TOKEN: null,
			BUN_PRELOAD: null,
			NODE_OPTIONS: null,
		});
		expect(observedPaths.noEnvFile).toBe("1");
		expect(await Bun.file(preloadMarker).exists()).toBe(false);
		for (const [name, directory] of Object.entries(observedPaths.locations)) {
			expect(isInside(stageRoot, directory)).toBe(true);
			expect(isInside(sourceRoot, directory)).toBe(false);
			expect(await Bun.file(path.join(directory, `${name}.probe`)).text()).toBe(name);
		}
		expect(await fs.readdir(sourceRoot)).toEqual([]);


		const publisherIdentity = await runText(["git", "var", "GIT_AUTHOR_IDENT"], {
			cwd: sourceRoot,
			env: publisherEnvironment,
		});
		expect(publisherIdentity).toContain("AutoBot Publisher <publisher@example.invalid>");
		expect(publisherEnvironment.HOME).toBe(publisherHome);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("redacts sensitive output before bounded command capture discards stream context", async () => {
	const commandCredential = "known-command-credential-canary";
	const parentCredential = "known-parent-credential-canary";
	const previousParentCredential = process.env.AUTOBOT_CAPTURE_PARENT_SECRET;
	process.env.AUTOBOT_CAPTURE_PARENT_SECRET = parentCredential;
	try {
		let captured: { stdout: string; stderr: string; truncated: boolean } | undefined;
		const recorder = {
			async record(): Promise<void> {},
			async recordOutput(record: {
				commandKind: string;
				stdout: string;
				stderr: string;
				truncated: boolean;
			}): Promise<void> {
				captured = record;
			},
		};
		const commandEnvironment: NodeJS.ProcessEnv = {
			...process.env,
			AUTOBOT_CAPTURE_SECRET: commandCredential,
		};
		delete commandEnvironment.AUTOBOT_CAPTURE_PARENT_SECRET;
		await runQuiet(
			recorder,
			"native-addon-reuse-check",
			"sensitive capture probe",
			[
				process.execPath,
				"-e",
				`const parentCredential = ${JSON.stringify(parentCredential)};
const commandCredential = process.env.AUTOBOT_CAPTURE_SECRET;
const token = ["github", "_pat_", "A".repeat(24)].join("");
const url = "https://private.example/path?auth=canary";
const capabilityUrl = "wss://collab.example/session?capability=private-canary";
const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const end = ["-----END ", "PRIVATE KEY-----"].join("");
const material = [
	parentCredential,
	commandCredential,
	token,
	url,
	capabilityUrl,
	begin,
	"PRIVATE-KEY-CANARY",
	end,
	"",
].join("\\n");
const padding = "z".repeat(8 * 1024 - Buffer.byteLength(material.slice(1)));
process.stdout.write("x".repeat(40 * 1024) + "\\n" + material + padding);`,
			],
			{ captureOutput: true, env: commandEnvironment },
		);
		expect(captured).toBeDefined();
		expect(captured?.stdout).toContain("[REDACTED PRIVATE KEY]");
		expect(captured?.stdout).not.toContain("PRIVATE-KEY-CANARY");
		expect(captured?.stdout).not.toContain(commandCredential);
		expect(captured?.stdout).not.toContain(parentCredential);
		expect(captured?.stdout).not.toContain(parentCredential.slice(1));
		expect(captured?.stdout).not.toContain("wss://collab.example");
		expect(captured?.stdout).not.toContain("github_pat_");
		expect(captured?.stdout).not.toContain("https://private.example");
		expect(captured?.stdout).not.toContain("-----END PRIVATE KEY-----");
		expect(captured?.truncated).toBe(true);
	} finally {
		if (previousParentCredential === undefined) delete process.env.AUTOBOT_CAPTURE_PARENT_SECRET;
		else process.env.AUTOBOT_CAPTURE_PARENT_SECRET = previousParentCredential;
	}
});

test("enforces exact and minimum Bun tooling declarations with canonical numeric versions", async () => {
	const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bun-tooling-policy-"));
	const declare = async (packageManager: string): Promise<void> => {
		await fs.writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({ packageManager }));
	};
	try {
		await declare("bun@>=1.4");
		await expect(assertDeclaredToolingBunSupport(sourceRoot, "1.4.0")).resolves.toBe("bun@>=1.4");
		await expect(assertDeclaredToolingBunSupport(sourceRoot, "1.3.14")).rejects.toThrow(
			"does not satisfy",
		);
		await expect(assertDeclaredToolingBunSupport(sourceRoot, "not-a-version")).rejects.toThrow(
			"supported numeric version",
		);

		await declare("bun@1.4.0");
		await expect(assertDeclaredToolingBunSupport(sourceRoot, "1.4.1")).rejects.toThrow("does not satisfy");

		await declare("bun@^1.4");
		await expect(assertDeclaredToolingBunSupport(sourceRoot, "1.4.0")).rejects.toThrow(
			"unsupported Bun tooling declaration",
		);
	} finally {
		await fs.rm(sourceRoot, { recursive: true, force: true });
	}
});
