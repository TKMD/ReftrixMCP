// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain (large-page cross-binding)
 *
 * INV-BACKFILL-SECONDARY-SPAWN-TIMEOUT-TERMINAL-013 (Plan v2 §6 / ADR-0011
 * Amendment 7 §A7.4 — SEC-REAUDIT-01 V2 reframe):
 *
 *   The fallback-on-absence scan-based terminal transition. When the deferred
 *   secondary-spawn retry reaches its 10min bound (`SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS`
 *   = 20 attempts) AND the `embedding-backfill` worker is still absent, the
 *   supervisor emits `backfill_secondary_spawn_timeout` (fail-loud) and runs a
 *   CAS-guard `web_pages.updateMany` that terminalizes ALL stranded overflow
 *   rows. The timer holds NO webPageId (`ensureAllWorkersRunningStaggered`
 *   signature takes only `heartbeatTimeoutMs`; webPageId grep 0 — SEC-REAUDIT-01),
 *   so this is a SCAN, not a single-row update.
 *
 *   This is the sole mechanism that terminalizes a stranded `queued` row:
 *   `queued` is selected by neither the recovery cron (`failed_with_known_reason`
 *   gate) nor reconciliation (`skipped_*`); it is the parent timer's sole
 *   responsibility (TPA-REAUDIT-01). It closes the H regression where >100-part
 *   pages delegated overflow to the backfill queue but never reached a terminal
 *   state because the consumer worker never started (MEMORY.md #162).
 *
 *   Contract (this INV pins, Plan v3 §V2.1 ruling (a)-narrowed):
 *     (c) SCAN-BASED END-TO-END: seed multiple stranded `queued` rows (>10min
 *         old) → fire the 10min timeout under fake timers → the scan terminalizes
 *         all of them to `failed_with_known_reason` / `supervisor_restart_orphan`
 *         (recovery-IN), and `backfill_secondary_spawn_timeout` is emitted. NOT
 *         targeting a single webPageId (timer has none).
 *     FROM-STATUS 2-BRANCH (Plan v3 §V2.1, SEC-REAUDIT-02 + TPA-REAUDIT-02): the
 *         give-up scan splits its terminal write by from-status:
 *           - `queued`-origin (stranded by worker-absence) →
 *             `failed_with_known_reason` + `supervisor_restart_orphan`
 *             (recovery-IN; the recovery handler re-enqueues toward `completed`).
 *           - `in_progress`-origin (real vision-unload timeout) → UNCHANGED bare
 *             `failed` + `vision_unload_timeout` (recovery-OUT, SEC-REAUDIT-02
 *             race-window cover preserved).
 *         The time-anchor `embeddingBackfillStartedAt < now - 10min` excludes
 *         in-flight (<10min) normal rows from false terminalization.
 *     RACE WINDOW (SEC-REAUDIT-02): when a row was already advanced by child
 *         recovery (out of the from-status set), the scan is a no-op on it
 *         (count excludes it) — first-writer-wins idempotent.
 *
 * MANDATORY, CI-failing executable invariant. `.skip()` / `.todo()` /
 * `describe.skip` FORBIDDEN; failure is a P0 incident (pipeline-engineer).
 *
 * @see  §3.5 / §4.5 / §6 (INV-013)
 * @see  §A7.4
 * @see apps/mcp-server/src/services/worker-supervisor-lifecycle.service.ts (handleSecondarySpawnTimeout)
 * @module tests/regression/standing/worker-lifecycle/inv-backfill-secondary-spawn-timeout-terminal-013
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import { WorkerSupervisor } from "../../../../src/services/worker-supervisor.service";
import {
  SECONDARY_SPAWN_RETRY_CADENCE_MS,
  SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS,
} from "../../../../src/services/worker-supervisor-lifecycle.service";
import { VISION_UNLOAD_FINAL_TIMEOUT_MS } from "../../../../src/services/vision/vision-unload-handshake";
import {
  resetAuditLogService,
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
} from "../../../../src/services/audit-log.service";
import type { VisionPreconditionResult } from "../../../../src/services/vision/vision-unload-handshake";
import type { WorkerType } from "../../../../src/types/worker-type";
// SSOT-derive: assert against the SSOT constant, not a bare literal, so a
// rename surfaces as a CI failure (coupling-drift detection, LCC-IMPL-02).
// SSOT 定数経由で assert (bare literal 不可、coupling-drift 検出可能化)。
import { AUDIT_ACTION_BACKFILL_SECONDARY_SPAWN_TIMEOUT } from "../../../../src/audit/audit-actions";

const INV = "INV-BACKFILL-SECONDARY-SPAWN-TIMEOUT-TERMINAL-013";

/**
 * Fixed scan-time reference (host-clock-independent, testing-requirements §7
 * determinism pattern). The injected `nowFn` returns this so the time-anchor
 * (`startedAt < SCAN_NOW - 10min`) is deterministic regardless of how far the
 * fake retry-cadence timer advances the loop clock.
 */
const SCAN_NOW = 1_900_000_000_000;

const RESIDUAL: VisionPreconditionResult = {
  status: "vision_residual",
  sizeVramBytes: 11_403_141_120,
  modelName: "llama3.2-vision:11b",
  deferred: true,
};

interface FakeWebPageRow {
  id: string;
  embeddingBackfillStatus: string;
  embeddingBackfillStartedAt: Date | null;
  embeddingBackfillFailureReason: string | null;
}

/**
 * Fake Prisma modelling `web_pages.updateMany` with the CAS scan semantics:
 * `embeddingBackfillStatus IN (...)` + `embeddingBackfillStartedAt < lt`.
 */
function makeFakePrisma(rows: FakeWebPageRow[]): {
  client: unknown;
  state: FakeWebPageRow[];
  updateManySpy: ReturnType<typeof vi.fn>;
} {
  const state = rows.map((r) => ({ ...r }));
  // Plan v3 §V2.1 ruling (a)-narrowed: the give-up scan splits its single
  // `{ in: ['queued','in_progress'] }` updateMany into two from-status-scoped
  // updateMany — `embeddingBackfillStatus: "queued"` (plain string) and
  // `embeddingBackfillStatus: "in_progress"` (plain string). The mock therefore
  // models BOTH shapes: the legacy `{ in: [...] }` set AND a plain-string
  // from-status equality.
  const updateManySpy = vi.fn(
    async ({
      where,
      data,
    }: {
      where: {
        embeddingBackfillStatus?: { in?: string[] } | string;
        embeddingBackfillStartedAt?: { lt?: Date };
      };
      data: Record<string, unknown>;
    }) => {
      const statusWhere = where.embeddingBackfillStatus;
      const matchesStatus = (rowStatus: string): boolean => {
        if (typeof statusWhere === "string") return rowStatus === statusWhere;
        return (statusWhere?.in ?? []).includes(rowStatus);
      };
      const lt = where.embeddingBackfillStartedAt?.lt;
      let count = 0;
      for (const r of state) {
        if (!matchesStatus(r.embeddingBackfillStatus)) continue;
        if (lt !== undefined) {
          if (r.embeddingBackfillStartedAt === null) continue;
          if (!(r.embeddingBackfillStartedAt.getTime() < lt.getTime())) continue;
        }
        if (typeof data.embeddingBackfillStatus === "string") {
          r.embeddingBackfillStatus = data.embeddingBackfillStatus;
        }
        // `null` (clear) and `string` (set) are both modelled for the
        // failure-reason metadata; ignore `{ increment }` style objects.
        if ("embeddingBackfillFailureReason" in data) {
          const reason = data.embeddingBackfillFailureReason;
          if (typeof reason === "string" || reason === null) {
            r.embeddingBackfillFailureReason = reason;
          }
        }
        count += 1;
      }
      return { count };
    }
  );
  const client = { webPage: { updateMany: updateManySpy } };
  return { client, state, updateManySpy };
}

function lifecycleOf(supervisor: WorkerSupervisor): {
  scheduleSecondarySpawnRetry: (t: WorkerType) => void;
  setSecondarySpawnRetryDepsForTesting: (deps: {
    verifyVisionUnloadFn?: () => Promise<VisionPreconditionResult>;
    nowFn?: () => number;
  }) => void;
  secondarySpawnRetryTimer: unknown;
} {
  return supervisor.getLifecycle() as unknown as ReturnType<typeof lifecycleOf>;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Drive the retry timer to its bounded attempt cap (timeout path). */
async function advanceToTimeout(): Promise<void> {
  for (let i = 0; i < SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS; i++) {
    await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS);
    await flush();
  }
}

describe(`${INV}: fallback-on-absence scan-based terminal transition`, () => {
  let auditStub: { prisma: unknown; created: Array<Record<string, unknown>> };

  function makeSupervisorWithPrisma(prisma: unknown): WorkerSupervisor {
    const supervisor = new WorkerSupervisor({
      workerScript: "/dev/null",
      maxJobsBeforeRestart: 1,
      maxRestartAttempts: 1,
      shutdownTimeoutMs: 1000,
    });
    (
      supervisor as unknown as { setPrismaClientForTesting: (c: unknown) => void }
    ).setPrismaClientForTesting(prisma);
    // The secondary stays absent for the whole bound (probe always residual).
    // Inject a FIXED nowFn so the scan time-anchor is deterministic and
    // independent of how far the fake cadence timer advances (§7 pattern).
    const probe = vi.fn<[], Promise<VisionPreconditionResult>>().mockResolvedValue(RESIDUAL);
    lifecycleOf(supervisor).setSecondarySpawnRetryDepsForTesting({
      verifyVisionUnloadFn: probe,
      nowFn: () => SCAN_NOW,
    });
    return supervisor;
  }

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const created: Array<Record<string, unknown>> = [];
    auditStub = {
      created,
      prisma: {
        auditLog: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            created.push(data);
            return data;
          }),
        },
      },
    };
    setAuditLogPrismaClientFactory(() => auditStub.prisma as never);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // (c) SCAN-BASED END-TO-END: multiple stranded queued rows → all terminal
  // --------------------------------------------------------------------------
  it(`${INV}: (c) 10min timeout terminalizes ALL stranded queued rows (>10min) to failed_with_known_reason/supervisor_restart_orphan (Plan v3 ruling (a)-narrowed, recovery-IN)`, async () => {
    // Plan v3 §V2.1 ruling (a)-narrowed: `queued`-origin orphans (stranded by
    // worker-absence) now terminalize to `failed_with_known_reason` +
    // `supervisor_restart_orphan` (recovery-IN; the recovery handler re-enqueues
    // unconditionally → completed), NOT bare `failed` + `vision_unload_timeout`.
    const old = new Date(SCAN_NOW - VISION_UNLOAD_FINAL_TIMEOUT_MS - 60_000);
    const { client, state, updateManySpy } = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-00000000a001",
        embeddingBackfillStatus: "queued",
        embeddingBackfillStartedAt: old,
        embeddingBackfillFailureReason: null,
      },
      {
        id: "00000000-0000-7000-8000-00000000a002",
        embeddingBackfillStatus: "queued",
        embeddingBackfillStartedAt: old,
        embeddingBackfillFailureReason: null,
      },
    ]);
    const supervisor = makeSupervisorWithPrisma(client);

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    await advanceToTimeout();

    // The scan ran and terminalized both stranded queued rows (recovery-IN).
    expect(updateManySpy).toHaveBeenCalled();
    for (const r of state) {
      expect(r.embeddingBackfillStatus).toBe("failed_with_known_reason");
      expect(r.embeddingBackfillFailureReason).toBe("supervisor_restart_orphan");
    }
    // No stranded queued row remains (no permanent queued stall).
    expect(state.every((r) => r.embeddingBackfillStatus !== "queued")).toBe(true);

    // fail-loud emit (§A7.4.1 step 1, §A7.7).
    const actions = auditStub.created.map((d) => d.action);
    expect(actions).toContain(AUDIT_ACTION_BACKFILL_SECONDARY_SPAWN_TIMEOUT);
    // Timer cleared after timeout.
    expect(lifecycleOf(supervisor).secondarySpawnRetryTimer).toBeNull();
  });

  // --------------------------------------------------------------------------
  // FROM-STATUS 2-BRANCH (co-located): OLD queued-origin AND OLD in_progress-origin
  // rows are routed by from-status to their DISTINCT terminal contracts in the
  // SAME scan tick (Plan v3 §V2.1 ruling (a)-narrowed, SEC-REAUDIT-02 +
  // TPA-REAUDIT-02). This is the in_progress-origin half that the (c) test
  // (queued-origin only) and the in-flight test (recent in_progress, time-anchor
  // exclusion only) do NOT pin — closes TPA-IMPL-M-1 (the ruling's in_progress
  // branch was un-pinned for the OLD/>10min terminalization path).
  //
  // FROM-STATUS 2分岐 (co-located): OLD queued 起源と OLD in_progress 起源の row が
  // 同一 scan tick 内で from-status により各々の終端契約へ振り分けられることを pin。
  //   - queued 起源 (>10min) → failed_with_known_reason + supervisor_restart_orphan
  //     (recovery-IN、recovery handler が無条件 re-enqueue → completed)
  //   - in_progress 起源 (>10min) → bare failed + vision_unload_timeout
  //     (recovery-OUT、SEC-REAUDIT-02 race-window cover 契約温存)
  // (c) test は queued 半分のみ、in-flight test は recent(1min) in_progress の
  // time-anchor 除外のみを test しており、OLD(>10min) in_progress 起源が bare failed +
  // vision_unload_timeout へ終端化される半分が un-pinned だった (TPA-IMPL-M-1)。
  // --------------------------------------------------------------------------
  it(`${INV}: from-status 2-branch — OLD queued→failed_with_known_reason/supervisor_restart_orphan AND OLD in_progress→bare failed/vision_unload_timeout in the SAME scan (Plan v3 ruling (a)-narrowed, recovery-IN vs recovery-OUT, closes TPA-IMPL-M-1)`, async () => {
    const old = new Date(SCAN_NOW - VISION_UNLOAD_FINAL_TIMEOUT_MS - 60_000);
    const { client, state, updateManySpy } = makeFakePrisma([
      {
        // OLD queued-origin orphan (stranded by worker-absence) → recovery-IN.
        id: "00000000-0000-7000-8000-00000000e001",
        embeddingBackfillStatus: "queued",
        embeddingBackfillStartedAt: old,
        embeddingBackfillFailureReason: null,
      },
      {
        // OLD in_progress-origin (real vision-unload timeout) → recovery-OUT.
        id: "00000000-0000-7000-8000-00000000e002",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: old,
        embeddingBackfillFailureReason: null,
      },
    ]);
    const supervisor = makeSupervisorWithPrisma(client);

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    await advanceToTimeout();

    expect(updateManySpy).toHaveBeenCalled();

    const queuedOrigin = state.find((r) => r.id.endsWith("e001"));
    const inProgressOrigin = state.find((r) => r.id.endsWith("e002"));

    // queued-origin → recovery-IN terminal (re-enqueueable toward completed).
    // queued 起源 → recovery-IN 終端 (completed へ re-enqueue 可能)。
    expect(queuedOrigin?.embeddingBackfillStatus).toBe("failed_with_known_reason");
    expect(queuedOrigin?.embeddingBackfillFailureReason).toBe("supervisor_restart_orphan");

    // in_progress-origin → recovery-OUT terminal: bare `failed` +
    // `vision_unload_timeout` (SEC-REAUDIT-02 race-window cover preserved). This
    // is the assertion TPA-IMPL-M-1 flagged as missing. A mutation flipping the
    // in_progress branch to failed_with_known_reason/supervisor_restart_orphan
    // would FAIL these two assertions (non-vacuous, mutation-load-bearing).
    // in_progress 起源 → recovery-OUT 終端: bare failed + vision_unload_timeout
    // (SEC-REAUDIT-02 契約温存)。in_progress branch を recovery-IN reason に変える
    // mutation は以下 2 assertion で fail する (非 vacuous)。
    expect(inProgressOrigin?.embeddingBackfillStatus).toBe("failed");
    expect(inProgressOrigin?.embeddingBackfillFailureReason).toBe("vision_unload_timeout");

    // Cross-branch leakage guard: the recovery-OUT row must NOT acquire the
    // recovery-IN reason, and the recovery-IN row must NOT acquire the
    // recovery-OUT reason. Pins that the two branches never cross-contaminate.
    // クロス分岐汚染ガード: recovery-OUT row が recovery-IN reason を、recovery-IN
    // row が recovery-OUT reason を取得しないことを pin (2分岐が交差しない)。
    expect(inProgressOrigin?.embeddingBackfillFailureReason).not.toBe("supervisor_restart_orphan");
    expect(queuedOrigin?.embeddingBackfillFailureReason).not.toBe("vision_unload_timeout");

    // Both rows left the {queued,in_progress} from-status set (no permanent stall).
    // 両 row が {queued,in_progress} を脱した (恒久 stall 無し)。
    expect(state.every((r) => r.embeddingBackfillStatus !== "queued")).toBe(true);
    expect(state.every((r) => r.embeddingBackfillStatus !== "in_progress")).toBe(true);

    // Aggregate terminalizedCount = queued(1) + in_progress(1) = 2.
    // 集計 terminalizedCount = queued(1) + in_progress(1) = 2。
    const timeoutAudit = auditStub.created.find(
      (d) => d.action === AUDIT_ACTION_BACKFILL_SECONDARY_SPAWN_TIMEOUT
    );
    expect(timeoutAudit).toBeDefined();
    const details = timeoutAudit?.details as { terminalizedCount?: number } | undefined;
    expect(details?.terminalizedCount).toBe(2);
  });

  // --------------------------------------------------------------------------
  // CAS STATUS-SET: in-flight (<10min) rows NOT terminalized
  // --------------------------------------------------------------------------
  it(`${INV}: in-flight (<10min) row is NOT terminalized (time-anchor excludes it)`, async () => {
    const old = new Date(SCAN_NOW - VISION_UNLOAD_FINAL_TIMEOUT_MS - 60_000);
    const recent = new Date(SCAN_NOW - 60_000); // 1min old → in-flight
    const { client, state } = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-00000000b001",
        embeddingBackfillStatus: "queued",
        embeddingBackfillStartedAt: old,
        embeddingBackfillFailureReason: null,
      },
      {
        id: "00000000-0000-7000-8000-00000000b002",
        embeddingBackfillStatus: "in_progress",
        embeddingBackfillStartedAt: recent,
        embeddingBackfillFailureReason: null,
      },
    ]);
    const supervisor = makeSupervisorWithPrisma(client);

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    await advanceToTimeout();

    const stranded = state.find((r) => r.id.endsWith("b001"));
    const inflight = state.find((r) => r.id.endsWith("b002"));
    // Plan v3 ruling (a)-narrowed: queued-origin stranded → recovery-IN terminal.
    expect(stranded?.embeddingBackfillStatus).toBe("failed_with_known_reason");
    expect(stranded?.embeddingBackfillFailureReason).toBe("supervisor_restart_orphan");
    // In-flight (<10min) row unchanged — NOT falsely terminalized.
    expect(inflight?.embeddingBackfillStatus).toBe("in_progress");
    expect(inflight?.embeddingBackfillFailureReason).toBeNull();
  });

  // --------------------------------------------------------------------------
  // RACE WINDOW: already-advanced row dropped from from-status set (no-op)
  // --------------------------------------------------------------------------
  it(`${INV}: a row already advanced past the from-status set is a no-op (CAS first-writer-wins)`, async () => {
    const old = new Date(SCAN_NOW - VISION_UNLOAD_FINAL_TIMEOUT_MS - 60_000);
    // Row was already completed by child recovery before the scan fired.
    const { client, state, updateManySpy } = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-00000000c001",
        embeddingBackfillStatus: "completed",
        embeddingBackfillStartedAt: old,
        embeddingBackfillFailureReason: null,
      },
    ]);
    const supervisor = makeSupervisorWithPrisma(client);

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    await advanceToTimeout();

    // Scan ran but the completed row is outside {queued,in_progress} → untouched.
    expect(updateManySpy).toHaveBeenCalled();
    expect(state[0]?.embeddingBackfillStatus).toBe("completed");
    // terminalizedCount = 0 reported in the audit details (no-op observability).
    const timeoutAudit = auditStub.created.find(
      (d) => d.action === AUDIT_ACTION_BACKFILL_SECONDARY_SPAWN_TIMEOUT
    );
    expect(timeoutAudit).toBeDefined();
    const details = timeoutAudit?.details as { terminalizedCount?: number } | undefined;
    expect(details?.terminalizedCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // CAS STATUS-SET pin: emitted audit details are PII-free numeric/enum
  // --------------------------------------------------------------------------
  it(`${INV}: timeout audit details are PII-free numeric/enum (attemptCount/elapsedMs/finalProbeStatus/terminalizedCount)`, async () => {
    const old = new Date(SCAN_NOW - VISION_UNLOAD_FINAL_TIMEOUT_MS - 60_000);
    const { client } = makeFakePrisma([
      {
        id: "00000000-0000-7000-8000-00000000d001",
        embeddingBackfillStatus: "queued",
        embeddingBackfillStartedAt: old,
        embeddingBackfillFailureReason: null,
      },
    ]);
    const supervisor = makeSupervisorWithPrisma(client);

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    await advanceToTimeout();

    const timeoutAudit = auditStub.created.find(
      (d) => d.action === AUDIT_ACTION_BACKFILL_SECONDARY_SPAWN_TIMEOUT
    );
    expect(timeoutAudit?.targetType).toBe("web_page");
    const details = timeoutAudit?.details as Record<string, unknown> | undefined;
    expect(typeof details?.attemptCount).toBe("number");
    expect(typeof details?.elapsedMs).toBe("number");
    expect(["vision_residual", "probe_failed"]).toContain(details?.finalProbeStatus);
    expect(typeof details?.terminalizedCount).toBe("number");
    // The scan terminalized the single stranded queued row.
    expect(details?.terminalizedCount).toBe(1);
    expect(details?.attemptCount).toBe(SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS);
  });
});
