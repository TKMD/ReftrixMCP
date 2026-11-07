// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 重なり順による救済（VR-M-01）: 描画確認で一致しなかった候補のうち、上に描かれるのが
 * 半透明の層・少しの文字・自分の子孫だけのものを残す。
 * Paint-order rescue: among candidates the paint check rejected, keep those painted over only by
 * translucent layers, a little text or their own subtree.
 */
import { describe, expect, it } from "vitest";
import {
  PART_PAINT_ORDER_STYLES,
  findPaintOrderRescues,
} from "../../../src/services/part/part-paint-order";
import { PART_PID_ATTR, type PartGeometryMap } from "../../../src/services/part/part-live-geometry";

type Style = Partial<Record<(typeof PART_PAINT_ORDER_STYLES)[number], string>>;
interface FakeNode {
  name: string;
  parent: number;
  type?: number;
  pid?: number;
  /** layout box; omitted → no layout object */
  box?: [number, number, number, number];
  paintOrder?: number;
  style?: Style;
}

/** CDP DOMSnapshot.captureSnapshot の形を組み立てる / Builds a DOMSnapshot-shaped object */
function snapshot(nodes: FakeNode[]): unknown {
  const strings: string[] = [];
  const s = (v: string): number => {
    const i = strings.indexOf(v);
    if (i >= 0) return i;
    strings.push(v);
    return strings.length - 1;
  };
  const layout = {
    nodeIndex: [] as number[],
    bounds: [] as number[][],
    paintOrders: [] as number[],
    styles: [] as number[][],
  };
  nodes.forEach((n, i) => {
    if (!n.box) return;
    layout.nodeIndex.push(i);
    layout.bounds.push(n.box);
    layout.paintOrders.push(n.paintOrder ?? i);
    layout.styles.push(PART_PAINT_ORDER_STYLES.map((k) => (n.style?.[k] ? s(n.style[k]!) : -1)));
  });
  return {
    documents: [
      {
        nodes: {
          parentIndex: nodes.map((n) => n.parent),
          nodeType: nodes.map((n) => n.type ?? 1),
          nodeName: nodes.map((n) => s(n.name)),
          attributes: nodes.map((n) =>
            n.pid === undefined ? [] : [s(PART_PID_ATTR), s(String(n.pid))]
          ),
        },
        layout,
      },
    ],
    strings,
  };
}

const VIEWPORT = { width: 1280, height: 800 };
const CARD: [number, number, number, number] = [100, 100, 300, 200];
const geo = (pid: number, b = CARD): PartGeometryMap =>
  new Map([[pid, { x: b[0], y: b[1], width: b[2], height: b[3] }]]);

/** 画像のパーツとその上の兄弟要素 / An image part and siblings painted after it */
function cardWith(...above: FakeNode[]): unknown {
  return snapshot([
    { name: "HTML", parent: -1, box: [0, 0, 1280, 2000], paintOrder: 0 },
    { name: "DIV", parent: 0, box: CARD, paintOrder: 1 },
    { name: "IMG", parent: 1, pid: 7, box: CARD, paintOrder: 2 },
    ...above,
  ]);
}

