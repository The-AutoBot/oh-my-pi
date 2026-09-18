import type { CollabRestartBlockReason } from "@oh-my-pi/pi-wire";
import { isRecord } from "./type-guards";

const STORAGE_PREFIX = "omp.collab.restart-drafts.v1.";
const STORAGE_INDEX_SUFFIX = ".index";
const RECORD_VERSION = 1;
const RECOVERY_TTL_MS = 5 * 60_000;
const MAX_PERSISTED_DRAFT_BYTES = 64 * 1024;
const HOST_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const INPUT_QUIET_MS = 750;

export type RestartDraftSurface =
	| { readonly kind: "composer" }
	| { readonly kind: "editor"; readonly reqId: number; readonly capabilityFingerprint: string }
	| { readonly kind: "agent-chat"; readonly agentId: string };

export interface RestartDraftScope {
	/** SHA-256 fingerprint only; no room capability or coordinator identity is stored. */
	readonly fingerprint: string;
	readonly sessionId: string;
}

export interface RestartDraftPreparation {
	readonly requestId: string;
	readonly sessionId: string;
	readonly leaseMs: number;
}

export type RestartDraftPreparationResult =
	| { readonly status: "ready" }
	| { readonly status: "blocked"; readonly reason: CollabRestartBlockReason };

export interface RestartDraftStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

interface StoredDraft {
	readonly surface: RestartDraftSurface;
	readonly text: string;
}

interface StoredRecord {
	readonly version: typeof RECORD_VERSION;
	readonly fingerprint: string;
	readonly sessionId: string;
	readonly recordId: string;
	readonly requestId: string | null;
	readonly recoverUntilMs: number;
	readonly drafts: readonly StoredDraft[];
}

interface StoredIndex {
	readonly version: typeof RECORD_VERSION;
	readonly fingerprint: string;
	readonly sessionId: string;
	readonly recordId: string;
	readonly recoverUntilMs: number;
}

/** Hashes a manual room capability in memory before it is used as a draft scope. */
export async function createManualDraftScope(link: string, sessionId: string): Promise<RestartDraftScope | null> {
	if (!validSessionId(sessionId) || link.length === 0 || link.length > 16_384) return null;
	const fingerprint = await sha256Fingerprint(`manual\u0000${link}\u0000${sessionId}`);
	return fingerprint ? { fingerprint, sessionId } : null;
}

/** Only call this after authenticated managed-session discovery confirmed the route and capability. */
export async function createManagedDraftScope(
	pcId: string,
	sessionId: string,
): Promise<RestartDraftScope | null> {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(pcId) || !validSessionId(sessionId)) return null;
	const fingerprint = await sha256Fingerprint(`managed\u0000${pcId}\u0000${sessionId}`);
	return fingerprint ? { fingerprint, sessionId } : null;
}

/** Hashes the current host capability in memory to distinguish editor request generations. */
export async function createEditorDraftCapabilityFingerprint(link: string): Promise<string | null> {
	if (link.length === 0 || link.length > 16_384) return null;
	return sha256Fingerprint(`editor-capability\u0000${link}`);
}

/**
 * Session-scoped, browser-local draft registry. It persists each accepted edit
 * synchronously so an acknowledged restart cannot make later text disappear.
 * No draft leaves this object or local browser storage.
 */
export class RestartDraftRegistry {
	readonly #storage: RestartDraftStorage | null;
	readonly #now: () => number;
	readonly #monotonicNow: () => number;
	readonly #listeners = new Set<() => void>();
	readonly #drafts = new Map<string, StoredDraft>();
	readonly #composing = new Set<string>();
	readonly #recentInputAt = new Map<string, number>();
	#scope: RestartDraftScope | undefined;
	#localRecordId = newLocalRecordId();
	#activeRequestId: string | undefined;
	#persistenceFailed = false;

	constructor(
		storage: RestartDraftStorage | null = browserStorage(),
		now: () => number = () => Date.now(),
		monotonicNow: () => number = () => performance.now(),
	) {
		this.#storage = storage;
		this.#now = now;
		this.#monotonicNow = monotonicNow;
	}

