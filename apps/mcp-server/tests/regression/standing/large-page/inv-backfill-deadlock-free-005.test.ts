// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-BACKFILL-DEADLOCK-FREE-005 (Plan v3 T3-Backfill V1 Wave 2):
 *   For every `web_pages` row where `embeddingBackfillStatus = 'failed_with_known_reason'`,
 *   the row reaches a terminal state (`completed` | `failed` | `queued` re-enqueue)
 *   within `T_TERMINAL = max(5 min × MAX_AUTO_RETRIES, 60 min wall clock)`
 *   absent operator intervention.
 *
 *   C-1 winning contract (ADR-0007 Amendment 1 §A1.2.1):
 *     - `vision_residual` chain bounded by 30s polling × 5min terminal × 10min final.
 *     - `vision_residual` (>= 5min elapsed) → switches to `vision_unload_timeout`.
 *     - `vision_unload_timeout` (>= 10min elapsed) → terminal `failed`.
 *
 * INV-BACKFILL-DEADLOCK-FREE-005 (Plan v3 T3-Backfill V1 Wave 2):
 *   `failed_with_known_reason` rows must reach a terminal state via the
 *   `BackfillRecoveryReconciliationService` per-reason policy within the
 *   C-1 winning contract timeouts.
 *
 * # Test strategy
 *
 *   Use `runRecoveryCycle()` with mocked Prisma + mocked
 *   `verifyVisionUnloadFn` to deterministically drive the state machine.
 *   No testcontainer / Redis required — exercise the algorithmic contract.
 *
 *   - Case A: `vision_residual` within 5min bound + VRAM=0 → outcome `re_enqueued`
 *   - Case B: `vision_residual` 5min+ elapsed → outcome `switched_to_unload_timeout`
 *   - Case C: `vision_unload_timeout` 10min+ elapsed → outcome `terminal_failed`
 *   - Case D: `ssrf_blocked` (terminal_unrecoverable policy) → terminal `failed`
 *   - Case E: retryCount >= MAX_AUTO_RETRIES → terminal `failed`
 *   - Case F: `parity_check_failed` (legacy_existing_path) → no-op (retry bucket handles it)
 *   - Case G: feature flag disabled → cycle returns 0 row processed
 *
 * @see Plan v3 T3-Backfill V1 §4.1 INV-005 + §3.1 axis C
 * @see ADR-0007 Amendment 1 §A1.2.1 (C-1 winning contract)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  runRecoveryCycle,
  isRecoveryReconciliationEnabled,
  BACKFILL_RECOVERY_MAX_AUTO_RETRIES,
  BACKFILL_VISION_RESIDUAL_TERMINAL_BOUND_MS,
  BACKFILL_VISION_UNLOAD_FINAL_TIMEOUT_MS,
} from "../../../../src/services/backfill-recovery-reconciliation.service";
// PR-BT-4 (ADR-0018 Amendment 10 Decision 10.4 / U7): analysis-status guard
// deadlock companion — the H-1 worker re-enqueue/terminal-failed transitions.
import {
  transitionAnalysisGuardReEnqueue,
  transitionAnalysisGuardTerminalFailed,
} from "../../../../src/workers/embedding-backfill-worker";
import { decideAnalysisGuard } from "../../../../src/workers/phases/backfill-analysis-guard";

// ============================================================================
// Test fixture — minimal Prisma + Queue + verifyVisionUnload stubs
// ============================================================================

interface FakeRow {
  id: string;
  embeddingBackfillStatus: string;
  embeddingBackfillFailureReason: string | null;
  embeddingBackfillFailedAt: Date | null;
  embeddingBackfillRetryCount: number;
  screenshotStoragePath: string | null;
}

