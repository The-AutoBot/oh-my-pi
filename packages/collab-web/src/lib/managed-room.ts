import { parseCollabLink } from "./link";
import type { RestartDraftScope } from "./restart-drafts";
import { isRecord } from "./type-guards";

export interface ManagedRoomRoute {
	readonly pcId: string;
	readonly sessionId: string;
}

/**
 * A route that names a managed session stays inert until authenticated
 * discovery binds its exact draft scope. It must never briefly use the manual
 * scope and strand a draft when that binding arrives.
 */
export function resolveDraftScopeForRoute(
	route: ManagedRoomRoute | null,
	managedDraftScope: RestartDraftScope | null,
	sessionId: string,
): RestartDraftScope | "manual" | null {
	if (route === null) return "manual";
	return managedDraftScope?.sessionId === sessionId ? managedDraftScope : null;
}

const PC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WEB_BUNDLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

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
 * Bounded discovery states suitable for browser diagnostics. Only a validated
 * replacement carries a URL, and callers must keep that URL out of diagnostics.
 */
export type ManagedRoomReplacementResult =
	| { readonly stage: "inactive" }
	| {
			readonly stage: "payload";
			readonly code: "invalid-envelope" | "invalid-room" | "invalid-replacement";
	  }
	| { readonly stage: "session"; readonly code: "pc-missing" | "session-missing" }
	| { readonly stage: "room"; readonly code: "missing" | "expired" }
	| { readonly stage: "ready"; readonly code: "unchanged" }
	| { readonly stage: "ready"; readonly code: "replacement-ready"; readonly href: string };

/**
 * Classifies a coordinator response and selects a replacement only for this
 * exact dashboard identity. The capability stays in the fragment; routing IDs
 * are restored as ordinary query parameters.
 */
export function managedRoomReplacement(
	payload: unknown,
	currentUrl: URL,
	route: ManagedRoomRoute,
): ManagedRoomReplacementResult {
	const currentRoute = managedRoomRoute(currentUrl.searchParams);
	// A manual leave strips these IDs synchronously. Do not let a response from
	// its already-running discovery request restore a fresh room capability.
	if (currentRoute?.pcId !== route.pcId || currentRoute.sessionId !== route.sessionId) {
		return { stage: "inactive" };
	}
	if (!isRecord(payload) || !Array.isArray(payload.pcs) || !Array.isArray(payload.sessions)) {
		return { stage: "payload", code: "invalid-envelope" };
	}
	if (!payload.pcs.some(pc => isRecord(pc) && pc.pcId === route.pcId)) {
		return { stage: "session", code: "pc-missing" };
	}
	const session = payload.sessions.find(
		candidate => isRecord(candidate) && candidate.pcId === route.pcId && candidate.sessionId === route.sessionId,
	);
	if (!isRecord(session)) return { stage: "session", code: "session-missing" };
	if (session.room === undefined || session.room === null) return { stage: "room", code: "missing" };
	if (
		!isRecord(session.room) ||
		typeof session.room.webLink !== "string" ||
		typeof session.room.expiresAt !== "string"
	) {
		return { stage: "payload", code: "invalid-room" };
	}
	const expirationMs = Date.parse(session.room.expiresAt);
	if (!Number.isFinite(expirationMs)) return { stage: "payload", code: "invalid-room" };
	if (expirationMs <= Date.now()) return { stage: "room", code: "expired" };

	let replacement: URL;
	try {
		replacement = new URL(session.room.webLink);
	} catch {
		return { stage: "payload", code: "invalid-replacement" };
	}
	const replacementPath = normalizedLivePath(replacement.pathname);
	const currentPath = normalizedLivePath(currentUrl.pathname);
	if (
		replacement.origin !== currentUrl.origin ||
		replacementPath === null ||
		currentPath === null ||
		replacement.username ||
		replacement.password ||
		replacement.hash.length <= 1 ||
		"error" in parseCollabLink(replacement.hash.slice(1))
	) {
		return { stage: "payload", code: "invalid-replacement" };
	}
	replacement.search = "";
	replacement.searchParams.set("pcId", route.pcId);
	replacement.searchParams.set("sessionId", route.sessionId);
	if (replacementPath === currentPath && replacement.hash === currentUrl.hash) {
		return { stage: "ready", code: "unchanged" };
	}
	return { stage: "ready", code: "replacement-ready", href: replacement.href };
}

/** Selects only a validated replacement, preserving the former nullable API. */
export function managedReplacementHref(payload: unknown, currentUrl: URL, route: ManagedRoomRoute): string | null {
	const result = managedRoomReplacement(payload, currentUrl, route);
	return result.stage === "ready" && result.code === "replacement-ready" ? result.href : null;
}
function normalizedLivePath(pathname: string): string | null {
	const normalized = pathname.replace(/\/+$/u, "") || "/";
	if (normalized === "/live") return normalized;
	const match = /^\/live\/([^/]+)$/u.exec(normalized);
	if (!match || !WEB_BUNDLE_ID_PATTERN.test(match[1])) return null;
	return normalized;
}
