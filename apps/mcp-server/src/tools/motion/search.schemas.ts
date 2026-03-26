// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.search MCP Tool — Zod Schema Definitions
 * motion.search 固有のスキーマ定義（入力/出力/エラーコード）
 *
 * @module @reftrixmcp/mcp-server/tools/motion/search.schemas
 */
import { z } from "zod";

import { motionPatternSchema } from "./shared.schemas";
import { motionDetectErrorSchema, MOTION_MCP_ERROR_CODES } from "./detect.schemas";
import { commonSearchFiltersSchema } from "../../schemas/common-search-filters";

// ============================================================================
// motion.search Input Schema
// ============================================================================

/**
 * 検索用モーションタイプスキーマ
 * motion.searchで使用するシンプルなモーションタイプ
 */
export const motionSearchTypeSchema = z.enum([
  "animation",
  "transition",
  "transform",
  "scroll",
  "hover",
  "keyframe",
]);
export type MotionSearchType = z.infer<typeof motionSearchTypeSchema>;

/**
 * 検索用トリガースキーマ
 */
export const motionSearchTriggerSchema = z.enum([
  "load",
  "hover",
  "scroll",
  "click",
  "focus",
  "custom",
]);
export type MotionSearchTrigger = z.infer<typeof motionSearchTriggerSchema>;

/**
 * サンプルパターンスキーマ
 * 類似パターンを検索するための基準パターン
 */
export const samplePatternSchema = z.object({
  type: motionSearchTypeSchema.optional(),
  duration: z.number().min(0).optional(),
  easing: z.string().optional(),
  properties: z.array(z.string()).optional(),
});
export type SamplePattern = z.infer<typeof samplePatternSchema>;

/**
 * 検索フィルタースキーマ
 */
export const motionSearchFiltersSchema = z
  .object({
    type: motionSearchTypeSchema.optional(),
    minDuration: z.number().min(0).optional(),
    maxDuration: z.number().min(0).optional(),
    trigger: motionSearchTriggerSchema.optional(),
  })
  .merge(commonSearchFiltersSchema);
export type MotionSearchFilters = z.infer<typeof motionSearchFiltersSchema>;

/**
 * motion.search アクションタイプ
 * Phase3-3: motion.get_implementation を motion.search に統合
 */
export const motionSearchActionSchema = z.enum(["search", "generate"]);
export type MotionSearchAction = z.infer<typeof motionSearchActionSchema>;

// ============================================================================
// JSAnimation Search Schemas (v0.1.0)
// ============================================================================

/**
 * JSアニメーションライブラリタイプ
 * Prisma JSAnimationLibrary enumと同期
 */
export const jsAnimationLibraryTypeSchema = z.enum([
  "gsap",
  "framer_motion",
  "anime_js",
  "three_js",
  "lottie",
  "web_animations_api",
  "unknown",
]);
export type JSAnimationLibraryType = z.infer<typeof jsAnimationLibraryTypeSchema>;

/**
 * JSアニメーションタイプ
 * Prisma JSAnimationType enumと同期
 */
export const jsAnimationTypeSchema = z.enum([
  "tween",
  "timeline",
  "spring",
  "physics",
  "keyframe",
  "morphing",
  "path",
  "scroll_driven",
  "gesture",
]);
export type JSAnimationType = z.infer<typeof jsAnimationTypeSchema>;

/**
 * JSアニメーション検索フィルタースキーマ
 * motion.search で JSAnimationPattern をフィルタリングするためのスキーマ
 */
export const jsAnimationFiltersSchema = z.object({
  /** ライブラリタイプでフィルタリング */
  libraryType: jsAnimationLibraryTypeSchema.optional(),
  /** アニメーションタイプでフィルタリング */
  animationType: jsAnimationTypeSchema.optional(),
});
export type JSAnimationFilters = z.infer<typeof jsAnimationFiltersSchema>;

/**
 * JSアニメーション情報スキーマ
 * 検索結果に含まれるJSアニメーション固有の情報
 */
