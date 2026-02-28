// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorldView Analyzer
 *
 * スクリーンショット（Vision LLM）、CSS変数、タイポグラフィ、モーションから
 * Webページの「世界観・雰囲気」を分析するサービス。
 *
 * 分析アプローチ:
 * 1. Vision分析（主）: Ollama llama3.2-visionでスクリーンショットから印象抽出
 * 2. CSS分析（補助）: 色相・明度・彩度からムード推定
 * 3. フォールバック: Vision失敗時はCSS分析のみで推定
 *
 * @module services/narrative/analyzers/worldview.analyzer
 */

import { z } from 'zod';
import type {
  WorldViewResult,
  MoodCategory,
  ColorImpression,
  TypographyPersonality,
  MotionEmotion,
  OverallTone,
} from '../types/narrative.types';
import type { CSSVariableExtractionResult } from '../../visual/css-variable-extractor.service';
import type { TypographyExtractionResult } from '../../visual/typography-extractor.service';
import type { MotionDetectionResult } from '../../page/motion-detector.service';
import { LlamaVisionAdapter, type VisionAnalysisResult } from '../../vision/llama-vision-adapter';
import { isDevelopment, logger } from '../../../utils/logger';

// =============================================================================
// Constants
// =============================================================================

/**
 * 有効なMoodCategory値
 */
export const VALID_MOOD_CATEGORIES: readonly MoodCategory[] = [
  'professional',
  'playful',
  'premium',
  'tech',
  'organic',
  'minimal',
  'bold',
  'elegant',
  'friendly',
  'artistic',
  'trustworthy',
  'energetic',
] as const;

/**
 * デフォルトタイムアウト（Vision CPU完走保証対応）
 */
const DEFAULT_VISION_TIMEOUT_MS = 180000; // 3分（CPU小画像）

/**
 * 最小信頼度閾値
 */
const MIN_CONFIDENCE_THRESHOLD = 0.5;

// =============================================================================
// Types
// =============================================================================

/**
 * WorldView分析入力
 */
export interface WorldViewAnalysisInput {
  /** Base64スクリーンショット */
  screenshot?: string;
  /** CSS変数抽出結果 */
  cssVariables?: CSSVariableExtractionResult;
  /** タイポグラフィ抽出結果 */
  typography?: TypographyExtractionResult;
  /** モーション検出結果 */
  motionPatterns?: MotionDetectionResult;
  /** 分析オプション */
  options?: WorldViewAnalysisOptions;
}

/**
 * WorldView分析オプション
 */
export interface WorldViewAnalysisOptions {
  /** Visionタイムアウト（ms） */
  visionTimeoutMs?: number;
  /** Vision分析を強制スキップ */
  skipVision?: boolean;
}

/**
 * WorldView分析メタデータ
 */
export interface WorldViewAnalysisMetadata {
  /** Vision分析が使用されたか */
  visionUsed: boolean;
  /** Vision分析の信頼度（使用された場合） */
  visionConfidence?: number;
  /** フォールバック理由（Vision未使用時） */
  fallbackReason?: string;
  /** 処理時間（ms） */
  processingTimeMs: number;
}

/**
 * WorldView分析結果（メタデータ付き）
 */
export interface WorldViewAnalysisOutput {
  /** 分析結果 */
  result: WorldViewResult;
  /** メタデータ */
  metadata: WorldViewAnalysisMetadata;
}

// =============================================================================
// Zod Schemas
// =============================================================================

/**
 * Vision LLMからのJSON出力スキーマ
 */
const VisionWorldViewSchema = z.object({
  moodCategory: z.enum(VALID_MOOD_CATEGORIES as unknown as [string, ...string[]]),
  moodDescription: z.string().min(10).max(500),
  colorImpression: z.object({
    overall: z.string().min(5).max(200),
    dominantEmotion: z.string().min(3).max(50),
    harmony: z.enum(['complementary', 'analogous', 'monochromatic', 'triadic', 'split-complementary', 'mixed']),
  }),
  typographyPersonality: z.object({
    style: z.string().min(3).max(100),
    readability: z.enum(['high', 'medium', 'low']),
    hierarchy: z.enum(['clear', 'subtle', 'flat']),
  }),
  overallTone: z.object({
    primary: z.string().min(3).max(50),
    formality: z.number().min(0).max(1),
    energy: z.number().min(0).max(1),
  }),
  confidence: z.number().min(0).max(1),
});

type VisionWorldViewOutput = z.infer<typeof VisionWorldViewSchema>;

// =============================================================================
// Vision Prompt
// =============================================================================

/**
 * WorldView分析用のVisionプロンプト
 */
