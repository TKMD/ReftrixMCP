// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze MCPツールの出力スキーマ定義
 * Output/result schemas for layout, motion, quality, narrative, and job status
 *
 * @module @reftrix/mcp-server/tools/page/output.schemas
 */
import { z } from "zod";
import { gradeSchema, sourceTypeSchema, usageScopeSchema } from "./shared.schemas";

// ============================================================================
// Output Schemas - Layout
// ============================================================================

/** エラー情報スキーマ（共通） */
const errorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
});

/** CSSフレームワークタイプ */
const cssFrameworkTypeSchema = z.enum([
  "tailwind",
  "bootstrap",
  "css_modules",
  "styled_components",
  "vanilla",
  "unknown",
  // No-code / 追加フレームワーク
  "webflow",
  "jquery_ui",
  "squarespace",
  "framer",
  "elementor",
  "wix",
]);

/** CSSフレームワーク複合検出結果スキーマ */
export const cssFrameworkCompositeResultSchema = z.object({
  /** プライマリフレームワーク（最も優勢） */
  primary: cssFrameworkTypeSchema,
  /** セカンダリフレームワーク（併用されている） */
  secondary: z.array(cssFrameworkTypeSchema),
  /** 各フレームワークの信頼度 */
  confidenceMap: z.record(cssFrameworkTypeSchema, z.number().min(0).max(1)),
  /** CSS変数が検出されたか */
  hasCssVariables: z.boolean(),
  /** CSS変数の信頼度（0-1） */
  cssVariablesConfidence: z.number().min(0).max(1).optional(),
});
export type CssFrameworkCompositeResult = z.infer<typeof cssFrameworkCompositeResultSchema>;

/** CSSフレームワーク検出結果スキーマ */
export const cssFrameworkResultSchema = z.object({
  /** 検出されたフレームワーク（primary）- 後方互換性のため維持 */
  framework: cssFrameworkTypeSchema,
  /** 検出信頼度 (0-1) - primary フレームワークの信頼度 */
  confidence: z.number().min(0).max(1),
  /** 検出根拠 */
  evidence: z.array(z.string()),
  /** 複合検出結果 - 複数フレームワークが検出された場合 */
  composite: cssFrameworkCompositeResultSchema.optional(),
});
export type CssFrameworkResult = z.infer<typeof cssFrameworkResultSchema>;

// ============================================================================
// CSS Variable Extraction Schemas (v0.1.0)
// ============================================================================

/**
 * CSS変数（カスタムプロパティ）
 *
 * 外部CSSから抽出されたCSS custom properties。
 * Webサイト構築時の参考データとして活用可能。
 */
export const cssVariableSchema = z.object({
  /** 変数名（--プレフィックス含む） */
  name: z.string(),
  /** 変数値（var()参照を含む場合あり） */
  value: z.string(),
  /** カテゴリ（命名パターンから推測） */
  category: z.enum([
    "color",
    "typography",
    "spacing",
    "border",
    "shadow",
    "layout",
    "animation",
    "other",
  ]),
  /** 定義スコープ（CSSセレクタ） */
  scope: z.string(),
  /** 参照している他の変数名（value内のvar()から抽出） */
  references: z.array(z.string()).optional(),
});
export type CSSVariable = z.infer<typeof cssVariableSchema>;

/**
 * clamp()値
 *
 * レスポンシブデザイン用のfluid値。
 */
export const clampValueSchema = z.object({
  /** CSSプロパティ名 */
  property: z.string(),
  /** CSSセレクタ */
  selector: z.string(),
  /** 最小値 */
  min: z.string(),
  /** 推奨値（可変） */
  preferred: z.string(),
  /** 最大値 */
  max: z.string(),
  /** 元のclamp()文字列 */
  raw: z.string(),
});
export type ClampValue = z.infer<typeof clampValueSchema>;

/**
 * calc()式
 */
export const calcExpressionSchema = z.object({
  /** CSSプロパティ名 */
  property: z.string(),
  /** CSSセレクタ */
  selector: z.string(),
  /** calc()内の式 */
  expression: z.string(),
  /** 元のcalc()文字列 */
  raw: z.string(),
});
export type CalcExpression = z.infer<typeof calcExpressionSchema>;

/**
 * デザイントークン検出情報
 */
export const designTokensInfoSchema = z.object({
  /** 検出されたフレームワーク/システム */
  framework: z.enum(["tailwind", "open-props", "css-in-js", "css-variables", "unknown"]),
  /** 検出信頼度（0-1） */
  confidence: z.number().min(0).max(1),
  /** 検出根拠 */
  evidence: z.array(z.string()),
});
export type DesignTokensInfo = z.infer<typeof designTokensInfoSchema>;

/**
 * CSS変数抽出結果
 *
 * 外部CSS取得時（fetchExternalCss: true）に抽出されるデータ。
 * カラーパレット、タイポグラフィ、スペーシングなどの
 * デザイントークンとして活用可能。
 */
export const cssVariableExtractionResultSchema = z.object({
  /** 抽出されたCSS変数 */
  variables: z.array(cssVariableSchema),
  /** 抽出されたclamp()値 */
  clampValues: z.array(clampValueSchema),
  /** 抽出されたcalc()式 */
  calcExpressions: z.array(calcExpressionSchema),
  /** デザイントークン検出情報 */
  designTokens: designTokensInfoSchema,
  /** 処理時間（ミリ秒） */
  processingTimeMs: z.number().nonnegative(),
});
export type CSSVariableExtractionResult = z.infer<typeof cssVariableExtractionResultSchema>;

export const layoutResultSummarySchema = z.object({
  success: z.boolean(),
  pageId: z.string().uuid().optional(),
  sectionCount: z.number().int().nonnegative(),
  sectionTypes: z.record(z.number().int().nonnegative()),
  processingTimeMs: z.number().nonnegative(),
  error: errorInfoSchema.optional(),
  /** CSSフレームワーク検出結果 */
  cssFramework: cssFrameworkResultSchema.optional(),
  /** CSSスニペット（ページ全体から抽出） */
  cssSnippet: z.string().optional(),
});

