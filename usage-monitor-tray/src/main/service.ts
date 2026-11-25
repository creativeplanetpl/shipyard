// Client for the local Shipyard usage monitor. Uses node:http from the main process so no Origin
// header is sent: the service refuses every Origin except the Chrome extension's.
import http from "node:http";
import type { RecordBody } from "../shared/claude";

const HOST = "127.0.0.1";
export const SERVICE_PORT = 43821;

function request(method: "GET" | "POST", path: string, body: unknown, port: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: HOST,
        port,
        path,
        method,
        timeout: 15_000,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          let parsed: unknown = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// The stored snapshot, or null when the service is down or has nothing yet.
export async function getServiceSnapshot(port = SERVICE_PORT): Promise<unknown> {
  try {
    const response = await request("GET", "/snapshot", undefined, port);
    return response.status === 200 ? response.body : null;
  } catch {
    return null;
  }
}

export async function publishClaude(record: RecordBody, port = SERVICE_PORT): Promise<boolean> {
  try {
    return (await request("POST", "/record", record, port)).status === 200;
  } catch {
    return false;
  }
}
