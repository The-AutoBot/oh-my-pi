import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
	serializeAutoBotReleaseManifest,
	type AutoBotReleaseManifest,
} from "@oh-my-pi/pi-coding-agent/autobot-update/contract";
import type { VerifiedAutoBotRelease } from "@oh-my-pi/pi-coding-agent/autobot-update/channel";
import {
	AutoBotInstallationChannelUnavailableError,
	recoverAutoBotInstallation,
	refreshAutoBotInstallation,
	refreshAutoBotInstallationLocked,
} from "@oh-my-pi/pi-coding-agent/autobot-update/installation";
import { acquireAutoBotFileLock } from "@oh-my-pi/pi-coding-agent/autobot-update/lock";
import { ensureAutoBotPrivateDirectory } from "@oh-my-pi/pi-coding-agent/autobot-update/permissions";
import { currentAutoBotRuntimeTarget } from "@oh-my-pi/pi-coding-agent/autobot-update/platform";
import { autoBotPaths, type AutoBotPaths } from "@oh-my-pi/pi-coding-agent/autobot-update/paths";
import {
	advanceAutoBotSequenceHighWater,
	readAutoBotActivePointer,
	writeAutoBotActivePointer,
} from "@oh-my-pi/pi-coding-agent/autobot-update/state";
import { sha256File, writeJsonAtomically } from "@oh-my-pi/pi-coding-agent/autobot-update/storage";
import type { StagedAutoBotRelease } from "@oh-my-pi/pi-coding-agent/autobot-update/stage";

const roots: string[] = [];
const windowsFilesystemSecurityTestTimeoutMs = process.platform === "win32" ? 120_000 : 10_000;
function isCryptoKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
	return "privateKey" in value && "publicKey" in value;
}
const timestamp = "2026-09-22T00:00:00.000Z";

interface RecoveryFixture {
	readonly paths: AutoBotPaths;
	readonly stablePath: string;
	readonly preparedPath: string;
	readonly backupPath: string;
	readonly journalPath: string;
	readonly newBootstrapSha256: string;
	readonly previousBootstrapSha256: string;
	readonly newRuntimePath: string;
	readonly release: VerifiedAutoBotRelease;
	readonly staged: StagedAutoBotRelease;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function executableName(): string {
	return process.platform === "win32" ? "omp.exe" : "omp";
}

function manifest(
	releaseSequence: number,
	runtimeSha256: string,
	runtimeSize: number,
	bootstrapSha256: string,
	bootstrapSize: number,
): AutoBotReleaseManifest {
	const target = currentAutoBotRuntimeTarget();
	return {
		schemaVersion: AUTO_BOT_RELEASE_SCHEMA_VERSION,
		releaseSequence,
		upstreamVersion: `18.2.${releaseSequence}`,
		forkCommit: releaseSequence.toString(16).padStart(40, "a").slice(-40),
		upstreamCommit: releaseSequence.toString(16).padStart(40, "b").slice(-40),
		publishedAt: timestamp,
		minimumBootstrapVersion: AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		assets: [
			{
				kind: "runtime",
				target,
				url: "https://assets.example.invalid/runtime",
				size: runtimeSize,
				sha256: runtimeSha256,
			},
			{
				kind: "bootstrap",
				target,
				url: "https://assets.example.invalid/bootstrap",
				size: bootstrapSize,
				sha256: bootstrapSha256,
			},
		],
		webBundleId: `fixture-${releaseSequence}`,
	};
}

async function createRecoveryFixture(): Promise<RecoveryFixture> {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-installation-publication-"));
	roots.push(temporaryRoot);
	const root = await ensureAutoBotPrivateDirectory(temporaryRoot);
	const paths = autoBotPaths(root);
	for (const directory of [paths.controlDir, paths.lockDir, paths.runtimeDir, paths.bootstrapDir]) {
		await ensureAutoBotPrivateDirectory(directory);
	}
	const stablePath = path.join(root, executableName());
	await fs.copyFile(process.execPath, stablePath);
	if (process.platform !== "win32") await fs.chmod(stablePath, 0o700);
	const previousBootstrapSha256 = await sha256File(stablePath);

	const slotId = "2-recovery-fixture";
	const runtimeSlot = await ensureAutoBotPrivateDirectory(path.join(paths.runtimeDir, slotId));
	const bootstrapSlot = await ensureAutoBotPrivateDirectory(path.join(paths.bootstrapDir, slotId));
	const newRuntimePath = path.join(runtimeSlot, executableName());
	const stagedBootstrapPath = path.join(bootstrapSlot, executableName());
	await fs.copyFile(process.execPath, newRuntimePath);
	await fs.copyFile(process.execPath, stagedBootstrapPath);
	await fs.appendFile(stagedBootstrapPath, Buffer.from("signed-new-bootstrap"));
	const [runtimeStat, bootstrapStat, runtimeSha256, newBootstrapSha256] = await Promise.all([
		fs.stat(newRuntimePath),
		fs.stat(stagedBootstrapPath),
		sha256File(newRuntimePath),
		sha256File(stagedBootstrapPath),
	]);
	const releaseManifest = manifest(2, runtimeSha256, runtimeStat.size, newBootstrapSha256, bootstrapStat.size);
	const payload = serializeAutoBotReleaseManifest(releaseManifest);
	const payloadSha256 = createHash("sha256").update(payload).digest("hex");
	const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
	if (!isCryptoKeyPair(keys)) throw new Error("Ed25519 fixture key generation failed");
	const signature = Buffer.from(
		await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(payload)),
	).toString("base64");
	const envelopeJson = JSON.stringify({ payload, signature, keyId: "fixture" });
	await writeJsonAtomically(paths.channelConfigPath, {
		schemaVersion: 1,
		envelopeUrl: "https://channel.example.invalid/current.json",
		collabPortalUrl: "https://portal.example.invalid/live",
		trustedKeys: {
			fixture: Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64"),
		},
		allowedArtifactOrigins: ["https://assets.example.invalid"],
	});
	await advanceAutoBotSequenceHighWater(paths, releaseManifest, payloadSha256);

