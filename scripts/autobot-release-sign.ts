#!/usr/bin/env bun

import * as path from "node:path";
import { AUTO_BOT_COMPATIBILITY_EPOCH } from "../packages/coding-agent/src/autobot-update/contract.ts";
import { COORDINATOR_CLIENT_TARGET, parseCoordinatorClientProvenance } from "./autobot-release-coordinator.ts";
import {
	AutoBotReleaseError,
	assertKnownOptions,
	assertReleaseSequenceAfter,
	hasOption,
	importEd25519PrivateKey,
	hashFile,
	loadTrustedKeys,
	outputError,
	optionalOption,
	parseCliArgs,
	parseUnsignedManifest,
	parseAssetIndex,
	readJson,
	readVerifiedEnvelope,
	repeatedOption,
	requireKeyId,
	requiredOption,
	requireSha256,
	signManifest,
	resolveIndexedPath,
	verifyIndexedAssets,
	writeJsonAtomic,
} from "./autobot-release-common.ts";
import { assertCompleteAutoBotReleaseTopology } from "./autobot-release-topology.ts";
import { verifyManagedBundleArchive } from "./autobot-release-web.ts";

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2), ["allow-initial"]);
	assertKnownOptions(args, [
		"manifest",
		"asset-index",
		"out",
		"key-id",
		"private-key",
		"previous-envelope",
		"trusted-key",
		"coordinator-source",
		"coordinator-source-sha256",
		"allow-initial",
	]);
	const manifestPath = path.resolve(requiredOption(args, "manifest"));
	const indexPath = path.resolve(requiredOption(args, "asset-index"));
	const outputPath = path.resolve(requiredOption(args, "out"));
	if (await Bun.file(outputPath).exists())
		throw new AutoBotReleaseError(`Refusing to overwrite signed envelope: ${outputPath}`);
	const manifest = parseUnsignedManifest(await readJson(manifestPath, "unsigned release manifest"));
	assertCompleteAutoBotReleaseTopology(manifest.assets);
	await verifyIndexedAssets(manifest, indexPath);
	if (manifest.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH) {
		throw new AutoBotReleaseError(
			"Unsigned release compatibility epoch does not match the trusted producer contract",
		);
	}
	const assetIndex = parseAssetIndex(await readJson(indexPath, "asset index"));
	const webAsset = manifest.assets.find(asset => asset.kind === "collab-web" && asset.target === "web");
	const webIndex = assetIndex.assets.find(asset => asset.kind === "collab-web" && asset.target === "web");
	if (!webAsset || !webIndex) throw new AutoBotReleaseError("Unsigned release is missing the web collab asset");
	await verifyManagedBundleArchive(resolveIndexedPath(path.dirname(indexPath), webIndex.file), {
		bundleId: manifest.webBundleId,
		forkCommit: manifest.forkCommit,
		upstreamCommit: manifest.upstreamCommit,
		upstreamVersion: manifest.upstreamVersion,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
	});
	const coordinatorSourcePath = path.resolve(requiredOption(args, "coordinator-source"));
	const expectedCoordinatorSourceSha256 = requireSha256(
		requiredOption(args, "coordinator-source-sha256"),
		"Coordinator source provenance SHA-256",
	);
	const actualCoordinatorSource = await hashFile(coordinatorSourcePath);
	if (actualCoordinatorSource.sha256 !== expectedCoordinatorSourceSha256) {
		throw new AutoBotReleaseError("Coordinator source provenance does not match the trusted configured SHA-256 pin");
	}
	const coordinatorSource = parseCoordinatorClientProvenance(
		await readJson(coordinatorSourcePath, "coordinator source provenance"),
	);
	const coordinatorAsset = manifest.assets.find(
		asset => asset.kind === "coordinator-client" && asset.target === COORDINATOR_CLIENT_TARGET,
	);
	if (
		!coordinatorAsset ||
		coordinatorAsset.sha256 !== coordinatorSource.artifact.sha256 ||
		coordinatorAsset.size !== coordinatorSource.artifact.size
	) {
		throw new AutoBotReleaseError(
			"Signed coordinator-client asset does not match the trusted pinned coordinator provenance",
		);
	}
	const previousEnvelope = optionalOption(args, "previous-envelope");
	const allowInitial = hasOption(args, "allow-initial");
	if (previousEnvelope) {
		if (allowInitial) throw new AutoBotReleaseError("--allow-initial cannot be used with --previous-envelope");
		const trusted = await loadTrustedKeys(repeatedOption(args, "trusted-key"));
		if (trusted.keys.size === 0) {
			throw new AutoBotReleaseError(
				"--previous-envelope requires at least one locally configured --trusted-key keyId=public-key-path",
			);
		}
		const previous = await readVerifiedEnvelope(path.resolve(previousEnvelope), trusted);
		assertReleaseSequenceAfter(manifest, previous.manifest);
	} else if (!allowInitial) {
		throw new AutoBotReleaseError(
			"A prior signed channel envelope is required. Use --previous-envelope with local --trusted-key configuration, or explicitly approve the first release with --allow-initial.",
		);
	}
	const keyId = requireKeyId(requiredOption(args, "key-id"));
	const signingKey = await importEd25519PrivateKey(requiredOption(args, "private-key"));
	const envelope = await signManifest(manifest, keyId, signingKey);
	await writeJsonAtomic(outputPath, envelope);
	console.log(`Signed AutoBot release sequence ${manifest.releaseSequence} with key ID ${keyId}`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		outputError(error);
		process.exitCode = 1;
	}
}
