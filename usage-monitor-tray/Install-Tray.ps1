<#
.SYNOPSIS
  Installs the AI Monitor tray app for the current user. No administrator rights needed.
.DESCRIPTION
  Copies the packaged app to %LOCALAPPDATA%\cp-AImonitor\tray, registers it to start at logon
  (HKCU ...\Run) and starts it. The background service and its "CP AI Monitor" logon task are
  not touched. Use -Build to package the app from source first (needs Node.js 20 or newer).
#>
[CmdletBinding()]
param(
  [string]$Source,
  [switch]$Build,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'

# $PSScriptRoot can be empty inside param() when started with "powershell -File" on Windows PowerShell 5.1.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Source) { $Source = Join-Path $here 'release\AI Monitor-win32-x64' }

$exeName = 'AI Monitor.exe'
$target = Join-Path $env:LOCALAPPDATA 'cp-AImonitor\tray'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'CP AI Monitor Tray'

if ($Build) {
  Push-Location $here
  try {
    npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    npm run package
    if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
  } finally { Pop-Location }
}

if (-not (Test-Path (Join-Path $Source $exeName))) {
  throw "Packaged app not found in '$Source'. Copy the 'AI Monitor-win32-x64' folder next to this script (in 'release'), or run with -Build."
}

# Stop only a copy that runs from the install folder.
Get-Process -Name 'AI Monitor' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($target, [System.StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force
Start-Sleep -Milliseconds 800

New-Item -ItemType Directory -Force $target | Out-Null
robocopy $Source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit code $LASTEXITCODE)." }
$global:LASTEXITCODE = 0

$exe = Join-Path $target $exeName
Set-ItemProperty -Path $runKey -Name $runName -Value "`"$exe`""

try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://127.0.0.1:43821/snapshot' | Out-Null
  Write-Host 'Background service: answering on 127.0.0.1:43821.'
} catch {
  Write-Warning 'The background service is not answering on 127.0.0.1:43821. Codex and Grok will show as unavailable until it is installed (Shipyard: scripts\Install-UsageMonitor.ps1).'
}

if (-not $NoStart) { Start-Process -FilePath $exe }
Write-Host "Installed to $target and set to start at logon."
Write-Host 'Next: right-click the tray icon (near the clock) and choose "Sign in to Claude".'
