import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { isRecord } from "../../utils/src/type-guards";
export const NATIVE_BUILD_PROVENANCE_FILENAME = "native-build-provenance.json";

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const WINDOWS_VARIANT = /^win32-(?:x64-(?:baseline|modern)|arm64)$/;
const WINDOWS_CARGO_TARGET = /^(?:x86_64|aarch64)-pc-windows-msvc$/;
const CARGO_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const INPUT_DOMAIN = "omp-native-inputs-v1\n";

export interface NativeBuildArtifact {
	readonly filename: string;
	readonly variant: string;
	readonly size: number;
	readonly sha256: string;
}

export interface NativeBuildIdentity {
	readonly target: string;
	readonly profile: string;
	readonly toolchain: string;
}

export interface NativeBuildProvenance {
	readonly schemaVersion: 1;
	readonly nativeCompatibilityVersion: string;
	readonly inputsSha256: string;
	readonly build: NativeBuildIdentity;
	readonly artifacts: readonly NativeBuildArtifact[];
}

export interface ValidatedNativeBuildArtifact extends NativeBuildArtifact {
	readonly path: string;
}

export interface NativeInputErrorDetails {
	readonly [key: string]: string | number | boolean | null | readonly string[];
}

export class NativeInputError extends Error {
	readonly code: string;
	readonly details: NativeInputErrorDetails;

	constructor(code: string, message: string, details: NativeInputErrorDetails = {}) {
		super(message);
		this.name = "NativeInputError";
		this.code = code;
		this.details = details;
	}
}

export interface ValidateNativeArtifactInputsOptions {
	readonly sourceRoot: string;
	readonly nativeDirectory: string;
	readonly provenanceSha256: string;
}

export interface ValidatedNativeArtifactInputs {
	readonly provenance: NativeBuildProvenance;
	readonly provenanceSha256: string;
	readonly artifacts: readonly ValidatedNativeBuildArtifact[];
}

export interface WriteNativeBuildProvenanceOptions {
	readonly sourceRoot: string;
	readonly nativeDirectory: string;
	readonly inputsSha256: string;
	readonly build: NativeBuildIdentity;
	readonly artifacts: readonly { readonly filename: string; readonly variant: string }[];
}

export interface WrittenNativeBuildProvenance {
	readonly provenance: NativeBuildProvenance;
	readonly provenanceSha256: string;
	readonly path: string;
}

// Runtime records cross a trust boundary; parse and validate every consumed field below.

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new NativeInputError("NATIVE_PROVENANCE_INVALID", `${label} must contain exactly: ${wanted.join(", ")}`, {
			label,
			fields: actual,
		});
	}
}

function stringField(value: unknown, label: string, maxLength = 4096): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		/[\u0000-\u001f\u007f]/.test(value)
	) {
		throw new NativeInputError("NATIVE_PROVENANCE_INVALID", `${label} must be a bounded non-empty string`, { label });
	}
	return value;
}

function shaField(value: unknown, label: string): string {
	const result = stringField(value, label);
	if (!SHA256.test(result)) {
		throw new NativeInputError("NATIVE_PROVENANCE_INVALID", `${label} must be a lowercase SHA-256 digest`, { label });
	}
	return result;
}

function positiveSize(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new NativeInputError("NATIVE_PROVENANCE_INVALID", `${label} must be a positive safe integer`, { label });
	}
	return value;
}

function assertArtifactName(filename: string, variant: string, label: string): void {
	if (
		path.basename(filename) !== filename ||
		!WINDOWS_VARIANT.test(variant) ||
		filename !== `pi_natives.${variant}.node`
	) {
		throw new NativeInputError(
			"NATIVE_PROVENANCE_INVALID",
			`${label} filename and variant must identify the same canonical Windows pi_natives addon`,
			{ filename, variant },
		);
	}
}

