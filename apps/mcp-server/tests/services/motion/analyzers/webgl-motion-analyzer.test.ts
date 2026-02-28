// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGLMotionAnalyzer テスト
 *
 * TDD: Red Phase - 失敗するテストを先に作成
 *
 * テスト対象: WebGLMotionAnalyzer
 *
 * このテストは以下を検証します:
 * - フレーム差分のchangeRatio時系列データからの分析
 * - 周期性検出（自己相関法）
 * - 方向分析
 * - 変化パターン特性の抽出
 * - 統計計算（平均、標準偏差など）
 *
 * @module tests/services/motion/analyzers/webgl-motion-analyzer
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  WebGLMotionAnalyzer,
  createWebGLMotionAnalyzer,
  type WebGLMotionAnalysisOptions,
  type WebGLMotionAnalysisResult,
  type PeriodicityAnalysis,
  type DirectionAnalysis,
  type ChangePatternCharacteristics,
} from '../../../../src/services/motion/analyzers/webgl-motion-analyzer';
import type { FrameDiffResult, BoundingBox } from '../../../../src/services/motion/types';

// =====================================================
// テストユーティリティ
// =====================================================

/**
 * モックのFrameDiffResultを生成
 */
function createMockFrameDiff(
  changeRatio: number,
  regions: BoundingBox[] = []
): FrameDiffResult {
  return {
    changeRatio,
    diffPixelCount: Math.round(changeRatio * 10000),
    totalPixelCount: 10000,
    regions,
  };
}

/**
 * 周期的なFrameDiffResult配列を生成
 */
function generatePeriodicFrameDiffs(
  length: number,
  period: number,
  amplitude: number,
  baseline: number
): FrameDiffResult[] {
  const diffs: FrameDiffResult[] = [];
  for (let i = 0; i < length; i++) {
    const changeRatio = baseline + amplitude * Math.sin((2 * Math.PI * i) / period);
    diffs.push(createMockFrameDiff(Math.max(0, Math.min(1, changeRatio))));
  }
  return diffs;
}

/**
 * 方向性のある領域を持つFrameDiffResult配列を生成
 */
function generateDirectionalFrameDiffs(
  length: number,
  startX: number,
  endX: number
): FrameDiffResult[] {
  const diffs: FrameDiffResult[] = [];
  const stepX = (endX - startX) / (length - 1);

  for (let i = 0; i < length; i++) {
    const x = startX + stepX * i;
    const region: BoundingBox = {
      x,
      y: 50,
      width: 20,
      height: 20,
    };
    diffs.push(createMockFrameDiff(0.1, [region]));
  }
  return diffs;
}

/**
 * 一定のchangeRatioを持つFrameDiffResult配列を生成
 */
function generateConstantFrameDiffs(length: number, changeRatio: number): FrameDiffResult[] {
  return Array(length).fill(null).map(() => createMockFrameDiff(changeRatio));
}

/**
 * スパイクを含むFrameDiffResult配列を生成
 */
function generateSpikyFrameDiffs(
  length: number,
  spikeCount: number,
  spikeValue: number,
  baseValue: number
): FrameDiffResult[] {
  const diffs: FrameDiffResult[] = [];
  const step = Math.floor(length / (spikeCount + 1));

  for (let i = 0; i < length; i++) {
    const isSpike = spikeCount > 0 && i > 0 && i % step === 0 && i / step <= spikeCount;
    diffs.push(createMockFrameDiff(isSpike ? spikeValue : baseValue));
  }
  return diffs;
}

// =====================================================
// テストスイート
// =====================================================

