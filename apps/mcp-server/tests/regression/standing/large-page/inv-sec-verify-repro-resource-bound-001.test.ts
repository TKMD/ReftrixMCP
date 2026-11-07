// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-VERIFY-REPRO-RESOURCE-BOUND-001 (H, CWE-770 / CWE-1333, design.verify_reproduction)
 *
 * A candidate inside the input caps (2 MiB) must not be able to stop or crash the MCP server:
 *  - `stripMetaRefresh` runs in linear time (the former regex backtracked quadratically on
 *    `<meta ` repeated without `>`: 480 KB took 16.8 s on the event loop).
 *  - Computed-style values coming back from the page are truncated inside the browser, so an
 *    inherited huge `font-family` cannot amplify into hundreds of MB through the Playwright pipe
 *    (155 KB of input crashed the process with "Cannot create a string longer than ...").
 *  - The whole render (setContent + screenshot + DOM read) has one deadline; past it the
 *    browser is closed and the launch semaphore is released.
 *  - Speculative connections (preconnect / dns-prefetch / prefetch / ws://) open no TCP
 *    connection (complements INV-SEC-VERIFY-REPRO-OFFLINE-001, which only sees HTTP requests).
 *
 * P0 standing regression. `.skip()` / `.todo()` are prohibited.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { transformSync } from "esbuild";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { assertInvName } from "../_setup/inv-assert";
import {
  MAX_RETURNED_ATTR_CHARS_TOTAL,
  MAX_STYLE_VALUE_CHARS,
  renderCandidate,
  stripMetaRefresh,
} from "../../../../src/services/design/reproduction-render.service";

const INV = "INV-SEC-VERIFY-REPRO-RESOURCE-BOUND-001";
const launchNoProxy = () => chromium.launch();

let server: net.Server;
let port = 0;
let connections = 0;

beforeAll(async () => {
  server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe(`${INV}: a capped candidate cannot stop or crash the server`, () => {
  it(`${INV} stripMetaRefresh is linear on unterminated <meta repeats`, () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const hostile = "<meta ".repeat(80_000); // 480 KB
    const t0 = performance.now();
    stripMetaRefresh(hostile);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it(`${INV} stripMetaRefresh still removes refresh tags and keeps others`, () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    expect(stripMetaRefresh(`a<meta http-equiv="refresh" content="0;url=x">b`)).toBe("ab");
    expect(stripMetaRefresh(`a<META HTTP-EQUIV=Refresh content=0>b`)).toBe("ab");
    expect(stripMetaRefresh(`a<meta content="0" http-equiv='refresh'>b`)).toBe("ab");
    expect(stripMetaRefresh(`<meta charset="utf-8"><p>x</p>`)).toBe(
      `<meta charset="utf-8"><p>x</p>`
    );
    expect(stripMetaRefresh(`<metadata>x</metadata>`)).toBe(`<metadata>x</metadata>`);
    expect(stripMetaRefresh(`<meta http-equiv="refresh"`)).toBe(`<meta http-equiv="refresh"`);
  });

  it(`${INV} inherited huge computed styles are truncated in the browser`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const css = `body{font-family:"${"a".repeat(120_000)}"}`;
    const html = `<button class="btn">x</button>`.repeat(3000);
    const res = await renderCandidate(
      { html, css, width: 800, height: 400 },
      { launch: launchNoProxy }
    );
    expect(res.parts.length).toBeGreaterThan(0);
    for (const p of res.parts) {
      for (const v of Object.values(p.styles)) {
        expect(v.length).toBeLessThanOrEqual(MAX_STYLE_VALUE_CHARS);
      }
    }
  }, 120_000);

  it(`${INV} parser-cloned class/role attributes are truncated in the browser`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    // Formatting elements (<a>, <b>, ...) are re-created with their attributes each time a <p>
    // implicitly closes them, so one long attribute is cloned thousands of times.
    const long = "x".repeat(40_000);
    const html = `<p><a class="btn ${long}" role="${long}">` + "<p>x".repeat(5000);
    const res = await renderCandidate(
      { html, css: "", width: 800, height: 400 },
      { launch: launchNoProxy }
    );
    expect(res.attrCharsReturned).toBeLessThanOrEqual(MAX_RETURNED_ATTR_CHARS_TOTAL);
  }, 120_000);

  it(`${INV} stripMetaRefresh keeps offsets for characters whose lower case changes length`, () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const head = "\u0130".repeat(10);
    expect(stripMetaRefresh(`${head}<meta http-equiv="refresh" content="0"><p>keep</p>`)).toBe(
      `${head}<p>keep</p>`
    );
  });

  it(`${INV} past the render deadline the call rejects and the semaphore is released`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    await expect(
      renderCandidate(
        { html: "<p>x</p>", css: "", width: 800, height: 200 },
        { launch: launchNoProxy, deadlineMs: 1 }
      )
    ).rejects.toThrow(/deadline/);
    // a following render acquires the semaphore and completes
    const ok = await renderCandidate(
      {
        html: `<div class="card" style="width:40px;height:20px">ok</div>`,
        css: "",
        width: 800,
        height: 200,
      },
      { launch: launchNoProxy }
    );
    expect(ok.png.length).toBeGreaterThan(0);
  }, 120_000);

  it(`${INV} speculative connections and ws:// open no TCP connection`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const base = `http://127.0.0.1:${port}`;
    const html = `
      <link rel="preconnect" href="${base}">
      <link rel="dns-prefetch" href="${base}">
      <link rel="prefetch" href="${base}/pf">
      <link rel="prerender" href="${base}/pr">
      <link rel="modulepreload" href="${base}/m.js">
      <script type="speculationrules">{"prerender":[{"source":"list","urls":["${base}/sr"]}]}</script>
      <a href="ws://127.0.0.1:${port}/ws">ws</a>
      <div class="card" style="width:40px;height:20px">x</div>`;
    await renderCandidate({ html, css: "", width: 800, height: 200 }, { launch: launchNoProxy });
    await new Promise((r) => setTimeout(r, 300));
    expect(connections).toBe(0);
  }, 60_000);

  it(`${INV} the DOM-read page.evaluate callback has no __name under a tsx keepNames transform`, () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    // INV-PAGE-EVALUATE-NO-NAME-INJECTION-001 covers the part bbox callback only; this pins the
    // render callback: a named helper inside it throws "__name is not defined" under tsx.
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../../src/services/design/reproduction-render.service.ts"),
      "utf8"
    );
    const out = transformSync(src, { loader: "ts", keepNames: true, format: "esm" }).code;
    const start = out.indexOf("page.evaluate(");
    const end = out.indexOf("maxAttrTotal", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(out.slice(start, end)).not.toContain("__name");
    // positive control: the same transform does inject __name for a named arrow binding
    const ctl = transformSync("page.evaluate(() => { const f = () => 1; return f(); });", {
      loader: "ts",
      keepNames: true,
    }).code;
    expect(ctl).toContain("__name");
  });
});
