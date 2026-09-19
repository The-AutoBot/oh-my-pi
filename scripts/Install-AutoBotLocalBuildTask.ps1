# AutoBot Local Build scheduled-task installer
# Registers only the dedicated interactive task; it never starts the task.

param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ConfigPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$BunPath
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion -lt [version]"5.1") {
    throw "Windows PowerShell 5.1 or newer is required."
}

if ($null -eq (Get-Command -Name Register-ScheduledTask -ErrorAction SilentlyContinue)) {
    throw "Windows Task Scheduler cmdlets are unavailable."
}

function Resolve-ExistingFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    # Path.IsPathRooted accepts drive-relative (C:child) and current-drive
    # rooted (\child) paths on .NET Framework. Accept only a drive path with
    # its root separator or a normal UNC server/share path.
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -and $Path -notmatch '^\\\\[^\\/]+[\\/][^\\/]+') {
        throw "$Label must be an absolute existing file."
    }

    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch {
        throw "$Label must be an absolute existing file."
    }

    if ($item.PSIsContainer -or -not ($item -is [System.IO.FileInfo])) {
        throw "$Label must be an absolute existing file."
    }

    return $item.FullName
}

function Test-ExactOwnedAction {
    param(
        [Parameter(Mandatory = $true)]$Task,
        [Parameter(Mandatory = $true)][string]$Execute,
        [Parameter(Mandatory = $true)][string]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) {
        return $false
    }

    $action = $actions[0]
    return [string]::Equals([string]$action.Execute, $Execute, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$action.Arguments, $Arguments, [System.StringComparison]::Ordinal) -and
        [string]::Equals([string]$action.WorkingDirectory, $WorkingDirectory, [System.StringComparison]::OrdinalIgnoreCase)
}

$taskName = "AutoBot Local Build"
$taskPath = "\"
$scriptsRoot = (Get-Item -LiteralPath $PSScriptRoot -Force -ErrorAction Stop).FullName
$repoItem = Get-Item -LiteralPath (Split-Path -Path $scriptsRoot -Parent) -Force -ErrorAction Stop
if (-not $repoItem.PSIsContainer) {
    throw "The local repository directory is unavailable."
}
$repoRoot = $repoItem.FullName

$launcherPath = Resolve-ExistingFile -Path (Join-Path -Path $scriptsRoot -ChildPath "Invoke-AutoBotLocalBuild.ps1") -Label "Local launcher"
$null = Resolve-ExistingFile -Path (Join-Path -Path $scriptsRoot -ChildPath "autobot-local.ts") -Label "Local pipeline"
$resolvedConfigPath = Resolve-ExistingFile -Path $ConfigPath -Label "ConfigPath"
$resolvedBunPath = Resolve-ExistingFile -Path $BunPath -Label "BunPath"
$windowsPowerShellPath = Resolve-ExistingFile -Path (Join-Path -Path $env:WINDIR -ChildPath "System32\WindowsPowerShell\v1.0\powershell.exe") -Label "Windows PowerShell"

$arguments = '-NoProfile -NonInteractive -File "{0}" -ConfigPath "{1}" -BunPath "{2}"' -f $launcherPath, $resolvedConfigPath, $resolvedBunPath
$action = New-ScheduledTaskAction -Execute $windowsPowerShellPath -Argument $arguments -WorkingDirectory $repoRoot

# The daily trigger plus its one-day repetition pattern produces one run per
# hour indefinitely while retaining the Task Scheduler calendar semantics.
$now = Get-Date
$firstRun = $now.Date.AddHours($now.Hour).AddMinutes(17)
if ($firstRun -le $now) {
    $firstRun = $firstRun.AddHours(1)
}
$trigger = New-ScheduledTaskTrigger -Daily -At $firstRun -DaysInterval 1
$repetition = New-CimInstance -Namespace "Root/Microsoft/Windows/TaskScheduler" -ClassName "MSFT_TaskRepetitionPattern" -ClientOnly -Property @{
    Interval = "PT1H"
    Duration = "P1D"
    StopAtDurationEnd = $false
}
$trigger.CimInstanceProperties["Repetition"].Value = $repetition

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
try {
    if ($null -eq $currentIdentity.User) {
        throw "The current Windows user identity is unavailable."
    }
    $userId = $currentIdentity.User.Value
} finally {
    $currentIdentity.Dispose()
}

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 0

$existingTask = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
$isUpdate = $null -ne $existingTask
if ($isUpdate -and -not (Test-ExactOwnedAction -Task $existingTask -Execute $windowsPowerShellPath -Arguments $arguments -WorkingDirectory $repoRoot)) {
    throw "AutoBot Local Build already exists with a different action. Refusing to overwrite it."
}

$registration = @{
    TaskName = $taskName
    TaskPath = $taskPath
    Action = $action
    Trigger = $trigger
    Settings = $settings
    Principal = $principal
    ErrorAction = "Stop"
}

try {
    if ($isUpdate) {
        Register-ScheduledTask @registration -Force | Out-Null
    } else {
        Register-ScheduledTask @registration | Out-Null
    }
} catch {
    throw "AutoBot Local Build task registration failed."
}

if ($isUpdate) {
    Write-Host "AutoBot Local Build task updated."
} else {
    Write-Host "AutoBot Local Build task registered."
}
