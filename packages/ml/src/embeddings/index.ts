// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding service exports
 */

export {
  EmbeddingService,
  embeddingService,
  cosineSimilarity,
  DEFAULT_MAX_CACHE_SIZE,
  DEFAULT_PIPELINE_RECYCLE_THRESHOLD,
} from './service.js';
export type {
  EmbeddingTextType,
  EmbeddingServiceConfig,
  CacheStats,
  EmbeddingResult,
  BatchEmbeddingResult,
} from './types.js';

// Multimodal Embedding
export {
  MultimodalEmbeddingService,
  DEFAULT_MULTIMODAL_CONFIG,
  multimodalEmbeddingConfigSchema,
  multimodalEmbeddingInputSchema,
  multimodalEmbeddingResultSchema,
} from './multimodal-embedding.service.js';
export type {
  IEmbeddingService,
  MultimodalEmbeddingConfig,
  MultimodalEmbeddingInput,
  MultimodalEmbeddingResult,
  // 新しい型
  SearchMode,
  MultimodalEmbeddingResultV2,
  MultimodalBatchItem,
  MultimodalBatchResult,
  // バッチ処理最適化
  MultimodalBatchMetrics,
  OptimizedBatchProgress,
  OptimizedBatchOptions,
  OptimizedBatchResult,
} from './multimodal-embedding.service.js';

// Style Feature Embedding
export {
  StyleEmbeddingService,
  styleEmbeddingService,
  createStyleEmbedding,
  createBatchStyleEmbeddings,
  createQueryEmbedding,
} from './style-embedding.service.js';
export type { StyleEmbeddingConfig } from './style-embedding.service.js';

// Vision Feature Embedding
export {
  VisionEmbeddingService,
  visionEmbeddingService,
  createVisionEmbedding,
  createBatchVisionEmbeddings,
  visionFeaturesToText,
} from './vision-embedding.service.js';
export type {
  VisionFeatures,
  VisionRhythm,
  VisionDensity,
  VisionGravity,
  VisionTheme,
  VisionEmbeddingServiceConfig,
  VisionCacheStats,
} from './vision-embedding.types.js';
