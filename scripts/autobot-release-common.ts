#!/usr/bin/env bun

import { type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	parseAutoBotReleaseManifest,
	parseAutoBotReleasePayload,
	parseSignedAutoBotReleaseEnvelope,
	serializeAutoBotReleaseManifest,
	type AutoBotReleaseAsset,
	type AutoBotReleaseManifest,
	type SignedAutoBotReleaseEnvelope,
} from "../packages/coding-agent/src/autobot-update/contract.ts";
import { isRecord } from "../packages/utils/src/type-guards.ts";

export const AUTO_BOT_ASSET_KINDS = ["runtime", "bootstrap", "coordinator-client", "collab-web"] as const;
export type AutoBotAssetKind = (typeof AUTO_BOT_ASSET_KINDS)[number];

const SAFE_KEY_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_RELATIVE_FILE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class AutoBotReleaseError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AutoBotReleaseError";
	}
}

export interface ParsedCliArgs {
	readonly flags: ReadonlyMap<string, readonly string[]>;
	readonly positionals: readonly string[];
}

/** Parse long options strictly, keeping boolean options separate from valued options. */
export function parseCliArgs(argv: readonly string[], booleanFlags: readonly string[] = []): ParsedCliArgs {
	const booleans = new Set(booleanFlags);
	const flags = new Map<string, string[]>();
	const positionals: string[] = [];
	let positionalOnly = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index] ?? "";
		if (positionalOnly) {
			positionals.push(argument);
			continue;
		}
		if (argument === "--") {
			positionalOnly = true;
			continue;
		}
		if (!argument.startsWith("--")) {
			positionals.push(argument);
			continue;
		}
		const equals = argument.indexOf("=");
		const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
		if (!name) throw new AutoBotReleaseError("An option name is required after --");
		if (booleans.has(name)) {
			if (equals !== -1) throw new AutoBotReleaseError(`--${name} does not accept a value`);
			if (flags.has(name)) throw new AutoBotReleaseError(`--${name} may be supplied only once`);
			flags.set(name, ["true"]);
			continue;
		}
		let value: string | undefined;
		if (equals !== -1) {
			value = argument.slice(equals + 1);
		} else {
			value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new AutoBotReleaseError(`--${name} requires a value`);
			}
			index++;
		}
		if (value.length === 0) throw new AutoBotReleaseError(`--${name} must not be empty`);
		const entries = flags.get(name) ?? [];
		entries.push(value);
		flags.set(name, entries);
	}
	return { flags, positionals };
}

export function assertKnownOptions(args: ParsedCliArgs, allowed: readonly string[]): void {
	const known = new Set(allowed);
	for (const name of args.flags.keys()) {
		if (!known.has(name)) throw new AutoBotReleaseError(`Unknown option --${name}`);
	}
	if (args.positionals.length > 0) {
		throw new AutoBotReleaseError(`Unexpected positional argument: ${args.positionals[0]}`);
	}
}

export function requiredOption(args: ParsedCliArgs, name: string): string {
	const values = args.flags.get(name);
	if (!values || values.length !== 1) throw new AutoBotReleaseError(`--${name} must be supplied exactly once`);
	return values[0] ?? "";
}

export function optionalOption(args: ParsedCliArgs, name: string): string | undefined {
	const values = args.flags.get(name);
	if (!values) return undefined;
	if (values.length !== 1) throw new AutoBotReleaseError(`--${name} may be supplied only once`);
	return values[0];
}

export function repeatedOption(args: ParsedCliArgs, name: string): readonly string[] {
	return args.flags.get(name) ?? [];
}

export function hasOption(args: ParsedCliArgs, name: string): boolean {
	return args.flags.has(name);
}

export function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new AutoBotReleaseError(`${label} must be a non-empty string`);
	return value;
}

export function requirePositiveSafeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new AutoBotReleaseError(`${label} must be a positive safe integer`);
	}
	return value;
}

export function requireCommit(value: string, label: string): string {
	if (!COMMIT.test(value)) throw new AutoBotReleaseError(`${label} must be a lowercase 40- or 64-character commit ID`);
	return value;
}

export function requireKeyId(value: string, label = "key ID"): string {
	if (!SAFE_KEY_ID.test(value)) throw new AutoBotReleaseError(`${label} must use only letters, digits, _ and -`);
	return value;
}

export function requireSha256(value: string, label: string): string {
	if (!SHA256.test(value)) throw new AutoBotReleaseError(`${label} must be a lowercase SHA-256 hexadecimal digest`);
	return value;
}

export function parseJson(text: string, label: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new AutoBotReleaseError(`${label} is not valid JSON`, { cause: error });
	}
}

