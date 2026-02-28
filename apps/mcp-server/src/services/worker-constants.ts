// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Constants - 共通定数定義
 *
 * ワーカー関連の複数サービスで共有される定数を一元管理する。
 * 重複定義を排除し、値の不整合を防止する。
 *
 * 使用箇所:
 * - queue-cleanup.service.ts: orphaned active job の completed/failed 判定
 * - worker-stall-recovery.service.ts: orphaned job のカテゴリ分類
 * - page-analyze-worker.ts: PHASE_PROGRESS.EMBEDDING_START
 *
 * @module services/worker-constants
 */

// ============================================================================
// Progress Thresholds
// ============================================================================

/**
 * DB保存済みとみなすprogressの閾値（%）
 *
 * page-analyze-workerのPHASE_PROGRESSに基づく:
 * - EMBEDDING_START: 90
 * - EMBEDDING_COMPLETE: 100
 * progress >= 90%ならLayout/Motion/QualityのDB保存は完了している可能性が高い
 *
 * 使用箇所:
 * - queue-cleanup.service.ts: orphaned active job の completed/failed 判定（progress >= 90 → completed）
 * - worker-stall-recovery.service.ts: orphaned job のカテゴリ分類（db_saved_but_stuck）
 * - page-analyze-worker.ts: PHASE_PROGRESS.EMBEDDING_START
 */
export const DB_SAVED_PROGRESS_THRESHOLD = 90;

// ============================================================================
// Timing Constants
// ============================================================================

/**
 * Orphaned job判定のための追加マージン（ms）
 *
 * lockDuration + STALL_MARGIN_MS を超えたactive jobをorphanedとみなす。
 * BullMQのstall detectionにはstalledInterval（通常lockDuration/4=10分）の遅延が
 * あるため、十分なマージンを設ける。lockDuration=2400s (40分) に対して
 * 4分のマージンでstalledInterval検出遅延を吸収する。
 *
 * 使用箇所:
 * - worker-stall-recovery.service.ts: orphaned active job 判定
 */
export const STALL_MARGIN_MS = 240_000; // 4分のマージン
