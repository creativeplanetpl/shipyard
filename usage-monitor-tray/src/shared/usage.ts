// Pure usage logic shared by the main process, the panel and the tests.
// Everything here carries percentages, reset times and labels only.

export type ProviderId = "claude" | "chatgpt" | "grok";

export type ProviderState =
  | "ready"
  | "connected"
  | "snapshot"
  | "blocked"
  | "unavailable"
  | "signed-out"
  | "error";

export interface UsageWindow {
  label: string;
  used: number;
  resetsAt: string | null;
}

export interface Provider {
  id: ProviderId;
  state: ProviderState;
  plan: string | null;
  note: string | null;
  error: string | null;
  windows: UsageWindow[];
}

export interface PanelSnapshot {
  providers: Provider[];
  updatedAt: string;
  serviceOnline: boolean;
}

export const PROVIDER_ORDER: ProviderId[] = ["claude", "chatgpt", "grok"];

export const PROVIDER_META: Record<ProviderId, { name: string; mark: string; color: string; url: string }> = {
  claude: { name: "Claude", mark: "CL", color: "#d97757", url: "https://claude.ai/settings/usage" },
  chatgpt: { name: "Codex", mark: "GP", color: "#19c37d", url: "https://chatgpt.com/" },
  grok: { name: "Grok", mark: "GR", color: "#9aa4b2", url: "https://grok.com/?_s=usage" },
};

const STATES: ProviderState[] = ["ready", "connected", "snapshot", "blocked", "unavailable", "signed-out", "error"];

export function normalizeState(state: unknown): ProviderState {
  return STATES.includes(state as ProviderState) ? (state as ProviderState) : "unavailable";
}

export function stateLabel(state: ProviderState): string {
  return {
    ready: "live",
    connected: "online",
    snapshot: "snapshot",
    blocked: "blocked (log)",
    unavailable: "unavailable",
    "signed-out": "sign in",
    error: "error",
  }[state];
}

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

// Accepts ISO strings and Unix seconds/milliseconds; returns ISO or null.
export function normalizeReset(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value))) return value;
  return null;
}

function toWindows(value: unknown): UsageWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: UsageWindow[] = [];
  for (const item of value.slice(0, 10)) {
    const label = text((item as { label?: unknown })?.label, 60);
    const used = (item as { used?: unknown })?.used;
    if (!label || typeof used !== "number" || !Number.isFinite(used)) continue;
    windows.push({ label, used: clampPercent(used), resetsAt: normalizeReset((item as { resetsAt?: unknown })?.resetsAt) });
  }
  return windows;
}

export function unavailable(id: ProviderId, note: string): Provider {
  return { id, state: "unavailable", plan: null, note, error: null, windows: [] };
}

// One provider out of the service's GET /snapshot answer, or null when it is not there.
export function providerFromService(serviceSnapshot: unknown, id: ProviderId): Provider | null {
  const list = (serviceSnapshot as { providers?: unknown })?.providers;
  if (!Array.isArray(list)) return null;
  const found = list.find((item) => (item as { id?: unknown })?.id === id) as Record<string, unknown> | undefined;
  if (!found) return null;
  return {
    id,
    state: normalizeState(found.state),
    plan: text(found.plan, 80),
    note: text(found.note),
    error: text(found.error),
    windows: toWindows(found.windows),
  };
}

const SERVICE_DOWN = "The AI Monitor background service is not answering on 127.0.0.1:43821 (it starts with Windows).";

// Panel data: Claude from the app's own reading when it is live, otherwise whatever the
// service last stored for Claude, shown as a snapshot. Codex and Grok always come from the service.
export function composeSnapshot(serviceSnapshot: unknown, claude: Provider, now: Date = new Date()): PanelSnapshot {
  const serviceOnline = Array.isArray((serviceSnapshot as { providers?: unknown })?.providers);
  let claudeCard = claude;
  if (claude.state !== "ready") {
    const stored = providerFromService(serviceSnapshot, "claude");
    if (stored && stored.windows.length) {
      const why = claude.state === "signed-out" ? "Not signed in to Claude in this app" : "Claude could not be read just now";
      claudeCard = {
        ...stored,
        state: claude.state === "signed-out" ? "signed-out" : "snapshot",
        plan: null,
        error: null,
        note: `${why}; showing the last reading the service has.`,
      };
    }
  }
  const fromService = (id: ProviderId) =>
    providerFromService(serviceSnapshot, id) ?? unavailable(id, serviceOnline ? "The service has no reading yet." : SERVICE_DOWN);
  return {
    providers: [claudeCard, fromService("chatgpt"), fromService("grok")],
    updatedAt: now.toISOString(),
    serviceOnline,
  };
}

export interface Highest {
  used: number;
  provider: ProviderId;
  label: string;
}

// Highest usage among windows that are still current (a passed reset time means an old reading).
export function highestUsage(snapshot: PanelSnapshot | null, now: Date = new Date()): Highest | null {
  let best: Highest | null = null;
  for (const provider of snapshot?.providers ?? []) {
    for (const window of provider.windows) {
      const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      if (Number.isFinite(reset) && reset <= now.getTime()) continue;
      if (!best || window.used > best.used) best = { used: window.used, provider: provider.id, label: window.label };
    }
  }
  return best;
}

