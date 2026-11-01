import { defineConfig } from "vitest/config";

// Console tests run under this config for `pnpm --filter @fleetos/console test`;
// the root vitest config also picks them up (CI runs the root runner). The
// jsdom environment comes from the per-file @vitest-environment docblock, and
// each test file imports ../test/setup (jest-dom matchers + RTL cleanup), so
// both runners behave identically without config-level path coupling.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
  },
});
