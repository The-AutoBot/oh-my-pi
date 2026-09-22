import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
	AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
	parseAutoBotHandoffRecord,
	parseAutoBotRestartRequest,
	parseAutoBotRestartTarget,
	serializeAutoBotReleaseManifest,
	type AutoBotLaunchRelease,
	type AutoBotReleaseManifest,
	type AutoBotRestartTarget,
} from "@oh-my-pi/pi-coding-agent/autobot-update/contract";
import { fetchVerifiedAutoBotRelease } from "@oh-my-pi/pi-coding-agent/autobot-update/channel";
import {
	assertAutoBotDenyOnlyDarwinAclListing,
	assertAutoBotPrivateDirectoryAndOptionalFiles,
	ensureAutoBotPrivateDirectory,
} from "@oh-my-pi/pi-coding-agent/autobot-update/permissions";
import { __projectAutoBotHandoffProfileEnvironmentForTests } from "@oh-my-pi/pi-coding-agent/autobot-update/bootstrap";
import {
	hasAutoBotMinimumRemainingHandoffTime,
	planAutoBotLaunchUpdate,
} from "@oh-my-pi/pi-coding-agent/autobot-update/supervisor";
import { autoBotPaths, type AutoBotPaths } from "@oh-my-pi/pi-coding-agent/autobot-update/paths";
import {
	advanceAutoBotActivePointer,
	advanceAutoBotSequenceHighWater,
	assertAutoBotSequenceAllowed,
	isAutoBotReleaseQuarantined,
	quarantineAutoBotRelease,
	readAutoBotActivePointer,
	readAutoBotSequenceHighWater,
	type AutoBotActivePointer,
} from "@oh-my-pi/pi-coding-agent/autobot-update/state";
import {
	loadManagedSessionEnvironment,
	PROJECT_SESSION_BUS_ENVIRONMENT_NAMES,
	SHARED_SESSION_BUS_ENVIRONMENT_NAMES,
} from "@oh-my-pi/pi-coding-agent/autobot-update/session-bus-environment";

const windowsFilesystemSecurityTestTimeoutMs = process.platform === "win32" ? 120_000 : undefined;

const temporaryDirectories: string[] = [];

function isCryptoKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
	return "privateKey" in value && "publicKey" in value;
}

function expectChannelErrorToRedact(error: Error, sensitiveValue: string): void {
	expect(error.message).not.toContain(sensitiveValue);
	expect(String(error.cause)).not.toContain(sensitiveValue);
	if (error.cause instanceof Error) expect(error.cause.message).not.toContain(sensitiveValue);
}

function releaseManifest(releaseSequence: number): AutoBotReleaseManifest {
	return {
		schemaVersion: AUTO_BOT_RELEASE_SCHEMA_VERSION,
		releaseSequence,
		upstreamVersion: "18.2.3",
		forkCommit: "a".repeat(40),
		upstreamCommit: "b".repeat(40),
		publishedAt: "2026-09-17T00:00:00.000Z",
		minimumBootstrapVersion: AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		assets: [
			{
				kind: "runtime",
				target: "win32-x64",
				url: "https://releases.example.invalid/omp-win32-x64",
				size: 1,
				sha256: "c".repeat(64),
			},
		],
		webBundleId: "web-test",
	};
}

function launchRelease(releaseSequence: number): AutoBotLaunchRelease {
	const manifest = releaseManifest(releaseSequence);
	return {
		releaseSequence: manifest.releaseSequence,
		upstreamVersion: manifest.upstreamVersion,
		forkCommit: manifest.forkCommit,
		sessionFormatVersion: manifest.sessionFormatVersion,
		collabProtocolVersion: manifest.collabProtocolVersion,
		compatibilityEpoch: manifest.compatibilityEpoch,
		webBundleId: manifest.webBundleId,
	};
}

