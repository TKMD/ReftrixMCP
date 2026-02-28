// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze MCPツール
 * URLを指定してlayout/motion/qualityの3分析を並列実行し、統合レスポンスを返す
 *
 * @module tools/page/analyze.tool
 */

import { v7 as uuidv7 } from 'uuid';
import { logger, isDevelopment } from '../../utils/logger';
import { validateExternalUrl, normalizeUrlForValidation } from '../../utils/url-validator';
import { normalizeUrlForStorage } from '../../utils/url-normalizer';
import { isUrlAllowedByRobotsTxt } from '@reftrix/core';
import { sanitizeHtml } from '../../utils/html-sanitizer';
import { pageIngestAdapter, type IngestResult, type ComputedStyleInfo } from '../../services/page-ingest-adapter';
import { extractCssUrls } from '../../services/external-css-fetcher';
import { assertNonProductionFactory } from '../../services/production-guard';

// Embedding統合用インポート（ハンドラーから再エクスポート）
import {
  generateSectionEmbeddings,
  generateMotionEmbeddings,
  generateSectionTextRepresentation as generateSectionTextRepresentationFromHandler,
  type SectionDataForEmbedding,
  type MotionPatternForEmbedding,
} from './handlers/embedding-handler';

// DB保存ロジック（ハンドラーから）
import {
  saveToDatabase,
  type SectionForSave,
  type MotionPatternForSave,
  type BackgroundDesignForSave,
} from './handlers/db-handler';

// Layout Handler (Phase2)
import { defaultAnalyzeLayout } from './handlers/layout-handler';

// Result Builder (Phase3)
import {
  determineErrorCode,
  buildLayoutResult,
  buildMotionResult,
  buildQualityResult,
  buildNarrativeResult,
  buildBackgroundDesignsSummary,
  extractWarning,
} from './handlers/result-builder';

// Narrative Handler (v0.1.0)
import { handleNarrativeAnalysis } from './handlers/narrative-handler';
import type { NarrativeHandlerInput, NarrativeHandlerResult } from './handlers/types';

// Motion Handler (Phase4)
import { defaultDetectMotion } from './handlers/motion-handler';

// JS Animation Handler（DB保存用 + Embedding生成）
import {
  mapJSAnimationResultToPatterns,
  saveJSAnimationPatternsWithEmbeddings,
} from './handlers/js-animation-handler';

// Quality Handler (Phase4)
import { defaultEvaluateQuality } from './handlers/quality-handler';

// Types Handler（共通型定義）
import {
  type LayoutServiceResult,
  type MotionServiceResult,
  type QualityServiceResult,
  type IPageAnalyzeService,
  type IPageAnalyzePrismaClient,
  type MotionPatternInput,
} from './handlers/types';

// VideoMode DB保存用インポート
import {
  getMotionDbService,
  type BatchSaveResult as MotionDbBatchSaveResult,
} from '../../services/motion/motion-db.service';

import {
  pageAnalyzeInputSchema,
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeInput,
  type PageAnalyzeOutput,
  type PageAnalyzeData,
  type LayoutResult,
  type MotionResult,
  type QualityResult,
  type NarrativeResult,
  type PageMetadata,
  type AnalysisWarning,
  type PageAnalyzeAsyncOutput,
} from './schemas';

// Async mode support (Phase3-2)
import { isRedisAvailable } from '../../config/redis';
import {
  createPageAnalyzeQueue,
  addPageAnalyzeJob,
  closeQueue,
  type PageAnalyzeJobOptions,
} from '../../queues/page-analyze-queue';

// WorkerSupervisor: ワーカープロセスの自動管理（OOM対策）
import { getWorkerSupervisor } from '../../services/worker-supervisor.service';

// Queue Cleanup: バッチ投入前のorphaned job自動クリーンアップ
import { cleanupQueue, createQueueAdapter } from '../../services/queue-cleanup.service';

// タイムアウトユーティリティ（Phase 5: Graceful Degradation）
import {
  withTimeout,
  PhaseTimeoutError,
  distributeTimeout,
  ExecutionStatusTracker,
  withTimeoutAndTracking,
  // Vision CPU完走保証 Phase 4: 早期ハードウェア検出とタイムアウト拡張
  calculateEffectiveTimeout,
  HardwareType,
  type HardwareInfoForTimeout,
} from './handlers/timeout-utils';

// Vision CPU完走保証 Phase 4: 早期ハードウェア検出
import { HardwareDetector } from '../../services/vision/hardware-detector';

// WebGL検出ユーティリティ（v0.1.0: タイムアウト自動延長）
import {
  detectWebGL,
  adjustTimeoutForWebGL,
  type LegacyWebGLDetectionResult,
} from './handlers/webgl-detector';

// WebGL事前推定（v0.1.0: HTML取得前のタイムアウト先制設定）
import { preDetectWebGL, detectSiteTier } from './handlers/webgl-pre-detector';

// Pre-flight Probe Service（v0.1.0: 自動タイムアウト調整）
import {
  preflightProbeService,
  type ProbeResult,
} from '@reftrix/webdesign-core';

// リトライ戦略（v0.1.0: タイムアウト累積防止）
import {
  getRetryStrategy,
  shouldRetry,
  isNetworkError,
  calculateMaxTotalTime,
} from './handlers/retry-strategy';

// =====================================================
// Embedding用テキスト表現生成関数（再エクスポート）
// =====================================================

// 型定義はハンドラーから再エクスポート
export type { SectionPatternInput } from './handlers/embedding-handler';
export type { MotionPatternInput } from './handlers/types';

/**
 * セクションからEmbedding用テキスト表現を生成
 * ハンドラーモジュールに移動済み - 後方互換性のため再エクスポート
 */
export { generateSectionTextRepresentationFromHandler as generateSectionTextRepresentation };

/**
 * モーションパターンからEmbedding用テキスト表現を生成
 *
 * E5モデル用にpassage:プレフィックスを付与
 * 768次元ベクトル生成に最適化されたテキスト形式
 *
 * @param pattern - モーションパターン情報
 * @returns Embedding用テキスト表現（passage:プレフィックス付き）
 */
export function generateMotionTextRepresentation(pattern: MotionPatternInput): string {
  const parts: string[] = [];

  // パターンタイプ
  parts.push(`Motion type: ${pattern.type}`);

  // パターン名
  if (pattern.name) {
    parts.push(`Name: ${pattern.name}`);
  }

  // カテゴリ
  parts.push(`Category: ${pattern.category}`);

  // トリガー
  parts.push(`Trigger: ${pattern.trigger}`);

  // Duration
  if (pattern.duration !== undefined) {
    parts.push(`Duration: ${pattern.duration}ms`);
  }

  // Easing
  if (pattern.easing) {
    parts.push(`Easing: ${pattern.easing}`);
  }

  // プロパティ
  if (pattern.properties && pattern.properties.length > 0) {
    parts.push(`Properties: ${pattern.properties.join(', ')}`);
  }

  return `passage: ${parts.join('. ')}.`;
}


// =====================================================
// 型定義（再エクスポート）
// =====================================================

export type { PageAnalyzeInput, PageAnalyzeOutput };
export type { IPageAnalyzeService, IPageAnalyzePrismaClient } from './handlers/types';

// =====================================================
// サービスファクトリ（DI用）
// =====================================================

let serviceFactory: (() => IPageAnalyzeService) | null = null;

export function setPageAnalyzeServiceFactory(
  factory: () => IPageAnalyzeService
): void {
  serviceFactory = factory;
}

export function resetPageAnalyzeServiceFactory(): void {
  serviceFactory = null;
}

// =====================================================
// Prismaクライアントファクトリ（DI用）
// =====================================================

let prismaClientFactory: (() => IPageAnalyzePrismaClient) | null = null;

/**
 * PrismaClientファクトリを設定
 *
 * @throws ProductionGuardError 本番環境で上書きを試みた場合
 */
export function setPageAnalyzePrismaClientFactory(
  factory: () => IPageAnalyzePrismaClient
): void {
  // 本番環境で既に設定済みの場合のみ禁止（上書き防止）
  if (prismaClientFactory !== null) {
    assertNonProductionFactory('pageAnalyzePrismaClient');
  }
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 */
export function resetPageAnalyzePrismaClientFactory(): void {
  prismaClientFactory = null;
}

/**
 * PrismaClientを取得
 */
function getPrismaClient(): IPageAnalyzePrismaClient | null {
  if (prismaClientFactory) {
    return prismaClientFactory();
  }
  return null;
}

// =====================================================
// デフォルトサービス実装（モック的な基本実装）
// =====================================================

/**
 * デフォルトのHTML取得（PageIngestAdapter実装）
 * React/Vue/Next.js等のJS駆動サイトに対応するため、DOM安定化待機を使用
 */
async function defaultFetchHtml(
  url: string,
  options: {
    timeout?: number | undefined;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | undefined;
    viewport?: { width: number; height: number } | undefined;
    includeComputedStyles?: boolean | undefined;
    skipScreenshot?: boolean | undefined;
  }
): Promise<{
  html: string;
  title?: string | undefined;
  description?: string | undefined;
  screenshot?: string | undefined;
  computedStyles?: ComputedStyleInfo[] | undefined;
}> {
  if (isDevelopment()) {
    logger.debug('[page.analyze] defaultFetchHtml called', {
      url,
      timeout: options.timeout,
      waitUntil: options.waitUntil,
      hasViewport: !!options.viewport,
    });
  }

  // PageIngestAdapterを使用（DOM安定化待機、ローディング要素待機対応）
  // exactOptionalPropertyTypes対応: undefinedの可能性がある値は条件付きで含める
  const ingestOptions: Parameters<typeof pageIngestAdapter.ingest>[0] = {
    url,
    fullPage: true,
    // React/Vue/Next.js対応: DOM安定化待機（デフォルト有効）
    waitForDomStable: true,
    domStableTimeout: 1000,  // 1秒間DOMが安定するまで待機
    // ローディングアニメーション対応: 一般的なローディング要素を待機
    waitForSelectorHidden: '.loading, .loader, .loadingElement, [data-loading], [aria-busy="true"]',
    // コンテンツ要素の可視性待機: 実際のコンテンツ（見出し、セクション）が表示されるまで待機
    waitForContentVisible: 'h1:not(.sr-only), h2:not(.sr-only), section:not(.sr-only), [data-section], article',
    // ユーザーインタラクション模倣: マウス移動でローディング解除するサイト対応
    simulateUserInteraction: true,
    // 追加の固定待機（アニメーション完了用）
    waitForTimeout: 3000,  // 3秒に増加
    // Computed Styles取得（htmlSnippetにインラインスタイル適用用）
    includeComputedStyles: options.includeComputedStyles ?? true,
    // WebGL/3Dサイト対応: 適応的待機戦略（デフォルト有効）
    // Canvas/WebGL検出、Three.js等3Dライブラリ検出、フレームレート安定化待機
    adaptiveWebGLWait: true,
  };

  // オプショナルなプロパティを条件付きで追加
  if (options.timeout !== undefined) {
    ingestOptions.timeout = options.timeout;
  }
  if (options.waitUntil !== undefined) {
    ingestOptions.waitUntil = options.waitUntil;
  }
  if (options.viewport !== undefined) {
    ingestOptions.viewport = options.viewport;
  }
  // スクリーンショットをスキップ（WebGL/3Dサイトでのタイムアウト防止）
  if (options.skipScreenshot) {
    ingestOptions.skipScreenshot = true;
  }

  // グローバルタイムアウトを計算（ユーザー指定 or デフォルト30秒）
  // 内部操作にはバッファを持たせるため、フェッチタイムアウトは指定値の1.5倍を使用
  const fetchTimeout = (options.timeout ?? 30000) * 1.5;

  if (isDevelopment()) {
    logger.debug('[page.analyze] defaultFetchHtml starting with timeout', {
      url,
      userTimeout: options.timeout,
      fetchTimeout,
    });
  }

  // グローバルタイムアウトラッパーで囲む
  // WebGLサイトでChromiumがハングした場合でもタイムアウトを強制する
  const result: IngestResult = await withTimeout(
    pageIngestAdapter.ingest(ingestOptions),
    fetchTimeout,
    `page.analyze fetchHtml for ${url}`
  );

  if (!result.success) {
    throw new Error(result.error || 'Failed to fetch page');
  }

  if (isDevelopment()) {
    logger.debug('[page.analyze] defaultFetchHtml completed', {
      url,
      htmlLength: result.html.length,
      hasTitle: !!result.metadata.title,
      hasDescription: !!result.metadata.description,
      hasScreenshot: !!result.screenshots?.length,
      hasComputedStyles: !!result.computedStyles?.length,
      computedStylesCount: result.computedStyles?.length ?? 0,
    });
  }

  // 戻り値を構築（exactOptionalPropertyTypes対応）
  const returnValue: {
    html: string;
    title?: string | undefined;
    description?: string | undefined;
    screenshot?: string | undefined;
    computedStyles?: ComputedStyleInfo[] | undefined;
  } = {
    html: result.html,
    title: result.metadata.title || undefined,
    description: result.metadata.description || undefined,
    screenshot: result.screenshots?.[0]?.data,
  };

  // computedStylesがある場合のみ含める
  if (result.computedStyles && result.computedStyles.length > 0) {
    returnValue.computedStyles = result.computedStyles;
  }

  return returnValue;
}

/**
 * HTMLからメタデータを抽出
 */
function extractMetadata(html: string, fetchedTitle?: string, fetchedDescription?: string): PageMetadata {
  const metadata: PageMetadata = {};

  // タイトル
  if (fetchedTitle) {
    metadata.title = fetchedTitle;
  } else {
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      metadata.title = titleMatch[1].trim();
    }
  }

  // description
  if (fetchedDescription) {
    metadata.description = fetchedDescription;
  } else {
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
    if (descMatch && descMatch[1]) {
      metadata.description = descMatch[1].trim();
    }
  }

  // OG image
  const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i);
  if (ogImageMatch && ogImageMatch[1]) {
    try {
      new URL(ogImageMatch[1]);
      metadata.ogImage = ogImageMatch[1];
    } catch {
      // 無効なURLは無視
    }
  }

  // Favicon
  const faviconMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i);
  if (faviconMatch && faviconMatch[1]) {
    try {
      new URL(faviconMatch[1]);
      metadata.favicon = faviconMatch[1];
    } catch {
      // 相対パスや無効なURLは無視
    }
  }

  return metadata;
}


