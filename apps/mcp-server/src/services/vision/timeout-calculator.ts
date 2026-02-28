// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TimeoutCalculator - 動的タイムアウト計算
 *
 * Vision CPU完走保証 Phase 1: GPU/CPUおよび画像サイズに基づくタイムアウト計算
 *
 * タイムアウト値:
 * - GPU: 60秒 (60,000ms)
 * - CPU小画像 (< 100KB): 180秒 (180,000ms)
 * - CPU中画像 (100KB - 500KB): 600秒 (600,000ms)
 * - CPUフルページ (>= 500KB): 1200秒 (1,200,000ms)
 *
 * @see apps/mcp-server/tests/services/vision/timeout-calculator.test.ts
 */

import { HardwareType, type HardwareInfo } from './hardware-detector.js';

// Re-export HardwareType for convenience
export { HardwareType };

// =============================================================================
// 定数
// =============================================================================

/**
 * 画像サイズ境界値（バイト）
 */
const IMAGE_SIZE_SMALL_THRESHOLD = 100_000; // 100KB
const IMAGE_SIZE_LARGE_THRESHOLD = 500_000; // 500KB

/**
 * 画像サイズ分類
 */
export enum ImageSize {
  SMALL = 'SMALL',
  MEDIUM = 'MEDIUM',
  LARGE = 'LARGE',
}

/**
 * タイムアウト定数（ミリ秒）
 */
export const VisionTimeouts = {
  /** GPU: 60秒 */
  GPU: 60_000,
  /** CPU小画像: 180秒（3分） */
  CPU_SMALL: 180_000,
  /** CPU中画像: 600秒（10分） */
  CPU_MEDIUM: 600_000,
  /** CPUフルページ: 1200秒（20分） */
  CPU_LARGE: 1_200_000,
} as const;

// =============================================================================
// TimeoutCalculator クラス
// =============================================================================

/**
 * タイムアウト計算クラス
 *
 * ハードウェアタイプと画像サイズに基づいて適切なタイムアウトを計算。
 *
 * @example
 * ```typescript
 * const calculator = new TimeoutCalculator();
 * const timeout = calculator.calculate(HardwareType.CPU, 200_000);
 * console.log(calculator.formatTimeout(timeout)); // "10m 0s"
 * ```
 */
export class TimeoutCalculator {
  /**
   * タイムアウトを計算
   *
   * @param hardwareType - ハードウェアタイプ（GPU/CPU）
   * @param imageSizeBytes - 画像サイズ（バイト）、オプション
   * @returns タイムアウト（ミリ秒）
   */
  calculate(hardwareType: HardwareType, imageSizeBytes?: number): number {
    // GPUは画像サイズに関係なく60秒
    if (hardwareType === HardwareType.GPU) {
      return VisionTimeouts.GPU;
    }

    // CPUの場合は画像サイズで判定
    const imageSize = this.classifyImageSize(imageSizeBytes);

    switch (imageSize) {
      case ImageSize.SMALL:
        return VisionTimeouts.CPU_SMALL;
      case ImageSize.LARGE:
        return VisionTimeouts.CPU_LARGE;
      case ImageSize.MEDIUM:
      default:
        return VisionTimeouts.CPU_MEDIUM;
    }
  }

  /**
   * HardwareInfoオブジェクトからタイムアウトを計算
   *
   * @param info - ハードウェア情報
   * @param imageSizeBytes - 画像サイズ（バイト）、オプション
   * @returns タイムアウト（ミリ秒）
   */
  calculateFromHardwareInfo(
    info: HardwareInfo,
    imageSizeBytes?: number
  ): number {
    return this.calculate(info.type, imageSizeBytes);
  }

  /**
   * 画像サイズを分類
   *
   * - < 100KB: SMALL
   * - 100KB - 500KB: MEDIUM
   * - >= 500KB: LARGE
   *
   * @param bytes - 画像サイズ（バイト）
   * @returns 画像サイズ分類
   */
  classifyImageSize(bytes?: number): ImageSize {
    // undefined、0、負の値は中サイズとして扱う（デフォルト）
    if (bytes === undefined) {
      return ImageSize.MEDIUM;
    }

    // 負の値または0は小サイズ
    if (bytes <= 0) {
      return ImageSize.SMALL;
    }

    if (bytes < IMAGE_SIZE_SMALL_THRESHOLD) {
      return ImageSize.SMALL;
    }

    if (bytes >= IMAGE_SIZE_LARGE_THRESHOLD) {
      return ImageSize.LARGE;
    }

    return ImageSize.MEDIUM;
  }

  /**
   * タイムアウトを人間が読みやすい形式にフォーマット
   *
   * @param ms - タイムアウト（ミリ秒）
   * @returns フォーマットされた文字列（例: "10m 0s"）
   */
  formatTimeout(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }
}
