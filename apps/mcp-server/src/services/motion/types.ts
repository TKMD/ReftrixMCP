// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frame Image Analysis Service Types
 *
 * PNG/JPEGフレーム連番を分析するサービスの型定義
 *
 * @module @reftrix/mcp-server/services/motion/types
 */

// ============================================================================
// 基本型
// ============================================================================

/**
 * RGB色値
 */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * 境界ボックス
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * ビューポートサイズ
 */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * フレームメタデータ
 */
export interface FrameMetadata {
  path: string;
  index?: number;
  width?: number;
  height?: number;
}

/**
 * フレームデータ
 */
export interface FrameData {
  buffer: Buffer;
  width: number;
  height: number;
  index: number;
  path?: string;
}

// ============================================================================
// 入力スキーマ
// ============================================================================

/**
 * フレーム抽出結果（FrameAnalyzerServiceからの入力）
 */
export interface ExtractResult {
  totalFrames: number;
  frameDir: string;
  fps: number;
}

/**
 * 分析オプション
 */
export interface AnalysisOptions {
  // === フレーム差分 ===
  /** フレーム差分分析を実行（デフォルト: true） */
  diffAnalysis?: boolean;
  /** 変化検出閾値 0-1（デフォルト: 0.01） */
  diffThreshold?: number;

  // === モーションベクトル ===
  /** モーションベクトル推定を実行（デフォルト: false） */
  motionVector?: boolean;
  /** 信頼度閾値 0-1（デフォルト: 0.7） */
  motionConfidenceThreshold?: number;

  // === レイアウトシフト ===
  /** レイアウトシフト検出を実行（デフォルト: true） */
  layoutShift?: boolean;
  /** シフト影響スコア閾値 0-1（デフォルト: 0.05） */
  layoutShiftThreshold?: number;

  // === 色変化検出 ===
  /** 色変化検出を実行（デフォルト: false） */
  colorChange?: boolean;

  // === 要素出現/消失 ===
  /** 要素出現/消失検出を実行（デフォルト: false） */
  elementVisibility?: boolean;
  /** 最小検出サイズ（デフォルト: 100px） */
  minElementSize?: number;

  // === パフォーマンス ===
  /** 並列処理を使用（デフォルト: true） */
  parallel?: boolean;
  /** 最大ワーカー数（デフォルト: 4） */
  maxWorkers?: number;
  /** フレームキャッシュサイズ（デフォルト: 50） */
  cacheSize?: number;
}

/**
 * フレーム分析入力
 */
export interface FrameAnalysisInput {
  // === 入力ソース（いずれか必須） ===
  /** フレームディレクトリパス */
  frameDir?: string;
  /** フレームファイルパス配列 */
  framePaths?: string[];
  /** FrameAnalyzerServiceの抽出結果 */
  extractResult?: ExtractResult;

  // === メタデータ ===
  /** フレームレート（デフォルト: 30） */
  fps?: number;
  /** ビューポートサイズ（レイアウトシフト計算用） */
  viewport?: ViewportSize;

  // === 分析オプション ===
  analysisOptions?: AnalysisOptions;

  // === 出力オプション ===
  /** 差分可視化画像を生成 */
  includeDiffImages?: boolean;
  /** 軽量モード（サマリーのみ） */
  summary?: boolean;
}

// ============================================================================
// 差分分析結果
// ============================================================================

/**
 * 差分オプション
 */
export interface DiffOptions {
  /** 許容差 0-1（デフォルト: 0.1） */
  threshold?: number;
  /** アンチエイリアスを含むか（デフォルト: false） */
  includeAA?: boolean;
  /** 差分マスクを含むか */
  includeDiffMask?: boolean;
}

/**
 * フレーム差分結果
 */
export interface FrameDiffResult {
  /** フレームインデックス（ペアの2番目） */
  frameIndex: number;
  /** 変化したピクセル数 */
  changedPixels: number;
  /** 総ピクセル数 */
  totalPixels: number;
  /** 変化率 (0-1) */
  changeRatio: number;
  /** 変化があるか（0.1%以上） */
  hasChange: boolean;
  /** 変化領域 */
  regions: BoundingBox[];
  /** 差分マスク（オプション） */
  diffMask?: Uint8Array;
}

