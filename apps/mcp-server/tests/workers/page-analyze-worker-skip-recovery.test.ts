// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * v0.4.0 PR7b (ADR-0008): page-analyze-worker — Skip Recovery 静的検証テスト
 * v0.4.0 PR7b (ADR-0008): page-analyze-worker — Skip Recovery static checks
 *
 * Phase 5 全体 skip 検出時に全 7 カテゴリを `embedding-backfill` Queue へ
 * enqueue する `dispatchSkipRecoveryBackfill` の実装が以下を満たすことを
 * ソース静的検証で確認する:
 *
 *   1. retry cap (5) 超過時に `failed` 固定 + audit log
 *   2. back-pressure 超過時に `skipped_*` のまま残し cron 補完に委譲
 *   3. CAS guard で skipped_* / in_progress → queued 遷移
 *   4. memory_pressure 経路で `delay` を付与
 *   5. fork_error 経路は `delay` を付与しない
 *   6. screenshot 必須カテゴリ (part_visual / section_visual) は path 確認
 *   7. 全 7 カテゴリ (`EMBEDDING_BACKFILL_CATEGORIES`) を SSOT で参照
 *
 * Static source inspection follows the same pattern as `page-analyze-silent-skip-fix.test.ts`.
 *
 * @module tests/workers/page-analyze-worker-skip-recovery
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

const WORKER_SRC = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");

