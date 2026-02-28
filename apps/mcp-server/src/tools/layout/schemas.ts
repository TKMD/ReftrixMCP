// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.* MCP Tools Zod Schema Definitions
 * Webデザインレイアウト解析ツールの入力/出力バリデーションスキーマ
 *
 * @module @reftrix/mcp-server/tools/layout/schemas
 *
 * 対応ツール:
 * - layout.ingest: URLからWebページを取得しレイアウト解析用データを準備
 * - layout.inspect: HTMLを解析しセクション・グリッド・タイポグラフィを抽出
 * - layout.search: レイアウトパターンをセマンティック検索
 * - layout.generate_code: パターンからReact/Vue/HTMLコードを生成
 * - layout.batch_ingest: 複数URLを一括取得しレイアウト解析用データを準備
 */
import { z } from 'zod';
import {
  moodFilterSchema,
  brandToneFilterSchema,
} from '../../schemas/mood-brandtone-filters';

// ============================================================================
// Enum Schemas
// ============================================================================

/**
 * ソースタイプ
 * - award_gallery: アワードサイトからの収集
 * - user_provided: ユーザーが提供
 */
export const sourceTypeSchema = z.enum(['award_gallery', 'user_provided']);
export type SourceType = z.infer<typeof sourceTypeSchema>;

/**
 * 利用範囲
 * - inspiration_only: インスピレーションのみ（商用利用不可）
 * - owned_asset: 所有アセット（商用利用可）
 */
export const usageScopeSchema = z.enum(['inspiration_only', 'owned_asset']);
export type UsageScope = z.infer<typeof usageScopeSchema>;

/**
 * セクションタイプ（検索用 - unknownを除外）
 * Webページの主要セクションタイプ
 *
 * 基本タイプ（10種）:
 * - hero: ヒーローセクション
 * - feature: 機能・特徴紹介
 * - cta: コールトゥアクション
 * - testimonial: お客様の声
 * - pricing: 料金プラン
 * - footer: フッター
 * - navigation: ナビゲーション
 * - about: 会社・サービス紹介
 * - contact: お問い合わせ
 * - gallery: ギャラリー
 *
 * 拡張タイプ（8種）:
 * - partners: パートナー・クライアントロゴ
 * - portfolio: ポートフォリオ・実績
 * - team: チーム・メンバー紹介
 * - stories: ストーリー・事例紹介
 * - research: リサーチ・調査結果
 * - subscribe: 購読・ニュースレター登録
 * - stats: 統計・数値実績
 * - faq: よくある質問
 */
export const sectionTypeForSearchSchema = z.enum([
  // 基本タイプ（10種）
  'hero',
  'feature',
  'cta',
  'testimonial',
  'pricing',
  'footer',
  'navigation',
  'about',
  'contact',
  'gallery',
  // 拡張タイプ（8種）
  'partners',
  'portfolio',
  'team',
  'stories',
  'research',
  'subscribe',
  'stats',
  'faq',
]);
export type SectionTypeForSearch = z.infer<typeof sectionTypeForSearchSchema>;

/**
 * フレームワーク
 * コード生成時のターゲットフレームワーク
 */
export const frameworkSchema = z.enum(['react', 'vue', 'html']);
export type Framework = z.infer<typeof frameworkSchema>;

/**
 * ソート対象フィールド
 */
export const sortBySchema = z.enum(['createdAt', 'usageCount', 'quality']);
export type SortBy = z.infer<typeof sortBySchema>;

/**
 * ソート順序
 */
export const sortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof sortOrderSchema>;

// ============================================================================
// layout.ingest Schemas
// ============================================================================

/**
 * ビューポート設定スキーマ
 *
 * @property width - 幅（320-4096px）
 * @property height - 高さ（240-16384px）
 */
export const viewportSchema = z.object({
  width: z
    .number()
    .int({ message: 'widthは整数である必要があります' })
    .min(320, { message: 'widthは320以上4096以下である必要があります' })
    .max(4096, { message: 'widthは320以上4096以下である必要があります' }),
  height: z
    .number()
    .int({ message: 'heightは整数である必要があります' })
    .min(240, { message: 'heightは240以上16384以下である必要があります' })
    .max(16384, { message: 'heightは240以上16384以下である必要があります' }),
});
export type Viewport = z.infer<typeof viewportSchema>;

// ============================================================================
// Responsive Viewport Schemas (v0.1.0)
// ============================================================================

/**
 * 名前付きビューポートスキーマ
 * マルチビューポートキャプチャ用
 *
 * @property name - ビューポート名（desktop/tablet/mobile等）
 * @property width - 幅（320-4096px）
 * @property height - 高さ（240-16384px）
 */
export const responsiveViewportSchema = z.object({
  name: z
    .string()
    .min(1, { message: 'nameは1文字以上必要です' })
    .max(50, { message: 'nameは50文字以下にしてください' }),
  width: z
    .number()
    .int({ message: 'widthは整数である必要があります' })
    .min(320, { message: 'widthは320以上4096以下である必要があります' })
    .max(4096, { message: 'widthは320以上4096以下である必要があります' }),
  height: z
    .number()
    .int({ message: 'heightは整数である必要があります' })
    .min(240, { message: 'heightは240以上16384以下である必要があります' })
    .max(16384, { message: 'heightは240以上16384以下である必要があります' }),
});
export type ResponsiveViewport = z.infer<typeof responsiveViewportSchema>;

/**
 * デフォルトビューポートプリセット
 * - desktop: 1920x1080 (Full HD)
 * - tablet: 768x1024 (iPad Portrait)
 * - mobile: 375x667 (iPhone SE)
 */
export const DEFAULT_VIEWPORTS: ResponsiveViewport[] = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 667 },
];

/**
 * ナビゲーションタイプ
 * レスポンシブデザインでのナビゲーション表示パターン
 */
export const navigationTypeSchema = z.enum([
  'horizontal-menu',   // 水平メニュー（デスクトップ向け）
  'hamburger-menu',    // ハンバーガーメニュー（モバイル向け）
  'drawer',            // ドロワーメニュー
  'bottom-nav',        // ボトムナビゲーション
  'tab-bar',           // タブバー
  'hidden',            // 非表示
  'other',             // その他
]);
export type NavigationType = z.infer<typeof navigationTypeSchema>;

/**
 * 要素の可視性情報スキーマ
 */
export const elementVisibilitySchema = z.object({
  visible: z.boolean(),
  type: navigationTypeSchema.optional(),
  displayMode: z.string().optional(), // CSS display値
  reason: z.string().optional(), // 非表示の理由（display:none, visibility:hidden等）
});
export type ElementVisibility = z.infer<typeof elementVisibilitySchema>;

/**
 * レスポンシブ差異アイテムスキーマ
 * 各ビューポート間での要素の差異を記録
 *
 * @property element - CSSセレクタ
 * @property description - 差異の説明
 * @property category - 差異のカテゴリ
 */
export const responsiveDifferenceSchema = z.object({
  element: z.string(),
  description: z.string().optional(),
  category: z.enum([
    'visibility',       // 表示/非表示の変化
    'layout',           // レイアウト構造の変化
    'navigation',       // ナビゲーションパターンの変化
    'typography',       // タイポグラフィの変化
    'spacing',          // 間隔の変化
    'order',            // 要素順序の変化
    'other',            // その他
  ]),
  desktop: z.record(z.unknown()).optional(),
  tablet: z.record(z.unknown()).optional(),
  mobile: z.record(z.unknown()).optional(),
});
export type ResponsiveDifference = z.infer<typeof responsiveDifferenceSchema>;

/**
 * ビューポート別スクリーンショットスキーマ
 */
export const viewportScreenshotSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  screenshot: z.object({
    base64: z.string(),
    format: z.enum(['png', 'jpeg']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).optional(),
});
export type ViewportScreenshot = z.infer<typeof viewportScreenshotSchema>;

