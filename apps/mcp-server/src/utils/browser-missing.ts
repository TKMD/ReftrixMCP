// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browser-missing detection and fixed client message
 * ブラウザ欠如の判定と client 向け固定文言
 *
 * `chromium.launch()` が Chromium 未導入で reject したとき、エラー本文には
 * 内部 path (`/home/...`, `ms-playwright`) と Call log が含まれる。client には
 * 本モジュールの固定文言だけを返し (CWE-209)、server-side log には raw を残す。
 *
 * When `chromium.launch()` rejects because Chromium is not installed, the error
 * body contains internal paths and a call log. Clients receive only the fixed
 * message below; server-side logs keep the raw error.
 *
 * @module utils/browser-missing
 */

/**
 * Pinned Playwright version (must equal root devDependencies / mcp-server
 * dependencies / installed playwright-core; asserted by browser-missing.test.ts).
 * 版固定により、実行 dir に依らず同じ Chromium revision が入る。
 */
export const PLAYWRIGHT_PINNED_VERSION = "1.57.0";

/** Fixed client-facing message. No path, stack, call log or error body. */
export const BROWSER_MISSING_MESSAGE = `Browser for page crawling is not installed. Run: npx playwright@${PLAYWRIGHT_PINNED_VERSION} install chromium`;

/**
 * playwright-core 1.57.0 emits two variants:
 * - `Executable doesn't exist at <path>` (registry)
 * - `executable doesn't exist at <path>` (browserType.js)
 * plus the `npx playwright install` hint. Compared lower-cased (OR).
 *
 * The hint must not match `npx playwright install-deps` (missing host libraries:
 * a different remedy). The fixed message itself also matches (idempotent), so a
 * second sanitize pass keeps it instead of degrading to a generic message.
 */
const BROWSER_MISSING_PATTERNS: readonly RegExp[] = [
  /executable doesn't exist at/,
  /npx playwright install(?!-)/,
];
const FIXED_MESSAGE_LOWER = BROWSER_MISSING_MESSAGE.toLowerCase();

/** Thrown by launchChromium() when Chromium is not installed. The message is the fixed text. */
export class BrowserNotInstalledError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(BROWSER_MISSING_MESSAGE, options);
    this.name = "BrowserNotInstalledError";
  }
}

/**
 * Whether the error is Playwright's "browser executable missing" launch error
 * (or already the fixed message).
 * Playwright の「ブラウザ実行ファイル欠如」起動エラー (または固定文言そのもの) か判定する。
 */
export function isBrowserMissingError(error: unknown): boolean {
  if (error instanceof BrowserNotInstalledError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.startsWith(FIXED_MESSAGE_LOWER) ||
    BROWSER_MISSING_PATTERNS.some((re) => re.test(message))
  );
}
