import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeAutoBotUpdateDiagnostic } from "../../src/autobot-update/diagnostics";
import type { AuthenticatedAutoBotEnvironment } from "../../src/autobot-update/identity";
import { AUTO_BOT_ENV } from "../../src/autobot-update/identity";
import { ensureAutoBotPrivateDirectory } from "../../src/autobot-update/permissions";
import { autoBotPaths } from "../../src/autobot-update/paths";
import { getLatestRelease, runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

const temporaryDirectories: string[] = [];
let managedMarkerBeforeTest: string | undefined;

async function createPrivateRoot(): Promise<string> {
	const root = path.join(os.tmpdir(), `.omp-managed-update-cli-${crypto.randomUUID()}`);
	temporaryDirectories.push(root);
	const normalizedRoot = await ensureAutoBotPrivateDirectory(root);
	await ensureAutoBotPrivateDirectory(autoBotPaths(normalizedRoot).controlDir);
	return normalizedRoot;
}

interface RenderedManagedReasons {
	readonly output: string;
	readonly networkCalls: number;
}

async function renderManagedReasons(reasons: readonly string[]): Promise<RenderedManagedReasons> {
	const root = await createPrivateRoot();
	const paths = autoBotPaths(root);
	const launchId = "z".repeat(32);
	const environment = {
		paths,
		launchId,
		launchRelease: { releaseSequence: 4 },
	} as unknown as AuthenticatedAutoBotEnvironment;
	for (const [index, reason] of reasons.entries()) {
		await writeAutoBotUpdateDiagnostic(paths, {
			phase: "session-admission",
			outcome: "deferred",
			reason,
			releaseSequence: 5,
			launchId: index.toString().padStart(32, "0"),
		});
	}
	const output: string[] = [];
	vi.spyOn(console, "log").mockImplementation(value => output.push(String(value)));
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));

	await runUpdateCommand({ force: false, check: false, status: true }, { readManagedEnvironment: () => environment });
	return { output: output.join("\n"), networkCalls: fetchSpy.mock.calls.length };
}

function expectManagedReason(output: string, code: string, meaning: RegExp): void {
	const line = output.split("\n").find(item => item.includes(`(${code})`));
	expect(line).toBeDefined();
	expect(line).toMatch(meaning);
}

