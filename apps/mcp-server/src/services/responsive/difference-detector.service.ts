// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Difference Detector Service
 * ビューポート間のレイアウト差異を検出するサービス
 *
 * @module services/responsive/difference-detector.service
 */

import { logger, isDevelopment } from '../../utils/logger';
import type {
  ViewportCaptureResult,
  ResponsiveDifference,
  DifferenceCategory,
  NavigationType,
} from './types';

/**
 * 差異検出結果
 */
export interface DifferenceDetectionResult {
  differences: ResponsiveDifference[];
  breakpoints: string[];
  summary: DifferenceSummary;
}

/**
 * 差異サマリー
 */
export interface DifferenceSummary {
  totalDifferences: number;
  byCategory: Record<DifferenceCategory, number>;
  navigationChange: boolean;
  significantLayoutChange: boolean;
}

/**
 * Responsive Difference Detector Service
 */
export class DifferenceDetectorService {
  /**
   * 複数ビューポートのキャプチャ結果から差異を検出
   *
   * @param captureResults - ビューポートごとのキャプチャ結果
   * @returns 差異検出結果
   */
  detectDifferences(captureResults: ViewportCaptureResult[]): DifferenceDetectionResult {
    const differences: ResponsiveDifference[] = [];
    const allBreakpoints = new Set<string>();

    if (isDevelopment()) {
      logger.debug('[DifferenceDetector] Starting difference detection', {
        viewports: captureResults.map((r) => r.viewport.name),
      });
    }

    // 各ビューポートからブレークポイントを収集
    for (const result of captureResults) {
      result.layoutInfo.breakpoints.forEach((bp) => allBreakpoints.add(bp));
    }

    // ビューポートをサイズでソート（大きい順: desktop -> tablet -> mobile）
    const sortedResults = [...captureResults].sort(
      (a, b) => b.viewport.width - a.viewport.width
    );

    // 隣接ビューポート間の差異を検出
    for (let i = 0; i < sortedResults.length - 1; i++) {
      const larger = sortedResults[i];
      const smaller = sortedResults[i + 1];

      // 配列境界チェック（TypeScript strict mode対応）
      if (!larger || !smaller) {
        continue;
      }

      // ナビゲーション差異
      const navDiffs = this.detectNavigationDifferences(larger, smaller);
      differences.push(...navDiffs);

      // レイアウト差異
      const layoutDiffs = this.detectLayoutDifferences(larger, smaller);
      differences.push(...layoutDiffs);

      // タイポグラフィ差異
      const typographyDiffs = this.detectTypographyDifferences(larger, smaller);
      differences.push(...typographyDiffs);

      // スペーシング差異
      const spacingDiffs = this.detectSpacingDifferences(larger, smaller);
      differences.push(...spacingDiffs);
    }

    // 全ビューポートを通した差異検出（最大 vs 最小）
    if (sortedResults.length >= 2) {
      const largest = sortedResults[0];
      const smallest = sortedResults[sortedResults.length - 1];

      // 配列境界チェック（TypeScript strict mode対応）
      if (largest && smallest) {
        // 全体的な可視性差異
        const visibilityDiffs = this.detectVisibilityDifferences(largest, smallest);
        differences.push(...visibilityDiffs);
      }
    }

    // 重複を除去
    const uniqueDifferences = this.deduplicateDifferences(differences);

    // サマリー作成
    const summary = this.createSummary(uniqueDifferences);

    if (isDevelopment()) {
      logger.info('[DifferenceDetector] Difference detection completed', {
        totalDifferences: uniqueDifferences.length,
        byCategory: summary.byCategory,
        navigationChange: summary.navigationChange,
      });
    }

    return {
      differences: uniqueDifferences,
      breakpoints: Array.from(allBreakpoints).sort((a, b) => {
        const numA = parseInt(a.replace('px', ''), 10);
        const numB = parseInt(b.replace('px', ''), 10);
        return numA - numB;
      }),
      summary,
    };
  }

