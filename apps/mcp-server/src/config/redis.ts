// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Redis Connection Configuration for BullMQ
 *
 * Provides Redis connection factory with:
 * - Environment variable configuration (REDIS_HOST, REDIS_PORT)
 * - Port offset convention (27379 = 6379 + 21000)
 * - Graceful degradation when Redis is unavailable
 * - Purpose-aware BullMQ compliance: `worker` / `queue` purposes force
 *   `maxRetriesPerRequest: null` + `enableOfflineQueue: true` per BullMQ's
 *   required connection settings. `client` purpose keeps fail-fast semantics
 *   (`maxRetriesPerRequest: 3`, `enableOfflineQueue: false`) for general
 *   short-lived consumers such as rate limiters.
 *
 * Purpose 引数により BullMQ 公式必須設定に準拠する:
 *   - `worker` / `queue`: `maxRetriesPerRequest: null` + `enableOfflineQueue: true`
 *     (BZPOPMIN 等の blocking command 失敗 / silent disconnect を防止)
 *   - `client`: 既存の fail-fast 動作 (`maxRetriesPerRequest: 3` +
 *     `enableOfflineQueue: false`) を維持 (rate limiter 等の短寿命クライアント向け)
 *
 * References:
 *   - https://docs.bullmq.io/guide/connections
 *   - https://github.com/taskforcesh/bullmq/issues/2466 (silent disconnect症状)
 *   - https://api.docs.bullmq.io/interfaces/v5.WorkerOptions.html
 *
 * @module config/redis
 */

import Redis from "ioredis";
import { z } from "zod";
import { logger } from "../utils/logger";

/**
 * Purpose of the Redis client — determines BullMQ-compliant connection knobs.
 *
 * Redis クライアントの用途区分 — BullMQ 公式必須設定に準拠した接続オプションを選択する。
 *
 * - `worker`: BullMQ Worker backing store (BZPOPMIN blocking + reconnect-forever 必須)
 * - `queue`: BullMQ Queue / QueueEvents backing store (commandQueue 経由の再接続必須)
 * - `client`: General-purpose short-lived client (rate limiter, ad-hoc readers) with
 *   fail-fast semantics suitable for request/response style consumers.
 */
export type RedisClientPurpose = "worker" | "queue" | "client";

/**
 * Redis connection configuration interface
 */
export interface RedisConfig {
  /** Redis server hostname (default: localhost) */
  host: string;
  /** Redis server port (default: 27379 with port offset) */
  port: number;
  /**
   * Maximum retries per request. `null` disables per-request retry limits and
   * is **required by BullMQ** for Worker / Queue connections (BZPOPMIN must not
   * fail after N retries). Numeric value used for the `client` purpose only.
   *
   * 最大リトライ回数。`null` は per-request 制限を無効化し、BullMQ Worker/Queue 用途で **必須**。
   * 数値は `client` purpose (rate limiter 等) でのみ使用される。
   *
   * Defaults to `null` to align with BullMQ's required configuration.
   */
  maxRetriesPerRequest: number | null;
  /** Connection timeout in milliseconds (default: 5000) */
  connectTimeout: number;
  /** Lazy connect mode - don't connect immediately (default: true) */
  lazyConnect: boolean;
}

/**
 * Default Redis configuration with port offset.
 *
 * Port offset: 21000 (standard Redis 6379 -> 27379).
 *
 * `maxRetriesPerRequest: null` is the BullMQ-required default. The `client`
 * purpose in `createRedisClient` overrides it to 3 for fail-fast behaviour.
 *
 * `maxRetriesPerRequest: null` は BullMQ 公式必須のデフォルト。`client` purpose の
 * `createRedisClient` 呼び出しで 3 (fail-fast) に上書きされる。
 */
export const DEFAULT_REDIS_CONFIG: RedisConfig = {
  host: "localhost",
  port: 27379, // 6379 + 21000 (port offset)
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
  lazyConnect: true,
};

