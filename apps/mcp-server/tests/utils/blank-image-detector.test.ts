// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TKMD & Reftrix Contributors

/**
 * isBlankImage テスト / isBlankImage tests
 *
 * TDD Red: Lazy Loading未描画セクションの白画像検出ユーティリティ
 * TDD Red: Blank image detection utility for lazy-loaded unrendered sections
 *
 * SEC要件テスト / SEC requirement tests:
 * - SEC-01: Buffer入力バリデーション / Buffer input validation
 * - SEC-02: 環境変数の不正値防御 / Environment variable sanitization
 * - SEC-03: Sharp stats stddev結果のNaN/Infinity防御 / Sharp stats stddev NaN/Infinity defense
 * - SEC-04: Sharp stats mean結果のNaN/Infinity防御 / Sharp stats mean NaN/Infinity defense
 *
 * @module tests/utils/blank-image-detector
 */

import { describe, it, expect, afterEach } from 'vitest';
import sharp from 'sharp';

import { isBlankImage } from '../../src/utils/blank-image-detector';

describe('isBlankImage', () => {
  // ==========================================================================
  // SEC-01: Buffer入力バリデーション / Buffer input validation
  // ==========================================================================

  describe('SEC-01: 無効入力 / invalid input', () => {
    it('null入力 → false を返す / null input returns false', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await isBlankImage(null as any);
      expect(result).toBe(false);
    });

    it('undefined入力 → false を返す / undefined input returns false', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await isBlankImage(undefined as any);
      expect(result).toBe(false);
    });

    it('空バッファ → false を返す / empty buffer returns false', async () => {
      const result = await isBlankImage(Buffer.alloc(0));
      expect(result).toBe(false);
    });

    it('巨大バッファ(上限超過) → false を返す / oversized buffer returns false', async () => {
      // 20MB + 1 byte の巨大バッファ / Buffer exceeding 20MB limit
      const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
      const result = await isBlankImage(oversized);
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // 実バッファ統合テスト（TDA MEDIUM-2） / Real buffer integration tests
  // ==========================================================================

  describe('実バッファ画像判定 / real buffer image detection', () => {
    it('白画像(RGB stddev < 5.0) → true を返す / white image returns true', async () => {
      // Sharp で 100x100 白画像を生成 / Generate 100x100 white image with Sharp
      const whiteBuffer = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .png()
        .toBuffer();

      const result = await isBlankImage(whiteBuffer);
      expect(result).toBe(true);
    });

    it('単色画像(非白, 中間輝度) → false を返す / solid color mid-luminance image returns false', async () => {
      // 単色の青画像（mean ~97, 極端でない）→ blank ではない
      // Solid blue image (mean ~97, not extreme) → not blank
      const blueBuffer = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 30, g: 60, b: 200 },
        },
      })
        .png()
        .toBuffer();

      const result = await isBlankImage(blueBuffer);
      expect(result).toBe(false);
    });

    it('純黒画像(near-black, stddev ≈ 0) → true を返す / pure black image returns true', async () => {
      // 純黒画像（mean ~0, stddev ~0）→ blank
      // Pure black image (mean ~0, stddev ~0) → blank
      const blackBuffer = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const result = await isBlankImage(blackBuffer);
      expect(result).toBe(true);
    });

    it('ダークテーマ背景(mean ~30-50, stddev < 5) → false を返す / dark theme background returns false', async () => {
      // supabase.comのようなダークテーマ背景（mean ~35, stddev < 5）→ blank ではない
      // Dark theme background like supabase.com (mean ~35, stddev < 5) → not blank
      const darkBuffer = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 30, g: 35, b: 40 },
        },
      })
        .png()
        .toBuffer();

      const result = await isBlankImage(darkBuffer);
      expect(result).toBe(false);
    });

    it('通常画像(stddev > 5.0) → false を返す / normal image returns false', async () => {
      // ノイズのある画像を生成: 半分白 + 半分黒のパターン
      // Generate noisy image: half white + half black pattern
      const width = 100;
      const height = 100;
      const channels = 3;
      const rawData = Buffer.alloc(width * height * channels);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * channels;
          if (y < height / 2) {
            // 上半分: 白 / Top half: white
            rawData[idx] = 255;
            rawData[idx + 1] = 255;
            rawData[idx + 2] = 255;
          } else {
            // 下半分: 黒 / Bottom half: black
            rawData[idx] = 0;
            rawData[idx + 1] = 0;
            rawData[idx + 2] = 0;
          }
        }
      }

      const imageBuffer = await sharp(rawData, {
        raw: { width, height, channels },
      })
        .png()
        .toBuffer();

      const result = await isBlankImage(imageBuffer);
      expect(result).toBe(false);
    });

    it('グラデーション画像 → false を返す / gradient image returns false', async () => {
      // 垂直グラデーション画像 / Vertical gradient image
      const width = 100;
      const height = 100;
      const channels = 3;
      const rawData = Buffer.alloc(width * height * channels);

      for (let y = 0; y < height; y++) {
        const value = Math.round((y / (height - 1)) * 255);
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * channels;
          rawData[idx] = value;
          rawData[idx + 1] = value;
          rawData[idx + 2] = value;
        }
      }

      const imageBuffer = await sharp(rawData, {
        raw: { width, height, channels },
      })
        .png()
        .toBuffer();

      const result = await isBlankImage(imageBuffer);
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // v0.1.10: mean境界値テスト / mean threshold boundary tests
  // ==========================================================================

  describe('mean閾値境界値 / mean threshold boundaries', () => {
    it('mean=245(ちょうど上限) → false / mean exactly at upper threshold returns false', async () => {
      // RGB(245, 245, 245) → avgMean = 245, 245 > 245 は false → blank ではない
      const buffer = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 245, g: 245, b: 245 } },
      }).png().toBuffer();

      expect(await isBlankImage(buffer)).toBe(false);
    });

    it('mean=246(上限超過) → true / mean above upper threshold returns true', async () => {
      // RGB(246, 246, 246) → avgMean = 246 > 245 → blank
      const buffer = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 246, g: 246, b: 246 } },
      }).png().toBuffer();

      expect(await isBlankImage(buffer)).toBe(true);
    });

    it('mean=10(ちょうど下限) → false / mean exactly at lower threshold returns false', async () => {
      // RGB(10, 10, 10) → avgMean = 10, 10 < 10 は false → blank ではない
      const buffer = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 10, g: 10, b: 10 } },
      }).png().toBuffer();

      expect(await isBlankImage(buffer)).toBe(false);
    });

    it('mean=9(下限未満) → true / mean below lower threshold returns true', async () => {
      // RGB(9, 9, 9) → avgMean = 9 < 10 → blank
      const buffer = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 9, g: 9, b: 9 } },
      }).png().toBuffer();

      expect(await isBlankImage(buffer)).toBe(true);
    });
  });

  // ==========================================================================
  // SEC-02: 環境変数の不正値防御 / Environment variable sanitization
  // ==========================================================================

  describe('SEC-02: 環境変数 BLANK_IMAGE_STDDEV_THRESHOLD', () => {
    const originalEnv = process.env['BLANK_IMAGE_STDDEV_THRESHOLD'];

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env['BLANK_IMAGE_STDDEV_THRESHOLD'];
      } else {
        process.env['BLANK_IMAGE_STDDEV_THRESHOLD'] = originalEnv;
      }
    });

    it('NaN → デフォルト値(5.0)を使用する / NaN falls back to default', async () => {
      process.env['BLANK_IMAGE_STDDEV_THRESHOLD'] = 'NaN';

      // 白画像はデフォルト閾値 5.0 で true を返すべき
      // White image should return true with default threshold 5.0
      const whiteBuffer = await sharp({
        create: {
          width: 50,
          height: 50,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .png()
        .toBuffer();

      const result = await isBlankImage(whiteBuffer);
      expect(result).toBe(true);
    });

    it('負の値(-1) → デフォルト値を使用する / negative value falls back to default', async () => {
      process.env['BLANK_IMAGE_STDDEV_THRESHOLD'] = '-1';

      const whiteBuffer = await sharp({
        create: {
          width: 50,
          height: 50,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .png()
        .toBuffer();

      const result = await isBlankImage(whiteBuffer);
      expect(result).toBe(true);
    });

    it('上限超過(300) → デフォルト値を使用する / value over 255 falls back to default', async () => {
      process.env['BLANK_IMAGE_STDDEV_THRESHOLD'] = '300';

      const whiteBuffer = await sharp({
        create: {
          width: 50,
          height: 50,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .png()
        .toBuffer();

      // デフォルト閾値(5.0)で判定するため true
      // Default threshold (5.0) yields true
      const result = await isBlankImage(whiteBuffer);
      expect(result).toBe(true);
    });

    it('有効な値(10.0) → その値をカスタム閾値として使用 / valid value is used as custom threshold', async () => {
      process.env['BLANK_IMAGE_STDDEV_THRESHOLD'] = '10.0';

      // stddev がちょうど閾値付近の微弱なノイズ画像を生成
      // Generate image with slight noise near the threshold
      const width = 100;
      const height = 100;
      const channels = 3;
      const rawData = Buffer.alloc(width * height * channels);

      // ほぼ白だが微妙なノイズ: r=250-255のランダム
      // Nearly white with slight noise: r=250-255 random
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * channels;
          const noise = Math.round(Math.random() * 5);
          rawData[idx] = 250 + noise;
          rawData[idx + 1] = 250 + noise;
          rawData[idx + 2] = 250 + noise;
        }
      }

      const imageBuffer = await sharp(rawData, {
        raw: { width, height, channels },
      })
        .png()
        .toBuffer();

      // stddev < 10.0 のため true を返すべき
      // stddev < 10.0 so should return true
      const result = await isBlankImage(imageBuffer);
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // SEC-03: Sharp stats結果のNaN/Infinity防御
  // ==========================================================================

  describe('SEC-03: Sharp stats異常値 / Sharp stats anomalies', () => {
    it('壊れたバッファ → false を返す(Graceful Degradation) / corrupted buffer returns false', async () => {
      // Sharp が例外を投げるような不正バッファ
      // Invalid buffer that causes Sharp to throw
      const corruptedBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
      const result = await isBlankImage(corruptedBuffer);
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // LCC MUST-FIX-2: バッファ参照を保持しない / Buffer reference not retained
  // ==========================================================================

  describe('LCC MUST-FIX-2: バッファ参照 / buffer reference', () => {
    it('isBlankImage は入力バッファを変更しない / does not mutate input buffer', async () => {
      const whiteBuffer = await sharp({
        create: {
          width: 50,
          height: 50,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .png()
        .toBuffer();

      const originalLength = whiteBuffer.length;
      const originalFirstByte = whiteBuffer[0];

      await isBlankImage(whiteBuffer);

      // バッファが変更されていないことを確認 / Verify buffer was not mutated
      expect(whiteBuffer.length).toBe(originalLength);
      expect(whiteBuffer[0]).toBe(originalFirstByte);
    });
  });
});
