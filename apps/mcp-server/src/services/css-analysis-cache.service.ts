// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS Analysis Cache Service
 *
 * layout.inspect/motion.detect の CSS解析結果をキャッシュするサービス。
 * URLハッシュまたはコンテンツハッシュをキーとしてPersistentCacheに保存。
 *
 * 目的:
 * - 同一URL/HTMLの再解析を防止（コスト削減）
 * - キャッシュヒット率の監視
 * - system.health への統合報告
 *
 * 使用方法:
 * ```typescript
 * const cacheService = await createCSSAnalysisCacheService({
 *   cacheDir: '/tmp/reftrix-css-cache',
 *   maxSize: 5000,
 *   defaultTtlMs: 3600000, // 1時間
 * });
 *
 * const key = cacheService.generateCacheKey({ url: 'https://example.com' });
 * await cacheService.setLayoutInspectResult(key, result);
 * const cached = await cacheService.getLayoutInspectResult(key);
 * ```
 *
 * @module services/css-analysis-cache.service
 */

import * as crypto from 'crypto';
import type { PersistentCache } from './persistent-cache';
import { createPersistentCache } from './persistent-cache';
import { Logger } from '../utils/logger';

const logger = new Logger('CSSAnalysisCache');

// ============================================================
// 型定義
// ============================================================

/**
 * CSS解析結果の型（layout.inspect出力の一部）
 */
export interface CSSAnalysisResult {
  colors: {
    palette: string[];
    dominant?: string;
    background?: string;
    text?: string;
  };
  typography: {
    fonts: string[];
    baseSize?: string;
    scale?: number[];
  };
  grid: {
    type: 'flex' | 'grid' | 'float' | 'none';
    columns?: number;
    gap?: string;
    maxWidth?: number;
  };
  sections: Array<{
    type: string;
    confidence: number;
    /** セクションコンテンツ（v0.1.0で追加: キャッシュ復元時のcontent空配列バグ修正） */
    content?: {
      headings: Array<{ level: number; text: string }>;
      paragraphs: string[];
      links: Array<{ href: string; text: string }>;
      images: Array<{ src: string; alt?: string }>;
      buttons: Array<{ text: string; type: string }>;
    };
  }>;
  analyzedAt: number;
  cacheKey: string;
}

/**
 * Motion解析結果の型（motion.detect出力の一部）
 */
export interface MotionAnalysisResult {
  patterns: Array<{
    type: string;
    name: string;
    duration?: number;
    easing?: string;
  }>;
  summary: {
    totalPatterns: number;
    hasAnimations: boolean;
    hasTransitions: boolean;
  };
  analyzedAt: number;
  cacheKey: string;
}

/**
 * CSS解析キャッシュ統計
 */
export interface CSSAnalysisCacheStats {
  layoutInspect: {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
  };
  motionDetect: {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
  };
  totalHits: number;
  totalMisses: number;
  totalHitRate: number;
  totalSize: number;
  maxSize: number;
  diskUsageBytes: number;
}

/**
 * CSS解析キャッシュサービスオプション
 */
export interface CSSAnalysisCacheOptions {
  /** キャッシュ保存ディレクトリ */
  cacheDir: string;
  /** 最大エントリ数（layoutとmotionの合計） */
  maxSize?: number;
  /** デフォルトTTL（ミリ秒） */
  defaultTtlMs?: number;
  /** ログ有効化 */
  enableLogging?: boolean;
}

/**
 * CSS解析キャッシュサービスインターフェース
 */
export interface ICSSAnalysisCacheService {
  // layout.inspect キャッシュ
  getLayoutInspectResult: (key: string) => Promise<CSSAnalysisResult | null>;
  setLayoutInspectResult: (key: string, result: CSSAnalysisResult, ttlMs?: number) => Promise<void>;

  // motion.detect キャッシュ
  getMotionDetectResult: (key: string) => Promise<MotionAnalysisResult | null>;
  setMotionDetectResult: (key: string, result: MotionAnalysisResult, ttlMs?: number) => Promise<void>;

