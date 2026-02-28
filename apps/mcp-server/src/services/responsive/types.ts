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
  viewportsAnalyzed: string[];
  differences: ResponsiveDifference[];
  breakpoints: string[];
  screenshots?: ViewportScreenshot[];
  analysisTimeMs: number;
}

/**
 * レスポンシブ解析オプション
 */
export interface ResponsiveAnalysisOptions {
  enabled: boolean;
  viewports?: ResponsiveViewport[];
  include_screenshots?: boolean;
  detect_navigation?: boolean;
  detect_visibility?: boolean;
  detect_layout?: boolean;
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
