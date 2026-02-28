// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze 結果ビルダー
 * Layout/Motion/Quality の分析結果を PageAnalyzeOutput 形式に変換
 *
 * @module tools/page/handlers/result-builder
 */

import {
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeInput,
  type LayoutResult,
  type LayoutResultSummary,
  type MotionResult,
  type QualityResult,
  type NarrativeResult,
  type AnalysisWarning,
  type CssFrameworkResult,
} from '../schemas';

import {
  type LayoutServiceResult,
  type MotionServiceResult,
  type QualityServiceResult,
  type NarrativeHandlerResult,
} from './types';

import {
  WarningFactory,
  legacyWarningToActionable,
  type ActionableWarning as ActionableWarningType,
} from '../../../utils/actionable-warning';

// =====================================================
// エラーコード判定
// =====================================================

/**
 * エラーメッセージから適切なエラーコードを判定
 */
export function determineErrorCode(errorMessage: string): string {
  if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
    return PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR;
  }
  if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
    return PAGE_ANALYZE_ERROR_CODES.HTTP_ERROR;
  }
  if (errorMessage.includes('browser') || errorMessage.includes('Browser')) {
    return PAGE_ANALYZE_ERROR_CODES.BROWSER_ERROR;
  }
  return PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR;
}

// =====================================================
// Result Builders
// =====================================================

/**
 * レイアウト結果を構築
 */
export function buildLayoutResult(
  lr: LayoutServiceResult,
  isSummary: boolean,
  layoutOptions?: PageAnalyzeInput['layoutOptions']
): LayoutResult {
  // 基本フィールドでLayoutResultSummaryを構築
  const base: LayoutResultSummary = {
    success: lr.success,
    pageId: lr.pageId,
    sectionCount: lr.sectionCount,
    sectionTypes: lr.sectionTypes,
    processingTimeMs: lr.processingTimeMs,
    error: lr.error,
  };

  // CSSフレームワーク検出結果（summary/full 共通で含める）
  // CSSフレームワーク検出はDB保存の重要な情報のため、常に含める
  if (lr.cssFramework !== undefined) {
    // LayoutServiceResultのcssFrameworkをLayoutResultSummaryのcssFrameworkに変換
    const cssFramework: CssFrameworkResult = {
      framework: lr.cssFramework.framework,
      confidence: lr.cssFramework.confidence,
      evidence: lr.cssFramework.evidence,
    };
    base.cssFramework = cssFramework;
  }
  if (lr.cssSnippet !== undefined) {
    base.cssSnippet = lr.cssSnippet;
  }

  if (isSummary) {
    // Summary版: include_html/include_screenshotは独立して適用
    // MCP-RESP-03: snake_case (include_html) を優先し、camelCase (includeHtml) はフォールバック
    const shouldIncludeHtml = layoutOptions?.include_html ?? layoutOptions?.includeHtml;
    const shouldIncludeScreenshot = layoutOptions?.include_screenshot ?? layoutOptions?.includeScreenshot;

    if (shouldIncludeHtml && lr.html) {
      (base as LayoutServiceResult).html = lr.html;
    }
    if (shouldIncludeScreenshot && lr.screenshot) {
      (base as LayoutServiceResult).screenshot = lr.screenshot;
    }
    // Vision解析結果は useVision=true の場合、summaryでも含める（明示的に有効化された結果）
    if (layoutOptions?.useVision && lr.visionFeatures) {
      (base as LayoutServiceResult).visionFeatures = lr.visionFeatures;
    }
    if (layoutOptions?.useVision && lr.textRepresentation) {
      (base as LayoutServiceResult).textRepresentation = lr.textRepresentation;
    }
    // Visual Features は常にsummaryに含める（明示的に抽出された結果）
    if (lr.visualFeatures !== undefined) {
      (base as LayoutServiceResult).visualFeatures = lr.visualFeatures;
    }
    // CSS Variables は常にsummaryに含める（v0.1.0: デザイン参考データ）
    if (lr.cssVariables !== undefined) {
      (base as LayoutServiceResult).cssVariables = lr.cssVariables;
    }
  } else {
    // Full版: 値が存在する場合のみ設定
    if (lr.html !== undefined) {
      (base as LayoutServiceResult).html = lr.html;
    }
    if (lr.screenshot !== undefined) {
      (base as LayoutServiceResult).screenshot = lr.screenshot;
    }
    if (lr.sections !== undefined) {
      (base as LayoutServiceResult).sections = lr.sections;
    }
    // Vision解析結果（Full版）
    if (lr.visionFeatures !== undefined) {
      (base as LayoutServiceResult).visionFeatures = lr.visionFeatures;
    }
    if (lr.textRepresentation !== undefined) {
      (base as LayoutServiceResult).textRepresentation = lr.textRepresentation;
    }
    // Visual Features（Phase 1/2統合結果）
    if (lr.visualFeatures !== undefined) {
      (base as LayoutServiceResult).visualFeatures = lr.visualFeatures;
    }
    // CSS Variables（v0.1.0: デザイン参考データ）
    if (lr.cssVariables !== undefined) {
      (base as LayoutServiceResult).cssVariables = lr.cssVariables;
    }
  }

  return base;
}

