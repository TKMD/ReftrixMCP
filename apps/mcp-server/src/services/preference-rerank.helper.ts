// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference-rerank.helper.ts
 * 嗜好プロファイルに基づく検索結果リランキングヘルパー
 *
 * 機能:
 * - 検索結果をユーザーの嗜好プロファイル（preference_embedding）で再ランキング
 * - cosine similarity によるスコア調整
 * - confidence不足時のグレースフルフォールバック（元の順序を維持）
 *
 * preference-rerank.helper.ts
 * Search result reranking helper based on user preference profiles
 *
 * Features:
 * - Rerank search results using user preference profile (preference_embedding)
 * - Score adjustment via cosine similarity
 * - Graceful fallback when confidence is insufficient (preserve original order)
 *
 * @module services/preference-rerank.helper
 */

import { logger } from "../utils/logger";
import { cosineSimilarity, parseVectorString as parseVectorStringUtil } from "../utils/vector-math";
import { truncateId } from "../tools/preference/schemas";
import type { IPrismaClient } from "./preference-profile.service";

// =====================================================
// 定数 / Constants
// =====================================================

/**
 * デフォルトのリランキング重み（嗜好スコアの寄与率）
 * Default reranking weight (contribution of preference score)
 */
export const DEFAULT_RERANK_ALPHA = 0.3;

/**
 * リランキング適用に必要な最低インタラクション数
 * Minimum number of interactions required to apply reranking
 */
export const MIN_INTERACTIONS_FOR_RERANK = 5;

// =====================================================
// Embedding ドメイン設定 / Embedding Domain Config
// =====================================================

/**
 * リランキング対象のドメイン
 * Reranking target domain
 */
export type EmbeddingDomain = "layout" | "motion" | "background" | "narrative" | "responsive";

/**
 * ドメインごとのembeddingテーブル設定
 * Embedding table config per domain
 *
 * テーブル名・カラム名はすべてハードコード定数であり、
 * ユーザー入力由来ではないためSQLインジェクションリスクなし。
 *
 * Table/column names are all hardcoded constants (not from user input),
 * so there is no SQL injection risk.
 */
const DOMAIN_EMBEDDING_CONFIG: Record<
  EmbeddingDomain,
  { table: string; fkColumn: string; embeddingExpr: string }
> = {
  layout: {
    table: "section_embeddings",
    fkColumn: "section_pattern_id",
    embeddingExpr: "COALESCE(combined_embedding, text_embedding)",
  },
  motion: {
    table: "motion_embeddings",
    fkColumn: "motion_pattern_id",
    embeddingExpr: "embedding",
  },
  background: {
    table: "background_design_embeddings",
    fkColumn: "background_design_id",
    embeddingExpr: "embedding",
  },
  narrative: {
    table: "design_narrative_embeddings",
    fkColumn: "design_narrative_id",
    embeddingExpr: "embedding",
  },
  responsive: {
    table: "responsive_analysis_embeddings",
    // responsive searchは rae.id（embedding行PK）をitem.idとして返すため、
    // FKではなくPKで検索する
    // responsive search returns rae.id (embedding row PK) as item.id,
    // so search by PK instead of FK
    fkColumn: "id",
    embeddingExpr: "embedding",
  },
};

// =====================================================
// インターフェース / Interfaces
// =====================================================

/**
 * リランキングオプション
 * Reranking options
 */
export interface RerankOptions {
  /** 嗜好重み（0-1、デフォルト0.3） / Preference weight (0-1, default 0.3) */
  alpha?: number;
  /** 最低confidence閾値（デフォルト0.8） / Minimum confidence threshold (default 0.8) */
  minConfidence?: number;
  /** embeddingドメイン（DB取得用） / Embedding domain (for DB fetch) */
  domain?: EmbeddingDomain;
}

/**
 * リランキング可能なアイテム
 * Rerankable item
 */
export interface RerankableItem {
  /** アイテムID / Item ID */
  id: string;
  /** 既存の検索スコア（0-1） / Existing search score (0-1) */
  similarity: number;
  /** 結果のembeddingベクトル（768D） / Result embedding vector (768D) */
  embedding?: number[];
  /** その他のフィールドを透過 / Pass through other fields */
  [key: string]: unknown;
}

