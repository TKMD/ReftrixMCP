// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fade Detector Service Tests
 *
 * TDD: Red phase - Write failing tests first
 *
 * 透明度変化検出によるフェードイン/フェードアウト検出テスト
 *
 * @module @reftrix/mcp-server/tests/unit/services/motion/fade-detector.service.test
 */

import { describe, it, expect, beforeEach } from 'vitest';

import type {
  FadeDetectorConfig,
  FadeEvent,
  FadeDetectionResult,
  FrameAlphaInfo,
} from '../../../../src/services/motion/fade-detector.service';
import {
  FadeDetector,
  createFadeDetector,
} from '../../../../src/services/motion/fade-detector.service';

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create mock frame buffer with specified alpha
 */
function createMockFrame(
  width: number,
  height: number,
  options: {
    fill?: { r: number; g: number; b: number };
    alpha?: number;
    gradientAlpha?: { start: number; end: number };
    region?: { x: number; y: number; w: number; h: number; alpha: number };
  } = {}
): Buffer {
  const buffer = Buffer.alloc(width * height * 4);
  const fill = options.fill ?? { r: 128, g: 128, b: 128 };
  const defaultAlpha = options.alpha ?? 255;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      buffer[i] = fill.r;
      buffer[i + 1] = fill.g;
      buffer[i + 2] = fill.b;

      // Handle alpha gradient
      if (options.gradientAlpha) {
        const ratio = y / (height - 1);
        buffer[i + 3] = Math.round(
          options.gradientAlpha.start + (options.gradientAlpha.end - options.gradientAlpha.start) * ratio
        );
      } else if (options.region) {
        const { x: rx, y: ry, w, h, alpha } = options.region;
        if (x >= rx && x < rx + w && y >= ry && y < ry + h) {
          buffer[i + 3] = alpha;
        } else {
          buffer[i + 3] = defaultAlpha;
        }
      } else {
        buffer[i + 3] = defaultAlpha;
      }
    }
  }

  return buffer;
}

/**
 * Create frame sequence for fade in animation
 */
function createFadeInSequence(
  width: number,
  height: number,
  frameCount: number
): { buffer: Buffer; width: number; height: number; index: number }[] {
  return Array.from({ length: frameCount }, (_, i) => {
    const alpha = Math.round((i / (frameCount - 1)) * 255);
    return {
      buffer: createMockFrame(width, height, { alpha }),
      width,
      height,
      index: i,
    };
  });
}

/**
 * Create frame sequence for fade out animation
 */
function createFadeOutSequence(
  width: number,
  height: number,
  frameCount: number
): { buffer: Buffer; width: number; height: number; index: number }[] {
  return Array.from({ length: frameCount }, (_, i) => {
    const alpha = Math.round((1 - i / (frameCount - 1)) * 255);
    return {
      buffer: createMockFrame(width, height, { alpha }),
      width,
      height,
      index: i,
    };
  });
}

/**
 * Create static frame sequence (no change)
 */
function createStaticSequence(
  width: number,
  height: number,
  frameCount: number
): { buffer: Buffer; width: number; height: number; index: number }[] {
  return Array.from({ length: frameCount }, (_, i) => ({
    buffer: createMockFrame(width, height, { alpha: 255 }),
    width,
    height,
    index: i,
  }));
}

// =============================================================================
// Tests
// =============================================================================

