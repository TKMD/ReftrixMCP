// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * IVisionAnalyzer インターフェース定義
 *
 * ビジョン解析アダプタのプラガブルなインターフェースを定義します。
 * LlamaVision、Claude Vision、Mock等の実装を切り替え可能にするための設計です。
 *
 * @module vision-adapter/interface
 * @see docs/plans/webdesign/00-overview.md (ビジョン解析アダプタ セクション)
 */

import { z } from 'zod';

// =============================================================================
// 特徴タイプ定義
// =============================================================================

/**
 * 抽出する特徴の種類
 */
export type VisionFeatureType =
  | 'layout_structure' // レイアウト構造
  | 'color_palette' // カラーパレット
  | 'typography' // タイポグラフィ
  | 'visual_hierarchy' // 視覚的階層
  | 'whitespace' // 余白・スペーシング
  | 'density' // 情報密度
  | 'rhythm' // 視覚的リズム
  | 'section_boundaries' // セクション境界
  // Reftrix専用Feature Types
  | 'motion_candidates' // アニメーション候補（Vision検出）
  | 'brand_tone' // ブランドトーン分析
  | 'ai_cliches'; // AIクリシェ検出

/**
 * VisionFeatureType の Zod スキーマ
 */
export const visionFeatureTypeSchema = z.enum([
  'layout_structure',
  'color_palette',
  'typography',
  'visual_hierarchy',
  'whitespace',
  'density',
  'rhythm',
  'section_boundaries',
  // Reftrix専用Feature Types
  'motion_candidates',
  'brand_tone',
  'ai_cliches',
]);

// =============================================================================
// 入力オプション
// =============================================================================

/**
 * ビジョン解析の入力オプション
 */
export interface VisionAnalysisOptions {
  /** 解析対象の画像バッファ */
  imageBuffer: Buffer;
  /** 画像のMIMEタイプ */
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** 解析プロンプト（オプション） */
  prompt?: string;
  /** 抽出する特徴の種類 */
  features?: VisionFeatureType[];
  /** タイムアウト（ミリ秒） */
  timeout?: number;
}

/**
 * VisionAnalysisOptions の Zod スキーマ
 */
export const visionAnalysisOptionsSchema = z.object({
  imageBuffer: z.instanceof(Buffer),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  prompt: z.string().optional(),
  features: z.array(visionFeatureTypeSchema).optional(),
  timeout: z.number().int().positive().optional(),
});

// =============================================================================
// 特徴データ型定義
// =============================================================================

/**
 * レイアウト構造データ
 */
export interface LayoutStructureData {
  type: 'layout_structure';
  gridType:
    | 'single-column'
    | 'two-column'
    | 'three-column'
    | 'grid'
    | 'masonry'
    | 'asymmetric';
  mainAreas: string[];
  description: string;
}

/**
 * カラーパレットデータ
 */
export interface ColorPaletteData {
  type: 'color_palette';
  dominantColors: string[]; // HEX colors
  mood: string;
  contrast: 'high' | 'medium' | 'low';
}

/**
 * タイポグラフィデータ
 */
export interface TypographyData {
  type: 'typography';
  headingStyle: string;
  bodyStyle: string;
  hierarchy: string[];
}

/**
 * 視覚的階層データ
 */
export interface VisualHierarchyData {
  type: 'visual_hierarchy';
  focalPoints: string[];
  flowDirection: 'top-to-bottom' | 'left-to-right' | 'z-pattern' | 'f-pattern';
  emphasisTechniques: string[];
}

/**
 * 余白データ
 */
export interface WhitespaceData {
  type: 'whitespace';
  amount: 'minimal' | 'moderate' | 'generous' | 'extreme';
  distribution: 'even' | 'top-heavy' | 'bottom-heavy' | 'centered';
}

/**
 * 情報密度データ
 */
