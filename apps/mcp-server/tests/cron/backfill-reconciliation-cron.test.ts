// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * scheduleBackfillReconciliationCron Tests (v0.4.0 PR6)
 *
 * setInterval ベースの cron を fake timers で駆動し、reconcileStaleBackfillJobs
 * の呼び出しと stop() 動作を検証する。
 *
 * Unit tests for the setInterval-based reconciliation cron — validates that
 * the service is invoked and stop() halts subsequent ticks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scheduleBackfillReconciliationCron } from "../../src/cron/backfill-reconciliation-cron";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import type {
  EmbeddingBackfillJobData,
  EmbeddingBackfillJobResult,
} from "../../src/queues/embedding-backfill-queue";

// Mock the underlying service so we don't need a full Prisma mock tree
vi.mock("../../src/services/backfill-reconciliation.service", () => ({
  reconcileStaleBackfillJobs: vi.fn(async () => ({
    totalChecked: 0,
    staleDetected: 0,
    remediated: 0,
    concurrentUpdatesSkipped: 0,
    errors: 0,
    dryRun: false,
  })),
}));

import { reconcileStaleBackfillJobs } from "../../src/services/backfill-reconciliation.service";

describe("scheduleBackfillReconciliationCron (v0.4.0 PR6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(reconcileStaleBackfillJobs).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildDeps(): {
    prisma: PrismaClient;
    queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  } {
    const prisma = {} as unknown as PrismaClient;
    const queue = {} as unknown as Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
    return { prisma, queue };
  }

  it("invokes reconcileStaleBackfillJobs on interval tick", async () => {
    const { prisma, queue } = buildDeps();
    const handle = scheduleBackfillReconciliationCron({
      prisma,
      queue,
      intervalMs: 1000,
      staleThresholdMs: 60 * 60 * 1000,
      batchLimit: 500,
    });

    expect(reconcileStaleBackfillJobs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1050);
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileStaleBackfillJobs).toHaveBeenCalledTimes(1);
    const call = vi.mocked(reconcileStaleBackfillJobs).mock.calls[0]![0];
    expect(call.staleThresholdMs).toBe(60 * 60 * 1000);
    expect(call.batchLimit).toBe(500);
    handle.stop();
  });

  it("runs once immediately when runOnStart=true", async () => {
    const { prisma, queue } = buildDeps();
    const handle = scheduleBackfillReconciliationCron({
      prisma,
      queue,
      intervalMs: 60_000,
      runOnStart: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(reconcileStaleBackfillJobs).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("stop() prevents subsequent ticks", async () => {
    const { prisma, queue } = buildDeps();
    const handle = scheduleBackfillReconciliationCron({
      prisma,
      queue,
      intervalMs: 500,
    });
    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcileStaleBackfillJobs).not.toHaveBeenCalled();
  });

  it("swallows sweep errors (non-fatal)", async () => {
    vi.mocked(reconcileStaleBackfillJobs).mockRejectedValueOnce(new Error("boom"));
    const { prisma, queue } = buildDeps();
    const handle = scheduleBackfillReconciliationCron({
      prisma,
      queue,
      intervalMs: 500,
    });
    await vi.advanceTimersByTimeAsync(550);
    await Promise.resolve();
    await Promise.resolve();
    // Cron should still be running (not thrown); second tick should re-invoke
    await vi.advanceTimersByTimeAsync(550);
    expect(reconcileStaleBackfillJobs).toHaveBeenCalledTimes(2);
    handle.stop();
  });
});
