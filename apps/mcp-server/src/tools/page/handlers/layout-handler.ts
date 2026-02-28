// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze レイアウト分析ハンドラー
 *
 * analyze.tool.tsから抽出したレイアウト分析ロジック
 * - LayoutAnalyzerService を使用したHTML解析
 * - Vision API (Ollama + llama3.2-vision) による画像解析
 * - Per-Section Vision分析
 *
 * @module tools/page/handlers/layout-handler
 */

import { v7 as uuidv7 } from 'uuid';
import { logger, isDevelopment } from '../../../utils/logger';
import { getLayoutAnalyzerService, type LayoutAnalysisResult } from '../../../services/page/layout-analyzer.service';
import { SectionScreenshotService } from '../../../services/section-screenshot.service';
import { PAGE_ANALYZE_ERROR_CODES, type PageAnalyzeInput, type VisualFeatures } from '../schemas';
import type { VisionAnalysisResult, SectionBoundariesData } from '../../../services/vision-adapter';
import type { ComputedStyleInfo } from '../../../services/page-ingest-adapter';
import {
  type LayoutServiceResult,
  type CssFrameworkType,
  DEFAULT_SCREENSHOT,
  MAX_SECTIONS_FOR_PER_SECTION_VISION,
} from './types';
// Visual Feature Extraction Services (Phase 1 - Deterministic)
import { createColorExtractorService } from '../../../services/visual-extractor/color-extractor.service';
import { createThemeDetectorService } from '../../../services/visual-extractor/theme-detector.service';
import { createDensityCalculatorService } from '../../../services/visual-extractor/density-calculator.service';
import { createGradientDetectorService } from '../../../services/visual-extractor/gradient-detector.service';
import { createVisualFeatureMerger, type DeterministicExtractionInput } from '../../../services/visual-extractor/visual-feature-merger.service';
// CSS Variable Extraction (v0.1.0)
import { createCSSVariableExtractorService } from '../../../services/visual/css-variable-extractor.service';
// Background Design Detection
import { createBackgroundDesignDetectorService, type BackgroundDesignDetection } from '../../../services/background/background-design-detector.service';

// Vision CPU完走保証 (Phase 1-2 Services)
import { HardwareDetector, HardwareType } from '../../../services/vision/hardware-detector';
import { TimeoutCalculator } from '../../../services/vision/timeout-calculator';
import { ImageOptimizer } from '../../../services/vision/image-optimizer';
import type { VisionOptions } from '../schemas';

// Vision CPU完走保証 Phase 4: MCP進捗報告統合
import type { ProgressContext } from '../../../router';
import { createMCPProgressCallback, ProgressReporter } from '../../../services/vision/index';

// =====================================================
// 内部型定義
// =====================================================

/**
 * セクション型定義（mutable版 - perSectionVisionで後から更新されるため）
 */
type MutableSection = {
  id: string;
  type: string;
  positionIndex: number;
  heading?: string;
  confidence: number;
  htmlSnippet?: string;
  position?: { startY: number; endY: number; height: number };
  visionFeatures?: {
    success: boolean;
    features: Array<{
      type: string;
      confidence: number;
      description?: string;
    }>;
    textRepresentation?: string;
    error?: string;
    processingTimeMs: number;
    modelName: string;
    sectionBounds?: {
      startY: number;
      endY: number;
      height: number;
    };
  };
};

// =====================================================
// セクション統合処理（Phase 1: Vision統合）
// =====================================================

/**
 * Vision検出セクション境界をHTML検出結果と統合
 *
 * HTML解析で検出できなかったビジュアルセクションをVision分析結果から追加する。
 * - 既存セクションとの重複を除去（Y座標の50%以上重複で同一とみなす）
 * - Vision専用セクションは新規IDで追加
 * - 信頼度スコアを統合計算
 *
 * @param htmlSections - HTML解析で検出されたセクション
 * @param visionBoundaries - Vision分析で検出されたセクション境界
 * @returns 統合されたセクション配列
 */
function mergeVisionDetectedSections(
  htmlSections: MutableSection[],
  visionBoundaries: SectionBoundariesData | undefined
): MutableSection[] {
  if (!visionBoundaries || !visionBoundaries.sections || visionBoundaries.sections.length === 0) {
    if (isDevelopment()) {
      logger.debug('[layout-handler] mergeVisionDetectedSections: No vision boundaries to merge');
    }
    return htmlSections;
  }

  const mergedSections: MutableSection[] = [...htmlSections];
  let addedVisionSections = 0;
  let boostedSections = 0;

  for (const visionSection of visionBoundaries.sections) {
    const visionStartY = visionSection.startY;
    const visionEndY = visionSection.endY;
    const visionHeight = visionEndY - visionStartY;

    if (visionHeight <= 0) {
      continue;
    }

    // 既存セクションとの重複チェック
    let hasOverlap = false;
    let bestOverlapIndex = -1;
    let bestOverlapRatio = 0;

    for (let i = 0; i < mergedSections.length; i++) {
      const htmlSection = mergedSections[i];
      if (!htmlSection?.position) {
        continue;
      }

      const htmlStartY = htmlSection.position.startY;
      const htmlEndY = htmlSection.position.endY;

      // 重複領域を計算
      const overlapStartY = Math.max(visionStartY, htmlStartY);
      const overlapEndY = Math.min(visionEndY, htmlEndY);
      const overlapHeight = Math.max(0, overlapEndY - overlapStartY);

      // 重複率を計算（両方向で確認）
      const overlapRatioVision = overlapHeight / visionHeight;
      const overlapRatioHtml = overlapHeight / (htmlEndY - htmlStartY);
      const maxOverlapRatio = Math.max(overlapRatioVision, overlapRatioHtml);

      if (maxOverlapRatio > 0.5) {
        hasOverlap = true;
        if (maxOverlapRatio > bestOverlapRatio) {
          bestOverlapRatio = maxOverlapRatio;
          bestOverlapIndex = i;
        }
      }
    }

    if (hasOverlap && bestOverlapIndex >= 0) {
      // 既存セクションと重複: 信頼度をブースト
      const existingSection = mergedSections[bestOverlapIndex];
      if (existingSection) {
        // Vision検出で確認されたので信頼度を上げる（最大15%ブースト）
        const boostAmount = Math.min(0.15, visionSection.confidence * 0.2);
        existingSection.confidence = Math.min(1, existingSection.confidence + boostAmount);

        // セクションタイプがunknownの場合はVisionの結果で更新
        if (existingSection.type === 'unknown' && visionSection.type !== 'unknown') {
          existingSection.type = visionSection.type;
        }

        boostedSections++;
      }
    } else {
      // 新規Vision専用セクションとして追加
      const newSection: MutableSection = {
        id: uuidv7(),
        type: visionSection.type || 'unknown',
        positionIndex: mergedSections.length,
        confidence: visionSection.confidence * 0.85, // Vision検出は若干低めに設定
        position: {
          startY: visionStartY,
          endY: visionEndY,
          height: visionHeight,
        },
        // Vision検出セクションはHTMLスニペットなし（後で取得可能）
        visionFeatures: {
          success: true,
          features: [{
            type: 'section_boundaries',
            confidence: visionSection.confidence,
            description: `Vision-detected ${visionSection.type} section`,
          }],
          processingTimeMs: 0,
          modelName: 'llama3.2-vision',
        },
      };

      mergedSections.push(newSection);
      addedVisionSections++;
    }
  }

  // 位置インデックスを再計算（Y座標順にソート）
  mergedSections.sort((a, b) => {
    const aStartY = a.position?.startY ?? 0;
    const bStartY = b.position?.startY ?? 0;
    return aStartY - bStartY;
  });

  mergedSections.forEach((section, index) => {
    section.positionIndex = index;
  });

  if (isDevelopment()) {
    logger.info('[layout-handler] mergeVisionDetectedSections: completed', {
      originalHtmlSections: htmlSections.length,
      visionSections: visionBoundaries.sections.length,
      addedVisionSections,
      boostedSections,
      totalMergedSections: mergedSections.length,
    });
  }

  return mergedSections;
}

