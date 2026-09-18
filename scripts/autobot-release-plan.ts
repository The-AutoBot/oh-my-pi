#!/usr/bin/env bun

import * as path from "node:path";
import { AUTO_BOT_COMPATIBILITY_EPOCH } from "../packages/coding-agent/src/autobot-update/contract.ts";
import { isRecord } from "../packages/utils/src/type-guards.ts";
import {
	AutoBotReleaseError,
	assertKnownOptions,
	gitOutput,
	outputError,
	parseCliArgs,
	requireCommit,
	requireString,
	requiredOption,
	runCommand,
	writeJsonAtomic,
} from "./autobot-release-common.ts";

const CANDIDATE_SUBJECT = /^chore\(autobot\): candidate upstream ([0-9a-f]{12})$/;
const UPSTREAM_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;

interface ReadyReleasePlan {
	readonly schemaVersion: 1;
	readonly ready: true;
	readonly forkCommit: string;
	readonly upstreamCommit: string;
	readonly upstreamVersion: string;
	readonly compatibilityEpoch: number;
}

interface DeferredReleasePlan {
	readonly schemaVersion: 1;
	readonly ready: false;
	readonly reason: string;
}

async function latestIntegratedUpstreamCommit(sourceRoot: string, forkCommit: string): Promise<string | undefined> {
	const history = await runCommand(["git", "log", "--topo-order", "--format=%H%x00%s", forkCommit], {
		cwd: sourceRoot,
		capture: true,
	});
	for (const row of history.stdout.split("\n")) {
		const [candidateCommit, subject] = row.split("\u0000", 2);
		const match = CANDIDATE_SUBJECT.exec(subject ?? "");
		if (!match) continue;
		const commit = requireCommit(candidateCommit ?? "", "Candidate merge commit");
		const parents = (await gitOutput(sourceRoot, ["show", "-s", "--format=%P", commit])).split(" ");
		if (parents.length !== 2) {
			throw new AutoBotReleaseError(`AutoBot candidate ${commit} must retain its canonical and upstream merge parents`);
		}
		const upstreamCommit = requireCommit(parents[1] ?? "", "Candidate upstream parent");
		if (!upstreamCommit.startsWith(match[1] ?? "")) {
			throw new AutoBotReleaseError(`AutoBot candidate ${commit} subject does not match its upstream merge parent`);
		}
		await gitOutput(sourceRoot, ["merge-base", "--is-ancestor", upstreamCommit, commit]);
		return upstreamCommit;
	}
	return undefined;
}

async function upstreamVersion(sourceRoot: string, upstreamCommit: string): Promise<string> {
	const packageJson = await runCommand(["git", "show", `${upstreamCommit}:packages/coding-agent/package.json`], {
		cwd: sourceRoot,
		capture: true,
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(packageJson.stdout);
	} catch (error) {
		throw new AutoBotReleaseError("Pinned upstream coding-agent package.json is invalid JSON", { cause: error });
	}
	if (!isRecord(parsed) || typeof parsed.version !== "string" || !UPSTREAM_VERSION.test(parsed.version)) {
		throw new AutoBotReleaseError("Pinned upstream coding-agent package.json must declare a valid release version");
	}
	return parsed.version;
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	assertKnownOptions(args, ["source-root", "out"]);
	const sourceRoot = path.resolve(requiredOption(args, "source-root"));
	const output = path.resolve(requiredOption(args, "out"));
	const forkCommit = requireCommit(await gitOutput(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]), "Canonical fork commit");
	const upstreamCommit = await latestIntegratedUpstreamCommit(sourceRoot, forkCommit);
	if (!upstreamCommit) {
		const deferred: DeferredReleasePlan = {
			schemaVersion: 1,
			ready: false,
			reason: "Canonical HEAD has no retained AutoBot candidate merge commit",
		};
		await writeJsonAtomic(output, deferred);
		console.log(deferred.reason);
		return;
	}
	const plan: ReadyReleasePlan = {
		schemaVersion: 1,
		ready: true,
		forkCommit,
		upstreamCommit,
		upstreamVersion: await upstreamVersion(sourceRoot, upstreamCommit),
		compatibilityEpoch: AUTO_BOT_COMPATIBILITY_EPOCH,
	};
	await writeJsonAtomic(output, plan);
	console.log(`Planned AutoBot release source ${plan.forkCommit.slice(0, 12)} from upstream ${plan.upstreamCommit.slice(0, 12)}`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		outputError(error);
		process.exitCode = 1;
	}
}
