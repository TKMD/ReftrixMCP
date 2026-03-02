// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Viewport Diff Service Tests
 *
 * ViewportDiffService のユニットテスト
 * Sharp で生成したテスト画像を使用してピクセル差分検出を検証する
 *
 * @module tests/services/responsive/viewport-diff.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import sharp from 'sharp';
import { ViewportDiffService } from '../../../src/services/responsive/viewport-diff.service';

/**
 * 単色PNG画像を生成するヘルパー
 */
async function createSolidImage(
  width: number,
  height: number,
  color: { r: number; g: number; b: number; alpha: number }
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

describe('ViewportDiffService', () => {
  let service: ViewportDiffService;

  beforeEach(() => {
    service = new ViewportDiffService();
  });

  // ==========================================================================
  // comparePair
  // ==========================================================================

  describe('comparePair', () => {
    it('同一画像の差分は diffPercentage ≈ 0', async () => {
      const image = await createSolidImage(100, 100, {
        r: 255,
        g: 0,
        b: 0,
        alpha: 1,
      });

      const result = await service.comparePair(
        image,
        image,
        'desktop',
        'mobile'
      );

      expect(result.viewport1).toBe('desktop');
      expect(result.viewport2).toBe('mobile');
      expect(result.diffPercentage).toBeCloseTo(0, 1);
      expect(result.diffPixelCount).toBe(0);
      expect(result.totalPixels).toBe(100 * 100);
      expect(result.comparedWidth).toBe(100);
      expect(result.comparedHeight).toBe(100);
    });

    it('異なる色の画像で diffPercentage > 0', async () => {
      const red = await createSolidImage(100, 100, {
        r: 255,
        g: 0,
        b: 0,
        alpha: 1,
      });
      const blue = await createSolidImage(100, 100, {
        r: 0,
        g: 0,
        b: 255,
        alpha: 1,
      });

      const result = await service.comparePair(red, blue, 'desktop', 'mobile');

      expect(result.diffPercentage).toBeGreaterThan(0);
      expect(result.diffPixelCount).toBeGreaterThan(0);
      expect(result.totalPixels).toBe(10000);
    });

    it('完全に異なる色の画像で diffPercentage = 100', async () => {
      const white = await createSolidImage(50, 50, {
        r: 255,
        g: 255,
        b: 255,
        alpha: 1,
      });
      const black = await createSolidImage(50, 50, {
        r: 0,
        g: 0,
        b: 0,
        alpha: 1,
      });

      const result = await service.comparePair(
        white,
        black,
        'desktop',
        'mobile'
      );

      expect(result.diffPercentage).toBe(100);
      expect(result.diffPixelCount).toBe(50 * 50);
    });

    it('異なる解像度の画像がリサイズされて比較される', async () => {
      const large = await createSolidImage(200, 200, {
        r: 128,
        g: 128,
        b: 128,
        alpha: 1,
      });
      const small = await createSolidImage(100, 100, {
        r: 128,
        g: 128,
        b: 128,
        alpha: 1,
      });

      const result = await service.comparePair(
        large,
        small,
        'desktop',
        'mobile'
      );

      // 小さい方に合わせてリサイズ（100x100）
      expect(result.comparedWidth).toBe(100);
      expect(result.comparedHeight).toBe(100);
      expect(result.totalPixels).toBe(10000);
      // 同じ色なので差分はほぼ0
      expect(result.diffPercentage).toBeCloseTo(0, 1);
    });

    it('幅だけ異なる画像も正しくリサイズされる', async () => {
      const wide = await createSolidImage(300, 100, {
        r: 50,
        g: 50,
        b: 50,
        alpha: 1,
      });
      const narrow = await createSolidImage(100, 100, {
        r: 50,
        g: 50,
        b: 50,
        alpha: 1,
      });

      const result = await service.comparePair(
        wide,
        narrow,
        'desktop',
        'tablet'
      );

      expect(result.comparedWidth).toBe(100);
      expect(result.comparedHeight).toBe(100);
    });

    it('includeDiffImage: true で差分画像バッファが返される', async () => {
      const red = await createSolidImage(50, 50, {
        r: 255,
        g: 0,
        b: 0,
        alpha: 1,
      });
      const green = await createSolidImage(50, 50, {
        r: 0,
        g: 255,
        b: 0,
        alpha: 1,
      });

      const result = await service.comparePair(red, green, 'v1', 'v2', {
        includeDiffImage: true,
      });

      expect(result.diffImageBuffer).toBeDefined();
      expect(result.diffImageBuffer).toBeInstanceOf(Buffer);
      // 差分画像がPNGとして有効か確認
      const metadata = await sharp(result.diffImageBuffer!).metadata();
      expect(metadata.format).toBe('png');
      expect(metadata.width).toBe(50);
      expect(metadata.height).toBe(50);
    });

    it('includeDiffImage: false（デフォルト）で差分画像バッファが返されない', async () => {
      const image = await createSolidImage(50, 50, {
        r: 100,
        g: 100,
        b: 100,
        alpha: 1,
      });

      const result = await service.comparePair(image, image, 'v1', 'v2');

      expect(result.diffImageBuffer).toBeUndefined();
    });

    it('threshold オプションが差分検出感度に影響する', async () => {
      // わずかに異なる色で threshold の効果を確認
      const color1 = await createSolidImage(50, 50, {
        r: 100,
        g: 100,
        b: 100,
        alpha: 1,
      });
      const color2 = await createSolidImage(50, 50, {
        r: 110,
        g: 100,
        b: 100,
        alpha: 1,
      });

      const strictResult = await service.comparePair(
        color1,
        color2,
        'v1',
        'v2',
        { threshold: 0.01 }
      );
      const lenientResult = await service.comparePair(
        color1,
        color2,
        'v1',
        'v2',
        { threshold: 0.5 }
      );

      // 厳しい閾値では差分が多く、緩い閾値では差分が少ない
      expect(strictResult.diffPixelCount).toBeGreaterThanOrEqual(
        lenientResult.diffPixelCount
      );
    });

    it('不正な画像データでエラーをスローする', async () => {
      const invalidBuffer = Buffer.from('not a valid image');
      const validImage = await createSolidImage(50, 50, {
        r: 0,
        g: 0,
        b: 0,
        alpha: 1,
      });

      await expect(
        service.comparePair(invalidBuffer, validImage, 'v1', 'v2')
      ).rejects.toThrow();
    });

    it('空バッファでエラーをスローする', async () => {
      const emptyBuffer = Buffer.alloc(0);
      const validImage = await createSolidImage(50, 50, {
        r: 0,
        g: 0,
        b: 0,
        alpha: 1,
      });

      await expect(
        service.comparePair(emptyBuffer, validImage, 'v1', 'v2')
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // compareAll
  // ==========================================================================

  describe('compareAll', () => {
    it('2つのスクリーンショットで1ペアの結果を返す', async () => {
      const red = await createSolidImage(50, 50, {
        r: 255,
        g: 0,
        b: 0,
        alpha: 1,
      });
      const blue = await createSolidImage(50, 50, {
        r: 0,
        g: 0,
        b: 255,
        alpha: 1,
      });

      const screenshots = new Map<string, Buffer>();
      screenshots.set('desktop', red);
      screenshots.set('mobile', blue);

      const results = await service.compareAll(screenshots);

      expect(results).toHaveLength(1);
      expect(results[0]!.viewport1).toBe('desktop');
      expect(results[0]!.viewport2).toBe('mobile');
      expect(results[0]!.diffPercentage).toBeGreaterThan(0);
    });

    it('3つのスクリーンショットで3ペアの結果を返す', async () => {
      const red = await createSolidImage(50, 50, {
        r: 255,
        g: 0,
        b: 0,
        alpha: 1,
      });
      const green = await createSolidImage(50, 50, {
        r: 0,
        g: 255,
        b: 0,
        alpha: 1,
      });
      const blue = await createSolidImage(50, 50, {
        r: 0,
        g: 0,
        b: 255,
        alpha: 1,
      });

      const screenshots = new Map<string, Buffer>();
      screenshots.set('desktop', red);
      screenshots.set('tablet', green);
      screenshots.set('mobile', blue);

      const results = await service.compareAll(screenshots);

      // C(3,2) = 3 ペア
      expect(results).toHaveLength(3);
    });

    it('1つ以下のスクリーンショットでは空配列を返す', async () => {
      const image = await createSolidImage(50, 50, {
        r: 0,
        g: 0,
        b: 0,
        alpha: 1,
      });

      // 0件
      const emptyResults = await service.compareAll(new Map());
      expect(emptyResults).toHaveLength(0);

      // 1件
      const singleMap = new Map<string, Buffer>();
      singleMap.set('desktop', image);
      const singleResults = await service.compareAll(singleMap);
      expect(singleResults).toHaveLength(0);
    });

    it('オプションが各ペアに伝播する', async () => {
      const white = await createSolidImage(50, 50, {
        r: 255,
        g: 255,
        b: 255,
        alpha: 1,
      });
      const black = await createSolidImage(50, 50, {
        r: 0,
        g: 0,
        b: 0,
        alpha: 1,
      });

      const screenshots = new Map<string, Buffer>();
      screenshots.set('desktop', white);
      screenshots.set('mobile', black);

      const results = await service.compareAll(screenshots, {
        includeDiffImage: true,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.diffImageBuffer).toBeDefined();
      expect(results[0]!.diffImageBuffer).toBeInstanceOf(Buffer);
    });
  });
});