export const jsAnimationInfoSchema = z.object({
  /** ライブラリタイプ */
  libraryType: jsAnimationLibraryTypeSchema,
  /** アニメーションタイプ */
  animationType: jsAnimationTypeSchema.optional(),
  /** ライブラリバージョン */
  libraryVersion: z.string().optional(),
  /** 追加メタデータ */
  metadata: z.record(z.unknown()).optional(),
});
export type JSAnimationInfo = z.infer<typeof jsAnimationInfoSchema>;

// ============================================================================
// WebGL Animation Search Schemas (v0.1.0)
// ============================================================================

/**
 * WebGLアニメーションカテゴリ
 * WebGLAnimationDetectorServiceの検出カテゴリと同期
 */
export const webglAnimationCategorySchema = z.enum([
  "fade",
  "pulse",
  "wave",
  "particle",
  "morph",
  "rotation",
  "parallax",
  "noise",
  "complex",
]);
export type WebGLAnimationCategory = z.infer<typeof webglAnimationCategorySchema>;

/**
 * WebGLアニメーション検索フィルタースキーマ
 * motion.search で WebGLAnimationPattern をフィルタリングするためのスキーマ
 */
export const webglAnimationFiltersSchema = z.object({
  /** カテゴリでフィルタリング */
  category: webglAnimationCategorySchema.optional(),
  /** 検出されたライブラリでフィルタリング（例: three.js, babylon.js） */
  detectedLibrary: z.string().optional(),
  /** 最小信頼度しきい値（0-1） */
  minConfidence: z.number().min(0).max(1).optional(),
});
export type WebGLAnimationFilters = z.infer<typeof webglAnimationFiltersSchema>;

/**
 * WebGLアニメーション情報スキーマ
 * 検索結果に含まれるWebGLアニメーション固有の情報
 */
export const webglAnimationInfoSchema = z.object({
  /** アニメーションカテゴリ */
  category: webglAnimationCategorySchema,
  /** 検出されたライブラリ */
  detectedLibrary: z.string().optional(),
  /** Canvas要素のセレクタ */
  canvasSelector: z.string().optional(),
  /** 検出信頼度（0-1） */
  confidence: z.number().min(0).max(1),
  /** アニメーション特性 */
  characteristics: z
    .object({
      averageChangeRate: z.number().optional(),
      peakChangeRate: z.number().optional(),
      changePattern: z.enum(["continuous", "pulsed", "irregular"]).optional(),
    })
    .optional(),
});
export type WebGLAnimationInfo = z.infer<typeof webglAnimationInfoSchema>;

// ============================================================================
// Implementation Generation Schemas (Phase3-3: moved before motionSearchInputSchema)
// ============================================================================

/**
 * 実装出力フォーマット
 */
export const implementationFormatSchema = z.enum([
  "css",
  "css-module",
  "tailwind",
  "styled-components",
  "emotion",
  "framer-motion",
  "gsap",
  "three-js",
  "lottie",
]);
export type ImplementationFormat = z.infer<typeof implementationFormatSchema>;

/**
 * モーションパターンタイプ（実装生成用）
 */
export const motionPatternTypeSchema = z.enum([
  "animation",
  "transition",
  "transform",
  "scroll",
  "hover",
  "keyframe",
]);
export type MotionPatternType = z.infer<typeof motionPatternTypeSchema>;

/**
 * キーフレームオフセットスキーマ
 */
export const keyframeOffsetSchema = z.object({
  offset: z.number().min(0).max(1),
  value: z.string(),
});
export type KeyframeOffset = z.infer<typeof keyframeOffsetSchema>;

/**
 * アニメーションプロパティスキーマ（実装生成用）
 */
export const implementationPropertySchema = z.object({
  name: z.string().min(1),
  from: z.string(),
  to: z.string(),
  keyframes: z.array(keyframeOffsetSchema).optional(),
});
export type ImplementationProperty = z.infer<typeof implementationPropertySchema>;

/**
 * モーションパターン入力スキーマ（実装生成用）
 */