/**
 * 差分分析サマリー
 */
export interface DiffAnalysisSummary {
  /** 平均変化率 */
  avgChangeRatio: number;
  /** 最大変化率 */
  maxChangeRatio: number;
  /** 動きのあるフレーム数 */
  motionFrameCount: number;
  /** 動きのあるフレーム比率 */
  motionFrameRatio: number;
}

// ============================================================================
// レイアウトシフト結果
// ============================================================================

/**
 * レイアウトシフトの推定原因
 */
export type LayoutShiftCause =
  | 'image_load'
  | 'font_swap'
  | 'dynamic_content'
  | 'ad_injection'
  | 'unknown';

/**
 * レイアウトシフト結果
 */
export interface LayoutShiftResult {
  /** フレームインデックス */
  frameIndex: number;
  /** シフト開始時間（ms） */
  shiftStartMs: number;
  /** 影響スコア（CLS計算式） */
  impactScore: number;
  /** 影響を受けた領域 */
  affectedRegions: BoundingBox[];
  /** 推定原因 */
  estimatedCause: LayoutShiftCause;
  /** シフト方向（度） */
  shiftDirection: number;
  /** シフト距離（px） */
  shiftDistance: number;
}

/**
 * レイアウトシフトサマリー
 */
export interface LayoutShiftSummary {
  /** 総シフト数 */
  totalShifts: number;
  /** 最大影響スコア */
  maxImpactScore: number;
  /** 累積シフトスコア（CLS相当） */
  cumulativeShiftScore: number;
}

// ============================================================================
// 色変化結果
// ============================================================================

/**
 * 色変化タイプ
 */
export type ColorChangeType = 'fade_in' | 'fade_out' | 'color_transition' | 'brightness_change';

/**
 * 色変化イベント
 */
export interface ColorChangeEvent {
  /** 開始フレーム */
  startFrame: number;
  /** 終了フレーム */
  endFrame: number;
  /** 変化タイプ */
  changeType: ColorChangeType;
  /** 影響領域 */
  affectedRegion: BoundingBox;
  /** 開始色（HEX） */
  fromColor: string;
  /** 終了色（HEX） */
  toColor: string;
  /** 推定持続時間（ms） */
  estimatedDurationMs: number;
}

/**
 * 色変化結果
 */
export interface ColorChangeResult {
  /** 色変化イベント */
  events: ColorChangeEvent[];
  /** フェードイン検出数 */
  fadeInCount: number;
  /** フェードアウト検出数 */
  fadeOutCount: number;
  /** 色遷移検出数 */
  transitionCount: number;
}

// ============================================================================
// モーションベクトル結果
// ============================================================================

/**
 * モーションタイプ
 */
export type MotionType =
  | 'static'
  | 'slide_left'
  | 'slide_right'
  | 'slide_up'
  | 'slide_down'
  | 'zoom_in'
  | 'zoom_out'
  | 'rotation'
  | 'complex';

/**
 * モーションベクトル結果
 */
export interface MotionVectorResult {
  /** フレームインデックス */
  frameIndex: number;
  /** 主要な動きの方向（度） */
  dominantDirection: number;
  /** 平均速度（px/frame） */
  avgSpeed: number;
  /** 最大速度 */
  maxSpeed: number;
  /** 信頼度 (0-1) */
  confidence: number;
  /** 推定モーションタイプ */
  motionType: MotionType;
}

/**
 * モーションベクトルサマリー
 */
export interface MotionVectorSummary {
  /** 主要モーションタイプ */
  primaryMotionType: MotionType;
  /** 平均速度 */
  avgSpeed: number;
  /** 主要方向（度） */
  dominantDirection: number;
}

// ============================================================================
// 要素可視性結果
// ============================================================================

/**
 * 要素可視性イベントタイプ
 */
export type VisibilityEventType = 'appear' | 'disappear';

/**
 * 要素可視性イベント
 */
export interface ElementVisibilityEvent {
  /** フレームインデックス */
  frameIndex: number;
  /** イベントタイプ */
  eventType: VisibilityEventType;
  /** 要素の境界ボックス */
  region: BoundingBox;
  /** 推定要素サイズ（px） */
  elementSize: number;
}