export async function readJson(pathname: string, label: string): Promise<unknown> {
	try {
		await requireRegularFile(pathname, label);
		return parseJson(await Bun.file(pathname).text(), label);
	} catch (error) {
		if (error instanceof AutoBotReleaseError) throw error;
		throw new AutoBotReleaseError(`Could not read ${label}: ${pathname}`, { cause: error });
	}
}

export async function writeTextAtomic(pathname: string, contents: string): Promise<void> {
	const absolute = path.resolve(pathname);
	const parent = path.dirname(absolute);
	await fs.mkdir(parent, { recursive: true });
	const temporary = path.join(parent, `.${path.basename(absolute)}.${crypto.randomUUID()}.tmp`);
	try {
		await Bun.write(temporary, contents);
		await fs.rename(temporary, absolute);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

export async function writeJsonAtomic(pathname: string, value: unknown): Promise<void> {
	await writeTextAtomic(pathname, `${JSON.stringify(value, null, "\t")}\n`);
}

export async function createEmptyDirectory(pathname: string, label: string): Promise<string> {
	const absolute = path.resolve(pathname);
	try {
		await fs.mkdir(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const entries = await fs.readdir(absolute);
		if (entries.length !== 0) throw new AutoBotReleaseError(`${label} must be a new or empty directory: ${absolute}`);
	}
	return absolute;
}

export async function requireRegularFile(pathname: string, label: string): Promise<Stats> {
	let stat: Stats;
	try {
		stat = await fs.lstat(pathname);
	} catch (error) {
		throw new AutoBotReleaseError(`${label} does not exist: ${pathname}`, { cause: error });
	}
	if (!stat.isFile()) throw new AutoBotReleaseError(`${label} must be a regular file: ${pathname}`);
	if (!Number.isSafeInteger(stat.size) || stat.size <= 0) {
		throw new AutoBotReleaseError(`${label} must have a positive safe byte size: ${pathname}`);
	}
	return stat;
}

export async function hashFile(pathname: string): Promise<{ readonly size: number; readonly sha256: string }> {
	const stat = await requireRegularFile(pathname, "Release asset");
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(pathname).stream()) {
		hasher.update(chunk);
	}
	return { size: stat.size, sha256: hasher.digest("hex") };
}

export function relativeAssetPath(value: string): string {
	if (!SAFE_RELATIVE_FILE.test(value)) throw new AutoBotReleaseError(`Asset index path is not a safe relative file path: ${value}`);
	return value;
}

export function resolveIndexedPath(indexDirectory: string, relative: string): string {
	const safeRelative = relativeAssetPath(relative);
	const resolved = path.resolve(indexDirectory, safeRelative);
	const relativeToIndex = path.relative(indexDirectory, resolved);
	if (relativeToIndex.startsWith("..") || path.isAbsolute(relativeToIndex)) {
		throw new AutoBotReleaseError(`Asset index path escapes its directory: ${relative}`);
	}
	return resolved;
}

export async function runCommand(
	argv: readonly string[],
	options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly capture?: boolean } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
	if (argv.length === 0) throw new AutoBotReleaseError("Cannot run an empty command");
	const capture = options.capture === true;
	const process = Bun.spawn([...argv], {
		cwd: options.cwd,
		env: options.env,
		stdout: capture ? "pipe" : "inherit",
		stderr: capture ? "pipe" : "inherit",
	});
	if (capture) {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		]);
		if (exitCode !== 0) throw new AutoBotReleaseError(`${argv[0]} failed with exit code ${exitCode}`);
		return { stdout, stderr };
	}
	const exitCode = await process.exited;
	if (exitCode !== 0) throw new AutoBotReleaseError(`${argv[0]} failed with exit code ${exitCode}`);
	return { stdout: "", stderr: "" };
}

export async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
	const result = await runCommand(["git", ...args], { cwd, capture: true });
	return result.stdout.trim();
}

export interface AssetInput {
	readonly kind: AutoBotAssetKind;
	readonly target: string;
	readonly source: string;
	readonly url: string;
}

function isAssetKind(value: string): value is AutoBotAssetKind {
	return (AUTO_BOT_ASSET_KINDS as readonly string[]).includes(value);
}

function parseAssetInput(value: unknown, index: number): AssetInput {
	if (!isRecord(value)) throw new AutoBotReleaseError(`assets[${index}] must be an object`);
	for (const key of Object.keys(value)) {
		if (!["kind", "target", "source", "url"].includes(key)) {
			throw new AutoBotReleaseError(`assets[${index}] has an unsupported field: ${key}`);
		}
	}
	const kind = requireString(value.kind, `assets[${index}].kind`);
	if (!isAssetKind(kind)) throw new AutoBotReleaseError(`assets[${index}].kind is unsupported`);
	const target = requireString(value.target, `assets[${index}].target`);
	const source = requireString(value.source, `assets[${index}].source`);
	const url = requireString(value.url, `assets[${index}].url`);
	return { kind, target, source, url };
}

