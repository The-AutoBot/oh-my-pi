#!/usr/bin/env bun

import * as path from "node:path";
import type { AutoBotReleaseManifest } from "../packages/coding-agent/src/autobot-update/contract.ts";
import { isRecord } from "../packages/utils/src/type-guards.ts";
import {
	AutoBotReleaseError,
	assertKnownOptions,
	assertReleaseSequenceAfter,
	gitOutput,
	hashFile,
	loadTrustedKeys,
	optionalOption,
	parseAssetIndex,
	parseCliArgs,
	readJson,
	readVerifiedEnvelope,
	repeatedOption,
	requirePositiveSafeInteger,
	requireSha256,
	requireString,
	requiredOption,
	verifyIndexedAssets,
	type AssetIndex,
} from "./autobot-release-common.ts";
import {
	COORDINATOR_CLIENT_TARGET,
	parseCoordinatorClientProvenance,
	type CoordinatorClientProvenance,
} from "./autobot-release-coordinator.ts";
import { assertCompleteAutoBotReleaseTopology } from "./autobot-release-topology.ts";

interface ReleaseProvenance {
	readonly schemaVersion: 1;
	readonly compatibilityEpoch: number;
	readonly coordinatorSourceSha256: string;
	readonly source: {
		readonly forkCommit: string;
		readonly upstreamCommit: string;
		readonly upstreamVersion: string;
		readonly webBundleId: string;
		readonly sessionFormatVersion: number;
		readonly collabProtocolVersion: number;
	};
	readonly coordinatorSource: CoordinatorClientProvenance;
	readonly assets: AssetIndex["assets"];
}

function parseProvenance(value: unknown): ReleaseProvenance {
	if (!isRecord(value)) throw new AutoBotReleaseError("Release provenance must be an object");
	for (const key of Object.keys(value)) {
		if (!["schemaVersion", "compatibilityEpoch", "coordinatorSourceSha256", "source", "coordinatorSource", "assets"].includes(key)) {
			throw new AutoBotReleaseError(`Release provenance has an unsupported field: ${key}`);
		}
	}
	if (value.schemaVersion !== 1) throw new AutoBotReleaseError("Release provenance schemaVersion must be 1");
	if (!isRecord(value.source)) throw new AutoBotReleaseError("Release provenance source must be an object");
	for (const key of Object.keys(value.source)) {
		if (!["forkCommit", "upstreamCommit", "upstreamVersion", "webBundleId", "sessionFormatVersion", "collabProtocolVersion"].includes(key)) {
			throw new AutoBotReleaseError(`Release provenance source has an unsupported field: ${key}`);
		}
	}
	const sessionFormatVersion = value.source.sessionFormatVersion;
	if (typeof sessionFormatVersion !== "number") {
		throw new AutoBotReleaseError("Release provenance sessionFormatVersion must be a number");
	}
	const collabProtocolVersion = value.source.collabProtocolVersion;
	if (typeof collabProtocolVersion !== "number") {
		throw new AutoBotReleaseError("Release provenance collabProtocolVersion must be a number");
	}
	const compatibilityEpoch = value.compatibilityEpoch;
	if (typeof compatibilityEpoch !== "number") {
		throw new AutoBotReleaseError("Release provenance compatibilityEpoch must be a number");
	}
	return {
		schemaVersion: 1,
		compatibilityEpoch: requirePositiveSafeInteger(compatibilityEpoch, "Release provenance compatibilityEpoch"),
		coordinatorSourceSha256: requireSha256(
			requireString(value.coordinatorSourceSha256, "Release provenance coordinatorSourceSha256"),
			"Release provenance coordinatorSourceSha256",
		),
		source: {
			forkCommit: requireString(value.source.forkCommit, "Release provenance forkCommit"),
			upstreamCommit: requireString(value.source.upstreamCommit, "Release provenance upstreamCommit"),
			upstreamVersion: requireString(value.source.upstreamVersion, "Release provenance upstreamVersion"),
			webBundleId: requireString(value.source.webBundleId, "Release provenance webBundleId"),
			sessionFormatVersion,
			collabProtocolVersion,
		},
		coordinatorSource: parseCoordinatorClientProvenance(value.coordinatorSource),
		assets: parseAssetIndex({ schemaVersion: 1, assets: value.assets }).assets,
	};
}

function assertProvenance(manifest: AutoBotReleaseManifest, provenance: ReleaseProvenance): void {
	const source = provenance.source;
	if (
		source.forkCommit !== manifest.forkCommit ||
		source.upstreamCommit !== manifest.upstreamCommit ||
		source.upstreamVersion !== manifest.upstreamVersion ||
		source.webBundleId !== manifest.webBundleId ||
		source.sessionFormatVersion !== manifest.sessionFormatVersion ||
		source.collabProtocolVersion !== manifest.collabProtocolVersion ||
		provenance.compatibilityEpoch !== manifest.compatibilityEpoch
	) {
		throw new AutoBotReleaseError("Release provenance does not match the signed manifest");
	}
	const indexed = new Map(provenance.assets.map(asset => [`${asset.kind}\u0000${asset.target}`, asset.file]));
	if (indexed.size !== manifest.assets.length) throw new AutoBotReleaseError("Release provenance has a different asset count");
	for (const asset of manifest.assets) {
		if (!indexed.has(`${asset.kind}\u0000${asset.target}`)) {
			throw new AutoBotReleaseError(`Release provenance is missing ${asset.kind}/${asset.target}`);
		}
	}
	const coordinatorAsset = manifest.assets.find(
		asset => asset.kind === "coordinator-client" && asset.target === COORDINATOR_CLIENT_TARGET,
	);
	if (!coordinatorAsset) {
		throw new AutoBotReleaseError("Signed manifest is missing the universal coordinator-client asset");
	}
	if (
		coordinatorAsset.size !== provenance.coordinatorSource.artifact.size ||
		coordinatorAsset.sha256 !== provenance.coordinatorSource.artifact.sha256
	) {
		throw new AutoBotReleaseError("Signed coordinator-client asset does not match its pinned external source provenance");
	}
}
function sameCoordinatorSource(
	left: CoordinatorClientProvenance,
	right: CoordinatorClientProvenance,
): boolean {
	return (
		left.source.repository === right.source.repository &&
		left.source.commit === right.source.commit &&
		left.artifact.filename === right.artifact.filename &&
		left.artifact.sha256 === right.artifact.sha256 &&
		left.artifact.size === right.artifact.size
	);
}

