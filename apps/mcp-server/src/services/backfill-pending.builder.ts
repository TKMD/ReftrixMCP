// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backfill Pending Builder — Pure function for MCP response `backfillPending`
 *
 * v0.4.0 PR6 TDA TD-3: `page-analyze-worker.ts` 内のインライン構築ロジック（約35行）
 * を pure function に抽出し、worker 本体の複雑度を下げてテスト容易にする。
 *
 * v0.4.0 PR6 TDA TD-3: Extracts the inline `backfillPending` construction logic
 * (~35 lines) from `page-analyze-worker.ts` into a pure function, reducing
 * worker complexity and improving testability.
 *
 * @module services/backfill-pending.builder
 */

import {
  buildBackfillJobId,
  SKIP_RECOVERY_RETRY_CAP,
  type EmbeddingBackfillCategory,
} from "../queues/embedding-backfill-queue";
import type {
  EmbeddingBackfillPending,
  EmbeddingBackfillPendingSkipRecovery,
  EmbeddingBackfillPendingSyncOverflow,
} from "../queues/page-analyze-queue";
import type { EmbeddingSkipReason } from "../workers/phases/types";

/**
 * Input for {@link buildBackfillPending}.
 */
export interface BuildBackfillPendingInput {
  /** Part embedding を保存した件数（Phase 5 DB save 後） / Parts saved during Phase 5 */
  partsSaved: number;
  /** Phase 5 同期フェーズの処理上限（PART_SYNC_THRESHOLD） / Sync phase cap */
  threshold: number;
  /** 1 件あたりの平均処理時間 (ms)（BACKFILL_AVG_MS_PER_ITEM） / Avg per-item ms */
  avgMsPerItem: number;
  /** WebPage ID (UUID v4/v7) */
  webPageId: string;
  /** part_text カテゴリが enqueue されたか / Whether part_text was enqueued */
  enqueuedTextCategory: boolean;
  /** part_visual カテゴリが enqueue されたか / Whether part_visual was enqueued */
  enqueuedVisualCategory: boolean;
  /**
   * v0.4.0 PR7e-α (バグ⑥): section_visual カテゴリが enqueue されたか。
   * 後方互換のため optional (既存呼び出しはそのまま動作)。
   *
   * v0.4.0 PR7e-α (bug ⑥): whether section_visual was enqueued. Optional
   * for backward compatibility (existing callers continue to work).
   */
  enqueuedSectionVisualCategory?: boolean;
}

/**
 * Build the `backfillPending` payload embedded in the `page.analyze` MCP response.
 *
 * Pure function — no DB access, no side effects. Values are clamped so that
 * remainder never goes negative and estimated duration never produces
 * `Infinity` / `NaN`.
 *
 * MCP response に埋め込む `backfillPending` ペイロードを構築する。副作用なし・
 * DB 非依存の pure function。残件数は常に 0 以上にクランプされ、estimatedCompletionAt
 * の計算で Infinity / NaN が発生しないよう防御している。
 *
 * @returns backfillPending object, or null if no backfill category is enqueued.
 */
export function buildBackfillPending(
  input: BuildBackfillPendingInput
): EmbeddingBackfillPendingSyncOverflow | null {
  const {
    partsSaved,
    threshold,
    avgMsPerItem,
    webPageId,
    enqueuedTextCategory,
    enqueuedVisualCategory,
    enqueuedSectionVisualCategory,
  } = input;

  if (!enqueuedTextCategory && !enqueuedVisualCategory && !enqueuedSectionVisualCategory) {
    return null;
  }

  // 残件 = partsSaved - threshold（非負にクランプ）
  // remainder = partsSaved - threshold (non-negative clamp)
  const remainder = Math.max(0, partsSaved - threshold);
  const partTextPending = enqueuedTextCategory ? remainder : 0;
  const partVisualPending = enqueuedVisualCategory ? remainder : 0;

  const enqueuedCategories: EmbeddingBackfillCategory[] = [];
  if (enqueuedTextCategory) enqueuedCategories.push("part_text");
  if (enqueuedVisualCategory) enqueuedCategories.push("part_visual");
  // v0.4.0 PR7e-α (バグ⑥): section_visual も enqueue されていれば jobIds に追加。
  // v0.4.0 PR7e-α (bug ⑥): include section_visual jobId when enqueued.
  if (enqueuedSectionVisualCategory) enqueuedCategories.push("section_visual");
  const jobIds = enqueuedCategories.map((category) => buildBackfillJobId(webPageId, category));

  // NaN/Infinity 防御: 有限な avgMsPerItem のみ採用
  // NaN/Infinity defense: only accept finite avgMsPerItem
  const safeAvgMs = Number.isFinite(avgMsPerItem) && avgMsPerItem > 0 ? avgMsPerItem : 0;
  const maxPending = Math.max(partTextPending, partVisualPending);
  const estimatedDurationMs = maxPending * safeAvgMs;
  const estimatedCompletionAt =
    maxPending > 0 && safeAvgMs > 0 && Number.isFinite(estimatedDurationMs)
      ? new Date(Date.now() + estimatedDurationMs).toISOString()
      : undefined;

  const pending: EmbeddingBackfillPendingSyncOverflow = {
    source: "sync_overflow",
    partTextPending,
    partVisualPending,
    jobIds,
  };
  // v0.4.0 PR7e-α (バグ⑥): section_visual が enqueue された場合のみ
  // sectionVisualPending を設定 (件数は現時点で unknown=0 で明示)。
  // v0.4.0 PR7e-α (bug ⑥): set sectionVisualPending (currently unknown=0)
  // only when section_visual was enqueued.
  if (enqueuedSectionVisualCategory) {
    pending.sectionVisualPending = 0;
  }
  if (estimatedCompletionAt !== undefined) {
    pending.estimatedCompletionAt = estimatedCompletionAt;
  }
  return pending;
}

