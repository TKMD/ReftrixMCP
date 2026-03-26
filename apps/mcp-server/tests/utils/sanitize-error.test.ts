// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * sanitize-error ユーティリティ テスト
 *
 * 統一エラーメッセージサニタイズの検証
 * - Prismaエラーコード（P2002, P2025等）から安全なメッセージへの変換
 * - 未知のPrismaコード（P9999）→ "Database operation failed"
 * - ネットワークエラー（ECONNREFUSED等）
 * - タイムアウトエラー
 * - not foundエラー
 * - 不明エラー→ "An internal error occurred"
 * - sanitizeErrorCode: マッピングあり/なし
 *
 * @module tests/utils/sanitize-error
 */

import { describe, it, expect } from "vitest";
import { sanitizeErrorMessage, sanitizeErrorCode } from "../../src/utils/sanitize-error";

// ============================================================================
// Prisma エラーコード / Prisma error codes
// ============================================================================

describe("sanitizeErrorMessage", () => {
  describe("Prisma エラーコード / Prisma error codes", () => {
    it('P2002 → "A record with this value already exists"', () => {
      const error = Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      });
      expect(sanitizeErrorMessage(error)).toBe("A record with this value already exists");
    });

    it('P2025 → "Record not found"', () => {
      const error = Object.assign(
        new Error(
          "An operation failed because it depends on records that were required but not found."
        ),
        { code: "P2025" }
      );
      expect(sanitizeErrorMessage(error)).toBe("Record not found");
    });

    it('P2001 → "Record not found"', () => {
      const error = Object.assign(new Error("Record does not exist"), {
        code: "P2001",
      });
      expect(sanitizeErrorMessage(error)).toBe("Record not found");
    });

    it('P2003 → "Foreign key constraint failed"', () => {
      const error = Object.assign(new Error("Foreign key constraint failed on the field"), {
        code: "P2003",
      });
      expect(sanitizeErrorMessage(error)).toBe("Foreign key constraint failed");
    });

    it('P1001 → "Database server is unreachable"', () => {
      const error = Object.assign(new Error("Can't reach database server"), {
        code: "P1001",
      });
      expect(sanitizeErrorMessage(error)).toBe("Database server is unreachable");
    });

    it('P1008 → "Operation timed out"', () => {
      const error = Object.assign(new Error("Operations timed out after"), {
        code: "P1008",
      });
      expect(sanitizeErrorMessage(error)).toBe("Operation timed out");
    });

    it('P2000 → "Value too long for the column"', () => {
      const error = Object.assign(new Error("Value too long"), {
        code: "P2000",
      });
      expect(sanitizeErrorMessage(error)).toBe("Value too long for the column");
    });
  });

  // ============================================================================
  // 未知のPrismaコード / Unknown Prisma codes
  // ============================================================================

  describe("未知のPrismaコード / unknown Prisma codes", () => {
    it('P9999 → "Database operation failed"', () => {
      const error = Object.assign(new Error("Some unknown Prisma error"), {
        code: "P9999",
      });
      expect(sanitizeErrorMessage(error)).toBe("Database operation failed");
    });

    it('P3000 → "Database operation failed"（マッピング外のPxxxxパターン）', () => {
      const error = Object.assign(new Error("Migration error"), {
        code: "P3000",
      });
      expect(sanitizeErrorMessage(error)).toBe("Database operation failed");
    });
  });

  // ============================================================================
  // ネットワークエラー / Network errors
  // ============================================================================

  describe("ネットワークエラー / network errors", () => {
    it('ECONNREFUSED → "Network request failed"', () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      expect(sanitizeErrorMessage(error)).toBe("Network request failed");
    });

    it('ETIMEDOUT → "Network request failed"', () => {
      const error = new Error("connect ETIMEDOUT 10.0.0.1:443");
      expect(sanitizeErrorMessage(error)).toBe("Network request failed");
    });

    it('ENOTFOUND → "Network request failed"', () => {
      const error = new Error("getaddrinfo ENOTFOUND unknown.host.com");
      expect(sanitizeErrorMessage(error)).toBe("Network request failed");
    });

    it('fetch failed → "Network request failed"', () => {
      const error = new Error("fetch failed");
      expect(sanitizeErrorMessage(error)).toBe("Network request failed");
    });
  });

  // ============================================================================
  // タイムアウトエラー / Timeout errors
  // ============================================================================

  describe("タイムアウトエラー / timeout errors", () => {
    it('"timeout" を含むメッセージ → "Operation timed out"', () => {
      const error = new Error("Request timeout after 30000ms");
      expect(sanitizeErrorMessage(error)).toBe("Operation timed out");
    });

    it('"timed out" を含むメッセージ → "Operation timed out"', () => {
      const error = new Error("Operation timed out waiting for response");
      expect(sanitizeErrorMessage(error)).toBe("Operation timed out");
    });

    it('大文字混在の "Timeout" でも検出される', () => {
      const error = new Error("Connection Timeout Error");
      expect(sanitizeErrorMessage(error)).toBe("Operation timed out");
    });
  });

  // ============================================================================
  // not found エラー / Not found errors
  // ============================================================================

  describe("not found エラー / not found errors", () => {
    it('"not found" を含むメッセージ → "Resource not found"', () => {
      const error = new Error("User not found");
      expect(sanitizeErrorMessage(error)).toBe("Resource not found");
    });

    it('"does not exist" を含むメッセージ → "Resource not found"', () => {
      const error = new Error("The requested resource does not exist");
      expect(sanitizeErrorMessage(error)).toBe("Resource not found");
    });
  });

  // ============================================================================
  // 不明エラー / Unknown errors
  // ============================================================================

  describe("不明エラー / unknown errors", () => {
    it('一般的なErrorオブジェクト → "An internal error occurred"', () => {
      const error = new Error("Something went terribly wrong with internal module");
      expect(sanitizeErrorMessage(error)).toBe("An internal error occurred");
    });

    it('文字列エラー → "An internal error occurred"', () => {
      expect(sanitizeErrorMessage("raw string error")).toBe("An internal error occurred");
    });

    it('null → "An internal error occurred"', () => {
      expect(sanitizeErrorMessage(null)).toBe("An internal error occurred");
    });

    it('undefined → "An internal error occurred"', () => {
      expect(sanitizeErrorMessage(undefined)).toBe("An internal error occurred");
    });

    it('数値 → "An internal error occurred"', () => {
      expect(sanitizeErrorMessage(42)).toBe("An internal error occurred");
    });

    it('空オブジェクト → "An internal error occurred"', () => {
      expect(sanitizeErrorMessage({})).toBe("An internal error occurred");
    });
  });

  // ============================================================================
  // 内部構造漏洩防止 / Internal structure leakage prevention
  // ============================================================================

  describe("内部構造漏洩防止 / internal structure leakage prevention", () => {
    it("Prismaエラーの元メッセージがレスポンスに含まれない", () => {
      const error = Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), {
        code: "P2002",
      });
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).not.toContain("email");
      expect(sanitized).not.toContain("fields");
      expect(sanitized).not.toContain("constraint");
    });

    it("ネットワークエラーのIPアドレスがレスポンスに含まれない", () => {
      const error = new Error("connect ECONNREFUSED 192.168.1.100:5432");
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).not.toContain("192.168");
      expect(sanitized).not.toContain("5432");
    });
  });
});

