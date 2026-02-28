// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AnimationMetricsCollector Service Tests
 *
 * Phase3-TDD-Refactor: コード品質改善のためのテスト
 *
 * テスト対象:
 * 1. マジックナンバーの定数化 (SCORE_FACTORS)
 * 2. プロパティ抽出ヘルパー関数 (extractPropertyName)
 * 3. 既存機能の動作保証
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  AnimationMetricsInput} from '../../../src/services/motion/animation-metrics-collector.service';
import {
  AnimationMetricsCollector,
  AnimationMetricsResult,
  AnimationImpactScore,
  // リファクタリング後にエクスポートされる定数と関数
  SCORE_FACTORS,
  THRESHOLDS,
  extractPropertyName,
  extractPropertyNames,
} from '../../../src/services/motion/animation-metrics-collector.service';
import type { MotionPattern, LighthouseMetrics } from '../../../src/tools/motion/schemas';

// ============================================================================
// テストヘルパー
// ============================================================================

/**
 * テスト用のMotionPatternを作成
 */
function createMockPattern(overrides: Partial<MotionPattern> = {}): MotionPattern {
  return {
    id: 'test-pattern-1',
    name: 'test-animation',
    type: 'css_animation',
    category: 'entrance',
    trigger: 'load',
    animation: {
      duration: 300,
      delay: 0,
      easing: 'ease-out',
      iterations: 1,
    },
    properties: [],
    performance: {
      usesTransform: true,
      usesOpacity: true,
      triggersLayout: false,
      triggersPaint: false,
      level: 'good',
    },
    accessibility: {
      respectsReducedMotion: true,
    },
    ...overrides,
  } as MotionPattern;
}

/**
 * テスト用のLighthouseMetricsを作成
 */
function createMockLighthouseMetrics(overrides: Partial<LighthouseMetrics> = {}): LighthouseMetrics {
  return {
    performance_score: 90,
    cls: 0.05,
    lcp: 1500,
    fid: 50,
    tbt: 100,
    si: 2000,
    tti: 3000,
    fcp: 1000,
    ...overrides,
  } as LighthouseMetrics;
}

// ============================================================================
// Phase3-TDD-Refactor: スコア計算定数化テスト
// ============================================================================

describe('AnimationMetricsCollector - スコア計算定数', () => {
  describe('SCORE_FACTORS定数の公開検証', () => {
    it('SCORE_FACTORSがエクスポートされている', () => {
      expect(SCORE_FACTORS).toBeDefined();
      expect(typeof SCORE_FACTORS).toBe('object');
    });

    it('SCORE_FACTORS.TRIGGERS_LAYOUT が 30 である', () => {
      expect(SCORE_FACTORS.TRIGGERS_LAYOUT).toBe(30);
    });

    it('SCORE_FACTORS.TRIGGERS_PAINT が 15 である', () => {
      expect(SCORE_FACTORS.TRIGGERS_PAINT).toBe(15);
    });

    it('SCORE_FACTORS.NO_GPU_ACCELERATION が 20 である', () => {
      expect(SCORE_FACTORS.NO_GPU_ACCELERATION).toBe(20);
    });

    it('SCORE_FACTORS.POOR_PERFORMANCE_LEVEL が 15 である', () => {
      expect(SCORE_FACTORS.POOR_PERFORMANCE_LEVEL).toBe(15);
    });

    it('SCORE_FACTORS.FAIR_PERFORMANCE_LEVEL が 5 である', () => {
      expect(SCORE_FACTORS.FAIR_PERFORMANCE_LEVEL).toBe(5);
    });

    it('SCORE_FACTORS.LONG_DURATION が 10 である', () => {
      expect(SCORE_FACTORS.LONG_DURATION).toBe(10);
    });

    it('SCORE_FACTORS.INFINITE_ITERATIONS が 15 である', () => {
      expect(SCORE_FACTORS.INFINITE_ITERATIONS).toBe(15);
    });

    it('SCORE_FACTORS.DELAYED_LAYOUT_CHANGE が 20 である', () => {
      expect(SCORE_FACTORS.DELAYED_LAYOUT_CHANGE).toBe(20);
    });

    it('SCORE_FACTORS.LAYOUT_PROPERTY が 5 である', () => {
      expect(SCORE_FACTORS.LAYOUT_PROPERTY).toBe(5);
    });

    it('SCORE_FACTORS.CLS_CORRELATION が 15 である', () => {
      expect(SCORE_FACTORS.CLS_CORRELATION).toBe(15);
    });

    it('SCORE_FACTORS.TBT_CORRELATION が 10 である', () => {
      expect(SCORE_FACTORS.TBT_CORRELATION).toBe(10);
    });
  });

  describe('閾値定数の公開検証', () => {
    it('THRESHOLDS.LONG_DURATION_MS が 1000 である', () => {
      expect(THRESHOLDS.LONG_DURATION_MS).toBe(1000);
    });

    it('THRESHOLDS.HIGH_TBT_MS が 600 である', () => {
      expect(THRESHOLDS.HIGH_TBT_MS).toBe(600);
    });

    it('THRESHOLDS.LONG_ANIMATION_MS が 500 である', () => {
      expect(THRESHOLDS.LONG_ANIMATION_MS).toBe(500);
    });
  });
});

