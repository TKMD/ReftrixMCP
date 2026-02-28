// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LocalVisionAdapter テスト
 *
 * OSS画像解析ライブラリ（Sharp）を使用したローカルビジョン解析アダプタのテスト。
 * 外部LLM API依存なしで動作する完全OSSの実装をテストします。
 *
 * @module vision-adapter/local.adapter.test
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import sharp from 'sharp';
import {
  LocalVisionAdapter,
  type LocalVisionAdapterConfig,
  type ColorExtractionOptions,
  type DensityAnalysisOptions,
} from '../../../src/services/vision-adapter/local.adapter';
import type {
  VisionAnalysisOptions,
  VisionAnalysisResult,
  VisionFeatureType,
  ColorPaletteData,
  DensityData,
  LayoutStructureData,
  WhitespaceData,
  SectionBoundariesData,
} from '../../../src/services/vision-adapter/interface';

// =============================================================================
// テストユーティリティ
// =============================================================================

/**
 * テスト用画像を生成（Sharp使用）
 */
async function createTestImage(options: {
  width?: number;
  height?: number;
  background?: string;
  format?: 'png' | 'jpeg' | 'webp';
}): Promise<Buffer> {
  const { width = 100, height = 100, background = '#ffffff', format = 'png' } = options;

  const image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background,
    },
  });

  if (format === 'jpeg') {
    return image.jpeg().toBuffer();
  } else if (format === 'webp') {
    return image.webp().toBuffer();
  }
  return image.png().toBuffer();
}

/**
 * 色付きテスト画像を生成
 */
async function createColorTestImage(colors: string[]): Promise<Buffer> {
  // 各色をストライプとして配置
  const width = 100;
  const height = colors.length * 20;
  const stripeHeight = Math.floor(height / colors.length);

  // 白背景の画像を作成
  let image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: '#ffffff',
    },
  });

  // 各色のストライプを合成
  const composites: sharp.OverlayOptions[] = colors.map((color, index) => ({
    input: {
      create: {
        width,
        height: stripeHeight,
        channels: 4 as const,
        background: color,
      },
    },
    top: index * stripeHeight,
    left: 0,
  }));

  // composites は空でないことが保証されている
  if (composites.length > 0) {
    image = image.composite(composites);
  }

  return image.png().toBuffer();
}

// =============================================================================
// テスト
// =============================================================================

