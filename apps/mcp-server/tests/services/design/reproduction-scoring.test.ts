// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.verify_reproduction: pure scoring / matching unit tests.
 * design.verify_reproduction: スコアリング・マッチングの純関数テスト。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PART_EXTRACTION_CONFIG } from "../../../src/services/part/types";
import {
  DIFF_VALUE_MAX_CHARS,
  PIXEL_MASK_PART_TYPES,
  SCORE_WEIGHTS,
  combineOverall,
  compareParts,
  normalizeText,
  textPreview,
  type CandidatePart,
  type ReferencePart,
} from "../../../src/services/design/reproduction-scoring";

const ref = (over: Partial<ReferencePart> = {}): ReferencePart => ({
  partType: "heading",
  text: "Welcome to the studio",
  rect: { x: 10, y: 20, width: 400, height: 50 },
  styles: { "font-size": "32px", color: "rgb(0, 0, 0)" },
  highPii: false,
  ...over,
});
const cand = (over: Partial<CandidatePart> = {}): CandidatePart => ({
  partType: "heading",
  text: "Welcome to the studio",
  rect: { x: 10, y: 20, width: 400, height: 50 },
  styles: { "font-size": "32px", color: "rgb(0, 0, 0)" },
  ...over,
});

describe("score weights", () => {
  it("sum to 1 and give layout+style more weight than pixel", () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(SCORE_WEIGHTS.layout + SCORE_WEIGHTS.style).toBeGreaterThan(0.6);
    expect(SCORE_WEIGHTS.pixel).toBeLessThanOrEqual(0.1);
  });
  it("renormalizes over available components only", () => {
    expect(combineOverall({ layout: 1, style: null, visual: null, pixel: null })).toBe(1);
    expect(combineOverall({ layout: null, style: null, visual: null, pixel: null })).toBe(0);
    const all = combineOverall({ layout: 1, style: 1, visual: 1, pixel: 0 });
    expect(all).toBeCloseTo(1 - SCORE_WEIGHTS.pixel, 10);
  });
  it("never returns NaN or out-of-range values", () => {
    const v = combineOverall({ layout: Number.NaN, style: 2, visual: -1, pixel: Infinity });
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("text helpers", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeText("  Hello \n  WORLD ")).toBe("hello world");
  });
  it("truncates previews to 40 chars", () => {
    expect(textPreview("x".repeat(100)).length).toBeLessThanOrEqual(40);
    expect(textPreview("short")).toBe("short");
  });
  it("mask types include images", () => {
    expect(PIXEL_MASK_PART_TYPES.has("image")).toBe(true);
  });
});