/**
 * レスポンシブ解析結果スキーマ
 * layout.ingestのレスポンシブ解析結果
 *
 * @property viewportsAnalyzed - 解析したビューポート名配列
 * @property differences - 検出された差異配列
 * @property breakpoints - 検出されたブレークポイント
 * @property screenshots - ビューポート別スクリーンショット
 */
export const responsiveAnalysisSchema = z.object({
  viewportsAnalyzed: z.array(z.string()),
  differences: z.array(responsiveDifferenceSchema),
  breakpoints: z.array(z.string()),
  screenshots: z.array(viewportScreenshotSchema).optional(),
  analysisTimeMs: z.number().nonnegative().optional(),
});
export type ResponsiveAnalysis = z.infer<typeof responsiveAnalysisSchema>;

/**
 * レスポンシブ解析オプションスキーマ
 *
 * @property enabled - レスポンシブ解析を有効化（デフォルトfalse）
 * @property viewports - カスタムビューポート配列（省略時はデフォルト3種）
 * @property include_screenshots - 各ビューポートのスクリーンショットを含める（デフォルトtrue）
 * @property detect_navigation - ナビゲーションパターン検出（デフォルトtrue）
 * @property detect_visibility - 要素の表示/非表示変化検出（デフォルトtrue）
 * @property detect_layout - レイアウト構造変化検出（デフォルトtrue）
 */
export const responsiveAnalysisOptionsSchema = z.object({
  enabled: z.boolean().optional().default(false),
  viewports: z
    .array(responsiveViewportSchema)
    .min(1, { message: 'viewportsは1つ以上指定してください' })
    .max(10, { message: 'viewportsは10個以下にしてください' })
    .optional(),
  include_screenshots: z.boolean().optional().default(true),
  detect_navigation: z.boolean().optional().default(true),
  detect_visibility: z.boolean().optional().default(true),
  detect_layout: z.boolean().optional().default(true),
});
export type ResponsiveAnalysisOptions = z.infer<typeof responsiveAnalysisOptionsSchema>;

/**
 * layout.ingest オプションスキーマ
 *
 * @property fullPage - フルページキャプチャ（デフォルトtrue）
 * @property viewport - ビューポート設定（オプション）
 * @property waitForSelector - 待機セレクタ（オプション）
 * @property timeout - タイムアウト（1000-120000ms、デフォルト30000）
 * @property disableJavaScript - JavaScript無効化（デフォルトfalse）
 * @property include_html - HTMLを返却に含めるか（デフォルトfalse）
 * @property include_screenshot - スクリーンショットを返却に含めるか（デフォルトfalse）
 * @property truncate_html_bytes - HTMLを切り詰めるバイト数（100-10000000、オプション）
 * @property screenshot_format - スクリーンショット形式（png/jpeg、デフォルトpng）
 * @property screenshot_quality - JPEG品質（1-100、オプション）
 * @property screenshot_max_width - スクリーンショット最大幅（オプション）
 * @property screenshot_max_height - スクリーンショット最大高さ（オプション）
 * @property auto_optimize - レスポンス自動最適化（デフォルトfalse）
 * @property response_size_limit - レスポンスサイズ上限（10000-50000000、オプション）
 * @property wait_until - ページ読み込み完了判定（load/domcontentloaded/networkidle、デフォルトload）
 */
export const layoutIngestOptionsSchema = z.object({
  // snake_case parameters (MCP standard)
  full_page: z.boolean().optional().default(true),
  viewport: viewportSchema.optional(),
  wait_for_selector: z.string().optional(),
  wait_until: z
    .enum(['load', 'domcontentloaded', 'networkidle'])
    .optional()
    .default('load'),
  /** DOM安定化待機（React/Vue/Next.js対応、デフォルトtrue） */
  wait_for_dom_stable: z.boolean().optional().default(true),
  /** DOM安定化判定の無変更時間（ms）（デフォルト500） */
  dom_stable_timeout: z
    .number()
    .int({ message: 'dom_stable_timeoutは整数である必要があります' })
    .min(100, { message: 'dom_stable_timeoutは100以上5000以下である必要があります' })
    .max(5000, { message: 'dom_stable_timeoutは100以上5000以下である必要があります' })
    .optional()
    .default(500),
  /** ローディング完了後の追加待機時間（ms）（0-30000） */
  wait_for_timeout: z
    .number()
    .int({ message: 'wait_for_timeoutは整数である必要があります' })
    .min(0, { message: 'wait_for_timeoutは0以上30000以下である必要があります' })
    .max(30000, { message: 'wait_for_timeoutは0以上30000以下である必要があります' })
    .optional(),
  /** 非表示待機セレクター（ローディング要素など） */
  wait_for_selector_hidden: z.string().optional(),
  timeout: z
    .number()
    .int({ message: 'timeoutは整数である必要があります' })
    .min(1000, { message: 'timeoutは1000以上120000以下である必要があります' })
    .max(120000, { message: 'timeoutは1000以上120000以下である必要があります' })
    .optional()
    .default(30000),
  disable_javascript: z.boolean().optional().default(false),
  // レスポンス最適化オプション（DB-first: レスポンスサイズ削減）
  include_html: z.boolean().optional().default(false),
  include_screenshot: z.boolean().optional().default(false),
  truncate_html_bytes: z
    .number()
    .int({ message: 'truncate_html_bytesは整数である必要があります' })
    .min(100, { message: 'truncate_html_bytesは100以上10000000以下である必要があります' })
    .max(10000000, { message: 'truncate_html_bytesは100以上10000000以下である必要があります' })
    .optional(),
  screenshot_format: z.enum(['png', 'jpeg']).optional().default('png'),
  screenshot_quality: z
    .number()
    .int({ message: 'screenshot_qualityは整数である必要があります' })
    .min(1, { message: 'screenshot_qualityは1以上100以下である必要があります' })
    .max(100, { message: 'screenshot_qualityは1以上100以下である必要があります' })
    .optional(),
  screenshot_max_width: z
    .number()
    .int({ message: 'screenshot_max_widthは整数である必要があります' })
    .min(1, { message: 'screenshot_max_widthは1以上16384以下である必要があります' })
    .max(16384, { message: 'screenshot_max_widthは1以上16384以下である必要があります' })
    .optional(),
  screenshot_max_height: z
    .number()
    .int({ message: 'screenshot_max_heightは整数である必要があります' })
    .min(1, { message: 'screenshot_max_heightは1以上16384以下である必要があります' })
    .max(16384, { message: 'screenshot_max_heightは1以上16384以下である必要があります' })
    .optional(),
  auto_optimize: z.boolean().optional().default(false),
  response_size_limit: z
    .number()
    .int({ message: 'response_size_limitは整数である必要があります' })
    .min(10000, { message: 'response_size_limitは10000以上50000000以下である必要があります' })
    .max(50000000, { message: 'response_size_limitは10000以上50000000以下である必要があります' })
    .optional(),
  // DB保存オプション（DB-first: デフォルトで保存）
  save_to_db: z.boolean().optional().default(true),
  // 自動解析オプション（DB-first: Embedding自動生成）
  auto_analyze: z.boolean().optional().default(true),
  // Computed Stylesオプション
  include_computed_styles: z.boolean().optional().default(false),
  // 外部CSS取得オプション
  /** 外部CSSファイルの内容を取得するか（デフォルト: true） */
  fetch_external_css: z.boolean().optional().default(true),
  /** 外部CSS取得のタイムアウト（ミリ秒、デフォルト: 5000） */
  external_css_timeout: z
    .number()
    .int({ message: 'external_css_timeoutは整数である必要があります' })
    .min(1000, { message: 'external_css_timeoutは1000以上30000以下である必要があります' })
    .max(30000, { message: 'external_css_timeoutは1000以上30000以下である必要があります' })
    .optional()
    .default(5000),
  /** 外部CSS1ファイルあたりの最大サイズ（バイト、デフォルト: 5MB） */
  external_css_max_size: z
    .number()
    .int({ message: 'external_css_max_sizeは整数である必要があります' })
    .min(1024, { message: 'external_css_max_sizeは1024以上10485760以下である必要があります' })
    .max(10485760, { message: 'external_css_max_sizeは1024以上10485760以下である必要があります' })
    .optional()
    .default(5242880),
  /** 外部CSS取得の最大並列数（デフォルト: 5） */
  external_css_max_concurrent: z
    .number()
    .int({ message: 'external_css_max_concurrentは整数である必要があります' })
    .min(1, { message: 'external_css_max_concurrentは1以上10以下である必要があります' })
    .max(10, { message: 'external_css_max_concurrentは1以上10以下である必要があります' })
    .optional()
    .default(5),
  /** 外部CSS取得の最大ファイル数（デフォルト: 20） */
  external_css_max_files: z
    .number()
    .int({ message: 'external_css_max_filesは整数である必要があります' })
    .min(1, { message: 'external_css_max_filesは1以上50以下である必要があります' })
    .max(50, { message: 'external_css_max_filesは1以上50以下である必要があります' })
    .optional()
    .default(20),
  /**
   * WebGLを完全に無効化
   * 重い3Dサイト（Three.js、WebGL等）でタイムアウトが発生する場合に使用
   * true設定時: 専用ブラウザインスタンスを起動し、WebGL関連機能を無効化
   * @default false
   */
  disable_webgl: z.boolean().optional().default(false),
  /**
   * タイムアウト時にブラウザプロセスを強制終了
   * WebGLサイトでハングした場合の最終手段として使用
   * @default false
   */
  force_kill_on_timeout: z.boolean().optional().default(false),
  /**
   * レスポンシブ解析オプション
   * 複数ビューポートでのレイアウト差異を検出
   * @see responsiveAnalysisOptionsSchema
   */
  responsive: responsiveAnalysisOptionsSchema.optional(),
});
export type LayoutIngestOptions = z.infer<typeof layoutIngestOptionsSchema>;

