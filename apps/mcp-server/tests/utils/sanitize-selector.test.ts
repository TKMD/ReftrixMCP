// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * sanitize-selector ユーティリティ テスト
 *
 * CSS セレクタ / クラス配列の PII redaction 検証:
 * - CSS-in-JS hash (`__userEmail-abc123`) redact
 * - email redact
 * - UUID v1-v7 redact
 * - 汎用 hash-suffix (`Button-4f3a9e7c`) redact
 * - 80 char truncate
 * - 非該当文字列はそのまま
 * - cssClasses 配列: 先頭 3 件 / 各 32 char 制限
 *
 * Tests for CSS selector / class list sanitization (PII redaction).
 *
 * @module tests/utils/sanitize-selector
 */

import { describe, it, expect } from "vitest";
import { sanitizeSelector, sanitizeCssClasses } from "../../src/utils/sanitize-selector";

describe("sanitizeSelector", () => {
  it("CSS Modules / CSS-in-JS hash → [REDACTED] / CSS Modules hash redacted", () => {
    expect(sanitizeSelector("div.__userEmail-abc123")).toBe("div.[REDACTED]");
    expect(sanitizeSelector(".__foo-bar-a1b2c3d4")).toBe(".[REDACTED]");
  });

  it("email pattern → [REDACTED] / email pattern redacted", () => {
    expect(sanitizeSelector("a[href='mailto:user@example.com']")).toContain("[REDACTED]");
    expect(sanitizeSelector("a[href='mailto:user@example.com']")).not.toContain("user@example.com");
  });

  it("UUID v4/v7 → [REDACTED] / UUID v4/v7 redacted", () => {
    // UUID v4
    expect(sanitizeSelector("div[data-id='01934567-89ab-7def-8123-456789abcdef']")).toContain(
      "[REDACTED]"
    );
    expect(sanitizeSelector("div[data-id='01934567-89ab-7def-8123-456789abcdef']")).not.toContain(
      "01934567"
    );
  });

  it("80 char truncate / truncate to 80 chars", () => {
    const longSelector =
      "div.class1.class2.class3.class4.class5.class6.class7.class8.class9.class10.class11";
    const result = sanitizeSelector(longSelector);
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it("非該当文字列はそのまま / non-matching strings pass through unchanged", () => {
    expect(sanitizeSelector("div.button")).toBe("div.button");
    expect(sanitizeSelector("#header")).toBe("#header");
    expect(sanitizeSelector("a[href='/home']")).toBe("a[href='/home']");
  });

  it("空文字列 / 非文字列 → 空文字 / empty or non-string input → empty string", () => {
    expect(sanitizeSelector("")).toBe("");
    // @ts-expect-error - test non-string input defense
    expect(sanitizeSelector(null)).toBe("");
    // @ts-expect-error - test non-string input defense
    expect(sanitizeSelector(undefined)).toBe("");
  });
});

describe("sanitizeCssClasses", () => {
  it("先頭 3 件のみ残す / keeps only first 3 elements", () => {
    const input = ["c1", "c2", "c3", "c4", "c5"];
    const result = sanitizeCssClasses(input);
    expect(result).toHaveLength(3);
    expect(result).toEqual(["c1", "c2", "c3"]);
  });

  it("各クラスを 32 文字で truncate / each class truncated to 32 chars", () => {
    const longClass = "a".repeat(50);
    const result = sanitizeCssClasses([longClass]);
    expect(result[0]?.length).toBeLessThanOrEqual(32);
  });

  it("hash-suffix クラスを redact / hash-suffix classes redacted", () => {
    // 8+ hex suffix triggers generic hash-suffix pattern
    const result = sanitizeCssClasses(["Button-4f3a9e7c"]);
    expect(result[0]).toContain("[REDACTED]");
  });

  it("空配列 / 非配列 → 空配列 / empty or non-array input → empty array", () => {
    expect(sanitizeCssClasses([])).toEqual([]);
    // @ts-expect-error - test non-array input defense
    expect(sanitizeCssClasses(null)).toEqual([]);
    // @ts-expect-error - test non-array input defense
    expect(sanitizeCssClasses(undefined)).toEqual([]);
  });

  it("非文字列要素を除外 / filters out non-string elements (after slice-first)", () => {
    // 仕様: slice(0, 3) を先に適用 → その中の非文字列を除外するため、
    // 4 番目以降の正常値は取り込まれない (データ最小化の優先)。
    // Spec: slice(0, 3) runs first, then non-strings are filtered; items at
    // index >= 3 are not promoted (data-minimisation takes precedence).
    // @ts-expect-error - test mixed-type input defense
    const result = sanitizeCssClasses(["valid", null, undefined, 123, "also-valid"]);
    expect(result).toEqual(["valid"]);
  });

  it("通常のクラス名はそのまま / normal class names pass through", () => {
    expect(sanitizeCssClasses(["btn", "primary"])).toEqual(["btn", "primary"]);
  });
});