function restartTargetForManifest(manifest: AutoBotReleaseManifest): AutoBotRestartTarget {
	return {
		releaseSequence: manifest.releaseSequence,
		upstreamVersion: manifest.upstreamVersion,
		forkCommit: manifest.forkCommit,
		sessionFormatVersion: manifest.sessionFormatVersion,
		collabProtocolVersion: manifest.collabProtocolVersion,
		compatibilityEpoch: manifest.compatibilityEpoch,
		webBundleId: manifest.webBundleId,
		handoffBudgetMs: 180_000,
	};
}

function activePointer(paths: AutoBotPaths, releaseSequence: number, slotId: string): AutoBotActivePointer {
	return {
		schemaVersion: 1,
		slotId,
		runtimePath: path.join(paths.runtimeDir, slotId, "omp"),
		runtimeSha256: releaseSequence.toString(16).padStart(64, "0"),
		manifest: releaseManifest(releaseSequence),
		activatedAt: "2026-09-17T00:00:00.000Z",
	};
}

async function createTemporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autobot-replay-security-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function createPrivateTemporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.homedir(), ".omp-autobot-permissions-"));
	temporaryDirectories.push(directory);
	return ensureAutoBotPrivateDirectory(directory);
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error("Expected AutoBot replay fence rejection to be an Error");
	}
	throw new Error("Expected AutoBot replay fence to reject");
}

function restartTarget(releaseSequence: number): AutoBotRestartTarget {
	return {
		releaseSequence,
		upstreamVersion: "18.2.3",
		forkCommit: releaseSequence === 42 ? "d".repeat(40) : "e".repeat(40),
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		webBundleId: `web-${releaseSequence}`,
		handoffBudgetMs: 180_000,
	};
}

function restartRequestInput(
	target = restartTarget(43),
	predecessorTarget = restartTarget(42),
): Record<string, unknown> {
	return {
		sessionFile: "/tmp/session.jsonl",
		sessionId: "session-43",
		cwd: "/tmp/project",
		context: null,
		target,
		predecessorTarget,
		nonce: "a".repeat(32),
	};
}