/**
 * Fail-fast retry count used by the `client` purpose when no explicit override
 * is supplied via env var / overrides. Mirrors the pre-v0.4.0 behaviour.
 *
 * `client` purpose のデフォルト fail-fast リトライ数。env var / overrides 未指定時に
 * 使用される。v0.4.0 以前の動作と互換。
 */
const CLIENT_PURPOSE_FALLBACK_RETRIES = 3;

/**
 * Zod schema for `REDIS_MAX_RETRIES_PER_REQUEST` env var.
 *
 * 受け付ける値 / Accepted values:
 *   - 未設定 / unset, `""`, `"null"`: → `null` (BullMQ 必須デフォルト)
 *   - 非負整数 / non-negative integer string: → その数値
 *   - それ以外 / otherwise: 警告ログ + `null` フォールバック
 */
const RedisMaxRetriesEnvSchema = z
  .union([
    z.literal("").transform((): number | null => null),
    z.literal("null").transform((): number | null => null),
    z
      .string()
      .regex(/^\d+$/, "must be a non-negative integer or 'null'")
      .transform((raw): number | null => parseInt(raw, 10))
      .refine((value: number | null) => value === null || (value >= 0 && value <= 1_000_000), {
        message: "must be 0..1000000",
      }),
  ])
  .nullable();

/**
 * Parse `REDIS_MAX_RETRIES_PER_REQUEST` env var with Zod validation.
 *
 * 環境変数 `REDIS_MAX_RETRIES_PER_REQUEST` を Zod で検証し、値 or `null` を返す。
 * 未設定・空文字・`"null"` → `null` (BullMQ 必須デフォルト)。不正値は警告ログを出して
 * `null` にフォールバックする。
 */
function parseMaxRetriesEnv(): number | null {
  const raw = process.env.REDIS_MAX_RETRIES_PER_REQUEST;
  if (raw === undefined) {
    return null;
  }
  const result = RedisMaxRetriesEnvSchema.safeParse(raw);
  if (!result.success) {
    logger.warn(
      "[Redis] invalid REDIS_MAX_RETRIES_PER_REQUEST — falling back to null (BullMQ-compliant default)",
      {
        raw,
        issues: result.error.issues.map((i) => i.message),
      }
    );
    return null;
  }
  return result.data;
}

/**
 * Parse REDIS_URL environment variable
 *
 * @param url - Redis URL (e.g., "redis://localhost:27379")
 * @returns Partial Redis configuration or null if invalid
 */
function parseRedisUrl(url: string): Partial<RedisConfig> | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      return null;
    }
    return {
      host: parsed.hostname || "localhost",
      port: parsed.port ? parseInt(parsed.port, 10) : 27379,
    };
  } catch {
    return null;
  }
}

/**
 * Get Redis configuration from environment variables
 *
 * Priority:
 * 1. REDIS_URL (full URL)
 * 2. REDIS_HOST + REDIS_PORT (individual settings)
 * 3. REDIS_MAX_RETRIES_PER_REQUEST (optional explicit override)
 * 4. Default values (localhost:27379, maxRetriesPerRequest=null)
 *
 * @param overrides - Optional configuration overrides
 * @returns Complete Redis configuration
 */
export function getRedisConfig(overrides?: Partial<RedisConfig>): RedisConfig {
  const envConfig: Partial<RedisConfig> = {};

  // Parse REDIS_URL if available
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const parsed = parseRedisUrl(redisUrl);
    if (parsed) {
      Object.assign(envConfig, parsed);
    }
  }

  // Override with individual environment variables
  if (process.env.REDIS_HOST) {
    envConfig.host = process.env.REDIS_HOST;
  }
  if (process.env.REDIS_PORT) {
    const port = parseInt(process.env.REDIS_PORT, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      envConfig.port = port;
    }
  }

  // Parse REDIS_MAX_RETRIES_PER_REQUEST only when explicitly set so that
  // `null` from DEFAULT_REDIS_CONFIG remains the source of truth otherwise.
  if (process.env.REDIS_MAX_RETRIES_PER_REQUEST !== undefined) {
    envConfig.maxRetriesPerRequest = parseMaxRetriesEnv();
  }

  return {
    ...DEFAULT_REDIS_CONFIG,
    ...envConfig,
    ...overrides,
  };
}