export async function readAssetInputs(pathname: string): Promise<readonly AssetInput[]> {
	const parsed = await readJson(pathname, "asset list");
	if (!Array.isArray(parsed) || parsed.length === 0) throw new AutoBotReleaseError("Asset list must be a non-empty JSON array");
	return parsed.map(parseAssetInput);
}

export interface AssetIndexEntry {
	readonly kind: AutoBotAssetKind;
	readonly target: string;
	readonly file: string;
}

export interface AssetIndex {
	readonly schemaVersion: 1;
	readonly assets: readonly AssetIndexEntry[];
}

function parseAssetIndexEntry(value: unknown, index: number): AssetIndexEntry {
	if (!isRecord(value)) throw new AutoBotReleaseError(`asset index assets[${index}] must be an object`);
	for (const key of Object.keys(value)) {
		if (!["kind", "target", "file"].includes(key)) {
			throw new AutoBotReleaseError(`asset index assets[${index}] has an unsupported field: ${key}`);
		}
	}
	const kind = requireString(value.kind, `asset index assets[${index}].kind`);
	if (!isAssetKind(kind)) throw new AutoBotReleaseError(`asset index assets[${index}].kind is unsupported`);
	return {
		kind,
		target: requireString(value.target, `asset index assets[${index}].target`),
		file: relativeAssetPath(requireString(value.file, `asset index assets[${index}].file`)),
	};
}

export function parseAssetIndex(value: unknown): AssetIndex {
	if (!isRecord(value)) throw new AutoBotReleaseError("Asset index must be an object");
	for (const key of Object.keys(value)) {
		if (!["schemaVersion", "assets"].includes(key)) throw new AutoBotReleaseError(`Asset index has an unsupported field: ${key}`);
	}
	if (value.schemaVersion !== 1) throw new AutoBotReleaseError("Asset index schemaVersion must be 1");
	if (!Array.isArray(value.assets) || value.assets.length === 0) {
		throw new AutoBotReleaseError("Asset index assets must be a non-empty array");
	}
	const assets = value.assets.map(parseAssetIndexEntry);
	const identities = new Set<string>();
	const files = new Set<string>();
	for (const asset of assets) {
		const identity = `${asset.kind}\u0000${asset.target}`;
		if (identities.has(identity)) throw new AutoBotReleaseError(`Asset index duplicates ${asset.kind}/${asset.target}`);
		if (files.has(asset.file)) throw new AutoBotReleaseError(`Asset index reuses staged file ${asset.file}`);
		identities.add(identity);
		files.add(asset.file);
	}
	return { schemaVersion: 1, assets };
}

export async function verifyIndexedAssets(
	manifest: AutoBotReleaseManifest,
	assetIndexPath: string,
): Promise<void> {
	const indexPath = path.resolve(assetIndexPath);
	const index = parseAssetIndex(await readJson(indexPath, "asset index"));
	const indexed = new Map(index.assets.map(asset => [`${asset.kind}\u0000${asset.target}`, asset]));
	if (indexed.size !== manifest.assets.length) {
		throw new AutoBotReleaseError("Asset index and signed manifest have different asset counts");
	}
	for (const asset of manifest.assets) {
		const entry = indexed.get(`${asset.kind}\u0000${asset.target}`);
		if (!entry) throw new AutoBotReleaseError(`Asset index is missing ${asset.kind}/${asset.target}`);
		const stagedPath = resolveIndexedPath(path.dirname(indexPath), entry.file);
		const actual = await hashFile(stagedPath);
		if (actual.size !== asset.size || actual.sha256 !== asset.sha256) {
			throw new AutoBotReleaseError(`Staged asset verification failed for ${asset.kind}/${asset.target}`);
		}
	}
}

function decodePemOrDer(bytes: Uint8Array, label: string): Uint8Array {
	const text = new TextDecoder().decode(bytes).trim();
	if (!text.startsWith("-----BEGIN")) return bytes;
	const match = /^-----BEGIN ([A-Z0-9 ]+)-----\s*([A-Za-z0-9+/=\r\n]+)\s*-----END \1-----$/u.exec(text);
	if (!match) throw new AutoBotReleaseError(`${label} is not a supported PEM key`);
	try {
		return Uint8Array.from(Buffer.from(match[2].replace(/\s/g, ""), "base64"));
	} catch (error) {
		throw new AutoBotReleaseError(`${label} PEM payload is not base64`, { cause: error });
	}
}

