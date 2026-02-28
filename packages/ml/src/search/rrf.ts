// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reciprocal Rank Fusion (RRF) implementation
 *
 * RRF is a method for combining rankings from multiple search sources.
 * It's particularly useful for hybrid search combining vector and full-text results.
 *
 * Formula: score = 1 / (k + rank)
 * where k is a constant (typically 60) that prevents high-ranked items from
 * dominating the final ranking.
 */

/**
 * Item with ranking information from a single source
 */
export interface RankedItem {
  id: string;
  rank: number;
  [key: string]: unknown;
}

/**
 * Item with combined RRF score
 */
export interface RRFScoredItem {
  id: string;
  rrfScore: number;
  vectorRank?: number;
  fulltextRank?: number;
  data: Record<string, unknown>;
}

/**
 * Calculate RRF score for a single rank position
 *
 * @param rank - Rank position (1-based)
 * @param k - Ranking constant (default 60)
 * @returns RRF score
 */
export function calculateRRF(rank: number, k: number = 60): number {
  return 1 / (k + rank);
}

/**
 * Merge results from vector and full-text search using RRF
 *
 * @param vectorResults - Results from vector similarity search
 * @param fulltextResults - Results from full-text search
 * @param vectorWeight - Weight for vector search results (default 0.6)
 * @param fulltextWeight - Weight for full-text search results (default 0.4)
 * @param k - RRF constant (default 60)
 * @returns Merged and sorted results
 */
export function mergeWithRRF(
  vectorResults: RankedItem[],
  fulltextResults: RankedItem[],
  vectorWeight: number = 0.6,
  fulltextWeight: number = 0.4,
  k: number = 60
): RRFScoredItem[] {
  const scoreMap = new Map<string, RRFScoredItem>();

  // Process vector search results
  vectorResults.forEach((item, index) => {
    const rank = index + 1; // 1-based rank
    const rrfScore = calculateRRF(rank, k) * vectorWeight;

    const existing = scoreMap.get(item.id);
    if (existing) {
      existing.rrfScore += rrfScore;
      existing.vectorRank = rank;
    } else {
      const { id: _id, rank: _, ...data } = item;
      scoreMap.set(item.id, {
        id: item.id,
        rrfScore,
        vectorRank: rank,
        data: data as Record<string, unknown>,
      });
    }
  });

  // Process full-text search results
  fulltextResults.forEach((item, index) => {
    const rank = index + 1; // 1-based rank
    const rrfScore = calculateRRF(rank, k) * fulltextWeight;

    const existing = scoreMap.get(item.id);
    if (existing) {
      existing.rrfScore += rrfScore;
      existing.fulltextRank = rank;
      // Merge additional data if not present
      existing.data = { ...item, ...existing.data };
    } else {
      const { id: _id, rank: _, ...data } = item;
      scoreMap.set(item.id, {
        id: item.id,
        rrfScore,
        fulltextRank: rank,
        data: data as Record<string, unknown>,
      });
    }
  });

  // Convert to array and sort by RRF score (descending)
  const merged = Array.from(scoreMap.values());
  merged.sort((a, b) => b.rrfScore - a.rrfScore);

  if (process.env.NODE_ENV === 'development') {
    // eslint-disable-next-line no-console
    console.log('[Search] RRF merge completed:', {
      vectorCount: vectorResults.length,
      fulltextCount: fulltextResults.length,
      mergedCount: merged.length,
      topScore: merged[0]?.rrfScore,
    });
  }

  return merged;
}

/**
 * Convert an array of rows (with an `id` field) into RankedItem[] with 1-based ranks.
 *
 * The array order is preserved and used for rank assignment.
 * All fields from each row are spread into the resulting RankedItem.
 *
 * @param rows - Array of objects that each contain at least an `id: string` field
 * @returns RankedItem[] with rank starting from 1
 */
export function toRankedItems<T extends { id: string }>(rows: T[]): RankedItem[] {
  return rows.map((row, index) => ({
    ...row,
    rank: index + 1,
  }));
}

/**
 * Calculate effective score from RRF for display purposes
 * Normalizes the RRF score to a 0-1 range
 *
 * @param rrfScore - Raw RRF score
 * @param maxPossibleScore - Maximum possible score (sum of max vector and fulltext scores)
 * @returns Normalized similarity score (0-1)
 */
export function normalizeRRFScore(
  rrfScore: number,
  maxPossibleScore?: number
): number {
  // Default max score: best possible rank (1) in both searches with default weights
  const defaultMax = calculateRRF(1, 60) * 0.6 + calculateRRF(1, 60) * 0.4;
  const maxScore = maxPossibleScore ?? defaultMax;

  return Math.min(1, rrfScore / maxScore);
}