/**
 * layout.ingest 入力スキーマ
 *
 * @property url - 取得対象URL（必須）
 * @property source_type - ソースタイプ（デフォルトuser_provided）
 * @property usage_scope - 利用範囲（デフォルトinspiration_only）
 * @property options - オプション設定（オプション）
 */
export const layoutIngestInputSchema = z.object({
  url: z.string().url({ message: '有効なURL形式を指定してください' }),
  source_type: sourceTypeSchema.optional().default('user_provided'),
  usage_scope: usageScopeSchema.optional().default('inspiration_only'),
  options: layoutIngestOptionsSchema.optional(),
  /** robots.txtを尊重するかどうか（RFC 9309）。falseで無視 */
  respect_robots_txt: z.boolean().optional(),
});
export type LayoutIngestInput = z.infer<typeof layoutIngestInputSchema>;

/**
 * スクリーンショット情報スキーマ
 */
export const screenshotInfoSchema = z.object({
  base64: z.string(),
  format: z.enum(['png', 'jpeg']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ScreenshotInfo = z.infer<typeof screenshotInfoSchema>;

/**
 * 要素のComputed Stylesスキーマ
 * 取得するCSSプロパティのセット
 */
export const elementComputedStylesSchema = z.object({
  // 背景
  backgroundColor: z.string(),
  backgroundImage: z.string(),
  // テキスト
  color: z.string(),
  fontSize: z.string(),
  fontFamily: z.string(),
  fontWeight: z.string(),
  lineHeight: z.string(),
  letterSpacing: z.string(),
  textAlign: z.string(),
  textDecoration: z.string(),
  textTransform: z.string(),
  // レイアウト
  display: z.string(),
  position: z.string(),
  flexDirection: z.string(),
  justifyContent: z.string(),
  alignItems: z.string(),
  padding: z.string(),
  paddingTop: z.string(),
  paddingRight: z.string(),
  paddingBottom: z.string(),
  paddingLeft: z.string(),
  margin: z.string(),
  marginTop: z.string(),
  marginRight: z.string(),
  marginBottom: z.string(),
  marginLeft: z.string(),
  gap: z.string(),
  width: z.string(),
  height: z.string(),
  maxWidth: z.string(),
  minHeight: z.string(),
  // 視覚効果
  border: z.string(),
  borderRadius: z.string(),
  boxShadow: z.string(),
  backdropFilter: z.string(),
  opacity: z.string(),
  overflow: z.string(),
  // トランジション・アニメーション
  transition: z.string(),
  transform: z.string(),
});
export type ElementComputedStyles = z.infer<typeof elementComputedStylesSchema>;

/**
 * 子要素のComputed Styles情報スキーマ
 */
export const childElementStyleInfoSchema = z.object({
  /** CSSセレクタ（ユニーク識別用） */
  selector: z.string(),
  /** HTML要素タグ名 */
  tagName: z.string(),
  /** class属性値 */
  className: z.string(),
  /** 親セクションからの相対パス */
  path: z.string(),
  /** 要素のテキストコンテンツ（ボタンやリンクの場合） */
  textContent: z.string().optional(),
  /** Computed Styles */
  styles: elementComputedStylesSchema,
});
export type ChildElementStyleInfo = z.infer<typeof childElementStyleInfoSchema>;

/**
 * Computed Styles情報スキーマ
 * ブラウザがレンダリングした実際のスタイル値
 */
export const computedStyleInfoSchema = z.object({
  /** セクションのインデックス */
  index: z.number().int().nonnegative(),
  /** HTML要素タグ名 */
  tagName: z.string(),
  /** class属性値 */
  className: z.string(),
  /** id属性値 */
  id: z.string(),
  /** role属性値 */
  role: z.string(),
  /** セクション自体のComputed Styles */
  styles: elementComputedStylesSchema,
  /** セクション内の子要素のスタイル（重要な要素のみ） */
  children: z.array(childElementStyleInfoSchema).optional(),
});
export type ComputedStyleInfo = z.infer<typeof computedStyleInfoSchema>;

/**
 * ページメタデータ出力スキーマ
 */
export const pageMetadataOutputSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  favicon: z.string().optional(),
  ogImage: z.string().optional(),
});
export type PageMetadataOutput = z.infer<typeof pageMetadataOutputSchema>;

/**
 * ソース情報出力スキーマ
 */
export const sourceInfoOutputSchema = z.object({
  type: sourceTypeSchema,
  usageScope: usageScopeSchema,
});
export type SourceInfoOutput = z.infer<typeof sourceInfoOutputSchema>;

/**
 * layout.ingest 成功レスポンスデータスキーマ
 * htmlとscreenshotはinclude_html/include_screenshotオプションに応じて省略可能
 */
export const layoutIngestDataSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  normalizedUrl: z.string().url(),
  html: z.string().optional(), // include_html: false で省略
  screenshot: screenshotInfoSchema.optional(), // include_screenshot: false で省略
  computedStyles: z.array(computedStyleInfoSchema).optional(), // include_computed_styles: true で取得
  metadata: pageMetadataOutputSchema,
  source: sourceInfoOutputSchema,
  crawledAt: z.string().datetime(),
  // DB保存ステータス
  savedToDb: z.boolean().optional(), // save_to_db: true 時のみ true
  // レスポンシブ解析結果（responsive.enabled: true 時のみ）
  responsiveAnalysis: responsiveAnalysisSchema.optional(),
});
export type LayoutIngestData = z.infer<typeof layoutIngestDataSchema>;

/**
 * layout.ingest エラー情報スキーマ
 */
