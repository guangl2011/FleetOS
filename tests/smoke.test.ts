import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Root workspace smoke suite.
 *
 * Keeps the scaffold honest in CI before any domain package lands:
 * the toolchain must execute under Node >= 20 and the pnpm workspace
 * glob must resolve to the directories the spec mandates.
 */
describe("FleetOS workspace scaffold", () => {
  it("runs on Node >= 20", () => {
    const major = Number(process.versions.node.split(".")[0]);
    expect(major).toBeGreaterThanOrEqual(20);
  });

  it("declares the packages/* + apps/* workspace layout", () => {
    const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
    expect(workspace).toContain('"packages/*"');
    expect(workspace).toContain('"apps/*"');
  });

  it("requires Node >= 20 in the root package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe(">=20");
  });
});