  /**
   * ナビゲーション差異を検出
   */
  private detectNavigationDifferences(
    larger: ViewportCaptureResult,
    smaller: ViewportCaptureResult
  ): ResponsiveDifference[] {
    const differences: ResponsiveDifference[] = [];
    const largerNav = larger.navigationInfo;
    const smallerNav = smaller.navigationInfo;

    // ナビゲーションタイプの変化
    if (largerNav.type !== smallerNav.type) {
      differences.push({
        element: smallerNav.selector ?? 'nav',
        description: this.getNavigationChangeDescription(largerNav.type, smallerNav.type),
        category: 'navigation',
        [larger.viewport.name]: { type: largerNav.type },
        [smaller.viewport.name]: { type: smallerNav.type },
      });
    }

    // 水平メニュー → ハンバーガーメニュー変化
    if (largerNav.hasHorizontalMenu && !smallerNav.hasHorizontalMenu && smallerNav.hasHamburgerMenu) {
      differences.push({
        element: smallerNav.selector ?? 'nav',
        description: `${larger.viewport.name}では水平メニュー、${smaller.viewport.name}ではハンバーガーメニューに変化`,
        category: 'navigation',
        [larger.viewport.name]: {
          hasHorizontalMenu: true,
          hasHamburgerMenu: false,
        },
        [smaller.viewport.name]: {
          hasHorizontalMenu: false,
          hasHamburgerMenu: true,
        },
      });
    }

    // ボトムナビゲーションの出現
    if (!largerNav.hasBottomNav && smallerNav.hasBottomNav) {
      differences.push({
        element: '.bottom-nav',
        description: `${smaller.viewport.name}でボトムナビゲーションが出現`,
        category: 'navigation',
        [larger.viewport.name]: { hasBottomNav: false },
        [smaller.viewport.name]: { hasBottomNav: true },
      });
    }

    return differences;
  }

