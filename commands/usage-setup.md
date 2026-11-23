---
description: Install or update the usage monitor (Claude/Grok/Codex limits, /pace and /model on 127.0.0.1:43821) that Shipyard uses to balance work across providers before their weekly resets.
allowed-tools: Bash, PowerShell, Read
---

# Shipyard usage setup

Install the usage monitor and check it answers. Windows only (a per-user logon
task); on other systems say so and stop.

1. Run `"<plugin root>/scripts/Install-UsageMonitor.ps1"` (PowerShell). It copies
   `usage-monitor/` to `%LOCALAPPDATA%\cp-AImonitor\service`, registers the task
   "CP AI Monitor" and starts it. No admin rights. Re-run after a plugin update.
2. `curl -s http://127.0.0.1:43821/pace` — report per provider: used %, hours to
   reset, %/h needed to use the rest. Grok needs a Grok CLI login, Codex needs at
   least one local Codex run; say which one is missing.
3. Tell the user to set `SHIPYARD_USAGE_MONITOR=http://127.0.0.1:43821` in
   `~/.claude/settings.json` under `env` to turn on balancing in the pipeline
   (the skill only balances when that variable is set).

To remove: `Install-UsageMonitor.ps1 -Remove` (history stays on disk).
Never print tokens; the monitor stores only percentages and reset times.