export const sectionDetailSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  positionIndex: z.number().int().nonnegative(),
  heading: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export const screenshotSchema = z.object({
  base64: z.string(),
  format: z.enum(["png", "jpeg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** Vision API 解析結果の特徴スキーマ */
export const visionFeatureSchema = z.object({
  type: z.string(),
  confidence: z.number().min(0).max(1),
  description: z.string().optional(),
  boundingBox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});
export type VisionFeature = z.infer<typeof visionFeatureSchema>;

/** Vision API 解析結果スキーマ */
export const visionFeaturesResultSchema = z.object({
  /** 解析成功フラグ */
  success: z.boolean(),
  /** 検出された特徴一覧 */
  features: z.array(visionFeatureSchema),
  /** エラーメッセージ（失敗時） */
  error: z.string().optional(),
  /** 処理時間（ms） */
  processingTimeMs: z.number().nonnegative(),
  /** 使用モデル名 */
  modelName: z.string(),
});
export type VisionFeaturesResult = z.infer<typeof visionFeaturesResultSchema>;

// ============================================================================
// Visual Features Schemas (Phase 3-1: Deterministic Extraction Results)
// ============================================================================

/**
 * HEXカラー文字列パターン（JSON injection対策）
 * 例: #FFFFFF, #000000, #1a2b3c
 */
const hexColorPattern = /^#[0-9A-Fa-f]{6}$/;

/** カラーパレットアイテムスキーマ */
export const colorPaletteItemSchema = z.object({
  /** HEX形式のカラーコード (#RRGGBB) */
  color: z.string().regex(hexColorPattern, "Invalid HEX color format"),
  /** 画像内での占有率 (0-100) */
  percentage: z.number().min(0).max(100),
});
export type ColorPaletteItem = z.infer<typeof colorPaletteItemSchema>;

/** Visual Features: Colors (ColorExtractionResult相当) */
export const visualFeaturesColorsSchema = z.object({
  /** 支配色（最大5色） */
  dominant: z.array(z.string().regex(hexColorPattern)).max(5),
  /** アクセントカラー（最大3色） */
  accent: z.array(z.string().regex(hexColorPattern)).max(3),
  /** カラーパレット（占有率付き、最大100色） */
  palette: z.array(colorPaletteItemSchema).max(100),
  /** データソース */
  source: z.literal("deterministic"),
  /** 信頼度 (0.9-1.0) */
  confidence: z.number().min(0).max(1),
});
export type VisualFeaturesColors = z.infer<typeof visualFeaturesColorsSchema>;

/** Visual Features: Theme (ThemeDetectionResult相当) */
export const visualFeaturesThemeSchema = z.object({
  /** テーマタイプ */
  type: z.enum(["light", "dark", "mixed"]),
  /** 推定背景色 */
  backgroundColor: z.string().regex(hexColorPattern),
  /** 推定テキスト色 */
  textColor: z.string().regex(hexColorPattern),
  /** WCAGコントラスト比 (1-21) */
  contrastRatio: z.number().min(1).max(21),
  /** 輝度情報 */
  luminance: z.object({
    /** 背景の相対輝度 (0-1) */
    background: z.number().min(0).max(1),
    /** 前景/テキストの相対輝度 (0-1) */
    foreground: z.number().min(0).max(1),
  }),
  /** データソース */
  source: z.literal("deterministic"),
  /** 信頼度 (0.9-1.0) */
  confidence: z.number().min(0).max(1),
});
export type VisualFeaturesTheme = z.infer<typeof visualFeaturesThemeSchema>;

/** 領域分析結果スキーマ */
export const regionAnalysisSchema = z.object({
  /** 領域ID */
  id: z.string(),
  /** X座標 */
  x: z.number().nonnegative(),
  /** Y座標 */
  y: z.number().nonnegative(),
  /** 幅 */
  width: z.number().positive(),
  /** 高さ */
  height: z.number().positive(),
  /** コンテンツ密度 (0-1) */
  density: z.number().min(0).max(1),
  /** エッジ強度 */
  edgeIntensity: z.number().nonnegative(),
});
export type RegionAnalysis = z.infer<typeof regionAnalysisSchema>;

/** 密度メトリクススキーマ */
export const densityMetricsSchema = z.object({
  /** 総ピクセル数 */
  totalPixels: z.number().int().positive(),
  /** コンテンツピクセル数 */
  contentPixels: z.number().int().nonnegative(),
  /** 平均エッジ強度 */
  averageEdgeIntensity: z.number().nonnegative(),
  /** 標準偏差 */
  standardDeviation: z.number().nonnegative(),
});
export type DensityMetrics = z.infer<typeof densityMetricsSchema>;

/** Visual Features: Density (DensityCalculationResult相当) */
export const visualFeaturesDensitySchema = z.object({
  /** コンテンツ密度 (0-1) */
  contentDensity: z.number().min(0).max(1),
  /** ホワイトスペース比率 (0-1) */
  whitespaceRatio: z.number().min(0).max(1),
  /** 視覚的バランススコア (0-100) */
  visualBalance: z.number().min(0).max(100),
  /** 領域分析結果（最大50件） */
  regions: z.array(regionAnalysisSchema).max(50).optional(),
  /** 密度メトリクス */
  metrics: densityMetricsSchema.optional(),
  /** データソース */
  source: z.literal("deterministic"),
  /** 信頼度 (0.9-1.0) */
  confidence: z.number().min(0).max(1),
});
export type VisualFeaturesDensity = z.infer<typeof visualFeaturesDensitySchema>;

/** カラーストップスキーマ */
export const colorStopSchema = z.object({
  /** 位置 (0-1) */
  position: z.number().min(0).max(1),
  /** カラーコード */
  color: z.string().regex(hexColorPattern),
  /** 不透明度 (0-1) */
  opacity: z.number().min(0).max(1).optional(),
});
export type ColorStop = z.infer<typeof colorStopSchema>;

/** グラデーション領域スキーマ */
export const gradientRegionSchema = z.object({
  /** X座標 */
  x: z.number().nonnegative(),
  /** Y座標 */
  y: z.number().nonnegative(),
  /** 幅 */
  width: z.number().positive(),
  /** 高さ */
  height: z.number().positive(),
});
export type GradientRegion = z.infer<typeof gradientRegionSchema>;

/** 検出されたグラデーションスキーマ */
export const detectedGradientSchema = z.object({
  /** グラデーションタイプ */
  type: z.enum(["linear", "radial", "conic"]),
  /** 方向（linear用、度数） */
  direction: z.number().optional(),
  /** 中心X座標（radial/conic用） */
  centerX: z.number().optional(),
  /** 中心Y座標（radial/conic用） */
  centerY: z.number().optional(),
  /** カラーストップ */
  colorStops: z.array(colorStopSchema),
  /** 検出領域 */
  region: gradientRegionSchema,
  /** 検出信頼度 (0-1) */
  confidence: z.number().min(0).max(1),
});
export type DetectedGradient = z.infer<typeof detectedGradientSchema>;

/** Visual Features: Gradient (GradientDetectionResult相当) */
export const visualFeaturesGradientSchema = z.object({
  /** グラデーションが存在するか */
  hasGradient: z.boolean(),
  /** 検出されたグラデーント配列（最大20件） */
  gradients: z.array(detectedGradientSchema).max(20),
  /** 支配的なグラデーションタイプ */
  dominantGradientType: z.enum(["linear", "radial", "conic"]).optional(),
  /** 検出信頼度 (0-1) */
  confidence: z.number().min(0).max(1),
  /** 処理時間（ms） */
  processingTimeMs: z.number().nonnegative(),
  /** データソース */
  source: z.literal("deterministic"),
});
export type VisualFeaturesGradient = z.infer<typeof visualFeaturesGradientSchema>;

/** ムードタイプ */
export const moodTypeSchema = z.enum([
  "calm",
  "energetic",
  "professional",
  "playful",
  "luxurious",
  "minimalist",
  "bold",
  "elegant",
  "friendly",
  "serious",
]);
export type MoodType = z.infer<typeof moodTypeSchema>;

/** Visual Features: Mood (Vision AI analysis result) */
export const visualFeaturesMoodSchema = z
  .object({
    /** 主要ムード */
    primary: moodTypeSchema,
    /** 副次ムード */
    secondary: moodTypeSchema.optional(),
    /** データソース */
    source: z.literal("vision-ai"),
    /** 信頼度 (0.6-0.8) */
    confidence: z.number().min(0).max(1),
  })
  .nullable();
export type VisualFeaturesMood = z.infer<typeof visualFeaturesMoodSchema>;

/** ブランドトーンタイプ */
export const brandToneTypeSchema = z.enum([
  "corporate",
  "startup",
  "luxury",
  "eco-friendly",
  "tech-forward",
  "traditional",
  "innovative",
  "trustworthy",
  "creative",
  "accessible",
]);
export type BrandToneType = z.infer<typeof brandToneTypeSchema>;

/** Visual Features: BrandTone (Vision AI analysis result) */
export const visualFeaturesBrandToneSchema = z
  .object({
    /** 主要ブランドトーン */
    primary: brandToneTypeSchema,
    /** 副次ブランドトーン */
    secondary: brandToneTypeSchema.optional(),
    /** データソース */
    source: z.literal("vision-ai"),
    /** 信頼度 (0.6-0.8) */
    confidence: z.number().min(0).max(1),
  })
  .nullable();
export type VisualFeaturesBrandTone = z.infer<typeof visualFeaturesBrandToneSchema>;

/** visionAnalysis警告コード */
export const visionAnalysisWarningCodeSchema = z.enum([
  /** mood分析結果が空または低信頼度でフォールバック値を使用 */
  "MOOD_FALLBACK_USED",
  /** brandTone分析結果が空または低信頼度でフォールバック値を使用 */
  "BRAND_TONE_FALLBACK_USED",
  /** Vision AIサービスが利用不可 */
  "VISION_AI_UNAVAILABLE",
  /** 信頼度が低い（0.5未満） */
  "LOW_CONFIDENCE",
  /** 決定論的抽出の一部が失敗 */
  "DETERMINISTIC_EXTRACTION_PARTIAL",
]);
export type VisionAnalysisWarningCode = z.infer<typeof visionAnalysisWarningCodeSchema>;

/** visionAnalysis警告スキーマ */
export const visionAnalysisWarningSchema = z.object({
  /** 警告コード */
  code: visionAnalysisWarningCodeSchema,
  /** 警告メッセージ */
  message: z.string(),
  /** 関連フィールド */
  field: z.string().optional(),
  /** 詳細情報 */
  details: z.record(z.unknown()).optional(),
});
export type VisionAnalysisWarning = z.infer<typeof visionAnalysisWarningSchema>;

/** マージメタデータスキーマ */
export const mergeMetadataSchema = z.object({
  /** マージ日時（ISO8601） */
  mergedAt: z.string().datetime(),
  /** 決定論的データが利用可能か */
  deterministicAvailable: z.boolean(),
  /** Vision AIデータが利用可能か */
  visionAiAvailable: z.boolean(),
  /** 全体の信頼度 (0-1) */
  overallConfidence: z.number().min(0).max(1),
  /**
   * 完全性スコア (0-1)
   *
   * 必須フィールド（colors, theme, density, mood, brandTone）の充足度を表す。
   * - 1.0: すべての必須フィールドが有効なデータを持つ
   * - 0.8: 4/5のフィールドが有効
   * - 0.6: 3/5のフィールドが有効
   * - 0.4: 2/5のフィールドが有効
   * - 0.2: 1/5のフィールドが有効
   * - 0.0: すべてのフィールドが空またはフォールバック
   *
   * フォールバック値が使用されている場合、そのフィールドは0.5としてカウント
   */
  completeness: z.number().min(0).max(1),
  /** 警告配列 */
  warnings: z.array(visionAnalysisWarningSchema),
});
export type MergeMetadata = z.infer<typeof mergeMetadataSchema>;

/**
 * Visual Features: 統合スキーマ (MergedVisualFeatures相当)
 *
 * Phase 1（決定論的抽出）とPhase 2（Vision AI分析）の結果を統合した構造。
 * 既存のvisionFeatures（Vision API解析結果）とは別のフィールド。
 *
 * すべてのフィールドはオプショナル（失敗時もpage.analyzeを壊さない）
 */
export const visualFeaturesSchema = z.object({
  /** カラー抽出結果 */
  colors: visualFeaturesColorsSchema.nullable().optional(),
  /** テーマ検出結果 */
  theme: visualFeaturesThemeSchema.nullable().optional(),
  /** 密度計算結果 */
  density: visualFeaturesDensitySchema.nullable().optional(),
  /** グラデーション検出結果 */
  gradient: visualFeaturesGradientSchema.nullable().optional(),
  /** ムード分析結果（Vision AI） */
  mood: visualFeaturesMoodSchema.optional(),
  /** ブランドトーン分析結果（Vision AI） */
  brandTone: visualFeaturesBrandToneSchema.optional(),
  /** マージメタデータ */
  metadata: mergeMetadataSchema.optional(),
});
export type VisualFeatures = z.infer<typeof visualFeaturesSchema>;

export const layoutResultFullSchema = layoutResultSummarySchema.extend({
  html: z.string().optional(),
  screenshot: screenshotSchema.optional(),
  sections: z.array(sectionDetailSchema).optional(),
  /** Vision API 解析結果（useVision=true 時のみ） */
  visionFeatures: visionFeaturesResultSchema.optional(),
  /** Embedding用テキスト表現（Vision解析結果から生成） */
  textRepresentation: z.string().optional(),
  /**
   * Visual Feature抽出結果（Phase 1/2統合）
   *
   * Phase 1: 決定論的抽出（colors, theme, density, gradient）
   * Phase 2: Vision AI分析（mood, brandTone）
   *
   * visionFeaturesとは別物:
   * - visionFeatures: Vision API（Ollama）による直接的な画像解析結果
   * - visualFeatures: 画像処理アルゴリズムによる特徴抽出結果
   */
  visualFeatures: visualFeaturesSchema.optional(),
  /**
   * CSS変数抽出結果（v0.1.0追加）
   *
   * 外部CSS取得時（fetchExternalCss: true）に抽出されるデータ。
   * カラーパレット、タイポグラフィ、スペーシングなどの
   * デザイントークンとして活用可能。
   *
   * 用途:
   * - Webサイト構築時の参考データ
   * - デザインシステムの分析
   * - ブランドカラー/タイポグラフィの把握
   */
  cssVariables: cssVariableExtractionResultSchema.optional(),
});

export type LayoutResultSummary = z.infer<typeof layoutResultSummarySchema>;
export type LayoutResultFull = z.infer<typeof layoutResultFullSchema>;
export type LayoutResult = LayoutResultSummary | LayoutResultFull;

// ============================================================================
// Output Schemas - Motion
// ============================================================================

export const motionResultSummarySchema = z.object({
  success: z.boolean(),
  patternCount: z.number().int().nonnegative(),
  categoryBreakdown: z.record(z.number().int().nonnegative()),
  warningCount: z.number().int().nonnegative(),
  a11yWarningCount: z.number().int().nonnegative(),
  perfWarningCount: z.number().int().nonnegative(),
  processingTimeMs: z.number().nonnegative(),
  error: errorInfoSchema.optional(),
});

export const patternDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["css_animation", "css_transition", "keyframes"]),
  category: z.string(),
  trigger: z.string(),
  duration: z.number().nonnegative(),
  easing: z.string(),
  properties: z.array(z.string()),
  performance: z.object({
    level: z.enum(["good", "acceptable", "poor"]),
    usesTransform: z.boolean(),
    usesOpacity: z.boolean(),
  }),
  accessibility: z.object({
    respectsReducedMotion: z.boolean(),
  }),
});

export const warningDetailSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string(),
});

