const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer } = require("../server.js");

const EXTENSION = `chrome-extension://${"a".repeat(32)}`;

async function start(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aimon-snap-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const snapshotFile = path.join(dir, "nested", "snapshot.json");
  const server = createServer(dir, { snapshotFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, snapshotFile };
}

test("extension publishes a snapshot that local tools can read back, sanitized", async (t) => {
  const { url, snapshotFile } = await start(t);
  assert.equal((await fetch(`${url}/snapshot`)).status, 404);
  const body = {
    updatedAt: "2026-11-23T07:00:00Z",
    providers: [{ id: "claude", state: "ready", cookie: "secret", windows: [{ label: "Weekly", used: 85, resetsAt: "2026-11-27T00:00:00Z", extra: "x" }] }],
  };
  const post = await fetch(`${url}/snapshot`, { method: "POST", headers: { Origin: EXTENSION, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(post.status, 200);
  const read = await (await fetch(`${url}/snapshot`)).json();
  assert.equal(read.providers[0].id, "claude");
  assert.equal(read.providers[0].windows[0].used, 85);
  assert.equal(read.providers[0].cookie, undefined);
  assert.equal(read.providers[0].windows[0].extra, undefined);
  assert.ok(JSON.parse(await fs.readFile(snapshotFile, "utf8")).receivedAt);
});

test("snapshot POST requires the extension origin and valid JSON", async (t) => {
  const { url } = await start(t);
  const json = { "Content-Type": "application/json" };
  const valid = JSON.stringify({ providers: [] });
  assert.equal((await fetch(`${url}/snapshot`, { method: "POST", headers: json, body: valid })).status, 403);
  assert.equal((await fetch(`${url}/snapshot`, { method: "POST", headers: { ...json, Origin: "https://example.com" }, body: valid })).status, 403);
  assert.equal((await fetch(`${url}/snapshot`, { method: "POST", headers: { ...json, Origin: EXTENSION }, body: "{" })).status, 400);
  assert.equal((await fetch(`${url}/snapshot`, { method: "POST", headers: { ...json, Origin: EXTENSION }, body: JSON.stringify({ x: 1 }) })).status, 400);
  assert.equal((await fetch(`${url}/snapshot`, { method: "POST", headers: { ...json, Origin: EXTENSION }, body: "x".repeat(70 * 1024) }).catch(() => ({ status: 400 }))).status >= 400, true);
});
