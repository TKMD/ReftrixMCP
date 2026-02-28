// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Motion Search Service Export Layer
 * motionSearchHandlerを外部モジュールから直接使用可能にするエクスポート層
 *
 * @module @reftrix/mcp-server/services/motion-search-service
 */

import { motionSearchHandler } from '../tools/motion/search.tool';
import type {
  MotionSearchInput,
  MotionSearchOutput,
} from '../tools/motion';

/**
 * モーションパターン検索を実行
 *
 * @param input - 検索パラメータ
 * @returns 検索結果（success/error構造）
 */
export async function executeMotionSearch(input: MotionSearchInput): Promise<MotionSearchOutput> {
  return await motionSearchHandler(input);
}

// 型エクスポート
export type {
  MotionSearchInput,
  MotionSearchOutput,
  MotionSearchParams,
  MotionSearchResult,
  MotionSearchData,
  MotionSearchError,
  MotionSearchResultItem,
  MotionSearchFilters,
  MotionSearchType,
  MotionSearchTrigger,
  MotionSearchSource,
  MotionSearchQueryInfo,
} from '../tools/motion';
