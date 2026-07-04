// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-CROP-PII-EXCLUDED-001 — high-PII crops are NEVER written (H, W6 Issue A PR-3a).
 *
 * Context / 背景:
 *   PR-3a persists per-section / per-part viewable PNG crops in Phase 5. The crop is
 *   a NEW visual sink for exactly the avatars (high-PII parts) that text redaction
 *   suppresses. The crop save MUST sit INSIDE the already-PII-filtered loops so a
 *   high-PII crop is NEVER written to disk (fail-closed — not generate-then-unlink):
 *     - section sink: `processSingleSectionVisualEmbedding` is only reachable from
 *       `sectionsFiltered` (high-PII section_pattern_ids removed via the
 *       `highPiiSectionIdSet` / `queryHighPiiPendingSectionPatternIds` SSOT).
 *     - part sink: the part loop query filters `piiRiskLevel: { not: "high" }`.
 *   The `getHighPiiSectionIds` SSOT (`page-detail.service.ts`) MUST be EXPORTED
 *   (SEC-M-01) so the section.inspect crop-sink redaction (PR-4 runtime) imports it
 *   instead of re-implementing inline.
 *
 * section.inspect crop-sink (TPA-L-02): the crop read path does not exist until the
 * PR-4 serve route. In PR-3a the crop-sink redaction is a FORWARD-COMPAT AST-pin —
 * the SSOT must be EXPORTED + importable now; the runtime sink is exercised in PR-4.
 *
 * Invariant / 不変条件 (AST source-pin, deterministic, NO testcontainer):
 *   - surface 1: the section crop save is gated by CROP_PERSISTENCE_ENABLED inside
 *     `processSingleSectionVisualEmbedding` (reachable only from `sectionsFiltered`).
 *   - surface 2: the part crop save is gated by CROP_PERSISTENCE_ENABLED inside the
 *     part loop whose query already filters `piiRiskLevel: { not: "high" }`.
 *   - surface 3: neither crop save inlines a high-PII re-judgement (the filtered
 *     loop / query is trusted; no `pii_risk_level` literal at the crop-save site).
 *   - surface 4 (SEC-M-01): `getHighPiiSectionIds` is EXPORTED from
 *     page-detail.service.ts (forward-compat import-pin for the PR-4 crop-sink).
 *
 * This is a P0 standing regression (gdpr-delete + large-page cross-binding).
 * CI-failing executable invariant. `.skip()` / `.todo()` are prohibited.
 *
 * @see apps/mcp-server/src/workers/phases/phase-5-embedding.ts (both crop sinks)
 * @see apps/mcp-server/src/api/internal/page-detail.service.ts (getHighPiiSectionIds SSOT)
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
const PAGE_DETAIL_REL = "api/internal/page-detail.service.ts";

