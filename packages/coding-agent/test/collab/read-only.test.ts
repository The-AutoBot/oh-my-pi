/**
 * End-to-end contract: a host started with both link variants marks view-link
 * guests read-only in `welcome` and refuses their mutating frames, while
 * full-link guests keep prompt/abort/agent-cmd capability. Runs over an
 * in-process relay + fake WebSocket transport (no real sockets, no handshake
 * or polling latency) that speaks the documented relay forwarding contract,
 * with real AES-GCM sealing — only the TUI context and the network transport
 * are stubbed. One host/relay boots once and is reused; guest frames ride the
 * in-memory transport, so the suite stays fast and time-independent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { LiveInput } from "@oh-my-pi/pi-wire";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// In-memory transport: FakeWebSocket + InMemoryRelay (see ./helpers/in-memory-relay)
// replace the real Bun.serve relay and loopback WebSocket with a zero-latency
// microtask transport. Real CollabSocket / CollabHost run unchanged on top, so
// sealing, enveloping, the hello→welcome handshake, and read-only enforcement
// are all exercised.

interface HostHarness {
	ctx: InteractiveModeContext;
	prompts: { from?: string }[];
	aborts: { count: number };
	live: LiveHarness;
	/** Resolves on the next promptCustomMessage call — no polling. */
	nextPrompt(): Promise<{ from?: string }>;
}

interface DeferredBoolean {
	promise: Promise<boolean>;
	resolve(value: boolean): void;
	reject(reason?: unknown): void;
}

interface LiveHarness {
	active: boolean;
	input: LiveInput;
	toggleCount: number;
	remoteStartCount: number;
	remoteStopCount: number;
	remoteFrames: Float32Array[];
	setActive(active: boolean): void;
	setState(active: boolean, input: LiveInput): void;
	nextRemoteFrame(): Promise<Float32Array>;
	nextRemoteStart(): Promise<void>;
	nextRemoteStop(): Promise<void>;
	emitRemoteOutput(samples: Float32Array): void;
	deferRemoteStart(): DeferredBoolean;
}

