// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * safeParseInt テスト
 *
 * TDD Red: 環境変数パースの安全化ヘルパー
 *
 * SEC-M2対応: parseInt(process.env.XXX || 'default') パターンの安全化
 * - NaN チェック
 * - 範囲チェック（min/max）
 * - デフォルト値フォールバック
 *
 * @module tests/utils/safe-parse-int
 */

import { describe, it, expect } from 'vitest';

import { safeParseInt } from '../../src/utils/safe-parse-int';

describe('safeParseInt', () => {
  // ==========================================================================
  // 正常入力
  // ==========================================================================

  describe('正常入力', () => {
    it('有効な数値文字列をパースする', () => {
      expect(safeParseInt('1200000', 0)).toBe(1200000);
    });

    it('0 をパースする', () => {
      expect(safeParseInt('0', 42)).toBe(0);
    });

    it('負の数値をパースする', () => {
      expect(safeParseInt('-100', 0)).toBe(-100);
    });

    it('先頭・末尾の空白を無視する', () => {
      expect(safeParseInt(' 300000 ', 0)).toBe(300000);
    });
  });

  // ==========================================================================
  // NaN入力
  // ==========================================================================

  describe('NaN入力', () => {
    it('undefined の場合デフォルト値を返す', () => {
      expect(safeParseInt(undefined, 1200000)).toBe(1200000);
    });

    it('空文字列の場合デフォルト値を返す', () => {
      expect(safeParseInt('', 1200000)).toBe(1200000);
    });

    it('非数値文字列の場合デフォルト値を返す', () => {
      expect(safeParseInt('abc', 300000)).toBe(300000);
    });

    it('NaN文字列の場合デフォルト値を返す', () => {
      expect(safeParseInt('NaN', 100)).toBe(100);
    });

    it('Infinity文字列の場合デフォルト値を返す', () => {
      expect(safeParseInt('Infinity', 100)).toBe(100);
    });

    it('小数点を含む文字列は整数部分のみパースする', () => {
      // parseInt('12.5') は 12 を返す — これは既存の parseInt の挙動と同一
      expect(safeParseInt('12.5', 0)).toBe(12);
    });
  });

  // ==========================================================================
  // 範囲チェック
  // ==========================================================================

  describe('範囲チェック', () => {
    it('min が指定されている場合、min 未満ならデフォルト値を返す', () => {
      expect(safeParseInt('5', 100, { min: 10 })).toBe(100);
    });

    it('max が指定されている場合、max 超過ならデフォルト値を返す', () => {
      expect(safeParseInt('200', 50, { max: 100 })).toBe(50);
    });

    it('min/max の範囲内なら値をそのまま返す', () => {
      expect(safeParseInt('50', 0, { min: 10, max: 100 })).toBe(50);
    });

    it('min = max の境界値を正しく判定する', () => {
      expect(safeParseInt('10', 0, { min: 10, max: 10 })).toBe(10);
      expect(safeParseInt('9', 0, { min: 10, max: 10 })).toBe(0);
      expect(safeParseInt('11', 0, { min: 10, max: 10 })).toBe(0);
    });

    it('min のみ指定で max 未指定の場合、上限チェックなし', () => {
      expect(safeParseInt('999999999', 0, { min: 0 })).toBe(999999999);
    });

    it('max のみ指定で min 未指定の場合、下限チェックなし', () => {
      expect(safeParseInt('-999999', 0, { max: 1000 })).toBe(-999999);
    });
  });

  // ==========================================================================
  // 環境変数パターン互換性
  // ==========================================================================

  describe('環境変数パターン互換性', () => {
    it('BULLMQ_LOCK_DURATION パターン: 正常値', () => {
      expect(safeParseInt('1200000', 1200000, { min: 60000 })).toBe(1200000);
    });

    it('BULLMQ_LOCK_DURATION パターン: 範囲外（小さすぎ）', () => {
      expect(safeParseInt('100', 1200000, { min: 60000 })).toBe(1200000);
    });

    it('BULLMQ_LOCK_EXTEND_INTERVAL_MS パターン: 正常値', () => {
      expect(safeParseInt('300000', 300000, { min: 10000 })).toBe(300000);
    });

    it('WORKER_MEMORY_DEGRADATION_MB パターン: 正常値', () => {
      expect(safeParseInt('12288', 12288, { min: 1024 })).toBe(12288);
    });
  });
});
