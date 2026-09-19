import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCandidateBuildEnvironment } from "../scripts/autobot-local-release.ts";

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
		await fs.writeFile(publisherGitConfig, "");

		const candidateEnvironment = await createCandidateBuildEnvironment(stageRoot, publisherEnvironment);
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
const locations = Object.fromEntries(names.map(name => [name, process.env[name]]));
locations.osHome = os.homedir();
for (const [name, directory] of Object.entries(locations)) {
	if (!directory) throw new Error(\`Missing \${name}\`);
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(path.join(directory, \`\${name}.probe\`), name);
}
process.stdout.write(JSON.stringify(locations));`,
				],
				{ cwd: sourceRoot, env: candidateEnvironment },
			),
		) as Record<string, string>;
		expect(observedPaths).toEqual({ ...expectedPaths, osHome: expectedPaths.HOME });
		for (const [name, directory] of Object.entries(observedPaths)) {
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
