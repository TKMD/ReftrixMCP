// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.search MCPツール用Service層エクスポート
 * Service関数をエクスポート
 *
 * @module services/layout-search-service-export
 */

import { layoutSearchHandler } from '../tools/layout/search.tool';
import type {
  LayoutSearchInput,
  LayoutSearchOutput,
} from '../tools/layout/schemas';

/**
 * layout.searchツールを直接実行するService関数
 * 外部モジュールから直接呼び出し可能
 *
 * @param input - layout.search入力パラメータ
 * @returns layout.searchの実行結果
 * @throws エラーが発生した場合、LayoutSearchErrorOutputで返却される
 *
 * @example
 * ```typescript
 * const result = await executeLayoutSearch({
 *   query: 'modern hero section with gradient',
 *   filters: {
 *     sectionType: 'hero',
 *     sourceType: 'award_gallery',
 *   },
 *   limit: 10,
 *   offset: 0,
 * });
 *
 * if (result.success) {
 *   console.log('Search results:', result.data.results);
 * } else {
 *   console.error('Search failed:', result.error);
 * }
 * ```
 */
export async function executeLayoutSearch(
  input: LayoutSearchInput
): Promise<LayoutSearchOutput> {
  return await layoutSearchHandler(input);
}

// 型をre-export
export type {
  LayoutSearchInput,
  LayoutSearchOutput,
  LayoutSearchData,
  LayoutSearchErrorInfo,
  LayoutSearchResultItem,
  LayoutSearchFilters,
  LayoutSearchPreview,
  LayoutSearchSource,
} from '../tools/layout/schemas';
