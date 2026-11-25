<#
.SYNOPSIS
  Removes the AI Monitor tray app for the current user: the program, its logon entry and its
  saved Claude sign-in. The background service and its "CP AI Monitor" logon task stay.
#>
[CmdletBinding()]
param([switch]$KeepSignIn)
$ErrorActionPreference = 'Stop'

$root = Join-Path $env:LOCALAPPDATA 'cp-AImonitor'
$target = Join-Path $root 'tray'
$data = Join-Path $root 'tray-data'

Get-Process -Name 'AI Monitor' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($target, [System.StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force
Start-Sleep -Milliseconds 800

Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'CP AI Monitor Tray' -ErrorAction SilentlyContinue
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
if (-not $KeepSignIn -and (Test-Path $data)) { Remove-Item -Recurse -Force $data }
Write-Host 'AI Monitor tray app removed. The background service was left in place.'