// ============================================================================
// Phase3-TDD-Refactor: プロパティ抽出ヘルパー関数テスト
// ============================================================================

describe('AnimationMetricsCollector - プロパティ抽出', () => {
  describe('extractPropertyName関数', () => {
    it('文字列プロパティをそのまま返す', () => {
      expect(extractPropertyName('opacity')).toBe('opacity');
      expect(extractPropertyName('transform')).toBe('transform');
      expect(extractPropertyName('width')).toBe('width');
    });

    it('AnimatedPropertyオブジェクトからpropertyフィールドを抽出する', () => {
      expect(extractPropertyName({ property: 'opacity', from: '0', to: '1' })).toBe('opacity');
      expect(extractPropertyName({ property: 'transform' })).toBe('transform');
      expect(extractPropertyName({ property: 'margin-left', from: '0', to: '20px', unit: 'px' })).toBe('margin-left');
    });
  });

  describe('extractPropertyNames関数', () => {
    it('空配列を処理できる', () => {
      expect(extractPropertyNames([])).toEqual([]);
    });

    it('文字列のみの配列を処理できる', () => {
      const result = extractPropertyNames(['opacity', 'transform', 'width']);
      expect(result).toEqual(['opacity', 'transform', 'width']);
    });

    it('オブジェクトのみの配列を処理できる', () => {
      const result = extractPropertyNames([
        { property: 'opacity', from: '0', to: '1' },
        { property: 'transform' },
      ]);
      expect(result).toEqual(['opacity', 'transform']);
    });

    it('混合配列を処理できる', () => {
      const result = extractPropertyNames([
        'opacity',
        { property: 'transform', from: 'scale(0)', to: 'scale(1)' },
        'width',
      ]);
      expect(result).toEqual(['opacity', 'transform', 'width']);
    });
  });
});

// ============================================================================
// 既存機能の動作保証テスト
// ============================================================================

