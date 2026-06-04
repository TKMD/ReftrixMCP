// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * v0.4.0 PR7b (ADR-0008 #6 / #8 / LCC M-3): backfill-reconciliation Skip Recovery テスト
 * v0.4.0 PR7b (ADR-0008 #6 / #8 / LCC M-3): backfill-reconciliation Skip Recovery tests
 *
 * Cron `reconcileStaleBackfillJobs` の Section B（skipped_* recovery）が
 * 以下を満たすことを検証する:
 *
 *   1. skipped_fork_error / skipped_memory_pressure 行を target に取り込む
 *   2. 7 日 TTL 超過行は `failed` 固定 + audit log (`skip_recovery_expired`)
 *   3. retry cap 5 超過行は `failed` 固定 + audit log (`backfill_retry_exhausted`)
 *   4. CAS guard 失敗時は concurrentUpdatesSkipped にカウント
 *   5. memory_pressure 経路で初期 delay 付き enqueue
 *
 * Section A（in_progress recovery）の既存テストは
 * `backfill-reconciliation.service.test.ts` でカバー。
 *
 * @module tests/services/backfill-reconciliation-skip-recovery
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import {
  reconcileStaleBackfillJobs,
  type BackfillReconciliationResult,
} from "../../src/services/backfill-reconciliation.service";
import type {
  EmbeddingBackfillJobData,
  EmbeddingBackfillJobResult,
} from "../../src/queues/embedding-backfill-queue";

// audit-log.service の getAuditLogService をモック（singleton 化して assertion 可能に）
// Mock getAuditLogService as a singleton so call assertions persist across invocations
// CO-5: include truncateAuditTargetId helper + AUDIT_LOG_CONSTANTS in the mock so
// that backfill-reconciliation.service.ts can import them (added in CO-5 Phase 2).
const mockAuditLog = vi.fn(async () => undefined);
vi.mock("../../src/services/audit-log.service", () => ({
  getAuditLogService: vi.fn(() => ({ log: mockAuditLog })),
  truncateAuditTargetId: vi.fn((id: string) => (id.length <= 8 ? id : id.slice(0, 8) + "...")),
  AUDIT_LOG_CONSTANTS: {
    DEFAULT_QUERY_LIMIT: 20,
    MAX_QUERY_LIMIT: 100,
    DEFAULT_RETENTION_DAYS: 365,
    TARGET_ID_TRUNCATE_LENGTH: 8,
    WORKER_ZOMBIE_RECOVERED_ACTION: "worker_zombie_recovered",
    WORKER_ZOMBIE_RECOVERED_ACTOR_PREFIX: "operator:",
    WORKER_ZOMBIE_RECOVERY_METHODS: ["force_release_redis_lock"] as const,
  },
}));

type MockedQueue = Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;

interface SkippedRow {
  id: string;
  url: string;
  embeddingBackfillStatus: "skipped_fork_error" | "skipped_memory_pressure";
  embeddingBackfillSkippedAt: Date;
  embeddingBackfillRetryCount: number;
  screenshotStoragePath: string | null;
}

function buildPrismaMock(skippedRows: SkippedRow[]): PrismaClient {
  const updateManySpy = vi.fn(async () => ({ count: 1 }));
  // Section A は空、Section B は skippedRows
  // Section A returns empty, Section B returns skippedRows
  const findManySpy = vi.fn(async (args: { where?: { embeddingBackfillStatus?: unknown } }) => {
    const status = args?.where?.embeddingBackfillStatus;
    if (typeof status === "object" && status !== null && "in" in status) {
      return skippedRows;
    }
    return [];
  });
  const queryRawUnsafe = vi.fn(async () => [{ count: BigInt(0) }]);

  return {
    webPage: {
      findMany: findManySpy,
      updateMany: updateManySpy,
    },
    $queryRawUnsafe: queryRawUnsafe,
  } as unknown as PrismaClient;
}

function buildQueueMock(opts?: {
  waitingCount?: number;
  hasActiveJob?: boolean;
  addJob?: ReturnType<typeof vi.fn>;
}): MockedQueue {
  const getJob = vi.fn(async () => {
    if (opts?.hasActiveJob) {
      return {
        id: "stub",
        getState: vi.fn(async () => "active"),
      } as unknown as Awaited<ReturnType<Queue["getJob"]>>;
    }
    return null;
  });
  const getWaitingCount = vi.fn(async () => opts?.waitingCount ?? 0);
  const add = opts?.addJob ?? vi.fn(async () => ({ id: "added" }));
  return { getJob, getWaitingCount, add } as unknown as MockedQueue;
}

function makeSkippedRow(
  id: string,
  status: "skipped_fork_error" | "skipped_memory_pressure",
  options?: {
    skippedAgeHours?: number;
    retryCount?: number;
    screenshotStoragePath?: string | null;
  }
): SkippedRow {
  const ageHours = options?.skippedAgeHours ?? 2; // default 2h ago
  return {
    id,
    url: "https://example.com",
    embeddingBackfillStatus: status,
    embeddingBackfillSkippedAt: new Date(Date.now() - ageHours * 60 * 60 * 1000),
    embeddingBackfillRetryCount: options?.retryCount ?? 0,
    screenshotStoragePath: options?.screenshotStoragePath ?? null,
  };
}

describe("reconcileStaleBackfillJobs Section B — Skip Recovery (PR7b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes skipped_* rows in totalChecked / skipped_* 行が totalChecked に含まれる", async () => {
    const prisma = buildPrismaMock([
      makeSkippedRow("019bc111-1111-7777-8888-aaaaaaaaaaaa", "skipped_fork_error"),
      makeSkippedRow("019bc222-2222-7777-8888-bbbbbbbbbbbb", "skipped_memory_pressure"),
    ]);
    const queue = buildQueueMock();
    const result: BackfillReconciliationResult = await reconcileStaleBackfillJobs({
      prisma,
      queue,
    });
    expect(result.totalChecked).toBe(2);
    expect(result.skipRecoveryEnqueued).toBe(2);
    expect(result.remediated).toBe(2);
  });

  it("expires rows beyond 7d TTL with audit log / 7d TTL 超過行を failed 固定 + audit log", async () => {
    const oldRow = makeSkippedRow(
      "019bc333-3333-7777-8888-cccccccccccc",
      "skipped_fork_error",
      { skippedAgeHours: 8 * 24 } // 8 days ago
    );
    const prisma = buildPrismaMock([oldRow]);
    const queue = buildQueueMock();
    const result = await reconcileStaleBackfillJobs({ prisma, queue });
    expect(result.ttlExpired).toBe(1);
    expect(result.skipRecoveryEnqueued).toBe(0);

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "skip_recovery_expired" })
    );
  });

  it("pins retry-cap-exceeded rows to failed with audit log / retry cap 超過は failed + audit log", async () => {
    const exhausted = makeSkippedRow(
      "019bc444-4444-7777-8888-dddddddddddd",
      "skipped_memory_pressure",
      { retryCount: 5 }
    );
    const prisma = buildPrismaMock([exhausted]);
    const queue = buildQueueMock();
    const result = await reconcileStaleBackfillJobs({ prisma, queue });
    expect(result.retryCapExhausted).toBe(1);
    expect(result.skipRecoveryEnqueued).toBe(0);

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "backfill_retry_exhausted" })
    );
  });

  it("skips when active queue job exists / active job 残存時はスキップ", async () => {
    const row = makeSkippedRow("019bc555-5555-7777-8888-eeeeeeeeeeee", "skipped_fork_error");
    const prisma = buildPrismaMock([row]);
    const queue = buildQueueMock({ hasActiveJob: true });
    const result = await reconcileStaleBackfillJobs({ prisma, queue });
    // staleDetected はインクリメントされない（active job 検出で continue）
    // staleDetected NOT incremented (continue on active job)
    expect(result.staleDetected).toBe(0);
    expect(result.skipRecoveryEnqueued).toBe(0);
  });

  it("respects back-pressure cap (waiting > 10000) / back-pressure 超過時はスキップ", async () => {
    const row = makeSkippedRow("019bc666-6666-7777-8888-ffffffffffff", "skipped_fork_error");
    const prisma = buildPrismaMock([row]);
    const queue = buildQueueMock({ waitingCount: 11_000 });
    const result = await reconcileStaleBackfillJobs({ prisma, queue });
    expect(result.skipRecoveryEnqueued).toBe(0);
    // staleDetected はカウントされる（back-pressure チェックは active 後）
    // staleDetected counted (back-pressure check after active check)
    expect(result.staleDetected).toBe(1);
  });

  it("CAS race counted as concurrentUpdatesSkipped / CAS race を concurrentUpdatesSkipped に計上", async () => {
    const row = makeSkippedRow("019bc777-7777-7777-8888-aaaaaaaaaaa1", "skipped_fork_error");
    // updateMany 全体で count=0（CAS race を再現）
    // updateMany returns count=0 across the board (simulates CAS race)
    const updateManySpy = vi.fn(async () => ({ count: 0 }));
    const prisma = buildPrismaMock([row]);
    (prisma.webPage.updateMany as never) = updateManySpy;
    const queue = buildQueueMock();
    const result = await reconcileStaleBackfillJobs({ prisma, queue });
    expect(result.concurrentUpdatesSkipped).toBeGreaterThanOrEqual(1);
    expect(result.skipRecoveryEnqueued).toBe(0);
  });

  it("dryRun does not write to DB and previews TTL expiration / dryRun は書き込み無しで TTL preview", async () => {
    const oldRow = makeSkippedRow("019bc888-8888-7777-8888-bbbbbbbbbbb1", "skipped_fork_error", {
      skippedAgeHours: 9 * 24,
    });
    const updateManySpy = vi.fn(async () => ({ count: 1 }));
    const prisma = buildPrismaMock([oldRow]);
    (prisma.webPage.updateMany as never) = updateManySpy;
    const queue = buildQueueMock();
    const result = await reconcileStaleBackfillJobs({ prisma, queue, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(updateManySpy).not.toHaveBeenCalled();
    expect(result.ttlExpired).toBe(0);
  });

  it("memory_pressure path enqueues with initial delay / memory_pressure 経路は delay 付き enqueue", async () => {
    const row = makeSkippedRow("019bc999-9999-7777-8888-ccccccccccc1", "skipped_memory_pressure", {
      screenshotStoragePath: null,
    });
    const addJobSpy = vi.fn(async () => ({ id: "j1" }));
    const prisma = buildPrismaMock([row]);
    const queue = buildQueueMock({ addJob: addJobSpy });
    const result = await reconcileStaleBackfillJobs({ prisma, queue });
    expect(result.skipRecoveryEnqueued).toBe(1);
    // すべての enqueue 呼び出しに delay > 0 が含まれている
    // All enqueue calls must include delay > 0
    const calls = addJobSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, , opts] of calls as Array<[unknown, unknown, { delay?: number }]>) {
      expect(opts.delay).toBeGreaterThan(0);
    }
  });
});
