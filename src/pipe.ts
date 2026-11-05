import process from "node:process";

/**
 * Turn a closed pipe into something harmless.
 *
 * `hooktap ... | head -1` makes the reader exit after the first line. The next
 * write to stdout then raises EPIPE, and with no error listener on the stream
 * Node treats it as an unhandled 'error' event: it prints a stack trace and
 * exits non-zero, so a caller that only wanted the first line saw a crash where
 * the command had actually succeeded.
 *
 * stdout carries the payload, so EPIPE there means the reader has read enough --
 * the run is a success and exits 0. stderr is only logging, so EPIPE there is
 * swallowed and the command carries on to whatever it still has to do. Any
 * other stream error is a real bug and is rethrown.
 */
export function installPipeGuard(): void {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
  process.stderr.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      return;
    }
    throw error;
  });
}
