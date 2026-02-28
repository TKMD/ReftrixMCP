// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Narrative Analysis Service - Public API
 *
 * Webページから「世界観・雰囲気」と「ビジュアルレイアウト構成」を
 * 抽出し、DesignNarrativeテーブルに保存する分析サービス。
 *
 * @module services/narrative
 */

// Types
export * from './types/narrative.types';

// Generators
export {
  generateTextRepresentation,
  generateWorldViewTextRepresentation,
  generateLayoutStructureTextRepresentation,
  formatSearchQuery,
  moodCategoryToSearchText,
  E5_PREFIX,
} from './generators/text-representation.generator';

export {
  calculateConfidence,
  getConfidenceLevel,
  getRecommendedAction,
  CONFIDENCE_THRESHOLDS,
  CONFIDENCE_LEVEL_LABELS,
  type ConfidenceLevel,
  type AnalysisMetadata,
} from './generators/confidence-calculator';

// Analyzers
export {
  WorldViewAnalyzer,
  createWorldViewAnalyzer,
  VALID_MOOD_CATEGORIES,
  type WorldViewAnalysisInput,
  type WorldViewAnalysisOptions,
  type WorldViewAnalysisMetadata,
  type WorldViewAnalysisOutput,
} from './analyzers/worldview.analyzer';

export {
  LayoutStructureAnalyzer,
  createLayoutStructureAnalyzer,
  type LayoutStructureAnalysisInput,
  type LayoutStructureAnalysisMetadata,
  type LayoutStructureAnalysisOutput,
} from './analyzers/layout-structure.analyzer';

// Services
export {
  NarrativeAnalysisService,
  createNarrativeAnalysisService,
  type NarrativeAnalysisServiceConfig,
} from './narrative-analysis.service';

export {
  NarrativeSearchService,
  createNarrativeSearchService,
  setNarrativeEmbeddingServiceFactory,
  resetNarrativeEmbeddingServiceFactory,
  setNarrativePrismaClientFactory,
  resetNarrativePrismaClientFactory,
  type NarrativeSearchServiceConfig,
  type IEmbeddingService as INarrativeEmbeddingService,
  type IPrismaClient as INarrativePrismaClient,
} from './narrative-search.service';
