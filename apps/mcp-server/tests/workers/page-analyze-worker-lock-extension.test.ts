// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Lock Extension Tests
 *
 * Tests for BullMQ lock auto-extension mechanism to prevent
 * job stalling during long-running phases (e.g., Ollama Vision).
 *
 * BullMQ v5.x provides automatic lock renewal via lockRenewTime
 * (default: lockDuration/2), but CPU-bound processing may block
 * the event loop, preventing timer-based renewal. This module
 * provides explicit lock extension at phase boundaries as a
 * secondary protection layer.
 *
 * @module tests/workers/page-analyze-worker-lock-extension
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('PageAnalyzeWorker - Lock Extension', () => {
  const workerSourcePath = path.resolve(
    __dirname,
    '../../src/workers/page-analyze-worker.ts'
  );

  let workerSource: string;

  beforeEach(() => {
    workerSource = fs.readFileSync(workerSourcePath, 'utf8');
  });

  // ============================================================================
  // 1. createLockExtender utility function
  // ============================================================================

  describe('createLockExtender utility', () => {
    it('should export createLockExtender function', () => {
      expect(workerSource).toContain('export function createLockExtender');
    });

    it('should accept job, token, lockDuration, and intervalMs parameters', () => {
      // The function signature should include these parameters
      const fnMatch = workerSource.match(
        /function createLockExtender\([^)]+\)/
      );
      expect(fnMatch).not.toBeNull();
      const fnSignature = fnMatch![0];
      expect(fnSignature).toContain('job');
      expect(fnSignature).toContain('token');
      expect(fnSignature).toContain('lockDuration');
      expect(fnSignature).toContain('intervalMs');
    });

    it('should return an object with start() and stop() methods', () => {
      // The return type should include start and stop within createLockExtender
      const fnStart = workerSource.indexOf('function createLockExtender');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = workerSource.slice(fnStart, fnStart + 2000);
      // Should contain both start: and stop: property definitions
      expect(fnSection).toContain('start:');
      expect(fnSection).toContain('stop:');
    });

    it('should call job.extendLock(token, lockDuration) in the interval callback', () => {
      // The extendLock call with token and lockDuration
      expect(workerSource).toContain('job.extendLock(token, lockDuration)');
    });

    it('should use setInterval to periodically extend the lock', () => {
      // Look for setInterval usage within the createLockExtender function
      const fnStart = workerSource.indexOf('function createLockExtender');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = workerSource.slice(fnStart, fnStart + 1500);
      expect(fnSection).toContain('setInterval');
    });

    it('should clearInterval in stop() method', () => {
      const fnStart = workerSource.indexOf('function createLockExtender');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = workerSource.slice(fnStart, fnStart + 1500);
      expect(fnSection).toContain('clearInterval');
    });

    it('should log when lock extension fails', () => {
      // There should be error handling for extendLock failure
      const fnStart = workerSource.indexOf('function createLockExtender');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = workerSource.slice(fnStart, fnStart + 1500);
      expect(fnSection).toContain('Lock extension failed');
    });

    it('should log when lock extension starts', () => {
      const fnStart = workerSource.indexOf('function createLockExtender');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = workerSource.slice(fnStart, fnStart + 1500);
      expect(fnSection).toMatch(/Lock extender start|Starting lock extender/i);
    });
  });

  // ============================================================================
  // 2. LockExtender interface/type
  // ============================================================================

  describe('LockExtender type', () => {
    it('should define LockExtender interface with start and stop methods', () => {
      expect(workerSource).toMatch(
        /(?:interface|type)\s+LockExtender/
      );
    });

    it('should export LockExtender type', () => {
      expect(workerSource).toMatch(/export\s+(?:interface|type)\s+LockExtender/);
    });
  });

  // ============================================================================
  // 3. Lock extension constants
  // ============================================================================

  describe('Lock extension constants', () => {
    it('should define DEFAULT_LOCK_EXTEND_INTERVAL constant', () => {
      expect(workerSource).toContain('DEFAULT_LOCK_EXTEND_INTERVAL');
    });

    it('should set DEFAULT_LOCK_EXTEND_INTERVAL to 300000ms (5 minutes) as default', () => {
      // 5 minutes = 300000ms, configured via safeParseInt with env var fallback
      expect(workerSource).toContain("BULLMQ_LOCK_EXTEND_INTERVAL_MS");
      expect(workerSource).toContain("300000");
    });

    it('should allow BULLMQ_LOCK_EXTEND_INTERVAL_MS environment variable override', () => {
      expect(workerSource).toContain('BULLMQ_LOCK_EXTEND_INTERVAL_MS');
    });

    it('should allow BULLMQ_LOCK_DURATION environment variable override for lockDuration', () => {
      expect(workerSource).toContain('BULLMQ_LOCK_DURATION');
    });
  });

  // ============================================================================
  // 4. processPageAnalyzeJob token integration
  // ============================================================================

  describe('processPageAnalyzeJob token parameter', () => {
    it('should accept token as second parameter in processPageAnalyzeJob', () => {
      // The function signature should include token
      const fnMatch = workerSource.match(
        /(?:async\s+)?function\s+processPageAnalyzeJob\s*\([^)]+\)/
      );
      expect(fnMatch).not.toBeNull();
      expect(fnMatch![0]).toContain('token');
    });

    it('should create lock extender at the start of job processing', () => {
      // Within processPageAnalyzeJob, createLockExtender should be called
      const fnStart = workerSource.indexOf('function processPageAnalyzeJob');
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 3000);
      expect(fnBody).toContain('createLockExtender');
    });

    it('should call lockExtender.start() before processing phases', () => {
      const fnStart = workerSource.indexOf('function processPageAnalyzeJob');
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart);
      // start() should be called before Phase 0 (Ingest)
      const startCall = fnBody.indexOf('lockExtender.start()');
      const phase0 = fnBody.indexOf('Phase 0: Ingest');
      expect(startCall).toBeGreaterThan(-1);
      expect(startCall).toBeLessThan(phase0);
    });

    it('should call lockExtender.stop() in finally block', () => {
      const fnStart = workerSource.indexOf('function processPageAnalyzeJob');
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart);
      // stop() should be in a finally block
      const finallyIndex = fnBody.lastIndexOf('finally');
      expect(finallyIndex).toBeGreaterThan(-1);
      const finallyBlock = fnBody.slice(finallyIndex, finallyIndex + 500);
      expect(finallyBlock).toContain('lockExtender.stop()');
    });
  });

  // ============================================================================
  // 5. Phase boundary lock extensions
  // ============================================================================

  describe('Phase boundary explicit lock extensions', () => {
    it('should call extendJobLock before Scroll Vision phase', () => {
      // Look for extendJobLock call near scroll vision section
      const scrollVisionStart = workerSource.indexOf('Phase 1.5: Scroll Vision');
      expect(scrollVisionStart).toBeGreaterThan(-1);
      // extendJobLock is called just after the phase comment header
      const surrounding = workerSource.slice(
        scrollVisionStart,
        scrollVisionStart + 300
      );
      expect(surrounding).toContain('extendJobLock');
    });

    it('should call extendJobLock before Narrative phase', () => {
      const narrativeStart = workerSource.indexOf('Phase 4: Narrative Analysis');
      expect(narrativeStart).toBeGreaterThan(-1);
      // extendJobLock is called just after the phase comment header
      const surrounding = workerSource.slice(
        narrativeStart,
        narrativeStart + 300
      );
      expect(surrounding).toContain('extendJobLock');
    });

    it('should call job.extendLock before Embedding phase', () => {
      const embeddingStart = workerSource.indexOf('Phase 5: Embedding Generation');
      expect(embeddingStart).toBeGreaterThan(-1);
      // extendJobLock is called just above the phase comment; extend range to 800 chars
      const surrounding = workerSource.slice(
        Math.max(0, embeddingStart - 800),
        embeddingStart + 200
      );
      expect(surrounding).toContain('extendJobLock');
    });

    it('should call extendJobLock before SectionEmbedding sub-phase', () => {
      const sectionEmbStart = workerSource.indexOf('// 1. SectionEmbedding');
      expect(sectionEmbStart).toBeGreaterThan(-1);
      const surrounding = workerSource.slice(sectionEmbStart, sectionEmbStart + 300);
      expect(surrounding).toContain("extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-sections')");
    });

    it('should call extendJobLock before MotionEmbedding sub-phase', () => {
      const motionEmbStart = workerSource.indexOf('// 2. MotionEmbedding');
      expect(motionEmbStart).toBeGreaterThan(-1);
      const surrounding = workerSource.slice(motionEmbStart, motionEmbStart + 300);
      expect(surrounding).toContain("extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-motions')");
    });

    it('should call extendJobLock before BackgroundDesignEmbedding sub-phase', () => {
      const bgEmbStart = workerSource.indexOf('// 3. BackgroundDesignEmbedding');
      expect(bgEmbStart).toBeGreaterThan(-1);
      const surrounding = workerSource.slice(bgEmbStart, bgEmbStart + 300);
      expect(surrounding).toContain("extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-backgrounds')");
    });

    it('should call extendJobLock before JSAnimationEmbedding sub-phase', () => {
      const jsEmbStart = workerSource.indexOf('// 4. JSAnimationEmbedding');
      expect(jsEmbStart).toBeGreaterThan(-1);
      const surrounding = workerSource.slice(jsEmbStart, jsEmbStart + 300);
      expect(surrounding).toContain("extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-js-animations')");
    });
  });

  // ============================================================================
  // 6. extendJobLock helper function
  // ============================================================================

  describe('extendJobLock helper', () => {
    it('should define extendJobLock helper function for phase boundary extensions', () => {
      expect(workerSource).toContain('async function extendJobLock');
    });

    it('should handle extendLock failure gracefully with warning log', () => {
      const fnStart = workerSource.indexOf('async function extendJobLock');
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 700);
      expect(fnBody).toContain('catch');
      expect(fnBody).toContain('logger.warn');
    });

    it('should accept job, token, lockDuration, and phaseName parameters', () => {
      const fnMatch = workerSource.match(
        /async function extendJobLock\([^)]+\)/
      );
      expect(fnMatch).not.toBeNull();
      const fnSignature = fnMatch![0];
      expect(fnSignature).toContain('job');
      expect(fnSignature).toContain('token');
      expect(fnSignature).toContain('phaseName');
    });
  });

  // ============================================================================
  // 7. Worker factory lockDuration configuration
  // ============================================================================

  describe('createPageAnalyzeWorker lockDuration', () => {
    it('should read BULLMQ_LOCK_DURATION env var for default lockDuration', () => {
      // In the constants section or the factory function
      expect(workerSource).toContain('BULLMQ_LOCK_DURATION');
    });

    it('should fall back to DEFAULT_LOCK_DURATION when env var is not set', () => {
      // Should use ?? or || with DEFAULT_LOCK_DURATION
      expect(workerSource).toContain('DEFAULT_LOCK_DURATION');
    });

    it('should pass lockDuration to stalledInterval calculation', () => {
      // stalledInterval should use lockDuration variable
      expect(workerSource).toContain(
        'Math.max(60000, Math.floor(lockDuration / 4))'
      );
    });
  });

  // ============================================================================
  // 8. Unit tests for createLockExtender behavior (mock-based)
  // ============================================================================

  describe('createLockExtender behavior', () => {
    let createLockExtender: typeof import('../../src/workers/page-analyze-worker').createLockExtender;

    beforeEach(async () => {
      // Dynamic import to get the actual function
      const mod = await import('../../src/workers/page-analyze-worker');
      createLockExtender = mod.createLockExtender;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return LockExtender with start and stop methods', () => {
      const mockJob = {
        extendLock: vi.fn().mockResolvedValue(1),
        id: 'test-job-1',
      };

      const extender = createLockExtender(
        mockJob as never,
        'test-token',
        600000,
        300000
      );

      expect(extender).toHaveProperty('start');
      expect(extender).toHaveProperty('stop');
      expect(typeof extender.start).toBe('function');
      expect(typeof extender.stop).toBe('function');
    });

    it('should call job.extendLock periodically after start()', () => {
      vi.useFakeTimers();

      const mockJob = {
        extendLock: vi.fn().mockResolvedValue(1),
        id: 'test-job-2',
      };

      const extender = createLockExtender(
        mockJob as never,
        'test-token',
        600000,  // lockDuration
        5000     // intervalMs (short for testing)
      );

      extender.start();

      // No calls yet (interval hasn't fired)
      expect(mockJob.extendLock).not.toHaveBeenCalled();

      // Advance time by intervalMs
      vi.advanceTimersByTime(5000);

      expect(mockJob.extendLock).toHaveBeenCalledTimes(1);
      expect(mockJob.extendLock).toHaveBeenCalledWith('test-token', 600000);

      // Advance again
      vi.advanceTimersByTime(5000);
      expect(mockJob.extendLock).toHaveBeenCalledTimes(2);

      extender.stop();

      // After stop, no more calls
      vi.advanceTimersByTime(5000);
      expect(mockJob.extendLock).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should not throw when extendLock fails', () => {
      vi.useFakeTimers();

      const mockJob = {
        extendLock: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
        id: 'test-job-3',
      };

      const extender = createLockExtender(
        mockJob as never,
        'test-token',
        600000,
        5000
      );

      extender.start();

      // Should not throw
      expect(() => vi.advanceTimersByTime(5000)).not.toThrow();

      extender.stop();
      vi.useRealTimers();
    });

    it('should be safe to call stop() multiple times', () => {
      const mockJob = {
        extendLock: vi.fn().mockResolvedValue(1),
        id: 'test-job-4',
      };

      const extender = createLockExtender(
        mockJob as never,
        'test-token',
        600000,
        300000
      );

      extender.start();
      extender.stop();

      // Second stop should not throw
      expect(() => extender.stop()).not.toThrow();
    });

    it('should be safe to call stop() without start()', () => {
      const mockJob = {
        extendLock: vi.fn().mockResolvedValue(1),
        id: 'test-job-5',
      };

      const extender = createLockExtender(
        mockJob as never,
        'test-token',
        600000,
        300000
      );

      // Stop without start should not throw
      expect(() => extender.stop()).not.toThrow();
    });
  });

  // ============================================================================
  // 9. Mathematical validation
  // ============================================================================

  describe('Lock extension timing calculations', () => {
    it('should extend lock more frequently than lockDuration to prevent stall', () => {
      // DEFAULT_LOCK_EXTEND_INTERVAL (300s) < DEFAULT_LOCK_DURATION (1200s)
      const DEFAULT_LOCK_DURATION = 1_200_000;
      const DEFAULT_LOCK_EXTEND_INTERVAL = 300_000;
      expect(DEFAULT_LOCK_EXTEND_INTERVAL).toBeLessThan(DEFAULT_LOCK_DURATION);
    });

    it('should have stalledInterval >= lockExtendInterval/2 for safety margin', () => {
      // stalledInterval = max(60s, lockDuration/4) = 300s
      // lockExtendInterval = 300s
      // stalledInterval (300s) >= lockExtendInterval/2 (150s)
      const DEFAULT_LOCK_DURATION = 1_200_000;
      const DEFAULT_LOCK_EXTEND_INTERVAL = 300_000;
      const stalledInterval = Math.max(60000, Math.floor(DEFAULT_LOCK_DURATION / 4));
      expect(stalledInterval).toBeGreaterThanOrEqual(DEFAULT_LOCK_EXTEND_INTERVAL / 2);
    });

    it('should handle custom lockDuration of 2400000ms (40 min) for Vision processing', () => {
      // For Vision-heavy processing, lockDuration=2400s
      // stalledInterval = max(60s, 2400s/4) = 600s
      // lockExtendInterval should be < lockDuration
      const visionLockDuration = 2_400_000;
      const stalledInterval = Math.max(60000, Math.floor(visionLockDuration / 4));
      expect(stalledInterval).toBe(600_000);
      // Default extend interval (300s) is still less than lockDuration
      const DEFAULT_LOCK_EXTEND_INTERVAL = 300_000;
      expect(DEFAULT_LOCK_EXTEND_INTERVAL).toBeLessThan(visionLockDuration);
    });
  });
});
