// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Difference Detector Service Tests — Phase 2-4
 *
 * computedStyleベースのレイアウト検出、セマンティック要素の可視性変化、
 * 拡張タイポグラフィ（h1-h6）、セクション間スペーシング検出のテスト
 *
 * @module tests/services/responsive/difference-detector.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DifferenceDetectorService } from '../../../src/services/responsive/difference-detector.service';
import type {
  ViewportCaptureResult,
  ViewportLayoutInfo,
  NavigationInfo,
  SemanticElementInfo,
} from '../../../src/services/responsive/types';

// ============================================================================
// ヘルパー関数
// ============================================================================

/**
 * Phase 2-4 対応のモックキャプチャ結果を生成
 */
function createCaptureResult(
  overrides: Partial<{
    name: string;
    width: number;
    height: number;
    navType: NavigationInfo['type'];
    hasHamburgerMenu: boolean;
    hasHorizontalMenu: boolean;
    hasBottomNav: boolean;
    gridColumns: number;
    flexDirection: string;
    scrollHeight: number;
    typography: ViewportLayoutInfo['typography'];
    spacing: ViewportLayoutInfo['spacing'];
    semanticElements: SemanticElementInfo[];
    extendedTypography: ViewportLayoutInfo['extendedTypography'];
    sectionSpacing: ViewportLayoutInfo['sectionSpacing'];
  }> = {}
): ViewportCaptureResult {
  const {
    name = 'desktop',
    width = 1920,
    height = 1080,
    navType = 'horizontal-menu',
    hasHamburgerMenu = false,
    hasHorizontalMenu = true,
    hasBottomNav = false,
    gridColumns,
    flexDirection,
    scrollHeight = 2000,
    typography,
    spacing,
    semanticElements,
    extendedTypography,
    sectionSpacing,
  } = overrides;

  const layoutInfo: ViewportLayoutInfo = {
    documentWidth: width,
    documentHeight: height * 2,
    viewportWidth: width,
    viewportHeight: height,
    scrollHeight,
    breakpoints: ['768px', '1024px'],
  };

  if (gridColumns !== undefined) layoutInfo.gridColumns = gridColumns;
  if (flexDirection !== undefined) layoutInfo.flexDirection = flexDirection;
  if (typography) layoutInfo.typography = typography;
  if (spacing) layoutInfo.spacing = spacing;
  if (semanticElements) layoutInfo.semanticElements = semanticElements;
  if (extendedTypography) layoutInfo.extendedTypography = extendedTypography;
  if (sectionSpacing) layoutInfo.sectionSpacing = sectionSpacing;

  const navigationInfo: NavigationInfo = {
    type: navType,
    hasHamburgerMenu,
    hasHorizontalMenu,
    hasBottomNav,
    selector: 'nav',
  };

  return {
    viewport: { name, width, height },
    html: `<html><body>Mock HTML for ${name}</body></html>`,
    layoutInfo,
    navigationInfo,
  };
}

// ============================================================================
// Phase 2: computedStyleベースのレイアウト・可視性検出
// ============================================================================