  // ユーティリティ
  generateCacheKey: (input: string | { url?: string; html?: string }) => string;
  invalidate: (key: string) => Promise<boolean>;
  clear: () => Promise<void>;
  getStats: () => Promise<CSSAnalysisCacheStats>;
  close: () => Promise<void>;
}

// ============================================================
// 定数
// ============================================================

/** デフォルトの最大エントリ数 */
const DEFAULT_MAX_SIZE = 5000;

/** デフォルトTTL（1時間） */
const DEFAULT_TTL_MS = 3600000;

/** キャッシュキープレフィックス */
const LAYOUT_PREFIX = 'layout:';
const MOTION_PREFIX = 'motion:';

// ============================================================
// CSSAnalysisCacheService 実装
// ============================================================

/**
 * CSS Analysis Cache Service
 *
 * PersistentCacheを使用してlayout.inspect/motion.detectの解析結果をキャッシュ
 */
export class CSSAnalysisCacheService implements ICSSAnalysisCacheService {
  private readonly layoutCache: PersistentCache<CSSAnalysisResult>;
  private readonly motionCache: PersistentCache<MotionAnalysisResult>;
  private readonly defaultTtlMs: number;
  private readonly maxSize: number;
  private readonly enableLogging: boolean;

  // 統計情報（PersistentCacheから取得するが、getを呼び出すたびにカウント）
  private layoutHits = 0;
  private layoutMisses = 0;
  private motionHits = 0;
  private motionMisses = 0;

  private isClosed = false;

  constructor(options: CSSAnalysisCacheOptions) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.enableLogging = options.enableLogging ?? true;

    // layout.inspect用キャッシュ
    this.layoutCache = createPersistentCache<CSSAnalysisResult>({
      dbPath: `${options.cacheDir}/layout`,
      maxSize: Math.floor(this.maxSize / 2),
      defaultTtlMs: this.defaultTtlMs,
      enableLogging: this.enableLogging,
    });

    // motion.detect用キャッシュ
    this.motionCache = createPersistentCache<MotionAnalysisResult>({
      dbPath: `${options.cacheDir}/motion`,
      maxSize: Math.floor(this.maxSize / 2),
      defaultTtlMs: this.defaultTtlMs,
      enableLogging: this.enableLogging,
    });