export interface DensityData {
  type: 'density';
  level: 'sparse' | 'balanced' | 'dense' | 'cluttered';
  description: string;
}

/**
 * 視覚的リズムデータ
 */
export interface RhythmData {
  type: 'rhythm';
  pattern: 'regular' | 'irregular' | 'progressive' | 'alternating';
  description: string;
}

/**
 * セクション境界データ
 */
export interface SectionBoundariesData {
  type: 'section_boundaries';
  sections: Array<{
    type: string;
    startY: number;
    endY: number;
    confidence: number;
  }>;
}

// =============================================================================
// Reftrix専用Feature Data
// =============================================================================

/**
 * アニメーション候補データ（Vision検出）
 *
 * スクリーンショットから推定されるアニメーション対象要素。
 * CSS/JS静的解析の補完として使用。
 */
export interface MotionCandidatesData {
  type: 'motion_candidates';
  /** 推定されるアニメーション */
  likelyAnimations: Array<{
    element: string;
    animationType: 'fade-in' | 'slide' | 'scale' | 'rotate' | 'hover-scale' | 'hover-lift' | 'parallax' | 'other';
    confidence: number;
  }>;
  /** インタラクティブ要素 */
  interactiveElements: string[];
  /** スクロールトリガー候補 */
  scrollTriggers: string[];
}

/**
 * ブランドトーンデータ
 *
 * デザインの視覚的トーンとブランドパーソナリティ分析結果。
 */
export interface BrandToneData {
  type: 'brand_tone';
  /** プロフェッショナリズム */
  professionalism: 'minimal' | 'moderate' | 'bold';
  /** 温かみ */
  warmth: 'cold' | 'neutral' | 'warm';
  /** モダンさ */
  modernity: 'classic' | 'contemporary' | 'futuristic';
  /** エネルギー */
  energy: 'calm' | 'balanced' | 'dynamic';
  /** ターゲットオーディエンス */
  targetAudience: 'enterprise' | 'startup' | 'creative' | 'consumer';
  /** 視覚的指標 */
  indicators: string[];
}

/**
 * AIクリシェ検出データ
 *
 * AI生成デザインの典型的パターン検出結果。
 * quality.evaluateのOriginality評価に活用。
 */
export interface AiClichesData {
  type: 'ai_cliches';
  /** 検出されたクリシェ */
  clichesDetected: Array<{
    clicheType: 'gradient_orbs' | 'generic_isometric' | 'meaningless_patterns' | 'oversaturated_gradients' | 'ai_generated_people' | 'floating_ui' | 'generic_hero' | 'symmetrical_layout' | 'other';
    location: string;
    severity: 'low' | 'medium' | 'high';
  }>;
  /** オリジナリティスコア (0-100) */
  originalityScore: number;
  /** 評価 */
  assessment: 'highly-original' | 'mostly-original' | 'moderate-ai-influence' | 'heavy-ai-influence';
  /** 改善提案 */
  suggestions: string[];
}

/**
 * 特徴の詳細データ（種類別）
 */
export type VisionFeatureData =
  | LayoutStructureData
  | ColorPaletteData
  | TypographyData
  | VisualHierarchyData
  | WhitespaceData
  | DensityData
  | RhythmData
  | SectionBoundariesData
  // Reftrix専用
  | MotionCandidatesData
  | BrandToneData
  | AiClichesData;

// =============================================================================
// 特徴データ Zod スキーマ
// =============================================================================

const layoutStructureDataSchema = z.object({
  type: z.literal('layout_structure'),
  gridType: z.enum([
    'single-column',
    'two-column',
    'three-column',
    'grid',
    'masonry',
    'asymmetric',
  ]),
  mainAreas: z.array(z.string()),
  description: z.string(),
});

const colorPaletteDataSchema = z.object({
  type: z.literal('color_palette'),
  dominantColors: z.array(z.string()),
  mood: z.string(),
  contrast: z.enum(['high', 'medium', 'low']),
});

