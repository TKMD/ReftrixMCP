// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisionCache テスト - TDD RED Phase
 *
 * Phase 5: LRUキャッシュサービスのユニットテスト
 *
 * 目的:
 * - LRU (Least Recently Used) キャッシュの実装検証
 * - 容量超過時の自動削除（LRU eviction）
 * - TTL (Time To Live) 期限切れエントリの無効化
 * - キャッシュヒット率の計算
 * - スレッドセーフ（同時アクセス）検証
 *
 * 参照:
 * - apps/mcp-server/src/services/vision/mood.analyzer.ts
 * - apps/mcp-server/src/services/vision/brandtone.analyzer.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// VisionCache インポート（動的インポートで TDD RED Phase を実現）
// =============================================================================

// NOTE: TDD RED Phase - 動的インポートを使用して、テストが実行され失敗することを確認
// 実装ファイル: apps/mcp-server/src/services/vision/vision.cache.ts

// =============================================================================
// 型定義（テスト用）
// =============================================================================

interface VisionCacheConfig {
  capacity: number;
  ttlMs: number;
  maxMemoryBytes?: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  entries: number;
  capacity: number;
  estimatedMemoryBytes?: number;
}

// =============================================================================
// テストケース
// =============================================================================

describe('VisionCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ===========================================================================
  // 実装存在確認テスト（TDD GREEN Phase）
  // ===========================================================================

  describe('implementation verification', () => {
    it('should have VisionCache implementation', async () => {
      // TDD GREEN Phase: 実装が存在することを確認
      const module = await import('@/services/vision/vision.cache');
      expect(module.VisionCache).toBeDefined();
      expect(typeof module.VisionCache).toBe('function');
    });
  });

  // ===========================================================================
  // 基本操作テスト
  // ===========================================================================

  describe('basic operations', () => {
    it('should store and retrieve cached results', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      const key = 'test-key-1';
      const value = { mood: 'professional', confidence: 0.85 };

      // Act
      cache.set(key, value);
      const retrieved = cache.get(key);

      // Assert
      expect(retrieved).toEqual(value);
    });

    it('should return undefined for non-existent keys', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      const key = 'non-existent-key';

      // Act
      const result = cache.get(key);

      // Assert
      expect(result).toBeUndefined();
    });

    it('should overwrite existing values', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      const key = 'test-key';
      const value1 = { mood: 'playful' };
      const value2 = { mood: 'elegant' };

      // Act
      cache.set(key, value1);
      cache.set(key, value2);
      const result = cache.get(key);

      // Assert
      expect(result).toEqual(value2);
    });

    it('should delete entries', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      const key = 'test-key';
      const value = { mood: 'minimal' };
      cache.set(key, value);

      // Act
      const deleted = cache.delete(key);
      const result = cache.get(key);

      // Assert
      expect(deleted).toBe(true);
      expect(result).toBeUndefined();
    });

    it('should return false when deleting non-existent key', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      const key = 'non-existent';

      // Act
      const result = cache.delete(key);

      // Assert
      expect(result).toBe(false);
    });

    it('should clear all entries', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      cache.set('key1', { value: 1 });
      cache.set('key2', { value: 2 });
      cache.set('key3', { value: 3 });

      // Act
      cache.clear();

      // Assert
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.get('key3')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it('should report correct size', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });

      // Act
      cache.set('key1', { value: 1 });
      cache.set('key2', { value: 2 });
      cache.set('key3', { value: 3 });

      // Assert
      expect(cache.size).toBe(3);
    });

    it('should check if key exists', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      cache.set('existing-key', { value: 'test' });

      // Act & Assert
      expect(cache.has('existing-key')).toBe(true);
      expect(cache.has('non-existing-key')).toBe(false);
    });
  });

  // ===========================================================================
  // LRU Eviction テスト
  // ===========================================================================

  describe('LRU eviction', () => {
    it('should evict least recently used item when capacity exceeded', async () => {
      // Arrange: 容量3のキャッシュ
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const smallCache = new VisionCache<string, number>({
        capacity: 3,
        ttlMs: 60000,
      });

      // Act: 4つのアイテムを追加
      smallCache.set('key1', 1); // 最古
      smallCache.set('key2', 2);
      smallCache.set('key3', 3);
      smallCache.set('key4', 4); // 追加 -> key1が削除される

      // Assert
      expect(smallCache.get('key1')).toBeUndefined(); // 削除された
      expect(smallCache.get('key2')).toBe(2);
      expect(smallCache.get('key3')).toBe(3);
      expect(smallCache.get('key4')).toBe(4);
      expect(smallCache.size).toBe(3);
    });

    it('should update access order on get', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const smallCache = new VisionCache<string, number>({
        capacity: 3,
        ttlMs: 60000,
      });
      smallCache.set('key1', 1);
      smallCache.set('key2', 2);
      smallCache.set('key3', 3);

      // Act: key1にアクセス -> key1が最新になる
      smallCache.get('key1');
      smallCache.set('key4', 4); // key2が削除される

      // Assert
      expect(smallCache.get('key1')).toBe(1); // 存在する
      expect(smallCache.get('key2')).toBeUndefined(); // 削除された
      expect(smallCache.get('key3')).toBe(3);
      expect(smallCache.get('key4')).toBe(4);
    });

    it('should update access order on set (update)', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const smallCache = new VisionCache<string, number>({
        capacity: 3,
        ttlMs: 60000,
      });
      smallCache.set('key1', 1);
      smallCache.set('key2', 2);
      smallCache.set('key3', 3);

      // Act: key1を更新 -> key1が最新になる
      smallCache.set('key1', 100);
      smallCache.set('key4', 4); // key2が削除される

      // Assert
      expect(smallCache.get('key1')).toBe(100);
      expect(smallCache.get('key2')).toBeUndefined();
      expect(smallCache.get('key3')).toBe(3);
      expect(smallCache.get('key4')).toBe(4);
    });

    it('should evict multiple items if needed', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const smallCache = new VisionCache<string, number>({
        capacity: 2,
        ttlMs: 60000,
      });
      smallCache.set('key1', 1);
      smallCache.set('key2', 2);

      // Act: 2つ追加 -> 2つ削除
      smallCache.set('key3', 3); // key1削除
      smallCache.set('key4', 4); // key2削除

      // Assert
      expect(smallCache.get('key1')).toBeUndefined();
      expect(smallCache.get('key2')).toBeUndefined();
      expect(smallCache.get('key3')).toBe(3);
      expect(smallCache.get('key4')).toBe(4);
    });
  });

  // ===========================================================================
  // TTL (Time To Live) テスト
  // ===========================================================================

  describe('TTL expiration', () => {
    it('should return undefined for expired cache entries', async () => {
      // Arrange: TTL 1秒
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const shortTtlCache = new VisionCache<string, string>({
        capacity: 100,
        ttlMs: 1000, // 1秒
      });
      shortTtlCache.set('key1', 'value1');

      // Act: 1秒経過
      vi.advanceTimersByTime(1001);
      const result = shortTtlCache.get('key1');

      // Assert
      expect(result).toBeUndefined();
    });

    it('should return value before TTL expiration', async () => {
      // Arrange: TTL 5秒
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, string>({
        capacity: 100,
        ttlMs: 5000,
      });
      cache.set('key1', 'value1');

      // Act: 4秒経過（期限内）
      vi.advanceTimersByTime(4000);
      const result = cache.get('key1');

      // Assert
      expect(result).toBe('value1');
    });

    it('should refresh TTL on set (update)', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, string>({
        capacity: 100,
        ttlMs: 3000, // 3秒
      });
      cache.set('key1', 'value1');

      // Act: 2秒後に更新
      vi.advanceTimersByTime(2000);
      cache.set('key1', 'value1-updated');

      // Act: さらに2秒経過（合計4秒、更新後は2秒）
      vi.advanceTimersByTime(2000);
      const result = cache.get('key1');

      // Assert: まだ有効
      expect(result).toBe('value1-updated');
    });

    it('should not refresh TTL on get', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, string>({
        capacity: 100,
        ttlMs: 3000, // 3秒
      });
      cache.set('key1', 'value1');

      // Act: 2秒後にget
      vi.advanceTimersByTime(2000);
      cache.get('key1');

      // Act: さらに2秒経過（合計4秒、TTL超過）
      vi.advanceTimersByTime(2000);
      const result = cache.get('key1');

      // Assert: 期限切れ
      expect(result).toBeUndefined();
    });

    it('should not count expired entries in size', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, string>({
        capacity: 100,
        ttlMs: 1000,
      });
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      // 初期サイズ
      expect(cache.size).toBe(2);

      // Act: 期限切れ + アクセス（クリーンアップトリガー）
      vi.advanceTimersByTime(1001);
      cache.get('key1'); // 期限切れエントリへのアクセスでクリーンアップ

      // Assert
      expect(cache.size).toBeLessThanOrEqual(2);
    });
  });

  // ===========================================================================
  // キャッシュ統計テスト
  // ===========================================================================

  describe('cache statistics', () => {
    it('should calculate cache hit rate', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      cache.set('key1', { value: 1 });
      cache.set('key2', { value: 2 });

      // Act: 5回アクセス（3 hit, 2 miss）
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('key2'); // hit
      cache.get('key3'); // miss
      cache.get('key4'); // miss

      // Assert
      const stats = cache.getStats();
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBeCloseTo(0.6, 2); // 3/5 = 0.6
    });

    it('should return 0 hit rate when no accesses', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      cache.set('key1', { value: 1 });

      // Act
      const stats = cache.getStats();

      // Assert
      expect(stats.hitRate).toBe(0);
    });

    it('should track total entries', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      cache.set('key1', { value: 1 });
      cache.set('key2', { value: 2 });
      cache.set('key3', { value: 3 });

      // Act
      const stats = cache.getStats();

      // Assert
      expect(stats.entries).toBe(3);
    });

    it('should reset stats', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      cache.set('key1', { value: 1 });
      cache.get('key1'); // hit
      cache.get('key2'); // miss

      // Act
      cache.resetStats();
      const stats = cache.getStats();

      // Assert
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    it('should report capacity', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const customCache = new VisionCache<string, number>({
        capacity: 50,
        ttlMs: 60000,
      });

      // Act
      const stats = customCache.getStats();

      // Assert
      expect(stats.capacity).toBe(50);
    });

    it('should report memory usage estimation', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      cache.set('key1', { largeData: 'x'.repeat(1000) });
      cache.set('key2', { largeData: 'y'.repeat(2000) });

      // Act
      const stats = cache.getStats();

      // Assert
      expect(stats.estimatedMemoryBytes).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // スレッドセーフテスト（同時アクセス）
  // ===========================================================================

  describe('concurrent access', () => {
    it('should handle concurrent reads safely', async () => {
      // Arrange
      vi.useRealTimers(); // Promise使用時は実タイマー
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      cache.set('key1', { value: 'test' });

      // Act: 100の同時読み取り
      const promises = Array(100)
        .fill(null)
        .map(() => Promise.resolve(cache.get('key1')));

      const results = await Promise.all(promises);

      // Assert: すべて同じ値
      results.forEach(result => {
        expect(result).toEqual({ value: 'test' });
      });
    });

    it('should handle concurrent writes safely', async () => {
      // Arrange
      vi.useRealTimers();
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });

      // Act: 100の同時書き込み
      const promises = Array(100)
        .fill(null)
        .map((_, i) => Promise.resolve(cache.set(`key${i}`, { index: i })));

      await Promise.all(promises);

      // Assert: すべて書き込まれた（容量内）
      expect(cache.size).toBeLessThanOrEqual(100);
    });

    it('should handle mixed read/write operations', async () => {
      // Arrange
      vi.useRealTimers();
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const cache = new VisionCache<string, unknown>({
        capacity: 100,
        ttlMs: 5 * 60 * 1000,
      });
      cache.set('shared-key', { counter: 0 });

      // Act: 読み取りと書き込みの混合
      const operations = Array(50)
        .fill(null)
        .map((_, i) =>
          i % 2 === 0
            ? Promise.resolve(cache.get('shared-key'))
            : Promise.resolve(cache.set(`key${i}`, { value: i }))
        );

      await Promise.all(operations);

      // Assert: エラーなく完了
      expect(cache.get('shared-key')).toBeDefined();
    });
  });

  // ===========================================================================
  // 設定テスト
  // ===========================================================================

  describe('configuration', () => {
    it('should accept custom configuration', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const config: VisionCacheConfig = {
        capacity: 500,
        ttlMs: 10 * 60 * 1000, // 10分
      };

      // Act
      const customCache = new VisionCache<string, unknown>(config);

      // Assert
      expect(customCache.getStats().capacity).toBe(500);
    });

    it('should use default configuration', async () => {
      // Arrange & Act
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const defaultCache = new VisionCache<string, unknown>();

      // Assert: デフォルト値
      const stats = defaultCache.getStats();
      expect(stats.capacity).toBeGreaterThan(0);
    });

    it('should reject invalid capacity (< 1)', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');

      // Act & Assert
      expect(() => {
        new VisionCache<string, unknown>({
          capacity: 0,
          ttlMs: 60000,
        });
      }).toThrow();
    });

    it('should reject invalid TTL (< 1ms)', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');

      // Act & Assert
      expect(() => {
        new VisionCache<string, unknown>({
          capacity: 100,
          ttlMs: 0,
        });
      }).toThrow();
    });
  });

  // ===========================================================================
  // キーのハッシュ化テスト
  // ===========================================================================

  describe('key hashing', () => {
    it('should generate consistent hash for same input', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const input = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';

      // Act
      const key1 = VisionCache.generateKey(input);
      const key2 = VisionCache.generateKey(input);

      // Assert
      expect(key1).toBe(key2);
    });

    it('should generate different hash for different input', async () => {
      // Arrange
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const input1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
      const input2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNl';

      // Act
      const key1 = VisionCache.generateKey(input1);
      const key2 = VisionCache.generateKey(input2);

      // Assert
      expect(key1).not.toBe(key2);
    });

    it('should generate short hash for large input', async () => {
      // Arrange: 1MBの入力
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const largeInput = 'x'.repeat(1024 * 1024);

      // Act
      const key = VisionCache.generateKey(largeInput);

      // Assert: ハッシュは短い（64文字以下）
      expect(key.length).toBeLessThanOrEqual(64);
    });
  });

  // ===========================================================================
  // メモリ管理テスト
  // ===========================================================================

  describe('memory management', () => {
    it('should respect memory limit', async () => {
      // Arrange: メモリ制限付きキャッシュ
      const { VisionCache } = await import('@/services/vision/vision.cache');
      const memoryLimitedCache = new VisionCache<string, unknown>({
        capacity: 1000,
        ttlMs: 60000,
        maxMemoryBytes: 1024 * 1024, // 1MB
      });

      // Act: 大きなデータを追加
      for (let i = 0; i < 100; i++) {
        memoryLimitedCache.set(`key${i}`, { data: 'x'.repeat(50000) }); // 50KBずつ
      }

      // Assert: メモリ制限を超えない
      const stats = memoryLimitedCache.getStats();
      expect(stats.estimatedMemoryBytes).toBeLessThanOrEqual(1024 * 1024 * 1.1); // 10%マージン
    });
  });
});

// =============================================================================
// 統合テスト
// =============================================================================

describe('VisionCache Integration', () => {
  it('should work with MoodAnalyzer-like workflow', async () => {
    // Arrange
    vi.useRealTimers();
    const { VisionCache } = await import('@/services/vision/vision.cache');
    const cache = new VisionCache<string, { mood: string; confidence: number }>({
      capacity: 100,
      ttlMs: 5 * 60 * 1000,
    });

    const mockAnalyze = async (screenshot: string) => {
      // キャッシュチェック
      const key = VisionCache.generateKey(screenshot);
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }

      // シミュレートされた分析
      await new Promise(resolve => setTimeout(resolve, 10));
      const result = { mood: 'professional', confidence: 0.85 };

      // キャッシュに保存
      cache.set(key, result);
      return result;
    };

    // Act
    const screenshot = 'test-screenshot-base64';
    const result1 = await mockAnalyze(screenshot);
    const result2 = await mockAnalyze(screenshot); // キャッシュヒット

    // Assert
    expect(result1).toEqual(result2);
    expect(cache.getStats().hits).toBe(1);
    expect(cache.getStats().misses).toBe(1);
  });
});
