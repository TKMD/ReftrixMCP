// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-INGEST-FAIL-ROW-001 (PR-INGEST-FAIL-ROW / BUG-2 / ADR-0016 Amendment 6)
 *
 * Phase 0 (ingest) の fetch fail で「NOROW」(web_pages row 未作成 + terminal
 * status なし + audit_logs なし = 完全に観測不能) が起きないことを保証する。
 * run3 CPU 10-site 検証で textfiles / neverssl の 2 sites が NOROW で観測不能
 * だった observability gap を closure する。
 *
 * Guarantees that Phase 0 (ingest) fetch failures do NOT produce "NOROW" (no
 * web_pages row + no terminal status + no audit_logs = fully unobservable),
 * closing the observability gap observed for textfiles / neverssl in the run3
 * CPU 10-site verification.
 *
 * ## 不変条件 / Invariants (A/B/C)
 *
 *   - **A (real flag=true fault-injection)**: row 不在 (NOROW state) で
 *     production の `markFailedAndAuditAtomic` (url-key upsert) を real-DB に
 *     実呼出 → terminal `failed` row が **新規 create** される。既存 no-op
 *     test に依存しない (CONS-4)。
 *   - **B (並行 retry fault injection, CONS-3)**: 同一 url × 別 webPageId の
 *     並行 retry を real-DB で誘発 → url-key upsert により `url @unique`
 *     (`schema.prisma:208`) P2002 退行が起きず、両 retry が同一行に収束し
 *     terminal `failed` が残る (CWE-362 race closure)。
 *   - **C (release event 非終端保持)**: row 存在後に `recordWorkerRelease`
 *     (release event) を real-DB に書込 → FK (P2003、`schema.prisma:2047`) が
 *     解消し worker_job_lifecycle に release event が残る (supervisor backfill
 *     が true-orphan と区別可能)。
 *
 *   - **A**: with the row ABSENT (NOROW state), invoke the production
 *     `markFailedAndAuditAtomic` (url-key upsert) against the real DB → the
 *     terminal `failed` row is **created**. Does NOT depend on the legacy
 *     no-op test (CONS-4).
 *   - **B (CONS-3)**: induce a concurrent retry (same url × different
 *     webPageId) against the real DB → the url-key upsert avoids a
 *     `url @unique` P2002 regression; both retries converge on one row with a
 *     terminal `failed` status (CWE-362 race closure).
 *   - **C**: after the row exists, write a `recordWorkerRelease` (release
 *     event) against the real DB → the FK (P2003) is resolved and the release
 *     event persists in worker_job_lifecycle (so supervisor backfill can
 *     distinguish from a true orphan).
 *
 * @see ADR-0016 Amendment 6 (PR-INGEST-FAIL-ROW: default flip + url-key upsert)
 * @see apps/mcp-server/src/services/worker-supervisor-failure-path.service.ts (markFailedAndAuditAtomic)
 * @see apps/mcp-server/src/services/worker-supervisor-helpers.ts (recordWorkerRelease)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { assertInvName } from "../_setup/inv-assert";
import {
  markFailedAndAuditAtomic,
  type FailurePathPrismaClient,
} from "../../../../src/services/worker-supervisor-failure-path.service";
import {
  recordWorkerRelease,
  type WorkerJobLifecyclePrismaClient,
} from "../../../../src/services/worker-supervisor-helpers";
import { cleanupSeededWebPage } from "./_fixtures/seed-large-page";

const TERMINAL_FAILURE_STATUS = "failed" as const;

