import * as fs from "node:fs";
import { autoBotTrustEnvironment } from "./trust-env";

export interface MuslDetectionOptions {
	readonly platform?: NodeJS.Platform;
	readonly alpineRelease?: boolean;
	readonly lddOutput?: string;
}

export interface AutoBotRuntimeTargetOptions extends MuslDetectionOptions {
	readonly arch?: string;
}

function detectLddOutput(): string | undefined {
	const lddPath = fs.existsSync("/usr/bin/ldd") ? "/usr/bin/ldd" : fs.existsSync("/bin/ldd") ? "/bin/ldd" : undefined;
	if (!lddPath) return undefined;
	try {
		const result = Bun.spawnSync([lddPath, "--version"], {
			cwd: "/",
			env: autoBotTrustEnvironment(),
			stdout: "pipe",
			stderr: "pipe",
		});
		return `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`;
	} catch {
		return undefined;
	}
}

/**
 * Detect a musl Linux host before selecting an immutable native runtime.
 * A glibc runtime must never be substituted for this signed asset identity.
 */
export function isAutoBotMuslLinux(options: MuslDetectionOptions = {}): boolean {
	if ((options.platform ?? process.platform) !== "linux") return false;
	if (options.alpineRelease ?? fs.existsSync("/etc/alpine-release")) return true;
	return /\bmusl\b/i.test(options.lddOutput ?? detectLddOutput() ?? "");
}

/** Exact release target identity used by both runtime and bootstrap assets. */
export function currentAutoBotRuntimeTarget(options: AutoBotRuntimeTargetOptions = {}): string {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported AutoBot architecture: ${arch}`);
	switch (platform) {
		case "win32":
			return `win32-${arch}`;
		case "darwin":
			return `darwin-${arch}`;
		case "linux":
			return isAutoBotMuslLinux(options) ? `linux-musl-${arch}` : `linux-${arch}`;
		default:
			throw new Error(`Unsupported AutoBot platform: ${platform}`);
	}
}
