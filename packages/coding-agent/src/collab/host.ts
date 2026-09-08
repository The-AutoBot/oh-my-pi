/**
 * Host side of a collab live session.
 *
 * Taps the host session's event stream and SessionManager append chokepoint,
 * broadcasting entries/events/state to guests through the relay. Guests prompt
 * and abort through us; the host machine runs the agent and tools. The host's
 * subagent ecosystem is mirrored too: task EventBus traffic (observer HUD),
 * agent-registry snapshots (Agent Hub table), hub chat/kill/revive commands,
 * and incremental subagent-transcript reads.
 */

import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	BusChannel,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	LiveInput,
	AgentEvent as WireAgentEvent,
	SessionEntry as WireSessionEntry,
} from "@oh-my-pi/pi-wire";
import type { InteractiveModeContext } from "../modes/types";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { stripImagesFromMessage, USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";
import { generateRoomKey, generateWriteToken, importRoomKey } from "./crypto";
import { collabDisplayName } from "./display-name";
import {
	type AgentSnapshot,
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabParticipant,
	type CollabPromptDetails,
	type CollabSessionState,
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	parseCollabLink,
} from "./protocol";
import { CollabSocket } from "./relay-client";
import { shrinkForReplication } from "./replication-shrink";

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	advisor_cost_changed: true,
	auto_compaction_end: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
const WIRE_AGENT_EVENT_TYPES: Record<WireAgentEvent["type"], true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	notice: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	thinking_level_changed: true,
};

const WIRE_SESSION_ENTRY_TYPES: Record<WireSessionEntry["type"], true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};
const COLLAB_BUS_CHANNELS = [
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
] as const satisfies readonly BusChannel[];

function isWireAgentEvent(event: AgentSessionEvent): event is AgentSessionEvent & WireAgentEvent {
	return event.type in WIRE_AGENT_EVENT_TYPES;
}

function isWireSessionEntry(entry: StoredSessionEntry): entry is StoredSessionEntry & WireSessionEntry {
	return entry.type in WIRE_SESSION_ENTRY_TYPES;
}
const CONNECT_TIMEOUT_MS = 15_000;
/** Max bytes served per fetch-transcript reply (guest re-requests from `newSize`). */
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;
/**
 * Soft byte cap per `snapshot-chunk` frame. The first MB of a snapshot takes
 * ~3s through the default relay, so a 512 KB chunk lands well under the
 * guest's 30 s per-chunk progress timeout; oversized single entries still
 * ship in a chunk of their own.
 */
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;

const LIVE_INPUT_SAMPLE_RATE = 16_000;
const LIVE_INPUT_CHANNELS = 1;
const LIVE_INPUT_FRAME_SAMPLES = 320;
const LIVE_INPUT_FRAME_BYTES = LIVE_INPUT_FRAME_SAMPLES * 2;
const LIVE_INPUT_BASE64URL_LENGTH = 854;
const LIVE_INPUT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LIVE_INPUT_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const LIVE_OUTPUT_SAMPLE_RATE = 48_000;
const LIVE_OUTPUT_CHANNELS = 1;
const LIVE_OUTPUT_MAX_FRAME_SAMPLES = 2_880;
/**
 * A browser may spend time obtaining microphone permission, but an abandoned
 * claim must not monopolize the host's sole remote-input slot indefinitely.
 */
const LIVE_INPUT_LEASE_CLAIM_TIMEOUT_MS = 30_000;
/** Audio worklets normally produce a frame every 20 ms; allow network jitter
 * without keeping a silent connected owner active forever. */
const LIVE_INPUT_LEASE_IDLE_TIMEOUT_MS = 10_000;
/**
 * Outcome of {@link CollabHost.requestGuestUi}. `answered` carries the guest's
 * response (an `undefined` value is a genuine guest cancel); `unavailable`
 * means the collab channel went away (teardown, relay drop) or the request was
 * aborted before any guest answered — callers MUST NOT treat it as a cancel.
 */
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

type RemoteLiveInputLease = {
	peerId: number;
	requestId: string;
	leaseId: string;
	phase: "claimed" | "starting" | "active";
	lastSeq?: number;
	nextOutputSeq: number;
	startPromise?: Promise<boolean>;
	timer?: Timer;
};

type LiveInputLeaseStatus = Extract<CollabFrame, { t: "live-input-lease" }>["status"];

/** Optional timing overrides for deterministic lifecycle tests. */
export interface CollabHostOptions {
	liveInputClaimTimeoutMs?: number;
	liveInputIdleTimeoutMs?: number;
}

function isLiveInputId(value: unknown): value is string {
	return typeof value === "string" && LIVE_INPUT_ID_RE.test(value);
}

