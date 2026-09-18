import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Per-PC values from `$HOME/.env`. The authenticated launcher owns the
 * collaboration URL, so it is deliberately not part of this allowlist.
 */
export const SHARED_SESSION_BUS_ENVIRONMENT_NAMES = [
	"OMP_SESSION_AUTO_COLLAB",
	"OMP_SESSION_BUS_ALLOW_STEER",
	"OMP_SESSION_BUS_ENDPOINT",
	"OMP_SESSION_BUS_MACHINE_KEY",
	"OMP_SESSION_BUS_PC_ID",
] as const;

/** The only values a selected workspace may contribute to a managed launch. */
export const PROJECT_SESSION_BUS_ENVIRONMENT_NAMES = ["OMP_SESSION_BUS_ROLE", "OMP_SESSION_BUS_NAME"] as const;

const MANAGED_SESSION_ENVIRONMENT_NAMES = [
	...SHARED_SESSION_BUS_ENVIRONMENT_NAMES,
	...PROJECT_SESSION_BUS_ENVIRONMENT_NAMES,
] as const;
const MAX_MANAGED_SESSION_ENVIRONMENT_BYTES = 1_048_576;

type ManagedSessionEnvironmentName = (typeof MANAGED_SESSION_ENVIRONMENT_NAMES)[number];
type Environment = Record<string, string | undefined>;
type EnvironmentSnapshot = Readonly<Environment>;

export interface LoadManagedSessionEnvironmentOptions {
	/** Test-only override; production reads `$HOME/.env`. */
	readonly homeDirectory?: string;
	/** Test-only override; production reads the final selected working directory. */
	readonly projectDirectory?: string;
	/** Test-only override; production updates the current process environment. */
	readonly environment?: NodeJS.ProcessEnv;
	/**
	 * Test-only launch snapshot. Production uses the snapshot captured before
	 * ordinary dotenv initialization, so a workspace file cannot impersonate an
	 * inherited routing or credential setting.
	 */
	readonly launchEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

function environmentValue(environment: EnvironmentSnapshot, name: string): string | undefined {
	const direct = environment[name];
	if (direct !== undefined || process.platform !== "win32") return direct;
	const foldedName = name.toUpperCase();
	for (const [key, value] of Object.entries(environment)) {
		if (key.toUpperCase() === foldedName) return value;
	}
	return undefined;
}

function snapshotLaunchEnvironment(environment: EnvironmentSnapshot): Readonly<Record<ManagedSessionEnvironmentName, string | undefined>> {
	const snapshot = Object.create(null) as Record<ManagedSessionEnvironmentName, string | undefined>;
	for (const name of MANAGED_SESSION_ENVIRONMENT_NAMES) {
		snapshot[name] = environmentValue(environment, name);
	}
	return snapshot;
}

// This module must load before the regular dotenv module. The later loader call
// uses this provenance to remove any workspace values that ordinary dotenv
// initialization may have already observed.
const managedSessionLaunchEnvironment = snapshotLaunchEnvironment(process.env);

function hasEnvironmentValue(value: string | undefined): value is string {
	return value !== undefined && value.length > 0;
}

function readDotenvFile(filePath: string): Record<string, string> {
	try {
		const metadata = fs.statSync(filePath);
		if (!metadata.isFile() || metadata.size > MAX_MANAGED_SESSION_ENVIRONMENT_BYTES) return {};
		const source = fs.readFileSync(filePath, "utf8");
		if (Buffer.byteLength(source, "utf8") > MAX_MANAGED_SESSION_ENVIRONMENT_BYTES) return {};
		return parseEnv(source);
	} catch {
		return {};
	}
}

function clearEnvironmentValue(environment: Environment, name: string): void {
	delete environment[name];
	if (process.platform !== "win32") return;
	const foldedName = name.toUpperCase();
	for (const key of Object.keys(environment)) {
		if (key.toUpperCase() === foldedName) delete environment[key];
	}
}

function applyEnvironmentValues(
	names: readonly ManagedSessionEnvironmentName[],
	values: Record<string, string>,
	environment: Environment,
	launchEnvironment: EnvironmentSnapshot,
): void {
	for (const name of names) {
		const launchValue = environmentValue(launchEnvironment, name);
		if (hasEnvironmentValue(launchValue)) {
			clearEnvironmentValue(environment, name);
			environment[name] = launchValue;
			continue;
		}
		clearEnvironmentValue(environment, name);
		const value = values[name];
		if (hasEnvironmentValue(value) && !/[\0\r\n]/u.test(value)) environment[name] = value;
	}
}

/**
 * Restore trusted launch values, then load per-PC settings from `$HOME/.env`
 * and role/name from only the final selected workspace. It is deliberately
 * silent: missing, unreadable, oversized, and malformed dotenv files simply
 * contribute no values.
 */
export function loadManagedSessionEnvironment(options: LoadManagedSessionEnvironmentOptions = {}): void {
	const environment = options.environment ?? process.env;
	const launchEnvironment = options.launchEnvironment ?? managedSessionLaunchEnvironment;
	const homeValues = readDotenvFile(join(options.homeDirectory ?? homedir(), ".env"));
	const projectValues = readDotenvFile(join(options.projectDirectory ?? process.cwd(), ".env"));
	applyEnvironmentValues(SHARED_SESSION_BUS_ENVIRONMENT_NAMES, homeValues, environment, launchEnvironment);
	applyEnvironmentValues(PROJECT_SESSION_BUS_ENVIRONMENT_NAMES, projectValues, environment, launchEnvironment);
}