/**
 * リランキング結果
 * Reranking result
 */
export interface RerankResult<T extends RerankableItem> {
  /** リランキング後のアイテム配列 / Items after reranking */
  items: T[];
  /** リランキングが適用されたか / Whether reranking was applied */
  reranked: boolean;
  /** 適用されなかった場合の理由 / Reason if not applied */
  reason?: string;
}

// =====================================================
// DB行型 / Database Row Types
// =====================================================

/**
 * preference_profiles テーブルの部分行型（リランキング用）
 * Partial row type for preference_profiles table (for reranking)
 */
interface PreferenceEmbeddingRow {
  preference_embedding: string | null;
  interaction_count: number | bigint;
}

/**
 * アイテムembedding取得結果の行型
 * Row type for item embedding fetch result
 */
interface ItemEmbeddingRow {
  item_id: string;
  embedding: string;
}

// =====================================================
// 純粋関数 / Pure Functions
// =====================================================

// cosineSimilarity は ../utils/vector-math から re-export
// cosineSimilarity is re-exported from ../utils/vector-math
export { cosineSimilarity };

/**
 * pgvector文字列をnumber[]にパース（NaN含有時は空配列）
 * Parse pgvector string to number[] (returns empty array on NaN)
 *
 * @param vectorStr - pgvector文字列 / pgvector string
 * @returns パースされたnumber配列 / Parsed number array
 */
function parseVectorString(vectorStr: string): number[] {
  const result = parseVectorStringUtil(vectorStr, { nanStrategy: "passthrough" });
  if (!result || result.length === 0) {
    if (result !== null || vectorStr.length > 2) {
      logger.warn(
        "[PreferenceRerank] Non-finite value detected in vector string, returning empty",
        {
          vectorStrLength: vectorStr.length,
        }
      );
    }
    return [];
  }
  return result;
}

// =====================================================
// データアクセス / Data Access
// =====================================================

/**
 * 嗜好プロファイルのembeddingとインタラクション数を取得
 * Get preference profile embedding and interaction count
 *
 * preference_profiles テーブルから preference_embedding と interaction_count を取得する。
 * embedding は PostgreSQL の vector 型から number[] に変換される。
 *
 * Fetches preference_embedding and interaction_count from the preference_profiles table.
 * The embedding is converted from PostgreSQL vector type to number[].
 *
 * @param profileId - プロファイルID（UUID） / Profile ID (UUID)
 * @param prisma - PrismaClientインスタンス / PrismaClient instance
 * @returns embedding（null可）とインタラクション数 / embedding (nullable) and interaction count
 */
