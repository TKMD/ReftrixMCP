// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-CROP-PII-EXCLUDED-001 — high-PII parts are never given a visual embedding by the
 * part visual loop, and the high-PII section SSOT stays exported (H).
 *
 * Context / 背景:
 *   Crop generation (the write path) was removed (2026-10-26); the original surfaces
 *   that pinned the crop save sites went with it (INV-CROP-NO-WRITE-001 now pins that
 *   no crop write exists). What stays is the part-side data-minimisation pin (the part
 *   visual loop must keep excluding high-PII parts, GDPR Art.5(1)(c)) and the
 *   `getHighPiiSectionIds` SSOT export that the redaction paths import.
 *
 * Invariant / 不変条件 (AST source-pin, deterministic, NO testcontainer):
 *   - surface 2: the part visual loop (`processPartVisualEmbeddingLoop` body only)
 *     filters `piiRiskLevel: { not: "high" }`.
 *   - surface 4 (SEC-M-01): `getHighPiiSectionIds` is EXPORTED from
 *     services/section-detail.service.ts.
 *   - surface 4b: the export is importable and returns an empty Set for empty input.
 *
 * This is a P0 standing regression (gdpr-delete + large-page cross-binding).
 * CI-failing executable invariant. `.skip()` / `.todo()` are prohibited.
 *
 * @see apps/mcp-server/src/workers/phases/phase-5-embedding.ts (processPartVisualEmbeddingLoop)
 * @see apps/mcp-server/src/services/section-detail.service.ts (getHighPiiSectionIds SSOT)
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertInvName } from "../_setup/inv-assert";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, relPath), "utf8");
}

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const PHASE5_REL = "workers/phases/phase-5-embedding.ts";
const SECTION_DETAIL_REL = "services/section-detail.service.ts";

describe("INV-CROP-PII-EXCLUDED-001: the part visual loop skips high-PII parts and the high-PII section SSOT stays exported (fail-closed PII gate, W6 Issue A PR-3a)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-PII-EXCLUDED-001");
  });

  // ==========================================================================
  // Surface 2 — the part visual loop filters out high-PII parts
  // ==========================================================================

  it("INV-CROP-PII-EXCLUDED-001: surface 2 — the part visual loop body filters piiRiskLevel: { not: 'high' } (scoped to processPartVisualEmbeddingLoop)", () => {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    const fnStart = phase5.indexOf("async function processPartVisualEmbeddingLoop");
    expect(fnStart, "processPartVisualEmbeddingLoop must exist").toBeGreaterThan(-1);
    const nextFn = phase5.indexOf("\nasync function ", fnStart + 1);
    const body = phase5.slice(fnStart, nextFn === -1 ? undefined : nextFn);
    // Scoped to the loop body: a `piiRiskLevel: { not: "high" }` elsewhere in the
    // file must not satisfy this pin.
    expect(
      /piiRiskLevel:\s*\{\s*not:\s*["']high["']\s*\}/.test(body),
      "part visual loop query must filter piiRiskLevel: { not: 'high' } (high-PII parts never get a visual embedding)"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 4 — getHighPiiSectionIds is EXPORTED (SEC-M-01, forward-compat pin)
  // ==========================================================================

  it("INV-CROP-PII-EXCLUDED-001: surface 4 — getHighPiiSectionIds is EXPORTED from services/section-detail.service.ts (SEC-M-01 import prerequisite for redaction paths)", () => {
    const sectionDetail = stripLineComments(readSrc(SECTION_DETAIL_REL));
    // SEC-M-01: getHighPiiSectionIds MUST be exported so every redaction path imports the
    // SAME SSOT (inline forbidden). Pinned as a real `export async function` declaration.
    expect(
      /export\s+async\s+function\s+getHighPiiSectionIds\s*\(/.test(sectionDetail),
      "getHighPiiSectionIds MUST be exported (SEC-M-01) so redaction paths can import the SSOT"
    ).toBe(true);
  });

  it("INV-CROP-PII-EXCLUDED-001: surface 4b — getHighPiiSectionIds is importable + behaves as a high-PII section SSOT (export executes)", async () => {
    // Import-pin (TPA-L-02): the export must stay importable from the section-detail module.
    const mod = await import("../../../../src/services/section-detail.service");
    expect(
      typeof mod.getHighPiiSectionIds,
      "getHighPiiSectionIds must be importable as a function"
    ).toBe("function");
    // Empty input → empty set (no DB hit) confirms the SSOT contract shape.
    const empty = await mod.getHighPiiSectionIds([]);
    expect(empty instanceof Set, "getHighPiiSectionIds([]) must return a Set").toBe(true);
    expect(empty.size, "getHighPiiSectionIds([]) must be empty (no DB hit)").toBe(0);
  });
});