describe("runUpdateCommand routing", () => {
	beforeEach(() => {
		managedMarkerBeforeTest = process.env[AUTO_BOT_ENV.managed];
		delete process.env[AUTO_BOT_ENV.managed];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (managedMarkerBeforeTest === undefined) delete process.env[AUTO_BOT_ENV.managed];
		else process.env[AUTO_BOT_ENV.managed] = managedMarkerBeforeTest;
		for (const directory of temporaryDirectories.splice(0)) {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("reports unmanaged status without making a network request", async () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation(value => output.push(String(value)));
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));

		await runUpdateCommand({ force: false, check: false, status: true }, { readManagedEnvironment: () => undefined });

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(output.join("\\n")).toContain("not an authenticated managed installation");
	});

	it("refuses a forged managed marker rather than falling through to the upstream updater", async () => {
		process.env[AUTO_BOT_ENV.managed] = "1";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));

		await expect(
			runUpdateCommand({ force: false, check: false }, { readManagedEnvironment: () => undefined }),
		).rejects.toThrow("authenticated installation environment is invalid");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("renders runtime activity and MCP deferrals as stable, actionable status without network access", async () => {
		const expectations: ReadonlyArray<readonly [string, RegExp]> = [
			["session-work-active", /wait.+response.+tool calls/i],
			["browser-session-active", /close.+browser tabs/i],
			["computer-session-active", /close.+desktop-computer/i],
			["javascript-evaluation-active", /close.+JavaScript evaluation/i],
			["python-kernel-active", /close.+Python kernel/i],
			["debugger-session-active", /terminate.+debugger/i],
			["hub-service-active", /stop.+hub services/i],
			["hub-service-inspection-failed", /check.+hub services/i],
			["mcp-connection-active", /wait.+MCP connection.+tool loading.+configured servers reconnect/i],
			[
				"mcp-request-active",
				/wait.+MCP calls.+incoming request handlers.+response delivery.+configured servers reconnect/i,
			],
			["mcp-restart-quiescence-unavailable", /wait.+MCP transport.+idle.+configured servers reconnect/i],
			["mcp-restart-quiescence-unsupported", /disconnect.+unsupported MCP transport/i],
		];
		const { output, networkCalls } = await renderManagedReasons(expectations.map(([code]) => code));

		expect(networkCalls).toBe(0);
		for (const [code, meaning] of expectations) {
			expectManagedReason(output, code, meaning);
		}
	});

	it("explains launch overrides and changing authenticated update state with corrective actions", async () => {
		const expectations: ReadonlyArray<readonly [string, RegExp]> = [
			["runtime-api-key-override", /restart without.+API key override/i],
			["system-prompt-override", /restart without.+system-prompt override/i],
			["model-override", /restart without.+provider or model overrides/i],
			["model-role-override", /restart without.+model-role or thinking overrides/i],
			["provider-session-override", /restart without.+provider-session/i],
			["extension-override", /restart without.+extension.+hook.+plugin overrides/i],
			["startup-override", /restart without.+startup.+skill.+time-limit overrides/i],
			["authentication-changed", /run the command again from the active launch/i],
			["update-changed", /preferred update changed.+run the command again/i],
			["compatibility-epoch-mismatch", /restart OMP normally.+compatible release/i],
			["session-admission-changed", /wait.+idle.+retry/i],
		];
		const { output, networkCalls } = await renderManagedReasons(expectations.map(([code]) => code));

		expect(networkCalls).toBe(0);
		for (const [code, meaning] of expectations) {
			expectManagedReason(output, code, meaning);
		}
	});

	it("explains coordinator and collaboration deferrals while preserving their stable reason codes", async () => {
		const expectations: ReadonlyArray<readonly [string, RegExp]> = [
			["coordinator-service-unavailable", /restart OMP normally.+coordinator service/i],
			["coordinator-reservation-contended", /coordinator deferred.+wait.+retry/i],
			["coordinator-preparation-invalid", /restart OMP normally.+coordinator reservation/i],
			["collab-controller-shutdown", /restart.+collaboration session/i],
			["collab-reservation-active", /wait.+collaboration restart reservation/i],
			["collab-session-busy", /wait.+collaboration work/i],
			["collab-session-transition", /wait.+collaboration session transition/i],
			["collab-target-incompatible", /update connected collaboration clients/i],
			["collab-guest-incompatible", /collaboration state deferred.+wait.+retry/i],
		];
		const { output, networkCalls } = await renderManagedReasons(expectations.map(([code]) => code));

		expect(networkCalls).toBe(0);
		for (const [code, meaning] of expectations) {
			expectManagedReason(output, code, meaning);
		}
	});

	it("gives specific recovery actions for interactive admission deferrals", async () => {
		const expectations: ReadonlyArray<readonly [string, RegExp]> = [
			["interactive-teardown", /wait.+teardown/i],
			["user-exit-pending", /allow.+exit.+finish/i],
			["modal-interface-open", /close.+modal/i],
			["session-focus-changing", /wait.+focus change/i],
			["external-editor-active", /close.+external editor/i],
			["composer-draft-pending", /send or discard.+draft.+attachments/i],
			["prompt-pending", /wait.+prompt.+finish/i],
			["compaction-pending", /wait.+compaction work/i],
			["automatic-mode-active", /wait.+automatic mode.+transition/i],
			["interactive-request-active", /finish.+side request/i],
			["subagent-session-active", /wait.+subagents.+stop them/i],
			["agent-transition-active", /wait.+agent lifecycle transition/i],
			["interactive-state-unsafe", /idle interactive state/i],
		];
		const { output, networkCalls } = await renderManagedReasons(expectations.map(([code]) => code));

		expect(networkCalls).toBe(0);
		for (const [code, meaning] of expectations) {
			expectManagedReason(output, code, meaning);
		}
	});

	it("gives recovery actions for installation, persistence, preparation, and handoff states", async () => {
		const expectations: ReadonlyArray<readonly [string, RegExp]> = [
			["channel-unavailable", /retry.+connectivity/i],
			["release-quarantined", /wait.+replacement signed release/i],
			["update-quarantined", /wait.+corrected signed update.+verified installed release remains active/i],
			["installation-refresh-failed", /retry or repair.+installation/i],
			["signed-refresh-failed", /retry or repair.+installation/i],
			["publication-recovery-pending", /restart.+managed launcher.+recover/i],
			["offline-installed-fallback", /connectivity.+recover/i],
			["refresh-completed", /refresh completed.+no user action/i],
			["session-not-persisted", /save.+session to disk/i],
			["session-persistence-failed", /check local storage/i],
			["preflight-failed", /retry.+active managed launch/i],
			["preflight-deferred", /idle state.+retry/i],
			["restart-preparation-deferred", /idle resumable state.+retry/i],
			["restart-preparation-failed", /retry.+active managed launch/i],
			["restart-context-invalid", /restart OMP normally/i],
			["handoff-budget-expired", /restart window expired.+retry/i],
			["handoff-contended", /wait.+finish.+retry/i],
			["handoff-invalid", /restart OMP normally/i],
			["handoff-write-failed", /check local storage.+retry/i],
			["sequence-rejected", /wait.+corrected signed release/i],
			["coordinator-bundle-unavailable", /repair or refresh.+coordinator bundle/i],
			["coordinator-deferred", /wait.+current work.+retry/i],
		];
		const { output, networkCalls } = await renderManagedReasons(expectations.map(([code]) => code));

		expect(networkCalls).toBe(0);
		for (const [code, meaning] of expectations) {
			expectManagedReason(output, code, meaning);
		}
	});

	it("shows an unknown stable code without exposing launch identity or inventing a catch-all diagnosis", async () => {
		const { output, networkCalls } = await renderManagedReasons(["future-safe-condition"]);

		expect(networkCalls).toBe(0);
		expect(output).toContain("unrecognized managed update condition");
		expect(output).toContain("(future-safe-condition)");
		expect(output).not.toContain("z".repeat(32));
		expect(output).not.toMatch(/https?:\/\//i);
	});

	it("uses signed installation refresh for an authenticated managed update", async () => {
		const root = await createPrivateRoot();
		const paths = autoBotPaths(root);
		const environment = {
			paths,
			launchId: "a".repeat(32),
			launchRelease: { releaseSequence: 4 },
		} as unknown as AuthenticatedAutoBotEnvironment;
		const active = {
			manifest: { releaseSequence: 5, upstreamVersion: "19.0.0" },
		};
		const refresh = vi.fn(async () => ({ active, changed: true }) as never);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("upstream updater must not be used"));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await runUpdateCommand(
			{ force: false, check: false },
			{ readManagedEnvironment: () => environment, refreshManagedInstallation: refresh },
		);

		expect(refresh).toHaveBeenCalledWith(paths);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const managed = process.env[AUTO_BOT_ENV.managed];
		delete process.env[AUTO_BOT_ENV.managed];
		try {
			await runUpdateCommand({ force: false, check: true }, { readManagedEnvironment: () => undefined });
		} finally {
			if (managed === undefined) delete process.env[AUTO_BOT_ENV.managed];
			else process.env[AUTO_BOT_ENV.managed] = managed;
		}

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("getLatestRelease rename pointers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubRegistry(manifests: Record<string, unknown>): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				let manifest: unknown;
				for (const pkg in manifests) {
					if (url.includes(pkg)) {
						manifest = manifests[pkg];
						break;
					}
				}
				if (!manifest) return new Response(null, { status: 404, statusText: "Not Found" });
				return Response.json(manifest);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("follows omp.rename to the new package and resolves version, dist, and names from its manifest", async () => {
		const urls = stubRegistry({
			"@new/omp": { version: "999.1.0", omp: { dist: "npm" } },
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { dist: "binary", rename: { package: "@new/omp", natives: "@new/natives" } },
			},
		});

		const release = await getLatestRelease();

		expect(release.version).toBe("999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/omp", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest",
			"https://registry.npmjs.org/@new/omp/latest",
		]);
	});
	it("fetches the canary dist-tag when checking the canary channel", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": { version: "999.0.0-canary.1" },
		});

		await getLatestRelease({ channel: "canary" });

		expect(urls).toEqual(["https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/canary"]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { rename: { package: "@oh-my-pi/pi-coding-agent" } },
			},
		});

		const release = await getLatestRelease();

		expect(urls).toHaveLength(1);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives" });
	});
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestRelease({ timeoutMs: 5000 }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});