export const motionPatternInputSchema = z.object({
  type: motionPatternTypeSchema,
  name: z.string().min(1).max(100),
  duration: z.number().min(0).max(60000).default(300),
  delay: z.number().min(0).max(60000).default(0),
  easing: z.string().default("ease"),
  iterations: z.union([z.number().min(1), z.literal("infinite")]).default(1),
  direction: z.enum(["normal", "reverse", "alternate", "alternate-reverse"]).default("normal"),
  fillMode: z.enum(["none", "forwards", "backwards", "both"]).default("none"),
  properties: z.array(implementationPropertySchema).min(1),
});
export type MotionPatternInput = z.infer<typeof motionPatternInputSchema>;

/**
 * 実装オプションスキーマ
 */
export const implementationOptionsSchema = z.object({
  selector: z.string().default(".animated"),
  includeVendorPrefixes: z.boolean().default(false),
  includeReducedMotion: z.boolean().default(true),
  typescript: z.boolean().default(true),
  componentName: z.string().optional(),
});
export type ImplementationOptions = z.infer<typeof implementationOptionsSchema>;

// ============================================================================
// Generation Options for Duplicate Detection (v0.1.0)
// ============================================================================

/**
 * 生成オプションスキーマ（重複検出用）
 *
 * action: 'generate' 時に使用する追加オプション
 * プロジェクト内の既存アニメーションとの重複を検出し、
 * 不要なコード生成を防止
 *
 * @property check_duplicates - 重複チェックを有効にするか（デフォルト: false）
 * @property project_css_path - プロジェクトのCSSファイルパス（単一）
 * @property project_css_paths - プロジェクトのCSSファイルパス（複数）
 * @property similarity_threshold - 類似度しきい値（0-1、デフォルト: 0.8）
 */
export const generationOptionsSchema = z.object({
  /** 重複チェックを有効にするか（デフォルト: false） */
  check_duplicates: z
    .boolean()
    .default(false)
    .describe("Enable duplicate animation detection in project CSS files"),
  /** プロジェクトのCSSファイルパス（単一） */
  project_css_path: z
    .string()
    .optional()
    .describe("Path to project CSS file to scan for existing animations"),
  /** プロジェクトのCSSファイルパス（複数） */
  project_css_paths: z
    .array(z.string())
    .optional()
    .describe("Paths to multiple project CSS files to scan"),
  /** 類似度しきい値（0-1、デフォルト: 0.8） */
  similarity_threshold: z
    .number()
    .min(0, { message: "similarity_thresholdは0以上である必要があります" })
    .max(1, { message: "similarity_thresholdは1以下である必要があります" })
    .default(0.8)
    .describe("Similarity threshold for duplicate detection (0-1, default: 0.8)"),
});
export type GenerationOptions = z.infer<typeof generationOptionsSchema>;

/**
 * 既存アニメーション一致情報スキーマ
 */
export const existingAnimationMatchSchema = z.object({
  /** 既存アニメーション名 */
  animation_name: z.string(),
  /** ファイルパス */
  file_path: z.string(),
  /** 類似度 (0-1) */
  similarity: z.number().min(0).max(1),
  /** 提案メッセージ */
  suggestion: z.string(),
});
export type ExistingAnimationMatch = z.infer<typeof existingAnimationMatchSchema>;

/**
 * 重複チェック結果スキーマ
 */
export const duplicateCheckResultSchema = z.object({
  /** 重複があるか */
  has_duplicates: z.boolean(),
  /** マッチした既存アニメーション */
  existing_matches: z.array(existingAnimationMatchSchema),
  /** 警告メッセージ */
  warnings: z.array(z.string()),
});
export type DuplicateCheckResult = z.infer<typeof duplicateCheckResultSchema>;

// ============================================================================
// Motion Pattern Implementation Schema (v0.1.0)
// ============================================================================

/**
 * モーションパターン実装情報スキーマ
 *
 * 検索結果に含まれる実装コード情報
 * include_implementation: true 時に付与される
 *
 * @property keyframes - @keyframes定義（CSS形式）
 * @property animation - animationプロパティ（CSS形式）
 * @property tailwind - TailwindCSS クラス名（animate-xxx形式）
 * @property transition - transitionプロパティ（transition型の場合のみ）
 */