const typographyDataSchema = z.object({
  type: z.literal('typography'),
  headingStyle: z.string(),
  bodyStyle: z.string(),
  hierarchy: z.array(z.string()),
});

const visualHierarchyDataSchema = z.object({
  type: z.literal('visual_hierarchy'),
  focalPoints: z.array(z.string()),
  flowDirection: z.enum(['top-to-bottom', 'left-to-right', 'z-pattern', 'f-pattern']),
  emphasisTechniques: z.array(z.string()),
});

const whitespaceDataSchema = z.object({
  type: z.literal('whitespace'),
  amount: z.enum(['minimal', 'moderate', 'generous', 'extreme']),
  distribution: z.enum(['even', 'top-heavy', 'bottom-heavy', 'centered']),
});

const densityDataSchema = z.object({
  type: z.literal('density'),
  level: z.enum(['sparse', 'balanced', 'dense', 'cluttered']),
  description: z.string(),
});

const rhythmDataSchema = z.object({
  type: z.literal('rhythm'),
  pattern: z.enum(['regular', 'irregular', 'progressive', 'alternating']),
  description: z.string(),
});

const sectionBoundariesDataSchema = z.object({
  type: z.literal('section_boundaries'),
  sections: z.array(
    z.object({
      type: z.string(),
      startY: z.number(),
      endY: z.number(),
      confidence: z.number().min(0).max(1),
    })
  ),
});

// Reftrix専用スキーマ
const motionCandidatesDataSchema = z.object({
  type: z.literal('motion_candidates'),
  likelyAnimations: z.array(
    z.object({
      element: z.string(),
      animationType: z.enum([
        'fade-in',
        'slide',
        'scale',
        'rotate',
        'hover-scale',
        'hover-lift',
        'parallax',
        'other',
      ]),
      confidence: z.number().min(0).max(1),
    })
  ),
  interactiveElements: z.array(z.string()),
  scrollTriggers: z.array(z.string()),
});

const brandToneDataSchema = z.object({
  type: z.literal('brand_tone'),
  professionalism: z.enum(['minimal', 'moderate', 'bold']),
  warmth: z.enum(['cold', 'neutral', 'warm']),
  modernity: z.enum(['classic', 'contemporary', 'futuristic']),
  energy: z.enum(['calm', 'balanced', 'dynamic']),
  targetAudience: z.enum(['enterprise', 'startup', 'creative', 'consumer']),
  indicators: z.array(z.string()),
});

const aiClichesDataSchema = z.object({
  type: z.literal('ai_cliches'),
  clichesDetected: z.array(
    z.object({
      clicheType: z.enum([
        'gradient_orbs',
        'generic_isometric',
        'meaningless_patterns',
        'oversaturated_gradients',
        'ai_generated_people',
        'floating_ui',
        'generic_hero',
        'symmetrical_layout',
        'other',
      ]),
      location: z.string(),
      severity: z.enum(['low', 'medium', 'high']),
    })
  ),
  originalityScore: z.number().min(0).max(100),
  assessment: z.enum([
    'highly-original',
    'mostly-original',
    'moderate-ai-influence',
    'heavy-ai-influence',
  ]),
  suggestions: z.array(z.string()),
});

const visionFeatureDataSchema = z.discriminatedUnion('type', [
  layoutStructureDataSchema,
  colorPaletteDataSchema,
  typographyDataSchema,
  visualHierarchyDataSchema,
  whitespaceDataSchema,
  densityDataSchema,
  rhythmDataSchema,
  sectionBoundariesDataSchema,
  // Reftrix専用
  motionCandidatesDataSchema,
  brandToneDataSchema,
  aiClichesDataSchema,
]);

// =============================================================================
// 抽出された特徴
// =============================================================================

/**
 * 抽出された特徴
 */
