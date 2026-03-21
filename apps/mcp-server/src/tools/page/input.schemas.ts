// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze MCPツールの入力スキーマ定義
 * Input schemas + all option types
 *
 * @module @reftrix/mcp-server/tools/page/input.schemas
 */
import { z } from "zod";
import { sourceTypeSchema, usageScopeSchema, waitUntilSchema } from "./shared.schemas";

// ============================================================================
// Features Schema
// ============================================================================

/** 分析機能フラグ（デフォルト: 全機能有効） */
export const analysisFeaturesSchema = z
  .object({
    /** レイアウト解析（セクション検出含む） */
    layout: z.boolean().optional().default(true),
    /** モーション検出（アニメーション/トランジション） */
    motion: z.boolean().optional().default(true),
    /** 品質評価（3軸 + AIクリシェ検出） */
    quality: z.boolean().optional().default(true),
  })
  .optional()
  .default({ layout: true, motion: true, quality: true });
export type AnalysisFeatures = z.infer<typeof analysisFeaturesSchema>;

// ============================================================================
// Option Schemas
// ============================================================================

export const viewportSchema = z.object({
  width: z.number().int().min(320).max(4096).optional().default(1440),
  height: z.number().int().min(240).max(16384).optional().default(900),
});
export type Viewport = z.infer<typeof viewportSchema>;

export const layoutOptionsSchema = z
  .object({
    fullPage: z.boolean().optional().default(true),
    viewport: viewportSchema.optional(),
    // MCP-RESP-03: snake_case正式形式（新規オプション推奨形式）
    // デフォルト値はresult-builder.tsで適用（両形式対応のため）
    include_html: z.boolean().optional(),
    include_screenshot: z.boolean().optional(),
    // レガシー互換: camelCaseは後方互換として維持
    // デフォルト値はresult-builder.tsで適用（両形式対応のため）
    includeHtml: z.boolean().optional(),
    includeScreenshot: z.boolean().optional(),
    saveToDb: z.boolean().optional().default(true),
    autoAnalyze: z.boolean().optional().default(true),
    /**
     * 外部CSSファイルを取得して解析に含めるか
     * @default true
     */
    fetchExternalCss: z.boolean().optional().default(true),
    /**
     * Vision API（Ollama + llama3.2-vision）を使用してスクリーンショットを解析するか
     * true の場合、スクリーンショートを layout.inspect の screenshot モードに委譲し、
     * 画像から直接セクション構造・デザイン特徴を抽出する
     *
     * NOTE: Ollamaがローカルで起動していない場合は、graceful degradation によりHTML解析のみで続行する
     * 処理時間が5-10秒増加する点に注意
     *
     * @default true
     */
    useVision: z.boolean().optional().default(true),
    /**
     * Enable per-section Vision analysis for more accurate semantic search.
     * Each section gets individual visual feature extraction.
     * Requires useVision=true.
     *
     * @default true (maximum analysis capability)
     * @warning Increases processing time significantly
     */
    perSectionVision: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Enable per-section Vision analysis for more accurate semantic search. Each section gets individual visual feature extraction. Requires useVision=true. Default: true (maximum analysis capability). Warning: Increases processing time significantly."
      ),
    /**
     * Maximum concurrent Vision API calls when perSectionVision is enabled.
     * Higher values increase speed but may overwhelm Ollama.
     *
     * @default 5 (optimized for parallel processing)
     */
    visionBatchSize: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(5)
      .describe(
        "Maximum concurrent Vision API calls when perSectionVision is enabled. Higher values increase speed but may overwhelm Ollama. Default: 5"
      ),
    /**
     * Scroll-position Smart Capture + Vision analysis.
     * Captures viewport screenshots at section boundary scroll positions
     * and analyzes with Ollama Vision for scroll-triggered animation detection.
     * Only works in async mode (requires Playwright + Ollama).
     * @default true (when useVision=true)
     */
    scrollVision: z.boolean().optional().default(true),
    /**
     * Maximum number of scroll positions to capture.
     * @default 10
     * @min 2
     * @max 20
     */
    scrollVisionMaxCaptures: z.number().int().min(2).max(20).optional().default(10),
  })
  .optional();
export type LayoutOptions = z.infer<typeof layoutOptionsSchema>;

// ============================================================================
// Vision CPU完走保証オプション (Phase 3)
// ============================================================================

