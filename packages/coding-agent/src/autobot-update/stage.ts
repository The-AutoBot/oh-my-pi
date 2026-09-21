import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { extractArchive, openArchive } from "@oh-my-pi/pi-utils/ar";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES,
	AUTO_BOT_MAX_COLLAB_WEB_ARCHIVE_ENTRIES,
	AUTO_BOT_MAX_COLLAB_WEB_FILES,
	AUTO_BOT_MAX_COLLAB_WEB_INVENTORY_BYTES,
	AUTO_BOT_MAX_COLLAB_WEB_PATH_BYTES,
	AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
	isAutoBotCollabWebDirectoryPath,
	isAutoBotCollabWebFilePath,
	parseAutoBotReleaseManifest,
	serializeAutoBotReleaseManifest,
	type AutoBotReleaseAsset,
	type AutoBotReleaseManifest,
} from "./contract";
import { parseAutoBotBootstrapIdentity } from "./bootstrap-metadata";
import type { AutoBotBootstrapIdentity } from "./bootstrap-metadata";
import { downloadVerifiedAutoBotAsset, type AutoBotFetchDeps, type VerifiedAutoBotRelease } from "./channel";
import { autoBotBootstrapSlotPath, autoBotRuntimeSlotPath, pathIsInside, type AutoBotPaths } from "./paths";
import { currentAutoBotRuntimeTarget } from "./platform";
import { autoBotTrustEnvironment } from "./trust-env";
import { assertAutoBotPrivateDirectory } from "./permissions";
import { ensurePrivateDirectory, readJsonIfPresent, readUtf8File, sha256File, writeJsonAtomically } from "./storage";

const MAX_RUNTIME_IDENTITY_BYTES = 64 * 1024;
const COLLAB_WEB_ARCHIVE_LIMITS = {
	maxInMemorySize: AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES,
	maxMemberSize: AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES,
	// ArchiveReader deliberately omits the coordinator-counted root node.
	maxEntries: AUTO_BOT_MAX_COLLAB_WEB_ARCHIVE_ENTRIES - 1,
	maxPathBytes: AUTO_BOT_MAX_COLLAB_WEB_PATH_BYTES,
};

export interface StagedAutoBotRelease {
	readonly slotId: string;
	readonly runtimePath: string;
	readonly bootstrapPath: string;
	readonly coordinatorClientPath: string;
	readonly collabWebPath: string;
	readonly manifest: AutoBotReleaseManifest;
	readonly payloadSha256: string;
}

const SlotMarkerSchema = type({
	schemaVersion: "1",
	payloadSha256: "string > 0",
	manifest: "unknown",
	runtimeSha256: "string > 0",
	bootstrapPath: "string > 0",
	createdAt: "string > 0",
});
const RuntimeIdentitySchema = type({
	schemaVersion: "1",
	releaseSequence: "number.integer > 0",
	upstreamVersion: "string > 0",
	forkCommit: "string > 0",
	upstreamCommit: "string > 0",
	sessionFormatVersion: "number.integer > 0",
	collabProtocolVersion: "number.integer > 0",
	compatibilityEpoch: "number.integer > 0",
});
const WebBundleSchema = type({
	schemaVersion: "1",
	bundleId: "string > 0",
	sessionFormatVersion: "3",
	collabProtocolVersion: "4",
	compatibilityEpoch: "number.integer > 0",
	source: {
		forkCommit: "string > 0",
		upstreamCommit: "string > 0",
		upstreamVersion: "string > 0",
	},
	files: "unknown[]",
});
const WebBundleFileSchema = type({
	path: "string > 0",
	sha256: "string > 0",
	size: "number.integer > 0",
});

function targetForCurrentRuntime(): string {
	return currentAutoBotRuntimeTarget();
}

function slotIdFor(manifest: AutoBotReleaseManifest, runtime: AutoBotReleaseAsset): string {
	return `${manifest.releaseSequence}-${runtime.sha256.slice(0, 16)}`;
}

function runtimeExecutableName(): string {
	return process.platform === "win32" ? "omp.exe" : "omp";
}

function requiredAsset(
	manifest: AutoBotReleaseManifest,
	kind: AutoBotReleaseAsset["kind"],
	target: string,
): AutoBotReleaseAsset {
	const asset = manifest.assets.find(candidate => candidate.kind === kind && candidate.target === target);
	if (!asset) throw new Error(`Signed AutoBot release is missing ${kind}/${target}`);
	return asset;
}

