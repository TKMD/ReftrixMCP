// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * truncateId ユーティリティ独立テスト
 * PII配慮ログ出力用のID切り詰め処理を検証
 *
 * truncateId utility independent tests
 * Validates ID truncation for PII-aware log output
 *
 * @module tests/utils/truncate-id.test
 */

import { describe, it, expect } from "vitest";

import { truncateId } from "../../src/tools/preference/schemas";

// =====================================================
// テスト / Tests
// =====================================================

describe("truncateId", () => {
  // =====================================================
  // 通常のUUID / Normal UUID
  // =====================================================
  describe("通常のUUID / normal UUID", () => {
    it('UUIDの先頭8文字 + "..." を返す / returns first 8 chars + "..."', () => {
      const uuid = "01234567-89ab-cdef-0123-456789abcdef";
      expect(truncateId(uuid)).toBe("01234567...");
    });

    it('異なるUUIDでも先頭8文字 + "..." を返す / works with different UUIDs', () => {
      const uuid = "abcdef01-2345-6789-abcd-ef0123456789";
      expect(truncateId(uuid)).toBe("abcdef01...");
    });

    it("UUIDv7形式でも正しく切り詰める / works with UUIDv7 format", () => {
      const uuidv7 = "019537f1-4b7a-7000-8000-000000000001";
      expect(truncateId(uuidv7)).toBe("019537f1...");
    });
  });

  // =====================================================
  // 境界値テスト / Boundary value tests
  // =====================================================
  describe("境界値テスト / boundary values", () => {
    it('undefined に対して "undefined" を返す / returns "undefined" for undefined', () => {
      expect(truncateId(undefined)).toBe("undefined");
    });

    it('空文字列に対して "undefined" を返す / returns "undefined" for empty string', () => {
      expect(truncateId("")).toBe("undefined");
    });

    it("8文字以下の文字列はそのまま返す / returns short strings as-is", () => {
      expect(truncateId("abc")).toBe("abc");
      expect(truncateId("12345678")).toBe("12345678");
    });

    it("9文字以上の文字列は切り詰める / truncates strings with 9+ chars", () => {
      expect(truncateId("123456789")).toBe("12345678...");
    });

    it("ちょうど8文字の文字列はそのまま返す / returns exactly 8 chars as-is", () => {
      expect(truncateId("abcdefgh")).toBe("abcdefgh");
    });
  });

  // =====================================================
  // PII保護検証 / PII protection verification
  // =====================================================
  describe("PII保護 / PII protection", () => {
    it("完全なUUIDが出力に含まれない / full UUID is not in output", () => {
      const uuid = "01234567-89ab-cdef-0123-456789abcdef";
      const result = truncateId(uuid);
      expect(result).not.toBe(uuid);
      expect(result.length).toBeLessThan(uuid.length);
    });

    it("ハイフンを含むUUIDの9文字目以降が含まれない / characters after position 8 are hidden", () => {
      const uuid = "01234567-89ab-cdef-0123-456789abcdef";
      const result = truncateId(uuid);
      expect(result).not.toContain("89ab");
      expect(result).not.toContain("cdef");
    });
  });
});
