// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Redis Configuration Tests
 *
 * Tests for Redis connection configuration module, including:
 * - BullMQ-compliant defaults (maxRetriesPerRequest: null)
 * - Purpose-aware client creation (worker / queue / client)
 * - REDIS_MAX_RETRIES_PER_REQUEST env var validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getRedisConfig,
  createRedisClient,
  DEFAULT_REDIS_CONFIG,
  type RedisConfig,
} from "../../src/config/redis";

describe("Redis Configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment for each test
    vi.resetModules();
    process.env = { ...originalEnv };
    // Ensure tests start from a clean slate for the newly-introduced env var.
    delete process.env.REDIS_MAX_RETRIES_PER_REQUEST;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("DEFAULT_REDIS_CONFIG", () => {
    it("should have correct default values with port offset", () => {
      expect(DEFAULT_REDIS_CONFIG.host).toBe("localhost");
      expect(DEFAULT_REDIS_CONFIG.port).toBe(27379); // 6379 + 21000
      // BullMQ 公式必須: maxRetriesPerRequest は null がデフォルト
      // BullMQ requires maxRetriesPerRequest to be null by default
      expect(DEFAULT_REDIS_CONFIG.maxRetriesPerRequest).toBe(null);
      expect(DEFAULT_REDIS_CONFIG.connectTimeout).toBe(5000);
      expect(DEFAULT_REDIS_CONFIG.lazyConnect).toBe(true);
    });

    it("should use port offset 21000 (6379 -> 27379)", () => {
      const standardRedisPort = 6379;
      const portOffset = 21000;
      expect(DEFAULT_REDIS_CONFIG.port).toBe(standardRedisPort + portOffset);
    });
  });

  describe("getRedisConfig", () => {
    it("should return default config when no environment variables are set", () => {
      delete process.env.REDIS_URL;
      delete process.env.REDIS_HOST;
      delete process.env.REDIS_PORT;

      const config = getRedisConfig();

      expect(config.host).toBe("localhost");
      expect(config.port).toBe(27379);
      expect(config.maxRetriesPerRequest).toBe(null);
    });

    it("should parse REDIS_URL environment variable", () => {
      process.env.REDIS_URL = "redis://redis-server:27379";

      const config = getRedisConfig();

      expect(config.host).toBe("redis-server");
      expect(config.port).toBe(27379);
    });

    it("should override with REDIS_HOST environment variable", () => {
      process.env.REDIS_HOST = "custom-redis";

      const config = getRedisConfig();

      expect(config.host).toBe("custom-redis");
    });

    it("should override with REDIS_PORT environment variable", () => {
      process.env.REDIS_PORT = "6380";

      const config = getRedisConfig();

      expect(config.port).toBe(6380);
    });

    it("should prioritize REDIS_HOST/PORT over REDIS_URL", () => {
      process.env.REDIS_URL = "redis://url-host:27379";
      process.env.REDIS_HOST = "override-host";
      process.env.REDIS_PORT = "27380";

      const config = getRedisConfig();

      expect(config.host).toBe("override-host");
      expect(config.port).toBe(27380);
    });

    it("should apply config overrides", () => {
      const overrides: Partial<RedisConfig> = {
        host: "override-host",
        port: 12345,
        maxRetriesPerRequest: 5,
      };

      const config = getRedisConfig(overrides);

      expect(config.host).toBe("override-host");
      expect(config.port).toBe(12345);
      expect(config.maxRetriesPerRequest).toBe(5);
    });

    it("should handle invalid REDIS_URL gracefully", () => {
      process.env.REDIS_URL = "not-a-valid-url";
      delete process.env.REDIS_HOST;
      delete process.env.REDIS_PORT;

      const config = getRedisConfig();

      // Should fall back to defaults
      expect(config.host).toBe("localhost");
      expect(config.port).toBe(27379);
    });

    it("should handle non-redis protocol URLs", () => {
      process.env.REDIS_URL = "http://localhost:6379";
      delete process.env.REDIS_HOST;
      delete process.env.REDIS_PORT;

      const config = getRedisConfig();

      // Should fall back to defaults (non-redis protocol)
      expect(config.host).toBe("localhost");
      expect(config.port).toBe(27379);
    });

    it("should handle invalid REDIS_PORT gracefully", () => {
      process.env.REDIS_PORT = "not-a-number";

      const config = getRedisConfig();

      // Should fall back to default
      expect(config.port).toBe(27379);
    });

    it("should handle out-of-range REDIS_PORT gracefully", () => {
      process.env.REDIS_PORT = "99999";

      const config = getRedisConfig();

      // Should fall back to default (port > 65535)
      expect(config.port).toBe(27379);
    });
  });

  describe("REDIS_MAX_RETRIES_PER_REQUEST env var (BullMQ compliance)", () => {
    it("should default to null when env var is unset", () => {
      delete process.env.REDIS_MAX_RETRIES_PER_REQUEST;
      const config = getRedisConfig();
      expect(config.maxRetriesPerRequest).toBe(null);
    });

    it("should coerce empty string to null", () => {
      process.env.REDIS_MAX_RETRIES_PER_REQUEST = "";
      const config = getRedisConfig();
      expect(config.maxRetriesPerRequest).toBe(null);
    });

    it("should coerce literal 'null' to null", () => {
      process.env.REDIS_MAX_RETRIES_PER_REQUEST = "null";
      const config = getRedisConfig();
      expect(config.maxRetriesPerRequest).toBe(null);
    });

    it("should accept explicit numeric values", () => {
      process.env.REDIS_MAX_RETRIES_PER_REQUEST = "5";
      const config = getRedisConfig();
      expect(config.maxRetriesPerRequest).toBe(5);
    });

    it("should accept 0 (unlimited retries semantics in ioredis)", () => {
      process.env.REDIS_MAX_RETRIES_PER_REQUEST = "0";
      const config = getRedisConfig();
      expect(config.maxRetriesPerRequest).toBe(0);
    });

    it("should fall back to null on non-numeric garbage", () => {
      process.env.REDIS_MAX_RETRIES_PER_REQUEST = "not-a-number";
      const config = getRedisConfig();
      expect(config.maxRetriesPerRequest).toBe(null);
    });

    it("should fall back to null on negative values", () => {
      process.env.REDIS_MAX_RETRIES_PER_REQUEST = "-1";
      const config = getRedisConfig();
      expect(config.maxRetriesPerRequest).toBe(null);
    });
  });

  describe("createRedisClient (purpose-aware)", () => {
    it("should create a Redis client with default config (client purpose)", () => {
      const client = createRedisClient();

      expect(client).toBeDefined();
      // ioredis client should have the options
      expect(client.options.host).toBe("localhost");
      expect(client.options.port).toBe(27379);

      // Cleanup
      client.disconnect();
    });

    it("should create a Redis client with custom config", () => {
      const client = createRedisClient({
        host: "custom-host",
        port: 12345,
      });

      expect(client.options.host).toBe("custom-host");
      expect(client.options.port).toBe(12345);

      // Cleanup
      client.disconnect();
    });

    it("should have lazyConnect enabled by default", () => {
      const client = createRedisClient();

      // With lazyConnect, client should not be connected yet
      expect(client.status).toBe("wait");

      // Cleanup
      client.disconnect();
    });

    it("should have retry strategy configured", () => {
      const client = createRedisClient();

      // The retry strategy should be a function
      expect(client.options.retryStrategy).toBeDefined();
      expect(typeof client.options.retryStrategy).toBe("function");

      // Cleanup
      client.disconnect();
    });

    // ===============================================================
    // Purpose-aware configuration — BullMQ compliance
    // ===============================================================

    it("purpose='worker' should enable offline queue and force maxRetries=null (BullMQ required)", () => {
      const client = createRedisClient({ purpose: "worker" });
      try {
        // BullMQ required: offline queue enabled + maxRetriesPerRequest null
        expect(client.options.enableOfflineQueue).toBe(true);
        expect(client.options.maxRetriesPerRequest).toBe(null);
      } finally {
        client.disconnect();
      }
    });

    it("purpose='queue' should enable offline queue and force maxRetries=null (BullMQ required)", () => {
      const client = createRedisClient({ purpose: "queue" });
      try {
        expect(client.options.enableOfflineQueue).toBe(true);
        expect(client.options.maxRetriesPerRequest).toBe(null);
      } finally {
        client.disconnect();
      }
    });

    it("purpose='client' should preserve fail-fast behaviour (maxRetries=3, offline queue off)", () => {
      const client = createRedisClient({ purpose: "client" });
      try {
        // Fail-fast for short-lived clients (rate limiters, ad-hoc readers)
        expect(client.options.enableOfflineQueue).toBe(false);
        expect(client.options.maxRetriesPerRequest).toBe(3);
      } finally {
        client.disconnect();
      }
    });

    it("default purpose should be 'client' (backward compatibility)", () => {
      const client = createRedisClient();
      try {
        expect(client.options.enableOfflineQueue).toBe(false);
        expect(client.options.maxRetriesPerRequest).toBe(3);
      } finally {
        client.disconnect();
      }
    });

    it("purpose='worker' retryStrategy should return finite ms and never null (retry forever)", () => {
      const client = createRedisClient({ purpose: "worker" });
      try {
        const strategy = client.options.retryStrategy as (t: number) => number | null;
        expect(strategy).toBeDefined();
        // Sample a few attempt counts — none should return null
        for (const attempt of [1, 10, 100, 1000]) {
          const delay = strategy(attempt);
          expect(delay).not.toBeNull();
          expect(typeof delay).toBe("number");
          expect(delay).toBeGreaterThan(0);
          expect(delay).toBeLessThanOrEqual(30_000);
        }
      } finally {
        client.disconnect();
      }
    });

    it("purpose='client' retryStrategy should return null after 3 attempts (fail-fast)", () => {
      const client = createRedisClient({ purpose: "client" });
      try {
        const strategy = client.options.retryStrategy as (t: number) => number | null;
        expect(strategy).toBeDefined();
        // First 3 attempts return numeric delays
        expect(strategy(1)).toBeGreaterThan(0);
        expect(strategy(2)).toBeGreaterThan(0);
        expect(strategy(3)).toBeGreaterThan(0);
        // 4th attempt returns null (give up)
        expect(strategy(4)).toBeNull();
      } finally {
        client.disconnect();
      }
    });

    it("purpose='worker' should honour explicit numeric maxRetriesPerRequest override (tests only)", () => {
      // Escape hatch for tests that want finite retries on a worker-purpose client.
      const client = createRedisClient({ purpose: "worker", maxRetriesPerRequest: 7 });
      try {
        expect(client.options.maxRetriesPerRequest).toBe(7);
        // offlineQueue is still enabled regardless of maxRetries override
        expect(client.options.enableOfflineQueue).toBe(true);
      } finally {
        client.disconnect();
      }
    });
  });

  describe("Redis URL parsing edge cases", () => {
    it("should handle redis:// protocol", () => {
      process.env.REDIS_URL = "redis://myhost:27379";

      const config = getRedisConfig();

      expect(config.host).toBe("myhost");
      expect(config.port).toBe(27379);
    });

    it("should handle rediss:// (TLS) protocol", () => {
      process.env.REDIS_URL = "rediss://secure-redis:27379";

      const config = getRedisConfig();

      expect(config.host).toBe("secure-redis");
      expect(config.port).toBe(27379);
    });

    it("should handle URL without port", () => {
      process.env.REDIS_URL = "redis://redis-server";
      delete process.env.REDIS_PORT;

      const config = getRedisConfig();

      expect(config.host).toBe("redis-server");
      expect(config.port).toBe(27379); // Default port
    });

    it("should handle URL with empty hostname", () => {
      process.env.REDIS_URL = "redis://:27379";
      delete process.env.REDIS_HOST;

      const config = getRedisConfig();

      // Empty hostname falls back to localhost
      expect(config.host).toBe("localhost");
    });
  });
});
