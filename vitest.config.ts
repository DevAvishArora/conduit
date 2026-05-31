import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/tests/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "packages/web/**"],
    environment: "node",
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "coverage",
      // Coverage is enforced ONLY on the pure libs that have direct unit tests.
      // Service entrypoints are exercised via the integration test, not unit
      // tests, so demanding line-coverage on them would be misleading.
      include: [
        "packages/shared/src/retry.ts",
        "packages/shared/src/template.ts",
        "packages/shared/src/validate.ts",
        "packages/shared/src/crypto/hmac.ts",
        "packages/shared/src/handlers/condition.ts",
        "packages/shared/src/handlers/ssrf.ts",
      ],
      thresholds: {
        // These targets are deliberately tight — if they slip, lower the
        // threshold consciously rather than auto-degrading.
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90,
      },
    },
  },
});
