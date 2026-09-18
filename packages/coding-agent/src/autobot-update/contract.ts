/**
 * Stable boundary shared by the AutoBot release producer, immutable bootstrap,
 * and the running coding-agent runtime. Keep this module dependency-free: the
 * release publisher imports it before the application bundle exists.
 */

/** Version of the signed release document understood by this bootstrap. */
export const AUTO_BOT_RELEASE_SCHEMA_VERSION = 1 as const;
/** Lowest bootstrap implementation accepted by the first signed channel. */
export const AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION = 1 as const;
/** Current persisted coding-agent session format (`CURRENT_SESSION_VERSION`). */
export const AUTO_BOT_SESSION_FORMAT_VERSION = 3 as const;
/** Current collaboration wire format (`COLLAB_PROTO`). */
export const AUTO_BOT_COLLAB_PROTOCOL_VERSION = 4 as const;
/** Version of the local bootstrap/runtime handoff protocol. */
export const AUTO_BOT_HANDOFF_PROTOCOL_VERSION = 1 as const;
/** Shared DB/settings/daemon IPC compatibility epoch emitted by the initial release. */
export const AUTO_BOT_COMPATIBILITY_EPOCH = 1 as const;
/** Dedicated successful handoff exit status. Ordinary process exits MUST NOT trigger a bootstrap respawn. */
export const AUTO_BOT_RESTART_EXIT_CODE = 75 as const;
/** Per-release collab-web compressed archive and expanded tar ceiling. */
export const AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Maximum non-manifest files in one collab-web inventory. */
export const AUTO_BOT_MAX_COLLAB_WEB_FILES = 20_000;
/** Largest UTF-8 `managed-bundle.json` accepted for collab-web. */
export const AUTO_BOT_MAX_COLLAB_WEB_INVENTORY_BYTES = 1024 * 1024;
/** Maximum UTF-8 path length for collab-web archive and inventory entries. */
export const AUTO_BOT_MAX_COLLAB_WEB_PATH_BYTES = 1024;
/** Structural archive member ceiling; aggregate collab-web output remains 64MiB. */
export const AUTO_BOT_MAX_COLLAB_WEB_FILE_BYTES = 2_147_483_647;
/** Maximum slash-separated segments in a collab-web archive or inventory path. */
export const AUTO_BOT_MAX_COLLAB_WEB_PATH_SEGMENTS = 4;
/** Archive headers plus synthesized directories, including the coordinator-counted archive root. */
export const AUTO_BOT_MAX_COLLAB_WEB_ARCHIVE_ENTRIES = 80_001;