/**
 * Vision CPU完走保証オプションスキーマ
 *
 * Vision CPU完走保証 Phase 3: GPU/CPU検出に基づく動的タイムアウト・画像最適化オプション
 *
 * 用途:
 * - page.analyze / layout.inspect のVision解析で使用
 * - HardwareDetector, TimeoutCalculator, ImageOptimizer との統合
 * - Graceful Degradation（HTML解析フォールバック）のサポート
 *
 * タイムアウト値の目安:
 * - GPU: 60,000ms (1分)
 * - CPU Small (<100KB): 180,000ms (3分)
 * - CPU Medium (100KB-500KB): 600,000ms (10分)
 * - CPU Large (>=500KB): 1,200,000ms (20分)
 *
 * @see apps/mcp-server/src/services/vision/hardware-detector.ts
 * @see apps/mcp-server/src/services/vision/timeout-calculator.ts
 * @see apps/mcp-server/src/services/vision/image-optimizer.ts
 */
export const visionOptionsSchema = z
  .object({
    /**
     * Vision解析のタイムアウト（ミリ秒）
     * 未指定時はHardwareDetector + TimeoutCalculatorで自動計算
     *
     * @min 1000 (1秒)
     * @max 1200000 (20分)
     */
    visionTimeoutMs: z
      .number()
      .min(1000, { message: "visionTimeoutMsは1000ms以上である必要があります（最小1秒）" })
      .max(1200000, { message: "visionTimeoutMsは1200000ms以下にしてください（最大20分）" })
      .optional()
      .describe(
        "Vision解析のタイムアウト（ms）。未指定時はハードウェア検出で自動計算。GPU:60秒、CPU:3-20分"
      ),

    /**
     * Vision解析に渡す画像の最大サイズ（バイト）
     * これを超える画像はImageOptimizerで圧縮される
     *
     * @min 1024 (1KB)
     * @max 10000000 (10MB)
     */
    visionImageMaxSize: z
      .number()
      .min(1024, { message: "visionImageMaxSizeは1024bytes以上である必要があります（最小1KB）" })
      .max(10000000, { message: "visionImageMaxSizeは10000000bytes以下にしてください（最大10MB）" })
      .optional()
      .describe(
        "Vision解析に渡す画像の最大サイズ（bytes）。これを超える画像は自動圧縮される。デフォルト: 自動"
      ),

    /**
     * GPUが利用可能でもCPUモードを強制するか
     * テストやCI環境で有用
     *
     * @default false
     */
    visionForceCpu: z
      .boolean()
      .optional()
      .default(false)
      .describe("GPUが利用可能でもCPUモードを強制。テスト/CI環境で有用。デフォルト: false"),

    /**
     * 長時間処理時に進捗報告を有効にするか
     * 将来的なストリーミング対応用
     *
     * @default false
     */
    visionEnableProgress: z
      .boolean()
      .optional()
      .default(false)
      .describe("長時間処理時に進捗報告を有効化。デフォルト: false"),

    /**
     * Vision解析がタイムアウト/失敗した場合にHTML解析のみで続行するか
     * Graceful Degradation設定
     *
     * @default true (フォールバック有効)
     */
    visionFallbackToHtmlOnly: z
      .boolean()
      .optional()
      .default(true)
      .describe("Vision解析失敗時にHTML解析のみで続行（Graceful Degradation）。デフォルト: true"),
  })
  .optional();
export type VisionOptions = z.infer<typeof visionOptionsSchema>;

// ============================================================================
// Motion Options - Frame Capture Schemas (Video Mode)
// ============================================================================

/** 最大合計フレーム数制限 (motion.detect と同じ) */
export const PAGE_ANALYZE_MAX_TOTAL_FRAMES = 3600;

// ============================================================================
// Timeout Constants for page.analyze (v0.1.0)
// ============================================================================

/**
 * page.analyze 各フェーズのタイムアウト定数
 *
 * 問題背景: 600秒タイムアウトが発生する原因
 * - HTMLフェッチのみにタイムアウトが適用され、並列分析フェーズには伝播しない
 * - フレームキャプチャに上限がなく、大きなページで数千フレームをキャプチャ
 * - networkidleは遅いサイトで非常に時間がかかる
 *
 * 改善策:
 * - 各フェーズに個別タイムアウトを設定
 * - フレームキャプチャに最大フレーム数制限を追加
 * - タイムアウト時は部分結果を返却（Graceful Degradation）
 */
