[CmdletBinding()]
param(
    [ValidateSet('dev', 'dev:desktop')]
    [string]$Mode = 'dev:desktop',
    [switch]$Status,
    [switch]$CheckOnly,
    [string]$DataHome,
    [ValidateRange(10, 600)]
    [int]$WaitSeconds = 180
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = Split-Path -Parent $PSScriptRoot
$runtimeNode = (Get-Command node.exe -ErrorAction Stop).Source
$runtimeGitFile = Join-Path $runtimeRoot '.git'
$runtimeIsWorktree = (Test-Path -LiteralPath $runtimeGitFile -PathType Leaf) -and
    ((Get-Content -LiteralPath $runtimeGitFile -Raw) -match '[/\\]worktrees[/\\]')
$runtimeDataHome = if ($DataHome) { [System.IO.Path]::GetFullPath($DataHome) }
    elseif ($runtimeIsWorktree) { Join-Path $runtimeRoot '.t3' }
    else { 'E:/NewAutoUsage' }
$runtimeRecordPath = Join-Path $runtimeRoot '.t3\runtime-launch.json'
$runtimeRecord = if (Test-Path -LiteralPath $runtimeRecordPath) {
    Get-Content -LiteralPath $runtimeRecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else { $null }
if (-not $PSBoundParameters.ContainsKey('Mode') -and $null -ne $runtimeRecord) {
    $Mode = $runtimeRecord.Mode
}

if ($CheckOnly) {
    Push-Location -LiteralPath $runtimeRoot
    try {
        & $runtimeNode scripts/dev-runner.ts $Mode --home-dir $runtimeDataHome --dry-run
        if ($LASTEXITCODE -ne 0) { throw "Runner configuration failed: exit $LASTEXITCODE" }
    } finally { Pop-Location }
    return
}

function Get-RecordedProcess($record) {
    if ($null -eq $record) { return $null }
    $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$record.Pid)
    if ($null -ne $candidate -and
        $candidate.CreationDate.ToUniversalTime().Ticks.ToString() -eq $record.CreatedUtcTicks -and
        $candidate.CommandLine -eq $record.CommandLine) { return $candidate }
    return $null
}

function Get-RuntimeHealth($record) {
    $rootProcess = Get-RecordedProcess $record
    if ($null -eq $rootProcess) { return [pscustomobject]@{ Ready = $false; Running = $false } }
    $header = @(Get-Content -LiteralPath $record.Stdout -TotalCount 30 -ErrorAction SilentlyContinue) -join "`n"
    $ports = [regex]::Match($header, 'serverPort=(\d+) webPort=(\d+)')
    if (-not $ports.Success) { return [pscustomobject]@{ Ready = $false; Running = $true } }
    $serverPort = [int]$ports.Groups[1].Value
    $webPort = [int]$ports.Groups[2].Value
    $allProcesses = @(Get-CimInstance Win32_Process)
    $ownedIds = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ownedIds.Add([int]$record.Pid)
    do {
        $added = $false
        foreach ($entry in $allProcesses) {
            if ($ownedIds.Contains([int]$entry.ParentProcessId) -and $ownedIds.Add([int]$entry.ProcessId)) { $added = $true }
        }
    } while ($added)
    $ownedPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $ownedIds.Contains([int]$_.OwningProcess) } | Select-Object -ExpandProperty LocalPort -Unique)
    $webOk = $false
    $serverOk = $false
    if ($serverPort -in $ownedPorts -and $webPort -in $ownedPorts) {
        try { $serverOk = (Invoke-WebRequest -Uri "http://127.0.0.1:$serverPort/" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch {}
        $webHost = if ($record.Mode -eq 'dev:desktop') { '127.0.0.1' } else { 'localhost' }
        try { $webOk = (Invoke-WebRequest -Uri "http://${webHost}:$webPort/" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch {}
    }
    $desktopOk = $null
    if ($record.Mode -eq 'dev:desktop') {
        $desktopOk = @($allProcesses | Where-Object { $ownedIds.Contains([int]$_.ProcessId) -and $_.Name -eq 'electron.exe' } |
            ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
            Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0
    }
    return [pscustomobject]@{
        Ready = $webOk -and $serverOk -and ($record.Mode -ne 'dev:desktop' -or $desktopOk)
        Running = $true; Mode = $record.Mode; Pid = $record.Pid
        WebPort = $webPort; BackendPort = $serverPort
        WebHttp200 = $webOk; BackendHttp200 = $serverOk; DesktopWindow = $desktopOk
        Stdout = $record.Stdout; Stderr = $record.Stderr
    }
}

if ($Status) {
    Get-RuntimeHealth $runtimeRecord | ConvertTo-Json
    return
}

# Starting does not stop a healthy runtime or silently change its mode.
if ($null -ne (Get-RecordedProcess $runtimeRecord)) {
    if ([System.IO.Path]::GetFullPath($runtimeRecord.DataHome) -ne [System.IO.Path]::GetFullPath($runtimeDataHome)) {
        throw 'The recorded runtime uses a different data home; no duplicate was started.'
    }
    if ($runtimeRecord.Mode -ne $Mode) {
        throw "Recorded mode is $($runtimeRecord.Mode), requested $Mode. Complete the authorized stop of the identified runtime before changing modes."
    }
    $existingHealth = Get-RuntimeHealth $runtimeRecord
    if (-not $existingHealth.Ready) {
        $existingHealth | ConvertTo-Json
        throw 'Recorded runtime is still present but not ready. Inspect its logs; no duplicate was started.'
    }
    $existingHealth | ConvertTo-Json
    return
}

# A missing/stale record is not permission to create a second backend on shifted ports.
$existingDefaultPorts = @(Get-NetTCPConnection -State Listen -LocalPort 13773,5733 -ErrorAction SilentlyContinue)
if (-not $runtimeIsWorktree -and $existingDefaultPorts.Count -gt 0) {
    throw 'Default runtime ports are already occupied. Identify and record the existing runtime before starting another one.'
}

$runtimeLogDir = Join-Path $runtimeRoot '.logs'
[void](New-Item -ItemType Directory -Path $runtimeLogDir -Force)
[void](New-Item -ItemType Directory -Path (Split-Path -Parent $runtimeRecordPath) -Force)
$runtimeStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$runtimeOut = Join-Path $runtimeLogDir "runtime-$runtimeStamp.out.log"
$runtimeErr = Join-Path $runtimeLogDir "runtime-$runtimeStamp.err.log"
# The desktop build invokes `vp` from nested package scripts. PowerShell does
# not get package-manager PATH injection when launching node directly.
$runtimeOriginalPath = $env:PATH
try {
    $env:PATH = (Join-Path $runtimeRoot 'node_modules\.bin') + ';' + (Split-Path -Parent $runtimeNode) + ';' + $runtimeOriginalPath
    $runtimeProcess = Start-Process -FilePath $runtimeNode `
        -ArgumentList "scripts/dev-runner.ts $Mode --home-dir `"$runtimeDataHome`"" `
        -WorkingDirectory $runtimeRoot -WindowStyle Hidden `
        -RedirectStandardOutput $runtimeOut -RedirectStandardError $runtimeErr -PassThru
} finally { $env:PATH = $runtimeOriginalPath }
$runtimeIdentity = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $runtimeProcess.Id)
if ($null -eq $runtimeIdentity) { throw "Runner exited before identity capture. Read $runtimeErr" }
$runtimeRecord = [pscustomobject]@{
    Pid = $runtimeProcess.Id; CreatedUtcTicks = $runtimeIdentity.CreationDate.ToUniversalTime().Ticks.ToString()
    CommandLine = $runtimeIdentity.CommandLine; Mode = $Mode
    Stdout = $runtimeOut; Stderr = $runtimeErr; DataHome = $runtimeDataHome
}
$runtimeRecord | ConvertTo-Json | Set-Content -LiteralPath $runtimeRecordPath -Encoding UTF8
$runtimeDeadline = (Get-Date).AddSeconds($WaitSeconds)
do {
    $runtimeHealth = Get-RuntimeHealth $runtimeRecord
    if ($runtimeHealth.Ready) { $runtimeHealth | ConvertTo-Json; return }
    if (-not $runtimeHealth.Running) { throw "Runner exited. Read $runtimeErr and $runtimeOut" }
    Start-Sleep -Seconds 1
} while ((Get-Date) -lt $runtimeDeadline)
$runtimeHealth | ConvertTo-Json
throw "Runtime did not become ready within $WaitSeconds seconds. Inspect $runtimeErr and $runtimeOut"
