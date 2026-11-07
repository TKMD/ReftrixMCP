// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-VERIFY-REPRO-OFFLINE-001 (H, security boundary of design.verify_reproduction)
 * INV-SEC-VERIFY-REPRO-NO-JS-001 (H)
 *
 * OFFLINE: a candidate's HTML/CSS must not make ANY request leave the render context:
 * `<img>` / `srcset` / `<link>` / `<iframe>` / `<object>` / `<meta refresh>` / CSS `@import` /
 * `url()` / `@font-face` / protocol-relative URLs. The render launches Chromium WITHOUT the
 * egress guard proxy here on purpose, so a leak would reach the local listener; the
 * context-level layer (offline + route abort) is what is proven. `data:` URLs still work.
 * Only the COUNT of blocked requests is returned (no host names).
 *
 * NO-JS: `<script>`, inline event handlers, `javascript:` URLs, SVG `<script>` and
 * `<meta http-equiv=refresh>` must not run / navigate. A probe element keeps its stylesheet
 * width; any script effect would change it.
 *
 * Static legs: the render module keeps `javaScriptEnabled: false`, `offline: true`, a route
 * that aborts, goes through `launchChromium()` by default, and never keeps host names.
 *
 * P0 standing regression. `.skip()` / `.todo()` are prohibited.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { assertInvName } from "../_setup/inv-assert";
import { renderCandidate } from "../../../../src/services/design/reproduction-render.service";

const RENDER_SRC = path.resolve(
  __dirname,
  "../../../../src/services/design/reproduction-render.service.ts"
);

let server: http.Server;
let port = 0;
const hits: string[] = [];

const launchNoProxy = () => chromium.launch();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.statusCode = 200;
    res.end("x");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("INV-SEC-VERIFY-REPRO-OFFLINE-001: no request leaves the render context", () => {
  it("INV-SEC-VERIFY-REPRO-OFFLINE-001 aborts every http/https/ws, link, @import, url(), srcset and font request", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SEC-VERIFY-REPRO-OFFLINE-001");
    const base = `http://127.0.0.1:${port}`;
    const gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const html = `
      <meta http-equiv="refresh" content="0;url=${base}/refresh">
      <link rel="stylesheet" href="${base}/link.css">
      <link rel="preload" as="font" href="${base}/preload.woff2" crossorigin>
      <img src="${base}/img.png">
      <img src="${gif}" srcset="${base}/a.png 1x, ${base}/b.png 2x">
      <picture><source srcset="${base}/p.webp"><img src="${gif}"></picture>
      <img src="//127.0.0.1:${port}/proto-relative.png">
      <iframe src="${base}/frame.html"></iframe>
      <object data="${base}/obj.bin"></object>
      <video poster="${base}/poster.png" src="${base}/v.mp4"></video>
      <div class="card" style="width:100px;height:40px;background:url(${base}/inline-bg.png)">ok</div>
      <img src="${gif}" alt="data uri still allowed">`;
    const css = `
      @import url("${base}/import.css");
      @font-face { font-family: X; src: url(${base}/font.woff2) format("woff2"); }
      body { font-family: X; background: url(${base}/body-bg.png); }
      .card { border-image: url(${base}/border.png) 1; cursor: url(${base}/cursor.png), auto; }`;
    const res = await renderCandidate(
      { html, css, width: 800, height: 300 },
      { launch: launchNoProxy }
    );
    // give any leaked request time to land on the listener
    await new Promise((r) => setTimeout(r, 300));
    expect(hits).toEqual([]);
    expect(res.blockedRequests).toBeGreaterThanOrEqual(8);
    expect(res.png.length).toBeGreaterThan(0);
    // The blocked-request report is a number: no host name can be carried.
    expect(typeof res.blockedRequests).toBe("number");
    expect(JSON.stringify(res)).not.toContain("127.0.0.1");
  }, 60_000);

  it("INV-SEC-VERIFY-REPRO-OFFLINE-001 static: context is offline, script-free, aborts, and launches via launchChromium", () => {
    const src = fs.readFileSync(RENDER_SRC, "utf8");
    expect(src).toMatch(/javaScriptEnabled:\s*false/);
    expect(src).toMatch(/offline:\s*true/);
    expect(src).toMatch(/route\.abort\(\)/);
    expect(src).toMatch(/launchChromium\(\)/);
    expect(src).not.toMatch(/from "playwright"\s*;?\s*$[\s\S]*chromium\.launch/m);
    expect(src).not.toMatch(/chromium\.launch\(/);
    // no host name / URL is ever stored from a blocked request
    expect(src).not.toMatch(/blockedHosts|sampleHosts|new URL\(/);
  });
});

describe("INV-SEC-VERIFY-REPRO-NO-JS-001: candidate scripts never run", () => {
  it("INV-SEC-VERIFY-REPRO-NO-JS-001 script, inline handlers, javascript: URL, svg script do not run", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SEC-VERIFY-REPRO-NO-JS-001");
    const html = `
      <div id="p" class="card" style="width:100px;height:40px" onmouseover="this.style.width='500px'">probe</div>
      <script>document.getElementById('p').style.width='500px'</script>
      <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
           onload="document.getElementById('p').style.width='500px'">
      <img src="not-a-real-image" onerror="document.getElementById('p').style.width='500px'">
      <a id="l" href="javascript:document.getElementById('p').style.width='500px'">x</a>
      <svg width="10" height="10"><script>document.getElementById('p').style.width='500px'</script></svg>
      <button autofocus onfocus="document.getElementById('p').style.width='500px'">b</button>`;
    const res = await renderCandidate(
      { html, css: "", width: 800, height: 300 },
      { launch: launchNoProxy }
    );
    const probe = res.parts.find((p) => p.partType === "card");
    expect(probe).toBeDefined();
    expect(probe?.rect.width).toBeCloseTo(100, 0);
  }, 60_000);

  it("INV-SEC-VERIFY-REPRO-NO-JS-001 entity-encoded meta refresh never reaches the network (renders or rejects)", async () => {
    const before = hits.length;
    const html = `<meta http-equiv="&#114;efresh" content="0;url=http://127.0.0.1:${port}/enc"><div class="card" style="width:50px;height:20px">x</div>`;
    await renderCandidate(
      { html, css: "", width: 800, height: 200 },
      { launch: launchNoProxy }
    ).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(hits.length).toBe(before);
  }, 60_000);

  it("INV-SEC-VERIFY-REPRO-NO-JS-001 meta refresh does not navigate away (content still rendered)", async () => {
    const html = `<meta http-equiv="refresh" content="0;url=http://example.invalid/gone"><div class="card" style="width:123px;height:20px">stay</div>`;
    const res = await renderCandidate(
      { html, css: "", width: 800, height: 200 },
      { launch: launchNoProxy }
    );
    const card = res.parts.find((p) => p.partType === "card");
    expect(card?.rect.width).toBeCloseTo(123, 0);
  }, 60_000);
});
