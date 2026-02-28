// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Full-text search SQL ヘルパー関数のユニットテスト
 *
 * packages/ml/src/search/fulltext-helpers.ts の全関数をテスト:
 * - buildFulltextConditions: tsvector WHERE条件のSQL文字列生成
 * - buildFulltextRankExpression: ts_rank_cd ランキング式の生成
 *
 * SEC監査 M-3: fulltext-helpers.ts ユニットテスト欠如の解消
 */
import { describe, it, expect } from 'vitest';
import {
  buildFulltextConditions,
  buildFulltextRankExpression,
} from '../../src/search/fulltext-helpers';

// =====================================================
// buildFulltextConditions テスト
// =====================================================

describe('buildFulltextConditions', () => {
  // --- デフォルトパラメータでの基本動作 ---

  it('デフォルトパラメータ ($1) で正しい3条件SQL文字列を生成すること', () => {
    // Arrange
    const column = 'se.search_vector';
    const paramIndex = 1;

    // Act
    const result = buildFulltextConditions(column, paramIndex);

    // Assert: 3つの条件がANDで結合されている
    expect(result).toBe(
      "se.search_vector IS NOT NULL AND plainto_tsquery('english', $1) <> ''::tsquery AND se.search_vector @@ plainto_tsquery('english', $1)"
    );
  });

  // --- 異なるパラメータインデックス ---

  it('パラメータインデックス $5 で正しくSQL文字列を生成すること', () => {
    // Arrange & Act
    const result = buildFulltextConditions('se.search_vector', 5);

    // Assert
    expect(result).toContain('$5');
    expect(result).not.toContain('$1');
  });

  it('パラメータインデックス $10 で正しくSQL文字列を生成すること', () => {
    // Arrange & Act
    const result = buildFulltextConditions('se.search_vector', 10);

    // Assert
    expect(result).toContain('$10');
  });

  // --- 異なるカラム名 ---

  it("カラム名 'bde.search_vector' で正しくSQL文字列を生成すること", () => {
    // Arrange & Act
    const result = buildFulltextConditions('bde.search_vector', 1);

    // Assert: カラム名がIS NOT NULLと@@の両方で使用される
    expect(result).toContain('bde.search_vector IS NOT NULL');
    expect(result).toContain("bde.search_vector @@ plainto_tsquery('english', $1)");
  });

  it("カラム名 'ne.search_vector' で正しくSQL文字列を生成すること", () => {
    // Arrange & Act
    const result = buildFulltextConditions('ne.search_vector', 1);

    // Assert
    expect(result).toContain('ne.search_vector IS NOT NULL');
    expect(result).toContain("ne.search_vector @@ plainto_tsquery('english', $1)");
  });

  // --- 3つの条件の存在確認 ---

  it('IS NOT NULL 条件を含むこと', () => {
    const result = buildFulltextConditions('se.search_vector', 1);
    expect(result).toContain('se.search_vector IS NOT NULL');
  });

  it("plainto_tsquery <> ''::tsquery 条件（空クエリスキップ）を含むこと", () => {
    const result = buildFulltextConditions('se.search_vector', 1);
    expect(result).toContain("plainto_tsquery('english', $1) <> ''::tsquery");
  });

  it('@@ match 条件を含むこと', () => {
    const result = buildFulltextConditions('se.search_vector', 1);
    expect(result).toContain("se.search_vector @@ plainto_tsquery('english', $1)");
  });

  it('3つの条件が AND で結合されていること', () => {
    const result = buildFulltextConditions('se.search_vector', 1);

    // AND区切りで分割すると3要素
    const parts = result.split(' AND ');
    expect(parts).toHaveLength(3);
  });

  it('WHERE や AND のプレフィックスを含まないこと（先頭部分）', () => {
    const result = buildFulltextConditions('se.search_vector', 1);

    // 先頭がカラム名で始まる（WHEREやANDで始まらない）
    expect(result).toMatch(/^se\.search_vector/);
  });
});

// =====================================================
// buildFulltextRankExpression テスト
// =====================================================

describe('buildFulltextRankExpression', () => {
  // --- デフォルトパラメータでの基本動作 ---

  it('デフォルトパラメータで正しいts_rank_cd式を生成すること', () => {
    // Arrange & Act
    const result = buildFulltextRankExpression('se.search_vector', 1);

    // Assert
    expect(result).toBe(
      "ts_rank_cd(se.search_vector, plainto_tsquery('english', $1))"
    );
  });

  // --- 異なるパラメータインデックス ---

  it('パラメータインデックス $5 で正しく生成すること', () => {
    // Arrange & Act
    const result = buildFulltextRankExpression('se.search_vector', 5);

    // Assert
    expect(result).toBe(
      "ts_rank_cd(se.search_vector, plainto_tsquery('english', $5))"
    );
  });

  it('パラメータインデックス $10 で正しく生成すること', () => {
    // Arrange & Act
    const result = buildFulltextRankExpression('se.search_vector', 10);

    // Assert
    expect(result).toContain('$10');
  });

  // --- 異なるカラム名 ---

  it("カラム名 'bde.search_vector' で正しく生成すること", () => {
    // Arrange & Act
    const result = buildFulltextRankExpression('bde.search_vector', 1);

    // Assert
    expect(result).toBe(
      "ts_rank_cd(bde.search_vector, plainto_tsquery('english', $1))"
    );
  });

  it("カラム名 'ne.search_vector' で正しく生成すること", () => {
    // Arrange & Act
    const result = buildFulltextRankExpression('ne.search_vector', 3);

    // Assert
    expect(result).toBe(
      "ts_rank_cd(ne.search_vector, plainto_tsquery('english', $3))"
    );
  });

  // --- 式の構造検証 ---

  it('ts_rank_cd 関数呼び出しの形式であること', () => {
    const result = buildFulltextRankExpression('se.search_vector', 1);
    expect(result).toMatch(/^ts_rank_cd\(.+\)$/);
  });

  it('plainto_tsquery を english 辞書で呼び出すこと', () => {
    const result = buildFulltextRankExpression('se.search_vector', 1);
    expect(result).toContain("plainto_tsquery('english',");
  });
});
