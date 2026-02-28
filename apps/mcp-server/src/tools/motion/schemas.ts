// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.* MCP Tools Zod Schema Definitions
 * Webページのモーション/アニメーションパターン検出ツールの入力/出力バリデーションスキーマ
 *
 * @module @reftrix/mcp-server/tools/motion/schemas
 *
 * 対応ツール:
 * - motion.detect: Webページからモーション/アニメーションパターンを検出
 *
 * 検出対象:
 * - CSS Animation (@keyframes)
 * - CSS Transition
 * - アニメーションライブラリ (Framer Motion, GSAP, etc.)
 */
import { z } from 'zod';

// ============================================================================
// Detection Mode Schema (v0.1.0)
// ============================================================================

/**
 * 検出モード
 *
 * モード選択ガイド:
 * - 'css': CSS静的解析のみ。html または pageId が必須。
 *   用途: layout.ingest → motion.detect パイプライン、静的HTMLの解析
 *   長所: 高速、リソース軽量、Playwright不要
 *   短所: JS駆動アニメーション（GSAP, Framer Motion等）検出不可
 *
 * - 'runtime': JavaScript駆動アニメーション検出。url が必須。
 *   用途: SPA/React/Vue/Next.js等のJS駆動サイト
 *   長所: CSS-in-JS、JSアニメーションライブラリを検出可能
 *   短所: Playwright起動オーバーヘッド（数秒）
 *
 * - 'hybrid': CSS + runtime 両方を組み合わせた検出。url が必須。
 *   用途: 最も包括的な検出が必要な場合
 *   長所: 静的CSS + JS駆動の両方を検出
 *   短所: 2倍のリソース消費、処理時間増加
 *
 * - 'video': 動画キャプチャ + フレーム解析。url が必須。
 *   用途: 視覚的なモーション検出、Lighthouse連携
 *   長所: 実際のレンダリング結果を解析
 *   短所: 最大リソース消費、長時間処理
 *
 * - 'library_only' (v0.1.0): ライブラリ検出のみ。url が必須。
 *   用途: WebGL/Three.jsサイトでの高速検出、layout_first モード
 *   長所: 超高速（5-15秒）、グローバルオブジェクト検出のみ
 *   短所: アニメーション詳細（duration, easing等）は取得不可
 *   検出対象: window.THREE, window.gsap, window.anime, data-framer-* 等
 *
 * 推奨:
 * - 静的サイト/事前取得HTML: 'css'
 * - SPA/JSフレームワーク: 'runtime' または 'hybrid'
 * - パフォーマンス分析: 'video' + lighthouse_options
 * - WebGL/Three.jsサイト: 'library_only' (layout_first='auto'時に自動選択)
 */
export const detectionModeSchema = z.enum(['css', 'runtime', 'hybrid', 'video', 'library_only']);
export type DetectionMode = z.infer<typeof detectionModeSchema>;

// ============================================================================
// JS Animation Detection Options Schema (v0.1.0)
// ============================================================================

/**
 * JSアニメーション検出オプションスキーマ
 *
 * Chrome DevTools Protocol (CDP) と Web Animations API を使用した
 * JavaScript駆動アニメーションの包括的検出オプション
 *
 * @property enable_cdp - CDP Animation ドメインを使用してアニメーション検出 (default: true)
 * @property enable_web_animations - Web Animations API (document.getAnimations()) を使用 (default: true)
 * @property enable_library_detection - ライブラリ検出を有効にするか (default: true)
 * @property wait_time - アニメーション待機時間（ms）(default: 1000)
 */
export const jsAnimationOptionsSchema = z.object({
  enable_cdp: z
    .boolean()
    .default(true)
    .describe('Enable CDP Animation domain for animation detection'),
  enable_web_animations: z
    .boolean()
    .default(true)
    .describe('Enable Web Animations API (document.getAnimations()) detection'),
  enable_library_detection: z
    .boolean()
    .default(true)
    .describe('Enable library detection (GSAP, Framer Motion, Anime.js, Three.js, Lottie)'),
  wait_time: z
    .number()
    .int()
    .min(0, { message: 'wait_timeは0以上である必要があります' })
    .max(30000, { message: 'wait_timeは30000ms以下にしてください' })
    .default(1000)
    .describe('Wait time for animations to start (ms)'),
});
export type JSAnimationOptions = z.infer<typeof jsAnimationOptionsSchema>;

// ============================================================================
// JS Animation Detection Result Schemas (v0.1.0)
// ============================================================================

/**
 * CDPアニメーションソース情報スキーマ
 */