// ============================================================================
// Video Mode Output Schemas - Frame Capture & Frame Analysis Results
// ============================================================================

/** フレームファイル情報スキーマ */
export const frameFileInfoSchema = z.object({
  frame_number: z.number().int().nonnegative(),
  scroll_position_px: z.number().nonnegative(),
  timestamp_ms: z.number().nonnegative(),
  file_path: z.string(),
});
export type FrameFileInfo = z.infer<typeof frameFileInfoSchema>;

/** フレームキャプチャ結果スキーマ */
export const frameCaptureResultSchema = z.object({
  total_frames: z.number().int().nonnegative(),
  output_dir: z.string(),
  config: z.object({
    scroll_px_per_frame: z.number().positive(),
    frame_interval_ms: z.number().positive(),
    output_format: z.enum(["png", "jpeg"]),
    output_dir: z.string(),
    filename_pattern: z.string(),
  }),
  files: z.array(frameFileInfoSchema),
  duration_ms: z.number().int().nonnegative(),
});
export type FrameCaptureResult = z.infer<typeof frameCaptureResultSchema>;

/** フレーム分析タイムラインエントリスキーマ */
export const frameAnalysisTimelineEntrySchema = z.object({
  frame_index: z.number().int().nonnegative(),
  diff_percentage: z.number().min(0).max(1),
  layout_shift_score: z.number().min(0).optional(),
  motion_vectors: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        magnitude: z.number().nonnegative(),
      })
    )
    .optional(),
});
export type FrameAnalysisTimelineEntry = z.infer<typeof frameAnalysisTimelineEntrySchema>;

