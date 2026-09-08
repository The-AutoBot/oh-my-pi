import { describe, expect, it } from "bun:test";
import { StreamingFrameResampler } from "../public/live-input-worklet.js";
import { encodeBase64Url } from "../src/lib/link";
import {
	decodeLiveOutputChunk,
	encodePcm16Le,
	FreshAudioQueue,
	isLiveInputSpeech,
	LIVE_INPUT_FRAME_SAMPLES,
	LIVE_INPUT_PCM_BYTES,
	LIVE_INPUT_QUEUE_FRAMES,
	LIVE_OUTPUT_MAX_BUFFER_SAMPLES,
	LIVE_OUTPUT_SAMPLE_RATE,
	LIVE_OUTPUT_START_BUFFER_SAMPLES,
	type LiveOutputChunk,
	LiveOutputPlayer,
} from "../src/lib/live-audio";

function outputFrame(seq: number, value = 1_000, frameSamples = 960, leaseId = "lease-1"): LiveOutputChunk {
	const bytes = new Uint8Array(frameSamples * Int16Array.BYTES_PER_ELEMENT);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < frameSamples; index++) {
		view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, value, true);
	}
	return {
		t: "live-output-chunk",
		leaseId,
		seq,
		format: "pcm_s16le",
		sampleRate: LIVE_OUTPUT_SAMPLE_RATE,
		channels: 1,
		frameSamples,
		data: encodeBase64Url(bytes),
	};
}

class TestAudioBuffer {
	readonly channel: Float32Array;

	constructor(length: number) {
		this.channel = new Float32Array(length);
	}

	getChannelData(): Float32Array {
		return this.channel;
	}
}

class TestBufferSource {
	buffer: AudioBuffer | null = null;
	onended: (() => void) | null = null;
	startedAt: number | null = null;
	stopCount = 0;
	disconnectCount = 0;

	connect(): void {}

	start(when = 0): void {
		this.startedAt = when;
	}

	stop(): void {
		this.stopCount++;
	}

	disconnect(): void {
		this.disconnectCount++;
	}
}

class TestOutputContext {
	readonly state: AudioContextState = "running";
	readonly destination = {};
	readonly sources: TestBufferSource[] = [];
	currentTime = 0;

	createBuffer(_channels: number, length: number, _sampleRate: number): AudioBuffer {
		return new TestAudioBuffer(length) as unknown as AudioBuffer;
	}

	createBufferSource(): AudioBufferSourceNode {
		const source = new TestBufferSource();
		this.sources.push(source);
		return source as unknown as AudioBufferSourceNode;
	}

	asAudioContext(): AudioContext {
		return this as unknown as AudioContext;
	}
}

describe("live input PCM", () => {
	it("encodes normalized samples as clamped little-endian signed 16-bit PCM", () => {
		const bytes = encodePcm16Le([-2, -1, -0.5, 0, 0.5, 1, 2, Number.NaN]);
		const view = new DataView(bytes.buffer);
		expect(Array.from({ length: 8 }, (_, index) => view.getInt16(index * 2, true))).toEqual([
			-32_768, -32_768, -16_384, 0, 16_383, 32_767, 32_767, 0,
		]);
	});

	it("produces exactly 640 bytes for each 320-sample frame", () => {
		expect(encodePcm16Le(new Float32Array(LIVE_INPUT_FRAME_SAMPLES)).byteLength).toBe(LIVE_INPUT_PCM_BYTES);
	});
});

describe("worklet streaming resampler", () => {
	it("resamples 48 kHz input continuously to 16 kHz", () => {
		const resampler = new StreamingFrameResampler(48_000);
		const input = Float32Array.from({ length: 960 }, (_, index) => index / 960);
		const frames: Float32Array[] = [];
		resampler.push(input, frame => frames.push(frame));
		expect(frames).toHaveLength(1);
		expect(frames[0]).toHaveLength(320);
		expect(frames[0][0]).toBeCloseTo(input[0]);
		expect(frames[0][319]).toBeCloseTo(input[957]);
	});

	it("preserves frame boundaries across arbitrary input chunks", () => {
		const resampler = new StreamingFrameResampler(48_000);
		const frames: Float32Array[] = [];
		const emit = (frame: Float32Array): void => {
			frames.push(frame);
		};
		resampler.push(new Float32Array(511), emit);
		resampler.push(new Float32Array(446), emit);
		expect(frames).toHaveLength(0);
		resampler.push(new Float32Array(1), emit);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toHaveLength(LIVE_INPUT_FRAME_SAMPLES);
	});
});

describe("fresh audio queue", () => {
	it("retains only the five freshest frames when capture outruns transport", () => {
		const queue = new FreshAudioQueue<number>(LIVE_INPUT_QUEUE_FRAMES);
		for (let value = 1; value <= 8; value++) queue.push(value);
		expect(queue.length).toBe(5);
		expect(Array.from({ length: 5 }, () => queue.shift())).toEqual([4, 5, 6, 7, 8]);
		expect(queue.length).toBe(0);
	});
});