export const layoutIngestErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type LayoutIngestErrorInfo = z.infer<typeof layoutIngestErrorInfoSchema>;

/**
 * layout.ingest 成功レスポンススキーマ
 */
export const layoutIngestSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: layoutIngestDataSchema,
});

/**
 * layout.ingest 失敗レスポンススキーマ
 */
export const layoutIngestErrorOutputSchema = z.object({
  success: z.literal(false),
  error: layoutIngestErrorInfoSchema,
});

/**
 * layout.ingest 出力スキーマ（統合）
 */
export const layoutIngestOutputSchema = z.discriminatedUnion('success', [
  layoutIngestSuccessOutputSchema,
  layoutIngestErrorOutputSchema,
]);
export type LayoutIngestOutput = z.infer<typeof layoutIngestOutputSchema>;

/**
 * layout.ingest シンプル出力スキーマ（後方互換用）
 * @deprecated layoutIngestOutputSchema を使用してください
 */
export const layoutIngestSimpleOutputSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  title: z.string().optional(),
  screenshotUrl: z.string().url().optional(),
  htmlSize: z.number().int().nonnegative(),
  sectionsDetected: z.number().int().nonnegative(),
  ingestedAt: z.string().datetime(),
});
export type LayoutIngestSimpleOutput = z.infer<typeof layoutIngestSimpleOutputSchema>;

// ============================================================================
// layout.inspect Schemas
// ============================================================================

/**
 * layout.inspect オプションスキーマ
 *
 * @property detectSections - セクション検出（デフォルトtrue）
 * @property extractColors - 色抽出（デフォルトtrue）
 * @property analyzeTypography - タイポグラフィ解析（デフォルトtrue）
 * @property detectGrid - グリッド検出（デフォルトtrue）
 */
export const layoutInspectOptionsSchema = z.object({
  detectSections: z.boolean().optional().default(true),
  extractColors: z.boolean().optional().default(true),
  analyzeTypography: z.boolean().optional().default(true),
  detectGrid: z.boolean().optional().default(true),
});
export type LayoutInspectOptions = z.infer<typeof layoutInspectOptionsSchema>;

/**
 * layout.inspect 入力スキーマ
 *
 * @property id - WebページID（UUID形式、htmlと排他）
 * @property html - HTMLコンテンツ（最大10MB、idと排他）
 * @property options - オプション設定（オプション）
 *
 * バリデーション: idまたはhtmlのいずれか一方のみ指定可能
 */
export const layoutInspectInputSchema = z
  .object({
    id: z.string().uuid({ message: '有効なUUID形式のIDを指定してください' }).optional(),
    html: z
      .string()
      .min(1, { message: 'HTMLコンテンツは1文字以上必要です' })
      .max(10_000_000, { message: 'HTMLコンテンツは10MB以下にしてください' })
      .optional(),
    options: layoutInspectOptionsSchema.optional(),
  })
  .refine(
    (data) => {
      const hasId = data.id !== undefined;
      const hasHtml = data.html !== undefined;
      // Either id or html must be provided, but not both
      return (hasId || hasHtml) && !(hasId && hasHtml);
    },
    {
      message: 'idまたはhtmlのいずれか一方のみを指定してください',
    }
  );
export type LayoutInspectInput = z.infer<typeof layoutInspectInputSchema>;

/**
 * セクション情報スキーマ
 */
export const sectionInfoSchema = z.object({
  type: z.string(),
  index: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  htmlSnippet: z.string().optional(),
});
export type SectionInfo = z.infer<typeof sectionInfoSchema>;

/**
 * タイポグラフィ情報スキーマ
 */
export const typographyInfoSchema = z.object({
  fonts: z.array(z.string()),
  headingSizes: z.array(z.string()).optional(),
  bodySize: z.string().optional(),
});
export type TypographyInfo = z.infer<typeof typographyInfoSchema>;

/**
 * グリッド情報スキーマ
 */
export const gridInfoSchema = z.object({
  columns: z.number().int().positive().optional(),
  gap: z.string().optional(),
  areas: z.array(z.string()).optional(),
});
export type GridInfo = z.infer<typeof gridInfoSchema>;

/**
 * layout.inspect 出力スキーマ
 */
export const layoutInspectOutputSchema = z.object({
  webPageId: z.string().uuid(),
  sections: z.array(sectionInfoSchema),
  colors: z.array(z.string()).optional(),
  typography: typographyInfoSchema.optional(),
  grid: gridInfoSchema.optional(),
});
export type LayoutInspectOutput = z.infer<typeof layoutInspectOutputSchema>;

// ============================================================================
// layout.search Schemas
// ============================================================================

// ============================================================================
// Visual Features Filter Schemas (Phase 4-1)
// ============================================================================

/**
 * HEXカラーパターン（#RRGGBB形式）
 */
const hexColorPattern = /^#[0-9A-Fa-f]{6}$/;

/**
 * テーマフィルタースキーマ
 * layoutInfo.visualFeatures.theme に基づくフィルタリング
 *
 * @property type - テーマタイプ（light/dark/mixed）
 * @property minContrastRatio - 最小コントラスト比（1-21、WCAG基準）
 */
export const visualFeaturesThemeFilterSchema = z.object({
  type: z.enum(['light', 'dark', 'mixed']).optional(),
  minContrastRatio: z
    .number()
    .min(1, { message: 'minContrastRatioは1以上21以下である必要があります' })
    .max(21, { message: 'minContrastRatioは1以上21以下である必要があります' })
    .optional(),
});
export type VisualFeaturesThemeFilter = z.infer<typeof visualFeaturesThemeFilterSchema>;

/**
 * カラーフィルタースキーマ
 * layoutInfo.visualFeatures.colors に基づくフィルタリング
 *
 * @property dominantColor - 支配色（HEX形式 #RRGGBB）
 * @property colorTolerance - 色許容度（ΔE距離、0-100、デフォルト15）
 */
export const visualFeaturesColorsFilterSchema = z.object({
  dominantColor: z
    .string()
    .regex(hexColorPattern, {
      message: 'dominantColorは#RRGGBB形式である必要があります',
    })
    .optional(),
  colorTolerance: z
    .number()
    .min(0, { message: 'colorToleranceは0以上100以下である必要があります' })
    .max(100, { message: 'colorToleranceは0以上100以下である必要があります' })
    .default(15)
    .optional(),
});
export type VisualFeaturesColorsFilter = z.infer<typeof visualFeaturesColorsFilterSchema>;

/**
 * 密度フィルタースキーマ
 * layoutInfo.visualFeatures.density に基づくフィルタリング
 *
 * @property minContentDensity - 最小コンテンツ密度（0-1）
 * @property maxContentDensity - 最大コンテンツ密度（0-1）
 * @property minWhitespaceRatio - 最小ホワイトスペース比率（0-1）
 */
export const visualFeaturesDensityFilterSchema = z.object({
  minContentDensity: z
    .number()
    .min(0, { message: 'minContentDensityは0以上1以下である必要があります' })
    .max(1, { message: 'minContentDensityは0以上1以下である必要があります' })
    .optional(),
  maxContentDensity: z
    .number()
    .min(0, { message: 'maxContentDensityは0以上1以下である必要があります' })
    .max(1, { message: 'maxContentDensityは0以上1以下である必要があります' })
    .optional(),
  minWhitespaceRatio: z
    .number()
    .min(0, { message: 'minWhitespaceRatioは0以上1以下である必要があります' })
    .max(1, { message: 'minWhitespaceRatioは0以上1以下である必要があります' })
    .optional(),
});
export type VisualFeaturesDensityFilter = z.infer<typeof visualFeaturesDensityFilterSchema>;

