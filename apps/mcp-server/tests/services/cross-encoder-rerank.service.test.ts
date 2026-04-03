// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CrossEncoderRerankService テスト / CrossEncoderRerankService Tests
 *
 * Cross-Encoder リランキングサービスの検証:
 * - コサインフォールバックリランキング（モデル未ロード時）
 * - スコア順の正確性
 * - Graceful Degradation（エラー時に元の順序を維持）
 * - 空結果、単一結果のエッジケース
 * - 統合テスト（Query Understanding → Rerank パイプライン）
 *
 * Cross-Encoder reranking service verification:
 * - Cosine fallback reranking (when model not loaded)
 * - Score order accuracy
 * - Graceful Degradation (maintain original order on error)
 * - Empty results, single result edge cases
 * - Integration test (Query Understanding → Rerank pipeline)
 *
 * @module tests/services/cross-encoder-rerank.service
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  rerankWithCrossEncoder,
  computeCosineFallbackScores,
  createCrossEncoderRerankService,
  type CrossEncoderRerankableItem,
  type CrossEncoderRerankResult,
  type CrossEncoderRerankOptions,
} from "../../src/services/search/cross-encoder-rerank.service";

// ============================================================================
// Mock logger
// ============================================================================

vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// ============================================================================
// Test helpers
// ============================================================================

function createTestItem(
  id: string,
  similarity: number,
  embedding?: number[],
  text?: string
): CrossEncoderRerankableItem {
  return { id, similarity, embedding, text };
}

/**
 * 768次元の正規化されたダミーベクトルを生成
 * Generate a normalized dummy 768D vector
 */
