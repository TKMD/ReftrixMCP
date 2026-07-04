// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-TOLERANCE-NON-GATING-001 (H)
 *
 * W6 Issue A PR-2 (part bbox gate-fix). Asserts the part-bbox resolution gate
 * is **non-gating** for real-sized in-flow elements (the ±500px `sectionTolerance`
 * band is replaced by DOM-ancestry containment scope) AND that the new scope
 * **structurally closes silent-wrong crop** surfaces.
 *
 * Host-independent by construction (no real-DB, no Playwright, no memory/RSS/VRAM
 * thresholds): Layer (i) is AST source-pin over production source; Layer (ii)/(iii)
 * use a deterministic jsdom DOM fixture with **stubbed getBoundingClientRect()**
 * (fixed literals), so the CI host's real viewport / RAM / rendering is never read.
 * This avoids the `feedback_real_db_test_short_circuit_false_pass` HAS_DB
 * short-circuit and the `testing-requirements.md §7` host-RAM × mocked-rss flake.
 *
 * 3 layers + strengthened fixtures (Finding Registry §1-A/B/C/D):
 *   Layer (i)   AST source-pin: band removal + escape SSOT + gate non-reintroduction
 *               + BBOX_RELOAD budget / absoluteCap invariance (D) + container scope (A).
 *   Layer (ii)  jsdom fixture-DOM unit: deep-element non-gating, selector escape (A),
 *               honest-skip-on-divergence (B), self-cancel clamp edge (C),
 *               container-null honest-skip, zero-size skip.
 *   Layer (iii) isElementCountDivergent leaf unit: population definition pin (B).
 *
 * **Severity**: H (code + CI). band-reject was the dominant cause of the
 * 16729-part `bbox_unresolvable` collapse (0.2% band-resolve rate).
 *
 * @see  §4.1
 * @see  §1
 * @module tests/regression/standing/large-page/inv-tolerance-non-gating-001
 */

import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { Project } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { JSDOM } from "jsdom";
import { assertInvName } from "../_setup/inv-assert";
import {
  resolvePartBboxesInScope,
  isElementCountDivergent,
  type DomLikeScope,
  type PartSelectorInput,
  type RectLike,
} from "../../../../src/services/part/section-selector.helper";
import { escapeCssIdentifier } from "@reftrixmcp/core";

// ============================================================================
// Constants / paths
// ============================================================================

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const SRC_ROOT = path.resolve(MCP_SERVER_ROOT, "src");
const REPO_ROOT = path.resolve(MCP_SERVER_ROOT, "../..");

const BBOX_SERVICE_FILE = path.resolve(SRC_ROOT, "services/part/part-bbox-playwright.service.ts");
const SECTION_DETECTOR_FILE = path.resolve(
  REPO_ROOT,
  "packages/webdesign-core/src/section-detector/index.ts"
);
const CORE_UTILS_FILE = path.resolve(REPO_ROOT, "packages/core/src/utils/css-identifier.ts");

// ============================================================================
// Helpers — AST
// ============================================================================

function createAstProject(): Project {
  return new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: false, strict: true },
  });
}

/**
 * Extract the source text of the `runBboxPageEvaluate` function (the page.evaluate
 * gate body) so AST-pin assertions are scoped to the gate, not the whole file.
 */
function getGateBodyText(sourceFile: SourceFile): string {
  const fn = sourceFile.getFunction("runBboxPageEvaluate");
  if (!fn) throw new Error("runBboxPageEvaluate function not found");
  return fn.getText();
}

// ============================================================================
// Helpers — jsdom fixture with stubbed getBoundingClientRect()
// ============================================================================

/**
 * Build a jsdom document and a DOM-like scope adapter. Each element's rect is
 * stubbed from a fixed literal map keyed by a `data-rect` id attribute, so the
 * test is host-independent (jsdom's native getBoundingClientRect always returns
 * 0×0). The returned `getRect` reads the stub.
 */
function buildScope(
  html: string,
  rects: Record<string, RectLike>,
  scrollY = 0
): { scope: DomLikeScope; getRect: (el: Element) => RectLike } {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const doc = dom.window.document;
  const getRect = (el: Element): RectLike => {
    const key = el.getAttribute("data-rect");
    if (key && rects[key]) return rects[key]!;
    return { top: 0, left: 0, width: 0, height: 0 };
  };
  const scope: DomLikeScope = {
    querySelector: (sel: string) => doc.querySelector(sel),
    querySelectorAll: (sel: string) => doc.querySelectorAll(sel),
    scrollY,
  };
  return { scope, getRect };
}

