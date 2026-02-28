// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Confidence Calculator
 *
 * 各分析結果の信頼度（0-1）を算出。
 *
 * @module services/narrative/generators/confidence-calculator
 */

import type {
  ConfidenceScore,
  ExistingAnalysisResults,
  WorldViewResult,
  LayoutStructureResult,
} from '../types/narrative.types';

// =============================================================================
// Constants
// =============================================================================

/**
 * 信頼度算出の重み
 */
const CONFIDENCE_WEIGHTS = {
  /** Vision分析の重み */
  visionAnalysis: 0.4,
  /** CSS静的分析の重み */
  cssStaticAnalysis: 0.2,
  /** HTML構造分析の重み */
  htmlStructureAnalysis: 0.25,
  /** モーション分析の重み */
  motionAnalysis: 0.15,
} as const;

/**
 * 信頼度しきい値
 */
export const CONFIDENCE_THRESHOLDS = {
  /** 高信頼 */
  HIGH: 0.8,
  /** 中信頼 */
  MEDIUM: 0.6,
  /** 低信頼 */
  LOW: 0.4,
} as const;

/**
 * 信頼度レベル
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'insufficient';

// =============================================================================
// Types
// =============================================================================

/**
 * 分析メタデータ（信頼度算出用）
 */
export interface AnalysisMetadata {
  /** Vision分析が使用されたか */
  visionUsed: boolean;
  /** Vision分析結果（使用された場合） */
  visionResult?: {
    confidence?: number;
  };
  /** Visionフォールバックが発生したか */
  visionFallback: boolean;
}

// =============================================================================
// Main Calculator
// =============================================================================

/**
 * 信頼度スコアを算出
 *
 * @param analysisResults - 既存の分析結果
 * @param metadata - 分析メタデータ
 * @param worldView - 世界観分析結果（オプション）
 * @param layoutStructure - レイアウト構成分析結果（オプション）
 * @returns 信頼度スコア
 */
export function calculateConfidence(
  analysisResults: ExistingAnalysisResults,
  metadata: AnalysisMetadata,
  worldView?: WorldViewResult,
  layoutStructure?: LayoutStructureResult
): ConfidenceScore {
  const breakdown: ConfidenceScore['breakdown'] = {
    visionAnalysis: 0,
    cssStaticAnalysis: 0,
    htmlStructureAnalysis: 0,
    motionAnalysis: 0,
  };

  // 1. Vision分析信頼度
  breakdown.visionAnalysis = calculateVisionConfidence(metadata, worldView);

  // 2. CSS静的分析信頼度
  breakdown.cssStaticAnalysis = calculateCssConfidence(analysisResults);

  // 3. HTML構造分析信頼度
  breakdown.htmlStructureAnalysis = calculateHtmlConfidence(analysisResults, layoutStructure);

  // 4. モーション分析信頼度
  breakdown.motionAnalysis = calculateMotionConfidence(analysisResults);

  // 総合スコア計算（重み付き平均）
  const overall = Object.entries(CONFIDENCE_WEIGHTS).reduce((sum, [key, weight]) => {
    return sum + breakdown[key as keyof typeof breakdown] * weight;
  }, 0);

  // WorldView信頼度（Vision重視）
  const worldViewConfidence = (breakdown.visionAnalysis * 0.6 + breakdown.cssStaticAnalysis * 0.4);

  // LayoutStructure信頼度（HTML構造重視）
  const layoutConfidence = (breakdown.htmlStructureAnalysis * 0.7 + breakdown.cssStaticAnalysis * 0.3);

  return {
    overall: Math.min(1, Math.max(0, overall)),
    worldView: Math.min(1, Math.max(0, worldViewConfidence)),
    layoutStructure: Math.min(1, Math.max(0, layoutConfidence)),
    breakdown,
  };
}

// =============================================================================
// Sub-Calculators
// =============================================================================

/**
 * Vision分析の信頼度を算出
 */
