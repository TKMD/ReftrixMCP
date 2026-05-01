// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PR2 (v0.4.0): page-analyze-worker サイレント skip バグ修正テスト
 * PR2 (v0.4.0): page-analyze-worker silent-skip bug fix tests
 *
 * Phase 5 embedding が以下のケースでサイレントに skip されると、
 * `completedPhases` にも `failedPhases` にも embedding が含まれず、
 * MCP クライアントはジョブを success と誤認していた:
 *   1. Pre-flight: V8 heap headroom < 512MB / System MemAvailable < 8GB
 *   2. Text child fork 例外 / IPC race / exit code != 0
 *   3. Text child error message
 *   4. Visual child 同様の失敗
 *
 * PR2 は page-analyze-worker.ts に以下の 4 つの変更を加える:
 *   A. embeddingPhaseResult.skipReason を failedPhases への push 判定に使用
 *   B. results.embedding.skipReason を常に埋める
 *   C. web_pages.embeddingBackfillStatus を更新する
 *   D. DB reconciliation で IPC race による偽陽性を補正する
 *
 * このテストはソースコード静的検証（他の phase-5-* テストと同じ方式）で
 * 実装の抜け漏れを検知する。
 *
 * This test relies on static source inspection (the same approach used by
 * the existing phase-5-* tests) to detect regressions in the silent-skip fix.
 *
 * @module tests/workers/page-analyze-silent-skip-fix
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

const WORKER_SRC = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");
const TYPES_SRC = path.resolve(__dirname, "../../src/workers/phases/types.ts");
const QUEUE_SRC = path.resolve(__dirname, "../../src/queues/page-analyze-queue.ts");

