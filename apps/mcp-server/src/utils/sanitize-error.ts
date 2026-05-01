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

// =====================================================
// extractPrismaCode / Prismaエラーコード抽出
// =====================================================

/**
 * Extract a Prisma-shaped error code (`P\d{4}` such as `P2002`, `P2025`) from
 * an unknown error-like value.
 *
 * 未知のエラー値から Prisma 形式のエラーコード (`P\d{4}` 例: `P2002`, `P2025`)
 * を抽出する。
 *
 * PR-D-7 Wave 3 / FIND-PLAN-TPA-01 H binding (see Plan v1.2 §3.5.2 Step 5):
 *   When a caller shapes `result.errors[]` as an object form that carries a
 *   `code` field, it MUST be populated via this helper so the code matches the
 *   strict `/^P\d{4}$/` regex (no freeform strings). Callers are still
 *   responsible for CWE-200 defense: the raw Prisma code must only be paired
 *   with a sanitized `message` from `sanitizeErrorMessage` before any
 *   client-facing exposure.
 *
 * PR-D-7 Wave 3 / FIND-PLAN-TPA-01 H 対応 (Plan v1.2 §3.5.2 Step 5 参照):
 *   caller が `result.errors[]` の object form に `code` フィールドを含める場合、
 *   必ず本 helper を経由して `/^P\d{4}$/` に一致するコードのみを採用する
 *   (freeform 文字列は不可)。CWE-200 対策は caller 責務: raw Prisma code は
 *   client 露出前に `sanitizeErrorMessage` 由来の message と組み合わせること。
 *
 * @param error - Raw error (unknown type from catch blocks)
 * @returns Prisma error code if the error exposes a strict `P\d{4}` code,
 *          otherwise `undefined`.
 */
export function extractPrismaCode(error: unknown): string | undefined {
  if (error === null || error === undefined) {
    return undefined;
  }
  if (typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") {
    return undefined;
  }
  return /^P\d{4}$/.test(code) ? code : undefined;
}
