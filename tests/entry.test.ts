import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";

const distCli = new URL("../dist/cli.js", import.meta.url);

async function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [decodeURIComponent(distCli.pathname.replace(/^\/([A-Za-z]):/, "$1:")), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString("utf8"); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("cli timed out")); }, 15000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, stdout: out, stderr: err }); });
  });
}

describe("cli entry guard", () => {
  it("dist build exists (pretest guarantees it)", () => {
    expect(existsSync(distCli)).toBe(true);
  });

  it("--version prints without needing an exit syscall", async () => {
    const r = await runCli(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hooktap 0.1.3");
  });

  it("replay completes asynchronously and prints status before exit", async () => {
    const target = createServer((_req, res) => {
      res.writeHead(202, { "content-type": "text/plain" });
      res.end("accepted");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const port = (target.address() as { port: number }).port;
    try {
      const fixture = new URL("./fixtures/entry-store.json", import.meta.url);
      const r = await runCli(["replay", decodeURIComponent(fixture.pathname.replace(/^\/([A-Za-z]):/, "$1:")), "--to", "http://127.0.0.1:" + port + "/hook"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("status: 202");
      expect(r.stdout).toContain("body:  accepted");
    } finally {
      target.closeAllConnections();
      target.close();
    }
  }, 15000);

  it("sync failures still report non-zero exit codes", async () => {
    const r = await runCli(["sign", "--secret", "s", "--scheme", "md5", "x"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--scheme must be sha256 or sha1");
  });
});
