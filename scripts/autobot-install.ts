#!/usr/bin/env bun

import { type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withAutoBotFileLock } from "../packages/coding-agent/src/autobot-update/lock.ts";
import {
	assertAutoBotChannelConfig,
	fetchVerifiedAutoBotRelease,
	readAutoBotChannelConfig,
	type AutoBotChannelConfig,
	type AutoBotFetchDeps,
} from "../packages/coding-agent/src/autobot-update/channel.ts";
import { AUTO_BOT_COMPATIBILITY_EPOCH } from "../packages/coding-agent/src/autobot-update/contract.ts";
import {
	ensureAutoBotInstallationIdentity,
	readAutoBotInstallationIdentity,
} from "../packages/coding-agent/src/autobot-update/identity.ts";
import {
	prepareAutoBotInstallationReleaseLocked,
	recoverAutoBotInstallationLocked,
	refreshAutoBotInstallationLocked,
} from "../packages/coding-agent/src/autobot-update/installation.ts";
import {
	autoBotBootstrapSlotPath,
	autoBotPaths,
	type AutoBotPaths,
} from "../packages/coding-agent/src/autobot-update/paths.ts";
import {
	assertAutoBotImportableFile,
	assertAutoBotPrivateDirectory,
	assertAutoBotPrivateFile,
	ensureAutoBotPrivateDirectory,
	normalizeAutoBotPrivateFile,
} from "../packages/coding-agent/src/autobot-update/permissions.ts";
import { currentAutoBotRuntimeTarget } from "../packages/coding-agent/src/autobot-update/platform.ts";
import { type StagedAutoBotRelease } from "../packages/coding-agent/src/autobot-update/stage.ts";
import { replaceFileAtomically } from "../packages/coding-agent/src/utils/atomic-file.ts";
import {
	advanceAutoBotSequenceHighWater,
	assertAutoBotSequenceAllowed,
	isAutoBotReleaseQuarantined,
	readAutoBotActivePointer,
	writeAutoBotActivePointer,
	type AutoBotActivePointer,
} from "../packages/coding-agent/src/autobot-update/state.ts";
import { sha256File, writeJsonAtomically } from "../packages/coding-agent/src/autobot-update/storage.ts";
import {
	AutoBotReleaseError,
	assertKnownOptions,
	hasOption,
	parseCliArgs,
	repeatedOption,
	requireKeyId,
	requiredOption,
} from "./autobot-release-common.ts";

const MAX_TRUSTED_KEY_BYTES = 16 * 1024;
const LEGACY_MIGRATION_FILE = "legacy-migration.json";
const CONTROL_FILES: Readonly<Record<string, true>> = {
	"channel.json": true,
	"identity.json": true,
	"active.json": true,
	"high-water.json": true,
	"pending-restart.json": true,
	"installation-root.json": true,
	"committed-restart.json": true,
	"installation-publication.json": true,
	[LEGACY_MIGRATION_FILE]: true,
};
const CONTROL_DIRECTORIES: Readonly<Record<string, true>> = {
	handoffs: true,
	locks: true,
	phases: true,
	quarantine: true,
	signals: true,
	"update-diagnostics": true,
};

const helpText = `Usage: bun scripts/autobot-install.ts --root <absolute-directory> --channel-url <https-url> --trusted-key <keyId=Ed25519-SPKI-file> --portal-url <https-live-url>

Install or safely maintain a signed AutoBot installation. Every option is
explicit; the installer never reads root paths, keys, or channel settings from
dotenv, bunfig, package metadata, or the current project.

Required options:
  --root <directory>       Absolute installation directory. It must be new,
                           empty, an already managed AutoBot root, or a plain
                           legacy omp binary with --migrate-legacy.
  --channel-url <url>      HTTPS URL for the signed release envelope.
  --trusted-key <key=file> Repeatable Ed25519 SPKI DER or PEM public key.
  --portal-url <url>       HTTPS collaboration portal base ending exactly in
                           /live.
  --migrate-legacy         One-time migration of the direct legacy omp binary
                           at --root. Refuses live legacy users or workers.

Release transport options:
  --artifact-origin <url>  Repeatable exact HTTPS origin allowed for signed
                           asset URLs and their redirects. Supply
                           https://github.com/ and every pinned GitHub asset
                           redirect origin (for example,
                           https://release-assets.githubusercontent.com/) when
                           the channel is hosted elsewhere. No wildcards,
                           hostnames, credentials, query strings, or paths.

Existing verified installations are maintained under both install and update
locks. A verified newer release becomes the preferred runtime and its bootstrap
is published at the stable launcher path without stopping processes already
mapped to older bytes. Publication is journaled and recovered idempotently. A
legacy migration stages and records all signed state before atomically replacing
the legacy launcher as its final operation.`;

type RootKind = "fresh" | "recoverable" | "managed" | "legacy" | "migration-interrupted";

interface RootInspection {
	readonly kind: RootKind;
	readonly stableBootstrapPath: string;
	readonly retiredLegacyPath?: string;
}

interface LegacyMigration {
	readonly schemaVersion: 1;
	readonly legacyPath: string;
	readonly legacySha256: string;
	readonly legacySize: number;
	readonly legacyNlink: 1;
	readonly retiredLegacyPath?: string;
	readonly startedAt: string;
}