export async function importEd25519PrivateKey(pathname: string): Promise<CryptoKey> {
	const bytes = decodePemOrDer(new Uint8Array(await Bun.file(pathname).arrayBuffer()), "Private signing key");
	try {
		return await crypto.subtle.importKey("pkcs8", bytes, { name: "Ed25519" }, false, ["sign"]);
	} catch (error) {
		throw new AutoBotReleaseError("Private signing key is not an Ed25519 PKCS#8 key", { cause: error });
	}
}

export async function importEd25519PublicKey(pathname: string): Promise<CryptoKey> {
	const bytes = decodePemOrDer(new Uint8Array(await Bun.file(pathname).arrayBuffer()), "Trusted public key");
	try {
		return await crypto.subtle.importKey("spki", bytes, { name: "Ed25519" }, false, ["verify"]);
	} catch (error) {
		throw new AutoBotReleaseError("Trusted public key is not an Ed25519 SPKI key", { cause: error });
	}
}

export async function signManifest(manifest: AutoBotReleaseManifest, keyId: string, privateKey: CryptoKey): Promise<SignedAutoBotReleaseEnvelope> {
	const payload = serializeAutoBotReleaseManifest(manifest);
	const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(payload)));
	if (signature.byteLength !== 64) throw new AutoBotReleaseError("Ed25519 signing produced an unexpected signature length");
	return { payload, signature: Buffer.from(signature).toString("base64"), keyId: requireKeyId(keyId) };
}

export interface TrustedKeySet {
	readonly keys: ReadonlyMap<string, CryptoKey>;
}

/**
 * Parse repeatable `--trusted-key keyId=path` values. Key selection is local
 * configuration only; envelope payloads never provide a key URL or material.
 */
export async function loadTrustedKeys(specifications: readonly string[]): Promise<TrustedKeySet> {
	const keys = new Map<string, CryptoKey>();
	for (const specification of specifications) {
		const equals = specification.indexOf("=");
		if (equals <= 0 || equals === specification.length - 1) {
			throw new AutoBotReleaseError("Each --trusted-key must be keyId=path-to-Ed25519-SPKI-key");
		}
		const keyId = requireKeyId(specification.slice(0, equals), "Trusted key ID");
		if (keys.has(keyId)) throw new AutoBotReleaseError(`Trusted key ${keyId} was supplied more than once`);
		keys.set(keyId, await importEd25519PublicKey(specification.slice(equals + 1)));
	}
	return { keys };
}

export interface VerifiedReleaseEnvelope {
	readonly envelope: SignedAutoBotReleaseEnvelope;
	readonly manifest: AutoBotReleaseManifest;
}

export async function verifySignedEnvelope(value: unknown, trustedKeys: TrustedKeySet): Promise<VerifiedReleaseEnvelope> {
	const envelope = parseSignedAutoBotReleaseEnvelope(value);
	const key = trustedKeys.keys.get(envelope.keyId);
	if (!key) throw new AutoBotReleaseError(`No locally configured trusted key matches envelope keyId ${envelope.keyId}`);
	let signature: Uint8Array;
	try {
		signature = Uint8Array.from(Buffer.from(envelope.signature, "base64"));
	} catch (error) {
		throw new AutoBotReleaseError("Signed release envelope has an invalid base64 signature", { cause: error });
	}
	const valid = await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(envelope.payload));
	if (!valid) throw new AutoBotReleaseError("Signed release envelope has an invalid Ed25519 signature");
	return { envelope, manifest: parseAutoBotReleasePayload(envelope.payload) };
}

export async function readVerifiedEnvelope(pathname: string, trustedKeys: TrustedKeySet): Promise<VerifiedReleaseEnvelope> {
	return verifySignedEnvelope(await readJson(pathname, "signed release envelope"), trustedKeys);
}

export function parseUnsignedManifest(value: unknown): AutoBotReleaseManifest {
	return parseAutoBotReleaseManifest(value);
}

export function assertReleaseSequenceAfter(candidate: AutoBotReleaseManifest, previous: AutoBotReleaseManifest): void {
	if (candidate.releaseSequence <= previous.releaseSequence) {
		throw new AutoBotReleaseError(
			`Release sequence ${candidate.releaseSequence} must be greater than existing sequence ${previous.releaseSequence}`,
		);
	}
}

export function outputError(error: unknown): void {
	if (error instanceof Error) {
		console.error(`AutoBot release failed: ${error.message}`);
	} else {
		console.error("AutoBot release failed with a non-error value");
	}
}

export function formatAssetIdentity(asset: Pick<AutoBotReleaseAsset, "kind" | "target">): string {
	return `${asset.kind}/${asset.target}`;
}
