# Process layout

Every shipyard or boatyard run is a **process**: one folder, one branch name,
its own worktrees. This is what lets `/shipyard:resume` pick a run back up in a
new thread, and lets several threads run different processes side by side.

## Where

`SHIPYARD_HOME` names the root (`printenv SHIPYARD_HOME`). Unset → ask the user
once where processes should live, and suggest setting it in
`~/.claude/settings.json` under `env`. Never guess a root.

```
$SHIPYARD_HOME/
  INDEX.md                  one row per process
  <name>-<yyyymmdd>/
    SPEC.md                 the user's requirements — source of truth, never rewritten by you
    PLAN.md                 plan of record after stage 2
    STATUS.md               stage, open tasks, what waits on the user, last commit/deploy
    DECISIONS.md            the user's decisions and answers, dated, verbatim where short
    briefs/                 implementer and repair briefs
    reviews/                every review, one file each (stage-reviewer-round.md)
    wt/                     worktrees: <repo>-<task>, and <repo>-int for integration
    scratch/                temporary files
  _archive/                 closed processes
```

## Opening a process

Before stage 1, if the run has no process folder yet:

```powershell
& "<plugin root>/scripts/New-ShipyardProcess.ps1" -Name <slug> -Repo <live checkout>[,<live checkout>...] [-Spec <brief.md>]
```

It creates the folder and files above, adds the `INDEX.md` row, fetches each
repo and creates `wt/<repo>-int` on branch `shipyard/<name>-<yyyymmdd>` from
`origin`'s default branch. On machines without PowerShell, do the same by hand.

## Rules

- **Live checkouts are read-only to the pipeline.** Every edit, build, merge and
  commit happens in the process's `wt/`. The live checkout gets `git fetch`
  from you and `git pull` only after the user approves the merged PR.
- **Branch names:** integration branch `shipyard/<process>`; task branches
  `shipyard/<process>-<task>`, each in `wt/<repo>-<task>` (not
  `shipyard/<process>/<task>`: git cannot hold a branch and a folder of
  branches under the same name).
- **Never push or modify a protected default branch** (`main`, `master`). Push
  the integration branch and open a PR.
- **STATUS.md is updated at every stage change, every merge, and every time you
  stop to wait for the user** — stage, open tasks, "Czeka na mnie" (what the
  user must decide), last commit and deploy, and a dated line in Historia. Then
  update the process's row in `INDEX.md` (stage, last change). A thread can die
  at any moment; STATUS.md is the only memory the next one gets.
- **Record the user's answers in DECISIONS.md** as they happen, with the date.
- **Save every review verbatim** to `reviews/` before folding it.
- **Removing worktrees:** only with `scripts/Remove-ShipyardWorktree.ps1`. Worktrees
  often hold junctions (shared `node_modules`, deps); a recursive delete follows
  them and destroys the target. Never `Remove-Item -Recurse`, `rm -rf` or
  `rmdir /s` a folder that may contain one.
- **Closing:** after the PR merges and the user says the process is done,
  `scripts/Close-ShipyardProcess.ps1 -Process <name>` removes the worktrees,
  marks the row `done` and moves the folder to `_archive/`.
- **One thread, one process.** On resume, write the current time to `ACTIVE`
  in the process folder; if `ACTIVE` already holds a time from the last six
  hours, ask the user whether another thread is still running it before going on.
