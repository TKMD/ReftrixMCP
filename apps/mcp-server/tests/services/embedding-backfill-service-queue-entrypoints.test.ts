// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * embedding-backfill.service.ts — Queue-based Backfill Entry Points Tests (v0.4.0 PR4)
 *
 * Verifies that the service exports the two new entry points used by
 * `embedding-backfill-worker.ts`:
 *   - backfillPartTextForPage(webPageId, options?)
 *   - countPartVisualBackfillTargets(webPageId)
 *
 * These are thin wrappers around the existing chunked backfill logic; they must:
 *   - preserve DB self-discovery semantics (WHERE embedding IS NULL)
 *   - dispose the ONNX pipeline on completion (finally block)
 *   - return structured { generated, failed, memorySkips, errors } / { pendingCount }
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("embedding-backfill.service Queue entry points (v0.4.0 PR4)", () => {
  const servicePath = path.resolve(__dirname, "../../src/services/embedding-backfill.service.ts");
  let serviceSource: string;

  beforeAll(() => {
    serviceSource = fs.readFileSync(servicePath, "utf8");
  });

  describe("backfillPartTextForPage export", () => {
    it("should be exported as async function", () => {
      expect(serviceSource).toMatch(/export async function backfillPartTextForPage\b/);
    });

    it("should return PerCategoryBackfillResult with generated / failed / memorySkips / errors", () => {
      // v0.4.0 PR7a-3: The inline return type was extracted to the
      // `PerCategoryBackfillResult` interface so all 6 wrappers share it.
      expect(serviceSource).toContain("export interface PerCategoryBackfillResult");
      const typeBlock =
        serviceSource.match(/export interface PerCategoryBackfillResult \{[\s\S]*?\}/)?.[0] ?? "";
      expect(typeBlock).toContain("generated: number");
      expect(typeBlock).toContain("failed: number");
      expect(typeBlock).toContain("memorySkips: number");
      expect(typeBlock).toContain("errors: string[]");
      // backfillPartTextForPage must declare this as its Promise return type
      expect(serviceSource).toMatch(
        /export async function backfillPartTextForPage[\s\S]*?Promise<PerCategoryBackfillResult>/
      );
    });

    it("should use DB self-discovery via getMissingPartEmbeddings", () => {
      expect(serviceSource).toContain("getMissingPartEmbeddings(webPageId)");
    });

    it("should dispose embedding pipeline in finally block", () => {
      // v0.4.0 PR7a-3: Pipeline disposal lives in the shared generic core.
      // Verify the core owns the try/finally + disposeEmbeddingPipeline guarantee.
      const coreStart = serviceSource.indexOf("async function backfillCategoryForPage");
      const coreEnd = serviceSource.indexOf("export async function backfillPartTextForPage");
      expect(coreStart).toBeGreaterThanOrEqual(0);
      expect(coreEnd).toBeGreaterThan(coreStart);
      const coreBody = serviceSource.substring(coreStart, coreEnd);
      expect(coreBody).toMatch(/finally[\s\S]*?disposeEmbeddingPipeline/);
    });

    it("should handle zero-pending case without invoking the chunk runner", () => {
      // v0.4.0 PR7a-3: The zero-pending early return lives in the shared generic
      // core (`backfillCategoryForPage`) rather than in each wrapper. Verify the
      // early-return still exists there.
      const coreStart = serviceSource.indexOf("async function backfillCategoryForPage");
      const coreEnd = serviceSource.indexOf("export async function backfillPartTextForPage");
      expect(coreStart).toBeGreaterThanOrEqual(0);
      expect(coreEnd).toBeGreaterThan(coreStart);
      const coreBody = serviceSource.substring(coreStart, coreEnd);
      expect(coreBody).toMatch(/if \(missing\.length === 0\)[\s\S]*?return \{ generated: 0/);
    });
  });

  describe("countPartVisualBackfillTargets export", () => {
    it("should be exported as async function", () => {
      expect(serviceSource).toMatch(/export async function countPartVisualBackfillTargets\b/);
    });

    it("should return { pendingCount }", () => {
      expect(serviceSource).toContain("Promise<{ pendingCount: number }>");
    });

    it("should JOIN component_part_embeddings and filter visual_embedding IS NULL", () => {
      expect(serviceSource).toContain(
        "JOIN component_part_embeddings cpe ON cp.id = cpe.component_part_id"
      );
      expect(serviceSource).toContain("cpe.visual_embedding IS NULL");
    });

    it("should exclude piiRiskLevel='high' parts (GDPR Art. 5(1)(c))", () => {
      expect(serviceSource).toContain("cp.pii_risk_level != 'high'");
    });

    it("should validate pendingCount via Number.isFinite (NaN defense)", () => {
      expect(serviceSource).toContain("Number.isFinite(pendingCount)");
    });
  });

  describe("No TODO / FIXME / feature flag", () => {
    it("should not contain TODO markers in the new PR4 entry points", () => {
      // Scope: backfillPartTextForPage + countPartVisualBackfillTargets blocks
      const pr4Section = serviceSource.substring(
        serviceSource.indexOf("backfillPartTextForPage"),
        serviceSource.indexOf("async function backfillParts(")
      );
      expect(pr4Section).not.toContain("TODO");
      expect(pr4Section).not.toContain("FIXME");
    });

    it("should not rely on process.env feature flags for dispatch", () => {
      const pr4Section = serviceSource.substring(
        serviceSource.indexOf("backfillPartTextForPage"),
        serviceSource.indexOf("async function backfillParts(")
      );
      // No feature flags — we want the Queue-based Backfill to be a permanent path
      expect(pr4Section).not.toMatch(/process\.env\.[A-Z_]*FEATURE/);
      expect(pr4Section).not.toMatch(/process\.env\.[A-Z_]*ENABLE/);
    });
  });

  // ============================================================================
  // v0.4.0 PR7a-3: Per-category wrappers consolidated through the generic
  // backfillCategoryForPage core. These tests assert (a) the 5 non-part
  // wrappers remain exported with the same public signature, (b) each wrapper
  // is a thin delegator to the generic core, and (c) the shared core exists.
  // ============================================================================

  describe("backfillCategoryForPage generic core (PR7a-3, TDA High-1)", () => {
    it("should declare the internal generic function", () => {
      expect(serviceSource).toMatch(/async function backfillCategoryForPage<TRow>/);
    });

    it("should export the shared PerCategoryBackfillResult type", () => {
      expect(serviceSource).toMatch(/export interface PerCategoryBackfillResult/);
    });

    it("should include generated / failed / memorySkips / errors in the shared type", () => {
      const typeBlock = serviceSource.match(
        /export interface PerCategoryBackfillResult \{[\s\S]*?\}/
      );
      expect(typeBlock).not.toBeNull();
      const body = typeBlock?.[0] ?? "";
      expect(body).toContain("generated: number");
      expect(body).toContain("failed: number");
      expect(body).toContain("memorySkips: number");
      expect(body).toContain("errors: string[]");
    });

    it("should own the EmbeddingService lifecycle inside the generic core", () => {
      // new LayoutEmbeddingService + finally dispose + GC must live inside the generic
      const coreBlock = serviceSource.substring(
        serviceSource.indexOf("async function backfillCategoryForPage"),
        serviceSource.indexOf("export async function backfillPartTextForPage")
      );
      expect(coreBlock).toContain("new LayoutEmbeddingService");
      expect(coreBlock).toContain("disposeEmbeddingPipeline");
      expect(coreBlock).toContain("tryGarbageCollect");
      expect(coreBlock).toContain("resolveRssThreshold");
    });
  });

  describe.each([
    ["backfillPartTextForPage", "getMissingPartEmbeddings", "backfillParts"],
    ["backfillSectionVisualsForPage", "getMissingSectionEmbeddings", "backfillSections"],
    ["backfillMotionsForPage", "getMissingMotionEmbeddings", "backfillMotions"],
    ["backfillBackgroundsForPage", "getMissingBackgroundEmbeddings", "backfillBackgrounds"],
    ["backfillJsAnimationsForPage", "getMissingJsAnimationEmbeddings", "backfillJsAnimations"],
    ["backfillResponsiveForPage", "getMissingResponsiveEmbeddings", "backfillResponsive"],
  ])("per-category wrapper %s (PR7a-3)", (wrapperName, getMissingName, runChunkName) => {
    it("should be exported as async function", () => {
      const pattern = new RegExp(`export async function ${wrapperName}\\b`);
      expect(serviceSource).toMatch(pattern);
    });

    it("should return PerCategoryBackfillResult", () => {
      const pattern = new RegExp(
        `export async function ${wrapperName}[\\s\\S]*?Promise<PerCategoryBackfillResult>`
      );
      expect(serviceSource).toMatch(pattern);
    });

    it("should delegate to backfillCategoryForPage with the correct deps", () => {
      // Extract just this wrapper's body (up to the next top-level export)
      const start = serviceSource.indexOf(`export async function ${wrapperName}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const rest = serviceSource.substring(start);
      // The wrapper body must end before the next export async function boundary
      const nextBoundary = rest.slice(1).search(/\nexport async function /);
      const body = nextBoundary >= 0 ? rest.substring(0, nextBoundary + 1) : rest;
      expect(body).toContain("backfillCategoryForPage");
      // v0.4.0 PR7e-β4 PR2b-β (TPA-M-1): `backfillJsAnimationsForPage` routes
      // between `getMissingJsAnimationEmbeddings` (partsLimit undefined) and
      // `getMissingJsAnimationEmbeddingsWithLimit` (partsLimit set). Other
      // wrappers still pass the fetcher directly.
      //
      // v0.4.0 PR7e-β4 PR2b-β (TPA-M-1): js_animation wrapper は partsLimit に
      // よって `getMissingJsAnimationEmbeddings` / `getMissingJsAnimationEmbeddingsWithLimit`
      // を切り替える。他 wrapper は fetcher を直接渡す。
      if (wrapperName === "backfillJsAnimationsForPage") {
        expect(body).toContain("getMissingJsAnimationEmbeddings");
        expect(body).toContain("getMissingJsAnimationEmbeddingsWithLimit");
        expect(body).toContain("partsLimit");
        expect(body).toContain("getMissingRows,");
      } else {
        expect(body).toContain(`getMissingRows: ${getMissingName}`);
      }
      expect(body).toContain(`runChunkLoop: ${runChunkName}`);
      // Thin wrapper — must NOT re-declare EmbeddingService / dispose / RSS threshold
      expect(body).not.toContain("new LayoutEmbeddingService");
      expect(body).not.toContain("disposeEmbeddingPipeline");
      expect(body).not.toContain("resolveRssThreshold");
    });
  });

  // ==========================================================================
  // v0.4.0 PR7e-β4 PR2b-β (TPA-M-1): partsLimit routing behavioral test
  // ==========================================================================
  describe("backfillJsAnimationsForPage partsLimit routing (PR7e-β4 PR2b-β)", () => {
    it("should export getMissingJsAnimationEmbeddingsWithLimit with LIMIT clause", () => {
      // Export must exist so fork orchestrator / tests can observe it.
      expect(serviceSource).toMatch(
        /export async function getMissingJsAnimationEmbeddingsWithLimit\(/
      );
      // Body must contain LIMIT + ORDER BY for deterministic head-N fetch.
      const start = serviceSource.indexOf(
        "export async function getMissingJsAnimationEmbeddingsWithLimit"
      );
      expect(start).toBeGreaterThan(0);
      const rest = serviceSource.substring(start);
      const nextBoundary = rest.slice(1).search(/\n(export )?async function /);
      const body = nextBoundary >= 0 ? rest.substring(0, nextBoundary + 1) : rest;
      expect(body).toContain("ORDER BY jap.id ASC");
      expect(body).toContain("LIMIT $2");
    });

    it("BackfillOptions should declare optional partsLimit", () => {
      const start = serviceSource.indexOf("export interface BackfillOptions");
      expect(start).toBeGreaterThan(0);
      const rest = serviceSource.substring(start);
      const end = rest.indexOf("\n}\n");
      const body = rest.substring(0, end >= 0 ? end + 2 : rest.length);
      expect(body).toContain("partsLimit?: number");
    });
  });

  describe("Duplication elimination (PR7a-3, TDA High-1)", () => {
    it("should instantiate LayoutEmbeddingService exactly twice: once in the generic core, once in backfillWebPageEmbeddings", () => {
      // After PR7a-3 consolidation:
      //   - `backfillCategoryForPage` (generic core, shared by 6 Queue-based wrappers)
      //   - `backfillWebPageEmbeddings` (full-page orchestrator, different public API)
      // Any third occurrence indicates a per-category wrapper has re-introduced
      // the duplication (TDA High-1 regression).
      const matches = serviceSource.match(
        /new LayoutEmbeddingService\(\{ cacheEnabled: false \}\)/g
      );
      expect(matches).not.toBeNull();
      expect(matches?.length ?? 0).toBe(2);
    });

    it("should NOT contain LayoutEmbeddingService instantiation inside any per-category wrapper", () => {
      const wrapperNames = [
        "backfillPartTextForPage",
        "backfillSectionVisualsForPage",
        "backfillMotionsForPage",
        "backfillBackgroundsForPage",
        "backfillJsAnimationsForPage",
        "backfillResponsiveForPage",
      ];
      for (const wrapperName of wrapperNames) {
        const start = serviceSource.indexOf(`export async function ${wrapperName}`);
        expect(start).toBeGreaterThanOrEqual(0);
        const rest = serviceSource.substring(start);
        const nextBoundary = rest.slice(1).search(/\nexport async function /);
        const body = nextBoundary >= 0 ? rest.substring(0, nextBoundary + 1) : rest;
        expect(body, `${wrapperName} should be a thin wrapper`).not.toContain(
          "new LayoutEmbeddingService"
        );
      }
    });
  });
});
