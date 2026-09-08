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
	stop(): void;
}

/**
 * A real loopback WebSocket endpoint: ensureCollab only needs the relay's
 * connection handshake here, while Bun owns the actual socket lifecycle.
 */
function startRelay(): TestRelay {
	let hostConnections = 0;
	const server = Bun.serve<RelayData>({
		port: 0,
		fetch(req, srv): Response | undefined {
			const role = new URL(req.url).searchParams.get("role") === "host" ? "host" : "guest";
			if (srv.upgrade(req, { data: { role } })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(ws): void {
				if (ws.data.role === "host") hostConnections++;
			},
			message(): void {},
		},
	});
	return {
		url: `ws://localhost:${server.port}`,
		hostConnections: () => hostConnections,
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
	pi.on("collab_started", async event => {
		fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
		if (!fs.existsSync(${JSON.stringify(startedGatePath)})) return;
		process.emit(${JSON.stringify(startedEnteredEvent)});
		const { promise, resolve } = Promise.withResolvers();
		process.once(${JSON.stringify(startedReleaseEvent)}, resolve);
		await promise;
	});
	pi.on("collab_stopped", event => {
		fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
	});
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

		expect(context.mode).toBe("tui");
		expect(started.reused).toBe(false);
		expect(concurrentReuse).toEqual({ ...links, reused: true });
		expect(reused).toEqual({ ...links, reused: true });
		expect(started.link).not.toBe(started.viewLink);
		expect(started.webLink).not.toBe(started.webViewLink);
		expect(relay.hostConnections()).toBe(1);
		const parsed = parseCollabLink(started.link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toStartWith(`${relay.url}/r/`);
		expect(JSON.parse(fs.readFileSync(eventsPath, "utf8"))).toEqual({ type: "collab_started", ...links });

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
			{ type: "collab_started", ...links },
			{ type: "collab_stopped", ...links },
		]);
	});

	it("does not retain a host when a guest commits while its connection is starting", async () => {
		const context = session.extensionRunner?.createContext();
		if (!context) throw new Error("Expected interactive extension context");

		const starting = context.ensureCollab({ relayUrl: relay.url });
		const joiningGuest = {} as CollabGuestLink;
		mode.collabGuest = joiningGuest;

		await expect(starting).rejects.toThrow("Collaboration stopped before the relay connected.");
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
		const stopping = host.stop("extension stopped host");
		process.emit(startedReleaseEvent);
		await stopping;

		await expect(starting).rejects.toThrow("Collaboration stopped while the started handlers were running.");
		expect(mode.collabHost).toBeUndefined();
	});
});
