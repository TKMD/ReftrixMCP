// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-EMBEDDING-INTEGRITY-002-A
 *
 * `savePartEmbeddings(parts)` atomic dual-phase write contract.
 *
 * 契約 / Contract:
 *   `savePartEmbeddings(parts)` の実装は、`prisma.$transaction` 境界内で
 *   (a) `createMany` による非ベクトルカラム挿入、(b) `$executeRawUnsafe` による
 *   vector(768) カラム更新の 2 step を atomic に実行しなければならない。
 *   partial failure 時は transaction rollback により "base row exists but
 *   vector is NULL" の半書込状態を絶対に残さない。
 *
 *   `savePartEmbeddings(parts)` MUST execute both (a) non-vector column
 *   `createMany` and (b) vector(768) `$executeRawUnsafe` UPDATE atomically
 *   within a single `prisma.$transaction` boundary. On partial failure the
 *   transaction MUST roll back, leaving NO "base row exists but vector is NULL"
 *   half-written state.
 *
 * @see ADR-0018 §Decision 3 (atomic dual-phase write)
 * @see PR-D-2 Plan §4.2
 * @see INV-EMBEDDING-INTEGRITY-002-A (new invariant landing in PR-D-2)
 *
 * Severity: H (landing PR-D-2)
 *
 * @module tests/regression/standing/embedding-integrity/inv-embedding-integrity-002a-part-atomic-write
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  savePartEmbeddings,
  type PartEmbeddingPrismaClient,
} from "../../../../src/services/part/part-embedding-db.service";
import type { PartEmbeddingResult } from "../../../../src/services/part/part-embedding.service";

// ============================================================================
// Fixtures
// ============================================================================

function makeValidEmbedding(partId: string): PartEmbeddingResult {
  return {
    componentPartId: partId,
    visualEmbedding: Array.from({ length: 768 }, (_, i) => i * 0.001),
    textEmbedding: Array.from({ length: 768 }, (_, i) => (768 - i) * 0.001),
    textRepresentation: `part-${partId}`,
  };
}

/**
 * Create a mock PrismaClient that simulates `$transaction` (interactive).
 * The mock runs the callback with a `tx` client whose behavior is
 * configurable, and surfaces the callback's return value OR rolls back
 * (rethrows) on failure.
 */
type MockConfig = {
  failCreateManyAt?: "always" | "never";
  failUpdateAt?: "never" | "first" | "all";
};

