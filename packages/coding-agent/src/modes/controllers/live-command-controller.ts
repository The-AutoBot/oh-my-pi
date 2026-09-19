import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { LiveInput } from "@oh-my-pi/pi-wire";
import {
	LiveSessionController,
	type LiveSessionControllerOptions,
	type LiveSessionInput,
	type LiveTranscript,
} from "../../live/controller";
import { LIVE_MODEL } from "../../live/protocol";
import { LiveVisualizer } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import { vocalizer } from "../../tts/vocalizer";
import type { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import type { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../types";
import { createAssistantMessageComponent } from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";

const ANIMATION_INTERVAL_MS = 80;
type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionController;
type LiveStateListener = (active: boolean, input: LiveInput) => void;
type RemoteOutputListener = (samples: Float32Array) => void;

const LIVE_MESSAGE_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

/** Owns the editor-replacing visualizer and realtime session lifecycle for `/live`. */
export class LiveCommandController {
	readonly #ctx: InteractiveModeContext;
	readonly #createSession: LiveSessionFactory | undefined;

	#activeListeners = new Set<(active: boolean) => void>();
	#liveStateListeners = new Set<LiveStateListener>();
	#remoteOutputListeners = new Set<RemoteOutputListener>();
	#lastEmittedActive = false;
	#lastEmittedInput: LiveInput = "none";
	#commandChain: Promise<void> = Promise.resolve();
	#session: LiveSessionController | undefined;
	#settling: Promise<void> | undefined;
	#visualizer: LiveVisualizer | undefined;
	#detachedEditor: CustomEditor | undefined;
	#animationInterval: NodeJS.Timeout | undefined;
	#previousShowHardwareCursor: boolean | undefined;
	#previousUseTerminalCursor: boolean | undefined;
	#resumeVocalizer: (() => void) | undefined;
	#assistantTranscriptComponent: AssistantMessageComponent | undefined;
	#assistantTranscriptTurn = 0;
	#assistantTranscriptStartedAt = 0;

	constructor(ctx: InteractiveModeContext, createSession?: LiveSessionFactory) {
		this.#ctx = ctx;
		this.#createSession = createSession;
	}

	/** Whether a live session is connected, connecting, or closing. */
	get active(): boolean {
		return this.#session !== undefined || this.#settling !== undefined;
	}

	/** Input currently feeding live mode; closing sessions report no input. */
	get input(): LiveInput {
		return this.#session?.input ?? "none";
	}

	/** Subscribe to transitions of {@link active}. */
	onActiveChange(listener: (active: boolean) => void): () => void {
		this.#activeListeners.add(listener);
		return () => this.#activeListeners.delete(listener);
	}

	/** Subscribe to active/input state changes for collaboration replication. */
	onLiveStateChange(listener: LiveStateListener): () => void {
		this.#liveStateListeners.add(listener);
		return () => this.#liveStateListeners.delete(listener);
	}

	/** Subscribe to decoded assistant PCM from an active remote-input session. */
	onRemoteOutputAudio(listener: RemoteOutputListener): () => void {
		this.#remoteOutputListeners.add(listener);
		return () => this.#remoteOutputListeners.delete(listener);
	}

	/** Start live mode, or stop the currently active session. */
	handleCommand(): Promise<void> {
		const command = this.#commandChain.then(() => this.#handleCommand());
		this.#commandChain = command.catch(() => {});
		return command;
	}

	/**
	 * Starts a live session whose audio is supplied by a remote collab peer.
	 * This never opens the terminal host microphone.
	 */
	startRemoteInput(): Promise<boolean> {
		const command = this.#commandChain.then(() => this.#startRemoteInput());
		this.#commandChain = command.then(
			() => {},
			() => {},
		);
		return command;
	}

	/** Delivers a validated remote audio frame to the active remote session. */
	pushRemoteAudio(samples: Float32Array): boolean {
		const session = this.#session;
		return session?.input === "remote" ? session.pushRemoteAudio(samples) : false;
	}

	/** Stops only a remote-input session, leaving a local `/live` call intact. */
	stopRemoteInput(): Promise<boolean> {
		const command = this.#commandChain.then(async () => {
			const session = this.#session;
			if (session?.input !== "remote") return false;
			await this.stop();
			return true;
		});
		this.#commandChain = command.then(
			() => {},
			() => {},
		);
		return command;
	}

	async #startRemoteInput(): Promise<boolean> {
		if (this.#session || this.#settling) return false;
		return this.#start("remote");
	}

	async #handleCommand(): Promise<void> {
		if (this.#session) {
			await this.stop();
			return;
		}
		if (this.#settling) await this.#settling;
		if (this.#session) {
			await this.stop();
			return;
		}
		await this.#start("local");
	}

	/** Stop the active live session and restore the editor. */
	async stop(): Promise<void> {
		const session = this.#session;
		if (!session) {
			if (this.#settling) await this.#settling;
			return;
		}
		try {
			await session.stop();
		} catch (cause) {
			this.#finish(session, errorFrom(cause));
		} finally {
			this.#finish(session);
		}
	}

	/** Release UI resources during synchronous InteractiveMode teardown. */
	dispose(): void {
		const session = this.#session;
		if (session) {
			this.#finish(session);
			void session.stop().catch(cause => {
				logger.debug("Live session teardown failed", { error: errorFrom(cause).message });
			});
		} else {
			this.#restoreEditor();
		}
	}

	async #start(input: LiveSessionInput): Promise<boolean> {
		this.#assistantTranscriptTurn = 0;
		this.#assistantTranscriptStartedAt = 0;
		const visualizer = new LiveVisualizer({
			onStop: () => {
				void this.stop().catch(cause => this.#ctx.showError(errorFrom(cause).message));
			},
			onToggleMute: () => this.#session?.toggleMute(),
			stopKeys: this.#ctx.keybindings.getKeys("app.live.toggle"),
		});
		this.#mountVisualizer(visualizer);

		const options: LiveSessionControllerOptions = {
			session: this.#ctx.session,
			extractAssistantText: message => this.#ctx.extractAssistantText(message),
			voice: this.#ctx.settings.get("live.voice"),
			input,
			callbacks: {
				onPhase: phase => {
					if (this.#visualizer !== visualizer) return;
					visualizer.setPhase(phase);
					this.#ctx.ui.requestComponentRender(visualizer);
				},
				onLevels: input => {
					if (this.#visualizer !== visualizer) return;
					visualizer.setInputLevel(input);
					this.#ctx.ui.requestComponentRender(visualizer);
				},
				onTranscript: transcript => {
					if (this.#visualizer !== visualizer) return;
					if (!transcript) {
						visualizer.clearTranscript();
						this.#ctx.ui.requestComponentRender(visualizer);
					} else if (transcript.role === "user") {
						visualizer.setTranscript(transcript.text);
						this.#ctx.ui.requestComponentRender(visualizer);
					} else {
						this.#presentAssistantTranscript(transcript);
					}
				},
				onTerminal: error => this.#finish(session, error),
			},
			...(input === "remote"
				? {
						onOutputAudio: (samples: Float32Array) => {
							if (this.#session !== session || session.input !== "remote") return;
							for (const listener of this.#remoteOutputListeners) listener(samples);
						},
						outputMuted: true,
					}
				: {}),
		};
		const session = this.#createSession ? this.#createSession(options) : new LiveSessionController(options);
		this.#session = session;
		this.#emitLiveStateChange();

		try {
			await session.start();
		} catch (cause) {
			if (this.#session === session) {
				try {
					await session.stop();
				} catch (stopCause) {
					logger.debug("Live session cleanup after failed start failed", {
						error: errorFrom(stopCause).message,
					});
				}
				this.#finish(session, errorFrom(cause));
			}
		}
		return this.#session === session;
	}

	#presentAssistantTranscript(transcript: LiveTranscript): void {
		if (
			transcript.turn < this.#assistantTranscriptTurn ||
			(transcript.turn === this.#assistantTranscriptTurn && !this.#assistantTranscriptComponent)
		) {
			return;
		}
		if (transcript.turn > this.#assistantTranscriptTurn) {
			this.#finalizeAssistantTranscript();
			this.#assistantTranscriptTurn = transcript.turn;
		}

		let component = this.#assistantTranscriptComponent;
		if (!component) {
			component = createAssistantMessageComponent(this.#ctx);
			component.setTextColorTransform(text => theme.fg("borderAccent", text));
			this.#assistantTranscriptComponent = component;
			this.#assistantTranscriptStartedAt = Date.now();
		}
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: transcript.text }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: LIVE_MODEL,
			usage: { ...LIVE_MESSAGE_USAGE },
			stopReason: "stop",
			timestamp: this.#assistantTranscriptStartedAt,
		};
		component.updateContent(message, { transient: !transcript.final });
		if (transcript.final) {
			component.markTranscriptBlockFinalized();
			this.#assistantTranscriptComponent = undefined;
			this.#assistantTranscriptStartedAt = 0;
		}
		if (!this.#ctx.chatContainer.children.includes(component)) {
			this.#ctx.present(component);
		} else {
			this.#ctx.ui.requestComponentRender(component);
		}
	}

	#finalizeAssistantTranscript(): void {
		const component = this.#assistantTranscriptComponent;
		if (!component) return;
		component.markTranscriptBlockFinalized();
		this.#assistantTranscriptComponent = undefined;
		this.#assistantTranscriptStartedAt = 0;
		this.#ctx.ui.requestComponentRender(component);
	}

	#mountVisualizer(visualizer: LiveVisualizer): void {
		this.#visualizer = visualizer;
		this.#detachedEditor = this.#ctx.editor;
		this.#previousShowHardwareCursor = this.#ctx.ui.getShowHardwareCursor();
		this.#previousUseTerminalCursor = this.#ctx.editor.getUseTerminalCursor();
		this.#ctx.ui.setShowHardwareCursor(false);
		this.#ctx.editor.setUseTerminalCursor(false);
		this.#ctx.editorContainer.clear();
		this.#ctx.editorContainer.addChild(visualizer);
		this.#ctx.ui.setFocus(visualizer);
		this.#resumeVocalizer = vocalizer.suspend();
		let frame = 0;
		this.#animationInterval = setInterval(() => {
			if (this.#visualizer !== visualizer) return;
			frame += 1;
			visualizer.setFrame(frame);
			this.#ctx.ui.requestComponentRender(visualizer);
		}, ANIMATION_INTERVAL_MS);
		this.#ctx.ui.requestRender();
	}

	#emitActiveChange(): void {
		const active = this.active;
		if (active === this.#lastEmittedActive) return;
		this.#lastEmittedActive = active;
		for (const listener of this.#activeListeners) listener(active);
	}

	#emitLiveStateChange(): void {
		const active = this.active;
		const input = this.input;
		if (active === this.#lastEmittedActive && input === this.#lastEmittedInput) return;
		this.#lastEmittedInput = input;
		for (const listener of this.#liveStateListeners) listener(active, input);
		this.#emitActiveChange();
	}

	#finish(session: LiveSessionController, error?: Error): void {
		if (this.#session !== session) return;
		this.#session = undefined;
		this.#restoreEditor();
		if (error) this.#ctx.showError(error.message);
		const settling = session.stop().catch(cause => {
			logger.debug("Live session cleanup failed", { error: errorFrom(cause).message });
		});
		this.#settling = settling;
		this.#emitLiveStateChange();
		void settling.finally(() => {
			if (this.#settling !== settling) return;
			this.#settling = undefined;
			this.#emitLiveStateChange();
		});
	}

	#restoreEditor(): void {
		this.#finalizeAssistantTranscript();
		if (this.#animationInterval) {
			clearInterval(this.#animationInterval);
			this.#animationInterval = undefined;
		}
		this.#resumeVocalizer?.();
		this.#resumeVocalizer = undefined;
		const editor = this.#detachedEditor;
		this.#detachedEditor = undefined;
		this.#visualizer = undefined;
		if (!editor) return;
		this.#ctx.editorContainer.clear();
		this.#ctx.editorContainer.addChild(editor);
		if (this.#previousShowHardwareCursor !== undefined) {
			this.#ctx.ui.setShowHardwareCursor(this.#previousShowHardwareCursor);
		}
		if (this.#previousUseTerminalCursor !== undefined) {
			editor.setUseTerminalCursor(this.#previousUseTerminalCursor);
		}
		this.#previousShowHardwareCursor = undefined;
		this.#previousUseTerminalCursor = undefined;
		this.#ctx.ui.setFocus(editor);
		this.#ctx.ui.requestRender();
	}
}
