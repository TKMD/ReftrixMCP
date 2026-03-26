// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search Result Cache Service
 * 検索結果キャッシュサービス
 *
 * In-memory LRU cache for search results to reduce P95 latency.
 * P95レイテンシ削減のための検索結果インメモリLRUキャッシュ。
 *
 * Cache key = hash of (toolName + query + filters + userContext).
 * TTL-based expiration with configurable max entries.
 *
 * @module services/search-cache.service
 */

import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
import { logger } from "../utils/logger";

// =====================================================
// Configuration / 設定
// =====================================================

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Environment variable overrides
const MAX_ENTRIES = Math.max(
  1,
  parseInt(process.env.SEARCH_CACHE_MAX_ENTRIES ?? "", 10) || DEFAULT_MAX_ENTRIES
);
const TTL_MS = Math.max(
  1000,
  parseInt(process.env.SEARCH_CACHE_TTL_MS ?? "", 10) || DEFAULT_TTL_MS
);

// =====================================================
// Types / 型定義
// =====================================================

export interface SearchCacheStats {
  /** Number of items in cache / キャッシュ内アイテム数 */
  size: number;
  /** Maximum capacity / 最大容量 */
  maxEntries: number;
  /** TTL in milliseconds / TTL（ミリ秒） */
  ttlMs: number;
  /** Cache hit count since startup / 起動後のキャッシュヒット数 */
  hits: number;
  /** Cache miss count since startup / 起動後のキャッシュミス数 */
  misses: number;
  /** Hit rate (0-1) / ヒット率 */
  hitRate: number;
}

// =====================================================
// Cache Key Generation / キャッシュキー生成
// =====================================================

/**
 * Generate a deterministic cache key from search parameters.
 * 検索パラメータから決定論的なキャッシュキーを生成。
 *
 * Uses SHA-256 hash of JSON-serialized params for consistent key generation.
 * Includes userContext (e.g., profileId) to prevent cross-user cache pollution.
 */
export function generateCacheKey(toolName: string, params: Record<string, unknown>): string {
  // Sort keys for deterministic serialization
  const sortedParams = JSON.stringify(params, Object.keys(params).sort());
  const input = `${toolName}:${sortedParams}`;
  return createHash("sha256").update(input).digest("hex");
}

// =====================================================
// SearchCacheService
// =====================================================

let hitCount = 0;
let missCount = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- LRU cache stores heterogeneous search results
const cache = new LRUCache<string, any>({
  max: MAX_ENTRIES,
  ttl: TTL_MS,
});

/**
 * Get cached search result.
 * キャッシュされた検索結果を取得。
 *
 * @returns Cached result or undefined on miss
 */
export function getCachedResult<T>(key: string): T | undefined {
  const result = cache.get(key) as T | undefined;
  if (result !== undefined) {
    hitCount++;
    return result;
  }
  missCount++;
  return undefined;
}

/**
 * Store search result in cache.
 * 検索結果をキャッシュに格納。
 */
export function setCachedResult<T>(key: string, value: T): void {
  cache.set(key, value);
}

/**
 * Invalidate cache entries matching a prefix pattern.
 * プレフィックスパターンに一致するキャッシュエントリを無効化。
 *
 * Note: LRU cache doesn't support prefix-based invalidation natively.
 * For targeted invalidation, clear the entire cache (safe due to short TTL).
 */
export function invalidateCache(): void {
  cache.clear();
  logger.info(`[SearchCache] Cache cleared (was ${cache.size} entries)`);
}

/**
 * Get cache statistics.
 * キャッシュ統計を取得。
 */
export function getCacheStats(): SearchCacheStats {
  const total = hitCount + missCount;
  return {
    size: cache.size,
    maxEntries: MAX_ENTRIES,
    ttlMs: TTL_MS,
    hits: hitCount,
    misses: missCount,
    hitRate: total > 0 ? hitCount / total : 0,
  };
}

/**
 * Higher-order function to wrap a search operation with caching.
 * 検索操作をキャッシュでラップする高階関数。
 *
 * @example
 * ```typescript
 * const cachedSearch = withSearchCache("layout.search", async (params) => {
 *   return await performLayoutSearch(params);
 * });
 * const result = await cachedSearch({ query: "hero section", limit: 10 });
 * ```
 */
export function withSearchCache<TParams extends Record<string, unknown>, TResult>(
  toolName: string,
  searchFn: (params: TParams) => Promise<TResult>
): (params: TParams) => Promise<TResult> {
  return async (params: TParams): Promise<TResult> => {
    const key = generateCacheKey(toolName, params);
    const cached = getCachedResult<TResult>(key);
    if (cached !== undefined) {
      return cached;
    }
    const result = await searchFn(params);
    setCachedResult(key, result);
    return result;
  };
}
