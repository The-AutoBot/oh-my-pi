import { describe, expect, it } from "bun:test";
import { RestartDraftRegistry, type RestartDraftStorage } from "../src/lib/restart-drafts";

class MemoryStorage implements RestartDraftStorage {
	#values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.#values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.#values.set(key, value);
	}

	removeItem(key: string): void {
		this.#values.delete(key);
	}
}

class FailingStorage extends MemoryStorage {
	override setItem(_key: string, _value: string): void {
		throw new Error("quota exceeded");
	}
}

class FailingRemovalStorage extends MemoryStorage {
	override removeItem(_key: string): void {
		throw new Error("storage removal failed");
	}
}

const requestA = "a".repeat(16);
const scopeA = { fingerprint: "a".repeat(64), sessionId: "session-a" } as const;
const scopeB = { fingerprint: "b".repeat(64), sessionId: "session-b" } as const;
const editorCapabilityA = "c".repeat(64);
const editorCapabilityB = "d".repeat(64);

describe("restart draft registry", () => {
	it("restores only the exact independently established session scope", () => {
		const storage = new MemoryStorage();
		const writer = new RestartDraftRegistry(storage);
		writer.setScope(scopeA);
		expect(writer.set({ kind: "composer" }, "private draft")).toBe(true);
		expect(writer.prepare({ requestId: requestA, sessionId: "session-a", leaseMs: 1_000 })).toEqual({
			status: "ready",
		});

		const other = new RestartDraftRegistry(storage);
		other.setScope(scopeB);
		expect(other.restore(scopeB, editorCapabilityB)).toBe(false);
		expect(other.get({ kind: "composer" })).toBeUndefined();

		const restored = new RestartDraftRegistry(storage);
		restored.setScope(scopeA);
		expect(restored.restore(scopeA, editorCapabilityA)).toBe(true);
		expect(restored.get({ kind: "composer" })).toBe("private draft");
	});

	it("fails closed when durable local storage cannot accept a prepared draft", () => {
		const drafts = new RestartDraftRegistry(new FailingStorage());
		drafts.setScope(scopeA);
		expect(drafts.set({ kind: "composer" }, "must not be claimed as saved")).toBe(false);
		expect(drafts.prepare({ requestId: requestA, sessionId: "session-a", leaseMs: 1_000 })).toEqual({
			status: "blocked",
			reason: "draft-storage-unavailable",
		});
	});

	it("fails managed reload when deleting the final draft cannot be persisted", () => {
		const drafts = new RestartDraftRegistry(new FailingRemovalStorage());
		drafts.setScope(scopeA);
		expect(drafts.set({ kind: "composer" }, "remove me")).toBe(true);
		expect(drafts.clear({ kind: "composer" })).toBe(false);
		expect(drafts.prepareForManagedReload()).toBe(false);
	});

	it("keeps ordinary drafts while rejecting an editor record from another capability generation", () => {
		const storage = new MemoryStorage();
		const writer = new RestartDraftRegistry(storage);
		writer.setScope(scopeA);
		writer.set({ kind: "composer" }, "ordinary");
		writer.set({ kind: "editor", reqId: 1, capabilityFingerprint: editorCapabilityA }, "answer");

		const restored = new RestartDraftRegistry(storage);
		restored.setScope(scopeA);
		expect(restored.restore(scopeA, editorCapabilityB)).toBe(true);
		expect(restored.get({ kind: "composer" })).toBe("ordinary");
		expect(restored.get({ kind: "editor", reqId: 1, capabilityFingerprint: editorCapabilityB })).toBeUndefined();
	});

	it("allows a focused-but-idle draft to reload after the bounded input quiet period", () => {
		const storage = new MemoryStorage();
		let monotonicNow = 0;
		const drafts = new RestartDraftRegistry(
			storage,
			() => 0,
			() => monotonicNow,
		);
		drafts.setScope(scopeA);
		drafts.noteInput({ kind: "composer" });
		drafts.set({ kind: "composer" }, "saved");

		expect(drafts.prepareForManagedReload()).toBe(false);
		monotonicNow = 751;
		expect(drafts.prepareForManagedReload()).toBe(true);
	});

	it("does not acknowledge a restart while IME input may still commit", () => {
		const storage = new MemoryStorage();
		let monotonicNow = 0;
		const drafts = new RestartDraftRegistry(
			storage,
			() => 0,
			() => monotonicNow,
		);
		const surface = { kind: "composer" } as const;
		drafts.setScope(scopeA);
		drafts.setComposing(surface, true);
		expect(drafts.prepare({ requestId: requestA, sessionId: "session-a", leaseMs: 1_000 })).toEqual({
			status: "blocked",
			reason: "reservation-conflict",
		});

		drafts.setComposing(surface, false);
		drafts.noteInput(surface);
		expect(drafts.prepare({ requestId: requestA, sessionId: "session-a", leaseMs: 1_000 })).toEqual({
			status: "blocked",
			reason: "reservation-conflict",
		});
		monotonicNow = 751;
		expect(drafts.prepare({ requestId: requestA, sessionId: "session-a", leaseMs: 1_000 })).toEqual({
			status: "ready",
		});
	});

	it("keeps same-room tab records independent when each tab has session-scoped storage", () => {
		const firstTab = new MemoryStorage();
		const secondTab = new MemoryStorage();
		const first = new RestartDraftRegistry(firstTab);
		const second = new RestartDraftRegistry(secondTab);
		first.setScope(scopeA);
		second.setScope(scopeA);
		first.set({ kind: "composer" }, "first tab");
		second.set({ kind: "composer" }, "second tab");

		const restoredFirst = new RestartDraftRegistry(firstTab);
		restoredFirst.setScope(scopeA);
		expect(restoredFirst.restore(scopeA, editorCapabilityA)).toBe(true);
		expect(restoredFirst.get({ kind: "composer" })).toBe("first tab");
	});
});
