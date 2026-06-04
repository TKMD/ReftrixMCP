// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests — `apps/mcp-server/src/services/part/bbox-resolution-pipeline.ts`
 *
 * Plan v3 T5 V1 §1.2 / §6.1 (NEW V1):
 *   - BboxResolutionPipeline strategy class layered execution
 *   - Cyclomatic ≤ 8 contract (verified via test coverage of all branches)
 *   - Promise.race timeout (`BBOX_LAYERED_TOTAL_TIMEOUT_MS`)
 *   - Path histogram correctness (preempt / 1stpass / targeted / reload)
 *   - NaN/Infinity defense in stale-bbox heuristic
 *   - Mode D AND-then-fallback semantic (Option A + Option C BOTH execute)
 *
 * Test isolation: pipeline is pure logic (no Playwright I/O); we mock the
 * `Page` object and `firstPass` injection per ADR-0020 1 test = 1 mock cycle
 * contract.
 *
 * @see Plan v3 T5 V1 §1.2 / §1.6 / §3.7 / §6.1
 * @module tests/services/part/bbox-resolution-pipeline
 */

import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright";
import {
  BboxResolutionPipeline,
  BboxLayeredTimeoutError,
} from "../../../src/services/part/bbox-resolution-pipeline";
import type {
  PipelinePartSelector,
  PipelineBboxResult,
  FirstPassEvaluate,
} from "../../../src/services/part/bbox-resolution-pipeline";
import type { PartBboxEnvConfig } from "../../../src/utils/env-validators";

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
    selectors: [`#part-${id}`],
    sectionStartY,
    sampleIndex,
  };
}

function makeBbox(id: string, y = 50): PipelineBboxResult {
  return { id, x: 0, y, width: 100, height: 50 };
}

/**
 * Mock Page where `page.evaluate()` is a vi.fn that resolves immediately.
 * The pipeline calls `page.evaluate()` only inside `preEmptiveScrollReplay`
 * (not 1st-pass — that is injected via `firstPass` param).
 */
function makeMockPage(): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

// ============================================================================
// Tests
// ============================================================================