/**
 * ビジュアル特徴フィルタースキーマ（統合）
 * SectionPattern.layoutInfo.visualFeatures に基づくフィルタリング
 *
 * @property theme - テーマフィルター（light/dark/mixed、コントラスト比）
 * @property colors - カラーフィルター（支配色、許容度）
 * @property density - 密度フィルター（コンテンツ密度、ホワイトスペース比率）
 */
export const visualFeaturesFilterSchema = z.object({
  theme: visualFeaturesThemeFilterSchema.optional(),
  colors: visualFeaturesColorsFilterSchema.optional(),
  density: visualFeaturesDensityFilterSchema.optional(),
});
export type VisualFeaturesFilter = z.infer<typeof visualFeaturesFilterSchema>;

// ============================================================================
// layout.search Filters Schema
// ============================================================================

/**
 * layout.search フィルタースキーマ
 *
 * @property sectionType - セクションタイプフィルター（オプション）
 * @property sourceType - ソースタイプフィルター（オプション）
 * @property usageScope - 利用範囲フィルター（オプション）
 * @property visualFeatures - ビジュアル特徴フィルター（Phase 4-1、オプション）
 */
export const layoutSearchFiltersSchema = z.object({
  sectionType: sectionTypeForSearchSchema.optional(),
  sourceType: sourceTypeSchema.optional(),
  usageScope: usageScopeSchema.optional(),
  visualFeatures: visualFeaturesFilterSchema.optional(),
  mood: moodFilterSchema.optional(),
  brandTone: brandToneFilterSchema.optional(),
});
export type LayoutSearchFilters = z.infer<typeof layoutSearchFiltersSchema>;

/**
 * Project Context オプションスキーマ
 * プロジェクトのデザインパターンを検出し、検索結果の適合度を評価
 *
 * @property enabled - プロジェクトコンテキスト解析を有効化（デフォルトtrue）
 * @property project_path - スキャン対象のプロジェクトパス（オプション）
 * @property design_tokens_path - デザイントークンファイルの特定パス（オプション）
 */
export const projectContextOptionsSchema = z.object({
  enabled: z.boolean().optional().default(true),
  project_path: z
    .string()
    .min(1, { message: 'project_pathは空文字列にできません' })
    .optional(),
  design_tokens_path: z
    .string()
    .min(1, { message: 'design_tokens_pathは空文字列にできません' })
    .optional(),
});
export type ProjectContextOptions = z.infer<typeof projectContextOptionsSchema>;

/**
 * Integration Hints スキーマ
 * 検索結果をプロジェクトに統合するためのヒント情報
 *
 * @property suggested_hooks - 推奨カスタムフック（useScrollAnimation等）
 * @property color_mapping - パターン色からプロジェクトトークンへのマッピング
 * @property existing_animations - 既存アニメーション（globals.css等）
 */
export const integrationHintsSchema = z.object({
  suggested_hooks: z.array(z.string()),
  color_mapping: z.record(z.string(), z.string()),
  existing_animations: z.array(z.string()),
});
export type IntegrationHints = z.infer<typeof integrationHintsSchema>;

// ============================================================================
// Multimodal Search Schemas
// ============================================================================

/**
 * 検索モードスキーマ
 * マルチモーダル検索における検索モードを指定
 *
 * - text_only: text_embeddingのみを使用（デフォルト）
 * - vision_only: vision_embeddingのみを使用
 * - combined: 両方を使用してRRF統合
 */
export const searchModeSchema = z.enum(['text_only', 'vision_only', 'combined']);
export type SearchMode = z.infer<typeof searchModeSchema>;

/**
 * マルチモーダルオプションスキーマ
 * RRF統合検索の重み付け設定
 *
 * @property textWeight - text_embeddingの重み（0-1、デフォルト0.6）
 * @property visionWeight - vision_embeddingの重み（0-1、デフォルト0.4）
 * @property rrfK - RRFのkパラメータ（1-100、デフォルト60）
 */
export const multimodalOptionsSchema = z.object({
  textWeight: z
    .number()
    .min(0, { message: 'textWeightは0以上1以下である必要があります' })
    .max(1, { message: 'textWeightは0以上1以下である必要があります' })
    .optional()
    .default(0.6),
  visionWeight: z
    .number()
    .min(0, { message: 'visionWeightは0以上1以下である必要があります' })
    .max(1, { message: 'visionWeightは0以上1以下である必要があります' })
    .optional()
    .default(0.4),
  rrfK: z
    .number()
    .int({ message: 'rrfKは整数である必要があります' })
    .min(1, { message: 'rrfKは1以上100以下である必要があります' })
    .max(100, { message: 'rrfKは1以上100以下である必要があります' })
    .optional()
    .default(60),
});
export type MultimodalOptions = z.infer<typeof multimodalOptionsSchema>;

// ============================================================================
// Vision Search Query Schema (Phase 4-2)
// ============================================================================

/**
 * VisualFeatures検索条件スキーマ
 * vision_embeddingを活用したセマンティック検索用
 *
 * @property theme - テーマ（light/dark/mixed）
 * @property colors - 色指定（HEX形式配列）
 * @property density - 密度（sparse/moderate/dense）
 * @property gradient - グラデーション（none/subtle/prominent）
 * @property mood - 雰囲気（professional/playful/minimal等）
 * @property brandTone - ブランドトーン
 */
export const visionSearchVisualFeaturesSchema = z.object({
  theme: z.string().optional(),
  colors: z.array(z.string()).optional(),
  density: z.string().optional(),
  gradient: z.string().optional(),
  mood: z.string().optional(),
  brandTone: z.string().optional(),
});
export type VisionSearchVisualFeatures = z.infer<typeof visionSearchVisualFeaturesSchema>;

/**
 * Vision検索クエリスキーマ
 * vision_embedding列でのセマンティック検索
 *
 * @property textQuery - テキストクエリ（視覚的特徴を自然言語で記述）
 * @property visualFeatures - 構造化された視覚的特徴条件
 * @property sectionPatternId - 既存セクションIDで類似検索
 */
export const visionSearchQuerySchema = z.object({
  textQuery: z
    .string()
    .min(1, { message: 'textQueryは1文字以上必要です' })
    .max(500, { message: 'textQueryは500文字以下にしてください' })
    .optional(),
  visualFeatures: visionSearchVisualFeaturesSchema.optional(),
  sectionPatternId: z
    .string()
    .uuid({ message: '有効なUUID形式のsectionPatternIdを指定してください' })
    .optional(),
});
export type VisionSearchQuery = z.infer<typeof visionSearchQuerySchema>;

/**
 * Vision検索オプションスキーマ
 *
 * @property minSimilarity - 最小類似度（0-1、デフォルト0.5）
 * @property visionWeight - RRFでのvision_embeddingの重み（0-1、デフォルト0.6）
 * @property textWeight - RRFでのtext_embeddingの重み（0-1、デフォルト0.4）
 */
export const visionSearchOptionsSchema = z.object({
  minSimilarity: z
    .number()
    .min(0, { message: 'minSimilarityは0以上1以下である必要があります' })
    .max(1, { message: 'minSimilarityは0以上1以下である必要があります' })
    .optional()
    .default(0.5),
  visionWeight: z
    .number()
    .min(0, { message: 'visionWeightは0以上1以下である必要があります' })
    .max(1, { message: 'visionWeightは0以上1以下である必要があります' })
    .optional()
    .default(0.6),
  textWeight: z
    .number()
    .min(0, { message: 'textWeightは0以上1以下である必要があります' })
    .max(1, { message: 'textWeightは0以上1以下である必要があります' })
    .optional()
    .default(0.4),
});
export type VisionSearchOptions = z.infer<typeof visionSearchOptionsSchema>;

// ============================================================================
// layout.search Input Schema
// ============================================================================

