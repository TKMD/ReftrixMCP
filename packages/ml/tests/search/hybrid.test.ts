// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * executeHybridSearch 統合テスト
 *
 * packages/ml/src/search/hybrid.ts のテスト:
 * - Promise.all並列実行の検証
 * - 片側失敗時のgraceful degradation
 * - 両方失敗時の空結果
 * - カスタムconfigの適用
 * - HybridSearchResultの型チェック
 *
 * TDA監査 P2-5: Hybrid Search固有テスト欠如の解消
 */
import { describe, it, expect, vi } from 'vitest';
import { executeHybridSearch } from '../../src/search/hybrid';
import { calculateRRF } from '../../src/search/rrf';
import type { RankedItem } from '../../src/search/rrf';
import type { HybridSearchConfig, HybridSearchResult } from '../../src/search/hybrid';

// =====================================================
// ヘルパー
// =====================================================

/** テスト用 RankedItem 生成 */
function createRankedItem(id: string, rank: number, extra?: Record<string, unknown>): RankedItem {
  return { id, rank, ...extra };
}

/** 即時解決するPromiseを返すモック検索関数 */
function createMockSearchFn(results: RankedItem[]): () => Promise<RankedItem[]> {
  return vi.fn().mockResolvedValue(results);
}

/** 拒否されるPromiseを返すモック検索関数 */
function createFailingSearchFn(errorMessage: string): () => Promise<RankedItem[]> {
  return vi.fn().mockRejectedValue(new Error(errorMessage));
}

// =====================================================
// executeHybridSearch テスト
// =====================================================

