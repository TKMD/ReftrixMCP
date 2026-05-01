// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backfill Status Helper Tests (v0.4.0 PR7e-β2 carryover — SSOT unification)
 *
 * `computeRemainingStatusWithPrisma` が 7 カテゴリ全てを DB レベルで数え、
 * いずれか 1 件でも未完了なら `in_progress`、全て 0 件なら `completed` を
 * 返すことを検証する。Worker (`embedding-backfill-worker.ts`) と
 * Reconciliation (`backfill-reconciliation.service.ts`) の両方が本 helper を
 * 呼ぶため、SSOT drift が発生しないことを保証する回帰テスト。
 *
 * Regression tests confirming `computeRemainingStatusWithPrisma` counts all 7
 * categories at the DB level and returns `in_progress` if any is non-zero,
 * else `completed`. Both the worker (`embedding-backfill-worker.ts`) and the
 * reconciliation service (`backfill-reconciliation.service.ts`) call this
 * helper; these tests guard against SSOT drift.
 */

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  computeRemainingStatusWithPrisma,
  countPartVisualBackfillTargetsWithPrisma,
} from "../../src/services/backfill-status.helper";

interface PendingCounts {
  partText?: number;
  partVisual?: number;
  sectionVisual?: number;
  motion?: number;
  background?: number;
  jsAnimation?: number;
  responsive?: number;
}

function buildPrismaMock(counts: PendingCounts): PrismaClient {
  return {
    componentPart: {
      count: vi.fn(async () => counts.partText ?? 0),
    },
    motionPattern: {
      count: vi.fn(async () => counts.motion ?? 0),
    },
    backgroundDesign: {
      count: vi.fn(async () => counts.background ?? 0),
    },
    jSAnimationPattern: {
      count: vi.fn(async () => counts.jsAnimation ?? 0),
    },
    responsiveAnalysis: {
      count: vi.fn(async () => counts.responsive ?? 0),
    },
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes("component_part_embeddings")) {
        return [{ count: BigInt(counts.partVisual ?? 0) }];
      }
      if (sql.includes("section_embeddings")) {
        return [{ count: BigInt(counts.sectionVisual ?? 0) }];
      }
      return [{ count: BigInt(0) }];
    }),
  } as unknown as PrismaClient;
}

const FAKE_PAGE_ID = "019bc123-4567-7890-abcd-ef1234500001";

