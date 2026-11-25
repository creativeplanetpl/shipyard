// Reads Claude usage with the same two calls the Chrome extension makes (background.js, probeClaude).
// Only percent used, reset times and the rate-limit tier label leave this module; the organization id
// is used for the second request and then dropped, and the organization name is never read
// (it can contain an e-mail address).
import { normalizeReset, type Provider, type UsageWindow } from "./usage";

export interface JsonResponse {
  status: number;
  body: unknown;
}

export type FetchJson = (path: string) => Promise<JsonResponse>;

const WINDOWS: Array<[key: string, label: string]> = [
  ["five_hour", "5 hours"],
  ["seven_day", "7 days"],
  ["seven_day_sonnet", "Sonnet"],
  ["seven_day_opus", "Opus"],
];

export function mapClaudeUsage(usage: unknown): UsageWindow[] {
  if (!usage || typeof usage !== "object") return [];
  const windows: UsageWindow[] = [];
  for (const [key, label] of WINDOWS) {
    const value = (usage as Record<string, unknown>)[key] as Record<string, unknown> | null | undefined;
    if (!value || typeof value !== "object") continue;
    const used = value.utilization ?? value.used_percent ?? value.percent_used;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    windows.push({
      label,
      used: Math.max(0, Math.min(100, used)),
      resetsAt: wholeMinute(normalizeReset(value.resets_at ?? value.reset_at)),
    });
  }
  return windows;
}

// Claude returns the same reset moment with different microseconds on every call. The service's pace
// calculation groups readings by an identical reset time, so publish it rounded to the minute.
function wholeMinute(value: string | null): string | null {
  return value === null ? null : new Date(Math.round(Date.parse(value) / 60_000) * 60_000).toISOString();
}

function organizationId(organizations: unknown): string | null {
  if (!Array.isArray(organizations)) return null;
  const withId = organizations.filter((item) => typeof (item?.uuid ?? item?.id) === "string");
  // Prefer the organization that carries the chat subscription when the account has several.
  const chat = withId.find((item) => Array.isArray(item.capabilities) && item.capabilities.includes("chat"));
  const chosen = chat ?? withId[0];
  const id = chosen ? String(chosen.uuid ?? chosen.id) : "";
  return /^[\w-]{1,80}$/.test(id) ? id : null;
}

function tierLabel(organizations: unknown, id: string): string | null {
  if (!Array.isArray(organizations)) return null;
  const tier = organizations.find((item) => (item?.uuid ?? item?.id) === id)?.rate_limit_tier;
  return typeof tier === "string" && /^[\w.\- ]{1,60}$/.test(tier) ? tier : null;
}

const base = { id: "claude" as const, plan: null, note: null, error: null, windows: [] as UsageWindow[] };

export async function readClaude(fetchJson: FetchJson): Promise<Provider> {
  try {
    const organizations = await fetchJson("/api/organizations");
    if (organizations.status === 401 || organizations.status === 403) return { ...base, state: "signed-out" };
    if (organizations.status !== 200) return { ...base, state: "error", error: `Claude HTTP ${organizations.status}` };

    const id = organizationId(organizations.body);
    if (!id) return { ...base, state: "error", error: "No Claude organization found" };

    const usage = await fetchJson(`/api/organizations/${id}/usage?cedar_ember=1`);
    if (usage.status === 401 || usage.status === 403) return { ...base, state: "signed-out" };
    if (usage.status !== 200) return { ...base, state: "error", error: `Claude usage HTTP ${usage.status}` };

    return { ...base, state: "ready", plan: tierLabel(organizations.body, id), windows: mapClaudeUsage(usage.body) };
  } catch {
    // Never surface the underlying message: it can quote a URL with the organization id in it.
    return { ...base, state: "error", error: "Claude could not be reached" };
  }
}

export interface RecordBody {
  type: "usage";
  provider: "claude";
  windows: UsageWindow[];
}

// Body for the service's POST /record (the local-tools route rec.ps1 uses). Null when there is nothing to publish.
export function claudeRecordBody(provider: Provider): RecordBody | null {
  if (provider.id !== "claude" || provider.state !== "ready" || !provider.windows.length) return null;
  return {
    type: "usage",
    provider: "claude",
    windows: provider.windows.map(({ label, used, resetsAt }) => ({ label, used, resetsAt })),
  };
}
