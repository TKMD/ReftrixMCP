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
 * ## 実装戦略 / Implementation strategy (PR-INGEST-FAIL-ROW CONS-2: real catch-path)
 *
 *   PR-INGEST-FAIL-ROW (ADR-0016 Amendment 6) で、従来の no-op model
 *   (`prisma.update` を呼ばないことで worker skip を模倣) を **real
 *   catch-path 化** する。no-op model は real guard を永久に未 exercise に
 *   する偽前提 PASS (CONS-2 test fidelity defect) であった。本 test は
 *   production の `markFailedAndAuditAtomic` を real-DB に対して実呼出する:
 *
 *     1. testcontainer 内に WebPage + >100 parts を seed (W0 相当)
 *     2. W0 を模倣して `analysisStatus='pending'` を書込
 *     3. failure-path の production helper `markFailedAndAuditAtomic` を
 *        実呼出 (url-key upsert) → `{committed:true}` + terminal `failed` row
 *        残存を assert
 *     4. row **不在** のまま `markFailedAndAuditAtomic` を実呼出 (NOROW 経路):
 *        旧 id-key plain UPDATE なら P2025 → transaction_aborted で row 不在
 *        のままだったが、url-key upsert 化 (Amendment 6 §Decision 2) により
 *        terminal `failed` row が **新規 create** されることを real-DB で assert。
 *        これが NOROW closure の core contract。
 *
 *   PR-INGEST-FAIL-ROW (ADR-0016 Amendment 6) replaces the legacy no-op model
 *   (which simulated the worker skip by NOT calling `prisma.update`) with a
 *   **real catch-path**. The no-op model was a false-premise PASS that left
 *   the real guard permanently un-exercised (CONS-2 test fidelity defect).
 *   This test invokes the production `markFailedAndAuditAtomic` against the
 *   live testcontainer DB:
 *
 *     1. Seed a WebPage with >100 parts (W0-equivalent)
 *     2. Simulate W0 by writing `analysisStatus='pending'`
 *     3. Invoke the production failure-path helper `markFailedAndAuditAtomic`
 *        (url-key upsert) → assert `{committed:true}` + terminal `failed` row
 *     4. With the row **absent** (NOROW path): the legacy id-key plain UPDATE
 *        would P2025 → transaction_aborted (row stays absent), but the url-key
 *        upsert (Amendment 6 §Decision 2) **creates** the terminal `failed`
 *        row. Asserted against real DB — this is the NOROW closure contract.
 *
 * @see ADR-0016 Amendment 6 (PR-INGEST-FAIL-ROW: real catch-path, url-key upsert)
 * @see ADR-0016 § Invariants (INV-PAGE-QUEUE-001-C row — carry-over from PR-B)
 * @see decision_search 019da663 (PR-B scope)
 * @see decision_search 019da827 (stripe.com RC-1 confirmation)
 * @see apps/mcp-server/src/services/worker-supervisor-failure-path.service.ts (markFailedAndAuditAtomic)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { assertInvName } from "../_setup/inv-assert";
