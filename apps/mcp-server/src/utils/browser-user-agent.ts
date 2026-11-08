// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ブラウザ context に付ける User-Agent / User-Agent for browser contexts
 *
 * Chrome 互換の文字列 + `(compatible; ReftrixBot/1.0; +URL)`。バージョンは起動中のブラウザから
 * 読む。読めないときは素の bot UA になる (`buildBrowserUserAgent` の fallback)。
 * bot 判定を避ける細工 (stealth、`navigator.webdriver` の偽装、UA のローテーション、サイトごとの
 * 上書き) はしない (LCC 2026-11-08、ADR-0018 Amendment)。
 *
 * A Chrome-compatible string plus `(compatible; ReftrixBot/1.0; +URL)`, with the version read from
 * the running browser; an unreadable version yields the plain bot UA. No bot-detection evasion
 * (stealth, `navigator.webdriver` spoofing, UA rotation, per-site overrides).
 *
 * INV-CRAWLER-UA-IDENTITY-001
 */

import type { Browser } from "playwright";
import { buildBrowserUserAgent } from "@reftrixmcp/core";

export function browserUserAgent(browser: Pick<Browser, "version">): string {
  let version = "";
  try {
    version = typeof browser.version === "function" ? browser.version() : "";
  } catch {
    version = "";
  }
  return buildBrowserUserAgent(typeof version === "string" ? version : "");
}