export const cdpAnimationSourceSchema = z.object({
  duration: z.number().min(0),
  delay: z.number().min(0),
  iterations: z.number().min(0),
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

/**
 * CDP経由で検出されたアニメーションスキーマ
 */
export const cdpAnimationSchema = z.object({
  id: z.string(),
  name: z.string(),
  pausedState: z.boolean(),
  playState: z.string(),
  playbackRate: z.number(),
  startTime: z.number(),
  currentTime: z.number(),
  type: z.enum(['CSSAnimation', 'CSSTransition', 'WebAnimation']),
  source: cdpAnimationSourceSchema,
});
export type CDPAnimation = z.infer<typeof cdpAnimationSchema>;

/**
 * Web Animations APIタイミング情報スキーマ
 */
export const webAnimationTimingSchema = z.object({
  duration: z.number().min(0),
  delay: z.number().min(0),
  iterations: z.number(),
  direction: z.string(),
  easing: z.string(),
  fill: z.string(),
});
export type WebAnimationTiming = z.infer<typeof webAnimationTimingSchema>;

/**
 * Web Animations API キーフレームスキーマ
 */
export const webAnimationKeyframeSchema = z.object({
  offset: z.number().nullable(),
  easing: z.string(),
  composite: z.string(),
}).passthrough();
export type WebAnimationKeyframe = z.infer<typeof webAnimationKeyframeSchema>;

/**
 * Web Animations API で検出されたアニメーションスキーマ
 */
export const webAnimationSchema = z.object({
  id: z.string(),
  playState: z.string(),
  target: z.string(),
  timing: webAnimationTimingSchema,
  keyframes: z.array(webAnimationKeyframeSchema),
});
export type WebAnimation = z.infer<typeof webAnimationSchema>;

/**
 * ライブラリ検出結果スキーマ
 */
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

/**
 * JSアニメーション検出結果スキーマ
 */
export const jsAnimationResultSchema = z.object({
  /** CDP経由で検出されたアニメーション */
  cdpAnimations: z.array(cdpAnimationSchema),
  /** Web Animations API で検出されたアニメーション */
  webAnimations: z.array(webAnimationSchema),
  /** ライブラリ検出結果 */
  libraries: libraryDetectionResultSchema,
  /** 検出にかかった時間（ms） */
  detectionTimeMs: z.number().int().nonnegative(),
  /** 総検出数 */
  totalDetected: z.number().int().nonnegative(),
});
export type JSAnimationResult = z.infer<typeof jsAnimationResultSchema>;

/**
 * ランタイムオプションスキーマ (v0.1.0)
 *
 * @property wait_for_animations - アニメーション待機時間（ms）0-60000
 * @property scroll_positions - スクロール位置の配列（%）0-100
 */
export const runtimeOptionsSchema = z.object({
  wait_for_animations: z
    .number()
    .min(0, { message: 'wait_for_animationsは0以上である必要があります' })
    .max(30000, { message: 'wait_for_animationsは30000ms以下にしてください' })
    .default(3000)
    .optional(),
  scroll_positions: z
    .array(
      z
        .number()
        .min(0, { message: 'scroll_positionは0以上である必要があります' })
        .max(100, { message: 'scroll_positionは100以下である必要があります' })
    )
    .max(20, { message: 'scroll_positionsは最大20個までです' })
    .optional(),
});
export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>;

// ============================================================================
// Video Options Schema (Phase1)
// ============================================================================

/**
 * フレーム解析オプションスキーマ
 *
 * @property fps - フレームレート (1-30, デフォルト: 10)
 * @property change_threshold - 変化検出閾値 (0-1, デフォルト: 0.01)
 * @property min_motion_duration_ms - 最小モーション継続時間 (デフォルト: 100ms)
 */
export const frameAnalysisOptionsSchema = z.object({
  fps: z
    .number()
    .int()
    .min(1, { message: 'fpsは1以上である必要があります' })
    .max(30, { message: 'fpsは30以下にしてください' })
    .default(10)
    .optional(),
  change_threshold: z
    .number()
    .min(0, { message: 'change_thresholdは0以上である必要があります' })
    .max(1, { message: 'change_thresholdは1以下である必要があります' })
    .default(0.01)
    .optional(),
  min_motion_duration_ms: z
    .number()
    .int()
    .min(0, { message: 'min_motion_duration_msは0以上である必要があります' })
    .max(10000, { message: 'min_motion_duration_msは10000以下にしてください' })
    .default(100)
    .optional(),
  gap_tolerance_ms: z
    .number()
    .int()
    .min(0, { message: 'gap_tolerance_msは0以上である必要があります' })
    .max(1000, { message: 'gap_tolerance_msは1000以下にしてください' })
    .default(50)
    .optional(),
});
export type FrameAnalysisOptions = z.infer<typeof frameAnalysisOptionsSchema>;

/**
 * 動画キャプチャオプションスキーマ (Phase1)
 *
 * @property timeout - ページ読み込みタイムアウト (1000-120000ms, デフォルト: 30000)
 * @property record_duration - 録画時間 (1000-60000ms, デフォルト: 5000)
 * @property viewport - ビューポートサイズ (デフォルト: 1280x720)
 * @property scroll_page - スクロール操作を行うか (デフォルト: true)
 * @property move_mouse - マウス移動操作を行うか (デフォルト: true)
 * @property frame_analysis - フレーム解析オプション
 */
export const videoOptionsSchema = z.object({
  timeout: z
    .number()
    .int()
    .min(1000, { message: 'timeoutは1000ms以上である必要があります' })
    .max(120000, { message: 'timeoutは120000ms以下にしてください' })
    .default(30000)
    .optional(),
  record_duration: z
    .number()
    .int()
    .min(1000, { message: 'record_durationは1000ms以上である必要があります' })
    .max(60000, { message: 'record_durationは60000ms以下にしてください' })
    .default(5000)
    .optional(),
  viewport: z
    .object({
      width: z
        .number()
        .int()
        .min(320, { message: 'viewport.widthは320以上である必要があります' })
        .max(4096, { message: 'viewport.widthは4096以下にしてください' }),
      height: z
        .number()
        .int()
        .min(240, { message: 'viewport.heightは240以上である必要があります' })
        .max(4096, { message: 'viewport.heightは4096以下にしてください' }),
    })
    .optional(),
  scroll_page: z.boolean().default(true).optional(),
  move_mouse: z.boolean().default(true).optional(),
  wait_until: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load').optional(),
  frame_analysis: frameAnalysisOptionsSchema.optional(),
});
export type VideoOptions = z.infer<typeof videoOptionsSchema>;

// ============================================================================
// Frame Capture Options Schema (video mode)
// ============================================================================

/**
 * 合計フレーム数の最大制限
 * DoS攻撃やリソース枯渇を防ぐため、120fps × 300sec = 36,000 ではなく
 * より安全な 3,600 フレーム（30fps × 2分相当）を上限とする
 */
export const MAX_TOTAL_FRAMES = 3600;

/**
 * フレームキャプチャオプションスキーマ (video mode)
 *
 * ページをスクロールしながらフレームを連続撮影し、動画制作用の素材を生成する機能
 *
 * @property frame_rate - フレームレート (1-120fps, デフォルト: 30)
 * @property frame_interval_ms - フレーム間隔 (ms, 自動計算: 1000/frame_rate)
 * @property scroll_speed_px_per_sec - スクロール速度 (px/sec, 自動計算: page_height_px/scroll_duration_sec)
 * @property scroll_px_per_frame - フレームあたりスクロール量 (px, 自動計算: scroll_speed_px_per_sec/frame_rate)
 * @property output_format - 出力形式 (png|jpeg, デフォルト: png)
 * @property output_dir - 出力ディレクトリ (デフォルト: /tmp/reftrix-frames/)
 * @property filename_pattern - ファイル名パターン (デフォルト: frame-{0000}.png)
 * @property page_height_px - ページ高さ (px, デフォルト: 1080)
 * @property scroll_duration_sec - スクロール時間 (秒, デフォルト: 5)
 *
 * セキュリティ対策:
 * - output_dir: パストラバーサル文字(..)を禁止
 * - filename_pattern: パス区切り文字(/、..)を禁止
 * - 合計フレーム数: MAX_TOTAL_FRAMES (3600) 以下に制限
 */
export const frameCaptureOptionsSchema = z
  .object({
    frame_rate: z
      .number()
      .int()
      .min(1, { message: 'frame_rateは1以上である必要があります' })
      .max(120, { message: 'frame_rateは120以下にしてください' })
      .optional(),
    frame_interval_ms: z
      .number()
      .min(1, { message: 'frame_interval_msは1以上である必要があります' })
      .optional(),
    scroll_speed_px_per_sec: z
      .number()
      .min(1, { message: 'scroll_speed_px_per_secは1以上である必要があります' })
      .optional(),
    scroll_px_per_frame: z
      .number()
      .min(0.01, { message: 'scroll_px_per_frameは0.01以上である必要があります' })
      .optional(),
    output_format: z.enum(['png', 'jpeg']).optional(),
    output_dir: z
      .string()
      .min(1, { message: 'output_dirは1文字以上必要です' })
      .refine(
        (dir) => !dir.includes('..'),
        { message: 'output_dirにパストラバーサル文字(..)は使用できません' }
      )
      .optional(),
    filename_pattern: z
      .string()
      .min(1, { message: 'filename_patternは1文字以上必要です' })
      .refine(
        (pattern) => !pattern.includes('..') && !pattern.includes('/'),
        { message: 'filename_patternにパス区切り文字(/または..)は使用できません' }
      )
      .optional(),
    page_height_px: z
      .number()
      .int()
      .min(100, { message: 'page_height_pxは100以上である必要があります' })
      .max(100000, { message: 'page_height_pxは100000以下にしてください' })
      .optional(),
    scroll_duration_sec: z
      .number()
      .min(0.1, { message: 'scroll_duration_secは0.1以上である必要があります' })
      .max(300, { message: 'scroll_duration_secは300以下にしてください' })
      .optional(),
  })
  .refine(
    (data) => {
      // 合計フレーム数制限チェック
      const frameRate = data.frame_rate ?? 30;
      const scrollDuration = data.scroll_duration_sec ?? 5;
      const totalFrames = Math.ceil(frameRate * scrollDuration);
      return totalFrames <= MAX_TOTAL_FRAMES;
    },
    {
      message: `合計フレーム数は${MAX_TOTAL_FRAMES}以下である必要があります（frame_rate × scroll_duration_sec）`,
    }
  );
export type FrameCaptureOptions = z.infer<typeof frameCaptureOptionsSchema>;

/**
 * フレームファイル情報スキーマ
 */
export const frameFileInfoSchema = z.object({
  frame_number: z.number().int().nonnegative(),
  scroll_position_px: z.number().nonnegative(),
  timestamp_ms: z.number().nonnegative(),
  file_path: z.string(),
});
export type FrameFileInfo = z.infer<typeof frameFileInfoSchema>;

/**
 * フレームキャプチャ結果スキーマ
 *
 * FrameCaptureServiceResult と整合性を保つ。
 * Phase5: v0.1.0 で実装構造に合わせて更新。
 */
export const frameCaptureResultSchema = z.object({
  total_frames: z.number().int().nonnegative(),
  output_dir: z.string(),
  config: z.object({
    scroll_px_per_frame: z.number().positive(),
    frame_interval_ms: z.number().positive(),
    output_format: z.enum(['png', 'jpeg']),
    output_dir: z.string(),
    filename_pattern: z.string(),
  }),
  files: z.array(frameFileInfoSchema),
  duration_ms: z.number().int().nonnegative(),
});
export type FrameCaptureResult = z.infer<typeof frameCaptureResultSchema>;

// ============================================================================
// Frame Image Analysis Input Options Schema (Phase5)
// ============================================================================

/**
 * フレーム画像分析入力オプションスキーマ (Phase5: v0.1.0)
 *
 * Pixelmatch + Sharpを使用したフレーム差分分析のオプション。
 * analyze_frames=trueの場合にのみ有効。
 *
 * @property frame_dir - フレーム画像ディレクトリ（省略時はframeCaptureResult.output_dir または frame_capture_options.output_dir、最終フォールバック: /tmp/reftrix-frames/）
 * @property sample_interval - サンプリング間隔（N番目のフレームごと、デフォルト: 10）
 * @property diff_threshold - ピクセル差分しきい値（0-1、デフォルト: 0.1）
 * @property cls_threshold - CLS（レイアウトシフト）しきい値（デフォルト: 0.05）
 * @property motion_threshold - モーション検出しきい値（ピクセル、デフォルト: 50）
 * @property output_diff_images - 差分可視化画像を出力するか（デフォルト: false）
 * @property parallel - 並列処理を有効にするか（デフォルト: true）
 */
export const frameImageAnalysisInputOptionsSchema = z.object({
  /**
   * フレーム画像が保存されているディレクトリ
   * 指定しない場合はframe_capture_options.output_dirを使用します。
   * それも未指定の場合は'/tmp/reftrix-frames/'を使用します。
   */
  frame_dir: z
    .string()
    .min(1, { message: 'frame_dirは1文字以上必要です' })
    .refine(
      (dir) => !dir.includes('..'),
      { message: 'frame_dirにパストラバーサル文字(..)は使用できません' }
    )
    .optional()
    .describe('Directory containing frame images. Falls back to frameCaptureResult.output_dir, frame_capture_options.output_dir, or "/tmp/reftrix-frames/".'),

  /**
   * サンプリング間隔（N番目のフレームごとに分析）
   * 大きな値にすると分析が高速化しますが、精度が低下します。
   * @default 10
   * @minimum 1
   * @maximum 100
   */
  sample_interval: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('Analyze every Nth frame. Higher values = faster but less precise. (1-100, default: 10)'),

  /**
   * ピクセル差分しきい値（0-1）
   * この値を超える差分があるフレームペアを「有意な変化」として検出します。
   * @default 0.1
   * @minimum 0
   * @maximum 1
   */
  diff_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe('Pixel diff threshold (0-1). Frame pairs exceeding this are marked as significant changes. (default: 0.1)'),

  /**
   * レイアウトシフト(CLS)しきい値
   * Core Web Vitals基準では0.05が良好とされます。
   * @default 0.05
   * @minimum 0
   * @maximum 1
   */
  cls_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.05)
    .describe('Layout shift (CLS) threshold. Core Web Vitals considers 0.05 as "good". (default: 0.05)'),

  /**
   * モーション検出しきい値（ピクセル）
   * この値を超える移動量があるフレームペアでモーションベクトルを検出します。
   * @default 50
   * @minimum 1
   * @maximum 500
   */
  motion_threshold: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe('Motion detection threshold in pixels. Movements exceeding this are tracked as motion vectors. (default: 50)'),

  /**
   * 差分画像を出力するか
   * trueにすると、フレーム間の差分を可視化した画像を生成します。
   * @default false
   */
  output_diff_images: z
    .boolean()
    .default(false)
    .describe('Generate diff visualization images for each frame pair. (default: false)'),

  /**
   * 並列処理を有効にするか
   * @default true
   */
  parallel: z
    .boolean()
    .default(true)
    .describe('Enable parallel frame processing. (default: true)'),
});
export type FrameImageAnalysisInputOptions = z.infer<typeof frameImageAnalysisInputOptionsSchema>;

// ============================================================================
// Lighthouse Options Schema (Phase3)
// ============================================================================

/**
 * Lighthouseカテゴリ
 */
export const lighthouseCategorySchema = z.enum([
  'performance',
  'accessibility',
  'best-practices',
  'seo',
]);
export type LighthouseCategory = z.infer<typeof lighthouseCategorySchema>;

/**
 * Lighthouseオプションスキーマ (Phase3)
 *
 * motion.detect 実行後にLighthouseを実行してパフォーマンスメトリクスを収集するオプション
 *
 * @property enabled - Lighthouse実行を有効にするか (default: false)
 * @property categories - 収集するカテゴリ配列 (default: ['performance'])
 * @property throttling - ネットワーク/CPU スロットリングを適用するか (default: false)
 * @property timeout - Lighthouse実行タイムアウト (30000-120000ms, default: 60000)
 * @property save_to_db - 結果をDBに保存するか (default: false)
 */
export const lighthouseOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  categories: z
    .array(lighthouseCategorySchema)
    .default(['performance'])
    .optional(),
  throttling: z.boolean().default(false).optional(),
  timeout: z
    .number()
    .int()
    .min(30000, { message: 'timeoutは30000ms以上である必要があります' })
    .max(120000, { message: 'timeoutは120000ms以下にしてください' })
    .default(60000)
    .optional(),
  save_to_db: z.boolean().default(false).optional(),
});
export type LighthouseOptions = z.infer<typeof lighthouseOptionsSchema>;

