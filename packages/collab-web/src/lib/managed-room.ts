import { parseCollabLink } from "./link";
import { isRecord } from "./type-guards";

export interface ManagedRoomRoute {
	readonly pcId: string;
	readonly sessionId: string;
}

const PC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Returns a coordinator route only when both non-secret routing identities are present and valid. */
export function managedRoomRoute(search: URLSearchParams): ManagedRoomRoute | null {
	const pcIds = search.getAll("pcId");
	const sessionIds = search.getAll("sessionId");
	if (pcIds.length !== 1 || sessionIds.length !== 1) return null;
	const pcId = pcIds[0];
	const sessionId = sessionIds[0];
	if (
		pcId === undefined ||
		sessionId === undefined ||
		!PC_ID_PATTERN.test(pcId) ||
		sessionId.length === 0 ||
		sessionId.length > 200 ||
		sessionId === "*"
	) {
		return null;
	}
	return { pcId, sessionId };
}

/** Removes coordinator routing and the room capability when a guest deliberately leaves. */
export function managedLeaveHref(currentUrl: URL): string {
	const next = new URL(currentUrl.href);
	next.searchParams.delete("pcId");
	next.searchParams.delete("sessionId");
	return `${next.pathname}${next.search}`;
}

/**
 * Selects a replacement only for this exact dashboard identity. The capability
 * stays in the fragment; routing IDs are restored as ordinary query parameters.
 */
export function managedReplacementHref(payload: unknown, currentUrl: URL, route: ManagedRoomRoute): string | null {
	const currentRoute = managedRoomRoute(currentUrl.searchParams);
	// A manual leave strips these IDs synchronously. Do not let a response from
	// its already-running discovery request restore a fresh room capability.
	if (currentRoute?.pcId !== route.pcId || currentRoute.sessionId !== route.sessionId) return null;
	if (!isRecord(payload) || !Array.isArray(payload.pcs) || !Array.isArray(payload.sessions)) return null;
	if (!payload.pcs.some(pc => isRecord(pc) && pc.pcId === route.pcId)) return null;
	const session = payload.sessions.find(
		candidate => isRecord(candidate) && candidate.pcId === route.pcId && candidate.sessionId === route.sessionId,
	);
	if (
		!isRecord(session) ||
		!isRecord(session.room) ||
		typeof session.room.webLink !== "string" ||
		typeof session.room.expiresAt !== "string"
	) {
		return null;
	}
	const expirationMs = Date.parse(session.room.expiresAt);
	if (!Number.isFinite(expirationMs) || expirationMs <= Date.now()) {
		return null;
	}

	let replacement: URL;
	try {
		replacement = new URL(session.room.webLink);
	} catch {
		return null;
	}
	if (
		replacement.origin !== currentUrl.origin ||
		normalizedLivePath(replacement.pathname) !== "/live" ||
		normalizedLivePath(currentUrl.pathname) !== "/live" ||
		replacement.username ||
		replacement.password ||
		replacement.hash.length <= 1 ||
		"error" in parseCollabLink(replacement.hash.slice(1))
	) {
		return null;
	}
	replacement.search = "";
	replacement.searchParams.set("pcId", route.pcId);
	replacement.searchParams.set("sessionId", route.sessionId);
	if (replacement.hash === currentUrl.hash) return null;
	return replacement.href;
}
function normalizedLivePath(pathname: string): string {
	return pathname.replace(/\/+$/u, "") || "/";
}
