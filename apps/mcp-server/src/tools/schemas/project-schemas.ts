// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Project MCP Tools Zod Schemas
 * プロジェクト関連MCPツールの入出力スキーマ定義
 *
 * @module tools/schemas/project-schemas
 */

import { z } from 'zod';
import { getSummaryDefault } from './shared';

// =============================================================================
// project.get スキーマ
// =============================================================================

/**
 * project.get ツールの入力スキーマ
 *
 * @property id - プロジェクトID（UUID形式、必須）
 * @property summary - 軽量レスポンスモード（デフォルトfalse）
 */
export const projectGetInputSchema = z.object({
  id: z.string().uuid({ message: '有効なUUID形式のIDを指定してください' }),
  summary: z.boolean().optional(),
}).transform((data) => ({
  ...data,
  summary: data.summary ?? getSummaryDefault(),
}));

/**
 * project.get ツールの入力型
 */
export type ProjectGetInput = z.infer<typeof projectGetInputSchema>;

// =============================================================================
// 出力スキーマ
// =============================================================================

// [DELETED Phase 1] pageInfoSchema removed (ProjectPage table deleted)

/**
 * ブランド設定情報のスキーマ
 */
export const brandSettingInfoSchema = z.object({
  id: z.string(),
  brandId: z.string().nullable(),
  paletteId: z.string().nullable(),
});

/**
 * ブランド設定情報の型
 */
export type BrandSettingInfo = z.infer<typeof brandSettingInfoSchema>;

/**
 * project.get ツールのフル出力スキーマ
 */
export const projectGetOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  brandSetting: brandSettingInfoSchema.nullable(),
});

/**
 * project.get ツールのフル出力型
 */
export type ProjectGetOutput = z.infer<typeof projectGetOutputSchema>;

/**
 * project.get ツールのサマリー出力スキーマ
 */
export const projectGetSummaryOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  _summary_mode: z.literal(true),
});

/**
 * project.get ツールのサマリー出力型
 */
export type ProjectGetSummaryOutput = z.infer<typeof projectGetSummaryOutputSchema>;

// =============================================================================
// project.list スキーマ
// =============================================================================

/**
 * プロジェクトステータスのスキーマ
 */
export const projectStatusSchema = z.enum([
  'draft',
  'in_progress',
  'review',
  'completed',
  'archived',
]);

/**
 * プロジェクトステータスの型
 */
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

/**
 * ソート項目のスキーマ
 */
export const projectSortBySchema = z.enum(['createdAt', 'updatedAt', 'name']);

/**
 * ソート項目の型
 */
export type ProjectSortBy = z.infer<typeof projectSortBySchema>;

/**
 * ソート順のスキーマ
 */
export const projectSortOrderSchema = z.enum(['asc', 'desc']);

/**
 * ソート順の型
 */
export type ProjectSortOrder = z.infer<typeof projectSortOrderSchema>;

/**
 * project.list ツールの入力スキーマ
 *
 * @property status - プロジェクトステータスでフィルタ（オプション）
 * @property limit - 取得件数（1-50、デフォルト: 10）
 * @property offset - オフセット（デフォルト: 0）
 * @property sortBy - ソート項目（デフォルト: updatedAt）
 * @property sortOrder - ソート順（デフォルト: desc）
 * @property summary - 軽量レスポンスモード（デフォルトfalse）
 */
export const projectListInputSchema = z.object({
  status: projectStatusSchema.optional(),
  limit: z
    .number()
    .int()
    .min(1, { message: 'limitは1以上の整数を指定してください' })
    .max(50, { message: 'limitは50以下の整数を指定してください' })
    .optional()
    .default(10),
  offset: z
    .number()
    .int()
    .min(0, { message: 'offsetは0以上の整数を指定してください' })
    .optional()
    .default(0),
  sortBy: projectSortBySchema.optional().default('updatedAt'),
  sortOrder: projectSortOrderSchema.optional().default('desc'),
  summary: z.boolean().optional(),
}).transform((data) => ({
  ...data,
  summary: data.summary ?? getSummaryDefault(),
}));

/**
 * project.list ツールの入力型
 */
export type ProjectListInput = z.infer<typeof projectListInputSchema>;

/**
 * プロジェクト一覧アイテム（フル）のスキーマ
 */
export const projectListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  brandSetting: brandSettingInfoSchema.nullable(),
});

/**
 * プロジェクト一覧アイテム（フル）の型
 */
export type ProjectListItem = z.infer<typeof projectListItemSchema>;

/**
 * プロジェクト一覧アイテム（サマリー）のスキーマ
 */
export const projectListItemSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

/**
 * プロジェクト一覧アイテム（サマリー）の型
 */
export type ProjectListItemSummary = z.infer<typeof projectListItemSummarySchema>;

/**
 * project.list ツールのフル出力スキーマ
 */
export const projectListOutputSchema = z.object({
  projects: z.array(projectListItemSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

/**
 * project.list ツールのフル出力型
 */
export type ProjectListOutput = z.infer<typeof projectListOutputSchema>;

/**
 * project.list ツールのサマリー出力スキーマ
 */
export const projectListSummaryOutputSchema = z.object({
  projects: z.array(projectListItemSummarySchema),
  total: z.number(),
  _summary_mode: z.literal(true),
});

/**
 * project.list ツールのサマリー出力型
 */
export type ProjectListSummaryOutput = z.infer<typeof projectListSummaryOutputSchema>;
