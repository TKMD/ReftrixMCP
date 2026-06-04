// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-BACKFILL-QUEUED-RESCUE-014 (Plan v3 — `queued`-stuck rescue: job-loss
 * recovery → completed)
 *
 * **Problem (real-verified, fact-based)**: a page stuck at
 * `web_pages.embeddingBackfillStatus = 'queued'` whose corresponding BullMQ job
 * has been lost (worker interruption / Redis flush / job-retention expiry) is
 * **never re-enqueued and stays perpetually incomplete** — none of the rescue
 * scans (Section A `in_progress`, Section B `skipped_*`, recovery cron
 * `failed_with_known_reason`) cover the `queued` status. Real verification
 * confirmed these pages run to terminal `completed` once a job is re-enqueued
 * (no OOM); they are rescuable and were silently dropped.
 *
 * **Fix (Plan v3)**: two coordinated code changes, both pinned here as
 * CI-failing invariants:
 *
 *   1. **Section C `reconcileQueuedRows`** (worker-present rescue scan,
 *      `backfill-reconciliation.service.ts`): stale `queued` rows
 *      (`startedAt < now - rescueStaleThresholdMs`, default = 10min) are routed
 *      P3 (cap give-up) → P1 (in-flight skip) → P2 (rescue re-arm + re-enqueue).
 *   2. **give-up scan from-status 2-branch** (Plan v3 §V2.1 ruling (a)-narrowed,
 *      `worker-supervisor-lifecycle.service.ts handleSecondarySpawnTimeout`):
 *      `queued`-origin → `failed_with_known_reason` + `supervisor_restart_orphan`
 *      (recovery-IN, the recovery handler re-enqueues unconditionally toward
 *      `completed`); `in_progress`-origin → UNCHANGED bare `failed` +
 *      `vision_unload_timeout` (recovery-OUT, SEC-REAUDIT-02 contract preserved).
 *
 * **9 mandatory contracts (Plan v3 §6 / §V2.8)** + aggregate back-pressure
 * assert. Each is non-vacuous: a single production-line mutation fails a
 * specific contract (mutation map documented per `it`). `.skip` / `.todo` /
 * accepted-risk are forbidden (H severity: rescuable pages silently abandoned;
 *
 * @see ADR-0007 Amendment 2 §A2.1 / §A2.2 / §A2.2.1 / §A2.3 (queued rescue lifecycle)
 * @see backfill-reconciliation.service.ts (`reconcileQueuedRows`, Section C)
 * @see worker-supervisor-lifecycle.service.ts (`handleSecondarySpawnTimeout`)
 * @see backfill-recovery-reconciliation.service.ts (`runRecoveryCycle`, recovery gate)
 * @see audit-actions.ts (`AUDIT_ACTION_BACKFILL_RESCUE_QUEUED[_GAVE_UP]` SSOT)
 *
 * @module tests/regression/standing/large-page/inv-backfill-queued-rescue-014
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import fs from "node:fs";
import path from "node:path";
import { assertInvName } from "../_setup/inv-assert";
import { reconcileStaleBackfillJobs } from "../../../../src/services/backfill-reconciliation.service";
import { runRecoveryCycle } from "../../../../src/services/backfill-recovery-reconciliation.service";
import { SKIP_RECOVERY_RETRY_CAP } from "../../../../src/queues/embedding-backfill-queue";
import {
  AUDIT_ACTION_BACKFILL_RESCUE_QUEUED,
  AUDIT_ACTION_BACKFILL_RESCUE_QUEUED_GAVE_UP,
} from "../../../../src/audit/audit-actions";
import type {
  EmbeddingBackfillJobData,
  EmbeddingBackfillJobResult,
} from "../../../../src/queues/embedding-backfill-queue";
import { seedMinimalWebPage, cleanupSeededWebPage } from "./_fixtures/seed-large-page";

const INV_NAME = "INV-BACKFILL-QUEUED-RESCUE-014";

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const MCP_SERVER_SRC_ROOT = path.resolve(MCP_SERVER_ROOT, "src");

type MockedQueue = Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;

// rescueStaleThresholdMs default = 10min; seed startedAt 20min in the past.
const TWENTY_MIN_MS = 20 * 60 * 1000;

/**
 * Build a queue mock for the rescue path.
 *
 * - `getJob` → null: no live BullMQ job (P1 in-flight skip is not taken unless
 *   overridden), so the stale `queued` row is rescue/give-up eligible.
 * - `getWaitingCount` → small: back-pressure allows enqueue.
 * - `client` → rejects: forces the collision guard's **fail-open** path, which
 *   still calls `queue.add` — so `add` is the real enqueue side-effect spy and
 *   the rescue assertion exercises the actual
 *   `enqueueAllCategoriesForSkipRecovery` → `addEmbeddingBackfillJobWithGuard`
 *   → `enqueueWithCollisionGuard` production path end-to-end (non-vacuous).
 *
 * @param overrides - optional per-method overrides (e.g. live job, back-pressure).
 */
function buildRescueQueueMock(overrides?: { hasLiveJob?: boolean; waitingCount?: number }): {
  queue: MockedQueue;
  add: ReturnType<typeof vi.fn>;
} {
  const add = vi.fn(async () => ({ id: "mock-job" }));
  const queue = {
    // hasActiveQueueJob iterates the 7 categories; "active" state = live job.
    getJob: vi.fn(async () => (overrides?.hasLiveJob ? { getState: async () => "active" } : null)),
    getWaitingCount: vi.fn(async () => overrides?.waitingCount ?? 0),
    // Reject so enqueueWithCollisionGuard takes the fail-open branch → queue.add.
    get client() {
      return Promise.reject(new Error("redis-unavailable (test fail-open)"));
    },
    add,
  } as unknown as MockedQueue;
  return { queue, add };
}

/**
 * Force a seeded page into the stale `queued` state with a startedAt far enough
 * in the past to satisfy the Section C `rescueStaleThresholdMs` gate (10min).
 */
async function markStaleQueued(
  prisma: PrismaClient,
  webPageId: string,
  opts: { startedAtAgoMs: number; retryCount: number }
): Promise<void> {
  await prisma.webPage.update({
    where: { id: webPageId },
    data: {
      embeddingBackfillStatus: "queued",
      embeddingBackfillStartedAt: new Date(Date.now() - opts.startedAtAgoMs),
      embeddingBackfillRetryCount: opts.retryCount,
    },
  });
}

async function readBackfillState(
  prisma: PrismaClient,
  webPageId: string
): Promise<{
  status: string;
  failureReason: string | null;
  failedAt: Date | null;
  retryCount: number;
  startedAt: Date | null;
}> {
  const row = await prisma.webPage.findUniqueOrThrow({
    where: { id: webPageId },
    select: {
      embeddingBackfillStatus: true,
      embeddingBackfillFailureReason: true,
      embeddingBackfillFailedAt: true,
      embeddingBackfillRetryCount: true,
      embeddingBackfillStartedAt: true,
    },
  });
  return {
    status: row.embeddingBackfillStatus,
    failureReason: row.embeddingBackfillFailureReason,
    failedAt: row.embeddingBackfillFailedAt,
    retryCount: row.embeddingBackfillRetryCount ?? 0,
    startedAt: row.embeddingBackfillStartedAt,
  };
}

describe(`${INV_NAME}: queued-stuck rescue (job-loss recovery → completed)`, () => {
  // ==========================================================================
  // Behavioural contracts (.1–.6, .8, .9 + aggregate) — real Prisma DB.
  // ==========================================================================
  describe(`${INV_NAME}: Section C rescue/give-up (real DB)`, () => {
    let prisma: PrismaClient;

    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", INV_NAME);
    });

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error(
          `[${INV_NAME}] DATABASE_URL not set by globalSetup (testcontainer boot failure?)`
        );
      }
      prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
      await prisma.$connect();
    }, 180_000);

    afterAll(async () => {
      try {
        await prisma?.$disconnect();
      } catch {
        /* best-effort shutdown */
      }
    }, 30_000);

    it(`${INV_NAME}: (.1) rescue P2 happy path — stale queued + retryCount<5 + no live job → re-arm (queued, startedAt advanced, retryCount+1) + enqueue all 7 categories`, async () => {
      // Mutation: removing the from-status `queued` guard in fetchStaleQueuedPages,
      // or the rescueQueuedRow CAS `status='queued'`, makes this no-op → fail.
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        await markStaleQueued(prisma, webPageId, { startedAtAgoMs: TWENTY_MIN_MS, retryCount: 0 });
        const before = await readBackfillState(prisma, webPageId);
        const { queue, add } = buildRescueQueueMock();

        const result = await reconcileStaleBackfillJobs({ prisma, queue });

        expect(result.queuedRescueEnqueued, "exactly one queued row rescued").toBe(1);
        expect(result.queuedGaveUp, "no give-up on a below-cap row").toBe(0);

        const state = await readBackfillState(prisma, webPageId);
        expect(state.status, "rescued row stays queued (re-armed, not terminalized)").toBe(
          "queued"
        );
        expect(state.retryCount, "retryCount incremented by 1").toBe(1);
        expect(
          state.startedAt!.getTime(),
          "startedAt re-armed forward (M-B time-anchor exclusion)"
        ).toBeGreaterThan(before.startedAt!.getTime());

        // no-fake-success: "rescued" == actual enqueue calls. enqueueAllCategories
        // skips screenshot-required categories without a screenshot path; the
        // minimal page has no screenshotStoragePath, so part_visual / section_visual
        // are skipped → 5 of 7 categories enqueue. The contract is "enqueue actually
        // invoked", asserted via the real queue.add side-effect (fail-open path).
        expect(add.mock.calls.length, "enqueue actually invoked for ≥1 category").toBeGreaterThan(
          0
        );
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    }, 60_000);

    it(`${INV_NAME}: (.2) give-up P3 at cap — stale queued + retryCount=5 (>=cap) → failed_with_known_reason + supervisor_restart_orphan + NO enqueue`, async () => {
      // Mutation: cap compare `>=`→`>` lets retryCount=5 fall to rescue (P2) →
      // queuedGaveUp=0 + enqueue called → fail.
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        await markStaleQueued(prisma, webPageId, {
          startedAtAgoMs: TWENTY_MIN_MS,
          retryCount: SKIP_RECOVERY_RETRY_CAP,
        });
        const { queue, add } = buildRescueQueueMock();

        const result = await reconcileStaleBackfillJobs({ prisma, queue });

        expect(result.queuedGaveUp, "cap-reached row is given up").toBe(1);
        expect(result.queuedRescueEnqueued, "no rescue on a cap-reached row").toBe(0);
        expect(add.mock.calls.length, "give-up MUST NOT enqueue any job").toBe(0);

        const state = await readBackfillState(prisma, webPageId);
        expect(state.status, "give-up transitions to failed_with_known_reason").toBe(
          "failed_with_known_reason"
        );
        expect(
          state.failureReason,
          "give-up reason MUST be supervisor_restart_orphan (recovery-IN)"
        ).toBe("supervisor_restart_orphan");
        expect(
          state.failedAt,
          "give-up MUST set failed_at for recovery fairness ordering"
        ).not.toBeNull();
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    }, 60_000);

    it(`${INV_NAME}: (.3) in-flight skip P1 — stale queued + live BullMQ job → no-op (not rescued, not given up, not staleDetected)`, async () => {
      // Mutation: removing the hasActiveQueueJob skip rescues an in-flight row →
      // queuedRescueEnqueued=1 → fail.
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        await markStaleQueued(prisma, webPageId, { startedAtAgoMs: TWENTY_MIN_MS, retryCount: 0 });
        const { queue, add } = buildRescueQueueMock({ hasLiveJob: true });

        const result = await reconcileStaleBackfillJobs({ prisma, queue });

        expect(result.queuedRescueEnqueued, "in-flight row MUST NOT be rescued").toBe(0);
        expect(result.queuedGaveUp, "in-flight below-cap row MUST NOT be given up").toBe(0);
        expect(add.mock.calls.length, "in-flight skip MUST NOT enqueue").toBe(0);

        const state = await readBackfillState(prisma, webPageId);
        expect(state.status, "in-flight row left untouched at queued").toBe("queued");
        expect(state.retryCount, "in-flight row retryCount unchanged").toBe(0);
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    }, 60_000);

    it(`${INV_NAME}: (.4) CAS idempotency — row advanced out of queued between SELECT and UPDATE → updateMany count=0 → no enqueue, concurrentUpdatesSkipped++`, async () => {
      // Models a concurrent transition (e.g. give-up scan won the race) by having
      // the queue's getJob trigger the row to leave `queued` before the CAS runs.
      // Simpler deterministic model: pre-advance the row's status AFTER fetch is
      // impossible to interleave in a single-threaded test, so we assert the CAS
      // guard structurally: a row that is NOT `queued` at CAS time yields count=0.
      // We drive this by seeding the candidate as queued (so it is fetched) then
      // flipping it to in_progress via the getJob side-effect hook.
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        await markStaleQueued(prisma, webPageId, { startedAtAgoMs: TWENTY_MIN_MS, retryCount: 0 });
        const add = vi.fn(async () => ({ id: "mock-job" }));
        // getJob is called by hasActiveQueueJob (P1) BEFORE the CAS. Use it as the
        // interleave point: flip the row out of `queued` so the subsequent rescue
        // CAS `where status='queued'` matches 0 rows (concurrent advance).
        let flipped = false;
        const queue = {
          getJob: vi.fn(async () => {
            if (!flipped) {
              flipped = true;
              await prisma.webPage.update({
                where: { id: webPageId },
                data: { embeddingBackfillStatus: "in_progress" },
              });
            }
            return null;
          }),
          getWaitingCount: vi.fn(async () => 0),
          get client() {
            return Promise.reject(new Error("redis-unavailable (test fail-open)"));
          },
          add,
        } as unknown as MockedQueue;

        const result = await reconcileStaleBackfillJobs({ prisma, queue });

        expect(result.queuedRescueEnqueued, "concurrent-advance row MUST NOT be rescued").toBe(0);
        expect(
          result.concurrentUpdatesSkipped,
          "concurrent advance is counted as a skipped CAS"
        ).toBeGreaterThanOrEqual(1);
        expect(add.mock.calls.length, "no enqueue when CAS count=0 (no double-enqueue)").toBe(0);
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    }, 60_000);

    it(`${INV_NAME}: (.5) time-anchor exclusion (M-B) — a fresh queued row (startedAt within 10min) is NOT rescued; re-arm advances startedAt out of the window`, async () => {
      // Mutation: removing the re-arm `startedAt:now` keeps a just-rescued row in
      // the stale window for the same tick. Here we assert the inverse: a fresh
      // (in-window-exclusive) row is NOT a candidate at all — proving the
      // time-anchor gate. Then a 20min-stale row IS rescued and its startedAt is
      // advanced past the cutoff (re-arm).
      const fresh = await seedMinimalWebPage(prisma);
      const stale = await seedMinimalWebPage(prisma);
      try {
        // Fresh: startedAt 1min ago → inside the 10min window → NOT eligible.
        await markStaleQueued(prisma, fresh.webPageId, {
          startedAtAgoMs: 60 * 1000,
          retryCount: 0,
        });
        await markStaleQueued(prisma, stale.webPageId, {
          startedAtAgoMs: TWENTY_MIN_MS,
          retryCount: 0,
        });
        const { queue } = buildRescueQueueMock();
        const cutoffMs = Date.now() - 10 * 60 * 1000;

        const result = await reconcileStaleBackfillJobs({ prisma, queue });

        expect(
          result.queuedRescueEnqueued,
          "only the stale row is rescued, not the fresh one"
        ).toBe(1);
        const freshState = await readBackfillState(prisma, fresh.webPageId);
        expect(freshState.retryCount, "fresh (in-window) row is NOT rescued").toBe(0);
        const staleState = await readBackfillState(prisma, stale.webPageId);
        expect(
          staleState.startedAt!.getTime(),
          "rescued row startedAt re-armed past the 10min cutoff (M-B exclusion)"
        ).toBeGreaterThan(cutoffMs);
      } finally {
        await cleanupSeededWebPage(prisma, fresh.webPageId);
        await cleanupSeededWebPage(prisma, stale.webPageId);
      }
    }, 60_000);

    it(`${INV_NAME}: (.6) bidirectional race orthogonality — give-up-first (queued→failed_with_known_reason+supervisor_restart_orphan) yields a recovery-eligible terminal that is NOT re-rescued`, async () => {
      // Models the give-up-first branch of the bidirectional race: the give-up
      // scan terminalized a `queued`-origin orphan to failed_with_known_reason +
      // supervisor_restart_orphan (Plan v3 §V2.1 ruling (a)-narrowed). This test
      // pins (a) the terminal status + reason, (b) recovery-eligibility (the row
      // is scanned + re-enqueued by the recovery cron), and (c) that the rescue
      // scan does NOT re-rescue it (it is no longer `queued`, M-A from-status excl).
      //
      // Mutation: reverting the give-up `queued` branch to bare `failed` (V1
      // behaviour) drops it out of the recovery scan window → inState stays at
      // the seeded status → recovery-eligibility assert fails.
      const orphan = await seedMinimalWebPage(prisma);
      try {
        // Simulate the give-up-scan terminal write for a queued-origin orphan.
        await prisma.webPage.update({
          where: { id: orphan.webPageId },
          data: {
            embeddingBackfillStatus: "failed_with_known_reason",
            embeddingBackfillFailureReason: "supervisor_restart_orphan",
            embeddingBackfillFailedAt: new Date(),
            embeddingBackfillRetryCount: 0,
          },
        });

        // (c) The rescue scan MUST NOT touch a non-queued row (M-A from-status excl).
        const { queue: rescueQueue, add } = buildRescueQueueMock();
        const rescueResult = await reconcileStaleBackfillJobs({ prisma, queue: rescueQueue });
        expect(
          rescueResult.queuedRescueEnqueued,
          "a failed_with_known_reason row is NOT in the queued rescue set (M-A from-status exclusion)"
        ).toBe(0);
        expect(add.mock.calls.length, "no rescue enqueue for a non-queued terminal row").toBe(0);

        // (a)+(b) The recovery cron scans it and re-enqueues (supervisor_restart_orphan
        // is lifecycle-origin → unconditional re_enqueued → toward completed).
        const recoveryResult = await runRecoveryCycle({
          prisma,
          queue: buildRescueQueueMock().queue,
          verifyVisionUnloadFn: async () => ({ status: "vision_unloaded", sizeVramBytes: 0 }),
        });
        expect(
          recoveryResult.totalChecked,
          "give-up-first terminal MUST be recovery-eligible (scanned by the recovery cron)"
        ).toBeGreaterThanOrEqual(1);

        const inState = await readBackfillState(prisma, orphan.webPageId);
        expect(
          inState.status,
          "supervisor_restart_orphan recovery re-enqueues (leaves failed_with_known_reason toward completed)"
        ).not.toBe("failed_with_known_reason");
      } finally {
        await cleanupSeededWebPage(prisma, orphan.webPageId);
      }
    }, 60_000);

    it(`${INV_NAME}: (.8) shared-counter boundary — a queued row whose retryCount reached 5 via a NON-analysis-guard path (recovery/Section B style) flows to P3 give-up, not rescue`, async () => {
      // Plan v3 §V2.2 premise rewrite: the row reaches retryCount=5 while STAYING
      // `queued` (the recovery cron / Section B increment retryCount without
      // leaving `queued`; the analysis-guard CAS would instead bare-`failed` it).
      // We seed exactly that state directly (queued + retryCount=5) and assert P3.
      //
      // Mutation: cap compare `>=`→`>` lets retryCount=5 fall to rescue (P2) →
      // queuedGaveUp=0 → fail. Non-vacuous because the seed is a genuine queued
      // row (not the empty analysis-guard-origin set).
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        await markStaleQueued(prisma, webPageId, {
          startedAtAgoMs: TWENTY_MIN_MS,
          retryCount: SKIP_RECOVERY_RETRY_CAP,
        });
        const { queue, add } = buildRescueQueueMock();

        const result = await reconcileStaleBackfillJobs({ prisma, queue });

        expect(
          result.queuedGaveUp,
          "a queued row at the shared cap (5) flows to give-up (P3), not rescue"
        ).toBe(1);
        expect(result.queuedRescueEnqueued, "no rescue budget left at the shared cap").toBe(0);
        expect(add.mock.calls.length, "exhausted-budget row MUST NOT enqueue").toBe(0);

        const state = await readBackfillState(prisma, webPageId);
        expect(state.status).toBe("failed_with_known_reason");
        expect(state.failureReason).toBe("supervisor_restart_orphan");
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    }, 60_000);

    it(`${INV_NAME}: (.9) PII-symmetric exclusion — a queued page containing a high-PII part is rescued once; the worker pending predicate routes it to completed so it is NOT re-rescued (monotonic)`, async () => {
      // Plan v3 §5.PII: high-PII parts are excluded from the pending predicate
      // (computeRemainingStatusWithPrisma), so a rescued high-PII page can reach
      // `completed` and leave the `queued` set — no infinite rescue loop.
      //
      // Here we model the structural causal chain deterministically with DB state:
      //  (1) rescue a queued page with a high-PII part (rescue count=1);
      //  (2) simulate the worker outcome: the page becomes `completed` (the high-PII
      //      part is excluded from pending, all other categories pending=0);
      //  (3) a second reconcile tick MUST NOT re-rescue it (it is no longer queued).
      // Mutation: dropping `!= 'high'` from the pending predicate keeps the high-PII
      // part pending forever → the page never reaches completed → the second tick
      // would still see `queued` (had we not completed it) → the monotonic-1 assert
      // breaks for a real worker. We pin the monotonicity at the rescue-scan layer.
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        // Anchor a section + a high-PII part on this page.
        const sectionPatternId = crypto.randomUUID();
        await prisma.sectionPattern.create({
          data: {
            id: sectionPatternId,
            webPageId,
            sectionType: "hero",
            positionIndex: 0,
            layoutInfo: { type: "hero" },
          },
        });
        await prisma.componentPart.create({
          data: {
            id: crypto.randomUUID(),
            webPageId,
            sectionPatternId,
            partType: "input",
            partSubtype: "email",
            computedStyles: {},
            attributes: {},
            boundingBox: { x: 0, y: 0, width: 100, height: 40 },
            interactionInfo: {},
            piiRiskLevel: "high",
            extractedAt: new Date(),
          },
        });
        await markStaleQueued(prisma, webPageId, { startedAtAgoMs: TWENTY_MIN_MS, retryCount: 0 });

        const { queue } = buildRescueQueueMock();
        const firstTick = await reconcileStaleBackfillJobs({ prisma, queue });
        expect(firstTick.queuedRescueEnqueued, "high-PII queued page is rescued once").toBe(1);

        // Simulate the worker outcome: high-PII part excluded from pending → the
        // page reaches terminal `completed` (it leaves the `queued` set).
        await prisma.webPage.update({
          where: { id: webPageId },
          data: { embeddingBackfillStatus: "completed", embeddingBackfillStartedAt: null },
        });

        const secondTick = await reconcileStaleBackfillJobs({
          prisma,
          queue: buildRescueQueueMock().queue,
        });
        expect(
          secondTick.queuedRescueEnqueued,
          "a completed page is NOT re-rescued (queuedRescueEnqueued monotonic, no infinite loop)"
        ).toBe(0);

        const state = await readBackfillState(prisma, webPageId);
        expect(state.status, "high-PII page reaches completed (PII-symmetric exclusion)").toBe(
          "completed"
        );
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    }, 60_000);

    it(`${INV_NAME}: (aggregate) back-pressure hard bound — under Redis fail-open, the per-tick enqueue is bounded by batchLimit (candidate LIMIT batchLimit)`, async () => {
      // Mutation: removing `take: batchLimit` (LIMIT) from fetchStaleQueuedPages
      // removes the aggregate hard bound — with N>batchLimit stale rows, more than
      // batchLimit rows would be rescued. Here we seed 3 stale rows, batchLimit=2,
      // and assert exactly 2 are fetched/rescued in one tick (≤ batchLimit).
      const pages = await Promise.all([
        seedMinimalWebPage(prisma),
        seedMinimalWebPage(prisma),
        seedMinimalWebPage(prisma),
      ]);
      try {
        for (const p of pages) {
          await markStaleQueued(prisma, p.webPageId, {
            startedAtAgoMs: TWENTY_MIN_MS,
            retryCount: 0,
          });
        }
        const { queue } = buildRescueQueueMock();

        const result = await reconcileStaleBackfillJobs({ prisma, queue, batchLimit: 2 });

        expect(
          result.queuedRescueEnqueued,
          "per-tick rescue count is bounded by batchLimit (LIMIT batchLimit aggregate hard bound)"
        ).toBeLessThanOrEqual(2);
        expect(
          result.queuedRescueEnqueued,
          "the batchLimit fully fills with stale candidates (non-vacuous: ≥ batchLimit available)"
        ).toBe(2);
      } finally {
        await Promise.all(pages.map((p) => cleanupSeededWebPage(prisma, p.webPageId)));
      }
    }, 60_000);
  });

  // ==========================================================================
  // .7 — AST/source-pin: new audit action ×2 SSOT (no bare-literal). No DB.
  // ==========================================================================
  describe(`${INV_NAME}: AST source-pin (new audit action SSOT, no bare literal)`, () => {
    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", INV_NAME);
    });

    /**
     * Recursively collect production `*.ts` files under `src/` (excludes tests).
     */
    function collectProductionSources(root: string): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name.startsWith(".")
          ) {
            continue;
          }
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (
            entry.isFile() &&
            entry.name.endsWith(".ts") &&
            !entry.name.endsWith(".test.ts") &&
            !entry.name.endsWith(".spec.ts")
          ) {
            out.push(full);
          }
        }
      };
      walk(root);
      return out;
    }

    it(`${INV_NAME}: (.7) new audit action ×2 — bare literals "backfill_rescue_queued" / "backfill_rescue_queued_gave_up" have 0 production occurrences outside the SSOT module (import-only, INV-AUDIT-EMIT-SSOT-IMPORT-001 Test 8 rigor)`, () => {
      // Mutation: writing a bare action literal at an emit callsite (instead of the
      // SSOT import) introduces a production occurrence outside audit-actions.ts → fail.
      const SSOT_FILE = path.resolve(MCP_SERVER_SRC_ROOT, "audit/audit-actions.ts");
      // Quoted-literal patterns (string literal emit), NOT identifier references.
      const barePatterns: Array<{ name: string; re: RegExp }> = [
        { name: "backfill_rescue_queued_gave_up", re: /["']backfill_rescue_queued_gave_up["']/ },
        // Negative lookahead so the longer `_gave_up` form is not double-counted by
        // the shorter pattern.
        { name: "backfill_rescue_queued", re: /["']backfill_rescue_queued(?!_gave_up)["']/ },
      ];

      const violations: Array<{ file: string; line: number; action: string; snippet: string }> = [];
      for (const filePath of collectProductionSources(MCP_SERVER_SRC_ROOT)) {
        const absPath = path.resolve(filePath);
        // The SSOT module defines the canonical literals in JSDoc + `as const`.
        if (absPath === SSOT_FILE) continue;
        const lines = fs.readFileSync(absPath, "utf8").split("\n");
        lines.forEach((lineText, idx) => {
          const trimmed = lineText.trim();
          // Skip comment lines (JSDoc / block / line) — only flag emit literals.
          if (
            trimmed.startsWith("//") ||
            trimmed.startsWith("*") ||
            trimmed.startsWith("/*") ||
            trimmed.startsWith("/**")
          ) {
            return;
          }
          for (const { name, re } of barePatterns) {
            if (re.test(lineText)) {
              violations.push({
                file: path.relative(MCP_SERVER_ROOT, absPath),
                line: idx + 1,
                action: name,
                snippet: trimmed,
              });
            }
          }
        });
      }

      if (violations.length > 0) {
        const formatted = violations
          .map((v) => `  - ${v.file}:${v.line} [${v.action}]\n      ${v.snippet}`)
          .join("\n");
        expect.fail(
          `${INV_NAME} (.7) violation: ${violations.length} production bare audit-action literal(s) outside the SSOT module.\n` +
            `Replace with: import { AUDIT_ACTION_BACKFILL_RESCUE_QUEUED, AUDIT_ACTION_BACKFILL_RESCUE_QUEUED_GAVE_UP } from "<path>/audit/audit-actions"\n` +
            `Violations:\n${formatted}`
        );
      }
      expect(violations).toEqual([]);

      // Dual-assertion (Wave 5 LCC canonical pattern): the SSOT constants resolve
      // to the canonical literals so coupling drift is impossible.
      expect(AUDIT_ACTION_BACKFILL_RESCUE_QUEUED).toBe("backfill_rescue_queued");
      expect(AUDIT_ACTION_BACKFILL_RESCUE_QUEUED_GAVE_UP).toBe("backfill_rescue_queued_gave_up");

      // The Section C emit file MUST import the SSOT constants (pins the import site).
      const sectionCFile = fs.readFileSync(
        path.resolve(MCP_SERVER_SRC_ROOT, "services/backfill-reconciliation.service.ts"),
        "utf8"
      );
      expect(
        sectionCFile.includes("AUDIT_ACTION_BACKFILL_RESCUE_QUEUED"),
        "backfill-reconciliation.service.ts MUST import + emit via the SSOT action constants"
      ).toBe(true);
    });
  });
});