function runtimeIdentityMatches(identityValue: unknown, manifest: AutoBotReleaseManifest): void {
	const identity = RuntimeIdentitySchema.assert(identityValue);
	if (
		identity.schemaVersion !== AUTO_BOT_RELEASE_SCHEMA_VERSION ||
		identity.releaseSequence !== manifest.releaseSequence ||
		identity.upstreamVersion !== manifest.upstreamVersion ||
		identity.forkCommit !== manifest.forkCommit ||
		identity.upstreamCommit !== manifest.upstreamCommit ||
		identity.sessionFormatVersion !== manifest.sessionFormatVersion ||
		identity.collabProtocolVersion !== manifest.collabProtocolVersion ||
		identity.compatibilityEpoch !== manifest.compatibilityEpoch
	) {
		throw new Error("Staged AutoBot runtime identity does not match the signed release");
	}
}

async function runManagedBinary(binaryPath: string, argument: string): Promise<string> {
	const processHandle = Bun.spawn([binaryPath, argument], {
		cwd: path.dirname(binaryPath),
		env: autoBotTrustEnvironment(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const output = await new Response(processHandle.stdout).text();
	if (output.length > MAX_RUNTIME_IDENTITY_BYTES)
		throw new Error("AutoBot managed binary identity response is too large");
	if ((await processHandle.exited) !== 0) throw new Error("AutoBot managed binary rejected its identity check");
	return output.trim();
}

async function verifyRuntimeIdentity(runtimePath: string, manifest: AutoBotReleaseManifest): Promise<void> {
	let identity: unknown;
	try {
		identity = JSON.parse(await runManagedBinary(runtimePath, "--autobot-build-identity"));
	} catch (error) {
		throw new Error("Staged AutoBot runtime did not provide a valid build identity", { cause: error });
	}
	runtimeIdentityMatches(identity, manifest);
}

async function verifyBootstrapVersion(bootstrapPath: string, target: string): Promise<void> {
	const output = await runManagedBinary(bootstrapPath, "--autobot-bootstrap-version");
	if (output !== String(AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION)) {
		throw new Error("Staged AutoBot bootstrap does not support the required protocol");
	}
	let identity: AutoBotBootstrapIdentity;
	try {
		identity = parseAutoBotBootstrapIdentity(
			JSON.parse(await runManagedBinary(bootstrapPath, "--autobot-bootstrap-identity")),
		);
	} catch (error) {
		throw new Error("Staged AutoBot bootstrap did not provide a valid embedded identity", { cause: error });
	}
	if (identity.target !== target) throw new Error("Staged AutoBot bootstrap identity has the wrong target");
}

async function inspectWebBundleArchive(archivePath: string): Promise<ReadonlySet<string>> {
	const archive = await openArchive(archivePath, { limits: COLLAB_WEB_ARCHIVE_LIMITS });
	const archiveFiles = new Set<string>();
	let expandedFileBytes = 0;
	let archiveEntryCount = 0;
	for (const entry of archive.indexEntries()) {
		if (++archiveEntryCount > AUTO_BOT_MAX_COLLAB_WEB_ARCHIVE_ENTRIES - 1) {
			throw new Error("AutoBot collaboration bundle has too many archive entries");
		}
		if (entry.isDirectory) {
			if (!isAutoBotCollabWebDirectoryPath(entry.path)) {
				throw new Error("AutoBot collaboration bundle has an unsupported directory path");
			}
			continue;
		}
		if (entry.storage?.type !== "member")
			throw new Error("AutoBot collaboration bundle may contain only regular files and directories");
		if (entry.path !== "managed-bundle.json" && !isAutoBotCollabWebFilePath(entry.path)) {
			throw new Error("AutoBot collaboration bundle has an unsupported path");
		}
		if (archiveFiles.has(entry.path)) throw new Error("AutoBot collaboration bundle has duplicate file paths");
		archiveFiles.add(entry.path);
		if (archiveFiles.size > AUTO_BOT_MAX_COLLAB_WEB_FILES + 1) {
			throw new Error("AutoBot collaboration bundle has too many files");
		}
		expandedFileBytes += entry.size;
		if (!Number.isSafeInteger(expandedFileBytes) || expandedFileBytes > AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES) {
			throw new Error("AutoBot collaboration bundle expanded content exceeds the safe limit");
		}
	}
	return archiveFiles;
}

async function verifyExtractedWebBundle(
	destinationPath: string,
	archiveFiles: ReadonlySet<string>,
	manifest: AutoBotReleaseManifest,
): Promise<void> {
	const inventoryPath = path.join(destinationPath, "managed-bundle.json");
	let inventoryValue: unknown;
	try {
		const inventoryStat = await fs.lstat(inventoryPath);
		if (!inventoryStat.isFile() || inventoryStat.size > AUTO_BOT_MAX_COLLAB_WEB_INVENTORY_BYTES) {
			throw new Error("inventory exceeds the safe limit");
		}
		inventoryValue = JSON.parse(await readUtf8File(inventoryPath));
	} catch (error) {
		throw new Error("AutoBot collaboration bundle inventory is invalid", { cause: error });
	}
	const inventory = WebBundleSchema.assert(inventoryValue);
	if (
		inventory.schemaVersion !== AUTO_BOT_RELEASE_SCHEMA_VERSION ||
		inventory.compatibilityEpoch !== manifest.compatibilityEpoch ||
		inventory.bundleId !== manifest.webBundleId ||
		inventory.sessionFormatVersion !== AUTO_BOT_SESSION_FORMAT_VERSION ||
		inventory.collabProtocolVersion !== AUTO_BOT_COLLAB_PROTOCOL_VERSION ||
		inventory.source.forkCommit !== manifest.forkCommit ||
		inventory.source.upstreamCommit !== manifest.upstreamCommit ||
		inventory.source.upstreamVersion !== manifest.upstreamVersion
	) {
		throw new Error("AutoBot collaboration bundle inventory does not match the signed release");
	}
	if (inventory.files.length === 0 || inventory.files.length > AUTO_BOT_MAX_COLLAB_WEB_FILES) {
		throw new Error("AutoBot collaboration bundle inventory has an unsafe file count");
	}
	let declaredContentBytes = 0;
	const files = inventory.files.map((value, index) => {
		const file = WebBundleFileSchema.assert(value);
		if (!isAutoBotCollabWebFilePath(file.path))
			throw new Error(`AutoBot collaboration bundle file ${index} has an unsupported path`);
		if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error("AutoBot collaboration bundle file digest is invalid");
		declaredContentBytes += file.size;
		if (!Number.isSafeInteger(declaredContentBytes) || declaredContentBytes > AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES) {
			throw new Error("AutoBot collaboration bundle inventory exceeds the safe content limit");
		}
		return file;
	});
	let previousPath = "";
	const expectedFiles = new Set<string>(["managed-bundle.json"]);
	for (const file of files) {
		if (file.path <= previousPath) throw new Error("AutoBot collaboration bundle inventory is not strictly sorted");
		previousPath = file.path;
		expectedFiles.add(file.path);
	}
	if (
		expectedFiles.size !== files.length + 1 ||
		expectedFiles.size !== archiveFiles.size ||
		[...expectedFiles].some(filePath => !archiveFiles.has(filePath))
	) {
		throw new Error("AutoBot collaboration bundle archive does not exactly match its inventory");
	}
	for (const file of files) {
		const filePath = path.resolve(destinationPath, file.path);
		if (!pathIsInside(destinationPath, filePath))
			throw new Error("AutoBot collaboration bundle file escapes its root");
		const stat = await fs.lstat(filePath);
		if (!stat.isFile()) throw new Error("AutoBot collaboration bundle inventory references a non-file");
		if (stat.size !== file.size || (await sha256File(filePath)) !== file.sha256) {
			throw new Error("AutoBot collaboration bundle file does not match its inventory");
		}
	}
}

async function verifyAndExtractWebBundle(
	archivePath: string,
	destinationPath: string,
	manifest: AutoBotReleaseManifest,
	envelopeJson: string,
): Promise<void> {
	const archiveFiles = await inspectWebBundleArchive(archivePath);
	await fs.mkdir(destinationPath, { recursive: true, mode: 0o700 });
	await extractArchive(archivePath, destinationPath, { limits: COLLAB_WEB_ARCHIVE_LIMITS });
	await verifyExtractedWebBundle(destinationPath, archiveFiles, manifest);
	const provenancePath = path.join(destinationPath, "_provenance");
	await fs.mkdir(provenancePath, { recursive: true, mode: 0o700 });
	await fs.rename(archivePath, path.join(provenancePath, "collab-web.tar.gz"));
	await Bun.write(path.join(provenancePath, "release-envelope.json"), envelopeJson);
}

async function quarantine(paths: AutoBotPaths, unsafePath: string): Promise<void> {
	try {
		await fs.mkdir(paths.quarantineDir, { recursive: true, mode: 0o700 });
		const destination = path.join(paths.quarantineDir, `${Date.now()}-${crypto.randomUUID()}`);
		await fs.rename(unsafePath, destination);
	} catch {
		await fs.rm(unsafePath, { recursive: true, force: true }).catch(() => undefined);
	}
}

function markerPath(slotPath: string): string {
	return path.join(slotPath, "release.json");
}

async function validateExistingSlot(
	paths: AutoBotPaths,
	slotPath: string,
	slotId: string,
	release: VerifiedAutoBotRelease,
): Promise<StagedAutoBotRelease | undefined> {
	const { manifest, payloadSha256 } = release;
	const raw = await readJsonIfPresent(markerPath(slotPath));
	if (raw === undefined) return undefined;
	const marker = SlotMarkerSchema.assert(raw);
	if (marker.schemaVersion !== 1 || marker.payloadSha256 !== payloadSha256 || marker.runtimeSha256.length !== 64) {
		throw new Error("Existing AutoBot slot conflicts with the signed release");
	}
	const storedManifest = serializeAutoBotReleaseManifest(parseAutoBotReleaseManifest(marker.manifest));
	if (storedManifest !== serializeAutoBotReleaseManifest(manifest))
		throw new Error("Existing AutoBot slot manifest conflicts with the signed release");
	const runtimePath = path.join(slotPath, runtimeExecutableName());
	if ((await sha256File(runtimePath)) !== marker.runtimeSha256)
		throw new Error("Existing AutoBot runtime slot integrity check failed");
	const bootstrapPath = path.join(autoBotBootstrapSlotPath(paths, slotId), runtimeExecutableName());
	const coordinatorClientPath = path.join(
		slotPath,
		"assets",
		"coordinator-client",
		"omp-session-coordinator-extension.mjs",
	);
	const collabWebPath = path.join(slotPath, "assets", "collab-web", manifest.webBundleId);
	const provenancePath = path.join(collabWebPath, "_provenance");
	const collabArchivePath = path.join(provenancePath, "collab-web.tar.gz");
	const collabAsset = requiredAsset(manifest, "collab-web", "web");
	const archiveStat = await fs.lstat(collabArchivePath);
	if (
		!archiveStat.isFile() ||
		archiveStat.size !== collabAsset.size ||
		archiveStat.size > AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES ||
		(await sha256File(collabArchivePath)) !== collabAsset.sha256
	) {
		throw new Error("Existing AutoBot collaboration archive provenance check failed");
	}
	const archiveFiles = await inspectWebBundleArchive(collabArchivePath);
	await verifyExtractedWebBundle(collabWebPath, archiveFiles, manifest);
	if ((await readUtf8File(path.join(provenancePath, "release-envelope.json"))) !== release.envelopeJson) {
		throw new Error("Existing AutoBot release envelope provenance check failed");
	}
	await verifyRuntimeIdentity(runtimePath, manifest);
	await verifyBootstrapVersion(bootstrapPath, targetForCurrentRuntime());
	return { slotId, runtimePath, bootstrapPath, coordinatorClientPath, collabWebPath, manifest, payloadSha256 };
}

/**
 * Stage every required signed asset in an immutable slot. This never promotes
 * the active pointer; the bootstrap promotes only after a successful handoff.
 */
export async function stageVerifiedAutoBotRelease(
	paths: AutoBotPaths,
	release: VerifiedAutoBotRelease,
	deps: AutoBotFetchDeps = {},
): Promise<StagedAutoBotRelease> {
	const target = targetForCurrentRuntime();
	if ((await assertAutoBotPrivateDirectory(paths.root)) !== paths.root) {
		throw new Error("AutoBot managed root is not canonical before staging");
	}
	await ensurePrivateDirectory(paths.root);
	await ensurePrivateDirectory(paths.runtimeDir);
	await ensurePrivateDirectory(paths.bootstrapDir);
	const runtime = requiredAsset(release.manifest, "runtime", target);
	const bootstrap = requiredAsset(release.manifest, "bootstrap", target);
	const coordinatorClient = requiredAsset(release.manifest, "coordinator-client", "universal");
	const collabWeb = requiredAsset(release.manifest, "collab-web", "web");
	if (collabWeb.size > AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES) {
		throw new Error("Signed AutoBot collaboration archive exceeds the safe size limit");
	}
	const slotId = slotIdFor(release.manifest, runtime);
	const slotPath = autoBotRuntimeSlotPath(paths, slotId);
	const existing = await validateExistingSlot(paths, slotPath, slotId, release);
	if (existing) return existing;

	const tempSlot = `${slotPath}.${process.pid}.${crypto.randomUUID()}.staging`;
	const bootstrapSlot = autoBotBootstrapSlotPath(paths, slotId);
	const tempBootstrapSlot = `${bootstrapSlot}.${process.pid}.${crypto.randomUUID()}.staging`;
	try {
		await fs.mkdir(tempSlot, { recursive: true, mode: 0o700 });
		await fs.mkdir(tempBootstrapSlot, { recursive: true, mode: 0o700 });
		await ensurePrivateDirectory(tempSlot);
		await ensurePrivateDirectory(tempBootstrapSlot);
		const runtimePath = path.join(tempSlot, runtimeExecutableName());
		const bootstrapPath = path.join(tempBootstrapSlot, runtimeExecutableName());
		const coordinatorClientPath = path.join(
			tempSlot,
			"assets",
			"coordinator-client",
			"omp-session-coordinator-extension.mjs",
		);
		const webArchivePath = path.join(tempSlot, "collab-web.tar.gz");
		const collabWebPath = path.join(tempSlot, "assets", "collab-web", release.manifest.webBundleId);
		await downloadVerifiedAutoBotAsset({
			asset: runtime,
			destinationPath: runtimePath,
			allowedOrigins: release.allowedArtifactOrigins,
			deps,
		});
		await downloadVerifiedAutoBotAsset({
			asset: bootstrap,
			destinationPath: bootstrapPath,
			allowedOrigins: release.allowedArtifactOrigins,
			deps,
		});
		await downloadVerifiedAutoBotAsset({
			asset: coordinatorClient,
			destinationPath: coordinatorClientPath,
			allowedOrigins: release.allowedArtifactOrigins,
			deps,
		});
		await downloadVerifiedAutoBotAsset({
			asset: collabWeb,
			destinationPath: webArchivePath,
			allowedOrigins: release.allowedArtifactOrigins,
			deps,
		});
		await verifyRuntimeIdentity(runtimePath, release.manifest);
		await verifyBootstrapVersion(bootstrapPath, target);
		await verifyAndExtractWebBundle(webArchivePath, collabWebPath, release.manifest, release.envelopeJson);
		await writeJsonAtomically(markerPath(tempSlot), {
			schemaVersion: 1,
			payloadSha256: release.payloadSha256,
			manifest: release.manifest,
			runtimeSha256: runtime.sha256,
			bootstrapPath: path.join(bootstrapSlot, runtimeExecutableName()),
			createdAt: new Date().toISOString(),
		});
		await fs.rename(tempSlot, slotPath);
		await fs.rename(tempBootstrapSlot, bootstrapSlot);
		return {
			slotId,
			runtimePath: path.join(slotPath, runtimeExecutableName()),
			bootstrapPath: path.join(bootstrapSlot, runtimeExecutableName()),
			coordinatorClientPath: path.join(
				slotPath,
				"assets",
				"coordinator-client",
				"omp-session-coordinator-extension.mjs",
			),
			collabWebPath: path.join(slotPath, "assets", "collab-web", release.manifest.webBundleId),
			manifest: release.manifest,
			payloadSha256: release.payloadSha256,
		};
	} catch (error) {
		await quarantine(paths, tempSlot);
		await quarantine(paths, tempBootstrapSlot);
		throw error;
	}
}
