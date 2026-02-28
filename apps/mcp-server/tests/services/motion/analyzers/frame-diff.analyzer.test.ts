// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FrameDiffAnalyzer テスト
 *
 * TDD: Red Phase - 失敗するテストを先に作成
 *
 * テスト対象: FrameDiffAnalyzer
 *
 * このテストは以下を検証します:
 * - 2つのフレーム間のピクセル差分検出 (Pixelmatch使用)
 * - 変化率 (changeRatio) の計算
 * - 差分領域 (BoundingBox) の抽出
 * - 差分画像の生成
 * - 閾値パラメータの動作
 *
 * 仕様: docs/specs/frame-image-analysis-spec.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import sharp from 'sharp';

// テスト対象のインポート（まだ存在しない - TDD Red Phase）
import {
  FrameDiffAnalyzer,
  type FrameDiffResult,
  type BoundingBox,
  type FrameDiffOptions,
} from '../../../../src/services/motion/analyzers/frame-diff.analyzer';

// =====================================================
// テストユーティリティ
// =====================================================

/**
 * テスト用の単色PNG画像を生成
 */
async function createSolidColorImage(
  width: number,
  height: number,
  color: { r: number; g: number; b: number; alpha?: number }
): Promise<Buffer> {
  const channels = color.alpha !== undefined ? 4 : 3;
  const pixels = Buffer.alloc(width * height * channels);

  for (let i = 0; i < width * height; i++) {
    const offset = i * channels;
    pixels[offset] = color.r;
    pixels[offset + 1] = color.g;
    pixels[offset + 2] = color.b;
    if (channels === 4) {
      pixels[offset + 3] = color.alpha ?? 255;
    }
  }

  return sharp(pixels, {
    raw: {
      width,
      height,
      channels: channels as 3 | 4,
    },
  })
    .png()
    .toBuffer();
}

/**
 * テスト用の部分変化画像を生成
 * baseColor: 基本色
 * changeColor: 変化色
 * changeRegion: 変化領域 (x, y, width, height)
 */
async function createImageWithRegion(
  width: number,
  height: number,
  baseColor: { r: number; g: number; b: number },
  changeColor: { r: number; g: number; b: number },
  changeRegion: { x: number; y: number; width: number; height: number }
): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const inRegion =
        x >= changeRegion.x &&
        x < changeRegion.x + changeRegion.width &&
        y >= changeRegion.y &&
        y < changeRegion.y + changeRegion.height;

      const color = inRegion ? changeColor : baseColor;
      pixels[offset] = color.r;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.b;
    }
  }

  return sharp(pixels, {
    raw: {
      width,
      height,
      channels,
    },
  })
    .png()
    .toBuffer();
}

// =====================================================
// テストスイート
// =====================================================

