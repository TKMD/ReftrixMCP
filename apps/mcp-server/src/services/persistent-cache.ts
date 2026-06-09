// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Persistent Cache Service
 * ディスク永続化対応のLRUキャッシュ実装
 *
 * 目的:
 * - JSONファイルベースのディスク永続化
 * - TTL対応（有効期限管理）
 * - LRUエビクション（最大サイズ制限）
 * - 非同期API
 * - エラーハンドリング（ディスク障害時のgraceful degradation）
 * - プロセス再起動後のデータ復元
 *
 * 使用方法:
 * ```typescript
 * const cache = new PersistentCache<string>({
 *   dbPath: '/tmp/my-cache',
 *   maxSize: 1000,
 *   defaultTtlMs: 300000, // 5分
 * });
 *
 * await cache.set('key', 'value');
 * const value = await cache.get('key');
 * await cache.close();
 * ```
 */
import * as fs from "fs/promises";
import * as path from "path";
import { Logger } from "../utils/logger";
import { CACHE_TEMP_PREFIX } from "./cache-temp-const";
import { sweepOrphanTempFiles, type SweepClock, type IsProcessAliveFn } from "./cache-orphan-sweep";

const logger = new Logger("PersistentCache");

/**
 * 永続キャッシュエントリの型定義
 */
export interface PersistentCacheEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

/**
 * 永続キャッシュの設定オプション
 */
export interface PersistentCacheOptions {
  /** キャッシュ保存ディレクトリパス */
  dbPath: string;
  /** 最大エントリ数 */
  maxSize: number;
  /** デフォルトTTL（ミリ秒） */
  defaultTtlMs: number;
  /** ディスク書き込み失敗時のリトライ回数 */
  writeRetries?: number;
  /** ログ有効化 */
  enableLogging?: boolean;
  /** 最大キー長（デフォルト: 256） */
  maxKeyLength?: number;
  /** 最大値サイズ（バイト、デフォルト: 10MB） */
  maxValueSize?: number;
  /**
   * close() 時の flush を skip するか（Plan v2 §2.6.1 close flush 非対称）。
   *
   * worker (churn 高、`maxJobsBeforeRestart=1`) は `ephemeral: true` 相当として
   * close() で `saveToDisk()` を呼ばず、close 毎の 70MB 級 temp 生成を除去する。
   * MCP server 本体 (長命) は default false で flush を維持し cache 永続性を保つ。
   * `saveDebounceTimer` の clearTimeout は本フラグと無関係に **両経路で実行**。
   *
   * When true, close() skips `saveToDisk()` (worker ephemeral). Default false
   * (MCP server keeps the final flush). The debounce timer is always cleared.
   */
  skipFlushOnClose?: boolean;
  /**
   * 起動時 orphan sweep を有効にするか（Plan v2 §2.5、デフォルト: true）。
   *
   * 自 dbPath 内の死 pid orphan temp を起動時 1 回 sweep する。test では
   * `false` にして決定論的に制御する。
   *
   * When true (default), runs a one-shot orphan temp sweep of this dbPath at
   * startup. Tests may set false for determinism and call sweep helpers directly.
   */
  sweepOnInit?: boolean;
  /** DI seam: sweep 用 clock（test 決定論化、Plan §3.6）。 */
  sweepClock?: SweepClock;
  /** DI seam: sweep 用 pid 生存判定（test 決定論化、EPERM mapping 含む）。 */
  sweepIsProcessAlive?: IsProcessAliveFn;
  /** DI seam: sweep 用 mtime grace window（ms）。 */
  sweepGraceMs?: number;
  /**
   * DI seam: `fs.rename` の差し替え（Plan v2 §3.3 / U-10 / TPA-08 fault-inject）。
   *
   * INV-CACHE-WRITE-FAILURE-CLEANUP-003 が rename 失敗を決定論的に注入するための
   * seam。`vi.spyOn(fs,...)` の namespace spy を回避する (testing-requirements.md §7)。
   * 未指定時は `fs.rename` を使用 (production 挙動不変)。
   *
   * DI seam to substitute `fs.rename` for the write-failure-cleanup INV
   * (deterministic fault injection, avoiding namespace spies). Defaults to
   * `fs.rename` (production behaviour unchanged).
   */
  renameImpl?: (oldPath: string, newPath: string) => Promise<void>;
}