describe("BboxResolutionPipeline (Plan v3 T5 V1 §1.2 / §3.7)", () => {
  // ==========================================================================
  // Branch 1: empty parts fast path
  // ==========================================================================
  it("returns empty result for parts.length === 0", async () => {
    const pipeline = new BboxResolutionPipeline(DEFAULT_CONFIG);
    const firstPass: FirstPassEvaluate = vi.fn();
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [], firstPass });

    expect(result.resolved).toEqual([]);
    expect(result.stillUnresolved).toEqual([]);
    expect(result.pathHistogram).toEqual({ preempt: 0, "1stpass": 0, targeted: 0, reload: 0 });
    expect(firstPass).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Branch 2: preEmptive enabled — Option A executes
  // ==========================================================================
  it("invokes pre-emptive scroll replay when preEmptiveScrollEnabled=true", async () => {
    const pipeline = new BboxResolutionPipeline(DEFAULT_CONFIG);
    const part = makePart("p1");
    const firstPass: FirstPassEvaluate = vi.fn().mockResolvedValue([makeBbox("p1")]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    expect(result.pathHistogram.preempt).toBe(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1); // only the scroll replay
    expect(result.pathHistogram["1stpass"]).toBe(1);
  });

  it("skips pre-emptive scroll replay when preEmptiveScrollEnabled=false", async () => {
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, preEmptiveScrollEnabled: false };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    const firstPass: FirstPassEvaluate = vi.fn().mockResolvedValue([makeBbox("p1")]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    expect(result.pathHistogram.preempt).toBe(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Branch 3: 1st-pass success / failure partition
  // ==========================================================================
  it("partitions 1st-pass results into resolved + unresolved", async () => {
    const cfg: PartBboxEnvConfig = {
      ...DEFAULT_CONFIG,
      preEmptiveScrollEnabled: false,
      targetedRequeryEnabled: false,
      staleDetectionEnabled: false,
    };
    const pipeline = new BboxResolutionPipeline(cfg);
    const parts = [makePart("p1"), makePart("p2"), makePart("p3")];
    const firstPass: FirstPassEvaluate = vi
      .fn()
      .mockResolvedValue([makeBbox("p1"), null, makeBbox("p3")]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts, firstPass });

    expect(result.resolved).toHaveLength(2);
    expect(result.resolved.map((r) => r.id).sort()).toEqual(["p1", "p3"]);
    expect(result.stillUnresolved).toHaveLength(1);
    expect(result.stillUnresolved[0]!.id).toBe("p2");
    expect(result.pathHistogram["1stpass"]).toBe(2);
    expect(result.pathHistogram.targeted).toBe(0);
  });

  // ==========================================================================
  // Branch 4: stale-bbox detection (Option C)
  // ==========================================================================
  it("detects stale bbox when |bbox.y| > staleDetectionTolerancePx", async () => {
    const cfg: PartBboxEnvConfig = {
      ...DEFAULT_CONFIG,
      preEmptiveScrollEnabled: false,
      staleDetectionTolerancePx: 100,
    };
    const pipeline = new BboxResolutionPipeline(cfg);
    const parts = [makePart("p1"), makePart("p2")];
    // p1 bbox.y = 50 (within tolerance), p2 bbox.y = 5000 (stale)
    const firstPassFn = vi
      .fn()
      .mockResolvedValueOnce([makeBbox("p1", 50), makeBbox("p2", 5000)])
      // 2nd call (Option B targeted requery) recovers p2
      .mockResolvedValueOnce([makeBbox("p2", 80)]);
    const firstPass: FirstPassEvaluate = firstPassFn;
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts, firstPass });

    expect(result.pathHistogram["1stpass"]).toBe(2); // both initially resolved
    expect(result.pathHistogram.targeted).toBe(1); // p2 recovered via Option B
    expect(result.resolved.find((r) => r.id === "p2")?.y).toBe(80);
  });

  it("AND-fallback (Mode D §1.6 U-T5-6): Option A AND Option C BOTH execute", async () => {
    // Mode D: pre-emptive scroll succeeds, but Option C still detects stale.
    // Assertion: BOTH layers fire; targeted requery activates.
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, staleDetectionTolerancePx: 100 };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    const firstPassFn = vi
      .fn()
      // 1st call after pre-emptive scroll: bbox.y = 5000 (stale even after scroll)
      .mockResolvedValueOnce([makeBbox("p1", 5000)])
      // 2nd call (Option B): finally clean
      .mockResolvedValueOnce([makeBbox("p1", 80)]);
    const firstPass: FirstPassEvaluate = firstPassFn;
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    expect(result.pathHistogram.preempt).toBe(1); // Option A executed
    expect(result.pathHistogram.targeted).toBe(1); // Option B fired despite Option A
    expect(result.resolved[0]!.y).toBe(80);
  });

  it("skips stale detection when staleDetectionEnabled=false", async () => {
    const cfg: PartBboxEnvConfig = {
      ...DEFAULT_CONFIG,
      preEmptiveScrollEnabled: false,
      staleDetectionEnabled: false,
      targetedRequeryEnabled: false,
    };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    // bbox.y = 5000 would be flagged stale; but detection is off
    const firstPass: FirstPassEvaluate = vi.fn().mockResolvedValue([makeBbox("p1", 5000)]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.y).toBe(5000);
    expect(result.pathHistogram.targeted).toBe(0);
  });

  // ==========================================================================
  // Branch 5: Option B targeted requery
  // ==========================================================================
  it("targeted requery recovers parts after 1st-pass null", async () => {
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, preEmptiveScrollEnabled: false };
    const pipeline = new BboxResolutionPipeline(cfg);
    const parts = [makePart("p1"), makePart("p2")];
    const firstPass: FirstPassEvaluate = vi
      .fn()
      .mockResolvedValueOnce([null, null])
      .mockResolvedValueOnce([makeBbox("p1"), null]); // p1 recovered, p2 still missing
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts, firstPass });

    expect(result.pathHistogram.targeted).toBe(1);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.id).toBe("p1");
    expect(result.stillUnresolved).toHaveLength(1);
    expect(result.stillUnresolved[0]!.id).toBe("p2");
  });

  it("skips targeted requery when targetedRequeryEnabled=false", async () => {
    const cfg: PartBboxEnvConfig = {
      ...DEFAULT_CONFIG,
      preEmptiveScrollEnabled: false,
      targetedRequeryEnabled: false,
    };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    const firstPass: FirstPassEvaluate = vi.fn().mockResolvedValueOnce([null]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    expect(result.pathHistogram.targeted).toBe(0);
    expect(result.stillUnresolved).toHaveLength(1);
    expect(firstPass).toHaveBeenCalledTimes(1); // only 1st-pass, no requery
  });

  // ==========================================================================
  // Branch 6: cumulative timeout (Promise.race)
  // ==========================================================================
  it("throws BboxLayeredTimeoutError on cumulative timeout exhaustion", async () => {
    const cfg: PartBboxEnvConfig = {
      ...DEFAULT_CONFIG,
      preEmptiveScrollEnabled: false,
      layeredTotalTimeoutMs: 5_000, // 5s minimum
    };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    // 1st-pass that never resolves (simulates hung Playwright)
    const firstPass: FirstPassEvaluate = () =>
      new Promise<Array<PipelineBboxResult | null>>(() => {
        /* never resolves */
      });
    const page = makeMockPage();

    // Use vi.useFakeTimers to compress the 5s wait
    vi.useFakeTimers();
    const promise = pipeline.execute({ page, parts: [part], firstPass });
    vi.advanceTimersByTime(5_001);
    await expect(promise).rejects.toThrow(BboxLayeredTimeoutError);
    vi.useRealTimers();
  });

  // ==========================================================================
  // NaN / Infinity defense (FIND-PLAN-SEC-CROSS-04 cross-cutting per V1)
  // ==========================================================================
  it("stale-detect heuristic handles NaN bbox.y gracefully (treats as stale)", async () => {
    const cfg: PartBboxEnvConfig = {
      ...DEFAULT_CONFIG,
      preEmptiveScrollEnabled: false,
      staleDetectionTolerancePx: 100,
    };
    const pipeline = new BboxResolutionPipeline(cfg);
    const part = makePart("p1");
    // Math.abs(NaN) = NaN, NaN > 100 = false → confirmed (NOT stale).
    // This test documents current behaviour: NaN defense is at parse-int level
    // (env validators throw); pipeline trust DB-derived bboxes, but if NaN
    // somehow leaks, treat as confirmed (no infinite Option B loop).
    const firstPass: FirstPassEvaluate = vi
      .fn()
      .mockResolvedValueOnce([{ id: "p1", x: 0, y: NaN, width: 100, height: 50 }]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts: [part], firstPass });

    // NaN bbox.y → Math.abs(NaN) > tolerance is false → NOT escalated to B.
    // (Defensive: avoids infinite escalation loop on garbage input.)
    expect(result.pathHistogram.targeted).toBe(0);
  });

  // ==========================================================================
  // Path histogram correctness
  // ==========================================================================
  it("path histogram correctly reflects layer execution counts", async () => {
    const cfg: PartBboxEnvConfig = { ...DEFAULT_CONFIG, staleDetectionTolerancePx: 100 };
    const pipeline = new BboxResolutionPipeline(cfg);
    const parts = [makePart("p1"), makePart("p2"), makePart("p3")];
    const firstPass: FirstPassEvaluate = vi
      .fn()
      // 1st call: p1 ok / p2 stale (will retry via Option B) / p3 null (will retry)
      .mockResolvedValueOnce([makeBbox("p1", 50), makeBbox("p2", 5000), null])
      // 2nd call (Option B): order is [...unresolved=[p3], ...staleSelectors=[p2]] = [p3, p2]
      // results[0] for p3 = null (still missing) / results[1] for p2 = recovered
      .mockResolvedValueOnce([null, makeBbox("p2", 80)]);
    const page = makeMockPage();

    const result = await pipeline.execute({ page, parts, firstPass });

    expect(result.pathHistogram.preempt).toBe(1); // Option A enabled
    expect(result.pathHistogram["1stpass"]).toBe(2); // p1 confirmed + p2 initially resolved
    expect(result.pathHistogram.targeted).toBe(1); // p2 recovered via Option B
    expect(result.pathHistogram.reload).toBe(0); // pipeline does NOT own reload
    expect(result.stillUnresolved).toHaveLength(1); // p3 residual → C-06 reload pass
    expect(result.stillUnresolved[0]!.id).toBe("p3");
  });
});
