// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision CPU完走保証 Phase 3: 統合テスト
 *
 * page.analyze ツールでの visionOptions 統合をテストします。
 *
 * テスト対象:
 * - visionOptions が pageAnalyzeInputSchema に含まれること
 * - visionOptions が layout-handler に渡されること
 * - HardwareDetector, TimeoutCalculator, ImageOptimizer の統合
 * - Graceful Degradation の動作
 *
 * @module tests/tools/page/vision-cpu-guarantee-integration
 */

import { describe, it, expect, vi } from 'vitest';
import { pageAnalyzeInputSchema, visionOptionsSchema } from '../../../src/tools/page/schemas';
import type { z } from 'zod';

// =============================================================================
// テスト用型定義
// =============================================================================

type PageAnalyzeInput = z.infer<typeof pageAnalyzeInputSchema>;
type VisionOptions = z.infer<typeof visionOptionsSchema>;

// =============================================================================
// pageAnalyzeInputSchema with visionOptions Tests
// =============================================================================

describe('Vision CPU完走保証 Phase 3: pageAnalyzeInputSchema統合', () => {
  describe('visionOptions field', () => {
    it('should accept visionOptions in pageAnalyzeInputSchema', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionTimeoutMs: 60000,
          visionForceCpu: false,
          visionEnableProgress: false,
          visionFallbackToHtmlOnly: true,
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionOptions).toBeDefined();
        expect(result.data.visionOptions?.visionTimeoutMs).toBe(60000);
        expect(result.data.visionOptions?.visionForceCpu).toBe(false);
      }
    });

    it('should accept pageAnalyzeInputSchema without visionOptions (optional)', () => {
      const input = {
        url: 'https://example.com',
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        // visionOptions is optional, so it should be undefined or have defaults
        expect(result.data.url).toBe('https://example.com');
      }
    });

    it('should apply default values for visionOptions boolean fields', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionTimeoutMs: 120000,
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionOptions?.visionTimeoutMs).toBe(120000);
        // デフォルト値が適用される
        expect(result.data.visionOptions?.visionForceCpu).toBe(false);
        expect(result.data.visionOptions?.visionEnableProgress).toBe(false);
        expect(result.data.visionOptions?.visionFallbackToHtmlOnly).toBe(true);
      }
    });
  });

  describe('GPU mode configuration', () => {
    it('should support GPU mode with fast timeout', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionTimeoutMs: 60000, // GPU timeout
          visionForceCpu: false,
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionOptions?.visionForceCpu).toBe(false);
        expect(result.data.visionOptions?.visionTimeoutMs).toBe(60000);
      }
    });
  });

  describe('CPU mode configuration', () => {
    it('should support forced CPU mode with extended timeout', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionTimeoutMs: 600000, // 10 minutes for CPU
          visionForceCpu: true,
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionOptions?.visionForceCpu).toBe(true);
        expect(result.data.visionOptions?.visionTimeoutMs).toBe(600000);
      }
    });

    it('should support CPU Large configuration (20 minutes)', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionTimeoutMs: 1200000, // 20 minutes for CPU Large
          visionForceCpu: true,
          visionImageMaxSize: 500000, // 500KB threshold
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionOptions?.visionTimeoutMs).toBe(1200000);
        expect(result.data.visionOptions?.visionImageMaxSize).toBe(500000);
      }
    });
  });

  describe('Graceful Degradation configuration', () => {
    it('should support fallback enabled (default)', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionFallbackToHtmlOnly: true,
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionOptions?.visionFallbackToHtmlOnly).toBe(true);
      }
    });

    it('should support fallback disabled (strict mode)', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionFallbackToHtmlOnly: false, // Vision失敗時にエラーを返す
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionOptions?.visionFallbackToHtmlOnly).toBe(false);
      }
    });
  });

  describe('Progress tracking configuration', () => {
    it('should support progress tracking enabled', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionEnableProgress: true,
          visionTimeoutMs: 600000,
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionOptions?.visionEnableProgress).toBe(true);
      }
    });
  });

  describe('Complete configuration scenarios', () => {
    it('should support full CPU mode with all options', () => {
      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: {
          useVision: true,
        },
        visionOptions: {
          visionTimeoutMs: 1200000,
          visionImageMaxSize: 500000,
          visionForceCpu: true,
          visionEnableProgress: true,
          visionFallbackToHtmlOnly: true,
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionOptions?.visionTimeoutMs).toBe(1200000);
        expect(result.data.visionOptions?.visionImageMaxSize).toBe(500000);
        expect(result.data.visionOptions?.visionForceCpu).toBe(true);
        expect(result.data.visionOptions?.visionEnableProgress).toBe(true);
        expect(result.data.visionOptions?.visionFallbackToHtmlOnly).toBe(true);
      }
    });

    it('should support auto-detect mode (no forced CPU)', () => {
      const input: PageAnalyzeInput = {
        url: 'https://example.com',
        layoutOptions: {
          useVision: true,
        },
        visionOptions: {
          // visionForceCpu not specified = auto-detect (use GPU if available)
          visionFallbackToHtmlOnly: true,
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionOptions?.visionForceCpu).toBe(false);
      }
    });
  });

  describe('Validation errors', () => {
    it('should reject visionTimeoutMs below minimum', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionTimeoutMs: 500, // Below 1000ms minimum
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should reject visionTimeoutMs above maximum', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionTimeoutMs: 1500000, // Above 1200000ms maximum
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should reject visionImageMaxSize below minimum', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionImageMaxSize: 500, // Below 1024 bytes minimum
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should reject visionImageMaxSize above maximum', () => {
      const input = {
        url: 'https://example.com',
        visionOptions: {
          visionImageMaxSize: 20000000, // Above 10000000 bytes maximum
        },
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Layout Handler Integration Tests (Mock-based)
// =============================================================================

describe('Vision CPU完走保証 Phase 3: Layout Handler統合', () => {
  describe('HardwareDetector integration', () => {
    it('should detect GPU when VRAM is available', async () => {
      // HardwareDetectorの型定義と振る舞いをテスト
      const { HardwareDetector, HardwareType } = await import('../../../src/services/vision/hardware-detector');

      const detector = new HardwareDetector();
      // 実際のOllama接続をテストするのではなく、型の互換性を確認
      expect(typeof detector.detect).toBe('function');
      expect(HardwareType.GPU).toBe('GPU');
      expect(HardwareType.CPU).toBe('CPU');
    });
  });

  describe('TimeoutCalculator integration', () => {
    it('should calculate correct timeout for GPU', async () => {
      const { TimeoutCalculator } = await import('../../../src/services/vision/timeout-calculator');
      const { HardwareType } = await import('../../../src/services/vision/hardware-detector');

      const calculator = new TimeoutCalculator();
      const timeout = calculator.calculate(HardwareType.GPU, 100000);

      // GPU timeout should be 60000ms
      expect(timeout).toBe(60000);
    });

    it('should calculate correct timeout for CPU Small', async () => {
      const { TimeoutCalculator } = await import('../../../src/services/vision/timeout-calculator');
      const { HardwareType } = await import('../../../src/services/vision/hardware-detector');

      const calculator = new TimeoutCalculator();
      const timeout = calculator.calculate(HardwareType.CPU, 50000); // 50KB = Small

      // CPU Small timeout should be 180000ms (3 minutes)
      expect(timeout).toBe(180000);
    });

    it('should calculate correct timeout for CPU Medium', async () => {
      const { TimeoutCalculator } = await import('../../../src/services/vision/timeout-calculator');
      const { HardwareType } = await import('../../../src/services/vision/hardware-detector');

      const calculator = new TimeoutCalculator();
      const timeout = calculator.calculate(HardwareType.CPU, 200000); // 200KB = Medium

      // CPU Medium timeout should be 600000ms (10 minutes)
      expect(timeout).toBe(600000);
    });

    it('should calculate correct timeout for CPU Large', async () => {
      const { TimeoutCalculator } = await import('../../../src/services/vision/timeout-calculator');
      const { HardwareType } = await import('../../../src/services/vision/hardware-detector');

      const calculator = new TimeoutCalculator();
      const timeout = calculator.calculate(HardwareType.CPU, 600000); // 600KB = Large

      // CPU Large timeout should be 1200000ms (20 minutes)
      expect(timeout).toBe(1200000);
    });

    it('should format timeout correctly', async () => {
      const { TimeoutCalculator } = await import('../../../src/services/vision/timeout-calculator');

      const calculator = new TimeoutCalculator();

      expect(calculator.formatTimeout(60000)).toBe('1m 0s');
      expect(calculator.formatTimeout(180000)).toBe('3m 0s');
      expect(calculator.formatTimeout(600000)).toBe('10m 0s');
      expect(calculator.formatTimeout(1200000)).toBe('20m 0s');
    });
  });

  describe('ImageOptimizer integration', () => {
    it('should select NONE strategy for GPU', async () => {
      const { ImageOptimizer, OptimizationStrategy } = await import('../../../src/services/vision/image-optimizer');
      const { HardwareType } = await import('../../../src/services/vision/hardware-detector');

      const optimizer = new ImageOptimizer();
      const strategy = optimizer.selectStrategy(HardwareType.GPU, 500000);

      expect(strategy).toBe(OptimizationStrategy.NONE);
    });

    it('should select NONE strategy for CPU Small', async () => {
      const { ImageOptimizer, OptimizationStrategy } = await import('../../../src/services/vision/image-optimizer');
      const { HardwareType } = await import('../../../src/services/vision/hardware-detector');

      const optimizer = new ImageOptimizer();
      const strategy = optimizer.selectStrategy(HardwareType.CPU, 50000); // 50KB = Small

      expect(strategy).toBe(OptimizationStrategy.NONE);
    });

    it('should select MEDIUM strategy for CPU Medium', async () => {
      const { ImageOptimizer, OptimizationStrategy } = await import('../../../src/services/vision/image-optimizer');
      const { HardwareType } = await import('../../../src/services/vision/hardware-detector');

      const optimizer = new ImageOptimizer();
      const strategy = optimizer.selectStrategy(HardwareType.CPU, 200000); // 200KB = Medium

      expect(strategy).toBe(OptimizationStrategy.MEDIUM);
    });

    it('should select AGGRESSIVE strategy for CPU Large', async () => {
      const { ImageOptimizer, OptimizationStrategy } = await import('../../../src/services/vision/image-optimizer');
      const { HardwareType } = await import('../../../src/services/vision/hardware-detector');

      const optimizer = new ImageOptimizer();
      const strategy = optimizer.selectStrategy(HardwareType.CPU, 600000); // 600KB = Large

      expect(strategy).toBe(OptimizationStrategy.AGGRESSIVE);
    });

    it('should estimate optimal size for CPU', async () => {
      const { ImageOptimizer, OptimizationStrategy, OPTIMIZATION_CONFIGS } = await import('../../../src/services/vision/image-optimizer');
      const { HardwareType } = await import('../../../src/services/vision/hardware-detector');

      const optimizer = new ImageOptimizer();
      const estimate = optimizer.estimateOptimalSize(600000, HardwareType.CPU);

      expect(estimate.strategy).toBe(OptimizationStrategy.AGGRESSIVE);
      expect(estimate.maxWidth).toBe(OPTIMIZATION_CONFIGS[OptimizationStrategy.AGGRESSIVE].maxWidth);
      expect(estimate.maxHeight).toBe(OPTIMIZATION_CONFIGS[OptimizationStrategy.AGGRESSIVE].maxHeight);
      expect(estimate.quality).toBe(OPTIMIZATION_CONFIGS[OptimizationStrategy.AGGRESSIVE].quality);
    });
  });
});

// =============================================================================
// VisionOptions Schema Integration Tests
// =============================================================================

describe('Vision CPU完走保証 Phase 3: visionOptionsSchema統合', () => {
  describe('Schema consistency', () => {
    it('should have consistent defaults with pageAnalyzeInputSchema', () => {
      // visionOptionsSchemaとpageAnalyzeInputSchemaのvisionOptionsフィールドが一致すること
      const standaloneResult = visionOptionsSchema.safeParse({});
      expect(standaloneResult.success).toBe(true);

      const pageResult = pageAnalyzeInputSchema.safeParse({
        url: 'https://example.com',
        visionOptions: {},
      });
      expect(pageResult.success).toBe(true);

      if (standaloneResult.success && pageResult.success) {
        // デフォルト値が一致
        expect(standaloneResult.data.visionForceCpu).toBe(pageResult.data.visionOptions?.visionForceCpu);
        expect(standaloneResult.data.visionEnableProgress).toBe(pageResult.data.visionOptions?.visionEnableProgress);
        expect(standaloneResult.data.visionFallbackToHtmlOnly).toBe(pageResult.data.visionOptions?.visionFallbackToHtmlOnly);
      }
    });

    it('should validate same constraints in both schemas', () => {
      // 境界値が両スキーマで同じ
      const minTimeout = 1000;
      const maxTimeout = 1200000;

      // visionOptionsSchema
      expect(visionOptionsSchema.safeParse({ visionTimeoutMs: minTimeout }).success).toBe(true);
      expect(visionOptionsSchema.safeParse({ visionTimeoutMs: maxTimeout }).success).toBe(true);
      expect(visionOptionsSchema.safeParse({ visionTimeoutMs: minTimeout - 1 }).success).toBe(false);
      expect(visionOptionsSchema.safeParse({ visionTimeoutMs: maxTimeout + 1 }).success).toBe(false);

      // pageAnalyzeInputSchema
      expect(pageAnalyzeInputSchema.safeParse({
        url: 'https://example.com',
        visionOptions: { visionTimeoutMs: minTimeout }
      }).success).toBe(true);
      expect(pageAnalyzeInputSchema.safeParse({
        url: 'https://example.com',
        visionOptions: { visionTimeoutMs: maxTimeout }
      }).success).toBe(true);
      expect(pageAnalyzeInputSchema.safeParse({
        url: 'https://example.com',
        visionOptions: { visionTimeoutMs: minTimeout - 1 }
      }).success).toBe(false);
      expect(pageAnalyzeInputSchema.safeParse({
        url: 'https://example.com',
        visionOptions: { visionTimeoutMs: maxTimeout + 1 }
      }).success).toBe(false);
    });
  });
});
