import * as fs from "node:fs/promises";
import * as path from "node:path";

interface Release {
	tag_name: string;
	draft: boolean;
	target_commitish: string;
	assets: string;
}
interface State {
	releases: Release[];
	releaseGit: string;
	channelGit: string;
	channelBranch: string;
	channelPath: string;
	log: string[];
	publishAfterAssetView?: boolean;
	listedExtraAsset?: string;
}

const statePath = process.env.AUTOBOT_FAKE_GH_STATE;
if (!statePath) throw new Error("AUTOBOT_FAKE_GH_STATE is required");
const args = process.argv.slice(2);
const state = JSON.parse(await fs.readFile(statePath, "utf8")) as State;
const save = async (): Promise<void> => fs.writeFile(statePath, JSON.stringify(state));
const log = async (value: string): Promise<void> => {
	state.log.push(value);
	await save();
};
const gitBytes = (gitArgs: string[]): Buffer => {
	const child = Bun.spawnSync(["git", ...gitArgs], { stdout: "pipe", stderr: "pipe" });
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	return Buffer.from(child.stdout);
};
const git = (gitArgs: string[]): string => gitBytes(gitArgs).toString().trim();
const included = (status: number, body: unknown): void => {
	process.stdout.write(`HTTP/1.1 ${status} fixture\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`);
};
const releaseRepository = "The-AutoBot/oh-my-pi";
const channelRepositoryEndpoint = "repos/The-AutoBot/channel";
const channelBranchEndpoint = `${channelRepositoryEndpoint}/branches/${state.channelBranch}`;
const channelContentsEndpoint = `${channelRepositoryEndpoint}/contents/${state.channelPath}?ref=${state.channelBranch}`;
const exactArgs = (expected: readonly string[]): boolean =>
	args.length === expected.length && expected.every((value, index) => args[index] === value);
const fixtureRoot = path.dirname(statePath);
const isInsideFixture = (pathname: string): boolean => {
	const relative = path.relative(fixtureRoot, pathname);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

if (exactArgs(["api", "--paginate", "--slurp", `repos/${releaseRepository}/releases?per_page=100`])) {
	process.stdout.write(JSON.stringify([state.releases]));
} else if (args[0] === "api" && args[1] === "--include" && args.length === 3) {
	const endpoint = args[2]!;
	if (endpoint === channelContentsEndpoint) {
		try {
			const bytes = gitBytes(["--git-dir", state.channelGit, "show", `${state.channelBranch}:${state.channelPath}`]);
			included(200, { encoding: "base64", content: bytes.toString("base64") });
		} catch {
			included(404, { message: "Not Found" });
		}
	} else if (endpoint === channelRepositoryEndpoint || endpoint === channelBranchEndpoint) {
		included(200, {});
	} else {
		throw new Error(`unsupported fake gh API route: ${endpoint}`);
	}
} else if (exactArgs(["auth", "setup-git"])) {
	await log("auth");
} else if (args[0] === "release" && args[1] === "create") {
	if (
		args.length !== 12 ||
		args[3] !== "--repo" ||
		args[4] !== releaseRepository ||
		args[5] !== "--target" ||
		args[7] !== "--draft" ||
		args[8] !== "--title" ||
		!args[9] ||
		args[10] !== "--notes" ||
		!args[11]
	) {
		throw new Error("unsupported fake gh release create invocation");
	}
	const tag = args[2]!;
	const target = args[6]!;
	if (state.releases.some(release => release.tag_name === tag)) throw new Error("release exists");
	const tagged = git(["--git-dir", state.releaseGit, "rev-parse", `refs/tags/${tag}^{commit}`]);
	if (tagged !== target) throw new Error("release tag was not bound to the exact target before draft creation");
	const assets = path.join(fixtureRoot, `assets-${tag}`);
	await fs.mkdir(assets);
	state.releases.push({ tag_name: tag, draft: true, target_commitish: target, assets });
	state.log.push(`tag-exact-at-create:${tag}`);
	await log(`create:${tag}`);
} else if (
	args[0] === "release" &&
	args[1] === "view" &&
	exactArgs(["release", "view", args[2]!, "--repo", releaseRepository, "--json", "assets"])
) {
	const tag = args[2]!;
	const release = state.releases.find(value => value.tag_name === tag);
	if (!release) throw new Error("release missing");
	const names = await fs.readdir(release.assets);
	if (state.listedExtraAsset) names.push(state.listedExtraAsset);
	if (state.publishAfterAssetView) {
		release.draft = false;
		await log(`transition-published:${tag}`);
	}
	process.stdout.write(JSON.stringify({ assets: names.map(name => ({ name })) }));
} else if (args[0] === "release" && args[1] === "upload") {
	const tag = args[2]!;
	const fresh = state.log.includes(`create:${tag}`);
	if (
		args[3] !== "--repo" ||
		args[4] !== releaseRepository ||
		(fresh ? args.length !== 14 : args.length < 6 || args.length > 14)
	) {
		throw new Error("unsupported fake gh release upload invocation");
	}
	const sources = args.slice(5);
	if (
		sources.some(source => !path.isAbsolute(source) || !isInsideFixture(path.resolve(source))) ||
		new Set(sources.map(source => path.basename(source))).size !== sources.length
	) {
		throw new Error("release upload paths are not exact unique fixture files");
	}
	const release = state.releases.find(value => value.tag_name === tag && value.draft);
	if (!release) throw new Error("draft missing");
	for (const source of sources) {
		const destination = path.join(release.assets, path.basename(source));
		if (await fs.stat(destination).catch(() => undefined)) throw new Error("asset exists");
		await fs.copyFile(source, destination);
	}
	await log(`${fresh ? "upload" : "resume-upload"}:${tag}:${sources.map(source => path.basename(source)).join(",")}`);
} else if (args[0] === "release" && args[1] === "download") {
	if (
		args.length !== 9 ||
		args[3] !== "--repo" ||
		args[4] !== releaseRepository ||
		args[5] !== "--dir" ||
		!args[6] ||
		args[7] !== "--pattern" ||
		args[8] !== "*"
	) {
		throw new Error("unsupported fake gh release download invocation");
	}
	const tag = args[2]!;
	const destination = path.resolve(args[6]!);
	if (!isInsideFixture(destination)) throw new Error("release download directory escapes fixture ownership");
	const release = state.releases.find(value => value.tag_name === tag);
	if (!release) throw new Error("release missing");
	await fs.mkdir(destination, { recursive: true });
	for (const name of await fs.readdir(release.assets))
		await fs.copyFile(path.join(release.assets, name), path.join(destination, name));
	await log(`download:${tag}`);
} else if (args[0] === "release" && args[1] === "edit") {
	if (!exactArgs(["release", "edit", args[2]!, "--repo", releaseRepository, "--draft=false"])) {
		throw new Error("unsupported fake gh release edit invocation");
	}
	const tag = args[2]!;
	const release = state.releases.find(value => value.tag_name === tag && value.draft);
	if (!release) throw new Error("draft missing");
	release.draft = false;
	await log(`publish:${tag}`);
} else {
	throw new Error(`unsupported fake gh invocation: ${args.join(" ")}`);
}
