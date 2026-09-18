import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES,
	AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
	autoBotPathRequiresCompatibilityReview,
	serializeAutoBotReleaseManifest,
	type AutoBotReleaseManifest,
} from "../packages/coding-agent/src/autobot-update/contract.ts";
import { type AssetInput, type TrustedKeySet, verifySignedEnvelope } from "./autobot-release-common.ts";
import {
	COORDINATOR_CLIENT_FILENAME,
	type CoordinatorClientProvenance,
} from "./autobot-release-coordinator.ts";
import {
	createManagedBundle,
	deriveManagedBundleId,
	parseManagedBundleInventory,
	verifyManagedBundleArchive,
} from "./autobot-release-web.ts";
import { assertAutoBotRuntimeTarget } from "./autobot-release-targets.ts";

const repoRoot = path.join(import.meta.dir, "..");
const temporaryDirectories: string[] = [];
const textEncoder = new TextEncoder();
const tarBlockSize = 512;
const completeRuntimeTargets = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-musl-arm64",
	"linux-musl-x64",
	"linux-x64",
	"win32-arm64",
	"win32-x64",
] as const;

interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface AssemblyFixture {
	readonly assetInputsPath: string;
	readonly baseArgs: readonly string[];
	readonly coordinatorAssetPath: string;
	readonly coordinatorProvenance: CoordinatorClientProvenance;
	readonly coordinatorSourcePath: string;
	readonly coordinatorSourceSha256: string;
}

interface SigningKeys {
	readonly privateKeyPath: string;
	readonly publicKeyPath: string;
}

function releaseManifest(overrides: Partial<AutoBotReleaseManifest> = {}): AutoBotReleaseManifest {
	return {
		schemaVersion: AUTO_BOT_RELEASE_SCHEMA_VERSION,
		releaseSequence: 7,
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
		...overrides,
	};
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function isCryptoKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
	return "privateKey" in value && "publicKey" in value;
}

async function createEd25519KeyPair(): Promise<CryptoKeyPair> {
	const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
	if (!isCryptoKeyPair(generated)) throw new Error("Ed25519 generation did not return a key pair");
	return generated;
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error("Expected release verification rejection to be an Error");
	}
	throw new Error("Expected release verification to reject");
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	hash.update(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
	return hash.digest("hex");
}

async function run(command: readonly string[]): Promise<CommandResult> {
	const processHandle = Bun.spawn([...command], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		processHandle.exited,
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function runReleaseScript(scriptName: string, args: readonly string[]): Promise<CommandResult> {
	return run([process.execPath, path.join(repoRoot, "scripts", scriptName), ...args]);
}

async function runAssembly(out: string, fixture: AssemblyFixture): Promise<CommandResult> {
	return runReleaseScript("autobot-release-assemble.ts", ["--out", out, ...fixture.baseArgs]);
}

async function createSigningKeys(directory: string): Promise<SigningKeys> {
	const keyPair = await createEd25519KeyPair();
	const privateKeyPath = path.join(directory, "release-private.pk8");
	const publicKeyPath = path.join(directory, "release-public.spki");
	await Bun.write(privateKeyPath, new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)));
	await Bun.write(publicKeyPath, new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey)));
	return { privateKeyPath, publicKeyPath };
}

async function runSigning(
	out: string,
	fixture: AssemblyFixture,
	privateKeyPath: string,
	envelopePath: string,
): Promise<CommandResult> {
	return runReleaseScript("autobot-release-sign.ts", [
		"--manifest",
		path.join(out, "manifest.json"),
		"--asset-index",
		path.join(out, "asset-index.json"),
		"--out",
		envelopePath,
		"--key-id",
		"current",
		"--private-key",
		privateKeyPath,
		"--coordinator-source",
		fixture.coordinatorSourcePath,
		"--coordinator-source-sha256",
		fixture.coordinatorSourceSha256,
		"--allow-initial",
	]);
}

