// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * toRankedItems() ユニットテスト
 *
 * packages/ml/src/search/rrf.ts の toRankedItems<T>() をテスト:
 * - 空配列の処理
 * - 単一要素のランク付け
 * - 複数要素の1-basedランク付与
 * - ジェネリック型のデータ保持
 *
 * SEC監査 M-5: toRankedItems() ユニットテスト欠如の解消
 */
import { describe, it, expect } from 'vitest';
import { toRankedItems } from '../../src/search/rrf';

// =====================================================
// toRankedItems テスト
// =====================================================

describe('toRankedItems', () => {
  // --- 空配列の処理 ---

  it('空配列を渡した場合に空配列を返すこと', () => {
    // Arrange
    const rows: { id: string }[] = [];

    // Act
    const result = toRankedItems(rows);

    // Assert
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });

  // --- 単一要素 ---

  it('1件の場合に rank=1 が付与されること', () => {
    // Arrange
    const rows = [{ id: 'item-1' }];

    // Act
    const result = toRankedItems(rows);

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0].rank).toBe(1);
    expect(result[0].id).toBe('item-1');
  });

  it('1件の場合に data プロパティにオリジナルデータが含まれること', () => {
    // Arrange
    const rows = [{ id: 'item-1', name: 'Test Item', score: 0.95 }];

    // Act
    const result = toRankedItems(rows);

    // Assert: スプレッドされたオリジナルフィールドがRankedItemに含まれる
    expect(result[0].id).toBe('item-1');
    expect(result[0].rank).toBe(1);
    // toRankedItems は ...row でスプレッドするため、追加フィールドもトップレベルに含まれる
    expect((result[0] as Record<string, unknown>).name).toBe('Test Item');
    expect((result[0] as Record<string, unknown>).score).toBe(0.95);
  });

  // --- 複数要素 ---

  it('複数件の場合に rank=1,2,3... の順序で付与されること', () => {
    // Arrange
    const rows = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];

    // Act
    const result = toRankedItems(rows);

    // Assert: 配列順序に基づく1-basedランク
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ id: 'a', rank: 1 });
    expect(result[1]).toMatchObject({ id: 'b', rank: 2 });
    expect(result[2]).toMatchObject({ id: 'c', rank: 3 });
  });

  it('入力配列の順序が保持されること', () => {
    // Arrange: 意図的にID順でない配列
    const rows = [
      { id: 'z' },
      { id: 'a' },
      { id: 'm' },
    ];

    // Act
    const result = toRankedItems(rows);

    // Assert: 入力順が維持される（ソートされない）
    expect(result[0].id).toBe('z');
    expect(result[1].id).toBe('a');
    expect(result[2].id).toBe('m');
  });

  // --- ジェネリック型の保持確認 ---

  it('ジェネリック型の追加フィールドがスプレッドで保持されること', () => {
    // Arrange: 様々な追加フィールドを持つオブジェクト
    interface LayoutRow {
      id: string;
      designType: string;
      similarity: number;
      siteUrl: string;
    }
    const rows: LayoutRow[] = [
      { id: 'layout-1', designType: 'hero', similarity: 0.92, siteUrl: 'https://example.com' },
      { id: 'layout-2', designType: 'grid', similarity: 0.85, siteUrl: 'https://test.com' },
    ];

    // Act
    const result = toRankedItems(rows);

    // Assert: 各アイテムにオリジナルフィールドが保持される
    expect(result).toHaveLength(2);

    const first = result[0] as Record<string, unknown>;
    expect(first.id).toBe('layout-1');
    expect(first.rank).toBe(1);
    expect(first.designType).toBe('hero');
    expect(first.similarity).toBe(0.92);
    expect(first.siteUrl).toBe('https://example.com');

    const second = result[1] as Record<string, unknown>;
    expect(second.id).toBe('layout-2');
    expect(second.rank).toBe(2);
    expect(second.designType).toBe('grid');
    expect(second.similarity).toBe(0.85);
  });

  // --- similarity フィールドの上書き確認 ---

  it('元の rank フィールドがあっても新しいrankで上書きされること', () => {
    // Arrange: 元のデータに rank=99 が含まれている場合
    const rows = [
      { id: 'item-1', rank: 99 },
      { id: 'item-2', rank: 50 },
    ];

    // Act
    const result = toRankedItems(rows);

    // Assert: スプレッドの後に rank: index + 1 が設定されるため上書きされる
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
  });

  // --- 大量データの処理 ---

  it('100件のデータを正しくランク付けできること', () => {
    // Arrange
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `item-${i}`,
    }));

    // Act
    const result = toRankedItems(rows);

    // Assert
    expect(result).toHaveLength(100);
    expect(result[0].rank).toBe(1);
    expect(result[99].rank).toBe(100);

    // 全ランクが連番であること
    result.forEach((item, index) => {
      expect(item.rank).toBe(index + 1);
    });
  });
});
