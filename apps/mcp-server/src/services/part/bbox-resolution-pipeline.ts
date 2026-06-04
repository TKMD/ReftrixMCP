// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bbox Resolution Pipeline (Plan v3 T5 V1 §1.2 / §3.7 — U-T5-2)
 *
 * Strategy class encapsulating the layered Part bbox resolution pipeline:
 *
 *   Option A (pre-emptive scroll replay)
 *     → 1st-pass `page.evaluate()` (existing PR-D-9 W4)
 *     → Option C (stale-bbox detection — AND with Option A per §1.6)
 *     → Option B (targeted requery for stale + unresolved)
 *     → existing PR-D-9 W4 C-06 reload pass (catch-all of last resort, contract preserved)
 *
 * **V1 contract guarantees** (per Plan v3 T5 V1):
 *   - Cyclomatic complexity ≤ 8 (TDA Impl Audit gate)
 *   - Cumulative `BBOX_LAYERED_TOTAL_TIMEOUT_MS` Promise.race wrap (§1.3 U-T5-3)
 *   - Mode D AND-then-fallback: Option A + Option C BOTH execute (§1.6 U-T5-6)
 *   - `pathHistogram` emit ALWAYS (not opt-in) per §1.2 U-T5-2 + LCC-T5-01
 *   - Existing PR-D-9 C-06 reload pass contract UNCHANGED — pipeline does NOT
 *     own browser lifecycle / SSRF guard / DB writes (those remain in
 *     {@link resolvePartBoundingBoxes} per §3.6 contract preservation)
 *   - SSRF guard preserved by structural design: pipeline does NOT call
 *     `page.goto()` (operates on pre-loaded page object only). Verified by
 *     standing regression `inv-part-bbox-reload-001-ssrf-preservation.test.ts`
 *     (§1.4 U-T5-4 AST scan).
 *
 * **Why a strategy class** (not free functions):
 *   - Encapsulates env config (validated at boot via `validatePartBboxEnv()`)
 *   - Cyclomatic ≤ 8 contract is checkable at the class boundary
 *   - Future Option D / E layers can extend without touching service.ts
 *
 * @see Plan v3 T5 V1 §1.2 / §1.6 / §3.4 / §3.7 / §6.1 unit tests
 * @see ADR-0018 §Decision 1 Supplement S3 (`bbox_unresolvable` mutual exclusivity)
 * @module services/part/bbox-resolution-pipeline
 */

import type { Page } from "playwright";
import type { PartBboxEnvConfig } from "../../utils/env-validators";

// ============================================================================
// Public types — re-export shape from part-bbox-playwright.service.ts
// ============================================================================

/**
 * Part selector data passed through the pipeline. Kept structurally identical
 * to {@link PartSelectorData} in `part-bbox-playwright.service.ts` so the
 * pipeline can be a pure transform without bidirectional schema coupling.
 */
export interface PipelinePartSelector {
  /** DB part ID */
  id: string;
  /** CSS selector candidates (priority order) */
  selectors: string[];
  /** Section absolute Y start coordinate */
  sectionStartY: number;
  /** Per-partType index within section */
  sampleIndex: number;
}

/**
 * Resolved bounding box result. Section-relative coordinates.
 */
export interface PipelineBboxResult {
  /** DB part ID */
  id: string;
  /** Section-relative X coordinate */
  x: number;
  /** Section-relative Y coordinate */
  y: number;
  /** Width */
  width: number;
  /** Height */
  height: number;
}

/**
 * Distribution of which layer resolved each part. ALWAYS emitted per V1
 * §1.2 (LCC-T5-01 hydration telemetry retention compliance).
 *
 *   - `preempt`: 1 when Option A pre-emptive scroll executed (per page, not per part)
 *   - `1stpass`: count of parts resolved by initial page.evaluate
 *   - `targeted`: count of parts resolved by Option B targeted requery
 *   - `reload`: count of parts resolved by C-06 reload pass (catch-all)
 *
 * Note: `preempt` is page-level (1/0 when enabled/skipped), not part-level
 * count — it indicates **whether** the layer executed, since scroll replay
 * affects all subsequent layers' resolution rate uniformly.
 */
export interface PathHistogram {
  preempt: number;
  "1stpass": number;
  targeted: number;
  reload: number;
}

/**
 * 1st-pass page.evaluate signature — injected so the service.ts callsite
 * keeps the existing inline `page.evaluate()` body (V1 §3.6 contract: pipeline
 * does NOT touch SSRF guard or browser lifecycle; it only orchestrates).
 */
export type FirstPassEvaluate = (
  page: Page,
  selectors: PipelinePartSelector[]
) => Promise<Array<PipelineBboxResult | null>>;

/**
 * Pipeline execution input.
 */
export interface PipelineExecuteParams {
  page: Page;
  parts: PipelinePartSelector[];
  /** 1st-pass implementation (uses page.evaluate inline body from service.ts). */
  firstPass: FirstPassEvaluate;
}

/**
 * Pipeline execution output.
 */
