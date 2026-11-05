import http from "node:http";
import https from "node:https";
import type { CaptureRecord, Headers, ReplayResult } from "./types.js";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

function cleanHeaders(headers: Headers): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Replay sends the exact bytes that arrived; only fall back to the decoded form for hand-written stores. */
export function bodyText(r: CaptureRecord): string {
  if (r.raw !== undefined && r.raw !== null) return r.raw;
  return typeof r.body === "string" ? r.body : JSON.stringify(r.body);
}

/**
 * Response hop-by-hop headers (RFC 9110 §7.6.1): these describe the single
 * transport connection that delivered the response and must not be surfaced
 * as if they belonged to the replayed exchange. Headers named by the
 * Connection header are hop-by-hop too.
 */
const RESPONSE_HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade",
  "proxy-authenticate", "trailer", "te",
]);

function cleanResponseHeaders(res: http.IncomingMessage): Headers {
  const out: Headers = {};
  const connectionNamed = new Set(
    (res.headers.connection ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
  );
  for (const [k, v] of Object.entries(res.headers)) {
    const lower = k.toLowerCase();
    if (RESPONSE_HOP_BY_HOP.has(lower) || connectionNamed.has(lower)) continue;
    if (typeof v === "string") out[lower] = v;
    else if (Array.isArray(v)) out[lower] = v.join(", ");
  }
  return out;
}

/** Re-send one captured request to a (usually local) target server. */
export function replayCapture(record: CaptureRecord, targetUrl: string, timeoutMs = 10000): Promise<ReplayResult> {
  const body = bodyText(record);
  const url = new URL(targetUrl);
  const transport = url.protocol === "https:" ? https : http;
  const headers = cleanHeaders(record.headers);
  const bodyless = record.method === "GET" || record.method === "HEAD";
  // A bodyless request must not declare a length it will never send: the
  // body write below is skipped for GET/HEAD, so content-length goes too.
  if (!bodyless) headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
  return new Promise<ReplayResult>((resolve, reject) => {
    // Absolute deadline, not the socket's idle timeout: a server that keeps
    // dribbling bytes would reset req.setTimeout forever without this.
    const deadline = setTimeout(() => {
      req.destroy(new Error("replay timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    const req = transport.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: record.method, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(deadline);
          resolve({ url: targetUrl, status: res.statusCode ?? 0, headers: cleanResponseHeaders(res), body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("replay timed out after " + timeoutMs + "ms")));
    req.on("error", (e) => { clearTimeout(deadline); reject(e); });
    if (!bodyless && body.length > 0) req.write(body);
    req.end();
  });
}