describe("findPaintOrderRescues", () => {
  it("rescues an image under a translucent gradient and a short caption", () => {
    const snap = cardWith(
      {
        name: "::after",
        parent: 1,
        box: CARD,
        paintOrder: 3,
        style: {
          "background-image": "linear-gradient(rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.7) 100%)",
        },
      },
      { name: "#text", type: 3, parent: 1, box: [110, 250, 200, 40], paintOrder: 4 }
    );
    expect(findPaintOrderRescues(snap, geo(7), VIEWPORT)).toEqual(new Set([7]));
  });

  it("does not rescue a part under an opaque layer", () => {
    const snap = cardWith({
      name: "DIV",
      parent: 1,
      box: [100, 100, 300, 120],
      paintOrder: 3,
      style: { "background-color": "rgb(255, 255, 255)" },
    });
    expect(findPaintOrderRescues(snap, geo(7), VIEWPORT).size).toBe(0);
  });

  it("does not rescue a part under an image painted above it", () => {
    const snap = cardWith({ name: "IMG", parent: 1, box: CARD, paintOrder: 3 });
    expect(findPaintOrderRescues(snap, geo(7), VIEWPORT).size).toBe(0);
  });

  it("does not rescue a part mostly covered by someone else's text", () => {
    const snap = cardWith({ name: "#text", type: 3, parent: 1, box: CARD, paintOrder: 3 });
    expect(findPaintOrderRescues(snap, geo(7), VIEWPORT).size).toBe(0);
  });

  it("treats a fixed translucent layer over most of the viewport as a modal scrim", () => {
    const snap = cardWith({
      name: "DIV",
      parent: 0,
      box: [0, 0, 1280, 800],
      paintOrder: 3,
      style: { "background-color": "rgba(0, 0, 0, 0.5)", position: "fixed" },
    });
    expect(findPaintOrderRescues(snap, geo(7), VIEWPORT).size).toBe(0);
  });

  it("counts an opaque layer as translucent when an ancestor's opacity fades it", () => {
    const snap = snapshot([
      { name: "HTML", parent: -1, box: [0, 0, 1280, 2000], paintOrder: 0 },
      { name: "IMG", parent: 0, pid: 7, box: CARD, paintOrder: 1 },
      { name: "DIV", parent: 0, box: CARD, paintOrder: 2, style: { opacity: "0.3" } },
      {
        name: "DIV",
        parent: 2,
        box: CARD,
        paintOrder: 3,
        style: { "background-color": "rgb(0, 0, 0)" },
      },
    ]);
    expect(findPaintOrderRescues(snap, geo(7), VIEWPORT)).toEqual(new Set([7]));
  });

  it("ignores the part's own subtree and boxes that paint nothing", () => {
    const snap = snapshot([
      { name: "HTML", parent: -1, box: [0, 0, 1280, 2000], paintOrder: 0 },
      { name: "A", parent: 0, pid: 7, box: CARD, paintOrder: 1 },
      { name: "IMG", parent: 1, box: CARD, paintOrder: 2 },
      { name: "DIV", parent: 0, box: CARD, paintOrder: 3 },
    ]);
    expect(findPaintOrderRescues(snap, geo(7), VIEWPORT)).toEqual(new Set([7]));
  });

  it("ignores layers painted before the part and layers that do not overlap it", () => {
    const snap = snapshot([
      { name: "HTML", parent: -1, box: [0, 0, 1280, 2000], paintOrder: 0 },
      { name: "DIV", parent: 0, box: CARD, paintOrder: 1, style: { "background-color": "red" } },
      { name: "IMG", parent: 0, pid: 7, box: CARD, paintOrder: 2 },
      { name: "IMG", parent: 0, box: [600, 100, 100, 100], paintOrder: 3 },
    ]);
    expect(findPaintOrderRescues(snap, geo(7), VIEWPORT)).toEqual(new Set([7]));
  });

  it("does not rescue a pid the snapshot does not contain", () => {
    expect(findPaintOrderRescues(cardWith(), geo(8), VIEWPORT).size).toBe(0);
  });

  it("returns nothing for a malformed snapshot", () => {
    for (const bad of [
      null,
      {},
      { documents: [] },
      { documents: [{ nodes: {}, layout: {} }], strings: [] },
      { documents: [{ nodes: { parentIndex: "x" }, layout: { nodeIndex: [0] } }], strings: [] },
    ]) {
      expect(findPaintOrderRescues(bad, geo(7), VIEWPORT).size).toBe(0);
    }
  });
});

