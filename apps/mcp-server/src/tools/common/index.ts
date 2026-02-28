// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 共通MCPツールユーティリティ
 *
 * @module @reftrix/mcp-server/tools/common
 */

export {
  // エラーコード
  COMMON_MCP_ERROR_CODES,
  type CommonMcpErrorCode,
  // 型定義
  type McpErrorInfo,
  type McpSuccessResponse,
  type McpErrorResponse,
  type McpResponse,
  // ヘルパー関数
  createSuccessResponse,
  createErrorResponse,
  isSuccess,
  isError,
  determineCommonErrorCode,
} from './error-codes';
