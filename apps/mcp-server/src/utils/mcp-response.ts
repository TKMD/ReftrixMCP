// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP統一レスポンス形式
 *
 * 全MCPツールで使用する統一レスポンス形式を定義
 * 成功/エラーを同じ構造で表現し、クライアント側の処理を簡素化
 *
 * 設計原則:
 * - 成功/エラーを success フィールドで明示的に区別
 * - 軽量化モード情報を metadata で統一表現
 * - エラー情報は error オブジェクトに集約
 * - 型安全性を確保（TypeScript discriminated union）
 *
 * @see SEC監査: 機密情報漏洩防止のため details は開発環境のみ
 */

import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { ErrorCode } from './errors';
import { isDevelopment } from './logger';

// =============================================================================
// 型定義
// =============================================================================

/**
 * 最適化モード
 * - full: 全フィールド返却
 * - summary: 軽量化（主要フィールドのみ）
 * - compact: 最小限（ID等のみ）
 * - truncated: 切り詰め（サイズ制限適用）
 */
export type OptimizationMode = 'full' | 'summary' | 'compact' | 'truncated';

/**
 * メタデータ（全レスポンス共通）
 */
export interface McpResponseMetadata {
  /** リクエストID（ログ/メトリクス相関用） */
  request_id?: string;
  /** 処理時間（ミリ秒） */
  processing_time_ms?: number;
  /** 適用された最適化モード */
  optimization_mode?: OptimizationMode;
  /** 切り詰めが適用されたか */
  truncated?: boolean;
  /** 元のサイズ（切り詰め時） */
  original_size?: number;
  /** 総件数（ページネーション時） */
  total_count?: number;
  /** オフセット（ページネーション時） */
  offset?: number;
  /** リミット（ページネーション時） */
  limit?: number;
}

/**
 * エラー情報
 */
export interface McpErrorInfo {
  /** エラーコード */
  code: string;
  /** エラーメッセージ */
  message: string;
  /** 詳細情報（開発環境のみ） */
  details?: unknown;
}

/**
 * 成功レスポンス
 */
export interface McpSuccessResponse<T> {
  success: true;
  data: T;
  metadata?: McpResponseMetadata;
}

/**
 * エラーレスポンス
 */
export interface McpErrorResponse {
  success: false;
  error: McpErrorInfo;
  metadata?: McpResponseMetadata;
}

/**
 * 統一レスポンス型（discriminated union）
 */
export type McpResponse<T> = McpSuccessResponse<T> | McpErrorResponse;

// =============================================================================
// Zodスキーマ
// =============================================================================

/**
 * 最適化モードスキーマ
 */
export const optimizationModeSchema = z.enum(['full', 'summary', 'compact', 'truncated']);

/**
 * メタデータスキーマ
 */
export const mcpResponseMetadataSchema = z.object({
  request_id: z.string().optional(),
  processing_time_ms: z.number().optional(),
  optimization_mode: optimizationModeSchema.optional(),
  truncated: z.boolean().optional(),
  original_size: z.number().optional(),
  total_count: z.number().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

/**
 * エラー情報スキーマ
 */
export const mcpErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

/**
 * 成功レスポンススキーマファクトリ
 * @param dataSchema - データ部分のスキーマ
 */
export function createSuccessResponseSchema<T extends z.ZodTypeAny>(
  dataSchema: T
): z.ZodObject<{
  success: z.ZodLiteral<true>;
  data: T;
  metadata: z.ZodOptional<typeof mcpResponseMetadataSchema>;
}> {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
    metadata: mcpResponseMetadataSchema.optional(),
  });
}

/**
 * エラーレスポンススキーマ
 */
export const mcpErrorResponseSchema = z.object({
  success: z.literal(false),
  error: mcpErrorInfoSchema,
  metadata: mcpResponseMetadataSchema.optional(),
});

/**
 * 統一レスポンススキーマファクトリ
 * @param dataSchema - 成功時のデータスキーマ
 */
export function createMcpResponseSchema<T extends z.ZodTypeAny>(
  dataSchema: T
): z.ZodUnion<
  [
    z.ZodObject<{
      success: z.ZodLiteral<true>;
      data: T;
      metadata: z.ZodOptional<typeof mcpResponseMetadataSchema>;
    }>,
    typeof mcpErrorResponseSchema,
  ]
> {
  return z.union([
    createSuccessResponseSchema(dataSchema),
    mcpErrorResponseSchema,
  ]);
}

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * 成功レスポンスを作成
 * @param data - レスポンスデータ
 * @param metadata - オプションのメタデータ
 */
export function createSuccessResponse<T>(
  data: T,
  metadata?: McpResponseMetadata
): McpSuccessResponse<T> {
  return {
    success: true,
    data,
    ...(metadata && { metadata }),
  };
}

/**
 * エラーレスポンスを作成
 * @param code - エラーコード
 * @param message - エラーメッセージ
 * @param details - 詳細情報（開発環境のみ含める）
 * @param metadata - オプションのメタデータ
 */
