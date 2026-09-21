import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { withAutoBotFileLock } from "./lock";
import { parseAutoBotLaunchRelease, parseAutoBotReleaseManifest, type AutoBotLaunchRelease } from "./contract";
import { autoBotPaths, pathIsInside, type AutoBotPaths } from "./paths";
import { equalSecret, ensurePrivateDirectory, readJsonIfPresent, writeJsonAtomically } from "./storage";

export const AUTO_BOT_ENV = {
	root: "OMP_AUTOBOT_ROOT",
	installId: "OMP_AUTOBOT_INSTALL_ID",
	supervisorToken: "OMP_AUTOBOT_SUPERVISOR_TOKEN",
	managed: "OMP_AUTOBOT_MANAGED",
	runtimePath: "OMP_AUTOBOT_RUNTIME_PATH",
	pinnedRuntimePath: "OMP_AUTOBOT_PINNED_RUNTIME_PATH",
	role: "OMP_AUTOBOT_ROLE",
	handoffFile: "OMP_AUTOBOT_HANDOFF_FILE",
	handoffNonce: "OMP_AUTOBOT_HANDOFF_NONCE",
	launchId: "OMP_AUTOBOT_LAUNCH_ID",
	bootstrapProcessId: "OMP_AUTOBOT_BOOTSTRAP_PROCESS_ID",
	releaseSequence: "OMP_AUTOBOT_RELEASE_SEQUENCE",
	releaseVersion: "OMP_AUTOBOT_RELEASE_VERSION",
	forkCommit: "OMP_AUTOBOT_RELEASE_FORK_COMMIT",
	sessionFormatVersion: "OMP_AUTOBOT_RELEASE_SESSION_FORMAT_VERSION",
	collabProtocolVersion: "OMP_AUTOBOT_RELEASE_COLLAB_PROTOCOL_VERSION",
	compatibilityEpoch: "OMP_AUTOBOT_RELEASE_COMPATIBILITY_EPOCH",
	webBundleId: "OMP_AUTOBOT_RELEASE_WEB_BUNDLE_ID",
	collabWebUrl: "OMP_SESSION_COLLAB_WEB_URL",
} as const;

/** Bun dotenv treats empty strings as missing; this nonempty value reserves absent claims. */
export const AUTO_BOT_ENV_ABSENT = "__OMP_AUTOBOT_ABSENT__";

export interface AutoBotInstallationIdentity {
	readonly schemaVersion: 1;
	readonly installId: string;
	/** Local bootstrap-to-runtime capability, never logged or serialized into a session. */
	readonly supervisorSecret: string;
	readonly createdAt: string;
}

const InstallationIdentitySchema = type({
	schemaVersion: "1",
	installId: "string > 0",
	supervisorSecret: "string > 0",
	createdAt: "string > 0",
});

function parseInstallationIdentity(value: unknown): AutoBotInstallationIdentity {
	const identity = InstallationIdentitySchema.assert(value);
	if (!/^[A-Za-z0-9_-]{16,128}$/.test(identity.installId)) throw new Error("Invalid AutoBot installation identity");
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(identity.supervisorSecret))
		throw new Error("Invalid AutoBot installation secret");
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(identity.createdAt)) {
		throw new Error("Invalid AutoBot installation timestamp");
	}
	return identity;
}

function makeInstallationIdentity(): AutoBotInstallationIdentity {
	return {
		schemaVersion: 1,
		installId: randomBytes(16).toString("base64url"),
		supervisorSecret: randomBytes(32).toString("base64url"),
		createdAt: new Date().toISOString(),
	};
}

export async function readAutoBotInstallationIdentity(
	paths: AutoBotPaths,
): Promise<AutoBotInstallationIdentity | undefined> {
	const raw = await readJsonIfPresent(paths.identityPath);
	return raw === undefined ? undefined : parseInstallationIdentity(raw);
}