/**
 * layout.search 入力スキーマ
 *
 * @property query - 検索クエリ（1-500文字、必須）
 * @property filters - 検索フィルター（オプション）
 * @property limit - 取得件数（1-50、デフォルト10）
 * @property offset - オフセット（0以上、デフォルト0）
 * @property include_html - HTMLを含めるか（デフォルトfalse）- snake_case正式形式
 * @property includeHtml - HTMLを含めるか（デフォルトfalse）- レガシー互換（include_html推奨）
 * @property include_preview - プレビュー用HTMLスニペットを含めるか（デフォルトtrue）
 * @property preview_max_length - プレビューの最大文字数（100-1000、デフォルト500）
 * @property project_context - プロジェクトコンテキスト解析オプション（オプション）
 * @property use_vision_search - Vision検索を有効化（デフォルトfalse）
 * @property vision_search_query - Vision検索クエリ（use_vision_search=true時に使用）
 * @property vision_search_options - Vision検索オプション（use_vision_search=true時に使用）
 */
export const layoutSearchInputSchema = z.object({
  query: z
    .string()
    .min(1, { message: 'クエリは1文字以上必要です' })
    .max(500, { message: 'クエリは500文字以下にしてください' }),
  filters: layoutSearchFiltersSchema.optional(),
  limit: z
    .number()
    .int({ message: 'limitは整数である必要があります' })
    .min(1, { message: 'limitは1以上50以下である必要があります' })
    .max(50, { message: 'limitは1以上50以下である必要があります' })
    .optional()
    .default(10),
  offset: z
    .number()
    .int({ message: 'offsetは整数である必要があります' })
    .min(0, { message: 'offsetは0以上である必要があります' })
    .optional()
    .default(0),
  // MCP-RESP-03: snake_case正式形式（新規オプション推奨形式）
  // デフォルト値はgetIncludeHtml()で適用（両形式対応のため）
  include_html: z.boolean().optional(),
  // レガシー互換: camelCaseは後方互換として維持
  // デフォルト値はgetIncludeHtml()で適用（両形式対応のため）
  includeHtml: z.boolean().optional(),
  include_preview: z.boolean().optional().default(true),
  preview_max_length: z
    .number()
    .int({ message: 'preview_max_lengthは整数である必要があります' })
    .min(100, { message: 'preview_max_lengthは100以上1000以下である必要があります' })
    .max(1000, { message: 'preview_max_lengthは100以上1000以下である必要があります' })
    .optional()
    .default(500),
  project_context: projectContextOptionsSchema.optional(),
  // REFTRIX-LAYOUT-02: Auto-detect context from query
  /**
   * クエリから業界・スタイルコンテキストを自動推論
   * 推論結果に基づいて検索結果をブースト
   * @default true
   */
  auto_detect_context: z.boolean().optional().default(true),
  // Phase 4-2: Vision Search Parameters
  use_vision_search: z.boolean().optional().default(false),
  vision_search_query: visionSearchQuerySchema.optional(),
  vision_search_options: visionSearchOptionsSchema.optional(),
  // Multimodal Search Parameters
  /**
   * 検索モード
   * - text_only: text_embeddingのみを使用（デフォルト）
   * - vision_only: vision_embeddingのみを使用
   * - combined: 両方を使用してRRF統合
   * @default 'text_only'
   */
  search_mode: searchModeSchema.optional().default('text_only'),
  /**
   * マルチモーダルオプション
   * search_mode='combined'時のRRF統合パラメータ
   */
  multimodal_options: multimodalOptionsSchema.optional(),
});
export type LayoutSearchInput = z.infer<typeof layoutSearchInputSchema>;

/**
 * 検索結果プレビュースキーマ
 */
export const layoutSearchPreviewSchema = z.object({
  heading: z.string().optional(),
  description: z.string().optional(),
  thumbnail: z.string().optional(), // Base64エンコード画像（縮小版）
});
export type LayoutSearchPreview = z.infer<typeof layoutSearchPreviewSchema>;

/**
 * 検索結果ソース情報スキーマ
 */
export const layoutSearchSourceSchema = z.object({
  url: z.string().url(),
  type: sourceTypeSchema,
  usageScope: usageScopeSchema,
});
export type LayoutSearchSource = z.infer<typeof layoutSearchSourceSchema>;

/**
 * Vision分析結果の特徴スキーマ
 */
export const visionFeatureSchema = z.object({
  type: z.string(),
  confidence: z.number().min(0).max(1),
  description: z.string().optional(),
  data: z.unknown().optional(),
});
export type VisionFeature = z.infer<typeof visionFeatureSchema>;

/**
 * Vision分析結果スキーマ（layout.inspect Vision分析の結果）
 */
export const visionAnalysisSchema = z.object({
  success: z.boolean(),
  features: z.array(visionFeatureSchema),
  textRepresentation: z.string().optional(),
  processingTimeMs: z.number().optional(),
  modelName: z.string().optional(),
  rawResponse: z.string().optional(),
  error: z.string().optional(),
});
export type VisionAnalysis = z.infer<typeof visionAnalysisSchema>;

/**
 * 検索結果アイテムスキーマ（拡張版）
 */
export const layoutSearchResultItemSchema = z.object({
  id: z.string().uuid(),
  webPageId: z.string().uuid(),
  type: z.string(), // sectionType
  similarity: z.number().min(0).max(1),
  preview: layoutSearchPreviewSchema,
  source: layoutSearchSourceSchema,
  html: z.string().optional(), // includeHtml=true時のみ
  // HTMLプレビュー（サニタイズ済み短縮HTML）
  htmlPreview: z.string().optional(), // include_preview=true時のみ（デフォルト）
  previewLength: z.number().int().nonnegative().optional(), // htmlPreviewの元の文字数
  visionAnalysis: visionAnalysisSchema.optional(), // Vision分析結果
  // Mood/BrandTone search results (optional, when mood/brandTone filters applied)
  moodInfo: z.object({
    primary: z.string(),
    secondary: z.string().optional(),
  }).optional(),
  brandToneInfo: z.object({
    primary: z.string(),
    secondary: z.string().optional(),
  }).optional(),
  // Project Context Adaptation fields (optional, when project_context.enabled=true)
  adaptability_score: z.number().int().min(0).max(100).optional(), // 0-100
  integration_hints: integrationHintsSchema.optional(),
  // REFTRIX-LAYOUT-02: Context boost (auto_detect_context=true時)
  context_boost: z.number().min(0).max(0.15).optional(),
  // RRF統合検索時の個別結果詳細（combined モード時のみ）
  rrfDetails: z
    .object({
      textRank: z.number().int().nonnegative(), // テキスト検索でのランク（0=含まれない）
      visionRank: z.number().int().nonnegative(), // Vision検索でのランク（0=含まれない）
      textScore: z.number().min(0).max(1).optional(), // テキスト類似度スコア
      visionScore: z.number().min(0).max(1).optional(), // Vision類似度スコア
      rrfScore: z.number().min(0).optional(), // RRF統合スコア
    })
    .optional(),
});
export type LayoutSearchResultItem = z.infer<typeof layoutSearchResultItemSchema>;

/**
 * 推論されたコンテキストスキーマ（REFTRIX-LAYOUT-02）
 */
export const inferredContextSchema = z.object({
  industry: z.string().nullable(),
  style: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  detected_keywords: z.array(z.string()),
});
export type InferredContextOutput = z.infer<typeof inferredContextSchema>;

// ============================================================================
// RRF Details Schema
// ============================================================================

/**
 * RRF（Reciprocal Rank Fusion）詳細情報スキーマ
 *
 * @property k - RRFのkパラメータ
 * @property textWeight - text_embeddingの重み
 * @property visionWeight - vision_embeddingの重み
 * @property textResultCount - text検索結果数
 * @property visionResultCount - vision検索結果数
 * @property fusedResultCount - 統合後の結果数
 * @property calculationTimeMs - RRF計算時間（ミリ秒）
 */
