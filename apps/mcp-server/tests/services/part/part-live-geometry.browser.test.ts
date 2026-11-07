// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 実 Chromium でのパーツ実測（VR-M-01）: 番号付け → 測定 → スクリーンショット → 描画確認。
 * Real-Chromium check of part live geometry: numbering, measurement, screenshot and paint check.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  PART_PID_ATTR,
  PartGeometryCapture,
  assignPartPids,
  groupDisjointRects,
  keepPaintedGeometry,
} from "../../../src/services/part/part-live-geometry";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const BTN =
  "display:block;width:160px;height:48px;background:rgb(20,90,200);color:#fff;border:0;font-size:18px";

const PAGE = `<!doctype html><html><body style="margin:0;background:#fff">
  <button id="visible" style="${BTN}">Visible</button>
  <button id="planted" ${PART_PID_ATTR}="999" style="${BTN}">Planted</button>
  <button id="hidden" style="${BTN};display:none">Hidden</button>
  <button id="transparent" style="${BTN};opacity:0">Transparent</button>
  <button id="nopointer" style="${BTN};pointer-events:none">No pointer</button>
  <div style="position:relative;width:300px">
    <button id="covered" style="${BTN}">Covered</button>
    <div style="position:absolute;inset:0;background:rgb(200,30,30)"></div>
  </div>
  <div style="position:relative;width:300px">
    <button id="underlink" style="${BTN}">Card</button>
    <a href="#x" style="position:absolute;inset:0"></a>
  </div>
  <div style="height:20px;overflow:hidden">
    <button id="clipped" style="${BTN};margin-top:40px">Clipped</button>
  </div>
  <a id="softtext" href="#t" style="display:inline-block;color:rgba(0,0,0,0.9);font:600 22px sans-serif">Soft text</a>
  <a id="smalltext" href="#s" style="display:inline-block;color:#333;font:11px sans-serif">small link</a>
  <svg style="display:none"><symbol id="ico" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" fill="rgb(30,30,30)"/></symbol></svg>
  <button id="spriteicon" aria-label="Sprite" style="display:block;width:32px;height:32px;padding:4px;border:0;background:transparent"><svg width="24" height="24"><use href="#ico"></use></svg></button>
  <div style="position:relative;width:300px;height:160px">
    <a id="gradcard" href="#g" style="display:block;width:300px;height:160px;background:rgb(40,140,90)"></a>
    <div style="position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,0) 0%,rgba(0,0,0,0.75) 100%)"></div>
    <span style="position:absolute;left:12px;bottom:10px;color:#fff;font:600 16px sans-serif">Caption</span>
  </div>
  <a id="moving" href="#m" style="display:inline-block;padding:8px;background:rgb(200,120,20);color:#000;animation:slide 0.4s linear infinite">Moving</a>
  <style>@keyframes slide{from{transform:translateX(0)}to{transform:translateX(400px)}}</style>
  <div style="height:1500px"></div>
  <button id="below" style="${BTN}">Below the fold</button>
</body></html>`;

async function pidOf(page: Page, id: string): Promise<number | null> {
  const v = await page.evaluate(
    (a: { id: string; attr: string }) =>
      document.getElementById(a.id)?.getAttribute(a.attr) ?? null,
    { id, attr: PART_PID_ATTR }
  );
  return v === null ? null : Number(v);
}

