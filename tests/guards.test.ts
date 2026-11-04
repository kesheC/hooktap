import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

/** Strip // comments outside strings from JSON-with-comments. */
function parseJsonc(text: string): Record<string, unknown> {
  const lines = text.split("\n").filter((l) => !l.trim().startsWith("//"));
  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

describe("tsconfig layers", () => {
  it("base typechecks src and tests with noEmit", () => {
    const ts = parseJsonc(read("tsconfig.json")) as { compilerOptions: Record<string, unknown>; include: string[] };
    expect(ts.compilerOptions.noEmit).toBe(true);
    expect(ts.compilerOptions.types).toEqual(["node"]);
    expect(String(ts.compilerOptions.module).toLowerCase()).toBe("nodenext");
    expect(ts.include).toEqual(["src", "tests"]);
  });

  it("build layer emits with rootDir src only", () => {
    const ts = parseJsonc(read("tsconfig.build.json")) as { compilerOptions: Record<string, unknown>; include: string[] };
    expect(ts.compilerOptions.noEmit).toBe(false);
    expect(ts.compilerOptions.rootDir).toBe("src");
    expect(ts.compilerOptions.outDir).toBe("dist");
    expect(ts.include).toEqual(["src"]);
  });
});

describe("package contract", () => {
  const pkg = JSON.parse(read("package.json")) as Record<string, unknown> & {
    dependencies: Record<string, string>;
    engines: { node: string };
    scripts: Record<string, string>;
    bin: Record<string, string>;
  };

  it("has zero runtime dependencies", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("promises node >=20.11", () => {
    expect(pkg.engines.node).toBe(">=20.11");
  });

  it("bin points at dist/cli.js and dev rebuilds first", () => {
    expect(pkg.bin.hooktap).toBe("./dist/cli.js");
    expect(pkg.scripts.dev).toBe("npm run build && node dist/cli.js");
  });
});

describe("ci workflow", () => {
  const ci = read(".github/workflows/ci.yml");

  it("pins actions to 40-char shas with version comments", () => {
    const uses = ci.split("\n").filter((l) => l.trim().startsWith("- uses:"));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(/@([0-9a-f]{40}) # v\d+\.\d+\.\d+$/);
    }
  });

  it("runs npm audit after npm ci", () => {
    const lines = ci.split("\n");
    const ciIdx = lines.findIndex((l) => l.includes("npm ci"));
    const auditIdx = lines.findIndex((l) => l.includes("npm audit --audit-level=high"));
    expect(ciIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(ciIdx);
  });

  it("keeps contents read-only permission", () => {
    expect(ci).toContain("permissions:");
    expect(ci).toContain("contents: read");
  });
});

describe("release workflow", () => {
  const rel = read(".github/workflows/release.yml");

  it("validates tag==package.json before any gh call", () => {
    const lines = rel.split("\n");
    const gate = lines.findIndex((l) => l.includes("PKG="));
    const firstGh = lines.findIndex((l) => !l.trim().startsWith("#") && l.includes("gh "));
    expect(gate).toBeGreaterThan(-1);
    expect(firstGh).toBeGreaterThan(gate);
  });

  it("uploads both versioned and stable tarball names", () => {
    expect(rel).toContain("hooktap-");
    expect(rel).toContain("hooktap.tgz");
    expect(rel).toContain("SHA256SUMS");
  });
});

describe("dependabot", () => {
  it("ignores vitest and coverage majors as a pair plus @types/node", () => {
    const dep = read(".github/dependabot.yml");
    expect(dep).toContain("vitest");
    expect(dep).toContain("@vitest/coverage-v8");
    expect(dep).toContain("@types/node");
  });
});
