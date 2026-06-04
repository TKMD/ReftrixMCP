// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-BACKFILL-ANALYSIS-GUARD-008 (PR-BT-4 / ADR-0018 Amendment 10 Decision 10.1 + 10.4):
 *
 *   The embedding-backfill worker must NOT process part categories until the
 *   owning `web_pages.analysisStatus` reaches a terminal state
 *   (`completed` | `failed`). While the page is still analyzing
 *   (`pending` | `processing`) the worker bounded-re-enqueues the job using the
 *   `embeddingBackfillRetryCount` CAS-increment mechanism — NOT BullMQ retry
 *   (`attempts: ≥2` / `moveToDelayed` / job-throw).
 *
 *   Contract (3 assertions):
 *     (a) `analysisStatus IN ('completed','failed')` → guard outcome `proceed`
 *         (part processing runs).
 *     (b) `analysisStatus IN ('pending','processing')` AND `retryCount < cap`
 *         → guard outcome `re_enqueue` (retryCount CAS-increment, part NOT
 *         mutated). NOT BullMQ retry.
 *     (c) deadlock fault-injection: `analysisStatus='processing'` never resolves
 *         (e.g. `markAnalysisCompleted` non-fatal failure) → re-enqueue is
 *         bounded by `retryCount` cap (`BACKFILL_RECOVERY_MAX_AUTO_RETRIES=5`);
 *         at cap the row reaches terminal `failed`. The re-enqueue loop must NOT
 *         be infinite.
 *
 * # Test strategy
 *
 *   Two surfaces, both deterministic (no testcontainer / Redis required — same
 *   mock-driven approach as INV-BACKFILL-DEADLOCK-FREE-005):
 *
 *   1. Pure leaf helper `decideAnalysisGuard()` (algorithmic contract a/b/c).
 *   2. `transitionAnalysisGuardReEnqueue()` same-shape CAS helper with
 *      mock-Prisma + mock-Queue (CAS increment, cap → terminal failed,
 *      deadlock fault-injection bounded-loop).
 *   3. AST source assertion: the worker source uses the retryCount-reuse
 *      mechanism, NOT BullMQ `moveToDelayed` (SEC-V1-01 + U1 winning contract).
 *
 * @see  §3 / §4.2.1 / §9.1
 * @see ADR-0018 Amendment 10 Decision 10.1 (H-1 guard) + 10.4 (deadlock guard)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  decideAnalysisGuard,
  isAnalysisComplete,
  BACKFILL_ANALYSIS_GUARD_DELAY_MS,
  type AnalysisGuardOutcome,
} from "../../../../src/workers/phases/backfill-analysis-guard";
import {
  transitionAnalysisGuardReEnqueue,
  type AnalysisGuardReEnqueueResult,
} from "../../../../src/workers/embedding-backfill-worker";
import { BACKFILL_RECOVERY_MAX_AUTO_RETRIES } from "../../../../src/services/backfill-recovery-reconciliation.service";

// ============================================================================
// Mock fixtures (mock-Prisma + mock-Queue, no testcontainer)
// ============================================================================

interface FakeWebPageRow {
  id: string;
  analysisStatus: string;
  embeddingBackfillStatus: string;
  embeddingBackfillRetryCount: number;
  screenshotStoragePath: string | null;
}

/**
 * Mock Prisma that mutates `web_pages` state in place. `findUnique` returns the
 * guard-relevant columns; `updateMany` applies the CAS gate (id + status `in`
 * predicate) and retryCount increment, returning `{ count }`.
 */
function makeFakePrisma(rows: FakeWebPageRow[]): {
  client: Parameters<typeof transitionAnalysisGuardReEnqueue>[0]["prisma"];
  state: FakeWebPageRow[];
} {
  const state = rows.map((r) => ({ ...r }));
  const client = {
    webPage: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => state.find((r) => r.id === where.id) ?? null
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; embeddingBackfillStatus?: { in?: string[] } | string };
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const r of state) {
            if (r.id !== where.id) continue;
            // CAS gate: status `in` predicate (SEC-V1-01 distinct gate).
            const statusGate = where.embeddingBackfillStatus;
            if (statusGate !== undefined) {
              if (typeof statusGate === "string") {
                if (r.embeddingBackfillStatus !== statusGate) continue;
              } else if (Array.isArray(statusGate.in)) {
                if (!statusGate.in.includes(r.embeddingBackfillStatus)) continue;
              }
            }
            if (typeof data.embeddingBackfillStatus === "string") {
              r.embeddingBackfillStatus = data.embeddingBackfillStatus;
            }
            if (data.embeddingBackfillRetryCount !== undefined) {
              const inc = data.embeddingBackfillRetryCount as { increment?: number };
              r.embeddingBackfillRetryCount += inc.increment ?? 0;
            }
            count += 1;
          }
          return { count };
        }
      ),
    },
  } as unknown as Parameters<typeof transitionAnalysisGuardReEnqueue>[0]["prisma"];
  return { client, state };
}

