// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rate Limiter Middleware - Token Bucket Algorithm
 *
 * MCPツール呼び出しにToken Bucketベースのレート制限を適用（CWE-770 DoS対策）
 * Redis永続化対応。Redis未接続時はインメモリフォールバックで動作継続。
 *
 * Applies Token Bucket rate limiting to MCP tool calls (CWE-770 DoS mitigation).
 * Supports Redis persistence with graceful in-memory fallback when Redis is unavailable.
 *
 * @module middleware/rate-limiter
 */

import type Redis from "ioredis";
import { getRedisClient } from "../config/redis";
import { logger } from "../utils/logger";

/**
 * Token Bucket の状態（インメモリ用）
 */
interface TokenBucket {
  /** 現在のトークン数 */
  tokens: number;
  /** 最後にトークンが補充された時刻（ms） */
  lastRefillTime: number;
}

/**
 * レート制限カテゴリの設定
 */
export interface RateLimitTierConfig {
  /** 1分あたりの最大リクエスト数 (RPM) */
  maxRequestsPerMinute: number;
  /** バーストサイズ上限（トークンバケットの最大容量） */
  maxBurst: number;
}

/**
 * レート制限チェック結果
 */
export interface RateLimitResult {
  /** リクエストが許可されるか */
  allowed: boolean;
  /** 次にリクエスト可能になるまでの待機時間（ms）。allowedがtrueの場合はundefined */
  retryAfterMs?: number;
  /** 残りトークン数 */
  remaining: number;
  /** トークンバケットの最大容量 */
  limit: number;
}

/**
 * レート制限ティア名
 */
export type RateLimitTier = "default" | "analysis" | "search";

/**
 * ティアごとのデフォルト設定
 *
 * - default: 60 RPM（一般ツール）
 * - analysis: 10 RPM（重い分析系ツール）
 * - search: 120 RPM（軽い検索系ツール）
 */
export const DEFAULT_TIER_CONFIGS: Record<RateLimitTier, RateLimitTierConfig> = {
  default: { maxRequestsPerMinute: 60, maxBurst: 60 },
  analysis: { maxRequestsPerMinute: 10, maxBurst: 10 },
  search: { maxRequestsPerMinute: 120, maxBurst: 120 },
};

/**
 * ツール名→ティアのマッピング
 * 未登録のツールは "default" ティアを使用
 */
export const TOOL_TIER_MAP: Record<string, RateLimitTier> = {
  // 分析系（重い処理、10 RPM）
  "page.analyze": "analysis",
  "layout.ingest": "analysis",
  "layout.batch_ingest": "analysis",
  "quality.batch_evaluate": "analysis",
  // 検索系（軽い処理、120 RPM）
  "layout.search": "search",
  "motion.search": "search",
  "narrative.search": "search",
  "background.search": "search",
  "responsive.search": "search",
  "part.search": "search",
  "search.unified": "search",
  "design.search_by_image": "search",
};

/** Redis key prefix for rate limiter buckets */
const REDIS_KEY_PREFIX = "reftrix:ratelimit:";

/** Redis key TTL in seconds (2x the 1-minute refill window) */
const REDIS_KEY_TTL_SECONDS = 120;

/** Minimum interval between Redis retry attempts after failure (ms) */
const REDIS_RETRY_INTERVAL_MS = 5000;

/**
 * Lua script for atomic Token Bucket operation on Redis
 *
 * Performs refill + consume in a single atomic operation.
 * KEYS[1] = bucket key (e.g., "reftrix:ratelimit:analysis")
 * ARGV[1] = maxBurst (number)
 * ARGV[2] = tokensPerMs (number as string)
 * ARGV[3] = now (ms timestamp)
 * ARGV[4] = ttl (seconds)
 *
 * Returns: [allowed (0|1), remaining, maxBurst, retryAfterMs]
 */
