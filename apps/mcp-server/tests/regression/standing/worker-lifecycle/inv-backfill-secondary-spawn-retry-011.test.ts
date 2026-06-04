// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-BACKFILL-SECONDARY-SPAWN-RETRY-011 (Plan v2 §6 / ADR-0011 Amendment 7
 * §A7.2-§A7.6):
 *
 *   The supervisor's deferred secondary-spawn bounded retry timer. When the
 *   Vision-unload precondition defers the `embedding-backfill` secondary spawn
 *   (Vision residual / probe failure), the supervisor schedules a bounded retry
 *   timer (30s cadence, 20-attempt cap = ceil(10min/30s)) that re-probes Vision
 *   via a DI seam and spawns once Vision unloads. This closes the timing gap
 *   where a single `page.analyze` call left the consumer worker permanently
 *   un-started (MEMORY.md #162, H severity).
 *
 *   Contract (this INV pins):
 *     (a) STATE-ACTION (T1-aligned, TDA-REAUDIT-02): the retry tick spawns the
 *         secondary via `ensureWorkerRunningForType("embedding-backfill")`
 *         exactly once when Vision unloads. The spawn-eligible states per
 *         `worker-supervisor.service.ts:757-774` are `idle` + `crashed`
 *         (auto-reset → spawn); `stopped` / `running` / `restarting` are no-op
 *         (early-return at :757-759). The retry tick stops re-probing once the
 *         secondary is `running`.
 *     (b) PROBE 3-STRIKE (§A7.6): three consecutive `probe_failed` outcomes emit
 *         `vision_probe_unavailable` and block the retry (no infinite retry);
 *         `vision_residual` resets the streak.
 *     (c) RE-ENTRY GUARD (per-supervisor singleton): a second
 *         `scheduleSecondarySpawnRetry` call while a timer is active is a no-op
 *         (no second timer). Bounded attempt counter
 *         `SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS = 20` (CWE-770).
 *     (d) TIMER LEAK GUARD (CWE-400): the facade `shutdown()` clears the retry
 *         timer (clearInterval) AND the callback-head `isShuttingDownNow()`
 *         guard stops the tick — double defense, asserted via the facade.
 *     (e) DI SEAM (deterministic): the Vision probe is injected via
 *         `setSecondarySpawnRetryDepsForTesting({ verifyVisionUnloadFn, nowFn })`
 *         (canonical precedent `backfill-recovery-reconciliation.service.ts:184`),
 *         driving `vision_residual → vision_unloaded` without a live Ollama probe.
 *
 * MANDATORY, CI-failing executable invariant. `.skip()` / `.todo()` /
 * `describe.skip` FORBIDDEN; failure is a P0 incident (pipeline-engineer).
 *
 * @see  §6 (INV-011)
 * @see  §A7.2-§A7.6
 * @see apps/mcp-server/src/services/worker-supervisor-lifecycle.service.ts
 * @module tests/regression/standing/worker-lifecycle/inv-backfill-secondary-spawn-retry-011
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import { WorkerSupervisor } from "../../../../src/services/worker-supervisor.service";
import {
  SECONDARY_SPAWN_RETRY_CADENCE_MS,
  SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS,
  SECONDARY_SPAWN_RETRY_PROBE_FAILED_STRIKE_LIMIT,
  SECONDARY_SPAWN_RETRY_TIMEOUT_MS,
} from "../../../../src/services/worker-supervisor-lifecycle.service";
import {
  VISION_RESIDUAL_BACKFILL_ENQUEUE_DELAY_MS,
  VISION_UNLOAD_FINAL_TIMEOUT_MS,
  type VisionPreconditionResult,
} from "../../../../src/services/vision/vision-unload-handshake";
// SSOT-derive: assert against the SSOT constant, not a bare literal, so a
// rename surfaces as a CI failure (coupling-drift detection, LCC-IMPL-02).
// SSOT 定数経由で assert (bare literal 不可、coupling-drift 検出可能化)。
import { AUDIT_ACTION_VISION_PROBE_UNAVAILABLE } from "../../../../src/audit/audit-actions";
import {
  resetAuditLogService,
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
} from "../../../../src/services/audit-log.service";
import type { WorkerType } from "../../../../src/types/worker-type";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const LIFECYCLE_SRC = path.join(
  REPO_ROOT,
  "apps/mcp-server/src/services/worker-supervisor-lifecycle.service.ts"
);
const FACADE_SRC = path.join(
  REPO_ROOT,
  "apps/mcp-server/src/services/worker-supervisor.service.ts"
);

const INV = "INV-BACKFILL-SECONDARY-SPAWN-RETRY-011";

// ----------------------------------------------------------------------------
// Probe result fixtures (discriminated union from the SSOT module)
// ----------------------------------------------------------------------------
const UNLOADED: VisionPreconditionResult = { status: "vision_unloaded", sizeVramBytes: 0 };
const RESIDUAL: VisionPreconditionResult = {
  status: "vision_residual",
  sizeVramBytes: 11_403_141_120,
  modelName: "llama3.2-vision:11b",
  deferred: true,
};
const PROBE_FAILED: VisionPreconditionResult = {
  status: "probe_failed",
  error: "probe timeout",
  failClosed: true,
};

/** Minimal audit Prisma stub so emit paths never throw. */
function makeAuditStub(): { prisma: unknown; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
  };
  return { prisma, created };
}