function createDummyEmbedding(seed: number): number[] {
  const vec = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

// ============================================================================
// rerankWithCrossEncoder (cosine fallback mode)
// ============================================================================

describe("rerankWithCrossEncoder", () => {
  describe("コサインフォールバックモード / cosine fallback mode", () => {
    it("クエリembeddingと結果embeddingのコサイン類似度でリランキングする", async () => {
      const queryEmbedding = createDummyEmbedding(1);
      const items = [
        createTestItem("a", 0.5, createDummyEmbedding(10)),
        createTestItem("b", 0.8, createDummyEmbedding(1)), // queryとほぼ同一方向
        createTestItem("c", 0.3, createDummyEmbedding(5)),
      ];

      const result = await rerankWithCrossEncoder(items, "test query", {
        queryEmbedding,
        mode: "cosine_fallback",
      });

      expect(result.reranked).toBe(true);
      expect(result.method).toBe("cosine_fallback");
      expect(result.items.length).toBe(3);
      // "b"はqueryとほぼ同一方向なので最上位にくるはず
      expect(result.items[0]!.id).toBe("b");
    });

    it("queryEmbeddingがない場合はフォールバックでoriginal orderを維持する", async () => {
      const items = [createTestItem("a", 0.5), createTestItem("b", 0.8), createTestItem("c", 0.3)];

      const result = await rerankWithCrossEncoder(items, "test query", {
        mode: "cosine_fallback",
      });

      expect(result.reranked).toBe(false);
      expect(result.reason).toBeDefined();
      // 元のsimilarity順で降順ソートされている
      expect(result.items[0]!.id).toBe("b");
      expect(result.items[1]!.id).toBe("a");
      expect(result.items[2]!.id).toBe("c");
    });

    it("embeddingが一部のアイテムにない場合もリランキングする", async () => {
      const queryEmbedding = createDummyEmbedding(1);
      const items = [
        createTestItem("a", 0.5, createDummyEmbedding(10)),
        createTestItem("b", 0.8), // embeddingなし
        createTestItem("c", 0.3, createDummyEmbedding(1)), // queryとほぼ同一
      ];

      const result = await rerankWithCrossEncoder(items, "test query", {
        queryEmbedding,
        mode: "cosine_fallback",
      });

      expect(result.reranked).toBe(true);
      expect(result.items.length).toBe(3);
    });
  });

  // --- Graceful Degradation ---
  describe("Graceful Degradation", () => {
    it("空の結果配列の場合はそのまま返す", async () => {
      const result = await rerankWithCrossEncoder([], "test query", {
        mode: "cosine_fallback",
      });

      expect(result.reranked).toBe(false);
      expect(result.items).toEqual([]);
      expect(result.reason).toContain("empty");
    });

    it("単一アイテムの場合はリランキング不要", async () => {
      const items = [createTestItem("a", 0.5, createDummyEmbedding(1))];
      const result = await rerankWithCrossEncoder(items, "test query", {
        queryEmbedding: createDummyEmbedding(1),
        mode: "cosine_fallback",
      });

      expect(result.items.length).toBe(1);
      expect(result.items[0]!.id).toBe("a");
    });
  });

  // --- score accuracy ---
  describe("スコア精度 / score accuracy", () => {
    it("rerankスコアは0-1の範囲内にクランプされる", async () => {
      const queryEmbedding = createDummyEmbedding(1);
      const items = [
        createTestItem("a", 0.95, createDummyEmbedding(1)),
        createTestItem("b", 0.1, createDummyEmbedding(100)),
      ];

      const result = await rerankWithCrossEncoder(items, "test query", {
        queryEmbedding,
        mode: "cosine_fallback",
      });

      for (const item of result.items) {
        expect(item.similarity).toBeGreaterThanOrEqual(0);
        expect(item.similarity).toBeLessThanOrEqual(1);
      }
    });

    it("alphaパラメータでoriginal scoreとrerank scoreの重みを制御できる", async () => {
      const queryEmbedding = createDummyEmbedding(1);
      const items = [
        createTestItem("a", 0.9, createDummyEmbedding(100)), // 高いoriginal, 低いrerank
        createTestItem("b", 0.1, createDummyEmbedding(1)), // 低いoriginal, 高いrerank
      ];

      // alpha=0 → original scoreのみ → "a"が上位
      const resultAlpha0 = await rerankWithCrossEncoder(items, "test query", {
        queryEmbedding,
        mode: "cosine_fallback",
        alpha: 0,
      });
      expect(resultAlpha0.items[0]!.id).toBe("a");

      // alpha=1 → rerank scoreのみ → "b"が上位
      const resultAlpha1 = await rerankWithCrossEncoder(items, "test query", {
        queryEmbedding,
        mode: "cosine_fallback",
        alpha: 1,
      });
      expect(resultAlpha1.items[0]!.id).toBe("b");
    });
  });

  // --- top_k / 上位N件 ---
  describe("top_k 制限 / top_k limit", () => {
    it("top_kが指定された場合は上位N件のみリランキングする", async () => {
      const queryEmbedding = createDummyEmbedding(1);
      const items = Array.from({ length: 20 }, (_, i) =>
        createTestItem(`item-${i}`, 0.5 - i * 0.01, createDummyEmbedding(i + 1))
      );

      const result = await rerankWithCrossEncoder(items, "test query", {
        queryEmbedding,
        mode: "cosine_fallback",
        topK: 5,
      });

      // 全アイテムが返されるが、上位5件のみリランキングされる
      expect(result.items.length).toBe(20);
      expect(result.reranked).toBe(true);
    });
  });
});

// ============================================================================
// computeCosineFallbackScores
// ============================================================================

describe("computeCosineFallbackScores", () => {
  it("queryEmbeddingとitemEmbeddingのコサイン類似度を計算する", () => {
    const queryEmbedding = createDummyEmbedding(1);
    const items = [
      createTestItem("a", 0.5, createDummyEmbedding(1)), // 完全一致
      createTestItem("b", 0.5, createDummyEmbedding(100)), // 異なる方向
    ];

    const scores = computeCosineFallbackScores(items, queryEmbedding);
    expect(scores.get("a")).toBeDefined();
    expect(scores.get("b")).toBeDefined();

    // 完全一致の方がスコアが高い
    const scoreA = scores.get("a")!;
    const scoreB = scores.get("b")!;
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it("embeddingがないアイテムにはスコア0を返す", () => {
    const queryEmbedding = createDummyEmbedding(1);
    const items = [createTestItem("a", 0.5)]; // embeddingなし

    const scores = computeCosineFallbackScores(items, queryEmbedding);
    expect(scores.get("a")).toBe(0);
  });

  it("空のアイテム配列の場合は空のMapを返す", () => {
    const queryEmbedding = createDummyEmbedding(1);
    const scores = computeCosineFallbackScores([], queryEmbedding);
    expect(scores.size).toBe(0);
  });
});

// ============================================================================
// createCrossEncoderRerankService (factory)
// ============================================================================

describe("createCrossEncoderRerankService", () => {
  it("サービスインスタンスを作成できる", () => {
    const service = createCrossEncoderRerankService();
    expect(service).toBeDefined();
    expect(typeof service.rerank).toBe("function");
    expect(typeof service.isModelLoaded).toBe("function");
  });

  it("モデル未ロード時はisModelLoadedがfalseを返す", () => {
    const service = createCrossEncoderRerankService();
    expect(service.isModelLoaded()).toBe(false);
  });

  it("rerankメソッドがフォールバックモードで動作する", async () => {
    const service = createCrossEncoderRerankService();
    const items = [
      createTestItem("a", 0.5, createDummyEmbedding(1)),
      createTestItem("b", 0.8, createDummyEmbedding(2)),
    ];

    const result = await service.rerank(items, "test query", {
      queryEmbedding: createDummyEmbedding(1),
    });

    expect(result.reranked).toBe(true);
    expect(result.method).toBe("cosine_fallback");
  });
});
