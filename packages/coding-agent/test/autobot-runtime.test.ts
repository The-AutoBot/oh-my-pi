import { expect, test } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	AutoBotRuntime,
	type AutoBotCoordinatorPreflight,
	createAutoBotCandidateArgs,
	createAutoBotRestartLaunchContext,
	parseAutoBotRestartLaunchContext,
} from "@oh-my-pi/pi-coding-agent/autobot-runtime";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_SESSION_FORMAT_VERSION,
	type AutoBotRestartRequest,
	type JsonValue,
} from "@oh-my-pi/pi-coding-agent/autobot-update/contract";

const request: AutoBotRestartRequest = {
	sessionFile: "/tmp/session.jsonl",
	sessionId: "session-1",
	cwd: "/tmp/project",
	context: null,
	nonce: "a".repeat(32),
	target: {
		releaseSequence: 2,
		upstreamVersion: "1.2.3",
		forkCommit: "a".repeat(40),
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		webBundleId: "bundle_2",
		handoffBudgetMs: 180_000,
	},
	predecessorTarget: {
		releaseSequence: 1,
		upstreamVersion: "1.2.2",
		forkCommit: "b".repeat(40),
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		webBundleId: "bundle_1",
		handoffBudgetMs: 180_000,
	},
};

type RuntimeSession = ConstructorParameters<typeof AutoBotRuntime>[0];
type RuntimeMode = ConstructorParameters<typeof AutoBotRuntime>[2];

type PreflightSession = Pick<RuntimeSession, "getEvalKernelOwnerId"> & {
	readonly sessionManager: Pick<
		RuntimeSession["sessionManager"],
		"isSessionOnDisk" | "getSessionId" | "getCwd" | "flush"
	>;
	readonly autoBotUpdateCoordinator: Pick<
		NonNullable<RuntimeSession["autoBotUpdateCoordinator"]>,
		"canPrepare" | "prepare"
	>;
};

type PreflightMode = Pick<
	RuntimeMode,
	"getAutoBotUpdateDeferralReason" | "beginAutoBotUpdateAdmission" | "mcpManager"
> & {
	readonly collabController: Pick<RuntimeMode["collabController"], "canPrepareUpdate">;
};

function runtimeForPreflight(
	isCollabSafe: () => boolean,
	canPrepare: () => Promise<AutoBotCoordinatorPreflight>,
	onReservation: () => void,
	transport?: {
		readonly hasActiveRequests?: boolean;
		acquireRestartQuiescence?: () => { release(): void } | undefined;
	},
	interactiveReason?: string,
): AutoBotRuntime {
	const session = {
		sessionManager: {
			isSessionOnDisk: () => true,
			getSessionId: () => "autobot-runtime-preflight",
			getCwd: () => process.cwd(),
			flush: async () => {
				throw new Error("read-only preflight must not flush the session");
			},
		},
		getEvalKernelOwnerId: () => "autobot-runtime-preflight",
		autoBotUpdateCoordinator: {
			canPrepare,
			prepare: async () => {
				onReservation();
				throw new Error("read-only preflight must not reserve the coordinator");
			},
		},
	} satisfies PreflightSession;
	const mode = {
		mcpManager: transport
			? {
					get restartQuiescenceReason(): string | undefined {
						if (transport.hasActiveRequests === true) return "mcp-request-active";
						return transport.acquireRestartQuiescence ? undefined : "mcp-restart-quiescence-unsupported";
					},
					acquireRestartQuiescence: () => transport.acquireRestartQuiescence?.(),
				}
			: undefined,
		getAutoBotUpdateDeferralReason: () => interactiveReason,
		beginAutoBotUpdateAdmission: () => {
			throw new Error("read-only preflight must not begin update admission");
		},
		collabController: {
			canPrepareUpdate: () => (isCollabSafe() ? { safe: true } : { safe: false, reason: "guest-incompatible" }),
		},
	} satisfies PreflightMode;
	return new AutoBotRuntime(
		session as unknown as RuntimeSession,
		parseArgs([]),
		mode as unknown as RuntimeMode,
		undefined,
	);
}

test("AutoBot preflight defers without reserving when browser safety changes during coordinator preflight", async () => {
	const preflightStarted = Promise.withResolvers<void>();
	const preflight = Promise.withResolvers<AutoBotCoordinatorPreflight>();
	let collabSafe = true;
	let reservations = 0;
	const runtime = runtimeForPreflight(
		() => collabSafe,
		() => {
			preflightStarted.resolve();
			return preflight.promise;
		},
		() => {
			reservations++;
		},
	);

	const result = runtime.hooks.canPrepareRestart(request.target, request.predecessorTarget);
	await preflightStarted.promise;
	collabSafe = false;
	preflight.resolve({ canPrepare: true });

	expect(await result).toEqual({ canPrepare: false, reason: "collab-guest-incompatible" });
	expect(reservations).toBe(0);
});