export const PAGE_ANALYZE_TIMEOUTS = {
  /** HTML取得フェーズのタイムアウト（ms） - デフォルト60秒 */
  FETCH_HTML: 60000,

  /** レイアウト分析フェーズのタイムアウト（ms） - 30秒 */
  LAYOUT_ANALYSIS: 30000,

  /** モーション検出フェーズのタイムアウト（ms） - フレームキャプチャ含む場合120秒 */
  MOTION_DETECTION: 120000,

  /** 品質評価フェーズのタイムアウト（ms） - 15秒 */
  QUALITY_EVALUATION: 15000,

  /** フレームキャプチャのタイムアウト（ms） - 90秒 */
  FRAME_CAPTURE: 90000,

  /**
   * JSアニメーション検出のタイムアウト（ms）
   * WebGL/Three.jsサイトではPlaywright起動 + ページ読み込み + CDP検出に時間がかかるため、
   * 120秒（2分）を確保。軽量サイトでは早期に完了する。
   * @default 120000 (2分)
   */
  JS_ANIMATION_DETECTION: 120000,

  /** DB保存のタイムアウト（ms） - 30秒 */
  DB_SAVE: 30000,

  /** Vision解析のタイムアウト（ms） - 30秒 */
  VISION_ANALYSIS: 30000,
} as const;

/** フレームキャプチャの最大フレーム数 */
export const PAGE_ANALYZE_FRAME_CAPTURE_MAX_FRAMES = 1000;

/**
 * フレームキャプチャオプションスキーマ (page.analyze 用)
 *
 * motion.detect の frameCaptureOptionsSchema と同等の構造。
 * セキュリティ対策:
 * - output_dir: パストラバーサル文字(..)を禁止
 * - filename_pattern: パス区切り文字(/、..)を禁止
 */
export const pageAnalyzeFrameCaptureOptionsSchema = z
  .object({
    frame_rate: z
      .number()
      .int()
      .min(1, { message: "frame_rateは1以上である必要があります" })
      .max(120, { message: "frame_rateは120以下にしてください" })
      .optional()
      .default(30),
    frame_interval_ms: z
      .number()
      .min(1, { message: "frame_interval_msは1以上である必要があります" })
      .optional()
      .default(33),
    scroll_speed_px_per_sec: z
      .number()
      .min(1, { message: "scroll_speed_px_per_secは1以上である必要があります" })
      .optional(),
    scroll_px_per_frame: z
      .number()
      .min(0.01, { message: "scroll_px_per_frameは0.01以上である必要があります" })
      .optional()
      .default(15),
    output_format: z.enum(["png", "jpeg"]).optional().default("png"),
    output_dir: z
      .string()
      .min(1, { message: "output_dirは1文字以上必要です" })
      .refine((dir) => !dir.includes(".."), {
        message: "output_dirにパストラバーサル文字(..)は使用できません",
      })
      .optional()
      .default("/tmp/reftrix-frames/"),
    filename_pattern: z
      .string()
      .min(1, { message: "filename_patternは1文字以上必要です" })
      .refine((pattern) => !pattern.includes("..") && !pattern.includes("/"), {
        message: "filename_patternにパス区切り文字(/または..)は使用できません",
      })
      .optional()
      .default("frame-{0000}.png"),
    page_height_px: z
      .number()
      .int()
      .min(100, { message: "page_height_pxは100以上である必要があります" })
      .max(100000, { message: "page_height_pxは100000以下にしてください" })
      .optional(),
    scroll_duration_sec: z
      .number()
      .min(0.1, { message: "scroll_duration_secは0.1以上である必要があります" })
      .max(300, { message: "scroll_duration_secは300以下にしてください" })
      .optional(),
  })
  .refine(
    (data) => {
      // 合計フレーム数制限チェック
      const frameRate = data.frame_rate ?? 30;
      const scrollDuration = data.scroll_duration_sec ?? 5;
      const totalFrames = Math.ceil(frameRate * scrollDuration);
      return totalFrames <= PAGE_ANALYZE_MAX_TOTAL_FRAMES;
    },
    {
      message: `合計フレーム数は${PAGE_ANALYZE_MAX_TOTAL_FRAMES}以下である必要があります（frame_rate × scroll_duration_sec）`,
    }
  );
export type PageAnalyzeFrameCaptureOptions = z.infer<typeof pageAnalyzeFrameCaptureOptionsSchema>;

/**
 * フレーム画像分析オプションスキーマ (page.analyze 用)
 *
 * motion.detect の frameImageAnalysisInputOptionsSchema と同等の構造。
 * CLS検出、差分解析などフレーム画像分析のオプション。
 */
