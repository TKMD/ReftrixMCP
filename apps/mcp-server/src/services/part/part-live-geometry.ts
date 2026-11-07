// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part live geometry (VR-M-01)
 *
 * 取り込み時（Phase 0）に、実際に描画されたページの要素へ番号（`data-reftrix-pid`）を振り、
 * フルページのスクリーンショットを撮る直前に、パーツ候補の位置・表示状態・computed style を測る。
 * 番号付きの HTML はパーツ抽出だけが使い、保存・ハッシュ・埋め込みに渡す HTML からは外す。
 *
 * At ingest (Phase 0) each element of the rendered page gets a `data-reftrix-pid`, and right
 * before the full-page screenshot the position, visibility and computed styles of every part
 * candidate are measured. Only part extraction sees the numbered HTML; every persisted, hashed or
 * embedded string has the attribute removed.
 *
 * ページ由来の値は信用しない。`page.evaluate` はページの JavaScript 環境で動き、プロトタイプは
 * 差し替えられうるため、Node 側で型・範囲・許可キーを検証し直す。
 * Values returned by the page are untrusted (the evaluate runs in the page's realm), so they are
 * re-validated in Node.
 *
 * @module services/part/part-live-geometry
 */

import type { CDPSession, Page } from "playwright";
import { PART_COMPUTED_STYLE_KEYS, PART_COMPUTED_STYLE_MAX_CHARS } from "./types";
import { identifyPartTypeFromAttrs } from "./part-extraction.service";
import { logger } from "../../utils/logger";
import sharp from "../../utils/sharp-safe";
import { PART_PID_ATTR, duplicatePartPids, readPartPid, stripPartPids } from "../../utils/part-pid";
import {
  PART_PAINT_ORDER_MAX_LAYOUT_NODES,
  PART_PAINT_ORDER_TIMEOUT_MS,
  capturePaintOrderSnapshot,
  findPaintOrderRescues,
} from "./part-paint-order";

export { PART_PID_ATTR, readPartPid, stripPartPids };

/** 番号を振る要素数の上限（文書順の先頭から）/ Max numbered elements (document order) */
export const PART_PID_MAX_ELEMENTS = 20_000;

/** 1 要素あたりの class 文字列の上限 / Max class-string length returned per element */
const CLASS_MAX_CHARS = 512;

/** 表示とみなす最小の見えている面積の割合 / Min visible-area ratio to count as visible */
export const PART_MIN_VISIBLE_RATIO = 0.5;

/** スクリーンショット前後で位置がずれてよい上限（px）/ Max drift across the screenshot (px) */
export const PART_GEOMETRY_STABLE_TOLERANCE_PX = 2;

/** 座標の上限（巨大値の拒否）/ Coordinate magnitude ceiling */
const MAX_COORD = 1_000_000;

/** 文書座標の位置と、測れたときの computed style / Document-coordinate rect and styles */
export interface PartLiveGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  styles?: Record<string, string>;
}

/** pid → 位置 / pid → geometry (only visible, stable candidates) */
export type PartGeometryMap = Map<number, PartLiveGeometry>;