/**
 * モーション結果を構築
 */
export function buildMotionResult(
  mr: MotionServiceResult,
  isSummary: boolean
): MotionResult {
  const base: MotionResult = {
    success: mr.success,
    patternCount: mr.patternCount,
    categoryBreakdown: mr.categoryBreakdown,
    warningCount: mr.warningCount,
    a11yWarningCount: mr.a11yWarningCount,
    perfWarningCount: mr.perfWarningCount,
    processingTimeMs: mr.processingTimeMs,
    error: mr.error,
  };

  if (!isSummary) {
    if (mr.patterns !== undefined) {
      (base as MotionServiceResult).patterns = mr.patterns;
    }
    if (mr.warnings !== undefined) {
      (base as MotionServiceResult).warnings = mr.warnings;
    }
  }

  // === Video Mode 結果（summary/full 共通で含める） ===
  // video mode 結果は明示的に有効化された場合のみ存在するため、
  // summary モードでも含める（ユーザーが意図的に有効化した結果）
  if (mr.frame_capture !== undefined) {
    (base as MotionServiceResult).frame_capture = mr.frame_capture;
  }
  if (mr.frame_analysis !== undefined) {
    (base as MotionServiceResult).frame_analysis = mr.frame_analysis;
  }
  if (mr.frame_capture_error !== undefined) {
    (base as MotionServiceResult).frame_capture_error = mr.frame_capture_error;
  }
  if (mr.frame_analysis_error !== undefined) {
    (base as MotionServiceResult).frame_analysis_error = mr.frame_analysis_error;
  }

  // === JS Animation 結果（summary/full 共通で含める）(v0.1.0) ===
  // JS Animation 結果は明示的に有効化された場合のみ存在するため、
  // summary モードでも含める（ユーザーが意図的に有効化した結果）
  if (mr.js_animation_summary !== undefined) {
    (base as MotionServiceResult).js_animation_summary = mr.js_animation_summary;
  }
  if (mr.js_animations !== undefined) {
    (base as MotionServiceResult).js_animations = mr.js_animations;
  }
  if (mr.js_animation_error !== undefined) {
    (base as MotionServiceResult).js_animation_error = mr.js_animation_error;
  }

  // === WebGL Animation 結果（summary/full 共通で含める）(v0.1.0) ===
  // WebGL Animation 結果は明示的に有効化された場合のみ存在するため、
  // summary モードでも含める（ユーザーが意図的に有効化した結果）
  if (mr.webgl_animation_summary !== undefined) {
    (base as MotionServiceResult).webgl_animation_summary = mr.webgl_animation_summary;
  }
  if (mr.webgl_animations !== undefined) {
    (base as MotionServiceResult).webgl_animations = mr.webgl_animations;
  }
  if (mr.webgl_animation_error !== undefined) {
    (base as MotionServiceResult).webgl_animation_error = mr.webgl_animation_error;
  }

  return base;
}

/**
 * 品質結果を構築
 */
export function buildQualityResult(
  qr: QualityServiceResult,
  isSummary: boolean,
  qualityOptions?: PageAnalyzeInput['qualityOptions']
): QualityResult {
  const base: QualityResult = {
    success: qr.success,
    overallScore: qr.overallScore,
    grade: qr.grade,
    axisScores: qr.axisScores,
    clicheCount: qr.clicheCount,
    processingTimeMs: qr.processingTimeMs,
    error: qr.error,
  };

  if (isSummary) {
    // includeRecommendationsはsummaryと独立して適用
    if (qualityOptions?.includeRecommendations !== false && qr.recommendations) {
      (base as QualityServiceResult).recommendations = qr.recommendations;
    }
  } else {
    // Full版: 値が存在する場合のみ設定
    if (qr.axisGrades !== undefined) {
      (base as QualityServiceResult).axisGrades = qr.axisGrades;
    }
    if (qr.axisDetails !== undefined) {
      (base as QualityServiceResult).axisDetails = qr.axisDetails;
    }
    if (qr.cliches !== undefined) {
      (base as QualityServiceResult).cliches = qr.cliches;
    }
    if (qr.recommendations !== undefined) {
      (base as QualityServiceResult).recommendations = qr.recommendations;
    }
  }

  return base;
}

