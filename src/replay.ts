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

/**
 * Re-send one captured request to a (usually local) target server.
 * Argument validation happens before any await, so misuse reaches the caller
 * as a rejected promise (not a synchronous throw that escapes .catch()).
 */
export function replayCapture(record: CaptureRecord, targetUrl: string, timeoutMs = 10000): Promise<ReplayResult> {
  if (record === null || typeof record !== "object") {
    return Promise.reject(new Error("replayCapture needs a capture record"));
  }
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch (e) {
    return Promise.reject(new Error("replay target must be a valid URL: " + String(targetUrl)));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new Error("unsupported replay scheme " + url.protocol + " (only http/https)"));
  }
  const body = bodyText(record);
  const transport = url.protocol === "https:" ? https : http;
  const headers = cleanHeaders(record.headers);
  const bodyless = record.method === "GET" || record.method === "HEAD";
  // A bodyless request must not declare a length it will never send: the
  // body write below is skipped for GET/HEAD, so content-length goes too.
  if (!bodyless) headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
  return new Promise<ReplayResult>((resolve, reject) => {
    // Exactly-once settlement: a mid-body socket death fires several events
    // (res error, aborted, req error) and the deadline timer fires on top of
    // them, so every path funnels through this guard.
    let settled = false;
    const settle = (ok: boolean, value: ReplayResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (ok) resolve(value as ReplayResult);
      else reject(value as Error);
    };
    // Absolute deadline, not the socket's idle timeout: a server that keeps
    // dribbling bytes would reset req.setTimeout forever without this. The
    // timer rejects directly (then destroys); it must not rely on destroy()
    // producing an error event, which does not always happen.
    const deadline = setTimeout(() => {
      const err = new Error("replay deadline exceeded (" + timeoutMs + "ms)");
      settle(false, err);
      req.destroy(err);
    }, timeoutMs);
    const req = transport.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: record.method, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          settle(true, { url: targetUrl, status: res.statusCode ?? 0, headers: cleanResponseHeaders(res), body: Buffer.concat(chunks).toString("utf8") });
        });
        // A response socket that dies mid-body never emits "end": reject so
        // the caller's await settles instead of hanging forever.
        res.on("error", (e: Error) => settle(false, e));
        res.on("aborted", () => settle(false, new Error("response aborted before completion")));
      },
    );
    req.setTimeout(timeoutMs, () => settle(false, new Error("replay deadline exceeded (" + timeoutMs + "ms)")));
    req.on("error", (e) => settle(false, e instanceof Error ? e : new Error(String(e))));
    if (!bodyless && body.length > 0) req.write(body);
    req.end();
  });
}