export const pageAnalyzeFrameAnalysisOptionsSchema = z.object({
  /** フレーム画像ディレクトリ（省略時はframe_capture_options.output_dir使用） */
  frame_dir: z
    .string()
    .min(1, { message: "frame_dirは1文字以上必要です" })
    .refine((dir) => !dir.includes(".."), {
      message: "frame_dirにパストラバーサル文字(..)は使用できません",
    })
    .optional(),
  /** サンプリング間隔（N番目のフレームごと、デフォルト: 1 = 全フレーム） */
  sample_interval: z.number().int().min(1).max(100).optional().default(1),
  /** ピクセル差分しきい値（0-1、デフォルト: 0.01 = 1%） */
  diff_threshold: z.number().min(0).max(1).optional().default(0.01),
  /** CLS（レイアウトシフト）しきい値（デフォルト: 0.1、WCAG推奨値） */
  cls_threshold: z.number().min(0).max(1).optional().default(0.1),
  /** モーション検出しきい値（ピクセル、デフォルト: 5） */
  motion_threshold: z.number().int().min(1).max(500).optional().default(5),
  /** 差分可視化画像を出力するか（デフォルト: false） */
  output_diff_images: z.boolean().optional().default(false),
  /** 並列処理を有効にするか（デフォルト: true） */
  parallel: z.boolean().optional().default(true),
});
export type PageAnalyzeFrameAnalysisOptions = z.infer<typeof pageAnalyzeFrameAnalysisOptionsSchema>;

// ============================================================================
// Motion Options Schema (Extended with Video Mode)
// ============================================================================

/**
 * WebGLアニメーション検出オプションスキーマ (page.analyze 用)
 *
 * Canvas/WebGLベースのアニメーション（Three.js等）をフレームベースで検出するオプション
 * @see WebGLAnimationDetectorService
 */
export const webglAnimationOptionsSchema = z.object({
  /**
   * サンプリングするフレーム数
   * @default 50 (maximum analysis capability)
   * @min 5
   * @max 100
   */
  sample_frames: z.number().int().min(5).max(100).optional().default(50),
  /**
   * フレーム間隔（ms）
   * @default 100
   * @min 50
   * @max 500
   */
  sample_interval_ms: z.number().int().min(50).max(500).optional().default(100),
  /**
   * 変化検出しきい値（0-1）
   * @default 0.005 (high sensitivity for maximum detection)
   * @min 0.001
   * @max 0.5
   */
  change_threshold: z.number().min(0.001).max(0.5).optional().default(0.005),
  /**
   * 検出タイムアウト（ms）
   * v0.1.0: デフォルトを120秒に増加（重いWebGLサイト対応）
   * @default 120000
   * @min 5000
   * @max 180000
   */
  timeout_ms: z.number().int().min(5000).max(180000).optional().default(120000),
});
export type WebGLAnimationOptions = z.infer<typeof webglAnimationOptionsSchema>;

/**
 * JSアニメーション検出オプションスキーマ (page.analyze 用)
 *
 * Chrome DevTools Protocol + Web Animations API + ライブラリシグネチャ検出のオプション
 * @see motion.detect の js_animation_options と同等の構造
 */
export const jsAnimationOptionsSchema = z.object({
  /**
   * CDPアニメーション検出を有効にするか
   * @default true
   */
  enableCDP: z.boolean().optional().default(true),
  /**
   * Web Animations API検出を有効にするか
   * @default true
   */
  enableWebAnimations: z.boolean().optional().default(true),
  /**
   * ライブラリ検出を有効にするか (GSAP, Framer Motion, anime.js, Three.js, Lottie)
   * @default true
   */
  enableLibraryDetection: z.boolean().optional().default(true),
  /**
   * アニメーション待機時間（ms）- ページ読み込み後、アニメーション開始を待つ時間
   * @default 2000
   */
  waitTime: z.number().int().min(0).max(10000).optional().default(2000),
});
export type JSAnimationOptions = z.infer<typeof jsAnimationOptionsSchema>;

/**
 * モーション検出モード
 * - css: CSS静的解析のみ（最速、デフォルト）
 * - video: 動画録画+フレーム解析（motion.detectと同等）
 * - runtime: Playwrightでページ読み込み後のランタイムアニメーション検出
 * - hybrid: CSS静的解析 + ランタイム検出の組み合わせ
 */
export const motionDetectionModeSchema = z.enum(["css", "video", "runtime", "hybrid"]);
export type MotionDetectionMode = z.infer<typeof motionDetectionModeSchema>;

