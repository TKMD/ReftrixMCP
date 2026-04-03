// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Server - Tool Router
 * MCPツールのルーティングとハンドラー管理
 *
 * 認証ミドルウェア統合対応
 * 観測性統合（MetricsCollector）
 */

import { ErrorCode, McpError } from "./utils/errors";
import { logger } from "./utils/logger";
import type { AuthMiddlewareInstance, AuthContext } from "./middleware/auth";
import {
  applyLightResponse,
  extractLightResponseOptions,
} from "./middleware/light-response-controller";
import { checkRateLimit } from "./middleware/rate-limiter";
import { getMetricsCollector, type MetricsStats } from "./services/metrics-collector";
import { generateRequestId } from "./utils/mcp-response";
import {
  buildTelemetryEntry,
  isUsageTelemetryEnabled,
  logToolUsage,
} from "./utils/usage-telemetry";
import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";

/**
 * 進捗報告コンテキスト（MCP Phase 4）
 *
 * クライアントが_meta.progressTokenを提供した場合に利用可能
 */
export interface ProgressContext {
  /** クライアントから提供されたprogressToken */
  progressToken: string | number | undefined;
  /** MCP SDK sendNotification関数 */
  sendNotification: (notification: ProgressNotification) => Promise<void>;
}

/**
 * ツールハンドラーの型定義
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  progressContext?: ProgressContext
) => Promise<unknown>;

/**
 * ツールハンドラーのマップ
 * 35のMCPツールを管理（allToolDefinitions SSoTから自動同期）
 */
export const toolHandlers: Map<string, ToolHandler> = new Map();

/**
 * 認証ミドルウェアのインスタンス（デフォルトはnull = 認証無効）
 * index.tsからsetAuthMiddlewareで設定される
 */
let authMiddleware: AuthMiddlewareInstance | null = null;

/**
 * 認証ミドルウェアを設定
 * @param middleware - 認証ミドルウェアインスタンス
 */
export function setAuthMiddleware(middleware: AuthMiddlewareInstance): void {
  logger.info("[Router] Authentication middleware configured");
  authMiddleware = middleware;
}

/**
 * 認証ミドルウェアをクリア（テスト用）
 */
export function clearAuthMiddleware(): void {
  authMiddleware = null;
}

/**
 * 現在の認証ミドルウェアを取得（テスト用）
 */
export function getAuthMiddleware(): AuthMiddlewareInstance | null {
  return authMiddleware;
}

/**
 * ツールハンドラーを登録
 */
export function registerTool(name: string, handler: ToolHandler): void {
  logger.debug(`Registering tool: ${name}`);
  toolHandlers.set(name, handler);
}

/**
 * ツール呼び出しの結果型
 */
export interface ToolCallResult {
  result: unknown;
  authContext?: AuthContext;
  /** リクエストID（ログ相関用） */
  requestId?: string;
  /** 処理時間（ミリ秒） */
  durationMs?: number;
}

/**
 * ツール呼び出し統計情報
 */
export interface ToolCallStats {
  /** ツール別呼び出し回数 */
  callsByTool: Record<string, number>;
  /** ツール別エラー回数 */
  errorsByTool: Record<string, number>;
  /** ツール別平均レスポンス時間 */
  avgResponseTimeByTool: Record<string, number>;
  /** 全体統計 */
  overall: {
    totalCalls: number;
    totalErrors: number;
    errorRate: number;
    avgResponseTime: number;
  };
}

/**
 * ツール呼び出しを実行（認証対応版・観測性統合・進捗報告対応）
 *
 * @param toolName - ツール名
 * @param args - ツール引数
 * @param apiKey - APIキー（オプション）
 * @param requestId - リクエストID（オプション、未指定時は自動生成）
 * @param progressContext - 進捗報告コンテキスト（オプション）
 * @returns ツール実行結果
 * @throws McpError - 認証失敗時またはツールエラー時
 */
