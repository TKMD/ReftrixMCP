// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search service type definitions
 *
 * WebDesign専用 - Layout (SectionPattern) and Motion (MotionPattern) search
 */

/**
 * Search filter options for WebDesign patterns
 */
export interface SearchFilters {
  /** Pattern type filter (hero, feature, cta, footer, etc.) */
  type?: string | undefined;
  /** Trigger filter for motion patterns (scroll, hover, click, load) */
  trigger?: string | undefined;
  /** Category filter for motion patterns (entrance, exit, emphasis, etc.) */
  category?: string | undefined;
  /** Tag filters */
  tags?: string[] | undefined;
  /** Page ID filter */
  pageId?: string | undefined;
}

/**
 * Search options for all search methods
 */
export interface SearchOptions {
  /** Maximum number of results to return */
  limit: number;
  /** Offset for pagination */
  offset?: number | undefined;
  /** Search filters */
  filters?: SearchFilters | undefined;
  /** Summary mode: returns only id, name, similarity (default: false) */
  summary?: boolean | undefined;
}

/**
 * Hybrid search options extending base options
 */
export interface HybridSearchOptions extends SearchOptions {
  /** Weight for vector search results (default 0.6) */
  vectorWeight?: number | undefined;
  /** Weight for full-text search results (default 0.4) */
  fulltextWeight?: number | undefined;
  /** Minimum similarity threshold (0-1) */
  minSimilarity?: number | undefined;
}

/**
 * Individual search result item for WebDesign patterns
 */
export interface SearchResultItem {
  id: string;
  name: string;
  type: string;
  description: string | undefined;
  similarity: number;
  /** HTML snippet for layout patterns */
  htmlSnippet?: string | undefined;
  /** Raw CSS for motion patterns */
  rawCss?: string | undefined;
  /** Trigger type for motion patterns */
  trigger?: string | undefined;
  /** Category for motion patterns */
  category?: string | undefined;
  /** Associated page ID */
  pageId?: string | undefined;
  createdAt: Date;
}

/**
 * Summary search result item (lightweight, only essential fields)
 */
export interface SummarySearchResultItem {
  id: string;
  name: string;
  similarity: number;
}

/**
 * Search result with pagination info
 */
export interface SearchResult {
  items: SearchResultItem[];
  total: number;
  limit: number;
  offset: number;
  searchTimeMs?: number;
  /** Summary mode flag (only present when summary=true) */
  _summary_mode?: true;
}

/**
 * Summary search result with pagination info (lightweight response)
 */
export interface SummarySearchResult {
  items: SummarySearchResultItem[];
  total: number;
  limit: number;
  offset: number;
  searchTimeMs?: number;
  /** Summary mode flag (always true for summary results) */
  _summary_mode: true;
}

/**
 * Vector search raw result from database (section_patterns / motion_patterns)
 */
export interface VectorSearchRawResult {
  id: string;
  name: string;
  type: string;
  description?: string;
  similarity: number;
  html_snippet?: string;
  raw_css?: string;
  trigger?: string;
  category?: string;
  page_id?: string;
  created_at: Date;
}

/**
 * Full-text search raw result from database
 */
export interface FullTextSearchRawResult {
  id: string;
  name: string;
  type: string;
  description?: string;
  rank: number;
  html_snippet?: string;
  raw_css?: string;
  trigger?: string;
  category?: string;
  page_id?: string;
  created_at: Date;
}
