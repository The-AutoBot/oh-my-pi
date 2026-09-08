import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveVisualizer } from "@oh-my-pi/pi-coding-agent/live/visualizer";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

/** Fake InteractiveModeContext plus typed capture channels for focus/mount traffic. */
interface ContextHarness {
	ctx: InteractiveModeContext;
	/** The editor stub the controller must restore after live mode ends. */
	editor: unknown;
	/** Every component handed to `ui.setFocus`, in order. */
	focused: unknown[];
	/** Every component handed to `editorContainer.addChild`, in order. */
	mounted: unknown[];
	/** Resolves when `ui.setFocus` sees the original editor again. */
	editorRefocused: Promise<void>;
}

function createContext(): ContextHarness {
	const editor = {
		getUseTerminalCursor: vi.fn(() => true),
		setUseTerminalCursor: vi.fn(),
	};
	const focused: unknown[] = [];
	const mounted: unknown[] = [];
	const refocused = Promise.withResolvers<void>();
	const ctx = {
		settings: Settings.isolated({ "live.voice": "vale" }),
		keybindings: { getKeys: vi.fn(() => ["ctrl+l"]) },
		session: {},
		extractAssistantText: vi.fn(() => ""),
		editor,
		editorContainer: {
			clear: vi.fn(),
			addChild: vi.fn((component: unknown) => {
				mounted.push(component);
			}),
		},
		ui: {
			getShowHardwareCursor: vi.fn(() => true),
			setShowHardwareCursor: vi.fn(),
			setFocus: vi.fn((component: unknown) => {
				focused.push(component);
				if (component === editor) refocused.resolve();
			}),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		showError: vi.fn(),
		chatContainer: { children: [] },
		present: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, focused, mounted, editorRefocused: refocused.promise };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("forwards the selected voice and local input across the live-session boundary", async () => {
		const { ctx } = createContext();
		let receivedVoice: string | undefined;
		let receivedInput: "local" | "remote" | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedVoice = options.voice;
			receivedInput = options.input;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(receivedVoice).toBe("vale");
			expect(receivedInput).toBe("local");
		} finally {
			await controller.stop();
		}
	});

	it("starts, feeds, and stops an explicit remote input session without selecting host-local capture", async () => {
		const { ctx } = createContext();
		let receivedInput: "local" | "remote" | undefined;
		const pushedFrames: Float32Array[] = [];
		const controller = new LiveCommandController(ctx, options => {
			receivedInput = options.input;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			vi.spyOn(session, "pushRemoteAudio").mockImplementation(frame => {
				pushedFrames.push(frame);
				return true;
			});
			return session;
		});
		const samples = new Float32Array([0.25, -0.5]);

		try {
			expect(await controller.startRemoteInput()).toBe(true);
			expect(receivedInput).toBe("remote");
			expect(controller.input).toBe("remote");
			expect(controller.pushRemoteAudio(samples)).toBe(true);
			expect(pushedFrames).toEqual([samples]);
			expect(await controller.stopRemoteInput()).toBe(true);
		} finally {
			await controller.stop();
		}
	});

	it("stops the session and restores the editor when the live-toggle chord hits the focused visualizer", async () => {
		const { ctx, editor, focused, mounted, editorRefocused } = createContext();
		const stop = vi.fn(async () => {});
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockImplementation(stop);
			return session;
		});
		const activeStates: boolean[] = [];
		controller.onActiveChange(active => activeStates.push(active));

		await controller.handleCommand();
		expect(controller.active).toBe(true);

		// The controller replaces and focuses the editor with the visualizer;
		// Ctrl+L must end the call from there, not just from the editor.
		const visualizer = focused[0];
		if (!(visualizer instanceof LiveVisualizer)) {
			throw new Error("expected the controller to focus a LiveVisualizer");
		}
		visualizer.handleInput("\x0c"); // Ctrl+L — the keypress alone must drive teardown
		await editorRefocused;

		expect(stop).toHaveBeenCalled();
		expect(mounted.at(-1)).toBe(editor);
		expect(focused.at(-1)).toBe(editor);
		// `active` stays true until #finish's fire-and-forget settling promise
		// clears; drain microtasks deterministically instead of sleeping.
		for (let i = 0; controller.active && i < 20; i++) await Promise.resolve();
		expect(controller.active).toBe(false);
		expect(activeStates).toEqual([true, false]);
	});

	it("serializes toggles that arrive while a prior session is still settling", async () => {
		const { ctx } = createContext();
		const cleanup = Promise.withResolvers<void>();
		const sessions: LiveSessionController[] = [];
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			const index = sessions.length;
			sessions.push(session);
			vi.spyOn(session, "start").mockResolvedValue();
			if (index === 0) {
				let stopCalls = 0;
				vi.spyOn(session, "stop").mockImplementation(() => {
					stopCalls++;
					return stopCalls === 1 ? Promise.resolve() : cleanup.promise;
				});
			} else {
				vi.spyOn(session, "stop").mockResolvedValue();
			}
			return session;
		});

		await controller.handleCommand();
		await controller.stop();
		const toggles = [controller.handleCommand(), controller.handleCommand()];
		cleanup.resolve();
		await Promise.all(toggles);

		expect(sessions).toHaveLength(2);
	});
});
