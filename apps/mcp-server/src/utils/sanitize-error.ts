// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unified error message sanitization utility
 * 統一エラーメッセージサニタイズユーティリティ
 *
 * Prevents internal structure leakage (CWE-209) by mapping
 * raw error objects to safe, user-facing messages.
 * 内部構造の漏洩防止（CWE-209）のため、生のエラーオブジェクトを
 * 安全なユーザー向けメッセージにマッピング。
 *
 * @module utils/sanitize-error
 */

// =====================================================
// Prisma Error Code Mapping / Prismaエラーコードマッピング
// =====================================================

const PRISMA_ERROR_MESSAGES: Record<string, string> = {
  // Common Request Errors / 一般的なリクエストエラー
  P2000: "Value too long for the column",
  P2001: "Record not found",
  P2002: "A record with this value already exists",
  P2003: "Foreign key constraint failed",
  P2025: "Record not found",

  // Connection Errors / 接続エラー
  P1001: "Database server is unreachable",
  P1002: "Database server connection timed out",
  P1003: "Database does not exist",
  P1008: "Operation timed out",
  P1017: "Database server closed the connection",
};

// =====================================================
// Generic Error Category Messages / 汎用エラーカテゴリメッセージ
// =====================================================

const CATEGORY_MESSAGES = {
  database: "Database operation failed",
  network: "Network request failed",
  timeout: "Operation timed out",
  validation: "Input validation failed",
  not_found: "Resource not found",
  service: "Service is temporarily unavailable",
  internal: "An internal error occurred",
} as const;

// =====================================================
// sanitizeErrorMessage / エラーサニタイズ関数
// =====================================================

/**
 * Sanitize error for client-facing response.
 * クライアント向けレスポンスのエラーをサニタイズ。
 *
 * - Prisma errors: mapped by error code (P2002, P2025, etc.)
 * - Network/timeout errors: detected by message keywords
 * - All others: generic "An internal error occurred"
 *
 * Server-side logging should use the original error object.
 * サーバーサイドのログには元のエラーオブジェクトを使用すること。
 *
 * @param error - Raw error (unknown type from catch blocks)
 * @returns Safe, user-facing error message
 *
 * @example
 * ```typescript
 * catch (error) {
 *   logger.error("Operation failed", { error });
 *   return createErrorResponse({ message: sanitizeErrorMessage(error) });
 * }
 * ```
 */
export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Prisma known request errors (P2xxx, P1xxx)
    const prismaError = error as { code?: string };
    if (prismaError.code && prismaError.code in PRISMA_ERROR_MESSAGES) {
      return PRISMA_ERROR_MESSAGES[prismaError.code]!;
    }

    // Prisma-like error codes (Pxxxx pattern) — generic DB message
    if (prismaError.code && /^P\d{4}$/.test(prismaError.code)) {
      return CATEGORY_MESSAGES.database;
    }

    // Detect category from error message (keyword-based)
    const lowerMessage = error.message.toLowerCase();

    if (lowerMessage.includes("timeout") || lowerMessage.includes("timed out")) {
      return CATEGORY_MESSAGES.timeout;
    }
    if (
      lowerMessage.includes("econnrefused") ||
      lowerMessage.includes("etimedout") ||
      lowerMessage.includes("enotfound") ||
      lowerMessage.includes("fetch failed")
    ) {
      return CATEGORY_MESSAGES.network;
    }
    if (lowerMessage.includes("not found") || lowerMessage.includes("does not exist")) {
      return CATEGORY_MESSAGES.not_found;
    }
  }

  // Error code string (from domain-specific error code enums)
  if (typeof error === "string") {
    return CATEGORY_MESSAGES.internal;
  }

  return CATEGORY_MESSAGES.internal;
}

/**
 * Sanitize error by MCP error code string.
 * MCPエラーコード文字列からサニタイズ。
 *
 * Used when the caller already has a domain-specific error code
 * (e.g., PREFERENCE_MCP_ERROR_CODES.PROFILE_NOT_FOUND).
 *
 * @param errorCode - Domain-specific error code string
 * @param codeToMessageMap - Mapping of error codes to user-facing messages
 * @returns Safe, user-facing error message
 */
export function sanitizeErrorCode(
  errorCode: string,
  codeToMessageMap: Record<string, string>
): string {
  return codeToMessageMap[errorCode] ?? (CATEGORY_MESSAGES.internal as string);
}
