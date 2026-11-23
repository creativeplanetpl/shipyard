# Installs (or removes with -Remove) the Shipyard usage monitor on Windows.
# Copies usage-monitor/ to %LOCALAPPDATA%\cp-AImonitor\service, so plugin updates never move
# the running copy, and registers a per-user logon task "CP AI Monitor" that starts it hidden.
# No admin rights needed. Re-run after a plugin update to install the new version.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'CP AI Monitor'
$target = Join-Path $env:LOCALAPPDATA 'cp-AImonitor\service'

function Stop-Monitor {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'server\.js' -and $_.CommandLine -match 'cp-AImonitor' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Stop-Monitor
  Write-Output "Removed task '$name' and stopped the service. History stays in $(Split-Path $target)."
  return
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not on PATH; install Node 18+ first.' }
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'usage-monitor'
if (-not (Test-Path (Join-Path $source 'server.js'))) { throw "usage-monitor not found next to scripts: $source" }

Stop-Monitor
New-Item -ItemType Directory -Force $target | Out-Null
Get-ChildItem $source -File | Where-Object { $_.Extension -in '.js', '.vbs', '.ps1' } |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $target $_.Name) -Force }

$vbs = Join-Path $target 'start-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Shipyard usage monitor: Claude/Grok/Codex limits on 127.0.0.1:43821 (/pace, /model)' -Force | Out-Null
Start-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
# A non-interactive shell (e.g. an agent's) may be refused the task start (0x800710E0);
# the logon trigger still works, so start this session's copy directly.
$up = $false
try { $up = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:43821/pace' -TimeoutSec 5).StatusCode -eq 200 } catch {}
if (-not $up) { Start-Process wscript.exe -ArgumentList "`"$vbs`""; Start-Sleep -Seconds 5 }
try {
  $code = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:43821/pace' -TimeoutSec 10).StatusCode
  Write-Output "Installed to $target; task '$name' registered; service answers ($code)."
} catch {
  Write-Output "Installed to $target; task '$name' registered, but the service does not answer yet: $($_.Exception.Message)"
}