export interface VisionFeature {
  /** 特徴の種類 */
  type: VisionFeatureType;
  /** 信頼度 (0-1) */
  confidence: number;
  /** 特徴の詳細データ */
  data: VisionFeatureData;
}

/**
 * VisionFeature の Zod スキーマ
 */
export const visionFeatureSchema = z.object({
  type: visionFeatureTypeSchema,
  confidence: z.number().min(0).max(1),
  data: visionFeatureDataSchema,
});

// =============================================================================
// 解析結果
// =============================================================================

/**
 * ビジョン解析の結果
 */
export interface VisionAnalysisResult {
  /** 解析成功フラグ */
  success: boolean;
  /** 抽出された特徴 */
  features: VisionFeature[];
  /** 生のレスポンス（デバッグ用） */
  rawResponse?: string;
  /** エラーメッセージ */
  error?: string;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
  /** 使用したモデル名 */
  modelName: string;
}

/**
 * VisionAnalysisResult の Zod スキーマ
 */
export const visionAnalysisResultSchema = z.object({
  success: z.boolean(),
  features: z.array(visionFeatureSchema),
  rawResponse: z.string().optional(),
  error: z.string().optional(),
  processingTimeMs: z.number().min(0),
  modelName: z.string().min(1),
});

// =============================================================================
// 型ガード関数
// =============================================================================

/**
 * LayoutStructureDataかどうかを判定する型ガード
 */
export function isLayoutStructureData(
  data: VisionFeatureData
): data is LayoutStructureData {
  return data.type === 'layout_structure';
}

/**
 * ColorPaletteDataかどうかを判定する型ガード
 */
export function isColorPaletteData(
  data: VisionFeatureData
): data is ColorPaletteData {
  return data.type === 'color_palette';
}

/**
 * TypographyDataかどうかを判定する型ガード
 */
export function isTypographyData(
  data: VisionFeatureData
): data is TypographyData {
  return data.type === 'typography';
}

/**
 * VisualHierarchyDataかどうかを判定する型ガード
 */
export function isVisualHierarchyData(
  data: VisionFeatureData
): data is VisualHierarchyData {
  return data.type === 'visual_hierarchy';
}

/**
 * WhitespaceDataかどうかを判定する型ガード
 */
export function isWhitespaceData(
  data: VisionFeatureData
): data is WhitespaceData {
  return data.type === 'whitespace';
}

/**
 * DensityDataかどうかを判定する型ガード
 */
export function isDensityData(data: VisionFeatureData): data is DensityData {
  return data.type === 'density';
}

/**
 * RhythmDataかどうかを判定する型ガード
 */
export function isRhythmData(data: VisionFeatureData): data is RhythmData {
  return data.type === 'rhythm';
}

/**
 * SectionBoundariesDataかどうかを判定する型ガード
 */
export function isSectionBoundariesData(
  data: VisionFeatureData
): data is SectionBoundariesData {
  return data.type === 'section_boundaries';
}

// =============================================================================
// Reftrix専用型ガード関数
// =============================================================================

/**
 * MotionCandidatesDataかどうかを判定する型ガード
 */
export function isMotionCandidatesData(
  data: VisionFeatureData
): data is MotionCandidatesData {
  return data.type === 'motion_candidates';
}

/**
 * BrandToneDataかどうかを判定する型ガード
 */
export function isBrandToneData(
  data: VisionFeatureData
): data is BrandToneData {
  return data.type === 'brand_tone';
}

/**
 * AiClichesDataかどうかを判定する型ガード
 */
export function isAiClichesData(
  data: VisionFeatureData
): data is AiClichesData {
  return data.type === 'ai_cliches';
}

// =============================================================================
// インターフェース定義
// =============================================================================

