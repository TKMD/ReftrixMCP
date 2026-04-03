// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-Encoder Reranking Service
 * Cross-Encoderリランキングサービス
 *
 * 検索結果をCross-Encoderモデルで再ランク付けする。
 * ONNX Runtimeでのms-marco-MiniLM-L-6-v2相当のモデルを使用。
 * モデル未ロード時はcosine similarityベースのフォールバックリランキング。
 *
 * Reranks search results using Cross-Encoder model.
 * Uses ms-marco-MiniLM-L-6-v2 equivalent model via ONNX Runtime.
 * Falls back to cosine similarity-based reranking when model is not loaded.
 *
 * Features / 機能:
 * - Cross-Encoder ONNX inference (future)
 * - Cosine similarity fallback reranking
 * - Graceful Degradation on failure
 * - Alpha blending (original score + rerank score)
 * - top_k selective reranking
 *
 * @module services/search/cross-encoder-rerank.service
 */

import { logger } from "../../utils/logger";
import { cosineSimilarity } from "../../utils/vector-math";

// =====================================================
// Types / 型定義
// =====================================================

/**
 * リランキング可能なアイテム / Rerankable item
 */
export interface CrossEncoderRerankableItem {
  /** アイテムID / Item ID */
  id: string;
  /** 既存の検索スコア（0-1） / Existing search score (0-1) */
  similarity: number;
  /** 結果のembeddingベクトル（768D） / Result embedding vector (768D) */
  embedding?: number[] | undefined;
  /** テキストコンテンツ（Cross-Encoder用） / Text content (for Cross-Encoder) */
  text?: string | undefined;
  /** その他のフィールドを透過 / Pass through other fields */
  [key: string]: unknown;
}

/**
 * リランキングオプション / Reranking options
 */
export interface CrossEncoderRerankOptions {
  /** リランキングモード / Reranking mode
   * - "cross_encoder": ONNXモデルでリランキング（未実装、自動フォールバック）
   * - "cosine_fallback": コサインフォールバック
   */
  mode?: "cross_encoder" | "cosine_fallback" | undefined;
  /** クエリembedding（cosine fallback用） / Query embedding (for cosine fallback) */
  queryEmbedding?: number[] | undefined;
  /** alphaブレンド重み（0: original only, 1: rerank only, default: 0.5）
   * final_score = (1 - alpha) * original_score + alpha * rerank_score
   */
  alpha?: number | undefined;
  /** 上位N件のみリランキング / Only rerank top N items */
  topK?: number | undefined;
}

/**
 * リランキング結果 / Reranking result
 */
export interface CrossEncoderRerankResult<T extends CrossEncoderRerankableItem> {
  /** リランキング後のアイテム配列 / Items after reranking */
  items: T[];
  /** リランキングが適用されたか / Whether reranking was applied */
  reranked: boolean;
  /** 使用されたリランキング手法 / Method used for reranking */
  method: "cross_encoder" | "cosine_fallback" | "none";
  /** 適用されなかった場合の理由 / Reason if not applied */
  reason?: string;
}

/**
 * Cross-Encoderリランキングサービスインターフェース
 * Cross-Encoder reranking service interface
 */
export interface CrossEncoderRerankService {
  /** リランキングを実行 / Execute reranking */
  rerank<T extends CrossEncoderRerankableItem>(
    items: T[],
    query: string,
    options?: CrossEncoderRerankOptions
  ): Promise<CrossEncoderRerankResult<T>>;
  /** モデルがロードされているか / Is model loaded */
  isModelLoaded(): boolean;
}

// =====================================================
// Constants / 定数
// =====================================================

/**
 * デフォルトのalphaブレンド重み
 * Default alpha blending weight
 */
const DEFAULT_ALPHA = 0.5;

/**
 * コサインスコアの最小値クランプ
 * Minimum cosine score clamp
 */
const MIN_SCORE = 0;

/**
 * コサインスコアの最大値クランプ
 * Maximum cosine score clamp
 */
const MAX_SCORE = 1;

// =====================================================
// Cosine Fallback / コサインフォールバック
// =====================================================

/**
 * コサインフォールバックスコアを計算する
 * Compute cosine fallback scores
 *
 * queryEmbeddingと各アイテムのembeddingのコサイン類似度を計算する。
 * embeddingがないアイテムにはスコア0を割り当てる。
 *
 * Computes cosine similarity between queryEmbedding and each item's embedding.
 * Assigns score 0 to items without embedding.
 *
 * @param items - リランキング対象のアイテム / Items to rerank
 * @param queryEmbedding - クエリembedding / Query embedding
 * @returns アイテムID → コサインスコアのMap / Map of item ID to cosine score
 */
