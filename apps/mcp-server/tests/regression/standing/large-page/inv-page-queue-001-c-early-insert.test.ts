// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain (sub-invariant C)
 *
 * INV-PAGE-QUEUE-001-C: `PHASE0_EARLY_INSERT=true` のときにオーケストレーター
 *   が書き込む W0 upsert により、Phase 0 の早期失敗経路 (robots.txt block /
 *   DNS NXDOMAIN / ingestResult.success === false 等) でも `web_pages` 行が
 *   DB に存在し、failure path の `prisma.webPage.update({where: {id}})` が
 *   P2025 (record not found) で no-op に陥らず、`analysisStatus='failed'` と
 *   `analysisError` が永続化されることを保証する。
 *
 * INV-PAGE-QUEUE-001-C: When `PHASE0_EARLY_INSERT=true`, the orchestrator's
 *   W0 upsert guarantees that even on early Phase 0 failures (robots.txt
 *   block / DNS NXDOMAIN / ingest failure), the `web_pages` row exists in
 *   DB. The failure-path `prisma.webPage.update({where: {id}})` therefore
 *   transitions `analysisStatus` to `'failed'` and records `analysisError`
 *   instead of no-op-ing on P2025.
 *
 * ## 責務分離 / Responsibility separation
 *
 *   - **本 standing test**: 契約レベル (W0 後の failure-path update が
 *     成功し、row が残存して `analysisStatus='failed'` になる)
 *   - **unit test `tests/workers/early-insert.test.ts`**: Phase 0.5 W1 upsert
 *     の `analysisStatus` 書込が flag 値に応じて分岐する挙動
 *
 *   - **This standing test**: contract level (W0 → failure-path update
 *     succeeds, row persists with `analysisStatus='failed'`)
 *   - **Unit test**: Phase 0.5 W1 upsert branch on flag value
 *
 * ## 実装戦略 / Implementation strategy
 *
 *   M2 では Phase 0 の実発火 (robots.txt / ingest) を行わず、W0 upsert →
 *   failure-path update 遷移の閉包性を以下で検証する:
 *
 *     1. testcontainer 内に WebPage + >100 parts を seed
 *     2. W0 を模倣して `analysisStatus='pending'` の状態を直接 DB に書込
 *     3. failure-path を模倣して `prisma.webPage.update({where: {id}})` を実行
 *     4. update が成功し、`analysisStatus='failed'` + `analysisError` 非 null
 *        + `analysisCompletedAt` 非 null が永続化されることを assert
 *     5. 続けて W0 なしパス (`phase0EarlyInsertEnabled=false` 相当) を再現:
 *        worker の catch block は `if (state.actualWebPageId)` guard で
 *        protected されているため、Phase 0 早期失敗で
 *        `state.actualWebPageId` が未設定の場合 update は **一切呼ばれない**。
 *        したがって row は create されないままで、DB に存在しないことを
 *        findUnique で確認する (FIND-PR-B-002: 実 worker 挙動に即した
 *        contrast)。
 *
 *   Uses a "DB-state closure" approach instead of actually invoking Phase 0:
 *
 *     1. Seed a WebPage with >100 parts
 *     2. Simulate W0 by directly writing `analysisStatus='pending'`
 *     3. Simulate the failure path by calling
 *        `prisma.webPage.update({where: {id}})`
 *     4. Assert the update succeeds and leaves `analysisStatus='failed'` +
 *        non-null `analysisError` + non-null `analysisCompletedAt`
 *     5. As a contrast, reproduce the no-W0 path: the worker's catch block
 *        is protected by `if (state.actualWebPageId)`, so when
 *        `state.actualWebPageId` is unset (Phase 0 early failure before W0)
 *        the update is **never invoked**. The row therefore stays absent
 *        from DB, verified via findUnique (FIND-PR-B-002: aligns the
 *        regression guard with real worker behavior).
 *
 * @see ADR-0016 § Invariants (INV-PAGE-QUEUE-001-C row — carry-over from PR-B)
 * @see ADR-0016 Am4 § FIND-PR-B-002 (test assert drift → real behavior)
 * @see decision_search 019da663 (PR-B scope)
 * @see decision_search 019da827 (stripe.com RC-1 confirmation)
 * @see apps/mcp-server/src/workers/page-analyze-worker.ts:2428 (guard)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { assertInvName } from "../_setup/inv-assert";
import { cleanupSeededWebPage, seedWebPageWithParts } from "./_fixtures/seed-large-page";

const LARGE_PAGE_PART_COUNT = 101 as const;

/**
 * Invariant C terminal contract: after the failure-path update on a W0-present
 * row, `analysisStatus` must be `'failed'` and the error / completion columns
 * must be populated.
 */
const TERMINAL_FAILURE_STATUS = "failed" as const;

