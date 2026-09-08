import type { GuestSnapshot, LiveInputStopReason } from "./client";
import { encodeBase64Url } from "./link";
import {
	encodePcm16Le,
	FreshAudioQueue,
	isLiveInputSpeech,
	LIVE_INPUT_FRAME_SAMPLES,
	LIVE_INPUT_PCM_BYTES,
	LIVE_INPUT_QUEUE_FRAMES,
	LIVE_INPUT_SAMPLE_RATE,
	type LiveOutputChunk,
	LiveOutputPlayer,
} from "./live-audio";

export type PhoneMicPhase =
	| "idle"
	| "requesting"
	| "waiting"
	| "active"
	| "busy"
	| "permission-denied"
	| "unavailable"
	| "revoked";

export type PhonePlaybackPhase = "locked" | "unlocking" | "ready" | "unavailable";

export interface PhoneMicSnapshot {
	phase: PhoneMicPhase;
	message: string | null;
	playbackPhase: PhonePlaybackPhase;
	playbackMessage: string | null;
}

type LiveInputSnapshot = Pick<GuestSnapshot, "phase" | "readOnly" | "liveActive" | "liveInput" | "liveInputLease">;

export interface LiveInputClient {
	subscribe(listener: () => void): () => void;
	subscribeLiveOutput(listener: (frame: LiveOutputChunk) => void): () => void;
	getSnapshot(): LiveInputSnapshot;
	claimLiveInput(): string | null;
	cancelLiveInputClaim(requestId: string, reason: LiveInputStopReason): void;
	startLiveInput(leaseId: string): Promise<boolean>;
	sendLiveInputChunk(leaseId: string, seq: number, data: string): Promise<boolean>;
	stopLiveInput(leaseId: string, reason: LiveInputStopReason): Promise<boolean>;
}

export interface PhoneMicEnvironment {
	getUserMedia(): Promise<MediaStream>;
	createAudioContext(): AudioContext;
	createWorkletNode(context: AudioContext): AudioWorkletNode;
	readonly workletUrl: string;
	addPageHideListener(listener: () => void): () => void;
}

const IDLE_SNAPSHOT: PhoneMicSnapshot = {
	phase: "idle",
	message: null,
	playbackPhase: "locked",
	playbackMessage: null,
};

/** Browser boundary kept injectable so controller behavior is testable without requesting real permission. */
export function createBrowserPhoneMicEnvironment(): PhoneMicEnvironment {
	return {
		getUserMedia: () =>
			navigator.mediaDevices.getUserMedia({
				audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true },
				video: false,
			}),
		createAudioContext: () => new AudioContext({ latencyHint: "interactive" }),
		createWorkletNode: context =>
			new AudioWorkletNode(context, "omp-live-input", {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [1],
				processorOptions: { targetSampleRate: LIVE_INPUT_SAMPLE_RATE, frameSamples: LIVE_INPUT_FRAME_SAMPLES },
			}),
		workletUrl: new URL("public/live-input-worklet.js", document.baseURI).href,
		addPageHideListener: listener => {
			window.addEventListener("pagehide", listener);
			return () => window.removeEventListener("pagehide", listener);
		},
	};
}

function stopStream(stream: MediaStream): void {
	for (const track of stream.getTracks()) track.stop();
}

export class PhoneMicController {
	readonly #listeners = new Set<() => void>();
	readonly #queue = new FreshAudioQueue<string>(LIVE_INPUT_QUEUE_FRAMES);
	readonly #output: LiveOutputPlayer;
	readonly #client: LiveInputClient;
	readonly #environment: PhoneMicEnvironment;
	#snapshot: PhoneMicSnapshot = IDLE_SNAPSHOT;
	#unsubscribeClient: (() => void) | null = null;
	#unsubscribeLiveOutput: (() => void) | null = null;
	#removePageHide: (() => void) | null = null;
	#operation = 0;
	#requestId: string | null = null;
	#leaseId: string | null = null;
	#stream: MediaStream | null = null;
	#context: AudioContext | null = null;
	#source: MediaStreamAudioSourceNode | null = null;
	#worklet: AudioWorkletNode | null = null;
	#silence: GainNode | null = null;
	#activating = false;
	#pumping = false;
	#sequence = 0;

	constructor(client: LiveInputClient, environment: PhoneMicEnvironment = createBrowserPhoneMicEnvironment()) {
		this.#client = client;
		this.#environment = environment;
		this.#output = new LiveOutputPlayer(message => this.#setPlayback("unavailable", message));
	}

