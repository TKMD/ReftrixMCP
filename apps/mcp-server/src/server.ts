// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Server - Server Implementation
 * MCPサーバーの作成と管理
 *
 * 認証ミドルウェア統合対応
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolRequest, ProgressNotification } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './utils/logger';
import { handleToolCall, type ProgressContext } from './router';
import { McpError } from './utils/errors';
import { allToolDefinitions, getToolDefinition } from './tools';
import { responseSizeWarning } from './middleware';
import {
  generateRequestId,
  createErrorResponseWithRequestId,
} from './utils/mcp-response';
import { coerceArgs } from './middleware/args-type-coercion';

/**
 * ツールレスポンスがエラーかどうかを判定
 * 標準形式: { success: false, error: {...} }
 */
function isToolErrorResponse(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) {
    return false;
  }
  const obj = result as Record<string, unknown>;
  return obj.success === false && obj.error !== undefined;
}

/**
 * レスポンスにrequest_idがない場合は注入
 *
 * McpResponse形式（{ success, data/error, metadata }）を検出し、
 * metadata.request_idが未設定の場合に追加する
 *
 * @param result - ツールのレスポンス
 * @param requestId - 注入するリクエストID（UUIDv7形式）
 * @returns request_idが追加されたレスポンス
 */
function injectRequestIdIfMissing(result: unknown, requestId: string): unknown {
  // オブジェクトでない場合はそのまま返す
  if (typeof result !== 'object' || result === null) {
    return result;
  }

  const obj = result as Record<string, unknown>;

  // McpResponse形式かチェック（successフィールドを持つ）
  if (typeof obj.success !== 'boolean') {
    return result;
  }

  // 既存のmetadataを取得
  const existingMetadata = (obj.metadata as Record<string, unknown> | undefined) ?? {};

  // 既にrequest_idがある場合はそのまま返す
  if (existingMetadata.request_id) {
    return result;
  }

  // request_idを追加したmetadataを作成
  return {
    ...obj,
    metadata: {
      ...existingMetadata,
      request_id: requestId,
    },
  };
}

/**
 * サーバー設定
 */
export const SERVER_CONFIG = {
  name: 'reftrix-mcp-server',
  version: '0.1.0',
} as const;

/**
 * MCPツール定義
 * tools/index.ts から一元管理されたツール定義を使用
 */

/**
 * リクエストからAPIキーを取得
 *
 * 優先順位:
 * 1. リクエストの拡張フィールド（_meta?.apiKey）
 * 2. 環境変数（MCP_API_KEY）
 *
 * @param request - CallToolRequest
 * @returns APIキー（存在しない場合はundefined）
 */
export function getApiKeyFromRequest(request: CallToolRequest): string | undefined {
  // MCP SDKの拡張フィールドからAPIキーを取得する試み
  // _metaはMCP仕様の拡張フィールド
  const params = request.params as {
    _meta?: { apiKey?: string };
    [key: string]: unknown;
  };
  const meta = params._meta;

  if (meta?.apiKey && typeof meta.apiKey === 'string') {
    logger.debug('[Server] API key found in request _meta');
    return meta.apiKey;
  }

  // フォールバック: 環境変数
  const envApiKey = process.env.MCP_API_KEY;
  if (envApiKey) {
    logger.debug('[Server] API key found in environment variable');
    return envApiKey;
  }

  logger.debug('[Server] No API key found');
  return undefined;
}

/**
 * Dual Transport Server Instance
 * StdIOとHTTPを同時に管理（将来の拡張用）
 */
// interface DualTransportServer {
//   stdioServer?: Server;
//   httpServer?: import('http').Server;
// }

// let dualTransportInstance: DualTransportServer = {};

/**
 * MCPサーバーを作成
 */
export function createServer(): Server {
  logger.info(`Creating server: ${SERVER_CONFIG.name} v${SERVER_CONFIG.version}`);

  const server = new Server(
    {
      name: SERVER_CONFIG.name,
      version: SERVER_CONFIG.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ListToolsRequestハンドラー
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('Handling ListToolsRequest');

    return {
      tools: allToolDefinitions,
    };
  });

  // CallToolRequestハンドラー（認証対応・request_id統合・進捗報告対応）
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    // リクエストIDを生成（UUIDv7形式）
    const requestId = generateRequestId();

    // リクエストからAPIキーを取得
    const apiKey = getApiKeyFromRequest(request);

    // 進捗報告コンテキストを構築（MCP Phase 4）
    // クライアントが_meta.progressTokenを提供した場合のみ進捗報告が有効
    const progressContext: ProgressContext | undefined = extra.sendNotification
      ? {
          progressToken: (request.params as { _meta?: { progressToken?: string | number } })._meta?.progressToken,
          sendNotification: async (notification: ProgressNotification): Promise<void> => {
            await extra.sendNotification(notification);
          },
        }
      : undefined;

    logger.debug(`[Server] Handling CallToolRequest: ${name}`, {
      requestId,
      args,
      hasApiKey: !!apiKey,
      hasProgressToken: !!progressContext?.progressToken,
    });

    try {
      // 引数型変換: MCP経由で文字列として渡された数値・ブーリアンを自動変換
      // JSON Schemaの型定義に基づいて安全に変換する
      let coercedArgs = args || {};
      const toolDef = getToolDefinition(name);
      if (toolDef?.inputSchema) {
        coercedArgs = coerceArgs(
          coercedArgs as Record<string, unknown>,
          toolDef.inputSchema as Record<string, unknown>
        );
      }

      // 認証対応版handleToolCallを呼び出し（request_id付き・進捗報告対応）
      const result = await handleToolCall(name, coercedArgs, apiKey, requestId, progressContext);

      // レスポンスサイズ警告チェック
      responseSizeWarning.checkResponseSize(name, result);

      // ツールレスポンスが { success: false } の場合はエラーとして処理
      const isError = isToolErrorResponse(result);

      // レスポンスにrequest_idがない場合は注入
      const enrichedResult = injectRequestIdIfMissing(result, requestId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(enrichedResult, null, 2),
          },
        ],
        ...(isError && { isError: true }),
      };
    } catch (error) {
      // RESP-10: 統一エラーレスポンス形式
      // { success: false, error: { code, message }, metadata: { request_id } }
      const errorCode = error instanceof McpError
        ? error.code
        : error instanceof Error
          ? 'INTERNAL_ERROR'
          : 'UNKNOWN_ERROR';

      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error occurred';

      logger.debug(`[Server] Tool call error: ${name}`, {
        error: errorMessage,
        code: errorCode,
        requestId,
      });

      // 統一形式でエラーレスポンスを作成
      // SEC: 本番環境ではdetailsが除外される（createErrorResponseWithRequestId内で制御）
      const errorResponse = createErrorResponseWithRequestId(
        errorCode,
        errorMessage,
        requestId,
        error instanceof Error ? error.stack : undefined
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(errorResponse, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  logger.info('Server created successfully');

  return server;
}

/**
 * サーバーを起動
 */
export async function start(
  server: Server,
  transport: StdioServerTransport
): Promise<void> {
  logger.info('Starting server...');

  await server.connect(transport);

  logger.info('Server started successfully');
}

/**
 * サーバーを停止
 */
export async function close(server: Server): Promise<void> {
  logger.info('Closing server...');

  await server.close();

  logger.info('Server closed successfully');
}

export { Server };