  /**
   * レイアウト差異を検出
   * Phase 2: computedStyleベースのgrid/flex情報を使用、既存はフォールバック
   */
  private detectLayoutDifferences(
    larger: ViewportCaptureResult,
    smaller: ViewportCaptureResult
  ): ResponsiveDifference[] {
    const differences: ResponsiveDifference[] = [];
    const largerLayout = larger.layoutInfo;
    const smallerLayout = smaller.layoutInfo;

    // Phase 2: セマンティック要素ベースのgrid/flex差異検出
    const largerElements = largerLayout.semanticElements ?? [];
    const smallerElements = smallerLayout.semanticElements ?? [];
    let foundGridDiff = false;
    let foundFlexDiff = false;

    if (largerElements.length > 0 && smallerElements.length > 0) {
      const smallerBySelector = new Map(
        smallerElements.map((e) => [e.selector, e])
      );

      for (const largeEl of largerElements) {
        const smallEl = smallerBySelector.get(largeEl.selector);
        if (!smallEl) continue;

        // grid差異
        if (
          largeEl.gridColumns !== undefined &&
          smallEl.gridColumns !== undefined &&
          largeEl.gridColumns !== smallEl.gridColumns
        ) {
          differences.push({
            element: largeEl.selector,
            description: `${largeEl.selector}のグリッドカラム数が${largeEl.gridColumns}列から${smallEl.gridColumns}列に変化`,
            category: 'layout',
            [larger.viewport.name]: { gridColumns: largeEl.gridColumns },
            [smaller.viewport.name]: { gridColumns: smallEl.gridColumns },
          });
          foundGridDiff = true;
        }

        // flex差異
        if (
          largeEl.flexDirection &&
          smallEl.flexDirection &&
          largeEl.flexDirection !== smallEl.flexDirection
        ) {
          differences.push({
            element: largeEl.selector,
            description: `${largeEl.selector}のフレックス方向が${this.translateFlexDirection(largeEl.flexDirection)}から${this.translateFlexDirection(smallEl.flexDirection)}に変化`,
            category: 'layout',
            [larger.viewport.name]: { flexDirection: largeEl.flexDirection },
            [smaller.viewport.name]: { flexDirection: smallEl.flexDirection },
          });
          foundFlexDiff = true;
        }
      }
    }

    // フォールバック: 既存セレクタベースのgrid/flex検出（セマンティック要素で未検出の場合）
    if (
      !foundGridDiff &&
      largerLayout.gridColumns !== undefined &&
      smallerLayout.gridColumns !== undefined &&
      largerLayout.gridColumns !== smallerLayout.gridColumns
    ) {
      differences.push({
        element: '.grid',
        description: `グリッドカラム数が${largerLayout.gridColumns}列から${smallerLayout.gridColumns}列に変化`,
        category: 'layout',
        [larger.viewport.name]: { gridColumns: largerLayout.gridColumns },
        [smaller.viewport.name]: { gridColumns: smallerLayout.gridColumns },
      });
    }

    if (
      !foundFlexDiff &&
      largerLayout.flexDirection &&
      smallerLayout.flexDirection &&
      largerLayout.flexDirection !== smallerLayout.flexDirection
    ) {
      differences.push({
        element: '.flex',
        description: `フレックス方向が${this.translateFlexDirection(largerLayout.flexDirection)}から${this.translateFlexDirection(smallerLayout.flexDirection)}に変化`,
        category: 'layout',
        [larger.viewport.name]: { flexDirection: largerLayout.flexDirection },
        [smaller.viewport.name]: { flexDirection: smallerLayout.flexDirection },
      });
    }

    // スクロール高さの大きな変化（50%以上）
    const scrollHeightRatio = smallerLayout.scrollHeight / largerLayout.scrollHeight;
    if (scrollHeightRatio > 1.5 || scrollHeightRatio < 0.67) {
      differences.push({
        element: 'body',
        description: `ページ高さが${Math.round(scrollHeightRatio * 100)}%に変化（${larger.viewport.name}: ${largerLayout.scrollHeight}px → ${smaller.viewport.name}: ${smallerLayout.scrollHeight}px）`,
        category: 'layout',
        [larger.viewport.name]: { scrollHeight: largerLayout.scrollHeight },
        [smaller.viewport.name]: { scrollHeight: smallerLayout.scrollHeight },
      });
    }

    return differences;
  }

  /**
   * 可視性差異を検出
   * Phase 2: セマンティック要素（aside, table, figure, section > div等）の
   * display/visibility/opacityをビューポート間で比較
   */
  private detectVisibilityDifferences(
    largest: ViewportCaptureResult,
    smallest: ViewportCaptureResult
  ): ResponsiveDifference[] {
    const differences: ResponsiveDifference[] = [];

    // ハンバーガーメニューの可視性変化（既存）
    if (largest.navigationInfo.hasHamburgerMenu !== smallest.navigationInfo.hasHamburgerMenu) {
      const desktopVisible = largest.navigationInfo.hasHamburgerMenu;
      differences.push({
        element: '.hamburger-menu',
        description: desktopVisible
          ? 'ハンバーガーメニューが全ビューポートで表示'
          : `ハンバーガーメニューが${smallest.viewport.name}でのみ表示`,
        category: 'visibility',
        [largest.viewport.name]: { visible: desktopVisible },
        [smallest.viewport.name]: { visible: smallest.navigationInfo.hasHamburgerMenu },
      });
    }

    // Phase 2: セマンティック要素のcomputedStyleベース可視性比較
    const largestElements = largest.layoutInfo.semanticElements ?? [];
    const smallestElements = smallest.layoutInfo.semanticElements ?? [];

    if (largestElements.length === 0 || smallestElements.length === 0) {
      return differences;
    }

    // セレクタベースでマッチング
    const smallestBySelector = new Map(
      smallestElements.map((e) => [e.selector, e])
    );

    for (const largeEl of largestElements) {
      const smallEl = smallestBySelector.get(largeEl.selector);
      if (!smallEl) continue;

      const largeVisible = this.isElementVisible(largeEl);
      const smallVisible = this.isElementVisible(smallEl);

      if (largeVisible !== smallVisible) {
        const description = largeVisible
          ? `${largeEl.selector}が${largest.viewport.name}では表示、${smallest.viewport.name}では非表示`
          : `${largeEl.selector}が${smallest.viewport.name}でのみ表示`;
        differences.push({
          element: largeEl.selector,
          description,
          category: 'visibility',
          [largest.viewport.name]: {
            visible: largeVisible,
            display: largeEl.display,
            visibility: largeEl.visibility,
            opacity: largeEl.opacity,
          },
          [smallest.viewport.name]: {
            visible: smallVisible,
            display: smallEl.display,
            visibility: smallEl.visibility,
            opacity: smallEl.opacity,
          },
        });
      }
    }

    return differences;
  }

