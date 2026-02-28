// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * project.get MCPツールハンドラー
 * ID指定でプロジェクト詳細を取得
 *
 * 機能:
 * - UUID指定でプロジェクト取得
 * - summaryオプションで軽量レスポンス
 * - 存在しないIDのエラーハンドリング
 * - 認証エラーのハンドリング
 *
 * レスポンス形式:
 * - 成功: { success: true, data: {...}, metadata: { request_id, ... } }
 * - エラー: { success: false, error: { code, message }, metadata: { request_id, ... } }
 */
import { ZodError } from 'zod';
import {
  projectGetInputSchema,
  type ProjectGetInput,
  type ProjectGetOutput,
  type ProjectGetSummaryOutput,
} from './schemas/project-schemas';
import { serviceClient } from '../services/service-client';
import { logger, isDevelopment } from '../utils/logger';
import { ErrorCode } from '../utils/errors';
import {
  type McpResponse,
  generateRequestId,
  createSuccessResponseWithRequestId,
  createErrorResponseWithRequestId,
} from '../utils/mcp-response';

/** project.get ハンドラーの戻り値型 */
export type ProjectGetResponse = McpResponse<ProjectGetOutput | ProjectGetSummaryOutput>;

/**
 * project.get ツールハンドラー
 *
 * @param input - 取得入力パラメータ
 * @returns 統一レスポンス形式（success: true/false + data/error + metadata.request_id）
 */
export async function projectGetHandler(
  input: unknown
): Promise<ProjectGetResponse> {
  // router.tsから注入された_request_idを使用、フォールバックとして自動生成
  const requestId =
    (input as Record<string, unknown> | null)?._request_id as string | undefined ??
    generateRequestId();

  // 開発環境でのログ出力
  if (isDevelopment()) {
    logger.info('[MCP Tool] project.get called', { input, requestId });
  }

  // 入力バリデーション
  let validated: ProjectGetInput;
  try {
    validated = projectGetInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');

      if (isDevelopment()) {
        logger.error('[MCP Tool] project.get validation error', {
          errors: error.errors,
          requestId,
        });
      }

      return createErrorResponseWithRequestId(
        ErrorCode.VALIDATION_ERROR,
        `入力バリデーションエラー: ${errorMessage}`,
        requestId,
        error.errors // details（開発環境のみ含まれる）
      );
    }
    // 予期せぬエラー
    return createErrorResponseWithRequestId(
      ErrorCode.INTERNAL_ERROR,
      '入力処理中に予期せぬエラーが発生しました',
      requestId
    );
  }

  try {
    // API呼び出し
    const result = await serviceClient.getProject(validated.id);

    // 存在しないIDの場合（ServiceClientでnullを返す）
    if (result === null) {
      if (isDevelopment()) {
        logger.warn('[MCP Tool] project.get - Project not found', {
          id: validated.id,
          requestId,
        });
      }

      return createErrorResponseWithRequestId(
        ErrorCode.PROJECT_NOT_FOUND,
        `指定されたIDのプロジェクトが見つかりません: ${validated.id}`,
        requestId
      );
    }

    if (isDevelopment()) {
      logger.info('[MCP Tool] project.get completed', {
        id: validated.id,
        name: result.name,
        summary: validated.summary,
        requestId,
      });
    }

    // summaryモードの場合は軽量レスポンスを返す（id, name, statusのみ）
    if (validated.summary) {
      const summaryData: ProjectGetSummaryOutput = {
        id: result.id,
        name: result.name,
        status: result.status,
        _summary_mode: true,
      };

      if (isDevelopment()) {
        logger.info('[MCP Tool] project.get returning summary response', {
          id: result.id,
          requestId,
        });
      }

      return createSuccessResponseWithRequestId(summaryData, requestId);
    }

    // フルレスポンス
    const fullData: ProjectGetOutput = {
      id: result.id,
      name: result.name,
      slug: result.slug,
      description: result.description,
      status: result.status,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      brandSetting: result.brandSetting ?? null,
    };

    return createSuccessResponseWithRequestId(fullData, requestId);
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] project.get API error', { error, requestId });
    }

    // 認証エラーのチェック
    if (error instanceof Error && error.message.includes('UNAUTHORIZED')) {
      return createErrorResponseWithRequestId(
        ErrorCode.UNAUTHORIZED,
        '認証が必要です',
        requestId
      );
    }

    return createErrorResponseWithRequestId(
      ErrorCode.INTERNAL_ERROR,
      'プロジェクト取得中にエラーが発生しました',
      requestId,
      error instanceof Error ? error.message : undefined
    );
  }
}

/**
 * project.get ツール定義
 * MCP Protocol用のツール定義オブジェクト
 */
export const projectGetToolDefinition = {
  name: 'project.get',
  description: 'Get project details by ID.',
  annotations: {
    title: 'Project Get',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: 'Project ID (UUID)',
      },
      summary: {
        type: 'boolean',
        description:
          'Lightweight mode: returns id, name, status only (default: true)',
        default: true,
      },
    },
    required: ['id'],
  },
};
