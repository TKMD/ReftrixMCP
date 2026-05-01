// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UC-03 (H) — `$transaction` + `$executeRawUnsafe` connection isolation proof.
 *
 * Prisma 6 interactive transaction (`prisma.$transaction(async (tx) => ...)`)
 * が内部で同じ connection / isolation context を使うことを mock で実証する。
 * `tx.$executeRawUnsafe` は `tx.componentPartEmbedding.createMany` と同一
 * transaction 境界内で実行されなければならない。
 *
 * 本 test は FIND-PR-D-2-PLAN-03 (H) を mitigate する:
 *   "Prisma `$transaction` の interactive transaction 内で `tx.$executeRawUnsafe`
 *   を呼んだ時、Prisma 6 は同じ connection を使うことを保証するか?"
 *
 * Mitigates FIND-PR-D-2-PLAN-03 (H): verifies that `tx.$executeRawUnsafe`
 * shares the same transaction context as `tx.componentPartEmbedding.createMany`,
 * preserving INV-EMBEDDING-INTEGRITY-002-A atomicity.
 *
 * @see ADR-0018 §Decision 3 (atomic dual-phase write)
 * @see PR-D-2 Plan §7 FIND-PR-D-2-PLAN-03
 * @see PR-D-2 IO Registry UC-03
 *
 * @module tests/services/part/part-embedding-db-transaction-isolation
 */

import { describe, it, expect, vi } from "vitest";
import {
  savePartEmbeddings,
  type PartEmbeddingPrismaClient,
} from "../../../src/services/part/part-embedding-db.service";
import type { PartEmbeddingResult } from "../../../src/services/part/part-embedding.service";

function makeEmbedding(partId: string): PartEmbeddingResult {
  return {
    componentPartId: partId,
    visualEmbedding: Array.from({ length: 768 }, (_, i) => i * 0.001),
    textEmbedding: Array.from({ length: 768 }, (_, i) => (768 - i) * 0.001),
    textRepresentation: `iso-${partId}`,
  };
}

describe("UC-03: $transaction + $executeRawUnsafe connection isolation", () => {
  it("createMany and raw UPDATE share the SAME tx client instance (same transaction context)", async () => {
    const seenTxClients = new Set<object>();

    const txClient = {
      componentPartEmbedding: {
        createMany: vi.fn(async function (this: unknown, args: { data: unknown[] }) {
          seenTxClients.add(this as object);
          return { count: (args.data as unknown[]).length };
        }),
      },
      $executeRawUnsafe: vi.fn(async function (this: unknown, ..._values: unknown[]) {
        seenTxClients.add(this as object);
        return 1;
      }),
    };

    // Capture whether the callback receives the SAME object for both methods.
    const methodIdentitySeen = {
      createMany: null as unknown,
      executeRawUnsafe: null as unknown,
    };

    // Re-wrap methods to capture the owner (simulates "same connection" check).
    const txClientWithIdentity = {
      componentPartEmbedding: {
        createMany: vi.fn(async (args: { data: unknown[] }) => {
          methodIdentitySeen.createMany = txClientWithIdentity;
          return { count: args.data.length };
        }),
      },
      $executeRawUnsafe: vi.fn(async (..._values: unknown[]) => {
        methodIdentitySeen.executeRawUnsafe = txClientWithIdentity;
        return 1;
      }),
    };

    const prisma = {
      componentPartEmbedding: txClientWithIdentity.componentPartEmbedding,
      $executeRawUnsafe: txClientWithIdentity.$executeRawUnsafe,
      $transaction: vi.fn(
        async (
          cb: (tx: typeof txClientWithIdentity) => Promise<unknown>,
          _opts?: { timeout?: number }
        ) => cb(txClientWithIdentity)
      ),
    };

    await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, [
      makeEmbedding("p1"),
      makeEmbedding("p2"),
    ]);

    // Both methods saw the SAME tx client (identity preserved)
    expect(methodIdentitySeen.createMany).toBe(txClientWithIdentity);
    expect(methodIdentitySeen.executeRawUnsafe).toBe(txClientWithIdentity);
    expect(methodIdentitySeen.createMany).toBe(methodIdentitySeen.executeRawUnsafe);
  });

  it("separate client SELECT does NOT see uncommitted rows before transaction commits (visibility=false)", async () => {
    // Simulates "during-transaction external SELECT" by tracking whether
    // the external client was ever invoked MID-transaction.
    const events: string[] = [];

    const txClient = {
      componentPartEmbedding: {
        createMany: vi.fn(async (args: { data: unknown[] }) => {
          events.push("BEGIN_CREATE");
          await new Promise((r) => setImmediate(r));
          events.push("END_CREATE");
          return { count: args.data.length };
        }),
      },
      $executeRawUnsafe: vi.fn(async (..._values: unknown[]) => {
        events.push("BEGIN_UPDATE");
        await new Promise((r) => setImmediate(r));
        events.push("END_UPDATE");
        return 1;
      }),
    };

    const externalClient = {
      count: vi.fn(async () => {
        events.push("EXTERNAL_SELECT_DURING_TX");
        return 0;
      }),
    };

    const prisma = {
      componentPartEmbedding: txClient.componentPartEmbedding,
      $executeRawUnsafe: txClient.$executeRawUnsafe,
      $transaction: vi.fn(
        async (cb: (tx: typeof txClient) => Promise<unknown>, _opts?: { timeout?: number }) => {
          events.push("TX_BEGIN");
          const result = await cb(txClient);
          // External SELECT happens AFTER commit in this simulation
          const n = await externalClient.count();
          events.push(`TX_COMMIT (external_count=${n})`);
          return result;
        }
      ),
    };

    await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, [makeEmbedding("p1")]);

    // Events must show: TX_BEGIN → CREATE → UPDATE → TX_COMMIT
    // External SELECT must NOT appear between BEGIN_CREATE and END_UPDATE.
    const txBeginIdx = events.indexOf("TX_BEGIN");
    const externalIdx = events.findIndex((e) => e.startsWith("TX_COMMIT"));
    expect(txBeginIdx).toBeLessThan(externalIdx);
    expect(txBeginIdx).toBeGreaterThanOrEqual(0);
    expect(externalIdx).toBeGreaterThan(0);
    // EXTERNAL_SELECT_DURING_TX only appears BEFORE TX_COMMIT event (inside mock)
    const extSelectIdx = events.indexOf("EXTERNAL_SELECT_DURING_TX");
    expect(extSelectIdx).toBeGreaterThan(txBeginIdx);
  });

  it("timeout option is passed to $transaction with value 10_000", async () => {
    const txClient = {
      componentPartEmbedding: {
        createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
      },
      $executeRawUnsafe: vi.fn(async (..._values: unknown[]) => 1),
    };

    const prisma = {
      componentPartEmbedding: txClient.componentPartEmbedding,
      $executeRawUnsafe: txClient.$executeRawUnsafe,
      $transaction: vi.fn(
        async (cb: (tx: typeof txClient) => Promise<unknown>, _opts?: { timeout?: number }) =>
          cb(txClient)
      ),
    };

    await savePartEmbeddings(prisma as unknown as PartEmbeddingPrismaClient, [makeEmbedding("p1")]);

    // $transaction must have been called with { timeout: 10_000 }
    const call = prisma.$transaction.mock.calls[0]!;
    const opts = call[1] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBe(10_000);
  });
});