/**
 * Lighthouseメトリクススキーマ (Phase3)
 *
 * Lighthouse実行結果のパフォーマンスメトリクス
 *
 * @property fcp - First Contentful Paint (ms)
 * @property lcp - Largest Contentful Paint (ms)
 * @property cls - Cumulative Layout Shift (0-1)
 * @property tbt - Total Blocking Time (ms)
 * @property si - Speed Index (ms)
 * @property tti - Time to Interactive (ms)
 * @property performance_score - パフォーマンススコア (0-100)
 * @property fetched_at - 取得日時 (ISO 8601)
 */
export const lighthouseMetricsSchema = z.object({
  fcp: z.number().min(0, { message: 'fcpは0以上である必要があります' }),
  lcp: z.number().min(0, { message: 'lcpは0以上である必要があります' }),
  cls: z
    .number()
    .min(0, { message: 'clsは0以上である必要があります' })
    .max(1, { message: 'clsは1以下である必要があります' }),
  tbt: z.number().min(0, { message: 'tbtは0以上である必要があります' }),
  si: z.number().min(0, { message: 'siは0以上である必要があります' }),
  tti: z.number().min(0, { message: 'ttiは0以上である必要があります' }),
  performance_score: z
    .number()
    .min(0, { message: 'performance_scoreは0以上である必要があります' })
    .max(100, { message: 'performance_scoreは100以下である必要があります' }),
  fetched_at: z.string(),
});
export type LighthouseMetrics = z.infer<typeof lighthouseMetricsSchema>;

// ============================================================================
// Analyze Metrics Options Schema (Phase4)
// ============================================================================

/**
 * AnimationMetricsCollector オプションスキーマ (Phase4)
 *
 * motion.detect 実行後にアニメーションパフォーマンス分析を行うオプション
 *
 * @property include_recommendations - 改善提案を含めるか (default: true)
 * @property include_cls_contributors - CLS貢献者リストを含めるか (default: true)
 * @property timeout - 分析タイムアウト (1000-60000ms, default: 30000)
 */
export const analyzeMetricsOptionsSchema = z.object({
  include_recommendations: z.boolean().default(true).optional(),
  include_cls_contributors: z.boolean().default(true).optional(),
  timeout: z
    .number()
    .int()
    .min(1000, { message: 'timeoutは1000ms以上である必要があります' })
    .max(60000, { message: 'timeoutは60000ms以下にしてください' })
    .default(30000)
    .optional(),
});
export type AnalyzeMetricsOptions = z.infer<typeof analyzeMetricsOptionsSchema>;

// ============================================================================
// AnimationMetricsResult Output Schema (Phase4)
// ============================================================================

/**
 * 個別アニメーションのパフォーマンス影響スコアスキーマ
 */
export const animationImpactScoreSchema = z.object({
  /** パターンID */
  patternId: z.string(),
  /** パターン名 */
  patternName: z.string(),
  /** 総合影響スコア (0-100, 高いほど悪い) */
  impactScore: z.number().min(0).max(100),
  /** レイアウト影響スコア (0-100) */
  layoutImpact: z.number().min(0).max(100),
  /** レンダリング影響スコア (0-100) */
  renderImpact: z.number().min(0).max(100),
  /** CPU影響スコア (0-100) */
  cpuImpact: z.number().min(0).max(100),
  /** 影響カテゴリ */
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  /** 詳細情報 */
  details: z.record(z.unknown()).optional(),
});
export type AnimationImpactScore = z.infer<typeof animationImpactScoreSchema>;

/**
 * CLS貢献者スキーマ
 */
export const clsContributorSchema = z.object({
  /** 要素セレクタ */
  selector: z.string(),
  /** CLS貢献度 (0-1) */
  contribution: z.number().min(0).max(1),
  /** 関連パターンID */
  relatedPatternId: z.string().optional(),
  /** シフト量（ピクセル） */
  shiftAmount: z.number().optional(),
});
export type ClsContributor = z.infer<typeof clsContributorSchema>;

/**
 * パフォーマンス改善推奨スキーマ
 */
export const performanceRecommendationSchema = z.object({
  /** 推奨ID */
  id: z.string(),
  /** 重要度 */
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  /** カテゴリ */
  category: z.enum(['layout', 'rendering', 'animation', 'accessibility']),
  /** タイトル */
  title: z.string(),
  /** 説明 */
  description: z.string(),
  /** 影響を受けるパターンID */
  affectedPatterns: z.array(z.string()),
  /** 推定改善効果 (0-1) */
  estimatedImpact: z.number().min(0).max(1),
  /** 実装難易度 */
  effort: z.enum(['low', 'medium', 'high']),
});
export type PerformanceRecommendation = z.infer<typeof performanceRecommendationSchema>;

/**
 * AnimationMetricsResult スキーマ (Phase4)
 *
 * AnimationMetricsCollector が MotionPattern + LighthouseMetrics を分析した結果
 *
 * @property patternImpacts - 個別アニメーションのパフォーマンス影響スコア
 * @property overallScore - 総合スコア (0-100, 高いほど良い)
 * @property clsContributors - CLSに貢献している要素のリスト
 * @property layoutTriggeringProperties - レイアウトをトリガーするプロパティ
 * @property recommendations - パフォーマンス改善推奨
 * @property lighthouseAvailable - Lighthouseメトリクスが利用可能か
 * @property analyzedAt - 分析日時 (ISO 8601)
 */
export const animationMetricsResultSchema = z.object({
  patternImpacts: z.array(animationImpactScoreSchema),
  overallScore: z.number().min(0).max(100),
  clsContributors: z.array(clsContributorSchema),
  layoutTriggeringProperties: z.array(z.string()),
  recommendations: z.array(performanceRecommendationSchema),
  lighthouseAvailable: z.boolean(),
  analyzedAt: z.string(),
});
export type AnimationMetricsResult = z.infer<typeof animationMetricsResultSchema>;

// ============================================================================
// Enum Schemas
// ============================================================================

/**
 * モーションパターンのタイプ
 */
export const motionTypeSchema = z.enum([
  'css_animation',
  'css_transition',
  'keyframes',
  'library_animation',
  'video_motion', // Phase1: フレーム解析で検出されたモーション
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
  'scroll_trigger',
  'hover_effect',
  'page_transition',
  'loading_state',
  'micro_interaction',
  'attention_grabber',
  'navigation',
  'feedback',
  'entrance',
  'exit',
  // v0.1.0 new categories
  'marquee',
  'video_overlay',
  'parallax',
  'reveal',
  'morphing',
  'background_animation',
  'typing_animation',
  'unknown',
]);
export type MotionCategory = z.infer<typeof motionCategorySchema>;

/**
 * トリガータイプ
 */
export const triggerTypeSchema = z.enum([
  'scroll',
  'scroll_velocity',
  'hover',
  'click',
  'focus',
  'load',
  'intersection',
  'time',
  'state_change',
  'unknown',
]);
export type TriggerType = z.infer<typeof triggerTypeSchema>;

/**
 * イージングタイプ
 */
export const easingTypeSchema = z.enum([
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'cubic-bezier',
  'spring',
  'steps',
  'unknown',
]);
export type EasingType = z.infer<typeof easingTypeSchema>;

/**
 * 警告の重要度
 */
export const warningSeveritySchema = z.enum(['info', 'warning', 'error']);
export type WarningSeverity = z.infer<typeof warningSeveritySchema>;

/**
 * パフォーマンスレベル
 */
export const performanceLevelSchema = z.enum([
  'excellent',
  'good',
  'fair',
  'poor',
]);
export type PerformanceLevel = z.infer<typeof performanceLevelSchema>;

// ============================================================================
// Sub-schemas
// ============================================================================

/**
 * イージング設定スキーマ
 */
