// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TKMD & Reftrix Contributors

/**
 * Blank Image Detector
 *
 * 画像バッファが白/単色（blank）かどうかを判定するユーティリティ。
 * Phase 5 (Embedding) で fullPage screenshot の Lazy Loading 未描画セクション検出に使用。
 * Sharp stats の RGB 各チャンネルの stddev（標準偏差）と mean（平均輝度）で判定する。
 *
 * v0.1.10: stddev + mean 2条件判定に改善。stddev < 閾値 かつ 平均輝度が極端（>245 or <10）の
 * 場合のみ blank と判定する。ダークテーマサイト（supabase.com等）での誤検出を防止。
 *
 * Utility to detect if an image buffer is blank (white/solid color).
 * Used in Phase 5 (Embedding) to detect lazy-loaded unrendered sections in fullPage screenshots.
 * Determines blankness using RGB channel stddev AND mean from Sharp stats.
 *
 * v0.1.10: Improved to dual-condition (stddev + mean). Only flags as blank when stddev < threshold
 * AND average mean is extreme (>245 or <10). Prevents false positives on dark-themed sites.
 *
 * SEC: 読み取り専用操作。バッファを出力に使用しない（LCC MUST-FIX-2）。
 * SEC: Read-only operation. Buffer is not used in output (LCC MUST-FIX-2).
 *
 * @module utils/blank-image-detector
 */

import sharp from "sharp";

/**
 * デフォルトの stddev 閾値 / Default stddev threshold
 * 各チャンネルの平均 stddev がこの値未満の場合、blank 候補とする（mean条件も必要）
 * Image is considered a blank candidate when average channel stddev is below this value (mean condition also required)
 */
const DEFAULT_STDDEV_THRESHOLD = 5.0;

/**
 * 平均輝度の上限閾値 / Mean brightness upper threshold
 * 平均値がこの値より大きい場合、近白色（near-white）と判定
 * Image is considered near-white when average mean exceeds this value
 */
const MEAN_UPPER_THRESHOLD = 245;

/**
 * 平均輝度の下限閾値 / Mean brightness lower threshold
 * 平均値がこの値より小さい場合、近黒色（near-black）と判定
 * Image is considered near-black when average mean is below this value
 */
const MEAN_LOWER_THRESHOLD = 10;

/**
 * 最大バッファサイズ（20MB） / Maximum buffer size (20MB)
 * SEC-01: 巨大バッファによるメモリ消費を防御
 * SEC-01: Defend against memory consumption from oversized buffers
 */
const MAX_BUFFER_SIZE = 20 * 1024 * 1024;

/**
 * 画像バッファが白/単色（blank）かどうかを判定する / Detect if image buffer is blank (white/solid color)
 *
 * Sharp stats の RGB 各チャンネルの stddev と mean で判定。stddev が小さいほど画素値の分散が少なく、
 * 単色に近い画像であることを示す。さらに mean（平均輝度）が極端（>245 or <10）の場合のみ
 * blank と判定し、ダークテーマサイトでの誤検出（false positive）を防止する。
 *
 * Uses Sharp stats RGB channel stddev AND mean. Lower stddev means less pixel variance, indicating
 * a near-solid-color image. Additionally requires mean to be extreme (>245 or <10) to prevent
 * false positives on dark-themed sites where sections have dark but content-rich backgrounds.
 *
 * SEC-01: 無効入力（null/undefined/空/巨大バッファ）は false を返す
 * SEC-02: 環境変数 BLANK_IMAGE_STDDEV_THRESHOLD の NaN/Infinity/負値/上限防御
 * SEC-03: Sharp stats 結果の NaN/Infinity 防御
 * SEC-04: mean 値の NaN/Infinity 防御
 * LCC MUST-FIX-2: バッファの参照を保持しない（読み取り専用操作）
 *
 * @param buffer - 判定対象の画像バッファ / Image buffer to check
 * @returns true の場合は blank（白/単色）と判定 / true if image is blank (white/solid color)
 */
export async function isBlankImage(buffer: Buffer): Promise<boolean> {
  // SEC-01: 入力バリデーション / Input validation
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false; // SEC-01: 無効入力は blank とみなさない / Invalid input is not considered blank
  }
  if (buffer.length > MAX_BUFFER_SIZE) {
    return false; // SEC-01: 巨大バッファ防御 / Oversized buffer defense
  }

  // SEC-02: 環境変数の安全なパース / Safe environment variable parsing
  const envValue = parseFloat(process.env["BLANK_IMAGE_STDDEV_THRESHOLD"] ?? "");
  const stddevThreshold =
    Number.isFinite(envValue) && envValue >= 0 && envValue <= 255
      ? envValue
      : DEFAULT_STDDEV_THRESHOLD;

  try {
    // SEC: sharp() は読み取り専用操作。入力バッファを変更しない
    // SEC: sharp() is a read-only operation. Does not mutate the input buffer
    const { channels } = await sharp(buffer).stats();

    // LOW-1: 空チャンネル配列の型ガード / Empty channels array type guard
    if (!channels || channels.length === 0) {
      return false;
    }

    // SEC-03: 各チャンネルの stddev を取得し NaN/Infinity 防御
    // SEC-03: Extract stddev from each channel with NaN/Infinity defense
    const stddevValues = channels.map((c) => c.stdev);
    if (stddevValues.some((v) => !Number.isFinite(v))) {
      return false; // SEC-03: 不正な統計値は blank とみなさない / Invalid stats not considered blank
    }

    // SEC-04: 各チャンネルの mean を取得し NaN/Infinity 防御
    // SEC-04: Extract mean from each channel with NaN/Infinity defense
    const meanValues = channels.map((c) => c.mean);
    if (meanValues.some((v) => !Number.isFinite(v))) {
      return false; // SEC-04: 不正な統計値は blank とみなさない / Invalid stats not considered blank
    }

    // MEDIUM-3: Number.isFinite() + 範囲クランプ (0.0-255.0)
    // MEDIUM-3: Number.isFinite() + range clamp (0.0-255.0)
    const clampedStddevValues = stddevValues.map((v) => Math.max(0, Math.min(255, v)));
    const clampedMeanValues = meanValues.map((v) => Math.max(0, Math.min(255, v)));

    const avgStddev = clampedStddevValues.reduce((a, b) => a + b, 0) / clampedStddevValues.length;
    const avgMean = clampedMeanValues.reduce((a, b) => a + b, 0) / clampedMeanValues.length;

    // SEC-03: 平均 stddev/mean の最終防御チェック / Final defense check on average stddev/mean
    if (!Number.isFinite(avgStddev) || !Number.isFinite(avgMean)) {
      return false;
    }

    // v0.1.10: 2条件判定 - stddev が低い かつ 輝度が極端（近白色 or 近黒色）の場合のみ blank
    // v0.1.10: Dual condition - blank only when low stddev AND extreme luminance (near-white or near-black)
    // ダークテーマサイト（mean ~30-50, stddev < 5）は blank にならない
    // Dark-themed sites (mean ~30-50, stddev < 5) will NOT be flagged as blank
    const isLowVariance = avgStddev < stddevThreshold;
    const isExtremeLuminance = avgMean > MEAN_UPPER_THRESHOLD || avgMean < MEAN_LOWER_THRESHOLD;

    return isLowVariance && isExtremeLuminance;
  } catch {
    // Graceful Degradation: Sharp エラー時は blank とみなさない
    // Graceful Degradation: Sharp errors are not considered blank
    return false;
  }
}
