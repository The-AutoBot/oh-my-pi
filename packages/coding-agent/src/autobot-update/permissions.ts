import * as fs from "node:fs/promises";
import * as path from "node:path";
import { autoBotTrustEnvironment } from "./trust-env";

const PRIVATE_MODE = 0o700;
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const CREATOR_OWNER_SID = "S-1-3-0";
const OWNER_RIGHTS_SID = "S-1-3-4";
/** Any useful write capability satisfies the managed root's owner/SYSTEM ACL requirement. */
const ROOT_WRITE_RIGHTS_MASK = 2 | 4 | 16 | 64 | 256 | 65_536 | 262_144 | 524_288;
const GENERIC_ALL_MASK = 0x10000000;
const GENERIC_WRITE_MASK = 0x40000000;
/** Rights that let a foreign principal replace or retake the managed root from an ancestor. */
const ANCESTOR_REPLACEMENT_RIGHTS_MASK = 0x40 | 0x10000 | 0x40000 | 0x80000 | GENERIC_ALL_MASK;
const WINDOWS_SYSTEM_DIRECTORY =
	process.platform === "win32"
		? (() => {
				const systemRoot = process.env.SystemRoot;
				if (!systemRoot || !path.isAbsolute(systemRoot))
					throw new Error("Windows SystemRoot is unavailable for AutoBot ACL verification");
				const resolved = path.resolve(systemRoot);
				if (path.basename(resolved).toLowerCase() !== "windows")
					throw new Error("Windows SystemRoot is invalid for AutoBot ACL verification");
				return path.join(resolved, "System32");
			})()
		: "";
function trustedWindowsSystemBinary(name: string): string {
	// This is captured at module initialization before ordinary configuration is
	// read. Signed compiled launchers disable dotenv/bunfig autoloading.
	return path.join(WINDOWS_SYSTEM_DIRECTORY, name);
}

async function runTrustedWindowsTool(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = autoBotTrustEnvironment(),
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
	const child = Bun.spawn([command, ...args], {
		cwd: WINDOWS_SYSTEM_DIRECTORY,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).arrayBuffer(),
	]);
	return { exitCode, stdout };
}

