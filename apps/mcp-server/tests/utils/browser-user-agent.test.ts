// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-CRAWLER-UA-IDENTITY-001 (mcp-server side)
 *
 * ブラウザ context の UA は起動中のブラウザのバージョンを使い、ReftrixBot のトークンを必ず含む。
 * src に `reftrix.dev/bot`（名前解決できない旧 URL）と、トークンの無い UA の直書きが残らない。
 *
 * Browser-context UAs use the running browser's version and always carry the ReftrixBot token.
 * src keeps neither the old unresolvable `reftrix.dev/bot` URL nor a hard-coded UA without it.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { ROBOTS_TXT, REFTRIXBOT_INFO_URL } from "@reftrixmcp/core";
import { browserUserAgent } from "../../src/utils/browser-user-agent";

const SRC = path.resolve(__dirname, "../../src");

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listTs(p);
    return e.isFile() && p.endsWith(".ts") ? [p] : [];
  });
}

let browser: Browser | undefined;
afterAll(async () => {
  await browser?.close();
});

describe("INV-CRAWLER-UA-IDENTITY-001 browserUserAgent", () => {
  it("uses the real Chromium version and the page sees that UA with the ReftrixBot token", async () => {
    browser = await chromium.launch({ headless: true });
    const ua = browserUserAgent(browser);
    const version = browser.version().replace(/^HeadlessChrome\//, "");
    expect(ua).toContain(`Chrome/${version} `);
    expect(ua).toContain(`(compatible; ${ROBOTS_TXT.PRODUCT_TOKEN}/1.0; +${REFTRIXBOT_INFO_URL})`);
    expect(ua).not.toContain("HeadlessChrome");

    const context = await browser.newContext({ userAgent: ua });
    const page = await context.newPage();
    expect(await page.evaluate("navigator.userAgent")).toBe(ua);
    await context.close();
  });

  it("falls back to the plain bot UA when the version cannot be read", () => {
    const throwing = {
      version: (): string => {
        throw new Error("closed");
      },
    };
    expect(browserUserAgent(throwing)).toBe(ROBOTS_TXT.USER_AGENT);
    expect(browserUserAgent({} as never)).toBe(ROBOTS_TXT.USER_AGENT);
  });

  it("src has no unresolvable reftrix.dev/bot or reftrix.app URL and no userAgent set to the plain constant in browser contexts", () => {
    const offenders: string[] = [];
    for (const f of listTs(SRC)) {
      const text = fs.readFileSync(f, "utf8");
      if (text.includes("reftrix.dev/bot"))
        offenders.push(`${path.relative(SRC, f)}: reftrix.dev/bot`);
      if (/userAgent:\s*ROBOTS_TXT\.USER_AGENT/.test(text)) {
        offenders.push(`${path.relative(SRC, f)}: userAgent: ROBOTS_TXT.USER_AGENT`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every browser context in src sets a User-Agent with the token (offline reproduction render excepted)", () => {
    // reproduction-render はネットワークを使わない (offline、JS 無効) ので UA を送らない
    // reproduction-render never goes to the network (offline, JS off), so it sends no UA.
    const OFFLINE = new Set(["services/design/reproduction-render.service.ts"]);
    const offenders: string[] = [];
    for (const f of listTs(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join("/");
      const text = fs.readFileSync(f, "utf8");
      if (text.includes("Reftrix/0.3.0")) offenders.push(`${rel}: Reftrix/0.3.0`);
      if (OFFLINE.has(rel)) continue;
      const re = /\.newContext\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        // 呼び出しの括弧の中だけを見る / look only inside this call's parentheses
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < text.length; end++) {
          if (text[end] === "(") depth++;
          else if (text[end] === ")" && --depth === 0) break;
        }
        const args = text.slice(m.index, end + 1);
        if (!/userAgent:\s*(browserUserAgent\(|SharedBrowserManager\.getUserAgent\()/.test(args)) {
          const line = text.slice(0, m.index).split("\n").length;
          offenders.push(`${rel}:${line}: newContext without a ReftrixBot User-Agent`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
