import { expect, test } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	AutoBotRuntime,
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

function runtimeForPreflight(
	isCollabSafe: () => boolean,
	canPrepare: () => Promise<{ readonly canPrepare: boolean }>,
	onReservation: () => void,
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
	};
	const mode = {
		getAutoBotUpdateDeferralReason: () => undefined,
		beginAutoBotUpdateAdmission: () => {
			throw new Error("read-only preflight must not begin update admission");
		},
		collabController: {
			canPrepareUpdate: () => (isCollabSafe() ? { safe: true } : { safe: false, reason: "guest-incompatible" }),
		},
	};
	return new AutoBotRuntime(
		session as ConstructorParameters<typeof AutoBotRuntime>[0],
		parseArgs([]),
		mode as ConstructorParameters<typeof AutoBotRuntime>[2],
		undefined,
	);
}

test("AutoBot preflight defers without reserving when browser safety changes during coordinator preflight", async () => {
	const preflightStarted = Promise.withResolvers<void>();
	const preflight = Promise.withResolvers<{ readonly canPrepare: boolean }>();
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

	expect(await result).toBeFalse();
	expect(reservations).toBe(0);
});

test("AutoBot restart capsule rejects nonpersistent credential and prompt overrides", () => {
	const credentialArgs = parseArgs(["--model", "openai/gpt-5", "--api-key", "secret"]);
	expect(createAutoBotRestartLaunchContext(credentialArgs)).toBeUndefined();

	const promptArgs = parseArgs(["--append-system-prompt", "private prompt"]);
	expect(createAutoBotRestartLaunchContext(promptArgs)).toBeUndefined();
});

test("AutoBot candidate args restore only safe effective launch state", () => {
	const args = parseArgs(["--no-lsp", "--no-pty", "--approval-mode", "write", "--config", "/tmp/config.yml", "ignored prompt"]);
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
	expect(parseAutoBotRestartLaunchContext(context!, incompatible, {
		target: incompatible,
		predecessorTarget: request.predecessorTarget,
	})).toBeUndefined();
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
	expect(parseAutoBotRestartLaunchContext(context!, request.target, {
		target: request.target,
		predecessorTarget: request.predecessorTarget,
	})).toEqual(context);
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
	expect(parseAutoBotRestartLaunchContext(context!, request.predecessorTarget, {
		target: request.target,
		predecessorTarget: request.predecessorTarget,
	})).toEqual(context);
	expect(parseAutoBotRestartLaunchContext(context!, request.predecessorTarget, {
		target: request.predecessorTarget,
		predecessorTarget: request.predecessorTarget,
	})).toBeUndefined();
	expect(parseAutoBotRestartLaunchContext(
		{ ...context!, collab: { wasHosting: true } } as unknown as JsonValue,
		request.predecessorTarget,
		{ target: request.target, predecessorTarget: request.predecessorTarget },
	)).toBeUndefined();
});
