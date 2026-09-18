#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES,
	AUTO_BOT_MAX_COLLAB_WEB_ARCHIVE_ENTRIES,
	AUTO_BOT_MAX_COLLAB_WEB_FILES,
	AUTO_BOT_MAX_COLLAB_WEB_FILE_BYTES,
	AUTO_BOT_MAX_COLLAB_WEB_INVENTORY_BYTES,
	AUTO_BOT_MAX_COLLAB_WEB_PATH_BYTES,
	AUTO_BOT_MAX_COLLAB_WEB_PATH_SEGMENTS,
	AUTO_BOT_SESSION_FORMAT_VERSION,
	isAutoBotCollabWebDirectoryPath,
	isAutoBotCollabWebFilePath,
} from "../packages/coding-agent/src/autobot-update/contract.ts";
import { isRecord } from "../packages/utils/src/type-guards.ts";
import {
	AutoBotReleaseError,
	assertKnownOptions,
	hashFile,
	optionalOption,
	outputError,
	parseCliArgs,
	parseJson,
	requireCommit,
	requireSha256,
	requireRegularFile,
	requireString,
	requiredOption,
	runCommand,
	writeTextAtomic,
} from "./autobot-release-common.ts";

const MANAGED_BUNDLE_INVENTORY_FILE = "managed-bundle.json";
const SAFE_BUNDLE_ID = /^[A-Za-z0-9_-]{1,96}$/;
const SAFE_BUNDLE_SOURCE_VALUE = /^[A-Za-z0-9._+~-]{1,128}$/;
const textEncoder = new TextEncoder();

export interface ManagedBundleFile {
	readonly path: string;
	readonly sha256: string;
	readonly size: number;
}

export interface ManagedBundleInventory {
	readonly schemaVersion: 1;
	readonly bundleId: string;
	readonly sessionFormatVersion: typeof AUTO_BOT_SESSION_FORMAT_VERSION;
	readonly collabProtocolVersion: typeof AUTO_BOT_COLLAB_PROTOCOL_VERSION;
	readonly compatibilityEpoch: typeof AUTO_BOT_COMPATIBILITY_EPOCH;
	readonly source: {
		readonly forkCommit: string;
		readonly upstreamCommit: string;
		readonly upstreamVersion: string;
	};
	readonly files: readonly ManagedBundleFile[];
}

export interface ManagedBundleExpectation {
	readonly bundleId: string;
	readonly forkCommit: string;
	readonly upstreamCommit: string;
	readonly upstreamVersion: string;
	readonly compatibilityEpoch: typeof AUTO_BOT_COMPATIBILITY_EPOCH;
}

function assertBundleId(value: string): string {
	if (!SAFE_BUNDLE_ID.test(value)) {
		throw new AutoBotReleaseError("webBundleId must be a 1-96 character safe identifier");
	}
	return value;
}

function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

function pathSegmentCount(value: string): number {
	return value === "" ? 0 : value.split("/").length;
}

function assertBundleFilePath(value: string): string {
	if (
		utf8ByteLength(value) <= AUTO_BOT_MAX_COLLAB_WEB_PATH_BYTES &&
		pathSegmentCount(value) <= AUTO_BOT_MAX_COLLAB_WEB_PATH_SEGMENTS &&
		isAutoBotCollabWebFilePath(value)
	) {
		return value;
	}
	throw new AutoBotReleaseError(`Managed web bundle contains an unsupported path: ${value}`);
}

function assertBundleSourceValue(value: string, label: string): string {
	if (!SAFE_BUNDLE_SOURCE_VALUE.test(value)) {
		throw new AutoBotReleaseError(`${label} must use 1-128 safe source characters`);
	}
	return value;
}

function assertBundleFileSize(value: unknown, label: string): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > AUTO_BOT_MAX_COLLAB_WEB_FILE_BYTES
	) {
		throw new AutoBotReleaseError(
			`${label} must be a non-negative integer no larger than ${AUTO_BOT_MAX_COLLAB_WEB_FILE_BYTES}`,
		);
	}
	return value;
}

function assertManagedBundleInventoryLimits(files: readonly ManagedBundleFile[]): void {
	if (files.length > AUTO_BOT_MAX_COLLAB_WEB_FILES) {
		throw new AutoBotReleaseError(`managed-bundle.json cannot contain more than ${AUTO_BOT_MAX_COLLAB_WEB_FILES} files`);
	}
	let totalBytes = 0;
	for (const file of files) {
		const size = assertBundleFileSize(file.size, `managed-bundle file ${file.path} size`);
		if (totalBytes > AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES - size) {
			throw new AutoBotReleaseError(
				`managed-bundle.json file bytes exceed the ${AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES}-byte expanded archive limit`,
			);
		}
		totalBytes += size;
	}
}

