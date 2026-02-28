// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ImageOptimizer - CPU推論向け画像最適化
 *
 * Vision CPU完走保証 Phase 2: 画像を事前にリサイズ・圧縮して推論時間を短縮
 *
 * 最適化戦略:
 * - GPU: 最適化不要（そのまま使用）
 * - CPU Small (< 100KB): 最適化不要
 * - CPU Medium (100KB - 500KB): 最大1024x1024にリサイズ、品質80%
 * - CPU Large (>= 500KB): 最大768x768にリサイズ、品質70%
 *
 * @see apps/mcp-server/tests/services/vision/image-optimizer.test.ts
 */

import sharp from 'sharp';
import { HardwareType } from './hardware-detector.js';

// =============================================================================
// 定数
// =============================================================================

/**
 * 画像サイズ閾値（バイト）
 */
export const IMAGE_SIZE_THRESHOLDS = {
  /** Small画像閾値: 100KB */
  SMALL: 100_000,
  /** Large画像閾値: 500KB */
  LARGE: 500_000,
} as const;

/**
 * 最適化戦略
 */
export enum OptimizationStrategy {
  /** 最適化なし */
  NONE = 'NONE',
  /** 中程度の最適化（1024x1024、品質80%） */
  MEDIUM = 'MEDIUM',
  /** 積極的な最適化（768x768、品質70%） */
  AGGRESSIVE = 'AGGRESSIVE',
}

/**
 * 最適化設定
 */
export interface OptimizationConfig {
  /** 最大幅 */
  maxWidth?: number;
  /** 最大高さ */
  maxHeight?: number;
  /** JPEG品質（1-100） */
  quality?: number;
}

/**
 * 最適化設定プリセット
 */
export const OPTIMIZATION_CONFIGS: Record<OptimizationStrategy, OptimizationConfig> = {
  [OptimizationStrategy.NONE]: {},
  [OptimizationStrategy.MEDIUM]: {
    maxWidth: 1024,
    maxHeight: 1024,
    quality: 80,
  },
  [OptimizationStrategy.AGGRESSIVE]: {
    maxWidth: 768,
    maxHeight: 768,
    quality: 70,
  },
} as const;

/**
 * Sharp並行処理制限（メモリ枯渇防止）
 */
const SHARP_CONCURRENCY = 2;

// =============================================================================
// 型定義
// =============================================================================

/**
 * 最適化オプション
 */
export interface OptimizeOptions {
  /** ハードウェアタイプ（GPU/CPU） */
  hardwareType: HardwareType;
  /** 戦略を強制（自動選択をスキップ） */
  forceStrategy?: OptimizationStrategy;
  /** 出力フォーマット（デフォルト: jpeg） */
  outputFormat?: 'jpeg' | 'png';
}

/**
 * 最適化結果
 */
export interface OptimizeResult {
  /** 最適化後のバッファ */
  buffer: Buffer;
  /** 元のサイズ（バイト） */
  originalSizeBytes: number;
  /** 最適化後のサイズ（バイト） */
  optimizedSizeBytes: number;
  /** 画像サイズ（幅x高さ） */
  dimensions: {
    width: number;
    height: number;
  };
  /** 圧縮率（optimized / original、1以下なら圧縮成功） */
  compressionRatio: number;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
  /** 最適化がスキップされたか */
  skipped: boolean;
  /** スキップまたはエラーの理由 */
  reason?: string;
  /** エラーメッセージ */
  error?: string;
}

/**
 * 最適サイズ推定結果
 */
export interface ImageDimensions {
  /** 最大幅（undefined = 制限なし） */
  maxWidth: number | undefined;
  /** 最大高さ（undefined = 制限なし） */
  maxHeight: number | undefined;
  /** JPEG品質（undefined = 制限なし） */
  quality: number | undefined;
  /** 選択された戦略 */
  strategy: OptimizationStrategy;
}

// =============================================================================
// ImageOptimizer クラス
// =============================================================================

/**
 * 画像最適化クラス
 *
 * CPU推論のパフォーマンスを向上させるため、画像を事前にリサイズ・圧縮。
 * GPU使用時や小さな画像では最適化をスキップして効率を維持。
 *
 * @example
 * ```typescript
 * const optimizer = new ImageOptimizer();
 *
 * // 自動戦略選択
 * const result = await optimizer.optimizeForCPU(imageBuffer, {
 *   hardwareType: HardwareType.CPU,
 * });
 *
 * // 強制的に積極的な最適化
 * const result = await optimizer.optimizeForCPU(imageBuffer, {
 *   hardwareType: HardwareType.CPU,
 *   forceStrategy: OptimizationStrategy.AGGRESSIVE,
 * });
 * ```
 */
export class ImageOptimizer {
  constructor() {
    // Sharp並行処理制限を設定
    sharp.concurrency(SHARP_CONCURRENCY);
  }

  // ===========================================================================
  // パブリックメソッド
  // ===========================================================================

