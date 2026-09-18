import { type } from "@oh-my-pi/omptype";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
	type AutoBotReleaseManifest,
} from "./contract";

declare const OMP_AUTOBOT_BUILD_IDENTITY: string | undefined;

export interface AutoBotBuildIdentity {
	readonly schemaVersion: 1;
	readonly releaseSequence: number;
	readonly upstreamVersion: string;
	readonly forkCommit: string;
	readonly upstreamCommit: string;
	readonly sessionFormatVersion: number;
	readonly collabProtocolVersion: number;
	readonly compatibilityEpoch: number;
}

const BuildIdentitySchema = type({
	schemaVersion: "1",
	releaseSequence: "number.integer > 0",
	upstreamVersion: "string > 0",
	forkCommit: "string > 0",
	upstreamCommit: "string > 0",
	sessionFormatVersion: "number.integer > 0",
	collabProtocolVersion: "number.integer > 0",
	compatibilityEpoch: "number.integer > 0",
});

function compiledIdentityText(): string | undefined {
	return typeof OMP_AUTOBOT_BUILD_IDENTITY === "string" ? OMP_AUTOBOT_BUILD_IDENTITY : undefined;
}

/** An embedded identity marks a fork runtime that must never self-update from upstream. */
export function isAutoBotCustomBuild(): boolean {
	return compiledIdentityText() !== undefined;
}

export function getAutoBotBuildIdentity(): AutoBotBuildIdentity | undefined {
	const text = compiledIdentityText();
	if (text === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Embedded AutoBot build identity is invalid");
	}
	const identity = BuildIdentitySchema.assert(value);
	if (
		identity.schemaVersion !== AUTO_BOT_RELEASE_SCHEMA_VERSION ||
		identity.sessionFormatVersion !== AUTO_BOT_SESSION_FORMAT_VERSION ||
		identity.collabProtocolVersion !== AUTO_BOT_COLLAB_PROTOCOL_VERSION ||
		identity.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH ||
		!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(identity.upstreamVersion) ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(identity.forkCommit) ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(identity.upstreamCommit)
	) {
		throw new Error("Embedded AutoBot build identity is incompatible with this runtime");
	}
	return identity;
}

export function assertAutoBotBuildIdentityMatches(identity: AutoBotBuildIdentity, manifest: AutoBotReleaseManifest): void {
	if (
		identity.releaseSequence !== manifest.releaseSequence ||
		identity.upstreamVersion !== manifest.upstreamVersion ||
		identity.forkCommit !== manifest.forkCommit ||
		identity.upstreamCommit !== manifest.upstreamCommit ||
		identity.sessionFormatVersion !== manifest.sessionFormatVersion ||
		identity.collabProtocolVersion !== manifest.collabProtocolVersion ||
		identity.compatibilityEpoch !== manifest.compatibilityEpoch
	) {
		throw new Error("Embedded AutoBot build identity does not match the signed release");
	}
}
