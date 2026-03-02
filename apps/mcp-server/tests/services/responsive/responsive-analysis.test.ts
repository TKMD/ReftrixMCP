// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Analysis Service Tests
 *
 * レスポンシブ解析サービスのユニットテスト
 * - DifferenceDetectorService: 差異検出ロジック
 * - ResponsiveAnalysisService: 統合オーケストレーション（Phase 1 screenshot_diffs設計検証）
 *
 * @module tests/services/responsive/responsive-analysis.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DifferenceDetectorService } from '../../../src/services/responsive/difference-detector.service';
import type {
  ViewportCaptureResult,
  ResponsiveDifference,
  ViewportLayoutInfo,
  NavigationInfo,
  ResponsiveAnalysisOptions,
} from '../../../src/services/responsive/types';

// logger モック（ResponsiveAnalysisService用、DifferenceDetectorServiceにも無害）
vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// ============================================================================
// Difference Detector Service Tests
// ============================================================================

describe('DifferenceDetectorService', () => {
  let service: DifferenceDetectorService;

  beforeEach(() => {
    service = new DifferenceDetectorService();
  });

  // ヘルパー関数：モックキャプチャ結果を生成
  function createMockCaptureResult(
    overrides: Partial<{
      name: string;
      width: number;
      height: number;
      navType: 'horizontal-menu' | 'hamburger-menu' | 'other';
      hasHamburgerMenu: boolean;
      hasHorizontalMenu: boolean;
      hasBottomNav: boolean;
      gridColumns: number;
      flexDirection: string;
      scrollHeight: number;
      typography: { h1FontSize: number; bodyFontSize: number; bodyLineHeight: number };
      spacing: {
        bodyPadding: { top: number; right: number; bottom: number; left: number };
        mainContainerPadding?: { top: number; right: number; bottom: number; left: number };
      };
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
      gridColumns = 3,
      flexDirection = 'row',
      scrollHeight = 2000,
      typography,
      spacing,
    } = overrides;

    const layoutInfo: ViewportLayoutInfo = {
      documentWidth: width,
      documentHeight: height * 2,
      viewportWidth: width,
      viewportHeight: height,
      scrollHeight,
      breakpoints: ['768px', '1024px'],
      gridColumns,
      flexDirection,
    };
    if (typography) {
      layoutInfo.typography = typography;
    }
    if (spacing) {
      layoutInfo.spacing = spacing;
    }

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

  describe('detectDifferences', () => {
    it('空のキャプチャ結果では差異なし', () => {
      const result = service.detectDifferences([]);
      expect(result.differences).toHaveLength(0);
      expect(result.breakpoints).toHaveLength(0);
    });

    it('単一ビューポートでは差異なし', () => {
      const captures = [createMockCaptureResult({ name: 'desktop' })];
      const result = service.detectDifferences(captures);
      expect(result.differences).toHaveLength(0);
    });

    it('ナビゲーションタイプの変化を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          navType: 'horizontal-menu',
          hasHorizontalMenu: true,
          hasHamburgerMenu: false,
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          navType: 'hamburger-menu',
          hasHorizontalMenu: false,
          hasHamburgerMenu: true,
        }),
      ];

      const result = service.detectDifferences(captures);

      // ナビゲーション変化を検出
      const navDiffs = result.differences.filter((d) => d.category === 'navigation');
      expect(navDiffs.length).toBeGreaterThan(0);

      // ナビゲーションタイプ変化の確認
      const typeDiff = navDiffs.find((d) => d.description?.includes('ナビゲーション'));
      expect(typeDiff).toBeDefined();
    });

    it('グリッドカラム数の変化を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          gridColumns: 4,
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          gridColumns: 1,
        }),
      ];

      const result = service.detectDifferences(captures);

      const layoutDiffs = result.differences.filter((d) => d.category === 'layout');
      const gridDiff = layoutDiffs.find((d) => d.description?.includes('グリッド'));
      expect(gridDiff).toBeDefined();
      expect(gridDiff?.description).toContain('4列');
      expect(gridDiff?.description).toContain('1列');
    });

    it('フレックス方向の変化を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          flexDirection: 'row',
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          flexDirection: 'column',
        }),
      ];

      const result = service.detectDifferences(captures);

      const layoutDiffs = result.differences.filter((d) => d.category === 'layout');
      const flexDiff = layoutDiffs.find((d) => d.description?.includes('フレックス'));
      expect(flexDiff).toBeDefined();
      expect(flexDiff?.description).toContain('横並び');
      expect(flexDiff?.description).toContain('縦並び');
    });

    it('スクロール高さの大きな変化を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          scrollHeight: 2000,
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          scrollHeight: 4000, // 200% (> 150%)
        }),
      ];

      const result = service.detectDifferences(captures);

      const layoutDiffs = result.differences.filter((d) => d.category === 'layout');
      const heightDiff = layoutDiffs.find((d) => d.description?.includes('ページ高さ'));
      expect(heightDiff).toBeDefined();
    });

    it('ハンバーガーメニューの可視性変化を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          hasHamburgerMenu: false,
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          hasHamburgerMenu: true,
        }),
      ];

      const result = service.detectDifferences(captures);

      const visibilityDiffs = result.differences.filter((d) => d.category === 'visibility');
      const hamburgerDiff = visibilityDiffs.find((d) => d.element === '.hamburger-menu');
      expect(hamburgerDiff).toBeDefined();
    });

    it('ボトムナビゲーションの出現を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          hasBottomNav: false,
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          hasBottomNav: true,
        }),
      ];

      const result = service.detectDifferences(captures);

      const navDiffs = result.differences.filter((d) => d.category === 'navigation');
      const bottomNavDiff = navDiffs.find((d) => d.element === '.bottom-nav');
      expect(bottomNavDiff).toBeDefined();
    });

    it('3ビューポート間の差異を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          gridColumns: 4,
          flexDirection: 'row',
        }),
        createMockCaptureResult({
          name: 'tablet',
          width: 768,
          gridColumns: 2,
          flexDirection: 'row',
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          gridColumns: 1,
          flexDirection: 'column',
        }),
      ];

      const result = service.detectDifferences(captures);

      // desktop → tablet と tablet → mobile の両方で差異が検出される
      expect(result.differences.length).toBeGreaterThan(0);
      expect(result.summary.totalDifferences).toBeGreaterThan(0);
    });

    it('ブレークポイントを収集', () => {
      const captures = [
        createMockCaptureResult({ name: 'desktop' }),
        createMockCaptureResult({ name: 'mobile' }),
      ];

      const result = service.detectDifferences(captures);

      expect(result.breakpoints).toContain('768px');
      expect(result.breakpoints).toContain('1024px');
    });

    it('サマリーを正しく生成', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          navType: 'horizontal-menu',
          gridColumns: 3,
        }),
        createMockCaptureResult({
          name: 'mobile',
          navType: 'hamburger-menu',
          gridColumns: 1,
        }),
      ];

      const result = service.detectDifferences(captures);

      expect(result.summary.totalDifferences).toBeGreaterThan(0);
      expect(result.summary.byCategory).toBeDefined();
      expect(typeof result.summary.navigationChange).toBe('boolean');
      expect(typeof result.summary.significantLayoutChange).toBe('boolean');
    });

    // ================================================================
    // Typography 差異検出テスト
    // ================================================================

    it('h1フォントサイズの20%以上の変化を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          typography: { h1FontSize: 48, bodyFontSize: 16, bodyLineHeight: 1.5 },
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          typography: { h1FontSize: 28, bodyFontSize: 16, bodyLineHeight: 1.5 },
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter((d) => d.category === 'typography');
      const h1Diff = typoDiffs.find((d) => d.element === 'h1');
      expect(h1Diff).toBeDefined();
      expect(h1Diff?.description).toContain('h1フォントサイズ');
      expect(h1Diff?.description).toContain('48px');
      expect(h1Diff?.description).toContain('28px');
    });

    it('h1フォントサイズの20%未満の変化は検出しない', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          typography: { h1FontSize: 48, bodyFontSize: 16, bodyLineHeight: 1.5 },
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          typography: { h1FontSize: 42, bodyFontSize: 16, bodyLineHeight: 1.5 },
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter((d) => d.category === 'typography');
      const h1Diff = typoDiffs.find((d) => d.element === 'h1');
      expect(h1Diff).toBeUndefined();
    });

    it('bodyフォントサイズの変化を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          typography: { h1FontSize: 48, bodyFontSize: 18, bodyLineHeight: 1.5 },
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          typography: { h1FontSize: 48, bodyFontSize: 14, bodyLineHeight: 1.4 },
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter((d) => d.category === 'typography');
      const bodyDiff = typoDiffs.find(
        (d) => d.element === 'body' && d.category === 'typography'
      );
      expect(bodyDiff).toBeDefined();
      expect(bodyDiff?.description).toContain('本文フォントサイズ');
      expect(bodyDiff?.description).toContain('18px');
      expect(bodyDiff?.description).toContain('14px');
      // モバイルで16px未満の場合、可読性警告
      expect(bodyDiff?.description).toContain('16px未満');
    });

    it('bodyフォントサイズが同じ場合は差異を検出しない', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          typography: { h1FontSize: 48, bodyFontSize: 16, bodyLineHeight: 1.5 },
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          typography: { h1FontSize: 48, bodyFontSize: 16, bodyLineHeight: 1.5 },
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter(
        (d) => d.category === 'typography' && d.element === 'body'
      );
      expect(typoDiffs).toHaveLength(0);
    });

    it('typography情報がない場合はスキップ', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          // typography なし
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          // typography なし
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter((d) => d.category === 'typography');
      expect(typoDiffs).toHaveLength(0);
    });

    it('片方だけtypography情報がある場合はスキップ', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          typography: { h1FontSize: 48, bodyFontSize: 16, bodyLineHeight: 1.5 },
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          // typography なし
        }),
      ];

      const result = service.detectDifferences(captures);

      const typoDiffs = result.differences.filter((d) => d.category === 'typography');
      expect(typoDiffs).toHaveLength(0);
    });

    // ================================================================
    // Spacing 差異検出テスト
    // ================================================================

    it('bodyPaddingの変化を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: {
            bodyPadding: { top: 0, right: 40, bottom: 0, left: 40 },
          },
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: {
            bodyPadding: { top: 0, right: 16, bottom: 0, left: 16 },
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      const spacingDiffs = result.differences.filter((d) => d.category === 'spacing');
      const bodyDiff = spacingDiffs.find((d) => d.element === 'body');
      expect(bodyDiff).toBeDefined();
      expect(bodyDiff?.description).toContain('body padding');
    });

    it('mainContainerPaddingの変化を検出', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: {
            bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
            mainContainerPadding: { top: 20, right: 60, bottom: 20, left: 60 },
          },
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: {
            bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
            mainContainerPadding: { top: 10, right: 16, bottom: 10, left: 16 },
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      const spacingDiffs = result.differences.filter((d) => d.category === 'spacing');
      const mainDiff = spacingDiffs.find((d) => d.element === 'main');
      expect(mainDiff).toBeDefined();
      expect(mainDiff?.description).toContain('メインコンテナ');
    });

    it('spacing情報がない場合はスキップ', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          // spacing なし
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          // spacing なし
        }),
      ];

      const result = service.detectDifferences(captures);

      const spacingDiffs = result.differences.filter((d) => d.category === 'spacing');
      expect(spacingDiffs).toHaveLength(0);
    });

    it('bodyPaddingが同じ場合は差異を検出しない', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: {
            bodyPadding: { top: 0, right: 20, bottom: 0, left: 20 },
          },
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: {
            bodyPadding: { top: 0, right: 20, bottom: 0, left: 20 },
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      const spacingDiffs = result.differences.filter(
        (d) => d.category === 'spacing' && d.element === 'body'
      );
      expect(spacingDiffs).toHaveLength(0);
    });

    it('mainContainerPaddingが片方のみの場合は検出しない', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          spacing: {
            bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
            mainContainerPadding: { top: 20, right: 60, bottom: 20, left: 60 },
          },
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          spacing: {
            bodyPadding: { top: 0, right: 0, bottom: 0, left: 0 },
            // mainContainerPadding なし
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      const mainDiffs = result.differences.filter(
        (d) => d.category === 'spacing' && d.element === 'main'
      );
      expect(mainDiffs).toHaveLength(0);
    });

    it('サマリーにtypographyとspacingカウントが含まれる', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          typography: { h1FontSize: 48, bodyFontSize: 18, bodyLineHeight: 1.5 },
          spacing: {
            bodyPadding: { top: 0, right: 40, bottom: 0, left: 40 },
          },
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          typography: { h1FontSize: 28, bodyFontSize: 14, bodyLineHeight: 1.4 },
          spacing: {
            bodyPadding: { top: 0, right: 16, bottom: 0, left: 16 },
          },
        }),
      ];

      const result = service.detectDifferences(captures);

      expect(result.summary.byCategory.typography).toBeGreaterThan(0);
      expect(result.summary.byCategory.spacing).toBeGreaterThan(0);
    });

    it('重複する差異を除去', () => {
      const captures = [
        createMockCaptureResult({
          name: 'desktop',
          width: 1920,
          navType: 'horizontal-menu',
        }),
        createMockCaptureResult({
          name: 'tablet',
          width: 768,
          navType: 'horizontal-menu',
        }),
        createMockCaptureResult({
          name: 'mobile',
          width: 375,
          navType: 'hamburger-menu',
        }),
      ];

      const result = service.detectDifferences(captures);

      // 同じ要素・カテゴリの差異は1つにマージされる
      const navDiffs = result.differences.filter(
        (d) => d.category === 'navigation' && d.element === 'nav'
      );
      expect(navDiffs.length).toBeLessThanOrEqual(2);
    });
  });
});