export const motionImplementationSchema = z.object({
  /** @keyframes定義（例: "@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }"） */
  keyframes: z.string().optional(),
  /** animationプロパティ（例: "animation: fadeIn 0.3s ease-out forwards;"） */
  animation: z.string().optional(),
  /** TailwindCSSクラス（例: "animate-fadeIn"） */
  tailwind: z.string().optional(),
  /** transitionプロパティ（例: "transition: opacity 0.3s ease-out;"） */
  transition: z.string().optional(),
});
export type MotionImplementation = z.infer<typeof motionImplementationSchema>;

// ============================================================================
// motion.search Input Schema (with Phase3-3 integration)
// ============================================================================

/**
 * motion.search 入力スキーマ（統合版）
 *
 * Phase3-3: action パラメータを追加
 * - action: 'search' (デフォルト) - 検索モード
 * - action: 'generate' - コード生成モード（motion.get_implementation の機能）
 *
 * @property action - アクションタイプ（search | generate、デフォルト: search）
 * @property query - 検索クエリ（自然言語、1-500文字）
 * @property samplePattern - サンプルパターンで類似検索
 * @property filters - 検索フィルター
 * @property limit - 結果制限（1-50、デフォルト10）
 * @property minSimilarity - 最小類似度しきい値（0-1、デフォルト0.5）
 * @property pattern - コード生成用パターン（action: 'generate' 時のみ）
 * @property format - 出力フォーマット（action: 'generate' 時のみ）
 * @property options - 生成オプション（action: 'generate' 時のみ）
 */
export const motionSearchInputSchema = z
  .object({
    // Phase3-3: アクションパラメータ追加
    action: motionSearchActionSchema.default("search"),

    // 検索用パラメータ（action: 'search' 時に使用）
    query: z
      .string()
      .min(1, { message: "検索クエリは1文字以上必要です" })
      .max(500, { message: "検索クエリは500文字以下にしてください" })
      .optional(),
    samplePattern: samplePatternSchema.optional(),
    filters: motionSearchFiltersSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1, { message: "limitは1以上である必要があります" })
      .max(50, { message: "limitは50以下にしてください" })
      .default(10),
    minSimilarity: z
      .number()
      .min(0, { message: "minSimilarityは0以上である必要があります" })
      .max(1, { message: "minSimilarityは1以下である必要があります" })
      .default(0.5),

    // v0.1.0: JSアニメーション検索パラメータ
    /** JSアニメーションパターンを検索結果に含めるか（デフォルト: true） */
    include_js_animations: z.boolean().default(true),
    /** JSアニメーション検索用フィルター */
    js_animation_filters: jsAnimationFiltersSchema.optional(),

    // v0.1.0: WebGLアニメーション検索パラメータ
    /** WebGLアニメーションパターンを検索結果に含めるか（デフォルト: true） */
    include_webgl_animations: z.boolean().default(true),
    /** WebGLアニメーション検索用フィルター */
    webgl_animation_filters: webglAnimationFiltersSchema.optional(),

    // v0.1.0: 実装コード取得オプション
    /** 検索結果に実装コード（@keyframes, animation, tailwindクラス）を含めるか（デフォルト: false） */
    include_implementation: z.boolean().default(false),

    // 多様性向上オプション（MMRアルゴリズム）
    /**
     * MMR (Maximal Marginal Relevance) アルゴリズムのλ値（0.0-1.0、デフォルト: 0.3）
     *
     * MMRスコア = λ * relevance - (1-λ) * max_similarity_to_selected
     *
     * - 0.0: 最大多様性（同一パターン名・カテゴリの連続を強く抑制）
     * - 0.3: デフォルト（関連度と多様性のバランス）
     * - 0.5: バランス設定
     * - 1.0: 関連度のみ（多様性フィルタなし、従来の類似度順）
     *
     * fadeIn系パターンが連続する問題を解決するには、0.3-0.5の値を推奨します。
     */
    diversity_threshold: z
      .number()
      .min(0, { message: "diversity_thresholdは0以上である必要があります" })
      .max(1, { message: "diversity_thresholdは1以下である必要があります" })
      .default(0.3),
    /**
     * カテゴリ分散を強制するか（デフォルト: true）
     * trueの場合、異なるカテゴリのパターンにボーナススコアを付与し、
     * 同一カテゴリが3件以上連続する場合はペナルティを適用します。
     */
    ensure_category_diversity: z.boolean().default(true),

    // 生成用パラメータ（action: 'generate' 時に使用）
    pattern: motionPatternInputSchema.optional(),
    format: implementationFormatSchema.optional(),
    options: implementationOptionsSchema.optional(),

    // v0.1.0: 重複検出オプション（action: 'generate' 時に使用）
    /** 生成オプション（重複検出設定を含む） */
    generation_options: generationOptionsSchema.optional(),

    /**
     * 嗜好プロファイルID（検索結果のリランキングに使用）
     * Preference profile ID (used for search result reranking)
     */
    profile_id: z.string().uuid().optional(),
  })
  .refine(
    (data) => {
      // action: 'search' の場合、query または samplePattern が必要
      if (data.action === "search") {
        const hasQuery = data.query !== undefined && data.query.length > 0;
        const hasSamplePattern = data.samplePattern !== undefined;
        return hasQuery || hasSamplePattern;
      }
      // action: 'generate' の場合、pattern が必要
      if (data.action === "generate") {
        return data.pattern !== undefined;
      }
      return true;
    },
    {
      message:
        "action: search の場合は query または samplePattern、action: generate の場合は pattern が必要です",
    }
  );