export const easingConfigSchema = z.object({
  type: easingTypeSchema,
  cubicBezier: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .optional(),
  steps: z
    .object({
      count: z.number().int().positive(),
      position: z.enum(['start', 'end', 'jump-start', 'jump-end', 'jump-both', 'jump-none']).optional(),
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
  type: z.enum(['3d_rotation', 'z_translation', 'perspective_function', 'complex_3d']),
  axes: z.array(z.enum(['X', 'Y', 'Z'])).optional(),
  rotationRange: z.object({
    min: z.number(),
    max: z.number(),
  }).optional(),
  translationRange: z.object({
    min: z.number(),
    max: z.number(),
  }).optional(),
  rotationAngles: z.record(z.string(), z.object({
    from: z.number(),
    to: z.number(),
  })).optional(),
  perspectiveValue: z.number().optional(),
  parentPerspective: z.number().optional(),
  transformStyle: z.enum(['flat', 'preserve-3d']).optional(),
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
  mergedFrom: z.array(z.enum(['css', 'runtime'])),
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
    iterations: z.union([z.number().positive(), z.literal('infinite')]).optional(),
    direction: z
      .enum(['normal', 'reverse', 'alternate', 'alternate-reverse'])
      .optional(),
    fillMode: z.enum(['none', 'forwards', 'backwards', 'both']).optional(),
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
  detectionSource: z.enum(['css', 'runtime']).optional(),

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
      intensity: z.enum(['low', 'medium', 'high']),
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
  detection_mode: z.enum(['css', 'runtime', 'hybrid', 'video']).optional(),
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

// ============================================================================
// motion.detect Input Schema
// ============================================================================

/**
 * motion.detect 入力スキーマ
 *
 * @property pageId - WebページID（UUID形式、htmlと排他）
 * @property html - HTMLコンテンツ（最大10MB、pageIdと排他）
 * @property css - 追加CSSコンテンツ（最大5MB）
 * @property includeInlineStyles - インラインスタイルを解析するか（デフォルトtrue）
 * @property includeStyleSheets - スタイルシートを解析するか（デフォルトtrue）
 * @property minDuration - 検出する最小duration（ms、デフォルト0）
 * @property maxPatterns - 最大検出パターン数（デフォルト100）
 * @property includeWarnings - 警告を含めるか（デフォルトtrue）
 * @property min_severity - 返却する警告の最小重要度（info/warning/error、デフォルトinfo）
 * @property includeSummary - サマリーを含めるか（デフォルトtrue）
 * @property verbose - 詳細モード（rawCssを含める、デフォルトfalse）
 */
/**
 * 外部CSSオプションスキーマ
 */
export const externalCssOptionsSchema = z.object({
  timeout: z
    .number()
    .int()
    .min(1000, { message: 'timeoutは1000ms以上である必要があります' })
    .max(30000, { message: 'timeoutは30000ms以下にしてください' })
    .default(5000),
  maxConcurrent: z
    .number()
    .int()
    .min(1, { message: 'maxConcurrentは1以上である必要があります' })
    .max(10, { message: 'maxConcurrentは10以下にしてください' })
    .default(5),
});
export type ExternalCssOptions = z.infer<typeof externalCssOptionsSchema>;

export const motionDetectInputSchema = z
  .object({
    pageId: z
      .string()
      .uuid({ message: '有効なUUID形式のpageIdを指定してください' })
      .optional(),
    html: z
      .string()
      .min(1, { message: 'HTMLコンテンツは1文字以上必要です' })
      .max(10_000_000, { message: 'HTMLコンテンツは10MB以下にしてください' })
      .optional(),
    css: z
      .string()
      .max(5_000_000, { message: 'CSSコンテンツは5MB以下にしてください' })
      .optional(),
    includeInlineStyles: z.boolean().default(true),
    includeStyleSheets: z.boolean().default(true),
    minDuration: z
      .number()
      .min(0, { message: 'minDurationは0以上である必要があります' })
      .max(60000, { message: 'minDurationは60000ms以下にしてください' })
      .default(0),
    maxPatterns: z
      .number()
      .int()
      .min(1, { message: 'maxPatternsは1以上である必要があります' })
      .max(4000, { message: 'maxPatternsは4000以下にしてください' })
      .default(100),
    includeWarnings: z.boolean().default(true),
    min_severity: warningSeveritySchema.optional().default('info'),
    includeSummary: z.boolean().default(true),
    verbose: z.boolean().default(false),

    // v0.1.0: 検出モード
    detection_mode: detectionModeSchema
      .default('video')
      .describe(
        "Detection mode: 'video' (default, requires url) for visual motion detection with frame capture and Lighthouse integration, 'css' (requires html/pageId) for static CSS parsing, 'runtime' (requires url) for JS-driven animations (SPA/React/Vue), 'hybrid' (requires url) for CSS+runtime combined."
      ),

    // v0.1.0: 3D効果検出オプション
    include_perspective: z.boolean().default(false),

    // v0.1.0: ランタイム検出オプション
    runtime_options: runtimeOptionsSchema.optional(),

    // 外部CSS取得オプション
    fetchExternalCss: z.boolean().default(true),
    baseUrl: z
      .string()
      .url({ message: 'baseUrlは有効なURL形式である必要があります' })
      .optional(),
    externalCssOptions: externalCssOptionsSchema.optional(),
    // DB保存オプション
    save_to_db: z.boolean().default(true),

    // ============================================
    // Phase1: 動画キャプチャオプション (v0.1.0)
    // ============================================

    /**
     * 動画キャプチャ用URL
     * detection_mode='video'の場合に必須。
     * http/https のみ許可。SSRF対策が適用されます。
     */
    url: z
      .string()
      .url({ message: 'urlは有効なURL形式である必要があります' })
      .refine(
        (url) => {
          try {
            const parsed = new URL(url);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
          } catch {
            return false;
          }
        },
        { message: 'urlはhttp://またはhttps://で始まる必要があります' }
      )
      .optional(),

    /**
     * 動画録画・フレーム解析オプション
     * detection_mode='video'の場合のみ有効。
     */
    video_options: videoOptionsSchema.optional(),

    // ============================================
    // video mode: フレームキャプチャオプション (v0.1.0)
    // ============================================

    /**
     * フレームキャプチャを有効にするか
     * detection_mode='video'の場合のみ有効。
     * trueにすると、ページをスクロールしながらフレームを連続撮影し、
     * フレームキャプチャ用の素材を生成します。
     * @default true
     */
    enable_frame_capture: z
      .boolean()
      .default(true)
      .describe(
        'Enable frame capture for video mode. When true, captures frames while scrolling for video production.'
      ),

    /**
     * フレームキャプチャオプション
     * enable_frame_capture=true の場合のみ有効。
     */
    frame_capture_options: frameCaptureOptionsSchema.optional(),

    // ============================================
    // Phase3: Lighthouseオプション (v0.1.0)
    // ============================================

    /**
     * Lighthouse実行オプション
     * detection_mode='video'の場合のみ有効。
     * 動画キャプチャ後にLighthouseを実行してパフォーマンスメトリクスを収集します。
     */
    lighthouse_options: lighthouseOptionsSchema.optional(),

    // ============================================
    // Phase4: AnimationMetricsCollector パラメータ (v0.1.0)
    // ============================================

    /**
     * アニメーションパフォーマンス分析を有効にするか
     * detection_mode='video' かつ lighthouse_options.enabled=true の場合に有効。
     * trueにすると、MotionPatternとLighthouseメトリクスを分析して
     * アニメーションがパフォーマンスに与える影響を定量化します。
     * @default false
     */
    analyze_metrics: z
      .boolean()
      .default(false)
      .describe(
        'Enable animation performance analysis using AnimationMetricsCollector. Requires detection_mode=video and lighthouse_options.enabled=true.'
      ),

    /**
     * AnimationMetricsCollector オプション
     * analyze_metrics=true の場合のみ有効。
     */
    analyze_metrics_options: analyzeMetricsOptionsSchema.optional(),

    // ============================================
    // Phase5: Frame Image Analysis パラメータ (v0.1.0)
    // ============================================

    /**
     * フレーム画像分析を有効にするか
     * detection_mode='video' の場合に有効。
     * trueにすると、キャプチャされたフレーム画像を解析し、
     * ピクセル差分、レイアウトシフト(CLS)、モーションベクトルを検出します。
     * @default true
     */
    analyze_frames: z
      .boolean()
      .default(true)
      .describe(
        'Enable frame image analysis using Pixelmatch + Sharp. Detects pixel diff, layout shifts (CLS), and motion vectors. Requires detection_mode=video.'
      ),

    /**
     * フレーム画像分析オプション
     * analyze_frames=true の場合のみ有効。
     */
    frame_analysis_options: frameImageAnalysisInputOptionsSchema
      .optional()
      .describe('Frame image analysis options. Only effective when analyze_frames=true.'),

    // ============================================
    // Phase6: JS Animation Detection パラメータ (v0.1.0)
    // ============================================

    /**
     * JSアニメーション検出を有効にするか
     * detection_mode='video', 'runtime', 'hybrid' の場合に有効。
     * trueにすると、Chrome DevTools Protocol (CDP) と Web Animations API を使用して
     * JavaScript駆動のアニメーションを検出します。
     * GSAP, Framer Motion, Anime.js, Three.js, Lottie などのライブラリも検出します。
     * @default false
     */
    detect_js_animations: z
      .boolean()
      .default(false)
      .describe(
        'Enable JS animation detection using CDP and Web Animations API. Detects GSAP, Framer Motion, Anime.js, Three.js, Lottie. Requires url (video/runtime/hybrid mode).'
      ),

    /**
     * JSアニメーション検出オプション
     * detect_js_animations=true の場合のみ有効。
     */
    js_animation_options: jsAnimationOptionsSchema.optional(),

    // ============================================
    // レスポンスサイズ最適化パラメータ (v0.1.0)
    // ============================================

    /**
     * 軽量モード（summary mode）
     * trueにすると、パターンの詳細情報（animation, performance, rawCss等）を除外し、
     * id, name, category, trigger, type のみを返却します。
     * 期待削減率: 70-85%
     * @default false
     */
    summary: z
      .boolean()
      .default(false)
      .describe(
        'Lightweight mode: returns id, name, category, trigger, type only (default: false). When true, detailed animation/performance/rawCss info is excluded for 70-85% response size reduction.'
      ),

    /**
     * レスポンス最大文字数制限
     * 指定した文字数を超える場合、パターンを順次削減して制限内に収めます。
     * 切り詰め発生時は _truncated: true と _original_size がレスポンスに含まれます。
     * @minimum 100
     * @maximum 10000000
     */
    truncate_max_chars: z
      .number()
      .int()
      .min(100, { message: 'truncate_max_charsは100以上である必要があります' })
      .max(10_000_000, { message: 'truncate_max_charsは10000000以下にしてください' })
      .optional()
      .describe(
        'Max response size in characters (100-10000000). When exceeded, patterns are progressively removed and _truncated metadata is added.'
      ),

    /**
     * 自動サイズ最適化
     * trueにすると、レスポンスサイズに応じて自動的に最適化を適用します。
     * - 100KB超: summary=true に切り替え
     * - 500KB超: truncate を適用
     * 適用された最適化は _size_optimization メタデータで報告されます。
     * @default false
     */
    auto_optimize: z
      .boolean()
      .default(false)
      .describe(
        'Auto-optimize response size: applies summary=true when >100KB, truncate when >500KB. Reports applied optimizations in _size_optimization metadata.'
      ),

    // ============================================
    // タイムアウト設定 (v0.1.0)
    // ============================================

    /**
     * 全体タイムアウト（ミリ秒）
     * motion.detect 処理全体の最大実行時間を指定します。
     * タイムアウト発生時は、それまでに取得できた結果（CSS解析等）を
     * 警告付きで返却します（graceful degradation）。
     * @minimum 30000 (30秒)
     * @maximum 600000 (10分)
     * @default 180000 (3分)
     */
    timeout: z
      .number()
      .int()
      .min(30000, { message: 'timeoutは30000ms（30秒）以上である必要があります' })
      .max(600000, { message: 'timeoutは600000ms（10分）以下にしてください' })
      .default(180000)
      .describe(
        'Overall timeout in milliseconds (30000-600000, default: 180000 = 3 minutes). On timeout, returns partial results with warnings (graceful degradation).'
      ),
  })
  .refine(
    (data) => {
      // video/runtime/hybrid モードの場合は url が必須
      if (
        data.detection_mode === 'video' ||
        data.detection_mode === 'runtime' ||
        data.detection_mode === 'hybrid'
      ) {
        return data.url !== undefined;
      }
      // それ以外のモードでは pageId または html が必須
      const hasPageId = data.pageId !== undefined;
      const hasHtml = data.html !== undefined;
      return hasPageId || hasHtml;
    },
    {
      message:
        'detection_mode=video/runtime/hybridの場合はurlが必須、それ以外はpageIdまたはhtmlのいずれかを指定してください',
    }
  )
  .refine(
    (_data) => {
      // video モードでは pageId/html は使用しない（警告ではなく無視される）
      // この refine は検証ではなくドキュメント目的
      return true;
    },
    {
      message: 'detection_mode=videoの場合、pageId/htmlは無視されます',
    }
  )
  .refine(
    (data) => {
      // fetchExternalCss=true の場合、baseUrl が必須
      // ただし、以下の場合は免除:
      // 1. detection_mode='css' かつ html/pageId 指定（CSS静的解析モードでは外部CSSフェッチは任意）
      // 2. detection_mode='video'/'runtime'/'hybrid' かつ url 指定（urlからbaseUrlを推測可能）
      if (data.fetchExternalCss && !data.baseUrl) {
        // css モードで html または pageId が指定されている場合は OK
        if (data.detection_mode === 'css' && (data.html || data.pageId)) {
          return true;
        }
        // video/runtime/hybrid モードで url が指定されている場合は OK（urlからbaseUrlを推測可能）
        if (
          (data.detection_mode === 'video' ||
            data.detection_mode === 'runtime' ||
            data.detection_mode === 'hybrid') &&
          data.url
        ) {
          return true;
        }
        return false;
      }
      return true;
    },
    {
      message: 'fetchExternalCssがtrueの場合、baseUrlは必須です（css+html/pageIdまたはvideo/runtime/hybrid+url指定時を除く）',
      path: ['baseUrl'],
    }
  );
export type MotionDetectInput = z.infer<typeof motionDetectInputSchema>;

// ============================================================================
// motion.detect Output Schema
// ============================================================================

/**
 * DB保存結果スキーマ
 */
export const motionSaveResultSchema = z.object({
  saved: z.boolean(),
  savedCount: z.number().int().nonnegative(),
  patternIds: z.array(z.string().uuid()),
  embeddingIds: z.array(z.string().uuid()),
  /** 保存されなかった理由（saved=false時） */
  reason: z.string().optional(),
});
export type MotionSaveResult = z.infer<typeof motionSaveResultSchema>;

/**
 * デバッグ情報スキーマ（開発環境のみ）
 */
export const debugInfoSchema = z
  .object({
    persistenceServiceAvailable: z.boolean(),
    isAvailable: z.boolean().optional(),
    error: z.string().optional(),
    factoryExists: z.boolean().optional(),
  })
  .optional();

/**
 * ランタイム実行情報スキーマ (v0.1.0)
 *
 * runtime / hybrid モードで返却されるランタイム実行情報
 */
export const runtimeInfoSchema = z.object({
  /** 実際に使用された待機時間（ms） */
  wait_time_used: z.number().min(0).optional(),
  /** キャプチャされたアニメーション数 */
  animations_captured: z.number().int().nonnegative().optional(),
  /** チェックされたスクロール位置の配列（%） */
  scroll_positions_checked: z.array(z.number().min(0).max(100)).optional(),
  /** スクロール位置ごとのパターン数 */
  patterns_by_scroll_position: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /** スクロールで検出されたパターン総数 */
  total_scroll_patterns: z.number().int().nonnegative().optional(),
});
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;

/**
 * ビデオ解析情報スキーマ (Phase1: v0.1.0)
 *
 * detection_mode='video' で返却されるビデオ録画・解析情報
 */
export const videoInfoSchema = z.object({
  /** 録画URL */
  recorded_url: z.string().url(),
  /** 録画時間（ms） */
  record_duration_ms: z.number().int().min(0),
  /** 動画ファイルサイズ（bytes） */
  video_size_bytes: z.number().int().nonnegative(),
  /** 解析したフレーム数 */
  frames_analyzed: z.number().int().nonnegative(),
  /** 検出されたモーションセグメント数 */
  motion_segments_detected: z.number().int().nonnegative(),
  /** 処理時間（ms） */
  processing_time_ms: z.number().int().nonnegative(),
  /** ビューポートサイズ */
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  /** ページタイトル */
  page_title: z.string().optional(),
  /** モーションカバレッジ（0-1） - 動画内でモーションが検出された時間の割合 */
  motion_coverage: z.number().min(0).max(1).optional(),
});
export type VideoInfo = z.infer<typeof videoInfoSchema>;

// ============================================================================
// レスポンスサイズ最適化メタデータスキーマ (v0.1.0)
// ============================================================================

/**
 * サイズ最適化情報スキーマ
 * auto_optimize=true 時に適用された最適化の詳細情報
 */
export const sizeOptimizationSchema = z.object({
  /** 最適化前のサイズ（バイト） */
  original_size_bytes: z.number().int().nonnegative(),
  /** 最適化後のサイズ（バイト） */
  optimized_size_bytes: z.number().int().nonnegative(),
  /** 削減率（%） */
  reduction_percent: z.number().min(0).max(100),
  /** 適用された最適化のリスト */
  applied_optimizations: z.array(z.enum(['summary', 'truncate'])),
});
export type SizeOptimization = z.infer<typeof sizeOptimizationSchema>;

/**
 * motion.detect 成功レスポンスデータスキーマ
 */
export const motionDetectDataSchema = z.object({
  pageId: z.string().uuid().optional(),
  patterns: z.array(motionPatternSchema),
  summary: motionSummarySchema.optional(),
  warnings: z.array(motionWarningSchema).optional(),
  metadata: motionMetadataSchema,
  saveResult: motionSaveResultSchema.optional(),
  /** デバッグ情報（開発環境のみ） */
  _debugInfo: debugInfoSchema,
  /** v0.1.0: ランタイム実行情報 (runtime/hybrid モード時) */
  runtime_info: runtimeInfoSchema.optional(),
  /** Phase1 v0.1.0: ビデオ解析情報 (video モード時) */
  video_info: videoInfoSchema.optional(),

  // ============================================
  // video mode: フレームキャプチャ結果 (v0.1.0)
  // ============================================

  /**
   * フレームキャプチャ結果
   * enable_frame_capture=true かつ detection_mode='video' の場合に設定
   * enable_frame_capture=false の場合は undefined
   */
  frame_capture: frameCaptureResultSchema.optional(),

  /**
   * フレームキャプチャエラー情報
   * フレームキャプチャ実行が失敗した場合に設定（graceful degradation）
   */
  frame_capture_error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),

  // ============================================
  // Phase3: Lighthouseメトリクス (v0.1.0)
  // ============================================

  /**
   * Lighthouseパフォーマンスメトリクス
   * lighthouse_options.enabled=true かつ detection_mode='video' の場合に設定
   * エラーまたは利用不可の場合はnull
   */
  lighthouse_metrics: lighthouseMetricsSchema.nullable().optional(),

  /**
   * Lighthouseエラー情報
   * Lighthouse実行が失敗した場合に設定（graceful degradation）
   */
  lighthouse_error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),

  /**
   * Lighthouse DB保存結果
   * lighthouse_options.save_to_db=true の場合に設定
   */
  lighthouse_save_result: z
    .object({
      saved: z.boolean(),
    })
    .optional(),

  // ============================================
  // Phase4: AnimationMetrics分析結果 (v0.1.0)
  // ============================================

  /**
   * アニメーションパフォーマンス分析結果
   * analyze_metrics=true かつ detection_mode='video' かつ lighthouse_options.enabled=true の場合に設定
   * エラーまたは利用不可の場合はnull
   */
  animation_metrics: animationMetricsResultSchema.nullable().optional(),

  /**
   * AnimationMetrics分析エラー情報
   * 分析が失敗した場合に設定（graceful degradation）
   */
  animation_metrics_error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),

  // ============================================
  // Phase5: Frame Image Analysis結果 (v0.1.0)
  // ============================================

  /**
   * フレーム画像分析結果
   * analyze_frames=true かつ detection_mode='video' の場合に設定
   * Pixelmatch + Sharp を使用してフレーム間の差分、レイアウトシフト、モーションベクトルを検出
   */
  frame_analysis: z
    .object({
      /**
       * 分析メタデータ
       */
      metadata: z.object({
        /** 総フレーム数 */
        totalFrames: z.number().int().nonnegative(),
        /** 分析したフレームペア数 */
        analyzedPairs: z.number().int().nonnegative(),
        /** サンプリング間隔 */
        sampleInterval: z.number().int().positive(),
        /** フレームあたりのスクロール量（px） */
        scrollPxPerFrame: z.number().positive(),
        /** 分析時間（秒） */
        analysisTime: z.string(),
        /** 分析日時（ISO 8601） */
        analyzedAt: z.string(),
      }),

      /**
       * 統計情報
       */
      statistics: z.object({
        /** 平均ピクセル差分（%） */
        averageDiffPercentage: z.string(),
        /** 有意な変化があったフレームペア数 */
        significantChangeCount: z.number().int().nonnegative(),
        /** 有意な変化の割合（%） */
        significantChangePercentage: z.string(),
        /** レイアウトシフト検出数 */
        layoutShiftCount: z.number().int().nonnegative(),
        /** モーションベクトル検出数 */
        motionVectorCount: z.number().int().nonnegative(),
      }),

      /**
       * 検出されたアニメーションゾーン
       * 連続する有意な変化がある領域を検出
       */
      animationZones: z.array(
        z.object({
          /** 開始フレーム名 */
          frameStart: z.string(),
          /** 終了フレーム名 */
          frameEnd: z.string(),
          /** スクロール開始位置（px） */
          scrollStart: z.number().nonnegative(),
          /** スクロール終了位置（px） */
          scrollEnd: z.number().nonnegative(),
          /** アニメーション持続時間（スクロールpx） */
          duration: z.number().nonnegative(),
          /** 平均ピクセル差分（%） */
          avgDiff: z.string(),
          /** 最大ピクセル差分（%） */
          peakDiff: z.string(),
          /** アニメーションタイプ推定 */
          animationType: z.enum([
            'micro-interaction',
            'fade/slide transition',
            'scroll-linked animation',
            'long-form reveal',
          ]),
        })
      ),

      /**
       * 検出されたレイアウトシフト（CLS問題）
       * Core Web Vitalsの基準（0.05）を超えるシフトを検出
       */
      layoutShifts: z.array(
        z.object({
          /** フレーム範囲（例: "frame-0010.png - frame-0020.png"） */
          frameRange: z.string(),
          /** スクロール範囲（例: "150px - 300px"） */
          scrollRange: z.string(),
          /** 影響度スコア（CLS指標） */
          impactFraction: z.string(),
          /** 影響を受けた領域のバウンディングボックス */
          boundingBox: z.object({
            x: z.number().int().nonnegative(),
            y: z.number().int().nonnegative(),
            width: z.number().int().nonnegative(),
            height: z.number().int().nonnegative(),
          }),
        })
      ),

      /**
       * 検出されたモーションベクトル
       * 閾値を超える移動があるフレームペアを検出
       */
      motionVectors: z.array(
        z.object({
          /** フレーム範囲 */
          frameRange: z.string(),
          /** X方向移動量（px） */
          dx: z.number(),
          /** Y方向移動量（px） */
          dy: z.number(),
          /** 移動量の大きさ（px） */
          magnitude: z.string(),
          /** 移動方向 */
          direction: z.enum(['up', 'down', 'left', 'right', 'stationary']),
          /** 角度（度） */
          angle: z.string(),
        })
      ),
    })
    .nullable()
    .optional()
    .describe(
      'Frame image analysis results. Set when analyze_frames=true and detection_mode=video. Uses Pixelmatch + Sharp for diff detection, layout shift (CLS) detection, and motion vector estimation.'
    ),

  /**
   * フレーム画像分析エラー情報
   * 分析が失敗した場合に設定（graceful degradation）
   */
  frame_analysis_error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),

  /**
   * フレーム画像分析結果のDB保存結果 (v0.1.0)
   * save_to_db=true かつ analyze_frames=true の場合に、
   * AnimationZone/LayoutShift/MotionVectorをMotionPatternとして保存した結果
   */
  frame_analysis_save_result: z
    .object({
      /** 保存が成功したか */
      saved: z.boolean(),
      /** 保存したパターン数 */
      savedCount: z.number().int().nonnegative(),
      /** 保存したパターンID一覧 */
      patternIds: z.array(z.string().uuid()),
      /** 保存したEmbedding ID一覧 */
      embeddingIds: z.array(z.string().uuid()),
      /** エラー理由（失敗時） */
      reason: z.string().optional(),
      /** カテゴリ別保存数 */
      byCategory: z
        .object({
          animationZones: z.number().int().nonnegative(),
          layoutShifts: z.number().int().nonnegative(),
          motionVectors: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .optional()
    .describe(
      'DB save result for frame analysis. Set when save_to_db=true and analyze_frames=true. Saves AnimationZones, LayoutShifts, and MotionVectors as MotionPatterns with embeddings.'
    ),

  // ============================================
  // Phase6: JS Animation Detection結果 (v0.1.0)
  // ============================================

  /**
   * JSアニメーション検出結果
   * detect_js_animations=true かつ URL指定時（runtime/hybrid/videoモード）に設定
   * Chrome DevTools Protocol + Web Animations API + ライブラリ検出の統合結果
   */
  js_animations: jsAnimationResultSchema.nullable().optional().describe(
    'JS animation detection results. Set when detect_js_animations=true and URL is provided. ' +
      'Combines CDP Animation domain, Web Animations API, and library detection (GSAP, Framer Motion, Anime.js, Three.js, Lottie).'
  ),

  /**
   * JSアニメーション検出エラー情報
   * 検出が失敗した場合に設定（graceful degradation）
   */
  js_animations_error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),

  /**
   * JSアニメーションDB保存結果 (v0.1.0)
   * save_to_db=true かつ JS Animation検出成功時に設定
   * js_animation_patterns + js_animation_embeddings テーブルへの保存結果
   */
  js_animation_save_result: z
    .object({
      savedPatternCount: z.number().int().nonnegative(),
      embeddingCount: z.number().int().nonnegative(),
      error: z.string().optional(),
    })
    .optional()
    .describe(
      'DB save result for JS animation patterns. Set when save_to_db=true and JS animations are detected. ' +
        'Saves to js_animation_patterns and js_animation_embeddings tables with multilingual-e5-base embeddings.'
    ),

  // ============================================
  // レスポンスサイズ最適化メタデータ (v0.1.0)
  // ============================================

  /**
   * サマリーモードフラグ
   * summary=true が適用された場合に true
   */
  _summary_mode: z.boolean().optional(),

  /**
   * 切り詰めフラグ
   * truncate_max_chars による切り詰めが発生した場合に true
   */
  _truncated: z.boolean().optional(),

  /**
   * 切り詰め前の元サイズ（文字数）
   * 切り詰めが発生した場合のみ設定
   */
  _original_size: z.number().int().nonnegative().optional(),

  /**
   * 切り詰められたパターン数
   * truncate_max_chars で削減されたパターンの数
   */
  _patterns_truncated_count: z.number().int().nonnegative().optional(),

  /**
   * サイズ最適化情報
   * auto_optimize=true で最適化が適用された場合に設定
   */
  _size_optimization: sizeOptimizationSchema.optional(),
});
export type MotionDetectData = z.infer<typeof motionDetectDataSchema>;

/**
 * エラー情報スキーマ
 */
export const motionDetectErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type MotionDetectError = z.infer<typeof motionDetectErrorSchema>;

/**
 * motion.detect 成功レスポンススキーマ
 */
export const motionDetectSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: motionDetectDataSchema,
});

/**
 * motion.detect 失敗レスポンススキーマ
 */
export const motionDetectErrorOutputSchema = z.object({
  success: z.literal(false),
  error: motionDetectErrorSchema,
});

/**
 * motion.detect 出力スキーマ（統合）
 */
export const motionDetectOutputSchema = z.discriminatedUnion('success', [
  motionDetectSuccessOutputSchema,
  motionDetectErrorOutputSchema,
]);
export type MotionDetectOutput = z.infer<typeof motionDetectOutputSchema>;

// ============================================================================
// Error Codes
// ============================================================================

/**
 * motion.* ツール用エラーコード
 */
export const MOTION_MCP_ERROR_CODES = {
  /** バリデーションエラー */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** ページが見つからない */
  PAGE_NOT_FOUND: 'PAGE_NOT_FOUND',
  /** 無効なHTML */
  INVALID_HTML: 'INVALID_HTML',
  /** 無効なCSS */
  INVALID_CSS: 'INVALID_CSS',
  /** 解析エラー */
  PARSE_ERROR: 'PARSE_ERROR',
  /** 検出エラー */
  DETECTION_ERROR: 'DETECTION_ERROR',
  /** データベースエラー */
  DB_ERROR: 'DB_ERROR',
  /** 内部エラー */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** サービス利用不可 */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** タイムアウト */
  TIMEOUT: 'TIMEOUT',
  /** Phase1: 動画録画エラー */
  VIDEO_RECORD_ERROR: 'VIDEO_RECORD_ERROR',
  /** Phase1: フレーム解析エラー */
  FRAME_ANALYSIS_ERROR: 'FRAME_ANALYSIS_ERROR',
  /** Phase1: 動画タイムアウトエラー */
  VIDEO_TIMEOUT_ERROR: 'VIDEO_TIMEOUT_ERROR',
  /** Phase1: SSRFブロック */
  SSRF_BLOCKED: 'SSRF_BLOCKED',
} as const;

export type MotionMcpErrorCode =
  (typeof MOTION_MCP_ERROR_CODES)[keyof typeof MOTION_MCP_ERROR_CODES];

// ============================================================================
// Warning Codes
// ============================================================================

/**
 * 警告コード
 */
export const MOTION_WARNING_CODES = {
  /** パフォーマンス警告: レイアウトトリガー */
  PERF_LAYOUT_TRIGGER: 'PERF_LAYOUT_TRIGGER',
  /** パフォーマンス警告: 過度なアニメーション */
  PERF_TOO_MANY_ANIMATIONS: 'PERF_TOO_MANY_ANIMATIONS',
  /** パフォーマンス警告: 長いduration */
  PERF_LONG_DURATION: 'PERF_LONG_DURATION',
  /** アクセシビリティ警告: reduced-motion未対応 */
  A11Y_NO_REDUCED_MOTION: 'A11Y_NO_REDUCED_MOTION',
  /** アクセシビリティ警告: 無限アニメーション */
  A11Y_INFINITE_ANIMATION: 'A11Y_INFINITE_ANIMATION',
  /** 解析警告: 不完全なキーフレーム */
  PARSE_INCOMPLETE_KEYFRAMES: 'PARSE_INCOMPLETE_KEYFRAMES',
  /** 解析警告: 無効なイージング */
  PARSE_INVALID_EASING: 'PARSE_INVALID_EASING',
  /** 外部CSS取得失敗 */
  EXTERNAL_CSS_FETCH_FAILED: 'EXTERNAL_CSS_FETCH_FAILED',
  /** 外部CSS SSRF保護によりブロック */
  EXTERNAL_CSS_SSRF_BLOCKED: 'EXTERNAL_CSS_SSRF_BLOCKED',
  /** Phase3: Lighthouse利用不可 */
  LIGHTHOUSE_UNAVAILABLE: 'LIGHTHOUSE_UNAVAILABLE',
  /** Phase4: AnimationMetrics分析にはLighthouseが必要 */
  ANALYZE_METRICS_REQUIRES_LIGHTHOUSE: 'ANALYZE_METRICS_REQUIRES_LIGHTHOUSE',
  /** Phase4: AnimationMetrics分析が利用不可 */
  ANIMATION_METRICS_UNAVAILABLE: 'ANIMATION_METRICS_UNAVAILABLE',
  /** Phase5: Frame Image Analysis利用不可 */
  FRAME_ANALYSIS_UNAVAILABLE: 'FRAME_ANALYSIS_UNAVAILABLE',
  /** WebGL/Canvas検出機能が無効（detect_js_animations=false時）*/
  WEBGL_DETECTION_DISABLED: 'WEBGL_DETECTION_DISABLED',
} as const;

export type MotionWarningCode =
  (typeof MOTION_WARNING_CODES)[keyof typeof MOTION_WARNING_CODES];

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * パフォーマンスレベルを計算
 */
export function calculatePerformanceLevel(
  info: PerformanceInfo
): PerformanceLevel {
  // GPU加速プロパティのみ使用 && レイアウト/ペイントなし = excellent
  if (
    (info.usesTransform || info.usesOpacity) &&
    !info.triggersLayout &&
    !info.triggersPaint
  ) {
    return 'excellent';
  }

  // レイアウトトリガーあり = poor
  if (info.triggersLayout) {
    return 'poor';
  }

  // ペイントトリガーあり = fair
  if (info.triggersPaint) {
    return 'fair';
  }

  // それ以外 = good
  return 'good';
}

/**
 * 複雑度スコアを計算
 */
export function calculateComplexityScore(patterns: MotionPattern[]): number {
  if (patterns.length === 0) return 0;

  let score = 0;

  // パターン数による加算
  score += Math.min(patterns.length * 5, 30);

  // キーフレーム複雑度
  const keyframeCount = patterns.reduce(
    (sum, p) => sum + (p.keyframes?.length ?? 0),
    0
  );
  score += Math.min(keyframeCount * 2, 20);

  // プロパティ数（propertiesがない場合も安全に処理）
  const propertyCount = patterns.reduce(
    (sum, p) => sum + (p.properties?.length ?? 0),
    0
  );
  score += Math.min(propertyCount * 3, 30);

  // 無限アニメーション（'infinite' または -1 をサポート）
  const infiniteCount = patterns.filter(
    (p) =>
      p.animation?.iterations === 'infinite' ||
      p.animation?.iterations === -1 ||
      p.animation?.iterations === Infinity
  ).length;
  score += Math.min(infiniteCount * 5, 20);

  return Math.min(score, 100);
}

/**
 * 平均duration計算
 */
export function calculateAverageDuration(patterns: MotionPattern[]): number {
  const durations = patterns
    .map((p) => p.animation?.duration)
    .filter((d): d is number => d !== undefined && d > 0);

  if (durations.length === 0) return 0;

  return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
}

/**
 * タイプ別集計
 */
export function countByType(
  patterns: MotionPattern[]
): Record<MotionType, number> {
  const counts: Record<MotionType, number> = {
    css_animation: 0,
    css_transition: 0,
    keyframes: 0,
    library_animation: 0,
    video_motion: 0,
  };

  for (const pattern of patterns) {
    counts[pattern.type]++;
  }

  return counts;
}

/**
 * トリガー別集計
 */
export function countByTrigger(
  patterns: MotionPattern[]
): Record<TriggerType, number> {
  const counts: Record<TriggerType, number> = {
    scroll: 0,
    scroll_velocity: 0,
    hover: 0,
    click: 0,
    focus: 0,
    load: 0,
    intersection: 0,
    time: 0,
    state_change: 0,
    unknown: 0,
  };

  for (const pattern of patterns) {
    counts[pattern.trigger]++;
  }

  return counts;
}

/**
 * カテゴリ別集計
 */
export function countByCategory(
  patterns: MotionPattern[]
): Record<MotionCategory, number> {
  const counts: Record<MotionCategory, number> = {
    scroll_trigger: 0,
    hover_effect: 0,
    page_transition: 0,
    loading_state: 0,
    micro_interaction: 0,
    attention_grabber: 0,
    navigation: 0,
    feedback: 0,
    entrance: 0,
    exit: 0,
    // v0.1.0 new categories
    marquee: 0,
    video_overlay: 0,
    parallax: 0,
    reveal: 0,
    morphing: 0,
    background_animation: 0,
    typing_animation: 0,
    unknown: 0,
  };

  for (const pattern of patterns) {
    counts[pattern.category]++;
  }

  return counts;
}

// ============================================================================
// Frame Capture Utility Functions (video mode)
// ============================================================================

/**
 * フレームキャプチャ設定の計算結果
 */
export interface FrameCaptureConfig {
  frame_rate: number;
  frame_interval_ms: number;
  scroll_speed_px_per_sec: number;
  scroll_px_per_frame: number;
  output_format: 'png' | 'jpeg';
  output_dir: string;
  filename_pattern: string;
  page_height_px: number;
  scroll_duration_sec: number;
  total_frames: number;
}

/**
 * フレームキャプチャ設定を計算
 *
 * デフォルト値を適用し、相互に依存する値を計算します。
 *
 * デフォルト値:
 * - scroll_px_per_frame = 15 (Reftrix仕様)
 * - frame_rate = 30
 * - frame_interval_ms = 1000 / frame_rate = 33.33ms
 *
 * 計算式:
 * - frame_interval_ms = 1000 / frame_rate
 * - scroll_speed_px_per_sec = page_height_px / scroll_duration_sec
 * - total_frames = ceil(scroll_duration_sec * frame_rate)
 *
 * @param options - フレームキャプチャオプション
 * @returns 計算済みの設定
 */
export function calculateFrameCaptureConfig(
  options: FrameCaptureOptions = {}
): FrameCaptureConfig {
  // デフォルト値
  const page_height_px = options.page_height_px ?? 1080;
  const scroll_duration_sec = options.scroll_duration_sec ?? 5;
  const frame_rate = options.frame_rate ?? 30;
  const output_format = options.output_format ?? 'png';
  const output_dir = options.output_dir ?? '/tmp/reftrix-frames/';
  const filename_pattern = options.filename_pattern ?? 'frame-{0000}.png';

  // 計算式: frame_interval_ms = 1000 / frame_rate
  const frame_interval_ms = options.frame_interval_ms ?? 1000 / frame_rate;

  // 計算式: scroll_speed_px_per_sec = page_height_px / scroll_duration_sec
  const scroll_speed_px_per_sec =
    options.scroll_speed_px_per_sec ?? page_height_px / scroll_duration_sec;

  // デフォルト値: 15px/frame（Reftrix仕様）
  // 15px/frameの根拠:
  // - 60fps等価スクロール（216px/秒 ÷ 60 ≈ 3.6px）と50px/frameの中間
  // - IntersectionObserver閾値（0.1〜0.3）を確実に検出
  // - cubic-bezier easing曲線の解析に十分なサンプル数
  // - parallax微動（係数0.02〜0.05）の検出可能
  const scroll_px_per_frame = options.scroll_px_per_frame ?? 15;

  // 計算式: total_frames = scroll_duration_sec * frame_rate
  const total_frames = Math.ceil(scroll_duration_sec * frame_rate);

  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_FRAME_CAPTURE) {
    console.warn('[FrameCapture] Config calculated:', {
      frame_rate,
      frame_interval_ms,
      scroll_speed_px_per_sec,
      scroll_px_per_frame,
      total_frames,
    });
  }

  return {
    frame_rate,
    frame_interval_ms,
    scroll_speed_px_per_sec,
    scroll_px_per_frame,
    output_format,
    output_dir,
    filename_pattern,
    page_height_px,
    scroll_duration_sec,
    total_frames,
  };
}

