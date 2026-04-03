// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Performance Services
 * Core Web Vitals計測 + パフォーマンス評価サービスのエントリポイント
 *
 * @module services/performance
 */

export {
  CoreWebVitalsService,
  type ICoreWebVitalsService,
  type CwvMetricResult,
  type CwvMetrics,
  type CwvScoreResult,
  type CwvMeasureOptions,
  type RawCwvData,
  type MetricRating,
  CWV_THRESHOLDS,
  CWV_WEIGHTS,
  rateMetric,
  metricToScore,
  clsToScore,
  calculateCwvScore,
  scoreToGrade,
  buildCwvMetrics,
} from "./core-web-vitals.service";

export {
  PerformanceEvaluationService,
  type IPerformanceEvaluationService,
  type PerformanceBudget,
  type BudgetComparison,
  type PerformanceRecommendation,
  type PerformanceEvaluationResult,
  DEFAULT_PERFORMANCE_BUDGET,
  compareBudget,
  generateRecommendations,
} from "./performance-evaluation.service";