async function runVerification(
	out: string,
	envelopePath: string,
	publicKeyPath: string,
): Promise<CommandResult> {
	return runReleaseScript("autobot-release-verify.ts", [
		"--envelope",
		envelopePath,
		"--asset-index",
		path.join(out, "asset-index.json"),
		"--provenance",
		path.join(out, "provenance.json"),
		"--trusted-key",
		`current=${publicKeyPath}`,
	]);
}

async function createAssemblyFixture(): Promise<AssemblyFixture> {
	const root = await createTemporaryDirectory("omp-autobot-release-security-");
	const inputs = path.join(root, "inputs");
	const webDist = path.join(inputs, "web-dist");
	await fs.mkdir(path.join(webDist, "assets"), { recursive: true });
	await Bun.write(path.join(webDist, "index.html"), "<!doctype html><title>AutoBot</title>\n");
	await Bun.write(path.join(webDist, "assets", "app.js"), "export const release = 1;\n");

	const forkCommit = "a".repeat(40);
	const upstreamCommit = "b".repeat(40);
	const upstreamVersion = "18.2.3";
	const webBundleId = await deriveManagedBundleId(webDist);
	const webArchivePath = path.join(inputs, `omp-collab-web-${webBundleId}.tar.gz`);
	await createManagedBundle({
		dist: webDist,
		out: webArchivePath,
		bundleId: webBundleId,
		forkCommit,
		upstreamCommit,
		upstreamVersion,
	});

	const coordinatorAssetPath = path.join(inputs, COORDINATOR_CLIENT_FILENAME);
	const coordinatorBytes = "export const coordinator = 'trusted';\n";
	await Bun.write(coordinatorAssetPath, coordinatorBytes);
	const assetInputs: AssetInput[] = [
		{
			kind: "coordinator-client",
			target: "universal",
			source: coordinatorAssetPath,
			url: `https://releases.example.invalid/${COORDINATOR_CLIENT_FILENAME}`,
		},
	];
	for (const target of completeRuntimeTargets) {
		const runtimePath = path.join(inputs, `omp-runtime-${target}`);
		const bootstrapPath = path.join(inputs, `omp-bootstrap-${target}`);
		await Bun.write(runtimePath, `runtime bytes for ${target}\n`);
		await Bun.write(bootstrapPath, `bootstrap bytes for ${target}\n`);
		assetInputs.push(
			{
				kind: "runtime",
				target,
				source: runtimePath,
				url: `https://releases.example.invalid/${path.basename(runtimePath)}`,
			},
			{
				kind: "bootstrap",
				target,
				source: bootstrapPath,
				url: `https://releases.example.invalid/${path.basename(bootstrapPath)}`,
			},
		);
	}

	const coordinatorProvenance: CoordinatorClientProvenance = {
		schemaVersion: 1,
		source: {
			repository: "https://github.com/example/omp-session-coordinator",
			commit: "d".repeat(40),
		},
		artifact: {
			filename: COORDINATOR_CLIENT_FILENAME,
			sha256: await sha256File(coordinatorAssetPath),
			size: textEncoder.encode(coordinatorBytes).byteLength,
		},
	};
	const coordinatorSourcePath = path.join(inputs, "coordinator-source.json");
	await Bun.write(coordinatorSourcePath, `${JSON.stringify(coordinatorProvenance, null, "\t")}\n`);
	const coordinatorSourceSha256 = await sha256File(coordinatorSourcePath);

	const assetInputsPath = path.join(inputs, "asset-inputs.json");
	assetInputs.push({
		kind: "collab-web",
		target: "web",
		source: webArchivePath,
		url: `https://releases.example.invalid/${path.basename(webArchivePath)}`,
	});
	await Bun.write(assetInputsPath, JSON.stringify(assetInputs));

	return {
		assetInputsPath,
		baseArgs: [
			"--assets",
			assetInputsPath,
			"--release-sequence",
			"7",
			"--upstream-version",
			upstreamVersion,
			"--fork-commit",
			forkCommit,
			"--upstream-commit",
			upstreamCommit,
			"--web-bundle-id",
			webBundleId,
			"--published-at",
			"2026-09-17T00:00:00.000Z",
			"--coordinator-source",
			coordinatorSourcePath,
			"--coordinator-source-sha256",
			coordinatorSourceSha256,
		],
		coordinatorAssetPath,
		coordinatorProvenance,
		coordinatorSourcePath,
		coordinatorSourceSha256,
	};
}

