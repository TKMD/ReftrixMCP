// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisionCache - LRUキャッシュ + TTL機能
 *
 * Phase 5: Vision AI分析結果のキャッシュサービス
 *
 * 機能:
 * - LRU (Least Recently Used) eviction
 * - TTL (Time To Live) 期限切れ
 * - SHA256キー生成
 * - キャッシュ統計（ヒット率等）
 * - スレッドセーフ（同期的操作）
 *
 * 参照:
 * - apps/mcp-server/src/services/vision/mood.analyzer.ts
 * - apps/mcp-server/src/services/vision/brandtone.analyzer.ts
 */

import crypto from 'crypto';

// =============================================================================
// 型定義
// =============================================================================

/**
 * VisionCacheの設定インターフェース
 */
export interface VisionCacheConfig {
  /** キャッシュ容量（エントリ数） */
  capacity: number;
  /** TTL（ミリ秒） */
  ttlMs: number;
  /** 最大メモリ使用量（バイト、オプション） */
  maxMemoryBytes?: number | undefined;
}

/**
 * キャッシュ統計情報
 */
export interface CacheStats {
  /** キャッシュヒット数 */
  hits: number;
  /** キャッシュミス数 */
  misses: number;
  /** ヒット率（0-1） */
  hitRate: number;
  /** 現在のエントリ数 */
  entries: number;
  /** 最大容量 */
  capacity: number;
  /** 推定メモリ使用量（バイト） */
  estimatedMemoryBytes: number;
}

/**
 * キャッシュエントリの内部構造
 */
interface CacheEntry<V> {
  value: V;
  createdAt: number;
  lastAccessedAt: number;
}

// =============================================================================
// VisionCache クラス
// =============================================================================

/**
 * LRUキャッシュ + TTL機能を持つVision AI分析結果用キャッシュ
 *
 * @template K - キーの型
 * @template V - 値の型
 */
export class VisionCache<K extends string = string, V = unknown> {
  private readonly cache: Map<K, CacheEntry<V>> = new Map();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly maxMemoryBytes: number | undefined;

  private hits = 0;
  private misses = 0;

  /**
   * デフォルト設定
   */
  private static readonly DEFAULT_CONFIG: VisionCacheConfig = {
    capacity: 100,
    ttlMs: 5 * 60 * 1000, // 5分
  };

  /**
   * VisionCacheのコンストラクタ
   *
   * @param config - キャッシュ設定（省略時はデフォルト値を使用）
   * @throws Error - 無効な設定値が指定された場合
   */
  constructor(config?: Partial<VisionCacheConfig>) {
    const mergedConfig = { ...VisionCache.DEFAULT_CONFIG, ...config };

    // バリデーション
    if (mergedConfig.capacity < 1) {
      throw new Error('Invalid capacity: must be >= 1');
    }
    if (mergedConfig.ttlMs < 1) {
      throw new Error('Invalid TTL: must be >= 1ms');
    }

    this.capacity = mergedConfig.capacity;
    this.ttlMs = mergedConfig.ttlMs;
    this.maxMemoryBytes = mergedConfig.maxMemoryBytes;
  }

  // ===========================================================================
  // 静的メソッド
  // ===========================================================================

  /**
   * 入力データからキャッシュキーを生成（SHA256ハッシュ）
   *
   * @param input - ハッシュ化する入力データ
   * @returns SHA256ハッシュ値（64文字）
   */
  static generateKey(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  // ===========================================================================
  // パブリックメソッド
  // ===========================================================================

  /**
   * キャッシュからエントリを取得
   *
   * @param key - キャッシュキー
   * @returns キャッシュされた値、存在しないか期限切れの場合はundefined
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // TTLチェック
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // LRU: アクセス順序を更新（Map順序も更新）
    entry.lastAccessedAt = Date.now();
    // Mapの挿入順序を更新するために再挿入
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  /**
   * キャッシュにエントリを設定
   *
   * @param key - キャッシュキー
   * @param value - キャッシュする値
   */
  set(key: K, value: V): void {
    const now = Date.now();

    // 既存エントリがある場合は更新（TTLもリフレッシュ）
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      if (entry) {
        entry.value = value;
        entry.createdAt = now;
        entry.lastAccessedAt = now;
        // LRU: 順序を最新に更新（Map.delete + set）
        this.cache.delete(key);
        this.cache.set(key, entry);
      }
      return;
    }

    // 容量チェック - LRU eviction
    if (this.cache.size >= this.capacity) {
      this.evictLRU();
    }

    // メモリ制限チェック
    if (this.maxMemoryBytes) {
      this.enforceMemoryLimit();
    }

    // 新規エントリを追加
    this.cache.set(key, {
      value,
      createdAt: now,
      lastAccessedAt: now,
    });
  }

  /**
   * キャッシュからエントリを削除
   *
   * @param key - キャッシュキー
   * @returns 削除に成功した場合はtrue
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * キャッシュをクリア
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * キーが存在するかチェック（期限切れも考慮）
   *
   * @param key - キャッシュキー
   * @returns キーが存在し、期限内であればtrue
   */
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 現在のキャッシュサイズ（エントリ数）
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * キャッシュ統計を取得
   *
   * @returns キャッシュ統計情報
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      entries: this.cache.size,
      capacity: this.capacity,
      estimatedMemoryBytes: this.estimateMemoryUsage(),
    };
  }

  /**
   * 統計をリセット
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * エントリが期限切れかチェック
   */
  private isExpired(entry: CacheEntry<V>): boolean {
    return Date.now() - entry.createdAt > this.ttlMs;
  }

  /**
   * LRU（最も古くアクセスされたエントリ）を削除
   * MapはES6の仕様で挿入順序を保持するため、最初のエントリが最も古い
   */
  private evictLRU(): void {
    // Mapの最初のエントリを取得（最も古いアクセス順）
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      this.cache.delete(firstKey);
    }
  }

  /**
   * メモリ使用量を推定
   */
  private estimateMemoryUsage(): number {
    let totalBytes = 0;

    for (const [key, entry] of this.cache) {
      // キーのサイズ
      totalBytes += key.length * 2; // UTF-16

      // 値のサイズ（JSON文字列化して推定）
      try {
        const valueStr = JSON.stringify(entry.value);
        totalBytes += valueStr.length * 2;
      } catch {
        // JSON化できない場合は固定サイズを加算
        totalBytes += 1024;
      }

      // エントリメタデータ（タイムスタンプ等）
      totalBytes += 24; // 3 * 8 bytes (numbers)
    }

    return totalBytes;
  }

  /**
   * メモリ制限を強制（制限を超えた場合はLRU削除）
   */
  private enforceMemoryLimit(): void {
    if (!this.maxMemoryBytes) {
      return;
    }

    while (
      this.cache.size > 0 &&
      this.estimateMemoryUsage() > this.maxMemoryBytes
    ) {
      this.evictLRU();
    }
  }
}
