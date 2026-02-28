// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision AI Prompts - Ollama Vision APIのプロンプトテンプレート
 *
 * Phase 5 REFACTOR: MoodAnalyzerとBrandToneAnalyzerのプロンプトを統合管理
 *
 * プロンプト設計原則:
 * 1. 有効な値をリストアップして選択を制限
 * 2. JSONフォーマットを明示（構造を示す）
 * 3. 必須フィールドとオプショナルフィールドを区別
 * 4. confidenceスコアの基準を明確化
 *
 * 参照:
 * - apps/mcp-server/src/services/vision/mood.analyzer.ts
 * - apps/mcp-server/src/services/vision/brandtone.analyzer.ts
 */

import { VALID_MOODS } from './mood.analyzer.js';
import {
  VALID_BRAND_TONES,
  PROFESSIONALISM_LEVELS,
  WARMTH_LEVELS,
  MODERNITY_LEVELS,
  ENERGY_LEVELS,
  TARGET_AUDIENCES,
} from './brandtone.analyzer.js';

// =============================================================================
// Theme Analysis Types
// =============================================================================

/**
 * Valid theme types for analysis
 */
export const VALID_THEMES = ['light', 'dark', 'mixed'] as const;
export type ThemeType = (typeof VALID_THEMES)[number];

// =============================================================================
// 型定義
// =============================================================================

/**
 * カラーコンテキスト（プロンプト生成用）
 */
export interface ColorContextForPrompt {
  dominantColors: string[];
  theme: 'light' | 'dark';
  contentDensity: number;
}

// =============================================================================
// Mood分析プロンプト
// =============================================================================

/**
 * Mood分析のベースプロンプト
 */
export function getMoodAnalysisPrompt(): string {
  return `Analyze this screenshot and identify the mood/atmosphere.

Valid moods: ${VALID_MOODS.join(', ')}.

Return JSON:
{
  "primaryMood": "<mood>",
  "secondaryMood": "<mood>",
  "confidence": <0.0-1.0>,
  "indicators": ["<indicator1>", "<indicator2>"],
  "colorContextUsed": false
}

Guidelines:
- primaryMood: The dominant mood/atmosphere (REQUIRED)
- secondaryMood: A secondary mood if present (OPTIONAL)
- confidence: How confident you are in this analysis (0.6-1.0 for valid results)
- indicators: Visual elements that support your analysis (2-5 items)
- colorContextUsed: Set to false for this prompt`;
}

/**
 * カラーコンテキスト付きMood分析プロンプト
 */
export function getMoodAnalysisWithContextPrompt(
  colorContext: ColorContextForPrompt
): string {
  return `Analyze this screenshot and identify the mood/atmosphere.
Consider the following color context:
- Dominant colors: ${colorContext.dominantColors.join(', ')}
- Theme: ${colorContext.theme}
- Content density: ${colorContext.contentDensity}

Valid moods: ${VALID_MOODS.join(', ')}.

Return JSON:
{
  "primaryMood": "<mood>",
  "secondaryMood": "<mood>",
  "confidence": <0.0-1.0>,
  "indicators": ["<indicator1>", "<indicator2>"],
  "colorContextUsed": true
}

Guidelines:
- Use the color context to inform your mood analysis
- primaryMood: The dominant mood/atmosphere (REQUIRED)
- secondaryMood: A secondary mood if present (OPTIONAL)
- confidence: How confident you are in this analysis (0.6-1.0 for valid results)
- indicators: Visual elements that support your analysis (2-5 items)
- colorContextUsed: Set to true as color context was provided`;
}

// =============================================================================
// BrandTone分析プロンプト
// =============================================================================

/**
 * BrandTone分析のベースプロンプト
 */
export function getBrandToneAnalysisPrompt(): string {
  return `Analyze this screenshot and identify the brand tone/atmosphere.

Valid brand tones: ${VALID_BRAND_TONES.join(', ')}.
Professionalism levels: ${PROFESSIONALISM_LEVELS.join(', ')}.
Warmth levels: ${WARMTH_LEVELS.join(', ')}.
Modernity levels: ${MODERNITY_LEVELS.join(', ')}.
Energy levels: ${ENERGY_LEVELS.join(', ')}.
Target audiences: ${TARGET_AUDIENCES.join(', ')}.

Return JSON:
{
  "primaryTone": "<tone>",
  "secondaryTone": "<tone>",
  "confidence": <0.0-1.0>,
  "professionalism": "<level>",
  "warmth": "<level>",
  "modernity": "<level>",
  "energy": "<level>",
  "targetAudience": "<audience>",
  "indicators": ["<indicator1>", "<indicator2>"],
  "colorContextUsed": false
}

Guidelines:
- primaryTone: The dominant brand tone (REQUIRED)
- secondaryTone: A secondary brand tone if present (OPTIONAL)
- confidence: How confident you are in this analysis (0.6-1.0 for valid results)
- professionalism/warmth/modernity/energy: Evaluate each attribute
- targetAudience: Who this design is targeting
- indicators: Visual elements that support your analysis (2-5 items)
- colorContextUsed: Set to false for this prompt`;
}

/**
 * カラーコンテキスト付きBrandTone分析プロンプト
 */