/**
 * ビジョン解析アダプタインターフェース
 *
 * LlamaVision、Claude Vision、Mock等の実装を切り替え可能にするための
 * プラガブル設計のインターフェースです。
 *
 * @example
 * ```typescript
 * const analyzer: IVisionAnalyzer = new LlamaVisionAdapter();
 *
 * if (await analyzer.isAvailable()) {
 *   const result = await analyzer.analyze({
 *     imageBuffer: screenshotBuffer,
 *     mimeType: 'image/png',
 *     features: ['layout_structure', 'color_palette'],
 *   });
 *
 *   if (result.success) {
 *     const textRep = analyzer.generateTextRepresentation(result);
 *     // textRepをEmbeddingに使用
 *   }
 * }
 * ```
 */
export interface IVisionAnalyzer {
  /** アダプタ名 */
  readonly name: string;

  /** 使用するモデル名 */
  readonly modelName: string;

  /**
   * アダプタが利用可能かチェック
   *
   * @returns 利用可能な場合はtrue
   *
   * @example
   * ```typescript
   * if (await analyzer.isAvailable()) {
   *   // 解析を実行
   * } else {
   *   // フォールバック処理
   * }
   * ```
   */
  isAvailable(): Promise<boolean>;

  /**
   * 画像を解析して特徴を抽出
   *
   * @param options - 解析オプション
   * @returns 解析結果
   *
   * @example
   * ```typescript
   * const result = await analyzer.analyze({
   *   imageBuffer: Buffer.from(imageData),
   *   mimeType: 'image/png',
   *   features: ['layout_structure', 'whitespace'],
   *   timeout: 30000,
   * });
   * ```
   */
  analyze(options: VisionAnalysisOptions): Promise<VisionAnalysisResult>;

  /**
   * テキスト表現を生成（Embedding用）
   *
   * 解析結果をテキストに変換し、Embeddingモデルに入力可能な形式にします。
   * 生成されたテキストはmultilingual-e5-baseなどでベクトル化され、
   * 類似検索に使用されます。
   *
   * @param result - 解析結果
   * @returns テキスト表現
   *
   * @example
   * ```typescript
   * const result = await analyzer.analyze(options);
   * const textRep = analyzer.generateTextRepresentation(result);
   * // textRep例: "Layout: two-column grid with header and sidebar.
   * //            Colors: blue primary (#3B82F6), white background.
   * //            Whitespace: generous, evenly distributed."
   * ```
   */
  generateTextRepresentation(result: VisionAnalysisResult): string;
}

// =============================================================================
// ファクトリ関数型
// =============================================================================

/**
 * ビジョンアダプタのファクトリ関数型
 *
 * アダプタのインスタンスを生成するファクトリ関数の型定義です。
 * DIコンテナやアダプタ切り替えに使用します。
 *
 * @example
 * ```typescript
 * const adapters: Record<string, VisionAdapterFactory> = {
 *   'llama-vision': () => new LlamaVisionAdapter(),
 *   'claude-vision': () => new ClaudeVisionAdapter(apiKey),
 *   'mock': () => new MockVisionAdapter(),
 * };
 *
 * const factory = adapters[config.visionAdapter];
 * const analyzer = factory();
 * ```
 */
export type VisionAdapterFactory = () => IVisionAnalyzer;

// =============================================================================
// Phase 2: Enhanced Mood & Brand Tone Analysis
// =============================================================================

/**
 * Mood type for enhanced analysis
 *
 * 11 distinct mood categories for web design classification
 * Includes 'neutral' as fallback value for low-confidence or unavailable Vision AI results
 */
export type MoodType =
  | 'professional'
  | 'playful'
  | 'minimal'
  | 'bold'
  | 'elegant'
  | 'modern'
  | 'classic'
  | 'energetic'
  | 'calm'
  | 'luxurious'
  | 'neutral';

/**
 * Brand tone type for enhanced analysis
 *
 * 9 distinct brand tone categories
 * Includes 'neutral' as fallback value for low-confidence or unavailable Vision AI results
 */