	mount(): () => void {
		if (!this.#unsubscribeClient) this.#unsubscribeClient = this.#client.subscribe(() => this.#syncClient());
		if (!this.#unsubscribeLiveOutput)
			this.#unsubscribeLiveOutput = this.#client.subscribeLiveOutput(frame => this.#handleLiveOutput(frame));
		if (!this.#removePageHide)
			this.#removePageHide = this.#environment.addPageHideListener(() => this.stop("transport"));
		this.#syncClient();
		return () => this.dispose();
	}

	dispose(): void {
		this.#unsubscribeClient?.();
		this.#unsubscribeClient = null;
		this.#unsubscribeLiveOutput?.();
		this.#unsubscribeLiveOutput = null;
		this.#removePageHide?.();
		this.#removePageHide = null;
		this.stop("transport");
		this.#listeners.clear();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	getSnapshot(): PhoneMicSnapshot {
		return this.#snapshot;
	}

	toggle(): void {
		if (
			this.#snapshot.phase === "requesting" ||
			this.#snapshot.phase === "waiting" ||
			this.#snapshot.phase === "active"
		) {
			this.stop("user");
			return;
		}
		this.start();
	}

	/** Retries only playback; an active microphone lease and capture graph stay intact. */
	retryPlayback(): void {
		const context = this.#context;
		if (!context || this.#snapshot.playbackPhase !== "unavailable") return;
		const operation = this.#operation;
		this.#setPlayback("unlocking", null);
		let resumePromise: Promise<void>;
		try {
			// Called directly by the speaker retry button so browser gesture gating is preserved.
			resumePromise = context.resume();
		} catch {
			this.#setPlayback(
				"unavailable",
				"Assistant audio playback is unavailable. Microphone sharing is still active; try the speaker control again.",
			);
			return;
		}
		void resumePromise.then(
			() => {
				if (operation !== this.#operation || context !== this.#context) return;
				if (this.#output.unlock(context)) {
					this.#setPlayback("ready", null);
					this.#syncClient();
				}
			},
			() => {
				if (operation !== this.#operation || context !== this.#context) return;
				this.#setPlayback(
					"unavailable",
					"Assistant audio could not be unlocked. Microphone sharing is still active; try the speaker control again.",
				);
			},
		);
	}

	start(): void {
		const clientSnapshot = this.#client.getSnapshot();
		if (clientSnapshot.readOnly || clientSnapshot.phase !== "live") {
			this.#setSnapshot("unavailable", "Live microphone input is unavailable while disconnected or read-only.");
			return;
		}
		const requestId = this.#client.claimLiveInput();
		if (!requestId) {
			this.#setSnapshot("unavailable", "Live microphone input is not available yet.");
			return;
		}

		const operation = ++this.#operation;
		this.#requestId = requestId;
		this.#leaseId = null;
		this.#sequence = 0;
		this.#setSnapshot("requesting", "Allow microphone access on this device.", "unlocking", null);

		let streamPromise: Promise<MediaStream> | null = null;
		try {
			// Permission is requested only from this explicit start call.
			streamPromise = this.#environment.getUserMedia();
			this.#context = this.#environment.createAudioContext();
			const resumePromise = this.#context.resume();
			void this.#prepareCapture(operation, streamPromise, resumePromise);
		} catch (error) {
			this.#client.cancelLiveInputClaim(requestId, "transport");
			this.#requestId = null;
			if (streamPromise) void streamPromise.then(stopStream, () => {});
			this.#releaseMedia();
			this.#setSnapshot(
				"unavailable",
				error instanceof Error ? error.message : "Microphone capture is unavailable.",
			);
		}
	}

	stop(reason: LiveInputStopReason): void {
		++this.#operation;
		const requestId = this.#requestId;
		const leaseId = this.#leaseId;
		this.#requestId = null;
		this.#leaseId = null;
		this.#activating = false;
		if (leaseId) void this.#client.stopLiveInput(leaseId, reason);
		else if (requestId) this.#client.cancelLiveInputClaim(requestId, reason);
		this.#releaseMedia();
		this.#setSnapshot("idle", null, "locked", null);
	}

	async #prepareCapture(
		operation: number,
		streamPromise: Promise<MediaStream>,
		resumePromise: Promise<void>,
	): Promise<void> {
		try {
			const stream = await streamPromise;
			if (operation !== this.#operation) {
				stopStream(stream);
				return;
			}
			this.#stream = stream;
			for (const track of stream.getAudioTracks())
				track.addEventListener("ended", this.#handleTrackEnded, { once: true });
			await resumePromise;
			if (operation !== this.#operation) return;
			if (!this.#context || !this.#output.unlock(this.#context)) {
				throw new Error("Assistant audio playback could not be initialized.");
			}
			this.#setPlayback("ready", null);
			if (this.#leaseId) void this.#activate(operation);
			else this.#setSnapshot("waiting", "Microphone ready; waiting for the host.");
		} catch (error) {
			if (operation !== this.#operation) return;
			const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
			const denied = name === "NotAllowedError" || name === "SecurityError";
			this.#failCapture(
				denied ? "permission-denied" : "unavailable",
				denied ? "Microphone permission was denied." : "This device microphone is unavailable.",
			);
		}
	}

	readonly #handleTrackEnded = (): void => {
		this.stop("track-ended");
	};

	#syncClient(): void {
		const snapshot = this.#client.getSnapshot();
		this.#syncPlayback(snapshot);
		if (snapshot.phase !== "live" || snapshot.readOnly) {
			if (this.#snapshot.phase !== "idle") this.#failCapture("unavailable", "The live connection was interrupted.");
			return;
		}
		const lease = snapshot.liveInputLease;
		if (!this.#requestId || lease.requestId !== this.#requestId) return;
		if (lease.status === "granted" && lease.leaseId) {
			this.#leaseId = lease.leaseId;
			if (lease.started) {
				if (snapshot.liveActive && snapshot.liveInput === "remote") {
					this.#setSnapshot("active", "This device microphone is live.");
					void this.#pumpAudio(this.#operation, lease.leaseId);
				} else {
					this.#setSnapshot("waiting", "The host is starting live voice.");
				}
			} else if (this.#stream && this.#context) {
				void this.#activate(this.#operation);
			}
			return;
		}
		if (lease.status === "claiming" || lease.status === "idle") return;
		if (lease.status === "busy") this.#failCapture("busy", lease.message ?? "Another microphone is already live.");
		else if (lease.status === "revoked")
			this.#failCapture("revoked", lease.message ?? "Microphone access was revoked.", false);
		else if (lease.status === "read-only")
			this.#failCapture("unavailable", lease.message ?? "Read-only guests cannot share audio.");
		else this.#failCapture("unavailable", lease.message ?? "The host cannot accept microphone audio.");
	}

	async #activate(operation: number): Promise<void> {
		if (this.#activating || !this.#stream || !this.#context || !this.#leaseId) return;
		this.#activating = true;
		const leaseId = this.#leaseId;
		try {
			await this.#context.audioWorklet.addModule(this.#environment.workletUrl);
			if (operation !== this.#operation || leaseId !== this.#leaseId || !this.#stream) return;
			this.#source = this.#context.createMediaStreamSource(this.#stream);
			this.#worklet = this.#environment.createWorkletNode(this.#context);
			this.#silence = this.#context.createGain();
			this.#silence.gain.value = 0;
			this.#worklet.port.onmessage = event => this.#handleAudioFrame(event.data);
			this.#source.connect(this.#worklet);
			this.#worklet.connect(this.#silence);
			this.#silence.connect(this.#context.destination);
			const started = await this.#client.startLiveInput(leaseId);
			if (!started || operation !== this.#operation || leaseId !== this.#leaseId) {
				if (operation === this.#operation)
					this.#failCapture("unavailable", "The microphone stream could not start.");
				return;
			}
			const liveSnapshot = this.#client.getSnapshot();
			if (liveSnapshot.liveActive && liveSnapshot.liveInput === "remote") {
				this.#setSnapshot("active", "This device microphone is live.");
				void this.#pumpAudio(operation, leaseId);
			} else {
				this.#setSnapshot("waiting", "The host is starting live voice.");
			}
		} catch {
			if (operation === this.#operation)
				this.#failCapture("unavailable", "Audio processing is unavailable in this browser.");
		} finally {
			this.#activating = false;
		}
	}

	#handleLiveOutput(frame: LiveOutputChunk): void {
		const snapshot = this.#client.getSnapshot();
		const lease = snapshot.liveInputLease;
		if (
			snapshot.phase !== "live" ||
			snapshot.readOnly ||
			!snapshot.liveActive ||
			snapshot.liveInput !== "remote" ||
			lease.status !== "granted" ||
			!lease.started ||
			!lease.leaseId ||
			lease.leaseId !== this.#leaseId ||
			frame.leaseId !== lease.leaseId ||
			this.#snapshot.playbackPhase !== "ready"
		) {
			return;
		}
		this.#output.push(frame);
	}

	#syncPlayback(snapshot: LiveInputSnapshot): void {
		const lease = snapshot.liveInputLease;
		if (
			snapshot.phase === "live" &&
			!snapshot.readOnly &&
			snapshot.liveActive &&
			snapshot.liveInput === "remote" &&
			lease.status === "granted" &&
			lease.started &&
			lease.leaseId &&
			lease.leaseId === this.#leaseId &&
			this.#snapshot.playbackPhase === "ready"
		) {
			this.#output.activateLease(lease.leaseId);
			return;
		}
		this.#output.deactivateLease();
	}

	#handleAudioFrame(data: unknown): void {
		if (!(data instanceof Float32Array) || data.length !== LIVE_INPUT_FRAME_SAMPLES || !this.#leaseId) return;
		if (isLiveInputSpeech(data)) this.#output.resetForBargeIn();
		const pcm = encodePcm16Le(data);
		if (pcm.byteLength !== LIVE_INPUT_PCM_BYTES) return;
		this.#queue.push(encodeBase64Url(pcm));
		if (this.#snapshot.phase === "active") void this.#pumpAudio(this.#operation, this.#leaseId);
	}

	async #pumpAudio(operation: number, leaseId: string): Promise<void> {
		if (this.#pumping) return;
		this.#pumping = true;
		try {
			while (operation === this.#operation && leaseId === this.#leaseId && this.#snapshot.phase === "active") {
				const data = this.#queue.shift();
				if (!data) break;
				const sent = await this.#client.sendLiveInputChunk(leaseId, this.#sequence, data);
				if (sent) this.#sequence++;
			}
		} finally {
			this.#pumping = false;
			if (
				this.#queue.length > 0 &&
				operation === this.#operation &&
				leaseId === this.#leaseId &&
				this.#snapshot.phase === "active"
			) {
				void this.#pumpAudio(operation, leaseId);
			}
		}
	}

	#failCapture(
		phase: Exclude<PhoneMicPhase, "idle" | "requesting" | "waiting" | "active">,
		message: string,
		release = true,
	): void {
		++this.#operation;
		const requestId = this.#requestId;
		const leaseId = this.#leaseId;
		this.#requestId = null;
		this.#leaseId = null;
		this.#activating = false;
		if (release) {
			if (leaseId) void this.#client.stopLiveInput(leaseId, "transport");
			else if (requestId) this.#client.cancelLiveInputClaim(requestId, "transport");
		}
		this.#releaseMedia();
		this.#setSnapshot(phase, message, "locked", null);
	}

	#releaseMedia(): void {
		this.#output.lock();
		this.#queue.clear();
		if (this.#worklet) this.#worklet.port.onmessage = null;
		for (const node of [this.#source, this.#worklet, this.#silence]) {
			try {
				node?.disconnect();
			} catch {
				// A partially-created graph may already be disconnected.
			}
		}
		this.#source = null;
		this.#worklet = null;
		this.#silence = null;
		if (this.#stream) {
			for (const track of this.#stream.getAudioTracks()) track.removeEventListener("ended", this.#handleTrackEnded);
			stopStream(this.#stream);
			this.#stream = null;
		}
		const context = this.#context;
		this.#context = null;
		if (context && context.state !== "closed") void context.close().catch(() => {});
	}

	#setSnapshot(
		phase: PhoneMicPhase,
		message: string | null,
		playbackPhase: PhonePlaybackPhase = this.#snapshot.playbackPhase,
		playbackMessage: string | null = this.#snapshot.playbackMessage,
	): void {
		if (
			this.#snapshot.phase === phase &&
			this.#snapshot.message === message &&
			this.#snapshot.playbackPhase === playbackPhase &&
			this.#snapshot.playbackMessage === playbackMessage
		) {
			return;
		}
		this.#snapshot = { phase, message, playbackPhase, playbackMessage };
		for (const listener of this.#listeners) listener();
	}

	#setPlayback(playbackPhase: PhonePlaybackPhase, playbackMessage: string | null): void {
		this.#setSnapshot(this.#snapshot.phase, this.#snapshot.message, playbackPhase, playbackMessage);
	}
}
