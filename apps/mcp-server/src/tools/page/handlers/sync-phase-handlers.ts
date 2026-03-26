// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze 同期処理フェーズハンドラー
 *
 * sync-processing.ts から分離された個別フェーズのハンドリングロジック。
 * DB保存、Embedding生成、Narrative分析、Responsive分析、レスポンス構築を担当。
 *
 * @module tools/page/handlers/sync-phase-handlers
 */

import { v7 as uuidv7 } from "uuid";
import { logger, isDevelopment } from "../../../utils/logger";
import { normalizeUrlForStorage } from "../../../utils/url-normalizer";
import { validateExternalUrl } from "../../../utils/url-validator";
import { sanitizeErrorMessage } from "../../../utils/sanitize-error";
import { isUrlAllowedByRobotsTxt } from "@reftrixmcp/core";

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

// Result Builder
import {
  buildLayoutResult,
  buildMotionResult,
  buildQualityResult,
  buildNarrativeResult,
  buildBackgroundDesignsSummary,
  extractWarning,
} from "./result-builder";

// Narrative Handler
import { handleNarrativeAnalysis } from "./narrative-handler";
import type { NarrativeHandlerInput, NarrativeHandlerResult } from "./types";

// JS Animation Handler
import {
  mapJSAnimationResultToPatterns,
  saveJSAnimationPatternsWithEmbeddings,
} from "./js-animation-handler";

// VideoMode DB保存用ヘルパー
import { saveFrameAnalysisToDb } from "../../../services/motion/frame-analysis-save.helper";

// Timeout
import { withTimeout, PhaseTimeoutError } from "./timeout-utils";

import { PAGE_ANALYZE_ERROR_CODES } from "../schemas";
import type {
  PageAnalyzeInput,
  PageAnalyzeData,
  LayoutResult,
  MotionResult,
  QualityResult,
  NarrativeResult,
  PageMetadata,
  AnalysisWarning,
} from "../schemas";

import type {
  LayoutServiceResult,
  MotionServiceResult,
  QualityServiceResult,
  IPageAnalyzePrismaClient,
} from "./types";

import type { ProbeResult } from "@reftrixmcp/webdesign-core";
import type { ExecutionStatusTracker } from "./timeout-utils";

// =====================================================
// DB保存処理
// =====================================================

export interface DatabasePersistenceParams {
  prisma: IPageAnalyzePrismaClient | null;
  normalizedUrl: string;
  sanitizedHtml: string;
  metadata: PageMetadata;
  fetchedScreenshot: string | undefined;
  validated: PageAnalyzeInput;
  layoutSaveToDb: boolean;
  motionSaveToDb: boolean;
  layoutServiceResult: LayoutServiceResult | undefined;
  motionServiceResult: MotionServiceResult | undefined;
  qualityServiceResult: QualityServiceResult | undefined;
  warnings: AnalysisWarning[];
}

export interface DatabasePersistenceResult {
  savedWebPageId: string | undefined;
  savedSectionIdMapping: Map<string, string> | undefined;
  savedMotionPatternIdMapping: Map<string, string> | undefined;
  savedBackgroundDesignCount: number;
}

/**
 * DB保存処理（セクション、モーションパターン、背景デザイン、品質評価を保存）
 */