/** 番号を振ったときに返る要素の識別情報 / Identity returned for each numbered element */
export interface NumberedElementMeta {
  pid: number;
  tagName: string;
  classAttr: string | null;
  role: string | null;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Node-side re-validation of the styles a page returned. The browser-side cut runs in the page's
 * own JavaScript realm, where `getComputedStyle` / `String.prototype.slice` can be replaced, so
 * it is only a first filter (SEC M-1): keep allow-listed keys with string values, drop NUL,
 * cut to `PART_COMPUTED_STYLE_MAX_CHARS` and remove a surrogate half left by the cut.
 * Returns undefined when nothing valid remains.
 *
 * ページが返した styles を Node 側で検証し直す（ブラウザ内の切り詰めはページに差し替えられうる）。
 */
export function sanitizePartComputedStyles(raw: unknown): Record<string, string> | undefined {
  if (Object.prototype.toString.call(raw) !== "[object Object]") return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of PART_COMPUTED_STYLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const v = src[key];
    if (typeof v !== "string") continue;
    const clean = v
      .slice(0, PART_COMPUTED_STYLE_MAX_CHARS * 2)
      .split("\u0000")
      .join("")
      .slice(0, PART_COMPUTED_STYLE_MAX_CHARS)
      .replace(LONE_SURROGATE, "");
    if (clean.length > 0) out[key] = clean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isFiniteCoord(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
}

/**
 * ページ内の要素に文書順で番号を振り、各要素のタグ名・class・role を返す。
 * 既存の同名属性（ページが仕込んだもの）は先に全部外す。
 * Numbers elements in document order and returns tag / class / role per element. Any attribute
 * of the same name already in the page is removed first.
 */
export async function assignPartPids(
  page: Page,
  maxElements: number = PART_PID_MAX_ELEMENTS
): Promise<NumberedElementMeta[]> {
  const raw: unknown = await page.evaluate(
    (args: { attr: string; cap: number; classMax: number }) => {
      document.querySelectorAll("[" + args.attr + "]").forEach((e) => {
        e.removeAttribute(args.attr);
      });
      const out: Array<[string, string | null, string | null]> = [];
      if (!document.body) return out;
      const all = document.body.querySelectorAll("*");
      if (all.length > args.cap) return null;
      const n = all.length;
      for (let i = 0; i < n; i++) {
        const el = all[i] as Element;
        el.setAttribute(args.attr, String(i));
        const cls = el.getAttribute("class");
        out.push([
          el.tagName,
          cls === null ? null : cls.slice(0, args.classMax),
          el.getAttribute("role"),
        ]);
      }
      return out;
    },
    { attr: PART_PID_ATTR, cap: maxElements, classMax: CLASS_MAX_CHARS }
  );
  if (raw === null) {
    throw new Error(`more than ${maxElements} elements; part geometry is skipped for this page`);
  }
  if (!Array.isArray(raw)) return [];
  const limit = Math.min(raw.length, maxElements);
  const metas: NumberedElementMeta[] = [];
  for (let i = 0; i < limit; i++) {
    const entry: unknown = raw[i];
    if (!Array.isArray(entry) || entry.length !== 3) continue;
    const [tag, cls, role] = entry as unknown[];
    if (typeof tag !== "string" || tag.length === 0 || tag.length > 64) continue;
    metas.push({
      pid: i,
      tagName: tag,
      classAttr: typeof cls === "string" ? cls.slice(0, CLASS_MAX_CHARS) : null,
      role: typeof role === "string" ? role.slice(0, 64) : null,
    });
  }
  return metas;
}

/** ブラウザから返る 1 要素分の生データ / Raw per-element row returned by the browser */
type RawGeometryRow = [number, number, number, number, number, unknown];

/**
 * 指定した番号の要素の位置を測る。大きさが 0、非表示（visibility / opacity / content-visibility）、
 * 文書の外、overflow で半分以上隠れている要素は返さない。`withStyles` のときは computed style も返す。
 * Measures the listed elements. Zero-size, hidden, out-of-document and mostly overflow-clipped
 * elements are not returned. With `withStyles` the computed styles come back as well.
 */
export async function measurePartGeometry(
  page: Page,
  pids: readonly number[],
  withStyles: boolean
): Promise<PartGeometryMap> {
  const wanted = new Set(pids);
  const raw: unknown = await page.evaluate(
    (args: {
      attr: string;
      pids: number[];
      keys: string[];
      maxChars: number;
      minRatio: number;
    }) => {
      const idx = new Map<string, Element>();
      const dup = new Set<string>();
      document.querySelectorAll("[" + args.attr + "]").forEach((e) => {
        const k = e.getAttribute(args.attr) ?? "";
        if (idx.has(k)) dup.add(k);
        idx.set(k, e);
      });
      const de = document.documentElement;
      const bd = document.body;
      const sx = window.scrollX;
      const sy = window.scrollY;
      const docW = Math.max(de.scrollWidth, bd ? bd.scrollWidth : 0);
      const docH = Math.max(de.scrollHeight, bd ? bd.scrollHeight : 0);
      const clipCache = new Map<Element, DOMRect | null>();
      const out: Array<[number, number, number, number, number, unknown]> = [];
      for (const pid of args.pids) {
        if (dup.has(String(pid))) continue;
        const el = idx.get(String(pid));
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (!(r.width >= 1 && r.height >= 1)) continue;
        const cv = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
        if (
          typeof cv === "function" &&
          !cv.call(el, {
            opacityProperty: true,
            visibilityProperty: true,
            contentVisibilityAuto: true,
          })
        ) {
          continue;
        }
        let l = Math.max(r.left, -sx);
        let t = Math.max(r.top, -sy);
        let rt = Math.min(r.right, docW - sx);
        let b = Math.min(r.bottom, docH - sy);
        for (let p = el.parentElement; p && p !== bd && p !== de; p = p.parentElement) {
          let clip = clipCache.get(p);
          if (clip === undefined) {
            const ps = getComputedStyle(p);
            clip =
              ps.overflowX !== "visible" || ps.overflowY !== "visible"
                ? p.getBoundingClientRect()
                : null;
            clipCache.set(p, clip);
          }
          if (clip) {
            l = Math.max(l, clip.left);
            t = Math.max(t, clip.top);
            rt = Math.min(rt, clip.right);
            b = Math.min(b, clip.bottom);
          }
        }
        const visibleArea = Math.max(0, rt - l) * Math.max(0, b - t);
        if (visibleArea < args.minRatio * r.width * r.height) continue;
        let styles: unknown = null;
        if (args.keys.length > 0) {
          const cs = getComputedStyle(el);
          const s: Record<string, string> = {};
          for (const k of args.keys) {
            const v = cs.getPropertyValue(k);
            if (v) s[k] = v.slice(0, args.maxChars);
          }
          styles = s;
        }
        out.push([pid, r.left + sx, r.top + sy, r.width, r.height, styles]);
      }
      return out;
    },
    {
      attr: PART_PID_ATTR,
      pids: [...wanted],
      keys: withStyles ? [...PART_COMPUTED_STYLE_KEYS] : [],
      maxChars: PART_COMPUTED_STYLE_MAX_CHARS,
      minRatio: PART_MIN_VISIBLE_RATIO,
    }
  );
  const map: PartGeometryMap = new Map();
  if (!Array.isArray(raw)) return map;
  for (const entry of raw as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 6) continue;
    const [pid, x, y, w, h, styles] = entry as RawGeometryRow;
    if (!Number.isInteger(pid) || !wanted.has(pid) || map.has(pid)) continue;
    if (!isFiniteCoord(x) || !isFiniteCoord(y) || !isFiniteCoord(w) || !isFiniteCoord(h)) continue;
    if (w <= 0 || h <= 0) continue;
    const geometry: PartLiveGeometry = { x, y, width: w, height: h };
    const clean = withStyles ? sanitizePartComputedStyles(styles) : undefined;
    if (clean) geometry.styles = clean;
    map.set(pid, geometry);
  }
  return map;
}

/**
 * スクリーンショット前（before）と後（after）の測定を突き合わせ、両方にあり位置と大きさの
 * ずれが許容内の要素だけを残す（スクリーンショットに写った位置と一致するものだけを保存する）。
 * Keeps only elements present in both measurements whose rect moved within tolerance, so stored
 * positions match what the screenshot shows.
 */
export function keepStableGeometry(
  before: PartGeometryMap,
  after: PartGeometryMap,
  tolerancePx: number = PART_GEOMETRY_STABLE_TOLERANCE_PX
): PartGeometryMap {
  const out: PartGeometryMap = new Map();
  for (const [pid, g] of before) {
    const a = after.get(pid);
    if (!a) continue;
    if (
      Math.abs(a.x - g.x) > tolerancePx ||
      Math.abs(a.y - g.y) > tolerancePx ||
      Math.abs(a.width - g.width) > tolerancePx ||
      Math.abs(a.height - g.height) > tolerancePx
    ) {
      continue;
    }
    out.set(pid, g);
  }
  return out;
}

/** 描画確認で一致とみなす画素の割合の下限 / Min share of matching pixels for the paint check */
export const PART_PAINT_MATCH_MIN = 0.8;

/** 描画確認で必要な描画画素の最小数 / Min painted pixels for the paint check */
export const PART_PAINT_MIN_PIXELS = 16;

/**
 * 描画確認にかける時間の上限（ms）。超えたら残りの候補は確認できないので保存しない。
 * Time budget for the paint check (ms); candidates left unchecked when it runs out are dropped.
 */
export const PART_PAINT_CHECK_BUDGET_MS = 15_000;

/** 描画確認のスクリーンショット 1 枚の最小タイムアウト（ms）/ Min timeout per paint-check shot */
const PAINT_MIN_SHOT_TIMEOUT_MS = 1_000;
/**
 * 撮影に使わず重なり順の確認に残す予算の割合と上限（TDA-PPA-M-1 監査 M-1。予算を撮影で使い切ると
 * 確認が締め切りで空になり、半透明だけの一致がページ全体で落ちる）。
 * Share of the budget (capped) kept for the paint-order confirmation instead of shots: if the
 * shots use it all, the confirmation hits its deadline and every translucent-only match drops.
 */
const PAINT_RESCUE_RESERVE_SHARE = 0.1;
const PAINT_RESCUE_RESERVE_MAX_MS = 1_500;

/**
 * 重なり順のスナップショットを撮るノード数（テキストを含む）の上限。レイアウト要素の上限と同じ。
 * Max nodes (text included) for taking the paint-order snapshot; same as the layout-object cap.
 */
export const PART_PAINT_ORDER_MAX_NODES = PART_PAINT_ORDER_MAX_LAYOUT_NODES;

/** アニメーションの再開を待つ上限（ms）/ Max wait for resuming animations (ms) */
export const PART_ANIMATION_RESUME_TIMEOUT_MS = 2_000;

/**
 * 取り込み全体の締め切りの手前に残す余裕（ms）。これを差し引いた残りが描画確認の予算の上限。
 * Margin kept before the ingest deadline; the paint-check budget never runs into it.
 */
export const PART_PAINT_DEADLINE_MARGIN_MS = 10_000;

/**
 * 描画確認の縮小率。縮小すると細い文字や小さなアイコンの画素が消えるので等倍で見る。
 * Scale for the paint check; downscaling erases thin text and small icons, so check at full size.
 */
const PAINT_SCALE = 1;

/** 単色の背景色（2 色で背景が透けているかを見分ける）/ Two solid backdrops */
const PAINT_BACKDROPS = ["#ff00ff", "#00ff00"] as const;

/**
 * 描画として数える画素の不透明度の下限。2 色の背景での差から画素ごとに不透明度を推定する
 * （rgba の文字色や opacity を持つ要素も描画として数える）。
 * Min estimated opacity for a pixel to count as painted; opacity is estimated per pixel from the
 * difference between the two backdrops (so rgba text colours and opacity count as paint).
 */
const PAINT_ALPHA_MIN = 0.5;
/** 1 チャンネルあたりの画素の差の許容 / Per-channel pixel tolerance */
const PAINT_CHANNEL_TOLERANCE = 16;

/** RGB の生画素 / Raw RGB image */
export interface RawRgbImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * 不透明として数える画素の不透明度の下限。これ以上の画素は一致の幅が許容差だけになる（TDA-PPA-M-1）。
 * Min opacity for a pixel to count as solid; such pixels match only within the tolerance.
 */
const PAINT_SOLID_ALPHA_MIN = 0.85;

/** 描画確認の結果 / Result of the paint check for one candidate */
export interface PaintMatch {
  /** 一致した画素の割合 / Share of matching pixels */
  ratio: number;
  /**
   * 半透明の画素だけで判定した。背景が分からず一致の幅が広いので、重なり順で上に不透明な層が
   * 無いことを確かめるまで残さない（TDA-PPA-M-1）。
   * Judged on translucent pixels only: the match range is wide, so keep it only after the paint
   * order shows nothing opaque above it.
   */
  translucent: boolean;
}

/**
 * パーツ自身の描画がスクリーンショットに写っているかを判定する（純関数）。
 * `onA` / `onB` は候補だけを表示し背景を 2 色に替えた描画。2 枚の差から画素ごとに不透明度 α と
 * 背景を除いた色（α を掛けた色）を求め、α が下限以上の画素を候補自身の描画とみなす。実際の背景は
 * 分からないので、スクリーンショット（`shot`）の画素が「その色 + 任意の背景 × (1 − α)」の範囲に
 * 入れば一致とする。不透明な画素が `PART_PAINT_MIN_PIXELS` 以上あればそれだけで割合を求め、
 * 足りなければ半透明の画素も含めて求めて `translucent` を立てる。描画画素が少なすぎるときは null。
 *
 * Decides whether a part's own paint shows in the screenshot (pure). `onA` / `onB` render only
 * the candidates over two solid backdrops; from their difference each pixel gets an opacity α and
 * a premultiplied colour, and pixels with α at or above the minimum count as the candidate's own
 * paint. The real background is unknown, so a `shot` pixel matches when it lies within
 * "premultiplied colour + any background × (1 − α)". With at least `PART_PAINT_MIN_PIXELS` solid
 * pixels the share is taken over them alone; otherwise over all painted pixels with `translucent`
 * set. Returns null when too few painted pixels exist (the candidate paints nothing).
 */
export function paintMatch(
  shot: RawRgbImage,
  onA: RawRgbImage,
  onB: RawRgbImage,
  rect: { x: number; y: number; width: number; height: number }
): PaintMatch | null {
  const w = Math.min(shot.width, onA.width, onB.width);
  const h = Math.min(shot.height, onA.height, onB.height);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(w, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(h, Math.ceil(rect.y + rect.height));
  let painted = 0;
  let match = 0;
  let solid = 0;
  let solidMatch = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ia = (y * onA.width + x) * 3;
      const ib = (y * onB.width + x) * 3;
      const is = (y * shot.width + x) * 3;
      // 背景の差 (A − B) は R: +255, G: −255, B: +255。透ける割合 t = 1 − α
      // Backdrop difference (A − B) is R +255, G −255, B +255; t = 1 − α is the see-through share
      let t = 0;
      for (let k = 0; k < 3; k++) {
        const diff = onA.data[ia + k]! - onB.data[ib + k]!;
        t += (k === 1 ? -diff : diff) / 255;
      }
      t = Math.min(1, Math.max(0, t / 3));
      if (1 - t < PAINT_ALPHA_MIN) continue;
      painted++;
      let ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        const backA = k === 1 ? 0 : 255;
        const backB = 255 - backA;
        // α を掛けた色（2 枚の推定の平均）/ Premultiplied colour (mean of both estimates)
        const pre = (onA.data[ia + k]! - backA * t + onB.data[ib + k]! - backB * t) / 2;
        const s = shot.data[is + k]!;
        ok = s >= pre - PAINT_CHANNEL_TOLERANCE && s <= pre + t * 255 + PAINT_CHANNEL_TOLERANCE;
      }
      if (ok) match++;
      if (1 - t >= PAINT_SOLID_ALPHA_MIN) {
        solid++;
        if (ok) solidMatch++;
      }
    }
  }
  if (painted < PART_PAINT_MIN_PIXELS) return null;
  if (solid >= PART_PAINT_MIN_PIXELS) return { ratio: solidMatch / solid, translucent: false };
  return { ratio: match / painted, translucent: true };
}

