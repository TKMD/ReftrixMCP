// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Full-text search SQL helpers for Hybrid Search.
 *
 * Provides shared SQL clause builders used across layout, motion,
 * background, and narrative hybrid search implementations.
 *
 * @see TDA-HS-R2: DRY principle for fulltext SQL construction
 */

/**
 * Build WHERE conditions for PostgreSQL tsvector full-text search.
 *
 * Generates the standard three-part condition:
 * 1. search_vector IS NOT NULL
 * 2. plainto_tsquery('english', $N) <> ''::tsquery  (skip empty queries)
 * 3. search_vector @@ plainto_tsquery('english', $N) (actual match)
 *
 * @param searchVectorColumn - Fully qualified column name (e.g., 'se.search_vector')
 * @param paramIndex - The $N parameter index for the query text
 * @returns SQL condition string (without leading AND/WHERE)
 */
export function buildFulltextConditions(
  searchVectorColumn: string,
  paramIndex: number
): string {
  return [
    `${searchVectorColumn} IS NOT NULL`,
    `plainto_tsquery('english', $${paramIndex}) <> ''::tsquery`,
    `${searchVectorColumn} @@ plainto_tsquery('english', $${paramIndex})`,
  ].join(' AND ');
}

/**
 * Build ts_rank_cd expression for full-text search ranking.
 *
 * @param searchVectorColumn - Fully qualified column name (e.g., 'se.search_vector')
 * @param paramIndex - The $N parameter index for the query text
 * @returns SQL expression string for use in SELECT or ORDER BY
 */
export function buildFulltextRankExpression(
  searchVectorColumn: string,
  paramIndex: number
): string {
  return `ts_rank_cd(${searchVectorColumn}, plainto_tsquery('english', $${paramIndex}))`;
}