async function assertCoordinatorSource(
	coordinatorSourcePath: string,
	expectedSha256: string,
	provenance: ReleaseProvenance,
): Promise<void> {
	const expected = requireSha256(expectedSha256, "Coordinator source provenance SHA-256");
	if (provenance.coordinatorSourceSha256 !== expected) {
		throw new AutoBotReleaseError("Release provenance coordinator source pin differs from the configured trusted SHA-256");
	}
	const actual = await hashFile(path.resolve(coordinatorSourcePath));
	if (actual.sha256 !== expected) {
		throw new AutoBotReleaseError("Coordinator source provenance does not match the configured trusted SHA-256 pin");
	}
	const source = parseCoordinatorClientProvenance(
		await readJson(path.resolve(coordinatorSourcePath), "coordinator source provenance"),
	);
	if (!sameCoordinatorSource(source, provenance.coordinatorSource)) {
		throw new AutoBotReleaseError("Release provenance coordinator source details do not match the pinned raw document");
	}
}


async function assertGitSource(
	sourceRoot: string,
	forkCommit: string,
	upstreamCommit: string,
	canonicalRef: string | undefined,
	releaseTag: string | undefined,
): Promise<void> {
	const fork = await gitOutput(sourceRoot, ["rev-parse", "--verify", `${forkCommit}^{commit}`]);
	if (fork !== forkCommit) throw new AutoBotReleaseError("Fork commit does not resolve exactly in the configured source repository");
	const upstream = await gitOutput(sourceRoot, ["rev-parse", "--verify", `${upstreamCommit}^{commit}`]);
	if (upstream !== upstreamCommit) throw new AutoBotReleaseError("Upstream commit does not resolve exactly in the configured source repository");
	await gitOutput(sourceRoot, ["merge-base", "--is-ancestor", upstreamCommit, forkCommit]);
	if (canonicalRef) {
		const canonical = await gitOutput(sourceRoot, ["rev-parse", "--verify", `${canonicalRef}^{commit}`]);
		if (canonical !== forkCommit) {
			throw new AutoBotReleaseError(`Configured canonical ref ${canonicalRef} does not point at the signed fork commit`);
		}
	}
	if (releaseTag) {
		const tagged = await gitOutput(sourceRoot, ["rev-parse", "--verify", `${releaseTag}^{commit}`]);
		if (tagged !== forkCommit) throw new AutoBotReleaseError(`Release tag ${releaseTag} does not point at the signed fork commit`);
	}
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	assertKnownOptions(args, [
		"envelope",
		"asset-index",
		"provenance",
		"trusted-key",
		"previous-envelope",
		"source-root",
		"canonical-ref",
		"release-tag",
		"coordinator-source",
		"coordinator-source-sha256",
	]);
	const trusted = await loadTrustedKeys(repeatedOption(args, "trusted-key"));
	if (trusted.keys.size === 0) {
		throw new AutoBotReleaseError("Verification requires at least one local --trusted-key keyId=public-key-path");
	}
	const verified = await readVerifiedEnvelope(path.resolve(requiredOption(args, "envelope")), trusted);
	assertCompleteAutoBotReleaseTopology(verified.manifest.assets);
	const indexPath = path.resolve(requiredOption(args, "asset-index"));
	await verifyIndexedAssets(verified.manifest, indexPath);
	const provenance = parseProvenance(await readJson(path.resolve(requiredOption(args, "provenance")), "release provenance"));
	assertProvenance(verified.manifest, provenance);
	const coordinatorSource = optionalOption(args, "coordinator-source");
	const coordinatorSourceSha256 = optionalOption(args, "coordinator-source-sha256");
	if ((coordinatorSource === undefined) !== (coordinatorSourceSha256 === undefined)) {
		throw new AutoBotReleaseError("--coordinator-source and --coordinator-source-sha256 must be supplied together");
	}
	if (coordinatorSource && coordinatorSourceSha256) {
		await assertCoordinatorSource(coordinatorSource, coordinatorSourceSha256, provenance);
	}
	const previousEnvelope = optionalOption(args, "previous-envelope");
	if (previousEnvelope) {
		const previous = await readVerifiedEnvelope(path.resolve(previousEnvelope), trusted);
		assertReleaseSequenceAfter(verified.manifest, previous.manifest);
	}
	const sourceRoot = optionalOption(args, "source-root");
	const canonicalRef = optionalOption(args, "canonical-ref");
	const releaseTag = optionalOption(args, "release-tag");
	if ((canonicalRef || releaseTag) && !sourceRoot) {
		throw new AutoBotReleaseError("--canonical-ref and --release-tag require --source-root");
	}
	if (sourceRoot) {
		await assertGitSource(path.resolve(sourceRoot), verified.manifest.forkCommit, verified.manifest.upstreamCommit, canonicalRef, releaseTag);
	}
	console.log(`Verified AutoBot release sequence ${verified.manifest.releaseSequence}`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		outputError(error);
		process.exitCode = 1;
	}
}