function makeMockPrisma(config: MockConfig = {}) {
  const state = {
    insertedRows: [] as Array<{ id: string; componentPartId: string }>,
    vectorUpdates: [] as Array<{ id: string; ok: boolean }>,
    transactionCommitted: false,
    transactionRolledBack: false,
  };

  let updateCallIndex = 0;

  const txClient = {
    componentPartEmbedding: {
      createMany: vi.fn(async (args: { data: Array<{ componentPartId: string }> }) => {
        if (config.failCreateManyAt === "always") {
          throw new Error("MOCK: createMany failed");
        }
        const count = args.data.length;
        for (const row of args.data) {
          state.insertedRows.push({
            id: `row-${row.componentPartId}`,
            componentPartId: row.componentPartId,
          });
        }
        return { count };
      }),
    },
    $executeRawUnsafe: vi.fn(async (..._values: unknown[]) => {
      const idx = updateCallIndex++;
      const shouldFail =
        config.failUpdateAt === "all" || (config.failUpdateAt === "first" && idx === 0);
      state.vectorUpdates.push({
        id: `vec-${idx}`,
        ok: !shouldFail,
      });
      if (shouldFail) {
        throw new Error(`MOCK: $executeRawUnsafe failed at idx=${idx}`);
      }
      return 1;
    }),
  };

  const $transaction = vi.fn(
    async (cb: (tx: typeof txClient) => Promise<unknown>, _opts?: { timeout?: number }) => {
      try {
        const result = await cb(txClient);
        state.transactionCommitted = true;
        return result;
      } catch (error) {
        // Rollback semantic: clear inserted rows that were part of the
        // aborted transaction (real pgsql MVCC would discard uncommitted rows).
        state.insertedRows = [];
        state.transactionRolledBack = true;
        throw error;
      }
    }
  );

  return {
    prisma: {
      componentPartEmbedding: txClient.componentPartEmbedding,
      $executeRawUnsafe: txClient.$executeRawUnsafe,
      $transaction,
    },
    txClient,
    state,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("INV-EMBEDDING-INTEGRITY-002-A: savePartEmbeddings atomic dual-phase write", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-EMBEDDING-INTEGRITY-002-A");
  });

  it("INV-EMBEDDING-INTEGRITY-002-A: $transaction wraps both createMany and raw vector UPDATE", async () => {
    const { prisma, state } = makeMockPrisma();
    const parts = [makeValidEmbedding("p1"), makeValidEmbedding("p2"), makeValidEmbedding("p3")];

    await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, parts);

    // $transaction must have been called exactly once
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Timeout must be explicit (FIND-PLAN-09 / ADR §3.5 → 10s)
    const optsArg = prisma.$transaction.mock.calls[0]![1] as { timeout?: number } | undefined;
    expect(optsArg).toBeDefined();
    expect(optsArg!.timeout).toBe(10_000);
    // Transaction committed successfully
    expect(state.transactionCommitted).toBe(true);
    expect(state.transactionRolledBack).toBe(false);
  });

  it("INV-EMBEDDING-INTEGRITY-002-A: Step 2 UPDATE failure triggers full transaction rollback (no half-written rows)", async () => {
    const { prisma, state } = makeMockPrisma({ failUpdateAt: "first" });
    const parts = [makeValidEmbedding("p1"), makeValidEmbedding("p2")];

    // savePartEmbeddings must propagate the failure via accumulated `errors[]`
    // OR throw (depending on implementation). Either way, NO row may remain
    // in state.insertedRows (rollback semantic).
    // PR-D-3 (UC-06): `generatedCount` is the sole SSOT; `savedCount` alias removed.
    let threw = false;
    let result: { generatedCount: number; errors: string[] } | undefined;
    try {
      result = await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, parts);
    } catch {
      threw = true;
    }

    // Rollback must have occurred
    expect(state.transactionRolledBack).toBe(true);
    expect(state.insertedRows).toEqual([]); // No half-written rows

    // Either threw or recorded the failure in errors[]
    if (!threw) {
      expect(result!.errors.length).toBeGreaterThan(0);
    }
  });

  it("INV-EMBEDDING-INTEGRITY-002-A: Step 1 createMany failure triggers rollback and surfaces error", async () => {
    const { prisma, state } = makeMockPrisma({ failCreateManyAt: "always" });
    const parts = [makeValidEmbedding("p1")];

    // PR-D-3 (UC-06): `generatedCount` is the sole SSOT; `savedCount` alias removed.
    let threw = false;
    let result: { generatedCount: number; errors: string[] } | undefined;
    try {
      result = await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, parts);
    } catch {
      threw = true;
    }

    expect(state.transactionRolledBack).toBe(true);
    expect(state.insertedRows).toEqual([]);
    if (!threw) {
      expect(result!.errors.length).toBeGreaterThan(0);
      expect(result!.generatedCount).toBe(0);
    }
  });

  it("INV-EMBEDDING-INTEGRITY-002-A: successful transaction returns generatedCount derived from createMany.count (not loop counter)", async () => {
    const { prisma } = makeMockPrisma();
    const parts = [makeValidEmbedding("p1"), makeValidEmbedding("p2"), makeValidEmbedding("p3")];

    const result = await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, parts);

    // PR-D-3 (UC-06): `generatedCount` is the sole SSOT; `savedCount` alias removed.
    // generatedCount is derived solely from createMany.count (INV-EMBEDDING-INTEGRITY-002).
    expect(result.generatedCount).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("INV-EMBEDDING-INTEGRITY-002-A: empty embeddings input is a no-op (no transaction opened)", async () => {
    const { prisma } = makeMockPrisma();
    const result = await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, []);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    // PR-D-3 (UC-06): `generatedCount` is the sole SSOT; `savedCount` alias removed.
    expect(result.generatedCount).toBe(0);
  });
});
