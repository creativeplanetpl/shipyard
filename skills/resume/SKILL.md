---
name: resume
description: Resume a shipyard/boatyard process from where it stopped, in a new thread. With a process name (or a unique prefix), reads its STATUS, SPEC, PLAN and DECISIONS and continues the pipeline; with no argument, lists the open processes from INDEX.md. Use when the user says "resume", "wznów", "continue <process>", or names a process folder.
argument-hint: "[process name or prefix]"
---

# Resume a process

The process layout is in `../shipping-plans-with-agents/process-layout.md`.
Read it first if you have not this session.

## 1. Find the root

`printenv SHIPYARD_HOME`. Unset → stop and tell the user to set it (see
`docs/desktop-setup.md` in the plugin); do not search the disk for it.

## 2. No argument → list

Read `$SHIPYARD_HOME/INDEX.md`. Show every row whose state is not `done`:
name, repo, stage, last change — one line each, newest first. Then list any
folder directly under `$SHIPYARD_HOME` that has a `STATUS.md` but no `INDEX.md`
row, marked "poza indeksem" (older processes from before the layout). Skip
`_archive`. Ask which one to resume and stop.

## 3. Argument → pick the process

Match `$ARGUMENTS` against folder names: exact match first, then a unique
prefix (`film` → `film-workflow-20261026`). Several matches → list them and
ask. None → say so and show the list from step 2.

## 4. Load the state

From the process folder, in this order:

1. `STATUS.md` — the current stage, open tasks, what waits on the user, last
   commit/deploy. It can be long: read the header and the last sections first,
   and search it (`grep -n`) for the stage you land on rather than reading it whole.
2. `SPEC.md` — the requirements; the source of truth.
3. `PLAN.md` — the plan of record.
4. `DECISIONS.md` — the user's answers so far. Never re-ask a question answered here.
5. Older processes may have `HANDOFF.md` and per-stage folders (`stage1/`,
   `step2/`, …) instead; read `HANDOFF.md` too when it exists. Their brief may
   live elsewhere — STATUS or HANDOFF names it.

Then check the claim against the tree, because STATUS can lag a thread that
died mid-step: `git worktree list` in each repo the process names, the
integration branch's last commit, and `git status --short` in each worktree
under `wt/`. Where reality and STATUS disagree, reality wins: say what differs
in one line and correct STATUS.md.

## 5. Claim it

Write the current date and time to `ACTIVE` in the process folder. If `ACTIVE`
already holds a time less than six hours old, ask the user whether another
thread is still working on this process before you change anything.

## 6. Report, then continue

Tell the user in at most four lines: which process, which stage, what is done,
what comes next — and anything under "Czeka na mnie" in STATUS.md, which
needs their answer before you go on.

If nothing waits on them, continue the run with the
`shipping-plans-with-agents` skill from that stage (or `boatyard.md` if STATUS
says boatyard). Every rule there holds. Never redo a finished stage, never
overwrite an earlier stage's artifacts or reviews, and keep STATUS.md and the
`INDEX.md` row current as the process-layout rules say.

`$ARGUMENTS` after the process name are extra instructions from the user for
this resume; follow them.
