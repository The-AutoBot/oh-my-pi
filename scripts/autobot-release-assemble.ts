#!/usr/bin/env bun

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
	serializeAutoBotReleaseManifest,
	type AutoBotReleaseAsset,
	type AutoBotReleaseManifest,
} from "../packages/coding-agent/src/autobot-update/contract.ts";
import {
	AutoBotReleaseError,
	assertKnownOptions,
	createEmptyDirectory,
	hashFile,
	optionalOption,
	outputError,
	parseCliArgs,
	parseUnsignedManifest,
	readAssetInputs,
	readJson,
	requireCommit,
	requirePositiveSafeInteger,
	requireRegularFile,
	requireSha256,
	requiredOption,
	requireString,
	writeJsonAtomic,
	writeTextAtomic,
	type AssetIndex,
	type AssetIndexEntry,
	type AssetInput,
} from "./autobot-release-common.ts";
import {
	COORDINATOR_CLIENT_FILENAME,
	COORDINATOR_CLIENT_TARGET,
	parseCoordinatorClientProvenance,
	type CoordinatorClientProvenance,
} from "./autobot-release-coordinator.ts";
import { verifyManagedBundleArchive } from "./autobot-release-web.ts";
import { assertCompleteAutoBotReleaseTopology } from "./autobot-release-topology.ts";

const SAFE_ASSET_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;


interface StagedAsset {
	readonly asset: AutoBotReleaseAsset;
	readonly index: AssetIndexEntry;
}

function canonicalPublishedAt(value: string | undefined): string {
	const timestamp = value ?? new Date().toISOString();
	const parsed = new Date(timestamp);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
		throw new AutoBotReleaseError("--published-at must be a canonical ISO-8601 UTC timestamp");
	}
	return timestamp;
}

function assetFilename(source: string, url: string): string {
	const filename = path.basename(source);
	if (!SAFE_ASSET_FILENAME.test(filename)) {
		throw new AutoBotReleaseError(`Release asset filename must be safe and portable: ${filename}`);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (error) {
		throw new AutoBotReleaseError(`Release asset URL is invalid: ${url}`, { cause: error });
	}
	const urlFilename = decodeURIComponent(parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1));
	if (urlFilename !== filename) {
		throw new AutoBotReleaseError(`Release asset URL must end in its staged filename: ${filename}`);
	}
	return filename;
}

function assertAssetTopology(inputs: readonly AssetInput[], webBundleId: string): void {
	assertCompleteAutoBotReleaseTopology(inputs);
	for (const input of inputs) {
		if (
			input.kind === "coordinator-client" &&
			path.basename(input.source) !== COORDINATOR_CLIENT_FILENAME
		) {
			throw new AutoBotReleaseError(`coordinator-client filename must be ${COORDINATOR_CLIENT_FILENAME}`);
		}
		if (
			input.kind === "collab-web" &&
			path.basename(input.source) !== `omp-collab-web-${webBundleId}.tar.gz`
		) {
			throw new AutoBotReleaseError(`collab-web filename must be omp-collab-web-${webBundleId}.tar.gz`);
		}
	}
}

