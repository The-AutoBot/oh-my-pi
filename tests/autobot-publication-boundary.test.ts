import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertCandidatePublicationBoundary,
	assertDeclaredStagedDiff,
	parseRepairIntent,
	stageDeclaredRepair,
} from "../scripts/autobot-publication-boundary";

const temporaryDirectories: string[] = [];

async function git(root: string, args: readonly string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], {
		cwd: root,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	return stdout;
}

async function createRepository(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autobot-publication-boundary-"));
	temporaryDirectories.push(root);
	await git(root, ["init"]);
	await git(root, ["config", "user.name", "AutoBot test"]);
	await git(root, ["config", "user.email", "autobot-test@example.invalid"]);
	return root;
}

async function writeRepositoryFile(root: string, repositoryPath: string, contents: string): Promise<void> {
	const destination = path.join(root, ...repositoryPath.split("/"));
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.writeFile(destination, contents);
}

async function stagePaths(root: string, paths: readonly string[], force = false): Promise<void> {
	for (const repositoryPath of paths) {
		await git(root, ["add", ...(force ? ["-f"] : []), "--", `:(literal)${repositoryPath}`]);
	}
}

async function commitStaged(root: string, subject: string): Promise<string> {
	await git(root, ["commit", "--no-gpg-sign", "-m", subject]);
	return (await git(root, ["rev-parse", "HEAD"])).trim();
}

async function commitPaths(root: string, subject: string, paths: readonly string[]): Promise<string> {
	await stagePaths(root, paths);
	return commitStaged(root, subject);
}

