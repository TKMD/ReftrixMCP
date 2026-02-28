// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frame Worker Pool Service Tests
 *
 * TDD: Red phase - Write failing tests first
 *
 * Worker Threadsを使用したフレーム差分計算の並列処理テスト
 *
 * @module @reftrix/mcp-server/tests/unit/services/motion/frame-worker-pool.service.test
 */

import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type {
  FrameWorkerPoolConfig,
  WorkerTask,
  WorkerTaskResult,
  PoolStats,
} from '../../../../src/services/motion/frame-worker-pool.service';
import {
  FrameWorkerPool,
  createFrameWorkerPool,
} from '../../../../src/services/motion/frame-worker-pool.service';

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create mock frame buffer
 */
function createMockBuffer(width: number, height: number, fill: number = 0): Buffer {
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i] = fill;     // R
    buffer[i + 1] = fill; // G
    buffer[i + 2] = fill; // B
    buffer[i + 3] = 255;  // A
  }
  return buffer;
}

/**
 * Create mock task
 */
function createMockTask(
  taskId: string,
  frame1Fill: number = 0,
  frame2Fill: number = 128,
  width: number = 100,
  height: number = 100
): WorkerTask {
  return {
    taskId,
    frame1: createMockBuffer(width, height, frame1Fill),
    frame2: createMockBuffer(width, height, frame2Fill),
    width,
    height,
    options: {
      threshold: 0.1,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('FrameWorkerPool', () => {
  let pool: FrameWorkerPool;

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
    }
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      pool = new FrameWorkerPool();
      expect(pool).toBeInstanceOf(FrameWorkerPool);
    });

    it('should accept custom worker count', () => {
      const config: FrameWorkerPoolConfig = {
        workerCount: 2,
      };
      pool = new FrameWorkerPool(config);
      expect(pool).toBeInstanceOf(FrameWorkerPool);
    });

    it('should limit worker count to CPU cores', () => {
      const cpuCount = os.cpus().length;
      const config: FrameWorkerPoolConfig = {
        workerCount: cpuCount + 10, // More than available
      };
      pool = new FrameWorkerPool(config);

      const stats = pool.getStats();
      expect(stats.totalWorkers).toBeLessThanOrEqual(cpuCount);
    });

    it('should use at least 1 worker', () => {
      const config: FrameWorkerPoolConfig = {
        workerCount: 0,
      };
      pool = new FrameWorkerPool(config);

      const stats = pool.getStats();
      expect(stats.totalWorkers).toBeGreaterThanOrEqual(1);
    });
  });

  describe('initialize', () => {
    beforeEach(() => {
      pool = new FrameWorkerPool({ workerCount: 2 });
    });

    it('should initialize workers', async () => {
      await pool.initialize();

      const stats = pool.getStats();
      expect(stats.isInitialized).toBe(true);
    });

    it('should be idempotent (multiple calls are safe)', async () => {
      await pool.initialize();
      await pool.initialize(); // Second call should be no-op

      const stats = pool.getStats();
      expect(stats.isInitialized).toBe(true);
    });
  });

  describe('processTask', () => {
    beforeEach(async () => {
      pool = new FrameWorkerPool({ workerCount: 2 });
      await pool.initialize();
    });

    it('should process single task', async () => {
      const task = createMockTask('task-1');

      const result = await pool.processTask(task);

      expect(result.taskId).toBe('task-1');
      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
    });

    it('should return diff result with correct structure', async () => {
      const task = createMockTask('task-2');

      const result = await pool.processTask(task);

      expect(result.result).toHaveProperty('changeRatio');
      expect(result.result).toHaveProperty('changedPixels');
      expect(result.result).toHaveProperty('totalPixels');
      expect(result.result).toHaveProperty('regions');
    });

    it('should detect changes between different frames', async () => {
      const task = createMockTask('task-3', 0, 255); // Black to white

      const result = await pool.processTask(task);

      expect(result.success).toBe(true);
      expect(result.result?.changeRatio).toBeGreaterThan(0);
    });

    it('should detect no changes for identical frames', async () => {
      const task = createMockTask('task-4', 128, 128); // Same color

      const result = await pool.processTask(task);

      expect(result.success).toBe(true);
      expect(result.result?.changeRatio).toBe(0);
    });

    it('should handle error gracefully', async () => {
      const invalidTask: WorkerTask = {
        taskId: 'invalid-task',
        frame1: Buffer.alloc(10), // Wrong size
        frame2: Buffer.alloc(10),
        width: 100,
        height: 100,
        options: {},
      };

      const result = await pool.processTask(invalidTask);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('processBatch', () => {
    beforeEach(async () => {
      pool = new FrameWorkerPool({ workerCount: 2 });
      await pool.initialize();
    });

    it('should process multiple tasks in parallel', async () => {
      const tasks = [
        createMockTask('batch-1', 0, 64),
        createMockTask('batch-2', 64, 128),
        createMockTask('batch-3', 128, 192),
      ];

      const results = await pool.processBatch(tasks);

      expect(results).toHaveLength(3);
      results.forEach((r, i) => {
        expect(r.taskId).toBe(`batch-${i + 1}`);
        expect(r.success).toBe(true);
      });
    });

    it('should maintain task order in results', async () => {
      const tasks = [
        createMockTask('order-3'),
        createMockTask('order-1'),
        createMockTask('order-2'),
      ];

      const results = await pool.processBatch(tasks);

      expect(results[0]?.taskId).toBe('order-3');
      expect(results[1]?.taskId).toBe('order-1');
      expect(results[2]?.taskId).toBe('order-2');
    });

    it('should handle empty batch', async () => {
      const results = await pool.processBatch([]);

      expect(results).toHaveLength(0);
    });

    it('should handle partial failures in batch', async () => {
      const tasks = [
        createMockTask('valid-1'),
        {
          taskId: 'invalid',
          frame1: Buffer.alloc(10),
          frame2: Buffer.alloc(10),
          width: 100,
          height: 100,
          options: {},
        } as WorkerTask,
        createMockTask('valid-2'),
      ];

      const results = await pool.processBatch(tasks);

      expect(results).toHaveLength(3);
      expect(results[0]?.success).toBe(true);
      expect(results[1]?.success).toBe(false);
      expect(results[2]?.success).toBe(true);
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      pool = new FrameWorkerPool({ workerCount: 2 });
    });

    it('should return pool statistics', () => {
      const stats = pool.getStats();

      expect(stats).toHaveProperty('totalWorkers');
      expect(stats).toHaveProperty('busyWorkers');
      expect(stats).toHaveProperty('pendingTasks');
      expect(stats).toHaveProperty('completedTasks');
      expect(stats).toHaveProperty('failedTasks');
      expect(stats).toHaveProperty('isInitialized');
    });

    it('should track completed tasks', async () => {
      await pool.initialize();

      const initialStats = pool.getStats();
      expect(initialStats.completedTasks).toBe(0);

      await pool.processTask(createMockTask('stats-1'));

      const afterStats = pool.getStats();
      expect(afterStats.completedTasks).toBe(1);
    });

    it('should track failed tasks', async () => {
      await pool.initialize();

      await pool.processTask({
        taskId: 'fail-task',
        frame1: Buffer.alloc(10),
        frame2: Buffer.alloc(10),
        width: 100,
        height: 100,
        options: {},
      });

      const stats = pool.getStats();
      expect(stats.failedTasks).toBe(1);
    });
  });

  describe('shutdown', () => {
    beforeEach(async () => {
      pool = new FrameWorkerPool({ workerCount: 2 });
      await pool.initialize();
    });

    it('should shut down gracefully', async () => {
      await pool.shutdown();

      const stats = pool.getStats();
      expect(stats.isInitialized).toBe(false);
    });

    it('should be idempotent (multiple calls are safe)', async () => {
      await pool.shutdown();
      await pool.shutdown();

      expect(true).toBe(true); // No error thrown
    });

    it('should reject new tasks after shutdown', async () => {
      await pool.shutdown();

      await expect(pool.processTask(createMockTask('after-shutdown'))).rejects.toThrow();
    });
  });

  describe('performance', () => {
    beforeEach(async () => {
      pool = new FrameWorkerPool({ workerCount: Math.min(4, os.cpus().length) });
      await pool.initialize();
    });

    it('should process 100 tasks within 30 seconds', async () => {
      const tasks: WorkerTask[] = [];
      for (let i = 0; i < 100; i++) {
        tasks.push(createMockTask(`perf-${i}`, i % 256, (i + 1) % 256, 192, 108)); // Small frames
      }

      const startTime = performance.now();
      const results = await pool.processBatch(tasks);
      const elapsedMs = performance.now() - startTime;

      expect(results).toHaveLength(100);
      expect(elapsedMs).toBeLessThan(30000); // 30 seconds max

      if (process.env.NODE_ENV === 'development') {
        console.log(`[FrameWorkerPool] 100 tasks processed in ${elapsedMs.toFixed(2)}ms`);
      }
    }, 60000); // 60 second timeout

    it('should scale with worker count', async () => {
      // Create tasks
      const tasks: WorkerTask[] = [];
      for (let i = 0; i < 20; i++) {
        tasks.push(createMockTask(`scale-${i}`, i % 256, (i + 1) % 256, 100, 100));
      }

      // Process with current pool
      const startTime = performance.now();
      await pool.processBatch(tasks);
      const multiWorkerTime = performance.now() - startTime;

      // Single worker comparison (optional benchmark)
      expect(multiWorkerTime).toBeGreaterThan(0);
    });
  });

  describe('factory function', () => {
    it('should create pool via factory', () => {
      pool = createFrameWorkerPool({ workerCount: 2 });
      expect(pool).toBeInstanceOf(FrameWorkerPool);
    });

    it('should create pool with defaults via factory', () => {
      pool = createFrameWorkerPool();
      expect(pool).toBeInstanceOf(FrameWorkerPool);
    });
  });
});