/**
 * フレームファイル情報の生成
 *
 * 設定に基づいて各フレームのファイル情報を生成します。
 *
 * @param config - フレームキャプチャ設定
 * @returns フレームファイル情報の配列
 */
export function generateFrameFileInfos(config: FrameCaptureConfig): FrameFileInfo[] {
  const files: FrameFileInfo[] = [];
  const pattern = config.filename_pattern;
  const ext = config.output_format;

  for (let i = 0; i < config.total_frames; i++) {
    const frame_number = i;
    const scroll_position_px = Math.min(
      i * config.scroll_px_per_frame,
      config.page_height_px
    );
    const timestamp_ms = i * config.frame_interval_ms;

    // ファイル名パターンの置換: {0000} -> 0001, {000} -> 001
    let filename = pattern.replace(/\{(\d+)\}/g, (_, digits) => {
      const padLength = digits.length;
      return String(i).padStart(padLength, '0');
    });

    // 拡張子の置換
    filename = filename.replace(/\.(png|jpeg)$/, `.${ext}`);

    const file_path = `${config.output_dir}${filename}`;

    files.push({
      frame_number,
      scroll_position_px,
      timestamp_ms,
      file_path,
    });
  }

  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_FRAME_CAPTURE) {
    console.warn('[FrameCapture] Generated', files.length, 'frame file infos');
  }

  return files;
}