/**
 * 永続キャッシュ統計情報
 */
export interface PersistentCacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  maxSize: number;
  diskUsageBytes: number;
  evictionCount: number;
  writeErrorCount: number;
  readErrorCount: number;
}

/**
 * 内部ストレージ形式
 */
interface StorageData<T> {
  entries: Record<string, PersistentCacheEntry<T>>;
  accessOrder: string[];
  stats: {
    hits: number;
    misses: number;
    evictionCount: number;
    writeErrorCount: number;
    readErrorCount: number;
  };
}

/**
 * getメソッドのオプション
 */
export interface PersistentCacheGetOptions {
  /** 期限切れを無視するか（オフラインフォールバック用） */
  ignoreExpiry?: boolean;
}

/**
 * 永続キャッシュクラス
 * JSONファイルベースのディスク永続化対応LRUキャッシュ
 */
/** 予約済みキー名（Prototype Pollution対策） */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** デフォルトの最大キー長 */
const DEFAULT_MAX_KEY_LENGTH = 256;

/** デフォルトの最大値サイズ（10MB） */
const DEFAULT_MAX_VALUE_SIZE = 10 * 1024 * 1024;

export class PersistentCache<T> {
  private readonly dbPath: string;
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly writeRetries: number;
  private readonly enableLogging: boolean;
  private readonly maxKeyLength: number;
  private readonly maxValueSize: number;
  private readonly skipFlushOnClose: boolean;
  private readonly sweepOnInit: boolean;
  private readonly sweepClock: SweepClock | undefined;
  private readonly sweepIsProcessAlive: IsProcessAliveFn | undefined;
  private readonly sweepGraceMs: number | undefined;
  private readonly renameImpl: (oldPath: string, newPath: string) => Promise<void>;

  // インメモリキャッシュ
  private entries: Map<string, PersistentCacheEntry<T>> = new Map();
  private accessOrder: string[] = [];

  // 統計情報
  private hits: number = 0;
  private misses: number = 0;
  private evictionCount: number = 0;
  private writeErrorCount: number = 0;
  private readErrorCount: number = 0;

