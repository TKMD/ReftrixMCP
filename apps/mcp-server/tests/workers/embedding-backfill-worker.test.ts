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

  describe("Post-Job Memory Gate (v0.4.0 PR7c + β2 audit carryover)", () => {
    it("should read WORKER_MAX_JOBS_BEFORE_RESTART env var", () => {
      expect(workerSource).toContain("process.env.WORKER_MAX_JOBS_BEFORE_RESTART");
    });

    it("should delegate post-job memory gate to applyPostJobMemoryGate (PR7e-β2 audit)", () => {
      // v0.4.0 PR7c: pause(true) + performMemoryCheckAndExit は shared helper に移動
      //   旧: finalizeBackfillJob 内で _workerInstanceRef.pause(true) + setImmediate(...) 直呼び
      //   新: applyPostJobMemoryGate() 一本化
      // v0.4.0 PR7e-β2 hotfix: pause/resume を完全削除
      // v0.4.0 PR7e-β2 audit carryover: helper を applyPostJobMemoryGate にリネームし、
      //   workerRef 引数も削除
      // Helper invocations now use the renamed, simplified signature.
      expect(workerSource).toContain("applyPostJobMemoryGate");
      // Legacy name must not remain anywhere in the worker source.
      expect(workerSource).not.toContain("applyPreReturnPauseAndMemoryGate");
    });
  });

  describe("Memory defense (v0.4.0 PR7c + β2 audit carryover)", () => {
    it("should delegate post-job memory check to the shared helper", () => {
      // applyPostJobMemoryGate internally calls shouldExitForMemory() and
      //   - process.exit(0) if above threshold
      //   - no-op if below threshold (PR7e-β2 hotfix: pause/resume removed — BullMQ
      //     mainLoop fetches the next job naturally)
      expect(workerSource).toContain("applyPostJobMemoryGate");
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
    it("should truncate webPageId in logs via SSOT-derived TARGET_ID_TRUNCATE_LENGTH", () => {
      // Wave 5 LCC canonical CWE-209 PII protection pattern (FIND-IMPL-LCC-PATCH-W5-02
      // anchor 019df7ab-2f5a): all logger calls involving webPageId MUST derive the
      // truncation length from `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` SSOT,
      // NOT a hardcoded literal `slice(0, 8)`. See `.claude/rules/security.md`
      // §Canonical CWE-209 PII Protection Pattern (LCC-endorsed).
      //
      // The canonical surface is:
      //   webPageId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "..."
      //
      // CO-21 closure (Wave 4 V4, 2026-05-13): the previously-residual
      // `webPageId.slice(0, 8)` literal in the job.log() start interpolation
      // at line ~833 of `apps/mcp-server/src/workers/embedding-backfill-worker.ts`
      // has been migrated to the SSOT-derived form. All callsites in the worker
      // now satisfy the canonical contract above. See root CHANGELOG entry
      // [Wave-4-V4-2026-05-13] for the full migration record.
      expect(workerSource).toMatch(
        /webPageId\.slice\(0,\s*AUDIT_LOG_CONSTANTS\.TARGET_ID_TRUNCATE_LENGTH\)\s*\+\s*"\.\.\."/
      );
    });

    it("should import AUDIT_LOG_CONSTANTS SSOT from audit-log.service", () => {
      // SSOT import precondition for the PII truncation pattern above.
      expect(workerSource).toMatch(/AUDIT_LOG_CONSTANTS/);
      expect(workerSource).toMatch(/from ["']\.\.\/services\/audit-log\.service["']/);
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

    it("should declare finalizeBackfillJob owning Post-Job Memory Gate + failed transition (Plan v1.1 candidate B / ADR-0034 Amendment 5)", () => {
      const start = workerSource.indexOf("async function finalizeBackfillJob(");
      // Find end as the next top-level async function declaration
      const rest = workerSource.substring(start + 1);
      const nextFn = rest.indexOf("\nasync function ");
      const end = nextFn >= 0 ? start + 1 + nextFn : workerSource.length;
      const body = workerSource.substring(start, end);

      // Plan v1.1 candidate B (ADR-0034 Amendment 5) で Stage 2
      // `worker.pause(true)` を formal removal。success path も failure path も
      // `applyPostJobMemoryGate` のみを呼ぶ統一構造に変更。`applyPostJobLifecycleGate`
      // および `_workerInstanceRef` の参照は finalizeBackfillJob から削除された。
      //
      // Plan v1.1 candidate B (ADR-0034 Amendment 5): Stage 2 `worker.pause(true)`
      // is formally removed. Both success and failure paths invoke only
      // `applyPostJobMemoryGate`. References to `applyPostJobLifecycleGate` and
      // `_workerInstanceRef` are removed from finalizeBackfillJob.
      expect(body).toContain("applyPostJobMemoryGate"); // unified success + failure path
      expect(body).toContain("_preReturnPauseEnabled");

      // Failed-transition logic remains inside finalizeBackfillJob
      expect(body).toContain("isFinalAttempt");
      expect(body).toContain("job.attemptsMade >= (job.opts.attempts ?? 1)");

      // Plan v1.1 candidate B: legacy references must be absent
      expect(body).not.toContain("_workerInstanceRef.pause(true)");
      expect(body).not.toContain("performMemoryCheckAndExit");
      // Legacy helper name must not remain
      expect(body).not.toContain("applyPreReturnPauseAndMemoryGate");
      // Plan v1.1 candidate B: `applyPostJobLifecycleGate` callsite is removed
      // from finalizeBackfillJob (helper itself remains as no-op stub for
      // legacy test-caller backward compat per ADR-0034 Amendment 5 §Decision 4).
      expect(body).not.toMatch(/applyPostJobLifecycleGate\s*\(/);
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
    it("should import applyPostJobMemoryGate helper (PR7c + β2 audit carryover)", () => {
      // Helper import line must exist — source of truth for the post-job lifecycle.
      // v0.4.0 PR7e-β2 audit carryover: renamed to applyPostJobMemoryGate, legacy
      //   name applyPreReturnPauseAndMemoryGate must not reappear anywhere.
      expect(workerSource).toMatch(/from ["']\.\/shared\/post-job-lifecycle["']/);
      expect(workerSource).toContain("applyPostJobMemoryGate");
      expect(workerSource).not.toContain("applyPreReturnPauseAndMemoryGate");
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

  describe("computeRemainingStatus 7-category (PR7b TPA Low-1 / PR7e-β2 carryover SSOT)", () => {
    // v0.4.0 PR7e-β2 carryover (SSOT unification):
    // 実装は `services/backfill-status.helper.ts` の
    // `computeRemainingStatusWithPrisma` に委譲済み。worker の wrapper は
    // `return computeRemainingStatusWithPrisma(webPageId, prisma)` 1 行のみ。
    // 7 カテゴリ SQL / Promise.all / bigint 防御の構造検証は helper 側で行うため、
    // ここでは wrapper が helper に委譲していることと、SSOT import がある
    // ことを検証する。詳細ロジックの回帰は
    // `tests/services/backfill-status.helper.test.ts` でカバー。
    //
    // v0.4.0 PR7e-β2 carryover (SSOT unification):
    // The implementation was delegated to
    // `computeRemainingStatusWithPrisma` in `services/backfill-status.helper.ts`.
    // The worker wrapper is now a single-line passthrough. Structural checks
    // for the 7-category SQL, Promise.all, and bigint defense live in the
    // helper tests; here we only verify the wrapper delegates and imports the
    // SSOT helper. Full regression coverage lives in
    // `tests/services/backfill-status.helper.test.ts`.
    let helperSource: string;
    beforeAll(() => {
      const helperPath = path.resolve(__dirname, "../../src/services/backfill-status.helper.ts");
      helperSource = fs.readFileSync(helperPath, "utf8");
    });

    it("worker wrapper delegates to computeRemainingStatusWithPrisma (SSOT)", () => {
      // Wrapper は helper を import して呼び出すこと。PR-D-4 で `verifyCategoryParity`
      // + `CategoryPendingSnapshot` も同じ helper から import するため、import 文
      // は multi-line に拡張された。identifier 単位で検証する (exact-string 検証は
      // import が同一 module からかどうかを分離検証)。
      // Wrapper must import and invoke the helper. PR-D-4 also imports
      // `verifyCategoryParity` and `CategoryPendingSnapshot` from the same
      // helper, so the import statement is now multi-line. We assert per
      // identifier + same-module origin separately.
      expect(workerSource).toContain("computeRemainingStatusWithPrisma");
      expect(workerSource).toContain('from "../services/backfill-status.helper"');
      expect(workerSource).toContain("return computeRemainingStatusWithPrisma(webPageId, prisma)");
    });

    it("worker still exports computeRemainingStatus for backward compatibility", () => {
      // 既存 API 契約: test/reconciliation 等の外部 import が破綻しないこと
      // Preserves the existing public API contract so external callers (tests,
      // reconciliation, etc.) keep working.
      expect(workerSource).toMatch(/computeRemainingStatus,\s*\n/);
    });

    it("helper should query all 7 categories (part_text, part_visual, section_visual, motion, background, js_animation, responsive)", () => {
      // part_text: prisma.componentPart.count
      expect(helperSource).toContain("prisma.componentPart.count");
      // part_visual: countPartVisualBackfillTargetsWithPrisma
      expect(helperSource).toContain("countPartVisualBackfillTargetsWithPrisma");
      // section_visual: raw SQL on section_embeddings via the SSOT
      // sectionVisualPendingExclusionPredicate (PR-BT-2: terminal-skip exclusion;
      // the vision_embedding IS NULL conjunct is now inside the predicate fragment,
      // no longer an inline literal in this file).
      expect(helperSource).toContain("section_embeddings se");
      expect(helperSource).toContain('sectionVisualPendingExclusionPredicate("se")');
      // motion: prisma.motionPattern.count
      expect(helperSource).toContain("prisma.motionPattern.count");
      // background: prisma.backgroundDesign.count
      expect(helperSource).toContain("prisma.backgroundDesign.count");
      // js_animation: prisma.jSAnimationPattern.count
      expect(helperSource).toContain("prisma.jSAnimationPattern.count");
      // responsive: prisma.responsiveAnalysis.count
      expect(helperSource).toContain("prisma.responsiveAnalysis.count");
    });

    it("helper should sum all 7 pending counts and return 'completed' only when all zero", () => {
      expect(helperSource).toContain("partTextPending");
      expect(helperSource).toContain("partVisualPending.pendingCount");
      expect(helperSource).toContain("sectionVisualCount");
      expect(helperSource).toContain("motionPending");
      expect(helperSource).toContain("backgroundPending");
      expect(helperSource).toContain("jsAnimationPending");
      expect(helperSource).toContain("responsivePending");
      expect(helperSource).toMatch(/totalPending === 0 \?\s*"completed"\s*:\s*"in_progress"/);
    });

    it("helper should filter out high-PII parts in part_text count (GDPR Art. 5(1)(c))", () => {
      expect(helperSource).toMatch(/piiRiskLevel:\s*\{\s*not:\s*["']high["']/);
    });

    it("helper should use Promise.all for parallel category queries", () => {
      expect(helperSource).toContain("Promise.all([");
    });

    it("helper should defend against bigint/NaN parsing for raw SQL counts (TPA Low-1)", () => {
      expect(helperSource).toContain("Number.isFinite(n)");
      expect(helperSource).toContain("parseBigint");
    });
  });

  // ============================================================================
  // INFRA-EMBEDDING-MOTION-SIGABRT-001 Fix-1: close → dispose ordering
  // (TDA-D-1b-01 H block-equivalent mandatory landing per IO §13.16.4).
  //
  // The previous order `dispose → close` raced with motion-category batches
  // whose final ONNX inference was still in flight. After Fix-1 the BullMQ
  // Worker is closed first so in-flight jobs and their locks resolve before
  // the ONNX session is torn down.
  // ============================================================================

  describe("close ordering (INFRA-EMBEDDING-MOTION-SIGABRT-001 Fix-1)", () => {
    it("should call worker.close() BEFORE disposeEmbeddingPipeline()", () => {
      // Verify ordering by comparing the indices of the actual `await`
      // statements (NOT comment references). `await worker.close()` MUST
      // appear before `await sharedLayoutEmbeddingService.disposeEmbeddingPipeline()`
      // so the BullMQ Worker quiesces in-flight jobs first.
      const awaitWorkerCloseIdx = workerSource.indexOf("await worker.close();");
      const awaitDisposeIdx = workerSource.indexOf(
        "await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();"
      );
      expect(awaitWorkerCloseIdx).toBeGreaterThan(0);
      expect(awaitDisposeIdx).toBeGreaterThan(0);
      expect(awaitWorkerCloseIdx).toBeLessThan(awaitDisposeIdx);
    });

    it("should reference the finding ID in close-block comment (forensic anchor)", () => {
      // Forensic anchor: future audits must trace the ordering decision back
      // to INFRA-EMBEDDING-MOTION-SIGABRT-001 / ADR-0019 directly from source.
      expect(workerSource).toContain("INFRA-EMBEDDING-MOTION-SIGABRT-001");
    });
  });
});