import {
  markFailedAndAuditAtomic,
  type FailurePathPrismaClient,
} from "../../../../src/services/worker-supervisor-failure-path.service";
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

  it("INV-PAGE-QUEUE-001-C-EARLYINSERT: W0-present row → real markFailedAndAuditAtomic commits terminal failed", async () => {
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
      // 2. REAL catch-path: invoke the production failure-path helper
      //    `markFailedAndAuditAtomic` (url-key upsert) directly against the
      //    live testcontainer DB — NOT a no-op model (CONS-2 fidelity).
      //    seed.url is the normalizeUrlForStorage-equivalent url-key.
      // ----------------------------------------------------------------
      const result = await markFailedAndAuditAtomic(prisma as unknown as FailurePathPrismaClient, {
        webPageId: seed.webPageId,
        normalizedUrl: seed.url,
        errorMessage: "Blocked by robots.txt (simulated)",
        phaseN: "0",
        childPid: 4242,
      });
      expect(result.committed).toBe(true);

      // ----------------------------------------------------------------
      // 3. Primary assertion — the row still exists AND is in the terminal
      //    'failed' state with non-null error / completion timestamps +
      //    canonical failedWithKnownReason. Direct encoding of
      //    INV-PAGE-QUEUE-001-C against the real failure-path helper.
      // ----------------------------------------------------------------
      const afterFailure = await prisma.webPage.findUnique({
        where: { id: seed.webPageId },
        select: {
          analysisStatus: true,
          analysisError: true,
          analysisCompletedAt: true,
          failedWithKnownReason: true,
        },
      });
      expect(afterFailure).not.toBeNull();
      expect(afterFailure!.analysisStatus).toBe(TERMINAL_FAILURE_STATUS);
      expect(afterFailure!.analysisError).toBe("Blocked by robots.txt (simulated)");
      expect(afterFailure!.analysisCompletedAt).toBeInstanceOf(Date);
      expect(afterFailure!.failedWithKnownReason).toBe("worker_restart_during_inflight_phase_0");

      // audit_logs emit (GDPR Art.30) — SSOT actor (CONS-1).
      const auditCount = await prisma.auditLog.count({
        where: {
          action: "worker_restart_during_inflight_phase",
          actor: "system:page-analyze-worker",
        },
      });
      expect(auditCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupSeededWebPage(prisma, seed.webPageId);
    }
  }, 60_000);

  it("INV-PAGE-QUEUE-001-C-EARLYINSERT (NOROW closure): row ABSENT → real markFailedAndAuditAtomic url-key upsert CREATES terminal failed", async () => {
    // ------------------------------------------------------------------
    // PR-INGEST-FAIL-ROW CONS-2 real catch-path: this is the core NOROW
    // closure contract. The legacy no-op model simulated the worker skip by
    // NOT calling prisma.update — a false-premise PASS. We now exercise the
    // REAL production helper `markFailedAndAuditAtomic` against the live DB
    // with the row ABSENT (the NOROW state: W0 failed / fetch threw before
    // W0).
    //
    // Pre-fix (id-key plain UPDATE): row absent → P2025 (Record not found) →
    //   $transaction abort → {committed:false, reason:'transaction_aborted'}
    //   → row STAYS absent (NOROW — the bug).
    // Post-fix (url-key upsert, Amendment 6 §Decision 2): row absent →
    //   CREATE terminal `failed` row → {committed:true} → row PERSISTS.
    //
    // This test asserts the post-fix behavior: a terminal `failed` row is
    // created even when no row pre-existed (NOROW closure). It is a real DB
    // assertion, not a no-op model.
    // ------------------------------------------------------------------
    const orphanWebPageId = randomUUID();
    // RFC 2606 reserved domain (ADR-0016 § Fixture URL Policy). Unique suffix.
    const orphanUrl = `https://example.com/ingest-fail-norow/${orphanWebPageId}`;

    try {
      // Pre-condition: NO row exists for this url (NOROW state).
      const preById = await prisma.webPage.findUnique({
        where: { id: orphanWebPageId },
        select: { id: true },
      });
      expect(preById).toBeNull();
      const preByUrl = await prisma.webPage.findUnique({
        where: { url: orphanUrl },
        select: { id: true },
      });
      expect(preByUrl).toBeNull();

      // REAL catch-path invocation with the row absent.
      const result = await markFailedAndAuditAtomic(prisma as unknown as FailurePathPrismaClient, {
        webPageId: orphanWebPageId,
        normalizedUrl: orphanUrl,
        errorMessage: "Phase 0 fetch failed (NOROW simulated)",
        phaseN: "0",
        childPid: 4242,
      });

      // Post-fix assertion: url-key upsert created the terminal failed row.
      expect(result.committed).toBe(true);

      const created = await prisma.webPage.findUnique({
        where: { url: orphanUrl },
        select: {
          id: true,
          analysisStatus: true,
          analysisError: true,
          analysisCompletedAt: true,
          failedWithKnownReason: true,
        },
      });
      expect(created).not.toBeNull();
      expect(created!.id).toBe(orphanWebPageId);
      expect(created!.analysisStatus).toBe(TERMINAL_FAILURE_STATUS);
      expect(created!.analysisError).toBe("Phase 0 fetch failed (NOROW simulated)");
      expect(created!.analysisCompletedAt).toBeInstanceOf(Date);
      expect(created!.failedWithKnownReason).toBe("worker_restart_during_inflight_phase_0");
    } finally {
      // Cleanup the row created by the upsert (find by url since id matched).
      const row = await prisma.webPage.findUnique({
        where: { url: orphanUrl },
        select: { id: true },
      });
      if (row) {
        await cleanupSeededWebPage(prisma, row.id);
      }
    }
  }, 30_000);
});