export const motionOptionsSchema = z
  .object({
    // === 検出モード（v0.1.0追加, v0.1.0でデフォルト変更, v0.1.0でデフォルトをcssに戻す） ===
    /**
     * モーション検出モード
     * - css: CSS静的解析のみ（最速、デフォルト）
     * - video: 動画録画+フレーム解析（motion.detectのvideo modeと同等）
     * - runtime: Playwrightでランタイムアニメーション検出
     * - hybrid: CSS + ランタイム検出の組み合わせ（WebGLサイト対応）
     * @default 'css' (v0.1.0: タイムアウト問題回避のためCSSのみに戻す)
     */
    detection_mode: motionDetectionModeSchema.optional().default("css"),

    // === CSS静的解析オプション（既存） ===
    /** 外部CSSファイルを取得して解析に含めるか（v0.1.0でデフォルトtrue化） */
    fetchExternalCss: z.boolean().optional().default(true),
    minDuration: z.number().int().min(0).optional().default(0),
    maxPatterns: z.number().int().min(1).max(4000).optional().default(500),
    includeWarnings: z.boolean().optional().default(true),
    saveToDb: z.boolean().optional().default(true),

    // === Video Mode オプション ===
    /**
     * フレームキャプチャを有効にするか
     * @default false (v0.1.0: タイムアウト問題回避のためデフォルト無効化)
     * 有効化する場合は明示的に true を指定
     */
    enable_frame_capture: z.boolean().optional().default(false),
    /** フレームキャプチャオプション（enable_frame_capture=true時のみ有効） */
    frame_capture_options: pageAnalyzeFrameCaptureOptionsSchema.optional(),

    /**
     * フレーム画像分析を有効にするか
     * @default false (v0.1.0: タイムアウト問題回避のためデフォルト無効化)
     */
    analyze_frames: z.boolean().optional().default(false),
    /** フレーム画像分析オプション（analyze_frames=true時のみ有効） */
    frame_analysis_options: pageAnalyzeFrameAnalysisOptionsSchema.optional(),

    // === Video Mode 詳細オプション (v0.1.0追加) ===
    /**
     * 動画録画・フレーム解析オプション
     * detection_mode='video'の場合のみ有効
     */
    video_options: z
      .object({
        /** ページ読み込みタイムアウト (1000-120000ms) @default 30000 */
        timeout: z.number().int().min(1000).max(120000).optional().default(30000),
        /** 録画時間 (1000-60000ms) @default 10000 */
        record_duration: z.number().int().min(1000).max(60000).optional().default(10000),
        /** ビューポートサイズ */
        viewport: z
          .object({
            width: z.number().int().min(320).max(4096),
            height: z.number().int().min(240).max(4096),
          })
          .optional(),
        /** スクロール操作を行うか @default true */
        scroll_page: z.boolean().optional().default(true),
        /** マウス移動操作を行うか @default true */
        move_mouse: z.boolean().optional().default(true),
        /** ページロード完了待機戦略 @default 'domcontentloaded' */
        wait_until: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .default("domcontentloaded"),
        /** フレーム解析オプション */
        frame_analysis: z
          .object({
            /** フレームレート (1-30fps) @default 15 */
            fps: z.number().int().min(1).max(30).optional().default(15),
            /** 変化検出閾値 (0-1) @default 0.005 */
            change_threshold: z.number().min(0).max(1).optional().default(0.005),
            /** 最小モーション継続時間 (ms) @default 50 */
            min_motion_duration_ms: z.number().int().min(0).max(10000).optional().default(50),
            /** ギャップ許容時間 (ms) @default 50 */
            gap_tolerance_ms: z.number().int().min(0).max(1000).optional().default(50),
          })
          .optional(),
      })
      .optional(),

    // === Runtime Mode オプション (v0.1.0追加) ===
    /**
     * ランタイム検出オプション
     * detection_mode='runtime'または'hybrid'の場合のみ有効
     */
    runtime_options: z
      .object({
        /** アニメーション待機時間 (0-30000ms) @default 5000 */
        wait_for_animations: z.number().min(0).max(30000).optional().default(5000),
        /** スクロール位置の配列 (0-100%) 最大20個 */
        scroll_positions: z.array(z.number().min(0).max(100)).max(20).optional(),
      })
      .optional(),

    // === JS Animation 検出オプション (v0.1.0, v0.1.0でデフォルト変更, v0.1.0でfalse, v0.1.0でtrue復帰) ===
    /**
     * JavaScript駆動アニメーション検出を有効にするか
     * CDP Animation API + Web Animations API + ライブラリ検出 を統合
     * Playwrightが必要で処理に30秒以上かかる場合あり
     * @default true (v0.1.0: データ蓄積のため再有効化、asyncモードで長時間検出可能)
     */
    detect_js_animations: z.boolean().optional().default(true),
    /**
     * JSアニメーション検出の詳細オプション
     * detect_js_animations=true時のみ有効
     */
    js_animation_options: jsAnimationOptionsSchema.optional(),

    // === WebGL Animation 検出オプション (v0.1.0, v0.1.0でfalse, v0.1.0でtrue復帰) ===
    /**
     * WebGL/Canvasベースのアニメーション検出を有効にするか
     * Three.js等のWebGLアニメーションをフレームベースで検出
     * Playwrightが必要で処理に30秒以上かかる場合あり
     * @default true (v0.1.0: データ蓄積のため再有効化、asyncモードで長時間検出可能)
     */
    detect_webgl_animations: z.boolean().optional().default(true),
    /**
     * WebGLアニメーション検出の詳細オプション
     * detect_webgl_animations=true時のみ有効
     */
    webgl_animation_options: webglAnimationOptionsSchema.optional(),

    // === Async Worker用タイムアウト (v0.1.0) ===
    /**
     * Motion検出のタイムアウト（ミリ秒）
     *
     * MCP Protocol (Claude Desktop/API) には60秒のツール呼び出し制限があります。
     * page.analyzeのasyncモードでは、この制限が適用されないため、
     * 長時間のmotion検出が可能です。
     *
     * 同期モード（async=false）では、このパラメータはツール内部処理用であり、
     * MCP層の60秒制限を上書きすることはできません。
     *
     * @default 300000 (5分)
     * @min 30000 (30秒)
     * @max 600000 (10分)
     */
    timeout: z.number().int().min(30000).max(600000).optional().default(300000),
  })
  .optional()
  .default({});
