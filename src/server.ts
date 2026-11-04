import { createServer, type IncomingMessage, type Server } from "node:http";
import { emptyStore, saveCaptures } from "./store.js";
import type { CaptureRecord, CaptureServer, CaptureStore, Headers, ServeOptions } from "./types.js";

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
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const remote = req.socket.remoteAddress ?? "unknown";
      const record = captureFromRequest(req, Buffer.concat(chunks), remote);
      store.captures.push(record);
      if (opts.outPath) {
        try { saveCaptures(store, opts.outPath); } catch { /* keep serving */ }
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
