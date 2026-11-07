// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part paint-order rescue (VR-M-01)
 *
 * 描画確認（画素の比較）は、カード画像に重なる半透明のグラデーションや短い見出しでも不一致になる。
 * そうした候補を、Chromium の DOMSnapshot が返す重なり順（paint order）で見直し、上に描かれるのが
 * 半透明の層・少しの文字・自分の子孫だけなら残す。不透明な層（画像・背景色・ダイアログ）や
 * 画面の大半を覆う固定の幕（モーダルの背景）の下にあるものは残さない。
 *
 * The pixel paint check fails for card images under a translucent gradient or a short caption.
 * Those candidates are re-examined with the paint order Chromium's DOMSnapshot reports: a
 * candidate is kept when everything painted above it is translucent, a little text or its own
 * subtree. Candidates under opaque layers (images, backgrounds, dialogs) or a fixed scrim over
 * most of the viewport (a modal backdrop) stay dropped.
 *
 * スナップショットの文字列はページ由来なので、構造・型・大きさを検証してから使う。
 * Snapshot strings come from the page, so the structure, types and sizes are validated first.
 *
 * @module services/part/part-paint-order
 */

import type { CDPSession, Page } from "playwright";
import { logger } from "../../utils/logger";
import { PART_PID_ATTR, readPartPid } from "../../utils/part-pid";
import type { PartGeometryMap } from "./part-live-geometry";

/** スナップショットで読む computed style（順番が配列の添字になる）/ Styles read, in index order */
export const PART_PAINT_ORDER_STYLES = [
  "opacity",
  "background-color",
  "background-image",
  "position",
  "visibility",
] as const;
const S_OPACITY = 0;
const S_BG_COLOR = 1;
const S_BG_IMAGE = 2;
const S_POSITION = 3;
const S_VISIBILITY = 4;

/** スナップショット取得の上限（ms）。超えたら救済しない / Snapshot timeout; no rescue past it */
export const PART_PAINT_ORDER_TIMEOUT_MS = 3_000;

/** 読むレイアウト要素の上限（超えたら救済しない）/ Max layout objects read (else no rescue) */
export const PART_PAINT_ORDER_MAX_LAYOUT_NODES = 100_000;

/** 不透明な層が覆ってよい割合の上限 / Max share of the box covered by opaque layers */
export const PART_RESCUE_MAX_OPAQUE = 0.15;

/** 他人の文字が覆ってよい割合の上限 / Max share of the box covered by other text */
export const PART_RESCUE_MAX_TEXT = 0.6;

/** これ未満の不透明度の層は半透明とみなす / Layers below this opacity count as translucent */
const TRANSLUCENT_BELOW = 0.6;

/** これ未満の不透明度の層は描画なしとみなす / Layers below this opacity paint nothing */
const INVISIBLE_BELOW = 0.05;

/** 固定の半透明層がビューポートのこの割合以上を覆えば幕とみなす / Scrim viewport share */
const SCRIM_MIN_VIEWPORT_SHARE = 0.5;

/** 覆われた割合を数える格子の分割数 / Grid resolution for the covered share */
const GRID = 24;

/**
 * 救済の判定でする処理の上限（候補と層の組の確認 + 格子の更新の回数）。超えたら残りの候補は
 * 救済しない（同期処理でイベントループを長く止めない、SEC H-1）。
 * Cap on the rescue's work (candidate × layer checks plus grid updates); past it the remaining
 * candidates are not rescued, so the synchronous loop never blocks the event loop for long.
 */
export const PART_PAINT_ORDER_MAX_WORK = 20_000_000;

/**
 * 解析する背景画像の文字列の長さの上限。超えるものは不透明とみなす（救済しない側）。
 * Max background-image string length parsed; longer ones count as opaque (no rescue).
 */
const MAX_IMAGE_CHARS = 4_096;

