// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Webdesign Types
 * TypeScript型定義 for Webデザイン解析機能
 *
 * Reference: /docs/plans/webdesign/07-database-schema.md
 *
 * @module @reftrix/core/webdesign
 */

import { z } from 'zod';

// =========================================
// Enum / Literal Types with Zod Schemas
// =========================================

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
 * アワードソース
 * - cssda: CSS Design Awards
 * - fwa: FWA (Favourite Website Awards)
 * - awwwards: Awwwards
 */
export const awardSourceSchema = z.enum(['cssda', 'fwa', 'awwwards']);
export type AwardSource = z.infer<typeof awardSourceSchema>;

/**
 * セクションタイプ
 * Webページの主要セクションタイプ
 */
export const sectionTypeSchema = z.enum([
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
  'unknown',
]);
export type SectionType = z.infer<typeof sectionTypeSchema>;

/**
 * モーションタイプ
 * アニメーション・インタラクションの種類
 */
export const motionTypeSchema = z.enum([
  'scroll_trigger',
  'hover',
  'page_transition',
  'loading',
  'parallax',
  'reveal',
  'unknown',
]);
export type MotionType = z.infer<typeof motionTypeSchema>;

/**
 * 解析ステータス
 */
export const analysisStatusSchema = z.enum([
  'pending',
  'processing',
  'completed',
  'failed',
]);
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;

/**
 * コード生成タイプ
 */
export const codeTypeSchema = z.enum(['react', 'html', 'tailwind']);
export type CodeType = z.infer<typeof codeTypeSchema>;

/**
 * MIMEタイプ（スクリーンショット用）
 */
export const screenshotMimeTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
export type ScreenshotMimeType = z.infer<typeof screenshotMimeTypeSchema>;

// =========================================
// Interface Schemas
// =========================================

/**
 * ソース情報
 */
export const sourceInfoSchema = z.object({
  type: sourceTypeSchema,
  usageScope: usageScopeSchema,
  awardSource: awardSourceSchema.optional(),
  licenseNote: z.string().optional(),
});
export type SourceInfo = z.infer<typeof sourceInfoSchema>;

/**
 * ページメタデータ
 */
export const pageMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  ogImage: z.string().url().optional(),
  keywords: z.array(z.string()).optional(),
});
export type PageMetadata = z.infer<typeof pageMetadataSchema>;

/**
 * ビューポート情報
 */
export const viewportInfoSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive(),
});
export type ViewportInfo = z.infer<typeof viewportInfoSchema>;

/**
 * 部分的なビューポート情報（オプション用）
 */
export const partialViewportInfoSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  deviceScaleFactor: z.number().positive().optional(),
});
export type PartialViewportInfo = z.infer<typeof partialViewportInfoSchema>;

/**
 * スクリーンショット結果
 */
export const screenshotResultSchema = z.object({
  buffer: z.instanceof(Buffer),
  mimeType: screenshotMimeTypeSchema,
  viewport: viewportInfoSchema,
});
export type ScreenshotResult = z.infer<typeof screenshotResultSchema>;

/**
 * インジェストオプション
 */
export const ingestOptionsSchema = z.object({
  url: z.string().url(),
  viewport: partialViewportInfoSchema.optional(),
  fullPage: z.boolean().optional(),
  waitForSelector: z.string().optional(),
  timeout: z.number().int().nonnegative().optional(),
  source: sourceInfoSchema.partial().optional(),
});
export type IngestOptions = z.infer<typeof ingestOptionsSchema>;

/**
 * インジェスト結果
 */
export const ingestResultSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  html: z.string(),
  screenshot: screenshotResultSchema.optional(),
  metadata: pageMetadataSchema,
  source: sourceInfoSchema,
  crawledAt: z.date(),
});
export type IngestResult = z.infer<typeof ingestResultSchema>;

/**
 * グリッド構造
 */
export const gridStructureSchema = z.object({
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  gap: z.string().optional(),
  areas: z.array(z.string()).optional(),
});
export type GridStructure = z.infer<typeof gridStructureSchema>;

