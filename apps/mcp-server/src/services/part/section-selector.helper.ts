// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Section-selector leaf helpers (apps-only) — W6 Issue A PR-2 (part bbox gate-fix)
 *
 * apps (Playwright/page) 専用の純粋 leaf helper 群。CC ≤ 10 を machine-enforce する
 * ため `packages/config/eslint/index.js` の scoped complexity override に含める。
 *
 * Pure, apps-only leaf helpers (Playwright/`page`-coupled). Included in the
 * `packages/config/eslint/index.js` scoped complexity override so CC ≤ 10 is
 * machine-enforced.
 *
 * 含む / Contains:
 *   - `resolvePartBboxesInScope` — DOM-ancestry containment gate の Node-context SSOT
 *     mirror。`runBboxPageEvaluate` の page.evaluate body が同 semantic を inline
 *     再宣言する (serialize 制約のため import 不可) ので、本 SSOT が unit-test 用の
 *     真実の源泉。両者の semantic 一致は INV-TOLERANCE-NON-GATING-001 で pin。
 *   - `isElementCountDivergent` — population-parity 判定 (F-M-02(A) 同一 selector 基準)。
 *   - `waitForRafSettle` — rAF-race tail dedup util (F-M-05、Playwright `page` 依存)。
 *   - `computeResolveRate` / `assertNoResolveRateRegression` — INV-VISUAL-COVERAGE-FLOOR-001。
 *
 * @module services/part/section-selector.helper
 * @see  §3.2 / §3.3.3 / §3.4 / §4.3
 */

import type { Page } from "playwright";

// ============================================================================
// DOM-like scope contract (Node-context SSOT mirror of the page.evaluate gate)
// ============================================================================

/** 固定リテラル rect (Node-context テスト用、browser `DOMRect` の最小 subset)。 */
export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * `runBboxPageEvaluate` の page.evaluate body が依存する DOM-like scope の最小契約。
 * browser-context では `document` / container 要素がこれを満たす。Node-context テスト
 * では jsdom document を adapter で wrap する。
 *
 * Minimal DOM-like scope contract the page.evaluate gate body depends on. In the
 * browser context `document` / a container element satisfy it; in Node-context
 * tests a jsdom document is wrapped via an adapter.
 */
export interface DomLikeScope {
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): ArrayLike<Element> & Iterable<Element>;
  /** `window.scrollY` 相当 / equivalent of `window.scrollY`. */
  scrollY: number;
}

/** part ごとの selector データ (page.evaluate へ渡る `PartSelectorData` の subset)。 */
export interface PartSelectorInput {
  id: string;
  /** section container を一意特定する DOM selector (未 persist 時 undefined)。 */
  sectionSelector?: string | undefined;
  /** part type/class 由来の CSS selector 候補 (優先度順)。 */
  selectors: string[];
  /** セクションの絶対 Y 開始座標 (garbage の可能性あり、clamp edge 用)。 */
  sectionStartY: number;
  /** 同一 selector 基準での part index (F-M-02(A))。 */
  sampleIndex: number;
}

