import { afterEach, describe, expect, it } from "bun:test";
import type { GuestFrame } from "@oh-my-pi/pi-wire";
import { importRoomKey, open } from "../src/lib/codec";
import { unpackEnvelope } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;

class RecordingWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: RecordingWebSocket[] = [];

	binaryType = "arraybuffer";
	bufferedAmount = 0;
	readyState = RecordingWebSocket.CONNECTING;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readonly sent: Uint8Array[] = [];

	constructor(_url: string) {
		RecordingWebSocket.instances.push(this);
	}

	send(data: Uint8Array): void {
		this.sent.push(new Uint8Array(data));
	}

	open(): void {
		this.readyState = RecordingWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	close(_code?: number): void {
		this.readyState = RecordingWebSocket.CLOSED;
		this.onclose?.({ code: 1000, reason: "closed" } as CloseEvent);
	}
}

function holdFirstKeyRead(key: CryptoKey): { key: PromiseLike<CryptoKey>; release: () => void } {
	const firstRead = Promise.withResolvers<CryptoKey>();
	let reads = 0;
	return {
		key: {
			then(onfulfilled, onrejected) {
				const next = reads++ === 0 ? firstRead.promise : Promise.resolve(key);
				return next.then(onfulfilled, onrejected);
			},
		},
		release: () => firstRead.resolve(key),
	};
}

async function framesSent(ws: RecordingWebSocket, key: CryptoKey): Promise<GuestFrame[]> {
	const frames: GuestFrame[] = [];
	for (const sent of ws.sent) {
		const envelope = unpackEnvelope(sent);
		if (!envelope) throw new Error("expected encrypted envelope");
		frames.push((await open(key, envelope.payload)) as GuestFrame);
	}
	return frames;
}

afterEach(() => {
	globalThis.WebSocket = ORIGINAL_WEBSOCKET;
	RecordingWebSocket.instances = [];
});

describe("CollabSocket realtime sends", () => {
	it("bounds pending chunks while ordered lease controls progress independently", async () => {
		globalThis.WebSocket = RecordingWebSocket as unknown as typeof WebSocket;
		const cryptoKey = await importRoomKey(new Uint8Array(32));
		const heldKey = holdFirstKeyRead(cryptoKey);
		const socket = new CollabSocket({ wsUrl: "ws://relay.test/r/room", role: "guest", key: heldKey.key });
		socket.connect();
		const ws = RecordingWebSocket.instances[0];
		if (!ws) throw new Error("expected socket");
		ws.open();

		const firstChunk = socket.sendRealtime({ t: "live-input-chunk", leaseId: "lease-1", seq: 0, data: "A" });
		await Promise.resolve();
		expect(await socket.sendRealtime({ t: "live-input-chunk", leaseId: "lease-1", seq: 1, data: "B" })).toBe(false);

		const claim = socket.sendRealtime({ t: "live-input-claim", requestId: "request-1" });
		const start = socket.sendRealtime({
			t: "live-input-start",
			leaseId: "lease-2",
			format: "pcm_s16le",
			sampleRate: 16_000,
			channels: 1,
			frameSamples: 320,
		});
		const stop = socket.sendRealtime({ t: "live-input-stop", leaseId: "lease-2", reason: "user" });

		expect(await claim).toBe(true);
		expect(await start).toBe(true);
		expect(await stop).toBe(true);
		expect(await framesSent(ws, cryptoKey)).toEqual([
			{ t: "live-input-claim", requestId: "request-1" },
			{
				t: "live-input-start",
				leaseId: "lease-2",
				format: "pcm_s16le",
				sampleRate: 16_000,
				channels: 1,
				frameSamples: 320,
			},
			{ t: "live-input-stop", leaseId: "lease-2", reason: "user" },
		]);

		heldKey.release();
		expect(await firstChunk).toBe(false);
		expect(await framesSent(ws, cryptoKey)).toEqual([
			{ t: "live-input-claim", requestId: "request-1" },
			{
				t: "live-input-start",
				leaseId: "lease-2",
				format: "pcm_s16le",
				sampleRate: 16_000,
				channels: 1,
				frameSamples: 320,
			},
			{ t: "live-input-stop", leaseId: "lease-2", reason: "user" },
		]);
		socket.close();
	});
});
