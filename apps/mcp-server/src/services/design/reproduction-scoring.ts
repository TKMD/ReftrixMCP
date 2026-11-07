// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.verify_reproduction: pure scoring, matching and diff logic (no I/O).
 * design.verify_reproduction: スコアリング・パーツ対応付け・差分抽出（I/O なしの純関数）。
 *
 * Scores are in [0, 1] and mean "closer to the stored section" at 1. The pixel score is
 * advisory only: web fonts and images are blocked in the offline render, so it can only be
 * trusted loosely. Layout and style carry most of the weight.
 * スコアは 0〜1 で 1 が参照に近い。オフライン描画では Web フォント・画像が使えないため、
 * ピクセルスコアは参考値（重みを低くする）。レイアウトとスタイルの重みが大きい。
 *
 * @module services/design/reproduction-scoring
 */

import { DEFAULT_PART_EXTRACTION_CONFIG } from "../part/types";

/**
 * The stored reference keeps at most this many parts per type (DOM order) and drops parts
 * smaller than the minimum size; candidate parts are judged against the same limits.
 */
const REFERENCE_MAX_PARTS_PER_TYPE = DEFAULT_PART_EXTRACTION_CONFIG.maxPartsPerType;
const REFERENCE_MIN_PART_SIZE = DEFAULT_PART_EXTRACTION_CONFIG.minPartSize;

/** Maximum characters of a returned `expected` / `actual` value (candidate values are not reflected in full). */
export const DIFF_VALUE_MAX_CHARS = 128;

function clipValue(v: string): string {
  return v.length > DIFF_VALUE_MAX_CHARS ? v.slice(0, DIFF_VALUE_MAX_CHARS) : v;
}

/** Weights of the overall score (sum = 1). Layout + style = 0.65, pixel is advisory (0.10). */
export const SCORE_WEIGHTS = {
  layout: 0.4,
  style: 0.25,
  visual: 0.25,
  pixel: 0.1,
} as const;

/** Minimum pair score for a candidate element to be matched to a reference part. */
export const MATCH_MIN_SCORE = 0.2;

/** Caps that bound the quadratic matching work (CWE-770). */
export const MAX_REFERENCE_PARTS = 1000;
export const MAX_CANDIDATE_PARTS = 2000;

/** Maximum characters of any returned text preview. */
export const TEXT_PREVIEW_MAX = 40;

/** Part types whose pixels are masked in the advisory pixel comparison (images cannot load offline). */
export const PIXEL_MASK_PART_TYPES: ReadonlySet<string> = new Set([
  "image",
  "icon",
  "video",
  "hero_image",
  "avatar",
]);

/** Fixed computed-style keys that are compared (kebab-case). */
export const STYLE_KEYS = [
  "font-size",
  "font-weight",
  "line-height",
  "font-family",
  "color",
  "background-color",
  "border-radius",
  "padding",
  "margin",
  "gap",
  "text-align",
] as const;

export type Severity = "high" | "medium" | "low";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReferencePart {
  partType: string;
  /** Plain text derived from the stored snippet; null when unavailable (always null for high-PII). */
  text: string | null;
  /** Section-relative rect; null when the stored box is missing / all zero. */
  rect: Rect | null;
  /** kebab-case computed styles (may be empty). */
  styles: Record<string, string>;
  highPii: boolean;
}

export interface CandidatePart {
  partType: string;
  text: string;
  rect: Rect;
  styles: Record<string, string>;
}

export interface PartDiff {
  partType: string;
  textPreview?: string;
  property: string;
  expected: string;
  actual: string;
  severity: Severity;
}

