// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Memory Degradation Tests
 *
 * Tests for memory-aware phase degradation:
 * - checkMemoryPressure() thresholds
 * - HTML size pre-degradation
 * - Memory constants export
 *
 * @module tests/workers/page-analyze-worker-memory
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkMemoryPressure,
  tryGarbageCollect,
  MEMORY_DEGRADATION_THRESHOLD_MB,
  MEMORY_CRITICAL_THRESHOLD_MB,
  HTML_LARGE_THRESHOLD,
  HTML_HUGE_THRESHOLD,
} from '../../src/workers/page-analyze-worker';
import { resolveMemoryConfig } from '../../src/services/worker-memory-profile';

describe('PageAnalyzeWorker - Memory Degradation', () => {
  describe('Constants', () => {
    it('should export MEMORY_DEGRADATION_THRESHOLD_MB matching resolveMemoryConfig', () => {
      const config = resolveMemoryConfig();
      expect(MEMORY_DEGRADATION_THRESHOLD_MB).toBe(config.degradationThresholdMb);
    });

    it('should export MEMORY_CRITICAL_THRESHOLD_MB matching resolveMemoryConfig', () => {
      const config = resolveMemoryConfig();
      expect(MEMORY_CRITICAL_THRESHOLD_MB).toBe(config.criticalThresholdMb);
    });

    it('should have degradation threshold less than critical threshold', () => {
      expect(MEMORY_DEGRADATION_THRESHOLD_MB).toBeLessThan(MEMORY_CRITICAL_THRESHOLD_MB);
    });

    it('should export HTML_LARGE_THRESHOLD as 5000000', () => {
      expect(HTML_LARGE_THRESHOLD).toBe(5_000_000);
    });

    it('should export HTML_HUGE_THRESHOLD as 10000000', () => {
      expect(HTML_HUGE_THRESHOLD).toBe(10_000_000);
    });

    it('should have large threshold less than huge threshold', () => {
      expect(HTML_LARGE_THRESHOLD).toBeLessThan(HTML_HUGE_THRESHOLD);
    });
  });

  describe('checkMemoryPressure()', () => {
    it('should return an object with shouldDegrade, shouldAbort, and rssMb', () => {
      const result = checkMemoryPressure();
      expect(result).toHaveProperty('shouldDegrade');
      expect(result).toHaveProperty('shouldAbort');
      expect(result).toHaveProperty('rssMb');
      expect(typeof result.shouldDegrade).toBe('boolean');
      expect(typeof result.shouldAbort).toBe('boolean');
      expect(typeof result.rssMb).toBe('number');
    });

    it('should return rssMb as a positive integer', () => {
      const result = checkMemoryPressure();
      expect(result.rssMb).toBeGreaterThan(0);
      expect(Number.isInteger(result.rssMb)).toBe(true);
    });

    it('should report no degradation needed in test environment (RSS << 3GB)', () => {
      // In test environment, RSS should be well below 3GB
      const result = checkMemoryPressure();
      expect(result.shouldDegrade).toBe(false);
      expect(result.shouldAbort).toBe(false);
    });

    it('should accurately reflect process.memoryUsage().rss', () => {
      const result = checkMemoryPressure();
      const actualRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      // Allow small variance (memory can change between calls)
      expect(Math.abs(result.rssMb - actualRss)).toBeLessThan(50);
    });
  });

  describe('HTML size thresholds logic', () => {
    it('should consider 100KB HTML as normal (no degradation)', () => {
      const htmlLength = 100_000;
      expect(htmlLength < HTML_LARGE_THRESHOLD).toBe(true);
    });

    it('should consider 6MB HTML as large (vision disabled)', () => {
      const htmlLength = 6_000_000;
      expect(htmlLength > HTML_LARGE_THRESHOLD).toBe(true);
      expect(htmlLength < HTML_HUGE_THRESHOLD).toBe(true);
    });

    it('should consider 11MB HTML as huge (narrative+vision disabled)', () => {
      const htmlLength = 11_000_000;
      expect(htmlLength > HTML_HUGE_THRESHOLD).toBe(true);
    });
  });

  describe('Worker source code memory checks', () => {
    // Verify the worker has memory checks in the right places
    const workerSourcePath = require('node:path').resolve(
      __dirname,
      '../../src/workers/page-analyze-worker.ts'
    );
    const workerSource = require('node:fs').readFileSync(workerSourcePath, 'utf8');

    it('should have Memory Check 1 before Quality phase', () => {
      const memCheck1Pos = workerSource.indexOf('Memory Check 1: Before Phase 3');
      const qualityPhasePos = workerSource.indexOf('Phase 3: Quality Evaluation');
      expect(memCheck1Pos).toBeGreaterThan(-1);
      expect(qualityPhasePos).toBeGreaterThan(-1);
      expect(memCheck1Pos).toBeLessThan(qualityPhasePos);
    });

    it('should have Memory Check 2 before Narrative phase', () => {
      const memCheck2Pos = workerSource.indexOf('Memory Check 2: Before Phase 4');
      const narrativePhasePos = workerSource.indexOf('Phase 4: Narrative Analysis');
      expect(memCheck2Pos).toBeGreaterThan(-1);
      expect(narrativePhasePos).toBeGreaterThan(-1);
      expect(memCheck2Pos).toBeLessThan(narrativePhasePos);
    });

    it('should have Memory Check 3 before Embedding phase', () => {
      const memCheck3Pos = workerSource.indexOf('Memory Check 3: Before Phase 5');
      const embeddingPhasePos = workerSource.indexOf('Phase 5: Embedding Generation');
      expect(memCheck3Pos).toBeGreaterThan(-1);
      expect(embeddingPhasePos).toBeGreaterThan(-1);
      expect(memCheck3Pos).toBeLessThan(embeddingPhasePos);
    });

    it('should have HTML size pre-degradation check after ingest', () => {
      const htmlCheckPos = workerSource.indexOf('HTML size pre-degradation check');
      const phase05Pos = workerSource.indexOf('Phase 0.5: WebPage DB保存');
      expect(htmlCheckPos).toBeGreaterThan(-1);
      expect(phase05Pos).toBeGreaterThan(-1);
      expect(htmlCheckPos).toBeLessThan(phase05Pos);
    });

    it('should skip quality phase when memoryAborted is true', () => {
      expect(workerSource).toContain('!memoryAborted && options.features?.quality !== false');
    });

    it('should skip narrative phase when narrativePreDisabled is true', () => {
      expect(workerSource).toContain('!memoryAborted && !narrativePreDisabled');
    });

    it('should override vision option when visionPreDisabled', () => {
      expect(workerSource).toContain('visionPreDisabled ? false');
    });

    it('should have memory cleanup after ingestResult release (before Layout)', () => {
      const cleanupPos = workerSource.indexOf('[MemCleanup] ingestResult released');
      const layoutPhasePos = workerSource.indexOf('Phase 1: Layout Analysis');
      expect(cleanupPos).toBeGreaterThan(-1);
      expect(layoutPhasePos).toBeGreaterThan(-1);
      expect(cleanupPos).toBeLessThan(layoutPhasePos);
    });

    it('should have memory cleanup after Layout/ScrollVision (before Motion)', () => {
      const cleanupPos = workerSource.indexOf('[MemCleanup] Post-Layout/ScrollVision GC');
      const motionPhasePos = workerSource.indexOf('Phase 2: Motion Detection');
      expect(cleanupPos).toBeGreaterThan(-1);
      expect(motionPhasePos).toBeGreaterThan(-1);
      expect(cleanupPos).toBeLessThan(motionPhasePos);
    });

    it('should have memory cleanup after Motion (before Memory Check 1)', () => {
      const cleanupPos = workerSource.indexOf('[MemCleanup] Post-Motion GC');
      const memCheck1Pos = workerSource.indexOf('Memory Check 1: Before Phase 3');
      expect(cleanupPos).toBeGreaterThan(-1);
      expect(memCheck1Pos).toBeGreaterThan(-1);
      expect(cleanupPos).toBeLessThan(memCheck1Pos);
    });

    it('should have memory cleanup after Quality (before Memory Check 2)', () => {
      const cleanupPos = workerSource.indexOf('[MemCleanup] Post-Quality GC');
      const memCheck2Pos = workerSource.indexOf('Memory Check 2: Before Phase 4');
      expect(cleanupPos).toBeGreaterThan(-1);
      expect(memCheck2Pos).toBeGreaterThan(-1);
      expect(cleanupPos).toBeLessThan(memCheck2Pos);
    });

    it('should have memory cleanup after Narrative (before Memory Check 3)', () => {
      const cleanupPos = workerSource.indexOf('[MemCleanup] Post-Narrative GC');
      const memCheck3Pos = workerSource.indexOf('Memory Check 3: Before Phase 5');
      expect(cleanupPos).toBeGreaterThan(-1);
      expect(memCheck3Pos).toBeGreaterThan(-1);
      expect(cleanupPos).toBeLessThan(memCheck3Pos);
    });

    it('should have final memory cleanup after Embedding (before Finalize)', () => {
      const cleanupPos = workerSource.indexOf('[MemCleanup] Post-Embedding final cleanup');
      const finalizePos = workerSource.indexOf('// Finalize');
      expect(cleanupPos).toBeGreaterThan(-1);
      expect(finalizePos).toBeGreaterThan(-1);
      expect(cleanupPos).toBeLessThan(finalizePos);
    });

    it('should have memory cleanup comment after Phase 0.5 (ingestResult)', () => {
      expect(workerSource).toContain('[MemCleanup] ingestResult released');
    });

    it('should release layoutResultForNarrative after Embedding', () => {
      expect(workerSource).toContain('layoutResultForNarrative = null');
    });

    it('should release motionResultForEmbedding after Embedding', () => {
      expect(workerSource).toContain('motionResultForEmbedding = null');
    });

    it('should release scrollVisionResultForEmbedding after Embedding', () => {
      expect(workerSource).toContain('scrollVisionResultForEmbedding = null');
    });

    it('should extract screenshotBase64 from ingestResult before release', () => {
      expect(workerSource).toContain('let screenshotBase64');
      // Verify screenshotBase64 is used instead of ingestResult.screenshots
      const screenshotUsages = workerSource.match(/screenshotBase64/g);
      expect(screenshotUsages).not.toBeNull();
      expect(screenshotUsages!.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('tryGarbageCollect()', () => {
    it('should be exported as a function', () => {
      expect(typeof tryGarbageCollect).toBe('function');
    });

    it('should return a boolean', () => {
      const result = tryGarbageCollect();
      expect(typeof result).toBe('boolean');
    });

    it('should not throw even when global.gc is unavailable', () => {
      // In test environment, global.gc may or may not be available
      expect(() => tryGarbageCollect()).not.toThrow();
    });
  });

  describe('checkMemoryPressure() with GC integration', () => {
    it('should call GC before measuring RSS (if available)', () => {
      // Verify that checkMemoryPressure uses tryGarbageCollect internally
      // by checking the source code
      const workerSourcePath = require('node:path').resolve(
        __dirname,
        '../../src/workers/page-analyze-worker.ts'
      );
      const workerSource = require('node:fs').readFileSync(workerSourcePath, 'utf8');

      // Find checkMemoryPressure function and verify it calls tryGarbageCollect
      const funcStart = workerSource.indexOf('function checkMemoryPressure()');
      const funcEnd = workerSource.indexOf('}', workerSource.indexOf('return {', funcStart));
      const funcBody = workerSource.slice(funcStart, funcEnd);

      expect(funcBody).toContain('tryGarbageCollect()');
    });
  });
});
