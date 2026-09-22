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

async function waitForFile(filePath: string, signal?: AbortSignal): Promise<void> {
	const changes = fs.watch(path.dirname(filePath), { signal });
	try {
		if (await Bun.file(filePath).exists()) return;
		for await (const change of changes) {
			if (change.filename === path.basename(filePath) && (await Bun.file(filePath).exists())) return;
		}
		throw new Error(`Stopped watching before ${filePath} was created`);
	} finally {
		await changes.return?.();
	}
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

interface CapturedScheduleOperation {
	readonly operation: "register" | "set";
	readonly weekly: boolean;
	readonly weeksInterval: number;
	readonly dayOfWeek: string;
	readonly hour: number;
	readonly minute: number;
	readonly settings?: {
		readonly allowStartIfOnBatteries: boolean;
		readonly dontStopIfGoingOnBatteries: boolean;
		readonly startWhenAvailable: boolean;
		readonly multipleInstances: string;
		readonly restartCount: number;
		readonly executionTimeLimitHours: number;
	};
	readonly principal?: {
		readonly logonType: string;
		readonly runLevel: string;
	};
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

windowsTest(
	"overlapping launches run the isolated pipeline only once",
	async () => {
		const root = await createRoot();
		const runner = path.join(root, "blocking-runner.cmd");
		const configPath = path.join(root, "config.json");
		const readyPath = path.join(root, "runner.ready");
		const releasePath = path.join(root, "runner.release");
		const startsPath = path.join(root, "runner-starts.txt");
		await fs.writeFile(
			runner,
			`@echo off\r\n>> "${startsPath}" echo start\r\n> "${readyPath}" echo ready\r\n:wait\r\nif not exist "${releasePath}" (\r\n  ping -n 2 127.0.0.1 >nul\r\n  goto wait\r\n)\r\nexit /b 0\r\n`,
		);
		await writeConfig(configPath, runner);

		const readinessAbort = new AbortController();
		// This is a real subprocess integration boundary. Bound the file-system
		// signal so a broken launcher cannot leave its child and watcher alive.
		const readinessSignal = AbortSignal.any([readinessAbort.signal, AbortSignal.timeout(15_000)]);
		const ready = waitForFile(readyPath, readinessSignal);
		const first = Bun.spawn(
			[
				powershellPath,
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				launcherPath,
				"-ConfigPath",
				configPath,
			],
			{ cwd: repositoryRoot, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		let firstExitCode: number;
		try {
			const readiness = await Promise.race([
				ready.then(() => ({ kind: "ready" as const })),
				first.exited.then(exitCode => ({ kind: "exited" as const, exitCode })),
			]);
			if (readiness.kind === "exited") {
				throw new Error(`Launcher exited with ${readiness.exitCode} before its runner became ready`);
			}
			const overlapAbort = new AbortController();
			const overlapDeadline = AbortSignal.any([overlapAbort.signal, AbortSignal.timeout(15_000)]);
			const overlapping = Bun.spawn(
				[
					powershellPath,
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					launcherPath,
					"-ConfigPath",
					configPath,
				],
				{ cwd: repositoryRoot, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
			);
			try {
				const overlapResult = await Promise.race([
					overlapping.exited.then(exitCode => ({ kind: "exited" as const, exitCode })),
					new Promise<{ kind: "deadline" }>(resolve => {
						overlapDeadline.addEventListener("abort", () => resolve({ kind: "deadline" }), { once: true });
					}),
				]);
				if (overlapResult.kind === "deadline") {
					throw new Error("Overlapping launcher did not finish before the integration deadline");
				}
				expect(overlapResult.exitCode).toBe(0);
				expect((await fs.readFile(startsPath, "utf8")).trim().split(/\r?\n/)).toEqual(["start"]);
			} finally {
				await fs.writeFile(releasePath, "release");
				overlapAbort.abort();
				const cleanupDeadline = AbortSignal.timeout(5_000);
				const cleanupResult = await Promise.race([
					overlapping.exited.then(() => "exited" as const),
					new Promise<"deadline">(resolve => {
						cleanupDeadline.addEventListener("abort", () => resolve("deadline"), { once: true });
					}),
				]);
				if (cleanupResult === "deadline" && overlapping.exitCode === null) {
					const treeKill = Bun.spawn(["taskkill.exe", "/PID", String(overlapping.pid), "/T", "/F"], {
						stdin: "ignore",
						stdout: "ignore",
						stderr: "ignore",
					});
					await treeKill.exited;
				}
				await Promise.all([
					overlapping.exited,
					new Response(overlapping.stdout).text(),
					new Response(overlapping.stderr).text(),
				]);
			}
		} finally {
			await fs.writeFile(releasePath, "release");
			readinessAbort.abort();
			const cleanupDeadline = AbortSignal.timeout(5_000);
			const cleanupResult = await Promise.race([
				first.exited.then(() => "exited" as const),
				new Promise<"deadline">(resolve => {
					cleanupDeadline.addEventListener("abort", () => resolve("deadline"), { once: true });
				}),
			]);
			if (cleanupResult === "deadline" && first.exitCode === null) {
				const treeKill = Bun.spawn(["taskkill.exe", "/PID", String(first.pid), "/T", "/F"], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
				await treeKill.exited;
			}
			[firstExitCode] = await Promise.all([
				first.exited,
				new Response(first.stdout).text(),
				new Response(first.stderr).text(),
			]);
		}
		expect(firstExitCode).toBe(0);
	},
	45_000,
);

windowsTest("a failed pipeline releases the invocation mutex for the next run", async () => {
	const root = await createRoot();
	const runner = path.join(root, "recovering-runner.cmd");
	const configPath = path.join(root, "config.json");
	const marker = path.join(root, "runs.txt");
	await fs.writeFile(runner, `@echo off\r\n>> "${marker}" echo failed\r\nexit /b 23\r\n`);
	await writeConfig(configPath, runner);

	const failed = await runPowerShell(["-File", launcherPath, "-ConfigPath", configPath]);
	expect(failed.exitCode).toBe(23);

	await fs.writeFile(runner, `@echo off\r\n>> "${marker}" echo recovered\r\nexit /b 0\r\n`);
	const recovered = await runPowerShell(["-File", launcherPath, "-ConfigPath", configPath]);
	expect(recovered.exitCode).toBe(0);
	expect((await fs.readFile(marker, "utf8")).trim().split(/\r?\n/)).toEqual(["failed", "recovered"]);
});

windowsTest("a config-only scheduled action follows runner updates without re-registration", async () => {
	const root = await createRoot();
	const firstMarker = path.join(root, "first.marker");
	const secondMarker = path.join(root, "second.marker");
	const firstRunner = await createRunner(root, "first", firstMarker);
	const secondRunner = await createRunner(root, "second", secondMarker);
	const configPath = path.join(root, "config.json");
	const actionCapture = path.join(root, "action.json");
	const scheduleCapture = path.join(root, "schedule.json");
	const harnessPath = path.join(root, "install-harness.ps1");
	await writeConfig(configPath, firstRunner);
	await fs.writeFile(
		harnessPath,
		`function New-ScheduledTaskAction {
    param($Execute, $Argument, $WorkingDirectory)
    $script:createdAction = [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
    return $script:createdAction
}
function New-ScheduledTaskTrigger {
    param([switch]$Weekly, $At, $WeeksInterval, $DaysOfWeek)
    [pscustomobject]@{ Weekly = [bool]$Weekly; At = $At; WeeksInterval = $WeeksInterval; DaysOfWeek = [string]$DaysOfWeek }
}
function New-ScheduledTaskPrincipal {
    param($UserId, $LogonType, $RunLevel)
    [pscustomobject]@{ UserId = $UserId; LogonType = [string]$LogonType; RunLevel = [string]$RunLevel }
}
function New-ScheduledTaskSettingsSet {
    param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$StartWhenAvailable, $MultipleInstances, $RestartCount, $ExecutionTimeLimit)
    [pscustomobject]@{
        AllowStartIfOnBatteries = [bool]$AllowStartIfOnBatteries
        DontStopIfGoingOnBatteries = [bool]$DontStopIfGoingOnBatteries
        StartWhenAvailable = [bool]$StartWhenAvailable
        MultipleInstances = [string]$MultipleInstances
        RestartCount = [int]$RestartCount
        ExecutionTimeLimitHours = $ExecutionTimeLimit.TotalHours
    }
}
function Get-ScheduledTask {
    param($TaskName, $TaskPath, $ErrorAction)
    if ($env:AUTOBOT_EXISTING_MODE -eq "owned") {
        return [pscustomobject]@{ Actions = @($script:createdAction) }
    }
    if ($env:AUTOBOT_EXISTING_MODE -eq "foreign") {
        return [pscustomobject]@{ Actions = @([pscustomobject]@{ Execute = "foreign.exe"; Arguments = ""; WorkingDirectory = "C:\\" }) }
    }
    return $null
}
function Write-ScheduleCapture {
    param($Operation, $Trigger, $Settings, $Principal)
    $capture = [ordered]@{
        weekly = $Trigger.Weekly
        weeksInterval = $Trigger.WeeksInterval
        operation = $Operation
        dayOfWeek = [string]$Trigger.DaysOfWeek
        hour = $Trigger.At.Hour
        minute = $Trigger.At.Minute
    }
    if ($null -ne $Settings) {
        $capture.settings = [ordered]@{
            allowStartIfOnBatteries = $Settings.AllowStartIfOnBatteries
            dontStopIfGoingOnBatteries = $Settings.DontStopIfGoingOnBatteries
            startWhenAvailable = $Settings.StartWhenAvailable
            multipleInstances = $Settings.MultipleInstances
            restartCount = $Settings.RestartCount
            executionTimeLimitHours = $Settings.ExecutionTimeLimitHours
        }
    }
    if ($null -ne $Principal) {
        $capture.principal = [ordered]@{ logonType = $Principal.LogonType; runLevel = $Principal.RunLevel }
    }
    $capture | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath $env:AUTOBOT_SCHEDULE_CAPTURE -Encoding UTF8
}
function Register-ScheduledTask {
    param($TaskName, $TaskPath, $Description, $Action, $Trigger, $Principal, $Settings, [switch]$Force, $ErrorAction)
    $Action | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:AUTOBOT_ACTION_CAPTURE -Encoding UTF8
    Write-ScheduleCapture -Operation "register" -Trigger $Trigger -Settings $Settings -Principal $Principal
    return [pscustomobject]@{}
}
function Set-ScheduledTask {
    param($TaskName, $TaskPath, $Trigger, $ErrorAction)
    Write-ScheduleCapture -Operation "set" -Trigger $Trigger
    return [pscustomobject]@{}
}
& ${powerShellLiteral(installerPath)} -ConfigPath ${powerShellLiteral(configPath)} -BunPath $env:AUTOBOT_INSTALL_BUN
`,
	);

	const installation = await runPowerShell(["-File", harnessPath], {
		...process.env,
		AUTOBOT_ACTION_CAPTURE: actionCapture,
		AUTOBOT_SCHEDULE_CAPTURE: scheduleCapture,
		AUTOBOT_INSTALL_BUN: firstRunner,
	});
	const action = JSON.parse((await fs.readFile(actionCapture, "utf8")).replace(/^\uFEFF/, "")) as CapturedAction;
	expect(installation.exitCode).toBe(0);
	const initialSchedule = JSON.parse(
		(await fs.readFile(scheduleCapture, "utf8")).replace(/^\uFEFF/, ""),
	) as CapturedScheduleOperation;
	expect(initialSchedule).toEqual({
		operation: "register",
		weekly: true,
		weeksInterval: 1,
		dayOfWeek: "Friday",
		hour: 21,
		minute: 17,
		settings: {
			allowStartIfOnBatteries: true,
			dontStopIfGoingOnBatteries: true,
			startWhenAvailable: true,
			multipleInstances: "IgnoreNew",
			restartCount: 0,
			executionTimeLimitHours: 72,
		},
		principal: {
			logonType: "Interactive",
			runLevel: "Limited",
		},
	});

	await fs.rm(scheduleCapture);
	const update = await runPowerShell(["-File", harnessPath], {
		...process.env,
		AUTOBOT_ACTION_CAPTURE: actionCapture,
		AUTOBOT_SCHEDULE_CAPTURE: scheduleCapture,
		AUTOBOT_INSTALL_BUN: firstRunner,
		AUTOBOT_EXISTING_MODE: "owned",
	});
	expect(update.exitCode).toBe(0);
	const updatedSchedule = JSON.parse(
		(await fs.readFile(scheduleCapture, "utf8")).replace(/^\uFEFF/, ""),
	) as CapturedScheduleOperation;
	expect(updatedSchedule).toEqual({
		operation: "set",
		weekly: true,
		weeksInterval: 1,
		dayOfWeek: "Friday",
		hour: 21,
		minute: 17,
	});

	await fs.rm(scheduleCapture);
	const foreignUpdate = await runPowerShell(["-File", harnessPath], {
		...process.env,
		AUTOBOT_ACTION_CAPTURE: actionCapture,
		AUTOBOT_SCHEDULE_CAPTURE: scheduleCapture,
		AUTOBOT_INSTALL_BUN: firstRunner,
		AUTOBOT_EXISTING_MODE: "foreign",
	});
	expect(foreignUpdate.exitCode).not.toBe(0);
	expect(await Bun.file(scheduleCapture).exists()).toBe(false);

	await fs.rm(actionCapture);
	const rejectedInstallation = await runPowerShell(["-File", harnessPath], {
		...process.env,
		AUTOBOT_ACTION_CAPTURE: actionCapture,
		AUTOBOT_SCHEDULE_CAPTURE: scheduleCapture,
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