/**
 * Singleton Redis client instance (general-purpose `client` purpose)
 */
let redisClient: Redis | null = null;

/**
 * Redis connection status
 */
export interface RedisConnectionStatus {
  /** Whether Redis is connected */
  connected: boolean;
  /** Error message if connection failed */
  error?: string;
  /** Redis server info (if connected) */
  info?: {
    version?: string;
    mode?: string;
    connectedClients?: number;
  };
}

/**
 * Options for {@link createRedisClient}.
 *
 * `createRedisClient` のオプション。
 *
 * `purpose` により BullMQ 公式必須設定と fail-fast 設定を切り替える:
 *   - `worker` / `queue`: `maxRetriesPerRequest: null` +
 *     `enableOfflineQueue: true` + retry forever (BullMQ 必須)
 *   - `client` (default, 後方互換): `maxRetriesPerRequest: 3` +
 *     `enableOfflineQueue: false` + bounded retry (fail-fast, rate limiter 等の短寿命用途)
 */
export interface CreateRedisClientOptions extends Partial<RedisConfig> {
  /**
   * Purpose of the client. Defaults to `"client"` for backward compatibility
   * with the pre-purpose-aware API. BullMQ Worker / Queue construction sites
   * **must** pass `"worker"` / `"queue"` explicitly.
   */
  purpose?: RedisClientPurpose;
}

/**
 * Create a new Redis client with the given configuration.
 *
 * Purpose-aware behaviour:
 *   - `worker` / `queue`: BullMQ-compliant — `maxRetriesPerRequest: null` and
 *     `enableOfflineQueue: true` and retry-forever strategy. Explicit overrides
 *     via `maxRetriesPerRequest` are respected (e.g. tests may set a finite
 *     value, but production code should not).
 *   - `client` (default): fail-fast — `maxRetriesPerRequest: 3` (unless
 *     overridden) and `enableOfflineQueue: false` and bounded retry (3 tries
 *     then give up).
 *
 * Features:
 * - Lazy connection (doesn't connect immediately)
 * - Graceful error handling
 * - Automatic reconnection
 *
 * @param options - Configuration overrides and purpose selector
 * @returns Redis client instance
 */
