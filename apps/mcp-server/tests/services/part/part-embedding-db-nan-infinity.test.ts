// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UC-04 (H) — NaN/Infinity pre-filter test.
 *
 * Embedding 生成結果に含まれる `NaN` / `Infinity` は pgvector `vector(768)` 型
 * への書込時にクエリ失敗を引き起こす。ADR-0018 §Decision 3.6 に基づき、
 * `savePartEmbeddings` は transaction 境界の**前段**で `Number.isFinite()`
 * 検証を行い、不正 embedding を `validParts` から除外しなければならない。
 *
 * Per ADR-0018 §Decision 3.6, `savePartEmbeddings` MUST pre-filter `NaN` /
 * `Infinity` embeddings **before** the transaction boundary via
 * `Number.isFinite()`. Invalid embeddings are rejected before `$transaction`
 * is opened, preventing `NaN::vector` writes that would crash pgvector queries.
 *
 * @see ADR-0018 §Decision 3.6 (NaN/Infinity pre-filter)
 * @see CONTRIBUTING.md §Vector Data Validation
 * @see PR-D-2 IO Registry UC-04 (H)
 *
 * @module tests/services/part/part-embedding-db-nan-infinity
 */

import { describe, it, expect, vi } from "vitest";
import {
  savePartEmbeddings,
  type PartEmbeddingPrismaClient,
} from "../../../src/services/part/part-embedding-db.service";
import type { PartEmbeddingResult } from "../../../src/services/part/part-embedding.service";

// ============================================================================
// Fixtures
// ============================================================================

function makeFiniteEmbedding(partId: string): PartEmbeddingResult {
  return {
    componentPartId: partId,
    visualEmbedding: Array.from({ length: 768 }, (_, i) => i * 0.001),
    textEmbedding: Array.from({ length: 768 }, (_, i) => (768 - i) * 0.001),
    textRepresentation: `finite-${partId}`,
  };
}

function makeNanEmbedding(partId: string): PartEmbeddingResult {
  const visualEmbedding = Array.from({ length: 768 }, (_, i) => i * 0.001);
  visualEmbedding[10] = Number.NaN; // contaminate with NaN
  return {
    componentPartId: partId,
    visualEmbedding,
    textEmbedding: Array.from({ length: 768 }, (_, i) => (768 - i) * 0.001),
    textRepresentation: `nan-${partId}`,
  };
}

function makeInfinityEmbedding(partId: string): PartEmbeddingResult {
  return {
    componentPartId: partId,
    visualEmbedding: Array.from({ length: 768 }, (_, i) => i * 0.001),
    textEmbedding: Array.from({ length: 768 }, (_, i) =>
      i === 5 ? Number.POSITIVE_INFINITY : (768 - i) * 0.001
    ),
    textRepresentation: `inf-${partId}`,
  };
}

function makeTextOnlyNanEmbedding(partId: string): PartEmbeddingResult {
  const textEmbedding = Array.from({ length: 768 }, (_, i) => (768 - i) * 0.001);
  textEmbedding[100] = Number.NEGATIVE_INFINITY;
  return {
    componentPartId: partId,
    visualEmbedding: null, // text-only case (e.g., backfill path)
    textEmbedding,
    textRepresentation: `text-nan-${partId}`,
  };
}

function makeMockPrisma() {
  const state = {
    createManyCalls: [] as Array<{ dataCount: number }>,
    updateCalls: [] as Array<{ paramCount: number }>,
    transactionOpened: false,
  };

  const txClient = {
    componentPartEmbedding: {
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        state.createManyCalls.push({ dataCount: args.data.length });
        return { count: args.data.length };
      }),
    },
    $executeRawUnsafe: vi.fn(async (..._values: unknown[]) => {
      state.updateCalls.push({ paramCount: _values.length });
      return 1;
    }),
  };

  const $transaction = vi.fn(
    async (cb: (tx: typeof txClient) => Promise<unknown>, _opts?: { timeout?: number }) => {
      state.transactionOpened = true;
      return cb(txClient);
    }
  );

  return {
    prisma: {
      componentPartEmbedding: txClient.componentPartEmbedding,
      $executeRawUnsafe: txClient.$executeRawUnsafe,
      $transaction,
    },
    state,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("UC-04: savePartEmbeddings NaN/Infinity pre-filter", () => {
  it("rejects NaN in visualEmbedding BEFORE transaction boundary", async () => {
    const { prisma, state } = makeMockPrisma();
    const parts = [
      makeFiniteEmbedding("p1"),
      makeNanEmbedding("p2"), // NaN in visual
      makeFiniteEmbedding("p3"),
    ];

    const result = await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, parts);

    // Transaction opened only if there are valid parts — 2 valid parts remain
    expect(state.transactionOpened).toBe(true);

    // Only 2 valid parts should be written (p2 filtered out).
    // PR-D-3 (UC-06): `generatedCount` is the sole SSOT; `savedCount` alias removed.
    expect(result.generatedCount).toBe(2);

    // The NaN part must NOT have been inserted
    const totalDataInserted = state.createManyCalls.reduce((acc, c) => acc + c.dataCount, 0);
    expect(totalDataInserted).toBe(2);
  });

  it("rejects Infinity in textEmbedding BEFORE transaction boundary", async () => {
    const { prisma } = makeMockPrisma();
    const parts = [makeInfinityEmbedding("p1"), makeFiniteEmbedding("p2")];

    const result = await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, parts);

    // PR-D-3 (UC-06): `generatedCount` is the sole SSOT; `savedCount` alias removed.
    expect(result.generatedCount).toBe(1);
  });

  it("rejects NegativeInfinity in text-only (visualEmbedding=null) embedding", async () => {
    const { prisma } = makeMockPrisma();
    const parts = [
      makeTextOnlyNanEmbedding("p1"), // NEGATIVE_INFINITY in text
      makeFiniteEmbedding("p2"),
    ];

    const result = await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, parts);

    // PR-D-3 (UC-06): `generatedCount` is the sole SSOT; `savedCount` alias removed.
    expect(result.generatedCount).toBe(1);
  });

  it("passes through when ALL embeddings are finite (no filtering)", async () => {
    const { prisma } = makeMockPrisma();
    const parts = [makeFiniteEmbedding("p1"), makeFiniteEmbedding("p2"), makeFiniteEmbedding("p3")];

    const result = await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, parts);

    // PR-D-3 (UC-06): `generatedCount` is the sole SSOT; `savedCount` alias removed.
    expect(result.generatedCount).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("filters ALL when all embeddings contain NaN (transaction no-op or empty)", async () => {
    const { prisma } = makeMockPrisma();
    const parts = [makeNanEmbedding("p1"), makeNanEmbedding("p2")];

    const result = await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, parts);

    // PR-D-3 (UC-06): `generatedCount` is the sole SSOT; `savedCount` alias removed.
    expect(result.generatedCount).toBe(0);
  });
});