export type MotionSearchInput = z.infer<typeof motionSearchInputSchema>;

// ============================================================================
// motion.search Output Schema
// ============================================================================

/**
 * 検索結果のソース情報スキーマ
 */
export const motionSearchSourceSchema = z.object({
  pageId: z.string().uuid().optional(),
  url: z.string().optional(),
  selector: z.string().optional(),
});
export type MotionSearchSource = z.infer<typeof motionSearchSourceSchema>;

/**
 * 検索結果アイテムスキーマ
 * v0.1.0: jsAnimationInfo フィールド追加（JSアニメーション検索結果用）
 * v0.1.0: webglAnimationInfo フィールド追加（WebGLアニメーション検索結果用）
 * v0.1.0: implementation フィールド追加（include_implementation: true 時）
 */
export const motionSearchResultItemSchema = z.object({
  pattern: motionPatternSchema,
  similarity: z.number().min(0).max(1),
  source: motionSearchSourceSchema.optional(),
  /** v0.1.0: JSアニメーション固有情報（JSアニメーション検索結果の場合のみ） */
  jsAnimationInfo: jsAnimationInfoSchema.optional(),
  /** v0.1.0: WebGLアニメーション固有情報（WebGLアニメーション検索結果の場合のみ） */
  webglAnimationInfo: webglAnimationInfoSchema.optional(),
  /** v0.1.0: 実装コード情報（include_implementation: true 時のみ） */
  implementation: motionImplementationSchema.optional(),
});
export type MotionSearchResultItem = z.infer<typeof motionSearchResultItemSchema>;

/**
 * クエリ情報スキーマ
 */
export const motionSearchQueryInfoSchema = z.object({
  text: z.string().optional(),
  embedding: z.array(z.number()).optional(),
});
export type MotionSearchQueryInfo = z.infer<typeof motionSearchQueryInfoSchema>;

/**
 * motion.search 成功レスポンスデータスキーマ（検索モード）
 */
export const motionSearchSearchDataSchema = z.object({
  results: z.array(motionSearchResultItemSchema),
  total: z.number().int().nonnegative(),
  query: motionSearchQueryInfoSchema.optional(),
});
export type MotionSearchSearchData = z.infer<typeof motionSearchSearchDataSchema>;

/**
 * motion.search 成功レスポンスデータスキーマ（生成モード）
 * Phase3-3: action: generate のレスポンス形式
 * v0.1.0: duplicate_check フィールド追加
 */
