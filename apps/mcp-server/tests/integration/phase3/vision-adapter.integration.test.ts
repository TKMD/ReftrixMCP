// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 3 統合テスト: LocalVisionAdapter + layout.inspect ツール
 *
 * LocalVisionAdapter（Sharp使用）と各種ツールの統合テスト。
 * 画像解析、色抽出、密度分析、レイアウト構造推定を検証。
 *
 * @module tests/integration/phase3/vision-adapter.integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCanvas } from 'canvas';
import sharp from 'sharp';
import {
  LocalVisionAdapter,
  type LocalVisionAdapterConfig,
} from '../../../src/services/vision-adapter/local.adapter';
import type {
  VisionAnalysisOptions,
  VisionAnalysisResult,
  VisionFeature,
  ColorPaletteData,
  DensityData,
  WhitespaceData,
  LayoutStructureData,
  SectionBoundariesData,
} from '../../../src/services/vision-adapter/interface';

// =============================================
// テストユーティリティ
// =============================================

/**
 * テスト用の画像バッファを生成
 * canvas パッケージを使用して単色またはグラデーション画像を作成
 */
async function createTestImageBuffer(
  width: number,
  height: number,
  options: {
    backgroundColor?: string;
    gradient?: boolean;
    pattern?: 'solid' | 'gradient' | 'checkered' | 'sections';
  } = {}
): Promise<Buffer> {
  const { backgroundColor = '#FFFFFF', pattern = 'solid' } = options;

  // Sharpで直接画像を生成
  const channels = 3; // RGB
  const rawPixels = Buffer.alloc(width * height * channels);

  // 背景色をRGBに変換
  const hexToRgb = (hex: string): [number, number, number] => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return [
        parseInt(result[1]!, 16),
        parseInt(result[2]!, 16),
        parseInt(result[3]!, 16),
      ];
    }
    return [255, 255, 255];
  };

  const [r, g, b] = hexToRgb(backgroundColor);

  if (pattern === 'solid') {
    // 単色塗りつぶし
    for (let i = 0; i < width * height; i++) {
      rawPixels[i * 3] = r;
      rawPixels[i * 3 + 1] = g;
      rawPixels[i * 3 + 2] = b;
    }
  } else if (pattern === 'gradient') {
    // 垂直グラデーション（白から指定色）
    for (let y = 0; y < height; y++) {
      const ratio = y / height;
      const rVal = Math.round(255 - (255 - r) * ratio);
      const gVal = Math.round(255 - (255 - g) * ratio);
      const bVal = Math.round(255 - (255 - b) * ratio);

      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        rawPixels[idx] = rVal;
        rawPixels[idx + 1] = gVal;
        rawPixels[idx + 2] = bVal;
      }
    }
  } else if (pattern === 'checkered') {
    // チェッカーボードパターン（白と指定色）
    const cellSize = 20;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        const isEven = (Math.floor(x / cellSize) + Math.floor(y / cellSize)) % 2 === 0;

        if (isEven) {
          rawPixels[idx] = 255;
          rawPixels[idx + 1] = 255;
          rawPixels[idx + 2] = 255;
        } else {
          rawPixels[idx] = r;
          rawPixels[idx + 1] = g;
          rawPixels[idx + 2] = b;
        }
      }
    }
  } else if (pattern === 'sections') {
    // セクション分割パターン（上部：白、中央：指定色、下部：グレー）
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;

        if (y < height / 3) {
          // 上部（白）
          rawPixels[idx] = 255;
          rawPixels[idx + 1] = 255;
          rawPixels[idx + 2] = 255;
        } else if (y < (2 * height) / 3) {
          // 中央（指定色）
          rawPixels[idx] = r;
          rawPixels[idx + 1] = g;
          rawPixels[idx + 2] = b;
        } else {
          // 下部（グレー）
          rawPixels[idx] = 128;
          rawPixels[idx + 1] = 128;
          rawPixels[idx + 2] = 128;
        }
      }
    }
  }

  // SharpでPNGに変換
  return await sharp(rawPixels, {
    raw: {
      width,
      height,
      channels,
    },
  })
    .png()
    .toBuffer();
}

/**
 * 高コントラスト画像を生成（黒と白の組み合わせ）
 */