export interface CompareResult {
  matchedParts: number;
  missingParts: Array<{ partType: string; textPreview?: string; rect?: Rect }>;
  extraParts: Array<{ partType: string; rect: Rect }>;
  /**
   * Unmatched candidate parts of a type whose reference already holds the per-type cap: the
   * reference cannot show whether they are extra, so they are neither penalized nor listed.
   */
  beyondReferenceCap: number;
  diffs: PartDiff[];
  diffsTruncated: boolean;
  layoutScore: number | null;
  styleScore: number | null;
  stylesCompared: number;
  referencePartsWithRect: number;
  referenceParts: number;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function textPreview(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_PREVIEW_MAX ? flat.slice(0, TEXT_PREVIEW_MAX) : flat;
}

function hasRect(r: Rect | null): r is Rect {
  return (
    r !== null &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

function iou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function words(s: string): Set<string> {
  return new Set(s.split(" ").filter((w) => w.length > 0));
}

function textSimilarity(refText: string | null, candText: string): number {
  if (refText === null) return 0.5; // unknown (e.g. high-PII): neutral
  const a = normalizeText(refText);
  const b = normalizeText(candText);
  if (a.length === 0 && b.length === 0) return 0.5;
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.6;
  const wa = words(a);
  const wb = words(b);
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const uni = wa.size + wb.size - inter;
  return uni > 0 ? (inter / uni) * 0.8 : 0;
}

/** Neutral text score used when text is left out of the match (same as "unknown"). */
const IGNORED_TEXT_SIMILARITY = 0.5;

function pairScore(ref: ReferencePart, cand: CandidatePart, ignoreText: boolean): number {
  const t = ignoreText ? IGNORED_TEXT_SIMILARITY : textSimilarity(ref.text, cand.text);
  if (hasRect(ref.rect) && hasRect(cand.rect)) {
    return 0.6 * iou(ref.rect, cand.rect) + 0.4 * t;
  }
  return t;
}

// ---------------------------------------------------------------------------
// style value comparison
// ---------------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(v: string): Rgba | null {
  const s = v.trim().toLowerCase();
  const m =
    /^rgba?\(\s*(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d*\.?\d+%?))?\s*\)$/.exec(
      s
    );
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  const h = /^#([0-9a-f]{6})$/.exec(s);
  if (h && h[1] !== undefined) {
    const n = parseInt(h[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

function colorScore(a: Rgba, b: Rgba): number {
  if (a.a === 0 && b.a === 0) return 1;
  const dist =
    Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2) / (255 * Math.sqrt(3));
  return clamp01(1 - dist * 3 - Math.abs(a.a - b.a) * 0.5);
}

function pxValue(v: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v.trim());
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

function numberScore(a: number, b: number): number {
  if (Math.abs(a - b) <= 1) return 1;
  return clamp01(1 - Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1));
}

function normWeight(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (s === "normal") return 400;
  if (s === "bold") return 700;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function firstFamily(v: string): string {
  const first = v.split(",")[0] ?? "";
  return first.replace(/["']/g, "").trim().toLowerCase();
}

function styleKeyScore(key: string, expected: string, actual: string): number {
  const e = expected.trim().toLowerCase().replace(/\s+/g, " ");
  const a = actual.trim().toLowerCase().replace(/\s+/g, " ");
  if (e === a) return 1;
  if (key === "color" || key === "background-color") {
    const ce = parseColor(e);
    const ca = parseColor(a);
    if (ce && ca) return colorScore(ce, ca);
    return 0;
  }
  if (key === "font-family") return firstFamily(e) === firstFamily(a) ? 1 : 0.5;
  if (key === "font-weight") {
    const we = normWeight(e);
    const wa = normWeight(a);
    if (we !== null && wa !== null) return we === wa ? 1 : clamp01(1 - Math.abs(we - wa) / 600);
    return 0;
  }
  const tokensE = e.split(" ");
  const tokensA = a.split(" ");
  if (tokensE.length === tokensA.length) {
    let sum = 0;
    for (let i = 0; i < tokensE.length; i++) {
      const pe = pxValue(tokensE[i] ?? "");
      const pa = pxValue(tokensA[i] ?? "");
      if (pe !== null && pa !== null) sum += numberScore(pe, pa);
      else sum += (tokensE[i] ?? "") === (tokensA[i] ?? "") ? 1 : 0;
    }
    return tokensE.length > 0 ? sum / tokensE.length : 0;
  }
  return 0;
}

function severityOf(score: number, key: string): Severity {
  if (key === "font-family") return "low"; // web fonts are blocked offline: advisory only
  if (score < 0.5) return "high";
  if (score < 0.9) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// matching + comparison
// ---------------------------------------------------------------------------

interface Pair {
  ri: number;
  ci: number;
  score: number;
}

function greedyMatch(refs: ReferencePart[], cands: CandidatePart[], ignoreText: boolean): Pair[] {
  const byType = new Map<string, number[]>();
  cands.forEach((c, ci) => {
    const list = byType.get(c.partType);
    if (list) list.push(ci);
    else byType.set(c.partType, [ci]);
  });
  const all: Pair[] = [];
  refs.forEach((r, ri) => {
    for (const ci of byType.get(r.partType) ?? []) {
      const c = cands[ci];
      if (!c) continue;
      const score = pairScore(r, c, ignoreText);
      if (score >= MATCH_MIN_SCORE) all.push({ ri, ci, score });
    }
  });
  all.sort((a, b) => b.score - a.score || a.ri - b.ri || a.ci - b.ci);
  const usedR = new Set<number>();
  const usedC = new Set<number>();
  const out: Pair[] = [];
  for (const p of all) {
    if (usedR.has(p.ri) || usedC.has(p.ci)) continue;
    usedR.add(p.ri);
    usedC.add(p.ci);
    out.push(p);
  }
  return out.sort((a, b) => a.ri - b.ri);
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function fmtPx(n: number): string {
  return `${Math.round(n * 10) / 10}px`;
}

/** Reference text preview for a diff; none for high-PII parts, unknown text or when text is ignored. */
function previewOf(ref: ReferencePart, ignoreText: boolean): string | undefined {
  return ignoreText || ref.highPii || ref.text === null ? undefined : textPreview(ref.text);
}

function rectDiffs(
  ref: ReferencePart,
  cand: CandidatePart,
  rr: Rect,
  ignoreText: boolean
): PartDiff[] {
  const out: PartDiff[] = [];
  const preview = previewOf(ref, ignoreText);
  const props: Array<{ name: string; e: number; a: number; dim: number }> = [
    { name: "rect.x", e: rr.x, a: cand.rect.x, dim: rr.width },
    { name: "rect.y", e: rr.y, a: cand.rect.y, dim: rr.height },
    { name: "rect.width", e: rr.width, a: cand.rect.width, dim: rr.width },
    { name: "rect.height", e: rr.height, a: cand.rect.height, dim: rr.height },
  ];
  for (const p of props) {
    const delta = Math.abs(p.e - p.a);
    if (delta <= Math.max(4, 0.05 * p.dim)) continue;
    const rel = delta / Math.max(p.dim, 1);
    out.push({
      partType: ref.partType,
      ...(preview ? { textPreview: preview } : {}),
      property: p.name,
      expected: fmtPx(p.e),
      actual: fmtPx(p.a),
      severity: rel > 0.25 ? "high" : rel > 0.1 ? "medium" : "low",
    });
  }
  return out;
}

export interface CompareOptions {
  /**
   * Leave text content out of the match: part pairing, the no-position quality fallback and the
   * reference text previews no longer use text. Layout and style comparisons still run.
   */
  ignoreText?: boolean;
}

export function compareParts(
  refsIn: ReferencePart[],
  candsIn: CandidatePart[],
  maxDiffs: number,
  options: CompareOptions = {}
): CompareResult {
  const ignoreText = options.ignoreText === true;
  const refs = refsIn.slice(0, MAX_REFERENCE_PARTS);
  // Same rule as the reference extraction: drop a part only when BOTH sides are under the
  // minimum (a 120x17 inline link is kept).
  const cands = candsIn
    .filter(
      (c) =>
        !(
          c.rect.width > 0 &&
          c.rect.height > 0 &&
          c.rect.width < REFERENCE_MIN_PART_SIZE &&
          c.rect.height < REFERENCE_MIN_PART_SIZE
        )
    )
    .slice(0, MAX_CANDIDATE_PARTS);
  const pairs = greedyMatch(refs, cands, ignoreText);
  const matchedRef = new Set(pairs.map((p) => p.ri));
  const matchedCand = new Set(pairs.map((p) => p.ci));

  const diffs: PartDiff[] = [];
  let qualitySum = 0;
  let styleSum = 0;
  let stylesCompared = 0;

  for (const p of pairs) {
    const r = refs[p.ri];
    const c = cands[p.ci];
    if (!r || !c) continue;
    const rr = hasRect(r.rect) ? r.rect : null;
    if (rr) {
      qualitySum += iou(rr, c.rect);
      diffs.push(...rectDiffs(r, c, rr, ignoreText));
    } else {
      qualitySum +=
        0.5 + 0.5 * (ignoreText ? IGNORED_TEXT_SIMILARITY : textSimilarity(r.text, c.text));
    }
    const preview = previewOf(r, ignoreText);
    for (const key of STYLE_KEYS) {
      const expected = r.styles[key];
      if (expected === undefined || expected === "") continue;
      const actual = c.styles[key] ?? "";
      stylesCompared++;
      const s = styleKeyScore(key, expected, actual);
      styleSum += s;
      if (s < 0.98) {
        diffs.push({
          partType: r.partType,
          ...(preview ? { textPreview: preview } : {}),
          property: key,
          expected: clipValue(expected),
          actual: clipValue(actual),
          severity: severityOf(s, key),
        });
      }
    }
  }

  const missingParts: CompareResult["missingParts"] = [];
  refs.forEach((r, ri) => {
    if (matchedRef.has(ri)) return;
    const preview = previewOf(r, ignoreText);
    missingParts.push({
      partType: r.partType,
      ...(preview ? { textPreview: preview } : {}),
      ...(hasRect(r.rect) ? { rect: r.rect } : {}),
    });
  });
  const refCountByType = new Map<string, number>();
  for (const r of refs) refCountByType.set(r.partType, (refCountByType.get(r.partType) ?? 0) + 1);
  const extraParts: CompareResult["extraParts"] = [];
  let beyondReferenceCap = 0;
  cands.forEach((c, ci) => {
    if (matchedCand.has(ci)) return;
    if ((refCountByType.get(c.partType) ?? 0) >= REFERENCE_MAX_PARTS_PER_TYPE) {
      beyondReferenceCap++;
      return;
    }
    extraParts.push({ partType: c.partType, rect: c.rect });
  });

  diffs.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const cap = Math.max(0, maxDiffs);

  const denom = refs.length + 0.5 * extraParts.length;
  return {
    matchedParts: pairs.length,
    missingParts,
    extraParts,
    beyondReferenceCap,
    diffs: diffs.slice(0, cap),
    diffsTruncated: diffs.length > cap,
    layoutScore: refs.length === 0 ? null : clamp01(qualitySum / denom),
    styleScore: stylesCompared === 0 ? null : clamp01(styleSum / stylesCompared),
    stylesCompared,
    referencePartsWithRect: refs.filter((r) => hasRect(r.rect)).length,
    referenceParts: refs.length,
  };
}

export interface ScoreComponents {
  layout: number | null;
  style: number | null;
  visual: number | null;
  pixel: number | null;
}

/** Weighted mean over the components that are available (weights renormalized). */
export function combineOverall(c: ScoreComponents): number {
  let sum = 0;
  let wsum = 0;
  for (const key of ["layout", "style", "visual", "pixel"] as const) {
    const v = c[key];
    if (v === null) continue;
    sum += SCORE_WEIGHTS[key] * clamp01(v);
    wsum += SCORE_WEIGHTS[key];
  }
  return wsum > 0 ? clamp01(sum / wsum) : 0;
}