	get dirty(): boolean {
		return this.#drafts.size > 0;
	}

	get persistenceFailed(): boolean {
		return this.#persistenceFailed;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setScope(scope: RestartDraftScope | undefined): void {
		if (
			this.#scope?.fingerprint === scope?.fingerprint &&
			this.#scope?.sessionId === scope?.sessionId
		)
			return;
		this.#scope = scope;
		this.#drafts.clear();
		this.#composing.clear();
		this.#recentInputAt.clear();
		this.#activeRequestId = undefined;
		this.#localRecordId = newLocalRecordId();
		this.#persistenceFailed = false;
		this.#notify();
	}

	get(surface: RestartDraftSurface): string | undefined {
		return this.#drafts.get(surfaceKey(surface))?.text;
	}

	/** Keeps the visible edit even if local storage is full; callers must defer reload on false. */
	set(surface: RestartDraftSurface, text: string): boolean {
		const key = surfaceKey(surface);
		if (text.length === 0) this.#drafts.delete(key);
		else this.#drafts.set(key, { surface, text });
		const persisted = this.#persistCurrent();
		this.#persistenceFailed = !persisted;
		this.#notify();
		return persisted;
	}

	clear(surface: RestartDraftSurface): boolean {
		return this.set(surface, "");
	}

	/** Records a user edit before its synchronous persistence attempt. */
	noteInput(surface: RestartDraftSurface): void {
		this.#recentInputAt.set(surfaceKey(surface), this.#monotonicNow());
	}

	setComposing(surface: RestartDraftSurface, composing: boolean): void {
		const key = surfaceKey(surface);
		if (composing) this.#composing.add(key);
		else this.#composing.delete(key);
	}

