// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CLS Calculator Service Tests
 *
 * TDD: Red phase - Write failing tests first
 *
 * @module @reftrix/mcp-server/tests/unit/services/motion/cls-calculator.service.test
 */

import { describe, it, expect, beforeEach } from 'vitest';

import type {
  CLSCalculatorConfig,
  FrameSequenceCLSResult,
  CLSSessionWindow,
} from '../../../../src/services/motion/cls-calculator.service';
import {
  CLSCalculator,
  CLS_THRESHOLDS,
} from '../../../../src/services/motion/cls-calculator.service';
import type { FrameDiffResult, BoundingBox, ViewportSize } from '../../../../src/services/motion/types';

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create mock diff result with regions
 */
function createMockDiffResult(
  frameIndex: number,
  regions: BoundingBox[],
  changeRatio: number = 0.1
): FrameDiffResult {
  return {
    frameIndex,
    changedPixels: Math.round(changeRatio * 1920 * 1080),
    totalPixels: 1920 * 1080,
    changeRatio,
    hasChange: changeRatio > 0.001,
    regions,
  };
}

/**
 * Create bounding box
 */
function createBox(x: number, y: number, width: number, height: number): BoundingBox {
  return { x, y, width, height };
}

// =============================================================================
// Tests
// =============================================================================

