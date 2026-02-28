// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * project.list MCPツールハンドラー
 * ユーザーのプロジェクト一覧を取得
 *
 * 機能:
 * - ステータスフィルタ
 * - ページネーション（limit, offset）
 * - ソート（sortBy, sortOrder）
 * - summaryオプションで軽量レスポンス
 * - 認証エラーのハンドリング
 *
 * レスポンス形式:
 * - 成功: { success: true, data: {...}, metadata: { request_id, ... } }
 * - エラー: { success: false, error: { code, message }, metadata: { request_id, ... } }
 */
import { ZodError } from 'zod';
import {
  projectListInputSchema,
  type ProjectListInput,
  type ProjectListOutput,
  type ProjectListSummaryOutput,
  type ProjectListItem,
  type ProjectListItemSummary,
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

/** project.list ハンドラーの戻り値型 */
export type ProjectListResponse = McpResponse<ProjectListOutput | ProjectListSummaryOutput>;

/**
 * project.list ツールハンドラー
 *
 * @param input - 一覧取得パラメータ
 * @returns 統一レスポンス形式（success: true/false + data/error + metadata.request_id）
 */
export async function projectListHandler(
  input: unknown
): Promise<ProjectListResponse> {
  // router.tsから注入された_request_idを使用、フォールバックとして自動生成
  const requestId =
    (input as Record<string, unknown> | null)?._request_id as string | undefined ??
    generateRequestId();

  // 開発環境でのログ出力
  if (isDevelopment()) {
    logger.info('[MCP Tool] project.list called', { input, requestId });
  }

  // null/undefined を空オブジェクトに変換
  const normalizedInput = input ?? {};

  // 入力バリデーション
  let validated: ProjectListInput;
  try {
    validated = projectListInputSchema.parse(normalizedInput);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');

      if (isDevelopment()) {
        logger.error('[MCP Tool] project.list validation error', {
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
    const result = await serviceClient.listProjects({
      status: validated.status,
      limit: validated.limit,
      offset: validated.offset,
      sortBy: validated.sortBy,
      sortOrder: validated.sortOrder,
    });

    if (isDevelopment()) {
      logger.info('[MCP Tool] project.list completed', {
        count: result.projects.length,
        total: result.total,
        summary: validated.summary,
        requestId,
      });
    }

    // summaryモードの場合は軽量レスポンスを返す（id, name, statusのみ）
    if (validated.summary) {
      const summaryProjects: ProjectListItemSummary[] = result.projects.map(
        (project) => ({
          id: project.id,
          name: project.name,
          status: project.status,
        })
      );

      const summaryData: ProjectListSummaryOutput = {
        projects: summaryProjects,
        total: result.total,
        _summary_mode: true,
      };

      if (isDevelopment()) {
        logger.info('[MCP Tool] project.list returning summary response', {
          count: summaryProjects.length,
          requestId,
        });
      }

      return createSuccessResponseWithRequestId(summaryData, requestId);
    }

    // フルレスポンス
    const fullProjects: ProjectListItem[] = result.projects.map((project) => ({
      id: project.id,
      name: project.name,
      slug: project.slug,
      description: project.description,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      brandSetting: project.brandSetting ?? null,
    }));

    const fullData: ProjectListOutput = {
      projects: fullProjects,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };

    return createSuccessResponseWithRequestId(fullData, requestId);
  } catch (error) {
    // SEC: 開発環境のみでエラー詳細をログ（スタックトレース含む）
    // 本番環境ではメッセージとrequestIdのみ
    if (isDevelopment()) {
      logger.error('[MCP Tool] project.list API error', {
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        requestId,
      });
    } else {
      logger.error('[MCP Tool] project.list API error', {
        message: error instanceof Error ? error.message : String(error),
        requestId,
      });
    }

    // 認証エラーのチェック
    if (error instanceof Error && error.message.includes('UNAUTHORIZED')) {
      return createErrorResponseWithRequestId(
        ErrorCode.UNAUTHORIZED,
        '認証が必要です',
        requestId
      );
    }

    // 詳細なエラーメッセージを含めて返す（開発時のデバッグ用）
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createErrorResponseWithRequestId(
      ErrorCode.INTERNAL_ERROR,
      `プロジェクト一覧取得中にエラーが発生しました`,
      requestId,
      errorMessage // details（開発環境のみ含まれる）
    );
  }
}

/**
 * project.list ツール定義
 * MCP Protocol用のツール定義オブジェクト
 */
export const projectListToolDefinition = {
  name: 'project.list',
  description: 'List user projects. Supports status filter, pagination, sorting.',
  annotations: {
    title: 'Project List',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        enum: ['draft', 'in_progress', 'review', 'completed', 'archived'],
        description: 'Filter by project status (optional)',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Limit (1-50, default: 10)',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Offset (default: 0)',
      },
      sortBy: {
        type: 'string',
        enum: ['createdAt', 'updatedAt', 'name'],
        default: 'updatedAt',
        description: 'Sort by (default: updatedAt)',
      },
      sortOrder: {
        type: 'string',
        enum: ['asc', 'desc'],
        default: 'desc',
        description: 'Sort order (default: desc)',
      },
      summary: {
        type: 'boolean',
        description:
          'Lightweight mode: returns id, name, status only (default: true)',
        default: true,
      },
    },
  },
};