export function parseNativeBuildProvenance(value: unknown): NativeBuildProvenance {
	if (!isRecord(value))
		throw new NativeInputError("NATIVE_PROVENANCE_INVALID", "Native provenance must be a JSON object");
	exactKeys(
		value,
		["schemaVersion", "nativeCompatibilityVersion", "inputsSha256", "build", "artifacts"],
		"Native provenance",
	);
	if (value.schemaVersion !== 1) {
		throw new NativeInputError("NATIVE_PROVENANCE_INVALID", "Native provenance schemaVersion must be 1", {
			schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : null,
		});
	}
	const nativeCompatibilityVersion = stringField(value.nativeCompatibilityVersion, "nativeCompatibilityVersion");
	if (!VERSION.test(nativeCompatibilityVersion)) {
		throw new NativeInputError("NATIVE_PROVENANCE_INVALID", "nativeCompatibilityVersion is not a supported version", {
			nativeCompatibilityVersion,
		});
	}
	const inputsSha256 = shaField(value.inputsSha256, "inputsSha256");
	if (!isRecord(value.build)) throw new NativeInputError("NATIVE_PROVENANCE_INVALID", "build must be an object");
	exactKeys(value.build, ["target", "profile", "toolchain"], "build");
	const build: NativeBuildIdentity = {
		target: stringField(value.build.target, "build.target", 128),
		profile: stringField(value.build.profile, "build.profile", 128),
		toolchain: stringField(value.build.toolchain, "build.toolchain"),
	};
	if (!WINDOWS_CARGO_TARGET.test(build.target)) {
		throw new NativeInputError(
			"NATIVE_PROVENANCE_INVALID",
			"build.target must be a supported Windows MSVC Cargo target",
			{
				target: build.target,
			},
		);
	}
	if (!CARGO_PROFILE.test(build.profile)) {
		throw new NativeInputError("NATIVE_PROVENANCE_INVALID", "build.profile must be a Cargo profile name", {
			profile: build.profile,
		});
	}
	if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > 16) {
		throw new NativeInputError("NATIVE_PROVENANCE_INVALID", "artifacts must contain between 1 and 16 entries");
	}
	const filenames = new Set<string>();
	const variants = new Set<string>();
	const artifacts = value.artifacts.map((entry, index): NativeBuildArtifact => {
		if (!isRecord(entry))
			throw new NativeInputError("NATIVE_PROVENANCE_INVALID", `artifacts[${index}] must be an object`);
		exactKeys(entry, ["filename", "variant", "size", "sha256"], `artifacts[${index}]`);
		const filename = stringField(entry.filename, `artifacts[${index}].filename`);
		const variant = stringField(entry.variant, `artifacts[${index}].variant`);
		assertArtifactName(filename, variant, `artifacts[${index}]`);
		if (filenames.has(filename) || variants.has(variant)) {
			throw new NativeInputError(
				"NATIVE_PROVENANCE_INVALID",
				"Native provenance contains a duplicate filename or variant",
				{
					filename,
					variant,
				},
			);
		}
		filenames.add(filename);
		variants.add(variant);
		return {
			filename,
			variant,
			size: positiveSize(entry.size, `artifacts[${index}].size`),
			sha256: shaField(entry.sha256, `artifacts[${index}].sha256`),
		};
	});
	const targetVariantMatches = artifacts.every(artifact =>
		build.target === "x86_64-pc-windows-msvc"
			? artifact.variant.startsWith("win32-x64-")
			: artifact.variant === "win32-arm64",
	);
	if (!targetVariantMatches) {
		throw new NativeInputError(
			"NATIVE_PROVENANCE_INVALID",
			"Native artifact variants do not match the recorded Windows Cargo target",
			{ target: build.target, variants: artifacts.map(artifact => artifact.variant) },
		);
	}
	return { schemaVersion: 1, nativeCompatibilityVersion, inputsSha256, build, artifacts };
}

async function regularFile(
	file: string,
	label: string,
	missingCode = "NATIVE_INPUT_INVALID",
	invalidCode = "NATIVE_INPUT_INVALID",
): Promise<Stats> {
	let stat: Stats;
	try {
		stat = await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new NativeInputError(missingCode, `${label} is missing`, { path: file });
		}
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new NativeInputError(invalidCode, `${label} must be a real regular file`, { path: file });
	}
	return stat;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex");
}

