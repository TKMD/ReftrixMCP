// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * part-live-geometry のユニットテスト（VR-M-01）
 * Unit tests for part live geometry: paint check, grouping, stability, Node-side re-validation.
 */
import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  PART_PAINT_MIN_PIXELS,
  groupDisjointRects,
  isolationShotsValid,
  isPartLiveGeometryEnabled,
  keepStableGeometry,
  measurePartGeometry,
  paintMatch,
  paintMatchRatio,
  selectPartCandidatePids,
  type PartGeometryMap,
  type RawRgbImage,
} from "../../../src/services/part/part-live-geometry";

function solid(width: number, height: number, rgb: [number, number, number]): RawRgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set(rgb, i * 3);
  return { data, width, height };
}

function paintRect(
  img: RawRgbImage,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: [number, number, number]
): void {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) img.data.set(rgb, (yy * img.width + xx) * 3);
}

// TDA-PPA-M-1: 半透明の画素は背景が分からないので一致の幅が広い。不透明な画素が十分あればそれだけで判定し、
// 半透明の画素しかないときは「半透明だけで一致した」と返して呼び出し側に重なり順で確かめさせる。
// Translucent pixels match a wide range because the real backdrop is unknown: judge on solid
// pixels when there are enough, and flag translucent-only matches for a paint-order check.
describe("paintMatch (TDA-PPA-M-1)", () => {
  const rect = { x: 2, y: 2, width: 10, height: 10 };
  // 白 α 0.6: 事前乗算した色 153、背景が透ける割合 0.4 / white at alpha 0.6 (premultiplied 153)
  const WHITE_06_A: [number, number, number] = [255, 153, 255];
  const WHITE_06_B: [number, number, number] = [153, 255, 153];

  it("judges on the solid pixels when there are enough of them", () => {
    // 白い不透明な芯 4x4 と α 0.6 の白い縁が #ddd の覆いの下にある
    // A solid white 4x4 core with alpha 0.6 white edges, all under a #ddd overlay
    const shot = solid(20, 20, [221, 221, 221]);
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    paintRect(onA, 2, 2, 10, 10, WHITE_06_A);
    paintRect(onB, 2, 2, 10, 10, WHITE_06_B);
    paintRect(onA, 5, 5, 4, 4, [255, 255, 255]);
    paintRect(onB, 5, 5, 4, 4, [255, 255, 255]);
    const m = paintMatch(shot, onA, onB, rect)!;
    expect(m.translucent).toBe(false);
    expect(m.ratio).toBeLessThan(0.8);
    expect(paintMatchRatio(shot, onA, onB, rect)).toBeLessThan(0.8);
  });

  it("flags a match made only of translucent pixels", () => {
    // 白 α 0.6 のボタン全体が #ddd の覆いの下: 画素だけでは見分けられない
    // A white alpha 0.6 button under a #ddd overlay: pixels alone cannot tell
    const shot = solid(20, 20, [221, 221, 221]);
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    paintRect(onA, 2, 2, 10, 10, WHITE_06_A);
    paintRect(onB, 2, 2, 10, 10, WHITE_06_B);
    expect(paintMatch(shot, onA, onB, rect)).toMatchObject({ translucent: true });
  });

  it("does not flag opaque paint", () => {
    const shot = solid(20, 20, [255, 255, 255]);
    paintRect(shot, 2, 2, 10, 10, [10, 20, 30]);
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    paintRect(onA, 2, 2, 10, 10, [10, 20, 30]);
    paintRect(onB, 2, 2, 10, 10, [10, 20, 30]);
    expect(paintMatch(shot, onA, onB, rect)).toEqual({ ratio: 1, translucent: false });
  });
});

