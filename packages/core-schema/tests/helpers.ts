import type { z } from "zod";

/** Test helpers shared by the round-trip and parity suites. */

export function ensureParsed<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Expected valid record, got: ${result.error.message}`);
  }
  return result.data;
}

export function isRejected<T extends z.ZodType>(schema: T, value: unknown): boolean {
  return !schema.safeParse(value).success;
}

export function issuePaths<T extends z.ZodType>(schema: T, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) {
    throw new Error("Expected validation to fail, but it succeeded");
  }
  return result.error.issues.map((issue) => issue.path.map(String).join("."));
}
