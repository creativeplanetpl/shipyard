# Sets up Shipyard on a Windows workstation the same way as the reference machine:
#   - Git, Node.js and the Codex CLI on Windows,
#   - WSL 2 + Ubuntu with the Grok CLI inside it (Landlock sandbox, Windows interop off)
#     for the implementer, and the Grok CLI on Windows for the read-only reviewer,
#   - the Shipyard plugin from a local checkout, user scope,
#   - SHIPYARD_HOME and SHIPYARD_USAGE_MONITOR in ~/.claude/settings.json,
#   - the usage monitor ("CP AI Monitor" logon task).
#
# Run it as the person who will use Shipyard, in a normal (not elevated) PowerShell:
#   powershell -ExecutionPolicy Bypass -File Install-Shipyard.ps1 -CheckOnly   # report only
#   powershell -ExecutionPolicy Bypass -File Install-Shipyard.ps1              # install
#
# It is safe to re-run: every step first checks whether it is already done.
# It never logs in anywhere. The sign-ins it cannot do are listed at the end.
# The only step that needs an administrator is installing WSL itself; the script
# stops there and prints the one command to run elevated.
param(
  [string]$ShipyardPath = 'C:\Scripts\shipyard',
  [string]$ShipyardHome = 'C:\Scripts\Workflow\.shipyard',
  [string]$RepoUrl = 'https://github.com/creativeplanetpl/shipyard.git',
  [string]$Distro = 'Ubuntu-24.04',
  [string]$MonitorUrl = 'http://127.0.0.1:43821',
  [string]$MinCodex = '0.167.0',
  [string]$WslNodeVersion = '20.20.2',
  [switch]$SkipWslNode,
  [switch]$SkipGrok,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$script:todo = New-Object System.Collections.Generic.List[string]
$script:failed = $false

function Say([string]$state, [string]$what, [string]$detail) {
  $line = ('{0,-7} {1}' -f $state, $what)
  if ($detail) { $line += " - $detail" }
  Write-Output $line
}
function Have([string]$name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$m;$u"
}
function Winget-Install([string]$id, [string]$label) {
  if (-not (Have 'winget')) { throw "winget is missing, so $label cannot be installed automatically. Install $label by hand and re-run." }
  & winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements | Out-Null
  Refresh-Path
}
function To-WslPath([string]$p) {
  $full = [IO.Path]::GetFullPath($p)
  '/mnt/' + $full.Substring(0, 1).ToLower() + ($full.Substring(2) -replace '\\', '/')
}
# wsl.exe prints UTF-16; strip the NULs so the output can be compared.
# Windows PowerShell turns a native program's stderr into a terminating error when
# $ErrorActionPreference is Stop, so probes run with it relaxed (wsl.exe writes to
# stderr when WSL itself is not installed).
function Wsl-Text {
  $ErrorActionPreference = 'SilentlyContinue'
  try { (& wsl.exe @args 2>$null | Out-String) -replace "`0", '' } catch { '' }
}
function Quiet-Text([scriptblock]$block) {
  $ErrorActionPreference = 'SilentlyContinue'
  try { (& $block 2>$null | Out-String) } catch { '' }
}
# Bash goes to WSL as a file, never as a command-line string: Windows PowerShell
# drops embedded double quotes when it passes arguments to a native program.
function Run-InWsl([string]$user, [string]$bash, [switch]$Probe) {
  $file = Join-Path $env:TEMP ("shipyard-setup-{0}.sh" -f ([guid]::NewGuid().ToString('N')))
  [IO.File]::WriteAllText($file, ($bash -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))
  try {
    if ($Probe) { return (Wsl-Text -d $Distro -u $user -e bash (To-WslPath $file)) }
    & wsl.exe -d $Distro -u $user -e bash (To-WslPath $file)
    if ($LASTEXITCODE -ne 0) { throw "WSL step failed (user $user, exit $LASTEXITCODE)." }
  } finally { Remove-Item $file -Force -ErrorAction SilentlyContinue }
}
$grokProbe = 'test -x "$HOME/.grok/bin/grok" && "$HOME/.grok/bin/grok" --version'

Write-Output "Shipyard setup on $env:COMPUTERNAME for $env:USERNAME$(if ($CheckOnly) { ' (check only, nothing is changed)' })"
Write-Output ''

# --- 1. Windows tools ---------------------------------------------------------
foreach ($t in @(@{ n = 'git'; id = 'Git.Git'; l = 'Git for Windows' }, @{ n = 'node'; id = 'OpenJS.NodeJS.LTS'; l = 'Node.js LTS' })) {
  if (Have $t.n) { Say 'OK' $t.l ((& $t.n --version) -join ' ') }
  elseif ($CheckOnly) { Say 'MISSING' $t.l 'would install with winget' }
  else { Winget-Install $t.id $t.l; if (Have $t.n) { Say 'DONE' $t.l ((& $t.n --version) -join ' ') } else { throw "$($t.l) is still not on PATH. Open a new PowerShell window and re-run." } }
}

$codexVer = $null
if (Have 'codex') { $codexVer = ((& codex --version) -join ' ') -replace '^[^\d]*', '' }
$codexOk = $false
if ($codexVer) { try { $codexOk = [version]($codexVer -replace '-.*$', '') -ge [version]$MinCodex } catch { $codexOk = $false } }
if ($codexOk) { Say 'OK' 'Codex CLI' $codexVer }
elseif ($CheckOnly) { Say 'MISSING' 'Codex CLI' "have '$codexVer', need $MinCodex or newer; would run npm install -g @openai/codex" }
elseif (-not (Have 'npm')) { throw 'npm is not on PATH; cannot install the Codex CLI.' }
else {
  & npm install -g '@openai/codex' | Out-Null
  Refresh-Path
  Say 'DONE' 'Codex CLI' ((& codex --version) -join ' ')
}

# --- 2. Shipyard checkout -----------------------------------------------------
if (Test-Path (Join-Path $ShipyardPath '.claude-plugin\plugin.json')) {
  Say 'OK' 'Shipyard checkout' $ShipyardPath
} elseif ($CheckOnly) { Say 'MISSING' 'Shipyard checkout' "would clone $RepoUrl to $ShipyardPath" }
else {
  if (Test-Path $ShipyardPath) { throw "$ShipyardPath exists but is not a Shipyard checkout. Move it away and re-run." }
  New-Item -ItemType Directory -Force (Split-Path $ShipyardPath -Parent) | Out-Null
  & git clone $RepoUrl $ShipyardPath
  if ($LASTEXITCODE -ne 0) { throw "git clone failed. Sign in to GitHub with access to $RepoUrl and re-run." }
  Say 'DONE' 'Shipyard checkout' $ShipyardPath
}

# --- 3. ~/.claude/settings.json ------------------------------------------------
$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
$settings = New-Object psobject
if (Test-Path $settingsPath) { $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json }
function Ensure-Object($parent, [string]$name) {
  if (-not ($parent.PSObject.Properties.Name -contains $name) -or $null -eq $parent.$name) {
    $parent | Add-Member -NotePropertyName $name -NotePropertyValue (New-Object psobject) -Force
  }
  $parent.$name
}
function Ensure-Value($parent, [string]$name, $value) {
  $has = $parent.PSObject.Properties.Name -contains $name
  if ($has -and (($parent.$name | ConvertTo-Json -Depth 10 -Compress) -eq ($value | ConvertTo-Json -Depth 10 -Compress))) { return $false }
  $parent | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
  $true
}
$changed = $false
$envObj = Ensure-Object $settings 'env'
if (Ensure-Value $envObj 'SHIPYARD_HOME' $ShipyardHome) { $changed = $true }
if (Ensure-Value $envObj 'SHIPYARD_USAGE_MONITOR' $MonitorUrl) { $changed = $true }
$markets = Ensure-Object $settings 'extraKnownMarketplaces'
$marketValue = [pscustomobject]@{ source = [pscustomobject]@{ source = 'directory'; path = $ShipyardPath } }
if (Ensure-Value $markets 'shipyard' $marketValue) { $changed = $true }
$plugins = Ensure-Object $settings 'enabledPlugins'
if (Ensure-Value $plugins 'shipyard@shipyard' $true) { $changed = $true }
if (-not $changed) { Say 'OK' 'Claude settings' 'plugin enabled, SHIPYARD_HOME and SHIPYARD_USAGE_MONITOR set' }
elseif ($CheckOnly) { Say 'MISSING' 'Claude settings' "would add the plugin and both variables to $settingsPath" }
else {
  New-Item -ItemType Directory -Force (Split-Path $settingsPath -Parent) | Out-Null
  if (Test-Path $settingsPath) { Copy-Item $settingsPath "$settingsPath.before-shipyard" -Force }
  [IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding($false)))
  Say 'DONE' 'Claude settings' "written; previous copy in settings.json.before-shipyard"
}
if (Test-Path $ShipyardHome) { Say 'OK' 'Process folder' $ShipyardHome }
elseif ($CheckOnly) { Say 'MISSING' 'Process folder' "would create $ShipyardHome" }
else { New-Item -ItemType Directory -Force $ShipyardHome | Out-Null; Say 'DONE' 'Process folder' $ShipyardHome }

