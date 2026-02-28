// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 共通MCPエラーコード定義
 * 全ツール共通で使用するエラーコードを定義
 *
 * @module @reftrix/mcp-server/tools/common/error-codes
 */

// ============================================================================
// McpResponse型を再エクスポート（統一形式）
// ============================================================================

// 統一McpResponse型はutils/mcp-response.tsからインポート
export {
  type McpSuccessResponse,
  type McpErrorResponse,
  type McpResponse,
  type McpErrorInfo,
  type McpResponseMetadata,
  createSuccessResponse,
  createErrorResponse,
  isSuccessResponse,
  isErrorResponse,
  generateRequestId,
  withRequestId,
  withProcessingTime,
  createSuccessResponseWithRequestId,
  createErrorResponseWithRequestId,
} from '../../utils/mcp-response';

// 互換性のためエイリアスをエクスポート
export { isSuccessResponse as isSuccess, isErrorResponse as isError } from '../../utils/mcp-response';

// ============================================================================
// 共通エラーコード
// ============================================================================

/**
 * 全ツール共通のエラーコード
 * 各ツール固有のエラーコードに加えて使用される
 */
export const COMMON_MCP_ERROR_CODES = {
  /** 入力バリデーションエラー */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** 内部エラー */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** サービス利用不可 */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** リソースが見つからない */
  NOT_FOUND: 'NOT_FOUND',
  /** タイムアウト */
  TIMEOUT: 'TIMEOUT',
  /** データベースエラー */
  DB_ERROR: 'DB_ERROR',
  /** ネットワークエラー */
  NETWORK_ERROR: 'NETWORK_ERROR',
} as const;

export type CommonMcpErrorCode =
  (typeof COMMON_MCP_ERROR_CODES)[keyof typeof COMMON_MCP_ERROR_CODES];

/**
 * 汎用エラーコード判定
 * エラーメッセージから適切なエラーコードを判定
 */
export function determineCommonErrorCode(error: Error | string): CommonMcpErrorCode {
  const message = typeof error === 'string' ? error : error.message;
  const lowerMessage = message.toLowerCase();

  // データベースエラー
  if (
    lowerMessage.includes('database') ||
    lowerMessage.includes('prisma') ||
    lowerMessage.includes('connection') ||
    lowerMessage.includes('query')
  ) {
    return COMMON_MCP_ERROR_CODES.DB_ERROR;
  }

  // ネットワークエラー
  if (
    lowerMessage.includes('network') ||
    lowerMessage.includes('fetch') ||
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('etimedout')
  ) {
    return COMMON_MCP_ERROR_CODES.NETWORK_ERROR;
  }

  // タイムアウト
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return COMMON_MCP_ERROR_CODES.TIMEOUT;
  }

  // バリデーションエラー
  if (
    lowerMessage.includes('validation') ||
    lowerMessage.includes('invalid') ||
    lowerMessage.includes('required')
  ) {
    return COMMON_MCP_ERROR_CODES.VALIDATION_ERROR;
  }

  // 見つからない
  if (
    lowerMessage.includes('not found') ||
    lowerMessage.includes('does not exist')
  ) {
    return COMMON_MCP_ERROR_CODES.NOT_FOUND;
  }

  // その他は内部エラー
  return COMMON_MCP_ERROR_CODES.INTERNAL_ERROR;
}