describe("live output PCM", () => {
	it("strictly decodes mono 48 kHz PCM16 little-endian samples", () => {
		const decoded = decodeLiveOutputChunk(outputFrame(4, -16_384, 3));
		expect(decoded?.leaseId).toBe("lease-1");
		expect(decoded?.seq).toBe(4);
		expect(Array.from(decoded?.samples ?? [])).toEqual([-0.5, -0.5, -0.5]);
	});

	it("rejects malformed format, bounds, sequence, and decoded byte length", () => {
		const valid = outputFrame(0);
		for (const invalid of [
			{ ...valid, seq: -1 },
			{ ...valid, format: "pcm_f32le" },
			{ ...valid, sampleRate: 16_000 },
			{ ...valid, channels: 2 },
			{ ...valid, frameSamples: 0 },
			{ ...valid, frameSamples: 2_881 },
			{ ...valid, data: valid.data.slice(0, -2) },
		]) {
			expect(decodeLiveOutputChunk(invalid as LiveOutputChunk)).toBeNull();
		}
	});

	it("detects voice-active capture without treating silence or low noise as barge-in", () => {
		expect(isLiveInputSpeech(new Float32Array(320))).toBe(false);
		expect(isLiveInputSpeech(Float32Array.from({ length: 320 }, () => 0.005))).toBe(false);
		expect(isLiveInputSpeech(Float32Array.from({ length: 320 }, () => 0.1))).toBe(true);
	});
});

describe("LiveOutputPlayer", () => {
	it("starts at 60 ms and schedules decoded chunks in strict order below the 200 ms cap", () => {
		const context = new TestOutputContext();
		const player = new LiveOutputPlayer();
		expect(player.unlock(context.asAudioContext())).toBe(true);
		expect(player.activateLease("lease-1")).toBe(true);

		expect(player.push(outputFrame(0, 1_000))).toBe("queued");
		expect(player.push(outputFrame(1, 2_000))).toBe("queued");
		expect(context.sources).toHaveLength(0);
		expect(player.push(outputFrame(2, 3_000))).toBe("scheduled");

		expect(context.sources.map(source => source.startedAt)).toEqual([0.005, 0.025, 0.045]);
		expect(context.sources.map(source => source.buffer?.getChannelData(0)[0])).toEqual([
			1_000 / 0x8000,
			2_000 / 0x8000,
			3_000 / 0x8000,
		]);
		expect(player.bufferedSeconds).toBeGreaterThanOrEqual(LIVE_OUTPUT_START_BUFFER_SAMPLES / LIVE_OUTPUT_SAMPLE_RATE);
		expect(player.bufferedSeconds).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_BUFFER_SAMPLES / LIVE_OUTPUT_SAMPLE_RATE);
	});

	it("clears scheduled audio and re-buffers from the first fresh frame after a sequence gap", () => {
		const context = new TestOutputContext();
		const player = new LiveOutputPlayer();
		player.unlock(context.asAudioContext());
		player.activateLease("lease-1");
		for (let seq = 0; seq < 3; seq++) player.push(outputFrame(seq));
		const oldSources = [...context.sources];

		expect(player.push(outputFrame(4, 4_000))).toBe("gap-reset");
		expect(oldSources.every(source => source.stopCount === 1)).toBe(true);
		expect(player.push(outputFrame(5, 5_000))).toBe("queued");
		expect(player.push(outputFrame(6, 6_000))).toBe("scheduled");
		expect(context.sources.slice(-3).map(source => source.buffer?.getChannelData(0)[0])).toEqual([
			4_000 / 0x8000,
			5_000 / 0x8000,
			6_000 / 0x8000,
		]);
	});

	it("drops stale and wrong-lease frames without disturbing ordered playback", () => {
		const context = new TestOutputContext();
		const player = new LiveOutputPlayer();
		player.unlock(context.asAudioContext());
		player.activateLease("lease-1");
		for (let seq = 0; seq < 3; seq++) player.push(outputFrame(seq));
		const sourceCount = context.sources.length;

		expect(player.push(outputFrame(2, 9_000))).toBe("stale");
		expect(player.push(outputFrame(3, 9_000, 960, "lease-2"))).toBe("wrong-lease");
		expect(context.sources).toHaveLength(sourceCount);
	});

	it("drops an overflowing scheduled train and keeps only fresh bounded audio", () => {
		const context = new TestOutputContext();
		const player = new LiveOutputPlayer();
		player.unlock(context.asAudioContext());
		player.activateLease("lease-1");
		expect(player.push(outputFrame(0, 1_000, 2_880))).toBe("scheduled");
		expect(player.push(outputFrame(1, 2_000, 2_880))).toBe("scheduled");
		expect(player.push(outputFrame(2, 3_000, 2_880))).toBe("scheduled");
		const oldSources = [...context.sources];

		expect(player.push(outputFrame(3, 4_000, 2_880))).toBe("overflow-reset");
		expect(oldSources.every(source => source.stopCount === 1)).toBe(true);
		expect(context.sources.at(-1)?.buffer?.getChannelData(0)[0]).toBe(4_000 / 0x8000);
		expect(player.bufferedSeconds).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_BUFFER_SAMPLES / LIVE_OUTPUT_SAMPLE_RATE);
	});

	it("clears all pending and scheduled sources on barge-in, stop, and lock", () => {
		const context = new TestOutputContext();
		const player = new LiveOutputPlayer();
		player.unlock(context.asAudioContext());
		player.activateLease("lease-1");
		for (let seq = 0; seq < 3; seq++) player.push(outputFrame(seq));
		const firstTrain = [...context.sources];

		player.resetForBargeIn();
		expect(firstTrain.every(source => source.stopCount === 1)).toBe(true);
		player.push(outputFrame(3));
		player.push(outputFrame(4));
		player.push(outputFrame(5));
		const secondTrain = context.sources.slice(-3);
		player.deactivateLease();
		expect(secondTrain.every(source => source.stopCount === 1)).toBe(true);
		expect(player.push(outputFrame(6))).toBe("locked");
		player.lock();
		expect(player.bufferedSeconds).toBe(0);
	});
});
