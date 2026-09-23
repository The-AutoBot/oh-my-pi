import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";
import { type } from "@oh-my-pi/omptype";
import {
	parseAutoBotReleasePayload,
	parseSignedAutoBotReleaseEnvelope,
	type AutoBotReleaseAsset,
	type AutoBotReleaseManifest,
	type SignedAutoBotReleaseEnvelope,
} from "./contract";
import { readJsonIfPresent } from "./storage";

const MAX_CHANNEL_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const CHANNEL_TIMEOUT_MS = 30_000;
const ARTIFACT_TIMEOUT_MS = 15 * 60_000;

export interface AutoBotChannelConfig {
	readonly schemaVersion: 1;
	readonly envelopeUrl: string;
	/** Installer-controlled coordinator portal base; exact HTTPS `/live`, never workspace dotenv. */
	readonly collabPortalUrl: string;
	/** Local key-id → base64 SPKI DER; the signed channel never supplies trust material. */
	readonly trustedKeys: Readonly<Record<string, string>>;
	/** Additional HTTPS origins allowed for release assets after explicit installation-time approval. */
	readonly allowedArtifactOrigins: readonly string[];
}

export interface VerifiedAutoBotRelease {
	readonly envelope: SignedAutoBotReleaseEnvelope;
	/** Exact UTF-8 outer envelope bytes decoded as text, retained for asset provenance. */
	readonly envelopeJson: string;
	readonly manifest: AutoBotReleaseManifest;
	/** SHA-256 of exact UTF-8 signed payload bytes. */
	readonly payloadSha256: string;
	readonly allowedArtifactOrigins: Readonly<Record<string, true>>;
}

export interface AutoBotFetchDeps {
	readonly fetchImpl?: typeof fetch;
}

/** A redacted network/response-stream failure, distinct from authenticated content rejection. */
export class AutoBotTransportError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AutoBotTransportError";
	}
}

const ChannelConfigSchema = type({
	schemaVersion: "1",
	envelopeUrl: "string > 0",
	collabPortalUrl: "string > 0",
	trustedKeys: { "[string]": "string > 0" },
	"allowedArtifactOrigins?": "string[]",
});

