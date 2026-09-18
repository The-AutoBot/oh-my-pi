const UNSAFE_LOADER_ENV: Record<string, true> = {
	LD_PRELOAD: true,
	LD_LIBRARY_PATH: true,
	LD_AUDIT: true,
	LD_DEBUG: true,
	LD_PROFILE: true,
	DYLD_INSERT_LIBRARIES: true,
	DYLD_LIBRARY_PATH: true,
	DYLD_FRAMEWORK_PATH: true,
	DYLD_FALLBACK_LIBRARY_PATH: true,
	DYLD_FALLBACK_FRAMEWORK_PATH: true,
	NODE_OPTIONS: true,
	BUN_OPTIONS: true,
	BUN_PRELOAD: true,
};

function unsafeLoaderEnvironmentKey(key: string): boolean {
	const normalized = key.toUpperCase();
	return (
		UNSAFE_LOADER_ENV[normalized] === true ||
		normalized.startsWith("LD_") ||
		normalized.startsWith("DYLD_") ||
		normalized.startsWith("BUN_PRELOAD")
	);
}

function reservedAutoBotEnvironmentKey(key: string): boolean {
	const normalized = key.toUpperCase();
	return normalized.startsWith("OMP_AUTOBOT_") || normalized === "OMP_SESSION_COLLAB_WEB_URL";
}

/** Preserve ordinary user settings while stripping native-code injection and all untrusted reserved claims. */
export function scrubAutoBotLaunchEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined && !unsafeLoaderEnvironmentKey(key) && !reservedAutoBotEnvironmentKey(key)) {
			environment[key] = value;
		}
	}
	return environment;
}

/** Minimal deterministic environment for release verification probes and libc detection. */
export function autoBotTrustEnvironment(): NodeJS.ProcessEnv {
	return process.platform === "win32" ? {} : { LANG: "C", PATH: "/usr/bin:/bin" };
}