/**
 * Narrative結果を構築（v0.1.0）
 *
 * NarrativeHandlerResultをNarrativeResult形式に変換
 */
export function buildNarrativeResult(
  nr: NarrativeHandlerResult,
  _isSummary: boolean // TODO: summary/full mode実装時に使用
): NarrativeResult | undefined {
  // スキップされた場合またはnarrativeが存在しない場合はundefined
  if (nr.skipped || !nr.narrative) {
    return undefined;
  }

  // 失敗した場合もundefined（エラーはwarningsに含める）
  if (!nr.success) {
    return undefined;
  }

  const narrative = nr.narrative;

  // 基本フィールド（summary/full 共通）
  const base: NarrativeResult = {
    worldView: {
      moodCategory: narrative.worldView.moodCategory as NarrativeResult['worldView']['moodCategory'],
      moodDescription: narrative.worldView.moodDescription,
      colorImpression: narrative.worldView.colorImpression,
      typographyPersonality: narrative.worldView.typographyPersonality,
      overallTone: narrative.worldView.overallTone,
    },
    layoutStructure: {
      gridSystem: narrative.layoutStructure.gridSystem,
    },
    confidence: narrative.confidence,
    analyzedAt: narrative.analyzedAt,
  };

  // Optional fields (exactOptionalPropertyTypes対応)
  if (narrative.id !== undefined) {
    base.id = narrative.id;
  }
  if (narrative.webPageId !== undefined) {
    base.webPageId = narrative.webPageId;
  }
  if (narrative.worldView.secondaryMoodCategory !== undefined) {
    base.worldView.secondaryMoodCategory = narrative.worldView.secondaryMoodCategory as NarrativeResult['worldView']['secondaryMoodCategory'];
  }
  if (narrative.worldView.motionEmotion !== undefined) {
    base.worldView.motionEmotion = narrative.worldView.motionEmotion;
  }
  if (narrative.processingTimeMs !== undefined) {
    base.processingTimeMs = narrative.processingTimeMs;
  }
  if (narrative.visionUsed !== undefined) {
    base.visionUsed = narrative.visionUsed;
  }
  if (narrative.fallbackReason !== undefined) {
    base.fallbackReason = narrative.fallbackReason;
  }

  // LayoutStructure optional fields
  if (narrative.layoutStructure.columnCount !== undefined) {
    base.layoutStructure.columnCount = narrative.layoutStructure.columnCount;
  }
  if (narrative.layoutStructure.gutterWidth !== undefined) {
    base.layoutStructure.gutterWidth = narrative.layoutStructure.gutterWidth;
  }
  if (narrative.layoutStructure.containerWidth !== undefined) {
    base.layoutStructure.containerWidth = narrative.layoutStructure.containerWidth;
  }
  if (narrative.layoutStructure.visualHierarchy !== undefined) {
    base.layoutStructure.visualHierarchy = narrative.layoutStructure.visualHierarchy;
  }
  if (narrative.layoutStructure.spacingRhythm !== undefined) {
    base.layoutStructure.spacingRhythm = narrative.layoutStructure.spacingRhythm;
  }
  if (narrative.layoutStructure.whitespaceRatio !== undefined) {
    base.layoutStructure.whitespaceRatio = narrative.layoutStructure.whitespaceRatio;
  }
  if (narrative.layoutStructure.visualDensity !== undefined) {
    base.layoutStructure.visualDensity = narrative.layoutStructure.visualDensity;
  }

  return base;
}

// =====================================================
// Background Design Summary Builder
// =====================================================

/**
 * 背景デザイン検出結果のサマリーを構築
 *
 * LayoutServiceResultのbackgroundDesignsとDB保存結果から
 * PageAnalyzeDataのbackgroundDesignsフィールドを生成する。
 *
 * @param backgroundDesigns - 検出された背景デザインデータ配列
 * @param savedToDbCount - DBに保存された件数（saveToDb=false時は0）
 * @returns backgroundDesignsサマリーオブジェクト、またはundefined（検出なし時）
 */
export function buildBackgroundDesignsSummary(
  backgroundDesigns: Array<{ designType: string }> | undefined,
  savedToDbCount: number
): { count: number; types: string[]; savedToDb: number } | undefined {
  const count = backgroundDesigns?.length ?? 0;

  // 検出なしの場合はundefined（レスポンスサイズ削減）
  if (count === 0) {
    return undefined;
  }

  return {
    count,
    types: backgroundDesigns?.map((bg) => bg.designType) ?? [],
    savedToDb: savedToDbCount,
  };
}

// =====================================================
// Warning Extraction
// =====================================================

/**
 * 分析結果からwarningを抽出
 */
