import { defineConfig } from "vitest/config";

export default defineConfig({
  // JSX transform must be automatic — React 19 components do not import React.
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "tests/**/*.test.ts",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
    ],
    environment: "node",
    // Per-file concerns: console component tests declare jsdom via a
    // @vitest-environment docblock and import ../test/setup themselves —
    // keeping this config free of console-specific paths so package-level
    // vitest runs (which walk up to this config) resolve cleanly.
  },
});