function writeTarText(target: Uint8Array, offset: number, length: number, value: string): void {
	const bytes = textEncoder.encode(value);
	if (bytes.byteLength > length) throw new Error("Tar fixture field exceeds its fixed header width");
	target.set(bytes, offset);
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number): void {
	writeTarText(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function hostileTarGzip(entryPath: string, type: "0" | "2"): Uint8Array {
	const payload = type === "0" ? textEncoder.encode("not a web bundle\n") : new Uint8Array(0);
	const header = new Uint8Array(tarBlockSize);
	writeTarText(header, 0, 100, entryPath);
	writeTarOctal(header, 100, 8, 0o644);
	writeTarOctal(header, 108, 8, 0);
	writeTarOctal(header, 116, 8, 0);
	writeTarOctal(header, 124, 12, payload.byteLength);
	writeTarOctal(header, 136, 12, 0);
	header.fill(0x20, 148, 156);
	header[156] = type.charCodeAt(0);
	if (type === "2") writeTarText(header, 157, 100, "/outside-the-bundle");
	writeTarText(header, 257, 6, "ustar\0");
	writeTarText(header, 263, 2, "00");
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);

	const padding = (tarBlockSize - (payload.byteLength % tarBlockSize)) % tarBlockSize;
	const archive = new Uint8Array(tarBlockSize + payload.byteLength + padding + tarBlockSize * 2);
	archive.set(header);
	archive.set(payload, tarBlockSize);
	return Bun.gzipSync(archive);
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("AutoBot release signing", () => {
	test("accepts exact signed bytes but rejects tampering and unknown keys", async () => {
		const keyPair = await createEd25519KeyPair();
		const manifest = releaseManifest();
		const payload = `\n${serializeAutoBotReleaseManifest(manifest)}\n`;
		const signature = Buffer.from(
			new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, textEncoder.encode(payload))),
		).toString("base64");
		const envelope = { payload, signature, keyId: "current" };
		const trusted: TrustedKeySet = { keys: new Map([["current", keyPair.publicKey]]) };

		const verified = await verifySignedEnvelope(envelope, trusted);
		expect(verified.envelope.payload).toBe(payload);
		expect(verified.manifest).toEqual(manifest);

		const tamperError = await rejectionOf(verifySignedEnvelope({ ...envelope, payload: `${payload} ` }, trusted));
		expect(tamperError.message).toContain("invalid Ed25519 signature");
		const unknownKeyError = await rejectionOf(verifySignedEnvelope({ ...envelope, keyId: "untrusted" }, trusted));
		expect(unknownKeyError.message).toContain("No locally configured trusted key");
	});
});

describe("AutoBot release target selection", () => {
	test("rejects inherited object property names", () => {
		for (const value of ["constructor", "toString", "__proto__"]) {
			expect(() => assertAutoBotRuntimeTarget(value)).toThrow("Unsupported AutoBot runtime/bootstrap target");
		}
	});
});