/**
 * コンポーネントノード（再帰的定義）
 */
export interface ComponentNode {
  tag: string;
  className?: string;
  role?: string;
  children?: ComponentNode[];
}

// Base schema for ComponentNode (without recursion type annotation)
const baseComponentNodeSchema = z.object({
  tag: z.string().min(1),
  className: z.string().optional(),
  role: z.string().optional(),
});

// Zod schema for ComponentNode (lazy for recursion)
export const componentNodeSchema: z.ZodType<ComponentNode> = z.lazy(() =>
  baseComponentNodeSchema.extend({
    children: z.array(componentNodeSchema).optional(),
  })
) as z.ZodType<ComponentNode>;

/**
 * セクションパターンデータ
 */
export const sectionPatternDataSchema = z.object({
  sectionType: sectionTypeSchema,
  sectionIndex: z.number().int().nonnegative(),
  htmlFragment: z.string().optional(),
  cssStyles: z.record(z.string()).optional(),
  gridStructure: gridStructureSchema.optional(),
  componentTree: componentNodeSchema.optional(),
  textRepresentation: z.string().optional(),
});
export type SectionPatternData = z.infer<typeof sectionPatternDataSchema>;

/**
 * モーションパターンデータ
 */
export const motionPatternDataSchema = z.object({
  motionType: motionTypeSchema,
  triggerElement: z.string().optional(),
  targetElement: z.string().optional(),
  cssAnimation: z.string().optional(),
  jsImplementation: z.string().optional(),
  duration: z.number().nonnegative().optional(),
  easing: z.string().optional(),
  delay: z.number().nonnegative().optional(),
  textRepresentation: z.string().optional(),
});
export type MotionPatternData = z.infer<typeof motionPatternDataSchema>;

/**
 * 品質スコア
 * anti_ai_clicheスコアリング用
 */
export const qualityScoreSchema = z.object({
  visualMotifsScore: z.number().min(0).max(100),
  compositionScore: z.number().min(0).max(100),
  contextScore: z.number().min(0).max(100),
  overallScore: z.number().min(0).max(100),
  detectedPatterns: z.array(z.string()).optional(),
  humanCraftedEvidence: z.array(z.string()).optional(),
});
export type QualityScore = z.infer<typeof qualityScoreSchema>;

/**
 * レイアウト検査結果
 */
export const layoutInspectResultSchema = z.object({
  webPageId: z.string().uuid(),
  sections: z.array(sectionPatternDataSchema),
  motions: z.array(motionPatternDataSchema),
  qualityScore: qualityScoreSchema.optional(),
});
export type LayoutInspectResult = z.infer<typeof layoutInspectResultSchema>;

/**
 * コード生成オプション
 */
export const codeGenerateOptionsSchema = z.object({
  codeType: codeTypeSchema,
  paletteId: z.string().uuid().optional(),
  productionReady: z.boolean().optional(),
});
export type CodeGenerateOptions = z.infer<typeof codeGenerateOptionsSchema>;

/**
 * 生成コード結果
 */
export const generatedCodeResultSchema = z.object({
  code: z.string(),
  codeType: codeTypeSchema,
  inspirationUrls: z.array(z.string().url()),
  usageScope: usageScopeSchema,
  productionReady: z.boolean(),
  qualityNotes: z.string().optional(),
});
export type GeneratedCodeResult = z.infer<typeof generatedCodeResultSchema>;

// =========================================
// Additional Utility Types
// =========================================

/**
 * Webページ作成入力
 */
export const webPageCreateInputSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  description: z.string().optional(),
  sourceType: sourceTypeSchema,
  sourcePlatform: z.string().optional(),
  awardInfo: z.record(z.unknown()).optional(),
  usageScope: usageScopeSchema,
  licenseNote: z.string().optional(),
  htmlContent: z.string().optional(),
  screenshotDesktopUrl: z.string().url().optional(),
  screenshotMobileUrl: z.string().url().optional(),
  screenshotFullUrl: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WebPageCreateInput = z.infer<typeof webPageCreateInputSchema>;