/** Minimal InteractiveModeContext double: only the members CollabHost touches. */
function makeHostContext(): HostHarness {
	const prompts: { from?: string }[] = [];
	const aborts = { count: 0 };
	const liveListeners = new Set<(active: boolean, input: LiveInput) => void>();
	const remoteFrameWaiters: ((samples: Float32Array) => void)[] = [];
	const remoteStopWaiters: (() => void)[] = [];
	const remoteStartWaiters: (() => void)[] = [];
	const remoteOutputListeners = new Set<(samples: Float32Array) => void>();
	const remoteStartGate: { current: DeferredBoolean | undefined } = { current: undefined };
	const deferRemoteStart = (): DeferredBoolean => {
		if (remoteStartGate.current) throw new Error("remote start is already deferred");
		const deferred = Promise.withResolvers<boolean>();
		remoteStartGate.current = deferred;
		return deferred;
	};
	const live: LiveHarness = {
		active: false,
		input: "none",
		toggleCount: 0,
		remoteStartCount: 0,
		remoteStopCount: 0,
		remoteFrames: [],
		setActive(active: boolean): void {
			live.setState(active, active ? (live.input === "none" ? "local" : live.input) : "none");
		},
		setState(active: boolean, input: LiveInput): void {
			if (live.active === active && live.input === input) return;
			live.active = active;
			live.input = input;
			for (const listener of liveListeners) listener(active, input);
		},
		nextRemoteFrame(): Promise<Float32Array> {
			const frame = live.remoteFrames.at(-1);
			if (frame) return Promise.resolve(frame);
			const { promise, resolve } = Promise.withResolvers<Float32Array>();
			remoteFrameWaiters.push(resolve);
			return promise;
		},
		nextRemoteStart(): Promise<void> {
			if (live.remoteStartCount > 0) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			remoteStartWaiters.push(resolve);
			return promise;
		},
		nextRemoteStop(): Promise<void> {
			if (live.remoteStopCount > 0) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			remoteStopWaiters.push(resolve);
			return promise;
		},
		emitRemoteOutput(samples: Float32Array): void {
			if (!live.active || live.input !== "remote") return;
			for (const listener of remoteOutputListeners) listener(samples);
		},
		deferRemoteStart,
	};
	const promptWaiters: ((details: { from?: string }) => void)[] = [];
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: (message: { details?: { from?: string } }) => {
				const details = message.details ?? {};
				prompts.push(details);
				for (const waiter of promptWaiters.splice(0)) waiter(details);
				return Promise.resolve();
			},
			abort: () => {
				aborts.count++;
				return Promise.resolve();
			},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		get liveActive(): boolean {
			return live.active;
		},
		get liveInput(): LiveInput {
			return live.input;
		},
		onLiveStateChange: (listener: (active: boolean, input: LiveInput) => void): (() => void) => {
			liveListeners.add(listener);
			return () => liveListeners.delete(listener);
		},
		onRemoteLiveOutput: (listener: (samples: Float32Array) => void): (() => void) => {
			remoteOutputListeners.add(listener);
			return () => remoteOutputListeners.delete(listener);
		},
		handleLiveCommand: async () => {
			live.toggleCount++;
			live.setActive(!live.active);
		},
		startRemoteLiveInput: async () => {
			if (live.active) return false;
			live.remoteStartCount++;
			for (const resolve of remoteStartWaiters.splice(0)) resolve();
			const deferred = remoteStartGate.current;
			remoteStartGate.current = undefined;
			if (deferred && !(await deferred.promise)) return false;
			live.setState(true, "remote");
			return true;
		},
		pushRemoteLiveInput: (samples: Float32Array): boolean => {
			if (!live.active || live.input !== "remote") return false;
			const copy = Float32Array.from(samples);
			live.remoteFrames.push(copy);
			for (const resolve of remoteFrameWaiters.splice(0)) resolve(copy);
			return true;
		},
		stopRemoteLiveInput: async () => {
			if (!live.active || live.input !== "remote") return false;
			live.remoteStopCount++;
			live.setState(false, "none");
			for (const resolve of remoteStopWaiters.splice(0)) resolve();
			return true;
		},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	const nextPrompt = (): Promise<{ from?: string }> => {
		const { promise, resolve } = Promise.withResolvers<{ from?: string }>();
		promptWaiters.push(resolve);
		return promise;
	};
	return { ctx, prompts, aborts, nextPrompt, live };
}

interface TestGuest {
	socket: CollabSocket;
	frames: CollabFrame[];
	nextFrame(): Promise<CollabFrame>;
}

/**
 * Frames the test harness skips: the host's debounced broadcasts (state,
 * agents, entry, event, bus) and the per-peer snapshot-chunk train that
 * follows every welcome. They interleave nondeterministically with the
 * directed welcome/error frames these tests actually assert on.
 */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

/**
 * Raw guest speaking the wire protocol directly. `writeToken` overrides the link's token (e.g. forged).
 * Broadcast frames interleave nondeterministically with directed replies (the post-hello state
 * broadcast races the first prompt's error reply), so `nextFrame` drops them and yields only the
 * welcome/error frames these tests assert on.
 */
async function joinAsGuest(link: string, name: string, writeTokenOverride?: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken =
		writeTokenOverride ?? (parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined);
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const frames: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		frames.push(frame);
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, frames, nextFrame };
}

type LiveInputLeaseFrame = Extract<CollabFrame, { t: "live-input-lease" }>;

async function claimLiveInput(guest: TestGuest, requestId: string): Promise<LiveInputLeaseFrame> {
	guest.socket.send({ t: "live-input-claim", requestId });
	const frame = await guest.nextFrame();
	if (frame.t !== "live-input-lease") throw new Error(`expected live-input-lease, got ${frame.t}`);
	return frame;
}

async function nextLiveOutputChunk(guest: TestGuest): Promise<Extract<CollabFrame, { t: "live-output-chunk" }>> {
	for (;;) {
		const frame = await guest.nextFrame();
		if (frame.t === "live-output-chunk") return frame;
	}
}

// ── Shared host/relay, booted once ──────────────────────────────────────────
// Booting the relay + host and connecting the host socket is the only heavy
// step; it is identical across these cases, so it runs once. Per-test guest
// state is reset in afterEach.

