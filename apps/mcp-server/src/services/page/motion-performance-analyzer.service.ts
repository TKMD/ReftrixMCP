// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionPerformanceAnalyzer Service
 *
 * CSS animation/transition のパフォーマンス分析サービス
 * motion-detector.ts から抽出（Phase5 リファクタリング）
 *
 * 責務:
 * - GPU accelerated properties の検出（transform, opacity）
 * - Layout/Paint trigger properties の検出
 * - アクセシビリティ（prefers-reduced-motion）の検出
 * - パフォーマンススコアと推奨事項の生成
 *
 * @module services/page/motion-performance-analyzer.service
 */

import { logger, isDevelopment } from '../../utils/logger';

// =====================================================
// Types
// =====================================================

/** パフォーマンスレベル */
export type PerformanceLevel = 'good' | 'acceptable' | 'poor';

/** パフォーマンス情報 */
export interface PerformanceInfo {
  level: PerformanceLevel;
  usesTransform: boolean;
  usesOpacity: boolean;
  triggersLayout: boolean;
  triggersPaint: boolean;
}

/** アクセシビリティ情報 */
export interface AccessibilityInfo {
  respectsReducedMotion: boolean;
}

/** キーフレームステップ（extractPropertiesFromKeyframes用） */
export interface KeyframeStep {
  offset: number;
  styles: Record<string, string>;
}

/** キーフレームプロパティ詳細（from/to値を含む） */
export interface DetailedProperty {
  property: string;
  from?: string;
  to?: string;
}

// =====================================================
// Constants
// =====================================================

/**
 * レイアウト再計算をトリガーするプロパティ
 * これらのプロパティはリフロー（reflow）を引き起こすため、パフォーマンスが悪い
 */
export const LAYOUT_TRIGGER_PROPERTIES = new Set([
  'width',
  'height',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'top',
  'right',
  'bottom',
  'left',
  'border',
  'border-width',
  'font-size',
  'line-height',
]);

/**
 * ペイントをトリガーするプロパティ
 * レイアウトには影響しないが、再描画が必要
 */
export const PAINT_TRIGGER_PROPERTIES = new Set([
  'background',
  'background-color',
  'background-image',
  'color',
  'border-color',
  'border-style',
  'box-shadow',
  'text-shadow',
  'outline',
]);

// =====================================================
// Performance Scores
// =====================================================

/** パフォーマンスレベルごとのスコア */
const PERFORMANCE_SCORES: Record<PerformanceLevel, number> = {
  good: 100,
  acceptable: 60,
  poor: 20,
};

// =====================================================
// MotionPerformanceAnalyzer Class
// =====================================================

/**
 * モーションパターンのパフォーマンス分析器
 *
 * CSSアニメーション/トランジションのパフォーマンス特性を分析し、
 * GPU accelerated properties（transform, opacity）の使用状況、
 * レイアウト/ペイントトリガーの検出、アクセシビリティ対応状況を評価する
 */
export class MotionPerformanceAnalyzer {
  /**
   * CSSプロパティ配列からパフォーマンス情報を分析
   *
   * @param properties - 分析するCSSプロパティ名の配列
   * @returns パフォーマンス情報（レベル、GPU加速使用、トリガー情報）
   *
   * パフォーマンスレベルの判定ロジック:
   * - poor: レイアウトトリガープロパティを含む
   * - acceptable: ペイントトリガーのみ（GPU加速なし）または不明プロパティ
   * - good: transform/opacityを使用（GPU加速）
   */
  analyzePerformance(properties: string[]): PerformanceInfo {
    const propNames = properties.map((p) => p.toLowerCase());

    // GPU accelerated properties の検出
    const usesTransform = propNames.some(
      (p) =>
        p === 'transform' ||
        p.startsWith('translate') ||
        p.startsWith('rotate') ||
        p.startsWith('scale')
    );
    const usesOpacity = propNames.includes('opacity');

    // Trigger properties の検出
    const triggersLayout = propNames.some((p) => LAYOUT_TRIGGER_PROPERTIES.has(p));
    const triggersPaint = propNames.some((p) => PAINT_TRIGGER_PROPERTIES.has(p));

    // パフォーマンスレベルの判定
    let level: PerformanceLevel;
    if (triggersLayout) {
      // レイアウトトリガーは常に poor
      level = 'poor';
    } else if (triggersPaint && !usesTransform && !usesOpacity) {
      // ペイントのみでGPU加速なしは acceptable
      level = 'acceptable';
    } else if (usesTransform || usesOpacity) {
      // GPU加速プロパティを使用は good
      level = 'good';
    } else {
      // 不明なプロパティは acceptable
      level = 'acceptable';
    }

    if (isDevelopment()) {
      logger.debug('[MotionPerformanceAnalyzer] analyzePerformance:', {
        properties,
        level,
        usesTransform,
        usesOpacity,
        triggersLayout,
        triggersPaint,
      });
    }

    return {
      level,
      usesTransform,
      usesOpacity,
      triggersLayout,
      triggersPaint,
    };
  }

  /**
   * CSSコンテンツからアクセシビリティ情報を分析
   *
   * @param css - 分析するCSSコンテンツ
   * @returns アクセシビリティ情報
   *
   * 検出対象:
   * - @media (prefers-reduced-motion: reduce)
   * - @media (prefers-reduced-motion: no-preference)
   */
  analyzeAccessibility(css: string): AccessibilityInfo {
    // prefers-reduced-motion メディアクエリの検出
    const respectsReducedMotion = /prefers-reduced-motion/.test(css);

    if (isDevelopment()) {
      logger.debug('[MotionPerformanceAnalyzer] analyzeAccessibility:', {
        respectsReducedMotion,
        cssLength: css.length,
      });
    }

    return {
      respectsReducedMotion,
    };
  }