const AUTO_BOT_COLLAB_WEB_SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const AUTO_BOT_COLLAB_WEB_ROOT_FILE = /^(?!managed-bundle\.json$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Exact regular-file namespace accepted for a signed collab-web bundle.
 * Hashed build output may live at the archive root; nested output is confined
 * to the two owned static trees.
 */
export function isAutoBotCollabWebFilePath(value: string): boolean {
	const segments = value.split("/");
	if (
		value.length > AUTO_BOT_MAX_COLLAB_WEB_PATH_BYTES ||
		segments.length > AUTO_BOT_MAX_COLLAB_WEB_PATH_SEGMENTS
	) {
		return false;
	}
	if (segments.length === 1) return AUTO_BOT_COLLAB_WEB_ROOT_FILE.test(value);
	return (
		(segments[0] === "assets" || segments[0] === "public") &&
		segments.slice(1).every(segment => AUTO_BOT_COLLAB_WEB_SAFE_PATH_SEGMENT.test(segment))
	);
}

/** Directory entries may describe only the archive root or the two owned static trees. */
export function isAutoBotCollabWebDirectoryPath(value: string): boolean {
	if (value === "") return true;
	const segments = value.split("/");
	return (
		value.length <= AUTO_BOT_MAX_COLLAB_WEB_PATH_BYTES &&
		segments.length <= AUTO_BOT_MAX_COLLAB_WEB_PATH_SEGMENTS &&
		(segments[0] === "assets" || segments[0] === "public") &&
		segments.every(segment => AUTO_BOT_COLLAB_WEB_SAFE_PATH_SEGMENT.test(segment))
	);
}

/**
 * Paths whose changes can alter shared state, daemon IPC, or collaboration
 * coexistence. Release automation must require human review when any matches;
 * increment `compatibilityEpoch` only for an explicitly-maintained migration.
 */
export function autoBotPathRequiresCompatibilityReview(repositoryPath: string): boolean {
	return (
		repositoryPath === "packages/coding-agent/src/config.ts" ||
		repositoryPath === "packages/coding-agent/src/autobot-runtime.ts" ||
		repositoryPath === "packages/coding-agent/src/autobot-bootstrap.ts" ||
		repositoryPath === "packages/coding-agent/src/autobot-update/contract.ts" ||
		repositoryPath.startsWith("packages/coding-agent/src/autobot-update/") ||
		repositoryPath.startsWith("packages/coding-agent/src/session/") ||
		repositoryPath.startsWith("packages/coding-agent/src/config/") ||
		repositoryPath.startsWith("packages/coding-agent/src/launch/") ||
		repositoryPath.startsWith("packages/coding-agent/src/blob-broker/") ||
		repositoryPath.startsWith("packages/coding-agent/src/collab/") ||
		repositoryPath.startsWith("packages/omp-session-coordinator/")
	);
}

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type AutoBotReleaseAssetKind = "bootstrap" | "collab-web" | "coordinator-client" | "runtime";

export interface AutoBotReleaseAsset {
	readonly kind: AutoBotReleaseAssetKind;
	/** Platform or logical target, for example `win32-x64` or `web`. */
	readonly target: string;
	/** HTTPS source URL. The channel verifier applies its origin allowlist too. */
	readonly url: string;
	readonly size: number;
	/** Lowercase hexadecimal SHA-256 of the downloaded bytes. */
	readonly sha256: string;
}

/** The exact UTF-8 JSON document covered by an Ed25519 signature. */
export interface AutoBotReleaseManifest {
	readonly schemaVersion: typeof AUTO_BOT_RELEASE_SCHEMA_VERSION;
	readonly releaseSequence: number;
	readonly upstreamVersion: string;
	readonly forkCommit: string;
	readonly upstreamCommit: string;
	/** Canonical ISO-8601 UTC timestamp (`Date#toISOString()`). */
	readonly publishedAt: string;
	readonly minimumBootstrapVersion: typeof AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION;
	readonly sessionFormatVersion: typeof AUTO_BOT_SESSION_FORMAT_VERSION;
	readonly collabProtocolVersion: typeof AUTO_BOT_COLLAB_PROTOCOL_VERSION;
	/** Shared state and daemon IPC coexistence epoch, independent of session JSONL format. */
	readonly compatibilityEpoch: number;
	readonly assets: readonly AutoBotReleaseAsset[];
	readonly webBundleId: string;
}

/** Detached envelope: `signature` is a base64-encoded 64-byte Ed25519 signature over `payload` UTF-8 bytes. */
export interface SignedAutoBotReleaseEnvelope {
	readonly payload: string;
	readonly signature: string;
	readonly keyId: string;
}

/**
 * Compatibility facts exposed to the live runtime before it decides whether a
 * session can safely move to a staged release. File-system slot paths stay in
 * the supervisor so a runtime never chooses an executable itself.
 */
export interface AutoBotLaunchRelease {
	readonly releaseSequence: number;
	readonly upstreamVersion: string;
	readonly forkCommit: string;
	readonly sessionFormatVersion: typeof AUTO_BOT_SESSION_FORMAT_VERSION;
	readonly collabProtocolVersion: typeof AUTO_BOT_COLLAB_PROTOCOL_VERSION;
	readonly compatibilityEpoch: number;
	readonly webBundleId: string;
}

export interface AutoBotRestartTarget extends AutoBotLaunchRelease {
	/** Reservation lifetime requested before the predecessor is stopped. */
	readonly handoffBudgetMs: number;
}

/** Durable state the runtime prepares only while it is idle and safe to restart. */
export interface PreparedAutoBotRestart {
	readonly sessionFile: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly profile?: string;
	readonly context: JsonValue;
	/** Server timestamp for diagnostics only; clients MUST NOT subtract their wall clock from it. */
	readonly expiresAt?: string;
	/** Server-issued reservation duration anchored at this predecessor's local monotonic receipt time. */
	readonly leaseDurationMs?: number;
	/** Broker-minted claimant identity reserved exclusively for an old-build fallback. */
	readonly fallbackInstanceId?: string;
}

/**
 * Exact restart capability bound into the bootstrap handoff record and the
 * replacement runtime's ready acknowledgement.
 */
export interface AutoBotRestartRequest extends PreparedAutoBotRestart {
	/** New signed target for the normal candidate; fallback handoffs replace this with `predecessorTarget`. */
	readonly target: AutoBotRestartTarget;
	/** Immutable active-release snapshot captured by the supervisor before predecessor teardown. */
	readonly predecessorTarget: AutoBotRestartTarget;
	/** Cryptographically random base64url capability minted by the supervisor. */
	readonly nonce: string;
}

/**
 * Immutable bootstrap-parent binding sealed into a handoff. `launchId` names
 * the bootstrap lifetime lease; process IDs bind the exact parent/child launch.
 */
export interface AutoBotHandoffOwner {
	readonly launchId: string;
	readonly bootstrapProcessId: number;
	readonly predecessorRuntimeProcessId: number;
}

/** Mutable bootstrap claimant for a sealed handoff after verified orphan recovery. */
export interface AutoBotHandoffClaim {
	readonly launchId: string;
	readonly bootstrapProcessId: number;
}

/**
 * Runtime-owned safety boundary. Returning undefined defers the update.
 * `abortRestart` is invoked only before activation is durably sent, reopening
 * a prepared admission fence when the supervisor cannot complete handoff.
 * After activation is sent, an absent acknowledgement is indeterminate and
 * MUST NOT trigger a fallback or abort.
 */
export interface AutoBotUpdateHooks {
	/** Nonmutating early admission; `prepareRestart` MUST repeat every safety check late. */
	canPrepareRestart(
		target: AutoBotRestartTarget,
		predecessorTarget: AutoBotRestartTarget,
	): Promise<boolean>;
	prepareRestart(
		target: AutoBotRestartTarget,
		predecessorTarget: AutoBotRestartTarget,
	): Promise<PreparedAutoBotRestart | undefined>;
	commitRestart(request: AutoBotRestartRequest): Promise<void>;
	abortRestart?(request: AutoBotRestartRequest, reason: AutoBotRestartAbortReason): Promise<void>;
	/** Must restore exact broker/browser predecessor ownership before fallback accepts work. */
	restorePredecessorFallback?(fallback: AutoBotPredecessorFallback): Promise<void>;
}

export type AutoBotRestartAbortReason =
	| "candidate-ready-timeout"
	| "candidate-exited"
	| "candidate-rejected"
	| "handoff-invalid"
	| "handoff-write-failed"
	| "handoff-contended";


/** Protected old-build restoration after the new candidate fails before activation. */
export interface AutoBotPredecessorFallback {
	/** `request.target` is the exact recorded predecessor target, never the failed candidate target. */
	readonly request: AutoBotRestartRequest;
	/** Failed candidate target retained for audit/broker reservation correlation. */
	readonly attemptedTarget: AutoBotRestartTarget;
}
/**
 * Successor-only control surface. The successor restores and checks its exact
 * session before `signalReady`, then waits for explicit activation before
 * accepting any user work and acknowledges that activation afterwards.
 */
export interface AutoBotRestartCandidate {
	readonly request: AutoBotRestartRequest;
	signalReady(): Promise<void>;
	waitForActivation(): Promise<void>;
	acknowledgeActivation(): Promise<void>;
	reject(reason: string): Promise<void>;
}

export interface AutoBotUpdateHandle {
	dispose(): void;
	readonly candidate?: AutoBotRestartCandidate;
	/** Resolves after any required fallback admission fence has been reopened. */
	readonly startup?: Promise<void>;
}

/** On-disk handoff payload written by the supervisor for its stable bootstrap. */
export interface AutoBotHandoffRecord extends AutoBotRestartRequest {
	readonly protocolVersion: typeof AUTO_BOT_HANDOFF_PROTOCOL_VERSION;
	/** Immutable bootstrap/runtime launch binding for this handoff's origin. */
	readonly owner: AutoBotHandoffOwner;
	/** A fallback starts only the immutable recorded predecessor. */
	readonly role: "candidate" | "fallback";
	/** Present only for role=fallback; identifies the rejected new candidate target. */
	readonly attemptedTarget?: AutoBotRestartTarget;
	readonly runtimePath: string;
	readonly previousRuntimePath: string;
	readonly createdAt: string;
}

/** Ready acknowledgement sent by a replacement runtime through the bootstrap. */
export interface AutoBotRuntimeReady {
	readonly protocolVersion: typeof AUTO_BOT_HANDOFF_PROTOCOL_VERSION;
	readonly nonce: string;
	readonly releaseSequence: number;
	readonly compatibilityEpoch: number;
	readonly sessionFile: string;
	readonly sessionId: string;
}

const ASSET_KINDS: Record<AutoBotReleaseAssetKind, true> = {
	bootstrap: true,
	"collab-web": true,
	"coordinator-client": true,
	runtime: true,
};
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
const SAFE_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UPSTREAM_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const CANONICAL_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_RELEASE_PAYLOAD_BYTES = 1_000_000;

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, name: string, keys: readonly string[]): void {
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) throw new Error(`${name} has an unsupported field: ${key}`);
	}
}

