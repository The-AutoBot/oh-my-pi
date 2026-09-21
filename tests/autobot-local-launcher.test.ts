import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const windowsTest = process.platform === "win32" ? test : test.skip;
const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dir, "..");
const launcherPath = path.join(repositoryRoot, "scripts", "Invoke-AutoBotLocalBuild.ps1");
const installerPath = path.join(repositoryRoot, "scripts", "Install-AutoBotLocalBuildTask.ps1");
const powershellPath = path.join(
	process.env.WINDIR ?? String.raw`C:\Windows`,
	"System32",
	"WindowsPowerShell",
	"v1.0",
	"powershell.exe",
);

async function createRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autobot-launcher-"));
	temporaryDirectories.push(root);
	return root;
}

async function createRunner(root: string, name: string, marker: string): Promise<string> {
	const runner = path.join(root, `${name}.cmd`);
	await fs.writeFile(runner, `@echo off\r\n> "${marker}" echo ${name}\r\nexit /b 0\r\n`);
	return runner;
}

interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function runPowerShell(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ProcessResult> {
	const child = Bun.spawn([powershellPath, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
		cwd: repositoryRoot,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}
function powerShellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

interface CapturedAction {
	readonly Execute: string;
	readonly Arguments: string;
	readonly WorkingDirectory: string;
}

async function runScheduledAction(action: CapturedAction): Promise<ProcessResult> {
	return runPowerShell(
		[
			"-Command",
			"$process = Start-Process -FilePath $env:AUTOBOT_ACTION_EXECUTE -ArgumentList $env:AUTOBOT_ACTION_ARGUMENTS -WorkingDirectory $env:AUTOBOT_ACTION_WORKING_DIRECTORY -NoNewWindow -Wait -PassThru; exit $process.ExitCode",
		],
		{
			...process.env,
			AUTOBOT_ACTION_EXECUTE: action.Execute,
			AUTOBOT_ACTION_ARGUMENTS: action.Arguments,
			AUTOBOT_ACTION_WORKING_DIRECTORY: action.WorkingDirectory,
		},
	);
}

async function writeConfig(configPath: string, runnerBun: string, secret = "private-config-canary"): Promise<void> {
	await fs.writeFile(configPath, JSON.stringify({ runnerBun, privateValue: secret }));
}

afterEach(async () => {
	const directories = temporaryDirectories.splice(0);
	await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })));
});

windowsTest("invokes the runner authorized by private config", async () => {
	const root = await createRoot();
	const marker = path.join(root, "configured.marker");
	const runner = await createRunner(root, "configured", marker);
	const configPath = path.join(root, "config.json");
	await writeConfig(configPath, runner);

	const result = await runPowerShell(["-File", launcherPath, "-ConfigPath", configPath]);

	expect(result.exitCode).toBe(0);
	expect((await fs.readFile(marker, "utf8")).trim()).toBe("configured");
});

windowsTest("rejects an explicit Bun mismatch before starting either runtime", async () => {
	const root = await createRoot();
	const configuredMarker = path.join(root, "configured.marker");
	const assertedMarker = path.join(root, "asserted.marker");
	const configuredRunner = await createRunner(root, "configured", configuredMarker);
	const assertedRunner = await createRunner(root, "asserted", assertedMarker);
	const configPath = path.join(root, "config.json");
	const secret = "mismatch-private-canary";
	await writeConfig(configPath, configuredRunner, secret);

	const result = await runPowerShell(["-File", launcherPath, "-ConfigPath", configPath, "-BunPath", assertedRunner]);

	expect(result.exitCode).toBe(1);
	expect(await Bun.file(configuredMarker).exists()).toBe(false);
	expect(await Bun.file(assertedMarker).exists()).toBe(false);
	expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
});

windowsTest("a config-only scheduled action follows runner updates without re-registration", async () => {
	const root = await createRoot();
	const firstMarker = path.join(root, "first.marker");
	const secondMarker = path.join(root, "second.marker");
	const firstRunner = await createRunner(root, "first", firstMarker);
	const secondRunner = await createRunner(root, "second", secondMarker);
	const configPath = path.join(root, "config.json");
	const actionCapture = path.join(root, "action.json");
	const harnessPath = path.join(root, "install-harness.ps1");
	await writeConfig(configPath, firstRunner);
	await fs.writeFile(
		harnessPath,
		`function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
function New-ScheduledTaskTrigger { param([switch]$Daily, $At, $DaysInterval) [pscustomobject]@{ CimInstanceProperties = @{ Repetition = [pscustomobject]@{ Value = $null } } } }
function New-CimInstance { param($Namespace, $ClassName, [switch]$ClientOnly, $Property) [pscustomobject]$Property }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$StartWhenAvailable, $MultipleInstances, $RestartCount) [pscustomobject]@{} }
function Get-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction) return $null }
function Register-ScheduledTask { param($TaskName, $TaskPath, $Description, $Action, $Trigger, $Principal, $Settings, [switch]$Force, $ErrorAction) $Action | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:AUTOBOT_ACTION_CAPTURE -Encoding UTF8; return [pscustomobject]@{} }
& ${powerShellLiteral(installerPath)} -ConfigPath ${powerShellLiteral(configPath)} -BunPath $env:AUTOBOT_INSTALL_BUN
`,
	);

	const installation = await runPowerShell(["-File", harnessPath], {
		...process.env,
		AUTOBOT_ACTION_CAPTURE: actionCapture,
		AUTOBOT_INSTALL_BUN: firstRunner,
	});
	const action = JSON.parse((await fs.readFile(actionCapture, "utf8")).replace(/^\uFEFF/, "")) as CapturedAction;
	expect(installation.exitCode).toBe(0);

	await fs.rm(actionCapture);
	const rejectedInstallation = await runPowerShell(["-File", harnessPath], {
		...process.env,
		AUTOBOT_ACTION_CAPTURE: actionCapture,
		AUTOBOT_INSTALL_BUN: secondRunner,
	});
	expect(rejectedInstallation.exitCode).not.toBe(0);
	expect(await Bun.file(actionCapture).exists()).toBe(false);

	const firstRun = await runScheduledAction(action);
	expect(firstRun.exitCode).toBe(0);
	expect((await fs.readFile(firstMarker, "utf8")).trim()).toBe("first");

	await writeConfig(configPath, secondRunner);
	const secondRun = await runScheduledAction(action);
	expect(secondRun.exitCode).toBe(0);
	expect((await fs.readFile(secondMarker, "utf8")).trim()).toBe("second");
});
