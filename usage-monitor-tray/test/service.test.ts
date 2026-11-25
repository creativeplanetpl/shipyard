// Runs the real Shipyard usage monitor (when its source is on this machine) against a temporary
// snapshot file, to prove the app's publish and read calls match the service's contract.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getServiceSnapshot, publishClaude } from "../src/main/service";
import { composeSnapshot, type Provider } from "../src/shared/usage";
import { claudeRecordBody } from "../src/shared/claude";

const SERVER = process.env.AIMON_SERVER_JS ?? "C:\\Scripts\\shipyard\\usage-monitor\\server.js";

describe.skipIf(!fs.existsSync(SERVER))("against the Shipyard usage monitor", () => {
  let server: import("node:http").Server;
  let port = 0;
  let dir = "";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimon-tray-"));
    const { createServer } = createRequire(import.meta.url)(SERVER);
    server = createServer(undefined, { snapshotFile: path.join(dir, "snapshot.json") });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null before any reading exists", async () => {
    expect(await getServiceSnapshot(port)).toBeNull();
  });

  it("publishes Claude through /record and reads it back from /snapshot", async () => {
    const claude: Provider = {
      id: "claude", state: "ready", plan: "default_raven", note: null, error: null,
      windows: [
        { label: "5 hours", used: 69, resetsAt: "2026-11-25T13:20:00.283067+00:00" },
        { label: "7 days", used: 14, resetsAt: "2026-12-02T02:00:00.283087+00:00" },
        { label: "Opus", used: 3, resetsAt: null },
      ],
    };
    expect(await publishClaude(claudeRecordBody(claude)!, port)).toBe(true);
    const stored = await getServiceSnapshot(port);
    const card = composeSnapshot(stored, { ...claude, state: "signed-out", windows: [] }).providers[0];
    expect(card.windows).toEqual(claude.windows);
    expect(fs.readFileSync(path.join(dir, "history.jsonl"), "utf8")).toContain('"id":"claude"');
  });

  it("reports failure when nothing listens", async () => {
    expect(await publishClaude({ type: "usage", provider: "claude", windows: [] }, 1)).toBe(false);
    expect(await getServiceSnapshot(1)).toBeNull();
  });
});