const SHORT_NAME: Record<ProviderId, string> = { claude: "Claude", chatgpt: "Codex", grok: "Grok" };

// Tray tooltip: the highest figure first, then one line per provider. Windows limits tooltips to 127 characters.
export function tooltipText(snapshot: PanelSnapshot | null, now: Date = new Date()): string {
  const top = highestUsage(snapshot, now);
  if (!snapshot || !top) return "AI Monitor: no usage data";
  const lines = [`AI Monitor: highest ${Math.round(top.used)}% (${SHORT_NAME[top.provider]}, ${top.label})`];
  for (const provider of snapshot.providers) {
    const parts = provider.windows.map((window) => `${shortLabel(window.label)} ${Math.round(window.used)}%`);
    lines.push(`${SHORT_NAME[provider.id]}: ${parts.length ? parts.join(", ") : stateLabel(provider.state)}`);
  }
  return lines.join("\n").slice(0, 127);
}

function shortLabel(label: string): string {
  if (label === "5 hours") return "5h";
  if (label === "7 days") return "7d";
  return label;
}

export type Level = "ok" | "warn" | "high" | "none";

export function usageLevel(used: number | null | undefined): Level {
  if (typeof used !== "number") return "none";
  if (used >= 90) return "high";
  if (used >= 70) return "warn";
  return "ok";
}

export function defaultNote(provider: Provider): string {
  if (provider.state === "signed-out") return "Sign in to Claude to enable live monitoring.";
  if (provider.id === "claude" && provider.state === "ready") {
    return provider.windows.length ? "Live usage from Claude." : "No active limit windows.";
  }
  if (provider.id === "grok" && provider.state === "ready") return "Grok usage; reset shown in your local time.";
  if (provider.state === "connected") return "Signed in; usage data unavailable.";
  return "Usage data unavailable. Refresh to check again.";
}

export function formatRelative(value: string, now: Date = new Date()): string {
  const difference = new Date(value).getTime() - now.getTime();
  const absolute = Math.abs(difference);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absolute < 60_000) return formatter.format(Math.round(difference / 1000), "second");
  if (absolute < 3_600_000) return formatter.format(Math.round(difference / 60_000), "minute");
  if (absolute < 86_400_000) return formatter.format(Math.round(difference / 3_600_000), "hour");
  return formatter.format(Math.round(difference / 86_400_000), "day");
}

export function formatLocal(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

export function resetText(window: UsageWindow, now: Date = new Date()): string {
  if (!window.resetsAt) return "Reset time unavailable from this source";
  const passed = Date.parse(window.resetsAt) <= now.getTime();
  return `${passed ? "Reset time passed" : "Resets"}: ${formatLocal(window.resetsAt)} (${formatRelative(window.resetsAt, now)})`;
}

// Compact reset wording for one line next to the window label.
export function resetShort(window: UsageWindow, now: Date = new Date()): string {
  if (!window.resetsAt) return "no reset time";
  if (Date.parse(window.resetsAt) <= now.getTime()) return "reset time passed";
  return `resets ${formatRelative(window.resetsAt, now)}`;
}

// The panel stays quiet while a card has numbers and is live or a snapshot; it explains only problems.
export function problemNote(provider: Provider): string | null {
  if (provider.error) return provider.error;
  if (provider.state === "signed-out") return provider.windows.length ? "Not signed in: showing the last stored reading." : "Sign in to Claude for live usage.";
  if (provider.id === "claude" && provider.state === "snapshot") return "Claude unreachable: showing the last stored reading.";
  if (provider.state === "ready" || provider.state === "snapshot") return provider.windows.length ? null : "No active limit windows.";
  return provider.note ?? defaultNote(provider);
}

// 32x32 BGRA tray icon: a dark tile with a gauge that fills from the bottom and changes colour with the level.
export function trayIconBitmap(used: number | null, size = 32): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const colors: Record<Level, [number, number, number]> = {
    ok: [0x3f, 0xb9, 0x50],
    warn: [0xe3, 0xa0, 0x08],
    high: [0xf0, 0x4a, 0x4a],
    none: [0x8b, 0x94, 0xa3],
  };
  const [r, g, b] = colors[usageLevel(used)];
  const inner = size - 8;
  const filled = used === null ? 0 : Math.max(2, Math.round((clampPercent(used) / 100) * inner));
  const radius = 6;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      if (dx * dx + dy * dy > radius * radius) continue;
      const offset = (y * size + x) * 4;
      const border = x < 2 || y < 2 || x >= size - 2 || y >= size - 2 || dx + dy > radius - 2;
      const inGauge = x >= 4 && x < size - 4 && y >= 4 && y < size - 4;
      let color: [number, number, number] = [0x1b, 0x1f, 0x2a];
      if (border) color = [r, g, b];
      else if (inGauge && y >= size - 4 - filled) color = [r, g, b];
      pixels[offset] = color[2];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[0];
      pixels[offset + 3] = 0xff;
    }
  }
  return pixels;
}