function requiredString(value: unknown, name: string, pattern?: RegExp): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
	if (pattern && !pattern.test(value)) throw new Error(`${name} has an invalid format`);
	return value;
}

function boundedString(value: unknown, name: string, maxLength: number, pattern?: RegExp): string {
	const string = requiredString(value, name, pattern);
	if (string.length > maxLength) throw new Error(`${name} exceeds the maximum length`);
	return string;
}

function positiveSafeInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return value;
}

function parseAsset(value: unknown): AutoBotReleaseAsset {
	const asset = record(value, "release asset");
	onlyKeys(asset, "release asset", ["kind", "target", "url", "size", "sha256"]);
	const kind = requiredString(asset.kind, "release asset.kind");
	if (ASSET_KINDS[kind as AutoBotReleaseAssetKind] !== true) throw new Error("release asset.kind is unsupported");
	const url = boundedString(asset.url, "release asset.url", 2_048);
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new Error("release asset.url must be an HTTPS URL");
	}
	if (
		parsedUrl.protocol !== "https:" ||
		!parsedUrl.hostname ||
		parsedUrl.username ||
		parsedUrl.password ||
		parsedUrl.hash
	) {
		throw new Error("release asset.url must be an HTTPS URL without credentials or fragments");
	}
	return {
		kind: kind as AutoBotReleaseAssetKind,
		target: boundedString(asset.target, "release asset.target", 128, SAFE_TARGET_PATTERN),
		url,
		size: positiveSafeInteger(asset.size, "release asset.size"),
		sha256: requiredString(asset.sha256, "release asset.sha256", SHA256_PATTERN),
	};
}

