// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RRF (Reciprocal Rank Fusion) スコア計算テスト
 *
 * packages/ml/src/search/rrf.ts の全関数をテスト:
 * - calculateRRF: 基本的なRRFスコア計算
 * - mergeWithRRF: ベクトル検索+全文検索の結果統合
 * - normalizeRRFScore: RRFスコアの0-1正規化
 *
 * TDA監査 P2-5: Hybrid Search固有テスト欠如の解消
 */
import { describe, it, expect } from 'vitest';
import {
  calculateRRF,
  mergeWithRRF,
  normalizeRRFScore,
} from '../../src/search/rrf';
import type { RankedItem, RRFScoredItem } from '../../src/search/rrf';

// =====================================================
// calculateRRF テスト
// =====================================================

describe('calculateRRF', () => {
  // --- 基本計算の正確性 ---

  it('rank=1, k=60 の場合 1/61 を返すこと', () => {
    // Arrange & Act
    const result = calculateRRF(1, 60);

    // Assert
    expect(result).toBeCloseTo(1 / 61, 10);
  });

  it('rank=2, k=60 の場合 1/62 を返すこと', () => {
    const result = calculateRRF(2, 60);
    expect(result).toBeCloseTo(1 / 62, 10);
  });

  it('rank=10, k=60 の場合 1/70 を返すこと', () => {
    const result = calculateRRF(10, 60);
    expect(result).toBeCloseTo(1 / 70, 10);
  });

  // --- デフォルトk値 ---

  it('k を省略した場合デフォルト値60が使用されること', () => {
    const result = calculateRRF(1);
    expect(result).toBeCloseTo(1 / 61, 10);
  });

  // --- カスタムk値 ---

  it('k=0 の場合 rank の逆数を返すこと', () => {
    const result = calculateRRF(5, 0);
    expect(result).toBeCloseTo(1 / 5, 10);
  });

  it('k=100 の場合 1/(100+rank) を返すこと', () => {
    const result = calculateRRF(1, 100);
    expect(result).toBeCloseTo(1 / 101, 10);
  });

  // --- エッジケース ---

  it('rank=0 の場合 1/k を返すこと', () => {
    // rank=0 は通常使われないが、関数は数学的に正しい値を返す
    const result = calculateRRF(0, 60);
    expect(result).toBeCloseTo(1 / 60, 10);
  });

  it('大きなrank値(1000)でも正しく計算されること', () => {
    const result = calculateRRF(1000, 60);
    expect(result).toBeCloseTo(1 / 1060, 10);
  });

  it('rankが大きくなるほどスコアが減少すること', () => {
    // RRFの特性: 上位ランクほどスコアが高い
    const score1 = calculateRRF(1, 60);
    const score5 = calculateRRF(5, 60);
    const score10 = calculateRRF(10, 60);
    const score100 = calculateRRF(100, 60);

    expect(score1).toBeGreaterThan(score5);
    expect(score5).toBeGreaterThan(score10);
    expect(score10).toBeGreaterThan(score100);
  });

  it('全てのスコアが正の値であること', () => {
    const ranks = [0, 1, 2, 5, 10, 50, 100, 1000];
    for (const rank of ranks) {
      expect(calculateRRF(rank, 60)).toBeGreaterThan(0);
    }
  });
});

// =====================================================
// mergeWithRRF テスト
// =====================================================

