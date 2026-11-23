const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");

const defaultRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");

async function latestRollout(root) {
  let latest = null;
  async function walk(directory) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      // Do not follow links outside the sessions directory.
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const stat = await fs.promises.stat(file);
        if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { file, mtimeMs: stat.mtimeMs };
      }
    }
  }
  await walk(root);
  return latest;
}

function timestamp(value, epoch = false) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  if (epoch) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    value = number < 1e12 ? number * 1000 : number;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function unavailable(note) {
  return { state: "unavailable", source: "Codex local session log", windows: [], note };
}

function normalize(limits, observedAt) {
  const windows = [limits.primary, limits.secondary].flatMap((block) => {
    if (!block || typeof block.used_percent !== "number" || !Number.isFinite(block.used_percent)) return [];
    const minutes = block.window_minutes;
    const label = minutes === 300 ? "5 hours" : minutes === 10080 ? "7 days"
      : typeof minutes === "number" && minutes > 0 ? `${minutes} minutes` : "Usage window";
    return [{ label, used: Math.max(0, Math.min(100, block.used_percent)), resetsAt: timestamp(block.resets_at, true) }];
  });
  const reason = typeof limits.rate_limit_reached_type === "string" ? limits.rate_limit_reached_type.slice(0, 120) : "";
  if (!windows.length && !reason) return unavailable("The latest Codex rate-limit event contains no usable windows.");
  const blocked = Boolean(reason) || windows.some((window) => window.used >= 100);
  const note = [
    "Last Codex run; not a live check. Codex limits are separate from ChatGPT chat limits.",
    reason === "workspace_owner_credits_depleted"
      ? "Workspace owner credits depleted; a time reset may not restore access."
      : reason ? `Reported block: ${reason}.` : blocked ? "A usage window was exhausted in this snapshot." : "",
    limits.credits?.has_credits === false && !limits.credits?.unlimited
      ? "No extra credits reported (this alone does not mean the included quota is blocked)." : "",
  ].filter(Boolean).join(" ");
  return { state: blocked ? "blocked" : "snapshot", source: "Codex local session log",
    observedAt: timestamp(observedAt), windows, note };
}

async function readLatestUsage(root = defaultRoot) {
  let latest;
  try { latest = await latestRollout(root); }
  catch (error) {
    if (error.code === "ENOENT") return unavailable("No Codex sessions found. Run Codex locally to create a usage log.");
    throw error;
  }
  if (!latest) return unavailable("No Codex rollout logs found. Run Codex locally first.");
  let record = null;
  const stream = fs.createReadStream(latest.file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      // Parse JSON, not regex brace fragments; never return conversation content.
      if (!line.includes('"rate_limits"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // A writer may have an incomplete final line.
      const limits = entry.payload?.rate_limits;
      if (entry.type !== "event_msg" || entry.payload?.type !== "token_count" || !limits || typeof limits !== "object") continue;
      if (limits.limit_id && limits.limit_id !== "codex") continue;
      record = normalize(limits, entry.timestamp);
    }
  } finally { lines.close(); stream.destroy(); }
  return record ?? unavailable("The newest Codex session has no rate-limit data yet. Older sessions are not used because they may belong to another account.");
}

module.exports = { readLatestUsage };