// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Text Representation Generator
 *
 * NarrativeAnalysisResultからEmbedding用テキスト表現を生成。
 * multilingual-e5-base（768次元）で有効な形式で出力。
 *
 * @module services/narrative/generators/text-representation.generator
 */

import type {
  WorldViewResult,
  LayoutStructureResult,
  NarrativeAnalysisResult,
  MoodCategory,
} from '../types/narrative.types';

// =============================================================================
// Constants
// =============================================================================

/**
 * e5モデル用プレフィックス
 *
 * - passage: ドキュメント側（保存時）
 * - query: 検索クエリ側（検索時）
 */
export const E5_PREFIX = {
  PASSAGE: 'passage:',
  QUERY: 'query:',
} as const;

/**
 * 最大テキスト長（トークン数概算）
 *
 * e5モデルは512トークンを推奨
 * 1トークン ≈ 4文字（英語）として2048文字を上限
 */
const MAX_TEXT_LENGTH = 2048;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * 文字列を安全にトリム
 */
function safeTrim(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

/**
 * 配列を安全にjoin
 */
function safeJoin(arr: unknown[], separator: string): string {
  return arr.filter((item) => typeof item === 'string' && item.trim()).join(separator);
}

/**
 * 数値を安全に文字列化
 */
function safeNumber(value: unknown, decimals: number = 2): string {
  if (typeof value === 'number' && !isNaN(value)) {
    return value.toFixed(decimals);
  }
  return '';
}

// =============================================================================
// WorldView Text Generation
// =============================================================================

/**
 * WorldViewResultからテキスト部分を生成
 */
function generateWorldViewText(worldView: WorldViewResult): string[] {
  const parts: string[] = [];

  // Mood情報
  if (worldView.moodCategory) {
    parts.push(`design mood: ${worldView.moodCategory}`);
  }
  if (worldView.moodDescription) {
    parts.push(`mood description: ${safeTrim(worldView.moodDescription)}`);
  }

  // Color Impression
  if (worldView.colorImpression) {
    const ci = worldView.colorImpression;
    if (ci.overall) {
      parts.push(`color impression: ${safeTrim(ci.overall)}`);
    }
    if (ci.dominantEmotion) {
      parts.push(`color emotion: ${safeTrim(ci.dominantEmotion)}`);
    }
    if (ci.harmony) {
      parts.push(`color harmony: ${ci.harmony}`);
    }
  }

  // Typography Personality
  if (worldView.typographyPersonality) {
    const tp = worldView.typographyPersonality;
    if (tp.style) {
      parts.push(`typography style: ${safeTrim(tp.style)}`);
    }
    if (tp.readability) {
      parts.push(`typography readability: ${tp.readability}`);
    }
    if (tp.hierarchy) {
      parts.push(`typography hierarchy: ${tp.hierarchy}`);
    }
  }

  // Motion Emotion（オプション）
  if (worldView.motionEmotion) {
    const me = worldView.motionEmotion;
    if (me.overall) {
      parts.push(`motion emotion: ${safeTrim(me.overall)}`);
    }
    if (me.pace) {
      parts.push(`motion pace: ${me.pace}`);
    }
    if (typeof me.intensity === 'number') {
      parts.push(`motion intensity: ${safeNumber(me.intensity)}`);
    }
  }

  // Overall Tone
  if (worldView.overallTone) {
    const ot = worldView.overallTone;
    if (ot.primary) {
      parts.push(`overall tone: ${safeTrim(ot.primary)}`);
    }
    if (typeof ot.formality === 'number') {
      const formalityLabel = ot.formality > 0.7 ? 'formal' : ot.formality > 0.3 ? 'balanced' : 'casual';
      parts.push(`formality: ${formalityLabel}`);
    }
    if (typeof ot.energy === 'number') {
      const energyLabel = ot.energy > 0.7 ? 'dynamic' : ot.energy > 0.3 ? 'balanced' : 'calm';
      parts.push(`energy: ${energyLabel}`);
    }
  }

  return parts;
}

// =============================================================================
// LayoutStructure Text Generation
// =============================================================================

/**
 * LayoutStructureResultからテキスト部分を生成
 */
function generateLayoutStructureText(layoutStructure: LayoutStructureResult): string[] {
  const parts: string[] = [];

  // Grid System
  if (layoutStructure.gridSystem) {
    const gs = layoutStructure.gridSystem;
    const columnsStr = gs.columns === 'fluid' ? 'fluid' : `${gs.columns} columns`;
    parts.push(`layout grid: ${gs.type} ${columnsStr}`);
    if (gs.containerWidth) {
      parts.push(`container width: ${gs.containerWidth}`);
    }
  }

  // Visual Hierarchy
  if (layoutStructure.visualHierarchy) {
    const vh = layoutStructure.visualHierarchy;
    if (vh.sectionFlow) {
      parts.push(`section flow: ${vh.sectionFlow}`);
    }
    if (vh.primaryElements.length > 0) {
      parts.push(`primary elements: ${safeJoin(vh.primaryElements.slice(0, 3), ', ')}`);
    }
    if (vh.weightDistribution) {
      const wd = vh.weightDistribution;
      const dominant = wd.top > wd.middle && wd.top > wd.bottom ? 'top-heavy' :
                       wd.middle > wd.top && wd.middle > wd.bottom ? 'center-focused' :
                       wd.bottom > wd.top && wd.bottom > wd.middle ? 'bottom-heavy' : 'balanced';
      parts.push(`visual weight: ${dominant}`);
    }
  }

  // Spacing Rhythm
  if (layoutStructure.spacingRhythm) {
    const sr = layoutStructure.spacingRhythm;
    if (sr.scaleName) {
      parts.push(`spacing rhythm: ${sr.scaleName}`);
    }
    if (sr.baseUnit) {
      parts.push(`spacing base: ${sr.baseUnit}`);
    }
  }

  // Graphic Elements
  if (layoutStructure.graphicElements) {
    const ge = layoutStructure.graphicElements;

    // Image Layout
    if (ge.imageLayout?.pattern && ge.imageLayout.pattern !== 'none') {
      parts.push(`image layout: ${ge.imageLayout.pattern}`);
    }

    // Decorations
    if (ge.decorations) {
      const decorationParts: string[] = [];
      if (ge.decorations.hasGradients) decorationParts.push('gradients');
      if (ge.decorations.hasShadows) decorationParts.push('shadows');
      if (ge.decorations.hasIllustrations) decorationParts.push('illustrations');
      if (decorationParts.length > 0) {
        parts.push(`decorations: ${decorationParts.join(', ')}`);
      }
    }

    // Visual Balance
    if (ge.visualBalance) {
      const vb = ge.visualBalance;
      if (vb.symmetry) {
        parts.push(`visual balance: ${vb.symmetry}`);
      }
      if (vb.density) {
        parts.push(`density: ${vb.density}`);
      }
      if (typeof vb.whitespace === 'number') {
        const whitespaceLabel = vb.whitespace > 0.5 ? 'spacious' : vb.whitespace > 0.3 ? 'balanced' : 'compact';
        parts.push(`whitespace: ${whitespaceLabel}`);
      }
    }
  }

  return parts;
}

// =============================================================================
// Main Generator
// =============================================================================

/**
 * NarrativeAnalysisResultからtext_representationを生成
 *
 * @param result - 分析結果
 * @returns e5形式のテキスト表現（passage:プレフィックス付き）
 *
 * @example
 * ```typescript
 * const text = generateTextRepresentation(analysisResult);
 * // "passage: web design narrative. design mood: professional. color impression: cool and clean. ..."
 * ```
 */
export function generateTextRepresentation(result: NarrativeAnalysisResult): string {
  const parts: string[] = [];

  // WorldView部分
  const worldViewParts = generateWorldViewText(result.worldView);
  parts.push(...worldViewParts);

  // LayoutStructure部分
  const layoutParts = generateLayoutStructureText(result.layoutStructure);
  parts.push(...layoutParts);

  // テキスト結合
  let text = parts.filter((p) => p.length > 0).join('. ');

  // 長さ制限
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.substring(0, MAX_TEXT_LENGTH - 3) + '...';
  }

  // e5プレフィックス付与
  return `${E5_PREFIX.PASSAGE} web design narrative. ${text}.`;
}