function calculateVisionConfidence(
  metadata: AnalysisMetadata,
  worldView?: WorldViewResult
): number {
  // Vision分析が使用された場合
  if (metadata.visionUsed && metadata.visionResult) {
    // Vision結果から信頼度を取得（デフォルト0.8）
    const baseConfidence = metadata.visionResult.confidence ?? 0.8;

    // WorldView結果の充実度で調整
    if (worldView) {
      const completeness = calculateWorldViewCompleteness(worldView);
      return baseConfidence * (0.7 + completeness * 0.3);
    }

    return baseConfidence;
  }

  // Visionフォールバック時
  if (metadata.visionFallback) {
    return 0.4;
  }

  // Vision未使用（スクリーンショットなし等）
  return 0.3;
}

/**
 * WorldViewの充実度を算出
 */
function calculateWorldViewCompleteness(worldView: WorldViewResult): number {
  let score = 0;
  let total = 0;

  // 必須フィールド
  if (worldView.moodCategory) { score += 1; } total += 1;
  if (worldView.moodDescription && worldView.moodDescription.length > 10) { score += 1; } total += 1;

  // Color Impression
  if (worldView.colorImpression) {
    if (worldView.colorImpression.overall) { score += 0.5; } total += 0.5;
    if (worldView.colorImpression.dominantEmotion) { score += 0.5; } total += 0.5;
  }

  // Typography Personality
  if (worldView.typographyPersonality) {
    if (worldView.typographyPersonality.style) { score += 0.5; } total += 0.5;
    if (worldView.typographyPersonality.readability) { score += 0.5; } total += 0.5;
  }

  // Overall Tone
  if (worldView.overallTone) {
    if (worldView.overallTone.primary) { score += 0.5; } total += 0.5;
    if (typeof worldView.overallTone.formality === 'number') { score += 0.25; } total += 0.25;
    if (typeof worldView.overallTone.energy === 'number') { score += 0.25; } total += 0.25;
  }

  return total > 0 ? score / total : 0;
}

/**
 * CSS静的分析の信頼度を算出
 */
function calculateCssConfidence(analysisResults: ExistingAnalysisResults): number {
  const cssVarCount = analysisResults.cssVariables?.variables.length ?? 0;
  const typographyStyleCount = analysisResults.typography?.styles.length ?? 0;

  // CSS変数の数に基づく信頼度（50変数で最大）
  const cssVarScore = Math.min(1, cssVarCount / 50) * 0.5;

  // タイポグラフィスタイルの数に基づく信頼度（20スタイルで最大）
  const typographyScore = Math.min(1, typographyStyleCount / 20) * 0.3;

  // デザイントークン検出の信頼度
  const designTokenConfidence = analysisResults.cssVariables?.designTokens?.confidence ?? 0;
  const tokenScore = designTokenConfidence * 0.2;

  // ベーススコア0.2を加算（CSS分析が実行されていれば最低限の信頼度）
  const hasData = cssVarCount > 0 || typographyStyleCount > 0;
  const baseScore = hasData ? 0.2 : 0;

  return Math.min(1, baseScore + cssVarScore + typographyScore + tokenScore);
}

/**
 * HTML構造分析の信頼度を算出
 */
function calculateHtmlConfidence(
  analysisResults: ExistingAnalysisResults,
  layoutStructure?: LayoutStructureResult
): number {
  const sectionCount = analysisResults.sections?.length ?? 0;

  // セクション数に基づく信頼度（10セクションで最大）
  const sectionScore = Math.min(1, sectionCount / 10) * 0.5;

  // セクションタイプの多様性
  const sectionTypes = new Set(analysisResults.sections?.map(s => s.type) ?? []);
  const diversityScore = Math.min(1, sectionTypes.size / 5) * 0.2;

  // LayoutStructureの充実度
  let layoutScore = 0;
  if (layoutStructure) {
    layoutScore = calculateLayoutStructureCompleteness(layoutStructure) * 0.3;
  }

  // ベーススコア
  const hasData = sectionCount > 0;
  const baseScore = hasData ? 0.3 : 0;

  return Math.min(1, baseScore + sectionScore + diversityScore + layoutScore);
}

