// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AnimationMetricsCollector Service
 *
 * MotionPatternとLighthouseメトリクスを分析し、
 * アニメーションがパフォーマンスに与える影響を定量化する
 *
 * @module @reftrix/mcp-server/services/motion/animation-metrics-collector
 *
 * 主要機能:
 * 1. 各アニメーションのパフォーマンス影響度スコア計算
 * 2. CLSに影響するアニメーション特定
 * 3. レイアウトトリガーするプロパティ検出
 * 4. パフォーマンス改善提案生成
 */

import type { MotionPattern, LighthouseMetrics } from '../../tools/motion/schemas';

// ============================================================================
// 型定義
// ============================================================================

/**
 * AnimationMetricsCollectorの入力
 */
export interface AnimationMetricsInput {
  /** 分析対象のMotionPattern配列 */
  patterns: MotionPattern[];
  /** Lighthouseメトリクス（オプション、なくても動作） */
  lighthouseMetrics: LighthouseMetrics | null;
}

/**
 * パフォーマンス影響レベル
 */
export type ImpactLevel = 'high' | 'medium' | 'low';

/**
 * 改善提案の優先度
 */
export type RecommendationPriority = 'high' | 'medium' | 'low';

/**
 * 改善提案のカテゴリ
 */
export type RecommendationCategory =
  | 'use-transform'
  | 'reduce-duration'
  | 'avoid-layout'
  | 'cls-risk'
  | 'infinite-animation'
  | 'reduce-paint'
  | 'general';

/**
 * 各パターンの影響度スコア
 */
export interface AnimationImpactScore {
  /** パターンID */
  patternId: string;
  /** パターン名 */
  patternName: string;
  /** 影響度スコア (0-100、高いほど悪影響) */
  score: number;
  /** 影響レベル */
  impactLevel: ImpactLevel;
  /** 影響要因 */
  factors: string[];
}

/**
 * CLS貢献者情報
 */
export interface ClsContributor {
  /** パターンID */
  patternId: string;
  /** パターン名 */
  patternName: string;
  /** CLSへの推定寄与度 */
  estimatedContribution: number;
  /** 理由 */
  reason: string;
}

/**
 * パフォーマンス改善提案
 */
export interface PerformanceRecommendation {
  /** 優先度 */
  priority: RecommendationPriority;
  /** カテゴリ */
  category: RecommendationCategory;
  /** 説明 */
  description: string;
  /** 影響を受けるパターンID */
  affectedPatternIds: string[];
  /** 推定改善効果 */
  estimatedImprovement?: string;
}

/**
 * AnimationMetricsCollectorの出力
 */
export interface AnimationMetricsResult {
  /** 各パターンの影響度スコア */
  patternImpacts: AnimationImpactScore[];
  /** 全体スコア (0-100、高いほど良い) */
  overallScore: number;
  /** CLS貢献者リスト */
  clsContributors: ClsContributor[];
  /** レイアウトトリガープロパティ */
  layoutTriggeringProperties: string[];
  /** 改善提案 */
  recommendations: PerformanceRecommendation[];
  /** Lighthouseが利用可能か */
  lighthouseAvailable: boolean;
  /** 分析日時 */
  analyzedAt: string;
}

// ============================================================================
// 定数
// ============================================================================

/**
 * スコア計算で使用する影響度ファクター
 *
 * 各アニメーション特性がパフォーマンスに与える影響度を定量化
 * 値が大きいほど悪影響が大きいことを示す
 */
export const SCORE_FACTORS = {
  /** レイアウトをトリガーする場合の加算値 */
  TRIGGERS_LAYOUT: 30,
  /** ペイントをトリガーする場合の加算値 */
  TRIGGERS_PAINT: 15,
  /** GPU加速を使用しない場合の加算値 */
  NO_GPU_ACCELERATION: 20,
  /** パフォーマンスレベルがpoorの場合の加算値 */
  POOR_PERFORMANCE_LEVEL: 15,
  /** パフォーマンスレベルがfairの場合の加算値 */
  FAIR_PERFORMANCE_LEVEL: 5,
  /** 長いduration（>1000ms）の場合の加算値 */
  LONG_DURATION: 10,
  /** 無限ループアニメーションの加算値 */
  INFINITE_ITERATIONS: 15,
  /** 遅延のあるレイアウト変更の加算値 */
  DELAYED_LAYOUT_CHANGE: 20,
  /** レイアウトプロパティごとの加算値 */
  LAYOUT_PROPERTY: 5,
  /** CLS悪化時の相関による加算値 */
  CLS_CORRELATION: 15,
  /** TBT悪化時の相関による加算値 */
  TBT_CORRELATION: 10,
} as const;

