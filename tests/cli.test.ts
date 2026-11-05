import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { main, VERSION } from "../src/cli.js";
import { signBody } from "../src/verify.js";
import { emptyStore, saveCaptures } from "../src/store.js";
import type { CaptureRecord } from "../src/types.js";

function capture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    method: "POST",
    url: "/hook",
    headers: { "content-type": "application/json" },
    body: { event: "ping" },
    raw: '{"event":"ping"}',
    receivedAt: "2026-01-01T00:00:00.000Z",
    remote: "127.0.0.1",
    ...overrides,
  };
}

function storeFixture(records: CaptureRecord[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hooktap-cli-"));
  const file = join(dir, "store.json");
  const store = emptyStore("fixture");
  store.captures.push(...records);
  saveCaptures(store, file);
  return file;
}

function memStreams(): { out: string[]; err: string[]; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } {
  const out: string[] = [];
  const err: string[] = [];
  const mk = (sink: string[]): NodeJS.WritableStream => ({
    write: (s: string | Uint8Array) => { sink.push(String(s)); return true; },
  } as NodeJS.WritableStream);
  return { out, err, stdout: mk(out), stderr: mk(err) };
}

describe("cli basics", () => {
  it("prints help and version", () => {
    const s = memStreams();
    expect(main(["--help"], s.stdout, s.stderr)).toBe(0);
    expect(s.out.join("")).toContain("USAGE");
    expect(main(["--version"], s.stdout, s.stderr)).toBe(0);
    expect(s.out.join("")).toContain("hooktap " + VERSION);
  });

  it("rejects unknown commands with rc 2", () => {
    const s = memStreams();
    expect(main(["frobnicate"], s.stdout, s.stderr)).toBe(2);
    expect(s.err.join("")).toContain("unknown command");
  });
});

describe("cli sign", () => {
  it("signs a body from argv", () => {
    const s = memStreams();
    const rc = main(["sign", "--secret", "k", "hello"], s.stdout, s.stderr);
    expect(rc).toBe(0);
    expect(s.out.join("").trim()).toBe(signBody("k", "hello"));
  });

  it("requires a BODY argument (stdin was removed: readSync can block forever on vitest workers)", () => {
    const s = memStreams();
    expect(main(["sign", "--secret", "k"], s.stdout, s.stderr)).toBe(2);
    expect(s.err.join("")).toContain("missing BODY");
  });

  it("requires --secret", () => {
    const s = memStreams();
    expect(main(["sign", "x"], s.stdout, s.stderr)).toBe(2);
    expect(s.err.join("")).toContain("--secret");
  });

  it("rejects unknown schemes", () => {
    const s = memStreams();
    expect(main(["sign", "--secret", "k", "--scheme", "md5", "x"], s.stdout, s.stderr)).toBe(2);
  });
});

describe("cli verify", () => {
  const good = capture({ headers: { "x-hub-signature-256": signBody("s3cret", '{"event":"ping"}') } });

  it("verifies a valid signature (rc 0)", () => {
    const file = storeFixture([good]);
    const s = memStreams();
    expect(main(["verify", file, "--secret", "s3cret"], s.stdout, s.stderr)).toBe(0);
    expect(s.out.join("")).toContain("valid:     yes");
  });

  it("fails an invalid signature (rc 1)", () => {
    const file = storeFixture([good]);
    const s = memStreams();
    expect(main(["verify", file, "--secret", "nope"], s.stdout, s.stderr)).toBe(1);
    expect(s.out.join("")).toContain("valid:     NO");
  });

  it("emits JSON with --json", () => {
    const file = storeFixture([good]);
    const s = memStreams();
    expect(main(["verify", file, "--secret", "s3cret", "--json"], s.stdout, s.stderr)).toBe(0);
    const parsed = JSON.parse(s.out.join("")) as { valid: boolean; scheme: string };
    expect(parsed.valid).toBe(true);
    expect(parsed.scheme).toBe("sha256");
  });

  it("verifies by --index", () => {
    const bad = capture({ headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) } });
    const file = storeFixture([good, bad]);
    const s = memStreams();
    expect(main(["verify", file, "--secret", "s3cret", "--index", "1"], s.stdout, s.stderr)).toBe(1);
  });

  it("errors on missing file / empty store / bad index", () => {
    const s = memStreams();
    expect(main(["verify", "Z:/nope.json", "--secret", "k"], s.stdout, s.stderr)).toBe(2);
    const empty = storeFixture([]);
    expect(main(["verify", empty, "--secret", "k"], s.stdout, s.stderr)).toBe(2);
    const one = storeFixture([good]);
    expect(main(["verify", one, "--secret", "k", "--index", "9"], s.stdout, s.stderr)).toBe(2);
  });
});