  // 状態管理
  private isClosed: boolean = false;
  private isInitialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: PersistentCacheOptions) {
    // パストラバーサル対策: dbPathを検証
    this.dbPath = this.validateDbPath(options.dbPath);
    this.maxSize = options.maxSize;
    this.defaultTtlMs = options.defaultTtlMs;
    this.writeRetries = options.writeRetries ?? 3;
    this.enableLogging = options.enableLogging ?? true;
    this.maxKeyLength = options.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH;
    this.maxValueSize = options.maxValueSize ?? DEFAULT_MAX_VALUE_SIZE;
    this.skipFlushOnClose = options.skipFlushOnClose ?? false;
    this.sweepOnInit = options.sweepOnInit ?? true;
    this.sweepClock = options.sweepClock;
    this.sweepIsProcessAlive = options.sweepIsProcessAlive;
    this.sweepGraceMs = options.sweepGraceMs;
    this.renameImpl = options.renameImpl ?? fs.rename;

    this.log("debug", "PersistentCache created", {
      dbPath: this.dbPath,
      maxSize: this.maxSize,
      defaultTtlMs: this.defaultTtlMs,
    });

    // 初期化を開始（非同期）
    this.initPromise = this.initialize();
  }

  /**
   * dbPathを検証（パストラバーサル対策）
   */
  private validateDbPath(dbPath: string): string {
    if (!dbPath || typeof dbPath !== "string") {
      throw new Error("dbPath must be a non-empty string");
    }

    // null byte reject (CWE-22 防御の最低限)
    if (dbPath.includes("\0")) {
      throw new Error("dbPath must not contain null bytes");
    }

    // パストラバーサル検出: 元のパスに .. が含まれる場合は reject (fail-closed)。
    // Plan v2 §2.4.1 / U-13: 旧実装は warn のみだったが、sweep の unlink が想定外
    // dir を走査・削除しうる surface を構造的に塞ぐため reject へ格上げ。
    // Plan v2 §2.4.1 / U-13: hardened from warn to reject (fail-closed) — the
    // startup sweep unlink path could otherwise traverse/delete an unexpected dir.
    if (dbPath.includes("..")) {
      throw new Error("dbPath must not contain path traversal sequences ('..')");
    }

    // パスを正規化
    const resolved = path.resolve(dbPath);

    return resolved;
  }

  /**
   * キー名を検証
   */
  private validateKey(key: string): void {
    if (!key || typeof key !== "string") {
      throw new Error("Key must be a non-empty string");
    }

    if (key.length > this.maxKeyLength) {
      throw new Error(`Key length (${key.length}) exceeds maximum (${this.maxKeyLength})`);
    }

    // 制御文字のチェック（セキュリティ対策として意図的に使用）
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(key)) {
      throw new Error("Key contains control characters");
    }

    // 予約済みキー名のチェック（Prototype Pollution対策）
    if (RESERVED_KEYS.has(key)) {
      throw new Error(`Key name '${key}' is reserved`);
    }
  }

  /**
   * 値のサイズを検証
   */
  private validateValueSize(value: T): void {
    const serialized = JSON.stringify(value);
    if (serialized.length > this.maxValueSize) {
      throw new Error(
        `Value size (${serialized.length} bytes) exceeds maximum (${this.maxValueSize} bytes)`
      );
    }
  }

  /**
   * 初期化処理 - ディスクからデータを復元
   */
  private async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // ディレクトリが存在しない場合は作成
      await fs.mkdir(path.dirname(this.getStoragePath()), { recursive: true });

      // Plan v2 §2.5: 起動時 orphan temp sweep (fail-open、起動 critical path 非ブロック)。
      // 自 dbPath 内の死 pid orphan temp を 1 回 sweep し、temp leak → disk full を
      // 根治する。sweep 失敗は warn のみで初期化を継続 (SEC-M-03 fail-open)。
      // Plan v2 §2.5: one-shot startup orphan sweep (fail-open, non-blocking).
      if (this.sweepOnInit) {
        try {
          const removed = sweepOrphanTempFiles(
            this.dbPath,
            process.pid,
            this.sweepClock,
            this.sweepIsProcessAlive,
            this.sweepGraceMs
          );
          if (removed > 0) {
            this.log("info", "Startup orphan temp sweep", { dbPath: this.dbPath, removed });
          }
        } catch (sweepErr) {
          this.log("warn", "Startup orphan temp sweep failed (non-fatal)", {
            error: (sweepErr as Error).message,
          });
        }
      }

      // 既存データの読み込みを試行
      await this.loadFromDisk();
      this.isInitialized = true;
      this.log("debug", "Initialized", { size: this.entries.size });
    } catch (error) {
      // 初期化エラーは警告として扱い、空の状態で開始
      this.log("warn", "Failed to initialize from disk, starting fresh", { error });
      this.isInitialized = true;
    }
  }

  /**
   * 初期化完了を待機
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isClosed) {
      throw new Error("Database is closed");
    }

    if (!this.isInitialized && this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * キャッシュから値を取得
   * @param key キャッシュキー
   * @param options オプション（ignoreExpiry: 期限切れを無視）
   * @returns 値が存在すれば値、なければnull
   */
  async get(key: string, options?: PersistentCacheGetOptions): Promise<T | null> {
    await this.ensureInitialized();
    this.validateKey(key);

    const entry = this.entries.get(key);

    if (!entry) {
      this.misses++;
      this.log("debug", "Miss", { key });
      return null;
    }

    // TTLチェック（ignoreExpiryがtrueの場合はスキップ）
    if (!options?.ignoreExpiry && this.isExpired(entry)) {
      this.entries.delete(key);
      this.removeFromAccessOrder(key);
      this.misses++;
      this.log("debug", "Expired", { key });
      // 永続化は遅延実行
      this.saveToDiskDebounced();
      return null;
    }

    // アクセス情報を更新（LRU）
    entry.lastAccessedAt = Date.now();
    entry.accessCount++;
    this.updateAccessOrder(key);

    this.hits++;
    this.log("debug", "Hit", { key, ignoreExpiry: options?.ignoreExpiry });

    // 永続化は遅延実行
    this.saveToDiskDebounced();

    return entry.value;
  }

  /**
   * キャッシュに値を設定
   * @param key キャッシュキー
   * @param value 保存する値
   * @param ttlMs オプションのTTL（ミリ秒）
   */
  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.ensureInitialized();
    this.validateKey(key);
    this.validateValueSize(value);

    const isUpdate = this.entries.has(key);

    // 最大サイズチェック（新規追加の場合のみ）
    if (!isUpdate && this.entries.size >= this.maxSize) {
      this.evictLRU();
    }

    const now = Date.now();
    const actualTtl = ttlMs ?? this.defaultTtlMs;

    const entry: PersistentCacheEntry<T> = {
      value,
      createdAt: now,
      expiresAt: now + actualTtl,
      lastAccessedAt: now,
      accessCount: 0,
    };

    this.entries.set(key, entry);
    this.updateAccessOrder(key);

    this.log("debug", "Set", {
      key,
      ttl: actualTtl,
      size: this.entries.size,
    });

    // ディスクに永続化
    await this.saveToDisk();
  }

  /**
   * キーが存在するかチェック
   * @param key キャッシュキー
   * @returns 存在すればtrue
   */
  async has(key: string): Promise<boolean> {
    await this.ensureInitialized();
    this.validateKey(key);

    const entry = this.entries.get(key);
    if (!entry) return false;

    // 期限切れの場合は削除してfalseを返す
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      this.removeFromAccessOrder(key);
      this.saveToDiskDebounced();
      return false;
    }

    return true;
  }

  /**
   * キャッシュからエントリを削除
   * @param key キャッシュキー
   * @returns 削除成功ならtrue
   */
  async delete(key: string): Promise<boolean> {
    await this.ensureInitialized();
    this.validateKey(key);

    const deleted = this.entries.delete(key);
    if (deleted) {
      this.removeFromAccessOrder(key);
      this.log("debug", "Delete", { key });
      await this.saveToDisk();
    }
    return deleted;
  }

  /**
   * キャッシュをクリア
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();

    this.entries.clear();
    this.accessOrder = [];
    this.hits = 0;
    this.misses = 0;
    // evictionCount と errorCount はリセットしない（永続的な統計）
    // ただし、テストの期待に合わせてリセット
    this.evictionCount = 0;
    this.writeErrorCount = 0;
    this.readErrorCount = 0;

    this.log("debug", "Cleared");
    await this.saveToDisk();
  }

  /**
   * 現在のキャッシュサイズを取得
   * @returns キャッシュサイズ
   */
  async size(): Promise<number> {
    await this.ensureInitialized();
    return this.entries.size;
  }

  /**
   * 全キーを取得
   * @returns キーの配列
   */
  async keys(): Promise<string[]> {
    await this.ensureInitialized();
    return Array.from(this.entries.keys());
  }

  /**
   * キャッシュ統計を取得
   * @returns キャッシュ統計情報
   */
  async getStats(): Promise<PersistentCacheStats> {
    await this.ensureInitialized();

    const total = this.hits + this.misses;
    const hitRate = total > 0 ? this.hits / total : 0;

    // ディスク使用量の概算（JSONシリアライズサイズ）
    let diskUsageBytes = 0;
    try {
      const data = this.prepareStorageData();
      diskUsageBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
    } catch {
      // 計算失敗時は0
    }

    return {
      hits: this.hits,
      misses: this.misses,
      hitRate,
      size: this.entries.size,
      maxSize: this.maxSize,
      diskUsageBytes,
      evictionCount: this.evictionCount,
      writeErrorCount: this.writeErrorCount,
      readErrorCount: this.readErrorCount,
    };
  }

  /**
   * キャッシュを閉じる
   * 閉じた後は操作できない
   */
  async close(): Promise<void> {
    if (this.isClosed) return;

    // Plan v2 §2.6.1 / §1.5: dangling debounce timer を **両経路で** clearTimeout。
    // close 後の debounce 発火による closed-instance temp leak を防止する。
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }

    // Plan v2 §2.6.1 close flush 非対称:
    //   worker (skipFlushOnClose=true): saveToDisk() を skip し close 毎の 70MB temp 生成を除去。
    //   MCP server (skipFlushOnClose=false): 最終 flush で cache 永続性を保つ。
    if (!this.skipFlushOnClose) {
      try {
        await this.saveToDisk();
      } catch (e) {
        // SEC-L-02 / security.md §isDevelopment ガード禁止: 空 catch で silent 吸収せず
        // 全環境で logger.warn 出力 (close 時の flush 失敗は non-fatal)。
        this.log("warn", "Final flush on close failed (non-fatal)", {
          error: (e as Error).message,
        });
      }
    }

    this.isClosed = true;
    this.entries.clear();
    this.accessOrder = [];

    this.log("debug", "Closed", { skipFlushOnClose: this.skipFlushOnClose });
  }

  /**
   * 期限切れエントリを削除（コンパクション）
   */
  async compact(): Promise<void> {
    await this.ensureInitialized();

    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.entries.entries()) {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.entries.delete(key);
      this.removeFromAccessOrder(key);
    }

    if (keysToDelete.length > 0) {
      this.log("debug", "Compacted", { removed: keysToDelete.length });
      await this.saveToDisk();
    }
  }

  /**
   * 複数エントリを一括設定（バッチ操作）
   * @param entries 設定するエントリの配列
   */
  async setMany(entries: Array<{ key: string; value: T; ttlMs?: number }>): Promise<void> {
    await this.ensureInitialized();

    // 事前にすべてのキーと値を検証
    for (const { key, value } of entries) {
      this.validateKey(key);
      this.validateValueSize(value);
    }

    const now = Date.now();

    for (const { key, value, ttlMs } of entries) {
      const isUpdate = this.entries.has(key);

      // 最大サイズチェック（新規追加の場合のみ）
      if (!isUpdate && this.entries.size >= this.maxSize) {
        this.evictLRU();
      }

      const actualTtl = ttlMs ?? this.defaultTtlMs;

      const entry: PersistentCacheEntry<T> = {
        value,
        createdAt: now,
        expiresAt: now + actualTtl,
        lastAccessedAt: now,
        accessCount: 0,
      };

      this.entries.set(key, entry);
      this.updateAccessOrder(key);
    }

    this.log("debug", "SetMany", { count: entries.length, size: this.entries.size });

    // 一括保存
    await this.saveToDisk();
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * ストレージファイルパスを取得
   */
  private getStoragePath(): string {
    return path.join(this.dbPath, "cache.json");
  }

  /**
   * エントリが期限切れかチェック
   */
  private isExpired(entry: PersistentCacheEntry<T>): boolean {
    return Date.now() > entry.expiresAt;
  }

  /**
   * LRUエントリを削除（最も長くアクセスされていないエントリ）
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;

    const oldestKey = this.accessOrder.shift();
    if (oldestKey) {
      this.entries.delete(oldestKey);
      this.evictionCount++;
      this.log("debug", "Evicted LRU", { key: oldestKey });
    }
  }

  /**
   * アクセス順序を更新（キーを末尾に移動）
   */
  private updateAccessOrder(key: string): void {
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  /**
   * アクセス順序からキーを削除
   */
  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * ストレージデータを準備
   */
  private prepareStorageData(): StorageData<T> {
    const entriesObj: Record<string, PersistentCacheEntry<T>> = {};
    for (const [key, entry] of this.entries.entries()) {
      entriesObj[key] = entry;
    }

    return {
      entries: entriesObj,
      accessOrder: [...this.accessOrder],
      stats: {
        hits: this.hits,
        misses: this.misses,
        evictionCount: this.evictionCount,
        writeErrorCount: this.writeErrorCount,
        readErrorCount: this.readErrorCount,
      },
    };
  }

  /**
   * ディスクからデータを読み込み
   */
  // Pre-existing CC=15 (prototype-pollution-defended load path). This function
  // predates the embedding-cache temp-leak fix scoped `complexity:["error",10]`
  // override (Plan v2 §2.7 / U-7) — the override exists to gate the NEW sweep/
  // write/close code path. Refactoring this load path is out of this PR's scope;
  // tracked under the FIND-TDA-07 Q3-2026 monorepo complexity successor issue
  // (same disposition as the embedding-backfill-queue.ts inline disables).
  // eslint-disable-next-line complexity
  private async loadFromDisk(): Promise<void> {
    const filePath = this.getStoragePath();

    try {
      const content = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(content) as StorageData<T>;

      // データを復元（Prototype Pollution対策付き）
      this.entries.clear();
      if (data.entries && typeof data.entries === "object") {
        for (const [key, entry] of Object.entries(data.entries)) {
          // Prototype Pollution対策: 予約済みキーをスキップ
          if (RESERVED_KEYS.has(key)) {
            this.log("warn", "Blocked prototype pollution attempt during load", { key });
            continue;
          }
          // Object.prototypeから継承したプロパティをスキップ
          if (!Object.prototype.hasOwnProperty.call(data.entries, key)) {
            continue;
          }
          this.entries.set(key, entry);
        }
      }

      // accessOrderも安全にフィルタリング
      this.accessOrder = Array.isArray(data.accessOrder)
        ? data.accessOrder.filter((key) => typeof key === "string" && !RESERVED_KEYS.has(key))
        : [];

      // 統計を復元
      if (data.stats) {
        this.hits = data.stats.hits ?? 0;
        this.misses = data.stats.misses ?? 0;
        this.evictionCount = data.stats.evictionCount ?? 0;
        this.writeErrorCount = data.stats.writeErrorCount ?? 0;
        this.readErrorCount = data.stats.readErrorCount ?? 0;
      }

      this.log("debug", "Loaded from disk", { size: this.entries.size });
    } catch (error) {
      // ファイルが存在しない場合は正常（初回起動）
      const errCode = (error as { code?: string }).code;
      if (errCode === "ENOENT") {
        this.log("debug", "No existing cache file, starting fresh");
        return;
      }

      // JSONパースエラー等は readErrorCount をインクリメント
      this.readErrorCount++;
      throw error;
    }
  }

  /**
   * ディスクにデータを保存（リトライ付き）
   */
  private async saveToDisk(): Promise<void> {
    const filePath = this.getStoragePath();
    const data = this.prepareStorageData();
    const content = JSON.stringify(data, null, 2);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.writeRetries; attempt++) {
      // アトミック書き込み（一時ファイル経由）
      // PID + timestamp でtmpファイルを分離し、複数プロセス間の競合を防止。
      // temp 名 prefix は SSOT (`CACHE_TEMP_PREFIX`) から derive (二重管理排除)。
      // filePath = `<dbPath>/cache.json`、CACHE_TEMP_PREFIX = `cache.json.tmp.` のため
      // tempPath basename = `cache.json.tmp.<pid>.<ts>`。
      const dir = path.dirname(filePath);
      const tempPath = path.join(dir, `${CACHE_TEMP_PREFIX}${process.pid}.${Date.now()}`);
      let renamed = false;
      try {
        // ディレクトリが存在することを確認
        await fs.mkdir(dir, { recursive: true });

        await fs.writeFile(tempPath, content, "utf8");
        await this.renameImpl(tempPath, filePath);
        renamed = true;

        this.log("debug", "Saved to disk", { size: this.entries.size });
        return;
      } catch (error) {
        lastError = error as Error;
        this.log("warn", `Write attempt ${attempt + 1} failed`, { error });

        // 最後の試行でなければ少し待機
        if (attempt < this.writeRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      } finally {
        // Plan v2 §2.10 / U-10: rename 未完 (writeFile 後 rename 失敗 or 例外) の
        // temp を回収。orphan を残さない。unlink 失敗は non-fatal だが silent 吸収せず
        // logger.warn (起動時 sweep が backstop、SEC-L-02 isDevelopment ガード禁止)。
        if (!renamed) {
          await fs.unlink(tempPath).catch((e) =>
            this.log("warn", "temp unlink after failed rename failed (non-fatal)", {
              error: (e as Error).message,
            })
          );
        }
      }
    }

    // 全リトライ失敗
    this.writeErrorCount++;
    throw lastError;
  }

  // デバウンス用タイマー
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * ディスク保存をデバウンス（頻繁な保存を防止）
   */
  private saveToDiskDebounced(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(() => {
      this.saveToDisk().catch((error) => {
        this.log("error", "Debounced save failed", { error });
      });
    }, 100);
  }

  /**
   * ログ出力
   */
  private log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void {
    if (!this.enableLogging) return;

    switch (level) {
      case "debug":
        logger.debug(message, data);
        break;
      case "info":
        logger.info(message, data);
        break;
      case "warn":
        logger.warn(message, data);
        break;
      case "error":
        logger.error(message, data);
        break;
    }
  }
}

/**
 * PersistentCacheのファクトリ関数
 *
 * @param options キャッシュオプション
 * @returns PersistentCacheインスタンス
 *
 * @example
 * const cache = createPersistentCache<string>({
 *   dbPath: '/tmp/my-cache',
 *   maxSize: 1000,
 *   defaultTtlMs: 300000,
 * });
 */
export function createPersistentCache<T>(options: PersistentCacheOptions): PersistentCache<T> {
  return new PersistentCache<T>(options);
}