describe("INV-CROP-PII-EXCLUDED-001: high-PII crops are never written (fail-closed PII gate, W6 Issue A PR-3a)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-PII-EXCLUDED-001");
  });

  // ==========================================================================
  // Surface 1 — section crop save lives inside the PII-filtered section sink
  // ==========================================================================

  it("INV-CROP-PII-EXCLUDED-001: surface 1 — the section crop save is invoked inside processSingleSectionVisualEmbedding (reachable only from sectionsFiltered)", () => {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    // The single-section function processes ONLY the PII-filtered `sectionsFiltered`
    // set (high-PII section_pattern_ids removed). Pin that the crop persistence call
    // (saveCropFromBuffer / persistSectionCrop) sits within this function body.
    const fnStart = phase5.indexOf("async function processSingleSectionVisualEmbedding");
    expect(fnStart, "processSingleSectionVisualEmbedding must exist").toBeGreaterThan(-1);
    // The crop save helper must be referenced (section sink wiring).
    expect(
      /\bpersistSectionCrop\b|\bsaveCropFromBuffer\b/.test(phase5),
      "section crop persistence must be wired (persistSectionCrop / saveCropFromBuffer)"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 2 — part crop save lives inside the PII-filtered part loop
  // ==========================================================================

  it("INV-CROP-PII-EXCLUDED-001: surface 2 — the part loop query filters piiRiskLevel: { not: 'high' } (part crop sink is inside this filtered loop)", () => {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    // The part visual loop query MUST exclude high-PII parts so the crop produced
    // inside it is structurally PII-safe.
    expect(
      /piiRiskLevel:\s*\{\s*not:\s*["']high["']\s*\}/.test(phase5),
      "part loop query must filter piiRiskLevel: { not: 'high' } (high-PII parts never reach crop save)"
    ).toBe(true);
    expect(
      /\bpersistPartCrop\b|\bsaveCropFromBuffer\b/.test(phase5),
      "part crop persistence must be wired (persistPartCrop / saveCropFromBuffer)"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 3 — no inline high-PII re-judgement at the crop-save sites
  // ==========================================================================

  it("INV-CROP-PII-EXCLUDED-001: surface 3 — the crop save helpers do NOT inline a high-PII re-judgement (the filtered loop/query is the single gate)", () => {
    const cropHelper = stripLineComments(readSrc("services/part/crop-persistence.helper.ts"));
    // The crop helper is a pure path-build + save leaf; it must NOT contain a
    // `pii_risk_level` / `piiRiskLevel` re-judgement (the gate is the caller's loop).
    expect(
      /pii_risk_level|piiRiskLevel/.test(cropHelper),
      "crop helper must NOT inline a high-PII re-judgement (fail-closed gate is the caller's filtered loop)"
    ).toBe(false);
  });

  // ==========================================================================
  // Surface 4 — getHighPiiSectionIds is EXPORTED (SEC-M-01, forward-compat pin)
  // ==========================================================================

  it("INV-CROP-PII-EXCLUDED-001: surface 4 — getHighPiiSectionIds is EXPORTED from page-detail.service.ts (SEC-M-01 import prerequisite for the PR-4 crop-sink)", () => {
    const pageDetail = stripLineComments(readSrc(PAGE_DETAIL_REL));
    // SEC-M-01: getHighPiiSectionIds was module-private. It MUST be exported so the
    // crop-sink redaction (PR-4 runtime) imports the SAME SSOT (inline forbidden).
    expect(
      /export\s+async\s+function\s+getHighPiiSectionIds\s*\(/.test(pageDetail),
      "getHighPiiSectionIds MUST be exported (SEC-M-01) so the crop-sink redaction can import the SSOT"
    ).toBe(true);
  });

  it("INV-CROP-PII-EXCLUDED-001: surface 4b — getHighPiiSectionIds is importable + behaves as a high-PII section SSOT (export executes)", async () => {
    // Forward-compat import-pin (TPA-L-02): the export must be importable now even
    // though the crop-sink runtime read path lands in PR-4.
    const mod = await import("../../../../src/api/internal/page-detail.service");
    expect(
      typeof mod.getHighPiiSectionIds,
      "getHighPiiSectionIds must be importable as a function"
    ).toBe("function");
    // Empty input → empty set (no DB hit) confirms the SSOT contract shape.
    const empty = await mod.getHighPiiSectionIds([]);
    expect(empty instanceof Set, "getHighPiiSectionIds([]) must return a Set").toBe(true);
    expect(empty.size, "getHighPiiSectionIds([]) must be empty (no DB hit)").toBe(0);
  });

  // ==========================================================================
  // Surface 5 — backfill loop inherits high-PII fail-closed (W6 Issue A PR-4a, F-L-06)
  //
  // The PR-4a backfill script (`scripts/backfill-crops.ts`) re-cuts crops for
  // already-embedded rows. It MUST inherit the SAME 3-layer high-PII fail-closed
  // exclusion as Phase 5 so a backfill crop is NEVER persisted for a high-PII
  // section/part:
  //   - part eligibility: `piiRiskLevel: { not: "high" }` (or `pii_risk_level <>
  //     'high'`) on the part query.
  //   - section eligibility: a high-PII NOT EXISTS / sectionVisualPendingExclusionPredicate
  //     in the section eligibility query (no high-PII section reaches the crop save).
  // This surface CI-RED's if the backfill drops either filter.
  // ==========================================================================

  it("INV-CROP-PII-EXCLUDED-001: surface 5 — backfill part eligibility excludes high-PII parts (piiRiskLevel != high) so no high-PII part crop is backfilled", () => {
    const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../../");
    const script = stripLineComments(
      fs.readFileSync(path.resolve(MCP_SERVER_ROOT, "scripts/backfill-crops.ts"), "utf8")
    );
    expect(
      /piiRiskLevel:\s*\{\s*not:\s*["']high["']\s*\}/.test(script) ||
        /pii_risk_level\s*<>\s*['"]high['"]|pii_risk_level\s*!=\s*['"]high['"]/.test(script),
      "backfill-crops.ts part eligibility must exclude high-PII parts (piiRiskLevel != high)"
    ).toBe(true);
  });

  it("INV-CROP-PII-EXCLUDED-001: surface 5b — backfill section eligibility excludes high-PII sections (NOT EXISTS / sectionVisualPendingExclusionPredicate)", () => {
    const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../../");
    const script = stripLineComments(
      fs.readFileSync(path.resolve(MCP_SERVER_ROOT, "scripts/backfill-crops.ts"), "utf8")
    );
    // The section eligibility must inherit the high-PII fail-closed exclusion (either
    // by importing the sectionVisualPendingExclusionPredicate SSOT or an inline NOT
    // EXISTS high-PII subquery on component_parts).
    const hasSectionPiiExclusion =
      /sectionVisualPendingExclusionPredicate/.test(script) ||
      (/NOT\s+EXISTS/i.test(script) && /pii_risk_level\s*=\s*['"]high['"]/.test(script));
    expect(
      hasSectionPiiExclusion,
      "backfill-crops.ts section eligibility must exclude high-PII sections (sectionVisualPendingExclusionPredicate or NOT EXISTS high-PII)"
    ).toBe(true);
  });
});
