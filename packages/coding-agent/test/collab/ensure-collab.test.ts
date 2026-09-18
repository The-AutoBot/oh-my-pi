import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface RelayData {
	role: "host" | "guest";
}

interface TestRelay {
	url: string;
	hostConnections(): number;
	dropHosts(): void;
	acceptConnections(): void;
	closeHosts(code: number): void;
	stop(): void;
}

/**
 * A real loopback WebSocket endpoint: ensureCollab only needs the relay's
 * connection handshake here, while Bun owns the actual socket lifecycle.
 *
 * The test controls distinguish a retryable close from a fatal room close
 * without replacing the client transport or its reconnect policy.
 */
function startRelay(): TestRelay {
	let hostConnections = 0;
	let acceptingConnections = true;
	const hosts = new Set<{ close(code?: number, reason?: string): void }>();
	const server = Bun.serve<RelayData>({
		port: 0,
		fetch(req, srv): Response | undefined {
			if (!acceptingConnections) return new Response("relay unavailable", { status: 503 });
			const role = new URL(req.url).searchParams.get("role") === "host" ? "host" : "guest";
			if (srv.upgrade(req, { data: { role } })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(ws): void {
				if (ws.data.role === "host") {
					hostConnections++;
					hosts.add(ws);
				}
			},
			close(ws): void {
				hosts.delete(ws);
			},
			message(): void {},
		},
	});
	const closeHosts = (code: number): void => {
		for (const host of hosts) host.close(code, "test relay close");
	};
	return {
		url: `ws://localhost:${server.port}`,
		hostConnections: () => hostConnections,
		dropHosts: () => {
			acceptingConnections = false;
			closeHosts(1011);
		},
		acceptConnections: () => {
			acceptingConnections = true;
		},
		closeHosts,
		stop: () => server.stop(true),
	};
}

describe("ExtensionContext.ensureCollab", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let relay: TestRelay;
	let eventsPath: string;
	let startedGatePath: string;
	let startedEnteredEvent: string;
	let startedReleaseEvent: string;
	let collabEventName: string;

	function waitForCollabEvent(
		predicate: (event: Record<string, unknown>) => boolean,
	): Promise<Record<string, unknown>> {
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		const listener = (event: Record<string, unknown>) => {
			if (!predicate(event)) return;
			process.off(collabEventName, listener);
			resolve(event);
		};
		process.on(collabEventName, listener);
		return promise;
	}

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-ensure-collab-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		relay = startRelay();
		eventsPath = path.join(tempDir.path(), "collab-events.jsonl");
		startedGatePath = path.join(tempDir.path(), "hold-collab-started");
		startedEnteredEvent = `collab-started-entered-${crypto.randomUUID()}`;
		startedReleaseEvent = `collab-started-release-${crypto.randomUUID()}`;
		collabEventName = `collab-event-${crypto.randomUUID()}`;

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));

		const extensionPath = path.join(tempDir.path(), "collab-lifecycle.ts");
		fs.writeFileSync(
			extensionPath,
			`import * as fs from "node:fs";

export default function(pi) {
	const record = event => {
		fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
		process.emit(${JSON.stringify(collabEventName)}, event);
	};
	pi.on("collab_started", async event => {
		record(event);
		if (!fs.existsSync(${JSON.stringify(startedGatePath)})) return;
		process.emit(${JSON.stringify(startedEnteredEvent)});
		const { promise, resolve } = Promise.withResolvers();
		process.once(${JSON.stringify(startedReleaseEvent)}, resolve);
		await promise;
	});
	pi.on("collab_connection_state", record);
	pi.on("collab_stopped", record);
}
`,
		);
		const loaded = await loadExtensions([extensionPath], tempDir.path());
		if (loaded.errors.length > 0) throw new Error(`Failed to load test extension: ${loaded.errors[0]?.error}`);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			Settings.isolated(),
		);
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: runner,
		});
		mode = new InteractiveMode(session, "test");
		await mode.initHooksAndCustomTools();
	});

	afterEach(async () => {
		await mode?.collabHost?.stop("test cleanup");
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		relay?.stop();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("starts one host, reuses its links, and emits each lifecycle event once", async () => {
		const context = session.extensionRunner?.createContext();
		if (!context) throw new Error("Expected interactive extension context");

		const [started, concurrentReuse] = await Promise.all([
			context.ensureCollab({ relayUrl: relay.url, webUrl: "https://dashboard.example.test" }),
			context.ensureCollab({ relayUrl: relay.url, webUrl: "https://ignored.example.test" }),
		]);
		const reused = await context.ensureCollab();
		const links = {
			link: started.link,
			webLink: started.webLink,
			viewLink: started.viewLink,
			webViewLink: started.webViewLink,
		};
		const identity = { hostId: started.hostId, sessionId: started.sessionId };

		expect(context.mode).toBe("tui");
		expect(started.reused).toBe(false);
		expect(concurrentReuse).toEqual({ ...links, ...identity, reused: true });
		expect(reused).toEqual({ ...links, ...identity, reused: true });
		expect(started.link).not.toBe(started.viewLink);
		expect(started.webLink).not.toBe(started.webViewLink);
		expect(relay.hostConnections()).toBe(1);
		const parsed = parseCollabLink(started.link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toStartWith(`${relay.url}/r/`);
		expect(JSON.parse(fs.readFileSync(eventsPath, "utf8"))).toEqual({
			type: "collab_started",
			...links,
			...identity,
		});

		const host = mode.collabHost;
		if (!host) throw new Error("Expected an active collaboration host");
		await host.stop("test complete");
		await host.stop("duplicate stop");

		expect(mode.collabHost).toBeUndefined();
		expect(
			fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line)),
		).toEqual([
			{ type: "collab_started", ...links, ...identity },
			{ type: "collab_stopped", ...links, ...identity, reason: "user" },
		]);
	});

	it("does not retain a host when a guest commits while its connection is starting", async () => {
		const context = session.extensionRunner?.createContext();
		if (!context) throw new Error("Expected interactive extension context");

		const starting = context.ensureCollab({ relayUrl: relay.url });
		const joiningGuest = {} as CollabGuestLink;
		mode.collabGuest = joiningGuest;
		await expect(starting).rejects.toMatchObject({ code: "collab-stopped" });
		expect(mode.collabHost).toBeUndefined();
		expect(mode.collabGuest).toBe(joiningGuest);
		expect(relay.hostConnections()).toBe(0);
		mode.collabGuest = undefined;
	});

	it("rejects a start whose started handler stops the host instead of returning dead links", async () => {
		const context = session.extensionRunner?.createContext();
		if (!context) throw new Error("Expected interactive extension context");

		const enteredStartedHandler = Promise.withResolvers<void>();
		process.once(startedEnteredEvent, () => enteredStartedHandler.resolve());
		fs.writeFileSync(startedGatePath, "");
		const starting = context.ensureCollab({ relayUrl: relay.url });
		await enteredStartedHandler.promise;

		const host = mode.collabHost;
		if (!host) throw new Error("Expected an active collaboration host");
		const stopping = host.stop("extension stopped host", "user");
		process.emit(startedReleaseEvent);
		await stopping;
		await expect(starting).rejects.toMatchObject({ code: "collab-stopped" });
		expect(mode.collabHost).toBeUndefined();
	});

	it("keeps reuse pending across a transient relay drop until the original host reconnects", async () => {
		const context = session.extensionRunner?.createContext();
		if (!context) throw new Error("Expected interactive extension context");
		const started = await context.ensureCollab({ relayUrl: relay.url });

		const reconnecting = waitForCollabEvent(
			event =>
				event.type === "collab_connection_state" &&
				event.state === "reconnecting" &&
				event.hostId === started.hostId &&
				event.sessionId === started.sessionId,
		);
		relay.dropHosts();
		await reconnecting;

		let reuseSettled = false;
		const reuse = context.ensureCollab().then(result => {
			reuseSettled = true;
			return result;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(reuseSettled).toBe(false);

		const reconnected = waitForCollabEvent(
			event =>
				event.type === "collab_connection_state" &&
				event.state === "connected" &&
				event.hostId === started.hostId &&
				event.sessionId === started.sessionId,
		);
		relay.acceptConnections();
		await reconnected;

		await expect(reuse).resolves.toEqual({ ...started, reused: true });
		expect(relay.hostConnections()).toBe(2);
	});

	it("replaces a fatally lost room with a distinct ready host", async () => {
		const context = session.extensionRunner?.createContext();
		if (!context) throw new Error("Expected interactive extension context");
		const original = await context.ensureCollab({ relayUrl: relay.url });
		const originalHost = mode.collabHost;
		if (!originalHost) throw new Error("Expected an active collaboration host");

		const stopped = waitForCollabEvent(
			event =>
				event.type === "collab_stopped" &&
				event.reason === "connection-failed" &&
				event.hostId === original.hostId &&
				event.sessionId === original.sessionId,
		);
		relay.closeHosts(4004);
		await stopped;
		expect(mode.collabHost).toBeUndefined();

		const replacement = await context.ensureCollab({ relayUrl: relay.url });
		expect(replacement.reused).toBe(false);
		expect(replacement.hostId).not.toBe(original.hostId);
		expect(replacement.sessionId).toBe(original.sessionId);
		expect(mode.collabHost?.hostId).toBe(replacement.hostId);
	});

	it("does not reuse an old host after a session boundary", async () => {
		const context = session.extensionRunner?.createContext();
		if (!context) throw new Error("Expected interactive extension context");
		const original = await context.ensureCollab({ relayUrl: relay.url });
		const originalHost = mode.collabHost;
		if (!originalHost) throw new Error("Expected an active collaboration host");

		await session.sessionManager.newSession();
		const stopped = waitForCollabEvent(
			event =>
				event.type === "collab_stopped" &&
				event.reason === "session-switch" &&
				event.hostId === original.hostId &&
				event.sessionId === original.sessionId,
		);
		await expect(context.ensureCollab()).rejects.toMatchObject({ code: "collab-session-changed" });
		await stopped;
		expect(mode.collabHost).toBeUndefined();

		const replacement = await context.ensureCollab({ relayUrl: relay.url });
		expect(replacement.reused).toBe(false);
		expect(replacement.hostId).not.toBe(original.hostId);
		expect(replacement.sessionId).not.toBe(original.sessionId);
		expect(mode.collabHost?.hostId).toBe(replacement.hostId);
	});

	it("rejects a stale start completion after its started handler crosses a session boundary", async () => {
		const context = session.extensionRunner?.createContext();
		if (!context) throw new Error("Expected interactive extension context");
		const enteredStartedHandler = Promise.withResolvers<void>();
		process.once(startedEnteredEvent, () => enteredStartedHandler.resolve());
		fs.writeFileSync(startedGatePath, "");
		const starting = context.ensureCollab({ relayUrl: relay.url });
		await enteredStartedHandler.promise;
		const originalHost = mode.collabHost;
		if (!originalHost) throw new Error("Expected an active collaboration host");

		await session.sessionManager.newSession();
		process.emit(startedReleaseEvent);
		await expect(starting).rejects.toMatchObject({ code: "collab-session-changed" });
		fs.rmSync(startedGatePath);
		expect(mode.collabHost).toBeUndefined();

		const replacement = await context.ensureCollab({ relayUrl: relay.url });
		expect(replacement.reused).toBe(false);
		expect(replacement.hostId).not.toBe(originalHost.hostId);
		expect(replacement.sessionId).not.toBe(originalHost.sessionId);
		expect(mode.collabHost?.hostId).toBe(replacement.hostId);
	});
});
