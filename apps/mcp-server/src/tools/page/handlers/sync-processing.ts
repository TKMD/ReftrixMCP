// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze 同期処理ロジック
 *
 * analyze.tool.ts から分離された executeSyncProcessing 関数。
 * MCP Tool handler（入力バリデーション・SSRF・async判定）は呼び出し元に残し、
 * ここでは同期モードの分析処理本体を担当する。
 *
 * v0.2.0: sync-helpers.ts / sync-phase-handlers.ts に分割。
 * このファイルはオーケストレーションのみを担当。
 *
 * @module tools/page/handlers/sync-processing
 */

import { logger, isDevelopment } from "../../../utils/logger";
import { sanitizeHtml } from "../../../utils/html-sanitizer";
import { extractCssUrls } from "../../../services/external-css-fetcher";

// Layout Handler (Phase2)
import { defaultAnalyzeLayout } from "./layout-handler";

// Result Builder
import { determineErrorCode } from "./result-builder";

// Motion Handler (Phase4)
import { defaultDetectMotion } from "./motion-handler";

// Quality Handler (Phase4)
import { defaultEvaluateQuality } from "./quality-handler";

// Types Handler
import type { LayoutServiceResult, MotionServiceResult, QualityServiceResult } from "./types";

import type { PageAnalyzeInput, PageAnalyzeOutput, AnalysisWarning } from "../schemas";

import { PAGE_ANALYZE_ERROR_CODES } from "../schemas";

