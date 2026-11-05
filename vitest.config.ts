import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // entry.test.ts spawns the CLI asynchronously; the default 5s is too tight.
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
      },
      exclude: ["dist/**", "tests/**", "**/*.test.ts"],
    },
  },
});