interface LegacyBinaryProof {
	readonly legacyPath: string;
	readonly legacySha256: string;
	readonly legacySize: number;
	readonly legacyNlink: 1;
}

export interface InstallArguments {
	readonly root: string;
	readonly channel: AutoBotChannelConfig;
	readonly migrateLegacy: boolean;
}

function isEnoent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function bootstrapExecutableName(): string {
	return process.platform === "win32" ? "omp.exe" : "omp";
}

function isRetainedAtomicBackup(entry: string): boolean {
	const prefix = `${bootstrapExecutableName()}.`;
	if (!entry.startsWith(prefix) || !entry.endsWith(".bak")) return false;
	return /^\d+\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(entry.slice(prefix.length, -4));
}

function isPublicationArtifact(entry: string): boolean {
	const escapedName = bootstrapExecutableName().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`^${escapedName}\\.publication-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.(?:tmp|bak)$`,
		"u",
	).test(entry);
}

function reportError(error: unknown): void {
	const detail = error instanceof Error ? error.message : "non-error value";
	process.stderr.write(`AutoBot install failed: ${detail}\n`);
}

async function lstatIfPresent(filePath: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(filePath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

async function requirePlainFile(filePath: string, label: string): Promise<void> {
	const stat = await lstatIfPresent(filePath);
	if (!stat) throw new AutoBotReleaseError(`${label} does not exist: ${filePath}`);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new AutoBotReleaseError(`${label} must be a non-symlink regular file: ${filePath}`);
	}
}

async function inspectDiagnosticsDirectory(directory: string): Promise<void> {
	for (const entry of await fs.readdir(directory)) {
		const isSnapshot = /^[A-Za-z0-9_-]{32,128}\.json$/u.test(entry);
		const isAtomicTransient =
			/^[A-Za-z0-9_-]{32,128}\.json\.\d+\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:tmp|bak)$/u.test(entry);
		if (!isSnapshot && !isAtomicTransient) {
			throw new AutoBotReleaseError(
				`AutoBot diagnostics snapshot has an invalid name: ${path.join(directory, entry)}`,
			);
		}
		const snapshotPath = path.join(directory, entry);
		const stat = await lstatIfPresent(snapshotPath);
		if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
			throw new AutoBotReleaseError(`AutoBot diagnostics snapshot is unsafe: ${snapshotPath}`);
		}
	}
}

async function inspectControlDirectory(paths: AutoBotPaths): Promise<boolean> {
	const controlStat = await lstatIfPresent(paths.controlDir);
	if (!controlStat) return false;
	if (!controlStat.isDirectory() || controlStat.isSymbolicLink()) {
		throw new AutoBotReleaseError(`AutoBot control directory must be a non-symlink directory: ${paths.controlDir}`);
	}
	for (const entry of await fs.readdir(paths.controlDir)) {
		const child = path.join(paths.controlDir, entry);
		const stat = await lstatIfPresent(child);
		if (!stat || stat.isSymbolicLink()) throw new AutoBotReleaseError(`AutoBot control entry is unsafe: ${child}`);
		if (CONTROL_FILES[entry] === true) {
			if (!stat.isFile()) throw new AutoBotReleaseError(`AutoBot control file is not regular: ${child}`);
			continue;
		}
		if (CONTROL_DIRECTORIES[entry] === true) {
			if (!stat.isDirectory())
				throw new AutoBotReleaseError(`AutoBot control directory is not a directory: ${child}`);
			if (entry === "update-diagnostics") await inspectDiagnosticsDirectory(child);
			continue;
		}
		throw new AutoBotReleaseError(`Refusing an AutoBot root with an unknown control entry: ${child}`);
	}
	return true;
}