function handoffInput(
	request: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		...request,
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		role: "candidate",
		owner: {
			launchId: "b".repeat(32),
			bootstrapProcessId: 123,
			predecessorRuntimeProcessId: 456,
		},
		runtimePath: "/managed/runtime/omp",
		previousRuntimePath: "/managed/previous/omp",
		createdAt: "2026-09-17T00:00:00.000Z",
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("AutoBot release replay fence", () => {
	test(
		"allows an exact repeat but rejects rollback and equivocation before staging",
		async () => {
			const paths = autoBotPaths(await createTemporaryDirectory());
			const accepted = releaseManifest(7);
			const acceptedPayloadSha256 = "d".repeat(64);
			await advanceAutoBotSequenceHighWater(paths, accepted, acceptedPayloadSha256);

			await assertAutoBotSequenceAllowed(paths, accepted, acceptedPayloadSha256);
			const rollbackError = await rejectionOf(
				assertAutoBotSequenceAllowed(paths, releaseManifest(6), "e".repeat(64)),
			);
			expect(rollbackError.message).toContain("lower than the accepted high-water mark");
			const equivocationError = await rejectionOf(
				assertAutoBotSequenceAllowed(paths, releaseManifest(7), "e".repeat(64)),
			);
			expect(equivocationError.message).toContain("conflicts with the accepted signed payload");

			const highWater = await readAutoBotSequenceHighWater(paths);
			expect(highWater).toMatchObject({
				releaseSequence: accepted.releaseSequence,
				payloadSha256: acceptedPayloadSha256,
			});
			const runtimeDirectoryError = await rejectionOf(fs.lstat(paths.runtimeDir));
			expect((runtimeDirectoryError as NodeJS.ErrnoException).code).toBe("ENOENT");
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);
});

describe("AutoBot signed channel redirects", () => {
	test("follows only explicitly allowed redirects without credentials", async () => {
		const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
		if (!isCryptoKeyPair(generated)) throw new Error("Ed25519 key generation did not return a key pair");
		const manifest = releaseManifest(7);
		const payload = serializeAutoBotReleaseManifest(manifest);
		const signature = await crypto.subtle.sign("Ed25519", generated.privateKey, new TextEncoder().encode(payload));
		const initialUrl = "https://github.com/oh-my-pi/autobot/releases/channel.json";
		const assetUrl = "https://release-assets.githubusercontent.com/oh-my-pi/autobot/channel.json?signed=token";
		const envelope = JSON.stringify({
			keyId: "current",
			payload,
			signature: Buffer.from(signature).toString("base64"),
		});
		const channel = {
			schemaVersion: 1 as const,
			envelopeUrl: initialUrl,
			collabPortalUrl: "https://collab.example.invalid/live",
			trustedKeys: {
				current: Buffer.from(await crypto.subtle.exportKey("spki", generated.publicKey)).toString("base64"),
			},
			allowedArtifactOrigins: ["https://release-assets.githubusercontent.com/"],
		};
		const credentials: string[] = [];
		const verified = await fetchVerifiedAutoBotRelease(channel, {
			fetchImpl: (async (input, init) => {
				credentials.push(init?.credentials ?? "missing");
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url === initialUrl) return new Response(null, { status: 302, headers: { location: assetUrl } });
				if (url === assetUrl) return new Response(envelope, { status: 200 });
				throw new Error("Unexpected channel request");
			}) as typeof fetch,
		});

		expect(verified.manifest).toEqual(manifest);
		expect(credentials).toEqual(["omit", "omit"]);

		const rejectedCredentials: string[] = [];
		let rejectedBodyCancelled = false;
		const rejected = await rejectionOf(
			fetchVerifiedAutoBotRelease(channel, {
				fetchImpl: (async (_input, init) => {
					rejectedCredentials.push(init?.credentials ?? "missing");
					return {
						status: 302,
						ok: false,
						headers: new Headers({ location: "https://unapproved.example.invalid/channel.json" }),
						body: {
							cancel: async () => {
								rejectedBodyCancelled = true;
							},
						},
					} as unknown as Response;
				}) as typeof fetch,
			}),
		);
		expect(rejected).toBeInstanceOf(Error);
		expect(rejectedCredentials).toEqual(["omit"]);
		expect(rejectedBodyCancelled).toBeTrue();
	});

	test("redacts failing response streams and cancels incomplete reads", async () => {
		const sensitiveUrl = "https://release-assets.githubusercontent.com/channel.json?X-Amz-Signature=secret";
		const channel = {
			schemaVersion: 1 as const,
			envelopeUrl: "https://github.com/oh-my-pi/autobot/releases/channel.json",
			collabPortalUrl: "https://collab.example.invalid/live",
			trustedKeys: { current: Buffer.from("placeholder-key").toString("base64") },
			allowedArtifactOrigins: [],
		};
		const getReaderError = await rejectionOf(
			fetchVerifiedAutoBotRelease(channel, {
				fetchImpl: (async (_input, _init) => {
					return {
						status: 200,
						ok: true,
						headers: new Headers(),
						body: {
							getReader: () => {
								throw new Error(sensitiveUrl);
							},
						},
					} as unknown as Response;
				}) as typeof fetch,
			}),
		);
		expectChannelErrorToRedact(getReaderError, sensitiveUrl);

		let incompleteBodyCancelled = false;
		const readError = await rejectionOf(
			fetchVerifiedAutoBotRelease(channel, {
				fetchImpl: (async (_input, _init) => {
					return {
						status: 200,
						ok: true,
						headers: new Headers(),
						body: {
							getReader: () => ({
								read: async () => {
									throw new Error(sensitiveUrl);
								},
								cancel: async () => {
									incompleteBodyCancelled = true;
								},
								releaseLock: () => {},
							}),
						},
					} as unknown as Response;
				}) as typeof fetch,
			}),
		);
		expectChannelErrorToRedact(readError, sensitiveUrl);
		expect(incompleteBodyCancelled).toBeTrue();
	});
});

describe("AutoBot failed candidate quarantine", () => {
	test(
		"quarantines only the exact failed R43 release",
		async () => {
			const paths = autoBotPaths(await createTemporaryDirectory());
			const failedR43 = releaseManifest(43);
			const newerR44 = releaseManifest(44);

			await quarantineAutoBotRelease(paths, restartTargetForManifest(failedR43));

			expect(await isAutoBotReleaseQuarantined(paths, failedR43)).toBeTrue();
			expect(await isAutoBotReleaseQuarantined(paths, newerR44)).toBeFalse();
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);
});

describe("AutoBot installation-wide active pointer", () => {
	test(
		"keeps an R42 session's predecessor independent from a newer global pointer",
		async () => {
			const paths = autoBotPaths(await createTemporaryDirectory());
			const r42Fallback = activePointer(paths, 42, "r42-fallback");
			const r43 = activePointer(paths, 43, "r43");
			const competingR43 = activePointer(paths, 43, "r43-competing");

			expect(await advanceAutoBotActivePointer(paths, r42Fallback)).toEqual(r42Fallback);
			expect(await advanceAutoBotActivePointer(paths, r43)).toEqual(r43);

			const plan = planAutoBotLaunchUpdate(launchRelease(42), releaseManifest(44));
			expect(plan).toMatchObject({
				target: { releaseSequence: 44, handoffBudgetMs: 390_000 },
				predecessorTarget: { releaseSequence: 42, handoffBudgetMs: 390_000 },
			});

			expect(await advanceAutoBotActivePointer(paths, r42Fallback)).toEqual(r43);
			expect(await advanceAutoBotActivePointer(paths, competingR43)).toEqual(r43);
			expect(await readAutoBotActivePointer(paths)).toEqual(r43);
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);
});

describe("AutoBot restart handoff contracts", () => {
	test("requires an immutable predecessor target for every restart request", () => {
		const { predecessorTarget: _ignored, ...withoutPredecessor } = restartRequestInput();

		expect(() => parseAutoBotRestartRequest(withoutPredecessor)).toThrow();
	});

	test("admits the canonical new-reservation budget but rejects a longer target", () => {
		const bounded = { ...restartTarget(43), handoffBudgetMs: 390_000 };
		expect(parseAutoBotRestartTarget(bounded)).toEqual(bounded);
		expect(() => parseAutoBotRestartTarget({ ...bounded, handoffBudgetMs: 390_001 })).toThrow();
	});

	test("admits a fallback only when it restores the recorded predecessor", () => {
		const candidateTarget = restartTarget(43);
		const predecessorTarget = restartTarget(42);
		const fallback = parseAutoBotHandoffRecord(
			handoffInput(restartRequestInput(candidateTarget, predecessorTarget), {
				role: "fallback",
				target: predecessorTarget,
				predecessorTarget,
				attemptedTarget: candidateTarget,
			}),
		);

		expect(fallback.role).toBe("fallback");
		expect(fallback.target).toEqual(predecessorTarget);
		expect(fallback.predecessorTarget).toEqual(predecessorTarget);
		expect(fallback.attemptedTarget).toEqual(candidateTarget);
	});

	test("rejects forged candidate and fallback target relationships", () => {
		const candidateTarget = restartTarget(43);
		const predecessorTarget = restartTarget(42);
		const request = restartRequestInput(candidateTarget, predecessorTarget);

		expect(() => parseAutoBotHandoffRecord(handoffInput(request, { attemptedTarget: candidateTarget }))).toThrow();
		expect(() =>
			parseAutoBotHandoffRecord(
				handoffInput(request, {
					role: "fallback",
					target: predecessorTarget,
					predecessorTarget,
				}),
			),
		).toThrow();
		expect(() =>
			parseAutoBotHandoffRecord(
				handoffInput(request, {
					role: "fallback",
					target: candidateTarget,
					predecessorTarget,
					attemptedTarget: candidateTarget,
				}),
			),
		).toThrow();
		expect(() =>
			parseAutoBotHandoffRecord(
				handoffInput(request, {
					role: "fallback",
					target: predecessorTarget,
					predecessorTarget,
					attemptedTarget: predecessorTarget,
				}),
			),
		).toThrow();
	});

	test("requires a fallback identity for a broker-expiring handoff", () => {
		const candidateTarget = restartTarget(43);
		const predecessorTarget = restartTarget(42);
		const brokeredRequest = {
			...restartRequestInput(candidateTarget, predecessorTarget),
			expiresAt: "2026-09-17T00:05:00.000Z",
			leaseDurationMs: 90_000,
		};
		const fallback = {
			role: "fallback",
			target: predecessorTarget,
			predecessorTarget,
			attemptedTarget: candidateTarget,
		};

		expect(() => parseAutoBotHandoffRecord(handoffInput(brokeredRequest, fallback))).toThrow();
		const admitted = parseAutoBotHandoffRecord(
			handoffInput(brokeredRequest, { ...fallback, fallbackInstanceId: "fallback-42" }),
		);
		expect(admitted.fallbackInstanceId).toBe("fallback-42");
	});

	test("pins named and default handoffs over ambient profile aliases", () => {
		const ambient: NodeJS.ProcessEnv = {
			OMP_PROFILE: "ambient-omp",
			omp_profile: "ambient-omp-case-variant",
			PI_PROFILE: "ambient-pi",
			pi_profile: "ambient-pi-case-variant",
			KEEP: "unchanged",
		};
		const profileAliases = (environment: NodeJS.ProcessEnv) =>
			Object.keys(environment).filter(key => {
				const normalized = key.toUpperCase();
				return normalized === "OMP_PROFILE" || normalized === "PI_PROFILE";
			});

		const named = __projectAutoBotHandoffProfileEnvironmentForTests(ambient, { profile: "smoke" });
		expect(named.OMP_PROFILE).toBe("smoke");
		expect(named.KEEP).toBe("unchanged");
		expect(profileAliases(named)).toEqual(["OMP_PROFILE"]);

		const defaultProfile = __projectAutoBotHandoffProfileEnvironmentForTests(ambient, { profile: undefined });
		expect(defaultProfile.KEEP).toBe("unchanged");
		expect(profileAliases(defaultProfile)).toEqual([]);
		expect(__projectAutoBotHandoffProfileEnvironmentForTests(ambient, undefined)).toBe(ambient);
	});

	test("requires the entire worst-case handoff reserve before predecessor shutdown", () => {
		expect(hasAutoBotMinimumRemainingHandoffTime(390_000, 120_000)).toBeTrue();
		expect(hasAutoBotMinimumRemainingHandoffTime(390_000, 120_001)).toBeFalse();
	});
});

describe("Managed AutoBot session environment", () => {
	test("uses home identity while confining workspace dotenv to role and name", async () => {
		const home = await createTemporaryDirectory();
		const project = await createTemporaryDirectory();
		await fs.writeFile(
			path.join(home, ".env"),
			[
				"OMP_SESSION_BUS_PC_ID=home-pc",
				"OMP_SESSION_BUS_MACHINE_KEY=home-machine-key",
				"OMP_SESSION_BUS_ENDPOINT=wss://home.example.test/bus",
				"OMP_SESSION_AUTO_COLLAB=1",
				"OMP_SESSION_BUS_ALLOW_STEER=1",
				"OMP_SESSION_COLLAB_WEB_URL=https://home.example.test/live",
				"OMP_SESSION_BUS_ROLE=home-role",
				"OMP_SESSION_BUS_NAME=home-name",
				"OMP_AUTOBOT_SUPERVISOR_TOKEN=forged-home-capability",
				"UNRELATED_VALUE=not-imported",
			].join("\n"),
		);
		await fs.writeFile(
			path.join(project, ".env"),
			[
				"OMP_SESSION_BUS_PC_ID=project-pc",
				"OMP_SESSION_BUS_MACHINE_KEY=project-machine-key",
				"OMP_SESSION_BUS_ENDPOINT=wss://project.example.test/bus",
				"OMP_SESSION_AUTO_COLLAB=0",
				"OMP_SESSION_BUS_ALLOW_STEER=0",
				"OMP_SESSION_BUS_ROLE=coordinator",
				'OMP_SESSION_BUS_NAME="Project Coordinator"',
				"OMP_SESSION_COLLAB_WEB_URL=https://project.example.test/live",
				"OMP_AUTOBOT_SUPERVISOR_TOKEN=forged-project-capability",
			].join("\n"),
		);
		const launchEnvironment: NodeJS.ProcessEnv = {
			OMP_SESSION_COLLAB_WEB_URL: "__OMP_AUTOBOT_ABSENT__",
			OMP_AUTOBOT_SUPERVISOR_TOKEN: "authenticated-capability",
			OMP_AUTOBOT_RELEASE_VERSION: "authenticated-release",
		};
		const environment: NodeJS.ProcessEnv = {
			...launchEnvironment,
			OMP_SESSION_BUS_PC_ID: "project-pc",
			OMP_SESSION_BUS_MACHINE_KEY: "project-machine-key",
			OMP_SESSION_BUS_ENDPOINT: "wss://project.example.test/bus",
			OMP_SESSION_AUTO_COLLAB: "0",
			OMP_SESSION_BUS_ALLOW_STEER: "0",
			OMP_SESSION_BUS_ROLE: "coordinator",
			OMP_SESSION_BUS_NAME: "Project Coordinator",
		};

		loadManagedSessionEnvironment({
			homeDirectory: home,
			projectDirectory: project,
			environment,
			launchEnvironment,
		});

		expect(SHARED_SESSION_BUS_ENVIRONMENT_NAMES).toEqual([
			"OMP_SESSION_AUTO_COLLAB",
			"OMP_SESSION_BUS_ALLOW_STEER",
			"OMP_SESSION_BUS_ENDPOINT",
			"OMP_SESSION_BUS_MACHINE_KEY",
			"OMP_SESSION_BUS_PC_ID",
		]);
		expect(PROJECT_SESSION_BUS_ENVIRONMENT_NAMES).toEqual(["OMP_SESSION_BUS_ROLE", "OMP_SESSION_BUS_NAME"]);
		expect(environment).toEqual({
			OMP_SESSION_COLLAB_WEB_URL: "__OMP_AUTOBOT_ABSENT__",
			OMP_AUTOBOT_SUPERVISOR_TOKEN: "authenticated-capability",
			OMP_AUTOBOT_RELEASE_VERSION: "authenticated-release",
			OMP_SESSION_AUTO_COLLAB: "1",
			OMP_SESSION_BUS_ALLOW_STEER: "1",
			OMP_SESSION_BUS_ENDPOINT: "wss://home.example.test/bus",
			OMP_SESSION_BUS_MACHINE_KEY: "home-machine-key",
			OMP_SESSION_BUS_PC_ID: "home-pc",
			OMP_SESSION_BUS_ROLE: "coordinator",
			OMP_SESSION_BUS_NAME: "Project Coordinator",
		});
	});

	test("preserves inherited settings and ignores unusable home dotenv input", async () => {
		const home = await createTemporaryDirectory();
		const project = await createTemporaryDirectory();
		await fs.mkdir(path.join(home, ".env"));
		await fs.writeFile(
			path.join(project, ".env"),
			"OMP_SESSION_BUS_ROLE=coordinator\nOMP_SESSION_BUS_NAME=project-name\n",
		);
		const launchEnvironment: NodeJS.ProcessEnv = {
			OMP_SESSION_BUS_ENDPOINT: "wss://inherited.example.test/bus",
			OMP_SESSION_BUS_ROLE: "participant",
			OMP_SESSION_BUS_NAME: "inherited-name",
			OMP_SESSION_COLLAB_WEB_URL: "https://managed.example.test/live/release",
			OMP_AUTOBOT_SUPERVISOR_TOKEN: "authenticated-capability",
		};
		const environment: NodeJS.ProcessEnv = { ...launchEnvironment };

		loadManagedSessionEnvironment({
			homeDirectory: home,
			projectDirectory: project,
			environment,
			launchEnvironment,
		});

		expect(environment).toEqual(launchEnvironment);
	});
});

describe("AutoBot managed directory cohorts", () => {
	test(
		"accepts absent optional files and rejects paths outside the managed directory",
		async () => {
			const directory = await createPrivateTemporaryDirectory();
			const present = path.join(directory, "state.db");
			await fs.writeFile(present, "state");
			await fs.chmod(present, 0o600);

			await expect(
				assertAutoBotPrivateDirectoryAndOptionalFiles(directory, [present, path.join(directory, "state.db-wal")]),
			).resolves.toBe(await fs.realpath(directory));
			await expect(
				assertAutoBotPrivateDirectoryAndOptionalFiles(directory, [path.join(directory, "nested", "state.db")]),
			).rejects.toThrow("immediate children");
			await expect(
				assertAutoBotPrivateDirectoryAndOptionalFiles(directory, [path.join(path.dirname(directory), "state.db")]),
			).rejects.toThrow("immediate children");
			await expect(
				assertAutoBotPrivateDirectoryAndOptionalFiles(directory, [path.dirname(directory)]),
			).rejects.toThrow("immediate children");
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);

	test(
		"rejects a present optional reparse point instead of following it",
		async () => {
			const directory = await createPrivateTemporaryDirectory();
			const target = await createPrivateTemporaryDirectory();
			const linkedFile = path.join(directory, "state.db");
			await fs.symlink(target, linkedFile, process.platform === "win32" ? "junction" : "dir");

			await expect(assertAutoBotPrivateDirectoryAndOptionalFiles(directory, [linkedFile])).rejects.toThrow(
				"real regular file",
			);
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);

	test(
		"rejects a regular optional file writable by another identity",
		async () => {
			const directory = await createPrivateTemporaryDirectory();
			const unsafe = path.join(directory, "state.db");
			await fs.writeFile(unsafe, "state");
			if (process.platform === "win32") {
				const icacls = path.join(process.env.SystemRoot ?? "", "System32", "icacls.exe");
				const child = Bun.spawn([icacls, unsafe, "/grant", "*S-1-1-0:W"], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "pipe",
				});
				const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
				if (exitCode !== 0) throw new Error(`Cannot prepare unsafe ACL fixture: ${stderr}`);
			} else {
				await fs.chmod(unsafe, 0o666);
			}

			await expect(assertAutoBotPrivateDirectoryAndOptionalFiles(directory, [unsafe])).rejects.toThrow();
		},
		windowsFilesystemSecurityTestTimeoutMs,
	);
});

describe("AutoBot macOS ACL listings", () => {
	test("accepts C-locale deny-only ACL markers and fails closed otherwise", () => {
		expect(() =>
			assertAutoBotDenyOnlyDarwinAclListing(
				"drwx------+ 8 owner staff 256 Jan  1 00:00 home\n 0: everyone deny delete\n",
			),
		).not.toThrow();
		expect(() =>
			assertAutoBotDenyOnlyDarwinAclListing(
				"-rw-------@+ 1 owner staff 1 Jan  1 00:00 credential\n 0: everyone deny write\n",
			),
		).not.toThrow();
		expect(() =>
			assertAutoBotDenyOnlyDarwinAclListing(
				"-rw-------+ 1 owner staff 1 Jan  1 00:00 credential\n 0: everyone allow write\n",
			),
		).toThrow();
		expect(() =>
			assertAutoBotDenyOnlyDarwinAclListing(
				"-rw-------+ 1 owner staff 1 Jan  1 00:00 credential\n 0: everyone audit write\n",
			),
		).toThrow();
		expect(() =>
			assertAutoBotDenyOnlyDarwinAclListing("-rw-------+ 1 owner staff 1 Jan  1 00:00 credential\n"),
		).toThrow();
	});
});