/**
 * セクションパターン作成入力
 */
export const sectionPatternCreateInputSchema = z.object({
  webPageId: z.string().uuid(),
  sectionType: sectionTypeSchema,
  sectionName: z.string().optional(),
  positionIndex: z.number().int().nonnegative(),
  layoutInfo: z.record(z.unknown()),
  components: z.array(z.record(z.unknown())).optional(),
  visualFeatures: z.record(z.unknown()).optional(),
  htmlSnippet: z.string().optional(),
  cssSnippet: z.string().optional(),
  qualityScore: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type SectionPatternCreateInput = z.infer<typeof sectionPatternCreateInputSchema>;

/**
 * モーションパターン作成入力
 */
export const motionPatternCreateInputSchema = z.object({
  webPageId: z.string().uuid().optional(),
  name: z.string().min(1),
  category: z.string().min(1),
  triggerType: z.string().min(1),
  triggerConfig: z.record(z.unknown()).optional(),
  animation: z.record(z.unknown()),
  properties: z.array(z.record(z.unknown())).optional(),
  implementation: z.record(z.unknown()),
  accessibility: z.record(z.unknown()).optional(),
  performance: z.record(z.unknown()).optional(),
  sourceUrl: z.string().url().optional(),
  usageScope: usageScopeSchema.optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type MotionPatternCreateInput = z.infer<typeof motionPatternCreateInputSchema>;

/**
 * 生成コード作成入力
 */
export const generatedCodeCreateInputSchema = z.object({
  sectionPatternId: z.string().uuid().optional(),
  motionPatternIds: z.array(z.string().uuid()).optional(),
  brandPaletteId: z.string().uuid().optional(),
  codeType: codeTypeSchema,
  codeContent: z.string(),
  codeHash: z.string(),
  productionReady: z.boolean().optional(),
  qualityNotes: z.string().optional(),
  qualityScore: z.record(z.unknown()).optional(),
  sourceAttribution: z.record(z.unknown()),
  generationParams: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type GeneratedCodeCreateInput = z.infer<typeof generatedCodeCreateInputSchema>;

// =========================================
// Pre-flight Probe Types (Complexity Metrics)
// =========================================

/**
 * 複雑度メトリクス
 * Pre-flight Probeで取得したページ複雑度情報
 * layout.ingest/page.analyze実行前の軽量プローブで取得し、
 * タイムアウト値の動的計算に使用
 *
 * @see WebPage.complexity_metrics column (JSONB)
 */
export const complexityMetricsSchema = z.object({
  /** HEAD/初期レスポンス時間 (ms) */
  responseTimeMs: z.number().nonnegative(),
  /** HTMLサイズ (bytes) */
  htmlSizeBytes: z.number().nonnegative(),
  /** <script>タグ数 */
  scriptCount: z.number().int().nonnegative(),
  /** 外部リソース数（CSS, JS, images等） */
  externalResourceCount: z.number().int().nonnegative(),
  /** WebGL使用検出フラグ */
  hasWebGL: z.boolean(),
  /** SPA検出フラグ（React/Vue/Angular等） */
  hasSPA: z.boolean(),
  /** 重いフレームワーク検出フラグ（Three.js等） */
  hasHeavyFramework: z.boolean(),
  /** 計算されたタイムアウト値 (ms) */
  calculatedTimeoutMs: z.number().int().positive(),
  /** 複雑度スコア (0-100) */
  complexityScore: z.number().min(0).max(100),
  /** プローブ実行日時 (ISO 8601) */
  probedAt: z.string().datetime(),
  /** プローブバージョン */
  probeVersion: z.string(),
});
export type ComplexityMetrics = z.infer<typeof complexityMetricsSchema>;

/**
 * 部分的な複雑度メトリクス（オプショナルフィールド用）
 */
export const partialComplexityMetricsSchema = complexityMetricsSchema.partial();
export type PartialComplexityMetrics = z.infer<typeof partialComplexityMetricsSchema>;
