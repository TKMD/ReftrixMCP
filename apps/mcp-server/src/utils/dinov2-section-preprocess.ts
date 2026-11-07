// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 input for a section image: the single preprocessing used to make stored section
 * vision embeddings (Phase 5) and anything compared against them (design.verify_reproduction).
 * Center crop (`fit: "cover"`) with a cubic kernel, alpha removed, sRGB, raw RGB bytes.
 * Changing it changes every stored section embedding's meaning: keep both sides on this function.
 *
 * セクション画像の DINOv2 入力。保存済み embedding（Phase 5）とそれと比べる側で同じ前処理を使う。
 *
 * @module utils/dinov2-section-preprocess
 */
import sharp from "./sharp-safe";

export async function preprocessSectionForDinov2(
  image: Buffer,
  inputSize: number
): Promise<Buffer> {
  return sharp(image)
    .resize(inputSize, inputSize, { fit: "cover", kernel: "cubic" })
    .removeAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer();
}

/**
 * Whole-image variant (`fit: "contain"`, white padding) for comparisons where both sides are
 * embedded fresh (design.verify_reproduction with the screenshot crop). Not used for stored
 * embeddings. Measured on the dev DB (8 sections, rescaled against a blank render): the reference
 * scores 1, the stored snippet 0.19, an unrelated section 0.11, an empty page 0.03; with the
 * center crop the last three were 0.06 / 0.05 / 0.
 *
 * 両側をその場で埋め込む比較用（全体を縮小）。保存済み embedding には使わない。
 */
export async function preprocessSectionContainForDinov2(
  image: Buffer,
  inputSize: number
): Promise<Buffer> {
  return sharp(image)
    .resize(inputSize, inputSize, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
      kernel: "cubic",
    })
    .removeAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer();
}
