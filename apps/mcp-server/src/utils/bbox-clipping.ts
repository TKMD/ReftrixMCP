// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bounding Box Clipping Utility
 *
 * 画像範囲内に bbox を安全にクリップし、Sharp.extract() に渡せる
 * {left, top, width, height} に正規化するユーティリティ。
 *
 * Clips a bounding box safely to image bounds and normalizes it into
 * {left, top, width, height} suitable for Sharp.extract().
 *
 * ## 背景 / Background
 *
 * v0.4.0 PR7e-1 以前、Part Visual Embedding では bbox の y 方向 (top) が
 * 画像高さを超える場合の clamp が抜けており、Sharp extract_area で
 * "bad extract area" エラーが発生し 7.9% のパーツが失敗していた。
 * また -1 px 余白を取らない boundary crop は `left + width == imgWidth`
 * の edge case で Sharp がエラーを返すことがある。
 *
 * Prior to v0.4.0 PR7e-1, Part Visual Embedding did not clamp bbox.y (top)
 * against image height, causing Sharp.extract_area() "bad extract area"
 * failures for ~7.9% of parts. Edge cases where `left + width == imgWidth`
 * (no 1px margin) also triggered Sharp errors.
 *
 * ## 本ユーティリティの保証 / Guarantees
 *
 * - `left >= 0`, `top >= 0` (負値を 0 にクランプ / clamps negatives to 0)
 * - `left + width <= imgWidth - 1` (右端 1px 余白 / right 1px margin)
 * - `top + height <= imgHeight - 1` (下端 1px 余白 / bottom 1px margin)
 * - `width >= 1 && height >= 1` を満たせない場合は `null` を返す
 *   (returns `null` when the above cannot hold)
 * - `NaN` / `Infinity` を含む入力は `null`
 *   (`NaN` / `Infinity` inputs yield `null`)
 *
 * @module utils/bbox-clipping
 */

/**
 * 入力 bounding box (セクション相対 or 画像絶対座標、どちらでも可)。
 * Input bounding box (either section-relative or absolute image coordinates).
 */
export interface InputBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Sharp.extract() が受け付ける形式にクリップ済みの結果。
 * Clipped result in Sharp.extract()-compatible form.
 */
export interface ClippedBbox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * bbox を画像範囲にクランプし Sharp.extract() 形式に正規化する。
 * Clamp a bbox to the image bounds and normalize to the Sharp.extract() format.
 *
 * - 負の x/y は 0 にクランプ / negative x/y clamp to 0
 * - オーバーフロー width/height は `imgWidth - left - 1` / `imgHeight - top - 1` に制限
 *   (overflow width/height clip to `imgWidth - left - 1` / `imgHeight - top - 1`)
 * - NaN / Infinity / 非数値入力は `null` / non-finite inputs yield `null`
 * - クリップ後に width / height が 1 未満になる場合は `null`
 *   (returns `null` when clipped width / height < 1)
 *
 * @param bbox - 入力 bbox / Input bounding box
 * @param imgWidth - 画像幅 (1 以上) / Image width (must be >= 1)
 * @param imgHeight - 画像高さ (1 以上) / Image height (must be >= 1)
 * @returns Sharp.extract() に渡せる形式、または不正時は null / Sharp-extract form or null
 */
export function clampBboxToImage(
  bbox: InputBbox,
  imgWidth: number,
  imgHeight: number
): ClippedBbox | null {
  // NaN / Infinity ガード / Non-finite guard
  if (
    !Number.isFinite(bbox.x) ||
    !Number.isFinite(bbox.y) ||
    !Number.isFinite(bbox.width) ||
    !Number.isFinite(bbox.height) ||
    !Number.isFinite(imgWidth) ||
    !Number.isFinite(imgHeight)
  ) {
    return null;
  }

  // 画像サイズが 2px 未満なら 1px 余白が取れず crop 不能
  // Cannot reserve 1px margin when image < 2px
  if (imgWidth < 2 || imgHeight < 2) {
    return null;
  }

  const left = Math.max(0, Math.round(bbox.x));
  const top = Math.max(0, Math.round(bbox.y));

  // `imgWidth - left - 1` / `imgHeight - top - 1` により右端・下端に 1px の余白を残す
  // (Sharp が `left + width == imgWidth` の境界値で失敗するケースを回避)
  // Reserve 1px margin on right/bottom edges to avoid Sharp boundary failures
  // where `left + width == imgWidth`.
  const availableWidth = imgWidth - left - 1;
  const availableHeight = imgHeight - top - 1;

  if (availableWidth < 1 || availableHeight < 1) {
    return null;
  }

  const width = Math.min(Math.round(bbox.width), availableWidth);
  const height = Math.min(Math.round(bbox.height), availableHeight);

  if (width < 1 || height < 1) {
    return null;
  }

  return { left, top, width, height };
}
