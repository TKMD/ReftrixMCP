// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.verify_reproduction: orchestration (read-only on the stored data).
 * design.verify_reproduction: 参照セクションの読み取り（read-only）と比較の組み立て。
 *
 * - Reference: `section_patterns` / `component_parts` / `section_embeddings`, and (when it still
 *   exists) the persisted full-page screenshot. A missing screenshot is NOT an error: the pixel
 *   comparison is skipped (`coverage.pixel = "unavailable"`) and everything else still runs.
 * - Nothing is written: no screenshot, crop or cache file is created (INV-CROP-NO-WRITE-001).
 * - PII symmetry: sections whose visual embedding was intentionally not generated for PII
 *   (high-PII parts / `section_visual_pii_excluded`) skip the pixel and visual comparison, using the
 *   same SSOT as the embedding pipeline (`getHighPiiSectionIds`, `EMBEDDING_SECTION_VISUAL_SKIP_REASONS`).
 *
 * @module services/design/reproduction-verify.service
 */

import fs from "node:fs/promises";
import pixelmatch from "pixelmatch";
import sharp from "../../utils/sharp-safe";
import { dinov2Semaphore, type VerifyDinov2 } from "./resident-dinov2";
import { clampBboxToImage } from "../../utils/bbox-clipping";
import { logger } from "../../utils/logger";
import { getHighPiiSectionIds } from "../section-detail.service";
import { validateScreenshotPath } from "../screenshot-persistence.service";
import { EMBEDDING_SECTION_VISUAL_SKIP_REASONS } from "../../workers/phases/types";
import {
  MAX_RENDER_HEIGHT_PX,
  MAX_RENDER_WIDTH_PX,
  MIN_RENDER_WIDTH_PX,
  renderCandidate,
  type RenderInput,
  type RenderResult,
} from "./reproduction-render.service";
import {
  PIXEL_MASK_PART_TYPES,
  SCORE_WEIGHTS,
  STYLE_KEYS,
  combineOverall,
  compareParts,
  type CompareResult,
  type ReferencePart,
  type Rect,
} from "./reproduction-scoring";

/** Default reference width when no screenshot tells us the capture viewport. */
export const DEFAULT_REFERENCE_WIDTH_PX = 1920;
/** pixelmatch per-pixel colour threshold. */
export const PIXELMATCH_THRESHOLD = 0.1;
/** Longest edge of the optional diff heat-map. */
export const DIFF_IMAGE_MAX_WIDTH_PX = 256;
const MASK_GRAY = 128;
/** The only `vision_skip_reason` that means "intentionally not embedded for PII". */
const PII_SKIP_REASON = "section_visual_pii_excluded";

// Compile-time/SSOT link: the PII marker must remain a member of the embedding skip enum.
if (!(EMBEDDING_SECTION_VISUAL_SKIP_REASONS as readonly string[]).includes(PII_SKIP_REASON)) {
  throw new Error("section_visual_pii_excluded is no longer an embedding skip reason");
}

export type CoverageState = "compared" | "unavailable" | "pii_excluded";
export type VisualBasis = "screenshot" | "stored_embedding";

/**
 * Below this gap between the blank baseline and 1 the reference itself looks blank, so rescaling
 * would divide by ~0: the raw cosine is reported instead.
 */
export const VISUAL_MIN_BASELINE_GAP = 0.02;
const BLANK_EMBEDDING_CACHE_MAX = 16;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Maps a raw DINOv2 cosine onto 0..1 where 0 is "as similar as an empty page" and 1 is identical.
 * Raw cosines between web sections sit in a narrow band (an unrelated page and an empty one both
 * score ~0.19 against a reference on the dev DB), so the raw value does not separate them.
 */
