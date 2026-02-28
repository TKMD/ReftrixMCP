#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @reftrix/mcp-server
 * MCP Server for Reftrix - AI agent integration
 *
 * エントリポイント
 *
 * 認証ミドルウェア統合対応
 *
 * MCP-INIT-01: サービス初期化の一本化
 * - initializeAllServices() による統合初期化
 * - 起動ログの可視化（有効化されたカテゴリ表示）
 * - 配線漏れ検出（必須サービス未初期化の警告）
 */

import { createServer, start, SERVER_CONFIG } from './server';
import { createTransport } from './transport';
import { logger, validateEnvironment } from './utils/logger';
import { registerTool, setAuthMiddleware } from './router';
import { toolHandlers, checkToolConsistency } from './tools';
import { createAuthMiddleware, PUBLIC_TOOLS } from './middleware/auth';
import {
  assertProductionAuthEnabled,
  ProductionAuthRequiredError,
  isProductionEnvironment,
} from './services/production-guard';
import { embeddingService } from '@reftrix/ml';
import { prisma } from '@reftrix/database';
import { webPageService } from './services/web-page.service';
import { initializeAllServices, type ServiceInitializerConfig } from './services/service-initializer';
import { getWorkerSupervisor } from './services/worker-supervisor.service';

/**
 * メイン関数
 * MCPサーバーを起動
 */
