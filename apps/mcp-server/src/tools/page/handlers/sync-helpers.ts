// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze 同期処理ヘルパー
 *
 * sync-processing.ts から分離されたDI型定義、HTML取得、メタデータ抽出、リトライロジック。
 *
 * @module tools/page/handlers/sync-helpers
 */

import { logger, isDevelopment } from "../../../utils/logger";
import {
  pageIngestAdapter,
  type IngestResult,
  type ComputedStyleInfo,
} from "../../../services/page-ingest-adapter";

import { withTimeout } from "./timeout-utils";

// リトライ戦略
import {
  getRetryStrategy,
  shouldRetry,
  isNetworkError,
  calculateMaxTotalTime,
  type RetryStrategyConfig,
} from "./retry-strategy";

// WebGL事前推定
import { preDetectWebGL, detectSiteTier, type PreDetectionResult } from "./webgl-pre-detector";

// Pre-flight Probe Service
import { preflightProbeService, type ProbeResult } from "@reftrixmcp/webdesign-core";

import type { PageMetadata } from "../schemas";

import type { IPageAnalyzeService, IPageAnalyzePrismaClient } from "./types";

// =====================================================
// DI依存を受け取るインターフェース
// =====================================================

/**
 * executeSyncProcessing に必要なDI依存
 */
export interface SyncProcessingDeps {
  /** IPageAnalyzeService ファクトリ（DI） */
  getService: () => Partial<IPageAnalyzeService>;
  /** PrismaClient 取得関数（DI） */
  getPrismaClient: () => IPageAnalyzePrismaClient | null;
}

// =====================================================
// HTML取得結果の型
// =====================================================

export interface FetchHtmlResult {
  html: string;
  fetchedTitle: string | undefined;
  fetchedDescription: string | undefined;
  fetchedScreenshot: string | undefined;
  fetchedComputedStyles: ComputedStyleInfo[] | undefined;
}

// =====================================================
// Pre-fetch設定結果の型
// =====================================================

export interface PreFetchConfig {
  preDetection: PreDetectionResult;
  preAdjustedTimeout: number;
  probeResult: ProbeResult | null;
  finalBaseTimeout: number;
}

// =====================================================
// デフォルトサービス実装
// =====================================================

/**
 * デフォルトのHTML取得（PageIngestAdapter実装）
 * React/Vue/Next.js等のJS駆動サイトに対応するため、DOM安定化待機を使用
 */
