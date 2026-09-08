export class StreamingFrameResampler {
	#sourceToTargetRatio;
	#frameSamples;
	#frame;
	#frameLength = 0;
	#sourceIndex = 0;
	#nextOutputPosition = 0;
	#previousSample = 0;
	#hasPreviousSample = false;

	constructor(sourceSampleRate, targetSampleRate = 16_000, frameSamples = 320) {
		if (!(sourceSampleRate > 0) || !(targetSampleRate > 0) || !Number.isInteger(frameSamples) || frameSamples <= 0) {
			throw new RangeError("invalid live input resampler configuration");
		}
		this.#sourceToTargetRatio = sourceSampleRate / targetSampleRate;
		this.#frameSamples = frameSamples;
		this.#frame = new Float32Array(frameSamples);
	}

	push(samples, onFrame) {
		for (let i = 0; i < samples.length; i++) this.pushSample(samples[i], onFrame);
	}

	pushSample(sample, onFrame) {
		const current = Number.isFinite(sample) ? sample : 0;
		const currentIndex = this.#sourceIndex++;
		if (!this.#hasPreviousSample) {
			this.#hasPreviousSample = true;
			this.#previousSample = current;
			this.#emit(current, onFrame);
			this.#nextOutputPosition += this.#sourceToTargetRatio;
			return;
		}

		const previousIndex = currentIndex - 1;
		while (this.#nextOutputPosition <= currentIndex) {
			const fraction = this.#nextOutputPosition - previousIndex;
			const interpolated = this.#previousSample + (current - this.#previousSample) * fraction;
			this.#emit(interpolated, onFrame);
			this.#nextOutputPosition += this.#sourceToTargetRatio;
		}
		this.#previousSample = current;
	}

	#emit(sample, onFrame) {
		this.#frame[this.#frameLength++] = sample;
		if (this.#frameLength !== this.#frameSamples) return;
		const complete = this.#frame;
		this.#frame = new Float32Array(this.#frameSamples);
		this.#frameLength = 0;
		onFrame(complete);
	}
}

const ProcessorBase = typeof AudioWorkletProcessor === "undefined" ? class {} : AudioWorkletProcessor;

export class LiveInputProcessor extends ProcessorBase {
	#resampler;

	constructor(options) {
		super();
		const sourceRate = typeof sampleRate === "number" ? sampleRate : 48_000;
		const processorOptions = options?.processorOptions ?? {};
		this.#resampler = new StreamingFrameResampler(
			sourceRate,
			processorOptions.targetSampleRate ?? 16_000,
			processorOptions.frameSamples ?? 320,
		);
	}

	process(inputs) {
		const channels = inputs[0];
		if (!channels || channels.length === 0) return true;
		const sampleCount = channels[0]?.length ?? 0;
		for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
			let mono = 0;
			for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
				mono += channels[channelIndex][sampleIndex] ?? 0;
			}
			mono /= channels.length;
			this.#resampler.pushSample(mono, frame => this.port.postMessage(frame, [frame.buffer]));
		}
		return true;
	}
}

if (typeof registerProcessor !== "undefined") registerProcessor("omp-live-input", LiveInputProcessor);
