// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.* MCP Tools — Shared Zod Schema Definitions
 * detect / search 両方で共有される共通型定義
 *
 * @module @reftrix/mcp-server/tools/motion/shared.schemas
 */
import { z } from "zod";

// ============================================================================
// Enum Schemas
// ============================================================================

/**
 * モーションパターンのタイプ
 */
export const motionTypeSchema = z.enum([
  "css_animation",
  "css_transition",
  "keyframes",
  "library_animation",
  "video_motion", // Phase1: フレーム解析で検出されたモーション
]);
export type MotionType = z.infer<typeof motionTypeSchema>;

/**
 * モーションカテゴリ
 *
 * v0.1.0: 以下のカテゴリを追加して分類精度を向上
 * - marquee: 無限水平スクロールアニメーション
 * - video_overlay: 動画プレーヤーオーバーレイ
 * - parallax: 深度/パララックス効果
 * - reveal: フェードイン/スライドインの表示アニメーション
 * - morphing: SVGパスモーフィング
 * - background_animation: 背景位置/グラデーションアニメーション
 * - typing_animation: タイプライター/カーソル点滅
 * - entrance: 登場アニメーション
 * - exit: 退場アニメーション
 */
export const motionCategorySchema = z.enum([
  "scroll_trigger",
  "hover_effect",
  "page_transition",
  "loading_state",
  "micro_interaction",
  "attention_grabber",
  "navigation",
  "feedback",
  "entrance",
  "exit",
  // v0.1.0 new categories
  "marquee",
  "video_overlay",
  "parallax",
  "reveal",
  "morphing",
  "background_animation",
  "typing_animation",
  "unknown",
]);
export type MotionCategory = z.infer<typeof motionCategorySchema>;

/**
 * トリガータイプ
 */
export const triggerTypeSchema = z.enum([
  "scroll",
  "scroll_velocity",
  "hover",
  "click",
  "focus",
  "load",
  "intersection",
  "time",
  "state_change",
  "unknown",
]);
export type TriggerType = z.infer<typeof triggerTypeSchema>;

/**
 * イージングタイプ
 */
export const easingTypeSchema = z.enum([
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "cubic-bezier",
  "spring",
  "steps",
  "unknown",
]);
export type EasingType = z.infer<typeof easingTypeSchema>;

/**
 * 警告の重要度
 */
export const warningSeveritySchema = z.enum(["info", "warning", "error"]);
export type WarningSeverity = z.infer<typeof warningSeveritySchema>;

/**
 * パフォーマンスレベル
 */
export const performanceLevelSchema = z.enum(["excellent", "good", "fair", "poor"]);
export type PerformanceLevel = z.infer<typeof performanceLevelSchema>;

// ============================================================================
// Sub-schemas
// ============================================================================

/**
 * イージング設定スキーマ
 */
export const easingConfigSchema = z.object({
  type: easingTypeSchema,
  cubicBezier: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  steps: z
    .object({
      count: z.number().int().positive(),
      position: z
        .enum(["start", "end", "jump-start", "jump-end", "jump-both", "jump-none"])
        .optional(),
    })
    .optional(),
});
export type EasingConfig = z.infer<typeof easingConfigSchema>;

/**
 * アニメーション対象プロパティスキーマ
 */
export const animatedPropertySchema = z.object({
  property: z.string(),
  from: z.union([z.string(), z.number()]).optional(),
  to: z.union([z.string(), z.number()]).optional(),
  unit: z.string().optional(),
});
export type AnimatedProperty = z.infer<typeof animatedPropertySchema>;

/**
 * パフォーマンス情報スキーマ
 */
export const performanceInfoSchema = z.object({
  usesTransform: z.boolean(),
  usesOpacity: z.boolean(),
  triggersLayout: z.boolean(),
  triggersPaint: z.boolean(),
  usesWillChange: z.boolean().optional(),
  estimatedFps: z.number().min(0).max(120).optional(),
  level: performanceLevelSchema.optional(),
});
export type PerformanceInfo = z.infer<typeof performanceInfoSchema>;

/**
 * アクセシビリティ情報スキーマ
 */
export const accessibilityInfoSchema = z.object({
  respectsReducedMotion: z.boolean(),
  hasReducedMotionFallback: z.boolean().optional(),
  alternativeForReduced: z.string().optional(),
});
export type AccessibilityInfo = z.infer<typeof accessibilityInfoSchema>;

/**
 * キーフレームステップスキーマ
 */
export const keyframeStepSchema = z.object({
  offset: z.number().min(0).max(100),
  styles: z.record(z.string(), z.string()),
});
export type KeyframeStep = z.infer<typeof keyframeStepSchema>;

