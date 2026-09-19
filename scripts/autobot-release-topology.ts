import { AutoBotReleaseError } from "./autobot-release-common.ts";
import { COORDINATOR_CLIENT_TARGET } from "./autobot-release-coordinator.ts";
import { AUTO_BOT_RELEASE_REQUIRED_RUNTIME_TARGETS } from "./autobot-release-targets.ts";

interface ReleaseAssetIdentity {
	readonly kind: string;
	readonly target: string;
}

/** Require the exact producer-owned asset topology for every signed release. */
export function assertCompleteAutoBotReleaseTopology(assets: readonly ReleaseAssetIdentity[]): void {
	const expectedTargets: readonly string[] = AUTO_BOT_RELEASE_REQUIRED_RUNTIME_TARGETS;
	const runtimeTargets = new Set<string>();
	const bootstrapTargets = new Set<string>();
	const seenIdentities = new Set<string>();
	let coordinatorCount = 0;
	let collabWebCount = 0;
	for (const asset of assets) {
		const identity = `${asset.kind}\u0000${asset.target}`;
		if (seenIdentities.has(identity)) {
			throw new AutoBotReleaseError(`Release contains a duplicate asset identity: ${asset.kind}/${asset.target}`);
		}
		seenIdentities.add(identity);
		switch (asset.kind) {
			case "runtime":
				if (!expectedTargets.includes(asset.target)) {
					throw new AutoBotReleaseError(
						`Release contains a runtime target outside the required release topology: ${asset.target}`,
					);
				}
				runtimeTargets.add(asset.target);
				break;
			case "bootstrap":
				if (!expectedTargets.includes(asset.target)) {
					throw new AutoBotReleaseError(
						`Release contains a bootstrap target outside the required release topology: ${asset.target}`,
					);
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
		throw new AutoBotReleaseError(
			"Release must contain one runtime and one bootstrap for every required release target",
		);
	}
	if (coordinatorCount !== 1)
		throw new AutoBotReleaseError("Release must contain exactly one universal coordinator-client asset");
	if (collabWebCount !== 1) throw new AutoBotReleaseError("Release must contain exactly one web collab-web asset");
}
