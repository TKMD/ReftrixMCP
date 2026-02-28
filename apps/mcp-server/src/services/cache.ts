// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cache Service
 * LRU (Least Recently Used) キャッシュ実装
 *
 * 目的:
 * - 検索結果のキャッシュ（TTL 5分）
 * - Embeddingベクトルのキャッシュ（TTL 30分）
 * - キャッシュヒット率の追跡
 * - メモリ効率を考慮した実装
 */
import { createHash } from 'crypto';
import { Logger } from '../utils/logger';

const logger = new Logger('Cache');

/**
 * キャッシュエントリの型定義
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastAccessed: number;
}

/**
 * キャッシュ統計情報の型定義
 */
export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  maxSize: number;
}

/**
 * LRUキャッシュの設定オプション
 */
interface LRUCacheOptions {
  maxSize: number;
  ttlMs: number;
}

/**
 * LRUキャッシュクラス
 * 最も長くアクセスされていないエントリから削除する
 */
export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private maxSize: number;
  private defaultTTL: number;
  private hits: number = 0;
  private misses: number = 0;

  constructor(options: LRUCacheOptions) {
    this.maxSize = options.maxSize;
    this.defaultTTL = options.ttlMs;

    logger.debug('LRUCache initialized', {
      maxSize: this.maxSize,
      defaultTTL: this.defaultTTL,
    });
  }

  /**
   * キャッシュから値を取得
   * @param key キャッシュキー
   * @returns 値が存在すれば値、なければundefined
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      logger.debug('Miss', { key });
      return undefined;
    }

    // TTLチェック
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.misses++;
      logger.debug('Expired', { key });
      return undefined;
    }

    // アクセス時間を更新（LRU）
    entry.lastAccessed = Date.now();
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    logger.debug('Hit', { key });
    return entry.value;
  }

  /**
   * キャッシュに値を設定
   * @param key キャッシュキー
   * @param value 保存する値
   * @param ttlMs オプションのTTL（ミリ秒）
   */
  set(key: string, value: T, ttlMs?: number): void {
    // 最大サイズに達している場合、LRUエントリを削除
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    const now = Date.now();
    const entry: CacheEntry<T> = {
      value,
      expiresAt: now + (ttlMs ?? this.defaultTTL),
      lastAccessed: now,
    };

    // 既存のキーがあれば削除して末尾に追加（順序更新）
    this.cache.delete(key);
    this.cache.set(key, entry);

    logger.debug('Set', {
      key,
      ttl: ttlMs ?? this.defaultTTL,
      size: this.cache.size,
    });
  }

  /**
   * キーが存在するかチェック（期限切れは無視）
   * @param key キャッシュキー
   * @returns 存在すればtrue
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // 期限切れの場合は削除してfalseを返す
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * キャッシュからエントリを削除
   * @param key キャッシュキー
   * @returns 削除成功ならtrue
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      logger.debug('Delete', { key });
    }
    return deleted;
  }

  /**
   * キャッシュをクリア
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    logger.debug('Cleared');
  }

  /**
   * 現在のキャッシュサイズを取得
   * @returns キャッシュサイズ
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * ヒット率を取得
   * @returns ヒット率（0-1）
   */
  getHitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }

  /**
   * キャッシュ統計を取得
   * @returns キャッシュ統計情報
   */
  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: this.getHitRate(),
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }

  /**
   * LRUエントリを削除（最も長くアクセスされていないエントリ）
   */
  private evictLRU(): void {
    // Mapは挿入順序を保持するため、最初のエントリが最も古い
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      this.cache.delete(firstKey);
      logger.debug('Evicted LRU', { key: firstKey });
    }
  }

  /**
   * エントリが期限切れかチェック
   * @param entry キャッシュエントリ
   * @returns 期限切れならtrue
   */
  private isExpired(entry: CacheEntry<T>): boolean {
    return Date.now() > entry.expiresAt;
  }
}

/**
 * 検索結果の型定義
 */
export interface SearchResult {
  id: string;
  name: string;
  embedding?: number[];
  similarity?: number;
  metadata?: Record<string, unknown>;
}

/**
 * 検索結果キャッシュクラス
 * クエリとフィルターからキーを生成
 */
const searchLogger = new Logger('SearchCache');

export class SearchCache extends LRUCache<SearchResult[]> {
  constructor(options: LRUCacheOptions) {
    super(options);
    searchLogger.debug('Initialized');
  }

  /**
   * クエリからキャッシュキーを生成
   * @param query 検索クエリ
   * @param filters オプションのフィルター
   * @returns ハッシュ化されたキー
   */
  generateKey(query: string, filters?: Record<string, unknown>): string {
    const input = JSON.stringify({ query, filters: filters ?? {} });
    const hash = createHash('sha256').update(input).digest('hex');
    return `search:${hash.substring(0, 16)}`;
  }
}

/**
 * Embeddingキャッシュクラス
 * テキストからキーを生成してベクトルをキャッシュ
 */
const embeddingLogger = new Logger('EmbeddingCache');

export class EmbeddingCache extends LRUCache<number[]> {
  constructor(options: LRUCacheOptions) {
    super(options);
    embeddingLogger.debug('Initialized');
  }

  /**
   * テキストからキャッシュキーを生成
   * @param text テキスト
   * @returns ハッシュ化されたキー
   */
  generateKey(text: string): string {
    const hash = createHash('sha256').update(text).digest('hex');
    return `embedding:${hash.substring(0, 16)}`;
  }
}

/**
 * シングルトンインスタンス
 */

// 検索結果キャッシュ: 最大1000件、TTL 5分
export const searchCache = new SearchCache({
  maxSize: 1000,
  ttlMs: 5 * 60 * 1000,
});

// Embeddingキャッシュ: 最大5000件、TTL 30分
export const embeddingCache = new EmbeddingCache({
  maxSize: 5000,
  ttlMs: 30 * 60 * 1000,
});