describe("INV-INGEST-FAIL-ROW-001: Phase 0 ingest-fail terminal row persistence (NOROW closure)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "[INV-INGEST-FAIL-ROW-001] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
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
    assertInvName(expect.getState().currentTestName ?? "", "INV-INGEST-FAIL-ROW-001");
  });

  // ==========================================================================
  // A — real flag=true fault-injection (NOROW → terminal failed created)
  // ==========================================================================
  it("INV-INGEST-FAIL-ROW-001-A: row ABSENT (real fetch-fail) → url-key upsert creates terminal failed row", async () => {
    const webPageId = randomUUID();
    const url = `https://example.com/inv-ingest-fail-a/${webPageId}`;

    try {
      // Pre-condition: NOROW (the real fault-injection state — fetch threw
      // before any row was written).
      const pre = await prisma.webPage.findUnique({ where: { url }, select: { id: true } });
      expect(pre).toBeNull();

      // REAL production failure-path helper (NOT a no-op model, CONS-4).
      const result = await markFailedAndAuditAtomic(prisma as unknown as FailurePathPrismaClient, {
        webPageId,
        normalizedUrl: url,
        errorMessage: "Phase 0 fetch failed: DNS NXDOMAIN (simulated)",
        phaseN: "0",
        childPid: 4242,
      });
      expect(result.committed).toBe(true);

      // Terminal failed row created.
      const created = await prisma.webPage.findUnique({
        where: { url },
        select: {
          id: true,
          analysisStatus: true,
          analysisError: true,
          analysisCompletedAt: true,
          failedWithKnownReason: true,
        },
      });
      expect(created).not.toBeNull();
      expect(created!.id).toBe(webPageId);
      expect(created!.analysisStatus).toBe(TERMINAL_FAILURE_STATUS);
      expect(created!.analysisError).toContain("DNS NXDOMAIN");
      expect(created!.analysisCompletedAt).toBeInstanceOf(Date);
      expect(created!.failedWithKnownReason).toBe("worker_restart_during_inflight_phase_0");

      // audit_logs (GDPR Art.30) with SSOT actor (CONS-1).
      const auditCount = await prisma.auditLog.count({
        where: {
          action: "worker_restart_during_inflight_phase",
          actor: "system:page-analyze-worker",
        },
      });
      expect(auditCount).toBeGreaterThanOrEqual(1);
    } finally {
      const row = await prisma.webPage.findUnique({ where: { url }, select: { id: true } });
      if (row) await cleanupSeededWebPage(prisma, row.id);
    }
  }, 30_000);

  // ==========================================================================
  // B — concurrent retry fault injection (CONS-3 url-key, CWE-362)
  // ==========================================================================
  it("INV-INGEST-FAIL-ROW-001-B: concurrent retry (same url × different webPageId) → url-key upsert converges, no P2002 regression", async () => {
    // Same url, two DIFFERENT worker-generated webPageIds (the CWE-362 race:
    // a retry of the same URL gets a fresh worker webPageId). An id-key upsert
    // create branch would let the second create hit `url @unique` → P2002 →
    // transaction_aborted → NOROW regression. The url-key upsert collapses both
    // onto the single `url @unique` row.
    const url = `https://example.com/inv-ingest-fail-b/${randomUUID()}`;
    const webPageIdA = randomUUID();
    const webPageIdB = randomUUID();

    try {
      const pre = await prisma.webPage.findUnique({ where: { url }, select: { id: true } });
      expect(pre).toBeNull();

      // Fire both failure-path upserts concurrently against the real DB.
      const [resA, resB] = await Promise.all([
        markFailedAndAuditAtomic(prisma as unknown as FailurePathPrismaClient, {
          webPageId: webPageIdA,
          normalizedUrl: url,
          errorMessage: "Phase 0 fetch failed: retry A (simulated)",
          phaseN: "0",
          childPid: 1111,
        }),
        markFailedAndAuditAtomic(prisma as unknown as FailurePathPrismaClient, {
          webPageId: webPageIdB,
          normalizedUrl: url,
          errorMessage: "Phase 0 fetch failed: retry B (simulated)",
          phaseN: "0",
          childPid: 2222,
        }),
      ]);

      // BOTH committed (no P2002 transaction_aborted regression). This is the
      // direct encoding of CONS-3: the url-key upsert never trips `url @unique`
      // on the create branch because both retries key on the same url.
      expect(resA.committed).toBe(true);
      expect(resB.committed).toBe(true);

      // Exactly ONE row exists for the url (converged, no duplicate create).
      const rows = await prisma.webPage.findMany({
        where: { url },
        select: { id: true, analysisStatus: true, failedWithKnownReason: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.analysisStatus).toBe(TERMINAL_FAILURE_STATUS);
      expect(rows[0]!.failedWithKnownReason).toBe("worker_restart_during_inflight_phase_0");
      // The converged row id is one of the two worker-generated ids (whichever
      // won the create; the other resolved via the update branch).
      expect([webPageIdA, webPageIdB]).toContain(rows[0]!.id);
    } finally {
      const row = await prisma.webPage.findUnique({ where: { url }, select: { id: true } });
      if (row) await cleanupSeededWebPage(prisma, row.id);
    }
  }, 30_000);

  // ==========================================================================
  // C — release event persists once the row exists (P2003 FK closure)
  // ==========================================================================
  it("INV-INGEST-FAIL-ROW-001-C: after row exists, recordWorkerRelease persists (no P2003 FK violation)", async () => {
    const webPageId = randomUUID();
    const url = `https://example.com/inv-ingest-fail-c/${webPageId}`;
    const workerPid = 3333;
    const workerSpawnTime = new Date();
    const nonce = randomUUID(); // worker_job_lifecycle.nonce is @db.Uuid

    try {
      // 1. url-key upsert creates the terminal failed row (NOROW → row exists).
      const result = await markFailedAndAuditAtomic(prisma as unknown as FailurePathPrismaClient, {
        webPageId,
        normalizedUrl: url,
        errorMessage: "Phase 0 fetch failed: release-event case (simulated)",
        phaseN: "0",
        childPid: workerPid,
      });
      expect(result.committed).toBe(true);

      const created = await prisma.webPage.findUnique({ where: { url }, select: { id: true } });
      expect(created).not.toBeNull();
      const actualWebPageId = created!.id;

      // 2. recordWorkerRelease against the REAL DB. Pre-fix (NOROW) this FK
      //    (worker_job_lifecycle.web_page_id → web_pages.id) would P2003 because
      //    the row was absent; with the row present it persists.
      await recordWorkerRelease(prisma as unknown as WorkerJobLifecyclePrismaClient, {
        webPageId: actualWebPageId,
        workerPid,
        workerSpawnTime,
        workerType: "page",
        nonce,
      });

      // 3. The release event row persists (FK resolved → supervisor backfill
      //    can distinguish "child reached catch tail" from a true orphan).
      const releaseRows = await prisma.workerJobLifecycle.findMany({
        where: { webPageId: actualWebPageId, eventType: "release" },
        select: { id: true, eventType: true },
      });
      expect(releaseRows.length).toBeGreaterThanOrEqual(1);
    } finally {
      // worker_job_lifecycle rows cascade-delete with the web_pages row.
      const row = await prisma.webPage.findUnique({ where: { url }, select: { id: true } });
      if (row) await cleanupSeededWebPage(prisma, row.id);
    }
  }, 30_000);

  // ==========================================================================
  // mask-not assert (TDA-L-01 / CONS-6): W0 fail-open does NOT mask the
  // catch-path upsert. Even when W0 never wrote a row (fail-open), the
  // failure-path url-key upsert still persists the terminal failed row.
  // ==========================================================================
  it("INV-INGEST-FAIL-ROW-001 (mask-not): W0 fail-open does not mask the catch-path url-key upsert", async () => {
    const webPageId = randomUUID();
    const url = `https://example.com/inv-ingest-fail-masknot/${webPageId}`;

    try {
      // Model W0 fail-open: NO W0 row written (W0 upsert itself failed DB-side
      // and was swallowed as a non-fatal warn). The row is absent.
      const pre = await prisma.webPage.findUnique({ where: { url }, select: { id: true } });
      expect(pre).toBeNull();

      // The catch-path url-key upsert must still create the terminal row —
      // W0 fail-open must NOT mask it.
      const result = await markFailedAndAuditAtomic(prisma as unknown as FailurePathPrismaClient, {
        webPageId,
        normalizedUrl: url,
        errorMessage: "Phase 0 fetch failed: W0 fail-open mask-not (simulated)",
        phaseN: "0",
        childPid: 4242,
      });
      expect(result.committed).toBe(true);

      const created = await prisma.webPage.findUnique({
        where: { url },
        select: { analysisStatus: true, failedWithKnownReason: true },
      });
      expect(created).not.toBeNull();
      expect(created!.analysisStatus).toBe(TERMINAL_FAILURE_STATUS);
      expect(created!.failedWithKnownReason).toBe("worker_restart_during_inflight_phase_0");
    } finally {
      const row = await prisma.webPage.findUnique({ where: { url }, select: { id: true } });
      if (row) await cleanupSeededWebPage(prisma, row.id);
    }
  }, 30_000);
});
