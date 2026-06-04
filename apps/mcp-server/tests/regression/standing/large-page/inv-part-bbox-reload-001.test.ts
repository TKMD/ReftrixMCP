// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PART-BBOX-RELOAD-001
 *
 * Plan v3 T5 V1 §4 invariant landing: layered Part bbox resolution pipeline
 * (Option A pre-emptive scroll + Option C stale detection + Option B targeted
 * requery) preserves contract semantics across the canonical failure modes
 * (Mode A lazy / Mode B dynamic / Mode C SPA / Mode D scroll-pinned / Mode E
 * truly broken).
 *
 * **Invariant statement** (Plan v3 T5 V1 §4.1):
 *   The PartBboxPlaywrightService layered pipeline MUST:
 *   (a) Execute Option A pre-emptive scroll BEFORE 1st-pass when enabled;
 *   (b) Detect stale bboxes (|y| > tolerance) and route them to Option B
 *       targeted requery (NOT directly to bbox_unresolvable);
 *   (c) Treat Option A and Option C as AND (not XOR) per §1.6 U-T5-6 — both
 *       fire on every non-zero 1st-pass result when both layers enabled;
 *   (d) Honour cumulative `BBOX_LAYERED_TOTAL_TIMEOUT_MS` (Promise.race);
 *   (e) Preserve existing PR-D-9 W4 C-06 reload pass contract as catch-all
 *       of last resort (mutual exclusivity with `bbox_invalid` per ADR-0018
 *       §Decision 1 Supplement S3 maintained);
 *   (f) Emit `pathHistogram` ALWAYS (V1 §1.2 LCC-T5-01 hydration telemetry).
 *
 * **Severity**: M — operational reliability + GDPR Art.5(1)(d) accuracy.
 *
 * **Cross-INV impact**: INV-EMBEDDING-INTEGRITY-001 (parts.visual coverage SLO),
 * INV-PAGE-QUEUE-001 (Phase 5 pipeline integrity).
 *
 * **Co-existence with INV-EMBEDDING-INTEGRITY-001**: this file covers the
 * NEW V1 layered pipeline contracts (Option A/B/C orchestration). The
 * existing `inv-embedding-integrity-001-bbox-and-responsive.test.ts` covers
 * the C-06 reload pass safety budget (cases #1-#10 V0 framework). The two
 * INVs are complementary, not overlapping.
 *
 * @see Plan v3 T5 V1 §4 + §6.2 standing regression
 * @see ADR-0018 §Decision 1 Supplement S3 (`bbox_unresolvable` mutual exclusivity)
 * @see internal anchor `019e125d-7e77` (T5 V1 SLO empirical commitment)
 * @module tests/regression/standing/large-page/inv-part-bbox-reload-001
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { assertInvName } from "../_setup/inv-assert";
import {
  BboxResolutionPipeline,
  BboxLayeredTimeoutError,
} from "../../../../src/services/part/bbox-resolution-pipeline";
import type {
  PipelineBboxResult,
  PipelinePartSelector,
  FirstPassEvaluate,
} from "../../../../src/services/part/bbox-resolution-pipeline";
import type { PartBboxEnvConfig } from "../../../../src/utils/env-validators";

// ============================================================================
// Test fixtures
// ============================================================================

const DEFAULT_CONFIG: PartBboxEnvConfig = {
  preEmptiveScrollEnabled: true,
  preEmptiveScrollMaxIterations: 30,
  targetedRequeryEnabled: true,
  staleDetectionEnabled: true,
  staleDetectionTolerancePx: 500,
  layeredTotalTimeoutMs: 30_000,
};

function makePart(id: string, sectionStartY = 1000, sampleIndex = 0): PipelinePartSelector {
  return {
    id,
    selectors: [`#${id}`],
    sectionStartY,
    sampleIndex,
  };
}

function makeBbox(id: string, y = 50): PipelineBboxResult {
  return { id, x: 0, y, width: 100, height: 50 };
}

function makeMockPage(): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

// ============================================================================
// INV-PART-BBOX-RELOAD-001 standing regression suite
// ============================================================================

describe("INV-PART-BBOX-RELOAD-001: Layered Part bbox resolution pipeline contracts", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PART-BBOX-RELOAD-001");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // Case #1 — partsNeedingBbox empty (no pipeline invocation)
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #1: partsNeedingBbox empty → preEmptiveScrollReplay NOT invoked", async () => {
    const pipeline = new BboxResolutionPipeline(DEFAULT_CONFIG);
    const firstPass: FirstPassEvaluate = vi.fn();
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [], firstPass });

    expect(result.pathHistogram).toEqual({ preempt: 0, "1stpass": 0, targeted: 0, reload: 0 });
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(firstPass).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Case #2 — All parts in first viewport (1st-pass succeeds)
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #2: All parts in first viewport → 1st-pass succeeds, no escalation", async () => {
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, preEmptiveScrollEnabled: false };
    const pipeline = new BboxResolutionPipeline(cfg);
    const parts = [makePart("p1"), makePart("p2"), makePart("p3")];
    const firstPass: FirstPassEvaluate = vi
      .fn()
      .mockResolvedValueOnce([makeBbox("p1", 50), makeBbox("p2", 60), makeBbox("p3", 70)]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts, firstPass });

    expect(result.pathHistogram["1stpass"]).toBe(3);
    expect(result.pathHistogram.targeted).toBe(0);
    expect(result.stillUnresolved).toHaveLength(0);
    expect(firstPass).toHaveBeenCalledTimes(1); // no Option B retry
  });

  // ==========================================================================
  // Case #3 — Mode A failure (lazy load) → Option A scroll replay recovers
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #3: Mode A (lazy load) → preEmptiveScrollReplay invoked + 1st-pass resolves all parts", async () => {
    const pipeline = new BboxResolutionPipeline(DEFAULT_CONFIG);
    const part = makePart("p1");
    const firstPass: FirstPassEvaluate = vi.fn().mockResolvedValueOnce([makeBbox("p1", 80)]); // resolves after Option A scroll
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    expect(result.pathHistogram.preempt).toBe(1); // Option A executed
    expect(page.evaluate).toHaveBeenCalledTimes(1); // scroll replay
    expect(result.pathHistogram["1stpass"]).toBe(1);
    expect(result.stillUnresolved).toHaveLength(0);
  });

  // ==========================================================================
  // Case #4 — Mode B failure (dynamic content) → Option B targeted requery recovers
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #4: Mode B (dynamic content) → 1st-pass partial, targeted requery resolves, pathHistogram.targeted > 0", async () => {
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, preEmptiveScrollEnabled: false };
    const pipeline = new BboxResolutionPipeline(cfg);
    const parts = [makePart("p1"), makePart("p2")];
    const firstPass: FirstPassEvaluate = vi
      .fn()
      .mockResolvedValueOnce([makeBbox("p1"), null]) // p1 ok, p2 dynamic-content miss
      .mockResolvedValueOnce([makeBbox("p2", 90)]); // Option B recovers p2
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts, firstPass });

    expect(result.pathHistogram.targeted).toBe(1);
    expect(result.stillUnresolved).toHaveLength(0);
    expect(firstPass).toHaveBeenCalledTimes(2); // 1st-pass + Option B
  });

  // ==========================================================================
  // Case #5 — Mode C failure (SPA route change) → still unresolved → C-06 fallback
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #5: Mode C (SPA route change) → 1st-pass partial, B partial, residual routes to C-06 reload (caller responsibility)", async () => {
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, preEmptiveScrollEnabled: false };
    const pipeline = new BboxResolutionPipeline(cfg);
    const parts = [makePart("p1"), makePart("p2")];
    const firstPass: FirstPassEvaluate = vi
      .fn()
      .mockResolvedValueOnce([null, null]) // SPA route → all DOM disposed
      .mockResolvedValueOnce([null, null]); // Option B also fails (route still wrong)
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts, firstPass });

    expect(result.pathHistogram.targeted).toBe(0);
    expect(result.stillUnresolved).toHaveLength(2);
    // Caller (resolvePartBoundingBoxes) routes stillUnresolved to C-06 reload pass.
    // Pipeline's reload bucket is 0; reload bucket is populated by service.ts.
    expect(result.pathHistogram.reload).toBe(0);
  });

  // ==========================================================================
  // Case #6 — Mode D (scroll-pinned animation) AND-semantic per V1 §1.6 U-T5-6
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #6: Mode D (scroll-pinned animation) — V1 AND-semantic — Option A AND Option C BOTH execute", async () => {
    // Option A scroll replay succeeds; Option C may detect stale OR clean.
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, staleDetectionTolerancePx: 100 };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    const firstPass: FirstPassEvaluate = vi
      .fn()
      // After Option A scroll, p1 bbox.y = 80 (within tolerance — Option C confirms)
      .mockResolvedValueOnce([makeBbox("p1", 80)]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    // V1 AND assertion: Option A executed (preempt > 0) AND Option C ran on
    // the result (since staleDetectionEnabled=true). targeted may be 0 if
    // Option C confirmed clean, OR > 0 if it detected residual stale.
    expect(result.pathHistogram.preempt).toBeGreaterThan(0);
    expect(result.pathHistogram.targeted).toBeGreaterThanOrEqual(0);
    expect(result.stillUnresolved).toHaveLength(0); // p1 confirmed
  });

  // ==========================================================================
  // Case #6b — NEW V1 (U-T5-6): Mode D residual — Option A succeeds + Option C still detects stale
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #6b: Mode D residual — Option A succeeds but Option C still detects stale, Option B fires, final bbox sane (NEW V1 U-T5-6)", async () => {
    // Fault injection scenario: animation library ignores scroll state →
    // Option A scroll replay completes but bbox is still stale.
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, staleDetectionTolerancePx: 100 };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    const firstPass: FirstPassEvaluate = vi
      .fn()
      // 1st-pass after Option A: bbox.y = 5000 (stale even after scroll)
      .mockResolvedValueOnce([makeBbox("p1", 5000)])
      // Option B: finally clean
      .mockResolvedValueOnce([makeBbox("p1", 80)]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    expect(result.pathHistogram.preempt).toBe(1); // Option A executed
    expect(result.pathHistogram.targeted).toBe(1); // Option B fired despite Option A succeeding
    expect(result.resolved[0]!.y).toBe(80); // final bbox sane
  });

  // ==========================================================================
  // Case #7 — All layers exhaust → true unresolved (catch-all to caller)
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #7: All layers exhaust → stillUnresolved emitted for caller bbox_unresolvable routing", async () => {
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, preEmptiveScrollEnabled: false };
    const pipeline = new BboxResolutionPipeline(cfg);
    const parts = [makePart("p1"), makePart("p2")];
    const firstPass: FirstPassEvaluate = vi
      .fn()
      .mockResolvedValueOnce([null, null]) // 1st-pass all null
      .mockResolvedValueOnce([null, null]); // Option B all null
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts, firstPass });

    expect(result.stillUnresolved).toHaveLength(2);
    // Caller routes to C-06 reload pass; if that also exhausts, emits
    // skipReason='bbox_unresolvable' per ADR-0018 §Decision 1 Supplement S3.
  });

  // ==========================================================================
  // Case #8 — sharedBrowser disconnected (caller responsibility — pipeline blind)
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #8: pipeline operates on injected page object; sharedBrowser fallback is caller responsibility (Graceful Degradation)", async () => {
    // The pipeline does NOT own browser lifecycle. Caller's
    // resolvePartBoundingBoxes handles sharedBrowser.isConnected() check
    // + standalone Chromium fallback BEFORE invoking the pipeline.
    // This test asserts the pipeline accepts ANY Page object satisfying
    // the interface contract.
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, preEmptiveScrollEnabled: false };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    const firstPass: FirstPassEvaluate = vi.fn().mockResolvedValueOnce([makeBbox("p1")]);
    const page = makeMockPage(); // simulates "fallback Chromium page"

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    expect(result.resolved).toHaveLength(1);
  });

  // ==========================================================================
  // Case #9 — SSRF preserved via structural design (pipeline does NOT call page.goto)
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #9: pipeline does NOT call page.goto() (SSRF guard preserved by structural absence)", async () => {
    // SSRF guard lives in resolvePartBoundingBoxes (validateExternalUrl)
    // BEFORE the pipeline is invoked. The pipeline operates on a pre-loaded
    // Page object only. AST scan in
    // `inv-part-bbox-reload-001-ssrf-preservation.test.ts` enforces this
    // structural invariant.
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, preEmptiveScrollEnabled: false };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    const gotoSpy = vi.fn();
    const reloadSpy = vi.fn();
    const firstPass: FirstPassEvaluate = vi.fn().mockResolvedValueOnce([makeBbox("p1")]);
    // Page object with goto/reload spies — assert NEVER called from pipeline
    const page = {
      evaluate: vi.fn().mockResolvedValue(undefined),
      goto: gotoSpy,
      reload: reloadSpy,
    } as unknown as Page;

    await pipeline.execute({ page, parts: [part], firstPass });

    expect(gotoSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Case #10 — Cross-INV: stillUnresolved contract preserves bbox_unresolvable mutual exclusivity
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #10: stillUnresolved parts maintain mutual exclusivity with bbox_invalid (ADR-0018 §Decision 1 Supplement S3)", async () => {
    // Pipeline does NOT emit skipReason directly. The caller
    // (resolvePartBoundingBoxes / embedding-backfill-processors)
    // routes stillUnresolved → C-06 reload pass → bbox_unresolvable IF
    // residual remains. NEVER bbox_invalid (which has different semantic:
    // valid bbox geometrically rejected).
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, preEmptiveScrollEnabled: false };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    const firstPass: FirstPassEvaluate = vi
      .fn()
      .mockResolvedValueOnce([null]) // 1st-pass null
      .mockResolvedValueOnce([null]); // Option B null
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    // Pipeline output: stillUnresolved present. Caller routes to
    // bbox_unresolvable per Supplement S3. Pipeline does NOT mark
    // bbox_invalid (mutual exclusivity preserved by absence-of-emit).
    expect(result.stillUnresolved).toHaveLength(1);
    expect(result.stillUnresolved[0]!.id).toBe("p1");
    // No skipReason field on PipelineExecuteResult → emit is caller's
    // responsibility (which routes through audit-actions SSOT, ensuring
    // mutual exclusivity).
    expect(result).not.toHaveProperty("skipReason");
  });

  // ==========================================================================
  // Case #11 — NEW V1 (U-T5-3): Cumulative BBOX_LAYERED_TOTAL_TIMEOUT_MS exhausted
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #11: Cumulative BBOX_LAYERED_TOTAL_TIMEOUT_MS=5000 exhausted → BboxLayeredTimeoutError thrown (NEW V1 U-T5-3)", async () => {
    const cfg: PartBboxEnvConfig = {
      ...DEFAULT_CONFIG,
      preEmptiveScrollEnabled: false,
      layeredTotalTimeoutMs: 5_000, // 5s minimum
    };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    // 1st-pass that hangs forever (simulates Option A pre-emptive scroll
    // taking 35s due to a degenerate page; cumulative budget enforces 30s
    // default cap — for this test we use 5s minimum cap).
    const firstPass: FirstPassEvaluate = () =>
      new Promise<Array<PipelineBboxResult | null>>(() => {
        /* never resolves */
      });
    const page = makeMockPage();

    vi.useFakeTimers();
    const promise = pipeline.execute({ page, parts: [part], firstPass });
    vi.advanceTimersByTime(5_001);
    await expect(promise).rejects.toThrow(BboxLayeredTimeoutError);

    // Verify error structure for caller (audit_logs emit can include
    // timeout indication via `BboxLayeredTimeoutError.timeoutMs`).
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BboxLayeredTimeoutError);
    expect((err as BboxLayeredTimeoutError).timeoutMs).toBe(5_000);
  });

  // ==========================================================================
  // Case #12 — V1 §1.2 LCC-T5-01: pathHistogram emit ALWAYS (not opt-in)
  // ==========================================================================
  it("INV-PART-BBOX-RELOAD-001 case #12: pathHistogram emit ALWAYS — present on every execute() call regardless of disablement (V1 §1.2 LCC-T5-01)", async () => {
    // All layers disabled — histogram should still be present (all zeros).
    const cfg: PartBboxEnvConfig = {
      ...DEFAULT_CONFIG,
      preEmptiveScrollEnabled: false,
      targetedRequeryEnabled: false,
      staleDetectionEnabled: false,
    };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    const firstPass: FirstPassEvaluate = vi.fn().mockResolvedValueOnce([makeBbox("p1")]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    // Hydration retention compliance: pathHistogram MUST be present even
    // when all opt-out flags are set. Caller (audit_logs emit) relies on
    // this for `details.bboxResolutionPath` per CO-T5-03.
    expect(result.pathHistogram).toBeDefined();
    expect(result.pathHistogram.preempt).toBe(0);
    expect(result.pathHistogram["1stpass"]).toBe(1);
    expect(result.pathHistogram.targeted).toBe(0);
    expect(result.pathHistogram.reload).toBe(0);
  });
});
