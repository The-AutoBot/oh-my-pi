import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	AutoBotTransportError,
	fetchVerifiedAutoBotRelease,
	readAutoBotChannelConfig,
	verifyAutoBotReleaseEnvelope,
	type AutoBotFetchDeps,
	type VerifiedAutoBotRelease,
} from "./channel";
import {
	AUTO_BOT_COMPATIBILITY_EPOCH,
	parseAutoBotReleaseManifest,
	serializeAutoBotReleaseManifest,
	type AutoBotReleaseManifest,
} from "./contract";
import { withAutoBotFileLock } from "./lock";
import { autoBotBootstrapSlotPath, pathIsInside, type AutoBotPaths } from "./paths";
import { assertAutoBotPrivateDirectory, assertAutoBotPrivateDirectoryAndOptionalFiles } from "./permissions";
import { currentAutoBotRuntimeTarget } from "./platform";
import { stageVerifiedAutoBotRelease, type StagedAutoBotRelease } from "./stage";
import {
	advanceAutoBotActivePointer,
	advanceAutoBotSequenceHighWater,
	assertAutoBotSequenceAllowed,
	isAutoBotReleaseQuarantined,
	readAutoBotActivePointer,
	readAutoBotSequenceHighWater,
	type AutoBotActivePointer,
} from "./state";
import { readJsonIfPresent, readUtf8File, removeFileIfPresent, sha256File, writeJsonAtomically } from "./storage";

const PUBLICATION_JOURNAL = "installation-publication.json";
const ROOT_RENAME_RETRIES = 20;
const ROOT_RENAME_RETRY_MS = 100;
const UPDATE_LOCK_JOIN_TIMEOUT_MS = 15 * 60_000;
const UPDATE_LOCK_RETRY_DELAY_MS = 125;
const UPDATE_LOCK_JOIN_RETRIES = Math.ceil(UPDATE_LOCK_JOIN_TIMEOUT_MS / UPDATE_LOCK_RETRY_DELAY_MS) + 1;

interface PublicationJournal {
	readonly schemaVersion: 1;
	readonly transactionId: string;
	readonly slotId: string;
	readonly releaseSequence: number;
	readonly payloadSha256: string;
	readonly envelopeJson: string;
	readonly runtimePath: string;
	readonly runtimeSha256: string;
	readonly bootstrapPath: string;
	readonly bootstrapSha256: string;
	readonly stableBootstrapPath: string;
	readonly preparedBootstrapPath: string;
	readonly backupBootstrapPath: string;
	readonly previousBootstrapSha256?: string;
	readonly manifest: AutoBotReleaseManifest;
	readonly createdAt: string;
}

interface RootPublicationReceipt {
	readonly schemaVersion: 1;
	readonly slotId: string;
	readonly releaseSequence: number;
	readonly payloadSha256: string;
	readonly bootstrapSha256: string;
	readonly stableBootstrapPath: string;
	readonly publishedAt: string;
}

export interface AutoBotInstallationRefreshResult {
	readonly active: AutoBotActivePointer;
	readonly release: VerifiedAutoBotRelease;
	readonly staged: StagedAutoBotRelease;
	readonly changed: boolean;
}

/** The only refresh failure for which a verified installed release may be used offline. */
export class AutoBotInstallationChannelUnavailableError extends Error {
	constructor(options?: ErrorOptions) {
		super("AutoBot release channel is temporarily unavailable", options);
		this.name = "AutoBotInstallationChannelUnavailableError";
	}
}

export class AutoBotInstallationQuarantinedError extends Error {
	readonly releaseSequence: number;
	readonly forkCommit: string;

	constructor(manifest: AutoBotReleaseManifest) {
		super("AutoBot signed release is quarantined after a failed activation");
		this.name = "AutoBotInstallationQuarantinedError";
		this.releaseSequence = manifest.releaseSequence;
		this.forkCommit = manifest.forkCommit;
	}
}

function executableName(): string {
	return process.platform === "win32" ? "omp.exe" : "omp";
}

function journalPath(paths: AutoBotPaths): string {
	return path.join(paths.controlDir, PUBLICATION_JOURNAL);
}

