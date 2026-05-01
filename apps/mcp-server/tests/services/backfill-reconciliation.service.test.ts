// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BackfillReconciliationService Tests (v0.4.0 PR5 / PR6 / PR7e-β2 carryover)
 *
 * 純粋な service 関数として動作する `reconcileStaleBackfillJobs` を、
 * モックされた PrismaClient / Queue に対してユニットテストする。
 *
 * PR6 更新: `update` → `updateMany` CAS、`updatedAt` → `embeddingBackfillStartedAt`、
 * `concurrentUpdatesSkipped` / `dryRun` 追加。
 *
 * PR7e-β2 carryover (SSOT unification): 旧 `countRemainingGaps` (part_text /
 * part_visual の 2 カテゴリのみ) を廃止し、`computeRemainingStatusWithPrisma`
 * helper (全 7 カテゴリ backfill-eligible) に統一。テストモックも Prisma API
 * ベースに再構成し、blank image skip / section カバー外 parts を legitimate
 * skip として扱う SSOT を Reconciliation が SSOT として参照することを保証する。
 *
 * Unit tests for `reconcileStaleBackfillJobs` with mocked PrismaClient / Queue.
 * PR6 updates: `update` → `updateMany` CAS, `updatedAt` → `embeddingBackfillStartedAt`,
 * added `concurrentUpdatesSkipped` / `dryRun`.
 *
 * PR7e-β2 carryover (SSOT unification): Deprecated the 2-category
 * `countRemainingGaps` and unified on the 7-category backfill-eligible
 * `computeRemainingStatusWithPrisma` helper. Mocks rebuilt to exercise the
 * Prisma-level API that the helper calls, so Reconciliation mirrors the
 * worker's SSOT (blank-image skips / out-of-section parts remain legitimate
 * skips, not mis-counted pendings).
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

/**
 * Category-level pending counts that the SSOT helper
 * (`computeRemainingStatusWithPrisma`) inspects. Each page declares
 * the count per category; default = 0 (fully complete, no residual backfill).
 *
 * SSOT helper が参照する 7 カテゴリの pending 件数。デフォルト 0（= 完了状態）。
 */
interface PagePendingCounts {
  partText?: number;
  partVisual?: number; // raw visual gaps (helper 側で legitimate skip は既に除外されている前提)
  sectionVisual?: number;
  motion?: number;
  background?: number;
  jsAnimation?: number;
  responsive?: number;
}