export type MotionOptions = z.infer<typeof motionOptionsSchema>;

export const qualityOptionsSchema = z
  .object({
    weights: z
      .object({
        originality: z.number().min(0).max(1).optional().default(0.35),
        craftsmanship: z.number().min(0).max(1).optional().default(0.4),
        contextuality: z.number().min(0).max(1).optional().default(0.25),
      })
      .optional(),
    targetIndustry: z.string().max(100).optional(),
    targetAudience: z.string().max(100).optional(),
    strict: z.boolean().optional().default(true),
    includeRecommendations: z.boolean().optional().default(true),
  })
  .optional();
export type QualityOptions = z.infer<typeof qualityOptionsSchema>;

// ============================================================================
// Narrative Options Schema
// ============================================================================

/**
 * Narrative分析オプションスキーマ
 *
 * page.analyzeでWebページの「世界観・雰囲気（WorldView）」と
 * 「レイアウト構成（LayoutStructure）」を分析するオプション。
 *
 * 機能:
 * - WorldViewAnalyzer: 色彩印象、タイポグラフィ性格、モーション感情、全体トーン
 * - LayoutStructureAnalyzer: グリッドシステム、視覚的階層、スペーシングリズム
 * - Embedding生成（multilingual-e5-base、768次元）
 * - DB保存（DesignNarrative, DesignNarrativeEmbedding）
 *
 * @see NarrativeAnalysisService
 */
export const narrativeOptionsSchema = z
  .object({
    /**
     * Narrative分析を有効化するか
     * @default true
     */
    enabled: z.boolean().optional().default(true).describe("Narrative分析を有効化"),

    /**
     * 分析結果をDBに保存するか
     * @default true
     */
    saveToDb: z.boolean().optional().default(true).describe("分析結果をDBに保存"),

    /**
     * Vision LLM（Ollama llama3.2-vision）を使用するか
     * trueの場合、スクリーンショットを使用してより精度の高い分析を行う
     * @default true
     */
    includeVision: z.boolean().optional().default(true).describe("Vision LLM使用"),

    /**
     * Vision解析タイムアウト（ミリ秒）
     * @default 300000 (5分)
     * @min 30000 (30秒)
     * @max 600000 (10分)
     */
    visionTimeoutMs: z
      .number()
      .int()
      .min(30000, { message: "visionTimeoutMsは30000ms以上である必要があります（最小30秒）" })
      .max(600000, { message: "visionTimeoutMsは600000ms以下にしてください（最大10分）" })
      .optional()
      .default(300000)
      .describe("Vision解析タイムアウト（ms）"),

    /**
     * Embedding生成を含むか
     * @default true
     */
    generateEmbedding: z.boolean().optional().default(true).describe("Embedding生成を含む"),
  })
  .optional()
  .default({
    enabled: true,
    saveToDb: true,
    includeVision: true,
    visionTimeoutMs: 300000,
    generateEmbedding: true,
  });
export type NarrativeOptions = z.infer<typeof narrativeOptionsSchema>;

// ============================================================================
// Timeout Strategy Schema
// ============================================================================

/**
 * タイムアウト戦略
 * - strict: タイムアウト発生時は完全に失敗（部分結果なし）
 * - progressive: タイムアウト発生時も部分結果を返却（デフォルト）
 */
export const timeoutStrategySchema = z.enum(["strict", "progressive"]);
export type TimeoutStrategy = z.infer<typeof timeoutStrategySchema>;

// ============================================================================
// Input Schema
// ============================================================================

