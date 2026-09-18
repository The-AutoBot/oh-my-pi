#!/usr/bin/env bun

import { isRecord } from "../packages/utils/src/type-guards.ts";
import {
	AutoBotReleaseError,
	requireCommit,
	requirePositiveSafeInteger,
	requireSha256,
	requireString,
} from "./autobot-release-common.ts";

export const COORDINATOR_CLIENT_TARGET = "universal";
export const COORDINATOR_CLIENT_FILENAME = "omp-session-coordinator-extension.mjs";

export interface CoordinatorClientProvenance {
	readonly schemaVersion: 1;
	readonly source: {
		readonly repository: string;
		readonly commit: string;
	};
	readonly artifact: {
		readonly filename: typeof COORDINATOR_CLIENT_FILENAME;
		readonly sha256: string;
		readonly size: number;
	};
}

function requireHttpsRepository(value: unknown): string {
	const repository = requireString(value, "Coordinator source repository");
	let url: URL;
	try {
		url = new URL(repository);
	} catch (error) {
		throw new AutoBotReleaseError("Coordinator source repository must be an explicit HTTPS URL", { cause: error });
	}
	if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
		throw new AutoBotReleaseError("Coordinator source repository must be an HTTPS URL without credentials, query, or fragment");
	}
	return repository;
}

/** Parse independently produced, pinned coordinator-client provenance before packaging its bytes. */
export function parseCoordinatorClientProvenance(value: unknown): CoordinatorClientProvenance {
	if (!isRecord(value)) throw new AutoBotReleaseError("Coordinator source provenance must be an object");
	for (const key of Object.keys(value)) {
		if (!["schemaVersion", "source", "artifact"].includes(key)) {
			throw new AutoBotReleaseError(`Coordinator source provenance has an unsupported field: ${key}`);
		}
	}
	if (value.schemaVersion !== 1) throw new AutoBotReleaseError("Coordinator source provenance schemaVersion must be 1");
	if (!isRecord(value.source)) throw new AutoBotReleaseError("Coordinator source provenance source must be an object");
	for (const key of Object.keys(value.source)) {
		if (!["repository", "commit"].includes(key)) {
			throw new AutoBotReleaseError(`Coordinator source provenance source has an unsupported field: ${key}`);
		}
	}
	if (!isRecord(value.artifact)) throw new AutoBotReleaseError("Coordinator source provenance artifact must be an object");
	for (const key of Object.keys(value.artifact)) {
		if (!["filename", "sha256", "size"].includes(key)) {
			throw new AutoBotReleaseError(`Coordinator source provenance artifact has an unsupported field: ${key}`);
		}
	}
	const filename = requireString(value.artifact.filename, "Coordinator artifact filename");
	if (filename !== COORDINATOR_CLIENT_FILENAME) {
		throw new AutoBotReleaseError(`Coordinator artifact filename must be ${COORDINATOR_CLIENT_FILENAME}`);
	}
	return {
		schemaVersion: 1,
		source: {
			repository: requireHttpsRepository(value.source.repository),
			commit: requireCommit(requireString(value.source.commit, "Coordinator source commit"), "Coordinator source commit"),
		},
		artifact: {
			filename: COORDINATOR_CLIENT_FILENAME,
			sha256: requireSha256(requireString(value.artifact.sha256, "Coordinator artifact SHA-256"), "Coordinator artifact SHA-256"),
			size: requirePositiveSafeInteger(value.artifact.size, "Coordinator artifact size"),
		},
	};
}
