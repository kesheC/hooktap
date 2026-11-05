import { createHmac, timingSafeEqual } from "node:crypto";
import { SIGNATURE_HEADERS, VERIFY_SCHEMES, type Headers, type VerifyResult, type VerifyScheme } from "./types.js";

/** Parse "sha256=abcd" (GitHub style) or a bare hex digest into scheme + hex. */
export function parseSignatureHeader(value: string): { scheme: VerifyScheme; hex: string } | null {
  const trimmed = value.trim();
  const eq = trimmed.indexOf("=");
  if (eq > 0) {
    const scheme = trimmed.slice(0, eq).toLowerCase();
    const hex = trimmed.slice(eq + 1).trim();
    if ((VERIFY_SCHEMES as readonly string[]).includes(scheme) && isHex(hex)) {
      return { scheme: scheme as VerifyScheme, hex: hex.toLowerCase() };
    }
    return null;
  }
  if (isHex(trimmed)) {
    // Bare hex: disambiguate by length (64 nibbles = sha256, 40 = sha1).
    if (trimmed.length === 64) return { scheme: "sha256", hex: trimmed.toLowerCase() };
    if (trimmed.length === 40) return { scheme: "sha1", hex: trimmed.toLowerCase() };
  }
  return null;
}

function isHex(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(s) && s.length > 0;
}

function computeHex(secret: string, body: string | Record<string, unknown>, scheme: VerifyScheme): string {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return createHmac(scheme, secret).update(payload, "utf8").digest("hex");
}

/**
 * Verify an HMAC-signed webhook request. Looks up the digest in the four
 * conventional signature headers, recomputes it with the given secret, and
 * compares in constant time.
 */
export function hmacVerify(
  secret: string,
  headers: Headers,
  body: string | Record<string, unknown>,
): VerifyResult {
  // Callers may pass header keys in any case (an SDK user sends
  // "X-Hub-Signature-256", Node delivers "x-hub-signature-256"); normalize
  // once so the lookup below cannot silently miss an uppercase key.
  const lower: Headers = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  for (const name of SIGNATURE_HEADERS) {
    const value = lower[name];
    if (value === undefined) continue;
    const parsed = parseSignatureHeader(value);
    if (!parsed) {
      return invalid(null, value, name, "");
    }
    const computed = computeHex(secret, body, parsed.scheme);
    return judge(parsed.scheme, value, name, computed, parsed.hex);
  }
  return { valid: false, scheme: null, headerValue: null, headerName: null, computed: computeHex(secret, body, "sha256") };
}

function invalid(scheme: VerifyScheme | null, headerValue: string, headerName: string, computed: string): VerifyResult {
  return { valid: false, scheme, headerValue, headerName, computed };
}

function judge(scheme: VerifyScheme, headerValue: string, headerName: string, computed: string, hex: string): VerifyResult {
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(hex, "utf8");
  const sameLen = a.length === b.length;
  const equal = sameLen && timingSafeEqual(a, b);
  if (equal) return { valid: true, scheme, headerValue, headerName, computed };
  let firstDiff: number | undefined = undefined;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) { firstDiff = i; break; }
  }
  return { valid: false, scheme, headerValue, headerName, computed, firstDiff };
}

/** Compute the signature a sender would attach for this secret and body. */
export function signBody(secret: string, body: string | Record<string, unknown>, scheme: VerifyScheme = "sha256"): string {
  return scheme + "=" + computeHex(secret, body, scheme);
}