/** page.evaluate から返る bounding box 結果 (section 相対座標)。 */
export interface BboxResolveResult {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// ============================================================================
// Population-parity (F-M-02(A) — same-selector basis)
// ============================================================================

/**
 * container scope 内の selector-match 要素数 (`liveCount`) が要求 `sampleIndex` を
 * 含み得ない場合に divergent (= `bbox_unresolvable`) と判定する。
 *
 * F-M-02(A): live-count と extraction の `sampleIndex` を **同一 selector 基準**で
 * 突き合わせる。`liveCount <= sampleIndex` のとき、container scope は要求 index 番目の
 * 要素を持たない → silent-wrong pick を避け honest-skip する。
 *
 * Returns true (divergent → bbox_unresolvable) when the container-scope
 * selector-match count cannot contain the requested `sampleIndex`. Same-selector
 * basis (F-M-02(A)): avoids the `identifyPartType`-count ≠ selector-count
 * non-isomorphism, structurally closing silent-wrong picks.
 */
export function isElementCountDivergent(liveCount: number, sampleIndex: number): boolean {
  return liveCount <= sampleIndex;
}

// ============================================================================
// DOM-ancestry containment gate — Node-context SSOT mirror
// ============================================================================

/**
 * DOM-ancestry containment gate の Node-context SSOT。各 part について:
 *   1. `sectionSelector` で container を解決。null → honest-skip (`null`、document
 *      全体 fallback も band 復帰もしない)。
 *   2. container scope 内で selector 候補を順に query し、zero-size を除外しつつ
 *      `sampleIndex` 番目の non-zero 要素を選ぶ (population-parity)。
 *   3. clamp edge (F-M-03(B)): `absoluteY < sectionStartY` のとき
 *      `Math.max(0, absoluteY - sectionStartY)` が 0 にクランプし garbage crop を
 *      生むため、honest-skip (`null`)。
 *
 * The Node-context SSOT for the DOM-ancestry containment gate. The page.evaluate
 * body in `runBboxPageEvaluate` re-declares this same semantic inline (serialize
 * constraint); their equivalence is pinned by INV-TOLERANCE-NON-GATING-001.
 *
 * @param scope - document-like root (browser `document` / jsdom adapter)
 * @param parts - per-part selector inputs
 * @param getRect - element → rect resolver (browser `getBoundingClientRect` /
 *   jsdom fixed-literal stub)
 * @returns input-order-aligned `Array<BboxResolveResult | null>`
 */
export function resolvePartBboxesInScope(
  scope: DomLikeScope,
  parts: PartSelectorInput[],
  getRect: (el: Element) => RectLike
): Array<BboxResolveResult | null> {
  const matched = new Set<Element>();
  return parts.map((part) => resolveSinglePart(scope, part, getRect, matched));
}

/** 単一 part の解決 (CC を thin に保つため抽出)。 */
function resolveSinglePart(
  scope: DomLikeScope,
  part: PartSelectorInput,
  getRect: (el: Element) => RectLike,
  matched: Set<Element>
): BboxResolveResult | null {
  // 1. container 解決 — null は honest-skip (document fallback / band 復帰しない)。
  if (!part.sectionSelector) return null;
  let container: Element | null;
  try {
    container = scope.querySelector(part.sectionSelector);
  } catch {
    return null;
  }
  if (!container) return null;

  // 2. container scope 内で selector 候補を試行。
  for (const selector of part.selectors) {
    const hit = matchInContainer(container, selector, part, getRect, matched, scope.scrollY);
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * 1 つの selector について container scope 内で sampleIndex マッチを試みる。
 * 解決時は `BboxResolveResult`、selector が parse-fail / population-divergent /
 * clamp-edge の場合は `null`、この selector では未確定 (次 selector へ) の場合は
 * `undefined` を返す。
 */
function matchInContainer(
  container: Element,
  selector: string,
  part: PartSelectorInput,
  getRect: (el: Element) => RectLike,
  matched: Set<Element>,
  scrollY: number
): BboxResolveResult | null | undefined {
  let elements: ArrayLike<Element> & Iterable<Element>;
  try {
    elements = container.querySelectorAll(selector);
  } catch {
    return undefined; // invalid selector → try next candidate
  }

  // non-zero-size 要素のみを母集団に数える (population-parity / 同一 selector 基準)。
  let matchIndex = 0;
  for (const el of elements) {
    if (matched.has(el)) continue;
    const rect = getRect(el);
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (matchIndex === part.sampleIndex) {
      return finalizeMatch(el, rect, part, matched, scrollY);
    }
    matchIndex++;
  }
  // (B) divergence: この selector の live population が sampleIndex を含まない。
  return isElementCountDivergent(matchIndex, part.sampleIndex) ? null : undefined;
}

/**
 * sampleIndex 一致要素を確定する。clamp edge (F-M-03(B)) で garbage crop を避ける。
 */
function finalizeMatch(
  el: Element,
  rect: RectLike,
  part: PartSelectorInput,
  matched: Set<Element>,
  scrollY: number
): BboxResolveResult | null {
  const absoluteY = rect.top + scrollY;
  // (C) clamp edge: absoluteY < sectionStartY だと stored y が 0 にクランプされ、
  // 下流 crop 絶対 y = 0 + sectionStartY = garbage。honest-skip する (F-M-03(B))。
  if (absoluteY < part.sectionStartY) return null;
  matched.add(el);
  return {
    id: part.id,
    x: Math.max(0, rect.left),
    y: absoluteY - part.sectionStartY,
    width: rect.width,
    height: rect.height,
  };
}

// ============================================================================
// rAF settle (F-M-05 — dedup target)
// ============================================================================

/** rAF 2-frame settle の timeout (ms)。Phase 0 lazy-scroll と同パターン。 */
const RAF_SETTLE_TIMEOUT_MS_DEFAULT = 2000;

/**
 * scroll 後の rAF-race tail を待つ leaf util (F-M-05、×3 重複の dedup 単位)。
 * `requestAnimationFrame` を 2 フレーム待ち、`timeoutMs` で打ち切る。失敗は non-fatal。
 *
 * 真の dedup 単位は **rAF-race tail のみ** であり、`scrollTo` (絶対 Y) と
 * `scrollIntoView` (container) で scroll セマンティクスが異なるため scroll 自体は
 * 共有しない (plan-v1 §3.3.3 / F-M-05 訂正)。
 *
 * Waits the rAF-race tail after a scroll (the F-M-05 dedup unit, ×3 duplicated).
 * Waits 2 `requestAnimationFrame` frames, capped by `timeoutMs`; failures are
 * non-fatal. Only the rAF tail is shared — `scrollTo` (absolute Y) vs
 * `scrollIntoView` (container) differ in scroll semantics so the scroll itself
 * is NOT shared.
 */
export async function waitForRafSettle(
  page: Page,
  timeoutMs: number = RAF_SETTLE_TIMEOUT_MS_DEFAULT
): Promise<void> {
  await Promise.race([
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })
    ),
    page.waitForTimeout(timeoutMs),
  ]).catch(() => {
    /* non-fatal: rAF timeout / disposed page mid-step */
  });
}

