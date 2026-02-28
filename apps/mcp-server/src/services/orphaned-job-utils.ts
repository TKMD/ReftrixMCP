// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Orphaned Job Utilities - 共通判定ヘルパー
 *
 * orphaned job 判定ロジックの共通部分を集約する。
 *
 * 2つの異なるコンテキストで orphaned job 判定が行われる:
 * 1. QueueAdapter 経由（queue-cleanup.service.ts）:
 *    - 簡易な時間ベース判定（processedOn + elapsed + progress）
 *    - thresholdMs パラメータで閾値を外部から指定
 *
 * 2. BullMQ 直接操作（worker-stall-recovery.service.ts）:
 *    - 詳細な state + lockDuration + STALL_MARGIN_MS 判定
 *    - active状態のジョブのみ対象
 *
 * 共通化される要素:
 * - DB_SAVED_PROGRESS_THRESHOLD (worker-constants.ts)
 * - STALL_MARGIN_MS (worker-constants.ts)
 * - isDbSavedProgress: progress判定ヘルパー
 * - isOrphanedByElapsedTime: 時間ベース判定（queue-cleanup用）
 * - isOrphanedByLockExpiry: ロック期限ベース判定（stall-recovery用）
 *
 * @module services/orphaned-job-utils
 */

import { DB_SAVED_PROGRESS_THRESHOLD, STALL_MARGIN_MS } from './worker-constants';

// ============================================================================
// Types
// ============================================================================

/**
 * Orphaned job の分類
 *
 * - db_saved_but_stuck: DB保存済みだがBullMQがactive（progress >= 90%）
 * - processing_interrupted: 処理中に中断（progress > 0 && < 90%）
 * - never_started: 処理が開始されていない（progress = 0）
 */
export type OrphanedJobCategory = 'db_saved_but_stuck' | 'processing_interrupted' | 'never_started';

// ============================================================================
// Progress Helpers
// ============================================================================

/**
 * ジョブの進捗がDB保存済みレベルに達しているか判定する
 *
 * progress >= DB_SAVED_PROGRESS_THRESHOLD (90%) ならば、
 * Layout/Motion/QualityのDB保存は完了している可能性が高い。
 *
 * @param progress - ジョブの進捗（0-100）
 * @returns DB保存済みレベルに達しているか
 */
export function isDbSavedProgress(progress: number): boolean {
  return progress >= DB_SAVED_PROGRESS_THRESHOLD;
}

// ============================================================================
// Category Classification
// ============================================================================

/**
 * progress と processedOn からジョブカテゴリを判定する
 *
 * 全てのカテゴリ分類はこの関数に集約される。
 * categorizeOrphanedJob や handleStalledJob から使用される。
 *
 * @param progress - ジョブの進捗（0-100）
 * @param processedOn - 処理開始タイムスタンプ（ms）。undefined/null は未開始
 * @returns カテゴリ
 */
export function categorizeByProgress(
  progress: number,
  processedOn: number | undefined | null,
): OrphanedJobCategory {
  if (progress >= DB_SAVED_PROGRESS_THRESHOLD) {
    return 'db_saved_but_stuck';
  }
  if (progress > 0) {
    return 'processing_interrupted';
  }
  if (processedOn === undefined || processedOn === null) {
    return 'never_started';
  }
  return 'never_started';
}

// ============================================================================
// Orphaned Job Detection: Elapsed Time Based (for QueueAdapter)
// ============================================================================

/**
 * 経過時間ベースで orphaned active job を判定する（QueueAdapter用）
 *
 * queue-cleanup.service.ts で使用。QueueAdapterのJobInfoから取得できる
 * 最小限の情報（processedOn, progress）で判定する。
 *
 * 以下の条件のいずれかを満たす場合、orphaned と判定する:
 * - processedOn が undefined/null
 * - processedOn から thresholdMs 以上経過 かつ progress < 100
 *
 * @param processedOn - 処理開始タイムスタンプ（ms）。undefined/null の場合は orphaned
 * @param progress - ジョブの進捗（0-100）
 * @param thresholdMs - orphaned 判定の閾値（ms）
 * @returns orphaned かどうか
 */
export function isOrphanedByElapsedTime(
  processedOn: number | undefined | null,
  progress: number,
  thresholdMs: number,
): boolean {
  if (processedOn == null) {
    return true;
  }
  const elapsed = Date.now() - processedOn;
  return elapsed >= thresholdMs && progress < 100;
}

// ============================================================================
// Orphaned Job Detection: Lock Expiry Based (for BullMQ direct)
// ============================================================================

/**
 * ロック期限ベースで orphaned active job を判定する（BullMQ直接操作用）
 *
 * worker-stall-recovery.service.ts で使用。BullMQのJob情報から取得できる
 * 詳細情報（state, processedOn, lockDurationMs）で判定する。
 *
 * 以下の条件をすべて満たす場合にorphanedとみなす:
 * 1. 状態がactive
 * 2. processedOnが未設定、または lockDuration + STALL_MARGIN_MS を超過
 *
 * @param state - BullMQ Job state
 * @param processedOn - 処理開始タイムスタンプ（ms）。undefined の場合は orphaned
 * @param lockDurationMs - ワーカーのlockDuration設定（ms）
 * @returns orphaned かどうか
 */
export function isOrphanedByLockExpiry(
  state: string,
  processedOn: number | undefined | null,
  lockDurationMs: number,
): boolean {
  // active状態でないジョブは対象外
  if (state !== 'active') {
    return false;
  }

  // processedOnが未設定 = lockを取得したがprocessing関数が開始されていない
  if (processedOn === undefined || processedOn === null) {
    return true;
  }

  // lockDuration + マージンを超過しているか判定
  const elapsed = Date.now() - processedOn;
  const threshold = lockDurationMs + STALL_MARGIN_MS;

  return elapsed > threshold;
}
