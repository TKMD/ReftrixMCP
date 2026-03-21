// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze 同期処理ロジック
 *
 * analyze.tool.ts から分離された executeSyncProcessing 関数。
 * MCP Tool handler（入力バリデーション・SSRF・async判定）は呼び出し元に残し、
 * ここでは同期モードの分析処理本体を担当する。
 *
 * @module tools/page/handlers/sync-processing
 */

import { v7 as uuidv7 } from "uuid";
import { logger, isDevelopment } from "../../../utils/logger";
import { normalizeUrlForStorage } from "../../../utils/url-normalizer";
import { validateExternalUrl } from "../../../utils/url-validator";
import { sanitizeHtml } from "../../../utils/html-sanitizer";
import { isUrlAllowedByRobotsTxt } from "@reftrixmcp/core";
import {
  pageIngestAdapter,
  type IngestResult,
  type ComputedStyleInfo,
} from "../../../services/page-ingest-adapter";
import { extractCssUrls } from "../../../services/external-css-fetcher";

// Responsive Analysis Services
import {
  responsiveAnalysisService,
  responsivePersistenceService,
  type ResponsiveAnalysisResult,
} from "../../../services/responsive";

// Embedding統合用インポート
import {
  generateSectionEmbeddings,
  generateMotionEmbeddings,
  type SectionDataForEmbedding,
  type MotionPatternForEmbedding,
} from "./embedding-handler";

// DB保存ロジック
import {
  saveToDatabase,
  type SectionForSave,
  type MotionPatternForSave,
  type BackgroundDesignForSave,
} from "./db-handler";

// Layout Handler (Phase2)
import { defaultAnalyzeLayout } from "./layout-handler";

// Result Builder (Phase3)
import {
  determineErrorCode,
  buildLayoutResult,
  buildMotionResult,
  buildQualityResult,
  buildNarrativeResult,
  buildBackgroundDesignsSummary,
  extractWarning,
} from "./result-builder";

// Narrative Handler (v0.1.0)
import { handleNarrativeAnalysis } from "./narrative-handler";
import type { NarrativeHandlerInput, NarrativeHandlerResult } from "./types";

// Motion Handler (Phase4)
import { defaultDetectMotion } from "./motion-handler";

// JS Animation Handler（DB保存用 + Embedding生成）
import {
  mapJSAnimationResultToPatterns,
  saveJSAnimationPatternsWithEmbeddings,
} from "./js-animation-handler";

// Quality Handler (Phase4)
import { defaultEvaluateQuality } from "./quality-handler";

// Types Handler（共通型定義）
import type {
  LayoutServiceResult,
  MotionServiceResult,
  QualityServiceResult,
  IPageAnalyzeService,
  IPageAnalyzePrismaClient,
} from "./types";

// VideoMode DB保存用ヘルパー（同期/非同期モード共有）
import { saveFrameAnalysisToDb } from "../../../services/motion/frame-analysis-save.helper";

import type {
  PageAnalyzeInput,
  PageAnalyzeOutput,
  PageAnalyzeData,
  LayoutResult,
  MotionResult,
  QualityResult,
  NarrativeResult,
  PageMetadata,
  AnalysisWarning,
} from "../schemas";

import { PAGE_ANALYZE_ERROR_CODES } from "../schemas";

// タイムアウトユーティリティ
import {
  withTimeout,
  PhaseTimeoutError,
  distributeTimeout,
  ExecutionStatusTracker,
  withTimeoutAndTracking,
  calculateEffectiveTimeout,
  HardwareType,
  type HardwareInfoForTimeout,
} from "./timeout-utils";

// Vision CPU完走保証 Phase 4: 早期ハードウェア検出
import { HardwareDetector } from "../../../services/vision/hardware-detector";

// WebGL検出ユーティリティ
import {
  detectWebGL,
  adjustTimeoutForWebGL,
  type LegacyWebGLDetectionResult,
} from "./webgl-detector";

// WebGL事前推定
import { preDetectWebGL, detectSiteTier } from "./webgl-pre-detector";

// Pre-flight Probe Service
import { preflightProbeService, type ProbeResult } from "@reftrixmcp/webdesign-core";

// リトライ戦略
import {
  getRetryStrategy,
  shouldRetry,
  isNetworkError,
  calculateMaxTotalTime,
} from "./retry-strategy";

// Vision CPU完走保証 Phase 4: MCP進捗報告統合
import type { ProgressContext } from "../../../router";

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
// デフォルトサービス実装
// =====================================================

