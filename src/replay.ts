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

/** Re-send one captured request to a (usually local) target server. */
export function replayCapture(record: CaptureRecord, targetUrl: string, timeoutMs = 10000): Promise<ReplayResult> {
  const body = bodyText(record);
  const url = new URL(targetUrl);
  const transport = url.protocol === "https:" ? https : http;
  const headers = cleanHeaders(record.headers);
  headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
  return new Promise<ReplayResult>((resolve, reject) => {
    const req = transport.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: record.method, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const resHeaders: Headers = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") resHeaders[k] = v;
            else if (Array.isArray(v)) resHeaders[k] = v.join(", ");
          }
          resolve({ url: targetUrl, status: res.statusCode ?? 0, headers: resHeaders, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("replay timed out after " + timeoutMs + "ms")));
    req.on("error", reject);
    if (body.length > 0 && record.method !== "GET" && record.method !== "HEAD") req.write(body);
    req.end();
  });
}