export async function defaultFetchHtml(
  url: string,
  options: {
    timeout?: number | undefined;
    waitUntil?: "load" | "domcontentloaded" | "networkidle" | undefined;
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
    logger.debug("[page.analyze] defaultFetchHtml called", {
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
    domStableTimeout: 1000, // 1秒間DOMが安定するまで待機
    // ローディングアニメーション対応: 一般的なローディング要素を待機
    waitForSelectorHidden: '.loading, .loader, .loadingElement, [data-loading], [aria-busy="true"]',
    // コンテンツ要素の可視性待機: 実際のコンテンツ（見出し、セクション）が表示されるまで待機
    waitForContentVisible:
      "h1:not(.sr-only), h2:not(.sr-only), section:not(.sr-only), [data-section], article",
    // ユーザーインタラクション模倣: マウス移動でローディング解除するサイト対応
    simulateUserInteraction: true,
    // 追加の固定待機（アニメーション完了用）
    waitForTimeout: 3000, // 3秒に増加
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
    logger.debug("[page.analyze] defaultFetchHtml starting with timeout", {
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
    throw new Error(result.error || "Failed to fetch page");
  }

  if (isDevelopment()) {
    logger.debug("[page.analyze] defaultFetchHtml completed", {
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
export function extractMetadata(
  html: string,
  fetchedTitle?: string,
  fetchedDescription?: string
): PageMetadata {
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
    const descMatch = html.match(
      /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i
    );
    if (descMatch && descMatch[1]) {
      metadata.description = descMatch[1].trim();
    }
  }

  // OG image
  const ogImageMatch = html.match(
    /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i
  );
  if (ogImageMatch && ogImageMatch[1]) {
    try {
      new URL(ogImageMatch[1]);
      metadata.ogImage = ogImageMatch[1];
    } catch {
      // 無効なURLは無視
    }
  }

  // Favicon
  const faviconMatch = html.match(
    /<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i
  );
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

// =====================================================
// Pre-fetch設定（WebGL事前推定 + Pre-flight Probe）
// =====================================================

/**
 * HTML取得前の事前設定（WebGL推定、Pre-flight Probe、タイムアウト計算）
 */
export async function computePreFetchConfig(
  url: string,
  userTimeout: number | undefined,
  autoTimeout: boolean | undefined
): Promise<PreFetchConfig> {
  // WebGL事前推定
  const preDetection = preDetectWebGL(url);
  const preAdjustedTimeout = preDetection.isLikelyWebGL
    ? Math.min(
        (userTimeout ?? 120000) * preDetection.timeoutMultiplier,
        600000 // 最大10分
      )
    : (userTimeout ?? 120000);

  if (isDevelopment() && preDetection.isLikelyWebGL) {
    logger.info("[page.analyze] WebGL pre-detection triggered", {
      url,
      confidence: preDetection.confidence,
      matchedDomain: preDetection.matchedDomain,
      matchedPattern: preDetection.matchedPattern,
      originalTimeout: userTimeout,
      preAdjustedTimeout,
      timeoutMultiplier: preDetection.timeoutMultiplier,
    });
  }

  // Pre-flight Probe
  let probeResult: ProbeResult | null = null;
  let probeCalculatedTimeout = preAdjustedTimeout;

  if (autoTimeout === true) {
    try {
      if (isDevelopment()) {
        logger.info("[page.analyze] Pre-flight probe started", { url });
      }

      probeResult = await preflightProbeService.probe(url);

      const userTimeoutValue = userTimeout ?? 120000;
      probeCalculatedTimeout = Math.min(
        Math.max(probeResult.calculatedTimeoutMs, 30000),
        Math.max(userTimeoutValue, 600000)
      );

      if (isDevelopment()) {
        logger.info("[page.analyze] Pre-flight probe completed", {
          url,
          calculatedTimeoutMs: probeResult.calculatedTimeoutMs,
          complexityScore: probeResult.complexityScore,
          hasWebGL: probeResult.hasWebGL,
          hasSPA: probeResult.hasSPA,
          hasHeavyFramework: probeResult.hasHeavyFramework,
          probeCalculatedTimeout,
          userTimeout: userTimeoutValue,
          responseTimeMs: probeResult.responseTimeMs,
        });
      }
    } catch (probeError) {
      logger.warn("[page.analyze] Pre-flight probe failed, using fallback timeout", {
        url,
        error: probeError instanceof Error ? probeError.message : String(probeError),
        fallbackTimeout: preAdjustedTimeout,
      });
    }
  }

  const finalBaseTimeout =
    autoTimeout === true && probeResult ? probeCalculatedTimeout : preAdjustedTimeout;

  return {
    preDetection,
    preAdjustedTimeout,
    probeResult,
    finalBaseTimeout,
  };
}

// =====================================================
// HTML取得（自動リトライ対応）
// =====================================================

/**
 * fetchHtmlWithRetries に渡すfetchHtml関数の型
 * defaultFetchHtml と IPageAnalyzeService.fetchHtml の両方をカバー
 * exactOptionalPropertyTypes対応: 戻り値の optional プロパティに | undefined を含む
 */
export type FetchHtmlFunction = (
  url: string,
  options: {
    timeout?: number;
    waitUntil?: "load" | "domcontentloaded" | "networkidle";
    viewport?: { width: number; height: number };
    includeComputedStyles?: boolean;
    skipScreenshot?: boolean;
  }
) => Promise<{
  html: string;
  title?: string | undefined;
  description?: string | undefined;
  screenshot?: string | undefined;
  computedStyles?: ComputedStyleInfo[] | undefined;
}>;

export interface FetchHtmlWithRetriesParams {
  url: string;
  finalBaseTimeout: number;
  preDetection: PreDetectionResult;
  validated: {
    url: string;
    timeout?: number | undefined;
    waitUntil?: "load" | "domcontentloaded" | "networkidle" | undefined;
    auto_retry?: boolean | undefined;
    max_retries?: number | undefined;
    auto_timeout?: boolean | undefined;
    layoutOptions?:
      | {
          viewport?: { width: number; height: number } | undefined;
          useVision?: boolean | undefined;
          includeScreenshot?: boolean | undefined;
        }
      | undefined;
    motionOptions?:
      | {
          detect_js_animations?: boolean | undefined;
        }
      | undefined;
    narrativeOptions?:
      | {
          includeVision?: boolean | undefined;
        }
      | undefined;
  };
  fetchHtml: FetchHtmlFunction;
  probeResult: ProbeResult | null;
}

export interface FetchHtmlWithRetriesResult {
  success: true;
  result: FetchHtmlResult;
  skipScreenshot: boolean;
  siteTier: string;
}

export interface FetchHtmlWithRetriesFailure {
  success: false;
  errorMessage: string;
  attemptCount: number;
}

/**
 * リトライ付きHTML取得
 */
export async function fetchHtmlWithRetries(
  params: FetchHtmlWithRetriesParams
): Promise<FetchHtmlWithRetriesResult | FetchHtmlWithRetriesFailure> {
  const { url, finalBaseTimeout, preDetection, validated, fetchHtml, probeResult } = params;

  const viewport = validated.layoutOptions?.viewport;
  const useVision = validated.layoutOptions?.useVision === true;
  const useNarrativeVision = validated.narrativeOptions?.includeVision === true;
  const skipScreenshot =
    useVision || useNarrativeVision ? false : validated.layoutOptions?.includeScreenshot !== true;

  // サイト種別を検出してリトライ戦略を取得
  const siteTier = detectSiteTier(url, preDetection);
  const retryStrategy = getRetryStrategy(siteTier);

  const effectiveRetryStrategy: RetryStrategyConfig = {
    ...retryStrategy,
    autoRetry: validated.auto_retry ?? retryStrategy.autoRetry,
    maxRetries: validated.max_retries ?? retryStrategy.maxRetries,
  };

  // MCP 600秒上限チェック（警告ログ）
  const maxTotalTime = calculateMaxTotalTime(finalBaseTimeout, effectiveRetryStrategy);
  if (isDevelopment() && maxTotalTime > 600000) {
    logger.warn("[page.analyze] Max total time may exceed MCP 600s limit", {
      siteTier,
      baseTimeout: finalBaseTimeout,
      maxTotalTime,
      maxRetries: effectiveRetryStrategy.maxRetries,
      timeoutMultiplier: effectiveRetryStrategy.timeoutMultiplier,
      autoTimeout: validated.auto_timeout,
      probeUsed: probeResult !== null,
    });
  }

  const getRetryConfig = (
    attempt: number
  ): {
    timeout: number;
    waitUntil: "load" | "domcontentloaded" | "networkidle" | undefined;
  } => {
    if (attempt === 0) {
      return {
        timeout: finalBaseTimeout,
        waitUntil: validated.waitUntil !== "load" ? validated.waitUntil : undefined,
      };
    }

    const multiplier = Math.pow(effectiveRetryStrategy.timeoutMultiplier, attempt);
    const newTimeout = Math.min(Math.round(finalBaseTimeout * multiplier), 600000);

    return {
      timeout: newTimeout,
      waitUntil: "domcontentloaded" as const,
    };
  };

  let lastError: Error | null = null;
  const attemptCount = effectiveRetryStrategy.autoRetry ? effectiveRetryStrategy.maxRetries + 1 : 1;
  let attemptSucceeded = false;
  let html = "";
  let fetchedTitle: string | undefined;
  let fetchedDescription: string | undefined;
  let fetchedScreenshot: string | undefined;
  let fetchedComputedStyles: ComputedStyleInfo[] | undefined;

  if (isDevelopment()) {
    logger.info("[page.analyze] Retry strategy determined", {
      url,
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
      logger.info("[page.analyze] Retrying HTML fetch", {
        attempt: attempt + 1,
        maxAttempts: attemptCount,
        timeout: retryConfig.timeout,
        waitUntil: retryConfig.waitUntil ?? "load",
        previousError: lastError?.message,
        isNetworkError: lastError ? isNetworkError(lastError) : false,
      });
    }

    try {
      const fetchResult = await fetchHtml(url, {
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
        logger.info("[page.analyze] Retry succeeded", {
          attempt: attempt + 1,
          timeout: retryConfig.timeout,
          waitUntil: retryConfig.waitUntil ?? "load",
        });
      }

      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      logger.warn("[page.analyze] Fetch attempt failed", {
        attempt: attempt + 1,
        maxAttempts: attemptCount,
        error: lastError.message,
        url,
        isNetworkError: isNetworkError(lastError),
      });

      if (shouldRetry(lastError, attempt, effectiveRetryStrategy)) {
        await new Promise((resolve) =>
          setTimeout(resolve, effectiveRetryStrategy.waitBetweenRetriesMs)
        );
        continue;
      }

      break;
    }
  }

  if (!attemptSucceeded) {
    if (isDevelopment()) {
      logger.error("[MCP Tool] page.analyze fetch error (all retries failed)", {
        error: lastError,
        url,
        attempts: attemptCount,
      });
    }

    return {
      success: false,
      errorMessage: lastError?.message ?? "Failed to fetch page",
      attemptCount,
    };
  }

  return {
    success: true,
    result: {
      html,
      fetchedTitle,
      fetchedDescription,
      fetchedScreenshot,
      fetchedComputedStyles,
    },
    skipScreenshot,
    siteTier,
  };
}