export function computeCosineFallbackScores<T extends CrossEncoderRerankableItem>(
  items: T[],
  queryEmbedding: number[]
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const item of items) {
    if (item.embedding && Array.isArray(item.embedding) && item.embedding.length > 0) {
      const sim = cosineSimilarity(item.embedding, queryEmbedding);
      // NaN/Infinity防御 + 0-1クランプ
      // NaN/Infinity defense + 0-1 clamp
      const clampedScore = Number.isFinite(sim)
        ? Math.max(MIN_SCORE, Math.min(MAX_SCORE, (sim + 1) / 2)) // [-1,1] → [0,1]
        : 0;
      scores.set(item.id, clampedScore);
    } else {
      scores.set(item.id, 0);
    }
  }

  return scores;
}

// =====================================================
// Main Reranking / メインリランキング
// =====================================================

/**
 * Cross-Encoderリランキングを実行する
 * Execute Cross-Encoder reranking
 *
 * 現在のフロー:
 * 1. モデルロード状態をチェック
 * 2. モデルがある場合 → Cross-Encoder推論（将来実装）
 * 3. モデルがない場合 → コサインフォールバック
 * 4. コサインフォールバックも不可の場合 → 元の順序を維持
 *
 * Current flow:
 * 1. Check model load state
 * 2. If model available → Cross-Encoder inference (future)
 * 3. If no model → Cosine fallback
 * 4. If cosine fallback not possible → Maintain original order
 *
 * @param items - リランキング対象のアイテム / Items to rerank
 * @param query - 検索クエリ / Search query
 * @param options - リランキングオプション / Reranking options
 * @returns リランキング結果 / Reranking result
 */
export async function rerankWithCrossEncoder<T extends CrossEncoderRerankableItem>(
  items: T[],
  _query: string, // 将来のCross-Encoderモデル推論用 / For future Cross-Encoder model inference
  options?: CrossEncoderRerankOptions
): Promise<CrossEncoderRerankResult<T>> {
  const alpha = options?.alpha ?? DEFAULT_ALPHA;

  // 空の結果 / Empty results
  if (items.length === 0) {
    return {
      items: [],
      reranked: false,
      method: "none",
      reason: "Results are empty / 検索結果が空です",
    };
  }

  // 単一アイテム / Single item
  if (items.length === 1) {
    return {
      items: [...items],
      reranked: false,
      method: "none",
      reason: "Single result, reranking not needed / 結果が1件のためリランキング不要",
    };
  }

  try {
    // コサインフォールバックモード / Cosine fallback mode
    if (!options?.queryEmbedding) {
      // queryEmbeddingがない場合はoriginal score順でソート
      // If no queryEmbedding, sort by original score
      const sorted = [...items].sort((a, b) => b.similarity - a.similarity);
      return {
        items: sorted,
        reranked: false,
        method: "none",
        reason:
          "Query embedding not available for reranking / クエリembeddingがリランキングに利用できません",
      };
    }

    // top_k制御: 上位N件のみリランキング対象
    // top_k control: only rerank top N items
    const topK = options?.topK;
    let itemsToRerank: T[];
    let remainingItems: T[];

    if (topK && topK > 0 && topK < items.length) {
      // original score順でソートしてから上位N件を選択
      // Sort by original score, then select top N
      const sortedByOriginal = [...items].sort((a, b) => b.similarity - a.similarity);
      itemsToRerank = sortedByOriginal.slice(0, topK);
      remainingItems = sortedByOriginal.slice(topK);
    } else {
      itemsToRerank = [...items];
      remainingItems = [];
    }

    // コサインフォールバックスコアを計算
    // Compute cosine fallback scores
    const rerankScores = computeCosineFallbackScores(itemsToRerank, options.queryEmbedding);

    // Alpha blending: final_score = (1 - alpha) * original + alpha * rerank
    const scoredItems = itemsToRerank.map((item) => {
      const rerankScore = rerankScores.get(item.id) ?? 0;
      const finalScore = (1 - alpha) * item.similarity + alpha * rerankScore;
      // NaN/Infinity防御 + 0-1クランプ
      const clampedFinal = Number.isFinite(finalScore)
        ? Math.max(MIN_SCORE, Math.min(MAX_SCORE, finalScore))
        : item.similarity;

      return {
        item,
        finalScore: clampedFinal,
      };
    });

    // finalScore降順でソート
    // Sort by finalScore descending
    scoredItems.sort((a, b) => b.finalScore - a.finalScore);

    // similarityを更新してアイテムを構築
    // Update similarity and build items
    const rerankedItems = scoredItems.map(({ item, finalScore }) => ({
      ...item,
      similarity: finalScore,
    }));

    // 残りのアイテムを追加
    // Append remaining items
    const allItems = [...rerankedItems, ...remainingItems];

    logger.info("[CrossEncoderRerank] Reranking applied (cosine fallback)", {
      totalItems: items.length,
      rerankedItems: itemsToRerank.length,
      alpha,
      topK: topK ?? "all",
    });

    return {
      items: allItems,
      reranked: true,
      method: "cosine_fallback",
    };
  } catch (error) {
    // Graceful Degradation: エラー時は元のsimilarity順でソート
    // Graceful Degradation: sort by original similarity on error
    logger.warn("[CrossEncoderRerank] Reranking failed, falling back to original order", {
      error: error instanceof Error ? error.message : String(error),
    });

    const sorted = [...items].sort((a, b) => b.similarity - a.similarity);
    return {
      items: sorted,
      reranked: false,
      method: "none",
      reason: "Reranking failed: an internal error occurred",
    };
  }
}

