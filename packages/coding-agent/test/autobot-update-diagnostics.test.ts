import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	readAutoBotUpdateDiagnostics,
	writeAutoBotUpdateDiagnostic,
} from "@oh-my-pi/pi-coding-agent/autobot-update/diagnostics";
import { ensureAutoBotPrivateDirectory } from "@oh-my-pi/pi-coding-agent/autobot-update/permissions";
import { autoBotPaths } from "@oh-my-pi/pi-coding-agent/autobot-update/paths";

const windowsFilesystemSecurityTestTimeoutMs = process.platform === "win32" ? 120_000 : undefined;
const temporaryDirectories: string[] = [];

async function createPaths() {
	const root = await fs.mkdtemp(path.join(os.homedir(), ".omp-autobot-diagnostics-"));
	temporaryDirectories.push(root);
	await ensureAutoBotPrivateDirectory(root);
	await ensureAutoBotPrivateDirectory(path.join(root, ".autobot"));
	return autoBotPaths(root);
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

describe("AutoBot update diagnostics", () => {
	test(
		"keeps one latest state per launch and deduplicates repeated unchanged polling cycles",
		async () => {
			const paths = await createPaths();
			const firstLaunch = "a".repeat(32);
			const secondLaunch = "b".repeat(32);
			await writeAutoBotUpdateDiagnostic(paths, {
				phase: "channel-refresh",
				outcome: "unchanged",
				releaseSequence: 7,
				launchId: firstLaunch,
			});
			const [first] = await readAutoBotUpdateDiagnostics(paths);
			await writeAutoBotUpdateDiagnostic(paths, {
				phase: "channel-refresh",
				outcome: "unchanged",
				releaseSequence: 7,
				launchId: firstLaunch,
			});
			await writeAutoBotUpdateDiagnostic(paths, {
				phase: "channel-refresh",
				outcome: "started",
				releaseSequence: 7,
				launchId: firstLaunch,
			});
			await writeAutoBotUpdateDiagnostic(paths, {
				phase: "channel-refresh",
				outcome: "unchanged",
				releaseSequence: 7,
				launchId: firstLaunch,
			});
			await writeAutoBotUpdateDiagnostic(paths, {
				phase: "channel-refresh",
				outcome: "completed",
				releaseSequence: 8,
				launchId: secondLaunch,
			});

			const diagnostics = await readAutoBotUpdateDiagnostics(paths);
			expect(diagnostics).toHaveLength(2);
			expect(diagnostics.map(item => item.launchId)).toEqual([secondLaunch, firstLaunch]);
			expect(diagnostics[1]?.timestamp).toBe(first?.timestamp);
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);

	test(
		"rejects free-form reasons before private data can reach persisted state",
		async () => {
			const paths = await createPaths();
			const privateText = `${path.join(os.homedir(), "sessions", "private.jsonl")} token=super-secret`;
			await expect(
				writeAutoBotUpdateDiagnostic(paths, {
					phase: "channel-refresh",
					outcome: "failed",
					reason: privateText,
					releaseSequence: 7,
					launchId: "a".repeat(32),
				}),
			).rejects.toThrow("reason code");
			expect(await readAutoBotUpdateDiagnostics(paths)).toEqual([]);
			await expect(
				writeAutoBotUpdateDiagnostic(paths, {
					phase: "channel-refresh",
					outcome: "failed",
					reason: "publication-recovery-pending",
					releaseSequence: 0,
					launchId: "a".repeat(32),
				}),
			).rejects.toThrow();
			await writeAutoBotUpdateDiagnostic(paths, {
				phase: "channel-refresh",
				outcome: "failed",
				reason: "signed-refresh-failed",
				launchId: "a".repeat(32),
				privateDetail: privateText,
			} as Parameters<typeof writeAutoBotUpdateDiagnostic>[1] & { privateDetail: string });
			const persisted = await Bun.file(
				path.join(paths.controlDir, "update-diagnostics", `${"a".repeat(32)}.json`),
			).text();
			expect(persisted).not.toContain(privateText);
			expect((await readAutoBotUpdateDiagnostics(paths))[0]?.releaseSequence).toBeUndefined();
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);

	test(
		"retains only the 32 most recent per-launch snapshots",
		async () => {
			const paths = await createPaths();
			const launchIds = Array.from(
				{ length: 34 },
				(_, index) => `${index.toString().padStart(2, "0")}${"x".repeat(30)}`,
			);
			for (let index = 0; index < launchIds.length; index += 1) {
				await writeAutoBotUpdateDiagnostic(paths, {
					phase: "channel-refresh",
					outcome: "completed",
					releaseSequence: index + 1,
					launchId: launchIds[index]!,
				});
			}

			const diagnostics = await readAutoBotUpdateDiagnostics(paths);
			expect(diagnostics).toHaveLength(32);
			expect(diagnostics.some(item => item.launchId === launchIds[0])).toBe(false);
			expect(diagnostics.some(item => item.launchId === launchIds.at(-1))).toBe(true);
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);

	test(
		"rejects a cached diagnostics directory replaced by a redirect before a later write",
		async () => {
			const paths = await createPaths();
			const launchId = "r".repeat(32);
			await writeAutoBotUpdateDiagnostic(paths, {
				phase: "channel-refresh",
				outcome: "started",
				releaseSequence: 7,
				launchId,
			});
			const directory = path.join(paths.controlDir, "update-diagnostics");
			const displaced = path.join(paths.controlDir, "displaced-diagnostics");
			await fs.rename(directory, displaced);
			try {
				await fs.symlink(displaced, directory, process.platform === "win32" ? "junction" : "dir");
			} catch (error) {
				if (process.platform === "win32") return;
				throw error;
			}

			await expect(
				writeAutoBotUpdateDiagnostic(paths, {
					phase: "channel-refresh",
					outcome: "completed",
					releaseSequence: 7,
					launchId,
				}),
			).rejects.toThrow();
			const persisted = JSON.parse(await Bun.file(path.join(displaced, `${launchId}.json`)).text()) as {
				outcome: string;
			};
			expect(persisted.outcome).toBe("started");
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);

	test(
		"rejects caller-supplied diagnostic storage outside the managed control directory",
		async () => {
			const paths = await createPaths();
			await expect(
				writeAutoBotUpdateDiagnostic(
					{ ...paths, controlDir: path.join(paths.root, "alternate-control") },
					{
						phase: "channel-refresh",
						outcome: "failed",
						reason: "signed-refresh-failed",
						releaseSequence: 1,
						launchId: "a".repeat(32),
					},
				),
			).rejects.toThrow("storage paths");
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);
	test(
		"refuses a diagnostic path replaced with a non-regular filesystem entry",
		async () => {
			const paths = await createPaths();
			await writeAutoBotUpdateDiagnostic(paths, {
				phase: "channel-refresh",
				outcome: "completed",

				releaseSequence: 7,
				launchId: "a".repeat(32),
			});
			const diagnosticPath = path.join(paths.controlDir, "update-diagnostics", `${"a".repeat(32)}.json`);
			await fs.rm(diagnosticPath);
			await fs.mkdir(diagnosticPath);

			await expect(readAutoBotUpdateDiagnostics(paths)).rejects.toThrow();
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);
});