async function currentWindowsSid(): Promise<string> {
	const result = await runTrustedWindowsTool(trustedWindowsSystemBinary("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
	if (result.exitCode !== 0)
		throw new Error("Cannot determine the current Windows identity for AutoBot ACL verification");
	const fields = result.stdout.trim().replace(/^"|"$/g, "").split('","');
	const sid = fields.at(-1)?.trim();
	if (!sid || !/^S-1-\d+(?:-\d+)+$/i.test(sid)) throw new Error("Windows identity query returned an invalid SID");
	return sid.toUpperCase();
}

interface WindowsAclRule {
	readonly sid: string;
	readonly rights: number;
	readonly allow: boolean;
	readonly inherited: boolean;
	/** An inherit-only ACE does not apply to the directory currently being checked. */
	readonly inheritOnly: boolean;
	/** Whether this ACE would be inherited by a newly-created directory child. */
	readonly inheritToContainers: boolean;
	/** Whether this ACE would be inherited by a newly-created file child. */
	readonly inheritToObjects: boolean;
}

interface WindowsAclSnapshot {
	readonly owner: string;
	readonly protected: boolean;
	readonly daclPresent: boolean;
	readonly sddl: string;
	readonly rules: readonly WindowsAclRule[];
}

function encodedPowerShell(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

interface WindowsAclBatch {
	readonly sid: string;
	readonly snapshots: ReadonlyMap<string, WindowsAclSnapshot>;
}

function parseWindowsAclSnapshot(value: unknown): WindowsAclSnapshot {
	const parsed = value as WindowsAclSnapshot & { rules?: WindowsAclRule | readonly WindowsAclRule[] };
	const rules = Array.isArray(parsed.rules) ? parsed.rules : parsed.rules ? [parsed.rules] : [];
	if (
		typeof parsed.owner !== "string" ||
		!/^S-1-\d+(?:-\d+)+$/i.test(parsed.owner) ||
		typeof parsed.protected !== "boolean" ||
		typeof parsed.daclPresent !== "boolean" ||
		typeof parsed.sddl !== "string" ||
		!rules.every(
			rule =>
				typeof rule.sid === "string" &&
				/^S-1-\d+(?:-\d+)+$/i.test(rule.sid) &&
				Number.isInteger(rule.rights) &&
				typeof rule.allow === "boolean" &&
				typeof rule.inherited === "boolean" &&
				typeof rule.inheritOnly === "boolean" &&
				typeof rule.inheritToContainers === "boolean" &&
				typeof rule.inheritToObjects === "boolean",
		)
	) {
		throw new Error("invalid ACL response");
	}
	return {
		owner: parsed.owner.toUpperCase(),
		protected: parsed.protected,
		daclPresent: parsed.daclPresent,
		sddl: parsed.sddl,
		rules: rules.map(rule => ({ ...rule, sid: rule.sid.toUpperCase() })),
	};
}

/**
 * One trusted PowerShell invocation snapshots a verification cohort. The
 * cohort is discarded after each security transition; it is never a cache
 * across ACL mutations.
 */
async function readWindowsAcls(directories: readonly string[]): Promise<WindowsAclBatch> {
	const requested = [...new Set(directories.map(directory => path.resolve(directory)))];
	if (requested.length === 0) throw new Error("No Windows ACL paths were requested");
	const script = [
		"$ErrorActionPreference='Stop'",
		"$json=[Environment]::GetEnvironmentVariable('OMP_AUTOBOT_ACL_PATHS','Process')",
		"if([string]::IsNullOrWhiteSpace($json)){exit 2}",
		"$decoded=ConvertFrom-Json -InputObject $json",
		"$paths=if($decoded -is [System.Array]){$decoded}else{@($decoded)}",
		"if($paths.Count -lt 1 -or @($paths|Where-Object {$_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_)}).Count -ne 0){exit 2}",
		"$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
		"$entries=@($paths|ForEach-Object {$p=[string]$_;if([string]::IsNullOrWhiteSpace($p)){throw 'invalid path'};$acl=Get-Acl -LiteralPath $p;$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;$rules=@($acl.Access|ForEach-Object {$ruleSid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;$inheritance=[int]$_.InheritanceFlags;[PSCustomObject]@{sid=$ruleSid;rights=[int]$_.FileSystemRights;allow=($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow);inherited=[bool]$_.IsInherited;inheritOnly=(([int]$_.PropagationFlags -band [int][System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0);inheritToContainers=(($inheritance -band [int][System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0);inheritToObjects=(($inheritance -band [int][System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0)}});$raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);[PSCustomObject]@{path=$p;owner=$owner;protected=[bool]$acl.AreAccessRulesProtected;daclPresent=($null -ne $raw.DiscretionaryAcl);sddl=$acl.Sddl;rules=$rules}})",
		"[PSCustomObject]@{sid=$sid;entries=$entries}|ConvertTo-Json -Compress -Depth 4",
	].join(";");
	const result = await runTrustedWindowsTool(
		trustedWindowsSystemBinary("WindowsPowerShell\\v1.0\\powershell.exe"),
		["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)],
		{ ...autoBotTrustEnvironment(), OMP_AUTOBOT_ACL_PATHS: JSON.stringify(requested) },
	);
	if (result.exitCode !== 0) throw new Error("Cannot inspect the Windows ACL protecting AutoBot files");
	try {
		const parsed = JSON.parse(result.stdout) as { sid?: unknown; entries?: unknown };
		if (typeof parsed.sid !== "string" || !/^S-1-\d+(?:-\d+)+$/i.test(parsed.sid))
			throw new Error("invalid SID response");
		const entries = Array.isArray(parsed.entries)
			? parsed.entries
			: parsed.entries === undefined
				? []
				: [parsed.entries];
		const requestedPaths = new Set(requested);
		const snapshots = new Map<string, WindowsAclSnapshot>();
		for (const value of entries) {
			if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string") {
				throw new Error("invalid ACL path response");
			}
			const directory = path.resolve(value.path);
			if (!requestedPaths.has(directory) || snapshots.has(directory))
				throw new Error("unexpected ACL path response");
			snapshots.set(directory, parseWindowsAclSnapshot(value));
		}
		if (snapshots.size !== requested.length) throw new Error("incomplete ACL response");
		return { sid: parsed.sid.toUpperCase(), snapshots };
	} catch {
		throw new Error("Cannot parse the Windows ACL protecting AutoBot files");
	}
}

async function readWindowsAcl(directory: string): Promise<WindowsAclSnapshot> {
	const resolved = path.resolve(directory);
	const snapshot = (await readWindowsAcls([resolved])).snapshots.get(resolved);
	if (!snapshot) throw new Error("Windows ACL response omitted a requested path");
	return snapshot;
}

function hasRootWriteAccess(rights: number): boolean {
	return (
		(rights & ROOT_WRITE_RIGHTS_MASK) !== 0 ||
		(rights & GENERIC_ALL_MASK) !== 0 ||
		(rights & GENERIC_WRITE_MASK) !== 0
	);
}

function hasAncestorReplacementAccess(rule: WindowsAclRule): boolean {
	return !rule.inheritOnly && (rule.rights & ANCESTOR_REPLACEMENT_RIGHTS_MASK) !== 0;
}

function hasWriteAccess(snapshot: WindowsAclSnapshot, sid: string): boolean {
	return snapshot.rules.some(rule => rule.allow && rule.sid === sid && hasRootWriteAccess(rule.rights));
}

function removeForeignWindowsAllowGrants(snapshot: WindowsAclSnapshot, sid: string): string[] {
	const identities = new Set(
		snapshot.rules.filter(rule => rule.allow && rule.sid !== sid && rule.sid !== SYSTEM_SID).map(rule => rule.sid),
	);
	return [...identities].flatMap(identity => ["/remove:g", `*${identity}`]);
}

function trustedWindowsAncestorOwner(owner: string, sid: string): boolean {
	return owner === sid || owner === SYSTEM_SID || owner === ADMINISTRATORS_SID || owner === TRUSTED_INSTALLER_SID;
}

function cohortSnapshot(cohort: WindowsAclBatch, directory: string): WindowsAclSnapshot {
	const snapshot = cohort.snapshots.get(path.resolve(directory));
	if (!snapshot) throw new Error("Windows ACL response omitted a requested path");
	return snapshot;
}

function assertWindowsOwnerPrivateSnapshot(snapshot: WindowsAclSnapshot, sid: string): void {
	if (!snapshot.protected || !snapshot.daclPresent || !snapshot.sddl.includes("D:")) {
		throw new Error("AutoBot managed directory has no protected Windows DACL");
	}
	if (snapshot.owner !== sid || !hasWriteAccess(snapshot, sid) || !hasWriteAccess(snapshot, SYSTEM_SID)) {
		throw new Error("AutoBot managed directory lacks its required owner-private ACL");
	}
	for (const rule of snapshot.rules) {
		if (!rule.allow || rule.rights === 0 || rule.sid === sid || rule.sid === SYSTEM_SID) continue;
		throw new Error("AutoBot managed directory ACL grants access beyond its owner");
	}
}

function windowsAncestorDirectories(canonicalDirectory: string): string[] {
	const directories: string[] = [];
	let current = path.dirname(canonicalDirectory);
	while (true) {
		directories.push(current);
		const parent = path.dirname(current);
		if (parent === current) return directories;
		current = parent;
	}
}

function assertSafeWindowsAncestorSnapshots(directories: readonly string[], cohort: WindowsAclBatch): void {
	for (const directory of directories) {
		const snapshot = cohortSnapshot(cohort, directory);
		if (!snapshot.daclPresent) throw new Error("An AutoBot storage ancestor has a NULL Windows DACL");
		if (!trustedWindowsAncestorOwner(snapshot.owner, cohort.sid)) {
			throw new Error("An AutoBot storage ancestor is owned by an untrusted Windows identity");
		}
		for (const rule of snapshot.rules) {
			if (
				rule.allow &&
				rule.sid !== cohort.sid &&
				rule.sid !== SYSTEM_SID &&
				rule.sid !== ADMINISTRATORS_SID &&
				rule.sid !== TRUSTED_INSTALLER_SID &&
				hasAncestorReplacementAccess(rule)
			) {
				throw new Error("An AutoBot storage ancestor grants another Windows identity replacement access");
			}
		}
	}
}

async function assertWindowsOwnerPrivateAndSafeAncestors(directory: string): Promise<void> {
	const canonical = await fs.realpath(directory);
	const ancestors = windowsAncestorDirectories(canonical);
	const cohort = await readWindowsAcls([canonical, ...ancestors]);
	assertWindowsOwnerPrivateSnapshot(cohortSnapshot(cohort, canonical), cohort.sid);
	assertSafeWindowsAncestorSnapshots(ancestors, cohort);
}

async function assertWindowsOwnerPrivate(directory: string): Promise<void> {
	const cohort = await readWindowsAcls([directory]);
	assertWindowsOwnerPrivateSnapshot(cohortSnapshot(cohort, directory), cohort.sid);
}

async function assertWindowsPrivateFile(filePath: string): Promise<void> {
	const cohort = await readWindowsAcls([filePath]);
	const snapshot = cohortSnapshot(cohort, filePath);
	if (!snapshot.daclPresent || snapshot.owner !== cohort.sid) {
		throw new Error("AutoBot managed executable lacks a current-user-owned Windows DACL");
	}
	for (const rule of snapshot.rules) {
		if (
			!rule.allow ||
			rule.inheritOnly ||
			rule.sid === cohort.sid ||
			rule.sid === SYSTEM_SID ||
			rule.sid === CREATOR_OWNER_SID ||
			rule.sid === OWNER_RIGHTS_SID
		) {
			continue;
		}
		if (hasRootWriteAccess(rule.rights)) {
			throw new Error("AutoBot managed executable grants another Windows identity mutation access");
		}
	}
}

/**
 * Legacy bytes may be imported only when no untrusted identity can mutate
 * them. Read/execute inheritance and OS-trusted servicing principals are
 * acceptable until the file is normalized under the managed root.
 */
async function assertWindowsImportableFile(filePath: string): Promise<void> {
	const cohort = await readWindowsAcls([filePath]);
	const snapshot = cohortSnapshot(cohort, filePath);
	if (!snapshot.daclPresent || snapshot.owner !== cohort.sid) {
		throw new Error("AutoBot legacy executable lacks a current-user-owned Windows DACL");
	}
	for (const rule of snapshot.rules) {
		if (
			rule.allow &&
			!rule.inheritOnly &&
			!trustedWindowsPrincipal(rule.sid, cohort.sid) &&
			!trustedWindowsDescendantPrincipal(rule.sid, cohort.sid) &&
			hasRootWriteAccess(rule.rights)
		) {
			throw new Error("AutoBot legacy executable grants an untrusted Windows identity mutation access");
		}
	}
}

async function assertWindowsImportableDirectory(directory: string): Promise<void> {
	const cohort = await readWindowsAcls([directory]);
	const snapshot = cohortSnapshot(cohort, directory);
	if (!snapshot.daclPresent || snapshot.owner !== cohort.sid) {
		throw new Error("AutoBot legacy directory lacks a current-user-owned Windows DACL");
	}
	for (const rule of snapshot.rules) {
		if (
			!rule.allow ||
			trustedWindowsPrincipal(rule.sid, cohort.sid) ||
			trustedWindowsDescendantPrincipal(rule.sid, cohort.sid)
		)
			continue;
		if (
			(!rule.inheritOnly && hasRootWriteAccess(rule.rights)) ||
			((rule.inheritToContainers || rule.inheritToObjects) && hasRootWriteAccess(rule.rights))
		) {
			throw new Error("AutoBot legacy directory grants an untrusted Windows identity mutation access");
		}
	}
}

async function assertSafeWindowsAncestors(directory: string): Promise<void> {
	const canonical = await fs.realpath(directory);
	const ancestors = windowsAncestorDirectories(canonical);
	const cohort = await readWindowsAcls(ancestors);
	assertSafeWindowsAncestorSnapshots(ancestors, cohort);
}

function trustedWindowsPrincipal(principal: string, sid: string): boolean {
	return (
		principal === sid ||
		principal === SYSTEM_SID ||
		principal === ADMINISTRATORS_SID ||
		principal === TRUSTED_INSTALLER_SID
	);
}

function trustedWindowsDescendantPrincipal(principal: string, sid: string): boolean {
	return trustedWindowsPrincipal(principal, sid) || principal === CREATOR_OWNER_SID || principal === OWNER_RIGHTS_SID;
}

async function assertWindowsOwnedByCurrentUser(directory: string): Promise<void> {
	const cohort = await readWindowsAcls([directory]);
	if (cohortSnapshot(cohort, directory).owner !== cohort.sid) {
		throw new Error("AutoBot managed directory is not owned by the current Windows user");
	}
}

async function assertSafeWindowsCreationParent(directory: string): Promise<void> {
	const parent = await fs.realpath(directory);
	const ancestors = windowsAncestorDirectories(parent);
	const cohort = await readWindowsAcls([parent, ...ancestors]);
	const snapshot = cohortSnapshot(cohort, parent);
	if (!snapshot.daclPresent || !trustedWindowsAncestorOwner(snapshot.owner, cohort.sid)) {
		throw new Error("AutoBot creation parent has an unsafe Windows security descriptor");
	}
	// Only the nearest existing parent supplies ACLs inherited by a new child.
	// Higher ancestors are checked separately for replacement rights; their
	// inherit-only ACEs may already be blocked by a protected profile ancestor.
	for (const rule of snapshot.rules) {
		if (!rule.allow || trustedWindowsDescendantPrincipal(rule.sid, cohort.sid)) continue;
		if (
			(!rule.inheritOnly && hasAncestorReplacementAccess(rule)) ||
			(rule.inheritToContainers && hasRootWriteAccess(rule.rights))
		) {
			throw new Error("AutoBot creation parent grants a foreign identity mutation access to new descendants");
		}
	}
	assertSafeWindowsAncestorSnapshots(ancestors, cohort);
}

async function nearestExistingDirectory(directory: string): Promise<string> {
	let current = path.resolve(directory);
	while (true) {
		try {
			await assertNoLinkDirectory(current);
			return current;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			const parent = path.dirname(current);
			if (parent === current) throw new Error("AutoBot storage has no existing directory ancestor");
			current = parent;
		}
	}
}

async function restrictWindowsDirectory(directory: string): Promise<void> {
	const cohort = await readWindowsAcls([directory]);
	const result = await runTrustedWindowsTool(trustedWindowsSystemBinary("icacls.exe"), [
		directory,
		"/inheritance:r",
		...removeForeignWindowsAllowGrants(cohortSnapshot(cohort, directory), cohort.sid),
		"/grant:r",
		`*${cohort.sid}:(OI)(CI)F`,
		`*${SYSTEM_SID}:(OI)(CI)F`,
	]);
	if (result.exitCode !== 0) throw new Error("Cannot set the required owner-private Windows ACL for AutoBot files");
	await assertWindowsOwnerPrivateAndSafeAncestors(directory);
}

async function restrictWindowsFile(filePath: string): Promise<void> {
	const cohort = await readWindowsAcls([filePath]);
	const result = await runTrustedWindowsTool(trustedWindowsSystemBinary("icacls.exe"), [
		filePath,
		"/inheritance:r",
		...removeForeignWindowsAllowGrants(cohortSnapshot(cohort, filePath), cohort.sid),
		"/grant:r",
		`*${cohort.sid}:F`,
		`*${SYSTEM_SID}:F`,
	]);
	if (result.exitCode !== 0)
		throw new Error("Cannot set the required owner-private Windows ACL for an AutoBot executable");
}

async function assertNoLinkDirectory(directory: string): Promise<void> {
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("AutoBot managed storage must be a real directory, not a link or reparse point");
	}
}

async function assertNoLexicalLinks(directory: string): Promise<void> {
	const parsed = path.parse(path.resolve(directory));
	let current = parsed.root;
	for (const segment of path.relative(parsed.root, path.resolve(directory)).split(path.sep)) {
		if (!segment) continue;
		current = path.join(current, segment);
		await assertNoLinkDirectory(current);
	}
}

async function runTrustedDarwinTool(command: string, args: readonly string[]): Promise<string> {
	const child = Bun.spawn([command, ...args], {
		cwd: "/",
		env: { ...autoBotTrustEnvironment(), LANG: "C", LC_ALL: "C" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	if (exitCode !== 0) throw new Error("Cannot inspect or normalize the macOS ACL protecting AutoBot files");
	return stdout;
}

/**
 * Validate `ls -lde` C-locale output before trusting a macOS file or ancestor.
 * A named ACL is safe only when every numbered entry is an explicit deny:
 * denies only reduce authority, while every allow or unparseable entry fails
 * closed before bytes become migration provenance.
 */
export function assertAutoBotDenyOnlyDarwinAclListing(listing: string): void {
	const lines = listing.trimEnd().split("\n");
	const mode = lines.shift();
	if (!mode) throw new Error("Cannot parse the macOS ACL protecting AutoBot files");
	const hasAclMarker = /^[bcdlps-][rwxStTs-]{9}[@+]*\+/.test(mode);
	const entries = lines.filter(line => line.trim().length > 0);
	if (entries.length === 0) {
		if (hasAclMarker) throw new Error("Cannot parse the macOS ACL protecting AutoBot files");
		return;
	}
	if (!hasAclMarker) throw new Error("Cannot parse the macOS ACL protecting AutoBot files");
	for (const entry of entries) {
		const parsed = /^\s*\d+:\s+\S+\s+(deny|allow)\s+[A-Za-z][A-Za-z0-9_-]*(?:,[A-Za-z][A-Za-z0-9_-]*)*\s*$/.exec(
			entry,
		);
		if (!parsed || parsed[1] !== "deny") {
			throw new Error("AutoBot storage has a macOS ACL that can grant authority");
		}
	}
}

async function assertDarwinDenyOnlyAcl(filePath: string): Promise<void> {
	if (process.platform !== "darwin") return;
	assertAutoBotDenyOnlyDarwinAclListing(await runTrustedDarwinTool("/bin/ls", ["-lde", filePath]));
}

async function removeDarwinAcl(filePath: string): Promise<void> {
	if (process.platform !== "darwin") return;
	await runTrustedDarwinTool("/bin/chmod", ["-N", filePath]);
	await assertDarwinDenyOnlyAcl(filePath);
}

async function assertPosixPrivateDirectory(directory: string): Promise<void> {
	const stat = await fs.stat(directory);
	const getuid = process.getuid;
	if (!getuid || stat.uid !== getuid()) throw new Error("AutoBot managed directory is not owned by the current user");
	if ((stat.mode & 0o077) !== 0) throw new Error("AutoBot managed directory is not owner-private");
}

async function assertSafePosixAncestors(directory: string): Promise<void> {
	const getuid = process.getuid;
	if (!getuid) throw new Error("Cannot determine the current user for AutoBot storage verification");
	const uid = getuid();
	let current = await fs.realpath(directory);
	while (true) {
		const stat = await fs.lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("AutoBot storage ancestor is not a real directory");
		await assertDarwinDenyOnlyAcl(current);
		if ((stat.mode & 0o022) !== 0) throw new Error("AutoBot storage ancestor is writable by another user");
		if (stat.uid !== uid && stat.uid !== 0) throw new Error("AutoBot storage ancestor is owned by another user");
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

/** Create then prove an owner-private canonical directory before it holds trust state or release bytes. */
export async function ensureAutoBotPrivateDirectory(directory: string): Promise<string> {
	const lexical = path.resolve(directory);
	const nearest = await nearestExistingDirectory(lexical);
	if (process.platform === "win32") {
		// `fs.mkdir(..., 0o700)` cannot atomically set a Windows DACL. Refuse
		// creation unless the nearest existing parent cannot give another user
		// mutation rights over a descendant during that setup window.
		await assertSafeWindowsCreationParent(nearest);
	}
	await fs.mkdir(lexical, { recursive: true, mode: PRIVATE_MODE });
	await assertNoLexicalLinks(lexical);
	if (process.platform === "win32") {
		// Never launder a concurrently or previously attacker-created child.
		await assertWindowsOwnedByCurrentUser(lexical);
		await restrictWindowsDirectory(lexical);
		return assertAutoBotPrivateDirectory(lexical);
	}
	await fs.chmod(lexical, PRIVATE_MODE);
	await removeDarwinAcl(lexical);
	await assertPosixPrivateDirectory(lexical);
	await assertSafePosixAncestors(lexical);
	return assertAutoBotPrivateDirectory(lexical);
}

/** Prove an existing trust boundary remains canonical and owner-private. */
export async function assertAutoBotPrivateDirectory(directory: string): Promise<string> {
	const lexical = path.resolve(directory);
	const verify = async (candidate: string): Promise<void> => {
		await assertNoLexicalLinks(candidate);
		if (process.platform === "win32") {
			await assertWindowsOwnerPrivateAndSafeAncestors(candidate);
			return;
		}
		await assertPosixPrivateDirectory(candidate);
		await assertSafePosixAncestors(candidate);
	};
	await verify(lexical);
	const canonical = await fs.realpath(lexical);
	// Revalidate after canonicalization so a concurrent replacement cannot turn
	// a checked lexical path into a different trusted root.
	await verify(canonical);
	return canonical;
}

async function assertNoLinkRegularFile(filePath: string): Promise<void> {
	const stat = await fs.lstat(filePath);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error("AutoBot managed executable must be a real regular file, not a link or reparse point");
	}
}

async function assertPosixPrivateFile(filePath: string): Promise<void> {
	const stat = await fs.stat(filePath);
	const getuid = process.getuid;
	if (!getuid || stat.uid !== getuid()) throw new Error("AutoBot managed executable is not owned by the current user");
	// Executable release artifacts may be world-readable/executable (for
	// example 0755) inside the already owner-private parent. Only another
	// principal's ability to mutate the bytes invalidates provenance.
	if ((stat.mode & 0o022) !== 0) throw new Error("AutoBot managed executable is writable by another user");
}

/**
 * Prove a legacy executable is regular, canonical, and protected before its
 * bytes may be used as migration provenance. This never creates or repairs it.
 */
export async function assertAutoBotPrivateFile(filePath: string): Promise<string> {
	const lexical = path.resolve(filePath);
	await assertNoLinkRegularFile(lexical);
	await assertAutoBotPrivateDirectory(path.dirname(lexical));
	if (process.platform === "win32") {
		await assertWindowsPrivateFile(lexical);
		await assertSafeWindowsAncestors(lexical);
	} else {
		await assertDarwinDenyOnlyAcl(lexical);
		await assertPosixPrivateFile(lexical);
		await assertSafePosixAncestors(path.dirname(lexical));
	}
	const canonical = await fs.realpath(lexical);
	await assertNoLinkRegularFile(canonical);
	if (process.platform === "win32") {
		await assertWindowsPrivateFile(canonical);
		await assertSafeWindowsAncestors(canonical);
	} else {
		await assertDarwinDenyOnlyAcl(canonical);
		await assertPosixPrivateFile(canonical);
		await assertSafePosixAncestors(path.dirname(canonical));
	}
	return canonical;
}

/**
 * Prove legacy executable bytes are regular, canonical, current-user-owned,
 * and cannot be changed by an untrusted identity. Unlike the managed-file
 * proof, this deliberately permits integrity-safe inherited read/execute
 * access and trusted Windows servicing principals before normalization.
 */
export async function assertAutoBotImportableFile(filePath: string): Promise<string> {
	const lexical = path.resolve(filePath);
	const verify = async (candidate: string): Promise<void> => {
		const parent = path.dirname(candidate);
		await assertNoLinkRegularFile(candidate);
		await assertNoLexicalLinks(parent);
		if (process.platform === "win32") {
			await assertWindowsImportableFile(candidate);
			await assertWindowsImportableDirectory(parent);
			await assertSafeWindowsAncestors(parent);
			return;
		}
		await assertDarwinDenyOnlyAcl(candidate);
		await assertPosixPrivateFile(candidate);
		await assertSafePosixAncestors(parent);
	};
	await verify(lexical);
	const canonical = await fs.realpath(lexical);
	await verify(canonical);
	return canonical;
}

/**
 * Tighten a previously proven legacy executable only after its parent has
 * become the managed owner-private root. It never repairs an unproven file.
 */
export async function normalizeAutoBotPrivateFile(filePath: string): Promise<string> {
	const canonical = await assertAutoBotImportableFile(filePath);
	const parent = await assertAutoBotPrivateDirectory(path.dirname(canonical));
	if (parent !== path.dirname(canonical)) throw new Error("AutoBot managed executable parent is not canonical");
	await assertNoLinkRegularFile(canonical);
	if (process.platform === "win32") {
		await restrictWindowsFile(canonical);
	} else {
		await fs.chmod(canonical, PRIVATE_MODE);
		await removeDarwinAcl(canonical);
	}
	return assertAutoBotPrivateFile(canonical);
}