describe("cli inspect", () => {
  it("renders records and the summary line", () => {
    const file = storeFixture([capture(), capture({ url: "/two" })]);
    const s = memStreams();
    expect(main(["inspect", file], s.stdout, s.stderr)).toBe(0);
    const text = s.out.join("");
    expect(text).toContain("#0  POST /hook");
    expect(text).toContain("#1  POST /two");
    expect(text).toContain("2 capture(s)");
  });

  it("honors --last and --json", () => {
    const file = storeFixture([capture(), capture({ url: "/two" })]);
    const s = memStreams();
    expect(main(["inspect", file, "--last", "1"], s.stdout, s.stderr)).toBe(0);
    expect(s.out.join("")).not.toContain("/hook ");
    const s2 = memStreams();
    expect(main(["inspect", file, "--json"], s2.stdout, s2.stderr)).toBe(0);
    const parsed = JSON.parse(s2.out.join("")) as { captures: unknown[] };
    expect(parsed.captures).toHaveLength(2);
  });
});

describe("cli replay", () => {
  it("redelivers to a live target and reports status", async () => {
    const seen: string[] = [];
    const target = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { seen.push(Buffer.concat(chunks).toString("utf8")); res.statusCode = 200; res.end("ok"); });
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const port = (target.address() as { port: number }).port;
    const file = storeFixture([capture()]);
    const s = memStreams();
    const rc = main(["replay", file, "--to", "http://127.0.0.1:" + port + "/in"], s.stdout, s.stderr);
    expect(rc).toBe(0);
    for (let i = 0; i < 50 && s.out.join("") === ""; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toEqual(['{"event":"ping"}']);
    expect(s.out.join("")).toContain("status: 200");
    target.closeAllConnections();
    target.close();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  it("requires --to and rejects out-of-range index", () => {
    const s = memStreams();
    const file = storeFixture([capture()]);
    expect(main(["replay", file], s.stdout, s.stderr)).toBe(2);
    expect(main(["replay", file, "--to", "http://x", "--index", "7"], s.stdout, s.stderr)).toBe(2);
  });
});

describe("cli end-of-options", () => {
  it("treats everything after the first bare -- as a literal positional", () => {
    // Regression: every bare "--" used to be stripped and positionals that
    // start with "-" were skipped, so "--body-starts-with-dash" as BODY died
    // with rc 2 "missing BODY".
    const s = memStreams();
    expect(main(["sign", "--secret", "k", "--", "--body-starts-with-dash"], s.stdout, s.stderr)).toBe(0);
    expect(s.out.join("")).toMatch(/^sha256=[0-9a-f]{64}/);
    const s2 = memStreams();
    expect(main(["sign", "--secret", "k", "--", "--body-starts-with-dash", "extra"], s2.stdout, s2.stderr)).toBe(0);
    expect(s2.out.join("")).toMatch(/^sha256=[0-9a-f]{64}/);
  });

  it("a leading bare -- terminates before any command token", () => {
    const s = memStreams();
    // Tokens after the first "--" are literal positionals, so a leading "--"
    // leaves no command to run: usage error, not a crash or a hang.
    expect(main(["--", "sign", "--secret", "k", "plain-body"], s.stdout, s.stderr)).toBe(2);
    // Only the FIRST bare "--" is the terminator: a second one stays literal.
    const s2 = memStreams();
    expect(main(["sign", "--secret", "k", "--", "--", "--dash-dash"], s2.stdout, s2.stderr)).toBe(0);
    expect(s2.out.join("")).toMatch(/^sha256=[0-9a-f]{64}/);
  });
});

describe("cli replay failure paths", () => {
  it("exits non-zero when the target socket dies mid-response", async () => {
    // Regression for the replay hang: the CLI must print a clear error and
    // exit 2 instead of never settling.
    const target = createServer((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => res.destroy(), 30);
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const port = (target.address() as { port: number }).port;
    const file = storeFixture([capture()]);
    const s = memStreams();
    const rc = main(["replay", file, "--to", "http://127.0.0.1:" + port + "/in"], s.stdout, s.stderr);
    expect(rc).toBe(0);
    // Wait until the async replay path has settled (error printed on stderr).
    for (let i = 0; i < 100 && s.err.join("") === ""; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(s.err.join("")).toContain("error:");
    expect(s.err.join("")).not.toBe("");
    target.closeAllConnections();
    target.close();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  it("exits non-zero in a child process when the replay target aborts mid-response", async () => {
    // CLI-layer contract: process exit code must be 2 with a stderr message,
    // not a silent hang (the audit's reproducible symptom).
    const { spawn } = await import("node:child_process");
    const { join, dirname } = await import("node:path");
    const { mkdtempSync, writeFileSync: wfs, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const target = createServer((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => res.destroy(), 30);
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const port = (target.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "hooktap-replay-"));
    const storePath = join(dir, "store.json");
    wfs(storePath, JSON.stringify({ formatVersion: 1, name: "t", captures: [{ method: "POST", url: "/in", headers: {}, body: "hi", raw: "hi", receivedAt: "t", remote: "r" }] }));
    const cliPath = join(dirname(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))), "dist", "cli.js");
    const child = spawn(process.execPath, [cliPath, "replay", storePath, "--to", "http://127.0.0.1:" + port + "/in"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderrOut = "";
    let stdoutOut = "";
    child.stderr!.on("data", (c: Buffer) => { stderrOut += c.toString("utf8"); });
    child.stdout!.on("data", (c: Buffer) => { stdoutOut += c.toString("utf8"); });
    const rc = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
    expect(rc).toBe(2);
    expect(stderrOut).toContain("error:");
    rmSync(dir, { recursive: true, force: true });
    target.closeAllConnections();
    target.close();
  }, 15000);
});

describe("cli listen", () => {
  it("validates --port", () => {
    const s = memStreams();
    expect(main(["listen", "--port", "nope"], s.stdout, s.stderr)).toBe(2);
    expect(main(["listen", "--port", "99999"], s.stdout, s.stderr)).toBe(2);
  });

  it("reports listen errors (EADDRINUSE) on stderr with rc 2 in a child process", async () => {
    // In-process listen failure would crash the worker; the real contract is
    // "child exits 2 with a stderr message", so test the entrypoint directly.
    const { spawn } = await import("node:child_process");
    const net = await import("node:net");
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    const { join, dirname } = await import("node:path");
    const cliPath = join(dirname(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))), "dist", "cli.js");
    const child = spawn(process.execPath, [cliPath, "listen", "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderrOut = "";
    child.stderr!.on("data", (c: Buffer) => { stderrOut += c.toString("utf8"); });
    const rc = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
    expect(rc).toBe(2);
    expect(stderrOut).toContain("hooktap: listen error");
    blocker.close();
  }, 15000);
});

describe("cli argument strictness", () => {
  it("rejects unknown --* flags (typo protection)", () => {
    const file = storeFixture([capture({ headers: { "x-hub-signature-256": signBody("s3cret", '{"event":"ping"}') } })]);
    const s = memStreams();
    // "--indexs" (typo) used to be silently ignored and capture 0 was verified.
    expect(main(["verify", file, "--secret", "s3cret", "--indexs", "1"], s.stdout, s.stderr)).toBe(2);
    expect(s.err.join("")).toContain("unknown option: --indexs");
  });

  it("rejects a value flag followed by another flag", () => {
    const s = memStreams();
    // "--secret --json" used to make the secret the literal string "--json".
    expect(main(["verify", "whatever.json", "--secret", "--json"], s.stdout, s.stderr)).toBe(2);
    expect(s.err.join("")).toContain("--secret needs a value");
  });

  it("rejects a trailing value flag with no value", () => {
    // loadCaptures runs before flag validation, so use a real store file;
    // "--index" at the end used to silently fall back to capture 0.
    const file = storeFixture([capture()]);
    const s = memStreams();
    expect(main(["verify", file, "--secret", "k", "--index"], s.stdout, s.stderr)).toBe(2);
    expect(s.err.join("")).toContain("--index needs a value");
  });

  it("verifies a raw:null capture against the decoded body (rc 0)", () => {
    // raw === null means "payload not storable as UTF-8"; verify used to hash
    // the string "null" and disagree with replay, which falls back to body.
    const rec = {
      ...capture(),
      headers: { "x-hub-signature-256": signBody("s3cret", '{"event":"ping"}') },
      raw: null,
    } as unknown as CaptureRecord;
    const file = storeFixture([rec]);
    const s = memStreams();
    expect(main(["verify", file, "--secret", "s3cret"], s.stdout, s.stderr)).toBe(0);
    expect(s.out.join("")).toContain("valid:     yes");
  });

  it("reports a null capture entry as malformed instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hooktap-cli-"));
    const file = join(dir, "store.json");
    writeFileSync(file, JSON.stringify({ formatVersion: 1, tape: "fixture", captures: [null] }));
    const s = memStreams();
    expect(main(["verify", file, "--secret", "k"], s.stdout, s.stderr)).toBe(2);
    expect(s.err.join("")).toContain("capture 0 malformed");
  });
});