function secureUrl(value: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be an absolute HTTPS URL`);
	}
	if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
		throw new Error(`${label} must be an HTTPS URL without credentials or fragments`);
	}
	return url;
}

function allowedOrigin(value: string, label: string): string {
	const url = secureUrl(value, label);
	if (url.search || url.pathname !== "/") throw new Error(`${label} must be an HTTPS origin`);
	return url.origin;
}

function approvedUrl(value: string, allowedOrigins: Readonly<Record<string, true>>, label: string): URL {
	const url = secureUrl(value, label);
	if (allowedOrigins[url.origin] !== true) throw new Error(`${label} origin is not approved`);
	return url;
}

function strictBase64(value: string, label: string): Uint8Array<ArrayBuffer> {
	try {
		return new Uint8Array(Uint8Array.fromBase64(value));
	} catch {
		throw new Error(`${label} must be base64`);
	}
}

function portalBase(value: string): string {
	const url = secureUrl(value, "AutoBot collaboration portal URL");
	if (url.search || url.pathname !== "/live") {
		throw new Error("AutoBot collaboration portal URL must be an HTTPS /live base");
	}
	return `${url.origin}/live`;
}

function reservedTrustedKeyId(value: string): boolean {
	return value === "__proto__" || value === "constructor" || value === "prototype";
}

function parseChannelConfig(value: unknown): AutoBotChannelConfig {
	const config = ChannelConfigSchema.assert(value);
	const envelopeUrl = secureUrl(config.envelopeUrl, "AutoBot envelope URL");
	const collabPortalUrl = portalBase(config.collabPortalUrl);
	const envelope = envelopeUrl.origin;
	const trustedKeys: Record<string, string> = Object.create(null) as Record<string, string>;
	for (const [keyId, encodedKey] of Object.entries(config.trustedKeys)) {
		if (!/^[A-Za-z0-9_-]{1,96}$/.test(keyId) || reservedTrustedKeyId(keyId)) {
			throw new Error("AutoBot trusted key ID is invalid");
		}
		const key = strictBase64(encodedKey, "AutoBot trusted public key");
		if (key.byteLength === 0 || key.byteLength > 16 * 1024)
			throw new Error("AutoBot trusted public key has an invalid size");
		trustedKeys[keyId] = encodedKey;
	}
	if (Object.keys(trustedKeys).length === 0) throw new Error("AutoBot channel has no trusted signing keys");
	const origins: Record<string, true> = Object.assign(Object.create(null), { [envelope]: true }) as Record<
		string,
		true
	>;
	const extraOrigins: string[] = [];
	for (const origin of config.allowedArtifactOrigins ?? []) {
		const normalized = allowedOrigin(origin, "AutoBot allowed artifact origin");
		origins[normalized] = true;
		extraOrigins.push(normalized);
	}
	return {
		schemaVersion: 1,
		envelopeUrl: envelopeUrl.toString(),
		trustedKeys,
		collabPortalUrl,
		allowedArtifactOrigins: extraOrigins,
	};
}

export async function readAutoBotChannelConfig(configPath: string): Promise<AutoBotChannelConfig | undefined> {
	const raw = await readJsonIfPresent(configPath);
	return raw === undefined ? undefined : parseChannelConfig(raw);
}

/** Bootstrap-safe local config read; it never falls back to ambient environment. */
export function readAutoBotChannelConfigSync(configPath: string): AutoBotChannelConfig | undefined {
	try {
		return parseChannelConfig(JSON.parse(fsSync.readFileSync(configPath, "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export function assertAutoBotChannelConfig(value: unknown): AutoBotChannelConfig {
	return parseChannelConfig(value);
}

async function discardResponseBody(response: Response): Promise<void> {
	const cancel = response.body?.cancel;
	if (typeof cancel === "function") await cancel.call(response.body).catch(() => undefined);
}
function openResponseReader(body: NonNullable<Response["body"]>, label: string) {
	try {
		return body.getReader();
	} catch {
		throw new AutoBotTransportError(`${label} response stream failed`);
	}
}

async function fetchApproved(
	initialUrl: string,
	allowedOrigins: Readonly<Record<string, true>>,
	label: string,
	timeoutMs: number,
	fetchImpl: typeof fetch,
): Promise<Response> {
	let current = approvedUrl(initialUrl, allowedOrigins, label);
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
		let response: Response;
		try {
			response = await fetchImpl(current, {
				redirect: "manual",
				credentials: "omit",
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			// Fetch implementations may include a presigned redirect URL in their
			// native error text. Never surface that credential-bearing detail.
			throw new AutoBotTransportError(`${label} request failed`);
		}
		if (response.status >= 300 && response.status < 400) {
			try {
				const location = response.headers.get("location");
				if (!location) throw new Error(`${label} redirect has no location`);
				if (redirect === MAX_REDIRECTS) throw new Error(`${label} exceeded redirect limit`);
				let redirectUrl: string;
				try {
					redirectUrl = new URL(location, current).toString();
				} catch {
					throw new Error(`${label} redirect is invalid`);
				}
				current = approvedUrl(redirectUrl, allowedOrigins, `${label} redirect`);
			} finally {
				await discardResponseBody(response);
			}
			continue;
		}
		if (!response.ok) {
			await discardResponseBody(response);
			throw new Error(`${label} request failed with HTTP ${response.status}`);
		}
		return response;
	}
	throw new Error(`${label} exceeded redirect limit`);
}

async function boundedResponseBytes(response: Response, label: string): Promise<Uint8Array> {
	let responseConsumed = false;
	try {
		const body = response.body;
		if (!body) throw new Error(`${label} has no response body`);
		const contentLength = response.headers.get("content-length");
		if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CHANNEL_BYTES)) {
			throw new Error(`${label} exceeds the maximum size`);
		}
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = openResponseReader(body, label);
		let streamCompleted = false;
		try {
			while (true) {
				let result: ReadableStreamReadResult<Uint8Array>;
				try {
					result = await reader.read();
				} catch {
					throw new AutoBotTransportError(`${label} response stream failed`);
				}
				if (result.done) {
					streamCompleted = true;
					break;
				}
				const value = result.value;
				size += value.byteLength;
				if (size > MAX_CHANNEL_BYTES) throw new Error(`${label} exceeds the maximum size`);
				chunks.push(value);
			}
		} finally {
			if (!streamCompleted) await reader.cancel().catch(() => undefined);
			try {
				reader.releaseLock();
			} catch {}
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		responseConsumed = true;
		return bytes;
	} finally {
		if (!responseConsumed) await discardResponseBody(response);
	}
}

/** Verify retained envelope bytes against installation-pinned trust without network access. */
export async function verifyAutoBotReleaseEnvelope(
	config: AutoBotChannelConfig,
	envelopeJson: string,
): Promise<VerifiedAutoBotRelease> {
	const checkedConfig = parseChannelConfig(config);
	const allowedOrigins: Record<string, true> = Object.assign(Object.create(null), {
		[secureUrl(checkedConfig.envelopeUrl, "AutoBot envelope URL").origin]: true,
	}) as Record<string, true>;
	for (const origin of checkedConfig.allowedArtifactOrigins) allowedOrigins[origin] = true;
	let envelopeValue: unknown;
	try {

		envelopeValue = JSON.parse(envelopeJson);
	} catch (error) {
		throw new Error("AutoBot release channel is not valid UTF-8 JSON", { cause: error });
	}
	const envelope = parseSignedAutoBotReleaseEnvelope(envelopeValue);
	const encodedKey = checkedConfig.trustedKeys[envelope.keyId];
	if (!encodedKey) throw new Error("AutoBot release signature key is not trusted by this installation");
	const signature = strictBase64(envelope.signature, "AutoBot release signature");
	const key = await crypto.subtle.importKey(
		"spki",
		strictBase64(encodedKey, "AutoBot trusted public key"),
		{ name: "Ed25519" },
		false,
		["verify"],
	);
	const payloadBytes = new TextEncoder().encode(envelope.payload);
	if (!(await crypto.subtle.verify("Ed25519", key, signature, payloadBytes))) {
		throw new Error("AutoBot release signature verification failed");
	}
	return {
		envelope,
		envelopeJson,
		manifest: parseAutoBotReleasePayload(envelope.payload),
		payloadSha256: createHash("sha256").update(payloadBytes).digest("hex"),
		allowedArtifactOrigins: allowedOrigins,
	};
}

/** Fetch, verify, and parse a channel document without accepting channel-provided keys or origins. */
export async function fetchVerifiedAutoBotRelease(
	config: AutoBotChannelConfig,
	deps: AutoBotFetchDeps = {},
): Promise<VerifiedAutoBotRelease> {
	const checkedConfig = parseChannelConfig(config);
	const allowedOrigins: Record<string, true> = Object.assign(Object.create(null), {
		[secureUrl(checkedConfig.envelopeUrl, "AutoBot envelope URL").origin]: true,
	}) as Record<string, true>;
	for (const origin of checkedConfig.allowedArtifactOrigins) allowedOrigins[origin] = true;
	const response = await fetchApproved(
		checkedConfig.envelopeUrl,
		allowedOrigins,
		"AutoBot release channel",
		CHANNEL_TIMEOUT_MS,
		deps.fetchImpl ?? fetch,
	);
	let envelopeJson: string;
	try {
		envelopeJson = new TextDecoder("utf-8", { fatal: true }).decode(
			await boundedResponseBytes(response, "AutoBot release channel"),
		);
	} catch (error) {
		if (error instanceof AutoBotTransportError) throw error;
		throw new Error("AutoBot release channel is not valid UTF-8 JSON", { cause: error });
	}
	return verifyAutoBotReleaseEnvelope(checkedConfig, envelopeJson);
}

async function writeChunk(file: fs.FileHandle, chunk: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < chunk.byteLength) {
		const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
		if (bytesWritten <= 0) throw new Error("AutoBot artifact write made no progress");
		offset += bytesWritten;
	}
}

/** Download one signed asset with bounded streaming size and SHA-256 verification. */
export async function downloadVerifiedAutoBotAsset(input: {
	readonly asset: AutoBotReleaseAsset;
	readonly destinationPath: string;
	readonly allowedOrigins: Readonly<Record<string, true>>;
	readonly deps?: AutoBotFetchDeps;
}): Promise<void> {
	const { asset, destinationPath, allowedOrigins } = input;
	const tempPath = `${destinationPath}.${process.pid}.${crypto.randomUUID()}.part`;
	await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
	try {
		const response = await fetchApproved(
			asset.url,
			allowedOrigins,
			`AutoBot ${asset.kind} asset`,
			ARTIFACT_TIMEOUT_MS,
			input.deps?.fetchImpl ?? fetch,
		);
		let responseConsumed = false;
		try {
			const body = response.body;
			if (!body) throw new Error(`AutoBot ${asset.kind} asset has no response body`);
			const contentLength = response.headers.get("content-length");
			if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) !== asset.size)) {
				throw new Error(`AutoBot ${asset.kind} asset content length does not match signed size`);
			}
			const output = await fs.open(tempPath, "wx", 0o600);
			const hash = createHash("sha256");
			let size = 0;
			try {
				const reader = openResponseReader(body, `AutoBot ${asset.kind} asset`);
				let streamCompleted = false;
				try {
					while (true) {
						let result: ReadableStreamReadResult<Uint8Array>;
						try {
							result = await reader.read();
						} catch {
							throw new AutoBotTransportError(`AutoBot ${asset.kind} asset response stream failed`);
						}
						if (result.done) {
							streamCompleted = true;
							break;
						}
						const value = result.value;
						size += value.byteLength;
						if (size > asset.size) throw new Error(`AutoBot ${asset.kind} asset exceeds signed size`);
						hash.update(value);
						await writeChunk(output, value);
					}
				} finally {
					if (!streamCompleted) await reader.cancel().catch(() => undefined);
					try {
						reader.releaseLock();
					} catch {}
				}
			} finally {
				await output.close();
			}
			if (size !== asset.size) throw new Error(`AutoBot ${asset.kind} asset size does not match signed size`);
			if (hash.digest("hex") !== asset.sha256)
				throw new Error(`AutoBot ${asset.kind} asset SHA-256 does not match signed digest`);
			if (process.platform !== "win32") await fs.chmod(tempPath, 0o755);
			await fs.rename(tempPath, destinationPath);
			responseConsumed = true;
		} finally {
			if (!responseConsumed) await discardResponseBody(response);
		}
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}