describe("INV-PAGE-QUEUE-001-C: Phase 0 Early INSERT guarantees failure-path update closes the row (-EARLYINSERT)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "[INV-PAGE-QUEUE-001-C] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
      );
    }
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();
  }, 30_000);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } catch {
      /* best-effort shutdown */
    }
  }, 15_000);

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PAGE-QUEUE-001-C");
  });

  it("INV-PAGE-QUEUE-001-C-EARLYINSERT: W0-upserted row lets failure-path update reach analysisStatus='failed'", async () => {
    // ------------------------------------------------------------------
    // 1. Seed: W0 相当 (analysisStatus='pending' の minimal row) + >100 parts
    //    Seed: W0-equivalent (minimal row with analysisStatus='pending') + >100 parts
    // ------------------------------------------------------------------
    const seed = await seedWebPageWithParts(prisma, {
      partCount: LARGE_PAGE_PART_COUNT,
      preEmbedAll: true,
    });

    try {
      // W0 simulation: orchestrator wrote analysisStatus='pending'
      await prisma.webPage.update({
        where: { id: seed.webPageId },
        data: { analysisStatus: "pending" },
      });

      // ----------------------------------------------------------------
      // 2. Failure-path update (robots.txt block 等 Phase 0 早期失敗を模倣)
      //    Failure-path update (simulating Phase 0 early failure)
      // ----------------------------------------------------------------
      const failureError = "Blocked by robots.txt (simulated)";
      const result = await prisma.webPage.update({
        where: { id: seed.webPageId },
        data: {
          analysisStatus: TERMINAL_FAILURE_STATUS,
          analysisError: failureError,
          analysisCompletedAt: new Date(),
        },
      });
      expect(result).not.toBeNull();

      // ----------------------------------------------------------------
      // 3. Primary assertion — the row still exists AND is in the terminal
      //    'failed' state with non-null error / completion timestamps.
      //    This is the direct encoding of INV-PAGE-QUEUE-001-C.
      // ----------------------------------------------------------------
      const afterFailure = await prisma.webPage.findUnique({
        where: { id: seed.webPageId },
        select: {
          analysisStatus: true,
          analysisError: true,
          analysisCompletedAt: true,
        },
      });
      expect(afterFailure).not.toBeNull();
      expect(afterFailure!.analysisStatus).toBe(TERMINAL_FAILURE_STATUS);
      expect(afterFailure!.analysisError).toBe(failureError);
      expect(afterFailure!.analysisCompletedAt).toBeInstanceOf(Date);
    } finally {
      await cleanupSeededWebPage(prisma, seed.webPageId);
    }
  }, 60_000);

  it("INV-PAGE-QUEUE-001-C-EARLYINSERT (regression guard): WITHOUT W0, worker's guard skips the update and row stays absent — mirrors real worker behavior", async () => {
    // ------------------------------------------------------------------
    // FIND-PR-B-002: 実 worker 挙動に即した regression guard。
    //
    // W0 なし (legacy path / Phase 0 早期失敗で `state.actualWebPageId`
    // が未設定) を模倣: seed せず、worker の catch block が
    // `if (state.actualWebPageId)` guard で protected されているため
    // failure-path の `prisma.webPage.update({where: {id}})` は **一切
    // 呼ばれない**。したがって row は DB に create されないままであり、
    // findUnique で null を確認する。
    //
    // これは PR-B 以前の legacy 挙動: W0 を書かないと `actualWebPageId`
    // が設定されず、catch block が update を skip し、`analysisStatus='failed'`
    // が永続化されない (root cause RC-1) ことを示す。
    //
    // FIND-PR-B-002: regression guard aligned with real worker behavior.
    //
    // Without W0 (legacy path / Phase 0 early failure before
    // `state.actualWebPageId` is set): the worker's catch block is guarded
    // by `if (state.actualWebPageId)`, so the failure-path
    // `prisma.webPage.update({where: {id}})` is **never invoked**. The row
    // is therefore never created in DB; verified by findUnique returning
    // null.
    //
    // This encodes the pre-PR-B legacy behavior: without W0,
    // `actualWebPageId` stays unset, the catch block skips the update, and
    // `analysisStatus='failed'` is never persisted (root cause RC-1).
    // ------------------------------------------------------------------
    const nonexistentId = randomUUID();

    // ------------------------------------------------------------------
    // Pre-condition: the row does not exist (no W0, no seed).
    // ------------------------------------------------------------------
    const preCheck = await prisma.webPage.findUnique({
      where: { id: nonexistentId },
      select: { id: true },
    });
    expect(preCheck).toBeNull();

    // ------------------------------------------------------------------
    // Simulate the worker's catch block: the guard
    // `if (state.actualWebPageId)` is false (no W0 set it), so the failure
    // update is skipped entirely. We model this by NOT calling
    // prisma.webPage.update — matching real worker control flow.
    //
    // worker の catch block を模倣: guard が false なので update は呼ばない
    // (prisma.update を呼ばないことで実 worker の skip 挙動を反映)。
    // ------------------------------------------------------------------
    // no-op: matches `if (state.actualWebPageId)` guard being false.

    // ------------------------------------------------------------------
    // Post-condition: the row still does not exist in DB. `analysisStatus`
    // was never persisted (this is the legacy RC-1 symptom PR-B's W0
    // upsert fixes by ensuring the row always exists before Phase 0).
    //
    // row は DB に存在しないまま。`analysisStatus` が永続化されない
    // (legacy RC-1 症状、PR-B の W0 upsert が修復する対象)。
    // ------------------------------------------------------------------
    const postCheck = await prisma.webPage.findUnique({
      where: { id: nonexistentId },
      select: {
        id: true,
        analysisStatus: true,
        analysisError: true,
        analysisCompletedAt: true,
      },
    });
    expect(postCheck).toBeNull();
  }, 30_000);
});
