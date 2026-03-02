// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * responsive.search MCPツール Zodスキーマ定義
 * レスポンシブデザイン分析のセマンティック検索用バリデーション
 *
 * @module tools/responsive/schemas
 */

import { z } from 'zod';

// ============================================================================
// Enum Schemas
// ============================================================================

/**
 * レスポンシブ差異カテゴリ
 */
export const responsiveDiffCategorySchema = z.enum([
  'layout',
  'typography',
  'spacing',
  'visibility',
  'navigation',
  'image',
  'interaction',
  'animation',
]);

export type ResponsiveDiffCategory = z.infer<typeof responsiveDiffCategorySchema>;

/**
 * ビューポートペア
 */
export const viewportPairSchema = z.enum([
  'desktop-tablet',
  'desktop-mobile',
  'tablet-mobile',
]);

export type ViewportPair = z.infer<typeof viewportPairSchema>;

// ============================================================================
// Error Codes
// ============================================================================

export const RESPONSIVE_MCP_ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  SEARCH_FAILED: 'SEARCH_FAILED',
  EMBEDDING_FAILED: 'EMBEDDING_FAILED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ResponsiveMcpErrorCode =
  (typeof RESPONSIVE_MCP_ERROR_CODES)[keyof typeof RESPONSIVE_MCP_ERROR_CODES];

// ============================================================================
// Input Schema
// ============================================================================

/**
 * responsive.search 検索フィルター
 */
export const responsiveSearchFiltersSchema = z.object({
  /** 差異カテゴリフィルタ */
  diffCategory: responsiveDiffCategorySchema.optional(),
  /** ビューポートペアフィルタ */
  viewportPair: viewportPairSchema.optional(),
  /** ブレークポイント範囲フィルタ */
  breakpointRange: z.object({
    min: z.number().int().min(0).optional(),
    max: z.number().int().max(10000).optional(),
  }).optional(),
  /** 最小スクリーンショット差分パーセンテージ */
  minDiffPercentage: z.number().min(0).max(100).optional(),
  /** WebページIDフィルタ */
  webPageId: z.string().uuid().optional(),
}).optional();

export type ResponsiveSearchFilters = z.infer<typeof responsiveSearchFiltersSchema>;

/**
 * responsive.search 入力スキーマ
 */
export const responsiveSearchInputSchema = z.object({
  /** 検索クエリ（1-500文字） */
  query: z.string().min(1).max(500),
  /** 取得件数（1-50、デフォルト: 10） */
  limit: z.number().int().min(1).max(50).default(10),
  /** オフセット（0以上、デフォルト: 0） */
  offset: z.number().int().min(0).default(0),
  /** 検索フィルター */
  filters: responsiveSearchFiltersSchema,
});

export type ResponsiveSearchInput = z.infer<typeof responsiveSearchInputSchema>;
