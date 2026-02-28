// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FrameDiffAnalyzer
 *
 * Pixelmatchを使用したフレーム差分検出モジュール
 *
 * 機能:
 * - 2つのフレーム間のピクセル差分検出
 * - 変化率 (changeRatio) の計算 (0-1)
 * - 差分領域 (BoundingBox) の抽出
 * - 差分画像の生成
 *
 * 仕様: docs/specs/frame-image-analysis-spec.md
 *
 * @module services/motion/analyzers/frame-diff.analyzer
 */

import * as fs from 'node:fs';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import { logger, isDevelopment } from '../../../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * バウンディングボックス
 */
export interface BoundingBox {
  /** 左上X座標 */
  x: number;
  /** 左上Y座標 */
  y: number;
  /** 幅 */
  width: number;
  /** 高さ */
  height: number;
}

/**
 * フレーム差分検出オプション
 */
export interface FrameDiffOptions {
  /** ピクセル差分閾値 (0-1) デフォルト: 0.1 */
  threshold?: number;
  /** 差分画像を含めるか デフォルト: false */
  includeDiffImage?: boolean;
  /** アンチエイリアシングを考慮するか デフォルト: true */
  includeAA?: boolean;
}

/**
 * フレーム差分検出結果
 */
export interface FrameDiffResult {
  /** 変化率 (0-1) */
  changeRatio: number;
  /** 差分ピクセル数 */
  diffPixelCount: number;
  /** 総ピクセル数 */
  totalPixelCount: number;
  /** 差分領域のバウンディングボックス配列 */
  diffRegions: BoundingBox[];
  /** 差分画像バッファ (オプション) */
  diffImageBuffer?: Buffer;
}

/**
 * デフォルトオプション
 */
const DEFAULT_OPTIONS: Required<FrameDiffOptions> = {
  threshold: 0.1,
  includeDiffImage: false,
  includeAA: true,
};

// =====================================================
// エラークラス
// =====================================================

/**
 * フレーム差分解析エラー
 */
export class FrameDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameDiffError';
  }
}

// =====================================================
// FrameDiffAnalyzer クラス
// =====================================================

/**
 * Pixelmatchを使用したフレーム差分検出クラス
 */
export class FrameDiffAnalyzer {
  private readonly options: Required<FrameDiffOptions>;

  /**
   * コンストラクタ
   * @param options - 差分検出オプション
   */
  constructor(options: FrameDiffOptions = {}) {
    this.options = {
      threshold: options.threshold ?? DEFAULT_OPTIONS.threshold,
      includeDiffImage: options.includeDiffImage ?? DEFAULT_OPTIONS.includeDiffImage,
      includeAA: options.includeAA ?? DEFAULT_OPTIONS.includeAA,
    };

    if (isDevelopment()) {
      logger.debug('[FrameDiffAnalyzer] Initialized', {
        threshold: this.options.threshold,
        includeDiffImage: this.options.includeDiffImage,
      });
    }
  }

  /**
   * 2つのフレーム間の差分を解析
   *
   * @param frame1 - 比較元フレーム (Buffer または ファイルパス)
   * @param frame2 - 比較先フレーム (Buffer または ファイルパス)
   * @param options - 解析オプション (コンストラクタオプションを上書き)
   * @returns フレーム差分結果
   * @throws FrameDiffError
   */
  async analyze(
    frame1: Buffer | string,
    frame2: Buffer | string,
    options?: FrameDiffOptions
  ): Promise<FrameDiffResult> {
    const opts = {
      threshold: options?.threshold ?? this.options.threshold,
      includeDiffImage: options?.includeDiffImage ?? this.options.includeDiffImage,
      includeAA: options?.includeAA ?? this.options.includeAA,
    };

    if (isDevelopment()) {
      logger.debug('[FrameDiffAnalyzer] analyze called', { threshold: opts.threshold });
    }

    // 入力をBufferに変換
    const buffer1 = await this.toBuffer(frame1);
    const buffer2 = await this.toBuffer(frame2);

    // 画像データを取得（RGBA形式に統一）
    const [img1Data, img2Data] = await Promise.all([
      this.getImageData(buffer1),
      this.getImageData(buffer2),
    ]);

    // サイズチェック
    if (img1Data.width !== img2Data.width || img1Data.height !== img2Data.height) {
      throw new FrameDiffError(
        `Image dimensions do not match: ${img1Data.width}x${img1Data.height} vs ${img2Data.width}x${img2Data.height}`
      );
    }

    const { width, height } = img1Data;
    const totalPixelCount = width * height;

    // 差分画像バッファを準備
    const diffBuffer = Buffer.alloc(width * height * 4);

    // Pixelmatchで差分検出
    const diffPixelCount = pixelmatch(
      img1Data.data,
      img2Data.data,
      diffBuffer,
      width,
      height,
      {
        threshold: opts.threshold,
        includeAA: opts.includeAA,
      }
    );

    // 変化率を計算
    const changeRatio = this.calculateChangeRatio(diffPixelCount, totalPixelCount);

    // 差分領域を抽出（差分がない場合は空配列）
    const diffRegions = diffPixelCount === 0
      ? []
      : this.extractDiffRegionsFromBuffer(diffBuffer, width, height, diffPixelCount);

    // 結果を構築
    const result: FrameDiffResult = {
      changeRatio,
      diffPixelCount,
      totalPixelCount,
      diffRegions,
    };

    // 差分画像を含める場合
    if (opts.includeDiffImage) {
      result.diffImageBuffer = await this.bufferToPng(diffBuffer, width, height);
    }

    if (isDevelopment()) {
      logger.debug('[FrameDiffAnalyzer] analyze completed', {
        changeRatio,
        diffPixelCount,
        totalPixelCount,
        regionsCount: diffRegions.length,
      });
    }

    return result;
  }