/** Validate a decoded release document before use or signing. */
export function parseAutoBotReleaseManifest(value: unknown): AutoBotReleaseManifest {
	const manifest = record(value, "release manifest");
	onlyKeys(manifest, "release manifest", [
		"schemaVersion",
		"releaseSequence",
		"upstreamVersion",
		"forkCommit",
		"upstreamCommit",
		"publishedAt",
		"minimumBootstrapVersion",
		"sessionFormatVersion",
		"collabProtocolVersion",
		"compatibilityEpoch",
		"assets",
		"webBundleId",
	]);
	if (manifest.schemaVersion !== AUTO_BOT_RELEASE_SCHEMA_VERSION) {
		throw new Error(`Unsupported release schema version: ${String(manifest.schemaVersion)}`);
	}
	if (manifest.minimumBootstrapVersion !== AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION) {
		throw new Error(`Unsupported minimum bootstrap version: ${String(manifest.minimumBootstrapVersion)}`);
	}
	if (manifest.sessionFormatVersion !== AUTO_BOT_SESSION_FORMAT_VERSION) {
		throw new Error(`Unsupported session format version: ${String(manifest.sessionFormatVersion)}`);
	}
	if (manifest.collabProtocolVersion !== AUTO_BOT_COLLAB_PROTOCOL_VERSION) {
		throw new Error(`Unsupported collaboration protocol version: ${String(manifest.collabProtocolVersion)}`);
	}
	const publishedAt = requiredString(manifest.publishedAt, "release manifest.publishedAt", CANONICAL_ISO_TIMESTAMP_PATTERN);
	if (new Date(publishedAt).toISOString() !== publishedAt) {
		throw new Error("release manifest.publishedAt must be a canonical ISO-8601 UTC timestamp");
	}
	if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
		throw new Error("release manifest.assets must be a non-empty array");
	}
	const assets = manifest.assets.map(parseAsset);
	const identities = new Set<string>();
	for (const asset of assets) {
		const identity = `${asset.kind}\u0000${asset.target}`;
		if (identities.has(identity)) throw new Error(`release manifest contains duplicate asset ${asset.kind}/${asset.target}`);
		identities.add(identity);
	}
	return {
		schemaVersion: AUTO_BOT_RELEASE_SCHEMA_VERSION,
		releaseSequence: positiveSafeInteger(manifest.releaseSequence, "release manifest.releaseSequence"),
		upstreamVersion: boundedString(manifest.upstreamVersion, "release manifest.upstreamVersion", 128, UPSTREAM_VERSION_PATTERN),
		forkCommit: boundedString(manifest.forkCommit, "release manifest.forkCommit", 64, FULL_COMMIT_PATTERN),
		upstreamCommit: boundedString(manifest.upstreamCommit, "release manifest.upstreamCommit", 64, FULL_COMMIT_PATTERN),
		publishedAt,
		minimumBootstrapVersion: AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: positiveSafeInteger(manifest.compatibilityEpoch, "release manifest.compatibilityEpoch"),
		assets,
		webBundleId: boundedString(manifest.webBundleId, "release manifest.webBundleId", 96, SAFE_IDENTIFIER_PATTERN),
	};
}