describe("compareParts", () => {
  it("scores an identical reproduction at 1 with no diffs", () => {
    const r = compareParts([ref()], [cand()], 20);
    expect(r.layoutScore).toBeCloseTo(1, 5);
    expect(r.styleScore).toBeCloseTo(1, 5);
    expect(r.diffs).toEqual([]);
    expect(r.missingParts).toEqual([]);
    expect(r.extraParts).toEqual([]);
    expect(r.matchedParts).toBe(1);
    expect(r.stylesCompared).toBe(2);
  });

  it("reports font-size and color diffs", () => {
    const r = compareParts(
      [ref()],
      [cand({ styles: { "font-size": "16px", color: "rgb(255, 0, 0)" } })],
      20
    );
    const props = r.diffs.map((d) => d.property);
    expect(props).toContain("font-size");
    expect(props).toContain("color");
    expect(r.styleScore).toBeLessThan(0.6);
    const fs = r.diffs.find((d) => d.property === "font-size");
    expect(fs?.expected).toBe("32px");
    expect(fs?.actual).toBe("16px");
  });

  it("reports a removed element as missing", () => {
    const r = compareParts([ref(), ref({ partType: "button", text: "Join" })], [cand()], 20);
    expect(r.missingParts).toHaveLength(1);
    expect(r.missingParts[0]?.partType).toBe("button");
    expect(r.layoutScore).toBeLessThan(0.7);
  });

  it("reports a moved/resized element as rect diffs", () => {
    const r = compareParts(
      [ref()],
      [cand({ rect: { x: 10, y: 120, width: 200, height: 50 } })],
      20
    );
    const props = r.diffs.map((d) => d.property);
    expect(props).toContain("rect.y");
    expect(props).toContain("rect.width");
    expect(props).not.toContain("rect.x");
  });

  it("flags extra candidate parts without echoing candidate text", () => {
    const r = compareParts(
      [ref()],
      [cand(), cand({ partType: "button", text: "SECRET-CAND" })],
      20
    );
    expect(r.extraParts).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain("SECRET-CAND");
  });

  it("never exposes text of high-PII reference parts", () => {
    const r = compareParts(
      [ref({ highPii: true, text: "alice@example.com" })],
      [cand({ text: "other" })],
      20
    );
    expect(JSON.stringify(r)).not.toContain("alice@example.com");
  });

  it("skips style comparison when reference styles are empty (stylesCompared 0)", () => {
    const r = compareParts([ref({ styles: {} })], [cand()], 20);
    expect(r.stylesCompared).toBe(0);
    expect(r.styleScore).toBeNull();
  });

  it("matches by type + text/IoU greedily, not by order", () => {
    const a = ref({ text: "A", rect: { x: 0, y: 0, width: 100, height: 40 } });
    const b = ref({ text: "B", rect: { x: 0, y: 200, width: 100, height: 40 } });
    const r = compareParts(
      [a, b],
      [
        cand({ text: "B", rect: { x: 0, y: 200, width: 100, height: 40 } }),
        cand({ text: "A", rect: { x: 0, y: 0, width: 100, height: 40 } }),
      ],
      20
    );
    expect(r.matchedParts).toBe(2);
    expect(r.diffs).toEqual([]);
  });

  it("caps diffs at maxDiffs and keeps the most severe first", () => {
    const refs = Array.from({ length: 10 }, (_, i) =>
      ref({ text: `t${i}`, rect: { x: 0, y: i * 100, width: 100, height: 40 } })
    );
    const cands = refs.map((r0) =>
      cand({
        text: r0.text ?? "",
        rect: r0.rect ?? { x: 0, y: 0, width: 1, height: 1 },
        styles: { "font-size": "10px", color: "rgb(1, 1, 1)" },
      })
    );
    const r = compareParts(refs, cands, 3);
    expect(r.diffs).toHaveLength(3);
    expect(r.diffsTruncated).toBe(true);
  });

  it("treats references without rect as type/text-only (partial coverage)", () => {
    const r = compareParts([ref({ rect: null })], [cand()], 20);
    expect(r.matchedParts).toBe(1);
    expect(r.referencePartsWithRect).toBe(0);
  });

  it("returns null layout score when there are no reference parts", () => {
    const r = compareParts([], [cand()], 20);
    expect(r.layoutScore).toBeNull();
  });
});

