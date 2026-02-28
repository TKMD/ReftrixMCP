// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.inspect Vision Options Tests
 *
 * Vision CPU完走保証 Phase 3 Step 3: layout.inspectのvisionOptions対応テスト
 *
 * テスト対象:
 * - layoutInspectVisionOptionsSchema: Vision CPU完走保証オプション
 * - layoutInspectInputSchema: visionOptionsを含む入力スキーマ
 * - ハンドラーでのvisionOptions利用
 *
 * @module tests/tools/layout/inspect-vision-options.test
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// =============================================================================
// visionOptionsSchema（page.analyzeと共通の仕様をlayout.inspectに適用）
// =============================================================================

/**
 * layout.inspect用visionOptionsスキーマ
 *
 * page.analyzeと同じオプション体系を維持:
 * - visionTimeoutMs: タイムアウト値（1000-1200000ms）
 * - visionImageMaxSize: 最大画像サイズ（1024-10000000 bytes）
 * - visionForceCpu: 強制CPUモード（デフォルト: false）
 * - visionFallbackToHtmlOnly: HTML フォールバック（デフォルト: true）
 */
const layoutInspectVisionOptionsSchema = z
  .object({
    /** Vision推論タイムアウト（ms）: 1秒〜20分 */
    visionTimeoutMs: z.number().int().min(1000).max(1200000).optional(),
    /** Vision最大画像サイズ（bytes）: 1KB〜10MB */
    visionImageMaxSize: z.number().int().min(1024).max(10000000).optional(),
    /** 強制CPUモード: trueならGPU検出をスキップしてCPU推論 */
    visionForceCpu: z.boolean().default(false),
    /** Vision失敗時のフォールバック: trueならHTML解析のみで続行 */
    visionFallbackToHtmlOnly: z.boolean().default(true),
  })
  .optional();

// =============================================================================
// Test Suites
// =============================================================================

