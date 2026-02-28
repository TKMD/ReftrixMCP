// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ImageOptimizer - Unit Tests
 *
 * Vision CPU完走保証 Phase 2: 画像最適化機能のテスト
 *
 * 最適化戦略:
 * - GPU: 最適化不要（そのまま使用）
 * - CPU Small (< 100KB): 最適化不要
 * - CPU Medium (100KB - 500KB): 最大1024x1024にリサイズ、品質80%
 * - CPU Large (>= 500KB): 最大768x768にリサイズ、品質70%
 */

import { describe, it, expect, beforeEach } from 'vitest';
import sharp from 'sharp';
import {
  ImageOptimizer,
  OptimizationStrategy,
  IMAGE_SIZE_THRESHOLDS,
  OPTIMIZATION_CONFIGS,
} from '../../../src/services/vision/image-optimizer.js';
import { HardwareType } from '../../../src/services/vision/timeout-calculator.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * テスト用の画像バッファを生成
 */
async function createTestImage(
  width: number,
  height: number,
  options?: { quality?: number; format?: 'jpeg' | 'png' }
): Promise<Buffer> {
  // ノイズを追加して圧縮率を下げる（より大きなファイルサイズを生成）
  const noiseBuffer = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noiseBuffer.length; i++) {
    noiseBuffer[i] = Math.floor(Math.random() * 256);
  }

  let pipeline = sharp(noiseBuffer, {
    raw: {
      width,
      height,
      channels: 3,
    },
  });

  if (options?.format === 'png') {
    return pipeline.png().toBuffer();
  }

  return pipeline.jpeg({ quality: options?.quality ?? 90 }).toBuffer();
}

/**
 * 指定サイズ付近の画像バッファを生成（サイズ調整用）
 */
async function createImageNearSize(targetBytes: number): Promise<Buffer> {
  // 大きめの画像を作成してサイズを調整
  const estimatedPixels = Math.ceil(targetBytes / 3); // RGB 3 bytes per pixel (rough estimate)
  const side = Math.ceil(Math.sqrt(estimatedPixels));
  const buffer = await createTestImage(side, side, { quality: 95 });

  // サイズが小さすぎる場合は大きくする
  if (buffer.length < targetBytes * 0.8) {
    const largeSide = side * 2;
    return createTestImage(largeSide, largeSide, { quality: 95 });
  }

  return buffer;
}

// =============================================================================
// Tests
// =============================================================================