const guestCleanups: (() => void)[] = [];
let harness: HostHarness;
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	harness = makeHostContext();
	host = new CollabHost(harness.ctx);
	// Port is irrelevant: the fake transport routes by the `role` query param.
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	harness.prompts.length = 0;
	harness.aborts.count = 0;
	harness.live.active = false;
	harness.live.input = "none";
	harness.live.toggleCount = 0;
	harness.live.remoteStartCount = 0;
	harness.live.remoteStopCount = 0;
	harness.live.remoteFrames.length = 0;
});

afterAll(async () => {
	// Restore the real transport first so the global is clean even if stop() throws;
	// the host's socket holds its own FakeWebSocket/relay refs, so teardown still works.
	uninstallInMemoryRelay();
	await host.stop("test done");
});

describe("collab read-only links", () => {
	it("welcomes view-link guests read-only and refuses their mutating frames", async () => {
		const { prompts, aborts } = harness;
		expect(host.viewLink).not.toBe(host.link);

		const guest = await joinAsGuest(host.viewLink, "viewer");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBe(true);

		guest.socket.send({ t: "prompt", text: "do something" });
		const promptReply = await guest.nextFrame();
		if (promptReply.t !== "error") throw new Error(`expected error, got ${promptReply.t}`);
		expect(promptReply.message).toContain("read-only");
		expect(prompts).toHaveLength(0);

		guest.socket.send({ t: "abort" });
		const abortReply = await guest.nextFrame();
		expect(abortReply.t).toBe("error");
		expect(aborts.count).toBe(0);
		guest.socket.send({ t: "live-input-claim", requestId: "viewer-claim" });
		const liveReply = await guest.nextFrame();
		if (liveReply.t !== "live-input-lease") throw new Error(`expected live-input-lease, got ${liveReply.t}`);
		expect(liveReply.status).toBe("read-only");
		expect(harness.live.remoteStartCount).toBe(0);

		guest.socket.send({ t: "agent-cmd", cmd: "kill", agentId: "nope" });
		const cmdReply = await guest.nextFrame();
		expect(cmdReply.t).toBe("error");

		expect(host.participants.find(p => p.name === "viewer")?.readOnly).toBe(true);
	});

	it("keeps full write capability for guests holding the write token", async () => {
		const { prompts, nextPrompt } = harness;

		const guest = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBeUndefined();
		expect(harness.live.remoteStartCount).toBe(0);

		const prompted = nextPrompt();
		guest.socket.send({ t: "prompt", text: "real prompt" });
		expect(await prompted).toEqual({ from: "writer" });
		expect(prompts).toHaveLength(1);
		expect(host.participants.find(p => p.name === "writer")?.readOnly).toBeUndefined();
	});

	it("routes a leased browser microphone through remote live input and broadcasts its source", async () => {
		const guest = await joinAsGuest(host.link, "remote-mic");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.liveInput).toBe("none");

		const lease = await claimLiveInput(guest, "remote-mic-claim");
		if (lease.status !== "granted" || !lease.leaseId) throw new Error(`expected granted lease, got ${lease.status}`);
		guest.socket.send({
			t: "live-input-start",
			leaseId: lease.leaseId,
			format: "pcm_s16le",
			sampleRate: 16_000,
			channels: 1,
			frameSamples: 320,
		});
		expect(await guest.nextFrame()).toEqual({ t: "live-state", active: true, input: "remote" });
		expect(harness.live.remoteStartCount).toBe(1);

		const pcm = Buffer.alloc(640);
		pcm.writeInt16LE(-32_768, 0);
		pcm.writeInt16LE(16_384, 2);
		const received = harness.live.nextRemoteFrame();
		guest.socket.send({ t: "live-input-chunk", leaseId: lease.leaseId, seq: 0, data: pcm.toString("base64url") });
		const samples = await received;
		expect(samples[0]).toBe(-1);
		expect(samples[1]).toBeCloseTo(0.5);
		expect(samples[2]).toBe(0);

		guest.socket.send({ t: "live-input-stop", leaseId: lease.leaseId, reason: "user" });
		expect(await guest.nextFrame()).toEqual({ t: "live-state", active: false, input: "none" });
		expect(harness.live.remoteStopCount).toBe(1);
	});

	it("revokes a downgraded peer and stops a remote start that completes after revocation", async () => {
		const guest = await joinAsGuest(host.link, "remote-downgrade");
		guestCleanups.push(() => guest.socket.close());
		await guest.nextFrame();

		const deferredStart = harness.live.deferRemoteStart();
		const lease = await claimLiveInput(guest, "remote-downgrade-claim");
		if (lease.status !== "granted" || !lease.leaseId) throw new Error(`expected granted lease, got ${lease.status}`);
		const started = harness.live.nextRemoteStart();
		guest.socket.send({
			t: "live-input-start",
			leaseId: lease.leaseId,
			format: "pcm_s16le",
			sampleRate: 16_000,
			channels: 1,
			frameSamples: 320,
		});
		await started;
		expect(harness.live.remoteStartCount).toBe(1);

		guest.socket.send({ t: "hello", proto: COLLAB_PROTO, name: "remote-downgrade" });
		const revoked = await guest.nextFrame();
		if (revoked.t !== "live-input-lease") throw new Error(`expected lease revocation, got ${revoked.t}`);
		expect(revoked).toMatchObject({ requestId: "remote-downgrade-claim", status: "revoked" });

		deferredStart.resolve(true);
		await harness.live.nextRemoteStop();
		expect(harness.live).toMatchObject({ active: false, input: "none", remoteStopCount: 1 });
		expect(host.participants.find(participant => participant.name === "remote-downgrade")?.readOnly).toBe(true);
	});

	it("expires abandoned claims and silent active input with short host lease deadlines", async () => {
		await host.stop("isolate short lease deadlines");
		const timeoutHarness = makeHostContext();
		const timeoutHost = new CollabHost(timeoutHarness.ctx, undefined, {
			liveInputClaimTimeoutMs: 250,
			liveInputIdleTimeoutMs: 250,
		});
		await timeoutHost.start("ws://localhost:8787");
		let guest: TestGuest | undefined;
		try {
			guest = await joinAsGuest(timeoutHost.link, "remote-timeout");
			await guest.nextFrame();

			const abandoned = await claimLiveInput(guest, "abandoned-claim");
			expect(abandoned.status).toBe("granted");
			const abandonedExpiry = await guest.nextFrame();
			expect(abandonedExpiry).toMatchObject({
				t: "live-input-lease",
				requestId: "abandoned-claim",
				status: "revoked",
			});

			const lease = await claimLiveInput(guest, "active-timeout");
			if (lease.status !== "granted" || !lease.leaseId)
				throw new Error(`expected granted lease, got ${lease.status}`);
			guest.socket.send({
				t: "live-input-start",
				leaseId: lease.leaseId,
				format: "pcm_s16le",
				sampleRate: 16_000,
				channels: 1,
				frameSamples: 320,
			});
			expect(await guest.nextFrame()).toEqual({ t: "live-state", active: true, input: "remote" });

			const pcm = Buffer.alloc(640).toString("base64url");
			const accepted = timeoutHarness.live.nextRemoteFrame();
			guest.socket.send({ t: "live-input-chunk", leaseId: lease.leaseId, seq: 0, data: pcm });
			await accepted;

			const stopped = timeoutHarness.live.nextRemoteStop();
			const idleExpiry = await guest.nextFrame();
			expect(idleExpiry).toMatchObject({
				t: "live-input-lease",
				requestId: "active-timeout",
				status: "revoked",
			});
			await stopped;
			expect(timeoutHarness.live).toMatchObject({ active: false, input: "none", remoteStopCount: 1 });
		} finally {
			guest?.socket.close();
			await timeoutHost.stop("test cleanup");
			host = new CollabHost(harness.ctx);
			await host.start("ws://localhost:8787");
		}
	});

	it("delivers validated decoded PCM only to the active lease owner and resets output sequencing with the lease", async () => {
		const owner = await joinAsGuest(host.link, "remote-output-owner");
		const observer = await joinAsGuest(host.link, "remote-output-observer");
		guestCleanups.push(
			() => owner.socket.close(),
			() => observer.socket.close(),
		);
		await owner.nextFrame();
		await observer.nextFrame();

		const lease = await claimLiveInput(owner, "remote-output-claim");
		if (lease.status !== "granted" || !lease.leaseId) throw new Error(`expected granted lease, got ${lease.status}`);
		const observerStarted = observer.nextFrame();
		owner.socket.send({
			t: "live-input-start",
			leaseId: lease.leaseId,
			format: "pcm_s16le",
			sampleRate: 16_000,
			channels: 1,
			frameSamples: 320,
		});
		expect(await owner.nextFrame()).toEqual({ t: "live-state", active: true, input: "remote" });
		expect(await observerStarted).toEqual({ t: "live-state", active: true, input: "remote" });

		harness.live.emitRemoteOutput(new Float32Array([-1, -0.5, 0, 0.5, 1, 1.5]));
		const first = await nextLiveOutputChunk(owner);
		expect(first).toMatchObject({
			leaseId: lease.leaseId,
			seq: 0,
			format: "pcm_s16le",
			sampleRate: 48_000,
			channels: 1,
			frameSamples: 6,
		});
		const firstPcm = Buffer.from(first.data, "base64url");
		expect(firstPcm.byteLength).toBe(first.frameSamples * 2);
		expect(Array.from({ length: first.frameSamples }, (_, index) => firstPcm.readInt16LE(index * 2))).toEqual([
			-32_768, -16_384, 0, 16_384, 32_767, 32_767,
		]);
		expect(observer.frames.some(frame => frame.t === "live-output-chunk")).toBe(false);

		harness.live.emitRemoteOutput(new Float32Array([0.25]));
		expect((await nextLiveOutputChunk(owner)).seq).toBe(1);
		harness.live.emitRemoteOutput(new Float32Array());
		harness.live.emitRemoteOutput(new Float32Array(2_881));
		harness.live.emitRemoteOutput(new Float32Array([Number.NaN]));
		harness.live.emitRemoteOutput(new Float32Array([-0.25]));
		expect((await nextLiveOutputChunk(owner)).seq).toBe(2);

		owner.socket.send({ t: "live-input-stop", leaseId: lease.leaseId, reason: "user" });
		expect(await owner.nextFrame()).toEqual({ t: "live-state", active: false, input: "none" });
		const outputCountAfterStop = owner.frames.filter(frame => frame.t === "live-output-chunk").length;
		harness.live.emitRemoteOutput(new Float32Array([0.75]));
		for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
		expect(owner.frames.filter(frame => frame.t === "live-output-chunk")).toHaveLength(outputCountAfterStop);

		const nextLease = await claimLiveInput(owner, "remote-output-reset");
		if (nextLease.status !== "granted" || !nextLease.leaseId) {
			throw new Error(`expected replacement lease, got ${nextLease.status}`);
		}
		owner.socket.send({
			t: "live-input-start",
			leaseId: nextLease.leaseId,
			format: "pcm_s16le",
			sampleRate: 16_000,
			channels: 1,
			frameSamples: 320,
		});
		expect(await owner.nextFrame()).toEqual({ t: "live-state", active: true, input: "remote" });
		harness.live.emitRemoteOutput(new Float32Array([0.125]));
		const reset = await nextLiveOutputChunk(owner);
		expect(reset.leaseId).toBe(nextLease.leaseId);
		expect(reset.seq).toBe(0);

		owner.socket.send({ t: "live-input-stop", leaseId: nextLease.leaseId, reason: "user" });
		expect(await owner.nextFrame()).toEqual({ t: "live-state", active: false, input: "none" });
	});

	it("rejects malformed remote input metadata, malformed data, and nonmonotonic or stale chunks", async () => {
		const guest = await joinAsGuest(host.link, "remote-validator");
		guestCleanups.push(() => guest.socket.close());
		await guest.nextFrame();

		const lease = await claimLiveInput(guest, "remote-validator-claim");
		if (lease.status !== "granted" || !lease.leaseId) throw new Error(`expected granted lease, got ${lease.status}`);
		guest.socket.send({
			t: "live-input-start",
			leaseId: lease.leaseId,
			format: "pcm_s16le",
			sampleRate: 48_000 as 16_000,
			channels: 1,
			frameSamples: 320,
		});
		const malformedStart = await guest.nextFrame();
		expect(malformedStart.t).toBe("error");
		expect(harness.live.remoteStartCount).toBe(0);

		guest.socket.send({
			t: "live-input-start",
			leaseId: lease.leaseId,
			format: "pcm_s16le",
			sampleRate: 16_000,
			channels: 1,
			frameSamples: 320,
		});
		expect(await guest.nextFrame()).toEqual({ t: "live-state", active: true, input: "remote" });

		const pcm = Buffer.alloc(640);
		const received = harness.live.nextRemoteFrame();
		guest.socket.send({ t: "live-input-chunk", leaseId: lease.leaseId, seq: 3, data: pcm.toString("base64url") });
		await received;
		guest.socket.send({ t: "live-input-chunk", leaseId: lease.leaseId, seq: 3, data: pcm.toString("base64url") });
		const replay = await guest.nextFrame();
		expect(replay.t).toBe("error");
		guest.socket.send({ t: "live-input-chunk", leaseId: lease.leaseId, seq: 4, data: "not-base64url-audio" });
		const malformedChunk = await guest.nextFrame();
		expect(malformedChunk.t).toBe("error");
		expect(harness.live.remoteFrames).toHaveLength(1);

		guest.socket.send({ t: "live-input-stop", leaseId: lease.leaseId, reason: "track-ended" });
		expect(await guest.nextFrame()).toEqual({ t: "live-state", active: false, input: "none" });
		guest.socket.send({ t: "live-input-chunk", leaseId: lease.leaseId, seq: 5, data: pcm.toString("base64url") });
		const staleChunk = await guest.nextFrame();
		expect(staleChunk.t).toBe("error");
	});

	it("atomically grants one concurrent claim and stops remote live input when its owner disconnects", async () => {
		const first = await joinAsGuest(host.link, "remote-first");
		const second = await joinAsGuest(host.link, "remote-second");
		guestCleanups.push(
			() => first.socket.close(),
			() => second.socket.close(),
		);
		await first.nextFrame();
		await second.nextFrame();

		const [firstLease, secondLease] = await Promise.all([
			claimLiveInput(first, "concurrent-first"),
			claimLiveInput(second, "concurrent-second"),
		]);
		expect([firstLease.status, secondLease.status].sort()).toEqual(["busy", "granted"]);
		const owner = firstLease.status === "granted" ? first : second;
		const observer = owner === first ? second : first;
		const ownerLease = firstLease.status === "granted" ? firstLease : secondLease;
		if (!ownerLease.leaseId) throw new Error("granted claim did not include a lease id");

		const observerRemoteState = observer.nextFrame();
		owner.socket.send({
			t: "live-input-start",
			leaseId: ownerLease.leaseId,
			format: "pcm_s16le",
			sampleRate: 16_000,
			channels: 1,
			frameSamples: 320,
		});
		expect(await owner.nextFrame()).toEqual({ t: "live-state", active: true, input: "remote" });
		expect(await observerRemoteState).toEqual({ t: "live-state", active: true, input: "remote" });

		const observerIdleState = observer.nextFrame();
		const stopped = harness.live.nextRemoteStop();
		owner.socket.close();
		await stopped;
		expect(await observerIdleState).toEqual({ t: "live-state", active: false, input: "none" });
		expect(harness.live.remoteStopCount).toBe(1);

		const retryLease = await claimLiveInput(observer, "after-disconnect");
		if (retryLease.status !== "granted" || !retryLease.leaseId) {
			throw new Error(`expected released lease after disconnect, got ${retryLease.status}`);
		}
		observer.socket.send({
			t: "live-input-start",
			leaseId: retryLease.leaseId,
			format: "pcm_s16le",
			sampleRate: 16_000,
			channels: 1,
			frameSamples: 320,
		});
		expect(await observer.nextFrame()).toEqual({ t: "live-state", active: true, input: "remote" });
		observer.socket.send({ t: "live-input-stop", leaseId: retryLease.leaseId, reason: "transport" });
		expect(await observer.nextFrame()).toEqual({ t: "live-state", active: false, input: "none" });
	});

	it("keeps a remotely killed subagent tombstoned", async () => {
		const guest = await joinAsGuest(host.link, "writer-kill");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		const id = "Remote-Killed-Sub";
		const registry = AgentRegistry.global();
		let aborts = 0;

		const session = {
			abort: async () => {
				aborts++;
			},
			dispose: async () => {},
		} as unknown as AgentSession;
		const ref = registry.register({
			id,
			displayName: "remote kill",
			kind: "sub",
			session,
			sessionFile: "/tmp/Remote-Killed-Sub.jsonl",
			status: "running",
		});
		const killed = Promise.withResolvers<void>();
		const unsubscribe = registry.onChange(event => {
			if (event.ref === ref && event.type === "status_changed" && event.ref.status === "aborted") killed.resolve();
		});
		try {
			guest.socket.send({ t: "agent-cmd", cmd: "kill", agentId: id });
			await killed.promise;
			expect(aborts).toBe(1);
			expect(registry.get(id)).toMatchObject({ status: "aborted", session: null });
		} finally {
			unsubscribe();
			registry.unregister(id, ref);
		}
	});

	it("includes live state in welcome and broadcasts subsequent transitions", async () => {
		harness.live.setState(true, "local");
		const guest = await joinAsGuest(host.viewLink, "live-viewer");
		guestCleanups.push(() => guest.socket.close());

		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.liveActive).toBe(true);
		expect(welcome.liveInput).toBe("local");

		harness.live.setState(false, "none");
		expect(await guest.nextFrame()).toEqual({ t: "live-state", active: false, input: "none" });
	});

	it("routes host UI requests to write guests and resolves their response", async () => {
		const guest = await joinAsGuest(host.link, "writer-ui");
		guestCleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		const pending = host.requestGuestUi({ kind: "select", title: "Continue?", options: ["Yes"] });
		if (!pending) throw new Error("expected writable guest UI request");
		const request = await guest.nextFrame();
		if (request.t !== "ui-request") throw new Error(`expected ui-request, got ${request.t}`);
		expect(request.request).toMatchObject({ kind: "select", title: "Continue?", options: ["Yes"] });

		guest.socket.send({ t: "ui-response", reqId: request.request.reqId, value: "Yes" });
		expect(await pending).toEqual({ kind: "answered", value: "Yes" });
		const end = await guest.nextFrame();
		expect(end).toEqual({ t: "ui-request-end", reqId: request.request.reqId });
	});

	it("replays pending host UI requests to writable guests that join later", async () => {
		const firstGuest = await joinAsGuest(host.link, "writer-ui-first");
		guestCleanups.push(() => firstGuest.socket.close());
		const firstWelcome = await firstGuest.nextFrame();
		if (firstWelcome.t !== "welcome") throw new Error(`expected welcome, got ${firstWelcome.t}`);

		const pending = host.requestGuestUi({ kind: "editor", title: "Pending?", prefill: "draft" });
		if (!pending) throw new Error("expected writable guest UI request");
		const firstRequest = await firstGuest.nextFrame();
		if (firstRequest.t !== "ui-request") throw new Error(`expected ui-request, got ${firstRequest.t}`);

		const secondGuest = await joinAsGuest(host.link, "writer-ui-second");
		guestCleanups.push(() => secondGuest.socket.close());
		const secondWelcome = await secondGuest.nextFrame();
		if (secondWelcome.t !== "welcome") throw new Error(`expected welcome, got ${secondWelcome.t}`);
		const replayed = await secondGuest.nextFrame();
		expect(replayed).toEqual(firstRequest);

		secondGuest.socket.send({ t: "ui-response", reqId: firstRequest.request.reqId, value: "late" });
		expect(await pending).toEqual({ kind: "answered", value: "late" });
	});

	it("treats a forged write token as read-only", async () => {
		const { prompts } = harness;

		// A viewer knows the room key but not the token; garbage must not escalate.
		const forged = Buffer.alloc(16, 0xab).toString("base64url");
		const guest = await joinAsGuest(host.viewLink, "forger", forged);
		guestCleanups.push(() => guest.socket.close());

		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.readOnly).toBe(true);

		guest.socket.send({ t: "prompt", text: "escalation attempt" });
		const reply = await guest.nextFrame();
		expect(reply.t).toBe("error");
		expect(prompts).toHaveLength(0);
	});
});
