#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { hmacVerify, signBody } from "./verify.js";
import { createCaptureServer } from "./server.js";
import { loadCaptures } from "./store.js";
import { renderRecord, renderVerify } from "./render.js";
import { replayCapture } from "./replay.js";
import { installPipeGuard } from "./pipe.js";
import type { CaptureRecord } from "./types.js";

export const VERSION = "0.1.2";

const HELP = `hooktap ${VERSION} - capture, verify and replay webhooks locally

USAGE
  hooktap listen [--port N] [--host H] [--out FILE] [--quiet]
      Run a local capture server. Every request is recorded;
      with --out the store file is updated after each request.

  hooktap verify FILE --secret S [--index N] [--json]
      Verify the HMAC signature of stored capture N (default 0).
      Reads the digest from x-hub-signature-256 / x-hub-signature /
      x-signature-256 / x-signature and compares in constant time.

  hooktap sign --secret S [--scheme sha256|sha1] BODY
      Print the signature a sender would attach for BODY.

  hooktap replay FILE --to URL [--index N]
      Re-send captured request N (default 0) to URL.

  hooktap inspect FILE [--json] [--last N]
      Print stored captures.

  hooktap --help | -h | --version | -V
`;

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const next: string | undefined = args[i + 1];
  // A value flag followed by another flag (or by nothing) is a usage error:
  // "--secret --json" used to silently make the secret the string "--json".
  if (next === undefined || next.startsWith("-")) {
    throw new Error("option " + flag + " needs a value");
  }
  return next;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

const VALUE_FLAGS = new Set(["--port", "--host", "--out", "--secret", "--scheme", "--to", "--index", "--last"]);

// Every flag the CLI understands; anything else starting with "--" is a typo
// and must be rejected instead of silently ignored.
const ALLOWED_FLAGS = new Set([
  "--port", "--host", "--out", "--quiet", "--secret", "--scheme",
  "--to", "--index", "--last", "--json",
]);

function positional(args: string[], trailing: string[] = []): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a: string | undefined = args[i];
    const prev: string | undefined = args[i - 1];
    if (a !== undefined && !a.startsWith("-") && !VALUE_FLAGS.has(prev ?? "")) return a;
  }
  // Tokens after the first bare "--" are positionals verbatim, even when they
  // start with "-" (end-of-options convention).
  return trailing[0];
}