function makeSupervisor(): WorkerSupervisor {
  return new WorkerSupervisor({
    workerScript: "/dev/null",
    maxJobsBeforeRestart: 1,
    maxRestartAttempts: 1,
    shutdownTimeoutMs: 1000,
  });
}

/** Access the lifecycle instance with its retry surface for white-box tests. */
function lifecycleOf(supervisor: WorkerSupervisor): {
  scheduleSecondarySpawnRetry: (t: WorkerType) => void;
  clearSecondarySpawnRetryTimer: () => void;
  setSecondarySpawnRetryDepsForTesting: (deps: {
    verifyVisionUnloadFn?: () => Promise<VisionPreconditionResult>;
    nowFn?: () => number;
  }) => void;
  secondarySpawnRetryTimer: unknown;
} {
  return supervisor.getLifecycle() as unknown as ReturnType<typeof lifecycleOf>;
}

/** Flush queued microtasks/macrotasks deterministically under fake timers. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe(`${INV}: deferred secondary-spawn bounded retry`, () => {
  let auditStub: ReturnType<typeof makeAuditStub>;

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    auditStub = makeAuditStub();
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
  // (e) DI SEAM — derived constants (no new magic numbers)
  // --------------------------------------------------------------------------
  it(`${INV}: (e) retry constants derive from the Vision-unload SSOT (cadence=30s, timeout=10min, maxAttempts=ceil=20)`, () => {
    expect(SECONDARY_SPAWN_RETRY_CADENCE_MS).toBe(VISION_RESIDUAL_BACKFILL_ENQUEUE_DELAY_MS);
    expect(SECONDARY_SPAWN_RETRY_TIMEOUT_MS).toBe(VISION_UNLOAD_FINAL_TIMEOUT_MS);
    expect(SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS).toBe(
      Math.ceil(SECONDARY_SPAWN_RETRY_TIMEOUT_MS / SECONDARY_SPAWN_RETRY_CADENCE_MS)
    );
    expect(SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS).toBe(20);
    expect(Number.isFinite(SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS)).toBe(true);
    expect(SECONDARY_SPAWN_RETRY_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(SECONDARY_SPAWN_RETRY_PROBE_FAILED_STRIKE_LIMIT).toBe(3);
  });

  // --------------------------------------------------------------------------
  // (a) STATE-ACTION — residual then unloaded spawns exactly once
  // --------------------------------------------------------------------------
  it(`${INV}: (a) retry spawns the secondary exactly once after vision_residual → vision_unloaded (idle state)`, async () => {
    const supervisor = makeSupervisor();
    const ensureSpy = vi
      .spyOn(
        supervisor as unknown as { ensureWorkerRunningForType: (t: WorkerType) => void },
        "ensureWorkerRunningForType"
      )
      .mockImplementation(() => {});

    const probe = vi
      .fn<[], Promise<VisionPreconditionResult>>()
      .mockResolvedValueOnce(RESIDUAL)
      .mockResolvedValueOnce(RESIDUAL)
      .mockResolvedValue(UNLOADED);
    lifecycleOf(supervisor).setSecondarySpawnRetryDepsForTesting({ verifyVisionUnloadFn: probe });

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");

    // Tick 1: residual → no spawn.
    await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS);
    await flush();
    expect(ensureSpy).not.toHaveBeenCalled();

    // Tick 2: residual → still no spawn.
    await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS);
    await flush();
    expect(ensureSpy).not.toHaveBeenCalled();

    // Tick 3: unloaded → spawn exactly once + timer cleared.
    await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS);
    await flush();
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(ensureSpy).toHaveBeenCalledWith("embedding-backfill");
    expect(lifecycleOf(supervisor).secondarySpawnRetryTimer).toBeNull();

    // Idempotency: further ticks do not re-spawn (timer is gone).
    await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS * 5);
    await flush();
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it(`${INV}: (a) retry stops re-probing once the secondary is already 'running' (running state no-op)`, async () => {
    const supervisor = makeSupervisor();
    // Force the secondary into 'running' so the tick's state guard fires.
    (supervisor as unknown as { getStateForType: (t: WorkerType) => string }).getStateForType = ((
      t: WorkerType
    ) => (t === "embedding-backfill" ? "running" : "idle")) as never;

    const ensureSpy = vi
      .spyOn(
        supervisor as unknown as { ensureWorkerRunningForType: (t: WorkerType) => void },
        "ensureWorkerRunningForType"
      )
      .mockImplementation(() => {});
    const probe = vi.fn<[], Promise<VisionPreconditionResult>>().mockResolvedValue(UNLOADED);
    lifecycleOf(supervisor).setSecondarySpawnRetryDepsForTesting({ verifyVisionUnloadFn: probe });

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS);
    await flush();

    // running → tick returns early, never probes, never spawns, timer cleared.
    expect(probe).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(lifecycleOf(supervisor).secondarySpawnRetryTimer).toBeNull();
  });

  // --------------------------------------------------------------------------
  // (b) PROBE 3-STRIKE — 3 consecutive probe_failed → block + emit
  // --------------------------------------------------------------------------
  it(`${INV}: (b) three consecutive probe_failed emit vision_probe_unavailable and block the retry`, async () => {
    const supervisor = makeSupervisor();
    const ensureSpy = vi
      .spyOn(
        supervisor as unknown as { ensureWorkerRunningForType: (t: WorkerType) => void },
        "ensureWorkerRunningForType"
      )
      .mockImplementation(() => {});
    const probe = vi.fn<[], Promise<VisionPreconditionResult>>().mockResolvedValue(PROBE_FAILED);
    lifecycleOf(supervisor).setSecondarySpawnRetryDepsForTesting({ verifyVisionUnloadFn: probe });

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");

    // 3 ticks of probe_failed → block on the 3rd.
    for (let i = 0; i < SECONDARY_SPAWN_RETRY_PROBE_FAILED_STRIKE_LIMIT; i++) {
      await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS);
      await flush();
    }

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(lifecycleOf(supervisor).secondarySpawnRetryTimer).toBeNull();
    const emitted = auditStub.created.map((d) => d.action);
    expect(emitted).toContain(AUDIT_ACTION_VISION_PROBE_UNAVAILABLE);

    // Blocked: no further probes after the timer cleared.
    const probeCallsAfterBlock = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS * 3);
    await flush();
    expect(probe.mock.calls.length).toBe(probeCallsAfterBlock);
  });

  it(`${INV}: (b) vision_residual resets the probe_failed streak (no premature block)`, async () => {
    const supervisor = makeSupervisor();
    const ensureSpy = vi
      .spyOn(
        supervisor as unknown as { ensureWorkerRunningForType: (t: WorkerType) => void },
        "ensureWorkerRunningForType"
      )
      .mockImplementation(() => {});
    // failed, failed, residual (reset), failed, then unloaded → spawn (no block).
    const probe = vi
      .fn<[], Promise<VisionPreconditionResult>>()
      .mockResolvedValueOnce(PROBE_FAILED)
      .mockResolvedValueOnce(PROBE_FAILED)
      .mockResolvedValueOnce(RESIDUAL)
      .mockResolvedValueOnce(PROBE_FAILED)
      .mockResolvedValue(UNLOADED);
    lifecycleOf(supervisor).setSecondarySpawnRetryDepsForTesting({ verifyVisionUnloadFn: probe });

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS);
      await flush();
    }

    // The residual at tick 3 reset the streak so no vision_probe_unavailable.
    const emitted = auditStub.created.map((d) => d.action);
    expect(emitted).not.toContain(AUDIT_ACTION_VISION_PROBE_UNAVAILABLE);
    expect(ensureSpy).toHaveBeenCalledWith("embedding-backfill");
  });

  // --------------------------------------------------------------------------
  // (c) RE-ENTRY GUARD — per-supervisor singleton
  // --------------------------------------------------------------------------
  it(`${INV}: (c) a second scheduleSecondarySpawnRetry while active is a no-op (singleton timer)`, async () => {
    const supervisor = makeSupervisor();
    const probe = vi.fn<[], Promise<VisionPreconditionResult>>().mockResolvedValue(RESIDUAL);
    lifecycleOf(supervisor).setSecondarySpawnRetryDepsForTesting({ verifyVisionUnloadFn: probe });

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    const firstTimer = lifecycleOf(supervisor).secondarySpawnRetryTimer;
    expect(firstTimer).not.toBeNull();

    // Second schedule must NOT replace / duplicate the timer.
    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    expect(lifecycleOf(supervisor).secondarySpawnRetryTimer).toBe(firstTimer);

    // Exactly one probe per cadence (single timer, not two).
    await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS);
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);

    lifecycleOf(supervisor).clearSecondarySpawnRetryTimer();
  });

  // --------------------------------------------------------------------------
  // (d) TIMER LEAK GUARD — facade shutdown clears the timer (CWE-400)
  // --------------------------------------------------------------------------
  it(`${INV}: (d) facade shutdown() clears the retry timer (CWE-400 leak defense layer 2)`, async () => {
    const supervisor = makeSupervisor();
    const probe = vi.fn<[], Promise<VisionPreconditionResult>>().mockResolvedValue(RESIDUAL);
    lifecycleOf(supervisor).setSecondarySpawnRetryDepsForTesting({ verifyVisionUnloadFn: probe });

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    expect(lifecycleOf(supervisor).secondarySpawnRetryTimer).not.toBeNull();

    await supervisor.shutdown();
    expect(lifecycleOf(supervisor).secondarySpawnRetryTimer).toBeNull();
  });

  it(`${INV}: (d) callback-head isShuttingDownNow() guard stops the tick (layer 1)`, async () => {
    const supervisor = makeSupervisor();
    const probe = vi.fn<[], Promise<VisionPreconditionResult>>().mockResolvedValue(UNLOADED);
    const ensureSpy = vi
      .spyOn(
        supervisor as unknown as { ensureWorkerRunningForType: (t: WorkerType) => void },
        "ensureWorkerRunningForType"
      )
      .mockImplementation(() => {});
    lifecycleOf(supervisor).setSecondarySpawnRetryDepsForTesting({ verifyVisionUnloadFn: probe });

    lifecycleOf(supervisor).scheduleSecondarySpawnRetry("embedding-backfill");
    // Flip shutting-down BEFORE the first tick fires.
    (supervisor as unknown as { isShuttingDown: boolean }).isShuttingDown = true;

    await vi.advanceTimersByTimeAsync(SECONDARY_SPAWN_RETRY_CADENCE_MS);
    await flush();

    // Tick saw shutdown at the head → no probe, no spawn, timer cleared.
    expect(probe).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(lifecycleOf(supervisor).secondarySpawnRetryTimer).toBeNull();
  });

  // --------------------------------------------------------------------------
  // (a)/(c) SOURCE-PIN — state-action set + singleton structure (T1 coupling)
  // --------------------------------------------------------------------------
  it(`${INV}: (a) lifecycle source routes the Vision probe through the DI seam (this.verifyVisionUnloadFn)`, () => {
    const src = readFileSync(LIFECYCLE_SRC, "utf-8");
    // The staggered spawn path must call the DI seam, not the raw import.
    expect(src).toMatch(/this\.verifyVisionUnloadFn\(\)/);
    expect(src).toContain("scheduleSecondarySpawnRetry");
  });

  it(`${INV}: (d) facade shutdown() source binds clearSecondarySpawnRetryTimer`, () => {
    const src = readFileSync(FACADE_SRC, "utf-8");
    const fnStart = src.indexOf("async shutdown()");
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = src.slice(fnStart, fnStart + 1500);
    expect(fnBody).toContain("clearSecondarySpawnRetryTimer");
  });
});
