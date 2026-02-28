// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Quality Services
 * 品質評価関連サービスのエクスポート
 *
 * @module services/quality
 */

// Interface exports
export type {
  IQualityEvaluateService,
  SimilarSection,
  SimilarMotion,
  PatternReferences,
  QualityBenchmark,
  FindSimilarSectionsOptions,
  FindSimilarMotionsOptions,
} from './quality-evaluate.service.interface';

// Benchmark Service exports
export type {
  IBenchmarkService,
  BenchmarkMatch,
  IndustryAverages,
  BenchmarkMetadata,
  FindSimilarBenchmarksOptions,
} from './benchmark.service';

export {
  BenchmarkService,
  createBenchmarkService,
} from './benchmark.service';

// aXe Accessibility Service exports
export type {
  AxeAccessibilityResult,
  AxeViolation,
  AxeServiceOptions,
  ViolationImpact,
  WcagLevel,
} from './axe-accessibility.service';

export {
  AxeAccessibilityService,
  createAxeAccessibilityService,
} from './axe-accessibility.service';
