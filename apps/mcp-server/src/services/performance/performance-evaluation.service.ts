// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Performance Evaluation Service
 * CWVスコア + ページ重量分析 + パフォーマンスbudget比較 + 改善提案生成
 *
 * Core Web Vitals Serviceの結果を元に、包括的なパフォーマンス評価を行う。
 *
 * @module services/performance/performance-evaluation.service
 */

import { logger } from "../../utils/logger";
import type { CwvScoreResult, CwvMetrics } from "./core-web-vitals.service";

// =====================================================
// Types / 型定義
// =====================================================

/**
 * パフォーマンスBudget定義 / Performance budget definition
 */
export interface PerformanceBudget {
  /** LCP上限（ms） */
  lcpMs: number;
  /** CLS上限 */
  cls: number;
  /** FID上限（ms） */
  fidMs: number;
  /** TTFB上限（ms） */
  ttfbMs: number;
  /** INP上限（ms） */
  inpMs: number;
}

/**
 * Budget比較結果 / Budget comparison result
 */
export interface BudgetComparison {
  /** 指標名 */
  metric: string;
  /** 実測値 */
  actual: number;
  /** Budget上限値 */
  budget: number;
  /** Budget内かどうか */
  withinBudget: boolean;
  /** 超過率（%、Budget内なら0） */
  overagePercent: number;
}

/**
 * 改善提案 / Improvement recommendation
 */
export interface PerformanceRecommendation {
  /** 改善対象指標 */
  metric: string;
  /** 優先度 */
  priority: "high" | "medium" | "low";
  /** 提案内容 */
  suggestion: string;
  /** 推定改善効果 */
  estimatedImpact: string;
}

/**
 * パフォーマンス評価結果 / Performance evaluation result
 */
export interface PerformanceEvaluationResult {
  /** 総合スコア（0-100） */
  score: number;
  /** グレード */
  grade: string;
  /** CWV指標 */
  metrics: CwvMetrics;
  /** Budget比較結果 */
  budgetComparisons: BudgetComparison[];
  /** 改善提案 */
  recommendations: PerformanceRecommendation[];
  /** 計測時刻 */
  measuredAt: string;
}

// =====================================================
// Default Budget / デフォルトBudget
// =====================================================

/**
 * Google推奨のデフォルトパフォーマンスBudget
 */
export const DEFAULT_PERFORMANCE_BUDGET: PerformanceBudget = {
  lcpMs: 2500,
  cls: 0.1,
  fidMs: 100,
  ttfbMs: 800,
  inpMs: 200,
};

// =====================================================
// Budget Comparison / Budget比較
// =====================================================

/**
 * CWV指標をBudgetと比較 / Compare CWV metrics against budget
 */
export function compareBudget(metrics: CwvMetrics, budget: PerformanceBudget): BudgetComparison[] {
  const comparisons: BudgetComparison[] = [];

  const addComparison = (metric: string, actual: number, budgetValue: number): void => {
    if (!Number.isFinite(actual) || !Number.isFinite(budgetValue) || budgetValue <= 0) {
      comparisons.push({
        metric,
        actual: Number.isFinite(actual) ? actual : 0,
        budget: Number.isFinite(budgetValue) ? budgetValue : 0,
        withinBudget: false,
        overagePercent: 100,
      });
      return;
    }

    const withinBudget = actual <= budgetValue;
    const overagePercent = withinBudget
      ? 0
      : Math.round(((actual - budgetValue) / budgetValue) * 100);

    comparisons.push({
      metric,
      actual: Math.round(actual * 100) / 100,
      budget: budgetValue,
      withinBudget,
      overagePercent: Math.max(0, overagePercent),
    });
  };

  addComparison("LCP", metrics.lcp.value, budget.lcpMs);
  addComparison("FID", metrics.fid.value, budget.fidMs);
  addComparison("CLS", metrics.cls.value, budget.cls);
  addComparison("TTFB", metrics.ttfb.value, budget.ttfbMs);
  addComparison("INP", metrics.inp.value, budget.inpMs);

  return comparisons;
}

// =====================================================
// Recommendations / 改善提案生成
// =====================================================

/**
 * CWV指標から改善提案を生成 / Generate recommendations from CWV metrics
 */