function rootReceiptPath(paths: AutoBotPaths): string {
	return path.join(paths.controlDir, "installation-root.json");
}
function stableBootstrapPath(paths: AutoBotPaths): string {
	return path.join(paths.root, executableName());
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

async function lstatIfPresent(filePath: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(filePath);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

async function requirePlainFile(filePath: string, label: string): Promise<void> {
	const stat = await lstatIfPresent(filePath);
	if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a non-symlink regular file`);
}

function requiredAsset(release: VerifiedAutoBotRelease, kind: "runtime" | "bootstrap") {
	const target = currentAutoBotRuntimeTarget();
	const asset = release.manifest.assets.find(candidate => candidate.kind === kind && candidate.target === target);
	if (!asset) throw new Error(`Signed AutoBot release is missing ${kind}/${target}`);
	return asset;
}

function pointerFor(staged: StagedAutoBotRelease, release: VerifiedAutoBotRelease): AutoBotActivePointer {
	return {
		schemaVersion: 1,
		slotId: staged.slotId,
		runtimePath: staged.runtimePath,
		runtimeSha256: requiredAsset(release, "runtime").sha256,
		manifest: staged.manifest,
		activatedAt: new Date().toISOString(),
	};
}

function sameRelease(pointer: AutoBotActivePointer, release: VerifiedAutoBotRelease): boolean {
	return (
		pointer.manifest.releaseSequence === release.manifest.releaseSequence &&
		serializeAutoBotReleaseManifest(pointer.manifest) === serializeAutoBotReleaseManifest(release.manifest)
	);
}

async function readCurrentVerifiedStage(
	paths: AutoBotPaths,
	release: VerifiedAutoBotRelease,
): Promise<StagedAutoBotRelease | undefined> {
	const [active, highWater] = await Promise.all([
		readAutoBotActivePointer(paths),
		readAutoBotSequenceHighWater(paths),
	]);
	if (!active || !sameRelease(active, release)) return undefined;
	if (
		!highWater ||
		highWater.releaseSequence !== release.manifest.releaseSequence ||
		highWater.payloadSha256 !== release.payloadSha256 ||
		highWater.forkCommit !== release.manifest.forkCommit
	) {
		throw new Error("Preferred AutoBot release conflicts with its signed payload high-water mark");
	}
	const runtimeAsset = requiredAsset(release, "runtime");
	const slotPath = path.dirname(active.runtimePath);
	const bootstrapPath = path.join(autoBotBootstrapSlotPath(paths, active.slotId), executableName());
	if (!pathIsInside(paths.runtimeDir, slotPath) || !pathIsInside(paths.bootstrapDir, bootstrapPath)) {
		throw new Error("Preferred AutoBot release escapes immutable installation slots");
	}
	for (const directory of [slotPath, path.dirname(bootstrapPath)]) {
		if ((await assertAutoBotPrivateDirectory(directory)) !== directory) {
			throw new Error("Preferred AutoBot release slot is not canonical");
		}
	}
	const marker = await readJsonIfPresent(path.join(slotPath, "release.json"));
	if (!marker || typeof marker !== "object") throw new Error("Preferred AutoBot release marker is missing");
	const value = marker as Record<string, unknown>;
	let markerManifest: AutoBotReleaseManifest;
	try {
		markerManifest = parseAutoBotReleaseManifest(value.manifest);
	} catch (error) {
		throw new Error("Preferred AutoBot release marker has an invalid manifest", { cause: error });
	}
	if (
		value.schemaVersion !== 1 ||
		value.payloadSha256 !== release.payloadSha256 ||
		value.runtimeSha256 !== runtimeAsset.sha256 ||
		value.bootstrapPath !== bootstrapPath ||
		serializeAutoBotReleaseManifest(markerManifest) !== serializeAutoBotReleaseManifest(release.manifest)
	) {
		throw new Error("Preferred AutoBot release marker conflicts with the signed release");
	}
	await Promise.all([
		requirePlainFile(active.runtimePath, "Preferred AutoBot runtime"),
		requirePlainFile(bootstrapPath, "Preferred AutoBot bootstrap"),
	]);
	const coordinatorClientPath = path.join(
		slotPath,
		"assets",
		"coordinator-client",
		"omp-session-coordinator-extension.mjs",
	);
	const collabWebPath = path.join(slotPath, "assets", "collab-web", release.manifest.webBundleId);
	const envelopePath = path.join(collabWebPath, "_provenance", "release-envelope.json");
	if ((await assertAutoBotPrivateDirectory(collabWebPath)) !== collabWebPath) {
		throw new Error("Preferred AutoBot collaboration assets are not canonical");
	}
	await Promise.all([
		requirePlainFile(coordinatorClientPath, "Preferred AutoBot coordinator client"),
		requirePlainFile(envelopePath, "Preferred AutoBot release envelope"),
	]);
	if ((await readUtf8File(envelopePath)) !== release.envelopeJson) {
		throw new Error("Preferred AutoBot slot does not retain the verified release envelope");
	}
	return {
		slotId: active.slotId,
		runtimePath: active.runtimePath,
		bootstrapPath,
		coordinatorClientPath,
		collabWebPath,
		manifest: release.manifest,
		payloadSha256: release.payloadSha256,
	};
}

function parseJournal(value: unknown, paths: AutoBotPaths): PublicationJournal {
	if (!value || typeof value !== "object") throw new Error("AutoBot installation publication journal is invalid");
	const candidate = value as PublicationJournal;
	let manifest: AutoBotReleaseManifest;
	try {
		manifest = parseAutoBotReleaseManifest(candidate.manifest);
	} catch (error) {
		throw new Error("AutoBot installation publication journal has an invalid manifest", { cause: error });
	}
	const journal = { ...candidate, manifest };
	const expectedStable = stableBootstrapPath(paths);
	const expectedRuntime = path.join(paths.runtimeDir, journal.slotId, executableName());
	const expectedBootstrap = path.join(autoBotBootstrapSlotPath(paths, journal.slotId), executableName());
	const prefix = `${expectedStable}.publication-${journal.transactionId}`;
	if (
		journal.schemaVersion !== 1 ||
		!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(journal.transactionId) ||
		!Number.isSafeInteger(journal.releaseSequence) ||
		journal.releaseSequence <= 0 ||
		!/^[0-9a-f]{64}$/.test(journal.payloadSha256) ||
		!/^[0-9a-f]{64}$/.test(journal.runtimeSha256) ||
		!/^[0-9a-f]{64}$/.test(journal.bootstrapSha256) ||
		typeof journal.envelopeJson !== "string" ||
		journal.stableBootstrapPath !== expectedStable ||
		journal.preparedBootstrapPath !== `${prefix}.tmp` ||
		journal.backupBootstrapPath !== `${prefix}.bak` ||
		journal.bootstrapPath !== expectedBootstrap ||
		journal.runtimePath !== expectedRuntime ||
		!pathIsInside(paths.runtimeDir, journal.runtimePath) ||
		journal.manifest.releaseSequence !== journal.releaseSequence
	) {
		throw new Error("AutoBot installation publication journal failed identity and path validation");
	}
	const runtimeAsset = journal.manifest.assets.find(
		asset => asset.kind === "runtime" && asset.target === currentAutoBotRuntimeTarget(),
	);
	const bootstrapAsset = journal.manifest.assets.find(
		asset => asset.kind === "bootstrap" && asset.target === currentAutoBotRuntimeTarget(),
	);
	if (
		!runtimeAsset ||
		runtimeAsset.sha256 !== journal.runtimeSha256 ||
		!bootstrapAsset ||
		bootstrapAsset.sha256 !== journal.bootstrapSha256
	) {
		throw new Error("AutoBot installation publication journal conflicts with its release manifest");
	}
	return journal;
}

/**
 * A receipt is only a protected same-install optimization. It is accepted for
 * the exact signed payload, slot, root path, and bootstrap digest, after fresh
 * ACL/non-reparse/plain-file checks. It is never reused across a release or a
 * root mutation performed by this module.
 */
async function hasMatchingRootReceipt(
	paths: AutoBotPaths,
	release: VerifiedAutoBotRelease,
	staged: StagedAutoBotRelease,
): Promise<boolean> {
	const receiptPath = rootReceiptPath(paths);
	const stablePath = stableBootstrapPath(paths);
	const stat = await lstatIfPresent(receiptPath);
	if (!stat) return false;
	await Promise.all([
		assertAutoBotPrivateDirectoryAndOptionalFiles(paths.root, [stablePath]),
		assertAutoBotPrivateDirectoryAndOptionalFiles(paths.controlDir, [receiptPath]),
	]);
	const raw = await readJsonIfPresent(receiptPath);
	if (!raw || typeof raw !== "object") throw new Error("AutoBot root publication receipt is invalid");
	const receipt = raw as RootPublicationReceipt;
	let timestampValid = false;
	try {
		timestampValid = new Date(receipt.publishedAt).toISOString() === receipt.publishedAt;
	} catch {}
	const bootstrapSha256 = requiredAsset(release, "bootstrap").sha256;
	const identityMatches =
		receipt.schemaVersion === 1 &&
		receipt.slotId === staged.slotId &&
		receipt.releaseSequence === release.manifest.releaseSequence &&
		receipt.payloadSha256 === release.payloadSha256 &&
		receipt.bootstrapSha256 === bootstrapSha256 &&
		receipt.stableBootstrapPath === stablePath &&
		timestampValid;
	if (!identityMatches) return false;
	return (await sha256File(stablePath)) === bootstrapSha256;
}

async function writeRootReceipt(
	paths: AutoBotPaths,
	releaseSequence: number,
	payloadSha256: string,
	slotId: string,
	bootstrapSha256: string,
): Promise<void> {
	await writeJsonAtomically(rootReceiptPath(paths), {
		schemaVersion: 1,
		slotId,
		releaseSequence,
		payloadSha256,
		bootstrapSha256,
		stableBootstrapPath: stableBootstrapPath(paths),
		publishedAt: new Date().toISOString(),
	} satisfies RootPublicationReceipt);
}

async function renameRootFile(source: string, destination: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(source, destination);
			return;
		} catch (error) {
			if (
				(errorCode(error) !== "EPERM" && errorCode(error) !== "EBUSY" && errorCode(error) !== "EACCES") ||
				attempt + 1 >= ROOT_RENAME_RETRIES
			) {
				throw new Error(
					"AutoBot root bootstrap is temporarily locked; publication can be retried without stopping sessions",
					{ cause: error },
				);
			}
			await Bun.sleep(ROOT_RENAME_RETRY_MS);
		}
	}
}

async function publishPreparedRoot(
	preparedPath: string,
	stablePath: string,
	backupPath: string,
	hasBackup: boolean,
): Promise<void> {
	try {
		// No hashing, ACL work, waits, or process inspection belongs in this
		// vacancy: retirement and publication are deliberately back-to-back.
		await fs.rename(preparedPath, stablePath);
	} catch (publicationError) {
		if (!hasBackup) {
			throw new Error("AutoBot prepared root bootstrap could not be published", { cause: publicationError });
		}
		try {
			await fs.rename(backupPath, stablePath);
		} catch (restoreError) {
			throw new AggregateError(
				[publicationError, restoreError],
				"AutoBot root bootstrap publication failed and its retained backup could not be restored",
			);
		}
		throw new Error("AutoBot root bootstrap publication failed; its retained backup was restored", {
			cause: publicationError,
		});
	}
}

async function digestIfPlainFile(filePath: string): Promise<string | undefined> {
	const stat = await lstatIfPresent(filePath);
	if (!stat) return undefined;
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("AutoBot publication encountered an unsafe root executable entry");
	return sha256File(filePath);
}
async function verifyJournalAuthority(
	paths: AutoBotPaths,
	journal: PublicationJournal,
	allowNewerHighWater: boolean,
): Promise<void> {
	const channel = await readAutoBotChannelConfig(paths.channelConfigPath);
	if (!channel) throw new Error("AutoBot publication recovery requires its pinned channel trust configuration");
	const verified = await verifyAutoBotReleaseEnvelope(channel, journal.envelopeJson);
	if (
		verified.payloadSha256 !== journal.payloadSha256 ||
		serializeAutoBotReleaseManifest(verified.manifest) !== serializeAutoBotReleaseManifest(journal.manifest)
	) {
		throw new Error("AutoBot publication journal does not match its retained signed envelope");
	}
	const highWater = await readAutoBotSequenceHighWater(paths);
	if (
		!highWater ||
		highWater.releaseSequence < journal.releaseSequence ||
		(highWater.releaseSequence === journal.releaseSequence &&
			(highWater.payloadSha256 !== journal.payloadSha256 || highWater.forkCommit !== journal.manifest.forkCommit)) ||
		(!allowNewerHighWater && highWater.releaseSequence !== journal.releaseSequence)
	) {
		throw new Error("AutoBot publication journal conflicts with the accepted release high-water mark");
	}
	const marker = await readJsonIfPresent(path.join(path.dirname(journal.runtimePath), "release.json"));
	if (!marker || typeof marker !== "object")
		throw new Error("AutoBot publication recovery requires its immutable stage marker");
	const value = marker as Record<string, unknown>;
	let markerManifest: AutoBotReleaseManifest;
	try {
		markerManifest = parseAutoBotReleaseManifest(value.manifest);
	} catch (error) {
		throw new Error("AutoBot publication stage marker has an invalid manifest", { cause: error });
	}
	if (
		value.schemaVersion !== 1 ||
		value.payloadSha256 !== journal.payloadSha256 ||
		value.runtimeSha256 !== journal.runtimeSha256 ||
		value.bootstrapPath !== journal.bootstrapPath ||
		serializeAutoBotReleaseManifest(markerManifest) !== serializeAutoBotReleaseManifest(journal.manifest)
	) {
		throw new Error("AutoBot publication stage marker conflicts with the signed release");
	}
	const provenancePath = path.join(
		path.dirname(journal.runtimePath),
		"assets",
		"collab-web",
		journal.manifest.webBundleId,
		"_provenance",
		"release-envelope.json",
	);
	if ((await readUtf8File(provenancePath)) !== journal.envelopeJson) {
		throw new Error("AutoBot publication stage provenance conflicts with the signed release");
	}
}

/** Caller-held recovery for established installLock -> updateLock ordering. */
export async function recoverAutoBotInstallationLocked(paths: AutoBotPaths): Promise<void> {
	const raw = await readJsonIfPresent(journalPath(paths));
	if (raw === undefined) return;
	const journal = parseJournal(raw, paths);
	const active = await readAutoBotActivePointer(paths);
	await verifyJournalAuthority(
		paths,
		journal,
		Boolean(active && active.manifest.releaseSequence > journal.releaseSequence),
	);
	if (active && active.manifest.releaseSequence > journal.releaseSequence) {
		await removeFileIfPresent(journal.preparedBootstrapPath);
		await removeFileIfPresent(journalPath(paths));
		return;
	}
	const [stableDigest, preparedDigest, backupDigest, runtimeDigest, stagedBootstrapDigest] = await Promise.all([
		digestIfPlainFile(journal.stableBootstrapPath),
		digestIfPlainFile(journal.preparedBootstrapPath),
		digestIfPlainFile(journal.backupBootstrapPath),
		sha256File(journal.runtimePath),
		sha256File(journal.bootstrapPath),
	]);
	if (runtimeDigest !== journal.runtimeSha256 || stagedBootstrapDigest !== journal.bootstrapSha256) {
		throw new Error("AutoBot installation publication journal references tampered staged assets");
	}
	if (backupDigest !== undefined && backupDigest !== journal.previousBootstrapSha256) {
		throw new Error("AutoBot installation publication backup does not match its recorded identity");
	}
	if (stableDigest !== journal.bootstrapSha256) {
		if (preparedDigest !== journal.bootstrapSha256) {
			throw new Error("AutoBot installation publication cannot recover its verified prepared bootstrap");
		}
		if (stableDigest !== undefined) {
			if (stableDigest !== journal.previousBootstrapSha256 || backupDigest !== undefined) {
				throw new Error("AutoBot installation publication found an unexpected stable bootstrap");
			}
			await renameRootFile(journal.stableBootstrapPath, journal.backupBootstrapPath);
		}
		await publishPreparedRoot(
			journal.preparedBootstrapPath,
			journal.stableBootstrapPath,
			journal.backupBootstrapPath,
			stableDigest !== undefined || backupDigest !== undefined,
		);
	}
	const pointer: AutoBotActivePointer = {
		schemaVersion: 1,
		slotId: journal.slotId,
		runtimePath: journal.runtimePath,
		runtimeSha256: journal.runtimeSha256,
		manifest: journal.manifest,
		activatedAt: new Date().toISOString(),
	};
	await advanceAutoBotActivePointer(paths, pointer);
	await writeRootReceipt(
		paths,
		journal.releaseSequence,
		journal.payloadSha256,
		journal.slotId,
		journal.bootstrapSha256,
	);
	await removeFileIfPresent(journal.preparedBootstrapPath);
	await removeFileIfPresent(journalPath(paths));
}

export async function recoverAutoBotInstallation(paths: AutoBotPaths): Promise<void> {
	// The common launch path has no journal. Avoid lock creation and contention;
	// a publisher racing this absence owns updateLock and completes its own recovery.
	if (!(await lstatIfPresent(journalPath(paths)))) return;
	await withAutoBotFileLock(paths.updateLockPath, () => recoverAutoBotInstallationLocked(paths));
}

async function publishInstallationLocked(
	paths: AutoBotPaths,
	release: VerifiedAutoBotRelease,
	staged: StagedAutoBotRelease,
	rootReceiptAlreadyMatched: boolean,
): Promise<AutoBotActivePointer> {
	await recoverAutoBotInstallationLocked(paths);
	const current = await readAutoBotActivePointer(paths);
	if (current && current.manifest.releaseSequence > release.manifest.releaseSequence) return current;
	const desired = pointerFor(staged, release);
	const bootstrapAsset = requiredAsset(release, "bootstrap");
	const runtimeAsset = requiredAsset(release, "runtime");
	if (
		current &&
		sameRelease(current, release) &&
		(rootReceiptAlreadyMatched || (await hasMatchingRootReceipt(paths, release, staged)))
	) {
		await requirePlainFile(stableBootstrapPath(paths), "Published AutoBot root bootstrap");
		return current;
	}
	if (
		(await sha256File(staged.runtimePath)) !== runtimeAsset.sha256 ||
		(await sha256File(staged.bootstrapPath)) !== bootstrapAsset.sha256
	) {
		throw new Error("Verified AutoBot stage changed before installation publication");
	}
	const stablePath = stableBootstrapPath(paths);
	const stableDigest = await digestIfPlainFile(stablePath);
	if (stableDigest === bootstrapAsset.sha256) {
		await writeRootReceipt(
			paths,
			release.manifest.releaseSequence,
			release.payloadSha256,
			staged.slotId,
			bootstrapAsset.sha256,
		);
		return advanceAutoBotActivePointer(paths, desired);
	}
	const transactionId = crypto.randomUUID();
	const preparedPath = `${stablePath}.publication-${transactionId}.tmp`;
	const backupPath = `${stablePath}.publication-${transactionId}.bak`;
	await fs.copyFile(staged.bootstrapPath, preparedPath, constants.COPYFILE_EXCL);
	if (process.platform !== "win32") await fs.chmod(preparedPath, 0o755);
	if ((await sha256File(preparedPath)) !== bootstrapAsset.sha256) {
		await removeFileIfPresent(preparedPath);
		throw new Error("Prepared AutoBot root bootstrap does not match the signed asset");
	}
	const journal: PublicationJournal = {
		schemaVersion: 1,
		transactionId,
		slotId: staged.slotId,
		releaseSequence: release.manifest.releaseSequence,
		payloadSha256: release.payloadSha256,
		envelopeJson: release.envelopeJson,
		runtimePath: staged.runtimePath,
		runtimeSha256: runtimeAsset.sha256,
		bootstrapPath: staged.bootstrapPath,
		bootstrapSha256: bootstrapAsset.sha256,
		stableBootstrapPath: stablePath,
		preparedBootstrapPath: preparedPath,
		backupBootstrapPath: backupPath,
		...(stableDigest === undefined ? {} : { previousBootstrapSha256: stableDigest }),
		manifest: release.manifest,
		createdAt: new Date().toISOString(),
	};
	await writeJsonAtomically(journalPath(paths), journal);
	await recoverAutoBotInstallationLocked(paths);
	return (await readAutoBotActivePointer(paths)) ?? desired;
}

/**
 * Validate a signed release against installation policy and fully stage it
 * without changing channel trust, high-water, active, or publication state.
 * The caller must hold updateLock.
 */
export async function prepareAutoBotInstallationReleaseLocked(
	paths: AutoBotPaths,
	release: VerifiedAutoBotRelease,
	deps: AutoBotFetchDeps = {},
): Promise<StagedAutoBotRelease> {
	await recoverAutoBotInstallationLocked(paths);
	if (release.manifest.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH) {
		throw new Error("Signed AutoBot release compatibility epoch does not match this installation");
	}
	if (await isAutoBotReleaseQuarantined(paths, release.manifest)) {
		throw new AutoBotInstallationQuarantinedError(release.manifest);
	}
	await assertAutoBotSequenceAllowed(paths, release.manifest, release.payloadSha256);
	return (await readCurrentVerifiedStage(paths, release)) ?? stageVerifiedAutoBotRelease(paths, release, deps);
}

/**
 * Caller-held variant for the installer, whose established ordering is
 * installLock -> updateLock. Calling this helper without updateLock is unsafe.
 */
export async function refreshAutoBotInstallationLocked(
	paths: AutoBotPaths,
	release: VerifiedAutoBotRelease,
	deps: AutoBotFetchDeps = {},
	preparedStage?: StagedAutoBotRelease,
): Promise<AutoBotInstallationRefreshResult> {
	await recoverAutoBotInstallationLocked(paths);
	if (release.manifest.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH) {
		throw new Error("Signed AutoBot release compatibility epoch does not match this installation");
	}
	if (await isAutoBotReleaseQuarantined(paths, release.manifest)) {
		throw new AutoBotInstallationQuarantinedError(release.manifest);
	}
	await assertAutoBotSequenceAllowed(paths, release.manifest, release.payloadSha256);
	const before = await readAutoBotActivePointer(paths);
	const staged =
		preparedStage ??
		(await readCurrentVerifiedStage(paths, release)) ??
		(await stageVerifiedAutoBotRelease(paths, release, deps));
	if (
		staged.payloadSha256 !== release.payloadSha256 ||
		serializeAutoBotReleaseManifest(staged.manifest) !== serializeAutoBotReleaseManifest(release.manifest)
	) {
		throw new Error("Prepared AutoBot stage conflicts with the verified signed release");
	}
	const rootWasPublished = Boolean(
		before && sameRelease(before, release) && (await hasMatchingRootReceipt(paths, release, staged)),
	);
	await advanceAutoBotSequenceHighWater(paths, staged.manifest, staged.payloadSha256);
	const active = await publishInstallationLocked(paths, release, staged, rootWasPublished);

	return {
		active,
		release,
		staged,
		changed:
			!before ||
			before.slotId !== active.slotId ||
			before.manifest.releaseSequence !== active.manifest.releaseSequence ||
			!rootWasPublished,
	};
}

async function readSamePreferredReleaseWithoutLock(
	paths: AutoBotPaths,
	release: VerifiedAutoBotRelease,
): Promise<AutoBotInstallationRefreshResult | undefined> {
	if (release.manifest.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH) {
		throw new Error("Signed AutoBot release compatibility epoch does not match this installation");
	}
	if (await isAutoBotReleaseQuarantined(paths, release.manifest)) {
		throw new AutoBotInstallationQuarantinedError(release.manifest);
	}
	await assertAutoBotSequenceAllowed(paths, release.manifest, release.payloadSha256);
	const active = await readAutoBotActivePointer(paths);
	if (!active || !sameRelease(active, release)) return undefined;
	const staged = await readCurrentVerifiedStage(paths, release);
	if (!staged || !(await hasMatchingRootReceipt(paths, release, staged))) return undefined;

	if (await isAutoBotReleaseQuarantined(paths, release.manifest)) {
		throw new AutoBotInstallationQuarantinedError(release.manifest);
	}
	await assertAutoBotSequenceAllowed(paths, release.manifest, release.payloadSha256);
	const confirmed = await readAutoBotActivePointer(paths);
	if (!confirmed || confirmed.slotId !== active.slotId || !sameRelease(confirmed, release)) return undefined;
	return { active: confirmed, release, staged, changed: false };
}

export async function refreshAutoBotInstallation(
	paths: AutoBotPaths,
	deps: AutoBotFetchDeps = {},
): Promise<AutoBotInstallationRefreshResult> {
	const channel = await readAutoBotChannelConfig(paths.channelConfigPath);
	if (!channel) throw new Error("AutoBot managed channel configuration is missing");
	let release: VerifiedAutoBotRelease;
	try {
		release = await fetchVerifiedAutoBotRelease(channel, deps);
	} catch (error) {
		if (error instanceof AutoBotTransportError) {
			throw new AutoBotInstallationChannelUnavailableError({ cause: error });
		}
		throw error;
	}
	const current = await readSamePreferredReleaseWithoutLock(paths, release);
	if (current) return current;
	return withAutoBotFileLock(paths.updateLockPath, () => refreshAutoBotInstallationLocked(paths, release, deps), {
		retries: UPDATE_LOCK_JOIN_RETRIES,
		retryDelayMs: UPDATE_LOCK_RETRY_DELAY_MS,
	});
}