  /**
   * セマンティック要素が可視かどうか判定
   */
  private isElementVisible(el: { display: string; visibility: string; opacity: number }): boolean {
    return el.display !== 'none' && el.visibility !== 'hidden' && el.opacity > 0;
  }

  /**
   * タイポグラフィ差異を検出
   * Phase 4: h1-h6全てのfontSize検出（15%以上の変化）、p:first-of-type対応
   */
  private detectTypographyDifferences(
    larger: ViewportCaptureResult,
    smaller: ViewportCaptureResult
  ): ResponsiveDifference[] {
    const differences: ResponsiveDifference[] = [];

    // Phase 4: 拡張タイポグラフィ（h1-h6 + p:first-of-type）
    const largerExt = larger.layoutInfo.extendedTypography;
    const smallerExt = smaller.layoutInfo.extendedTypography;

    if (largerExt && smallerExt) {
      // h1-h6フォントサイズ比較（15%以上の変化で報告）
      const smallerHeadingMap = new Map(
        smallerExt.headings.map((h) => [h.tag, h.fontSize])
      );

      for (const largeH of largerExt.headings) {
        const smallFS = smallerHeadingMap.get(largeH.tag);
        if (smallFS !== undefined && largeH.fontSize > 0 && smallFS > 0) {
          const ratio = smallFS / largeH.fontSize;
          if (ratio < 0.85 || ratio > 1.15) {
            differences.push({
              element: largeH.tag,
              description: `${largeH.tag}フォントサイズが${largeH.fontSize}pxから${smallFS}pxに変化（${Math.round(ratio * 100)}%）`,
              category: 'typography',
              [larger.viewport.name]: { fontSize: largeH.fontSize },
              [smaller.viewport.name]: { fontSize: smallFS },
            });
          }
        }
      }

      // p:first-of-typeフォントサイズ比較（15%以上の変化）
      if (
        largerExt.pFirstOfType !== undefined &&
        smallerExt.pFirstOfType !== undefined &&
        largerExt.pFirstOfType > 0 &&
        smallerExt.pFirstOfType > 0
      ) {
        const pRatio = smallerExt.pFirstOfType / largerExt.pFirstOfType;
        if (pRatio < 0.85 || pRatio > 1.15) {
          differences.push({
            element: 'p:first-of-type',
            description: `本文（p:first-of-type）フォントサイズが${largerExt.pFirstOfType}pxから${smallerExt.pFirstOfType}pxに変化（${Math.round(pRatio * 100)}%）`,
            category: 'typography',
            [larger.viewport.name]: { fontSize: largerExt.pFirstOfType },
            [smaller.viewport.name]: { fontSize: smallerExt.pFirstOfType },
          });
        }
      }
    }

    // 既存: h1FontSize（フォールバック、拡張タイポグラフィが無い場合）
    const largerTypo = larger.layoutInfo.typography;
    const smallerTypo = smaller.layoutInfo.typography;

    if (largerTypo && smallerTypo) {
      // 拡張タイポグラフィでh1を検出済みかチェック
      const h1AlreadyDetected = differences.some((d) => d.element === 'h1');

      if (!h1AlreadyDetected && largerTypo.h1FontSize > 0 && smallerTypo.h1FontSize > 0) {
        const h1Ratio = smallerTypo.h1FontSize / largerTypo.h1FontSize;
        if (h1Ratio < 0.85 || h1Ratio > 1.15) {
          differences.push({
            element: 'h1',
            description: `h1フォントサイズが${largerTypo.h1FontSize}pxから${smallerTypo.h1FontSize}pxに変化（${Math.round(h1Ratio * 100)}%）`,
            category: 'typography',
            [larger.viewport.name]: { h1FontSize: largerTypo.h1FontSize },
            [smaller.viewport.name]: { h1FontSize: smallerTypo.h1FontSize },
          });
        }
      }

      // bodyFontSize が変化した場合（モバイルで16px未満を警告）
      if (largerTypo.bodyFontSize !== smallerTypo.bodyFontSize) {
        const warning = smallerTypo.bodyFontSize < 16
          ? `（${smaller.viewport.name}で16px未満: 可読性に注意）`
          : '';
        differences.push({
          element: 'body',
          description: `本文フォントサイズが${largerTypo.bodyFontSize}pxから${smallerTypo.bodyFontSize}pxに変化${warning}`,
          category: 'typography',
          [larger.viewport.name]: { bodyFontSize: largerTypo.bodyFontSize },
          [smaller.viewport.name]: { bodyFontSize: smallerTypo.bodyFontSize },
        });
      }
    }

    return differences;
  }

