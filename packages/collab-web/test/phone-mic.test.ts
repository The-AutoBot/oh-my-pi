import { describe, expect, it } from "bun:test";
import type { GuestSnapshot, LiveInputLeaseState, LiveInputStopReason } from "../src/lib/client";
import type { LiveOutputChunk } from "../src/lib/live-audio";
import { type LiveInputClient, PhoneMicController, type PhoneMicEnvironment } from "../src/lib/phone-mic";

const IDLE_LEASE: LiveInputLeaseState = {
	status: "idle",
	requestId: null,
	leaseId: null,
	message: null,
	started: false,
};

async function settle(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

class FakeClient implements LiveInputClient {
	readonly listeners = new Set<() => void>();
	readonly outputListeners = new Set<(frame: LiveOutputChunk) => void>();
	readonly chunks: { leaseId: string; seq: number; data: string }[] = [];
	readonly stops: { leaseId: string; reason: LiveInputStopReason }[] = [];
	claimCount = 0;
	startCount = 0;
	readonly requestId = "request-1";
	snapshot: Pick<
		GuestSnapshot,
		"phase" | "readOnly" | "restartPreparing" | "liveActive" | "liveInput" | "liveInputLease"
	> = {
		phase: "live",
		readOnly: false,
		restartPreparing: false,
		liveActive: false,
		liveInput: "none",
		liveInputLease: IDLE_LEASE,
	};

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	subscribeLiveOutput(listener: (frame: LiveOutputChunk) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	getSnapshot(): typeof this.snapshot {
		return this.snapshot;
	}

	claimLiveInput(): string | null {
		if (this.snapshot.readOnly || this.snapshot.phase !== "live") return null;
		this.claimCount++;
		this.snapshot = {
			...this.snapshot,
			liveInputLease: {
				status: "claiming",
				requestId: this.requestId,
				leaseId: null,
				message: null,
				started: false,
			},
		};
		this.emit();
		return this.requestId;
	}

	cancelLiveInputClaim(): void {
		this.snapshot = { ...this.snapshot, liveInputLease: IDLE_LEASE };
		this.emit();
	}

	async startLiveInput(leaseId: string): Promise<boolean> {
		if (this.snapshot.liveInputLease.leaseId !== leaseId) return false;
		this.startCount++;
		this.snapshot = {
			...this.snapshot,
			liveInputLease: { ...this.snapshot.liveInputLease, started: true },
		};
		this.emit();
		return true;
	}

	async sendLiveInputChunk(leaseId: string, seq: number, data: string): Promise<boolean> {
		this.chunks.push({ leaseId, seq, data });
		return true;
	}

	async stopLiveInput(leaseId: string, reason: LiveInputStopReason): Promise<boolean> {
		this.stops.push({ leaseId, reason });
		this.snapshot = { ...this.snapshot, liveActive: false, liveInput: "none", liveInputLease: IDLE_LEASE };
		this.emit();
		return true;
	}

	grant(): void {
		this.snapshot = {
			...this.snapshot,
			liveInputLease: {
				status: "granted",
				requestId: this.requestId,
				leaseId: "lease-1",
				message: null,
				started: false,
			},
		};
		this.emit();
	}

	setLive(active: boolean, input: GuestSnapshot["liveInput"]): void {
		this.snapshot = { ...this.snapshot, liveActive: active, liveInput: input };
		this.emit();
	}

	emit(): void {
		for (const listener of this.listeners) listener();
	}
}

class FakeTrack extends EventTarget {
	stopCount = 0;

	stop(): void {
		this.stopCount++;
	}
}

class FakeNode {
	disconnectCount = 0;

	connect(): void {}

	disconnect(): void {
		this.disconnectCount++;
	}
}

class FakeEnvironment implements PhoneMicEnvironment {
	readonly track = new FakeTrack();
	readonly source = new FakeNode();
	readonly worklet = new FakeNode();
	readonly silence = new FakeNode();
	readonly port: { onmessage: ((event: MessageEvent<unknown>) => void) | null } = { onmessage: null };
	readonly workletUrl = "https://collab.test/live-input-worklet.js";
	getUserMediaCount = 0;
	resumeCount = 0;
	closeCount = 0;
	addModuleCount = 0;
	pageHideListener: (() => void) | null = null;
	readonly context: AudioContext;

	constructor() {
		const context = {
			state: "running" as AudioContextState,
			destination: {},
			currentTime: 0,
			audioWorklet: { addModule: async () => void this.addModuleCount++ },
			resume: async () => void this.resumeCount++,
			close: async () => {
				this.closeCount++;
				context.state = "closed";
			},
			createMediaStreamSource: () => this.source as unknown as MediaStreamAudioSourceNode,
			createGain: () => Object.assign(this.silence, { gain: { value: 1 } }) as unknown as GainNode,
		};
		this.context = context as unknown as AudioContext;
	}

	getUserMedia(): Promise<MediaStream> {
		this.getUserMediaCount++;
		return Promise.resolve({
			getTracks: () => [this.track],
			getAudioTracks: () => [this.track],
		} as unknown as MediaStream);
	}

	createAudioContext(): AudioContext {
		return this.context;
	}

	createWorkletNode(): AudioWorkletNode {
		return Object.assign(this.worklet, { port: this.port }) as unknown as AudioWorkletNode;
	}

	addPageHideListener(listener: () => void): () => void {
		this.pageHideListener = listener;
		return () => {
			this.pageHideListener = null;
		};
	}

	emitFrame(frame: Float32Array): void {
		this.port.onmessage?.({ data: frame } as MessageEvent<Float32Array>);
	}
}

describe("PhoneMicController", () => {
	it("requests permission only from the explicit click and waits for the matching grant and live state", async () => {
		const client = new FakeClient();
		const environment = new FakeEnvironment();
		const controller = new PhoneMicController(client, environment);
		controller.mount();
		expect(environment.getUserMediaCount).toBe(0);
		expect(client.claimCount).toBe(0);

		controller.toggle();
		expect(environment.getUserMediaCount).toBe(1);
		expect(client.claimCount).toBe(1);
		await settle();
		expect(controller.getSnapshot().phase).toBe("waiting");
		expect(client.startCount).toBe(0);

		client.grant();
		await settle();
		expect(client.startCount).toBe(1);
		environment.emitFrame(new Float32Array(320));
		await settle();
		expect(client.chunks).toHaveLength(0);

		client.setLive(true, "remote");
		await settle();
		expect(controller.getSnapshot().phase).toBe("active");
		expect(client.chunks).toHaveLength(1);
		expect(client.chunks[0]).toMatchObject({ leaseId: "lease-1", seq: 0 });
		expect(client.chunks[0].data).toHaveLength(854);
		controller.dispose();
	});

	it("stops capture and the lease on pagehide, track end, and unmount", async () => {
		for (const action of ["pagehide", "track-ended", "unmount"] as const) {
			const client = new FakeClient();
			const environment = new FakeEnvironment();
			const controller = new PhoneMicController(client, environment);
			controller.mount();
			controller.toggle();
			await settle();
			client.grant();
			await settle();
			client.setLive(true, "remote");
			await settle();

			if (action === "pagehide") environment.pageHideListener?.();
			else if (action === "track-ended") environment.track.dispatchEvent(new Event("ended"));
			else controller.dispose();
			await settle();

			expect(client.stops.at(-1)).toEqual({
				leaseId: "lease-1",
				reason: action === "track-ended" ? "track-ended" : "transport",
			});
			expect(environment.track.stopCount).toBe(1);
			expect(environment.closeCount).toBe(1);
			if (action !== "unmount") controller.dispose();
		}
	});

	it("never requests permission for a read-only guest", () => {
		const client = new FakeClient();
		client.snapshot = { ...client.snapshot, readOnly: true };
		const environment = new FakeEnvironment();
		const controller = new PhoneMicController(client, environment);
		controller.mount();
		controller.toggle();
		expect(environment.getUserMediaCount).toBe(0);
		expect(client.claimCount).toBe(0);
		expect(controller.getSnapshot().phase).toBe("unavailable");
		controller.dispose();
	});

	it("does not acquire microphone permission while a restart is preparing", () => {
		const client = new FakeClient();
		client.snapshot = { ...client.snapshot, restartPreparing: true };
		const environment = new FakeEnvironment();
		const controller = new PhoneMicController(client, environment);
		controller.mount();
		controller.toggle();
		expect(environment.getUserMediaCount).toBe(0);
		expect(client.claimCount).toBe(0);
		expect(controller.getSnapshot().phase).toBe("idle");
		controller.dispose();
	});
});