describe("audit fixes (SEC M-1 / TDA H-1)", () => {
  it("truncates returned expected/actual style values (no reflection of huge candidate values)", () => {
    const huge = "a".repeat(200_000);
    const r = compareParts([ref()], [cand({ styles: { "font-size": huge, color: huge } })], 20);
    expect(r.diffs.length).toBeGreaterThan(0);
    for (const d of r.diffs) {
      expect(d.actual.length).toBeLessThanOrEqual(DIFF_VALUE_MAX_CHARS);
      expect(d.expected.length).toBeLessThanOrEqual(DIFF_VALUE_MAX_CHARS);
    }
  });

  it("does not penalize candidate parts beyond the reference per-type cap", () => {
    const cap = DEFAULT_PART_EXTRACTION_CONFIG.maxPartsPerType;
    const link = (i: number) => ({
      partType: "link",
      text: `Link number ${i}`,
      rect: { x: 10, y: 10 + i * 40, width: 200, height: 30 },
      styles: {},
    });
    const refs = Array.from({ length: cap }, (_, i) => ({ ...link(i), highPii: false }));
    const cands = Array.from({ length: cap + 7 }, (_, i) => link(i));
    const r = compareParts(refs, cands, 20);
    expect(r.extraParts).toEqual([]);
    expect(r.beyondReferenceCap).toBe(7);
    expect(r.layoutScore).toBeGreaterThan(0.95);
  });

  it("still reports extra parts of a type whose reference count is below the cap", () => {
    const r = compareParts([ref()], [cand(), cand({ partType: "button", text: "Buy" })], 20);
    expect(r.extraParts).toHaveLength(1);
    expect(r.beyondReferenceCap).toBe(0);
  });

  it("keeps a thin inline link (120x17): only parts under the minimum on both sides are dropped", () => {
    const linkRect = { x: 10, y: 10, width: 120, height: 17 };
    const r = compareParts(
      [ref({ partType: "link", text: "Read more", rect: linkRect, styles: {} })],
      [cand({ partType: "link", text: "Read more", rect: linkRect, styles: {} })],
      20
    );
    expect(r.matchedParts).toBe(1);
    expect(r.missingParts).toEqual([]);
  });

  it("ignores candidate parts smaller than the reference minPartSize", () => {
    const tiny = cand({ partType: "icon", text: "", rect: { x: 0, y: 0, width: 10, height: 10 } });
    const r = compareParts([ref()], [cand(), tiny], 20);
    expect(r.extraParts).toEqual([]);
  });
});

describe("ignoreText option (VR-M-03)", () => {
  const differentText = cand({ text: "Totally unrelated copy that shares nothing" });

  it("default (option absent or false) keeps text in the match", () => {
    const same = compareParts([ref()], [cand()], 20);
    const diff = compareParts([ref()], [differentText], 20);
    const diffFalse = compareParts([ref()], [differentText], 20, { ignoreText: false });
    // layout quality uses IoU for positioned parts, but missing/matched and previews use text
    expect(diff.diffs).toEqual(diffFalse.diffs);
    expect(diff.layoutScore).toBe(diffFalse.layoutScore);
    expect(same.matchedParts).toBe(1);
  });

  it("completely different text scores the same as matching text", () => {
    const a = compareParts([ref()], [cand()], 20, { ignoreText: true });
    const b = compareParts([ref()], [differentText], 20, { ignoreText: true });
    expect(b.layoutScore).toBe(a.layoutScore);
    expect(b.styleScore).toBe(a.styleScore);
    expect(b.matchedParts).toBe(a.matchedParts);
    expect(b.diffs).toEqual(a.diffs);
    expect(b.missingParts).toEqual(a.missingParts);
  });

  it("matches a part without a stored position by type alone, independent of text", () => {
    const refNoRect = ref({ rect: null });
    const a = compareParts([refNoRect], [cand()], 20, { ignoreText: true });
    const b = compareParts([refNoRect], [differentText], 20, { ignoreText: true });
    expect(b.layoutScore).toBe(a.layoutScore);
    expect(b.matchedParts).toBe(1);
    // text-based scoring would give a lower score for different text
    const withText = compareParts([refNoRect], [differentText], 20);
    expect(withText.matchedParts).toBe(0);
  });

  it("does not echo reference text previews in diffs or missing parts", () => {
    const r = compareParts(
      [ref(), ref({ partType: "button", text: "Join the club" })],
      [cand({ rect: { x: 300, y: 20, width: 400, height: 50 } })],
      20,
      { ignoreText: true }
    );
    expect(r.diffs.length).toBeGreaterThan(0);
    for (const d of r.diffs) expect(d.textPreview).toBeUndefined();
    expect(r.missingParts.length).toBe(1);
    for (const m of r.missingParts) expect(m.textPreview).toBeUndefined();
  });

  it("still compares layout and style when text is ignored", () => {
    const r = compareParts(
      [ref()],
      [cand({ rect: { x: 300, y: 20, width: 400, height: 50 }, styles: { "font-size": "16px" } })],
      20,
      { ignoreText: true }
    );
    const props = r.diffs.map((d) => d.property);
    expect(props).toContain("rect.x");
    expect(props).toContain("font-size");
  });
});
