export interface AutoBotRuntimeTarget {
	readonly platform: "darwin" | "linux" | "win32";
	readonly arch: "arm64" | "x64";
	readonly libc: "glibc" | "musl" | "none";
}

/**
 * Signed runtime/bootstrap target IDs intentionally match existing release-binary
 * artifact IDs. `baseline` belongs to Bun's internal compile target, not the
 * public manifest selector, and musl uses the established linux-musl-* spelling.
 */
export const AUTO_BOT_RUNTIME_TARGETS: Record<string, AutoBotRuntimeTarget> = {
	"darwin-arm64": { platform: "darwin", arch: "arm64", libc: "none" },
	"darwin-x64": { platform: "darwin", arch: "x64", libc: "none" },
	"linux-arm64": { platform: "linux", arch: "arm64", libc: "glibc" },
	"linux-musl-arm64": { platform: "linux", arch: "arm64", libc: "musl" },
	"linux-musl-x64": { platform: "linux", arch: "x64", libc: "musl" },
	"linux-x64": { platform: "linux", arch: "x64", libc: "glibc" },
	"win32-arm64": { platform: "win32", arch: "arm64", libc: "none" },
	"win32-x64": { platform: "win32", arch: "x64", libc: "none" },
};

/**
 * Exact target set required when producing a signed AutoBot release locally.
 *
 * The broader runtime map above remains the consumer and legacy-tooling
 * selector; producer completeness is intentionally a separate policy.
 */
export const AUTO_BOT_RELEASE_REQUIRED_RUNTIME_TARGETS = ["win32-x64"] as const;

export function assertAutoBotRuntimeTarget(value: string): AutoBotRuntimeTarget {
	if (!Object.hasOwn(AUTO_BOT_RUNTIME_TARGETS, value)) {
		throw new Error(`Unsupported AutoBot runtime/bootstrap target: ${value}`);
	}
	return AUTO_BOT_RUNTIME_TARGETS[value]!;
}
