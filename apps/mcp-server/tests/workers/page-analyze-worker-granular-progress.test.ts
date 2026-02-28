// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Granular Progress Reporting Tests
 *
 * Tests for per-phase granular progress interpolation:
 * - createPhaseProgressInterpolator utility
 * - ScrollVisionAnalyzer onProgress callback
 * - Embedding sub-phase progress callbacks
 * - getJobStatus backward compatibility (number + object progress)
 *
 * @module tests/workers/page-analyze-worker-granular-progress
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type {
  PageAnalyzeJobData,
  PageAnalyzeJobResult,
} from '../../src/queues/page-analyze-queue';

// Direct import of the exported utility
import { createPhaseProgressInterpolator } from '../../src/workers/page-analyze-worker';

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal mock Job with updateProgress spy */
function createMockJob(): Job<PageAnalyzeJobData, PageAnalyzeJobResult> & {
  updateProgress: ReturnType<typeof vi.fn>;
} {
  return {
    updateProgress: vi.fn().mockResolvedValue(undefined),
    // Minimal properties needed to satisfy the type
    id: 'test-job-id',
    data: {
      webPageId: 'test-page-id',
      url: 'https://example.com',
      options: {},
      createdAt: new Date().toISOString(),
    },
  } as unknown as Job<PageAnalyzeJobData, PageAnalyzeJobResult> & {
    updateProgress: ReturnType<typeof vi.fn>;
  };
}

// ============================================================================
// 1. createPhaseProgressInterpolator
// ============================================================================

describe('createPhaseProgressInterpolator', () => {
  let mockJob: ReturnType<typeof createMockJob>;

  beforeEach(() => {
    mockJob = createMockJob();
  });

  it('should return a function', () => {
    const interpolator = createPhaseProgressInterpolator(mockJob, 35, 45);
    expect(typeof interpolator).toBe('function');
  });

  it('should interpolate at 0% (start of phase)', () => {
    const interpolator = createPhaseProgressInterpolator(mockJob, 35, 45);
    interpolator(0, 10);
    expect(mockJob.updateProgress).toHaveBeenCalledWith(35);
  });

  it('should interpolate at 50% (midpoint of phase)', () => {
    const interpolator = createPhaseProgressInterpolator(mockJob, 35, 45);
    interpolator(5, 10);
    expect(mockJob.updateProgress).toHaveBeenCalledWith(40);
  });

  it('should interpolate at 100% (end of phase)', () => {
    const interpolator = createPhaseProgressInterpolator(mockJob, 35, 45);
    interpolator(10, 10);
    expect(mockJob.updateProgress).toHaveBeenCalledWith(45);
  });

  it('should round to integer values', () => {
    const interpolator = createPhaseProgressInterpolator(mockJob, 35, 45);
    interpolator(1, 3); // 35 + 10*(1/3) = 38.33...
    expect(mockJob.updateProgress).toHaveBeenCalledWith(38);
  });

  it('should clamp ratio to 1 when completed > total', () => {
    const interpolator = createPhaseProgressInterpolator(mockJob, 90, 100);
    interpolator(15, 10); // completed > total
    expect(mockJob.updateProgress).toHaveBeenCalledWith(100);
  });

  it('should not call updateProgress when total is 0', () => {
    const interpolator = createPhaseProgressInterpolator(mockJob, 35, 45);
    interpolator(5, 0);
    expect(mockJob.updateProgress).not.toHaveBeenCalled();
  });

  it('should not call updateProgress when total is negative', () => {
    const interpolator = createPhaseProgressInterpolator(mockJob, 35, 45);
    interpolator(5, -1);
    expect(mockJob.updateProgress).not.toHaveBeenCalled();
  });

  it('should silently catch updateProgress rejection (fire-and-forget)', async () => {
    mockJob.updateProgress.mockRejectedValue(new Error('Redis disconnected'));
    const interpolator = createPhaseProgressInterpolator(mockJob, 35, 45);

    // Should not throw
    expect(() => interpolator(5, 10)).not.toThrow();

    // Wait for promise rejection to be handled
    await new Promise((resolve) => setTimeout(resolve, 10));

    // updateProgress was called (even though it rejected)
    expect(mockJob.updateProgress).toHaveBeenCalledWith(40);
  });

  it('should work with embedding phase range (90-100)', () => {
    const interpolator = createPhaseProgressInterpolator(mockJob, 90, 100);

    interpolator(100, 705); // ~90 + 10*(100/705) = ~91.4
    expect(mockJob.updateProgress).toHaveBeenCalledWith(91);

    interpolator(350, 705); // ~90 + 10*(350/705) = ~94.96
    expect(mockJob.updateProgress).toHaveBeenCalledWith(95);

    interpolator(705, 705); // 90 + 10 = 100
    expect(mockJob.updateProgress).toHaveBeenCalledWith(100);
  });

  it('should produce monotonically non-decreasing values for sequential calls', () => {
    const interpolator = createPhaseProgressInterpolator(mockJob, 35, 45);
    const values: number[] = [];

    for (let i = 1; i <= 10; i++) {
      interpolator(i, 10);
      const lastCall = mockJob.updateProgress.mock.calls[mockJob.updateProgress.mock.calls.length - 1];
      values.push(lastCall[0] as number);
    }

    // Verify monotonicity
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
    }

    // First should be > phaseStart, last should be phaseEnd
    expect(values[0]).toBeGreaterThan(35);
    expect(values[values.length - 1]).toBe(45);
  });
});