// ============================================================================
// Type Definitions Tests
// ============================================================================

describe('レスポンシブ型定義', () => {
  it('ResponsiveDifference 型が正しい構造を持つ', () => {
    const difference: ResponsiveDifference = {
      element: 'nav',
      description: 'ナビゲーション変化',
      category: 'navigation',
      desktop: { type: 'horizontal-menu' },
      mobile: { type: 'hamburger-menu' },
    };

    expect(difference.element).toBe('nav');
    expect(difference.category).toBe('navigation');
    expect(difference.desktop).toBeDefined();
    expect(difference.mobile).toBeDefined();
  });

  it('ViewportLayoutInfo 型が正しい構造を持つ', () => {
    const layoutInfo: ViewportLayoutInfo = {
      documentWidth: 1920,
      documentHeight: 3000,
      viewportWidth: 1920,
      viewportHeight: 1080,
      scrollHeight: 3000,
      breakpoints: ['768px', '1024px'],
      gridColumns: 3,
      flexDirection: 'row',
    };

    expect(layoutInfo.breakpoints).toContain('768px');
    expect(layoutInfo.gridColumns).toBe(3);
    expect(layoutInfo.flexDirection).toBe('row');
  });

  it('NavigationInfo 型が正しい構造を持つ', () => {
    const navInfo: NavigationInfo = {
      type: 'hamburger-menu',
      hasHamburgerMenu: true,
      hasHorizontalMenu: false,
      hasBottomNav: false,
      selector: 'nav.main',
    };

    expect(navInfo.type).toBe('hamburger-menu');
    expect(navInfo.hasHamburgerMenu).toBe(true);
    expect(navInfo.selector).toBe('nav.main');
  });
});

