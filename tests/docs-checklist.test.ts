import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D2 doc-lint: every required section of the product plan and system design
 * (approved spec art_s9VfpgZW, deliverable D2) must exist. Sections are
 * asserted by heading prefix so a refactor that renames a chapter fails
 * loudly instead of silently dropping content.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

function readDoc(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

function headingExists(doc: string, heading: string): boolean {
  const lines = doc.split("\n");
  const target = heading.toLowerCase();
  return lines.some((line) => {
    const match = /^#{1,6}\s+(?:\d+\.\s+)?(.+)$/.exec(line.trim());
    if (!match?.[1]) return false;
    return match[1].toLowerCase().startsWith(target);
  });
}

function requireHeadings(doc: string, headings: readonly string[], file: string) {
  for (const heading of headings) {
    expect(headingExists(doc, heading), `${file} is missing required section: "${heading}"`).toBe(
      true,
    );
  }
}

describe("docs/plan/product-plan.md (D2)", () => {
  const doc = readDoc("docs/plan/product-plan.md");

  const sections = [
    "Market framing",
    "Competitive positioning",
    "Customers and segments",
    "Phased integration roadmap",
    "Milestone plan",
    "Business model",
    "Risk register",
  ] as const;

  it("contains every required D2 plan section", () => {
    requireHeadings(doc, sections, "docs/plan/product-plan.md");
  });

  it("names the first-batch OEMs and the next category", () => {
    for (const fact of [
      "Greenworks",
      "Navimow",
      "Husqvarna",
      "scrubbing",
      "Auterion",
      "Formant",
      "InOrbit",
    ]) {
      expect(doc.includes(fact), `plan does not mention "${fact}"`).toBe(true);
    }
  });

  it("aligns milestones to the concept-doc work packages", () => {
    for (const period of ["M1–M3", "M4–M6", "M7–M9", "M10–M12"]) {
      expect(doc.includes(period), `plan does not cover work package ${period}`).toBe(true);
    }
  });

  it("carries a draft-for-improvement status banner", () => {
    expect(doc).toMatch(/Draft for improvement/i);
  });
});

describe("docs/design/fleetos-design.md (D2)", () => {
  const doc = readDoc("docs/design/fleetos-design.md");

  const sections = [
    "Architecture overview",
    "The capability ontology",
    "The adapter SDK",
    "World-model layer",
    "External constraints",
    "Agentic operations",
    "Scheduling core",
    "Fleet health",
    "Data compliance by design",
    "Stack and repository layout",
    "Verification",
  ] as const;

  it("contains every required D2 design section", () => {
    requireHeadings(doc, sections, "docs/design/fleetos-design.md");
  });

  it("covers the external-constraints chapter: constraint packs + Phase I AI extraction seam", () => {
    for (const fact of [
      "ExternalConstraintPack",
      "constraint packs",
      "humanApproved",
      "ai-draft",
      "AI constraint extraction",
    ]) {
      expect(doc.includes(fact), `design does not cover "${fact}"`).toBe(true);
    }
  });

  it("covers the agentic-operations chapter: per-device agents, bounded autonomy, human-supervised recovery", () => {
    for (const fact of ["DeviceAgent", "bounded", "human approval", "audit trail", "Phase I"]) {
      expect(doc.includes(fact), `design does not cover "${fact}"`).toBe(true);
    }
  });

  it("covers data compliance: FCC posture, residency/minimization, cross-border flows, firmware governance, audit evidence", () => {
    for (const fact of [
      "Covered List",
      "residency",
      "minimization",
      "cross-border",
      "Firmware-update governance",
      "audit trail",
    ]) {
      expect(doc.includes(fact), `design does not cover "${fact}"`).toBe(true);
    }
  });

  it("states the non-goal guardrail: no remote driving, robot-local safety authoritative", () => {
    expect(doc).toMatch(/No teleoperation/i);
    expect(doc).toMatch(/local safety controller stays authoritative/i);
    expect(doc).toMatch(/pause\/resume\/reassign/i);
  });

  it("cites the concept doc and carries source attribution", () => {
    expect(doc.includes("02_Circunar_RaaS_Fleet_OS.docx")).toBe(true);
    expect(doc).toMatch(/Sources:/);
  });
});