// =====================================================
// Deterministic Visual Feature Extraction (Phase 1)
// =====================================================

/**
 * スクリーンショットから決定論的なVisual Featuresを抽出
 *
 * 4つのサービスを使用して画像から特徴を抽出:
 * - ColorExtractor: 支配色・アクセントカラー抽出
 * - ThemeDetector: light/dark/mixed テーマ検出
 * - DensityCalculator: コンテンツ密度・ホワイトスペース計算
 * - GradientDetector: グラデーション検出
 *
 * @param screenshot - Base64エンコードされたスクリーンショット
 * @param computedStyles - Computed Styles（Playwrightから取得、optional）
 * @returns Visual Features（エラー時はundefined）
 */
async function extractDeterministicVisualFeatures(
  screenshot: { base64: string; mimeType: string },
  computedStyles?: ComputedStyleInfo[]
): Promise<VisualFeatures | undefined> {
  const startTime = Date.now();

  if (isDevelopment()) {
    logger.info('[layout-handler] extractDeterministicVisualFeatures: starting', {
      screenshotSize: screenshot.base64.length,
      mimeType: screenshot.mimeType,
    });
  }

  try {
    // Convert base64 to Buffer
    const imageBuffer = Buffer.from(screenshot.base64, 'base64');

    // Create service instances
    const colorExtractor = createColorExtractorService();
    const themeDetector = createThemeDetectorService();
    const densityCalculator = createDensityCalculatorService();
    const gradientDetector = createGradientDetectorService();
    const visualFeatureMerger = createVisualFeatureMerger();

    // Execute all deterministic extractions in parallel
    // Note: Theme detection uses computed styles if available for more accurate results
    const [colorResult, themeResult, densityResult, gradientResult] = await Promise.all([
      colorExtractor.extractColors(imageBuffer).catch((error) => {
        if (isDevelopment()) {
          logger.warn('[layout-handler] ColorExtractor failed', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
        return undefined;
      }),
      // Use detectThemeWithComputedStyles for more accurate theme detection
      // This prioritizes computed backgroundColor values from Playwright over screenshot analysis
      themeDetector.detectThemeWithComputedStyles(imageBuffer, computedStyles).catch((error) => {
        if (isDevelopment()) {
          logger.warn('[layout-handler] ThemeDetector failed', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
        return undefined;
      }),
      densityCalculator.calculateDensity(imageBuffer).catch((error) => {
        if (isDevelopment()) {
          logger.warn('[layout-handler] DensityCalculator failed', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
        return undefined;
      }),
      gradientDetector.detectGradient(imageBuffer).catch((error) => {
        if (isDevelopment()) {
          logger.warn('[layout-handler] GradientDetector failed', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
        return undefined;
      }),
    ]);

    // Check if at least one extraction succeeded
    if (!colorResult && !themeResult && !densityResult && !gradientResult) {
      if (isDevelopment()) {
        logger.warn('[layout-handler] All deterministic extractions failed');
      }
      return undefined;
    }

    // Prepare deterministic input for merger (used for metadata calculation)
    const deterministicInput: DeterministicExtractionInput = {};
    if (colorResult) deterministicInput.colors = colorResult;
    if (themeResult) deterministicInput.theme = themeResult;
    if (densityResult) deterministicInput.density = densityResult;

    // Merge deterministic results (no Vision AI input for now)
    // Note: We use merger for metadata calculation, but build visualFeatures directly
    // to avoid type incompatibility between MergedVisualFeatures and VisualFeatures
    const mergedFeatures = await visualFeatureMerger.merge(deterministicInput, null);

    // Build final VisualFeatures directly from service results
    // This avoids type incompatibility issues between Merger types and Schema types
    const visualFeatures: VisualFeatures = {
      // Colors: Build from colorResult directly
      colors: colorResult
        ? {
            dominant: colorResult.dominantColors,
            accent: colorResult.accentColors,
            palette: colorResult.colorPalette,
            source: 'deterministic' as const,
            confidence: 0.95,
          }
        : null,
      // Theme: Build from themeResult with luminance
      theme: themeResult
        ? {
            type: themeResult.theme,
            backgroundColor: themeResult.backgroundColor,
            textColor: themeResult.textColor,
            contrastRatio: themeResult.contrastRatio,
            luminance: themeResult.luminance,
            source: 'deterministic' as const,
            confidence: themeResult.confidence,
          }
        : null,
      // Density: Build from densityResult directly
      // Note: regions and metrics are optional in schema, and service types differ
      // from schema types, so we only include the core fields
      density: densityResult
        ? {
            contentDensity: densityResult.contentDensity,
            whitespaceRatio: densityResult.whitespaceRatio,
            visualBalance: densityResult.visualBalance,
            source: 'deterministic' as const,
            confidence: 0.95,
          }
        : null,
      // Mood and BrandTone: null for now (Phase 2 Vision AI features)
      mood: null,
      brandTone: null,
      // Metadata from merger
      metadata: mergedFeatures.metadata,
      // Gradient: Build from gradientResult directly
      gradient: gradientResult
        ? {
            hasGradient: gradientResult.hasGradient,
            gradients: gradientResult.gradients,
            dominantGradientType: gradientResult.dominantGradientType,
            confidence: gradientResult.confidence,
            processingTimeMs: gradientResult.processingTimeMs,
            source: 'deterministic' as const,
          }
        : null,
    };

    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[layout-handler] extractDeterministicVisualFeatures: completed', {
        processingTimeMs,
        hasColors: !!visualFeatures.colors,
        hasTheme: !!visualFeatures.theme,
        hasDensity: !!visualFeatures.density,
        hasGradient: !!visualFeatures.gradient,
        overallConfidence: visualFeatures.metadata?.overallConfidence,
      });
    }

    return visualFeatures;
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[layout-handler] extractDeterministicVisualFeatures failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        processingTimeMs: Date.now() - startTime,
      });
    }
    // Graceful degradation - return undefined, don't throw
    return undefined;
  }
}

// =====================================================
// Vision分析処理
// =====================================================

/**
 * Vision分析結果（セクション境界検出を含む）
 */
interface VisionAnalysisWithBoundaries {
  sectionBoundaries?: SectionBoundariesData;
}

/**
 * ページ全体のVision分析を実行（セクション境界検出を含む）
 *
 * Vision CPU完走保証 Phase 3:
 * - HardwareDetector: GPU/CPU自動判定（Ollama /api/ps API使用）
 * - TimeoutCalculator: ハードウェア・画像サイズに基づく動的タイムアウト
 * - ImageOptimizer: CPU推論向け画像最適化（リサイズ、圧縮）
 * - Graceful Degradation: タイムアウト時はHTML解析のみで続行
 *
 * @param screenshot - スクリーンショットデータ
 * @param result - レイアウト分析結果（更新される）
 * @param visionStartTime - Vision分析開始時刻
 * @param visionOptions - Vision CPU完走保証オプション（Phase 3）
 * @param progressContext - MCP進捗報告コンテキスト（Phase 4）
 * @returns セクション境界データ（HTMLセクションとのマージに使用）
 */
async function executePageVisionAnalysis(
  screenshot: { base64: string; mimeType: string },
  result: LayoutServiceResult,
  visionStartTime: number,
  visionOptions?: VisionOptions,
  progressContext?: ProgressContext
): Promise<VisionAnalysisWithBoundaries> {
  const analysisResult: VisionAnalysisWithBoundaries = {};

  // Vision CPU完走保証: デフォルトオプション
  const visionForceCpu = visionOptions?.visionForceCpu ?? false;
  const visionEnableProgress = visionOptions?.visionEnableProgress ?? false;
  const visionFallbackToHtmlOnly = visionOptions?.visionFallbackToHtmlOnly ?? true;
  const visionTimeoutMs = visionOptions?.visionTimeoutMs;
  // @ts-expect-error Phase 4予定: 最大画像サイズ制限で使用
  const _visionImageMaxSize = visionOptions?.visionImageMaxSize;

  // Vision CPU完走保証 Phase 4: 進捗報告セットアップ
  let progressReporter: ProgressReporter | null = null;
  if (visionEnableProgress && progressContext?.progressToken !== undefined) {
    const progressCallback = createMCPProgressCallback({
      progressToken: progressContext.progressToken,
      sendNotification: progressContext.sendNotification,
    });
    if (progressCallback) {
      // Vision分析の推定時間: CPU環境では180秒（3分）をデフォルトとする
      const estimatedTotalMs = visionOptions?.visionTimeoutMs ?? 180000;
      progressReporter = new ProgressReporter({ onProgress: progressCallback });
      progressReporter.start(estimatedTotalMs);
    }
  }

  try {
    const { LlamaVisionAdapter } = await import('../../../services/vision-adapter/index.js');
    const visionAdapter = new LlamaVisionAdapter();

    const isAvailable = await visionAdapter.isAvailable();
    if (isAvailable) {
      let imageBuffer = Buffer.from(screenshot.base64, 'base64');
      const mimeType = screenshot.mimeType as 'image/png' | 'image/jpeg' | 'image/webp';
      const originalImageSize = imageBuffer.length;

      // ================================================================
      // Vision CPU完走保証 Phase 1: ハードウェア検出
      // ================================================================
      const hardwareDetector = new HardwareDetector();
      let hardwareType = HardwareType.CPU; // デフォルトはCPU（安全側）
      let hardwareInfo: Awaited<ReturnType<HardwareDetector['detect']>> | null = null;

      try {
        hardwareInfo = await hardwareDetector.detect();
        hardwareType = visionForceCpu ? HardwareType.CPU : hardwareInfo.type;

        if (isDevelopment()) {
          logger.info('[layout-handler] Hardware detection completed', {
            detectedType: hardwareInfo.type,
            effectiveType: hardwareType,
            forceCpu: visionForceCpu,
            vramBytes: hardwareInfo.vramBytes,
            isGpuAvailable: hardwareInfo.isGpuAvailable,
          });
        }
      } catch (hwError) {
        // ハードウェア検出失敗時はCPUと仮定（安全側）
        if (isDevelopment()) {
          logger.warn('[layout-handler] Hardware detection failed, assuming CPU', {
            error: hwError instanceof Error ? hwError.message : 'Unknown error',
          });
        }
      }

      // Phase 4: 進捗報告 - ハードウェア検出完了 (5%)
      if (progressReporter) {
        progressReporter.updatePhase('preparing');
        progressReporter.updateProgress(5);
      }

      // ================================================================
      // Vision CPU完走保証 Phase 1: タイムアウト計算
      // ================================================================
      const timeoutCalculator = new TimeoutCalculator();
      const calculatedTimeout = visionTimeoutMs ?? timeoutCalculator.calculate(hardwareType, originalImageSize);

      if (isDevelopment()) {
        logger.info('[layout-handler] Vision timeout calculated', {
          hardwareType,
          imageSizeBytes: originalImageSize,
          calculatedTimeoutMs: calculatedTimeout,
          userOverride: visionTimeoutMs !== undefined,
          formatted: timeoutCalculator.formatTimeout(calculatedTimeout),
        });
      }

      // ================================================================
      // Vision CPU完走保証 Phase 2: 画像最適化（CPU時のみ）
      // ================================================================
      const imageOptimizer = new ImageOptimizer();
      let optimizationApplied = false;

      if (hardwareType === HardwareType.CPU) {
        try {
          const optimizeResult = await imageOptimizer.optimizeForCPU(imageBuffer, {
            hardwareType,
          });

          if (!optimizeResult.skipped) {
            // Buffer型の互換性を確保するため、新しいBufferとしてコピー
            imageBuffer = Buffer.from(optimizeResult.buffer);
            optimizationApplied = true;

            if (isDevelopment()) {
              logger.info('[layout-handler] Image optimization applied', {
                originalSize: optimizeResult.originalSizeBytes,
                optimizedSize: optimizeResult.optimizedSizeBytes,
                compressionRatio: optimizeResult.compressionRatio.toFixed(2),
                dimensions: optimizeResult.dimensions,
                processingTimeMs: optimizeResult.processingTimeMs,
              });
            }
          } else {
            if (isDevelopment()) {
              logger.debug('[layout-handler] Image optimization skipped', {
                reason: optimizeResult.reason,
              });
            }
          }
        } catch (optError) {
          // 最適化失敗時は元の画像を使用
          if (isDevelopment()) {
            logger.warn('[layout-handler] Image optimization failed, using original', {
              error: optError instanceof Error ? optError.message : 'Unknown error',
            });
          }
        }
      }

      // Phase 4: 進捗報告 - 画像最適化完了 (20%)
      if (progressReporter) {
        progressReporter.updatePhase('optimizing');
        progressReporter.updateProgress(20);
      }

      // ================================================================
      // Vision分析実行（タイムアウト付き）
      // ================================================================
      const analyzeWithTimeout = async (): Promise<VisionAnalysisResult> => {
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error(`Vision analysis timeout after ${calculatedTimeout}ms (${timeoutCalculator.formatTimeout(calculatedTimeout)})`));
          }, calculatedTimeout);

          visionAdapter
            .analyze({ imageBuffer, mimeType })
            .then((result) => {
              clearTimeout(timeoutId);
              resolve(result);
            })
            .catch((error) => {
              clearTimeout(timeoutId);
              reject(error);
            });
        });
      };

      // Phase 4: 進捗報告 - Vision分析開始 (30%)
      if (progressReporter) {
        progressReporter.updatePhase('analyzing');
        progressReporter.updateProgress(30);
      }

      try {
        const visionResult = await analyzeWithTimeout();
        const visionProcessingTimeMs = Date.now() - visionStartTime;

        // Phase 4: 進捗報告 - Vision分析完了 (70%)
        if (progressReporter) {
          progressReporter.updateProgress(70);
        }

        result.visionFeatures = {
          success: visionResult.success,
          features: visionResult.features.map((f) => {
            const desc = 'description' in f.data ? (f.data as { description?: string }).description : undefined;
            const feature: { type: string; confidence: number; description?: string } = {
              type: f.type,
              confidence: f.confidence,
            };
            if (desc !== undefined) {
              feature.description = desc;
            }
            return feature;
          }),
          processingTimeMs: visionProcessingTimeMs,
          modelName: visionResult.modelName,
          // Vision CPU完走保証: メタ情報を追加
          hardwareType,
          timeoutMs: calculatedTimeout,
          optimizationApplied,
        };

        result.textRepresentation = visionAdapter.generateTextRepresentation(visionResult);

        if (isDevelopment()) {
          logger.info('[layout-handler] Vision analysis completed', {
            featureCount: visionResult.features.length,
            processingTimeMs: visionProcessingTimeMs,
            textRepresentationLength: result.textRepresentation?.length,
            hardwareType,
            optimizationApplied,
          });
        }

        // Reftrix専用: セクション境界検出
        try {
          const boundaryStartTime = Date.now();
          const boundaryResult = await visionAdapter.detectSectionBoundaries({
            imageBuffer,
            mimeType,
          });

          if (boundaryResult.success && boundaryResult.data) {
            analysisResult.sectionBoundaries = boundaryResult.data;

            if (isDevelopment()) {
              logger.info('[layout-handler] Section boundary detection completed', {
                sectionCount: boundaryResult.data.sections?.length ?? 0,
                processingTimeMs: Date.now() - boundaryStartTime,
              });
            }
          } else {
            if (isDevelopment()) {
              logger.warn('[layout-handler] Section boundary detection failed', {
                error: boundaryResult.error,
              });
            }
          }
        } catch (boundaryError) {
          if (isDevelopment()) {
            logger.warn('[layout-handler] Section boundary detection error (non-critical)', {
              error: boundaryError instanceof Error ? boundaryError.message : 'Unknown error',
            });
          }
          // セクション境界検出エラーは非クリティカル - 続行
        }

        // Phase 4: 進捗報告 - セクション境界検出完了 (90%)
        if (progressReporter) {
          progressReporter.updatePhase('completing');
          progressReporter.updateProgress(90);
        }

        // Phase 4: 進捗報告 - 完了 (100%)
        if (progressReporter) {
          progressReporter.complete();
        }
      } catch (visionError) {
        // ================================================================
        // Vision CPU完走保証 Phase 3: Graceful Degradation
        // ================================================================
        const isTimeout = visionError instanceof Error && visionError.message.includes('timeout');

        if (isDevelopment()) {
          logger.warn('[layout-handler] Vision analysis failed', {
            error: visionError instanceof Error ? visionError.message : 'Unknown error',
            isTimeout,
            fallbackEnabled: visionFallbackToHtmlOnly,
          });
        }

        if (visionFallbackToHtmlOnly) {
          // Graceful Degradation: HTML解析のみで続行
          result.visionFeatures = {
            success: false,
            features: [],
            error: visionError instanceof Error ? visionError.message : 'Vision analysis failed',
            processingTimeMs: Date.now() - visionStartTime,
            modelName: 'llama3.2-vision',
            // Vision CPU完走保証: フォールバック情報
            fallback: true,
            fallbackReason: isTimeout ? 'timeout' : 'error',
            hardwareType,
            timeoutMs: calculatedTimeout,
          };

          // Phase 4: 進捗報告 - フォールバック完了 (100%)
          if (progressReporter) {
            progressReporter.updatePhase('completing');
            progressReporter.complete();
          }

          if (isDevelopment()) {
            logger.info('[layout-handler] Graceful Degradation: continuing with HTML analysis only');
          }
        } else {
          // フォールバック無効: エラーを再スロー
          throw visionError;
        }
      }
    } else {
      if (isDevelopment()) {
        logger.warn('[layout-handler] VisionAdapter not available, skipping Vision analysis');
      }

      result.visionFeatures = {
        success: false,
        features: [],
        error: 'Ollama service unavailable. Please ensure Ollama is running with llama3.2-vision model.',
        processingTimeMs: Date.now() - visionStartTime,
        modelName: 'llama3.2-vision',
      };

      // Phase 4: 進捗報告 - Ollama利用不可（100%で完了扱い）
      if (progressReporter) {
        progressReporter.updatePhase('completing');
        progressReporter.complete();
      }
    }
  } catch (visionError) {
    if (isDevelopment()) {
      logger.error('[layout-handler] Vision analysis failed', { error: visionError });
    }

    result.visionFeatures = {
      success: false,
      features: [],
      error: visionError instanceof Error ? visionError.message : 'Vision analysis failed',
      processingTimeMs: Date.now() - visionStartTime,
      modelName: 'llama3.2-vision',
    };

    // Phase 4: 進捗報告 - エラー終了（100%で完了扱い）
    if (progressReporter) {
      progressReporter.updatePhase('completing');
      progressReporter.complete();
    }
  }

  return analysisResult;
}

