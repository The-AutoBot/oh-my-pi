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

export interface LocalCandidate {
	readonly sourceRoot: string;
	readonly forkCommit: string;
	readonly upstreamCommit: string;
	readonly upstreamVersion: string;
	readonly compatibilityEpoch: number;
	readonly changed: boolean;
	readonly sensitivePaths: readonly string[];
}