test("AutoBot preflight admits an idle explicitly reconnectable MCP transport", async () => {
	const runtime = runtimeForPreflight(
		() => true,
		async () => ({ canPrepare: true }),
		() => {},
		{ hasActiveRequests: false, acquireRestartQuiescence: () => ({ release: () => {} }) },
	);

	expect(await runtime.hooks.canPrepareRestart(request.target, request.predecessorTarget)).toEqual({
		canPrepare: true,
	});
});

test("AutoBot preflight reports active and unsupported MCP transports without disturbing them", async () => {
	const active = runtimeForPreflight(
		() => true,
		async () => ({ canPrepare: true }),
		() => {},
		{ hasActiveRequests: true, acquireRestartQuiescence: () => ({ release: () => {} }) },
	);
	expect(await active.hooks.canPrepareRestart(request.target, request.predecessorTarget)).toEqual({
		canPrepare: false,
		reason: "mcp-request-active",
	});

	const unsupported = runtimeForPreflight(
		() => true,
		async () => ({ canPrepare: true }),
		() => {},
		{ hasActiveRequests: false },
	);
	expect(await unsupported.hooks.canPrepareRestart(request.target, request.predecessorTarget)).toEqual({
		canPrepare: false,
		reason: "mcp-restart-quiescence-unsupported",
	});
});

test("AutoBot preflight preserves coordinator deferral reason as a stable code", async () => {
	const runtime = runtimeForPreflight(
		() => true,
		async () => ({ canPrepare: false, reason: "reservation-contended" }),
		() => {},
	);
	expect(await runtime.hooks.canPrepareRestart(request.target, request.predecessorTarget)).toEqual({
		canPrepare: false,
		reason: "coordinator-reservation-contended",
	});
});

test("AutoBot preflight reports a busy session without reserving shared handoff state", async () => {
	let coordinatorChecks = 0;
	const runtime = runtimeForPreflight(
		() => true,
		async () => {
			coordinatorChecks++;
			return { canPrepare: true };
		},
		() => {},
		undefined,
		"session work is still active",
	);
	expect(await runtime.hooks.canPrepareRestart(request.target, request.predecessorTarget)).toEqual({
		canPrepare: false,
		reason: "session-work-active",
	});
	expect(coordinatorChecks).toBe(0);
});

test("AutoBot preparation materializes an idle empty session without changing its identity", async () => {
	const sessionId = "empty-session";
	const sessionFile = "/tmp/empty-session.jsonl";
	const admission = {};
	let onDisk = false;
	let mcpQuiesced = false;
	let ensureCalls = 0;
	const preparation = {
		reservationId: "reservation",
		fallbackInstanceId: "fallback",
		predecessorInstanceId: "predecessor",
		successorInstanceId: "successor",
		predecessorTarget: request.predecessorTarget,
		expiresAt: "2030-01-01T00:00:00.000Z",
		leaseDurationMs: 600_000,
		target: request.target,
		handoff: { manualRoom: "preserve" as const, collab: "preserve" as const },
	};
	const session = {
		sessionManager: {
			isSessionOnDisk: () => onDisk,
			ensureOnDisk: async () => {
				ensureCalls++;
				onDisk = true;
			},
			flush: async () => {},
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
			getCwd: () => process.cwd(),
		},
		getEvalKernelOwnerId: () => sessionId,
		autoBotUpdateCoordinator: {
			canPrepare: async () => ({ canPrepare: true as const }),
			prepare: async () => preparation,
			cancel: async () => {},
			abandon: async () => {},
		},
	};
	const mode = {
		mcpManager: {
			get restartQuiescenceReason(): string | undefined {
				return mcpQuiesced ? "mcp-restart-quiescence-unavailable" : undefined;
			},
			acquireRestartQuiescence: () => {
				if (mcpQuiesced) return undefined;
				mcpQuiesced = true;
				return {
					release: () => {
						mcpQuiesced = false;
					},
				};
			},
		},
		getAutoBotUpdateDeferralReason: () => undefined,
		beginAutoBotUpdateAdmission: () => admission,
		isAutoBotUpdateAdmissionValid: (value: unknown) => value === admission,
		isAutoBotUpdateExitRequested: () => false,
		cancelAutoBotUpdateAdmission: () => {},
		collabController: {
			canPrepareUpdate: () => ({ safe: true as const }),
			captureAutoBotFallbackState: () => ({ wasHosting: false as const }),
		},
	};
	const runtime = new AutoBotRuntime(
		session as unknown as ConstructorParameters<typeof AutoBotRuntime>[0],
		parseArgs([]),
		mode as unknown as ConstructorParameters<typeof AutoBotRuntime>[2],
		undefined,
	);

	expect(await runtime.hooks.canPrepareRestart(request.target, request.predecessorTarget)).toEqual({
		canPrepare: true,
	});
	const prepared = await runtime.hooks.prepareRestart!(request.target, request.predecessorTarget);
	expect(ensureCalls).toBe(1);
	expect(prepared).toMatchObject({ sessionId, sessionFile });
	expect(mcpQuiesced).toBe(true);
	await runtime.hooks.abortRestart!(request, "candidate-rejected");
	expect(mcpQuiesced).toBe(false);
});

