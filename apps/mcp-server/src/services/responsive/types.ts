// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Analysis Types
 * レスポンシブ解析関連の型定義
 *
 * @module services/responsive/types
 */

/**
 * 名前付きビューポート設定
 */
export interface ResponsiveViewport {
  name: string;
  width: number;
  height: number;
}

/**
 * ナビゲーションタイプ
 */
export type NavigationType =
  | 'horizontal-menu'
  | 'hamburger-menu'
  | 'drawer'
  | 'bottom-nav'
  | 'tab-bar'
  | 'hidden'
  | 'other';

/**
 * 差異カテゴリ
 */
export type DifferenceCategory =
  | 'visibility'
  | 'layout'
  | 'navigation'
  | 'typography'
  | 'spacing'
  | 'order'
  | 'other';

/**
 * 要素の可視性情報
 */
export interface ElementVisibility {
  visible: boolean;
  type?: NavigationType;
  displayMode?: string;
  reason?: string;
}

/**
 * セマンティック要素のcomputedStyle情報（Phase 2: computedStyleベース検出）
 */
export interface SemanticElementInfo {
  /** 要素のCSSセレクタ（例: "header", "aside#sidebar"） */
  selector: string;
  /** タグ名 */
  tagName: string;
  /** display値 */
  display: string;
  /** visibility値 */
  visibility: string;
  /** opacity値 */
  opacity: number;
  /** グリッドカラム数（display: grid/inline-gridの場合） */
  gridColumns?: number;
  /** フレックス方向（display: flex/inline-flexの場合） */
  flexDirection?: string;
  /** BoundingRect */
  boundingRect?: { x: number; y: number; width: number; height: number };
}

/**
 * ブレークポイント解像度モード
 */
export type BreakpointResolution = 'range' | 'precise';

/**
 * レスポンシブ差異アイテム
 */
export interface ResponsiveDifference {
  element: string;
  description?: string;
  category: DifferenceCategory;
  desktop?: Record<string, unknown>;
  tablet?: Record<string, unknown>;
  mobile?: Record<string, unknown>;
}

/**
 * ビューポート別スクリーンショット
 */
export interface ViewportScreenshot {
  name: string;
  width: number;
  height: number;
  screenshot?: {
    base64: string;
    format: 'png' | 'jpeg';
    width: number;
    height: number;
  };
}

/**
 * ビューポートキャプチャ結果
 */
export interface ViewportCaptureResult {
  viewport: ResponsiveViewport;
  html: string;
  screenshot?: ViewportScreenshot;
  layoutInfo: ViewportLayoutInfo;
  navigationInfo: NavigationInfo;
  error?: string;
}

/**
 * ビューポートごとのレイアウト情報
 */
export interface ViewportLayoutInfo {
  /** ドキュメント幅 */
  documentWidth: number;
  /** ドキュメント高さ */
  documentHeight: number;
  /** ビューポート幅 */
  viewportWidth: number;
  /** ビューポート高さ */
  viewportHeight: number;
  /** スクロール高さ */
  scrollHeight: number;
  /** 検出されたブレークポイント（CSSから抽出） */
  breakpoints: string[];
  /** グリッドカラム数 */
  gridColumns?: number;
  /** フレックス方向 */
  flexDirection?: string;
  /** タイポグラフィ情報 */
  typography?: {
    h1FontSize: number;
    bodyFontSize: number;
    bodyLineHeight: number;
  };
  /** スペーシング情報 */
  spacing?: {
    bodyPadding: { top: number; right: number; bottom: number; left: number };
    mainContainerPadding?: { top: number; right: number; bottom: number; left: number };
  };
  /** セマンティック要素のcomputedStyle情報（Phase 2） */
  semanticElements?: SemanticElementInfo[];
  /** 拡張タイポグラフィ情報（h1-h6, p:first-of-type）（Phase 4） */
  extendedTypography?: {
    headings: Array<{ tag: string; fontSize: number }>;
    pFirstOfType?: number;
  };
  /** セクション間スペーシング（Phase 4） */
  sectionSpacing?: Array<{ selector: string; marginTop: number; marginBottom: number }>;
}

/**
 * ナビゲーション情報
 */
export interface NavigationInfo {
  /** ナビゲーションタイプ */
  type: NavigationType;
  /** ハンバーガーメニューが存在するか */
  hasHamburgerMenu: boolean;
  /** 水平メニューが存在するか */
  hasHorizontalMenu: boolean;
  /** ボトムナビゲーションが存在するか */
  hasBottomNav: boolean;
  /** ナビゲーション要素のセレクタ */
  selector?: string;
}

/**
 * レスポンシブ解析結果
 */
export interface ResponsiveAnalysisResult {
  viewportsAnalyzed: ResponsiveViewport[];
  differences: ResponsiveDifference[];
  breakpoints: string[];
  screenshots?: ViewportScreenshot[];
  /** ビューポート間の視覚的差分（スクリーンショット有効時のみ） */
  viewportDiffs?: ViewportDiffResult[];
  analysisTimeMs: number;
}

/**
 * レスポンシブ解析オプション
 */