/**
 * Canonical producer serializer. Sign the returned string's UTF-8 bytes without
 * parsing or reserializing it again.
 */
export function serializeAutoBotReleaseManifest(value: AutoBotReleaseManifest): string {
	const manifest = parseAutoBotReleaseManifest(value);
	return JSON.stringify({
		schemaVersion: manifest.schemaVersion,
		releaseSequence: manifest.releaseSequence,
		upstreamVersion: manifest.upstreamVersion,
		forkCommit: manifest.forkCommit,
		upstreamCommit: manifest.upstreamCommit,
		publishedAt: manifest.publishedAt,
		minimumBootstrapVersion: manifest.minimumBootstrapVersion,
		sessionFormatVersion: manifest.sessionFormatVersion,
		collabProtocolVersion: manifest.collabProtocolVersion,
		compatibilityEpoch: manifest.compatibilityEpoch,
		assets: manifest.assets.map(asset => ({
			kind: asset.kind,
			target: asset.target,
			url: asset.url,
			size: asset.size,
			sha256: asset.sha256,
		})),
		webBundleId: manifest.webBundleId,
	});
}

/** Parse an exact signed payload after signature verification has succeeded. */
export function parseAutoBotReleasePayload(payload: string): AutoBotReleaseManifest {
	if (new TextEncoder().encode(payload).byteLength > MAX_RELEASE_PAYLOAD_BYTES) {
		throw new Error("Signed release payload exceeds the maximum size");
	}
	try {
		return parseAutoBotReleaseManifest(JSON.parse(payload));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error("Signed release payload is not valid JSON", { cause: error });
		throw error;
	}
}

/** Validate the unsigned envelope shape before looking up a trusted signing key. */
export function parseSignedAutoBotReleaseEnvelope(value: unknown): SignedAutoBotReleaseEnvelope {
	const envelope = record(value, "signed release envelope");
	onlyKeys(envelope, "signed release envelope", ["payload", "signature", "keyId"]);
	const payload = requiredString(envelope.payload, "signed release envelope.payload");
	if (new TextEncoder().encode(payload).byteLength > MAX_RELEASE_PAYLOAD_BYTES) {
		throw new Error("Signed release payload exceeds the maximum size");
	}
	const signature = requiredString(envelope.signature, "signed release envelope.signature");
	let signatureBytes: Uint8Array;
	try {
		signatureBytes = Uint8Array.fromBase64(signature);
	} catch {
		throw new Error("signed release envelope.signature must be base64");
	}
	if (signatureBytes.byteLength !== 64) throw new Error("signed release envelope.signature must be an Ed25519 signature");
	return {
		payload,
		signature,
		keyId: boundedString(envelope.keyId, "signed release envelope.keyId", 96, SAFE_IDENTIFIER_PATTERN),
	};
}

