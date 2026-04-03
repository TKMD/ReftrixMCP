// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * vector-math ユーティリティ テスト
 *
 * ベクトル演算ユーティリティの検証
 * - cosineSimilarity: 基本版コサイン類似度（NaN/Infinity防御、[0,1]クランプ）
 * - cosineSimilarityNullable: null許容版コサイン類似度
 * - parseVectorString: pgvector文字列パース（NaN戦略: null/zero/passthrough）
 *
 * Tests for vector math utilities:
 * - cosineSimilarity: basic cosine similarity (NaN/Infinity defense, [0,1] clamp)
 * - cosineSimilarityNullable: nullable cosine similarity
 * - parseVectorString: pgvector string parsing (NaN strategies: null/zero/passthrough)
 *
 * @module tests/utils/vector-math
 */

import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  cosineSimilarityNullable,
  parseVectorString,
} from "../../src/utils/vector-math";

// ============================================================================
// cosineSimilarity / 基本版コサイン類似度
// ============================================================================

describe("cosineSimilarity", () => {
  describe("正常系 / Normal cases", () => {
    it("同一ベクトル → 1 / identical vectors → 1", () => {
      const v = [1, 2, 3];
      expect(cosineSimilarity(v, v)).toBe(1);
    });

    it("同方向のスケーリングベクトル → 1 / same direction scaled vectors → 1", () => {
      expect(cosineSimilarity([1, 0, 0], [5, 0, 0])).toBe(1);
    });

    it("直交ベクトル → 0 / orthogonal vectors → 0", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    });

    it("部分的に類似するベクトル → 0-1の範囲 / partially similar → between 0 and 1", () => {
      const similarity = cosineSimilarity([1, 1, 0], [1, 0, 0]);
      expect(similarity).toBeGreaterThan(0);
      expect(similarity).toBeLessThan(1);
    });

    it("高次元ベクトル / high-dimensional vectors", () => {
      const a = Array.from({ length: 768 }, (_, i) => Math.sin(i));
      const b = Array.from({ length: 768 }, (_, i) => Math.sin(i));
      // 浮動小数点精度の許容 / floating-point precision tolerance
      expect(cosineSimilarity(a, b)).toBeCloseTo(1, 10);
    });
  });

  describe("境界値 / Edge cases", () => {
    it("空配列 → 0 / empty arrays → 0", () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });

    it("長さが異なるベクトル → 0 / different lengths → 0", () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it("ゼロベクトル → 0 / zero vectors → 0", () => {
      expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
    });

    it("片方がゼロベクトル → 0 / one zero vector → 0", () => {
      expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    });

    it("1次元ベクトル / single-dimension vectors", () => {
      expect(cosineSimilarity([3], [7])).toBe(1);
    });
  });

  describe("NaN/Infinity防御 / NaN/Infinity defense", () => {
    it("NaN要素は0として扱う / NaN elements treated as 0", () => {
      // [NaN, 1] → [0, 1], [0, 1] → cos = 1
      expect(cosineSimilarity([NaN, 1], [0, 1])).toBe(1);
    });

    it("Infinity要素は0として扱う / Infinity elements treated as 0", () => {
      expect(cosineSimilarity([Infinity, 1], [0, 1])).toBe(1);
    });

    it("-Infinity要素は0として扱う / -Infinity elements treated as 0", () => {
      expect(cosineSimilarity([-Infinity, 1], [0, 1])).toBe(1);
    });

    it("全NaN要素 → 0（ゼロベクトル扱い）/ all NaN → 0 (zero vector)", () => {
      expect(cosineSimilarity([NaN, NaN], [1, 1])).toBe(0);
    });

    it("両方にNaN/Infinity混在 / both vectors with mixed NaN/Infinity", () => {
      // [NaN, 1, Inf] → [0, 1, 0], [Inf, 0, NaN] → [0, 0, 0]
      expect(cosineSimilarity([NaN, 1, Infinity], [Infinity, 0, NaN])).toBe(0);
    });
  });

  describe("[0,1]クランプ / [0,1] clamp", () => {
    it("反対方向ベクトルは0にクランプ / opposite vectors clamped to 0", () => {
      // cos(-1) → clamp to 0
      expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
    });

    it("結果は常に0以上 / result is always >= 0", () => {
      expect(cosineSimilarity([1, -1], [-1, 1])).toBe(0);
    });

    it("結果は常に1以下 / result is always <= 1", () => {
      const v = [1, 2, 3, 4, 5];
      expect(cosineSimilarity(v, v)).toBeLessThanOrEqual(1);
    });
  });
});

// ============================================================================
// cosineSimilarityNullable / null許容版コサイン類似度
// ============================================================================