/** 締め切りを確かめる間隔（処理の回数）/ How often (in work units) the deadline is checked */
const DEADLINE_CHECK_EVERY = 1 << 16;

const MEDIA_NODES = new Set([
  "IMG",
  "VIDEO",
  "CANVAS",
  "IFRAME",
  "EMBED",
  "OBJECT",
  "svg",
  "path",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "line",
  "image",
  "use",
  "text",
]);

const enum ImageKind {
  None = 0,
  Opaque = 1,
  TranslucentGradient = 2,
}

const enum Cover {
  None = 0,
  Translucent = 1,
  Text = 2,
  Opaque = 3,
}

/**
 * 重なり順のスナップショットを撮る。Chromium 以外・時間切れ・失敗のときは null。
 * `session` を渡すとそれを使い、閉じない。CDP のセッションを閉じると、別のセッションで
 * 止めたアニメーションの描画がずれる（合成スレッドだけが動き出す）ため、止めている間は同じ
 * セッションを使う。
 * Captures the paint-order snapshot; null on non-Chromium pages, timeout or failure. A given
 * `session` is used and left open: detaching any CDP session lets compositor animations paused
 * through another session move again, so the pausing session is reused while paused.
 */
export async function capturePaintOrderSnapshot(
  page: Page,
  timeoutMs: number = PART_PAINT_ORDER_TIMEOUT_MS,
  session?: CDPSession
): Promise<unknown> {
  if (timeoutMs <= 0) return null;
  let owned: CDPSession | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const s = session ?? (owned = await page.context().newCDPSession(page));
    return await Promise.race([
      s.send("DOMSnapshot.captureSnapshot", {
        computedStyles: [...PART_PAINT_ORDER_STYLES],
        includePaintOrder: true,
        includeDOMRects: false,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch (error) {
    logger.info("[PartPaintOrder] Snapshot unavailable; no rescue", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    await owned?.detach().catch(() => undefined);
  }
}

/** 色の不透明度（rgb / rgba / `/ a` 形式 / transparent）/ Alpha of a computed colour */
function colorAlpha(color: string): number {
  if (color === "" || color === "transparent") return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
  if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
  const rgba = /^rgba\(([^)]*)\)$/.exec(color);
  if (rgba) {
    const parts = rgba[1]!.split(",");
    if (parts.length === 4) return Number(parts[3]);
  }
  return 1;
}

/** グラデーションに半透明の色が含まれるか / Whether a gradient has a translucent colour stop */
function gradientIsTranslucent(image: string): boolean {
  if (/\btransparent\b/.test(image)) return true;
  for (const m of image.matchAll(/(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^()]*\)/g)) {
    const a = colorAlpha(m[0]);
    if (Number.isFinite(a) && a < TRANSLUCENT_BELOW) return true;
  }
  return false;
}

const isIntArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => Number.isInteger(x));

interface Parsed {
  strings: string[];
  parent: number[];
  nodeType: number[];
  nodeName: number[];
  attributes: unknown[];
  layoutNode: number[];
  bounds: unknown[];
  paintOrder: number[];
  styles: unknown[];
}

/** スナップショットの主文書を検証して取り出す / Validates and unpacks the main document */
function parse(snapshot: unknown): Parsed | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const root = snapshot as { documents?: unknown; strings?: unknown };
  if (!Array.isArray(root.documents) || root.documents.length === 0) return null;
  if (!Array.isArray(root.strings) || !root.strings.every((x) => typeof x === "string")) {
    return null;
  }
  const doc = root.documents[0] as {
    nodes?: Record<string, unknown>;
    layout?: Record<string, unknown>;
  };
  const nodes = doc?.nodes;
  const layout = doc?.layout;
  if (!nodes || !layout) return null;
  const { parentIndex, nodeType, nodeName, attributes } = nodes;
  const { nodeIndex, bounds, paintOrders, styles } = layout;
  if (!isIntArray(parentIndex) || !isIntArray(nodeType) || !isIntArray(nodeName)) return null;
  if (!Array.isArray(attributes)) return null;
  if (!isIntArray(nodeIndex) || !isIntArray(paintOrders)) return null;
  if (!Array.isArray(bounds) || !Array.isArray(styles)) return null;
  const n = parentIndex.length;
  const l = nodeIndex.length;
  if (nodeType.length !== n || nodeName.length !== n || attributes.length !== n) return null;
  if (bounds.length !== l || paintOrders.length !== l || styles.length !== l) return null;
  if (l > PART_PAINT_ORDER_MAX_LAYOUT_NODES) return null;
  if (!nodeIndex.every((i) => i >= 0 && i < n)) return null;
  if (!parentIndex.every((p, i) => p >= -1 && p < n && p !== i)) return null;
  return {
    strings: root.strings as string[],
    parent: parentIndex,
    nodeType,
    nodeName,
    attributes,
    layoutNode: nodeIndex,
    bounds,
    paintOrder: paintOrders,
    styles,
  };
}

function rect(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length < 4) return null;
  const [x, y, w, h] = v as unknown[];
  if (![x, y, w, h].every((c) => typeof c === "number" && Number.isFinite(c))) return null;
  return [x as number, y as number, w as number, h as number];
}