function getWorldViewAnalysisPrompt(): string {
  const validMoods = VALID_MOOD_CATEGORIES.join(', ');

  return `Analyze this web page screenshot and extract the overall mood, atmosphere, and design tone.

**IMPORTANT**: Return ONLY valid JSON. No explanations, no code examples, no markdown.

**Task**: Identify the visual impression and emotional tone of this web design.

**Valid mood categories**: ${validMoods}

**Analysis Guidelines**:
1. Examine the overall color palette (warm/cool, light/dark, saturated/muted)
2. Assess typography style (modern/classic, bold/elegant, playful/serious)
3. Consider the visual weight and spacing (minimal/dense, balanced/asymmetric)
4. Identify the target audience and purpose

**Return this exact JSON structure**:
{
  "moodCategory": "<one of: ${validMoods}>",
  "moodDescription": "<natural language description of the mood and atmosphere, 20-100 words>",
  "colorImpression": {
    "overall": "<color impression description, e.g., 'warm and inviting', 'cool and professional'>",
    "dominantEmotion": "<primary emotion evoked by colors, e.g., 'trust', 'excitement', 'calm'>",
    "harmony": "<one of: complementary, analogous, monochromatic, triadic, split-complementary, mixed>"
  },
  "typographyPersonality": {
    "style": "<typography style, e.g., 'modern sans-serif', 'classic serif', 'playful display'>",
    "readability": "<one of: high, medium, low>",
    "hierarchy": "<one of: clear, subtle, flat>"
  },
  "overallTone": {
    "primary": "<primary tone word, e.g., 'professional', 'casual', 'luxury'>",
    "formality": <0.0-1.0, where 0=casual, 1=formal>,
    "energy": <0.0-1.0, where 0=calm/static, 1=dynamic/energetic>
  },
  "confidence": <0.0-1.0, confidence in this analysis>
}

**Output ONLY the JSON object, nothing else.**`;
}

// =============================================================================
// CSS-based Analysis (Fallback)
// =============================================================================

/**
 * CSS変数から色彩印象を推定
 */
function analyzeColorFromCSS(
  cssVariables?: CSSVariableExtractionResult
): ColorImpression {
  // デフォルト値
  const defaultImpression: ColorImpression = {
    overall: 'neutral and balanced',
    dominantEmotion: 'neutral',
    harmony: 'mixed',
  };

  if (!cssVariables?.variables || cssVariables.variables.length === 0) {
    return defaultImpression;
  }

  // 色変数を抽出
  const colorVars = cssVariables.variables.filter(v => v.category === 'color');

  if (colorVars.length === 0) {
    return defaultImpression;
  }

  // 色値を解析してヒューリスティクスを適用
  const colorValues = colorVars.map(v => v.value.toLowerCase());
  const hasBlue = colorValues.some(c =>
    c.includes('blue') || c.includes('#0') || c.includes('rgb(0')
  );
  const hasWarm = colorValues.some(c =>
    c.includes('orange') || c.includes('red') || c.includes('yellow')
  );
  const hasDark = colorValues.some(c =>
    c.includes('#1') || c.includes('#2') || c.includes('#0')
  );
  const hasNeutral = colorValues.some(c =>
    c.includes('gray') || c.includes('grey') || c.includes('#f')
  );

  // 印象を推定
  let overall = 'balanced';
  let dominantEmotion = 'neutral';

  if (hasBlue && !hasWarm) {
    overall = 'cool and professional';
    dominantEmotion = 'trust';
  } else if (hasWarm && !hasBlue) {
    overall = 'warm and inviting';
    dominantEmotion = 'energy';
  } else if (hasDark) {
    overall = 'dark and sophisticated';
    dominantEmotion = 'elegance';
  } else if (hasNeutral) {
    overall = 'clean and neutral';
    dominantEmotion = 'clarity';
  }

  return {
    overall,
    dominantEmotion,
    harmony: 'mixed',
  };
}

/**
 * タイポグラフィから性格を推定
 */
function analyzeTypographyPersonality(
  typography?: TypographyExtractionResult
): TypographyPersonality {
  // デフォルト値
  const defaultPersonality: TypographyPersonality = {
    style: 'modern sans-serif',
    readability: 'medium',
    hierarchy: 'subtle',
  };

  if (!typography?.styles || typography.styles.length === 0) {
    return defaultPersonality;
  }

  // フォントファミリーを解析
  const fontFamilies = typography.styles
    .map(s => s.fontFamily?.toLowerCase() ?? '')
    .filter(f => f.length > 0);

  const hasSerif = fontFamilies.some(f =>
    f.includes('serif') && !f.includes('sans-serif')
  );
  const hasSansSerif = fontFamilies.some(f =>
    f.includes('sans-serif') || f.includes('helvetica') || f.includes('arial')
  );
  const hasDisplay = fontFamilies.some(f =>
    f.includes('display') || f.includes('playfair') || f.includes('oswald')
  );

  // スタイルを決定
  let style = 'modern sans-serif';
  if (hasSerif && !hasSansSerif) {
    style = 'classic serif';
  } else if (hasDisplay) {
    style = 'display/decorative';
  }

  // フォントサイズの多様性から階層を推定
  const uniqueSizes = new Set(
    typography.styles.map(s => s.fontSize).filter(Boolean)
  );
  let hierarchy: 'clear' | 'subtle' | 'flat' = 'subtle';
  if (uniqueSizes.size >= 5) {
    hierarchy = 'clear';
  } else if (uniqueSizes.size <= 2) {
    hierarchy = 'flat';
  }

  return {
    style,
    readability: 'medium',
    hierarchy,
  };
}

