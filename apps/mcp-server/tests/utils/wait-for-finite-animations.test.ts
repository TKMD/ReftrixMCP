// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-CAPTURE-FINITE-ANIMATION-WAIT-001
 *
 * 撮影前に、有限の CSS / Web Animations（フェードインなど）の完了を上限付きで待つ。
 * 無限ループのアニメーションと一時停止中のアニメーションは待たない。上限を超えたら打ち切る。
 *
 * Before the screenshot, wait (with a cap) for finite CSS / Web Animations such as
 * fade-ins to finish. Infinite and paused animations are not waited for; the cap ends
 * the wait.
 *
 * 起点 / Origin: 2026-11-08 kurokawawonderland.jp — the stored screenshot was taken
 * before the per-letter fade-in finished, so the title and ENTER button were missing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { waitForFiniteAnimations } from "../../src/utils/wait-for-finite-animations";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

async function pageWith(html: string): Promise<Page> {
  const page = await browser.newPage();
  // setContent は外部通信をしない / setContent makes no network request
  await page.setContent(html);
  return page;
}

const opacityOf = (page: Page, sel: string): Promise<number> =>
  page.$eval(sel, (el) => parseFloat(getComputedStyle(el).opacity));

describe("INV-CAPTURE-FINITE-ANIMATION-WAIT-001 waitForFiniteAnimations", () => {
  it("waits until a staggered CSS fade-in has finished", async () => {
    const page = await pageWith(`
      <style>
        .f { opacity: 0; animation: fade .6s forwards; }
        @keyframes fade { to { opacity: 1; } }
      </style>
      <span class="f" style="animation-delay:.1s">A</span>
      <span class="f" id="last" style="animation-delay:.4s">B</span>`);
    expect(await opacityOf(page, "#last")).toBeLessThan(1);

    const result = await waitForFiniteAnimations(page, 5000);

    expect(result.timedOut).toBe(false);
    expect(result.animationCount).toBe(2);
    expect(await opacityOf(page, "#last")).toBe(1);
    await page.close();
  });

  it("returns at once when only infinite animations run", async () => {
    const page = await pageWith(`
      <style>.spin { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }</style>
      <div class="spin">x</div>`);

    const result = await waitForFiniteAnimations(page, 5000);

    expect(result.timedOut).toBe(false);
    expect(result.animationCount).toBe(0);
    expect(result.waitedMs).toBeLessThan(1500);
    await page.close();
  });

  it("does not wait for a paused animation", async () => {
    const page = await pageWith(`
      <style>.p { animation: fade 10s forwards paused; }
      @keyframes fade { to { opacity: 1; } }</style>
      <div class="p">x</div>`);

    const result = await waitForFiniteAnimations(page, 5000);

    expect(result.timedOut).toBe(false);
    expect(result.animationCount).toBe(0);
    await page.close();
  });

  it("stops at the cap for a long finite animation", async () => {
    const page = await pageWith(`
      <style>.slow { animation: fade 30s forwards; }
      @keyframes fade { to { opacity: 1; } }</style>
      <div class="slow">x</div>`);

    const result = await waitForFiniteAnimations(page, 400);

    expect(result.timedOut).toBe(true);
    expect(result.animationCount).toBe(1);
    expect(result.waitedMs).toBeLessThan(2500);
    await page.close();
  });

  it("also waits for an animation started a moment later by script", async () => {
    const page = await pageWith(`
      <style>.f { opacity: 0; } .f.on { animation: fade .3s forwards; }
      @keyframes fade { to { opacity: 1; } }</style>
      <div class="f" id="late">x</div>
      <script>setTimeout(() => document.getElementById('late').classList.add('on'), 50);</script>`);

    const result = await waitForFiniteAnimations(page, 5000);

    expect(result.timedOut).toBe(false);
    expect(await opacityOf(page, "#late")).toBe(1);
    await page.close();
  });

  it("still returns near the cap when the page overrides its clock and timers (SEC M-1)", async () => {
    const page = await pageWith(`
      <style>.slow { animation: fade 30s forwards; }
      @keyframes fade { to { opacity: 1; } }</style>
      <div class="slow">x</div>
      <script>
        performance.now = () => 0;
        window.setTimeout = () => 0;
      </script>`);

    const started = Date.now();
    const result = await waitForFiniteAnimations(page, 400);

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(400 + 1000 + 1500);
    await page.close();
  });

  it("returns a zero result for a non-positive cap without touching the page", async () => {
    const page = await pageWith(`<div>x</div>`);
    const result = await waitForFiniteAnimations(page, 0);
    expect(result).toEqual({ animationCount: 0, waitedMs: 0, timedOut: false });
    await page.close();
  });
});
