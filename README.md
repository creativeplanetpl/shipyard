# Shipyard

A five-stage shipping pipeline for Claude Code. Astra writes the plan, three
adversarial reviewers across three labs try to kill it, Codex, Grok and Sonnet
agents implement every independent task in parallel git worktrees, and nothing merges
until Fable, Astra and Grok have all attacked the integrated diff.

Not every change needs all of that. Before planning, the session triages the
spec: large or hard work gets the full shipyard, everything else goes to
[boatyard](#boatyard), the same five stages and gates with a smaller, cheaper
crew (Opus plans, Sonnet reviews each task).

Reviews hunt for reasons to reject; the gate is
blockers, not an empty findings list. Astra reviews the plan it wrote and the
branch built from it — as fresh dispatches that carry none of the planning
context, and are told to distrust both.

## Install

```
/plugin marketplace add esse/shipyard
/plugin install shipyard@shipyard
```

## Requires

- The [Codex CLI](https://github.com/openai/codex) on `PATH` and authenticated
  (`codex login`), 0.147 or newer. Two agents shell out to `codex exec`, and
  one of them writes the plan, so Codex is required from stage 1 onwards.
  `--full-auto` is gone; Luna uses `--sandbox workspace-write -c approval_policy="never"`
  (`--approve-for-me` conflicts with `--sandbox` since 0.153).
- The Grok CLI (`grok`) on `PATH` and authenticated (`grok login`). Two roles
  shell out to `grok --prompt-file`. Required unless you switch Grok off — see
  [Turning Grok off](#turning-grok-off).
- Git, for the worktree isolation used during implementation.
- Optional: a `claude-local` launcher on `PATH`, a Claude Code wrapper pointed
  at a self-hosted Bonsai model. Only needed if you turn on the
  [local Bonsai tier](#local-bonsai-tier).

Run `/shipyard:doctor` to check both CLIs (and `claude-local`, when the Bonsai
tier is on) before you rely on them. It exercises
the exact delegation form the wrappers use, and asserts that the read-only
reviewer gates actually refuse a write — a green round-trip with a broken gate
is the one failure that would otherwise look healthy.

If you already keep any of `astra.md`, `fable.md`, `opus.md`, `codex.md`,
`opus-reviewer.md`, `sonnet-reviewer.md`, `sonnet-implementer.md`,
`grok-implementer.md`, `bonsai-implementer.md`, `grok-reviewer.md` or
`mythos.md` in
`~/.claude/agents/`, delete them after installing — the plugin ships the same
names and duplicates are confusing. Shipyard 0.4 and earlier shipped a
`sol-reviewer` agent; `astra` replaces it, so delete any stale copy of that
one too.

## The cast

| Name | Agent | Model | Access | Used in |
| --- | --- | --- | --- | --- |
| Astra | `astra` | gpt-6-astra, medium reasoning | read-only | shipyard: plan, plan + branch review |
| Fable | `fable` | Claude Fable | read-only | both: plan + branch review |
| Opus | `opus` | Claude Opus | read-only | boatyard: plan, plan + branch review |
| Opus | `opus-reviewer` | Claude Opus | read-only | shipyard: task review |
| Sonnet | `sonnet-reviewer` | Claude Sonnet | read-only | boatyard: task review |
| Grok | `grok-reviewer` | grok-4.7, xhigh reasoning | read-only | shipyard: plan + branch review |
| Bonsai | `bonsai-implementer` | Ternary-Bonsai-2-27B via `claude-local` (opt-in) | write, edits only | both: `TRIVIAL` tasks |
| Luna | `codex` | gpt-6-luna, max reasoning | write | both: `EASY` tasks, plus fallbacks |
| Grok | `grok-implementer` | grok-4.7, xhigh reasoning | write | both: `ROUTINE` tasks |
| Sonnet | `sonnet-implementer` | Claude Sonnet 5.5 | write | shipyard: `HARD` tasks |
| Mythos | `mythos` | Claude Mythos 5.1 (opt-in security scan) | read-only | both: branch review |

Every name is a model, pinned in the agent definition — frontmatter for the
Claude agents, a CLI argument for the wrappers. **Your session model
doesn't matter** — start on Opus, Sonnet or Haiku and the plan is still written
by Astra and the branch still reviewed by Fable, Astra and Grok, because every
stage is a dispatch to a pinned agent (Opus and Fable in boatyard). Your session orchestrates: it dispatches, merges,
resolves conflicts, and talks to you.

Swap the model IDs in `agents/*.md` for whatever your accounts have. If your
build doesn't recognise the `fable` or `sonnet` alias, use the full ID
`claude-fable-5` or `claude-sonnet-5-5`;
`agents/astra.md` pins `gpt-6-astra` on the Codex side.

## Triage: shipyard or boatyard

Before stage 1, the session decides which pipeline the spec gets:

- **Shipyard** if the work is **large or hard**: more than five tasks expected,
  more than one module or service touched, or an open decision about API
  shape, data format, security, compatibility, concurrency or migration. Also
  when you ask for the strongest models.
- **Boatyard** otherwise.

When unsure, it picks shipyard. It tells you the call and the reason in one
line and carries on; say "use shipyard" or "use boatyard" to override.

## Task tiers

The planner tags every task, and the tag picks the implementer:

| Tag | Means | Implementer |
| --- | --- | --- |
| `TRIVIAL` | The task states the exact edit (a constant, a string, a version bump, one more list entry) and nothing needs running to finish it | Bonsai, or Luna if the [local tier](#local-bonsai-tier) is off |
| `EASY` | Fully prescribed, and follows a pattern already in the codebase | Luna |
| `ROUTINE` | No open design decision, but the implementer works out the how | Grok, or Luna if [Grok is off](#turning-grok-off) |
| `HARD` | Leaves open an API, data format, security, compatibility, concurrency or migration decision | Sonnet (shipyard only) |

## The pipeline

The full shipyard:

1. **Plan** — Astra turns the spec into a plan, split into small tasks,
   marking which are independent and tagging each `TRIVIAL`, `EASY`, `ROUTINE` or `HARD`.
2. **Plan review** — Fable, Grok and a *fresh* Astra attack the plan on paper,
   in parallel. The second Astra is a new dispatch and a new `codex exec`: it
   gets the spec and the plan text, never the planning run's context.
   Blockers get fixed before a line of code is written. Verdicts key off
   blockers: `EXECUTE AS-IS` means none, not "no nits". At most two rounds
   (full, then a delta if blockers were folded); residual nits travel with
   the tasks rather than looping.
3. **Implement** — one agent per task, all dispatched at once, each in its own
   git worktree so parallel file edits can't collide. `TRIVIAL` tasks go to
   Bonsai (or Luna, see [Local Bonsai tier](#local-bonsai-tier)), `EASY` ones to
   Luna, `ROUTINE` ones to Grok, `HARD` ones to Sonnet. Luna and Grok are
   sandboxed to their worktree, Sonnet only by its instructions (see [How the
   roles are confined](#how-the-roles-are-confined)). Each agent commits in
   its worktree; the Codex and Grok CLIs inside the wrappers do not.
4. **Task review** — Opus reviews each finished task against the plan step that
   spawned it. `FIX` (blockers) goes back to the same implementer in the same
   worktree; `APPROVE` (nits allowed) lets the branch merge. A task is done
   only when approved *and* merged.
5. **Branch review** — Fable, Astra and Grok (plus Mythos, if enabled) attack the integrated diff,
   in parallel. Verdict: `MERGE AS-IS` / `MERGE WITH FIXES` / `DO NOT MERGE`,
   derived from blockers. Fixes send the branch back through this stage; the
   PR opens only once every enabled reviewer has an empty blocker list on the
   diff as it then stands.

The full stage-by-stage instructions live in
`skills/shipping-plans-with-agents/SKILL.md`, which your session loads on its
own when a plan is ready to build. You can also just say "ship this with
shipyard".

## Boatyard

The same five stages and the same gates as shipyard, with a smaller crew. Every
shipyard rule still applies: worktrees per task, blockers gate and verdict words
don't, at most two plan-review rounds, delta re-reviews after every fix.

| Stage | Shipyard | Boatyard |
| --- | --- | --- |
| 1. Plan | Astra | Opus |
| 2. Plan review | Fable, fresh Astra, Grok | Fable, fresh Opus |
| 3. Implement | Bonsai / Luna / Grok / Sonnet by tag | Bonsai / Luna / Grok by tag |
| 4. Task review | Opus | Sonnet |
| 5. Branch review | Fable, Astra, Grok (+ Mythos) | fresh Opus, Fable (+ Mythos) |

- **The Opus reviews are fresh dispatches.** They get the spec and the plan or
  diff, never the planning run's context, so the reviewer doesn't share the
  author's blind spots.
- **A `HARD` task means the triage was wrong.** If the plan, a plan reviewer or
  a branch fix calls a task `HARD`, boatyard stops, says which task and why, and
  restarts in shipyard from stage 1. Work already merged stays on the branch.
- **The switches behave the same.** `CLAUDE_LOCAL_AVAILABLE` and
  `SHIPYARD_NO_GROK` change implementer routing exactly as in shipyard, and
  `SHIPYARD_SECURITY_SCAN` adds Mythos to the branch review.
- **The trade-off:** planning and every review stay with Anthropic models, so
  boatyard gives up shipyard's cross-lab independence in exchange for speed and
  cost. That's why anything large or hard goes to shipyard.

The boatyard rules live in `skills/shipping-plans-with-agents/boatyard.md`.

## Turning Grok off

Set `SHIPYARD_NO_GROK=1` and the two Grok roles drop out: the plan gets reviewed
by Fable and the fresh Astra, `ROUTINE` tasks go to Luna with the easy ones, and
the branch review runs Fable + Astra. Boatyard has no Grok reviewer, so there
the switch only moves `ROUTINE` tasks to Luna. The stage gates are unchanged. In
`.claude/settings.json`:

```json
{ "env": { "SHIPYARD_NO_GROK": "1" } }
```

Any non-empty value counts, `0` and `false` included — it's a switch, not a
boolean. This env var is the *only* way to run without Grok: with it unset, a
missing or unauthenticated `grok` stops the pipeline exactly like a missing
`codex` would, rather than quietly shipping with one less reviewer.

## Local Bonsai tier

Set `CLAUDE_LOCAL_AVAILABLE=1` and `TRIVIAL` tasks (the exact edit is stated in
the task, no command needed to finish it) go to `bonsai-implementer`, which runs
a self-hosted Ternary-Bonsai-2-27B through the `claude-local` wrapper. Unset,
they go to Luna with the `EASY` ones. Works the same in shipyard and boatyard,
and every Bonsai commit is still reviewed (by Opus in shipyard, Sonnet in
boatyard).

```json
{ "env": { "CLAUDE_LOCAL_AVAILABLE": "1" } }
```

Bonsai runs headless with `--permission-mode acceptEdits` and no `Bash`, so it
can edit its worktree and nothing else; the wrapper commits. Once on, an
unreachable `claude-local` stops the pipeline instead of falling back to Luna.
`/shipyard:doctor` checks both: a round-trip, and that a write outside the
worktree is refused.

## Security scan

Set `SHIPYARD_SECURITY_SCAN=1` and stage 5 gains one more reviewer: Mythos,
pinned to `claude-mythos-5-1`, scans the integrated diff for security issues
only — injection, auth gaps, leaked secrets, unsafe data handling, supply
chain. Its blockers gate the PR like any other stage-5 reviewer's, and every
repair gets a delta re-scan. Off by default.

```json
{ "env": { "SHIPYARD_SECURITY_SCAN": "1" } }
```

Same switch semantics as `SHIPYARD_NO_GROK`: any non-empty value turns it on.
Once on, an unavailable Mythos model stops the pipeline instead of skipping
the scan. The agent pins the full ID because the bare `mythos` alias doesn't
resolve.

## How the roles are confined

Every flag in the two grok commands is load-bearing, so don't trim them:

- **`grok-reviewer` gets two gates.** `--sandbox read-only` is kernel-enforced
  and refuses writes to the project; the `--deny Edit/Write/Bash/MCPTool` rules
  cover what a sandbox can't, since `--deny MCPTool` is the only thing that
  closes MCP tools — the `--tools` allowlist leaves them reachable.
  `--permission-mode plan`, by contrast, does not block writes headlessly.
- **`grok-implementer` is confined by `--sandbox workspace`**: writes are
  limited to its worktree plus `~/.grok` and the temp dirs, so the rest of the
  repo, sibling worktrees and the main `.git` are all off limits. That last one
  is also why it can't commit its own work — committing from a linked worktree
  writes the main checkout's `.git` — so the wrapper agent runs the commit.
  Both grok roles also pass `--deny MCPTool`, because MCP servers run as
  separate processes that no sandbox profile covers.
- **Luna has the same commit split.** `--sandbox workspace-write` does not
  include a linked worktree's git index, so the `codex` wrapper commits.
  Do not add the git common dir as a writable root to paper over this.
- **`bonsai-implementer` is confined by Claude Code permissions.** It runs
  `claude-local -p --permission-mode acceptEdits --disallowedTools
  Bash,WebFetch,WebSearch --strict-mcp-config` from inside its worktree. Edits
  there are approved; anything outside needs an approval nobody can give
  headlessly, so it is refused. No Bash means no shell to escape through, and
  `--strict-mcp-config` drops MCP servers. `acceptEdits` matters: it overrides
  any looser `defaultMode` in the `claude-local` config. The wrapper commits.
- **`sonnet-implementer` has no sandbox.** It is a native Claude subagent,
  held to its worktree by its instructions alone, so the orchestrator checks
  the main checkout after every Sonnet task and won't merge one that wrote
  outside its tree. That is detection, not prevention.
- **A built-in profile that can't be applied only warns, then runs
  unconfined.** The wrappers are told to detect that — on stderr and via the
  `ProfileApplied` event in `~/.grok/sessions/sandbox-events.jsonl` — and refuse to
  commit, but detection happens after the run. For prevention instead, define a
  custom profile with a non-empty `deny` list in `.grok/sandbox.toml` and name
  it in the command: grok refuses to start rather than expose denied paths when
  a custom profile is unknown, its `sandbox.toml` is malformed, or (on Linux)
  `bubblewrap` is missing. That does not extend to the kernel and entitlement
  failures that make a built-in profile fail open.

## Why cross-model

The plan author and the plan reviewers share no weights, no context, and no
sunk cost. Every role receives a self-contained prompt rather than the
conversation, so none of them can inherit the assumption that produced the bug.
Astra is the one role that reads its own work again, in stages 2 and 5, and
both are fresh dispatches told to attack rather than defend — no session resume,
no planning context, nothing to be loyal to.

Because the roles are pinned models rather than "whatever is running", that
independence doesn't quietly disappear when you switch your session model.

Boatyard deliberately trades some of this away: its planner and reviewers are
all Anthropic models. Fresh dispatches still keep the reviewers away from the
planner's context, but they share a lab. Triage keeps that to work small and
simple enough for the trade to be worth it.

## Adapting it

Everything is markdown. Common edits:

- **No Codex account?** Point `agents/codex.md` and `agents/astra.md` at a
  different CLI, or replace them with plain Claude subagents — the pipeline
  shape survives, though planning and two of the review seats then come from
  the same lab.
- **Solo tasks.** Stage 3 with one task is just "implement in a worktree". The
  review gates still apply.
- **Different verdict vocabulary.** The skill's red-flags list keys off the
  gates, not the exact words; rename them in the agent files if you prefer.

## License

MIT
