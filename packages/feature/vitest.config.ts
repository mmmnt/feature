import { defineConfig } from "vitest/config";

// Several suites here spawn the built CLI (a few hundred ms to a few seconds each); under a parallel
// turbo run the default 5s was flaky.
export default defineConfig({ test: { testTimeout: 30_000 } });