/**
 * モーションパターンから感情を推定
 */
function analyzeMotionEmotion(
  motionPatterns?: MotionDetectionResult
): MotionEmotion | undefined {
  if (!motionPatterns?.patterns || motionPatterns.patterns.length === 0) {
    return undefined;
  }

  const patterns = motionPatterns.patterns;

  // Durationの平均から速度を推定（MotionPatternはdurationがnumber型）
  const durations = patterns
    .map(p => p.duration)
    .filter((d): d is number => typeof d === 'number' && d > 0);

  const avgDuration = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 300;

  let pace: 'slow' | 'moderate' | 'fast' = 'moderate';
  if (avgDuration > 500) {
    pace = 'slow';
  } else if (avgDuration < 200) {
    pace = 'fast';
  }

  // パターン数から強度を推定
  const intensity = Math.min(1, patterns.length / 20);

  // アクセシビリティ対応をチェック
  const accessibility = patterns.every(
    p => p.accessibility?.respectsReducedMotion !== false
  );

  // 全体的な印象を決定
  let overall = 'smooth and subtle';
  if (pace === 'fast' && intensity > 0.5) {
    overall = 'dynamic and playful';
  } else if (pace === 'slow' && intensity < 0.3) {
    overall = 'elegant and refined';
  }

  return {
    overall,
    pace,
    intensity,
    accessibility,
  };
}

/**
 * CSS分析のみでWorldViewResultを生成（フォールバック）
 */
function generateFallbackWorldView(
  cssVariables?: CSSVariableExtractionResult,
  typography?: TypographyExtractionResult,
  motionPatterns?: MotionDetectionResult
): WorldViewResult {
  const colorImpression = analyzeColorFromCSS(cssVariables);
  const typographyPersonality = analyzeTypographyPersonality(typography);
  const motionEmotion = analyzeMotionEmotion(motionPatterns);

  // MoodCategoryをヒューリスティックで決定
  let moodCategory: MoodCategory = 'professional';

  if (colorImpression.dominantEmotion === 'trust') {
    moodCategory = 'trustworthy';
  } else if (colorImpression.dominantEmotion === 'energy') {
    moodCategory = 'energetic';
  } else if (colorImpression.dominantEmotion === 'elegance') {
    moodCategory = 'elegant';
  } else if (typographyPersonality.style.includes('display')) {
    moodCategory = 'bold';
  } else if (typographyPersonality.style.includes('serif')) {
    moodCategory = 'elegant';
  }

  // Overall Toneを決定
  let formality = 0.5;
  if (moodCategory === 'professional' || moodCategory === 'trustworthy') {
    formality = 0.7;
  }

  const energy = motionEmotion?.intensity ?? 0.5;

  const overallTone: OverallTone = {
    primary: moodCategory,
    formality,
    energy,
  };

  // Mood Descriptionを生成
  const moodDescription = `This design conveys a ${moodCategory} atmosphere with ${colorImpression.overall} colors and ${typographyPersonality.style} typography.`;

  // motionEmotionがundefinedの場合は含めない（exactOptionalPropertyTypes対応）
  const result: WorldViewResult = {
    moodCategory,
    moodDescription,
    colorImpression,
    typographyPersonality,
    overallTone,
  };

  if (motionEmotion !== undefined) {
    result.motionEmotion = motionEmotion;
  }

  return result;
}

// =============================================================================
// WorldViewAnalyzer Class
// =============================================================================

/**
 * WorldView Analyzer
 *
 * Vision LLMとCSS静的分析を組み合わせてWebページの世界観を分析
 */
export class WorldViewAnalyzer {
  private readonly visionAdapter: LlamaVisionAdapter;
  private readonly defaultTimeoutMs: number;

  constructor(options?: { visionTimeoutMs?: number }) {
    this.visionAdapter = new LlamaVisionAdapter({
      enableOptimization: true,
    });
    this.defaultTimeoutMs = options?.visionTimeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;

    if (isDevelopment()) {
      logger.info('[WorldViewAnalyzer] Initialized', {
        defaultTimeoutMs: this.defaultTimeoutMs,
      });
    }
  }

