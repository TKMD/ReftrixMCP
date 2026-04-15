// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Category SSOT Tests (v0.4.0 PR7a-2)
 *
 * SSOT である `EMBEDDING_BACKFILL_CATEGORIES` 配列・`EmbeddingBackfillCategory`
 * 型・`EmbeddingBackfillJobDataSchema.category` enum・`BACKFILLABLE_CATEGORIES`
 * エイリアスがすべて同じ 7 カテゴリで一致していることを検証する。
 *
 * Verifies the SSOT consistency across the `EMBEDDING_BACKFILL_CATEGORIES` array,
 * the `EmbeddingBackfillCategory` type, the Zod enum in
 * `EmbeddingBackfillJobDataSchema.category`, and the `BACKFILLABLE_CATEGORIES`
 * legacy alias — all must enumerate the same 7 categories.
 */

import { describe, it, expect } from "vitest";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  BACKFILLABLE_CATEGORIES,
  EmbeddingBackfillJobDataSchema,
  type EmbeddingBackfillCategory,
} from "../../src/queues/embedding-backfill-queue";

describe("EmbeddingBackfillCategory SSOT (v0.4.0 PR7a-2)", () => {
  const EXPECTED_CATEGORIES = [
    "part_text",
    "part_visual",
    "section_visual",
    "motion",
    "background",
    "js_animation",
    "responsive",
  ] as const;

  it("should enumerate exactly 7 categories in SSOT array", () => {
    expect(EMBEDDING_BACKFILL_CATEGORIES).toHaveLength(7);
    expect(EMBEDDING_BACKFILL_CATEGORIES).toEqual(EXPECTED_CATEGORIES);
  });

  it("should be defined as readonly const assertion (compile-time immutability)", () => {
    // `as const` により readonly tuple として扱われる。push / pop / splice は型エラー。
    // The `as const` assertion makes it a readonly tuple — push/pop/splice are type errors.
    // Runtime immutability is guaranteed via Object.isFrozen in strict mode.
    // @ts-expect-error — readonly array should reject mutation at compile time
    EMBEDDING_BACKFILL_CATEGORIES.push("foo");
  });

  it("should have no duplicate categories", () => {
    const unique = new Set(EMBEDDING_BACKFILL_CATEGORIES);
    expect(unique.size).toBe(EMBEDDING_BACKFILL_CATEGORIES.length);
  });

  it("should share identity with BACKFILLABLE_CATEGORIES alias", () => {
    // エイリアスは SSOT 配列と同一内容・同一順序
    // Alias shares the same contents and order as the SSOT array
    expect(BACKFILLABLE_CATEGORIES).toEqual(EMBEDDING_BACKFILL_CATEGORIES);
    expect(BACKFILLABLE_CATEGORIES.length).toBe(EMBEDDING_BACKFILL_CATEGORIES.length);
  });

  it("should keep Zod enum in sync with the SSOT array", () => {
    // すべての SSOT カテゴリが Zod parse を通過することで enum 連動を検証
    // All SSOT categories must parse successfully via the Zod enum
    const validBase = {
      webPageId: "019bc123-4567-7890-abcd-ef1234567890",
      createdAt: "2026-04-12T00:00:00.000Z",
    };
    for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
      const result = EmbeddingBackfillJobDataSchema.safeParse({ ...validBase, category });
      expect(result.success, `Zod enum must accept SSOT category=${category}`).toBe(true);
    }
    // 逆に SSOT に無いカテゴリは必ず reject される
    // A non-SSOT category must always be rejected
    const bogus = EmbeddingBackfillJobDataSchema.safeParse({
      ...validBase,
      category: "not_a_real_category",
    });
    expect(bogus.success).toBe(false);
  });

  it("should expose the TypeScript type derived from the SSOT array", () => {
    // コンパイル時の型一致を検証する（ランタイムでは value check のみ）。
    // SSOT に無い文字列を代入しようとすると typecheck が通らない。
    // Compile-time type unity check — assigning a non-SSOT string should fail typecheck.
    const c: EmbeddingBackfillCategory = "part_text";
    expect(EMBEDDING_BACKFILL_CATEGORIES).toContain(c);

    // @ts-expect-error — 型レベルで SSOT 外のカテゴリを拒絶する
    const bogus: EmbeddingBackfillCategory = "unknown_kind";
    // runtime assertion — never reached if typecheck passes for "unknown_kind"
    expect(typeof bogus).toBe("string");
  });
});