export function generateRecommendations(
  metrics: CwvMetrics,
  budgetComparisons: BudgetComparison[]
): PerformanceRecommendation[] {
  const recommendations: PerformanceRecommendation[] = [];

  // LCP改善提案
  if (metrics.lcp.rating !== "good") {
    const priority = metrics.lcp.rating === "poor" ? "high" : "medium";
    recommendations.push({
      metric: "LCP",
      priority,
      suggestion:
        "Optimize Largest Contentful Paint: preload critical resources, optimize images (WebP/AVIF), " +
        "use <link rel=preload> for hero images, minimize render-blocking CSS/JS.",
      estimatedImpact:
        metrics.lcp.rating === "poor"
          ? "Critical: LCP > 4s severely impacts user experience"
          : "Moderate: LCP between 2.5-4s needs optimization",
    });
  }

  // FID改善提案
  if (metrics.fid.rating !== "good") {
    const priority = metrics.fid.rating === "poor" ? "high" : "medium";
    recommendations.push({
      metric: "FID",
      priority,
      suggestion:
        "Reduce First Input Delay: break up long tasks, use web workers for heavy computation, " +
        "defer non-critical JavaScript, optimize event handlers.",
      estimatedImpact:
        metrics.fid.rating === "poor"
          ? "Critical: FID > 300ms makes the page feel unresponsive"
          : "Moderate: FID between 100-300ms needs attention",
    });
  }

  // CLS改善提案
  if (metrics.cls.rating !== "good") {
    const priority = metrics.cls.rating === "poor" ? "high" : "medium";
    recommendations.push({
      metric: "CLS",
      priority,
      suggestion:
        "Reduce Cumulative Layout Shift: set explicit dimensions on images/videos, " +
        "avoid inserting content above existing content, use transform animations instead of layout-triggering properties.",
      estimatedImpact:
        metrics.cls.rating === "poor"
          ? "Critical: CLS > 0.25 causes significant visual instability"
          : "Moderate: CLS between 0.1-0.25 needs improvement",
    });
  }

  // TTFB改善提案
  if (metrics.ttfb.rating !== "good") {
    const priority = metrics.ttfb.rating === "poor" ? "high" : "low";
    recommendations.push({
      metric: "TTFB",
      priority,
      suggestion:
        "Optimize Time to First Byte: use CDN, enable server-side caching, " +
        "optimize database queries, consider edge computing.",
      estimatedImpact:
        metrics.ttfb.rating === "poor"
          ? "High: TTFB > 1.8s indicates severe server-side issues"
          : "Low: TTFB between 800ms-1.8s can be improved",
    });
  }

  // INP改善提案
  if (metrics.inp.rating !== "good") {
    const priority = metrics.inp.rating === "poor" ? "medium" : "low";
    recommendations.push({
      metric: "INP",
      priority,
      suggestion:
        "Optimize Interaction to Next Paint: minimize main thread blocking, " +
        "optimize input handlers, use requestAnimationFrame for visual updates.",
      estimatedImpact:
        metrics.inp.rating === "poor"
          ? "Medium: INP > 500ms significantly degrades interactivity"
          : "Low: INP between 200-500ms has room for improvement",
    });
  }

  // Budget超過ベースの追加提案
  const overBudget = budgetComparisons.filter((c) => !c.withinBudget);
  if (overBudget.length >= 3) {
    recommendations.push({
      metric: "Overall",
      priority: "high",
      suggestion:
        "Multiple metrics exceed budget. Consider a comprehensive performance audit: " +
        "profile with Chrome DevTools Performance panel, review bundle sizes, " +
        "and implement code splitting.",
      estimatedImpact: `${overBudget.length} of ${budgetComparisons.length} metrics are over budget`,
    });
  }

  // 優先度順にソート
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  recommendations.sort(
    (a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2)
  );

  return recommendations;
}

// =====================================================
// Service / サービス
// =====================================================

/**
 * Performance Evaluation Serviceインターフェース
 */
export interface IPerformanceEvaluationService {
  /**
   * CWV結果からパフォーマンス評価を実行
   * @param cwvResult - CWV計測結果
   * @param budget - パフォーマンスBudget（省略時デフォルト）
   * @returns パフォーマンス評価結果
   */
  evaluate(cwvResult: CwvScoreResult, budget?: PerformanceBudget): PerformanceEvaluationResult;
}

/**
 * Performance Evaluation Service 実装
 */
export class PerformanceEvaluationService implements IPerformanceEvaluationService {
  evaluate(cwvResult: CwvScoreResult, budget?: PerformanceBudget): PerformanceEvaluationResult {
    const effectiveBudget = budget ?? DEFAULT_PERFORMANCE_BUDGET;

    // Budget比較
    const budgetComparisons = compareBudget(cwvResult.metrics, effectiveBudget);

    // 改善提案生成
    const recommendations = generateRecommendations(cwvResult.metrics, budgetComparisons);

    if (recommendations.length > 0) {
      logger.debug("[PerformanceEvaluation] Recommendations generated", {
        count: recommendations.length,
        highPriority: recommendations.filter((r) => r.priority === "high").length,
      });
    }

    return {
      score: cwvResult.score,
      grade: cwvResult.grade,
      metrics: cwvResult.metrics,
      budgetComparisons,
      recommendations,
      measuredAt: cwvResult.measuredAt,
    };
  }
}