/** Verify that a runtime-supplied value can be losslessly encoded in a handoff JSON file. */
export function assertJsonValue(value: unknown): asserts value is JsonValue {
	const seen = new WeakSet<object>();
	const visit = (candidate: unknown, depth: number): void => {
		if (depth > 64) throw new Error("Restart context is nested too deeply");
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate)) throw new Error("Restart context contains a non-finite number");
			return;
		}
		if (typeof candidate !== "object") throw new Error("Restart context contains a non-JSON value");
		if (seen.has(candidate)) throw new Error("Restart context contains a cycle");
		seen.add(candidate);
		if (Array.isArray(candidate)) {
			for (let index = 0; index < candidate.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
				if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
					throw new Error("Restart context contains a sparse array or accessor");
				}
				visit(descriptor.value, depth + 1);
			}
			for (const key of Reflect.ownKeys(candidate)) {
				if (key === "length") continue;
				if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= candidate.length) {
					throw new Error("Restart context array contains a non-index property");
				}
			}
			return;
		}
		const prototype = Object.getPrototypeOf(candidate);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("Restart context contains a non-plain object");
		}
		for (const key of Reflect.ownKeys(candidate)) {
			if (typeof key !== "string") throw new Error("Restart context contains a symbol key");
			if (key === "__proto__" || key === "constructor" || key === "prototype") {
				throw new Error("Restart context contains a reserved object key");
			}
			const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
			if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
				throw new Error("Restart context contains a non-enumerable property or accessor");
			}
			visit(descriptor.value, depth + 1);
		}
	};
	visit(value, 0);
}

function parseAutoBotLaunchReleaseFields(
	release: Record<string, unknown>,
	name: string,
): AutoBotLaunchRelease {
	if (release.sessionFormatVersion !== AUTO_BOT_SESSION_FORMAT_VERSION) {
		throw new Error(`${name} has an unsupported session format version`);
	}
	if (release.collabProtocolVersion !== AUTO_BOT_COLLAB_PROTOCOL_VERSION) {
		throw new Error(`${name} has an unsupported collaboration protocol version`);
	}
	if (release.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH) {
		throw new Error(`${name} has an incompatible shared-state epoch`);
	}
	return {
		releaseSequence: positiveSafeInteger(release.releaseSequence, `${name}.releaseSequence`),
		upstreamVersion: boundedString(release.upstreamVersion, `${name}.upstreamVersion`, 128, UPSTREAM_VERSION_PATTERN),
		forkCommit: boundedString(release.forkCommit, `${name}.forkCommit`, 64, FULL_COMMIT_PATTERN),
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		webBundleId: boundedString(release.webBundleId, `${name}.webBundleId`, 96, SAFE_IDENTIFIER_PATTERN),
	};
}

/** Validate immutable release facts supplied by the authenticated bootstrap launch. */
export function parseAutoBotLaunchRelease(value: unknown): AutoBotLaunchRelease {
	const release = record(value, "launch release");
	onlyKeys(release, "launch release", [
		"releaseSequence",
		"upstreamVersion",
		"forkCommit",
		"sessionFormatVersion",
		"collabProtocolVersion",
		"compatibilityEpoch",
		"webBundleId",
	]);
	return parseAutoBotLaunchReleaseFields(release, "launch release");
}

export function parseAutoBotRestartTarget(value: unknown): AutoBotRestartTarget {
	const target = record(value, "restart target");
	onlyKeys(target, "restart target", [
		"releaseSequence",
		"upstreamVersion",
		"forkCommit",
		"sessionFormatVersion",
		"collabProtocolVersion",
		"compatibilityEpoch",
		"webBundleId",
		"handoffBudgetMs",
	]);
	const handoffBudgetMs = positiveSafeInteger(target.handoffBudgetMs, "restart target.handoffBudgetMs");
	if (handoffBudgetMs < 30_000 || handoffBudgetMs > 390_000) {
		throw new Error("restart target.handoffBudgetMs is outside the safe range");
	}
	return { ...parseAutoBotLaunchReleaseFields(target, "restart target"), handoffBudgetMs };
}

export function sameAutoBotRestartTarget(left: AutoBotRestartTarget, right: AutoBotRestartTarget): boolean {
	return (
		left.releaseSequence === right.releaseSequence &&
		left.upstreamVersion === right.upstreamVersion &&
		left.forkCommit === right.forkCommit &&
		left.sessionFormatVersion === right.sessionFormatVersion &&
		left.collabProtocolVersion === right.collabProtocolVersion &&
		left.compatibilityEpoch === right.compatibilityEpoch &&
		left.webBundleId === right.webBundleId &&
		left.handoffBudgetMs === right.handoffBudgetMs
	);
}

