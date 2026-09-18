import { describe, expect, it } from "bun:test";
import { resolveDraftScopeForRoute } from "../src/lib/managed-room";

const managedScope = { fingerprint: "a".repeat(64), sessionId: "session-a" } as const;

describe("managed draft readiness", () => {
	it("does not activate a manual draft scope before managed identity is verified", () => {
		expect(resolveDraftScopeForRoute(null, null, "session-a")).toBe("manual");
		expect(resolveDraftScopeForRoute({ pcId: "local", sessionId: "session-a" }, null, "session-a")).toBeNull();
		expect(
			resolveDraftScopeForRoute(
				{ pcId: "local", sessionId: "session-a" },
				{ ...managedScope, sessionId: "session-b" },
				"session-a",
			),
		).toBeNull();
		expect(resolveDraftScopeForRoute({ pcId: "local", sessionId: "session-a" }, managedScope, "session-a")).toBe(
			managedScope,
		);
	});
});