describe("paintMatchRatio", () => {
  const rect = { x: 2, y: 2, width: 10, height: 10 };

  it("returns 1 when the part's opaque paint shows unchanged in the screenshot", () => {
    const shot = solid(20, 20, [255, 255, 255]);
    paintRect(shot, 2, 2, 10, 10, [10, 20, 30]);
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    paintRect(onA, 2, 2, 10, 10, [10, 20, 30]);
    paintRect(onB, 2, 2, 10, 10, [10, 20, 30]);
    expect(paintMatchRatio(shot, onA, onB, rect)).toBe(1);
  });

  it("returns a low ratio when something else covers the part in the screenshot", () => {
    const shot = solid(20, 20, [200, 0, 0]); // an overlay painted over everything
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    paintRect(onA, 2, 2, 10, 10, [10, 20, 30]);
    paintRect(onB, 2, 2, 10, 10, [10, 20, 30]);
    expect(paintMatchRatio(shot, onA, onB, rect)).toBe(0);
  });

  it("returns null when the part paints nothing (backdrop shows through everywhere)", () => {
    const shot = solid(20, 20, [255, 255, 255]);
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    expect(paintMatchRatio(shot, onA, onB, rect)).toBeNull();
  });

  it("ignores mostly transparent pixels (alpha below the minimum)", () => {
    const shot = solid(20, 20, [255, 255, 255]);
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    // alpha 0.3 black: A = 0.7 * magenta, B = 0.7 * green
    paintRect(onA, 2, 2, 10, 10, [179, 0, 179]);
    paintRect(onB, 2, 2, 10, 10, [0, 179, 0]);
    expect(paintMatchRatio(shot, onA, onB, rect)).toBeNull();
  });

  it("counts semi-transparent paint and matches it over the real background", () => {
    // alpha 0.95 black text over a white page: shot = 13, A = (13,0,13), B = (0,13,0)
    const shot = solid(20, 20, [255, 255, 255]);
    paintRect(shot, 2, 2, 10, 10, [13, 13, 13]);
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    paintRect(onA, 2, 2, 10, 10, [13, 0, 13]);
    paintRect(onB, 2, 2, 10, 10, [0, 13, 0]);
    expect(paintMatchRatio(shot, onA, onB, rect)).toBe(1);
  });

  it("matches half-transparent paint over any background it could blend with", () => {
    // alpha 0.6 rgb(0,0,200) over a light grey page: shot = 0.6*paint + 0.4*rgb(200,200,200).
    // The page adds 80 per channel, far beyond the tolerance, so only the blend range matches it.
    const shot = solid(20, 20, [200, 200, 200]);
    paintRect(shot, 2, 2, 10, 10, [80, 80, 200]);
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    paintRect(onA, 2, 2, 10, 10, [102, 0, 222]);
    paintRect(onB, 2, 2, 10, 10, [0, 102, 120]);
    expect(paintMatchRatio(shot, onA, onB, rect)).toBe(1);
  });

  it("rejects a pixel just above the brightest blend of half-transparent paint", () => {
    // alpha 0.6 rgb(0,0,200): over white it is (102,102,222); +17 is outside the tolerance
    const shot = solid(20, 20, [255, 255, 255]);
    paintRect(shot, 2, 2, 10, 10, [119, 119, 239]);
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    paintRect(onA, 2, 2, 10, 10, [102, 0, 222]);
    paintRect(onB, 2, 2, 10, 10, [0, 102, 120]);
    expect(paintMatchRatio(shot, onA, onB, rect)).toBe(0);
  });

  it("still rejects semi-transparent paint covered by an opaque overlay", () => {
    const shot = solid(20, 20, [220, 30, 30]); // an overlay painted over everything
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    paintRect(onA, 2, 2, 10, 10, [13, 0, 13]);
    paintRect(onB, 2, 2, 10, 10, [0, 13, 0]);
    expect(paintMatchRatio(shot, onA, onB, rect)).toBe(0);
  });

  it("needs at least PART_PAINT_MIN_PIXELS painted pixels", () => {
    const shot = solid(20, 20, [0, 0, 0]);
    const onA = solid(20, 20, [255, 0, 255]);
    const onB = solid(20, 20, [0, 255, 0]);
    paintRect(onA, 2, 2, PART_PAINT_MIN_PIXELS - 1, 1, [0, 0, 0]);
    paintRect(onB, 2, 2, PART_PAINT_MIN_PIXELS - 1, 1, [0, 0, 0]);
    expect(paintMatchRatio(shot, onA, onB, { x: 0, y: 0, width: 20, height: 20 })).toBeNull();
  });

  it("clamps rects that leave the image", () => {
    const shot = solid(10, 10, [1, 2, 3]);
    const onA = solid(10, 10, [1, 2, 3]);
    const onB = solid(10, 10, [1, 2, 3]);
    expect(paintMatchRatio(shot, onA, onB, { x: -5, y: -5, width: 100, height: 100 })).toBe(1);
  });
});

describe("groupDisjointRects", () => {
  const g = (
    x: number,
    y: number,
    width: number,
    height: number
  ): { x: number; y: number; width: number; height: number } => ({ x, y, width, height });

  it("puts nested and overlapping rects in different groups and disjoint ones together", () => {
    const map: PartGeometryMap = new Map([
      [1, g(0, 0, 100, 100)], // parent
      [2, g(10, 10, 20, 20)], // nested in 1
      [3, g(200, 0, 50, 50)], // disjoint from all
      [4, g(15, 15, 20, 20)], // overlaps 2
    ]);
    const groups = groupDisjointRects(map);
    const groupOf = (pid: number): number => groups.findIndex((gr) => gr.includes(pid));
    expect(groupOf(1)).not.toBe(groupOf(2));
    expect(groupOf(2)).not.toBe(groupOf(4));
    expect(groupOf(1)).not.toBe(groupOf(4));
    expect(groupOf(3)).toBe(groupOf(1));
    expect(groups.flat().sort()).toEqual([1, 2, 3, 4]);
  });

  it("treats touching edges as disjoint", () => {
    const map: PartGeometryMap = new Map([
      [1, g(0, 0, 10, 10)],
      [2, g(10, 0, 10, 10)],
    ]);
    expect(groupDisjointRects(map)).toHaveLength(1);
  });
});

