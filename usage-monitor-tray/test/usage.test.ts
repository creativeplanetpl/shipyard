import { describe, expect, it } from "vitest";
import {
  composeSnapshot, highestUsage, normalizeReset, problemNote, providerFromService, resetShort, resetText, tooltipText, trayIconBitmap, usageLevel,
  type Provider,
} from "../src/shared/usage";

const now = new Date("2026-11-25T13:00:00Z");
const service = {
  providers: [
    { id: "grok", state: "ready", plan: null, note: null, error: null, windows: [{ label: "7 days", used: 100, resetsAt: "2026-11-25T15:43:16.543+00:00" }] },
    { id: "chatgpt", state: "snapshot", note: "Last Codex run; not a live check.", windows: [
      { label: "5 hours", used: 57, resetsAt: "2026-11-25T12:13:01.000Z" },
      { label: "7 days", used: 81, resetsAt: "2026-11-30T05:18:30.000Z" },
    ] },
    { id: "claude", state: "ready", plan: "default_raven", windows: [{ label: "5 hours", used: 69, resetsAt: "2026-11-25T13:20:00Z" }] },
  ],
  updatedAt: "2026-11-25T12:55:58.466Z",
};
const base = { id: "claude" as const, plan: null, note: null, error: null, windows: [] };
const live: Provider = { ...base, state: "ready", plan: "default_raven", windows: [{ label: "5 hours", used: 70, resetsAt: "2026-11-25T13:20:00Z" }] };

describe("providerFromService", () => {
  it("maps a provider and ignores malformed windows", () => {
    const provider = providerFromService({ providers: [{ id: "grok", state: "weird", windows: [{ label: "7 days", used: 140, resetsAt: 1795000000 }, { label: 3, used: 1 }, { label: "x", used: "1" }] }] }, "grok");
    expect(provider).toEqual({ id: "grok", state: "unavailable", plan: null, note: null, error: null,
      windows: [{ label: "7 days", used: 100, resetsAt: new Date(1795000000 * 1000).toISOString() }] });
    expect(providerFromService(service, "claude")?.plan).toBe("default_raven");
    expect(providerFromService(null, "grok")).toBeNull();
  });
});

describe("composeSnapshot", () => {
  it("uses the live Claude reading and the service for Codex and Grok, in card order", () => {
    const snapshot = composeSnapshot(service, live, now);
    expect(snapshot.providers.map((provider) => provider.id)).toEqual(["claude", "chatgpt", "grok"]);
    expect(snapshot.providers[0]).toBe(live);
    expect(snapshot.providers[1].state).toBe("snapshot");
    expect(snapshot.providers[2].windows[0].used).toBe(100);
    expect(snapshot.serviceOnline).toBe(true);
    expect(snapshot.updatedAt).toBe(now.toISOString());
  });
  it("falls back to the service's Claude reading when signed out, never calling it live", () => {
    const card = composeSnapshot(service, { ...base, state: "signed-out" }, now).providers[0];
    expect(card.state).toBe("signed-out");
    expect(card.windows[0].used).toBe(69);
    expect(card.note).toMatch(/Not signed in/);
    expect(composeSnapshot(service, { ...base, state: "error", error: "Claude HTTP 500" }, now).providers[0].state).toBe("snapshot");
  });
  it("marks Codex and Grok unavailable when the service is down", () => {
    const snapshot = composeSnapshot(null, { ...base, state: "signed-out" }, now);
    expect(snapshot.serviceOnline).toBe(false);
    expect(snapshot.providers.map((provider) => provider.state)).toEqual(["signed-out", "unavailable", "unavailable"]);
    expect(snapshot.providers[1].note).toMatch(/43821/);
  });
});

describe("highestUsage and tooltip", () => {
  it("picks the highest current window and skips windows whose reset has passed", () => {
    const snapshot = composeSnapshot(service, live, now);
    expect(highestUsage(snapshot, now)).toEqual({ used: 100, provider: "grok", label: "7 days" });
    expect(highestUsage(snapshot, new Date("2026-11-25T16:00:00Z"))).toEqual({ used: 81, provider: "chatgpt", label: "7 days" });
    expect(highestUsage(null, now)).toBeNull();
  });
  it("writes a short tooltip", () => {
    const tip = tooltipText(composeSnapshot(service, live, now), now);
    expect(tip.split("\n")).toEqual([
      "AI Monitor: highest 100% (Grok, 7 days)",
      "Claude: 5h 70%",
      "Codex: 5h 57%, 7d 81%",
      "Grok: 7d 100%",
    ]);
    expect(tip.length).toBeLessThanOrEqual(127);
    expect(tooltipText(null, now)).toBe("AI Monitor: no usage data");
  });
});

describe("small helpers", () => {
  it("normalizes reset times", () => {
    expect(normalizeReset("2026-11-25T13:20:00Z")).toBe("2026-11-25T13:20:00Z");
    expect(normalizeReset(1795000000000)).toBe(new Date(1795000000000).toISOString());
    expect(normalizeReset("soon")).toBeNull();
    expect(normalizeReset(null)).toBeNull();
  });
  it("grades usage and words the reset line", () => {
    expect([usageLevel(10), usageLevel(70), usageLevel(95), usageLevel(null)]).toEqual(["ok", "warn", "high", "none"]);
    expect(resetText({ label: "5 hours", used: 1, resetsAt: "2026-11-25T12:00:00Z" }, now)).toMatch(/^Reset time passed: /);
    expect(resetText({ label: "5 hours", used: 1, resetsAt: "2026-11-25T15:00:00Z" }, now)).toMatch(/^Resets: .*\(in 2 hours\)$/);
    expect(resetText({ label: "5 hours", used: 1, resetsAt: null }, now)).toBe("Reset time unavailable from this source");
  });
  it("keeps the panel quiet unless there is a problem", () => {
    expect(resetShort({ label: "5 hours", used: 1, resetsAt: "2026-11-25T15:00:00Z" }, now)).toBe("resets in 2 hours");
    expect(resetShort({ label: "5 hours", used: 1, resetsAt: "2026-11-25T12:00:00Z" }, now)).toBe("reset time passed");
    expect(resetShort({ label: "5 hours", used: 1, resetsAt: null }, now)).toBe("no reset time");
    const cards = composeSnapshot(service, live, now).providers;
    expect(cards.map(problemNote)).toEqual([null, null, null]);
    expect(problemNote(composeSnapshot(service, { ...base, state: "signed-out" }, now).providers[0])).toMatch(/^Not signed in/);
    expect(problemNote({ ...base, state: "error", error: "Claude HTTP 500" })).toBe("Claude HTTP 500");
    expect(problemNote(composeSnapshot(null, live, now).providers[1])).toMatch(/43821/);
  });
  it("draws an opaque 32x32 icon whose fill grows with usage", () => {
    const filled = (used: number | null) => {
      const pixels = trayIconBitmap(used);
      expect(pixels.length).toBe(32 * 32 * 4);
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] === 255 && pixels[i] !== 0x2a) count += 1;
      return count;
    };
    expect(filled(90)).toBeGreaterThan(filled(20));
    expect(filled(20)).toBeGreaterThan(filled(null));
  });
});