export function getBrandToneAnalysisWithContextPrompt(
  colorContext: ColorContextForPrompt
): string {
  return `Analyze this screenshot and identify the brand tone/atmosphere.
Consider the following color context:
- Dominant colors: ${colorContext.dominantColors.join(', ')}
- Theme: ${colorContext.theme}
- Content density: ${colorContext.contentDensity}

Valid brand tones: ${VALID_BRAND_TONES.join(', ')}.
Professionalism levels: ${PROFESSIONALISM_LEVELS.join(', ')}.
Warmth levels: ${WARMTH_LEVELS.join(', ')}.
Modernity levels: ${MODERNITY_LEVELS.join(', ')}.
Energy levels: ${ENERGY_LEVELS.join(', ')}.
Target audiences: ${TARGET_AUDIENCES.join(', ')}.

Return JSON:
{
  "primaryTone": "<tone>",
  "secondaryTone": "<tone>",
  "confidence": <0.0-1.0>,
  "professionalism": "<level>",
  "warmth": "<level>",
  "modernity": "<level>",
  "energy": "<level>",
  "targetAudience": "<audience>",
  "indicators": ["<indicator1>", "<indicator2>"],
  "colorContextUsed": true
}

Guidelines:
- Use the color context to inform your brand tone analysis
- primaryTone: The dominant brand tone (REQUIRED)
- secondaryTone: A secondary brand tone if present (OPTIONAL)
- confidence: How confident you are in this analysis (0.6-1.0 for valid results)
- professionalism/warmth/modernity/energy: Evaluate each attribute
- targetAudience: Who this design is targeting
- indicators: Visual elements that support your analysis (2-5 items)
- colorContextUsed: Set to true as color context was provided`;
}

// =============================================================================
// Theme分析プロンプト
// =============================================================================

/**
 * Theme分析のベースプロンプト
 *
 * 問題背景:
 * - E&A Financial (#0A1628 ダークブルー) が "Light/Mixed" と誤認識された
 * - 原因: テーマ判定基準が曖昧だった
 *
 * 解決策:
 * - 明確な輝度閾値を指定（DARK < 30%, LIGHT > 70%）
 * - 背景色のHEXコードを要求
 * - JSON形式で構造化された出力
 */
export function getThemeAnalysisPrompt(): string {
  const validThemes = VALID_THEMES.join(', ');

  return `Analyze this web page screenshot and determine the visual theme.

**Theme Detection (CRITICAL - Follow these rules strictly):**

1. Examine the BACKGROUND COLOR of the main content area (not just the header/footer)
2. Determine if the overall theme is DARK, LIGHT, or MIXED using these criteria:

   - DARK Theme: Background luminance < 30% (e.g., #0A1628, #1A1A2E, #000000)
     Examples: Dark navy, black, deep purple backgrounds

   - LIGHT Theme: Background luminance > 70% (e.g., #FFFFFF, #F5F5F5, #FAFAFA)
     Examples: White, off-white, light gray backgrounds

   - MIXED Theme: 30% <= luminance <= 70% OR page has distinct dark AND light sections

3. Extract the PRIMARY BACKGROUND COLOR in HEX format (#RRGGBB)

Valid themes: ${validThemes}.

Return JSON:
{
  "theme": "<theme>",
  "themeConfidence": <0.0-1.0>,
  "primaryBackgroundColor": "#RRGGBB",
  "visualFeatures": ["<feature1>", "<feature2>"],
  "reasoning": "<brief explanation of why this theme was detected>"
}

Guidelines:
- theme: The detected theme (REQUIRED, must be one of: ${validThemes})
- themeConfidence: How confident you are (0.6-1.0 for valid results)
- primaryBackgroundColor: The dominant background color in HEX format (REQUIRED)
- visualFeatures: Visual elements that support your analysis (2-5 items)
- reasoning: Brief explanation including the luminance assessment

IMPORTANT: Dark backgrounds like #0A1628 (dark navy blue) should ALWAYS be classified as "dark", NOT "light" or "mixed".`;
}

/**
 * カラーコンテキスト付きTheme分析プロンプト
 */
export function getThemeAnalysisWithContextPrompt(
  colorContext: ColorContextForPrompt
): string {
  const validThemes = VALID_THEMES.join(', ');

  return `Analyze this web page screenshot and determine the visual theme.

Consider the following color context:
- Dominant colors: ${colorContext.dominantColors.join(', ')}
- Pre-detected theme hint: ${colorContext.theme}
- Content density: ${colorContext.contentDensity}

**Theme Detection (CRITICAL - Follow these rules strictly):**

1. Examine the BACKGROUND COLOR of the main content area
2. Determine if the overall theme is DARK, LIGHT, or MIXED:

   - DARK Theme: Background luminance < 30% (e.g., #0A1628, #1A1A2E, #000000)
   - LIGHT Theme: Background luminance > 70% (e.g., #FFFFFF, #F5F5F5, #FAFAFA)
   - MIXED Theme: 30% <= luminance <= 70% OR distinct dark AND light sections

3. Use the color context to validate your analysis
4. Extract the PRIMARY BACKGROUND COLOR in HEX format (#RRGGBB)

Valid themes: ${validThemes}.

Return JSON:
{
  "theme": "<theme>",
  "themeConfidence": <0.0-1.0>,
  "primaryBackgroundColor": "#RRGGBB",
  "visualFeatures": ["<feature1>", "<feature2>"],
  "reasoning": "<brief explanation>",
  "colorContextUsed": true
}

Guidelines:
- theme: The detected theme (REQUIRED, must be one of: ${validThemes})
- themeConfidence: How confident you are (0.6-1.0 for valid results)
- primaryBackgroundColor: The dominant background color in HEX format (REQUIRED)
- visualFeatures: Visual elements that support your analysis (2-5 items)
- reasoning: Brief explanation including the luminance assessment
- colorContextUsed: Set to true as color context was provided

IMPORTANT: Dark backgrounds like #0A1628 (dark navy blue) should ALWAYS be classified as "dark", NOT "light" or "mixed".`;
}
