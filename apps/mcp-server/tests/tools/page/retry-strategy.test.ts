// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * リトライ戦略のテスト
 *
 * タイムアウト累積防止のためのリトライ戦略をテストする
 *
 * @module tests/tools/page/retry-strategy.test
 */

import { describe, it, expect } from 'vitest';
import {
  getRetryStrategy,
  isNetworkError,
  calculateMaxTotalTime,
  shouldRetry,
  type RetryStrategyConfig,
  type SiteTier,
} from '../../../src/tools/page/handlers/retry-strategy';

describe('retry-strategy', () => {
  describe('getRetryStrategy', () => {
    describe('normal tier', () => {
      it('should return default retry config for normal sites', () => {
        const config = getRetryStrategy('normal');

        expect(config.autoRetry).toBe(true);
        expect(config.maxRetries).toBe(2);
        expect(config.timeoutMultiplier).toBe(1.5);
        expect(config.waitBetweenRetriesMs).toBe(1000);
        expect(config.retryOnlyOnNetworkError).toBe(false);
      });
    });

    describe('webgl tier', () => {
      it('should return WebGL-specific retry config', () => {
        const config = getRetryStrategy('webgl');

        expect(config.autoRetry).toBe(true);
        expect(config.maxRetries).toBe(2);
        expect(config.timeoutMultiplier).toBe(1.2);
        expect(config.waitBetweenRetriesMs).toBe(2000);
        expect(config.retryOnlyOnNetworkError).toBe(false);
      });
    });

    describe('heavy tier', () => {
      it('should return conservative retry config for heavy sites', () => {
        const config = getRetryStrategy('heavy');

        expect(config.autoRetry).toBe(true);
        expect(config.maxRetries).toBe(1);
        expect(config.timeoutMultiplier).toBe(1.0);
        expect(config.waitBetweenRetriesMs).toBe(3000);
        expect(config.retryOnlyOnNetworkError).toBe(true);
      });
    });

    describe('ultra-heavy tier', () => {
      it('should return minimal retry config for ultra-heavy sites', () => {
        const config = getRetryStrategy('ultra-heavy');

        expect(config.autoRetry).toBe(true);
        expect(config.maxRetries).toBe(1);
        expect(config.timeoutMultiplier).toBe(1.0);
        expect(config.waitBetweenRetriesMs).toBe(5000);
        expect(config.retryOnlyOnNetworkError).toBe(true);
      });
    });

    describe('unknown tier', () => {
      it('should fallback to normal tier for unknown values', () => {
        // @ts-expect-error - Testing unknown tier value
        const config = getRetryStrategy('unknown-tier');

        expect(config.autoRetry).toBe(true);
        expect(config.maxRetries).toBe(2);
        expect(config.timeoutMultiplier).toBe(1.5);
      });
    });
  });

  describe('isNetworkError', () => {
    describe('should detect network errors', () => {
      it('should detect net::ERR_ errors', () => {
        const error = new Error('net::ERR_CONNECTION_REFUSED');
        expect(isNetworkError(error)).toBe(true);
      });

      it('should detect ECONNREFUSED errors', () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:3000');
        expect(isNetworkError(error)).toBe(true);
      });

      it('should detect ETIMEDOUT errors', () => {
        const error = new Error('connect ETIMEDOUT 192.168.1.1');
        expect(isNetworkError(error)).toBe(true);
      });

      it('should detect ENOTFOUND errors', () => {
        const error = new Error('getaddrinfo ENOTFOUND example.invalid');
        expect(isNetworkError(error)).toBe(true);
      });

      it('should detect network errors (generic)', () => {
        const error = new Error('Network request failed');
        expect(isNetworkError(error)).toBe(true);
      });

      it('should detect socket errors', () => {
        const error = new Error('Socket closed unexpectedly');
        expect(isNetworkError(error)).toBe(true);
      });

      it('should be case-insensitive', () => {
        const error = new Error('NETWORK ERROR');
        expect(isNetworkError(error)).toBe(true);
      });
    });

    describe('should not detect non-network errors', () => {
      it('should not detect timeout errors as network errors', () => {
        const error = new Error('Timeout waiting for page to load');
        expect(isNetworkError(error)).toBe(false);
      });

      it('should not detect JavaScript errors', () => {
        const error = new Error('Cannot read property of undefined');
        expect(isNetworkError(error)).toBe(false);
      });

      it('should not detect validation errors', () => {
        const error = new Error('Invalid URL format');
        expect(isNetworkError(error)).toBe(false);
      });

      it('should handle non-Error objects', () => {
        expect(isNetworkError('not an error')).toBe(false);
        expect(isNetworkError(null)).toBe(false);
        expect(isNetworkError(undefined)).toBe(false);
        expect(isNetworkError(42)).toBe(false);
        expect(isNetworkError({})).toBe(false);
      });
    });
  });

  describe('calculateMaxTotalTime', () => {
    describe('should calculate max total time correctly', () => {
      it('should calculate for normal tier (timeout × (1 + 1.5 + 2.25) × 3 attempts + waits)', () => {
        const config = getRetryStrategy('normal');
        const baseTimeout = 60000; // 60 seconds

        const maxTime = calculateMaxTotalTime(baseTimeout, config);

        // normal: timeout=60s, multiplier=1.5, retries=2, wait=1s
        // attempt 1: 60s
        // attempt 2: 60 * 1.5 = 90s, wait: 1s
        // attempt 3: 60 * 1.5 * 1.5 = 135s, wait: 1s
        // Total: 60 + 90 + 135 + 2 = 287s
        expect(maxTime).toBe(287000);
      });

      it('should calculate for ultra-heavy tier (no timeout accumulation)', () => {
        const config = getRetryStrategy('ultra-heavy');
        const baseTimeout = 180000; // 180 seconds

        const maxTime = calculateMaxTotalTime(baseTimeout, config);

        // ultra-heavy: timeout=180s, multiplier=1.0, retries=1, wait=5s
        // attempt 1: 180s
        // attempt 2: 180 * 1.0 = 180s, wait: 5s
        // Total: 180 + 180 + 5 = 365s
        expect(maxTime).toBe(365000);
      });

      it('should stay within MCP 600s limit for heavy sites', () => {
        const config = getRetryStrategy('heavy');
        const baseTimeout = 180000; // 180 seconds (max recommended)

        const maxTime = calculateMaxTotalTime(baseTimeout, config);

        // heavy: timeout=180s, multiplier=1.0, retries=1, wait=3s
        // Total: 180 + 180 + 3 = 363s
        expect(maxTime).toBeLessThanOrEqual(600000); // MCP limit
      });

      it('should stay within MCP 600s limit for ultra-heavy sites', () => {
        const config = getRetryStrategy('ultra-heavy');
        const baseTimeout = 180000; // 180 seconds

        const maxTime = calculateMaxTotalTime(baseTimeout, config);

        expect(maxTime).toBeLessThanOrEqual(600000); // MCP limit
      });
    });
  });

  describe('shouldRetry', () => {
    describe('with retryOnlyOnNetworkError=false', () => {
      const config: RetryStrategyConfig = {
        autoRetry: true,
        maxRetries: 2,
        timeoutMultiplier: 1.5,
        waitBetweenRetriesMs: 1000,
        retryOnlyOnNetworkError: false,
      };

      it('should retry on timeout errors', () => {
        const error = new Error('Timeout waiting for page to load');
        expect(shouldRetry(error, 0, config)).toBe(true);
      });

      it('should retry on network errors', () => {
        const error = new Error('net::ERR_CONNECTION_REFUSED');
        expect(shouldRetry(error, 0, config)).toBe(true);
      });

      it('should not retry when max retries reached', () => {
        const error = new Error('Some error');
        expect(shouldRetry(error, 2, config)).toBe(false);
      });

      it('should not retry when autoRetry is disabled', () => {
        const disabledConfig = { ...config, autoRetry: false };
        const error = new Error('Some error');
        expect(shouldRetry(error, 0, disabledConfig)).toBe(false);
      });
    });

    describe('with retryOnlyOnNetworkError=true', () => {
      const config: RetryStrategyConfig = {
        autoRetry: true,
        maxRetries: 1,
        timeoutMultiplier: 1.0,
        waitBetweenRetriesMs: 3000,
        retryOnlyOnNetworkError: true,
      };

      it('should retry on network errors', () => {
        const error = new Error('net::ERR_CONNECTION_REFUSED');
        expect(shouldRetry(error, 0, config)).toBe(true);
      });

      it('should NOT retry on timeout errors', () => {
        const error = new Error('Timeout waiting for page to load');
        expect(shouldRetry(error, 0, config)).toBe(false);
      });

      it('should NOT retry on JavaScript errors', () => {
        const error = new Error('Cannot read property of undefined');
        expect(shouldRetry(error, 0, config)).toBe(false);
      });

      it('should not retry when max retries reached', () => {
        const error = new Error('net::ERR_CONNECTION_REFUSED');
        expect(shouldRetry(error, 1, config)).toBe(false);
      });
    });
  });

  describe('SiteTier type', () => {
    it('should accept valid tier values', () => {
      const tiers: SiteTier[] = ['normal', 'webgl', 'heavy', 'ultra-heavy'];

      tiers.forEach(tier => {
        const config = getRetryStrategy(tier);
        expect(config).toBeDefined();
        expect(config.autoRetry).toBeDefined();
        expect(config.maxRetries).toBeDefined();
        expect(config.timeoutMultiplier).toBeDefined();
        expect(config.waitBetweenRetriesMs).toBeDefined();
        expect(config.retryOnlyOnNetworkError).toBeDefined();
      });
    });
  });

  describe('integration: timeout accumulation prevention', () => {
    it('should prevent timeout accumulation for ultra-heavy sites', () => {
      const config = getRetryStrategy('ultra-heavy');

      // timeoutMultiplier=1.0 means no accumulation
      expect(config.timeoutMultiplier).toBe(1.0);

      // With 180s base timeout and 1 retry:
      // Old behavior (1.5 multiplier): 180 + 270 + 405 = 855s (exceeds 600s)
      // New behavior (1.0 multiplier): 180 + 180 = 360s (within limit)
      const baseTimeout = 180000;
      const maxTime = calculateMaxTotalTime(baseTimeout, config);

      expect(maxTime).toBeLessThan(600000);
    });

    it('should prevent timeout accumulation for heavy sites', () => {
      const config = getRetryStrategy('heavy');

      expect(config.timeoutMultiplier).toBe(1.0);
      expect(config.maxRetries).toBe(1);

      const baseTimeout = 180000;
      const maxTime = calculateMaxTotalTime(baseTimeout, config);

      expect(maxTime).toBeLessThan(600000);
    });

    it('should allow mild accumulation for webgl sites', () => {
      const config = getRetryStrategy('webgl');

      // WebGL sites get mild accumulation (1.2x)
      expect(config.timeoutMultiplier).toBe(1.2);

      // With 120s base timeout:
      // 120 + 144 + 172.8 = 436.8s (within 600s limit)
      const baseTimeout = 120000;
      const maxTime = calculateMaxTotalTime(baseTimeout, config);

      expect(maxTime).toBeLessThan(600000);
    });

    it('should allow normal accumulation for normal sites', () => {
      const config = getRetryStrategy('normal');

      // Normal sites get standard accumulation (1.5x)
      expect(config.timeoutMultiplier).toBe(1.5);

      // With 60s base timeout (typical):
      // 60 + 90 + 135 = 285s (well within 600s limit)
      const baseTimeout = 60000;
      const maxTime = calculateMaxTotalTime(baseTimeout, config);

      expect(maxTime).toBeLessThan(600000);
    });
  });

  describe('edge cases', () => {
    it('should handle zero base timeout', () => {
      const config = getRetryStrategy('normal');
      const maxTime = calculateMaxTotalTime(0, config);

      // Only wait times: 1s × 2 retries = 2s
      expect(maxTime).toBe(2000);
    });

    it('should handle very large base timeout', () => {
      const config = getRetryStrategy('ultra-heavy');
      const maxTime = calculateMaxTotalTime(300000, config); // 300s

      // 300 + 300 + 5 = 605s (slightly over, but that's user's choice)
      expect(maxTime).toBe(605000);
    });
  });
});
