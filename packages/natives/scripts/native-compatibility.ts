import * as fs from "node:fs/promises";
import * as path from "node:path";

const NATIVE_PACKAGE_PATH = "packages/natives/package.json";
const CARGO_MANIFEST_PATH = "Cargo.toml";
const CARGO_LOCK_PATH = "Cargo.lock";
const MARKER_PATHS = [
	"crates/pi-natives/src/lib.rs",
	"packages/natives/native/index.js",
	"packages/natives/native/index.d.ts",
] as const;
const NATIVE_COMPATIBILITY_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const NATIVE_SENTINEL_RE = /__piNativesV[A-Za-z0-9_]+/g;

function nativeSentinelFor(nativeCompatibilityVersion: string): string {
	return `__piNativesV${nativeCompatibilityVersion.replace(/[^A-Za-z0-9]/g, "_")}`;
}

function replaceWorkspaceVersion(content: string, nativeCompatibilityVersion: string): string {
	const workspacePackage = /(^\[workspace\.package\][\s\S]*?)(?=^\[|(?![\s\S]))/m;
	const match = workspacePackage.exec(content);
	if (!match) throw new Error(`${CARGO_MANIFEST_PATH} is missing [workspace.package]`);
	let foundVersion = false;
	const updatedSection = match[0].replace(/^version[^\S\r\n]*=[^\S\r\n]*"[^"\r\n]+"[^\S\r\n]*$/m, line => {
		foundVersion = true;
		return line.replace(/"[^"\r\n]+"/, `"${nativeCompatibilityVersion}"`);
	});
	if (!foundVersion) throw new Error(`${CARGO_MANIFEST_PATH} [workspace.package] is missing a string version`);
	return content.slice(0, match.index) + updatedSection + content.slice(match.index + match[0].length);
}

function workspaceOwnedPackageVersions(sourceRoot: string): Promise<Map<string, string>> {
	return (async () => {
		const rootManifest = await fs.readFile(path.join(sourceRoot, CARGO_MANIFEST_PATH), "utf8");
		const membersMatch = /^members\s*=\s*\[([\s\S]*?)^\]/m.exec(rootManifest);
		if (!membersMatch) throw new Error(`${CARGO_MANIFEST_PATH} is missing workspace members`);
		const members = [...membersMatch[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
		const versions = new Map<string, string>();
		for (const member of members) {
			const manifestPath = path.join(sourceRoot, member, "Cargo.toml");
			const manifest = await fs.readFile(manifestPath, "utf8");
			const packageSection = /(^\[package\][\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(manifest)?.[0];
			if (!packageSection || !/^version\.workspace\s*=\s*true\s*$/m.test(packageSection)) continue;
			const name = /^name\s*=\s*"([^"]+)"\s*$/m.exec(packageSection)?.[1];
			if (!name) throw new Error(`${path.relative(sourceRoot, manifestPath)} [package] is missing name`);
			versions.set(name, "");
		}
		return versions;
	})();
}

function synchronizeCargoLock(
	content: string,
	workspacePackages: Map<string, string>,
	nativeCompatibilityVersion: string,
): string {
	const blocks = content.split(/(?=^\[\[package\]\][^\S\r\n]*$)/m);
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (!block.startsWith("[[package]]")) continue;
		const name = /^name\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1];
		if (!name || !workspacePackages.has(name) || /^source\s*=/m.test(block)) continue;
		const versionLine = /^version[^\S\r\n]*=[^\S\r\n]*"[^"\r\n]+"[^\S\r\n]*$/m.exec(block)?.[0];
		if (!versionLine) throw new Error(`${CARGO_LOCK_PATH} workspace package ${name} is missing version`);
		const oldVersion = /"[^"\r\n]+"/.exec(versionLine)?.[0].slice(1, -1);
		if (!oldVersion) throw new Error(`${CARGO_LOCK_PATH} workspace package ${name} has an invalid version`);
		if (workspacePackages.get(name))
			throw new Error(`${CARGO_LOCK_PATH} contains duplicate sourceless workspace package ${name}`);
		workspacePackages.set(name, oldVersion);
		blocks[index] = block.replace(versionLine, versionLine.replace(/"[^"\r\n]+"/, `"${nativeCompatibilityVersion}"`));
	}
	for (const [name, oldVersion] of workspacePackages) {
		if (!oldVersion) throw new Error(`${CARGO_LOCK_PATH} is missing sourceless workspace package ${name}`);
		if (oldVersion === nativeCompatibilityVersion) continue;
		const dependencyReference = JSON.stringify(`${name} ${oldVersion}`);
		const replacement = JSON.stringify(`${name} ${nativeCompatibilityVersion}`);
		for (let index = 0; index < blocks.length; index++) {
			blocks[index] = blocks[index].split(dependencyReference).join(replacement);
		}
	}
	return blocks.join("");
}

async function writeIfChanged(sourceRoot: string, relativePath: string, content: string, changed: string[]) {
	const absolutePath = path.join(sourceRoot, relativePath);
	const previous = await fs.readFile(absolutePath, "utf8");
	if (previous === content) return;
	await fs.writeFile(absolutePath, content);
	changed.push(relativePath.replaceAll(path.sep, "/"));
}

/**
 * Restore native build identity metadata after application-only release version updates.
 * This deliberately does not regenerate Cargo metadata or inspect dependency resolution.
 */
export async function synchronizeNativeReleaseMetadata(sourceRoot: string): Promise<string[]> {
	const packageJson = JSON.parse(await fs.readFile(path.join(sourceRoot, NATIVE_PACKAGE_PATH), "utf8")) as {
		nativeCompatibilityVersion?: unknown;
	};
	const nativeCompatibilityVersion = packageJson.nativeCompatibilityVersion;
	if (
		typeof nativeCompatibilityVersion !== "string" ||
		!NATIVE_COMPATIBILITY_VERSION_RE.test(nativeCompatibilityVersion)
	) {
		throw new Error(
			`${NATIVE_PACKAGE_PATH} must define nativeCompatibilityVersion as a stable three-part numeric version`,
		);
	}

	const changed: string[] = [];
	const cargoManifest = await fs.readFile(path.join(sourceRoot, CARGO_MANIFEST_PATH), "utf8");
	await writeIfChanged(
		sourceRoot,
		CARGO_MANIFEST_PATH,
		replaceWorkspaceVersion(cargoManifest, nativeCompatibilityVersion),
		changed,
	);

	const workspacePackages = await workspaceOwnedPackageVersions(sourceRoot);
	const cargoLock = await fs.readFile(path.join(sourceRoot, CARGO_LOCK_PATH), "utf8");
	await writeIfChanged(
		sourceRoot,
		CARGO_LOCK_PATH,
		synchronizeCargoLock(cargoLock, workspacePackages, nativeCompatibilityVersion),
		changed,
	);

	const expectedSentinel = nativeSentinelFor(nativeCompatibilityVersion);
	for (const relativePath of MARKER_PATHS) {
		const absolutePath = path.join(sourceRoot, relativePath);
		const content = await fs.readFile(absolutePath, "utf8");
		const markers = content.match(NATIVE_SENTINEL_RE) ?? [];
		if (markers.length === 0) throw new Error(`${relativePath} is missing a __piNativesV marker`);
		await writeIfChanged(sourceRoot, relativePath, content.replace(NATIVE_SENTINEL_RE, expectedSentinel), changed);
	}

	return changed;
}