export interface PipelineExecuteResult {
  resolved: PipelineBboxResult[];
  stillUnresolved: PipelinePartSelector[];
  pathHistogram: PathHistogram;
  elapsedMs: number;
}

/**
 * Thrown by {@link BboxResolutionPipeline.execute} when the cumulative
 * `BBOX_LAYERED_TOTAL_TIMEOUT_MS` budget is exhausted. Caller (service.ts)
 * catches and treats as Graceful Degradation: residual parts emit
 * `skipReason='bbox_unresolvable'` per ADR-0018 §Decision 1 Supplement S3.
 */
export class BboxLayeredTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Bbox resolution pipeline exceeded cumulative timeout ${timeoutMs}ms`);
    this.name = "BboxLayeredTimeoutError";
  }
}

// ============================================================================
// Pipeline strategy class (cyclomatic ≤ 8 contract per V1 §1.2)
// ============================================================================

/**
 * Pipeline strategy class for layered Part bbox resolution.
 *
 * @see Plan v3 T5 V1 §1.2 (U-T5-2) + §3.4 layered composition
 */
export class BboxResolutionPipeline {
  constructor(private readonly config: PartBboxEnvConfig) {}

  /**
   * Execute the layered pipeline (cumulative timeout via Promise.race).
   *
   * Cyclomatic complexity contract: ≤ 8 branches at this method boundary.
   * Each layer is delegated to a private helper to keep the orchestration
   * branch-light.
   */
  async execute(params: PipelineExecuteParams): Promise<PipelineExecuteResult> {
    const startedAt = Date.now();
    return Promise.race([
      this.executeLayered(params, startedAt),
      this.timeoutPromise(this.config.layeredTotalTimeoutMs),
    ]);
  }

  /**
   * Layered execution body. Cyclomatic count (sequential branches):
   *   B1 entry / parts.length===0 fast path
   *   B2 preEmptiveScrollEnabled
   *   B3 1st-pass (always)
   *   B4 staleDetectionEnabled
   *   B5 targetedRequeryEnabled (and stillUnresolved.length>0)
   *   B6 reloadPass deferred to caller (existing C-06)
   *   B7 timeout (handled at execute() race level)
   *   = ≤ 8 within method boundary
   */
  private async executeLayered(
    params: PipelineExecuteParams,
    startedAt: number
  ): Promise<PipelineExecuteResult> {
    const { page, parts, firstPass } = params;
    const histogram: PathHistogram = { preempt: 0, "1stpass": 0, targeted: 0, reload: 0 };

    if (parts.length === 0) {
      return { resolved: [], stillUnresolved: [], pathHistogram: histogram, elapsedMs: 0 };
    }

    // Layer A: pre-emptive scroll replay (Mode A + D upfront)
    if (this.config.preEmptiveScrollEnabled) {
      await this.preEmptiveScrollReplay(page);
      histogram.preempt = 1;
    }

    // Layer 1st-pass: always executes
    const firstPassResults = await firstPass(page, parts);
    const { resolved, unresolved } = this.partitionFirstPass(parts, firstPassResults);
    histogram["1stpass"] = resolved.length;

    // Layer C: stale-bbox detection (AND with Option A per §1.6 U-T5-6)
    let staleSelectors: PipelinePartSelector[] = [];
    let confirmedResolved: PipelineBboxResult[] = resolved;
    if (this.config.staleDetectionEnabled) {
      const detectionResult = this.detectStaleBboxes(resolved, parts);
      confirmedResolved = detectionResult.confirmed;
      staleSelectors = detectionResult.stale;
    }

    // Layer B: targeted requery for stale + unresolved
    let targetedRecovered: PipelineBboxResult[] = [];
    let stillUnresolved: PipelinePartSelector[] = [...unresolved, ...staleSelectors];
    if (this.config.targetedRequeryEnabled && stillUnresolved.length > 0) {
      const requeryResult = await this.targetedRequery(page, stillUnresolved, firstPass);
      targetedRecovered = requeryResult.recovered;
      stillUnresolved = requeryResult.stillUnresolved;
      histogram.targeted = targetedRecovered.length;
    }

    return {
      resolved: [...confirmedResolved, ...targetedRecovered],
      stillUnresolved,
      pathHistogram: histogram,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /**
   * Promise.race timeout arm — throws {@link BboxLayeredTimeoutError} when
   * cumulative budget exhausted. Caller catches and emits `bbox_unresolvable`.
   */
  private timeoutPromise(timeoutMs: number): Promise<never> {
    return new Promise((_resolve, reject) => {
      const t = setTimeout(() => reject(new BboxLayeredTimeoutError(timeoutMs)), timeoutMs);
      // unref so Node doesn't keep the event loop alive on a hung pipeline
      t.unref?.();
    });
  }

  /**
   * Option A — pre-emptive scroll-state replay. Walks the page from top to
   * bottom up to {@link PartBboxEnvConfig.preEmptiveScrollMaxIterations}
   * scroll steps so lazy-load IntersectionObservers fire before the 1st-pass
   * `page.evaluate()` measures bounding boxes.
   *
   * Mirrors Phase 0 LAZY_SCROLL pattern (page-ingest-adapter) bounded to
   * 1-50 iterations per §1.1 U-T5-1 SSOT.
   */
  private async preEmptiveScrollReplay(page: Page): Promise<void> {
    const maxIterations = this.config.preEmptiveScrollMaxIterations;
    await page.evaluate(async (iterations: number) => {
      for (let i = 0; i < iterations; i++) {
        const before = window.scrollY;
        const step = Math.max(1, Math.floor(window.innerHeight * 0.8));
        window.scrollTo(0, before + step);
        // rAF wait — let IntersectionObservers fire
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        const after = window.scrollY;
        if (after === before) break; // hit page bottom
      }
      window.scrollTo(0, 0);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    }, maxIterations);
  }

  /**
   * Option C helper — stale-bbox detection. Heuristic: a 1st-pass result
   * whose `absoluteY = bbox.y + sectionStartY` is far from the expected
   * `sectionStartY` (beyond {@link PartBboxEnvConfig.staleDetectionTolerancePx})
   * is treated as stale and routed back to Option B targeted requery.
   *
   * Pure function — no Playwright I/O.
   */
  private detectStaleBboxes(
    resolved: PipelineBboxResult[],
    allParts: PipelinePartSelector[]
  ): { confirmed: PipelineBboxResult[]; stale: PipelinePartSelector[] } {
    const tolerance = this.config.staleDetectionTolerancePx;
    const partById = new Map(allParts.map((p) => [p.id, p]));
    const confirmed: PipelineBboxResult[] = [];
    const stale: PipelinePartSelector[] = [];

    for (const r of resolved) {
      const part = partById.get(r.id);
      if (!part) {
        // Defensive: missing part metadata — keep as confirmed (don't escalate
        // unknown shape to Option B since requery would also fail).
        confirmed.push(r);
        continue;
      }
      // bbox.y is section-relative; expected drift from sectionStartY = 0.
      // Stale heuristic: |bbox.y| > tolerance suggests measurement is from
      // a wrong-section element (post-scroll repositioning anomaly).
      if (Math.abs(r.y) > tolerance) {
        stale.push(part);
      } else {
        confirmed.push(r);
      }
    }
    return { confirmed, stale };
  }

  /**
   * Option B — targeted requery via 2nd-pass page.evaluate (no reload). Fires
   * for stale (Option C) + unresolved (1st-pass null) parts. The reload pass
   * (PR-D-9 W4 C-06) handles the residual catch-all in the caller, NOT here.
   *
   * **Defensive id-alignment**: validates `r.id === selectors[i].id` to guard
   * against malformed `firstPass` outputs that violate the index-alignment
   * contract (e.g. mock returning a wrong-shape array, or a page.evaluate
   * implementation that filters internally). Mismatches route to
   * `stillUnresolved` for downstream catch-all per ADR-0018 §Decision 1
   * Supplement S3 mutual exclusivity.
   */
  private async targetedRequery(
    page: Page,
    selectors: PipelinePartSelector[],
    firstPass: FirstPassEvaluate
  ): Promise<{ recovered: PipelineBboxResult[]; stillUnresolved: PipelinePartSelector[] }> {
    const results = await firstPass(page, selectors);
    const recovered: PipelineBboxResult[] = [];
    const stillUnresolved: PipelinePartSelector[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < selectors.length; i++) {
      const sel = selectors[i];
      if (sel === undefined) continue;
      const r = results[i];
      // Index alignment + id alignment + duplicate detection. Defensive against
      // malformed firstPass outputs (mock test artefacts, page.evaluate that
      // re-orders, etc.). On any mismatch → route to stillUnresolved.
      if (r !== null && r !== undefined && r.id === sel.id && !seenIds.has(r.id)) {
        recovered.push(r);
        seenIds.add(r.id);
      } else {
        stillUnresolved.push(sel);
      }
    }
    return { recovered, stillUnresolved };
  }

  /**
   * Pure helper: split 1st-pass results into resolved + unresolved partitions.
   *
   * **Defensive id-alignment**: validates `r.id === parts[i].id` to guard
   * against malformed firstPass outputs. Mismatches route to `unresolved`
   * (downstream Option B / C-06 handles fallback).
   */
  private partitionFirstPass(
    parts: PipelinePartSelector[],
    results: Array<PipelineBboxResult | null>
  ): { resolved: PipelineBboxResult[]; unresolved: PipelinePartSelector[] } {
    const resolved: PipelineBboxResult[] = [];
    const unresolved: PipelinePartSelector[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === undefined) continue;
      const r = results[i];
      if (r !== null && r !== undefined && r.id === part.id && !seenIds.has(r.id)) {
        resolved.push(r);
        seenIds.add(r.id);
      } else {
        unresolved.push(part);
      }
    }
    return { resolved, unresolved };
  }
}
