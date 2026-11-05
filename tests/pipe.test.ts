import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The pipe guard, tested the way it broke.
 *
 * `... | head -1` closes the reader after the first line. Without an error
 * listener on stdout the next write raises an unhandled EPIPE event: Node
 * prints a stack trace and exits non-zero, so a caller that only wanted the
 * first line saw a crash where the command had actually succeeded.
 *
 * The child below has its read end closed before the first byte is written, so
 * the very next write fails -- there is no timing luck in the assertion. Both
 * directions are covered: a normal run must exit 0, and a run that legitimately
 * fails must keep its own exit code instead of being turned into a crash.
 */
const CLI = path.resolve("dist", "cli.js");

interface Closed {
  code: number;
  stderr: string;
}

/** Run the CLI with stdout already closed by the reader. */
function runWithClosedStdout(args: readonly string[]): Promise<Closed> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
    child.stdout.destroy();
  });
}

/** An unhandled stream error is what the guard exists to suppress. */
function expectNoCrash(stderr: string): void {
  expect(stderr).not.toContain("EPIPE");
  expect(stderr).not.toContain("Unhandled 'error' event");
  expect(stderr).not.toContain("    at ");
}

describe.skipIf(!existsSync(CLI))("broken pipe", () => {
  it("exits 0 and prints no stack when the reader closes stdout", async () => {
    const result = await runWithClosedStdout(["--help"]);
    expectNoCrash(result.stderr);
    expect(result.code).toBe(0);
  });

  it("keeps the real failure exit code when stdout is closed too", async () => {
    const result = await runWithClosedStdout(["__no_such_command__"]);
    expectNoCrash(result.stderr);
    expect(result.code).toBe(2);
  });
});