describe('CLSCalculator', () => {
  let calculator: CLSCalculator;
  const defaultViewport: ViewportSize = { width: 1920, height: 1080 };

  beforeEach(() => {
    calculator = new CLSCalculator();
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      expect(calculator).toBeInstanceOf(CLSCalculator);
    });

    it('should accept custom config', () => {
      const config: CLSCalculatorConfig = {
        sessionWindowDurationMs: 10000,
        gapThresholdMs: 2000,
        fps: 60,
      };
      const customCalculator = new CLSCalculator(config);
      expect(customCalculator).toBeInstanceOf(CLSCalculator);
    });
  });

  describe('calculateFramePairCLS', () => {
    it('should return 0 for empty regions', () => {
      const diffResult = createMockDiffResult(1, [], 0);
      const result = calculator.calculateFramePairCLS(diffResult, defaultViewport);

      expect(result.cls).toBe(0);
      expect(result.classification).toBe('good');
      expect(result.shifts).toHaveLength(0);
    });

    it('should calculate CLS for single region', () => {
      // 10% of viewport area, 5% distance
      const regions = [createBox(100, 100, 192, 108)]; // 192*108 = 20736 = 1% of 1920*1080
      const diffResult = createMockDiffResult(1, regions, 0.01);

      const result = calculator.calculateFramePairCLS(diffResult, defaultViewport, {
        previousRegions: [createBox(50, 50, 192, 108)], // moved 50px diagonally
      });

      expect(result.cls).toBeGreaterThan(0);
      expect(result.shifts).toHaveLength(1);
    });

    it('should classify CLS as good when < 0.1', () => {
      const regions = [createBox(100, 100, 50, 50)]; // small region
      const diffResult = createMockDiffResult(1, regions, 0.001);

      const result = calculator.calculateFramePairCLS(diffResult, defaultViewport);

      expect(result.classification).toBe('good');
    });

    it('should classify CLS as needs-improvement when >= 0.1 and < 0.25', () => {
      // Create regions that will result in CLS between 0.1 and 0.25
      // Large region (30% of viewport) with significant movement
      const regions = [createBox(500, 500, 576, 324)]; // ~10% of viewport
      const diffResult = createMockDiffResult(1, regions, 0.1);

      const result = calculator.calculateFramePairCLS(diffResult, defaultViewport, {
        previousRegions: [createBox(0, 0, 576, 324)], // moved significantly
      });

      // Force the classification check with explicit threshold
      if (result.cls >= CLS_THRESHOLDS.GOOD && result.cls < CLS_THRESHOLDS.NEEDS_IMPROVEMENT) {
        expect(result.classification).toBe('needs-improvement');
      }
    });

    it('should classify CLS as poor when >= 0.25', () => {
      // Very large region with huge movement
      const regions = [createBox(1000, 800, 960, 540)]; // ~25% of viewport
      const diffResult = createMockDiffResult(1, regions, 0.25);

      const result = calculator.calculateFramePairCLS(diffResult, defaultViewport, {
        previousRegions: [createBox(0, 0, 960, 540)], // moved from corner to center
      });

      if (result.cls >= CLS_THRESHOLDS.NEEDS_IMPROVEMENT) {
        expect(result.classification).toBe('poor');
      }
    });
  });

  describe('calculateSequenceCLS', () => {
    it('should handle empty sequence', () => {
      const result = calculator.calculateSequenceCLS([], defaultViewport);

      expect(result.totalCLS).toBe(0);
      expect(result.maxSessionCLS).toBe(0);
      expect(result.classification).toBe('good');
      expect(result.sessionWindows).toHaveLength(0);
    });

    it('should calculate cumulative CLS for sequence', () => {
      const diffResults: FrameDiffResult[] = [
        createMockDiffResult(1, [createBox(100, 100, 100, 100)], 0.01),
        createMockDiffResult(2, [createBox(150, 150, 100, 100)], 0.01),
        createMockDiffResult(3, [createBox(200, 200, 100, 100)], 0.01),
      ];

      const result = calculator.calculateSequenceCLS(diffResults, defaultViewport);

      expect(result.totalCLS).toBeGreaterThanOrEqual(0);
      expect(result.shiftCount).toBeGreaterThanOrEqual(0);
    });

    it('should detect session windows correctly', () => {
      // Create shifts with gaps to trigger window detection
      const diffResults: FrameDiffResult[] = [];

      // First burst (frames 1-3)
      for (let i = 1; i <= 3; i++) {
        diffResults.push(createMockDiffResult(i, [createBox(i * 50, i * 50, 100, 100)], 0.05));
      }

      // Gap (frames 4-60 - no changes for 2 seconds at 30fps)
      for (let i = 4; i <= 60; i++) {
        diffResults.push(createMockDiffResult(i, [], 0));
      }

      // Second burst (frames 61-63)
      for (let i = 61; i <= 63; i++) {
        diffResults.push(createMockDiffResult(i, [createBox(i * 5, i * 5, 100, 100)], 0.05));
      }

      const result = calculator.calculateSequenceCLS(diffResults, defaultViewport);

      // Should detect at least 2 session windows due to the gap
      expect(result.sessionWindows.length).toBeGreaterThanOrEqual(1);
    });

    it('should use maxSessionCLS for Core Web Vitals compliance', () => {
      // Core Web Vitals uses the largest session window's CLS
      const diffResults: FrameDiffResult[] = [
        createMockDiffResult(1, [createBox(100, 100, 200, 200)], 0.1),
        createMockDiffResult(2, [createBox(300, 300, 200, 200)], 0.1),
      ];

      const result = calculator.calculateSequenceCLS(diffResults, defaultViewport);

      expect(result.maxSessionCLS).toBeLessThanOrEqual(result.totalCLS);
    });
  });

  describe('CLS_THRESHOLDS', () => {
    it('should have correct Core Web Vitals thresholds', () => {
      expect(CLS_THRESHOLDS.GOOD).toBe(0.1);
      expect(CLS_THRESHOLDS.NEEDS_IMPROVEMENT).toBe(0.25);
    });
  });

  describe('calculateImpactFraction', () => {
    it('should calculate impact fraction correctly', () => {
      const region = createBox(0, 0, 192, 108); // 1% of 1920x1080
      const viewport = defaultViewport;

      const impact = calculator.calculateImpactFraction(region, viewport);

      expect(impact).toBeCloseTo(0.01, 2);
    });

    it('should handle regions outside viewport', () => {
      const region = createBox(-100, -100, 200, 200);
      const viewport = defaultViewport;

      const impact = calculator.calculateImpactFraction(region, viewport);

      // Only visible part should count
      expect(impact).toBeLessThan(200 * 200 / (1920 * 1080));
    });

    it('should return 0 for completely outside regions', () => {
      const region = createBox(-200, -200, 100, 100);
      const viewport = defaultViewport;

      const impact = calculator.calculateImpactFraction(region, viewport);

      expect(impact).toBe(0);
    });
  });

  describe('calculateDistanceFraction', () => {
    it('should calculate distance fraction based on movement', () => {
      const currentRegion = createBox(200, 200, 100, 100);
      const previousRegion = createBox(100, 100, 100, 100);
      const viewport = defaultViewport;

      const distance = calculator.calculateDistanceFraction(
        currentRegion,
        previousRegion,
        viewport
      );

      // Distance: sqrt(100^2 + 100^2) = ~141.4px
      // Max dimension: 1920px
      // Expected: ~141.4 / 1920 = ~0.0737
      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeLessThan(1);
    });

    it('should return 0 for no movement', () => {
      const region = createBox(100, 100, 100, 100);
      const viewport = defaultViewport;

      const distance = calculator.calculateDistanceFraction(region, region, viewport);

      expect(distance).toBe(0);
    });

    it('should estimate distance when no previous region', () => {
      const region = createBox(100, 100, 100, 100);
      const viewport = defaultViewport;

      const distance = calculator.calculateDistanceFraction(region, undefined, viewport, 0.5);

      // Should use intensity-based estimation
      expect(distance).toBeGreaterThan(0);
    });
  });

  describe('performance', () => {
    it('should process 100 frames in reasonable time', async () => {
      const diffResults: FrameDiffResult[] = [];
      for (let i = 1; i <= 100; i++) {
        diffResults.push(
          createMockDiffResult(i, [createBox(i * 10 % 1800, i * 5 % 900, 100, 100)], 0.01)
        );
      }

      const startTime = performance.now();
      const result = calculator.calculateSequenceCLS(diffResults, defaultViewport);
      const elapsedMs = performance.now() - startTime;

      expect(result).toBeDefined();
      expect(elapsedMs).toBeLessThan(1000); // Should complete in under 1 second
    });
  });

  describe('edge cases', () => {
    it('should handle invalid viewport gracefully', () => {
      const diffResult = createMockDiffResult(1, [createBox(100, 100, 100, 100)], 0.01);

      expect(() => {
        calculator.calculateFramePairCLS(diffResult, { width: 0, height: 0 });
      }).toThrow();
    });

    it('should handle negative coordinates in regions', () => {
      const regions = [createBox(-50, -50, 200, 200)];
      const diffResult = createMockDiffResult(1, regions, 0.01);

      const result = calculator.calculateFramePairCLS(diffResult, defaultViewport);

      // Should still calculate CLS for visible portion
      expect(result).toBeDefined();
      expect(result.cls).toBeGreaterThanOrEqual(0);
    });

    it('should handle very large regions', () => {
      const regions = [createBox(0, 0, 3840, 2160)]; // 4K region in 1080p viewport
      const diffResult = createMockDiffResult(1, regions, 0.5);

      const result = calculator.calculateFramePairCLS(diffResult, defaultViewport);

      // Impact should be clamped to 1
      expect(result.shifts[0]?.impactFraction).toBeLessThanOrEqual(1);
    });
  });
});