/** Distinguish a known managed topology from an unrelated nonempty target before any mutation. */
async function inspectInstallRoot(paths: AutoBotPaths): Promise<RootInspection> {
	const stableBootstrapPath = path.join(paths.root, bootstrapExecutableName());
	const rootStat = await lstatIfPresent(paths.root);
	if (!rootStat) return { kind: "fresh", stableBootstrapPath };
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new AutoBotReleaseError(`AutoBot root must be a non-symlink directory: ${paths.root}`);
	}

	const entries = await fs.readdir(paths.root);
	if (entries.length === 0) return { kind: "fresh", stableBootstrapPath };
	const knownEntries: Readonly<Record<string, true>> = {
		".autobot": true,
		bootstraps: true,
		runtimes: true,
		[bootstrapExecutableName()]: true,
	};
	const present: Record<string, true> = Object.create(null) as Record<string, true>;
	for (const entry of entries) present[entry] = true;
	for (const entry of entries) {
		const child = path.join(paths.root, entry);
		const stat = await lstatIfPresent(child);
		const isRetainedBackup = isRetainedAtomicBackup(entry);
		const isPublicationFile = isPublicationArtifact(entry);
		if (!stat || stat.isSymbolicLink() || (knownEntries[entry] !== true && !isRetainedBackup && !isPublicationFile)) {
			throw new AutoBotReleaseError(
				`Refusing unrelated nonempty root; never overwrite a possibly live legacy executable: ${paths.root}`,
			);
		}
		if (entry === bootstrapExecutableName() || isRetainedBackup || isPublicationFile) {
			if (!stat.isFile()) throw new AutoBotReleaseError(`AutoBot executable entry is not a regular file: ${child}`);
		} else if (!stat.isDirectory()) {
			throw new AutoBotReleaseError(`AutoBot root entry is not a directory: ${child}`);
		}
	}

	if (entries.length === 1 && present[bootstrapExecutableName()] === true) {
		return { kind: "legacy", stableBootstrapPath };
	}

	const hasControl = await inspectControlDirectory(paths);
	const hasRuntimeDirectory = present.runtimes === true;
	const hasBootstrapDirectory = present.bootstraps === true;
	const hasStableBootstrap = present[bootstrapExecutableName()] === true;
	const activePointerPresent = (await lstatIfPresent(paths.activePointerPath)) !== undefined;
	const retainedBackups = entries.filter(isRetainedAtomicBackup);
	const legacyMigrationRecordPresent = (await lstatIfPresent(legacyMigrationPath(paths))) !== undefined;
	const publicationJournalPresent =
		(await lstatIfPresent(path.join(paths.controlDir, "installation-publication.json"))) !== undefined;
	if (
		hasControl &&
		hasRuntimeDirectory &&
		hasBootstrapDirectory &&
		!hasStableBootstrap &&
		activePointerPresent &&
		legacyMigrationRecordPresent &&
		retainedBackups.length === 1
	) {
		return {
			kind: "migration-interrupted",
			stableBootstrapPath,
			retiredLegacyPath: path.join(paths.root, retainedBackups[0]!),
		};
	}
	if (
		hasControl &&
		hasRuntimeDirectory &&
		hasBootstrapDirectory &&
		activePointerPresent &&
		(hasStableBootstrap || publicationJournalPresent)
	) {
		return { kind: "managed", stableBootstrapPath };
	}
	if (
		!hasControl ||
		activePointerPresent ||
		(hasStableBootstrap && (!hasRuntimeDirectory || !hasBootstrapDirectory))
	) {
		throw new AutoBotReleaseError(
			`Refusing incomplete or legacy AutoBot root; it is unsafe to replace a potentially mapped executable: ${paths.root}`,
		);
	}
	return { kind: "recoverable", stableBootstrapPath };
}

async function validateManagedReleaseState(paths: AutoBotPaths): Promise<AutoBotActivePointer> {
	const [identity, channel, active] = await Promise.all([
		readAutoBotInstallationIdentity(paths),
		readAutoBotChannelConfig(paths.channelConfigPath),
		readAutoBotActivePointer(paths),
	]);
	if (!identity || !channel || !active) {
		throw new AutoBotReleaseError("Existing AutoBot root lacks a complete verified managed installation state");
	}
	const runtimeTarget = currentAutoBotRuntimeTarget();
	const activeRuntimeAsset = active.manifest.assets.find(
		asset => asset.kind === "runtime" && asset.target === runtimeTarget,
	);
	const activeBootstrapAsset = active.manifest.assets.find(
		asset => asset.kind === "bootstrap" && asset.target === runtimeTarget,
	);
	if (!activeRuntimeAsset || activeRuntimeAsset.sha256 !== active.runtimeSha256 || !activeBootstrapAsset) {
		throw new AutoBotReleaseError("Managed AutoBot active pointer does not match its signed staged assets");
	}
	const activeBootstrapPath = path.join(autoBotBootstrapSlotPath(paths, active.slotId), bootstrapExecutableName());
	await Promise.all([
		requirePlainFile(active.runtimePath, "Managed AutoBot runtime"),
		requirePlainFile(activeBootstrapPath, "Managed AutoBot bootstrap slot"),
	]);
	const [runtimeDigest, bootstrapDigest] = await Promise.all([
		sha256File(active.runtimePath),
		sha256File(activeBootstrapPath),
	]);
	if (runtimeDigest !== active.runtimeSha256) {
		throw new AutoBotReleaseError("Managed AutoBot active runtime does not match its active pointer digest");
	}
	if (bootstrapDigest !== activeBootstrapAsset.sha256) {
		throw new AutoBotReleaseError("Managed AutoBot bootstrap does not match its signed staged asset");
	}
	return active;
}

async function validateKnownManagedInstall(paths: AutoBotPaths, stableBootstrapPath: string): Promise<void> {
	const active = await validateManagedReleaseState(paths);
	const activeBootstrapPath = path.join(autoBotBootstrapSlotPath(paths, active.slotId), bootstrapExecutableName());
	await requirePlainFile(stableBootstrapPath, "Stable AutoBot bootstrap");
	const [stableDigest, activeBootstrapDigest] = await Promise.all([
		sha256File(stableBootstrapPath),
		sha256File(activeBootstrapPath),
	]);
	if (stableDigest !== activeBootstrapDigest) {
		throw new AutoBotReleaseError("Stable AutoBot bootstrap does not match the active verified bootstrap slot");
	}
}

/**
 * The permission boundary canonicalizes every path before locks, credentials,
 * release bytes, or control state are created. Reopening the root catches a
 * replacement between initial topology inspection and lock acquisition.
 */
