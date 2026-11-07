// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Chromium check of the bbox measurement body: computed styles are read in the browser,
 * limited to `PART_COMPUTED_STYLE_KEYS` and cut to `PART_COMPUTED_STYLE_MAX_CHARS` there
 * (a page cannot hand back an unbounded value).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { runBboxPageEvaluate } from "../../../src/services/part/part-bbox-playwright.service";
import {
  PART_COMPUTED_STYLE_KEYS,
  PART_COMPUTED_STYLE_MAX_CHARS,
} from "../../../src/services/part/types";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const longFamily = Array.from({ length: 80 }, (_, i) => `Family${i}`).join(", ");

describe("runBboxPageEvaluate computed styles (real Chromium)", () => {
  it("returns kebab-case computed styles for the matched element, bounded per value", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <section id="s1" style="padding:0">
          <h1 class="t" style="font-size:32px;font-weight:700;color:rgb(10, 20, 30);font-family:${longFamily}">Hello</h1>
        </section></body></html>`);
      const [r] = await runBboxPageEvaluate(page, [
        {
          id: "p1",
          sectionSelector: "#s1",
          selectors: ["h1.t", "h1"],
          sectionStartY: 0,
          sampleIndex: 0,
          styleKeys: [...PART_COMPUTED_STYLE_KEYS],
          styleMaxChars: PART_COMPUTED_STYLE_MAX_CHARS,
        },
      ]);
      expect(r).not.toBeNull();
      expect(r!.styles?.["font-size"]).toBe("32px");
      expect(r!.styles?.["font-weight"]).toBe("700");
      expect(r!.styles?.["color"]).toBe("rgb(10, 20, 30)");
      expect(r!.styles?.["font-family"]?.length).toBe(PART_COMPUTED_STYLE_MAX_CHARS);
      for (const key of Object.keys(r!.styles ?? {})) {
        expect(PART_COMPUTED_STYLE_KEYS as readonly string[]).toContain(key);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
});
