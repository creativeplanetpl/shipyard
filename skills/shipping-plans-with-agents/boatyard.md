# Boatyard

Shipyard with a smaller crew, for work that is neither large nor hard.
Everything in `SKILL.md` holds — worktrees you create and seed, paths not
pasted files, blockers gate and verdict words don't, citation checks,
round caps, delta reviews, stop-and-ask on a declined blocker, the env-var
switches — except the cast below.

| Stage | Shipyard | Boatyard |
|---|---|---|
| 1. Plan | `astra` | `opus` (job 1) |
| 2. Plan review | `fable` + fresh `astra` + `grok-reviewer` | `fable` + fresh `opus` (job 2) |
| 3. Implement | by tag, `HARD` → `sonnet-implementer` | by tag, no `HARD` |
| 4. Task review | `opus-reviewer` | `sonnet-reviewer` |
| 5. Branch review | `fable` + `astra` + `grok-reviewer` (+ `mythos`) | fresh `opus` (job 3) + `fable` (+ `mythos`) |

Routing in stage 3: `TRIVIAL` → `bonsai-implementer` (`codex` when
`CLAUDE_LOCAL_AVAILABLE` is unset), `EASY` → `codex`, `ROUTINE` →
`grok-implementer` (`codex` when `SHIPYARD_NO_GROK` is set).
`SHIPYARD_NO_GROK` changes nothing else here — boatyard has no Grok
reviewer. `SHIPYARD_SECURITY_SCAN` adds `mythos` to stage 5 exactly as in
shipyard.

The two `opus` reviews are fresh dispatches: the spec and the plan text
(or diff), never the planning run's context. Same reason as Astra in
shipyard — the reviewer must not share the author's blind spot.

**A `HARD` tag means triage was wrong.** If the stage-1 plan, a stage-2
reviewer, or a stage-5 repair says a task is `HARD`, stop boatyard, tell
the user in one line which task and why, and restart in shipyard from
stage 1 with the same spec. Work already merged stays on the branch; give
Astra the branch state as context. Never hand a `HARD` task to a boatyard
implementer.

## Red flags

- Dispatching `opus-reviewer` or `astra` in boatyard, or `sonnet-reviewer`
  in shipyard → the cast is per mode; follow the table.
- Reusing the planning `opus` run for its stage-2 or stage-5 review → that
  is the author reviewing itself.
- Implementing a `HARD` task in boatyard → escalate to shipyard instead.