/** `paintMatch` の割合だけを返す / The share from `paintMatch` only */
export function paintMatchRatio(
  shot: RawRgbImage,
  onA: RawRgbImage,
  onB: RawRgbImage,
  rect: { x: number; y: number; width: number; height: number }
): number | null {
  return paintMatch(shot, onA, onB, rect)?.ratio ?? null;
}

async function toRawRgb(png: Buffer, scaledWidth: number): Promise<RawRgbImage> {
  const { data, info } = await sharp(png)
    .resize({ width: scaledWidth, kernel: "nearest" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height,
  };
}

/** 背景の確認で見る格子の分割数 / Sample grid for the backdrop check */
const BACKDROP_SAMPLES = 16;
/** 背景色とみなすチャンネルの許容差 / Channel tolerance for a backdrop pixel */
const BACKDROP_TOLERANCE = 24;
/**
 * 候補の外の標本のうち、2 色の背景がそろっていることが必要な割合。候補の子孫は枠の外にも
 * 描かれる（インラインのリンクの中の画像など）ので低めにする。古いフレームなら 2 枚が同じ
 * ページになり、背景がそろう標本は 0 になる。
 * Share of samples outside the candidates that must show both backdrops. Kept low because a
 * candidate's subtree can paint outside its box (an image inside an inline link); a stale frame
 * shows the same page in both shots, so no sample shows both backdrops.
 */
const BACKDROP_MIN_SHARE = 0.25;
/** 判定に必要な標本の最小数 / Min samples needed to judge */
const BACKDROP_MIN_SAMPLES = 8;

/**
 * 隔離の 2 枚に、候補の外では 2 色の背景（#ff00ff / #00ff00）が写っているか。古いフレームを
 * 撮ると 2 枚がページのままになり、全候補が一致してしまう（SEC M-2）。その組は使わない。
 * 候補の外の標本が少なすぎて判断できないときは true。
 * Whether both isolated shots show the two backdrops outside the candidates. A stale frame shows
 * the page in both shots, which would make every candidate match (SEC M-2); such a group is not
 * used. Returns true when too few samples lie outside the candidates to judge.
 */
export function isolationShotsValid(
  onA: RawRgbImage,
  onB: RawRgbImage,
  rects: ReadonlyArray<{ x: number; y: number; width: number; height: number }>
): boolean {
  const width = Math.min(onA.width, onB.width);
  const height = Math.min(onA.height, onB.height);
  if (width <= 0 || height <= 0) return false;
  const near = (v: number, want: number): boolean => Math.abs(v - want) <= BACKDROP_TOLERANCE;
  let samples = 0;
  let matches = 0;
  for (let sy = 0; sy < BACKDROP_SAMPLES; sy++) {
    const y = Math.floor(((sy + 0.5) * height) / BACKDROP_SAMPLES);
    for (let sx = 0; sx < BACKDROP_SAMPLES; sx++) {
      const x = Math.floor(((sx + 0.5) * width) / BACKDROP_SAMPLES);
      // 候補の近く（はみ出す描画を含む）は見ない / Skip points near a candidate
      if (
        rects.some(
          (r) => x >= r.x - 2 && x < r.x + r.width + 2 && y >= r.y - 2 && y < r.y + r.height + 2
        )
      ) {
        continue;
      }
      samples++;
      const ia = (y * onA.width + x) * 3;
      const ib = (y * onB.width + x) * 3;
      if (
        near(onA.data[ia]!, 255) &&
        near(onA.data[ia + 1]!, 0) &&
        near(onA.data[ia + 2]!, 255) &&
        near(onB.data[ib]!, 0) &&
        near(onB.data[ib + 1]!, 255) &&
        near(onB.data[ib + 2]!, 0)
      ) {
        matches++;
      }
    }
  }
  if (samples < BACKDROP_MIN_SAMPLES) return true;
  return matches >= BACKDROP_MIN_SHARE * samples;
}

const ISO_ATTR = "data-reftrix-iso";

/**
 * 隔離のスタイルを付ける（印の付いた候補とその子孫だけを表示し、背景を単色にする）。描画確認の
 * 間は付けたままにし、組ごとには印だけを付け替える。外すとページ全体が描き直され、大きなページ
 * では次の操作が数十秒待たされるため。スタイルは adoptedStyleSheets で足す（CSP に左右されない）。
 * Installs the isolation style (only marked candidates and their subtrees show, over a solid
 * backdrop). It stays for the whole paint check and only the marks move between groups: removing
 * it repaints the whole page, which makes the next call wait tens of seconds on large pages.
 * The style goes in through adoptedStyleSheets (not subject to the page's CSP).
 */
async function installIsolation(page: Page): Promise<void> {
  await page.evaluate((iso: string) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      // <use> が参照する SVG の symbol は隠さない（参照先のスタイルが複製にも効くため）
      // Never hide SVG symbols: their styles also apply to the copies <use> renders
      "*:not([" +
        iso +
        "]):not([" +
        iso +
        "] *):not(symbol):not(symbol *){visibility:hidden!important}" +
        "[" +
        iso +
        "]{visibility:visible!important}" +
        "*,*::before,*::after{transition:none!important}" +
        "html{background:#ff00ff!important}"
    );
    (window as unknown as { __reftrixIso?: CSSStyleSheet }).__reftrixIso = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, ISO_ATTR);
}