	const activeSlot = await ensureAutoBotPrivateDirectory(path.join(paths.runtimeDir, "1-active-fixture"));
	const activeRuntimePath = path.join(activeSlot, executableName());
	await fs.copyFile(process.execPath, activeRuntimePath);
	const activeManifest = manifest(
		1,
		runtimeSha256,
		runtimeStat.size,
		previousBootstrapSha256,
		(await fs.stat(stablePath)).size,
	);
	await writeAutoBotActivePointer(paths, {
		schemaVersion: 1,
		slotId: "1-active-fixture",
		runtimePath: activeRuntimePath,
		runtimeSha256,
		manifest: activeManifest,
		activatedAt: timestamp,
	});

	await writeJsonAtomically(path.join(runtimeSlot, "release.json"), {
		schemaVersion: 1,
		payloadSha256,
		manifest: releaseManifest,
		runtimeSha256,
		bootstrapPath: stagedBootstrapPath,
		createdAt: timestamp,
	});
	const assets = await ensureAutoBotPrivateDirectory(path.join(runtimeSlot, "assets"));
	const coordinator = await ensureAutoBotPrivateDirectory(path.join(assets, "coordinator-client"));
	await Bun.write(path.join(coordinator, "omp-session-coordinator-extension.mjs"), "export {};");
	const collab = await ensureAutoBotPrivateDirectory(path.join(assets, "collab-web"));
	const web = await ensureAutoBotPrivateDirectory(path.join(collab, releaseManifest.webBundleId));
	const provenance = await ensureAutoBotPrivateDirectory(path.join(web, "_provenance"));
	await Bun.write(path.join(provenance, "release-envelope.json"), envelopeJson);

	const transactionId = crypto.randomUUID();
	const preparedPath = `${stablePath}.publication-${transactionId}.tmp`;
	const backupPath = `${stablePath}.publication-${transactionId}.bak`;
	await fs.copyFile(stagedBootstrapPath, preparedPath);
	const journalPath = path.join(paths.controlDir, "installation-publication.json");
	await writeJsonAtomically(journalPath, {
		schemaVersion: 1,
		transactionId,
		slotId,
		releaseSequence: 2,
		payloadSha256,
		envelopeJson,
		runtimePath: newRuntimePath,
		runtimeSha256,
		bootstrapPath: stagedBootstrapPath,
		bootstrapSha256: newBootstrapSha256,
		stableBootstrapPath: stablePath,
		preparedBootstrapPath: preparedPath,
		backupBootstrapPath: backupPath,
		previousBootstrapSha256,
		manifest: releaseManifest,
		createdAt: timestamp,
	});
	const release: VerifiedAutoBotRelease = {
		envelope: { payload, signature, keyId: "fixture" },
		envelopeJson,
		manifest: releaseManifest,
		payloadSha256,
		allowedArtifactOrigins: Object.assign(Object.create(null), {
			"https://channel.example.invalid": true,
			"https://assets.example.invalid": true,
		}) as Record<string, true>,
	};
	const staged: StagedAutoBotRelease = {
		slotId,
		runtimePath: newRuntimePath,
		bootstrapPath: stagedBootstrapPath,
		coordinatorClientPath: path.join(
			runtimeSlot,
			"assets",
			"coordinator-client",
			"omp-session-coordinator-extension.mjs",
		),
		collabWebPath: path.join(runtimeSlot, "assets", "collab-web", releaseManifest.webBundleId),
		manifest: releaseManifest,
		payloadSha256,
	};
	return {
		paths,
		stablePath,
		preparedPath,
		backupPath,
		journalPath,
		newBootstrapSha256,
		previousBootstrapSha256,
		newRuntimePath,
		release,
		staged,
	};
}