export async function getPreferenceEmbedding(
  profileId: string,
  prisma: IPrismaClient
): Promise<{ embedding: number[] | null; interactionCount: number }> {
  try {
    const rows = await prisma.$queryRawUnsafe<PreferenceEmbeddingRow[]>(
      `SELECT preference_embedding::text AS preference_embedding, interaction_count
       FROM preference_profiles
       WHERE id = $1::uuid`,
      profileId
    );

    const row = rows[0];
    if (!row) {
      return { embedding: null, interactionCount: 0 };
    }

    const interactionCount = Number(row.interaction_count);

    if (!row.preference_embedding) {
      return { embedding: null, interactionCount };
    }

    const embedding = parseVectorString(row.preference_embedding);

    return { embedding, interactionCount };
  } catch (error) {
    // 全環境でログ出力（isDevelopmentガードなし）
    // Log in all environments (no isDevelopment guard)
    logger.warn("[PreferenceRerank] Failed to get preference embedding", {
      profileId: truncateId(profileId),
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return { embedding: null, interactionCount: 0 };
  }
}

/**
 * ドメインのembeddingテーブルからアイテムのembeddingを一括取得
 * Batch-fetch item embeddings from domain embedding table
 *
 * @param itemIds - アイテムID配列 / Item ID array
 * @param domain - embeddingドメイン / Embedding domain
 * @param prisma - PrismaClientインスタンス / PrismaClient instance
 * @returns アイテムID → embedding のMap / Map of item ID to embedding
 */
async function fetchItemEmbeddings(
  itemIds: string[],
  domain: EmbeddingDomain,
  prisma: IPrismaClient
): Promise<Map<string, number[]>> {
  const config = DOMAIN_EMBEDDING_CONFIG[domain];
  const map = new Map<string, number[]>();

  if (itemIds.length === 0) {
    return map;
  }

  try {
    // テーブル名・カラム名はハードコード定数のためSQLインジェクションリスクなし
    // Table/column names are hardcoded constants, no SQL injection risk
    const query = `SELECT ${config.fkColumn}::text AS item_id, (${config.embeddingExpr})::text AS embedding
       FROM ${config.table}
       WHERE ${config.fkColumn} = ANY($1::uuid[])
       AND ${config.embeddingExpr} IS NOT NULL`;

    const rows = await prisma.$queryRawUnsafe<ItemEmbeddingRow[]>(query, itemIds);

    for (const row of rows) {
      if (row.embedding) {
        map.set(row.item_id, parseVectorString(row.embedding));
      }
    }
  } catch (error) {
    logger.warn("[PreferenceRerank] Failed to fetch item embeddings", {
      domain,
      itemCount: itemIds.length,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return map;
}

// =====================================================
// リランキング / Reranking
// =====================================================

/**
 * 嗜好プロファイルに基づいて検索結果をリランキング
 * Rerank search results based on preference profile
 *
 * final_score = (1 - alpha) * item.similarity + alpha * prefSimilarity
 *
 * 以下の場合はリランキングを適用せず、元の結果をそのまま返す:
 * - プロファイルが見つからない
 * - preference_embedding が NULL
 * - interaction_count が MIN_INTERACTIONS_FOR_RERANK 未満
 * - アイテムにembeddingが含まれていない
 *
 * Returns original results without reranking in the following cases:
 * - Profile not found
 * - preference_embedding is NULL
 * - interaction_count is below MIN_INTERACTIONS_FOR_RERANK
 * - Items do not contain embeddings
 *
 * @param results - 検索結果配列 / Search result array
 * @param profileId - プロファイルID（UUID） / Profile ID (UUID)
 * @param prisma - PrismaClientインスタンス / PrismaClient instance
 * @param options - リランキングオプション / Reranking options
 * @returns リランキング結果 / Reranking result
 */
export async function rerankWithPreference<T extends RerankableItem>(
  results: T[],
  profileId: string,
  prisma: IPrismaClient,
  options?: RerankOptions
): Promise<RerankResult<T>> {
  const alpha = options?.alpha ?? DEFAULT_RERANK_ALPHA;

  // 空の結果の場合は早期リターン
  // Early return for empty results
  if (results.length === 0) {
    return { items: results, reranked: false, reason: "検索結果が空です / No search results" };
  }

  // 嗜好プロファイルのembeddingを取得
  // Get preference profile embedding
  const { embedding: preferenceEmbedding, interactionCount } = await getPreferenceEmbedding(
    profileId,
    prisma
  );

  // preference_embedding が NULL の場合
  // When preference_embedding is NULL
  if (!preferenceEmbedding) {
    return {
      items: results,
      reranked: false,
      reason:
        "嗜好embeddingが未生成です（フィードバックが記録されていません） / Preference embedding not yet generated (no feedback recorded)",
    };
  }

  // interaction_count が閾値未満の場合
  // When interaction_count is below threshold
  if (interactionCount < MIN_INTERACTIONS_FOR_RERANK) {
    return {
      items: results,
      reranked: false,
      reason: `インタラクション数が不足しています（${interactionCount}/${MIN_INTERACTIONS_FOR_RERANK}） / Insufficient interactions (${interactionCount}/${MIN_INTERACTIONS_FOR_RERANK})`,
    };
  }

  // アイテムのembeddingを準備（インラインまたはDB取得）
  // Prepare item embeddings (inline or DB fetch)
  let itemEmbeddingMap: Map<string, number[]> | null = null;

  const itemsWithEmbedding = results.filter(
    (item) => item.embedding && Array.isArray(item.embedding) && item.embedding.length > 0
  );

  if (itemsWithEmbedding.length === 0 && options?.domain) {
    // アイテムにembeddingがない場合、ドメインのDBテーブルから一括取得
    // When items lack embeddings, batch-fetch from domain embedding table
    const itemIds = results.map((item) => item.id);
    itemEmbeddingMap = await fetchItemEmbeddings(itemIds, options.domain, prisma);

    if (itemEmbeddingMap.size === 0) {
      return {
        items: results,
        reranked: false,
        reason: "DB上にembeddingが見つかりません / No embeddings found in DB",
      };
    }
  } else if (itemsWithEmbedding.length === 0) {
    return {
      items: results,
      reranked: false,
      reason: "検索結果にembeddingが含まれていません / Search results do not contain embeddings",
    };
  }

  // リランキングスコアを計算
  // Calculate reranking scores
  const scored = results.map((item) => {
    // インラインembeddingまたはDB取得embeddingを使用
    // Use inline embedding or DB-fetched embedding
    const itemEmbedding =
      item.embedding && Array.isArray(item.embedding) && item.embedding.length > 0
        ? item.embedding
        : (itemEmbeddingMap?.get(item.id) ?? null);

    if (!itemEmbedding) {
      // embedding がないアイテムは元のスコアを維持
      // Items without embedding keep their original score
      return { item, finalScore: item.similarity };
    }

    const prefSimilarity = cosineSimilarity(itemEmbedding, preferenceEmbedding);
    const finalScore = (1 - alpha) * item.similarity + alpha * prefSimilarity;

    return { item, finalScore };
  });

  // final_score降順でソート
  // Sort by final_score descending
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // 元のアイテムのフィールドをすべて透過（similarity を更新）
  // Pass through all original item fields (update similarity)
  const rerankedItems = scored.map(({ item, finalScore }) => ({
    ...item,
    similarity: finalScore,
  }));

  // 全環境でログ出力（isDevelopmentガードなし）
  // Log in all environments (no isDevelopment guard)
  logger.info("[PreferenceRerank] Reranking applied", {
    profileId: truncateId(profileId),
    alpha,
    interactionCount,
    totalItems: results.length,
    itemsWithEmbedding: itemsWithEmbedding.length,
    itemsFromDb: itemEmbeddingMap?.size ?? 0,
    domain: options?.domain ?? "none",
  });

  return {
    items: rerankedItems,
    reranked: true,
  };
}

// =====================================================
// 統合ヘルパー / Integrated Helper
// =====================================================

/**
 * 検索結果にpreference rerankingを適用する統合ヘルパー
 * Integrated helper to apply preference reranking to search results
 *
 * @param results - 検索結果配列 / Search result array
 * @param profileId - プロファイルID（undefinedの場合はスキップ） / Profile ID (skip if undefined)
 * @param prismaFactory - PrismaClientファクトリ / PrismaClient factory
 * @param domain - embeddingドメイン / Embedding domain
 * @param toolName - ログ用ツール名 / Tool name for logging
 * @returns リランキング済み結果（または元の結果） / Reranked results (or original)
 */
export async function applyPreferenceReranking<T extends { id: string; similarity: number }>(
  results: T[],
  profileId: string | undefined,
  prismaFactory: (() => IPrismaClient) | null,
  domain: EmbeddingDomain,
  toolName: string
): Promise<T[]> {
  if (!profileId || results.length === 0 || !prismaFactory) {
    return results;
  }

  try {
    const prisma = prismaFactory();
    const rerankableItems: RerankableItem[] = results.map((item) => ({
      ...item,
      id: item.id,
      similarity: item.similarity,
    }));
    const rerankResult = await rerankWithPreference(rerankableItems, profileId, prisma, { domain });

    if (rerankResult.reranked) {
      logger.info(`[MCP Tool] ${toolName} preference reranking applied`, {
        profileId: truncateId(profileId),
        resultCount: results.length,
      });
      return rerankResult.items as T[];
    }

    logger.info(`[MCP Tool] ${toolName} preference reranking skipped`, {
      profileId: truncateId(profileId),
      reason: rerankResult.reason,
    });
    return results;
  } catch (error) {
    logger.warn(`[MCP Tool] ${toolName} preference reranking failed`, {
      profileId: truncateId(profileId),
      error: error instanceof Error ? error.message : String(error),
    });
    return results;
  }
}