describe('FadeDetector', () => {
  let detector: FadeDetector;

  beforeEach(() => {
    detector = new FadeDetector();
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      expect(detector).toBeInstanceOf(FadeDetector);
    });

    it('should accept custom config', () => {
      const config: FadeDetectorConfig = {
        alphaThreshold: 0.2,
        minFadeDurationFrames: 5,
        fps: 60,
      };
      const customDetector = new FadeDetector(config);
      expect(customDetector).toBeInstanceOf(FadeDetector);
    });
  });

  describe('analyzeFrameAlpha', () => {
    it('should calculate average alpha for frame', () => {
      const frame = createMockFrame(100, 100, { alpha: 128 });

      const result = detector.analyzeFrameAlpha(frame, 100, 100);

      expect(result.averageAlpha).toBeCloseTo(128, 0);
      expect(result.alphaRatio).toBeCloseTo(0.5, 1);
    });

    it('should detect fully opaque frame', () => {
      const frame = createMockFrame(100, 100, { alpha: 255 });

      const result = detector.analyzeFrameAlpha(frame, 100, 100);

      expect(result.averageAlpha).toBe(255);
      expect(result.alphaRatio).toBe(1);
    });

    it('should detect fully transparent frame', () => {
      const frame = createMockFrame(100, 100, { alpha: 0 });

      const result = detector.analyzeFrameAlpha(frame, 100, 100);

      expect(result.averageAlpha).toBe(0);
      expect(result.alphaRatio).toBe(0);
    });

    it('should handle alpha gradient', () => {
      const frame = createMockFrame(100, 100, {
        gradientAlpha: { start: 0, end: 255 },
      });

      const result = detector.analyzeFrameAlpha(frame, 100, 100);

      // Average should be around middle
      expect(result.averageAlpha).toBeGreaterThan(100);
      expect(result.averageAlpha).toBeLessThan(155);
    });

    it('should detect regional alpha changes', () => {
      const frame = createMockFrame(100, 100, {
        region: { x: 25, y: 25, w: 50, h: 50, alpha: 0 },
        alpha: 255,
      });

      const result = detector.analyzeFrameAlpha(frame, 100, 100);

      // 25% of pixels are transparent
      expect(result.alphaRatio).toBeLessThan(1);
      expect(result.alphaRatio).toBeGreaterThan(0.5);
    });
  });

  describe('detectFadeIn', () => {
    it('should detect fade in sequence', () => {
      const frames = createFadeInSequence(100, 100, 30);

      const result = detector.detect(frames);

      expect(result.fadeEvents.length).toBeGreaterThan(0);

      const fadeIn = result.fadeEvents.find((e) => e.type === 'fade_in');
      expect(fadeIn).toBeDefined();
    });

    it('should calculate duration for fade in', () => {
      const frames = createFadeInSequence(100, 100, 30);

      const result = detector.detect(frames, { fps: 30 });

      const fadeIn = result.fadeEvents.find((e) => e.type === 'fade_in');
      expect(fadeIn?.durationMs).toBeGreaterThan(0);
      expect(fadeIn?.durationMs).toBeLessThanOrEqual(1001); // 30 frames at 30fps = 1s (with float tolerance)
    });

    it('should include start and end frame indices', () => {
      const frames = createFadeInSequence(100, 100, 30);

      const result = detector.detect(frames);

      const fadeIn = result.fadeEvents.find((e) => e.type === 'fade_in');
      expect(fadeIn?.startFrame).toBeDefined();
      expect(fadeIn?.endFrame).toBeDefined();
      expect(fadeIn!.endFrame).toBeGreaterThan(fadeIn!.startFrame);
    });
  });

  describe('detectFadeOut', () => {
    it('should detect fade out sequence', () => {
      const frames = createFadeOutSequence(100, 100, 30);

      const result = detector.detect(frames);

      expect(result.fadeEvents.length).toBeGreaterThan(0);

      const fadeOut = result.fadeEvents.find((e) => e.type === 'fade_out');
      expect(fadeOut).toBeDefined();
    });

    it('should calculate duration for fade out', () => {
      const frames = createFadeOutSequence(100, 100, 30);

      const result = detector.detect(frames, { fps: 30 });

      const fadeOut = result.fadeEvents.find((e) => e.type === 'fade_out');
      expect(fadeOut?.durationMs).toBeGreaterThan(0);
    });

    it('should include alpha change information', () => {
      const frames = createFadeOutSequence(100, 100, 30);

      const result = detector.detect(frames);

      const fadeOut = result.fadeEvents.find((e) => e.type === 'fade_out');
      expect(fadeOut?.startAlpha).toBeGreaterThan(fadeOut!.endAlpha);
    });
  });

  describe('detect (combined)', () => {
    it('should return empty for static sequence', () => {
      const frames = createStaticSequence(100, 100, 30);

      const result = detector.detect(frames);

      expect(result.fadeEvents).toHaveLength(0);
    });

    it('should handle single frame', () => {
      const frames = [
        {
          buffer: createMockFrame(100, 100, { alpha: 255 }),
          width: 100,
          height: 100,
          index: 0,
        },
      ];

      const result = detector.detect(frames);

      expect(result.fadeEvents).toHaveLength(0);
      expect(result.success).toBe(true);
    });

    it('should handle empty frame array', () => {
      const result = detector.detect([]);

      expect(result.fadeEvents).toHaveLength(0);
      expect(result.success).toBe(true);
    });

    it('should detect multiple fade events in sequence', () => {
      // Create fade in followed by fade out
      const fadeIn = createFadeInSequence(100, 100, 15);
      const fadeOut = createFadeOutSequence(100, 100, 15).map((f, i) => ({
        ...f,
        index: i + 15,
      }));
      const frames = [...fadeIn, ...fadeOut];

      const result = detector.detect(frames);

      expect(result.fadeEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should include summary statistics', () => {
      const frames = createFadeInSequence(100, 100, 30);

      const result = detector.detect(frames);

      expect(result.fadeInCount).toBeDefined();
      expect(result.fadeOutCount).toBeDefined();
      expect(result.totalFadeEvents).toBeDefined();
    });

    it('should respect minimum duration threshold', () => {
      // Very short fade (only 2 frames)
      const frames = createFadeInSequence(100, 100, 2);
      const customDetector = new FadeDetector({ minFadeDurationFrames: 5 });

      const result = customDetector.detect(frames);

      // Should not detect fade because it's too short
      expect(result.fadeEvents.length).toBe(0);
    });

    it('should respect alpha change threshold', () => {
      // Create subtle alpha change
      const frames = Array.from({ length: 30 }, (_, i) => ({
        buffer: createMockFrame(100, 100, { alpha: 250 + Math.round((i / 29) * 5) }),
        width: 100,
        height: 100,
        index: i,
      }));

      const result = detector.detect(frames);

      // Subtle change should not trigger detection
      expect(result.fadeEvents.length).toBe(0);
    });
  });

  describe('performance', () => {
    it('should process 100 frames quickly', () => {
      const frames = createFadeInSequence(200, 200, 100);

      const startTime = performance.now();
      const result = detector.detect(frames);
      const elapsedMs = performance.now() - startTime;

      expect(result).toBeDefined();
      expect(elapsedMs).toBeLessThan(5000); // Should complete in under 5 seconds

      if (process.env.NODE_ENV === 'development') {
        console.log(`[FadeDetector] 100 frames processed in ${elapsedMs.toFixed(2)}ms`);
      }
    });
  });

  describe('factory function', () => {
    it('should create detector via factory', () => {
      const newDetector = createFadeDetector({ fps: 60 });
      expect(newDetector).toBeInstanceOf(FadeDetector);
    });

    it('should create detector with defaults via factory', () => {
      const newDetector = createFadeDetector();
      expect(newDetector).toBeInstanceOf(FadeDetector);
    });
  });

  describe('edge cases', () => {
    it('should handle mismatched buffer sizes gracefully', () => {
      const frames = [
        { buffer: Buffer.alloc(100), width: 100, height: 100, index: 0 },
      ];

      expect(() => detector.detect(frames)).not.toThrow();
    });

    it('should handle zero-size frames', () => {
      const frames = [
        { buffer: Buffer.alloc(0), width: 0, height: 0, index: 0 },
      ];

      const result = detector.detect(frames);
      expect(result.success).toBe(true);
    });

    it('should handle very large alpha changes correctly', () => {
      const frames = [
        { buffer: createMockFrame(100, 100, { alpha: 0 }), width: 100, height: 100, index: 0 },
        { buffer: createMockFrame(100, 100, { alpha: 255 }), width: 100, height: 100, index: 1 },
      ];

      const result = detector.detect(frames);

      // Instant fade should still be detected if threshold allows
      expect(result.success).toBe(true);
    });
  });
});