export interface ResponsiveAnalysisOptions {
  enabled: boolean;
  viewports?: ResponsiveViewport[];
  include_screenshots?: boolean;
  /** ビューポート差分画像を結果に含めるか */
  include_diff_images?: boolean;
  /** ビューポート差分の閾値（0-1、デフォルト0.1） */
  diff_threshold?: number;
  detect_navigation?: boolean;
  detect_visibility?: boolean;
  detect_layout?: boolean;
  /** ブレークポイント解像度（'range': CSSメディアクエリ + VP差分推定, 'precise': 二分探索で±8px特定） */
  breakpoint_resolution?: BreakpointResolution;
  /** robots.txt の crawl-delay（ミリ秒）。指定時はビューポートキャプチャ間に遅延を挿入 */
  crawlDelayMs?: number;
}

/**
 * マルチビューポートキャプチャオプション
 */
export interface MultiViewportCaptureOptions {
  /** キャプチャ対象のビューポート配列 */
  viewports: ResponsiveViewport[];
  /** スクリーンショットを含めるか */
  includeScreenshots: boolean;
  /** タイムアウト（ms） */
  timeout: number;
  /** フルページスクリーンショット */
  fullPage?: boolean;
  /** ページ読み込み完了判定 */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /** DOM安定化待機 */
  waitForDomStable?: boolean;
  /** DOM安定化タイムアウト */
  domStableTimeout?: number;
  /** robots.txt の crawl-delay（ミリ秒）。2回目以降のキャプチャ前に遅延を挿入 */
  crawlDelayMs?: number;
}

/**
 * ナビゲーション検出オプション
 */
export interface NavigationDetectionOptions {
  /** ナビゲーション要素のセレクタ候補 */
  navSelectors?: string[];
  /** ハンバーガーメニューのセレクタ候補 */
  hamburgerSelectors?: string[];
}

/**
 * 可視性検出オプション
 */
export interface VisibilityDetectionOptions {
  /** 監視対象の要素セレクタ */
  targetSelectors?: string[];
  /** 特定の要素クラスを除外 */
  excludeClasses?: string[];
}

/**
 * レイアウト検出オプション
 */
export interface LayoutDetectionOptions {
  /** グリッドコンテナのセレクタ候補 */
  gridSelectors?: string[];
  /** フレックスコンテナのセレクタ候補 */
  flexSelectors?: string[];
}

/**
 * タッチターゲット違反要素
 */
export interface TouchTargetFailedElement {
  /** 要素のCSSセレクタ */
  selector: string;
  /** 要素の幅 (px) */
  width: number;
  /** 要素の高さ (px) */
  height: number;
}

/**
 * タッチターゲット検出結果
 */
export interface TouchTargetResult {
  /** 基準を満たした要素数 */
  passed: number;
  /** 基準を満たさなかった要素数 */
  failed: number;
  /** 基準を満たさなかった要素の詳細 */
  failedElements: TouchTargetFailedElement[];
}

/**
 * モバイル読みやすさ評価結果
 */
export interface ReadabilityResult {
  /** フォントサイズが基準以上か (>= 16px) */
  fontSizeOk: boolean;
  /** 行長が基準以下か (<= 80文字) */
  lineLengthOk: boolean;
  /** 行高さが基準以上か (>= 1.5) */
  lineHeightOk: boolean;
  /** 計測値の詳細 */
  details: {
    minFontSize: number;
    avgLineLength: number;
    avgLineHeight: number;
    sampleCount: number;
  };
}

/**
 * コンテンツオーバーフロー検出結果
 */
export interface OverflowResult {
  /** 水平スクロールが発生しているか */
  horizontalScroll: boolean;
  /** オーバーフローしている要素のセレクタ */
  overflowElements: string[];
}

/**
 * レスポンシブ画像チェック結果
 */
export interface ResponsiveImageResult {
  /** srcset属性を持つ画像数 */
  srcsetCount: number;
  /** picture要素数 */
  pictureCount: number;
  /** レスポンシブ対応していない画像数 */
  missingResponsive: number;
}

/**
 * ビューポートごとの品質評価結果
 */
export interface ViewportQualityResult {
  viewport: ResponsiveViewport;
  touchTargets: TouchTargetResult;
  readability: ReadabilityResult;
  overflow: OverflowResult;
  images: ResponsiveImageResult;
}

/**
 * レスポンシブ品質評価結果
 */
export interface ResponsiveQualityResult {
  viewportResults: ViewportQualityResult[];
  /** 総合スコア (0-100) */
  overallScore: number;
  /** 評価時間 (ms) */
  evaluationTimeMs: number;
}

/**
 * レスポンシブ品質評価オプション
 */
export interface ResponsiveQualityEvaluationOptions {
  /** 評価対象のビューポート */
  viewports?: ResponsiveViewport[];
  /** 実行するチェック項目の選択 */
  checks?: {
    touchTargets?: boolean;
    readability?: boolean;
    overflow?: boolean;
    images?: boolean;
  };
  /** タイムアウト (ms) */
  timeout?: number;
}

/**
 * ビューポート間の視覚的差分結果
 */
export interface ViewportDiffResult {
  /** 比較元ビューポート名 */
  viewport1: string;
  /** 比較先ビューポート名 */
  viewport2: string;
  /** 差分率 (0-100) */
  diffPercentage: number;
  /** 差分ピクセル数 */
  diffPixelCount: number;
  /** 総ピクセル数 */
  totalPixels: number;
  /** 比較時の幅 */
  comparedWidth: number;
  /** 比較時の高さ */
  comparedHeight: number;
  /** 差分画像バッファ（include_diff_images: true の場合のみ） */
  diffImageBuffer?: Buffer;
}