/**
 * 3D Perspective情報スキーマ (v0.1.0)
 *
 * 3D CSS効果の検出情報
 * - rotateX/Y/Z, translateZ
 * - perspective(), perspective プロパティ
 * - transform-style: preserve-3d
 */
export const perspectiveInfoSchema = z.object({
  type: z.enum(["3d_rotation", "z_translation", "perspective_function", "complex_3d"]),
  axes: z.array(z.enum(["X", "Y", "Z"])).optional(),
  rotationRange: z
    .object({
      min: z.number(),
      max: z.number(),
    })
    .optional(),
  translationRange: z
    .object({
      min: z.number(),
      max: z.number(),
    })
    .optional(),
  rotationAngles: z
    .record(
      z.string(),
      z.object({
        from: z.number(),
        to: z.number(),
      })
    )
    .optional(),
  perspectiveValue: z.number().optional(),
  parentPerspective: z.number().optional(),
  transformStyle: z.enum(["flat", "preserve-3d"]).optional(),
  hasBackfaceVisibility: z.boolean().optional(),
  uses3DTransform: z.boolean(),
});
export type PerspectiveInfo = z.infer<typeof perspectiveInfoSchema>;

/**
 * ランタイム検出メタデータスキーマ (v0.1.0)
 */
export const runtimeMetadataSchema = z.object({
  detectedAt: z.string().optional(),
  animationType: z.string().optional(),
});
export type RuntimeMetadata = z.infer<typeof runtimeMetadataSchema>;

/**
 * 重複情報スキーマ (v0.1.0)
 * hybrid モードで CSS と runtime 両方で検出されたパターンのマージ情報
 */
export const duplicateInfoSchema = z.object({
  mergedFrom: z.array(z.enum(["css", "runtime"])),
  originalPatternCount: z.number().int().positive(),
});
export type DuplicateInfo = z.infer<typeof duplicateInfoSchema>;

/**
 * 検出されたモーションパターンスキーマ
 */
export const motionPatternSchema = z.object({
  id: z.string(),
  type: motionTypeSchema,
  category: motionCategorySchema,
  name: z.string().optional(),
  selector: z.string().optional(),

  // トリガー情報
  trigger: triggerTypeSchema,

  // アニメーション設定
  animation: z.object({
    duration: z.number().min(0).optional(),
    delay: z.number().min(0).optional(),
    easing: easingConfigSchema.optional(),
    iterations: z.union([z.number().positive(), z.literal("infinite")]).optional(),
    direction: z.enum(["normal", "reverse", "alternate", "alternate-reverse"]).optional(),
    fillMode: z.enum(["none", "forwards", "backwards", "both"]).optional(),
  }),

  // 変化するプロパティ
  properties: z.array(animatedPropertySchema),

  // キーフレーム詳細（css_animation/keyframesの場合）
  keyframes: z.array(keyframeStepSchema).optional(),

  // パフォーマンス情報
  performance: performanceInfoSchema.optional(),

  // アクセシビリティ情報
  accessibility: accessibilityInfoSchema.optional(),

  // 生コード
  rawCss: z.string().optional(),

  // v0.1.0: 3D Perspective情報 (include_perspective: true 時のみ)
  perspective: perspectiveInfoSchema.optional(),

  // v0.1.0: 検出ソース (css | runtime)
  detectionSource: z.enum(["css", "runtime"]).optional(),

  // v0.1.0: ランタイム検出時の追加メタデータ
  runtimeMetadata: runtimeMetadataSchema.optional(),

  // v0.1.0: ランタイム検出時刻/イベント
  detected_at: z.string().optional(),

  // v0.1.0: スクロール位置（%）
  scroll_position: z.number().min(0).max(100).optional(),

  // v0.1.0: hybrid モードでの重複マージ情報
  duplicateInfo: duplicateInfoSchema.optional(),

  // Phase1 v0.1.0: ビデオモーション検出メタデータ
  videoMetadata: z
    .object({
      intensity: z.enum(["low", "medium", "high"]),
      startMs: z.number().min(0),
      endMs: z.number().min(0),
      avgChangeRatio: z.number().min(0).max(1),
      maxChangeRatio: z.number().min(0).max(1),
      estimatedType: z.string(),
    })
    .optional(),
});
export type MotionPattern = z.infer<typeof motionPatternSchema>;

/**
 * モーション警告スキーマ
 */
export const motionWarningSchema = z.object({
  code: z.string(),
  severity: warningSeveritySchema,
  message: z.string(),
  pattern: z.string().optional(),
  suggestion: z.string().optional(),
  /** Phase1: Video mode context (URL, duration, etc.) */
  context: z.record(z.unknown()).optional(),
});
export type MotionWarning = z.infer<typeof motionWarningSchema>;

/**
 * 3D効果統計スキーマ (v0.1.0)
 */