export type BrandToneType =
  | 'corporate'
  | 'friendly'
  | 'luxury'
  | 'tech-forward'
  | 'creative'
  | 'trustworthy'
  | 'innovative'
  | 'traditional'
  | 'neutral';

/**
 * Color context from Phase 1 deterministic extraction
 *
 * Used to enhance Vision AI analysis with deterministic color data
 */
export interface ColorContextInput {
  /** Dominant colors in HEX format */
  dominantColors?: string[];
  /** Accent colors in HEX format */
  accentColors?: string[];
  /** Theme: light, dark, or mixed */
  theme?: 'light' | 'dark' | 'mixed';
  /** Theme confidence (0-1) */
  themeConfidence?: number;
  /** Background color in HEX format */
  backgroundColor?: string;
  /** Content density (0-1, 1 = most dense) */
  contentDensity?: number;
  /** Whitespace ratio (0-1, 1 = all whitespace) */
  whitespaceRatio?: number;
}

/**
 * Enhanced Vision analysis options with color context
 */
export interface EnhancedVisionAnalysisOptions extends VisionAnalysisOptions {
  /** Include Phase 1 color context in the analysis prompt */
  includeColorContext?: boolean;
  /** Phase 1 extraction results to include in prompt */
  colorContext?: ColorContextInput;
}

/**
 * Mood analysis result
 */
export interface MoodAnalysisResult {
  /** Primary detected mood */
  primaryMood: MoodType;
  /** Secondary mood (if applicable) */
  secondaryMood?: MoodType;
  /** Confidence score (0-1) */
  confidence: number;
  /** Visual indicators that led to this mood detection */
  indicators: string[];
  /** Whether color context was used in analysis */
  colorContextUsed: boolean;
}

/**
 * Enhanced brand tone result with primary/secondary tones
 */
export interface EnhancedBrandToneResult {
  /** Primary brand tone */
  primaryTone: BrandToneType;
  /** Secondary brand tone (if applicable) */
  secondaryTone?: BrandToneType;
  /** Confidence score (0-1) */
  confidence: number;
  /** Professionalism level */
  professionalism: 'minimal' | 'moderate' | 'bold';
  /** Warmth level */
  warmth: 'cold' | 'neutral' | 'warm';
  /** Modernity level */
  modernity: 'classic' | 'contemporary' | 'futuristic';
  /** Energy level */
  energy: 'calm' | 'balanced' | 'dynamic';
  /** Target audience */
  targetAudience: 'enterprise' | 'startup' | 'creative' | 'consumer';
  /** Visual indicators */
  indicators: string[];
  /** Whether color context was used in analysis */
  colorContextUsed: boolean;
}

/**
 * Enhanced analysis result combining mood and brand tone
 */
export interface EnhancedAnalysisResult {
  /** Operation success */
  success: boolean;
  /** Mood analysis result */
  mood?: MoodAnalysisResult;
  /** Brand tone analysis result */
  brandTone?: EnhancedBrandToneResult;
  /** Error message if failed */
  error?: string;
  /** Processing time in milliseconds */
  processingTimeMs: number;
  /** Model name used for analysis */
  modelName: string;
  /** Color context summary (if used) */
  colorContext?: {
    dominantColors: string[];
    theme: 'light' | 'dark' | 'mixed';
    density: number;
  };
  /**
   * Warnings for data quality issues (v0.1.0)
   * Includes low confidence warnings and fallback usage
   */
  warnings?: VisionAnalysisWarning[];
  /**
   * Whether fallback values were used (v0.1.0)
   */
  fallbackUsed?: boolean;
}

/**
 * Warning type for Vision analysis (v0.1.0)
 */
export interface VisionAnalysisWarning {
  /** Warning code */
  code: VisionWarningCode;
  /** Human-readable message */
  message: string;
  /** Field that triggered the warning */
  field?: string;
  /** Actual value that triggered the warning */
  value?: unknown;
  /** Threshold that was violated (if applicable) */
  threshold?: number;
}