// タイムアウトユーティリティ
import {
  withTimeoutAndTracking,
  distributeTimeout,
  ExecutionStatusTracker,
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

// Vision CPU完走保証 Phase 4: MCP進捗報告統合
import type { ProgressContext } from "../../../router";

// =====================================================
// ヘルパー・フェーズハンドラーからインポート
// =====================================================

// sync-helpers.ts
import {
  type SyncProcessingDeps,
  type FetchHtmlFunction,
  defaultFetchHtml,
  extractMetadata,
  computePreFetchConfig,
  fetchHtmlWithRetries,
} from "./sync-helpers";

// sync-phase-handlers.ts
import {
  handleDatabasePersistence,
  handleEmbeddingGeneration,
  handleMotionPersistenceExtras,
  handleNarrativePhase,
  handleResponsivePhase,
  buildPageAnalyzeResponse,
  integrateAnalysisResults,
} from "./sync-phase-handlers";

// Re-export SyncProcessingDeps for backward compatibility
export type { SyncProcessingDeps } from "./sync-helpers";

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
  // FetchHtmlFunction型に統一（defaultFetchHtmlはskipScreenshotを含む）
  const fetchHtml: FetchHtmlFunction =
    (service.fetchHtml as FetchHtmlFunction | undefined) ?? defaultFetchHtml;
  const analyzeLayout = service.analyzeLayout ?? defaultAnalyzeLayout;
  const detectMotion = service.detectMotion ?? defaultDetectMotion;
  const evaluateQuality = service.evaluateQuality ?? defaultEvaluateQuality;

  // =====================================================
  // 事前WebGL推定とPre-flight Probe（sync-helpers.ts）
  // =====================================================
  const preFetchConfig = await computePreFetchConfig(
    validated.url,
    validated.timeout,
    validated.auto_timeout
  );
  const { preDetection, probeResult, finalBaseTimeout } = preFetchConfig;

  // =====================================================
  // HTML取得（自動リトライ対応 — sync-helpers.ts）
  // =====================================================
  const fetchResult = await fetchHtmlWithRetries({
    url: validated.url,
    finalBaseTimeout,
    preDetection,
    validated,
    fetchHtml,
    probeResult,
  });

  if (!fetchResult.success) {
    return {
      success: false,
      error: {
        code: determineErrorCode(fetchResult.errorMessage),
        message: `${fetchResult.errorMessage} (after ${fetchResult.attemptCount} attempt${fetchResult.attemptCount > 1 ? "s" : ""})`,
      },
    };
  }

  const { html, fetchedTitle, fetchedDescription, fetchedScreenshot, fetchedComputedStyles } =
    fetchResult.result;

  // 外部CSS URLを抽出（サニタイズ前のHTMLから）
  const preExtractedCssUrls = extractCssUrls(html, normalizedUrl).map((u) => u.url);

  if (isDevelopment()) {
    logger.debug("[page.analyze] Pre-extracted external CSS URLs", {
      count: preExtractedCssUrls.length,
      urls: preExtractedCssUrls.slice(0, 5),
    });
  }

  // HTMLサニタイズ（XSS対策）
  const sanitizedHtml = sanitizeHtml(html, { preserveDocumentStructure: true });

  // メタデータ抽出（サニタイズ前のHTMLからメタデータを取得）
  const metadata = extractMetadata(html, fetchedTitle, fetchedDescription);

  // =====================================================
  // WebGL検出とタイムアウト調整
  // =====================================================
  const webglResult: LegacyWebGLDetectionResult = detectWebGL(html);
  const originalTimeout = validated.timeout ?? 60000;
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
  // Vision CPU完走保証: 早期ハードウェア検出とタイムアウト拡張
  // =====================================================
  const useVision = validated.layoutOptions?.useVision === true;
  let cpuTimeoutExtended = false;
  let cpuEffectiveTimeout = effectiveTimeout;
  let hardwareInfoForTimeout: HardwareInfoForTimeout | undefined;
  let detectedHardwareType: HardwareType = HardwareType.GPU;

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

      const screenshotSizeBytes = fetchedScreenshot
        ? Buffer.from(fetchedScreenshot, "base64").length
        : undefined;

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

      const cpuTimeoutResult =
        screenshotSizeBytes !== undefined
          ? calculateEffectiveTimeout({
              originalTimeout: effectiveTimeout,
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
      detectedHardwareType = HardwareType.CPU;

      logger.warn("[page.analyze] Early hardware detection failed, assuming CPU", {
        error: hwError instanceof Error ? hwError.message : "Unknown error",
      });

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

  // MCP 600秒ハードリミット対策
  const MCP_HARD_LIMIT_MS = 570000;
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
  // ExecutionStatusTracker初期化
  // =====================================================
  const timeoutStrategy = validated.timeout_strategy ?? "progressive";
  const partialResultsEnabled = validated.partial_results ?? true;

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
          vramBytes: 0,
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

  executionTracker.markCompleted("html");
  if (fetchedScreenshot) {
    executionTracker.markCompleted("screenshot");
  }

  // =====================================================
  // フェーズタイムアウト配分
  // =====================================================
  const features = validated.features ?? { layout: true, motion: true, quality: true };
  const warnings: AnalysisWarning[] = [];

  const hasFrameCapture = validated.motionOptions?.enable_frame_capture === true;
  const hasJsAnimation = validated.motionOptions?.detect_js_animations !== false;

  const webglMultiplier = webglResult.detected
    ? webglResult.confidence >= 0.9
      ? 2.5
      : webglResult.confidence >= 0.7
        ? 2.0
        : 1.5
    : 1.0;

  const effectiveWebglMultiplier = preDetection.isLikelyWebGL
    ? Math.max(webglMultiplier, preDetection.timeoutMultiplier)
    : webglMultiplier;

  const phaseTimeouts = distributeTimeout(
    finalEffectiveTimeout,
    hasFrameCapture,
    hasJsAnimation,
    {
      detected: webglResult.detected || preDetection.isLikelyWebGL,
      multiplier: effectiveWebglMultiplier,
    },
    hardwareInfoForTimeout
  );

  // Per-Phase Timeout Override
  if (validated.layoutTimeout !== undefined) {
    phaseTimeouts.layoutAnalysis = validated.layoutTimeout;
  }
  if (validated.motionTimeout !== undefined) {
    phaseTimeouts.motionDetection = validated.motionTimeout;
  }
  if (validated.qualityTimeout !== undefined) {
    phaseTimeouts.qualityEvaluation = validated.qualityTimeout;
  }

  executionTracker.setPhaseTimeouts({
    layout: phaseTimeouts.layoutAnalysis,
    motion: phaseTimeouts.motionDetection,
    quality: phaseTimeouts.qualityEvaluation,
  });

  if (isDevelopment()) {
    logger.debug("[page.analyze] Phase timeouts calculated", {
      originalTimeout,
      effectiveTimeout,
      finalEffectiveTimeout,
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
      cpuVisionExtension: {
        useVision,
        cpuTimeoutExtended,
        hardwareType: detectedHardwareType,
      },
    });
  }

  // =====================================================
  // 並列分析実行
  // =====================================================
  let layoutServiceResult: LayoutServiceResult | null = null;
  let motionServiceResult: MotionServiceResult | null = null;
  let qualityServiceResult: QualityServiceResult | null = null;

  // layout_first モード判定
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

  // layout_first モード時のタイムアウト再分配
  let effectivePhaseTimeouts = phaseTimeouts;
  if (useLayoutFirst) {
    const LAYOUT_FIRST_MOTION_TIMEOUT = 45000;
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
    const screenshotForVision = fetchedScreenshot
      ? { base64: fetchedScreenshot, mimeType: "image/png" }
      : undefined;

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
    let effectiveMotionOptions = validated.motionOptions;
    if (useLayoutFirst) {
      const userExplicitFetchExternalCss = validated.motionOptions?.fetchExternalCss;
      const effectiveFetchExternalCss = userExplicitFetchExternalCss === true ? true : false;

      effectiveMotionOptions = {
        ...validated.motionOptions,
        detect_js_animations: true,
        js_animation_options: {
          ...validated.motionOptions?.js_animation_options,
          enableCDP: false,
          enableWebAnimations: false,
          enableLibraryDetection: true,
          waitTime: 500,
        },
        fetchExternalCss: effectiveFetchExternalCss,
        maxPatterns: 50,
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

    const motionExtendedContext = useLayoutFirst ? { layoutFirstModeEnabled: true } : undefined;

    const motionPromise = detectMotion(
      sanitizedHtml,
      validated.url,
      effectiveMotionOptions,
      undefined,
      motionExtendedContext,
      preExtractedCssUrls
    );

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

  // 並列分析を実行
  try {
    await Promise.all(analysisPromises);
  } catch (error) {
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
  }

  // =====================================================
  // 結果統合（sync-phase-handlers.ts）
  // =====================================================
  const integrated = integrateAnalysisResults({
    layoutServiceResult,
    motionServiceResult,
    qualityServiceResult,
    validated,
    warnings,
  });

  const {
    layoutResult,
    motionResult,
    qualityResult,
    layoutServiceResultForSave,
    motionServiceResultForSave,
    qualityServiceResultForSave,
  } = integrated;

  // =====================================================
  // DB保存処理（sync-phase-handlers.ts）
  // =====================================================
  const layoutSaveToDb = validated.layoutOptions?.saveToDb !== false;
  const motionSaveToDb = validated.motionOptions?.saveToDb !== false;

  const dbResult = await handleDatabasePersistence({
    prisma: deps.getPrismaClient(),
    normalizedUrl,
    sanitizedHtml,
    metadata,
    fetchedScreenshot,
    validated,
    layoutSaveToDb,
    motionSaveToDb,
    layoutServiceResult: layoutServiceResultForSave,
    motionServiceResult: motionServiceResultForSave,
    qualityServiceResult: qualityServiceResultForSave,
    warnings,
  });

  const {
    savedWebPageId,
    savedSectionIdMapping,
    savedMotionPatternIdMapping,
    savedBackgroundDesignCount,
  } = dbResult;

  // layoutResultにpageIdを設定（保存成功時）
  if (savedWebPageId && layoutResult) {
    (layoutResult as { pageId?: string }).pageId = savedWebPageId;
  }

  // =====================================================
  // Embedding生成（sync-phase-handlers.ts）
  // =====================================================
  const autoAnalyze = validated.layoutOptions?.autoAnalyze !== false;

  await handleEmbeddingGeneration({
    autoAnalyze,
    layoutSaveToDb,
    motionSaveToDb,
    layoutServiceResult: layoutServiceResultForSave,
    motionServiceResult: motionServiceResultForSave,
    savedSectionIdMapping,
    savedMotionPatternIdMapping,
    savedWebPageId,
    validated,
    overallStartTime,
    warnings,
  });

  // =====================================================
  // VideoMode / JSアニメーション DB保存（sync-phase-handlers.ts）
  // =====================================================
  await handleMotionPersistenceExtras({
    motionSaveToDb,
    motionServiceResult: motionServiceResultForSave,
    savedWebPageId,
    validated,
    getPrismaClient: deps.getPrismaClient,
    warnings,
  });

  // =====================================================
  // Narrative分析（sync-phase-handlers.ts）
  // =====================================================
  const isSummary = validated.summary ?? true;
  const { narrativeResult } = await handleNarrativePhase({
    validated,
    html,
    fetchedScreenshot,
    savedWebPageId,
    layoutServiceResult: layoutServiceResultForSave,
    motionServiceResult: motionServiceResultForSave,
    overallStartTime,
    isSummary,
    warnings,
  });

  // =====================================================
  // Responsive分析（sync-phase-handlers.ts）
  // =====================================================
  const { responsiveAnalysisResult, responsiveAnalysisId } = await handleResponsivePhase({
    validated,
    savedWebPageId,
    overallStartTime,
    warnings,
  });

  // =====================================================
  // レスポンス構築（sync-phase-handlers.ts）
  // =====================================================
  const data = buildPageAnalyzeResponse({
    validated,
    normalizedUrl,
    metadata,
    overallStartTime,
    executionTracker,
    layoutResult,
    motionResult,
    qualityResult,
    narrativeResult,
    responsiveAnalysisResult,
    responsiveAnalysisId,
    layoutServiceResult: layoutServiceResultForSave,
    savedBackgroundDesignCount,
    probeResult,
    warnings,
  });

  if (isDevelopment()) {
    logger.info("[MCP Tool] page.analyze completed", {
      url: validated.url,
      hasLayout: !!layoutResult,
      hasMotion: !!motionResult,
      hasQuality: !!qualityResult,
      hasNarrative: !!narrativeResult,
      hasResponsive: !!responsiveAnalysisResult,
      backgroundDesignCount: data.backgroundDesigns?.count ?? 0,
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
