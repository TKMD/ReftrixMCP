// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Page Analyze Queue Tests
 *
 * Tests for BullMQ queue configuration and operations
 * Note: Some tests are skipped when Redis is not available
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  PAGE_ANALYZE_QUEUE_NAME,
  createPageAnalyzeQueue,
  createQueueEvents,
  addPageAnalyzeJob,
  getJobStatus,
  closeQueue,
  checkQueueHealth,
  type PageAnalyzeJobData,
  type PageAnalyzeJobResult,
  type PageAnalyzeJobOptions,
} from '../../src/queues/page-analyze-queue';
import { isRedisAvailable } from '../../src/config/redis';
import type { Queue } from 'bullmq';

describe('Page Analyze Queue', () => {
  describe('Constants and Types', () => {
    it('should have correct queue name', () => {
      expect(PAGE_ANALYZE_QUEUE_NAME).toBe('page-analyze');
    });
  });

  describe('PageAnalyzeJobData interface', () => {
    it('should accept valid job data structure', () => {
      const jobData: PageAnalyzeJobData = {
        webPageId: '019bc123-4567-7890-abcd-ef1234567890',
        url: 'https://example.com',
        options: {
          timeout: 60000,
          features: {
            layout: true,
            motion: true,
            quality: true,
          },
        },
        createdAt: new Date().toISOString(),
      };

      expect(jobData.webPageId).toBeDefined();
      expect(jobData.url).toBeDefined();
      expect(jobData.options).toBeDefined();
      expect(jobData.createdAt).toBeDefined();
    });

    it('should accept optional requestId', () => {
      const jobData: PageAnalyzeJobData = {
        webPageId: '019bc123-4567-7890-abcd-ef1234567890',
        url: 'https://example.com',
        options: {},
        createdAt: new Date().toISOString(),
        requestId: 'req-12345',
      };

      expect(jobData.requestId).toBe('req-12345');
    });

    it('should accept minimal options', () => {
      const jobData: PageAnalyzeJobData = {
        webPageId: '019bc123-4567-7890-abcd-ef1234567890',
        url: 'https://example.com',
        options: {},
        createdAt: new Date().toISOString(),
      };

      expect(jobData.options).toEqual({});
    });
  });

  describe('PageAnalyzeJobOptions interface', () => {
    it('should accept full options structure', () => {
      const options: PageAnalyzeJobOptions = {
        timeout: 120000,
        features: {
          layout: true,
          motion: false,
          quality: true,
        },
        layoutOptions: {
          useVision: true,
          saveToDb: true,
          autoAnalyze: true,
          fullPage: true,
          viewport: { width: 1920, height: 1080 },
        },
        motionOptions: {
          detectJsAnimations: true,
          enableFrameCapture: true,
          saveToDb: true,
          maxPatterns: 100,
        },
        qualityOptions: {
          strict: true,
          weights: {
            originality: 0.35,
            craftsmanship: 0.4,
            contextuality: 0.25,
          },
          targetIndustry: 'technology',
          targetAudience: 'enterprise',
        },
      };

      expect(options.timeout).toBe(120000);
      expect(options.features?.layout).toBe(true);
      expect(options.layoutOptions?.useVision).toBe(true);
      expect(options.motionOptions?.detectJsAnimations).toBe(true);
      expect(options.qualityOptions?.weights?.originality).toBe(0.35);
    });
  });

  describe('PageAnalyzeJobResult interface', () => {
    it('should accept success result structure', () => {
      const result: PageAnalyzeJobResult = {
        webPageId: '019bc123-4567-7890-abcd-ef1234567890',
        success: true,
        partialSuccess: false,
        completedPhases: ['ingest', 'layout', 'motion', 'quality'],
        failedPhases: [],
        results: {
          layout: {
            sectionsDetected: 5,
            visionUsed: true,
          },
          motion: {
            patternsDetected: 10,
            jsAnimationsDetected: 3,
          },
          quality: {
            overallScore: 85,
            grade: 'A',
          },
        },
        processingTimeMs: 15000,
        completedAt: new Date().toISOString(),
      };

      expect(result.success).toBe(true);
      expect(result.completedPhases).toHaveLength(4);
      expect(result.results?.layout?.sectionsDetected).toBe(5);
    });

    it('should accept failure result structure', () => {
      const result: PageAnalyzeJobResult = {
        webPageId: '019bc123-4567-7890-abcd-ef1234567890',
        success: false,
        partialSuccess: true,
        completedPhases: ['ingest', 'layout'],
        failedPhases: ['motion', 'quality'],
        error: 'Timeout during motion detection',
        processingTimeMs: 60000,
      };

      expect(result.success).toBe(false);
      expect(result.partialSuccess).toBe(true);
      expect(result.error).toBeDefined();
    });
  });

  describe('createPageAnalyzeQueue', () => {
    let queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult> | null = null;

    afterEach(async () => {
      if (queue) {
        await queue.close();
        queue = null;
      }
    });

    it('should create a queue with correct name', () => {
      queue = createPageAnalyzeQueue();

      expect(queue.name).toBe(PAGE_ANALYZE_QUEUE_NAME);
    });

    it('should create a queue with default job options', () => {
      queue = createPageAnalyzeQueue();

      // Check that queue was created (defaultJobOptions are internal)
      expect(queue).toBeDefined();
      expect(queue.name).toBe('page-analyze');
    });

    it('should accept custom Redis config', () => {
      queue = createPageAnalyzeQueue({
        host: 'custom-host',
        port: 12345,
      });

      expect(queue).toBeDefined();
    });
  });

  describe('createQueueEvents', () => {
    it('should create queue events instance', async () => {
      // Redisが利用可能かチェック
      const redisAvailable = await isRedisAvailable();
      if (!redisAvailable) {
        // Redisが利用できない場合はスキップ
        console.log('Skipping test: Redis not available');
        return;
      }

      const events = createQueueEvents();

      expect(events).toBeDefined();

      // Cleanup - use close with force option
      await events.close();
    }, 10000); // 10秒タイムアウト

    it('should accept custom Redis config (creation only)', () => {
      // Note: We only test creation, not connection, to avoid timeout issues
      // with invalid hostnames. The QueueEvents object will try to connect
      // but we don't wait for it.
      const events = createQueueEvents({
        host: '127.0.0.1', // Use localhost to avoid DNS lookup issues
        port: 12345, // Invalid port, but won't cause DNS issues
      });

      expect(events).toBeDefined();

      // Cleanup - don't await as it may hang with invalid config
      events.close().catch(() => {
        /* expected */
      });
    });
  });

  // Integration tests that require Redis
  describe('Queue Operations (requires Redis)', () => {
    let queue: Queue<PageAnalyzeJobData, PageAnalyzeJobResult> | null = null;
    let redisAvailable = false;

    beforeAll(async () => {
      redisAvailable = await isRedisAvailable();
    });

    beforeEach(async () => {
      if (redisAvailable) {
        queue = createPageAnalyzeQueue();
      }
    });

    afterEach(async () => {
      if (queue) {
        // Clean up test jobs
        await queue.obliterate({ force: true });
        await queue.close();
        queue = null;
      }
    });

    it.skipIf(!redisAvailable)('should add a job to the queue', async () => {
      if (!queue) return;

      const job = await addPageAnalyzeJob(queue, {
        webPageId: '019bc123-4567-7890-abcd-ef1234567890',
        url: 'https://example.com',
        options: {
          timeout: 60000,
          features: {
            layout: true,
            motion: true,
            quality: true,
          },
        },
      });

      expect(job).toBeDefined();
      expect(job.id).toBe('019bc123-4567-7890-abcd-ef1234567890');
      expect(job.data.url).toBe('https://example.com');
      expect(job.data.createdAt).toBeDefined();
    });

    it.skipIf(!redisAvailable)('should add a job with priority', async () => {
      if (!queue) return;

      const job = await addPageAnalyzeJob(
        queue,
        {
          webPageId: '019bc123-4567-7890-abcd-ef1234567891',
          url: 'https://example.com/priority',
          options: {},
        },
        5 // Higher priority (lower number)
      );

      expect(job).toBeDefined();
      expect(job.opts.priority).toBe(5);
    });

    it.skipIf(!redisAvailable)('should get job status', async () => {
      if (!queue) return;

      const webPageId = '019bc123-4567-7890-abcd-ef1234567892';

      await addPageAnalyzeJob(queue, {
        webPageId,
        url: 'https://example.com/status',
        options: {},
      });

      const status = await getJobStatus(queue, webPageId);

      expect(status).not.toBeNull();
      expect(status?.jobId).toBe(webPageId);
      expect(status?.state).toBe('waiting');
      expect(status?.progress).toBe(0);
    });

    it.skipIf(!redisAvailable)('should return null for non-existent job', async () => {
      if (!queue) return;

      const status = await getJobStatus(queue, 'non-existent-job-id');

      expect(status).toBeNull();
    });

    it.skipIf(!redisAvailable)('should check queue health', async () => {
      if (!queue) return;

      const health = await checkQueueHealth(queue);

      expect(health.healthy).toBe(true);
      expect(health.stats).toBeDefined();
      expect(typeof health.stats.waiting).toBe('number');
      expect(typeof health.stats.active).toBe('number');
      expect(typeof health.stats.completed).toBe('number');
      expect(typeof health.stats.failed).toBe('number');
      expect(typeof health.stats.delayed).toBe('number');
    });

    it.skipIf(!redisAvailable)('should serialize/deserialize job data correctly', async () => {
      if (!queue) return;

      const originalData = {
        webPageId: '019bc123-4567-7890-abcd-ef1234567893',
        url: 'https://example.com/serialization',
        options: {
          timeout: 120000,
          features: {
            layout: true,
            motion: false,
            quality: true,
          },
          layoutOptions: {
            viewport: { width: 1920, height: 1080 },
          },
        },
        requestId: 'test-request-123',
      };

      const job = await addPageAnalyzeJob(queue, originalData);

      // Retrieve the job
      const retrievedJob = await queue.getJob(originalData.webPageId);

      expect(retrievedJob).not.toBeNull();
      expect(retrievedJob?.data.url).toBe(originalData.url);
      expect(retrievedJob?.data.options.timeout).toBe(120000);
      expect(retrievedJob?.data.options.features?.motion).toBe(false);
      expect(retrievedJob?.data.options.layoutOptions?.viewport?.width).toBe(1920);
      expect(retrievedJob?.data.requestId).toBe('test-request-123');
    });

    it.skipIf(!redisAvailable)('should handle multiple jobs', async () => {
      if (!queue) return;

      const jobs = await Promise.all([
        addPageAnalyzeJob(queue, {
          webPageId: '019bc123-4567-7890-abcd-ef1234567894',
          url: 'https://example.com/page1',
          options: {},
        }),
        addPageAnalyzeJob(queue, {
          webPageId: '019bc123-4567-7890-abcd-ef1234567895',
          url: 'https://example.com/page2',
          options: {},
        }),
        addPageAnalyzeJob(queue, {
          webPageId: '019bc123-4567-7890-abcd-ef1234567896',
          url: 'https://example.com/page3',
          options: {},
        }),
      ]);

      expect(jobs).toHaveLength(3);

      const health = await checkQueueHealth(queue);
      expect(health.stats.waiting).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Graceful Degradation', () => {
    it('should handle queue creation when Redis is unavailable', () => {
      // This should not throw - queue creation is lazy
      // Use localhost to avoid DNS issues, just an unlikely port
      const queue = createPageAnalyzeQueue({
        host: '127.0.0.1',
        port: 59999,
      });

      expect(queue).toBeDefined();
      expect(queue.name).toBe(PAGE_ANALYZE_QUEUE_NAME);

      // Cleanup - don't wait for close since it can't connect
      queue.close().catch(() => {
        /* expected */
      });
    });

    // Note: Testing checkQueueHealth with unavailable Redis is skipped
    // because BullMQ Queue operations wait indefinitely for connection.
    // In production, this is handled by:
    // 1. isRedisAvailable() check before queue operations
    // 2. Connection timeouts at infrastructure level
    // 3. Monitoring and alerting on queue health metrics
    it.skip('should report unhealthy when Redis connection fails', async () => {
      // This test is skipped because BullMQ queue operations
      // don't have configurable timeouts and will wait for connection
    });
  });
});
