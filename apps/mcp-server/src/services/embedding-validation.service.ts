// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Vector Validation Service
 *
 * SQLに渡される768次元ベクトル配列の型検証を行うサービス。
 * セキュリティレビュー（Phase5）で指摘された以下の問題に対応:
 * - 配列要素が数値であることを確認するバリデーション
 * - isFinite()チェックでNaN/Infinityを除外
 *
 * TDD Red Phase: スタブ実装（テストを失敗させるため）
 *
 * @module services/embedding-validation.service
 */

// =====================================================
// 定数
// =====================================================

/** 期待されるベクトル次元数 */
export const EXPECTED_DIMENSIONS = 768;

// =====================================================
// エラーコード
// =====================================================

/**
 * Embedding検証エラーコード
 */
export type EmbeddingValidationErrorCode =
  | 'INVALID_VECTOR'           // ベクトルがnull/undefinedまたは配列でない
  | 'INVALID_DIMENSION'        // 次元数が不正
  | 'INVALID_VECTOR_TYPE'      // 要素が数値型でない
  | 'INVALID_VECTOR_ELEMENT';  // 要素がNaN/Infinity

// =====================================================
// 型定義
// =====================================================

/**
 * 検証結果
 */
export interface EmbeddingValidationResult {
  /** 検証が成功したかどうか */
  isValid: boolean;
  /** エラー情報（検証失敗時） */
  error?: {
    code: EmbeddingValidationErrorCode;
    message: string;
    index?: number;
  };
}

/**
 * 検証オプション
 */
export interface EmbeddingValidationOptions {
  /** 空ベクトルを許可するかどうか（デフォルト: false） */
  allowEmpty?: boolean;
}

// =====================================================
// EmbeddingValidationError クラス
// =====================================================

/**
 * Embedding検証エラー
 */
export class EmbeddingValidationError extends Error {
  /** エラーコード */
  public readonly code: EmbeddingValidationErrorCode;
  /** 問題のある要素のインデックス（該当する場合） */
  public readonly index: number | undefined;

  constructor(code: EmbeddingValidationErrorCode, message: string, index?: number) {
    super(message);
    this.name = 'EmbeddingValidationError';
    this.code = code;
    this.index = index;

    // Error のプロトタイプチェーンを正しく設定
    Object.setPrototypeOf(this, EmbeddingValidationError.prototype);
  }
}

// =====================================================
// validateEmbeddingVector 関数
// =====================================================

/**
 * Embeddingベクトルを検証する
 *
 * 検証項目:
 * - null/undefined チェック
 * - 配列型チェック
 * - 次元数チェック（768次元）
 * - 要素の型チェック（number）
 * - NaN/Infinity チェック（isFinite）
 *
 * @param vector 検証するベクトル
 * @param options 検証オプション
 * @returns 検証結果
 */
export function validateEmbeddingVector(
  vector: unknown,
  options?: EmbeddingValidationOptions
): EmbeddingValidationResult {
  const allowEmpty = options?.allowEmpty ?? false;

  // Step 1: null/undefinedチェック
  if (vector === null || vector === undefined) {
    return {
      isValid: false,
      error: {
        code: 'INVALID_VECTOR',
        message: 'Vector is null or undefined',
      },
    };
  }

  // Step 2: 配列型チェック
  if (!Array.isArray(vector)) {
    return {
      isValid: false,
      error: {
        code: 'INVALID_VECTOR',
        message: 'Vector is not an array',
      },
    };
  }

  // Step 3: 次元数チェック
  const vectorLength = vector.length;
  if (vectorLength === 0) {
    if (allowEmpty) {
      return { isValid: true };
    }
    return {
      isValid: false,
      error: {
        code: 'INVALID_DIMENSION',
        message: `Expected ${EXPECTED_DIMENSIONS} dimensions, got 0 (empty vector)`,
      },
    };
  }

  if (vectorLength !== EXPECTED_DIMENSIONS) {
    return {
      isValid: false,
      error: {
        code: 'INVALID_DIMENSION',
        message: `Expected ${EXPECTED_DIMENSIONS} dimensions, got ${vectorLength}`,
      },
    };
  }

  // Step 4 & 5: 要素の型チェック + NaN/Infinityチェック
  for (let i = 0; i < vectorLength; i++) {
    const element = vector[i];

    // 型チェック: number型でない場合
    if (typeof element !== 'number') {
      return {
        isValid: false,
        error: {
          code: 'INVALID_VECTOR_TYPE',
          message: `Element at index ${i} is not a number (type: ${typeof element})`,
          index: i,
        },
      };
    }

    // NaN/Infinityチェック
    if (!Number.isFinite(element)) {
      const valueDescription = Number.isNaN(element)
        ? 'NaN'
        : element > 0
          ? 'Infinity'
          : '-Infinity';
      return {
        isValid: false,
        error: {
          code: 'INVALID_VECTOR_ELEMENT',
          message: `Vector contains ${valueDescription} at index ${i}`,
          index: i,
        },
      };
    }
  }

  // すべての検証をパス
  return { isValid: true };
}