function parseLaunchId(value: unknown, name: string): string {
	const launchId = boundedString(value, name, 128, SAFE_IDENTIFIER_PATTERN);
	if (launchId.length < 32) throw new Error(`${name} is too short`);
	return launchId;
}

/** Validate the immutable origin binding sealed into a bootstrap handoff. */
export function parseAutoBotHandoffOwner(value: unknown): AutoBotHandoffOwner {
	const owner = record(value, "restart handoff owner");
	onlyKeys(owner, "restart handoff owner", ["launchId", "bootstrapProcessId", "predecessorRuntimeProcessId"]);
	return {
		launchId: parseLaunchId(owner.launchId, "restart handoff owner.launchId"),
		bootstrapProcessId: positiveSafeInteger(owner.bootstrapProcessId, "restart handoff owner.bootstrapProcessId"),
		predecessorRuntimeProcessId: positiveSafeInteger(
			owner.predecessorRuntimeProcessId,
			"restart handoff owner.predecessorRuntimeProcessId",
		),
	};
}

/** Validate the current bootstrap claimant for a sealed handoff. */
export function parseAutoBotHandoffClaim(value: unknown): AutoBotHandoffClaim {
	const claim = record(value, "restart handoff claim");
	onlyKeys(claim, "restart handoff claim", ["launchId", "bootstrapProcessId"]);
	return {
		launchId: parseLaunchId(claim.launchId, "restart handoff claim.launchId"),
		bootstrapProcessId: positiveSafeInteger(claim.bootstrapProcessId, "restart handoff claim.bootstrapProcessId"),
	};
}

function parseRestartRequestFields(value: Record<string, unknown>, name: string): AutoBotRestartRequest {
	const profile = value.profile;
	const expiresAt = value.expiresAt;
	const leaseDurationMs = value.leaseDurationMs;
	const fallbackInstanceId = value.fallbackInstanceId;
	const context = value.context;
	if (profile !== undefined) boundedString(profile, `${name}.profile`, 256);
	if (expiresAt !== undefined) {
		const timestamp = requiredString(expiresAt, `${name}.expiresAt`, CANONICAL_ISO_TIMESTAMP_PATTERN);
		if (new Date(timestamp).toISOString() !== timestamp) throw new Error(`${name}.expiresAt must be canonical UTC`);
	}
	if (leaseDurationMs !== undefined) positiveSafeInteger(leaseDurationMs, `${name}.leaseDurationMs`);
	if (expiresAt !== undefined && leaseDurationMs === undefined) {
		throw new Error(`${name}.leaseDurationMs is required with a coordinator expiry`);
	}
	if (fallbackInstanceId !== undefined) {
		boundedString(fallbackInstanceId, `${name}.fallbackInstanceId`, 128, SAFE_IDENTIFIER_PATTERN);
	}
	if (expiresAt !== undefined && fallbackInstanceId === undefined) {
		throw new Error(`${name}.fallbackInstanceId is required with a coordinator expiry`);
	}
	assertJsonValue(context);
	return {
		sessionFile: boundedString(value.sessionFile, `${name}.sessionFile`, 4_096),
		sessionId: boundedString(value.sessionId, `${name}.sessionId`, 256, SAFE_IDENTIFIER_PATTERN),
		cwd: boundedString(value.cwd, `${name}.cwd`, 4_096),
		...(profile === undefined ? {} : { profile: profile as string }),
		...(expiresAt === undefined ? {} : { expiresAt: expiresAt as string }),
		...(leaseDurationMs === undefined ? {} : { leaseDurationMs: leaseDurationMs as number }),
		...(fallbackInstanceId === undefined ? {} : { fallbackInstanceId: fallbackInstanceId as string }),
		context,
		target: parseAutoBotRestartTarget(value.target),
		predecessorTarget: parseAutoBotRestartTarget(value.predecessorTarget),
		nonce: boundedString(value.nonce, `${name}.nonce`, 128, SAFE_IDENTIFIER_PATTERN),
	};
}

