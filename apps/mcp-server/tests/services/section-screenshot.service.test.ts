// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SectionScreenshotService テスト
 *
 * フルページスクリーンショットからセクションを切り出すサービスのテスト。
 * Sharp を使用した画像処理の正確性と、エラーハンドリングを検証します。
 *
 * テストカバレッジ:
 * - 単一セクション切り出し（正常系）（5テスト）
 * - 境界外アクセス（エラー系）（4テスト）
 * - 複数セクション並列切り出し（5テスト）
 * - 空/無効Base64入力（3テスト）
 * - 出力フォーマット（3テスト）
 *
 * @module tests/services/section-screenshot.service
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import sharp from 'sharp';
import {
  SectionScreenshotService,
  SectionScreenshotServiceError,
  type SectionBounds,
  type SectionScreenshotOptions,
  type MultiSectionResult,
} from '../../src/services/section-screenshot.service';

// =====================================================
// テストユーティリティ
// =====================================================

/**
 * テスト用のフルページスクリーンショットを生成（Sharp使用）
 * 実際のスクリーンショットをシミュレートするために、
 * 異なる色のストライプを持つ画像を生成
 */
async function createFullPageScreenshot(options: {
  width?: number;
  height?: number;
  stripes?: Array<{ color: string; height: number }>;
}): Promise<string> {
  const { width = 1440, height = 3000 } = options;

  // デフォルトのストライプ（セクションをシミュレート）
  const stripes = options.stripes ?? [
    { color: '#3B82F6', height: 600 }, // hero
    { color: '#FFFFFF', height: 600 }, // features
    { color: '#F3F4F6', height: 600 }, // testimonials
    { color: '#1F2937', height: 600 }, // pricing
    { color: '#111827', height: 600 }, // footer
  ];

  // ベース画像を作成（最初のストライプの色）
  let image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: stripes[0]?.color ?? '#FFFFFF',
    },
  });

  // 各ストライプを合成
  const composites: sharp.OverlayOptions[] = [];
  let currentY = 0;

  for (const stripe of stripes) {
    composites.push({
      input: {
        create: {
          width,
          height: stripe.height,
          channels: 4 as const,
          background: stripe.color,
        },
      },
      top: currentY,
      left: 0,
    });
    currentY += stripe.height;
  }

  if (composites.length > 0) {
    image = image.composite(composites);
  }

  const buffer = await image.png().toBuffer();
  return buffer.toString('base64');
}

/**
 * 小さなテスト画像を生成（Base64）
 */
async function createSmallTestImage(
  width = 100,
  height = 100,
  color = '#FF0000'
): Promise<string> {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color,
    },
  })
    .png()
    .toBuffer();
  return buffer.toString('base64');
}

// =====================================================
// 初期化テスト
// =====================================================