/**
 * Per-Section Vision分析を実行
 */
async function executePerSectionVisionAnalysis(
  screenshot: { base64: string; mimeType: string },
  sections: MutableSection[],
  options?: PageAnalyzeInput['layoutOptions']
): Promise<void> {
  const perSectionStartTime = Date.now();

  if (isDevelopment()) {
    logger.info('[layout-handler] Per-section Vision analysis: starting', {
      sectionCount: sections.length,
      batchSize: options?.visionBatchSize ?? 3,
    });
  }

  try {
    const screenshotService = new SectionScreenshotService();
    const batchSize = options?.visionBatchSize ?? 3;

    // セクション境界情報を収集
    const allSectionsWithBounds = sections
      .filter((s) => s.position?.startY !== undefined && s.position?.endY !== undefined)
      .map((s) => ({
        id: s.id,
        type: s.type,
        bounds: {
          startY: s.position!.startY,
          endY: s.position!.endY,
          height: s.position!.endY - s.position!.startY,
        },
      }));

    // メモリ保護: 最大セクション数に制限
    const sectionsWithBounds = allSectionsWithBounds.slice(0, MAX_SECTIONS_FOR_PER_SECTION_VISION);

    if (allSectionsWithBounds.length > MAX_SECTIONS_FOR_PER_SECTION_VISION) {
      logger.warn('[layout-handler] Per-section Vision analysis: section count exceeded limit', {
        totalSections: allSectionsWithBounds.length,
        processedSections: sectionsWithBounds.length,
        maxSections: MAX_SECTIONS_FOR_PER_SECTION_VISION,
        skippedSections: allSectionsWithBounds.length - sectionsWithBounds.length,
      });
    }

    if (sectionsWithBounds.length > 0) {
      if (isDevelopment()) {
        logger.debug('[layout-handler] Per-section Vision analysis: extracting sections', {
          sectionsWithBoundsCount: sectionsWithBounds.length,
        });
      }

      const extractResult = await screenshotService.extractMultipleSections(
        screenshot.base64,
        sectionsWithBounds.map((s) => ({ id: s.id, bounds: s.bounds }))
      );

      if (isDevelopment()) {
        logger.debug('[layout-handler] Per-section Vision analysis: extraction complete', {
          successCount: extractResult.successes.length,
          errorCount: extractResult.errors.length,
        });
      }

      const { LlamaVisionAdapter } = await import('../../../services/vision-adapter/index.js');
      const visionAdapter = new LlamaVisionAdapter();

      const isVisionAvailable = await visionAdapter.isAvailable();

      if (isVisionAvailable) {
        const totalBatches = Math.ceil(extractResult.successes.length / batchSize);

        for (let i = 0; i < extractResult.successes.length; i += batchSize) {
          const batch = extractResult.successes.slice(i, i + batchSize);
          const batchIndex = Math.floor(i / batchSize) + 1;

          if (isDevelopment()) {
            logger.info(`[layout-handler] Per-section Vision analysis: batch ${batchIndex}/${totalBatches}`, {
              batchSectionIds: batch.map((b) => b.sectionId),
            });
          }

          const visionResults = await Promise.allSettled(
            batch.map((ss) => {
              const sectionInfo = sectionsWithBounds.find((s) => s.id === ss.sectionId);
              const sectionType = sectionInfo?.type;
              if (sectionType !== undefined) {
                return visionAdapter.analyzeSection({
                  imageBuffer: ss.imageBuffer,
                  mimeType: 'image/png' as const,
                  features: ['layout_structure', 'color_palette', 'whitespace'] as const,
                  sectionId: ss.sectionId,
                  sectionTypeHint: sectionType,
                });
              }
              return visionAdapter.analyzeSection({
                imageBuffer: ss.imageBuffer,
                mimeType: 'image/png' as const,
                features: ['layout_structure', 'color_palette', 'whitespace'] as const,
                sectionId: ss.sectionId,
              });
            })
          );

          // 結果をセクションに紐付け
          for (let j = 0; j < batch.length; j++) {
            const batchItem = batch[j];
            if (!batchItem) continue;

            const sectionIndex = sections.findIndex((s) => s.id === batchItem.sectionId);
            if (sectionIndex >= 0) {
              const currentSection = sections[sectionIndex];
              if (!currentSection) continue;

              const visionResult = visionResults[j];
              if (!visionResult) continue;

              if (visionResult.status === 'fulfilled') {
                const vr = visionResult.value;
                currentSection.visionFeatures = {
                  success: vr.success,
                  features: vr.features.map((f) => {
                    const feature: { type: string; confidence: number; description?: string } = {
                      type: f.type,
                      confidence: f.confidence,
                    };
                    const featureData = f.data as unknown as Record<string, unknown> | undefined;
                    if (featureData && typeof featureData === 'object' && 'description' in featureData) {
                      feature.description = String(featureData.description);
                    }
                    return feature;
                  }),
                  textRepresentation: visionAdapter.generateSectionTextRepresentation(
                    vr,
                    currentSection.type
                  ),
                  processingTimeMs: vr.processingTimeMs,
                  modelName: vr.modelName,
                  sectionBounds: batchItem.bounds,
                };
              } else if (visionResult.status === 'rejected') {
                currentSection.visionFeatures = {
                  success: false,
                  features: [],
                  error: String(visionResult.reason),
                  processingTimeMs: 0,
                  modelName: 'llama3.2-vision',
                };
              }
            }
          }
        }
      } else {
        if (isDevelopment()) {
          logger.warn('[layout-handler] Per-section Vision analysis: Ollama not available');
        }

        for (const section of sections) {
          if (section.position) {
            section.visionFeatures = {
              success: false,
              features: [],
              error: 'Ollama service unavailable for per-section Vision analysis.',
              processingTimeMs: 0,
              modelName: 'llama3.2-vision',
            };
          }
        }
      }

      // 切り出し失敗したセクションの処理
      for (const extractError of extractResult.errors) {
        const sectionIndex = sections.findIndex((s) => s.id === extractError.sectionId);
        if (sectionIndex >= 0) {
          const failedSection = sections[sectionIndex];
          if (failedSection) {
            failedSection.visionFeatures = {
              success: false,
              features: [],
              error: `Screenshot extraction failed: ${extractError.errorMessage}`,
              processingTimeMs: 0,
              modelName: 'llama3.2-vision',
            };
          }
        }
      }
    }

    if (isDevelopment()) {
      const perSectionProcessingTime = Date.now() - perSectionStartTime;
      const successCount = sections.filter((s) => s.visionFeatures?.success).length;
      logger.info('[layout-handler] Per-section Vision analysis: completed', {
        totalSections: sections.length,
        processedSections: sectionsWithBounds.length,
        successCount,
        processingTimeMs: perSectionProcessingTime,
      });
    }
  } catch (perSectionError) {
    if (isDevelopment()) {
      logger.error('[layout-handler] Per-section Vision analysis failed', {
        error: perSectionError instanceof Error ? perSectionError.message : 'Unknown error',
      });
    }

    for (const section of sections) {
      if (section.position && !section.visionFeatures) {
        section.visionFeatures = {
          success: false,
          features: [],
          error: `Per-section analysis failed: ${perSectionError instanceof Error ? perSectionError.message : 'Unknown error'}`,
          processingTimeMs: 0,
          modelName: 'llama3.2-vision',
        };
      }
    }
  }
}

