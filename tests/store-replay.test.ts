import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createCaptureServer } from "../src/server.js";
import { emptyStore, loadCaptures, saveCaptures, describeRecord } from "../src/store.js";
import { replayCapture, bodyText } from "../src/replay.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("store", () => {
  it("roundtrips through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "hooktap-store-"));
    const file = join(dir, "c.json");
    const store = emptyStore("roundtrip");
    store.captures.push({
      method: "POST", url: "/x", headers: { "content-type": "text/plain" },
      body: "hi", raw: "hi", receivedAt: "2026-01-01T00:00:00.000Z", remote: "127.0.0.1",
    });
    saveCaptures(store, file);
    const loaded = loadCaptures(file);
    expect(loaded.name).toBe("roundtrip");
    expect(loaded.captures).toHaveLength(1);
    expect(loaded.captures[0]!.raw).toBe("hi");
  });

  it("loadCaptures preserves ENOENT on missing files", () => {
    expect(() => loadCaptures("Z:/definitely/not/here.json")).toThrowError(/capture store not found/);
    try {
      loadCaptures("Z:/definitely/not/here.json");
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  it("rejects unknown formatVersion and missing captures", () => {
    const dir = mkdtempSync(join(tmpdir(), "hooktap-store-"));
    const bad1 = join(dir, "bad1.json");
    writeFileSync(bad1, JSON.stringify({ formatVersion: 99, name: "x", captures: [] }));
    expect(() => loadCaptures(bad1)).toThrowError(/formatVersion/);
    const bad2 = join(dir, "bad2.json");
    writeFileSync(bad2, JSON.stringify({ formatVersion: 1, name: "x" }));
    expect(() => loadCaptures(bad2)).toThrowError(/captures array/);
  });

  it("describeRecord summarizes", () => {
    const rec = { method: "GET", url: "/q", headers: {}, body: "abc", raw: "abc", receivedAt: "t", remote: "r" };
    expect(describeRecord(rec)).toBe("GET /q (3B, t)");
  });
});

describe("replayCapture", () => {
  it("redelivers the exact raw bytes to a target server", async () => {
    const received: Array<{ body: string; method: string; path: string; sig?: string }> = [];
    const target = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ body: Buffer.concat(chunks).toString("utf8"), method: req.method ?? "", path: req.url ?? "", sig: req.headers["x-hub-signature-256"] as string | undefined });
        res.statusCode = 202;
        res.end("accepted");
      });
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const port = (target.address() as { port: number }).port;

    const record = {
      method: "POST",
      url: "/hook",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=abc", host: "original:1", connection: "close" },
      body: { event: "ping" },
      raw: '{"event":"ping"}',
      receivedAt: "t",
      remote: "127.0.0.1",
    };
    const result = await replayCapture(record, "http://127.0.0.1:" + port + "/ingest");
    expect(result.status).toBe(202);
    expect(result.body).toBe("accepted");
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toBe('{"event":"ping"}');
    expect(received[0]!.method).toBe("POST");
    expect(received[0]!.path).toBe("/ingest");
    expect(received[0]!.sig).toBe("sha256=abc");

    target.closeAllConnections();
    target.close();
  });

  it("bodyText prefers raw and falls back to the decoded form", () => {
    expect(bodyText({ method: "POST", url: "/", headers: {}, body: { a: 1 }, raw: '{"a":1}', receivedAt: "t", remote: "r" })).toBe('{"a":1}');
    expect(bodyText({ method: "POST", url: "/", headers: {}, body: { a: 1 }, receivedAt: "t", remote: "r" } as never)).toBe('{"a":1}');
    expect(bodyText({ method: "POST", url: "/", headers: {}, body: "plain", raw: "plain", receivedAt: "t", remote: "r" })).toBe("plain");
  });

  it("times out when the target never answers", async () => {
    const target = createServer(() => { /* never respond */ });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const port = (target.address() as { port: number }).port;
    const record = { method: "POST", url: "/", headers: {}, body: "", raw: "", receivedAt: "t", remote: "r" };
    await expect(replayCapture(record, "http://127.0.0.1:" + port + "/x", 100)).rejects.toThrowError(/timed out/);
    target.closeAllConnections();
    target.close();
  });
});