/** フレーム分析サマリースキーマ */
export const frameAnalysisSummarySchema = z.object({
  max_diff: z.number().min(0).max(1),
  avg_diff: z.number().min(0).max(1),
  total_layout_shifts: z.number().int().nonnegative(),
  cls_score: z.number().min(0).optional(),
  significant_change_frames: z.array(z.number().int().nonnegative()),
  processing_time_ms: z.number().nonnegative(),
});
export type FrameAnalysisSummary = z.infer<typeof frameAnalysisSummarySchema>;

/** フレーム画像分析結果スキーマ */
export const frameAnalysisResultSchema = z.object({
  timeline: z.array(frameAnalysisTimelineEntrySchema),
  summary: frameAnalysisSummarySchema,
});
export type FrameAnalysisResult = z.infer<typeof frameAnalysisResultSchema>;

// ============================================================================
// JS Animation Output Schemas (CDP + Web Animations API + Library Detection)
// ============================================================================

/** CDP Animation ソース情報スキーマ */
export const cdpAnimationSourceSchema = z.object({
  duration: z.number().nonnegative(),
  delay: z.number(),
  iterations: z.number(),
  direction: z.string(),
  easing: z.string(),
  keyframesRule: z
    .object({
      name: z.string().optional(),
      keyframes: z
        .array(
          z.object({
            offset: z.string(),
            easing: z.string(),
            style: z.string().optional(),
          })
        )
        .optional(),
    })
    .optional(),
});
export type CDPAnimationSource = z.infer<typeof cdpAnimationSourceSchema>;

/** CDP経由で検出されたアニメーションスキーマ */
export const cdpAnimationSchema = z.object({
  id: z.string(),
  name: z.string(),
  pausedState: z.boolean(),
  playState: z.string(),
  playbackRate: z.number(),
  startTime: z.number(),
  currentTime: z.number(),
  type: z.enum(["CSSAnimation", "CSSTransition", "WebAnimation"]),
  source: cdpAnimationSourceSchema,
});
export type CDPAnimation = z.infer<typeof cdpAnimationSchema>;

/** Web Animations API で検出されたアニメーションスキーマ */
export const webAnimationSchema = z.object({
  id: z.string(),
  playState: z.string(),
  target: z.string(),
  timing: z.object({
    duration: z.number().nonnegative(),
    delay: z.number(),
    iterations: z.number(),
    direction: z.string(),
    easing: z.string(),
    fill: z.string(),
  }),
  keyframes: z.array(
    z
      .object({
        offset: z.number().nullable(),
        easing: z.string(),
        composite: z.string(),
      })
      .passthrough()
  ),
});
export type WebAnimation = z.infer<typeof webAnimationSchema>;

/** ライブラリ検出結果スキーマ */
export const libraryDetectionResultSchema = z.object({
  gsap: z.object({
    detected: z.boolean(),
    version: z.string().optional(),
    tweens: z.number().int().nonnegative().optional(),
  }),
  framerMotion: z.object({
    detected: z.boolean(),
    elements: z.number().int().nonnegative().optional(),
  }),
  anime: z.object({
    detected: z.boolean(),
    instances: z.number().int().nonnegative().optional(),
  }),
  three: z.object({
    detected: z.boolean(),
    scenes: z.number().int().nonnegative().optional(),
  }),
  lottie: z.object({
    detected: z.boolean(),
    animations: z.number().int().nonnegative().optional(),
  }),
});
export type LibraryDetectionResult = z.infer<typeof libraryDetectionResultSchema>;

/** JSアニメーション検出結果スキーマ */
export const jsAnimationResultSchema = z.object({
  cdpAnimations: z.array(cdpAnimationSchema),
  webAnimations: z.array(webAnimationSchema),
  libraries: libraryDetectionResultSchema,
  detectionTimeMs: z.number().nonnegative(),
  totalDetected: z.number().int().nonnegative(),
});
export type JSAnimationResultOutput = z.infer<typeof jsAnimationResultSchema>;