/**
 * 描画確認で不一致だった候補のうち、重なり順で見て見えているものの pid を返す。
 * Returns the pids, among candidates the paint check rejected, that paint order shows visible.
 */
export function findPaintOrderRescues(
  snapshot: unknown,
  candidates: PartGeometryMap,
  viewport: { width: number; height: number },
  limits: { deadlineAt?: number; now?: () => number; maxWork?: number } = {}
): Set<number> {
  const now = limits.now ?? Date.now;
  const deadlineAt = limits.deadlineAt ?? Number.POSITIVE_INFINITY;
  const maxWork = limits.maxWork ?? PART_PAINT_ORDER_MAX_WORK;
  const out = new Set<number>();
  if (candidates.size === 0) return out;
  const p = parse(snapshot);
  if (!p) return out;
  const str = (i: unknown): string =>
    typeof i === "number" && i >= 0 && i < p.strings.length ? p.strings[i]! : "";
  const style = (li: number, k: number): string => {
    const row = p.styles[li];
    return Array.isArray(row) ? str(row[k]) : "";
  };

  // pid → node, node → first layout object / pid と layout の対応
  const pidNode = new Map<number, number>();
  p.attributes.forEach((attrs, i) => {
    if (!Array.isArray(attrs)) return;
    for (let k = 0; k + 1 < attrs.length; k += 2) {
      if (str(attrs[k]) !== PART_PID_ATTR) continue;
      const v = str(attrs[k + 1]);
      const pid = readPartPid({ getAttribute: () => v });
      if (pid === null) continue;
      // 同じ番号が 2 回現れたら使わない / A pid seen twice is not used
      pidNode.set(pid, pidNode.has(pid) ? -1 : i);
    }
  });
  const layoutOf = new Map<number, number>();
  p.layoutNode.forEach((ni, li) => {
    if (!layoutOf.has(ni)) layoutOf.set(ni, li);
  });

  // 祖先を含めた不透明度（反復で計算、深い木でもスタックを使わない）
  // Effective opacity including ancestors, computed iteratively (no recursion on deep trees)
  const opacity = new Float64Array(p.parent.length).fill(Number.NaN);
  const effectiveOpacity = (node: number): number => {
    const chain: number[] = [];
    let x = node;
    while (x >= 0 && Number.isNaN(opacity[x]!)) {
      chain.push(x);
      x = p.parent[x]!;
      if (chain.length > p.parent.length) return 1;
    }
    let acc = x >= 0 ? opacity[x]! : 1;
    for (let i = chain.length - 1; i >= 0; i--) {
      const n = chain[i]!;
      const li = layoutOf.get(n);
      const own = li === undefined ? 1 : Number(style(li, S_OPACITY) || "1");
      acc *= Number.isFinite(own) ? Math.min(1, Math.max(0, own)) : 1;
      opacity[n] = acc;
    }
    return acc;
  };
  // 子孫の判定を O(1) にする: 木を 1 回たどって入る順・出る順の番号を振る（循環は無視）
  // O(1) subtree test: number nodes on entry/exit in one iterative walk (cycles never reached)
  const n = p.parent.length;
  const firstChild = new Int32Array(n).fill(-1);
  const nextSibling = new Int32Array(n).fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    const parent = p.parent[i]!;
    if (parent < 0) continue;
    nextSibling[i] = firstChild[parent]!;
    firstChild[parent] = i;
  }
  const enter = new Int32Array(n).fill(-1);
  const exit = new Int32Array(n).fill(-1);
  let clock = 0;
  const stack: number[] = [];
  for (let root = 0; root < n; root++) {
    if (p.parent[root] !== -1) continue;
    stack.push(root);
    while (stack.length > 0) {
      const x = stack[stack.length - 1]!;
      if (enter[x] === -1) {
        enter[x] = clock++;
        for (let c = firstChild[x]!; c >= 0; c = nextSibling[c]!) {
          if (enter[c] === -1) stack.push(c);
        }
      } else {
        stack.pop();
        if (exit[x] === -1) exit[x] = clock++;
      }
    }
  }
  const isWithin = (node: number, ancestor: number): boolean =>
    enter[ancestor]! >= 0 &&
    enter[node]! >= enter[ancestor]! &&
    exit[node]! >= 0 &&
    exit[node]! <= exit[ancestor]!;

  // 背景画像の判定は文字列ごとに 1 回だけ（同じ文字列を多くの層が共有しうる、SEC M-3）
  // Judge each background-image string once: many layers can share one string (SEC M-3)
  const imageKinds = new Map<number, ImageKind>();
  const imageKindOf = (li: number): ImageKind => {
    const row = p.styles[li];
    const id = Array.isArray(row) ? row[S_BG_IMAGE] : undefined;
    if (typeof id !== "number" || id < 0 || id >= p.strings.length) return ImageKind.None;
    let kind = imageKinds.get(id);
    if (kind === undefined) {
      const image = p.strings[id]!;
      if (image === "" || image === "none") kind = ImageKind.None;
      else if (image.length > MAX_IMAGE_CHARS || !/gradient\(/.test(image)) kind = ImageKind.Opaque;
      else kind = gradientIsTranslucent(image) ? ImageKind.TranslucentGradient : ImageKind.Opaque;
      imageKinds.set(id, kind);
    }
    return kind;
  };
  const classify = (li: number, node: number, area: number): Cover => {
    if (style(li, S_VISIBILITY) === "hidden" || style(li, S_VISIBILITY) === "collapse") {
      return Cover.None;
    }
    if (p.nodeType[node] === 3) {
      const o = effectiveOpacity(p.parent[node]!);
      if (o < INVISIBLE_BELOW) return Cover.None;
      return o < TRANSLUCENT_BELOW ? Cover.Translucent : Cover.Text;
    }
    const o = effectiveOpacity(node);
    if (o < INVISIBLE_BELOW) return Cover.None;
    const name = str(p.nodeName[node]);
    const imageKind = imageKindOf(li);
    let c: Cover;
    if (MEDIA_NODES.has(name) || imageKind === ImageKind.Opaque) {
      c = o < TRANSLUCENT_BELOW ? Cover.Translucent : Cover.Opaque;
    } else if (imageKind === ImageKind.TranslucentGradient) {
      c = Cover.Translucent;
    } else {
      const a = colorAlpha(style(li, S_BG_COLOR));
      if (!(a > INVISIBLE_BELOW)) return Cover.None; // 自分は何も描かない / paints nothing itself
      c = a * o < TRANSLUCENT_BELOW ? Cover.Translucent : Cover.Opaque;
    }
    // 画面の大半を覆う固定の半透明層はモーダルの幕 / A fixed translucent layer is a modal scrim
    if (
      c === Cover.Translucent &&
      style(li, S_POSITION) === "fixed" &&
      area >= SCRIM_MIN_VIEWPORT_SHARE * viewport.width * viewport.height
    ) {
      c = Cover.Opaque;
    }
    return c;
  };

  // 層ごとの分類は 1 回だけ計算する / Classify each layer once
  const coverOf = new Int8Array(p.layoutNode.length).fill(-1);
  const coverAt = (li: number, node: number, area: number): Cover => {
    let c = coverOf[li]!;
    if (c < 0) {
      c = classify(li, node, area);
      coverOf[li] = c;
    }
    return c as Cover;
  };

  const total = GRID * GRID;
  const opaqueLimit = Math.ceil(PART_RESCUE_MAX_OPAQUE * total);
  const textLimit = Math.ceil(PART_RESCUE_MAX_TEXT * total);
  const cells = new Uint8Array(total);
  let work = 0;
  let nextCheck = DEADLINE_CHECK_EVERY;
  // 上限か締め切りに達したら、残りの候補は救済しない（救済しない側に倒す）
  // On the cap or the deadline, stop and rescue none of the remaining candidates
  const outOfTime = (): boolean => {
    if (work > maxWork) return true;
    if (work >= nextCheck) {
      nextCheck = work + DEADLINE_CHECK_EVERY;
      if (now() >= deadlineAt) return true;
    }
    return false;
  };
  if (now() >= deadlineAt) return out;

  candidateLoop: for (const [pid, g] of candidates) {
    const node = pidNode.get(pid);
    if (node === undefined || node < 0) continue;
    const own = layoutOf.get(node);
    if (own === undefined || g.width <= 0 || g.height <= 0) continue;
    const order = p.paintOrder[own]!;
    cells.fill(Cover.None);
    let opaque = 0;
    let text = 0;
    for (let li = 0; li < p.layoutNode.length; li++) {
      work++;
      if (outOfTime()) break candidateLoop;
      if (p.paintOrder[li]! <= order) continue;
      const b = rect(p.bounds[li]);
      if (!b) continue;
      const [bx, by, bw, bh] = b;
      if (bw <= 0 || bh <= 0) continue;
      if (bx >= g.x + g.width || by >= g.y + g.height || bx + bw <= g.x || by + bh <= g.y) continue;
      const cn = p.layoutNode[li]!;
      if (isWithin(cn, node)) continue; // 自分の子孫 / own subtree
      const c = coverAt(li, cn, bw * bh);
      if (c === Cover.None) continue;
      work += total;
      for (let yy = 0; yy < GRID; yy++) {
        const py = g.y + ((yy + 0.5) * g.height) / GRID;
        if (py < by || py >= by + bh) continue;
        for (let xx = 0; xx < GRID; xx++) {
          const px = g.x + ((xx + 0.5) * g.width) / GRID;
          if (px < bx || px >= bx + bw) continue;
          const k = yy * GRID + xx;
          const prev = cells[k]!;
          if (c <= prev) continue;
          cells[k] = c;
          if (prev === Cover.Opaque) opaque--;
          else if (prev === Cover.Text) text--;
          if (c === Cover.Opaque) opaque++;
          else if (c === Cover.Text) text++;
        }
      }
      // 不透明の上限に達したらこの候補は救済しない（不透明は下がらない）
      // Opaque cells never go back down, so stop once the opaque limit is reached
      if (opaque >= opaqueLimit) continue candidateLoop;
    }
    if (opaque < opaqueLimit && text < textLimit) out.add(pid);
  }
  return out;
}
