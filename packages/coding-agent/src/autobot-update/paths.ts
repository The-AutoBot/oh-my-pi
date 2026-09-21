import * as fs from "node:fs";
import * as path from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;

export interface AutoBotPaths {
	readonly root: string;
	readonly controlDir: string;
	readonly runtimeDir: string;
	readonly bootstrapDir: string;
	readonly channelConfigPath: string;
	readonly identityPath: string;
	readonly activePointerPath: string;
	readonly highWaterPath: string;
	readonly pendingRestartPath: string;
	readonly committedRestartPath: string;
	readonly handoffDir: string;
	readonly signalDir: string;
	readonly phaseDir: string;
	readonly lockDir: string;
	readonly updateLockPath: string;
	readonly handoffLockPath: string;
	readonly installLockPath: string;
	readonly activePointerLockPath: string;
	readonly identityLockPath: string;
	readonly quarantineDir: string;
}

/** Resolve only an explicitly supplied managed-install root. */
export function resolveAutoBotRoot(root: string): string {
	if (!root) throw new Error("AutoBot managed-install root is required");
	return path.resolve(root);
}

/**
 * The stable bootstrap derives its installation root only from its executable.
 * Tests may inject `sourceRoot` directly; ambient environment is never an
 * authority because Bun can preload an untrusted workspace dotenv file.
 */
export function resolveAutoBotBootstrapRoot(executablePath: string = process.execPath, sourceRoot?: string): string {
	try {
		if (sourceRoot !== undefined) return fs.realpathSync.native(path.resolve(sourceRoot));
		return path.dirname(fs.realpathSync.native(path.resolve(executablePath)));
	} catch {
		throw new Error("AutoBot bootstrap cannot establish a canonical executable root");
	}
}

export function autoBotPaths(root: string): AutoBotPaths {
	const installRoot = resolveAutoBotRoot(root);
	const controlDir = path.join(installRoot, ".autobot");
	const lockDir = path.join(controlDir, "locks");
	return {
		root: installRoot,
		controlDir,
		runtimeDir: path.join(installRoot, "runtimes"),
		bootstrapDir: path.join(installRoot, "bootstraps"),
		channelConfigPath: path.join(controlDir, "channel.json"),
		identityPath: path.join(controlDir, "identity.json"),
		activePointerPath: path.join(controlDir, "active.json"),
		highWaterPath: path.join(controlDir, "high-water.json"),
		pendingRestartPath: path.join(controlDir, "pending-restart.json"),
		committedRestartPath: path.join(controlDir, "committed-restart.json"),
		handoffDir: path.join(controlDir, "handoffs"),
		signalDir: path.join(controlDir, "signals"),
		phaseDir: path.join(controlDir, "phases"),
		lockDir,
		updateLockPath: path.join(lockDir, "update"),
		handoffLockPath: path.join(lockDir, "handoff"),
		activePointerLockPath: path.join(lockDir, "active-pointer"),
		installLockPath: path.join(lockDir, "install"),
		identityLockPath: path.join(lockDir, "identity"),
		quarantineDir: path.join(controlDir, "quarantine"),
	};
}

export function autoBotRuntimeSlotPath(paths: AutoBotPaths, slotId: string): string {
	if (!SAFE_SEGMENT.test(slotId)) throw new Error("Invalid AutoBot runtime slot identifier");
	return path.join(paths.runtimeDir, slotId);
}

export function autoBotBootstrapSlotPath(paths: AutoBotPaths, slotId: string): string {
	if (!SAFE_SEGMENT.test(slotId)) throw new Error("Invalid AutoBot bootstrap slot identifier");
	return path.join(paths.bootstrapDir, slotId);
}

export function autoBotHandoffPath(
	paths: AutoBotPaths,
	nonce: string,
	role: "candidate" | "fallback" = "candidate",
): string {
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new Error("Invalid AutoBot handoff nonce");
	return path.join(paths.handoffDir, `${nonce}.${role}.json`);
}

/** Unique lifetime lease held by one stable bootstrap while it supervises children. */
export function autoBotLaunchLeaseLockPath(paths: AutoBotPaths, launchId: string): string {
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(launchId)) throw new Error("Invalid AutoBot bootstrap launch identifier");
	return path.join(paths.lockDir, `launch-${launchId}`);
}

export function autoBotSignalPath(
	paths: AutoBotPaths,
	nonce: string,
	kind: "activate" | "activation-ack" | "candidate-ready" | "normal-exit" | "promoted" | "rejected" | "restart-exit",
): string {
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new Error("Invalid AutoBot handoff nonce");
	return path.join(paths.signalDir, `${nonce}.${kind}.json`);
}

export function autoBotPhasePath(paths: AutoBotPaths, nonce: string): string {
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new Error("Invalid AutoBot handoff nonce");
	return path.join(paths.phaseDir, `${nonce}.json`);
}

export function pathIsInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