/** 隔離のスタイルと印を必ず外す / Always removes the isolation style and marks */
async function removeIsolation(page: Page): Promise<void> {
  await page.evaluate((iso: string) => {
    const w = window as unknown as { __reftrixIso?: CSSStyleSheet };
    const sheet = w.__reftrixIso;
    if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    delete w.__reftrixIso;
    document.querySelectorAll("[" + iso + "]").forEach((e) => e.removeAttribute(iso));
  }, ISO_ATTR);
}

/**
 * 隔離のもとで、組の候補にだけ印を付け、2 色の背景でスクリーンショットを撮る。フレームは待たない
 * （スクリーンショットが新しいフレームを撮る。requestAnimationFrame の待ちには時間の上限が無い）。
 * Under the isolation, marks only this group's candidates and shoots over the two backdrops. No
 * frame wait: the screenshot captures a fresh frame, and a requestAnimationFrame wait has no
 * timeout.
 */
async function screenshotIsolated(
  page: Page,
  pids: readonly number[],
  fullPage: boolean,
  timeoutMs: number
): Promise<Buffer[]> {
  await page.evaluate(
    (a: { attr: string; iso: string; pids: number[] }) => {
      document.querySelectorAll("[" + a.iso + "]").forEach((e) => e.removeAttribute(a.iso));
      const want = new Set(a.pids.map(String));
      document.querySelectorAll("[" + a.attr + "]").forEach((e) => {
        if (want.has(e.getAttribute(a.attr) ?? "")) e.setAttribute(a.iso, "");
      });
    },
    { attr: PART_PID_ATTR, iso: ISO_ATTR, pids: [...pids] }
  );
  const shots: Buffer[] = [];
  for (const color of PAINT_BACKDROPS) {
    await page.evaluate((c: string) => {
      const sheet = (window as unknown as { __reftrixIso?: CSSStyleSheet }).__reftrixIso;
      const rules = sheet?.cssRules;
      const rule = rules ? (rules[rules.length - 1] as CSSStyleRule | undefined) : undefined;
      rule?.style.setProperty("background", c, "important");
    }, color);
    shots.push(await page.screenshot({ fullPage, type: "png", timeout: timeoutMs }));
  }
  return shots;
}