/** CLI entry. Returns a process exit code. */
export function main(argv: string[], stdout: NodeJS.WritableStream = process.stdout, stderr: NodeJS.WritableStream = process.stderr): number {
  // POSIX end-of-options: only the FIRST bare "--" is the terminator; every
  // token after it is a literal positional (so a body or file named "-x" or
  // "--flag-like" is deliverable). Parsing before the terminator is unchanged.
  const sep = argv.indexOf("--");
  const pre = sep === -1 ? argv : argv.slice(0, sep);
  const trailing: string[] = sep === -1 ? [] : argv.slice(sep + 1);
  if (hasFlag(pre, "-h") || hasFlag(pre, "--help")) { stdout.write(HELP); return 0; }
  if (hasFlag(pre, "-V") || hasFlag(pre, "--version")) { stdout.write("hooktap " + VERSION + "\n"); return 0; }

  const cmd = pre[0];
  const rest = pre.slice(1);

  const fail = (msg: string): number => { stderr.write("error: " + msg + "\n"); return 2; };

  // Typo'd flags must not be silently ignored: "--indexs 1" used to verify
  // capture 0 while the operator believed they were verifying capture 1.
  for (const token of rest) {
    if (token.startsWith("--") && !ALLOWED_FLAGS.has(token)) {
      return fail("unknown option: " + token);
    }
  }

  if (cmd === "listen") {
    const port = Number(argValue(rest, "--port") ?? "0");
    if (!Number.isInteger(port) || port < 0 || port > 65535) return fail("--port must be a valid port number");
    const host = argValue(rest, "--host") ?? "127.0.0.1";
    const outPath = argValue(rest, "--out");
    const quiet = hasFlag(rest, "--quiet");
    void createCaptureServer({ port, host, outPath, quiet }).then((server) => {
      stderr.write("hooktap listening on " + server.url + (outPath ? " (store: " + outPath + ")" : "") + "\n");
      stderr.write("send a webhook: curl -X POST " + server.url + "/hook -H 'content-type: application/json' -d '{\"event\":\"ping\"}'\n");
      stderr.write("press Ctrl-C to stop\n");
    }, (err) => {
      // EADDRINUSE and friends: report on stderr, set the exit code, and let
      // the process end on its own (never process.exit - it would kill async work).
      stderr.write("hooktap: listen error: " + (err instanceof Error ? err.message : String(err)) + "\n");
      process.exitCode = 2;
    });
    // The server keeps the process alive; Ctrl-C tears it down.
    return 0;
  }

  try {
    if (cmd === "verify") {
      const secret = argValue(rest, "--secret");
      if (!secret) return fail("--secret is required");
      const file = positional(rest, trailing);
      if (!file) return fail("missing FILE argument (see --help)");
      // loadCaptures is the single entry point for reading stores: it carries
      // the formatVersion and shape checks, so verify must not bypass it.
      const store = loadCaptures(file);
      const captures = store.captures;
      if (captures.length === 0) return fail("no captures in " + file);
      const index = Number(argValue(rest, "--index") ?? "0");
      if (!Number.isInteger(index) || index < 0 || index >= captures.length) return fail("index " + argValue(rest, "--index") + " out of range (" + captures.length + " captures)");
      const recAny: unknown = captures[index];
      // typeof null === "object", so a null entry needs its own guard; a
      // missing or non-object headers field would also crash deep inside.
      const headersOk = recAny !== null && typeof recAny === "object"
        && typeof (recAny as { headers?: unknown }).headers === "object"
        && (recAny as { headers?: unknown }).headers !== null;
      if (!headersOk) return fail("capture " + index + " malformed");
      const rec = recAny as CaptureRecord;
      // raw === null marks a non-UTF-8 payload on disk; hashing the string
      // "null" would be nonsense, so fall back to the body like replay does.
      const payload = rec.raw != null ? rec.raw : typeof rec.body === "string" ? rec.body : JSON.stringify(rec.body);
      const result = hmacVerify(secret, rec.headers, payload);
      if (hasFlag(rest, "--json")) stdout.write(JSON.stringify(result, null, 2) + "\n");
      else stdout.write(renderVerify(result) + "\n");
      return result.valid ? 0 : 1;
    }

    if (cmd === "sign") {
      const secret = argValue(rest, "--secret");
      if (!secret) return fail("--secret is required");
      const schemeRaw = argValue(rest, "--scheme") ?? "sha256";
      if (schemeRaw !== "sha256" && schemeRaw !== "sha1") return fail("--scheme must be sha256 or sha1");
      const bodyArg = positional(rest, trailing);
      if (bodyArg === undefined) return fail("missing BODY argument (pass the payload as one argument; compose with \$(echo ... ) in the shell)");
      stdout.write(signBody(secret, bodyArg, schemeRaw) + "\n");
      return 0;
    }

    if (cmd === "replay") {
      const to = argValue(rest, "--to");
      if (!to) return fail("--to URL is required");
      const file = positional(rest, trailing);
      if (!file) return fail("missing FILE argument (see --help)");
      const store = loadCaptures(file);
      const index = Number(argValue(rest, "--index") ?? "0");
      if (!Number.isInteger(index) || index < 0 || index >= store.captures.length) return fail("index " + argValue(rest, "--index") + " out of range (" + store.captures.length + " captures)");
      const record: CaptureRecord | undefined = store.captures[index];
      if (record === undefined) return fail("capture " + index + " malformed");
      void replayCapture(record, to).then((result) => {
        stdout.write("status: " + result.status + "\n");
        stdout.write("body:  " + result.body.slice(0, 400) + "\n");
        process.exitCode = result.status >= 200 && result.status < 300 ? 0 : 2;
      }, (e) => {
        stderr.write("error: " + (e instanceof Error ? e.message : String(e)) + "\n");
        process.exitCode = 2;
      });
      return 0;
    }

    if (cmd === "inspect") {
      const file = positional(rest, trailing);
      if (!file) return fail("missing FILE argument (see --help)");
      const store = loadCaptures(file);
      if (hasFlag(rest, "--json")) { stdout.write(JSON.stringify(store, null, 2) + "\n"); return 0; }
      const lastRaw = argValue(rest, "--last");
      const last = lastRaw === undefined ? store.captures.length : Number(lastRaw);
      if (!Number.isInteger(last) || last < 0) return fail("--last must be a non-negative integer");
      const from = Math.max(0, store.captures.length - last);
      for (let i = from; i < store.captures.length; i++) {
        const rec: CaptureRecord | undefined = store.captures[i];
        if (rec === undefined) continue;
        stdout.write(renderRecord(rec, i) + "\n");
      }
      stdout.write("\n" + store.captures.length + " capture(s) in " + file + "\n");
      return 0;
    }

    return fail("unknown command: " + String(cmd) + " (see --help)");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// Exact-path comparison, not a suffix regex: /cli\.(c|m)?js$/ would also
// fire for an unrelated "my-cli.js" imported by some other tool.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  installPipeGuard();
  // Never process.exit(main(...)): the replay command completes asynchronously, and an
  // immediate exit would kill the in-flight request before it prints. Setting exitCode
  // lets sync commands keep their codes (fail returns 1/2) while async work drains.
  process.exitCode = main(process.argv.slice(2));
}