async function establishPrivateInstallPaths(root: string, inspection: RootInspection): Promise<AutoBotPaths> {
	const canonicalRoot =
		inspection.kind === "fresh"
			? await ensureAutoBotPrivateDirectory(root)
			: await assertAutoBotPrivateDirectory(root);
	const paths = autoBotPaths(canonicalRoot);
	if (paths.root !== canonicalRoot) {
		throw new AutoBotReleaseError("AutoBot root did not retain its canonical identity");
	}
	for (const directory of [paths.controlDir, paths.lockDir, paths.runtimeDir, paths.bootstrapDir]) {
		const canonicalDirectory = await ensureAutoBotPrivateDirectory(directory);
		if (canonicalDirectory !== directory) {
			throw new AutoBotReleaseError(`AutoBot managed directory did not retain its canonical identity: ${directory}`);
		}
	}
	const reopenedRoot = await assertAutoBotPrivateDirectory(paths.root);
	if (reopenedRoot !== paths.root)
		throw new AutoBotReleaseError("AutoBot root changed while preparing private storage");
	return paths;
}

async function assertNoLiveLegacyProcesses(legacyPaths: readonly string[]): Promise<void> {
	// pi-natives is platform-specific; ordinary installs must not load it when
	// this explicitly requested legacy-migration-only capability is unused.
	try {
		const { Process, ProcessStatus } = await import("@oh-my-pi/pi-natives");
		const livePids: number[] = [];
		const seenPids: Record<string, true> = Object.create(null) as Record<string, true>;
		for (const legacyPath of legacyPaths) {
			for (const candidate of Process.fromPath(legacyPath)) {
				if (candidate.status() !== ProcessStatus.Running || seenPids[String(candidate.pid)] === true) continue;
				seenPids[String(candidate.pid)] = true;
				livePids.push(candidate.pid);
			}
		}
		if (livePids.length > 0) {
			throw new AutoBotReleaseError(
				`Refusing legacy migration while omp users or workers are live (PIDs: ${livePids.join(", ")}); stop all of them first`,
			);
		}
	} catch (error) {
		if (error instanceof AutoBotReleaseError) throw error;
		throw new AutoBotReleaseError("Cannot inspect processes using the legacy omp executable", { cause: error });
	}
}

type LegacyFileVerifier = (filePath: string) => Promise<string>;

function assertLegacyBinaryStat(stat: Stats): void {
	if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || !Number.isSafeInteger(stat.nlink) || stat.nlink !== 1) {
		throw new AutoBotReleaseError("Legacy omp executable must be a non-empty file with no hardlink aliases");
	}
}

async function inspectImportableLegacyBinary(legacyPath: string): Promise<string> {
	const canonicalPath = await assertAutoBotImportableFile(legacyPath);
	assertLegacyBinaryStat(await fs.stat(canonicalPath));
	return canonicalPath;
}

async function proveLegacyBinary(
	legacyPath: string,
	assertFile: LegacyFileVerifier = assertAutoBotPrivateFile,
): Promise<LegacyBinaryProof> {
	const canonicalPath = await assertFile(legacyPath);
	const initialStat = await fs.stat(canonicalPath);
	assertLegacyBinaryStat(initialStat);
	const initialDigest = await sha256File(canonicalPath);
	const revalidatedPath = await assertFile(canonicalPath);
	const finalStat = await fs.stat(revalidatedPath);
	assertLegacyBinaryStat(finalStat);
	const finalDigest = await sha256File(revalidatedPath);
	if (revalidatedPath !== canonicalPath || finalStat.size !== initialStat.size || finalDigest !== initialDigest) {
		throw new AutoBotReleaseError("Legacy omp changed while its migration identity was being verified");
	}
	return {
		legacyPath: canonicalPath,
		legacySha256: finalDigest,
		legacySize: finalStat.size,
		legacyNlink: 1,
	};
}

async function tightenProvenLegacyRoot(root: string, beforeTightening: LegacyBinaryProof): Promise<void> {
	const canonicalRoot = await ensureAutoBotPrivateDirectory(root);
	if (path.dirname(beforeTightening.legacyPath) !== canonicalRoot) {
		throw new AutoBotReleaseError("Legacy omp root changed while its permissions were being tightened");
	}
	const afterRootTightening = await proveLegacyBinary(beforeTightening.legacyPath, assertAutoBotImportableFile);
	assertLegacyProofUnchanged(beforeTightening, afterRootTightening);
	const normalizedPath = await normalizeAutoBotPrivateFile(afterRootTightening.legacyPath);
	const afterFileNormalization = await proveLegacyBinary(normalizedPath);
	assertLegacyProofUnchanged(beforeTightening, afterFileNormalization);
}

function legacyMigrationPath(paths: AutoBotPaths): string {
	return path.join(paths.controlDir, LEGACY_MIGRATION_FILE);
}