  /**
   * スペーシング差異を検出
   * Phase 4: セクション間gap/margin検出（20%以上の変化のみ報告）
   */
  private detectSpacingDifferences(
    larger: ViewportCaptureResult,
    smaller: ViewportCaptureResult
  ): ResponsiveDifference[] {
    const differences: ResponsiveDifference[] = [];
    const largerSpacing = larger.layoutInfo.spacing;
    const smallerSpacing = smaller.layoutInfo.spacing;

    if (!largerSpacing || !smallerSpacing) {
      return differences;
    }

    // bodyPadding の変化
    const lBody = largerSpacing.bodyPadding;
    const sBody = smallerSpacing.bodyPadding;
    if (
      lBody.top !== sBody.top ||
      lBody.right !== sBody.right ||
      lBody.bottom !== sBody.bottom ||
      lBody.left !== sBody.left
    ) {
      differences.push({
        element: 'body',
        description: `body paddingが変化（${larger.viewport.name}: ${lBody.top}/${lBody.right}/${lBody.bottom}/${lBody.left}px → ${smaller.viewport.name}: ${sBody.top}/${sBody.right}/${sBody.bottom}/${sBody.left}px）`,
        category: 'spacing',
        [larger.viewport.name]: { bodyPadding: lBody },
        [smaller.viewport.name]: { bodyPadding: sBody },
      });
    }

    // mainContainerPadding の変化
    const lContainer = largerSpacing.mainContainerPadding;
    const sContainer = smallerSpacing.mainContainerPadding;
    if (lContainer && sContainer) {
      if (
        lContainer.top !== sContainer.top ||
        lContainer.right !== sContainer.right ||
        lContainer.bottom !== sContainer.bottom ||
        lContainer.left !== sContainer.left
      ) {
        differences.push({
          element: 'main',
          description: `メインコンテナのpaddingが変化（${larger.viewport.name}: ${lContainer.top}/${lContainer.right}/${lContainer.bottom}/${lContainer.left}px → ${smaller.viewport.name}: ${sContainer.top}/${sContainer.right}/${sContainer.bottom}/${sContainer.left}px）`,
          category: 'spacing',
          [larger.viewport.name]: { mainContainerPadding: lContainer },
          [smaller.viewport.name]: { mainContainerPadding: sContainer },
        });
      }
    }

    // Phase 4: セクション間margin変化（section, main > * の margin-top/bottom）
    const largerSectionSpacing = larger.layoutInfo.sectionSpacing ?? [];
    const smallerSectionSpacing = smaller.layoutInfo.sectionSpacing ?? [];

    if (largerSectionSpacing.length > 0 && smallerSectionSpacing.length > 0) {
      const smallerBySelector = new Map(
        smallerSectionSpacing.map((s) => [s.selector, s])
      );

      for (const largeSec of largerSectionSpacing) {
        const smallSec = smallerBySelector.get(largeSec.selector);
        if (!smallSec) continue;

        // margin-top の20%以上の変化
        if (largeSec.marginTop > 0 && smallSec.marginTop > 0) {
          const topRatio = smallSec.marginTop / largeSec.marginTop;
          if (topRatio < 0.8 || topRatio > 1.2) {
            differences.push({
              element: largeSec.selector,
              description: `${largeSec.selector}のmargin-topが${largeSec.marginTop}pxから${smallSec.marginTop}pxに変化（${Math.round(topRatio * 100)}%）`,
              category: 'spacing',
              [larger.viewport.name]: { marginTop: largeSec.marginTop },
              [smaller.viewport.name]: { marginTop: smallSec.marginTop },
            });
          }
        }

        // margin-bottom の20%以上の変化
        if (largeSec.marginBottom > 0 && smallSec.marginBottom > 0) {
          const bottomRatio = smallSec.marginBottom / largeSec.marginBottom;
          if (bottomRatio < 0.8 || bottomRatio > 1.2) {
            differences.push({
              element: largeSec.selector,
              description: `${largeSec.selector}のmargin-bottomが${largeSec.marginBottom}pxから${smallSec.marginBottom}pxに変化（${Math.round(bottomRatio * 100)}%）`,
              category: 'spacing',
              [larger.viewport.name]: { marginBottom: largeSec.marginBottom },
              [smaller.viewport.name]: { marginBottom: smallSec.marginBottom },
            });
          }
        }
      }
    }

    return differences;
  }

