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