describe("cosineSimilarityNullable", () => {
  describe("null/空入力 → null / null/empty inputs → null", () => {
    it("a=null → null", () => {
      expect(cosineSimilarityNullable(null, [1, 2, 3])).toBeNull();
    });

    it("b=null → null", () => {
      expect(cosineSimilarityNullable([1, 2, 3], null)).toBeNull();
    });

    it("両方null → null / both null → null", () => {
      expect(cosineSimilarityNullable(null, null)).toBeNull();
    });

    it("a=空配列 → null / a=empty array → null", () => {
      expect(cosineSimilarityNullable([], [1, 2, 3])).toBeNull();
    });

    it("b=空配列 → null / b=empty array → null", () => {
      expect(cosineSimilarityNullable([1, 2, 3], [])).toBeNull();
    });

    it("両方空配列 → null / both empty → null", () => {
      expect(cosineSimilarityNullable([], [])).toBeNull();
    });
  });

  describe("ゼロベクトル → null / zero vectors → null", () => {
    it("両方ゼロベクトル → null / both zero vectors → null", () => {
      expect(cosineSimilarityNullable([0, 0, 0], [0, 0, 0])).toBeNull();
    });

    it("片方ゼロベクトル → null / one zero vector → null", () => {
      expect(cosineSimilarityNullable([1, 2, 3], [0, 0, 0])).toBeNull();
    });
  });

  describe("長さ不一致 → null / length mismatch → null", () => {
    it("異なる長さ → null / different lengths → null", () => {
      expect(cosineSimilarityNullable([1, 2], [1, 2, 3])).toBeNull();
    });
  });

  describe("有効な入力 / valid inputs", () => {
    it("同一ベクトル → 1 / identical vectors → 1", () => {
      expect(cosineSimilarityNullable([1, 2, 3], [1, 2, 3])).toBe(1);
    });

    it("直交ベクトル → 0 / orthogonal vectors → 0", () => {
      expect(cosineSimilarityNullable([1, 0], [0, 1])).toBe(0);
    });

    it("部分的に類似 → 0-1の範囲 / partially similar → between 0 and 1", () => {
      const result = cosineSimilarityNullable([1, 1, 0], [1, 0, 0]);
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(0);
      expect(result!).toBeLessThan(1);
    });

    it("反対方向 → 0にクランプ / opposite direction → clamped to 0", () => {
      expect(cosineSimilarityNullable([1, 0], [-1, 0])).toBe(0);
    });
  });

  describe("NaN/Infinity → null / NaN/Infinity in result → null", () => {
    it("NaN要素で分母が0になる場合 → null / NaN causing zero denominator → null", () => {
      // [NaN, NaN] は実質ゼロベクトル扱いではなく、NaN伝播により結果がNaN
      // denominator = sqrt(NaN) * sqrt(...) = NaN → not finite → null
      expect(cosineSimilarityNullable([NaN, NaN], [1, 1])).toBeNull();
    });

    it("Infinity要素が結果をInfinityにする場合 → null / Infinity making result Infinity → null", () => {
      expect(cosineSimilarityNullable([Infinity, 1], [1, 1])).toBeNull();
    });

    it("-Infinity要素 → null / -Infinity elements → null", () => {
      expect(cosineSimilarityNullable([-Infinity, 1], [1, 1])).toBeNull();
    });
  });
});

// ============================================================================
// parseVectorString / ベクトル文字列パース
// ============================================================================

