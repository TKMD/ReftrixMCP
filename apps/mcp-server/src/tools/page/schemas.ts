// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze MCPツールのZodスキーマ定義
 * layout/motion/qualityの3分析を統合したURLベースのWeb分析ツール
 *
 * @module @reftrix/mcp-server/tools/page/schemas
 */
import { z } from 'zod';

// ============================================================================
// Error Codes
// ============================================================================

/** page.analyze エラーコード */
export const PAGE_ANALYZE_ERROR_CODES = {
  // バリデーションエラー
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // SSRF対策
  SSRF_BLOCKED: 'SSRF_BLOCKED',

  // robots.txt (RFC 9309) ブロック
  ROBOTS_TXT_BLOCKED: 'ROBOTS_TXT_BLOCKED',

  // ネットワーク/ページ取得
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',

  // ブラウザ関連
  BROWSER_ERROR: 'BROWSER_ERROR',
  BROWSER_UNAVAILABLE: 'BROWSER_UNAVAILABLE',

  // 分析関連
  LAYOUT_ANALYSIS_FAILED: 'LAYOUT_ANALYSIS_FAILED',
  MOTION_DETECTION_FAILED: 'MOTION_DETECTION_FAILED',
  QUALITY_EVALUATION_FAILED: 'QUALITY_EVALUATION_FAILED',

  // DB関連
  DB_SAVE_FAILED: 'DB_SAVE_FAILED',
  DB_NOT_CONFIGURED: 'DB_NOT_CONFIGURED',

  // 内部エラー
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type PageAnalyzeErrorCode =
  (typeof PAGE_ANALYZE_ERROR_CODES)[keyof typeof PAGE_ANALYZE_ERROR_CODES];

// ============================================================================
// Enum Schemas
// ============================================================================

export const sourceTypeSchema = z.enum(['award_gallery', 'user_provided']);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const usageScopeSchema = z.enum(['inspiration_only', 'owned_asset']);
export type UsageScope = z.infer<typeof usageScopeSchema>;

export const waitUntilSchema = z.enum(['load', 'domcontentloaded', 'networkidle']);
export type WaitUntil = z.infer<typeof waitUntilSchema>;

export const gradeSchema = z.enum(['A', 'B', 'C', 'D', 'F']);
export type Grade = z.infer<typeof gradeSchema>;

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
        'Enable per-section Vision analysis for more accurate semantic search. Each section gets individual visual feature extraction. Requires useVision=true. Default: true (maximum analysis capability). Warning: Increases processing time significantly.'
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
        'Maximum concurrent Vision API calls when perSectionVision is enabled. Higher values increase speed but may overwhelm Ollama. Default: 5'
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
    scrollVisionMaxCaptures: z
      .number()
      .int()
      .min(2)
      .max(20)
      .optional()
      .default(10),
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
      .min(1000, { message: 'visionTimeoutMsは1000ms以上である必要があります（最小1秒）' })
      .max(1200000, { message: 'visionTimeoutMsは1200000ms以下にしてください（最大20分）' })
      .optional()
      .describe(
        'Vision解析のタイムアウト（ms）。未指定時はハードウェア検出で自動計算。GPU:60秒、CPU:3-20分'
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
      .min(1024, { message: 'visionImageMaxSizeは1024bytes以上である必要があります（最小1KB）' })
      .max(10000000, { message: 'visionImageMaxSizeは10000000bytes以下にしてください（最大10MB）' })
      .optional()
      .describe(
        'Vision解析に渡す画像の最大サイズ（bytes）。これを超える画像は自動圧縮される。デフォルト: 自動'
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
      .describe('GPUが利用可能でもCPUモードを強制。テスト/CI環境で有用。デフォルト: false'),

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
      .describe('長時間処理時に進捗報告を有効化。デフォルト: false'),

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
      .describe(
        'Vision解析失敗時にHTML解析のみで続行（Graceful Degradation）。デフォルト: true'
      ),
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

/** 最大ページ高さ制限（px）- フレームキャプチャ用 */
export const PAGE_ANALYZE_MAX_PAGE_HEIGHT = 50000;

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
      .min(1, { message: 'frame_rateは1以上である必要があります' })
      .max(120, { message: 'frame_rateは120以下にしてください' })
      .optional()
      .default(30),
    frame_interval_ms: z
      .number()
      .min(1, { message: 'frame_interval_msは1以上である必要があります' })
      .optional()
      .default(33),
    scroll_speed_px_per_sec: z
      .number()
      .min(1, { message: 'scroll_speed_px_per_secは1以上である必要があります' })
      .optional(),
    scroll_px_per_frame: z
      .number()
      .min(0.01, { message: 'scroll_px_per_frameは0.01以上である必要があります' })
      .optional()
      .default(15),
    output_format: z.enum(['png', 'jpeg']).optional().default('png'),
    output_dir: z
      .string()
      .min(1, { message: 'output_dirは1文字以上必要です' })
      .refine(
        (dir) => !dir.includes('..'),
        { message: 'output_dirにパストラバーサル文字(..)は使用できません' }
      )
      .optional()
      .default('/tmp/reftrix-frames/'),
    filename_pattern: z
      .string()
      .min(1, { message: 'filename_patternは1文字以上必要です' })
      .refine(
        (pattern) => !pattern.includes('..') && !pattern.includes('/'),
        { message: 'filename_patternにパス区切り文字(/または..)は使用できません' }
      )
      .optional()
      .default('frame-{0000}.png'),
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
    .min(1, { message: 'frame_dirは1文字以上必要です' })
    .refine(
      (dir) => !dir.includes('..'),
      { message: 'frame_dirにパストラバーサル文字(..)は使用できません' }
    )
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
export const motionDetectionModeSchema = z.enum(['css', 'video', 'runtime', 'hybrid']);
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
    detection_mode: motionDetectionModeSchema.optional().default('css'),

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
        wait_until: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().default('domcontentloaded'),
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
    enabled: z.boolean().optional().default(true).describe('Narrative分析を有効化'),

    /**
     * 分析結果をDBに保存するか
     * @default true
     */
    saveToDb: z.boolean().optional().default(true).describe('分析結果をDBに保存'),

    /**
     * Vision LLM（Ollama llama3.2-vision）を使用するか
     * trueの場合、スクリーンショットを使用してより精度の高い分析を行う
     * @default true
     */
    includeVision: z.boolean().optional().default(true).describe('Vision LLM使用'),

    /**
     * Vision解析タイムアウト（ミリ秒）
     * @default 300000 (5分)
     * @min 30000 (30秒)
     * @max 600000 (10分)
     */
    visionTimeoutMs: z
      .number()
      .int()
      .min(30000, { message: 'visionTimeoutMsは30000ms以上である必要があります（最小30秒）' })
      .max(600000, { message: 'visionTimeoutMsは600000ms以下にしてください（最大10分）' })
      .optional()
      .default(300000)
      .describe('Vision解析タイムアウト（ms）'),

    /**
     * Embedding生成を含むか
     * @default true
     */
    generateEmbedding: z.boolean().optional().default(true).describe('Embedding生成を含む'),
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
export const timeoutStrategySchema = z.enum(['strict', 'progressive']);
export type TimeoutStrategy = z.infer<typeof timeoutStrategySchema>;

// ============================================================================
// Input Schema
// ============================================================================

/** page.analyze 入力スキーマ */
export const pageAnalyzeInputSchema = z.object({
  url: z
    .string()
    .url({ message: '有効なURL形式を指定してください' })
    .refine(
      (url) => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'http:// または https:// プロトコルのみ許可されています' }
    ),

  sourceType: sourceTypeSchema.optional().default('user_provided'),
  usageScope: usageScopeSchema.optional().default('inspiration_only'),
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
  waitUntil: waitUntilSchema.optional().default('networkidle'),

  /**
   * タイムアウト戦略
   * - strict: タイムアウト発生時は完全に失敗
   * - progressive: タイムアウト発生時も部分結果を返却（デフォルト）
   * @default 'progressive'
   */
  timeout_strategy: timeoutStrategySchema.optional().default('progressive'),

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
  layout_first: z.enum(['auto', 'always', 'never']).optional().default('auto'),

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
});

export type PageAnalyzeInput = z.infer<typeof pageAnalyzeInputSchema>;

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
  'tailwind',
  'bootstrap',
  'css_modules',
  'styled_components',
  'vanilla',
  'unknown',
  // No-code / 追加フレームワーク
  'webflow',
  'jquery_ui',
  'squarespace',
  'framer',
  'elementor',
  'wix',
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
  category: z.enum(['color', 'typography', 'spacing', 'border', 'shadow', 'layout', 'animation', 'other']),
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
  framework: z.enum(['tailwind', 'open-props', 'css-in-js', 'css-variables', 'unknown']),
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
  format: z.enum(['png', 'jpeg']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** Vision API 解析結果の特徴スキーマ */
export const visionFeatureSchema = z.object({
  type: z.string(),
  confidence: z.number().min(0).max(1),
  description: z.string().optional(),
  boundingBox: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }).optional(),
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
  color: z.string().regex(hexColorPattern, 'Invalid HEX color format'),
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
  source: z.literal('deterministic'),
  /** 信頼度 (0.9-1.0) */
  confidence: z.number().min(0).max(1),
});
export type VisualFeaturesColors = z.infer<typeof visualFeaturesColorsSchema>;

/** Visual Features: Theme (ThemeDetectionResult相当) */
export const visualFeaturesThemeSchema = z.object({
  /** テーマタイプ */
  type: z.enum(['light', 'dark', 'mixed']),
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
  source: z.literal('deterministic'),
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
  source: z.literal('deterministic'),
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
  type: z.enum(['linear', 'radial', 'conic']),
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
  dominantGradientType: z.enum(['linear', 'radial', 'conic']).optional(),
  /** 検出信頼度 (0-1) */
  confidence: z.number().min(0).max(1),
  /** 処理時間（ms） */
  processingTimeMs: z.number().nonnegative(),
  /** データソース */
  source: z.literal('deterministic'),
});
export type VisualFeaturesGradient = z.infer<typeof visualFeaturesGradientSchema>;

/** ムードタイプ */
export const moodTypeSchema = z.enum([
  'calm',
  'energetic',
  'professional',
  'playful',
  'luxurious',
  'minimalist',
  'bold',
  'elegant',
  'friendly',
  'serious',
]);
export type MoodType = z.infer<typeof moodTypeSchema>;

/** Visual Features: Mood (Vision AI analysis result) */
export const visualFeaturesMoodSchema = z.object({
  /** 主要ムード */
  primary: moodTypeSchema,
  /** 副次ムード */
  secondary: moodTypeSchema.optional(),
  /** データソース */
  source: z.literal('vision-ai'),
  /** 信頼度 (0.6-0.8) */
  confidence: z.number().min(0).max(1),
}).nullable();
export type VisualFeaturesMood = z.infer<typeof visualFeaturesMoodSchema>;

/** ブランドトーンタイプ */
export const brandToneTypeSchema = z.enum([
  'corporate',
  'startup',
  'luxury',
  'eco-friendly',
  'tech-forward',
  'traditional',
  'innovative',
  'trustworthy',
  'creative',
  'accessible',
]);
export type BrandToneType = z.infer<typeof brandToneTypeSchema>;

/** Visual Features: BrandTone (Vision AI analysis result) */
export const visualFeaturesBrandToneSchema = z.object({
  /** 主要ブランドトーン */
  primary: brandToneTypeSchema,
  /** 副次ブランドトーン */
  secondary: brandToneTypeSchema.optional(),
  /** データソース */
  source: z.literal('vision-ai'),
  /** 信頼度 (0.6-0.8) */
  confidence: z.number().min(0).max(1),
}).nullable();
export type VisualFeaturesBrandTone = z.infer<typeof visualFeaturesBrandToneSchema>;

/** visionAnalysis警告コード */
export const visionAnalysisWarningCodeSchema = z.enum([
  /** mood分析結果が空または低信頼度でフォールバック値を使用 */
  'MOOD_FALLBACK_USED',
  /** brandTone分析結果が空または低信頼度でフォールバック値を使用 */
  'BRAND_TONE_FALLBACK_USED',
  /** Vision AIサービスが利用不可 */
  'VISION_AI_UNAVAILABLE',
  /** 信頼度が低い（0.5未満） */
  'LOW_CONFIDENCE',
  /** 決定論的抽出の一部が失敗 */
  'DETERMINISTIC_EXTRACTION_PARTIAL',
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
  type: z.enum(['css_animation', 'css_transition', 'keyframes']),
  category: z.string(),
  trigger: z.string(),
  duration: z.number().nonnegative(),
  easing: z.string(),
  properties: z.array(z.string()),
  performance: z.object({
    level: z.enum(['good', 'acceptable', 'poor']),
    usesTransform: z.boolean(),
    usesOpacity: z.boolean(),
  }),
  accessibility: z.object({
    respectsReducedMotion: z.boolean(),
  }),
});

export const warningDetailSchema = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
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
    output_format: z.enum(['png', 'jpeg']),
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
  keyframesRule: z.object({
    name: z.string().optional(),
    keyframes: z.array(z.object({
      offset: z.string(),
      easing: z.string(),
      style: z.string().optional(),
    })).optional(),
  }).optional(),
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
  type: z.enum(['CSSAnimation', 'CSSTransition', 'WebAnimation']),
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
  keyframes: z.array(z.object({
    offset: z.number().nullable(),
    easing: z.string(),
    composite: z.string(),
  }).passthrough()),
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
    'fade',
    'pulse',
    'wave',
    'particle',
    'morph',
    'rotation',
    'parallax',
    'noise',
    'complex',
  ]),
  detectedLibrary: z.string().optional(),
  canvasSelector: z.string(),
  animationCharacteristics: z.object({
    averageChangeRate: z.number(),
    peakChangeRate: z.number(),
    changePattern: z.enum(['continuous', 'pulsed', 'irregular']),
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
  frame_capture_error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
  /** フレーム画像分析エラー（失敗時） */
  frame_analysis_error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),

  // === JS Animation 結果 (v0.1.0) ===
  /** JSアニメーション検出サマリー（detect_js_animations=true時のみ） */
  js_animation_summary: jsAnimationSummarySchema.optional(),
  /** JSアニメーション検出結果（詳細）（summary=false時のみ） */
  js_animations: jsAnimationResultSchema.optional(),
  /** JSアニメーション検出エラー（失敗時） */
  js_animation_error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),

  // === WebGL Animation 結果 (v0.1.0) ===
  /** WebGLアニメーション検出サマリー（detect_webgl_animations=true時のみ） */
  webgl_animation_summary: webglAnimationSummarySchema.optional(),
  /** WebGLアニメーション検出結果（詳細）（summary=false時のみ） */
  webgl_animations: webglAnimationResultSchema.optional(),
  /** WebGLアニメーション検出エラー（失敗時） */
  webgl_animation_error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
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
  severity: z.enum(['high', 'medium', 'low']),
});