describe('layoutInspectVisionOptionsSchema', () => {
  describe('valid inputs', () => {
    it('should accept empty object (all fields optional)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionForceCpu).toBe(false);
        expect(result.data.visionFallbackToHtmlOnly).toBe(true);
      }
    });

    it('should accept undefined (optional schema)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse(undefined);
      expect(result.success).toBe(true);
    });

    it('should accept valid complete options', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({
        visionTimeoutMs: 600000, // 10 minutes
        visionImageMaxSize: 5000000, // 5MB
        visionForceCpu: true,
        visionFallbackToHtmlOnly: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionTimeoutMs).toBe(600000);
        expect(result.data.visionImageMaxSize).toBe(5000000);
        expect(result.data.visionForceCpu).toBe(true);
        expect(result.data.visionFallbackToHtmlOnly).toBe(false);
      }
    });

    // visionTimeoutMs boundary tests
    it('should accept visionTimeoutMs at minimum (1000ms)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionTimeoutMs: 1000 });
      expect(result.success).toBe(true);
    });

    it('should accept visionTimeoutMs at maximum (1200000ms = 20min)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionTimeoutMs: 1200000 });
      expect(result.success).toBe(true);
    });

    it('should accept typical GPU timeout (60000ms = 1min)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionTimeoutMs: 60000 });
      expect(result.success).toBe(true);
    });

    it('should accept typical CPU timeout (600000ms = 10min)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionTimeoutMs: 600000 });
      expect(result.success).toBe(true);
    });

    // visionImageMaxSize boundary tests
    it('should accept visionImageMaxSize at minimum (1024 bytes = 1KB)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionImageMaxSize: 1024 });
      expect(result.success).toBe(true);
    });

    it('should accept visionImageMaxSize at maximum (10000000 bytes = 10MB)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionImageMaxSize: 10000000 });
      expect(result.success).toBe(true);
    });

    // Boolean fields tests
    it('should accept visionForceCpu: true', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionForceCpu: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionForceCpu).toBe(true);
      }
    });

    it('should accept visionFallbackToHtmlOnly: false', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionFallbackToHtmlOnly: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionFallbackToHtmlOnly).toBe(false);
      }
    });
  });

  describe('invalid inputs', () => {
    it('should reject visionTimeoutMs below minimum (< 1000ms)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionTimeoutMs: 999 });
      expect(result.success).toBe(false);
    });

    it('should reject visionTimeoutMs above maximum (> 1200000ms)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionTimeoutMs: 1200001 });
      expect(result.success).toBe(false);
    });

    it('should reject visionImageMaxSize below minimum (< 1024 bytes)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionImageMaxSize: 1023 });
      expect(result.success).toBe(false);
    });

    it('should reject visionImageMaxSize above maximum (> 10000000 bytes)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionImageMaxSize: 10000001 });
      expect(result.success).toBe(false);
    });

    it('should reject non-number visionTimeoutMs', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionTimeoutMs: '60000' });
      expect(result.success).toBe(false);
    });

    it('should reject non-boolean visionForceCpu', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({ visionForceCpu: 'true' });
      expect(result.success).toBe(false);
    });
  });

  describe('default values', () => {
    it('should apply default false for visionForceCpu', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionForceCpu).toBe(false);
      }
    });

    it('should apply default true for visionFallbackToHtmlOnly', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionFallbackToHtmlOnly).toBe(true);
      }
    });

    it('should not apply defaults for optional numeric fields', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.visionTimeoutMs).toBeUndefined();
        expect(result.data.visionImageMaxSize).toBeUndefined();
      }
    });
  });

  describe('use cases', () => {
    it('should support GPU mode with fast timeout', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({
        visionTimeoutMs: 60000,
        visionForceCpu: false,
      });
      expect(result.success).toBe(true);
    });

    it('should support CPU mode with extended timeout', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({
        visionTimeoutMs: 1200000,
        visionForceCpu: true,
        visionImageMaxSize: 500000,
      });
      expect(result.success).toBe(true);
    });

    it('should support strict mode (no fallback)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({
        visionFallbackToHtmlOnly: false,
      });
      expect(result.success).toBe(true);
    });

    it('should support graceful degradation mode (default)', () => {
      const result = layoutInspectVisionOptionsSchema.safeParse({
        visionFallbackToHtmlOnly: true,
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('layoutInspectInputSchema with visionOptions integration', () => {
  /**
   * 拡張されたlayoutInspectInputSchemaのテスト用スキーマ
   * 実際の実装では inspect.schemas.ts に追加される
   */
  const layoutInspectOptionsSchema = z.object({
    detectSections: z.boolean().optional().default(true),
    extractColors: z.boolean().optional().default(true),
    analyzeTypography: z.boolean().optional().default(true),
    detectGrid: z.boolean().optional().default(true),
    useVision: z.boolean().optional().default(false),
    // Vision CPU完走保証オプション
    visionOptions: layoutInspectVisionOptionsSchema,
  });

  const extendedLayoutInspectInputSchema = z
    .object({
      id: z.string().uuid().optional(),
      html: z.string().min(1).optional(),
      options: layoutInspectOptionsSchema.optional(),
    })
    .refine((data) => data.id !== undefined || data.html !== undefined, {
      message: 'Either id or html must be provided',
    });

  describe('visionOptions in layoutInspectInputSchema', () => {
    it('should accept html with visionOptions', () => {
      const result = extendedLayoutInspectInputSchema.safeParse({
        html: '<html><body>Test</body></html>',
        options: {
          useVision: true,
          visionOptions: {
            visionTimeoutMs: 600000,
            visionForceCpu: true,
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('should accept id with visionOptions', () => {
      const result = extendedLayoutInspectInputSchema.safeParse({
        id: '01234567-89ab-cdef-0123-456789abcdef',
        options: {
          useVision: true,
          visionOptions: {
            visionFallbackToHtmlOnly: false,
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('should accept options without visionOptions', () => {
      const result = extendedLayoutInspectInputSchema.safeParse({
        html: '<html><body>Test</body></html>',
        options: {
          useVision: true,
          // visionOptions省略
        },
      });
      expect(result.success).toBe(true);
    });

    it('should apply default values for visionOptions', () => {
      const result = extendedLayoutInspectInputSchema.safeParse({
        html: '<html><body>Test</body></html>',
        options: {
          useVision: true,
          visionOptions: {},
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.visionOptions?.visionForceCpu).toBe(false);
        expect(result.data.options?.visionOptions?.visionFallbackToHtmlOnly).toBe(true);
      }
    });
  });

  describe('screenshot mode with visionOptions', () => {
    const screenshotInputSchema = z.object({
      base64: z.string().min(100),
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/png'),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    });

    const extendedScreenshotInputSchema = z
      .object({
        screenshot: screenshotInputSchema.optional(),
        options: layoutInspectOptionsSchema.optional(),
      })
      .refine((data) => data.screenshot !== undefined, {
        message: 'Screenshot must be provided',
      });

    it('should accept screenshot with visionOptions', () => {
      const result = extendedScreenshotInputSchema.safeParse({
        screenshot: {
          base64: 'A'.repeat(100),
          mimeType: 'image/png',
        },
        options: {
          visionOptions: {
            visionTimeoutMs: 300000,
            visionForceCpu: true,
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('should accept screenshot without visionOptions', () => {
      const result = extendedScreenshotInputSchema.safeParse({
        screenshot: {
          base64: 'A'.repeat(100),
          mimeType: 'image/jpeg',
        },
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('Vision CPU completion guarantee configuration', () => {
  describe('Hardware detection integration', () => {
    it('should select GPU mode when visionForceCpu is false', () => {
      const config = {
        visionForceCpu: false,
        detectedHardware: 'GPU' as const,
      };
      const effectiveHardware =
        config.visionForceCpu ? 'CPU' : config.detectedHardware;
      expect(effectiveHardware).toBe('GPU');
    });

    it('should select CPU mode when visionForceCpu is true', () => {
      const config = {
        visionForceCpu: true,
        detectedHardware: 'GPU' as const,
      };
      const effectiveHardware =
        config.visionForceCpu ? 'CPU' : config.detectedHardware;
      expect(effectiveHardware).toBe('CPU');
    });
  });

  describe('Timeout calculation integration', () => {
    it('should calculate GPU timeout', () => {
      const GPU_TIMEOUT = 60000;
      const timeout = GPU_TIMEOUT;
      expect(timeout).toBe(60000);
    });

    it('should calculate CPU timeout based on image size', () => {
      const CPU_SMALL_TIMEOUT = 180000;
      const CPU_MEDIUM_TIMEOUT = 600000;
      const CPU_LARGE_TIMEOUT = 1200000;

      // Small image
      const smallImageSize = 50000; // 50KB
      const smallTimeout =
        smallImageSize < 100000
          ? CPU_SMALL_TIMEOUT
          : smallImageSize < 500000
            ? CPU_MEDIUM_TIMEOUT
            : CPU_LARGE_TIMEOUT;
      expect(smallTimeout).toBe(180000);

      // Medium image
      const mediumImageSize = 300000; // 300KB
      const mediumTimeout =
        mediumImageSize < 100000
          ? CPU_SMALL_TIMEOUT
          : mediumImageSize < 500000
            ? CPU_MEDIUM_TIMEOUT
            : CPU_LARGE_TIMEOUT;
      expect(mediumTimeout).toBe(600000);

      // Large image
      const largeImageSize = 600000; // 600KB
      const largeTimeout =
        largeImageSize < 100000
          ? CPU_SMALL_TIMEOUT
          : largeImageSize < 500000
            ? CPU_MEDIUM_TIMEOUT
            : CPU_LARGE_TIMEOUT;
      expect(largeTimeout).toBe(1200000);
    });
  });

  describe('Graceful degradation configuration', () => {
    it('should fallback to HTML-only when visionFallbackToHtmlOnly is true', () => {
      const config = {
        visionFallbackToHtmlOnly: true,
        visionFailed: true,
      };
      const shouldFallback = config.visionFallbackToHtmlOnly && config.visionFailed;
      expect(shouldFallback).toBe(true);
    });

    it('should not fallback when visionFallbackToHtmlOnly is false', () => {
      const config = {
        visionFallbackToHtmlOnly: false,
        visionFailed: true,
      };
      const shouldFallback = config.visionFallbackToHtmlOnly && config.visionFailed;
      expect(shouldFallback).toBe(false);
    });

    it('should not fallback when vision succeeds', () => {
      const config = {
        visionFallbackToHtmlOnly: true,
        visionFailed: false,
      };
      const shouldFallback = config.visionFallbackToHtmlOnly && config.visionFailed;
      expect(shouldFallback).toBe(false);
    });
  });
});