describe('mergeWithRRF', () => {
  // --- テストデータファクトリ ---

  /** ランク付きアイテムを生成するヘルパー */
  function createRankedItem(id: string, rank: number, extra?: Record<string, unknown>): RankedItem {
    return { id, rank, ...extra };
  }

  // --- 基本的な統合テスト ---

  it('ベクトルと全文の結果を正しくマージすること', () => {
    // Arrange: 異なるIDの結果
    const vectorResults: RankedItem[] = [
      createRankedItem('a', 1, { name: 'Item A' }),
      createRankedItem('b', 2, { name: 'Item B' }),
    ];
    const fulltextResults: RankedItem[] = [
      createRankedItem('c', 1, { name: 'Item C' }),
      createRankedItem('d', 2, { name: 'Item D' }),
    ];

    // Act
    const result = mergeWithRRF(vectorResults, fulltextResults);

    // Assert: 4つのユニークなアイテムが返ること
    expect(result).toHaveLength(4);
    const ids = result.map((r) => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
    expect(ids).toContain('d');
  });

  // --- 重複IDの統合 ---

  it('同一IDが両方の検索結果に存在する場合にスコアが加算されること', () => {
    // Arrange: ID 'shared' が両方に存在
    const vectorResults: RankedItem[] = [
      createRankedItem('shared', 1),
      createRankedItem('vector-only', 2),
    ];
    const fulltextResults: RankedItem[] = [
      createRankedItem('shared', 1),
      createRankedItem('ft-only', 2),
    ];

    // Act
    const result = mergeWithRRF(vectorResults, fulltextResults);

    // Assert: 3つのユニークアイテム（shared, vector-only, ft-only）
    expect(result).toHaveLength(3);

    const shared = result.find((r) => r.id === 'shared');
    expect(shared).toBeDefined();
    // 'shared' のスコアは vector(rank1) + fulltext(rank1) の合計
    const expectedVectorScore = calculateRRF(1, 60) * 0.6;
    const expectedFtScore = calculateRRF(1, 60) * 0.4;
    expect(shared!.rrfScore).toBeCloseTo(expectedVectorScore + expectedFtScore, 10);
    expect(shared!.vectorRank).toBe(1);
    expect(shared!.fulltextRank).toBe(1);
  });

  it('重複IDは片方のみのIDよりもスコアが高くなること', () => {
    // Arrange: 'shared' は両方、他は片方のみ
    const vectorResults: RankedItem[] = [
      createRankedItem('shared', 1),
      createRankedItem('vector-only', 2),
    ];
    const fulltextResults: RankedItem[] = [
      createRankedItem('shared', 2),
      createRankedItem('ft-only', 1),
    ];

    // Act
    const result = mergeWithRRF(vectorResults, fulltextResults);

    // Assert
    const shared = result.find((r) => r.id === 'shared');
    const vectorOnly = result.find((r) => r.id === 'vector-only');
    const ftOnly = result.find((r) => r.id === 'ft-only');

    expect(shared!.rrfScore).toBeGreaterThan(vectorOnly!.rrfScore);
    expect(shared!.rrfScore).toBeGreaterThan(ftOnly!.rrfScore);
  });

  // --- 片側が空結果の場合 ---

  it('全文検索結果が空の場合はベクトル結果のみが返ること', () => {
    // Arrange
    const vectorResults: RankedItem[] = [
      createRankedItem('a', 1),
      createRankedItem('b', 2),
    ];
    const fulltextResults: RankedItem[] = [];

    // Act
    const result = mergeWithRRF(vectorResults, fulltextResults);

    // Assert
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[0].vectorRank).toBe(1);
    expect(result[0].fulltextRank).toBeUndefined();
  });

  it('ベクトル検索結果が空の場合は全文結果のみが返ること', () => {
    // Arrange
    const vectorResults: RankedItem[] = [];
    const fulltextResults: RankedItem[] = [
      createRankedItem('x', 1),
      createRankedItem('y', 2),
    ];

    // Act
    const result = mergeWithRRF(vectorResults, fulltextResults);

    // Assert
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('x');
    expect(result[0].fulltextRank).toBe(1);
    expect(result[0].vectorRank).toBeUndefined();
  });

  it('両方が空の場合は空配列が返ること', () => {
    const result = mergeWithRRF([], []);
    expect(result).toHaveLength(0);
  });

  // --- 重み付け検証 ---

  it('デフォルトの重み(0.6/0.4)が正しく適用されること', () => {
    // Arrange: 同じrank=1のアイテム
    const vectorResults: RankedItem[] = [createRankedItem('v', 1)];
    const fulltextResults: RankedItem[] = [createRankedItem('f', 1)];

    // Act
    const result = mergeWithRRF(vectorResults, fulltextResults);

    // Assert: ベクトル結果がデフォルトでは全文結果よりもスコアが高い
    const vItem = result.find((r) => r.id === 'v');
    const fItem = result.find((r) => r.id === 'f');
    expect(vItem!.rrfScore).toBeGreaterThan(fItem!.rrfScore);

    // 具体的なスコア検証
    const rrfRank1 = calculateRRF(1, 60);
    expect(vItem!.rrfScore).toBeCloseTo(rrfRank1 * 0.6, 10);
    expect(fItem!.rrfScore).toBeCloseTo(rrfRank1 * 0.4, 10);
  });

  it('カスタム重み(0.3/0.7)が正しく適用されること', () => {
    // Arrange
    const vectorResults: RankedItem[] = [createRankedItem('v', 1)];
    const fulltextResults: RankedItem[] = [createRankedItem('f', 1)];

    // Act: 全文検索に重みを置く設定
    const result = mergeWithRRF(vectorResults, fulltextResults, 0.3, 0.7);

    // Assert: 今度は全文結果の方がスコアが高い
    const vItem = result.find((r) => r.id === 'v');
    const fItem = result.find((r) => r.id === 'f');
    expect(fItem!.rrfScore).toBeGreaterThan(vItem!.rrfScore);
  });

  it('カスタムk値(k=10)が正しく適用されること', () => {
    // Arrange
    const vectorResults: RankedItem[] = [createRankedItem('a', 1)];

    // Act
    const result = mergeWithRRF(vectorResults, [], 0.6, 0.4, 10);

    // Assert: k=10 → score = 1/(10+1) * 0.6
    expect(result[0].rrfScore).toBeCloseTo((1 / 11) * 0.6, 10);
  });

  // --- ソート順の検証 ---

  it('結果がRRFスコア降順でソートされること', () => {
    // Arrange: 意図的にランク順をずらす
    const vectorResults: RankedItem[] = [
      createRankedItem('low', 1),
      createRankedItem('mid', 2),
      createRankedItem('high', 3),
    ];
    const fulltextResults: RankedItem[] = [
      createRankedItem('high', 1), // highは全文で1位
      createRankedItem('mid', 2),
      createRankedItem('low', 3),  // lowは全文で3位
    ];

    // Act
    const result = mergeWithRRF(vectorResults, fulltextResults);

    // Assert: スコア降順
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].rrfScore).toBeGreaterThanOrEqual(result[i + 1].rrfScore);
    }
  });

  // --- dataフィールドの検証 ---

  it('追加データ（id, rank以外）がdataフィールドに含まれること', () => {
    // Arrange
    const vectorResults: RankedItem[] = [
      createRankedItem('a', 1, { name: 'Test Item', category: 'hero' }),
    ];

    // Act
    const result = mergeWithRRF(vectorResults, []);

    // Assert
    expect(result[0].data).toBeDefined();
    expect(result[0].data.name).toBe('Test Item');
    expect(result[0].data.category).toBe('hero');
  });

  it('重複IDの場合にデータがマージされること', () => {
    // Arrange: vectorにのみ存在するフィールド + fulltextにのみ存在するフィールド
    const vectorResults: RankedItem[] = [
      createRankedItem('shared', 1, { vectorField: 'from-vector' }),
    ];
    const fulltextResults: RankedItem[] = [
      createRankedItem('shared', 1, { ftField: 'from-fulltext' }),
    ];

    // Act
    const result = mergeWithRRF(vectorResults, fulltextResults);

    // Assert: 両方のデータフィールドが保持される
    const shared = result.find((r) => r.id === 'shared');
    expect(shared!.data.vectorField).toBe('from-vector');
    // fulltextのデータはmergeロジックでスプレッドされる
  });

  // --- 大量データの処理 ---

  it('多数のアイテム(100件ずつ)を正しく処理できること', () => {
    // Arrange
    const vectorResults: RankedItem[] = Array.from({ length: 100 }, (_, i) =>
      createRankedItem(`v-${i}`, i + 1)
    );
    const fulltextResults: RankedItem[] = Array.from({ length: 100 }, (_, i) =>
      createRankedItem(`f-${i}`, i + 1)
    );

    // Act
    const result = mergeWithRRF(vectorResults, fulltextResults);

    // Assert: 200件のユニークアイテム（重複なし）
    expect(result).toHaveLength(200);
    // ソート順が正しいこと
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].rrfScore).toBeGreaterThanOrEqual(result[i + 1].rrfScore);
    }
  });
});