  /**
   * WorldViewを分析
   *
   * @param input - 分析入力
   * @returns 分析結果とメタデータ
   */
  async analyze(input: WorldViewAnalysisInput): Promise<WorldViewAnalysisOutput> {
    const startTime = Date.now();

    // Vision分析をスキップする場合、またはスクリーンショットがない場合
    if (input.options?.skipVision || !input.screenshot) {
      if (isDevelopment()) {
        logger.info('[WorldViewAnalyzer] Skipping Vision analysis', {
          reason: input.options?.skipVision ? 'skipVision option' : 'no screenshot',
        });
      }

      const result = generateFallbackWorldView(
        input.cssVariables,
        input.typography,
        input.motionPatterns
      );

      return {
        result,
        metadata: {
          visionUsed: false,
          fallbackReason: input.options?.skipVision
            ? 'Vision analysis skipped by option'
            : 'No screenshot provided',
          processingTimeMs: Date.now() - startTime,
        },
      };
    }

    // Vision分析を試行
    try {
      const visionResult = await this.analyzeWithVision(
        input.screenshot,
        input.options?.visionTimeoutMs
      );

      if (visionResult && visionResult.response.confidence >= MIN_CONFIDENCE_THRESHOLD) {
        // Vision分析成功
        const result = this.mergeVisionWithCSS(
          visionResult.response,
          input.motionPatterns
        );

        return {
          result,
          metadata: {
            visionUsed: true,
            visionConfidence: visionResult.response.confidence,
            processingTimeMs: Date.now() - startTime,
          },
        };
      }

      // Vision分析の信頼度が低い場合はフォールバック
      if (isDevelopment()) {
        logger.warn('[WorldViewAnalyzer] Vision confidence too low, using fallback', {
          confidence: visionResult?.response.confidence,
          threshold: MIN_CONFIDENCE_THRESHOLD,
        });
      }

      const result = generateFallbackWorldView(
        input.cssVariables,
        input.typography,
        input.motionPatterns
      );

      return {
        result,
        metadata: {
          visionUsed: false,
          fallbackReason: `Vision confidence (${visionResult?.response.confidence ?? 0}) below threshold (${MIN_CONFIDENCE_THRESHOLD})`,
          processingTimeMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      // Vision分析エラー時はフォールバック
      if (isDevelopment()) {
        logger.warn('[WorldViewAnalyzer] Vision analysis failed, using fallback', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const result = generateFallbackWorldView(
        input.cssVariables,
        input.typography,
        input.motionPatterns
      );

      return {
        result,
        metadata: {
          visionUsed: false,
          fallbackReason: `Vision analysis error: ${error instanceof Error ? error.message : String(error)}`,
          processingTimeMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Vision LLMで分析
   */
  private async analyzeWithVision(
    screenshot: string,
    _timeoutMs?: number
  ): Promise<VisionAnalysisResult<VisionWorldViewOutput> | null> {
    const prompt = getWorldViewAnalysisPrompt();

    try {
      const result = await this.visionAdapter.analyzeJSON<VisionWorldViewOutput>(
        screenshot,
        prompt
      );

      // Zodでバリデーション
      const parsed = VisionWorldViewSchema.safeParse(result.response);

      if (!parsed.success) {
        if (isDevelopment()) {
          logger.warn('[WorldViewAnalyzer] Vision response validation failed', {
            errors: parsed.error.errors,
          });
        }
        return null;
      }

      return {
        response: parsed.data,
        metrics: result.metrics,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[WorldViewAnalyzer] Vision API error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * Vision結果をモーション分析で補完
   */
  private mergeVisionWithCSS(
    visionResult: VisionWorldViewOutput,
    motionPatterns?: MotionDetectionResult
  ): WorldViewResult {
    // モーション分析はVision結果に含まれないため、別途分析で補完
    const motionEmotion = analyzeMotionEmotion(motionPatterns);

    // exactOptionalPropertyTypes対応: undefinedの場合はプロパティを含めない
    const result: WorldViewResult = {
      moodCategory: visionResult.moodCategory as MoodCategory,
      moodDescription: visionResult.moodDescription,
      colorImpression: visionResult.colorImpression as ColorImpression,
      typographyPersonality: visionResult.typographyPersonality as TypographyPersonality,
      overallTone: visionResult.overallTone as OverallTone,
    };

    if (motionEmotion !== undefined) {
      result.motionEmotion = motionEmotion;
    }

    return result;
  }

  /**
   * Ollamaサービスが利用可能かチェック
   */
  async isAvailable(): Promise<boolean> {
    return this.visionAdapter.isAvailable();
  }
}

/**
 * デフォルトのWorldViewAnalyzerインスタンスを作成
 */
export function createWorldViewAnalyzer(
  options?: { visionTimeoutMs?: number }
): WorldViewAnalyzer {
  return new WorldViewAnalyzer(options);
}