export function createRedisClient(options?: CreateRedisClientOptions): Redis {
  const { purpose = "client", ...configOverrides } = options ?? {};
  const finalConfig = getRedisConfig(configOverrides);

  // Purpose-aware resolution of maxRetriesPerRequest / enableOfflineQueue.
  //
  // BullMQ requires `maxRetriesPerRequest: null` + `enableOfflineQueue: true`
  // for Worker / Queue connections. Failing to comply causes BZPOPMIN / lease
  // renewal to abort, leading to the silent-disconnect class of bugs described
  // in taskforcesh/bullmq#2466.
  //
  // `client` purpose retains the pre-v0.4.0 fail-fast behaviour.
  let effectiveMaxRetries: number | null;
  let enableOfflineQueue: boolean;
  let retryStrategy: ((times: number) => number | null) | undefined;

  if (purpose === "worker" || purpose === "queue") {
    // Honour explicit `null` (BullMQ-compliant) or an explicit numeric override
    // if the caller knows what they're doing (tests). Otherwise force `null`.
    effectiveMaxRetries =
      configOverrides.maxRetriesPerRequest === undefined
        ? null
        : configOverrides.maxRetriesPerRequest;
    enableOfflineQueue = true;
    // Retry forever with capped exponential backoff — required so that BullMQ
    // reconnects after transient Redis hiccups rather than silently stopping.
    retryStrategy = (times: number): number | null => {
      // Cap delay at 30s to avoid unbounded growth; retry indefinitely.
      return Math.min(times * 200, 30_000);
    };
  } else {
    // `client` purpose — fail-fast bounded retry.
    effectiveMaxRetries =
      configOverrides.maxRetriesPerRequest === undefined
        ? CLIENT_PURPOSE_FALLBACK_RETRIES
        : configOverrides.maxRetriesPerRequest;
    enableOfflineQueue = false;
    retryStrategy = (times: number): number | null => {
      if (times > 3) {
        // Stop retrying after 3 attempts
        return null;
      }
      // Exponential backoff: 100ms, 200ms, 400ms
      return Math.min(times * 100, 1000);
    };
  }

  const client = new Redis({
    host: finalConfig.host,
    port: finalConfig.port,
    maxRetriesPerRequest: effectiveMaxRetries,
    connectTimeout: finalConfig.connectTimeout,
    lazyConnect: finalConfig.lazyConnect,
    enableOfflineQueue,
    retryStrategy,
  });

  // Log connection events in development
  if (process.env.NODE_ENV === "development") {
    client.on("connect", () => {
      console.warn(
        `[Redis] Connected to ${finalConfig.host}:${finalConfig.port} (purpose=${purpose})`
      );
    });

    client.on("error", (err) => {
      console.error(`[Redis] Connection error (purpose=${purpose}):`, err.message);
    });

    client.on("close", () => {
      console.warn(`[Redis] Connection closed (purpose=${purpose})`);
    });
  }

  return client;
}

/**
 * Get or create the singleton general-purpose Redis client (`client` purpose).
 *
 * For BullMQ Worker / Queue connections use `createRedisClient({ purpose: "worker" })`
 * or `createRedisClient({ purpose: "queue" })` directly — those connections must
 * **not** be shared with the singleton because their `maxRetriesPerRequest` /
 * `enableOfflineQueue` contracts differ.
 *
 * @returns Redis client instance (may not be connected yet)
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient({ purpose: "client" });
  }
  return redisClient;
}

/**
 * Check Redis connection status
 *
 * @param client - Optional Redis client (uses singleton if not provided)
 * @returns Connection status with optional server info
 */
export async function checkRedisConnection(client?: Redis): Promise<RedisConnectionStatus> {
  const redis = client || getRedisClient();

  try {
    // Try to connect if not already connected
    if (redis.status !== "ready") {
      await redis.connect();
    }

    // Ping to verify connection
    const pong = await redis.ping();
    if (pong !== "PONG") {
      return {
        connected: false,
        error: `Unexpected ping response: ${pong}`,
      };
    }

    // Get server info
    const info = await redis.info("server");
    const versionMatch = info.match(/redis_version:(\S+)/);
    const modeMatch = info.match(/redis_mode:(\S+)/);

    const clientsInfo = await redis.info("clients");
    const clientsMatch = clientsInfo.match(/connected_clients:(\d+)/);

    // Build info object, only including defined values
    const redisInfo: {
      version?: string;
      mode?: string;
      connectedClients?: number;
    } = {};

    if (versionMatch?.[1]) {
      redisInfo.version = versionMatch[1];
    }
    if (modeMatch?.[1]) {
      redisInfo.mode = modeMatch[1];
    }
    if (clientsMatch && clientsMatch[1]) {
      redisInfo.connectedClients = parseInt(clientsMatch[1], 10);
    }

    return {
      connected: true,
      info: redisInfo,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      connected: false,
      error,
    };
  }
}

/**
 * Close the singleton Redis client
 *
 * Call this during graceful shutdown
 */
export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

/**
 * Check if Redis is available without throwing
 *
 * Useful for graceful degradation when Redis is optional
 *
 * @returns true if Redis is available, false otherwise
 */
export async function isRedisAvailable(): Promise<boolean> {
  try {
    const status = await checkRedisConnection();
    return status.connected;
  } catch {
    return false;
  }
}