describe("PR2: page-analyze-worker silent-skip fix", () => {
  let workerSource: string;
  let typesSource: string;
  let queueSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(WORKER_SRC, "utf-8");
    typesSource = fs.readFileSync(TYPES_SRC, "utf-8");
    queueSource = fs.readFileSync(QUEUE_SRC, "utf-8");
  });

  // ==========================================================================
  // A. EmbeddingSkipReason enum の定義
  // A. EmbeddingSkipReason enum definition
  // ==========================================================================
  describe("A. EmbeddingSkipReason enum", () => {
    it("EMBEDDING_SKIP_REASONS が `as const` array でエクスポートされること / exported as `as const` array", () => {
      expect(typesSource).toMatch(
        /export const EMBEDDING_SKIP_REASONS\s*=\s*\[[\s\S]*?\]\s*as const/
      );
    });

    it("EmbeddingSkipReason 型がエクスポートされること / EmbeddingSkipReason type exported", () => {
      expect(typesSource).toMatch(
        /export type EmbeddingSkipReason\s*=\s*\(typeof EMBEDDING_SKIP_REASONS\)/
      );
    });

    it("15 種類のスキップ理由が定義されていること / all 15 skip reasons defined", () => {
      // TDA MEDIUM 1 (v0.4.0 PR2 監査): `dispatch_phase_failed` を追加して
      // 外側 catch での text_fork_failed 誤分類を解消。
      // TDA MEDIUM 1 (v0.4.0 PR2 audit): Added `dispatch_phase_failed` to
      // eliminate outer-catch mis-classification as text_fork_failed.
      //
      // ADR-0018 §Decision 2 (v0.4.0 PR-D-1): `fork_terminated_before_done` と
      // `parity_check_failed` を追加。fork child done 前終了 / terminal
      // transition parity check 失敗に対応。
      // ADR-0018 §Decision 2 (v0.4.0 PR-D-1): Added `fork_terminated_before_done`
      // and `parity_check_failed` for fork child pre-done termination and
      // terminal transition parity check failure.
      //
      // ADR-0018 §Decision 3 Amendment (v0.4.0 PR-D-2): `bbox_invalid` を追加。
      // Part visual embedding ループで boundingBox が invalid (null /
      // non-number / width<=0 / height<=0) により skip された場合の観測用。
      // hand-coded literal array は `typesSource.match()` regex 検証用のため
      // named import 不可。
      // ADR-0018 §Decision 3 Amendment (v0.4.0 PR-D-2): Added `bbox_invalid` for
      // observability when Part visual embedding loop skips due to invalid
      // boundingBox. Hand-coded literal array required for `typesSource.match()`
      // regex verification (named import would erase the source string under
      // verification).
      const required = [
        "v8_heap_headroom_low",
        "system_memavailable_low",
        "text_fork_failed",
        "text_child_error",
        "text_child_abnormal_exit",
        "text_ipc_race",
        "visual_fork_failed",
        "visual_child_error",
        "visual_child_abnormal_exit",
        "visual_ipc_race",
        "no_embeddable_items",
        "dispatch_phase_failed",
        "fork_terminated_before_done",
        "parity_check_failed",
        "bbox_invalid",
      ];
      for (const reason of required) {
        expect(typesSource).toContain(`"${reason}"`);
      }
    });

    it("EmbeddingPhaseResult が skipReason/skipDetail オプションを持つこと / EmbeddingPhaseResult has skipReason/skipDetail", () => {
      const match = typesSource.match(/interface EmbeddingPhaseResult\s*\{[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      const body = match![0];
      expect(body).toMatch(/skipReason\?:\s*EmbeddingSkipReason/);
      expect(body).toMatch(/skipDetail\?:\s*string/);
    });
  });

  // ==========================================================================
  // B. Response schema に skipReason を追加
  // B. Response schema includes skipReason
  // TDA LOW 3 (v0.4.0 PR2 監査): MCP response 側の命名を `skipReason` /
  // `skipDetail` に統一（旧 `skippedReason` / `skippedDetail` は廃止）。
  // TDA LOW 3 (v0.4.0 PR2 audit): Unified MCP response naming to
  // `skipReason` / `skipDetail` (legacy `skippedReason` / `skippedDetail`
  // removed).
  // ==========================================================================
  describe("B. PageAnalyzeJobResult.results.embedding.skipReason", () => {
    it("queue の embedding response 型に skipReason が含まれること / skipReason in queue embedding type", () => {
      // Locate the embedding?: {...} block and ensure skipReason is inside
      const match = queueSource.match(/embedding\?:\s*\{[\s\S]*?\n\s{4}\};/);
      expect(match).not.toBeNull();
      expect(match![0]).toMatch(/skipReason\?:\s*string/);
    });

    it("queue の embedding response 型に skipDetail が含まれること / skipDetail in queue embedding type", () => {
      const match = queueSource.match(/embedding\?:\s*\{[\s\S]*?\n\s{4}\};/);
      expect(match).not.toBeNull();
      expect(match![0]).toMatch(/skipDetail\?:\s*string/);
    });

    it("旧命名 skippedReason / skippedDetail がフィールドとして残っていないこと / legacy skippedReason/skippedDetail field removed", () => {
      // Comment references are allowed (migration notes), but the actual
      // field declarations (`skippedReason?:` / `skippedDetail?:`) must be
      // gone. Match `fieldName?:` to avoid matching words inside comments.
      expect(queueSource).not.toMatch(/\bskippedReason\?\s*:/);
      expect(queueSource).not.toMatch(/\bskippedDetail\?\s*:/);
    });
  });

  // ==========================================================================
  // C. page-analyze-worker: サイレント skip 検知ロジック
  // C. page-analyze-worker: silent-skip detection logic
  // ==========================================================================
  describe("C. silent-skip detection", () => {
    it("observedSkipReason 変数が宣言されること / observedSkipReason variable declared", () => {
      expect(workerSource).toMatch(
        /let observedSkipReason:\s*EmbeddingSkipReason\s*\|\s*undefined/
      );
    });

    it("skipReason 存在時に failedPhases へ push すること / pushes failedPhases when skipReason present", () => {
      // Expect the detection branch in processPageAnalyzeJob:
      //   embeddingPhaseResult.skipReason !== undefined
      //   ...failedPhases.push("embedding")
      expect(workerSource).toMatch(
        /embeddingPhaseResult\.skipReason\s*!==\s*undefined[\s\S]{0,600}failedPhases\.push/
      );
    });

    it("totalEmbeddingsGenerated === 0 の条件が存在すること / checks totalEmbeddingsGenerated === 0", () => {
      expect(workerSource).toMatch(/totalEmbeddingsGenerated\s*===\s*0/);
    });

    it("results.embedding.skipReason に観測値を格納すること / sets results.embedding.skipReason", () => {
      expect(workerSource).toMatch(
        /results\.embedding\.skipReason\s*=\s*observedSkipReason|embedding\.skipReason\s*=\s*observedSkipReason/
      );
    });

    it("Silent-skip 検知時に job.log と logger.warn を呼ぶこと / emits job.log and logger.warn on silent skip", () => {
      expect(workerSource).toMatch(/Silent skip detected/);
      expect(workerSource).toMatch(/Phase 5 silently skipped/);
    });
  });

  // ==========================================================================
  // D. web_pages.embeddingBackfillStatus 更新
  // D. web_pages.embeddingBackfillStatus update
  // ==========================================================================
  describe("D. embeddingBackfillStatus update", () => {
    it("skipReasonToBackfillStatus ヘルパーが存在すること / skipReasonToBackfillStatus helper exists", () => {
      expect(workerSource).toMatch(/function skipReasonToBackfillStatus/);
    });

    it("v8_heap_headroom_low と system_memavailable_low が skipped_memory_pressure にマップされること / heap/memavail → memory_pressure", () => {
      const match = workerSource.match(/function skipReasonToBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      const body = match![0];
      expect(body).toMatch(/case "v8_heap_headroom_low":[\s\S]*?return "skipped_memory_pressure"/);
      expect(body).toMatch(/case "system_memavailable_low":/);
    });

    it("fork/child 系スキップが skipped_fork_error にマップされること / fork/child → fork_error", () => {
      const match = workerSource.match(/function skipReasonToBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      const body = match![0];
      expect(body).toMatch(/case "text_fork_failed":/);
      expect(body).toMatch(/case "text_child_error":/);
      expect(body).toMatch(/case "visual_ipc_race":/);
      expect(body).toMatch(/case "dispatch_phase_failed":[\s\S]*?return "skipped_fork_error"/);
    });

    it("dispatch_phase_failed が skipped_fork_error にマップされること / dispatch_phase_failed → fork_error (TDA MEDIUM 1)", () => {
      // TDA MEDIUM 1 (v0.4.0 PR2 監査): 外側 catch は `dispatch_phase_failed`
      // を使い、fork/child 系と同じ backfill retry 経路に流す。
      // TDA MEDIUM 1 (v0.4.0 PR2 audit): The outer catch uses
      // `dispatch_phase_failed`, funneled through the same backfill retry
      // path as fork/child skips.
      const match = workerSource.match(/function skipReasonToBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      expect(match![0]).toMatch(/case "dispatch_phase_failed":/);
    });

    it("fork_terminated_before_done が skipped_fork_error にマップされること / fork_terminated_before_done → fork_error (ADR-0018 §Decision 2, PR-D-1 UC-2)", () => {
      // ADR-0018 §Decision 2 (v0.4.0 PR-D-1, TPA CA-1 UC-2): Fork child が
      // `done` IPC message 送信前に終了した場合 (非ゼロ exit / signal /
      // heartbeat timeout / IPC disconnect) に `fork_terminated_before_done`
      // を設定する。mapping は既存 fork/child 系と同じ `skipped_fork_error`
      // ルート (backfill queue 経由で retry、最終的に `failed` 永続化)。
      //
      // 本 test は AST レベルで case label の存在 + return 値を verify する。
      // 最終 state `embeddingBackfillStatus='failed'` への遷移は既存の backfill
      // worker / reconciliation service で契約 (`skipped_fork_error` → `failed`
      // は `backfill-reconciliation.service.ts` L283/559/621/758 で保証)。
      //
      // ADR-0018 §Decision 2 (v0.4.0 PR-D-1, TPA CA-1 UC-2): When fork child
      // terminates before sending the `done` IPC message (non-zero exit /
      // signal / heartbeat timeout / IPC disconnect), set
      // `fork_terminated_before_done`. Maps to `skipped_fork_error` (same
      // retry path as existing fork/child-originated reasons).
      //
      // This test verifies case label existence + return value at AST level.
      // Terminal transition to `embeddingBackfillStatus='failed'` is
      // contracted by the existing backfill worker / reconciliation service
      // (`skipped_fork_error` → `failed` guaranteed by
      // `backfill-reconciliation.service.ts` L283/559/621/758).
      const match = workerSource.match(/function skipReasonToBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      const body = match![0];
      expect(body).toMatch(/case "fork_terminated_before_done":/);
      // Stacked-case pattern: 同一ブロックが "skipped_fork_error" を return する
      // ことを確認する (fork/child-family と同じ block 内に落ちる)。
      // Stacked-case pattern: verify the shared block returns
      // "skipped_fork_error" (falls into the same block as fork/child family).
      expect(body).toMatch(
        /case "fork_terminated_before_done":[\s\S]*?return "skipped_fork_error"/
      );
    });

    it("bbox_invalid が skipped_fork_error にマップされること / bbox_invalid → fork_error (ADR-0018 §Decision 3 Amendment, PR-D-2 UC-01 Option D)", () => {
      // ADR-0018 §Decision 3 Amendment (v0.4.0 PR-D-2, IO Registry UC-01):
      // Part visual embedding loop で boundingBox が invalid (null /
      // non-number / width<=0 / height<=0) により skip された場合に
      // `bbox_invalid` を設定する。mapping は既存 `skipped_fork_error`
      // ルート (retry bucket 対象、GDPR Art.5(1)(d) accuracy 遵守)。
      // `skipped_screenshot_missing` は retry excluded のため採用不可
      // (IO Registry UC-01 Option B 撤回、Option D 採用)。
      //
      // ADR-0018 §Decision 3 Amendment (v0.4.0 PR-D-2, IO Registry UC-01):
      // When Part visual embedding loop skips due to invalid boundingBox
      // (null / non-number / width<=0 / height<=0), set `bbox_invalid`. Maps
      // to `skipped_fork_error` (retry bucket, per GDPR Art.5(1)(d) accuracy).
      // `skipped_screenshot_missing` rejected (retry-excluded; IO Registry
      // UC-01 Option B withdrawn in favor of Option D).
      const match = workerSource.match(/function skipReasonToBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      const body = match![0];
      expect(body).toMatch(/case "bbox_invalid":/);
      expect(body).toMatch(/case "bbox_invalid":[\s\S]*?return "skipped_fork_error"/);
    });

    it("parity_check_failed が skipped_fork_error にマップされること / parity_check_failed → fork_error (ADR-0018 §Decision 2, PR-D-1 UC-2)", () => {
      // ADR-0018 §Decision 2 / §Decision 4 / §Migration Path Step 4
      // (v0.4.0 PR-D-1, TPA CA-1 UC-2): terminal transition 直前の
      // `SELECT COUNT(*) FROM component_part_embeddings` が
      // `returnvalue.generatedCount` と不一致の場合、
      // `parity_check_failed` を設定し `skipped_fork_error` にマップ。
      // backfill queue で retry → 再実行で整合性回復を試み、3 回 retry で
      // `failed` 永続化 (INV-EMBEDDING-INTEGRITY-001 契約)。
      //
      // ADR-0018 §Decision 2 / §Decision 4 / §Migration Path Step 4
      // (v0.4.0 PR-D-1, TPA CA-1 UC-2): When the pre-terminal
      // `SELECT COUNT(*) FROM component_part_embeddings` mismatches
      // `returnvalue.generatedCount`, set `parity_check_failed` and map to
      // `skipped_fork_error`. Retries via backfill queue; after 3 retries
      // persists as `failed` (INV-EMBEDDING-INTEGRITY-001 contract).
      const match = workerSource.match(/function skipReasonToBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      const body = match![0];
      expect(body).toMatch(/case "parity_check_failed":/);
      expect(body).toMatch(/case "parity_check_failed":[\s\S]*?return "skipped_fork_error"/);
    });

    it("no_embeddable_items が not_required にマップされること / no_embeddable_items → not_required", () => {
      const match = workerSource.match(/function skipReasonToBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      expect(match![0]).toMatch(/case "no_embeddable_items":[\s\S]*?return "not_required"/);
    });

    it("exhaustiveness check (never) が含まれること / exhaustiveness check via never", () => {
      const match = workerSource.match(/function skipReasonToBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      expect(match![0]).toMatch(/const\s+_exhaustive:\s*never\s*=\s*reason/);
    });

    it("updateEmbeddingBackfillStatus が prisma.webPage.update を呼ぶこと / invokes prisma.webPage.update", () => {
      const match = workerSource.match(/async function updateEmbeddingBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      expect(match![0]).toMatch(/prisma\.webPage\.update/);
      expect(match![0]).toMatch(/embeddingBackfillStatus:\s*status/);
    });

    it("DB 更新失敗が非致命的で warn ログのみ出力すること / DB failure is non-fatal (warn only)", () => {
      const match = workerSource.match(/async function updateEmbeddingBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      expect(match![0]).toMatch(/catch[\s\S]*?logger\.warn/);
    });

    it("updateEmbeddingBackfillStatus が processPageAnalyzeJob から呼ばれること / called from processPageAnalyzeJob", () => {
      expect(workerSource).toMatch(
        /observedSkipReason\s*!==\s*undefined[\s\S]{0,1500}updateEmbeddingBackfillStatus/
      );
    });
  });

  // ==========================================================================
  // E. DB reconciliation による IPC race 偽陽性の補正
  // E. DB reconciliation corrects false positive caused by IPC race
  // ==========================================================================
  describe("E. IPC race false-positive correction via DB reconciliation", () => {
    it("reconciliation ブロックが失敗フェーズから embedding を除去できること / can remove embedding from failedPhases", () => {
      expect(workerSource).toMatch(
        /dbTotal\s*>\s*0[\s\S]{0,400}failedPhases\s*=\s*state\.failedPhases\.filter/
      );
    });

    it("reconciliation 後に completedPhases.push が呼ばれること / pushes to completedPhases after reconciliation", () => {
      expect(workerSource).toMatch(
        /dbTotal\s*>\s*0[\s\S]{0,800}completedPhases\.push\(\s*["']embedding["']/
      );
    });

    it("reconciliation 後に skipReason を削除すること / clears skipReason on correction", () => {
      expect(workerSource).toMatch(
        /dbTotal\s*>\s*0[\s\S]{0,800}delete\s+results\.embedding\.skipReason/
      );
    });
  });

  // ==========================================================================
  // F. MemoryAbort パスも skipReason を伝搬すること
  // F. MemoryAbort path also propagates skipReason
  // ==========================================================================
  describe("F. memoryAbort path propagation", () => {
    it("memoryAbort 時に observedSkipReason='v8_heap_headroom_low' を設定すること / memoryAbort sets v8_heap_headroom_low", () => {
      expect(workerSource).toMatch(
        /memoryAbortEmbedding\s*=\s*true[\s\S]{0,400}observedSkipReason\s*=\s*["']v8_heap_headroom_low["']/
      );
    });
  });

  // ==========================================================================
  // G. dispatchEmbeddingPhase の外側 catch も skipReason を保持
  // G. outer catch of dispatchEmbeddingPhase preserves skipReason
  // ==========================================================================
  describe("G. outer catch preserves skipReason", () => {
    it("dispatchEmbeddingPhase の外側 catch が observedSkipReason を設定すること / outer catch sets observedSkipReason", () => {
      expect(workerSource).toMatch(
        /catch\s*\(embeddingError\)[\s\S]{0,2000}observedSkipReason\s*===\s*undefined/
      );
    });

    it("外側 catch が dispatch_phase_failed をフォールバックとして使うこと / outer catch falls back to dispatch_phase_failed (TDA MEDIUM 1)", () => {
      // TDA MEDIUM 1 (v0.4.0 PR2 監査): 旧実装では `text_fork_failed` 固定で
      // Visual 側経路の例外を誤分類するリスクがあった。汎用分類
      // `dispatch_phase_failed` に差し替える。
      // TDA MEDIUM 1 (v0.4.0 PR2 audit): The previous implementation
      // hard-coded `text_fork_failed`, risking mis-classification of Visual
      // path exceptions. Replaced with the generic `dispatch_phase_failed`.
      expect(workerSource).toMatch(
        /catch\s*\(embeddingError\)[\s\S]{0,2500}observedSkipReason\s*=\s*["']dispatch_phase_failed["']/
      );
    });

    it("外側 catch で text_fork_failed が使われないこと / outer catch no longer uses text_fork_failed", () => {
      // Guard regression: search the outer `catch (embeddingError)` block
      // only (closed by the `await job.log` that ends that catch) and make
      // sure no `observedSkipReason = "text_fork_failed"` lives inside it.
      const catchBlockMatch = workerSource.match(
        /catch\s*\(embeddingError\)\s*\{[\s\S]*?await\s+job\.log\(`\[Phase 5\] Embedding failed:/
      );
      expect(catchBlockMatch).not.toBeNull();
      expect(catchBlockMatch![0]).not.toMatch(/observedSkipReason\s*=\s*["']text_fork_failed["']/);
    });
  });

  // ==========================================================================
  // H. sanitizeErrorMessage を使用すること (CWE-209)
  // H. Uses sanitizeErrorMessage (CWE-209)
  // ==========================================================================
  describe("H. sanitizeErrorMessage (CWE-209)", () => {
    it("updateEmbeddingBackfillStatus が sanitizeErrorMessage を使うこと / updateEmbeddingBackfillStatus uses sanitizeErrorMessage", () => {
      const match = workerSource.match(/async function updateEmbeddingBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      expect(match![0]).toMatch(/sanitizeErrorMessage/);
    });

    it("外側 catch が sanitizeErrorMessage を使うこと / outer catch uses sanitizeErrorMessage", () => {
      expect(workerSource).toMatch(
        /catch\s*\(embeddingError\)\s*\{[\s\S]{0,200}sanitizeErrorMessage\(embeddingError\)/
      );
    });
  });

  // ==========================================================================
  // I. PII truncation on backfill status logs
  // ==========================================================================
  describe("I. PII truncation", () => {
    it("updateEmbeddingBackfillStatus が webPageId を truncate すること / updateEmbeddingBackfillStatus truncates webPageId", () => {
      const match = workerSource.match(/async function updateEmbeddingBackfillStatus[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      // Must not log full UUID — uses .slice(0, 8) + "..." pattern
      expect(match![0]).toMatch(/webPageId\.slice\(0,\s*8\)\s*\+\s*["']\.\.\.["']/);
    });
  });

  // ==========================================================================
  // J. SKIP_DETAIL_MAX_LENGTH / truncateSkipDetail (LCC 推奨 1, v0.4.0 PR2 監査)
  // J. SKIP_DETAIL_MAX_LENGTH / truncateSkipDetail (LCC recommendation 1)
  // ==========================================================================
  describe("J. truncateSkipDetail / SKIP_DETAIL_MAX_LENGTH", () => {
    it("SKIP_DETAIL_MAX_LENGTH が 200 として export されること / SKIP_DETAIL_MAX_LENGTH exported as 200", () => {
      expect(typesSource).toMatch(/export const SKIP_DETAIL_MAX_LENGTH\s*=\s*200\s*;/);
    });

    it("truncateSkipDetail ヘルパーが export されること / truncateSkipDetail helper exported", () => {
      expect(typesSource).toMatch(/export function truncateSkipDetail\s*\(/);
    });

    it("ヘルパーの実装を確認 / verify helper runtime behavior", async () => {
      const typesModule = await import("../../src/workers/phases/types");
      const { truncateSkipDetail, SKIP_DETAIL_MAX_LENGTH } = typesModule;
      expect(SKIP_DETAIL_MAX_LENGTH).toBe(200);
      // 短い入力はそのまま / short input unchanged
      expect(truncateSkipDetail("short")).toBe("short");
      // 200 文字はそのまま / exactly 200 chars kept as-is
      const exact = "a".repeat(200);
      expect(truncateSkipDetail(exact)).toBe(exact);
      expect(truncateSkipDetail(exact).length).toBe(200);
      // 201 文字以上は 200 文字以内に切り詰められる / longer strings truncated to <= 200
      const tooLong = "b".repeat(500);
      const truncated = truncateSkipDetail(tooLong);
      expect(truncated.length).toBeLessThanOrEqual(200);
      expect(truncated.endsWith("...")).toBe(true);
      // 日本語などマルチバイト文字でも 200 文字以内 / multibyte still capped at <=200 chars
      const japaneseTooLong = "あ".repeat(500);
      const jaTruncated = truncateSkipDetail(japaneseTooLong);
      expect(jaTruncated.length).toBeLessThanOrEqual(200);
    });

    it("setSkipReasonIfUnset が truncateSkipDetail を使うこと / setSkipReasonIfUnset applies truncateSkipDetail", () => {
      const forkSrcPath = path.resolve(
        __dirname,
        "../../src/workers/phases/phase-5-fork-orchestrator.ts"
      );
      const forkSource = fs.readFileSync(forkSrcPath, "utf-8");
      const match = forkSource.match(/function setSkipReasonIfUnset[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      expect(match![0]).toMatch(/truncateSkipDetail\(detail\)/);
    });

    it("外側 catch で truncateSkipDetail が適用されること / outer catch applies truncateSkipDetail (worker)", () => {
      expect(workerSource).toMatch(/observedSkipDetail\s*=\s*truncateSkipDetail\(errorDetail\)/);
    });

    it("memoryAbort パスでも truncateSkipDetail が適用されること / memoryAbort path applies truncateSkipDetail", () => {
      expect(workerSource).toMatch(
        /observedSkipDetail\s*=\s*truncateSkipDetail\([\s\S]{0,200}worker RSS=/
      );
    });
  });
});