async function readLegacyMigration(paths: AutoBotPaths, stableBootstrapPath: string): Promise<LegacyMigration> {
	const markerPath = legacyMigrationPath(paths);
	await requirePlainFile(markerPath, "Legacy migration record");
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(markerPath).text());
	} catch (error) {
		throw new AutoBotReleaseError("Legacy migration record is not valid JSON", { cause: error });
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AutoBotReleaseError("Legacy migration record is not an object");
	}
	const record = value as Record<string, unknown>;
	// Earlier interrupted migrations predate the explicit link-count record;
	// their proof was nevertheless constrained to exactly one link.
	const legacyNlink = record.legacyNlink === undefined ? 1 : record.legacyNlink;
	let retiredLegacyPath: string | undefined;
	if (record.retiredLegacyPath !== undefined) {
		if (typeof record.retiredLegacyPath !== "string" || !path.isAbsolute(record.retiredLegacyPath)) {
			throw new AutoBotReleaseError("Legacy migration record has an invalid retired launcher path");
		}
		retiredLegacyPath = path.resolve(record.retiredLegacyPath);
		if (
			path.dirname(retiredLegacyPath) !== path.dirname(stableBootstrapPath) ||
			!isRetainedAtomicBackup(path.basename(retiredLegacyPath))
		) {
			throw new AutoBotReleaseError("Legacy migration record has an unsafe retired launcher path");
		}
	}
	if (
		record.schemaVersion !== 1 ||
		typeof record.legacyPath !== "string" ||
		typeof record.legacySha256 !== "string" ||
		typeof record.legacySize !== "number" ||
		typeof record.startedAt !== "string" ||
		!path.isAbsolute(record.legacyPath) ||
		path.resolve(record.legacyPath) !== stableBootstrapPath ||
		!/^[0-9a-f]{64}$/u.test(record.legacySha256) ||
		!Number.isSafeInteger(record.legacySize) ||
		record.legacySize <= 0 ||
		legacyNlink !== 1 ||
		Number.isNaN(Date.parse(record.startedAt))
	) {
		throw new AutoBotReleaseError("Legacy migration record has an invalid identity");
	}
	return {
		schemaVersion: 1,
		legacyPath: stableBootstrapPath,
		legacySha256: record.legacySha256,
		legacySize: record.legacySize,
		legacyNlink,
		...(retiredLegacyPath ? { retiredLegacyPath } : {}),
		startedAt: record.startedAt,
	};
}

function assertLegacyMigrationContent(migration: LegacyMigration, proof: LegacyBinaryProof): void {
	if (
		proof.legacySha256 !== migration.legacySha256 ||
		proof.legacySize !== migration.legacySize ||
		proof.legacyNlink !== migration.legacyNlink
	) {
		throw new AutoBotReleaseError("Legacy omp no longer matches the recorded migration provenance");
	}
}

function assertLegacyMigrationProof(migration: LegacyMigration, proof: LegacyBinaryProof, expectedPath: string): void {
	if (proof.legacyPath !== expectedPath) {
		throw new AutoBotReleaseError("Legacy omp no longer matches the recorded migration provenance");
	}
	assertLegacyMigrationContent(migration, proof);
}

function assertLegacyProofUnchanged(before: LegacyBinaryProof, after: LegacyBinaryProof): void {
	if (
		after.legacyPath !== before.legacyPath ||
		after.legacySha256 !== before.legacySha256 ||
		after.legacySize !== before.legacySize ||
		after.legacyNlink !== before.legacyNlink
	) {
		throw new AutoBotReleaseError("Legacy omp changed while its root permissions were being tightened");
	}
}
async function startLegacyMigration(paths: AutoBotPaths, stableBootstrapPath: string): Promise<LegacyMigration> {
	const proof = await proveLegacyBinary(stableBootstrapPath);
	if (proof.legacyPath !== stableBootstrapPath) {
		throw new AutoBotReleaseError("Legacy omp did not retain its canonical path");
	}
	await assertNoLiveLegacyProcesses([proof.legacyPath]);
	const migration: LegacyMigration = {
		schemaVersion: 1,
		legacyPath: proof.legacyPath,
		legacySha256: proof.legacySha256,
		legacySize: proof.legacySize,
		legacyNlink: proof.legacyNlink,
		startedAt: new Date().toISOString(),
	};
	await writeJsonAtomically(legacyMigrationPath(paths), migration);
	return migration;
}

async function resumeLegacyMigration(paths: AutoBotPaths, stableBootstrapPath: string): Promise<LegacyMigration> {
	const migration = await readLegacyMigration(paths, stableBootstrapPath);
	const proof = await proveLegacyBinary(stableBootstrapPath);
	assertLegacyMigrationProof(migration, proof, stableBootstrapPath);
	await assertNoLiveLegacyProcesses([proof.legacyPath]);
	return migration;
}

async function recordLegacyRetirement(
	paths: AutoBotPaths,
	migration: LegacyMigration,
	retiredLegacyPath: string,
): Promise<LegacyMigration> {
	if (
		path.dirname(retiredLegacyPath) !== path.dirname(migration.legacyPath) ||
		!isRetainedAtomicBackup(path.basename(retiredLegacyPath))
	) {
		throw new AutoBotReleaseError("Legacy migration retirement path is unsafe");
	}
	if (await lstatIfPresent(retiredLegacyPath)) {
		throw new AutoBotReleaseError("Legacy migration retirement path already exists");
	}
	const journal: LegacyMigration = { ...migration, retiredLegacyPath };
	await writeJsonAtomically(legacyMigrationPath(paths), journal);
	return journal;
}

