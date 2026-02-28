// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Server - Error Handling
 * エラーコード定義とMcpErrorクラス
 */

/**
 * MCPエラーコード定義
 * 14種類のエラーコードを定義
 */
export enum ErrorCode {
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  TRANSFORM_FAILED = 'TRANSFORM_FAILED',
  INVALID_QUERY = 'INVALID_QUERY',
  NO_RESULTS = 'NO_RESULTS',
  INVALID_ID = 'INVALID_ID',
  UNKNOWN_LICENSE = 'UNKNOWN_LICENSE',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  JOB_NOT_FOUND = 'JOB_NOT_FOUND',
  JOB_CANNOT_CANCEL = 'JOB_CANNOT_CANCEL',
  PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND',
  PALETTE_NOT_FOUND = 'PALETTE_NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  BRIEF_NOT_FOUND = 'BRIEF_NOT_FOUND',
  BRIEF_PARSE_ERROR = 'BRIEF_PARSE_ERROR',
  NO_ASSETS_MATCHED = 'NO_ASSETS_MATCHED',
  ROBOTS_TXT_BLOCKED = 'ROBOTS_TXT_BLOCKED',
  // WebDesign specific error codes
  LAYOUT_NOT_FOUND = 'LAYOUT_NOT_FOUND',
  MOTION_NOT_FOUND = 'MOTION_NOT_FOUND',
  QUALITY_EVALUATION_FAILED = 'QUALITY_EVALUATION_FAILED',
}

/**
 * MCP形式エラーレスポンスの型定義
 */
export interface McpErrorResponse {
  isError: true;
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

/**
 * MCP専用エラークラス
 * code, message, detailsを保持し、JSON形式・MCP形式への変換をサポート
 */
export class McpError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.details = details;

    // Errorクラスの継承時に必要なプロトタイプ設定
    Object.setPrototypeOf(this, McpError.prototype);
  }

  /**
   * JSON形式に変換
   */
  toJSON(): { code: ErrorCode; message: string; details: unknown } {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }

  /**
   * MCP形式のエラーレスポンスに変換
   */
  toMcpFormat(): McpErrorResponse {
    const detailsText = this.details
      ? `\n\nDetails: ${JSON.stringify(this.details, null, 2)}`
      : '';

    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error: ${this.code} - ${this.message}${detailsText}`,
        },
      ],
    };
  }
}