export function createErrorResponse(
  code: string | ErrorCode,
  message: string,
  details?: unknown,
  metadata?: McpResponseMetadata
): McpErrorResponse {
  return {
    success: false,
    error: {
      code: String(code),
      message,
      // SEC: 詳細情報は開発環境のみ
      ...(isDevelopment() && details !== undefined && { details }),
    },
    ...(metadata && { metadata }),
  };
}

/**
 * レスポンスが成功かどうかを判定（型ガード）
 */
export function isSuccessResponse<T>(
  response: McpResponse<T>
): response is McpSuccessResponse<T> {
  return response.success === true;
}

/**
 * レスポンスがエラーかどうかを判定（型ガード）
 */
export function isErrorResponse<T>(
  response: McpResponse<T>
): response is McpErrorResponse {
  return response.success === false;
}

/**
 * 処理時間を計測してメタデータに追加
 * @param startTime - 開始時刻（performance.now()）
 * @param existingMetadata - 既存のメタデータ
 */
export function withProcessingTime(
  startTime: number,
  existingMetadata?: McpResponseMetadata
): McpResponseMetadata {
  return {
    ...existingMetadata,
    processing_time_ms: performance.now() - startTime,
  };
}

/**
 * ページネーション情報をメタデータに追加
 * @param totalCount - 総件数
 * @param offset - オフセット
 * @param limit - リミット
 * @param existingMetadata - 既存のメタデータ
 */
export function withPagination(
  totalCount: number,
  offset: number,
  limit: number,
  existingMetadata?: McpResponseMetadata
): McpResponseMetadata {
  return {
    ...existingMetadata,
    total_count: totalCount,
    offset,
    limit,
  };
}

/**
 * 最適化モードをメタデータに追加
 * @param mode - 最適化モード
 * @param existingMetadata - 既存のメタデータ
 */
export function withOptimizationMode(
  mode: OptimizationMode,
  existingMetadata?: McpResponseMetadata
): McpResponseMetadata {
  return {
    ...existingMetadata,
    optimization_mode: mode,
  };
}

/**
 * 切り詰め情報をメタデータに追加
 * @param originalSize - 元のサイズ
 * @param existingMetadata - 既存のメタデータ
 */
export function withTruncation(
  originalSize: number,
  existingMetadata?: McpResponseMetadata
): McpResponseMetadata {
  return {
    ...existingMetadata,
    truncated: true,
    original_size: originalSize,
    optimization_mode: 'truncated',
  };
}

// =============================================================================
// リクエストID生成
// =============================================================================

/**
 * 一意のリクエストIDを生成（UUIDv7形式）
 *
 * 形式: UUIDv7（時間順序付きUUID）
 * 例: 01932a6e-8b7c-7d8e-9f0a-1b2c3d4e5f6a
 *
 * 用途:
 * - ログ/メトリクスとの相関
 * - エラートレーシング
 * - クライアント側での追跡
 *
 * セキュリティ:
 * - UUIDv7は暗号学的に安全なランダム成分を持つ
 * - 予測不可能（SEC要件準拠）
 * - RESP-14 (L-02): フォールバック処理でエラー耐性を確保
 */
export function generateRequestId(): string {
  try {
    return uuidv7();
  } catch {
    // SEC: フォールバック - crypto.randomUUID()を使用
    // UUIDv7生成に失敗した場合の耐障害性確保
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // 最終フォールバック: タイムスタンプ + ランダム文字列
    return `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

/**
 * リクエストIDをメタデータに追加
 * @param requestId - リクエストID（省略時は自動生成）
 * @param existingMetadata - 既存のメタデータ
 */
export function withRequestId(
  requestId?: string,
  existingMetadata?: McpResponseMetadata
): McpResponseMetadata {
  return {
    ...existingMetadata,
    request_id: requestId ?? generateRequestId(),
  };
}

/**
 * 成功レスポンスを作成（requestId付き）
 * @param data - レスポンスデータ
 * @param requestId - リクエストID（省略時は自動生成）
 * @param metadata - 追加のメタデータ
 */
export function createSuccessResponseWithRequestId<T>(
  data: T,
  requestId?: string,
  metadata?: Omit<McpResponseMetadata, 'request_id'>
): McpSuccessResponse<T> {
  return {
    success: true,
    data,
    metadata: {
      request_id: requestId ?? generateRequestId(),
      ...metadata,
    },
  };
}

/**
 * エラーレスポンスを作成（requestId付き）
 * @param code - エラーコード
 * @param message - エラーメッセージ
 * @param requestId - リクエストID（省略時は自動生成）
 * @param details - 詳細情報（開発環境のみ含める）
 * @param metadata - 追加のメタデータ
 */
export function createErrorResponseWithRequestId(
  code: string | ErrorCode,
  message: string,
  requestId?: string,
  details?: unknown,
  metadata?: Omit<McpResponseMetadata, 'request_id'>
): McpErrorResponse {
  return {
    success: false,
    error: {
      code: String(code),
      message,
      // SEC: 詳細情報は開発環境のみ
      ...(isDevelopment() && details !== undefined && { details }),
    },
    metadata: {
      request_id: requestId ?? generateRequestId(),
      ...metadata,
    },
  };
}