/**
 * 要素可視性結果
 */
export interface ElementVisibilityResult {
  /** イベント */
  events: ElementVisibilityEvent[];
  /** 出現数 */
  appearanceCount: number;
  /** 消失数 */
  disappearanceCount: number;
}

// ============================================================================
// 分析結果出力
// ============================================================================

/**
 * エラーコード
 */
export const FrameAnalysisErrorCodes = {
  // === 入力バリデーション ===
  INVALID_INPUT: 'FRAME_ANALYSIS_INVALID_INPUT',
  MISSING_FRAMES: 'FRAME_ANALYSIS_MISSING_FRAMES',
  INVALID_FRAME_FORMAT: 'FRAME_ANALYSIS_INVALID_FRAME_FORMAT',
  DIMENSION_MISMATCH: 'FRAME_ANALYSIS_DIMENSION_MISMATCH',
  PATH_TRAVERSAL: 'FRAME_ANALYSIS_PATH_TRAVERSAL',

  // === リソース制限 ===
  MAX_FRAMES_EXCEEDED: 'FRAME_ANALYSIS_MAX_FRAMES_EXCEEDED',
  MEMORY_LIMIT_EXCEEDED: 'FRAME_ANALYSIS_MEMORY_LIMIT_EXCEEDED',
  TIMEOUT: 'FRAME_ANALYSIS_TIMEOUT',

  // === 処理エラー ===
  DIFF_FAILED: 'FRAME_ANALYSIS_DIFF_FAILED',
  LAYOUT_SHIFT_FAILED: 'FRAME_ANALYSIS_LAYOUT_SHIFT_FAILED',
  COLOR_ANALYSIS_FAILED: 'FRAME_ANALYSIS_COLOR_ANALYSIS_FAILED',
  MOTION_VECTOR_FAILED: 'FRAME_ANALYSIS_MOTION_VECTOR_FAILED',

  // === インフラエラー ===
  WORKER_FAILED: 'FRAME_ANALYSIS_WORKER_FAILED',
  SHARP_ERROR: 'FRAME_ANALYSIS_SHARP_ERROR',
  FILE_READ_ERROR: 'FRAME_ANALYSIS_FILE_READ_ERROR',

  // === 内部エラー ===
  INTERNAL_ERROR: 'FRAME_ANALYSIS_INTERNAL_ERROR',
} as const;

export type FrameAnalysisErrorCode =
  (typeof FrameAnalysisErrorCodes)[keyof typeof FrameAnalysisErrorCodes];

/**
 * フレーム分析結果
 */