/**
 * Input for {@link buildSkipRecoveryBackfillPending}.
 */
export interface BuildSkipRecoveryBackfillPendingInput {
  /**
   * Phase 5 がスキップされた原因 (`EmbeddingSkipReason`)。
   * Cause of Phase 5 skip (`EmbeddingSkipReason`).
   */
  skipReason: EmbeddingSkipReason;
  /**
   * 実際に enqueue された backfill カテゴリ（screenshot 不在時は
   * screenshot 必須カテゴリが除外される）。
   *
   * Categories actually enqueued (screenshot-required categories are excluded
   * when no screenshot is available).
   */
  enqueuedCategories: EmbeddingBackfillCategory[];
  /**
   * この recovery 試行後の retry count（0〜5）。CAS guard で increment 済みの値。
   * Retry count after this recovery attempt (0..5). Value post-CAS-increment.
   */
  retryCount: number;
  /**
   * recovery enqueue 時刻。
   * Timestamp of the recovery enqueue.
   */
  enqueuedAt: Date;
}

/**
 * Build the `skip_recovery` variant of `backfillPending` for the MCP response.
 *
 * Phase 5 全体がスキップされた際（memory pressure / fork 失敗 / IPC race 等）、
 * `dispatchSkipRecoveryBackfill` が enqueue した全 7 カテゴリの recovery 情報を
 * MCP response へ投影する pure builder。副作用なし、DB 非依存。
 *
 * Pure builder that projects the full Phase 5 skip recovery enqueue result
 * (from `dispatchSkipRecoveryBackfill`) onto the MCP response. No side effects,
 * no DB dependency.
 *
 * 戻り値について / Return value:
 * - `enqueuedCategories` が空配列の場合も payload を返す（audit / observability
 *   のため）。呼び出し側は必要に応じて null 判定を行うこと。
 * - Returns the payload even when `enqueuedCategories` is empty (for audit /
 *   observability). Callers may skip attaching it based on their own policy.
 */
export function buildSkipRecoveryBackfillPending(
  input: BuildSkipRecoveryBackfillPendingInput
): EmbeddingBackfillPendingSkipRecovery {
  const { skipReason, enqueuedCategories, retryCount, enqueuedAt } = input;

  // retryCount を安全な非負整数にクランプし、SSOT の retry cap にも合わせる。
  // Prisma の更新結果経由で Infinity / NaN / cap 超過値が万一混入しても
  // response に漏らさない（Zod schema は `max(SKIP_RECOVERY_RETRY_CAP)` なので
  // clamp 無しだと parse error になる）。
  //
  // Clamp retryCount to a safe non-negative integer bounded by the SSOT retry
  // cap. Prevents Infinity / NaN / over-cap leakage from Prisma update results
  // into the MCP response (Zod schema's `max(SKIP_RECOVERY_RETRY_CAP)` would
  // otherwise raise a parse error here).
  const safeRetryCount = ((): number => {
    if (!Number.isFinite(retryCount) || retryCount < 0) return 0;
    const floored = Math.floor(retryCount);
    return floored > SKIP_RECOVERY_RETRY_CAP ? SKIP_RECOVERY_RETRY_CAP : floored;
  })();

  // enqueuedAt を ISO 8601 に安全に変換（Invalid Date は現在時刻でフォールバック）
  // Safely convert enqueuedAt to ISO 8601 (falls back to now on Invalid Date)
  const enqueuedAtIso = Number.isFinite(enqueuedAt.getTime())
    ? enqueuedAt.toISOString()
    : new Date().toISOString();

  return {
    source: "skip_recovery",
    skipReason,
    enqueuedCategories: [...enqueuedCategories],
    retryCount: safeRetryCount,
    enqueuedAt: enqueuedAtIso,
  };
}

/**
 * Type-narrow helper: checks whether two `backfillPending` candidates both
 * carry content. ADR-0008 Semantics Table では両立不能なため、呼び出し側は
 * この関数で invariant violation を検出したら `debug.log` へ記録すること。
 *
 * Type-narrow helper: detects the ADR-0008 invariant violation where both
 * `sync_overflow` and `skip_recovery` sources are present simultaneously.
 * Callers MUST log via `debug.log` when this returns true (LCC recommendation).
 */
export function isBackfillPendingSourceConflict(
  syncOverflow: EmbeddingBackfillPending | null | undefined,
  skipRecovery: EmbeddingBackfillPending | null | undefined
): boolean {
  return Boolean(syncOverflow) && Boolean(skipRecovery);
}
