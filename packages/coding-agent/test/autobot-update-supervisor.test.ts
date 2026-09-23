import { afterEach, expect, test, vi } from "bun:test";
import { startAutoBotPollingLoop } from "@oh-my-pi/pi-coding-agent/autobot-update/supervisor";
import { AUTO_BOT_UPDATE_INTERVAL_MS } from "@oh-my-pi/pi-coding-agent/autobot-update/timing";

afterEach(() => vi.useRealTimers());

test("AutoBot polling starts immediately, never overlaps, and retries after contention", async () => {
	vi.useFakeTimers();
	const first = Promise.withResolvers<void>();
	let calls = 0;
	let concurrent = 0;
	let maximumConcurrent = 0;
	const loop = startAutoBotPollingLoop(async () => {
		calls++;
		concurrent++;
		maximumConcurrent = Math.max(maximumConcurrent, concurrent);
		if (calls === 1) await first.promise;
		concurrent--;
	}, 5);

	try {
		expect(calls).toBe(1);
		vi.advanceTimersByTime(60_000);
		expect(calls).toBe(1);
		first.resolve();
		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(5);
		await Promise.resolve();
		expect(calls).toBe(2);
		expect(maximumConcurrent).toBe(1);
	} finally {
		loop.dispose();
	}
});

test("disposing AutoBot polling prevents every later retry", async () => {
	vi.useFakeTimers();
	let calls = 0;
	const firstCompleted = Promise.withResolvers<void>();
	const loop = startAutoBotPollingLoop(async () => {
		calls++;
		firstCompleted.resolve();
	}, 5);
	await firstCompleted.promise;
	await Promise.resolve();
	loop.dispose();
	vi.advanceTimersByTime(60_000);
	expect(calls).toBe(1);
});

test("managed update contention is retried on the bounded production cadence", () => {
	expect(AUTO_BOT_UPDATE_INTERVAL_MS).toBe(30_000);
});