/**
 * Warning codes for Vision analysis (v0.1.0)
 */
export type VisionWarningCode =
  | 'LOW_CONFIDENCE_MOOD'
  | 'LOW_CONFIDENCE_BRAND_TONE'
  | 'MOOD_FALLBACK_USED'
  | 'BRAND_TONE_FALLBACK_USED'
  | 'MISSING_INDICATORS'
  | 'PARSE_WARNING';

/**
 * Low confidence threshold for warnings (v0.1.0)
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Default fallback values for mood analysis (v0.1.0)
 */
export const DEFAULT_MOOD_FALLBACK: MoodAnalysisResult = {
  primaryMood: 'professional',
  confidence: 0.3,
  indicators: ['fallback_value'],
  colorContextUsed: false,
};

/**
 * Default fallback values for brand tone analysis (v0.1.0)
 */
export const DEFAULT_BRAND_TONE_FALLBACK: EnhancedBrandToneResult = {
  primaryTone: 'corporate',
  confidence: 0.3,
  professionalism: 'moderate',
  warmth: 'neutral',
  modernity: 'contemporary',
  energy: 'balanced',
  targetAudience: 'consumer',
  indicators: ['fallback_value'],
  colorContextUsed: false,
};

/**
 * Zod schemas for enhanced types
 */
export const moodTypeSchema = z.enum([
  'professional',
  'playful',
  'minimal',
  'bold',
  'elegant',
  'modern',
  'classic',
  'energetic',
  'calm',
  'luxurious',
  'neutral',
]);

export const brandToneTypeSchema = z.enum([
  'corporate',
  'friendly',
  'luxury',
  'tech-forward',
  'creative',
  'trustworthy',
  'innovative',
  'traditional',
  'neutral',
]);

export const colorContextInputSchema = z.object({
  dominantColors: z.array(z.string()).optional(),
  accentColors: z.array(z.string()).optional(),
  theme: z.enum(['light', 'dark', 'mixed']).optional(),
  themeConfidence: z.number().min(0).max(1).optional(),
  backgroundColor: z.string().optional(),
  contentDensity: z.number().min(0).max(1).optional(),
  whitespaceRatio: z.number().min(0).max(1).optional(),
});

export const enhancedVisionAnalysisOptionsSchema = visionAnalysisOptionsSchema.extend({
  includeColorContext: z.boolean().optional(),
  colorContext: colorContextInputSchema.optional(),
});

export const moodAnalysisResultSchema = z.object({
  primaryMood: moodTypeSchema,
  secondaryMood: moodTypeSchema.optional(),
  confidence: z.number().min(0).max(1),
  indicators: z.array(z.string()),
  colorContextUsed: z.boolean(),
});

export const enhancedBrandToneResultSchema = z.object({
  primaryTone: brandToneTypeSchema,
  secondaryTone: brandToneTypeSchema.optional(),
  confidence: z.number().min(0).max(1),
  professionalism: z.enum(['minimal', 'moderate', 'bold']),
  warmth: z.enum(['cold', 'neutral', 'warm']),
  modernity: z.enum(['classic', 'contemporary', 'futuristic']),
  energy: z.enum(['calm', 'balanced', 'dynamic']),
  targetAudience: z.enum(['enterprise', 'startup', 'creative', 'consumer']),
  indicators: z.array(z.string()),
  colorContextUsed: z.boolean(),
});

export const enhancedAnalysisResultSchema = z.object({
  success: z.boolean(),
  mood: moodAnalysisResultSchema.optional(),
  brandTone: enhancedBrandToneResultSchema.optional(),
  error: z.string().optional(),
  processingTimeMs: z.number(),
  modelName: z.string(),
  colorContext: z.object({
    dominantColors: z.array(z.string()),
    theme: z.enum(['light', 'dark', 'mixed']),
    density: z.number(),
  }).optional(),
});