export const rrfDetailsSchema = z.object({
  k: z.number().int().min(1).max(100),
  textWeight: z.number().min(0).max(1),
  visionWeight: z.number().min(0).max(1),
  textResultCount: z.number().int().nonnegative(),
  visionResultCount: z.number().int().nonnegative(),
  fusedResultCount: z.number().int().nonnegative(),
  calculationTimeMs: z.number().nonnegative().optional(),
});
export type RrfDetails = z.infer<typeof rrfDetailsSchema>;

/**
 * layout.search 成功レスポンスデータスキーマ
 */
export const layoutSearchDataSchema = z.object({
  results: z.array(layoutSearchResultItemSchema),
  total: z.number().int().nonnegative(),
  query: z.string(),
  filters: z.record(z.unknown()).optional(),
  filtersApplied: z.array(z.string()).optional(),
  searchTimeMs: z.number().nonnegative().optional(),
  // REFTRIX-LAYOUT-02: Auto-detected context
  inferred_context: inferredContextSchema.optional(),
  context_boost_applied: z.boolean().optional(),
  // Multimodal Search Output Fields
  /**
   * 要求された検索モード
   */
  searchMode: searchModeSchema.optional(),
  /**
   * 実際に使用された検索モード
   * vision_embeddingがnullの場合、text_onlyにフォールバック
   */
  actualSearchMode: searchModeSchema.optional(),
  /**
   * 警告メッセージ（Graceful Degradation時など）
   */
  warnings: z.array(z.string()).optional(),
  /**
   * RRF統合の詳細情報（search_mode='combined'時のみ）
   */
  rrfDetails: rrfDetailsSchema.optional(),
  /**
   * フォールバック理由（Graceful Degradation発生時のみ）
   */
  fallbackReason: z.string().optional(),
});
export type LayoutSearchData = z.infer<typeof layoutSearchDataSchema>;

/**
 * layout.search エラー情報スキーマ
 */
export const layoutSearchErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type LayoutSearchErrorInfo = z.infer<typeof layoutSearchErrorInfoSchema>;

/**
 * layout.search 成功レスポンススキーマ
 */
export const layoutSearchSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: layoutSearchDataSchema,
});

/**
 * layout.search 失敗レスポンススキーマ
 */
export const layoutSearchErrorOutputSchema = z.object({
  success: z.literal(false),
  error: layoutSearchErrorInfoSchema,
});

/**
 * layout.search 出力スキーマ（統合）
 */
export const layoutSearchOutputSchema = z.discriminatedUnion('success', [
  layoutSearchSuccessOutputSchema,
  layoutSearchErrorOutputSchema,
]);
export type LayoutSearchOutput = z.infer<typeof layoutSearchOutputSchema>;

// ============================================================================
// layout.generate_code Schemas
// ============================================================================

/**
 * layout.generate_code オプションスキーマ
 *
 * @property framework - フレームワーク（react/vue/html、デフォルトreact）
 * @property typescript - TypeScript出力（デフォルトtrue）
 * @property tailwind - Tailwind使用（デフォルトtrue）
 * @property paletteId - ブランドパレットID（オプション）
 * @property componentName - コンポーネント名（PascalCase形式、オプション）
 * @property splitComponents - HTMLを意味のあるサブコンポーネントに分割するか（デフォルトfalse）
 */
export const layoutToCodeOptionsSchema = z.object({
  framework: frameworkSchema.optional().default('react'),
  typescript: z.boolean().optional().default(true),
  tailwind: z.boolean().optional().default(true),
  paletteId: z
    .string()
    .uuid({ message: '有効なUUID形式のpaletteIdを指定してください' })
    .optional(),
  componentName: z
    .string()
    .min(1, { message: 'コンポーネント名は1文字以上必要です' })
    .regex(/^[A-Z][a-zA-Z0-9]*$/, {
      message: 'コンポーネント名はPascalCase形式である必要があります',
    })
    .optional(),
  splitComponents: z.boolean().optional().default(false),
  /**
   * レスポンシブブレークポイント自動生成
   * 大きなサイズのwidth/padding/font-size/flex-directionを
   * モバイルファーストのレスポンシブクラスに変換します
   * @default true
   */
  responsive: z.boolean().optional().default(true),
});
export type LayoutToCodeOptions = z.infer<typeof layoutToCodeOptionsSchema>;

/**
 * layout.generate_code 入力スキーマ
 *
 * @property patternId - パターンID（UUID形式、必須）
 * @property options - オプション設定（オプション）
 */
export const layoutToCodeInputSchema = z.object({
  patternId: z.string().uuid({ message: '有効なUUID形式のpatternIdを指定してください' }),
  options: layoutToCodeOptionsSchema.optional(),
});
export type LayoutToCodeInput = z.infer<typeof layoutToCodeInputSchema>;

/**
 * layout.generate_code データスキーマ
 */
export const layoutToCodeDataSchema = z.object({
  code: z.string(),
  framework: frameworkSchema,
  componentName: z.string(),
  filename: z.string(),
  dependencies: z.array(z.string()).optional(),
  inspirationUrls: z.array(z.string().url()).optional(),
  usageScope: usageScopeSchema,
});
export type LayoutToCodeData = z.infer<typeof layoutToCodeDataSchema>;

/**
 * layout.generate_code エラー情報スキーマ
 */
export const layoutToCodeErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type LayoutToCodeErrorInfo = z.infer<typeof layoutToCodeErrorInfoSchema>;

/**
 * layout.generate_code 成功レスポンススキーマ
 */
export const layoutToCodeSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: layoutToCodeDataSchema,
});

/**
 * layout.generate_code 失敗レスポンススキーマ
 */
export const layoutToCodeErrorOutputSchema = z.object({
  success: z.literal(false),
  error: layoutToCodeErrorInfoSchema,
});

/**
 * layout.generate_code 出力スキーマ（統合）
 */
export const layoutToCodeOutputSchema = z.discriminatedUnion('success', [
  layoutToCodeSuccessOutputSchema,
  layoutToCodeErrorOutputSchema,
]);
export type LayoutToCodeOutput = z.infer<typeof layoutToCodeOutputSchema>;

/**
 * @deprecated Use layoutToCodeDataSchema instead
 * 後方互換性のため残す（テスト移行後に削除）
 */
export const layoutToCodeLegacyOutputSchema = layoutToCodeDataSchema;

// ============================================================================
// layout.patterns Schemas (pattern listing, not a registered MCP tool)
// ============================================================================

/**
 * layout patterns 入力スキーマ（パターン一覧取得用）
 *
 * @property sectionType - セクションタイプフィルター（オプション）
 * @property limit - 取得件数（1-100、デフォルト20）
 * @property offset - オフセット（0以上、デフォルト0）
 * @property sortBy - ソート対象（createdAt/usageCount/quality、デフォルトcreatedAt）
 * @property sortOrder - ソート順序（asc/desc、デフォルトdesc）
 */
export const layoutPatternsInputSchema = z.object({
  sectionType: sectionTypeForSearchSchema.optional(),
  limit: z
    .number()
    .int({ message: 'limitは整数である必要があります' })
    .min(1, { message: 'limitは1以上100以下である必要があります' })
    .max(100, { message: 'limitは1以上100以下である必要があります' })
    .optional()
    .default(20),
  offset: z
    .number()
    .int({ message: 'offsetは整数である必要があります' })
    .min(0, { message: 'offsetは0以上である必要があります' })
    .optional()
    .default(0),
  sortBy: sortBySchema.optional().default('createdAt'),
  sortOrder: sortOrderSchema.optional().default('desc'),
});
export type LayoutPatternsInput = z.infer<typeof layoutPatternsInputSchema>;