/**
 * WorldViewResultのみからtext_representationを生成
 *
 * @param worldView - 世界観分析結果
 * @returns e5形式のテキスト表現
 */
export function generateWorldViewTextRepresentation(worldView: WorldViewResult): string {
  const parts = generateWorldViewText(worldView);
  let text = parts.filter((p) => p.length > 0).join('. ');

  if (text.length > MAX_TEXT_LENGTH) {
    text = text.substring(0, MAX_TEXT_LENGTH - 3) + '...';
  }

  return `${E5_PREFIX.PASSAGE} web design mood and tone. ${text}.`;
}

/**
 * LayoutStructureResultのみからtext_representationを生成
 *
 * @param layoutStructure - レイアウト構成分析結果
 * @returns e5形式のテキスト表現
 */
export function generateLayoutStructureTextRepresentation(layoutStructure: LayoutStructureResult): string {
  const parts = generateLayoutStructureText(layoutStructure);
  let text = parts.filter((p) => p.length > 0).join('. ');

  if (text.length > MAX_TEXT_LENGTH) {
    text = text.substring(0, MAX_TEXT_LENGTH - 3) + '...';
  }

  return `${E5_PREFIX.PASSAGE} web layout structure. ${text}.`;
}

/**
 * 検索クエリをe5形式に変換
 *
 * @param query - 検索クエリ
 * @returns e5形式のクエリ
 *
 * @example
 * ```typescript
 * const queryText = formatSearchQuery("professional tech website");
 * // "query: professional tech website"
 * ```
 */
export function formatSearchQuery(query: string): string {
  return `${E5_PREFIX.QUERY} ${safeTrim(query)}`;
}

/**
 * MoodCategoryから検索用テキストを生成
 *
 * @param moodCategory - ムードカテゴリ
 * @returns 検索用テキスト
 */
export function moodCategoryToSearchText(moodCategory: MoodCategory): string {
  const descriptions: Record<MoodCategory, string> = {
    professional: 'professional business corporate',
    playful: 'playful fun casual',
    premium: 'premium luxury high-end',
    tech: 'tech technology modern digital',
    organic: 'organic natural eco friendly',
    minimal: 'minimal simple clean',
    bold: 'bold impactful striking',
    elegant: 'elegant sophisticated refined',
    friendly: 'friendly approachable warm',
    artistic: 'artistic creative expressive',
    trustworthy: 'trustworthy reliable secure',
    energetic: 'energetic dynamic vibrant',
  };

  return descriptions[moodCategory] || moodCategory;
}