  /**
   * キーフレームステップからプロパティ名を抽出
   *
   * @param steps - キーフレームステップの配列
   * @returns 重複を除いたプロパティ名の配列
   */
  extractPropertiesFromKeyframes(steps: KeyframeStep[]): string[] {
    const properties = new Set<string>();

    for (const step of steps) {
      for (const prop of Object.keys(step.styles)) {
        properties.add(prop);
      }
    }

    const result = Array.from(properties);

    if (isDevelopment()) {
      logger.debug('[MotionPerformanceAnalyzer] extractPropertiesFromKeyframes:', {
        stepsCount: steps.length,
        propertiesCount: result.length,
        properties: result,
      });
    }

    return result;
  }

  /**
   * キーフレームステップからプロパティ名とfrom/to値を抽出
   *
   * 最初のステップ（最小offset）の値をfrom、最後のステップ（最大offset）の値をtoとして抽出する。
   * プロパティが最初/最後のステップに存在しない場合、そのフィールドはundefinedになる。
   *
   * @param steps - キーフレームステップの配列
   * @returns プロパティ名とfrom/to値の配列
   */
  extractDetailedPropertiesFromKeyframes(steps: KeyframeStep[]): DetailedProperty[] {
    if (steps.length === 0) {
      return [];
    }

    // ソート済みステップを使用（offsetの昇順）
    const sorted = [...steps].sort((a, b) => a.offset - b.offset);
    const firstStep = sorted[0];
    const lastStep = sorted.length > 1 ? sorted[sorted.length - 1] : undefined;

    // 全プロパティを収集（出現順を保持）
    const propertyNames: string[] = [];
    const seen = new Set<string>();

    for (const step of sorted) {
      for (const prop of Object.keys(step.styles)) {
        if (!seen.has(prop)) {
          seen.add(prop);
          propertyNames.push(prop);
        }
      }
    }

    // 各プロパティのfrom（最初のステップ）とto（最後のステップ）を抽出
    // プロパティが最初/最後のステップに存在しない場合、そのフィールドはundefined
    const result: DetailedProperty[] = propertyNames.map((property) => {
      const from = firstStep?.styles[property];
      const to = lastStep?.styles[property];

      const detailed: DetailedProperty = { property };

      if (from !== undefined) {
        detailed.from = from;
      }

      if (lastStep && to !== undefined) {
        detailed.to = to;
      }

      return detailed;
    });

    if (isDevelopment()) {
      logger.debug('[MotionPerformanceAnalyzer] extractDetailedPropertiesFromKeyframes:', {
        stepsCount: steps.length,
        propertiesCount: result.length,
        properties: result.map((p) => p.property),
      });
    }

    return result;
  }

  /**
   * パフォーマンスレベルからスコアを取得
   *
   * @param level - パフォーマンスレベル
   * @returns スコア（0-100）
   *
   * スコアマッピング:
   * - good: 100
   * - acceptable: 60
   * - poor: 20
   */
  getPerformanceScore(level: PerformanceLevel): number {
    return PERFORMANCE_SCORES[level];
  }

  /**
   * パフォーマンス情報から推奨事項を生成
   *
   * @param info - パフォーマンス情報
   * @returns 推奨事項の配列
   */
  getPerformanceRecommendations(info: PerformanceInfo): string[] {
    const recommendations: string[] = [];

    // 既に最適化されている場合は推奨事項なし
    if (info.level === 'good' && !info.triggersLayout && !info.triggersPaint) {
      return recommendations;
    }

    // レイアウトトリガーがある場合
    if (info.triggersLayout) {
      recommendations.push(
        'レイアウトをトリガーするプロパティ（width, height, margin等）をtransformまたはopacityに置き換えることを検討してください。' +
          'これによりGPU accelerationが有効になり、パフォーマンスが向上します。'
      );
    }

    // ペイントトリガーがあり、GPU加速がない場合
    if (info.triggersPaint && !info.usesTransform && !info.usesOpacity) {
      recommendations.push(
        'ペイントをトリガーするプロパティ（background-color, color等）の代わりに、' +
          'opacityやtransformを使用することでGPU accelerationを活用できます。'
      );
    }

    if (isDevelopment()) {
      logger.debug('[MotionPerformanceAnalyzer] getPerformanceRecommendations:', {
        info,
        recommendationsCount: recommendations.length,
      });
    }

    return recommendations;
  }
}

// =====================================================
// Singleton Pattern
// =====================================================

let instance: MotionPerformanceAnalyzer | null = null;

/**
 * MotionPerformanceAnalyzer のシングルトンインスタンスを取得
 *
 * @returns MotionPerformanceAnalyzer インスタンス
 */
export function getMotionPerformanceAnalyzer(): MotionPerformanceAnalyzer {
  if (!instance) {
    instance = new MotionPerformanceAnalyzer();
    if (isDevelopment()) {
      logger.debug('[MotionPerformanceAnalyzer] Created new instance');
    }
  }
  return instance;
}

/**
 * シングルトンインスタンスをリセット（テスト用）
 */
export function resetMotionPerformanceAnalyzer(): void {
  instance = null;
  if (isDevelopment()) {
    logger.debug('[MotionPerformanceAnalyzer] Instance reset');
  }
}