/**
 * パターンアイテムスキーマ
 */
export const layoutPatternItemSchema = z.object({
  id: z.string().uuid(),
  sectionType: z.string(),
  name: z.string(),
  previewUrl: z.string().url().optional(),
  usageCount: z.number().int().nonnegative(),
  quality: z.number().min(0).max(1),
  createdAt: z.string().datetime(),
});
export type LayoutPatternItem = z.infer<typeof layoutPatternItemSchema>;

/**
 * layout patterns 出力スキーマ（パターン一覧取得用）
 */
export const layoutPatternsOutputSchema = z.object({
  patterns: z.array(layoutPatternItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type LayoutPatternsOutput = z.infer<typeof layoutPatternsOutputSchema>;

// ============================================================================
// layout.batch_ingest Schemas
// ============================================================================

/**
 * layout.batch_ingest オプションスキーマ
 *
 * @property concurrency - 並列処理数（1-10、デフォルト5）
 * @property on_error - エラー時の動作（skip/abort、デフォルトskip）
 * @property save_to_db - DBに保存するか（デフォルトtrue）
 * @property auto_analyze - 自動解析するか（デフォルトtrue）
 */
export const layoutBatchIngestOptionsSchema = z.object({
  concurrency: z
    .number()
    .int({ message: 'concurrencyは整数である必要があります' })
    .min(1, { message: 'concurrencyは1以上10以下である必要があります' })
    .max(10, { message: 'concurrencyは1以上10以下である必要があります' })
    .optional()
    .default(5),
  on_error: z
    .enum(['skip', 'abort'])
    .optional()
    .default('skip'),
  save_to_db: z.boolean().optional().default(true),
  auto_analyze: z.boolean().optional().default(true),
});
export type LayoutBatchIngestOptions = z.infer<typeof layoutBatchIngestOptionsSchema>;

/**
 * layout.batch_ingest 入力スキーマ
 *
 * @property urls - インジェスト対象のURL配列（1-100件、必須）
 * @property options - オプション設定（オプション）
 */
export const layoutBatchIngestInputSchema = z.object({
  urls: z
    .array(z.string().url({ message: '有効なURL形式を指定してください' }))
    .min(1, { message: 'URLは1件以上100件以下で指定してください' })
    .max(100, { message: 'URLは1件以上100件以下で指定してください' }),
  options: layoutBatchIngestOptionsSchema.optional(),
  /** robots.txtを尊重するかどうか（RFC 9309）。falseで無視 */
  respect_robots_txt: z.boolean().optional(),
});
export type LayoutBatchIngestInput = z.infer<typeof layoutBatchIngestInputSchema>;

/**
 * バッチインジェスト結果アイテムスキーマ
 */
export const batchIngestResultItemSchema = z.object({
  url: z.string().url(),
  status: z.enum(['success', 'failed']),
  page_id: z.string().uuid().optional(),
  error: z.string().optional(),
  patterns_extracted: z.number().int().nonnegative().optional(),
});
export type BatchIngestResultItem = z.infer<typeof batchIngestResultItemSchema>;

/**
 * バッチインジェストサマリースキーマ
 */
export const batchIngestSummarySchema = z.object({
  success_rate: z.number().min(0).max(100),
  total_patterns: z.number().int().nonnegative(),
  processing_time_ms: z.number().nonnegative(),
});
export type BatchIngestSummary = z.infer<typeof batchIngestSummarySchema>;

/**
 * layout.batch_ingest 成功レスポンスデータスキーマ
 */
export const layoutBatchIngestDataSchema = z.object({
  job_id: z.string().uuid(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(batchIngestResultItemSchema),
  summary: batchIngestSummarySchema,
});
export type LayoutBatchIngestData = z.infer<typeof layoutBatchIngestDataSchema>;

/**
 * layout.batch_ingest エラー情報スキーマ
 */
export const layoutBatchIngestErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type LayoutBatchIngestErrorInfo = z.infer<typeof layoutBatchIngestErrorInfoSchema>;

/**
 * layout.batch_ingest 成功レスポンススキーマ
 */
export const layoutBatchIngestSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: layoutBatchIngestDataSchema,
});

/**
 * layout.batch_ingest 失敗レスポンススキーマ
 */
export const layoutBatchIngestErrorOutputSchema = z.object({
  success: z.literal(false),
  error: layoutBatchIngestErrorInfoSchema,
});

/**
 * layout.batch_ingest 出力スキーマ（統合）
 */
export const layoutBatchIngestOutputSchema = z.discriminatedUnion('success', [
  layoutBatchIngestSuccessOutputSchema,
  layoutBatchIngestErrorOutputSchema,
]);
export type LayoutBatchIngestOutput = z.infer<typeof layoutBatchIngestOutputSchema>;

// ============================================================================
// Error Codes
// ============================================================================

/**
 * layout.* ツール用エラーコード
 */
export const LAYOUT_MCP_ERROR_CODES = {
  /** レイアウトが見つからない */
  LAYOUT_NOT_FOUND: 'LAYOUT_NOT_FOUND',
  /** インジェスト失敗 */
  INGEST_FAILED: 'INGEST_FAILED',
  /** 検査失敗 */
  INSPECT_FAILED: 'INSPECT_FAILED',
  /** 検索失敗 */
  SEARCH_FAILED: 'SEARCH_FAILED',
  /** コード生成失敗 */
  CODE_GENERATION_FAILED: 'CODE_GENERATION_FAILED',
  /** バリデーションエラー */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** タイムアウト */
  TIMEOUT: 'TIMEOUT',
  /** HTMLサイズ超過 */
  HTML_TOO_LARGE: 'HTML_TOO_LARGE',
  /** パターンが見つからない */
  PATTERN_NOT_FOUND: 'PATTERN_NOT_FOUND',
  /** SSRF対策によりブロック */
  SSRF_BLOCKED: 'SSRF_BLOCKED',
  /** タイムアウトエラー */
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  /** ネットワークエラー */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** ブラウザエラー */
  BROWSER_ERROR: 'BROWSER_ERROR',
  /** 内部エラー */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** HTTPエラー */
  HTTP_ERROR: 'HTTP_ERROR',
  /** DB保存失敗 */
  DB_SAVE_FAILED: 'DB_SAVE_FAILED',
  /** バッチ処理中止 */
  BATCH_ABORTED: 'BATCH_ABORTED',
} as const;

export type LayoutMcpErrorCode = (typeof LAYOUT_MCP_ERROR_CODES)[keyof typeof LAYOUT_MCP_ERROR_CODES];

// ============================================================================
// MCP Tool Definitions
// ============================================================================

/**
 * MCP Tool definitions for layout.* tools
 * MCPプロトコル準拠のツール定義
 */
export const layoutMcpTools = {
  'layout.ingest': {
    name: 'layout.ingest',
    description: 'URLからWebページを取得し、レイアウト解析用データを準備します',
    inputSchema: layoutIngestInputSchema,
  },
  'layout.inspect': {
    name: 'layout.inspect',
    description: 'HTMLを解析し、セクション・グリッド・タイポグラフィを抽出します',
    inputSchema: layoutInspectInputSchema,
  },
  'layout.search': {
    name: 'layout.search',
    description: 'レイアウトパターンをセマンティック検索します',
    inputSchema: layoutSearchInputSchema,
  },
  'layout.generate_code': {
    name: 'layout.generate_code',
    description: 'パターンからReact/Vue/HTMLコードを生成します',
    inputSchema: layoutToCodeInputSchema,
  },
  'layout.batch_ingest': {
    name: 'layout.batch_ingest',
    description: '複数URLを一括取得しレイアウト解析用データを準備します',
    inputSchema: layoutBatchIngestInputSchema,
  },
} as const;

export type LayoutMcpToolName = keyof typeof layoutMcpTools;
