import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { type } from "@oh-my-pi/omptype";
import { assertAutoBotPrivateDirectoryAndOptionalFiles } from "./permissions";
import { autoBotPaths, type AutoBotPaths } from "./paths";
import { ensurePrivateDirectory } from "./storage";

const MAX_LAUNCH_DIAGNOSTICS = 32;
const DIAGNOSTIC_DIRECTORY_NAME = "update-diagnostics";
const STABLE_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LAUNCH_ID = /^[A-Za-z0-9_-]{32,128}$/;
const RECOVERABLE_REASON_CODES: Readonly<Record<string, true>> = {
	"offline-installed-fallback": true,
	"publication-recovered": true,
	"update-quarantined": true,
};

export type AutoBotUpdateDiagnosticOutcome =
	| "started"
	| "available"
	| "unchanged"
	| "deferred"
	| "completed"
	| "failed";

export interface AutoBotUpdateDiagnosticInput {
	readonly phase: string;
	readonly outcome: AutoBotUpdateDiagnosticOutcome;
	readonly reason?: string;
	readonly releaseSequence?: number;
	readonly launchId: string;
}

export interface AutoBotUpdateDiagnostic extends AutoBotUpdateDiagnosticInput {
	readonly timestamp: string;
}

const DiagnosticSchema = type({
	phase: "string > 0",
	outcome: "string > 0",
	reason: "string?",
	"releaseSequence?": "number.integer > 0",
	launchId: "string > 0",
	timestamp: "string > 0",
});

const initializedDirectories = new Map<string, Promise<void>>();
const latestProcessState = new Map<string, AutoBotUpdateDiagnostic>();

function validatePaths(paths: AutoBotPaths): void {
	const expected = autoBotPaths(paths.root);
	if (path.resolve(paths.controlDir) !== expected.controlDir) {
		throw new Error("Invalid AutoBot update diagnostic storage paths");
	}
}

function diagnosticDirectory(paths: AutoBotPaths): string {
	return path.join(paths.controlDir, DIAGNOSTIC_DIRECTORY_NAME);
}

function isOutcome(value: string): value is AutoBotUpdateDiagnosticOutcome {
	return (
		value === "started" ||
		value === "available" ||
		value === "unchanged" ||
		value === "deferred" ||
		value === "completed" ||
		value === "failed"
	);
}

function validTimestamp(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}

function parseDiagnostic(value: unknown): AutoBotUpdateDiagnostic {
	const parsed = DiagnosticSchema.assert(value);
	if (!STABLE_CODE.test(parsed.phase) || parsed.phase.length > 64) {
		throw new Error("Invalid AutoBot update diagnostic phase code");
	}
	if (!isOutcome(parsed.outcome)) throw new Error("Invalid AutoBot update diagnostic outcome");
	if (parsed.reason !== undefined && (!STABLE_CODE.test(parsed.reason) || parsed.reason.length > 96)) {
		throw new Error("Invalid AutoBot update diagnostic reason code");
	}
	if (
		parsed.releaseSequence !== undefined &&
		(!Number.isSafeInteger(parsed.releaseSequence) || parsed.releaseSequence <= 0)
	) {
		throw new Error("Invalid AutoBot update diagnostic release sequence");
	}
	if (!LAUNCH_ID.test(parsed.launchId)) throw new Error("Invalid AutoBot update diagnostic launch identity");
	if (!validTimestamp(parsed.timestamp)) throw new Error("Invalid AutoBot update diagnostic timestamp");
	return {
		phase: parsed.phase,
		outcome: parsed.outcome,
		...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
		...(parsed.releaseSequence === undefined ? {} : { releaseSequence: parsed.releaseSequence }),
		launchId: parsed.launchId,
		timestamp: parsed.timestamp,
	};
}

function parseInput(value: AutoBotUpdateDiagnosticInput): AutoBotUpdateDiagnosticInput {
	const parsed = parseDiagnostic({
		phase: value.phase,
		outcome: value.outcome,
		...(value.reason === undefined ? {} : { reason: value.reason }),
		...(value.releaseSequence === undefined ? {} : { releaseSequence: value.releaseSequence }),
		launchId: value.launchId,
		timestamp: new Date(0).toISOString(),
	});
	return {
		phase: parsed.phase,
		outcome: parsed.outcome,
		...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
		...(parsed.releaseSequence === undefined ? {} : { releaseSequence: parsed.releaseSequence }),
		launchId: parsed.launchId,
	};
}

function sameState(left: AutoBotUpdateDiagnostic, right: AutoBotUpdateDiagnosticInput): boolean {
	return (
		left.phase === right.phase &&
		left.outcome === right.outcome &&
		left.reason === right.reason &&
		left.releaseSequence === right.releaseSequence
	);
}

function logDiagnostic(event: AutoBotUpdateDiagnosticInput): void {
	const fields = {
		phase: event.phase,
		outcome: event.outcome,
		reason: event.reason,
		releaseSequence: event.releaseSequence,
	};
	if (event.outcome === "failed") {
		logger.error("AutoBot update failed", fields);
	} else if (event.reason && RECOVERABLE_REASON_CODES[event.reason]) {
		logger.warn("AutoBot update recovered", fields);
	} else if (event.outcome === "deferred" || event.outcome === "unchanged") {
		logger.debug("AutoBot update state", fields);
	} else {
		logger.info("AutoBot update lifecycle", fields);
	}
}

