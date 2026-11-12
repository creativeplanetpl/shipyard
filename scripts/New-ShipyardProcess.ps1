<#
.SYNOPSIS
  Opens a new Shipyard process: its folder, SPEC/PLAN/STATUS/DECISIONS, an INDEX.md
  row, and one integration worktree per repo on branch shipyard/<process>.

.DESCRIPTION
  Layout (under $env:SHIPYARD_HOME):
    INDEX.md
    <name>-<yyyymmdd>\SPEC.md PLAN.md STATUS.md DECISIONS.md briefs\ reviews\ wt\ scratch\
    _archive\
  Live checkouts are never touched beyond `git fetch`: every worktree is created
  from origin/<default branch> under the process's wt\ folder.

.EXAMPLE
  New-ShipyardProcess.ps1 -Name cp-delivery -Repo C:\Scripts\Node\cp-tool,C:\Scripts\Workflow\cp-api -Spec C:\path\brief.md
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]*$')][string]$Name,
  [Parameter(Mandatory)][string[]]$Repo,
  [string]$Spec,
  [string]$Date = (Get-Date -Format 'yyyyMMdd'),
  [string]$Root = $env:SHIPYARD_HOME
)
$ErrorActionPreference = 'Continue'   # 'Stop' turns git's stderr into terminating errors in PS 5.1; failures throw explicitly
if (-not $Root) { throw 'SHIPYARD_HOME is not set. See docs/desktop-setup.md.' }

$process = "$Name-$Date"
$dir = Join-Path $Root $process
$branch = "shipyard/$process"
if (Test-Path $dir) { throw "Process folder already exists: $dir" }

# Validate repos before creating anything.
$repos = foreach ($r in $Repo) {
  $top = (git -C $r rev-parse --show-toplevel 2>$null)
  if (-not $top) { throw "Not a git repository: $r" }
  $top = $top -replace '/', '\'
  $hasOrigin = [bool](git -C $top remote get-url origin 2>$null)
  $def = if ($hasOrigin) { git -C $top symbolic-ref --short refs/remotes/origin/HEAD 2>$null }
  if (-not $def -and $hasOrigin) { git -C $top rev-parse --verify --quiet origin/main 2>$null | Out-Null; if (-not $LASTEXITCODE) { $def = 'origin/main' } }
  if (-not $def) { throw "Cannot find origin's default branch for $top (set it: git remote set-head origin -a)" }
  [pscustomobject]@{ Path = $top; Name = Split-Path $top -Leaf; Base = $def }
}

if (-not $PSCmdlet.ShouldProcess($dir, 'create process')) { return }

New-Item -ItemType Directory -Force -Path $dir, "$dir\briefs", "$dir\reviews", "$dir\wt", "$dir\scratch" | Out-Null

$now = Get-Date -Format 'yyyy-MM-dd HH:mm'
$repoList = ($repos | ForEach-Object { "$($_.Name) ($($_.Path))" }) -join ', '
$wtList = ($repos | ForEach-Object { "wt\$($_.Name)-int" }) -join ', '

if ($Spec) { Copy-Item -LiteralPath $Spec -Destination "$dir\SPEC.md" }
else { Set-Content -Encoding utf8 "$dir\SPEC.md" "# SPEC - $process`n`n(Your requirements. Source of truth.)`n" }

Set-Content -Encoding utf8 "$dir\PLAN.md" "# PLAN - $process`n`n(Written in stage 1, revised after stage 2.)`n"
Set-Content -Encoding utf8 "$dir\DECISIONS.md" "# DECISIONS - $process`n`n| Data | Pytanie | Decyzja |`n|---|---|---|`n"
Set-Content -Encoding utf8 "$dir\STATUS.md" @"
# STATUS - $process

- **Etap:** 0 - zalozony
- **Repo:** $repoList
- **Galaz:** $branch
- **Worktree integracyjne:** $wtList
- **Ostatni commit:** -
- **Ostatni deploy:** -
- **Ostatnia zmiana:** $now

## Otwarte zadania

## Czeka na mnie

## Historia

- $now - proces zalozony
"@

foreach ($r in $repos) {
  git -C $r.Path fetch origin --quiet
  $wt = Join-Path $dir "wt\$($r.Name)-int"
  git -C $r.Path worktree add --no-track $wt -b $branch $r.Base
  if ($LASTEXITCODE) { throw "git worktree add failed for $($r.Path)" }
}

# INDEX.md row
$index = Join-Path $Root 'INDEX.md'
if (-not (Test-Path $index)) {
  Set-Content -Encoding utf8 $index "# Shipyard - procesy`n`n| Proces | Repo | Galaz | Etap | Ostatnia zmiana | Stan |`n|---|---|---|---|---|---|"
}
$repoNames = ($repos | ForEach-Object Name) -join ', '
Add-Content -Encoding utf8 $index "| $process | $repoNames | $branch | 0 - zalozony | $now | aktywny |"

Write-Output "Process: $dir"
Write-Output "Branch:  $branch"
$repos | ForEach-Object { Write-Output "Worktree: $dir\wt\$($_.Name)-int  (from $($_.Base))" }
