import { AutoBotReleaseError } from "./autobot-release-common.ts";
import { COORDINATOR_CLIENT_TARGET } from "./autobot-release-coordinator.ts";
import { AUTO_BOT_RUNTIME_TARGETS } from "./autobot-release-targets.ts";

interface ReleaseAssetIdentity {
	readonly kind: string;
	readonly target: string;
}

/** Require every signed release to carry the complete immutable runtime target set. */
export function assertCompleteAutoBotReleaseTopology(assets: readonly ReleaseAssetIdentity[]): void {
	const expectedTargets = Object.keys(AUTO_BOT_RUNTIME_TARGETS);
	const runtimeTargets = new Set<string>();
	const bootstrapTargets = new Set<string>();
	let coordinatorCount = 0;
	let collabWebCount = 0;
	for (const asset of assets) {
		switch (asset.kind) {
			case "runtime":
				if (!Object.hasOwn(AUTO_BOT_RUNTIME_TARGETS, asset.target)) {
					throw new AutoBotReleaseError(`Release contains an unsupported runtime target: ${asset.target}`);
				}
				runtimeTargets.add(asset.target);
				break;
			case "bootstrap":
				if (!Object.hasOwn(AUTO_BOT_RUNTIME_TARGETS, asset.target)) {
					throw new AutoBotReleaseError(`Release contains an unsupported bootstrap target: ${asset.target}`);
				}
				bootstrapTargets.add(asset.target);
				break;
			case "coordinator-client":
				if (asset.target !== COORDINATOR_CLIENT_TARGET) {
					throw new AutoBotReleaseError(`Coordinator-client target must be ${COORDINATOR_CLIENT_TARGET}`);
				}
				coordinatorCount++;
				break;
			case "collab-web":
				if (asset.target !== "web") throw new AutoBotReleaseError("Collab-web target must be web");
				collabWebCount++;
				break;
			default:
				throw new AutoBotReleaseError(`Release contains an unsupported asset kind: ${asset.kind}`);
		}
	}
	if (
		runtimeTargets.size !== expectedTargets.length ||
		bootstrapTargets.size !== expectedTargets.length ||
		expectedTargets.some(target => !runtimeTargets.has(target) || !bootstrapTargets.has(target))
	) {
		throw new AutoBotReleaseError("Release must contain one runtime and one bootstrap for every supported target");
	}
	if (coordinatorCount !== 1) throw new AutoBotReleaseError("Release must contain exactly one universal coordinator-client asset");
	if (collabWebCount !== 1) throw new AutoBotReleaseError("Release must contain exactly one web collab-web asset");
}
