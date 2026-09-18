import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertAutoBotPrivateDirectory, assertAutoBotPrivateFile } from "./permissions";

export interface AutoBotFileLockOptions {
	/** Maximum acquisition attempts, including the initial attempt. */
	readonly retries?: number;
	/** Delay between contended acquisition attempts. */
	readonly retryDelayMs?: number;
	/** Refuse to create storage; used only to prove an old lifetime lease existed. */
	readonly requireExisting?: boolean;
}

/** A crash-safe SQLite transaction lease held until the caller releases it. */
export interface AutoBotFileLockLease {
	release(): void;
}

const DEFAULT_OPTIONS: Required<AutoBotFileLockOptions> = {
	retries: 50,
	retryDelayMs: 100,
	requireExisting: false,
};

/** Bun can collect a locally awaited Database before its transaction is released. */
const LIVE_LOCK_DATABASES = new Set<Database>();

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function isEnoent(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function isSqliteBusy(error: unknown): boolean {
	return errorCode(error)?.startsWith("SQLITE_BUSY") === true;
}

function databasePathFor(filePath: string): string {
	return `${path.resolve(filePath)}.lock.sqlite`;
}

async function assertPrivateRegularFileIfPresent(filePath: string): Promise<void> {
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(filePath);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("AutoBot control lock is not a regular file");
	await assertAutoBotPrivateFile(filePath);
}

async function ensurePrivateLockDatabase(databasePath: string): Promise<void> {
	try {
		const handle = await fs.open(databasePath, "wx", 0o600);
		await handle.close();
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw new Error("Cannot create the AutoBot control lock database", { cause: error });
	}
	await assertPrivateRegularFileIfPresent(databasePath);
}

async function assertLockStorage(lockPath: string, requireExisting = false): Promise<string> {
	const lockDirectory = path.dirname(lockPath);
	if ((await assertAutoBotPrivateDirectory(lockDirectory)) !== lockDirectory) {
		throw new Error("AutoBot control lock directory is not canonical");
	}
	const databasePath = databasePathFor(lockPath);
	if (requireExisting) {
		try {
			await fs.lstat(databasePath);
		} catch (error) {
			if (isEnoent(error)) throw new Error("AutoBot required control lock database is missing");
			throw new Error("Cannot inspect the required AutoBot control lock database", { cause: error });
		}
		await assertPrivateRegularFileIfPresent(databasePath);
	} else {
		await ensurePrivateLockDatabase(databasePath);
	}
	for (const filePath of [`${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`]) {
		await assertPrivateRegularFileIfPresent(filePath);
	}
	return databasePath;
}

function closeDatabase(database: Database): void {
	try {
		database.close();
		LIVE_LOCK_DATABASES.delete(database);
	} catch (error) {
		throw new Error("Cannot close the AutoBot control lock database", { cause: error });
	}
}

async function acquireAutoBotLockTransaction(
	databasePath: string,
	options: Required<AutoBotFileLockOptions>,
): Promise<Database> {
	for (let attempt = 0; attempt < options.retries; attempt++) {
		let database: Database | undefined;
		try {
			database = new Database(databasePath, { create: !options.requireExisting, readwrite: true });
			// Keep the native handle strongly reachable across every callback await.
			LIVE_LOCK_DATABASES.add(database);
			// Never let SQLite sleep the event loop: contention is retried below.
			database.run("PRAGMA busy_timeout = 0");
			database.run("BEGIN IMMEDIATE");
			return database;
		} catch (error) {
			if (database) {
				try {
					closeDatabase(database);
				} catch (closeError) {
					throw new AggregateError([error, closeError], "Cannot acquire the AutoBot control lock");
				}
			}
			if (!isSqliteBusy(error)) throw new Error("Cannot acquire the AutoBot control lock", { cause: error });
			if (attempt + 1 < options.retries) await Bun.sleep(options.retryDelayMs);
		}
	}
	throw new Error("AutoBot control lock is already held");
}

function releaseAutoBotLockTransaction(database: Database): void {
	const releaseErrors: unknown[] = [];
	try {
		database.run("ROLLBACK");
	} catch (error) {
		releaseErrors.push(new Error("Cannot release the AutoBot control lock", { cause: error }));
	}
	try {
		closeDatabase(database);
	} catch (error) {
		releaseErrors.push(error);
	}
	if (releaseErrors.length === 1) throw releaseErrors[0];
	if (releaseErrors.length > 1) throw new AggregateError(releaseErrors, "Cannot release the AutoBot control lock");
}

/**
 * Acquire a crash-safe transaction lease. The lease deliberately spans async
 * child supervision for bootstrap lifetime ownership; callers MUST release it.
 */
export async function acquireAutoBotFileLock(
	filePath: string,
	options: AutoBotFileLockOptions = {},
): Promise<AutoBotFileLockLease> {
	const lockPath = path.resolve(filePath);
	const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };
	const databasePath = await assertLockStorage(lockPath, resolvedOptions.requireExisting);
	const database = await acquireAutoBotLockTransaction(databasePath, resolvedOptions);
	try {
		// Verify the newly created database and any rollback journal while the
		// transaction is held; no trust state is touched until this passes.
		await assertLockStorage(lockPath, resolvedOptions.requireExisting);
	} catch (error) {
		try {
			releaseAutoBotLockTransaction(database);
		} catch (releaseError) {
			throw new AggregateError([error, releaseError], "Cannot verify or release the AutoBot control lock");
		}
		throw error;
	}
	let released = false;
	return {
		release(): void {
			if (released) return;
			released = true;
			releaseAutoBotLockTransaction(database);
		},
	};
}

/**
 * Serialize AutoBot control-plane mutations with a persistent SQLite database
 * under the already owner-private lock directory. `BEGIN IMMEDIATE` is an
 * OS-backed lock released on crash; no stale lease is ever stolen or deleted.
 */
export async function withAutoBotFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: AutoBotFileLockOptions = {},
): Promise<T> {
	const lease = await acquireAutoBotFileLock(filePath, options);
	let callbackFailed = false;
	let callbackError: unknown;
	let result: T | undefined;
	try {
		result = await fn();
	} catch (error) {
		callbackFailed = true;
		callbackError = error;
	}
	let releaseError: unknown;
	try {
		lease.release();
	} catch (error) {
		releaseError = error;
	}
	if (callbackFailed && releaseError) {
		throw new AggregateError([callbackError, releaseError], "AutoBot control lock callback and release both failed");
	}
	if (callbackFailed) throw callbackError;
	if (releaseError) throw releaseError;
	return result as T;
}
