import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

describe("SessionManager AutoBot standby", () => {
	it("does not repair the predecessor's journal before activation", async () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/project", "/sessions", storage);
		await session.ensureOnDisk();
		const sessionFile = session.getSessionFile()!;
		const predecessorJournal = `${await storage.readText(sessionFile)}{"type":"custom","customType":"predecessor-write","data":{}}\n`;

		session.enterAutoBotStandby();
		await storage.writeText(sessionFile, predecessorJournal);
		await session.recoverPersistenceFromCurrentState();

		expect(await storage.readText(sessionFile)).toBe(predecessorJournal);
	});
});
