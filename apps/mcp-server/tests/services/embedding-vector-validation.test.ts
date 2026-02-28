// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ベクトルEmbedding SQL検証テスト
 *
 * セキュリティレビュー（Phase5）で指摘された以下の問題に対するテスト:
 * - 768次元ベクトル配列をSQLに渡す際の型検証
 * - 配列要素が数値であることを確認するバリデーション
 * - isFinite()チェックでNaN/Infinityを除外
 *
 * TDD Red Phase: テストは失敗する状態で作成
 *
 * @module tests/services/embedding-vector-validation.test
 */

import { describe, it, expect } from 'vitest';
import {
  validateEmbeddingVector,
  EmbeddingValidationError,
  // これらは実装後にエクスポートされる予定
} from '../../src/services/embedding-validation.service';

// =====================================================
// 定数
// =====================================================

/** 期待されるベクトル次元数 */
const EXPECTED_DIMENSIONS = 768;

/** 有効な768次元ベクトル */
const createValidVector = (fill: number = 0.1): number[] =>
  new Array(EXPECTED_DIMENSIONS).fill(fill);

/** NaNを含むベクトル */
const createVectorWithNaN = (position: 'first' | 'middle' | 'last'): number[] => {
  const vector = createValidVector();
  switch (position) {
    case 'first':
      vector[0] = NaN;
      break;
    case 'middle':
      vector[383] = NaN; // 中間位置
      break;
    case 'last':
      vector[767] = NaN;
      break;
  }
  return vector;
};

/** Infinityを含むベクトル */
const createVectorWithInfinity = (type: 'positive' | 'negative'): number[] => {
  const vector = createValidVector();
  vector[0] = type === 'positive' ? Infinity : -Infinity;
  return vector;
};

// =====================================================
// validateEmbeddingVector 関数テスト
// =====================================================