function serializedManagedBundleInventory(inventory: ManagedBundleInventory): string {
	return `${JSON.stringify(inventory, null, "\t")}\n`;
}

function assertManagedBundleManifestSize(contents: string): void {
	if (utf8ByteLength(contents) > AUTO_BOT_MAX_COLLAB_WEB_INVENTORY_BYTES) {
		throw new AutoBotReleaseError(
			`managed-bundle.json exceeds the ${AUTO_BOT_MAX_COLLAB_WEB_INVENTORY_BYTES}-byte coordinator admission limit`,
		);
	}
}

const TAR_BLOCK_BYTES = 512;

function readTarHeaderSize(header: Uint8Array): number {
	let raw = "";
	for (let index = 124; index < 136; index++) {
		const byte = header[index] ?? 0;
		if (byte === 0) break;
		raw += String.fromCharCode(byte);
	}
	const value = raw.trim();
	if (!/^[0-7]*$/.test(value)) {
		throw new AutoBotReleaseError("Collab web archive has an invalid tar entry size");
	}
	const size = value === "" ? 0 : Number.parseInt(value, 8);
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new AutoBotReleaseError("Collab web archive has an invalid tar entry size");
	}
	return size;
}

function assertManagedBundleTarEntryLimit(archive: Uint8Array): void {
	let entries = 0;
	for (let offset = 0; offset + TAR_BLOCK_BYTES <= archive.byteLength; ) {
		const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
		if (header.every(byte => byte === 0)) break;
		if (++entries > AUTO_BOT_MAX_COLLAB_WEB_ARCHIVE_ENTRIES) {
			throw new AutoBotReleaseError(
				`Collab web archive cannot contain more than ${AUTO_BOT_MAX_COLLAB_WEB_ARCHIVE_ENTRIES} entries`,
			);
		}
		const size = readTarHeaderSize(header);
		const contentStart = offset + TAR_BLOCK_BYTES;
		const contentEnd = contentStart + size;
		if (contentEnd > archive.byteLength) {
			throw new AutoBotReleaseError("Collab web archive is malformed");
		}
		offset = contentStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
	}
}

async function assertManagedBundleArchiveSize(archivePath: string): Promise<void> {
	const archive = await requireRegularFile(archivePath, "Collab web archive");
	if (archive.size > AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES) {
		throw new AutoBotReleaseError(
			`Collab web archive compressed bytes exceed the ${AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES}-byte coordinator admission limit`,
		);
	}
	try {
		const expanded = gunzipSync(new Uint8Array(await Bun.file(archivePath).arrayBuffer()), {
			maxOutputLength: AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES,
		});
		if (expanded.byteLength > AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES) {
			throw new AutoBotReleaseError(
				`Collab web archive expanded bytes exceed the ${AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES}-byte coordinator admission limit`,
			);
		}
		assertManagedBundleTarEntryLimit(expanded);
	} catch (error) {
		if (error instanceof AutoBotReleaseError) throw error;
		throw new AutoBotReleaseError("Collab web archive is invalid or exceeds the expanded coordinator admission limit", {
			cause: error,
		});
	}
}

async function collectFiles(root: string, relative = ""): Promise<string[]> {
	const directory = path.join(root, relative);
	const entries = await fs.readdir(directory, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	const files: string[] = [];
	for (const entry of entries) {
		const child = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(root, child)));
			continue;
		}
		if (!entry.isFile()) throw new AutoBotReleaseError(`Web bundle input must not contain links or special files: ${child}`);
		files.push(child);
	}
	return files;
}

async function copyRegularFiles(sourceRoot: string, destinationRoot: string, files: readonly string[]): Promise<void> {
	await fs.mkdir(destinationRoot, { recursive: true });
	for (const relative of files) {
		const destination = path.join(destinationRoot, relative);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.copyFile(path.join(sourceRoot, relative), destination);
	}
}

/**
 * Mirror the coordinator's maintained full-dist staging while the explicit
 * public tree remains authoritative for dynamic `public/...` URLs.
 */
function selectDistFiles(distFiles: readonly string[], publicDirectory?: string): readonly string[] {
	return publicDirectory ? distFiles.filter(file => !file.startsWith("public/")) : distFiles;
}