    this.log('debug', 'CSSAnalysisCacheService created', {
      cacheDir: options.cacheDir,
      maxSize: this.maxSize,
      defaultTtlMs: this.defaultTtlMs,
    });
  }

  /**
   * キャッシュキーを生成
   *
   * URL/HTMLからSHA-256ハッシュベースのキーを生成。
   * - URL入力: `url:<sha256>`
   * - HTML入力: `html:<sha256>`
   * - 文字列入力: HTMLとして扱う
   *
   * @param input URL、HTML、または両方を含むオブジェクト
   * @returns キャッシュキー
   * @throws URL/HTMLが空の場合にエラー
   */
  generateCacheKey(input: string | { url?: string; html?: string }): string {
    if (typeof input === 'string') {
      if (!input) {
        throw new Error('HTML must be a non-empty string');
      }
      return `html:${this.sha256(input)}`;
    }

    // URLが指定されていればURLを優先
    if (input.url !== undefined) {
      if (!input.url) {
        throw new Error('URL must be a non-empty string');
      }
      return `url:${this.sha256(input.url)}`;
    }

    // HTMLが指定されていればHTMLを使用
    if (input.html !== undefined) {
      if (!input.html) {
        throw new Error('HTML must be a non-empty string');
      }
      return `html:${this.sha256(input.html)}`;
    }

    throw new Error('Either url or html must be provided');
  }

  /**
   * layout.inspect結果を取得
   *
   * @param key キャッシュキー
   * @returns キャッシュされた結果、またはnull
   */
  async getLayoutInspectResult(key: string): Promise<CSSAnalysisResult | null> {
    this.ensureNotClosed();

    const internalKey = `${LAYOUT_PREFIX}${key}`;
    const result = await this.layoutCache.get(internalKey);

    if (result) {
      this.layoutHits++;
      this.log('debug', 'Layout cache hit', { key });
    } else {
      this.layoutMisses++;
      this.log('debug', 'Layout cache miss', { key });
    }

    return result;
  }

  /**
   * layout.inspect結果を保存
   *
   * @param key キャッシュキー
   * @param result 解析結果
   * @param ttlMs オプションのTTL（ミリ秒）
   */
  async setLayoutInspectResult(
    key: string,
    result: CSSAnalysisResult,
    ttlMs?: number
  ): Promise<void> {
    this.ensureNotClosed();

    const internalKey = `${LAYOUT_PREFIX}${key}`;
    await this.layoutCache.set(internalKey, result, ttlMs);

    this.log('debug', 'Layout cache set', { key, ttlMs: ttlMs ?? this.defaultTtlMs });
  }

  /**
   * motion.detect結果を取得
   *
   * @param key キャッシュキー
   * @returns キャッシュされた結果、またはnull
   */
  async getMotionDetectResult(key: string): Promise<MotionAnalysisResult | null> {
    this.ensureNotClosed();

    const internalKey = `${MOTION_PREFIX}${key}`;
    const result = await this.motionCache.get(internalKey);

    if (result) {
      this.motionHits++;
      this.log('debug', 'Motion cache hit', { key });
    } else {
      this.motionMisses++;
      this.log('debug', 'Motion cache miss', { key });
    }

    return result;
  }

  /**
   * motion.detect結果を保存
   *
   * @param key キャッシュキー
   * @param result 解析結果
   * @param ttlMs オプションのTTL（ミリ秒）
   */
  async setMotionDetectResult(
    key: string,
    result: MotionAnalysisResult,
    ttlMs?: number
  ): Promise<void> {
    this.ensureNotClosed();

    const internalKey = `${MOTION_PREFIX}${key}`;
    await this.motionCache.set(internalKey, result, ttlMs);

    this.log('debug', 'Motion cache set', { key, ttlMs: ttlMs ?? this.defaultTtlMs });
  }

  /**
   * 指定キーのキャッシュを無効化
   *
   * layout.inspectとmotion.detectの両方のキャッシュから削除
   *
   * @param key キャッシュキー
   * @returns いずれかのキャッシュから削除されたらtrue
   */
  async invalidate(key: string): Promise<boolean> {
    this.ensureNotClosed();

    const layoutKey = `${LAYOUT_PREFIX}${key}`;
    const motionKey = `${MOTION_PREFIX}${key}`;

    const layoutDeleted = await this.layoutCache.delete(layoutKey);
    const motionDeleted = await this.motionCache.delete(motionKey);

    const deleted = layoutDeleted || motionDeleted;
    this.log('debug', 'Cache invalidated', { key, layoutDeleted, motionDeleted });

    return deleted;
  }

  /**
   * 全キャッシュをクリア
   */
  async clear(): Promise<void> {
    this.ensureNotClosed();

    await this.layoutCache.clear();
    await this.motionCache.clear();

    // 統計もリセット
    this.layoutHits = 0;
    this.layoutMisses = 0;
    this.motionHits = 0;
    this.motionMisses = 0;

    this.log('debug', 'All caches cleared');
  }

  /**
   * キャッシュ統計を取得
   *
   * @returns キャッシュ統計情報（system.health統合用）
   */
  async getStats(): Promise<CSSAnalysisCacheStats> {
    const layoutStats = await this.layoutCache.getStats();
    const motionStats = await this.motionCache.getStats();

    const layoutTotal = this.layoutHits + this.layoutMisses;
    const motionTotal = this.motionHits + this.motionMisses;
    const totalHits = this.layoutHits + this.motionHits;
    const totalMisses = this.layoutMisses + this.motionMisses;
    const total = totalHits + totalMisses;

    return {
      layoutInspect: {
        hits: this.layoutHits,
        misses: this.layoutMisses,
        hitRate: layoutTotal > 0 ? this.layoutHits / layoutTotal : 0,
        size: layoutStats.size,
      },
      motionDetect: {
        hits: this.motionHits,
        misses: this.motionMisses,
        hitRate: motionTotal > 0 ? this.motionHits / motionTotal : 0,
        size: motionStats.size,
      },
      totalHits,
      totalMisses,
      totalHitRate: total > 0 ? totalHits / total : 0,
      totalSize: layoutStats.size + motionStats.size,
      maxSize: this.maxSize,
      diskUsageBytes: layoutStats.diskUsageBytes + motionStats.diskUsageBytes,
    };
  }

  /**
   * キャッシュサービスを閉じる
   *
   * 閉じた後は操作できない
   */
  async close(): Promise<void> {
    if (this.isClosed) return;

    await this.layoutCache.close();
    await this.motionCache.close();

    this.isClosed = true;
    this.log('debug', 'CSSAnalysisCacheService closed');
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * SHA-256ハッシュを生成
   */
  private sha256(input: string): string {
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
  }

  /**
   * サービスが閉じられていないことを確認
   */
  private ensureNotClosed(): void {
    if (this.isClosed) {
      throw new Error('CSSAnalysisCacheService is closed');
    }
  }

  /**
   * ログ出力
   */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    if (!this.enableLogging) return;

    switch (level) {
      case 'debug':
        logger.debug(message, data);
        break;
      case 'info':
        logger.info(message, data);
        break;
      case 'warn':
        logger.warn(message, data);
        break;
      case 'error':
        logger.error(message, data);
        break;
    }
  }
}