async function ensureDiagnosticDirectory(paths: AutoBotPaths): Promise<string> {
	validatePaths(paths);
	const directory = diagnosticDirectory(paths);
	let initialization = initializedDirectories.get(directory);
	if (!initialization) {
		initialization = ensurePrivateDirectory(directory).then(() => undefined);
		initializedDirectories.set(directory, initialization);
		initialization.catch(() => initializedDirectories.delete(directory));
	}
	await initialization;
	return directory;
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function replaceDiagnosticFile(tempPath: string, targetPath: string): Promise<void> {
	try {
		await fs.rename(tempPath, targetPath);
		return;
	} catch (renameError) {
		if (errorCode(renameError) !== "EPERM" && errorCode(renameError) !== "EEXIST") throw renameError;
	}
	const backupPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.bak`;
	try {
		await fs.rename(targetPath, backupPath);
	} catch (backupError) {
		if (errorCode(backupError) !== "ENOENT") throw backupError;
		await fs.rename(tempPath, targetPath);
		return;
	}
	try {
		await fs.rename(tempPath, targetPath);
	} catch (replaceError) {
		await fs.rename(backupPath, targetPath);
		throw replaceError;
	}
	await fs.rm(backupPath, { force: true });
}

async function writeDiagnosticAtomically(filePath: string, diagnostic: AutoBotUpdateDiagnostic): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(tempPath, JSON.stringify(diagnostic), { mode: 0o600 });
		if (process.platform !== "win32") await fs.chmod(tempPath, 0o600);
		await replaceDiagnosticFile(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function diagnosticFilesByRecency(directory: string): Promise<readonly string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const candidates: string[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".json") || !LAUNCH_ID.test(entry.name.slice(0, -5))) continue;
		if (!entry.isFile()) throw new Error("AutoBot update diagnostic must be a non-symlink regular file");
		candidates.push(path.join(directory, entry.name));
	}
	const dated = (
		await Promise.all(
			candidates.map(async filePath => {
				try {
					return { filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs };
				} catch (error) {
					if (errorCode(error) === "ENOENT") return undefined;
					throw error;
				}
			}),
		)
	).filter((item): item is { filePath: string; mtimeMs: number } => item !== undefined);
	dated.sort((left, right) => right.mtimeMs - left.mtimeMs || right.filePath.localeCompare(left.filePath));
	return dated.map(item => item.filePath);
}

async function retainLatestDiagnostics(directory: string): Promise<void> {
	const files = await diagnosticFilesByRecency(directory);
	await Promise.all(files.slice(MAX_LAUNCH_DIAGNOSTICS).map(filePath => fs.rm(filePath, { force: true })));
}

/**
 * Persist the latest structured update state for one authenticated bootstrap launch.
 * Each launch owns one atomic file, so unrelated sessions never serialize on a global
 * read-modify-write lock. Free-form text is rejected before it reaches disk.
 */
export async function writeAutoBotUpdateDiagnostic(
	paths: AutoBotPaths,
	event: AutoBotUpdateDiagnosticInput,
): Promise<void> {
	validatePaths(paths);
	const checked = parseInput(event);
	const cacheKey = `${path.resolve(paths.root)}\0${checked.launchId}`;
	const previous = latestProcessState.get(cacheKey);
	if (previous && sameState(previous, checked)) return;
	if (
		previous &&
		checked.outcome === "started" &&
		previous.outcome === "unchanged" &&
		previous.phase === checked.phase &&
		previous.releaseSequence === checked.releaseSequence
	) {
		return;
	}
	const initializedDirectory = await ensureDiagnosticDirectory(paths);
	const directory = await assertAutoBotPrivateDirectoryAndOptionalFiles(initializedDirectory, []);
	if (directory !== initializedDirectory) {
		throw new Error("AutoBot update diagnostic directory changed canonical identity");
	}
	const diagnostic = parseDiagnostic({ ...checked, timestamp: new Date().toISOString() });
	await writeDiagnosticAtomically(path.join(directory, `${diagnostic.launchId}.json`), diagnostic);
	latestProcessState.set(cacheKey, diagnostic);
	if (latestProcessState.size > MAX_LAUNCH_DIAGNOSTICS * 2) {
		const oldest = latestProcessState.keys().next().value;
		if (oldest !== undefined) latestProcessState.delete(oldest);
	}
	await retainLatestDiagnostics(directory);
	logDiagnostic(checked);
}

/** Read newest-first latest state for at most 32 recently active launches. */
export async function readAutoBotUpdateDiagnostics(paths: AutoBotPaths): Promise<readonly AutoBotUpdateDiagnostic[]> {
	validatePaths(paths);
	const directory = diagnosticDirectory(paths);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			let files = await diagnosticFilesByRecency(directory);
			if (files.length === 0) {
				await assertAutoBotPrivateDirectoryAndOptionalFiles(paths.controlDir, []);
				return [];
			}
			files = files.slice(0, MAX_LAUNCH_DIAGNOSTICS);
			await assertAutoBotPrivateDirectoryAndOptionalFiles(directory, files);
			const diagnostics = await Promise.all(
				files.map(async filePath => parseDiagnostic(JSON.parse(await Bun.file(filePath).text()))),
			);
			for (let index = 0; index < diagnostics.length; index += 1) {
				if (path.basename(files[index]) !== `${diagnostics[index]?.launchId}.json`) {
					throw new Error("AutoBot update diagnostic file does not match its launch identity");
				}
			}
			return diagnostics.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
		} catch (error) {
			if (attempt === 0 && errorCode(error) === "ENOENT") continue;
			throw error;
		}
	}
	throw new Error("AutoBot update diagnostics changed during both bounded read attempts");
}
