// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze ハンドラー共通型定義
 *
 * analyze.tool.tsから抽出したサービス結果型とDIインターフェース
 *
 * @module tools/page/handlers/types
 */

import type { PageAnalyzeInput, Grade, VisualFeatures } from '../schemas';
import type { ComputedStyleInfo } from '../../../services/page-ingest-adapter';
import type { CSSVariableExtractionResult } from '../../../services/visual/css-variable-extractor.service';
import type { BackgroundDesignDetection } from '../../../services/background/background-design-detector.service';

/**
 * BackgroundDesignDetection の型エイリアス（LayoutServiceResult用）
 * services/background/ のDetection型をhandlers/ で使用可能にする
 */
export type BackgroundDesignDetectionData = BackgroundDesignDetection;

// =====================================================
// エクスポート型（外部公開）
// =====================================================

/**
 * モーションパターン入力型（Embedding生成用）
 */
export interface MotionPatternInput {
  id: string;
  name: string;
  type: 'css_animation' | 'css_transition' | 'keyframes';
  category: string;
  trigger: string;
  duration?: number;
  easing?: string;
  properties?: string[];
}

// =====================================================
// Video Mode 型定義（video-handler.tsと共有）
// =====================================================

/**
 * Frame Capture設定（exactOptionalPropertyTypes対応）
 */
export interface FrameCaptureOptions {
  scroll_px_per_frame?: number | undefined;
  frame_interval_ms?: number | undefined;
  output_dir?: string | undefined;
  output_format?: 'png' | 'jpeg' | undefined;
  filename_pattern?: string | undefined;
}

/**
 * Frame Analysis設定（exactOptionalPropertyTypes対応）
 */
export interface FrameAnalysisOptions {
  sample_interval?: number | undefined;
  diff_threshold?: number | undefined;
  cls_threshold?: number | undefined;
  motion_threshold?: number | undefined;
  output_diff_images?: boolean | undefined;
  parallel?: boolean | undefined;
}

/**
 * Video Mode入力オプション
 */
export interface VideoModeOptions {
  enable_frame_capture?: boolean | undefined;
  analyze_frames?: boolean | undefined;
  frame_capture_options?: FrameCaptureOptions | undefined;
  frame_analysis_options?: FrameAnalysisOptions | undefined;
}

/**
 * Frame Capture結果
 */
export interface FrameCaptureResult {
  total_frames: number;
  output_dir: string;
  config: {
    scroll_px_per_frame: number;
    frame_interval_ms: number;
    output_format: 'png' | 'jpeg';
    output_dir: string;
    filename_pattern: string;
  };
  files: Array<{
    frame_number: number;
    scroll_position_px: number;
    timestamp_ms: number;
    file_path: string;
  }>;
  duration_ms: number;
}

/**
 * Frame Analysis結果
 * Note: exactOptionalPropertyTypesに対応するため、optional propertyには| undefinedを付けない
 */
export interface FrameAnalysisResult {
  timeline: Array<{
    frame_index: number;
    diff_percentage: number;
    layout_shift_score?: number;
    motion_vectors?: Array<{ x: number; y: number; magnitude: number }>;
  }>;
  summary: {
    max_diff: number;
    avg_diff: number;
    total_layout_shifts: number;
    cls_score?: number;
    significant_change_frames: number[];
    processing_time_ms: number;
  };
}

/**
 * Video Mode実行結果
 * Note: exactOptionalPropertyTypesに対応するため、optional propertyには| undefinedを付けない
 */
export interface VideoModeResult {
  frame_capture?: FrameCaptureResult;
  frame_analysis?: FrameAnalysisResult;
  frame_capture_error?: { code: string; message: string };
  frame_analysis_error?: { code: string; message: string };
}

// =====================================================
// Vision 型定義（共通化）
// =====================================================

/**
 * Vision特徴量の基本型
 */
export interface VisionFeatureBase {
  type: string;
  confidence: number;
  description?: string;
}

/**
 * Vision特徴量（BoundingBox付き、ページ全体解析用）
 */