// ============================================================
// ファクトリ関数
// ============================================================

/**
 * CSSAnalysisCacheServiceを作成
 *
 * @param options キャッシュオプション
 * @returns CSSAnalysisCacheServiceインスタンス
 *
 * @example
 * const cacheService = createCSSAnalysisCacheService({
 *   cacheDir: '/tmp/reftrix-css-cache',
 *   maxSize: 5000,
 *   defaultTtlMs: 3600000,
 * });
 */
export function createCSSAnalysisCacheService(
  options: CSSAnalysisCacheOptions
): CSSAnalysisCacheService {
  return new CSSAnalysisCacheService(options);
}

// ============================================================
// シングルトンインスタンス（グローバルアクセス用）
// ============================================================

let globalInstance: CSSAnalysisCacheService | null = null;

/**
 * グローバルCSSAnalysisCacheServiceインスタンスを取得
 *
 * 初回呼び出し時にインスタンスを作成。
 * 環境変数 CSS_ANALYSIS_CACHE_DIR でキャッシュディレクトリを設定可能。
 *
 * @returns CSSAnalysisCacheServiceインスタンス
 */
export function getCSSAnalysisCacheService(): CSSAnalysisCacheService {
  if (!globalInstance) {
    const cacheDir = process.env.CSS_ANALYSIS_CACHE_DIR ?? '/tmp/reftrix-css-analysis-cache';

    globalInstance = createCSSAnalysisCacheService({
      cacheDir,
      maxSize: parseInt(process.env.CSS_ANALYSIS_CACHE_MAX_SIZE ?? '5000', 10),
      defaultTtlMs: parseInt(process.env.CSS_ANALYSIS_CACHE_TTL_MS ?? '3600000', 10),
      enableLogging: process.env.NODE_ENV === 'development',
    });
  }

  return globalInstance;
}

/**
 * グローバルインスタンスをリセット（テスト用）
 */
export async function resetCSSAnalysisCacheService(): Promise<void> {
  if (globalInstance) {
    await globalInstance.close();
    globalInstance = null;
  }
}
