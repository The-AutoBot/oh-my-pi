import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireAutoBotFileLock } from "@oh-my-pi/pi-coding-agent/autobot-update/lock";
import { ensureAutoBotPrivateDirectory } from "@oh-my-pi/pi-coding-agent/autobot-update/permissions";

const windowsFilesystemSecurityTestTimeoutMs = process.platform === "win32" ? 120_000 : undefined;

const temporaryDirectories: string[] = [];

async function createPrivateDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.homedir(), ".omp-autobot-lock-"));
	temporaryDirectories.push(directory);
	return ensureAutoBotPrivateDirectory(directory);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.lstat(filePath);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

describe("AutoBot file lock storage", () => {
	test(
		"requireExisting refuses a missing database without creating it",
		async () => {
			const directory = await createPrivateDirectory();
			const lockPath = path.join(directory, "control");
			const databasePath = `${lockPath}.lock.sqlite`;

			await expect(
				acquireAutoBotFileLock(lockPath, { retries: 1, retryDelayMs: 0, requireExisting: true }),
			).rejects.toThrow("required control lock database is missing");
			expect(await pathExists(databasePath)).toBe(false);
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);

	test(
		"rejects unsafe journal storage and recovers after it is removed",
		async () => {
			const directory = await createPrivateDirectory();
			const lockPath = path.join(directory, "control");
			const journalPath = `${lockPath}.lock.sqlite-journal`;
			if (process.platform === "win32") {
				await fs.mkdir(journalPath);
			} else {
				await fs.writeFile(journalPath, "untrusted", { mode: 0o666 });
				await fs.chmod(journalPath, 0o666);
			}

			await expect(acquireAutoBotFileLock(lockPath, { retries: 1, retryDelayMs: 0 })).rejects.toThrow();
			await fs.rm(journalPath, { recursive: true, force: true });

			const lease = await acquireAutoBotFileLock(lockPath, { retries: 1, retryDelayMs: 0 });
			lease.release();
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);

	test(
		"a failed contender retains no lease after the held lease is released",
		async () => {
			const directory = await createPrivateDirectory();
			const lockPath = path.join(directory, "control");
			const held = await acquireAutoBotFileLock(lockPath, { retries: 1, retryDelayMs: 0 });
			try {
				await expect(acquireAutoBotFileLock(lockPath, { retries: 1, retryDelayMs: 0 })).rejects.toThrow(
					"already held",
				);
			} finally {
				held.release();
			}

			const reacquired = await acquireAutoBotFileLock(lockPath, { retries: 1, retryDelayMs: 0 });
			reacquired.release();
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);
});
