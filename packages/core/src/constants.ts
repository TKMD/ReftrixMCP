// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
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

/**
 * ReftrixBot の説明ページ (公開リポジトリ)。UA の識別 URL に使う (LCC 2026-11-08 条件 4)。
 * Public page describing ReftrixBot; the identification URL in every User-Agent.
 */
export const REFTRIXBOT_INFO_URL =
  "https://github.com/TKMD/ReftrixMCP/blob/main/docs/legal/REFTRIXBOT.md";

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
  USER_AGENT: `Mozilla/5.0 (compatible; ReftrixBot/1.0; +${REFTRIXBOT_INFO_URL})`,
  /** Environment variable name for feature flag */
  ENV_FLAG: "REFTRIX_RESPECT_ROBOTS_TXT",
} as const;

/** `browser.version()` から読む Chrome のバージョン / Chrome version read from `browser.version()` */
const CHROME_VERSION_PATTERN = /^(?:HeadlessChrome\/|Chrome\/)?(\d{1,4}(?:\.\d{1,6}){0,3})$/;

/**
 * ブラウザに付ける User-Agent。Chrome 互換の文字列に `(compatible; ReftrixBot/1.0; +URL)` を
 * 足す (Googlebot と同じ形)。バージョンは `browser.version()` の実際の値を渡す。読めない値の
 * ときは素の bot UA に戻し、トークンの無い UA は作らない。robots.txt の照合は
 * `ROBOTS_TXT.PRODUCT_TOKEN` のまま (LCC 2026-11-08、ADR-0018 Amendment)。
 *
 * The User-Agent for browser contexts: a Chrome-compatible string followed by
 * `(compatible; ReftrixBot/1.0; +URL)`, the Googlebot form. Pass the real `browser.version()`.
 * An unreadable version falls back to the plain bot UA, so no UA ever lacks the token.
 * robots.txt matching still uses `ROBOTS_TXT.PRODUCT_TOKEN`.
 *
 * @param browserVersion - `browser.version()` の値 / value of `browser.version()`
 */
export function buildBrowserUserAgent(browserVersion: string): string {
  const match = CHROME_VERSION_PATTERN.exec(browserVersion.trim());
  if (!match) return ROBOTS_TXT.USER_AGENT;
  return (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    `Chrome/${match[1]} Safari/537.36 ` +
    `(compatible; ${ROBOTS_TXT.PRODUCT_TOKEN}/1.0; +${REFTRIXBOT_INFO_URL})`
  );
}