export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  apiKey?: string,
  requestId?: string,
  progressContext?: ProgressContext
): Promise<unknown> {
  // リクエストIDを生成（UUIDv7形式、ログ相関用）
  const reqId = requestId ?? generateRequestId();
  const startTime = performance.now();

  // メトリクス収集
  const metrics = getMetricsCollector();
  metrics.incrementRequestCount(toolName, "TOOL_CALL");
  metrics.incrementActiveConnections();

  logger.debug(`[Router] Tool call: ${toolName}`, {
    requestId: reqId,
    args,
    hasApiKey: !!apiKey,
  });

  // 認証チェック（ミドルウェアが設定されている場合のみ）
  let authContext: AuthContext | undefined;
  if (authMiddleware) {
    const authResult = await authMiddleware.checkAuth(toolName, apiKey);
    if (!authResult.success) {
      const errorCode =
        authResult.error?.code === "FORBIDDEN" ? ErrorCode.FORBIDDEN : ErrorCode.UNAUTHORIZED;
      const error = new McpError(errorCode, authResult.error?.message ?? "Authentication failed", {
        tool: toolName,
        requestId: reqId,
      });

      // 認証エラーをメトリクスに記録
      metrics.incrementErrorCount(toolName, errorCode);
      metrics.decrementActiveConnections();

      const duration = performance.now() - startTime;
      metrics.recordResponseTime(duration, toolName);

      logger.warn(`[Router] Authentication failed for tool: ${toolName}`, {
        requestId: reqId,
        errorCode: authResult.error?.code,
        durationMs: duration,
      });
      throw error;
    }
    authContext = authResult.context;
    logger.debug(`[Router] Authentication passed for tool: ${toolName}`, {
      requestId: reqId,
      userId: authContext?.userId,
      role: authContext?.role,
    });
  }

  // レート制限チェック（CWE-770 DoS対策）
  const rateLimitResult = await checkRateLimit(toolName);
  if (!rateLimitResult.allowed) {
    const error = new McpError(
      ErrorCode.RATE_LIMIT_EXCEEDED,
      `Rate limit exceeded for tool: ${toolName}. Retry after ${rateLimitResult.retryAfterMs}ms`,
      {
        tool: toolName,
        requestId: reqId,
        retryAfterMs: rateLimitResult.retryAfterMs,
        limit: rateLimitResult.limit,
      }
    );

    metrics.incrementErrorCount(toolName, ErrorCode.RATE_LIMIT_EXCEEDED);
    metrics.decrementActiveConnections();

    const duration = performance.now() - startTime;
    metrics.recordResponseTime(duration, toolName);

    logger.warn(`[Router] Rate limit exceeded for tool: ${toolName}`, {
      requestId: reqId,
      retryAfterMs: rateLimitResult.retryAfterMs,
      durationMs: duration,
    });
    throw error;
  }

  // ツールハンドラーの取得
  const handler = toolHandlers.get(toolName);

  if (!handler) {
    const error = new McpError(ErrorCode.TOOL_NOT_FOUND, `Unknown tool: ${toolName}`, {
      toolName,
      requestId: reqId,
    });

    // ツール未発見エラーをメトリクスに記録
    metrics.incrementErrorCount(toolName, ErrorCode.TOOL_NOT_FOUND);
    metrics.decrementActiveConnections();

    const duration = performance.now() - startTime;
    metrics.recordResponseTime(duration, toolName);

    logger.error(`[Router] Tool not found: ${toolName}`, {
      requestId: reqId,
      durationMs: duration,
    });
    throw error;
  }

  try {
    // リクエストIDを引数に注入（ツール内でのログ相関用）
    const argsWithRequestId = {
      ...args,
      _request_id: reqId,
    };
    // 進捗報告コンテキストを渡してハンドラーを呼び出し（MCP Phase 4）
    const result = await handler(argsWithRequestId, progressContext);

    const duration = performance.now() - startTime;
    metrics.recordResponseTime(duration, toolName);
    metrics.decrementActiveConnections();

    // Light Response変換を適用
    // ツール引数からsummary/include_*オプションを抽出
    const lightResponseOptions = extractLightResponseOptions(args);
    const lightResult = applyLightResponse(toolName, result, lightResponseOptions);

    logger.debug(`[Router] Tool call completed: ${toolName}`, {
      requestId: reqId,
      durationMs: duration,
      lightResponseApplied: lightResponseOptions.summary !== false,
    });

    // Usage Telemetry — fire-and-forget（成功パス）
    // SEC-02: tool/at/durationMs/success の4フィールドのみ。args/requestId等は含めない
    if (isUsageTelemetryEnabled()) {
      logToolUsage(buildTelemetryEntry(toolName, duration, true)).catch(() => {
        /* fire-and-forget: テレメトリ書き込み失敗は無視 */
      });
    }

    return lightResult;
  } catch (error) {
    const duration = performance.now() - startTime;
    const errorType = error instanceof McpError ? error.code : "UNKNOWN_ERROR";

    // エラーをメトリクスに記録
    metrics.incrementErrorCount(toolName, errorType);
    metrics.recordResponseTime(duration, toolName);
    metrics.decrementActiveConnections();

    // Usage Telemetry — fire-and-forget（失敗パス）
    // SEC-02: tool/at/durationMs/success の4フィールドのみ。error.message等は含めない
    if (isUsageTelemetryEnabled()) {
      logToolUsage(buildTelemetryEntry(toolName, duration, false)).catch(() => {
        /* fire-and-forget: テレメトリ書き込み失敗は無視 */
      });
    }

    logger.error(`[Router] Tool call error: ${toolName}`, {
      requestId: reqId,
      error,
      durationMs: duration,
    });
    throw error;
  }
}

/**
 * 登録されているツールの一覧を取得
 */
export function getRegisteredTools(): string[] {
  return Array.from(toolHandlers.keys());
}

/**
 * 全ツールハンドラーをクリア (テスト用)
 */
export function clearToolHandlers(): void {
  toolHandlers.clear();
}

/**
 * メトリクス統計を取得
 *
 * system.healthや監視ツールから呼び出される
 * @returns MetricsStats - メトリクス統計情報
 */
export function getToolMetricsStats(): MetricsStats {
  const metrics = getMetricsCollector();
  return metrics.getStats();
}

/**
 * メトリクスをリセット（テスト用）
 */
export function resetToolMetrics(): void {
  const metrics = getMetricsCollector();
  metrics.reset();
}

/**
 * メトリクスをPrometheus形式でエクスポート
 *
 * @returns Prometheus形式のメトリクス文字列
 */
export function exportMetricsPrometheus(): string {
  const metrics = getMetricsCollector();
  return metrics.exportPrometheus();
}

/**
 * MCPツール名の定数（WebDesign専用）
 *
 * SSoT: allToolDefinitions (tools/index.ts) から自動導出。
 * tools/index.ts 側で TOOL_NAMES / ALL_TOOL_NAMES を生成し、
 * router.ts は re-export する。
 * 手動更新不要 — ツール追加/削除時は allToolDefinitions のみ変更すればOK。
 */
export { TOOL_NAMES, ALL_TOOL_NAMES } from "./tools/tool-names";