export const recommendationSchema = z.object({
  id: z.string(),
  category: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
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
  feature: z.enum(['layout', 'motion', 'quality']),
  code: z.string(),
  message: z.string(),
});
export type AnalysisWarning = z.infer<typeof analysisWarningSchema>;

/** 警告の重大度 */
export const warningSeveritySchema = z.enum(['info', 'warning', 'error']);
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
  type: z.literal('warning'),
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
  completed_phases: z.array(z.enum(['html', 'screenshot', 'layout', 'motion', 'quality'])),

  /**
   * 失敗したフェーズ（タイムアウトまたはエラー）
   */
  failed_phases: z.array(z.enum(['html', 'screenshot', 'layout', 'motion', 'quality'])),

  /**
   * タイムアウトで失敗したフェーズ（v0.1.0）
   * failed_phasesのうち、タイムアウトが原因のもの
   */
  timedout_phases: z.array(z.enum(['layout', 'motion', 'quality'])).optional(),

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
  phase_timeouts: z.object({
    layout: z.number().nonnegative(),
    motion: z.number().nonnegative(),
    quality: z.number().nonnegative(),
  }).optional(),

  /**
   * CPU環境でタイムアウトが延長されたか（Vision CPU完走保証 Phase 4）
   * CPU環境 + Vision有効時にVisionTimeoutsに基づいて延長された場合にtrue
   */
  cpu_mode_extended: z.boolean().optional(),

  /**
   * ハードウェアタイプ（Vision CPU完走保証 Phase 4）
   * GPU/CPUのどちらで実行されたかを記録
   */
  hardware_type: z.enum(['GPU', 'CPU']).optional(),
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
]);
export type MoodCategory = z.infer<typeof moodCategorySchema>;

