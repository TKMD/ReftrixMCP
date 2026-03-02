// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Quality Evaluator Service Tests
 *
 * ResponsiveQualityEvaluatorService のユニットテスト
 * calculateOverallScore のスコア計算ロジックを中心にテストする
 *
 * @module tests/services/responsive/responsive-quality-evaluator.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ResponsiveQualityEvaluatorService } from '../../../src/services/responsive/responsive-quality-evaluator.service';
import type {
  ViewportQualityResult,
  TouchTargetResult,
  ReadabilityResult,
  OverflowResult,
  ResponsiveImageResult,
  ResponsiveViewport,
} from '../../../src/services/responsive/types';

// ============================================================================
// テスト用サブクラス（private メソッドを公開）
// ============================================================================

class TestableEvaluator extends ResponsiveQualityEvaluatorService {
  /**
   * calculateOverallScore をテスト用に公開
   */
  public testCalculateOverallScore(results: ViewportQualityResult[]): number {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テスト用に private メソッドにアクセス
    return (this as any).calculateOverallScore(results);
  }
}

// ============================================================================
// ヘルパー関数
// ============================================================================

function createViewport(name: string): ResponsiveViewport {
  const presets: Record<string, ResponsiveViewport> = {
    desktop: { name: 'desktop', width: 1440, height: 900 },
    tablet: { name: 'tablet', width: 768, height: 1024 },
    mobile: { name: 'mobile', width: 375, height: 667 },
  };
  return presets[name] ?? { name, width: 1024, height: 768 };
}

