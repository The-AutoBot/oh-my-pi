import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	NATIVE_BUILD_PROVENANCE_FILENAME,
	NativeInputError,
	computeNativeInputsSha256,
	parseNativeBuildProvenance,
	validateNativeArtifactInputs,
	writeNativeBuildProvenance,
} from "../packages/natives/scripts/native-build-provenance";

const temporaryDirectories: string[] = [];
const nativeVersion = "18.2.7";
const variant = "win32-x64-baseline";
const cargoTarget = "x86_64-pc-windows-msvc";
const filename = `pi_natives.${variant}.node`;
function sha256(value: string | Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return hasher.digest("hex");
}

async function writeFixtureFile(root: string, relative: string, contents: string | Uint8Array): Promise<void> {
	const destination = path.join(root, ...relative.split("/"));
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.writeFile(destination, contents);
}

async function createNativeSourceFixture(): Promise<{ root: string; nativeDirectory: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-provenance-"));
	temporaryDirectories.push(root);
	await writeFixtureFile(
		root,
		"package.json",
		JSON.stringify({ version: "99.1.0", workspaces: { catalog: { "@napi-rs/cli": "3.7.2", unrelated: "1.0.0" } } }),
	);
	await writeFixtureFile(
		root,
		"packages/natives/package.json",
		JSON.stringify({
			version: "99.1.0",
			nativeCompatibilityVersion: nativeVersion,
			napi: { binaryName: "pi_natives", triples: {} },
			devDependencies: { "@napi-rs/cli": "catalog:" },
		}),
	);
	await writeFixtureFile(
		root,
		"packages/natives/node_modules/@napi-rs/cli/package.json",
		JSON.stringify({ name: "@napi-rs/cli", version: "3.7.2", bin: { napi: "bin/napi.js" } }),
	);
	await writeFixtureFile(root, "packages/natives/node_modules/@napi-rs/cli/bin/napi.js", "export const cli = true;\n");
	await writeFixtureFile(
		root,
		"packages/natives/node_modules/@napi-rs/cli/dist/chunk.js",
		"export const chunk = true;\n",
	);
	await writeFixtureFile(
		root,
		"Cargo.toml",
		`[workspace]\nmembers=["crates/pi-natives"]\n[workspace.package]\nversion="${nativeVersion}"\n`,
	);
	await writeFixtureFile(
		root,
		"packages/natives/scripts/native-build-provenance.ts",
		"export const provenanceRecipe = 1;\n",
	);
	await writeFixtureFile(
		root,
		"Cargo.lock",
		`version = 4\n[[package]]\nname = "pi-natives"\nversion = "${nativeVersion}"\n`,
	);
	await writeFixtureFile(root, "rust-toolchain.toml", '[toolchain]\nchannel = "nightly-2026-08-12"\n');
	await writeFixtureFile(root, ".cargo/config.toml", "[build]\nincremental = true\n");
	await writeFixtureFile(
		root,
		"crates/pi-natives/Cargo.toml",
		'[package]\nname="pi-natives"\nversion.workspace=true\n',
	);
	await writeFixtureFile(
		root,
		"crates/pi-natives/src/lib.rs",
		`#[napi(js_name = "__piNativesV18_2_7")]\npub fn sentinel() {}\n`,
	);
	await writeFixtureFile(root, "packages/natives/scripts/build-bindings.ts", "export const recipe = 'cargo-napi';\n");
	await writeFixtureFile(root, "scripts/bazel-natives.ts", "export const hostRoute = 'cargo';\n");
	await writeFixtureFile(root, "scripts/host-detect.ts", "export const variant = 'baseline';\n");
	await writeFixtureFile(root, "packages/coding-agent/src/application.ts", "export const applicationOnly = 1;\n");
	const nativeDirectory = path.join(root, "external-native");
	await fs.mkdir(nativeDirectory);
	await writeFixtureFile(root, `external-native/${filename}`, `MZ\0compiled-addon\0__piNativesV18_2_7\0`);
	return { root, nativeDirectory };
}

