import { createHash, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AUTO_BOT_COMPATIBILITY_EPOCH } from "../../packages/coding-agent/src/autobot-update/contract.ts";
import { ensureAutoBotPrivateDirectory } from "../../packages/coding-agent/src/autobot-update/permissions.ts";
import { createManagedBundle, deriveManagedBundleId } from "../../scripts/autobot-release-web.ts";
import { COORDINATOR_CLIENT_FILENAME } from "../../scripts/autobot-release-coordinator.ts";
import {
	admitPreparedLocalRelease,
	authenticateCompletedLocalRelease,
	publishPreparedLocalRelease,
} from "../../scripts/autobot-local-release.ts";
import type { LocalAutomationConfig, LocalCandidate } from "../../scripts/autobot-local-types.ts";
import type { LocalCommandDiagnosticRecord, LocalCommandRecorder } from "../../scripts/autobot-local.ts";

const scenario = process.argv[2];
if (!scenario) throw new Error("scenario is required");
const fakeGhExecutable = process.env.AUTOBOT_FAKE_GH_EXE;
if (!fakeGhExecutable || !path.isAbsolute(fakeGhExecutable)) {
	throw new Error("AUTOBOT_FAKE_GH_EXE must name the parent-owned native fixture executable");
}
const repoRoot = path.resolve(import.meta.dir, "../..");
const root = await fs.mkdtemp(path.join(os.homedir(), "omp-publication-test-"));
process.env.GIT_ALLOW_PROTOCOL = "file";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "isolated.gitconfig");
process.env.HOME = root;
process.env.USERPROFILE = root;
const ghConfigDir = path.join(root, "gh-config");
process.env.GH_CONFIG_DIR = ghConfigDir;
process.env.GH_PROMPT_DISABLED = "1";
for (const name of [
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GH_DEBUG",
	"GITHUB_DEBUG",
	"ACTIONS_STEP_DEBUG",
] as const) {
	delete process.env[name];
}
delete process.env.GIT_CONFIG_COUNT;
for (const name of Object.keys(process.env)) {
	if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete process.env[name];
}
await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, "");
const run = (argv: string[], cwd = root, env: NodeJS.ProcessEnv = process.env): string => {
	const child = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
	if (child.exitCode !== 0) throw new Error(`${argv[0]} failed: ${child.stderr.toString()}`);
	return child.stdout.toString().trim();
};
const git = (cwd: string, ...args: string[]): string => run(["git", ...args], cwd);
const write = async (file: string, value: string | Uint8Array): Promise<void> => {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, value);
};
const sha256 = async (file: string): Promise<string> => {
	const hash = createHash("sha256");
	hash.update(new Uint8Array(await Bun.file(file).arrayBuffer()));
	return hash.digest("hex");
};
const commit = (repository: string, message: string): string => {
	git(repository, "add", "-A");
	git(repository, "commit", "--no-gpg-sign", "-m", message);
	return git(repository, "rev-parse", "HEAD");
};
try {
	const source = path.join(root, "source");
	const releaseGit = path.join(root, "release.git");
	const channelSeed = path.join(root, "channel-seed");
	const channelGit = path.join(root, "channel.git");
	const coordinator = path.join(root, "coordinator");
	const nativeAddonDirectory = path.join(root, "native-input");
	for (const repository of [source, channelSeed, coordinator]) {
		await fs.mkdir(repository);
		git(repository, "init", "-b", "main");
		git(repository, "config", "user.name", "Fixture Publisher");
		git(repository, "config", "user.email", "publisher@example.invalid");
	}
	await fs.mkdir(nativeAddonDirectory);
	await write(path.join(source, "package.json"), '{"name":"fixture","version":"18.2.3"}\n');
	await write(path.join(source, "upstream.txt"), "upstream\n");
	const upstreamCommit = commit(source, "upstream");
	await write(path.join(source, "candidate.txt"), "candidate\n");
	const forkCommit = commit(source, "candidate");
	git(root, "init", "--bare", releaseGit);
	git(source, "remote", "add", "origin", releaseGit);
	git(source, "push", "origin", `HEAD:refs/heads/autobot-local`);

	await write(path.join(channelSeed, ".keep"), "initial channel\n");
	commit(channelSeed, "initial channel");
	git(root, "init", "--bare", channelGit);
	git(channelSeed, "remote", "add", "origin", channelGit);
	git(channelSeed, "push", "origin", "HEAD:refs/heads/main");
	git(channelGit, "symbolic-ref", "HEAD", "refs/heads/main");

	await write(path.join(coordinator, "src", "extension", "index.ts"), "export const fixture = import.meta.url;\n");
	const coordinatorCommit = commit(coordinator, "coordinator");
	git(coordinator, "remote", "add", "origin", "https://github.com/example/omp-session-coordinator.git");

	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const privateKeyPath = path.join(root, "private.pk8");
	const publicKeyPath = path.join(root, "public.spki");
	await write(privateKeyPath, privateKey.export({ format: "der", type: "pkcs8" }));
	await write(publicKeyPath, publicKey.export({ format: "der", type: "spki" }));

	const workRoot = path.join(root, "work");
	const stage = path.join(workRoot, "autobot-release-fixture");
	const inputs = path.join(stage, "inputs");
	const bundle = path.join(stage, "bundle");
	await ensureAutoBotPrivateDirectory(workRoot);
	await fs.mkdir(inputs, { recursive: true });
	await fs.mkdir(path.join(stage, "tmp"));
	await write(
		path.join(stage, "release-plan.json"),
		`${JSON.stringify({ ready: true, forkCommit, upstreamCommit, upstreamVersion: "18.2.3", compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH })}\n`,
	);
	const webDist = path.join(inputs, "web");
	await write(path.join(webDist, "index.html"), "<!doctype html><title>fixture</title>\n");
	const webBundleId = await deriveManagedBundleId(webDist);
	const web = path.join(inputs, `omp-collab-web-${webBundleId}.tar.gz`);
	await createManagedBundle({
		dist: webDist,
		out: web,
		bundleId: webBundleId,
		forkCommit,
		upstreamCommit,
		upstreamVersion: "18.2.3",
	});
	const runtime = path.join(inputs, "omp-runtime-win32-x64");
	const bootstrap = path.join(inputs, "omp-bootstrap-win32-x64");
	const coordinatorAsset = path.join(inputs, COORDINATOR_CLIENT_FILENAME);
	await write(runtime, "runtime\n");
	await write(bootstrap, "bootstrap\n");
	await write(coordinatorAsset, "export const fixture = import.meta.url;\n");
	const coordinatorSource = path.join(inputs, "coordinator-source.json");
	await write(
		coordinatorSource,
		`${JSON.stringify({ schemaVersion: 1, source: { repository: "https://github.com/example/omp-session-coordinator.git", commit: coordinatorCommit }, artifact: { filename: COORDINATOR_CLIENT_FILENAME, sha256: await sha256(coordinatorAsset), size: (await fs.stat(coordinatorAsset)).size } }, null, "\t")}\n`,
	);
	const thirdRelease = scenario.startsWith("third-release-");
	const subsequent = scenario === "subsequent-autocrlf" || thirdRelease;
	const releaseSequence = thirdRelease ? 3 : subsequent ? 2 : 1;
	const tag = `autobot-r${releaseSequence}`;
	const coordinatorSha = await sha256(coordinatorSource);
	const script = (name: string, args: string[]): void => {
		run([process.execPath, path.join(repoRoot, "scripts", name), ...args], repoRoot);
	};
	const assetRows = (releaseTag: string) => {
		const asset = (kind: string, target: string, sourcePath: string) => ({
			kind,
			target,
			source: sourcePath,
			url: `https://github.com/The-AutoBot/oh-my-pi/releases/download/${releaseTag}/${path.basename(sourcePath)}`,
		});
		return [
			asset("runtime", "win32-x64", runtime),
			asset("bootstrap", "win32-x64", bootstrap),
			asset("coordinator-client", "universal", coordinatorAsset),
			asset("collab-web", "web", web),
		];
	};
	const previousBundles: string[] = [];
	let previousBundle: string | undefined;
	for (let priorSequence = 1; priorSequence < releaseSequence; priorSequence += 1) {
		const priorTag = `autobot-r${priorSequence}`;
		const priorBundle = path.join(stage, `previous-bundle-${priorSequence}`);
		const previousInputs = path.join(inputs, `previous-asset-inputs-${priorSequence}.json`);
		await write(previousInputs, JSON.stringify(assetRows(priorTag)));
		script("autobot-release-assemble.ts", [
			"--out",
			priorBundle,
			"--assets",
			previousInputs,
			"--release-sequence",
			String(priorSequence),
			"--upstream-version",
			"18.2.3",
			"--fork-commit",
			forkCommit,
			"--upstream-commit",
			upstreamCommit,
			"--web-bundle-id",
			webBundleId,
			"--coordinator-source",
			coordinatorSource,
			"--coordinator-source-sha256",
			coordinatorSha,
		]);
		const priorSignArgs = [
			"--manifest",
			path.join(priorBundle, "manifest.json"),
			"--asset-index",
			path.join(priorBundle, "asset-index.json"),
			"--out",
			path.join(priorBundle, "signed-envelope.json"),
			"--key-id",
			"fixture",
			"--private-key",
			privateKeyPath,
			"--coordinator-source",
			path.join(priorBundle, "coordinator-source.json"),
			"--coordinator-source-sha256",
			coordinatorSha,
		];
		if (previousBundle) {
			priorSignArgs.push(
				"--previous-envelope",
				path.join(previousBundle, "signed-envelope.json"),
				"--trusted-key",
				`fixture=${publicKeyPath}`,
			);
		} else priorSignArgs.push("--allow-initial");
		script("autobot-release-sign.ts", priorSignArgs);
		previousBundles.push(priorBundle);
		previousBundle = priorBundle;
	}
	if (previousBundle) {
		await fs.copyFile(path.join(previousBundle, "signed-envelope.json"), path.join(channelSeed, "signed-envelope.json"));
		commit(channelSeed, "publish predecessor channel");
		git(channelSeed, "push", "origin", "HEAD:refs/heads/main");
	}
	const assetInputs = path.join(inputs, "asset-inputs.json");
	await write(assetInputs, JSON.stringify(assetRows(tag)));
	script("autobot-release-assemble.ts", [
		"--out",
		bundle,
		"--assets",
		assetInputs,
		"--release-sequence",
		String(releaseSequence),
		"--upstream-version",
		"18.2.3",
		"--fork-commit",
		forkCommit,
		"--upstream-commit",
		upstreamCommit,
		"--web-bundle-id",
		webBundleId,
		"--coordinator-source",
		coordinatorSource,
		"--coordinator-source-sha256",
		coordinatorSha,
	]);
	const signArgs = [
		"--manifest",
		path.join(bundle, "manifest.json"),
		"--asset-index",
		path.join(bundle, "asset-index.json"),
		"--out",
		path.join(bundle, "signed-envelope.json"),
		"--key-id",
		"fixture",
		"--private-key",
		privateKeyPath,
		"--trusted-key",
		`fixture=${publicKeyPath}`,
		"--coordinator-source",
		path.join(bundle, "coordinator-source.json"),
		"--coordinator-source-sha256",
		coordinatorSha,
	];
	if (previousBundle) signArgs.push("--previous-envelope", path.join(previousBundle, "signed-envelope.json"));
	else signArgs.push("--allow-initial");
	script("autobot-release-sign.ts", signArgs);
	const verifyArgs = [
		"--envelope",
		path.join(bundle, "signed-envelope.json"),
		"--asset-index",
		path.join(bundle, "asset-index.json"),
		"--provenance",
		path.join(bundle, "provenance.json"),
		"--coordinator-source",
		path.join(bundle, "coordinator-source.json"),
		"--coordinator-source-sha256",
		coordinatorSha,
		"--trusted-key",
		`fixture=${publicKeyPath}`,
		"--source-root",
		source,
	];
	if (previousBundle) verifyArgs.push("--previous-envelope", path.join(previousBundle, "signed-envelope.json"));
	script("autobot-release-verify.ts", verifyArgs);

	await ensureAutoBotPrivateDirectory(ghConfigDir);
	const gitConfig = path.join(root, "gitconfig");
	await write(
		gitConfig,
		`[url "${releaseGit.replaceAll("\\", "/")}"]\n\tinsteadOf = https://github.com/The-AutoBot/oh-my-pi.git\n[url "${channelGit.replaceAll("\\", "/")}"]\n\tinsteadOf = https://github.com/The-AutoBot/channel.git\n[user]\n\tname = Fixture Publisher\n\temail = publisher@example.invalid\n[core]\n\tautocrlf = ${subsequent ? "true" : "false"}\n`,
	);
	const statePath = path.join(root, "gh-state.json");
	const assets = path.join(root, "seed-assets");
	await fs.mkdir(assets);
	for (const metadata of [
		"manifest.json",
		"asset-index.json",
		"provenance.json",
		"coordinator-source.json",
		"signed-envelope.json",
	])
		await fs.copyFile(path.join(bundle, metadata), path.join(assets, metadata));
	for (const entry of await fs.readdir(path.join(bundle, "assets")))
		await fs.copyFile(path.join(bundle, "assets", entry), path.join(assets, entry));
	const recovery = scenario.startsWith("recovery-");
	const draft = {
		tag_name: tag,
		draft: recovery ? scenario === "recovery-draft" : scenario !== "published-promotion",
		target_commitish: forkCommit,
		assets,
	};
	const releases = scenario === "fresh" || scenario === "third-release-history" ? [] : [draft];
	if (subsequent) {
		for (let index = 0; index < previousBundles.length; index += 1) {
			const priorSequence = index + 1;
			const priorBundle = previousBundles[index];
			if (!priorBundle) throw new Error(`release fixture omitted predecessor ${priorSequence}`);
			const previousAssets = path.join(root, `predecessor-assets-${priorSequence}`);
			await fs.mkdir(previousAssets);
			for (const metadata of [
				"manifest.json",
				"asset-index.json",
				"provenance.json",
				"coordinator-source.json",
				"signed-envelope.json",
			]) {
				await fs.copyFile(path.join(priorBundle, metadata), path.join(previousAssets, metadata));
			}
			for (const entry of await fs.readdir(path.join(priorBundle, "assets"))) {
				await fs.copyFile(path.join(priorBundle, "assets", entry), path.join(previousAssets, entry));
			}
			releases.splice(index, 0, {
				tag_name: `autobot-r${priorSequence}`,
				draft: false,
				target_commitish: forkCommit,
				assets: previousAssets,
			});
		}
	}
	const state = {
		releases,
		releaseGit,
		channelGit,
		channelBranch: "main",
		channelPath: "signed-envelope.json",
		log: [] as string[],
	};
	if (scenario === "foreign-draft") draft.target_commitish = upstreamCommit;
	if (scenario === "tampered-asset") await fs.appendFile(path.join(assets, "manifest.json"), "tamper");
	if (scenario === "recovery-tampered") await fs.appendFile(path.join(assets, "manifest.json"), "tamper");
	if (scenario === "recovery-invalid-provenance") await write(path.join(assets, "provenance.json"), "{}\n");
	if (scenario === "recovery-wrong-target") draft.target_commitish = upstreamCommit;
	if (scenario === "recovery-bad-signature") {
		await fs.appendFile(path.join(bundle, "signed-envelope.json"), "tamper");
	}
	if (scenario === "recovery-foreign-release") {
		releases.push({
			tag_name: "autobot-r2",
			draft: false,
			target_commitish: forkCommit,
			assets,
		});
	}
	if (scenario === "third-release-future") {
		releases.push({
			tag_name: "autobot-r4",
			draft: false,
			target_commitish: forkCommit,
			assets,
		});
	}
	if (recovery) {
		await fs.copyFile(path.join(bundle, "signed-envelope.json"), path.join(channelSeed, "signed-envelope.json"));
		commit(channelSeed, "publish completed channel");
		git(channelSeed, "push", "origin", "HEAD:refs/heads/main");
	}
	if (scenario === "invalid-provenance") await write(path.join(bundle, "provenance.json"), "{}\n");
	if (scenario === "contradictory-manifest") {
		const manifestPath = path.join(bundle, "manifest.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.publishedAt = "2030-01-01T00:00:00.000Z";
		const contradictoryBytes = `${JSON.stringify(manifest, null, "\t")}\n`;
		await write(manifestPath, contradictoryBytes);
		await write(path.join(assets, "manifest.json"), contradictoryBytes);
	}
	if (scenario === "foreign-modify-acl") {
		const systemRoot = process.env.SystemRoot;
		if (!systemRoot) throw new Error("SystemRoot is required for the Windows ACL fixture");
		run([
			path.join(systemRoot, "System32", "icacls.exe"),
			path.join(bundle, "signed-envelope.json"),
			"/grant",
			"*S-1-1-0:(M)",
		]);
	}
	if (scenario === "stale-channel") {
		await write(path.join(channelSeed, "signed-envelope.json"), "not the signed predecessor\n");
		commit(channelSeed, "advance channel");
		git(channelSeed, "push", "origin", "HEAD:refs/heads/main");
	}
	await write(statePath, JSON.stringify(state));
	if (subsequent) {
		for (let priorSequence = 1; priorSequence < releaseSequence; priorSequence += 1) {
			git(source, "tag", `autobot-r${priorSequence}`, forkCommit);
			git(source, "push", "origin", `refs/tags/autobot-r${priorSequence}:refs/tags/autobot-r${priorSequence}`);
		}
	} else if (scenario === "matching") {
		// Deliberately absent: a GitHub draft does not create a Git tag.
	} else if (scenario === "conflicting-tag") {
		git(source, "tag", tag, upstreamCommit);
		git(source, "push", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
	} else if (scenario !== "fresh") {
		git(source, "tag", tag, forkCommit);
		git(source, "push", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
	}
	const readTag = (): string | undefined => {
		const child = Bun.spawnSync(["git", "--git-dir", releaseGit, "rev-parse", `refs/tags/${tag}^{commit}`], {
			stdout: "pipe",
			stderr: "ignore",
		});
		return child.exitCode === 0 ? child.stdout.toString().trim() : undefined;
	};
	const beforeTag = readTag();
	const resolvedGh = Bun.which("gh");
	if (!resolvedGh || path.resolve(resolvedGh).toLowerCase() !== path.resolve(fakeGhExecutable).toLowerCase()) {
		throw new Error("Fixture-local gh shim did not win effective PATH resolution");
	}
	process.env.AUTOBOT_FAKE_GH_STATE = statePath;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_CONFIG_GLOBAL = gitConfig;
	process.env.GIT_ALLOW_PROTOCOL = "file";
	process.env.GIT_TERMINAL_PROMPT = "0";
	delete process.env.GIT_CONFIG_COUNT;
	for (const name of Object.keys(process.env)) {
		if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete process.env[name];
	}
	process.env.HOME = root;
	process.env.USERPROFILE = root;
	if (scenario === "subsequent-autocrlf") {
		if (!previousBundle) throw new Error("subsequent release fixture omitted its predecessor");
		const checkoutProbe = path.join(root, "autocrlf-checkout");
		git(root, "clone", "--depth=1", "--branch", "main", channelGit, checkoutProbe);
		const checkedOut = await fs.readFile(path.join(checkoutProbe, "signed-envelope.json"));
		const committed = await fs.readFile(path.join(previousBundle, "signed-envelope.json"));
		if (!checkedOut.includes(Buffer.from("\r\n")) || committed.includes(Buffer.from("\r\n"))) {
			throw new Error("core.autocrlf fixture did not distinguish checkout bytes from committed predecessor bytes");
		}
		await fs.rm(checkoutProbe, { recursive: true, force: true });
	}
	const config: LocalAutomationConfig = {
		schemaVersion: 1,
		repository: "The-AutoBot/oh-my-pi",
		canonicalBranch: "main",
		integrationBranch: "autobot-local",
		upstreamRepository: "https://github.com/example/upstream.git",
		upstreamRef: "refs/heads/main",
		workRoot,
		runnerBun: process.execPath,
		runnerBunVersion: Bun.version,
		compilerBun: process.execPath,
		compilerBunVersion: Bun.version,
		nativeAddonDirectory,
		nativeAddonProvenanceSha256: "a".repeat(64),
		ompExecutable: process.execPath,
		coordinatorRoot: coordinator,
		keyId: "fixture",
		privateKeyPath,
		publicKeyPath,
		channelRepository: "The-AutoBot/channel",
		channelBranch: "main",
		channelPath: "signed-envelope.json",
		allowInitial: true,
		maxOmpAttempts: 0,
		ompMaxTime: "1s",
	};
	const candidate: LocalCandidate = {
		sourceRoot: source,
		forkCommit,
		upstreamCommit,
		upstreamVersion: "18.2.3",
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		changed: true,
		sensitivePaths: [],
	};
	const records: LocalCommandDiagnosticRecord[] = [];
	const recorder: LocalCommandRecorder = {
		async record(record) {
			records.push(record);
		},
	};
	let selectedStage = stage;
	if (scenario === "unsafe-stage") {
		selectedStage = path.join(workRoot, "autobot-release-junction");
		await fs.symlink(stage, selectedStage, "junction");
	}
	const beforeChannel = git(channelGit, "rev-parse", "refs/heads/main");
	let failure: unknown;
	let recoveredTwice = false;
	let recoveryReleaseState: string | undefined;
	try {
		if (recovery) {
			await fs.rm(stage, { recursive: true, force: true });
			recoveryReleaseState = JSON.stringify(state.releases);
			const first = await authenticateCompletedLocalRelease(config, forkCommit, source, recorder);
			const second = await authenticateCompletedLocalRelease(config, forkCommit, source, recorder);
			if (
				first.forkCommit !== forkCommit ||
				first.upstreamCommit !== upstreamCommit ||
				first.upstreamVersion !== candidate.upstreamVersion ||
				JSON.stringify(first) !== JSON.stringify(second)
			) {
				throw new Error("completed publication recovery returned the wrong immutable identity");
			}
			recoveredTwice = true;
		} else {
			const admitted = await admitPreparedLocalRelease(config, selectedStage, source, recorder);
			if (
				admitted.forkCommit !== candidate.forkCommit ||
				admitted.upstreamCommit !== candidate.upstreamCommit ||
				admitted.upstreamVersion !== candidate.upstreamVersion ||
				admitted.compatibilityEpoch !== candidate.compatibilityEpoch
			) {
				throw new Error("prepared admission returned the wrong candidate identity");
			}
			await publishPreparedLocalRelease(config, candidate, selectedStage, recorder);
		}
	} catch (error) {
		failure = error;
	}
	const finalState = JSON.parse(await fs.readFile(statePath, "utf8")) as typeof state;
	const rejecting = [
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
		"third-release-future",
	].includes(scenario);
	if (rejecting) {
		if (!failure) throw new Error(`${scenario} unexpectedly published`);
		if (!recovery && !finalState.releases.find(release => release.tag_name === tag)?.draft)
			throw new Error(`${scenario} changed draft state`);
		if (git(channelGit, "rev-parse", "refs/heads/main") !== beforeChannel)
			throw new Error(`${scenario} changed channel`);
		if (finalState.log.some(value => value.startsWith("publish:"))) throw new Error(`${scenario} published draft`);
		if (readTag() !== beforeTag) throw new Error(`${scenario} changed release tag`);
	} else {
		if (failure) throw failure;
		if (scenario === "recovery-complete" && !recoveredTwice) {
			throw new Error("completed publication was not authenticated idempotently without its retained stage");
		}
		if (scenario === "recovery-complete" && JSON.stringify(finalState.releases) !== recoveryReleaseState) {
			throw new Error("completed publication recovery changed observable release metadata or assets");
		}
		const expectedReleaseCount = releaseSequence;
		if (
			finalState.releases.length !== expectedReleaseCount ||
			finalState.releases.at(-1)?.tag_name !== tag ||
			finalState.releases.at(-1)?.draft
		) {
			throw new Error("release was not published exactly once");
		}
		if (git(releaseGit, "rev-parse", `refs/tags/${tag}^{commit}`) !== forkCommit)
			throw new Error("tag does not bind candidate");
		const channel = Bun.spawnSync(["git", "--git-dir", channelGit, "show", "main:signed-envelope.json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (channel.exitCode !== 0) throw new Error("published channel envelope is unreadable");
		if (!recovery) {
			const envelopeBytes = Buffer.from(await fs.readFile(path.join(bundle, "signed-envelope.json")));
			if (!Buffer.from(channel.stdout).equals(envelopeBytes))
				throw new Error("channel bytes differ from verified envelope");
		}
		const recoveryMutations = finalState.log.filter(
			value =>
				value.startsWith("upload:") ||
				value.startsWith("create:") ||
				value.startsWith("publish:") ||
				value.startsWith("delete:"),
		);
		if (scenario === "matching" && (recoveryMutations.length !== 1 || recoveryMutations[0] !== `publish:${tag}`)) {
			throw new Error("exact retained-draft recovery did not perform exactly the required publication");
		}
		if ((scenario === "published-promotion" || scenario === "recovery-complete") && recoveryMutations.length !== 0) {
			throw new Error("exact completed recovery replaced assets or republished the release");
		}
		if (
			scenario !== "matching" &&
			scenario !== "published-promotion" &&
			scenario !== "recovery-complete" &&
			(!finalState.log.includes(`tag-exact-at-create:${tag}`) || !finalState.log.includes(`create:${tag}`))
		) {
			throw new Error("draft creation did not observe the exact release tag target");
		}
	}
	const forbidden: Record<string, true> = {
		"release-plan": true,
		"native-addon-reuse-check": true,
		"candidate-dependency-installation": true,
		"browser-relay-build": true,
		"collab-web-build": true,
		"runtime-compilation": true,
		"runtime-smoke-test": true,
		"compiled-runtime-application-check": true,
		"runner-loader-compatibility-check": true,
		"bootstrap-compilation": true,
		"coordinator-sdk-preparation": true,
		"coordinator-extension-build": true,
		"release-assembly": true,
		"release-signing": true,
		"github-release-upload": true,
	};
	if (
		records.some(
			record =>
				forbidden[record.commandKind] &&
				!(
					(scenario === "fresh" ||
						scenario === "subsequent-autocrlf" ||
						scenario === "third-release-history") &&
					record.commandKind === "github-release-upload"
				),
		)
	) {
		throw new Error("prepared publication rebuilt, re-signed, or replaced retained draft assets");
	}
} finally {
	await fs.rm(root, { recursive: true, force: true });
}