describe('DifferenceDetectorService — Phase 2: computedStyleベース検出', () => {
  let service: DifferenceDetectorService;

  beforeEach(() => {
    service = new DifferenceDetectorService();
  });

  describe('セマンティック要素のgrid/flex検出', () => {
    it('should detect grid column changes via semanticElements', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          semanticElements: [
            {
              selector: 'main > .grid-container',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 4,
            },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          semanticElements: [
            {
              selector: 'main > .grid-container',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 1,
            },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const layoutDiffs = result.differences.filter((d) => d.category === 'layout');
      const gridDiff = layoutDiffs.find(
        (d) => d.element === 'main > .grid-container' && d.description?.includes('グリッド')
      );
      expect(gridDiff).toBeDefined();
      expect(gridDiff?.description).toContain('4列');
      expect(gridDiff?.description).toContain('1列');
    });

    it('should detect flex direction changes via semanticElements', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          semanticElements: [
            {
              selector: 'section.features',
              tagName: 'section',
              display: 'flex',
              visibility: 'visible',
              opacity: 1,
              flexDirection: 'row',
            },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          semanticElements: [
            {
              selector: 'section.features',
              tagName: 'section',
              display: 'flex',
              visibility: 'visible',
              opacity: 1,
              flexDirection: 'column',
            },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const layoutDiffs = result.differences.filter((d) => d.category === 'layout');
      const flexDiff = layoutDiffs.find(
        (d) => d.element === 'section.features' && d.description?.includes('フレックス')
      );
      expect(flexDiff).toBeDefined();
      expect(flexDiff?.description).toContain('横並び');
      expect(flexDiff?.description).toContain('縦並び');
    });

    it('should fall back to top-level gridColumns when semanticElements is empty', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          gridColumns: 3,
          semanticElements: [], // 空
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          gridColumns: 1,
          semanticElements: [], // 空
        }),
      ];

      const result = service.detectDifferences(captures);

      const layoutDiffs = result.differences.filter((d) => d.category === 'layout');
      const gridDiff = layoutDiffs.find(
        (d) => d.element === '.grid' && d.description?.includes('グリッド')
      );
      expect(gridDiff).toBeDefined();
      expect(gridDiff?.description).toContain('3列');
      expect(gridDiff?.description).toContain('1列');
    });

    it('should not fall back to top-level gridColumns when semanticElements detected grid', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          gridColumns: 3,
          semanticElements: [
            {
              selector: '.cards',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 4,
            },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          gridColumns: 1,
          semanticElements: [
            {
              selector: '.cards',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 2,
            },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const layoutDiffs = result.differences.filter((d) => d.category === 'layout');
      // semanticElements経由の検出のみ、フォールバックなし
      const semanticGridDiff = layoutDiffs.find((d) => d.element === '.cards');
      expect(semanticGridDiff).toBeDefined();
      // top-level fallback (.grid) は出ない
      const fallbackDiff = layoutDiffs.find((d) => d.element === '.grid');
      expect(fallbackDiff).toBeUndefined();
    });

    it('should not detect grid changes when gridColumns are the same', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          semanticElements: [
            {
              selector: '.grid',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 3,
            },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          semanticElements: [
            {
              selector: '.grid',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 3,
            },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const gridDiffs = result.differences.filter(
        (d) => d.category === 'layout' && d.description?.includes('グリッド')
      );
      expect(gridDiffs).toHaveLength(0);
    });
  });

  describe('セマンティック要素の可視性変化検出', () => {
    it('should detect element hidden via display:none in mobile', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          semanticElements: [
            {
              selector: 'aside.sidebar',
              tagName: 'aside',
              display: 'block',
              visibility: 'visible',
              opacity: 1,
            },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          semanticElements: [
            {
              selector: 'aside.sidebar',
              tagName: 'aside',
              display: 'none',
              visibility: 'visible',
              opacity: 1,
            },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const visDiffs = result.differences.filter((d) => d.category === 'visibility');
      const sidebarDiff = visDiffs.find((d) => d.element === 'aside.sidebar');
      expect(sidebarDiff).toBeDefined();
      expect(sidebarDiff?.description).toContain('desktop');
      expect(sidebarDiff?.description).toContain('表示');
      expect(sidebarDiff?.description).toContain('mobile');
      expect(sidebarDiff?.description).toContain('非表示');
    });

    it('should detect element hidden via visibility:hidden in mobile', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          semanticElements: [
            {
              selector: 'figure.hero-image',
              tagName: 'figure',
              display: 'block',
              visibility: 'visible',
              opacity: 1,
            },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          semanticElements: [
            {
              selector: 'figure.hero-image',
              tagName: 'figure',
              display: 'block',
              visibility: 'hidden',
              opacity: 1,
            },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const visDiffs = result.differences.filter((d) => d.category === 'visibility');
      const figureDiff = visDiffs.find((d) => d.element === 'figure.hero-image');
      expect(figureDiff).toBeDefined();
      expect(figureDiff?.description).toContain('非表示');
    });

    it('should detect element hidden via opacity:0 in mobile', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          semanticElements: [
            {
              selector: 'section.stats',
              tagName: 'section',
              display: 'block',
              visibility: 'visible',
              opacity: 1,
            },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          semanticElements: [
            {
              selector: 'section.stats',
              tagName: 'section',
              display: 'block',
              visibility: 'visible',
              opacity: 0,
            },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const visDiffs = result.differences.filter((d) => d.category === 'visibility');
      const statsDiff = visDiffs.find((d) => d.element === 'section.stats');
      expect(statsDiff).toBeDefined();
      expect(statsDiff?.description).toContain('非表示');
    });

    it('should detect element visible only on mobile (reversed)', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          semanticElements: [
            {
              selector: 'nav.mobile-menu',
              tagName: 'nav',
              display: 'none',
              visibility: 'visible',
              opacity: 1,
            },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          semanticElements: [
            {
              selector: 'nav.mobile-menu',
              tagName: 'nav',
              display: 'block',
              visibility: 'visible',
              opacity: 1,
            },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const visDiffs = result.differences.filter((d) => d.category === 'visibility');
      const menuDiff = visDiffs.find((d) => d.element === 'nav.mobile-menu');
      expect(menuDiff).toBeDefined();
      expect(menuDiff?.description).toContain('mobileでのみ表示');
    });

    it('should not detect visibility change when both are visible', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          semanticElements: [
            {
              selector: 'main',
              tagName: 'main',
              display: 'block',
              visibility: 'visible',
              opacity: 1,
            },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          semanticElements: [
            {
              selector: 'main',
              tagName: 'main',
              display: 'flex',
              visibility: 'visible',
              opacity: 0.8,
            },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const visDiffs = result.differences.filter(
        (d) => d.category === 'visibility' && d.element === 'main'
      );
      expect(visDiffs).toHaveLength(0);
    });

    it('should not detect visibility when semanticElements are empty', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          // semanticElements 未指定
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          // semanticElements 未指定
        }),
      ];

      const result = service.detectDifferences(captures);

      // ハンバーガーメニュー関連以外の可視性差異がないことを確認
      const semanticVisDiffs = result.differences.filter(
        (d) => d.category === 'visibility' && d.element !== '.hamburger-menu'
      );
      expect(semanticVisDiffs).toHaveLength(0);
    });

    it('should include display/visibility/opacity details in diff', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          semanticElements: [
            {
              selector: 'aside',
              tagName: 'aside',
              display: 'block',
              visibility: 'visible',
              opacity: 1,
            },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          semanticElements: [
            {
              selector: 'aside',
              tagName: 'aside',
              display: 'none',
              visibility: 'visible',
              opacity: 1,
            },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const visDiff = result.differences.find(
        (d) => d.category === 'visibility' && d.element === 'aside'
      );
      expect(visDiff).toBeDefined();
      // desktop側の詳細
      expect(visDiff?.desktop).toEqual(
        expect.objectContaining({ visible: true, display: 'block' })
      );
      // mobile側の詳細
      expect(visDiff?.mobile).toEqual(
        expect.objectContaining({ visible: false, display: 'none' })
      );
    });
  });
});

// ============================================================================
// Phase 4: 拡張タイポグラフィ・セクション間スペーシング検出
// ============================================================================

describe('DifferenceDetectorService — Phase 4: 拡張タイポグラフィ・スペーシング', () => {
  let service: DifferenceDetectorService;

  beforeEach(() => {
    service = new DifferenceDetectorService();
  });

  describe('拡張タイポグラフィ検出（h1-h6 + p:first-of-type）', () => {
    it('should detect h2 font size change above 15% threshold', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          extendedTypography: {
            headings: [
              { tag: 'h1', fontSize: 48 },
              { tag: 'h2', fontSize: 36 },
              { tag: 'h3', fontSize: 28 },
            ],
          },
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          extendedTypography: {
            headings: [
              { tag: 'h1', fontSize: 32 },
              { tag: 'h2', fontSize: 24 },
              { tag: 'h3', fontSize: 20 },
            ],
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter((d) => d.category === 'typography');

      // h1: 32/48 = 66% → 検出（85%未満）
      const h1Diff = typoDiffs.find((d) => d.element === 'h1');
      expect(h1Diff).toBeDefined();
      expect(h1Diff?.description).toContain('48px');
      expect(h1Diff?.description).toContain('32px');

      // h2: 24/36 = 66% → 検出
      const h2Diff = typoDiffs.find((d) => d.element === 'h2');
      expect(h2Diff).toBeDefined();
      expect(h2Diff?.description).toContain('36px');
      expect(h2Diff?.description).toContain('24px');

      // h3: 20/28 = 71% → 検出
      const h3Diff = typoDiffs.find((d) => d.element === 'h3');
      expect(h3Diff).toBeDefined();
    });

    it('should not detect heading changes below 15% threshold', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          extendedTypography: {
            headings: [
              { tag: 'h1', fontSize: 48 },
              { tag: 'h2', fontSize: 36 },
            ],
          },
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          extendedTypography: {
            headings: [
              { tag: 'h1', fontSize: 44 }, // 44/48 = 91% → 閾値内
              { tag: 'h2', fontSize: 34 }, // 34/36 = 94% → 閾値内
            ],
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter((d) => d.category === 'typography');
      const headingDiffs = typoDiffs.filter(
        (d) => d.element === 'h1' || d.element === 'h2'
      );
      expect(headingDiffs).toHaveLength(0);
    });

    it('should detect h4-h6 font size changes', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          extendedTypography: {
            headings: [
              { tag: 'h4', fontSize: 20 },
              { tag: 'h5', fontSize: 18 },
              { tag: 'h6', fontSize: 16 },
            ],
          },
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          extendedTypography: {
            headings: [
              { tag: 'h4', fontSize: 14 }, // 70% → 検出
              { tag: 'h5', fontSize: 13 }, // 72% → 検出
              { tag: 'h6', fontSize: 12 }, // 75% → 検出
            ],
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter((d) => d.category === 'typography');
      expect(typoDiffs.find((d) => d.element === 'h4')).toBeDefined();
      expect(typoDiffs.find((d) => d.element === 'h5')).toBeDefined();
      expect(typoDiffs.find((d) => d.element === 'h6')).toBeDefined();
    });

    it('should detect p:first-of-type font size change above 15%', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          extendedTypography: {
            headings: [],
            pFirstOfType: 20,
          },
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          extendedTypography: {
            headings: [],
            pFirstOfType: 14, // 14/20 = 70% → 検出
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter((d) => d.category === 'typography');
      const pDiff = typoDiffs.find((d) => d.element === 'p:first-of-type');
      expect(pDiff).toBeDefined();
      expect(pDiff?.description).toContain('20px');
      expect(pDiff?.description).toContain('14px');
      expect(pDiff?.description).toContain('p:first-of-type');
    });

    it('should not detect p:first-of-type change below 15% threshold', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          extendedTypography: {
            headings: [],
            pFirstOfType: 18,
          },
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          extendedTypography: {
            headings: [],
            pFirstOfType: 16, // 16/18 = 88% → 閾値内
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      const pDiffs = result.differences.filter(
        (d) => d.category === 'typography' && d.element === 'p:first-of-type'
      );
      expect(pDiffs).toHaveLength(0);
    });

    it('should fall back to typography.h1FontSize when extendedTypography is absent', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          typography: { h1FontSize: 48, bodyFontSize: 16, bodyLineHeight: 1.5 },
          // extendedTypography なし
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          typography: { h1FontSize: 28, bodyFontSize: 16, bodyLineHeight: 1.5 },
          // extendedTypography なし
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter((d) => d.category === 'typography');
      const h1Diff = typoDiffs.find((d) => d.element === 'h1');
      expect(h1Diff).toBeDefined();
      expect(h1Diff?.description).toContain('h1フォントサイズ');
    });

    it('should not duplicate h1 detection when both extendedTypography and typography exist', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          typography: { h1FontSize: 48, bodyFontSize: 16, bodyLineHeight: 1.5 },
          extendedTypography: {
            headings: [{ tag: 'h1', fontSize: 48 }],
          },
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          typography: { h1FontSize: 28, bodyFontSize: 16, bodyLineHeight: 1.5 },
          extendedTypography: {
            headings: [{ tag: 'h1', fontSize: 28 }],
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      // h1の重複検出がないこと
      const h1Diffs = result.differences.filter(
        (d) => d.category === 'typography' && d.element === 'h1'
      );
      expect(h1Diffs).toHaveLength(1);
    });

    it('should skip when extendedTypography is absent on one side', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          extendedTypography: {
            headings: [{ tag: 'h1', fontSize: 48 }],
          },
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          // extendedTypography なし
        }),
      ];

      const result = service.detectDifferences(captures);

      const extTypoDiffs = result.differences.filter(
        (d) => d.category === 'typography' && d.element !== 'h1' && d.element !== 'body'
      );
      expect(extTypoDiffs).toHaveLength(0);
    });

    it('should include percentage in description', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          extendedTypography: {
            headings: [{ tag: 'h2', fontSize: 40 }],
          },
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          extendedTypography: {
            headings: [{ tag: 'h2', fontSize: 24 }],
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      const h2Diff = result.differences.find(
        (d) => d.category === 'typography' && d.element === 'h2'
      );
      expect(h2Diff).toBeDefined();
      // 24/40 = 60%
      expect(h2Diff?.description).toContain('60%');
    });
  });

  describe('セクション間スペーシング検出', () => {
    it('should detect section margin-top change above 20% threshold', () => {
      // spacing が必須（detectSpacingDifferences の早期リターン回避）
      const defaultSpacing = {
        bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: defaultSpacing,
          sectionSpacing: [
            { selector: 'section.features', marginTop: 80, marginBottom: 60 },
            { selector: 'section.pricing', marginTop: 100, marginBottom: 80 },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: defaultSpacing,
          sectionSpacing: [
            { selector: 'section.features', marginTop: 40, marginBottom: 60 },
            { selector: 'section.pricing', marginTop: 50, marginBottom: 80 },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const spacingDiffs = result.differences.filter((d) => d.category === 'spacing');

      // section.features margin-top: 40/80 = 50% → 検出
      const featuresDiff = spacingDiffs.find(
        (d) =>
          d.element === 'section.features' &&
          d.description?.includes('margin-top')
      );
      expect(featuresDiff).toBeDefined();
      expect(featuresDiff?.description).toContain('80px');
      expect(featuresDiff?.description).toContain('40px');

      // section.pricing margin-top: 50/100 = 50% → 検出
      const pricingDiff = spacingDiffs.find(
        (d) =>
          d.element === 'section.pricing' &&
          d.description?.includes('margin-top')
      );
      expect(pricingDiff).toBeDefined();
    });

    it('should detect section margin-bottom change above 20% threshold', () => {
      const defaultSpacing = {
        bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: defaultSpacing,
          sectionSpacing: [
            { selector: 'section.hero', marginTop: 0, marginBottom: 100 },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: defaultSpacing,
          sectionSpacing: [
            { selector: 'section.hero', marginTop: 0, marginBottom: 40 },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const spacingDiffs = result.differences.filter((d) => d.category === 'spacing');
      const bottomDiff = spacingDiffs.find(
        (d) =>
          d.element === 'section.hero' &&
          d.description?.includes('margin-bottom')
      );
      expect(bottomDiff).toBeDefined();
      expect(bottomDiff?.description).toContain('100px');
      expect(bottomDiff?.description).toContain('40px');
    });

    it('should not detect section margin changes below 20% threshold', () => {
      const defaultSpacing = {
        bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: defaultSpacing,
          sectionSpacing: [
            { selector: 'section.content', marginTop: 60, marginBottom: 50 },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: defaultSpacing,
          sectionSpacing: [
            // 54/60 = 90% (閾値内), 45/50 = 90% (閾値内)
            { selector: 'section.content', marginTop: 54, marginBottom: 45 },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const sectionMarginDiffs = result.differences.filter(
        (d) =>
          d.category === 'spacing' &&
          d.element === 'section.content'
      );
      expect(sectionMarginDiffs).toHaveLength(0);
    });

    it('should skip section spacing when sectionSpacing is empty', () => {
      const defaultSpacing = {
        bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: defaultSpacing,
          sectionSpacing: [],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: defaultSpacing,
          sectionSpacing: [],
        }),
      ];

      const result = service.detectDifferences(captures);

      const sectionDiffs = result.differences.filter(
        (d) =>
          d.category === 'spacing' &&
          d.element !== 'body' &&
          d.element !== 'main'
      );
      expect(sectionDiffs).toHaveLength(0);
    });

    it('should skip section spacing when only one viewport has data', () => {
      const defaultSpacing = {
        bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: defaultSpacing,
          sectionSpacing: [
            { selector: 'section.hero', marginTop: 80, marginBottom: 60 },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: defaultSpacing,
          // sectionSpacing なし
        }),
      ];

      const result = service.detectDifferences(captures);

      const sectionDiffs = result.differences.filter(
        (d) =>
          d.category === 'spacing' &&
          d.element === 'section.hero'
      );
      expect(sectionDiffs).toHaveLength(0);
    });

    it('should skip section when selector not found in smaller viewport', () => {
      const defaultSpacing = {
        bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: defaultSpacing,
          sectionSpacing: [
            { selector: 'section.desktop-only', marginTop: 80, marginBottom: 60 },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: defaultSpacing,
          sectionSpacing: [
            { selector: 'section.mobile-only', marginTop: 40, marginBottom: 30 },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const sectionDiffs = result.differences.filter(
        (d) =>
          d.category === 'spacing' &&
          (d.element === 'section.desktop-only' || d.element === 'section.mobile-only')
      );
      expect(sectionDiffs).toHaveLength(0);
    });

    it('should include percentage in spacing description', () => {
      const defaultSpacing = {
        bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: defaultSpacing,
          sectionSpacing: [
            { selector: 'section.cta', marginTop: 100, marginBottom: 0 },
          ],
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: defaultSpacing,
          sectionSpacing: [
            { selector: 'section.cta', marginTop: 50, marginBottom: 0 },
          ],
        }),
      ];

      const result = service.detectDifferences(captures);

      const ctaDiff = result.differences.find(
        (d) =>
          d.element === 'section.cta' &&
          d.description?.includes('margin-top')
      );
      expect(ctaDiff).toBeDefined();
      // 50/100 = 50%
      expect(ctaDiff?.description).toContain('50%');
    });
  });

  describe('全カテゴリ統合テスト', () => {
    it('should detect differences across all categories simultaneously', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          navType: 'horizontal-menu',
          hasHorizontalMenu: true,
          hasHamburgerMenu: false,
          semanticElements: [
            {
              selector: '.grid',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 4,
            },
            {
              selector: 'aside',
              tagName: 'aside',
              display: 'block',
              visibility: 'visible',
              opacity: 1,
            },
          ],
          extendedTypography: {
            headings: [
              { tag: 'h1', fontSize: 48 },
              { tag: 'h2', fontSize: 36 },
            ],
          },
          sectionSpacing: [
            { selector: 'section.hero', marginTop: 100, marginBottom: 80 },
          ],
          spacing: {
            bodyPadding: { top: 0, right: 40, bottom: 0, left: 40 },
          },
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          navType: 'hamburger-menu',
          hasHorizontalMenu: false,
          hasHamburgerMenu: true,
          semanticElements: [
            {
              selector: '.grid',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 1,
            },
            {
              selector: 'aside',
              tagName: 'aside',
              display: 'none',
              visibility: 'visible',
              opacity: 1,
            },
          ],
          extendedTypography: {
            headings: [
              { tag: 'h1', fontSize: 28 },
              { tag: 'h2', fontSize: 22 },
            ],
          },
          sectionSpacing: [
            { selector: 'section.hero', marginTop: 40, marginBottom: 30 },
          ],
          spacing: {
            bodyPadding: { top: 0, right: 16, bottom: 0, left: 16 },
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      // 全カテゴリに差異あり
      expect(result.summary.byCategory.navigation).toBeGreaterThan(0);
      expect(result.summary.byCategory.layout).toBeGreaterThan(0);
      expect(result.summary.byCategory.visibility).toBeGreaterThan(0);
      expect(result.summary.byCategory.typography).toBeGreaterThan(0);
      expect(result.summary.byCategory.spacing).toBeGreaterThan(0);
      expect(result.summary.navigationChange).toBe(true);
      expect(result.summary.significantLayoutChange).toBe(true);
    });

    it('should handle 3 viewports with Phase 2-4 features', () => {
      const captures = [
        createCaptureResult({
          name: 'desktop',
          width: 1920,
          semanticElements: [
            {
              selector: '.cards',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 4,
            },
          ],
          extendedTypography: {
            headings: [{ tag: 'h1', fontSize: 48 }],
          },
        }),
        createCaptureResult({
          name: 'tablet',
          width: 768,
          semanticElements: [
            {
              selector: '.cards',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 2,
            },
          ],
          extendedTypography: {
            headings: [{ tag: 'h1', fontSize: 36 }],
          },
        }),
        createCaptureResult({
          name: 'mobile',
          width: 375,
          semanticElements: [
            {
              selector: '.cards',
              tagName: 'div',
              display: 'grid',
              visibility: 'visible',
              opacity: 1,
              gridColumns: 1,
            },
          ],
          extendedTypography: {
            headings: [{ tag: 'h1', fontSize: 24 }],
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      // desktop→tabletとtablet→mobileの両方で差異検出
      expect(result.differences.length).toBeGreaterThan(0);
      expect(result.summary.totalDifferences).toBeGreaterThan(0);
    });
  });
});