async function main(): Promise<void> {
  // 環境変数を検証（最優先で実行）
  // NODE_ENV が未設定/空の場合はエラーをスローしてサーバー起動を中止
  const environment = validateEnvironment();
  logger.info(`Environment validated: ${environment}`);

  logger.info('Reftrix MCP Server starting...');
  logger.info(`Server: ${SERVER_CONFIG.name} v${SERVER_CONFIG.version}`);

  try {
    // =====================================================
    // サービス初期化（統合化: MCP-INIT-01）
    // =====================================================
    // 以前は個別に set*Factory() を呼び出していたが、
    // service-initializer.ts の initializeAllServices() に統合。
    // これにより配線漏れリスクを低減し、起動ログを可視化。
    const serviceConfig: ServiceInitializerConfig = {
      embeddingService,
      prisma,
      webPageService,
    };

    const initResult = initializeAllServices(serviceConfig);

    if (!initResult.success) {
      logger.error('[Main] Service initialization failed', { error: initResult.error });
      throw new Error(`Service initialization failed: ${initResult.error}`);
    }

    logger.info('[Main] Service factories registered via initializeAllServices()');

    // 本番環境では認証を強制（MCP-AUTH-01）
    // NODE_ENV=production かつ MCP_AUTH_ENABLED!==true の場合、起動を失敗させる
    // 回避オプション: MCP_ALLOW_INSECURE_PRODUCTION=true（非推奨）
    assertProductionAuthEnabled();

    // 認証ミドルウェアを設定（環境変数で制御）
    const authEnabled = process.env.MCP_AUTH_ENABLED === 'true';
    if (authEnabled) {
      const authMiddleware = createAuthMiddleware({
        enabled: true,
        publicTools: PUBLIC_TOOLS,
      });
      setAuthMiddleware(authMiddleware);
      logger.info('[Main] Authentication middleware enabled');
      logger.info(`[Main] Public tools: ${PUBLIC_TOOLS.join(', ')}`);
    } else {
      logger.info('[Main] Authentication middleware disabled (set MCP_AUTH_ENABLED=true to enable)');
    }

    // =====================================================
    // ツール定義一致チェック（MCP-SSoT-02）
    // =====================================================
    // allToolDefinitions と toolHandlers の間で不一致がないか検証
    // 手動二重管理による登録漏れを起動時に検出
    const toolCheck = checkToolConsistency();
    if (!toolCheck.isConsistent) {
      const errorMsgParts: string[] = ['Tool definition mismatch detected:'];
      if (toolCheck.missingHandlers.length > 0) {
        errorMsgParts.push(
          `Missing handlers: ${toolCheck.missingHandlers.join(', ')}`
        );
      }
      if (toolCheck.extraHandlers.length > 0) {
        errorMsgParts.push(
          `Extra handlers: ${toolCheck.extraHandlers.join(', ')}`
        );
      }
      const errorMsg = errorMsgParts.join(' ');

      if (isProductionEnvironment()) {
        logger.error(`FATAL: ${errorMsg}`);
        process.exit(1);
      } else {
        logger.warn(`[MCP-SSoT-02] ${errorMsg}`);
      }
    }
    logger.info(
      `[MCP-SSoT-02] Tool consistency check passed: ${toolCheck.definedTools.length} tools registered`
    );

    // ツールハンドラーを登録
    for (const [name, handler] of Object.entries(toolHandlers)) {
      registerTool(name, handler);
    }

    logger.info(`Registered ${Object.keys(toolHandlers).length} tools`);

    // サーバーを作成
    const server = createServer();

    // トランスポートを作成（StdIO）
    const transport = createTransport();

    // サーバーを起動（StdIO）
    await start(server, transport);

    logger.info('StdIO transport is ready to accept connections');
    logger.info('MCP Server is ready (StdIO Mode)');

    // プロセス終了シグナルのハンドリング
    const handleShutdown = async (): Promise<void> => {
      logger.info('Shutting down server...');

      try {
        // WorkerSupervisor を先にシャットダウン（3-Phase Shutdown Protocol）
        // server.close() より前に実行し、ワーカーの graceful shutdown を確保する
        try {
          const supervisor = getWorkerSupervisor();
          await supervisor.shutdown();
          logger.info('WorkerSupervisor shutdown complete');
        } catch (supervisorError: unknown) {
          // WorkerSupervisor が未初期化（page.analyze未実行）の場合はエラーではない
          logger.warn('WorkerSupervisor shutdown skipped or failed', {
            error: supervisorError instanceof Error ? supervisorError.message : String(supervisorError),
          });
        }

        // StdIO Serverを停止
        await server.close();
        logger.info('StdIO transport shutdown complete');

        logger.info('MCP Server shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);
  } catch (error) {
    // ProductionAuthRequiredErrorの場合は既にログ出力済み
    if (error instanceof ProductionAuthRequiredError) {
      process.exit(1);
    }
    logger.error('Failed to start MCP server', error);
    process.exit(1);
  }
}

// エントリポイント
main().catch((error) => {
  logger.error('Unhandled error in main', error);
  process.exit(1);
});

// 公開API
export { createServer, start } from './server';
export { createTransport } from './transport';
export { ErrorCode, McpError } from './utils/errors';
export { Logger, logger, createLogger } from './utils/logger';
export type { ILogger } from './utils/logger';
export {
  registerTool,
  handleToolCall,
  getRegisteredTools,
  setAuthMiddleware,
  clearAuthMiddleware,
  getAuthMiddleware,
  TOOL_NAMES,
  ALL_TOOL_NAMES,
} from './router';
export type { ToolHandler, ToolCallResult } from './router';
export {
  createAuthMiddleware,
  validateApiKey,
  checkPermission,
  PERMISSIONS,
  ROLES,
  TOOL_PERMISSIONS,
  PUBLIC_TOOLS,
} from './middleware/auth';
export type {
  AuthContext,
  AuthMiddlewareOptions,
  AuthResult,
  AuthMiddlewareInstance,
  Role,
} from './middleware/auth';
export {
  ServiceClient,
  serviceClient,
  API_BASE_URL,
} from './services/service-client';
export type {
  ProjectBrandSettingInfo,
  ProjectResponse,
  ProjectListParams,
  ProjectListResponse,
  ColorToken,
  PaletteResponse,
} from './services/service-client';
export {
  webPageService,
  createWebPageService,
} from './services/web-page.service';
export type {
  IWebPageService,
  WebPageResult,
} from './services/web-page.service';
export {
  assertProductionAuthEnabled,
  isMcpAuthEnabled,
  isInsecureProductionAllowed,
  isProductionEnvironment,
  ProductionAuthRequiredError,
  ProductionGuardError,
} from './services/production-guard';

// ====================================================
// Service Export Layer（外部モジュールから利用可能）
// ====================================================
export {
  // Page Analyze
  executePageAnalyze,
  type PageAnalyzeInput,
  type PageAnalyzeOutput,
  type PageAnalyzeData,
  type PageAnalyzeError,
  type LayoutResult,
  type MotionResult,
  type QualityResult,
  type PageMetadata,
  type AnalysisWarning,
  sourceTypeSchema,
  usageScopeSchema,
  waitUntilSchema,
  gradeSchema,
  type SourceType,
  type UsageScope,
  type WaitUntil,
  type Grade,
  pageAnalyzeInputSchema,
  pageAnalyzeOutputSchema,
  analysisFeaturesSchema,
  viewportSchema,
  layoutOptionsSchema,
  motionOptionsSchema,
  qualityOptionsSchema,
  type AnalysisFeatures,
  type Viewport,
  type LayoutOptions,
  type MotionOptions,
  type QualityOptions,
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeErrorCode,
  // Layout Search
  executeLayoutSearch,
  type LayoutSearchInput,
  type LayoutSearchOutput,
  type LayoutSearchData,
  type LayoutSearchErrorInfo,
  type LayoutSearchResultItem,
  type LayoutSearchFilters,
  type LayoutSearchPreview,
  type LayoutSearchSource,
  // Motion Search
  executeMotionSearch,
  type MotionSearchInput,
  type MotionSearchOutput,
  type MotionSearchParams,
  type MotionSearchResult,
  type MotionSearchData,
  type MotionSearchError,
  type MotionSearchResultItem,
  type MotionSearchFilters,
  type MotionSearchType,
  type MotionSearchTrigger,
  type MotionSearchSource,
  type MotionSearchQueryInfo,
  // Motion Detect
  executeMotionDetect,
  resetMotionDetectService,
  type MotionDetectInput,
  type MotionDetectOutput,
  type MotionDetectData,
  type MotionDetectOptions,
  type MotionDetectErrorInfo,
  type MotionPatternApi,
  type MotionWarningApi,
  type MotionPattern,
  type MotionWarning,
  type MotionDetectionResult,
  type MotionDetectionOptions,
  // Quality Evaluate
  executeQualityEvaluate,
  resetQualityEvaluateService,
  type QualityEvaluateInput,
  type QualityEvaluateOutput,
  type QualityEvaluateData,
  type QualityEvaluateErrorInfo,
  type QualityEvaluatorOptions,
  type QualityEvaluatorResult,
  // Palette
  executeGetPalette,
  type GetPaletteInput,
  type GetPaletteResult,
  type GetPaletteOptions,
  type PaletteDetail,
  type PaletteListItem,
  type ColorTokenApi,
  type GradientApi,
  // Layout Generate Code
  executeLayoutGenerateCode,
  setPrismaClientFactory,
  type LayoutToCodeInput,
  type LayoutToCodeOutput,
  type LayoutToCodeData,
  type LayoutToCodeOptions,
  type LayoutToCodeErrorInfo,
  type Framework,
} from './services';

// ====================================================
// Service Initializer Export（統合初期化API）
// ====================================================
export {
  initializeAllServices,
  initializeMotionServices,
  initializeLayoutServices,
  initializeQualityServices,
  type ServiceInitializerConfig,
  type ServiceInitializerResult,
  type IEmbeddingService,
  type IWebPageService as IWebPageServiceInitializer,
  type IPrismaClientMinimal,
} from './services/service-initializer';
