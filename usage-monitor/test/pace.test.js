const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { appendHistory, computePace } = require("../server.js");

const reset = "2026-11-25T15:43:16.543+00:00";
const snap = (used) => ({ providers: [{ id: "grok", windows: [{ label: "7 days", used, resetsAt: reset }] }] });

test("history appends one line per poll and pace uses it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimon-"));
  const file = path.join(dir, "history.jsonl");
  await appendHistory(file, snap(80), new Date("2026-11-23T10:00:00Z"));
  await appendHistory(file, snap(84), new Date("2026-11-23T12:00:00Z"));
  const history = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.strictEqual(history.length, 2);
  const pace = computePace(snap(84), history, new Date("2026-11-23T12:00:00Z"));
  const w = pace.windows[0];
  assert.strictEqual(w.remaining, 16);
  assert.strictEqual(w.observedPerHour, 2);
  assert.ok(w.hoursLeft > 51 && w.hoursLeft < 52);
  assert.ok(Math.abs(w.neededPerHour - 16 / w.hoursLeft) < 0.01);
  assert.strictEqual(w.projectedAtReset, 100);
});

test("pace ignores points from an earlier reset period", () => {
  const history = [
    { at: "2026-11-23T10:00:00Z", rows: [{ id: "grok", label: "7 days", used: 90, resetsAt: "2026-11-18T00:00:00Z" }] },
    { at: "2026-11-23T11:00:00Z", rows: [{ id: "grok", label: "7 days", used: 1, resetsAt: reset }] },
  ];
  const w = computePace(snap(1), history, new Date("2026-11-23T11:30:00Z")).windows[0];
  assert.strictEqual(w.observedPerHour, null);
});

test("history keeps no notes or errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimon-"));
  const file = path.join(dir, "history.jsonl");
  await appendHistory(file, { providers: [{ id: "x", note: "secret?", error: "e", windows: [{ label: "5 hours", used: 3, resetsAt: reset }] }] });
  const line = fs.readFileSync(file, "utf8");
  assert.ok(!line.includes("secret") && !line.includes('"error"'));
});