describe("AutoBot coordinator release provenance", () => {
	test("assembles a pinned coordinator release before signing and independently verifying it", async () => {
		const fixture = await createAssemblyFixture();
		const releaseDirectory = path.join(path.dirname(fixture.assetInputsPath), "complete-release");
		const assembly = await runAssembly(releaseDirectory, fixture);
		expect(assembly.exitCode, assembly.stderr).toBe(0);

		const signingKeys = await createSigningKeys(path.dirname(fixture.assetInputsPath));
		const envelopePath = path.join(path.dirname(fixture.assetInputsPath), "release-envelope.json");
		const signing = await runSigning(releaseDirectory, fixture, signingKeys.privateKeyPath, envelopePath);
		expect(signing.exitCode, signing.stderr).toBe(0);

		const verification = await runVerification(releaseDirectory, envelopePath, signingKeys.publicKeyPath);
		expect(verification.exitCode, verification.stderr).toBe(0);
	});

	test("rechecks the trusted raw coordinator provenance pin before signing an assembled release", async () => {
		const fixture = await createAssemblyFixture();
		const releaseDirectory = path.join(path.dirname(fixture.assetInputsPath), "assembled-release");
		const assembly = await runAssembly(releaseDirectory, fixture);
		expect(assembly.exitCode, assembly.stderr).toBe(0);

		const substitutedBytes = "export const coordinator = 'substituted';\n";
		await Bun.write(fixture.coordinatorAssetPath, substitutedBytes);
		const substitutedProvenance: CoordinatorClientProvenance = {
			...fixture.coordinatorProvenance,
			artifact: {
				filename: COORDINATOR_CLIENT_FILENAME,
				sha256: await sha256File(fixture.coordinatorAssetPath),
				size: textEncoder.encode(substitutedBytes).byteLength,
			},
		};
		await Bun.write(fixture.coordinatorSourcePath, `${JSON.stringify(substitutedProvenance, null, "\t")}\n`);

		const signingKeys = await createSigningKeys(path.dirname(fixture.assetInputsPath));
		const envelopePath = path.join(path.dirname(fixture.assetInputsPath), "rejected-envelope.json");
		const signing = await runSigning(releaseDirectory, fixture, signingKeys.privateKeyPath, envelopePath);
		expect(signing.exitCode, signing.stderr).toBe(1);
		expect(signing.stderr).toContain("Coordinator source provenance does not match the trusted configured SHA-256 pin");
		expect(await Bun.file(envelopePath).exists()).toBeFalse();
	});

	test("rejects a provenance document swap that declares its replacement artifact", async () => {
		const fixture = await createAssemblyFixture();
		const substitutedBytes = "export const coordinator = 'substituted';\n";
		await Bun.write(fixture.coordinatorAssetPath, substitutedBytes);
		const substitutedProvenance: CoordinatorClientProvenance = {
			...fixture.coordinatorProvenance,
			artifact: {
				filename: COORDINATOR_CLIENT_FILENAME,
				sha256: await sha256File(fixture.coordinatorAssetPath),
				size: textEncoder.encode(substitutedBytes).byteLength,
			},
		};
		await Bun.write(fixture.coordinatorSourcePath, `${JSON.stringify(substitutedProvenance, null, "\t")}\n`);
		const out = path.join(path.dirname(fixture.assetInputsPath), "modified-provenance-out");

		const result = await runAssembly(out, fixture);

		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain("Coordinator source provenance does not match the trusted configured SHA-256 pin");
		expect(await fs.readdir(out)).toEqual([]);
	});

	test("refuses a coordinator artifact substituted under an unchanged trusted provenance document", async () => {
		const fixture = await createAssemblyFixture();
		await Bun.write(fixture.coordinatorAssetPath, "export const coordinator = 'substituted';\n");
		const out = path.join(path.dirname(fixture.assetInputsPath), "substituted-artifact-out");

		const result = await runAssembly(out, fixture);

		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain("Coordinator-client artifact does not match its explicit pinned source provenance");
		expect(await Bun.file(path.join(out, "manifest.json")).exists()).toBeFalse();
	});
});

