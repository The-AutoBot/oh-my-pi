import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { synchronizeNativeReleaseMetadata } from "../scripts/native-compatibility";

async function write(root: string, relativePath: string, content: string) {
	const target = path.join(root, relativePath);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, content);
}

describe("native release metadata synchronization", () => {
	it("restores only native compatibility metadata after an application version bump", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-compatibility-"));
		try {
			await write(
				root,
				"packages/natives/package.json",
				JSON.stringify({ version: "99.4.1", nativeCompatibilityVersion: "18.2.7" }),
			);
			await write(
				root,
				"Cargo.toml",
				'[workspace]\nmembers = [\n  "crates/pi-natives",\n  "crates/pi-helper",\n]\n\n[workspace.package]\nversion = "99.4.1"\nedition = "2024"\n',
			);
			await write(
				root,
				"crates/pi-natives/Cargo.toml",
				'[package]\nname = "pi-natives"\nversion.workspace = true\nedition.workspace = true\n',
			);
			await write(
				root,
				"crates/pi-helper/Cargo.toml",
				'[package]\nname = "pi-helper"\nversion.workspace = true\nedition.workspace = true\n',
			);
			await write(
				root,
				"Cargo.lock",
				'[[package]]\nname = "pi-helper"\nversion = "99.4.1"\n\n[[package]]\nname = "pi-natives"\nversion = "99.4.1"\ndependencies = [\n "pi-helper 99.4.1",\n "third-party",\n]\n\n[[package]]\nname = "third-party"\nversion = "99.4.1"\nsource = "registry+https://example.invalid/index"\nchecksum = "keep"\n',
			);
			await write(
				root,
				"crates/pi-natives/src/lib.rs",
				'#[napi(js_name = "__piNativesV99_4_1")]\npub const fn sentinel() {}\n// genuine source change\n',
			);
			await write(
				root,
				"packages/natives/native/index.js",
				"export const __piNativesV99_4_1 = nativeBindings.__piNativesV99_4_1;\n",
			);
			await write(
				root,
				"packages/natives/native/index.d.ts",
				"export declare function __piNativesV99_4_1(): void\n",
			);

			const changed = await synchronizeNativeReleaseMetadata(root);
			expect(changed).toEqual([
				"Cargo.toml",
				"Cargo.lock",
				"crates/pi-natives/src/lib.rs",
				"packages/natives/native/index.js",
				"packages/natives/native/index.d.ts",
			]);
			const cargo = await fs.readFile(path.join(root, "Cargo.toml"), "utf8");
			expect(cargo).toContain('version = "18.2.7"');
			expect(cargo).toContain('edition = "2024"');
			const lock = await fs.readFile(path.join(root, "Cargo.lock"), "utf8");
			expect(lock).toContain('name = "pi-helper"\nversion = "18.2.7"');
			expect(lock).toContain('"pi-helper 18.2.7"');
			expect(lock).toContain('name = "third-party"\nversion = "99.4.1"');
			expect(lock).toContain('checksum = "keep"');
			expect(await fs.readFile(path.join(root, "crates/pi-natives/src/lib.rs"), "utf8")).toContain(
				"// genuine source change",
			);
			expect(await synchronizeNativeReleaseMetadata(root)).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
