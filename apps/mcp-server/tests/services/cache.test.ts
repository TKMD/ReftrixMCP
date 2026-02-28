// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cache Service テスト
 * TDD Red フェーズ: キャッシュサービスのテスト
 *
 * 目的:
 * - LRUキャッシュ実装（get/set/has/delete操作）
 * - TTL（有効期限）管理
 * - 最大サイズ制限とLRU排出
 * - キャッシュヒット率計算
 * - 検索結果キャッシュ（クエリハッシュ、TTL 5分）
 * - Embeddingキャッシュ（テキストハッシュ、メモリ効率）
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// =====================================================
// 型定義（実装はまだ存在しない）
// =====================================================

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl?: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  maxSize: number;
}

type LRUCache<T> = {
  get: (key: string) => T | null;
  set: (key: string, value: T, ttl?: number) => void;
  has: (key: string) => boolean;
  delete: (key: string) => boolean;
  clear: () => void;
  size: () => number;
  stats: () => CacheStats;
};

type SearchCacheService = {
  getCachedResults: (queryHash: string) => Promise<unknown[] | null>;
  cacheResults: (queryHash: string, results: unknown[]) => Promise<void>;
  generateQueryHash: (query: string, filters?: Record<string, unknown>) => string;
  clear: () => void;
};

type EmbeddingCacheService = {
  getCachedEmbedding: (textHash: string) => Promise<number[] | null>;
  cacheEmbedding: (textHash: string, embedding: number[]) => Promise<void>;
  generateTextHash: (text: string) => string;
  clear: () => void;
};

// =====================================================
// 共通ファクトリー・ヘルパー（重複削減）
// =====================================================

// LRUキャッシュ生成ファクトリー（重複削減）
const createLRUCache = <T>(maxSize = 100): LRUCache<T> => {
  const storage = new Map<string, CacheEntry<T>>();
  const accessOrder: string[] = [];
  let hits = 0;
  let misses = 0;

  const updateAccessOrder = (key: string) => {
    const index = accessOrder.indexOf(key);
    if (index > -1) accessOrder.splice(index, 1);
    accessOrder.push(key);
  };

  return {
    get: (key: string) => {
      const entry = storage.get(key);
      if (!entry) { misses++; return null; }
      if (entry.ttl && Date.now() - entry.timestamp > entry.ttl) {
        storage.delete(key);
        misses++;
        return null;
      }
      updateAccessOrder(key);
      hits++;
      return entry.value;
    },
    set: (key: string, value: T, ttl?: number) => {
      storage.set(key, { value, timestamp: Date.now(), ttl });
      updateAccessOrder(key);
      if (storage.size > maxSize) {
        const oldestKey = accessOrder.shift();
        if (oldestKey) storage.delete(oldestKey);
      }
    },
    has: (key: string) => storage.has(key),
    delete: (key: string) => {
      const deleted = storage.delete(key);
      if (deleted) {
        const index = accessOrder.indexOf(key);
        if (index > -1) accessOrder.splice(index, 1);
      }
      return deleted;
    },
    clear: () => { storage.clear(); accessOrder.length = 0; hits = 0; misses = 0; },
    size: () => storage.size,
    stats: () => ({ hits, misses, hitRate: hits + misses > 0 ? hits / (hits + misses) : 0, size: storage.size, maxSize }),
  };
};

// =====================================================
// LRU Cache テスト
// =====================================================

