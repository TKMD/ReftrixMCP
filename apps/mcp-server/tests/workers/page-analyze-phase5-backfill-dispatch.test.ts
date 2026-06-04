// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker — Phase 5 Backfill Dispatch Tests (v0.4.0 PR4)
 *
 * Verifies the Queue-based Backfill dispatch logic embedded in page-analyze-worker.ts:
 *   - 100-Part threshold is applied only to Part text / visual (not Section / Motion / etc.)
 *   - partsLimit is plumbed through EmbeddingPhaseParams → fork orchestrator → children
 *   - Backfill part_* jobs are enqueued after Phase 5 for pages exceeding the threshold
 *   - embeddingBackfillStatus transitions to 'queued' when jobs are enqueued
 *
 * PR-BACKFILL-TERMINAL (系統A / System A): the dispatch now ALSO enqueues the 4
 * screenshot-free, gate-less categories (motion/background/js_animation/responsive)
 * unconditionally on every completed page, derived from the
 * `EMBEDDING_BACKFILL_CATEGORIES` SSOT (drift-proof). The part threshold gate and
 * the section_visual condition are PRESERVED inside the pure
 * `resolveBackfillDispatchCategories` helper. Consequently, pages with ≤ 100
 * Parts NO LONGER skip enqueue entirely — they still enqueue the gate-less
 * categories (closing the happy-path enqueue gap that mis-pinned pages to
 * `failed`). The behavioral contract is pinned by
 * INV-BACKFILL-TERMINAL-COMPLETED-007 (large-page standing).
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Phase 5 Backfill Dispatch (v0.4.0 PR4)", () => {
  const workerPath = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");
  const phase5Path = path.resolve(__dirname, "../../src/workers/phases/phase-5-embedding.ts");
  const typesPath = path.resolve(__dirname, "../../src/workers/phases/types.ts");
  const orchestratorPath = path.resolve(
    __dirname,
    "../../src/workers/phases/phase-5-fork-orchestrator.ts"
  );
  const ipcPath = path.resolve(__dirname, "../../src/workers/phases/phase-5-child-ipc.ts");
  const textChildPath = path.resolve(
    __dirname,
    "../../src/workers/phases/phase-5-text-embedding-child.ts"
  );
  const visualChildPath = path.resolve(
    __dirname,
    "../../src/workers/phases/phase-5-visual-embedding-child.ts"
  );

  let workerSource: string;
  let phase5Source: string;
  let typesSource: string;
  let orchestratorSource: string;
  let ipcSource: string;
  let textChildSource: string;
  let visualChildSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(workerPath, "utf8");
    phase5Source = fs.readFileSync(phase5Path, "utf8");
    typesSource = fs.readFileSync(typesPath, "utf8");
    orchestratorSource = fs.readFileSync(orchestratorPath, "utf8");
    ipcSource = fs.readFileSync(ipcPath, "utf8");
    textChildSource = fs.readFileSync(textChildPath, "utf8");
    visualChildSource = fs.readFileSync(visualChildPath, "utf8");
  });

  describe("100-Part threshold", () => {
    it("should define PART_SYNC_THRESHOLD via EMBEDDING_SYNC_PART_LIMIT env var (default 100)", () => {
      // TPA #1 (v0.4.0 PR4 audit): PART_SYNC_THRESHOLD is now env-configurable.
      // Default 100, clamped to [10, 1000] via safeParseInt.
      expect(workerSource).toContain("const PART_SYNC_THRESHOLD = safeParseInt(");
      expect(workerSource).toContain('process.env["EMBEDDING_SYNC_PART_LIMIT"]');
      expect(workerSource).toMatch(/min:\s*10/);
      expect(workerSource).toMatch(/max:\s*1000/);
    });

    it("should compute partsLimit only when partsSavedCount > PART_SYNC_THRESHOLD", () => {
      expect(workerSource).toMatch(/partsSavedCountForPhase5 > PART_SYNC_THRESHOLD/);
      expect(workerSource).toContain("PART_SYNC_THRESHOLD : undefined");
    });

    it("should pass partsLimit to dispatchEmbeddingPhase", () => {
      expect(workerSource).toContain("partsLimit: partsLimitForSyncPhase");
    });
  });

  describe("partsLimit plumbing", () => {
    it("should declare partsLimit in EmbeddingPhaseParams", () => {
      expect(typesSource).toContain("partsLimit?: number | undefined");
    });

    it("should declare partsLimit in TextEmbeddingSubPhaseParams", () => {
      expect(phase5Source).toContain("partsLimit?: number | undefined");
      // Check at least two separate declarations (text + visual)
      const count = (phase5Source.match(/partsLimit\?: number \| undefined/g) ?? []).length;
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it("should declare partsLimit in IPC Zod schemas for both init-text and init-visual", () => {
      // Must appear in both schemas.
      // PR-1 GPU-COORD (T1-wins): schemas are now `z.object({...}).strict()`
      // (FIND-PLAN-M-02 SEC H-2 parity), which Prettier renders multi-line as
      // `z\n  .object({...})\n  .strict();`. The regex tolerates both the legacy
      // `z.object({...});` form and the new `.strict()` form.
      const parentInitTextMatch = ipcSource.match(
        /parentInitTextSchema = z[\s\S]*?\.object\(\{[\s\S]*?\}\)[\s\S]*?;/
      );
      const parentInitVisualMatch = ipcSource.match(
        /parentInitVisualSchema = z[\s\S]*?\.object\(\{[\s\S]*?\}\)[\s\S]*?;/
      );
      expect(parentInitTextMatch).not.toBeNull();
      expect(parentInitVisualMatch).not.toBeNull();
      expect(parentInitTextMatch![0]).toContain("partsLimit");
      expect(parentInitVisualMatch![0]).toContain("partsLimit");
    });

    it("should propagate partsLimit from orchestrator to text/visual init messages", () => {
      // Orchestrator must destructure partsLimit and forward it conditionally.
      // PR-BT-5 (ADR-0039): the per-sub-phase fork helpers
      // (runTextSubPhaseFork / runVisualSubPhaseFork) forward partsLimit into the
      // init message via the conditional spread `args.partsLimit !== undefined
      // ? { partsLimit: args.partsLimit } : {}` (same conditional-forward
      // contract, now through the helper args). `partsLimit` is also threaded as
      // a top-level dispatch arg.
      expect(orchestratorSource).toContain("partsLimit,");
      expect(orchestratorSource).toContain(
        "args.partsLimit !== undefined ? { partsLimit: args.partsLimit } : {}"
      );
    });

    it("should propagate partsLimit in the text child script", () => {
      expect(textChildSource).toContain("partsLimit: msg.partsLimit");
    });

    it("should propagate partsLimit in the visual child script", () => {
      expect(visualChildSource).toContain("partsLimit: msg.partsLimit");
    });

    it("should pass partsLimit to processPartTextEmbeddingChunks", () => {
      expect(phase5Source).toContain("limit: textParams.partsLimit");
    });

    it("should pass partsLimit to processPartVisualEmbeddingLoop", () => {
      expect(phase5Source).toMatch(/limit: vParams\.partsLimit/);
    });
  });

  describe("DB-level cap via Prisma take", () => {
    it("should apply take/orderBy in processPartTextEmbeddingChunks when limit is set", () => {
      // Ensure the findMany args receive `take` and deterministic orderBy
      expect(phase5Source).toContain("findManyArgs.take = resolvedLimit");
      expect(phase5Source).toContain('findManyArgs.orderBy = { id: "asc" }');
    });

    it("should apply take/orderBy in processPartVisualEmbeddingLoop when limit is set", () => {
      expect(phase5Source).toContain(
        'resolvedLimit !== undefined ? { take: resolvedLimit, orderBy: { id: "asc" } } : {}'
      );
    });

    it("should validate limit via Number.isFinite and isInteger", () => {
      expect(phase5Source).toContain("Number.isFinite(options.limit)");
      expect(phase5Source).toContain("Number.isInteger(options.limit)");
    });
  });

  describe("Category scope (Part only)", () => {
    it("should NOT apply 100 threshold to Section embeddings", () => {
      // Section embedding chunks do not accept a limit option
      expect(phase5Source).not.toContain("processSectionTextEmbeddingChunks(ctx, limit:");
    });

    it("should NOT apply 100 threshold to Motion embeddings", () => {
      expect(phase5Source).not.toContain("processMotionTextEmbeddingChunks(ctx, limit:");
    });

    it("should NOT apply 100 threshold to Background / JS / Responsive", () => {
      // Only part_text and part_visual are the scope of this PR
      expect(phase5Source).not.toContain("processBackgroundTextEmbeddingChunks(ctx, limit:");
      expect(phase5Source).not.toContain("processJsAnimationEmbeddingChunks(ctx, limit:");
      expect(phase5Source).not.toContain("processResponsiveEmbeddingChunks(ctx, limit:");
    });
  });

  describe("Backfill queue enqueue", () => {
    it("should import createEmbeddingBackfillQueue lazily", () => {
      expect(workerSource).toContain("createEmbeddingBackfillQueue");
      expect(workerSource).toContain("function getBackfillQueue()");
    });

    it("should define dispatchBackfillJobsForPage helper", () => {
      expect(workerSource).toContain("async function dispatchBackfillJobsForPage");
    });

    it("should guard parts enqueue via the SSOT-derived resolver (PART_SYNC_THRESHOLD gate PRESERVED, PR-BACKFILL-TERMINAL 系統A)", () => {
      // v0.4.0 PR7e-α (バグ⑥): part / section_visual を独立条件化。
      // PR-BACKFILL-TERMINAL (系統A): gate ロジックを pure helper
      // `resolveBackfillDispatchCategories` に移し、dispatch は `dispatchSet.has(...)`
      // で `shouldEnqueueParts` を導出する。part の threshold gate は resolver 内で
      // PRESERVE される (FIND-BT-M-03)。behavioral contract は INV-BACKFILL-
      // TERMINAL-COMPLETED-007 Block A が resolver 出力で pin。
      //
      // v0.4.0 PR7e-α (bug ⑥): independent part / section_visual conditions.
      // PR-BACKFILL-TERMINAL (System A): the gate logic moved into the pure
      // helper `resolveBackfillDispatchCategories`; the dispatch derives
      // `shouldEnqueueParts` from `dispatchSet.has(...)`. The PART_SYNC_THRESHOLD
      // gate is PRESERVED inside the resolver (FIND-BT-M-03). The behavioral
      // contract is pinned by INV-BACKFILL-TERMINAL-COMPLETED-007 Block A.
      expect(workerSource).toMatch(/partsSavedCount\s*>\s*PART_SYNC_THRESHOLD/);
      expect(workerSource).toMatch(/shouldEnqueueParts\s*=\s*dispatchSet\.has\("part_text"\)/);
      expect(workerSource).toMatch(/if\s*\(shouldEnqueueParts\)/);
    });

    it("should dispatch section_visual via the SSOT-derived resolver (sections>0 && screenshot condition PRESERVED, PR-BACKFILL-TERMINAL 系統A)", () => {
      // PR-BACKFILL-TERMINAL (系統A): section_visual condition は resolver 内で
      // PRESERVE (`sectionsSavedCount > 0 && hasScreenshot`)。dispatch は
      // `dispatchSet.has("section_visual")` で導出。
      //
      // PR-BACKFILL-TERMINAL (System A): the section_visual condition is
      // PRESERVED inside the resolver; the dispatch derives it via
      // `dispatchSet.has("section_visual")`.
      expect(workerSource).toMatch(/sectionsSavedCount\s*>\s*0\s*&&\s*hasScreenshot/);
      expect(workerSource).toMatch(
        /shouldEnqueueSectionVisual\s*=\s*dispatchSet\.has\("section_visual"\)/
      );
      expect(workerSource).toMatch(/category:\s*"section_visual"/);
    });

    it("should enqueue the 4 gate-less categories unconditionally via SSOT-derived set (PR-BACKFILL-TERMINAL 系統A root cause fix)", () => {
      // PR-BACKFILL-TERMINAL (系統A): motion/bg/js/responsive を SSOT 由来の
      // `BACKFILL_DISPATCH_GATELESS_CATEGORIES` から無条件 enqueue する。これが
      // happy-path enqueue gap (root cause) の closure。
      //
      // PR-BACKFILL-TERMINAL (System A): unconditionally enqueue the 4 gate-less
      // categories from the SSOT-derived `BACKFILL_DISPATCH_GATELESS_CATEGORIES`.
      expect(workerSource).toContain("BACKFILL_DISPATCH_GATELESS_CATEGORIES");
      expect(workerSource).toMatch(
        /EMBEDDING_BACKFILL_CATEGORIES\.filter\(\(c\)\s*=>\s*!BACKFILL_DISPATCH_GATED_CATEGORIES\.has\(c\)\)/
      );
      expect(workerSource).toContain("Failed to enqueue gate-less backfill (non-fatal)");
    });

    it("should log dispatched categories unconditionally (PR7e-α min-observability)", () => {
      // TDA 最小 observability 要件。isDevelopment() ガードなし。
      // TDA minimum-observability requirement. No isDevelopment() guard.
      expect(workerSource).toContain("Dispatched backfill categories");
    });

    it("should enqueue part_text unconditionally (no screenshot needed)", () => {
      expect(workerSource).toMatch(/category: "part_text"/);
    });

    it("should enqueue part_visual only when persisted screenshot exists", () => {
      expect(workerSource).toContain("if (screenshotStoragePath) {");
      expect(workerSource).toMatch(/category: "part_visual"/);
    });

    it("should handle enqueue failures gracefully (non-fatal)", () => {
      expect(workerSource).toContain("Failed to enqueue part_text backfill (non-fatal)");
      expect(workerSource).toContain("Failed to enqueue part_visual backfill (non-fatal)");
    });
  });

  describe("embeddingBackfillStatus transition", () => {
    it("should transition status to 'queued' after enqueue", () => {
      expect(workerSource).toMatch(/updateEmbeddingBackfillStatus\([^)]*"queued"/);
    });

    it("should fetch screenshotStoragePath from DB for dispatch", () => {
      expect(workerSource).toContain("screenshotStoragePath: true");
      expect(workerSource).toContain("persistedScreenshotPath");
    });
  });

  describe("Queue resource cleanup", () => {
    it("should close the backfill queue on worker shutdown", () => {
      expect(workerSource).toMatch(/_backfillQueue[\s\S]{0,200}\.close\(\)/);
    });
  });
});