/** JSアニメーション検出サマリースキーマ */
export const jsAnimationSummarySchema = z.object({
  cdpAnimationCount: z.number().int().nonnegative(),
  webAnimationCount: z.number().int().nonnegative(),
  detectedLibraries: z.array(z.string()),
  totalDetected: z.number().int().nonnegative(),
  detectionTimeMs: z.number().nonnegative(),
});
export type JSAnimationSummary = z.infer<typeof jsAnimationSummarySchema>;

// ============================================================================
// WebGL Animation Output Schemas (v0.1.0)
// ============================================================================

/** WebGLアニメーションパターンスキーマ */
export const webglAnimationPatternSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum([
    "fade",
    "pulse",
    "wave",
    "particle",
    "morph",
    "rotation",
    "parallax",
    "noise",
    "complex",
  ]),
  detectedLibrary: z.string().optional(),
  canvasSelector: z.string(),
  animationCharacteristics: z.object({
    averageChangeRate: z.number(),
    peakChangeRate: z.number(),
    changePattern: z.enum(["continuous", "pulsed", "irregular"]),
    dominantColors: z.array(z.string()).optional(),
  }),
  duration: z.number().nonnegative().optional(),
  confidence: z.number().min(0).max(1),
});
export type WebGLAnimationPattern = z.infer<typeof webglAnimationPatternSchema>;

/** WebGLアニメーション検出結果スキーマ */
export const webglAnimationResultSchema = z.object({
  patterns: z.array(webglAnimationPatternSchema),
  summary: z.object({
    totalCanvasElements: z.number().int().nonnegative(),
    animatedCanvasCount: z.number().int().nonnegative(),
    detectedLibraries: z.array(z.string()),
    totalPatterns: z.number().int().nonnegative(),
  }),
  detectionTimeMs: z.number().nonnegative(),
});
export type WebGLAnimationResult = z.infer<typeof webglAnimationResultSchema>;

/** WebGLアニメーション検出サマリースキーマ */
export const webglAnimationSummarySchema = z.object({
  totalCanvasElements: z.number().int().nonnegative(),
  animatedCanvasCount: z.number().int().nonnegative(),
  detectedLibraries: z.array(z.string()),
  totalPatterns: z.number().int().nonnegative(),
  detectionTimeMs: z.number().nonnegative(),
});
export type WebGLAnimationSummary = z.infer<typeof webglAnimationSummarySchema>;

// ============================================================================
// Motion Result Schemas (Extended with Video Mode + JS Animation + WebGL Animation)
// ============================================================================

export const motionResultFullSchema = motionResultSummarySchema.extend({
  patterns: z.array(patternDetailSchema).optional(),
  warnings: z.array(warningDetailSchema).optional(),

  // === Video Mode 結果 ===
  /** フレームキャプチャ結果（enable_frame_capture=true時のみ） */
  frame_capture: frameCaptureResultSchema.optional(),
  /** フレーム画像分析結果（analyze_frames=true時のみ） */
  frame_analysis: frameAnalysisResultSchema.optional(),
  /** フレームキャプチャエラー（失敗時） */
  frame_capture_error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  /** フレーム画像分析エラー（失敗時） */
  frame_analysis_error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),

  // === JS Animation 結果 (v0.1.0) ===
  /** JSアニメーション検出サマリー（detect_js_animations=true時のみ） */
  js_animation_summary: jsAnimationSummarySchema.optional(),
  /** JSアニメーション検出結果（詳細）（summary=false時のみ） */
  js_animations: jsAnimationResultSchema.optional(),
  /** JSアニメーション検出エラー（失敗時） */
  js_animation_error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),

  // === WebGL Animation 結果 (v0.1.0) ===
  /** WebGLアニメーション検出サマリー（detect_webgl_animations=true時のみ） */
  webgl_animation_summary: webglAnimationSummarySchema.optional(),
  /** WebGLアニメーション検出結果（詳細）（summary=false時のみ） */
  webgl_animations: webglAnimationResultSchema.optional(),
  /** WebGLアニメーション検出エラー（失敗時） */
  webgl_animation_error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export type MotionResultSummary = z.infer<typeof motionResultSummarySchema>;
export type MotionResultFull = z.infer<typeof motionResultFullSchema>;
export type MotionResult = MotionResultSummary | MotionResultFull;

// ============================================================================
// Output Schemas - Quality
// ============================================================================

export const axisScoresSchema = z.object({
  originality: z.number().min(0).max(100),
  craftsmanship: z.number().min(0).max(100),
  contextuality: z.number().min(0).max(100),
});

export const axisGradesSchema = z.object({
  originality: gradeSchema,
  craftsmanship: gradeSchema,
  contextuality: gradeSchema,
});

export const axisDetailsSchema = z.object({
  originality: z.array(z.string()),
  craftsmanship: z.array(z.string()),
  contextuality: z.array(z.string()),
});

export const clicheDetailSchema = z.object({
  type: z.string(),
  description: z.string(),
  severity: z.enum(["high", "medium", "low"]),
});

export const recommendationSchema = z.object({
  id: z.string(),
  category: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  title: z.string(),
  description: z.string(),
});

export const qualityResultSummarySchema = z.object({
  success: z.boolean(),
  overallScore: z.number().min(0).max(100),
  grade: gradeSchema,
  axisScores: axisScoresSchema,
  clicheCount: z.number().int().nonnegative(),
  processingTimeMs: z.number().nonnegative(),
  error: errorInfoSchema.optional(),
});

export const qualityResultFullSchema = qualityResultSummarySchema.extend({
  axisGrades: axisGradesSchema.optional(),
  axisDetails: axisDetailsSchema.optional(),
  cliches: z.array(clicheDetailSchema).optional(),
  recommendations: z.array(recommendationSchema).optional(),
});

export type QualityResultSummary = z.infer<typeof qualityResultSummarySchema>;
export type QualityResultFull = z.infer<typeof qualityResultFullSchema>;
export type QualityResult = QualityResultSummary | QualityResultFull;

// ============================================================================
// Output Schemas - Metadata & Source
// ============================================================================

export const pageMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  favicon: z.string().url().optional(),
  ogImage: z.string().url().optional(),
});
export type PageMetadata = z.infer<typeof pageMetadataSchema>;

export const sourceInfoSchema = z.object({
  type: sourceTypeSchema,
  usageScope: usageScopeSchema,
});
export type SourceInfo = z.infer<typeof sourceInfoSchema>;

/** 旧形式の警告（後方互換性用） */
export const analysisWarningSchema = z.object({
  feature: z.enum(["layout", "motion", "quality", "responsive"]),
  code: z.string(),
  message: z.string(),
});
export type AnalysisWarning = z.infer<typeof analysisWarningSchema>;

/** 警告の重大度 */
export const warningSeveritySchema = z.enum(["info", "warning", "error"]);
export type WarningSeverity = z.infer<typeof warningSeveritySchema>;

