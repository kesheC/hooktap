import { describe, expect, it } from "vitest";
import { hmacVerify, parseSignatureHeader, signBody } from "../src/verify.js";
import type { Headers } from "../src/types.js";

// RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"
// HMAC-SHA-256 = 5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843
const RFC_DATA = "what do ya want for nothing?";

describe("parseSignatureHeader", () => {
  it("parses the GitHub scheme-prefixed form", () => {
    const parsed = parseSignatureHeader("sha256=abc123");
    expect(parsed).toEqual({ scheme: "sha256", hex: "abc123" });
  });

  it("parses bare hex by length", () => {
    const sha256 = "a".repeat(64);
    const sha1 = "b".repeat(40);
    expect(parseSignatureHeader(sha256)).toEqual({ scheme: "sha256", hex: sha256 });
    expect(parseSignatureHeader(sha1)).toEqual({ scheme: "sha1", hex: sha1 });
  });

  it("rejects garbage", () => {
    expect(parseSignatureHeader("not-a-signature")).toBeNull();
    expect(parseSignatureHeader("md5=abcd")).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader("sha256=xyz")).toBeNull();
  });
});

describe("hmacVerify", () => {
  const goodSig = signBody("Jefe", RFC_DATA);
  const headers: Headers = { "x-hub-signature-256": goodSig, "content-type": "text/plain" };

  it("accepts a valid GitHub-style signature (RFC 4231 vector)", () => {
    const result = hmacVerify("Jefe", headers, RFC_DATA);
    expect(result.valid).toBe(true);
    expect(result.scheme).toBe("sha256");
    expect(result.computed).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("accepts x-hub-signature (sha1) form", () => {
    const sig = signBody("Jefe", RFC_DATA, "sha1");
    const result = hmacVerify("Jefe", { "x-hub-signature": sig }, RFC_DATA);
    expect(result.valid).toBe(true);
    expect(result.scheme).toBe("sha1");
  });

  it("rejects a wrong secret and reports the first differing nibble", () => {
    const result = hmacVerify("wrong-secret", headers, RFC_DATA);
    expect(result.valid).toBe(false);
    expect(result.firstDiff).toBe(0);
  });

  it("rejects when the body was tampered with", () => {
    const result = hmacVerify("Jefe", headers, RFC_DATA + " tampered");
    expect(result.valid).toBe(false);
  });

  it("rejects with scheme null when no signature header is present", () => {
    const result = hmacVerify("Jefe", { "content-type": "text/plain" }, RFC_DATA);
    expect(result.valid).toBe(false);
    expect(result.scheme).toBeNull();
    expect(result.headerName).toBeNull();
  });

  it("rejects an unparsable signature header value", () => {
    const result = hmacVerify("Jefe", { "x-signature": "garbage!" }, RFC_DATA);
    expect(result.valid).toBe(false);
    expect(result.scheme).toBeNull();
    expect(result.headerName).toBe("x-signature");
  });

  it("verifies JSON-object bodies via their raw bytes", () => {
    const rawBody = '{"event":"ping","n":1}';
    const sig = signBody("s3cret", rawBody);
    const result = hmacVerify("s3cret", { "x-hub-signature-256": sig }, rawBody);
    expect(result.valid).toBe(true);
  });

  it("signBody roundtrip for both schemes", () => {
    for (const scheme of ["sha256", "sha1"] as const) {
      const sig = signBody("k", "data", scheme);
      expect(hmacVerify("k", { "x-hub-signature-256": sig }, "data").valid).toBe(true);
      expect(hmacVerify("k", { "x-hub-signature": sig }, "data").valid).toBe(true);
    }
  });
});
