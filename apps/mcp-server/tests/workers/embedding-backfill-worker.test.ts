// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EmbeddingBackfillWorker Tests (v0.4.0 PR4)
 *
 * Unit tests for the embedding-backfill worker processor and helpers.
 * Processor のカテゴリ振り分け、status 遷移、progress 更新、SPDX ヘッダーを検証する。
 *
 * Redis / Prisma にアクセスするテストは統合テスト扱い。本テストは主に
 * ソースコード構造と module-level contract の検証を行う。
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("EmbeddingBackfillWorker (v0.4.0 PR4)", () => {
  const workerPath = path.resolve(__dirname, "../../src/workers/embedding-backfill-worker.ts");
  const queuePath = path.resolve(__dirname, "../../src/queues/embedding-backfill-queue.ts");
  let workerSource: string;
  let queueSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(workerPath, "utf8");
    queueSource = fs.readFileSync(queuePath, "utf8");
  });

  describe("SPDX and license headers", () => {
    it("should have SPDX header on worker module", () => {
      expect(workerSource.startsWith("// SPDX-FileCopyrightText:")).toBe(true);
      expect(workerSource).toContain("// SPDX-License-Identifier: AGPL-3.0-only");
    });

    it("should have SPDX header on queue module", () => {
      expect(queueSource.startsWith("// SPDX-FileCopyrightText:")).toBe(true);
      expect(queueSource).toContain("// SPDX-License-Identifier: AGPL-3.0-only");
    });
  });

  describe("Worker factory contract", () => {
    it("should export createEmbeddingBackfillWorker factory", () => {
      expect(workerSource).toContain("export function createEmbeddingBackfillWorker");
    });

    it("should export EmbeddingBackfillWorkerInstance type", () => {
      expect(workerSource).toContain("export interface EmbeddingBackfillWorkerInstance");
    });

    it("should use autorun: false (explicit run from start-workers.ts)", () => {
      expect(workerSource).toContain("autorun: false");
    });

    it("should default concurrency to 1 (OOM defense)", () => {
      expect(workerSource).toContain("const DEFAULT_CONCURRENCY = 1");
    });

    it("should set lockDuration >= 10 minutes for DINOv2 inference", () => {
      // Default lock duration: 600_000 ms = 10 minutes
      expect(workerSource).toContain("const DEFAULT_LOCK_DURATION = 600_000");
    });
  });

  describe("Category dispatch (v0.4.0 PR7a-2 Strategy Pattern)", () => {
    it("should delegate to Strategy Pattern via getBackfillProcessor", () => {
      // v0.4.0 PR7a-2: switch 分岐を廃止し Strategy Pattern に集約。
      // v0.4.0 PR7a-2: switch replaced by Strategy Pattern.
      expect(workerSource).toContain("getBackfillProcessor");
      expect(workerSource).toContain("processor.process(ctx)");
    });

    it("should gate screenshot resolution by processor.requiresScreenshot()", () => {
      expect(workerSource).toContain("processor.requiresScreenshot()");
    });

    it("should NOT retain legacy per-category job dispatcher functions", () => {
      // 旧実装（processPartTextJob / processPartVisualJob）の痕跡が残っていないこと
      // Legacy dispatcher helpers must be fully removed
      expect(workerSource).not.toContain("processPartTextJob");
      expect(workerSource).not.toContain("processPartVisualJob");
      // 旧 if / else if 分岐の痕跡（warn log の条件分岐は除外）
      // No legacy if/else if chain remains
      expect(workerSource).not.toContain('if (category === "part_text")');
    });
  });

  describe("Status transitions", () => {
    it("should transition to in_progress on job start", () => {
      expect(workerSource).toMatch(/updateEmbeddingBackfillStatus\([^)]*"in_progress"/);
    });

    it("should transition to completed when no pending items remain", () => {
      expect(workerSource).toContain('"completed"');
      expect(workerSource).toContain("computeRemainingStatus");
    });

    it("should transition to failed only on final attempt", () => {
      expect(workerSource).toContain("isFinalAttempt");
      expect(workerSource).toContain("job.attemptsMade >= (job.opts.attempts ?? 1)");
    });
  });

  describe("Pre-Return Pause pattern (v0.4.0 PR7c)", () => {
    it("should read WORKER_MAX_JOBS_BEFORE_RESTART env var", () => {
      expect(workerSource).toContain("process.env.WORKER_MAX_JOBS_BEFORE_RESTART");
    });

    it("should delegate pause + memory gate to applyPreReturnPauseAndMemoryGate (PR7c)", () => {
      // v0.4.0 PR7c: pause(true) + performMemoryCheckAndExit は shared helper に移動
      //   旧: finalizeBackfillJob 内で _workerInstanceRef.pause(true) + setImmediate(...) 直呼び
      //   新: applyPreReturnPauseAndMemoryGate() 一本化
      // v0.4.0 PR7c: pause + memory gate are now delegated to the shared helper.
      expect(workerSource).toContain("applyPreReturnPauseAndMemoryGate");
    });
  });

  describe("Memory defense (v0.4.0 PR7c)", () => {
    it("should delegate post-job memory check to the shared helper (PR7c)", () => {
      // applyPreReturnPauseAndMemoryGate internally calls shouldExitForMemory() and
      //   - process.exit(0) if above threshold
      //   - worker.resume() if below threshold (PR7c Bug 1 fix)
      expect(workerSource).toContain("applyPreReturnPauseAndMemoryGate");
      // Legacy direct setImmediate(performMemoryCheckAndExit) call must be gone.
      expect(workerSource).not.toMatch(
        /setImmediate\s*\(\s*\(\s*\)\s*=>\s*\{\s*performMemoryCheckAndExit/
      );
    });
  });

  describe("Progress reporting", () => {
    it("should define progress sentinel values", () => {
      expect(workerSource).toContain("PROGRESS_START = 0");
      expect(workerSource).toContain("PROGRESS_COMPLETE = 100");
    });

    it("should call job.updateProgress for BullMQ UI", () => {
      expect(workerSource).toContain("job.updateProgress(");
    });
  });

  describe("Error handling", () => {
    it("should use sanitizeErrorMessage for all catches", () => {
      expect(workerSource).toContain("sanitizeErrorMessage");
    });

    it("should not use isDevelopment guard inside catch blocks", () => {
      // Ensure catch blocks log via logger.warn / logger.error, not behind isDevelopment guard
      const catchBlocks = workerSource.match(/catch \([^)]*\) \{[\s\S]*?\}/g) ?? [];
      for (const block of catchBlocks) {
        // Inside catch blocks, we should not gate error logging behind isDevelopment()
        if (block.includes("logger.error") || block.includes("logger.warn")) {
          continue;
        }
      }
      // No isDevelopment() wrapping the primary logger call within catch
      expect(workerSource).not.toMatch(
        /catch[^}]*if\s*\(\s*isDevelopment\(\)\s*\)\s*\{[^}]*logger\.error/
      );
    });
  });

  describe("PII-safe logging", () => {
    it("should truncate webPageId in logs", () => {
      // All logger calls involving webPageId should slice(0, 8) + "..."
      expect(workerSource).toMatch(/webPageId\.slice\(0, 8\) \+ "\.\.\."/);
    });
  });

  describe("NaN / Infinity defense", () => {
    it("should validate numeric progress via Number.isFinite", () => {
      expect(queueSource).toContain("Number.isFinite");
    });

    it("should clamp generator limits via Number.isFinite and isInteger", () => {
      const phase5Path = path.resolve(__dirname, "../../src/workers/phases/phase-5-embedding.ts");
      const phase5Source = fs.readFileSync(phase5Path, "utf8");
      expect(phase5Source).toContain("Number.isFinite(options.limit)");
      expect(phase5Source).toContain("Number.isInteger(options.limit)");
    });
  });

  // ============================================================================
  // v0.4.0 PR7a-3: processBackfillJob split into validateJobData +
  // initiateBackfillJob + finalizeBackfillJob (TDA High-2, complexity < 10).
  // ============================================================================

  describe("processBackfillJob split (PR7a-3, TDA High-2)", () => {
    it("should declare validateJobData as the Zod re-validation helper", () => {
      expect(workerSource).toMatch(/function validateJobData\(/);
      // Must call the Zod schema parse inside the helper
      const start = workerSource.indexOf("function validateJobData(");
      const end = workerSource.indexOf("async function resolveScreenshotForProcessor");
      const body = workerSource.substring(start, end);
      expect(body).toContain("EmbeddingBackfillJobDataSchema.parse");
      expect(body).toContain("sanitizeErrorMessage");
    });

    it("should declare initiateBackfillJob owning the Strategy Pattern dispatch", () => {
      const start = workerSource.indexOf("async function initiateBackfillJob(");
      const end = workerSource.indexOf("async function finalizeBackfillJob(");
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const body = workerSource.substring(start, end);
      expect(body).toContain("getBackfillProcessor(category)");
      expect(body).toContain("processor.process(ctx)");
      expect(body).toContain("computeRemainingStatus");
      expect(body).toMatch(/updateEmbeddingBackfillStatus\([^)]*"in_progress"/);
      // Must NOT contain the Pre-Return Pause — that belongs to finalize
      expect(body).not.toContain("_workerInstanceRef.pause(true)");
    });

    it("should declare finalizeBackfillJob owning Pre-Return Pause + failed transition", () => {
      const start = workerSource.indexOf("async function finalizeBackfillJob(");
      // Find end as the next top-level async function declaration
      const rest = workerSource.substring(start + 1);
      const nextFn = rest.indexOf("\nasync function ");
      const end = nextFn >= 0 ? start + 1 + nextFn : workerSource.length;
      const body = workerSource.substring(start, end);

      // v0.4.0 PR7c: Pre-Return Pause + memory gate は shared helper に抽出された。
      //   旧: worker.pause(true) + setImmediate(performMemoryCheckAndExit) をここで直接実行
      //   新: applyPreReturnPauseAndMemoryGate() 一行で内包
      // v0.4.0 PR7c: Pre-Return Pause + memory gate is now consolidated in a shared
      //   helper, so finalizeBackfillJob delegates instead of inlining pause/exit.
      expect(body).toContain("applyPreReturnPauseAndMemoryGate");
      expect(body).toContain("_workerInstanceRef");
      expect(body).toContain("_preReturnPauseEnabled");

      // Failed-transition logic remains inside finalizeBackfillJob
      expect(body).toContain("isFinalAttempt");
      expect(body).toContain("job.attemptsMade >= (job.opts.attempts ?? 1)");

      // Legacy direct references must be absent
      expect(body).not.toContain("_workerInstanceRef.pause(true)");
      expect(body).not.toContain("performMemoryCheckAndExit");
    });

    it("should keep processBackfillJob as a thin orchestrator", () => {
      const start = workerSource.indexOf("async function processBackfillJob(");
      // End before the "Worker Factory" comment banner
      const end = workerSource.indexOf("// Worker Factory", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const body = workerSource.substring(start, end);
      // Orchestrator should delegate to the 3 helpers
      expect(body).toContain("validateJobData(job)");
      expect(body).toContain("initiateBackfillJob(job)");
      expect(body).toContain("finalizeBackfillJob(job");
      // Orchestrator should NOT directly call EmbeddingBackfillJobDataSchema.parse
      expect(body).not.toContain("EmbeddingBackfillJobDataSchema.parse");
      // Orchestrator should NOT directly call the Strategy Pattern dispatch
      expect(body).not.toContain("getBackfillProcessor");
      // Orchestrator should NOT directly call the Pre-Return Pause
      expect(body).not.toContain("_workerInstanceRef.pause(true)");
    });

    it("should export the split helpers for unit tests", () => {
      const exportBlock = workerSource.match(/\/\/ 単体テスト用のみ[\s\S]*?export \{[\s\S]*?\};/);
      expect(exportBlock).not.toBeNull();
      const body = exportBlock?.[0] ?? "";
      expect(body).toContain("initiateBackfillJob");
      expect(body).toContain("finalizeBackfillJob");
      expect(body).toContain("validateJobData");
    });

    // ========================================================================
    // v0.4.0 PR7c M8: _preReturnPauseEnabled=false 経路のセマンティクス
    // v0.4.0 PR7c M8: semantics for _preReturnPauseEnabled=false path
    // ========================================================================
    it("should import applyPreReturnPauseAndMemoryGate helper (PR7c)", () => {
      // Helper import line must exist — source of truth for the new lifecycle
      expect(workerSource).toMatch(/from ["']\.\/shared\/post-job-lifecycle["']/);
      expect(workerSource).toContain("applyPreReturnPauseAndMemoryGate");
    });

    it("should derive _preReturnPauseEnabled from WORKER_MAX_JOBS_BEFORE_RESTART > 0 (PR7c M8)", () => {
      // The flag must remain env-driven so WORKER_MAX_JOBS_BEFORE_RESTART=0
      // disables the pause/resume/exit lifecycle entirely.
      expect(workerSource).toMatch(
        /_preReturnPauseEnabled\s*=\s*safeParseInt\(process\.env\.WORKER_MAX_JOBS_BEFORE_RESTART,\s*1\)\s*>\s*0/
      );
    });

    it("should NOT reintroduce legacy performMemoryCheckAndExit import (PR7c)", () => {
      // performMemoryCheckAndExit is now invoked inside the shared helper.
      // Direct imports in this worker would bypass the pause/resume gate.
      expect(workerSource).not.toMatch(
        /import \{[^}]*performMemoryCheckAndExit[^}]*\} from ["']\.\.\/services\/worker-memory-monitor\.service["']/
      );
    });
  });

  // ============================================================================
  // v0.4.0 PR7b (TPA Low-1 / TDA carryover): computeRemainingStatus 7-category
  // ============================================================================

  describe("computeRemainingStatus 7-category (PR7b TPA Low-1)", () => {
    let computeFn: string;
    beforeAll(() => {
      const start = workerSource.indexOf(
        "async function computeRemainingStatus(webPageId: string)"
      );
      const end = workerSource.indexOf("async function updateEmbeddingBackfillStatus(", start);
      computeFn = workerSource.substring(start, end);
    });

    it("should query all 7 categories (part_text, part_visual, section_visual, motion, background, js_animation, responsive)", () => {
      // part_text: prisma.componentPart.count
      expect(computeFn).toContain("prisma.componentPart.count");
      // part_visual: countPartVisualBackfillTargets
      expect(computeFn).toContain("countPartVisualBackfillTargets");
      // section_visual: raw SQL on section_embeddings
      expect(computeFn).toContain("section_embeddings se");
      expect(computeFn).toContain("vision_embedding IS NULL");
      // motion: prisma.motionPattern.count
      expect(computeFn).toContain("prisma.motionPattern.count");
      // background: prisma.backgroundDesign.count
      expect(computeFn).toContain("prisma.backgroundDesign.count");
      // js_animation: prisma.jSAnimationPattern.count
      expect(computeFn).toContain("prisma.jSAnimationPattern.count");
      // responsive: prisma.responsiveAnalysis.count
      expect(computeFn).toContain("prisma.responsiveAnalysis.count");
    });

    it("should sum all 7 pending counts and return 'completed' only when all zero", () => {
      // 全 7 件の pending を totalPending に集約
      // All 7 pending counts aggregated into totalPending
      expect(computeFn).toContain("partTextPending");
      expect(computeFn).toContain("partVisualPending.pendingCount");
      expect(computeFn).toContain("sectionVisualCount");
      expect(computeFn).toContain("motionPending");
      expect(computeFn).toContain("backgroundPending");
      expect(computeFn).toContain("jsAnimationPending");
      expect(computeFn).toContain("responsivePending");
      expect(computeFn).toMatch(/totalPending === 0 \?\s*"completed"\s*:\s*"in_progress"/);
    });

    it("should filter out high-PII parts in part_text count (GDPR Art. 5(1)(c))", () => {
      // part_text の WHERE 句に piiRiskLevel: { not: "high" } を含む
      // part_text WHERE clause includes piiRiskLevel: { not: "high" }
      expect(computeFn).toMatch(/piiRiskLevel:\s*\{\s*not:\s*["']high["']/);
    });

    it("should use Promise.all for parallel category queries", () => {
      expect(computeFn).toContain("Promise.all([");
    });

    it("should defend against bigint/NaN parsing for raw SQL counts (TPA Low-1)", () => {
      // parseBigint helper handles bigint / non-finite / negative values
      // parseBigint ヘルパーが bigint / 非有限 / 負値を防御
      expect(computeFn).toContain("Number.isFinite(n)");
      expect(computeFn).toContain("parseBigint");
    });
  });
});