/**
 * アクショナブル警告スキーマ (v0.1.0)
 *
 * 警告メッセージを構造化し、開発者が具体的なアクションを取れるようにする。
 * - type: 警告タイプ（常に 'warning'）
 * - code: 警告コード（一意の識別子）
 * - severity: 重大度（info/warning/error）
 * - message: 何が問題か
 * - impact: なぜ問題か（影響）
 * - action: どう対処すべきか（推奨アクション）
 * - docs: ドキュメントやリソースへのリンク（オプション）
 * - context: 追加の詳細情報（オプション）
 */
export const actionableWarningSchema = z.object({
  /** 警告タイプ */
  type: z.literal("warning"),
  /** 警告コード */
  code: z.string(),
  /** 重大度 */
  severity: warningSeveritySchema,
  /** 問題の説明 */
  message: z.string(),
  /** 影響の説明 */
  impact: z.string(),
  /** 推奨アクション */
  action: z.string(),
  /** ドキュメントへのリンク */
  docs: z.string().url().optional(),
  /** 追加のコンテキスト情報 */
  context: z.record(z.unknown()).optional(),
});
export type ActionableWarningSchema = z.infer<typeof actionableWarningSchema>;
/** ActionableWarningの型エイリアス（result-builder.ts等からの参照用） */
export type ActionableWarning = ActionableWarningSchema;

// ============================================================================
// Execution Status Schema (v0.1.0)
// ============================================================================

/**
 * 実行ステータススキーマ
 * タイムアウト処理とプログレッシブローディングの状態を追跡
 */
export const executionStatusSchema = z.object({
  /**
   * 完了したフェーズ
   * 優先順位: html > screenshot > layout > motion > quality
   */
  completed_phases: z.array(z.enum(["html", "screenshot", "layout", "motion", "quality"])),

  /**
   * 失敗したフェーズ（タイムアウトまたはエラー）
   */
  failed_phases: z.array(z.enum(["html", "screenshot", "layout", "motion", "quality"])),

  /**
   * タイムアウトで失敗したフェーズ（v0.1.0）
   * failed_phasesのうち、タイムアウトが原因のもの
   */
  timedout_phases: z.array(z.enum(["layout", "motion", "quality"])).optional(),

  /**
   * タイムアウトが発生したか
   */
  timeout_occurred: z.boolean(),

  /**
   * 実際の処理時間（ms）
   */
  actual_duration_ms: z.number().nonnegative(),

  /**
   * WebGL/3Dコンテンツが検出されたか
   */
  webgl_detected: z.boolean(),

  /**
   * タイムアウトが自動延長されたか（WebGL検出時）
   */
  timeout_extended: z.boolean(),

  /**
   * 元のタイムアウト値（ms）- 延長前
   */
  original_timeout_ms: z.number().nonnegative().optional(),

  /**
   * 有効タイムアウト値（ms）- 延長後
   */
  effective_timeout_ms: z.number().nonnegative().optional(),

  /**
   * フェーズごとのタイムアウト設定（v0.1.0）
   * ユーザー指定または自動計算された各フェーズのタイムアウト値
   */
  phase_timeouts: z
    .object({
      layout: z.number().nonnegative(),
      motion: z.number().nonnegative(),
      quality: z.number().nonnegative(),
    })
    .optional(),

  /**
   * CPU環境でタイムアウトが延長されたか（Vision CPU完走保証 Phase 4）
   * CPU環境 + Vision有効時にVisionTimeoutsに基づいて延長された場合にtrue
   */
  cpu_mode_extended: z.boolean().optional(),

  /**
   * ハードウェアタイプ（Vision CPU完走保証 Phase 4）
   * GPU/CPUのどちらで実行されたかを記録
   */
  hardware_type: z.enum(["GPU", "CPU"]).optional(),
});
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

// ============================================================================
// Pre-flight Probe Result Schema (v0.1.0)
// ============================================================================

/**
 * Pre-flight Probeの結果スキーマ
 *
 * auto_timeout=true時にURLの複雑度を事前分析した結果。
 * WebGL、SPA、重いフレームワークを検出し、最適なタイムアウト値を計算。
 */
export const preflightProbeResultSchema = z.object({
  /**
   * 計算されたタイムアウト値（ms）
   * この値がauto_timeout=true時の実際のタイムアウトとして使用される
   */
  calculatedTimeoutMs: z.number().nonnegative(),

  /**
   * 複雑度スコア（0-100）
   * 高いほど複雑なページ（タイムアウトが長くなる傾向）
   */
  complexityScore: z.number().min(0).max(100),

  /**
   * WebGL/3Dコンテンツの検出
   */
  hasWebGL: z.boolean(),

  /**
   * SPA（Single Page Application）の検出
   */
  hasSPA: z.boolean(),

  /**
   * 重いフレームワークの検出（Three.js、Babylon.js等）
   */
  hasHeavyFramework: z.boolean(),

  /**
   * プローブ実行時刻（ISO 8601）
   */
  probedAt: z.string().datetime(),

  /**
   * プローブバージョン
   */
  probeVersion: z.string(),

  /**
   * HTMLサイズ（バイト）
   */
  htmlSizeBytes: z.number().nonnegative().optional(),

  /**
   * スクリプト数
   */
  scriptCount: z.number().nonnegative().optional(),

  /**
   * 外部リソース数
   */
  externalResourceCount: z.number().nonnegative().optional(),

  /**
   * レスポンス時間（ms）
   */
  responseTimeMs: z.number().nonnegative().optional(),
});
export type PreflightProbeResult = z.infer<typeof preflightProbeResultSchema>;

// ============================================================================
// Narrative Result Schema
// ============================================================================

/**
 * MoodCategory ENUM（DesignNarrative.mood_category）
 */
export const moodCategorySchema = z.enum([
  "professional",
  "playful",
  "premium",
  "tech",
  "organic",
  "minimal",
  "bold",
  "elegant",
  "friendly",
  "artistic",
  "trustworthy",
  "energetic",
]);
export type MoodCategory = z.infer<typeof moodCategorySchema>;

/**
 * 色彩調和タイプ
 */
export const colorHarmonySchema = z.enum([
  "complementary",
  "analogous",
  "monochromatic",
  "triadic",
  "split-complementary",
  "mixed",
]);
export type ColorHarmony = z.infer<typeof colorHarmonySchema>;

/**
 * WorldView（世界観・雰囲気）結果スキーマ
 */
export const worldViewResultSchema = z.object({
  /** ムードカテゴリ */
  moodCategory: moodCategorySchema,
  /** セカンダリムードカテゴリ（オプション） */
  secondaryMoodCategory: moodCategorySchema.optional(),
  /** ムードの説明（自然言語） */
  moodDescription: z.string(),
  /** 色彩印象 */
  colorImpression: z.string(),
  /** タイポグラフィの性格 */
  typographyPersonality: z.string(),
  /** モーションの感情（オプション） */
  motionEmotion: z.string().optional(),
  /** 全体的なトーン */
  overallTone: z.string(),
});
export type WorldViewResult = z.infer<typeof worldViewResultSchema>;

