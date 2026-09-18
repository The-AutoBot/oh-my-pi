import { type } from "@oh-my-pi/omptype";
import {
	AUTO_BOT_COLLAB_PROTOCOL_VERSION,
	AUTO_BOT_COMPATIBILITY_EPOCH,
	AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
	AUTO_BOT_RELEASE_SCHEMA_VERSION,
	AUTO_BOT_SESSION_FORMAT_VERSION,
} from "./contract";

declare const OMP_AUTOBOT_BOOTSTRAP_IDENTITY: string | undefined;

export interface AutoBotBootstrapIdentity {
	readonly schemaVersion: 1;
	readonly bootstrapVersion: 1;
	readonly target: string;
	readonly sessionFormatVersion: number;
	readonly collabProtocolVersion: number;
	readonly compatibilityEpoch: number;
}

const BootstrapIdentitySchema = type({
	schemaVersion: "1",
	bootstrapVersion: "number.integer > 0",
	target: "string > 0",
	sessionFormatVersion: "number.integer > 0",
	collabProtocolVersion: "number.integer > 0",
	compatibilityEpoch: "number.integer > 0",
});

export function parseAutoBotBootstrapIdentity(value: unknown): AutoBotBootstrapIdentity {
	const identity = BootstrapIdentitySchema.assert(value);
	if (
		identity.schemaVersion !== AUTO_BOT_RELEASE_SCHEMA_VERSION ||
		identity.bootstrapVersion !== AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION ||
		identity.sessionFormatVersion !== AUTO_BOT_SESSION_FORMAT_VERSION ||
		identity.collabProtocolVersion !== AUTO_BOT_COLLAB_PROTOCOL_VERSION ||
		identity.compatibilityEpoch !== AUTO_BOT_COMPATIBILITY_EPOCH ||
		!/^(?:win32|darwin|linux)(?:-musl)?-(?:x64|arm64)$/.test(identity.target)
	) {
		throw new Error("Embedded AutoBot bootstrap identity is incompatible");
	}
	return {
		schemaVersion: AUTO_BOT_RELEASE_SCHEMA_VERSION,
		bootstrapVersion: AUTO_BOT_MINIMUM_BOOTSTRAP_VERSION,
		target: identity.target,
		sessionFormatVersion: AUTO_BOT_SESSION_FORMAT_VERSION,
		collabProtocolVersion: AUTO_BOT_COLLAB_PROTOCOL_VERSION,
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
	};
}

/** Bootstrap probes fail closed unless release tooling embedded this exact identity. */
export function getAutoBotBootstrapIdentity(): AutoBotBootstrapIdentity {
	if (typeof OMP_AUTOBOT_BOOTSTRAP_IDENTITY !== "string") {
		throw new Error("AutoBot bootstrap has no embedded identity");
	}
	try {
		return parseAutoBotBootstrapIdentity(JSON.parse(OMP_AUTOBOT_BOOTSTRAP_IDENTITY));
	} catch (error) {
		throw new Error("AutoBot bootstrap embedded identity is invalid", { cause: error });
	}
}