test("recovers mapped-root publication while the old executable remains alive and selects the new default", async () => {
	const fixture = await createRecoveryFixture();
	const oldProcess = Bun.spawn(
		[
			fixture.stablePath,
			"-e",
			'process.stdout.write("ready\\\\n"); process.stdin.resume(); const gate = Promise.withResolvers(); process.stdin.once("end", gate.resolve); await gate.promise',
		],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	const reader = oldProcess.stdout.getReader();
	const ready = await reader.read();
	reader.releaseLock();
	expect(new TextDecoder().decode(ready.value)).toContain("ready");
	try {
		expect(oldProcess.exitCode).toBeNull();
		await recoverAutoBotInstallation(fixture.paths);
		expect(oldProcess.exitCode).toBeNull();
		expect(await sha256File(fixture.stablePath)).toBe(fixture.newBootstrapSha256);
		expect(await sha256File(fixture.backupPath)).toBe(fixture.previousBootstrapSha256);
		expect((await readAutoBotActivePointer(fixture.paths))?.runtimePath).toBe(fixture.newRuntimePath);
		expect(await Bun.file(fixture.journalPath).exists()).toBeFalse();
	} finally {
		oldProcess.kill();
		await oldProcess.exited;
	}
});

test("rejects tampered prepared bytes without changing the stable bootstrap", async () => {
	const fixture = await createRecoveryFixture();
	await fs.appendFile(fixture.preparedPath, Buffer.from("tampered"));
	await expect(recoverAutoBotInstallation(fixture.paths)).rejects.toThrow(
		"cannot recover its verified prepared bootstrap",
	);
	expect(await sha256File(fixture.stablePath)).toBe(fixture.previousBootstrapSha256);
	expect(await Bun.file(fixture.journalPath).exists()).toBeTrue();
});

test("rejects a reparse prepared bootstrap before any root mutation", async () => {
	const fixture = await createRecoveryFixture();
	await fs.rm(fixture.preparedPath);
	try {
		await fs.symlink(fixture.stablePath, fixture.preparedPath, "file");
	} catch (error) {
		if (process.platform === "win32") return;
		throw error;
	}
	await expect(recoverAutoBotInstallation(fixture.paths)).rejects.toThrow("unsafe root executable entry");
	expect(await sha256File(fixture.stablePath)).toBe(fixture.previousBootstrapSha256);
});

test("a stale recovery journal cannot roll back a concurrently newer preferred release", async () => {
	const fixture = await createRecoveryFixture();
	const newerSlotId = "3-newer-fixture";
	const newerSlot = await ensureAutoBotPrivateDirectory(path.join(fixture.paths.runtimeDir, newerSlotId));
	const newerRuntimePath = path.join(newerSlot, executableName());
	await fs.copyFile(process.execPath, newerRuntimePath);
	const runtimeStat = await fs.stat(newerRuntimePath);
	const runtimeSha256 = await sha256File(newerRuntimePath);
	const stableStat = await fs.stat(fixture.stablePath);
	const newerManifest = manifest(3, runtimeSha256, runtimeStat.size, fixture.previousBootstrapSha256, stableStat.size);
	await advanceAutoBotSequenceHighWater(fixture.paths, newerManifest, "f".repeat(64));
	await writeAutoBotActivePointer(fixture.paths, {
		schemaVersion: 1,
		slotId: newerSlotId,
		runtimePath: newerRuntimePath,
		runtimeSha256,
		manifest: newerManifest,
		activatedAt: timestamp,
	});
	await recoverAutoBotInstallation(fixture.paths);
	expect((await readAutoBotActivePointer(fixture.paths))?.manifest.releaseSequence).toBe(3);
	expect(await sha256File(fixture.stablePath)).toBe(fixture.previousBootstrapSha256);
	expect(await Bun.file(fixture.journalPath).exists()).toBeFalse();
});

test("a valid receipt cannot hide mutated root bootstrap bytes", async () => {
	const fixture = await createRecoveryFixture();
	await recoverAutoBotInstallation(fixture.paths);
	await fs.appendFile(fixture.stablePath, Buffer.from("mutated-after-receipt"));
	const result = await refreshAutoBotInstallationLocked(fixture.paths, fixture.release, {}, fixture.staged);
	expect(result.changed).toBeTrue();
	expect(await sha256File(fixture.stablePath)).toBe(fixture.newBootstrapSha256);
});

test("a valid receipt cannot bypass a new root-bootstrap reparse", async () => {
	const fixture = await createRecoveryFixture();
	await recoverAutoBotInstallation(fixture.paths);
	await fs.rm(fixture.stablePath);
	try {
		await fs.symlink(fixture.staged.bootstrapPath, fixture.stablePath, "file");
	} catch (error) {
		if (process.platform === "win32") return;
		throw error;
	}
	await expect(refreshAutoBotInstallationLocked(fixture.paths, fixture.release, {}, fixture.staged)).rejects.toThrow();
});

test("a valid receipt cannot bypass unsafe root-bootstrap permissions", async () => {
	if (process.platform === "win32") return;
	const fixture = await createRecoveryFixture();
	await recoverAutoBotInstallation(fixture.paths);
	await fs.chmod(fixture.stablePath, 0o777);
	await expect(refreshAutoBotInstallationLocked(fixture.paths, fixture.release, {}, fixture.staged)).rejects.toThrow();
});

test("maps only channel transport failures to the installed-release offline fallback signal", async () => {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-installation-channel-"));
	roots.push(temporaryRoot);
	const root = await ensureAutoBotPrivateDirectory(temporaryRoot);
	const paths = autoBotPaths(root);
	await ensureAutoBotPrivateDirectory(paths.controlDir);
	const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
	if (!isCryptoKeyPair(keys)) throw new Error("Ed25519 fixture key generation failed");
	await writeJsonAtomically(paths.channelConfigPath, {
		schemaVersion: 1,
		envelopeUrl: "https://channel.example.invalid/current.json",
		collabPortalUrl: "https://portal.example.invalid/live",
		trustedKeys: {
			fixture: Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64"),
		},
		allowedArtifactOrigins: [],
	});

	let reads = 0;
	const disconnected = refreshAutoBotInstallation(paths, {
		fetchImpl: (async () => {
			return {
				status: 200,
				ok: true,
				headers: new Headers(),
				body: {
					getReader: () => ({
						read: async () => {
							if (reads++ === 0) return { done: false, value: new TextEncoder().encode('{"partial":') };
							throw new Error("private transport detail");
						},
						cancel: async () => undefined,
						releaseLock: () => undefined,
					}),
				},
			} as unknown as Response;
		}) as unknown as typeof fetch,
	});
	await expect(disconnected).rejects.toBeInstanceOf(AutoBotInstallationChannelUnavailableError);

	const malformed = refreshAutoBotInstallation(paths, {
		fetchImpl: (async () => new Response("{", { status: 200 })) as unknown as typeof fetch,
	});
	await expect(malformed).rejects.not.toBeInstanceOf(AutoBotInstallationChannelUnavailableError);

	const httpFailure = refreshAutoBotInstallation(paths, {
		fetchImpl: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
	});
	await expect(httpFailure).rejects.not.toBeInstanceOf(AutoBotInstallationChannelUnavailableError);
});

test(
	"fresh launch bypasses a busy updater for no-journal recovery and the exact verified preferred release",
	async () => {
		const fixture = await createRecoveryFixture();
		await recoverAutoBotInstallation(fixture.paths);
		const lease = await acquireAutoBotFileLock(fixture.paths.updateLockPath);
		try {
			await recoverAutoBotInstallation(fixture.paths);
			const refreshed = await refreshAutoBotInstallation(fixture.paths, {
				fetchImpl: (async () =>
					new Response(fixture.release.envelopeJson, { status: 200 })) as unknown as typeof fetch,
			});
			expect(refreshed.changed).toBeFalse();
			expect(refreshed.active.manifest.releaseSequence).toBe(fixture.release.manifest.releaseSequence);
		} finally {
			lease.release();
		}
	},
	windowsFilesystemSecurityTestTimeoutMs,
);