describe("PR7b: page-analyze-worker skip recovery (ADR-0008)", () => {
  let workerSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(WORKER_SRC, "utf-8");
  });

  describe("Worker 即時 enqueue (ADR-0008 #2)", () => {
    it("dispatchSkipRecoveryBackfill 関数が定義されている / function defined", () => {
      expect(workerSource).toMatch(/async function dispatchSkipRecoveryBackfill\(/);
    });

    it("skipped_fork_error / skipped_memory_pressure 経路から呼び出される / called from both skipped paths", () => {
      // 観点: backfillStatus が skipped_* の場合のみ recovery dispatch
      // Check: recovery dispatch invoked only when backfillStatus is skipped_*
      expect(workerSource).toMatch(
        /backfillStatus === "skipped_fork_error" \|\|\s*backfillStatus === "skipped_memory_pressure"/
      );
      expect(workerSource).toMatch(/await dispatchSkipRecoveryBackfill\(\{/);
    });

    it("全 7 カテゴリ enqueue はヘルパーに委譲 / delegates all-7-categories enqueue to helper (PR7b-convergence TDA H-1/H-2/M-2)", () => {
      // PR7b-convergence (TDA H-1/H-2/M-2): EMBEDDING_BACKFILL_CATEGORIES を使った
      // for ループは Worker から `enqueueAllCategoriesForSkipRecovery` ヘルパーへ
      // 移管された。Worker は `source: "worker"` でヘルパーを呼び出す。
      //
      // PR7b-convergence (TDA H-1/H-2/M-2): The for-loop over
      // `EMBEDDING_BACKFILL_CATEGORIES` has moved from Worker into the
      // `enqueueAllCategoriesForSkipRecovery` helper. Worker calls it with
      // `source: "worker"`.
      expect(workerSource).toContain("enqueueAllCategoriesForSkipRecovery");
      expect(workerSource).toMatch(
        /await enqueueAllCategoriesForSkipRecovery\(queue,\s*\{[\s\S]*?source:\s*["']worker["']/
      );
    });

    it("helper 実装が全 7 カテゴリを SSOT で iterate / helper iterates SSOT (moved from worker)", () => {
      // ヘルパー (embedding-backfill-processors.ts) 側に iteration を移管
      // Iteration moved to the helper (embedding-backfill-processors.ts)
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      const helperSrc = fs.readFileSync(
        path.resolve(__dirname, "../../src/queues/embedding-backfill-processors.ts"),
        "utf-8"
      );
      expect(helperSrc).toContain("EMBEDDING_BACKFILL_CATEGORIES");
      expect(helperSrc).toMatch(/for \(const category of EMBEDDING_BACKFILL_CATEGORIES\)/);
      expect(helperSrc).toMatch(/processor\.requiresScreenshot\(\)/);
      expect(helperSrc).toContain("getBackfillProcessor(category)");
    });
  });

  describe("CAS ガード拡張 (ADR-0008 #9 / SEC HIGH-3)", () => {
    it("WHERE 句に skipped_fork_error / skipped_memory_pressure / in_progress を含む / WHERE includes skipped_* + in_progress", () => {
      // dispatchSkipRecoveryBackfill 内の updateMany が CAS guard を持つ
      // updateMany inside dispatchSkipRecoveryBackfill enforces CAS
      const start = workerSource.indexOf("async function dispatchSkipRecoveryBackfill");
      expect(start).toBeGreaterThan(0);
      // 次の top-level async function 宣言までを抽出（body 全体を確実にカバー）
      // Extract until the next top-level async function declaration (covers full body)
      const rest = workerSource.substring(start + 1);
      const nextFn = rest.indexOf("\nasync function ");
      const end = nextFn >= 0 ? start + 1 + nextFn : workerSource.length;
      const body = workerSource.substring(start, end);
      expect(body).toMatch(/embeddingBackfillStatus:\s*\{\s*in:\s*\[\s*["']skipped_fork_error["']/);
      expect(body).toContain("skipped_memory_pressure");
      expect(body).toContain("in_progress");
    });

    it("queued 遷移時に embeddingBackfillRetryCount を increment する / increments retry count on transition", () => {
      const start = workerSource.indexOf("async function dispatchSkipRecoveryBackfill");
      expect(start).toBeGreaterThan(0);
      // 次の top-level async function 宣言までを抽出（body 全体を確実にカバー）
      // Extract until the next top-level async function declaration (covers full body)
      const rest = workerSource.substring(start + 1);
      const nextFn = rest.indexOf("\nasync function ");
      const end = nextFn >= 0 ? start + 1 + nextFn : workerSource.length;
      const body = workerSource.substring(start, end);
      expect(body).toMatch(/embeddingBackfillRetryCount:\s*\{\s*increment:\s*1\s*\}/);
      expect(body).toMatch(/embeddingBackfillStatus:\s*["']queued["']/);
    });
  });

  describe("retry cap (ADR-0008 #8 / SEC HIGH-1)", () => {
    it("SKIP_RECOVERY_RETRY_CAP = 5 が SSOT から import されている / imported from SSOT (PR7b-convergence TDA M-1)", () => {
      // PR7b-convergence (TDA M-1): SKIP_RECOVERY_RETRY_CAP はローカル const ではなく
      // queues/embedding-backfill-queue.ts の SSOT から import される。
      // backfillPendingSkipRecoverySchema も同じ SSOT を参照するため drift リスクが解消される。
      //
      // PR7b-convergence (TDA M-1): `SKIP_RECOVERY_RETRY_CAP` is imported from the
      // SSOT in `queues/embedding-backfill-queue.ts`, not declared locally.
      // Eliminates drift with `backfillPendingSkipRecoverySchema`.
      expect(workerSource).toMatch(/SKIP_RECOVERY_RETRY_CAP,?\s*$/m);
      // ローカル const 定義は無いこと / No local const declaration
      expect(workerSource).not.toMatch(/^\s*const SKIP_RECOVERY_RETRY_CAP\s*=\s*5/m);
    });

    it("retry cap 超過時に failed 固定 + audit log を呼ぶ / pins to failed + audit log on cap exceeded", () => {
      const start = workerSource.indexOf("async function dispatchSkipRecoveryBackfill");
      expect(start).toBeGreaterThan(0);
      // 次の top-level async function 宣言までを抽出（body 全体を確実にカバー）
      // Extract until the next top-level async function declaration (covers full body)
      const rest = workerSource.substring(start + 1);
      const nextFn = rest.indexOf("\nasync function ");
      const end = nextFn >= 0 ? start + 1 + nextFn : workerSource.length;
      const body = workerSource.substring(start, end);
      expect(body).toMatch(/currentRetryCount\s*>=\s*SKIP_RECOVERY_RETRY_CAP/);
      expect(body).toMatch(/embeddingBackfillStatus:\s*["']failed["']/);
      expect(body).toContain('action: "backfill_retry_exhausted"');
    });
  });

  describe("back-pressure (SEC HIGH-2)", () => {
    it("checkBackfillQueueBackPressure を import + 呼び出す / imports and uses back-pressure check", () => {
      expect(workerSource).toContain("checkBackfillQueueBackPressure");
      expect(workerSource).toMatch(/await checkBackfillQueueBackPressure\(/);
    });

    it("back-pressure 超過時は早期 return で enqueue を抑止 / back-pressure exceeded returns early", () => {
      const start = workerSource.indexOf("async function dispatchSkipRecoveryBackfill");
      expect(start).toBeGreaterThan(0);
      // 次の top-level async function 宣言までを抽出（body 全体を確実にカバー）
      // Extract until the next top-level async function declaration (covers full body)
      const rest = workerSource.substring(start + 1);
      const nextFn = rest.indexOf("\nasync function ");
      const end = nextFn >= 0 ? start + 1 + nextFn : workerSource.length;
      const body = workerSource.substring(start, end);
      expect(body).toMatch(/!backPressure\.allowEnqueue/);
      expect(body).toMatch(/reason:\s*["']back_pressure_exceeded["']/);
    });
  });

  describe("memory_pressure 経路 (ADR-0008 #3)", () => {
    it("resolveMemoryPressureDelayMs を import している / imports memory delay resolver", () => {
      expect(workerSource).toContain("resolveMemoryPressureDelayMs");
    });

    it("skipped_memory_pressure のみ初期 delay を付与する / only memory_pressure path adds initial delay", () => {
      const start = workerSource.indexOf("async function dispatchSkipRecoveryBackfill");
      expect(start).toBeGreaterThan(0);
      // 次の top-level async function 宣言までを抽出（body 全体を確実にカバー）
      // Extract until the next top-level async function declaration (covers full body)
      const rest = workerSource.substring(start + 1);
      const nextFn = rest.indexOf("\nasync function ");
      const end = nextFn >= 0 ? start + 1 + nextFn : workerSource.length;
      const body = workerSource.substring(start, end);
      expect(body).toMatch(
        /backfillStatus === "skipped_memory_pressure" \?\s*resolveMemoryPressureDelayMs\(\) : 0/
      );
    });
  });

  describe("Phase 4 dispose (ADR-0008 #5 / TPA H-2)", () => {
    it("disposePhase4Memory 関数が定義されている / disposePhase4Memory defined", () => {
      expect(workerSource).toMatch(/async function disposePhase4Memory\(/);
    });

    it("Narrative Phase 完了直後に disposePhase4Memory を呼ぶ / called immediately after Phase 4", () => {
      // processNarrativePhase の直後に dispose の呼び出しが現れることを確認
      // Verify dispose call appears immediately after processNarrativePhase
      const idxNarrative = workerSource.indexOf("await processNarrativePhase(state, ctx,");
      const idxDispose = workerSource.indexOf("await disposePhase4Memory(state)");
      expect(idxNarrative).toBeGreaterThan(0);
      expect(idxDispose).toBeGreaterThan(idxNarrative);
      // Memory Check 3 より前に dispose する
      // Dispose before Memory Check 3
      const idxMemCheck3 = workerSource.indexOf("Memory Check 3");
      expect(idxDispose).toBeLessThan(idxMemCheck3);
    });

    it("PR7e-α: state.* への null 代入を撤回し references を保持する / reverts state.* null assignments per ADR-0012", () => {
      const start = workerSource.indexOf("async function disposePhase4Memory");
      expect(start).toBeGreaterThan(0);
      const rest = workerSource.substring(start + 1);
      const nextFn = rest.indexOf("\nasync function ");
      const end = nextFn >= 0 ? start + 1 + nextFn : workerSource.length;
      const body = workerSource.substring(start, end);
      // ADR-0012 / PR7e-α: state.* = null 代入は撤回された（Phase 5 入力を壊していた）。
      // screenshotPngPath 代入も無い（従来どおり）。
      // ADR-0012 / PR7e-α: state.* = null assignments are reverted (they were
      // breaking Phase 5 inputs). screenshotPngPath assignment also absent.
      expect(body).not.toContain("state.layoutResultForNarrative = null");
      expect(body).not.toContain("state.motionResultForEmbedding = null");
      expect(body).not.toContain("state.jsAnimationsForEmbedding = null");
      expect(body).not.toContain("state.scrollVisionResultForEmbedding = null");
      expect(body).not.toContain("state.screenshotPngPath = ");
      // 撤回の根拠が JSDoc に明示されている（ADR-0012 / PR7e-α）。
      // Revert rationale must be documented in JSDoc (ADR-0012 / PR7e-α).
      expect(body).toMatch(/PR7e-α|ADR-0012|Revert/);
    });

    it("GC + 100ms wait + 3 回平均 RSS 測定 / GC + 100ms wait + 3-sample mean", () => {
      const start = workerSource.indexOf("async function disposePhase4Memory");
      expect(start).toBeGreaterThan(0);
      const rest = workerSource.substring(start + 1);
      const nextFn = rest.indexOf("\nasync function ");
      const end = nextFn >= 0 ? start + 1 + nextFn : workerSource.length;
      const body = workerSource.substring(start, end);
      expect(body).toContain("tryGarbageCollect()");
      expect(body).toMatch(/setTimeout\(resolve,\s*100\)/);
      // 3 サンプル loop
      // 3-sample loop
      expect(body).toMatch(/for \(let i = 0; i < 3; i\+\+\)/);
    });
  });

  describe("親 RSS upstream guard (ADR-0008 #4)", () => {
    it("loadPhase5Config / parentRssMaxMb を参照する / loads Phase5Config with parentRssMaxMb", () => {
      expect(workerSource).toContain("loadPhase5Config");
      expect(workerSource).toMatch(/phase5Config\.parentRssMaxMb/);
    });

    it("PR-C3 (系統B): 親 RSS 超過でも skip せず trim + ceiling fallback で fork 継続 / parent-RSS over-cap no longer skips — trim + ceiling fallback proceeds", () => {
      // PR-C3 (CPU true-10/10 plan V1.1 §3.3) supersedes the pre-PR-C3 parent-RSS
      // skip path: the legacy "Parent RSS exceeds Phase 5 ceiling, skipping fork"
      // branch (which set memoryAbortEmbedding=true + observedSkipReason=
      // "system_memavailable_low") is REMOVED and replaced by `trimParentRssAndDecide`
      // (global.gc + re-measure → deterministic ceiling fallback proceed). The
      // authoritative contract now lives in INV-PHASE5-PARENT-RSS-TRIM-001.
      // The legacy skip-on-parent-RSS path must be gone.
      expect(workerSource).not.toContain("Parent RSS exceeds Phase 5 ceiling");
      // The trim helper is wired before the ceiling decision (proceed, never skip
      // on the parent-RSS gate). The hard skip is now only the heap-critical
      // checkMemoryPressure().shouldAbort branch.
      expect(workerSource).toMatch(/trimParentRssAndDecide\s*\(/);
      expect(workerSource).toMatch(/from\s+"\.\/phases\/phase5-parent-rss-trim"/);
    });
  });
});
