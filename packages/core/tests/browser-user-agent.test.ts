// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-CRAWLER-UA-IDENTITY-001
 *
 * ブラウザの User-Agent は Chrome 互換の文字列に `(compatible; ReftrixBot/1.0; +<URL>)` を足した形。
 * Chrome のバージョンは実際のブラウザの値を使い、ReftrixBot のトークンは必ず残す。識別 URL は
 * 公開リポジトリの ReftrixBot の説明ページを指す（LCC 2026-11-08 の条件 1・2・4）。
 *
 * The browser User-Agent is a Chrome-compatible string followed by
 * `(compatible; ReftrixBot/1.0; +<URL>)`. The Chrome version comes from the real browser, the
 * ReftrixBot token is always present, and the URL points at the ReftrixBot page in the public
 * repository (LCC ruling 2026-11-08, conditions 1, 2 and 4).
 */

import { describe, it, expect } from "vitest";
import { ROBOTS_TXT, REFTRIXBOT_INFO_URL, buildBrowserUserAgent } from "../src/constants";

describe("INV-CRAWLER-UA-IDENTITY-001 crawler User-Agent", () => {
  it("the info URL is the public ReftrixBot page and every UA carries it", () => {
    expect(REFTRIXBOT_INFO_URL).toBe(
      "https://github.com/TKMD/ReftrixMCP/blob/main/docs/legal/REFTRIXBOT.md"
    );
    expect(ROBOTS_TXT.USER_AGENT).toBe(
      `Mozilla/5.0 (compatible; ReftrixBot/1.0; +${REFTRIXBOT_INFO_URL})`
    );
    expect(buildBrowserUserAgent("156.0.7499.4")).toContain(`+${REFTRIXBOT_INFO_URL}`);
  });

  it("uses the real browser version in a Chrome-compatible string and keeps the bot token", () => {
    expect(buildBrowserUserAgent("156.0.7499.4")).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/156.0.7499.4 Safari/537.36 " +
        `(compatible; ${ROBOTS_TXT.PRODUCT_TOKEN}/1.0; +${REFTRIXBOT_INFO_URL})`
    );
  });

  it("accepts the 'HeadlessChrome/' form that browser.version() may return", () => {
    expect(buildBrowserUserAgent("HeadlessChrome/156.0.7499.4")).toContain("Chrome/156.0.7499.4 ");
  });

  it("falls back to the plain bot UA for an unreadable version (never a UA without the token)", () => {
    for (const bad of ["", "abc", "156.0; evil", "1".repeat(64)]) {
      expect(buildBrowserUserAgent(bad)).toBe(ROBOTS_TXT.USER_AGENT);
    }
  });
});
