// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @reftrix/ml
 * ML/Embedding and Search services for Reftrix
 */

// Embedding service exports
export {
  EmbeddingService,
  embeddingService,
  cosineSimilarity,
} from './embeddings/index.js';
export type {
  EmbeddingTextType,
  EmbeddingServiceConfig,
  CacheStats,
  EmbeddingResult,
  BatchEmbeddingResult,
} from './embeddings/index.js';

// Style Feature Embedding exports
export {
  StyleEmbeddingService,
  styleEmbeddingService,
  createStyleEmbedding,
  createBatchStyleEmbeddings,
  createQueryEmbedding,
} from './embeddings/index.js';
export type { StyleEmbeddingConfig } from './embeddings/index.js';

// Vision Feature Embedding exports
export {
  VisionEmbeddingService,
  visionEmbeddingService,
  createVisionEmbedding,
  createBatchVisionEmbeddings,
  visionFeaturesToText,
} from './embeddings/index.js';
export type {
  VisionFeatures,
  VisionRhythm,
  VisionDensity,
  VisionGravity,
  VisionTheme,
  VisionEmbeddingServiceConfig,
  VisionCacheStats,
} from './embeddings/index.js';

// Search utilities exports (SearchService removed in v0.1.0)
export { calculateRRF, mergeWithRRF, normalizeRRFScore, toRankedItems } from './search/index.js';
export { executeHybridSearch } from './search/index.js';
export { buildFulltextConditions, buildFulltextRankExpression } from './search/index.js';
export type {
  SearchFilters,
  SearchOptions,
  HybridSearchOptions,
  SearchResult,
  SummarySearchResult,
  SearchResultItem,
  SummarySearchResultItem,
  VectorSearchRawResult,
  FullTextSearchRawResult,
  RankedItem,
  RRFScoredItem,
  HybridSearchConfig,
  HybridSearchResult,
} from './search/index.js';