async function stageAsset(
	input: AssetInput,
	assetsDirectory: string,
	forkCommit: string,
	upstreamCommit: string,
	upstreamVersion: string,
	webBundleId: string,
	seenNames: Set<string>,
	coordinatorProvenance: CoordinatorClientProvenance,
): Promise<StagedAsset> {
	const source = path.resolve(input.source);
	await requireRegularFile(source, "Release input asset");
	const filename = assetFilename(source, input.url);
	if (seenNames.has(filename)) throw new AutoBotReleaseError(`Release assets reuse filename ${filename}`);
	seenNames.add(filename);
	if (input.kind === "collab-web") {
		await verifyManagedBundleArchive(source, {
			bundleId: webBundleId,
			forkCommit,
			upstreamCommit,
			upstreamVersion,
			compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		});
	}
	const stagedRelative = `assets/${filename}`;
	const staged = path.join(assetsDirectory, filename);
	await fs.copyFile(source, staged, fsConstants.COPYFILE_EXCL);
	if (input.kind === "collab-web") {
		await verifyManagedBundleArchive(staged, {
			bundleId: webBundleId,
			forkCommit,
			upstreamCommit,
			upstreamVersion,
			compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		});
	}
	const hashed = await hashFile(staged);
	if (
		input.kind === "coordinator-client" &&
		(hashed.size !== coordinatorProvenance.artifact.size || hashed.sha256 !== coordinatorProvenance.artifact.sha256)
	) {
		throw new AutoBotReleaseError("Coordinator-client artifact does not match its explicit pinned source provenance");
	}
	return {
		asset: { kind: input.kind, target: input.target, url: input.url, size: hashed.size, sha256: hashed.sha256 },
		index: { kind: input.kind, target: input.target, file: stagedRelative },
	};
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	assertKnownOptions(args, [
		"out",
		"assets",
		"release-sequence",
		"upstream-version",
		"fork-commit",
		"upstream-commit",
		"web-bundle-id",
		"published-at",
		"coordinator-source",
		"coordinator-source-sha256",
	]);
	const output = await createEmptyDirectory(requiredOption(args, "out"), "Release output directory");
	const releaseSequence = requirePositiveSafeInteger(
		Number(requiredOption(args, "release-sequence")),
		"release sequence",
	);
	const upstreamVersion = requireString(requiredOption(args, "upstream-version"), "upstream version");
	const forkCommit = requireCommit(requiredOption(args, "fork-commit"), "Fork commit");
	const upstreamCommit = requireCommit(requiredOption(args, "upstream-commit"), "Upstream commit");
	const webBundleId = requireString(requiredOption(args, "web-bundle-id"), "web bundle ID");
	const inputs = await readAssetInputs(requiredOption(args, "assets"));
	const coordinatorSourcePath = path.resolve(requiredOption(args, "coordinator-source"));
	const expectedCoordinatorSourceSha256 = requireSha256(
		requiredOption(args, "coordinator-source-sha256"),
		"Coordinator source provenance SHA-256",
	);
	const coordinatorSourceHash = await hashFile(coordinatorSourcePath);
	if (coordinatorSourceHash.sha256 !== expectedCoordinatorSourceSha256) {
		throw new AutoBotReleaseError("Coordinator source provenance does not match the trusted configured SHA-256 pin");
	}
	const coordinatorProvenance = parseCoordinatorClientProvenance(
		await readJson(coordinatorSourcePath, "coordinator source provenance"),
	);
	assertAssetTopology(inputs, webBundleId);
	const assetsDirectory = path.join(output, "assets");
	await fs.mkdir(assetsDirectory);
	const seenNames = new Set<string>();
	const staged: StagedAsset[] = [];
	for (const input of inputs) {
		staged.push(
			await stageAsset(
				input,
				assetsDirectory,
				forkCommit,
				upstreamCommit,
				upstreamVersion,
				webBundleId,
				seenNames,
				coordinatorProvenance,
			),
		);
	}
	const manifest: AutoBotReleaseManifest = parseUnsignedManifest({
		schemaVersion: AUTO_BOT_RELEASE_SCHEMA_VERSION,
		releaseSequence,
		upstreamVersion,
		forkCommit,
		upstreamCommit,
		publishedAt: canonicalPublishedAt(optionalOption(args, "published-at")),
		minimumBootstrapVersion: AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
		webBundleId,
		assets: staged.map(item => item.asset),
	});
	const index: AssetIndex = { schemaVersion: 1, assets: staged.map(item => item.index) };
	await Promise.all([
		writeTextAtomic(path.join(output, "manifest.json"), serializeAutoBotReleaseManifest(manifest)),
		writeJsonAtomic(path.join(output, "asset-index.json"), index),
		writeJsonAtomic(path.join(output, "provenance.json"), {
			schemaVersion: 1,
			compatibilityEpoch: manifest.compatibilityEpoch,
			coordinatorSourceSha256: expectedCoordinatorSourceSha256,
			source: {
				forkCommit: manifest.forkCommit,
				upstreamCommit: manifest.upstreamCommit,
				upstreamVersion: manifest.upstreamVersion,
				webBundleId: manifest.webBundleId,
				sessionFormatVersion: manifest.sessionFormatVersion,
				collabProtocolVersion: manifest.collabProtocolVersion,
			},
			coordinatorSource: coordinatorProvenance,
			assets: index.assets,
		}),
		fs.copyFile(coordinatorSourcePath, path.join(output, "coordinator-source.json"), fsConstants.COPYFILE_EXCL),
	]);
	console.log(`Assembled AutoBot release sequence ${manifest.releaseSequence} in ${output}`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		outputError(error);
		process.exitCode = 1;
	}
}
