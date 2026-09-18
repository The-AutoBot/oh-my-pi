import { getAutoBotBootstrapIdentity } from "./autobot-update/bootstrap-metadata";

const bootstrapIdentity = getAutoBotBootstrapIdentity();

if (process.argv.length === 3 && process.argv[2] === "--autobot-bootstrap-identity") {
	process.stdout.write(`${JSON.stringify(bootstrapIdentity)}\n`);
} else if (process.argv.length === 3 && process.argv[2] === "--autobot-bootstrap-version") {
	process.stdout.write(`${bootstrapIdentity.bootstrapVersion}\n`);
} else {
	const { runAutoBotBootstrap } = await import("./autobot-update/bootstrap");
	await runAutoBotBootstrap();
}
