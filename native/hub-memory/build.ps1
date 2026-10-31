param(
  [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
  [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot "target/$Architecture" }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio C++ build tools are required.' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'Visual Studio C++ build tools are required.' }
$vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvarsall.bat'
$target = if ($Architecture -eq 'arm64') { 'amd64_arm64' } else { 'amd64' }
# Redirected Windows launches may use a different console encoding. Read the
# cmd built-in's Unicode output explicitly so user-profile paths survive intact.
$originalConsoleEncoding = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = [Text.Encoding]::Unicode
  $buildEnvironment = & $env:ComSpec /u /d /c "call `"$vcvars`" $target >nul && set"
  $environmentExitCode = $LASTEXITCODE
} finally {
  [Console]::OutputEncoding = $originalConsoleEncoding
}
if ($environmentExitCode -ne 0) { throw 'Could not initialize the C++ compiler environment.' }
foreach ($line in $buildEnvironment) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1), 'Process') }
}
[void][IO.Directory]::CreateDirectory($OutputDirectory)
$source = Join-Path $PSScriptRoot 'guard.cpp'
$binary = Join-Path $OutputDirectory 't3-hub-guard.exe'
$object = Join-Path $OutputDirectory 'guard.obj'
& cl.exe /nologo /std:c++17 /O2 /W4 /WX /EHsc /MT /utf-8 $source "/Fo$object" "/Fe$binary" /link /INCREMENTAL:NO
if ($LASTEXITCODE -ne 0) { throw "Hub guard build failed: $LASTEXITCODE" }
$bytes = [IO.File]::ReadAllBytes($binary)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
$expectedMachine = if ($Architecture -eq 'arm64') { 0xaa64 } else { 0x8664 }
if ($machine -ne $expectedMachine) { throw 'Hub guard target architecture mismatch.' }
# A cross-compiled executable cannot run on an x64 build host.
if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant() -eq $Architecture) {
  & $binary --version
  if ($LASTEXITCODE -ne 0) { throw 'Hub guard build verification failed.' }
}
Write-Output $binary
