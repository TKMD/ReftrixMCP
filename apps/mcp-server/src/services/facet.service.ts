// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Facet Service
 * ファセットサービス
 *
 * 検索結果セットからリアルタイムにファセットカウントを算出する。
 * 対応フィールド: sectionType, industry, audience, tags
 *
 * Computes facet counts from search result sets in real-time.
 * Supported fields: sectionType, industry, audience, tags
 *
 * @module services/facet.service
 */

import type { UnifiedSearchResultItem } from "../tools/search-unified.tool";

// =====================================================
// Types / 型定義
// =====================================================

/**
 * サポートされるファセットフィールド / Supported facet fields
 */
export type FacetField = "sectionType" | "industry" | "audience" | "tags";

/**
 * ファセットカウントの1項目 / Single facet count item
 */
export interface FacetCountItem {
  /** 値 / Value */
  value: string;
  /** 件数 / Count */
  count: number;
}

/**
 * ファセットカウントの結果 / Facet counts result
 */
export type FacetCounts = Partial<Record<FacetField, FacetCountItem[]>>;

// =====================================================
// Constants / 定数
// =====================================================

/**
 * サポートされるファセットフィールドの一覧
 * List of supported facet fields
 */
export const SUPPORTED_FACET_FIELDS: readonly FacetField[] = [
  "sectionType",
  "industry",
  "audience",
  "tags",
] as const;

// =====================================================
// Metadata field mapping / メタデータフィールドマッピング
// =====================================================

/**
 * ファセットフィールドに対応するmetadataキーのマッピング
 * Metadata key mapping for facet fields
 *
 * sectionType は layout の sectionType と part の partType の両方から取得する。
 * sectionType is derived from both layout's sectionType and part's partType.
 */
const FACET_METADATA_KEYS: Record<FacetField, string[]> = {
  sectionType: ["sectionType", "partType", "patternType"],
  industry: ["industry"],
  audience: ["audience"],
  tags: ["tags"],
};

// =====================================================
// computeFacetsFromResults / 結果セットからファセット算出
// =====================================================

/**
 * 検索結果セットからファセットカウントを算出する
 * Compute facet counts from search result set
 *
 * 各結果の metadata フィールドからファセット値を抽出し、
 * カウント降順でソートして返却する。
 *
 * Extracts facet values from each result's metadata,
 * returns them sorted by count descending.
 *
 * @param results - 統一検索結果 / Unified search results
 * @param fields - 算出するファセットフィールド / Facet fields to compute
 * @returns ファセットカウント / Facet counts
 */
export function computeFacetsFromResults(
  results: UnifiedSearchResultItem[],
  fields: FacetField[]
): FacetCounts {
  const facets: FacetCounts = {};

  for (const field of fields) {
    const counterMap = new Map<string, number>();
    const metadataKeys = FACET_METADATA_KEYS[field];

    for (const result of results) {
      if (!result.metadata) continue;

      for (const key of metadataKeys) {
        const value = result.metadata[key];

        if (value === undefined || value === null) continue;

        if (field === "tags" && Array.isArray(value)) {
          // tags: 配列を展開して個別にカウント
          // tags: flatten arrays and count individually
          for (const tag of value) {
            if (typeof tag === "string" && tag.length > 0) {
              counterMap.set(tag, (counterMap.get(tag) ?? 0) + 1);
            }
          }
        } else if (typeof value === "string" && value.length > 0) {
          counterMap.set(value, (counterMap.get(value) ?? 0) + 1);
        }
      }
    }

    // カウント降順でソート / Sort by count descending
    const sorted: FacetCountItem[] = Array.from(counterMap.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count);

    facets[field] = sorted;
  }

  return facets;
}
