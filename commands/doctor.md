---
description: Check that the Codex and Grok CLIs actually work for delegation, and that the read-only reviewer gates really deny writes.
allowed-tools: Bash, Read
---

# Shipyard doctor

Verify the pipeline can delegate before it tries to. Run every check, report
each result, and never fix anything — this command diagnoses.

Do the work in a throwaway directory so nothing touches the user's tree:
`d=$(mktemp -d)` in the same Bash call that uses it, and remove it after.

## Codex (Astra, Luna)

1. **On PATH** — `command -v codex`.
2. **Authenticated** — `codex login status`. Anything other than a logged-in
   line is a failure; do not attempt to log in.
3. **Flags the wrappers pass actually exist** — `codex exec --help`. Pass only
   if the output lists `--sandbox` and `--cd`. Luna runs headless via
   `-c approval_policy="never"`, not `--approve-for-me` (which conflicts with
   `--sandbox` since 0.153 and, alone, auto-approves writes outside the
   workspace). Do not pass `--full-auto`; it was removed in 0.147 and is not
   in the wrappers.
4. **Delegation round-trip in a linked worktree**, Luna's exact invocation,
   then a **host** commit — the path the wrapper uses, because
   `workspace-write` cannot write a linked worktree's git index:

   ```bash
   d=$(mktemp -d)
   repo="$d/repo"
   wt="$d/wt"
   git init "$repo"
   git -C "$repo" config user.email "shipyard-doctor@localhost"
   git -C "$repo" config user.name "shipyard-doctor"
   printf 'seed\n' > "$repo/README"
   git -C "$repo" add README
   git -C "$repo" -c commit.gpgsign=false commit -m seed
   git -C "$repo" worktree add "$wt" -b shipyard-doctor
   printf 'Create ok.txt containing OK here, then reply with just: DONE\n' > "$d/p.md"
   codex exec --model gpt-6-luna -c model_reasoning_effort="low" \
       --sandbox workspace-write -c approval_policy='"never"' \
       -c sandbox_workspace_write.network_access=true \
       --skip-git-repo-check --cd "$wt" - < "$d/p.md"
   echo "codex_exit=$?"
   cat "$wt/ok.txt" 2>&1
   git -C "$wt" add ok.txt
   git -C "$wt" -c commit.gpgsign=false commit -m 'shipyard-doctor host commit'
   echo "commit_exit=$?"
   git -C "$wt" log -1 --oneline
   git -C "$repo" worktree remove --force "$wt"
   rm -rf "$d"
   ```

   Pass only if Codex replies `DONE`, `ok.txt` contains `OK`, *and* the host
   commit succeeded. A reply without the file means the sandbox flags aren't
   working; a file without a reply means the relay is broken; a file whose
   host commit failed means the wrapper cannot land Luna's work in a linked
   worktree.
5. **Read-only profile accepted** — Astra's form, a trivial prompt returns an
   answer:

   ```bash
   d=$(mktemp -d) && printf 'Reply with just: DONE\n' > "$d/p.md" \
     && cd "$d" && codex exec --model gpt-6-astra -c model_reasoning_effort="low" \
       --sandbox read-only --skip-git-repo-check - < "$d/p.md" \
     ; echo "exit=$?"; rm -rf "$d"
   ```

## Grok (grok-implementer, grok-reviewer)

Skip this whole section and say so if `printenv SHIPYARD_NO_GROK` prints a
non-empty value — Grok is off for this project, and a missing CLI is then
expected rather than a fault.

1. **On PATH** — `command -v grok`.
2. **Authenticated, and grok-4.7 available** — `grok models`. Fail if the model
   the agents pin is absent from the list.
3. **Delegation round-trip**, the implementer's exact form:

   ```bash
   d=$(mktemp -d) && printf 'Create ok.txt containing OK here, then reply with just: DONE\n' > "$d/p.md" \
     && cd "$d" && grok --prompt-file "$d/p.md" --model grok-4.7 --effort low \
       --always-approve --no-plan --sandbox workspace --deny MCPTool \
     ; echo "exit=$?"; cat "$d/ok.txt" 2>&1; rm -rf "$d"
   ```

   Same pass condition: `DONE` returned and `ok.txt` present.
