import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { StreamRow } from "@oh-my-pi/pi-wire";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { streamSocketEndpoint } from "@oh-my-pi/pi-coding-agent/stream/paths";
import { STREAM_LOCAL_PROTO, type StreamSessionFrame } from "@oh-my-pi/pi-coding-agent/stream/protocol";
import { StreamRedactor } from "@oh-my-pi/pi-coding-agent/stream/redactor";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

type HelloFrame = Extract<StreamSessionFrame, { t: "hello" }>;

type Fixture = {
	mode: InteractiveMode;
	session: AgentSession;
	sessionManager: SessionManager;
	cwd: string;
	cleanup(): Promise<void>;
};

type FrameWaiter = {
	start: number;
	matches(frame: StreamSessionFrame): boolean;
	resolve(frame: StreamSessionFrame): void;
	reject(error: Error): void;
};

class StreamPeer {
	readonly frames: StreamSessionFrame[] = [];
	readonly hello: Promise<HelloFrame>;
	readonly closed: Promise<void>;
	#input = "";
	#socket: net.Socket;
	#welcomeOnHello: boolean;
	#hello = Promise.withResolvers<HelloFrame>();
	#closed = Promise.withResolvers<void>();
	#receivedHello = false;
	#frameWaiters: FrameWaiter[] = [];
	#viewport: StreamRow[] = [];

