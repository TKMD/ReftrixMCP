// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS Selector Sanitization Utility
 *
 * 構造化ログ / MCP レスポンスに CSS セレクタや CSS クラスを載せる際の
 * PII / 機微情報 redaction ユーティリティ。
 *
 * Sanitization utility for CSS selectors and class lists emitted to structured
 * logs / MCP responses, redacting PII and sensitive patterns.
 *
 * ## 背景 / Background
 *
 * v0.4.0 PR7e-1 で Part Bbox 解決失敗の観測性を強化するため、`selector` と
 * `cssClasses` をログに含める需要が生じた。CSS-in-JS (`__userEmail-abc123`)、
 * hashed class (`Button-4f3a9e7c`)、UUID (`user-id-01934567-89ab-7def-0123-...`)、
 * メール (`contact-support@example.com` をクラス名化するケース) が DB から
 * 流出すると GDPR Art.5(1)(c) 「データ最小化」に抵触しうる。
 *
 * In v0.4.0 PR7e-1, strengthened observability for Part Bbox resolution
 * failures introduced the need to log `selector` / `cssClasses`. CSS-in-JS
 * (`__userEmail-abc123`), hashed classes (`Button-4f3a9e7c`), UUIDs, and
 * email-derived class names could leak from the DB, potentially breaching
 * GDPR Art.5(1)(c) ("data minimisation").
 *
 * ## Sanitize 方針 / Sanitization Rules
 *
 * 1. CSS Modules / CSS-in-JS hash-suffix パターン (`__xyz-a1b2c3`) を `[REDACTED]`
 * 2. 汎用 hash-suffix (`foo-a1b2c3d4`) を `[REDACTED]` (8+ hex)
 * 3. email (`x@y.z`) を `[REDACTED]`
 * 4. UUID v1-v7 (`01934567-89ab-7def-0123-456789abcdef`) を `[REDACTED]`
 * 5. 長さ 80 文字で truncate (selector) / 32 文字で truncate (class 1件)
 * 6. cssClasses は先頭 3 件のみ (LCC Art.5(1)(c) データ最小化)
 *
 * @module utils/sanitize-selector
 */

// 最大セレクタ長 / Maximum selector length
const MAX_SELECTOR_LENGTH = 80;

// CSS クラス 1 件の最大長 / Maximum length of a single CSS class
const MAX_CLASS_LENGTH = 32;

// cssClasses 配列の最大件数 / Maximum number of CSS classes
const MAX_CLASSES_COUNT = 3;

// CSS Modules / CSS-in-JS: `__name-abc123` (6+ hex), `__foo-bar-a1b2c3`
const CSS_IN_JS_HASH_PATTERN = /__[\w-]+-[a-f0-9]{6,}/gi;

// 汎用 hash-suffix: `Button-4f3a9e7c`, `foo-a1b2c3d4ef` (8+ hex)
const GENERIC_HASH_SUFFIX_PATTERN = /[a-z-]+-[a-f0-9]{8,}/gi;

// Email-like パターン / Email-like pattern
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// UUID v1-v7 / UUID v1-v7
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

/**
 * CSS セレクタ文字列を sanitize する。PII / hash suffix / UUID / email を
 * `[REDACTED]` に置換し、80 文字で truncate する。
 *
 * Sanitize a CSS selector string. Replaces PII / hash suffixes / UUIDs /
 * emails with `[REDACTED]`, then truncates to 80 characters.
 *
 * @param selector - 入力セレクタ / Input selector
 * @returns サニタイズ済みセレクタ / Sanitized selector
 */
export function sanitizeSelector(selector: string): string {
  if (typeof selector !== "string" || selector.length === 0) {
    return "";
  }

  // 1. CSS-in-JS hash-suffix を先に置換 (汎用よりも優先)
  //    Replace CSS-in-JS patterns first (higher priority than generic)
  let sanitized = selector.replace(CSS_IN_JS_HASH_PATTERN, "[REDACTED]");

  // 2. email を置換 / Replace email
  sanitized = sanitized.replace(EMAIL_PATTERN, "[REDACTED]");

  // 3. UUID を置換 / Replace UUID
  sanitized = sanitized.replace(UUID_PATTERN, "[REDACTED]");

  // 4. 汎用 hash-suffix を置換 / Replace generic hash-suffix
  sanitized = sanitized.replace(GENERIC_HASH_SUFFIX_PATTERN, "[REDACTED]");

  // 5. 長さ制限 / Length limit
  if (sanitized.length > MAX_SELECTOR_LENGTH) {
    return sanitized.slice(0, MAX_SELECTOR_LENGTH);
  }
  return sanitized;
}

/**
 * CSS クラス配列を sanitize する。先頭 3 件のみ残し、各クラスは 32 文字で
 * truncate し、`sanitizeSelector` を適用する (LCC Art.5(1)(c) データ最小化)。
 *
 * Sanitize a CSS class list. Keeps only the first 3 items, truncates each
 * to 32 chars, and applies `sanitizeSelector` (LCC Art.5(1)(c) minimisation).
 *
 * @param classes - CSS クラス配列 / CSS class list
 * @returns サニタイズ済みクラス配列 (最大 3 件) / Sanitized class list (max 3)
 */
export function sanitizeCssClasses(classes: readonly string[]): string[] {
  if (!Array.isArray(classes) || classes.length === 0) {
    return [];
  }

  return classes
    .slice(0, MAX_CLASSES_COUNT)
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .map((c) => {
      const truncated = c.length > MAX_CLASS_LENGTH ? c.slice(0, MAX_CLASS_LENGTH) : c;
      return sanitizeSelector(truncated);
    });
}
