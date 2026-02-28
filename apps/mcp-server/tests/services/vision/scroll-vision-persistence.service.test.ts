// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ScrollVisionPersistenceService テスト
 *
 * スクロールVision分析結果のDB保存をテスト
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveScrollVisionResults,
  type ScrollVisionPrismaClient,
} from '../../../src/services/vision/scroll-vision-persistence.service';
import type { ScrollVisionResult } from '../../../src/services/vision/scroll-vision.analyzer';

// =============================================================================
// Mock Prisma Client
// =============================================================================

function createMockPrisma(): ScrollVisionPrismaClient {
  return {
    motionPattern: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 3 }),
    },
  };
}

// =============================================================================
// Test Data
// =============================================================================

function createMockVisionResult(animationCount: number = 3): ScrollVisionResult {
  const animations = Array.from({ length: animationCount }, (_, i) => ({
    triggerScrollY: (i + 1) * 500,
    element: `Element ${i + 1} description`,
    animationType: (['appear', 'animate', 'parallax'] as const)[i % 3],
    confidence: 0.7 + i * 0.05,
  }));

  return {
    analyses: [],
    scrollTriggeredAnimations: animations,
    totalProcessingTimeMs: 5000,
    captureCount: 5,
    analyzedCount: 5,
    visionModelUsed: 'llama3.2-vision',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('saveScrollVisionResults', () => {
  let mockPrisma: ScrollVisionPrismaClient;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
  });

  it('should return early for empty animations', async () => {
    const emptyResult: ScrollVisionResult = {
      analyses: [],
      scrollTriggeredAnimations: [],
      totalProcessingTimeMs: 100,
      captureCount: 0,
      analyzedCount: 0,
      visionModelUsed: 'llama3.2-vision',
    };

    const result = await saveScrollVisionResults(
      mockPrisma,
      'test-web-page-id',
      emptyResult,
      'https://example.com'
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.ids).toEqual([]);
    expect(result.idMapping.size).toBe(0);
    expect(mockPrisma.motionPattern.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.motionPattern.createMany).not.toHaveBeenCalled();
  });

  it('should delete existing vision_detected patterns before saving', async () => {
    const visionResult = createMockVisionResult(2);

    await saveScrollVisionResults(
      mockPrisma,
      'test-web-page-id',
      visionResult,
      'https://example.com'
    );

    expect(mockPrisma.motionPattern.deleteMany).toHaveBeenCalledWith({
      where: { webPageId: 'test-web-page-id', type: 'vision_detected' },
    });
  });

  it('should create MotionPattern records from animations', async () => {
    const visionResult = createMockVisionResult(2);
    (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

    const result = await saveScrollVisionResults(
      mockPrisma,
      'test-web-page-id',
      visionResult,
      'https://example.com'
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.ids).toHaveLength(2);
    expect(result.idMapping.size).toBe(2);
    // Verify idMapping keys match vision_detected_{index} pattern
    expect(result.idMapping.has('vision_detected_0')).toBe(true);
    expect(result.idMapping.has('vision_detected_1')).toBe(true);
    // Verify idMapping values match ids
    expect(result.idMapping.get('vision_detected_0')).toBe(result.ids[0]);
    expect(result.idMapping.get('vision_detected_1')).toBe(result.ids[1]);
    expect(mockPrisma.motionPattern.createMany).toHaveBeenCalledTimes(1);

    // Check data structure
    const callArgs = (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const data = callArgs.data as Record<string, unknown>[];
    expect(data).toHaveLength(2);

    // Verify first record structure
    const firstRecord = data[0];
    expect(firstRecord).toMatchObject({
      webPageId: 'test-web-page-id',
      type: 'vision_detected',
      triggerType: 'scroll',
      sourceUrl: 'https://example.com',
      usageScope: 'inspiration_only',
    });
    expect(firstRecord.id).toBeDefined();
    expect(firstRecord.name).toContain('Scroll-triggered');
    expect(firstRecord.tags).toContain('scroll-vision');
  });

  it('should map animation types to correct categories', async () => {
    const visionResult: ScrollVisionResult = {
      analyses: [],
      scrollTriggeredAnimations: [
        { triggerScrollY: 100, element: 'heading', animationType: 'appear', confidence: 0.8 },
        { triggerScrollY: 200, element: 'image', animationType: 'parallax', confidence: 0.7 },
        { triggerScrollY: 300, element: 'card', animationType: 'lazy-load', confidence: 0.6 },
        { triggerScrollY: 400, element: 'section', animationType: 'animate', confidence: 0.9 },
        { triggerScrollY: 500, element: 'bg', animationType: 'transform', confidence: 0.5 },
      ],
      totalProcessingTimeMs: 5000,
      captureCount: 5,
      analyzedCount: 5,
      visionModelUsed: 'llama3.2-vision',
    };

    (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 5 });

    await saveScrollVisionResults(
      mockPrisma,
      'test-web-page-id',
      visionResult,
      'https://example.com'
    );

    const callArgs = (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const data = callArgs.data as Record<string, unknown>[];

    expect(data[0].category).toBe('reveal');         // appear → reveal
    expect(data[1].category).toBe('parallax');        // parallax → parallax
    expect(data[2].category).toBe('entrance');        // lazy-load → entrance
    expect(data[3].category).toBe('scroll_trigger');  // animate → scroll_trigger
    expect(data[4].category).toBe('scroll_trigger');  // transform → scroll_trigger
  });

  it('should include metadata with visionConfidence and scrollY', async () => {
    const visionResult: ScrollVisionResult = {
      analyses: [],
      scrollTriggeredAnimations: [
        { triggerScrollY: 750, element: 'hero section', animationType: 'appear', confidence: 0.85 },
      ],
      totalProcessingTimeMs: 2000,
      captureCount: 3,
      analyzedCount: 3,
      visionModelUsed: 'llama3.2-vision',
    };

    (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    await saveScrollVisionResults(
      mockPrisma,
      'test-web-page-id',
      visionResult,
      'https://example.com'
    );

    const callArgs = (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const data = callArgs.data as Record<string, unknown>[];
    const metadata = data[0].metadata as Record<string, unknown>;

    expect(metadata.visionConfidence).toBe(0.85);
    expect(metadata.scrollY).toBe(750);
    expect(metadata.detectionSource).toBe('scroll_vision_analyzer');
  });

  it('should include triggerConfig with scroll position', async () => {
    const visionResult: ScrollVisionResult = {
      analyses: [],
      scrollTriggeredAnimations: [
        { triggerScrollY: 1200, element: 'card grid', animationType: 'animate', confidence: 0.9 },
      ],
      totalProcessingTimeMs: 1000,
      captureCount: 2,
      analyzedCount: 2,
      visionModelUsed: 'llama3.2-vision',
    };

    (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    await saveScrollVisionResults(
      mockPrisma,
      'test-web-page-id',
      visionResult,
      'https://example.com'
    );

    const callArgs = (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const data = callArgs.data as Record<string, unknown>[];
    const triggerConfig = data[0].triggerConfig as Record<string, unknown>;

    expect(triggerConfig.scrollY).toBe(1200);
    expect(triggerConfig.source).toBe('scroll_vision');
  });

  it('should handle DB errors gracefully', async () => {
    const visionResult = createMockVisionResult(1);
    (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database connection lost')
    );

    const result = await saveScrollVisionResults(
      mockPrisma,
      'test-web-page-id',
      visionResult,
      'https://example.com'
    );

    expect(result.success).toBe(false);
    expect(result.count).toBe(0);
    expect(result.ids).toEqual([]);
    expect(result.idMapping.size).toBe(0);
    expect(result.error).toBe('Database connection lost');
  });

  it('should handle deleteMany errors gracefully', async () => {
    const visionResult = createMockVisionResult(1);
    (mockPrisma.motionPattern.deleteMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Delete failed')
    );

    const result = await saveScrollVisionResults(
      mockPrisma,
      'test-web-page-id',
      visionResult,
      'https://example.com'
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Delete failed');
  });

  it('should truncate long element names in pattern name', async () => {
    const longElement = 'A'.repeat(200);
    const visionResult: ScrollVisionResult = {
      analyses: [],
      scrollTriggeredAnimations: [
        { triggerScrollY: 100, element: longElement, animationType: 'appear', confidence: 0.8 },
      ],
      totalProcessingTimeMs: 1000,
      captureCount: 1,
      analyzedCount: 1,
      visionModelUsed: 'llama3.2-vision',
    };

    (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    await saveScrollVisionResults(
      mockPrisma,
      'test-web-page-id',
      visionResult,
      'https://example.com'
    );

    const callArgs = (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const data = callArgs.data as Record<string, unknown>[];
    const name = data[0].name as string;

    // Name should include the truncated element (first 100 chars)
    expect(name.length).toBeLessThanOrEqual(150); // "Scroll-triggered appear: " + 100 chars
  });

  it('should generate unique UUIDv7 IDs for each record', async () => {
    const visionResult = createMockVisionResult(5);
    (mockPrisma.motionPattern.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 5 });

    const result = await saveScrollVisionResults(
      mockPrisma,
      'test-web-page-id',
      visionResult,
      'https://example.com'
    );

    expect(result.ids).toHaveLength(5);
    // All IDs should be unique
    const uniqueIds = new Set(result.ids);
    expect(uniqueIds.size).toBe(5);
  });
});