export const perspectiveStatsSchema = z.object({
  rotationCount: z.number().int().nonnegative(),
  translationZCount: z.number().int().nonnegative(),
  perspectiveFunctionCount: z.number().int().nonnegative(),
});
export type PerspectiveStats = z.infer<typeof perspectiveStatsSchema>;

/**
 * 検出サマリースキーマ
 */
export const motionSummarySchema = z.object({
  totalPatterns: z.number().int().nonnegative(),
  byType: z.record(motionTypeSchema, z.number().int().nonnegative()),
  byTrigger: z.record(triggerTypeSchema, z.number().int().nonnegative()),
  byCategory: z.record(motionCategorySchema, z.number().int().nonnegative()).optional(),
  averageDuration: z.number().min(0),
  hasInfiniteAnimations: z.boolean(),
  complexityScore: z.number().min(0).max(100),
  performanceScore: z.number().min(0).max(100).optional(),
  accessibilityScore: z.number().min(0).max(100).optional(),

  // v0.1.0: 3D効果関連サマリー (include_perspective: true 時)
  has3DEffects: z.boolean().optional(),
  perspective3DCount: z.number().int().nonnegative().optional(),
  perspectiveStats: perspectiveStatsSchema.optional(),

  // v0.1.0: hybrid モード関連サマリー
  byCssCount: z.number().int().nonnegative().optional(),
  byRuntimeCount: z.number().int().nonnegative().optional(),
});
export type MotionSummary = z.infer<typeof motionSummarySchema>;

/**
 * 外部CSS取得統計スキーマ
 */
export const externalCssStatsSchema = z.object({
  urlsFound: z.number().int().nonnegative(),
  urlsFetched: z.number().int().nonnegative(),
  fetchErrors: z.number().int().nonnegative(),
  fetchTimeMs: z.number().min(0).optional(),
  totalSize: z.number().int().nonnegative().optional(),
});
export type ExternalCssStats = z.infer<typeof externalCssStatsSchema>;

/**
 * メタデータスキーマ
 */
/**
 * Hybridモード固有の情報スキーマ (Phase2 v0.1.0)
 */
export const hybridInfoSchema = z.object({
  runtime_patterns_count: z.number().int().nonnegative(),
  css_patterns_count: z.number().int().nonnegative(),
  total_merged_patterns: z.number().int().nonnegative(),
});
export type HybridInfo = z.infer<typeof hybridInfoSchema>;

export const motionMetadataSchema = z.object({
  processingTimeMs: z.number().min(0),
  htmlSize: z.number().int().nonnegative().optional(), // videoモードでは不要のためoptional化
  cssSize: z.number().int().nonnegative().optional(),
  librariesDetected: z.array(z.string()).optional(),
  // 外部CSS関連メタデータ
  externalCssFetched: z.boolean().optional(),
  externalCssUrls: z.array(z.string()).optional(),
  externalCssStats: externalCssStatsSchema.optional(),
  blockedUrls: z.array(z.string()).optional(),
  // v0.1.0: レスポンスサイズ情報
  response_size_bytes: z.number().int().nonnegative().optional(),
  // Phase1 v0.1.0: 共通メタデータ
  detectedAt: z.string().optional(),
  schemaVersion: z.string().optional(),
  detection_mode: z.enum(["css", "runtime", "hybrid", "video"]).optional(),
  // Phase2 v0.1.0: Hybridモード固有の情報
  hybrid_info: hybridInfoSchema.optional(),
  // Phase3 v0.1.0: Lighthouse処理時間
  lighthouse_processing_time_ms: z.number().int().nonnegative().optional(),
  // Phase4 v0.1.0: AnimationMetricsCollector処理時間
  analyze_metrics_processing_time_ms: z.number().int().nonnegative().optional(),
  // Phase5 v0.1.0: Frame Image Analysis処理時間
  frame_analysis_processing_time_ms: z.number().int().nonnegative().optional(),
  // Phase5 v0.1.0: Frame Capture処理時間
  frame_capture_processing_time_ms: z.number().int().nonnegative().optional(),
  // Phase6 v0.1.0: JS Animation Detection処理時間
  js_animation_processing_time_ms: z.number().int().nonnegative().optional(),
  // v0.1.0: タイムアウト情報
  /** タイムアウトが発生したかどうか */
  had_timeout: z.boolean().optional(),
  /** タイムアウトが発生したフェーズ (css, video, runtime, hybrid, js_animation, frame_capture) */
  timeout_phase: z.string().optional(),
  /** タイムアウト発生までの経過時間 (ms) */
  timeout_elapsed_ms: z.number().int().nonnegative().optional(),
});
export type MotionMetadata = z.infer<typeof motionMetadataSchema>;