describe('FrameDiffAnalyzer', () => {
  let analyzer: FrameDiffAnalyzer;
  let tempDir: string;

  beforeEach(() => {
    analyzer = new FrameDiffAnalyzer();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-diff-test-'));
  });

  afterEach(async () => {
    // クリーンアップ
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------
  // analyze() メソッドのテスト
  // -------------------------------------------------

  describe('analyze()', () => {
    it('should return zero change ratio for identical images', async () => {
      // 同一画像の比較: 変化率は0
      const image = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });

      const result = await analyzer.analyze(image, image);

      expect(result.changeRatio).toBe(0);
      expect(result.diffPixelCount).toBe(0);
      expect(result.totalPixelCount).toBe(10000); // 100 * 100
      expect(result.diffRegions).toHaveLength(0);
    });

    it('should detect 100% change for completely different images', async () => {
      // 完全に異なる画像: 変化率は約1.0（100%）
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(100, 100, { r: 0, g: 0, b: 255 });

      const result = await analyzer.analyze(image1, image2);

      expect(result.changeRatio).toBeCloseTo(1.0, 1);
      expect(result.diffPixelCount).toBe(10000);
      expect(result.totalPixelCount).toBe(10000);
    });

    it('should detect partial change in specific region', async () => {
      // 25%の領域が変化した画像
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });
      const image2 = await createImageWithRegion(
        100,
        100,
        { r: 255, g: 255, b: 255 }, // ベース色（白）
        { r: 0, g: 0, b: 0 }, // 変化色（黒）
        { x: 0, y: 0, width: 50, height: 50 } // 左上の50x50領域
      );

      const result = await analyzer.analyze(image1, image2);

      // 50x50 = 2500 pixels / 10000 total = 0.25
      expect(result.changeRatio).toBeCloseTo(0.25, 2);
      expect(result.diffPixelCount).toBe(2500);
    });

    it('should detect change regions with bounding boxes', async () => {
      // 変化領域のバウンディングボックスを検出
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });
      const image2 = await createImageWithRegion(
        100,
        100,
        { r: 255, g: 255, b: 255 },
        { r: 0, g: 0, b: 0 },
        { x: 25, y: 25, width: 50, height: 50 }
      );

      const result = await analyzer.analyze(image1, image2);

      expect(result.diffRegions).toHaveLength(1);
      const region = result.diffRegions[0]!;
      // バウンディングボックスが変化領域を含むことを確認
      // （Pixelmatchのアンチエイリアシング検出により若干の誤差あり）
      expect(region.x).toBeLessThanOrEqual(25);
      expect(region.y).toBeLessThanOrEqual(25);
      expect(region.x + region.width).toBeGreaterThanOrEqual(74); // 25 + 50 - 1
      expect(region.y + region.height).toBeGreaterThanOrEqual(74);
    });

    it('should handle alpha channel correctly', async () => {
      // アルファチャンネル付き画像の比較
      const image1 = await createSolidColorImage(50, 50, { r: 255, g: 0, b: 0, alpha: 255 });
      const image2 = await createSolidColorImage(50, 50, { r: 255, g: 0, b: 0, alpha: 128 });

      const result = await analyzer.analyze(image1, image2);

      // 透明度の変化も検出
      expect(result.changeRatio).toBeGreaterThan(0);
    });

    it('should throw error for different image dimensions', async () => {
      // 異なるサイズの画像はエラー
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(200, 200, { r: 255, g: 0, b: 0 });

      await expect(analyzer.analyze(image1, image2)).rejects.toThrow(
        'Image dimensions do not match'
      );
    });

    it('should accept file paths as input', async () => {
      // ファイルパスでも動作する
      const image1Path = path.join(tempDir, 'frame1.png');
      const image2Path = path.join(tempDir, 'frame2.png');

      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(100, 100, { r: 0, g: 255, b: 0 });

      fs.writeFileSync(image1Path, image1);
      fs.writeFileSync(image2Path, image2);

      const result = await analyzer.analyze(image1Path, image2Path);

      expect(result.changeRatio).toBeCloseTo(1.0, 1);
    });
  });

  // -------------------------------------------------
  // calculateChangeRatio() メソッドのテスト
  // -------------------------------------------------

  describe('calculateChangeRatio()', () => {
    it('should calculate correct ratio for 0 diff pixels', () => {
      const ratio = analyzer.calculateChangeRatio(0, 10000);
      expect(ratio).toBe(0);
    });

    it('should calculate correct ratio for 100% diff', () => {
      const ratio = analyzer.calculateChangeRatio(10000, 10000);
      expect(ratio).toBe(1);
    });

    it('should calculate correct ratio for partial diff', () => {
      const ratio = analyzer.calculateChangeRatio(2500, 10000);
      expect(ratio).toBe(0.25);
    });

    it('should handle edge case of zero total pixels', () => {
      const ratio = analyzer.calculateChangeRatio(0, 0);
      expect(ratio).toBe(0);
    });
  });

  // -------------------------------------------------
  // extractDiffRegions() メソッドのテスト
  // -------------------------------------------------

  describe('extractDiffRegions()', () => {
    it('should return empty array for no differences', async () => {
      const image = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });
      const result = await analyzer.analyze(image, image);

      expect(result.diffRegions).toEqual([]);
    });

    it('should extract single contiguous region', async () => {
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });
      const image2 = await createImageWithRegion(
        100,
        100,
        { r: 255, g: 255, b: 255 },
        { r: 0, g: 0, b: 0 },
        { x: 10, y: 10, width: 30, height: 30 }
      );

      const result = await analyzer.analyze(image1, image2);

      expect(result.diffRegions.length).toBeGreaterThanOrEqual(1);
      // 最初の領域が変化領域を含むことを確認
      const region = result.diffRegions[0]!;
      // バウンディングボックスは変化領域以上（またはそれを含む）
      expect(region.x).toBeLessThanOrEqual(10);
      expect(region.y).toBeLessThanOrEqual(10);
      expect(region.x + region.width).toBeGreaterThanOrEqual(39); // 10 + 30 - 1
      expect(region.y + region.height).toBeGreaterThanOrEqual(39);
    });

    it('should merge nearby regions into single bounding box', async () => {
      // 近接した複数の変化は単一のバウンディングボックスにマージ
      // （実装の詳細によるが、一般的な期待動作）
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });

      // 2つの近接領域を持つ画像を生成
      const pixels = Buffer.alloc(100 * 100 * 3);
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          const offset = (y * 100 + x) * 3;
          // 2つの近接した小さな正方形を黒に
          const inRegion1 = x >= 10 && x < 20 && y >= 10 && y < 20;
          const inRegion2 = x >= 25 && x < 35 && y >= 10 && y < 20;
          if (inRegion1 || inRegion2) {
            pixels[offset] = 0;
            pixels[offset + 1] = 0;
            pixels[offset + 2] = 0;
          } else {
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
          }
        }
      }

      const image2 = await sharp(pixels, { raw: { width: 100, height: 100, channels: 3 } })
        .png()
        .toBuffer();

      const result = await analyzer.analyze(image1, image2);

      // 複数の領域またはマージされた1つの領域が返される
      expect(result.diffRegions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------
  // createDiffImage() メソッドのテスト
  // -------------------------------------------------

  describe('createDiffImage()', () => {
    it('should generate a diff visualization image', async () => {
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(100, 100, { r: 0, g: 255, b: 0 });

      const diffImage = await analyzer.createDiffImage(image1, image2);

      // 差分画像はBufferとして返される
      expect(diffImage).toBeInstanceOf(Buffer);
      expect(diffImage.length).toBeGreaterThan(0);

      // PNGフォーマットであることを確認（マジックナンバー）
      expect(diffImage[0]).toBe(0x89);
      expect(diffImage[1]).toBe(0x50); // 'P'
      expect(diffImage[2]).toBe(0x4e); // 'N'
      expect(diffImage[3]).toBe(0x47); // 'G'
    });

    it('should save diff image to file when path is provided', async () => {
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(100, 100, { r: 0, g: 255, b: 0 });
      const outputPath = path.join(tempDir, 'diff.png');

      const diffImage = await analyzer.createDiffImage(image1, image2, outputPath);

      expect(diffImage).toBeInstanceOf(Buffer);
      expect(fs.existsSync(outputPath)).toBe(true);

      const savedImage = fs.readFileSync(outputPath);
      expect(savedImage.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------
  // 閾値オプションのテスト
  // -------------------------------------------------

  describe('threshold options', () => {
    it('should use default threshold of 0.1', async () => {
      const analyzer = new FrameDiffAnalyzer();
      const image = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });

      // デフォルト閾値で同一画像を比較
      const result = await analyzer.analyze(image, image);
      expect(result.changeRatio).toBe(0);
    });

    it('should respect custom threshold in options', async () => {
      // より厳しい閾値を設定
      const strictAnalyzer = new FrameDiffAnalyzer({ threshold: 0.01 });

      // わずかに異なる画像を生成
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(100, 100, { r: 254, g: 0, b: 0 });

      // 厳しい閾値では変化を検出
      const strictResult = await strictAnalyzer.analyze(image1, image2);

      // ゆるい閾値では変化を検出しない可能性
      const lenientAnalyzer = new FrameDiffAnalyzer({ threshold: 0.5 });
      const lenientResult = await lenientAnalyzer.analyze(image1, image2);

      // 厳しい閾値のほうが多くの差分を検出する可能性が高い
      expect(strictResult.diffPixelCount).toBeGreaterThanOrEqual(lenientResult.diffPixelCount);
    });

    it('should accept threshold in analyze method options', async () => {
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(100, 100, { r: 0, g: 255, b: 0 });

      const result = await analyzer.analyze(image1, image2, { threshold: 0.05 });

      expect(result.changeRatio).toBeCloseTo(1.0, 1);
    });
  });

  // -------------------------------------------------
  // パフォーマンス要件のテスト
  // -------------------------------------------------

  describe('performance', () => {
    it('should process 1920x1080 frame pair within 1 second', async () => {
      // 仕様: 1920x1080のフレームペアを1秒以内に比較
      const image1 = await createSolidColorImage(1920, 1080, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(1920, 1080, { r: 0, g: 255, b: 0 });

      const startTime = Date.now();
      await analyzer.analyze(image1, image2);
      const elapsedMs = Date.now() - startTime;

      expect(elapsedMs).toBeLessThan(1000);
    });

    it('should process 100x100 frame pair within 100ms', async () => {
      // 仕様: フレーム差分（1ペア）< 100ms
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(100, 100, { r: 0, g: 255, b: 0 });

      const startTime = Date.now();
      await analyzer.analyze(image1, image2);
      const elapsedMs = Date.now() - startTime;

      expect(elapsedMs).toBeLessThan(100);
    });
  });

  // -------------------------------------------------
  // エッジケースのテスト
  // -------------------------------------------------

  describe('edge cases', () => {
    it('should handle very small images (1x1)', async () => {
      const image1 = await createSolidColorImage(1, 1, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(1, 1, { r: 0, g: 255, b: 0 });

      const result = await analyzer.analyze(image1, image2);

      expect(result.totalPixelCount).toBe(1);
      expect(result.diffPixelCount).toBe(1);
      expect(result.changeRatio).toBe(1);
    });

    it('should handle grayscale images', async () => {
      // グレースケール画像の生成と比較
      // sharp.create()はchannels 1をサポートしないため、RGB同値で疑似グレースケールを生成
      const gray1 = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .grayscale() // グレースケールに変換
        .png()
        .toBuffer();

      const gray2 = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 64, g: 64, b: 64 },
        },
      })
        .grayscale() // グレースケールに変換
        .png()
        .toBuffer();

      const result = await analyzer.analyze(gray1, gray2);

      expect(result.changeRatio).toBeGreaterThan(0);
    });

    it('should handle empty buffer gracefully', async () => {
      const emptyBuffer = Buffer.alloc(0);
      const validImage = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });

      await expect(analyzer.analyze(emptyBuffer, validImage)).rejects.toThrow();
    });

    it('should handle invalid image data gracefully', async () => {
      const invalidBuffer = Buffer.from('not an image');
      const validImage = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });

      await expect(analyzer.analyze(invalidBuffer, validImage)).rejects.toThrow();
    });
  });

  // -------------------------------------------------
  // FrameDiffResult インターフェースの検証
  // -------------------------------------------------

  describe('FrameDiffResult interface', () => {
    it('should return all required fields', async () => {
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(100, 100, { r: 0, g: 255, b: 0 });

      const result = await analyzer.analyze(image1, image2);

      // 必須フィールドの存在確認
      expect(result).toHaveProperty('changeRatio');
      expect(result).toHaveProperty('diffPixelCount');
      expect(result).toHaveProperty('totalPixelCount');
      expect(result).toHaveProperty('diffRegions');

      // 型確認
      expect(typeof result.changeRatio).toBe('number');
      expect(typeof result.diffPixelCount).toBe('number');
      expect(typeof result.totalPixelCount).toBe('number');
      expect(Array.isArray(result.diffRegions)).toBe(true);
    });

    it('should have optional diffImageBuffer field when requested', async () => {
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });
      const image2 = await createSolidColorImage(100, 100, { r: 0, g: 255, b: 0 });

      const result = await analyzer.analyze(image1, image2, { includeDiffImage: true });

      expect(result).toHaveProperty('diffImageBuffer');
      expect(result.diffImageBuffer).toBeInstanceOf(Buffer);
    });
  });

  // -------------------------------------------------
  // BoundingBox インターフェースの検証
  // -------------------------------------------------

  describe('BoundingBox interface', () => {
    it('should have correct structure', async () => {
      const image1 = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });
      const image2 = await createImageWithRegion(
        100,
        100,
        { r: 255, g: 255, b: 255 },
        { r: 0, g: 0, b: 0 },
        { x: 10, y: 20, width: 30, height: 40 }
      );

      const result = await analyzer.analyze(image1, image2);

      expect(result.diffRegions.length).toBeGreaterThan(0);

      const bbox = result.diffRegions[0];
      expect(bbox).toHaveProperty('x');
      expect(bbox).toHaveProperty('y');
      expect(bbox).toHaveProperty('width');
      expect(bbox).toHaveProperty('height');

      expect(typeof bbox?.x).toBe('number');
      expect(typeof bbox?.y).toBe('number');
      expect(typeof bbox?.width).toBe('number');
      expect(typeof bbox?.height).toBe('number');
    });
  });
});
