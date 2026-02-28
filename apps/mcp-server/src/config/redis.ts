// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Redis Connection Configuration for BullMQ
 *
 * Provides Redis connection factory with:
 * - Environment variable configuration (REDIS_HOST, REDIS_PORT)
 * - Port offset convention (27379 = 6379 + 21000)
 * - Graceful degradation when Redis is unavailable
 *
 * @module config/redis
 */

import Redis from 'ioredis';

/**
 * Redis connection configuration interface
 */
export interface RedisConfig {
  /** Redis server hostname (default: localhost) */
  host: string;
  /** Redis server port (default: 27379 with port offset) */
  port: number;
  /** Maximum retries per request (default: 3) */
  maxRetriesPerRequest: number;
  /** Connection timeout in milliseconds (default: 5000) */
  connectTimeout: number;
  /** Lazy connect mode - don't connect immediately (default: true) */
  lazyConnect: boolean;
}

/**
 * Default Redis configuration with port offset
 *
 * Port offset: 21000 (standard Redis 6379 -> 27379)
 */
export const DEFAULT_REDIS_CONFIG: RedisConfig = {
  host: 'localhost',
  port: 27379, // 6379 + 21000 (port offset)
  maxRetriesPerRequest: 3,
  connectTimeout: 5000,
  lazyConnect: true,
};

/**
 * Parse REDIS_URL environment variable
 *
 * @param url - Redis URL (e.g., "redis://localhost:27379")
 * @returns Partial Redis configuration or null if invalid
 */
function parseRedisUrl(url: string): Partial<RedisConfig> | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      return null;
    }
    return {
      host: parsed.hostname || 'localhost',
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
 * 3. Default values (localhost:27379)
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

  return {
    ...DEFAULT_REDIS_CONFIG,
    ...envConfig,
    ...overrides,
  };
}

/**
 * Singleton Redis client instance
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
 * Create a new Redis client with the given configuration
 *
 * Features:
 * - Lazy connection (doesn't connect immediately)
 * - Graceful error handling
 * - Automatic reconnection
 *
 * @param config - Optional configuration overrides
 * @returns Redis client instance
 */
export function createRedisClient(config?: Partial<RedisConfig>): Redis {
  const finalConfig = getRedisConfig(config);

  const client = new Redis({
    host: finalConfig.host,
    port: finalConfig.port,
    maxRetriesPerRequest: finalConfig.maxRetriesPerRequest,
    connectTimeout: finalConfig.connectTimeout,
    lazyConnect: finalConfig.lazyConnect,
    // Disable offline queue to fail fast when Redis is unavailable
    enableOfflineQueue: false,
    // Retry strategy: exponential backoff with max 3 retries
    retryStrategy: (times: number): number | null => {
      if (times > 3) {
        // Stop retrying after 3 attempts
        return null;
      }
      // Exponential backoff: 100ms, 200ms, 400ms
      return Math.min(times * 100, 1000);
    },
  });

  // Log connection events in development
  if (process.env.NODE_ENV === 'development') {
    client.on('connect', () => {
      console.warn(`[Redis] Connected to ${finalConfig.host}:${finalConfig.port}`);
    });

    client.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });

    client.on('close', () => {
      console.warn('[Redis] Connection closed');
    });
  }

  return client;
}

/**
 * Get or create the singleton Redis client
 *
 * @returns Redis client instance (may not be connected yet)
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

/**
 * Check Redis connection status
 *
 * @param client - Optional Redis client (uses singleton if not provided)
 * @returns Connection status with optional server info
 */
export async function checkRedisConnection(
  client?: Redis
): Promise<RedisConnectionStatus> {
  const redis = client || getRedisClient();

  try {
    // Try to connect if not already connected
    if (redis.status !== 'ready') {
      await redis.connect();
    }

    // Ping to verify connection
    const pong = await redis.ping();
    if (pong !== 'PONG') {
      return {
        connected: false,
        error: `Unexpected ping response: ${pong}`,
      };
    }

    // Get server info
    const info = await redis.info('server');
    const versionMatch = info.match(/redis_version:(\S+)/);
    const modeMatch = info.match(/redis_mode:(\S+)/);

    const clientsInfo = await redis.info('clients');
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