export const motionSearchGenerateDataSchema = z.object({
  code: z.string(),
  format: implementationFormatSchema,
  metadata: z.object({
    linesOfCode: z.number().int().nonnegative(),
    hasKeyframes: z.boolean(),
    hasReducedMotion: z.boolean(),
    dependencies: z.array(z.string()),
  }),
  /** v0.1.0: 重複チェック結果（check_duplicates: true の場合のみ） */
  duplicate_check: duplicateCheckResultSchema.optional(),
});
export type MotionSearchGenerateData = z.infer<typeof motionSearchGenerateDataSchema>;

/**
 * motion.search 成功レスポンスデータスキーマ（統合）
 * Phase3-3: 検索モードと生成モードの両方をサポート
 */
export const motionSearchDataSchema = z.union([
  motionSearchSearchDataSchema,
  motionSearchGenerateDataSchema,
]);
export type MotionSearchData = z.infer<typeof motionSearchDataSchema>;

/**
 * motion.search エラー情報スキーマ
 */
export const motionSearchErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type MotionSearchError = z.infer<typeof motionSearchErrorSchema>;

/**
 * motion.search 成功レスポンススキーマ
 */
export const motionSearchSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: motionSearchDataSchema,
});

/**
 * motion.search 失敗レスポンススキーマ
 */
export const motionSearchErrorOutputSchema = z.object({
  success: z.literal(false),
  error: motionSearchErrorSchema,
});

/**
 * motion.search 出力スキーマ（統合）
 */
export const motionSearchOutputSchema = z.discriminatedUnion("success", [
  motionSearchSuccessOutputSchema,
  motionSearchErrorOutputSchema,
]);
export type MotionSearchOutput = z.infer<typeof motionSearchOutputSchema>;

// ============================================================================
// Additional Error Codes for motion.search
// ============================================================================

/**
 * motion.search 追加エラーコード
 */
export const MOTION_SEARCH_ERROR_CODES = {
  ...MOTION_MCP_ERROR_CODES,
  /** 検索クエリエラー */
  SEARCH_ERROR: "SEARCH_ERROR",
  /** Embeddingエラー */
  EMBEDDING_ERROR: "EMBEDDING_ERROR",
  /** 結果なし（エラーではないが情報として） */
  NO_RESULTS: "NO_RESULTS",
} as const;

export type MotionSearchErrorCode =
  (typeof MOTION_SEARCH_ERROR_CODES)[keyof typeof MOTION_SEARCH_ERROR_CODES];

// ============================================================================
// motion.get_implementation Schemas (references moved schemas)
// ============================================================================

/**
 * motion.get_implementation 入力スキーマ
 */
export const motionGetImplementationInputSchema = z.object({
  pattern: motionPatternInputSchema,
  format: implementationFormatSchema.default("css"),
  options: implementationOptionsSchema.optional(),
});
export type MotionGetImplementationInput = z.infer<typeof motionGetImplementationInputSchema>;

/**
 * 実装メタデータスキーマ
 */
export const implementationMetadataSchema = z.object({
  linesOfCode: z.number().int().nonnegative(),
  hasKeyframes: z.boolean(),
  hasReducedMotion: z.boolean(),
  dependencies: z.array(z.string()),
});
export type ImplementationMetadata = z.infer<typeof implementationMetadataSchema>;

/**
 * motion.get_implementation 成功レスポンスデータスキーマ
 */
export const motionGetImplementationDataSchema = z.object({
  code: z.string(),
  format: implementationFormatSchema,
  metadata: implementationMetadataSchema,
});
export type MotionGetImplementationData = z.infer<typeof motionGetImplementationDataSchema>;

/**
 * motion.get_implementation 成功レスポンススキーマ
 */
export const motionGetImplementationSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: motionGetImplementationDataSchema,
});

/**
 * motion.get_implementation 失敗レスポンススキーマ
 */
export const motionGetImplementationErrorOutputSchema = z.object({
  success: z.literal(false),
  error: motionDetectErrorSchema,
});

/**
 * motion.get_implementation 出力スキーマ（統合）
 */
export const motionGetImplementationOutputSchema = z.discriminatedUnion("success", [
  motionGetImplementationSuccessOutputSchema,
  motionGetImplementationErrorOutputSchema,
]);
export type MotionGetImplementationOutput = z.infer<typeof motionGetImplementationOutputSchema>;