async function resolveLegacyMigration(
	paths: AutoBotPaths,
	initialInspection: RootInspection,
	lockedInspection: RootInspection,
	migrateLegacy: boolean,
): Promise<LegacyMigration | undefined> {
	if (!migrateLegacy) return undefined;
	if (initialInspection.kind === "legacy") {
		if (lockedInspection.kind !== "recoverable") {
			throw new AutoBotReleaseError("AutoBot root changed while preparing its legacy migration");
		}
		return await startLegacyMigration(paths, lockedInspection.stableBootstrapPath);
	}
	if (lockedInspection.kind !== "recoverable" && lockedInspection.kind !== "managed") {
		throw new AutoBotReleaseError(
			"--migrate-legacy requires a direct legacy omp root or an interrupted legacy migration",
		);
	}

	return await resumeLegacyMigration(paths, lockedInspection.stableBootstrapPath);
}

async function restoreRetiredLegacyBootstrap(
	stableBootstrapPath: string,
	retiredLegacyPath: string,
	migration: LegacyMigration,
): Promise<void> {
	const replacement = await lstatIfPresent(stableBootstrapPath);
	if (replacement) {
		throw new AutoBotReleaseError(
			"Cannot safely restore the legacy launcher because its original path has reappeared",
		);
	}
	const retiredProof = await proveLegacyBinary(retiredLegacyPath);
	assertLegacyMigrationContent(migration, retiredProof);
	await replaceFileAtomically(retiredLegacyPath, stableBootstrapPath);
	const restoredProof = await proveLegacyBinary(stableBootstrapPath);
	assertLegacyMigrationProof(migration, restoredProof, stableBootstrapPath);
}
async function recoverInterruptedLegacyMigration(paths: AutoBotPaths, inspection: RootInspection): Promise<void> {
	if (inspection.kind !== "migration-interrupted" || !inspection.retiredLegacyPath) {
		throw new AutoBotReleaseError("AutoBot migration recovery has no retired legacy launcher");
	}
	const migration = await readLegacyMigration(paths, inspection.stableBootstrapPath);
	if (migration.retiredLegacyPath !== inspection.retiredLegacyPath) {
		throw new AutoBotReleaseError("Interrupted migration backup does not match its recorded retirement path");
	}
	const retiredProof = await proveLegacyBinary(inspection.retiredLegacyPath);
	assertLegacyMigrationContent(migration, retiredProof);
	await assertNoLiveLegacyProcesses([migration.legacyPath, retiredProof.legacyPath]);
	await restoreRetiredLegacyBootstrap(inspection.stableBootstrapPath, inspection.retiredLegacyPath, migration);
}

async function replaceLegacyBootstrap(
	paths: AutoBotPaths,
	stableBootstrapPath: string,
	migration: LegacyMigration,
	staged: StagedAutoBotRelease,
): Promise<void> {
	await requirePlainFile(staged.bootstrapPath, "Staged AutoBot bootstrap");
	const stagedDigest = await sha256File(staged.bootstrapPath);
	const replacementPath = `${stableBootstrapPath}.${process.pid}.${crypto.randomUUID()}.autobot-bootstrap.tmp`;
	const retiredLegacyPath = `${stableBootstrapPath}.${process.pid}.${crypto.randomUUID()}.bak`;
	let retired = false;
	let completed = false;
	let journal = migration;
	try {
		const beforeCopy = await proveLegacyBinary(stableBootstrapPath);
		assertLegacyMigrationProof(migration, beforeCopy, stableBootstrapPath);
		await assertNoLiveLegacyProcesses([beforeCopy.legacyPath]);

		await fs.copyFile(staged.bootstrapPath, replacementPath);
		if (process.platform !== "win32") await fs.chmod(replacementPath, 0o755);
		if ((await sha256File(replacementPath)) !== stagedDigest) {
			throw new AutoBotReleaseError("Staged AutoBot bootstrap changed while preparing the legacy replacement");
		}

		const beforeRetirement = await proveLegacyBinary(stableBootstrapPath);
		assertLegacyMigrationProof(migration, beforeRetirement, stableBootstrapPath);
		await assertNoLiveLegacyProcesses([beforeRetirement.legacyPath]);
		journal = await recordLegacyRetirement(paths, migration, retiredLegacyPath);
		await fs.rename(stableBootstrapPath, retiredLegacyPath);
		retired = true;

		const retiredProof = await proveLegacyBinary(retiredLegacyPath);
		assertLegacyMigrationContent(journal, retiredProof);
		// The old PATH entry is absent before this second check. Query both
		// identities so a just-started image is detected on every platform.
		await assertNoLiveLegacyProcesses([journal.legacyPath, retiredProof.legacyPath]);

		await replaceFileAtomically(replacementPath, stableBootstrapPath);
		await requirePlainFile(stableBootstrapPath, "Published AutoBot bootstrap");
		if ((await sha256File(stableBootstrapPath)) !== stagedDigest) {
			throw new AutoBotReleaseError("Published AutoBot bootstrap does not match the verified staged bootstrap");
		}
		completed = true;
	} catch (error) {
		await fs.rm(replacementPath, { force: true }).catch(() => undefined);
		if (retired && !completed) {
			try {
				await restoreRetiredLegacyBootstrap(stableBootstrapPath, retiredLegacyPath, journal);
			} catch (rollbackError) {
				throw new AutoBotReleaseError(
					`Legacy migration failed and its original launcher could not be restored: ${
						rollbackError instanceof Error ? rollbackError.message : "non-error rollback failure"
					}`,
					{ cause: error },
				);
			}
		}
		throw error;
	}
}

