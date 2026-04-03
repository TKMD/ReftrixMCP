// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vector Math Utilities
 * ベクトル演算ユーティリティ
 *
 * cosineSimilarity と parseVectorString の共通実装。
 * 3サービス（design-compare, preference-rerank, design-change-tracker）+
 * similar-site で重複していた関数を統一。
 *
 * Common implementation of cosineSimilarity and parseVectorString.
 * Unifies functions duplicated across 3 services (design-compare,
 * preference-rerank, design-change-tracker) + similar-site.
 *
 * セキュリティ:
 * - NaN/Infinity防御（Number.isFinite）
 * - ゼロベクトル防御
 *
 * @module utils/vector-math
 */

// =====================================================
// Types / 型定義
// =====================================================

/**
 * parseVectorString の NaN 処理戦略
 * NaN handling strategy for parseVectorString
 *
 * - 'null': NaN を含む場合は null を返す / Return null if NaN is found
 * - 'zero': NaN を 0 に置換する / Replace NaN with 0
 * - 'passthrough': NaN を返す空配列で処理する / Return empty array on NaN
 */
export type NanStrategy = "null" | "zero" | "passthrough";

/**
 * parseVectorString のオプション
 * Options for parseVectorString
 */
export interface ParseVectorOptions {
  /** NaN処理戦略 (デフォルト: 'zero') / NaN handling strategy (default: 'zero') */
  nanStrategy?: NanStrategy;
}

// =====================================================
// Cosine Similarity / コサイン類似度
// =====================================================

/**
 * 2つのベクトル間のcosine類似度を計算（基本版）
 * Calculate cosine similarity between two vectors (basic version)
 *
 * NaN/Infinity要素は0として扱い、結果を[0,1]にクランプする。
 * ベクトルの長さが異なる場合やゼロベクトルの場合は0を返す。
 *
 * NaN/Infinity elements are treated as 0, result is clamped to [0,1].
 * Returns 0 if vectors have different lengths or are zero vectors.
 *
 * @param a - ベクトルA / Vector A
 * @param b - ベクトルB / Vector B
 * @returns cosine similarity (0-1) — NaN/Infinity防御済み / NaN/Infinity defended
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const rawA = a[i] ?? 0;
    const rawB = b[i] ?? 0;
    const va = Number.isFinite(rawA) ? rawA : 0;
    const vb = Number.isFinite(rawB) ? rawB : 0;
    dotProduct += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  const similarity = dotProduct / denominator;
  // Clamp to [0, 1] — cosine can be negative but we normalize for similarity
  return Math.max(0, Math.min(1, similarity));
}

/**
 * 2つのベクトル間のcosine類似度を計算（null許容版）
 * Calculate cosine similarity between two vectors (nullable version)
 *
 * いずれかがnullまたは空の場合はnullを返す。
 * NaN/Infinity防御済み、結果を[0,1]にクランプ。
 *
 * Returns null if either is null or empty.
 * NaN/Infinity defended, result clamped to [0,1].
 *
 * @param a - ベクトルA (null許容) / Vector A (nullable)
 * @param b - ベクトルB (null許容) / Vector B (nullable)
 * @returns cosine similarity (0-1), null if either input is null/empty
 */
export function cosineSimilarityNullable(a: number[] | null, b: number[] | null): number | null {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
    return null;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return null;

  const similarity = dotProduct / denominator;

  // NaN/Infinity防御 / NaN/Infinity defense
  if (!Number.isFinite(similarity)) return null;

  // クランプ / Clamp to [0, 1]
  return Math.max(0, Math.min(1, similarity));
}

// =====================================================
// Parse Vector String / ベクトル文字列パース
// =====================================================

/**
 * pgvectorの文字列表現からnumber配列に変換
 * Convert pgvector string representation to number array
 *
 * PostgreSQLのvector型を `::text` で取得した場合の文字列形式
 * "[0.1,0.2,...]" をパースする。
 *
 * Parses the string format "[0.1,0.2,...]" returned when fetching
 * PostgreSQL vector type via `::text`.
 *
 * NaN戦略:
 * - 'null' (デフォルト): NaN/Infinityを含む場合はnullを返す
 * - 'zero': NaN/Infinityを0に置換する
 * - 'passthrough': NaN含有時は空配列を返す（preference-rerank互換）
 *
 * NaN strategies:
 * - 'null' (default): Return null if NaN/Infinity is found
 * - 'zero': Replace NaN/Infinity with 0
 * - 'passthrough': Return empty array on NaN (preference-rerank compatible)
 *
 * @param vectorStr - pgvector文字列 / pgvector string
 * @param options - パースオプション / Parse options
 * @returns パースされたnumber配列、または null / Parsed number array, or null
 */
export function parseVectorString(
  vectorStr: string,
  options?: ParseVectorOptions
): number[] | null {
  const nanStrategy = options?.nanStrategy ?? "null";

  try {
    // pgvector format: "[0.1,0.2,0.3]" — remove brackets
    const cleaned = vectorStr.replace(/^\[/, "").replace(/\]$/, "");
    if (cleaned.length === 0) {
      return nanStrategy === "null" ? null : [];
    }

    const values = cleaned.split(",").map((s) => parseFloat(s.trim()));

    // NaN/Infinity チェック / NaN/Infinity check
    const hasInvalid = values.some((v) => !Number.isFinite(v));

    if (hasInvalid) {
      switch (nanStrategy) {
        case "null":
          return null;
        case "zero":
          return values.map((v) => (Number.isFinite(v) ? v : 0));
        case "passthrough":
          // preference-rerank互換: 空配列を返す
          // preference-rerank compatible: return empty array
          return [];
      }
    }

    return values;
  } catch {
    return nanStrategy === "null" ? null : [];
  }
}