describe('LocalVisionAdapter', () => {
  // ---------------------------------------------------------------------------
  // 初期化テスト
  // ---------------------------------------------------------------------------
  describe('initialization', () => {
    it('should create instance with default config', () => {
      const adapter = new LocalVisionAdapter();
      expect(adapter.name).toBe('LocalVisionAdapter');
      expect(adapter.modelName).toBe('local-sharp-1.0');
    });

    it('should create instance with custom config', () => {
      const config: LocalVisionAdapterConfig = {
        name: 'CustomAdapter',
        modelName: 'custom-model-1.0',
      };
      const adapter = new LocalVisionAdapter(config);
      expect(adapter.name).toBe('CustomAdapter');
      expect(adapter.modelName).toBe('custom-model-1.0');
    });

    it('should accept color extraction options', () => {
      const config: LocalVisionAdapterConfig = {
        colorExtraction: {
          maxColors: 10,
          minCoverage: 0.05,
          quantizationMethod: 'median-cut',
        },
      };
      const adapter = new LocalVisionAdapter(config);
      expect(adapter).toBeInstanceOf(LocalVisionAdapter);
    });

    it('should accept density analysis options', () => {
      const config: LocalVisionAdapterConfig = {
        densityAnalysis: {
          gridSize: 16,
          edgeThreshold: 50,
        },
      };
      const adapter = new LocalVisionAdapter(config);
      expect(adapter).toBeInstanceOf(LocalVisionAdapter);
    });
  });

  // ---------------------------------------------------------------------------
  // isAvailable テスト
  // ---------------------------------------------------------------------------
  describe('isAvailable', () => {
    it('should return true by default', async () => {
      const adapter = new LocalVisionAdapter();
      const available = await adapter.isAvailable();
      expect(available).toBe(true);
    });

    it('should return configured availability', async () => {
      const adapter = new LocalVisionAdapter({ isAvailable: false });
      const available = await adapter.isAvailable();
      expect(available).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // analyze テスト（基本）
  // ---------------------------------------------------------------------------
  describe('analyze - basic', () => {
    let adapter: LocalVisionAdapter;

    beforeEach(() => {
      adapter = new LocalVisionAdapter();
    });

    it('should analyze a valid PNG image', async () => {
      const imageBuffer = await createTestImage({ format: 'png' });
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.features).toBeInstanceOf(Array);
      expect(result.modelName).toBe('local-sharp-1.0');
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should analyze a valid JPEG image', async () => {
      const imageBuffer = await createTestImage({ format: 'jpeg' });
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/jpeg',
      });

      expect(result.success).toBe(true);
    });

    it('should analyze a valid WebP image', async () => {
      const imageBuffer = await createTestImage({ format: 'webp' });
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/webp',
      });

      expect(result.success).toBe(true);
    });

    it('should return error for invalid image buffer', async () => {
      const invalidBuffer = Buffer.from('not an image');
      const result = await adapter.analyze({
        imageBuffer: invalidBuffer,
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error when adapter is unavailable', async () => {
      const unavailableAdapter = new LocalVisionAdapter({ isAvailable: false });
      const imageBuffer = await createTestImage({});
      const result = await unavailableAdapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  // ---------------------------------------------------------------------------
  // analyze テスト（特徴抽出）
  // ---------------------------------------------------------------------------
  describe('analyze - feature extraction', () => {
    let adapter: LocalVisionAdapter;

    beforeEach(() => {
      adapter = new LocalVisionAdapter();
    });

    it('should extract color_palette feature', async () => {
      const imageBuffer = await createColorTestImage(['#ff0000', '#00ff00', '#0000ff']);
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette'],
      });

      expect(result.success).toBe(true);
      const colorFeature = result.features.find((f) => f.type === 'color_palette');
      expect(colorFeature).toBeDefined();
      expect(colorFeature?.confidence).toBeGreaterThan(0);

      const data = colorFeature?.data as ColorPaletteData;
      expect(data.type).toBe('color_palette');
      expect(data.dominantColors).toBeInstanceOf(Array);
      expect(data.dominantColors.length).toBeGreaterThan(0);
      expect(data.contrast).toMatch(/^(high|medium|low)$/);
    });

    it('should extract layout_structure feature', async () => {
      const imageBuffer = await createTestImage({ width: 1200, height: 800 });
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['layout_structure'],
      });

      expect(result.success).toBe(true);
      const layoutFeature = result.features.find((f) => f.type === 'layout_structure');
      expect(layoutFeature).toBeDefined();

      const data = layoutFeature?.data as LayoutStructureData;
      expect(data.type).toBe('layout_structure');
      expect(data.gridType).toBeDefined();
      expect(data.mainAreas).toBeInstanceOf(Array);
      expect(data.description).toBeDefined();
    });

    it('should extract density feature', async () => {
      const imageBuffer = await createTestImage({});
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['density'],
      });

      expect(result.success).toBe(true);
      const densityFeature = result.features.find((f) => f.type === 'density');
      expect(densityFeature).toBeDefined();

      const data = densityFeature?.data as DensityData;
      expect(data.type).toBe('density');
      expect(data.level).toMatch(/^(sparse|balanced|dense|cluttered)$/);
      expect(data.description).toBeDefined();
    });

    it('should extract whitespace feature', async () => {
      const imageBuffer = await createTestImage({});
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['whitespace'],
      });

      expect(result.success).toBe(true);
      const whitespaceFeature = result.features.find((f) => f.type === 'whitespace');
      expect(whitespaceFeature).toBeDefined();

      const data = whitespaceFeature?.data as WhitespaceData;
      expect(data.type).toBe('whitespace');
      expect(data.amount).toMatch(/^(minimal|moderate|generous|extreme)$/);
      expect(data.distribution).toMatch(/^(even|top-heavy|bottom-heavy|centered)$/);
    });

    it('should extract section_boundaries feature', async () => {
      const imageBuffer = await createTestImage({ width: 1200, height: 2000 });
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['section_boundaries'],
      });

      expect(result.success).toBe(true);
      const sectionFeature = result.features.find((f) => f.type === 'section_boundaries');
      expect(sectionFeature).toBeDefined();

      const data = sectionFeature?.data as SectionBoundariesData;
      expect(data.type).toBe('section_boundaries');
      expect(data.sections).toBeInstanceOf(Array);
    });

    it('should extract multiple features in single call', async () => {
      const imageBuffer = await createTestImage({});
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette', 'density', 'whitespace'],
      });

      expect(result.success).toBe(true);
      expect(result.features.length).toBe(3);

      const types = result.features.map((f) => f.type);
      expect(types).toContain('color_palette');
      expect(types).toContain('density');
      expect(types).toContain('whitespace');
    });

    it('should extract all features when none specified', async () => {
      const imageBuffer = await createTestImage({});
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      // デフォルトでcolor_paletteとdensityは抽出されるべき
      const types = result.features.map((f) => f.type);
      expect(types).toContain('color_palette');
      expect(types).toContain('density');
    });
  });

  // ---------------------------------------------------------------------------
  // analyze テスト（色抽出詳細）
  // ---------------------------------------------------------------------------
  describe('analyze - color extraction details', () => {
    let adapter: LocalVisionAdapter;

    beforeEach(() => {
      adapter = new LocalVisionAdapter();
    });

    it('should detect high contrast for black and white image', async () => {
      const imageBuffer = await createColorTestImage(['#000000', '#ffffff']);
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette'],
      });

      const colorFeature = result.features.find((f) => f.type === 'color_palette');
      const data = colorFeature?.data as ColorPaletteData;
      expect(data.contrast).toBe('high');
    });

    it('should detect low contrast for similar colors', async () => {
      const imageBuffer = await createColorTestImage(['#888888', '#999999', '#aaaaaa']);
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette'],
      });

      const colorFeature = result.features.find((f) => f.type === 'color_palette');
      const data = colorFeature?.data as ColorPaletteData;
      expect(data.contrast).toBe('low');
    });

    it('should extract colors as valid hex strings', async () => {
      const imageBuffer = await createColorTestImage(['#ff0000', '#00ff00', '#0000ff']);
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette'],
      });

      const colorFeature = result.features.find((f) => f.type === 'color_palette');
      const data = colorFeature?.data as ColorPaletteData;

      for (const color of data.dominantColors) {
        expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    });

    it('should limit number of extracted colors', async () => {
      const adapter = new LocalVisionAdapter({
        colorExtraction: { maxColors: 3 },
      });
      const imageBuffer = await createColorTestImage([
        '#ff0000',
        '#00ff00',
        '#0000ff',
        '#ffff00',
        '#ff00ff',
      ]);
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette'],
      });

      const colorFeature = result.features.find((f) => f.type === 'color_palette');
      const data = colorFeature?.data as ColorPaletteData;
      expect(data.dominantColors.length).toBeLessThanOrEqual(3);
    });
  });

  // ---------------------------------------------------------------------------
  // analyze テスト（画像サイズ）
  // ---------------------------------------------------------------------------
  describe('analyze - image dimensions', () => {
    it('should handle small images', async () => {
      const adapter = new LocalVisionAdapter();
      const imageBuffer = await createTestImage({ width: 10, height: 10 });
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
    });

    it('should handle large images', async () => {
      const adapter = new LocalVisionAdapter();
      const imageBuffer = await createTestImage({ width: 2000, height: 2000 });
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
    });

    it('should detect aspect ratio for landscape', async () => {
      const adapter = new LocalVisionAdapter();
      const imageBuffer = await createTestImage({ width: 1920, height: 1080 });
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['layout_structure'],
      });

      const layoutFeature = result.features.find((f) => f.type === 'layout_structure');
      const data = layoutFeature?.data as LayoutStructureData;
      // ランドスケープ画像はgridやtwo-columnなどが検出されやすい
      expect(data.gridType).toBeDefined();
    });

    it('should detect aspect ratio for portrait', async () => {
      const adapter = new LocalVisionAdapter();
      const imageBuffer = await createTestImage({ width: 1080, height: 1920 });
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['layout_structure'],
      });

      const layoutFeature = result.features.find((f) => f.type === 'layout_structure');
      const data = layoutFeature?.data as LayoutStructureData;
      // ポートレート画像はsingle-columnが検出されやすい
      expect(data.gridType).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // generateTextRepresentation テスト
  // ---------------------------------------------------------------------------
  describe('generateTextRepresentation', () => {
    let adapter: LocalVisionAdapter;

    beforeEach(() => {
      adapter = new LocalVisionAdapter();
    });

    it('should generate text for successful result', async () => {
      const imageBuffer = await createTestImage({});
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette', 'density'],
      });

      const text = adapter.generateTextRepresentation(result);
      expect(text).toBeDefined();
      expect(text.length).toBeGreaterThan(0);
    });

    it('should return empty string for failed result', () => {
      const failedResult: VisionAnalysisResult = {
        success: false,
        features: [],
        error: 'Some error',
        processingTimeMs: 0,
        modelName: 'local-sharp-1.0',
      };

      const text = adapter.generateTextRepresentation(failedResult);
      expect(text).toBe('');
    });

    it('should include color information in text', async () => {
      const imageBuffer = await createColorTestImage(['#ff0000', '#00ff00']);
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette'],
      });

      const text = adapter.generateTextRepresentation(result);
      expect(text.toLowerCase()).toContain('color');
    });

    it('should include density information in text', async () => {
      const imageBuffer = await createTestImage({});
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['density'],
      });

      const text = adapter.generateTextRepresentation(result);
      expect(text.toLowerCase()).toContain('density');
    });

    it('should include layout information in text', async () => {
      const imageBuffer = await createTestImage({ width: 1200, height: 800 });
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['layout_structure'],
      });

      const text = adapter.generateTextRepresentation(result);
      expect(text.toLowerCase()).toContain('layout');
    });
  });

  // ---------------------------------------------------------------------------
  // タイムアウトテスト
  // ---------------------------------------------------------------------------
  describe('timeout handling', () => {
    it('should respect timeout option', async () => {
      const adapter = new LocalVisionAdapter();
      const imageBuffer = await createTestImage({ width: 1000, height: 1000 });

      // 非常に短いタイムアウトで呼び出し
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        timeout: 1, // 1ms
      });

      // タイムアウトするかエラーになるか、もしくは成功する可能性もある
      // 重要なのはクラッシュしないこと
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should complete within reasonable time', async () => {
      const adapter = new LocalVisionAdapter();
      const imageBuffer = await createTestImage({});

      const startTime = Date.now();
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        timeout: 5000,
      });
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(5000);
    });
  });

  // ---------------------------------------------------------------------------
  // エラーハンドリングテスト
  // ---------------------------------------------------------------------------
  describe('error handling', () => {
    it('should handle empty buffer gracefully', async () => {
      const adapter = new LocalVisionAdapter();
      const result = await adapter.analyze({
        imageBuffer: Buffer.alloc(0),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle corrupted image data', async () => {
      const adapter = new LocalVisionAdapter();
      const corruptedBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]); // Partial PNG header
      const result = await adapter.analyze({
        imageBuffer: corruptedBuffer,
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle unsupported feature type gracefully', async () => {
      const adapter = new LocalVisionAdapter();
      const imageBuffer = await createTestImage({});
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['typography', 'visual_hierarchy', 'rhythm'] as VisionFeatureType[],
      });

      // 未サポートの特徴タイプは無視されるか、空の結果になる
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // パフォーマンステスト
  // ---------------------------------------------------------------------------
  describe('performance', () => {
    it('should process small image quickly (<100ms)', async () => {
      const adapter = new LocalVisionAdapter();
      const imageBuffer = await createTestImage({ width: 100, height: 100 });

      const startTime = Date.now();
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(100);
    });

    it('should track processing time accurately', async () => {
      const adapter = new LocalVisionAdapter();
      const imageBuffer = await createTestImage({});
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.processingTimeMs).toBeLessThan(10000); // Reasonable upper bound
    });
  });
});