// ============================================================================
// ResponsiveAnalysisService Tests — Phase 1 screenshot_diffs 設計検証
// ============================================================================

describe('ResponsiveAnalysisService', () => {
  // vi.spyOn でシングルトンの依存サービスをモック
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.spyOn用に動的インポートが必要
  let multiViewportCaptureService: typeof import('../../../src/services/responsive/multi-viewport-capture.service').multiViewportCaptureService;
  let viewportDiffService: typeof import('../../../src/services/responsive/viewport-diff.service').viewportDiffService;
  let ResponsiveAnalysisService: typeof import('../../../src/services/responsive/responsive-analysis.service').ResponsiveAnalysisService;

  beforeEach(async () => {
    vi.clearAllMocks();

    const captureModule = await import(
      '../../../src/services/responsive/multi-viewport-capture.service'
    );
    multiViewportCaptureService = captureModule.multiViewportCaptureService;

    const diffModule = await import(
      '../../../src/services/responsive/viewport-diff.service'
    );
    viewportDiffService = diffModule.viewportDiffService;

    const serviceModule = await import(
      '../../../src/services/responsive/responsive-analysis.service'
    );
    ResponsiveAnalysisService = serviceModule.ResponsiveAnalysisService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * スクリーンショット付きのモックキャプチャ結果を生成
   */
  function createMockCaptureWithScreenshot(
    name: string,
    width: number,
    height: number
  ): ViewportCaptureResult {
    // 1x1 PNG（最小有効PNG）
    const minimalPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    return {
      viewport: { name, width, height },
      html: `<html><body>${name}</body></html>`,
      layoutInfo: {
        documentWidth: width,
        documentHeight: height * 3,
        viewportWidth: width,
        viewportHeight: height,
        scrollHeight: height * 3,
        breakpoints: ['768px'],
      },
      navigationInfo: {
        type: 'horizontal-menu',
        hasHamburgerMenu: false,
        hasHorizontalMenu: true,
        hasBottomNav: false,
      },
      screenshot: {
        name,
        width,
        height,
        screenshot: {
          base64: minimalPng.toString('base64'),
          format: 'png',
          width,
          height,
        },
      },
    };
  }

  it('enabled: false の場合、空の結果を即座に返す', async () => {
    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = { enabled: false };

    const result = await service.analyze('https://example.com', options);

    expect(result.viewportsAnalyzed).toHaveLength(0);
    expect(result.differences).toHaveLength(0);
    expect(result.breakpoints).toHaveLength(0);
    expect(result.analysisTimeMs).toBe(0);
    expect(result.screenshots).toBeUndefined();
    expect(result.viewportDiffs).toBeUndefined();
  });

  it('include_screenshots: false でも viewportDiffs が返却される', async () => {
    const mockCaptures = [
      createMockCaptureWithScreenshot('desktop', 1920, 1080),
      createMockCaptureWithScreenshot('mobile', 375, 667),
    ];

    const mockDiffResults = [
      {
        viewport1: 'desktop',
        viewport2: 'mobile',
        diffPercentage: 45.2,
        diffPixelCount: 50000,
        totalPixels: 110592,
        comparedWidth: 375,
        comparedHeight: 667,
      },
    ];

    vi.spyOn(multiViewportCaptureService, 'captureAllViewports').mockResolvedValue(mockCaptures);
    vi.spyOn(multiViewportCaptureService, 'extractBreakpointsFromExternalCss').mockResolvedValue([]);
    vi.spyOn(viewportDiffService, 'compareAll').mockResolvedValue(mockDiffResults);

    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = {
      enabled: true,
      include_screenshots: false,
    };

    const result = await service.analyze('https://example.com', options);

    // viewportDiffs は含まれる（差分率はDB保存用）
    expect(result.viewportDiffs).toBeDefined();
    expect(result.viewportDiffs).toHaveLength(1);
    expect(result.viewportDiffs![0]!.diffPercentage).toBe(45.2);

    // screenshots は含まれない（include_screenshots: false）
    expect(result.screenshots).toBeUndefined();
  });

  it('include_screenshots: true で screenshots と viewportDiffs の両方が返却される', async () => {
    const mockCaptures = [
      createMockCaptureWithScreenshot('desktop', 1920, 1080),
      createMockCaptureWithScreenshot('mobile', 375, 667),
    ];

    const mockDiffResults = [
      {
        viewport1: 'desktop',
        viewport2: 'mobile',
        diffPercentage: 30.0,
        diffPixelCount: 33000,
        totalPixels: 110592,
        comparedWidth: 375,
        comparedHeight: 667,
      },
    ];

    vi.spyOn(multiViewportCaptureService, 'captureAllViewports').mockResolvedValue(mockCaptures);
    vi.spyOn(multiViewportCaptureService, 'extractBreakpointsFromExternalCss').mockResolvedValue([]);
    vi.spyOn(viewportDiffService, 'compareAll').mockResolvedValue(mockDiffResults);

    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = {
      enabled: true,
      include_screenshots: true,
    };

    const result = await service.analyze('https://example.com', options);

    // screenshots が含まれる
    expect(result.screenshots).toBeDefined();
    expect(result.screenshots).toHaveLength(2);
    expect(result.screenshots![0]!.name).toBe('desktop');
    expect(result.screenshots![1]!.name).toBe('mobile');

    // viewportDiffs も含まれる
    expect(result.viewportDiffs).toBeDefined();
    expect(result.viewportDiffs).toHaveLength(1);
  });

  it('成功キャプチャが2件未満の場合、差異なしで早期リターン', async () => {
    const mockCaptures = [
      createMockCaptureWithScreenshot('desktop', 1920, 1080),
    ];

    vi.spyOn(multiViewportCaptureService, 'captureAllViewports').mockResolvedValue(mockCaptures);

    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = { enabled: true };

    const result = await service.analyze('https://example.com', options);

    expect(result.differences).toHaveLength(0);
    expect(result.breakpoints).toHaveLength(0);
    expect(result.viewportsAnalyzed).toHaveLength(1);
  });

  it('エラーのあるキャプチャは除外される', async () => {
    const successCapture = createMockCaptureWithScreenshot('desktop', 1920, 1080);
    const errorCapture: ViewportCaptureResult = {
      viewport: { name: 'mobile', width: 375, height: 667 },
      html: '',
      layoutInfo: {
        documentWidth: 375,
        documentHeight: 667,
        viewportWidth: 375,
        viewportHeight: 667,
        scrollHeight: 667,
        breakpoints: [],
      },
      navigationInfo: {
        type: 'other',
        hasHamburgerMenu: false,
        hasHorizontalMenu: false,
        hasBottomNav: false,
      },
      error: 'Navigation failed',
    };

    vi.spyOn(multiViewportCaptureService, 'captureAllViewports').mockResolvedValue([
      successCapture,
      errorCapture,
    ]);

    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = { enabled: true };

    const result = await service.analyze('https://example.com', options);

    // エラーキャプチャは除外され、成功キャプチャのみ（1件→差異なし）
    expect(result.viewportsAnalyzed).toHaveLength(1);
    expect(result.viewportsAnalyzed[0]!.name).toBe('desktop');
  });

  it('detect_navigation: false でナビゲーション差異がフィルタリングされる', async () => {
    const mockCaptures = [
      createMockCaptureWithScreenshot('desktop', 1920, 1080),
      createMockCaptureWithScreenshot('mobile', 375, 667),
    ];
    // ナビゲーションを変化させる
    mockCaptures[0]!.navigationInfo = {
      type: 'horizontal-menu',
      hasHamburgerMenu: false,
      hasHorizontalMenu: true,
      hasBottomNav: false,
    };
    mockCaptures[1]!.navigationInfo = {
      type: 'hamburger-menu',
      hasHamburgerMenu: true,
      hasHorizontalMenu: false,
      hasBottomNav: false,
    };

    vi.spyOn(multiViewportCaptureService, 'captureAllViewports').mockResolvedValue(mockCaptures);
    vi.spyOn(multiViewportCaptureService, 'extractBreakpointsFromExternalCss').mockResolvedValue([]);
    vi.spyOn(viewportDiffService, 'compareAll').mockResolvedValue([]);

    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = {
      enabled: true,
      detect_navigation: false,
    };

    const result = await service.analyze('https://example.com', options);

    const navDiffs = result.differences.filter((d) => d.category === 'navigation');
    expect(navDiffs).toHaveLength(0);
  });

  it('detect_visibility: false で可視性差異がフィルタリングされる', async () => {
    const mockCaptures = [
      createMockCaptureWithScreenshot('desktop', 1920, 1080),
      createMockCaptureWithScreenshot('mobile', 375, 667),
    ];
    mockCaptures[0]!.navigationInfo.hasHamburgerMenu = false;
    mockCaptures[1]!.navigationInfo.hasHamburgerMenu = true;

    vi.spyOn(multiViewportCaptureService, 'captureAllViewports').mockResolvedValue(mockCaptures);
    vi.spyOn(multiViewportCaptureService, 'extractBreakpointsFromExternalCss').mockResolvedValue([]);
    vi.spyOn(viewportDiffService, 'compareAll').mockResolvedValue([]);

    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = {
      enabled: true,
      detect_visibility: false,
    };

    const result = await service.analyze('https://example.com', options);

    const visDiffs = result.differences.filter((d) => d.category === 'visibility');
    expect(visDiffs).toHaveLength(0);
  });

  it('detect_layout: false でレイアウト差異がフィルタリングされる', async () => {
    const mockCaptures = [
      createMockCaptureWithScreenshot('desktop', 1920, 1080),
      createMockCaptureWithScreenshot('mobile', 375, 667),
    ];
    mockCaptures[0]!.layoutInfo.gridColumns = 4;
    mockCaptures[1]!.layoutInfo.gridColumns = 1;

    vi.spyOn(multiViewportCaptureService, 'captureAllViewports').mockResolvedValue(mockCaptures);
    vi.spyOn(multiViewportCaptureService, 'extractBreakpointsFromExternalCss').mockResolvedValue([]);
    vi.spyOn(viewportDiffService, 'compareAll').mockResolvedValue([]);

    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = {
      enabled: true,
      detect_layout: false,
    };

    const result = await service.analyze('https://example.com', options);

    const layoutDiffs = result.differences.filter((d) => d.category === 'layout');
    expect(layoutDiffs).toHaveLength(0);
  });

  it('viewportsAnalyzed に width と height が含まれる', async () => {
    const mockCaptures = [
      createMockCaptureWithScreenshot('desktop', 1920, 1080),
      createMockCaptureWithScreenshot('mobile', 375, 667),
    ];

    vi.spyOn(multiViewportCaptureService, 'captureAllViewports').mockResolvedValue(mockCaptures);
    vi.spyOn(multiViewportCaptureService, 'extractBreakpointsFromExternalCss').mockResolvedValue([]);
    vi.spyOn(viewportDiffService, 'compareAll').mockResolvedValue([]);

    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = { enabled: true };

    const result = await service.analyze('https://example.com', options);

    expect(result.viewportsAnalyzed).toHaveLength(2);
    expect(result.viewportsAnalyzed[0]).toEqual({ name: 'desktop', width: 1920, height: 1080 });
    expect(result.viewportsAnalyzed[1]).toEqual({ name: 'mobile', width: 375, height: 667 });
  });

  it('外部CSSブレークポイントが各キャプチャのlayoutInfoにマージされる', async () => {
    const mockCaptures = [
      createMockCaptureWithScreenshot('desktop', 1920, 1080),
      createMockCaptureWithScreenshot('mobile', 375, 667),
    ];

    vi.spyOn(multiViewportCaptureService, 'captureAllViewports').mockResolvedValue(mockCaptures);
    vi.spyOn(multiViewportCaptureService, 'extractBreakpointsFromExternalCss').mockResolvedValue([
      '480px',
      '1200px',
    ]);
    vi.spyOn(viewportDiffService, 'compareAll').mockResolvedValue([]);

    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = {
      enabled: true,
      breakpoint_resolution: 'range',
    };

    const result = await service.analyze('https://example.com', options);

    // ブレークポイントに外部CSSのものが含まれる
    expect(result.breakpoints).toContain('480px');
    expect(result.breakpoints).toContain('768px');
    expect(result.breakpoints).toContain('1200px');
  });

  it('captureAllViewports に常に includeScreenshots: true が渡される', async () => {
    const spy = vi.spyOn(multiViewportCaptureService, 'captureAllViewports').mockResolvedValue([
      createMockCaptureWithScreenshot('desktop', 1920, 1080),
      createMockCaptureWithScreenshot('mobile', 375, 667),
    ]);
    vi.spyOn(multiViewportCaptureService, 'extractBreakpointsFromExternalCss').mockResolvedValue([]);
    vi.spyOn(viewportDiffService, 'compareAll').mockResolvedValue([]);

    const service = new ResponsiveAnalysisService();
    const options: ResponsiveAnalysisOptions = {
      enabled: true,
      include_screenshots: false, // レスポンスには含めない
    };

    await service.analyze('https://example.com', options);

    // 内部では常にスクリーンショットをキャプチャ（差分計算用）
    expect(spy).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ includeScreenshots: true }),
      undefined
    );
  });
});