describe("parseVectorString", () => {
  describe("正常系 / Normal cases", () => {
    it("有効なpgvector文字列をパースする / parses valid pgvector string", () => {
      expect(parseVectorString("[0.1,0.2,0.3]")).toEqual([0.1, 0.2, 0.3]);
    });

    it("整数値を含む文字列 / string with integer values", () => {
      expect(parseVectorString("[1,2,3]")).toEqual([1, 2, 3]);
    });

    it("負の値を含む文字列 / string with negative values", () => {
      expect(parseVectorString("[-0.5,0.0,0.5]")).toEqual([-0.5, 0, 0.5]);
    });

    it("スペースを含む文字列 / string with spaces", () => {
      expect(parseVectorString("[0.1, 0.2, 0.3]")).toEqual([0.1, 0.2, 0.3]);
    });

    it("1要素のベクトル / single-element vector", () => {
      expect(parseVectorString("[0.5]")).toEqual([0.5]);
    });

    it("高次元ベクトル / high-dimensional vector", () => {
      const values = Array.from({ length: 768 }, (_, i) => i * 0.001);
      const str = `[${values.join(",")}]`;
      const result = parseVectorString(str);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(768);
      expect(result![0]).toBeCloseTo(0);
      expect(result![767]).toBeCloseTo(0.767);
    });
  });

  describe("空文字列 / empty string", () => {
    it("空文字列 + nanStrategy='null'（デフォルト）→ null / empty string + default → null", () => {
      expect(parseVectorString("")).toBeNull();
    });

    it("空文字列 + nanStrategy='zero' → 空配列 / empty string + zero → empty array", () => {
      expect(parseVectorString("", { nanStrategy: "zero" })).toEqual([]);
    });

    it("空文字列 + nanStrategy='passthrough' → 空配列 / empty string + passthrough → empty array", () => {
      expect(parseVectorString("", { nanStrategy: "passthrough" })).toEqual([]);
    });

    it("空ブラケット → null（デフォルト）/ empty brackets → null (default)", () => {
      expect(parseVectorString("[]")).toBeNull();
    });

    it("空ブラケット + nanStrategy='zero' → 空配列 / empty brackets + zero → empty array", () => {
      expect(parseVectorString("[]", { nanStrategy: "zero" })).toEqual([]);
    });
  });

  describe("NaN戦略: 'null'（デフォルト）/ NaN strategy: 'null' (default)", () => {
    it("NaN値を含む → null / string with NaN → null", () => {
      expect(parseVectorString("[0.1,NaN,0.3]")).toBeNull();
    });

    it("非数値文字列 → null / non-numeric string → null", () => {
      expect(parseVectorString("[0.1,abc,0.3]")).toBeNull();
    });

    it("明示的にnull戦略を指定 / explicitly specify null strategy", () => {
      expect(parseVectorString("[0.1,NaN,0.3]", { nanStrategy: "null" })).toBeNull();
    });
  });

  describe("NaN戦略: 'zero' / NaN strategy: 'zero'", () => {
    it("NaN値を0に置換 / replaces NaN with 0", () => {
      expect(parseVectorString("[0.1,NaN,0.3]", { nanStrategy: "zero" })).toEqual([0.1, 0, 0.3]);
    });

    it("非数値文字列を0に置換 / replaces non-numeric with 0", () => {
      expect(parseVectorString("[0.1,abc,0.3]", { nanStrategy: "zero" })).toEqual([0.1, 0, 0.3]);
    });

    it("全てNaN → 全て0 / all NaN → all zeros", () => {
      expect(parseVectorString("[NaN,NaN,NaN]", { nanStrategy: "zero" })).toEqual([0, 0, 0]);
    });
  });

  describe("NaN戦略: 'passthrough' / NaN strategy: 'passthrough'", () => {
    it("NaN含有時は空配列 / NaN present → empty array", () => {
      expect(parseVectorString("[0.1,NaN,0.3]", { nanStrategy: "passthrough" })).toEqual([]);
    });

    it("有効なベクトルはそのまま返す / valid vector returned as-is", () => {
      expect(parseVectorString("[0.1,0.2,0.3]", { nanStrategy: "passthrough" })).toEqual([
        0.1, 0.2, 0.3,
      ]);
    });
  });

  describe("Infinity値 / Infinity values", () => {
    it("Infinity + nanStrategy='null' → null / Infinity + null strategy → null", () => {
      expect(parseVectorString("[0.1,Infinity,0.3]")).toBeNull();
    });

    it("-Infinity + nanStrategy='null' → null / -Infinity + null strategy → null", () => {
      expect(parseVectorString("[0.1,-Infinity,0.3]")).toBeNull();
    });

    it("Infinity + nanStrategy='zero' → 0に置換 / Infinity + zero strategy → replaced with 0", () => {
      expect(parseVectorString("[0.1,Infinity,0.3]", { nanStrategy: "zero" })).toEqual([
        0.1, 0, 0.3,
      ]);
    });

    it("Infinity + nanStrategy='passthrough' → 空配列 / Infinity + passthrough → empty array", () => {
      expect(parseVectorString("[0.1,Infinity,0.3]", { nanStrategy: "passthrough" })).toEqual([]);
    });
  });

  describe("不正な文字列 / malformed strings", () => {
    it("ブラケットなし → パース可能 / no brackets → parseable", () => {
      // replace removes leading [ and trailing ] — no brackets means split works on raw string
      expect(parseVectorString("0.1,0.2,0.3")).toEqual([0.1, 0.2, 0.3]);
    });

    it("完全に無効な文字列 + nanStrategy='null' → null / completely invalid + null → null", () => {
      expect(parseVectorString("not a vector")).toBeNull();
    });

    it("完全に無効な文字列 + nanStrategy='zero' → 0に置換 / completely invalid + zero → zeros", () => {
      expect(parseVectorString("abc", { nanStrategy: "zero" })).toEqual([0]);
    });

    it("完全に無効な文字列 + nanStrategy='passthrough' → 空配列 / completely invalid + passthrough → empty", () => {
      expect(parseVectorString("abc", { nanStrategy: "passthrough" })).toEqual([]);
    });
  });
});