async function expectNativeError(action: Promise<unknown>, code: string): Promise<void> {
	let caught: unknown;
	try {
		await action;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(NativeInputError);
	expect((caught as NativeInputError).code).toBe(code);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("native input fingerprint", () => {
	test("ignores application release changes but binds Rust, dependencies, toolchain, recipe, and resolved N-API CLI", async () => {
		const fixture = await createNativeSourceFixture();
		const baseline = await computeNativeInputsSha256(fixture.root);

		await writeFixtureFile(
			fixture.root,
			"package.json",
			JSON.stringify({
				version: "100.0.0",
				workspaces: { catalog: { "@napi-rs/cli": "3.7.2", unrelated: "2.0.0" } },
			}),
		);
		await writeFixtureFile(
			fixture.root,
			"packages/coding-agent/src/application.ts",
			"export const applicationOnly = 2;\n",
		);
		expect(await computeNativeInputsSha256(fixture.root)).toBe(baseline);

		const mutations: Array<[string, string]> = [
			["crates/pi-natives/src/lib.rs", "pub fn changed_native_source() {}\n"],
			["Cargo.lock", "version = 4\n# changed resolved dependency\n"],
			["rust-toolchain.toml", '[toolchain]\nchannel = "nightly-2026-09-01"\n'],
			["packages/natives/scripts/build-bindings.ts", "export const recipe = 'changed';\n"],
			["packages/natives/node_modules/@napi-rs/cli/bin/napi.js", "export const cli = false;\n"],
			["packages/natives/node_modules/@napi-rs/cli/dist/chunk.js", "export const chunk = false;\n"],
		];
		for (const [relative, replacement] of mutations) {
			const absolute = path.join(fixture.root, ...relative.split("/"));
			const original = await fs.readFile(absolute);
			await fs.writeFile(absolute, replacement);
			expect(await computeNativeInputsSha256(fixture.root)).not.toBe(baseline);
			await fs.writeFile(absolute, original);
		}
	});
});

describe("native provenance trust boundary", () => {
	test("independently enforces the record pin, source inputs, addon bytes, and compatibility sentinel", async () => {
		const fixture = await createNativeSourceFixture();
		const inputsSha256 = await computeNativeInputsSha256(fixture.root);
		const written = await writeNativeBuildProvenance({
			sourceRoot: fixture.root,
			nativeDirectory: fixture.nativeDirectory,
			inputsSha256,
			build: { target: cargoTarget, profile: "ci", toolchain: "rustc fixture" },
			artifacts: [{ filename, variant }],
		});
		const validated = await validateNativeArtifactInputs({
			sourceRoot: fixture.root,
			nativeDirectory: fixture.nativeDirectory,
			provenanceSha256: written.provenanceSha256,
		});
		expect(validated.artifacts.map(artifact => path.basename(artifact.path))).toEqual([filename]);

		const recordPath = path.join(fixture.nativeDirectory, NATIVE_BUILD_PROVENANCE_FILENAME);
		const exactRecord = await fs.readFile(recordPath);
		await fs.writeFile(recordPath, Buffer.concat([exactRecord, Buffer.from(" ")]));
		await expectNativeError(
			validateNativeArtifactInputs({
				sourceRoot: fixture.root,
				nativeDirectory: fixture.nativeDirectory,
				provenanceSha256: written.provenanceSha256,
			}),
			"NATIVE_PROVENANCE_PIN_MISMATCH",
		);
		await fs.writeFile(recordPath, exactRecord);

		await writeFixtureFile(fixture.root, `external-native/${filename}`, "MZ\0different bytes\0__piNativesV18_2_7\0");
		await expectNativeError(
			validateNativeArtifactInputs({
				sourceRoot: fixture.root,
				nativeDirectory: fixture.nativeDirectory,
				provenanceSha256: written.provenanceSha256,
			}),
			"NATIVE_ARTIFACT_MISMATCH",
		);
		await writeFixtureFile(fixture.root, `external-native/${filename}`, `MZ\0compiled-addon\0__piNativesV18_2_7\0`);
		const addonWithoutSentinel = "MZ\0compiled-addon-without-version-export\0";
		await writeFixtureFile(fixture.root, `external-native/${filename}`, addonWithoutSentinel);
		const sentinelRecord = {
			...written.provenance,
			artifacts: [
				{
					...written.provenance.artifacts[0],
					size: Buffer.byteLength(addonWithoutSentinel),
					sha256: sha256(addonWithoutSentinel),
				},
			],
		};
		const sentinelRecordBytes = `${JSON.stringify(sentinelRecord, null, "\t")}\n`;
		await fs.writeFile(recordPath, sentinelRecordBytes);
		await expectNativeError(
			validateNativeArtifactInputs({
				sourceRoot: fixture.root,
				nativeDirectory: fixture.nativeDirectory,
				provenanceSha256: sha256(sentinelRecordBytes),
			}),
			"NATIVE_SENTINEL_MISMATCH",
		);

		await writeFixtureFile(fixture.root, `external-native/${filename}`, `MZ\0compiled-addon\0__piNativesV18_2_7\0`);
		const incompatibleRecordBytes = `${JSON.stringify(
			{ ...written.provenance, nativeCompatibilityVersion: "18.2.8" },
			null,
			"\t",
		)}\n`;
		await fs.writeFile(recordPath, incompatibleRecordBytes);
		await expectNativeError(
			validateNativeArtifactInputs({
				sourceRoot: fixture.root,
				nativeDirectory: fixture.nativeDirectory,
				provenanceSha256: sha256(incompatibleRecordBytes),
			}),
			"NATIVE_COMPATIBILITY_MISMATCH",
		);
		await fs.writeFile(recordPath, exactRecord);

		await writeFixtureFile(fixture.root, "crates/pi-natives/src/lib.rs", "pub fn changed_after_build() {}\n");
		await expectNativeError(
			validateNativeArtifactInputs({
				sourceRoot: fixture.root,
				nativeDirectory: fixture.nativeDirectory,
				provenanceSha256: written.provenanceSha256,
			}),
			"NATIVE_INPUT_MISMATCH",
		);
	});

	test("rejects malformed records, duplicate identities, filename spoofing, missing records, and non-files", async () => {
		const base = {
			schemaVersion: 1,
			nativeCompatibilityVersion: nativeVersion,
			inputsSha256: "a".repeat(64),
			build: { target: cargoTarget, profile: "ci", toolchain: "rustc fixture" },
			artifacts: [{ filename, variant, size: 10, sha256: "b".repeat(64) }],
		};
		expect(() => parseNativeBuildProvenance({ ...base, unsupported: true })).toThrow(NativeInputError);
		expect(() =>
			parseNativeBuildProvenance({ ...base, build: { ...base.build, target: "win32-x64-baseline" } }),
		).toThrow("Windows MSVC Cargo target");
		expect(() =>
			parseNativeBuildProvenance({ ...base, build: { ...base.build, target: "aarch64-pc-windows-msvc" } }),
		).toThrow("variants do not match");
		expect(() => parseNativeBuildProvenance({ ...base, artifacts: [...base.artifacts, base.artifacts[0]] })).toThrow(
			"duplicate filename or variant",
		);
		expect(() =>
			parseNativeBuildProvenance({
				...base,
				artifacts: [{ ...base.artifacts[0], filename: "../pi_natives.win32-x64-baseline.node" }],
			}),
		).toThrow("canonical Windows pi_natives addon");

		const fixture = await createNativeSourceFixture();
		await expectNativeError(
			validateNativeArtifactInputs({
				sourceRoot: fixture.root,
				nativeDirectory: fixture.nativeDirectory,
				provenanceSha256: "a".repeat(64),
			}),
			"NATIVE_PROVENANCE_MISSING",
		);
		await fs.mkdir(path.join(fixture.nativeDirectory, NATIVE_BUILD_PROVENANCE_FILENAME));
		await expectNativeError(
			validateNativeArtifactInputs({
				sourceRoot: fixture.root,
				nativeDirectory: fixture.nativeDirectory,
				provenanceSha256: "a".repeat(64),
			}),
			"NATIVE_PROVENANCE_INVALID",
		);
	});

	test("refuses to write producer evidence when native inputs changed during the build", async () => {
		const fixture = await createNativeSourceFixture();
		const before = await computeNativeInputsSha256(fixture.root);
		await writeFixtureFile(fixture.root, "crates/pi-natives/src/lib.rs", "pub fn changed_during_build() {}\n");
		await expectNativeError(
			writeNativeBuildProvenance({
				sourceRoot: fixture.root,
				nativeDirectory: fixture.nativeDirectory,
				inputsSha256: before,
				build: { target: cargoTarget, profile: "ci", toolchain: "rustc fixture" },
				artifacts: [{ filename, variant }],
			}),
			"NATIVE_INPUT_CHANGED",
		);
		expect(await Bun.file(path.join(fixture.nativeDirectory, NATIVE_BUILD_PROVENANCE_FILENAME)).exists()).toBe(false);
	});
});
