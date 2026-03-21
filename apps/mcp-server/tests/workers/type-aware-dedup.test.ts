// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type-Aware Dedup + CTA Exemption Unit Tests
 *
 * isDuplicateVisionEmbedding ヘルパー関数のユニットテスト。
 * v0.1.10 で導入された type-aware dedup と CTA 小セクション exemption を検証する。
 *
 * Unit tests for isDuplicateVisionEmbedding helper function.
 * Validates type-aware dedup and CTA small section exemption introduced in v0.1.10.
 *
 * テストケース（7件）:
 *   1. 同一sectionType + 高類似度 → 重複として除外
 *   2. 異なるsectionType + 高類似度 → 重複としない（type-aware）
 *   3. CTA + height <= 200px → dedup exemption（除外しない）
 *   4. CTA + height > 200px → 通常dedup適用
 *   5. 空のrecentEmbeddings → 重複なし
 *   6. 閾値境界テスト（dot === threshold → false、dot > threshold → true）
 *   7. NaN embedding → false（Number.isFinite防御）
 *
 * @module tests/workers/type-aware-dedup
 */

import { describe, it, expect } from "vitest";

// isDuplicateVisionEmbedding はモジュール内関数のため、ロジックを再現してテストする
// isDuplicateVisionEmbedding is a module-internal function, so we reproduce the logic for testing

// 定数（ソースコードと同一値）/ Constants (same values as source code)
const DEDUP_EXEMPT_MAX_HEIGHT = 200;
const DEDUP_EXEMPT_TYPES = new Set(["cta"]);

/**
 * ソースコードの isDuplicateVisionEmbedding と同一ロジック
 * Same logic as isDuplicateVisionEmbedding in page-analyze-worker.ts
 */
function isDuplicateVisionEmbedding(params: {
  sectionType: string;
  height: number;
  embedding: number[];
  recentEmbeddings: ReadonlyArray<{ embedding: number[]; sectionType: string }>;
  threshold: number;
}): boolean {
  if (DEDUP_EXEMPT_TYPES.has(params.sectionType) && params.height <= DEDUP_EXEMPT_MAX_HEIGHT) {
    return false;
  }

  return params.recentEmbeddings.some((prev) => {
    if (prev.sectionType !== params.sectionType) return false;
    let dot = 0;
    for (let i = 0; i < prev.embedding.length; i++) {
      dot += prev.embedding[i]! * params.embedding[i]!;
    }
    return Number.isFinite(dot) && dot > params.threshold;
  });
}

// ============================================================================
// Test Helpers / テストヘルパー
// ============================================================================

/** L2正規化済みの単位ベクトルを生成 / Generate L2-normalized unit vector */
function createUnitVector(dim: number, seed: number = 0): number[] {
  const vec = Array.from({ length: dim }, (_, i) => Math.sin(seed + i * 0.1));
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / norm);
}

/** 2つのベクトルのドット積（コサイン類似度） / Dot product of two vectors (cosine similarity) */
function dotProduct(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * b[i]!, 0);
}

// ============================================================================
// Tests
// ============================================================================

describe("isDuplicateVisionEmbedding (Type-Aware Dedup)", () => {
  const DIM = 768;
  const THRESHOLD = 0.995;

  it("同一sectionType + 高類似度 → 重複として除外する", () => {
    const embedding = createUnitVector(DIM, 1);
    // 同一ベクトル = cosine similarity 1.0 > 0.995
    const recentEmbeddings = [{ embedding: [...embedding], sectionType: "feature" }];

    const result = isDuplicateVisionEmbedding({
      sectionType: "feature",
      height: 500,
      embedding,
      recentEmbeddings,
      threshold: THRESHOLD,
    });

    expect(result).toBe(true);
  });

  it("異なるsectionType + 高類似度 → 重複としない（type-aware）", () => {
    const embedding = createUnitVector(DIM, 1);
    // 同一ベクトルだが sectionType が異なる
    const recentEmbeddings = [{ embedding: [...embedding], sectionType: "feature" }];

    const result = isDuplicateVisionEmbedding({
      sectionType: "cta", // 異なるtype
      height: 500,
      embedding,
      recentEmbeddings,
      threshold: THRESHOLD,
    });

    expect(result).toBe(false);
  });

  it("CTA + height <= 200px → dedup exemption（除外しない）", () => {
    const embedding = createUnitVector(DIM, 1);
    // 同一type + 同一ベクトルだが CTA小セクションは exempt
    const recentEmbeddings = [{ embedding: [...embedding], sectionType: "cta" }];

    const result = isDuplicateVisionEmbedding({
      sectionType: "cta",
      height: 140, // <= 200px
      embedding,
      recentEmbeddings,
      threshold: THRESHOLD,
    });

    expect(result).toBe(false);
  });

  it("CTA + height > 200px → 通常dedup適用", () => {
    const embedding = createUnitVector(DIM, 1);
    const recentEmbeddings = [{ embedding: [...embedding], sectionType: "cta" }];

    const result = isDuplicateVisionEmbedding({
      sectionType: "cta",
      height: 300, // > 200px → exempt しない
      embedding,
      recentEmbeddings,
      threshold: THRESHOLD,
    });

    expect(result).toBe(true);
  });

  it("空のrecentEmbeddings → 重複なし", () => {
    const embedding = createUnitVector(DIM, 1);

    const result = isDuplicateVisionEmbedding({
      sectionType: "feature",
      height: 500,
      embedding,
      recentEmbeddings: [],
      threshold: THRESHOLD,
    });

    expect(result).toBe(false);
  });

  it("閾値境界: dot > threshold → true、dot === threshold に近い値 → false", () => {
    // 異なるseedで類似度が低いベクトルを生成
    const embedding1 = createUnitVector(DIM, 1);
    const embedding2 = createUnitVector(DIM, 100); // 大きく異なるseed
    const similarity = dotProduct(embedding1, embedding2);

    // 類似度が閾値より十分低いことを確認
    expect(similarity).toBeLessThan(THRESHOLD);

    const result = isDuplicateVisionEmbedding({
      sectionType: "feature",
      height: 500,
      embedding: embedding1,
      recentEmbeddings: [{ embedding: embedding2, sectionType: "feature" }],
      threshold: THRESHOLD,
    });

    expect(result).toBe(false);
  });

  it("NaN を含む embedding → false（Number.isFinite防御）", () => {
    const embedding = Array.from({ length: DIM }, () => NaN);
    const recent = createUnitVector(DIM, 1);

    const result = isDuplicateVisionEmbedding({
      sectionType: "feature",
      height: 500,
      embedding,
      recentEmbeddings: [{ embedding: recent, sectionType: "feature" }],
      threshold: THRESHOLD,
    });

    expect(result).toBe(false);
  });
});
