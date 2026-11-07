// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.verify_reproduction: offline, script-free render of a candidate HTML/CSS pair.
 * design.verify_reproduction: 候補 HTML/CSS をオフライン・スクリプト無効で描画する。
 *
 * Security boundary (INV-SEC-VERIFY-REPRO-OFFLINE-001 / INV-SEC-VERIFY-REPRO-NO-JS-001):
 * - the browser is started with `launchChromium()` (egress guard proxy stays on);
 * - a fresh context with `javaScriptEnabled: false` and `offline: true`;
 * - every request that is not a `data:` URL is aborted and only COUNTED (host names are
 *   never kept: the candidate is not echoed, stored or logged);
 * - the page is built with `page.setContent`, no navigation to a candidate-controlled URL.
 *
 * セキュリティ境界: launchChromium（送信先検査プロキシ有効）+ JS 無効 + offline の新規 context。
 * data: 以外の全リクエストを abort し件数のみ数える（ホスト名は保持しない）。候補は保存・ログ・返却しない。
 *
 * @module services/design/reproduction-render.service
 */

import type { Browser, BrowserContext } from "playwright";
import { launchChromium } from "../../utils/launch-chromium";
import { partBboxLaunchSemaphore } from "../../utils/launch-semaphore";
import { logger } from "../../utils/logger";
import { identifyPartTypeFromAttrs } from "../part/part-extraction.service";
import { STYLE_KEYS, MAX_CANDIDATE_PARTS, type CandidatePart } from "./reproduction-scoring";

/** Whole-render timeout (setContent / screenshot / evaluate). */
export const RENDER_TIMEOUT_MS = 15_000;
/** Hard cap on the rendered viewport height (CWE-770). */
export const MAX_RENDER_HEIGHT_PX = 8000;
export const MIN_RENDER_WIDTH_PX = 320;
export const MAX_RENDER_WIDTH_PX = 3840;
/** Elements read back from the DOM (bounds the evaluate payload). */
const MAX_DOM_ELEMENTS = 5000;
const MAX_TEXT_CHARS = 300;
/**
 * Computed-style values are truncated inside the browser: an inherited value (for example a huge
 * `font-family`) is repeated on every element and would otherwise amplify the input thousands of
 * times through the Playwright pipe (CWE-770).
 */
export const MAX_STYLE_VALUE_CHARS = 128;
/**
 * `class` / `role` are truncated inside the browser too: the HTML parser re-creates formatting
 * elements (`<a>`, `<b>`, ...) with their attributes each time a `<p>` closes them, so one long
 * attribute can be cloned thousands of times. A total budget stops returning attributes past it.
 */
export const MAX_ATTR_CHARS = 256;
export const MAX_RETURNED_ATTR_CHARS_TOTAL = 1_000_000;
/** One deadline for the whole render (setContent + screenshot + DOM read). */
export const RENDER_DEADLINE_MS = 20_000;

export interface RenderInput {
  html: string;
  css: string;
  width: number;
  height: number;
}

export interface RenderResult {
  png: Buffer;
  /** Bottom edge of the lowest rendered element (not the viewport; for heightDelta). */
  contentHeight: number;
  /** Count of aborted non-data: requests (no host names). */
  blockedRequests: number;
  parts: CandidatePart[];
  /** Characters of `class` / `role` returned from the page (bounded; for the standing test). */
  attrCharsReturned?: number;
}

export interface RenderDeps {
  launch?: () => Promise<Browser>;
  /** Test seam: overrides RENDER_DEADLINE_MS. */
  deadlineMs?: number;
}

interface RawElement {
  tag: string;
  cls: string | null;
  role: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  styles: Record<string, string>;
}

interface RawDom {
  scrollHeight: number;
  elements: RawElement[];
  attrChars: number;
}

/**
 * `<meta http-equiv="refresh">` would navigate the render document (the navigation is aborted
 * offline, but the page would become an error page). Removing it keeps the measurement valid.
 * Not a security control: the context is offline either way.
 */
export function stripMetaRefresh(html: string): string {
  // Linear scan (no backtracking regex over the whole input: CWE-1333). Each `<meta` is matched
  // to the next `>`; when there is none, the rest of the input is kept as is.
  // ASCII-only lower-casing keeps every offset valid on `html` (`toLowerCase()` can change the
  // length, e.g. U+0130, which would shift the slices below).
  const lower = html.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  let out = "";
  let pos = 0;
  for (;;) {
    const start = lower.indexOf("<meta", pos);
    if (start === -1) break;
    const next = lower.charCodeAt(start + 5);
    // `<meta` must end the tag name (whitespace, `/` or `>`), so `<metadata>` is kept.
    const endsName =
      next === 32 ||
      next === 9 ||
      next === 10 ||
      next === 12 ||
      next === 13 ||
      next === 47 ||
      next === 62;
    const end = lower.indexOf(">", start + 5);
    if (end === -1) break;
    if (endsName && REFRESH_ATTR.test(lower.slice(start, end))) {
      out += html.slice(pos, start);
      pos = end + 1;
    } else {
      out += html.slice(pos, end + 1);
      pos = end + 1;
    }
  }
  return out + html.slice(pos);
}