export interface FrameAnalysisResult {
  success: boolean;
  data?: {
    // === 基本情報 ===
    totalFrames: number;
    analyzedPairs: number;
    durationMs: number;
    fps: number;

    // === フレーム差分結果 ===
    diffAnalysis?: {
      results: FrameDiffResult[];
      summary: DiffAnalysisSummary;
    };

    // === モーションベクトル結果 ===
    motionVectors?: {
      results: MotionVectorResult[];
      summary: MotionVectorSummary;
    };

    // === レイアウトシフト結果 ===
    layoutShifts?: {
      results: LayoutShiftResult[];
      summary: LayoutShiftSummary;
    };

    // === 色変化結果 ===
    colorChanges?: ColorChangeResult;

    // === 要素出現/消失結果 ===
    elementVisibility?: ElementVisibilityResult;

    // === タイムライン ===
    timeline?: TimelineEvent[];

    // === メタデータ ===
    processingTimeMs: number;
    _summaryMode?: boolean;
  };
  error?: {
    code: FrameAnalysisErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ============================================================================
// タイムラインイベント
// ============================================================================

/**
 * タイムラインイベントタイプ
 */
export type TimelineEventType =
  | 'motion_start'
  | 'motion_end'
  | 'layout_shift'
  | 'fade_in'
  | 'fade_out'
  | 'element_appear'
  | 'element_disappear';

/**
 * タイムラインイベント
 */
export interface TimelineEvent {
  /** タイムスタンプ（ms） */
  timestampMs: number;
  /** フレームインデックス */
  frameIndex: number;
  /** イベントタイプ */
  type: TimelineEventType;
  /** イベント詳細 */
  details: Record<string, unknown>;
}

// ============================================================================
// インターフェース
// ============================================================================

/**
 * フレーム差分アナライザーインターフェース
 */
export interface IFrameDiffAnalyzer {
  /**
   * 2フレーム間の差分を計算
   */
  compare(
    frame1: Buffer,
    frame2: Buffer,
    width: number,
    height: number,
    options?: DiffOptions
  ): Promise<FrameDiffResult>;

  /**
   * 差分マスクから変化領域を抽出
   */
  extractRegions(
    diffMask: Uint8Array,
    width: number,
    height: number,
    minSize?: number
  ): BoundingBox[];
}

/**
 * レイアウトシフト検出器インターフェース
 */
export interface ILayoutShiftDetector {
  /**
   * フレームシーケンスからレイアウトシフトを検出
   */
  detect(
    frames: FrameData[],
    viewportSize: ViewportSize,
    threshold?: number
  ): Promise<LayoutShiftResult[]>;

  /**
   * CLS影響スコアを計算
   */
  calculateImpactScore(
    previousBox: BoundingBox,
    currentBox: BoundingBox,
    viewportArea: number
  ): number;
}

/**
 * 色変化アナライザーインターフェース
 */
export interface IColorChangeAnalyzer {
  /**
   * フレームから主要色を抽出
   */
  extractDominantColor(frame: Buffer): Promise<RGB>;

  /**
   * 色変化イベントを検出
   */
  detectColorEvents(frames: FrameData[], fps: number): Promise<ColorChangeEvent[]>;
}

/**
 * モーションベクトル推定器インターフェース
 */
export interface IMotionVectorEstimator {
  /**
   * オプティカルフローを計算
   */
  estimateFlow(frame1: Buffer, frame2: Buffer): Promise<MotionVectorResult>;

  /**
   * モーションタイプを分類
   */
  classifyMotion(vectors: MotionVectorResult[]): MotionType;
}

/**
 * フレームローダーインターフェース
 */
export interface IFrameLoader {
  /**
   * ディレクトリからフレームを読み込み
   */
  loadFromDirectory(dir: string, pattern?: string): Promise<FrameData[]>;

  /**
   * ファイルパス配列からフレームを読み込み
   */
  loadFromPaths(paths: string[]): Promise<FrameData[]>;

  /**
   * 単一フレームを読み込み
   */
  loadFrame(path: string): Promise<FrameData>;
}

/**
 * フレームキャッシュインターフェース
 */
export interface IFrameCache {
  /**
   * フレームをキャッシュに追加
   */
  set(key: string, buffer: Buffer, metadata: FrameMetadata): void;

  /**
   * フレームを取得
   */
  get(key: string): Buffer | undefined;

  /**
   * キャッシュをクリア
   */
  clear(): void;

  /**
   * 現在のサイズ（バイト）
   */
  readonly size: number;
}

/**
 * FrameImageAnalysisServiceインターフェース
 */
export interface IFrameImageAnalysisService {
  /**
   * フレームシーケンスを分析
   */
  analyze(input: FrameAnalysisInput): Promise<FrameAnalysisResult>;

  /**
   * 単一フレームペアの差分を計算
   */
  comparePair(
    frame1: string | Buffer,
    frame2: string | Buffer,
    options?: DiffOptions
  ): Promise<FrameDiffResult>;

  /**
   * リソースをクリーンアップ
   */
  dispose(): Promise<void>;
}

// ============================================================================
// エラークラス
// ============================================================================

/**
 * フレーム分析エラー
 */
export class FrameAnalysisError extends Error {
  constructor(
    public readonly code: FrameAnalysisErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'FrameAnalysisError';
  }

  toJSON(): { code: FrameAnalysisErrorCode; message: string; details?: Record<string, unknown> | undefined } {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

// ============================================================================
// 定数
// ============================================================================

/**
 * デフォルト設定
 */
export const DEFAULTS = {
  /** デフォルトFPS */
  FPS: 30,
  /** デフォルト差分閾値 */
  DIFF_THRESHOLD: 0.1,
  /** デフォルトレイアウトシフト閾値 */
  LAYOUT_SHIFT_THRESHOLD: 0.05,
  /** デフォルトモーション信頼度閾値 */
  MOTION_CONFIDENCE_THRESHOLD: 0.7,
  /** デフォルト最小要素サイズ */
  MIN_ELEMENT_SIZE: 100,
  /** デフォルト最大ワーカー数 */
  MAX_WORKERS: 4,
  /** デフォルトキャッシュサイズ */
  CACHE_SIZE: 50,
} as const;

/**
 * 制限値
 */
export const LIMITS = {
  /** 最大フレーム数 */
  MAX_TOTAL_FRAMES: 3600,
  /** 最大フレームサイズ（4K） */
  MAX_FRAME_SIZE: 4096 * 4096,
  /** 最小フレームサイズ */
  MIN_FRAME_SIZE: 320 * 240,
  /** 最大メモリ使用量（500MB） */
  MAX_MEMORY_BYTES: 500 * 1024 * 1024,
  /** 最大処理時間（60秒） */
  MAX_PROCESSING_TIME_MS: 60 * 1000,
  /** 許可された拡張子 */
  ALLOWED_EXTENSIONS: ['.png', '.jpg', '.jpeg'] as readonly string[],
  /** 最大ファイルサイズ（10MB） */
  MAX_FILE_SIZE: 10 * 1024 * 1024,
} as const;

// ============================================================================
// Frame Loader 型定義
// ============================================================================

/**
 * Frame Loader用のフレームメタデータ（拡張版）
 */
export interface FrameLoaderMetadata {
  /** ファイルパス */
  path: string;
  /** 幅 (pixels) */
  width: number;
  /** 高さ (pixels) */
  height: number;
  /** チャンネル数 (3: RGB, 4: RGBA) */
  channels: 3 | 4;
  /** ファイルサイズ (bytes) */
  fileSize: number;
  /** フォーマット */
  format: 'png' | 'jpeg';
}

/**
 * Frame Loader用のフレームデータ（拡張版）
 */
export interface FrameLoaderData {
  /** メタデータ */
  metadata: FrameLoaderMetadata;
  /** Rawピクセルデータ (RGBA) */
  buffer: Buffer;
}

/**
 * フレームペア（差分比較用）
 */
export interface FramePair {
  /** フレーム1 */
  frame1: FrameLoaderData;
  /** フレーム2 */
  frame2: FrameLoaderData;
}

/**
 * Frame Loader オプション
 */
export interface FrameLoaderOptions {
  /** 許可ディレクトリのリスト（デフォルト: プロセスcwd） */
  allowedDirectories?: string[];
  /** ファイルサイズ上限 (bytes, デフォルト: 10MB) */
  maxFileSize?: number;
  /** メモリ使用量最適化（縮小読み込み） */
  optimizeMemory?: boolean;
  /** 最大幅（optimizeMemory時） */
  maxWidth?: number;
  /** 最大高さ（optimizeMemory時） */
  maxHeight?: number;
}

/**
 * パス検証エラーコード
 */
export type PathValidationErrorCode =
  | 'PATH_TRAVERSAL'
  | 'OUTSIDE_ALLOWED_DIR'
  | 'INVALID_EXTENSION'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'NOT_A_FILE'
  | 'PERMISSION_DENIED';

/**
 * パス検証結果
 */
export interface PathValidationResult {
  /** 有効なパスか */
  isValid: boolean;
  /** エラーメッセージ（無効な場合） */
  errorMessage?: string;
  /** エラーコード（無効な場合） */
  errorCode?: PathValidationErrorCode;
  /** 正規化されたパス（有効な場合） */
  normalizedPath?: string;
}

/**
 * Frame Loader エラー
 */
export class FrameLoaderError extends Error {
  constructor(
    public readonly code: PathValidationErrorCode | 'DIMENSION_MISMATCH' | 'LOAD_FAILED',
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'FrameLoaderError';
  }

  toJSON(): { code: PathValidationErrorCode | 'DIMENSION_MISMATCH' | 'LOAD_FAILED'; message: string; details?: Record<string, unknown> | undefined } {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}
