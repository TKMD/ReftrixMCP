// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Viewport Diff Service
 * 異なるビューポートのスクリーンショットを比較し、視覚的差分を検出するサービス
 *
 * @module services/responsive/viewport-diff.service
 */

import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import { logger, isDevelopment } from '../../utils/logger';
import type { ViewportDiffResult } from './types';

/**
 * ViewportDiff オプション
 */
export interface ViewportDiffOptions {
  /** Pixelmatch の差分閾値 (0-1, デフォルト: 0.1) */
  threshold?: number;
  /** 差分画像を結果に含めるか */
  includeDiffImage?: boolean;
}

/**
 * 画像のRGBAデータ
 */
interface ImageData {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Viewport Diff Service
 * 異なるビューポートのスクリーンショットを比較するサービス
 */
export class ViewportDiffService {
  /**
   * 2つのスクリーンショットバッファを比較
   *
   * @param screenshot1 - 比較元スクリーンショット（PNGバッファ）
   * @param screenshot2 - 比較先スクリーンショット（PNGバッファ）
   * @param viewport1Name - 比較元ビューポート名
   * @param viewport2Name - 比較先ビューポート名
   * @param options - 差分検出オプション
   * @returns 差分結果
   */
  async comparePair(
    screenshot1: Buffer,
    screenshot2: Buffer,
    viewport1Name: string,
    viewport2Name: string,
    options?: ViewportDiffOptions
  ): Promise<ViewportDiffResult> {
    const threshold = options?.threshold ?? 0.1;
    const includeDiffImage = options?.includeDiffImage ?? false;

    if (isDevelopment()) {
      logger.debug('[ViewportDiff] Comparing pair', {
        viewport1: viewport1Name,
        viewport2: viewport2Name,
        threshold,
      });
    }

    // 画像データをRGBA形式で取得
    const [img1, img2] = await Promise.all([
      this.getImageData(screenshot1),
      this.getImageData(screenshot2),
    ]);

    // 小さい方の解像度に合わせてリサイズ（アスペクト比維持）
    const targetWidth = Math.min(img1.width, img2.width);
    const targetHeight = Math.min(img1.height, img2.height);

    const [resized1, resized2] = await Promise.all([
      this.resizeToMatch(screenshot1, targetWidth, targetHeight),
      this.resizeToMatch(screenshot2, targetWidth, targetHeight),
    ]);

    const totalPixels = resized1.width * resized1.height;

    // 差分画像バッファを準備
    const diffBuffer = Buffer.alloc(resized1.width * resized1.height * 4);

    // Pixelmatchで差分検出
    const diffPixelCount = pixelmatch(
      resized1.data,
      resized2.data,
      diffBuffer,
      resized1.width,
      resized1.height,
      { threshold }
    );

    const diffPercentage = totalPixels > 0
      ? (diffPixelCount / totalPixels) * 100
      : 0;

    if (isDevelopment()) {
      logger.debug('[ViewportDiff] Comparison completed', {
        viewport1: viewport1Name,
        viewport2: viewport2Name,
        diffPercentage: diffPercentage.toFixed(2),
        diffPixelCount,
        totalPixels,
      });
    }

    // exactOptionalPropertyTypes対応: 条件付きで返す
    if (includeDiffImage) {
      const diffImageBuffer = await this.bufferToPng(
        diffBuffer,
        resized1.width,
        resized1.height
      );
      return {
        viewport1: viewport1Name,
        viewport2: viewport2Name,
        diffPercentage,
        diffPixelCount,
        totalPixels,
        comparedWidth: resized1.width,
        comparedHeight: resized1.height,
        diffImageBuffer,
      };
    }

    return {
      viewport1: viewport1Name,
      viewport2: viewport2Name,
      diffPercentage,
      diffPixelCount,
      totalPixels,
      comparedWidth: resized1.width,
      comparedHeight: resized1.height,
    };
  }

  /**
   * 複数のスクリーンショットを全ペアで比較
   *
   * @param screenshots - ビューポート名 → スクリーンショットバッファのマップ
   * @param options - 差分検出オプション
   * @returns 全ペアの差分結果配列
   */
  async compareAll(
    screenshots: Map<string, Buffer>,
    options?: ViewportDiffOptions
  ): Promise<ViewportDiffResult[]> {
    const entries = Array.from(screenshots.entries());
    const results: ViewportDiffResult[] = [];

    if (entries.length < 2) {
      if (isDevelopment()) {
        logger.debug('[ViewportDiff] Not enough screenshots for comparison', {
          count: entries.length,
        });
      }
      return results;
    }

    // 全ペアを比較
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [name1, buffer1] = entries[i]!;
        const [name2, buffer2] = entries[j]!;
        const result = await this.comparePair(
          buffer1,
          buffer2,
          name1,
          name2,
          options
        );
        results.push(result);
      }
    }

    if (isDevelopment()) {
      logger.info('[ViewportDiff] All comparisons completed', {
        pairCount: results.length,
        avgDiffPercentage: results.length > 0
          ? (results.reduce((sum, r) => sum + r.diffPercentage, 0) / results.length).toFixed(2)
          : '0',
      });
    }

    return results;
  }

  /**
   * 画像データをRGBA形式で取得
   */
  private async getImageData(buffer: Buffer): Promise<ImageData> {
    const result = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      data: result.data,
      width: result.info.width,
      height: result.info.height,
    };
  }

  /**
   * 指定サイズにリサイズしてRGBAデータを返す（アスペクト比維持、パディングなし）
   */
  private async resizeToMatch(
    buffer: Buffer,
    targetWidth: number,
    targetHeight: number
  ): Promise<ImageData> {
    const result = await sharp(buffer)
      .resize(targetWidth, targetHeight, {
        fit: 'cover',
        position: 'top',
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      data: result.data,
      width: result.info.width,
      height: result.info.height,
    };
  }

  /**
   * RGBAバッファをPNG画像に変換
   */
  private async bufferToPng(
    buffer: Buffer,
    width: number,
    height: number
  ): Promise<Buffer> {
    return sharp(buffer, {
      raw: {
        width,
        height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();
  }
}

// シングルトンインスタンス
export const viewportDiffService = new ViewportDiffService();