test("AutoBot restart capsule rejects nonpersistent credential and prompt overrides", () => {
	const credentialArgs = parseArgs(["--model", "openai/gpt-5", "--api-key", "secret"]);
	expect(createAutoBotRestartLaunchContext(credentialArgs)).toBeUndefined();

	const promptArgs = parseArgs(["--append-system-prompt", "private prompt"]);
	expect(createAutoBotRestartLaunchContext(promptArgs)).toBeUndefined();
});

test("AutoBot candidate args restore only safe effective launch state", () => {
	const args = parseArgs([
		"--no-lsp",
		"--no-pty",
		"--approval-mode",
		"write",
		"--config",
		"/tmp/config.yml",
		"ignored prompt",
	]);
	const context = createAutoBotRestartLaunchContext(args);
	expect(context).toBeDefined();
	const parsed = parseAutoBotRestartLaunchContext(context!, request.target, {
		target: request.target,
		predecessorTarget: request.predecessorTarget,
	});
	expect(parsed).toEqual(context);

	const candidate = createAutoBotCandidateArgs(request, parsed!);
	expect(candidate.cwd).toBe(request.cwd);
	expect(candidate.resume).toBe(request.sessionFile);
	expect(candidate.config).toEqual(["/tmp/config.yml"]);
	expect(candidate.noLsp).toBeTrue();
	expect(candidate.noPty).toBeTrue();
	expect(candidate.approvalMode).toBe("write");
	expect(candidate.messages).toEqual([]);
	expect(candidate.fileArgs).toEqual([]);
	expect(candidate.model).toBeUndefined();
	expect(candidate.apiKey).toBeUndefined();
});

test("AutoBot candidate rejects a coordinator reservation for another release", () => {
	const args = parseArgs([]);
	const context = createAutoBotRestartLaunchContext(args, {
		reservationId: "reservation",
		fallbackInstanceId: "fallback",
		predecessorInstanceId: "old",
		successorInstanceId: "new",
		expiresAt: "2026-01-01T00:00:00.000Z",
		leaseDurationMs: 180_000,
		target: request.target,
		predecessorTarget: request.predecessorTarget,
		handoff: { manualRoom: "preserve", collab: "preserve" },
	});
	expect(context).toBeDefined();
	const incompatible = { ...request.target, releaseSequence: request.target.releaseSequence + 1 };
	expect(
		parseAutoBotRestartLaunchContext(context!, incompatible, {
			target: incompatible,
			predecessorTarget: request.predecessorTarget,
		}),
	).toBeUndefined();
});

test("AutoBot candidate treats coordinator expiry as diagnostic, not a cross-clock deadline", () => {
	const args = parseArgs([]);
	const context = createAutoBotRestartLaunchContext(args, {
		reservationId: "reservation",
		fallbackInstanceId: "fallback",
		predecessorInstanceId: "old",
		successorInstanceId: "new",
		expiresAt: "2000-01-01T00:00:00.000Z",
		leaseDurationMs: 180_000,
		target: request.target,
		predecessorTarget: request.predecessorTarget,
		handoff: { manualRoom: "preserve", collab: "preserve" },
	});
	expect(context).toBeDefined();
	expect(
		parseAutoBotRestartLaunchContext(context!, request.target, {
			target: request.target,
			predecessorTarget: request.predecessorTarget,
		}),
	).toEqual(context);
});

test("AutoBot fallback capsule binds the failed target while restoring the recorded predecessor", () => {
	const context = createAutoBotRestartLaunchContext(
		parseArgs([]),
		{
			reservationId: "reservation",
			fallbackInstanceId: "fallback",
			predecessorInstanceId: "old",
			successorInstanceId: "new",
			expiresAt: "2026-01-01T00:00:00.000Z",
			leaseDurationMs: 180_000,
			target: request.target,
			predecessorTarget: request.predecessorTarget,
			handoff: { manualRoom: "preserve", collab: "preserve" },
		},
		{ wasHosting: true, access: "view" },
	);
	expect(context).toBeDefined();
	expect(
		parseAutoBotRestartLaunchContext(context!, request.predecessorTarget, {
			target: request.target,
			predecessorTarget: request.predecessorTarget,
		}),
	).toEqual(context);
	expect(
		parseAutoBotRestartLaunchContext(context!, request.predecessorTarget, {
			target: request.predecessorTarget,
			predecessorTarget: request.predecessorTarget,
		}),
	).toBeUndefined();
	expect(
		parseAutoBotRestartLaunchContext(
			{ ...context!, collab: { wasHosting: true } } as unknown as JsonValue,
			request.predecessorTarget,
			{ target: request.target, predecessorTarget: request.predecessorTarget },
		),
	).toBeUndefined();
});
