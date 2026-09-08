export class StreamingFrameResampler {
	constructor(sourceSampleRate: number, targetSampleRate?: number, frameSamples?: number);
	push(samples: ArrayLike<number>, onFrame: (frame: Float32Array<ArrayBuffer>) => void): void;
	pushSample(sample: number, onFrame: (frame: Float32Array<ArrayBuffer>) => void): void;
}