# --- 4. Plugin registration ---------------------------------------------------
if (Have 'claude') {
  $listed = (Quiet-Text { claude plugin list }) -match 'shipyard@shipyard'
  if ($listed) { Say 'OK' 'Shipyard plugin' 'installed' }
  elseif ($CheckOnly) { Say 'MISSING' 'Shipyard plugin' 'would register the marketplace and install shipyard@shipyard' }
  else {
    & claude plugin marketplace add $ShipyardPath | Out-Null
    & claude plugin install 'shipyard@shipyard' --scope user | Out-Null
    $listed = (Quiet-Text { claude plugin list }) -match 'shipyard@shipyard'
    if ($listed) { Say 'DONE' 'Shipyard plugin' 'installed, user scope' }
    else { Say 'FAIL' 'Shipyard plugin' 'claude plugin install did not register it'; $script:failed = $true }
  }
} else {
  Say 'TODO' 'Shipyard plugin' 'no claude command on PATH; settings.json already enables it'
  $script:todo.Add("Plugin: open a NEW thread in Claude Desktop > Code and type /shipyard:doctor in the message box (not in PowerShell). If the command is unknown, run here:  npm install -g @anthropic-ai/claude-code  and re-run this script.")
}

# --- 5. WSL + Grok ------------------------------------------------------------
if ($SkipGrok) { Say 'SKIP' 'WSL and Grok' '-SkipGrok given; set SHIPYARD_NO_GROK=1 to run the pipeline without Grok' }
else {
  $distros = @()
  if (Have 'wsl.exe') { $distros = (Wsl-Text -l -q) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
  if ($distros -notcontains $Distro) {
    Say 'MISSING' "WSL distro $Distro" 'needs an administrator and a restart'
    $script:todo.Add("Open PowerShell as Administrator and run:  wsl --install -d $Distro --no-launch   Restart Windows, then run this script again.")
  } else {
    Say 'OK' "WSL distro $Distro" 'registered'
    $probe = (Run-InWsl 'root' @'
grep -q '^enabled=false' /etc/wsl.conf 2>/dev/null && echo conf=off
head -1 /proc/sys/fs/binfmt_misc/WSLInterop 2>/dev/null | sed 's/^/binfmt=/'
command -v bwrap >/dev/null && echo bwrap=yes
awk -F: '$3>=1000 && $3<60000 {print "user=" $1; exit}' /etc/passwd
'@ -Probe) -split "`r?`n" | ForEach-Object { $_.Trim() }
    $linuxUser = ($probe | Where-Object { $_ -like 'user=*' } | Select-Object -First 1) -replace '^user=', ''
    $interopOff = ($probe -contains 'conf=off') -and ($probe -contains 'binfmt=disabled')
    $hasBwrap = $probe -contains 'bwrap=yes'
    if ($interopOff -and $hasBwrap -and $linuxUser) { Say 'OK' 'WSL sandbox setup' "user $linuxUser, interop off, bubblewrap present" }
    elseif ($CheckOnly) { Say 'MISSING' 'WSL sandbox setup' "user='$linuxUser' interopOff=$interopOff bubblewrap=$hasBwrap; would configure" }
    else {
      if (-not $linuxUser) { $linuxUser = ($env:USERNAME.ToLower() -replace '[^a-z0-9]', ''); if (-not $linuxUser) { $linuxUser = 'shipyard' } }
      $nodeBlock = ''
      if (-not $SkipWslNode) {
        $nodeBlock = @"
if [ ! -x /opt/node20/bin/node ]; then
  curl -fsSL https://nodejs.org/dist/v$WslNodeVersion/node-v$WslNodeVersion-linux-x64.tar.xz -o /tmp/node.tar.xz
  mkdir -p /opt/node20 && tar -xJf /tmp/node.tar.xz -C /opt/node20 --strip-components=1 && rm -f /tmp/node.tar.xz
  ln -sf /opt/node20/bin/node /usr/local/bin/node
  ln -sf /opt/node20/bin/npm /usr/local/bin/npm
  ln -sf /opt/node20/bin/npx /usr/local/bin/npx
fi
"@
      }
      $rootScript = @"
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq bubblewrap git curl ca-certificates xz-utils >/dev/null
id -u $linuxUser >/dev/null 2>&1 || useradd -m -s /bin/bash $linuxUser
$nodeBlock
cat > /etc/wsl.conf <<'CONF'
[boot]
systemd=true
command = "echo 0 > /proc/sys/fs/binfmt_misc/WSLInterop"

[user]
default=$linuxUser

[interop]
enabled=false
appendWindowsPath=false
CONF
cat > /etc/systemd/system/wsl-interop-off.service <<'UNIT'
[Unit]
Description=Disable WSL Windows interop binfmt entry (Grok sandbox)
After=systemd-binfmt.service
ConditionPathExists=/proc/sys/fs/binfmt_misc/WSLInterop

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo 0 > /proc/sys/fs/binfmt_misc/WSLInterop'

[Install]
WantedBy=multi-user.target
UNIT
ln -sf /etc/systemd/system/wsl-interop-off.service /etc/systemd/system/multi-user.target.wants/wsl-interop-off.service
"@
      Run-InWsl 'root' $rootScript
      & wsl.exe --terminate $Distro | Out-Null
      $state = Run-InWsl 'root' 'head -1 /proc/sys/fs/binfmt_misc/WSLInterop 2>/dev/null' -Probe
      if ($state -match 'disabled') { Say 'DONE' 'WSL sandbox setup' "user $linuxUser, interop off, bubblewrap installed" }
      else { Say 'FAIL' 'WSL sandbox setup' "interop is still '$($state.Trim())' after restart of the distro"; $script:failed = $true }
    }

    if ($linuxUser) {
      $grokVer = (Run-InWsl $linuxUser $grokProbe -Probe).Trim()
      if ($grokVer) { Say 'OK' 'Grok CLI in WSL' $grokVer }
      elseif ($CheckOnly) { Say 'MISSING' 'Grok CLI in WSL' 'would install with the x.ai installer' }
      else {
        Run-InWsl $linuxUser "set -e`ncurl -fsSL https://x.ai/cli/install.sh | bash >/dev/null`n"
        $grokVer = (Run-InWsl $linuxUser $grokProbe -Probe).Trim()
        if ($grokVer) { Say 'DONE' 'Grok CLI in WSL' $grokVer } else { Say 'FAIL' 'Grok CLI in WSL' 'installer finished but ~/.grok/bin/grok is missing'; $script:failed = $true }
      }
      $script:todo.Add("Grok sign-in (inside WSL):  wsl -d $Distro -e sh -c '`$HOME/.grok/bin/grok login'")
    } elseif ($CheckOnly) { Say 'MISSING' 'Grok CLI in WSL' 'no Linux user yet; would create one and install' }
  }
}

# --- 5b. Grok on Windows (reviewer) --------------------------------------------
# grok-reviewer runs the Windows binary: it gets read-only tools and deny rules
# and no shell, so it cannot write. Only the implementer needs the WSL sandbox.
if (-not $SkipGrok) {
  $winGrok = Join-Path $env:USERPROFILE '.grok\bin\grok.exe'
  if ((Have 'grok') -or (Test-Path $winGrok)) {
    $exe = if (Have 'grok') { 'grok' } else { $winGrok }
    Say 'OK' 'Grok CLI on Windows' ((Quiet-Text { & $exe --version }).Trim())
  } elseif ($CheckOnly) { Say 'MISSING' 'Grok CLI on Windows' 'would install with the x.ai PowerShell installer' }
  else {
    Invoke-Expression (Invoke-RestMethod 'https://x.ai/cli/install.ps1') | Out-Null
    Refresh-Path
    if (Test-Path $winGrok) { Say 'DONE' 'Grok CLI on Windows' ((Quiet-Text { & $winGrok --version }).Trim()) }
    else { Say 'FAIL' 'Grok CLI on Windows' 'installer finished but ~\.grok\bin\grok.exe is missing'; $script:failed = $true }
  }
  $script:todo.Add('Grok sign-in on Windows (open a NEW terminal first):  grok login')
}

# --- 6. Usage monitor ---------------------------------------------------------
$monitorScript = Join-Path $ShipyardPath 'scripts\Install-UsageMonitor.ps1'
$task = Get-ScheduledTask -TaskName 'CP AI Monitor' -ErrorAction SilentlyContinue
if ($task) { Say 'OK' 'Usage monitor' "task 'CP AI Monitor' registered" }
elseif ($CheckOnly) { Say 'MISSING' 'Usage monitor' 'would run Install-UsageMonitor.ps1' }
elseif (-not (Test-Path $monitorScript)) { Say 'FAIL' 'Usage monitor' "not found: $monitorScript"; $script:failed = $true }
else { & $monitorScript | Out-Null; Say 'DONE' 'Usage monitor' "task 'CP AI Monitor' registered and started" }

# --- 7. What is left for the person -------------------------------------------
$script:todo.Add('Claude Desktop: sign in with your own account and open the Code tab.')
$script:todo.Add('Codex sign-in (Terminal panel in Claude Desktop):  codex login')
$script:todo.Add('Then open a new thread and run  /shipyard:doctor  - every line should be PASS or N/A.')
Write-Output ''
Write-Output 'Left for you (sign-ins are personal, the script never does them):'
$i = 1
foreach ($t in $script:todo) { Write-Output ("  {0}. {1}" -f $i, $t); $i++ }
if ($script:failed) { Write-Output ''; Write-Output 'Some steps FAILED - see above.'; exit 1 }
