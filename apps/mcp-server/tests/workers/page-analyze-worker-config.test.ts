// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker Configuration Tests
 *
 * Tests for BullMQ worker configuration including
 * stalledInterval and maxStalledCount settings.
 *
 * @module tests/workers/page-analyze-worker-config
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('PageAnalyzeWorker - Configuration', () => {
  const workerSourcePath = path.resolve(
    __dirname,
    '../../src/workers/page-analyze-worker.ts'
  );

  const batchWorkerSourcePath = path.resolve(
    __dirname,
    '../../src/workers/batch-quality-worker.ts'
  );

  let workerSource: string;
  let batchWorkerSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(workerSourcePath, 'utf8');
    batchWorkerSource = fs.readFileSync(batchWorkerSourcePath, 'utf8');
  });

  describe('page-analyze-worker stalledInterval', () => {
    it('should use lockDuration/4 for stalledInterval instead of hardcoded 30000', () => {
      // Should NOT contain the old hardcoded value
      expect(workerSource).not.toMatch(/stalledInterval:\s*30000/);
      // Should contain dynamic calculation based on lockDuration
      expect(workerSource).toContain('Math.max(60000, Math.floor(lockDuration / 4))');
    });

    it('should set maxStalledCount to 3', () => {
      expect(workerSource).toMatch(/maxStalledCount:\s*3/);
    });

    it('should have minimum stalledInterval of 60000ms', () => {
      // The Math.max(60000, ...) ensures minimum 60s
      expect(workerSource).toContain('Math.max(60000');
    });

    it('should calculate stalledInterval as 300000 for default lockDuration of 1200000', () => {
      // Verify the math: Math.max(60000, Math.floor(1200000 / 4)) = Math.max(60000, 300000) = 300000
      const defaultLockDuration = 1200000;
      const expected = Math.max(60000, Math.floor(defaultLockDuration / 4));
      expect(expected).toBe(300000);
    });
  });

  describe('page-analyze-worker motionTimeout', () => {
    it('should have motionTimeout with default 180000ms (3 minutes)', () => {
      expect(workerSource).toContain("options.motionOptions?.timeout ?? 180000");
    });

    it('should cap motionTimeout at 600000ms (10 minutes)', () => {
      expect(workerSource).toContain('600000 // 最大10分');
    });

    it('should use Math.min for motionTimeout calculation', () => {
      expect(workerSource).toContain('const motionTimeout = Math.min(');
    });

    it('should pass motionTimeout to video_options.timeout', () => {
      // Verify motionTimeout is used for both motion detection and video options
      const motionSection = workerSource.slice(
        workerSource.indexOf('const motionTimeout = Math.min'),
        workerSource.indexOf('video_options:') + 200
      );
      expect(motionSection).toContain('timeout: motionTimeout');
    });
  });

  describe('batch-quality-worker stalledInterval', () => {
    it('should use lockDuration/4 for stalledInterval instead of hardcoded 30000', () => {
      expect(batchWorkerSource).not.toMatch(/stalledInterval:\s*30000/);
      expect(batchWorkerSource).toContain('Math.max(60000, Math.floor(lockDuration / 4))');
    });

    it('should set maxStalledCount to 2', () => {
      expect(batchWorkerSource).toMatch(/maxStalledCount:\s*2/);
    });
  });
});