export async function handleDatabasePersistence(
  params: DatabasePersistenceParams
): Promise<DatabasePersistenceResult> {
  const {
    prisma,
    normalizedUrl,
    sanitizedHtml,
    metadata,
    fetchedScreenshot,
    validated,
    layoutSaveToDb,
    motionSaveToDb,
    layoutServiceResult,
    motionServiceResult,
    qualityServiceResult,
    warnings,
  } = params;

  const result: DatabasePersistenceResult = {
    savedWebPageId: undefined,
    savedSectionIdMapping: undefined,
    savedMotionPatternIdMapping: undefined,
    savedBackgroundDesignCount: 0,
  };

  if (!layoutSaveToDb && !motionSaveToDb) {
    return result;
  }

  if (!prisma) {
    logger.warn("[page.analyze] DB save skipped: database connection not configured");
    warnings.push({
      feature: "layout",
      code: PAGE_ANALYZE_ERROR_CODES.DB_NOT_CONFIGURED,
      message: "DB save skipped: database connection not configured. Data will not be persisted.",
    });
    return result;
  }

  // Vision分析結果を取得（全セクションで共有）
  const visionFeaturesFromLayout = layoutServiceResult?.visionFeatures;
  const pageCssSnippet = layoutServiceResult?.cssSnippet;
  const pageExternalCssContent = layoutServiceResult?.externalCssContent;
  const pageExternalCssMeta = layoutServiceResult?.externalCssMeta;
  const pageCssFramework = layoutServiceResult?.cssFramework;

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

  if (isDevelopment()) {
    logger.debug("[page.analyze] sectionsForSave preparation", {
      hasSections: !!layoutServiceResult?.sections,
      sectionCount: layoutServiceResult?.sections?.length ?? 0,
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
    layoutServiceResult?.sections?.map((section) => {
      const sectionForSave: SectionForSave = {
        id: section.id,
        type: section.type,
        positionIndex: section.positionIndex,
        heading: section.heading,
        confidence: section.confidence,
        htmlSnippet: section.htmlSnippet,
      };

      if (pageCssSnippet !== undefined && pageCssSnippet.length > 0) {
        sectionForSave.cssSnippet = pageCssSnippet;
      }
      if (pageExternalCssContent !== undefined && pageExternalCssContent.length > 0) {
        sectionForSave.externalCssContent = pageExternalCssContent;
      }
      if (pageExternalCssMeta !== undefined) {
        sectionForSave.externalCssMeta = pageExternalCssMeta;
      }
      if (pageCssFramework !== undefined) {
        sectionForSave.cssFramework = pageCssFramework.framework;
        sectionForSave.cssFrameworkMeta = {
          confidence: pageCssFramework.confidence,
          evidence: pageCssFramework.evidence,
        };
      }
      if (visionFeaturesFromLayout && visionFeaturesFromLayout.success) {
        const visionFeatures: SectionForSave["visionFeatures"] = {
          success: visionFeaturesFromLayout.success,
          features: visionFeaturesFromLayout.features,
        };
        if (layoutServiceResult?.textRepresentation !== undefined) {
          visionFeatures.textRepresentation = layoutServiceResult.textRepresentation;
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

  if (isDevelopment()) {
    const sectionsWithCssFramework = sectionsForSave.filter((s) => s.cssFramework !== undefined);
    logger.debug("[page.analyze] sectionsForSave created", {
      totalSections: sectionsForSave.length,
      sectionsWithCssFramework: sectionsWithCssFramework.length,
      firstSectionCssFramework: sectionsForSave[0]?.cssFramework ?? "not set",
      firstSectionHasCssFrameworkMeta: !!sectionsForSave[0]?.cssFrameworkMeta,
    });
  }

  // motionPatternsをDB保存用に変換
  const motionPatternsForSave: MotionPatternForSave[] =
    motionServiceResult?.patterns?.map((pattern) => ({
      id: pattern.id,
      name: pattern.name,
      type: pattern.type,
      category: pattern.category,
      trigger: pattern.trigger,
      duration: pattern.duration,
      easing: pattern.easing,
      properties: pattern.properties,
      propertiesDetailed: pattern.propertiesDetailed,
      rawCss: undefined,
      performance: pattern.performance,
      accessibility: pattern.accessibility,
    })) ?? [];

  // ページ全体のvisualFeatures
  const pageVisualFeatures = layoutServiceResult?.visualFeatures;

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
    layoutServiceResult?.backgroundDesigns?.map((bg) => ({
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
    qualityResult: qualityServiceResult,
    visualFeatures: pageVisualFeatures,
    backgroundDesigns: backgroundDesignsForSave,
  });

  if (saveResult.success) {
    result.savedWebPageId = saveResult.webPageId;
    result.savedSectionIdMapping = saveResult.sectionIdMapping;
    result.savedMotionPatternIdMapping = saveResult.motionPatternIdMapping;
    result.savedBackgroundDesignCount = saveResult.backgroundDesignCount ?? 0;

    if (isDevelopment()) {
      logger.info("[page.analyze] DB save completed", {
        webPageId: saveResult.webPageId,
        sectionPatternCount: saveResult.sectionPatternCount,
        motionPatternCount: saveResult.motionPatternCount,
        backgroundDesignCount: saveResult.backgroundDesignCount,
        qualityEvaluationId: saveResult.qualityEvaluationId,
        sectionIdMappingSize: result.savedSectionIdMapping?.size ?? 0,
        motionPatternIdMappingSize: result.savedMotionPatternIdMapping?.size ?? 0,
      });
    }
  } else {
    warnings.push({
      feature: "layout",
      code: PAGE_ANALYZE_ERROR_CODES.DB_SAVE_FAILED,
      message: saveResult.error ?? "Failed to save to database",
    });

    logger.warn("[page.analyze] DB save failed (graceful degradation)", {
      error: saveResult.error,
    });
  }

  return result;
}

// =====================================================
// Embedding生成
// =====================================================

export interface EmbeddingGenerationParams {
  autoAnalyze: boolean;
  layoutSaveToDb: boolean;
  motionSaveToDb: boolean;
  layoutServiceResult: LayoutServiceResult | undefined;
  motionServiceResult: MotionServiceResult | undefined;
  savedSectionIdMapping: Map<string, string> | undefined;
  savedMotionPatternIdMapping: Map<string, string> | undefined;
  savedWebPageId: string | undefined;
  validated: PageAnalyzeInput;
  overallStartTime: number;
  warnings: AnalysisWarning[];
}

/**
 * Section + Motion Embedding生成・保存
 */
export async function handleEmbeddingGeneration(params: EmbeddingGenerationParams): Promise<void> {
  const {
    autoAnalyze,
    layoutSaveToDb,
    motionSaveToDb,
    layoutServiceResult,
    motionServiceResult,
    savedSectionIdMapping,
    savedMotionPatternIdMapping,
    savedWebPageId,
    validated,
    overallStartTime,
    warnings,
  } = params;

  // Section Embedding
  if (
    autoAnalyze &&
    layoutSaveToDb &&
    layoutServiceResult?.success &&
    layoutServiceResult.sections &&
    savedSectionIdMapping &&
    savedSectionIdMapping.size > 0
  ) {
    const pageVisualFeaturesForEmbedding = layoutServiceResult.visualFeatures;

    const sectionsWithVisualFeatures: SectionDataForEmbedding[] = layoutServiceResult.sections.map(
      (section) => {
        const sectionForEmbedding: SectionDataForEmbedding = {
          id: section.id,
          type: section.type,
          positionIndex: section.positionIndex,
          confidence: section.confidence,
        };

        if (section.heading !== undefined) {
          sectionForEmbedding.heading = section.heading;
        }
        if (section.htmlSnippet !== undefined) {
          sectionForEmbedding.htmlSnippet = section.htmlSnippet;
        }
        if (pageVisualFeaturesForEmbedding !== undefined) {
          sectionForEmbedding.visualFeatures = pageVisualFeaturesForEmbedding;
        }

        return sectionForEmbedding;
      }
    );

    if (isDevelopment()) {
      logger.debug("[page.analyze] Propagating visualFeatures to sections for embedding", {
        sectionCount: sectionsWithVisualFeatures.length,
        hasPageVisualFeatures: !!pageVisualFeaturesForEmbedding,
        pageVisualFeaturesKeys: pageVisualFeaturesForEmbedding
          ? Object.keys(pageVisualFeaturesForEmbedding)
          : [],
      });
    }

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

  // Motion Embedding
  if (
    motionSaveToDb &&
    motionServiceResult?.success &&
    motionServiceResult.patterns &&
    savedMotionPatternIdMapping &&
    savedMotionPatternIdMapping.size > 0
  ) {
    const patterns = motionServiceResult.patterns as MotionPatternForEmbedding[];

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
}

// =====================================================
// VideoMode / JSアニメーション DB保存
// =====================================================

export interface MotionPersistenceExtrasParams {
  motionSaveToDb: boolean;
  motionServiceResult: MotionServiceResult | undefined;
  savedWebPageId: string | undefined;
  validated: PageAnalyzeInput;
  getPrismaClient: () => IPageAnalyzePrismaClient | null;
  warnings: AnalysisWarning[];
}

/**
 * VideoMode frame_analysis + JSアニメーション DB保存
 */
export async function handleMotionPersistenceExtras(
  params: MotionPersistenceExtrasParams
): Promise<void> {
  const {
    motionSaveToDb,
    motionServiceResult,
    savedWebPageId,
    validated,
    getPrismaClient,
    warnings,
  } = params;

  if (!motionSaveToDb || !motionServiceResult?.success) {
    return;
  }

  // Frame Analysis DB保存
  const frameAnalysis = motionServiceResult.frame_analysis;
  if (frameAnalysis && savedWebPageId) {
    const frameAnalysisSaveResult = await saveFrameAnalysisToDb({
      frameAnalysis,
      frameCapture: motionServiceResult.frame_capture,
      webPageId: savedWebPageId,
      sourceUrl: validated.url,
    });

    if (!frameAnalysisSaveResult.saved) {
      if (frameAnalysisSaveResult.error) {
        warnings.push({
          feature: "motion",
          code: "FRAME_ANALYSIS_DB_SAVE_ERROR",
          message: sanitizeErrorMessage(new Error(frameAnalysisSaveResult.error)),
        });
      } else if (frameAnalysisSaveResult.skipped) {
        logger.warn("[page.analyze] Frame analysis DB save skipped", {
          reason: frameAnalysisSaveResult.skipped,
        });
      } else if (frameAnalysisSaveResult.batchResult?.reason) {
        warnings.push({
          feature: "motion",
          code: "FRAME_ANALYSIS_DB_SAVE_FAILED",
          message: frameAnalysisSaveResult.batchResult.reason,
        });
      }
    }
  }

  // JSアニメーション DB保存
  const jsAnimations = motionServiceResult?.js_animations;
  const jsAnimationPrisma = getPrismaClient();
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

      const jsAnimationPatterns = mapJSAnimationResultToPatterns(
        jsAnimations,
        savedWebPageId,
        validated.url
      );

      if (jsAnimationPatterns.length > 0) {
        const saveResult = await saveJSAnimationPatternsWithEmbeddings(
          jsAnimationPrisma,
          jsAnimationPatterns,
          savedWebPageId,
          { generateEmbedding: true }
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
      logger.warn("[page.analyze] JS animation patterns DB save failed (graceful degradation)", {
        error: jsAnimDbError instanceof Error ? jsAnimDbError.message : "Unknown error",
      });

      warnings.push({
        feature: "motion",
        code: "JS_ANIMATION_DB_SAVE_ERROR",
        message: sanitizeErrorMessage(jsAnimDbError),
      });
    }
  }
}

// =====================================================
// Narrative分析
// =====================================================

export interface NarrativePhaseParams {
  validated: PageAnalyzeInput;
  html: string;
  fetchedScreenshot: string | undefined;
  savedWebPageId: string | undefined;
  layoutServiceResult: LayoutServiceResult | undefined;
  motionServiceResult: MotionServiceResult | undefined;
  overallStartTime: number;
  isSummary: boolean;
  warnings: AnalysisWarning[];
}

export interface NarrativePhaseResult {
  narrativeResult: NarrativeResult | undefined;
  narrativeHandlerResult: NarrativeHandlerResult | undefined;
}

/**
 * Narrative分析フェーズ
 */
export async function handleNarrativePhase(
  params: NarrativePhaseParams
): Promise<NarrativePhaseResult> {
  const {
    validated,
    html,
    fetchedScreenshot,
    savedWebPageId,
    layoutServiceResult,
    motionServiceResult,
    overallStartTime,
    isSummary,
    warnings,
  } = params;

  let narrativeResult: NarrativeResult | undefined;
  let narrativeHandlerResult: NarrativeHandlerResult | undefined;

  const narrativeEnabled = validated.narrativeOptions?.enabled !== false;
  if (!narrativeEnabled) {
    return { narrativeResult, narrativeHandlerResult };
  }

  if (isDevelopment()) {
    logger.info("[page.analyze] Starting narrative analysis", {
      saveToDb: validated.narrativeOptions.saveToDb,
      includeVision: validated.narrativeOptions.includeVision,
      visionTimeoutMs: validated.narrativeOptions.visionTimeoutMs,
      generateEmbedding: validated.narrativeOptions.generateEmbedding,
      webPageId: savedWebPageId,
    });
  }

  const narrativeInput: NarrativeHandlerInput = {
    html,
    narrativeOptions: validated.narrativeOptions,
  };

  if (fetchedScreenshot !== undefined) {
    narrativeInput.screenshot = fetchedScreenshot;
  }
  if (savedWebPageId !== undefined) {
    narrativeInput.webPageId = savedWebPageId;
  }

  if (layoutServiceResult || motionServiceResult) {
    narrativeInput.existingAnalysis = {};
    if (layoutServiceResult?.cssVariables) {
      narrativeInput.existingAnalysis.cssVariables = layoutServiceResult.cssVariables;
    }
    if (motionServiceResult) {
      narrativeInput.existingAnalysis.motionPatterns = motionServiceResult;
    }
    if (layoutServiceResult?.sections) {
      narrativeInput.existingAnalysis.sections = layoutServiceResult.sections;
    }
    if (layoutServiceResult?.visionFeatures) {
      narrativeInput.existingAnalysis.visualFeatures = layoutServiceResult.visionFeatures;
    }
  }

  if (layoutServiceResult?.externalCssContent) {
    narrativeInput.externalCss = layoutServiceResult.externalCssContent;
  }

  try {
    const narrativeRemaining = Math.max(0, 570000 - (Date.now() - overallStartTime));
    if (narrativeRemaining < 15000) {
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
      warnings.push({
        feature: "quality",
        code: narrativeHandlerResult.error.code,
        message: `Narrative analysis failed: ${sanitizeErrorMessage(narrativeHandlerResult.error)}`,
      });

      logger.warn("[page.analyze] Narrative analysis failed", {
        code: narrativeHandlerResult.error.code,
        message: narrativeHandlerResult.error.message,
      });
    }
  } catch (narrativeError) {
    const isTimeout = narrativeError instanceof PhaseTimeoutError;
    const rawErrorMessage =
      narrativeError instanceof Error ? narrativeError.message : String(narrativeError);
    const safeErrorMessage = sanitizeErrorMessage(narrativeError);
    warnings.push({
      feature: "quality",
      code: isTimeout ? "NARRATIVE_TIMEOUT" : "NARRATIVE_UNEXPECTED_ERROR",
      message: isTimeout
        ? `Narrative analysis timed out: ${safeErrorMessage}`
        : `Unexpected error in narrative analysis: ${safeErrorMessage}`,
    });

    logger.warn("[page.analyze] Unexpected narrative analysis error", {
      error: rawErrorMessage,
    });
  }

  return { narrativeResult, narrativeHandlerResult };
}

// =====================================================
// Responsive分析
// =====================================================

export interface ResponsivePhaseParams {
  validated: PageAnalyzeInput;
  savedWebPageId: string | undefined;
  overallStartTime: number;
  warnings: AnalysisWarning[];
}

export interface ResponsivePhaseResult {
  responsiveAnalysisResult: ResponsiveAnalysisResult | undefined;
  responsiveAnalysisId: string | undefined;
}

/**
 * Responsive分析フェーズ
 */
export async function handleResponsivePhase(
  params: ResponsivePhaseParams
): Promise<ResponsivePhaseResult> {
  const { validated, savedWebPageId, overallStartTime, warnings } = params;

  let responsiveAnalysisResult: ResponsiveAnalysisResult | undefined;
  let responsiveAnalysisId: string | undefined;

  if (validated.responsiveOptions?.enabled !== true) {
    return { responsiveAnalysisResult, responsiveAnalysisId };
  }

  const responsiveRemaining = Math.max(0, 570000 - (Date.now() - overallStartTime));
  if (responsiveRemaining < 15000) {
    warnings.push({
      feature: "layout",
      code: "RESPONSIVE_SKIPPED",
      message: `Responsive analysis skipped: insufficient time remaining (${responsiveRemaining}ms)`,
    });
    return { responsiveAnalysisResult, responsiveAnalysisId };
  }

  try {
    // SSRF対策: URLを検証
    const urlValidation = validateExternalUrl(validated.url);
    if (!urlValidation.valid) {
      warnings.push({
        feature: "layout",
        code: "RESPONSIVE_SSRF_BLOCKED",
        message: `レスポンシブ分析スキップ: ${urlValidation.error}`,
      });
      return { responsiveAnalysisResult, responsiveAnalysisId };
    }

    // robots.txt チェック
    const robotsResult = await isUrlAllowedByRobotsTxt(validated.url, validated.respect_robots_txt);
    if (!robotsResult.allowed) {
      warnings.push({
        feature: "layout",
        code: "RESPONSIVE_ROBOTS_BLOCKED",
        message: `レスポンシブ分析スキップ: robots.txtによりブロック (${robotsResult.reason})`,
      });
      return { responsiveAnalysisResult, responsiveAnalysisId };
    }

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
      Math.min(responsiveRemaining, 120000),
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

    // DB保存
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
          error: responsiveDbError instanceof Error ? responsiveDbError.message : "Unknown error",
        });
        warnings.push({
          feature: "layout",
          code: "RESPONSIVE_DB_SAVE_FAILED",
          message: sanitizeErrorMessage(responsiveDbError),
        });
      }
    }
  } catch (responsiveError) {
    const isTimeout = responsiveError instanceof PhaseTimeoutError;
    const rawErrorMessage =
      responsiveError instanceof Error ? responsiveError.message : String(responsiveError);
    const safeErrorMessage = sanitizeErrorMessage(responsiveError);
    warnings.push({
      feature: "layout",
      code: isTimeout ? "RESPONSIVE_TIMEOUT" : "RESPONSIVE_ERROR",
      message: isTimeout
        ? `Responsive analysis timed out: ${safeErrorMessage}`
        : `Responsive analysis failed: ${safeErrorMessage}`,
    });

    logger.warn("[page.analyze] Responsive analysis failed (graceful degradation)", {
      error: rawErrorMessage,
    });
  }

  return { responsiveAnalysisResult, responsiveAnalysisId };
}

// =====================================================
// レスポンス構築
// =====================================================

export interface BuildResponseParams {
  validated: PageAnalyzeInput;
  normalizedUrl: string;
  metadata: PageMetadata;
  overallStartTime: number;
  executionTracker: ExecutionStatusTracker;
  layoutResult: LayoutResult | undefined;
  motionResult: MotionResult | undefined;
  qualityResult: QualityResult | undefined;
  narrativeResult: NarrativeResult | undefined;
  responsiveAnalysisResult: ResponsiveAnalysisResult | undefined;
  responsiveAnalysisId: string | undefined;
  layoutServiceResult: LayoutServiceResult | undefined;
  savedBackgroundDesignCount: number;
  probeResult: ProbeResult | null;
  warnings: AnalysisWarning[];
}

/**
 * 最終レスポンスの構築
 */
export function buildPageAnalyzeResponse(params: BuildResponseParams): PageAnalyzeData {
  const {
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
    layoutServiceResult,
    savedBackgroundDesignCount,
    probeResult,
    warnings,
  } = params;

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
  if (narrativeResult) {
    data.narrative = narrativeResult;
  }

  // 背景デザイン検出サマリー
  const backgroundDesignsSummary = buildBackgroundDesignsSummary(
    layoutServiceResult?.backgroundDesigns,
    savedBackgroundDesignCount
  );
  if (backgroundDesignsSummary) {
    data.backgroundDesigns = backgroundDesignsSummary;
  }

  // Responsive分析結果
  if (responsiveAnalysisResult) {
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

  // Pre-flight Probe結果
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

  return data;
}

// =====================================================
// 分析結果の統合
// =====================================================

export interface IntegrateResultsParams {
  layoutServiceResult: LayoutServiceResult | null;
  motionServiceResult: MotionServiceResult | null;
  qualityServiceResult: QualityServiceResult | null;
  validated: PageAnalyzeInput;
  warnings: AnalysisWarning[];
}

export interface IntegrateResultsOutput {
  layoutResult: LayoutResult | undefined;
  motionResult: MotionResult | undefined;
  qualityResult: QualityResult | undefined;
  layoutServiceResultForSave: LayoutServiceResult | undefined;
  motionServiceResultForSave: MotionServiceResult | undefined;
  qualityServiceResultForSave: QualityServiceResult | undefined;
}

/**
 * 並列分析の結果を統合
 */
export function integrateAnalysisResults(params: IntegrateResultsParams): IntegrateResultsOutput {
  const { layoutServiceResult, motionServiceResult, qualityServiceResult, validated, warnings } =
    params;

  const isSummary = validated.summary ?? true;

  let layoutResult: LayoutResult | undefined;
  let motionResult: MotionResult | undefined;
  let qualityResult: QualityResult | undefined;
  let layoutServiceResultForSave: LayoutServiceResult | undefined;
  let motionServiceResultForSave: MotionServiceResult | undefined;
  let qualityServiceResultForSave: QualityServiceResult | undefined;

  // Layout結果の処理
  if (layoutServiceResult) {
    layoutServiceResultForSave = layoutServiceResult;
    layoutResult = buildLayoutResult(layoutServiceResult, isSummary, validated.layoutOptions);
    const warning = extractWarning("layout", layoutServiceResult);
    if (warning) warnings.push(warning);
  }

  // Motion結果の処理
  if (motionServiceResult !== null) {
    const motion = motionServiceResult as MotionServiceResult;
    motionServiceResultForSave = motion;
    motionResult = buildMotionResult(motion, isSummary);
    const warning = extractWarning("motion", motion);
    if (warning) warnings.push(warning);

    // WebGL/Canvas検出警告
    const detectJsAnimations = validated.motionOptions?.detect_js_animations ?? true;
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

  return {
    layoutResult,
    motionResult,
    qualityResult,
    layoutServiceResultForSave,
    motionServiceResultForSave,
    qualityServiceResultForSave,
  };
}
