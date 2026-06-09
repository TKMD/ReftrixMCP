// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Screenshot truncation detection (leaf module).
 *
 * ADR-0018 Amendment 13 §8.2 / Plan §5.1 / §5.10c (FIND-RE-TDA-L-01a):
 * Extracted as a dedicated leaf module so its cyclomatic complexity is
 * machine-enforced via the `packages/config/eslint/index.js` scoped
 * `complexity:["error",10]` override (the base rule is `complexity:"off"`
 * monorepo-wide, so a helper kept inline in `phase-5-embedding.ts` would NOT be
 * CC-enforced — `url-normalizer.ts` precedent).
 *
 * The visual embedding crop guard (`phase-5-embedding.ts`
 * `processPartVisualEmbeddingLoop` exit #2a / clamp-後 row #2) uses
 * {@link isScreenshotTruncated} to distinguish a part that is off-screen because
 * the persisted fullPage screenshot was **truncated** (viewport-only 1920x1080
 * on WebGL sites) from a part that is **genuinely** structurally off-screen. The
 * former is bounded-retryable (`screenshot_truncated`); the latter stays terminal
 * (`bbox_unresolvable`).
 *
 * @module workers/phases/screenshot-truncation
 */

/**
 * Default margin (px) below which a screenshot is NOT considered truncated even
 * if its height is slightly less than the section/part extent. Guards against
 * mis-classifying a legitimately short fullPage capture (e.g. lazy-loading
 * undelivered tail) as truncated. Plan §5.1 OQ-1: completed pages measure
 * 16955px / 4975px while truncated viewport-only pages measure exactly 1080px,
 * so the 1080 vs 5164+ gap is far wider than 256px.
 */
export const SCREENSHOT_TRUNCATION_MARGIN_PX = 256;

/**
 * Determine whether the persisted screenshot is **truncated** relative to the
 * content extent measured for the current run.
 *
 * A run is truncated when the screenshot's actual pixel height plus a margin is
 * still strictly below the maximum content extent (the lowest `top + height`
 * across the parts/sections needing visual embeddings). This is a run-level,
 * deterministic decision computed ONCE before the crop loop (never per-part).
 *
 * non-positive input returns `false` (not truncated) so a measurement error
 * never spuriously routes parts into the retryable path.
 *
 * @param imgHeight        Actual screenshot pixel height (from `sharp().metadata()`).
 * @param maxContentExtentY Maximum `round(absoluteY) + round(height)` across the
 *   items needing visual embeddings for this run.
 * @param marginPx         Tolerance margin (default {@link SCREENSHOT_TRUNCATION_MARGIN_PX}).
 * @returns `true` iff the screenshot is truncated relative to the content extent.
 */
export function isScreenshotTruncated(
  imgHeight: number,
  maxContentExtentY: number,
  marginPx: number = SCREENSHOT_TRUNCATION_MARGIN_PX
): boolean {
  if (!Number.isFinite(imgHeight) || imgHeight <= 0) return false;
  if (!Number.isFinite(maxContentExtentY) || maxContentExtentY <= 0) return false;
  if (!Number.isFinite(marginPx) || marginPx < 0) return false;
  return imgHeight + marginPx < maxContentExtentY;
}