/**
 * スクリーンショットにパーツ自身の描画が写っている候補だけを残す（覆う層・重なった canvas や
 * 動画・まだ描かれていない要素を外す）。画素が一致しなかった候補のうち、重なり順で見て上に
 * 半透明の層や少しの文字しかないもの（グラデーションや見出しが重なるカード画像など）は残す。
 * Keeps only candidates whose own paint shows in the screenshot (drops parts under overlays,
 * covering canvases or videos, and elements that paint nothing). Candidates whose pixels did not
 * match are kept when paint order shows only translucent layers or a little text above them
 * (e.g. a card image under a gradient and a caption).
 */
export async function keepPaintedGeometry(
  page: Page,
  geometry: PartGeometryMap,
  screenshot: Buffer,
  fullPage: boolean,
  budgetMs: number = PART_PAINT_CHECK_BUDGET_MS,
  now: () => number = Date.now,
  paintOrder?: { snapshot: unknown }
): Promise<PartGeometryMap> {
  if (geometry.size === 0) return geometry;
  const startedAt = now();
  const meta = await sharp(screenshot).metadata();
  const shotWidth = meta.width ?? 0;
  const shotHeight = meta.height ?? 0;
  const dpr: unknown = await page.evaluate(() => window.devicePixelRatio);
  const scale = typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const ratio = scale * PAINT_SCALE;
  const scaledWidth = Math.max(1, Math.round(shotWidth * PAINT_SCALE));
  // スクリーンショットからはみ出す要素は切り抜きが欠けるので外す / Rects cut by the shot are dropped
  const inside: PartGeometryMap = new Map();
  for (const [pid, g] of geometry) {
    if (
      g.x >= 0 &&
      g.y >= 0 &&
      (g.x + g.width) * scale <= shotWidth + 1 &&
      (g.y + g.height) * scale <= shotHeight + 1
    ) {
      inside.set(pid, g);
    }
  }
  const shot = await toRawRgb(screenshot, scaledWidth);
  const out: PartGeometryMap = new Map();
  const mismatched: PartGeometryMap = new Map();
  // 半透明の画素だけで一致した候補（重なり順で確かめるまで残さない）
  // Candidates matched on translucent pixels only (kept only once the paint order confirms them)
  const translucentOnly: PartGeometryMap = new Map();
  // 重なり順は隔離の撮影より前に撮る（隔離を外すと transition が動き出し、止めたアニメーションの
  // もとでは覆いが「非表示」のまま残るため）。撮影前に撮ったものがあればそれを使う。
  // Take the paint-order snapshot before any isolated shot (removing the isolation starts CSS
  // transitions, which stay at their start while animations are paused); prefer one taken
  // before the screenshot.
  const snapshot =
    paintOrder !== undefined
      ? paintOrder.snapshot
      : inside.size > 0
        ? await capturePaintOrderSnapshot(page, Math.min(PART_PAINT_ORDER_TIMEOUT_MS, budgetMs))
        : null;
  // 候補の多い組から確認する（予算切れで内側の小さなパーツが先に落ちないように）
  // Check the largest groups first so a budget cut does not drop the inner, smaller parts first
  const groups = groupDisjointRects(inside).sort((p, q) => q.length - p.length);
  let checkedGroups = 0;
  let staleGroups = 0;
  const reserveMs = Math.min(PAINT_RESCUE_RESERVE_MAX_MS, budgetMs * PAINT_RESCUE_RESERVE_SHARE);
  if (groups.length > 0) await installIsolation(page);
  try {
    for (const group of groups) {
      const left = budgetMs - reserveMs - (now() - startedAt);
      if (left <= 0) break;
      // 2 枚の撮影で残りの予算を分ける。時間切れなら確認済みの組だけで終える（予算を守る）
      // The two shots share the remaining budget; on a timeout stop with the groups checked so far
      let onA: Buffer | undefined;
      let onB: Buffer | undefined;
      try {
        [onA, onB] = await screenshotIsolated(
          page,
          group,
          fullPage,
          Math.max(PAINT_MIN_SHOT_TIMEOUT_MS, left / 2)
        );
      } catch (error) {
        logger.info("[PartLiveGeometry] Paint check stopped early", {
          checkedGroups,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      checkedGroups++;
      const a = await toRawRgb(onA!, scaledWidth);
      const b = await toRawRgb(onB!, scaledWidth);
      const scaled = group.map((pid) => {
        const g = inside.get(pid)!;
        return { x: g.x * ratio, y: g.y * ratio, width: g.width * ratio, height: g.height * ratio };
      });
      if (!isolationShotsValid(a, b, scaled)) {
        // 古いフレーム: この組は確かめられなかったので残さない / Stale frame: keep none of this group
        staleGroups++;
        continue;
      }
      for (const pid of group) {
        const g = inside.get(pid)!;
        const m = paintMatch(shot, a, b, {
          x: g.x * ratio,
          y: g.y * ratio,
          width: g.width * ratio,
          height: g.height * ratio,
        });
        if (m === null) continue;
        if (m.ratio < PART_PAINT_MATCH_MIN) mismatched.set(pid, g);
        else if (m.translucent) translucentOnly.set(pid, g);
        else out.set(pid, g);
      }
    }
  } finally {
    if (groups.length > 0) await removeIsolation(page);
  }
  // 画素が一致しなかった候補と半透明の画素だけで一致した候補を重なり順で確かめる。重なり順が
  // 無いときは半透明だけの一致も残さない（同系色の不透明な覆いと見分けられないため、TDA-PPA-M-1）。
  // Check by paint order both the mismatched candidates and those matched on translucent pixels
  // only; without a paint order the latter are dropped too (a similar-coloured opaque layer
  // cannot be told apart, TDA-PPA-M-1).
  let rescued = 0;
  let translucentConfirmed = 0;
  if ((mismatched.size > 0 || translucentOnly.size > 0) && snapshot !== null) {
    // 半透明だけの一致を先に渡す（処理量の上限で切られるのは後ろの候補）
    // Translucent-only matches go first: the work cap cuts the later candidates
    const ask: PartGeometryMap = new Map([...translucentOnly, ...mismatched]);
    for (const pid of findPaintOrderRescues(snapshot, ask, await viewportOf(page), {
      deadlineAt: startedAt + budgetMs,
      now,
    })) {
      out.set(pid, ask.get(pid)!);
      if (translucentOnly.has(pid)) translucentConfirmed++;
      else rescued++;
    }
  }
  logger.info("[PartLiveGeometry] Paint check", {
    candidates: geometry.size,
    groups: groups.length,
    checkedGroups,
    kept: out.size,
    rescuedByPaintOrder: rescued,
    translucentOnly: translucentOnly.size,
    translucentConfirmed,
    paintOrderSnapshot: snapshot !== null,
    staleGroups,
    durationMs: now() - startedAt,
  });
  return out;
}

/** ビューポートの大きさ（取れなければ 0 × 0）/ Viewport size (0 × 0 when unknown) */
async function viewportOf(page: Page): Promise<{ width: number; height: number }> {
  const v = page.viewportSize();
  if (v) return v;
  const raw: unknown = await page
    .evaluate(() => [window.innerWidth, window.innerHeight])
    .catch(() => null);
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return Array.isArray(raw) && ok(raw[0]) && ok(raw[1])
    ? { width: Math.min(raw[0], MAX_COORD), height: Math.min(raw[1], MAX_COORD) }
    : { width: 0, height: 0 };
}

/**
 * 互いに重ならない矩形の組に分ける（入れ子も重なりとみなす）。同じ組の候補を同時に表示しても、
 * 各候補の矩形には自分の子孫の描画しか入らない。大きい順に、入る最初の組へ入れる。
 * Splits rects into groups with no overlap (nesting counts as overlap), so showing a group at
 * once leaves only each candidate's own subtree inside its rect. Largest first, first fit.
 */
export function groupDisjointRects(geometry: PartGeometryMap): number[][] {
  const items = [...geometry].sort((p, q) => q[1].width * q[1].height - p[1].width * p[1].height);
  const groups: Array<Array<[number, PartLiveGeometry]>> = [];
  const overlaps = (p: PartLiveGeometry, q: PartLiveGeometry): boolean =>
    p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
  for (const item of items) {
    const group = groups.find((gr) => gr.every(([, g]) => !overlaps(g, item[1])));
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups.map((gr) => gr.map(([pid]) => pid));
}

/**
 * 番号を振った要素のうち、パーツ種別に当たるものの番号だけを返す（抽出と同じ判定）。
 * Returns the pids whose tag / class / role identify a part type (same rule as extraction).
 */
export function selectPartCandidatePids(metas: readonly NumberedElementMeta[]): number[] {
  const out: number[] = [];
  for (const m of metas) {
    if (identifyPartTypeFromAttrs(m.tagName, m.classAttr, m.role) !== null) out.push(m.pid);
  }
  return out;
}

/**
 * 取り込み 1 回分の測定。`start` → `page.content()` → `beforeScreenshot` → screenshot →
 * `afterScreenshot` の順に呼ぶ。失敗しても例外は投げず、位置なし（null）で続ける。
 * One ingest's measurement: call start → page.content() → beforeScreenshot → screenshot →
 * afterScreenshot. Never throws; a failure yields null (no geometry) and the ingest continues.
 */
export class PartGeometryCapture {
  private candidates: number[] = [];
  private before: PartGeometryMap | null = null;
  private duplicates = new Set<number>();
  private failed = false;
  private animationSession: CDPSession | null = null;
  private paintOrderSnapshot: unknown = null;

  /** 番号を振り、パーツ候補を決める / Numbers elements and picks part candidates */
  async start(page: Page): Promise<void> {
    try {
      this.candidates = selectPartCandidatePids(await assignPartPids(page));
    } catch (error) {
      this.fail("assign", error);
    }
  }

  /**
   * 番号付きの HTML を受け取り、2 回以上現れる番号を覚える（その要素は使わない）。
   * Takes the numbered HTML and remembers pids that occur more than once (not used).
   */
  noteSerializedHtml(html: string): void {
    this.duplicates = duplicatePartPids(html);
  }

  /**
   * スクリーンショット直前の測定（style 付き）。測定から描画確認が終わるまでアニメーションを止める
   * （撮影中に動く要素や、隔離の撮影の間に入れ替わる表示を減らす）。`release` で再開する。
   * Measurement right before the screenshot. Animations are paused from here until the paint
   * check ends (fewer elements moving during the shot or changing between the isolated shots);
   * `release` resumes them.
   */
  async beforeScreenshot(page: Page): Promise<void> {
    if (this.failed || this.candidates.length === 0) return;
    await this.pauseAnimations(page);
    try {
      this.before = await measurePartGeometry(page, this.candidates, true);
    } catch (error) {
      this.fail("measure-before", error);
      return;
    }
    // 重なり順はスクリーンショットの前に撮る（大きなページでは撮影後の取得がブラウザの後処理を
    // 待って数十秒かかる）。止めたアニメーションと同じセッションを使う。
    // Take the paint order before the screenshot (on large pages a capture after the shot waits
    // tens of seconds behind the browser), through the session that paused the animations.
    // ノード（テキストを含む）が多すぎるページでは撮らない（スナップショットは大きく、時間切れ
    // でも取り消せない）。数えるのは上限まで。
    // Skip pages with too many nodes, text included: the snapshot is large and a timeout cannot
    // cancel it. Counting stops at the limit.
    const count: unknown = await page
      .evaluate((limit: number) => {
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
        let n = 0;
        while (walker.nextNode()) {
          if (++n > limit) break;
        }
        return n;
      }, PART_PAINT_ORDER_MAX_NODES)
      .catch(() => null);
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > PART_PAINT_ORDER_MAX_NODES
    ) {
      return;
    }
    this.paintOrderSnapshot = await capturePaintOrderSnapshot(
      page,
      PART_PAINT_ORDER_TIMEOUT_MS,
      this.animationSession ?? undefined
    );
  }

  /**
   * スクリーンショット直後に測り直し、ずれなかったものだけを返す。fullPage でないときは
   * スクリーンショットに写る範囲（先頭のビューポート）に収まる要素だけを残す。
   * Re-measures after the screenshot and keeps only stable elements; for a viewport-only
   * screenshot keeps only elements inside the first viewport.
   */
  async afterScreenshot(
    page: Page,
    fullPage: boolean,
    viewportHeight: number,
    screenshot?: Buffer,
    deadlineAt?: number
  ): Promise<PartGeometryMap | null> {
    if (this.failed || !this.before) {
      await this.release();
      return null;
    }
    try {
      const after = await measurePartGeometry(page, [...this.before.keys()], false);
      const stable = keepStableGeometry(this.before, after);
      for (const pid of this.duplicates) stable.delete(pid);
      if (!fullPage) {
        for (const [pid, g] of stable) {
          if (g.y < 0 || g.y + g.height > viewportHeight) stable.delete(pid);
        }
      }
      let kept = stable;
      if (screenshot) {
        const budget = Math.min(
          PART_PAINT_CHECK_BUDGET_MS,
          deadlineAt === undefined
            ? PART_PAINT_CHECK_BUDGET_MS
            : deadlineAt - Date.now() - PART_PAINT_DEADLINE_MARGIN_MS
        );
        if (budget <= 0) return this.skip("no time left before the ingest deadline");
        kept = await keepPaintedGeometry(page, stable, screenshot, fullPage, budget, Date.now, {
          snapshot: this.paintOrderSnapshot,
        });
      }
      // 1 件も残らなければ従来の経路に戻す / With nothing kept, fall back to the usual path
      return kept.size > 0 ? kept : this.skip("no part kept");
    } catch (error) {
      this.fail("measure-after", error);
      return null;
    } finally {
      this.paintOrderSnapshot = null;
      await this.release();
    }
  }

  /**
   * 止めたアニメーションを再開する（何度呼んでもよい。撮影が失敗したときも呼ぶ）。
   * Resumes paused animations; idempotent, and also called when the screenshot failed.
   */
  async release(): Promise<void> {
    this.paintOrderSnapshot = null;
    const session = this.animationSession;
    this.animationSession = null;
    if (!session) return;
    let timer: NodeJS.Timeout | undefined;
    let resumed = false;
    try {
      // 大きなページでは再描画を待って数十秒かかることがあるので、待つのは上限まで
      // On large pages this can wait tens of seconds for a repaint, so wait only up to a limit
      resumed = await Promise.race([
        (async (): Promise<boolean> => {
          await session.send("Animation.setPlaybackRate", { playbackRate: 1 });
          await session.send("Animation.disable");
          return true;
        })(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), PART_ANIMATION_RESUME_TIMEOUT_MS);
        }),
      ]);
      if (!resumed) logger.info("[PartLiveGeometry] Resuming animations is still pending");
    } catch (error) {
      logger.warn("[PartLiveGeometry] Could not resume animations", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timer) clearTimeout(timer);
      // 再開を待ちきれなかったときは、閉じる処理も残りの命令を待つので完了を待たない
      // When the resume did not finish, detaching also waits for it, so do not await it
      const detached = session.detach().catch(() => undefined);
      if (resumed) await detached;
    }
  }

  /** CDP でアニメーションの再生速度を 0 にする（Chromium 以外では何もしない）/ Pause via CDP */
  private async pauseAnimations(page: Page): Promise<void> {
    if (this.animationSession) return;
    let session: CDPSession | null = null;
    try {
      session = await page.context().newCDPSession(page);
      await session.send("Animation.enable");
      await session.send("Animation.setPlaybackRate", { playbackRate: 0 });
      this.animationSession = session;
    } catch (error) {
      await session?.detach().catch(() => undefined);
      logger.info("[PartLiveGeometry] Animations not paused", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private skip(reason: string): null {
    logger.info("[PartLiveGeometry] Using the usual part path for this page", { reason });
    return null;
  }

  private fail(step: string, error: unknown): void {
    this.failed = true;
    logger.warn("[PartLiveGeometry] Measurement failed; continuing without part geometry", {
      step,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 機能フラグ `PART_LIVE_GEOMETRY_ENABLED`（既定は無効、`"true"` のときだけ有効）。
 * Feature flag `PART_LIVE_GEOMETRY_ENABLED` (off by default; on only for `"true"`).
 */
export function isPartLiveGeometryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["PART_LIVE_GEOMETRY_ENABLED"] === "true";
}