/**
 * 色彩調和タイプ
 */
export const colorHarmonySchema = z.enum([
  'complementary',
  'analogous',
  'monochromatic',
  'triadic',
  'split-complementary',
  'mixed',
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
  visualHierarchy: z.object({
    primaryElements: z.array(z.string()),
    sectionFlow: z.enum(['linear', 'modular', 'asymmetric']),
  }).optional(),
  /** スペーシングリズム（簡略化） */
  spacingRhythm: z.object({
    baseUnit: z.string(),
    scale: z.array(z.number()),
  }).optional(),
  /** ホワイトスペース比率（0-1） */
  whitespaceRatio: z.number().min(0).max(1).optional(),
  /** 視覚的密度 */
  visualDensity: z.enum(['sparse', 'balanced', 'dense']).optional(),
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
  backgroundDesigns: z.object({
    /** 検出された背景デザインの総数 */
    count: z.number().nonnegative(),
    /** 検出されたデザインタイプの一覧（重複あり） */
    types: z.array(z.string()),
    /** DBに保存された件数（saveToDb=true時のみ > 0） */
    savedToDb: z.number().nonnegative(),
  }).optional(),
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

export const pageAnalyzeOutputSchema = z.discriminatedUnion('success', [
  pageAnalyzeSuccessOutputSchema,
  pageAnalyzeErrorOutputSchema,
]);

export type PageAnalyzeOutput = z.infer<typeof pageAnalyzeOutputSchema>;
export type PageAnalyzeSuccessOutput = z.infer<typeof pageAnalyzeSuccessOutputSchema>;
export type PageAnalyzeErrorOutput = z.infer<typeof pageAnalyzeErrorOutputSchema>;

// ============================================================================
// Utility Functions
// ============================================================================

/** スコアをグレードに変換（A: 90+, B: 80+, C: 70+, D: 60+, F: <60） */
export function scoreToGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

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
  status: z.literal('queued'),
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
  'waiting',    // キュー待ち
  'active',     // 処理中
  'completed',  // 完了
  'failed',     // 失敗
  'delayed',    // 遅延
  'unknown',    // 不明
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
  completedPhases: z.array(z.enum(['ingest', 'layout', 'motion', 'quality', 'narrative', 'embedding'])),
  /** 失敗したフェーズ */
  failedPhases: z.array(z.enum(['ingest', 'layout', 'motion', 'quality', 'narrative', 'embedding'])),
  /** フェーズ別結果サマリー */
  results: z.object({
    layout: z.object({
      sectionsDetected: z.number().nonnegative(),
      visionUsed: z.boolean(),
    }).optional(),
    motion: z.object({
      patternsDetected: z.number().nonnegative(),
      jsAnimationsDetected: z.number().nonnegative(),
    }).optional(),
    quality: z.object({
      overallScore: z.number().min(0).max(100),
      grade: z.string(),
    }).optional(),
    narrative: z.object({
      moodCategory: z.string(),
      confidence: z.number().min(0).max(1),
      visionUsed: z.boolean(),
    }).optional(),
    embedding: z.object({
      sectionEmbeddingsGenerated: z.number().nonnegative().optional(),
      motionEmbeddingsGenerated: z.number().nonnegative().optional(),
      backgroundDesignEmbeddingsGenerated: z.number().nonnegative().optional(),
    }).optional(),
  }).optional(),
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
  currentPhase: z.enum(['ingest', 'layout', 'motion', 'quality', 'narrative', 'embedding']).optional(),
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
  optimization_mode: z.enum(['full', 'summary', 'compact', 'truncated']).optional(),
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
export const pageGetJobStatusOutputSchema = z.discriminatedUnion('success', [
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
