<#
.SYNOPSIS
  Closes a finished Shipyard process: removes its worktrees (junction-safe),
  marks it done in INDEX.md and moves its folder to _archive\.

.DESCRIPTION
  Stops without moving anything if any worktree could not be removed. Branches
  are kept; delete them yourself once merged. Use -WhatIf first.

.EXAMPLE
  Close-ShipyardProcess.ps1 -Process cp-delivery-20261112 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$Process,
  [string]$Root = $env:SHIPYARD_HOME
)
$ErrorActionPreference = 'Continue'   # failures throw explicitly
if (-not $Root) { throw 'SHIPYARD_HOME is not set; pass -Root.' }
$dir = Join-Path $Root $Process
if (-not (Test-Path $dir)) { throw "No such process: $dir" }

$wt = Join-Path $dir 'wt'
if ((Test-Path $wt) -and @(Get-ChildItem -LiteralPath $wt -Force).Count) {
  $global:LASTEXITCODE = 0
  & (Join-Path $PSScriptRoot 'Remove-ShipyardWorktree.ps1') -Process $Process -Root $Root -WhatIf:$WhatIfPreference
  if ($LASTEXITCODE) { throw 'Some worktrees were not removed; process left in place.' }
}
if ($WhatIfPreference) { Write-Output "What if: mark $Process done in INDEX.md and move to _archive\"; return }
if ((Test-Path $wt) -and (Get-ChildItem -LiteralPath $wt -Force)) { throw "wt\ is not empty; process left in place." }

$index = Join-Path $Root 'INDEX.md'
if (Test-Path $index) {
  $now = Get-Date -Format 'yyyy-MM-dd HH:mm'
  $lines = Get-Content -Encoding utf8 $index | ForEach-Object {
    if ($_ -match "^\|\s*$([regex]::Escape($Process))\s*\|") {
      $c = $_.Trim('|').Split('|') | ForEach-Object { $_.Trim() }
      "| $($c[0]) | $($c[1]) | $($c[2]) | $($c[3]) | $now | done |"
    } else { $_ }
  }
  Set-Content -Encoding utf8 $index $lines
}

$archive = Join-Path $Root '_archive'
New-Item -ItemType Directory -Force $archive | Out-Null
Move-Item -LiteralPath $dir -Destination $archive
Write-Output "Archived: $archive\$Process"