describe('ImageOptimizer', () => {
  let optimizer: ImageOptimizer;

  beforeEach(() => {
    optimizer = new ImageOptimizer();
  });

  // ==========================================================================
  // Constants and Configuration
  // ==========================================================================

  describe('Constants', () => {
    it('should export correct size thresholds', () => {
      expect(IMAGE_SIZE_THRESHOLDS.SMALL).toBe(100_000); // 100KB
      expect(IMAGE_SIZE_THRESHOLDS.LARGE).toBe(500_000); // 500KB
    });

    it('should export optimization configurations', () => {
      expect(OPTIMIZATION_CONFIGS.NONE).toBeDefined();
      expect(OPTIMIZATION_CONFIGS.MEDIUM).toBeDefined();
      expect(OPTIMIZATION_CONFIGS.AGGRESSIVE).toBeDefined();

      // Medium config
      expect(OPTIMIZATION_CONFIGS.MEDIUM.maxWidth).toBe(1024);
      expect(OPTIMIZATION_CONFIGS.MEDIUM.maxHeight).toBe(1024);
      expect(OPTIMIZATION_CONFIGS.MEDIUM.quality).toBe(80);

      // Aggressive config
      expect(OPTIMIZATION_CONFIGS.AGGRESSIVE.maxWidth).toBe(768);
      expect(OPTIMIZATION_CONFIGS.AGGRESSIVE.maxHeight).toBe(768);
      expect(OPTIMIZATION_CONFIGS.AGGRESSIVE.quality).toBe(70);
    });

    it('should export OptimizationStrategy enum', () => {
      expect(OptimizationStrategy.NONE).toBe('NONE');
      expect(OptimizationStrategy.MEDIUM).toBe('MEDIUM');
      expect(OptimizationStrategy.AGGRESSIVE).toBe('AGGRESSIVE');
    });
  });

  // ==========================================================================
  // Strategy Selection
  // ==========================================================================

  describe('selectStrategy', () => {
    it('should return NONE for GPU', () => {
      const strategy = optimizer.selectStrategy(HardwareType.GPU, 1_000_000);
      expect(strategy).toBe(OptimizationStrategy.NONE);
    });

    it('should return NONE for GPU regardless of image size', () => {
      expect(optimizer.selectStrategy(HardwareType.GPU, 50_000)).toBe(OptimizationStrategy.NONE);
      expect(optimizer.selectStrategy(HardwareType.GPU, 200_000)).toBe(OptimizationStrategy.NONE);
      expect(optimizer.selectStrategy(HardwareType.GPU, 1_000_000)).toBe(OptimizationStrategy.NONE);
    });

    it('should return NONE for CPU small images (< 100KB)', () => {
      expect(optimizer.selectStrategy(HardwareType.CPU, 50_000)).toBe(OptimizationStrategy.NONE);
      expect(optimizer.selectStrategy(HardwareType.CPU, 99_999)).toBe(OptimizationStrategy.NONE);
    });

    it('should return MEDIUM for CPU medium images (100KB - 500KB)', () => {
      expect(optimizer.selectStrategy(HardwareType.CPU, 100_000)).toBe(OptimizationStrategy.MEDIUM);
      expect(optimizer.selectStrategy(HardwareType.CPU, 300_000)).toBe(OptimizationStrategy.MEDIUM);
      expect(optimizer.selectStrategy(HardwareType.CPU, 499_999)).toBe(OptimizationStrategy.MEDIUM);
    });

    it('should return AGGRESSIVE for CPU large images (>= 500KB)', () => {
      expect(optimizer.selectStrategy(HardwareType.CPU, 500_000)).toBe(OptimizationStrategy.AGGRESSIVE);
      expect(optimizer.selectStrategy(HardwareType.CPU, 1_000_000)).toBe(OptimizationStrategy.AGGRESSIVE);
    });
  });

  // ==========================================================================
  // Optimal Size Estimation
  // ==========================================================================

  describe('estimateOptimalSize', () => {
    it('should return original dimensions for GPU', () => {
      const result = optimizer.estimateOptimalSize(1_000_000, HardwareType.GPU);
      expect(result.maxWidth).toBeUndefined();
      expect(result.maxHeight).toBeUndefined();
      expect(result.quality).toBeUndefined();
      expect(result.strategy).toBe(OptimizationStrategy.NONE);
    });

    it('should return original dimensions for small images', () => {
      const result = optimizer.estimateOptimalSize(50_000, HardwareType.CPU);
      expect(result.maxWidth).toBeUndefined();
      expect(result.maxHeight).toBeUndefined();
      expect(result.quality).toBeUndefined();
      expect(result.strategy).toBe(OptimizationStrategy.NONE);
    });

    it('should return medium optimization for medium images', () => {
      const result = optimizer.estimateOptimalSize(300_000, HardwareType.CPU);
      expect(result.maxWidth).toBe(1024);
      expect(result.maxHeight).toBe(1024);
      expect(result.quality).toBe(80);
      expect(result.strategy).toBe(OptimizationStrategy.MEDIUM);
    });

    it('should return aggressive optimization for large images', () => {
      const result = optimizer.estimateOptimalSize(600_000, HardwareType.CPU);
      expect(result.maxWidth).toBe(768);
      expect(result.maxHeight).toBe(768);
      expect(result.quality).toBe(70);
      expect(result.strategy).toBe(OptimizationStrategy.AGGRESSIVE);
    });
  });

  // ==========================================================================
  // Image Optimization
  // ==========================================================================

  describe('optimizeForCPU', () => {
    it('should return original buffer when no optimization needed', async () => {
      const originalBuffer = await createTestImage(100, 100);
      const result = await optimizer.optimizeForCPU(originalBuffer, {
        hardwareType: HardwareType.GPU,
      });

      expect(result.buffer).toBe(originalBuffer);
      expect(result.originalSizeBytes).toBe(originalBuffer.length);
      expect(result.optimizedSizeBytes).toBe(originalBuffer.length);
      expect(result.compressionRatio).toBe(1);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('No optimization needed');
    });

    it('should optimize medium-sized images', async () => {
      // Create a large image that will trigger optimization
      const originalBuffer = await createTestImage(2000, 2000);

      const result = await optimizer.optimizeForCPU(originalBuffer, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      expect(result.optimizedSizeBytes).toBeLessThan(result.originalSizeBytes);
      expect(result.dimensions.width).toBeLessThanOrEqual(1024);
      expect(result.dimensions.height).toBeLessThanOrEqual(1024);
      expect(result.compressionRatio).toBeLessThan(1);
      expect(result.skipped).toBe(false);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should optimize large images with aggressive settings', async () => {
      const originalBuffer = await createTestImage(2000, 2000);

      const result = await optimizer.optimizeForCPU(originalBuffer, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.AGGRESSIVE,
      });

      expect(result.dimensions.width).toBeLessThanOrEqual(768);
      expect(result.dimensions.height).toBeLessThanOrEqual(768);
      expect(result.compressionRatio).toBeLessThan(1);
    });

    it('should maintain aspect ratio during resize', async () => {
      // Create a wide image (2000x1000)
      const originalBuffer = await createTestImage(2000, 1000);

      const result = await optimizer.optimizeForCPU(originalBuffer, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      // Should fit within 1024x1024 while maintaining aspect ratio
      const aspectRatio = result.dimensions.width / result.dimensions.height;
      expect(aspectRatio).toBeCloseTo(2, 1); // 2:1 aspect ratio
      expect(result.dimensions.width).toBeLessThanOrEqual(1024);
      expect(result.dimensions.height).toBeLessThanOrEqual(1024);
    });

    it('should handle Base64 input', async () => {
      const originalBuffer = await createTestImage(2000, 2000);
      const base64 = originalBuffer.toString('base64');

      const result = await optimizer.optimizeForCPU(base64, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.skipped).toBe(false);
    });

    it('should record processing time', async () => {
      const originalBuffer = await createTestImage(1000, 1000);

      const result = await optimizer.optimizeForCPU(originalBuffer, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.processingTimeMs).toBe('number');
    });
  });

  // ==========================================================================
  // Auto Strategy Selection
  // ==========================================================================

  describe('Auto Strategy Selection', () => {
    it('should auto-select strategy based on image size when not forced', async () => {
      // Create a noisy image large enough to trigger MEDIUM optimization (>= 100KB)
      // With noise, compression is less effective, resulting in larger files
      const largeBuffer = await createTestImage(500, 500, { quality: 95 });

      // Verify the buffer is large enough (noise images are harder to compress)
      expect(largeBuffer.length).toBeGreaterThanOrEqual(IMAGE_SIZE_THRESHOLDS.SMALL);

      const result = await optimizer.optimizeForCPU(largeBuffer, {
        hardwareType: HardwareType.CPU,
        // No forceStrategy - should auto-select based on size
      });

      // Should have been optimized (not skipped)
      expect(result.skipped).toBe(false);
    });

    it('should skip optimization for small images', async () => {
      // Create a small image (< 100KB) - even with noise, small dimensions = small file
      const smallBuffer = await createTestImage(50, 50, { quality: 50 });

      // Verify the buffer is small enough
      expect(smallBuffer.length).toBeLessThan(IMAGE_SIZE_THRESHOLDS.SMALL);

      const result = await optimizer.optimizeForCPU(smallBuffer, {
        hardwareType: HardwareType.CPU,
        // No forceStrategy - should auto-select based on size
      });

      // Should be skipped for small images
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('No optimization needed');
    });
  });

  // ==========================================================================
  // Error Handling / Graceful Degradation
  // ==========================================================================

  describe('Error Handling', () => {
    it('should return original buffer on invalid image data (graceful degradation)', async () => {
      const invalidBuffer = Buffer.from('not a valid image');

      const result = await optimizer.optimizeForCPU(invalidBuffer, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      // Should return original buffer with error flag
      expect(result.buffer).toEqual(invalidBuffer);
      expect(result.skipped).toBe(true);
      expect(result.error).toBeDefined();
      expect(result.compressionRatio).toBe(1);
    });

    it('should handle empty buffer', async () => {
      const emptyBuffer = Buffer.alloc(0);

      const result = await optimizer.optimizeForCPU(emptyBuffer, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      expect(result.skipped).toBe(true);
      expect(result.error).toBeDefined();
    });

    it('should handle invalid Base64 string gracefully', async () => {
      const invalidBase64 = 'not-valid-base64!!!';

      const result = await optimizer.optimizeForCPU(invalidBase64, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      expect(result.skipped).toBe(true);
      expect(result.error).toBeDefined();
    });
  });

  // ==========================================================================
  // Output Format
  // ==========================================================================

  describe('Output Format', () => {
    it('should output JPEG by default', async () => {
      const originalBuffer = await createTestImage(1000, 1000);

      const result = await optimizer.optimizeForCPU(originalBuffer, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      // JPEG magic bytes: FF D8 FF
      expect(result.buffer[0]).toBe(0xff);
      expect(result.buffer[1]).toBe(0xd8);
      expect(result.buffer[2]).toBe(0xff);
    });

    it('should support PNG output when specified', async () => {
      const originalBuffer = await createTestImage(1000, 1000);

      const result = await optimizer.optimizeForCPU(originalBuffer, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
        outputFormat: 'png',
      });

      // PNG magic bytes: 89 50 4E 47
      expect(result.buffer[0]).toBe(0x89);
      expect(result.buffer[1]).toBe(0x50);
      expect(result.buffer[2]).toBe(0x4e);
      expect(result.buffer[3]).toBe(0x47);
    });
  });

  // ==========================================================================
  // Integration with ImageSize enum
  // ==========================================================================

  describe('Integration with ImageSize enum', () => {
    it('should align with TimeoutCalculator ImageSize classification', () => {
      // Small images (< 100KB) should not be optimized
      expect(optimizer.selectStrategy(HardwareType.CPU, 50_000)).toBe(OptimizationStrategy.NONE);

      // Medium images (100KB - 500KB) should use MEDIUM optimization
      expect(optimizer.selectStrategy(HardwareType.CPU, 200_000)).toBe(OptimizationStrategy.MEDIUM);

      // Large images (>= 500KB) should use AGGRESSIVE optimization
      expect(optimizer.selectStrategy(HardwareType.CPU, 600_000)).toBe(OptimizationStrategy.AGGRESSIVE);
    });
  });

  // ==========================================================================
  // Concurrency Control
  // ==========================================================================

  describe('Concurrency Control', () => {
    it('should handle concurrent optimization requests', async () => {
      const buffers = await Promise.all([
        createTestImage(1000, 1000),
        createTestImage(1000, 1000),
        createTestImage(1000, 1000),
      ]);

      const results = await Promise.all(
        buffers.map((buffer) =>
          optimizer.optimizeForCPU(buffer, {
            hardwareType: HardwareType.CPU,
            forceStrategy: OptimizationStrategy.MEDIUM,
          })
        )
      );

      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.skipped).toBe(false);
        expect(result.buffer).toBeInstanceOf(Buffer);
      });
    });
  });
});
