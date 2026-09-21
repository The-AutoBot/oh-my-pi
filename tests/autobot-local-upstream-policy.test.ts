import { describe, expect, test } from "bun:test";
import { assertCompletedUpstreamAdvance, selectEffectiveUpstreamBase } from "../scripts/autobot-local.ts";
import type { EffectiveUpstreamBase } from "../scripts/autobot-local-types.ts";

const commit = (character: string): string => character.repeat(40);
const base = (character: string, version: string): EffectiveUpstreamBase => ({
	commit: commit(character),
	version,
});

const official = base("2", "2.0.0");
const retained = base("3", "3.0.0");

describe("effective upstream selection", () => {
	test("uses the official release when no authenticated retained base exists", async () => {
		expect(await selectEffectiveUpstreamBase(official, undefined, async () => false)).toEqual(official);
	});

	test("keeps the official identity when retained provenance is already equal", async () => {
		expect(await selectEffectiveUpstreamBase(official, { ...official }, async () => false)).toEqual(official);
	});

	test("keeps an already-shipped descendant when the official stable endpoint moves backward", async () => {
		const selected = await selectEffectiveUpstreamBase(
			official,
			retained,
			async (older, newer) => older === official.commit && newer === retained.commit,
		);
		expect(selected).toEqual(retained);
	});

	test("advances automatically when a future official stable descends from the retained base", async () => {
		const selected = await selectEffectiveUpstreamBase(
			official,
			retained,
			async (older, newer) => older === retained.commit && newer === official.commit,
		);
		expect(selected).toEqual(official);
	});

	test("rejects divergent official and retained histories", async () => {
		expect(selectEffectiveUpstreamBase(official, retained, async () => false)).rejects.toThrow(
			"diverges from retained candidate upstream history",
		);
	});

	test("allows completed provenance to advance recorded upstream but never move it backward", async () => {
		await expect(
			assertCompletedUpstreamAdvance(official.commit, retained.commit, async (older, newer) => {
				return older === official.commit && newer === retained.commit;
			}),
		).resolves.toBeUndefined();
		await expect(
			assertCompletedUpstreamAdvance(retained.commit, official.commit, async (older, newer) => {
				return older === official.commit && newer === retained.commit;
			}),
		).rejects.toThrow("discard or diverge from retained upstream history");
	});
});
