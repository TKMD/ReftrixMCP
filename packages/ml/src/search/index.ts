// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search utilities exports
 *
 * RRF utilities and types for WebDesign search services.
 */

export { calculateRRF, mergeWithRRF, normalizeRRFScore, toRankedItems } from './rrf.js';
export type {
  RankedItem,
  RRFScoredItem,
} from './rrf.js';
export { executeHybridSearch } from './hybrid.js';
export { buildFulltextConditions, buildFulltextRankExpression } from './fulltext-helpers.js';
export type {
  HybridSearchConfig,
  HybridSearchResult,
} from './hybrid.js';
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
} from './types.js';