/**
 * LayoutStructureの充実度を算出
 */
function calculateLayoutStructureCompleteness(layoutStructure: LayoutStructureResult): number {
  let score = 0;
  let total = 0;

  // Grid System
  if (layoutStructure.gridSystem) {
    if (layoutStructure.gridSystem.type && layoutStructure.gridSystem.type !== 'none') {
      score += 1;
    }
    total += 1;
  }

  // Visual Hierarchy
  if (layoutStructure.visualHierarchy) {
    if (layoutStructure.visualHierarchy.primaryElements.length > 0) { score += 0.5; } total += 0.5;
    if (layoutStructure.visualHierarchy.sectionFlow) { score += 0.5; } total += 0.5;
  }

  // Spacing Rhythm
  if (layoutStructure.spacingRhythm) {
    if (layoutStructure.spacingRhythm.baseUnit) { score += 0.5; } total += 0.5;
    if (layoutStructure.spacingRhythm.scaleName) { score += 0.5; } total += 0.5;
  }

  // Graphic Elements
  if (layoutStructure.graphicElements) {
    if (layoutStructure.graphicElements.visualBalance) { score += 0.5; } total += 0.5;
    if (layoutStructure.graphicElements.imageLayout?.pattern) { score += 0.5; } total += 0.5;
  }

  return total > 0 ? score / total : 0;
}

/**
 * モーション分析の信頼度を算出
 */
function calculateMotionConfidence(analysisResults: ExistingAnalysisResults): number {
  const motionPatterns = analysisResults.motionPatterns;

  if (!motionPatterns) {
    return 0.5; // モーション分析未実行
  }

  const patternCount = motionPatterns.patterns.length;

  if (patternCount === 0) {
    // モーションなし（これは有効な結果）
    return 0.7;
  }

  // パターン数に基づく信頼度
  const patternScore = Math.min(1, patternCount / 20) * 0.4;

  // アクセシビリティ対応の有無
  const hasReducedMotion = motionPatterns.patterns.every(
    p => p.accessibility.respectsReducedMotion
  );
  const accessibilityScore = hasReducedMotion ? 0.2 : 0;

  // パフォーマンス情報の充実度
  const hasPerformanceInfo = motionPatterns.patterns.every(
    p => p.performance && typeof p.performance.level === 'string'
  );
  const performanceScore = hasPerformanceInfo ? 0.2 : 0;

  // ベーススコア
  const baseScore = 0.3;

  return Math.min(1, baseScore + patternScore + accessibilityScore + performanceScore);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * 信頼度スコアからレベルを判定
 *
 * @param score - 信頼度スコア（0-1）
 * @returns 信頼度レベル
 */
export function getConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= CONFIDENCE_THRESHOLDS.HIGH) {
    return 'high';
  }
  if (score >= CONFIDENCE_THRESHOLDS.MEDIUM) {
    return 'medium';
  }
  if (score >= CONFIDENCE_THRESHOLDS.LOW) {
    return 'low';
  }
  return 'insufficient';
}

/**
 * 信頼度レベルの日本語ラベル
 */
export const CONFIDENCE_LEVEL_LABELS: Record<ConfidenceLevel, string> = {
  high: '高信頼',
  medium: '中信頼',
  low: '低信頼',
  insufficient: '不十分',
};

/**
 * 信頼度に基づく推奨アクション
 *
 * @param level - 信頼度レベル
 * @returns 推奨アクション
 */
export function getRecommendedAction(level: ConfidenceLevel): string {
  switch (level) {
    case 'high':
      return 'そのまま保存';
    case 'medium':
      return '警告付きで保存';
    case 'low':
      return '要レビューフラグを設定';
    case 'insufficient':
      return '再分析を推奨';
  }
}
