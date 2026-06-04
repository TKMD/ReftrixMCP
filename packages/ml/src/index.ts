// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @reftrixmcp/ml
 * ML/Embedding and Search services for Reftrix
 */

// Embedding service exports
export { EmbeddingService, embeddingService, cosineSimilarity } from "./embeddings/index.js";
export type {
  EmbeddingTextType,
  EmbeddingServiceConfig,
  CacheStats,
  EmbeddingResult,
  BatchEmbeddingResult,
} from "./embeddings/index.js";

// Style Feature Embedding exports
export {
  StyleEmbeddingService,
  styleEmbeddingService,
  createStyleEmbedding,
  createBatchStyleEmbeddings,
  createQueryEmbedding,
} from "./embeddings/index.js";
export type { StyleEmbeddingConfig } from "./embeddings/index.js";

// Vision Feature Embedding exports
export {
  VisionEmbeddingService,
  visionEmbeddingService,
  createVisionEmbedding,
  createBatchVisionEmbeddings,
  visionFeaturesToText,
} from "./embeddings/index.js";
export type {
  VisionFeatures,
  VisionRhythm,
  VisionDensity,
  VisionGravity,
  VisionTheme,
  VisionEmbeddingServiceConfig,
  VisionCacheStats,
} from "./embeddings/index.js";

// DINOv2 visual embedding exports
export { DINOv2Service, DINOV2_EMBEDDING_DIMENSION, DINOV2_INPUT_SIZE } from "./dinov2/index.js";
export type { DINOv2ServiceConfig } from "./dinov2/index.js";
export type { DINOv2WorkerMessage, DINOv2WorkerResponse } from "./dinov2/index.js";

// ONNX Runtime availability checker
export {
  isOnnxRuntimeAvailable,
  OnnxRuntimeUnavailableError,
  safeImportOnnx,
} from "./onnx-availability.js";

// ONNX execution provider detection (CUDA EP `.so` availability gate)
// Exported so the Phase 5 fork-child VRAM probe can gate CUDA selection on the
// CUDA EP shared-library availability (FIND-IMPL-PR1-H-NEW-01), not just on
// free VRAM. `verifyCudaAvailability` is a pure filesystem check (no GPU/native
// init), safe to call from the fork-child leaf path.
export {
  detectExecutionProvider,
  verifyCudaAvailability,
  isLdLibraryPathSetAtOsLevel,
} from "./onnx-provider-detect.js";
export type { ExecutionProvider } from "./onnx-provider-detect.js";

// ML Worker Thread resource limits (PR7e-β1)
export {
  loadMLWorkerResourceLimits,
  getMLWorkerThreadOptions,
  MLWorkerResourceLimitsSchema,
} from "./config/worker-resource-limits.js";
export type { MLWorkerResourceLimits } from "./config/worker-resource-limits.js";

// Search utilities exports (SearchService removed in v0.1.0)
export { calculateRRF, mergeWithRRF, normalizeRRFScore, toRankedItems } from "./search/index.js";
export { executeHybridSearch } from "./search/index.js";
export { buildFulltextConditions, buildFulltextRankExpression } from "./search/index.js";
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
} from "./search/index.js";