describe("PartGeometryCapture (real Chromium)", () => {
  it("keeps only parts whose own paint shows in the full-page screenshot", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(PAGE);
      const cap = new PartGeometryCapture();
      await cap.start(page);
      const html = await page.content();
      expect(html).toContain(PART_PID_ATTR);
      // ページが仕込んだ番号は振り直される / A page-planted pid is replaced by our numbering
      expect(await pidOf(page, "planted")).not.toBe(999);

      await cap.beforeScreenshot(page);
      const png = await page.screenshot({ fullPage: true, type: "png" });
      const geo = await cap.afterScreenshot(page, true, 800, png);
      expect(geo).not.toBeNull();

      const kept = async (id: string): Promise<boolean> => geo!.has((await pidOf(page, id))!);
      expect(await kept("visible")).toBe(true);
      expect(await kept("planted")).toBe(true);
      expect(await kept("nopointer")).toBe(true);
      expect(await kept("underlink")).toBe(true);
      expect(await kept("below")).toBe(true);
      // 半透明の文字・小さな文字・SVG スプライトのアイコンも描画として数える
      // Semi-transparent text, small text and SVG sprite icons count as painted
      expect(await kept("softtext")).toBe(true);
      expect(await kept("smalltext")).toBe(true);
      expect(await kept("spriteicon")).toBe(true);
      // 半透明のグラデーションと短い見出しが重なるカードは重なり順で残す
      // A card under a translucent gradient and a short caption is kept by paint order
      expect(await kept("gradcard")).toBe(true);
      // 撮影の間アニメーションを止めるので、動き続ける要素も位置がずれない
      // Animations are paused during the capture, so a moving element keeps its position
      expect(await kept("moving")).toBe(true);
      expect(await kept("hidden")).toBe(false);
      expect(await kept("transparent")).toBe(false);
      expect(await kept("covered")).toBe(false);
      expect(await kept("clipped")).toBe(false);

      const v = geo!.get((await pidOf(page, "visible"))!)!;
      expect(v).toMatchObject({ x: 0, y: 0, width: 160, height: 48 });
      expect(v.styles?.["background-color"]).toBe("rgb(20, 90, 200)");

      // 描画確認の後始末: 一時属性とスタイルシートが残らない / The paint check leaves nothing behind
      const leftovers = await page.evaluate(() => ({
        iso: document.querySelectorAll("[data-reftrix-iso]").length,
        sheets: document.adoptedStyleSheets.length,
        handle: "__reftrixIso" in window,
      }));
      expect(leftovers).toEqual({ iso: 0, sheets: 0, handle: false });
      // 測定が終わればアニメーションは再び動く / Animations run again after the measurement
      const t0 = await page.evaluate(() => Number(document.getAnimations()[0]?.currentTime ?? -1));
      await page.waitForTimeout(150);
      const t1 = await page.evaluate(() => Number(document.getAnimations()[0]?.currentTime ?? -1));
      expect(t1).toBeGreaterThan(t0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("does not rescue parts under a modal scrim or an opaque layer", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">
        <button id="dimmed" style="${BTN}">Dimmed</button>
        <div style="position:fixed;inset:0;background:rgba(0,0,0,0.5)"></div>
        <div style="position:fixed;left:0;bottom:0;width:400px;height:200px;background:#fff;color:#000">Dialog</div>
        <div style="height:1200px"></div>
        <div style="position:relative;width:300px">
          <button id="sheet" style="${BTN}">Under sheet</button>
          <div style="position:absolute;inset:0;background:rgb(240,240,240)"></div>
        </div>
      </body></html>`);
      const cap = new PartGeometryCapture();
      await cap.start(page);
      await page.content();
      await cap.beforeScreenshot(page);
      const png = await page.screenshot({ fullPage: true, type: "png" });
      const geo = await cap.afterScreenshot(page, true, 800, png);
      const kept = async (id: string): Promise<boolean> =>
        geo?.has((await pidOf(page, id))!) ?? false;
      expect(await kept("dimmed")).toBe(false);
      expect(await kept("sheet")).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);

  // TDA-PPA-M-1: 半透明のパーツが同系色の不透明な覆いの下にあると画素だけでは一致に見える
  // A translucent part under a similar-coloured opaque layer looks matched by pixels alone
  it("drops a translucent part under a similar-coloured opaque layer and keeps it uncovered", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const LIGHT = "display:block;width:160px;height:48px;background:#fff;opacity:0.6;border:0";
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#888">
        <button id="open" style="${LIGHT}"></button>
        <div style="position:relative;width:300px;margin-top:20px">
          <button id="consent" style="${LIGHT}"></button>
          <div style="position:absolute;inset:0;background:#ddd"></div>
        </div>
      </body></html>`);
      const cap = new PartGeometryCapture();
      await cap.start(page);
      await page.content();
      await cap.beforeScreenshot(page);
      const png = await page.screenshot({ fullPage: true, type: "png" });
      const geo = await cap.afterScreenshot(page, true, 800, png);
      const kept = async (id: string): Promise<boolean> =>
        geo?.has((await pidOf(page, id))!) ?? false;
      expect(await kept("open")).toBe(true);
      expect(await kept("consent")).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);

  // TDA-PPA-M-1 監査 L-2: 重なり順が無ければ半透明だけの一致は残さず、不透明な描画は残す
  // Without a paint order, translucent-only matches are dropped and opaque paint is kept
  it("drops translucent-only matches without a paint-order snapshot", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">
        <button id="solid" style="${BTN}">Solid</button>
        <button id="faded" style="${BTN};opacity:0.5;margin-top:20px">Faded</button>
      </body></html>`);
      const cap = new PartGeometryCapture();
      await cap.start(page);
      await cap.beforeScreenshot(page);
      const png = await page.screenshot({ fullPage: true, type: "png" });
      const stable = (await cap.afterScreenshot(page, true, 600))!;
      const withOrder = await keepPaintedGeometry(page, stable, png, true);
      const without = await keepPaintedGeometry(page, stable, png, true, undefined, undefined, {
        snapshot: null,
      });
      const solid = (await pidOf(page, "solid"))!;
      const faded = (await pidOf(page, "faded"))!;
      expect(withOrder.has(solid) && withOrder.has(faded)).toBe(true);
      expect(without.has(solid)).toBe(true);
      expect(without.has(faded)).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("returns null and does not throw when the page breaks the measurement", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(`<!doctype html><html><body><button>Go</button></body></html>`);
      const cap = new PartGeometryCapture();
      await cap.start(page);
      await page.close();
      await cap.beforeScreenshot(page);
      expect(await cap.afterScreenshot(page, true, 600, Buffer.alloc(0))).toBeNull();
    } finally {
      if (!page.isClosed()) await page.close();
    }
  }, 30_000);

  it("stops after the time budget and drops candidates it could not check", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <div style="position:relative;width:300px">
          <button style="${BTN}">Under</button>
          <a href="#y" style="position:absolute;left:0;top:0;width:300px;height:60px;color:#000;font-size:20px">Over</a>
        </div>
        <button style="${BTN};margin-top:20px">Alone</button></body></html>`);
      const cap = new PartGeometryCapture();
      await cap.start(page);
      await cap.beforeScreenshot(page);
      const png = await page.screenshot({ fullPage: true, type: "png" });
      const stable = (await cap.afterScreenshot(page, true, 600))!;
      const groups = groupDisjointRects(stable);
      expect(groups.length).toBeGreaterThan(1);

      const unlimited = await keepPaintedGeometry(page, stable, png, true);
      // 時計は呼ぶたびに 1 秒進む: 開始 → 1 組目の前（残り 0.5 秒）→ 2 組目の前（使い切り）
      // The clock advances 1 s per call: start, before group 1 (0.5 s left), before group 2 (none)
      let t = 0;
      const limited = await keepPaintedGeometry(page, stable, png, true, 1500, () => (t += 1000));
      // 候補の多い組だけが確認される / Only the largest group is checked
      const largest = [...groups].sort((p, q) => q.length - p.length)[0]!;
      expect(limited.size).toBeGreaterThan(0);
      expect([...limited.keys()].every((pid) => largest.includes(pid))).toBe(true);
      expect(limited.size).toBeLessThan(unlimited.size);
      // 予算 0 なら何も確認しない / With no budget nothing is checked
      expect((await keepPaintedGeometry(page, stable, png, true, 0)).size).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  async function capture(
    page: Page,
    html: string,
    opts: { deadlineAt?: number; beforeContent?: () => Promise<void> } = {}
  ): Promise<Map<number, unknown> | null> {
    await page.setContent(html);
    const cap = new PartGeometryCapture();
    await cap.start(page);
    if (opts.beforeContent) await opts.beforeContent();
    cap.noteSerializedHtml(await page.content());
    await cap.beforeScreenshot(page);
    const png = await page.screenshot({ fullPage: true, type: "png" });
    return cap.afterScreenshot(page, true, 600, png, opts.deadlineAt);
  }

  it("drops a part covered by an overlay that has a CSS transition", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      const geo = await capture(
        page,
        `<!doctype html><html><body style="margin:0">
          <button id="ok" style="${BTN}">Ok</button>
          <div style="position:relative;width:300px">
            <button id="covered" style="${BTN}">Covered</button>
            <div style="position:absolute;inset:0;background:rgb(200,30,30);transition:all 1s"></div>
          </div></body></html>`
      );
      expect(geo!.has((await pidOf(page, "ok"))!)).toBe(true);
      expect(geo!.has((await pidOf(page, "covered"))!)).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("does not use a pid the page copied onto another element", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      const geo = await capture(
        page,
        `<!doctype html><html><body style="margin:0">
          <button id="h" style="${BTN};display:none">Hidden</button>
          <button id="v" style="${BTN}">Visible</button>
          <button id="other" style="${BTN}">Other</button></body></html>`,
        {
          beforeContent: async () => {
            await page.evaluate((attr: string) => {
              const v = document.getElementById("v")!.getAttribute(attr)!;
              document.getElementById("h")!.setAttribute(attr, v);
            }, PART_PID_ATTR);
          },
        }
      );
      expect(geo!.has((await pidOf(page, "v"))!)).toBe(false);
      expect(geo!.has((await pidOf(page, "other"))!)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("falls back (null) when no time is left before the ingest deadline or nothing is kept", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      const html = `<!doctype html><html><body style="margin:0"><button style="${BTN}">Go</button></body></html>`;
      expect(await capture(page, html, { deadlineAt: Date.now() + 1000 })).toBeNull();
      expect(await capture(page, html)).not.toBeNull();
      const covered = `<!doctype html><html><body style="margin:0"><div style="position:relative">
        <button style="${BTN}">Go</button>
        <div style="position:absolute;inset:0;background:#000"></div></div></body></html>`;
      expect(await capture(page, covered)).toBeNull();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("does not number a page with more elements than the cap", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(`<!doctype html><html><body>${"<p>x</p>".repeat(10)}</body></html>`);
      await expect(assignPartPids(page, 5)).rejects.toThrow(/more than 5 elements/);
      expect(
        await page.evaluate(
          (attr: string) => document.querySelectorAll("[" + attr + "]").length,
          PART_PID_ATTR
        )
      ).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);
});
