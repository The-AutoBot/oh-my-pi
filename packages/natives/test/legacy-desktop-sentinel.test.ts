import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateLoadedBindings } from "../native/loader-state.js";

async function withCandidate(contents: string, test: (candidate: string) => void) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-legacy-desktop-"));
	const candidate = path.join(dir, "pi_natives.node");
	try {
		await fs.writeFile(candidate, contents);
		test(candidate);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function ctxFor(nativeCompatibilityVersion: string) {
	return {
		isWorkspaceLoad: false,
		packageVersion: "99.4.1",
		nativeCompatibilityVersion,
		versionSentinelExport: `__piNativesV${nativeCompatibilityVersion.replace(/[^A-Za-z0-9]/g, "_")}`,
	};
}

class LegacyDesktopSession {
	capture() {}
	execute() {}
	close() {}
}

const legacyCoreBindings = {
	countTokens() {},
	executeShell() {},
	visibleWidth() {},
};

describe("legacy native addon loading", () => {
	it("rejects pre-sentinel addons even when their legacy ABI shape looks compatible", async () => {
		const ctx = ctxFor("17.2.8");
		const bindings = { ...legacyCoreBindings, DesktopSession: LegacyDesktopSession };
		await withCandidate("legacy native addon", candidate => {
			expect(() => validateLoadedBindings(ctx, bindings, candidate)).toThrow("different native generation");
		});
	});

	it("keeps resident old addons restart-only", async () => {
		const ctx = ctxFor("17.2.8");
		const bindings = { __piNativesV17_2_7: () => {}, ...legacyCoreBindings, DesktopSession: LegacyDesktopSession };
		await withCandidate("__piNativesV17_2_8", candidate => {
			expect(() => validateLoadedBindings(ctx, bindings, candidate)).toThrow("restart omp");
		});
	});
});
