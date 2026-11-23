const test = require("node:test");
const assert = require("node:assert");
const { series, tasks, attribute, averages, budget } = require("../model.js");

const R = "2026-11-25T02:00:00Z";
const h = (at, used, id = "claude", label = "Weekly · all models") => ({ at, rows: [{ id, label, used, resetsAt: R }] });

test("splits a provider delta over overlapping tasks", () => {
  const history = [h("2026-11-23T10:00:00Z", 60), h("2026-11-23T10:55:00Z", 64)];
  const ledger = [
    { at: "2026-11-23T10:00:00Z", id: "a", provider: "claude", kind: "impl-HARD", phase: "start" },
    { at: "2026-11-23T10:00:00Z", id: "b", provider: "claude", kind: "impl-HARD", phase: "start" },
    { at: "2026-11-23T10:50:00Z", id: "a", provider: "claude", kind: "impl-HARD", phase: "end" },
    { at: "2026-11-23T10:50:00Z", id: "b", provider: "claude", kind: "impl-HARD", phase: "end" },
  ];
  const costs = attribute(series(history), tasks(ledger).done);
  assert.deepStrictEqual(costs.map((c) => c.cost), [2, 2]);
  assert.strictEqual(averages(costs)["claude:impl-HARD"].avg, 2);
});

test("ignores the Fable weekly window and tasks across a reset", () => {
  const history = [
    { at: "2026-11-23T10:00:00Z", rows: [{ id: "claude", label: "Weekly · Fable", used: 1, resetsAt: R }] },
  ];
  assert.strictEqual(series(history).claude.length, 0);
});

test("budget counts tasks that fit before reset with a reserve", () => {
  const latest = { grok: { used: 86, resetsAt: "2026-11-25T15:43:00Z" } };
  const b = budget(latest, { "grok:impl-ROUTINE": { avg: 3, n: 2, max: 4 } }, Date.parse("2026-11-23T15:43:00Z"), 4);
  assert.strictEqual(b.grok.spendable, 10);
  assert.strictEqual(b.grok.fits["impl-ROUTINE"], 3);
  assert.strictEqual(b.grok.hoursLeft, 48);
});

test("polls often while a task runs and rarely when idle", () => {
  const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
  const { nextPollMs } = require("../server.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimon-"));
  assert.strictEqual(nextPollMs(dir, {}), 1800000);
  fs.writeFileSync(path.join(dir, "ledger.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: "x", provider: "grok", kind: "k", phase: "start" }) + "\n");
  assert.strictEqual(nextPollMs(dir, {}), 300000);
  fs.appendFileSync(path.join(dir, "ledger.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: "x", provider: "grok", kind: "k", phase: "end" }) + "\n");
  assert.strictEqual(nextPollMs(dir, {}), 1800000);
});