	constructor(socket: net.Socket, welcomeOnHello: boolean) {
		this.#socket = socket;
		this.#welcomeOnHello = welcomeOnHello;
		this.hello = this.#hello.promise;
		this.closed = this.#closed.promise;
		socket.on("data", chunk => this.#read(chunk.toString("utf8")));
		socket.on("error", () => {});
		socket.once("end", () => socket.destroy());
		socket.once("close", () => {
			this.#closed.resolve();
			if (!this.#receivedHello) this.#hello.reject(new Error("stream peer closed before hello"));
			for (const waiter of this.#frameWaiters.splice(0)) waiter.reject(new Error("stream peer closed before frame"));
		});
	}

	#read(chunk: string): void {
		this.#input += chunk;
		for (;;) {
			const newline = this.#input.indexOf("\n");
			if (newline < 0) return;
			const line = this.#input.slice(0, newline);
			this.#input = this.#input.slice(newline + 1);
			if (!line) continue;
			let frame: StreamSessionFrame;
			try {
				frame = JSON.parse(line) as StreamSessionFrame;
			} catch {
				continue;
			}
			this.#applyFrame(frame);
			const index = this.frames.push(frame) - 1;
			for (let waiterIndex = this.#frameWaiters.length - 1; waiterIndex >= 0; waiterIndex--) {
				const waiter = this.#frameWaiters[waiterIndex]!;
				if (index < waiter.start || !waiter.matches(frame)) continue;
				this.#frameWaiters.splice(waiterIndex, 1);
				waiter.resolve(frame);
			}
			if (frame.t !== "hello" || this.#receivedHello) continue;
			this.#receivedHello = true;
			this.#hello.resolve(frame);
			if (this.#welcomeOnHello) this.sendWelcome();
		}
	}
	#applyFrame(frame: StreamSessionFrame): void {
		switch (frame.t) {
			case "resize":
				if (this.#viewport.length > frame.rows) this.#viewport.length = frame.rows;
				while (this.#viewport.length < frame.rows) this.#viewport.push("");
				return;
			case "viewport":
				this.#viewport = frame.rows.slice();
				return;
			case "patch":
				if (this.#viewport.length > frame.rows) this.#viewport.length = frame.rows;
				while (this.#viewport.length < frame.rows) this.#viewport.push("");
				for (const [index, row] of frame.ops) {
					if (index >= 0 && index < frame.rows) this.#viewport[index] = row;
				}
				return;
			case "reset":
				this.#viewport = [];
				return;
			case "hello":
			case "history":
			case "paused":
				return;
		}
	}

	renderedViewport(): string {
		return Bun.stripANSI(this.#viewport.join("\n"));
	}

	waitForFrame(matches: (frame: StreamSessionFrame) => boolean, start = 0): Promise<StreamSessionFrame> {
		for (let index = start; index < this.frames.length; index++) {
			const frame = this.frames[index]!;
			if (matches(frame)) return Promise.resolve(frame);
		}
		const waiter = Promise.withResolvers<StreamSessionFrame>();
		this.#frameWaiters.push({ start, matches, ...waiter });
		return waiter.promise;
	}
	async waitForRenderedViewport(matches: (viewport: string) => boolean, start = 0): Promise<string> {
		let matchedViewport: string | undefined;
		await this.waitForFrame(frame => {
			if (frame.t !== "viewport" && frame.t !== "patch" && frame.t !== "reset") return false;
			const viewport = this.renderedViewport();
			if (!matches(viewport)) return false;
			matchedViewport = viewport;
			return true;
		}, start);
		if (matchedViewport === undefined) throw new Error("rendered viewport matched without a snapshot");
		return matchedViewport;
	}

	sendWelcome(): void {
		if (this.#socket.destroyed) return;
		this.#socket.write(
			`${JSON.stringify({ t: "welcome", proto: STREAM_LOCAL_PROTO, channel: "test", url: "test" })}\n`,
		);
	}
}

class StreamServer {
	#endpoint: string;
	#server: net.Server;
	#queuedPeers: StreamPeer[] = [];
	#allPeers = new Set<StreamPeer>();
	#sockets = new Set<net.Socket>();
	#peerWaiters: PromiseWithResolvers<StreamPeer>[] = [];
	#welcomeOnHello: boolean;
	#closed = false;

	constructor(endpoint: string, welcomeOnHello: boolean) {
		this.#endpoint = endpoint;
		this.#welcomeOnHello = welcomeOnHello;
		this.#server = net.createServer(socket => this.#accept(socket));
	}

	static async start(cwd: string, options: { welcomeOnHello?: boolean } = {}): Promise<StreamServer> {
		await fs.mkdir(cwd, { recursive: true });
		const endpoint = await streamSocketEndpoint(cwd, { create: true });
		await fs.rm(endpoint, { force: true });
		const server = new StreamServer(endpoint, options.welcomeOnHello ?? true);
		const listening = Promise.withResolvers<void>();
		server.#server.listen(endpoint, listening.resolve);
		await listening.promise;
		activeStreamServers.add(server);
		return server;
	}

	get peerCount(): number {
		return this.#allPeers.size;
	}

	#accept(socket: net.Socket): void {
		const peer = new StreamPeer(socket, this.#welcomeOnHello);
		this.#allPeers.add(peer);
		this.#sockets.add(socket);
		socket.once("close", () => this.#sockets.delete(socket));
		void peer.closed.finally(() => this.#allPeers.delete(peer));
		const waiter = this.#peerWaiters.shift();
		if (waiter) waiter.resolve(peer);
		else this.#queuedPeers.push(peer);
	}

	nextPeer(): Promise<StreamPeer> {
		const peer = this.#queuedPeers.shift();
		if (peer) return Promise.resolve(peer);
		const waiter = Promise.withResolvers<StreamPeer>();
		this.#peerWaiters.push(waiter);
		return waiter.promise;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		activeStreamServers.delete(this);
		for (const socket of this.#sockets) socket.destroy();
		for (const waiter of this.#peerWaiters.splice(0)) waiter.reject(new Error("stream server closed before peer"));
		const closed = Promise.withResolvers<void>();
		this.#server.close(error => {
			if (error) {
				closed.reject(error);
			} else {
				closed.resolve();
			}
		});
		await closed.promise;
		await fs.rm(this.#endpoint, { force: true });
	}
}

const activeFixtures = new Set<Fixture>();
const activeStreamServers = new Set<StreamServer>();

async function createFixture(): Promise<Fixture> {
	const originalProjectDir = getProjectDir();
	const tempDir = TempDir.createSync("@pi-interactive-mode-stream-");
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const authStorage: AuthStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		}),
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
	});
	const mode = new InteractiveMode(session, "test", undefined, () => {}, [], undefined, undefined);
	vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	let cleaned = false;
	const fixture: Fixture = {
		mode,
		session,
		sessionManager,
		cwd: tempDir.path(),
		cleanup: async () => {
			if (cleaned) return;
			cleaned = true;
			activeFixtures.delete(fixture);
			let stopped = false;
			try {
				if (mode.isInitialized) {
					mode.stop();
					stopped = true;
				}
			} finally {
				if (!stopped) mode.ui.stop();
				try {
					await session.dispose();
				} finally {
					authStorage.close();
					try {
						setProjectDir(originalProjectDir);
					} finally {
						await tempDir.remove();
					}
				}
			}
		},
	};
	activeFixtures.add(fixture);
	return fixture;
}

async function createTargetSession(cwd: string): Promise<{ sessionFile: string; sessionId: string }> {
	await fs.mkdir(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, cwd);
	manager.appendMessage({ role: "user", content: "target", timestamp: 1 });
	await manager.ensureOnDisk();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected target session file");
	const sessionId = manager.getSessionId();
	await manager.close();
	return { sessionFile, sessionId };
}

describe("InteractiveMode stream lifecycle", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		vi.spyOn(tinyTitleClient, "prewarm").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
	});

	afterEach(async () => {
		let cleanupError: unknown;
		for (const fixture of [...activeFixtures]) {
			try {
				await fixture.cleanup();
			} catch (error) {
				cleanupError ??= error;
			}
		}
		for (const streamer of [...activeStreamServers]) {
			try {
				await streamer.close();
			} catch (error) {
				cleanupError ??= error;
			}
		}
		vi.restoreAllMocks();
		resetSettingsForTest();
		if (cleanupError !== undefined) throw cleanupError;
	});

	it("does not publish a protected candidate until protected activation succeeds", async () => {
		const fixture = await createFixture();
		const streamer = await StreamServer.start(fixture.cwd);
		try {
			await fixture.mode.init({ holdControls: true, holdSubmit: true });
			expect(streamer.peerCount).toBe(0);

			expect(fixture.mode.releaseAutoBotProtectedStartupControls()).toBe(true);
			const peer = await streamer.nextPeer();
			expect(await peer.hello).toMatchObject({ sessionId: fixture.sessionManager.getSessionId() });
		} finally {
			await fixture.cleanup();
			await streamer.close();
		}
	});

	it("never opens a stream publisher when protected startup exits before activation", async () => {
		const fixture = await createFixture();
		const streamer = await StreamServer.start(fixture.cwd);
		try {
			await fixture.mode.init({ holdControls: true, holdSubmit: true });
			await fixture.mode.shutdown();

			expect(fixture.mode.isAutoBotProtectedStartupExitRequested()).toBe(true);
			expect(fixture.mode.releaseAutoBotProtectedStartupControls()).toBe(false);
			expect(streamer.peerCount).toBe(0);
		} finally {
			await fixture.cleanup();
			await streamer.close();
		}
	});

	it("routes a cross-project transcript only through the target publisher and target redactor", async () => {
		const fixture = await createFixture();
		const sourceStreamer = await StreamServer.start(fixture.cwd);
		const targetCwd = path.join(fixture.cwd, "target-project");
		const targetStreamer = await StreamServer.start(targetCwd);
		try {
			const secret = "target-secret-123456789";
			await Bun.write(path.join(targetCwd, ".env"), `TARGET_STREAM_SECRET=${secret}\n`);
			const target = await createTargetSession(targetCwd);

			await fixture.mode.init();
			const sourcePeer = await sourceStreamer.nextPeer();
			await sourcePeer.waitForFrame(frame => frame.t === "viewport");
			const switched = await fixture.session.switchSession(target.sessionFile, {
				onCwdChange: newCwd => fixture.mode.applyCwdChange(newCwd),
			});
			expect(switched).toBe(true);
			await sourcePeer.closed;

			const targetPeer = await targetStreamer.nextPeer();
			expect(await targetPeer.hello).toMatchObject({ sessionId: target.sessionId });
			await targetPeer.waitForFrame(frame => frame.t === "viewport");
			const targetFrameCount = targetPeer.frames.length;
			const marker = "public redaction arrives";

			fixture.mode.editor.setText(`${marker} ${secret}`);
			const redactedViewport = await targetPeer.waitForRenderedViewport(
				viewport => viewport.includes(marker),
				targetFrameCount,
			);

			expect(redactedViewport).toContain(marker);
			expect(redactedViewport).not.toContain(secret);
		} finally {
			await fixture.cleanup();
			await sourceStreamer.close();
			await targetStreamer.close();
		}
	});

	it("keeps the target publisher attached when a stale source handshake finishes later", async () => {
		const fixture = await createFixture();
		const sourceStreamer = await StreamServer.start(fixture.cwd);
		const targetCwd = path.join(fixture.cwd, "target-project");
		const targetStreamer = await StreamServer.start(targetCwd);
		const sourceRedactorGate = Promise.withResolvers<void>();
		const sourceRedactorStarted = Promise.withResolvers<void>();
		try {
			const sourceCwd = path.resolve(fixture.cwd);
			const loadRedactor = StreamRedactor.load;
			vi.spyOn(StreamRedactor, "load").mockImplementation(async (cwd, patterns) => {
				if (path.resolve(cwd) === sourceCwd) {
					sourceRedactorStarted.resolve();
					await sourceRedactorGate.promise;
				}
				return await loadRedactor(cwd, patterns);
			});
			const target = await createTargetSession(targetCwd);

			await fixture.mode.init({ holdControls: true, holdSubmit: true });
			expect(fixture.mode.releaseAutoBotProtectedStartupControls()).toBe(true);
			const sourcePeer = await sourceStreamer.nextPeer();
			await sourcePeer.hello;
			await sourceRedactorStarted.promise;

			expect(
				await fixture.session.switchSession(target.sessionFile, {
					onCwdChange: newCwd => fixture.mode.applyCwdChange(newCwd),
				}),
			).toBe(true);
			const targetPeer = await targetStreamer.nextPeer();
			expect(await targetPeer.hello).toMatchObject({ sessionId: target.sessionId });
			await targetPeer.waitForFrame(frame => frame.t === "viewport");

			sourceRedactorGate.resolve();
			await sourcePeer.closed;

			const targetFrameCount = targetPeer.frames.length;
			const marker = "target publisher remains attached";
			fixture.mode.editor.setText(marker);
			fixture.mode.ui.renderNow();
			expect(
				await targetPeer.waitForRenderedViewport(viewport => viewport.includes(marker), targetFrameCount),
			).toContain(marker);
		} finally {
			sourceRedactorGate.resolve();
			await fixture.cleanup();
			await sourceStreamer.close();
			await targetStreamer.close();
		}
	});

	it("drops a target publisher that completes after streaming has stopped", async () => {
		const fixture = await createFixture();
		const sourceStreamer = await StreamServer.start(fixture.cwd);
		const targetCwd = path.join(fixture.cwd, "target-project");
		const targetStreamer = await StreamServer.start(targetCwd, { welcomeOnHello: false });
		try {
			const target = await createTargetSession(targetCwd);
			await fixture.mode.init();
			await sourceStreamer.nextPeer();
			const switching = fixture.session.switchSession(target.sessionFile, {
				onCwdChange: newCwd => fixture.mode.applyCwdChange(newCwd),
			});

			const targetPeer = await targetStreamer.nextPeer();
			await targetPeer.hello;
			fixture.mode.stop();
			targetPeer.sendWelcome();
			expect(await switching).toBe(true);
			await targetPeer.closed;

			expect(targetPeer.frames).toHaveLength(1);
			expect(targetPeer.frames[0]).toMatchObject({ t: "hello", sessionId: target.sessionId });
		} finally {
			await fixture.cleanup();
			await sourceStreamer.close();
			await targetStreamer.close();
		}
	});

	it("rebinds the source publisher after a cross-project resume rolls back", async () => {
		const fixture = await createFixture();
		const sourceStreamer = await StreamServer.start(fixture.cwd);
		const targetCwd = path.join(fixture.cwd, "target-project");
		try {
			const target = await createTargetSession(targetCwd);
			await fixture.mode.init();
			const sourcePeer = await sourceStreamer.nextPeer();
			const sourceSessionId = (await sourcePeer.hello).sessionId;
			const switched = await fixture.session.switchSession(target.sessionFile, { onCwdChange: async () => false });
			expect(switched).toBe(false);

			const restoredPeer = await sourceStreamer.nextPeer();
			expect(await restoredPeer.hello).toMatchObject({ sessionId: sourceSessionId });
		} finally {
			await fixture.cleanup();
			await sourceStreamer.close();
		}
	});

	it("rebinds the publisher when a same-project new session adopts a new id", async () => {
		const fixture = await createFixture();
		const streamer = await StreamServer.start(fixture.cwd);
		try {
			await fixture.mode.init();
			const sourcePeer = await streamer.nextPeer();
			const sourceSessionId = (await sourcePeer.hello).sessionId;
			expect(await fixture.session.newSession()).toBe(true);

			const nextPeer = await streamer.nextPeer();
			expect((await nextPeer.hello).sessionId).not.toBe(sourceSessionId);
		} finally {
			await fixture.cleanup();
			await streamer.close();
		}
	});
});
