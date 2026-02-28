// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze Narrative分析ハンドラー
 *
 * NarrativeAnalysisServiceを使用してWebページの
 * 「世界観・雰囲気（WorldView）」と「レイアウト構成（LayoutStructure）」を分析する。
 *
 * @module tools/page/handlers/narrative-handler
 */

import { logger, isDevelopment } from '../../../utils/logger';
import {
  createNarrativeAnalysisService,
  type NarrativeAnalysisService,
} from '../../../services/narrative/narrative-analysis.service';
import type {
  NarrativeAnalysisInput,
  NarrativeAnalysisResult,
  ExistingAnalysisResults,
} from '../../../services/narrative/types/narrative.types';
import type {
  NarrativeHandlerInput,
  NarrativeHandlerResult,
} from './types';

// =====================================================
// Error Codes
// =====================================================

export const NARRATIVE_ERROR_CODES = {
  NARRATIVE_ANALYSIS_FAILED: 'NARRATIVE_ANALYSIS_FAILED',
  NARRATIVE_SAVE_FAILED: 'NARRATIVE_SAVE_FAILED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

// =====================================================
// Service Factory（DI用）
// =====================================================

let narrativeServiceFactory: (() => NarrativeAnalysisService) | null = null;

/**
 * NarrativeAnalysisServiceファクトリを設定（テスト用）
 */
export function setNarrativeServiceFactory(
  factory: () => NarrativeAnalysisService
): void {
  narrativeServiceFactory = factory;
}

/**
 * NarrativeAnalysisServiceファクトリをリセット（テスト用）
 */
export function resetNarrativeServiceFactory(): void {
  narrativeServiceFactory = null;
}

/**
 * NarrativeAnalysisServiceを取得
 */
function getNarrativeService(): NarrativeAnalysisService {
  if (narrativeServiceFactory) {
    return narrativeServiceFactory();
  }
  return createNarrativeAnalysisService();
}

// =====================================================
// Main Handler
// =====================================================

/**
 * Narrative分析を実行
 *
 * @param input - Narrative Handler入力
 * @returns Narrative分析結果
 */
export async function handleNarrativeAnalysis(
  input: NarrativeHandlerInput
): Promise<NarrativeHandlerResult> {
  const startTime = Date.now();

  // enabled=false の場合はスキップ
  if (!input.narrativeOptions?.enabled) {
    if (isDevelopment()) {
      logger.debug('[narrative-handler] Skipped: enabled=false');
    }
    return {
      success: true,
      skipped: true,
    };
  }

  if (isDevelopment()) {
    logger.info('[narrative-handler] Starting narrative analysis', {
      hasHtml: !!input.html,
      hasScreenshot: !!input.screenshot,
      hasWebPageId: !!input.webPageId,
      saveToDb: input.narrativeOptions?.saveToDb,
      includeVision: input.narrativeOptions?.includeVision,
    });
  }

  // saveToDb=true の場合は webPageId が必須
  if (input.narrativeOptions?.saveToDb && !input.webPageId) {
    return {
      success: false,
      error: {
        code: NARRATIVE_ERROR_CODES.VALIDATION_ERROR,
        message: 'webPageId is required when saveToDb is true',
      },
    };
  }

  try {
    // NarrativeAnalysisServiceを取得
    const narrativeService = getNarrativeService();

    // 既存分析結果をNarrativeAnalysisInput形式に変換
    // NOTE: exactOptionalPropertyTypes対応のため、as unknown as T パターンを使用
    // 入力のexistingAnalysisはpage.analyzeから渡されるため、型が一致することを保証
    const existingAnalysis: ExistingAnalysisResults | undefined =
      input.existingAnalysis
        ? (input.existingAnalysis as unknown as ExistingAnalysisResults)
        : undefined;

    // NarrativeAnalysisInput を構築
    // exactOptionalPropertyTypes対応: undefinedのプロパティは含めないようにオブジェクトを構築
    const analysisOptions: NarrativeAnalysisInput['options'] = {};
    if (input.narrativeOptions?.includeVision === false) {
      analysisOptions.forceVision = false;
    }
    if (input.narrativeOptions?.visionTimeoutMs !== undefined) {
      analysisOptions.visionTimeoutMs = input.narrativeOptions.visionTimeoutMs;
    }
    if (input.narrativeOptions?.generateEmbedding !== undefined) {
      analysisOptions.generateEmbedding = input.narrativeOptions.generateEmbedding;
    }

    const analysisInput: NarrativeAnalysisInput = {
      html: input.html,
      options: analysisOptions,
    };

    // exactOptionalPropertyTypes対応: undefinedのプロパティは含めない
    if (input.screenshot !== undefined) {
      analysisInput.screenshot = input.screenshot;
    }
    if (input.webPageId !== undefined) {
      analysisInput.webPageId = input.webPageId;
    }
    if (input.externalCss !== undefined) {
      analysisInput.externalCss = input.externalCss;
    }
    if (existingAnalysis !== undefined) {
      analysisInput.existingAnalysis = existingAnalysis;
    }

    let result: NarrativeAnalysisResult;
    let savedId: string | undefined;

    if (input.narrativeOptions?.saveToDb && input.webPageId) {
      // analyzeAndSave を使用
      const saved = await narrativeService.analyzeAndSave(analysisInput);
      savedId = saved.id;

      // 分析結果を取得するために再度 analyze を呼び出す
      // (analyzeAndSave は SavedNarrative を返すため)
      result = await narrativeService.analyze(analysisInput);
    } else {
      // analyze のみ
      result = await narrativeService.analyze(analysisInput);
    }

    const processingTimeMs = Date.now() - startTime;

    // 結果を整形
    const narrative = formatNarrativeResult(result, input.webPageId, savedId);

    if (isDevelopment()) {
      logger.info('[narrative-handler] Analysis complete', {
        moodCategory: result.worldView.moodCategory,
        confidence: result.metadata.confidence.overall,
        visionUsed: result.metadata.visionUsed,
        processingTimeMs,
        savedId,
      });
    }

    // exactOptionalPropertyTypes対応: undefinedのプロパティは含めない
    const handlerResult: NarrativeHandlerResult = {
      success: true,
      narrative,
      processingTimeMs,
    };

    if (savedId !== undefined) {
      handlerResult.savedId = savedId;
    }

    return handlerResult;
  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (isDevelopment()) {
      logger.error('[narrative-handler] Analysis failed', {
        error: errorMessage,
        processingTimeMs,
      });
    }

    // エラーの種類を判定
    const errorCode = errorMessage.includes('DB') || errorMessage.includes('save')
      ? NARRATIVE_ERROR_CODES.NARRATIVE_SAVE_FAILED
      : NARRATIVE_ERROR_CODES.NARRATIVE_ANALYSIS_FAILED;

    return {
      success: false,
      processingTimeMs,
      error: {
        code: errorCode,
        message: errorMessage,
      },
    };
  }
}

// =====================================================
// Helper Functions
// =====================================================

/**
 * NarrativeAnalysisResult を NarrativeHandlerResult.narrative 形式に変換
 */
function formatNarrativeResult(
  result: NarrativeAnalysisResult,
  webPageId?: string,
  savedId?: string
): NonNullable<NarrativeHandlerResult['narrative']> {
  const { worldView, layoutStructure, metadata } = result;

  // WorldView を簡略化（exactOptionalPropertyTypes対応）
  const formattedWorldView: NonNullable<NarrativeHandlerResult['narrative']>['worldView'] = {
    moodCategory: worldView.moodCategory,
    moodDescription: worldView.moodDescription,
    colorImpression: formatColorImpression(worldView.colorImpression),
    typographyPersonality: formatTypographyPersonality(worldView.typographyPersonality),
    overallTone: formatOverallTone(worldView.overallTone),
  };

  // Optional fields for WorldView
  if (worldView.motionEmotion !== undefined) {
    formattedWorldView.motionEmotion = formatMotionEmotion(worldView.motionEmotion);
  }

  // LayoutStructure を簡略化（exactOptionalPropertyTypes対応）
  const formattedLayoutStructure: NonNullable<NarrativeHandlerResult['narrative']>['layoutStructure'] = {
    gridSystem: layoutStructure.gridSystem.type,
    visualHierarchy: {
      primaryElements: layoutStructure.visualHierarchy.primaryElements,
      sectionFlow: layoutStructure.visualHierarchy.sectionFlow,
    },
    spacingRhythm: {
      baseUnit: layoutStructure.spacingRhythm.baseUnit,
      scale: layoutStructure.spacingRhythm.scale,
    },
    whitespaceRatio: layoutStructure.graphicElements.visualBalance.whitespace,
    visualDensity: layoutStructure.graphicElements.visualBalance.density,
  };

  // Optional fields for LayoutStructure
  if (typeof layoutStructure.gridSystem.columns === 'number') {
    formattedLayoutStructure.columnCount = layoutStructure.gridSystem.columns;
  }
  if (layoutStructure.gridSystem.gutterWidth !== undefined) {
    formattedLayoutStructure.gutterWidth = layoutStructure.gridSystem.gutterWidth;
  }
  if (layoutStructure.gridSystem.containerWidth !== undefined) {
    formattedLayoutStructure.containerWidth = layoutStructure.gridSystem.containerWidth;
  }

  // exactOptionalPropertyTypes対応: undefinedのプロパティは含めない
  const narrative: NonNullable<NarrativeHandlerResult['narrative']> = {
    worldView: formattedWorldView,
    layoutStructure: formattedLayoutStructure,
    confidence: metadata.confidence.overall,
    analyzedAt: new Date().toISOString(),
    processingTimeMs: metadata.analysisTimeMs,
    visionUsed: metadata.visionUsed,
  };

  if (savedId !== undefined) {
    narrative.id = savedId;
  }
  if (webPageId !== undefined) {
    narrative.webPageId = webPageId;
  }
  if (metadata.fallbackReason !== undefined) {
    narrative.fallbackReason = metadata.fallbackReason;
  }

  return narrative;
}

/**
 * ColorImpression を文字列に変換
 */
function formatColorImpression(colorImpression: {
  overall: string;
  dominantEmotion: string;
  harmony: string;
}): string {
  return `${colorImpression.overall} (${colorImpression.dominantEmotion}, ${colorImpression.harmony})`;
}

/**
 * TypographyPersonality を文字列に変換
 */
function formatTypographyPersonality(typography: {
  style: string;
  readability: string;
  hierarchy: string;
}): string {
  return `${typography.style} style with ${typography.readability} readability and ${typography.hierarchy} hierarchy`;
}

/**
 * MotionEmotion を文字列に変換
 */
function formatMotionEmotion(motion: {
  overall: string;
  pace: string;
  intensity: number;
  accessibility: boolean;
}): string {
  const a11y = motion.accessibility ? 'accessible' : 'not accessible';
  return `${motion.overall} (${motion.pace} pace, ${Math.round(motion.intensity * 100)}% intensity, ${a11y})`;
}

/**
 * OverallTone を文字列に変換
 */
function formatOverallTone(tone: {
  primary: string;
  formality: number;
  energy: number;
}): string {
  return `${tone.primary} (formality: ${Math.round(tone.formality * 100)}%, energy: ${Math.round(tone.energy * 100)}%)`;
}