function decodePemOrDer(bytes: Uint8Array): Uint8Array {
	const text = new TextDecoder().decode(bytes).trim();
	if (!text.startsWith("-----BEGIN")) return bytes;
	const match = /^-----BEGIN PUBLIC KEY-----\s*([A-Za-z0-9+/=\r\n]+)\s*-----END PUBLIC KEY-----$/u.exec(text);
	if (!match) throw new AutoBotReleaseError("Trusted key must be an Ed25519 SPKI DER file or PUBLIC KEY PEM file");
	try {
		return Uint8Array.from(Buffer.from(match[1].replace(/\s/g, ""), "base64"));
	} catch (error) {
		throw new AutoBotReleaseError("Trusted key PEM payload is not base64", { cause: error });
	}
}

async function loadTrustedKeyMaterial(specifications: readonly string[]): Promise<Record<string, string>> {
	if (specifications.length === 0) {
		throw new AutoBotReleaseError("At least one explicit --trusted-key keyId=Ed25519-SPKI-file is required");
	}
	const trustedKeys: Record<string, string> = Object.create(null) as Record<string, string>;
	for (const specification of specifications) {
		const equals = specification.indexOf("=");
		if (equals <= 0 || equals === specification.length - 1) {
			throw new AutoBotReleaseError("Each --trusted-key must be keyId=path-to-Ed25519-SPKI-key");
		}
		const keyId = requireKeyId(specification.slice(0, equals), "Trusted key ID");
		if (keyId === "__proto__" || keyId === "constructor" || keyId === "prototype") {
			throw new AutoBotReleaseError(`Trusted key ID ${keyId} is reserved`);
		}
		if (trustedKeys[keyId] !== undefined)
			throw new AutoBotReleaseError(`Trusted key ${keyId} was supplied more than once`);
		const keyPath = path.resolve(specification.slice(equals + 1));
		await requirePlainFile(keyPath, "Trusted public key");
		const der = decodePemOrDer(new Uint8Array(await Bun.file(keyPath).arrayBuffer()));
		if (der.byteLength === 0 || der.byteLength > MAX_TRUSTED_KEY_BYTES) {
			throw new AutoBotReleaseError(`Trusted key ${keyId} has an invalid size`);
		}
		try {
			await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
		} catch (error) {
			throw new AutoBotReleaseError(`Trusted key ${keyId} is not an Ed25519 SPKI public key`, { cause: error });
		}
		trustedKeys[keyId] = Buffer.from(der).toString("base64");
	}
	return trustedKeys;
}

async function parseInstallArguments(): Promise<InstallArguments | undefined> {
	const args = parseCliArgs(process.argv.slice(2), ["help", "migrate-legacy"]);
	assertKnownOptions(args, [
		"help",
		"migrate-legacy",
		"root",
		"channel-url",
		"trusted-key",
		"portal-url",
		"artifact-origin",
	]);
	if (hasOption(args, "help")) {
		if (args.flags.size !== 1) throw new AutoBotReleaseError("--help cannot be combined with other options");
		process.stdout.write(`${helpText}\n`);
		return undefined;
	}

	const requestedRoot = requiredOption(args, "root");
	if (!path.isAbsolute(requestedRoot))
		throw new AutoBotReleaseError("--root must be an absolute installation directory");
	const root = path.resolve(requestedRoot);
	const trustedKeys = await loadTrustedKeyMaterial(repeatedOption(args, "trusted-key"));
	const channel = assertAutoBotChannelConfig({
		schemaVersion: 1,
		envelopeUrl: requiredOption(args, "channel-url"),
		collabPortalUrl: requiredOption(args, "portal-url"),
		trustedKeys,
		allowedArtifactOrigins: repeatedOption(args, "artifact-origin"),
	});
	return { root, channel, migrateLegacy: hasOption(args, "migrate-legacy") };
}

