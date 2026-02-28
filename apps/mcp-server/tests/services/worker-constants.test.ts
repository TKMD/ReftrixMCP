// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Constants テスト
 *
 * TDD Red: 共通定数ファイルのテスト
 *
 * DB_SAVED_PROGRESS_THRESHOLD (90%) は以下の3ファイルで使用される:
 * - queue-cleanup.service.ts: orphaned active job の completed/failed 判定
 * - worker-stall-recovery.service.ts: orphaned job のカテゴリ分類
 * - page-analyze-worker.ts: PHASE_PROGRESS.EMBEDDING_START
 *
 * @module tests/services/worker-constants
 */

import { describe, it, expect } from 'vitest';

import {
  DB_SAVED_PROGRESS_THRESHOLD,
  STALL_MARGIN_MS,
} from '../../src/services/worker-constants';

describe('WorkerConstants', () => {
  describe('DB_SAVED_PROGRESS_THRESHOLD', () => {
    it('DB保存済みとみなすprogressの閾値が90である', () => {
      expect(DB_SAVED_PROGRESS_THRESHOLD).toBe(90);
    });

    it('number型である', () => {
      expect(typeof DB_SAVED_PROGRESS_THRESHOLD).toBe('number');
    });
  });

  describe('STALL_MARGIN_MS', () => {
    it('Stall判定の追加マージンが240,000ms（4分）である', () => {
      expect(STALL_MARGIN_MS).toBe(240_000);
    });

    it('number型である', () => {
      expect(typeof STALL_MARGIN_MS).toBe('number');
    });
  });
});
