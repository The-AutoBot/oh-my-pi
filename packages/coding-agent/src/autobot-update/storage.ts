import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureAutoBotPrivateDirectory } from "./permissions";

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function isEnoent(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

/**
 * Local quiet atomic replacement used by the immutable bootstrap. Keeping this
 * here avoids loading profile-aware logging or ambient native addons before the
 * verified managed runtime has started.
 */
async function replaceAutoBotFileAtomically(tempPath: string, targetPath: string): Promise<void> {
	try {
		await fs.rename(tempPath, targetPath);
		return;
	} catch (renameError) {
		if (errorCode(renameError) !== "EPERM" && errorCode(renameError) !== "EEXIST") throw renameError;
		const backupPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.bak`;
		try {
			await fs.rename(targetPath, backupPath);
		} catch (backupError) {
			if (!isEnoent(backupError)) throw renameError;
			await fs.rename(tempPath, targetPath);
			return;
		}
		try {
			await fs.rename(tempPath, targetPath);
		} catch (replaceError) {
			try {
				await fs.rename(backupPath, targetPath);
			} catch (restoreError) {
				throw new Error("Cannot restore the AutoBot state file after a failed replacement", {
					cause: restoreError,
				});
			}
			throw replaceError;
		}
		try {
			await fs.rm(backupPath);
		} catch (cleanupError) {
			if (!isEnoent(cleanupError))
				throw new Error("Cannot finalize the AutoBot state file replacement", { cause: cleanupError });
		}
	}
}

/** Read a JSON file without making a separate, racy existence probe. */
export async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await Bun.file(filePath).text());
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Atomically replace a JSON state file, leaving readers with an old or complete new document. */
export async function writeJsonAtomically(filePath: string, value: unknown, mode = 0o600): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await ensurePrivateDirectory(path.dirname(filePath));
	try {
		await Bun.write(tempPath, JSON.stringify(value));
		if (process.platform !== "win32") await fs.chmod(tempPath, mode);
		await replaceAutoBotFileAtomically(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** Atomically copy a verified artifact into its final immutable path. */
export async function copyFileAtomically(sourcePath: string, destinationPath: string, mode = 0o755): Promise<void> {
	const tempPath = `${destinationPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await ensurePrivateDirectory(path.dirname(destinationPath));
	try {
		await fs.copyFile(sourcePath, tempPath);
		if (process.platform !== "win32") await fs.chmod(tempPath, mode);
		await replaceAutoBotFileAtomically(tempPath, destinationPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
	await ensureAutoBotPrivateDirectory(directory);
}

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await Bun.file(filePath).stat();
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

export async function removeFileIfPresent(filePath: string): Promise<void> {
	try {
		await fs.rm(filePath, { force: true });
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

/** Hash a file in chunks, never copying the whole runtime or archive into memory. */
export async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const input = await fs.open(filePath, "r");
	try {
		for await (const chunk of input.createReadStream()) hash.update(chunk);
	} finally {
		await input.close();
	}
	return hash.digest("hex");
}

export async function readUtf8File(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

/** Compare secrets without a timing leak and reject unequal byte lengths first. */
export function equalSecret(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