describe('validateEmbeddingVector', () => {
  // -----------------------------------------------------
  // 正常系テスト
  // -----------------------------------------------------
  describe('正常系', () => {
    it('有効な768次元ベクトルを受け入れること', () => {
      // Arrange: 有効なベクトルを作成
      const validVector = createValidVector(0.1);

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(validVector);

      // Assert: 検証が成功すること
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('空のベクトルを受け入れること（オプショナルなEmbedding用）', () => {
      // Arrange: 空のベクトル
      const emptyVector: number[] = [];

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(emptyVector, { allowEmpty: true });

      // Assert: 空ベクトルは許可される
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('正の浮動小数点数を含むベクトルを受け入れること', () => {
      // Arrange: 小数点以下の値を持つベクトル
      const vector = new Array(EXPECTED_DIMENSIONS).fill(0).map((_, i) => i * 0.001);

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vector);

      // Assert: 検証が成功すること
      expect(result.isValid).toBe(true);
    });

    it('負の浮動小数点数を含むベクトルを受け入れること', () => {
      // Arrange: 負の値を含むベクトル
      const vector = new Array(EXPECTED_DIMENSIONS).fill(0).map((_, i) => -i * 0.001);

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vector);

      // Assert: 検証が成功すること
      expect(result.isValid).toBe(true);
    });

    it('ゼロのみを含むベクトルを受け入れること', () => {
      // Arrange: すべてゼロのベクトル
      const zeroVector = createValidVector(0);

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(zeroVector);

      // Assert: 検証が成功すること
      expect(result.isValid).toBe(true);
    });

    it('Number.MAX_SAFE_INTEGERに近い値を受け入れること', () => {
      // Arrange: 大きな有限値を含むベクトル
      const vector = createValidVector();
      vector[0] = Number.MAX_SAFE_INTEGER - 1;

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vector);

      // Assert: 検証が成功すること
      expect(result.isValid).toBe(true);
    });

    it('Number.MIN_SAFE_INTEGERに近い値を受け入れること', () => {
      // Arrange: 小さな有限値を含むベクトル
      const vector = createValidVector();
      vector[0] = Number.MIN_SAFE_INTEGER + 1;

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vector);

      // Assert: 検証が成功すること
      expect(result.isValid).toBe(true);
    });
  });

  // -----------------------------------------------------
  // 異常系テスト - NaN
  // -----------------------------------------------------
  describe('異常系 - NaN', () => {
    it('NaNを含むベクトルを拒否すること', () => {
      // Arrange: 中間位置にNaNを含むベクトル
      const vectorWithNaN = createVectorWithNaN('middle');

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vectorWithNaN);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('INVALID_VECTOR_ELEMENT');
      expect(result.error?.message).toContain('NaN');
    });

    it('先頭位置にNaNを含むベクトルを拒否すること', () => {
      // Arrange: 先頭にNaNを含むベクトル
      const vectorWithNaN = createVectorWithNaN('first');

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vectorWithNaN);

      // Assert: 検証が失敗し、位置情報が含まれること
      expect(result.isValid).toBe(false);
      expect(result.error?.index).toBe(0);
    });

    it('末尾位置にNaNを含むベクトルを拒否すること', () => {
      // Arrange: 末尾にNaNを含むベクトル
      const vectorWithNaN = createVectorWithNaN('last');

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vectorWithNaN);

      // Assert: 検証が失敗し、位置情報が含まれること
      expect(result.isValid).toBe(false);
      expect(result.error?.index).toBe(767);
    });

    it('複数のNaNを含むベクトルを拒否し、最初のNaN位置を報告すること', () => {
      // Arrange: 複数位置にNaNを含むベクトル
      const vector = createValidVector();
      vector[10] = NaN;
      vector[100] = NaN;
      vector[500] = NaN;

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vector);

      // Assert: 最初のNaN位置を報告すること
      expect(result.isValid).toBe(false);
      expect(result.error?.index).toBe(10);
    });
  });

  // -----------------------------------------------------
  // 異常系テスト - Infinity
  // -----------------------------------------------------
  describe('異常系 - Infinity', () => {
    it('正のInfinityを含むベクトルを拒否すること', () => {
      // Arrange: Infinityを含むベクトル
      const vectorWithInfinity = createVectorWithInfinity('positive');

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vectorWithInfinity);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_VECTOR_ELEMENT');
      expect(result.error?.message).toContain('Infinity');
    });

    it('負のInfinityを含むベクトルを拒否すること', () => {
      // Arrange: -Infinityを含むベクトル
      const vectorWithNegativeInfinity = createVectorWithInfinity('negative');

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vectorWithNegativeInfinity);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_VECTOR_ELEMENT');
    });

    it('NaNとInfinityの両方を含むベクトルを拒否すること', () => {
      // Arrange: NaNとInfinityの両方を含むベクトル
      const vector = createValidVector();
      vector[0] = Infinity;
      vector[100] = NaN;

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vector);

      // Assert: 検証が失敗し、最初の無効な要素を報告すること
      expect(result.isValid).toBe(false);
      expect(result.error?.index).toBe(0);
    });
  });

  // -----------------------------------------------------
  // 異常系テスト - 次元数
  // -----------------------------------------------------
  describe('異常系 - 次元数', () => {
    it('768次元未満のベクトルを拒否すること', () => {
      // Arrange: 767次元のベクトル
      const shortVector = new Array(767).fill(0.1);

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(shortVector);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_DIMENSION');
      expect(result.error?.message).toContain('768');
    });

    it('768次元を超えるベクトルを拒否すること', () => {
      // Arrange: 769次元のベクトル
      const longVector = new Array(769).fill(0.1);

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(longVector);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_DIMENSION');
    });

    it('空ベクトルをallowEmpty=falseで拒否すること', () => {
      // Arrange: 空のベクトル
      const emptyVector: number[] = [];

      // Act: バリデーションを実行（allowEmpty=falseがデフォルト）
      const result = validateEmbeddingVector(emptyVector);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_DIMENSION');
    });

    it('1次元のベクトルを拒否すること', () => {
      // Arrange: 1次元のベクトル
      const singleElementVector = [0.1];

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(singleElementVector);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_DIMENSION');
    });
  });

  // -----------------------------------------------------
  // 異常系テスト - 型
  // -----------------------------------------------------
  describe('異常系 - 型', () => {
    it('文字列要素を含むベクトルを拒否すること', () => {
      // Arrange: 文字列を含むベクトル（型を偽装）
      const vectorWithString = createValidVector() as unknown[];
      vectorWithString[0] = '0.1';

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vectorWithString as number[]);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_VECTOR_TYPE');
    });

    it('null要素を含むベクトルを拒否すること', () => {
      // Arrange: nullを含むベクトル
      const vectorWithNull = createValidVector() as unknown[];
      vectorWithNull[50] = null;

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vectorWithNull as number[]);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_VECTOR_TYPE');
    });

    it('undefined要素を含むベクトルを拒否すること', () => {
      // Arrange: undefinedを含むベクトル
      const vectorWithUndefined = createValidVector() as unknown[];
      vectorWithUndefined[100] = undefined;

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vectorWithUndefined as number[]);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_VECTOR_TYPE');
    });

    it('オブジェクト要素を含むベクトルを拒否すること', () => {
      // Arrange: オブジェクトを含むベクトル
      const vectorWithObject = createValidVector() as unknown[];
      vectorWithObject[0] = { value: 0.1 };

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vectorWithObject as number[]);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_VECTOR_TYPE');
    });

    it('nullベクトルを拒否すること', () => {
      // Act: バリデーションを実行
      const result = validateEmbeddingVector(null as unknown as number[]);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_VECTOR');
    });

    it('undefinedベクトルを拒否すること', () => {
      // Act: バリデーションを実行
      const result = validateEmbeddingVector(undefined as unknown as number[]);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_VECTOR');
    });

    it('配列でないオブジェクトを拒否すること', () => {
      // Act: バリデーションを実行
      const result = validateEmbeddingVector({ length: 768 } as unknown as number[]);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_VECTOR');
    });

    it('ブール値要素を含むベクトルを拒否すること', () => {
      // Arrange: ブール値を含むベクトル
      const vectorWithBoolean = createValidVector() as unknown[];
      vectorWithBoolean[0] = true;

      // Act: バリデーションを実行
      const result = validateEmbeddingVector(vectorWithBoolean as number[]);

      // Assert: 検証が失敗すること
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_VECTOR_TYPE');
    });
  });

  // -----------------------------------------------------
  // EmbeddingValidationError クラステスト
  // -----------------------------------------------------
  describe('EmbeddingValidationError', () => {
    it('エラーコードを含むこと', () => {
      // Act: エラーを作成
      const error = new EmbeddingValidationError(
        'INVALID_VECTOR_ELEMENT',
        'Vector contains NaN at index 0',
        0
      );

      // Assert: プロパティが正しいこと
      expect(error.code).toBe('INVALID_VECTOR_ELEMENT');
      expect(error.message).toContain('NaN');
      expect(error.index).toBe(0);
      expect(error.name).toBe('EmbeddingValidationError');
    });

    it('Error を継承していること', () => {
      // Act: エラーを作成
      const error = new EmbeddingValidationError(
        'INVALID_DIMENSION',
        'Expected 768 dimensions'
      );

      // Assert: Error のインスタンスであること
      expect(error).toBeInstanceOf(Error);
    });
  });
});

// =====================================================
// パフォーマンステスト
// =====================================================

describe('validateEmbeddingVector パフォーマンス', () => {
  it('768次元ベクトルの検証が1ms以内に完了すること', () => {
    // Arrange: 有効なベクトル
    const vector = createValidVector();

    // Act: 検証を100回実行して平均時間を計測
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      validateEmbeddingVector(vector);
    }
    const end = performance.now();
    const avgTime = (end - start) / 100;

    // Assert: 平均1ms以内であること
    expect(avgTime).toBeLessThan(1);
  });

  it('バッチ検証が効率的に動作すること', () => {
    // Arrange: 100個のベクトル
    const vectors = Array.from({ length: 100 }, () => createValidVector());

    // Act: 全ベクトルを検証
    const start = performance.now();
    vectors.forEach((v) => validateEmbeddingVector(v));
    const end = performance.now();

    // Assert: 全体で100ms以内であること
    expect(end - start).toBeLessThan(100);
  });
});