describe("AutoBot managed web bundles", () => {
	test("rejects traversal entries and symbolic links before archive extraction", async () => {
		const root = await createTemporaryDirectory("omp-autobot-archive-security-");
		const traversalArchive = path.join(root, "traversal.tar.gz");
		const symlinkArchive = path.join(root, "symlink.tar.gz");
		await Bun.write(traversalArchive, hostileTarGzip("assets/../outside-the-bundle", "0"));
		await Bun.write(symlinkArchive, hostileTarGzip("assets/escape.js", "2"));

		const traversalError = await rejectionOf(verifyManagedBundleArchive(traversalArchive));
		expect(traversalError.message).toContain("unsafe path");
		const symlinkError = await rejectionOf(verifyManagedBundleArchive(symlinkArchive));
		expect(symlinkError.message).toContain("non-regular entry");
	});

	test("rejects coordinator-oversized compressed and expanded bundle inputs before signing", async () => {
		expect(() =>
			parseManagedBundleInventory({
				schemaVersion: 1,
				bundleId: "web-limit-test",
				sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
				collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
				compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
				source: {
					forkCommit: "a".repeat(40),
					upstreamCommit: "b".repeat(40),
					upstreamVersion: "18.2.3",
				},
				files: [
					{ path: "assets/limit.js", sha256: "c".repeat(64), size: 1 },
					{ path: "index.html", sha256: "d".repeat(64), size: AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES },
				],
			}),
		).toThrow("expanded archive limit");

		const root = await createTemporaryDirectory("omp-autobot-archive-limit-");
		const oversizedArchive = path.join(root, "oversized.tar.gz");
		await Bun.write(oversizedArchive, "x");
		await fs.truncate(oversizedArchive, AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES + 1);
		const archiveError = await rejectionOf(verifyManagedBundleArchive(oversizedArchive));
		expect(archiveError.message).toContain("compressed bytes exceed");
	});

	test("rejects a valid tiny managed tar that expands past the admission ceiling", async () => {
		const root = await createTemporaryDirectory("omp-autobot-archive-expansion-");
		const dist = path.join(root, "dist");
		const validArchive = path.join(root, "valid.tar.gz");
		const expandedTar = path.join(root, "expanded.tar");
		const expansionArchive = path.join(root, "expanded.tar.gz");
		await fs.mkdir(path.join(dist, "assets"), { recursive: true });
		await Bun.write(path.join(dist, "index.html"), "<!doctype html><title>AutoBot</title>\n");
		await Bun.write(path.join(dist, "assets", "app.js"), "export const release = 1;\n");
		await createManagedBundle({
			bundleId: "expansion-limit",
			forkCommit: "a".repeat(40),
			upstreamCommit: "b".repeat(40),
			upstreamVersion: "18.2.3",
			dist,
			out: validArchive,
		});
		await pipeline(createReadStream(validArchive), createGunzip(), createWriteStream(expandedTar));

		const zeroChunk = new Uint8Array(1024 * 1024);
		const paddedTar = await fs.open(expandedTar, "a");
		try {
			let remaining = AUTO_BOT_MAX_COLLAB_ARCHIVE_BYTES + tarBlockSize;
			while (remaining > 0) {
				const chunkLength = Math.min(remaining, zeroChunk.byteLength);
				let offset = 0;
				while (offset < chunkLength) {
					const { bytesWritten } = await paddedTar.write(zeroChunk, offset, chunkLength - offset);
					if (bytesWritten === 0) throw new Error("Could not append zero padding to tar fixture");
					offset += bytesWritten;
				}
				remaining -= chunkLength;
			}
		} finally {
			await paddedTar.close();
		}
		await pipeline(createReadStream(expandedTar), createGzip(), createWriteStream(expansionArchive));

		expect((await fs.stat(expansionArchive)).size).toBeLessThan(1024 * 1024);
		const error = await rejectionOf(verifyManagedBundleArchive(expansionArchive));
		expect(error.message).toContain("expanded coordinator admission limit");
	});
});

describe("AutoBot trusted compatibility baseline", () => {
	test("keeps state, runtime, and coordinator paths under producer-owned compatibility review", () => {
		for (const repositoryPath of [
			"packages/coding-agent/src/config.ts",
			"packages/coding-agent/src/autobot-runtime.ts",
			"packages/coding-agent/src/autobot-update/channel.ts",
			"packages/coding-agent/src/session/session-manager.ts",
			"packages/coding-agent/src/collab/registry.ts",
			"packages/omp-session-coordinator/src/index.ts",
		]) {
			expect(autoBotPathRequiresCompatibilityReview(repositoryPath)).toBeTrue();
		}
		expect(autoBotPathRequiresCompatibilityReview("packages/coding-agent/src/tools/read.ts")).toBeFalse();
	});
});