function nulPaths(value: string): string[] {
	const paths = value.split("\0");
	expect(paths.pop()).toBe("");
	return paths.sort();
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("AutoBot declared repair staging", () => {
	test("rejects the observed generated residue without staging valid source changes", async () => {
		const repository = await createRepository();
		await writeRepositoryFile(repository, ".gitignore", ".bun-cache/\n");
		await writeRepositoryFile(repository, "src/kept.ts", "export const kept = 1;\n");
		await commitPaths(repository, "initial", [".gitignore", "src/kept.ts"]);

		const literalPath = "src/-literal [repair].ts";
		await writeRepositoryFile(repository, "src/kept.ts", "export const kept = 2;\n");
		await writeRepositoryFile(repository, literalPath, "export const literal = true;\n");
		await writeRepositoryFile(repository, ".integration-check/result.json", "{}\n");
		await writeRepositoryFile(repository, ".bun-cache/cache.json", "{}\n");
		await writeRepositoryFile(repository, "packages/coding-agent/.semgrep/guardian.yml", "generated\n");
		await writeRepositoryFile(repository, "packages/coding-agent/.semgrep/guardian.yml.lock", "generated\n");
		await writeRepositoryFile(repository, "packages/coding-agent/.semgrep/.lock", "generated\n");

		const intent = { paths: ["src/kept.ts", literalPath] };
		await expect(stageDeclaredRepair(repository, intent)).rejects.toThrow("publication boundary rejects");
		expect(await git(repository, ["diff", "--cached", "--name-only", "-z"])).toBe("");

		await fs.rm(path.join(repository, ".integration-check"), { recursive: true, force: true });
		await fs.rm(path.join(repository, ".bun-cache"), { recursive: true, force: true });
		await fs.rm(path.join(repository, "packages", "coding-agent", ".semgrep"), { recursive: true, force: true });
		await stageDeclaredRepair(repository, intent);
		expect(nulPaths(await git(repository, ["diff", "--cached", "--name-only", "-z"]))).toEqual(
			["src/kept.ts", literalPath].sort(),
		);
	});

	test("rejects a force-staged ignored artifact outside the declaration", async () => {
		const repository = await createRepository();
		await writeRepositoryFile(repository, ".gitignore", ".bun-cache/\n");
		await writeRepositoryFile(repository, "src/repair.ts", "export const repaired = false;\n");
		await commitPaths(repository, "initial", [".gitignore", "src/repair.ts"]);

		await writeRepositoryFile(repository, "src/repair.ts", "export const repaired = true;\n");
		await writeRepositoryFile(repository, ".bun-cache/forced.json", "{}\n");
		await stagePaths(repository, [".bun-cache/forced.json"], true);

		await expect(stageDeclaredRepair(repository, { paths: ["src/repair.ts"] })).rejects.toThrow(
			"publication boundary rejects",
		);
		expect(nulPaths(await git(repository, ["diff", "--cached", "--name-only", "-z"]))).toEqual([
			".bun-cache/forced.json",
		]);
	});

	test("rejects undeclared ordinary source changes before staging", async () => {
		const repository = await createRepository();
		await writeRepositoryFile(repository, "src/declared.ts", "export const declared = false;\n");
		await writeRepositoryFile(repository, "src/undeclared.ts", "export const undeclared = false;\n");
		await commitPaths(repository, "initial", ["src/declared.ts", "src/undeclared.ts"]);

		await writeRepositoryFile(repository, "src/declared.ts", "export const declared = true;\n");
		await writeRepositoryFile(repository, "src/undeclared.ts", "export const undeclared = true;\n");

		await expect(stageDeclaredRepair(repository, { paths: ["src/declared.ts"] })).rejects.toThrow(
			"does not match its declared repair paths",
		);
		expect(await git(repository, ["diff", "--cached", "--name-only", "-z"])).toBe("");
	});

	test("rejects executable bundle descendants before staging", async () => {
		const repository = await createRepository();
		await writeRepositoryFile(repository, "src/base.ts", "export const base = true;\n");
		await commitPaths(repository, "initial", ["src/base.ts"]);
		const bundlePath = "payload.app/Contents/MacOS/run";
		await writeRepositoryFile(repository, bundlePath, "binary payload\n");

		await expect(stageDeclaredRepair(repository, { paths: [bundlePath] })).rejects.toThrow(
			"publication boundary rejects",
		);
		expect(await git(repository, ["diff", "--cached", "--name-only", "-z"])).toBe("");
	});

	test("stages declared deletions and both sides of a literal rename", async () => {
		const repository = await createRepository();
		const oldPath = "src/old - [literal].ts";
		const newPath = "src/new - [literal].ts";
		await writeRepositoryFile(repository, oldPath, "export const oldValue = true;\n");
		await writeRepositoryFile(repository, "src/remove.ts", "export const remove = true;\n");
		const base = await commitPaths(repository, "initial", [oldPath, "src/remove.ts"]);

		await fs.rename(path.join(repository, ...oldPath.split("/")), path.join(repository, ...newPath.split("/")));
		await fs.rm(path.join(repository, "src", "remove.ts"));
		await writeRepositoryFile(repository, "src/added.ts", "export const added = true;\n");
		const intent = { paths: [oldPath, newPath, "src/remove.ts", "src/added.ts"] };

		await stageDeclaredRepair(repository, intent);
		await assertDeclaredStagedDiff(repository, base, intent);
		expect(nulPaths(await git(repository, ["diff", "--cached", "--name-only", "--no-renames", "-z"]))).toEqual(
			[oldPath, newPath, "src/remove.ts", "src/added.ts"].sort(),
		);
	});
});

describe("AutoBot candidate publication history", () => {
	test("allows exact pinned input bytes but rejects a force-staged committed bypass", async () => {
		const repository = await createRepository();
		await writeRepositoryFile(repository, ".gitignore", ".bun-cache/\n");
		await writeRepositoryFile(repository, "src/base.ts", "export const base = true;\n");
		const canonical = await commitPaths(repository, "initial", [".gitignore", "src/base.ts"]);

		await git(repository, ["checkout", "-b", "upstream", canonical]);
		await writeRepositoryFile(repository, ".integration-check/pinned.json", '{"pinned":true}\n');
		const upstream = await commitPaths(repository, "pinned upstream verification input", [
			".integration-check/pinned.json",
		]);

		await git(repository, ["checkout", "-b", "candidate", canonical]);
		await git(repository, ["merge", "--no-ff", "--no-gpg-sign", "-m", "candidate merge", upstream]);
		const cleanCandidate = (await git(repository, ["rev-parse", "HEAD"])).trim();
		await assertCandidatePublicationBoundary(repository, cleanCandidate, canonical, upstream);

		await writeRepositoryFile(repository, ".bun-cache/committed.json", "{}\n");
		await stagePaths(repository, [".bun-cache/committed.json"], true);
		const contaminated = await commitStaged(repository, "forced artifact");
		await expect(assertCandidatePublicationBoundary(repository, contaminated, canonical, upstream)).rejects.toThrow(
			"publication boundary rejects",
		);
	});

	test("rejects a historic candidate with generated local residue", async () => {
		const repository = await createRepository();
		await writeRepositoryFile(repository, ".gitignore", ".integration-check/\n");
		await writeRepositoryFile(repository, "src/base.ts", "export const base = true;\n");
		const candidate = await commitPaths(repository, "initial", [".gitignore", "src/base.ts"]);
		await writeRepositoryFile(repository, ".integration-check/home/.omp/agent/agent.db-shm", "local state\n");

		await expect(assertCandidatePublicationBoundary(repository, candidate, candidate, candidate)).rejects.toThrow(
			"publication boundary rejects",
		);
	});

	test("fails closed on malformed and replayed repair declarations", () => {
		expect(() => parseRepairIntent({ schemaVersion: 1, nonce: "other", paths: [] }, "expected")).toThrow(
			"does not belong",
		);
		expect(() =>
			parseRepairIntent({ schemaVersion: 1, nonce: "expected", paths: ["src/a.ts", "src/a.ts"] }, "expected"),
		).toThrow("duplicates");
		expect(() =>
			parseRepairIntent({ schemaVersion: 1, nonce: "expected", paths: ["src/a.ts"], extra: true }, "expected"),
		).toThrow("exactly");
	});
});