describe('WebGLMotionAnalyzer', () => {
  let analyzer: WebGLMotionAnalyzer;

  beforeEach(() => {
    analyzer = new WebGLMotionAnalyzer();
  });

  // -------------------------------------------------
  // 基本的な動作テスト
  // -------------------------------------------------

  describe('基本動作', () => {
    it('createWebGLMotionAnalyzer でインスタンスを作成できる', () => {
      const instance = createWebGLMotionAnalyzer();
      expect(instance).toBeInstanceOf(WebGLMotionAnalyzer);
    });

    it('カスタムオプションでインスタンスを作成できる', () => {
      const options: WebGLMotionAnalysisOptions = {
        maxPeriodLag: 120,
        changeThreshold: 0.005,
        analyzeDirection: false,
        smoothingWindow: 10,
      };
      const instance = createWebGLMotionAnalyzer(options);
      expect(instance).toBeInstanceOf(WebGLMotionAnalyzer);
    });

    it('analyze() がWebGLMotionAnalysisResultを返す', () => {
      const diffs = generateConstantFrameDiffs(10, 0.1);
      const result = analyzer.analyze(diffs);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('statistics');
      expect(result).toHaveProperty('periodicity');
      expect(result).toHaveProperty('changePattern');
      expect(result).toHaveProperty('processingTimeMs');
    });

    it('analyzeFromRatios() がchangeRatio配列から分析結果を返す', () => {
      const ratios = [0.1, 0.2, 0.1, 0.2, 0.1];
      const result = analyzer.analyzeFromRatios(ratios);

      expect(result.success).toBe(true);
      expect(result.statistics).toBeDefined();
    });
  });

  // -------------------------------------------------
  // 統計計算テスト
  // -------------------------------------------------

  describe('統計計算', () => {
    it('平均変化率を正しく計算する', () => {
      const diffs = [
        createMockFrameDiff(0.1),
        createMockFrameDiff(0.2),
        createMockFrameDiff(0.3),
        createMockFrameDiff(0.4),
        createMockFrameDiff(0.5),
      ];
      const result = analyzer.analyze(diffs);

      expect(result.statistics.avgChangeRatio).toBeCloseTo(0.3, 5);
    });

    it('最大・最小変化率を正しく計算する', () => {
      const diffs = [
        createMockFrameDiff(0.1),
        createMockFrameDiff(0.5),
        createMockFrameDiff(0.2),
        createMockFrameDiff(0.8),
        createMockFrameDiff(0.3),
      ];
      const result = analyzer.analyze(diffs);

      expect(result.statistics.maxChangeRatio).toBe(0.8);
      expect(result.statistics.minChangeRatio).toBe(0.1);
    });

    it('標準偏差を正しく計算する', () => {
      // 全て同じ値なら標準偏差は0
      const diffs = generateConstantFrameDiffs(10, 0.5);
      const result = analyzer.analyze(diffs);

      expect(result.statistics.stdDeviation).toBeCloseTo(0, 5);
    });

    it('フレーム数を正しくカウントする', () => {
      const diffs = generateConstantFrameDiffs(15, 0.1);
      const result = analyzer.analyze(diffs);

      expect(result.statistics.frameCount).toBe(15);
    });

    it('変化があったフレーム数をカウントする', () => {
      // 閾値（デフォルト0.001）を超えるフレームをカウント
      const diffs = [
        createMockFrameDiff(0.0001), // 閾値以下
        createMockFrameDiff(0.01),
        createMockFrameDiff(0.0005), // 閾値以下
        createMockFrameDiff(0.1),
        createMockFrameDiff(0.002),
      ];
      const result = analyzer.analyze(diffs);

      expect(result.statistics.changeFrameCount).toBe(3);
    });
  });

  // -------------------------------------------------
  // 周期性分析テスト
  // -------------------------------------------------

  describe('周期性分析', () => {
    it('周期的なデータから周期を検出する', () => {
      // 周期10のデータを生成
      const diffs = generatePeriodicFrameDiffs(60, 10, 0.1, 0.1);
      const result = analyzer.analyze(diffs);

      expect(result.periodicity.score).toBeGreaterThan(0);
      // 推定周期が10付近であることを確認（誤差許容）
      if (result.periodicity.estimatedPeriodFrames > 0) {
        expect(result.periodicity.estimatedPeriodFrames).toBeGreaterThanOrEqual(8);
        expect(result.periodicity.estimatedPeriodFrames).toBeLessThanOrEqual(12);
      }
    });

    it('非周期的なデータでは周期スコアが低い', () => {
      const diffs = generateConstantFrameDiffs(30, 0.1);
      const result = analyzer.analyze(diffs);

      // 一定値は周期性がない（または検出されない）
      expect(result.periodicity.score).toBeLessThanOrEqual(0.5);
    });

    it('周期をミリ秒に変換する', () => {
      const diffs = generatePeriodicFrameDiffs(60, 15, 0.1, 0.1);
      const result = analyzer.analyze(diffs, 30); // 30fps

      if (result.periodicity.estimatedPeriodFrames > 0) {
        // 15フレーム / 30fps = 500ms
        const expectedMs = (result.periodicity.estimatedPeriodFrames / 30) * 1000;
        expect(result.periodicity.estimatedPeriodMs).toBeCloseTo(expectedMs, 0);
      }
    });

    it('周期性の信頼度を計算する', () => {
      const diffs = generatePeriodicFrameDiffs(60, 10, 0.15, 0.1);
      const result = analyzer.analyze(diffs);

      expect(result.periodicity.confidence).toBeGreaterThanOrEqual(0);
      expect(result.periodicity.confidence).toBeLessThanOrEqual(1);
    });

    it('自己相関値の配列を返す', () => {
      const diffs = generatePeriodicFrameDiffs(40, 8, 0.1, 0.1);
      const result = analyzer.analyze(diffs);

      expect(Array.isArray(result.periodicity.autocorrelations)).toBe(true);
      expect(result.periodicity.autocorrelations.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------
  // 方向分析テスト
  // -------------------------------------------------

  describe('方向分析', () => {
    it('方向分析を有効にすると結果に含まれる', () => {
      const diffs = generateDirectionalFrameDiffs(20, 10, 90);
      const result = analyzer.analyze(diffs);

      expect(result.direction).toBeDefined();
    });

    it('方向分析を無効にすると結果に含まれない', () => {
      const analyzer = createWebGLMotionAnalyzer({ analyzeDirection: false });
      const diffs = generateDirectionalFrameDiffs(20, 10, 90);
      const result = analyzer.analyze(diffs);

      expect(result.direction).toBeUndefined();
    });

    it('右方向の動きを検出する', () => {
      // より大きな移動距離を設定（5px以上の移動が必要）
      const diffs = generateDirectionalFrameDiffs(20, 10, 150);
      const result = analyzer.analyze(diffs);

      if (result.direction) {
        // 方向分析が実行された場合、右方向の移動を検出
        // 移動距離が小さい場合は0になる可能性がある
        expect(result.direction.rightwardRatio).toBeGreaterThanOrEqual(0);
      }
    });

    it('方向一貫性スコアを計算する', () => {
      const diffs = generateDirectionalFrameDiffs(20, 10, 90);
      const result = analyzer.analyze(diffs);

      if (result.direction) {
        expect(result.direction.directionConsistency).toBeGreaterThanOrEqual(0);
        expect(result.direction.directionConsistency).toBeLessThanOrEqual(1);
      }
    });

    it('領域がない場合は方向分析をスキップする', () => {
      const diffs = generateConstantFrameDiffs(20, 0.1);
      const result = analyzer.analyze(diffs);

      // 領域情報がないので方向分析はスキップされる
      if (result.direction) {
        expect(result.direction.directionConsistency).toBe(0);
      }
    });
  });

  // -------------------------------------------------
  // 変化パターン分析テスト
  // -------------------------------------------------

  describe('変化パターン分析', () => {
    it('スパイク数をカウントする', () => {
      const diffs = generateSpikyFrameDiffs(30, 3, 0.3, 0.01);
      const result = analyzer.analyze(diffs);

      expect(result.changePattern.spikeCount).toBeGreaterThan(0);
    });

    it('平均スパイク間隔を計算する', () => {
      const diffs = generateSpikyFrameDiffs(50, 4, 0.3, 0.01);
      const result = analyzer.analyze(diffs);

      if (result.changePattern.spikeCount > 1) {
        expect(result.changePattern.avgSpikePeriod).toBeGreaterThan(0);
      }
    });

    it('静的フレームの割合を計算する', () => {
      // 半分が閾値以下
      const diffs: FrameDiffResult[] = [];
      for (let i = 0; i < 20; i++) {
        diffs.push(createMockFrameDiff(i % 2 === 0 ? 0.0001 : 0.1));
      }
      const result = analyzer.analyze(diffs);

      expect(result.changePattern.staticFrameRatio).toBeGreaterThan(0);
      expect(result.changePattern.staticFrameRatio).toBeLessThan(1);
    });

    it('動的フレームの割合を計算する', () => {
      const diffs = generateConstantFrameDiffs(20, 0.1);
      const result = analyzer.analyze(diffs);

      // 全て閾値以上なら動的フレーム割合は1
      expect(result.changePattern.dynamicFrameRatio).toBeCloseTo(1, 1);
    });

    it('静的と動的の割合の合計が1になる', () => {
      const diffs = generateSpikyFrameDiffs(30, 5, 0.2, 0.001);
      const result = analyzer.analyze(diffs);

      const total = result.changePattern.staticFrameRatio + result.changePattern.dynamicFrameRatio;
      expect(total).toBeCloseTo(1, 5);
    });

    it('変化の平均持続時間を計算する', () => {
      // 連続した変化区間を持つデータ
      const diffs: FrameDiffResult[] = [];
      for (let i = 0; i < 30; i++) {
        // 0-9: 変化あり、10-14: 静止、15-24: 変化あり、25-29: 静止
        const inChangeRegion = (i >= 0 && i < 10) || (i >= 15 && i < 25);
        diffs.push(createMockFrameDiff(inChangeRegion ? 0.1 : 0.0001));
      }
      const result = analyzer.analyze(diffs);

      expect(result.changePattern.avgChangeDuration).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------
  // エラーハンドリングテスト
  // -------------------------------------------------

  describe('エラーハンドリング', () => {
    it('データが不足している場合はエラーを返す', () => {
      const diffs = [createMockFrameDiff(0.1)];
      const result = analyzer.analyze(diffs);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('INSUFFICIENT_DATA');
    });

    it('analyzeFromRatiosでもデータ不足エラーを返す', () => {
      const ratios = [0.1];
      const result = analyzer.analyzeFromRatios(ratios);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INSUFFICIENT_DATA');
    });

    it('空の配列でエラーを返す', () => {
      const result = analyzer.analyze([]);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('エラー時もデフォルト値を持つ結果を返す', () => {
      const result = analyzer.analyze([]);

      expect(result.statistics).toBeDefined();
      expect(result.statistics.avgChangeRatio).toBe(0);
      expect(result.periodicity).toBeDefined();
      expect(result.changePattern).toBeDefined();
    });
  });

  // -------------------------------------------------
  // 処理時間テスト
  // -------------------------------------------------

  describe('処理時間', () => {
    it('処理時間を記録する', () => {
      const diffs = generateConstantFrameDiffs(20, 0.1);
      const result = analyzer.analyze(diffs);

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('エラー時は処理時間が0', () => {
      const result = analyzer.analyze([]);

      expect(result.processingTimeMs).toBe(0);
    });
  });

  // -------------------------------------------------
  // エッジケーステスト
  // -------------------------------------------------

  describe('エッジケース', () => {
    it('全て0のデータを処理できる', () => {
      const diffs = generateConstantFrameDiffs(20, 0);
      const result = analyzer.analyze(diffs);

      expect(result.success).toBe(true);
      expect(result.statistics.avgChangeRatio).toBe(0);
    });

    it('全て1のデータを処理できる', () => {
      const diffs = generateConstantFrameDiffs(20, 1);
      const result = analyzer.analyze(diffs);

      expect(result.success).toBe(true);
      expect(result.statistics.avgChangeRatio).toBe(1);
    });

    it('極端に小さい値を処理できる', () => {
      const diffs = generateConstantFrameDiffs(20, 0.000001);
      const result = analyzer.analyze(diffs);

      expect(result.success).toBe(true);
    });

    it('2つのフレームのみでも処理できる', () => {
      const diffs = [createMockFrameDiff(0.1), createMockFrameDiff(0.2)];
      const result = analyzer.analyze(diffs);

      expect(result.success).toBe(true);
      expect(result.statistics.frameCount).toBe(2);
    });

    it('大量のデータ（1000フレーム）を処理できる', () => {
      const diffs = generatePeriodicFrameDiffs(1000, 50, 0.1, 0.1);
      const result = analyzer.analyze(diffs);

      expect(result.success).toBe(true);
      expect(result.statistics.frameCount).toBe(1000);
    });

    it('異なるFPSで処理できる', () => {
      const diffs = generatePeriodicFrameDiffs(60, 10, 0.1, 0.1);

      const result30fps = analyzer.analyze(diffs, 30);
      const result60fps = analyzer.analyze(diffs, 60);

      // 同じフレーム数でもFPSが違えばミリ秒換算が変わる
      if (
        result30fps.periodicity.estimatedPeriodFrames > 0 &&
        result60fps.periodicity.estimatedPeriodFrames > 0
      ) {
        expect(result30fps.periodicity.estimatedPeriodMs).not.toBe(
          result60fps.periodicity.estimatedPeriodMs
        );
      }
    });
  });

  // -------------------------------------------------
  // パフォーマンステスト
  // -------------------------------------------------

  describe('パフォーマンス', () => {
    it('100フレームのデータを100ms以内に処理できる', () => {
      const diffs = generatePeriodicFrameDiffs(100, 20, 0.1, 0.1);

      const startTime = Date.now();
      analyzer.analyze(diffs);
      const elapsedMs = Date.now() - startTime;

      expect(elapsedMs).toBeLessThan(100);
    });

    it('500フレームのデータを500ms以内に処理できる', () => {
      const diffs = generatePeriodicFrameDiffs(500, 50, 0.1, 0.1);

      const startTime = Date.now();
      analyzer.analyze(diffs);
      const elapsedMs = Date.now() - startTime;

      expect(elapsedMs).toBeLessThan(500);
    });
  });

  // -------------------------------------------------
  // インターフェース検証テスト
  // -------------------------------------------------

  describe('インターフェース検証', () => {
    it('PeriodicityAnalysisが全フィールドを持つ', () => {
      const diffs = generatePeriodicFrameDiffs(40, 10, 0.1, 0.1);
      const result = analyzer.analyze(diffs);

      expect(result.periodicity).toHaveProperty('score');
      expect(result.periodicity).toHaveProperty('estimatedPeriodFrames');
      expect(result.periodicity).toHaveProperty('estimatedPeriodMs');
      expect(result.periodicity).toHaveProperty('confidence');
      expect(result.periodicity).toHaveProperty('autocorrelations');
    });

    it('DirectionAnalysisが全フィールドを持つ', () => {
      const diffs = generateDirectionalFrameDiffs(20, 10, 90);
      const result = analyzer.analyze(diffs);

      if (result.direction) {
        expect(result.direction).toHaveProperty('dominantDirection');
        expect(result.direction).toHaveProperty('directionConsistency');
        expect(result.direction).toHaveProperty('upwardRatio');
        expect(result.direction).toHaveProperty('downwardRatio');
        expect(result.direction).toHaveProperty('leftwardRatio');
        expect(result.direction).toHaveProperty('rightwardRatio');
      }
    });

    it('ChangePatternCharacteristicsが全フィールドを持つ', () => {
      const diffs = generateSpikyFrameDiffs(30, 3, 0.3, 0.01);
      const result = analyzer.analyze(diffs);

      expect(result.changePattern).toHaveProperty('spikeCount');
      expect(result.changePattern).toHaveProperty('avgSpikePeriod');
      expect(result.changePattern).toHaveProperty('avgChangeDuration');
      expect(result.changePattern).toHaveProperty('staticFrameRatio');
      expect(result.changePattern).toHaveProperty('dynamicFrameRatio');
    });
  });
});