export function extractWarning(
  feature: 'layout' | 'motion' | 'quality',
  result: { success: boolean; error?: { code: string; message: string } }
): AnalysisWarning | null {
  if (!result.success && result.error) {
    return {
      feature,
      code: result.error.code,
      message: result.error.message,
    };
  }
  return null;
}

// =====================================================
// Actionable Warning Extraction (v0.1.0)
// =====================================================

/**
 * エラーメッセージからアクショナブル警告を生成
 *
 * エラーコードとメッセージを解析し、適切なWarningFactoryメソッドを呼び出す。
 * 対応するFactoryメソッドがない場合は、legacyWarningToActionableでフォールバック変換。
 */
export function extractActionableWarning(
  feature: 'layout' | 'motion' | 'quality',
  result: { success: boolean; error?: { code: string; message: string } },
  context?: {
    url?: string;
    timeoutMs?: number;
    analysisType?: string;
  }
): ActionableWarningType | null {
  if (!result.success && result.error) {
    const { code, message } = result.error;

    // タイムアウトエラーの検出
    if (code === PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR ||
        message.toLowerCase().includes('timeout') ||
        message.toLowerCase().includes('timed out')) {
      return WarningFactory.pageTimeout(
        context?.url || 'unknown',
        context?.timeoutMs || 60000
      );
    }

    // ネットワークエラーの検出
    if (code === PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR ||
        message.toLowerCase().includes('network') ||
        message.toLowerCase().includes('fetch') ||
        message.toLowerCase().includes('econnrefused')) {
      return WarningFactory.networkError(
        context?.url || 'unknown',
        message
      );
    }

    // HTTPエラーの検出（404など）
    if (code === PAGE_ANALYZE_ERROR_CODES.HTTP_ERROR ||
        message.includes('404') ||
        message.includes('403') ||
        message.includes('500')) {
      const statusMatch = message.match(/(\d{3})/);
      const statusCode = statusMatch?.[1] ? parseInt(statusMatch[1], 10) : 0;
      return WarningFactory.httpError(
        (context?.url as string) ?? 'unknown',
        statusCode
      );
    }

    // ブラウザエラーの検出
    if (code === PAGE_ANALYZE_ERROR_CODES.BROWSER_ERROR ||
        message.toLowerCase().includes('browser') ||
        message.toLowerCase().includes('playwright') ||
        message.toLowerCase().includes('chromium')) {
      return WarningFactory.browserError(message);
    }

    // Vision分析が利用不可の場合
    if (message.toLowerCase().includes('vision') &&
        (message.toLowerCase().includes('unavailable') ||
         message.toLowerCase().includes('not available') ||
         message.toLowerCase().includes('failed'))) {
      return WarningFactory.visionUnavailableSimple();
    }

    // レイアウト固有のエラー
    if (feature === 'layout') {
      if (message.toLowerCase().includes('no sections') ||
          message.toLowerCase().includes('セクションが見つかり')) {
        return WarningFactory.noSectionsDetected(context?.url || 'unknown');
      }
    }

    // モーション固有のエラー
    if (feature === 'motion') {
      if (message.toLowerCase().includes('no animation') ||
          message.toLowerCase().includes('no motion') ||
          message.toLowerCase().includes('アニメーションが見つかり')) {
        return WarningFactory.noAnimationsDetected(context?.url || 'unknown');
      }
    }

    // 品質評価固有のエラー
    if (feature === 'quality') {
      if (message.toLowerCase().includes('low score') ||
          message.toLowerCase().includes('スコアが低')) {
        return WarningFactory.lowQualityScore(50, 'overall');
      }
    }

    // フォールバック: レガシー警告をアクショナブル形式に変換
    const legacyWarning: AnalysisWarning = {
      feature,
      code,
      message,
    };
    return legacyWarningToActionable(legacyWarning);
  }
  return null;
}

/**
 * 複数の分析結果からアクショナブル警告配列を生成
 */
export function extractAllActionableWarnings(
  results: {
    layout?: { success: boolean; error?: { code: string; message: string } };
    motion?: { success: boolean; error?: { code: string; message: string } };
    quality?: { success: boolean; error?: { code: string; message: string } };
  },
  context?: {
    url?: string;
    timeoutMs?: number;
  }
): ActionableWarningType[] {
  const warnings: ActionableWarningType[] = [];

  if (results.layout) {
    const warning = extractActionableWarning('layout', results.layout, context);
    if (warning) warnings.push(warning);
  }

  if (results.motion) {
    const warning = extractActionableWarning('motion', results.motion, context);
    if (warning) warnings.push(warning);
  }

  if (results.quality) {
    const warning = extractActionableWarning('quality', results.quality, context);
    if (warning) warnings.push(warning);
  }

  return warnings;
}