// ============================================================================
// sanitizeErrorCode / エラーコードサニタイズ
// ============================================================================

describe("sanitizeErrorCode", () => {
  const testMapping: Record<string, string> = {
    NOT_FOUND: "The requested item was not found",
    INVALID_INPUT: "The provided input is invalid",
    RATE_LIMITED: "Too many requests, please try again later",
  };

  it("マッピングに存在するコードは対応するメッセージを返す", () => {
    expect(sanitizeErrorCode("NOT_FOUND", testMapping)).toBe("The requested item was not found");
    expect(sanitizeErrorCode("INVALID_INPUT", testMapping)).toBe("The provided input is invalid");
    expect(sanitizeErrorCode("RATE_LIMITED", testMapping)).toBe(
      "Too many requests, please try again later"
    );
  });

  it('マッピングに存在しないコードは "An internal error occurred" を返す', () => {
    expect(sanitizeErrorCode("UNKNOWN_CODE", testMapping)).toBe("An internal error occurred");
  });

  it('空文字列のコードは "An internal error occurred" を返す', () => {
    expect(sanitizeErrorCode("", testMapping)).toBe("An internal error occurred");
  });

  it("空のマッピングではフォールバックメッセージを返す", () => {
    expect(sanitizeErrorCode("ANY_CODE", {})).toBe("An internal error occurred");
  });
});