describe("keepStableGeometry", () => {
  it("keeps only elements present in both measurements within tolerance", () => {
    const before: PartGeometryMap = new Map([
      [1, { x: 0, y: 0, width: 10, height: 10 }],
      [2, { x: 0, y: 0, width: 10, height: 10 }],
      [3, { x: 0, y: 0, width: 10, height: 10 }],
    ]);
    const after: PartGeometryMap = new Map([
      [1, { x: 1, y: 2, width: 10, height: 10 }],
      [2, { x: 0, y: 30, width: 10, height: 10 }],
    ]);
    expect([...keepStableGeometry(before, after).keys()]).toEqual([1]);
  });
});

describe("measurePartGeometry Node-side re-validation", () => {
  it("drops unrequested pids, duplicates, non-finite or huge coordinates and malformed rows", async () => {
    const rows: unknown = [
      [1, 0, 0, 10, 10, { "font-size": "12px", bogus: "x" }],
      [1, 5, 5, 10, 10, null], // duplicate
      [2, 0, 0, 10, 10, null], // not requested
      [3, Number.NaN, 0, 10, 10, null],
      [4, 0, 0, 2_000_000, 10, null],
      [5, 0, 0, 0, 10, null],
      ["6", 0, 0, 10, 10, null],
      [7, 0, 0, 10],
      "garbage",
    ];
    const page = { evaluate: async () => rows } as unknown as Page;
    const map = await measurePartGeometry(page, [1, 3, 4, 5, 6, 7], true);
    expect([...map.keys()]).toEqual([1]);
    expect(map.get(1)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      styles: { "font-size": "12px" },
    });
  });

  it("returns an empty map when the page returns a non-array", async () => {
    const page = { evaluate: async () => ({ length: 3 }) } as unknown as Page;
    expect((await measurePartGeometry(page, [1], false)).size).toBe(0);
  });
});

describe("selectPartCandidatePids", () => {
  it("keeps only elements that identify a part type", () => {
    const pids = selectPartCandidatePids([
      { pid: 0, tagName: "DIV", classAttr: null, role: null },
      { pid: 1, tagName: "BUTTON", classAttr: null, role: null },
      { pid: 2, tagName: "SPAN", classAttr: null, role: null },
    ]);
    expect(pids).toEqual([1]);
  });
});

describe("isPartLiveGeometryEnabled", () => {
  it("is on only for the exact string true", () => {
    expect(isPartLiveGeometryEnabled({})).toBe(false);
    expect(isPartLiveGeometryEnabled({ PART_LIVE_GEOMETRY_ENABLED: "1" })).toBe(false);
    expect(isPartLiveGeometryEnabled({ PART_LIVE_GEOMETRY_ENABLED: "true" })).toBe(true);
  });
});

describe("isolationShotsValid", () => {
  const rects = [{ x: 2, y: 2, width: 10, height: 10 }];
  it("accepts shots whose pixels outside the candidates show the two backdrops", () => {
    const a = solid(40, 40, [255, 0, 255]);
    const b = solid(40, 40, [0, 255, 0]);
    paintRect(a, 2, 2, 10, 10, [10, 10, 10]);
    paintRect(b, 2, 2, 10, 10, [10, 10, 10]);
    expect(isolationShotsValid(a, b, rects)).toBe(true);
  });
  it("accepts shots where the candidates' subtrees paint far outside their boxes", () => {
    // an inline link whose image overflows: most of the shot is the image, not the backdrop
    const a = solid(40, 40, [255, 0, 255]);
    const b = solid(40, 40, [0, 255, 0]);
    paintRect(a, 0, 0, 40, 24, [120, 80, 40]);
    paintRect(b, 0, 0, 40, 24, [120, 80, 40]);
    expect(isolationShotsValid(a, b, rects)).toBe(true);
  });

  it("rejects a stale frame (the shots show the page instead of the backdrops)", () => {
    const page = solid(40, 40, [250, 250, 250]);
    expect(isolationShotsValid(page, page, rects)).toBe(false);
  });
});
