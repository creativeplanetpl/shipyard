import { describe, expect, it } from "vitest";
import { claudeRecordBody, mapClaudeUsage, readClaude, type FetchJson } from "../src/shared/claude";

const ORG = "11111111-2222-3333-4444-555555555555";
const USAGE_PATH = `/api/organizations/${ORG}/usage?cedar_ember=1`;
const organizations = [{ uuid: ORG, name: "someone@example.com Organization", rate_limit_tier: "default_raven", capabilities: ["chat"] }];
const usage = {
  five_hour: { utilization: 69.4, resets_at: "2026-11-25T13:20:00.283067+00:00" },
  seven_day: { utilization: 14, resets_at: "2026-12-02T02:00:00.283087+00:00" },
  seven_day_sonnet: null,
  seven_day_opus: { utilization: 250, resets_at: null },
  extra: { utilization: 5 },
};

function fake(routes: Record<string, { status: number; body: unknown }>): FetchJson & { calls: string[] } {
  const calls: string[] = [];
  const fetchJson = async (path: string) => { calls.push(path); return routes[path] ?? { status: 404, body: null }; };
  return Object.assign(fetchJson, { calls });
}

describe("mapClaudeUsage", () => {
  it("keeps only known windows with a number, clamps and labels them", () => {
    expect(mapClaudeUsage(usage)).toEqual([
      { label: "5 hours", used: 69.4, resetsAt: "2026-11-25T13:20:00.000Z" },
      { label: "7 days", used: 14, resetsAt: "2026-12-02T02:00:00.000Z" },
      { label: "Opus", used: 100, resetsAt: null },
    ]);
  });
  it("gives the same reset time for readings that differ only in microseconds", () => {
    const at = (stamp: string) => mapClaudeUsage({ five_hour: { utilization: 1, resets_at: stamp } })[0].resetsAt;
    expect(at("2026-11-25T13:20:00.042220+00:00")).toBe(at("2026-11-25T13:19:59.946617+00:00"));
  });
  it("returns nothing for junk", () => {
    expect(mapClaudeUsage(null)).toEqual([]);
    expect(mapClaudeUsage({ five_hour: { utilization: "69" } })).toEqual([]);
  });
});

describe("readClaude", () => {
  it("reads usage with the two extension calls and leaks no identity", async () => {
    const fetchJson = fake({
      "/api/organizations": { status: 200, body: organizations },
      [USAGE_PATH]: { status: 200, body: usage },
    });
    const provider = await readClaude(fetchJson);
    expect(fetchJson.calls).toEqual(["/api/organizations", USAGE_PATH]);
    expect(provider.state).toBe("ready");
    expect(provider.plan).toBe("default_raven");
    expect(provider.windows).toHaveLength(3);
    const serialized = JSON.stringify(provider);
    expect(serialized).not.toContain(ORG);
    expect(serialized).not.toContain("example.com");
  });
  it("prefers the organization with the chat capability", async () => {
    const fetchJson = fake({
      "/api/organizations": { status: 200, body: [{ uuid: "api-org", capabilities: ["api"] }, ...organizations] },
      [USAGE_PATH]: { status: 200, body: usage },
    });
    expect((await readClaude(fetchJson)).state).toBe("ready");
  });
  it("reports signed-out on 401 and 403", async () => {
    for (const status of [401, 403]) {
      const provider = await readClaude(fake({ "/api/organizations": { status, body: null } }));
      expect(provider).toMatchObject({ state: "signed-out", windows: [] });
    }
  });
  it("reports errors without the organization id", async () => {
    const provider = await readClaude(fake({ "/api/organizations": { status: 200, body: organizations } }));
    expect(provider).toMatchObject({ state: "error", error: "Claude usage HTTP 404" });
    expect((await readClaude(fake({ "/api/organizations": { status: 200, body: [] } }))).error).toBe("No Claude organization found");
    const thrown = await readClaude(async () => { throw new Error(`boom ${ORG}`); });
    expect(thrown.error).toBe("Claude could not be reached");
  });
  it("drops a tier label that is not a plain word", async () => {
    const fetchJson = fake({
      "/api/organizations": { status: 200, body: [{ uuid: ORG, rate_limit_tier: "someone@example.com" }] },
      [USAGE_PATH]: { status: 200, body: usage },
    });
    expect((await readClaude(fetchJson)).plan).toBeNull();
  });
});

describe("claudeRecordBody", () => {
  it("builds the /record body with label, used and resetsAt only", async () => {
    const fetchJson = fake({
      "/api/organizations": { status: 200, body: organizations },
      [USAGE_PATH]: { status: 200, body: usage },
    });
    const body = claudeRecordBody(await readClaude(fetchJson));
    expect(body).toEqual({
      type: "usage",
      provider: "claude",
      windows: [
        { label: "5 hours", used: 69.4, resetsAt: "2026-11-25T13:20:00.000Z" },
        { label: "7 days", used: 14, resetsAt: "2026-12-02T02:00:00.000Z" },
        { label: "Opus", used: 100, resetsAt: null },
      ],
    });
  });
  it("publishes nothing unless Claude is live", () => {
    const base = { id: "claude" as const, plan: null, note: null, error: null, windows: [] };
    expect(claudeRecordBody({ ...base, state: "signed-out" })).toBeNull();
    expect(claudeRecordBody({ ...base, state: "ready" })).toBeNull();
  });
});