export interface VisionFeatureWithBoundingBox extends VisionFeatureBase {
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * セクション単位のVision解析結果
 * sections[].visionFeatures と SectionForSave.visionFeatures で共有
 */
export interface SectionVisionFeatures {
  success: boolean;
  features: VisionFeatureBase[];
  textRepresentation?: string;
  error?: string;
  processingTimeMs: number;
  modelName: string;
  sectionBounds?: {
    startY: number;
    endY: number;
    height: number;
  };
}

/**
 * ページ全体のVision解析結果
 *
 * Vision CPU完走保証 Phase 3:
 * - hardwareType: 検出されたハードウェアタイプ（GPU/CPU）
 * - timeoutMs: 計算されたタイムアウト値（ミリ秒）
 * - optimizationApplied: 画像最適化が適用されたか
 * - fallback: Graceful Degradationが発動したか
 * - fallbackReason: フォールバック理由（timeout/error）
 */
export interface PageVisionFeatures {
  success: boolean;
  features: VisionFeatureWithBoundingBox[];
  error?: string;
  processingTimeMs: number;
  modelName: string;
  // Vision CPU完走保証 Phase 3: メタ情報
  /** 検出されたハードウェアタイプ（GPU/CPU） */
  hardwareType?: 'GPU' | 'CPU';
  /** 計算されたタイムアウト値（ミリ秒） */
  timeoutMs?: number;
  /** 画像最適化が適用されたか */
  optimizationApplied?: boolean;
  /** Graceful Degradationが発動したか */
  fallback?: boolean;
  /** フォールバック理由（timeout/error） */
  fallbackReason?: 'timeout' | 'error';
}

// =====================================================
// サービス結果型（内部使用）
// =====================================================

/**
 * レイアウト分析サービスの結果型
 */
export interface LayoutServiceResult {
  success: boolean;
  pageId?: string;
  sectionCount: number;
  sectionTypes: Record<string, number>;
  processingTimeMs: number;
  html?: string;
  /** CSSスニペット（ページ全体から抽出、style/link/inline styles） */
  cssSnippet?: string;
  /** 外部CSSコンテンツ（<link rel="stylesheet">の実コンテンツ） */
  externalCssContent?: string;
  /** 外部CSSメタ情報 */
  externalCssMeta?: {
    fetchedCount: number;
    failedCount: number;
    totalSize: number;
    urls: Array<{ url: string; size?: number; success?: boolean }>;
    fetchedAt: string;
  };
  /** CSSフレームワーク検出結果 */
  cssFramework?: {
    framework: CssFrameworkType;
    confidence: number;
    evidence: string[];
  };
  screenshot?: {
    base64: string;
    format: 'png' | 'jpeg';
    width: number;
    height: number;
  };
  sections?: Array<{
    id: string;
    type: string;
    positionIndex: number;
    heading?: string;
    confidence: number;
    /** セクションのHTMLスニペット（サニタイズ済み、最大50KB） */
    htmlSnippet?: string;
    /** セクションの位置情報（perSectionVision用） */
    position?: {
      startY: number;
      endY: number;
      height: number;
    };
    /** セクション単位のVision解析結果（perSectionVision=true時のみ） */
    visionFeatures?: SectionVisionFeatures;
  }>;
  /** Vision API 解析結果（useVision=true 時のみ） */
  visionFeatures?: PageVisionFeatures;
  /** Embedding用テキスト表現（Vision解析結果から生成） */
  textRepresentation?: string;
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
  visualFeatures?: VisualFeatures;
  /**
   * CSS変数抽出結果（v0.1.0追加）
   *
   * 外部CSS取得時（fetchExternalCss: true）に、CSS custom properties、
   * clamp()値、calc()式、デザイントークン情報を抽出。
   *
   * Webサイト構築時の参考データとして活用可能。
   */
  cssVariables?: CSSVariableExtractionResult;
  /**
   * 背景デザイン検出結果
   *
   * CSS静的解析から検出された背景デザインパターン
   * (グラデーション、ガラスモーフィズム、画像背景、アニメーション背景 等)
   */
  backgroundDesigns?: BackgroundDesignDetectionData[];
  error?: {
    code: string;
    message: string;
  };
}

/**
 * モーションパターンデータ（共通型）
 * MotionServiceResult.patterns, MotionPatternForEmbedding, MotionPatternForSaveで共有
 */
export interface MotionPatternData {
  id: string;
  name: string;
  // v0.1.0: library_animation と video_motion を追加（motion.detect統合）
  // v0.1.0: vision_detected を追加（scroll-vision-persistence経由のパターン）
  type: 'css_animation' | 'css_transition' | 'keyframes' | 'library_animation' | 'video_motion' | 'vision_detected';
  category: string;
  trigger: string;
  // v0.1.0: duration は MotionPattern.animation.duration からの変換で undefined になり得る
  duration?: number | undefined;
  easing: string;
  properties: string[];
  propertiesDetailed?: Array<{ property: string; from?: string; to?: string }> | undefined;
  performance: {
    // v0.1.0: 'high' を追加（video/runtime mode で使用）
    level: 'good' | 'acceptable' | 'poor' | 'high';
    usesTransform: boolean;
    usesOpacity: boolean;
  };
  accessibility: {
    respectsReducedMotion: boolean;
  };
}

/**
 * モーションパターンデータ（Embedding生成用）
 * embedding-handler.tsで使用、MotionPatternDataと同一構造
 */
export type MotionPatternForEmbedding = MotionPatternData;

// =====================================================
// JS Animation 型定義（CDP + Web Animations API + Library Detection）
// =====================================================

/**
 * CDPアニメーションソース情報
 */
export interface CDPAnimationSource {
  duration: number;
  delay: number;
  iterations: number;
  direction: string;
  easing: string;
  keyframesRule?: {
    name?: string;
    keyframes?: Array<{
      offset: string;
      easing: string;
      style?: string;
    }>;
  };
}

/**
 * CDP経由で検出されたアニメーション
 */
export interface CDPAnimationData {
  id: string;
  name: string;
  pausedState: boolean;
  playState: string;
  playbackRate: number;
  startTime: number;
  currentTime: number;
  type: 'CSSAnimation' | 'CSSTransition' | 'WebAnimation';
  source: CDPAnimationSource;
}

/**
 * Web Animations APIで検出されたアニメーション
 */
export interface WebAnimationData {
  id: string;
  playState: string;
  target: string;
  timing: {
    duration: number;
    delay: number;
    iterations: number;
    direction: string;
    easing: string;
    fill: string;
  };
  keyframes: Array<{
    offset: number | null;
    easing: string;
    composite: string;
    [property: string]: unknown;
  }>;
}

// =====================================================
// Three.js 詳細情報型定義
// =====================================================

/**
 * Three.js オブジェクト情報
 */
export interface ThreeJSObjectData {
  type: string;
  geometry?: string;
  material?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  color?: string;
  intensity?: number;
}

/**
 * Three.js シーン情報
 */
export interface ThreeJSSceneData {
  id: string;
  background?: string;
  fog?: {
    type: string;
    color: string;
    density?: number;
    near?: number;
    far?: number;
  };
  objects: ThreeJSObjectData[];
}

/**
 * Three.js カメラ情報
 */
export interface ThreeJSCameraData {
  type: string;
  fov?: number;
  aspect?: number;
  near?: number;
  far?: number;
  position?: [number, number, number];
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/**
 * Three.js レンダラー情報
 */
export interface ThreeJSRendererData {
  antialias?: boolean;
  shadowMap?: boolean;
  toneMapping?: string;
  outputColorSpace?: string;
  pixelRatio?: number;
}

/**
 * Three.js パフォーマンス指標
 */
export interface ThreeJSPerformanceData {
  fps?: number;
  drawCalls?: number;
  triangles?: number;
  points?: number;
  lines?: number;
}

/**
 * Three.js 詳細情報
 */
export interface ThreeJSDetailsData {
  version?: string;
  scenes: ThreeJSSceneData[];
  cameras: ThreeJSCameraData[];
  renderer: ThreeJSRendererData;
  performance: ThreeJSPerformanceData;
  textures?: string[];
}

/**
 * Three.js library_specific_data 構造型
 * JSAnimationPattern.librarySpecificData に保存される Three.js 詳細情報
 *
 * サイズ制限: 256KB（超過時は truncate して extractionLevel を 'basic' に設定）
 */
export interface ThreeJSLibrarySpecificData {
  three_js: {
    /** Three.js バージョン (例: "r167") */
    version?: string;
    /** シーン情報配列 */
    scenes: ThreeJSSceneData[];
    /** カメラ情報配列 */
    cameras: ThreeJSCameraData[];
    /** レンダラー設定 */
    renderer: ThreeJSRendererData;
    /** パフォーマンス指標 */
    performance?: ThreeJSPerformanceData;
    /** 抽出日時 (ISO8601) */
    extractedAt: string;
    /** 抽出レベル: 'detailed' = 全データ, 'basic' = トランケート後 */
    extractionLevel: 'basic' | 'detailed';
    /** トランケート発生フラグ */
    truncated?: boolean;
    /** トランケート理由 */
    truncationReason?: string;
  };
  /** WebGLシーン数（後方互換性のため維持） */
  scenes?: number;
}

// =====================================================
// ライブラリ検出結果型定義
// =====================================================

/**
 * ライブラリ検出結果
 */
export interface LibraryDetectionData {
  gsap: {
    detected: boolean;
    version?: string;
    tweens?: number;
  };
  framerMotion: {
    detected: boolean;
    elements?: number;
  };
  anime: {
    detected: boolean;
    instances?: number;
  };
  three: {
    detected: boolean;
    scenes?: number;
    /** Three.js詳細情報 (v0.1.0) */
    details?: ThreeJSDetailsData;
  };
  lottie: {
    detected: boolean;
    animations?: number;
  };
}

/**
 * JSアニメーション検出結果（詳細）
 */
export interface JSAnimationFullResult {
  cdpAnimations: CDPAnimationData[];
  webAnimations: WebAnimationData[];
  libraries: LibraryDetectionData;
  detectionTimeMs: number;
  totalDetected: number;
}

/**
 * JSアニメーション検出サマリー
 */
export interface JSAnimationSummaryResult {
  cdpAnimationCount: number;
  webAnimationCount: number;
  detectedLibraries: string[];
  totalDetected: number;
  detectionTimeMs: number;
}

// =====================================================
// WebGL Animation 型定義 (v0.1.0)
// =====================================================

/**
 * WebGLアニメーションカテゴリ
 */
export type WebGLAnimationCategory =
  | 'fade'
  | 'pulse'
  | 'wave'
  | 'particle'
  | 'morph'
  | 'rotation'
  | 'parallax'
  | 'noise'
  | 'complex';

/**
 * WebGLアニメーション変化パターン
 */
export type WebGLChangePattern = 'continuous' | 'pulsed' | 'irregular';

/**
 * WebGLアニメーション特性
 */
export interface WebGLAnimationCharacteristics {
  averageChangeRate: number;
  peakChangeRate: number;
  changePattern: WebGLChangePattern;
  dominantColors?: string[] | undefined;
}

/**
 * WebGLアニメーションパターンデータ
 */
export interface WebGLAnimationPatternData {
  id: string;
  name: string;
  category: WebGLAnimationCategory;
  detectedLibrary?: string | undefined;
  canvasSelector: string;
  animationCharacteristics: WebGLAnimationCharacteristics;
  duration?: number | undefined;
  confidence: number;
}

/**
 * WebGLアニメーション検出サマリー（トップレベル用、detectionTimeMs含む）
 */
export interface WebGLAnimationSummaryResult {
  totalCanvasElements: number;
  animatedCanvasCount: number;
  detectedLibraries: string[];
  totalPatterns: number;
  detectionTimeMs: number;
}

/**
 * WebGLアニメーション検出サマリー（内部用、detectionTimeMs含まない）
 */
export interface WebGLAnimationSummaryInternal {
  totalCanvasElements: number;
  animatedCanvasCount: number;
  detectedLibraries: string[];
  totalPatterns: number;
}

/**
 * WebGLアニメーション検出結果（詳細）
 */
export interface WebGLAnimationFullResult {
  patterns: WebGLAnimationPatternData[];
  summary: WebGLAnimationSummaryInternal;
  detectionTimeMs: number;
}

// =====================================================
// Video/Runtime Mode 情報型定義（detection-modes.ts用）
// =====================================================

/**
 * Video Mode情報（detection_mode='video'時の結果）
 * motion/schemas.ts の VideoInfo と同等の型
 * Note: exactOptionalPropertyTypesに対応するため、optional propertyには| undefinedを付ける
 */
export interface VideoModeInfo {
  /** 録画URL */
  recorded_url: string;
  /** 録画時間（ms） */
  record_duration_ms: number;
  /** 動画ファイルサイズ（bytes） */
  video_size_bytes: number;
  /** 解析したフレーム数 */
  frames_analyzed: number;
  /** 検出されたモーションセグメント数 */
  motion_segments_detected: number;
  /** 処理時間（ms） */
  processing_time_ms: number;
  /** ビューポートサイズ */
  viewport?: {
    width: number;
    height: number;
  } | undefined;
  /** ページタイトル */
  page_title?: string | undefined;
  /** モーションカバレッジ（0-1） */
  motion_coverage?: number | undefined;
}

/**
 * Runtime Mode情報（detection_mode='runtime'時の結果）
 * motion/di-factories.ts の RuntimeInfo と同等の型
 * Note: exactOptionalPropertyTypesに対応するため、optional propertyには| undefinedを付ける
 */
export interface RuntimeModeInfo {
  /** 使用した待機時間（ms） */
  wait_time_used: number;
  /** キャプチャされたアニメーション数 */
  animations_captured: number;
  /** チェックしたスクロール位置（%） */
  scroll_positions_checked?: number[] | undefined;
  /** スクロール位置ごとのパターン数 */
  patterns_by_scroll_position?: Record<string, number> | undefined;
  /** スクロールパターン総数 */
  total_scroll_patterns?: number | undefined;
}

/**
 * モーション検出サービスの結果型
 */
export interface MotionServiceResult {
  success: boolean;
  patternCount: number;
  categoryBreakdown: Record<string, number>;
  warningCount: number;
  a11yWarningCount: number;
  perfWarningCount: number;
  processingTimeMs: number;
  patterns?: MotionPatternData[];
  warnings?: Array<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
  }>;
  error?: {
    code: string;
    message: string;
  };
  // === Video Mode 結果（FrameCaptureResult/FrameAnalysisResultを再利用） ===
  frame_capture?: FrameCaptureResult;
  frame_analysis?: FrameAnalysisResult;
  frame_capture_error?: {
    code: string;
    message: string;
  };
  frame_analysis_error?: {
    code: string;
    message: string;
  };
  // === JS Animation 結果 (v0.1.0) ===
  js_animation_summary?: JSAnimationSummaryResult;
  js_animations?: JSAnimationFullResult;
  js_animation_error?: {
    code: string;
    message: string;
  };
  /** Path A (handler) で保存済みのJSアニメーションパターン数 */
  jsSavedPatternCount?: number;
  // === WebGL Animation 結果 (v0.1.0) ===
  webgl_animation_summary?: WebGLAnimationSummaryResult;
  webgl_animations?: WebGLAnimationFullResult;
  webgl_animation_error?: {
    code: string;
    message: string;
  };
  // === Video/Runtime/Hybrid Mode 結果（page.analyze detection_mode統合 v0.1.0） ===
  /** Video Mode検出情報（detection_mode='video'/'hybrid'時） */
  video_info?: VideoModeInfo;
  /** Runtime Mode検出情報（detection_mode='runtime'/'hybrid'時） */
  runtime_info?: RuntimeModeInfo;
}

/**
 * 品質評価サービスの結果型
 */
export interface QualityServiceResult {
  success: boolean;
  overallScore: number;
  grade: Grade;
  axisScores: {
    originality: number;
    craftsmanship: number;
    contextuality: number;
  };
  clicheCount: number;
  processingTimeMs: number;
  axisGrades?: {
    originality: Grade;
    craftsmanship: Grade;
    contextuality: Grade;
  };
  axisDetails?: {
    originality: string[];
    craftsmanship: string[];
    contextuality: string[];
  };
  cliches?: Array<{
    type: string;
    description: string;
    severity: 'high' | 'medium' | 'low';
  }>;
  recommendations?: Array<{
    id: string;
    category: string;
    priority: 'high' | 'medium' | 'low';
    title: string;
    description: string;
  }>;
  error?: {
    code: string;
    message: string;
  };
}

// =====================================================
// DIインターフェース
// =====================================================

/**
 * モーション検出コンテキスト
 * DB保存に必要なPrismaクライアントとWebPage IDを保持
 */
export interface MotionDetectionContext {
  /** Prismaクライアント（DB保存時に必要） */
  prisma?: IPageAnalyzePrismaClient;
  /** WebPage ID（DB保存時に使用） */
  webPageId?: string;
  /** ソースURL（パターン保存時に使用） */
  sourceUrl?: string;
}

/**
 * モーション検出拡張コンテキスト
 * Vision解析用のスクリーンショットデータを含む
 */
export interface MotionDetectionExtendedContext extends MotionDetectionContext {
  /** Vision解析用スクリーンショット（base64エンコード、mimeType付き） */
  screenshot?: {
    base64: string;
    mimeType: 'image/png' | 'image/jpeg';
  };
  /**
   * layout_firstモードが有効かどうか
   * WebGL/3Dサイトでレイアウト抽出を優先し、モーション検出が軽量化される
   * @since v0.1.0
   */
  layoutFirstModeEnabled?: boolean;
}

/**
 * ページ分析サービスインターフェース（DI用）
 */
export interface IPageAnalyzeService {
  /** HTMLを取得（Playwrightなど） */
  fetchHtml?: (
    url: string,
    options: {
      timeout?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      viewport?: { width: number; height: number };
      includeComputedStyles?: boolean;
    }
  ) => Promise<{
    html: string;
    title?: string;
    description?: string;
    screenshot?: string;
    /** Computed Styles配列（includeComputedStyles=true時のみ） */
    computedStyles?: ComputedStyleInfo[];
  }>;
  /** レイアウト分析 */
  analyzeLayout?: (
    html: string,
    options: PageAnalyzeInput['layoutOptions'],
    /** Vision解析用スクリーンショート（useVision=true時に使用） */
    screenshot?: { base64: string; mimeType: string },
    /** Computed Styles配列（PageIngestAdapterから取得、htmlSnippetにインラインスタイルとして適用） */
    computedStyles?: ComputedStyleInfo[],
    /** 外部CSS解決用のベースURL */
    baseUrl?: string
  ) => Promise<LayoutServiceResult>;
  /** モーション検出 */
  detectMotion?: (
    html: string,
    url: string,
    options: PageAnalyzeInput['motionOptions'],
    /** DB保存コンテキスト（JSアニメーションパターンのDB保存に使用） */
    dbContext?: MotionDetectionContext,
    /** 拡張コンテキスト（Vision解析用スクリーンショート等） */
    extendedContext?: MotionDetectionExtendedContext,
    /** サニタイズ前のHTMLから抽出済みの外部CSS URL（DOMPurifyで<link>タグが除去される問題の回避策） */
    preExtractedCssUrls?: string[]
  ) => Promise<MotionServiceResult>;
  /** 品質評価 */
  evaluateQuality?: (
    html: string,
    options: PageAnalyzeInput['qualityOptions']
  ) => Promise<QualityServiceResult>;
}

// =====================================================
// Prisma データ型（共通化）
// =====================================================

/**
 * WebPage作成データ型
 */
export interface WebPageCreateData {
  id?: string | undefined;
  url: string;
  title?: string | undefined;
  htmlContent?: string | undefined;
  screenshotFullUrl?: string | undefined;
  sourceType: string;
  usageScope: string;
}

/**
 * WebPage更新データ型
 */
export interface WebPageUpdateData {
  title?: string | undefined;
  htmlContent?: string | undefined;
  screenshotFullUrl?: string | undefined;
  sourceType?: string | undefined;
  usageScope?: string | undefined;
  updatedAt?: Date | undefined;
}

/**
 * CSSフレームワークタイプ
 */
export type CssFrameworkType =
  | 'tailwind'
  | 'bootstrap'
  | 'css_modules'
  | 'styled_components'
  | 'vanilla'
  | 'unknown';

/**
 * CSSフレームワーク検出メタデータ
 */
export interface CssFrameworkMeta {
  confidence: number;
  evidence: string[];
}

/**
 * SectionPattern作成データ型
 */
export interface SectionPatternCreateData {
  id?: string | undefined;
  webPageId: string;
  sectionType: string;
  positionIndex: number;
  htmlSnippet?: string | undefined;
  /** CSSスニペット（style/link/inline styles） */
  cssSnippet?: string | undefined;
  /** CSSフレームワーク（tailwind, bootstrap, css_modules, styled_components, vanilla, unknown） */
  cssFramework?: string | undefined;
  /** CSSフレームワーク検出メタデータ（confidence, evidence） */
  cssFrameworkMeta?: CssFrameworkMeta | undefined;
  layoutInfo: unknown;
}

/**
 * MotionPattern作成データ型
 */
export interface MotionPatternCreateData {
  id?: string | undefined;
  /** WebPageへの参照（nullable: layoutSaveToDb=falseの場合はnull） */
  webPageId?: string | null | undefined;
  name: string;
  category: string;
  triggerType: string;
  triggerConfig?: unknown | undefined;
  animation: unknown;
  properties: unknown;
  implementation?: unknown | undefined;
  accessibility?: unknown | undefined;
  performance?: unknown | undefined;
  sourceUrl?: string | undefined;
  usageScope?: string | undefined;
  tags?: string[] | undefined;
  metadata?: unknown | undefined;
}

/**
 * QualityEvaluation作成データ型
 */
export interface QualityEvaluationCreateData {
  id?: string | undefined;
  targetType: string;
  targetId: string;
  overallScore: number;
  grade: string;
  antiAiCliche: unknown;
  designQuality?: unknown | undefined;
  technicalQuality?: unknown | undefined;
  recommendations?: string[] | undefined;
  evaluatorVersion: string;
  evaluationMode?: string | undefined;
}

// =====================================================
// JSAnimationPattern DB保存用型定義
// =====================================================

/**
 * JSアニメーションライブラリタイプ（Prisma ENUM対応）
 */
export type JSAnimationLibraryType =
  | 'gsap'
  | 'framer_motion'
  | 'anime_js'
  | 'three_js'
  | 'lottie'
  | 'web_animations_api'
  | 'unknown';

/**
 * JSアニメーションタイプ（Prisma ENUM対応）
 */
export type JSAnimationTypeEnum =
  | 'tween'
  | 'timeline'
  | 'spring'
  | 'physics'
  | 'keyframe'
  | 'morphing'
  | 'path'
  | 'scroll_driven'
  | 'gesture';

/**
 * JSAnimationPattern作成データ型
 * packages/database/prisma/schema.prisma の JSAnimationPattern モデルと同期
 */
export interface JSAnimationPatternCreateData {
  id?: string | undefined;
  webPageId?: string | null | undefined;
  libraryType: JSAnimationLibraryType;
  libraryVersion?: string | null | undefined;
  name: string;
  animationType: JSAnimationTypeEnum;
  description?: string | null | undefined;
  targetSelector?: string | null | undefined;
  targetCount?: number | null | undefined;
  targetTagNames?: string[] | undefined;
  durationMs?: number | null | undefined;
  delayMs?: number | null | undefined;
  easing?: string | null | undefined;
  iterations?: number | null | undefined;
  direction?: string | null | undefined;
  fillMode?: string | null | undefined;
  keyframes?: unknown | undefined;
  properties: unknown;
  triggerType?: string | null | undefined;
  triggerConfig?: unknown | undefined;
  cdpAnimationId?: string | null | undefined;
  cdpSourceType?: string | null | undefined;
  cdpPlayState?: string | null | undefined;
  cdpCurrentTime?: number | null | undefined;
  cdpStartTime?: number | null | undefined;
  cdpRawData?: unknown | undefined;
  librarySpecificData?: unknown | undefined;
  performance?: unknown | undefined;
  accessibility?: unknown | undefined;
  sourceUrl?: string | null | undefined;
  usageScope?: string | undefined;
  tags?: string[] | undefined;
  metadata?: unknown | undefined;
  confidence?: number | null | undefined;
}

/**
 * Prismaクライアントインターフェース
 * DB保存処理をテスト可能にするためのインターフェース
 *
 * NOTE: このインターフェースはPrismaスキーマ（packages/database/prisma/schema.prisma）の
 * WebPage, SectionPattern, MotionPattern, QualityEvaluation, JSAnimationPatternモデルと同期する必要があります
 */
export interface IPageAnalyzePrismaClient {
  webPage: {
    create: (args: { data: WebPageCreateData }) => Promise<{ id: string }>;
    upsert: (args: {
      where: { url: string };
      create: WebPageCreateData;
      update: WebPageUpdateData;
    }) => Promise<{ id: string }>;
  };
  sectionPattern: {
    create: (args: { data: SectionPatternCreateData }) => Promise<{ id: string }>;
    createMany: (args: { data: SectionPatternCreateData[] }) => Promise<{ count: number }>;
    deleteMany: (args: { where: { webPageId: string } }) => Promise<{ count: number }>;
  };
  motionPattern: {
    create: (args: { data: MotionPatternCreateData }) => Promise<{ id: string }>;
    createMany: (args: { data: MotionPatternCreateData[] }) => Promise<{ count: number }>;
  };
  qualityEvaluation: {
    create: (args: { data: QualityEvaluationCreateData }) => Promise<{ id: string }>;
  };
  jSAnimationPattern: {
    createMany: (args: {
      data: JSAnimationPatternCreateData[];
      skipDuplicates?: boolean;
    }) => Promise<{ count: number }>;
    deleteMany: (args: { where: { webPageId: string } }) => Promise<{ count: number }>;
    findMany: (args: { where: { webPageId: string } }) => Promise<Array<{ id: string }>>;
  };
  backgroundDesign: {
    deleteMany: (args: { where: { webPageId: string } }) => Promise<{ count: number }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
  jSAnimationEmbedding: {
    upsert: (args: {
      where: { jsAnimationPatternId: string };
      create: JSAnimationEmbeddingCreateData;
      update: JSAnimationEmbeddingUpdateData;
    }) => Promise<{ id: string }>;
    createMany: (args: {
      data: Array<{ jsAnimationPatternId: string; textRepresentation: string; modelVersion: string }>;
    }) => Promise<{ count: number }>;
  };
  $transaction: <T>(
    fn: (tx: IPageAnalyzePrismaClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
    }
  ) => Promise<T>;
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
}

// =====================================================
// JSAnimationEmbedding DB保存用型定義
// =====================================================

/**
 * JSAnimationEmbedding作成データ型
 * packages/database/prisma/schema.prisma の JSAnimationEmbedding モデルと同期
 */
export interface JSAnimationEmbeddingCreateData {
  id?: string | undefined;
  jsAnimationPatternId: string;
  textRepresentation: string;
  modelVersion: string;
}

/**
 * JSAnimationEmbedding更新データ型
 */
export interface JSAnimationEmbeddingUpdateData {
  textRepresentation?: string | undefined;
  modelVersion?: string | undefined;
  embeddingTimestamp?: Date | undefined;
}

// =====================================================
// ユーティリティ関数用型
// =====================================================

/**
 * 分析結果抽出用インターフェース
 */
export interface AnalysisResultForWarning {
  success: boolean;
  error?: { code: string; message: string };
}

// =====================================================
// 定数（デフォルト値）
// =====================================================

/** デフォルトスクリーンショット設定 */
export const DEFAULT_SCREENSHOT = {
  WIDTH: 1440,
  HEIGHT: 900,
  FORMAT: 'png' as const,
} as const;

/**
 * per-section Vision分析の最大セクション数
 * メモリ消費・処理時間を考慮し、20セクションに制限
 * 超過分は上位セクション（positionIndex順）のみ分析
 */
export const MAX_SECTIONS_FOR_PER_SECTION_VISION = 20;

// =====================================================
// Narrative 型定義（v0.1.0）
// =====================================================

/**
 * Narrative Handler入力型
 */
export interface NarrativeHandlerInput {
  /** サニタイズ済みHTML */
  html: string;
  /** Base64スクリーンショット（includeVision=true時に使用） */
  screenshot?: string;
  /** WebPage ID（DB保存時に必要） */
  webPageId?: string;
  /** Narrative分析オプション */
  narrativeOptions?: {
    enabled?: boolean;
    saveToDb?: boolean;
    includeVision?: boolean;
    visionTimeoutMs?: number;
    generateEmbedding?: boolean;
  };
  /** 既存分析結果（page.analyzeから渡される） */
  existingAnalysis?: {
    cssVariables?: unknown;
    motionPatterns?: unknown;
    sections?: unknown[];
    visualFeatures?: unknown;
  };
  /** 外部CSS（取得済みの場合） */
  externalCss?: string;
}

/**
 * Narrative Handler結果型
 */
export interface NarrativeHandlerResult {
  /** 成功フラグ */
  success: boolean;
  /** 分析をスキップしたか（enabled=false時） */
  skipped?: boolean;
  /** Narrative分析結果 */
  narrative?: {
    id?: string;
    webPageId?: string;
    worldView: {
      moodCategory: string;
      secondaryMoodCategory?: string;
      moodDescription: string;
      colorImpression: string;
      typographyPersonality: string;
      motionEmotion?: string;
      overallTone: string;
    };
    layoutStructure: {
      gridSystem: string;
      columnCount?: number;
      gutterWidth?: string;
      containerWidth?: string;
      visualHierarchy?: {
        primaryElements: string[];
        sectionFlow: 'linear' | 'modular' | 'asymmetric';
      };
      spacingRhythm?: {
        baseUnit: string;
        scale: number[];
      };
      whitespaceRatio?: number;
      visualDensity?: 'sparse' | 'balanced' | 'dense';
    };
    confidence: number;
    analyzedAt: string;
    processingTimeMs?: number;
    visionUsed?: boolean;
    fallbackReason?: string;
  };
  /** 保存されたNarrative ID（saveToDb=true時） */
  savedId?: string;
  /** 処理時間（ms） */
  processingTimeMs?: number;
  /** エラー情報 */
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Narrative Service Interface（DI用）
 */
export interface INarrativeService {
  analyze: (input: {
    html: string;
    screenshot?: string;
    webPageId?: string;
    externalCss?: string;
    existingAnalysis?: {
      cssVariables?: unknown;
      motionPatterns?: unknown;
      sections?: unknown[];
      visualFeatures?: unknown;
    };
    options?: {
      forceVision?: boolean;
      visionTimeoutMs?: number;
      generateEmbedding?: boolean;
    };
  }) => Promise<{
    worldView: {
      moodCategory: string;
      moodDescription: string;
      colorImpression: unknown;
      typographyPersonality: unknown;
      motionEmotion?: unknown;
      overallTone: unknown;
    };
    layoutStructure: {
      gridSystem: unknown;
      visualHierarchy: unknown;
      spacingRhythm: unknown;
      sectionRelationships: unknown[];
      graphicElements: unknown;
    };
    metadata: {
      textRepresentation: string;
      embedding?: number[];
      confidence: {
        overall: number;
        worldView: number;
        layoutStructure: number;
        breakdown: {
          visionAnalysis: number;
          cssStaticAnalysis: number;
          htmlStructureAnalysis: number;
          motionAnalysis: number;
        };
      };
      analysisTimeMs: number;
      visionUsed: boolean;
      fallbackReason?: string;
    };
  }>;
  save: (webPageId: string, result: unknown) => Promise<{
    id: string;
    webPageId: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
  analyzeAndSave: (input: unknown) => Promise<{
    id: string;
    webPageId: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
  isVisionAvailable?: () => Promise<boolean>;
}
