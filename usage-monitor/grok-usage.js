const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Same endpoint the Grok CLI uses for /usage. Read-only: we never refresh or rewrite credentials.
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

function defaultAuthFile() {
  return path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "auth.json");
}

function pickEntry(auth) {
  if (!auth || typeof auth !== "object") return null;
  return Object.values(auth).find((entry) => entry && typeof entry.key === "string" && entry.key) || null;
}

function expired(entry, now) {
  const value = entry.expires_at;
  if (value == null) return false;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) && ms <= now;
}

async function readGrokUsage(options = {}) {
  const authFile = options.authFile || defaultAuthFile();
  const fetchImpl = options.fetch || fetch;
  const now = options.now || Date.now();
  let entry;
  try { entry = pickEntry(JSON.parse(await fs.promises.readFile(authFile, "utf8"))); }
  catch { return { state: "unavailable", windows: [], note: "Grok CLI is not signed in on this computer." }; }
  if (!entry) return { state: "unavailable", windows: [], note: "Grok CLI is not signed in on this computer." };
  if (expired(entry, now)) {
    return { state: "unavailable", windows: [], note: "Grok CLI login expired; run grok once to refresh it." };
  }
  let response;
  try {
    response = await fetchImpl(BILLING_URL, {
      headers: {
        Authorization: `Bearer ${entry.key}`,
        Accept: "application/json",
        "x-grok-client-version": process.env.GROK_CLIENT_VERSION || "1.0.77",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch { return { state: "unavailable", windows: [], note: "Grok usage service unreachable." }; }
  if (response.status === 401 || response.status === 403) {
    return { state: "unavailable", windows: [], note: "Grok CLI login rejected; run grok once to refresh it." };
  }
  if (!response.ok) return { state: "unavailable", windows: [], note: `Grok usage HTTP ${response.status}` };
  let body;
  try { body = await response.json(); }
  catch { return { state: "unavailable", windows: [], note: "Grok usage returned invalid data." }; }
  const config = body?.config || {};
  const used = Number(config.creditUsagePercent);
  if (!Number.isFinite(used)) return { state: "unavailable", windows: [], note: "Grok returned no usage percentage." };
  const period = config.currentPeriod || {};
  const label = period.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "7 days" : "Credits";
  return {
    state: "ready",
    source: "Grok CLI login",
    observedAt: new Date(now).toISOString(),
    windows: [{
      label,
      used: Math.max(0, Math.min(100, used)),
      resetsAt: period.end || config.billingPeriodEnd || null,
    }],
  };
}

module.exports = { readGrokUsage, BILLING_URL };