// DB保存処理はhandlers/db-handler.tsに分離済み

// =====================================================
// メインハンドラー
// =====================================================

// Vision CPU完走保証 Phase 4: MCP進捗報告統合
import type { ProgressContext } from '../../router';

/**
 * page.analyze ツールハンドラー
 *
 * @param input - ツール入力パラメータ
 * @param progressContext - MCP進捗報告コンテキスト（Vision CPU完走保証 Phase 4）
 */
export async function pageAnalyzeHandler(
  input: unknown,
  progressContext?: ProgressContext
): Promise<PageAnalyzeOutput> {
  const overallStartTime = Date.now();

  if (isDevelopment()) {
    logger.info('[MCP Tool] page.analyze called', {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: PageAnalyzeInput;
  try {
    if (input === null || input === undefined) {
      return {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.VALIDATION_ERROR,
          message: 'Input is required',
        },
      };
    }

    validated = pageAnalyzeInputSchema.parse(input);
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] page.analyze validation error', { error });
    }
    return {
      success: false,
      error: {
        code: PAGE_ANALYZE_ERROR_CODES.VALIDATION_ERROR,
        message: error instanceof Error ? error.message : 'Invalid input',
      },
    };
  }

  // SSRF対策: URL検証
  const urlValidation = validateExternalUrl(validated.url);
  if (!urlValidation.valid) {
    if (isDevelopment()) {
      logger.warn('[MCP Tool] page.analyze SSRF blocked', {
        url: validated.url,
        error: urlValidation.error,
      });
    }
    return {
      success: false,
      error: {
        code: PAGE_ANALYZE_ERROR_CODES.SSRF_BLOCKED,
        message: urlValidation.error ?? 'URL is blocked for security reasons',
      },
    };
  }

  const normalizedUrl = urlValidation.normalizedUrl ?? normalizeUrlForValidation(validated.url);

  // robots.txt チェック（RFC 9309準拠）- 早期ブロック
  const robotsResult = await isUrlAllowedByRobotsTxt(validated.url, validated.respect_robots_txt);
  if (!robotsResult.allowed) {
    return {
      success: false,
      error: {
        code: PAGE_ANALYZE_ERROR_CODES.ROBOTS_TXT_BLOCKED,
        message: `Blocked by robots.txt: ${validated.url} (domain: ${robotsResult.domain}, reason: ${robotsResult.reason}). ` +
          `Use respect_robots_txt: false to override. ` +
          `Note: Overriding robots.txt may have legal implications depending on jurisdiction (e.g., EU DSM Directive Article 4).`,
      },
    };
  }

  // =====================================================
  // Smart Defaults: Vision有効時の自動非同期モード（v0.1.0）
  // =====================================================
  // Vision LLM (llama3.2-vision) はCPUモードで2-5分以上かかるため、
  // MCPの600秒ハードタイムアウトを回避するために自動的にasyncモードを有効化
  const useVisionEnabled = validated.layoutOptions?.useVision !== false; // デフォルトtrue
  const useNarrativeVisionEnabled = validated.narrativeOptions?.includeVision === true;
  const visionRequested = useVisionEnabled || useNarrativeVisionEnabled;

  // async が明示的に指定されていない場合のみ自動設定
  // (ユーザーが async: false を明示指定した場合は尊重)
  let autoAsyncEnabled = false;
  if (visionRequested && validated.async === undefined) {
    const redisCheck = await isRedisAvailable();
    if (redisCheck) {
      // Vision有効 + Redis利用可能 → 自動でasyncモードを有効化
      validated = { ...validated, async: true };
      autoAsyncEnabled = true;
      if (isDevelopment()) {
        logger.info('[page.analyze] Auto-async enabled for Vision analysis', {
          url: validated.url,
          useVision: useVisionEnabled,
          useNarrativeVision: useNarrativeVisionEnabled,
        });
      }
    } else if (isDevelopment()) {
      logger.warn('[page.analyze] Vision requested but Redis unavailable, sync mode will be used', {
        url: validated.url,
      });
    }
  }

  // =====================================================
  // 非同期モード処理（Phase3-2）
  // =====================================================
  // async=true の場合、ジョブをキューに投入して即座に返す
  if (validated.async === true) {
    if (isDevelopment()) {
      logger.info('[page.analyze] Async mode requested', { url: validated.url });
    }

    // Redis可用性チェック
    const redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
      if (isDevelopment()) {
        logger.warn('[page.analyze] Redis unavailable for async mode');
      }
      return {
        success: false,
        error: {
          code: 'REDIS_UNAVAILABLE',
          message: 'Async mode requires Redis. Please start Redis or use sync mode (async=false).',
        },
      };
    }

    // ワーカープロセスが起動していなければ起動する
    getWorkerSupervisor().ensureWorkerRunning();

    // ジョブIDとしてwebPageIdを事前生成
    const webPageId = uuidv7();

    // キューにジョブを追加
    const queue = createPageAnalyzeQueue();

    // バッチ投入前: orphaned/failed/stalledジョブを自動クリーンアップ
    const cleanupResult = await cleanupQueue(createQueueAdapter(queue));
    if (cleanupResult.strategy !== 'skipped' && isDevelopment()) {
      logger.info('[page.analyze] Queue cleanup before job submission', {
        strategy: cleanupResult.strategy,
        totalCleaned: cleanupResult.totalCleaned,
      });
    }

    try {
      // ジョブオプションを構築（exactOptionalPropertyTypes対応）
      const jobOptions: PageAnalyzeJobOptions = {
        timeout: validated.timeout,
        features: {
          layout: validated.features?.layout,
          motion: validated.features?.motion,
          quality: validated.features?.quality,
        },
      };

      // layoutOptions（undefinedを明示的に除外）
      if (validated.layoutOptions) {
        const layoutOpts: NonNullable<PageAnalyzeJobOptions['layoutOptions']> = {
          useVision: validated.layoutOptions.useVision ?? true,
          saveToDb: validated.layoutOptions.saveToDb ?? true,
          autoAnalyze: validated.layoutOptions.autoAnalyze ?? true,
          fullPage: validated.layoutOptions.fullPage ?? true,
          scrollVision: validated.layoutOptions.scrollVision ?? true,
          scrollVisionMaxCaptures: validated.layoutOptions.scrollVisionMaxCaptures ?? 10,
        };
        if (validated.layoutOptions.viewport) {
          layoutOpts.viewport = validated.layoutOptions.viewport;
        }
        jobOptions.layoutOptions = layoutOpts;
      }

      // motionOptions
      if (validated.motionOptions) {
        jobOptions.motionOptions = {
          detectJsAnimations: validated.motionOptions.detect_js_animations ?? true,
          detectWebglAnimations: validated.motionOptions.detect_webgl_animations ?? true,
          enableFrameCapture: validated.motionOptions.enable_frame_capture ?? true,
          saveToDb: validated.motionOptions.saveToDb ?? true,
          maxPatterns: validated.motionOptions.maxPatterns ?? 500,
          // v0.1.0: Motion検出タイムアウト（asyncモードでは長時間検出可能）
          timeout: validated.motionOptions.timeout ?? 300000,
        };
      }

      // qualityOptions（undefinedを明示的に除外）
      if (validated.qualityOptions) {
        const qualityOpts: NonNullable<PageAnalyzeJobOptions['qualityOptions']> = {
          strict: validated.qualityOptions.strict ?? true,
        };
        if (validated.qualityOptions.weights) {
          qualityOpts.weights = {
            originality: validated.qualityOptions.weights.originality ?? 0.35,
            craftsmanship: validated.qualityOptions.weights.craftsmanship ?? 0.4,
            contextuality: validated.qualityOptions.weights.contextuality ?? 0.25,
          };
        }
        if (validated.qualityOptions.targetIndustry) {
          qualityOpts.targetIndustry = validated.qualityOptions.targetIndustry;
        }
        if (validated.qualityOptions.targetAudience) {
          qualityOpts.targetAudience = validated.qualityOptions.targetAudience;
        }
        jobOptions.qualityOptions = qualityOpts;
      }

      // narrativeOptions（デフォルト有効）
      if (validated.narrativeOptions) {
        jobOptions.narrativeOptions = {
          enabled: validated.narrativeOptions.enabled ?? true,
          saveToDb: validated.narrativeOptions.saveToDb ?? true,
          includeVision: validated.narrativeOptions.includeVision ?? true,
          visionTimeoutMs: validated.narrativeOptions.visionTimeoutMs ?? 300000,
          generateEmbedding: validated.narrativeOptions.generateEmbedding ?? true,
        };
      }

      const job = await addPageAnalyzeJob(queue, {
        webPageId,
        url: validated.url,
        options: jobOptions,
      });

      if (isDevelopment()) {
        logger.info('[page.analyze] Job queued successfully', {
          jobId: job.id,
          webPageId,
          url: validated.url,
        });
      }

      // 非同期レスポンスを返す
      const autoAsyncNote = autoAsyncEnabled
        ? ' (Auto-enabled: Vision analysis requires async mode to avoid MCP timeout)'
        : '';
      const asyncResponse: PageAnalyzeAsyncOutput = {
        async: true,
        jobId: webPageId,
        status: 'queued',
        message: `Job queued successfully.${autoAsyncNote} Use page.getJobStatus(jobId="${webPageId}") to check progress.`,
        polling: {
          intervalSeconds: 10, // Vision処理は長時間かかるため10秒間隔を推奨
          retentionHours: 24,
          howToCheck: `Call page.getJobStatus with jobId="${webPageId}" to check job status and retrieve results.`,
        },
      };

      return asyncResponse as unknown as PageAnalyzeOutput;
    } finally {
      await closeQueue(queue);
    }
  }

  // =====================================================
  // MCP 570秒ハードタイムアウトガード（v0.1.0）
  // =====================================================
  // MCP プロトコルの600秒タイムアウトを超えないよう、570秒（30秒安全マージン）で
  // sync mode全体をハードタイムアウトで保護する。
  // CPU Vision延長やフェーズ個別タイムアウトが膨らんでも、このガードで確実に打ち切る。
  // fetchExternalCss: true で多数の外部リソースを取得する際のハング防止が主目的。
  const OVERALL_HARD_TIMEOUT_MS = 570000; // 570秒 = MCP 600秒 - 30秒安全マージン

  // タイマーIDを保持してクリーンアップ可能にする
  let hardTimeoutId: ReturnType<typeof setTimeout> | undefined;

  const syncProcessingResult = await Promise.race([
    executeSyncProcessing(validated, normalizedUrl, overallStartTime, progressContext),
    new Promise<PageAnalyzeOutput>((_, reject) => {
      hardTimeoutId = setTimeout(() => {
        reject(new PhaseTimeoutError('page.analyze-overall', OVERALL_HARD_TIMEOUT_MS));
      }, OVERALL_HARD_TIMEOUT_MS);
    }),
  ]).catch((error): PageAnalyzeOutput => {
    const isTimeout = error instanceof PhaseTimeoutError;
    const elapsedMs = Date.now() - overallStartTime;

    if (isDevelopment()) {
      logger.error('[page.analyze] Overall hard timeout triggered', {
        timeoutMs: OVERALL_HARD_TIMEOUT_MS,
        elapsedMs,
        isTimeout,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      success: false,
      error: {
        code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
        message: `page.analyze exceeded MCP hard timeout limit (${Math.round(elapsedMs / 1000)}s / ${OVERALL_HARD_TIMEOUT_MS / 1000}s). Consider using fetchExternalCss: false or reducing analysis scope.`,
      },
    };
  }).finally(() => {
    // Promise.race で executeSyncProcessing が先に完了した場合、タイマーをクリーンアップ
    if (hardTimeoutId) {
      clearTimeout(hardTimeoutId);
    }
  });

  return syncProcessingResult;
}

/**
 * page.analyze 同期処理の本体
 *
 * pageAnalyzeHandler から分離され、570秒ハードタイムアウトガードで保護される。
 * 入力バリデーション・SSRF・async mode 判定は呼び出し元で完了済み。
 *
 * @param validated - バリデーション済みの入力
 * @param normalizedUrl - SSRF検証済みの正規化URL
 * @param overallStartTime - 処理開始時刻（ms）
 * @param progressContext - MCP進捗報告コンテキスト
 */
async function executeSyncProcessing(
  validated: PageAnalyzeInput,
  normalizedUrl: string,
  overallStartTime: number,
  progressContext?: ProgressContext
): Promise<PageAnalyzeOutput> {
  // サービス取得
  const service = serviceFactory?.() ?? {};
  const fetchHtml = service.fetchHtml ?? defaultFetchHtml;
  const analyzeLayout = service.analyzeLayout ?? defaultAnalyzeLayout;
  const detectMotion = service.detectMotion ?? defaultDetectMotion;
  const evaluateQuality = service.evaluateQuality ?? defaultEvaluateQuality;

  // HTML取得結果（リトライループで設定される）
  // attemptSucceeded=true の場合のみ有効な値が入る
  let html = ''; // TypeScript definite assignment のため初期化
  let fetchedTitle: string | undefined;
  let fetchedDescription: string | undefined;
  let fetchedScreenshot: string | undefined;
  let fetchedComputedStyles: ComputedStyleInfo[] | undefined;

  // =====================================================
  // 事前WebGL推定とタイムアウト先制設定（v0.1.0）
  // =====================================================
  // HTML取得前にURLパターンからWebGLサイトかを推定し、
  // タイムアウトを先制的に延長することで、WebGLサイトでの
  // HTML取得タイムアウトを防止する

  const preDetection = preDetectWebGL(validated.url);
  const preAdjustedTimeout = preDetection.isLikelyWebGL
    ? Math.min(
        (validated.timeout ?? 120000) * preDetection.timeoutMultiplier,
        600000 // 最大10分
      )
    : validated.timeout ?? 120000;

  if (isDevelopment() && preDetection.isLikelyWebGL) {
    logger.info('[page.analyze] WebGL pre-detection triggered', {
      url: validated.url,
      confidence: preDetection.confidence,
      matchedDomain: preDetection.matchedDomain,
      matchedPattern: preDetection.matchedPattern,
      originalTimeout: validated.timeout,
      preAdjustedTimeout,
      timeoutMultiplier: preDetection.timeoutMultiplier,
    });
  }

  // =====================================================
  // Pre-flight Probe による自動タイムアウト調整（v0.1.0）
  // =====================================================
  // auto_timeout=true の場合、URLの複雑度を事前分析して最適なタイムアウトを計算
  // WebGL、SPA、重いフレームワークを検出し、タイムアウトを動的に調整

  let probeResult: ProbeResult | null = null;
  let probeCalculatedTimeout = preAdjustedTimeout;

  if (validated.auto_timeout === true) {
    try {
      if (isDevelopment()) {
        logger.info('[page.analyze] Pre-flight probe started', { url: validated.url });
      }

      probeResult = await preflightProbeService.probe(validated.url);

      // プローブ結果からタイムアウトを決定
      // ユーザー指定がある場合はそれを上限として使用
      const userTimeout = validated.timeout ?? 120000;
      probeCalculatedTimeout = Math.min(
        Math.max(probeResult.calculatedTimeoutMs, 30000), // 最低30秒
        Math.max(userTimeout, 600000) // ユーザー指定または最大10分のどちらか大きい方
      );

      if (isDevelopment()) {
        logger.info('[page.analyze] Pre-flight probe completed', {
          url: validated.url,
          calculatedTimeoutMs: probeResult.calculatedTimeoutMs,
          complexityScore: probeResult.complexityScore,
          hasWebGL: probeResult.hasWebGL,
          hasSPA: probeResult.hasSPA,
          hasHeavyFramework: probeResult.hasHeavyFramework,
          probeCalculatedTimeout,
          userTimeout,
          responseTimeMs: probeResult.responseTimeMs,
        });
      }
    } catch (probeError) {
      // プローブ失敗時はフォールバック（preAdjustedTimeoutを使用）
      if (isDevelopment()) {
        logger.warn('[page.analyze] Pre-flight probe failed, using fallback timeout', {
          url: validated.url,
          error: probeError instanceof Error ? probeError.message : String(probeError),
          fallbackTimeout: preAdjustedTimeout,
        });
      }
      // probeResultはnullのまま、probeCalculatedTimeoutはpreAdjustedTimeoutのまま
    }
  }

  // auto_timeout=falseまたはプローブ失敗時はpreAdjustedTimeoutを使用
  const finalBaseTimeout = validated.auto_timeout === true && probeResult
    ? probeCalculatedTimeout
    : preAdjustedTimeout;

  // =====================================================
  // HTML取得（自動リトライ対応 v0.1.0）
  // =====================================================
  // サイト種別（SiteTier）に基づくリトライ戦略を適用
  // - ultra-heavy/heavy: タイムアウト累積なし、ネットワークエラーのみリトライ
  // - webgl: 軽い累積（1.2倍）、全エラーでリトライ
  // - normal: 従来動作（1.5倍累積）

  const viewport = validated.layoutOptions?.viewport;
  // useVision=true の場合はスクリーンショットが必要（visualFeatures抽出のため）
  // Phase 4-2: Decision 019bd65f-29c5-795e-9c81-cea829b3d9fe
  const useVision = validated.layoutOptions?.useVision === true;
  // narrativeOptions.includeVision=true の場合もスクリーンショットが必要（世界観分析用）
  const useNarrativeVision = validated.narrativeOptions?.includeVision === true;
  const skipScreenshot = (useVision || useNarrativeVision)
    ? false // useVision または narrativeOptions.includeVision 時は常にスクリーンショット取得
    : validated.layoutOptions?.includeScreenshot !== true;

  // サイト種別を検出してリトライ戦略を取得
  const siteTier = detectSiteTier(validated.url, preDetection);
  const retryStrategy = getRetryStrategy(siteTier);

  // ユーザー指定がある場合はそちらを優先
  const effectiveRetryStrategy = {
    ...retryStrategy,
    autoRetry: validated.auto_retry ?? retryStrategy.autoRetry,
    maxRetries: validated.max_retries ?? retryStrategy.maxRetries,
  };

  // MCP 600秒上限チェック（警告ログ）
  const maxTotalTime = calculateMaxTotalTime(finalBaseTimeout, effectiveRetryStrategy);
  if (isDevelopment() && maxTotalTime > 600000) {
    logger.warn('[page.analyze] Max total time may exceed MCP 600s limit', {
      siteTier,
      baseTimeout: finalBaseTimeout,
      maxTotalTime,
      maxRetries: effectiveRetryStrategy.maxRetries,
      timeoutMultiplier: effectiveRetryStrategy.timeoutMultiplier,
      autoTimeout: validated.auto_timeout,
      probeUsed: probeResult !== null,
    });
  }

  /**
   * リトライ設定を取得
   * @param attempt 試行回数（0-indexed）
   */
  const getRetryConfig = (attempt: number): {
    timeout: number;
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | undefined;
  } => {
    // 1回目: 元の設定（auto_timeout時はprobeで計算されたタイムアウト）
    if (attempt === 0) {
      return {
        timeout: finalBaseTimeout,
        waitUntil: validated.waitUntil !== 'load' ? validated.waitUntil : undefined,
      };
    }

    // リトライ時: 乗数を累積適用（MCP 600秒上限を考慮）
    // timeoutMultiplier=1.0の場合は累積なし
    const multiplier = Math.pow(effectiveRetryStrategy.timeoutMultiplier, attempt);
    const newTimeout = Math.min(
      Math.round(finalBaseTimeout * multiplier),
      600000 // MCP 600秒上限
    );

    return {
      timeout: newTimeout,
      waitUntil: 'domcontentloaded' as const,
    };
  };

  let lastError: Error | null = null;
  const attemptCount = effectiveRetryStrategy.autoRetry ? effectiveRetryStrategy.maxRetries + 1 : 1;
  let attemptSucceeded = false;

  if (isDevelopment()) {
    logger.info('[page.analyze] Retry strategy determined', {
      url: validated.url,
      siteTier,
      autoRetry: effectiveRetryStrategy.autoRetry,
      maxRetries: effectiveRetryStrategy.maxRetries,
      timeoutMultiplier: effectiveRetryStrategy.timeoutMultiplier,
      retryOnlyOnNetworkError: effectiveRetryStrategy.retryOnlyOnNetworkError,
      baseTimeout: finalBaseTimeout,
      maxTotalTime,
      autoTimeout: validated.auto_timeout,
      probeUsed: probeResult !== null,
    });
  }

  for (let attempt = 0; attempt < attemptCount; attempt++) {
    const retryConfig = getRetryConfig(attempt);

    if (isDevelopment() && attempt > 0) {
      logger.info('[page.analyze] Retrying HTML fetch', {
        attempt: attempt + 1,
        maxAttempts: attemptCount,
        timeout: retryConfig.timeout,
        waitUntil: retryConfig.waitUntil ?? 'load',
        previousError: lastError?.message,
        isNetworkError: lastError ? isNetworkError(lastError) : false,
      });
    }

    try {
      const fetchResult = await fetchHtml(validated.url, {
        timeout: retryConfig.timeout,
        ...(retryConfig.waitUntil && { waitUntil: retryConfig.waitUntil }),
        ...(viewport && { viewport }),
        includeComputedStyles: true,
        skipScreenshot,
      });

      html = fetchResult.html;
      fetchedTitle = fetchResult.title;
      fetchedDescription = fetchResult.description;
      fetchedScreenshot = fetchResult.screenshot;
      fetchedComputedStyles = fetchResult.computedStyles;
      attemptSucceeded = true;

      if (isDevelopment() && attempt > 0) {
        logger.info('[page.analyze] Retry succeeded', {
          attempt: attempt + 1,
          timeout: retryConfig.timeout,
          waitUntil: retryConfig.waitUntil ?? 'load',
        });
      }

      break; // 成功したらループを抜ける
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isDevelopment()) {
        logger.warn('[page.analyze] Fetch attempt failed', {
          attempt: attempt + 1,
          maxAttempts: attemptCount,
          error: lastError.message,
          url: validated.url,
          isNetworkError: isNetworkError(lastError),
        });
      }

      // shouldRetry で次の試行を判定
      if (shouldRetry(lastError, attempt, effectiveRetryStrategy)) {
        // 待機時間を挟む
        await new Promise(resolve => setTimeout(resolve, effectiveRetryStrategy.waitBetweenRetriesMs));
        continue;
      }

      // リトライしない場合はループを抜ける
      break;
    }
  }

  // 全試行失敗
  if (!attemptSucceeded) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] page.analyze fetch error (all retries failed)', {
        error: lastError,
        url: validated.url,
        attempts: attemptCount,
      });
    }

    const errorMessage = lastError?.message ?? 'Failed to fetch page';

    return {
      success: false,
      error: {
        code: determineErrorCode(errorMessage),
        message: `${errorMessage} (after ${attemptCount} attempt${attemptCount > 1 ? 's' : ''})`,
      },
    };
  }

  // 外部CSS URLを抽出（サニタイズ前のHTMLから）
  // DOMPurifyで<link>タグが除去される問題の回避策
  const preExtractedCssUrls = extractCssUrls(html, normalizedUrl).map(u => u.url);

  if (isDevelopment()) {
    logger.debug('[page.analyze] Pre-extracted external CSS URLs', {
      count: preExtractedCssUrls.length,
      urls: preExtractedCssUrls.slice(0, 5), // 最初の5件のみログ
    });
  }

  // HTMLサニタイズ（XSS対策）
  // preserveDocumentStructure: true でドキュメント構造を保持
  // - <html lang>: aXe html-has-lang ルール（WCAG 2.1 AA）
  // - <title>: aXe document-title ルール
  // - 安全な<meta>: description, viewport, charset
  const sanitizedHtml = sanitizeHtml(html, { preserveDocumentStructure: true });

  // メタデータ抽出（サニタイズ前のHTMLからメタデータを取得）
  const metadata = extractMetadata(html, fetchedTitle, fetchedDescription);

  // =====================================================
  // WebGL検出とタイムアウト調整（v0.1.0）
  // =====================================================

  // WebGL/3Dコンテンツを早期検出
  const webglResult: LegacyWebGLDetectionResult = detectWebGL(html);

  // 元のタイムアウト値
  const originalTimeout = validated.timeout ?? 60000;

  // WebGL検出に基づいてタイムアウトを調整
  const timeoutAdjustment = adjustTimeoutForWebGL(originalTimeout, webglResult);
  const effectiveTimeout = timeoutAdjustment.effectiveTimeout;

  if (isDevelopment() && webglResult.detected) {
    logger.info('[page.analyze] WebGL content detected', {
      libraries: webglResult.libraries,
      confidence: webglResult.confidence,
      originalTimeout,
      effectiveTimeout,
      timeoutExtended: timeoutAdjustment.extended,
    });
  }

  // =====================================================
  // Vision CPU完走保証 Phase 4: 早期ハードウェア検出とタイムアウト拡張
  // CPU環境でVision分析を使用する場合、全体タイムアウトを自動延長
  // useVisionは既に736行目で定義済み
  // =====================================================
  let cpuTimeoutExtended = false;
  let cpuEffectiveTimeout = effectiveTimeout;
  let hardwareInfoForTimeout: HardwareInfoForTimeout | undefined;
  let detectedHardwareType: HardwareType = HardwareType.GPU; // デフォルトはGPU（高速）

  if (useVision) {
    try {
      const hardwareDetector = new HardwareDetector();
      const hardwareInfo = await hardwareDetector.detect();
      detectedHardwareType = hardwareInfo.type;

      if (isDevelopment()) {
        logger.info('[page.analyze] Early hardware detection for Vision CPU timeout', {
          hardwareType: hardwareInfo.type,
          vramBytes: hardwareInfo.vramBytes,
          isGpuAvailable: hardwareInfo.isGpuAvailable,
          useVision,
        });
      }

      // CPU環境かつVision有効時はタイムアウト拡張を計算
      const screenshotSizeBytes = fetchedScreenshot
        ? Buffer.from(fetchedScreenshot, 'base64').length
        : undefined;

      // HardwareInfoForTimeout: imageSizeBytesはオプショナル
      hardwareInfoForTimeout = screenshotSizeBytes !== undefined
        ? {
            type: hardwareInfo.type,
            isVisionEnabled: true,
            imageSizeBytes: screenshotSizeBytes,
          }
        : {
            type: hardwareInfo.type,
            isVisionEnabled: true,
          };

      // CalculateEffectiveTimeoutOptions: imageSizeBytesはオプショナル
      const cpuTimeoutResult = screenshotSizeBytes !== undefined
        ? calculateEffectiveTimeout({
            originalTimeout: effectiveTimeout, // WebGL調整後のタイムアウトをベースに
            hardwareType: hardwareInfo.type,
            isVisionEnabled: true,
            imageSizeBytes: screenshotSizeBytes,
          })
        : calculateEffectiveTimeout({
            originalTimeout: effectiveTimeout,
            hardwareType: hardwareInfo.type,
            isVisionEnabled: true,
          });

      if (cpuTimeoutResult.extended) {
        cpuTimeoutExtended = true;
        cpuEffectiveTimeout = cpuTimeoutResult.effectiveTimeout;

        if (isDevelopment()) {
          logger.info('[page.analyze] CPU Vision timeout extended', {
            originalTimeout: effectiveTimeout,
            extendedTimeout: cpuEffectiveTimeout,
            reason: cpuTimeoutResult.reason,
            imageSizeBytes: screenshotSizeBytes,
          });
        }
      }
    } catch (hwError) {
      // ハードウェア検出失敗時はCPUと仮定（安全側）
      detectedHardwareType = HardwareType.CPU;

      if (isDevelopment()) {
        logger.warn('[page.analyze] Early hardware detection failed, assuming CPU', {
          error: hwError instanceof Error ? hwError.message : 'Unknown error',
        });
      }

      // CPU仮定でタイムアウト拡張
      hardwareInfoForTimeout = {
        type: HardwareType.CPU,
        isVisionEnabled: true,
      };

      const cpuTimeoutResult = calculateEffectiveTimeout({
        originalTimeout: effectiveTimeout,
        hardwareType: HardwareType.CPU,
        isVisionEnabled: true,
      });

      if (cpuTimeoutResult.extended) {
        cpuTimeoutExtended = true;
        cpuEffectiveTimeout = cpuTimeoutResult.effectiveTimeout;
      }
    }
  }

  // Vision CPU完走保証を考慮した最終的な有効タイムアウト
  // MCP 600秒ハードリミット対策: フェーズタイムアウト配分の元になる値を570秒に制限
  // これにより distributeTimeout() が各フェーズに過大なタイムアウトを割り当てることを防止
  // CPU Vision延長で600秒以上に膨らんでも、フェーズ配分は570秒ベースで計算される
  const MCP_HARD_LIMIT_MS = 570000; // MCP 600秒 - 30秒安全マージン
  const rawFinalEffectiveTimeout = cpuTimeoutExtended ? cpuEffectiveTimeout : effectiveTimeout;
  const finalEffectiveTimeout = Math.min(rawFinalEffectiveTimeout, MCP_HARD_LIMIT_MS);

  if (isDevelopment() && rawFinalEffectiveTimeout > MCP_HARD_LIMIT_MS) {
    logger.info('[page.analyze] finalEffectiveTimeout capped to MCP hard limit', {
      rawFinalEffectiveTimeout,
      cappedTo: MCP_HARD_LIMIT_MS,
      cpuTimeoutExtended,
    });
  }

  // =====================================================
  // ExecutionStatusTracker初期化（v0.1.0）
  // Vision CPU完走保証 Phase 4: cpuModeExtended, hardwareInfoを追加
  // =====================================================

  const timeoutStrategy = validated.timeout_strategy ?? 'progressive';
  const partialResultsEnabled = validated.partial_results ?? true;

  // Vision CPU完走保証 Phase 4: hardwareInfoを条件付きで設定
  const executionTracker = hardwareInfoForTimeout
    ? new ExecutionStatusTracker({
        originalTimeoutMs: originalTimeout,
        effectiveTimeoutMs: finalEffectiveTimeout,
        strategy: timeoutStrategy,
        partialResultsEnabled,
        webglDetected: webglResult.detected,
        timeoutExtended: timeoutAdjustment.extended || cpuTimeoutExtended,
        cpuModeExtended: cpuTimeoutExtended,
        hardwareInfo: {
          type: detectedHardwareType,
          vramBytes: 0, // 詳細情報はlayout-handler内で取得
          isGpuAvailable: detectedHardwareType === HardwareType.GPU,
        },
      })
    : new ExecutionStatusTracker({
        originalTimeoutMs: originalTimeout,
        effectiveTimeoutMs: finalEffectiveTimeout,
        strategy: timeoutStrategy,
        partialResultsEnabled,
        webglDetected: webglResult.detected,
        timeoutExtended: timeoutAdjustment.extended || cpuTimeoutExtended,
        cpuModeExtended: cpuTimeoutExtended,
      });

  // HTML取得成功を記録
  executionTracker.markCompleted('html');

  // スクリーンショット取得成功を記録（取得できた場合）
  if (fetchedScreenshot) {
    executionTracker.markCompleted('screenshot');
  }

  // 並列分析処理
  const features = validated.features ?? { layout: true, motion: true, quality: true };
  const warnings: AnalysisWarning[] = [];

  // タイムアウト配分を計算（調整後のタイムアウトを使用）
  // 注意: enable_frame_capture はデフォルトで false
  // detect_js_animations / detect_webgl_animations はデフォルトで true (v0.1.0)
  // タイムアウト分配もこのデフォルト値を反映する必要がある
  const hasFrameCapture = validated.motionOptions?.enable_frame_capture === true; // デフォルト false
  const hasJsAnimation = validated.motionOptions?.detect_js_animations !== false;  // デフォルト true (v0.1.0)

  // WebGL乗数を計算（adjustTimeoutForWebGLと同じロジック）
  // v0.1.0: JSアニメーション検出有効時にモーション検出タイムアウトも延長
  const webglMultiplier = webglResult.detected
    ? (webglResult.confidence >= 0.9 ? 2.5 : webglResult.confidence >= 0.7 ? 2.0 : 1.5)
    : 1.0;

  // 事前推定（preDetection）とHTML解析（webglResult）の両方を考慮して最大乗数を使用
  const effectiveWebglMultiplier = preDetection.isLikelyWebGL
    ? Math.max(webglMultiplier, preDetection.timeoutMultiplier)
    : webglMultiplier;

  // Vision CPU完走保証 Phase 4: finalEffectiveTimeoutとhardwareInfoForTimeoutを使用
  const phaseTimeouts = distributeTimeout(
    finalEffectiveTimeout, // WebGL + CPU Vision拡張後のタイムアウト
    hasFrameCapture,
    hasJsAnimation,
    {
      detected: webglResult.detected || preDetection.isLikelyWebGL,
      multiplier: effectiveWebglMultiplier,
    },
    hardwareInfoForTimeout // Vision CPU完走保証 Phase 4: ハードウェア情報を渡す
  );

  // =====================================================
  // Per-Phase Timeout Override (v0.1.0)
  // ユーザー指定の個別タイムアウトで計算値をオーバーライド
  // =====================================================
  if (validated.layoutTimeout !== undefined) {
    phaseTimeouts.layoutAnalysis = validated.layoutTimeout;
  }
  if (validated.motionTimeout !== undefined) {
    phaseTimeouts.motionDetection = validated.motionTimeout;
  }
  if (validated.qualityTimeout !== undefined) {
    phaseTimeouts.qualityEvaluation = validated.qualityTimeout;
  }

  // ExecutionStatusTrackerにフェーズタイムアウト設定を反映（v0.1.0）
  executionTracker.setPhaseTimeouts({
    layout: phaseTimeouts.layoutAnalysis,
    motion: phaseTimeouts.motionDetection,
    quality: phaseTimeouts.qualityEvaluation,
  });

  if (isDevelopment()) {
    logger.debug('[page.analyze] Phase timeouts calculated', {
      originalTimeout,
      effectiveTimeout,
      finalEffectiveTimeout, // Vision CPU完走保証 Phase 4
      hasFrameCapture,
      hasJsAnimation,
      phaseTimeouts,
      timeoutStrategy,
      partialResultsEnabled,
      userOverrides: {
        layoutTimeout: validated.layoutTimeout,
        motionTimeout: validated.motionTimeout,
        qualityTimeout: validated.qualityTimeout,
      },
      // Vision CPU完走保証 Phase 4
      cpuVisionExtension: {
        useVision,
        cpuTimeoutExtended,
        hardwareType: detectedHardwareType,
      },
    });
  }

  // 並列分析用の結果格納変数
  let layoutServiceResult: LayoutServiceResult | null = null;
  let motionServiceResult: MotionServiceResult | null = null;
  let qualityServiceResult: QualityServiceResult | null = null;

  // =====================================================
  // layout_first モード判定（v0.1.0）
  // WebGLサイトでレイアウト抽出を最優先し、モーション検出を軽量化
  // =====================================================
  const layoutFirstMode = validated.layout_first ?? 'auto';
  const useLayoutFirst = layoutFirstMode === 'always' ||
    (layoutFirstMode === 'auto' && (webglResult.detected || preDetection.isLikelyWebGL));

  if (isDevelopment() && useLayoutFirst) {
    logger.info('[page.analyze] layout_first mode activated', {
      layoutFirstMode,
      webglDetected: webglResult.detected,
      preDetectionLikelyWebGL: preDetection.isLikelyWebGL,
      webglLibraries: webglResult.libraries,
    });
  }

  // =====================================================
  // layout_first モード時のタイムアウト再分配（v0.1.0）
  // モーション検出が軽量化されるため、その分をレイアウト分析に回す
  // =====================================================
  let effectivePhaseTimeouts = phaseTimeouts;
  if (useLayoutFirst) {
    // layout_first モードでは:
    // - モーション検出: ライブラリ検出 + CSS静的解析（45秒必要）
    // - レイアウト分析: 余った時間を追加
    // v0.1.0: 15秒→45秒に増加（CSS解析に時間がかかるWebGLサイト対応）
    const LAYOUT_FIRST_MOTION_TIMEOUT = 45000; // 45秒（CSS解析 + ライブラリ検出）
    const savedTime = phaseTimeouts.motionDetection - LAYOUT_FIRST_MOTION_TIMEOUT;
    const bonusLayoutTime = Math.max(0, savedTime);

    effectivePhaseTimeouts = {
      ...phaseTimeouts,
      motionDetection: LAYOUT_FIRST_MOTION_TIMEOUT,
      layoutAnalysis: phaseTimeouts.layoutAnalysis + bonusLayoutTime,
    };

    if (isDevelopment()) {
      logger.info('[page.analyze] layout_first: timeout reallocation', {
        originalMotionTimeout: phaseTimeouts.motionDetection,
        newMotionTimeout: LAYOUT_FIRST_MOTION_TIMEOUT,
        originalLayoutTimeout: phaseTimeouts.layoutAnalysis,
        newLayoutTimeout: effectivePhaseTimeouts.layoutAnalysis,
        savedTime,
      });
    }
  }

  // 並列分析Promiseを構築
  const analysisPromises: Promise<void>[] = [];

  if (features.layout !== false) {
    // Vision解析用スクリーンショートを準備（useVision=true時のみ必要）
    const screenshotForVision = fetchedScreenshot
      ? { base64: fetchedScreenshot, mimeType: 'image/png' }
      : undefined;

    // Computed StylesをhtmlSnippetにインラインスタイルとして適用するために渡す
    // preExtractedCssUrlsはサニタイズ前のHTMLから抽出した外部CSS URL
    // Vision CPU完走保証 Phase 3: visionOptionsを渡す
    // Vision CPU完走保証 Phase 4: progressContextを渡す
    const layoutPromise = analyzeLayout(
      sanitizedHtml,
      validated.layoutOptions,
      screenshotForVision,
      fetchedComputedStyles,
      normalizedUrl,
      preExtractedCssUrls,
      validated.visionOptions,
      progressContext
    );

    // withTimeoutAndTracking で Layout 分析にタイムアウトを適用（ExecutionStatusTracker統合）
    analysisPromises.push(
      withTimeoutAndTracking(
        layoutPromise,
        effectivePhaseTimeouts.layoutAnalysis,
        'layout-analysis',
        'layout',
        executionTracker,
        warnings
      ).then(result => {
        layoutServiceResult = result;
      })
    );
  }

  if (features.motion !== false) {
    // preExtractedCssUrlsをモーション検出にも渡す（サニタイズ前のHTMLから抽出済み）
    // DOMPurifyで<link>タグが除去される問題の回避策

    // =====================================================
    // layout_first モード時のモーション検出軽量化（v0.1.0）
    // WebGLサイトでは library_only モードで高速検出
    // =====================================================
    let effectiveMotionOptions = validated.motionOptions;
    if (useLayoutFirst) {
      // ユーザーが明示的にfetchExternalCss: trueを指定した場合は尊重（v0.1.0）
      // これにより、デザインデータ抽出目的での外部CSS取得が可能
      const userExplicitFetchExternalCss = validated.motionOptions?.fetchExternalCss;
      const effectiveFetchExternalCss = userExplicitFetchExternalCss === true ? true : false;

      effectiveMotionOptions = {
        ...validated.motionOptions,
        // library_only モードでライブラリ検出のみ実行（CDP/WebAnimations無効）
        // これにより 264秒 → 5-15秒 に短縮
        detect_js_animations: true,
        js_animation_options: {
          ...validated.motionOptions?.js_animation_options,
          enableCDP: false,           // CDP無効（高速化）
          enableWebAnimations: false, // Web Animations API無効（高速化）
          enableLibraryDetection: true, // ライブラリ検出のみ有効
          waitTime: 500,              // 短縮待機
        },
        // CSS解析は維持（高速）
        // v0.1.0: ユーザーが明示的に指定した場合は尊重、それ以外はデフォルトfalse（タイムアウト防止）
        fetchExternalCss: effectiveFetchExternalCss,
        maxPatterns: 50, // パターン数制限（メモリ節約）
      };

      if (isDevelopment()) {
        logger.info('[page.analyze] layout_first: motion detection using lightweight mode', {
          originalOptions: {
            detect_js_animations: validated.motionOptions?.detect_js_animations,
            fetchExternalCss: validated.motionOptions?.fetchExternalCss,
          },
          effectiveOptions: {
            detect_js_animations: true,
            enableCDP: false,
            enableWebAnimations: false,
            enableLibraryDetection: true,
            fetchExternalCss: effectiveFetchExternalCss,
          },
        });
      }
    }

    // extendedContextにlayout_firstモード情報を含める
    const motionExtendedContext = useLayoutFirst
      ? { layoutFirstModeEnabled: true }
      : undefined;

    const motionPromise = detectMotion(
      sanitizedHtml,
      validated.url,
      effectiveMotionOptions,
      undefined, // dbContext
      motionExtendedContext, // extendedContext（layout_firstモード情報を含む）
      preExtractedCssUrls // サニタイズ前に抽出した外部CSS URL
    );

    // withTimeoutAndTracking で Motion 検出にタイムアウトを適用（ExecutionStatusTracker統合）
    analysisPromises.push(
      withTimeoutAndTracking(
        motionPromise,
        effectivePhaseTimeouts.motionDetection,
        'motion-detection',
        'motion',
        executionTracker,
        warnings
      ).then(result => {
        motionServiceResult = result;
      })
    );
  }

  if (features.quality !== false) {
    const qualityPromise = evaluateQuality(sanitizedHtml, validated.qualityOptions);

    // withTimeoutAndTracking で Quality 評価にタイムアウトを適用（ExecutionStatusTracker統合）
    analysisPromises.push(
      withTimeoutAndTracking(
        qualityPromise,
        effectivePhaseTimeouts.qualityEvaluation,
        'quality-evaluation',
        'quality',
        executionTracker,
        warnings
      ).then(result => {
        qualityServiceResult = result;
      })
    );
  }

  // 並列分析を実行（withTimeoutAndTrackingで個別にハンドリング済み）
  // Strict戦略でエラーがスローされた場合はここでcatchされる
  try {
    await Promise.all(analysisPromises);
  } catch (error) {
    // Strict戦略でタイムアウトまたはエラーが発生した場合
    if (timeoutStrategy === 'strict') {
      const errorMessage = error instanceof Error ? error.message : 'Analysis failed';
      if (isDevelopment()) {
        logger.error('[page.analyze] Strict strategy: analysis failed', {
          error: errorMessage,
          executionStatus: executionTracker.toExecutionStatus(),
        });
      }
      return {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
          message: errorMessage,
        },
      };
    }
    // Progressive戦略では例外は発生しないはずだが、念のため無視して継続
  }

  // 結果を統合
  let layoutResult: LayoutResult | undefined;
  let motionResult: MotionResult | undefined;
  let qualityResult: QualityResult | undefined;
  let narrativeResult: NarrativeResult | undefined;
  let layoutServiceResultForSave: LayoutServiceResult | undefined;
  let motionServiceResultForSave: MotionServiceResult | undefined;
  let qualityServiceResultForSave: QualityServiceResult | undefined;
  let narrativeHandlerResult: NarrativeHandlerResult | undefined;
  const isSummary = validated.summary ?? true;

  // Layout結果の処理
  if (layoutServiceResult) {
    layoutServiceResultForSave = layoutServiceResult;
    layoutResult = buildLayoutResult(layoutServiceResult, isSummary, validated.layoutOptions);
    const warning = extractWarning('layout', layoutServiceResult);
    if (warning) warnings.push(warning);
  }

  // Motion結果の処理
  // Note: TypeScript control flow analysis doesn't track Promise.then() assignments,
  // so we use explicit type assertion after the truthy check
  if (motionServiceResult !== null) {
    const motion = motionServiceResult as MotionServiceResult;
    motionServiceResultForSave = motion;
    motionResult = buildMotionResult(motion, isSummary);
    const warning = extractWarning('motion', motion);
    if (warning) warnings.push(warning);

    // WebGL/Canvas検出警告（patternCount=0件 かつ detect_js_animations=false の場合）
    const detectJsAnimations = validated.motionOptions?.detect_js_animations ?? true; // v0.1.0: デフォルトtrue
    if (motion.patternCount === 0 && detectJsAnimations === false) {
      warnings.push({
        feature: 'motion',
        code: 'WEBGL_DETECTION_DISABLED',
        message: 'WebGL/Canvas animations may not be detected with current settings. Enable motionOptions.detect_js_animations: true for Three.js, GSAP, Lottie detection.',
      });
      if (isDevelopment()) {
        logger.info('[MCP Tool] page.analyze WebGL detection warning added', {
          patternCount: motion.patternCount,
          detectJsAnimations,
        });
      }
    }
  }

  // Quality結果の処理
  if (qualityServiceResult) {
    qualityServiceResultForSave = qualityServiceResult;
    qualityResult = buildQualityResult(qualityServiceResult, isSummary, validated.qualityOptions);
    const warning = extractWarning('quality', qualityServiceResult);
    if (warning) warnings.push(warning);
  }

  // =====================================================
  // DB保存処理（saveToDb=true の場合、デフォルトでtrue）
  // =====================================================
  const layoutSaveToDb = validated.layoutOptions?.saveToDb !== false;
  const motionSaveToDb = validated.motionOptions?.saveToDb !== false;
  let savedWebPageId: string | undefined;
  // sectionIdMapping: 元のセクションID（section-0等）→ DB保存後のUUIDv7のマッピング
  let savedSectionIdMapping: Map<string, string> | undefined;
  // motionPatternIdMapping: 元のモーションパターンID（motion-0等）→ DB保存後のUUIDv7のマッピング
  let savedMotionPatternIdMapping: Map<string, string> | undefined;
  // backgroundDesignCount: DB保存された背景デザインの件数
  let savedBackgroundDesignCount = 0;

  if (layoutSaveToDb || motionSaveToDb) {
    const prisma = getPrismaClient();

    if (prisma) {
      // Vision分析結果を取得（全セクションで共有）
      const visionFeaturesFromLayout = layoutServiceResultForSave?.visionFeatures;
      // ページ全体のCSSスニペットを取得（全セクションで共有）
      const pageCssSnippet = layoutServiceResultForSave?.cssSnippet;
      // ページ全体の外部CSSコンテンツを取得（全セクションで共有）
      const pageExternalCssContent = layoutServiceResultForSave?.externalCssContent;
      // ページ全体の外部CSSメタ情報を取得（全セクションで共有）
      const pageExternalCssMeta = layoutServiceResultForSave?.externalCssMeta;
      // ページ全体のCSSフレームワーク検出結果を取得（全セクションで共有）
      const pageCssFramework = layoutServiceResultForSave?.cssFramework;

      if (isDevelopment()) {
        logger.debug('[page.analyze] CSS info from layout analysis', {
          hasCssSnippet: !!pageCssSnippet,
          cssSnippetLength: pageCssSnippet?.length ?? 0,
          hasExternalCssContent: !!pageExternalCssContent,
          externalCssContentLength: pageExternalCssContent?.length ?? 0,
          cssFramework: pageCssFramework?.framework,
          cssFrameworkConfidence: pageCssFramework?.confidence,
        });
      }

      // sectionsをDB保存用に変換（Vision分析結果 + CSSスニペット + CSSフレームワークを含む）
      if (isDevelopment()) {
        logger.debug('[page.analyze] sectionsForSave preparation', {
          hasSections: !!layoutServiceResultForSave?.sections,
          sectionCount: layoutServiceResultForSave?.sections?.length ?? 0,
          pageCssFrameworkDetails: pageCssFramework ? {
            framework: pageCssFramework.framework,
            confidence: pageCssFramework.confidence,
            evidenceCount: pageCssFramework.evidence?.length ?? 0,
          } : null,
        });
      }
      const sectionsForSave: SectionForSave[] = layoutServiceResultForSave?.sections?.map((section) => {
        const sectionForSave: SectionForSave = {
          id: section.id,
          type: section.type,
          positionIndex: section.positionIndex,
          heading: section.heading,
          confidence: section.confidence,
          // htmlSnippetはLayoutServiceResult経由でSectionDetectorから取得
          htmlSnippet: section.htmlSnippet,
        };

        // ページ全体のCSSスニペットを各セクションに設定
        // NOTE: CSS情報はページ全体から抽出されるため、各セクションに同じCSSを含める
        if (pageCssSnippet !== undefined && pageCssSnippet.length > 0) {
          sectionForSave.cssSnippet = pageCssSnippet;
        }

        if (pageExternalCssContent !== undefined && pageExternalCssContent.length > 0) {
          sectionForSave.externalCssContent = pageExternalCssContent;
        }

        if (pageExternalCssMeta !== undefined) {
          sectionForSave.externalCssMeta = pageExternalCssMeta;
        }

        // ページ全体のCSSフレームワーク検出結果を各セクションに設定
        // NOTE: CSSフレームワークはページ全体で検出されるため、各セクションに同じ値を含める
        if (pageCssFramework !== undefined) {
          sectionForSave.cssFramework = pageCssFramework.framework;
          sectionForSave.cssFrameworkMeta = {
            confidence: pageCssFramework.confidence,
            evidence: pageCssFramework.evidence,
          };
        }

        // Vision分析結果がある場合はセクションに含める
        // NOTE: Vision分析はページ全体の解析結果のため、各セクションに同じ結果を含める
        // 将来的にはセクションごとの分析結果を持つように拡張可能
        if (visionFeaturesFromLayout && visionFeaturesFromLayout.success) {
          const visionFeatures: SectionForSave['visionFeatures'] = {
            success: visionFeaturesFromLayout.success,
            features: visionFeaturesFromLayout.features,
          };
          // exactOptionalPropertyTypes対応: undefinedの場合はプロパティを含めない
          if (layoutServiceResultForSave?.textRepresentation !== undefined) {
            visionFeatures.textRepresentation = layoutServiceResultForSave.textRepresentation;
          }
          if (visionFeaturesFromLayout.processingTimeMs !== undefined) {
            visionFeatures.processingTimeMs = visionFeaturesFromLayout.processingTimeMs;
          }
          if (visionFeaturesFromLayout.modelName !== undefined) {
            visionFeatures.modelName = visionFeaturesFromLayout.modelName;
          }
          sectionForSave.visionFeatures = visionFeatures;
        }

        return sectionForSave;
      }) ?? [];

      // sectionsForSaveの内容を確認（cssFrameworkが設定されているか）
      if (isDevelopment()) {
        const sectionsWithCssFramework = sectionsForSave.filter(s => s.cssFramework !== undefined);
        logger.debug('[page.analyze] sectionsForSave created', {
          totalSections: sectionsForSave.length,
          sectionsWithCssFramework: sectionsWithCssFramework.length,
          firstSectionCssFramework: sectionsForSave[0]?.cssFramework ?? 'not set',
          firstSectionHasCssFrameworkMeta: !!sectionsForSave[0]?.cssFrameworkMeta,
        });
      }

      // motionPatternsをDB保存用に変換
      const motionPatternsForSave: MotionPatternForSave[] = motionServiceResultForSave?.patterns?.map((pattern) => ({
        id: pattern.id,
        name: pattern.name,
        type: pattern.type,
        category: pattern.category,
        trigger: pattern.trigger,
        duration: pattern.duration,
        easing: pattern.easing,
        properties: pattern.properties,
        propertiesDetailed: pattern.propertiesDetailed,
        rawCss: undefined, // MotionServiceResultにはrawCssが含まれていない
        performance: pattern.performance,
        accessibility: pattern.accessibility,
      })) ?? [];

      // ページ全体のvisualFeatures（Phase 3-2追加）
      // layoutServiceResultForSaveから取得し、各セクションのvisualFeaturesカラムに保存
      const pageVisualFeatures = layoutServiceResultForSave?.visualFeatures;

      if (isDevelopment() && pageVisualFeatures) {
        logger.debug('[page.analyze] visualFeatures from layout analysis', {
          hasColors: !!pageVisualFeatures.colors,
          hasTheme: !!pageVisualFeatures.theme,
          hasDensity: !!pageVisualFeatures.density,
          hasGradient: !!pageVisualFeatures.gradient,
          hasMood: !!pageVisualFeatures.mood,
          hasBrandTone: !!pageVisualFeatures.brandTone,
        });
      }

      // 背景デザイン検出結果をDB保存用に変換
      const backgroundDesignsForSave: BackgroundDesignForSave[] | undefined =
        layoutServiceResultForSave?.backgroundDesigns?.map((bg) => ({
          name: bg.name,
          designType: bg.designType,
          cssValue: bg.cssValue,
          selector: bg.selector,
          positionIndex: bg.positionIndex,
          colorInfo: bg.colorInfo as unknown as Record<string, unknown>,
          gradientInfo: bg.gradientInfo as unknown as Record<string, unknown> | undefined,
          visualProperties: bg.visualProperties as unknown as Record<string, unknown>,
          animationInfo: bg.animationInfo as unknown as Record<string, unknown> | undefined,
          cssImplementation: bg.cssImplementation,
          performance: bg.performance as unknown as Record<string, unknown>,
          confidence: bg.confidence,
          sourceUrl: validated.url,
          usageScope: validated.usageScope ?? 'inspiration_only',
        }));

      const saveResult = await saveToDatabase(prisma, {
        url: normalizeUrlForStorage(normalizedUrl),
        title: metadata.title,
        htmlContent: sanitizedHtml,
        screenshot: fetchedScreenshot,
        sourceType: validated.sourceType ?? 'user_provided',
        usageScope: validated.usageScope ?? 'inspiration_only',
        layoutSaveToDb,
        motionSaveToDb,
        sections: sectionsForSave,
        motionPatterns: motionPatternsForSave,
        qualityResult: qualityServiceResultForSave,
        visualFeatures: pageVisualFeatures,
        backgroundDesigns: backgroundDesignsForSave,
      });

      if (saveResult.success) {
        savedWebPageId = saveResult.webPageId;
        savedSectionIdMapping = saveResult.sectionIdMapping;
        savedMotionPatternIdMapping = saveResult.motionPatternIdMapping;
        savedBackgroundDesignCount = saveResult.backgroundDesignCount ?? 0;

        if (isDevelopment()) {
          logger.info('[page.analyze] DB save completed', {
            webPageId: saveResult.webPageId,
            sectionPatternCount: saveResult.sectionPatternCount,
            motionPatternCount: saveResult.motionPatternCount,
            backgroundDesignCount: saveResult.backgroundDesignCount,
            qualityEvaluationId: saveResult.qualityEvaluationId,
            sectionIdMappingSize: savedSectionIdMapping?.size ?? 0,
            motionPatternIdMappingSize: savedMotionPatternIdMapping?.size ?? 0,
          });
        }
      } else {
        // Graceful Degradation: 保存失敗を警告に記録
        warnings.push({
          feature: 'layout', // DB保存はlayout機能の一部として扱う
          code: PAGE_ANALYZE_ERROR_CODES.DB_SAVE_FAILED,
          message: saveResult.error ?? 'Failed to save to database',
        });

        if (isDevelopment()) {
          logger.warn('[page.analyze] DB save failed (graceful degradation)', {
            error: saveResult.error,
          });
        }
      }
    } else {
      // PrismaClientが未設定の場合はスキップ（Graceful Degradation）
      logger.warn('[page.analyze] DB save skipped: database connection not configured');
      warnings.push({
        feature: 'layout',
        code: PAGE_ANALYZE_ERROR_CODES.DB_NOT_CONFIGURED,
        message: 'DB save skipped: database connection not configured. Data will not be persisted.',
      });
    }
  }

  // layoutResultにpageIdを設定（保存成功時）
  if (savedWebPageId && layoutResult) {
    (layoutResult as { pageId?: string }).pageId = savedWebPageId;
  }

  // =====================================================
  // Embedding生成・保存（autoAnalyze / saveToDb オプション時）
  // =====================================================

  // SectionEmbedding生成・保存（autoAnalyze=true（デフォルト） かつ saveToDb=true かつ IDマッピングがある場合）
  // ロジックはembedding-handler.tsに分離
  const autoAnalyze = validated.layoutOptions?.autoAnalyze !== false;

  if (autoAnalyze && layoutSaveToDb && layoutServiceResultForSave?.success && layoutServiceResultForSave.sections && savedSectionIdMapping && savedSectionIdMapping.size > 0) {
    // ページレベルのvisualFeaturesを取得（Phase 3-3: visualFeatures伝播）
    const pageVisualFeaturesForEmbedding = layoutServiceResultForSave.visualFeatures;

    // sectionsにvisualFeaturesを伝播してSectionDataForEmbedding[]を作成
    // db-handler.tsと同様に、ページレベルのvisualFeaturesを各セクションに適用
    const sectionsWithVisualFeatures: SectionDataForEmbedding[] = layoutServiceResultForSave.sections.map((section) => {
      // exactOptionalPropertyTypes対応: 明示的にオブジェクトを構築
      const sectionForEmbedding: SectionDataForEmbedding = {
        id: section.id,
        type: section.type,
        positionIndex: section.positionIndex,
        confidence: section.confidence,
      };

      // オプショナルフィールドは存在する場合のみ設定
      if (section.heading !== undefined) {
        sectionForEmbedding.heading = section.heading;
      }
      if (section.htmlSnippet !== undefined) {
        sectionForEmbedding.htmlSnippet = section.htmlSnippet;
      }

      // セクション固有のvisualFeaturesがある場合はそれを使用、なければページレベルを使用
      // NOTE: 現在はセクション固有のvisualFeaturesはないため、常にページレベルを使用
      if (pageVisualFeaturesForEmbedding !== undefined) {
        sectionForEmbedding.visualFeatures = pageVisualFeaturesForEmbedding;
      }

      return sectionForEmbedding;
    });

    if (isDevelopment()) {
      logger.debug('[page.analyze] Propagating visualFeatures to sections for embedding', {
        sectionCount: sectionsWithVisualFeatures.length,
        hasPageVisualFeatures: !!pageVisualFeaturesForEmbedding,
        pageVisualFeaturesKeys: pageVisualFeaturesForEmbedding ? Object.keys(pageVisualFeaturesForEmbedding) : [],
      });
    }

    // 分離されたハンドラーを呼び出し（visualFeatures伝播済みのセクションを渡す）
    // MCP 600秒ガード: 残り時間が不足していればスキップ
    const sectionEmbeddingRemaining = Math.max(0, 570000 - (Date.now() - overallStartTime));
    if (sectionEmbeddingRemaining < 10000) {
      warnings.push({
        feature: 'layout',
        code: 'EMBEDDING_SKIPPED',
        message: `Section embedding generation skipped: insufficient time remaining (${sectionEmbeddingRemaining}ms)`,
      });
    } else {
      try {
        await withTimeout(
          generateSectionEmbeddings(sectionsWithVisualFeatures, savedSectionIdMapping, {
            webPageId: savedWebPageId,
          }),
          Math.min(60000, sectionEmbeddingRemaining),
          'section-embedding-generation'
        );
      } catch (embeddingError) {
        const msg = embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
        warnings.push({
          feature: 'layout',
          code: 'EMBEDDING_TIMEOUT',
          message: `Section embedding generation failed: ${msg}`,
        });
        if (isDevelopment()) {
          logger.warn('[page.analyze] Section embedding generation failed', { error: msg });
        }
      }
    }
  }

  // MotionEmbedding生成・保存（saveToDb=true かつ IDマッピングがある場合）
  // ロジックはembedding-handler.tsに分離
  // 注意: db-handler.tsでMotionPatternは既に保存済み。ここではEmbedding生成・保存のみ実行
  if (motionSaveToDb && motionServiceResultForSave?.success && motionServiceResultForSave.patterns && savedMotionPatternIdMapping && savedMotionPatternIdMapping.size > 0) {
    const patterns = motionServiceResultForSave.patterns as MotionPatternForEmbedding[];

    // 分離されたハンドラーを呼び出し（motionPatternIdMappingを渡してEmbedding生成のみ実行）
    // MCP 600秒ガード: 残り時間が不足していればスキップ
    const motionEmbeddingRemaining = Math.max(0, 570000 - (Date.now() - overallStartTime));
    if (motionEmbeddingRemaining < 10000) {
      warnings.push({
        feature: 'motion',
        code: 'EMBEDDING_SKIPPED',
        message: `Motion embedding generation skipped: insufficient time remaining (${motionEmbeddingRemaining}ms)`,
      });
    } else {
      try {
        await withTimeout(
          generateMotionEmbeddings(patterns, {
            webPageId: savedWebPageId,
            sourceUrl: validated.url,
            motionPatternIdMapping: savedMotionPatternIdMapping,
          }),
          Math.min(60000, motionEmbeddingRemaining),
          'motion-embedding-generation'
        );
      } catch (embeddingError) {
        const msg = embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
        warnings.push({
          feature: 'motion',
          code: 'EMBEDDING_TIMEOUT',
          message: `Motion embedding generation failed: ${msg}`,
        });
        if (isDevelopment()) {
          logger.warn('[page.analyze] Motion embedding generation failed', { error: msg });
        }
      }
    }
  }

  // =====================================================
  // VideoMode DB保存処理（motionOptions.saveToDb=true かつ frame_analysis あり）
  // =====================================================
  // MotionDbServiceを使用してフレーム画像分析結果（AnimationZone, LayoutShift, MotionVector）を保存
  // MotionDbService は Embedding を自動生成するため、明示的な生成は不要
  if (motionSaveToDb && motionServiceResultForSave?.success) {
    // motionServiceResultForSave から生のframeAnalysis結果を取得する必要がある
    // frame_analysisがある場合は、FrameImageAnalysisOutput形式に変換してMotionDbServiceで保存
    // 注: motionServiceResultForSave.frame_analysisはMotionServiceResult形式（timeline/summary）
    // MotionDbService.saveFrameAnalysis()はFrameImageAnalysisOutput形式を期待
    // → 保存対象: animationZones, layoutShifts, motionVectors を推定して保存

    // frame_analysisのtimeline/summaryから推定してFrameImageAnalysisOutput形式を構築
    const frameAnalysis = motionServiceResultForSave.frame_analysis;
    if (frameAnalysis) {
      if (isDevelopment()) {
        logger.info('[page.analyze] Starting VideoMode frame analysis DB save', {
          webPageId: savedWebPageId,
          timelineLength: frameAnalysis.timeline?.length ?? 0,
          totalLayoutShifts: frameAnalysis.summary?.total_layout_shifts ?? 0,
        });
      }

      try {
        const motionDbService = getMotionDbService();

        if (motionDbService.isAvailable()) {
          // FrameImageAnalysisOutput形式を構築
          // timeline から animationZones を推定
          const animationZones: Array<{
            frameStart: string;
            frameEnd: string;
            scrollStart: number;
            scrollEnd: number;
            duration: number;
            avgDiff: string;
            peakDiff: string;
            animationType: 'micro-interaction' | 'fade/slide transition' | 'scroll-linked animation' | 'long-form reveal';
          }> = [];

          // timeline から layoutShifts を推定（layout_shift_score > 0.05 の場合）
          const layoutShifts: Array<{
            frameRange: string;
            scrollRange: string;
            impactFraction: string;
            boundingBox: { x: number; y: number; width: number; height: number };
          }> = [];

          // timeline から motionVectors を推定
          const motionVectors: Array<{
            frameRange: string;
            dx: number;
            dy: number;
            magnitude: string;
            direction: 'up' | 'down' | 'left' | 'right' | 'stationary';
            angle: string;
          }> = [];

          // timeline の significant_change_frames から AnimationZones を構築
          const significantFrames = frameAnalysis.summary?.significant_change_frames ?? [];
          const scrollPxPerFrame = 15; // Reftrix default

          if (significantFrames.length > 0) {
            // 連続したフレームをグループ化してAnimationZoneを作成
            let zoneStart = significantFrames[0] ?? 0;
            let zoneEnd = zoneStart;
            const diffs: number[] = [];

            for (let i = 0; i < significantFrames.length; i++) {
              const currentFrame = significantFrames[i] ?? 0;
              const nextFrame = significantFrames[i + 1];

              // 対応するtimelineエントリからdiffを取得
              const timelineEntry = frameAnalysis.timeline.find(t => t.frame_index === currentFrame);
              if (timelineEntry) {
                diffs.push(timelineEntry.diff_percentage * 100);
              }

              // 連続フレーム判定（5フレーム以内なら連続とみなす）
              if (nextFrame !== undefined && nextFrame - currentFrame <= 5) {
                zoneEnd = nextFrame;
              } else {
                // ゾーン確定
                if (diffs.length > 0) {
                  const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
                  const peakDiff = Math.max(...diffs);
                  const duration = (zoneEnd - zoneStart) * scrollPxPerFrame;

                  // アニメーションタイプを分類
                  let animationType: 'micro-interaction' | 'fade/slide transition' | 'scroll-linked animation' | 'long-form reveal';
                  if (duration < 500) animationType = 'micro-interaction';
                  else if (duration < 1500) animationType = 'fade/slide transition';
                  else if (duration < 3000) animationType = 'scroll-linked animation';
                  else animationType = 'long-form reveal';

                  animationZones.push({
                    frameStart: `frame-${String(zoneStart).padStart(4, '0')}.png`,
                    frameEnd: `frame-${String(zoneEnd).padStart(4, '0')}.png`,
                    scrollStart: zoneStart * scrollPxPerFrame,
                    scrollEnd: zoneEnd * scrollPxPerFrame,
                    duration,
                    avgDiff: avgDiff.toFixed(2),
                    peakDiff: peakDiff.toFixed(2),
                    animationType,
                  });
                }

                // 次のゾーン開始
                if (nextFrame !== undefined) {
                  zoneStart = nextFrame;
                  zoneEnd = nextFrame;
                  diffs.length = 0;
                }
              }
            }
          }

          // timeline から layoutShifts を推定
          for (const timelineEntry of frameAnalysis.timeline) {
            const shiftScore = timelineEntry.layout_shift_score;
            if (shiftScore !== undefined && shiftScore > 0.05) {
              layoutShifts.push({
                frameRange: `frame-${String(timelineEntry.frame_index).padStart(4, '0')}.png`,
                scrollRange: `${timelineEntry.frame_index * scrollPxPerFrame}px`,
                impactFraction: shiftScore.toFixed(4),
                boundingBox: { x: 0, y: 0, width: 1920, height: 1080 }, // デフォルト
              });
            }
          }

          // timeline の motion_vectors から MotionVectors を構築
          for (const timelineEntry of frameAnalysis.timeline) {
            const vectors = timelineEntry.motion_vectors;
            if (vectors && vectors.length > 0) {
              for (const vector of vectors) {
                // 方向を判定
                const angle = Math.atan2(vector.y, vector.x) * (180 / Math.PI);
                let direction: 'up' | 'down' | 'left' | 'right' | 'stationary' = 'stationary';
                if (vector.magnitude >= 5) {
                  if (angle >= -45 && angle < 45) direction = 'right';
                  else if (angle >= 45 && angle < 135) direction = 'down';
                  else if (angle >= -135 && angle < -45) direction = 'up';
                  else direction = 'left';
                }

                motionVectors.push({
                  frameRange: `frame-${String(timelineEntry.frame_index).padStart(4, '0')}.png`,
                  dx: vector.x,
                  dy: vector.y,
                  magnitude: vector.magnitude.toFixed(2),
                  direction,
                  angle: angle.toFixed(2),
                });
              }
            }
          }

          // FrameImageAnalysisOutput形式を構築
          const frameAnalysisOutput = {
            metadata: {
              framesDir: motionServiceResultForSave.frame_capture?.output_dir ?? '/tmp/reftrix-frames/',
              totalFrames: motionServiceResultForSave.frame_capture?.total_frames ?? 0,
              analyzedPairs: frameAnalysis.timeline.length,
              sampleInterval: 1,
              scrollPxPerFrame,
              analysisTime: `${(frameAnalysis.summary?.processing_time_ms ?? 0) / 1000}s`,
              analyzedAt: new Date().toISOString(),
            },
            statistics: {
              averageDiffPercentage: ((frameAnalysis.summary?.avg_diff ?? 0) * 100).toFixed(2),
              significantChangeCount: significantFrames.length,
              significantChangePercentage: frameAnalysis.timeline.length > 0
                ? ((significantFrames.length / frameAnalysis.timeline.length) * 100).toFixed(2)
                : '0.00',
              layoutShiftCount: frameAnalysis.summary?.total_layout_shifts ?? 0,
              motionVectorCount: motionVectors.length,
            },
            animationZones,
            layoutShifts,
            motionVectors,
          };

          // MotionDbServiceで保存
          const motionDbSaveResult: MotionDbBatchSaveResult = await motionDbService.saveFrameAnalysis(
            frameAnalysisOutput,
            {
              webPageId: savedWebPageId,
              sourceUrl: validated.url,
              continueOnError: true,
            }
          );

          if (isDevelopment()) {
            logger.info('[page.analyze] VideoMode frame analysis DB save completed', {
              saved: motionDbSaveResult.saved,
              savedCount: motionDbSaveResult.savedCount,
              byCategory: motionDbSaveResult.byCategory,
              reason: motionDbSaveResult.reason,
            });
          }

          // 保存失敗時はwarningsに記録（Graceful Degradation）
          if (!motionDbSaveResult.saved && motionDbSaveResult.reason) {
            warnings.push({
              feature: 'motion',
              code: 'FRAME_ANALYSIS_DB_SAVE_FAILED',
              message: motionDbSaveResult.reason,
            });
          }
        } else {
          if (isDevelopment()) {
            logger.warn('[page.analyze] MotionDbService not available, skipping frame analysis DB save');
          }
        }
      } catch (frameDbError) {
        // VideoMode DB保存失敗（Graceful Degradation）
        if (isDevelopment()) {
          logger.warn('[page.analyze] VideoMode frame analysis DB save failed (graceful degradation)', {
            error: frameDbError instanceof Error ? frameDbError.message : 'Unknown error',
          });
        }

        warnings.push({
          feature: 'motion',
          code: 'FRAME_ANALYSIS_DB_SAVE_ERROR',
          message: frameDbError instanceof Error ? frameDbError.message : 'Frame analysis DB save failed',
        });
      }
    }

    // =====================================================
    // JSアニメーションパターン DB保存処理（saveToDb=true かつ js_animations あり）
    // =====================================================
    // JSアニメーション検出結果をJSAnimationPatternテーブルに保存
    const jsAnimations = motionServiceResultForSave?.js_animations;
    const jsAnimationPrisma = getPrismaClient();
    if (jsAnimations && savedWebPageId && jsAnimationPrisma) {
      try {
        if (isDevelopment()) {
          logger.info('[page.analyze] Starting JS animation patterns DB save', {
            webPageId: savedWebPageId,
            cdpAnimationCount: jsAnimations.cdpAnimations?.length ?? 0,
            webAnimationCount: jsAnimations.webAnimations?.length ?? 0,
            totalDetected: jsAnimations.totalDetected ?? 0,
          });
        }

        // JSAnimationFullResultをJSAnimationPatternCreateDataの配列に変換
        const jsAnimationPatterns = mapJSAnimationResultToPatterns(
          jsAnimations,
          savedWebPageId,
          validated.url
        );

        // DBに保存（Embedding生成含む）
        if (jsAnimationPatterns.length > 0) {
          const saveResult = await saveJSAnimationPatternsWithEmbeddings(
            jsAnimationPrisma,
            jsAnimationPatterns,
            savedWebPageId,
            { generateEmbedding: true } // Embedding生成を有効化
          );

          if (isDevelopment()) {
            logger.info('[page.analyze] JS animation patterns DB save completed', {
              savedPatternCount: saveResult.savedPatternCount,
              embeddingCount: saveResult.embeddingCount,
              totalPatterns: jsAnimationPatterns.length,
              webPageId: savedWebPageId,
            });
          }
        }
      } catch (jsAnimDbError) {
        // JSアニメーションDB保存失敗（Graceful Degradation）
        if (isDevelopment()) {
          logger.warn('[page.analyze] JS animation patterns DB save failed (graceful degradation)', {
            error: jsAnimDbError instanceof Error ? jsAnimDbError.message : 'Unknown error',
          });
        }

        warnings.push({
          feature: 'motion',
          code: 'JS_ANIMATION_DB_SAVE_ERROR',
          message: jsAnimDbError instanceof Error ? jsAnimDbError.message : 'JS animation DB save failed',
        });
      }
    }
  }

  // =====================================================
  // Narrative分析（v0.1.0: narrativeOptions.enabled=true の場合）
  // =====================================================
  // NarrativeAnalysisServiceを使用してWebページの
  // 「世界観・雰囲気（WorldView）」と「レイアウト構成（LayoutStructure）」を分析
  // NOTE: DB保存後に実行することで、saveToDb=trueの場合にwebPageIdを利用可能
  // NOTE: narrativeOptions.enabledはデフォルトでtrue（Zodスキーマで設定）
  // v0.1.0: ?.演算子ではなく !== false でチェック（undefined/true の両方で有効化）
  const narrativeEnabled = validated.narrativeOptions?.enabled !== false;
  if (narrativeEnabled) {
    if (isDevelopment()) {
      logger.info('[page.analyze] Starting narrative analysis', {
        saveToDb: validated.narrativeOptions.saveToDb,
        includeVision: validated.narrativeOptions.includeVision,
        visionTimeoutMs: validated.narrativeOptions.visionTimeoutMs,
        generateEmbedding: validated.narrativeOptions.generateEmbedding,
        webPageId: savedWebPageId,
      });
    }

    // Narrative分析用の入力を準備
    const narrativeInput: NarrativeHandlerInput = {
      html,
      narrativeOptions: validated.narrativeOptions,
    };

    // exactOptionalPropertyTypes対応: undefinedのプロパティは含めない
    if (fetchedScreenshot !== undefined) {
      narrativeInput.screenshot = fetchedScreenshot;
    }

    // webPageIdがある場合は渡す（saveToDb=trueの場合に必要）
    if (savedWebPageId !== undefined) {
      narrativeInput.webPageId = savedWebPageId;
    }

    // 既存の分析結果を渡す（Narrative分析の精度向上のため）
    // NOTE: layoutServiceResultForSaveを使用（DB保存用に保持された結果）
    if (layoutServiceResultForSave || motionServiceResultForSave) {
      narrativeInput.existingAnalysis = {};
      if (layoutServiceResultForSave?.cssVariables) {
        narrativeInput.existingAnalysis.cssVariables = layoutServiceResultForSave.cssVariables;
      }
      if (motionServiceResultForSave) {
        narrativeInput.existingAnalysis.motionPatterns = motionServiceResultForSave;
      }
      if (layoutServiceResultForSave?.sections) {
        narrativeInput.existingAnalysis.sections = layoutServiceResultForSave.sections;
      }
      if (layoutServiceResultForSave?.visionFeatures) {
        narrativeInput.existingAnalysis.visualFeatures = layoutServiceResultForSave.visionFeatures;
      }
    }

    // 外部CSSがある場合は渡す
    if (layoutServiceResultForSave?.externalCssContent) {
      narrativeInput.externalCss = layoutServiceResultForSave.externalCssContent;
    }

    try {
      // MCP 600秒ガード: Narrative分析のタイムアウトを残り時間に基づいて設定
      const narrativeRemaining = Math.max(0, 570000 - (Date.now() - overallStartTime));
      if (narrativeRemaining < 15000) {
        // 残り時間が15秒未満ならNarrative分析をスキップ
        warnings.push({
          feature: 'quality',
          code: 'NARRATIVE_SKIPPED',
          message: `Narrative analysis skipped: insufficient time remaining (${narrativeRemaining}ms)`,
        });
        if (isDevelopment()) {
          logger.warn('[page.analyze] Narrative analysis skipped due to insufficient time', {
            remainingMs: narrativeRemaining,
            elapsedMs: Date.now() - overallStartTime,
          });
        }
      } else {
        // Narrative分析のタイムアウト: 残り時間とvisionTimeoutMsの小さい方を使用
        const narrativeTimeout = Math.min(
          validated.narrativeOptions?.visionTimeoutMs ?? 300000,
          narrativeRemaining
        );
        narrativeHandlerResult = await withTimeout(
          handleNarrativeAnalysis(narrativeInput),
          narrativeTimeout,
          'narrative-analysis'
        );
      }

      if (narrativeHandlerResult?.success && narrativeHandlerResult.narrative) {
        narrativeResult = buildNarrativeResult(narrativeHandlerResult, isSummary);

        if (isDevelopment() && narrativeResult) {
          logger.info('[page.analyze] Narrative analysis completed', {
            moodCategory: narrativeResult.worldView?.moodCategory,
            confidence: narrativeResult.confidence,
            processingTimeMs: narrativeHandlerResult.processingTimeMs,
            savedId: narrativeHandlerResult.savedId,
          });
        }
      } else if (narrativeHandlerResult?.skipped) {
        if (isDevelopment()) {
          logger.debug('[page.analyze] Narrative analysis skipped (enabled=false)');
        }
      } else if (narrativeHandlerResult?.error) {
        // Narrative分析失敗は警告として記録し、他の分析結果は返す
        // NOTE: narrativeはfeature enumに含まれていないため、コード + メッセージのみ記録
        warnings.push({
          feature: 'quality', // narrativeはQuality系機能として分類
          code: narrativeHandlerResult.error.code,
          message: `Narrative analysis failed: ${narrativeHandlerResult.error.message}`,
        });

        if (isDevelopment()) {
          logger.warn('[page.analyze] Narrative analysis failed', {
            code: narrativeHandlerResult.error.code,
            message: narrativeHandlerResult.error.message,
          });
        }
      }
    } catch (narrativeError) {
      // タイムアウトまたは予期しないエラーは警告として記録
      const isTimeout = narrativeError instanceof PhaseTimeoutError;
      const errorMessage = narrativeError instanceof Error ? narrativeError.message : String(narrativeError);
      warnings.push({
        feature: 'quality', // narrativeはQuality系機能として分類
        code: isTimeout ? 'NARRATIVE_TIMEOUT' : 'NARRATIVE_UNEXPECTED_ERROR',
        message: isTimeout
          ? `Narrative analysis timed out: ${errorMessage}`
          : `Unexpected error in narrative analysis: ${errorMessage}`,
      });

      if (isDevelopment()) {
        logger.error('[page.analyze] Unexpected narrative analysis error', {
          error: errorMessage,
        });
      }
    }
  }

  // =====================================================
  // 注: ExecutionStatus更新はwithTimeoutAndTracking内で自動的に行われる
  // markCompleted/markFailedがPromise完了/失敗時に呼び出される
  // =====================================================

  // レスポンス構築
  const data: PageAnalyzeData = {
    id: uuidv7(),
    url: validated.url,
    normalizedUrl,
    metadata,
    source: {
      type: validated.sourceType ?? 'user_provided',
      usageScope: validated.usageScope ?? 'inspiration_only',
    },
    totalProcessingTimeMs: Date.now() - overallStartTime,
    analyzedAt: new Date().toISOString(),
    // v0.1.0: ExecutionStatusを追加
    execution_status: executionTracker.toExecutionStatus(),
  };

  if (layoutResult) {
    data.layout = layoutResult;
  }

  if (motionResult) {
    data.motion = motionResult;
  }

  if (qualityResult) {
    data.quality = qualityResult;
  }

  // v0.1.0: Narrative結果を追加
  if (narrativeResult) {
    data.narrative = narrativeResult;
  }

  // 背景デザイン検出サマリーを追加
  const backgroundDesignsSummary = buildBackgroundDesignsSummary(
    layoutServiceResultForSave?.backgroundDesigns,
    savedBackgroundDesignCount
  );
  if (backgroundDesignsSummary) {
    data.backgroundDesigns = backgroundDesignsSummary;
  }

  if (warnings.length > 0) {
    data.warnings = warnings;
  }

  // v0.1.0: Pre-flight Probe結果を追加（auto_timeout=true時のみ）
  if (probeResult) {
    data.preflightProbe = {
      calculatedTimeoutMs: probeResult.calculatedTimeoutMs,
      complexityScore: probeResult.complexityScore,
      hasWebGL: probeResult.hasWebGL,
      hasSPA: probeResult.hasSPA,
      hasHeavyFramework: probeResult.hasHeavyFramework,
      probedAt: probeResult.probedAt,
      probeVersion: probeResult.probeVersion,
      htmlSizeBytes: probeResult.htmlSizeBytes,
      scriptCount: probeResult.scriptCount,
      externalResourceCount: probeResult.externalResourceCount,
      responseTimeMs: probeResult.responseTimeMs,
    };
  }

  if (isDevelopment()) {
    logger.info('[MCP Tool] page.analyze completed', {
      url: validated.url,
      hasLayout: !!layoutResult,
      hasMotion: !!motionResult,
      hasQuality: !!qualityResult,
      hasNarrative: !!narrativeResult,
      backgroundDesignCount: backgroundDesignsSummary?.count ?? 0,
      warningCount: warnings.length,
      totalProcessingTimeMs: data.totalProcessingTimeMs,
      autoTimeout: validated.auto_timeout,
      probeUsed: probeResult !== null,
    });
  }

  return {
    success: true,
    data,
  };
}

