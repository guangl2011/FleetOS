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
    // Console component tests run under jsdom with jest-dom matchers.
    setupFiles: ["apps/console/src/test/setup.ts"],
  },
});
