import type { CaptureRecord, VerifyResult } from "./types.js";

const MAX_BODY_PREVIEW = 200;

function bodyPreview(r: CaptureRecord): string {
  const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2);
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= MAX_BODY_PREVIEW) return one;
  return one.slice(0, MAX_BODY_PREVIEW - 1) + "\u2026";
}

export function renderRecord(r: CaptureRecord, index: number): string {
  const lines = [
    "#" + index + "  " + r.method + " " + r.url,
    "  from " + r.remote + "  at " + r.receivedAt,
  ];
  const sigKeys = Object.keys(r.headers).filter((k) => k.startsWith("x-hub-signature") || k.startsWith("x-signature"));
  for (const k of sigKeys) lines.push("  signature " + k + ": " + r.headers[k]);
  lines.push("  body: " + bodyPreview(r));
  return lines.join("\n");
}

export function renderVerify(v: VerifyResult): string {
  const lines = [
    "signature: " + (v.headerName ?? "(none)"),
    "scheme:    " + (v.scheme ?? "n/a"),
    "valid:     " + (v.valid ? "yes" : "NO"),
    "computed:  " + v.computed,
  ];
  if (v.headerValue !== null) lines.push("received:  " + v.headerValue);
  if (!v.valid && v.firstDiff !== undefined) lines.push("first diff at hex nibble " + v.firstDiff);
  return lines.join("\n");
}
