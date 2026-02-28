// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reftrix constants
 */

// Embedding dimensions for multilingual-e5-base model
export const EMBEDDING_DIMENSIONS = 768;

// Default pagination
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Search settings
export const SEARCH_MIN_QUERY_LENGTH = 1;
export const SEARCH_MAX_QUERY_LENGTH = 500;

// Port configuration (offset: 21000)
export const PORTS = {
  POSTGRES: 26432,
  PRISMA_STUDIO: 26555,
  MCP_SERVER: 29080,
  REDIS: 27379,
} as const;

// API versioning
export const API_VERSION = "v1";
export const API_BASE_PATH = `/api/${API_VERSION}`;

// Robots.txt compliance (RFC 9309)
export const ROBOTS_TXT = {
  /** Cache TTL in milliseconds (24 hours) */
  CACHE_TTL_MS: 24 * 60 * 60 * 1000,
  /** Maximum cache entries (LRU eviction beyond this) */
  MAX_CACHE_ENTRIES: 500,
  /** Fetch timeout in milliseconds */
  FETCH_TIMEOUT_MS: 5000,
  /** Maximum robots.txt file size in bytes (1MB) */
  MAX_FILE_SIZE: 1024 * 1024,
  /** Cache cleanup interval in milliseconds (1 hour) */
  CLEANUP_INTERVAL_MS: 60 * 60 * 1000,
  /** Default product token for crawler identification */
  PRODUCT_TOKEN: "ReftrixBot",
  /** Default User-Agent header for HTTP requests */
  USER_AGENT: "Mozilla/5.0 (compatible; ReftrixBot/1.0; +https://reftrix.dev/bot)",
  /** Environment variable name for feature flag */
  ENV_FLAG: "REFTRIX_RESPECT_ROBOTS_TXT",
} as const;