function makeFakeQueue(): {
  queue: Parameters<typeof transitionAnalysisGuardReEnqueue>[0]["queue"];
  addSpy: ReturnType<typeof vi.fn>;
} {
  const addSpy = vi.fn(async () => ({}));
  const queue = {
    add: addSpy,
    name: "embedding-backfill",
  } as unknown as Parameters<typeof transitionAnalysisGuardReEnqueue>[0]["queue"];
  return { queue, addSpy };
}

const PAGE_ID = "00000000-0000-7000-8000-0000000000a8";
const WORKER_SRC = path.resolve(__dirname, "../../../../src/workers/embedding-backfill-worker.ts");

// ============================================================================
// Tests
// ============================================================================

describe("INV-BACKFILL-ANALYSIS-GUARD-008: backfill analysis-status guard + retryCount-bounded re-enqueue", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-BACKFILL-ANALYSIS-GUARD-008");
  });

  // --------------------------------------------------------------------------
  // (a) analysisStatus completed/failed → proceed
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-ANALYSIS-GUARD-008: (a) analysisStatus='completed' → guard outcome proceed", () => {
    const outcome: AnalysisGuardOutcome = decideAnalysisGuard(
      "completed",
      0,
      BACKFILL_RECOVERY_MAX_AUTO_RETRIES
    );
    expect(outcome.kind).toBe("proceed");
    expect(isAnalysisComplete("completed")).toBe(true);
  });

  it("INV-BACKFILL-ANALYSIS-GUARD-008: (a) analysisStatus='failed' → guard outcome proceed", () => {
    const outcome = decideAnalysisGuard("failed", 3, BACKFILL_RECOVERY_MAX_AUTO_RETRIES);
    expect(outcome.kind).toBe("proceed");
    expect(isAnalysisComplete("failed")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // (b) analysisStatus pending/processing + retryCount < cap → re_enqueue
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-ANALYSIS-GUARD-008: (b) analysisStatus='processing' + retryCount<cap → guard outcome re_enqueue", () => {
    const outcome = decideAnalysisGuard("processing", 0, BACKFILL_RECOVERY_MAX_AUTO_RETRIES);
    expect(outcome.kind).toBe("re_enqueue");
    expect(isAnalysisComplete("processing")).toBe(false);
  });

  it("INV-BACKFILL-ANALYSIS-GUARD-008: (b) analysisStatus='pending' + retryCount<cap → guard outcome re_enqueue", () => {
    const outcome = decideAnalysisGuard(
      "pending",
      BACKFILL_RECOVERY_MAX_AUTO_RETRIES - 1,
      BACKFILL_RECOVERY_MAX_AUTO_RETRIES
    );
    expect(outcome.kind).toBe("re_enqueue");
    expect(isAnalysisComplete("pending")).toBe(false);
  });

  it("INV-BACKFILL-ANALYSIS-GUARD-008: (b) re_enqueue CAS-increments retryCount and re-adds without mutating embedding state", async () => {
    const { client, state } = makeFakePrisma([
      {
        id: PAGE_ID,
        analysisStatus: "processing",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillRetryCount: 0,
        screenshotStoragePath: null,
      },
    ]);
    const { queue, addSpy } = makeFakeQueue();
    const result: AnalysisGuardReEnqueueResult = await transitionAnalysisGuardReEnqueue({
      prisma: client,
      queue,
      webPageId: PAGE_ID,
      category: "part_visual",
      retryCount: 0,
      screenshotStoragePath: null,
    });
    expect(result.kind).toBe("re_enqueued");
    // retryCount CAS-incremented by 1.
    expect(state[0]?.embeddingBackfillRetryCount).toBe(1);
    // status moved to queued (NOT processed, NOT failed).
    expect(state[0]?.embeddingBackfillStatus).toBe("queued");
    // job re-added to the SAME queue (NOT BullMQ retry).
    expect(addSpy).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // (c) deadlock fault-injection: cap → terminal failed, NOT infinite loop
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-ANALYSIS-GUARD-008: (c) retryCount at cap → guard outcome terminal_failed (deadlock-free)", () => {
    const outcome = decideAnalysisGuard(
      "processing",
      BACKFILL_RECOVERY_MAX_AUTO_RETRIES,
      BACKFILL_RECOVERY_MAX_AUTO_RETRIES
    );
    expect(outcome.kind).toBe("terminal_failed");
  });

  it("INV-BACKFILL-ANALYSIS-GUARD-008: (c) deadlock fault-injection — processing never resolves, re-enqueue bounded by cap → terminal failed", async () => {
    // Fault injection: analysisStatus is permanently stuck at 'processing'
    // (e.g. markAnalysisCompleted non-fatal failure, Decision 10.4).
    const { client, state } = makeFakePrisma([
      {
        id: PAGE_ID,
        analysisStatus: "processing",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillRetryCount: 0,
        screenshotStoragePath: null,
      },
    ]);
    const { queue } = makeFakeQueue();

    // Simulate the worker guard loop: each "job receipt" reads status + retryCount,
    // decides, and (if re_enqueue) performs the CAS transition. The loop is
    // capped by an independent iteration guard to PROVE termination (not relied on).
    let iterations = 0;
    const HARD_LOOP_CAP = BACKFILL_RECOVERY_MAX_AUTO_RETRIES + 10; // generous; must terminate well before
    let reachedTerminal = false;
    while (iterations < HARD_LOOP_CAP) {
      iterations += 1;
      const row = state[0];
      if (!row) break;
      const outcome = decideAnalysisGuard(
        row.analysisStatus,
        row.embeddingBackfillRetryCount,
        BACKFILL_RECOVERY_MAX_AUTO_RETRIES
      );
      if (outcome.kind === "proceed") break;
      if (outcome.kind === "terminal_failed") {
        await transitionAnalysisGuardTerminalFailed(client, PAGE_ID);
        reachedTerminal = true;
        break;
      }
      // re_enqueue: CAS increment + re-add (status returns to queued → next job
      // receipt re-reads in_progress... but for the guard the retryCount monotonically grows).
      await transitionAnalysisGuardReEnqueue({
        prisma: client,
        queue,
        webPageId: PAGE_ID,
        category: "part_visual",
        retryCount: row.embeddingBackfillRetryCount,
        screenshotStoragePath: null,
      });
      // Next "job receipt" sees in_progress again (re-enqueued job picked up).
      state[0].embeddingBackfillStatus = "in_progress";
    }

    // MUST terminate via cap, NOT via the hard loop guard.
    expect(reachedTerminal).toBe(true);
    expect(state[0]?.embeddingBackfillStatus).toBe("failed");
    // retryCount must have reached the cap (5) — bounded, finite.
    expect(state[0]?.embeddingBackfillRetryCount).toBe(BACKFILL_RECOVERY_MAX_AUTO_RETRIES);
    // Hard loop guard must NOT have been the terminating condition.
    expect(iterations).toBeLessThan(HARD_LOOP_CAP);
  });

  // --------------------------------------------------------------------------
  // SEC-V1-01 + U1: NOT BullMQ retry — worker source uses retryCount-reuse
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-ANALYSIS-GUARD-008: worker re-enqueue uses retryCount-reuse, NOT BullMQ moveToDelayed (SEC-V1-01 / U1)", () => {
    const src = readFileSync(WORKER_SRC, "utf8");
    // The analysis-guard re-enqueue path must NOT *call* BullMQ moveToDelayed.
    // Match a method call (`.moveToDelayed(`), not the word in prose/JSDoc — the
    // docstring legitimately names the rejected mechanism (U1 winning contract).
    expect(/\.moveToDelayed\s*\(/.test(src)).toBe(false);
    // It MUST CAS-increment embeddingBackfillRetryCount (retryCount-reuse).
    expect(src.includes("embeddingBackfillRetryCount")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Delay constant sanity (U6/U9 — hardcoded constant, SEC M-01 floor)
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-ANALYSIS-GUARD-008: re-enqueue delay constant honours SEC M-01 CWE-770 floor (>= 500ms)", () => {
    expect(BACKFILL_ANALYSIS_GUARD_DELAY_MS).toBeGreaterThanOrEqual(500);
    expect(Number.isFinite(BACKFILL_ANALYSIS_GUARD_DELAY_MS)).toBe(true);
  });
});

/**
 * Helper used by the deadlock fault-injection loop — exercises the worker's
 * terminal-failed transition (CAS-guarded). Imported lazily to keep the test
 * focused; mirrors the worker's `transitionAnalysisGuardReEnqueue` companion.
 */
async function transitionAnalysisGuardTerminalFailed(
  prisma: Parameters<typeof transitionAnalysisGuardReEnqueue>[0]["prisma"],
  webPageId: string
): Promise<void> {
  const { transitionAnalysisGuardTerminalFailed: fn } =
    await import("../../../../src/workers/embedding-backfill-worker");
  await fn({ prisma, webPageId });
}