// ============================================================================
// Coverage-floor helpers (INV-VISUAL-COVERAGE-FLOOR-001)
// ============================================================================

/**
 * population delineation tag。本 INV の母集団 = bbox-resolve 率 (crop 前段)。
 * `inv-part-visual-coverage-001` の母集団 (part_visual embedding completion =
 * crop + DINOv2) とは段階が異なる (bbox-resolve ⊇ embedding-completion)。
 *
 * Population kind tag. This INV's population = bbox-resolve rate (pre-crop),
 * distinct from `inv-part-visual-coverage-001` (part_visual embedding completion).
 */
export const BBOX_RESOLVE_RATE_POPULATION_KIND = "bbox-resolve" as const;

/**
 * resolve 率の相対回帰許容幅 (絶対 percentage points)。実機 baseline 確定前の
 * non-regression contract 用。絶対カバレッジ達成は実機 DoD (plan-v1 §5)。
 *
 * Relative resolve-rate regression tolerance (absolute pp). Absolute coverage is
 * a real-machine DoD, not pinned here.
 */
export const RESOLVE_RATE_REGRESSION_TOLERANCE = 0.01;

/** resolve 数 / 総数 から resolve 率を算出する (0 除算防御)。 */
export function computeResolveRate(resolvedCount: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return resolvedCount / totalCount;
}

/**
 * current resolve 率が baseline から tolerance を超えて低下していたら throw する
 * (相対回帰 floor)。絶対値は pin しない (fake-success A-8 回避)。
 *
 * Throws when `current` resolve rate drops below `baseline` beyond the tolerance
 * (relative regression floor). Does NOT pin an absolute value (avoids
 * fake-success A-8).
 */
export function assertNoResolveRateRegression(baseline: number, current: number): void {
  if (current < baseline - RESOLVE_RATE_REGRESSION_TOLERANCE) {
    throw new Error(
      `[INV-VISUAL-COVERAGE-FLOOR-001] bbox-resolve rate regressed: ` +
        `baseline=${baseline.toFixed(4)} current=${current.toFixed(4)} ` +
        `tolerance=${RESOLVE_RATE_REGRESSION_TOLERANCE}`
    );
  }
}