export async function runInstallation(arguments_: InstallArguments, deps: AutoBotFetchDeps = {}): Promise<void> {
	const initialPaths = autoBotPaths(arguments_.root);
	const initialInspection = await inspectInstallRoot(initialPaths);
	if (initialInspection.kind === "legacy") {
		if (!arguments_.migrateLegacy) {
			throw new AutoBotReleaseError("A direct legacy omp root requires the explicit --migrate-legacy flag");
		}
		// Legacy input is never normalized until its canonical file and ancestry
		// are read-only-proven, all users are stopped, and its identity is
		// recorded. The strict managed ACL follows only after that proof.
		const importableLegacyPath = await inspectImportableLegacyBinary(initialInspection.stableBootstrapPath);
		await assertNoLiveLegacyProcesses([importableLegacyPath]);
		const beforeTightening = await proveLegacyBinary(importableLegacyPath, assertAutoBotImportableFile);
		if (beforeTightening.legacyPath !== importableLegacyPath) {
			throw new AutoBotReleaseError("Legacy omp changed while its migration identity was being recorded");
		}
		await assertNoLiveLegacyProcesses([beforeTightening.legacyPath]);
		await tightenProvenLegacyRoot(arguments_.root, beforeTightening);
	} else if (initialInspection.kind === "migration-interrupted" && !arguments_.migrateLegacy) {
		throw new AutoBotReleaseError(
			"An interrupted legacy migration requires the explicit --migrate-legacy flag to recover",
		);
	} else if (arguments_.migrateLegacy && initialInspection.kind === "fresh") {
		throw new AutoBotReleaseError("--migrate-legacy requires an existing direct legacy omp installation");
	}
	const paths = await establishPrivateInstallPaths(arguments_.root, initialInspection);

	await withAutoBotFileLock(
		paths.installLockPath,
		() =>
			withAutoBotFileLock(paths.updateLockPath, async () => {
				const lockedRoot = await assertAutoBotPrivateDirectory(paths.root);
				if (lockedRoot !== paths.root) throw new AutoBotReleaseError("AutoBot root changed after lock acquisition");
				let inspection = await inspectInstallRoot(paths);
				if (inspection.kind === "migration-interrupted") {
					if (!arguments_.migrateLegacy) {
						throw new AutoBotReleaseError(
							"An interrupted legacy migration requires the explicit --migrate-legacy flag to recover",
						);
					}
					await recoverInterruptedLegacyMigration(paths, inspection);
					inspection = await inspectInstallRoot(paths);
				}
				if (await lstatIfPresent(path.join(paths.controlDir, "installation-publication.json"))) {
					await recoverAutoBotInstallationLocked(paths);
					inspection = await inspectInstallRoot(paths);
				}
				const migration = await resolveLegacyMigration(
					paths,
					initialInspection,
					inspection,
					arguments_.migrateLegacy,
				);
				if (inspection.kind === "legacy") {
					throw new AutoBotReleaseError("AutoBot root changed while acquiring the installation locks");
				}
				if (inspection.kind === "managed") {
					if (migration || (await lstatIfPresent(path.join(paths.controlDir, "installation-publication.json")))) {
						await validateManagedReleaseState(paths);
					} else {
						await validateKnownManagedInstall(paths, inspection.stableBootstrapPath);
					}
				}

				// Fetch with the proposed trust configuration, then prove policy
				// eligibility and every signed executable before replacing the
				// currently durable channel. Rejections retain the old channel.
				const release = await fetchVerifiedAutoBotRelease(arguments_.channel, deps);
				if (release.manifest.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH) {
					throw new AutoBotReleaseError(
						`Signed release compatibility epoch ${release.manifest.compatibilityEpoch} does not match this installer (${AUTO_BOT_COMPATIBILITY_EPOCH})`,
					);
				}
				if (await isAutoBotReleaseQuarantined(paths, release.manifest)) {
					throw new AutoBotReleaseError("Signed AutoBot release is quarantined after a failed activation");
				}
				await assertAutoBotSequenceAllowed(paths, release.manifest, release.payloadSha256);
				await ensureAutoBotInstallationIdentity(paths);
				const staged = await prepareAutoBotInstallationReleaseLocked(paths, release, deps);

				// Publication recovery authenticates its retained envelope through
				// this file, so the awaited atomic channel write precedes any
				// high-water, active-pointer, or publication-journal mutation.
				await writeJsonAtomically(paths.channelConfigPath, arguments_.channel);
				if (migration) {
					await advanceAutoBotSequenceHighWater(paths, staged.manifest, staged.payloadSha256);
					const runtimeAsset = staged.manifest.assets.find(
						asset => asset.kind === "runtime" && asset.target === currentAutoBotRuntimeTarget(),
					);
					if (!runtimeAsset) {
						throw new AutoBotReleaseError(
							"Staged signed release has no runtime asset for this installation target",
						);
					}
					await writeAutoBotActivePointer(paths, {
						schemaVersion: 1,
						slotId: staged.slotId,
						runtimePath: staged.runtimePath,
						runtimeSha256: runtimeAsset.sha256,
						manifest: staged.manifest,
						activatedAt: new Date().toISOString(),
					});
					await replaceLegacyBootstrap(paths, inspection.stableBootstrapPath, migration, staged);
					process.stdout.write(
						`Migrated the recorded legacy omp launcher to AutoBot release ${staged.manifest.releaseSequence} at ${paths.root}.\n`,
					);
					return;
				}
				const refreshed = await refreshAutoBotInstallationLocked(paths, release, deps, staged);
				const action = inspection.kind === "managed" ? "Maintained" : "Installed";
				process.stdout.write(
					`${action} AutoBot release ${refreshed.active.manifest.releaseSequence} at ${paths.root}; the verified runtime and stable bootstrap are now preferred.\n`,
				);
			}),
		{ retries: 1, retryDelayMs: 0 },
	);
}

if (import.meta.main) {
	try {
		const arguments_ = await parseInstallArguments();
		if (arguments_) await runInstallation(arguments_);
	} catch (error) {
		reportError(error);
		process.exitCode = 1;
	}
}