// ============================================================================
// Layer (i) — AST source-pin
// ============================================================================

describe("INV-TOLERANCE-NON-GATING-001: Layer (i) AST source-pin", () => {
  let bboxFile: SourceFile;
  let sectionDetectorFile: SourceFile;
  let coreUtilsFile: SourceFile;

  beforeAll(() => {
    const project = createAstProject();
    bboxFile = project.addSourceFileAtPath(BBOX_SERVICE_FILE);
    sectionDetectorFile = project.addSourceFileAtPath(SECTION_DETECTOR_FILE);
    coreUtilsFile = project.addSourceFileAtPath(CORE_UTILS_FILE);
  });

  it("INV-TOLERANCE-NON-GATING-001: gate body removes the ±500px sectionTolerance band literal", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const body = getGateBodyText(bboxFile);
    // The legacy band was `const sectionTolerance = 500;` — must be gone.
    expect(/sectionTolerance\s*=\s*500/.test(body)).toBe(false);
    expect(/\bsectionTolerance\b/.test(body)).toBe(false);
  });

  it("INV-TOLERANCE-NON-GATING-001: (D) no abs(absoluteY - sectionStartY) comparison gate is reintroduced", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const body = getGateBodyText(bboxFile);
    // Forbid any `Math.abs(absoluteY - ... sectionStartY)` band-style comparison
    // (prevents bug reintroduction under a different literal).
    const absBandRe = /Math\.abs\s*\(\s*absoluteY\s*-[\s\S]{0,80}?sectionStartY\s*\)/;
    expect(absBandRe.test(body)).toBe(false);
  });

  it("INV-TOLERANCE-NON-GATING-001: (A) gate resolves a container scope (querySelector/querySelectorAll on container)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const body = getGateBodyText(bboxFile);
    // Section-scope: a `container` is resolved via document.querySelector(sectionSelector)
    // and querySelectorAll is invoked on the container, NOT document-wide unscoped.
    expect(/container\s*=\s*[\s\S]{0,120}?querySelector\(/.test(body)).toBe(true);
    expect(/container\.querySelectorAll\(/.test(body)).toBe(true);
  });

  it("INV-TOLERANCE-NON-GATING-001: (D) BBOX_RELOAD budget defaults + absoluteCap (100 / 600000) are unchanged", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const fullText = bboxFile.getFullText();
    expect(/BBOX_RELOAD_ENABLED_DEFAULT\s*=\s*false/.test(fullText)).toBe(true);
    expect(/BBOX_RELOAD_MAX_RELOADS_PER_PAGE_DEFAULT\s*=\s*5\b/.test(fullText)).toBe(true);
    expect(/BBOX_RELOAD_TOTAL_TIMEOUT_MS_DEFAULT\s*=\s*60_000\b/.test(fullText)).toBe(true);
    // absoluteCap arguments to parseBboxReloadIntEnv (SEC-04 申し送り): 100 and 600_000.
    expect(/parseBboxReloadIntEnv\([\s\S]*?,\s*100,/.test(fullText)).toBe(true);
    expect(/parseBboxReloadIntEnv\([\s\S]*?,\s*600_000,/.test(fullText)).toBe(true);
  });

  it("INV-TOLERANCE-NON-GATING-001: (A) escapeCssIdentifier SSOT lives ONLY in @reftrixmcp/core (no inline reimpl in apps/webdesign-core)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // The SSOT definition (a function declaration / arrow with the escape regex)
    // must exist in @reftrixmcp/core's css-identifier module.
    const coreText = coreUtilsFile.getFullText();
    expect(/export function escapeCssIdentifier/.test(coreText)).toBe(true);

    // No local re-definition in the apps service or section-detector (import only).
    const bboxText = bboxFile.getFullText();
    const detectorText = sectionDetectorFile.getFullText();
    expect(/function escapeCssIdentifier/.test(bboxText)).toBe(false);
    expect(/function escapeCssIdentifier/.test(detectorText)).toBe(false);
    // Both consumers import the SSOT from @reftrixmcp/core.
    expect(/from\s+["']@reftrixmcp\/core["']/.test(bboxText)).toBe(true);
    expect(/from\s+["']@reftrixmcp\/core["']/.test(detectorText)).toBe(true);
  });

  it("INV-TOLERANCE-NON-GATING-001: (A) generateSelector id/class tokens go through escapeCssIdentifier (id arm too)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const fn = sectionDetectorFile.getFunction("generateSelector");
    if (!fn) throw new Error("generateSelector not found");
    const text = fn.getText();
    // Both id arm and class arm must escape (ADDENDUM B: id arm is the surface
    // F-M-01 closes; class-only escape is insufficient).
    expect(/escapeCssIdentifier\(\s*id\s*\)/.test(text)).toBe(true);
    expect(/escapeCssIdentifier\(/.test(text)).toBe(true);
    // nth-of-type ambiguity resolution must exist.
    expect(/:nth-of-type\(/.test(text)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // (TPA-IMPL-M-02) Browser-context ↔ Node SSOT parity AST-pin.
  // The browser-context body of `runBboxPageEvaluate`
  // (`part-bbox-playwright.service.ts:795-858`) is a MIRROR of the Node SSOT
  // `resolvePartBboxesInScope` (`section-selector.helper.ts`), but the browser
  // body inlines the parity LITERALS instead of calling `isElementCountDivergent`
  // (page.evaluate cannot import — closures are not serialized). Layer (ii)/(iii)
  // exercise the Node SSOT only, so a future edit to the browser body alone could
  // make the two implementations behaviorally drift without any INV catching it.
  // These AST-pins assert the parity literals are present in the BROWSER body so
  // the mirror cannot silently diverge from the SSOT.
  // --------------------------------------------------------------------------

  it("INV-TOLERANCE-NON-GATING-001: (M-02 parity) browser gate body pins the clamp-edge honest-skip literal (absoluteY < sectionStartY → null)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const body = getGateBodyText(bboxFile);
    // Mirror of Node SSOT `finalizeMatch`: `if (absoluteY < part.sectionStartY) return null;`
    expect(/absoluteY\s*<\s*part\.sectionStartY/.test(body)).toBe(true);
    // And it returns null on that branch (honest-skip, not a garbage 0+startY crop).
    expect(/absoluteY\s*<\s*part\.sectionStartY\s*\)\s*return\s+null/.test(body)).toBe(true);
  });

  it("INV-TOLERANCE-NON-GATING-001: (M-02 parity) browser gate body pins the population-divergence literal (matchIndex <= sampleIndex → null else undefined)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const body = getGateBodyText(bboxFile);
    // Mirror of Node SSOT `isElementCountDivergent(liveCount, sampleIndex) = liveCount <= sampleIndex`:
    // the browser body inlines `matchIndex <= part.sampleIndex ? null : undefined`.
    expect(/matchIndex\s*<=\s*part\.sampleIndex\s*\?\s*null\s*:\s*undefined/.test(body)).toBe(true);
  });

  it("INV-TOLERANCE-NON-GATING-001: (M-02 parity) browser gate body pins the absoluteY = rect.top + window.scrollY computation", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const body = getGateBodyText(bboxFile);
    // Mirror of Node SSOT `finalizeMatch`: `absoluteY = rect.top + scrollY` (browser
    // uses `window.scrollY`). Pins the absolute-Y semantic shared with the SSOT.
    expect(/absoluteY\s*=\s*rect\.top\s*\+\s*window\.scrollY/.test(body)).toBe(true);
    // Self-cancel crop y: `absoluteY - part.sectionStartY` (>= 0 after the clamp gate).
    expect(/absoluteY\s*-\s*part\.sectionStartY/.test(body)).toBe(true);
  });

  it("INV-TOLERANCE-NON-GATING-001: (M-02 parity) browser gate body resolves a container scope & matches per-selector (sampleIndex / zero-size skip parity)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const body = getGateBodyText(bboxFile);
    // container resolved from sectionSelector (honest-skip on null, no document fallback)
    expect(
      /container\s*=\s*document\.querySelector\(\s*part\.sectionSelector\s*\)/.test(body)
    ).toBe(true);
    // matches are scoped to container.querySelectorAll(selector) (NOT document-wide).
    expect(/container\.querySelectorAll\(\s*selector\s*\)/.test(body)).toBe(true);
    // zero-size skip parity: `rect.width <= 0 || rect.height <= 0` → continue.
    expect(/rect\.width\s*<=\s*0\s*\|\|\s*rect\.height\s*<=\s*0/.test(body)).toBe(true);
    // sampleIndex match parity: `matchIndex === part.sampleIndex`.
    expect(/matchIndex\s*===\s*part\.sampleIndex/.test(body)).toBe(true);
  });
});

// ============================================================================
// Layer (ii) — deterministic jsdom fixture-DOM unit
// ============================================================================

describe("INV-TOLERANCE-NON-GATING-001: Layer (ii) jsdom fixture-DOM unit", () => {
  it("INV-TOLERANCE-NON-GATING-001: (non-gating) deep element far outside legacy band is resolved in container scope", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // sectionStartY=240, deep element absoluteY=30000 — legacy ±500 band would reject;
    // container scope must resolve it (real-sized element not gated).
    const html = `
      <section id="sec1">
        <a data-rect="deep" href="#">deep link</a>
      </section>`;
    const rects: Record<string, RectLike> = {
      deep: { top: 30000, left: 12, width: 120, height: 40 },
    };
    const { scope, getRect } = buildScope(html, rects, 0);
    const parts: PartSelectorInput[] = [
      { id: "p1", sectionSelector: "#sec1", selectors: ["a"], sectionStartY: 240, sampleIndex: 0 },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).not.toBeNull();
    expect(results[0]!.width).toBe(120);
    expect(results[0]!.height).toBe(40);
  });

  it("INV-TOLERANCE-NON-GATING-001: (A escape) CSS-metachar id/class do not break parsing nor mis-target", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // Two sections: one with metachar id, one decoy. Escaped selector must target
    // the intended container, never the decoy, and never throw.
    const html = `
      <section id="a.b#c"><a data-rect="real" href="#">x</a></section>
      <section id="decoy"><a data-rect="decoy" href="#">y</a></section>`;
    const rects: Record<string, RectLike> = {
      real: { top: 5000, left: 0, width: 50, height: 20 },
      decoy: { top: 100, left: 0, width: 999, height: 999 },
    };
    const { scope, getRect } = buildScope(html, rects, 0);
    const escaped = `section#${escapeCssIdentifier("a.b#c")}`;
    const parts: PartSelectorInput[] = [
      { id: "p1", sectionSelector: escaped, selectors: ["a"], sectionStartY: 0, sampleIndex: 0 },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).not.toBeNull();
    // Must be the real element (50×20), never the decoy (999×999).
    expect(results[0]!.width).toBe(50);
  });

  it("INV-TOLERANCE-NON-GATING-001: (A escape) unresolvable metachar selector → honest-skip (null), no document fallback", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const html = `<section id="sec1"><a data-rect="r" href="#">x</a></section>`;
    const rects: Record<string, RectLike> = { r: { top: 10, left: 0, width: 50, height: 20 } };
    const { scope, getRect } = buildScope(html, rects, 0);
    // sectionSelector points at a container that does not exist → null, no fallback.
    const parts: PartSelectorInput[] = [
      {
        id: "p1",
        sectionSelector: `section#${escapeCssIdentifier("does.not#exist")}`,
        selectors: ["a"],
        sectionStartY: 0,
        sampleIndex: 0,
      },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).toBeNull();
  });

  it("INV-TOLERANCE-NON-GATING-001: (B divergence) liveCount <= sampleIndex returns null, no silent pick of another element", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // Container has 1 matching <a>, but the part wants sampleIndex=3 → divergent → null.
    // The lone <a> must NOT be silently picked.
    const html = `<section id="sec1"><a data-rect="r" href="#">x</a></section>`;
    const rects: Record<string, RectLike> = { r: { top: 10, left: 0, width: 50, height: 20 } };
    const { scope, getRect } = buildScope(html, rects, 0);
    const parts: PartSelectorInput[] = [
      { id: "p1", sectionSelector: "#sec1", selectors: ["a"], sectionStartY: 0, sampleIndex: 3 },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).toBeNull();
  });

  // --------------------------------------------------------------------------
  // (TPA-IMPL-M-01) tag-only-fallback residual path: matchIndex > sampleIndex.
  // The single-element fixtures above all have matchIndex == sampleIndex == 0,
  // so the residual path where a tag-only selector (e.g. `a` with no id/class)
  // matches MULTIPLE same-type elements in one container — making the gate's
  // selector-count `matchIndex` advance past 0 — was previously never exercised.
  // Extraction's `sampleIndex` is the `identifyPartType` partition counter
  // (`part-extraction.service.ts:184-217` `typeCounters`/`currentCount`), whereas
  // the gate's `matchIndex` is the `buildSelectorsForPart` selector-match count.
  // When that selector over-counts (multiple same-type siblings), the gate's
  // ACTUAL behavior (per `section-selector.helper.ts:164-216`) is:
  //   - if liveCount > sampleIndex → pick the sampleIndex-th non-zero same-type
  //     element IN the container (bounded same-type pick — a real, in-section,
  //     same-tag element; NOT garbage and NOT cross-section), then
  //   - if liveCount <= sampleIndex → `isElementCountDivergent` → honest-skip null.
  // These two cases pin the genuine residual exercised by this H INV.
  // --------------------------------------------------------------------------

  it("INV-TOLERANCE-NON-GATING-001: (M-01 residual) matchIndex > sampleIndex → bounded same-type pick (sampleIndex-th in-container element, not the first)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // One container, THREE same-type <a> (tag-only fallback selector "a"). Each
    // <a> has a distinct rect so the picked element is unambiguous. The part
    // requests sampleIndex=2 → matchIndex advances 0→1→2 → the gate must pick the
    // THIRD <a> (a real same-type in-container sibling), never the first (a0).
    const html = `
      <section id="sec1">
        <a data-rect="a0" href="#">first</a>
        <a data-rect="a1" href="#">second</a>
        <a data-rect="a2" href="#">third</a>
      </section>`;
    const rects: Record<string, RectLike> = {
      a0: { top: 100, left: 0, width: 10, height: 10 },
      a1: { top: 200, left: 0, width: 20, height: 20 },
      a2: { top: 300, left: 0, width: 30, height: 30 },
    };
    const { scope, getRect } = buildScope(html, rects, 0);
    const parts: PartSelectorInput[] = [
      { id: "p1", sectionSelector: "#sec1", selectors: ["a"], sectionStartY: 0, sampleIndex: 2 },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).not.toBeNull();
    // Picked the THIRD same-type element (matchIndex 2), not the first (matchIndex 0).
    expect(results[0]!.width).toBe(30);
    expect(results[0]!.height).toBe(30);
    // section-relative y: absoluteY(300) - sectionStartY(0) = 300 (real, not garbage).
    expect(results[0]!.y).toBe(300);
  });

  it("INV-TOLERANCE-NON-GATING-001: (M-01 residual) matchIndex caps below requested sampleIndex → honest-skip (null), no over-pick of a same-type sibling", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // One container, TWO same-type <a> (liveCount 2). Part wants sampleIndex=3.
    // matchIndex advances 0→1→2 (never reaches 3) → isElementCountDivergent(2, 3)
    // = (2 <= 3) = true → honest-skip null. Neither <a> is silently over-picked.
    const html = `
      <section id="sec1">
        <a data-rect="a0" href="#">first</a>
        <a data-rect="a1" href="#">second</a>
      </section>`;
    const rects: Record<string, RectLike> = {
      a0: { top: 100, left: 0, width: 10, height: 10 },
      a1: { top: 200, left: 0, width: 20, height: 20 },
    };
    const { scope, getRect } = buildScope(html, rects, 0);
    const parts: PartSelectorInput[] = [
      { id: "p1", sectionSelector: "#sec1", selectors: ["a"], sectionStartY: 0, sampleIndex: 3 },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).toBeNull();
  });

  it("INV-TOLERANCE-NON-GATING-001: (C clamp edge) absoluteY < sectionStartY → honest-skip (null), no garbage 0+startY crop", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // Deep part: absoluteY=5000 but garbage sectionStartY=8000 (estimatedHeight
    // over-accumulated). Legacy Math.max(0, 5000-8000)=0 → crop y = 0 + 8000 = garbage.
    // Per F-M-03(B) the gate must honest-skip instead of emitting garbage crop coords.
    const html = `<section id="sec1"><a data-rect="r" href="#">x</a></section>`;
    const rects: Record<string, RectLike> = { r: { top: 5000, left: 4, width: 60, height: 30 } };
    const { scope, getRect } = buildScope(html, rects, 0);
    const parts: PartSelectorInput[] = [
      { id: "p1", sectionSelector: "#sec1", selectors: ["a"], sectionStartY: 8000, sampleIndex: 0 },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).toBeNull();
  });

  it("INV-TOLERANCE-NON-GATING-001: (C clamp edge) absoluteY >= sectionStartY → correct self-cancel crop y", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // Normal case: absoluteY=8000, sectionStartY=7000 → stored y = 1000 (self-cancel
    // downstream restores y + startY = 8000 = real absoluteY).
    const html = `<section id="sec1"><a data-rect="r" href="#">x</a></section>`;
    const rects: Record<string, RectLike> = { r: { top: 8000, left: 4, width: 60, height: 30 } };
    const { scope, getRect } = buildScope(html, rects, 0);
    const parts: PartSelectorInput[] = [
      { id: "p1", sectionSelector: "#sec1", selectors: ["a"], sectionStartY: 7000, sampleIndex: 0 },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).not.toBeNull();
    expect(results[0]!.y).toBe(1000);
  });

  it("INV-TOLERANCE-NON-GATING-001: (container-null) missing sectionSelector container → null, never document-wide fallback", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // Element exists document-wide but the part's container is absent → must NOT
    // fall back to document scope (that would revert to the garbage band approximation).
    const html = `<section id="other"><a data-rect="r" href="#">x</a></section>`;
    const rects: Record<string, RectLike> = { r: { top: 10, left: 0, width: 50, height: 20 } };
    const { scope, getRect } = buildScope(html, rects, 0);
    const parts: PartSelectorInput[] = [
      { id: "p1", sectionSelector: "#missing", selectors: ["a"], sectionStartY: 0, sampleIndex: 0 },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).toBeNull();
  });

  it("INV-TOLERANCE-NON-GATING-001: (container-null) absent sectionSelector field (undefined) → null honest-skip", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    const html = `<section id="sec1"><a data-rect="r" href="#">x</a></section>`;
    const rects: Record<string, RectLike> = { r: { top: 10, left: 0, width: 50, height: 20 } };
    const { scope, getRect } = buildScope(html, rects, 0);
    const parts: PartSelectorInput[] = [
      { id: "p1", selectors: ["a"], sectionStartY: 0, sampleIndex: 0 },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).toBeNull();
  });

  it("INV-TOLERANCE-NON-GATING-001: (zero-size) width/height 0 elements are skipped", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // First <a> is zero-size (skip), second is real → sampleIndex 0 must land on
    // the real one (zero-size does not consume the index).
    const html = `
      <section id="sec1">
        <a data-rect="zero" href="#">x</a>
        <a data-rect="real" href="#">y</a>
      </section>`;
    const rects: Record<string, RectLike> = {
      zero: { top: 100, left: 0, width: 0, height: 0 },
      real: { top: 200, left: 0, width: 80, height: 40 },
    };
    const { scope, getRect } = buildScope(html, rects, 0);
    const parts: PartSelectorInput[] = [
      { id: "p1", sectionSelector: "#sec1", selectors: ["a"], sectionStartY: 150, sampleIndex: 0 },
    ];
    const results = resolvePartBboxesInScope(scope, parts, getRect);
    expect(results[0]).not.toBeNull();
    expect(results[0]!.width).toBe(80);
  });
});

// ============================================================================
// Layer (iii) — isElementCountDivergent leaf unit (population definition pin)
// ============================================================================

describe("INV-TOLERANCE-NON-GATING-001: Layer (iii) isElementCountDivergent population pin", () => {
  it("INV-TOLERANCE-NON-GATING-001: liveCount <= sampleIndex is divergent (boundary)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    // population = number of selector-matching, non-zero-size elements in container.
    // When the live population cannot contain the requested sampleIndex → divergent.
    expect(isElementCountDivergent(0, 0)).toBe(true); // empty container
    expect(isElementCountDivergent(1, 1)).toBe(true); // index 1 needs >=2 elements
    expect(isElementCountDivergent(3, 3)).toBe(true);
  });

  it("INV-TOLERANCE-NON-GATING-001: liveCount > sampleIndex is non-divergent (real-sized element resolvable)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-TOLERANCE-NON-GATING-001");
    expect(isElementCountDivergent(1, 0)).toBe(false);
    expect(isElementCountDivergent(4, 3)).toBe(false);
    expect(isElementCountDivergent(10, 0)).toBe(false);
  });
});