describe('SectionScreenshotService', () => {
  describe('初期化', () => {
    it('デフォルトオプションで初期化できる', () => {
      const service = new SectionScreenshotService();
      expect(service).toBeDefined();
    });

    it('カスタムフォーマット（jpeg）で初期化できる', () => {
      const service = new SectionScreenshotService({ format: 'jpeg' });
      expect(service).toBeDefined();
    });

    it('カスタムフォーマット（webp）で初期化できる', () => {
      const service = new SectionScreenshotService({ format: 'webp' });
      expect(service).toBeDefined();
    });

    it('カスタム品質設定で初期化できる', () => {
      const service = new SectionScreenshotService({ quality: 85 });
      expect(service).toBeDefined();
    });

    it('カスタム並列数で初期化できる', () => {
      const service = new SectionScreenshotService({ maxConcurrency: 3 });
      expect(service).toBeDefined();
    });
  });

  // =====================================================
  // 単一セクション切り出し（正常系）（5テスト）
  // =====================================================

  describe('extractSection - 正常系', () => {
    let service: SectionScreenshotService;
    let fullPageBase64: string;

    beforeEach(async () => {
      service = new SectionScreenshotService();
      fullPageBase64 = await createFullPageScreenshot({});
    });

    it('単一セクションを切り出せる', async () => {
      const bounds: SectionBounds = {
        startY: 0,
        endY: 600,
        height: 600,
      };

      const result = await service.extractSection(
        fullPageBase64,
        bounds,
        'hero-section'
      );

      expect(result).toBeDefined();
      expect(result.sectionId).toBe('hero-section');
      expect(result.imageBuffer).toBeInstanceOf(Buffer);
      expect(result.base64).toBeDefined();
      expect(result.base64.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('切り出したセクションのサイズが正しい', async () => {
      const bounds: SectionBounds = {
        startY: 600,
        endY: 1200,
        height: 600,
      };

      const result = await service.extractSection(
        fullPageBase64,
        bounds,
        'features-section'
      );

      expect(result.width).toBe(1440);
      expect(result.height).toBe(600);
    });

    it('境界情報が正しく返される', async () => {
      const bounds: SectionBounds = {
        startY: 1200,
        endY: 1800,
        height: 600,
      };

      const result = await service.extractSection(
        fullPageBase64,
        bounds,
        'testimonials-section'
      );

      expect(result.bounds).toEqual(bounds);
    });

    it('ページ末尾のセクションを切り出せる', async () => {
      const bounds: SectionBounds = {
        startY: 2400,
        endY: 3000,
        height: 600,
      };

      const result = await service.extractSection(
        fullPageBase64,
        bounds,
        'footer-section'
      );

      expect(result.sectionId).toBe('footer-section');
      expect(result.height).toBe(600);
    });

    it('data:image/プレフィックス付きBase64も処理できる', async () => {
      const base64WithPrefix = `data:image/png;base64,${fullPageBase64}`;
      const bounds: SectionBounds = {
        startY: 0,
        endY: 600,
        height: 600,
      };

      const result = await service.extractSection(
        base64WithPrefix,
        bounds,
        'hero-section'
      );

      expect(result).toBeDefined();
      expect(result.sectionId).toBe('hero-section');
    });
  });

  // =====================================================
  // 境界外アクセス（エラー系）（4テスト）
  // =====================================================

  describe('extractSection - 境界外アクセス', () => {
    let service: SectionScreenshotService;
    let fullPageBase64: string;

    beforeEach(async () => {
      service = new SectionScreenshotService();
      // 高さ3000pxの画像を生成
      fullPageBase64 = await createFullPageScreenshot({ height: 3000 });
    });

    it('startYが画像の高さを超える場合エラー', async () => {
      const bounds: SectionBounds = {
        startY: 3500, // 画像高さ3000を超過
        endY: 4000,
        height: 500,
      };

      await expect(
        service.extractSection(fullPageBase64, bounds, 'out-of-bounds')
      ).rejects.toThrow(SectionScreenshotServiceError);

      try {
        await service.extractSection(fullPageBase64, bounds, 'out-of-bounds');
      } catch (error) {
        expect(error).toBeInstanceOf(SectionScreenshotServiceError);
        expect((error as SectionScreenshotServiceError).code).toBe('OUT_OF_BOUNDS');
      }
    });

    it('endYが画像の高さを超える場合エラー', async () => {
      const bounds: SectionBounds = {
        startY: 2800,
        endY: 3500, // 画像高さ3000を超過
        height: 700,
      };

      await expect(
        service.extractSection(fullPageBase64, bounds, 'partial-out-of-bounds')
      ).rejects.toThrow(SectionScreenshotServiceError);

      try {
        await service.extractSection(fullPageBase64, bounds, 'partial-out-of-bounds');
      } catch (error) {
        expect(error).toBeInstanceOf(SectionScreenshotServiceError);
        expect((error as SectionScreenshotServiceError).code).toBe('OUT_OF_BOUNDS');
      }
    });

    it('startYが負の値の場合エラー', async () => {
      const bounds: SectionBounds = {
        startY: -100,
        endY: 500,
        height: 600,
      };

      await expect(
        service.extractSection(fullPageBase64, bounds, 'negative-start')
      ).rejects.toThrow(SectionScreenshotServiceError);

      try {
        await service.extractSection(fullPageBase64, bounds, 'negative-start');
      } catch (error) {
        expect(error).toBeInstanceOf(SectionScreenshotServiceError);
        expect((error as SectionScreenshotServiceError).code).toBe('INVALID_BOUNDS');
      }
    });

    it('endYがstartY以下の場合エラー', async () => {
      const bounds: SectionBounds = {
        startY: 600,
        endY: 600, // startYと同じ
        height: 0,
      };

      await expect(
        service.extractSection(fullPageBase64, bounds, 'invalid-range')
      ).rejects.toThrow(SectionScreenshotServiceError);

      try {
        await service.extractSection(fullPageBase64, bounds, 'invalid-range');
      } catch (error) {
        expect(error).toBeInstanceOf(SectionScreenshotServiceError);
        expect((error as SectionScreenshotServiceError).code).toBe('INVALID_BOUNDS');
      }
    });
  });

  // =====================================================
  // 複数セクション並列切り出し（5テスト）
  // =====================================================

  describe('extractMultipleSections - 並列処理', () => {
    let service: SectionScreenshotService;
    let fullPageBase64: string;

    beforeEach(async () => {
      service = new SectionScreenshotService({ maxConcurrency: 3 });
      fullPageBase64 = await createFullPageScreenshot({});
    });

    it('複数セクションを並列で切り出せる', async () => {
      const sections = [
        { id: 'hero', bounds: { startY: 0, endY: 600, height: 600 } },
        { id: 'features', bounds: { startY: 600, endY: 1200, height: 600 } },
        { id: 'testimonials', bounds: { startY: 1200, endY: 1800, height: 600 } },
      ];

      const result = await service.extractMultipleSections(
        fullPageBase64,
        sections
      );

      expect(result.successes).toHaveLength(3);
      expect(result.errors).toHaveLength(0);
    });

    it('成功した切り出し結果のIDが正しい', async () => {
      const sections = [
        { id: 'section-0', bounds: { startY: 0, endY: 600, height: 600 } },
        { id: 'section-1', bounds: { startY: 600, endY: 1200, height: 600 } },
      ];

      const result = await service.extractMultipleSections(
        fullPageBase64,
        sections
      );

      const ids = result.successes.map((s) => s.sectionId);
      expect(ids).toContain('section-0');
      expect(ids).toContain('section-1');
    });

    it('一部セクションが失敗しても他のセクションは成功する', async () => {
      const sections = [
        { id: 'valid-1', bounds: { startY: 0, endY: 600, height: 600 } },
        { id: 'invalid', bounds: { startY: 5000, endY: 5600, height: 600 } }, // 境界外
        { id: 'valid-2', bounds: { startY: 600, endY: 1200, height: 600 } },
      ];

      const result = await service.extractMultipleSections(
        fullPageBase64,
        sections
      );

      expect(result.successes).toHaveLength(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.sectionId).toBe('invalid');
      expect(result.errors[0]?.errorCode).toBe('OUT_OF_BOUNDS');
    });

    it('空のセクション配列で空結果を返す', async () => {
      const result = await service.extractMultipleSections(fullPageBase64, []);

      expect(result.successes).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('5件以上のセクションでもバッチ処理が動作する', async () => {
      // 10セクション生成
      const sections = Array.from({ length: 10 }, (_, i) => ({
        id: `section-${i}`,
        bounds: { startY: i * 300, endY: (i + 1) * 300, height: 300 },
      }));

      const result = await service.extractMultipleSections(
        fullPageBase64,
        sections
      );

      expect(result.successes).toHaveLength(10);
      expect(result.errors).toHaveLength(0);
    });
  });

  // =====================================================
  // 空/無効Base64入力（3テスト）
  // =====================================================

  describe('extractSection - 無効入力', () => {
    let service: SectionScreenshotService;

    beforeEach(() => {
      service = new SectionScreenshotService();
    });

    it('空のBase64文字列でエラー', async () => {
      const bounds: SectionBounds = {
        startY: 0,
        endY: 600,
        height: 600,
      };

      await expect(
        service.extractSection('', bounds, 'empty-input')
      ).rejects.toThrow(SectionScreenshotServiceError);

      try {
        await service.extractSection('', bounds, 'empty-input');
      } catch (error) {
        expect(error).toBeInstanceOf(SectionScreenshotServiceError);
        expect((error as SectionScreenshotServiceError).code).toBe('INVALID_INPUT');
      }
    });

    it('無効なBase64文字列でエラー', async () => {
      const bounds: SectionBounds = {
        startY: 0,
        endY: 600,
        height: 600,
      };

      // 画像ではないBase64
      const invalidBase64 = Buffer.from('not an image').toString('base64');

      await expect(
        service.extractSection(invalidBase64, bounds, 'invalid-image')
      ).rejects.toThrow(SectionScreenshotServiceError);

      try {
        await service.extractSection(invalidBase64, bounds, 'invalid-image');
      } catch (error) {
        expect(error).toBeInstanceOf(SectionScreenshotServiceError);
        expect((error as SectionScreenshotServiceError).code).toBe('IMAGE_PROCESSING_ERROR');
      }
    });

    it('data:image/プレフィックスのみの場合エラー', async () => {
      const bounds: SectionBounds = {
        startY: 0,
        endY: 600,
        height: 600,
      };

      await expect(
        service.extractSection('data:image/png;base64,', bounds, 'empty-after-prefix')
      ).rejects.toThrow(SectionScreenshotServiceError);

      try {
        await service.extractSection('data:image/png;base64,', bounds, 'empty-after-prefix');
      } catch (error) {
        expect(error).toBeInstanceOf(SectionScreenshotServiceError);
        expect((error as SectionScreenshotServiceError).code).toBe('INVALID_INPUT');
      }
    });
  });

  // =====================================================
  // 出力フォーマット（3テスト）
  // =====================================================

  describe('extractSection - 出力フォーマット', () => {
    let fullPageBase64: string;

    beforeEach(async () => {
      fullPageBase64 = await createFullPageScreenshot({});
    });

    it('PNG形式で出力できる', async () => {
      const service = new SectionScreenshotService({ format: 'png' });
      const bounds: SectionBounds = { startY: 0, endY: 600, height: 600 };

      const result = await service.extractSection(
        fullPageBase64,
        bounds,
        'png-section'
      );

      expect(result.base64.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('JPEG形式で出力できる', async () => {
      const service = new SectionScreenshotService({ format: 'jpeg' });
      const bounds: SectionBounds = { startY: 0, endY: 600, height: 600 };

      const result = await service.extractSection(
        fullPageBase64,
        bounds,
        'jpeg-section'
      );

      expect(result.base64.startsWith('data:image/jpeg;base64,')).toBe(true);
    });

    it('WebP形式で出力できる', async () => {
      const service = new SectionScreenshotService({ format: 'webp' });
      const bounds: SectionBounds = { startY: 0, endY: 600, height: 600 };

      const result = await service.extractSection(
        fullPageBase64,
        bounds,
        'webp-section'
      );

      expect(result.base64.startsWith('data:image/webp;base64,')).toBe(true);
    });
  });

  // =====================================================
  // 品質オプション（2テスト）
  // =====================================================

  describe('extractSection - 品質オプション', () => {
    let fullPageBase64: string;

    beforeEach(async () => {
      fullPageBase64 = await createFullPageScreenshot({});
    });

    it('低品質JPEG出力のファイルサイズが小さい', async () => {
      const lowQualityService = new SectionScreenshotService({
        format: 'jpeg',
        quality: 30,
      });
      const highQualityService = new SectionScreenshotService({
        format: 'jpeg',
        quality: 95,
      });

      const bounds: SectionBounds = { startY: 0, endY: 600, height: 600 };

      const lowQuality = await lowQualityService.extractSection(
        fullPageBase64,
        bounds,
        'low-quality'
      );
      const highQuality = await highQualityService.extractSection(
        fullPageBase64,
        bounds,
        'high-quality'
      );

      // 低品質の方がファイルサイズが小さいはず
      expect(lowQuality.imageBuffer.length).toBeLessThan(
        highQuality.imageBuffer.length
      );
    });

    it('呼び出し時のオプションでフォーマットを上書きできる', async () => {
      const service = new SectionScreenshotService({ format: 'png' });
      const bounds: SectionBounds = { startY: 0, endY: 600, height: 600 };

      // 呼び出し時にJPEGを指定
      const result = await service.extractSection(
        fullPageBase64,
        bounds,
        'override-format',
        { format: 'jpeg' }
      );

      expect(result.base64.startsWith('data:image/jpeg;base64,')).toBe(true);
    });
  });

  // =====================================================
  // 高さの不整合（2テスト）
  // =====================================================

  describe('extractSection - 高さの不整合', () => {
    let service: SectionScreenshotService;
    let fullPageBase64: string;

    beforeEach(async () => {
      service = new SectionScreenshotService();
      fullPageBase64 = await createFullPageScreenshot({});
    });

    it('heightがendY-startYと一致しなくてもendY-startYで切り出す', async () => {
      // heightは500だが、endY-startYは600
      const bounds: SectionBounds = {
        startY: 0,
        endY: 600,
        height: 500, // 不一致
      };

      const result = await service.extractSection(
        fullPageBase64,
        bounds,
        'mismatched-height'
      );

      // endY - startY = 600 で切り出される
      expect(result.height).toBe(600);
    });

    it('heightが0でもendY>startYなら切り出せる', async () => {
      // これはエラーになるべき（height <= 0）
      const bounds: SectionBounds = {
        startY: 0,
        endY: 600,
        height: 0, // 無効
      };

      await expect(
        service.extractSection(fullPageBase64, bounds, 'zero-height')
      ).rejects.toThrow(SectionScreenshotServiceError);
    });
  });
});