function makeFakePrisma(rows: FakeRow[]): Parameters<typeof runRecoveryCycle>[0]["prisma"] {
  // Mutable copy so updateMany can mutate state in place.
  const state = rows.map((r) => ({ ...r }));
  return {
    webPage: {
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
        const matches = state
          .filter((r) => r.embeddingBackfillStatus === where.embeddingBackfillStatus)
          .slice(0, take);
        return matches.map((r) => ({
          id: r.id,
          embeddingBackfillFailureReason: r.embeddingBackfillFailureReason,
          embeddingBackfillFailedAt: r.embeddingBackfillFailedAt,
          embeddingBackfillRetryCount: r.embeddingBackfillRetryCount,
          screenshotStoragePath: r.screenshotStoragePath,
        }));
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id: string;
            embeddingBackfillStatus: string;
            embeddingBackfillFailureReason?: string;
          };
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const r of state) {
            if (r.id !== where.id) continue;
            if (r.embeddingBackfillStatus !== where.embeddingBackfillStatus) continue;
            if (
              where.embeddingBackfillFailureReason !== undefined &&
              r.embeddingBackfillFailureReason !== where.embeddingBackfillFailureReason
            ) {
              continue;
            }
            // Apply mutations.
            if (typeof data.embeddingBackfillStatus === "string") {
              r.embeddingBackfillStatus = data.embeddingBackfillStatus;
            }
            if (data.embeddingBackfillFailureReason !== undefined) {
              r.embeddingBackfillFailureReason = data.embeddingBackfillFailureReason as
                | string
                | null;
            }
            if (data.embeddingBackfillFailedAt !== undefined) {
              r.embeddingBackfillFailedAt = data.embeddingBackfillFailedAt as Date | null;
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
    // Make the type happy (other Prisma fields not exercised).
  } as unknown as Parameters<typeof runRecoveryCycle>[0]["prisma"];
}

function makeFakeQueue(): Parameters<typeof runRecoveryCycle>[0]["queue"] {
  return {
    add: vi.fn(async () => ({})),
  } as unknown as Parameters<typeof runRecoveryCycle>[0]["queue"];
}

// Stub verifyVisionUnload to return deterministic outcomes per case.
function visionUnloaded(): Parameters<typeof runRecoveryCycle>[0]["verifyVisionUnloadFn"] {
  return (async () => ({
    status: "vision_unloaded" as const,
    sizeVramBytes: 0,
  })) as unknown as Parameters<typeof runRecoveryCycle>[0]["verifyVisionUnloadFn"];
}

function visionResidual(): Parameters<typeof runRecoveryCycle>[0]["verifyVisionUnloadFn"] {
  return (async () => ({
    status: "vision_residual" as const,
    sizeVramBytes: 1024,
    modelName: "llama3.2-vision",
    deferred: true as const,
  })) as unknown as Parameters<typeof runRecoveryCycle>[0]["verifyVisionUnloadFn"];
}

// ============================================================================
// Tests
// ============================================================================

describe("INV-BACKFILL-DEADLOCK-FREE-005: failed_with_known_reason terminal-state contract", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-BACKFILL-DEADLOCK-FREE-005");
    delete process.env.BACKFILL_RECOVERY_RECONCILIATION_ENABLED;
  });

  // --------------------------------------------------------------------------
  // Case A — vision_residual within 5min bound + VRAM=0 → re_enqueued
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-DEADLOCK-FREE-005: Case A — vision_residual within 5min bound + VRAM=0 → re_enqueued", async () => {
    const failedAt = new Date(Date.now() - 60_000); // 1 min elapsed (< 5min bound)
    const prisma = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-000000000001",
        embeddingBackfillStatus: "failed_with_known_reason",
        embeddingBackfillFailureReason: "vision_residual",
        embeddingBackfillFailedAt: failedAt,
        embeddingBackfillRetryCount: 1,
        screenshotStoragePath: null,
      },
    ]);
    const queue = makeFakeQueue();
    const result = await runRecoveryCycle({
      prisma,
      queue,
      verifyVisionUnloadFn: visionUnloaded(),
    });
    expect(result.totalChecked).toBe(1);
    expect(result.recoveryAttempted).toBe(1);
    expect(result.recoveryResolved).toBe(1);
    expect(result.terminalFailed).toBe(0);
    expect(result.switchedToUnloadTimeout).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case B — vision_residual 5min+ elapsed → switched_to_unload_timeout
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-DEADLOCK-FREE-005: Case B — vision_residual elapsed >= 5min terminal bound → switched_to_unload_timeout", async () => {
    const failedAt = new Date(Date.now() - (BACKFILL_VISION_RESIDUAL_TERMINAL_BOUND_MS + 1000));
    const prisma = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-000000000002",
        embeddingBackfillStatus: "failed_with_known_reason",
        embeddingBackfillFailureReason: "vision_residual",
        embeddingBackfillFailedAt: failedAt,
        embeddingBackfillRetryCount: 1,
        screenshotStoragePath: null,
      },
    ]);
    const queue = makeFakeQueue();
    const result = await runRecoveryCycle({
      prisma,
      queue,
      verifyVisionUnloadFn: visionResidual(),
    });
    expect(result.switchedToUnloadTimeout).toBe(1);
    expect(result.recoveryResolved).toBe(0);
    expect(result.terminalFailed).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case C — vision_unload_timeout 10min+ elapsed → terminal_failed
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-DEADLOCK-FREE-005: Case C — vision_unload_timeout elapsed >= 10min final timeout → terminal failed", async () => {
    const failedAt = new Date(Date.now() - (BACKFILL_VISION_UNLOAD_FINAL_TIMEOUT_MS + 1000));
    const prisma = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-000000000003",
        embeddingBackfillStatus: "failed_with_known_reason",
        embeddingBackfillFailureReason: "vision_unload_timeout",
        embeddingBackfillFailedAt: failedAt,
        embeddingBackfillRetryCount: 2,
        screenshotStoragePath: null,
      },
    ]);
    const queue = makeFakeQueue();
    const result = await runRecoveryCycle({
      prisma,
      queue,
      verifyVisionUnloadFn: visionResidual(),
    });
    expect(result.terminalFailed).toBe(1);
    expect(result.recoveryResolved).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case D — ssrf_blocked (terminal_unrecoverable policy) → terminal_failed
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-DEADLOCK-FREE-005: Case D — ssrf_blocked is terminal_unrecoverable → terminal failed (no auto-retry)", async () => {
    const prisma = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-000000000004",
        embeddingBackfillStatus: "failed_with_known_reason",
        embeddingBackfillFailureReason: "ssrf_blocked",
        embeddingBackfillFailedAt: new Date(Date.now() - 10_000),
        embeddingBackfillRetryCount: 0,
        screenshotStoragePath: null,
      },
    ]);
    const queue = makeFakeQueue();
    const result = await runRecoveryCycle({ prisma, queue });
    expect(result.terminalFailed).toBe(1);
    expect(result.recoveryResolved).toBe(0);
    expect(result.switchedToUnloadTimeout).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case E — retryCount >= MAX_AUTO_RETRIES → terminal_failed
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-DEADLOCK-FREE-005: Case E — retryCount >= MAX_AUTO_RETRIES (5) → terminal failed", async () => {
    const prisma = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-000000000005",
        embeddingBackfillStatus: "failed_with_known_reason",
        embeddingBackfillFailureReason: "vision_residual",
        embeddingBackfillFailedAt: new Date(Date.now() - 60_000),
        embeddingBackfillRetryCount: BACKFILL_RECOVERY_MAX_AUTO_RETRIES,
        screenshotStoragePath: null,
      },
    ]);
    const queue = makeFakeQueue();
    const result = await runRecoveryCycle({
      prisma,
      queue,
      verifyVisionUnloadFn: visionUnloaded(),
    });
    expect(result.terminalFailed).toBe(1);
    expect(result.recoveryResolved).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case F — parity_check_failed (legacy_existing_path) → noop
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-DEADLOCK-FREE-005: Case F — parity_check_failed routes to legacy retry bucket (no-op in recovery service)", async () => {
    const prisma = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-000000000006",
        embeddingBackfillStatus: "failed_with_known_reason",
        embeddingBackfillFailureReason: "parity_check_failed",
        embeddingBackfillFailedAt: new Date(Date.now() - 10_000),
        embeddingBackfillRetryCount: 0,
        screenshotStoragePath: null,
      },
    ]);
    const queue = makeFakeQueue();
    const result = await runRecoveryCycle({ prisma, queue });
    // No-op policy: row not transitioned, no terminal/resolved/switch counts.
    expect(result.terminalFailed).toBe(0);
    expect(result.recoveryResolved).toBe(0);
    expect(result.switchedToUnloadTimeout).toBe(0);
    // attempt is still emitted for SLO observability.
    expect(result.recoveryAttempted).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Case G — feature flag disabled → 0 rows processed
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-DEADLOCK-FREE-005: Case G — feature flag disabled → cycle is no-op", async () => {
    process.env.BACKFILL_RECOVERY_RECONCILIATION_ENABLED = "false";
    expect(isRecoveryReconciliationEnabled()).toBe(false);
    const prisma = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-000000000007",
        embeddingBackfillStatus: "failed_with_known_reason",
        embeddingBackfillFailureReason: "vision_residual",
        embeddingBackfillFailedAt: new Date(Date.now() - 60_000),
        embeddingBackfillRetryCount: 0,
        screenshotStoragePath: null,
      },
    ]);
    const queue = makeFakeQueue();
    const result = await runRecoveryCycle({ prisma, queue });
    expect(result.totalChecked).toBe(0);
    expect(result.recoveryAttempted).toBe(0);
    expect(result.recoveryResolved).toBe(0);
    expect(result.terminalFailed).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case H — C-1 winning contract values are correct (anchor)
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-DEADLOCK-FREE-005: Case H — C-1 SSOT values match ADR-0007 Amendment 1 §A1.2.1", async () => {
    // ADR-0007 Amendment 1 §A1.2.1 SSOT: 30s / 5min / 10min.
    expect(BACKFILL_VISION_RESIDUAL_TERMINAL_BOUND_MS).toBe(300_000);
    expect(BACKFILL_VISION_UNLOAD_FINAL_TIMEOUT_MS).toBe(600_000);
    // 5min terminal must be < 10min final (sanity invariant).
    expect(BACKFILL_VISION_RESIDUAL_TERMINAL_BOUND_MS).toBeLessThan(
      BACKFILL_VISION_UNLOAD_FINAL_TIMEOUT_MS
    );
    expect(BACKFILL_RECOVERY_MAX_AUTO_RETRIES).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // Case I — PR-BT-4 (ADR-0018 Amendment 10 Decision 10.4 / U7):
  //   analysisStatus='processing' STUCK (markAnalysisCompleted non-fatal
  //   failure) → H-1 guard re-enqueues bounded by retryCount cap → terminal
  //   `failed`. Same family as Case E (retryCount cap), applied to the
  //   analysis-status guard deadlock path. PROVES no infinite re-enqueue loop.
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-DEADLOCK-FREE-005: Case I — analysisStatus='processing' stuck → guard re-enqueue bounded by retryCount cap → terminal failed", async () => {
    interface GuardRow {
      id: string;
      analysisStatus: string;
      embeddingBackfillStatus: string;
      embeddingBackfillRetryCount: number;
      screenshotStoragePath: string | null;
    }
    const state: GuardRow[] = [
      {
        id: "00000000-0000-7000-8000-000000000009",
        // Fault injection: page analysis never completes (stuck at processing).
        analysisStatus: "processing",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillRetryCount: 0,
        screenshotStoragePath: null,
      },
    ];
    const guardPrisma = {
      webPage: {
        findUnique: vi.fn(
          async ({ where }: { where: { id: string } }) =>
            state.find((r) => r.id === where.id) ?? null
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
              const gate = where.embeddingBackfillStatus;
              if (gate !== undefined) {
                if (typeof gate === "string") {
                  if (r.embeddingBackfillStatus !== gate) continue;
                } else if (Array.isArray(gate.in) && !gate.in.includes(r.embeddingBackfillStatus)) {
                  continue;
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
    const guardQueue = {
      add: vi.fn(async () => ({})),
      name: "embedding-backfill",
    } as unknown as Parameters<typeof transitionAnalysisGuardReEnqueue>[0]["queue"];

    const HARD_LOOP_CAP = BACKFILL_RECOVERY_MAX_AUTO_RETRIES + 10;
    let iterations = 0;
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
        await transitionAnalysisGuardTerminalFailed({ prisma: guardPrisma, webPageId: row.id });
        reachedTerminal = true;
        break;
      }
      await transitionAnalysisGuardReEnqueue({
        prisma: guardPrisma,
        queue: guardQueue,
        webPageId: row.id,
        category: "part_visual",
        retryCount: row.embeddingBackfillRetryCount,
        screenshotStoragePath: null,
      });
      // Re-enqueued job is picked up again — status returns to in_progress.
      state[0].embeddingBackfillStatus = "in_progress";
    }

    // Terminal state reached via retryCount cap, NOT via the hard loop guard.
    expect(reachedTerminal).toBe(true);
    expect(state[0]?.embeddingBackfillStatus).toBe("failed");
    expect(state[0]?.embeddingBackfillRetryCount).toBe(BACKFILL_RECOVERY_MAX_AUTO_RETRIES);
    expect(iterations).toBeLessThan(HARD_LOOP_CAP);
  });
});
