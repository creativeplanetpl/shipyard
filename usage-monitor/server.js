const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readLatestUsage } = require("./codex-usage.js");
const { readGrokUsage } = require("./grok-usage.js");

const SNAPSHOT_LIMIT_BYTES = 64 * 1024;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

function defaultSnapshotFile() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
  return path.join(base, "cp-AImonitor", "snapshot.json");
}

// Keep only usage numbers and labels; never tokens, cookies or page content.
function sanitizeSnapshot(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.providers)) return null;
  const text = (item, max = 200) => (typeof item === "string" ? item.slice(0, max) : null);
  const providers = value.providers.slice(0, 10).map((provider) => ({
    id: text(provider?.id, 40),
    state: text(provider?.state, 40),
    plan: text(provider?.plan, 80),
    note: text(provider?.note),
    error: text(provider?.error),
    windows: Array.isArray(provider?.windows)
      ? provider.windows.slice(0, 10).map((window) => ({
          label: text(window?.label, 60),
          used: typeof window?.used === "number" && Number.isFinite(window.used) ? window.used : null,
          resetsAt: typeof window?.resetsAt === "string" || typeof window?.resetsAt === "number" ? window.resetsAt : null,
        }))
      : [],
  }));
  return { providers, updatedAt: text(value.updatedAt, 40), receivedAt: new Date().toISOString() };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > SNAPSHOT_LIMIT_BYTES) { reject(new Error("too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function writeSnapshot(snapshotFile, snapshot) {
  await fs.promises.mkdir(path.dirname(snapshotFile), { recursive: true });
  const temp = `${snapshotFile}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(snapshot, null, 2));
  await fs.promises.rename(temp, snapshotFile);
}

async function readSnapshot(snapshotFile) {
  try { return JSON.parse(await fs.promises.readFile(snapshotFile, "utf8")); } catch { return null; }
}

// Merge one provider into the stored snapshot, keeping the others (e.g. Claude from the extension).
async function mergeProvider(snapshotFile, provider) {
  const current = (await readSnapshot(snapshotFile)) || { providers: [] };
  const providers = (current.providers || []).filter((item) => item?.id !== provider.id);
  providers.push(provider);
  const snapshot = sanitizeSnapshot({ providers, updatedAt: new Date().toISOString() });
  await writeSnapshot(snapshotFile, snapshot);
  return snapshot;
}

// Background poll without Chrome: Grok (CLI login) and Codex (local logs).
async function pollOnce(root, snapshotFile, options = {}) {
  const grok = await (options.readGrok || readGrokUsage)().catch(() => ({ state: "unavailable", windows: [] }));
  await mergeProvider(snapshotFile, { id: "grok", ...grok });
  const codex = await (options.readCodex || readLatestUsage)(root).catch(() => ({ state: "unavailable", windows: [] }));
  const snapshot = await mergeProvider(snapshotFile, { id: "chatgpt", ...codex });
  await appendHistory(historyFileFor(snapshotFile), snapshot, options.now).catch(() => {});
  return snapshot;
}

const HISTORY_MAX_LINES = 5000;

function historyFileFor(snapshotFile) {
  return path.join(path.dirname(snapshotFile), "history.jsonl");
}

// One line per poll: only numbers, labels and reset times (no notes or errors).
async function appendHistory(historyFile, snapshot, now = new Date()) {
  const rows = [];
  for (const provider of snapshot?.providers || []) {
    for (const window of provider.windows || []) {
      if (typeof window.used !== "number") continue;
      rows.push({ id: provider.id, label: window.label, used: window.used, resetsAt: window.resetsAt });
    }
  }
  if (!rows.length) return;
  await fs.promises.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.promises.appendFile(historyFile, JSON.stringify({ at: now.toISOString(), rows }) + "\n");
  const text = await fs.promises.readFile(historyFile, "utf8");
  const lines = text.split("\n").filter(Boolean);
  if (lines.length > HISTORY_MAX_LINES) {
    await fs.promises.writeFile(historyFile, lines.slice(-HISTORY_MAX_LINES).join("\n") + "\n");
  }
}

async function readHistory(historyFile) {
  try {
    return (await fs.promises.readFile(historyFile, "utf8")).split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Pace per window: what is left, hours to reset, the %/h needed to use it all,
// and the observed %/h over the last `windowHours` (same reset period only).
function computePace(snapshot, history, now = new Date(), windowHours = 6) {
  const out = [];
  for (const provider of snapshot?.providers || []) {
    for (const window of provider.windows || []) {
      if (typeof window.used !== "number") continue;
      const resetMs = Date.parse(window.resetsAt);
      const hoursLeft = Number.isFinite(resetMs) ? Math.max(0, (resetMs - now.getTime()) / 3600000) : null;
      const remaining = Math.max(0, 100 - window.used);
      const neededPerHour = hoursLeft ? remaining / hoursLeft : null;
      const since = now.getTime() - windowHours * 3600000;
      const points = history
        .filter((entry) => Date.parse(entry.at) >= since)
        .map((entry) => ({ at: Date.parse(entry.at), row: (entry.rows || []).find((r) => r.id === provider.id && r.label === window.label) }))
        .filter((point) => point.row && point.row.resetsAt === window.resetsAt);
      let observedPerHour = null;
      if (points.length >= 2) {
        const first = points[0];
        const last = points[points.length - 1];
        const hours = (last.at - first.at) / 3600000;
        if (hours >= 0.25) observedPerHour = (last.row.used - first.row.used) / hours;
      }
      const round = (value) => (value === null ? null : Math.round(value * 100) / 100);
      out.push({
        id: provider.id,
        label: window.label,
        used: window.used,
        remaining,
        resetsAt: window.resetsAt,
        hoursLeft: round(hoursLeft),
        neededPerHour: round(neededPerHour),
        observedPerHour: round(observedPerHour),
        projectedAtReset: observedPerHour === null || hoursLeft === null ? null : round(Math.min(100, window.used + observedPerHour * hoursLeft)),
      });
    }
  }
  return { at: now.toISOString(), windowHours, windows: out };
}

function createServer(root, options = {}) {
  const snapshotFile = options.snapshotFile || defaultSnapshotFile();
  return http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
    // Loopback only, fixed routes, no filesystem path supplied by a client, no website CORS.
    if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host || "")) return send(403, { error: "Host not allowed" });
    const origin = request.headers.origin;
    if (origin && !EXTENSION_ORIGIN.test(origin)) return send(403, { error: "Origin not allowed" });

    if (request.url === "/snapshot" && request.method === "POST") {
      // Only the extension publishes snapshots.
      if (!origin) return send(403, { error: "Origin required" });
      let parsed;
      try { parsed = JSON.parse(await readBody(request)); }
      catch { return send(400, { error: "Invalid snapshot" }); }
      const snapshot = sanitizeSnapshot(parsed);
      if (!snapshot) return send(400, { error: "Invalid snapshot" });
      // The extension is authoritative only for providers it actually read (Claude);
      // Grok and Codex come from the background poll.
      try {
        for (const provider of snapshot.providers) {
          if (provider.id === "claude" && provider.state === "ready") await mergeProvider(snapshotFile, provider);
        }
      } catch { return send(500, { error: "Unable to store snapshot" }); }
      return send(200, { ok: true });
    }

    if (request.url === "/record" && request.method === "POST") {
      // Local tools only (curl): browsers always send Origin, so any Origin is refused here.
      if (origin) return send(403, { error: "Origin not allowed" });
      let body;
      try { body = JSON.parse(await readBody(request)); } catch { return send(400, { error: "Invalid JSON" }); }
      const dir = path.dirname(snapshotFile);
      const word = (value, max = 80) => (typeof value === "string" && /^[\w.:\- ]{1,80}$/.test(value) ? value.slice(0, max) : null);
      try {
        if (body?.type === "usage" && word(body.provider)) {
          const windows = (Array.isArray(body.windows) ? body.windows : []).slice(0, 10)
            .filter((w) => typeof w?.used === "number" && word(w.label))
            .map((w) => ({ label: word(w.label), used: w.used, resetsAt: typeof w.resetsAt === "string" ? w.resetsAt.slice(0, 40) : null }));
          if (!windows.length) return send(400, { error: "No windows" });
          await appendHistory(historyFileFor(snapshotFile), { providers: [{ id: word(body.provider), windows }] });
          return send(200, { ok: true });
        }
        if (body?.type === "task" && word(body.id) && word(body.provider) && word(body.kind) && (body.phase === "start" || body.phase === "end")) {
          // Exact readings around a task: poll before a start and after an end.
          if (body.phase === "start" && options.pollNow) await options.pollNow();
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.appendFile(path.join(dir, "ledger.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: word(body.id), provider: word(body.provider), kind: word(body.kind), phase: body.phase }) + "\n");
          if (body.phase === "end" && options.pollNow) await options.pollNow();
          if (options.reschedule) options.reschedule();
          return send(200, { ok: true });
        }
      } catch { return send(500, { error: "Unable to record" }); }
      return send(400, { error: "Unknown record" });
    }

    if (request.method !== "GET") return send(405, { error: "GET only" });
    if (request.url === "/model") return send(200, require("./model.js").buildModel(path.dirname(snapshotFile)));
    if (request.url === "/snapshot") {
      try { return send(200, JSON.parse(await fs.promises.readFile(snapshotFile, "utf8"))); }
      catch { return send(404, { error: "No snapshot yet; open the AI Monitor widget and Refresh." }); }
    }
    if (request.url === "/pace") {
      const snapshot = await readSnapshot(snapshotFile);
      if (!snapshot) return send(404, { error: "No snapshot yet" });
      return send(200, computePace(snapshot, await readHistory(historyFileFor(snapshotFile))));
    }
    if (request.url === "/grok/usage") {
      const snapshot = await readSnapshot(snapshotFile);
      const grok = snapshot?.providers?.find((item) => item?.id === "grok");
      return grok ? send(200, grok) : send(404, { error: "No Grok reading yet" });
    }
    if (request.url !== "/codex/usage") return send(404, { error: "Not found" });
    try { send(200, await readLatestUsage(root)); }
    catch { send(500, { error: "Unable to read local Codex usage logs" }); }
  });
}

// Adaptive polling: often while a task is running (ledger has an unfinished start), rarely when idle.
function nextPollMs(dir, env = process.env) {
  const busy = Math.max(60, Number(env.AIMON_POLL_SECONDS) || 300) * 1000;
  const idle = Math.max(300, Number(env.AIMON_IDLE_POLL_SECONDS) || 1800) * 1000;
  const { running } = require("./model.js").tasks(readJsonlSync(path.join(dir, "ledger.jsonl")));
  // A start older than 12 h without an end is treated as abandoned.
  const live = running.filter((task) => Date.now() - task.start < 12 * 3600000);
  return live.length ? busy : idle;
}

function readJsonlSync(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

if (require.main === module) {
  const snapshotFile = defaultSnapshotFile();
  const dir = path.dirname(snapshotFile);
  let timer = null;
  let polling = Promise.resolve();
  const pollNow = () => (polling = polling.then(() => pollOnce(undefined, snapshotFile)).catch(() => {}));
  const reschedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { pollNow().then(reschedule); }, nextPollMs(dir));
  };
  const server = createServer(undefined, { pollNow, reschedule });
  pollNow().then(reschedule);
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? "Port 43821 is already in use; the reader may already be running." : "Cannot start the local usage reader.");
    process.exitCode = 1;
  });
  server.listen(43821, "127.0.0.1", () => console.log("AI Monitor local reader: http://127.0.0.1:43821/snapshot, /grok/usage, /codex/usage"));
}

module.exports = { createServer, sanitizeSnapshot, pollOnce, appendHistory, computePace, nextPollMs };