/**
 * LayoutStructure（レイアウト構成）結果スキーマ
 */
export const layoutStructureResultSchema = z.object({
  /** グリッドシステム */
  gridSystem: z.string(),
  /** カラム数 */
  columnCount: z.number().int().min(1).max(24).optional(),
  /** ガター幅 */
  gutterWidth: z.string().optional(),
  /** コンテナ幅 */
  containerWidth: z.string().optional(),
  /** 視覚的階層（簡略化） */
  visualHierarchy: z
    .object({
      primaryElements: z.array(z.string()),
      sectionFlow: z.enum(["linear", "modular", "asymmetric"]),
    })
    .optional(),
  /** スペーシングリズム（簡略化） */
  spacingRhythm: z
    .object({
      baseUnit: z.string(),
      scale: z.array(z.number()),
    })
    .optional(),
  /** ホワイトスペース比率（0-1） */
  whitespaceRatio: z.number().min(0).max(1).optional(),
  /** 視覚的密度 */
  visualDensity: z.enum(["sparse", "balanced", "dense"]).optional(),
});
export type LayoutStructureResult = z.infer<typeof layoutStructureResultSchema>;

/**
 * Narrative分析結果スキーマ
 */
export const narrativeResultSchema = z.object({
  /** DesignNarrative ID（DB保存時のみ） */
  id: z.string().uuid().optional(),
  /** WebPage ID */
  webPageId: z.string().uuid().optional(),
  /** 世界観・雰囲気 */
  worldView: worldViewResultSchema,
  /** レイアウト構成 */
  layoutStructure: layoutStructureResultSchema,
  /** 総合信頼度（0-1） */
  confidence: z.number().min(0).max(1),
  /** 分析日時（ISO 8601） */
  analyzedAt: z.string().datetime(),
  /** 処理時間（ms） */
  processingTimeMs: z.number().nonnegative().optional(),
  /** Vision LLMが使用されたか */
  visionUsed: z.boolean().optional(),
  /** フォールバック理由（Vision未使用時） */
  fallbackReason: z.string().optional(),
});
export type NarrativeResult = z.infer<typeof narrativeResultSchema>;

// ============================================================================
// Output Schemas - Main Response
// ============================================================================

export const pageAnalyzeDataSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  normalizedUrl: z.string().url(),
  metadata: pageMetadataSchema,
  source: sourceInfoSchema,
  layout: z.union([layoutResultSummarySchema, layoutResultFullSchema]).optional(),
  motion: z.union([motionResultSummarySchema, motionResultFullSchema]).optional(),
  quality: z.union([qualityResultSummarySchema, qualityResultFullSchema]).optional(),
  /**
   * Narrative分析結果（v0.1.0）
   * Webページの世界観・雰囲気とレイアウト構成の分析結果。
   * narrativeOptions.enabled=true時のみ含まれる。
   */
  narrative: narrativeResultSchema.optional(),
  totalProcessingTimeMs: z.number().nonnegative(),
  analyzedAt: z.string().datetime(),
  /** 旧形式の警告（後方互換性） */
  warnings: z.array(analysisWarningSchema).optional(),
  /**
   * アクショナブル警告（v0.1.0）
   * 構造化された警告メッセージ。問題、影響、推奨アクション、ドキュメントリンクを含む。
   */
  actionable_warnings: z.array(actionableWarningSchema).optional(),
  /**
   * 実行ステータス（v0.1.0）
   * タイムアウト処理とプログレッシブローディングの状態を追跡
   */
  execution_status: executionStatusSchema.optional(),
  /**
   * Pre-flight Probe結果（v0.1.0）
   * auto_timeout=true時のみ含まれる。
   * URLの複雑度を事前分析した結果（WebGL、SPA、重いフレームワーク検出）。
   */
  preflightProbe: preflightProbeResultSchema.optional(),
  /**
   * 背景デザイン検出サマリー
   * CSS静的解析から検出された背景デザインパターンの概要。
   * layoutOptionsでレイアウト分析が有効な場合に含まれる。
   */
  backgroundDesigns: z
    .object({
      /** 検出された背景デザインの総数 */
      count: z.number().nonnegative(),
      /** 検出されたデザインタイプの一覧（重複あり） */
      types: z.array(z.string()),
      /** DBに保存された件数（saveToDb=true時のみ > 0） */
      savedToDb: z.number().nonnegative(),
    })
    .optional(),
  /**
   * レスポンシブ分析結果
   * responsiveOptions.enabled=true時のみ含まれる。
   * 複数ビューポートでのレイアウト差分とブレークポイント検出結果。
   */
  responsiveAnalysis: z
    .object({
      /** 分析されたビューポート名の配列 */
      viewportsAnalyzed: z.array(z.string()),
      /** 検出されたレイアウト差分 */
      differences: z.array(
        z
          .object({
            element: z.string(),
            description: z.string().optional(),
            category: z.string(),
          })
          .passthrough()
      ),
      /** 検出されたブレークポイント */
      breakpoints: z.array(z.string()),
      /** 分析時間（ms） */
      analysisTimeMs: z.number().nonnegative(),
      /** DB保存されたレコードのID */
      responsiveAnalysisId: z.string().uuid().optional(),
    })
    .optional(),
});
export type PageAnalyzeData = z.infer<typeof pageAnalyzeDataSchema>;

export const pageAnalyzeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type PageAnalyzeError = z.infer<typeof pageAnalyzeErrorSchema>;

export const pageAnalyzeSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: pageAnalyzeDataSchema,
});

export const pageAnalyzeErrorOutputSchema = z.object({
  success: z.literal(false),
  error: pageAnalyzeErrorSchema,
});

export const pageAnalyzeOutputSchema = z.discriminatedUnion("success", [
  pageAnalyzeSuccessOutputSchema,
  pageAnalyzeErrorOutputSchema,
]);

export type PageAnalyzeOutput = z.infer<typeof pageAnalyzeOutputSchema>;
export type PageAnalyzeSuccessOutput = z.infer<typeof pageAnalyzeSuccessOutputSchema>;
export type PageAnalyzeErrorOutput = z.infer<typeof pageAnalyzeErrorOutputSchema>;

// ============================================================================
// Async Mode Schemas (Phase3-2)
// ============================================================================

/**
 * 非同期モード時のレスポンススキーマ
 *
 * async=true の場合、同期処理ではなくジョブをキューに投入し、
 * このスキーマに従ったレスポンスを返す。
 */
export const pageAnalyzeAsyncOutputSchema = z.object({
  /** 非同期モードフラグ */
  async: z.literal(true),
  /** ジョブID（BullMQ Job ID、webPageIdと同一） */
  jobId: z.string().uuid(),
  /** ジョブステータス */
  status: z.literal("queued"),
  /** ポーリング用メッセージ */
  message: z.string(),
  /** ジョブステータス確認用のガイダンス */
  polling: z.object({
    /** 推奨ポーリング間隔（秒） */
    intervalSeconds: z.number().positive(),
    /** ジョブ結果保持期間（時間） */
    retentionHours: z.number().positive(),
    /** ステータス確認方法 */
    howToCheck: z.string(),
  }),
});
export type PageAnalyzeAsyncOutput = z.infer<typeof pageAnalyzeAsyncOutputSchema>;

