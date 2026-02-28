// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.analyze_frames MCP Tool Zod Schema Definitions
 * フレーム画像解析用のMCPツールの入力/出力バリデーションスキーマ
 *
 * @module @reftrix/mcp-server/tools/motion/analyze-frames.schema
 *
 * 機能:
 * - フレーム差分検出 (frame_diff)
 * - レイアウトシフト検出 (layout_shift)
 * - 色変化検出 (color_change)
 * - モーションベクトル推定 (motion_vector)
 * - 要素出現/消失検出 (element_visibility)
 */
import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

/**
 * 最大フレーム数制限
 * DoS攻撃やリソース枯渇を防ぐため、3600フレーム（30fps × 2分相当）を上限とする
 */
export const MAX_ANALYSIS_FRAMES = 3600;

/**
 * 最小フレーム数
 * 差分分析には最低2フレームが必要
 */
export const MIN_ANALYSIS_FRAMES = 2;

// ============================================================================
// Error Codes
// ============================================================================

/**
 * motion.analyze_frames ツール用エラーコード
 */
export const ANALYZE_FRAMES_ERROR_CODES = {
  /** バリデーションエラー */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** ディレクトリが見つからない */
  DIRECTORY_NOT_FOUND: 'DIRECTORY_NOT_FOUND',
  /** フレームが見つからない */
  NO_FRAMES_FOUND: 'NO_FRAMES_FOUND',
  /** フレーム数不足 */
  INSUFFICIENT_FRAMES: 'INSUFFICIENT_FRAMES',
  /** 解析エラー */
  ANALYSIS_ERROR: 'ANALYSIS_ERROR',
  /** 画像読み込みエラー */
  IMAGE_READ_ERROR: 'IMAGE_READ_ERROR',
  /** メモリ不足 */
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
  /** タイムアウト */
  TIMEOUT: 'TIMEOUT',
  /** 内部エラー */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type AnalyzeFramesErrorCode =
  (typeof ANALYZE_FRAMES_ERROR_CODES)[keyof typeof ANALYZE_FRAMES_ERROR_CODES];

// ============================================================================
// Common Schemas
// ============================================================================

/**
 * バウンディングボックススキーマ
 */
export const boundingBoxSchema = z.object({
  /** 左上X座標 */
  x: z.number().int().nonnegative(),
  /** 左上Y座標 */
  y: z.number().int().nonnegative(),
  /** 幅 */
  width: z.number().int().positive(),
  /** 高さ */
  height: z.number().int().positive(),
});
export type BoundingBox = z.infer<typeof boundingBoxSchema>;

/**
 * 変化領域スキーマ
 */
export const changeRegionSchema = boundingBoxSchema.extend({
  /** 変化強度 (0-1) */
  change_intensity: z.number().min(0).max(1).optional(),
  /** 変化ピクセル数 */
  pixel_count: z.number().int().nonnegative().optional(),
});
export type ChangeRegion = z.infer<typeof changeRegionSchema>;

// ============================================================================
// Analysis Type Enum
// ============================================================================

/**
 * 解析タイプ
 */
export const analysisTypeSchema = z.enum([
  'frame_diff',
  'layout_shift',
  'color_change',
  'motion_vector',
  'element_visibility',
]);
export type AnalysisType = z.infer<typeof analysisTypeSchema>;

// ============================================================================
// Input Schema
// ============================================================================

/**
 * 解析オプションスキーマ
 */
export const analyzeOptionsSchema = z.object({
  /** 変化検出閾値 (0-1, デフォルト: 0.1) */
  diff_threshold: z
    .number()
    .min(0, { message: 'diff_thresholdは0以上である必要があります' })
    .max(1, { message: 'diff_thresholdは1以下である必要があります' })
    .default(0.1),
  /** 最大フレーム数 (2-3600, デフォルト: 300) */
  max_frames: z
    .number()
    .int()
    .min(MIN_ANALYSIS_FRAMES, { message: `max_framesは${MIN_ANALYSIS_FRAMES}以上である必要があります` })
    .max(MAX_ANALYSIS_FRAMES, { message: `max_framesは${MAX_ANALYSIS_FRAMES}以下にしてください` })
    .default(300),
  /** 並列処理を使用するか (デフォルト: true) */
  parallel: z.boolean().default(true),
  /** 差分画像を出力するか (デフォルト: false) */
  output_diff_images: z.boolean().default(false),
});
export type AnalyzeOptions = z.infer<typeof analyzeOptionsSchema>;

/**
 * motion.analyze_frames 入力スキーマ
 */
export const analyzeFramesInputSchema = z.object({
  /** フレーム画像ディレクトリパス (必須) */
  frame_dir: z
    .string()
    .min(1, { message: 'frame_dirは1文字以上必要です' })
    .refine(
      (dir) => !dir.includes('..'),
      { message: 'frame_dirにパストラバーサル文字(..)は使用できません' }
    ),
  /** ファイル名パターン (デフォルト: frame-*.png) */
  frame_pattern: z
    .string()
    .min(1, { message: 'frame_patternは1文字以上必要です' })
    .default('frame-*.png'),
  /** 解析タイプの配列 (デフォルト: ['frame_diff', 'layout_shift']) */
  analysis_types: z
    .array(analysisTypeSchema)
    .min(1, { message: '最低1つの解析タイプが必要です' })
    .default(['frame_diff', 'layout_shift']),
  /** 解析オプション */
  options: analyzeOptionsSchema.optional(),
});
export type AnalyzeFramesInput = z.infer<typeof analyzeFramesInputSchema>;

// ============================================================================
// Result Schemas
// ============================================================================

/**
 * フレーム差分結果スキーマ
 */
export const frameDiffResultSchema = z.object({
  /** 比較元フレームインデックス */
  from_index: z.number().int().nonnegative(),
  /** 比較先フレームインデックス */
  to_index: z.number().int().nonnegative(),
  /** 変化率 (0-1) */
  change_ratio: z.number().min(0).max(1),
  /** 変化ピクセル数 */
  changed_pixels: z.number().int().nonnegative(),
  /** 総ピクセル数 */
  total_pixels: z.number().int().positive(),
  /** 変化領域のバウンディングボックス */
  change_regions: z.array(boundingBoxSchema),
  /** 変化が検出されたか */
  has_change: z.boolean(),
});
export type FrameDiffResult = z.infer<typeof frameDiffResultSchema>;

/**
 * フレーム差分サマリースキーマ
 */
export const frameDiffSummarySchema = z.object({
  /** 比較総数 */
  total_comparisons: z.number().int().nonnegative(),
  /** 平均変化率 */
  avg_change_ratio: z.number().min(0).max(1),
  /** 最大変化率 */
  max_change_ratio: z.number().min(0).max(1),
  /** モーション検出フレーム数 */
  motion_frame_count: z.number().int().nonnegative(),
  /** 個別結果 (オプション) */
  results: z.array(frameDiffResultSchema).optional(),
});
export type FrameDiffSummary = z.infer<typeof frameDiffSummarySchema>;

/**
 * レイアウトシフト原因
 */
export const layoutShiftCauseSchema = z.enum([
  'image_load',
  'font_swap',
  'dynamic_content',
  'unknown',
]);
export type LayoutShiftCause = z.infer<typeof layoutShiftCauseSchema>;

/**
 * シフト方向
 */
export const shiftDirectionSchema = z.enum([
  'horizontal',
  'vertical',
  'both',
]);
export type ShiftDirection = z.infer<typeof shiftDirectionSchema>;

/**
 * レイアウトシフト結果スキーマ
 */
export const layoutShiftResultSchema = z.object({
  /** シフトが検出されたフレームインデックス */
  frame_index: z.number().int().nonnegative(),
  /** シフト開始時刻 (ms) */
  shift_start_ms: z.number().min(0),
  /** シフト影響スコア (0-1、CLSへの寄与度) */
  impact_score: z.number().min(0).max(1),
  /** シフト領域 */
  affected_regions: z.array(boundingBoxSchema),
  /** 推定原因 */
  estimated_cause: layoutShiftCauseSchema,
  /** シフト方向 */
  shift_direction: shiftDirectionSchema,
  /** シフト距離 (pixels) */
  shift_distance: z.number().min(0),
});
export type LayoutShiftResult = z.infer<typeof layoutShiftResultSchema>;

/**
 * レイアウトシフトサマリースキーマ
 */
export const layoutShiftSummarySchema = z.object({
  /** シフト総数 */
  total_shifts: z.number().int().nonnegative(),
  /** 最大影響スコア */
  max_impact_score: z.number().min(0).max(1),
  /** 累積レイアウトシフトスコア (CLSスコア相当) */
  cumulative_shift_score: z.number().min(0),
  /** 個別結果 */
  results: z.array(layoutShiftResultSchema).optional(),
});
export type LayoutShiftSummary = z.infer<typeof layoutShiftSummarySchema>;

/**
 * 色変化タイプ
 */
export const colorChangeTypeSchema = z.enum([
  'fade_in',
  'fade_out',
  'color_transition',
  'brightness_change',
]);
export type ColorChangeType = z.infer<typeof colorChangeTypeSchema>;

/**
 * 色変化イベントスキーマ
 */
export const colorChangeEventSchema = z.object({
  /** 開始フレームインデックス */
  start_frame: z.number().int().nonnegative(),
  /** 終了フレームインデックス */
  end_frame: z.number().int().nonnegative(),
  /** 変化タイプ */
  change_type: colorChangeTypeSchema,
  /** 影響領域 */
  affected_region: boundingBoxSchema,
  /** 変化前の主要色 (HEX) */
  from_color: z.string().regex(/^#[0-9A-Fa-f]{3,6}$/),
  /** 変化後の主要色 (HEX) */
  to_color: z.string().regex(/^#[0-9A-Fa-f]{3,6}$/),
  /** 推定duration (ms) */
  estimated_duration_ms: z.number().min(0),
});
export type ColorChangeEvent = z.infer<typeof colorChangeEventSchema>;

/**
 * 色変化結果スキーマ
 */
export const colorChangeResultSchema = z.object({
  /** 検出された色変化イベント */
  events: z.array(colorChangeEventSchema),
});
export type ColorChangeResult = z.infer<typeof colorChangeResultSchema>;

/**
 * モーションタイプ
 */
export const motionTypeEnumSchema = z.enum([
  'linear',
  'curved',
  'oscillating',
  'complex',
]);
export type MotionTypeEnum = z.infer<typeof motionTypeEnumSchema>;

/**
 * モーションベクトル結果スキーマ
 */
export const motionVectorResultSchema = z.object({
  /** フレームインデックス */
  frame_index: z.number().int().nonnegative(),
  /** 主要な移動方向 (degree, 0=右, 90=下) */
  primary_direction: z.number().min(0).max(360),
  /** 推定移動速度 (pixels/frame) */
  estimated_speed: z.number().min(0),
  /** 移動タイプ推定 */
  motion_type: motionTypeEnumSchema,
  /** 信頼度スコア (0-1) */
  confidence: z.number().min(0).max(1),
});
export type MotionVectorResult = z.infer<typeof motionVectorResultSchema>;

/**
 * モーションベクトルサマリースキーマ
 */
export const motionVectorSummarySchema = z.object({
  /** 主要な移動方向 */
  primary_direction: z.number().min(0).max(360),
  /** 平均速度 */
  avg_speed: z.number().min(0),
  /** 個別結果 */
  vectors: z.array(motionVectorResultSchema).optional(),
});
export type MotionVectorSummary = z.infer<typeof motionVectorSummarySchema>;

/**
 * 要素アニメーションヒント
 */
export const animationHintSchema = z.enum([
  'instant',
  'fade',
  'slide',
  'scale',
  'unknown',
]);
export type AnimationHint = z.infer<typeof animationHintSchema>;

/**
 * 要素出現/消失イベントスキーマ
 */
export const visibilityEventSchema = z.object({
  /** イベントタイプ */
  type: z.enum(['appear', 'disappear']),
  /** 発生フレームインデックス */
  frame_index: z.number().int().nonnegative(),
  /** 要素領域 */
  region: boundingBoxSchema,
  /** 推定アニメーションタイプ */
  animation_hint: animationHintSchema,
});
export type VisibilityEvent = z.infer<typeof visibilityEventSchema>;

/**
 * 要素出現/消失結果スキーマ
 */
export const elementVisibilityResultSchema = z.object({
  /** 出現/消失イベント */
  events: z.array(visibilityEventSchema),
});
export type ElementVisibilityResult = z.infer<typeof elementVisibilityResultSchema>;

/**
 * タイムラインエントリスキーマ
 */
export const timelineEntrySchema = z.object({
  /** フレームインデックス */
  frame_index: z.number().int().nonnegative(),
  /** タイムスタンプ (ms) */
  timestamp_ms: z.number().min(0),
  /** モーション検出フラグ */
  has_motion: z.boolean(),
  /** フレーム変化率 (オプション) */
  change_ratio: z.number().min(0).max(1).optional(),
  /** レイアウトシフト検出フラグ (オプション) */
  has_layout_shift: z.boolean().optional(),
  /** 色変化検出フラグ (オプション) */
  has_color_change: z.boolean().optional(),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

/**
 * 解析結果スキーマ
 */
export const analysisResultsSchema = z.object({
  /** フレーム差分結果 */
  frame_diff: frameDiffSummarySchema.optional(),
  /** レイアウトシフト結果 */
  layout_shift: layoutShiftSummarySchema.optional(),
  /** 色変化結果 */
  color_change: colorChangeResultSchema.optional(),
  /** モーションベクトル結果 */
  motion_vector: motionVectorSummarySchema.optional(),
  /** 要素出現/消失結果 */
  element_visibility: elementVisibilityResultSchema.optional(),
});
export type AnalysisResults = z.infer<typeof analysisResultsSchema>;

// ============================================================================
// Output Schema
// ============================================================================

/**
 * motion.analyze_frames 成功レスポンスデータスキーマ
 */
export const analyzeFramesDataSchema = z.object({
  /** 解析したフレーム数 */
  frame_count: z.number().int().positive(),
  /** 解析結果 */
  analysis_results: analysisResultsSchema,
  /** タイムライン */
  timeline: z.array(timelineEntrySchema),
  /** 処理時間 (ms) */
  processing_time_ms: z.number().min(0),
});
export type AnalyzeFramesData = z.infer<typeof analyzeFramesDataSchema>;

/**
 * エラー情報スキーマ
 */
export const analyzeFramesErrorSchema = z.object({
  /** エラーコード */
  code: z.string(),
  /** エラーメッセージ */
  message: z.string(),
  /** 詳細情報 */
  details: z.unknown().optional(),
});
export type AnalyzeFramesError = z.infer<typeof analyzeFramesErrorSchema>;

/**
 * motion.analyze_frames 成功レスポンススキーマ
 */
export const analyzeFramesSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: analyzeFramesDataSchema,
});

/**
 * motion.analyze_frames 失敗レスポンススキーマ
 */
export const analyzeFramesErrorOutputSchema = z.object({
  success: z.literal(false),
  error: analyzeFramesErrorSchema,
});

/**
 * motion.analyze_frames 出力スキーマ（統合）
 */
export const analyzeFramesOutputSchema = z.discriminatedUnion('success', [
  analyzeFramesSuccessOutputSchema,
  analyzeFramesErrorOutputSchema,
]);
export type AnalyzeFramesOutput = z.infer<typeof analyzeFramesOutputSchema>;

// ============================================================================
// MCP Tool Definition
// ============================================================================

/**
 * MCP Tool definition for motion.analyze_frames
 */
export const analyzeFramesMcpTool = {
  name: 'motion.analyze_frames',
  description: `フレーム画像（PNG/JPEG連番）を解析し、モーション/アニメーションパターンを検出します。

対応する解析タイプ:
- frame_diff: フレーム間のピクセルレベル変化を検出
- layout_shift: 予期しないレイアウト変化（CLS問題）を検出
- color_change: フェードイン/アウトなどの色・透明度変化を検出
- motion_vector: 移動方向と速度を推定
- element_visibility: 新規要素の出現や既存要素の消失を検出

入力: motion.detect の enable_frame_capture で生成されたフレーム画像ディレクトリ
出力: 解析結果（変化率、レイアウトシフトスコア、タイムライン等）`,
  inputSchema: analyzeFramesInputSchema,
} as const;
