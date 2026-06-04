// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PHASE5-SUBPHASE-FORK-EXIT-001
 *
 * PR-BT-5 (M-1-RSS, ADR-0039 Decision 1, unblock #6 / #8). Verifies the
 * per-sub-phase fork lifecycle contract surface:
 *
 *   1. **Fork-count cap (CWE-770, SEC-M-02 / unblock #8)**: the number of forks
 *      dispatched per page is bounded by the static sub-phase enumeration (≤ 9),
 *      **data-row-count-INDEPENDENT**. A large/hostile page (more parts /
 *      sections) cannot induce unbounded fork spawning because the descriptor
 *      count is fixed at `PHASE5_TEXT_SUBPHASES.length + PHASE5_VISUAL_SUBPHASES.length`.
 *
 *   2. **Sequential per-sub-phase lifecycle (each fork = 1 sub-phase → exit)**:
 *      each descriptor maps to a single sub-phase + workload (no descriptor
 *      bundles multiple sub-phases). Empty sub-phases are skipped (shouldRun
 *      false → no fork).
 *
 *   3. **Audit-continuity (LCC-M-01 / unblock #6)**: the 2 audit emit paths that
 *      the orchestrator already carries — PR-V3-T1a per-chunk RSS overshoot
 *      (`emitChunkedEncoderTelemetryAudit`) and `embedding_cpu_fallback_degraded`
 *      (`resolveProviderAndAuditDegraded` → AUDIT_ACTION_EMBEDDING_CPU_FALLBACK_DEGRADED)
 *      — are PRESERVED across the N-fork loop restructure (GDPR Art.30 audit
 *      continuity, not silently dropped). Source-pinned here.
 *
 * a CI-failing executable invariant. `.skip()` / `.todo()` are forbidden; any
 * failure is a P0 incident. The real fork + ONNX harness is out of scope for CI
 * runtime (it runs in the §5.3 real-machine merge gate); this exercises the
 * deterministic dispatch-decision + audit-continuity contract surface (same
 * approach as inv-phase5-rss-budget-001).
 *
 * @see  Decision 1 / §Security / §Neutral
 * @see src/workers/phases/phase-5-subphase-dispatch.ts (descriptor builders)
 * @see src/workers/phases/phase-5-fork-orchestrator.ts (loop + audit emit)
 * @module tests/regression/standing/large-page/inv-phase5-subphase-fork-exit-001
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  buildTextSubPhaseDescriptors,
  buildVisualSubPhaseDescriptors,
} from "../../../../src/workers/phases/phase-5-subphase-dispatch";
import {
  PHASE5_TEXT_SUBPHASES,
  PHASE5_VISUAL_SUBPHASES,
  PHASE5_TOTAL_SUBPHASE_FORK_COUNT,
} from "../../../../src/workers/phases/phase-5-subphases.const";
import type { EmbeddingPhaseParams } from "../../../../src/workers/phases/types";
import { assertInvName } from "../_setup/inv-assert";

/**
 * Build a minimal `EmbeddingPhaseParams` exercising data presence for ALL
 * sub-phases. Only the data-presence fields read by the descriptor builders are
 * populated; the rest are cast (the builders never read them).
 *
 * @param partCount  number of parts (used to prove fork count is part-COUNT-independent)
 * @param sectionCount  number of sections
 */
function buildParamsWithData(partCount: number, sectionCount: number): EmbeddingPhaseParams {
  const sectionMapping = new Map<string, string>();
  for (let i = 0; i < sectionCount; i++) sectionMapping.set(`s${i}`, `db-s${i}`);
  return {
    webPageId: "00000000-0000-0000-0000-000000000000",
    url: "https://example.com",
    sectionSaveResult: { idMapping: sectionMapping } as never,
    motionSaveResult: { idMapping: new Map([["m0", "db-m0"]]) } as never,
    jsSaveResult: { idMapping: new Map([["j0", "db-j0"]]) } as never,
    bgSaveResult: { ids: ["bg0"] } as never,
    scrollVisionSaveResult: { idMapping: new Map([["v0", "db-v0"]]) } as never,
    responsiveAnalysisId: "resp-0",
    partsSavedCount: partCount,
  } as unknown as EmbeddingPhaseParams;
}

/** Build params with ZERO embeddable data (all sub-phases skipped). */
function buildEmptyParams(): EmbeddingPhaseParams {
  return {
    webPageId: "00000000-0000-0000-0000-000000000000",
    url: "https://example.com",
    sectionSaveResult: null,
    motionSaveResult: null,
    jsSaveResult: null,
    bgSaveResult: null,
    scrollVisionSaveResult: null,
    responsiveAnalysisId: undefined,
    partsSavedCount: 0,
  } as unknown as EmbeddingPhaseParams;
}

describe("INV-PHASE5-SUBPHASE-FORK-EXIT-001: per-sub-phase fork lifecycle + count cap + audit-continuity", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PHASE5-SUBPHASE-FORK-EXIT-001");
  });

  describe("fork-count cap (CWE-770, data-independent)", () => {
    it("INV-PHASE5-SUBPHASE-FORK-EXIT-001: total fork count cap is the static sub-phase enumeration (= 9, ≤ 9)", () => {
      expect(PHASE5_TOTAL_SUBPHASE_FORK_COUNT).toBe(9);
      expect(PHASE5_TOTAL_SUBPHASE_FORK_COUNT).toBeLessThanOrEqual(9);
      expect(PHASE5_TEXT_SUBPHASES.length + PHASE5_VISUAL_SUBPHASES.length).toBe(
        PHASE5_TOTAL_SUBPHASE_FORK_COUNT
      );
    });

    it("INV-PHASE5-SUBPHASE-FORK-EXIT-001: descriptor count is INDEPENDENT of data row count (1 part vs 100000 parts → identical fork count)", () => {
      // CWE-770: a large/hostile page cannot induce more forks. The descriptor
      // count is fixed; only `shouldRun` (presence) varies, never the count.
      const small = buildParamsWithData(1, 1);
      const huge = buildParamsWithData(100_000, 5_000);

      const smallText = buildTextSubPhaseDescriptors(small);
      const hugeText = buildTextSubPhaseDescriptors(huge);
      const smallVisual = buildVisualSubPhaseDescriptors(small);
      const hugeVisual = buildVisualSubPhaseDescriptors(huge);

      // Descriptor COUNT is identical regardless of data magnitude.
      expect(smallText.length).toBe(hugeText.length);
      expect(smallVisual.length).toBe(hugeVisual.length);
      expect(smallText.length).toBe(PHASE5_TEXT_SUBPHASES.length);
      expect(smallVisual.length).toBe(PHASE5_VISUAL_SUBPHASES.length);

      // The number of forks that would actually be dispatched (shouldRun=true) is
      // also bounded by 9 regardless of part count.
      const dispatchedCount =
        hugeText.filter((d) => d.shouldRun).length + hugeVisual.filter((d) => d.shouldRun).length;
      expect(dispatchedCount).toBeLessThanOrEqual(PHASE5_TOTAL_SUBPHASE_FORK_COUNT);
    });

    it("INV-PHASE5-SUBPHASE-FORK-EXIT-001: empty page dispatches ZERO forks (all sub-phases skipped)", () => {
      const empty = buildEmptyParams();
      const text = buildTextSubPhaseDescriptors(empty);
      const visual = buildVisualSubPhaseDescriptors(empty);
      const dispatched =
        text.filter((d) => d.shouldRun).length + visual.filter((d) => d.shouldRun).length;
      expect(dispatched).toBe(0);
    });
  });

  describe("sequential per-sub-phase lifecycle (1 fork = 1 sub-phase)", () => {
    it("INV-PHASE5-SUBPHASE-FORK-EXIT-001: each text descriptor maps to a single distinct sub-phase + 'text' workload", () => {
      const descriptors = buildTextSubPhaseDescriptors(buildParamsWithData(10, 10));
      // Every descriptor is exactly one sub-phase (no bundling).
      const subPhases = descriptors.map((d) => d.subPhase);
      expect(new Set(subPhases).size).toBe(descriptors.length);
      expect(subPhases).toEqual([...PHASE5_TEXT_SUBPHASES]); // declaration = dispatch order
      for (const d of descriptors) expect(d.workload).toBe("text");
    });

    it("INV-PHASE5-SUBPHASE-FORK-EXIT-001: each visual descriptor maps to a single distinct sub-phase + 'visual' workload", () => {
      const descriptors = buildVisualSubPhaseDescriptors(buildParamsWithData(10, 10));
      const subPhases = descriptors.map((d) => d.subPhase);
      expect(new Set(subPhases).size).toBe(descriptors.length);
      expect(subPhases).toEqual([...PHASE5_VISUAL_SUBPHASES]);
      for (const d of descriptors) expect(d.workload).toBe("visual");
    });

    it("INV-PHASE5-SUBPHASE-FORK-EXIT-001: text + visual sub-phase identifiers do NOT overlap (no fork processes two sub-phases)", () => {
      const all = [...PHASE5_TEXT_SUBPHASES, ...PHASE5_VISUAL_SUBPHASES];
      expect(new Set(all).size).toBe(all.length);
    });
  });

  describe("audit-continuity (LCC-M-01, GDPR Art.30): 2 audit emit paths preserved across N-fork loop", () => {
    let orchestratorSource: string;

    beforeAll(() => {
      const abs = path.resolve(
        __dirname,
        "../../../../src/workers/phases/phase-5-fork-orchestrator.ts"
      );
      orchestratorSource = fs.readFileSync(abs, "utf8");
    });

    it("INV-PHASE5-SUBPHASE-FORK-EXIT-001: per-chunk RSS overshoot audit (emitChunkedEncoderTelemetryAudit) is still invoked in the loop", () => {
      // LCC-M-01: the PR-V3-T1a per-chunk RSS overshoot / partial-completion
      // audit emission must NOT be silently dropped by the N-fork restructure.
      // The text result merge invokes it; assert the invocation survives.
      expect(
        orchestratorSource,
        `phase-5-fork-orchestrator.ts must still invoke \`emitChunkedEncoderTelemetryAudit\` ` +
          `in the per-sub-phase text merge path (GDPR Art.30 audit continuity, LCC-M-01).`
      ).toMatch(/emitChunkedEncoderTelemetryAudit\(/);
    });

    it("INV-PHASE5-SUBPHASE-FORK-EXIT-001: cpu_fallback_degraded audit (resolveProviderAndAuditDegraded) is invoked per sub-phase fork", () => {
      // LCC-M-01: the embedding_cpu_fallback_degraded audit emit path must be
      // preserved. In the per-sub-phase model it is called per fork (text + visual
      // sub-phase fork helpers), so it appears in both fork dispatchers.
      const matches = orchestratorSource.match(/resolveProviderAndAuditDegraded\(/g) ?? [];
      expect(
        matches.length,
        `phase-5-fork-orchestrator.ts must invoke \`resolveProviderAndAuditDegraded\` ` +
          `in the per-sub-phase fork dispatch path (preserves embedding_cpu_fallback_degraded ` +
          `audit emission per fork, LCC-M-01 / PR-1 GPU-COORD). Found ${matches.length}.`
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
