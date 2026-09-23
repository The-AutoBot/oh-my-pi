import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
	type AutoBotReleaseManifest,
} from "@oh-my-pi/pi-coding-agent/autobot-update/contract";
import {
	isAutoBotReadOnlyUpdateStatusInvocation,
	prepareAutoBotFreshLaunch,
	resolveFreshLaunchHandoff,
	selectAutoBotLaunchActive,
	shouldQuarantineAutoBotCandidateFailure,
	type AutoBotFreshLaunchPreparationDeps,
} from "@oh-my-pi/pi-coding-agent/autobot-update/bootstrap";
import { acquireAutoBotFileLock, type AutoBotFileLockLease } from "@oh-my-pi/pi-coding-agent/autobot-update/lock";
import {
	autoBotLaunchLeaseLockPath,
	autoBotPaths,
	type AutoBotPaths,
} from "@oh-my-pi/pi-coding-agent/autobot-update/paths";
import { ensureAutoBotPrivateDirectory } from "@oh-my-pi/pi-coding-agent/autobot-update/permissions";
import type { AutoBotActivePointer } from "@oh-my-pi/pi-coding-agent/autobot-update/state";
import {
	AutoBotInstallationQuarantinedError,
	type AutoBotInstallationRefreshResult,
} from "@oh-my-pi/pi-coding-agent/autobot-update/installation";

const launchId = "l".repeat(32);

function manifest(releaseSequence: number): AutoBotReleaseManifest {
	return {
		schemaVersion: AUTO_BOT_RELEASE_SCHEMA_VERSION,
		releaseSequence,
		upstreamVersion: `1.0.${releaseSequence}`,
		forkCommit: releaseSequence.toString(16).padStart(40, "a"),
		upstreamCommit: releaseSequence.toString(16).padStart(40, "b"),
		publishedAt: "2026-09-22T00:00:00.000Z",
		minimumBootstrapVersion: AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		assets: [],
		webBundleId: `web-${releaseSequence}`,
	};
}

function active(releaseSequence: number): AutoBotActivePointer {
	const slotId = `slot-${releaseSequence}`;
	return {
		schemaVersion: 1,
		slotId,
		runtimePath: `/managed/runtimes/${slotId}/omp`,
		runtimeSha256: releaseSequence.toString(16).padStart(64, "0"),
		manifest: manifest(releaseSequence),
		activatedAt: "2026-09-22T00:00:00.000Z",
	};
}
function restartTarget(releaseSequence: number) {
	const release = manifest(releaseSequence);
	return {
		releaseSequence: release.releaseSequence,
		upstreamVersion: release.upstreamVersion,
		forkCommit: release.forkCommit,
		sessionFormatVersion: release.sessionFormatVersion,
		collabProtocolVersion: release.collabProtocolVersion,
		compatibilityEpoch: release.compatibilityEpoch,
		webBundleId: release.webBundleId,
		handoffBudgetMs: 180_000,
	};
}

function refreshResult(
	preferred: AutoBotActivePointer,
	stagedSequence: number,
	changed = true,
): AutoBotInstallationRefreshResult {
	const stagedManifest = manifest(stagedSequence);
	return {
		active: preferred,
		release: {
			envelope: { payload: "{}", signature: "signature", keyId: "current" },
			envelopeJson: "{}",
			manifest: stagedManifest,
			payloadSha256: "c".repeat(64),
			allowedArtifactOrigins: {},
		},
		staged: {
			slotId: `slot-${stagedSequence}`,
			runtimePath: `/managed/runtimes/slot-${stagedSequence}/omp`,
			bootstrapPath: `/managed/bootstraps/slot-${stagedSequence}/omp`,
			coordinatorClientPath: "/managed/coordinator.mjs",
			collabWebPath: "/managed/collab-web",
			manifest: stagedManifest,
			payloadSha256: "c".repeat(64),
		},
		changed,
	};
}

