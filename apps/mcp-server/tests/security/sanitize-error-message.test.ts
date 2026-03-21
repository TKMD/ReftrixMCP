// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * sanitizeErrorMessage 独立テスト
 * エラーコードから汎用メッセージへの変換を検証し、内部構造漏洩を防止
 *
 * sanitizeErrorMessage independent tests
 * Validates error code to generic message conversion, preventing internal structure leakage
 *
 * @module tests/security/sanitize-error-message.test
 */

import { describe, it, expect } from "vitest";

import {
  sanitizeErrorMessage,
  PREFERENCE_MCP_ERROR_CODES,
} from "../../src/tools/preference/schemas";

// =====================================================
// テスト / Tests
// =====================================================

describe("sanitizeErrorMessage", () => {
  // =====================================================
  // エラーコード → 固定メッセージ変換 / Error code → fixed message mapping
  // =====================================================
  describe("エラーコード→固定メッセージ変換 / error code to fixed message", () => {
    it('VALIDATION_ERROR → "Input validation failed"', () => {
      expect(sanitizeErrorMessage(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR)).toBe(
        "Input validation failed"
      );
    });

    it('PROFILE_NOT_FOUND → "Profile not found"', () => {
      expect(sanitizeErrorMessage(PREFERENCE_MCP_ERROR_CODES.PROFILE_NOT_FOUND)).toBe(
        "Profile not found"
      );
    });

    it('EMBEDDING_FAILED → "Embedding generation failed"', () => {
      expect(sanitizeErrorMessage(PREFERENCE_MCP_ERROR_CODES.EMBEDDING_FAILED)).toBe(
        "Embedding generation failed"
      );
    });

    it('SERVICE_UNAVAILABLE → "Preference service is not available"', () => {
      expect(sanitizeErrorMessage(PREFERENCE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE)).toBe(
        "Preference service is not available"
      );
    });

    it('INTERNAL_ERROR → "An internal error occurred"', () => {
      expect(sanitizeErrorMessage(PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR)).toBe(
        "An internal error occurred"
      );
    });

    it('RESET_NOT_CONFIRMED → "Reset not confirmed"', () => {
      expect(sanitizeErrorMessage(PREFERENCE_MCP_ERROR_CODES.RESET_NOT_CONFIRMED)).toBe(
        "Reset not confirmed"
      );
    });
  });

  // =====================================================
  // 未知のエラーコード / Unknown error codes
  // =====================================================
  describe("未知のエラーコード / unknown error codes", () => {
    it("未知のエラーコードに対してフォールバックメッセージを返す / returns fallback for unknown code", () => {
      expect(sanitizeErrorMessage("UNKNOWN_CODE")).toBe("An unexpected error occurred");
    });

    it("空文字列に対してフォールバックメッセージを返す / returns fallback for empty string", () => {
      expect(sanitizeErrorMessage("")).toBe("An unexpected error occurred");
    });

    it("Prismaエラーコード文字列に対してフォールバックメッセージを返す / returns fallback for Prisma-like code string", () => {
      // sanitizeErrorMessage はエラーコード文字列を受け取る設計
      // Prisma コード文字列は定義外なのでフォールバック
      expect(sanitizeErrorMessage("P2002")).toBe("An unexpected error occurred");
      expect(sanitizeErrorMessage("P2025")).toBe("An unexpected error occurred");
    });
  });

  // =====================================================
  // 内部構造漏洩防止 / Internal structure leakage prevention
  // =====================================================
  describe("内部構造漏洩防止 / internal structure leakage prevention", () => {
    it("全エラーコードの返却値にDB構造が含まれない / no DB structure in any response", () => {
      const allCodes = Object.values(PREFERENCE_MCP_ERROR_CODES);
      const dbPatterns = [
        "preference_profiles",
        "preference_signals",
        "web_pages",
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "WHERE",
        "FROM",
        "JOIN",
        "$1",
      ];

      for (const code of allCodes) {
        const message = sanitizeErrorMessage(code);
        for (const pattern of dbPatterns) {
          expect(message).not.toContain(pattern);
        }
      }
    });

    it("未知のコードでもDB構造が含まれない / no DB structure for unknown codes", () => {
      const unknownMessage = sanitizeErrorMessage("SOME_UNKNOWN_ERROR");
      expect(unknownMessage).not.toContain("table");
      expect(unknownMessage).not.toContain("column");
      expect(unknownMessage).not.toContain("constraint");
    });

    it("全エラーコードが非空の文字列を返す / all codes return non-empty strings", () => {
      const allCodes = Object.values(PREFERENCE_MCP_ERROR_CODES);
      for (const code of allCodes) {
        const message = sanitizeErrorMessage(code);
        expect(typeof message).toBe("string");
        expect(message.length).toBeGreaterThan(0);
      }
    });

    it("スタックトレース情報が含まれない / no stack trace information", () => {
      const allCodes = [...Object.values(PREFERENCE_MCP_ERROR_CODES), "UNKNOWN"];
      const stackPatterns = ["at ", "Error:", "node_modules", ".ts:", ".js:"];

      for (const code of allCodes) {
        const message = sanitizeErrorMessage(code);
        for (const pattern of stackPatterns) {
          expect(message).not.toContain(pattern);
        }
      }
    });
  });
});
