// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * background.search MCPツール Zodスキーマ定義
 * BackgroundDesign テーブルのセマンティック検索用バリデーション
 *
 * @module tools/background/schemas
 */

import { z } from 'zod';

// ============================================================================
// Enum Schemas
// ============================================================================

/**
 * BackgroundDesignType enum
 * Prisma enum BackgroundDesignType に基づく14種類
 */
export const backgroundDesignTypeSchema = z.enum([
  'solid_color',
  'linear_gradient',
  'radial_gradient',
  'conic_gradient',
  'mesh_gradient',
  'image_background',
  'pattern_background',
  'video_background',
  'animated_gradient',
  'glassmorphism',
  'noise_texture',
  'svg_background',
  'multi_layer',
  'unknown',
]);

export type BackgroundDesignType = z.infer<typeof backgroundDesignTypeSchema>;

// ============================================================================
// Error Codes
// ============================================================================

/**
 * background.search MCPエラーコード
 */
export const BACKGROUND_MCP_ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  SEARCH_FAILED: 'SEARCH_FAILED',
  EMBEDDING_FAILED: 'EMBEDDING_FAILED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type BackgroundMcpErrorCode =
  (typeof BACKGROUND_MCP_ERROR_CODES)[keyof typeof BACKGROUND_MCP_ERROR_CODES];

// ============================================================================
// Input Schema
// ============================================================================

/**
 * background.search 検索フィルター
 */
export const backgroundSearchFiltersSchema = z.object({
  designType: backgroundDesignTypeSchema.optional(),
  webPageId: z.string().optional(),
}).optional();

export type BackgroundSearchFilters = z.infer<typeof backgroundSearchFiltersSchema>;

/**
 * background.search 入力スキーマ
 */
export const backgroundSearchInputSchema = z.object({
  /** 検索クエリ（1-500文字） */
  query: z.string().min(1).max(500),
  /** 取得件数（1-50、デフォルト: 10） */
  limit: z.number().int().min(1).max(50).default(10),
  /** オフセット（0以上、デフォルト: 0） */
  offset: z.number().min(0).default(0),
  /** 検索フィルター */
  filters: backgroundSearchFiltersSchema,
});

export type BackgroundSearchInput = z.infer<typeof backgroundSearchInputSchema>;