// ============================================================================
// MCP Tool Definitions
// ============================================================================

/**
 * MCP Tool definitions for motion.* tools
 * MCPプロトコル準拠のツール定義
 */
export const motionMcpTools = {
  'motion.detect': {
    name: 'motion.detect',
    description:
      'Webページからモーション/アニメーションパターンを検出・分類します。CSSアニメーション、トランジション、キーフレームを解析し、パフォーマンスやアクセシビリティの問題を警告します。',
    inputSchema: motionDetectInputSchema,
  },
  'motion.search': {
    name: 'motion.search',
    description:
      'モーションパターンを類似検索します。自然言語クエリまたはサンプルパターンを使用して、類似のアニメーション/トランジションパターンを検索できます。',
    // inputSchema is defined below after motionSearchInputSchema
  },
} as const;

export type MotionMcpToolName = keyof typeof motionMcpTools;

// ============================================================================
// motion.search Input Schema
// ============================================================================

/**
 * 検索用モーションタイプスキーマ
 * motion.searchで使用するシンプルなモーションタイプ
 */
export const motionSearchTypeSchema = z.enum([
  'animation',
  'transition',
  'transform',
  'scroll',
  'hover',
  'keyframe',
]);
export type MotionSearchType = z.infer<typeof motionSearchTypeSchema>;