/**
 * Derive a stable route key from effective web bytes and protocol compatibility,
 * not from the release's incidental fork/upstream revision.
 */
export async function deriveManagedBundleId(dist: string, publicDirectory?: string): Promise<string> {
	const source = path.resolve(dist);
	const sourceStat = await fs.lstat(source).catch(error => {
		throw new AutoBotReleaseError(`Collab web dist directory does not exist: ${source}`, { cause: error });
	});
	if (!sourceStat.isDirectory()) throw new AutoBotReleaseError(`Collab web dist path is not a directory: ${source}`);
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(
		`autobot-collab-web\u0000${AUTO_BOT_SESSION_FORMAT_VERSION}\u0000${AUTO_BOT_COLLAB_PROTOCOL_VERSION}\u0000${AUTO_BOT_COMPATIBILITY_EPOCH}\n`,
	);
	const distFiles = await collectFiles(source);
	const selectedDistFiles = selectDistFiles(distFiles, publicDirectory);
	for (const relative of selectedDistFiles) {
		assertBundleFilePath(relative);
		const hashed = await hashFile(path.join(source, relative));
		hasher.update(`dist/${relative}\u0000${hashed.size}\u0000${hashed.sha256}\n`);
	}
	if (publicDirectory) {
		const publicRoot = path.resolve(publicDirectory);
		const publicStat = await fs.lstat(publicRoot).catch(error => {
			throw new AutoBotReleaseError(`Collab web public directory does not exist: ${publicRoot}`, { cause: error });
		});
		if (!publicStat.isDirectory()) throw new AutoBotReleaseError(`Collab web public path is not a directory: ${publicRoot}`);
		for (const relative of await collectFiles(publicRoot)) {
			assertBundleFilePath(`public/${relative}`);
			const hashed = await hashFile(path.join(publicRoot, relative));
			hasher.update(`public/${relative}\u0000${hashed.size}\u0000${hashed.sha256}\n`);
		}
	}
	return `web-${hasher.digest("hex")}`;
}

function parseInventoryFile(value: unknown, index: number): ManagedBundleFile {
	if (!isRecord(value)) throw new AutoBotReleaseError(`managed-bundle.files[${index}] must be an object`);
	for (const key of Object.keys(value)) {
		if (!["path", "sha256", "size"].includes(key)) {
			throw new AutoBotReleaseError(`managed-bundle.files[${index}] has an unsupported field: ${key}`);
		}
	}
	return {
		path: assertBundleFilePath(requireString(value.path, `managed-bundle.files[${index}].path`)),
		sha256: requireSha256(requireString(value.sha256, `managed-bundle.files[${index}].sha256`), "Managed bundle file hash"),
		size: assertBundleFileSize(value.size, `managed-bundle.files[${index}].size`),
	};
}