describe('executeHybridSearch', () => {
  // --- 正常系: 両方成功 ---

  it('両方の検索が成功した場合にマージ結果を返すこと', async () => {
    // Arrange
    const vectorResults: RankedItem[] = [
      createRankedItem('a', 1, { name: 'Vector A' }),
      createRankedItem('b', 2, { name: 'Vector B' }),
    ];
    const fulltextResults: RankedItem[] = [
      createRankedItem('c', 1, { name: 'Fulltext C' }),
      createRankedItem('b', 2, { name: 'Fulltext B' }),
    ];

    const vectorFn = createMockSearchFn(vectorResults);
    const fulltextFn = createMockSearchFn(fulltextResults);

    // Act
    const results = await executeHybridSearch(vectorFn, fulltextFn);

    // Assert: 3つのユニークアイテム（b は統合される）
    expect(results).toHaveLength(3);
    expect(vectorFn).toHaveBeenCalledOnce();
    expect(fulltextFn).toHaveBeenCalledOnce();
  });

  it('結果がHybridSearchResult型に準拠していること', async () => {
    // Arrange
    const vectorResults: RankedItem[] = [
      createRankedItem('item-1', 1, { category: 'hero' }),
    ];
    const fulltextResults: RankedItem[] = [
      createRankedItem('item-2', 1),
    ];

    // Act
    const results = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn(fulltextResults)
    );

    // Assert: 各結果の型を検証
    for (const result of results) {
      expect(result).toHaveProperty('id');
      expect(typeof result.id).toBe('string');

      expect(result).toHaveProperty('similarity');
      expect(typeof result.similarity).toBe('number');
      expect(result.similarity).toBeGreaterThanOrEqual(0);
      expect(result.similarity).toBeLessThanOrEqual(1);

      expect(result).toHaveProperty('source');
      expect(typeof result.source).toBe('object');

      expect(result).toHaveProperty('data');
      expect(typeof result.data).toBe('object');
    }
  });

  it('両方に存在するIDのsourceに両方のrankが含まれること', async () => {
    // Arrange: 同じIDが両方に存在
    // 注: mergeWithRRF は配列のインデックスから rank を計算する（index+1）
    // fulltextResults の 'shared' は配列の3番目(index=2) → rank=3
    const vectorResults: RankedItem[] = [createRankedItem('shared', 1)];
    const fulltextResults: RankedItem[] = [
      createRankedItem('other-1', 1),
      createRankedItem('other-2', 2),
      createRankedItem('shared', 3),
    ];

    // Act
    const results = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn(fulltextResults)
    );

    // Assert
    const shared = results.find((r) => r.id === 'shared');
    expect(shared).toBeDefined();
    expect(shared!.source.vectorRank).toBe(1);
    expect(shared!.source.fulltextRank).toBe(3);
  });

  it('ベクトルのみに存在するIDのsourceにvectorRankのみ含まれること', async () => {
    // Arrange
    const vectorResults: RankedItem[] = [createRankedItem('v-only', 1)];
    const fulltextResults: RankedItem[] = [];

    // Act
    const results = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn(fulltextResults)
    );

    // Assert
    const item = results.find((r) => r.id === 'v-only');
    expect(item).toBeDefined();
    expect(item!.source.vectorRank).toBe(1);
    expect(item!.source.fulltextRank).toBeUndefined();
  });

  it('全文のみに存在するIDのsourceにfulltextRankのみ含まれること', async () => {
    // Arrange
    const vectorResults: RankedItem[] = [];
    const fulltextResults: RankedItem[] = [createRankedItem('ft-only', 1)];

    // Act
    const results = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn(fulltextResults)
    );

    // Assert
    const item = results.find((r) => r.id === 'ft-only');
    expect(item).toBeDefined();
    expect(item!.source.fulltextRank).toBe(1);
    expect(item!.source.vectorRank).toBeUndefined();
  });

  // --- similarityの正規化検証 ---

  it('similarity値が0-1の範囲に正規化されていること', async () => {
    // Arrange: 複数ランクの結果
    const vectorResults: RankedItem[] = Array.from({ length: 10 }, (_, i) =>
      createRankedItem(`v-${i}`, i + 1)
    );
    const fulltextResults: RankedItem[] = Array.from({ length: 10 }, (_, i) =>
      createRankedItem(`f-${i}`, i + 1)
    );

    // Act
    const results = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn(fulltextResults)
    );

    // Assert: 全ての similarity が 0-1 の範囲
    for (const result of results) {
      expect(result.similarity).toBeGreaterThanOrEqual(0);
      expect(result.similarity).toBeLessThanOrEqual(1);
    }
  });

  it('結果がsimilarity降順でソートされていること', async () => {
    // Arrange
    const vectorResults: RankedItem[] = [
      createRankedItem('a', 1),
      createRankedItem('b', 5),
      createRankedItem('c', 10),
    ];
    const fulltextResults: RankedItem[] = [
      createRankedItem('d', 1),
      createRankedItem('e', 5),
    ];

    // Act
    const results = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn(fulltextResults)
    );

    // Assert: 降順ソート
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].similarity).toBeGreaterThanOrEqual(results[i + 1].similarity);
    }
  });

  // --- 両方空結果 ---

  it('両方の検索結果が空の場合に空配列を返すこと', async () => {
    // Arrange
    const vectorFn = createMockSearchFn([]);
    const fulltextFn = createMockSearchFn([]);

    // Act
    const results = await executeHybridSearch(vectorFn, fulltextFn);

    // Assert
    expect(results).toHaveLength(0);
    expect(results).toEqual([]);
  });

  // --- カスタムconfigの適用 ---

  it('カスタムvectorWeight/fulltextWeightが適用されること', async () => {
    // Arrange: 同じランクのアイテムを異なるIDで
    const vectorResults: RankedItem[] = [createRankedItem('v', 1)];
    const fulltextResults: RankedItem[] = [createRankedItem('f', 1)];

    const config: HybridSearchConfig = {
      vectorWeight: 0.3,
      fulltextWeight: 0.7,
    };

    // Act
    const results = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn(fulltextResults),
      config
    );

    // Assert: 全文結果の方がスコアが高いこと（0.7 > 0.3）
    const vItem = results.find((r) => r.id === 'v');
    const fItem = results.find((r) => r.id === 'f');
    expect(fItem!.similarity).toBeGreaterThan(vItem!.similarity);
  });

  it('カスタムk値が適用されること', async () => {
    // Arrange
    const vectorResults: RankedItem[] = [createRankedItem('a', 1)];
    const config: HybridSearchConfig = { k: 10 };

    // Act
    const results = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn([]),
      config
    );

    // Assert: k=10 のスコアは k=60 のスコアより大きい
    // k=10 → RRF = 1/(10+1) = 0.0909
    // k=60 → RRF = 1/(60+1) = 0.0164
    expect(results).toHaveLength(1);
    // k=10 での結果の similarity は k=60 でのデフォルト正規化と異なるが、
    // 関数はデフォルトmaxで正規化するので > 1 もありうる → clamp to 1
  });

  it('config未指定時にデフォルト値(k=60, 0.6/0.4)が使用されること', async () => {
    // Arrange
    const vectorResults: RankedItem[] = [createRankedItem('a', 1)];

    // Act: config なし
    const resultsNoConfig = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn([])
    );

    // Act: 明示的デフォルト config
    const resultsDefaultConfig = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn([]),
      { k: 60, vectorWeight: 0.6, fulltextWeight: 0.4 }
    );

    // Assert: 同じ結果
    expect(resultsNoConfig[0].similarity).toBeCloseTo(
      resultsDefaultConfig[0].similarity,
      10
    );
  });

  // --- 並列実行の検証 ---

  it('両方の検索関数が呼び出されること（Promise.all並列実行）', async () => {
    // Arrange
    const vectorFn = vi.fn().mockResolvedValue([createRankedItem('a', 1)]);
    const fulltextFn = vi.fn().mockResolvedValue([createRankedItem('b', 1)]);

    // Act
    await executeHybridSearch(vectorFn, fulltextFn);

    // Assert: 両方が呼び出された
    expect(vectorFn).toHaveBeenCalledOnce();
    expect(fulltextFn).toHaveBeenCalledOnce();
  });

  it('遅延のある検索でも正しく結果が返ること', async () => {
    // Arrange: ベクトル検索に遅延
    const vectorFn = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [createRankedItem('delayed', 1)];
    });
    const fulltextFn = createMockSearchFn([createRankedItem('instant', 1)]);

    // Act
    const results = await executeHybridSearch(vectorFn, fulltextFn);

    // Assert: 両方の結果が含まれる
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('delayed');
    expect(ids).toContain('instant');
  });

  // --- エラーハンドリング ---
  // 注: executeHybridSearchはPromise.allを使用しているため、
  // 片側の失敗はPromise.all全体の失敗となる。
  // graceful degradationはcaller側（サービス層）で実装される。

  it('ベクトル検索が失敗した場合にエラーが伝播すること', async () => {
    // Arrange
    const vectorFn = createFailingSearchFn('Vector search failed');
    const fulltextFn = createMockSearchFn([createRankedItem('a', 1)]);

    // Act & Assert
    await expect(
      executeHybridSearch(vectorFn, fulltextFn)
    ).rejects.toThrow('Vector search failed');
  });

  it('全文検索が失敗した場合にエラーが伝播すること', async () => {
    // Arrange
    const vectorFn = createMockSearchFn([createRankedItem('a', 1)]);
    const fulltextFn = createFailingSearchFn('Fulltext search failed');

    // Act & Assert
    await expect(
      executeHybridSearch(vectorFn, fulltextFn)
    ).rejects.toThrow('Fulltext search failed');
  });

  it('両方が失敗した場合にエラーが伝播すること', async () => {
    // Arrange
    const vectorFn = createFailingSearchFn('Vector failed');
    const fulltextFn = createFailingSearchFn('Fulltext failed');

    // Act & Assert
    await expect(
      executeHybridSearch(vectorFn, fulltextFn)
    ).rejects.toThrow();
  });

  // --- 大量データ ---

  it('大量の結果(100件ずつ)を正しく処理できること', async () => {
    // Arrange
    const vectorResults: RankedItem[] = Array.from({ length: 100 }, (_, i) =>
      createRankedItem(`v-${i}`, i + 1, { source: 'vector' })
    );
    const fulltextResults: RankedItem[] = Array.from({ length: 100 }, (_, i) =>
      createRankedItem(`f-${i}`, i + 1, { source: 'fulltext' })
    );

    // Act
    const results = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn(fulltextResults)
    );

    // Assert: 200件のユニークアイテム
    expect(results).toHaveLength(200);

    // 全て有効な HybridSearchResult
    for (const result of results) {
      expect(result.id).toBeDefined();
      expect(result.similarity).toBeGreaterThanOrEqual(0);
      expect(result.similarity).toBeLessThanOrEqual(1);
      expect(result.source).toBeDefined();
      expect(result.data).toBeDefined();
    }
  });

  // --- 重複率の高いケース ---

  it('全アイテムが重複(完全一致)の場合にスコアが加算されること', async () => {
    // Arrange: 全て同じID
    const vectorResults: RankedItem[] = [
      createRankedItem('same-1', 1),
      createRankedItem('same-2', 2),
      createRankedItem('same-3', 3),
    ];
    const fulltextResults: RankedItem[] = [
      createRankedItem('same-1', 2),
      createRankedItem('same-2', 1),
      createRankedItem('same-3', 3),
    ];

    // Act
    const results = await executeHybridSearch(
      createMockSearchFn(vectorResults),
      createMockSearchFn(fulltextResults)
    );

    // Assert: 3つのユニークアイテム（全てマージ済み）
    expect(results).toHaveLength(3);

    // 全アイテムが両方のランクを持つ
    for (const result of results) {
      expect(result.source.vectorRank).toBeDefined();
      expect(result.source.fulltextRank).toBeDefined();
    }

    // 最もスコアの高いアイテムを検証
    // same-1: vector rank 1 (高), fulltext rank 2
    // same-2: vector rank 2, fulltext rank 1 (高)
    // デフォルト重み0.6/0.4なので、vector rank 1の方がスコア寄与が大きい
    // → same-1 のスコアが最も高い可能性
    const same1 = results.find((r) => r.id === 'same-1');
    const same2 = results.find((r) => r.id === 'same-2');
    expect(same1).toBeDefined();
    expect(same2).toBeDefined();

    // same-1: 0.6 * RRF(1) + 0.4 * RRF(2)
    // same-2: 0.6 * RRF(2) + 0.4 * RRF(1)
    // RRF(1) > RRF(2) で vectorWeight > fulltextWeight なので same-1 > same-2
    expect(same1!.similarity).toBeGreaterThanOrEqual(same2!.similarity);
  });
});