/**
 * 検索用トリガースキーマ
 */
export const motionSearchTriggerSchema = z.enum([
  'load',
  'hover',
  'scroll',
  'click',
  'focus',
  'custom',
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
export const motionSearchFiltersSchema = z.object({
  type: motionSearchTypeSchema.optional(),
  minDuration: z.number().min(0).optional(),
  maxDuration: z.number().min(0).optional(),
  trigger: motionSearchTriggerSchema.optional(),
});
export type MotionSearchFilters = z.infer<typeof motionSearchFiltersSchema>;

/**
 * motion.search アクションタイプ
 * Phase3-3: motion.get_implementation を motion.search に統合
 */
export const motionSearchActionSchema = z.enum(['search', 'generate']);
export type MotionSearchAction = z.infer<typeof motionSearchActionSchema>;

// ============================================================================
// JSAnimation Search Schemas (v0.1.0)
// ============================================================================

/**
 * JSアニメーションライブラリタイプ
 * Prisma JSAnimationLibrary enumと同期
 */
export const jsAnimationLibraryTypeSchema = z.enum([
  'gsap',
  'framer_motion',
  'anime_js',
  'three_js',
  'lottie',
  'web_animations_api',
  'unknown',
]);
export type JSAnimationLibraryType = z.infer<typeof jsAnimationLibraryTypeSchema>;

/**
 * JSアニメーションタイプ
 * Prisma JSAnimationType enumと同期
 */
export const jsAnimationTypeSchema = z.enum([
  'tween',
  'timeline',
  'spring',
  'physics',
  'keyframe',
  'morphing',
  'path',
  'scroll_driven',
  'gesture',
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
  'fade',
  'pulse',
  'wave',
  'particle',
  'morph',
  'rotation',
  'parallax',
  'noise',
  'complex',
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
  characteristics: z.object({
    averageChangeRate: z.number().optional(),
    peakChangeRate: z.number().optional(),
    changePattern: z.enum(['continuous', 'pulsed', 'irregular']).optional(),
  }).optional(),
});
export type WebGLAnimationInfo = z.infer<typeof webglAnimationInfoSchema>;

// ============================================================================
// Implementation Generation Schemas (Phase3-3: moved before motionSearchInputSchema)
// ============================================================================

/**
 * 実装出力フォーマット
 */
export const implementationFormatSchema = z.enum([
  'css',
  'css-module',
  'tailwind',
  'styled-components',
  'emotion',
  'framer-motion',
  'gsap',
  'three-js',
  'lottie',
]);
export type ImplementationFormat = z.infer<typeof implementationFormatSchema>;

/**
 * モーションパターンタイプ（実装生成用）
 */
export const motionPatternTypeSchema = z.enum([
  'animation',
  'transition',
  'transform',
  'scroll',
  'hover',
  'keyframe',
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
  easing: z.string().default('ease'),
  iterations: z.union([z.number().min(1), z.literal('infinite')]).default(1),
  direction: z.enum(['normal', 'reverse', 'alternate', 'alternate-reverse']).default('normal'),
  fillMode: z.enum(['none', 'forwards', 'backwards', 'both']).default('none'),
  properties: z.array(implementationPropertySchema).min(1),
});
export type MotionPatternInput = z.infer<typeof motionPatternInputSchema>;

/**
 * 実装オプションスキーマ
 */
export const implementationOptionsSchema = z.object({
  selector: z.string().default('.animated'),
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
    .describe('Enable duplicate animation detection in project CSS files'),
  /** プロジェクトのCSSファイルパス（単一） */
  project_css_path: z
    .string()
    .optional()
    .describe('Path to project CSS file to scan for existing animations'),
  /** プロジェクトのCSSファイルパス（複数） */
  project_css_paths: z
    .array(z.string())
    .optional()
    .describe('Paths to multiple project CSS files to scan'),
  /** 類似度しきい値（0-1、デフォルト: 0.8） */
  similarity_threshold: z
    .number()
    .min(0, { message: 'similarity_thresholdは0以上である必要があります' })
    .max(1, { message: 'similarity_thresholdは1以下である必要があります' })
    .default(0.8)
    .describe('Similarity threshold for duplicate detection (0-1, default: 0.8)'),
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
    action: motionSearchActionSchema.default('search'),

    // 検索用パラメータ（action: 'search' 時に使用）
    query: z
      .string()
      .min(1, { message: '検索クエリは1文字以上必要です' })
      .max(500, { message: '検索クエリは500文字以下にしてください' })
      .optional(),
    samplePattern: samplePatternSchema.optional(),
    filters: motionSearchFiltersSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1, { message: 'limitは1以上である必要があります' })
      .max(50, { message: 'limitは50以下にしてください' })
      .default(10),
    minSimilarity: z
      .number()
      .min(0, { message: 'minSimilarityは0以上である必要があります' })
      .max(1, { message: 'minSimilarityは1以下である必要があります' })
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
      .min(0, { message: 'diversity_thresholdは0以上である必要があります' })
      .max(1, { message: 'diversity_thresholdは1以下である必要があります' })
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
  })
  .refine(
    (data) => {
      // action: 'search' の場合、query または samplePattern が必要
      if (data.action === 'search') {
        const hasQuery = data.query !== undefined && data.query.length > 0;
        const hasSamplePattern = data.samplePattern !== undefined;
        return hasQuery || hasSamplePattern;
      }
      // action: 'generate' の場合、pattern が必要
      if (data.action === 'generate') {
        return data.pattern !== undefined;
      }
      return true;
    },
    {
      message: 'action: search の場合は query または samplePattern、action: generate の場合は pattern が必要です',
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
export const motionSearchOutputSchema = z.discriminatedUnion('success', [
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
  SEARCH_ERROR: 'SEARCH_ERROR',
  /** Embeddingエラー */
  EMBEDDING_ERROR: 'EMBEDDING_ERROR',
  /** 結果なし（エラーではないが情報として） */
  NO_RESULTS: 'NO_RESULTS',
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
  format: implementationFormatSchema.default('css'),
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
export const motionGetImplementationOutputSchema = z.discriminatedUnion('success', [
  motionGetImplementationSuccessOutputSchema,
  motionGetImplementationErrorOutputSchema,
]);
export type MotionGetImplementationOutput = z.infer<typeof motionGetImplementationOutputSchema>;