/**
 * スコア計算で使用する閾値
 */
export const THRESHOLDS = {
  /** 長いdurationと判定する閾値（ms） */
  LONG_DURATION_MS: 1000,
  /** TBT悪化と判定する閾値（ms） */
  HIGH_TBT_MS: 600,
  /** TBT相関で影響ありと判定するアニメーション長（ms） */
  LONG_ANIMATION_MS: 500,
} as const;

/**
 * レイアウトをトリガーするCSSプロパティ
 */
const LAYOUT_TRIGGERING_PROPERTIES = new Set([
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'margin',
  'margin-top',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'padding',
  'padding-top',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'font-size',
  'line-height',
  'border',
  'border-width',
  'display',
  'position',
  'float',
  'clear',
  'flex',
  'grid',
]);

/**
 * ペイントをトリガーするCSSプロパティ
 */
const PAINT_TRIGGERING_PROPERTIES = new Set([
  'color',
  'background',
  'background-color',
  'background-image',
  'border-color',
  'border-style',
  'box-shadow',
  'text-shadow',
  'outline',
  'visibility',
]);

// 将来の機能拡張で使用予定
// const GPU_ACCELERATED_PROPERTIES = new Set(['transform', 'opacity', 'filter']);

/**
 * CLS閾値
 */
const CLS_THRESHOLDS = {
  good: 0.1,
  needsImprovement: 0.25,
  poor: 0.25,
};

// ============================================================================
// ヘルパー関数
// ============================================================================

/**
 * AnimatedProperty型（オブジェクトまたは文字列）
 * MotionPatternのpropertiesフィールドに対応
 *
 * from/to は string | number | undefined の可能性がある（Zodスキーマ準拠）
 */
type AnimatedPropertyInput =
  | string
  | {
      property: string;
      from?: string | number | undefined;
      to?: string | number | undefined;
      unit?: string | undefined;
    };

/**
 * AnimatedPropertyからプロパティ名を抽出
 *
 * @param prop - 文字列またはAnimatedPropertyオブジェクト
 * @returns プロパティ名
 */
export function extractPropertyName(prop: AnimatedPropertyInput): string {
  return typeof prop === 'string' ? prop : prop.property;
}

/**
 * AnimatedProperty配列からプロパティ名の配列を抽出
 *
 * @param properties - AnimatedProperty配列
 * @returns プロパティ名の配列
 */
export function extractPropertyNames(properties: AnimatedPropertyInput[]): string[] {
  return properties.map(extractPropertyName);
}

// ============================================================================
// AnimationMetricsCollector クラス
// ============================================================================

/**
 * AnimationMetricsCollector
 *
 * MotionPatternとLighthouseメトリクスを分析し、
 * アニメーションのパフォーマンス影響を評価するサービス
 */
export class AnimationMetricsCollector {
  /**
   * MotionPatternとLighthouseメトリクスを分析
   */
  async analyze(input: AnimationMetricsInput): Promise<AnimationMetricsResult> {
    const { patterns, lighthouseMetrics } = input;
    const lighthouseAvailable = lighthouseMetrics !== null && lighthouseMetrics !== undefined;

    // 空のパターン配列の場合
    if (patterns.length === 0) {
      return {
        patternImpacts: [],
        overallScore: 100,
        clsContributors: [],
        layoutTriggeringProperties: [],
        recommendations: [],
        lighthouseAvailable,
        analyzedAt: new Date().toISOString(),
      };
    }

    // 各パターンの影響度スコアを計算
    const patternImpacts = patterns.map((pattern) =>
      this.calculatePatternImpact(pattern, lighthouseMetrics)
    );

    // CLS貢献者を特定
    const clsContributors = this.identifyClsContributors(patterns, lighthouseMetrics);

    // レイアウトトリガープロパティを収集
    const layoutTriggeringProperties = this.collectLayoutTriggeringProperties(patterns);

    // 改善提案を生成
    const recommendations = this.getRecommendations(patterns, lighthouseMetrics);

    // 全体スコアを計算（高いほど良い）
    const overallScore = this.calculateOverallScore(patternImpacts, lighthouseMetrics);

    return {
      patternImpacts,
      overallScore,
      clsContributors,
      layoutTriggeringProperties,
      recommendations,
      lighthouseAvailable,
      analyzedAt: new Date().toISOString(),
    };
  }

