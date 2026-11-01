import { defineConfig } from "vitest/config";

// Console tests run under this config for `pnpm --filter @fleetos/console test`;
// the root vitest config also picks them up (CI runs the root runner), which is
// why the root config carries the matching setup file + esbuild JSX setting.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
  },
});