// =====================================================
// メインエクスポート関数
// =====================================================

/**
 * デフォルトのレイアウト分析
 *
 * @reftrix/webdesign-core の SectionDetector を使用した高精度なセクション検出
 * - セマンティック要素（header, nav, main, section, article, aside, footer）の検出
 * - class/id名ベースのヒューリスティックによるセクションタイプ推定
 * - グリッド/フレックスレイアウトの検出
 * - タイポグラフィ・色情報の抽出
 * - Vision API解析（useVision=true時、スクリーンショートから直接セクション検出）
 * - Computed Stylesのインラインスタイル適用（computedStyles指定時）
 *
 * @param html - 分析対象のHTML
 * @param options - レイアウト分析オプション
 * @param screenshot - Vision解析用スクリーンショート（useVision=true時に使用）
 * @param computedStyles - Computed Styles配列（PageIngestAdapterから取得、htmlSnippetにインラインスタイルとして適用）
 * @param baseUrl - ベースURL（外部CSS解決用）
 * @param preExtractedCssUrls - サニタイズ前のHTMLから抽出した外部CSS URL配列（DOMPurifyで<link>タグが除去される問題の回避策）
 * @param visionOptions - Vision CPU完走保証オプション
 * @param progressContext - MCP進捗報告コンテキスト（Vision CPU完走保証 Phase 4）
 * @param webPageId - 外部から渡されたwebPageId（asyncモードで一貫性を保証するため）
 */