describe("computeRemainingStatusWithPrisma (SSOT)", () => {
  it("returns 'completed' when all 7 categories have zero pending", async () => {
    const prisma = buildPrismaMock({});
    const { finalStatus: status } = await computeRemainingStatusWithPrisma(FAKE_PAGE_ID, prisma);
    expect(status).toBe("completed");
  });

  it("returns 'in_progress' when part_text has pending", async () => {
    const prisma = buildPrismaMock({ partText: 10 });
    const { finalStatus: status } = await computeRemainingStatusWithPrisma(FAKE_PAGE_ID, prisma);
    expect(status).toBe("in_progress");
  });

  it("returns 'in_progress' when part_visual has pending", async () => {
    const prisma = buildPrismaMock({ partVisual: 1 });
    const { finalStatus: status } = await computeRemainingStatusWithPrisma(FAKE_PAGE_ID, prisma);
    expect(status).toBe("in_progress");
  });

  it("returns 'in_progress' when section_visual has pending", async () => {
    const prisma = buildPrismaMock({ sectionVisual: 3 });
    const { finalStatus: status } = await computeRemainingStatusWithPrisma(FAKE_PAGE_ID, prisma);
    expect(status).toBe("in_progress");
  });

  it("returns 'in_progress' when motion has pending (Stripe-like motion_embeddings=0 regression)", async () => {
    // Stripe ケース: motion_patterns=216 件に対し motion_embeddings=0 件の状況。
    // SSOT helper は motion.count({ embedding: null }) で 216 を返し in_progress になる。
    // Stripe case: motion_patterns=216 but motion_embeddings=0. SSOT helper
    // returns 216 via motion.count and must classify as in_progress.
    const prisma = buildPrismaMock({ motion: 216 });
    const { finalStatus: status } = await computeRemainingStatusWithPrisma(FAKE_PAGE_ID, prisma);
    expect(status).toBe("in_progress");
  });

  it("returns 'in_progress' when background has pending", async () => {
    const prisma = buildPrismaMock({ background: 5 });
    const { finalStatus: status } = await computeRemainingStatusWithPrisma(FAKE_PAGE_ID, prisma);
    expect(status).toBe("in_progress");
  });

  it("returns 'in_progress' when js_animation has pending", async () => {
    const prisma = buildPrismaMock({ jsAnimation: 2 });
    const { finalStatus: status } = await computeRemainingStatusWithPrisma(FAKE_PAGE_ID, prisma);
    expect(status).toBe("in_progress");
  });

  it("returns 'in_progress' when responsive has pending", async () => {
    const prisma = buildPrismaMock({ responsive: 1 });
    const { finalStatus: status } = await computeRemainingStatusWithPrisma(FAKE_PAGE_ID, prisma);
    expect(status).toBe("in_progress");
  });

  it("invokes all 7 category counters in parallel", async () => {
    const prisma = buildPrismaMock({});
    await computeRemainingStatusWithPrisma(FAKE_PAGE_ID, prisma);
    expect(prisma.componentPart.count).toHaveBeenCalledTimes(1);
    expect(prisma.motionPattern.count).toHaveBeenCalledTimes(1);
    expect(prisma.backgroundDesign.count).toHaveBeenCalledTimes(1);
    expect(prisma.jSAnimationPattern.count).toHaveBeenCalledTimes(1);
    expect(prisma.responsiveAnalysis.count).toHaveBeenCalledTimes(1);
    // part_visual + section_visual = 2 raw queries
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("defends against NaN / Infinity in section_visual raw query result", async () => {
    // Number.parseInt("foo", 10) → NaN を返すケースでも 0 扱いで completed 判定されること。
    // Ensures NaN from a malformed `count` string falls back to 0, not breaking the aggregate.
    const prisma = {
      componentPart: { count: vi.fn(async () => 0) },
      motionPattern: { count: vi.fn(async () => 0) },
      backgroundDesign: { count: vi.fn(async () => 0) },
      jSAnimationPattern: { count: vi.fn(async () => 0) },
      responsiveAnalysis: { count: vi.fn(async () => 0) },
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes("component_part_embeddings")) {
          return [{ count: "not-a-number" }];
        }
        return [{ count: BigInt(0) }];
      }),
    } as unknown as PrismaClient;
    const { finalStatus: status } = await computeRemainingStatusWithPrisma(FAKE_PAGE_ID, prisma);
    expect(status).toBe("completed");
  });
});

describe("countPartVisualBackfillTargetsWithPrisma", () => {
  it("returns pendingCount=0 when no part_visual gaps exist", async () => {
    const prisma = buildPrismaMock({});
    const result = await countPartVisualBackfillTargetsWithPrisma(FAKE_PAGE_ID, prisma);
    expect(result.pendingCount).toBe(0);
  });

  it("returns pendingCount=N for positive bigint count", async () => {
    const prisma = buildPrismaMock({ partVisual: 42 });
    const result = await countPartVisualBackfillTargetsWithPrisma(FAKE_PAGE_ID, prisma);
    expect(result.pendingCount).toBe(42);
  });

  it("returns pendingCount=0 for negative/invalid raw values (defensive)", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn(async () => [{ count: "-5" }]),
    } as unknown as PrismaClient;
    const result = await countPartVisualBackfillTargetsWithPrisma(FAKE_PAGE_ID, prisma);
    expect(result.pendingCount).toBe(0);
  });

  it("returns pendingCount=0 when row is absent (raw returns [])", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn(async () => []),
    } as unknown as PrismaClient;
    const result = await countPartVisualBackfillTargetsWithPrisma(FAKE_PAGE_ID, prisma);
    expect(result.pendingCount).toBe(0);
  });
});