function deps(overrides: Partial<AutoBotFreshLaunchPreparationDeps> = {}): AutoBotFreshLaunchPreparationDeps {
	return {
		recover: async () => undefined,
		refresh: async () => refreshResult(active(2), 2),
		readActive: async () => active(1),
		verifyActive: async () => undefined,
		writeDiagnostic: async () => undefined,
		isChannelUnavailable: () => false,
		...overrides,
	};
}

async function createManagedPaths(): Promise<AutoBotPaths> {
	const root = await fs.mkdtemp(path.join(os.homedir(), ".omp-autobot-bootstrap-"));
	const paths = autoBotPaths(root);
	await ensureAutoBotPrivateDirectory(root);
	for (const directory of [paths.controlDir, paths.lockDir, paths.runtimeDir, paths.handoffDir]) {
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		await ensureAutoBotPrivateDirectory(directory);
	}
	return paths;
}

describe("AutoBot fresh bootstrap launch selection", () => {
	test("selects the newest published pointer without consulting an older running session or staged predecessor", async () => {
		const paths = autoBotPaths("/managed");
		const calls: string[] = [];
		const preferred = active(9);
		const selected = await prepareAutoBotFreshLaunch(
			paths,
			launchId,
			deps({
				recover: async () => {
					calls.push("recover");
				},
				refresh: async () => {
					calls.push("refresh");
					// Sequence 8 represents bytes staged by an older session. Monotonic
					// publication has already retained the newer sequence-9 default.
					return refreshResult(preferred, 8);
				},
				readActive: async () => {
					throw new Error("fresh online selection consulted an old installed pointer");
				},
				verifyActive: async (_paths, pointer) => {
					calls.push(`verify-${pointer.manifest.releaseSequence}`);
				},
				writeDiagnostic: async (_paths, event) => {
					calls.push(`${event.outcome}-${event.releaseSequence}`);
				},
			}),
		);

		expect(selected).toBe(preferred);
		expect(calls).toEqual(["recover", "refresh", "verify-9", "completed-9"]);
	});

	test("does not globally quarantine a preferred release for an old session's explicit runtime rejection", () => {
		expect(shouldQuarantineAutoBotCandidateFailure(active(6), restartTarget(6), "runtime-rejected")).toBe(false);
		expect(shouldQuarantineAutoBotCandidateFailure(active(7), restartTarget(6), "runtime-rejected")).toBe(false);
		expect(shouldQuarantineAutoBotCandidateFailure(active(5), restartTarget(6), "runtime-rejected")).toBe(true);
		expect(shouldQuarantineAutoBotCandidateFailure(active(6), restartTarget(6), "startup-failed")).toBe(true);
	});

	test("falls back to a different verified installed default when the newer channel target is quarantined", async () => {
		const paths = autoBotPaths("/managed");
		const installed = active(5);
		const quarantined = new AutoBotInstallationQuarantinedError(manifest(6));
		const calls: string[] = [];
		const selected = await prepareAutoBotFreshLaunch(
			paths,
			launchId,
			deps({
				recover: async () => {
					calls.push("recover");
				},
				refresh: async () => {
					calls.push("refresh");
					throw quarantined;
				},
				readActive: async () => {
					calls.push("read-installed");
					return installed;
				},
				verifyActive: async (_paths, pointer) => {
					calls.push(`verify-${pointer.manifest.releaseSequence}`);
				},
				writeDiagnostic: async (_paths, event) => {
					calls.push(`${event.reason}-${event.releaseSequence}`);
				},
			}),
		);

		expect(selected).toBe(installed);
		expect(calls).toEqual(["recover", "refresh", "recover", "read-installed", "verify-5", "update-quarantined-5"]);
	});

	test("never launches an installed pointer matching the exact quarantined target", async () => {
		const paths = autoBotPaths("/managed");
		const quarantinedManifest = manifest(6);
		const quarantined = new AutoBotInstallationQuarantinedError(quarantinedManifest);
		let verified = false;
		await expect(
			prepareAutoBotFreshLaunch(
				paths,
				launchId,
				deps({
					refresh: async () => {
						throw quarantined;
					},
					readActive: async () => active(6),
					verifyActive: async () => {
						verified = true;
					},
				}),
			),
		).rejects.toBe(quarantined);
		expect(verified).toBe(false);
	});

	test("recognizes only canonical read-only status argv with supported leading profile globals", () => {
		expect(isAutoBotReadOnlyUpdateStatusInvocation(["update", "--status"])).toBe(true);
		expect(isAutoBotReadOnlyUpdateStatusInvocation(["--profile", "work", "update", "--status"])).toBe(true);
		expect(isAutoBotReadOnlyUpdateStatusInvocation(["--profile=work", "update", "--status"])).toBe(true);
		expect(isAutoBotReadOnlyUpdateStatusInvocation(["--system-prompt", "update", "--status"])).toBe(false);
		expect(isAutoBotReadOnlyUpdateStatusInvocation(["update", "--status", "prompt"])).toBe(false);
		expect(isAutoBotReadOnlyUpdateStatusInvocation(["--profile", "--status", "update", "--status"])).toBe(false);
	});

	test("status selects and verifies installed active without refresh, recovery, diagnostics, or promotion", async () => {
		const paths = autoBotPaths("/managed");
		const installed = active(6);
		const calls: string[] = [];
		const selection = await selectAutoBotLaunchActive(
			paths,
			launchId,
			["--profile=work", "update", "--status"],
			deps({
				recover: async () => {
					throw new Error("status attempted publication recovery");
				},
				refresh: async () => {
					throw new Error("status attempted network refresh or promotion");
				},
				readActive: async () => {
					calls.push("read-installed");
					return installed;
				},
				verifyActive: async (_paths, pointer) => {
					calls.push(`verify-${pointer.manifest.releaseSequence}`);
				},
				writeDiagnostic: async () => {
					throw new Error("status attempted diagnostic mutation");
				},
			}),
		);

		expect(selection).toEqual({ active: installed, readOnlyStatus: true });
		expect(calls).toEqual(["read-installed", "verify-6"]);
	});

	test("leaves a valid live foreign committed handoff untouched and permits the independent launch", async () => {
		const paths = await createManagedPaths();
		const foreignLaunchId = "f".repeat(32);
		const foreignClaim = { launchId: foreignLaunchId, bootstrapProcessId: process.pid };
		let foreignLease: AutoBotFileLockLease | undefined;
		try {
			foreignLease = await acquireAutoBotFileLock(autoBotLaunchLeaseLockPath(paths, foreignLaunchId));
			const targetManifest = manifest(8);
			const request = {
				sessionFile: path.join(paths.root, "old-session.jsonl"),
				sessionId: "old-session",
				cwd: paths.root,
				context: null,
				target: {
					releaseSequence: targetManifest.releaseSequence,
					upstreamVersion: targetManifest.upstreamVersion,
					forkCommit: targetManifest.forkCommit,
					sessionFormatVersion: targetManifest.sessionFormatVersion,
					collabProtocolVersion: targetManifest.collabProtocolVersion,
					compatibilityEpoch: targetManifest.compatibilityEpoch,
					webBundleId: targetManifest.webBundleId,
					handoffBudgetMs: 180_000,
				},
				predecessorTarget: {
					releaseSequence: 7,
					upstreamVersion: "1.0.7",
					forkCommit: "7".repeat(40),
					sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
					collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
					compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
					webBundleId: "web-7",
					handoffBudgetMs: 180_000,
				},
				nonce: "n".repeat(32),
			};
			const committed = {
				schemaVersion: 1,
				request,
				runtimePath: path.join(paths.runtimeDir, "slot-8", process.platform === "win32" ? "omp.exe" : "omp"),
				previousRuntimePath: path.join(
					paths.runtimeDir,
					"slot-7",
					process.platform === "win32" ? "omp.exe" : "omp",
				),
				committedAt: "2026-09-22T00:00:00.000Z",
				owner: {
					launchId: foreignLaunchId,
					bootstrapProcessId: process.pid,
					predecessorRuntimeProcessId: process.pid,
				},
				claim: foreignClaim,
				candidateRuntimeProcessId: process.pid,
				recoveryState: "candidate-running",
			};
			const serialized = `${JSON.stringify(committed)}\n`;
			await Bun.write(paths.committedRestartPath, serialized);

			const recovery = await resolveFreshLaunchHandoff(paths, {
				launchId,
				bootstrapProcessId: process.pid,
			});
			expect(recovery.kind).toBe("blocked");
			expect(await Bun.file(paths.committedRestartPath).text()).toBe(serialized);
		} finally {
			foreignLease?.release();
			await fs.rm(paths.root, { recursive: true, force: true });
		}
	});

	test("fails closed on a malformed foreign pending journal", async () => {
		const paths = await createManagedPaths();
		try {
			await Bun.write(paths.pendingRestartPath, "{}\n");
			await expect(
				resolveFreshLaunchHandoff(paths, {
					launchId,
					bootstrapProcessId: process.pid,
				}),
			).rejects.toBeInstanceOf(Error);
			expect(await Bun.file(paths.pendingRestartPath).text()).toBe("{}\n");
		} finally {
			await fs.rm(paths.root, { recursive: true, force: true });
		}
	});

	test("uses a reverified installed runtime with an explicit diagnostic only for channel unavailability", async () => {
		const paths = autoBotPaths("/managed");
		const unavailable = new Error("offline");
		const installed = active(7);
		const calls: string[] = [];
		const selected = await prepareAutoBotFreshLaunch(
			paths,
			launchId,
			deps({
				recover: async () => {
					calls.push("recover");
				},
				refresh: async () => {
					calls.push("refresh");
					throw unavailable;
				},
				readActive: async () => {
					calls.push("read-installed");
					return installed;
				},
				verifyActive: async (_paths, pointer) => {
					calls.push(`verify-${pointer.manifest.releaseSequence}`);
				},
				writeDiagnostic: async (_paths, event) => {
					calls.push(`${event.reason}-${event.outcome}-${event.releaseSequence}`);
				},
				isChannelUnavailable: error => error === unavailable,
			}),
		);

		expect(selected).toBe(installed);
		expect(calls).toEqual([
			"recover",
			"refresh",
			"recover",
			"read-installed",
			"verify-7",
			"offline-installed-fallback-deferred-7",
		]);
	});

	test("fails closed on a signed-channel or publication failure instead of using the installed pointer", async () => {
		const paths = autoBotPaths("/managed");
		const invalidRelease = new Error("signature invalid");
		let installedRead = false;
		await expect(
			prepareAutoBotFreshLaunch(
				paths,
				launchId,
				deps({
					refresh: async () => {
						throw invalidRelease;
					},
					readActive: async () => {
						installedRead = true;
						return active(7);
					},
				}),
			),
		).rejects.toBe(invalidRelease);
		expect(installedRead).toBe(false);
	});

	test("does not refresh or fall back while publication recovery is unresolved", async () => {
		const paths = autoBotPaths("/managed");
		const unresolved = new Error("publication recovery unresolved");
		let laterStepRan = false;
		let recoveryDiagnostic: string | undefined;
		await expect(
			prepareAutoBotFreshLaunch(
				paths,
				launchId,
				deps({
					recover: async () => {
						throw unresolved;
					},
					refresh: async () => {
						laterStepRan = true;
						return refreshResult(active(2), 2);
					},
					readActive: async () => {
						laterStepRan = true;
						return active(1);
					},
					writeDiagnostic: async (_paths, event) => {
						recoveryDiagnostic = `${event.reason}-${event.outcome}-${event.releaseSequence ?? "none"}`;
					},
				}),
			),
		).rejects.toBe(unresolved);
		expect(laterStepRan).toBe(false);
		expect(recoveryDiagnostic).toBe("publication-recovery-pending-failed-none");
	});
});