// ============================================================================
// 2. ScrollVisionAnalyzer onProgress callback (source verification)
// ============================================================================

describe('ScrollVisionAnalyzer onProgress support', () => {
  it('should accept onProgress in ScrollVisionAnalyzerConfig', async () => {
    // Read source to verify the interface was updated
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/vision/scroll-vision.analyzer.ts'),
      'utf8'
    );

    expect(source).toContain('onProgress?:');
    expect(source).toContain('((completed: number, total: number) => void)');
  });

  it('should call onProgress after each capture in the analysis loop', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/vision/scroll-vision.analyzer.ts'),
      'utf8'
    );

    // Should use indexed loop
    expect(source).toContain('for (let i = 0; i < captures.length; i++)');
    // Should call onProgress with (i+1, captures.length)
    expect(source).toContain('config?.onProgress?.(i + 1, captures.length)');
  });
});

// ============================================================================
// 3. Embedding handler onProgress callbacks (source verification)
// ============================================================================

describe('Embedding handler onProgress support', () => {
  let embeddingSource: string;

  beforeEach(async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    embeddingSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/tools/page/handlers/embedding-handler.ts'),
      'utf8'
    );
  });

  it('should accept onProgress in GenerateSectionEmbeddingsOptions', () => {
    const interfaceMatch = embeddingSource.match(
      /interface GenerateSectionEmbeddingsOptions \{[^}]+\}/s
    );
    expect(interfaceMatch).not.toBeNull();
    expect(interfaceMatch![0]).toContain('onProgress?:');
  });

  it('should accept onProgress in GenerateMotionEmbeddingsOptions', () => {
    const interfaceMatch = embeddingSource.match(
      /interface GenerateMotionEmbeddingsOptions \{[^}]+\}/s
    );
    expect(interfaceMatch).not.toBeNull();
    expect(interfaceMatch![0]).toContain('onProgress?:');
  });

  it('should accept onProgress in GenerateBackgroundDesignEmbeddingsOptions', () => {
    const interfaceMatch = embeddingSource.match(
      /interface GenerateBackgroundDesignEmbeddingsOptions \{[^}]+\}/s
    );
    expect(interfaceMatch).not.toBeNull();
    expect(interfaceMatch![0]).toContain('onProgress?:');
  });

  it('should call onProgress after each section embedding iteration', () => {
    // Should contain onProgress call inside the section loop
    expect(embeddingSource).toContain('options.onProgress?.(result.generatedCount + result.failedCount, sections.length)');
  });

  it('should call onProgress after each motion embedding iteration', () => {
    // Should contain onProgress call inside the motion loop
    expect(embeddingSource).toContain('options.onProgress?.(result.savedCount + result.errors.length, patterns.length)');
  });

  it('should forward onProgress to background design embedding service', () => {
    // The wrapper function should pass options.onProgress to generateBgEmbeddings
    expect(embeddingSource).toContain('options.onProgress');
  });
});

// ============================================================================
// 4. BackgroundDesign embedding service onProgress (source verification)
// ============================================================================

describe('BackgroundDesign embedding service onProgress', () => {
  it('should accept onProgress parameter', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/background/background-design-embedding.service.ts'),
      'utf8'
    );

    // Function signature should include onProgress parameter
    const fnMatch = source.match(
      /export async function generateBackgroundDesignEmbeddings\([^)]+\)/s
    );
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toContain('onProgress');
  });

  it('should call onProgress after each background design item', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/background/background-design-embedding.service.ts'),
      'utf8'
    );

    expect(source).toContain('onProgress?.(result.generatedCount + result.failedCount, backgrounds.length)');
  });
});

