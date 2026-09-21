# AutoBot Local Build launcher
# Runs the fixed local pipeline once with the config-authorized Bun runtime.

param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ConfigPath,

    [ValidateNotNullOrEmpty()]
    [string]$BunPath,

    [switch]$VerifyOnly,

    [ValidateNotNullOrEmpty()]
    [string]$PublishPrepared
)

$ErrorActionPreference = "Stop"

# Keep the launcher compatible with the Windows PowerShell host used by the
# scheduled task. Newer PowerShell versions also pass this check.
if ($PSVersionTable.PSVersion -lt [version]"5.1") {
    [Console]::Error.WriteLine("AutoBot Local Build requires Windows PowerShell 5.1 or later.")
    exit 1
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

function Resolve-ConfiguredBunPath {
    param([Parameter(Mandatory = $true)][string]$ResolvedConfigPath)

    try {
        $parsed = Get-Content -LiteralPath $ResolvedConfigPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        $property = $parsed.PSObject.Properties["runnerBun"]
        if ($null -eq $property -or -not ($property.Value -is [string]) -or [string]::IsNullOrWhiteSpace($property.Value)) {
            throw "invalid"
        }
        return Resolve-ExistingFile -Path $property.Value -Label "Configured runner"
    } catch {
        throw "The configured runner is unavailable."
    }
}
function Resolve-ExistingDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($Path -notmatch '^[A-Za-z]:[\\/]' -and $Path -notmatch '^\\\\[^\\/]+[\\/][^\\/]+') {
        throw "$Label must be an absolute existing directory."
    }
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch {
        throw "$Label must be an absolute existing directory."
    }
    if (-not $item.PSIsContainer -or -not ($item -is [System.IO.DirectoryInfo])) {
        throw "$Label must be an absolute existing directory."
    }
    return $item.FullName
}


function Get-InvocationMutexName {
    param([Parameter(Mandatory = $true)][string]$ResolvedConfigPath)

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        if ($null -eq $identity.User) {
            throw "The current Windows user identity is unavailable."
        }

        # Windows path identity is case-insensitive. Hashing both the user SID
        # and canonical config path keeps the kernel-object name non-sensitive.
        $scope = $identity.User.Value + "`n" + $ResolvedConfigPath.ToUpperInvariant()
    } finally {
        $identity.Dispose()
    }

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($scope)
        $hash = [System.BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace("-", "")
        return "Global\AutoBotLocalBuild-$hash"
    } finally {
        $sha256.Dispose()
    }
}

function Invoke-AutoBotLocalBuild {
    $mutex = $null
    $mutexAcquired = $false

    try {
        $resolvedConfigPath = Resolve-ExistingFile -Path $ConfigPath -Label "ConfigPath"
        $resolvedBunPath = Resolve-ConfiguredBunPath -ResolvedConfigPath $resolvedConfigPath
        if (-not [string]::IsNullOrEmpty($BunPath)) {
            $resolvedAssertedBunPath = Resolve-ExistingFile -Path $BunPath -Label "BunPath"
            if (-not [string]::Equals($resolvedAssertedBunPath, $resolvedBunPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "BunPath does not match the configured runner."
            }
        }
        if ($VerifyOnly -and -not [string]::IsNullOrEmpty($PublishPrepared)) {
            throw "VerifyOnly and PublishPrepared are mutually exclusive."
        }
        $resolvedPreparedStage = $null
        if (-not [string]::IsNullOrEmpty($PublishPrepared)) {
            $resolvedPreparedStage = Resolve-ExistingDirectory -Path $PublishPrepared -Label "PublishPrepared"
        }
        $pipelinePath = Resolve-ExistingFile -Path (Join-Path -Path $PSScriptRoot -ChildPath "autobot-local.ts") -Label "Local pipeline"
        $pipelineArguments = @($pipelinePath, "--config", $resolvedConfigPath)
        if ($VerifyOnly) {
            $pipelineArguments += "--verify-only"
        } elseif ($null -ne $resolvedPreparedStage) {
            $pipelineArguments += @("--publish-prepared", $resolvedPreparedStage)
        }

        try {
            $repoItem = Get-Item -LiteralPath (Split-Path -Path $PSScriptRoot -Parent) -Force -ErrorAction Stop
        } catch {
            throw "The local repository directory is unavailable."
        }
        if (-not $repoItem.PSIsContainer) {
            throw "The local repository directory is unavailable."
        }
        $repoRoot = $repoItem.FullName

        $mutex = New-Object System.Threading.Mutex($false, (Get-InvocationMutexName -ResolvedConfigPath $resolvedConfigPath))
        try {
            $mutexAcquired = $mutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            # The operating system released an abandoned mutex. This invocation
            # now owns it and can safely continue.
            $mutexAcquired = $true
        }

        if (-not $mutexAcquired) {
            [Console]::Out.WriteLine("AutoBot Local Build: another invocation is active.")
            return 0
        }

        [Console]::Out.WriteLine("AutoBot Local Build: starting.")

        Push-Location -LiteralPath $repoRoot
        try {
            # Do not relay arbitrary child output: config, environment, and tool
            # output can be sensitive or unbounded. The exit code is the contract.
            $previousErrorActionPreference = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try {
                & $resolvedBunPath @pipelineArguments 1>$null 2>$null
                $pipelineExitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
        } finally {
            Pop-Location
        }

        if ($null -eq $pipelineExitCode) {
            [Console]::Error.WriteLine("AutoBot Local Build: pipeline did not return an exit code.")
            return 1
        }

        if ($pipelineExitCode -eq 0) {
            [Console]::Out.WriteLine("AutoBot Local Build: completed successfully.")
        } else {
            [Console]::Error.WriteLine("AutoBot Local Build: pipeline completed with a nonzero exit code.")
        }

        return [int]$pipelineExitCode
    } catch {
        [Console]::Error.WriteLine("AutoBot Local Build: unable to run.")
        return 1
    } finally {
        if ($null -ne $mutex) {
            if ($mutexAcquired) {
                try {
                    $mutex.ReleaseMutex()
                } catch {
                    # Process exit releases the mutex even if explicit release fails.
                }
            }
            $mutex.Dispose()
        }
    }
}

exit (Invoke-AutoBotLocalBuild)