/** Parse the exact inventory schema consumed by the immutable coordinator staging path. */
export function parseManagedBundleInventory(value: unknown): ManagedBundleInventory {
	if (!isRecord(value)) throw new AutoBotReleaseError("managed-bundle.json must be an object");
	for (const key of Object.keys(value)) {
		if (
			!["schemaVersion", "bundleId", "sessionFormatVersion", "collabProtocolVersion", "compatibilityEpoch", "source", "files"].includes(
				key,
			)
		) {
			throw new AutoBotReleaseError(`managed-bundle.json has an unsupported field: ${key}`);
		}
	}
	if (value.schemaVersion !== 1) throw new AutoBotReleaseError("managed-bundle.json schemaVersion must be 1");
	if (value.sessionFormatVersion !== AUTO_BOT_SESSION_FORMAT_VERSION) {
		throw new AutoBotReleaseError(`managed-bundle.json sessionFormatVersion must be ${AUTO_BOT_SESSION_FORMAT_VERSION}`);
	}
	if (value.collabProtocolVersion !== AUTO_BOT_COLLAB_PROTOCOL_VERSION) {
		throw new AutoBotReleaseError(`managed-bundle.json collabProtocolVersion must be ${AUTO_BOT_COLLAB_PROTOCOL_VERSION}`);
	}
	if (value.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH) {
		throw new AutoBotReleaseError(`managed-bundle.json compatibilityEpoch must be ${AUTO_BOT_COMPATIBILITY_EPOCH}`);
	}
	if (!isRecord(value.source)) throw new AutoBotReleaseError("managed-bundle.json source must be an object");
	for (const key of Object.keys(value.source)) {
		if (!["forkCommit", "upstreamCommit", "upstreamVersion"].includes(key)) {
			throw new AutoBotReleaseError(`managed-bundle.json source has an unsupported field: ${key}`);
		}
	}
	if (!Array.isArray(value.files) || value.files.length === 0) {
		throw new AutoBotReleaseError("managed-bundle.json files must be a non-empty array");
	}
	if (value.files.length > AUTO_BOT_MAX_COLLAB_WEB_FILES) {
		throw new AutoBotReleaseError(`managed-bundle.json cannot contain more than ${AUTO_BOT_MAX_COLLAB_WEB_FILES} files`);
	}
	const files = value.files.map(parseInventoryFile);
	const seen = new Set<string>();
	let priorPath = "";
	for (const file of files) {
		if (seen.has(file.path)) throw new AutoBotReleaseError(`managed-bundle.json duplicates file ${file.path}`);
		if (priorPath.localeCompare(file.path) >= 0) throw new AutoBotReleaseError("managed-bundle.json files must be sorted by path");
		seen.add(file.path);
		priorPath = file.path;
	}
	assertManagedBundleInventoryLimits(files);
	return {
		schemaVersion: 1,
		bundleId: assertBundleId(requireString(value.bundleId, "managed-bundle.json bundleId")),
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		source: {
			forkCommit: assertBundleSourceValue(
				requireCommit(requireString(value.source.forkCommit, "managed-bundle.json source forkCommit"), "Managed bundle fork commit"),
				"Managed bundle fork commit",
			),
			upstreamCommit: assertBundleSourceValue(
				requireCommit(requireString(value.source.upstreamCommit, "managed-bundle.json source upstreamCommit"), "Managed bundle upstream commit"),
				"Managed bundle upstream commit",
			),
			upstreamVersion: assertBundleSourceValue(
				requireString(value.source.upstreamVersion, "managed-bundle.json source upstreamVersion"),
				"Managed bundle upstream version",
			),
		},
		files,
	};
}

function assertInventoryExpectation(inventory: ManagedBundleInventory, expected: ManagedBundleExpectation): void {
	if (
		inventory.bundleId !== expected.bundleId ||
		inventory.compatibilityEpoch !== expected.compatibilityEpoch ||
		inventory.source.forkCommit !== expected.forkCommit ||
		inventory.source.upstreamCommit !== expected.upstreamCommit ||
		inventory.source.upstreamVersion !== expected.upstreamVersion
	) {
		throw new AutoBotReleaseError("managed-bundle.json source provenance does not match the release manifest inputs");
	}
}

async function validateExtractedBundle(root: string, expected?: ManagedBundleExpectation): Promise<ManagedBundleInventory> {
	const inventoryPath = path.join(root, "managed-bundle.json");
	const inventoryStat = await requireRegularFile(inventoryPath, "managed-bundle.json");
	if (inventoryStat.size > AUTO_BOT_MAX_COLLAB_WEB_INVENTORY_BYTES) {
		throw new AutoBotReleaseError(
			`managed-bundle.json exceeds the ${AUTO_BOT_MAX_COLLAB_WEB_INVENTORY_BYTES}-byte coordinator admission limit`,
		);
	}
	const inventory = parseManagedBundleInventory(parseJson(await Bun.file(inventoryPath).text(), "managed-bundle.json"));
	if (expected) assertInventoryExpectation(inventory, expected);
	const actualFiles = await collectFiles(root);
	const expectedFiles = ["managed-bundle.json", ...inventory.files.map(file => file.path)].sort((left, right) =>
		left.localeCompare(right),
	);
	if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
		throw new AutoBotReleaseError("Collab web archive files do not exactly match managed-bundle.json");
	}
	for (const file of inventory.files) {
		const actual = await hashFile(path.join(root, file.path));
		if (actual.size !== file.size || actual.sha256 !== file.sha256) {
			throw new AutoBotReleaseError(`managed-bundle.json hash verification failed for ${file.path}`);
		}
	}
	if (!actualFiles.includes("index.html")) throw new AutoBotReleaseError("Collab web archive is missing index.html");
	return inventory;
}