  /**
   * 単一パターンの影響度スコアを計算
   */
  calculateImpactScore(pattern: MotionPattern, lighthouseMetrics: LighthouseMetrics | null): number {
    return this.calculatePatternImpact(pattern, lighthouseMetrics).score;
  }

  /**
   * 改善提案を生成
   */
  getRecommendations(
    patterns: MotionPattern[],
    lighthouseMetrics: LighthouseMetrics | null
  ): PerformanceRecommendation[] {
    const recommendations: PerformanceRecommendation[] = [];

    for (const pattern of patterns) {
      const patternRecs = this.generatePatternRecommendations(pattern, lighthouseMetrics);
      recommendations.push(...patternRecs);
    }

    // 重複を除去してマージ
    return this.mergeRecommendations(recommendations);
  }

  // ============================================================================
  // プライベートメソッド
  // ============================================================================

  /**
   * パターンの影響度を計算
   */
  private calculatePatternImpact(
    pattern: MotionPattern,
    lighthouseMetrics: LighthouseMetrics | null
  ): AnimationImpactScore {
    const factors: string[] = [];
    let score = 0;

    // パフォーマンス情報から基本スコアを計算
    const perf = pattern.performance;
    if (perf) {
      if (perf.triggersLayout) {
        score += SCORE_FACTORS.TRIGGERS_LAYOUT;
        factors.push('triggers-layout');
      }
      if (perf.triggersPaint) {
        score += SCORE_FACTORS.TRIGGERS_PAINT;
        factors.push('triggers-paint');
      }
      if (!perf.usesTransform && !perf.usesOpacity) {
        score += SCORE_FACTORS.NO_GPU_ACCELERATION;
        factors.push('no-gpu-acceleration');
      }
      if (perf.level === 'poor') {
        score += SCORE_FACTORS.POOR_PERFORMANCE_LEVEL;
        factors.push('poor-performance-level');
      } else if (perf.level === 'fair') {
        score += SCORE_FACTORS.FAIR_PERFORMANCE_LEVEL;
        factors.push('fair-performance-level');
      }
    }

    // アニメーションプロパティからスコアを計算
    const animation = pattern.animation;
    if (animation) {
      // 長いアニメーションは影響大
      const duration = animation.duration ?? 0;
      if (duration > THRESHOLDS.LONG_DURATION_MS) {
        score += SCORE_FACTORS.LONG_DURATION;
        factors.push('long-duration');
      }

      // 無限ループ
      if (animation.iterations === Infinity || animation.iterations === 'infinite') {
        score += SCORE_FACTORS.INFINITE_ITERATIONS;
        factors.push('infinite-iterations');
      }

      // 遅延のあるレイアウト変更はCLSリスク
      if (animation.delay && animation.delay > 0 && perf?.triggersLayout) {
        score += SCORE_FACTORS.DELAYED_LAYOUT_CHANGE;
        factors.push('delayed-layout-change');
      }
    }

    // プロパティからスコアを計算
    // extractPropertyName ヘルパー関数を使用
    const properties = pattern.properties || [];
    for (const prop of properties) {
      const propertyName = extractPropertyName(prop);
      if (LAYOUT_TRIGGERING_PROPERTIES.has(propertyName)) {
        score += SCORE_FACTORS.LAYOUT_PROPERTY;
        if (!factors.includes('layout-property')) {
          factors.push('layout-property');
        }
      }
    }

    // Lighthouseメトリクスとの相関
    if (lighthouseMetrics) {
      // CLS悪化時にレイアウトトリガーパターンは影響大
      if (lighthouseMetrics.cls > CLS_THRESHOLDS.needsImprovement && perf?.triggersLayout) {
        score += SCORE_FACTORS.CLS_CORRELATION;
        factors.push('cls-correlation');
      }

      // TBT悪化時に長いアニメーションは影響大
      const animationDuration = animation?.duration ?? 0;
      if (lighthouseMetrics.tbt > THRESHOLDS.HIGH_TBT_MS && animationDuration > THRESHOLDS.LONG_ANIMATION_MS) {
        score += SCORE_FACTORS.TBT_CORRELATION;
        factors.push('tbt-correlation');
      }
    }

    // スコアを0-100にクランプ
    score = Math.max(0, Math.min(100, score));

    // 影響レベルを決定
    let impactLevel: ImpactLevel;
    if (score >= 50) {
      impactLevel = 'high';
    } else if (score >= 25) {
      impactLevel = 'medium';
    } else {
      impactLevel = 'low';
    }

    return {
      patternId: pattern.id || 'unknown',
      patternName: pattern.name || 'unknown',
      score,
      impactLevel,
      factors,
    };
  }

