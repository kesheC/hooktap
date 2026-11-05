import { createServer, type IncomingMessage, type Server } from "node:http";
import { renameSync, writeFileSync } from "node:fs";
import { emptyStore } from "./store.js";
import type { CaptureRecord, CaptureServer, CaptureStore, Headers, ServeOptions } from "./types.js";

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Write via a temp file + rename so a crash mid-write cannot leave a torn store. */
function saveAtomic(store: CaptureStore, outPath: string): void {
  const tmp = outPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  renameSync(tmp, outPath);
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

export function flattenHeaders(raw: IncomingMessage["headers"]): Headers {
  const out: Headers = {};
  for (const [key, value] of Object.entries(raw)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(", ");
  }
  return out;
}

function decodeBody(raw: string, contentType: string | undefined): string | Record<string, unknown> {
  if (contentType && contentType.toLowerCase().includes("application/json")) {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { /* fall through */ }
  }
  return raw;
}

function captureFromRequest(req: IncomingMessage, rawBytes: Buffer, remote: string): CaptureRecord {
  const raw = rawBytes.toString("utf8");
  return {
    method: req.method ?? "GET",
    url: req.url ?? "/",
    headers: flattenHeaders(req.headers),
    body: decodeBody(raw, req.headers["content-type"]),
    raw,
    receivedAt: new Date().toISOString(),
    remote,
  };
}

/**
 * Run a local HTTP server that records every request it receives.
 * With `outPath` the store file is rewritten after each capture, so a
 * Ctrl-C never loses what arrived before it.
 */
export function createCaptureServer(opts: ServeOptions = {}): Promise<CaptureServer> {
  const store: CaptureStore = emptyStore(opts.name ?? "captures");
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let oversized = false;
    req.on("data", (c: Buffer) => {
      received += c.length;
      if (received > maxBodyBytes) {
        oversized = true;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (oversized) {
        process.stderr.write("hooktap: request body exceeds maxBodyBytes (" + maxBodyBytes + "); rejecting with 413\n");
        res.statusCode = 413;
        res.end();
        return;
      }
      const remote = req.socket.remoteAddress ?? "unknown";
      const record = captureFromRequest(req, Buffer.concat(chunks), remote);
      store.captures.push(record);
      if (opts.outPath) {
        try {
          saveAtomic(store, opts.outPath);
        } catch (e) {
          process.stderr.write("hooktap: failed to persist capture store: " + (e instanceof Error ? e.message : String(e)) + "\n");
        }
      }
      if (!opts.quiet) process.stderr.write("captured: " + record.method + " " + record.url + " (#" + store.captures.length + ")\n");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ captured: store.captures.length }));
    });
    req.on("error", () => { res.statusCode = 400; res.end(); });
  });
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const realPort = typeof address === "object" && address !== null ? address.port : port;
      const captureServer: CaptureServer = {
        port: realPort,
        url: "http://" + (host === "0.0.0.0" ? "127.0.0.1" : host) + ":" + realPort,
        captures: store.captures,
        close: () => new Promise<void>((res) => { server.close(() => res()); }),
      };
      resolve(captureServer);
    });
  });
}
