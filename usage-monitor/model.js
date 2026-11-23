// Simple cost model: how many % of each limit a kind of task uses, and what still fits before reset.
// Inputs: history.jsonl (usage readings) and ledger.jsonl (task start/end events). Numbers only.
const fs = require("node:fs");
const path = require("node:path");

const PROVIDERS = ["claude", "grok", "chatgpt"];

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// The weekly window of a provider is the one we budget against.
function isWeekly(label) {
  return /7 days|weekly/i.test(label || "") && !/fable/i.test(label || "");
}

// Weekly usage series per provider: [{t, used, resetsAt}] sorted by time.
function series(history) {
  const out = Object.fromEntries(PROVIDERS.map((p) => [p, []]));
  for (const entry of history) {
    const t = Date.parse(entry.at);
    for (const row of entry.rows || []) {
      if (!out[row.id] || !isWeekly(row.label) || typeof row.used !== "number") continue;
      out[row.id].push({ t, used: row.used, resetsAt: row.resetsAt });
    }
  }
  for (const p of PROVIDERS) out[p].sort((a, b) => a.t - b.t);
  return out;
}

// Usage at time t: last reading at or before t (same reset period as `ref` when given).
function usedAt(points, t) {
  let best = null;
  for (const point of points) { if (point.t <= t) best = point; else break; }
  return best;
}

// Pair start/end events into tasks: {id, provider, kind, start, end}.
function tasks(ledger) {
  const open = new Map();
  const done = [];
  for (const event of ledger) {
    const t = Date.parse(event.at);
    if (event.phase === "start") open.set(event.id, { id: event.id, provider: event.provider, kind: event.kind, start: t });
    else if (event.phase === "end" && open.has(event.id)) {
      const task = open.get(event.id);
      open.delete(event.id);
      done.push({ ...task, end: t });
    }
  }
  return { done, running: [...open.values()] };
}

// Cost per finished task: provider's weekly delta over its run, split over the
// tasks of that provider running at the same time (by overlap). Skips tasks
// that cross a reset or have no reading on both sides.
function attribute(historySeries, finished) {
  const results = [];
  for (const task of finished) {
    const points = historySeries[task.provider] || [];
    const before = usedAt(points, task.start);
    // Readings lag up to one poll: take the first reading within 15 min after the end.
    const after = points.find((point) => point.t >= task.end && point.t <= task.end + 15 * 60000) || usedAt(points, task.end);
    if (!before || !after || before.resetsAt !== after.resetsAt) continue;
    const delta = Math.max(0, after.used - before.used);
    const own = task.end - task.start;
    let weight = own;
    for (const other of finished) {
      if (other === task || other.provider !== task.provider) continue;
      const overlap = Math.min(task.end, other.end) - Math.max(task.start, other.start);
      if (overlap > 0) weight += overlap;
    }
    const share = weight > 0 ? own / weight : 1;
    results.push({ ...task, cost: Math.round(delta * share * 100) / 100 });
  }
  return results;
}

function averages(costs) {
  const groups = {};
  for (const item of costs) {
    const key = `${item.provider}:${item.kind}`;
    (groups[key] ||= []).push(item.cost);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, {
    n: list.length,
    avg: Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100,
    max: Math.max(...list),
  }]));
}

// What fits before each weekly reset, keeping `reserve` % for final reviews.
function budget(latest, avg, now = Date.now(), reserve = 4) {
  const out = {};
  for (const provider of PROVIDERS) {
    const last = latest[provider];
    if (!last) continue;
    const hoursLeft = Math.max(0, (Date.parse(last.resetsAt) - now) / 3600000);
    const spendable = Math.max(0, 100 - last.used - reserve);
    const fits = {};
    for (const [key, value] of Object.entries(avg)) {
      const [p, kind] = key.split(":");
      if (p === provider && value.avg > 0) fits[kind] = Math.floor(spendable / value.avg);
    }
    out[provider] = {
      used: last.used,
      hoursLeft: Math.round(hoursLeft * 10) / 10,
      spendable,
      perHourToUseAll: hoursLeft ? Math.round((spendable / hoursLeft) * 100) / 100 : null,
      fits,
    };
  }
  return out;
}

function buildModel(dir, now = Date.now()) {
  const history = readJsonl(path.join(dir, "history.jsonl"));
  const ledger = readJsonl(path.join(dir, "ledger.jsonl"));
  const s = series(history);
  const { done, running } = tasks(ledger);
  const costs = attribute(s, done);
  const avg = averages(costs);
  const latest = Object.fromEntries(PROVIDERS.map((p) => [p, s[p][s[p].length - 1]]).filter(([, v]) => v));
  return { at: new Date(now).toISOString(), averages: avg, budget: budget(latest, avg, now), running, recent: costs.slice(-20) };
}

module.exports = { series, tasks, attribute, averages, budget, buildModel, isWeekly };

if (require.main === module) {
  const base = process.env.LOCALAPPDATA || path.join(require("node:os").homedir(), ".local", "share");
  console.log(JSON.stringify(buildModel(path.join(base, "cp-AImonitor")), null, 2));
}