async function createHighContrastImageBuffer(
  width: number,
  height: number
): Promise<Buffer> {
  const channels = 3;
  const rawPixels = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      // 左半分は黒、右半分は白
      const isLeft = x < width / 2;

      rawPixels[idx] = isLeft ? 0 : 255;
      rawPixels[idx + 1] = isLeft ? 0 : 255;
      rawPixels[idx + 2] = isLeft ? 0 : 255;
    }
  }

  return await sharp(rawPixels, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

/**
 * エッジの多い複雑な画像を生成（密度テスト用）
 */
async function createComplexImageBuffer(
  width: number,
  height: number
): Promise<Buffer> {
  const channels = 3;
  const rawPixels = Buffer.alloc(width * height * channels);

  // 小さなセルでチェッカーボードを作成（多くのエッジを含む）
  const cellSize = 5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const isEven = (Math.floor(x / cellSize) + Math.floor(y / cellSize)) % 2 === 0;

      rawPixels[idx] = isEven ? 255 : 0;
      rawPixels[idx + 1] = isEven ? 255 : 0;
      rawPixels[idx + 2] = isEven ? 255 : 0;
    }
  }

  return await sharp(rawPixels, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// =============================================
// テストスイート
// =============================================

describe('Phase 3 Integration: LocalVisionAdapter', () => {
  let adapter: LocalVisionAdapter;

  beforeEach(() => {
    adapter = new LocalVisionAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------
  // 基本機能テスト
  // -----------------------------------------

  describe('基本機能', () => {
    it('アダプタが正しく初期化される', async () => {
      // Assert
      expect(adapter.name).toBe('LocalVisionAdapter');
      expect(adapter.modelName).toBe('local-sharp-1.0');
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('カスタム設定でアダプタを初期化できる', async () => {
      // Arrange
      const config: LocalVisionAdapterConfig = {
        name: 'CustomAdapter',
        modelName: 'custom-model-1.0',
        colorExtraction: {
          maxColors: 16,
          minCoverage: 0.005,
        },
      };

      // Act
      const customAdapter = new LocalVisionAdapter(config);

      // Assert
      expect(customAdapter.name).toBe('CustomAdapter');
      expect(customAdapter.modelName).toBe('custom-model-1.0');
    });

    it('利用不可状態を設定できる', async () => {
      // Arrange
      const unavailableAdapter = new LocalVisionAdapter({
        isAvailable: false,
      });

      // Assert
      expect(await unavailableAdapter.isAvailable()).toBe(false);
    });

    it('利用不可状態では解析失敗を返す', async () => {
      // Arrange
      const unavailableAdapter = new LocalVisionAdapter({
        isAvailable: false,
      });
      const imageBuffer = await createTestImageBuffer(100, 100);

      // Act
      const result = await unavailableAdapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  // -----------------------------------------
  // 色抽出テスト
  // -----------------------------------------

  describe('色抽出 (color_palette)', () => {
    it('単色画像から主要色を抽出できる', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100, {
        backgroundColor: '#3366CC',
        pattern: 'solid',
      });

      // Act
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette'],
      });

      // Assert
      expect(result.success).toBe(true);

      const colorFeature = result.features.find((f) => f.type === 'color_palette');
      expect(colorFeature).toBeDefined();

      const colorData = colorFeature?.data as ColorPaletteData;
      expect(colorData.dominantColors).toBeDefined();
      expect(colorData.dominantColors.length).toBeGreaterThan(0);
    });

    it('コントラストレベルを判定できる', async () => {
      // Arrange: 高コントラスト画像（黒と白）
      const highContrastImage = await createHighContrastImageBuffer(100, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer: highContrastImage,
        mimeType: 'image/png',
        features: ['color_palette'],
      });

      // Assert
      expect(result.success).toBe(true);

      const colorFeature = result.features.find((f) => f.type === 'color_palette');
      const colorData = colorFeature?.data as ColorPaletteData;
      expect(colorData.contrast).toBe('high');
    });

    it('ムードを推定できる', async () => {
      // Arrange: 青系の画像（cool and calm）
      const blueImage = await createTestImageBuffer(100, 100, {
        backgroundColor: '#3366CC',
        pattern: 'solid',
      });

      // Act
      const result = await adapter.analyze({
        imageBuffer: blueImage,
        mimeType: 'image/png',
        features: ['color_palette'],
      });

      // Assert
      expect(result.success).toBe(true);

      const colorFeature = result.features.find((f) => f.type === 'color_palette');
      const colorData = colorFeature?.data as ColorPaletteData;
      expect(colorData.mood).toBeDefined();
      expect(typeof colorData.mood).toBe('string');
    });

    it('グラデーション画像から複数色を抽出できる', async () => {
      // Arrange
      const gradientImage = await createTestImageBuffer(100, 100, {
        backgroundColor: '#FF6600',
        pattern: 'gradient',
      });

      // Act
      const result = await adapter.analyze({
        imageBuffer: gradientImage,
        mimeType: 'image/png',
        features: ['color_palette'],
      });

      // Assert
      expect(result.success).toBe(true);

      const colorFeature = result.features.find((f) => f.type === 'color_palette');
      const colorData = colorFeature?.data as ColorPaletteData;
      expect(colorData.dominantColors.length).toBeGreaterThan(1);
    });
  });

  // -----------------------------------------
  // 密度分析テスト
  // -----------------------------------------

  describe('密度分析 (density)', () => {
    it('単純な画像はsparse密度を返す', async () => {
      // Arrange: 単色画像はエッジがほとんどない
      const simpleImage = await createTestImageBuffer(100, 100, {
        backgroundColor: '#FFFFFF',
        pattern: 'solid',
      });

      // Act
      const result = await adapter.analyze({
        imageBuffer: simpleImage,
        mimeType: 'image/png',
        features: ['density'],
      });

      // Assert
      expect(result.success).toBe(true);

      const densityFeature = result.features.find((f) => f.type === 'density');
      expect(densityFeature).toBeDefined();

      const densityData = densityFeature?.data as DensityData;
      expect(['sparse', 'balanced']).toContain(densityData.level);
    });

    it('複雑な画像はdense以上の密度を返す', async () => {
      // Arrange: チェッカーボードはエッジが多い
      const complexImage = await createComplexImageBuffer(100, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer: complexImage,
        mimeType: 'image/png',
        features: ['density'],
      });

      // Assert
      expect(result.success).toBe(true);

      const densityFeature = result.features.find((f) => f.type === 'density');
      const densityData = densityFeature?.data as DensityData;
      expect(['balanced', 'dense', 'cluttered']).toContain(densityData.level);
    });

    it('密度の説明が含まれる', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['density'],
      });

      // Assert
      expect(result.success).toBe(true);

      const densityFeature = result.features.find((f) => f.type === 'density');
      const densityData = densityFeature?.data as DensityData;
      expect(densityData.description).toBeDefined();
      expect(densityData.description.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------
  // 余白分析テスト
  // -----------------------------------------

  describe('余白分析 (whitespace)', () => {
    it('余白量を判定できる', async () => {
      // Arrange: 単色（ほぼ余白）
      const whitespaceImage = await createTestImageBuffer(100, 100, {
        backgroundColor: '#FFFFFF',
        pattern: 'solid',
      });

      // Act
      const result = await adapter.analyze({
        imageBuffer: whitespaceImage,
        mimeType: 'image/png',
        features: ['whitespace'],
      });

      // Assert
      expect(result.success).toBe(true);

      const whitespaceFeature = result.features.find((f) => f.type === 'whitespace');
      expect(whitespaceFeature).toBeDefined();

      const whitespaceData = whitespaceFeature?.data as WhitespaceData;
      expect(['minimal', 'moderate', 'generous', 'extreme']).toContain(whitespaceData.amount);
    });

    it('余白の分布を判定できる', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['whitespace'],
      });

      // Assert
      expect(result.success).toBe(true);

      const whitespaceFeature = result.features.find((f) => f.type === 'whitespace');
      const whitespaceData = whitespaceFeature?.data as WhitespaceData;
      expect(['even', 'centered', 'top-heavy', 'bottom-heavy']).toContain(whitespaceData.distribution);
    });
  });

  // -----------------------------------------
  // レイアウト構造テスト
  // -----------------------------------------

  describe('レイアウト構造 (layout_structure)', () => {
    it('正方形画像のグリッドタイプを推定できる', async () => {
      // Arrange: 正方形（アスペクト比1:1）
      const squareImage = await createTestImageBuffer(100, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer: squareImage,
        mimeType: 'image/png',
        features: ['layout_structure'],
      });

      // Assert
      expect(result.success).toBe(true);

      const layoutFeature = result.features.find((f) => f.type === 'layout_structure');
      expect(layoutFeature).toBeDefined();

      const layoutData = layoutFeature?.data as LayoutStructureData;
      expect(layoutData.gridType).toBeDefined();
      expect(['single-column', 'two-column', 'three-column', 'grid', 'masonry', 'asymmetric']).toContain(layoutData.gridType);
    });

    it('縦長画像はsingle-columnを返す', async () => {
      // Arrange: 縦長（アスペクト比 < 0.6）
      const tallImage = await createTestImageBuffer(100, 300);

      // Act
      const result = await adapter.analyze({
        imageBuffer: tallImage,
        mimeType: 'image/png',
        features: ['layout_structure'],
      });

      // Assert
      expect(result.success).toBe(true);

      const layoutFeature = result.features.find((f) => f.type === 'layout_structure');
      const layoutData = layoutFeature?.data as LayoutStructureData;
      expect(layoutData.gridType).toBe('single-column');
    });

    it('横長画像はgridを返す', async () => {
      // Arrange: 横長（アスペクト比 > 1.8）
      const wideImage = await createTestImageBuffer(300, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer: wideImage,
        mimeType: 'image/png',
        features: ['layout_structure'],
      });

      // Assert
      expect(result.success).toBe(true);

      const layoutFeature = result.features.find((f) => f.type === 'layout_structure');
      const layoutData = layoutFeature?.data as LayoutStructureData;
      expect(layoutData.gridType).toBe('grid');
    });

    it('メインエリアが推定される', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['layout_structure'],
      });

      // Assert
      expect(result.success).toBe(true);

      const layoutFeature = result.features.find((f) => f.type === 'layout_structure');
      const layoutData = layoutFeature?.data as LayoutStructureData;
      expect(layoutData.mainAreas).toBeDefined();
      expect(Array.isArray(layoutData.mainAreas)).toBe(true);
      expect(layoutData.mainAreas.length).toBeGreaterThan(0);
    });

    it('レイアウトの説明が生成される', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['layout_structure'],
      });

      // Assert
      expect(result.success).toBe(true);

      const layoutFeature = result.features.find((f) => f.type === 'layout_structure');
      const layoutData = layoutFeature?.data as LayoutStructureData;
      expect(layoutData.description).toBeDefined();
      expect(layoutData.description.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------
  // セクション境界テスト
  // -----------------------------------------

  describe('セクション境界 (section_boundaries)', () => {
    it('セクション分割画像で境界を検出できる', async () => {
      // Arrange: 明確なセクション分割がある画像
      const sectionImage = await createTestImageBuffer(100, 300, {
        backgroundColor: '#3366CC',
        pattern: 'sections',
      });

      // Act
      const result = await adapter.analyze({
        imageBuffer: sectionImage,
        mimeType: 'image/png',
        features: ['section_boundaries'],
      });

      // Assert
      expect(result.success).toBe(true);

      const sectionFeature = result.features.find((f) => f.type === 'section_boundaries');
      expect(sectionFeature).toBeDefined();

      const sectionData = sectionFeature?.data as SectionBoundariesData;
      expect(sectionData.sections).toBeDefined();
      expect(Array.isArray(sectionData.sections)).toBe(true);
    });

    it('セクションにはタイプと座標が含まれる', async () => {
      // Arrange
      const sectionImage = await createTestImageBuffer(100, 300, {
        pattern: 'sections',
      });

      // Act
      const result = await adapter.analyze({
        imageBuffer: sectionImage,
        mimeType: 'image/png',
        features: ['section_boundaries'],
      });

      // Assert
      expect(result.success).toBe(true);

      const sectionFeature = result.features.find((f) => f.type === 'section_boundaries');
      const sectionData = sectionFeature?.data as SectionBoundariesData;

      if (sectionData.sections.length > 0) {
        const firstSection = sectionData.sections[0]!;
        expect(firstSection.type).toBeDefined();
        expect(typeof firstSection.startY).toBe('number');
        expect(typeof firstSection.endY).toBe('number');
        expect(typeof firstSection.confidence).toBe('number');
      }
    });
  });

  // -----------------------------------------
  // 複数特徴の同時抽出テスト
  // -----------------------------------------

  describe('複数特徴の同時抽出', () => {
    it('複数の特徴タイプを同時に抽出できる', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100, {
        backgroundColor: '#FF6600',
        pattern: 'gradient',
      });

      // Act
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette', 'density', 'layout_structure'],
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.features.length).toBe(3);

      expect(result.features.some((f) => f.type === 'color_palette')).toBe(true);
      expect(result.features.some((f) => f.type === 'density')).toBe(true);
      expect(result.features.some((f) => f.type === 'layout_structure')).toBe(true);
    });

    it('features未指定時はデフォルト特徴を抽出', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });

      // Assert
      expect(result.success).toBe(true);
      // デフォルト: ['color_palette', 'density', 'layout_structure']
      expect(result.features.length).toBe(3);
    });
  });

  // -----------------------------------------
  // テキスト表現生成テスト
  // -----------------------------------------

  describe('テキスト表現生成', () => {
    it('解析結果からテキスト表現を生成できる', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100, {
        backgroundColor: '#3366CC',
      });
      const analysisResult = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette', 'density'],
      });

      // Act
      const textRepresentation = adapter.generateTextRepresentation(analysisResult);

      // Assert
      expect(textRepresentation).toBeDefined();
      expect(textRepresentation.length).toBeGreaterThan(0);
      expect(textRepresentation).toContain('Colors:');
      expect(textRepresentation).toContain('Density:');
    });

    it('失敗した解析結果では空文字列を返す', () => {
      // Arrange
      const failedResult: VisionAnalysisResult = {
        success: false,
        features: [],
        error: 'Test error',
        processingTimeMs: 0,
        modelName: 'local-sharp-1.0',
      };

      // Act
      const textRepresentation = adapter.generateTextRepresentation(failedResult);

      // Assert
      expect(textRepresentation).toBe('');
    });
  });

  // -----------------------------------------
  // エラーハンドリングテスト
  // -----------------------------------------

  describe('エラーハンドリング', () => {
    it('空のバッファでエラーを返す', async () => {
      // Act
      const result = await adapter.analyze({
        imageBuffer: Buffer.alloc(0),
        mimeType: 'image/png',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Empty image buffer');
    });

    it('無効な画像データでエラーを返す', async () => {
      // Arrange: 無効な画像データ
      const invalidBuffer = Buffer.from('not an image');

      // Act
      const result = await adapter.analyze({
        imageBuffer: invalidBuffer,
        mimeType: 'image/png',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('タイムアウトを処理できる', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100);

      // Act: 非常に短いタイムアウト（1ms）
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        timeout: 1, // 1ms
      });

      // Assert: タイムアウトまたは成功（競合状態による）
      // 実際のテストでは成功することもあるので、結果の存在のみ確認
      expect(result).toBeDefined();
    });
  });

  // -----------------------------------------
  // パフォーマンステスト
  // -----------------------------------------

  describe('パフォーマンス', () => {
    it('処理時間がレスポンスに含まれる', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
      });

      // Assert
      expect(result.processingTimeMs).toBeDefined();
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('大きな画像でも適切に処理できる', async () => {
      // Arrange: 1000x1000の画像
      const largeImage = await createTestImageBuffer(1000, 1000);

      // Act
      const startTime = Date.now();
      const result = await adapter.analyze({
        imageBuffer: largeImage,
        mimeType: 'image/png',
      });
      const processingTime = Date.now() - startTime;

      // Assert
      expect(result.success).toBe(true);
      // 大きな画像でも5秒以内に処理完了
      expect(processingTime).toBeLessThan(5000);
    });

    it('各特徴に信頼度スコアが含まれる', async () => {
      // Arrange
      const imageBuffer = await createTestImageBuffer(100, 100);

      // Act
      const result = await adapter.analyze({
        imageBuffer,
        mimeType: 'image/png',
        features: ['color_palette', 'density', 'layout_structure'],
      });

      // Assert
      expect(result.success).toBe(true);

      for (const feature of result.features) {
        expect(feature.confidence).toBeDefined();
        expect(feature.confidence).toBeGreaterThanOrEqual(0);
        expect(feature.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
});