const TOKEN_BUCKET_LUA_SCRIPT = `
local key = KEYS[1]
local max_burst = tonumber(ARGV[1])
local tokens_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local current = redis.call('HMGET', key, 'tokens', 'lastRefillTime')
local tokens = tonumber(current[1])
local last_refill = tonumber(current[2])

if tokens == nil or last_refill == nil then
  tokens = max_burst
  last_refill = now
end

local elapsed = now - last_refill
if elapsed > 0 then
  tokens = math.min(max_burst, tokens + elapsed * tokens_per_ms)
  last_refill = now
end

local allowed
local remaining
local retry_after_ms = 0

if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
  remaining = math.floor(tokens)
else
  allowed = 0
  remaining = 0
  if tokens_per_ms > 0 then
    retry_after_ms = math.ceil((1 - tokens) / tokens_per_ms)
  else
    retry_after_ms = 60000
  end
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefillTime', tostring(last_refill))
redis.call('EXPIRE', key, ttl)

return {allowed, remaining, max_burst, retry_after_ms}
`;

/**
 * SEC: 環境変数パース時のNaN/Infinity防御付き整数パーサー
 *
 * @param value - パースする文字列
 * @param defaultValue - パース失敗時のデフォルト値
 * @param min - 最小値（下限クランプ）
 * @param max - 最大値（上限クランプ）
 * @returns パース結果（有限整数、範囲内にクランプ済み）
 */
function safeParseInt(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(min, Math.min(max, parsed));
}

/**
 * レート制限が有効かどうかを判定
 *
 * 環境変数 `RATE_LIMIT_ENABLED` で制御（デフォルト: true）
 * "false", "0", "no" でのみ無効化
 */
export function isRateLimitEnabled(): boolean {
  const value = process.env.RATE_LIMIT_ENABLED;
  if (value === undefined || value === "") {
    return true; // デフォルト有効
  }
  return !["false", "0", "no"].includes(value.toLowerCase());
}

/**
 * 環境変数からデフォルトRPMを読み取り、ティア設定を構築
 */
function buildTierConfigs(): Record<RateLimitTier, RateLimitTierConfig> {
  const envRpm = process.env.RATE_LIMIT_RPM;
  if (envRpm === undefined || envRpm === "") {
    return { ...DEFAULT_TIER_CONFIGS };
  }

  // SEC: NaN/Infinity防御。1〜10000の範囲にクランプ
  const customDefault = safeParseInt(
    envRpm,
    DEFAULT_TIER_CONFIGS.default.maxRequestsPerMinute,
    1,
    10000
  );

  return {
    default: { maxRequestsPerMinute: customDefault, maxBurst: customDefault },
    analysis: { ...DEFAULT_TIER_CONFIGS.analysis },
    search: { ...DEFAULT_TIER_CONFIGS.search },
  };
}

/**
 * Token Bucket Rate Limiter
 *
 * ツール種別（ティア）ごとにToken Bucketを管理し、
 * リクエストの許可/拒否を判定する。
 *
 * Redis永続化対応:
 * - Redisクライアントが提供された場合、Luaスクリプトでアトミックにトークン操作
 * - Redis未接続・障害時はインメモリフォールバック（Graceful Degradation）
 * - Redis復旧時は自動的にRedis使用に復帰（リトライバックオフ: 5秒間隔）
 *
 * Token Bucketアルゴリズム:
 * - バケットは最大maxBurstトークンを保持
 * - 1リクエストで1トークンを消費
 * - maxRequestsPerMinute / 60秒 のレートでトークンを補充
 */
export class RateLimiter {
  /** ティアごとのインメモリ Token Bucket（フォールバック用） */
  private readonly inMemoryBuckets: Map<RateLimitTier, TokenBucket> = new Map();
  /** ティアごとの設定 */
  private readonly tierConfigs: Record<RateLimitTier, RateLimitTierConfig>;
  /** Redis クライアント（null の場合はインメモリのみ） */
  private readonly redisClient: Redis | null;
  /** 最後に Redis が失敗した時刻（リトライバックオフ用） */
  private redisFailedAt: number = 0;