// =====================================================
// ツール定義
// =====================================================

export const pageAnalyzeToolDefinition = {
  name: 'page.analyze',
  description:
    'Analyze a web page URL with layout detection, motion pattern extraction, and quality evaluation. Executes layout.ingest, motion.detect, and quality.evaluate in parallel and returns unified results.',
  annotations: {
    title: 'Page Analyze',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'Target URL to analyze (required)',
      },
      sourceType: {
        type: 'string',
        enum: ['award_gallery', 'user_provided'],
        default: 'user_provided',
        description: 'Source type: award_gallery or user_provided (default)',
      },
      usageScope: {
        type: 'string',
        enum: ['inspiration_only', 'owned_asset'],
        default: 'inspiration_only',
        description: 'Usage scope: inspiration_only (default) or owned_asset',
      },
      features: {
        type: 'object',
        description: 'Feature flags for analysis (default: all true)',
        properties: {
          layout: {
            type: 'boolean',
            default: true,
            description: 'Enable layout analysis (default: true)',
          },
          motion: {
            type: 'boolean',
            default: true,
            description: 'Enable motion detection (default: true)',
          },
          quality: {
            type: 'boolean',
            default: true,
            description: 'Enable quality evaluation (default: true)',
          },
        },
      },
      layoutOptions: {
        type: 'object',
        description: 'Layout analysis options',
        properties: {
          fullPage: {
            type: 'boolean',
            default: true,
            description: 'Full page screenshot (default: true)',
          },
          viewport: {
            type: 'object',
            properties: {
              width: { type: 'number', minimum: 320, maximum: 4096, default: 1440 },
              height: { type: 'number', minimum: 240, maximum: 16384, default: 900 },
            },
          },
          // MCP-RESP-03: snake_case正式形式（新規オプション推奨形式）
          include_html: {
            type: 'boolean',
            default: false,
            description: 'Include HTML in response (default: false) - snake_case正式形式',
          },
          include_screenshot: {
            type: 'boolean',
            default: false,
            description: 'Include screenshot in response (default: false) - snake_case正式形式',
          },
          // レガシー互換: camelCaseは後方互換として維持
          includeHtml: {
            type: 'boolean',
            default: false,
            description: 'Include HTML in response (default: false) - レガシー互換、include_html推奨',
          },
          includeScreenshot: {
            type: 'boolean',
            default: false,
            description: 'Include screenshot in response (default: false) - レガシー互換、include_screenshot推奨',
          },
          saveToDb: {
            type: 'boolean',
            default: true,
            description: 'Save to database (default: true)',
          },
          autoAnalyze: {
            type: 'boolean',
            default: true,
            description: 'Auto analyze sections and generate embeddings (default: true)',
          },
          fetchExternalCss: {
            type: 'boolean',
            default: true,
            description: 'Fetch external CSS files for layout analysis (default: true)',
          },
          useVision: {
            type: 'boolean',
            default: false,
            description: 'Use Vision API (Ollama + llama3.2-vision) to analyze screenshot for section detection. Delegates to layout.inspect screenshot mode. (default: false)',
          },
        },
      },
      motionOptions: {
        type: 'object',
        description: 'Motion detection options',
        properties: {
          fetchExternalCss: {
            type: 'boolean',
            default: false,
            description: 'Fetch external CSS files (default: false)',
          },
          minDuration: {
            type: 'number',
            minimum: 0,
            default: 0,
            description: 'Minimum animation duration in ms (default: 0)',
          },
          maxPatterns: {
            type: 'number',
            minimum: 1,
            maximum: 4000,
            default: 100,
            description: 'Maximum patterns to detect (default: 100)',
          },
          includeWarnings: {
            type: 'boolean',
            default: true,
            description: 'Include warnings in response (default: true)',
          },
          saveToDb: {
            type: 'boolean',
            default: true,
            description: 'Save motion patterns to database (default: true)',
          },
          // Video Mode Options (Phase 5)
          enable_frame_capture: {
            type: 'boolean',
            default: true,
            description: 'Enable frame capture for scroll animation analysis (default: true)',
          },
          frame_capture_options: {
            type: 'object',
            description: 'Frame capture configuration',
            properties: {
              frame_rate: {
                type: 'number',
                minimum: 1,
                maximum: 120,
                default: 30,
                description: 'Frame rate (default: 30fps)',
              },
              frame_interval_ms: {
                type: 'number',
                minimum: 1,
                maximum: 1000,
                default: 33,
                description: 'Frame interval in milliseconds (default: 33ms = 30fps)',
              },
              scroll_speed_px_per_sec: {
                type: 'number',
                minimum: 1,
                description: 'Scroll speed in pixels per second (optional)',
              },
              scroll_px_per_frame: {
                type: 'number',
                minimum: 0.01,
                default: 15,
                description: 'Scroll pixels per frame (default: 15px)',
              },
              output_format: {
                type: 'string',
                enum: ['png', 'jpeg'],
                default: 'png',
                description: 'Output image format (default: png)',
              },
              output_dir: {
                type: 'string',
                default: '/tmp/reftrix-frames/',
                description: 'Output directory for frames (default: /tmp/reftrix-frames/)',
              },
              filename_pattern: {
                type: 'string',
                default: 'frame-{0000}.png',
                description: 'Filename pattern with frame number placeholder (default: frame-{0000}.png)',
              },
              page_height_px: {
                type: 'number',
                minimum: 100,
                maximum: 100000,
                description: 'Manual page height in pixels (optional, auto-detected if omitted)',
              },
              scroll_duration_sec: {
                type: 'number',
                minimum: 0.1,
                maximum: 300,
                description: 'Scroll duration in seconds (optional)',
              },
            },
          },
          analyze_frames: {
            type: 'boolean',
            default: true,
            description: 'Enable frame image analysis with pixelmatch (default: true)',
          },
          frame_analysis_options: {
            type: 'object',
            description: 'Frame analysis configuration',
            properties: {
              frame_dir: {
                type: 'string',
                description: 'Frame image directory (optional, uses frame_capture_options.output_dir if omitted)',
              },
              sample_interval: {
                type: 'number',
                minimum: 1,
                maximum: 100,
                default: 1,
                description: 'Analyze every Nth frame (default: 1 = all frames)',
              },
              diff_threshold: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                default: 0.01,
                description: 'Minimum diff percentage to consider as change (default: 0.01 = 1%)',
              },
              cls_threshold: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                default: 0.1,
                description: 'CLS (Cumulative Layout Shift) warning threshold (default: 0.1)',
              },
              motion_threshold: {
                type: 'number',
                minimum: 1,
                maximum: 500,
                default: 5,
                description: 'Minimum pixels to detect motion vector (default: 5)',
              },
              output_diff_images: {
                type: 'boolean',
                default: false,
                description: 'Save diff images to output_dir (default: false)',
              },
              parallel: {
                type: 'boolean',
                default: true,
                description: 'Process frames in parallel (default: true)',
              },
            },
          },
          // JS Animation Options (v0.1.0)
          detect_js_animations: {
            type: 'boolean',
            default: false,
            description: 'Enable JavaScript animation detection via CDP + Web Animations API + library detection (default: false, requires Playwright)',
          },
          js_animation_options: {
            type: 'object',
            description: 'JS animation detection configuration',
            properties: {
              enableCDP: {
                type: 'boolean',
                default: true,
                description: 'Enable Chrome DevTools Protocol animation detection (default: true)',
              },
              enableWebAnimations: {
                type: 'boolean',
                default: true,
                description: 'Enable Web Animations API detection (default: true)',
              },
              enableLibraryDetection: {
                type: 'boolean',
                default: true,
                description: 'Enable library detection (GSAP, Framer Motion, anime.js, Three.js, Lottie) (default: true)',
              },
              waitTime: {
                type: 'number',
                minimum: 0,
                maximum: 10000,
                default: 1000,
                description: 'Wait time in ms after page load before detecting animations (default: 1000)',
              },
            },
          },
          // v0.1.0: Motion検出タイムアウト（asyncモードでは長時間検出可能）
          timeout: {
            type: 'number',
            minimum: 30000,
            maximum: 600000,
            default: 180000,
            description: 'Motion detection timeout in milliseconds. MCP Protocol has a 60-second tool call limit. In async mode (page.analyze with async=true), this limit does not apply, allowing longer detection times for heavy WebGL/Three.js sites. (default: 180000 = 3 minutes, max: 600000 = 10 minutes)',
          },
        },
      },
      qualityOptions: {
        type: 'object',
        description: 'Quality evaluation options',
        properties: {
          weights: {
            type: 'object',
            properties: {
              originality: { type: 'number', minimum: 0, maximum: 1, default: 0.35 },
              craftsmanship: { type: 'number', minimum: 0, maximum: 1, default: 0.4 },
              contextuality: { type: 'number', minimum: 0, maximum: 1, default: 0.25 },
            },
          },
          targetIndustry: {
            type: 'string',
            maxLength: 100,
            description: 'Target industry for contextual evaluation',
          },
          targetAudience: {
            type: 'string',
            maxLength: 100,
            description: 'Target audience for contextual evaluation',
          },
          strict: {
            type: 'boolean',
            default: false,
            description: 'Strict mode for AI cliche detection (default: false)',
          },
          includeRecommendations: {
            type: 'boolean',
            default: true,
            description: 'Include recommendations in response (default: true)',
          },
        },
      },
      summary: {
        type: 'boolean',
        default: true,
        description: 'Return summary response (default: true). Set to false for full details.',
      },
      timeout: {
        type: 'number',
        minimum: 5000,
        maximum: 300000,
        default: 60000,
        description: 'Overall timeout in ms (default: 60000)',
      },
      waitUntil: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        default: 'load',
        description: 'Page load completion criteria (default: load)',
      },
      auto_timeout: {
        type: 'boolean',
        default: false,
        description: 'Enable Pre-flight Probe for dynamic timeout calculation (v0.1.0). Analyzes page complexity (WebGL, SPA, heavy frameworks) before analysis and calculates optimal timeout. Results are included in preflightProbe response field.',
      },
    },
  },
};