/** Validate an exact restart request before writing or accepting a handoff. */
export function parseAutoBotRestartRequest(value: unknown): AutoBotRestartRequest {
	const request = record(value, "restart request");
	onlyKeys(request, "restart request", [
		"sessionFile",
		"sessionId",
		"cwd",
		"profile",
		"expiresAt",
		"leaseDurationMs",
		"fallbackInstanceId",
		"context",
		"target",
		"predecessorTarget",
		"nonce",
	]);
	return parseRestartRequestFields(request, "restart request");
}

/** Validate the durable bootstrap handoff record. */
export function parseAutoBotHandoffRecord(value: unknown): AutoBotHandoffRecord {
	const handoff = record(value, "restart handoff");
	onlyKeys(handoff, "restart handoff", [
		"sessionFile",
		"sessionId",
		"cwd",
		"profile",
		"expiresAt",
		"leaseDurationMs",
		"fallbackInstanceId",
		"context",
		"target",
		"predecessorTarget",
		"nonce",
		"owner",
		"protocolVersion",
		"role",
		"attemptedTarget",
		"runtimePath",
		"previousRuntimePath",
		"createdAt",
	]);
	if (handoff.protocolVersion !== AUTO_BOT_HANDOFF_PROTOCOL_VERSION) throw new Error("restart handoff has an unsupported protocol");
	if (handoff.role !== "candidate" && handoff.role !== "fallback") throw new Error("restart handoff has an invalid role");
	const request = parseRestartRequestFields(handoff, "restart handoff");
	const attemptedTarget = handoff.attemptedTarget === undefined ? undefined : parseAutoBotRestartTarget(handoff.attemptedTarget);
	if (handoff.role === "candidate" && attemptedTarget !== undefined) {
		throw new Error("Candidate handoff must not include an attempted target");
	}
	if (handoff.role === "fallback") {
		if (!attemptedTarget || !sameAutoBotRestartTarget(request.target, request.predecessorTarget)) {
			throw new Error("Fallback handoff does not target its recorded predecessor");
		}
		if (sameAutoBotRestartTarget(attemptedTarget, request.target)) {
			throw new Error("Fallback handoff attempted target must differ from its predecessor");
		}
		if (request.expiresAt !== undefined && request.fallbackInstanceId === undefined) {
			throw new Error("Broker-backed fallback handoff has no reserved fallback instance");
		}
	}
	const createdAt = requiredString(handoff.createdAt, "restart handoff.createdAt", CANONICAL_ISO_TIMESTAMP_PATTERN);
	if (new Date(createdAt).toISOString() !== createdAt) throw new Error("restart handoff.createdAt must be canonical UTC");
	return {
		...request,
		owner: parseAutoBotHandoffOwner(handoff.owner),
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		role: handoff.role,
		...(attemptedTarget === undefined ? {} : { attemptedTarget }),
		runtimePath: boundedString(handoff.runtimePath, "restart handoff.runtimePath", 4_096),
		previousRuntimePath: boundedString(handoff.previousRuntimePath, "restart handoff.previousRuntimePath", 4_096),
		createdAt,
	};
}

/** Validate a successor's protected ready acknowledgement. */
export function parseAutoBotRuntimeReady(value: unknown): AutoBotRuntimeReady {
	const ready = record(value, "restart ready acknowledgement");
	onlyKeys(ready, "restart ready acknowledgement", [
		"protocolVersion",
		"nonce",
		"releaseSequence",
		"compatibilityEpoch",
		"sessionFile",
		"sessionId",
	]);
	if (ready.protocolVersion !== AUTO_BOT_HANDOFF_PROTOCOL_VERSION) {
		throw new Error("restart ready acknowledgement has an unsupported protocol");
	}
	if (ready.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH) {
		throw new Error("restart ready acknowledgement has an incompatible shared-state epoch");
	}
	return {
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		nonce: boundedString(ready.nonce, "restart ready acknowledgement.nonce", 128, SAFE_IDENTIFIER_PATTERN),
		releaseSequence: positiveSafeInteger(ready.releaseSequence, "restart ready acknowledgement.releaseSequence"),
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		sessionFile: boundedString(ready.sessionFile, "restart ready acknowledgement.sessionFile", 4_096),
		sessionId: boundedString(ready.sessionId, "restart ready acknowledgement.sessionId", 512),
	};
}
