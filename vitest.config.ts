// Root Vitest config — applies to `feat run` (spawned from the project root).
// Coverage is REPORTED (artifact + lcov) but not yet threshold-gated: the spec
// suites execute built output, and v8 remapping through sourcemaps measures
// unreliably. Threshold gating lands once suites resolve source directly.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: [
        "packages/*/src/**",
        "adapters/*/src/**",
      ],
      reporter: ["text", "lcov"],
      reportsDirectory: "reports/coverage",
    },
  },
});