// ============================================================================
// page.getJobStatus Schemas (Phase3-2)
// ============================================================================

/**
 * page.getJobStatus 入力スキーマ
 */
export const pageGetJobStatusInputSchema = z.object({
  /**
   * ジョブID（page.analyze async=true で返されたjob_id）
   * MCP命名規約に沿ってsnake_case
   */
  job_id: z.string().uuid(),
});
export type PageGetJobStatusInput = z.infer<typeof pageGetJobStatusInputSchema>;

/**
 * ジョブステート
 */
export const jobStateSchema = z.enum([
  "waiting", // キュー待ち
  "active", // 処理中
  "completed", // 完了
  "failed", // 失敗
  "delayed", // 遅延
  "unknown", // 不明
]);
export type JobState = z.infer<typeof jobStateSchema>;

/**
 * ジョブ結果サマリー（完了時）
 */
export const jobResultSummarySchema = z.object({
  /** WebページID */
  webPageId: z.string().uuid(),
  /** 成功フラグ */
  success: z.boolean(),
  /** 部分成功フラグ（一部フェーズのみ完了） */
  partialSuccess: z.boolean(),
  /** 完了したフェーズ */
  completedPhases: z.array(
    z.enum(["ingest", "layout", "motion", "quality", "narrative", "responsive", "embedding"])
  ),
  /** 失敗したフェーズ */
  failedPhases: z.array(
    z.enum(["ingest", "layout", "motion", "quality", "narrative", "responsive", "embedding"])
  ),
  /** フェーズ別結果サマリー */
  results: z
    .object({
      layout: z
        .object({
          sectionsDetected: z.number().nonnegative(),
          visionUsed: z.boolean(),
        })
        .optional(),
      motion: z
        .object({
          patternsDetected: z.number().nonnegative(),
          jsAnimationsDetected: z.number().nonnegative(),
        })
        .optional(),
      quality: z
        .object({
          overallScore: z.number().min(0).max(100),
          grade: z.string(),
        })
        .optional(),
      narrative: z
        .object({
          moodCategory: z.string(),
          confidence: z.number().min(0).max(1),
          visionUsed: z.boolean(),
        })
        .optional(),
      embedding: z
        .object({
          sectionEmbeddingsGenerated: z.number().nonnegative().optional(),
          motionEmbeddingsGenerated: z.number().nonnegative().optional(),
          backgroundDesignEmbeddingsGenerated: z.number().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
  /** 処理時間（ms） */
  processingTimeMs: z.number().nonnegative().optional(),
  /** 完了日時 */
  completedAt: z.string().datetime().optional(),
});
export type JobResultSummary = z.infer<typeof jobResultSummarySchema>;

/**
 * page.getJobStatus 出力データスキーマ（ジョブ発見時）
 */
export const pageGetJobStatusDataSchema = z.object({
  /** ジョブID */
  jobId: z.string().uuid(),
  /** ジョブステート */
  status: jobStateSchema,
  /** 進捗（0-100） */
  progress: z.number().min(0).max(100),
  /** 現在処理中のフェーズ（active時のみ） */
  currentPhase: z
    .enum(["ingest", "layout", "motion", "quality", "narrative", "responsive", "embedding"])
    .optional(),
  /** 結果（completed時のみ） */
  result: jobResultSummarySchema.optional(),
  /** エラー理由（failed時のみ） */
  failedReason: z.string().optional(),
  /** タイムスタンプ */
  timestamps: z.object({
    created: z.number().optional(),
    started: z.number().optional(),
    completed: z.number().optional(),
    failed: z.number().optional(),
  }),
});
export type PageGetJobStatusData = z.infer<typeof pageGetJobStatusDataSchema>;

/**
 * page.getJobStatus メタデータスキーマ
 */
export const pageGetJobStatusMetadataSchema = z.object({
  /** リクエストID */
  request_id: z.string().optional(),
  /** 処理時間（ミリ秒） */
  processing_time_ms: z.number().optional(),
  /** 適用された最適化モード */
  optimization_mode: z.enum(["full", "summary", "compact", "truncated"]).optional(),
  /** 切り詰めが適用されたか */
  truncated: z.boolean().optional(),
  /** 元のサイズ（切り詰め時） */
  original_size: z.number().optional(),
  /** 総件数（ページネーション時） */
  total_count: z.number().optional(),
  /** オフセット（ページネーション時） */
  offset: z.number().optional(),
  /** リミット（ページネーション時） */
  limit: z.number().optional(),
});
export type PageGetJobStatusMetadata = z.infer<typeof pageGetJobStatusMetadataSchema>;

/**
 * page.getJobStatus 成功レスポンススキーマ
 */
export const pageGetJobStatusSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: pageGetJobStatusDataSchema,
  metadata: pageGetJobStatusMetadataSchema.optional(),
});
export type PageGetJobStatusSuccessOutput = z.infer<typeof pageGetJobStatusSuccessOutputSchema>;

/**
 * page.getJobStatus エラーレスポンススキーマ
 */
export const pageGetJobStatusErrorOutputSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  metadata: pageGetJobStatusMetadataSchema.optional(),
});
export type PageGetJobStatusErrorOutput = z.infer<typeof pageGetJobStatusErrorOutputSchema>;

/**
 * page.getJobStatus 出力スキーマ（統合：success=true/false）
 */
export const pageGetJobStatusOutputSchema = z.discriminatedUnion("success", [
  pageGetJobStatusSuccessOutputSchema,
  pageGetJobStatusErrorOutputSchema,
]);
export type PageGetJobStatusOutput = z.infer<typeof pageGetJobStatusOutputSchema>;

// ============================================================================
// 後方互換性のための型エイリアス（非推奨、将来削除予定）
// ============================================================================

/**
 * @deprecated 統一レスポンス形式に移行済み。PageGetJobStatusSuccessOutput を使用してください。
 */
export const pageGetJobStatusFoundOutputSchema = pageGetJobStatusSuccessOutputSchema;
export type PageGetJobStatusFoundOutput = PageGetJobStatusSuccessOutput;

/**
 * @deprecated 統一レスポンス形式に移行済み。PageGetJobStatusErrorOutput を使用してください。
 */
export const pageGetJobStatusNotFoundOutputSchema = pageGetJobStatusErrorOutputSchema;
export type PageGetJobStatusNotFoundOutput = PageGetJobStatusErrorOutput;

/**
 * @deprecated 統一レスポンス形式に移行済み。PageGetJobStatusErrorOutput を使用してください。
 */
export const redisUnavailableErrorSchema = pageGetJobStatusErrorOutputSchema;
export type RedisUnavailableError = PageGetJobStatusErrorOutput;
