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
   */
  private detectLayoutDifferences(
    larger: ViewportCaptureResult,
    smaller: ViewportCaptureResult
  ): ResponsiveDifference[] {
    const differences: ResponsiveDifference[] = [];
    const largerLayout = larger.layoutInfo;
    const smallerLayout = smaller.layoutInfo;

    // グリッドカラム数の変化
    if (
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

    // フレックス方向の変化（row → column など）
    if (
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
   */
  private detectVisibilityDifferences(
    largest: ViewportCaptureResult,
    smallest: ViewportCaptureResult
  ): ResponsiveDifference[] {
    const differences: ResponsiveDifference[] = [];

    // ハンバーガーメニューの可視性変化
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