  /**
   * CLS貢献者を特定
   */
  private identifyClsContributors(
    patterns: MotionPattern[],
    lighthouseMetrics: LighthouseMetrics | null
  ): ClsContributor[] {
    const contributors: ClsContributor[] = [];

    // CLSが良好な場合は貢献者を検出しない
    if (!lighthouseMetrics || lighthouseMetrics.cls <= CLS_THRESHOLDS.good) {
      return contributors;
    }

    for (const pattern of patterns) {
      const reasons: string[] = [];
      let contribution = 0;

      const perf = pattern.performance;
      const animation = pattern.animation;
      const properties = pattern.properties || [];
      // extractPropertyNames ヘルパー関数を使用
      const propertyNames = extractPropertyNames(properties);

      // レイアウトトリガーかつロード時トリガー
      if (perf?.triggersLayout && pattern.trigger === 'load') {
        contribution += 0.3;
        reasons.push('layout-on-load');
      }

      // サイズ変更プロパティ
      const sizeProperties = propertyNames.filter((p) =>
        ['width', 'height', 'margin', 'padding'].includes(p)
      );
      if (sizeProperties.length > 0) {
        contribution += 0.2 * sizeProperties.length;
        reasons.push(`size-change: ${sizeProperties.join(', ')}`);
      }

      // 遅延のあるサイズ変更
      if (animation?.delay && animation.delay > 0 && sizeProperties.length > 0) {
        contribution += 0.3;
        reasons.push(`delayed-size-change (delay: ${animation.delay}ms)`);
      }

      // 貢献度がある場合のみ追加
      if (contribution > 0) {
        contributors.push({
          patternId: pattern.id || 'unknown',
          patternName: pattern.name || 'unknown',
          estimatedContribution: Math.min(1, contribution),
          reason: reasons.join(', '),
        });
      }
    }

    // 貢献度順にソート
    return contributors.sort((a, b) => b.estimatedContribution - a.estimatedContribution);
  }

  /**
   * レイアウトトリガープロパティを収集
   */
  private collectLayoutTriggeringProperties(patterns: MotionPattern[]): string[] {
    const props = new Set<string>();

    for (const pattern of patterns) {
      const properties = pattern.properties || [];
      // extractPropertyName ヘルパー関数を使用
      for (const prop of properties) {
        const propertyName = extractPropertyName(prop);
        if (LAYOUT_TRIGGERING_PROPERTIES.has(propertyName)) {
          props.add(propertyName);
        }
      }
    }

    return Array.from(props);
  }