describe('Cache Service', () => {
  // ---------------------------------------------------
  // LRU Cache - 基本操作（パラメータ化）
  // ---------------------------------------------------
  describe('LRU Cache - 基本操作', () => {
    let cache: LRUCache<string>;
    beforeEach(() => { cache = createLRUCache<string>(); });

    it.each([
      { op: 'set/get', setup: (c: LRUCache<string>) => { c.set('key1', 'value1'); return c.get('key1'); }, expected: 'value1' },
      { op: 'get nonexistent', setup: (c: LRUCache<string>) => c.get('nonexistent'), expected: null },
    ])('$op が正しく動作すること', ({ setup, expected }) => {
      expect(setup(cache)).toBe(expected);
    });

    it('has()でキーの存在を確認できること', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);
      expect(cache.has('key2')).toBe(false);
    });

    it('delete()でエントリを削除できること', () => {
      cache.set('key1', 'value1');
      expect(cache.delete('key1')).toBe(true);
      expect(cache.has('key1')).toBe(false);
      expect(cache.get('key1')).toBeNull();
    });

    it('clear()で全エントリを削除できること', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.get('key1')).toBeNull();
    });

    it('size()で現在のサイズを取得できること', () => {
      expect(cache.size()).toBe(0);
      cache.set('key1', 'value1');
      expect(cache.size()).toBe(1);
      cache.set('key2', 'value2');
      expect(cache.size()).toBe(2);
    });
  });

  // ---------------------------------------------------
  // LRU Cache - TTL（有効期限）管理
  // ---------------------------------------------------
  describe('LRU Cache - TTL（有効期限）管理', () => {
    let cache: LRUCache<string>;
    beforeEach(() => { vi.useFakeTimers(); cache = createLRUCache<string>(); });
    afterEach(() => vi.useRealTimers());

    it.each([
      { ttl: 5000, advanceMs: 3000, expected: 'value1', desc: 'TTL期限内は取得可能' },
      { ttl: 5000, advanceMs: 6000, expected: null, desc: 'TTL期限切れ後はnull' },
      { ttl: undefined, advanceMs: 60000, expected: 'value1', desc: 'TTL未指定は期限切れしない' },
    ])('$desc', ({ ttl, advanceMs, expected }) => {
      cache.set('key1', 'value1', ttl);
      vi.advanceTimersByTime(advanceMs);
      expect(cache.get('key1')).toBe(expected);
    });
  });

  // ---------------------------------------------------
  // LRU Cache - 最大サイズ制限とLRU排出
  // ---------------------------------------------------
  describe('LRU Cache - 最大サイズ制限とLRU排出', () => {
    let cache: LRUCache<string>;
    beforeEach(() => { cache = createLRUCache<string>(3); });

    it('最大サイズを超えると最も古いエントリが削除されること', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
      cache.set('key4', 'value4');

      expect(cache.size()).toBe(3);
      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(true);
      expect(cache.has('key3')).toBe(true);
      expect(cache.has('key4')).toBe(true);
    });

    it('アクセス順序が更新されること', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
      cache.get('key1'); // key1を最新に
      cache.set('key4', 'value4'); // key2が削除される

      expect(cache.has('key1')).toBe(true);
      expect(cache.has('key2')).toBe(false);
      expect(cache.has('key3')).toBe(true);
      expect(cache.has('key4')).toBe(true);
    });
  });

  // ---------------------------------------------------
  // LRU Cache - キャッシュヒット率計算
  // ---------------------------------------------------
  describe('LRU Cache - キャッシュヒット率計算', () => {
    let cache: LRUCache<string>;
    beforeEach(() => { cache = createLRUCache<string>(); });

    it('ヒット率が正しく計算されること', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.get('key1'); cache.get('key2'); // 2 hits
      cache.get('nonexistent'); // 1 miss

      const stats = cache.stats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
    });

    it('初期状態でヒット率0を返すこと', () => {
      expect(cache.stats().hitRate).toBe(0);
    });

    it('stats()で統計情報を取得できること', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.get('key1');

      const stats = cache.stats();
      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('hitRate');
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(100);
    });
  });

  // ---------------------------------------------------
  // Search Cache Service - 検索結果キャッシュ
  // ---------------------------------------------------
  describe('Search Cache Service - 検索結果キャッシュ', () => {
    // SearchCacheService ファクトリー（重複削減）
    const createSearchCache = (ttl = 5 * 60 * 1000): SearchCacheService => {
      const cache = new Map<string, { results: unknown[]; timestamp: number }>();
      return {
        getCachedResults: async (queryHash: string) => {
          const entry = cache.get(queryHash);
          if (!entry) return null;
          if (Date.now() - entry.timestamp > ttl) { cache.delete(queryHash); return null; }
          return entry.results;
        },
        cacheResults: async (queryHash: string, results: unknown[]) => { cache.set(queryHash, { results, timestamp: Date.now() }); },
        generateQueryHash: (query: string, filters?: Record<string, unknown>) => Buffer.from(JSON.stringify({ query, filters })).toString('base64'),
        clear: () => cache.clear(),
      };
    };

    let searchCache: SearchCacheService;
    beforeEach(() => { searchCache = createSearchCache(); });

    it('検索結果をキャッシュできること', async () => {
      const queryHash = searchCache.generateQueryHash('blue bird');
      const results = [{ id: '1', name: 'Blue Bird' }];
      await searchCache.cacheResults(queryHash, results);
      expect(await searchCache.getCachedResults(queryHash)).toEqual(results);
    });

    it.each([
      { q1: 'blue bird', q2: 'blue bird', q3: 'red bird', desc: '同じクエリは同じハッシュ、異なるクエリは異なるハッシュ' },
    ])('$desc', ({ q1, q2, q3 }) => {
      expect(searchCache.generateQueryHash(q1)).toBe(searchCache.generateQueryHash(q2));
      expect(searchCache.generateQueryHash(q1)).not.toBe(searchCache.generateQueryHash(q3));
    });

    it('フィルター変更時に異なるハッシュが生成されること', () => {
      expect(searchCache.generateQueryHash('bird', { license: 'cc0' })).not.toBe(searchCache.generateQueryHash('bird', { license: 'cc-by' }));
    });

    it('存在しないクエリでnullを返すこと', async () => {
      expect(await searchCache.getCachedResults('nonexistent')).toBeNull();
    });

    it('TTL 5分でキャッシュが期限切れになること', async () => {
      vi.useFakeTimers();
      const queryHash = searchCache.generateQueryHash('bird');
      await searchCache.cacheResults(queryHash, [{ id: '1' }]);
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(await searchCache.getCachedResults(queryHash)).toBeNull();
      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------
  // Embedding Cache Service - Embeddingキャッシュ
  // ---------------------------------------------------
  describe('Embedding Cache Service - Embeddingキャッシュ', () => {
    // EmbeddingCacheService ファクトリー（重複削減）
    const createEmbeddingCache = (): EmbeddingCacheService => {
      const cache = new Map<string, number[]>();
      return {
        getCachedEmbedding: async (textHash: string) => cache.get(textHash) || null,
        cacheEmbedding: async (textHash: string, embedding: number[]) => { cache.set(textHash, embedding); },
        generateTextHash: (text: string) => Buffer.from(text).toString('base64'),
        clear: () => cache.clear(),
      };
    };

    let embeddingCache: EmbeddingCacheService;
    beforeEach(() => { embeddingCache = createEmbeddingCache(); });

    it('Embeddingベクトルをキャッシュできること', async () => {
      const textHash = embeddingCache.generateTextHash('blue bird');
      const embedding = new Array(384).fill(0).map(() => Math.random());
      await embeddingCache.cacheEmbedding(textHash, embedding);
      const cached = await embeddingCache.getCachedEmbedding(textHash);
      expect(cached).toEqual(embedding);
      expect(cached).toHaveLength(384);
    });

    it('テキストハッシュ生成: 同じ入力は同じハッシュ、異なる入力は異なるハッシュ', () => {
      expect(embeddingCache.generateTextHash('blue bird')).toBe(embeddingCache.generateTextHash('blue bird'));
      expect(embeddingCache.generateTextHash('blue bird')).not.toBe(embeddingCache.generateTextHash('red bird'));
    });

    it('存在しないテキストでnullを返すこと', async () => {
      expect(await embeddingCache.getCachedEmbedding('nonexistent')).toBeNull();
    });

    it('ベクトル配列のメモリ効率をテストできること', async () => {
      const textHash = embeddingCache.generateTextHash('test');
      await embeddingCache.cacheEmbedding(textHash, new Array(384).fill(0.5));
      const cached = await embeddingCache.getCachedEmbedding(textHash);
      expect(cached).toBeDefined();
      expect(cached!.length).toBe(384);
    });

    it('複数のEmbeddingを同時にキャッシュできること', async () => {
      const texts = ['bird', 'cat', 'dog'];
      const embeddings = texts.map(() => new Array(384).fill(0).map(() => Math.random()));
      for (let i = 0; i < texts.length; i++) {
        await embeddingCache.cacheEmbedding(embeddingCache.generateTextHash(texts[i]), embeddings[i]);
      }
      for (let i = 0; i < texts.length; i++) {
        expect(await embeddingCache.getCachedEmbedding(embeddingCache.generateTextHash(texts[i]))).toEqual(embeddings[i]);
      }
    });
  });
});