/**
 * デフォルトのHTML取得（PageIngestAdapter実装）
 * React/Vue/Next.js等のJS駆動サイトに対応するため、DOM安定化待機を使用
 */
async function defaultFetchHtml(
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
function extractMetadata(
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
// メイン同期処理関数
// =====================================================

/**
 * page.analyze 同期処理の本体
 *
 * pageAnalyzeHandler から分離され、570秒ハードタイムアウトガードで保護される。
 * 入力バリデーション・SSRF・async mode 判定は呼び出し元で完了済み。
 *
 * @param validated - バリデーション済みの入力
 * @param normalizedUrl - SSRF検証済みの正規化URL
 * @param overallStartTime - 処理開始時刻（ms）
 * @param deps - DI依存（サービスファクトリ、Prismaクライアント）
 * @param progressContext - MCP進捗報告コンテキスト
 */
export async function executeSyncProcessing(
  validated: PageAnalyzeInput,
  normalizedUrl: string,
  overallStartTime: number,
  deps: SyncProcessingDeps,
  progressContext?: ProgressContext
): Promise<PageAnalyzeOutput> {
  // サービス取得
  const service = deps.getService();
  const fetchHtml = service.fetchHtml ?? defaultFetchHtml;
  const analyzeLayout = service.analyzeLayout ?? defaultAnalyzeLayout;
  const detectMotion = service.detectMotion ?? defaultDetectMotion;
  const evaluateQuality = service.evaluateQuality ?? defaultEvaluateQuality;

  // HTML取得結果（リトライループで設定される）
  // attemptSucceeded=true の場合のみ有効な値が入る
  let html = ""; // TypeScript definite assignment のため初期化
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
    : (validated.timeout ?? 120000);

  if (isDevelopment() && preDetection.isLikelyWebGL) {
    logger.info("[page.analyze] WebGL pre-detection triggered", {
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
        logger.info("[page.analyze] Pre-flight probe started", { url: validated.url });
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
        logger.info("[page.analyze] Pre-flight probe completed", {
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
      logger.warn("[page.analyze] Pre-flight probe failed, using fallback timeout", {
        url: validated.url,
        error: probeError instanceof Error ? probeError.message : String(probeError),
        fallbackTimeout: preAdjustedTimeout,
      });
      // probeResultはnullのまま、probeCalculatedTimeoutはpreAdjustedTimeoutのまま
    }
  }

  // auto_timeout=falseまたはプローブ失敗時はpreAdjustedTimeoutを使用
  const finalBaseTimeout =
    validated.auto_timeout === true && probeResult ? probeCalculatedTimeout : preAdjustedTimeout;

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
  const skipScreenshot =
    useVision || useNarrativeVision
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

  /**
   * リトライ設定を取得
   * @param attempt 試行回数（0-indexed）
   */
  const getRetryConfig = (
    attempt: number
  ): {
    timeout: number;
    waitUntil: "load" | "domcontentloaded" | "networkidle" | undefined;
  } => {
    // 1回目: 元の設定（auto_timeout時はprobeで計算されたタイムアウト）
    if (attempt === 0) {
      return {
        timeout: finalBaseTimeout,
        waitUntil: validated.waitUntil !== "load" ? validated.waitUntil : undefined,
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
      waitUntil: "domcontentloaded" as const,
    };
  };

  let lastError: Error | null = null;
  const attemptCount = effectiveRetryStrategy.autoRetry ? effectiveRetryStrategy.maxRetries + 1 : 1;
  let attemptSucceeded = false;

  if (isDevelopment()) {
    logger.info("[page.analyze] Retry strategy determined", {
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
        logger.info("[page.analyze] Retry succeeded", {
          attempt: attempt + 1,
          timeout: retryConfig.timeout,
          waitUntil: retryConfig.waitUntil ?? "load",
        });
      }

      break; // 成功したらループを抜ける
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      logger.warn("[page.analyze] Fetch attempt failed", {
        attempt: attempt + 1,
        maxAttempts: attemptCount,
        error: lastError.message,
        url: validated.url,
        isNetworkError: isNetworkError(lastError),
      });

      // shouldRetry で次の試行を判定
      if (shouldRetry(lastError, attempt, effectiveRetryStrategy)) {
        // 待機時間を挟む
        await new Promise((resolve) =>
          setTimeout(resolve, effectiveRetryStrategy.waitBetweenRetriesMs)
        );
        continue;
      }

      // リトライしない場合はループを抜ける
      break;
    }
  }

  // 全試行失敗
  if (!attemptSucceeded) {
    if (isDevelopment()) {
      logger.error("[MCP Tool] page.analyze fetch error (all retries failed)", {
        error: lastError,
        url: validated.url,
        attempts: attemptCount,
      });
    }

    const errorMessage = lastError?.message ?? "Failed to fetch page";

    return {
      success: false,
      error: {
        code: determineErrorCode(errorMessage),
        message: `${errorMessage} (after ${attemptCount} attempt${attemptCount > 1 ? "s" : ""})`,
      },
    };
  }

  // 外部CSS URLを抽出（サニタイズ前のHTMLから）
  // DOMPurifyで<link>タグが除去される問題の回避策
  const preExtractedCssUrls = extractCssUrls(html, normalizedUrl).map((u) => u.url);

  if (isDevelopment()) {
    logger.debug("[page.analyze] Pre-extracted external CSS URLs", {
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
    logger.info("[page.analyze] WebGL content detected", {
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
  // useVisionは既に上で定義済み
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
        logger.info("[page.analyze] Early hardware detection for Vision CPU timeout", {
          hardwareType: hardwareInfo.type,
          vramBytes: hardwareInfo.vramBytes,
          isGpuAvailable: hardwareInfo.isGpuAvailable,
          useVision,
        });
      }

      // CPU環境かつVision有効時はタイムアウト拡張を計算
      const screenshotSizeBytes = fetchedScreenshot
        ? Buffer.from(fetchedScreenshot, "base64").length
        : undefined;

      // HardwareInfoForTimeout: imageSizeBytesはオプショナル
      hardwareInfoForTimeout =
        screenshotSizeBytes !== undefined
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
      const cpuTimeoutResult =
        screenshotSizeBytes !== undefined
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
          logger.info("[page.analyze] CPU Vision timeout extended", {
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

      logger.warn("[page.analyze] Early hardware detection failed, assuming CPU", {
        error: hwError instanceof Error ? hwError.message : "Unknown error",
      });

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
    logger.info("[page.analyze] finalEffectiveTimeout capped to MCP hard limit", {
      rawFinalEffectiveTimeout,
      cappedTo: MCP_HARD_LIMIT_MS,
      cpuTimeoutExtended,
    });
  }

  // =====================================================
  // ExecutionStatusTracker初期化（v0.1.0）
  // Vision CPU完走保証 Phase 4: cpuModeExtended, hardwareInfoを追加
  // =====================================================

  const timeoutStrategy = validated.timeout_strategy ?? "progressive";
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
  executionTracker.markCompleted("html");

  // スクリーンショット取得成功を記録（取得できた場合）
  if (fetchedScreenshot) {
    executionTracker.markCompleted("screenshot");
  }

  // 並列分析処理
  const features = validated.features ?? { layout: true, motion: true, quality: true };
  const warnings: AnalysisWarning[] = [];

  // タイムアウト配分を計算（調整後のタイムアウトを使用）
  // 注意: enable_frame_capture はデフォルトで false
  // detect_js_animations / detect_webgl_animations はデフォルトで true (v0.1.0)
  // タイムアウト分配もこのデフォルト値を反映する必要がある
  const hasFrameCapture = validated.motionOptions?.enable_frame_capture === true; // デフォルト false
  const hasJsAnimation = validated.motionOptions?.detect_js_animations !== false; // デフォルト true (v0.1.0)

  // WebGL乗数を計算（adjustTimeoutForWebGLと同じロジック）
  // v0.1.0: JSアニメーション検出有効時にモーション検出タイムアウトも延長
  const webglMultiplier = webglResult.detected
    ? webglResult.confidence >= 0.9
      ? 2.5
      : webglResult.confidence >= 0.7
        ? 2.0
        : 1.5
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
    logger.debug("[page.analyze] Phase timeouts calculated", {
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
  const layoutFirstMode = validated.layout_first ?? "auto";
  const useLayoutFirst =
    layoutFirstMode === "always" ||
    (layoutFirstMode === "auto" && (webglResult.detected || preDetection.isLikelyWebGL));

  if (isDevelopment() && useLayoutFirst) {
    logger.info("[page.analyze] layout_first mode activated", {
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
      logger.info("[page.analyze] layout_first: timeout reallocation", {
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
      ? { base64: fetchedScreenshot, mimeType: "image/png" }
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
        "layout-analysis",
        "layout",
        executionTracker,
        warnings
      ).then((result) => {
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
          enableCDP: false, // CDP無効（高速化）
          enableWebAnimations: false, // Web Animations API無効（高速化）
          enableLibraryDetection: true, // ライブラリ検出のみ有効
          waitTime: 500, // 短縮待機
        },
        // CSS解析は維持（高速）
        // v0.1.0: ユーザーが明示的に指定した場合は尊重、それ以外はデフォルトfalse（タイムアウト防止）
        fetchExternalCss: effectiveFetchExternalCss,
        maxPatterns: 50, // パターン数制限（メモリ節約）
      };

      if (isDevelopment()) {
        logger.info("[page.analyze] layout_first: motion detection using lightweight mode", {
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
    const motionExtendedContext = useLayoutFirst ? { layoutFirstModeEnabled: true } : undefined;

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
        "motion-detection",
        "motion",
        executionTracker,
        warnings
      ).then((result) => {
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
        "quality-evaluation",
        "quality",
        executionTracker,
        warnings
      ).then((result) => {
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
    if (timeoutStrategy === "strict") {
      const errorMessage = error instanceof Error ? error.message : "Analysis failed";
      logger.error("[page.analyze] Strict strategy: analysis failed", {
        error: errorMessage,
        executionStatus: executionTracker.toExecutionStatus(),
      });
      return {
        success: false,
        error: {
          code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
          message: "Analysis failed due to timeout or internal error",
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
    const warning = extractWarning("layout", layoutServiceResult);
    if (warning) warnings.push(warning);
  }

  // Motion結果の処理
  // Note: TypeScript control flow analysis doesn't track Promise.then() assignments,
  // so we use explicit type assertion after the truthy check
  if (motionServiceResult !== null) {
    const motion = motionServiceResult as MotionServiceResult;
    motionServiceResultForSave = motion;
    motionResult = buildMotionResult(motion, isSummary);
    const warning = extractWarning("motion", motion);
    if (warning) warnings.push(warning);

    // WebGL/Canvas検出警告（patternCount=0件 かつ detect_js_animations=false の場合）
    const detectJsAnimations = validated.motionOptions?.detect_js_animations ?? true; // v0.1.0: デフォルトtrue
    if (motion.patternCount === 0 && detectJsAnimations === false) {
      warnings.push({
        feature: "motion",
        code: "WEBGL_DETECTION_DISABLED",
        message:
          "WebGL/Canvas animations may not be detected with current settings. Enable motionOptions.detect_js_animations: true for Three.js, GSAP, Lottie detection.",
      });
      if (isDevelopment()) {
        logger.info("[MCP Tool] page.analyze WebGL detection warning added", {
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
    const warning = extractWarning("quality", qualityServiceResult);
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
    const prisma = deps.getPrismaClient();

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
        logger.debug("[page.analyze] CSS info from layout analysis", {
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
        logger.debug("[page.analyze] sectionsForSave preparation", {
          hasSections: !!layoutServiceResultForSave?.sections,
          sectionCount: layoutServiceResultForSave?.sections?.length ?? 0,
          pageCssFrameworkDetails: pageCssFramework
            ? {
                framework: pageCssFramework.framework,
                confidence: pageCssFramework.confidence,
                evidenceCount: pageCssFramework.evidence?.length ?? 0,
              }
            : null,
        });
      }
      const sectionsForSave: SectionForSave[] =
        layoutServiceResultForSave?.sections?.map((section) => {
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
            const visionFeatures: SectionForSave["visionFeatures"] = {
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
        const sectionsWithCssFramework = sectionsForSave.filter(
          (s) => s.cssFramework !== undefined
        );
        logger.debug("[page.analyze] sectionsForSave created", {
          totalSections: sectionsForSave.length,
          sectionsWithCssFramework: sectionsWithCssFramework.length,
          firstSectionCssFramework: sectionsForSave[0]?.cssFramework ?? "not set",
          firstSectionHasCssFrameworkMeta: !!sectionsForSave[0]?.cssFrameworkMeta,
        });
      }

      // motionPatternsをDB保存用に変換
      const motionPatternsForSave: MotionPatternForSave[] =
        motionServiceResultForSave?.patterns?.map((pattern) => ({
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
        logger.debug("[page.analyze] visualFeatures from layout analysis", {
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
          usageScope: validated.usageScope ?? "inspiration_only",
        }));

      const saveResult = await saveToDatabase(prisma, {
        url: normalizeUrlForStorage(normalizedUrl),
        title: metadata.title,
        htmlContent: sanitizedHtml,
        screenshot: fetchedScreenshot,
        sourceType: validated.sourceType ?? "user_provided",
        usageScope: validated.usageScope ?? "inspiration_only",
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
          logger.info("[page.analyze] DB save completed", {
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
          feature: "layout", // DB保存はlayout機能の一部として扱う
          code: PAGE_ANALYZE_ERROR_CODES.DB_SAVE_FAILED,
          message: saveResult.error ?? "Failed to save to database",
        });

        if (isDevelopment()) {
          logger.warn("[page.analyze] DB save failed (graceful degradation)", {
            error: saveResult.error,
          });
        }
      }
    } else {
      // PrismaClientが未設定の場合はスキップ（Graceful Degradation）
      logger.warn("[page.analyze] DB save skipped: database connection not configured");
      warnings.push({
        feature: "layout",
        code: PAGE_ANALYZE_ERROR_CODES.DB_NOT_CONFIGURED,
        message: "DB save skipped: database connection not configured. Data will not be persisted.",
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

  if (
    autoAnalyze &&
    layoutSaveToDb &&
    layoutServiceResultForSave?.success &&
    layoutServiceResultForSave.sections &&
    savedSectionIdMapping &&
    savedSectionIdMapping.size > 0
  ) {
    // ページレベルのvisualFeaturesを取得（Phase 3-3: visualFeatures伝播）
    const pageVisualFeaturesForEmbedding = layoutServiceResultForSave.visualFeatures;

    // sectionsにvisualFeaturesを伝播してSectionDataForEmbedding[]を作成
    // db-handler.tsと同様に、ページレベルのvisualFeaturesを各セクションに適用
    const sectionsWithVisualFeatures: SectionDataForEmbedding[] =
      layoutServiceResultForSave.sections.map((section) => {
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
      logger.debug("[page.analyze] Propagating visualFeatures to sections for embedding", {
        sectionCount: sectionsWithVisualFeatures.length,
        hasPageVisualFeatures: !!pageVisualFeaturesForEmbedding,
        pageVisualFeaturesKeys: pageVisualFeaturesForEmbedding
          ? Object.keys(pageVisualFeaturesForEmbedding)
          : [],
      });
    }

    // 分離されたハンドラーを呼び出し（visualFeatures伝播済みのセクションを渡す）
    // MCP 600秒ガード: 残り時間が不足していればスキップ
    const sectionEmbeddingRemaining = Math.max(0, 570000 - (Date.now() - overallStartTime));
    if (sectionEmbeddingRemaining < 10000) {
      warnings.push({
        feature: "layout",
        code: "EMBEDDING_SKIPPED",
        message: `Section embedding generation skipped: insufficient time remaining (${sectionEmbeddingRemaining}ms)`,
      });
    } else {
      try {
        await withTimeout(
          generateSectionEmbeddings(sectionsWithVisualFeatures, savedSectionIdMapping, {
            webPageId: savedWebPageId,
          }),
          Math.min(60000, sectionEmbeddingRemaining),
          "section-embedding-generation"
        );
      } catch (embeddingError) {
        const msg =
          embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
        warnings.push({
          feature: "layout",
          code: "EMBEDDING_TIMEOUT",
          message: `Section embedding generation failed: ${msg}`,
        });
        logger.warn("[page.analyze] Section embedding generation failed", { error: msg });
      }
    }
  }

  // MotionEmbedding生成・保存（saveToDb=true かつ IDマッピングがある場合）
  // ロジックはembedding-handler.tsに分離
  // 注意: db-handler.tsでMotionPatternは既に保存済み。ここではEmbedding生成・保存のみ実行
  if (
    motionSaveToDb &&
    motionServiceResultForSave?.success &&
    motionServiceResultForSave.patterns &&
    savedMotionPatternIdMapping &&
    savedMotionPatternIdMapping.size > 0
  ) {
    const patterns = motionServiceResultForSave.patterns as MotionPatternForEmbedding[];

    // 分離されたハンドラーを呼び出し（motionPatternIdMappingを渡してEmbedding生成のみ実行）
    // MCP 600秒ガード: 残り時間が不足していればスキップ
    const motionEmbeddingRemaining = Math.max(0, 570000 - (Date.now() - overallStartTime));
    if (motionEmbeddingRemaining < 10000) {
      warnings.push({
        feature: "motion",
        code: "EMBEDDING_SKIPPED",
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
          "motion-embedding-generation"
        );
      } catch (embeddingError) {
        const msg =
          embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
        warnings.push({
          feature: "motion",
          code: "EMBEDDING_TIMEOUT",
          message: `Motion embedding generation failed: ${msg}`,
        });
        logger.warn("[page.analyze] Motion embedding generation failed", { error: msg });
      }
    }
  }

  // =====================================================
  // VideoMode DB保存処理（motionOptions.saveToDb=true かつ frame_analysis あり）
  // =====================================================
  // 共有ヘルパー関数でフレーム画像分析結果（AnimationZone, LayoutShift, MotionVector）を保存
  // MotionDbService は Embedding を自動生成するため、明示的な生成は不要
  if (motionSaveToDb && motionServiceResultForSave?.success) {
    const frameAnalysis = motionServiceResultForSave.frame_analysis;
    if (frameAnalysis && savedWebPageId) {
      const frameAnalysisSaveResult = await saveFrameAnalysisToDb({
        frameAnalysis,
        frameCapture: motionServiceResultForSave.frame_capture,
        webPageId: savedWebPageId,
        sourceUrl: validated.url,
      });

      // 保存失敗時はwarningsに記録（Graceful Degradation）
      if (!frameAnalysisSaveResult.saved) {
        if (frameAnalysisSaveResult.error) {
          warnings.push({
            feature: "motion",
            code: "FRAME_ANALYSIS_DB_SAVE_ERROR",
            message: frameAnalysisSaveResult.error,
          });
        } else if (frameAnalysisSaveResult.skipped) {
          if (isDevelopment()) {
            logger.warn("[page.analyze] Frame analysis DB save skipped", {
              reason: frameAnalysisSaveResult.skipped,
            });
          }
        } else if (frameAnalysisSaveResult.batchResult?.reason) {
          warnings.push({
            feature: "motion",
            code: "FRAME_ANALYSIS_DB_SAVE_FAILED",
            message: frameAnalysisSaveResult.batchResult.reason,
          });
        }
      }
    }

    // =====================================================
    // JSアニメーションパターン DB保存処理（saveToDb=true かつ js_animations あり）
    // =====================================================
    // JSアニメーション検出結果をJSAnimationPatternテーブルに保存
    const jsAnimations = motionServiceResultForSave?.js_animations;
    const jsAnimationPrisma = deps.getPrismaClient();
    if (jsAnimations && savedWebPageId && jsAnimationPrisma) {
      try {
        if (isDevelopment()) {
          logger.info("[page.analyze] Starting JS animation patterns DB save", {
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
            logger.info("[page.analyze] JS animation patterns DB save completed", {
              savedPatternCount: saveResult.savedPatternCount,
              embeddingCount: saveResult.embeddingCount,
              totalPatterns: jsAnimationPatterns.length,
              webPageId: savedWebPageId,
            });
          }
        }
      } catch (jsAnimDbError) {
        // JSアニメーションDB保存失敗（Graceful Degradation）
        logger.warn("[page.analyze] JS animation patterns DB save failed (graceful degradation)", {
          error: jsAnimDbError instanceof Error ? jsAnimDbError.message : "Unknown error",
        });

        warnings.push({
          feature: "motion",
          code: "JS_ANIMATION_DB_SAVE_ERROR",
          message:
            jsAnimDbError instanceof Error ? jsAnimDbError.message : "JS animation DB save failed",
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
      logger.info("[page.analyze] Starting narrative analysis", {
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
          feature: "quality",
          code: "NARRATIVE_SKIPPED",
          message: `Narrative analysis skipped: insufficient time remaining (${narrativeRemaining}ms)`,
        });
        if (isDevelopment()) {
          logger.warn("[page.analyze] Narrative analysis skipped due to insufficient time", {
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
          "narrative-analysis"
        );
      }

      if (narrativeHandlerResult?.success && narrativeHandlerResult.narrative) {
        narrativeResult = buildNarrativeResult(narrativeHandlerResult, isSummary);

        if (isDevelopment() && narrativeResult) {
          logger.info("[page.analyze] Narrative analysis completed", {
            moodCategory: narrativeResult.worldView?.moodCategory,
            confidence: narrativeResult.confidence,
            processingTimeMs: narrativeHandlerResult.processingTimeMs,
            savedId: narrativeHandlerResult.savedId,
          });
        }
      } else if (narrativeHandlerResult?.skipped) {
        if (isDevelopment()) {
          logger.debug("[page.analyze] Narrative analysis skipped (enabled=false)");
        }
      } else if (narrativeHandlerResult?.error) {
        // Narrative分析失敗は警告として記録し、他の分析結果は返す
        // NOTE: narrativeはfeature enumに含まれていないため、コード + メッセージのみ記録
        warnings.push({
          feature: "quality", // narrativeはQuality系機能として分類
          code: narrativeHandlerResult.error.code,
          message: `Narrative analysis failed: ${narrativeHandlerResult.error.message}`,
        });

        if (isDevelopment()) {
          logger.warn("[page.analyze] Narrative analysis failed", {
            code: narrativeHandlerResult.error.code,
            message: narrativeHandlerResult.error.message,
          });
        }
      }
    } catch (narrativeError) {
      // タイムアウトまたは予期しないエラーは警告として記録
      const isTimeout = narrativeError instanceof PhaseTimeoutError;
      const errorMessage =
        narrativeError instanceof Error ? narrativeError.message : String(narrativeError);
      warnings.push({
        feature: "quality", // narrativeはQuality系機能として分類
        code: isTimeout ? "NARRATIVE_TIMEOUT" : "NARRATIVE_UNEXPECTED_ERROR",
        message: isTimeout
          ? `Narrative analysis timed out: ${errorMessage}`
          : `Unexpected error in narrative analysis: ${errorMessage}`,
      });

      if (isDevelopment()) {
        logger.error("[page.analyze] Unexpected narrative analysis error", {
          error: errorMessage,
        });
      }
    }
  }

  // =====================================================
  // 注: ExecutionStatus更新はwithTimeoutAndTracking内で自動的に行われる
  // markCompleted/markFailedがPromise完了/失敗時に呼び出される
  // =====================================================

  // =====================================================
  // レスポンシブ分析（responsiveOptions.enabled=true の場合）
  // =====================================================
  let responsiveAnalysisResult: ResponsiveAnalysisResult | undefined;
  let responsiveAnalysisId: string | undefined;

  if (validated.responsiveOptions?.enabled === true) {
    const responsiveRemaining = Math.max(0, 570000 - (Date.now() - overallStartTime));
    if (responsiveRemaining < 15000) {
      warnings.push({
        feature: "layout",
        code: "RESPONSIVE_SKIPPED",
        message: `Responsive analysis skipped: insufficient time remaining (${responsiveRemaining}ms)`,
      });
    } else {
      try {
        // SSRF対策: URLを検証
        const urlValidation = validateExternalUrl(validated.url);
        if (!urlValidation.valid) {
          warnings.push({
            feature: "layout",
            code: "RESPONSIVE_SSRF_BLOCKED",
            message: `レスポンシブ分析スキップ: ${urlValidation.error}`,
          });
        } else {
          // robots.txt チェック
          const robotsResult = await isUrlAllowedByRobotsTxt(
            validated.url,
            validated.respect_robots_txt
          );
          if (!robotsResult.allowed) {
            warnings.push({
              feature: "layout",
              code: "RESPONSIVE_ROBOTS_BLOCKED",
              message: `レスポンシブ分析スキップ: robots.txtによりブロック (${robotsResult.reason})`,
            });
          } else {
            if (isDevelopment()) {
              logger.info("[page.analyze] Starting responsive analysis", {
                url: validated.url,
                viewports: validated.responsiveOptions.viewports?.map((v) => v.name) ?? [
                  "desktop",
                  "tablet",
                  "mobile",
                ],
              });
            }

            // crawl-delay を取得（秒→ミリ秒変換、上限30秒）
            const MAX_CRAWL_DELAY_MS = 30000;
            const crawlDelayMs =
              robotsResult.crawlDelay !== undefined
                ? Math.min(robotsResult.crawlDelay * 1000, MAX_CRAWL_DELAY_MS)
                : undefined;

            // レスポンシブ分析オプションを構築
            const responsiveOpts: {
              enabled: boolean;
              viewports?: Array<{ name: string; width: number; height: number }>;
              include_screenshots?: boolean;
              include_diff_images?: boolean;
              diff_threshold?: number;
              detect_navigation?: boolean;
              detect_visibility?: boolean;
              detect_layout?: boolean;
              crawlDelayMs?: number;
            } = { enabled: true };

            if (validated.responsiveOptions.viewports !== undefined) {
              responsiveOpts.viewports = validated.responsiveOptions.viewports;
            }
            if (validated.responsiveOptions.include_screenshots !== undefined) {
              responsiveOpts.include_screenshots = validated.responsiveOptions.include_screenshots;
            }
            if (validated.responsiveOptions.include_diff_images !== undefined) {
              responsiveOpts.include_diff_images = validated.responsiveOptions.include_diff_images;
            }
            if (validated.responsiveOptions.diff_threshold !== undefined) {
              responsiveOpts.diff_threshold = validated.responsiveOptions.diff_threshold;
            }
            if (validated.responsiveOptions.detect_navigation !== undefined) {
              responsiveOpts.detect_navigation = validated.responsiveOptions.detect_navigation;
            }
            if (validated.responsiveOptions.detect_visibility !== undefined) {
              responsiveOpts.detect_visibility = validated.responsiveOptions.detect_visibility;
            }
            if (validated.responsiveOptions.detect_layout !== undefined) {
              responsiveOpts.detect_layout = validated.responsiveOptions.detect_layout;
            }
            if (crawlDelayMs !== undefined) {
              responsiveOpts.crawlDelayMs = crawlDelayMs;
            }

            responsiveAnalysisResult = await withTimeout(
              responsiveAnalysisService.analyze(validated.url, responsiveOpts),
              Math.min(responsiveRemaining, 120000), // 最大2分
              "responsive-analysis"
            );

            if (isDevelopment()) {
              logger.info("[page.analyze] Responsive analysis completed", {
                viewportsAnalyzed: responsiveAnalysisResult.viewportsAnalyzed.length,
                differencesFound: responsiveAnalysisResult.differences.length,
                breakpointsDetected: responsiveAnalysisResult.breakpoints.length,
                analysisTimeMs: responsiveAnalysisResult.analysisTimeMs,
              });
            }

            // DB保存（save_to_db=true かつ webPageIdがある場合）
            const responsiveSaveToDb = validated.responsiveOptions.save_to_db ?? true;
            if (responsiveSaveToDb && savedWebPageId) {
              try {
                responsiveAnalysisId = await responsivePersistenceService.save(
                  savedWebPageId,
                  responsiveAnalysisResult
                );

                if (isDevelopment()) {
                  logger.info("[page.analyze] Responsive analysis saved to DB", {
                    responsiveAnalysisId,
                    webPageId: savedWebPageId,
                  });
                }
              } catch (responsiveDbError) {
                logger.warn("[page.analyze] Responsive DB save failed (graceful degradation)", {
                  error:
                    responsiveDbError instanceof Error
                      ? responsiveDbError.message
                      : "Unknown error",
                });
                warnings.push({
                  feature: "layout",
                  code: "RESPONSIVE_DB_SAVE_FAILED",
                  message:
                    responsiveDbError instanceof Error
                      ? responsiveDbError.message
                      : "Responsive DB save failed",
                });
              }
            }
          }
        }
      } catch (responsiveError) {
        const isTimeout = responsiveError instanceof PhaseTimeoutError;
        const errorMessage =
          responsiveError instanceof Error ? responsiveError.message : String(responsiveError);
        warnings.push({
          feature: "layout",
          code: isTimeout ? "RESPONSIVE_TIMEOUT" : "RESPONSIVE_ERROR",
          message: isTimeout
            ? `Responsive analysis timed out: ${errorMessage}`
            : `Responsive analysis failed: ${errorMessage}`,
        });

        if (isDevelopment()) {
          logger.warn("[page.analyze] Responsive analysis failed (graceful degradation)", {
            error: errorMessage,
          });
        }
      }
    }
  }

  // レスポンス構築
  const data: PageAnalyzeData = {
    id: uuidv7(),
    url: validated.url,
    normalizedUrl,
    metadata,
    source: {
      type: validated.sourceType ?? "user_provided",
      usageScope: validated.usageScope ?? "inspiration_only",
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

  // レスポンシブ分析結果を追加（responsiveOptions.enabled=true時のみ）
  if (responsiveAnalysisResult) {
    // ResponsiveDifference[] → Zodスキーマ互換の型に変換（passthrough index signature対応）
    const differences = responsiveAnalysisResult.differences.map((d) => ({
      element: d.element,
      description: d.description,
      category: d.category,
      ...(d.desktop !== undefined ? { desktop: d.desktop } : {}),
      ...(d.tablet !== undefined ? { tablet: d.tablet } : {}),
      ...(d.mobile !== undefined ? { mobile: d.mobile } : {}),
    }));

    const responsiveData: NonNullable<PageAnalyzeData["responsiveAnalysis"]> = {
      viewportsAnalyzed: responsiveAnalysisResult.viewportsAnalyzed.map((v) => v.name),
      differences,
      breakpoints: responsiveAnalysisResult.breakpoints,
      analysisTimeMs: responsiveAnalysisResult.analysisTimeMs,
    };
    if (responsiveAnalysisId) {
      responsiveData.responsiveAnalysisId = responsiveAnalysisId;
    }
    data.responsiveAnalysis = responsiveData;
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
    logger.info("[MCP Tool] page.analyze completed", {
      url: validated.url,
      hasLayout: !!layoutResult,
      hasMotion: !!motionResult,
      hasQuality: !!qualityResult,
      hasNarrative: !!narrativeResult,
      hasResponsive: !!responsiveAnalysisResult,
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
