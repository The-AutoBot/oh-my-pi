import { decodeBase64Url } from "./link";

export const LIVE_INPUT_SAMPLE_RATE = 16_000;
export const LIVE_INPUT_FRAME_SAMPLES = 320;
export const LIVE_INPUT_PCM_BYTES = LIVE_INPUT_FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT;
export const LIVE_INPUT_QUEUE_FRAMES = 5;

export const LIVE_OUTPUT_SAMPLE_RATE = 48_000;
export const LIVE_OUTPUT_MIN_FRAME_SAMPLES = 1;
export const LIVE_OUTPUT_MAX_FRAME_SAMPLES = 2_880;
export const LIVE_OUTPUT_START_BUFFER_SAMPLES = 2_880;
export const LIVE_OUTPUT_MAX_BUFFER_SAMPLES = 9_600;
export const LIVE_OUTPUT_SPEECH_RMS_THRESHOLD = 0.02;

/** Encodes normalized mono samples as little-endian signed 16-bit PCM. */
export function encodePcm16Le(samples: ArrayLike<number>): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(samples.length * Int16Array.BYTES_PER_ELEMENT);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < samples.length; i++) {
		const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
		view.setInt16(i * Int16Array.BYTES_PER_ELEMENT, value < 0 ? value * 0x8000 : value * 0x7fff, true);
	}
	return bytes;
}

/** Fixed-capacity FIFO that replaces the oldest queued item when full. */
export class FreshAudioQueue<T> {
	readonly #items: (T | undefined)[];
	#head = 0;
	#length = 0;

	constructor(readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("audio queue capacity must be positive");
		this.#items = Array.from<T | undefined>({ length: capacity });
	}

	get length(): number {
		return this.#length;
	}

