import { describe, expect, it, vi } from "bun:test";
import type {
	AgentSnapshot,
	AssistantMessage,
	GuestFrame,
	HostFrame,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentProgressPayload,
	WireMessage,
} from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { importRoomKey, open } from "../src/lib/codec";
import { COLLAB_PROTO, encodeBase64Url, unpackEnvelope } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };

const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};

const AGENTS: AgentSnapshot[] = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1,
		lastActivity: 2,
	},
];

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test/model",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

function messageEntry(id: string, message: WireMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-06-12T00:00:01Z", message };
}

function welcomeFrame(
	entryCount = 0,
	readOnly?: boolean,
	liveActive?: boolean,
	liveInput: "none" | "local" | "remote" = "none",
): HostFrame {
	return {
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: STATE,
		agents: AGENTS,
		entryCount,
		readOnly,
		liveActive,
		liveInput,
	};
}

function snapshotChunk(entries: SessionEntry[], final = true): HostFrame {
	return { t: "snapshot-chunk", entries, final };
}

function liveClient(entries: SessionEntry[] = []): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest(welcomeFrame(entries.length));
	if (entries.length > 0) client.applyFrameForTest(snapshotChunk(entries));
	return client;
}

describe("GuestClient frame apply", () => {
	it("throws on an invalid link", () => {
		expect(() => new GuestClient("not a link", "tester")).toThrow();
	});

	it("welcome populates the snapshot and goes live", () => {
		const userEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const client = liveClient([userEntry]);
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(snap.header).toEqual(HEADER);
		expect(snap.entries).toEqual([userEntry]);
		expect(snap.state).toEqual(STATE);
		expect(snap.agents).toEqual(AGENTS);
		expect(snap.working).toBe(false);
		expect(snap.stream).toBeNull();
		expect(snap.activeTools.size).toBe(0);
	});

	it("welcome readOnly flag lands in the snapshot", () => {
		const client = new GuestClient(LINK, "tester");
		expect(client.getSnapshot().readOnly).toBe(false);
		client.applyFrameForTest(welcomeFrame(0, true));
		expect(client.getSnapshot().readOnly).toBe(true);
	});

	it("applies live voice state from welcome and subsequent state frames", () => {
		const client = new GuestClient(LINK, "tester");
		expect(client.getSnapshot().liveActive).toBe(false);

		client.applyFrameForTest(welcomeFrame(0, undefined, true, "local"));
		expect(client.getSnapshot().liveActive).toBe(true);
		expect(client.getSnapshot().liveInput).toBe("local");
		client.applyFrameForTest({ t: "live-state", active: false, input: "none" });
		expect(client.getSnapshot().liveActive).toBe(false);

		client.applyFrameForTest({ t: "live-state", active: true, input: "remote" });
		expect(client.getSnapshot().liveActive).toBe(true);
		expect(client.getSnapshot().liveInput).toBe("remote");
	});

	it("times out stalled snapshot chunks and resets the clock on progress", () => {
		vi.useFakeTimers();
		try {
			const firstEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
			const client = new GuestClient(LINK, "tester");
			client.applyFrameForTest(welcomeFrame(2));
			expect(client.getSnapshot().phase).toBe("connecting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("connecting");
			client.applyFrameForTest(snapshotChunk([firstEntry], false));
			expect(client.getSnapshot().entries).toEqual([firstEntry]);
			expect(client.getSnapshot().phase).toBe("connecting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("connecting");
			vi.advanceTimersByTime(1);
			const snap = client.getSnapshot();
			expect(snap.phase).toBe("ended");
			expect(snap.endedReason).toBe("timed out waiting for the host's session snapshot");

			const completeClient = new GuestClient(LINK, "tester");
			completeClient.applyFrameForTest(welcomeFrame(1));
			completeClient.applyFrameForTest(snapshotChunk([firstEntry]));
			vi.advanceTimersByTime(30_000);
			expect(completeClient.getSnapshot().phase).toBe("live");
		} finally {
			vi.useRealTimers();
		}
	});

	it("message_update sets the stream ghost (synthesizing a missed start)", () => {
		const client = liveClient();
		const partial = assistantMessage("hel");
		client.applyFrameForTest({ t: "event", event: { type: "message_update", message: partial } });
		const snap = client.getSnapshot();
		expect(snap.stream).toEqual(partial);
		expect(snap.streamDone).toBe(false);
	});

	it("message_end keeps the ghost until the matching entry lands", () => {
		const client = liveClient();
		const message = assistantMessage("hello");
		client.applyFrameForTest({ t: "event", event: { type: "message_update", message } });
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		let snap = client.getSnapshot();
		expect(snap.streamDone).toBe(true);
		expect(snap.stream).toEqual(message);

		client.applyFrameForTest({ t: "entry", entry: messageEntry("e2", message) });
		snap = client.getSnapshot();
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
		expect(snap.entries).toHaveLength(1);
	});

	it("tool start/update/end maintains activeTools", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		let tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.toolName).toBe("bash");
		expect(tool?.intent).toBe("Listing");

		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				partialResult: "src",
			},
		});
		tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.partialResult).toBe("src");

		client.applyFrameForTest({
			t: "event",
			event: { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: "src\ntest" },
		});
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("agent_start/agent_end and state reconcile the working flag", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "event", event: { type: "agent_start" } });
		expect(client.getSnapshot().working).toBe(true);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().working).toBe(false);
	});
	it("a state frame recovers a stuck-idle guest when agent_start was dropped", () => {
		// The host begins streaming mid-turn, but the matching `agent_start`
		// never arrived (e.g. dropped on a reconnect). Before the fix nothing
		// set `working` true except `agent_start`, so the guest stayed idle.
		const client = liveClient();
		expect(client.getSnapshot().working).toBe(false);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: true } });
		expect(client.getSnapshot().working).toBe(true);
	});

	it("an idle state frame clears a pinned tool card when tool_execution_end was dropped", () => {
		// Host reports idle, but the matching `tool_execution_end` was dropped,
		// leaving a stuck tool card. The authoritative idle signal must clear it.
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		expect(client.getSnapshot().activeTools.size).toBe(1);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("bus progress frames update the progress map", () => {
		const client = liveClient();
		const payload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			task: "do things",
			progress: {
				index: 0,
				id: "Sub1",
				agent: "task",
				status: "running",
				task: "do things",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				requests: 1,
				tokens: 100,
				cost: 0.01,
				durationMs: 1000,
			},
		};
		client.applyFrameForTest({ t: "bus", channel: "task:subagent:progress", data: payload });
		expect(client.getSnapshot().progress.get("Sub1")).toEqual(payload);
	});

	it("bye ends the session with a reason", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "bye", reason: "host left" });
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toBe("host left");
	});

	it("error frames append notices", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "error", message: "boom" });
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "boom" });
	});

	it("auto_retry_end failure surfaces an error notice", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: { type: "auto_retry_end", success: false, attempt: 3, finalError: "x" },
		});
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "x" });
	});

	it("a pre-welcome error (hello rejection, e.g. protocol mismatch) ends the session with the host's reason", () => {
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest({
			t: "error",
			message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${COLLAB_PROTO - 1}`,
		});
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toContain("protocol mismatch");
		expect(snap.endedReason).toContain(`v${COLLAB_PROTO}`);
	});

	it("tracks host UI requests and sends responses", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
		try {
			const client = liveClient();
			const request = {
				reqId: 7,
				kind: "select" as const,
				title: "Continue?",
				options: ["Yes", { label: "No", description: "Stop here" }],
				selectionMarker: "radio" as const,
			};
			client.applyFrameForTest({ t: "ui-request", request });
			expect(client.getSnapshot().uiRequest).toEqual(request);

			client.sendUiResponse(7, "Yes");
			expect(sent).toEqual([{ t: "ui-response", reqId: 7, value: "Yes" }]);
			expect(client.getSnapshot().uiRequest).toBeNull();
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("claims input only for writable live guests and gates chunks on a matching active lease", async () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "sendRealtime").mockImplementation(async (frame: GuestFrame) => {
			sent.push(frame);
			return true;
		});
		try {
			const client = liveClient();
			const requestId = client.claimLiveInput();
			if (!requestId) throw new Error("expected writable claim");
			expect(sent).toEqual([{ t: "live-input-claim", requestId }]);
			expect(client.getSnapshot().liveInputLease).toMatchObject({ status: "claiming", requestId });
			expect(new GuestClient(LINK, "waiting").claimLiveInput()).toBeNull();
			const readOnly = new GuestClient(LINK, "viewer");
			readOnly.applyFrameForTest(welcomeFrame(0, true));
			expect(readOnly.claimLiveInput()).toBeNull();

			client.applyFrameForTest({ t: "live-input-lease", requestId: "stale", status: "granted", leaseId: "wrong" });
			expect(client.getSnapshot().liveInputLease.status).toBe("claiming");
			client.applyFrameForTest({ t: "live-input-lease", requestId, status: "granted", leaseId: "lease-1" });
			expect(await client.sendLiveInputChunk("lease-1", 0, "A".repeat(854))).toBe(false);
			expect(await client.startLiveInput("lease-1")).toBe(true);
			client.applyFrameForTest({ t: "live-state", active: true, input: "remote" });
			expect(await client.sendLiveInputChunk("lease-1", 0, "A".repeat(853))).toBe(false);
			expect(await client.sendLiveInputChunk("wrong", 0, "A".repeat(854))).toBe(false);
			expect(await client.sendLiveInputChunk("lease-1", 0, "A".repeat(854))).toBe(true);
			expect(sent.at(-1)).toEqual({ t: "live-input-chunk", leaseId: "lease-1", seq: 0, data: "A".repeat(854) });

			client.cancelLiveInputClaim("not-current", "user");
			client.applyFrameForTest({ t: "live-input-lease", requestId, status: "revoked", message: "taken back" });
			expect(await client.sendLiveInputChunk("lease-1", 1, "A".repeat(854))).toBe(false);
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("releases a late grant after a cancelled claim", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "sendRealtime").mockImplementation(async (frame: GuestFrame) => {
			sent.push(frame);
			return true;
		});
		try {
			const client = liveClient();
			const requestId = client.claimLiveInput();
			if (!requestId) throw new Error("expected claim");
			client.cancelLiveInputClaim(requestId, "user");
			client.applyFrameForTest({
				t: "live-input-lease",
				requestId,
				status: "granted",
				leaseId: "late-lease",
			});
			expect(sent.at(-1)).toEqual({ t: "live-input-stop", leaseId: "late-lease", reason: "user" });
			expect(client.getSnapshot().liveInputLease.status).toBe("idle");
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("discards a canceled claim ID when its original send fails", async () => {
		const originalWebSocket = globalThis.WebSocket;
		class RecordingWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			static instances: RecordingWebSocket[] = [];

			binaryType = "arraybuffer";
			bufferedAmount = 0;
			readyState = RecordingWebSocket.CONNECTING;
			onclose: ((event: CloseEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onopen: ((event: Event) => void) | null = null;
			readonly sent: Uint8Array[] = [];
			readonly #sendWaiters: { count: number; resolve: () => void }[] = [];

			constructor(_url: string) {
				RecordingWebSocket.instances.push(this);
			}

			send(data: Uint8Array): void {
				this.sent.push(new Uint8Array(data));
				for (const waiter of [...this.#sendWaiters]) {
					if (this.sent.length < waiter.count) continue;
					this.#sendWaiters.splice(this.#sendWaiters.indexOf(waiter), 1);
					waiter.resolve();
				}
			}

			open(): void {
				this.readyState = RecordingWebSocket.OPEN;
				this.onopen?.(new Event("open"));
			}

			close(_code?: number): void {
				this.readyState = RecordingWebSocket.CLOSED;
				this.onclose?.({ code: 1000, reason: "closed" } as CloseEvent);
			}

			waitForSends(count: number): Promise<void> {
				if (this.sent.length >= count) return Promise.resolve();
				const { promise, resolve } = Promise.withResolvers<void>();
				this.#sendWaiters.push({ count, resolve });
				return promise;
			}
		}

		globalThis.WebSocket = RecordingWebSocket as unknown as typeof WebSocket;
		const client = liveClient();
		try {
			const requestId = client.claimLiveInput();
			if (!requestId) throw new Error("expected claim");
			client.cancelLiveInputClaim(requestId, "user");
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			client.connect();
			const ws = RecordingWebSocket.instances[0];
			if (!ws) throw new Error("expected guest socket");
			ws.open();
			await ws.waitForSends(1);

			client.applyFrameForTest({
				t: "live-input-lease",
				requestId,
				status: "granted",
				leaseId: "late-lease",
			});
			client.sendPrompt("barrier");
			await ws.waitForSends(2);

			const sent = ws.sent[1];
			if (!sent) throw new Error("expected encrypted prompt");
			const envelope = unpackEnvelope(sent);
			if (!envelope) throw new Error("expected valid encrypted prompt envelope");
			const key = await importRoomKey(new Uint8Array(32));
			expect(await open(key, envelope.payload)).toEqual({ t: "prompt", text: "barrier" });
		} finally {
			client.close();
			globalThis.WebSocket = originalWebSocket;
		}
	});

	it("clears pending host UI requests when the host ends them", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "ui-request",
			request: { reqId: 8, kind: "editor", title: "Other", prefill: "draft" },
		});
		expect(client.getSnapshot().uiRequest?.reqId).toBe(8);
		client.applyFrameForTest({ t: "ui-request-end", reqId: 8 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("queues overlapping host UI requests until the active one resolves", () => {
		const client = liveClient();
		const first = { reqId: 9, kind: "select" as const, title: "First?", options: ["A"] };
		const second = { reqId: 10, kind: "editor" as const, title: "Second?", prefill: "draft" };
		client.applyFrameForTest({ t: "ui-request", request: first });
		client.applyFrameForTest({ t: "ui-request", request: second });
		expect(client.getSnapshot().uiRequest).toEqual(first);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 9 });
		expect(client.getSnapshot().uiRequest).toEqual(second);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 10 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("delivers live output outside the React snapshot subscription", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		let snapshotNotifications = 0;
		const received: HostFrame[] = [];
		const unsubscribeSnapshot = client.subscribe(() => {
			snapshotNotifications++;
		});
		const unsubscribeOutput = client.subscribeLiveOutput(frame => {
			received.push(frame);
		});
		const frame: HostFrame = {
			t: "live-output-chunk",
			leaseId: "lease-1",
			seq: 0,
			format: "pcm_s16le",
			sampleRate: 48_000,
			channels: 1,
			frameSamples: 1,
			data: "AAA",
		};

		client.applyFrameForTest(frame);
		expect(received).toEqual([frame]);
		expect(snapshotNotifications).toBe(0);
		expect(client.getSnapshot()).toBe(before);
		unsubscribeOutput();
		unsubscribeSnapshot();
	});
	it("snapshot reference is stable between frames and replaced per frame", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		expect(client.getSnapshot()).toBe(before);
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		const after = client.getSnapshot();
		expect(after).not.toBe(before);
		expect(after.agents).not.toBe(before.agents);
		expect(after.entries).toBe(before.entries);
	});
});