/** The bootstrap needs this before importing regular runtime code or loading dotenv. */
export function readAutoBotInstallationIdentitySync(paths: AutoBotPaths): AutoBotInstallationIdentity | undefined {
	try {
		return parseInstallationIdentity(JSON.parse(fs.readFileSync(paths.identityPath, "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export async function ensureAutoBotInstallationIdentity(paths: AutoBotPaths): Promise<AutoBotInstallationIdentity> {
	await ensurePrivateDirectory(paths.root);
	await ensurePrivateDirectory(paths.controlDir);
	await ensurePrivateDirectory(paths.lockDir);
	return withAutoBotFileLock(paths.identityLockPath, async () => {
		const current = await readAutoBotInstallationIdentity(paths);
		if (current) return current;
		const created = makeInstallationIdentity();
		await writeJsonAtomically(paths.identityPath, created);
		return created;
	});
}

export interface AuthenticatedAutoBotEnvironment {
	readonly paths: AutoBotPaths;
	readonly identity: AutoBotInstallationIdentity;
	readonly runtimePath: string;
	readonly role: "active" | "candidate" | "fallback";
	readonly launchRelease: AutoBotLaunchRelease;
	readonly handoffFile?: string;
	/** Authenticated identity of the stable bootstrap supervising this runtime. */
	readonly launchId: string;
	readonly bootstrapProcessId: number;
	readonly handoffNonce?: string;
}

function readAuthenticatedLaunchRelease(): AutoBotLaunchRelease | undefined {
	const positiveInteger = (name: keyof typeof AUTO_BOT_ENV): number | undefined => {
		const value = process.env[AUTO_BOT_ENV[name]];
		if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	};
	const releaseSequence = positiveInteger("releaseSequence");
	const sessionFormatVersion = positiveInteger("sessionFormatVersion");
	const collabProtocolVersion = positiveInteger("collabProtocolVersion");
	const compatibilityEpoch = positiveInteger("compatibilityEpoch");
	const upstreamVersion = process.env[AUTO_BOT_ENV.releaseVersion];
	const forkCommit = process.env[AUTO_BOT_ENV.forkCommit];
	const webBundleId = process.env[AUTO_BOT_ENV.webBundleId];
	if (
		releaseSequence === undefined ||
		sessionFormatVersion === undefined ||
		collabProtocolVersion === undefined ||
		compatibilityEpoch === undefined ||
		!upstreamVersion ||
		!forkCommit ||
		!webBundleId
	) {
		return undefined;
	}
	try {
		return parseAutoBotLaunchRelease({
			releaseSequence,
			upstreamVersion,
			forkCommit,
			sessionFormatVersion,
			collabProtocolVersion,
			compatibilityEpoch,
			webBundleId,
		});
	} catch {
		return undefined;
	}
}

function launchReleaseMatchesPinnedRuntime(launchRelease: AutoBotLaunchRelease, runtimePath: string): boolean {
	try {
		const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(runtimePath), "release.json"), "utf8")) as {
			readonly manifest?: unknown;
		};
		const manifest = parseAutoBotReleaseManifest(marker.manifest);
		return (
			manifest.releaseSequence === launchRelease.releaseSequence &&
			manifest.upstreamVersion === launchRelease.upstreamVersion &&
			manifest.forkCommit === launchRelease.forkCommit &&
			manifest.sessionFormatVersion === launchRelease.sessionFormatVersion &&
			manifest.collabProtocolVersion === launchRelease.collabProtocolVersion &&
			manifest.compatibilityEpoch === launchRelease.compatibilityEpoch &&
			manifest.webBundleId === launchRelease.webBundleId
		);
	} catch {
		return false;
	}
}

/**
 * Accept supervision only when the launcher proves it knows a random secret
 * held in the installation state and pins this process to that managed slot.
 * Project/home dotenv values alone cannot satisfy this capability check.
 */
export function readAuthenticatedAutoBotEnvironment(): AuthenticatedAutoBotEnvironment | undefined {
	const root = process.env[AUTO_BOT_ENV.root];
	const installId = process.env[AUTO_BOT_ENV.installId];
	const supervisorSecret = process.env[AUTO_BOT_ENV.supervisorToken];
	const runtimePath = process.env[AUTO_BOT_ENV.runtimePath];
	const roleValue = process.env[AUTO_BOT_ENV.role];
	const launchId = process.env[AUTO_BOT_ENV.launchId];
	const bootstrapProcessIdText = process.env[AUTO_BOT_ENV.bootstrapProcessId];
	const bootstrapProcessId =
		bootstrapProcessIdText && /^[1-9]\d*$/.test(bootstrapProcessIdText) ? Number(bootstrapProcessIdText) : undefined;
	if (
		!root ||
		!path.isAbsolute(root) ||
		!installId ||
		!supervisorSecret ||
		!runtimePath ||
		process.env[AUTO_BOT_ENV.managed] !== "1" ||
		(roleValue !== "active" && roleValue !== "candidate" && roleValue !== "fallback")
	) {
		return undefined;
	}
	if (
		!launchId ||
		!/^[A-Za-z0-9_-]{32,128}$/.test(launchId) ||
		bootstrapProcessId === undefined ||
		!Number.isSafeInteger(bootstrapProcessId) ||
		process.ppid !== bootstrapProcessId
	) {
		return undefined;
	}

	const paths = autoBotPaths(root);
	if (!pathIsInside(paths.root, runtimePath) || path.resolve(runtimePath) !== path.resolve(process.execPath))
		return undefined;
	let identity: AutoBotInstallationIdentity | undefined;
	try {
		identity = readAutoBotInstallationIdentitySync(paths);
	} catch {
		return undefined;
	}
	if (!identity || identity.installId !== installId || !equalSecret(identity.supervisorSecret, supervisorSecret))
		return undefined;
	const launchRelease = readAuthenticatedLaunchRelease();
	if (!launchRelease) return undefined;
	if (!launchReleaseMatchesPinnedRuntime(launchRelease, path.resolve(runtimePath))) return undefined;
	const rawHandoffFile = process.env[AUTO_BOT_ENV.handoffFile];
	const rawHandoffNonce = process.env[AUTO_BOT_ENV.handoffNonce];
	const handoffFile = rawHandoffFile === AUTO_BOT_ENV_ABSENT ? undefined : rawHandoffFile || undefined;
	const handoffNonce = rawHandoffNonce === AUTO_BOT_ENV_ABSENT ? undefined : rawHandoffNonce || undefined;
	if (roleValue === "active") {
		if (rawHandoffFile !== AUTO_BOT_ENV_ABSENT || rawHandoffNonce !== AUTO_BOT_ENV_ABSENT) return undefined;
	} else if (
		!handoffFile ||
		!handoffNonce ||
		!pathIsInside(paths.handoffDir, handoffFile) ||
		!new RegExp(`^${handoffNonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:candidate|fallback)\\.json$`).test(
			path.basename(handoffFile),
		)
	) {
		return undefined;
	}

	return {
		paths,
		identity,
		runtimePath: path.resolve(runtimePath),
		role: roleValue,
		launchId,
		bootstrapProcessId,
		...(handoffFile ? { handoffFile: path.resolve(handoffFile) } : {}),
		...(handoffNonce ? { handoffNonce } : {}),
		launchRelease,
	};
}

/** Set every reserved variable so a later dotenv load cannot fill omitted claims. */
export function autoBotReservedEnvironment(input: {
	readonly paths: AutoBotPaths;
	readonly identity: AutoBotInstallationIdentity;
	readonly runtimePath: string;
	readonly role: "active" | "candidate" | "fallback";
	readonly launchId: string;
	readonly bootstrapProcessId: number;
	readonly handoffFile?: string;
	readonly handoffNonce?: string;
	readonly releaseSequence?: number;
	readonly releaseVersion?: string;
	readonly forkCommit?: string;
	readonly sessionFormatVersion?: number;
	readonly collabProtocolVersion?: number;
	readonly compatibilityEpoch?: number;
	readonly webBundleId?: string;
	readonly collabWebUrl?: string;
}): Record<string, string> {
	if (
		!/^[A-Za-z0-9_-]{32,128}$/.test(input.launchId) ||
		!Number.isSafeInteger(input.bootstrapProcessId) ||
		input.bootstrapProcessId <= 0
	) {
		throw new Error("Invalid authenticated AutoBot bootstrap launch identity");
	}
	return {
		[AUTO_BOT_ENV.root]: input.paths.root,
		[AUTO_BOT_ENV.installId]: input.identity.installId,
		[AUTO_BOT_ENV.supervisorToken]: input.identity.supervisorSecret,
		[AUTO_BOT_ENV.managed]: "1",
		[AUTO_BOT_ENV.runtimePath]: input.runtimePath,
		[AUTO_BOT_ENV.pinnedRuntimePath]: input.runtimePath,
		[AUTO_BOT_ENV.role]: input.role,
		[AUTO_BOT_ENV.handoffFile]: input.handoffFile ?? AUTO_BOT_ENV_ABSENT,
		[AUTO_BOT_ENV.handoffNonce]: input.handoffNonce ?? AUTO_BOT_ENV_ABSENT,
		[AUTO_BOT_ENV.launchId]: input.launchId,
		[AUTO_BOT_ENV.bootstrapProcessId]: String(input.bootstrapProcessId),
		[AUTO_BOT_ENV.releaseSequence]:
			input.releaseSequence === undefined ? AUTO_BOT_ENV_ABSENT : String(input.releaseSequence),
		[AUTO_BOT_ENV.releaseVersion]: input.releaseVersion ?? AUTO_BOT_ENV_ABSENT,
		[AUTO_BOT_ENV.forkCommit]: input.forkCommit ?? AUTO_BOT_ENV_ABSENT,
		[AUTO_BOT_ENV.sessionFormatVersion]:
			input.sessionFormatVersion === undefined ? AUTO_BOT_ENV_ABSENT : String(input.sessionFormatVersion),
		[AUTO_BOT_ENV.collabProtocolVersion]:
			input.collabProtocolVersion === undefined ? AUTO_BOT_ENV_ABSENT : String(input.collabProtocolVersion),
		[AUTO_BOT_ENV.compatibilityEpoch]:
			input.compatibilityEpoch === undefined ? AUTO_BOT_ENV_ABSENT : String(input.compatibilityEpoch),
		[AUTO_BOT_ENV.webBundleId]: input.webBundleId ?? AUTO_BOT_ENV_ABSENT,
		[AUTO_BOT_ENV.collabWebUrl]: input.collabWebUrl ?? AUTO_BOT_ENV_ABSENT,
	};
}