export function rescaleAgainstBlank(raw: number, blank: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (!isBaselineRescalable(blank)) return clamp01(raw);
  return clamp01((raw - blank) / (1 - blank));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** Fallback blank-render cache per deps object when `deps.blankEmbeddingCache` is not given. */
const perDepsBlankCache = new WeakMap<VerifyDeps, Map<string, number[]>>();

/** The empty baseline page could not be rendered: not a DINOv2 failure. */
class BlankRenderError extends Error {
  constructor(cause: unknown) {
    super(`blank baseline render failed: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "BlankRenderError";
  }
}

export function isBaselineRescalable(blank: number): boolean {
  return Number.isFinite(blank) && 1 - blank >= VISUAL_MIN_BASELINE_GAP;
}

export {
  DINOV2_RESIDENT_IDLE_MS,
  createResidentDinov2,
  type ResidentDinov2,
  type VerifyDinov2,
} from "./resident-dinov2";

export interface SectionRow {
  id: string;
  layoutInfo: unknown;
  screenshotPath: string | null;
  visionSkipReason: string | null;
  hasVisionEmbedding: boolean;
}

export interface PartRow {
  partType: string;
  /** null for high-PII parts (never selected from the DB). */
  htmlSnippet: string | null;
  boundingBox: unknown;
  computedStyles: unknown;
  piiRiskLevel: string;
}

export interface VerifyDeps {
  loadSection(patternId: string): Promise<SectionRow | null>;
  loadParts(patternId: string): Promise<PartRow[]>;
  getHighPiiSectionIds(ids: string[]): Promise<Set<string>>;
  visualSimilarity(patternId: string, embedding: number[]): Promise<number | null>;
  /** Returns the PNG bytes, or null when the file / path is gone or fails validation. Read-only. */
  readScreenshot(storagePath: string): Promise<Buffer | null>;
  getDinov2(): VerifyDinov2 | null;
  /**
   * Hands the instance back after one comparison. When absent the instance is disposed per call
   * (tests). Production keeps one resident instance (`createResidentDinov2`).
   */
  releaseDinov2?(dino: VerifyDinov2, broken: boolean): Promise<void>;
  /** Stored-embedding preprocessing (center crop), the same as Phase 5. */
  preprocessForDinov2(png: Buffer): Promise<Buffer>;
  /**
   * Whole-image preprocessing (`fit: "contain"`) used when the reference screenshot crop is
   * available: both sides are embedded fresh, so the center crop's loss of the section's edges does
   * not apply. When absent the stored embedding is the only visual reference.
   */
  preprocessContainForDinov2?(png: Buffer): Promise<Buffer>;
  /**
   * Blank-render embeddings keyed by `basis:WxH`, shared across calls. Production creates one map
   * next to the resident DINOv2 (the deps object itself is rebuilt per call); when absent a
   * per-deps map is used.
   */
  blankEmbeddingCache?: Map<string, number[]>;
  render(input: RenderInput): Promise<RenderResult>;
}

export interface VerifyInput {
  patternId: string;
  html: string;
  css: string;
  maxDiffs: number;
  includeDiffImage: boolean;
  maskImages: boolean;
  /** Leave text content out of the layout/style match (default false). */
  ignoreText?: boolean;
}

/** Reported when `ignoreText` is set: what was and was not left out. */
export const TEXT_IGNORED_NOTE =
  "Text content was left out of the layout/style match (part pairing and text previews). " +
  "Pixel and visual scores still compare the rendered image, so glyphs can still affect them.";

export interface VerifyResult {
  patternId: string;
  /** Present (true) only when the request set `ignore_text`. */
  textIgnored?: true;
  textIgnoredNote?: string;
  scores: {
    pixelMismatchRatio: number | null;
    visualSimilarity: number | null;
    layoutScore: number | null;
    styleScore: number | null;
    overall: number;
  };
  weights: typeof SCORE_WEIGHTS;
  heightDelta: number | null;
  matchedParts: number;
  missingParts: CompareResult["missingParts"];
  extraParts: CompareResult["extraParts"];
  beyondReferenceCap: number;
  diffs: CompareResult["diffs"];
  diffsTruncated: boolean;
  blockedRequests: { count: number };
  coverage: {
    referenceParts: "complete" | "partial" | "none";
    stylesCompared: number;
    pixel: CoverageState;
    pixelReason?: string;
    visual: CoverageState;
    visualReason?: string;
    /** What the candidate was compared with: the screenshot crop, or the stored section embedding. */
    visualBasis?: VisualBasis;
    /** Raw cosine between the reference and an empty render of the same size (the score's zero). */
    visualBlankBaseline?: number;
    /**
     * false when the reference itself looks blank (baseline within `VISUAL_MIN_BASELINE_GAP` of 1):
     * `visualSimilarity` is then the raw cosine, not the rescaled score.
     */
    visualRescaled?: boolean;
    /** Reference parts with a stored position; the rest are matched by type and text only. */
    referencePartsWithPosition: number;
    referencePartsTotal: number;
  };
  diffImage?: { mimeType: "image/png"; width: number; height: number; base64: string };
}

export class VerifyNotFoundError extends Error {
  constructor() {
    super("section pattern not found");
    this.name = "VerifyNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// reference parsing
// ---------------------------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `layout_info.position {startY, height}`; null when absent or non-positive. */
export function readSectionRegion(layoutInfo: unknown): { startY: number; height: number } | null {
  const pos = asObject(asObject(layoutInfo)?.["position"]);
  const startY = num(pos?.["startY"]);
  const height = num(pos?.["height"]);
  if (startY === null || height === null || startY < 0 || height < 1) return null;
  return { startY, height };
}

function readRect(v: unknown): Rect | null {
  const o = asObject(v);
  const x = num(o?.["x"]);
  const y = num(o?.["y"]);
  const width = num(o?.["width"]);
  const height = num(o?.["height"]);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function camelToKebab(k: string): string {
  return k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function readStyles(v: unknown): Record<string, string> {
  const o = asObject(v);
  const out: Record<string, string> = {};
  if (!o) return out;
  const allowed = new Set<string>(STYLE_KEYS);
  for (const [k, val] of Object.entries(o)) {
    const key = camelToKebab(k);
    if (allowed.has(key) && typeof val === "string" && val.length > 0) out[key] = val;
  }
  return out;
}

let templateDoc: Document | null = null;
async function snippetText(html: string): Promise<string> {
  if (templateDoc === null) {
    const { JSDOM } = await import("jsdom"); // scripts never run (runScripts is off by default)
    templateDoc = new JSDOM("").window.document;
  }
  const tpl = templateDoc.createElement("template");
  tpl.innerHTML = html;
  return (tpl.content.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function toReferenceParts(rows: PartRow[]): Promise<ReferencePart[]> {
  const out: ReferencePart[] = [];
  for (const row of rows) {
    const highPii = row.piiRiskLevel === "high";
    const text = !highPii && row.htmlSnippet ? await snippetText(row.htmlSnippet) : null;
    out.push({
      partType: row.partType,
      text,
      rect: readRect(row.boundingBox),
      styles: readStyles(row.computedStyles),
      highPii,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// pixel comparison
// ---------------------------------------------------------------------------

async function toRaw(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function maskRects(buf: Buffer, width: number, height: number, rects: Rect[]): void {
  // Clip to the image and drop empty rects, then paint row by row from a difference array:
  // O(height x rects + width x height) however much the rects overlap (CWE-770). Painting
  // every rect pixel by pixel was O(sum of areas): 2,000 full-size rects took ~16 s.
  const clipped: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.ceil(r.x + r.width));
    const y1 = Math.min(height, Math.ceil(r.y + r.height));
    if (x1 > x0 && y1 > y0) clipped.push({ x0, y0, x1, y1 });
  }
  if (clipped.length === 0) return;
  const delta = new Int32Array(width + 1);
  for (let y = 0; y < height; y++) {
    delta.fill(0);
    let any = false;
    for (const c of clipped) {
      if (y < c.y0 || y >= c.y1) continue;
      delta[c.x0] = (delta[c.x0] ?? 0) + 1;
      delta[c.x1] = (delta[c.x1] ?? 0) - 1;
      any = true;
    }
    if (!any) continue;
    let cover = 0;
    for (let x = 0; x < width; x++) {
      cover += delta[x] ?? 0;
      if (cover > 0) {
        const i = (y * width + x) * 4;
        buf[i] = MASK_GRAY;
        buf[i + 1] = MASK_GRAY;
        buf[i + 2] = MASK_GRAY;
        buf[i + 3] = 255;
      }
    }
  }
}

async function comparePixels(args: {
  refCropPng: Buffer;
  candidatePng: Buffer;
  maskRectsList: Rect[];
  includeDiffImage: boolean;
}): Promise<{ ratio: number; diffImage?: NonNullable<VerifyResult["diffImage"]> }> {
  const ref = await toRaw(args.refCropPng);
  const cand = await toRaw(
    await sharp(args.candidatePng)
      .extract({ left: 0, top: 0, width: ref.width, height: ref.height })
      .png()
      .toBuffer()
  );
  if (cand.width !== ref.width || cand.height !== ref.height) {
    throw new Error("pixel buffers differ in size");
  }
  maskRects(ref.data, ref.width, ref.height, args.maskRectsList);
  maskRects(cand.data, cand.width, cand.height, args.maskRectsList);
  const diff = Buffer.alloc(ref.width * ref.height * 4);
  const count = pixelmatch(ref.data, cand.data, diff, ref.width, ref.height, {
    threshold: PIXELMATCH_THRESHOLD,
    // Only the differing pixels are drawn: no faded copy of the stored screenshot leaves the
    // server in the diff image (data minimisation).
    diffMask: true,
  });
  const total = ref.width * ref.height;
  const ratio = total > 0 ? Math.min(1, Math.max(0, count / total)) : 0;
  if (!args.includeDiffImage) return { ratio };
  const resized = await sharp(diff, { raw: { width: ref.width, height: ref.height, channels: 4 } })
    .resize({ width: Math.min(DIFF_IMAGE_MAX_WIDTH_PX, ref.width) })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    ratio,
    diffImage: {
      mimeType: "image/png",
      width: resized.info.width,
      height: resized.info.height,
      base64: resized.data.toString("base64"),
    },
  };
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

export async function verifyReproduction(
  input: VerifyInput,
  deps: VerifyDeps
): Promise<VerifyResult> {
  const section = await deps.loadSection(input.patternId);
  if (!section) throw new VerifyNotFoundError();

  const [partRows, piiSet] = await Promise.all([
    deps.loadParts(section.id),
    deps.getHighPiiSectionIds([section.id]),
  ]);
  const piiExcluded = piiSet.has(section.id) || section.visionSkipReason === PII_SKIP_REASON;
  const referenceParts = await toReferenceParts(partRows);
  const region = readSectionRegion(section.layoutInfo);

  let pixelState: CoverageState = "unavailable";
  let pixelReason: string | undefined;
  let refCropPng: Buffer | null = null;
  let renderWidth = DEFAULT_REFERENCE_WIDTH_PX;
  let renderHeight = Math.min(region?.height ?? 1080, MAX_RENDER_HEIGHT_PX);

  if (piiExcluded) {
    pixelState = "pii_excluded";
  } else if (region === null) {
    pixelReason = "section_region_unknown";
  } else if (!section.screenshotPath) {
    pixelReason = "screenshot_missing";
  } else {
    const png = await deps.readScreenshot(section.screenshotPath);
    if (png === null) {
      pixelReason = "screenshot_missing";
    } else {
      const meta = await sharp(png).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      // The capture viewport is not stored. Captures use deviceScaleFactor 1, so the PNG width is
      // the viewport width; an implausible width means a scaled capture we cannot compare safely.
      if (w < MIN_RENDER_WIDTH_PX || w > MAX_RENDER_WIDTH_PX) {
        pixelReason = "reference_scale_unsupported";
      } else {
        const clip = clampBboxToImage(
          {
            x: 0,
            y: region.startY,
            width: w,
            height: Math.min(region.height, MAX_RENDER_HEIGHT_PX),
          },
          w,
          h
        );
        // The stored region must lie fully inside the image: a partial overlap would compare a
        // different area while claiming "compared".
        const regionBottom = region.startY + Math.min(region.height, MAX_RENDER_HEIGHT_PX);
        if (clip === null || region.startY < 0 || regionBottom > h) {
          pixelReason = "section_region_out_of_range";
        } else {
          refCropPng = await sharp(png).extract(clip).png().toBuffer();
          renderWidth = w;
          renderHeight = clip.height;
        }
      }
    }
  }

  const rendered = await deps.render({
    html: input.html,
    css: input.css,
    width: renderWidth,
    height: renderHeight,
  });

  // Layout + style (always)
  const compared = compareParts(referenceParts, rendered.parts, input.maxDiffs, {
    ignoreText: input.ignoreText === true,
  });

  // Pixel (advisory)
  let pixelMismatchRatio: number | null = null;
  let diffImage: VerifyResult["diffImage"];
  if (refCropPng !== null) {
    try {
      const masks: Rect[] = [];
      if (input.maskImages) {
        for (const p of referenceParts) {
          if (p.rect && PIXEL_MASK_PART_TYPES.has(p.partType)) masks.push(p.rect);
        }
        for (const p of rendered.parts) {
          if (PIXEL_MASK_PART_TYPES.has(p.partType)) masks.push(p.rect);
        }
      }
      const px = await comparePixels({
        refCropPng,
        candidatePng: rendered.png,
        maskRectsList: masks,
        includeDiffImage: input.includeDiffImage,
      });
      pixelMismatchRatio = px.ratio;
      diffImage = px.diffImage;
      pixelState = "compared";
    } catch (error) {
      logger.warn("[design.verify_reproduction] pixel comparison failed", {
        error: (error as Error).message,
      });
      pixelReason = "pixel_compare_failed";
    }
  }

  // Visual (DINOv2): screenshot crop when available, else the stored section embedding. Both are
  // rescaled against an empty render of the same size.
  let visualState: CoverageState = "unavailable";
  let visualReason: string | undefined;
  let visualSimilarity: number | null = null;
  let visualBasis: VisualBasis | undefined;
  let visualBlankBaseline: number | undefined;
  let visualRescaled: boolean | undefined;
  const preContain = deps.preprocessContainForDinov2?.bind(deps);
  const useScreenshot = refCropPng !== null && preContain !== undefined;
  if (piiExcluded) {
    visualState = "pii_excluded";
  } else if (!useScreenshot && !section.hasVisionEmbedding) {
    visualReason = "reference_embedding_missing";
  } else {
    // The shared DINOv2 semaphore (also taken by design.search_by_image) is held only across
    // get -> initialize -> generateEmbedding x N -> release. The blank-page render (Chromium) and
    // the DB similarity queries run outside it so they never block the other tool (VR-M-04 audit M-1).
    const basis: VisualBasis = useScreenshot ? "screenshot" : "stored_embedding";
    let blankCache = deps.blankEmbeddingCache ?? perDepsBlankCache.get(deps);
    if (blankCache === undefined) {
      blankCache = new Map();
      perDepsBlankCache.set(deps, blankCache);
    }
    const blankKey = `${basis}:${renderWidth}x${renderHeight}`;
    let blankEmbedding: number[] | undefined = blankCache.get(blankKey);
    let blankPng: Buffer | null = null;
    let baselineFailed = false;
    if (blankEmbedding === undefined) {
      try {
        blankPng = (
          await deps.render({ html: "", css: "", width: renderWidth, height: renderHeight })
        ).png;
      } catch (error) {
        baselineFailed = true;
        logger.warn("[design.verify_reproduction] visual comparison failed", {
          error: new BlankRenderError(error).message,
        });
        visualReason = "visual_baseline_failed";
      }
    }
    if (!baselineFailed) {
      const pre =
        useScreenshot && preContain !== undefined
          ? preContain
          : deps.preprocessForDinov2.bind(deps);
      let refEmbedding: number[] | null = null;
      let candidateEmbedding: number[] | null = null;
      const releaseVisual = await dinov2Semaphore.acquire();
      try {
        const dino = deps.getDinov2();
        if (dino === null) {
          visualReason = "visual_service_unavailable";
        } else {
          let broken = false;
          try {
            if (!dino.initialized) await dino.initialize();
            const embed = async (img: Buffer): Promise<number[]> => {
              const emb = await dino.generateEmbedding(await pre(img));
              if (emb.length === 0 || emb.some((v) => !Number.isFinite(v))) {
                throw new Error("invalid embedding (empty / NaN / Infinity)");
              }
              return emb;
            };
            if (useScreenshot && refCropPng !== null) refEmbedding = await embed(refCropPng);
            candidateEmbedding = await embed(rendered.png);
            if (blankEmbedding === undefined && blankPng !== null) {
              blankEmbedding = await embed(blankPng);
              // Bounded: start over when full (render sizes rarely vary that much).
              if (blankCache.size >= BLANK_EMBEDDING_CACHE_MAX) blankCache.clear();
              blankCache.set(blankKey, blankEmbedding);
            }
          } catch (error) {
            broken = true;
            candidateEmbedding = null;
            logger.warn("[design.verify_reproduction] visual comparison failed", {
              error: (error as Error).message,
            });
            visualReason = "visual_compare_failed";
          } finally {
            try {
              if (deps.releaseDinov2) {
                await deps.releaseDinov2(dino, broken);
              } else {
                await dino.dispose();
              }
            } catch (disposeError) {
              logger.warn("[design.verify_reproduction] DINOv2 release failed", {
                error: (disposeError as Error).message,
              });
            }
          }
        }
      } finally {
        releaseVisual();
      }

      if (candidateEmbedding !== null && blankEmbedding !== undefined) {
        try {
          let raw: number | null = null;
          let blank: number | null = null;
          if (useScreenshot && refEmbedding !== null) {
            raw = cosine(refEmbedding, candidateEmbedding);
            blank = cosine(refEmbedding, blankEmbedding);
            visualBasis = "screenshot";
          } else {
            raw = await deps.visualSimilarity(section.id, candidateEmbedding);
            if (raw !== null && Number.isFinite(raw)) {
              blank = await deps.visualSimilarity(section.id, blankEmbedding);
            }
            visualBasis = "stored_embedding";
          }
          if (raw !== null && Number.isFinite(raw) && blank !== null && Number.isFinite(blank)) {
            visualSimilarity = rescaleAgainstBlank(raw, blank);
            visualBlankBaseline = Math.round(blank * 10_000) / 10_000;
            visualRescaled = isBaselineRescalable(blank);
            visualState = "compared";
          } else {
            visualBasis = undefined;
            visualReason = "reference_embedding_missing";
          }
        } catch (error) {
          visualBasis = undefined;
          logger.warn("[design.verify_reproduction] visual comparison failed", {
            error: (error as Error).message,
          });
          visualReason = "visual_compare_failed";
        }
      }
    }
  }

  const overall = combineOverall({
    layout: compared.layoutScore,
    style: compared.styleScore,
    visual: visualSimilarity,
    pixel: pixelMismatchRatio === null ? null : 1 - pixelMismatchRatio,
  });

  const refCoverage: VerifyResult["coverage"]["referenceParts"] =
    compared.referenceParts === 0
      ? "none"
      : compared.referencePartsWithRect === compared.referenceParts
        ? "complete"
        : "partial";

  return {
    patternId: section.id,
    ...(input.ignoreText === true
      ? { textIgnored: true as const, textIgnoredNote: TEXT_IGNORED_NOTE }
      : {}),
    scores: {
      pixelMismatchRatio,
      visualSimilarity,
      layoutScore: compared.layoutScore,
      styleScore: compared.styleScore,
      overall,
    },
    weights: SCORE_WEIGHTS,
    heightDelta:
      region === null
        ? null
        : rendered.contentHeight - Math.min(region.height, MAX_RENDER_HEIGHT_PX),
    matchedParts: compared.matchedParts,
    missingParts: compared.missingParts,
    extraParts: compared.extraParts,
    beyondReferenceCap: compared.beyondReferenceCap,
    diffs: compared.diffs,
    diffsTruncated: compared.diffsTruncated,
    blockedRequests: { count: rendered.blockedRequests },
    coverage: {
      referenceParts: refCoverage,
      stylesCompared: compared.stylesCompared,
      pixel: pixelState,
      ...(pixelReason ? { pixelReason } : {}),
      visual: visualState,
      ...(visualReason ? { visualReason } : {}),
      ...(visualBasis ? { visualBasis } : {}),
      ...(visualBlankBaseline !== undefined ? { visualBlankBaseline } : {}),
      ...(visualRescaled !== undefined ? { visualRescaled } : {}),
      referencePartsWithPosition: compared.referencePartsWithRect,
      referencePartsTotal: compared.referenceParts,
    },
    ...(diffImage ? { diffImage } : {}),
  };
}

// ---------------------------------------------------------------------------
// default (production) dependencies
// ---------------------------------------------------------------------------

export interface VerifyPrisma {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

export interface DefaultDepsOptions {
  releaseDinov2?: (dino: VerifyDinov2, broken: boolean) => Promise<void>;
  preprocessContainForDinov2?: (png: Buffer) => Promise<Buffer>;
  /** Shared across calls (the deps object is rebuilt per call). */
  blankEmbeddingCache?: Map<string, number[]>;
}

/** Production deps over parameterised read-only SQL; the only filesystem call is a validated read. */
export function createDefaultDeps(
  prisma: VerifyPrisma,
  getDinov2: () => VerifyDinov2 | null,
  preprocessForDinov2: (png: Buffer) => Promise<Buffer>,
  options: DefaultDepsOptions = {}
): VerifyDeps {
  const { releaseDinov2, preprocessContainForDinov2, blankEmbeddingCache } = options;
  return {
    async loadSection(patternId): ReturnType<VerifyDeps["loadSection"]> {
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          id: string;
          layout_info: unknown;
          screenshot_storage_path: string | null;
          vision_skip_reason: string | null;
          has_vision: boolean | null;
        }>
      >(
        `SELECT sp.id, sp.layout_info, wp.screenshot_storage_path,
                se.vision_skip_reason, (se.vision_embedding IS NOT NULL) AS has_vision
           FROM section_patterns sp
           JOIN web_pages wp ON wp.id = sp.web_page_id
           LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
          WHERE sp.id = $1::uuid`,
        patternId
      );
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        layoutInfo: r.layout_info,
        screenshotPath: r.screenshot_storage_path,
        visionSkipReason: r.vision_skip_reason,
        hasVisionEmbedding: r.has_vision === true,
      };
    },
    async loadParts(patternId): ReturnType<VerifyDeps["loadParts"]> {
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          part_type: string;
          html_snippet: string | null;
          bounding_box: unknown;
          computed_styles: unknown;
          pii_risk_level: string;
        }>
      >(
        `SELECT part_type,
                CASE WHEN pii_risk_level = 'high' THEN NULL ELSE html_snippet END AS html_snippet,
                bounding_box, computed_styles, pii_risk_level
           FROM component_parts
          WHERE section_pattern_id = $1::uuid
          ORDER BY created_at, id
          LIMIT 1001`,
        patternId
      );
      return rows.map((r) => ({
        partType: r.part_type,
        htmlSnippet: r.html_snippet,
        boundingBox: r.bounding_box,
        computedStyles: r.computed_styles,
        piiRiskLevel: r.pii_risk_level,
      }));
    },
    getHighPiiSectionIds,
    async visualSimilarity(patternId, embedding): ReturnType<VerifyDeps["visualSimilarity"]> {
      const rows = await prisma.$queryRawUnsafe<Array<{ sim: number | null }>>(
        `SELECT 1 - (vision_embedding <=> $1::vector) AS sim
           FROM section_embeddings
          WHERE section_pattern_id = $2::uuid AND vision_embedding IS NOT NULL`,
        `[${embedding.join(",")}]`,
        patternId
      );
      const sim = rows[0]?.sim;
      return typeof sim === "number" ? sim : null;
    },
    async readScreenshot(storagePath): ReturnType<VerifyDeps["readScreenshot"]> {
      const safe = await validateScreenshotPath(storagePath);
      if (safe === null) return null;
      try {
        return await fs.readFile(safe);
      } catch {
        return null;
      }
    },
    getDinov2,
    ...(releaseDinov2 ? { releaseDinov2 } : {}),
    preprocessForDinov2,
    ...(preprocessContainForDinov2 ? { preprocessContainForDinov2 } : {}),
    ...(blankEmbeddingCache ? { blankEmbeddingCache } : {}),
    render: (i) => renderCandidate(i),
  };
}