  /**
   * 重複差異を除去
   */
  private deduplicateDifferences(differences: ResponsiveDifference[]): ResponsiveDifference[] {
    const seen = new Map<string, ResponsiveDifference>();

    for (const diff of differences) {
      const key = `${diff.element}:${diff.category}`;
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, diff);
      } else {
        // 既存の差異にビューポート情報をマージ
        const merged = { ...existing };
        for (const [key, value] of Object.entries(diff)) {
          if (key !== 'element' && key !== 'description' && key !== 'category') {
            (merged as Record<string, unknown>)[key] = value;
          }
        }
        seen.set(key, merged);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * サマリーを作成
   */
  private createSummary(differences: ResponsiveDifference[]): DifferenceSummary {
    const byCategory: Record<DifferenceCategory, number> = {
      visibility: 0,
      layout: 0,
      navigation: 0,
      typography: 0,
      spacing: 0,
      order: 0,
      other: 0,
    };

    for (const diff of differences) {
      byCategory[diff.category]++;
    }

    return {
      totalDifferences: differences.length,
      byCategory,
      navigationChange: byCategory.navigation > 0,
      significantLayoutChange: byCategory.layout > 0,
    };
  }

  /**
   * ナビゲーション変化の説明文を生成
   */
  private getNavigationChangeDescription(from: NavigationType, to: NavigationType): string {
    const typeNames: Record<NavigationType, string> = {
      'horizontal-menu': '水平メニュー',
      'hamburger-menu': 'ハンバーガーメニュー',
      'drawer': 'ドロワーメニュー',
      'bottom-nav': 'ボトムナビゲーション',
      'tab-bar': 'タブバー',
      'hidden': '非表示',
      'other': 'その他',
    };

    return `ナビゲーションが${typeNames[from]}から${typeNames[to]}に変化`;
  }

  /**
   * フレックス方向の日本語訳
   */
  private translateFlexDirection(direction: string): string {
    const translations: Record<string, string> = {
      row: '横並び',
      'row-reverse': '横並び（逆順）',
      column: '縦並び',
      'column-reverse': '縦並び（逆順）',
    };
    return translations[direction] ?? direction;
  }
}

// シングルトンインスタンス
export const differenceDetectorService = new DifferenceDetectorService();
