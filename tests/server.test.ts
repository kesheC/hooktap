import { afterAll, describe, expect, it } from "vitest";
import { createCaptureServer } from "../src/server.js";
import { request } from "node:http";

const servers: Array<{ close(): Promise<void> }> = [];

afterAll(async () => {
  for (const s of servers) await s.close();
});

function post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("createCaptureServer", () => {
  it("captures a JSON POST with decoded body and exact raw bytes", async () => {
    const server = await createCaptureServer({ quiet: true });
    servers.push(server);
    const raw = '{"event":"ping","n":42}';
    const res = await post(server.url + "/hook", raw, { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ captured: 1 });
    expect(server.captures).toHaveLength(1);
    const rec = server.captures[0]!;
    expect(rec.method).toBe("POST");
    expect(rec.url).toBe("/hook");
    expect(rec.body).toEqual({ event: "ping", n: 42 });
    expect(rec.raw).toBe(raw);
    expect(rec.remote).toContain("127.0.0.1");
    expect(rec.headers["content-type"]).toContain("application/json");
  });

  it("keeps non-JSON bodies as strings", async () => {
    const server = await createCaptureServer({ quiet: true });
    servers.push(server);
    await post(server.url + "/p", "plain,text", { "content-type": "text/plain" });
    const rec = server.captures[0]!;
    expect(rec.body).toBe("plain,text");
    expect(rec.raw).toBe("plain,text");
  });

  it("strips hop-by-hop headers and lowercases the rest", async () => {
    const server = await createCaptureServer({ quiet: true });
    servers.push(server);
    await post(server.url + "/p", "x", { "content-type": "text/plain", connection: "close", "x-custom": "Keep" });
    const rec = server.captures[0]!;
    expect(rec.headers["connection"]).toBeUndefined();
    expect(rec.headers["x-custom"]).toBe("Keep");
    expect(Object.keys(rec.headers).every((k) => k === k.toLowerCase())).toBe(true);
  });

  it("writes the store file after every capture when --out is given", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "hooktap-"));
    const out = join(dir, "store.json");
    const server = await createCaptureServer({ quiet: true, outPath: out, name: "demo" });
    servers.push(server);
    await post(server.url + "/a", "one", { "content-type": "text/plain" });
    const { readFileSync } = await import("node:fs");
    const store = JSON.parse(readFileSync(out, "utf8")) as { formatVersion: number; name: string; captures: unknown[] };
    expect(store.formatVersion).toBe(1);
    expect(store.name).toBe("demo");
    expect(store.captures).toHaveLength(1);
    await post(server.url + "/b", "two", { "content-type": "text/plain" });
    const store2 = JSON.parse(readFileSync(out, "utf8")) as { captures: unknown[] };
    expect(store2.captures).toHaveLength(2);
  });

  it("binds an ephemeral port and reports the real one", async () => {
    const server = await createCaptureServer({ quiet: true });
    servers.push(server);
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toContain(":" + server.port);
  });
});