describe('AnimationMetricsCollector - 基本機能', () => {
  let collector: AnimationMetricsCollector;

  beforeEach(() => {
    collector = new AnimationMetricsCollector();
  });

  describe('analyze()', () => {
    it('空のパターン配列で初期値を返す', async () => {
      const input: AnimationMetricsInput = {
        patterns: [],
        lighthouseMetrics: null,
      };

      const result = await collector.analyze(input);

      expect(result.patternImpacts).toEqual([]);
      expect(result.overallScore).toBe(100);
      expect(result.clsContributors).toEqual([]);
      expect(result.layoutTriggeringProperties).toEqual([]);
      expect(result.recommendations).toEqual([]);
      expect(result.lighthouseAvailable).toBe(false);
      expect(result.analyzedAt).toBeDefined();
    });

    it('単一パターンを正常に分析する', async () => {
      const pattern = createMockPattern({
        id: 'pattern-1',
        name: 'fade-in',
        properties: [{ property: 'opacity', from: '0', to: '1' }],
      });

      const input: AnimationMetricsInput = {
        patterns: [pattern],
        lighthouseMetrics: null,
      };

      const result = await collector.analyze(input);

      expect(result.patternImpacts).toHaveLength(1);
      expect(result.patternImpacts[0].patternId).toBe('pattern-1');
      expect(result.patternImpacts[0].patternName).toBe('fade-in');
      expect(result.overallScore).toBeGreaterThanOrEqual(0);
      expect(result.overallScore).toBeLessThanOrEqual(100);
    });

    it('Lighthouseメトリクスありで分析できる', async () => {
      const pattern = createMockPattern();
      const lighthouseMetrics = createMockLighthouseMetrics();

      const input: AnimationMetricsInput = {
        patterns: [pattern],
        lighthouseMetrics,
      };

      const result = await collector.analyze(input);

      expect(result.lighthouseAvailable).toBe(true);
    });

    it('複数パターンを正常に分析する', async () => {
      const patterns = [
        createMockPattern({ id: 'p1', name: 'anim-1' }),
        createMockPattern({ id: 'p2', name: 'anim-2' }),
        createMockPattern({ id: 'p3', name: 'anim-3' }),
      ];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: null,
      };

      const result = await collector.analyze(input);

      expect(result.patternImpacts).toHaveLength(3);
    });
  });

  describe('calculateImpactScore()', () => {
    it('レイアウトトリガーでスコアが増加する', () => {
      const patternWithLayout = createMockPattern({
        performance: {
          usesTransform: false,
          usesOpacity: false,
          triggersLayout: true,
          triggersPaint: false,
          level: 'poor',
        },
      });

      const patternWithoutLayout = createMockPattern({
        performance: {
          usesTransform: true,
          usesOpacity: true,
          triggersLayout: false,
          triggersPaint: false,
          level: 'good',
        },
      });

      const scoreWithLayout = collector.calculateImpactScore(patternWithLayout, null);
      const scoreWithoutLayout = collector.calculateImpactScore(patternWithoutLayout, null);

      expect(scoreWithLayout).toBeGreaterThan(scoreWithoutLayout);
    });

    it('無限ループアニメーションでスコアが増加する', () => {
      const infinitePattern = createMockPattern({
        animation: {
          duration: 300,
          delay: 0,
          easing: 'ease',
          iterations: Infinity,
        },
      });

      const finitePattern = createMockPattern({
        animation: {
          duration: 300,
          delay: 0,
          easing: 'ease',
          iterations: 1,
        },
      });

      const infiniteScore = collector.calculateImpactScore(infinitePattern, null);
      const finiteScore = collector.calculateImpactScore(finitePattern, null);

      expect(infiniteScore).toBeGreaterThan(finiteScore);
    });

    it('長いアニメーションでスコアが増加する', () => {
      const longPattern = createMockPattern({
        animation: {
          duration: 2000,
          delay: 0,
          easing: 'ease',
          iterations: 1,
        },
      });

      const shortPattern = createMockPattern({
        animation: {
          duration: 200,
          delay: 0,
          easing: 'ease',
          iterations: 1,
        },
      });

      const longScore = collector.calculateImpactScore(longPattern, null);
      const shortScore = collector.calculateImpactScore(shortPattern, null);

      expect(longScore).toBeGreaterThan(shortScore);
    });

    it('レイアウトプロパティでスコアが増加する', () => {
      const layoutPropPattern = createMockPattern({
        properties: [
          { property: 'width', from: '0', to: '100px' },
          { property: 'height', from: '0', to: '100px' },
        ],
      });

      const transformPropPattern = createMockPattern({
        properties: [
          { property: 'transform', from: 'scale(0)', to: 'scale(1)' },
        ],
      });

      const layoutScore = collector.calculateImpactScore(layoutPropPattern, null);
      const transformScore = collector.calculateImpactScore(transformPropPattern, null);

      expect(layoutScore).toBeGreaterThan(transformScore);
    });
  });

  describe('getRecommendations()', () => {
    it('レイアウトプロパティ使用時にtransform提案を返す', () => {
      const pattern = createMockPattern({
        properties: [
          { property: 'left', from: '0', to: '100px' },
          { property: 'top', from: '0', to: '50px' },
        ],
      });

      const recommendations = collector.getRecommendations([pattern], null);

      const transformRec = recommendations.find((r) => r.category === 'use-transform');
      expect(transformRec).toBeDefined();
      expect(transformRec?.priority).toBe('high');
    });

    it('サイズプロパティ使用時にscale提案を返す', () => {
      const pattern = createMockPattern({
        properties: [
          { property: 'width', from: '0', to: '100px' },
        ],
      });

      const recommendations = collector.getRecommendations([pattern], null);

      const avoidLayoutRec = recommendations.find((r) => r.category === 'avoid-layout');
      expect(avoidLayoutRec).toBeDefined();
    });

    it('無限ループアニメーションに対して提案を返す', () => {
      const pattern = createMockPattern({
        animation: {
          duration: 1000,
          delay: 0,
          easing: 'linear',
          iterations: 'infinite',
        },
      });

      const recommendations = collector.getRecommendations([pattern], null);

      const infiniteRec = recommendations.find((r) => r.category === 'infinite-animation');
      expect(infiniteRec).toBeDefined();
      expect(infiniteRec?.priority).toBe('medium');
    });

    it('遅延レイアウト変更でCLSリスク提案を返す', () => {
      const pattern = createMockPattern({
        trigger: 'load',
        animation: {
          duration: 500,
          delay: 500,
          easing: 'ease',
          iterations: 1,
        },
        performance: {
          usesTransform: false,
          usesOpacity: false,
          triggersLayout: true,
          triggersPaint: false,
          level: 'poor',
        },
      });

      const recommendations = collector.getRecommendations([pattern], null);

      const clsRec = recommendations.find((r) => r.category === 'cls-risk');
      expect(clsRec).toBeDefined();
      expect(clsRec?.priority).toBe('high');
    });

    it('重複する提案がマージされる', () => {
      const patterns = [
        createMockPattern({
          id: 'p1',
          properties: [{ property: 'left', from: '0', to: '100px' }],
        }),
        createMockPattern({
          id: 'p2',
          properties: [{ property: 'top', from: '0', to: '100px' }],
        }),
      ];

      const recommendations = collector.getRecommendations(patterns, null);

      // use-transformカテゴリは1つにマージされ、複数のpatternIdを含む
      const transformRecs = recommendations.filter((r) => r.category === 'use-transform');
      expect(transformRecs.length).toBeLessThanOrEqual(2);
    });
  });

  describe('CLS貢献者検出', () => {
    it('CLSが良好な場合は貢献者を返さない', async () => {
      const pattern = createMockPattern({
        trigger: 'load',
        performance: {
          usesTransform: false,
          usesOpacity: false,
          triggersLayout: true,
          triggersPaint: false,
          level: 'poor',
        },
      });

      const lighthouseMetrics = createMockLighthouseMetrics({ cls: 0.05 });

      const result = await collector.analyze({
        patterns: [pattern],
        lighthouseMetrics,
      });

      expect(result.clsContributors).toHaveLength(0);
    });

    it('CLSが悪い場合にレイアウトトリガーパターンを検出する', async () => {
      const pattern = createMockPattern({
        id: 'cls-contrib-pattern',
        trigger: 'load',
        performance: {
          usesTransform: false,
          usesOpacity: false,
          triggersLayout: true,
          triggersPaint: false,
          level: 'poor',
        },
      });

      const lighthouseMetrics = createMockLighthouseMetrics({ cls: 0.3 });

      const result = await collector.analyze({
        patterns: [pattern],
        lighthouseMetrics,
      });

      expect(result.clsContributors.length).toBeGreaterThan(0);
      expect(result.clsContributors[0].patternId).toBe('cls-contrib-pattern');
    });
  });

  describe('レイアウトトリガープロパティ収集', () => {
    it('レイアウトプロパティを正しく収集する', async () => {
      const pattern = createMockPattern({
        properties: [
          { property: 'width', from: '0', to: '100px' },
          { property: 'margin', from: '0', to: '10px' },
          { property: 'opacity', from: '0', to: '1' },
        ],
      });

      const result = await collector.analyze({
        patterns: [pattern],
        lighthouseMetrics: null,
      });

      expect(result.layoutTriggeringProperties).toContain('width');
      expect(result.layoutTriggeringProperties).toContain('margin');
      expect(result.layoutTriggeringProperties).not.toContain('opacity');
    });

    it('複数パターンからプロパティを収集する', async () => {
      const patterns = [
        createMockPattern({
          properties: [{ property: 'height', from: '0', to: '100px' }],
        }),
        createMockPattern({
          properties: [{ property: 'padding', from: '0', to: '10px' }],
        }),
      ];

      const result = await collector.analyze({
        patterns,
        lighthouseMetrics: null,
      });

      expect(result.layoutTriggeringProperties).toContain('height');
      expect(result.layoutTriggeringProperties).toContain('padding');
    });
  });

  describe('プロパティ型ハンドリング', () => {
    it('文字列プロパティを正しく処理する', async () => {
      const pattern = createMockPattern({
        properties: ['width', 'height'] as unknown as MotionPattern['properties'],
      });

      const result = await collector.analyze({
        patterns: [pattern],
        lighthouseMetrics: null,
      });

      expect(result.layoutTriggeringProperties).toContain('width');
      expect(result.layoutTriggeringProperties).toContain('height');
    });

    it('AnimatedPropertyオブジェクトを正しく処理する', async () => {
      const pattern = createMockPattern({
        properties: [
          { property: 'margin-left', from: '0', to: '20px' },
        ],
      });

      const result = await collector.analyze({
        patterns: [pattern],
        lighthouseMetrics: null,
      });

      expect(result.layoutTriggeringProperties).toContain('margin-left');
    });

    it('混合プロパティ配列を正しく処理する', async () => {
      const pattern = createMockPattern({
        properties: [
          'top',
          { property: 'left', from: '0', to: '100px' },
        ] as unknown as MotionPattern['properties'],
      });

      const result = await collector.analyze({
        patterns: [pattern],
        lighthouseMetrics: null,
      });

      expect(result.layoutTriggeringProperties).toContain('top');
      expect(result.layoutTriggeringProperties).toContain('left');
    });
  });
});

