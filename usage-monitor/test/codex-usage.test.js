const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readLatestUsage } = require("../codex-usage.js");
const { createServer } = require("../server.js");

function event(limits, timestamp = "2026-10-28T10:00:00Z") {
  return JSON.stringify({ timestamp, type: "event_msg", payload: {
    type: "token_count", rate_limits: limits,
  } });
}

async function fixture(t, text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-monitor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "2026", "10"), { recursive: true });
  const file = path.join(root, "2026", "10", "rollout-test.jsonl");
  await fs.writeFile(file, text);
  return { root, file };
}

test("reads last Codex event, converts epochs and excludes private log data", async (t) => {
  const { root } = await fixture(t, [
    event({ primary: { used_percent: 1, window_minutes: 300 } }),
    JSON.stringify({ type: "response_item", payload: { content: "PRIVATE CONVERSATION" } }),
    event({ limit_id: "codex", primary: { used_percent: 92, window_minutes: 300, resets_at: 1793048153 },
      secondary: { used_percent: 24, window_minutes: 10080, resets_at: 1793611413 },
      credits: { has_credits: false, unlimited: false, balance: null } }),
    event(null), '{"incomplete":',
  ].join("\n"));
  const result = await readLatestUsage(root);
  assert.equal(result.state, "snapshot");
  assert.equal(result.observedAt, "2026-10-28T10:00:00.000Z");
  assert.deepEqual(result.windows, [
    { label: "5 hours", used: 92, resetsAt: new Date(1793048153 * 1000).toISOString() },
    { label: "7 days", used: 24, resetsAt: new Date(1793611413 * 1000).toISOString() },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|rollout|has_credits/);
  assert.match(result.note, /not a live check/i);
});

test("workspace depletion is blocked even without percentage windows", async (t) => {
  const { root } = await fixture(t, event({ limit_id: "codex",
    rate_limit_reached_type: "workspace_owner_credits_depleted" }));
  const result = await readLatestUsage(root);
  assert.equal(result.state, "blocked");
  assert.deepEqual(result.windows, []);
  assert.match(result.note, /reset may not restore/i);
});

test("no invented quota or reset for missing or invalid fields", async (t) => {
  const { root } = await fixture(t, event({ limit_id: "codex",
    primary: { used_percent: 30, window_minutes: 120, resets_at: "bad" },
    secondary: { resets_at: 1793611413 } }));
  const result = await readLatestUsage(root);
  assert.deepEqual(result.windows, [{ label: "120 minutes", used: 30, resetsAt: null }]);
});

test("latest session with no usage is unavailable, not old usage from another account", async (t) => {
  const { root, file } = await fixture(t, event({ primary: { used_percent: 42, window_minutes: 300 } }));
  await fs.utimes(file, new Date(0), new Date(0));
  await fs.writeFile(path.join(root, "rollout-new.jsonl"), event(null));
  assert.equal((await readLatestUsage(root)).state, "unavailable");
});

test("missing sessions directory gives an actionable unavailable response", async (t) => {
  const { root } = await fixture(t, "");
  assert.equal((await readLatestUsage(path.join(root, "missing"))).state, "unavailable");
});

test("bridge exposes only usage and rejects website origins and arbitrary paths", async (t) => {
  const { root } = await fixture(t, event({ primary: { used_percent: 34, window_minutes: 300 } }));
  const server = createServer(root);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/codex/usage`, { headers: { Origin: `chrome-extension://${"a".repeat(32)}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).windows[0].used, 34);
  assert.equal((await fetch(`${url}/codex/usage`, { headers: { Origin: "https://example.com" } })).status, 403);
  assert.equal((await fetch(`${url}/other`)).status, 404);
});