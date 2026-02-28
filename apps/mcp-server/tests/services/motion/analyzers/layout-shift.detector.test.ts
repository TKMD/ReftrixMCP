// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layout Shift Detector Tests
 *
 * TDD Red Phase: 失敗するテストを先に作成
 *
 * CLS (Cumulative Layout Shift) 計算仕様:
 * - impact_fraction: ビューポートに対する変化領域の割合
 * - distance_fraction: ビューポートの最大次元に対する移動距離の割合
 * - layout_shift_score = impact_fraction * distance_fraction
 *
 * 分類閾値:
 * - good: < 0.1
 * - needs-improvement: >= 0.1 && < 0.25
 * - poor: >= 0.25
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  LayoutShiftDetector,
  type LayoutShift,
  type DiffRegion,
  type Viewport,
} from '../../../../src/services/motion/analyzers/layout-shift.detector';

describe('LayoutShiftDetector', () => {
  let detector: LayoutShiftDetector;

  beforeEach(() => {
    detector = new LayoutShiftDetector();
  });

  // ===========================================================================
  // detectShifts テスト
  // ===========================================================================
  describe('detectShifts', () => {
    it('空の差分領域配列の場合、空のシフト配列を返す', () => {
      const diffRegions: DiffRegion[] = [];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const result = detector.detectShifts(diffRegions, viewport);

      expect(result).toEqual([]);
    });

    it('単一の差分領域からシフトを検出する', () => {
      const diffRegions: DiffRegion[] = [
        {
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          changeIntensity: 0.8,
          pixelCount: 20000,
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const shifts = detector.detectShifts(diffRegions, viewport);

      expect(shifts).toHaveLength(1);
      expect(shifts[0]).toMatchObject({
        region: { x: 100, y: 100, width: 200, height: 100 },
        impactFraction: expect.any(Number),
        distanceFraction: expect.any(Number),
        score: expect.any(Number),
      });
    });

    it('複数の差分領域から複数のシフトを検出する', () => {
      const diffRegions: DiffRegion[] = [
        { x: 0, y: 0, width: 100, height: 100, changeIntensity: 0.5, pixelCount: 10000 },
        { x: 500, y: 500, width: 200, height: 200, changeIntensity: 0.7, pixelCount: 40000 },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const shifts = detector.detectShifts(diffRegions, viewport);

      expect(shifts).toHaveLength(2);
    });

    it('impactFractionは変化領域のビューポートに対する割合で計算される', () => {
      // ビューポートの10%を占める領域
      const diffRegions: DiffRegion[] = [
        {
          x: 0,
          y: 0,
          width: 192, // 1920 * 0.1
          height: 1080, // 全高さ
          changeIntensity: 1.0,
          pixelCount: 192 * 1080,
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const shifts = detector.detectShifts(diffRegions, viewport);

      // 192 * 1080 / (1920 * 1080) = 0.1
      expect(shifts[0].impactFraction).toBeCloseTo(0.1, 2);
    });

    it('distanceFractionは移動距離のビューポート最大次元に対する割合で計算される', () => {
      // 中央から右に移動した領域（移動距離 = 192px）
      const diffRegions: DiffRegion[] = [
        {
          x: 960, // 中央からスタート
          y: 540,
          width: 100,
          height: 100,
          changeIntensity: 1.0,
          pixelCount: 10000,
          // 移動情報を含む
          previousPosition: { x: 768, y: 540 },
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const shifts = detector.detectShifts(diffRegions, viewport);

      // 移動距離 192 / max(1920, 1080) = 192 / 1920 = 0.1
      expect(shifts[0].distanceFraction).toBeCloseTo(0.1, 2);
    });

    it('移動情報がない場合、distanceFractionはchangeIntensityに基づいて推定される', () => {
      const diffRegions: DiffRegion[] = [
        {
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          changeIntensity: 0.5,
          pixelCount: 20000,
          // previousPosition なし
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const shifts = detector.detectShifts(diffRegions, viewport);

      // changeIntensity * 0.1 (推定係数) = 0.5 * 0.1 = 0.05
      expect(shifts[0].distanceFraction).toBeCloseTo(0.05, 2);
    });
  });

  // ===========================================================================
  // calculateCLS テスト
  // ===========================================================================
  describe('calculateCLS', () => {
    it('空のシフト配列の場合、CLSは0を返す', () => {
      const shifts: LayoutShift[] = [];

      const cls = detector.calculateCLS(shifts);

      expect(cls).toBe(0);
    });

    it('単一のシフトからCLSを計算する（impact * distance）', () => {
      const shifts: LayoutShift[] = [
        {
          region: { x: 0, y: 0, width: 100, height: 100 },
          impactFraction: 0.2,
          distanceFraction: 0.1,
          score: 0.02, // 0.2 * 0.1
        },
      ];

      const cls = detector.calculateCLS(shifts);

      expect(cls).toBeCloseTo(0.02, 4);
    });

    it('複数のシフトからCLSを累積計算する', () => {
      const shifts: LayoutShift[] = [
        {
          region: { x: 0, y: 0, width: 100, height: 100 },
          impactFraction: 0.2,
          distanceFraction: 0.1,
          score: 0.02,
        },
        {
          region: { x: 200, y: 200, width: 150, height: 150 },
          impactFraction: 0.15,
          distanceFraction: 0.2,
          score: 0.03,
        },
      ];

      const cls = detector.calculateCLS(shifts);

      // 0.02 + 0.03 = 0.05
      expect(cls).toBeCloseTo(0.05, 4);
    });

    it('大きなシフトがある場合、高いCLSを返す', () => {
      const shifts: LayoutShift[] = [
        {
          region: { x: 0, y: 0, width: 500, height: 500 },
          impactFraction: 0.5,
          distanceFraction: 0.5,
          score: 0.25,
        },
      ];

      const cls = detector.calculateCLS(shifts);

      expect(cls).toBeCloseTo(0.25, 4);
    });
  });

  // ===========================================================================
  // classifyShift テスト
  // ===========================================================================
  describe('classifyShift', () => {
    it('CLS < 0.1 の場合、"good" を返す', () => {
      expect(detector.classifyShift(0)).toBe('good');
      expect(detector.classifyShift(0.05)).toBe('good');
      expect(detector.classifyShift(0.099)).toBe('good');
    });

    it('0.1 <= CLS < 0.25 の場合、"needs-improvement" を返す', () => {
      expect(detector.classifyShift(0.1)).toBe('needs-improvement');
      expect(detector.classifyShift(0.15)).toBe('needs-improvement');
      expect(detector.classifyShift(0.249)).toBe('needs-improvement');
    });

    it('CLS >= 0.25 の場合、"poor" を返す', () => {
      expect(detector.classifyShift(0.25)).toBe('poor');
      expect(detector.classifyShift(0.5)).toBe('poor');
      expect(detector.classifyShift(1.0)).toBe('poor');
    });

    it('負の値の場合、"good" を返す（エッジケース）', () => {
      expect(detector.classifyShift(-0.1)).toBe('good');
    });
  });

  // ===========================================================================
  // analyzeFramePair テスト（統合）
  // ===========================================================================
  describe('analyzeFramePair', () => {
    it('同一フレームの場合、CLSは0でgoodを返す', () => {
      // 同一フレームは差分なし
      const diffRegions: DiffRegion[] = [];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const result = detector.analyzeFramePair(diffRegions, viewport);

      expect(result).toMatchObject({
        cls: 0,
        classification: 'good',
        shifts: [],
        impactFraction: 0,
        distanceFraction: 0,
      });
    });

    it('小さな変化の場合、goodを返す', () => {
      // ビューポートの1%未満の変化
      const diffRegions: DiffRegion[] = [
        {
          x: 100,
          y: 100,
          width: 50,
          height: 50,
          changeIntensity: 0.3,
          pixelCount: 2500,
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const result = detector.analyzeFramePair(diffRegions, viewport);

      expect(result.cls).toBeLessThan(0.1);
      expect(result.classification).toBe('good');
    });

    it('中程度の変化の場合、needs-improvementを返す', () => {
      // CLS >= 0.1 かつ < 0.25 になるようなパラメータを設定
      // 目標CLS: 0.15
      // impactFraction = 0.5 (ビューポートの50%)
      // distanceFraction = 0.3 (ビューポートの30%移動)
      // CLS = 0.5 * 0.3 = 0.15
      const diffRegions: DiffRegion[] = [
        {
          x: 0,
          y: 0,
          width: 1920,
          height: 540, // 画面の半分 = 50%
          changeIntensity: 1.0,
          pixelCount: 1920 * 540,
          previousPosition: { x: 0, y: 576 }, // 576px移動 = 576/1920 = 0.3
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const result = detector.analyzeFramePair(diffRegions, viewport);

      // impactFraction = (1920*540) / (1920*1080) = 0.5
      // distanceFraction = 576 / 1920 = 0.3
      // CLS = 0.5 * 0.3 = 0.15 -> needs-improvement
      expect(result.cls).toBeGreaterThanOrEqual(0.1);
      expect(result.cls).toBeLessThan(0.25);
      expect(result.classification).toBe('needs-improvement');
    });

    it('大きな変化の場合、poorを返す', () => {
      // CLS >= 0.25 になるようなパラメータを設定
      // 目標CLS: 0.3
      // impactFraction = 0.6 (ビューポートの60%)
      // distanceFraction = 0.5 (ビューポートの50%移動)
      // CLS = 0.6 * 0.5 = 0.3
      const diffRegions: DiffRegion[] = [
        {
          x: 0,
          y: 0,
          width: 1920,
          height: 648, // 画面の60% (1080 * 0.6)
          changeIntensity: 1.0,
          pixelCount: 1920 * 648,
          previousPosition: { x: 0, y: 960 }, // 960px移動 = 960/1920 = 0.5
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const result = detector.analyzeFramePair(diffRegions, viewport);

      // impactFraction = (1920*648) / (1920*1080) = 0.6
      // distanceFraction = 960 / 1920 = 0.5
      // CLS = 0.6 * 0.5 = 0.3 -> poor
      expect(result.cls).toBeGreaterThanOrEqual(0.25);
      expect(result.classification).toBe('poor');
    });

    it('結果にすべての詳細情報が含まれる', () => {
      const diffRegions: DiffRegion[] = [
        {
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          changeIntensity: 0.5,
          pixelCount: 20000,
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const result = detector.analyzeFramePair(diffRegions, viewport);

      expect(result).toMatchObject({
        cls: expect.any(Number),
        classification: expect.stringMatching(/^(good|needs-improvement|poor)$/),
        shifts: expect.any(Array),
        impactFraction: expect.any(Number),
        distanceFraction: expect.any(Number),
      });
    });

    it('impactFractionとdistanceFractionは0-1の範囲内', () => {
      const diffRegions: DiffRegion[] = [
        {
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
          changeIntensity: 1.0,
          pixelCount: 1920 * 1080,
          previousPosition: { x: 1000, y: 1000 },
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const result = detector.analyzeFramePair(diffRegions, viewport);

      expect(result.impactFraction).toBeGreaterThanOrEqual(0);
      expect(result.impactFraction).toBeLessThanOrEqual(1);
      expect(result.distanceFraction).toBeGreaterThanOrEqual(0);
      expect(result.distanceFraction).toBeLessThanOrEqual(1);
    });
  });

  // ===========================================================================
  // エッジケース
  // ===========================================================================
  describe('エッジケース', () => {
    it('ビューポートサイズが0の場合、例外をスローする', () => {
      const diffRegions: DiffRegion[] = [];
      const viewport: Viewport = { width: 0, height: 0 };

      expect(() => detector.detectShifts(diffRegions, viewport)).toThrow('Invalid viewport');
    });

    it('負のビューポートサイズの場合、例外をスローする', () => {
      const diffRegions: DiffRegion[] = [];
      const viewport: Viewport = { width: -100, height: 1080 };

      expect(() => detector.detectShifts(diffRegions, viewport)).toThrow('Invalid viewport');
    });

    it('差分領域がビューポート外の場合も処理できる', () => {
      const diffRegions: DiffRegion[] = [
        {
          x: 2000, // ビューポート外
          y: 2000,
          width: 100,
          height: 100,
          changeIntensity: 0.5,
          pixelCount: 10000,
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      // ビューポート外の領域は影響なし
      const shifts = detector.detectShifts(diffRegions, viewport);
      expect(shifts[0].impactFraction).toBe(0);
    });

    it('非常に小さな差分領域は無視される（閾値以下）', () => {
      const diffRegions: DiffRegion[] = [
        {
          x: 100,
          y: 100,
          width: 1, // 非常に小さい
          height: 1,
          changeIntensity: 0.1,
          pixelCount: 1,
        },
      ];
      const viewport: Viewport = { width: 1920, height: 1080 };

      const result = detector.analyzeFramePair(diffRegions, viewport);

      // 非常に小さな変化はCLSに影響しない
      expect(result.cls).toBeLessThan(0.001);
    });
  });

  // ===========================================================================
  // パフォーマンス要件
  // ===========================================================================
  describe('パフォーマンス', () => {
    it('100個の差分領域を1秒以内に処理できる', () => {
      const diffRegions: DiffRegion[] = Array.from({ length: 100 }, (_, i) => ({
        x: i * 10,
        y: i * 10,
        width: 50,
        height: 50,
        changeIntensity: 0.5,
        pixelCount: 2500,
      }));
      const viewport: Viewport = { width: 1920, height: 1080 };

      const startTime = performance.now();
      detector.analyzeFramePair(diffRegions, viewport);
      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(1000);
    });
  });
});