async function readRegularFile(
	file: string,
	label: string,
	missingCode?: string,
	invalidCode?: string,
): Promise<{ bytes: Uint8Array; size: number; sha256: string }> {
	const before = await regularFile(file, label, missingCode, invalidCode);
	const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
	const after = await regularFile(file, label, missingCode, invalidCode);
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== before.size) {
		throw new NativeInputError("NATIVE_INPUT_CHANGED", `${label} changed while it was read`, { path: file });
	}
	return { bytes, size: bytes.byteLength, sha256: await hashBytes(bytes) };
}

async function collectTree(root: string, relativeRoot: string): Promise<string[]> {
	const absoluteRoot = path.join(root, relativeRoot);
	let rootStat: Stats;
	try {
		rootStat = await fs.lstat(absoluteRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new NativeInputError("NATIVE_INPUT_INVALID", "Native input directory must be a real directory", {
			path: absoluteRoot,
		});
	}
	const files: string[] = [];
	async function visit(relative: string): Promise<void> {
		const directory = path.join(root, relative);
		const entries = await fs.readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (entry.name === "target" || entry.name === ".git") continue;
			const child = path.posix.join(relative.split(path.sep).join("/"), entry.name);
			const childPath = path.join(root, ...child.split("/"));
			const stat = await fs.lstat(childPath);
			if (stat.isSymbolicLink()) {
				throw new NativeInputError("NATIVE_INPUT_INVALID", "Native inputs may not contain symbolic links", {
					path: child,
				});
			}
			if (stat.isDirectory()) await visit(child);
			else if (stat.isFile()) files.push(child);
			else
				throw new NativeInputError("NATIVE_INPUT_INVALID", "Native inputs may contain only regular files", {
					path: child,
				});
		}
	}
	await visit(relativeRoot);
	return files;
}
async function hashResolvedPackageTree(packageRoot: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update("omp-resolved-napi-package-v1\n");
	for (const relative of (await collectTree(packageRoot, ".")).sort()) {
		const read = await readRegularFile(
			path.join(packageRoot, ...relative.split("/")),
			`Resolved @napi-rs/cli file ${relative}`,
		);
		hasher.update(`${relative}\0${read.size}\0`);
		hasher.update(read.bytes);
		hasher.update("\n");
	}
	return hasher.digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
function parseJsonObject(bytes: Uint8Array, label: string, pathname: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		throw new NativeInputError("NATIVE_INPUT_INVALID", `${label} is not valid UTF-8 JSON`, {
			path: pathname,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	if (!isRecord(value)) {
		throw new NativeInputError("NATIVE_INPUT_INVALID", `${label} must contain a JSON object`, { path: pathname });
	}
	return value;
}

async function packageBuildMetadata(sourceRoot: string): Promise<Uint8Array> {
	const rootPackagePath = path.join(sourceRoot, "package.json");
	const nativePackagePath = path.join(sourceRoot, "packages/natives/package.json");
	const rootPackage = parseJsonObject(
		(await readRegularFile(rootPackagePath, "Root package.json")).bytes,
		"Root package.json",
		rootPackagePath,
	);
	const nativePackage = parseJsonObject(
		(await readRegularFile(nativePackagePath, "Native package.json")).bytes,
		"Native package.json",
		nativePackagePath,
	);
	const workspaces = isRecord(rootPackage.workspaces) ? rootPackage.workspaces : {};
	const catalog = isRecord(workspaces.catalog) ? workspaces.catalog : {};
	const devDependencies = isRecord(nativePackage.devDependencies) ? nativePackage.devDependencies : {};
	const compatibility = nativePackage.nativeCompatibilityVersion;
	if (typeof compatibility !== "string" || !VERSION.test(compatibility)) {
		throw new NativeInputError(
			"NATIVE_INPUT_INVALID",
			"packages/natives/package.json must declare nativeCompatibilityVersion",
			{
				path: "packages/natives/package.json",
			},
		);
	}
	const require_ = createRequire(nativePackagePath);
	let napiManifestPath: string;
	try {
		napiManifestPath = require_.resolve("@napi-rs/cli/package.json");
	} catch (error) {
		throw new NativeInputError("NATIVE_INPUT_INVALID", "Cannot resolve @napi-rs/cli from the native package", {
			path: nativePackagePath,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	const manifestRead = await readRegularFile(napiManifestPath, "Resolved @napi-rs/cli package manifest");
	const manifest = parseJsonObject(manifestRead.bytes, "Resolved @napi-rs/cli package manifest", napiManifestPath);
	const bin = isRecord(manifest.bin) ? manifest.bin.napi : undefined;
	if (typeof bin !== "string" || path.isAbsolute(bin) || bin.split(/[\\/]/).includes("..")) {
		throw new NativeInputError("NATIVE_INPUT_INVALID", "Resolved @napi-rs/cli has an invalid napi bin entry");
	}
	const binPath = path.join(path.dirname(napiManifestPath), bin);
	const binRead = await readRegularFile(binPath, "Resolved @napi-rs/cli entrypoint");
	const packageTreeSha256 = await hashResolvedPackageTree(path.dirname(napiManifestPath));
	return new TextEncoder().encode(
		stableJson({
			nativeCompatibilityVersion: compatibility,
			napi: nativePackage.napi,
			declaredNapiCli: devDependencies["@napi-rs/cli"],
			catalogNapiCli: catalog["@napi-rs/cli"],
			resolvedNapiCli: { name: manifest.name, version: manifest.version, bin: manifest.bin },
			resolvedNapiManifestSha256: manifestRead.sha256,
			resolvedNapiBinSha256: binRead.sha256,
			resolvedNapiPackageSha256: packageTreeSha256,
		}),
	);
}

export async function computeNativeInputsSha256(sourceRoot: string): Promise<string> {
	const root = path.resolve(sourceRoot);
	const rootStat = await fs.lstat(root).catch(error => {
		throw new NativeInputError("NATIVE_INPUT_INVALID", "Native source root does not exist", {
			path: root,
			cause: error instanceof Error ? error.message : String(error),
		});
	});
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new NativeInputError("NATIVE_INPUT_INVALID", "Native source root must be a real directory", { path: root });
	}
	const requiredFiles = [
		"Cargo.toml",
		"Cargo.lock",
		"rust-toolchain.toml",
		"packages/natives/scripts/build-bindings.ts",
		"packages/natives/scripts/native-build-provenance.ts",
		"scripts/bazel-natives.ts",
		"scripts/host-detect.ts",
	];
	const files = new Set(requiredFiles);
	for (const tree of [".cargo", "crates"]) {
		for (const file of await collectTree(root, tree)) files.add(file);
	}
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(INPUT_DOMAIN);
	for (const relative of [...files].sort()) {
		const normalized = relative.split(path.sep).join("/");
		const read = await readRegularFile(path.join(root, ...normalized.split("/")), `Native input ${normalized}`);
		hasher.update(`${normalized}\0${read.size}\0`);
		hasher.update(read.bytes);
		hasher.update("\n");
	}
	const metadata = await packageBuildMetadata(root);
	hasher.update(`packages/natives/package.build-metadata.json\0${metadata.byteLength}\0`);
	hasher.update(metadata);
	hasher.update("\n");
	return hasher.digest("hex");
}

function sentinelName(version: string): string {
	return `__piNativesV${version.replace(/[^0-9A-Za-z]/g, "_")}`;
}
async function readNativeCompatibilityVersion(sourceRoot: string): Promise<string> {
	const packagePath = path.join(path.resolve(sourceRoot), "packages/natives/package.json");
	let value: unknown;
	try {
		value = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				(await readRegularFile(packagePath, "Native package.json")).bytes,
			),
		);
	} catch (error) {
		if (error instanceof NativeInputError) throw error;
		throw new NativeInputError("NATIVE_INPUT_INVALID", "Native package.json is not valid UTF-8 JSON", {
			path: packagePath,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	if (
		!isRecord(value) ||
		typeof value.nativeCompatibilityVersion !== "string" ||
		!VERSION.test(value.nativeCompatibilityVersion)
	) {
		throw new NativeInputError("NATIVE_INPUT_INVALID", "Native package lacks a valid nativeCompatibilityVersion", {
			path: packagePath,
		});
	}
	return value.nativeCompatibilityVersion;
}

function includesBytes(haystack: Uint8Array, needleText: string): boolean {
	const needle = new TextEncoder().encode(needleText);
	outer: for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
		for (let index = 0; index < needle.length; index++)
			if (haystack[offset + index] !== needle[index]) continue outer;
		return true;
	}
	return false;
}

async function readProvenanceFile(
	nativeDirectory: string,
): Promise<{ path: string; bytes: Uint8Array; sha256: string }> {
	const provenancePath = path.join(path.resolve(nativeDirectory), NATIVE_BUILD_PROVENANCE_FILENAME);
	const read = await readRegularFile(
		provenancePath,
		"Native build provenance",
		"NATIVE_PROVENANCE_MISSING",
		"NATIVE_PROVENANCE_INVALID",
	);
	return { path: provenancePath, bytes: read.bytes, sha256: read.sha256 };
}

export async function validateNativeArtifactInputs(
	options: ValidateNativeArtifactInputsOptions,
): Promise<ValidatedNativeArtifactInputs> {
	if (!SHA256.test(options.provenanceSha256)) {
		throw new NativeInputError(
			"NATIVE_PROVENANCE_PIN_INVALID",
			"Configured native provenance SHA-256 pin is invalid",
		);
	}
	const record = await readProvenanceFile(options.nativeDirectory);
	if (record.sha256 !== options.provenanceSha256) {
		throw new NativeInputError(
			"NATIVE_PROVENANCE_PIN_MISMATCH",
			"Native build provenance bytes do not match the configured SHA-256 pin",
			{
				expectedSha256: options.provenanceSha256,
				actualSha256: record.sha256,
			},
		);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record.bytes));
	} catch (error) {
		throw new NativeInputError("NATIVE_PROVENANCE_INVALID", "Native build provenance is not valid UTF-8 JSON", {
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	const provenance = parseNativeBuildProvenance(decoded);
	const sourceCompatibilityVersion = await readNativeCompatibilityVersion(options.sourceRoot);
	if (sourceCompatibilityVersion !== provenance.nativeCompatibilityVersion) {
		throw new NativeInputError(
			"NATIVE_COMPATIBILITY_MISMATCH",
			"Native provenance compatibility version does not match the source package",
			{
				expectedVersion: sourceCompatibilityVersion,
				actualVersion: provenance.nativeCompatibilityVersion,
			},
		);
	}
	const actualInputsSha256 = await computeNativeInputsSha256(options.sourceRoot);
	if (actualInputsSha256 !== provenance.inputsSha256) {
		throw new NativeInputError("NATIVE_INPUT_MISMATCH", "Native source inputs do not match the pinned native build", {
			expectedSha256: provenance.inputsSha256,
			actualSha256: actualInputsSha256,
		});
	}
	const sentinel = sentinelName(provenance.nativeCompatibilityVersion);
	const artifacts: ValidatedNativeBuildArtifact[] = [];
	for (const artifact of provenance.artifacts) {
		const artifactPath = path.join(path.resolve(options.nativeDirectory), artifact.filename);
		const read = await readRegularFile(
			artifactPath,
			`Native addon ${artifact.filename}`,
			"NATIVE_ARTIFACT_MISSING",
			"NATIVE_ARTIFACT_INVALID",
		);
		if (read.size !== artifact.size || read.sha256 !== artifact.sha256) {
			throw new NativeInputError(
				"NATIVE_ARTIFACT_MISMATCH",
				`Native addon ${artifact.filename} does not match its provenance bytes`,
				{
					filename: artifact.filename,
					expectedSize: artifact.size,
					actualSize: read.size,
					expectedSha256: artifact.sha256,
					actualSha256: read.sha256,
				},
			);
		}
		if (!includesBytes(read.bytes, sentinel)) {
			throw new NativeInputError("NATIVE_SENTINEL_MISMATCH", `Native addon ${artifact.filename} lacks ${sentinel}`, {
				filename: artifact.filename,
				sentinel,
			});
		}
		artifacts.push({ ...artifact, path: artifactPath });
	}
	return { provenance, provenanceSha256: record.sha256, artifacts };
}

export async function writeNativeBuildProvenance(
	options: WriteNativeBuildProvenanceOptions,
): Promise<WrittenNativeBuildProvenance> {
	if (!SHA256.test(options.inputsSha256)) {
		throw new NativeInputError("NATIVE_INPUT_INVALID", "Pre-build native input SHA-256 is invalid");
	}
	const nativeCompatibilityVersion = await readNativeCompatibilityVersion(options.sourceRoot);
	const currentInputsSha256 = await computeNativeInputsSha256(options.sourceRoot);
	if (currentInputsSha256 !== options.inputsSha256) {
		throw new NativeInputError("NATIVE_INPUT_CHANGED", "Native source inputs changed during the native build", {
			beforeSha256: options.inputsSha256,
			afterSha256: currentInputsSha256,
		});
	}
	const artifacts: NativeBuildArtifact[] = [];
	const filenames = new Set<string>();
	const variants = new Set<string>();
	for (const descriptor of options.artifacts) {
		assertArtifactName(descriptor.filename, descriptor.variant, "Native artifact");
		if (filenames.has(descriptor.filename) || variants.has(descriptor.variant)) {
			throw new NativeInputError(
				"NATIVE_INPUT_INVALID",
				"Cannot write duplicate native artifact filename or variant",
				{
					filename: descriptor.filename,
					variant: descriptor.variant,
				},
			);
		}
		filenames.add(descriptor.filename);
		variants.add(descriptor.variant);
		const artifactPath = path.join(path.resolve(options.nativeDirectory), descriptor.filename);
		const read = await readRegularFile(
			artifactPath,
			`Native addon ${descriptor.filename}`,
			"NATIVE_ARTIFACT_MISSING",
			"NATIVE_ARTIFACT_INVALID",
		);
		const sentinel = sentinelName(nativeCompatibilityVersion);
		if (!includesBytes(read.bytes, sentinel)) {
			throw new NativeInputError(
				"NATIVE_SENTINEL_MISMATCH",
				`Native addon ${descriptor.filename} lacks ${sentinel}`,
				{
					filename: descriptor.filename,
					sentinel,
				},
			);
		}
		artifacts.push({ ...descriptor, size: read.size, sha256: read.sha256 });
	}
	const provenance = parseNativeBuildProvenance({
		schemaVersion: 1,
		nativeCompatibilityVersion,
		inputsSha256: options.inputsSha256,
		build: options.build,
		artifacts,
	});
	const provenancePath = path.join(path.resolve(options.nativeDirectory), NATIVE_BUILD_PROVENANCE_FILENAME);
	const bytes = new TextEncoder().encode(`${JSON.stringify(provenance, null, "\t")}\n`);
	const tempPath = `${provenancePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
	await fs.mkdir(path.dirname(provenancePath), { recursive: true });
	await fs.writeFile(tempPath, bytes, { flag: "wx", mode: 0o644 });
	try {
		await fs.rename(tempPath, provenancePath);
	} catch (renameError) {
		try {
			await fs.unlink(provenancePath);
		} catch {
			await fs.unlink(tempPath).catch(() => {});
			throw renameError;
		}
		try {
			await fs.rename(tempPath, provenancePath);
		} catch (replacementError) {
			await fs.unlink(tempPath).catch(() => {});
			throw replacementError;
		}
	}
	return { provenance, provenanceSha256: await hashBytes(bytes), path: provenancePath };
}

async function cli(): Promise<void> {
	const [command, sourceRoot, nativeDirectory, provenanceSha256, ...extra] = process.argv.slice(2);
	if (command !== "validate" || !sourceRoot || !nativeDirectory || !provenanceSha256 || extra.length > 0) {
		throw new NativeInputError(
			"NATIVE_CLI_USAGE",
			"Usage: bun native-build-provenance.ts validate <source-root> <native-directory> <provenance-sha256>",
		);
	}
	const result = await validateNativeArtifactInputs({ sourceRoot, nativeDirectory, provenanceSha256 });
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
	try {
		await cli();
	} catch (error) {
		if (error instanceof NativeInputError) {
			process.stderr.write(
				`${JSON.stringify({ name: error.name, code: error.code, message: error.message, details: error.details })}\n`,
			);
		} else {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}
		process.exit(1);
	}
}