	/**
	 * Restore only after the caller established the scope independently of
	 * host-provided session data. Editor records must also match this exact
	 * hashed capability generation, so a replacement host cannot reuse reqIds.
	 */
	restore(scope: RestartDraftScope, editorCapabilityFingerprint: string): boolean {
		if (this.#scope?.fingerprint !== scope.fingerprint || this.#scope.sessionId !== scope.sessionId) return false;
		const storage = this.#storage;
		if (!storage || !isCapabilityFingerprint(editorCapabilityFingerprint)) return false;
		try {
			const index = parseIndex(storage.getItem(indexKey(scope)));
			if (!index || !matchesScope(index, scope) || index.recoverUntilMs <= this.#now()) {
				if (index) this.#removeScopeRecord(index, scope);
				return false;
			}
			const record = parseRecord(storage.getItem(recordKey(scope, index.recordId)));
			if (!record || !matchesScope(record, scope) || record.recordId !== index.recordId || record.recoverUntilMs <= this.#now()) {
				this.#removeScopeRecord(index, scope);
				return false;
			}
			this.#drafts.clear();
			for (const draft of record.drafts) {
				if (
					draft.surface.kind === "editor" &&
					draft.surface.capabilityFingerprint !== editorCapabilityFingerprint
				)
					continue;
				this.#drafts.set(surfaceKey(draft.surface), draft);
			}
			this.#localRecordId = record.recordId;
			this.#activeRequestId = record.requestId ?? undefined;
			this.#persistenceFailed = !this.#persistCurrent();
			this.#notify();
			return !this.#persistenceFailed;
		} catch {
			return false;
		}
	}

	prepare(request: RestartDraftPreparation): RestartDraftPreparationResult {
		const scope = this.#scope;
		if (
			!scope ||
			request.sessionId !== scope.sessionId ||
			!HOST_REQUEST_ID_PATTERN.test(request.requestId) ||
			!Number.isSafeInteger(request.leaseMs) ||
			request.leaseMs <= 0
		) {
			return { status: "blocked", reason: "unavailable" };
		}
		// An IME can commit its final character after compositionend. Do not ACK
		// a host reservation until that input has either persisted or gone quiet.
		if (this.#composing.size > 0 || this.#hasRecentInput()) {
			return { status: "blocked", reason: "reservation-conflict" };
		}
		const previousRequestId = this.#activeRequestId;
		this.#activeRequestId = request.requestId;
		const persisted = this.#persistCurrent();
		if (!persisted) {
			this.#activeRequestId = previousRequestId;
			this.#persistenceFailed = true;
			this.#notify();
			return { status: "blocked", reason: "draft-storage-unavailable" };
		}
		this.#persistenceFailed = false;
		this.#notify();
		return { status: "ready" };
	}

	cancel(requestId: string, disposition: "discard" | "preserve"): void {
		if (this.#activeRequestId !== requestId) return;
		if (disposition === "preserve") return;
		const previousRecordId = requestId;
		this.#activeRequestId = undefined;
		const persisted = this.#persistCurrent();
		this.#persistenceFailed = !persisted;
		if (persisted) this.#removeRecord(previousRecordId);
		this.#notify();
	}

	/** A managed route replacement waits only for active IME or a bounded quiet period after input. */
	prepareForManagedReload(): boolean {
		if (this.#composing.size > 0 || this.#hasRecentInput()) return false;
		const persisted = this.#persistCurrent();
		this.#persistenceFailed = !persisted;
		this.#notify();
		return persisted;
	}

	#persistCurrent(): boolean {
		const scope = this.#scope;
		const storage = this.#storage;
		if (this.#drafts.size === 0) {
			if (!scope || !storage) return true;
			try {
				storage.removeItem(recordKey(scope, this.#activeRequestId ?? this.#localRecordId));
				storage.removeItem(indexKey(scope));
				return true;
			} catch {
				return false;
			}
		}
		if (!scope || !storage) return false;
		const recordId = this.#activeRequestId ?? this.#localRecordId;
		const record: StoredRecord = {
			version: RECORD_VERSION,
			fingerprint: scope.fingerprint,
			sessionId: scope.sessionId,
			recordId,
			requestId: this.#activeRequestId ?? null,
			recoverUntilMs: this.#now() + RECOVERY_TTL_MS,
			drafts: [...this.#drafts.values()],
		};
		const index: StoredIndex = {
			version: RECORD_VERSION,
			fingerprint: scope.fingerprint,
			sessionId: scope.sessionId,
			recordId,
			recoverUntilMs: record.recoverUntilMs,
		};
		let encodedRecord: string;
		let encodedIndex: string;
		try {
			encodedRecord = JSON.stringify(record);
			encodedIndex = JSON.stringify(index);
			if (new TextEncoder().encode(encodedRecord).byteLength > MAX_PERSISTED_DRAFT_BYTES) return false;
		} catch {
			return false;
		}
		const nextRecordKey = recordKey(scope, recordId);
		const nextIndexKey = indexKey(scope);
		try {
			const previousRecord = storage.getItem(nextRecordKey);
			const previousIndex = storage.getItem(nextIndexKey);
			try {
				storage.setItem(nextRecordKey, encodedRecord);
				storage.setItem(nextIndexKey, encodedIndex);
			} catch {
				this.#restoreStorageValue(nextRecordKey, previousRecord);
				this.#restoreStorageValue(nextIndexKey, previousIndex);
				return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	#restoreStorageValue(key: string, value: string | null): void {
		try {
			if (value === null) this.#storage?.removeItem(key);
			else this.#storage?.setItem(key, value);
		} catch {
			// A failed rollback remains an unavailable store; the caller fails closed.
		}
	}

	#removeRecord(recordId: string): void {
		const scope = this.#scope;
		if (!scope || !this.#storage) return;
		try {
			this.#storage.removeItem(recordKey(scope, recordId));
		} catch {
			// A stale local record expires and cannot be sent anywhere.
		}
	}

	#removeScopeRecord(index: StoredIndex, scope: RestartDraftScope): void {
		try {
			this.#storage?.removeItem(recordKey(scope, index.recordId));
			this.#storage?.removeItem(indexKey(scope));
		} catch {
			// Invalid or expired data is never restored even if storage rejects cleanup.
		}
	}

	#hasRecentInput(): boolean {
		const now = this.#monotonicNow();
		for (const [key, at] of this.#recentInputAt) {
			if (now - at < INPUT_QUIET_MS) return true;
			this.#recentInputAt.delete(key);
		}
		return false;
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}

function browserStorage(): RestartDraftStorage | null {
	try {
		return globalThis.sessionStorage ?? null;
	} catch {
		return null;
	}
}

function newLocalRecordId(): string {
	return `local-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function surfaceKey(surface: RestartDraftSurface): string {
	switch (surface.kind) {
		case "composer":
			return "composer";
		case "editor":
			return `editor:${surface.capabilityFingerprint}:${surface.reqId}`;
		case "agent-chat":
			return `agent:${surface.agentId}`;
	}
}

function validSessionId(value: string): boolean {
	return value.length > 0 && value.length <= 200 && value !== "*";
}

function recordKey(scope: RestartDraftScope, recordId: string): string {
	return `${STORAGE_PREFIX}${scope.fingerprint}.${recordId}`;
}

function indexKey(scope: RestartDraftScope): string {
	return `${STORAGE_PREFIX}${scope.fingerprint}${STORAGE_INDEX_SUFFIX}`;
}

function matchesScope(value: StoredRecord | StoredIndex, scope: RestartDraftScope): boolean {
	return value.fingerprint === scope.fingerprint && value.sessionId === scope.sessionId;
}

function parseIndex(value: string | null): StoredIndex | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed)) return null;
		const fingerprint = parsed.fingerprint;
		const sessionId = parsed.sessionId;
		const recordId = parsed.recordId;
		const recoverUntilMs = parsed.recoverUntilMs;
		if (
			parsed.version !== RECORD_VERSION ||
			typeof fingerprint !== "string" ||
			typeof sessionId !== "string" ||
			typeof recordId !== "string" ||
			typeof recoverUntilMs !== "number" ||
			!Number.isSafeInteger(recoverUntilMs)
		) {
			return null;
		}
		return { version: RECORD_VERSION, fingerprint, sessionId, recordId, recoverUntilMs };
	} catch {
		return null;
	}
}

function parseRecord(value: string | null): StoredRecord | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed) || !Array.isArray(parsed.drafts)) return null;
		const fingerprint = parsed.fingerprint;
		const sessionId = parsed.sessionId;
		const recordId = parsed.recordId;
		const requestId = parsed.requestId;
		const recoverUntilMs = parsed.recoverUntilMs;
		if (
			parsed.version !== RECORD_VERSION ||
			typeof fingerprint !== "string" ||
			typeof sessionId !== "string" ||
			typeof recordId !== "string" ||
			(requestId !== null && typeof requestId !== "string") ||
			typeof recoverUntilMs !== "number" ||
			!Number.isSafeInteger(recoverUntilMs)
		) {
			return null;
		}
		const drafts: StoredDraft[] = [];
		for (const draft of parsed.drafts) {
			if (!isRecord(draft) || typeof draft.text !== "string" || !isSurface(draft.surface)) return null;
			drafts.push({ surface: draft.surface, text: draft.text });
		}
		return {
			version: RECORD_VERSION,
			fingerprint,
			sessionId,
			recordId,
			requestId,
			recoverUntilMs,
			drafts,
		};
	} catch {
		return null;
	}
}

function isSurface(value: unknown): value is RestartDraftSurface {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	switch (value.kind) {
		case "composer":
			return Object.keys(value).length === 1;
		case "editor":
			return (
				Number.isSafeInteger(value.reqId) &&
				typeof value.capabilityFingerprint === "string" &&
				isCapabilityFingerprint(value.capabilityFingerprint) &&
				Object.keys(value).length === 3
			);
		case "agent-chat":
			return typeof value.agentId === "string" && value.agentId.length > 0 && Object.keys(value).length === 2;
		default:
			return false;
	}
}

function isCapabilityFingerprint(value: string): boolean {
	return /^[a-f0-9]{64}$/u.test(value);
}

async function sha256Fingerprint(value: string): Promise<string | null> {
	try {
		const subtle = globalThis.crypto?.subtle;
		if (!subtle) return null;
		const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
		return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
	} catch {
		return null;
	}
}
