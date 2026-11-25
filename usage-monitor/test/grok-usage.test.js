const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readGrokUsage, BILLING_URL } = require("../grok-usage.js");
const { pollOnce } = require("../server.js");

async function authFile(t, entry) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aimon-grok-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const file = path.join(dir, "auth.json");
  if (entry) await fs.writeFile(file, JSON.stringify({ "https://auth.x.ai::x": entry }));
  return { dir, file };
}

const billing = { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-25T15:43:16Z" }, creditUsagePercent: 85 } };

test("reads weekly percent and reset with the CLI key, without leaking it", async (t) => {
  const { file } = await authFile(t, { key: "secret-key", expires_at: "2099-01-01T00:00:00Z" });
  let seen;
  const result = await readGrokUsage({ authFile: file, fetch: async (url, init) => {
    seen = { url, auth: init.headers.Authorization };
    return { ok: true, status: 200, json: async () => billing };
  } });
  assert.equal(seen.url, BILLING_URL);
  assert.equal(seen.auth, "Bearer secret-key");
  assert.equal(result.state, "ready");
  assert.deepEqual(result.windows, [{ label: "7 days", used: 85, resetsAt: "2026-11-25T15:43:16Z" }]);
  assert.ok(!JSON.stringify(result).includes("secret-key"));
});

test("missing, expired or rejected login is unavailable and never calls refresh", async (t) => {
  const missing = await authFile(t, null);
  assert.equal((await readGrokUsage({ authFile: missing.file, fetch: () => assert.fail() })).state, "unavailable");
  const old = await authFile(t, { key: "k", expires_at: "2000-01-01T00:00:00Z" });
  assert.match((await readGrokUsage({ authFile: old.file, fetch: () => assert.fail() })).note, /expired/);
  const ok = await authFile(t, { key: "k" });
  const rejected = await readGrokUsage({ authFile: ok.file, fetch: async () => ({ ok: false, status: 401 }) });
  assert.equal(rejected.state, "unavailable");
});

test("background poll stores Grok and Codex in the snapshot and keeps Claude", async (t) => {
  const { dir } = await authFile(t, null);
  const snapshotFile = path.join(dir, "snap.json");
  await fs.writeFile(snapshotFile, JSON.stringify({ providers: [{ id: "claude", state: "ready", windows: [{ label: "7 days", used: 51 }] }] }));
  const snapshot = await pollOnce(dir, snapshotFile, {
    readGrok: async () => ({ state: "ready", windows: [{ label: "7 days", used: 85, resetsAt: "x" }] }),
    readCodex: async () => ({ state: "snapshot", windows: [{ label: "7 days", used: 12 }] }),
  });
  const byId = Object.fromEntries(snapshot.providers.map((p) => [p.id, p]));
  assert.equal(byId.grok.windows[0].used, 85);
  assert.equal(byId.chatgpt.windows[0].used, 12);
  assert.equal(byId.claude.windows[0].used, 51);
});

test("expired login: asks the CLI to refresh once, then reads again", async (t) => {
  const { file } = await authFile(t, { key: "old", expires_at: "2000-01-01T00:00:00Z" });
  let refreshed = 0;
  const result = await readGrokUsage({
    authFile: file,
    refresh: async () => { refreshed++; await fs.writeFile(file, JSON.stringify({ "https://auth.x.ai::x": { key: "new", expires_at: "2099-01-01T00:00:00Z" } })); },
    fetch: async (url, init) => { assert.equal(init.headers.Authorization, "Bearer new"); return { ok: true, status: 200, json: async () => billing }; },
  });
  assert.equal(refreshed, 1);
  assert.equal(result.state, "ready");
});

test("refresh that does not help leaves the reading unavailable, one attempt only", async (t) => {
  const { file } = await authFile(t, { key: "old", expires_at: "2000-01-01T00:00:00Z" });
  let refreshed = 0;
  const result = await readGrokUsage({ authFile: file, refresh: async () => { refreshed++; }, fetch: () => assert.fail() });
  assert.equal(refreshed, 1);
  assert.match(result.note, /expired/);
});