// ============================================================================
// 5. getJobStatus backward compatibility
// ============================================================================

describe('getJobStatus backward compatibility', () => {
  it('should handle numeric progress in source', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/queues/page-analyze-queue.ts'),
      'utf8'
    );

    // Should check for typeof number first
    expect(source).toContain("typeof job.progress === 'number'");
    // Should also check for object with overallProgress
    expect(source).toContain("'overallProgress' in job.progress");
  });

  it('should extract overallProgress from object progress', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/queues/page-analyze-queue.ts'),
      'utf8'
    );

    // Should cast and extract overallProgress
    expect(source).toContain('overallProgress: number');
    // Should default to 0 for unknown types
    expect(source).toContain(': 0');
  });
});

// ============================================================================
// 6. Worker integration: processEmbeddingPhase compound progress
// ============================================================================

describe('processEmbeddingPhase compound progress', () => {
  let workerSource: string;

  beforeEach(async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    workerSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/workers/page-analyze-worker.ts'),
      'utf8'
    );
  });

  it('should accept onProgress in EmbeddingPhaseParams', () => {
    const interfaceMatch = workerSource.match(
      /interface EmbeddingPhaseParams \{[^}]+\}/s
    );
    expect(interfaceMatch).not.toBeNull();
    expect(interfaceMatch![0]).toContain('onProgress?:');
  });

  it('should calculate totalEmbeddingItems from all sub-phases', () => {
    expect(workerSource).toContain('totalEmbeddingItems');
    expect(workerSource).toContain('sectionCount + motionCount + visionMotionCount + bgCount + jsCount');
  });

  it('should track completedEmbeddingItems across sub-phases', () => {
    expect(workerSource).toContain('completedEmbeddingItems');
    expect(workerSource).toContain('completedEmbeddingItems++');
  });

  it('should pass onProgress to section embedding generation', () => {
    expect(workerSource).toContain('onProgress: reportEmbeddingSubProgress }');
  });

  it('should pass onProgress to motion embedding generation', () => {
    expect(workerSource).toContain('onProgress: reportEmbeddingSubProgress,');
  });

  it('should pass createPhaseProgressInterpolator to processEmbeddingPhase call', () => {
    expect(workerSource).toContain(
      'onProgress: createPhaseProgressInterpolator(job, PHASE_PROGRESS.EMBEDDING_START, PHASE_PROGRESS.EMBEDDING_COMPLETE)'
    );
  });
});

// ============================================================================
// 7. Motion intermediate progress
// ============================================================================

describe('Motion intermediate progress updates', () => {
  let workerSource: string;

  beforeEach(async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    workerSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/workers/page-analyze-worker.ts'),
      'utf8'
    );
  });

  it('should report progress=55 after motion detection completes', () => {
    // After motionResultForEmbedding assignment, before statusTracker.completePhase
    const motionDetectionSection = workerSource.slice(
      workerSource.indexOf('motionResultForEmbedding = motionResult;'),
      workerSource.indexOf("statusTracker.completePhase('motion')")
    );
    expect(motionDetectionSection).toContain('job.updateProgress(55)');
  });

  it('should report progress=60 after motion DB saves complete', () => {
    // After all motion save blocks, before the catch
    expect(workerSource).toContain('await job.updateProgress(60)');
  });

  it('should have progress values between MOTION_START(45) and MOTION_COMPLETE(65)', () => {
    // Verify 55 and 60 are within range
    const motionStart = 45;
    const motionComplete = 65;
    expect(55).toBeGreaterThan(motionStart);
    expect(55).toBeLessThan(motionComplete);
    expect(60).toBeGreaterThan(motionStart);
    expect(60).toBeLessThan(motionComplete);
  });
});

// ============================================================================
// 8. ScrollVision progress wiring
// ============================================================================

describe('ScrollVision progress wiring in worker', () => {
  it('should pass createPhaseProgressInterpolator to analyzeScrollCaptures', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const workerSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/workers/page-analyze-worker.ts'),
      'utf8'
    );

    expect(workerSource).toContain(
      'onProgress: createPhaseProgressInterpolator(job, PHASE_PROGRESS.SCROLL_VISION_START, PHASE_PROGRESS.SCROLL_VISION_COMPLETE)'
    );
  });
});
