import { describe, expect, test } from "bun:test";
import {
	assertRecoverableIntegrationHistory,
	classifyIntegrationCheckpoint,
	hasRetainedPublishedCheckpoint,
	resolvePublishedCheckpointUpstream,
} from "../scripts/autobot-local.ts";

const commit = (character: string): string => character.repeat(40);
const checkpoint = commit("1");
const pending = commit("2");
const foreign = commit("3");

describe("integration checkpoint reconciliation", () => {
	test("recognizes an interrupted push that landed", () => {
		expect(
			classifyIntegrationCheckpoint(
				{ integrationRemoteCommit: checkpoint, pendingIntegrationCommit: pending },
				pending,
			),
		).toBe("pending-landed");
	});

	test("recognizes an interrupted push that did not land", () => {
		expect(
			classifyIntegrationCheckpoint(
				{ integrationRemoteCommit: checkpoint, pendingIntegrationCommit: pending },
				checkpoint,
			),
		).toBe("pending-not-landed");
	});

	test("rejects a third branch value while a push marker is pending", () => {
		expect(() =>
			classifyIntegrationCheckpoint(
				{ integrationRemoteCommit: checkpoint, pendingIntegrationCommit: pending },
				foreign,
			),
		).toThrow("did not reconcile with the interrupted local push");
	});

	test("permits authentication only for movement without a pending marker", () => {
		expect(classifyIntegrationCheckpoint({ integrationRemoteCommit: checkpoint }, foreign)).toBe(
			"authenticate-completion",
		);
		expect(classifyIntegrationCheckpoint({ integrationRemoteCommit: checkpoint }, checkpoint)).toBe("unchanged");
	});

	test("does not treat an empty fresh state as a retained published checkpoint", () => {
		expect(hasRetainedPublishedCheckpoint(undefined, undefined)).toBe(false);
		expect(hasRetainedPublishedCheckpoint(checkpoint, checkpoint)).toBe(true);
	});

	test("accepts only forward checkpoint recovery with linear owned local history", async () => {
		await expect(
			assertRecoverableIntegrationHistory(checkpoint, pending, pending, async (older, newer) => {
				return older === checkpoint && newer === pending;
			}),
		).resolves.toBeUndefined();
	});

	test("rejects backward or divergent authenticated publication movement", async () => {
		await expect(
			assertRecoverableIntegrationHistory(pending, checkpoint, checkpoint, async (older, newer) => {
				return older === checkpoint && newer === pending;
			}),
		).rejects.toThrow("discard or diverge from checkpointed integration history");
		await expect(
			assertRecoverableIntegrationHistory(checkpoint, pending, foreign, async (older, newer) => {
				return older === checkpoint && newer === pending;
			}),
		).rejects.toThrow("diverges from the owned local integration history");
	});

	test("derives a historical published base independently of newer in-progress candidate state", () => {
		const publishedUpstream = commit("4");
		const nextUpstream = commit("5");
		const interruptedState = {
			upstreamCommit: nextUpstream,
			publishedUpstreamCommit: publishedUpstream,
			publishedUpstreamVersion: "1.0.0",
		};
		expect(resolvePublishedCheckpointUpstream(publishedUpstream, "1.0.0", interruptedState)).toEqual({
			upstreamCommit: publishedUpstream,
			upstreamVersion: "1.0.0",
		});
		expect(() => resolvePublishedCheckpointUpstream(nextUpstream, "2.0.0", interruptedState)).toThrow(
			"conflicts with its immutable published upstream identity",
		);
	});
});