/** Extract and verify a tar.gz bundle without trusting archive paths, links, or its self-declared inventory. */
export async function verifyManagedBundleArchive(
	archivePath: string,
	expected?: ManagedBundleExpectation,
): Promise<ManagedBundleInventory> {
	await assertManagedBundleArchiveSize(archivePath);
	const listed = await runCommand(["tar", "-tzf", archivePath], { capture: true });
	const detailedListing = await runCommand(["tar", "-tvzf", archivePath], { capture: true });
	const archiveEntries = listed.stdout
		.split("\n")
		.map(entry => entry.trim())
		.filter(Boolean);
	const detailedEntries = detailedListing.stdout
		.split("\n")
		.map(entry => entry.trim())
		.filter(Boolean);
	if (archiveEntries.length === 0) throw new AutoBotReleaseError("Collab web archive is empty");
	if (archiveEntries.length !== detailedEntries.length) {
		throw new AutoBotReleaseError("Could not safely determine every collab web archive entry type");
	}
	if (archiveEntries.length > AUTO_BOT_MAX_COLLAB_WEB_ARCHIVE_ENTRIES) {
		throw new AutoBotReleaseError(
			`Collab web archive cannot contain more than ${AUTO_BOT_MAX_COLLAB_WEB_ARCHIVE_ENTRIES} entries`,
		);
	}
	const listedSet = new Set<string>();
	let archiveFileCount = 0;
	for (const [index, rawEntry] of archiveEntries.entries()) {
		const entryType = detailedEntries[index]?.charAt(0);
		if (entryType !== "-" && entryType !== "d") {
			throw new AutoBotReleaseError(`Collab web archive contains a non-regular entry: ${rawEntry}`);
		}
		if (entryType === "-" && ++archiveFileCount > AUTO_BOT_MAX_COLLAB_WEB_FILES + 1) {
			throw new AutoBotReleaseError(`Collab web archive cannot contain more than ${AUTO_BOT_MAX_COLLAB_WEB_FILES} inventory files`);
		}
		const entry = rawEntry.startsWith("./") ? rawEntry.slice(2) : rawEntry;
		if (entry === "") continue;
		if (entry.startsWith("/") || entry.split("/").includes("..") || entry.includes("\\")) {
			throw new AutoBotReleaseError(`Collab web archive contains an unsafe path: ${entry}`);
		}
		const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
		if (utf8ByteLength(normalized) > AUTO_BOT_MAX_COLLAB_WEB_PATH_BYTES) {
			throw new AutoBotReleaseError(`Collab web archive path exceeds ${AUTO_BOT_MAX_COLLAB_WEB_PATH_BYTES} bytes: ${entry}`);
		}
		if (pathSegmentCount(normalized) > AUTO_BOT_MAX_COLLAB_WEB_PATH_SEGMENTS) {
			throw new AutoBotReleaseError(
				`Collab web archive path exceeds ${AUTO_BOT_MAX_COLLAB_WEB_PATH_SEGMENTS} segments: ${entry}`,
			);
		}
		const validPath =
			entryType === "d"
				? isAutoBotCollabWebDirectoryPath(normalized)
				: normalized === MANAGED_BUNDLE_INVENTORY_FILE || isAutoBotCollabWebFilePath(normalized);
		if (!validPath) {
			throw new AutoBotReleaseError(`Collab web archive contains an unsupported path: ${entry}`);
		}
		if (listedSet.has(normalized)) throw new AutoBotReleaseError(`Collab web archive duplicates path: ${normalized}`);
		listedSet.add(normalized);
		if (entryType === "-" && entry.endsWith("/")) {
			throw new AutoBotReleaseError(`Collab web archive marks a regular file as a directory: ${entry}`);
		}
	}
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autobot-web-verify-"));
	try {
		await runCommand(["tar", "-xzf", archivePath, "-C", temporary]);
		return await validateExtractedBundle(temporary, expected);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

export interface CreateManagedBundleOptions {
	readonly bundleId: string;
	readonly forkCommit: string;
	readonly upstreamCommit: string;
	readonly upstreamVersion: string;
	readonly dist: string;
	/** Authoritative public tree staged under public/ alongside the complete compiled dist. */
	readonly publicDirectory?: string;
	readonly out: string;
}

/** Package a fresh compiled collab-web dist tree as a deterministic, inventory-backed tar.gz release asset. */
export async function createManagedBundle(options: CreateManagedBundleOptions): Promise<ManagedBundleInventory> {
	const source = path.resolve(options.dist);
	const output = path.resolve(options.out);
	assertBundleId(options.bundleId);
	const forkCommit = assertBundleSourceValue(requireCommit(options.forkCommit, "Fork commit"), "Fork commit");
	const upstreamCommit = assertBundleSourceValue(requireCommit(options.upstreamCommit, "Upstream commit"), "Upstream commit");
	const upstreamVersion = assertBundleSourceValue(options.upstreamVersion, "Upstream version");
	const outputRelative = path.relative(source, output);
	if (outputRelative === "" || (!outputRelative.startsWith("..") && !path.isAbsolute(outputRelative))) {
		throw new AutoBotReleaseError("Collab web output archive must not be inside the source dist tree");
	}
	const sourceStat = await fs.lstat(source).catch(error => {
		throw new AutoBotReleaseError(`Collab web dist directory does not exist: ${source}`, { cause: error });
	});
	if (!sourceStat.isDirectory()) throw new AutoBotReleaseError(`Collab web dist path is not a directory: ${source}`);
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autobot-web-build-"));
	const staged = path.join(temporary, "bundle");
	let archiveCreated = false;
	try {
		const distFiles = await collectFiles(source);
		const selectedDistFiles = selectDistFiles(distFiles, options.publicDirectory);
		await copyRegularFiles(source, staged, selectedDistFiles);
		if (options.publicDirectory) {
			const publicDirectory = path.resolve(options.publicDirectory);
			const publicStat = await fs.lstat(publicDirectory).catch(error => {
				throw new AutoBotReleaseError(`Collab web public directory does not exist: ${publicDirectory}`, { cause: error });
			});
			if (!publicStat.isDirectory()) {
				throw new AutoBotReleaseError(`Collab web public path is not a directory: ${publicDirectory}`);
			}
			await copyRegularFiles(publicDirectory, path.join(staged, "public"), await collectFiles(publicDirectory));
		}
		const sourceFiles = await collectFiles(staged);
		if (sourceFiles.length > AUTO_BOT_MAX_COLLAB_WEB_FILES) {
			throw new AutoBotReleaseError(`Collab web dist cannot contain more than ${AUTO_BOT_MAX_COLLAB_WEB_FILES} files`);
		}
		if (sourceFiles.includes(MANAGED_BUNDLE_INVENTORY_FILE)) {
			throw new AutoBotReleaseError("Collab web dist must not already contain managed-bundle.json");
		}
		const files: ManagedBundleFile[] = [];
		for (const relative of sourceFiles) {
			assertBundleFilePath(relative);
			const hashed = await hashFile(path.join(staged, relative));
			files.push({ path: relative, ...hashed });
		}
		assertManagedBundleInventoryLimits(files);
		if (!files.some(file => file.path === "index.html")) throw new AutoBotReleaseError("Collab web dist is missing index.html");
		const inventory: ManagedBundleInventory = {
			schemaVersion: 1,
			bundleId: options.bundleId,
			sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
			collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
			compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
			source: {
				forkCommit,
				upstreamCommit,
				upstreamVersion,
			},
			files,
		};
		const inventoryContents = serializedManagedBundleInventory(inventory);
		assertManagedBundleManifestSize(inventoryContents);
		await writeTextAtomic(path.join(staged, "managed-bundle.json"), inventoryContents);
		await fs.mkdir(path.dirname(output), { recursive: true });
		if (await Bun.file(output).exists()) throw new AutoBotReleaseError(`Refusing to overwrite collab web archive: ${output}`);
		// The coordinator admits only ustar file/directory entries; GNU/PAX extensions are unavailable.
		const tarArguments =
			process.platform === "win32"
				? ["tar", "--format=ustar", "--mtime", "1970-01-01 00:00:00 UTC", "-czf", output, "."]
				: ["tar", "--format=ustar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", output, "."];
		await runCommand(tarArguments, { cwd: staged, env: { ...Bun.env, GZIP: "-n" } });
		archiveCreated = true;
		await verifyManagedBundleArchive(output, { ...options, compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH });
		return inventory;
	} catch (error) {
		if (archiveCreated) await fs.rm(output, { force: true }).catch(() => {});
		throw error;
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	assertKnownOptions(args, ["dist", "public", "out", "web-bundle-id", "fork-commit", "upstream-commit", "upstream-version"]);
	const output = requiredOption(args, "out");
	const inventory = await createManagedBundle({
		dist: requiredOption(args, "dist"),
		publicDirectory: optionalOption(args, "public"),
		out: output,
		bundleId: requiredOption(args, "web-bundle-id"),
		forkCommit: requiredOption(args, "fork-commit"),
		upstreamCommit: requiredOption(args, "upstream-commit"),
		upstreamVersion: requiredOption(args, "upstream-version"),
	});
	console.log(`Packaged collab web bundle ${inventory.bundleId} at ${output}`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		outputError(error);
		process.exitCode = 1;
	}
}