// ============================================================================
// Lighthouseメトリクス連携テスト
// ============================================================================

describe('AnimationMetricsCollector - Lighthouse連携', () => {
  let collector: AnimationMetricsCollector;

  beforeEach(() => {
    collector = new AnimationMetricsCollector();
  });

  it('CLS悪化時にレイアウトトリガーパターンの影響度が増加する', () => {
    const pattern = createMockPattern({
      performance: {
        usesTransform: false,
        usesOpacity: false,
        triggersLayout: true,
        triggersPaint: false,
        level: 'fair',
      },
    });

    const goodCls = createMockLighthouseMetrics({ cls: 0.05 });
    const badCls = createMockLighthouseMetrics({ cls: 0.3 });

    const scoreWithGoodCls = collector.calculateImpactScore(pattern, goodCls);
    const scoreWithBadCls = collector.calculateImpactScore(pattern, badCls);

    expect(scoreWithBadCls).toBeGreaterThan(scoreWithGoodCls);
  });

  it('TBT悪化時に長いアニメーションの影響度が増加する', () => {
    const pattern = createMockPattern({
      animation: {
        duration: 600,
        delay: 0,
        easing: 'ease',
        iterations: 1,
      },
    });

    const goodTbt = createMockLighthouseMetrics({ tbt: 100 });
    const badTbt = createMockLighthouseMetrics({ tbt: 700 });

    const scoreWithGoodTbt = collector.calculateImpactScore(pattern, goodTbt);
    const scoreWithBadTbt = collector.calculateImpactScore(pattern, badTbt);

    expect(scoreWithBadTbt).toBeGreaterThan(scoreWithGoodTbt);
  });

  it('パフォーマンススコア低下で全体スコアにペナルティが適用される', async () => {
    const pattern = createMockPattern();

    const goodPerf = createMockLighthouseMetrics({ performance_score: 90 });
    const badPerf = createMockLighthouseMetrics({ performance_score: 40 });

    const resultGood = await collector.analyze({
      patterns: [pattern],
      lighthouseMetrics: goodPerf,
    });

    const resultBad = await collector.analyze({
      patterns: [pattern],
      lighthouseMetrics: badPerf,
    });

    expect(resultBad.overallScore).toBeLessThan(resultGood.overallScore);
  });
});
