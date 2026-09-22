import { expect, test } from "bun:test";
import {
	assertBuildRepairScope,
	deriveFailedStepContext,
} from "../scripts/autobot-local";
import { LocalBuildFailure } from "../scripts/autobot-local-release";
import type { FailedStepContext, RepairableStepId } from "../scripts/autobot-local-types";

test("application build failures retain their closed failed-step identity", () => {
	const failure = new LocalBuildFailure("runtime-smoke-test", "fresh-home smoke failed");

	expect(failure.stepId).toBe("runtime-smoke-test");
	expect(failure.diagnostics).toBe("fresh-home smoke failed");
	expect(failure.message).toContain("runtime-smoke-test");
});

test("controller-derived failed-step context accepts only source for that application", () => {
	const runtime = deriveFailedStepContext("runtime-compilation");
	expect(runtime).toEqual({
		stepId: "runtime-compilation",
		permittedSourcePaths: ["packages/coding-agent/src"],
	});
	expect(Object.isFrozen(runtime)).toBe(true);
	expect(Object.isFrozen(runtime.permittedSourcePaths)).toBe(true);

	expect(() =>
		assertBuildRepairScope(
			{ paths: ["packages/coding-agent/src/config/models-config-schema.ts"] },
			runtime,
		),
	).not.toThrow();
	expect(() =>
		assertBuildRepairScope(
			{ paths: ["packages/browser-relay/extension/background.ts"] },
			deriveFailedStepContext("browser-relay-output"),
		),
	).not.toThrow();
});

test("build repair scope rejects unrelated, control-plane, protected, and unknown paths", () => {
	const runtime = deriveFailedStepContext("runtime-smoke-test");
	for (const pathname of [
		"packages/utils/src/type-guards.ts",
		"scripts/autobot-local.ts",
		"packages/natives/scripts/native-build-provenance.ts",
		"packages/coding-agent/src/autobot-update/channel.ts",
		"packages/coding-agent/src/security/provenance.ts",
		"packages/coding-agent/src/tools/example/manifest.json",
	]) {
		expect(() => assertBuildRepairScope({ paths: [pathname] }, runtime)).toThrow(
			"outside the failed-step application source scope",
		);
	}

	const forged = {
		stepId: "runtime-smoke-test",
		permittedSourcePaths: ["packages"],
	} as const satisfies FailedStepContext;
	expect(() => assertBuildRepairScope({ paths: ["packages/utils/src/type-guards.ts"] }, forged)).toThrow(
		"unknown or invalid failed-step source scope",
	);
	expect(() => deriveFailedStepContext("unknown-step" as RepairableStepId)).toThrow(
		"unknown repairable step identity",
	);
});
