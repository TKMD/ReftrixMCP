// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BackfillReconciliationService Tests (v0.4.0 PR5 / PR6)
 *
 * 純粋な service 関数として動作する `reconcileStaleBackfillJobs` を、
 * モックされた PrismaClient / Queue に対してユニットテストする。
 *
 * PR6 更新: `update` → `updateMany` CAS、`updatedAt` → `embeddingBackfillStartedAt`、
 * `concurrentUpdatesSkipped` / `dryRun` 追加。
 *
 * Unit tests for `reconcileStaleBackfillJobs` with mocked PrismaClient / Queue.
 * PR6 updates: `update` → `updateMany` CAS, `updatedAt` → `embeddingBackfillStartedAt`,
 * added `concurrentUpdatesSkipped` / `dryRun`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import {
  reconcileStaleBackfillJobs,
  type BackfillReconciliationResult,
} from "../../src/services/backfill-reconciliation.service";
import {
  buildBackfillJobId,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "../../src/queues/embedding-backfill-queue";

type MockedQueue = Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;

interface FakePageRow {
  id: string;
  url: string;
  embeddingBackfillStartedAt: Date | null;
}

interface FakeJob {
  id: string;
  state: string;
}

function buildPrismaMock(options: {
  pages: FakePageRow[];
  textPendingByPage: Record<string, number>;
  visualPendingByPage: Record<string, number>;
  updateManySpy?: ReturnType<typeof vi.fn>;
  /**
   * v0.4.0 PR7b: skipped_* 状態の行（Section B 用）。デフォルト空配列。
   * v0.4.0 PR7b: skipped_* rows (for Section B). Defaults to empty array.
   */
  skippedPages?: Array<
    FakePageRow & {
      embeddingBackfillStatus: "skipped_fork_error" | "skipped_memory_pressure";
      embeddingBackfillSkippedAt: Date;
      embeddingBackfillRetryCount?: number;
      screenshotStoragePath?: string | null;
    }
  >;
}): PrismaClient {
  // Default: every updateMany succeeds with count=1 (CAS hit).
  // PR6 TPA #1: updateMany may return count=0 when worker already transitioned.
  const updateManySpy = options.updateManySpy ?? vi.fn(async () => ({ count: 1 }));
  // v0.4.0 PR7b: findMany dispatches by `where.embeddingBackfillStatus` filter:
  //   - "in_progress" (Section A) → returns options.pages
  //   - { in: ["skipped_fork_error", "skipped_memory_pressure"] } (Section B)
  //     → returns options.skippedPages (default [])
  // v0.4.0 PR7b: findMany ディスパッチを where 句で行う。Section A/B を分離。
  const skippedPages = options.skippedPages ?? [];
  const findManySpy = vi.fn(async (args: { where?: { embeddingBackfillStatus?: unknown } }) => {
    const status = args?.where?.embeddingBackfillStatus;
    if (typeof status === "object" && status !== null && "in" in status) {
      return skippedPages;
    }
    return options.pages;
  });

  const queryRawUnsafe = vi.fn(async (sql: string, id: string) => {
    if (sql.includes("LEFT JOIN")) {
      return [{ count: BigInt(options.textPendingByPage[id] ?? 0) }];
    }
    return [{ count: BigInt(options.visualPendingByPage[id] ?? 0) }];
  });

  return {
    webPage: {
      findMany: findManySpy,
      updateMany: updateManySpy,
    },
    $queryRawUnsafe: queryRawUnsafe,
  } as unknown as PrismaClient;
}

function buildQueueMock(jobsByPage: Record<string, FakeJob[]>): MockedQueue {
  const getJob = vi.fn(async (jobId: string) => {
    for (const [_, jobs] of Object.entries(jobsByPage)) {
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

function makePage(id: string, url = "https://example.com"): FakePageRow {
  return {
    id,
    url,
    embeddingBackfillStartedAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3h ago
  };
}

describe("reconcileStaleBackfillJobs (v0.4.0 PR5 / PR6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("staleness threshold", () => {
    it("returns zero-check result when no pages exceed threshold", async () => {
      const prisma = buildPrismaMock({
        pages: [],
        textPendingByPage: {},
        visualPendingByPage: {},
      });
      const queue = buildQueueMock({});
      const result: BackfillReconciliationResult = await reconcileStaleBackfillJobs({
        prisma,
        queue,
      });
      expect(result.totalChecked).toBe(0);
      expect(result.staleDetected).toBe(0);
      expect(result.remediated).toBe(0);
      expect(result.concurrentUpdatesSkipped).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.dryRun).toBe(false);
    });

    it("accepts custom staleThresholdMs", async () => {
      const prisma = buildPrismaMock({
        pages: [],
        textPendingByPage: {},
        visualPendingByPage: {},
      });
      const queue = buildQueueMock({});
      await reconcileStaleBackfillJobs({
        prisma,
        queue,
        staleThresholdMs: 15 * 60 * 1000,
      });
      // v0.4.0 PR7b: findMany is called twice — once for Section A (in_progress)
      // and once for Section B (skipped_*). Both must use the threshold.
      // v0.4.0 PR7b: findMany は Section A (in_progress) と Section B (skipped_*) で 2 回呼ばれる。
      expect(prisma.webPage.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe("queue state handling", () => {
    const page = makePage("019bc123-4567-7890-abcd-ef1234567890");

    it("leaves in_progress untouched when queue has active job", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: { [page.id]: 0 },
        visualPendingByPage: { [page.id]: 0 },
        updateManySpy,
      });
      const queue = buildQueueMock({
        [page.id]: [{ id: buildBackfillJobId(page.id, "part_text"), state: "active" }],
      });
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.totalChecked).toBe(1);
      expect(result.staleDetected).toBe(0);
      expect(result.remediated).toBe(0);
      expect(updateManySpy).not.toHaveBeenCalled();
    });

    it("leaves in_progress untouched when queue has waiting job", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: { [page.id]: 0 },
        visualPendingByPage: { [page.id]: 0 },
        updateManySpy,
      });
      const queue = buildQueueMock({
        [page.id]: [{ id: buildBackfillJobId(page.id, "part_visual"), state: "waiting" }],
      });
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.staleDetected).toBe(0);
      expect(updateManySpy).not.toHaveBeenCalled();
    });

    it("leaves in_progress untouched when queue has delayed job", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: { [page.id]: 0 },
        visualPendingByPage: { [page.id]: 0 },
        updateManySpy,
      });
      const queue = buildQueueMock({
        [page.id]: [{ id: buildBackfillJobId(page.id, "part_text"), state: "delayed" }],
      });
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.staleDetected).toBe(0);
      expect(updateManySpy).not.toHaveBeenCalled();
    });
  });

  describe("DB-based reconciliation", () => {
    const page = makePage("019bc123-4567-7890-abcd-ef1234567891");

    it("transitions to completed when DB is fully populated", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: { [page.id]: 0 },
        visualPendingByPage: { [page.id]: 0 },
        updateManySpy,
      });
      const queue = buildQueueMock({});
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.staleDetected).toBe(1);
      expect(result.remediated).toBe(1);
      expect(updateManySpy).toHaveBeenCalledWith({
        where: { id: page.id, embeddingBackfillStatus: "in_progress" },
        data: { embeddingBackfillStatus: "completed" },
      });
    });

    it("transitions to failed when DB still has text gaps", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: { [page.id]: 42 },
        visualPendingByPage: { [page.id]: 0 },
        updateManySpy,
      });
      const queue = buildQueueMock({});
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.remediated).toBe(1);
      expect(updateManySpy).toHaveBeenCalledWith({
        where: { id: page.id, embeddingBackfillStatus: "in_progress" },
        data: { embeddingBackfillStatus: "failed" },
      });
    });

    it("transitions to failed when DB still has visual gaps", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: { [page.id]: 0 },
        visualPendingByPage: { [page.id]: 7 },
        updateManySpy,
      });
      const queue = buildQueueMock({});
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.remediated).toBe(1);
      expect(updateManySpy).toHaveBeenCalledWith({
        where: { id: page.id, embeddingBackfillStatus: "in_progress" },
        data: { embeddingBackfillStatus: "failed" },
      });
    });

    it("ignores queue entry in completed state (treated as absent)", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: { [page.id]: 0 },
        visualPendingByPage: { [page.id]: 0 },
        updateManySpy,
      });
      const queue = buildQueueMock({
        [page.id]: [{ id: buildBackfillJobId(page.id, "part_text"), state: "completed" }],
      });
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.staleDetected).toBe(1);
      expect(result.remediated).toBe(1);
    });
  });

  describe("PR6 TPA #1: CAS concurrent-updates skip", () => {
    const page = makePage("019bc123-4567-7890-abcd-ef1234567892");

    it("counts concurrentUpdatesSkipped when updateMany returns count=0", async () => {
      // Worker が先に completed 遷移させた状況をシミュレート
      // Simulate worker having transitioned the row first.
      const updateManySpy = vi.fn(async () => ({ count: 0 }));
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: { [page.id]: 0 },
        visualPendingByPage: { [page.id]: 0 },
        updateManySpy,
      });
      const queue = buildQueueMock({});
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.staleDetected).toBe(1);
      expect(result.remediated).toBe(0);
      expect(result.concurrentUpdatesSkipped).toBe(1);
    });

    it("WHERE clause includes embeddingBackfillStatus: 'in_progress' guard", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: { [page.id]: 0 },
        visualPendingByPage: { [page.id]: 0 },
        updateManySpy,
      });
      const queue = buildQueueMock({});
      await reconcileStaleBackfillJobs({ prisma, queue });
      expect(updateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            embeddingBackfillStatus: "in_progress",
          }),
        })
      );
    });
  });

  describe("PR6 SEC LOW-2: dry-run mode", () => {
    const page = makePage("019bc123-4567-7890-abcd-ef1234567893");

    it("skips DB updates when dryRun=true", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: { [page.id]: 0 },
        visualPendingByPage: { [page.id]: 0 },
        updateManySpy,
      });
      const queue = buildQueueMock({});
      const result = await reconcileStaleBackfillJobs({ prisma, queue, dryRun: true });
      expect(result.staleDetected).toBe(1);
      expect(result.remediated).toBe(0);
      expect(result.dryRun).toBe(true);
      expect(updateManySpy).not.toHaveBeenCalled();
    });
  });

  describe("PR6 TPA #2: embeddingBackfillStartedAt-based stale detection", () => {
    it("findMany filters by embeddingBackfillStartedAt (dedicated column)", async () => {
      const findManySpy = vi.fn(async () => []);
      const prisma = {
        webPage: {
          findMany: findManySpy,
          updateMany: vi.fn(),
        },
        $queryRawUnsafe: vi.fn(),
      } as unknown as PrismaClient;
      const queue = buildQueueMock({});
      await reconcileStaleBackfillJobs({ prisma, queue });
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            embeddingBackfillStartedAt: expect.objectContaining({ not: null }),
          }),
        })
      );
    });
  });

  describe("error handling", () => {
    it("counts errors without aborting the batch", async () => {
      const page1 = makePage("019bc123-4567-7890-abcd-ef1234567894", "https://a.com");
      const page2 = makePage("019bc123-4567-7890-abcd-ef1234567895", "https://b.com");
      const updateManySpy = vi.fn(async (params: { where: { id: string }; data: unknown }) => {
        if (params.where.id === page1.id) {
          throw new Error("DB down");
        }
        return { count: 1 };
      });
      const prisma = buildPrismaMock({
        pages: [page1, page2],
        textPendingByPage: { [page1.id]: 0, [page2.id]: 0 },
        visualPendingByPage: { [page1.id]: 0, [page2.id]: 0 },
        updateManySpy,
      });
      const queue = buildQueueMock({});
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.totalChecked).toBe(2);
      expect(result.errors).toBe(1);
      expect(result.remediated).toBe(1);
    });
  });

  describe("Zod validation", () => {
    const page = makePage("019bc123-4567-7890-abcd-ef1234567896");

    it("rejects negative staleThresholdMs", async () => {
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: {},
        visualPendingByPage: {},
      });
      const queue = buildQueueMock({});
      await expect(
        reconcileStaleBackfillJobs({ prisma, queue, staleThresholdMs: -100 })
      ).rejects.toThrow();
    });

    it("rejects zero batchLimit", async () => {
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: {},
        visualPendingByPage: {},
      });
      const queue = buildQueueMock({});
      await expect(reconcileStaleBackfillJobs({ prisma, queue, batchLimit: 0 })).rejects.toThrow();
    });

    it("rejects excessive batchLimit", async () => {
      const prisma = buildPrismaMock({
        pages: [page],
        textPendingByPage: {},
        visualPendingByPage: {},
      });
      const queue = buildQueueMock({});
      await expect(
        reconcileStaleBackfillJobs({ prisma, queue, batchLimit: 999_999 })
      ).rejects.toThrow();
    });
  });
});