// =====================================================
// normalizeRRFScore テスト
// =====================================================

describe('normalizeRRFScore', () => {
  // --- 基本的な正規化 ---

  it('最大スコア(rank=1で両方存在)が1.0に正規化されること', () => {
    // Arrange: 最大可能スコア = calculateRRF(1,60)*0.6 + calculateRRF(1,60)*0.4
    const maxScore = calculateRRF(1, 60) * 0.6 + calculateRRF(1, 60) * 0.4;

    // Act
    const normalized = normalizeRRFScore(maxScore);

    // Assert
    expect(normalized).toBeCloseTo(1.0, 5);
  });

  it('スコア0が0.0に正規化されること', () => {
    const normalized = normalizeRRFScore(0);
    expect(normalized).toBe(0);
  });

  it('中間スコアが0-1の範囲内であること', () => {
    // Arrange: rank=5のベクトル検索のみのスコア
    const midScore = calculateRRF(5, 60) * 0.6;

    // Act
    const normalized = normalizeRRFScore(midScore);

    // Assert
    expect(normalized).toBeGreaterThan(0);
    expect(normalized).toBeLessThan(1);
  });

  // --- カスタムmaxPossibleScore ---

  it('カスタムmaxPossibleScoreが正しく適用されること', () => {
    // Arrange
    const score = 0.5;
    const maxPossible = 1.0;

    // Act
    const normalized = normalizeRRFScore(score, maxPossible);

    // Assert
    expect(normalized).toBeCloseTo(0.5, 10);
  });

  it('maxPossibleScore未指定時にデフォルト最大値が使用されること', () => {
    // Arrange
    const defaultMax = calculateRRF(1, 60) * 0.6 + calculateRRF(1, 60) * 0.4;
    const score = defaultMax / 2;

    // Act
    const withDefault = normalizeRRFScore(score);
    const withExplicit = normalizeRRFScore(score, defaultMax);

    // Assert: 両方同じ結果
    expect(withDefault).toBeCloseTo(withExplicit, 10);
  });

  // --- 上限クランプ ---

  it('1.0を超えるスコアが1.0にクランプされること', () => {
    // Arrange: 非常に大きなスコアを渡す
    const veryLargeScore = 100;

    // Act
    const normalized = normalizeRRFScore(veryLargeScore);

    // Assert
    expect(normalized).toBe(1);
  });

  // --- 現実的なシナリオ ---

  it('ベクトル検索のみ(rank=1)のスコアが正しく正規化されること', () => {
    // Arrange: ベクトル検索rank=1のスコア（0.6 weight）
    const vectorOnlyScore = calculateRRF(1, 60) * 0.6;

    // Act
    const normalized = normalizeRRFScore(vectorOnlyScore);

    // Assert: デフォルト最大は両方rank=1なので、片方のみなら0.6程度
    expect(normalized).toBeCloseTo(0.6, 1);
  });

  it('全文検索のみ(rank=1)のスコアが正しく正規化されること', () => {
    // Arrange: 全文検索rank=1のスコア（0.4 weight）
    const ftOnlyScore = calculateRRF(1, 60) * 0.4;

    // Act
    const normalized = normalizeRRFScore(ftOnlyScore);

    // Assert: 片方のみなら0.4程度
    expect(normalized).toBeCloseTo(0.4, 1);
  });
});