/** page.analyze 入力スキーマ */
export const pageAnalyzeInputSchema = z.object({
  url: z
    .string()
    .url({ message: "有効なURL形式を指定してください" })
    .refine(
      (url) => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "http:// または https:// プロトコルのみ許可されています" }
    ),

  sourceType: sourceTypeSchema.optional().default("user_provided"),
  usageScope: usageScopeSchema.optional().default("inspiration_only"),
  features: analysisFeaturesSchema,
  layoutOptions: layoutOptionsSchema,
  motionOptions: motionOptionsSchema,
  qualityOptions: qualityOptionsSchema,

  /**
   * Narrative分析オプション
   *
   * Webページの「世界観・雰囲気（WorldView）」と「レイアウト構成（LayoutStructure）」を分析するオプション。
   * enabled=trueで有効化。Vision LLMを使用してより精度の高い分析が可能。
   *
   * @see narrativeOptionsSchema
   */
  narrativeOptions: narrativeOptionsSchema,

  /**
   * Vision CPU完走保証オプション（Phase 3）
   *
   * Visionモデル（Ollama llama3.2-vision）の推論を確実に完了させるためのオプション。
   * GPU/CPU自動判定、動的タイムアウト、画像最適化、Graceful Degradation をサポート。
   *
   * @see visionOptionsSchema
   */
  visionOptions: visionOptionsSchema,

  summary: z.boolean().optional().default(false),

  /**
   * 非同期モード（Phase3-2 + v0.1.0 Smart Defaults）
   *
   * true: ジョブをBullMQキューに投入し、ジョブIDを返す
   * false: 同期処理（従来動作）
   * undefined: 自動判定（Vision有効時はtrue、それ以外はfalse）
   *
   * **v0.1.0 Smart Defaults**:
   * Vision分析（useVision=true または narrativeOptions.includeVision=true）が有効で、
   * asyncが明示的に指定されていない場合、Redisが利用可能であれば自動的にasync=trueに設定。
   * Vision LLM (llama3.2-vision) はCPUモードで2-5分以上かかるため、
   * MCPの600秒ハードタイムアウトを回避するために自動非同期化される。
   *
   * WebGL重いサイト（Linear, Vercel, Notion等）は非同期モードを推奨。
   * ジョブ結果は24時間保持され、page.getJobStatusで取得可能。
   *
   * 注意: async=true にはRedisが必要。Redis未起動時はエラーを返す。
   *
   * @default undefined (Vision有効時は自動でtrue)
   */
  async: z.boolean().optional(),
  /**
   * タイムアウト（ミリ秒）
   * WebGL/Three.jsサイトは初期レンダリングに60-90秒かかることがあるため、
   * デフォルトを600秒（10分）に設定。最大限の分析能力を発揮するための設定。
   * @default 600000 (10分)
   * @max 600000 (10分)
   */
  timeout: z.number().int().min(5000).max(600000).optional().default(600000),
  waitUntil: waitUntilSchema.optional().default("networkidle"),

  /**
   * タイムアウト戦略
   * - strict: タイムアウト発生時は完全に失敗
   * - progressive: タイムアウト発生時も部分結果を返却（デフォルト）
   * @default 'progressive'
   */
  timeout_strategy: timeoutStrategySchema.optional().default("progressive"),

  /**
   * 部分結果を許可するか
   * true: タイムアウト発生時も完了したフェーズの結果を返却
   * false: 全フェーズ完了時のみ結果を返却
   * @default true
   */
  partial_results: z.boolean().optional().default(true),

  // =========================================================================
  // Per-Phase Timeout Settings (v0.1.0)
  // =========================================================================
  /**
   * レイアウトフェーズの個別タイムアウト（ミリ秒）
   *
   * レイアウト分析（HTML解析、セクション検出、Vision分析）に適用。
   * 重いサイトでもモーション/品質評価を継続するため、個別設定可能。
   *
   * @default 120000 (2分)
   * @min 5000 (5秒)
   * @max 300000 (5分)
   */
  layoutTimeout: z.number().int().min(5000).max(300000).optional().default(120000),

  /**
   * モーションフェーズの個別タイムアウト（ミリ秒）
   *
   * モーション検出（CSS静的解析、JSアニメーション検出、フレームキャプチャ）に適用。
   * WebGL/Three.jsサイトはフレームキャプチャに時間がかかるため、長めに設定推奨。
   *
   * @default 300000 (5分)
   * @min 5000 (5秒)
   * @max 300000 (5分)
   */
  motionTimeout: z.number().int().min(5000).max(300000).optional().default(300000),

  /**
   * 品質評価フェーズの個別タイムアウト（ミリ秒）
   *
   * 品質評価（アクセシビリティ、パフォーマンス、ベストプラクティス）に適用。
   * 通常は15秒で十分だが、大規模サイトでは延長可能。
   *
   * @default 60000 (1分)
   * @min 5000 (5秒)
   * @max 60000 (1分)
   */
  qualityTimeout: z.number().int().min(5000).max(60000).optional().default(60000),

  /**
   * 自動リトライを有効化するか（v0.1.0）
   *
   * true: HTML取得失敗時に段階的にリトライ
   * - 1回目: 元のタイムアウト、waitUntil='load'
   * - 2回目: タイムアウト1.5倍、waitUntil='domcontentloaded'
   * - 3回目: タイムアウト2倍、waitUntil='domcontentloaded'
   *
   * 注: WebGLは無効化しません（ユーザー要件）
   * @default true
   */
  auto_retry: z.boolean().optional().default(true),

  /**
   * 最大リトライ回数（v0.1.0）
   * auto_retry=true の場合に使用
   * @default 3
   * @min 1
   * @max 3
   */
  max_retries: z.number().int().min(1).max(3).optional().default(3),

  /**
   * レイアウト優先モード（v0.1.0）
   *
   * WebGL/Three.jsサイトでレイアウト抽出を最優先し、モーション検出を軽量化。
   * 'auto': WebGL検出時に自動でレイアウト優先（デフォルト）
   * 'always': 常にレイアウト優先
   * 'never': 従来の並列処理
   *
   * レイアウト優先モードでは:
   * - SectionPattern抽出を最優先で実行
   * - モーション検出はlibrary_onlyモード（グローバルオブジェクト検出のみ）
   * - タイムアウト予算をレイアウトに再配分
   *
   * @default 'auto'
   */
  layout_first: z.enum(["auto", "always", "never"]).optional().default("auto"),

  /**
   * Pre-flight Probe による自動タイムアウト調整（v0.1.0）
   *
   * URLのページ複雑度を事前に分析し、最適なタイムアウト値を動的に計算します。
   * WebGL、SPA、重いフレームワーク（Three.js等）を検出し、タイムアウトを自動調整。
   *
   * - true: probe実行 → calculatedTimeoutMsを使用
   * - false: 従来のtimeoutパラメータを使用
   *
   * probe結果はレスポンスの`preflightProbe`フィールドに含まれます。
   * saveToDb=trueの場合、WebPage.complexity_metricsにも保存されます。
   *
   * @default true
   */
  auto_timeout: z.boolean().optional().default(true),

  /** robots.txtを尊重するかどうか（RFC 9309）。falseで無視 */
  respect_robots_txt: z.boolean().optional(),

  /**
   * レスポンシブ分析オプション
   *
   * 複数ビューポート（desktop/tablet/mobile）でページをキャプチャし、
   * レイアウト差分・ブレークポイント・ナビゲーション変化を検出する。
   * enabled=trueで有効化。結果はresponsive_analysesテーブルに保存される。
   */
  responsiveOptions: z
    .object({
      /** レスポンシブ分析を有効化（デフォルト: true） */
      enabled: z.boolean().optional().default(true),
      /** カスタムビューポート設定（デフォルト: desktop/tablet/mobile） */
      viewports: z
        .array(
          z.object({
            name: z.string().min(1).max(50),
            width: z.number().int().min(320).max(4096),
            height: z.number().int().min(240).max(16384),
          })
        )
        .min(1)
        .max(10)
        .optional(),
      /** スクリーンショットをレスポンスに含めるか（デフォルト: false、DB-first） */
      include_screenshots: z.boolean().optional().default(false),
      /** ビューポート差分画像を含めるか（デフォルト: false） */
      include_diff_images: z.boolean().optional().default(false),
      /** ビューポート差分の閾値（0-1、デフォルト: 0.1） */
      diff_threshold: z.number().min(0).max(1).optional().default(0.1),
      /** DB保存するか（デフォルト: true） */
      save_to_db: z.boolean().optional().default(true),
      /** ナビゲーションパターン変化を検出するか（デフォルト: true） */
      detect_navigation: z.boolean().optional().default(true),
      /** 要素の表示/非表示変化を検出するか（デフォルト: true） */
      detect_visibility: z.boolean().optional().default(true),
      /** レイアウト構造変化を検出するか（デフォルト: true） */
      detect_layout: z.boolean().optional().default(true),
      /** ブレークポイント解像度（'range': CSSメディアクエリ+VP差分推定, 'precise': 二分探索で±8px精度）。preciseは処理時間3-5倍 */
      breakpoint_resolution: z.enum(["range", "precise"]).optional().default("range"),
    })
    .optional()
    .default({ enabled: true }),
});

export type PageAnalyzeInput = z.infer<typeof pageAnalyzeInputSchema>;