  /**
   * パターン単位の改善提案を生成
   */
  private generatePatternRecommendations(
    pattern: MotionPattern,
    _lighthouseMetrics: LighthouseMetrics | null
  ): PerformanceRecommendation[] {
    const recommendations: PerformanceRecommendation[] = [];
    const patternId = pattern.id || 'unknown';
    const perf = pattern.performance;
    const animation = pattern.animation;
    const properties = pattern.properties || [];
    // extractPropertyNames ヘルパー関数を使用
    const propertyNames = extractPropertyNames(properties);

    // レイアウトプロパティ使用時にtransformを提案
    const layoutProps = propertyNames.filter((p) => LAYOUT_TRIGGERING_PROPERTIES.has(p));
    const positionProps = layoutProps.filter((p) => ['left', 'top', 'right', 'bottom'].includes(p));

    if (positionProps.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'use-transform',
        description: `Use transform: translate() instead of ${positionProps.join(', ')} for better performance`,
        affectedPatternIds: [patternId],
        estimatedImprovement: 'Reduces layout thrashing by 60-90%',
      });
    }

    // サイズプロパティのアニメーション
    const sizeProps = layoutProps.filter((p) => ['width', 'height'].includes(p));
    if (sizeProps.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'avoid-layout',
        description: `Avoid animating ${sizeProps.join(', ')}. Use transform: scale() instead.`,
        affectedPatternIds: [patternId],
        estimatedImprovement: 'Reduces layout recalculations',
      });
    }

    // CLS リスク
    if (
      animation?.delay &&
      animation.delay > 0 &&
      perf?.triggersLayout &&
      pattern.trigger === 'load'
    ) {
      recommendations.push({
        priority: 'high',
        category: 'cls-risk',
        description:
          'Delayed layout-triggering animation on load causes CLS. Reserve space or use transform.',
        affectedPatternIds: [patternId],
        estimatedImprovement: 'Reduces CLS by avoiding late layout shifts',
      });
    }

    // 無限ループアニメーション
    if (animation?.iterations === Infinity || animation?.iterations === 'infinite') {
      recommendations.push({
        priority: 'medium',
        category: 'infinite-animation',
        description:
          'Infinite animation can cause performance issues. Consider pausing when not visible.',
        affectedPatternIds: [patternId],
        estimatedImprovement: 'Reduces CPU usage when element is not in viewport',
      });
    }

    // ペイントトリガー
    const paintProps = propertyNames.filter((p) => PAINT_TRIGGERING_PROPERTIES.has(p));
    if (paintProps.length > 2 && !perf?.usesTransform) {
      recommendations.push({
        priority: 'low',
        category: 'reduce-paint',
        description: `Multiple paint-triggering properties (${paintProps.join(', ')}). Consider using will-change or opacity/transform.`,
        affectedPatternIds: [patternId],
      });
    }

    return recommendations;
  }

  /**
   * 重複する改善提案をマージ
   */
  private mergeRecommendations(
    recommendations: PerformanceRecommendation[]
  ): PerformanceRecommendation[] {
    const merged = new Map<string, PerformanceRecommendation>();

    for (const rec of recommendations) {
      const key = `${rec.category}-${rec.description}`;
      const existing = merged.get(key);

      if (existing) {
        // パターンIDをマージ
        existing.affectedPatternIds = [
          ...new Set([...existing.affectedPatternIds, ...rec.affectedPatternIds]),
        ];
        // 優先度は高い方を採用
        if (this.priorityToNumber(rec.priority) > this.priorityToNumber(existing.priority)) {
          existing.priority = rec.priority;
        }
      } else {
        merged.set(key, { ...rec });
      }
    }

    // 優先度順にソート
    return Array.from(merged.values()).sort(
      (a, b) => this.priorityToNumber(b.priority) - this.priorityToNumber(a.priority)
    );
  }

  /**
   * 優先度を数値に変換
   */
  private priorityToNumber(priority: RecommendationPriority): number {
    switch (priority) {
      case 'high':
        return 3;
      case 'medium':
        return 2;
      case 'low':
        return 1;
      default:
        return 0;
    }
  }

  /**
   * 全体スコアを計算
   */
  private calculateOverallScore(
    impacts: AnimationImpactScore[],
    lighthouseMetrics: LighthouseMetrics | null
  ): number {
    if (impacts.length === 0) {
      return 100;
    }

    // 各パターンのスコアの平均を取得（反転: 影響度が高いほどスコアが低い）
    const avgImpact = impacts.reduce((sum, i) => sum + i.score, 0) / impacts.length;

    // 100から平均影響度を引く
    let overallScore = 100 - avgImpact;

    // Lighthouseメトリクスによる調整
    if (lighthouseMetrics) {
      // CLS悪化時にペナルティ
      if (lighthouseMetrics.cls > CLS_THRESHOLDS.poor) {
        overallScore -= 10;
      } else if (lighthouseMetrics.cls > CLS_THRESHOLDS.needsImprovement) {
        overallScore -= 5;
      }

      // パフォーマンススコアが低い場合にペナルティ
      if (lighthouseMetrics.performance_score < 50) {
        overallScore -= 10;
      } else if (lighthouseMetrics.performance_score < 75) {
        overallScore -= 5;
      }
    }

    // 0-100にクランプ
    return Math.max(0, Math.min(100, Math.round(overallScore)));
  }
}

// ============================================================================
// エクスポート
// ============================================================================

export default AnimationMetricsCollector;