export async function defaultAnalyzeLayout(
  html: string,
  options?: PageAnalyzeInput['layoutOptions'],
  screenshot?: { base64: string; mimeType: string },
  computedStyles?: ComputedStyleInfo[],
  baseUrl?: string,
  preExtractedCssUrls?: string[],
  visionOptions?: VisionOptions,
  progressContext?: ProgressContext,
  webPageId?: string
): Promise<LayoutServiceResult> {
  const startTime = Date.now();

  if (isDevelopment()) {
    logger.debug('[layout-handler] defaultAnalyzeLayout called', {
      htmlLength: html.length,
      hasOptions: !!options,
      useVision: options?.useVision,
      hasScreenshot: !!screenshot,
      hasComputedStyles: !!computedStyles,
      computedStylesCount: computedStyles?.length ?? 0,
      hasBaseUrl: !!baseUrl,
    });
  }

  try {
    const useVision = options?.useVision === true;
    const shouldFetchExternalCss = options?.fetchExternalCss ?? true;

    // LayoutAnalyzerService を使用してセクション検出（HTML解析）
    const layoutAnalyzer = getLayoutAnalyzerService();
    const analysisResult: LayoutAnalysisResult = await layoutAnalyzer.analyze(html, {
      includeContent: true,
      includeStyles: true,
      ...(shouldFetchExternalCss && baseUrl && {
        externalCss: {
          fetchExternalCss: true,
          baseUrl,
          // DOMPurifyで<link>タグが除去される問題の回避策
          // サニタイズ前のHTMLから抽出したURLを使用
          ...(preExtractedCssUrls && preExtractedCssUrls.length > 0 && {
            preExtractedUrls: preExtractedCssUrls,
          }),
        },
      }),
      // Computed StylesをhtmlSnippetにインラインスタイルとして適用
      ...(computedStyles && computedStyles.length > 0 && { computedStyles }),
    });

    // セクションを LayoutServiceResult 形式に変換
    const sections: MutableSection[] = analysisResult.sections.map(
      (section, index) => {
        const result: MutableSection = {
          id: section.id,
          type: section.type,
          positionIndex: index,
          confidence: section.confidence,
        };
        const headingText = section.content?.headings?.[0]?.text;
        if (headingText !== undefined) {
          result.heading = headingText;
        }
        if (section.htmlSnippet !== undefined) {
          result.htmlSnippet = section.htmlSnippet;
        }
        if (section.position) {
          result.position = {
            startY: section.position.startY,
            endY: section.position.endY,
            height: section.position.height,
          };
        }
        return result;
      }
    );

    const result: LayoutServiceResult = {
      success: true,
      sectionCount: analysisResult.sectionCount,
      sectionTypes: analysisResult.sectionTypes,
      processingTimeMs: analysisResult.processingTimeMs,
    };

    // cssSnippetが存在する場合は結果に含める（exactOptionalPropertyTypes対応）
    if (analysisResult.cssSnippet !== undefined && analysisResult.cssSnippet.length > 0) {
      result.cssSnippet = analysisResult.cssSnippet;

      if (isDevelopment()) {
        logger.debug('[layout-handler] CSS snippet extracted', {
          cssSnippetLength: analysisResult.cssSnippet.length,
        });
      }
    }

    if (analysisResult.externalCssContent !== undefined && analysisResult.externalCssContent.length > 0) {
      result.externalCssContent = analysisResult.externalCssContent;

      // v0.1.0: CSS変数抽出（外部CSSが取得された場合）
      // Webサイト構築時の参考データとして活用可能
      try {
        const cssVariableExtractor = createCSSVariableExtractorService();
        const combinedCss = [analysisResult.cssSnippet, analysisResult.externalCssContent]
          .filter(Boolean)
          .join('\n');
        const cssVariablesResult = cssVariableExtractor.extractFromCSS(combinedCss);

        if (cssVariablesResult.variables.length > 0 || cssVariablesResult.clampValues.length > 0) {
          result.cssVariables = cssVariablesResult;

          if (isDevelopment()) {
            logger.info('[layout-handler] CSS variables extracted', {
              variableCount: cssVariablesResult.variables.length,
              clampValueCount: cssVariablesResult.clampValues.length,
              calcExpressionCount: cssVariablesResult.calcExpressions.length,
              designTokensFramework: cssVariablesResult.designTokens.framework,
              processingTimeMs: cssVariablesResult.processingTimeMs,
            });
          }
        }
      } catch (error) {
        if (isDevelopment()) {
          logger.warn('[layout-handler] CSS variable extraction failed', { error });
        }
        // エラー時はcssVariablesを省略（Graceful Degradation）
      }
    }

    if (analysisResult.externalCssMeta !== undefined) {
      result.externalCssMeta = analysisResult.externalCssMeta;
    }

    // cssFrameworkが存在する場合は結果に含める（exactOptionalPropertyTypes対応）
    if (isDevelopment()) {
      logger.debug('[layout-handler] Checking cssFramework from analysisResult', {
        hasCssFramework: analysisResult.cssFramework !== undefined,
        cssFrameworkValue: analysisResult.cssFramework,
      });
    }

    if (analysisResult.cssFramework !== undefined) {
      result.cssFramework = {
        framework: analysisResult.cssFramework.framework as CssFrameworkType,
        confidence: analysisResult.cssFramework.confidence,
        evidence: analysisResult.cssFramework.evidence,
      };

      if (isDevelopment()) {
        logger.debug('[layout-handler] CSS framework detected and set', {
          framework: analysisResult.cssFramework.framework,
          confidence: analysisResult.cssFramework.confidence,
          evidenceCount: analysisResult.cssFramework.evidence.length,
          resultCssFramework: result.cssFramework,
        });
      }
    } else {
      if (isDevelopment()) {
        logger.warn('[layout-handler] cssFramework is undefined in analysisResult');
      }
    }

    // Background Design Detection
    // CSSコンテンツから背景デザインパターンを検出（Graceful Degradation）
    let backgroundDesigns: BackgroundDesignDetection[] = [];
    try {
      const bgDetector = createBackgroundDesignDetectorService();
      const bgResult = bgDetector.detect({
        cssContent: analysisResult.cssSnippet ?? '',
        htmlContent: html,
        externalCssContent: analysisResult.externalCssContent ?? '',
      });
      backgroundDesigns = bgResult.backgrounds;

      if (isDevelopment() && backgroundDesigns.length > 0) {
        logger.info('[layout-handler] Background designs detected', {
          count: backgroundDesigns.length,
          types: backgroundDesigns.map((bg) => bg.designType),
          processingTimeMs: bgResult.processingTimeMs.toFixed(1),
        });
      }
    } catch (bgError) {
      if (isDevelopment()) {
        logger.warn('[layout-handler] Background design detection failed', {
          error: bgError instanceof Error ? bgError.message : String(bgError),
        });
      }
      // Graceful Degradation: 背景デザイン検出失敗はpage.analyzeを中断しない
    }

    // 検出された背景デザインを結果に含める
    if (backgroundDesigns.length > 0) {
      result.backgroundDesigns = backgroundDesigns;
    }

    // Vision解析実行（useVision=true かつ スクリーンショートがある場合）
    let visionAnalysisResult: VisionAnalysisWithBoundaries = {};

    if (useVision && screenshot) {
      const visionStartTime = Date.now();

      if (isDevelopment()) {
        logger.info('[layout-handler] Starting Vision analysis', {
          screenshotSize: screenshot.base64.length,
          mimeType: screenshot.mimeType,
        });
      }

      visionAnalysisResult = await executePageVisionAnalysis(screenshot, result, visionStartTime, visionOptions, progressContext);
    } else if (useVision && !screenshot) {
      if (isDevelopment()) {
        logger.warn('[layout-handler] useVision=true but no screenshot available, falling back to HTML analysis');
      }

      result.visionFeatures = {
        success: false,
        features: [],
        error: 'Screenshot not available for Vision analysis. Falling back to HTML analysis.',
        processingTimeMs: 0,
        modelName: 'llama3.2-vision',
      };
    }

    // Phase 1: Vision検出セクション境界とHTML検出セクションをマージ
    const mergedSections = mergeVisionDetectedSections(sections, visionAnalysisResult.sectionBoundaries);

    // マージ結果を更新（sectionCount, sectionTypesも更新）
    if (mergedSections.length !== sections.length) {
      result.sectionCount = mergedSections.length;

      // sectionTypesを再計算
      const updatedSectionTypes: Record<string, number> = {};
      for (const section of mergedSections) {
        updatedSectionTypes[section.type] = (updatedSectionTypes[section.type] ?? 0) + 1;
      }
      result.sectionTypes = updatedSectionTypes;

      if (isDevelopment()) {
        logger.info('[layout-handler] Sections merged with Vision boundaries', {
          originalCount: sections.length,
          mergedCount: mergedSections.length,
          addedSections: mergedSections.length - sections.length,
        });
      }
    }

    // Phase 1: Deterministic Visual Feature Extraction (Screenshot必須)
    // Note: computedStyles are passed for improved theme detection
    // This allows accurate detection of dark themes from CSS-in-JS/Tailwind
    if (useVision && screenshot) {
      const visualFeaturesStartTime = Date.now();

      if (isDevelopment()) {
        logger.info('[layout-handler] Starting Deterministic Visual Feature Extraction', {
          screenshotSize: screenshot.base64.length,
          hasComputedStyles: !!computedStyles,
          computedStylesCount: computedStyles?.length ?? 0,
        });
      }

      const visualFeatures = await extractDeterministicVisualFeatures(screenshot, computedStyles);

      if (visualFeatures) {
        result.visualFeatures = visualFeatures;

        if (isDevelopment()) {
          logger.info('[layout-handler] Deterministic Visual Features extracted', {
            hasDominantColors: !!visualFeatures.colors?.dominant?.length,
            hasAccentColors: !!visualFeatures.colors?.accent?.length,
            hasTheme: !!visualFeatures.theme,
            themeType: visualFeatures.theme?.type,
            hasDensity: !!visualFeatures.density,
            hasGradients: !!visualFeatures.gradient?.gradients?.length,
            processingTimeMs: Date.now() - visualFeaturesStartTime,
          });
        }
      } else {
        if (isDevelopment()) {
          logger.warn('[layout-handler] Deterministic Visual Feature Extraction failed, continuing without visualFeatures');
        }
      }
    }

    // オプションに応じて詳細を追加
    // MCP-RESP-03: snake_case (include_html) を優先し、camelCase (includeHtml) はフォールバック
    const shouldIncludeHtml = options?.include_html ?? options?.includeHtml;
    const shouldIncludeScreenshot = options?.include_screenshot ?? options?.includeScreenshot;

    if (shouldIncludeHtml) {
      result.html = html;
    }

    if (shouldIncludeScreenshot) {
      result.screenshot = {
        base64: 'placeholder',
        format: DEFAULT_SCREENSHOT.FORMAT,
        width: DEFAULT_SCREENSHOT.WIDTH,
        height: DEFAULT_SCREENSHOT.HEIGHT,
      };
    }

    if (options?.saveToDb) {
      // webPageIdが外部から渡された場合はそれを使用（asyncモードでの一貫性保証）
      // 渡されていない場合は新規生成
      result.pageId = webPageId ?? uuidv7();
    }

    // sections は summary=false の場合に返す（マージ後のセクションを使用）
    result.sections = mergedSections;

    // Per-Section Vision Analysis (perSectionVision=true の場合)
    // マージ後のセクションを使用して各セクションの詳細Vision分析を実行
    if (useVision && options?.perSectionVision && screenshot?.base64 && mergedSections.length > 0) {
      await executePerSectionVisionAnalysis(screenshot, mergedSections, options);
    }

    // 最終処理時間を更新（Vision解析含む）
    result.processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.debug('[layout-handler] defaultAnalyzeLayout completed', {
        sectionCount: result.sectionCount,
        sectionTypes: result.sectionTypes,
        processingTimeMs: result.processingTimeMs,
        hasVisionFeatures: !!result.visionFeatures,
        hasTextRepresentation: !!result.textRepresentation,
      });
    }

    return result;
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[layout-handler] defaultAnalyzeLayout error', { error });
    }

    return {
      success: false,
      sectionCount: 0,
      sectionTypes: {},
      processingTimeMs: Date.now() - startTime,
      error: {
        code: PAGE_ANALYZE_ERROR_CODES.LAYOUT_ANALYSIS_FAILED,
        message: error instanceof Error ? error.message : 'Layout analysis failed',
      },
    };
  }
}
