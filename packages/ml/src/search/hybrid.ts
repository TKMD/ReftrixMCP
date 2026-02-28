// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hybrid Search Service
 *
 * Combines vector search (pgvector cosine similarity) and full-text search
 * (PostgreSQL tsvector/tsquery) using Reciprocal Rank Fusion (RRF).
 *
 * Default weights: 60% vector + 40% full-text
 */

import { mergeWithRRF, normalizeRRFScore } from './rrf.js';
import type { RankedItem, RRFScoredItem } from './rrf.js';

/**
 * Configuration for hybrid search execution
 */
export interface HybridSearchConfig {
  /** Weight for vector search results (default 0.6) */
  vectorWeight?: number;
  /** Weight for full-text search results (default 0.4) */
  fulltextWeight?: number;
  /** RRF constant k (default 60) */
  k?: number;
}

/**
 * Result from hybrid search with normalized similarity score
 */
export interface HybridSearchResult {
  id: string;
  /** Normalized similarity score (0-1) */
  similarity: number;
  /** Source information for debugging */
  source: {
    vectorRank?: number;
    fulltextRank?: number;
  };
  /** Additional data from the search result */
  data: Record<string, unknown>;
}

const DEFAULT_CONFIG: Required<HybridSearchConfig> = {
  vectorWeight: 0.6,
  fulltextWeight: 0.4,
  k: 60,
};

/**
 * Execute hybrid search by combining vector and full-text search results with RRF
 *
 * Both search functions are executed in parallel via Promise.all for minimum latency.
 * Results are merged using Reciprocal Rank Fusion (RRF) with configurable weights.
 *
 * @param vectorSearchFn - Function that returns vector search results (ranked by cosine similarity)
 * @param fulltextSearchFn - Function that returns full-text search results (ranked by ts_rank_cd)
 * @param config - Optional hybrid search configuration
 * @returns Merged results sorted by normalized RRF similarity score
 */
export async function executeHybridSearch(
  vectorSearchFn: () => Promise<RankedItem[]>,
  fulltextSearchFn: () => Promise<RankedItem[]>,
  config?: HybridSearchConfig
): Promise<HybridSearchResult[]> {
  const { vectorWeight, fulltextWeight, k } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  // Execute both searches in parallel for minimum latency
  const [vectorResults, fulltextResults] = await Promise.all([
    vectorSearchFn(),
    fulltextSearchFn(),
  ]);

  // If one source returns empty, fall back to the other source only
  if (vectorResults.length === 0 && fulltextResults.length === 0) {
    return [];
  }

  // Merge with RRF
  const merged: RRFScoredItem[] = mergeWithRRF(
    vectorResults,
    fulltextResults,
    vectorWeight,
    fulltextWeight,
    k
  );

  // Normalize scores and format output
  return merged.map((item: RRFScoredItem): HybridSearchResult => {
    const source: HybridSearchResult['source'] = {};
    if (item.vectorRank !== undefined) {
      source.vectorRank = item.vectorRank;
    }
    if (item.fulltextRank !== undefined) {
      source.fulltextRank = item.fulltextRank;
    }
    return {
      id: item.id,
      similarity: normalizeRRFScore(item.rrfScore),
      source,
      data: item.data,
    };
  });
}