  /**
   * 最適化戦略を選択
   *
   * @param hardwareType - ハードウェアタイプ（GPU/CPU）
   * @param imageSizeBytes - 画像サイズ（バイト）
   * @returns 最適化戦略
   */
  selectStrategy(
    hardwareType: HardwareType,
    imageSizeBytes: number
  ): OptimizationStrategy {
    // GPUは最適化不要
    if (hardwareType === HardwareType.GPU) {
      return OptimizationStrategy.NONE;
    }

    // CPU: サイズに基づいて戦略を選択
    if (imageSizeBytes < IMAGE_SIZE_THRESHOLDS.SMALL) {
      return OptimizationStrategy.NONE;
    }

    if (imageSizeBytes >= IMAGE_SIZE_THRESHOLDS.LARGE) {
      return OptimizationStrategy.AGGRESSIVE;
    }

    return OptimizationStrategy.MEDIUM;
  }

  /**
   * 最適なサイズを推定
   *
   * @param imageSizeBytes - 画像サイズ（バイト）
   * @param hardwareType - ハードウェアタイプ（GPU/CPU）
   * @returns 推定される最適サイズと戦略
   */
  estimateOptimalSize(
    imageSizeBytes: number,
    hardwareType: HardwareType
  ): ImageDimensions {
    const strategy = this.selectStrategy(hardwareType, imageSizeBytes);
    const config = OPTIMIZATION_CONFIGS[strategy];

    return {
      maxWidth: config.maxWidth,
      maxHeight: config.maxHeight,
      quality: config.quality,
      strategy,
    };
  }

  /**
   * CPU推論向けに画像を最適化
   *
   * @param input - 画像バッファまたはBase64文字列
   * @param options - 最適化オプション
   * @returns 最適化結果
   */
  async optimizeForCPU(
    input: Buffer | string,
    options: OptimizeOptions
  ): Promise<OptimizeResult> {
    const startTime = performance.now();

    // 入力をBufferに変換
    let inputBuffer: Buffer;
    try {
      inputBuffer = this.toBuffer(input);
    } catch (error) {
      return this.createErrorResult(
        typeof input === 'string' ? Buffer.from(input) : input,
        startTime,
        `Invalid input: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const originalSize = inputBuffer.length;

    // 空のバッファをチェック
    if (originalSize === 0) {
      return this.createErrorResult(inputBuffer, startTime, 'Empty buffer');
    }

    // 戦略を決定
    const strategy =
      options.forceStrategy ?? this.selectStrategy(options.hardwareType, originalSize);

    // 最適化不要の場合はスキップ
    if (strategy === OptimizationStrategy.NONE) {
      return this.createSkippedResult(inputBuffer, startTime, 'No optimization needed');
    }

    // 最適化を実行
    try {
      const optimized = await this.applyOptimization(
        inputBuffer,
        strategy,
        options.outputFormat ?? 'jpeg'
      );
      const endTime = performance.now();

      return {
        buffer: optimized.buffer,
        originalSizeBytes: originalSize,
        optimizedSizeBytes: optimized.buffer.length,
        dimensions: {
          width: optimized.width,
          height: optimized.height,
        },
        compressionRatio: optimized.buffer.length / originalSize,
        processingTimeMs: Math.round(endTime - startTime),
        skipped: false,
      };
    } catch (error) {
      return this.createErrorResult(
        inputBuffer,
        startTime,
        `Optimization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * 入力をBufferに変換
   */
  private toBuffer(input: Buffer | string): Buffer {
    if (Buffer.isBuffer(input)) {
      return input;
    }

    // Base64文字列として解釈
    // data:image/...;base64, プレフィックスを除去
    const base64Data = input.replace(/^data:image\/[a-z]+;base64,/, '');
    return Buffer.from(base64Data, 'base64');
  }

  /**
   * 最適化を適用
   */
  private async applyOptimization(
    buffer: Buffer,
    strategy: OptimizationStrategy,
    outputFormat: 'jpeg' | 'png'
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    const config = OPTIMIZATION_CONFIGS[strategy];

    let pipeline = sharp(buffer);

    // リサイズ（アスペクト比を維持）
    if (config.maxWidth && config.maxHeight) {
      pipeline = pipeline.resize(config.maxWidth, config.maxHeight, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // 出力フォーマットと品質を設定
    if (outputFormat === 'jpeg') {
      pipeline = pipeline.jpeg({ quality: config.quality ?? 80 });
    } else {
      pipeline = pipeline.png({ compressionLevel: 6 });
    }

    // 処理を実行してメタデータを取得
    const outputBuffer = await pipeline.toBuffer();
    const metadata = await sharp(outputBuffer).metadata();

    return {
      buffer: outputBuffer,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
    };
  }

  /**
   * スキップ結果を作成
   */
  private createSkippedResult(
    buffer: Buffer,
    startTime: number,
    reason: string
  ): OptimizeResult {
    const endTime = performance.now();

    return {
      buffer,
      originalSizeBytes: buffer.length,
      optimizedSizeBytes: buffer.length,
      dimensions: { width: 0, height: 0 },
      compressionRatio: 1,
      processingTimeMs: Math.round(endTime - startTime),
      skipped: true,
      reason,
    };
  }

  /**
   * エラー結果を作成（Graceful Degradation）
   */
  private createErrorResult(
    buffer: Buffer,
    startTime: number,
    error: string
  ): OptimizeResult {
    const endTime = performance.now();

    return {
      buffer,
      originalSizeBytes: buffer.length,
      optimizedSizeBytes: buffer.length,
      dimensions: { width: 0, height: 0 },
      compressionRatio: 1,
      processingTimeMs: Math.round(endTime - startTime),
      skipped: true,
      error,
    };
  }
}