function isLiveInputStopReason(value: unknown): value is "user" | "track-ended" | "transport" {
	return value === "user" || value === "track-ended" || value === "transport";
}

function decodeLiveInputChunk(data: unknown): Float32Array | null {
	if (typeof data !== "string" || data.length !== LIVE_INPUT_BASE64URL_LENGTH || !LIVE_INPUT_BASE64URL_RE.test(data)) {
		return null;
	}
	const pcm = Buffer.from(data, "base64url");
	if (pcm.byteLength !== LIVE_INPUT_FRAME_BYTES || pcm.toString("base64url") !== data) return null;

	const samples = new Float32Array(LIVE_INPUT_FRAME_SAMPLES);
	for (let sampleIndex = 0; sampleIndex < LIVE_INPUT_FRAME_SAMPLES; sampleIndex += 1) {
		const byteIndex = sampleIndex * 2;
		const encoded = pcm[byteIndex]! | (pcm[byteIndex + 1]! << 8);
		const signed = encoded >= 0x8000 ? encoded - 0x1_0000 : encoded;
		samples[sampleIndex] = signed / 0x8000;
	}
	return samples;
}

function encodeLiveOutputPcm(samples: Float32Array): string | null {
	if (samples.length === 0 || samples.length > LIVE_OUTPUT_MAX_FRAME_SAMPLES) return null;
	for (const sample of samples) {
		if (!Number.isFinite(sample)) return null;
	}
	const pcm = Buffer.allocUnsafe(samples.length * 2);
	for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
		const sample = samples[sampleIndex] ?? 0;
		const normalized = Math.max(-1, Math.min(1, sample));
		const integer = Math.round(normalized * (normalized < 0 ? 0x8000 : 0x7fff));
		pcm.writeInt16LE(integer, sampleIndex * 2);
	}
	return pcm.toString("base64url");
}

export class CollabHost {
	#ctx: InteractiveModeContext;
	#socket: CollabSocket | null = null;
	#link = "";
	#webLink = "";
	#viewLink = "";
	#webViewLink = "";
	#writeToken: Uint8Array | null = null;
	#sessionId = "";
	#unsubscribe?: () => void;
	#peers = new Map<number, { name: string; canWrite: boolean; deliveredUiRequests: Set<number> }>();
	#uiReqSeq = 0;
	#pendingUi = new Map<number, { request: CollabUiRequest; settle(result: CollabGuestUiResult): void }>();
	#needsInput = false;
	#inputStateEmissions: Promise<void> = Promise.resolve();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#busUnsubscribers: (() => void)[] = [];
	#registryUnsubscribe?: () => void;
	#liveStateUnsubscribe?: () => void;
	#liveOutputUnsubscribe?: () => void;
	#remoteLiveInputLease: RemoteLiveInputLease | undefined;
	/**
	 * A revoked start can resolve after its logical lease was cleared. Keep its
	 * cleanup in flight so a replacement claim cannot start a transport that a
	 * stale completion would then stop.
	 */
	#remoteLiveInputStopping?: Promise<void>;
	#liveInputClaimTimeoutMs: number;
	#liveInputIdleTimeoutMs: number;
	#stopped = false;
	#rejectStart?: (reason?: unknown) => void;
	readonly #onStopped?: (host: CollabHost) => void | Promise<void>;

	constructor(
		ctx: InteractiveModeContext,
		onStopped?: (host: CollabHost) => void | Promise<void>,
		options: CollabHostOptions = {},
	) {
		this.#ctx = ctx;
		this.#onStopped = onStopped;
		this.#liveInputClaimTimeoutMs = options.liveInputClaimTimeoutMs ?? LIVE_INPUT_LEASE_CLAIM_TIMEOUT_MS;
		this.#liveInputIdleTimeoutMs = options.liveInputIdleTimeoutMs ?? LIVE_INPUT_LEASE_IDLE_TIMEOUT_MS;
	}

	get link(): string {
		return this.#link;
	}

	/** Browser deep link for the configured collab web UI. */
	get webLink(): string {
		return this.#webLink;
	}

	/** Read-only variant of {@link link}: bare room key, no write token. */
	get viewLink(): string {
		return this.#viewLink;
	}

	/** Read-only variant of {@link webLink}. */
	get webViewLink(): string {
		return this.#webViewLink;
	}

