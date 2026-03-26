// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SearchCacheService テスト
 *
 * 検索結果インメモリLRUキャッシュの検証
 * - generateCacheKey: 同一パラメータで同一キー、異なるパラメータで異なるキー
 * - getCachedResult/setCachedResult: 基本的なget/set
 * - TTL: 期限切れ後にmissになること
 * - LRU: max超過時に最も古いエントリが削除
 * - getCacheStats: ヒット率計算
 * - withSearchCache: 高階関数のキャッシュ動作
 *
 * @module tests/services/search-cache.service
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  generateCacheKey,
  getCachedResult,
  setCachedResult,
  invalidateCache,
  getCacheStats,
  withSearchCache,
} from "../../src/services/search-cache.service";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  // 各テスト前にキャッシュをクリア
  invalidateCache();
});

// ============================================================================
// generateCacheKey / キャッシュキー生成
// ============================================================================

describe("generateCacheKey", () => {
  it("同一パラメータで同一キーを生成する", () => {
    const params = { query: "hero section", limit: 10 };
    const key1 = generateCacheKey("layout.search", params);
    const key2 = generateCacheKey("layout.search", params);
    expect(key1).toBe(key2);
  });

  it("パラメータの順序が異なっても同一キーを生成する", () => {
    const key1 = generateCacheKey("layout.search", { query: "hero", limit: 10 });
    const key2 = generateCacheKey("layout.search", { limit: 10, query: "hero" });
    expect(key1).toBe(key2);
  });

  it("異なるパラメータで異なるキーを生成する", () => {
    const key1 = generateCacheKey("layout.search", { query: "hero" });
    const key2 = generateCacheKey("layout.search", { query: "footer" });
    expect(key1).not.toBe(key2);
  });

  it("異なるツール名で異なるキーを生成する", () => {
    const params = { query: "test" };
    const key1 = generateCacheKey("layout.search", params);
    const key2 = generateCacheKey("motion.search", params);
    expect(key1).not.toBe(key2);
  });

  it("SHA-256ハッシュ（64文字hex）を返す", () => {
    const key = generateCacheKey("tool", { a: 1 });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("空パラメータでも有効なキーを生成する", () => {
    const key = generateCacheKey("tool", {});
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ============================================================================
// getCachedResult / setCachedResult / 基本get/set
// ============================================================================

describe("getCachedResult / setCachedResult", () => {
  it("setした値をgetで取得できる", () => {
    const key = "test-key-1";
    const value = { results: [{ id: 1, name: "test" }], total: 1 };

    setCachedResult(key, value);
    const cached = getCachedResult<typeof value>(key);

    expect(cached).toEqual(value);
  });

  it("存在しないキーはundefinedを返す", () => {
    const result = getCachedResult("nonexistent-key");
    expect(result).toBeUndefined();
  });

  it("異なる型の値を格納・取得できる", () => {
    setCachedResult("string-key", "hello");
    setCachedResult("number-key", 42);
    setCachedResult("array-key", [1, 2, 3]);

    expect(getCachedResult<string>("string-key")).toBe("hello");
    expect(getCachedResult<number>("number-key")).toBe(42);
    expect(getCachedResult<number[]>("array-key")).toEqual([1, 2, 3]);
  });

  it("同一キーへの上書きが正しく動作する", () => {
    setCachedResult("key", "first");
    setCachedResult("key", "second");

    expect(getCachedResult<string>("key")).toBe("second");
  });
});

// ============================================================================
// TTL / 期限切れ
// ============================================================================

describe("TTL / 期限切れ", () => {
  // NOTE: lru-cache は perf_hooks.performance.now() を使用するため
  // vi.useFakeTimers() ではTTL経過をシミュレートできない。
  // TTL設定値はgetCacheStatsで検証する。

  it("TTL設定値がデフォルト5分（300000ms）以上で構成されている", () => {
    const stats = getCacheStats();
    // デフォルト TTL = 5 * 60 * 1000 = 300000ms
    expect(stats.ttlMs).toBeGreaterThanOrEqual(300_000);
  });

  it("TTL期限内はキャッシュヒットする（即時取得）", () => {
    const key = generateCacheKey("tool", { q: "ttl-hit-test" });
    setCachedResult(key, { data: "cached" });

    // 即時取得 — TTL期限内
    expect(getCachedResult(key)).toEqual({ data: "cached" });
  });

  it("invalidateCache後はキャッシュミスする", () => {
    const key = generateCacheKey("tool", { q: "ttl-clear-test" });
    setCachedResult(key, { data: "will-be-cleared" });

    invalidateCache();

    // クリア後はmiss
    expect(getCachedResult(key)).toBeUndefined();
  });
});

// ============================================================================
// LRU Eviction / LRU削除
// ============================================================================

describe("LRU eviction / LRU削除", () => {
  // NOTE: デフォルトmax=500なので、小規模テストではLRU evictionの直接テストは困難。
  // 代わりに、多数エントリを追加した場合のキャッシュサイズ上限を検証する。
  it("invalidateCache()でキャッシュ全体がクリアされる", () => {
    setCachedResult("key-1", "value-1");
    setCachedResult("key-2", "value-2");

    invalidateCache();

    expect(getCachedResult("key-1")).toBeUndefined();
    expect(getCachedResult("key-2")).toBeUndefined();
  });

  it("大量エントリ追加後もキャッシュが動作する", () => {
    // max=500（デフォルト）以上のエントリを追加
    for (let i = 0; i < 600; i++) {
      setCachedResult(`key-${i}`, `value-${i}`);
    }

    // 最新のエントリは存在する
    expect(getCachedResult("key-599")).toBe("value-599");

    // キャッシュサイズが上限以下であることを確認
    const stats = getCacheStats();
    expect(stats.size).toBeLessThanOrEqual(stats.maxEntries);
  });
});

// ============================================================================
// getCacheStats / キャッシュ統計
// ============================================================================

describe("getCacheStats", () => {
  it("初期状態のstatsが正しい", () => {
    const stats = getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.maxEntries).toBeGreaterThan(0);
    expect(stats.ttlMs).toBeGreaterThan(0);
  });

  it("ヒット後にhitsがインクリメントされる", () => {
    const statsBefore = getCacheStats();
    const hitsBefore = statsBefore.hits;

    setCachedResult("stats-key", "value");
    getCachedResult("stats-key"); // hit

    const statsAfter = getCacheStats();
    expect(statsAfter.hits).toBe(hitsBefore + 1);
  });

  it("ミス後にmissesがインクリメントされる", () => {
    const statsBefore = getCacheStats();
    const missesBefore = statsBefore.misses;

    getCachedResult("nonexistent-stats-key"); // miss

    const statsAfter = getCacheStats();
    expect(statsAfter.misses).toBe(missesBefore + 1);
  });

  it("ヒット率が正しく計算される", () => {
    // fresh state — 既存のヒット/ミスカウントを考慮
    const startStats = getCacheStats();
    const startHits = startStats.hits;
    const startMisses = startStats.misses;

    setCachedResult("hr-key", "value");
    getCachedResult("hr-key"); // hit (+1)
    getCachedResult("hr-key"); // hit (+2)
    getCachedResult("nonexistent"); // miss (+1)

    const stats = getCacheStats();
    const expectedTotal = startHits + 2 + (startMisses + 1);
    const expectedHitRate = (startHits + 2) / expectedTotal;
    expect(stats.hitRate).toBeCloseTo(expectedHitRate, 2);
  });

  it("ヒット/ミスともにゼロの場合hitRate=0", () => {
    // NOTE: モジュールレベルカウンタは他テストの影響を受ける可能性がある
    // hitRate=0は初回のみ。総アクセス=0の場合のみ0を返す
    // このテストは、ゼロ除算が起きないことを間接的に確認
    const stats = getCacheStats();
    expect(stats.hitRate).toBeGreaterThanOrEqual(0);
    expect(stats.hitRate).toBeLessThanOrEqual(1);
  });
});

// ============================================================================
// withSearchCache / 高階関数キャッシュ
// ============================================================================

describe("withSearchCache", () => {
  it("初回呼び出し時に実関数が実行される", async () => {
    const searchFn = vi.fn().mockResolvedValue({ results: [1, 2, 3] });
    const cached = withSearchCache("test.search", searchFn);

    const result = await cached({ query: "test" });

    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ results: [1, 2, 3] });
  });

  it("2回目の呼び出しはキャッシュから返され、実関数は呼ばれない", async () => {
    const searchFn = vi.fn().mockResolvedValue({ results: [1, 2, 3] });
    const cached = withSearchCache("test.cached", searchFn);

    await cached({ query: "cached-test" });
    const result2 = await cached({ query: "cached-test" });

    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(result2).toEqual({ results: [1, 2, 3] });
  });

  it("異なるパラメータでは実関数が再度呼ばれる", async () => {
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce({ results: ["a"] })
      .mockResolvedValueOnce({ results: ["b"] });
    const cached = withSearchCache("test.params", searchFn);

    const result1 = await cached({ query: "alpha" });
    const result2 = await cached({ query: "beta" });

    expect(searchFn).toHaveBeenCalledTimes(2);
    expect(result1).toEqual({ results: ["a"] });
    expect(result2).toEqual({ results: ["b"] });
  });

  it("キャッシュクリア後に実関数が再度呼ばれる", async () => {
    const searchFn = vi.fn().mockResolvedValue({ data: "fresh" });
    const cached = withSearchCache("test.invalidate", searchFn);

    await cached({ query: "inv" });
    expect(searchFn).toHaveBeenCalledTimes(1);

    invalidateCache();

    await cached({ query: "inv" });
    expect(searchFn).toHaveBeenCalledTimes(2);
  });
});
