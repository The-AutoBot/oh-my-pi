import { afterAll, afterEach, expect, test } from "bun:test";
import { unwatchFile, watchFile } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
	AUTO_BOT_RESTART_EXIT_CODE,
	AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
} from "../packages/coding-agent/src/autobot-update/contract.ts";
import type {
	AutoBotHandoffClaim,
	AutoBotHandoffOwner,
	AutoBotReleaseManifest,
	AutoBotRestartRequest,
	AutoBotRestartTarget,
} from "../packages/coding-agent/src/autobot-update/contract.ts";
import {
	createAutoBotHandoff,
	writeAutoBotActivation,
	writeAutoBotActivationAcknowledgement,
	writeAutoBotCandidateReady,
} from "../packages/coding-agent/src/autobot-update/handoff.ts";
import { ensureAutoBotInstallationIdentity } from "../packages/coding-agent/src/autobot-update/identity.ts";
import { acquireAutoBotFileLock } from "../packages/coding-agent/src/autobot-update/lock.ts";
import {
	autoBotHandoffPath,
	autoBotLaunchLeaseLockPath,
	autoBotPaths,
	autoBotSignalPath,
} from "../packages/coding-agent/src/autobot-update/paths.ts";
import type { AutoBotPaths } from "../packages/coding-agent/src/autobot-update/paths.ts";
import { ensureAutoBotPrivateDirectory } from "../packages/coding-agent/src/autobot-update/permissions.ts";
import { currentAutoBotRuntimeTarget } from "../packages/coding-agent/src/autobot-update/platform.ts";
import {
	commitAutoBotPendingRestart,
	createAutoBotPendingRestart,
	readAutoBotActivePointer,
	readAutoBotCommittedRestart,
	readAutoBotPendingRestart,
	withAutoBotHandoffLock,
	writeAutoBotActivePointer,
} from "../packages/coding-agent/src/autobot-update/state.ts";
import type {
	AutoBotCommittedRestart,
	AutoBotHandoffJournalMatch,
	AutoBotPendingRestart,
} from "../packages/coding-agent/src/autobot-update/state.ts";
import { sha256File } from "../packages/coding-agent/src/autobot-update/storage.ts";

const repoRoot = path.join(import.meta.dir, "..");
const temporaryDirectories: string[] = [];
const activeBootstrapRuns = new Set<BootstrapRun>();
const activeForeignHandoffLockHolders = new Set<ForeignHandoffLockHolder>();
const legacyProcessProgram = [
	'process.stdout.write("ready\\n")',
	"process.stdin.resume()",
	"const gate = Promise.withResolvers()",
	'process.stdin.once("end", gate.resolve)',
	"await gate.promise",
].join("; ");

interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

type LegacyProcess = Bun.Subprocess<"pipe", "pipe", "ignore">;

function legacyExecutableName(): string {
	return process.platform === "win32" ? "omp.exe" : "omp";
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function createPrivateRoot(): Promise<string> {
	if (process.platform === "win32") {
		return ensureAutoBotPrivateDirectory(await createTemporaryDirectory("omp-autobot-install-"));
	}
	const root = await fs.mkdtemp(path.join(os.homedir(), "omp-autobot-install-"));
	temporaryDirectories.push(root);
	return ensureAutoBotPrivateDirectory(root);
}

async function createPosixInheritedRoot(): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.homedir(), "omp-autobot-inherited-"));
	temporaryDirectories.push(parent);
	await fs.chmod(parent, 0o755);
	const root = path.join(parent, "root");
	await fs.mkdir(root, { mode: 0o755 });
	await fs.chmod(root, 0o755);
	return root;
}

async function createTrustedPublicKey(directory: string): Promise<string> {
	const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
	if (!("publicKey" in generated)) throw new Error("Ed25519 key generation did not return a key pair");
	const keyPath = path.join(directory, "release-public.spki");
	await Bun.write(keyPath, new Uint8Array(await crypto.subtle.exportKey("spki", generated.publicKey)));
	return keyPath;
}

