// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding service type definitions
 */

/**
 * Type of text for embedding generation
 * - 'query': For search queries (prefixed with "query: ")
 * - 'passage': For document/content (prefixed with "passage: ")
 */
export type EmbeddingTextType = 'query' | 'passage';

/**
 * Configuration options for EmbeddingService
 */
export interface EmbeddingServiceConfig {
  /**
   * Model ID from Hugging Face Hub
   * @default "Xenova/multilingual-e5-base"
   */
  modelId?: string;

  /**
   * Cache directory for downloaded models
   */
  cacheDir?: string;

  /**
   * Device to run inference on
   * @default "cpu"
   */
  device?: 'cpu' | 'cuda' | 'webgpu';

  /**
   * Data type for model precision
   * @default "fp32"
   */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';

  /**
   * Maximum number of entries in the embedding cache (LRU eviction)
   * @default 5000
   */
  maxCacheSize?: number;

  /**
   * Number of inferences before the ONNX pipeline is disposed and recreated.
   *
   * onnxruntime-node uses a native C++ arena allocator that grows monotonically
   * during inference. Pipeline recycling tears down the InferenceSession via
   * session.release(), freeing the arena's native memory back to the OS.
   *
   * Lower values reduce peak memory but increase overhead from model re-initialization.
   * Higher values reduce overhead but allow more native memory accumulation.
   *
   * Set to 0 to disable automatic recycling.
   *
   * @default 30
   */
  pipelineRecycleThreshold?: number;
}

/**
 * Cache statistics interface
 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

/**
 * Embedding result with metadata
 */
export interface EmbeddingResult {
  embedding: number[];
  text: string;
  type: EmbeddingTextType;
  cached: boolean;
  processingTimeMs: number;
}

/**
 * Batch embedding result
 */
export interface BatchEmbeddingResult {
  embeddings: number[][];
  texts: string[];
  type: EmbeddingTextType;
  totalProcessingTimeMs: number;
  cachedCount: number;
}