	get participants(): CollabParticipant[] {
		const list: CollabParticipant[] = [{ name: collabDisplayName(this.#ctx), role: "host" }];
		for (const peer of this.#peers.values()) {
			list.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
		}
		return list;
	}

	/** Never infer host-microphone capture for an incomplete embedded context. */
	#currentLiveInput(): LiveInput {
		return this.#ctx.liveInput ?? "none";
	}

	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
		if (!this.#socket) return null;
		const reqId = ++this.#uiReqSeq;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
		let settled = false;
		const settle = (result: CollabGuestUiResult): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(reqId);
			this.#syncInputState();
			for (const peer of this.#peers.values()) peer.deliveredUiRequests.delete(reqId);
			this.#sendWritablePeers({ t: "ui-request-end", reqId });
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		if (signal?.aborted) return Promise.resolve({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingUi.set(reqId, { request: fullRequest, settle });
		this.#syncInputState();
		this.#sendUiRequestToWritablePeers(fullRequest);
		return promise;
	}

	#syncInputState(): void {
		const needsInput = this.#pendingUi.size > 0;
		if (needsInput === this.#needsInput) return;
		this.#needsInput = needsInput;
		const runner = this.#ctx.session.extensionRunner;
		if (!runner?.hasHandlers("collab_input_state")) return;
		const event = Object.freeze({ type: "collab_input_state" as const, needsInput });
		this.#inputStateEmissions = this.#inputStateEmissions
			.then(() => runner.emit(event))
			.catch(error => logger.warn("collab_input_state handler failed", { error: String(error) }));
	}

	#sendUiRequestToWritablePeers(request: CollabUiRequest): void {
		for (const peerId of this.#peers.keys()) this.#sendUiRequestToPeer(request, peerId);
	}

	#sendUiRequestToPeer(request: CollabUiRequest, peerId: number): void {
		const socket = this.#socket;
		const peer = this.#peers.get(peerId);
		if (!socket || !peer?.canWrite || peer.deliveredUiRequests.has(request.reqId)) return;
		peer.deliveredUiRequests.add(request.reqId);
		socket.send({ t: "ui-request", request }, peerId);
	}

	#replayPendingUiRequests(peerId: number): void {
		for (const pending of this.#pendingUi.values()) this.#sendUiRequestToPeer(pending.request, peerId);
	}

	#sendWritablePeers(frame: CollabFrame): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite) socket.send(frame, peerId);
		}
	}

	#sendRegisteredPeers(frame: CollabFrame): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const peerId of this.#peers.keys()) socket.send(frame, peerId);
	}

	async start(relayUrl: string, webUrl = ""): Promise<void> {
		const rawKey = generateRoomKey();
		const writeToken = generateWriteToken();
		const roomId = generateRoomId();
		this.#writeToken = writeToken;
		this.#link = formatCollabLink(relayUrl, roomId, rawKey, writeToken);
		this.#webLink = formatCollabWebLink(relayUrl, roomId, rawKey, writeToken, webUrl);
		this.#viewLink = formatCollabLink(relayUrl, roomId, rawKey);
		this.#webViewLink = formatCollabWebLink(relayUrl, roomId, rawKey, undefined, webUrl);
		const parsed = parseCollabLink(this.#link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(rawKey);
		if (this.#stopped) throw new Error("Collaboration stopped before the relay connected.");

		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "host", key });
		this.#socket = socket;
		this.#sessionId = this.#ctx.sessionManager.getSessionId();
		this.#liveStateUnsubscribe = this.#ctx.onLiveStateChange?.((active, input) =>
			this.#handleLiveStateChange(active, input),
		);
		this.#liveOutputUnsubscribe = this.#ctx.onRemoteLiveOutput?.(samples => this.#handleRemoteLiveOutput(samples));

		const firstOpen = Promise.withResolvers<void>();
		this.#rejectStart = firstOpen.reject;
		let opened = false;
		socket.onOpen = () => {
			if (!opened) {
				opened = true;
				firstOpen.resolve();
			}
		};
		socket.onFrame = (frame, fromPeer) => this.#handleFrame(frame, fromPeer);
		socket.onControl = msg => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
		};
		socket.onClose = (reason, willReconnect) => {
			if (this.#stopped) return;
			if (!opened) {
				firstOpen.reject(new Error(reason));
				return;
			}
			const remoteLease = this.#remoteLiveInputLease;
			if (remoteLease) void this.#stopRemoteLiveInput(remoteLease);
			if (willReconnect) {
				this.#ctx.showStatus(`Collab relay connection lost (${reason}), reconnecting…`, { dim: true });
			} else {
				void this.#teardown();
				this.#ctx.session.emitNotice("warning", `Collab ended: ${reason}`, "collab");
			}
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new Error("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			socket.close();
			this.#liveStateUnsubscribe?.();
			this.#liveStateUnsubscribe = undefined;
			this.#liveOutputUnsubscribe?.();
			this.#liveOutputUnsubscribe = undefined;
			this.#socket = null;
			throw err;
		} finally {
			this.#rejectStart = undefined;
			clearTimeout(timeout);
		}

		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) this.#broadcast({ t: "event", event: shrinkForReplication(event) });
			this.#onEventForState(event);
		});
		// Subagent frames publish on the session tree's observability bus at
		// any spawn depth; mirroring from it is what lets nested agents reach
		// guests at all. Embedders on the previous constructor signature only
		// wire a session bus — fall back to it so depth-1 frames keep flowing.
		const observabilityBus = this.#ctx.subagentEventBus ?? this.#ctx.eventBus;
		if (observabilityBus) {
			for (const channel of COLLAB_BUS_CHANNELS) {
				this.#busUnsubscribers.push(
					observabilityBus.on(channel, data => this.#broadcast({ t: "bus", channel, data })),
				);
			}
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		this.#ctx.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry)) this.#broadcast({ t: "entry", entry: shrinkForReplication(entry) });
			// Model/thinking/title changes land as entries while idle; refresh
			// guest state promptly (debounce + JSON diff dedupe).
			this.#scheduleStateBroadcast();
		};
		this.#updateStatusSegment();
	}

	/** Broadcast a goodbye, detach all taps, and close the socket. */
	async stop(reason: string): Promise<void> {
		if (this.#stopped) return;
		this.#socket?.send({ t: "bye", reason });
		await this.#teardown();
	}

	async #teardown(): Promise<void> {
		if (this.#stopped) return;
		this.#rejectStart?.(new Error("Collaboration stopped before the relay connected."));
		this.#rejectStart = undefined;
		this.#stopped = true;
		if (this.#ctx.collabHost === this) this.#ctx.collabHost = undefined;
		this.#ctx.sessionManager.onEntryAppended = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const unsubscribe of this.#busUnsubscribers) unsubscribe();
		this.#busUnsubscribers = [];
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		this.#liveStateUnsubscribe?.();
		this.#liveStateUnsubscribe = undefined;
		this.#liveOutputUnsubscribe?.();
		this.#liveOutputUnsubscribe = undefined;
		clearTimeout(this.#stateDebounce ?? undefined);
		this.#stateDebounce = null;
		clearTimeout(this.#agentsDebounce ?? undefined);
		this.#agentsDebounce = null;
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		this.#syncInputState();
		const remoteLease = this.#remoteLiveInputLease;
		if (remoteLease) {
			const stopping = this.#stopRemoteLiveInput(remoteLease);
			// A host shutdown must not hang forever on an underlying start that
			// ignores cancellation. The retained cleanup still stops it if it
			// resolves later.
			if (remoteLease.phase !== "starting") await stopping;
		}
		this.#socket?.close();
		this.#socket = null;
		this.#ctx.statusLine.setCollabStatus(null);
		this.#ctx.ui.requestRender();
		await this.#onStopped?.(this);
	}

	#broadcast(frame: CollabFrame): void {
		if (this.#stopped || !this.#socket) return;
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			void this.stop("session switched");
			this.#ctx.session.emitNotice("warning", "Collab ended: session switched", "collab");
			return;
		}
		this.#socket.send(frame);
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		switch (frame.t) {
			case "hello":
				this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer);
				break;
			case "prompt":
				this.#handlePrompt(frame.text, frame.images, fromPeer);
				break;
			case "abort":
				this.#handleAbort(fromPeer);
				break;
			case "live-input-claim":
				this.#handleLiveInputClaim(frame.requestId, fromPeer);
				break;
			case "live-input-start":
				this.#handleLiveInputStart(
					frame.leaseId,
					frame.format,
					frame.sampleRate,
					frame.channels,
					frame.frameSamples,
					fromPeer,
				);
				break;
			case "live-input-chunk":
				this.#handleLiveInputChunk(frame.leaseId, frame.seq, frame.data, fromPeer);
				break;
			case "live-input-stop":
				this.#handleLiveInputStop(frame.leaseId, frame.reason, fromPeer);
				break;
			case "agent-cmd":
				this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text, fromPeer);
				break;
			case "ui-response":
				this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
				break;
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			default:
				logger.debug("collab host ignoring unexpected frame", { type: frame.t, fromPeer });
		}
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#socket?.send({ t: "error", message: `${action} is disabled on a read-only link` }, fromPeer);
	}

	#sendLiveInputLease(
		fromPeer: number,
		requestId: string,
		status: LiveInputLeaseStatus,
		leaseId?: string,
		message?: string,
	): void {
		this.#socket?.send({ t: "live-input-lease", requestId, status, leaseId, message }, fromPeer);
	}

	#rejectLiveInput(action: string, fromPeer: number): void {
		this.#socket?.send({ t: "error", message: `live input ${action} rejected` }, fromPeer);
	}

	#clearRemoteLiveInputLeaseTimer(lease: RemoteLiveInputLease): void {
		if (lease.timer) clearTimeout(lease.timer);
		lease.timer = undefined;
	}

	#armRemoteLiveInputLeaseTimer(lease: RemoteLiveInputLease, timeoutMs: number, message: string): void {
		this.#clearRemoteLiveInputLeaseTimer(lease);
		const timer = setTimeout(() => {
			if (
				this.#remoteLiveInputLease !== lease ||
				this.#remoteLiveInputLease?.leaseId !== lease.leaseId ||
				lease.timer !== timer
			) {
				return;
			}
			lease.timer = undefined;
			void this.#stopRemoteLiveInput(lease, "revoked", message);
		}, timeoutMs);
		lease.timer = timer;
	}

	#clearRemoteLiveInputLease(lease: RemoteLiveInputLease, status?: LiveInputLeaseStatus, message?: string): boolean {
		if (this.#remoteLiveInputLease !== lease) return false;
		this.#clearRemoteLiveInputLeaseTimer(lease);
		this.#remoteLiveInputLease = undefined;
		if (status && !this.#stopped) this.#sendLiveInputLease(lease.peerId, lease.requestId, status, undefined, message);
		return true;
	}

	async #stopRemoteLiveInput(
		lease: RemoteLiveInputLease,
		status?: LiveInputLeaseStatus,
		message?: string,
	): Promise<void> {
		if (!this.#clearRemoteLiveInputLease(lease, status, message) || lease.phase === "claimed") return;
		const stopping = (async (): Promise<void> => {
			if (lease.startPromise && !(await lease.startPromise)) return;
			if (this.#currentLiveInput() !== "remote") return;
			try {
				await this.#ctx.stopRemoteLiveInput();
			} catch (error) {
				logger.warn("collab remote live input stop failed", { error: String(error) });
			}
		})();
		this.#remoteLiveInputStopping = stopping;
		try {
			await stopping;
		} finally {
			if (this.#remoteLiveInputStopping === stopping) this.#remoteLiveInputStopping = undefined;
		}
	}

	#handleLiveInputClaim(requestId: unknown, fromPeer: number): void {
		if (!isLiveInputId(requestId)) {
			this.#rejectLiveInput("claim", fromPeer);
			return;
		}
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#sendLiveInputLease(fromPeer, requestId, "read-only");
			return;
		}
		if (
			this.#remoteLiveInputLease ||
			this.#remoteLiveInputStopping ||
			this.#ctx.liveActive ||
			this.#currentLiveInput() !== "none"
		) {
			this.#sendLiveInputLease(fromPeer, requestId, "busy");
			return;
		}
		const lease: RemoteLiveInputLease = {
			peerId: fromPeer,
			requestId,
			leaseId: crypto.randomUUID(),
			phase: "claimed",
			nextOutputSeq: 0,
		};
		this.#remoteLiveInputLease = lease;
		this.#armRemoteLiveInputLeaseTimer(lease, this.#liveInputClaimTimeoutMs, "microphone setup timed out");
		this.#sendLiveInputLease(fromPeer, requestId, "granted", lease.leaseId);
	}

	#handleLiveInputStart(
		leaseId: unknown,
		format: unknown,
		sampleRate: unknown,
		channels: unknown,
		frameSamples: unknown,
		fromPeer: number,
	): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("sending live input", fromPeer);
			return;
		}
		if (
			!isLiveInputId(leaseId) ||
			format !== "pcm_s16le" ||
			sampleRate !== LIVE_INPUT_SAMPLE_RATE ||
			channels !== LIVE_INPUT_CHANNELS ||
			frameSamples !== LIVE_INPUT_FRAME_SAMPLES
		) {
			this.#rejectLiveInput("start", fromPeer);
			return;
		}
		const lease = this.#remoteLiveInputLease;
		if (!lease || lease.peerId !== fromPeer || lease.leaseId !== leaseId || lease.phase !== "claimed") {
			this.#rejectLiveInput("stale start", fromPeer);
			return;
		}
		lease.phase = "starting";
		this.#armRemoteLiveInputLeaseTimer(lease, this.#liveInputClaimTimeoutMs, "microphone setup timed out");
		const startPromise = this.#startRemoteLiveInput();
		lease.startPromise = startPromise;
		void this.#finishRemoteLiveInputStart(lease, startPromise);
	}

	async #startRemoteLiveInput(): Promise<boolean> {
		try {
			return await this.#ctx.startRemoteLiveInput();
		} catch (error) {
			logger.warn("collab remote live input start failed", { error: String(error) });
			return false;
		}
	}

	async #finishRemoteLiveInputStart(lease: RemoteLiveInputLease, startPromise: Promise<boolean>): Promise<void> {
		const started = await startPromise;
		if (this.#remoteLiveInputLease !== lease) return;
		if (!started || !this.#ctx.liveActive || this.#currentLiveInput() !== "remote") {
			void this.#stopRemoteLiveInput(lease, "unavailable", "remote live input is unavailable");
			return;
		}
		lease.phase = "active";
		this.#armRemoteLiveInputLeaseTimer(lease, this.#liveInputIdleTimeoutMs, "microphone audio timed out");
		this.#handleLiveStateChange(this.#ctx.liveActive, this.#currentLiveInput());
	}

	#handleRemoteLiveOutput(samples: Float32Array): void {
		const lease = this.#remoteLiveInputLease;
		if (
			this.#stopped ||
			!lease ||
			lease.phase !== "active" ||
			!this.#ctx.liveActive ||
			this.#currentLiveInput() !== "remote" ||
			!this.#peers.get(lease.peerId)?.canWrite
		) {
			return;
		}
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			void this.stop("session switched");
			return;
		}
		if (!Number.isSafeInteger(lease.nextOutputSeq)) return;
		const data = encodeLiveOutputPcm(samples);
		if (!data) return;
		const seq = lease.nextOutputSeq;
		lease.nextOutputSeq = seq + 1;
		this.#socket?.sendRealtime(
			{
				t: "live-output-chunk",
				leaseId: lease.leaseId,
				seq,
				format: "pcm_s16le",
				sampleRate: LIVE_OUTPUT_SAMPLE_RATE,
				channels: LIVE_OUTPUT_CHANNELS,
				frameSamples: samples.length,
				data,
			},
			lease.peerId,
		);
	}

	#handleLiveInputChunk(leaseId: unknown, seq: unknown, data: unknown, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("sending live input", fromPeer);
			return;
		}
		if (!isLiveInputId(leaseId) || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
			this.#rejectLiveInput("chunk", fromPeer);
			return;
		}
		const lease = this.#remoteLiveInputLease;
		if (!lease || lease.peerId !== fromPeer || lease.leaseId !== leaseId || lease.phase !== "active") {
			this.#rejectLiveInput("stale chunk", fromPeer);
			return;
		}
		if (lease.lastSeq !== undefined && seq <= lease.lastSeq) {
			this.#rejectLiveInput("out-of-order chunk", fromPeer);
			return;
		}
		const samples = decodeLiveInputChunk(data);
		if (!samples) {
			this.#rejectLiveInput("chunk", fromPeer);
			return;
		}
		if (!this.#ctx.pushRemoteLiveInput(samples)) {
			void this.#stopRemoteLiveInput(lease, "revoked", "remote live input is no longer active");
			return;
		}
		lease.lastSeq = seq;
		this.#armRemoteLiveInputLeaseTimer(lease, this.#liveInputIdleTimeoutMs, "microphone audio timed out");
	}

	#handleLiveInputStop(leaseId: unknown, reason: unknown, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("stopping live input", fromPeer);
			return;
		}
		if (!isLiveInputId(leaseId) || !isLiveInputStopReason(reason)) {
			this.#rejectLiveInput("stop", fromPeer);
			return;
		}
		const lease = this.#remoteLiveInputLease;
		if (!lease || lease.peerId !== fromPeer || lease.leaseId !== leaseId) {
			this.#rejectLiveInput("stale stop", fromPeer);
			return;
		}
		void this.#stopRemoteLiveInput(lease);
	}

	#handleLiveStateChange(active: boolean, input: LiveInput): void {
		const lease = this.#remoteLiveInputLease;
		// Do not advertise a remote input until the live transport has finished
		// connecting; browser clients use this broadcast as their send gate.
		if (lease?.phase === "starting" && input === "remote") return;
		this.#sendRegisteredPeers({ t: "live-state", active, input });
		if (!lease) return;
		if (lease.phase === "claimed" && input !== "none") {
			this.#clearRemoteLiveInputLease(lease, "revoked", "live input was preempted");
			return;
		}
		if (lease.phase === "starting") {
			void this.#stopRemoteLiveInput(lease, "revoked", "remote live input ended");
			return;
		}
		if (lease.phase === "active" && (!active || input !== "remote")) {
			this.#clearRemoteLiveInputLease(lease, "revoked", "remote live input ended");
		}
	}

	#handleHello(name: string, proto: number, writeToken: string | undefined, fromPeer: number): void {
		if (proto !== COLLAB_PROTO) {
			this.#socket?.send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			return;
		}
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		const previousPeer = this.#peers.get(fromPeer);
		this.#peers.set(fromPeer, {
			name: cleanName,
			canWrite,
			deliveredUiRequests: canWrite && previousPeer?.canWrite ? previousPeer.deliveredUiRequests : new Set(),
		});
		const remoteLease = this.#remoteLiveInputLease;
		if (!canWrite && remoteLease?.peerId === fromPeer) {
			void this.#stopRemoteLiveInput(remoteLease, "revoked", "write access was revoked");
		}

		// Snapshot and send synchronously: no awaits between snapshot, welcome,
		// and chunk sends, so subsequent broadcast frames (entry/event/state/bus)
		// queue behind the snapshot on the same socket and the guest can't
		// observe a gap between the snapshot fragment and live traffic.
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		if (JSON.stringify(snapshot).length > WELCOME_IMAGE_STRIP_THRESHOLD) {
			let stripped = 0;
			for (const entry of snapshot.entries) {
				if (entry.type === "message") stripped += stripImagesFromMessage(entry.message);
			}
			logger.info("collab welcome exceeded size threshold; stripped images", { stripped });
		}
		const entries = snapshot.entries.filter(isWireSessionEntry);
		const socket = this.#socket;
		if (!socket) return;
		socket.send(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				header: snapshot.header,
				state: this.#buildState(),
				agents: this.#snapshotAgents(),
				entryCount: entries.length,
				liveActive: this.#ctx.liveActive,
				liveInput: this.#currentLiveInput(),
				readOnly: canWrite ? undefined : true,
			},
			fromPeer,
		);
		this.#sendSnapshotChunks(entries, fromPeer);
		if (canWrite) this.#replayPendingUiRequests(fromPeer);
		this.#ctx.session.emitNotice(
			"info",
			`${cleanName} joined the collab session${canWrite ? "" : " (read-only)"}`,
			"collab",
		);
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/**
	 * Slice {@link entries} into byte-bounded `snapshot-chunk` frames targeted
	 * at {@link fromPeer}. Each entry is first run through
	 * {@link shrinkForReplication} so a single oversized tool-result entry
	 * cannot ship as an oversized chunk that trips the relay's per-frame
	 * `maxPayloadLength` (issue #3739). Every batch carries at least one
	 * entry, and the last batch is tagged `final: true` so the guest can
	 * finalize the replica. An empty snapshot still emits one `final` chunk
	 * so the guest never blocks on a missing terminator.
	 */
	#sendSnapshotChunks(entries: (StoredSessionEntry & WireSessionEntry)[], fromPeer: number): void {
		const socket = this.#socket;
		if (!socket) return;
		if (entries.length === 0) {
			socket.send({ t: "snapshot-chunk", entries: [], final: true }, fromPeer);
			return;
		}
		let i = 0;
		while (i < entries.length) {
			const batch: (StoredSessionEntry & WireSessionEntry)[] = [];
			let batchBytes = 0;
			while (i < entries.length) {
				const entry = entries[i];
				if (!entry) break;
				const shrunk = shrinkForReplication(entry);
				const entryBytes = JSON.stringify(shrunk).length;
				if (batch.length > 0 && batchBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batch.push(shrunk);
				batchBytes += entryBytes;
				i++;
			}
			socket.send({ t: "snapshot-chunk", entries: batch, final: i >= entries.length }, fromPeer);
		}
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		this.#pendingUi.get(reqId)?.settle({ kind: "answered", value });
	}

	#handlePrompt(text: string, images: ImageContent[] | undefined, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		const name = peer.name;
		const content: string | (TextContent | ImageContent)[] =
			images && images.length > 0 ? [{ type: "text", text }, ...images] : text;
		const details: CollabPromptDetails = { from: name };
		if (this.#ctx.session.isStreaming) {
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.ui.requestRender();
			this.#scheduleStateBroadcast();
		}
		this.#ctx.session
			.promptCustomMessage(
				{
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content,
					display: true,
					details,
					attribution: "user",
				},
				{ streamingBehavior: "steer", queueChipText: text },
			)
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				this.#socket?.send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
			});
	}

	#handleAbort(fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("interrupting", fromPeer);
			return;
		}
		const name = peer.name;
		void this.#ctx.session
			.abort({ reason: USER_INTERRUPT_LABEL })
			.then(() => this.#ctx.session.emitNotice("info", `${name} interrupted`, "collab"))
			.catch(err => logger.warn("collab guest abort failed", { error: String(err) }));
	}

	#handlePeerLeft(peer: number): void {
		const name = this.#peers.get(peer)?.name;
		const remoteLease = this.#remoteLiveInputLease;
		if (remoteLease?.peerId === peer) void this.#stopRemoteLiveInput(remoteLease);
		this.#peers.delete(peer);
		if (name) this.#ctx.session.emitNotice("info", `${name} left the collab session`, "collab");
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#buildState(): CollabSessionState {
		const session = this.#ctx.session;
		// Context numbers come from the status line's memoized breakdown so guests
		// render exactly the same anchored, provider-real count the host's own
		// status line shows.
		const breakdown = this.#ctx.statusLine.getCachedContextBreakdown();
		const tokens = breakdown.usedTokens ?? 0;
		return {
			isStreaming: session.isStreaming,
			isAborting: session.isAborting,
			queuedMessageCount: session.queuedMessageCount,
			sessionName: session.sessionName,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			contextUsage: {
				tokens,
				contextWindow: breakdown.contextWindow,
				percent: breakdown.contextWindow > 0 ? (tokens / breakdown.contextWindow) * 100 : 0,
			},
			participants: this.participants,
		};
	}

	#onEventForState(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type]) return;
		this.#scheduleStateBroadcast();
		if (event.type === "agent_start" && !this.#streamingInterval) {
			this.#streamingInterval = setInterval(() => this.#scheduleStateBroadcast(), STREAMING_STATE_INTERVAL_MS);
		} else if (event.type === "agent_end" && this.#streamingInterval) {
			clearInterval(this.#streamingInterval);
			this.#streamingInterval = null;
		}
	}

	#snapshotAgents(): AgentSnapshot[] {
		return (
			AgentRegistry.global()
				.list()
				// Advisor transcripts are local observability only; never mirror them to
				// guests (the wire AgentSnapshot kind has no `advisor`, and guests must not
				// be able to chat/kill/revive them).
				.filter((ref): ref is AgentRef & { kind: "main" | "sub" } => ref.kind !== "advisor")
				.map(ref => ({
					id: ref.id,
					displayName: ref.displayName,
					kind: ref.kind,
					parentId: ref.parentId,
					status: ref.status,
					hasSessionFile: !!ref.sessionFile,
					createdAt: ref.createdAt,
					lastActivity: ref.lastActivity,
				}))
		);
	}

	#scheduleAgentsBroadcast(): void {
		if (this.#stopped || this.#agentsDebounce) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			this.#broadcast({ t: "agents", agents: this.#snapshotAgents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	#handleAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text: string | undefined, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// Advisor refs are excluded from snapshots, but reject control by id defensively:
		// a stale/malicious client must never chat/kill/revive a read-only advisor transcript.
		if (AgentRegistry.global().get(agentId)?.kind === "advisor") {
			this.#socket?.send({ t: "error", message: `agent ${agentId}: advisor transcripts are read-only` }, fromPeer);
			return;
		}
		const fail = (err: unknown) => {
			logger.warn("collab agent-cmd failed", { cmd, agentId, error: String(err) });
			this.#socket?.send({ t: "error", message: `agent ${agentId}: ${String(err)}` }, fromPeer);
		};
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) {
					this.#socket?.send({ t: "error", message: `agent ${agentId}: empty chat message` }, fromPeer);
					return;
				}
				// Mirrors the hub's #submitChatMessage: revive if parked, steer if mid-turn.
				AgentLifecycleManager.global()
					.ensureLive(agentId)
					.then(session => session.prompt(trimmed, { streamingBehavior: "steer" }))
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(agentId);
					if (!ref) return;
					if (ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					await AgentLifecycleManager.global().release(agentId, ref, { tombstone: true });
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(agentId).catch(fail);
				break;
		}
	}

	/** Incremental transcript read mirroring the hub's readFileIncremental contract. */
	async #handleFetchTranscript(reqId: number, agentId: string, fromByte: number, fromPeer: number): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			this.#socket?.send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
		const file = AgentRegistry.global().get(agentId)?.sessionFile;
		if (!file) {
			reply("", fromByte, "no transcript available");
			return;
		}
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) {
				reply("", stat.size);
				return;
			}
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			let bytesRead: number;
			const buf = Buffer.allocUnsafe(want);
			try {
				({ bytesRead } = await handle.read(buf, 0, want, fromByte));
			} finally {
				await handle.close();
			}
			let slice = buf.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				// Trim to the last complete JSONL line so no line or UTF-8 char is split.
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					reply("", fromByte, TRANSCRIPT_ENTRY_TOO_LARGE_ERROR);
					return;
				}
				slice = slice.subarray(0, lastNewline + 1);
			}
			reply(slice.toString("utf-8"), reachedEof ? stat.size : fromByte + slice.byteLength);
		} catch (err) {
			logger.debug("collab transcript read failed", { agentId, error: String(err) });
			reply("", fromByte, String(err));
		}
	}

	#scheduleStateBroadcast(): void {
		if (this.#stopped || this.#stateDebounce) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			this.#lastStateJson = json;
			this.#broadcast({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({ role: "host", participantCount: this.#peers.size + 1 });
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
