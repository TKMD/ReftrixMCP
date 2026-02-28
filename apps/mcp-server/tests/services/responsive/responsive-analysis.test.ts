// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Analysis Service Tests
 *
 * レスポンシブ解析サービスのユニットテスト
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
} from '../../../src/services/responsive/types';

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
