// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 共通検索フィルタースキーマ / Common Search Filters Schema
 *
 * 検索サービス（layout, motion, narrative, background, responsive）で共通利用。
 * part, search.unified, design は独自スキーマを使用。
 *
 * Common filter parameters shared by search services
 * (layout, motion, narrative, background, responsive).
 * part, search.unified, and design use their own schemas.
 *
 * @module schemas/common-search-filters
 */

import { z } from "zod";

/**
 * 共通検索フィルタースキーマ
 * Common search filters schema
 *
 * 各検索ツールのスキーマに `.extend()` または `.merge()` で統合して使用。
 * Use with `.extend()` or `.merge()` in each search tool's schema.
 */
export const commonSearchFiltersSchema = z.object({
  /** WebページIDでフィルター / Filter by web page ID */
  webPageId: z.string().uuid().optional(),
  /** WebページURLでフィルター / Filter by web page URL */
  webPageUrl: z.string().url().optional(),
  /** 業種フィルター / Industry filter (e.g., "tech", "finance", "healthcare") */
  industry: z.string().max(100).optional(),
  /** ターゲットオーディエンス / Target audience (e.g., "b2b", "b2c", "enterprise") */
  audience: z.string().max(100).optional(),
  /** タグフィルター / Tag filter */
  tags: z.array(z.string().max(50)).max(10).optional(),
});

/**
 * 共通検索フィルター型 / Common search filters type
 */
export type CommonSearchFilters = z.infer<typeof commonSearchFiltersSchema>;
