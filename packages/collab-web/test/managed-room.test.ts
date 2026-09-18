import { describe, expect, it } from "bun:test";
import {
	managedLeaveHref,
	managedReplacementHref,
	managedRoomReplacement,
	managedRoomRoute,
} from "../src/lib/managed-room";

const route = { pcId: "local", sessionId: "session-a" };
const current = new URL(
	"https://portal.example.test/live/?pcId=local&sessionId=session-a#oldroom0123.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const replacement = "https://portal.example.test/live/#newroom0123.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function payload(webLink: string): unknown {
	return {
		pcs: [{ pcId: "local" }],
		sessions: [{ pcId: "local", sessionId: "session-a", room: { webLink, expiresAt: "2030-01-01T00:00:00.000Z" } }],
	};
}

describe("managed room discovery", () => {
	it("accepts only paired routing IDs", () => {
		expect(managedRoomRoute(new URLSearchParams("pcId=local&sessionId=session-a"))).toEqual(route);
		expect(managedRoomRoute(new URLSearchParams("pcId=local"))).toBeNull();
		expect(managedRoomRoute(new URLSearchParams("pcId=local&pcId=other&sessionId=session-a"))).toBeNull();
	});

	it("removes coordinator routing and the room capability when leaving", () => {
		expect(
			managedLeaveHref(
				new URL(
					"https://portal.example.test/live/?pcId=local&sessionId=session-a&theme=dark#room0123456.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				),
			),
		).toBe("/live/?theme=dark");
	});

	it("follows only this session's same-origin replacement room", () => {
		expect(managedReplacementHref(payload(replacement), current, route)).toBe(
			"https://portal.example.test/live/?pcId=local&sessionId=session-a#newroom0123.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		);
		// An in-flight discovery response cannot undo an explicit leave, which
		// synchronously removes the route before React disposes the poll effect.
		expect(
			managedReplacementHref(
				payload(replacement),
				new URL("https://portal.example.test/live/#oldroom0123.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
				route,
			),
		).toBeNull();
		expect(
			managedReplacementHref(payload("https://attacker.example.test/live/#room.key"), current, route),
		).toBeNull();
		expect(managedReplacementHref(payload("https://portal.example.test/other/#room.key"), current, route)).toBeNull();
		expect(
			managedReplacementHref(
				{
					pcs: [{ pcId: "local" }],
					sessions: [
						{
							pcId: "local",
							sessionId: "other",
							room: { webLink: replacement, expiresAt: "2030-01-01T00:00:00.000Z" },
						},
					],
				},
				current,
				route,
			),
		).toBeNull();
	});

	it("accepts canonical versioned bundles and reloads when only the bundle path changes", () => {
		const currentBundle = new URL(
			"https://portal.example.test/live/old_bundle/?pcId=local&sessionId=session-a#oldroom0123.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);
		const sameCapabilityNewBundle =
			"https://portal.example.test/live/new_bundle/#oldroom0123.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		expect(managedRoomReplacement(payload(sameCapabilityNewBundle), currentBundle, route)).toEqual({
			stage: "ready",
			code: "replacement-ready",
			href: "https://portal.example.test/live/new_bundle/?pcId=local&sessionId=session-a#oldroom0123.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
	});

	it("classifies unavailable responses without returning room links", () => {
		expect(managedRoomReplacement({}, current, route)).toEqual({
			stage: "payload",
			code: "invalid-envelope",
		});
		expect(
			managedRoomReplacement(
				{ pcs: [{ pcId: "local" }], sessions: [] },
				current,
				route,
			),
		).toEqual({ stage: "session", code: "session-missing" });
		expect(
			managedRoomReplacement(
				{ pcs: [{ pcId: "local" }], sessions: [{ pcId: "local", sessionId: "session-a" }] },
				current,
				route,
			),
		).toEqual({ stage: "room", code: "missing" });

		expect(
			managedRoomReplacement(
				{
					pcs: [{ pcId: "local" }],
					sessions: [
						{
							pcId: "local",
							sessionId: "session-a",
							room: { webLink: replacement, expiresAt: "not-a-date" },
						},
					],
				},
				current,
				route,
			),
		).toEqual({ stage: "payload", code: "invalid-room" });

		const rejected = managedRoomReplacement(
			payload("https://attacker.example.test/live/#capability-do-not-log"),
			current,
			route,
		);
		expect(rejected).toEqual({ stage: "payload", code: "invalid-replacement" });
		expect(JSON.stringify(rejected)).not.toContain("capability-do-not-log");
	});
});
