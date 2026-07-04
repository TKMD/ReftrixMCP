// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS identifier escaping — SSOT (Single Source of Truth)
 *
 * `escapeCssIdentifier` は CSS セレクタ文字列に `id` / `class` token を埋め込む際の
 * **唯一の** escape 実装。`CSS.escape()` はブラウザコンテキスト外で利用できないため、
 * Node.js (cheerio selector 生成) 側でのセレクタ構築用に backslash escape を行う。
 *
 * **配置理由 (SEC 裁定 `019ef01e`)**: `@reftrixmcp/webdesign-core`
 * (section-detector の selector 生成) と `apps/mcp-server`
 * (part-bbox の part cssClasses escape) の **両方が import する唯一の共有 lower
 * package** が `@reftrixmcp/core` であるため、escape SSOT を本 package に置く。
 * inline 再実装・複製は禁止 (両 consumer は import only)。
 *
 * `escapeCssIdentifier` is the **single** escape implementation used when
 * embedding an `id` / `class` token into a CSS selector string. Since
 * `CSS.escape()` is unavailable outside the browser context, this backslash-escapes
 * unsafe characters for selector construction in Node.js (cheerio). Placed in
 * `@reftrixmcp/core` (SEC ruling `019ef01e`) — the only shared lower package both
 * `@reftrixmcp/webdesign-core` and `apps/mcp-server` import. No inline reimplementation.
 *
 * **ADDENDUM A (id-token whitespace, plan-v1 §3.1.4 option (i))**: the unsafe
 * character class includes `\s` (whitespace). An `id` attribute is NOT split on
 * whitespace at the call site (unlike `classList` which is `/\s+/`-split), so an
 * `id="a b"` would otherwise become `#a b` — a **descendant combinator** that
 * silently targets a different element (a CWE-20 silent-wrong, not a parse break,
 * uncatchable by null-checks). Including `\s` makes `#a\ b` match the id literally.
 * Aligns with the webgl precedent (`webgl-animation-detector.service.ts` `/[...~\s]/g`).
 *
 * @module @reftrixmcp/core/utils/css-identifier
 * @see  §3.1.4
 * @see SEC sign-off `019ef01e` (ADDENDUM A/B + @reftrixmcp/core escape move)
 */

/**
 * CSSセレクタ用の識別子をバックスラッシュエスケープする (SSOT)。
 * Backslash-escape a CSS identifier for use in selectors (SSOT).
 *
 * 危険文字 (CSS 構文メタ文字 + 空白) を `\` でエスケープする。空白 (`\s`) を含めるのは
 * ADDENDUM A の通り id token の descendant-combinator silent-wrong を防ぐため。
 *
 * Escapes unsafe characters (CSS syntax metacharacters + whitespace) with `\`.
 * Whitespace (`\s`) is included per ADDENDUM A to prevent the id-token
 * descendant-combinator silent-wrong.
 *
 * @param identifier - エスケープ対象の識別子 / Identifier to escape
 * @returns エスケープ済み識別子 / Escaped identifier
 */
export function escapeCssIdentifier(identifier: string): string {
  // CSS識別子として安全でない文字 + 空白をバックスラッシュエスケープ。
  // Backslash-escape characters unsafe for CSS identifiers, plus whitespace.
  return identifier.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~\s])/g, "\\$1");
}
