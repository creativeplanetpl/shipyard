<#
.SYNOPSIS
  Removes git worktrees safely when they may contain NTFS junctions or symlinks.

.DESCRIPTION
  Recursive deletes follow junctions on Windows (Remove-Item -Recurse in
  PowerShell 5.1, rmdir in some git builds), so a worktree whose node_modules or
  deps folder is a junction into a shared tree can take that tree with it. This
  script never deletes recursively through a reparse point:

    1. Refuses any path that is not a registered worktree of its repository,
       or that is the repository's main checkout.
    2. Refuses a worktree with uncommitted changes unless -Force.
    3. Walks the tree WITHOUT descending into reparse points and unlinks each
       junction/symlink on its own (the link, never its target).
    4. Re-walks to confirm none is left, then runs `git worktree remove`.
       If git cannot remove it, the script stops; it never falls back to rm.

  Branches are kept. Use -WhatIf to see what would happen.

.EXAMPLE
  Remove-ShipyardWorktree.ps1 -Path C:\Scripts\Workflow\.shipyard\x-20261112\wt\cp-tool-t1 -WhatIf
  Remove-ShipyardWorktree.ps1 -Process x-20261112          # every worktree in that process's wt\
#>
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Path')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Path')][string[]]$Path,
  [Parameter(Mandatory, ParameterSetName = 'Process')][string]$Process,
  [string]$Root = $env:SHIPYARD_HOME,
  [switch]$Force
)
$ErrorActionPreference = 'Continue'   # 'Stop' turns git's stderr into terminating errors in PS 5.1
$Reparse = [System.IO.FileAttributes]::ReparsePoint

function Get-ReparsePoints([string]$dir) {
  # Iterative walk that never enters a reparse point.
  $found = New-Object System.Collections.Generic.List[string]
  $stack = New-Object System.Collections.Generic.Stack[string]
  $stack.Push($dir)
  while ($stack.Count) {
    $d = $stack.Pop()
    try { $entries = [System.IO.Directory]::EnumerateFileSystemEntries($d) } catch { Write-Warning "Cannot list $d : $_"; continue }
    foreach ($e in $entries) {
      $attr = [System.IO.File]::GetAttributes($e)
      if ($attr -band $Reparse) { $found.Add($e) }
      elseif ($attr -band [System.IO.FileAttributes]::Directory) { $stack.Push($e) }
    }
  }
  return ,$found
}

function Remove-Link([string]$p) {
  $attr = [System.IO.File]::GetAttributes($p)
  if ($attr -band [System.IO.FileAttributes]::Directory) {
    [System.IO.Directory]::Delete($p, $false)   # non-recursive: removes the link only
  } else {
    [System.IO.File]::Delete($p)                # file symlink: removes the link only
  }
}

if ($PSCmdlet.ParameterSetName -eq 'Process') {
  if (-not $Root) { throw 'SHIPYARD_HOME is not set; pass -Root.' }
  $wtDir = Join-Path (Join-Path $Root $Process) 'wt'
  if (-not (Test-Path $wtDir)) { throw "No wt folder: $wtDir" }
  $Path = @((Get-ChildItem -LiteralPath $wtDir -Directory -Force).FullName)
  if (-not $Path) { Write-Output "Nothing to remove in $wtDir"; return }
}

$failed = 0
$pruned = @()
foreach ($p in $Path) {
  $full = [System.IO.Path]::GetFullPath($p).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $full)) { Write-Warning "Missing, skipped: $full"; continue }
  if ([System.IO.File]::GetAttributes($full) -band $Reparse) { Write-Warning "Is itself a link, skipped: $full"; $failed++; continue }

  $common = git -C $full rev-parse --path-format=absolute --git-common-dir 2>$null
  $top = git -C $full rev-parse --show-toplevel 2>$null
  if (-not $common -or -not $top) { Write-Warning "Not a git worktree, skipped: $full"; $failed++; continue }
  $top = ([System.IO.Path]::GetFullPath($top)).TrimEnd('\')
  if ($top -ne $full) { Write-Warning "Not a worktree root (top is $top), skipped: $full"; $failed++; continue }
  $mainRepo = Split-Path ([System.IO.Path]::GetFullPath($common).TrimEnd('\')) -Parent
  if ($mainRepo -eq $full) { Write-Warning "Main checkout, never removed: $full"; $failed++; continue }

  $registered = git -C $mainRepo worktree list --porcelain | Where-Object { $_ -like 'worktree *' } |
    ForEach-Object { [System.IO.Path]::GetFullPath($_.Substring(9)).TrimEnd('\') }
  if ($registered -notcontains $full) { Write-Warning "Not registered in $mainRepo, skipped: $full"; $failed++; continue }

  # Untracked junctions/symlinks (node_modules -> shared deps) are not work; anything else is.
  $dirty = @(git -C $full status --porcelain -uall 2>$null | Where-Object {
    if ($_ -notlike '?? *') { return $true }
    $p = Join-Path $full ($_.Substring(3).Trim('"').TrimEnd('/') -replace '/', '\')
    while ($p.Length -gt $full.Length) {       # under a link (git may list files through it)?
      if ((Test-Path -LiteralPath $p) -and ([System.IO.File]::GetAttributes($p) -band $Reparse)) { return $false }
      $p = Split-Path $p -Parent
    }
    return $true
  })
  if ($dirty -and -not $Force) { Write-Warning "Uncommitted changes, skipped (use -Force): $full"; $failed++; continue }

  $links = Get-ReparsePoints $full
  $branch = git -C $full rev-parse --abbrev-ref HEAD
  if (-not $PSCmdlet.ShouldProcess($full, "unlink $($links.Count) junction(s)/symlink(s), then git worktree remove (branch $branch kept)")) { continue }

  foreach ($l in $links) { Write-Output "  unlink $l"; Remove-Link $l }
  $left = Get-ReparsePoints $full
  if ($left.Count) { Write-Warning "Links still present, stopped: $full"; $failed++; continue }

  git -C $mainRepo worktree remove --force $full
  if ($LASTEXITCODE) { Write-Warning "git worktree remove failed; folder left as is: $full"; $failed++; continue }
  Write-Output "Removed $full (branch $branch kept)"
  $pruned += $mainRepo
}
$pruned | Select-Object -Unique | ForEach-Object { git -C $_ worktree prune 2>$null }
if ($failed) { exit 1 }