async function awaitLegacyProcessReady(processHandle: LegacyProcess): Promise<void> {
	const reader = processHandle.stdout.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		while (!output.includes("ready\n")) {
			const { done, value } = await reader.read();
			if (done) throw new Error("The copied legacy executable exited before it announced readiness");
			output += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

function assertLiveLegacyProcess(executablePath: string, pid: number): void {
	if (
		!Process.fromPath(executablePath).some(
			candidate => candidate.pid === pid && candidate.status() === ProcessStatus.Running,
		)
	) {
		throw new Error(`The copied legacy executable was not observed as a running process: ${executablePath}`);
	}
}

async function runInstaller(args: readonly string[]): Promise<CommandResult> {
	const installer = Bun.spawn([process.execPath, path.join(repoRoot, "scripts", "autobot-install.ts"), ...args], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		installer.exited,
		new Response(installer.stdout).text(),
		new Response(installer.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function stopProcess(processHandle: LegacyProcess): Promise<void> {
	try {
		processHandle.kill();
	} catch {
		// The process may already have exited while the installer rejected it.
	}
	await processHandle.exited;
}

afterEach(async () => {
	await Promise.all([...activeForeignHandoffLockHolders].map(stopForeignHandoffLockHolder));
	await Promise.all([...activeBootstrapRuns].map(stopBootstrap));
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

const fixtureTimestamp = "2026-09-17T00:00:00.000Z";
const identityModulePath = path
	.join(repoRoot, "packages", "coding-agent", "src", "autobot-update", "identity.ts")
	.replaceAll("\\", "/");
const handoffModulePath = path
	.join(repoRoot, "packages", "coding-agent", "src", "autobot-update", "handoff.ts")
	.replaceAll("\\", "/");
const stateModulePath = path
	.join(repoRoot, "packages", "coding-agent", "src", "autobot-update", "state.ts")
	.replaceAll("\\", "/");
const pathsModulePath = path
	.join(repoRoot, "packages", "coding-agent", "src", "autobot-update", "paths.ts")
	.replaceAll("\\", "/");
const fixtureRuntimeProgramEnvironment = "OMP_TEST_AUTOBOT_RUNTIME_PROGRAM";
// These are integration guards around separately scheduled child processes;
// fake timers cannot bound filesystem-lock acquisition or child termination.
const foreignHandoffLockHolderAcquisitionTimeoutMs = 15_000;
const foreignHandoffLockHolderCleanupTimeoutMs = 5_000;
const foreignHandoffLockHolderPhases: Record<string, true> = {
	"modules-loaded": true,
	"acquiring-lock": true,
	"lock-acquired": true,
	"pending-rejected": true,
	"pending-written": true,
	"ready-to-signal": true,
};
const fixtureRuntimeStageEnvironment = "OMP_TEST_AUTOBOT_RUNTIME_STAGE";

let compiledBootstrapDirectory: string | undefined;
let compiledBootstrapPath: string | undefined;
let compiledFixtureRuntimePath: string | undefined;

afterAll(async () => {
	if (compiledBootstrapDirectory) {
		await fs.rm(compiledBootstrapDirectory, { recursive: true, force: true });
	}
});

interface BootstrapFixture {
	readonly root: string;
	readonly paths: AutoBotPaths;
	readonly bootstrapPath: string;
	readonly activeRuntimePath: string;
	readonly candidateRuntimePath: string;
	readonly activeManifest: AutoBotReleaseManifest;
	readonly candidateManifest: AutoBotReleaseManifest;
}

interface RuntimeEvidence {
	readonly authenticated: boolean;
	readonly launchId: string;
	readonly bootstrapProcessId: number;
	readonly processId: number;
	readonly parentProcessId: number;
	readonly role: string;
}

type BootstrapProcess = Bun.Subprocess<"ignore", "ignore", "pipe">;

interface BootstrapRun {
	readonly bootstrap: BootstrapProcess;
	readonly stderr: Promise<string>;
	readonly programPath: string;
	readonly stagePath: string;
	readonly evidencePath: string;
	readonly gatePath: string;
	readonly restartGatePath?: string;
	readonly candidate: boolean;
	readonly activationObservedPath?: string;
	readonly postAcknowledgementPath?: string;
	readonly promotedExitGatePath?: string;
	readonly promotedExitIntentPath?: string;
	readonly promotedExitReleaseGatePath?: string;
	readonly promotedExitEvidencePath?: string;
}

interface ForeignHandoffLockHolder {
	readonly process: BootstrapProcess;
	readonly stderr: Promise<string>;
	readonly acquiredPath: string;
	readonly phasePath: string;
	readonly releasePath: string;
}

interface BootstrapStartOptions {
	readonly candidate?: boolean;
	readonly promoteAndQuit?: boolean;
}

function fixtureId(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

function releaseManifest(
	releaseSequence: number,
	target: string,
	runtimeSha256: string,
	runtimeSize: number,
	bootstrapSha256: string,
	bootstrapSize: number,
): AutoBotReleaseManifest {
	return {
		schemaVersion: AUTO_BOT_RELEASE_SCHEMA_VERSION,
		releaseSequence,
		upstreamVersion: "18.2.3",
		forkCommit: "a".repeat(40),
		upstreamCommit: "b".repeat(40),
		publishedAt: fixtureTimestamp,
		minimumBootstrapVersion: AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		assets: [
			{
				kind: "runtime",
				target,
				url: "https://assets.example.invalid/runtime",
				size: runtimeSize,
				sha256: runtimeSha256,
			},
			{
				kind: "bootstrap",
				target,
				url: "https://assets.example.invalid/bootstrap",
				size: bootstrapSize,
				sha256: bootstrapSha256,
			},
		],
		webBundleId: `fixture-bundle-${releaseSequence}`,
	};
}

function restartTarget(manifest: AutoBotReleaseManifest): AutoBotRestartTarget {
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

async function ensureStandaloneBootstrap(): Promise<string> {
	if (compiledBootstrapPath) return compiledBootstrapPath;
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autobot-bootstrap-fixture-"));
	compiledBootstrapDirectory = directory;
	const outputPath = path.join(directory, legacyExecutableName());
	const compiler = Bun.spawn(
		[
			process.execPath,
			path.join(repoRoot, "scripts", "autobot-build-bootstrap.ts"),
			"--target",
			currentAutoBotRuntimeTarget(),
			"--out",
			outputPath,
		],
		{ cwd: repoRoot, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
	);
	const [exitCode, stderr] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()]);
	if (exitCode !== 0) {
		throw new Error(`Unable to build the standalone AutoBot bootstrap fixture: ${stderr}`);
	}
	compiledBootstrapPath = outputPath;
	return outputPath;
}

async function ensureFixtureRuntime(): Promise<string> {
	if (compiledFixtureRuntimePath) return compiledFixtureRuntimePath;
	await ensureStandaloneBootstrap();
	const directory = compiledBootstrapDirectory;
	if (!directory) throw new Error("AutoBot fixture compiler directory is unavailable");
	const entrypoint = path.join(directory, "runtime-fixture.ts");
	const outputPath = path.join(directory, process.platform === "win32" ? "runtime-fixture.exe" : "runtime-fixture");
	await Bun.write(
		entrypoint,
		[
			'import * as path from "node:path";',
			'import { pathToFileURL } from "node:url";',
			"const root = process.env.OMP_AUTOBOT_ROOT;",
			`const programPath = process.env[${JSON.stringify(fixtureRuntimeProgramEnvironment)}];`,
			`const stagePath = process.env[${JSON.stringify(fixtureRuntimeStageEnvironment)}];`,
			"const insideRoot = candidate => {",
			"\tif (!root || !candidate || !path.isAbsolute(candidate)) return false;",
			"\tconst relative = path.relative(path.resolve(root), path.resolve(candidate));",
			'\treturn Boolean(relative) && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);',
			"};",
			'if (!insideRoot(programPath) || !insideRoot(stagePath)) throw new Error("Fixture runtime controls are unavailable");',
			'await Bun.write(stagePath, "runtime launcher entered");',
			"await import(pathToFileURL(programPath).href);",
		].join("\n"),
	);
	const build = await Bun.build({
		entrypoints: [entrypoint],
		target: "bun",
		format: "esm",
		compile: {
			outfile: outputPath,
			autoloadBunfig: false,
			autoloadDotenv: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
		},
		throw: false,
	});
	if (!build.success) {
		throw new Error(`Unable to build the AutoBot fixture runtime: ${build.logs.map(log => log.message).join("\n")}`);
	}
	compiledFixtureRuntimePath = outputPath;
	return outputPath;
}

async function writeRuntimeSlot(
	paths: AutoBotPaths,
	slotId: string,
	manifest: AutoBotReleaseManifest,
	bootstrapPath: string,
	runtimeSourcePath: string,
): Promise<string> {
	const slotPath = await ensureAutoBotPrivateDirectory(path.join(paths.runtimeDir, slotId));
	const runtimePath = path.join(slotPath, legacyExecutableName());
	await fs.copyFile(runtimeSourcePath, runtimePath);
	if (process.platform !== "win32") await fs.chmod(runtimePath, 0o700);
	const runtimeSha256 = await sha256File(runtimePath);
	if (runtimeSha256 !== manifest.assets[0]?.sha256) {
		throw new Error("AutoBot fixture manifest does not bind its copied runtime");
	}
	await Bun.write(
		path.join(slotPath, "release.json"),
		JSON.stringify({
			schemaVersion: 1,
			payloadSha256: "c".repeat(64),
			manifest,
			runtimeSha256,
			bootstrapPath,
			createdAt: fixtureTimestamp,
		}),
	);
	return runtimePath;
}

async function createBootstrapFixture(): Promise<BootstrapFixture> {
	const root = await createPrivateRoot();
	const paths = autoBotPaths(root);
	await ensureAutoBotInstallationIdentity(paths);
	const bootstrapSource = await ensureStandaloneBootstrap();
	const runtimeSource = await ensureFixtureRuntime();
	const bootstrapPath = path.join(root, legacyExecutableName());
	await fs.copyFile(bootstrapSource, bootstrapPath);
	if (process.platform !== "win32") await fs.chmod(bootstrapPath, 0o700);

	const [runtimeSha256, bootstrapSha256, runtimeStat, bootstrapStat] = await Promise.all([
		sha256File(runtimeSource),
		sha256File(bootstrapPath),
		fs.stat(runtimeSource),
		fs.stat(bootstrapPath),
	]);
	const target = currentAutoBotRuntimeTarget();
	const activeManifest = releaseManifest(
		1,
		target,
		runtimeSha256,
		runtimeStat.size,
		bootstrapSha256,
		bootstrapStat.size,
	);
	const candidateManifest = releaseManifest(
		2,
		target,
		runtimeSha256,
		runtimeStat.size,
		bootstrapSha256,
		bootstrapStat.size,
	);
	const activeRuntimePath = await writeRuntimeSlot(
		paths,
		"1-fixture-active",
		activeManifest,
		bootstrapPath,
		runtimeSource,
	);
	const candidateRuntimePath = await writeRuntimeSlot(
		paths,
		"2-fixture-candidate",
		candidateManifest,
		bootstrapPath,
		runtimeSource,
	);
	await writeAutoBotActivePointer(paths, {
		schemaVersion: 1,
		slotId: "1-fixture-active",
		runtimePath: activeRuntimePath,
		runtimeSha256,
		manifest: activeManifest,
		activatedAt: fixtureTimestamp,
	});
	return {
		root,
		paths,
		bootstrapPath,
		activeRuntimePath,
		candidateRuntimePath,
		activeManifest,
		candidateManifest,
	};
}

function runtimeProgram(input: {
	readonly evidencePath: string;
	readonly gatePath: string;
	readonly restartGatePath?: string;
	readonly promoteAndQuit: boolean;
	readonly activationObservedPath?: string;
	readonly promotedExitIntentPath?: string;
	readonly promotedExitReleaseGatePath?: string;
	readonly promotedExitEvidencePath?: string;
	readonly postAcknowledgementPath?: string;
	readonly promotedExitGatePath?: string;
}): string {
	return `
// Bundle these static checkout imports with the per-run fixture program. The
// copied runtime only imports that bundled program from its managed root.
import { unwatchFile, watchFile } from "node:fs";
import { readAuthenticatedAutoBotEnvironment } from ${JSON.stringify(identityModulePath)};
import {
	readAutoBotHandoff,
	authorizeAutoBotRestartExit,
	promoteAutoBotStartupHandoff,
	requestAutoBotNormalExit,
	writeAutoBotActivationAcknowledgement,
	writeAutoBotCandidateReady,
} from ${JSON.stringify(handoffModulePath)};
import { autoBotSignalPath } from ${JSON.stringify(pathsModulePath)};
import {
	readAutoBotActivePointer,
	readAutoBotCommittedRestart,
	readAutoBotPendingRestart,
	withAutoBotHandoffLock,
} from ${JSON.stringify(stateModulePath)};

const environment = readAuthenticatedAutoBotEnvironment();
if (!environment) throw new Error("The runtime did not receive an authenticated AutoBot environment");
const promotedExitGatePath = ${JSON.stringify(input.promotedExitGatePath)};
const promotedExitIntentPath = ${JSON.stringify(input.promotedExitIntentPath)};
const promotedExitReleaseGatePath = ${JSON.stringify(input.promotedExitReleaseGatePath)};
const promotedExitEvidencePath = ${JSON.stringify(input.promotedExitEvidencePath)};
const restartGatePath = ${JSON.stringify(input.restartGatePath ?? input.gatePath)};
const promoteAndQuit = ${JSON.stringify(input.promoteAndQuit)};

async function waitForCondition(filePaths, condition) {
	const initial = await condition();
	if (initial) return initial;
	const { promise, resolve, reject } = Promise.withResolvers();
	let settled = false;
	let checking = false;
	let recheckRequested = false;
	const finish = (value, error) => {
		if (settled) return;
		settled = true;
		if (error !== undefined) reject(error);
		else resolve(value);
	};
	const check = () => {
		if (settled) return;
		if (checking) {
			recheckRequested = true;
			return;
		}
		checking = true;
		void Promise.resolve()
			.then(condition)
			.then(
				value => {
					if (value) finish(value);
				},
				error => finish(undefined, error),
			)
			.finally(() => {
				checking = false;
				if (recheckRequested) {
					recheckRequested = false;
					check();
				}
			});
	};
	const listener = () => check();
	for (const filePath of filePaths) {
		watchFile(filePath, { interval: 25, persistent: true }, listener);
	}
	listener();
	try {
		return await promise;
	} finally {
		for (const filePath of filePaths) {
			unwatchFile(filePath, listener);
		}
	}
}

async function waitForEitherFile(firstPath, secondPath) {
	return waitForCondition([firstPath, secondPath], async () => {
		if (await Bun.file(firstPath).exists()) return "first";
		return (await Bun.file(secondPath).exists()) ? "second" : undefined;
	});
}

function promotionFailureDetails(error) {
	const message = error instanceof Error ? error.message : "";
	const errorName =
		error instanceof Error && ["Error", "TypeError", "SyntaxError", "RangeError", "AggregateError"].includes(error.name)
			? error.name
			: error instanceof Error
				? "other-error"
				: "non-error";
	const rawCode = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	const errorCode =
		rawCode === undefined
			? "none"
			: [
						"ENOENT",
						"EACCES",
						"EPERM",
						"EEXIST",
						"EBUSY",
						"EINVAL",
						"EIO",
						"ENOTDIR",
						"SQLITE_BUSY",
						"SQLITE_BUSY_RECOVERY",
						"SQLITE_IOERR",
						"SQLITE_CANTOPEN",
					].includes(rawCode)
				? rawCode
				: "other";
	let category = "unexpected";
	switch (message) {
		case "AutoBot promotion requires an authenticated candidate or fallback launch":
			category = "environment-rejected";
			break;
		case "AutoBot promotion handoff path does not match its authenticated launch":
			category = "handoff-path-mismatch";
			break;
		case "AutoBot promotion handoff does not match its authenticated launch":
			category = "handoff-record-mismatch";
			break;
		case "AutoBot promotion handoff does not match its current bootstrap claim":
			category = "bootstrap-claim-mismatch";
			break;
		case "AutoBot candidate cannot promote before activation acknowledgement":
			category = "activation-ack-missing";
			break;
		case "AutoBot promotion handoff no longer matches its sealed record":
			category = "sealed-handoff-race";
			break;
		case "AutoBot promotion does not match this authenticated launch":
			category = "promotion-record-mismatch";
			break;
		case "Invalid AutoBot handoff nonce":
			category = "nonce-invalid";
			break;
		case "AutoBot handoff references an unmanaged runtime":
			category = "handoff-runtime-unmanaged";
			break;
		case "AutoBot handoff contains a non-absolute session path":
			category = "handoff-session-path-invalid";
			break;
		default:
			if (message.startsWith("AutoBot activation acknowledgement ")) category = "activation-ack-invalid";
			else if (message.endsWith(" must be a canonical UTC timestamp")) category = "canonical-timestamp";
			else if (
				message.startsWith("AutoBot control lock ") ||
				message.startsWith("Cannot acquire") ||
				message.startsWith("Cannot create") ||
				message.startsWith("Cannot inspect") ||
				message.startsWith("Cannot verify") ||
				message.startsWith("Cannot release")
			) {
				category = "lock-failure";
			} else if (message.startsWith("AutoBot handoff ")) {
				category = "handoff-validation-failure";
			} else if (message.startsWith("AutoBot promotion ")) {
				category = "promotion-failure";
			}
	}
	return { category, errorName, errorCode };
}

async function postPromotionAuthenticationState(handoff) {
	const [pending, committed, promotion, candidateHandoff] = await Promise.allSettled([
		readAutoBotPendingRestart(environment.paths),
		readAutoBotCommittedRestart(environment.paths),
		Bun.file(autoBotSignalPath(environment.paths, handoff.nonce, "promoted")).exists(),
		Bun.file(environment.handoffFile).exists(),
	]);
	const journalState =
		pending.status !== "fulfilled" || committed.status !== "fulfilled"
			? "unavailable"
			: pending.value !== undefined && committed.value !== undefined
				? "both"
				: pending.value !== undefined
					? "pending"
					: committed.value !== undefined
						? "committed"
						: "cleared";
	return {
		journalState,
		promotionPresent: promotion.status === "fulfilled" && promotion.value,
		candidateHandoffPresent: candidateHandoff.status === "fulfilled" && candidateHandoff.value,
	};
}

await Bun.write(${JSON.stringify(input.evidencePath)}, JSON.stringify({
	authenticated: true,
	launchId: environment.launchId,
	bootstrapProcessId: environment.bootstrapProcessId,
	processId: process.pid,
	parentProcessId: process.ppid,
	role: environment.role,
}));

if (environment.role !== "candidate") {
	await waitForCondition([restartGatePath], () => Bun.file(restartGatePath).exists());
	if (promoteAndQuit) {
		const pending = await readAutoBotPendingRestart(environment.paths);
		if (!pending) throw new Error("Authenticated active runtime could not authorize its restart");
		await authorizeAutoBotRestartExit(pending.request);
		process.exitCode = ${AUTO_BOT_RESTART_EXIT_CODE};
	} else if (!(await requestAutoBotNormalExit())) {
		throw new Error("Authenticated active runtime could not request normal exit");
	}
} else {
	const handoff = await readAutoBotHandoff(environment.paths, environment.handoffFile);
	if (!handoff) throw new Error("Candidate runtime has no sealed handoff");
	await writeAutoBotCandidateReady(environment.paths, {
		protocolVersion: ${AUTO_BOT_HANDOFF_PROTOCOL_VERSION},
		nonce: handoff.nonce,
		releaseSequence: handoff.target.releaseSequence,
		compatibilityEpoch: handoff.target.compatibilityEpoch,
		sessionFile: handoff.sessionFile,
		sessionId: handoff.sessionId,
	});
	const activationPath = autoBotSignalPath(environment.paths, handoff.nonce, "activate");
	const activationObserved =
		(await waitForEitherFile(activationPath, ${JSON.stringify(input.gatePath)})) === "first";
	if (activationObserved) {
		await Bun.write(${JSON.stringify(input.activationObservedPath ?? input.gatePath)}, "activation observed");
		await waitForCondition([${JSON.stringify(input.gatePath)}], () => Bun.file(${JSON.stringify(input.gatePath)}).exists());
		await writeAutoBotActivationAcknowledgement(environment.paths, handoff);
		await promoteAutoBotStartupHandoff();
		await waitForCondition([environment.paths.activePointerPath], async () => {
			return (await readAutoBotActivePointer(environment.paths))?.runtimePath === process.execPath;
		});
		await waitForCondition([environment.paths.pendingRestartPath, environment.paths.committedRestartPath], async () => {
			const [pending, committed] = await Promise.all([
				readAutoBotPendingRestart(environment.paths),
				readAutoBotCommittedRestart(environment.paths),
			]);
			return pending === undefined && committed === undefined;
		});
		await withAutoBotHandoffLock(environment.paths, async () => undefined);
		const reauthenticationState = await postPromotionAuthenticationState(handoff);
		let authenticatedAfterPromotion = true;
		let promotionFailure = { category: "none", errorName: "none", errorCode: "none" };
		try {
			await promoteAutoBotStartupHandoff();
		} catch (error) {
			authenticatedAfterPromotion = false;
			promotionFailure = promotionFailureDetails(error);
		}
		await Bun.write(
			${JSON.stringify(input.postAcknowledgementPath ?? input.gatePath)},
			JSON.stringify({ authenticatedAfterPromotion, promotionFailure, ...reauthenticationState }),
		);
		if (authenticatedAfterPromotion && promotedExitGatePath !== undefined) {
			await waitForCondition([promotedExitGatePath], () => Bun.file(promotedExitGatePath).exists());
			if (!(await requestAutoBotNormalExit())) {
				throw new Error("Promoted candidate could not request a normal exit");
			}
			if (
				promotedExitIntentPath === undefined ||
				promotedExitReleaseGatePath === undefined ||
				promotedExitEvidencePath === undefined
			) {
				throw new Error("Promoted candidate normal-exit controls are unavailable");
			}
			await Bun.write(promotedExitIntentPath, "normal exit intent");
			await waitForCondition([promotedExitReleaseGatePath], () => Bun.file(promotedExitReleaseGatePath).exists());
			await Bun.write(promotedExitEvidencePath, JSON.stringify({ nativeExitCode: process.exitCode ?? 0 }));
		}
		if (!authenticatedAfterPromotion) process.exitCode = 92;
	}
}
`;
}

async function startBootstrap(fixture: BootstrapFixture, options: BootstrapStartOptions = {}): Promise<BootstrapRun> {
	const { candidate = false, promoteAndQuit = false } = options;
	const identifier = fixtureId();
	const stagePath = path.join(fixture.root, `${identifier}.entered`);
	const evidencePath = path.join(fixture.root, `${identifier}.evidence.json`);
	const gatePath = path.join(fixture.root, `${identifier}.exit`);
	const restartGatePath = promoteAndQuit ? path.join(fixture.root, `${identifier}.restart`) : undefined;
	const candidateControls = candidate || promoteAndQuit;
	const activationObservedPath = candidateControls ? path.join(fixture.root, `${identifier}.activation`) : undefined;
	const postAcknowledgementPath = candidateControls
		? path.join(fixture.root, `${identifier}.post-ack.json`)
		: undefined;
	const promotedExitGatePath = promoteAndQuit ? path.join(fixture.root, `${identifier}.promoted-exit`) : undefined;
	const promotedExitIntentPath = promoteAndQuit
		? path.join(fixture.root, `${identifier}.promoted-exit-intent`)
		: undefined;
	const promotedExitReleaseGatePath = promoteAndQuit
		? path.join(fixture.root, `${identifier}.promoted-exit-release`)
		: undefined;
	const promotedExitEvidencePath = promoteAndQuit
		? path.join(fixture.root, `${identifier}.promoted-exit.json`)
		: undefined;
	const programSourcePath = path.join(fixture.root, `${identifier}.runtime.ts`);
	const programPath = path.join(fixture.root, `${identifier}.runtime.js`);
	await Bun.write(
		programSourcePath,
		runtimeProgram({
			evidencePath,
			gatePath,
			restartGatePath,
			activationObservedPath,
			promoteAndQuit,
			postAcknowledgementPath,
			promotedExitGatePath,
			promotedExitIntentPath,
			promotedExitReleaseGatePath,
			promotedExitEvidencePath,
		}),
	);
	const programBundle = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"build",
			programSourcePath,
			"--target=bun",
			"--format=esm",
			`--outfile=${programPath}`,
			"--external=node:*",
			"--external=bun:*",
		],
		{ cwd: repoRoot, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
	);
	const [bundleExitCode, bundleStderr] = await Promise.all([
		programBundle.exited,
		new Response(programBundle.stderr).text(),
	]);
	if (bundleExitCode !== 0) {
		throw new Error(`Unable to bundle the AutoBot fixture runtime program: ${bundleStderr}`);
	}
	if (!(await Bun.file(programPath).exists())) {
		throw new Error("Bundled AutoBot fixture runtime program is unavailable");
	}
	const bootstrap = Bun.spawn([fixture.bootstrapPath], {
		cwd: fixture.root,
		env: {
			...Bun.env,
			[fixtureRuntimeProgramEnvironment]: programPath,
			[fixtureRuntimeStageEnvironment]: stagePath,
			OMP_AUTOBOT_LAUNCH_ID: "f".repeat(32),
			OMP_AUTOBOT_BOOTSTRAP_PROCESS_ID: "1",
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	}) as BootstrapProcess;
	const run: BootstrapRun = {
		bootstrap,
		stderr: new Response(bootstrap.stderr).text(),
		programPath,
		stagePath,
		evidencePath,
		gatePath,
		...(restartGatePath === undefined ? {} : { restartGatePath }),
		candidate,
		...(activationObservedPath === undefined ? {} : { activationObservedPath }),
		...(postAcknowledgementPath === undefined ? {} : { postAcknowledgementPath }),
		...(promotedExitGatePath === undefined ? {} : { promotedExitGatePath }),
		...(promotedExitIntentPath === undefined ? {} : { promotedExitIntentPath }),
		...(promotedExitReleaseGatePath === undefined ? {} : { promotedExitReleaseGatePath }),
		...(promotedExitEvidencePath === undefined ? {} : { promotedExitEvidencePath }),
	};
	activeBootstrapRuns.add(run);
	return run;
}

/**
 * Bun's Linux directory watcher can stop after a rename; stat-poll the target
 * path so fixture synchronization observes the durable marker itself.
 */
async function waitForFile(filePath: string, signal?: AbortSignal): Promise<void> {
	if (await Bun.file(filePath).exists()) return;
	if (signal?.aborted) throw signal.reason ?? new Error("Fixture file wait was aborted");
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	const finish = (error?: unknown): void => {
		if (settled) return;
		settled = true;
		if (error) reject(error);
		else resolve();
	};
	const abort = (): void => finish(signal?.reason ?? new Error("Fixture file wait was aborted"));
	const check = (): void => {
		void Bun.file(filePath)
			.exists()
			.then(exists => {
				if (exists) finish();
			}, finish);
	};
	watchFile(filePath, { interval: 25, persistent: false }, check);
	signal?.addEventListener("abort", abort, { once: true });
	check();
	try {
		await promise;
	} finally {
		unwatchFile(filePath, check);
		signal?.removeEventListener("abort", abort);
	}
}
type BootstrapCandidatePhase =
	| "candidate activation"
	| "candidate post-acknowledgement"
	| "promoted normal-exit intent";

async function waitForBootstrapFile(
	run: BootstrapRun,
	filePath: string,
	phase: BootstrapCandidatePhase,
): Promise<void> {
	const abort = new AbortController();
	try {
		const outcome = await Promise.race([
			waitForFile(filePath, abort.signal).then(() => ({ kind: "file" as const })),
			run.bootstrap.exited.then(async exitCode => ({
				kind: "exited" as const,
				exitCode,
				failure: bootstrapFailureSummary(await run.stderr),
			})),
		]);
		if (outcome.kind === "exited" && !(await Bun.file(filePath).exists())) {
			throw new Error(
				`Bootstrap exited before ${phase}: ${JSON.stringify({
					exitCode: outcome.exitCode,
					failure: outcome.failure,
				})}`,
			);
		}
	} finally {
		abort.abort();
	}
}

function foreignHandoffLockHolderProgram(input: {
	readonly root: string;
	readonly pending: AutoBotPendingRestart;
	readonly acquiredPath: string;
	readonly phasePath: string;
	readonly releasePath: string;
}): string {
	return `
import { unwatchFile, watchFile } from "node:fs";
import { autoBotPaths } from ${JSON.stringify(pathsModulePath)};
import { createAutoBotPendingRestart, withAutoBotHandoffLock } from ${JSON.stringify(stateModulePath)};

async function waitForFile(filePath) {
	if (await Bun.file(filePath).exists()) return;
	const { promise, resolve, reject } = Promise.withResolvers();
	let settled = false;
	const finish = error => {
		if (settled) return;
		settled = true;
		if (error) reject(error);
		else resolve();
	};
	const check = () => {
		void Bun.file(filePath).exists().then(exists => {
			if (exists) finish();
		}, finish);
	};
	watchFile(filePath, { interval: 25, persistent: true }, check);
	check();
	try {
		await promise;
	} finally {
		unwatchFile(filePath, check);
	}
}

async function writePhase(phase) {
	await Bun.write(${JSON.stringify(input.phasePath)}, phase);
}

await writePhase("modules-loaded");
const paths = autoBotPaths(${JSON.stringify(input.root)});
const pending = ${JSON.stringify(input.pending)};
await writePhase("acquiring-lock");
await withAutoBotHandoffLock(paths, async () => {
	await writePhase("lock-acquired");
	if (!(await createAutoBotPendingRestart(paths, pending))) {
		await writePhase("pending-rejected");
		throw new Error("Foreign handoff transaction could not create its pending journal");
	}
	await writePhase("pending-written");
	await writePhase("ready-to-signal");
	// Do not write another phase marker after this: the parent must observe the
	// acquisition marker itself rather than a later directory-watch event.
	await Bun.write(${JSON.stringify(input.acquiredPath)}, "acquired");
	await waitForFile(${JSON.stringify(input.releasePath)});
});
`;
}

async function startForeignHandoffLockHolder(
	fixture: BootstrapFixture,
	pending: AutoBotPendingRestart,
): Promise<ForeignHandoffLockHolder> {
	const identifier = fixtureId();
	const acquiredPath = path.join(fixture.root, `${identifier}.foreign-lock-acquired`);
	const phasePath = path.join(fixture.root, `${identifier}.foreign-lock-phase`);
	const releasePath = path.join(fixture.root, `${identifier}.foreign-lock-release`);
	const programPath = path.join(fixture.root, `${identifier}.foreign-lock-holder.ts`);
	await Bun.write(
		programPath,
		foreignHandoffLockHolderProgram({
			root: fixture.root,
			pending,
			acquiredPath,
			phasePath,
			releasePath,
		}),
	);
	const holderProcess = Bun.spawn([process.execPath, "--no-env-file", programPath], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	}) as BootstrapProcess;
	const holder: ForeignHandoffLockHolder = {
		process: holderProcess,
		stderr: new Response(holderProcess.stderr).text(),
		acquiredPath,
		phasePath,
		releasePath,
	};
	activeForeignHandoffLockHolders.add(holder);
	return holder;
}

async function foreignHandoffLockHolderPhase(holder: ForeignHandoffLockHolder): Promise<string> {
	try {
		const phase = await Bun.file(holder.phasePath).text();
		return Object.hasOwn(foreignHandoffLockHolderPhases, phase) ? phase : "unavailable";
	} catch {
		return "unavailable";
	}
}

async function foreignHandoffLockHolderStatus(
	holder: ForeignHandoffLockHolder,
): Promise<{ readonly phase: string; readonly acquired: boolean }> {
	const [phase, acquired] = await Promise.all([
		foreignHandoffLockHolderPhase(holder),
		Bun.file(holder.acquiredPath).exists(),
	]);
	return { phase, acquired };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	const { promise: expired, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), timeoutMs);
	try {
		return await Promise.race([promise.then(() => true), expired]);
	} finally {
		clearTimeout(timer);
	}
}

async function awaitForeignHandoffLockHolder(holder: ForeignHandoffLockHolder): Promise<void> {
	const abort = new AbortController();
	const acquisitionTimeout = Promise.withResolvers<{ readonly kind: "timed-out" }>();
	const timer = setTimeout(
		() => acquisitionTimeout.resolve({ kind: "timed-out" }),
		foreignHandoffLockHolderAcquisitionTimeoutMs,
	);
	try {
		const outcome = await Promise.race([
			waitForFile(holder.acquiredPath, abort.signal).then(() => ({ kind: "acquired" as const })),
			holder.process.exited.then(async exitCode => ({
				kind: "exited" as const,
				exitCode,
				status: await foreignHandoffLockHolderStatus(holder),
				failure: bootstrapFailureSummary(await holder.stderr),
			})),
			acquisitionTimeout.promise,
		]);
		if (outcome.kind === "exited") {
			throw new Error(
				`Foreign handoff lock holder exited before acquisition: ${JSON.stringify({
					exitCode: outcome.exitCode,
					status: outcome.status,
					failure: outcome.failure,
				})}`,
			);
		}
		if (outcome.kind === "timed-out") {
			throw new Error(
				`Foreign handoff lock holder did not acquire the lock within ${foreignHandoffLockHolderAcquisitionTimeoutMs}ms: ${JSON.stringify(
					{
						status: await foreignHandoffLockHolderStatus(holder),
					},
				)}`,
			);
		}
	} finally {
		clearTimeout(timer);
		abort.abort();
	}
}

async function stopForeignHandoffLockHolder(holder: ForeignHandoffLockHolder): Promise<void> {
	try {
		await Bun.write(holder.releasePath, "release");
		if (
			await settlesWithin(
				Promise.all([holder.process.exited, holder.stderr]),
				foreignHandoffLockHolderCleanupTimeoutMs,
			)
		) {
			return;
		}
		const phase = await foreignHandoffLockHolderPhase(holder);
		try {
			holder.process.kill("SIGKILL");
		} catch {
			// The process may have exited after the bounded cleanup wait.
		}
		await Promise.all([holder.process.exited, holder.stderr]);
		throw new Error(
			`Foreign handoff lock holder did not stop after release within ${foreignHandoffLockHolderCleanupTimeoutMs}ms: ${JSON.stringify(
				{
					phase,
				},
			)}`,
		);
	} finally {
		activeForeignHandoffLockHolders.delete(holder);
	}
}

async function runtimeEvidence(run: BootstrapRun): Promise<RuntimeEvidence> {
	const abort = new AbortController();
	try {
		await Promise.race([
			waitForFile(run.evidencePath, abort.signal),
			run.bootstrap.exited.then(async exitCode => {
				throw new Error(
					`Bootstrap exited before its runtime became authenticated (${exitCode}): ${await run.stderr}`,
				);
			}),
		]);
		return JSON.parse(await Bun.file(run.evidencePath).text()) as RuntimeEvidence;
	} finally {
		abort.abort();
	}
}

async function recoveredRuntimeEvidence(input: {
	readonly fixture: BootstrapFixture;
	readonly run: BootstrapRun;
	readonly request: AutoBotRestartRequest;
	readonly owner: AutoBotHandoffOwner;
	readonly oldClaim: AutoBotHandoffClaim;
	readonly oldCandidateProcessId: number;
}): Promise<RuntimeEvidence> {
	try {
		return await runtimeEvidence(input.run);
	} catch {
		const [
			pending,
			committed,
			runtimeEntered,
			evidencePresent,
			gatePresent,
			programPresent,
			candidateReady,
			activation,
			acknowledgement,
			promotion,
			normalExit,
		] = await Promise.all([
			readAutoBotPendingRestart(input.fixture.paths),
			readAutoBotCommittedRestart(input.fixture.paths),
			Bun.file(input.run.stagePath).exists(),
			Bun.file(input.run.evidencePath).exists(),
			Bun.file(input.run.gatePath).exists(),
			Bun.file(input.run.programPath).exists(),
			Bun.file(autoBotSignalPath(input.fixture.paths, input.request.nonce, "candidate-ready")).exists(),
			Bun.file(autoBotSignalPath(input.fixture.paths, input.request.nonce, "activate")).exists(),
			Bun.file(autoBotSignalPath(input.fixture.paths, input.request.nonce, "activation-ack")).exists(),
			Bun.file(autoBotSignalPath(input.fixture.paths, input.request.nonce, "promoted")).exists(),
			Bun.file(autoBotSignalPath(input.fixture.paths, input.request.nonce, "normal-exit")).exists(),
		]);
		const ownerIntact =
			committed !== undefined &&
			committed.owner.launchId === input.owner.launchId &&
			committed.owner.bootstrapProcessId === input.owner.bootstrapProcessId &&
			committed.owner.predecessorRuntimeProcessId === input.owner.predecessorRuntimeProcessId;
		const claimChanged =
			committed !== undefined &&
			(committed.claim.launchId !== input.oldClaim.launchId ||
				committed.claim.bootstrapProcessId !== input.oldClaim.bootstrapProcessId);
		const candidatePidState =
			committed === undefined
				? "absent"
				: committed.candidateRuntimeProcessId === input.oldCandidateProcessId
					? "unchanged"
					: "replaced";
		throw new Error(
			`Recovered candidate did not reach authenticated runtime: ${JSON.stringify({
				candidateFixture: input.run.candidate,
				programPresent,
				runtimeEntered,
				evidencePresent,
				gatePresent,
				pendingPresent: pending !== undefined,
				committedRecoveryState: committed?.recoveryState ?? "absent",
				ownerIntact,
				claimChanged,
				candidatePidState,
				candidateReady,
				activation,
				acknowledgement,
				promotion,
				normalExit,
			})}`,
		);
	}
}

async function stopBootstrap(run: BootstrapRun): Promise<void> {
	try {
		await Promise.all([
			Bun.write(run.gatePath, "cleanup"),
			...(run.restartGatePath === undefined ? [] : [Bun.write(run.restartGatePath, "cleanup")]),
			...(run.promotedExitGatePath === undefined ? [] : [Bun.write(run.promotedExitGatePath, "cleanup")]),
			...(run.promotedExitReleaseGatePath === undefined
				? []
				: [Bun.write(run.promotedExitReleaseGatePath, "cleanup")]),
		]);
		await Promise.all([run.bootstrap.exited, run.stderr]);
	} finally {
		activeBootstrapRuns.delete(run);
	}
}

async function releaseBootstrap(run: BootstrapRun): Promise<{ readonly exitCode: number; readonly stderr: string }> {
	await Promise.all([
		Bun.write(run.gatePath, "release"),
		...(run.restartGatePath === undefined ? [] : [Bun.write(run.restartGatePath, "release")]),
		...(run.promotedExitGatePath === undefined ? [] : [Bun.write(run.promotedExitGatePath, "release")]),
		...(run.promotedExitReleaseGatePath === undefined ? [] : [Bun.write(run.promotedExitReleaseGatePath, "release")]),
	]);
	const [exitCode, stderr] = await Promise.all([run.bootstrap.exited, run.stderr]);
	activeBootstrapRuns.delete(run);
	return { exitCode, stderr };
}

function bootstrapFailureSummary(stderr: string): { readonly category: string; readonly stackFrameCount: number } {
	const category = stderr.includes("AutoBot control lock")
		? "lock"
		: stderr.includes("AutoBot normal exit")
			? "normal-exit"
			: stderr.includes("AutoBot promotion")
				? "promotion"
				: stderr.includes("AutoBot handoff")
					? "handoff"
					: stderr.includes("Error")
						? "error"
						: stderr.length === 0
							? "empty"
							: "other";
	return {
		category,
		stackFrameCount: stderr.split(/\r?\n/).filter(line => /^\s*at\s/.test(line)).length,
	};
}

async function assertLaunchLeaseHeld(paths: AutoBotPaths, launchId: string): Promise<void> {
	const competingLease = await acquireAutoBotFileLock(autoBotLaunchLeaseLockPath(paths, launchId), {
		retries: 1,
		retryDelayMs: 0,
		requireExisting: true,
	}).catch(() => undefined);
	if (!competingLease) return;
	try {
		throw new Error("A live AutoBot bootstrap did not retain its unique lifetime lease");
	} finally {
		competingLease.release();
	}
}

function restartRequest(fixture: BootstrapFixture, nonce = fixtureId()): AutoBotRestartRequest {
	return {
		sessionFile: path.join(fixture.root, "session.jsonl"),
		sessionId: "fixture-session",
		cwd: fixture.root,
		context: null,
		target: restartTarget(fixture.candidateManifest),
		predecessorTarget: restartTarget(fixture.activeManifest),
		nonce,
	};
}

function journalMatch(
	record: Pick<AutoBotPendingRestart, "owner" | "claim" | "request" | "runtimePath" | "previousRuntimePath">,
): AutoBotHandoffJournalMatch {
	return {
		owner: record.owner,
		claim: record.claim,
		request: record.request,
		runtimePath: record.runtimePath,
		previousRuntimePath: record.previousRuntimePath,
	};
}

function pendingRestart(
	fixture: BootstrapFixture,
	request: AutoBotRestartRequest,
	owner: AutoBotHandoffOwner,
	claim: AutoBotHandoffClaim,
): AutoBotPendingRestart {
	return {
		schemaVersion: 1,
		request,
		handoffPath: autoBotHandoffPath(fixture.paths, request.nonce),
		runtimePath: fixture.candidateRuntimePath,
		previousRuntimePath: fixture.activeRuntimePath,
		createdAt: fixtureTimestamp,
		owner,
		claim,
	};
}

async function seedCommittedRestart(
	fixture: BootstrapFixture,
	owner: AutoBotHandoffOwner,
	claim: AutoBotHandoffClaim,
	candidateRuntimeProcessId: number,
): Promise<AutoBotCommittedRestart> {
	const request = restartRequest(fixture);
	const pending = pendingRestart(fixture, request, owner, claim);
	await createAutoBotHandoff(fixture.paths, {
		...request,
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		owner,
		role: "candidate",
		runtimePath: fixture.candidateRuntimePath,
		previousRuntimePath: fixture.activeRuntimePath,
		createdAt: fixtureTimestamp,
	});
	const committed: AutoBotCommittedRestart = {
		schemaVersion: 1,
		request,
		runtimePath: pending.runtimePath,
		previousRuntimePath: pending.previousRuntimePath,
		committedAt: fixtureTimestamp,
		owner,
		claim,
		candidateRuntimeProcessId,
		recoveryState: "candidate-running",
	};
	await withAutoBotHandoffLock(fixture.paths, async () => {
		expect(await createAutoBotPendingRestart(fixture.paths, pending)).toBe(true);
		expect(await commitAutoBotPendingRestart(fixture.paths, journalMatch(pending), committed)).toBe(true);
	});
	return committed;
}

async function createDefinitelyDeadProcessId(): Promise<number> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const processHandle = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		await processHandle.exited;
		try {
			process.kill(processHandle.pid, 0);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") return processHandle.pid;
		}
	}
	throw new Error("The fixture could not establish a definitely-dead process identifier");
}

test("launches an authenticated runtime under a unique bootstrap lifetime lease", async () => {
	const fixture = await createBootstrapFixture();
	const run = await startBootstrap(fixture);
	const evidence = await runtimeEvidence(run);

	expect(evidence.authenticated).toBe(true);
	expect(evidence.role).toBe("active");
	expect(evidence.launchId).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
	expect(evidence.launchId).not.toBe("f".repeat(32));
	expect(evidence.bootstrapProcessId).toBe(run.bootstrap.pid);
	expect(evidence.parentProcessId).toBe(run.bootstrap.pid);
	assertLiveLegacyProcess(await fs.realpath(fixture.bootstrapPath), run.bootstrap.pid);
	assertLiveLegacyProcess(await fs.realpath(fixture.activeRuntimePath), evidence.processId);
	await assertLaunchLeaseHeld(fixture.paths, evidence.launchId);

	const result = await releaseBootstrap(run);
	expect(result.exitCode).toBe(0);
	const releasedLease = await acquireAutoBotFileLock(autoBotLaunchLeaseLockPath(fixture.paths, evidence.launchId), {
		retries: 1,
		retryDelayMs: 0,
		requireExisting: true,
	});
	releasedLease.release();
}, 600_000);

test("does not clear foreign pending or committed restart journals after an unrelated normal exit", async () => {
	for (const journalKind of ["pending", "committed"] as const) {
		const fixture = await createBootstrapFixture();
		const run = await startBootstrap(fixture);
		await runtimeEvidence(run);
		const oldProcessId = await createDefinitelyDeadProcessId();
		const owner: AutoBotHandoffOwner = {
			launchId: fixtureId(),
			bootstrapProcessId: oldProcessId,
			predecessorRuntimeProcessId: oldProcessId,
		};
		const claim: AutoBotHandoffClaim = { launchId: owner.launchId, bootstrapProcessId: owner.bootstrapProcessId };
		const expected =
			journalKind === "pending"
				? (() => {
						const pending = pendingRestart(fixture, restartRequest(fixture), owner, claim);
						return { kind: "pending" as const, pending };
					})()
				: {
						kind: "committed" as const,
						committed: await seedCommittedRestart(fixture, owner, claim, oldProcessId),
					};
		if (expected.kind === "pending") {
			await withAutoBotHandoffLock(fixture.paths, async () => {
				expect(await createAutoBotPendingRestart(fixture.paths, expected.pending)).toBe(true);
			});
		}

		const result = await releaseBootstrap(run);
		expect(result.exitCode).toBe(0);
		if (expected.kind === "pending") {
			expect(await readAutoBotPendingRestart(fixture.paths)).toEqual(expected.pending);
		} else {
			expect(await readAutoBotCommittedRestart(fixture.paths)).toEqual(expected.committed);
		}
	}
}, 600_000);

test("returns zero when a promoted runtime exits while a foreign handoff transaction holds the lock", async () => {
	const fixture = await createBootstrapFixture();
	const run = await startBootstrap(fixture, { promoteAndQuit: true });
	const active = await runtimeEvidence(run);
	const owner: AutoBotHandoffOwner = {
		launchId: active.launchId,
		bootstrapProcessId: run.bootstrap.pid,
		predecessorRuntimeProcessId: active.processId,
	};
	const claim: AutoBotHandoffClaim = {
		launchId: active.launchId,
		bootstrapProcessId: run.bootstrap.pid,
	};
	const request = restartRequest(fixture);
	const pending = pendingRestart(fixture, request, owner, claim);
	await createAutoBotHandoff(fixture.paths, {
		...request,
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		owner,
		role: "candidate",
		runtimePath: fixture.candidateRuntimePath,
		previousRuntimePath: fixture.activeRuntimePath,
		createdAt: fixtureTimestamp,
	});
	await withAutoBotHandoffLock(fixture.paths, async () => {
		expect(await createAutoBotPendingRestart(fixture.paths, pending)).toBe(true);
	});

	await Bun.write(run.restartGatePath!, "restart");
	await waitForBootstrapFile(run, run.activationObservedPath!, "candidate activation");
	await Bun.write(run.gatePath, "promote");
	await waitForBootstrapFile(run, run.postAcknowledgementPath!, "candidate post-acknowledgement");
	expect(JSON.parse(await Bun.file(run.postAcknowledgementPath!).text())).toMatchObject({
		authenticatedAfterPromotion: true,
		promotionFailure: { category: "none", errorName: "none", errorCode: "none" },
		journalState: "cleared",
		promotionPresent: true,
		candidateHandoffPresent: true,
	});
	const promoted = JSON.parse(await Bun.file(run.evidencePath).text()) as RuntimeEvidence;
	expect(promoted.role).toBe("candidate");
	expect(promoted.processId).not.toBe(active.processId);
	expect((await readAutoBotActivePointer(fixture.paths))?.runtimePath).toBe(fixture.candidateRuntimePath);

	const foreignBootstrapProcessId = await createDefinitelyDeadProcessId();
	const foreignPredecessorProcessId = await createDefinitelyDeadProcessId();
	const foreignOwner: AutoBotHandoffOwner = {
		launchId: fixtureId(),
		bootstrapProcessId: foreignBootstrapProcessId,
		predecessorRuntimeProcessId: foreignPredecessorProcessId,
	};
	const foreignClaim: AutoBotHandoffClaim = {
		launchId: foreignOwner.launchId,
		bootstrapProcessId: foreignOwner.bootstrapProcessId,
	};
	const foreignRequest = restartRequest(fixture);
	const foreignPending = pendingRestart(fixture, foreignRequest, foreignOwner, foreignClaim);
	await createAutoBotHandoff(fixture.paths, {
		...foreignRequest,
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		owner: foreignOwner,
		role: "candidate",
		runtimePath: fixture.candidateRuntimePath,
		previousRuntimePath: fixture.activeRuntimePath,
		createdAt: fixtureTimestamp,
	});
	await Bun.write(run.promotedExitGatePath!, "request normal exit");
	await waitForBootstrapFile(run, run.promotedExitIntentPath!, "promoted normal-exit intent");
	const holder = await startForeignHandoffLockHolder(fixture, foreignPending);
	let bootstrapExitCode: number | undefined;
	let bootstrapStderr = "";
	let nativeExitCode: number | "absent" | "invalid" = "absent";
	let holderWasLive = false;
	let foreignPendingDigest: string | undefined;
	try {
		await awaitForeignHandoffLockHolder(holder);
		foreignPendingDigest = await sha256File(fixture.paths.pendingRestartPath);
		holderWasLive = Process.fromPath(await fs.realpath(process.execPath)).some(
			candidate => candidate.pid === holder.process.pid && candidate.status() === ProcessStatus.Running,
		);
		await Bun.write(run.promotedExitReleaseGatePath!, "allow native exit");
		[bootstrapExitCode, bootstrapStderr] = await Promise.all([run.bootstrap.exited, run.stderr]);
		activeBootstrapRuns.delete(run);
		if (await Bun.file(run.promotedExitEvidencePath!).exists()) {
			const nativeExit = JSON.parse(await Bun.file(run.promotedExitEvidencePath!).text()) as {
				readonly nativeExitCode?: unknown;
			};
			nativeExitCode = typeof nativeExit.nativeExitCode === "number" ? nativeExit.nativeExitCode : "invalid";
		}
	} finally {
		await stopForeignHandoffLockHolder(holder);
	}
	const foreignPendingPresent = await Bun.file(fixture.paths.pendingRestartPath).exists();
	const foreignPendingDigestMatches =
		foreignPendingPresent &&
		foreignPendingDigest !== undefined &&
		(await sha256File(fixture.paths.pendingRestartPath)) === foreignPendingDigest;
	const foreignCommittedPresent = await Bun.file(fixture.paths.committedRestartPath).exists();
	if (
		bootstrapExitCode !== 0 ||
		nativeExitCode !== 0 ||
		!holderWasLive ||
		!foreignPendingDigestMatches ||
		foreignCommittedPresent
	) {
		throw new Error(
			`Promoted runtime exit under a foreign handoff lock failed: ${JSON.stringify({
				nativeExitCode,
				bootstrapExitCode: bootstrapExitCode ?? "absent",
				holderWasLive,
				failure: bootstrapFailureSummary(bootstrapStderr),
				foreignPendingPresent,
				foreignPendingDigestMatches,
				foreignCommittedPresent,
			})}`,
		);
	}
	expect(foreignPendingPresent).toBe(true);
	expect(foreignPendingDigestMatches).toBe(true);
	expect(foreignCommittedPresent).toBe(false);
}, 600_000);

test("refuses a live owner lease then CAS-reclaims a safely abandoned committed candidate", async () => {
	const fixture = await createBootstrapFixture();
	const oldBootstrapProcessId = await createDefinitelyDeadProcessId();
	const oldPredecessorProcessId = await createDefinitelyDeadProcessId();
	const oldCandidateProcessId = await createDefinitelyDeadProcessId();
	const owner: AutoBotHandoffOwner = {
		launchId: fixtureId(),
		bootstrapProcessId: oldBootstrapProcessId,
		predecessorRuntimeProcessId: oldPredecessorProcessId,
	};
	const oldClaim: AutoBotHandoffClaim = { launchId: owner.launchId, bootstrapProcessId: owner.bootstrapProcessId };
	const committed = await seedCommittedRestart(fixture, owner, oldClaim, oldCandidateProcessId);
	await writeAutoBotCandidateReady(fixture.paths, {
		protocolVersion: AUTO_BOT_HANDOFF_PROTOCOL_VERSION,
		nonce: committed.request.nonce,
		releaseSequence: committed.request.target.releaseSequence,
		compatibilityEpoch: committed.request.target.compatibilityEpoch,
		sessionFile: committed.request.sessionFile,
		sessionId: committed.request.sessionId,
	});
	await writeAutoBotActivation(fixture.paths, committed.request);
	await writeAutoBotActivationAcknowledgement(fixture.paths, committed.request);

	const leasePath = autoBotLaunchLeaseLockPath(fixture.paths, oldClaim.launchId);
	let blockedGatePath: string | undefined;
	const liveOwnerLease = await acquireAutoBotFileLock(leasePath);
	try {
		const blocked = await startBootstrap(fixture);
		blockedGatePath = blocked.gatePath;
		const [blockedExitCode] = await Promise.all([blocked.bootstrap.exited, blocked.stderr]);
		activeBootstrapRuns.delete(blocked);
		expect(blockedExitCode).toBe(1);
		expect(await Bun.file(blocked.evidencePath).exists()).toBeFalse();
		expect(await Bun.file(blocked.gatePath).exists()).toBeFalse();
		expect(await readAutoBotCommittedRestart(fixture.paths)).toEqual(committed);
	} finally {
		liveOwnerLease.release();
	}

	const recovered = await startBootstrap(fixture, { candidate: true });
	expect(blockedGatePath).toBeDefined();
	expect(recovered.gatePath).not.toBe(blockedGatePath);
	expect(await Bun.file(recovered.gatePath).exists()).toBeFalse();
	const evidence = await recoveredRuntimeEvidence({
		fixture,
		run: recovered,
		request: committed.request,
		owner,
		oldClaim,
		oldCandidateProcessId,
	});
	expect(evidence.role).toBe("candidate");
	expect(evidence.bootstrapProcessId).toBe(recovered.bootstrap.pid);
	expect(evidence.parentProcessId).toBe(recovered.bootstrap.pid);
	await waitForFile(recovered.activationObservedPath!);

	const claimed = await readAutoBotCommittedRestart(fixture.paths);
	expect(claimed?.owner).toEqual(owner);
	expect(claimed?.claim).toEqual({
		launchId: evidence.launchId,
		bootstrapProcessId: recovered.bootstrap.pid,
	});
	expect(claimed?.claim).not.toEqual(oldClaim);
	expect(claimed?.candidateRuntimeProcessId).toBe(evidence.processId);
	expect(claimed?.recoveryState).toBe("candidate-running");
	expect(
		await Bun.file(autoBotSignalPath(fixture.paths, committed.request.nonce, "activation-ack")).exists(),
	).toBeFalse();

	const result = await releaseBootstrap(recovered);
	await waitForFile(recovered.postAcknowledgementPath!);
	expect(JSON.parse(await Bun.file(recovered.postAcknowledgementPath!).text())).toMatchObject({
		authenticatedAfterPromotion: true,
		promotionFailure: { category: "none", errorName: "none", errorCode: "none" },
		journalState: "cleared",
		promotionPresent: true,
		candidateHandoffPresent: true,
	});
	expect(result.exitCode).toBe(0);
	expect(await readAutoBotCommittedRestart(fixture.paths)).toBeUndefined();
}, 600_000);

test(
	"refuses a live legacy launcher before publishing a managed bootstrap",
	async () => {
		const root = await createPrivateRoot();
		const keyDirectory = await createTemporaryDirectory("omp-autobot-install-key-");
		const legacyPath = path.join(root, legacyExecutableName());
		await fs.copyFile(process.execPath, legacyPath);
		if (process.platform !== "win32") await fs.chmod(legacyPath, 0o700);
		const legacyDigest = await sha256File(legacyPath);
		const trustedKeyPath = await createTrustedPublicKey(keyDirectory);
		const legacyProcess: LegacyProcess = Bun.spawn([legacyPath, "-e", legacyProcessProgram], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});

		try {
			await awaitLegacyProcessReady(legacyProcess);
			assertLiveLegacyProcess(await fs.realpath(legacyPath), legacyProcess.pid);
			const result = await runInstaller([
				"--root",
				root,
				"--migrate-legacy",
				"--channel-url",
				"https://releases.example.invalid/envelope.json",
				"--trusted-key",
				`current=${trustedKeyPath}`,
				"--portal-url",
				"https://collab.example.invalid/live",
			]);

			expect(result.exitCode).toBe(1);
			expect(await sha256File(legacyPath)).toBe(legacyDigest);
			expect(await fs.readdir(root)).toEqual([legacyExecutableName()]);
		} finally {
			await stopProcess(legacyProcess);
		}
	},
	process.platform === "win32" ? 120_000 : undefined,
);

test("rejects unsafe artifact origins before creating installation state", async () => {
	const keyDirectory = await createTemporaryDirectory("omp-autobot-install-key-");
	const trustedKeyPath = await createTrustedPublicKey(keyDirectory);

	for (const artifactOrigin of [
		"https://release-assets.githubusercontent.com/?signed=1",
		"https://credential@release-assets.githubusercontent.com/",
	]) {
		const root = path.join(await createTemporaryDirectory("omp-autobot-install-origin-"), "root");
		const result = await runInstaller([
			"--root",
			root,
			"--channel-url",
			"https://releases.example.invalid/envelope.json",
			"--trusted-key",
			`current=${trustedKeyPath}`,
			"--portal-url",
			"https://collab.example.invalid/live",
			"--artifact-origin",
			artifactOrigin,
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).not.toContain(artifactOrigin);
		expect(await Bun.file(root).exists()).toBeFalse();
	}
});

test.skipIf(process.platform === "win32")(
	"defers tightening an integrity-safe inherited legacy root until live users stop",
	async () => {
		const root = await createPosixInheritedRoot();
		const keyDirectory = await createTemporaryDirectory("omp-autobot-install-key-");
		const legacyPath = path.join(root, legacyExecutableName());
		await fs.copyFile(process.execPath, legacyPath);
		await fs.chmod(legacyPath, 0o755);
		const trustedKeyPath = await createTrustedPublicKey(keyDirectory);
		const legacyProcess: LegacyProcess = Bun.spawn([legacyPath, "-e", legacyProcessProgram], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});

		try {
			await awaitLegacyProcessReady(legacyProcess);
			assertLiveLegacyProcess(await fs.realpath(legacyPath), legacyProcess.pid);
			const result = await runInstaller([
				"--root",
				root,
				"--migrate-legacy",
				"--channel-url",
				"https://releases.example.invalid/envelope.json",
				"--trusted-key",
				`current=${trustedKeyPath}`,
				"--portal-url",
				"https://collab.example.invalid/live",
			]);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Refusing legacy migration while omp users or workers are live");
			expect((await fs.stat(root)).mode & 0o777).toBe(0o755);
			expect((await fs.stat(legacyPath)).mode & 0o777).toBe(0o755);
			expect(await Bun.file(path.join(root, ".autobot")).exists()).toBeFalse();
			expect(await fs.readdir(root)).toEqual([legacyExecutableName()]);
		} finally {
			await stopProcess(legacyProcess);
		}
	},
);

test.skipIf(process.platform === "win32")("refuses writable legacy roots before normalizing them", async () => {
	const root = await createPosixInheritedRoot();
	const keyDirectory = await createTemporaryDirectory("omp-autobot-install-key-");
	await fs.chmod(root, 0o777);
	const legacyPath = path.join(root, legacyExecutableName());
	await fs.copyFile(process.execPath, legacyPath);
	await fs.chmod(legacyPath, 0o755);
	const trustedKeyPath = await createTrustedPublicKey(keyDirectory);
	const result = await runInstaller([
		"--root",
		root,
		"--migrate-legacy",
		"--channel-url",
		"https://releases.example.invalid/envelope.json",
		"--trusted-key",
		`current=${trustedKeyPath}`,
		"--portal-url",
		"https://collab.example.invalid/live",
	]);

	expect(result.exitCode).toBe(1);
	expect((await fs.stat(root)).mode & 0o777).toBe(0o777);
	expect((await fs.stat(legacyPath)).mode & 0o777).toBe(0o755);
	expect(await Bun.file(path.join(root, ".autobot")).exists()).toBeFalse();
	expect(await fs.readdir(root)).toEqual([legacyExecutableName()]);
});