function createQualityResult(
  overrides: Partial<{
    viewportName: string;
    touchTargets: Partial<TouchTargetResult>;
    readability: Partial<ReadabilityResult>;
    overflow: Partial<OverflowResult>;
    images: Partial<ResponsiveImageResult>;
  }> = {}
): ViewportQualityResult {
  const viewportName = overrides.viewportName ?? 'mobile';

  const touchTargets: TouchTargetResult = {
    passed: 0,
    failed: 0,
    failedElements: [],
    ...overrides.touchTargets,
  };

  const readability: ReadabilityResult = {
    fontSizeOk: true,
    lineLengthOk: true,
    lineHeightOk: true,
    details: { minFontSize: 16, avgLineLength: 60, avgLineHeight: 1.6, sampleCount: 10 },
    ...overrides.readability,
  };

  const overflow: OverflowResult = {
    horizontalScroll: false,
    overflowElements: [],
    ...overrides.overflow,
  };

  const images: ResponsiveImageResult = {
    srcsetCount: 0,
    pictureCount: 0,
    missingResponsive: 0,
    ...overrides.images,
  };

  return {
    viewport: createViewport(viewportName),
    touchTargets,
    readability,
    overflow,
    images,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ResponsiveQualityEvaluatorService', () => {
  // ==========================================================================
  // calculateOverallScore
  // ==========================================================================

  describe('calculateOverallScore', () => {
    let evaluator: TestableEvaluator;

    beforeEach(() => {
      evaluator = new TestableEvaluator();
    });

    it('空の結果配列で 0 を返す', () => {
      const score = evaluator.testCalculateOverallScore([]);
      expect(score).toBe(0);
    });

    it('全チェックOKで 100点', () => {
      const result = createQualityResult({
        touchTargets: { passed: 10, failed: 0 },
        readability: { fontSizeOk: true, lineLengthOk: true, lineHeightOk: true },
        overflow: { horizontalScroll: false, overflowElements: [] },
        images: { srcsetCount: 5, pictureCount: 0, missingResponsive: 0 },
      });

      const score = evaluator.testCalculateOverallScore([result]);
      expect(score).toBe(100);
    });

    // ================================================================
    // タッチターゲット (30点満点)
    // ================================================================

    describe('タッチターゲット (30点)', () => {
      it('全要素が44x44px以上 → 30点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 20, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 0, overflow: 0, images: 0 = 30
        expect(score).toBe(30);
      });

      it('半分の要素が基準未満 → 15点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 5, failed: 5 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 15, readability: 0, overflow: 0, images: 0 = 15
        expect(score).toBe(15);
      });

      it('全要素が基準未満 → 0点', () => {
        const result = createQualityResult({
          touchTargets: {
            passed: 0,
            failed: 10,
            failedElements: [
              { selector: 'a.small', width: 30, height: 30 },
            ],
          },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 0, readability: 0, overflow: 0, images: 0 = 0
        expect(score).toBe(0);
      });

      it('タッチ対象要素が0件 → 30点（ペナルティなし）', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 0, overflow: 0, images: 0 = 30
        expect(score).toBe(30);
      });
    });

    // ================================================================
    // 読みやすさ (30点満点: 3項目 x 10点)
    // ================================================================

    describe('読みやすさ (30点)', () => {
      it('fontSize >= 16px → fontSizeOk で 10点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: true, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 10, overflow: 0, images: 0 = 40
        expect(score).toBe(40);
      });

      it('lineHeight >= 1.5 → lineHeightOk で 10点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: true },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 10, overflow: 0, images: 0 = 40
        expect(score).toBe(40);
      });

      it('lineLength <= 80文字 → lineLengthOk で 10点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: true, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 10, overflow: 0, images: 0 = 40
        expect(score).toBe(40);
      });

      it('3項目すべてOK → 30点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: true, lineLengthOk: true, lineHeightOk: true },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 30, overflow: 0, images: 0 = 60
        expect(score).toBe(60);
      });

      it('3項目すべてNG → 0点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 0, overflow: 0, images: 0 = 30
        expect(score).toBe(30);
      });
    });

    // ================================================================
    // オーバーフロー検出 (20点満点)
    // ================================================================

    describe('オーバーフロー (20点)', () => {
      it('水平スクロールなし + オーバーフロー要素なし → 20点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: false, overflowElements: [] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 0, overflow: 20, images: 0 = 50
        expect(score).toBe(50);
      });

      it('水平スクロールなし + オーバーフロー要素あり → 10点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: false, overflowElements: ['div.wide'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 0, overflow: 10, images: 0 = 40
        expect(score).toBe(40);
      });

      it('水平スクロールあり → 0点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: [] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 10 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 0, overflow: 0, images: 0 = 30
        expect(score).toBe(30);
      });
    });

    // ================================================================
    // レスポンシブ画像 (20点満点)
    // ================================================================

    describe('レスポンシブ画像 (20点)', () => {
      it('全画像 srcset あり → 20点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 5, pictureCount: 0, missingResponsive: 0 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 0, overflow: 0, images: 20 = 50
        expect(score).toBe(50);
      });

      it('srcset なし + missingResponsive あり → 0点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 5 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 0, overflow: 0, images: 0 = 30
        expect(score).toBe(30);
      });

      it('画像なし → 20点（ペナルティなし）', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 0 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // touchTargets: 30, readability: 0, overflow: 0, images: 20 = 50
        expect(score).toBe(50);
      });

      it('picture 要素がカウントされる', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 2, pictureCount: 3, missingResponsive: 3 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // totalImages = 2 + 3 = 5, responsiveRatio = (2+3)/5 = 1.0 → 20点
        // touchTargets: 30, readability: 0, overflow: 0, images: 20 = 50
        expect(score).toBe(50);
      });

      it('一部のみ srcset → 部分点', () => {
        const result = createQualityResult({
          touchTargets: { passed: 0, failed: 0 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 2, pictureCount: 0, missingResponsive: 2 },
        });

        const score = evaluator.testCalculateOverallScore([result]);
        // totalImages = 2 + 2 = 4, responsiveRatio = 2/4 = 0.5 → 10点
        // touchTargets: 30, readability: 0, overflow: 0, images: 10 = 40
        expect(score).toBe(40);
      });
    });

    // ================================================================
    // 複数ビューポート
    // ================================================================

    describe('複数ビューポートの平均化', () => {
      it('2ビューポートのスコアが平均化される', () => {
        const perfect = createQualityResult({
          viewportName: 'desktop',
          touchTargets: { passed: 10, failed: 0 },
          readability: { fontSizeOk: true, lineLengthOk: true, lineHeightOk: true },
          overflow: { horizontalScroll: false, overflowElements: [] },
          images: { srcsetCount: 5, pictureCount: 0, missingResponsive: 0 },
        }); // 100点

        const poor = createQualityResult({
          viewportName: 'mobile',
          touchTargets: { passed: 0, failed: 10 },
          readability: { fontSizeOk: false, lineLengthOk: false, lineHeightOk: false },
          overflow: { horizontalScroll: true, overflowElements: ['div'] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 5 },
        }); // 0点

        const score = evaluator.testCalculateOverallScore([perfect, poor]);
        // (100 + 0) / 2 = 50
        expect(score).toBe(50);
      });

      it('3ビューポートのスコアが平均化される', () => {
        const good = createQualityResult({
          viewportName: 'desktop',
          touchTargets: { passed: 10, failed: 0 },
          readability: { fontSizeOk: true, lineLengthOk: true, lineHeightOk: true },
          overflow: { horizontalScroll: false, overflowElements: [] },
          images: { srcsetCount: 5, pictureCount: 0, missingResponsive: 0 },
        }); // 100点

        const medium = createQualityResult({
          viewportName: 'tablet',
          touchTargets: { passed: 10, failed: 0 },
          readability: { fontSizeOk: true, lineLengthOk: true, lineHeightOk: true },
          overflow: { horizontalScroll: false, overflowElements: [] },
          images: { srcsetCount: 0, pictureCount: 0, missingResponsive: 5 },
        }); // 80点 (images: 0)

        const mobile = createQualityResult({
          viewportName: 'mobile',
          touchTargets: { passed: 10, failed: 0 },
          readability: { fontSizeOk: true, lineLengthOk: false, lineHeightOk: true },
          overflow: { horizontalScroll: false, overflowElements: [] },
          images: { srcsetCount: 5, pictureCount: 0, missingResponsive: 0 },
        }); // 90点 (lineLengthOk: false → -10)

        const score = evaluator.testCalculateOverallScore([good, medium, mobile]);
        // (100 + 80 + 90) / 3 = 90
        expect(score).toBe(90);
      });
    });
  });

  // ==========================================================================
  // TouchTargetResult 型テスト
  // ==========================================================================

  describe('TouchTargetResult 構造', () => {
    it('44x44px以上の要素は passed にカウント', () => {
      const result: TouchTargetResult = {
        passed: 5,
        failed: 0,
        failedElements: [],
      };

      expect(result.passed).toBe(5);
      expect(result.failed).toBe(0);
      expect(result.failedElements).toHaveLength(0);
    });

    it('44x44px未満の要素は failed + failedElements に含まれる', () => {
      const result: TouchTargetResult = {
        passed: 3,
        failed: 2,
        failedElements: [
          { selector: 'a.small-link', width: 30, height: 20 },
          { selector: 'button.icon-btn', width: 24, height: 24 },
        ],
      };

      expect(result.failed).toBe(2);
      expect(result.failedElements).toHaveLength(2);
      expect(result.failedElements[0]!.width).toBeLessThan(44);
      expect(result.failedElements[1]!.height).toBeLessThan(44);
    });
  });

  // ==========================================================================
  // ReadabilityResult 型テスト
  // ==========================================================================

  describe('ReadabilityResult 構造', () => {
    it('基準を満たすケース', () => {
      const result: ReadabilityResult = {
        fontSizeOk: true,
        lineLengthOk: true,
        lineHeightOk: true,
        details: {
          minFontSize: 18,
          avgLineLength: 65,
          avgLineHeight: 1.6,
          sampleCount: 15,
        },
      };

      expect(result.fontSizeOk).toBe(true);
      expect(result.details.minFontSize).toBeGreaterThanOrEqual(16);
      expect(result.details.avgLineLength).toBeLessThanOrEqual(80);
      expect(result.details.avgLineHeight).toBeGreaterThanOrEqual(1.5);
    });

    it('基準を満たさないケース', () => {
      const result: ReadabilityResult = {
        fontSizeOk: false,
        lineLengthOk: false,
        lineHeightOk: false,
        details: {
          minFontSize: 12,
          avgLineLength: 120,
          avgLineHeight: 1.2,
          sampleCount: 20,
        },
      };

      expect(result.fontSizeOk).toBe(false);
      expect(result.details.minFontSize).toBeLessThan(16);
      expect(result.details.avgLineLength).toBeGreaterThan(80);
      expect(result.details.avgLineHeight).toBeLessThan(1.5);
    });
  });

  // ==========================================================================
  // OverflowResult 型テスト
  // ==========================================================================

  describe('OverflowResult 構造', () => {
    it('オーバーフローなし', () => {
      const result: OverflowResult = {
        horizontalScroll: false,
        overflowElements: [],
      };

      expect(result.horizontalScroll).toBe(false);
      expect(result.overflowElements).toHaveLength(0);
    });

    it('水平スクロール + オーバーフロー要素検出', () => {
      const result: OverflowResult = {
        horizontalScroll: true,
        overflowElements: ['table.data-table', 'pre.code-block'],
      };

      expect(result.horizontalScroll).toBe(true);
      expect(result.overflowElements).toHaveLength(2);
    });
  });

  // ==========================================================================
  // ResponsiveImageResult 型テスト
  // ==========================================================================

  describe('ResponsiveImageResult 構造', () => {
    it('srcset あり', () => {
      const result: ResponsiveImageResult = {
        srcsetCount: 8,
        pictureCount: 2,
        missingResponsive: 0,
      };

      expect(result.srcsetCount).toBe(8);
      expect(result.pictureCount).toBe(2);
      expect(result.missingResponsive).toBe(0);
    });

    it('srcset なしの img がある', () => {
      const result: ResponsiveImageResult = {
        srcsetCount: 3,
        pictureCount: 0,
        missingResponsive: 5,
      };

      expect(result.missingResponsive).toBe(5);
    });
  });
});
