export interface LocalAutomationConfig {
	readonly schemaVersion: 1;
	readonly repository: string;
	readonly canonicalBranch: string;
	readonly integrationBranch: string;
	readonly upstreamRepository: string;
	readonly upstreamRef: string;
	readonly workRoot: string;
	readonly runnerBun: string;
	readonly runnerBunVersion: string;
	readonly compilerBun: string;
	readonly compilerBunVersion: string;
	readonly nativeAddonDirectory: string;
	readonly nativeAddonProvenanceSha256: string;
	readonly ompExecutable: string;
	readonly coordinatorRoot: string;
	readonly keyId: string;
	readonly privateKeyPath: string;
	readonly publicKeyPath: string;
	readonly channelRepository: string;
	readonly channelBranch: string;
	readonly channelPath: string;
	readonly allowInitial: boolean;
	readonly maxOmpAttempts: number;
	readonly ompMaxTime: string;
}

/** The exact published release/tag observed from the configured official source. */
export interface OfficialUpstreamRelease {
	readonly tag: string;
	readonly ref: string;
	readonly commit: string;
}

export interface ObservedOfficialUpstreamRelease extends OfficialUpstreamRelease {
	readonly version: string;
}

/**
 * The source identity retained by the candidate. This can be newer than the
 * current official observation when an upstream release endpoint moves backward.
 */
export interface EffectiveUpstreamBase {
	readonly commit: string;
	readonly version: string;
}

export interface LocalCandidate {
	readonly sourceRoot: string;
	readonly forkCommit: string;
	readonly upstreamCommit: string;
	readonly upstreamVersion: string;
	readonly compatibilityEpoch: number;
	readonly changed: boolean;
	readonly sensitivePaths: readonly string[];
}

export const REPAIRABLE_STEP_IDS = [
	"browser-relay-build",
	"browser-relay-output",
	"collab-web-build",
	"runtime-compilation",
	"runtime-output",
	"runtime-version-check",
	"runtime-application-check",
	"runtime-smoke-test",
	"runtime-identity-check",
	"bootstrap-compilation",
	"bootstrap-output",
	"collab-web-bundle-identity",
	"collab-web-packaging",
] as const;

/** Closed identities for application build and smoke steps eligible for source repair. */
export type RepairableStepId = (typeof REPAIRABLE_STEP_IDS)[number];

/**
 * Controller-derived source boundary for one failed application step.
 * It never carries commands or permission to skip or resume pipeline steps.
 */
export interface FailedStepContext {
	readonly stepId: RepairableStepId;
	readonly permittedSourcePaths: readonly string[];
}

/** The only application source roots a failed step can authorize for repair. */
export const REPAIRABLE_STEP_SOURCE_PATHS: Readonly<Record<RepairableStepId, readonly string[]>> = Object.freeze({
	"browser-relay-build": Object.freeze(["packages/browser-relay/extension"]),
	"browser-relay-output": Object.freeze(["packages/browser-relay/extension"]),
	"collab-web-build": Object.freeze(["packages/collab-web/src", "packages/collab-web/public"]),
	"runtime-compilation": Object.freeze(["packages/coding-agent/src"]),
	"runtime-output": Object.freeze(["packages/coding-agent/src"]),
	"runtime-version-check": Object.freeze(["packages/coding-agent/src"]),
	"runtime-application-check": Object.freeze(["packages/coding-agent/src"]),
	"runtime-smoke-test": Object.freeze(["packages/coding-agent/src"]),
	"runtime-identity-check": Object.freeze(["packages/coding-agent/src"]),
	"bootstrap-compilation": Object.freeze(["packages/coding-agent/src"]),
	"bootstrap-output": Object.freeze(["packages/coding-agent/src"]),
	"collab-web-bundle-identity": Object.freeze(["packages/collab-web/src", "packages/collab-web/public"]),
	"collab-web-packaging": Object.freeze(["packages/collab-web/src", "packages/collab-web/public"]),
});