  /**
   * 変化率を計算
   *
   * @param diffPixels - 差分ピクセル数
   * @param totalPixels - 総ピクセル数
   * @returns 変化率 (0-1)
   */
  calculateChangeRatio(diffPixels: number, totalPixels: number): number {
    if (totalPixels === 0) {
      return 0;
    }
    return diffPixels / totalPixels;
  }

  /**
   * 差分画像を生成
   *
   * @param frame1 - 比較元フレーム
   * @param frame2 - 比較先フレーム
   * @param outputPath - 出力ファイルパス (オプション)
   * @returns 差分画像バッファ
   */
  async createDiffImage(
    frame1: Buffer | string,
    frame2: Buffer | string,
    outputPath?: string
  ): Promise<Buffer> {
    const result = await this.analyze(frame1, frame2, { includeDiffImage: true });

    if (!result.diffImageBuffer) {
      throw new FrameDiffError('Failed to generate diff image');
    }

    if (outputPath) {
      fs.writeFileSync(outputPath, result.diffImageBuffer);
      if (isDevelopment()) {
        logger.debug('[FrameDiffAnalyzer] Diff image saved', { outputPath });
      }
    }

    return result.diffImageBuffer;
  }

  // =====================================================
  // プライベートメソッド
  // =====================================================

  /**
   * 入力をBufferに変換
   */
  private async toBuffer(input: Buffer | string): Promise<Buffer> {
    if (Buffer.isBuffer(input)) {
      if (input.length === 0) {
        throw new FrameDiffError('Empty buffer provided');
      }
      return input;
    }

    // ファイルパスの場合
    if (!fs.existsSync(input)) {
      throw new FrameDiffError(`File not found: ${input}`);
    }

    return fs.promises.readFile(input);
  }

  /**
   * 画像データをRGBA形式で取得
   */
  private async getImageData(
    buffer: Buffer
  ): Promise<{ data: Buffer; width: number; height: number }> {
    try {
      const result = await sharp(buffer)
        .ensureAlpha() // アルファチャンネルを確保
        .raw()
        .toBuffer({ resolveWithObject: true });

      return {
        data: result.data,
        width: result.info.width,
        height: result.info.height,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new FrameDiffError(`Failed to process image: ${message}`);
    }
  }

  /**
   * 差分バッファから領域を抽出
   *
   * Pixelmatchの差分バッファからバウンディングボックスを計算
   * - 差分ピクセルは赤色(255, 0, 0, 255)で描画される
   * - アルファが0でないピクセルを差分として検出
   *
   * @param diffBuffer - Pixelmatchが生成した差分バッファ
   * @param width - 画像幅
   * @param height - 画像高さ
   * @param expectedDiffCount - Pixelmatchが報告した差分ピクセル数
   */
  private extractDiffRegionsFromBuffer(
    diffBuffer: Buffer,
    width: number,
    height: number,
    expectedDiffCount: number
  ): BoundingBox[] {
    if (expectedDiffCount === 0) {
      return [];
    }

    // 差分があるピクセルの座標からバウンディングボックスを計算
    // Pixelmatchは差分ピクセルをdiffColor（デフォルト: 赤#FF0000）で描画
    // アルファが255のピクセルを差分として検出
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        // アルファチャンネルで差分を検出（Pixelmatchはa=255で差分を描画）
        const alpha = diffBuffer[offset + 3];
        if (alpha !== undefined && alpha > 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    // 差分が見つからなかった場合
    if (maxX < 0 || maxY < 0) {
      return [];
    }

    return [
      {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      },
    ];
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