// =====================================================
// Factory / ファクトリ
// =====================================================

/**
 * Cross-Encoderリランキングサービスを作成する
 * Create a Cross-Encoder reranking service
 *
 * ONNXモデルのロード・推論を管理するサービスインスタンスを作成する。
 * 現在はコサインフォールバックモードのみ実装。
 *
 * Creates a service instance that manages ONNX model loading and inference.
 * Currently only cosine fallback mode is implemented.
 *
 * @returns Cross-Encoderリランキングサービスインスタンス
 */
export function createCrossEncoderRerankService(): CrossEncoderRerankService {
  // 将来: ONNXモデルのロード状態を管理
  // Future: manage ONNX model loading state
  let modelLoaded = false;

  return {
    async rerank<T extends CrossEncoderRerankableItem>(
      items: T[],
      query: string,
      options?: CrossEncoderRerankOptions
    ): Promise<CrossEncoderRerankResult<T>> {
      // モデルがロードされていない場合はコサインフォールバック
      // Fall back to cosine if model not loaded
      const effectiveOptions: CrossEncoderRerankOptions = {
        ...options,
        mode: modelLoaded ? (options?.mode ?? "cross_encoder") : "cosine_fallback",
      };

      return rerankWithCrossEncoder(items, query, effectiveOptions);
    },

    isModelLoaded(): boolean {
      return modelLoaded;
    },
  };
}

// =====================================================
// Utility Exports / ユーティリティエクスポート
// =====================================================

/**
 * 検索結果にCross-Encoderリランキングを適用する統合ヘルパー
 * Integrated helper to apply Cross-Encoder reranking to search results
 *
 * @param results - 検索結果配列 / Search result array
 * @param query - 検索クエリ / Search query
 * @param queryEmbedding - クエリembedding / Query embedding
 * @param options - リランキングオプション / Reranking options
 * @returns リランキング済み結果 / Reranked results
 */
export async function applyCrossEncoderReranking<
  T extends { id: string; similarity: number; embedding?: number[] | undefined },
>(
  results: T[],
  query: string,
  queryEmbedding: number[] | undefined,
  options?: { alpha?: number | undefined; topK?: number | undefined }
): Promise<{ items: T[]; reranked: boolean; method: string }> {
  if (results.length <= 1 || !queryEmbedding) {
    return { items: results, reranked: false, method: "none" };
  }

  try {
    const rerankableItems: CrossEncoderRerankableItem[] = results.map((item) => ({
      ...item,
      id: item.id,
      similarity: item.similarity,
      embedding: item.embedding ?? undefined,
    }));

    const alpha = options?.alpha;
    const topK = options?.topK;

    const rerankResult = await rerankWithCrossEncoder(rerankableItems, query, {
      queryEmbedding,
      ...(alpha !== undefined ? { alpha } : {}),
      ...(topK !== undefined ? { topK } : {}),
      mode: "cosine_fallback",
    });

    if (rerankResult.reranked) {
      return {
        items: rerankResult.items as T[],
        reranked: true,
        method: rerankResult.method,
      };
    }

    return { items: results, reranked: false, method: "none" };
  } catch (error) {
    logger.warn("[CrossEncoderRerank] applyCrossEncoderReranking failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { items: results, reranked: false, method: "none" };
  }
}