  constructor(
    tierConfigs?: Record<RateLimitTier, RateLimitTierConfig>,
    redisClient?: Redis | null
  ) {
    this.tierConfigs = tierConfigs ?? buildTierConfigs();
    this.redisClient = redisClient ?? null;

    // 各ティアのインメモリバケットを初期化（フル状態で開始）
    for (const tier of Object.keys(this.tierConfigs) as RateLimitTier[]) {
      const config = this.tierConfigs[tier];
      this.inMemoryBuckets.set(tier, {
        tokens: config.maxBurst,
        lastRefillTime: Date.now(),
      });
    }
  }

  /**
   * ツールのレート制限をチェック
   *
   * Redis使用可能時はLuaスクリプトでアトミックに操作。
   * Redis障害時はインメモリフォールバック。
   *
   * @param toolName - MCPツール名
   * @returns レート制限チェック結果
   */
  async checkRateLimit(toolName: string): Promise<RateLimitResult> {
    if (!isRateLimitEnabled()) {
      const tier = this.getTier(toolName);
      const config = this.tierConfigs[tier];
      return {
        allowed: true,
        remaining: config.maxBurst,
        limit: config.maxBurst,
      };
    }

    const tier = this.getTier(toolName);
    const config = this.tierConfigs[tier];

    // Redis が使用可能かつリトライバックオフ期間外なら Redis を試行
    if (this.redisClient && this.shouldRetryRedis()) {
      try {
        const result = await this.checkRateLimitRedis(tier, config);
        if (!result.allowed) {
          logger.warn(`[RateLimiter] Rate limit exceeded for tool: ${toolName} (tier: ${tier})`, {
            remaining: 0,
            limit: result.limit,
            retryAfterMs: result.retryAfterMs,
            backend: "redis",
          });
        }
        return result;
      } catch (err) {
        this.redisFailedAt = Date.now();
        logger.warn("[RateLimiter] Redis unavailable, using in-memory fallback", {
          error: err instanceof Error ? err.message : String(err),
          tier,
        });
      }
    }

    const result = this.checkRateLimitInMemory(tier, config);
    if (!result.allowed) {
      logger.warn(`[RateLimiter] Rate limit exceeded for tool: ${toolName} (tier: ${tier})`, {
        remaining: 0,
        limit: result.limit,
        retryAfterMs: result.retryAfterMs,
        backend: "in-memory",
      });
    }
    return result;
  }

  /**
   * Redis リトライバックオフ判定
   *
   * 前回の Redis 障害から REDIS_RETRY_INTERVAL_MS 経過していればリトライ可能
   */
  private shouldRetryRedis(): boolean {
    if (this.redisFailedAt === 0) return true;
    return Date.now() - this.redisFailedAt >= REDIS_RETRY_INTERVAL_MS;
  }

