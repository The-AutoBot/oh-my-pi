#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
} from "../packages/coding-agent/src/autobot-update/contract.ts";
import { currentAutoBotRuntimeTarget } from "../packages/coding-agent/src/autobot-update/platform.ts";
import {
	AutoBotReleaseError,
	assertKnownOptions,
	hasOption,
	parseCliArgs,
	requiredOption,
} from "./autobot-release-common.ts";
import { assertAutoBotRuntimeTarget } from "./autobot-release-targets.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const bootstrapEntrypoint = path.join(repositoryRoot, "packages", "coding-agent", "src", "autobot-bootstrap.ts");

const helpText = `Usage: bun scripts/autobot-build-bootstrap.ts --target <signed-platform-id> --out <file>

Build the immutable AutoBot bootstrap for one signed release target.

Required options:
  --target <id>  One of darwin-{arm64,x64}, linux-{arm64,x64},
                 linux-musl-{arm64,x64}, or win32-{arm64,x64}.
  --out <file>   New output file. Windows targets require a .exe filename.

The builder never reads release trust from dotenv or bunfig. When an exact
compiler Bun is supplied by the release workflow, set AUTOBOT_COMPILER_BUN to
its absolute path.`;

function isEnoent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function compileTarget(target: string): Bun.Build.CompileTarget {
	assertAutoBotRuntimeTarget(target);
	switch (target) {
		case "darwin-arm64":
			return "bun-darwin-arm64";
		case "darwin-x64":
			return "bun-darwin-x64";
		case "linux-arm64":
			return "bun-linux-arm64";
		case "linux-musl-arm64":
			return "bun-linux-arm64-musl";
		case "linux-musl-x64":
			return "bun-linux-x64-baseline-musl";
		case "linux-x64":
			return "bun-linux-x64-baseline";
		case "win32-arm64":
			return "bun-windows-arm64";
		case "win32-x64":
			return "bun-windows-x64-baseline";
	}
	throw new AutoBotReleaseError(`Unsupported AutoBot bootstrap target: ${target}`);
}

function configuredCompiler(): string | undefined {
	const configured = Bun.env.AUTOBOT_COMPILER_BUN ?? Bun.env.BUN_COMPILE_EXECUTABLE_PATH;
	if (!configured) return undefined;
	if (!path.isAbsolute(configured)) {
		throw new AutoBotReleaseError("Configured AutoBot compiler Bun path must be absolute");
	}
	return path.resolve(configured);
}

function reportBuildError(error: unknown): void {
	const detail = error instanceof Error ? error.message : "non-error value";
	process.stderr.write(`AutoBot bootstrap build failed: ${detail}\n`);
}

async function requireRegularFile(filePath: string, label: string): Promise<void> {
	let stat;
	try {
		stat = await fs.lstat(filePath);
	} catch (error) {
		if (isEnoent(error)) throw new AutoBotReleaseError(`${label} does not exist: ${filePath}`);
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new AutoBotReleaseError(`${label} must be a regular file: ${filePath}`);
}

async function prepareOutput(target: string, requestedOutput: string): Promise<string> {
	const output = path.resolve(requestedOutput);
	const windowsTarget = target.startsWith("win32-");
	if (windowsTarget !== output.toLowerCase().endsWith(".exe")) {
		throw new AutoBotReleaseError(
			windowsTarget
				? "Windows AutoBot bootstrap output must end in .exe"
				: "Non-Windows AutoBot bootstrap output must not end in .exe",
		);
	}
	try {
		await fs.lstat(output);
		throw new AutoBotReleaseError(`Refusing to overwrite existing bootstrap output: ${output}`);
	} catch (error) {
		if (error instanceof AutoBotReleaseError) throw error;
		if (!isEnoent(error)) throw error;
	}
	await fs.mkdir(path.dirname(output), { recursive: true });
	return output;
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2), ["help"]);
	assertKnownOptions(args, ["help", "target", "out"]);
	if (hasOption(args, "help")) {
		if (args.flags.size !== 1) throw new AutoBotReleaseError("--help cannot be combined with other options");
		process.stdout.write(`${helpText}\n`);
		return;
	}

	const target = requiredOption(args, "target");
	const nativeTarget = compileTarget(target);
	const output = await prepareOutput(target, requiredOption(args, "out"));
	await requireRegularFile(bootstrapEntrypoint, "AutoBot bootstrap entrypoint");
	const compilerExecutable = configuredCompiler();
	if (compilerExecutable) {
		await requireRegularFile(compilerExecutable, "Configured AutoBot compiler Bun");
		const compilerHostTarget = currentAutoBotRuntimeTarget();
		if (compilerHostTarget !== target) {
			throw new AutoBotReleaseError(
				`Configured compiler host target ${compilerHostTarget} does not match requested bootstrap target ${target}`,
			);
		}
	}
	const embeddedIdentity = JSON.stringify({
		schemaVersion: AUTO_BOT_RELEASE_SCHEMA_VERSION,
		bootstrapVersion: AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
		target,
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
	});

	const build = await Bun.build({
		entrypoints: [bootstrapEntrypoint],
		root: repositoryRoot,
		target: "bun",
		format: "esm",
		define: {
			OMP_AUTOBOT_BOOTSTRAP_IDENTITY: JSON.stringify(embeddedIdentity),
		},
		minify: {
			syntax: true,
			whitespace: true,
			identifiers: true,
			keepNames: true,
		},
		compile: {
			...(compilerExecutable ? { executablePath: compilerExecutable } : { target: nativeTarget }),
			outfile: output,
			// A stable bootstrap derives authority only from its compiled executable
			// and protected installation state, never a workspace config file.
			autoloadBunfig: false,
			autoloadDotenv: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
		},
		throw: false,
	});
	if (!build.success) {
		throw new AutoBotReleaseError(
			`AutoBot bootstrap compilation failed:\n${build.logs.map(log => log.message).join("\n")}`,
		);
	}
	await requireRegularFile(output, "Compiled AutoBot bootstrap");
	process.stdout.write(`Built AutoBot bootstrap ${target} at ${output}\n`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		reportBuildError(error);
		process.exitCode = 1;
	}
}