// INV-PART-PAINT-ORDER-BOUNDED-001: 敵対的なページでも救済の判定は有限の時間で終わり、
// 締め切りを過ぎたら救済しない（同期処理がイベントループを止めない）。
// The rescue finishes in bounded time on hostile pages and rescues nothing past its deadline.
describe("findPaintOrderRescues bounds (INV-PART-PAINT-ORDER-BOUNDED-001)", () => {
  it("finishes quickly with 1,000 candidates under 18,000 full-page opaque layers", () => {
    const nodes: FakeNode[] = [
      { name: "HTML", parent: -1, box: [0, 0, 1280, 20000], paintOrder: 0 },
    ];
    const cands: PartGeometryMap = new Map();
    for (let i = 0; i < 1000; i++) {
      const b: [number, number, number, number] = [(i % 20) * 60, Math.floor(i / 20) * 40, 50, 30];
      nodes.push({ name: "BUTTON", parent: 0, pid: i, box: b, paintOrder: 1 + i });
      cands.set(i, { x: b[0], y: b[1], width: b[2], height: b[3] });
    }
    for (let i = 0; i < 18000; i++) {
      nodes.push({
        name: "DIV",
        parent: 0,
        box: [0, 0, 1280, 20000],
        paintOrder: 2000 + i,
        style: { "background-color": "rgb(0, 0, 0)" },
      });
    }
    const snap = snapshot(nodes);
    const t0 = Date.now();
    expect(findPaintOrderRescues(snap, cands, VIEWPORT).size).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 30_000);

  it("finishes quickly on an 18,000-level deep tree", () => {
    const nodes: FakeNode[] = [
      { name: "HTML", parent: -1, box: [0, 0, 1280, 2000], paintOrder: 0 },
    ];
    for (let i = 1; i < 18000; i++) {
      nodes.push({ name: "DIV", parent: i - 1, box: [0, 0, 1280, 2000], paintOrder: i });
    }
    const cands: PartGeometryMap = new Map();
    for (let i = 0; i < 50; i++) {
      nodes.push({ name: "IMG", parent: 100 + i, pid: i, box: CARD, paintOrder: 100 + i });
      cands.set(i, { x: CARD[0], y: CARD[1], width: CARD[2], height: CARD[3] });
    }
    const snap = snapshot(nodes);
    const t0 = Date.now();
    findPaintOrderRescues(snap, cands, VIEWPORT);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 30_000);

  it("rescues nothing once the deadline has passed", () => {
    const snap = cardWith({
      name: "::after",
      parent: 1,
      box: CARD,
      paintOrder: 3,
      style: {
        "background-image": "linear-gradient(rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.7) 100%)",
      },
    });
    expect(
      findPaintOrderRescues(snap, geo(7), VIEWPORT, { deadlineAt: 0, now: () => 1 }).size
    ).toBe(0);
  });
});

describe("findPaintOrderRescues long background strings (SEC M-3)", () => {
  it("finishes quickly when thousands of layers share one huge gradient string", () => {
    const stops = Array.from({ length: 20000 }, (_, i) => `rgb(${i % 256}, 0, 0) ${i / 200}%`);
    const huge = `linear-gradient(${stops.join(", ")})`;
    const nodes: FakeNode[] = [
      { name: "HTML", parent: -1, box: [0, 0, 1280, 2000], paintOrder: 0 },
    ];
    nodes.push({ name: "IMG", parent: 0, pid: 1, box: CARD, paintOrder: 1 });
    for (let i = 0; i < 20000; i++) {
      nodes.push({
        name: "DIV",
        parent: 0,
        box: [CARD[0] + (i % 300), CARD[1], 1, 1],
        paintOrder: 2 + i,
        style: { "background-image": huge, opacity: "0.5" },
      });
    }
    const t0 = Date.now();
    findPaintOrderRescues(snapshot(nodes), geo(1), VIEWPORT);
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 60_000);

  it("treats a background-image string too long to parse as opaque", () => {
    const stops = Array.from({ length: 2000 }, () => "rgba(0, 0, 0, 0)");
    const snap = cardWith({
      name: "DIV",
      parent: 1,
      box: CARD,
      paintOrder: 3,
      style: { "background-image": `linear-gradient(${stops.join(", ")})` },
    });
    expect(findPaintOrderRescues(snap, geo(7), VIEWPORT).size).toBe(0);
  });
});