  /**
   * Redis を使用したアトミックなレート制限チェック
   *
   * Lua スクリプトでリフィル + 消費を1操作で実行（TOCTOU防止）
   */
  private async checkRateLimitRedis(
    tier: RateLimitTier,
    config: RateLimitTierConfig
  ): Promise<RateLimitResult> {
    const key = `${REDIS_KEY_PREFIX}${tier}`;
    const tokensPerMs = config.maxRequestsPerMinute / 60000;
    const now = Date.now();

    // SEC: NaN/Infinity防御 — 不正値の場合はインメモリにフォールバック
    if (!Number.isFinite(tokensPerMs) || tokensPerMs <= 0) {
      return this.checkRateLimitInMemory(tier, config);
    }
    if (!Number.isFinite(now)) {
      return this.checkRateLimitInMemory(tier, config);
    }

    const result = await this.redisClient!.eval(
      TOKEN_BUCKET_LUA_SCRIPT,
      1,
      key,
      String(config.maxBurst),
      String(tokensPerMs),
      String(now),
      String(REDIS_KEY_TTL_SECONDS)
    );

    // SEC: Redis レスポンス検証
    if (!Array.isArray(result) || result.length < 4) {
      throw new Error(`Unexpected Redis eval result: ${String(result)}`);
    }

    const [allowed, remaining, limit, retryAfterMs] = result as [number, number, number, number];

    // Redis 成功 — リトライバックオフをリセット
    this.redisFailedAt = 0;

    if (allowed === 1) {
      return { allowed: true, remaining, limit };
    }

    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      limit,
    };
  }

  /**
   * インメモリの Token Bucket によるレート制限チェック
   *
   * Redis 未使用時またはフォールバック時に使用
   */
  private checkRateLimitInMemory(
    tier: RateLimitTier,
    config: RateLimitTierConfig
  ): RateLimitResult {
    const bucket = this.inMemoryBuckets.get(tier);

    if (!bucket) {
      // 安全策: バケットが存在しない場合は許可（初期化ミス対策）
      logger.warn(`[RateLimiter] Bucket not found for tier: ${tier}, allowing request`);
      return { allowed: true, remaining: config.maxBurst, limit: config.maxBurst };
    }

    // トークンを補充
    this.refillTokens(bucket, config);

    if (bucket.tokens >= 1) {
      // トークン消費
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit: config.maxBurst,
      };
    }

    // トークン不足: 次の1トークン補充までの待機時間を計算
    const tokensPerMs = config.maxRequestsPerMinute / 60000;
    const msUntilNextToken = tokensPerMs > 0 ? Math.ceil((1 - bucket.tokens) / tokensPerMs) : 60000;

    return {
      allowed: false,
      retryAfterMs: msUntilNextToken,
      remaining: 0,
      limit: config.maxBurst,
    };
  }

  /**
   * ツール名からティアを取得
   */
  private getTier(toolName: string): RateLimitTier {
    return TOOL_TIER_MAP[toolName] ?? "default";
  }

  /**
   * Token Bucket のトークンを時間経過に応じて補充
   */
  private refillTokens(bucket: TokenBucket, config: RateLimitTierConfig): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefillTime;

    if (elapsed <= 0) {
      return; // 時間が経過していない
    }

    // tokensPerMs = RPM / 60000
    const tokensPerMs = config.maxRequestsPerMinute / 60000;
    const tokensToAdd = elapsed * tokensPerMs;

    bucket.tokens = Math.min(config.maxBurst, bucket.tokens + tokensToAdd);
    bucket.lastRefillTime = now;
  }

  /**
   * 特定ティアの現在の状態を取得（テスト・デバッグ用）
   *
   * 注: Redis使用時はインメモリ状態を返す（Redis状態とは異なる場合あり）
   */
  getBucketState(tier: RateLimitTier): { tokens: number; maxBurst: number } | undefined {
    const bucket = this.inMemoryBuckets.get(tier);
    const config = this.tierConfigs[tier];
    if (!bucket || !config) {
      return undefined;
    }
    return {
      tokens: bucket.tokens,
      maxBurst: config.maxBurst,
    };
  }

  /**
   * すべてのインメモリバケットをリセット（テスト用）
   */
  reset(): void {
    for (const tier of Object.keys(this.tierConfigs) as RateLimitTier[]) {
      const config = this.tierConfigs[tier];
      this.inMemoryBuckets.set(tier, {
        tokens: config.maxBurst,
        lastRefillTime: Date.now(),
      });
    }
  }
}

/**
 * シングルトンインスタンス
 */
let rateLimiterInstance: RateLimiter | null = null;

/**
 * グローバルRateLimiterインスタンスを取得（遅延初期化）
 *
 * Redis クライアントを自動的に注入。Redis 接続失敗時はインメモリのみで動作。
 */
export function getRateLimiter(): RateLimiter {
  if (!rateLimiterInstance) {
    let redisClient: Redis | null = null;
    try {
      redisClient = getRedisClient();
    } catch (err) {
      logger.warn("[RateLimiter] Failed to create Redis client, using in-memory only", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    rateLimiterInstance = new RateLimiter(undefined, redisClient);
  }
  return rateLimiterInstance;
}

/**
 * グローバルRateLimiterインスタンスをリセット（テスト用）
 */
export function resetRateLimiter(): void {
  rateLimiterInstance = null;
}

/**
 * レート制限チェックのショートカット関数
 *
 * @param toolName - MCPツール名
 * @returns レート制限チェック結果
 */
export async function checkRateLimit(toolName: string): Promise<RateLimitResult> {
  return getRateLimiter().checkRateLimit(toolName);
}