function buildPrismaMock(options: {
  pages: FakePageRow[];
  /**
   * PR7e-β2 carryover (SSOT): pending counts per category per page. Any
   * omitted page defaults to all-zero (complete).
   */
  pendingByPage?: Record<string, PagePendingCounts>;
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

  const pendingByPage = options.pendingByPage ?? {};

  // PR7e-β2 carryover: SSOT helper は以下の Prisma API を webPageId 毎に呼ぶ:
  //   - prisma.componentPart.count (part_text)
  //   - prisma.motionPattern.count (motion)
  //   - prisma.backgroundDesign.count (background)
  //   - prisma.jSAnimationPattern.count (js_animation)
  //   - prisma.responsiveAnalysis.count (responsive)
  //   - prisma.$queryRawUnsafe (part_visual + section_visual)
  const makeCountSpy = (category: keyof PagePendingCounts) =>
    vi.fn(async (args: { where?: { webPageId?: string } }) => {
      const id = args?.where?.webPageId ?? "";
      return pendingByPage[id]?.[category] ?? 0;
    });

  const componentPartCount = makeCountSpy("partText");
  const motionPatternCount = makeCountSpy("motion");
  const backgroundDesignCount = makeCountSpy("background");
  const jsAnimationPatternCount = makeCountSpy("jsAnimation");
  const responsiveAnalysisCount = makeCountSpy("responsive");

  // $queryRawUnsafe: ヘルパーは part_visual (JOIN component_part_embeddings) と
  // section_visual (JOIN section_embeddings) の 2 クエリを呼ぶ。SQL の中身で判別。
  //
  // $queryRawUnsafe: the helper issues two queries — part_visual (JOIN
  // component_part_embeddings) and section_visual (JOIN section_embeddings).
  // Dispatch by SQL substring.
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
    componentPart: { count: componentPartCount },
    motionPattern: { count: motionPatternCount },
    backgroundDesign: { count: backgroundDesignCount },
    jSAnimationPattern: { count: jsAnimationPatternCount },
    responsiveAnalysis: { count: responsiveAnalysisCount },
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
      const prisma = buildPrismaMock({ pages: [] });
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
      const prisma = buildPrismaMock({ pages: [] });
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
      const prisma = buildPrismaMock({ pages: [page], updateManySpy });
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
      const prisma = buildPrismaMock({ pages: [page], updateManySpy });
      const queue = buildQueueMock({
        [page.id]: [{ id: buildBackfillJobId(page.id, "part_visual"), state: "waiting" }],
      });
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.staleDetected).toBe(0);
      expect(updateManySpy).not.toHaveBeenCalled();
    });

    it("leaves in_progress untouched when queue has delayed job", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({ pages: [page], updateManySpy });
      const queue = buildQueueMock({
        [page.id]: [{ id: buildBackfillJobId(page.id, "part_text"), state: "delayed" }],
      });
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.staleDetected).toBe(0);
      expect(updateManySpy).not.toHaveBeenCalled();
    });
  });

  describe("DB-based reconciliation (SSOT via computeRemainingStatusWithPrisma)", () => {
    const page = makePage("019bc123-4567-7890-abcd-ef1234567891");

    it("transitions to completed when all 7 categories are fully populated", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({ pages: [page], updateManySpy });
      const queue = buildQueueMock({});
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.staleDetected).toBe(1);
      expect(result.remediated).toBe(1);
      expect(updateManySpy).toHaveBeenCalledWith({
        where: { id: page.id, embeddingBackfillStatus: "in_progress" },
        data: { embeddingBackfillStatus: "completed" },
      });
    });

    it("transitions to failed when DB still has part_text gaps", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        pendingByPage: { [page.id]: { partText: 42 } },
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

    it("transitions to failed when DB still has part_visual gaps", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        pendingByPage: { [page.id]: { partVisual: 7 } },
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

    it("transitions to failed when DB still has section_visual gaps", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        pendingByPage: { [page.id]: { sectionVisual: 3 } },
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

    it("transitions to failed when any of motion/background/js_animation/responsive has gaps", async () => {
      // PR7e-β2 carryover regression guard: Stripe-like motion_embeddings=0 の場合でも
      // SSOT helper が motion pending を検出し、reconciliation は `failed` に pin する。
      // Regression guard for Stripe-like motion_embeddings=0: SSOT helper must
      // pick up the motion pending and reconciliation must pin to `failed`.
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        pendingByPage: { [page.id]: { motion: 216 } },
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
      const prisma = buildPrismaMock({ pages: [page], updateManySpy });
      const queue = buildQueueMock({
        [page.id]: [{ id: buildBackfillJobId(page.id, "part_text"), state: "completed" }],
      });
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.staleDetected).toBe(1);
      expect(result.remediated).toBe(1);
    });
  });

  describe("PR7e-β2 carryover (SSOT unification): Stripe-like legitimate-skip regression", () => {
    // Stripe-like scenario: part_text 100% 完了 / part_visual 12% (254 parts のうち 30 件
    // 生成 / 224 件 blank image 等で legitimate skip 済) / 他カテゴリ全完了。旧
    // `countRemainingGaps` は part_visual_pending=224 をカウントして `failed` に
    // 誤判定していた。SSOT helper は backfill-eligible な (Phase 5 screenshot 絞り込み
    // 後の) 残件のみを数えるため、ここでは `partVisual: 0` として完了扱い。
    //
    // Stripe-like scenario: part_text fully complete, part_visual 12% (30 of 254
    // generated; remaining 224 already skipped as legitimate blank-image etc.),
    // all other categories complete. The old `countRemainingGaps` counted all 224
    // as pending and mis-classified the page as `failed`. The SSOT helper only
    // counts backfill-eligible items (post Phase-5 screenshot narrowing), so
    // here `partVisual: 0` legitimately represents a completed page.
    const page = makePage("019bc123-4567-7890-abcd-ef1234567897");

    it("transitions to completed even when most part_visual embeddings were legitimately skipped", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({
        pages: [page],
        pendingByPage: {
          [page.id]: {
            partText: 0,
            partVisual: 0, // SSOT-filtered: all 224 blank-image-skipped parts excluded
            sectionVisual: 0,
            motion: 0,
            background: 0,
            jsAnimation: 0,
            responsive: 0,
          },
        },
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
  });

  describe("PR6 TPA #1: CAS concurrent-updates skip", () => {
    const page = makePage("019bc123-4567-7890-abcd-ef1234567892");

    it("counts concurrentUpdatesSkipped when updateMany returns count=0", async () => {
      // Worker が先に completed 遷移させた状況をシミュレート
      // Simulate worker having transitioned the row first.
      const updateManySpy = vi.fn(async () => ({ count: 0 }));
      const prisma = buildPrismaMock({ pages: [page], updateManySpy });
      const queue = buildQueueMock({});
      const result = await reconcileStaleBackfillJobs({ prisma, queue });
      expect(result.staleDetected).toBe(1);
      expect(result.remediated).toBe(0);
      expect(result.concurrentUpdatesSkipped).toBe(1);
    });

    it("WHERE clause includes embeddingBackfillStatus: 'in_progress' guard", async () => {
      const updateManySpy = vi.fn(async () => ({ count: 1 }));
      const prisma = buildPrismaMock({ pages: [page], updateManySpy });
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
      const prisma = buildPrismaMock({ pages: [page], updateManySpy });
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
      const prisma = buildPrismaMock({ pages: [page] });
      const queue = buildQueueMock({});
      await expect(
        reconcileStaleBackfillJobs({ prisma, queue, staleThresholdMs: -100 })
      ).rejects.toThrow();
    });

    it("rejects zero batchLimit", async () => {
      const prisma = buildPrismaMock({ pages: [page] });
      const queue = buildQueueMock({});
      await expect(reconcileStaleBackfillJobs({ prisma, queue, batchLimit: 0 })).rejects.toThrow();
    });

    it("rejects excessive batchLimit", async () => {
      const prisma = buildPrismaMock({ pages: [page] });
      const queue = buildQueueMock({});
      await expect(
        reconcileStaleBackfillJobs({ prisma, queue, batchLimit: 999_999 })
      ).rejects.toThrow();
    });
  });
});
