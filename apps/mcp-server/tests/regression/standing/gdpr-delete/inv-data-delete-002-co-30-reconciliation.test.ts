// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-DATA-DELETE-002 extension
 *
 * **CO-30 closure (Item 2 PR / 2026-04-28)**: this case codifies the
 * Backfill terminal-state reconciliation gap closure landed by Item 2.
 *
 * **Scope** (v0.2 corrected per Plan v0.2 §4.3 / TPA-01 root cause re-attribution):
 *   - The aggregate `embedding_backfill_status` UPDATE owner is
 *     `embedding-backfill-worker.ts:661` (per-job execution path), NOT the page
 *     worker's `safeUpdateBackfillStatus`. The previous v0.1 attribution was
 *     wrong; `safeUpdateBackfillStatus` has zero hits in the codebase and is
 *     not on the aggregate UPDATE path.
 *   - 4 mechanisms can cause the per-job UPDATE to be late or dropped:
 *       (1) DB connection error in `updateEmbeddingBackfillStatus` catch block
 *       (2) BullMQ retry path exit
 *       (3) Planned worker restart drop (`maxJobsBeforeRestart=1`)
 *       (4) Last-job race during SIGTERM
 *   - `BackfillReconciliationCron` is the safety net; Item 2 cuts cron polling
 *     cadence default 1h → 5min for ~12% reduction in worst-tail lag.
 *   - This test exercises the worker-path-independent reconciliation contract:
 *     the reconciliation service must transition stale `in_progress` rows to a
 *     terminal state (`completed` or `failed`) regardless of why the per-job
 *     UPDATE never landed.
 *
 * **Why under gdpr-delete domain (INV-DATA-DELETE-002)**:
 *   - Stale `embedding_backfill_status='in_progress'` rows fall under GDPR
 *     Art.5(1)(d) accuracy invariant. Recovery to a terminal state ensures
 *     `audit_logs` retention, `data.delete` semantics, and Plan v1.1 §11.9-4
 *     24h SLO all stay coherent. The standing-regression case here pins the
 *     reconciliation contract whose failure would put rows past the 24h
 *     accuracy invariant deadline.
 *
 * **CAS guard (concurrent updates)**:
 *   - `prisma.webPage.updateMany({ where: { embeddingBackfillStatus: 'in_progress' } })`
 *     in `reconcileInProgressRows` ensures the embedding-backfill worker's late
 *     UPDATE wins if it races between the SELECT and the UPDATE; the
 *     reconciliation result reports `concurrentUpdatesSkipped` instead of
 *     racing the worker.
 *
 * @see Plan v0.2 §4.3 Step 3 (this test scenario)
 * @see Plan v0.2 §3.4 (Recommended Option A rationale)
 * @see PR-E-1 finding registry §1.3 CO-30 (closed by Item 2)
 * @see Item 2 finding registry §1.3.1 (CO-30 closure mechanism)
 * @see DATA_RETENTION.md §11.9 + §11.9.6.bis (cadence ↔ staleThresholdMs orthogonality)
 * @see ADR-0008 (Skip Recovery / 7d TTL)
 * @see ADR-0011 (Worker Dual-run Lock)
 * @module tests/regression/standing/gdpr-delete/inv-data-delete-002-co-30-reconciliation
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { assertInvName } from "../_setup/inv-assert";
import {
  reconcileStaleBackfillJobs,
  type BackfillReconciliationResult,
} from "../../../../src/services/backfill-reconciliation.service";
import {
  buildBackfillJobId,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "../../../../src/queues/embedding-backfill-queue";

type MockedQueue = Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;

interface FakePageRow {
  id: string;
  url: string;
  embeddingBackfillStartedAt: Date | null;
}

/**
 * Per-category pending counts inspected by the SSOT helper
 * (`computeRemainingStatusWithPrisma`). Default = 0 (fully complete = no
 * residual backfill-eligible rows).
 *
 * SSOT helper が参照する 7 カテゴリの pending 件数。デフォルト 0（= 完了状態）。
 */
interface PagePendingCounts {
  partText?: number;
  partVisual?: number;
  sectionVisual?: number;
  motion?: number;
  background?: number;
  jsAnimation?: number;
  responsive?: number;
}

interface BuildPrismaMockArgs {
  pages: FakePageRow[];
  pendingByPage?: Record<string, PagePendingCounts>;
  updateManySpy?: ReturnType<typeof vi.fn>;
}

function buildPrismaMock(args: BuildPrismaMockArgs): PrismaClient {
  const updateManySpy = args.updateManySpy ?? vi.fn(async () => ({ count: 1 }));
  const findManySpy = vi.fn(
    async (queryArgs: { where?: { embeddingBackfillStatus?: unknown } }) => {
      const status = queryArgs?.where?.embeddingBackfillStatus;
      if (typeof status === "object" && status !== null && "in" in status) {
        // Section B (skipped_*); not used by these CO-30 cases.
        return [];
      }
      // Plan v3 Section C (`queued`-stuck rescue) scans `embeddingBackfillStatus
      // === "queued"`. These CO-30 cases seed only `in_progress` pages, so the
      // queued scan returns no candidates (mock fidelity: do not re-return the
      // in_progress page for the Section C query).
      if (status === "queued") {
        return [];
      }
      return args.pages;
    }
  );

  const pendingByPage = args.pendingByPage ?? {};
  const makeCountSpy = (category: keyof PagePendingCounts) =>
    vi.fn(async (queryArgs: { where?: { webPageId?: string } }) => {
      const id = queryArgs?.where?.webPageId ?? "";
      return pendingByPage[id]?.[category] ?? 0;
    });

  const queryRawUnsafe = vi.fn(async (sql: string, id: string) => {
    if (sql.includes("component_part_embeddings")) {
      return [{ count: BigInt(pendingByPage[id]?.partVisual ?? 0) }];
    }
    if (sql.includes("section_embeddings")) {
      return [{ count: BigInt(pendingByPage[id]?.sectionVisual ?? 0) }];
    }
    return [{ count: BigInt(0) }];
  });

  return {
    webPage: {
      findMany: findManySpy,
      updateMany: updateManySpy,
    },
    componentPart: { count: makeCountSpy("partText") },
    motionPattern: { count: makeCountSpy("motion") },
    backgroundDesign: { count: makeCountSpy("background") },
    jSAnimationPattern: { count: makeCountSpy("jsAnimation") },
    responsiveAnalysis: { count: makeCountSpy("responsive") },
    $queryRawUnsafe: queryRawUnsafe,
  } as unknown as PrismaClient;
}

function buildQueueMock(
  jobsByPage: Record<string, Array<{ id: string; state: string }>>
): MockedQueue {
  const getJob = vi.fn(async (jobId: string) => {
    for (const [, jobs] of Object.entries(jobsByPage)) {
      const found = jobs.find((j) => j.id === jobId);
      if (found) {
        return {
          id: found.id,
          getState: vi.fn(async () => found.state),
        } as unknown as Awaited<ReturnType<Queue["getJob"]>>;
      }
    }
    return null;
  });
  return { getJob } as unknown as MockedQueue;
}

/**
 * Simulate a webPage row that the embedding-backfill worker had marked
 * `in_progress` but whose per-job aggregate UPDATE was lost (1h+1min ago,
 * just past the default `staleThresholdMs=1h`).
 *
 * embedding-backfill worker が `in_progress` に遷移させたが per-job UPDATE が
 * drop した状況を再現 (default `staleThresholdMs=1h` を 1 分超過)。
 */
function makeStaleInProgressPage(id: string): FakePageRow {
  return {
    id,
    url: "https://co-30-regression.example",
    embeddingBackfillStartedAt: new Date(Date.now() - (60 * 60 * 1000 + 60 * 1000)),
  };
}

// ============================================================================
// Test
// ============================================================================

describe("INV-DATA-DELETE-002: BackfillReconciliationCron picks up orphaned in_progress rows after embedding-backfill worker per-job UPDATE drop (CO-30 closure)", () => {
  beforeEach(() => {
    // INV-DATA-DELETE-002
    assertInvName(expect.getState().currentTestName ?? "", "INV-DATA-DELETE-002");
    vi.clearAllMocks();
  });

  it("INV-DATA-DELETE-002: should reconcile in_progress to completed via cron when embedding-backfill worker per-job UPDATE drops and DB shows full 7-category completion", async () => {
    // INV-DATA-DELETE-002
    // Arrange: 1 web_pages row with embeddingBackfillStatus='in_progress',
    //          embeddingBackfillStartedAt = now() - 1h - 1min (just past staleThresholdMs).
    //          → simulates embedding-backfill-worker.ts:661 per-job UPDATE
    //            late-arrive / drop (DB connection error / BullMQ retry exit /
    //            planned restart drop / last-job SIGTERM race).
    // Arrange: all 7 categories show 0 pending (DB row UPDATE was the only
    //          missing piece; embeddings themselves all populated).
    // Arrange: BullMQ has no active/waiting/delayed job for the webPageId.
    const page = makeStaleInProgressPage("019dd610-aaaa-7000-aaaa-000000000001");
    const updateManySpy = vi.fn(async () => ({ count: 1 }));
    const prisma = buildPrismaMock({ pages: [page], updateManySpy });
    const queue = buildQueueMock({}); // No active queue jobs

    // Act: invoke `reconcileStaleBackfillJobs` directly (cron tick equivalent).
    const result: BackfillReconciliationResult = await reconcileStaleBackfillJobs({
      prisma,
      queue,
    });

    // Assert: reconciliation transitions in_progress → completed via CAS UPDATE.
    expect(result.totalChecked).toBe(1);
    expect(result.staleDetected).toBe(1);
    expect(result.remediated).toBe(1);
    expect(result.concurrentUpdatesSkipped).toBe(0);
    expect(result.errors).toBe(0);

    // CAS UPDATE WHERE-clause locks status='in_progress' for race-safety.
    // defect B fix (INV-BACKFILL-RECONCILE-METADATA-010): the completed path now
    // also clears any stale failure metadata (failure_reason / failed_at → null)
    // so a row that became completed after a prior partial failure does not retain
    // stale failure metadata.
    expect(updateManySpy).toHaveBeenCalledWith({
      where: { id: page.id, embeddingBackfillStatus: "in_progress" },
      data: {
        embeddingBackfillStatus: "completed",
        embeddingBackfillFailureReason: null,
        embeddingBackfillFailedAt: null,
      },
    });
  });

  it("INV-DATA-DELETE-002: should NOT race with concurrent embedding-backfill worker late UPDATE (CAS guard pinning to in_progress)", async () => {
    // INV-DATA-DELETE-002
    // Arrange: same stale row scenario; CAS guard simulates worker's concurrent
    //          UPDATE landing between cron's SELECT and UPDATE
    //          (e.g. retry attempt fires UPDATE concurrently). The CAS WHERE
    //          clause `embeddingBackfillStatus='in_progress'` returns count=0,
    //          and the cron defers to the worker's later value.
    const page = makeStaleInProgressPage("019dd610-bbbb-7000-bbbb-000000000002");
    const updateManySpy = vi.fn(async () => ({ count: 0 })); // CAS miss (worker already transitioned)
    const prisma = buildPrismaMock({ pages: [page], updateManySpy });
    const queue = buildQueueMock({});

    // Act
    const result: BackfillReconciliationResult = await reconcileStaleBackfillJobs({
      prisma,
      queue,
    });

    // Assert: CAS miss is reported as concurrentUpdatesSkipped — NOT remediated.
    expect(result.totalChecked).toBe(1);
    expect(result.staleDetected).toBe(1);
    expect(result.remediated).toBe(0);
    expect(result.concurrentUpdatesSkipped).toBe(1);
    expect(result.errors).toBe(0);

    // CAS UPDATE was attempted but no row matched (worker won the race).
    // defect B fix: completed path clears stale failure metadata (see case 1).
    expect(updateManySpy).toHaveBeenCalledWith({
      where: { id: page.id, embeddingBackfillStatus: "in_progress" },
      data: {
        embeddingBackfillStatus: "completed",
        embeddingBackfillFailureReason: null,
        embeddingBackfillFailedAt: null,
      },
    });
  });

  it("INV-DATA-DELETE-002: should pin in_progress to failed_with_known_reason (+ failure metadata) via cron when DB still shows residual gaps in any of 7 categories (worker drop after partial completion)", async () => {
    // INV-DATA-DELETE-002
    // Arrange: stale in_progress row whose embeddings are still incomplete
    //          (e.g. motion category has 5 pending) — worker dropped the per-job
    //          UPDATE while the row was genuinely incomplete.
    //
    // defect B fix (INV-BACKFILL-RECONCILE-METADATA-010): the cron MUST pin the
    // row to `failed_with_known_reason` + `failure_reason='supervisor_restart_orphan'`
    // + `failed_at` (NOT plain `failed`). The previous plain-`failed` transition
    // left failure metadata NULL (observability gap) AND kept the row OUTSIDE the
    // recovery service's scan window (`fetchFailedWithKnownReasonRows` scans
    // `failed_with_known_reason` only) — so the row could never auto-recover even
    // after the residual category (e.g. motion) was backfilled. The
    // `failed_with_known_reason` transition routes the row into the auto-recovery
    // path (re_enqueue → all 7 categories → terminal `completed` once complete).
    const page = makeStaleInProgressPage("019dd610-cccc-7000-cccc-000000000003");
    const updateManySpy = vi.fn(async () => ({ count: 1 }));
    const prisma = buildPrismaMock({
      pages: [page],
      pendingByPage: { [page.id]: { motion: 5 } },
      updateManySpy,
    });
    const queue = buildQueueMock({});

    // Act
    const result: BackfillReconciliationResult = await reconcileStaleBackfillJobs({
      prisma,
      queue,
    });

    // Assert: pinned to failed_with_known_reason + failure metadata (recovery-eligible).
    expect(result.totalChecked).toBe(1);
    expect(result.staleDetected).toBe(1);
    expect(result.remediated).toBe(1);
    expect(updateManySpy).toHaveBeenCalledWith({
      where: { id: page.id, embeddingBackfillStatus: "in_progress" },
      data: {
        embeddingBackfillStatus: "failed_with_known_reason",
        embeddingBackfillFailureReason: "supervisor_restart_orphan",
        embeddingBackfillFailedAt: expect.any(Date),
      },
    });
  });

  it("INV-DATA-DELETE-002: should defer reconciliation when BullMQ still has active job (worker not yet given up on per-job UPDATE)", async () => {
    // INV-DATA-DELETE-002
    // Arrange: stale row whose BullMQ job is still 'active' — the
    //          embedding-backfill worker has not yet attempted the per-job
    //          UPDATE; cron must NOT preempt the worker.
    const page = makeStaleInProgressPage("019dd610-dddd-7000-dddd-000000000004");
    const updateManySpy = vi.fn(async () => ({ count: 1 }));
    const prisma = buildPrismaMock({ pages: [page], updateManySpy });
    const queue = buildQueueMock({
      [page.id]: [{ id: buildBackfillJobId(page.id, "part_text"), state: "active" }],
    });

    // Act
    const result: BackfillReconciliationResult = await reconcileStaleBackfillJobs({
      prisma,
      queue,
    });

    // Assert: cron defers to worker — no UPDATE attempted, no staleDetected.
    expect(result.totalChecked).toBe(1);
    expect(result.staleDetected).toBe(0);
    expect(result.remediated).toBe(0);
    expect(updateManySpy).not.toHaveBeenCalled();
  });
});
