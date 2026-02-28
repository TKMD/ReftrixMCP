// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Orphaned Job Utilities テスト
 *
 * TDD Red: orphaned job 判定の共通ユーティリティテスト
 *
 * 2つの isOrphanedActiveJob 実装は用途が異なる:
 * - isOrphanedByElapsedTime: QueueAdapter用（簡易時間ベース判定）
 * - isOrphanedByLockExpiry: BullMQ直接操作用（lockDuration+margin判定）
 *
 * 共通化されるのは:
 * - DB_SAVED_PROGRESS_THRESHOLD (worker-constants.ts)
 * - STALL_MARGIN_MS (worker-constants.ts)
 * - isDbSavedProgress: progress >= DB_SAVED_PROGRESS_THRESHOLD の判定ヘルパー
 *
 * @module tests/services/orphaned-job-utils
 */

import { describe, it, expect } from 'vitest';

import {
  isDbSavedProgress,
  isOrphanedByElapsedTime,
  isOrphanedByLockExpiry,
  categorizeByProgress,
  type OrphanedJobCategory,
} from '../../src/services/orphaned-job-utils';

describe('OrphanedJobUtils', () => {
  // ==========================================================================
  // isDbSavedProgress
  // ==========================================================================

  describe('isDbSavedProgress', () => {
    it('progress >= 90 の場合 true を返す', () => {
      expect(isDbSavedProgress(90)).toBe(true);
      expect(isDbSavedProgress(95)).toBe(true);
      expect(isDbSavedProgress(100)).toBe(true);
    });

    it('progress < 90 の場合 false を返す', () => {
      expect(isDbSavedProgress(89)).toBe(false);
      expect(isDbSavedProgress(50)).toBe(false);
      expect(isDbSavedProgress(0)).toBe(false);
    });

    it('境界値 89 は false、90 は true', () => {
      expect(isDbSavedProgress(89)).toBe(false);
      expect(isDbSavedProgress(90)).toBe(true);
    });
  });

  // ==========================================================================
  // isOrphanedByElapsedTime (QueueAdapter用)
  // ==========================================================================

  describe('isOrphanedByElapsedTime', () => {
    it('processedOn が undefined の場合 true を返す', () => {
      expect(isOrphanedByElapsedTime(undefined, 100, 3_600_000)).toBe(true);
    });

    it('processedOn が null の場合 true を返す', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(isOrphanedByElapsedTime(null as any, 100, 3_600_000)).toBe(true);
    });

    it('elapsed >= thresholdMs かつ progress < 100 の場合 true を返す', () => {
      const processedOn = Date.now() - 4_000_000; // 60分以上前
      expect(isOrphanedByElapsedTime(processedOn, 50, 3_600_000)).toBe(true);
    });

    it('elapsed < thresholdMs の場合 false を返す', () => {
      const processedOn = Date.now() - 60_000; // 1分前
      expect(isOrphanedByElapsedTime(processedOn, 50, 3_600_000)).toBe(false);
    });

    it('progress = 100 の場合 false を返す（完了済み）', () => {
      const processedOn = Date.now() - 4_000_000; // 60分以上前
      expect(isOrphanedByElapsedTime(processedOn, 100, 3_600_000)).toBe(false);
    });
  });

  // ==========================================================================
  // isOrphanedByLockExpiry (BullMQ直接操作用)
  // ==========================================================================

  // ==========================================================================
  // categorizeByProgress
  // ==========================================================================

  describe('categorizeByProgress', () => {
    it('progress >= 90 のジョブを db_saved_but_stuck として分類する', () => {
      const result: OrphanedJobCategory = categorizeByProgress(90, Date.now() - 3_000_000);
      expect(result).toBe('db_saved_but_stuck');
    });

    it('progress = 96 のジョブを db_saved_but_stuck として分類する', () => {
      expect(categorizeByProgress(96, Date.now() - 3_000_000)).toBe('db_saved_but_stuck');
    });

    it('progress = 100 のジョブを db_saved_but_stuck として分類する', () => {
      expect(categorizeByProgress(100, Date.now() - 3_000_000)).toBe('db_saved_but_stuck');
    });

    it('progress >= 90 は processedOn が undefined でも db_saved_but_stuck', () => {
      expect(categorizeByProgress(95, undefined)).toBe('db_saved_but_stuck');
    });

    it('progress >= 90 は processedOn が null でも db_saved_but_stuck', () => {
      expect(categorizeByProgress(90, null)).toBe('db_saved_but_stuck');
    });

    it('0 < progress < 90 のジョブを processing_interrupted として分類する', () => {
      expect(categorizeByProgress(45, Date.now() - 3_000_000)).toBe('processing_interrupted');
    });

    it('progress = 1 のジョブを processing_interrupted として分類する（境界値）', () => {
      expect(categorizeByProgress(1, Date.now() - 3_000_000)).toBe('processing_interrupted');
    });

    it('progress = 89 のジョブを processing_interrupted として分類する（境界値）', () => {
      expect(categorizeByProgress(89, Date.now() - 3_000_000)).toBe('processing_interrupted');
    });

    it('progress = 0, processedOn = undefined のジョブを never_started として分類する', () => {
      expect(categorizeByProgress(0, undefined)).toBe('never_started');
    });

    it('progress = 0, processedOn = null のジョブを never_started として分類する', () => {
      expect(categorizeByProgress(0, null)).toBe('never_started');
    });

    it('progress = 0, processedOn が設定済みのジョブを never_started として分類する', () => {
      // processedOn が設定されているが progress = 0 → 処理開始直後のクラッシュ
      expect(categorizeByProgress(0, Date.now() - 3_000_000)).toBe('never_started');
    });
  });

  // ==========================================================================
  // isOrphanedByLockExpiry (BullMQ直接操作用)
  // ==========================================================================

  describe('isOrphanedByLockExpiry', () => {
    it('active状態でないジョブは false を返す', () => {
      expect(isOrphanedByLockExpiry('completed', Date.now() - 800_000, 600_000)).toBe(false);
      expect(isOrphanedByLockExpiry('failed', Date.now() - 800_000, 600_000)).toBe(false);
      expect(isOrphanedByLockExpiry('waiting', Date.now() - 800_000, 600_000)).toBe(false);
    });

    it('processedOn が undefined の場合 true を返す', () => {
      expect(isOrphanedByLockExpiry('active', undefined, 600_000)).toBe(true);
    });

    it('lockDuration + STALL_MARGIN_MS を超過した場合 true を返す', () => {
      // threshold = lockDurationMs(600000) + STALL_MARGIN_MS(240000) = 840000
      // 900秒前に開始 → elapsed(900000) > threshold(840000)
      const processedOn = Date.now() - 900_000;
      expect(isOrphanedByLockExpiry('active', processedOn, 600_000)).toBe(true);
    });

    it('lockDuration + STALL_MARGIN_MS 以内の場合 false を返す', () => {
      // threshold = 600000 + 240000 = 840000
      // 300秒前に開始 → elapsed(300000) < threshold(840000)
      const processedOn = Date.now() - 300_000;
      expect(isOrphanedByLockExpiry('active', processedOn, 600_000)).toBe(false);
    });
  });
});