	push(item: T): void {
		if (this.#length === this.capacity) {
			this.#items[this.#head] = item;
			this.#head = (this.#head + 1) % this.capacity;
			return;
		}
		const tail = (this.#head + this.#length) % this.capacity;
		this.#items[tail] = item;
		this.#length++;
	}

	shift(): T | undefined {
		if (this.#length === 0) return undefined;
		const item = this.#items[this.#head];
		this.#items[this.#head] = undefined;
		this.#head = (this.#head + 1) % this.capacity;
		this.#length--;
		return item;
	}

	clear(): void {
		while (this.#length > 0) {
			this.#items[this.#head] = undefined;
			this.#head = (this.#head + 1) % this.capacity;
			this.#length--;
		}
		this.#head = 0;
	}
}

export interface LiveOutputChunk {
	t: "live-output-chunk";
	leaseId: string;
	seq: number;
	format: "pcm_s16le";
	sampleRate: 48_000;
	channels: 1;
	frameSamples: number;
	data: string;
}

export interface DecodedLiveOutputChunk {
	leaseId: string;
	seq: number;
	samples: Float32Array;
}

export type LiveOutputPushResult =
	| "queued"
	| "scheduled"
	| "invalid"
	| "wrong-lease"
	| "stale"
	| "gap-reset"
	| "overflow-reset"
	| "locked"
	| "unavailable";

const LIVE_OUTPUT_START_LEAD_SECONDS = 0.005;
const LIVE_OUTPUT_MAX_BUFFER_SECONDS = LIVE_OUTPUT_MAX_BUFFER_SAMPLES / LIVE_OUTPUT_SAMPLE_RATE;

/**
 * Strictly validates and decodes one assistant-audio frame.
 *
 * The wire payload is untrusted even though it arrived inside an authenticated
 * room envelope. Returning `null` keeps malformed audio away from Web Audio
 * allocation and scheduling APIs.
 */
export function decodeLiveOutputChunk(frame: LiveOutputChunk): DecodedLiveOutputChunk | null {
	if (
		frame.t !== "live-output-chunk" ||
		typeof frame.leaseId !== "string" ||
		frame.leaseId.length === 0 ||
		!Number.isSafeInteger(frame.seq) ||
		frame.seq < 0 ||
		frame.format !== "pcm_s16le" ||
		frame.sampleRate !== LIVE_OUTPUT_SAMPLE_RATE ||
		frame.channels !== 1 ||
		!Number.isInteger(frame.frameSamples) ||
		frame.frameSamples < LIVE_OUTPUT_MIN_FRAME_SAMPLES ||
		frame.frameSamples > LIVE_OUTPUT_MAX_FRAME_SAMPLES ||
		typeof frame.data !== "string"
	) {
		return null;
	}

	const byteLength = frame.frameSamples * Int16Array.BYTES_PER_ELEMENT;
	if (frame.data.length !== Math.ceil((byteLength * 4) / 3)) return null;
	const bytes = decodeBase64Url(frame.data);
	if (!bytes || bytes.byteLength !== byteLength) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const samples = new Float32Array(frame.frameSamples);
	for (let index = 0; index < samples.length; index++) {
		samples[index] = view.getInt16(index * Int16Array.BYTES_PER_ELEMENT, true) / 0x8000;
	}
	return { leaseId: frame.leaseId, seq: frame.seq, samples };
}

/** Low-cost local speech gate used only to clear already-scheduled assistant audio on barge-in. */
export function isLiveInputSpeech(samples: ArrayLike<number>): boolean {
	if (samples.length === 0) return false;
	let energy = 0;
	for (let index = 0; index < samples.length; index++) {
		const sample = Number.isFinite(samples[index]) ? samples[index] : 0;
		energy += sample * sample;
	}
	return energy / samples.length >= LIVE_OUTPUT_SPEECH_RMS_THRESHOLD ** 2;
}

/**
 * Lease-scoped Web Audio jitter scheduler.
 *
 * Three common 20 ms frames are collected before the first source starts.
 * Once running, sources stay ordered on one timeline. A burst that would put
 * more than 200 ms ahead is discarded in favor of the freshest frame, while a
 * sequence gap clears audio that may straddle an interruption.
 */
export class LiveOutputPlayer {
	readonly #sources = new Set<AudioBufferSourceNode>();
	readonly #onUnavailable: ((message: string) => void) | undefined;
	readonly #pending: Float32Array[] = [];
	#context: AudioContext | null = null;
	#leaseId: string | null = null;
	#expectedSeq: number | null = null;
	#pendingSamples = 0;
	#scheduledUntil = 0;
	#started = false;
	#failed = false;

	constructor(onUnavailable?: (message: string) => void) {
		this.#onUnavailable = onUnavailable;
	}

	get bufferedSeconds(): number {
		if (!this.#context) return 0;
		const scheduled = this.#started ? Math.max(0, this.#scheduledUntil - this.#context.currentTime) : 0;
		return scheduled + this.#pendingSamples / LIVE_OUTPUT_SAMPLE_RATE;
	}

	/** Attaches an AudioContext that was synchronously resumed by an explicit user gesture. */
	unlock(context: AudioContext): boolean {
		this.#clearAudio(true);
		this.#context = context;
		this.#failed = false;
		if (context.state !== "closed") return true;
		this.#markUnavailable();
		return false;
	}

	lock(): void {
		this.#clearAudio(true);
		this.#context = null;
		this.#leaseId = null;
		this.#failed = false;
	}

	activateLease(leaseId: string): boolean {
		if (!this.#context || this.#context.state === "closed" || this.#failed || leaseId.length === 0) return false;
		if (this.#leaseId === leaseId) return true;
		this.#clearAudio(true);
		this.#leaseId = leaseId;
		return true;
	}

	deactivateLease(): void {
		this.#clearAudio(true);
		this.#leaseId = null;
	}

	/** Clears queued output immediately while preserving sequence continuity across local barge-in. */
	resetForBargeIn(): void {
		this.#clearAudio(false);
	}

	push(frame: LiveOutputChunk): LiveOutputPushResult {
		const context = this.#context;
		if (!context || context.state === "closed" || this.#failed || !this.#leaseId) return "locked";
		if (frame.leaseId !== this.#leaseId) return "wrong-lease";
		if (
			this.#expectedSeq !== null &&
			Number.isSafeInteger(frame.seq) &&
			frame.seq >= 0 &&
			frame.seq < this.#expectedSeq
		) {
			return "stale";
		}

		const decoded = decodeLiveOutputChunk(frame);
		if (!decoded) return "invalid";

		let gapReset = false;
		if (this.#expectedSeq !== null) {
			if (decoded.seq > this.#expectedSeq) {
				this.#clearAudio(false);
				gapReset = true;
			}
		}
		this.#expectedSeq = decoded.seq + 1;

		let overflowReset = false;
		if (
			this.#started &&
			Math.max(0, this.#scheduledUntil - context.currentTime) + decoded.samples.length / LIVE_OUTPUT_SAMPLE_RATE >
				LIVE_OUTPUT_MAX_BUFFER_SECONDS
		) {
			this.#clearAudio(false);
			overflowReset = true;
		} else if (this.#started && this.#scheduledUntil <= context.currentTime) {
			// An underrun starts a fresh jitter window instead of replaying late audio.
			this.#clearAudio(false);
		}

		this.#pending.push(decoded.samples);
		this.#pendingSamples += decoded.samples.length;
		if (!this.#started && this.#pendingSamples < LIVE_OUTPUT_START_BUFFER_SAMPLES) {
			if (overflowReset) return "overflow-reset";
			if (gapReset) return "gap-reset";
			return "queued";
		}

		if (!this.#schedulePending(context)) return "unavailable";
		if (overflowReset) return "overflow-reset";
		if (gapReset) return "gap-reset";
		return "scheduled";
	}

	#schedulePending(context: AudioContext): boolean {
		this.#started = true;
		for (const samples of this.#pending) {
			if (!this.#schedule(context, samples)) return false;
		}
		this.#pending.length = 0;
		this.#pendingSamples = 0;
		return true;
	}

	#schedule(context: AudioContext, samples: Float32Array): boolean {
		let source: AudioBufferSourceNode | null = null;
		try {
			const buffer = context.createBuffer(1, samples.length, LIVE_OUTPUT_SAMPLE_RATE);
			buffer.getChannelData(0).set(samples);
			source = context.createBufferSource();
			source.buffer = buffer;
			source.connect(context.destination);
			const startAt = Math.max(context.currentTime + LIVE_OUTPUT_START_LEAD_SECONDS, this.#scheduledUntil);
			source.onended = () => {
				source?.disconnect();
				if (source) this.#sources.delete(source);
			};
			this.#sources.add(source);
			source.start(startAt);
			this.#scheduledUntil = startAt + samples.length / LIVE_OUTPUT_SAMPLE_RATE;
			return true;
		} catch {
			if (source) {
				source.onended = null;
				this.#sources.delete(source);
				try {
					source.disconnect();
				} catch {
					// A source that failed during setup may not be connected.
				}
			}
			this.#markUnavailable();
			return false;
		}
	}

	#markUnavailable(): void {
		this.#failed = true;
		this.#clearAudio(true);
		this.#onUnavailable?.(
			"Assistant audio playback is unavailable. Microphone sharing can continue; use the speaker retry control.",
		);
	}

	#clearAudio(resetSequence: boolean): void {
		this.#pending.length = 0;
		this.#pendingSamples = 0;
		this.#started = false;
		this.#scheduledUntil = 0;
		if (resetSequence) this.#expectedSeq = null;
		for (const source of this.#sources) {
			source.onended = null;
			try {
				source.stop();
			} catch {
				// An ended or not-yet-started source may reject a second stop.
			}
			try {
				source.disconnect();
			} catch {
				// A partially-created source may already be disconnected.
			}
		}
		this.#sources.clear();
	}
}
