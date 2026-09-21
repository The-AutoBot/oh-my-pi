import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { embedNativeAddon } from "../scripts/embed-native";

describe("native addon embedding", () => {
	it("rejects a longer release sentinel that starts with the expected version", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		const nativeDir = path.join(root, "native");
		const outputPath = path.join(nativeDir, "embedded-addon.js");
		try {
			await fs.mkdir(nativeDir);
			await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), "binary__piNativesV18_1_10");

			await expect(
				embedNativeAddon({
					targetPlatform: "win32",
					targetArch: "arm64",
					nativeDir,
					outputPath,
					applicationVersion: "99.4.1",
					nativeCompatibilityVersion: "18.1.1",
				}),
			).rejects.toThrow("does not contain native compatibility 18.1.1 sentinel `__piNativesV18_1_1`");
			expect(await Bun.file(outputPath).exists()).toBe(false);
			expect(await Bun.file(path.join(nativeDir, "embedded-addons.win32-arm64.tar.gz")).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("records application identity separately from native identity and hashes exact payload bytes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		const nativeDir = path.join(root, "native");
		const outputPath = path.join(nativeDir, "embedded-addon.js");
		try {
			await fs.mkdir(nativeDir);
			await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), "binary__piNativesV18_2_7");
			await embedNativeAddon({
				targetPlatform: "win32",
				targetArch: "arm64",
				nativeDir,
				outputPath,
				applicationVersion: "99.4.1",
				nativeCompatibilityVersion: "18.2.7",
			});
			const metadata = await fs.readFile(outputPath, "utf8");
			expect(metadata).toContain('applicationVersion: "99.4.1"');
			expect(metadata).toContain('nativeCompatibilityVersion: "18.2.7"');
			expect(metadata).toMatch(/payloadSha256: "[a-f0-9]{64}"/);
			expect(metadata).toMatch(/sha256: "[a-f0-9]{64}"/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