/** Matched against one lower-cased tag only; no nested quantifiers. */
const REFRESH_ATTR = /\bhttp-equiv\s*=\s*(?:["']\s*)?refresh\b/;

export async function renderCandidate(
  input: RenderInput,
  deps: RenderDeps = {}
): Promise<RenderResult> {
  const width = Math.max(
    MIN_RENDER_WIDTH_PX,
    Math.min(MAX_RENDER_WIDTH_PX, Math.round(input.width))
  );
  const height = Math.max(1, Math.min(MAX_RENDER_HEIGHT_PX, Math.round(input.height)));
  const launch = deps.launch ?? ((): Promise<Browser> => launchChromium());

  const deadlineMs = deps.deadlineMs ?? RENDER_DEADLINE_MS;

  const release = await partBboxLaunchSemaphore.acquire();
  let browser: Browser | null = null;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  const work = async (): Promise<RenderResult> => {
    const launched = await launch();
    if (timedOut) {
      // The deadline passed while launching: the outer finally has already run.
      await launched.close().catch(() => undefined);
      throw new Error("render deadline exceeded");
    }
    browser = launched;
    const context: BrowserContext = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      viewport: { width, height },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    context.setDefaultTimeout(RENDER_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(RENDER_TIMEOUT_MS);

    let blockedRequests = 0;
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("data:")) {
        await route.continue();
        return;
      }
      blockedRequests++;
      await route.abort();
    });

    const page = await context.newPage();
    const doc =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<style>html,body{margin:0}</style><style>${input.css}</style></head>` +
      `<body>${stripMetaRefresh(input.html)}</body></html>`;
    await page.setContent(doc, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });

    // The very first capture of a cold Chromium can fail with "Unable to capture screenshot";
    // one retry after a short pause makes it deterministic.
    const shot = (): Promise<Buffer> =>
      page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width, height },
        animations: "disabled",
        timeout: RENDER_TIMEOUT_MS,
      });
    let png: Buffer;
    try {
      png = await shot();
    } catch {
      await page.waitForTimeout(150);
      png = await shot();
    }

    // Argument-position anonymous callback only (INV-PAGE-EVALUATE-NO-NAME-INJECTION-001).
    const raw: RawDom = await page.evaluate(
      (args) => {
        const out: RawElement[] = [];
        let maxBottom = 0;
        let attrChars = 0;

        const all = document.body.querySelectorAll("*");
        const limit = Math.min(all.length, args.max);
        for (let i = 0; i < limit; i++) {
          const el = all[i];
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.height > 0 && r.top + r.height + window.scrollY > maxBottom) {
            maxBottom = r.top + r.height + window.scrollY;
          }
          const cs = window.getComputedStyle(el);
          const styles: Record<string, string> = {};
          for (const key of args.keys) {
            const v = cs.getPropertyValue(key);
            styles[key] = v.length > args.maxStyle ? v.slice(0, args.maxStyle) : v;
          }
          const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          // Inline on purpose: no named function inside page.evaluate
          // (INV-PAGE-EVALUATE-NO-NAME-INJECTION-001).
          const picked: Array<string | null> = [];
          for (const name of ["class", "role"]) {
            const v = el.getAttribute(name);
            if (v === null || attrChars >= args.maxAttrTotal) {
              picked.push(null);
              continue;
            }
            const room = Math.min(args.maxAttr, args.maxAttrTotal - attrChars);
            const cut = v.length > room ? v.slice(0, room) : v;
            attrChars += cut.length;
            picked.push(cut);
          }
          out.push({
            tag: el.tagName,
            cls: picked[0] ?? null,
            role: picked[1] ?? null,
            x: r.left + window.scrollX,
            y: r.top + window.scrollY,
            w: r.width,
            h: r.height,
            text: txt.length > args.maxText ? txt.slice(0, args.maxText) : txt,
            styles,
          });
        }
        return {
          scrollHeight: Math.ceil(maxBottom),
          elements: out,
          attrChars,
        };
      },
      {
        keys: [...STYLE_KEYS],
        max: MAX_DOM_ELEMENTS,
        maxText: MAX_TEXT_CHARS,
        maxStyle: MAX_STYLE_VALUE_CHARS,
        maxAttr: MAX_ATTR_CHARS,
        maxAttrTotal: MAX_RETURNED_ATTR_CHARS_TOTAL,
      }
    );

    const parts: CandidatePart[] = [];
    for (const el of raw.elements) {
      const partType = identifyPartTypeFromAttrs(el.tag, el.cls, el.role);
      if (partType === null) continue;
      if (!(el.w > 0) || !(el.h > 0)) continue;
      parts.push({
        partType,
        text: el.text,
        rect: { x: el.x, y: el.y, width: el.w, height: el.h },
        styles: el.styles,
      });
      if (parts.length >= MAX_CANDIDATE_PARTS) break;
    }

    // A candidate that navigated itself away (for example an entity-encoded meta refresh that
    // slipped past stripMetaRefresh) would give measurements of an error page: fail instead.
    if (page.url() !== "about:blank") {
      throw new Error("candidate navigated away from the render document");
    }

    return {
      png: Buffer.from(png),
      contentHeight: Number.isFinite(raw.scrollHeight) ? raw.scrollHeight : height,
      blockedRequests,
      parts,
      attrCharsReturned: raw.attrChars,
    };
  };

  try {
    const running = work();
    // After a timeout the work promise rejects once the browser is closed: keep it handled.
    running.catch(() => undefined);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("render deadline exceeded"));
      }, deadlineMs);
    });
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
    timedOut = true;
    // Assigned inside `work`; TypeScript cannot see that through the closure.
    const open = browser as Browser | null;
    if (open) {
      try {
        await open.close();
      } catch (closeError) {
        logger.warn("[design.verify_reproduction] browser close failed", {
          error: (closeError as Error).message,
        });
      }
    }
    release();
  }
}