4. **Sandbox actually enforced** — after that run, the last event in
   `~/.grok/sessions/sandbox-events.jsonl` must be `ProfileApplied` with
   `"enforced": true`. A profile that failed to apply only warns, so this is the
   check that catches it:

   ```bash
   tail -1 ~/.grok/sessions/sandbox-events.jsonl
   ```

5. **The reviewer's read-only gate really denies** — the security-critical one.
   Run from the project directory, with the reviewer's exact flags, as one
   command so the temp path stays in scope:

   ```bash
   d=$(mktemp -d) && printf 'Create PROBE-DELETEME.txt containing x in the current directory. Report the exact error if it fails.\n' > "$d/p.md" \
     && grok --prompt-file "$d/p.md" --model grok-4.7 --effort low --no-plan \
       --sandbox read-only --tools read_file,list_dir,grep \
       --deny Edit --deny Write --deny Bash --deny MCPTool \
     ; echo "exit=$?"; ls PROBE-DELETEME.txt 2>&1; rm -rf "$d"
   ```

   **Pass means `ls` says the file does not exist** and grok reported a denial
   (`Operation not permitted`, or a `deny rule` message). If the file appears,
   delete it and report a failure loudly: the reviewer is not read-only, so
   stage 2 and stage 5 have no gate.

6. **MCP is denied** — if `grok mcp list` shows any enabled server, confirm the
   deny rule covers it by asking grok, with the reviewer flags above, to
   actually *call* one of its MCP tools. Expect `Denied by permission policy:
   deny rule on mcp`. Do not judge this from grok's own account of which tools
   it has: it lists `use_tool` as available even when the deny rule stops every
   call. Skip with a note if no server is configured.

## Local Bonsai (bonsai-implementer)

Skip this section and say so unless `printenv CLAUDE_LOCAL_AVAILABLE` prints a
non-empty value.

1. **On PATH** — `command -v claude-local`.
2. **Round-trip and confinement**, the implementer's exact flags:

   ```bash
   d=$(mktemp -d) && git -C "$d" init -q && r=$(cd "$d" && pwd -P) \
     && printf 'Create ok.txt containing OK in the current directory. Then create %s/../outside-%s.txt containing X. Report which succeeded.\n' "$r" "$$" > "$r/.p.md" \
     && cd "$r" && claude-local -p --output-format json \
       --permission-mode acceptEdits --disallowedTools Bash,WebFetch,WebSearch \
       --strict-mcp-config < "$r/.p.md" \
     ; echo "exit=$?"; cat "$r/ok.txt" 2>&1; ls "$r/../outside-$$.txt" 2>&1; rm -rf "$d" "$r/../outside-$$.txt"
   ```

   **Pass means `ok.txt` contains `OK` and `outside-*.txt` does not exist.** If
   the outside file appears, report a failure loudly: Bonsai is not confined to
   its worktree.

## Report

One line per check: `PASS` / `FAIL` / `SKIP` with the observed evidence, not a
restatement of the expectation. Then:

- **Both CLIs pass** — say the pipeline can run all five stages.
- **Codex fails** — stages 1, 2, 3 and 5 are blocked; the pipeline cannot run.
  Astra writes the plan, so this fails at stage 1, before anything else. Do not
  offer to substitute another model for Astra or Luna.
- **Grok fails while enabled** — stages 2, 3 and 5 are blocked. Name
  `SHIPYARD_NO_GROK=1` as the user's choice to run without Grok, and do not set
  it for them.
- **Bonsai fails while enabled** — stage 3 is blocked for `TRIVIAL` tasks.
  Name unsetting `CLAUDE_LOCAL_AVAILABLE` as the user's choice to route them to
  Luna, and do not unset it for them.
- **A gate check fails while its round-trip passes** — the worst outcome, and
  say so plainly: delegation works, so the pipeline will appear healthy while
  running an agent that is not confined the way its own definition claims.

Never install, update, log in, or change a sandbox config to make a check pass.
