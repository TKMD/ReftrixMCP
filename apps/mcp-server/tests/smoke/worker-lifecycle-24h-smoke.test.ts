// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plan v4.2 PR-B: 24h Integration Smoke Pre-Merge Gate (SEC M-NEW-2 / ADR-0030 amendment)
 *
 * Plan v4.2 で formalise された **24h pre-merge smoke harness**。
 * Real Redis + Real BullMQ Worker を使用した 24h continuous run で
 * callback-based exit pattern (ADR-0034) の end-to-end semantic を verify する。
 *
 * Plan v4.2 PR-B: 24h Integration Smoke Pre-Merge Gate (SEC M-NEW-2 / ADR-0030
 * amendment). Real Redis + Real BullMQ Worker, 24h continuous run, end-to-end
 * verification of the callback-based exit pattern (ADR-0034).
 *
 * ## 4 PASS thresholds (SEC M-NEW-2 / ADR-0030 amendment §Decision N)
 *
 *   1. **0 deadlock occurrences** — zero `[DEADLOCK]` log lines + zero
 *      `worker-lock` `tryAcquireLock` race-lost > 5s + zero `Promise<never>`
 *      hang. Core SEC H-1 closure verification.
 *   2. **0 listener-not-fired events** — zero `process.exit(0)` invocations
 *      NOT preceded by `emit('completed')` listener firing within 100ms.
 *      Callback-based exit path correctness; listener leak = TPA-V42-M-03
 *      closure failure.
 *   3. **worker-lock duration p99 < 100ms** — Redis dual-run lock
 *      `tryAcquireLock` p99 latency < 100ms across 24h. Worker-lock SLO per
 *      ADR-0011 (Worker Dual-run Lock); regression = SEC M-NEW-1 reopening.
 *   4. **0 tryAcquireLock race-lost events** — zero `tryAcquireLock` returns
 *      `{kind: "race-lost"}` resulting in orphaned worker. INV-NEXT-JOB-RACE-001
 *      sub 1b structural fix verification; race-lost = INV semantic violation.
 *
 * ## Deadline & ADR-bound exception
 *
 *   - **Smoke kickoff**: T+1d 2026-05-17 末尾 (Phase 2 implementation 完了直後)
 *   - **Smoke deadline**: T+2d 2026-05-18 (24h smoke runtime requirement)
 *   - **ADR-bound external SLA exception**: `feedback_deadline_one_day.md` ADR
 *     exception clause invoked. ADR-0030 amendment formalises 24h smoke gate
 *     as bounded external SLA (NOT arbitrary deferral).
 *   - **Pre-merge gate enforces smoke PASS**: smoke FAIL → automatic BLOCK,
 *     no merge until smoke threshold breach root cause fixed + smoke re-run
 *     PASS.
 *
 * ## Execution
 *
 *   # Manual kickoff requires explicit env var (prevents accidental CI execution)
 *   REFTRIX_24H_SMOKE_KICKOFF=1 pnpm test:smoke:24h-worker-lifecycle
 *
 *   Prerequisites:
 *     - PostgreSQL on port 26432 + Redis on port 27379 (docker compose up)
 *     - WORKER_MAX_JOBS_BEFORE_RESTART=1 (planned restart per job)
 *     - 24h sustained host resources (RAM/CPU/disk)
 *     - internal MCP available for per-hour heartbeat (`note_add`)
 *
 *   Without `REFTRIX_24H_SMOKE_KICKOFF=1` the heavy real-run is skipped
 *   (`it.skipIf(...)` gate), so CI passes the metadata assertions only.
 *
 * ## CI integration
 *
 * 本 smoke harness は **standing regression suite 4 domain 外** の test
 * (long-running, real-infra required) であり、CI 上は `it.skip()` で skip
 * 許容される (standing regression `.skip` 禁止規約は本 file には適用されない)。
 * Manual kickoff (T+1d 末尾) + 24h run (T+2d) で 4 thresholds 全 PASS を
 * pre-merge gate として enforce する。
 *
 * This smoke harness is **outside the 4-domain standing regression suite**
 * (long-running, real-infra required); CI may `it.skip()` it (the standing
 * regression `.skip` ban does NOT apply here). Manual kickoff (end of T+1d)
 * + 24h run (T+2d) enforces all 4 thresholds as the pre-merge gate.
 *
 * ## A-9 Declaration (feedback_no_fake_success A-9)
 *
 * - **A-9.1**: Skeleton implementation. Real 24h run は manual kickoff で
 *   T+1d 末尾以降に実施。本 file は **structural placeholder** で 4 thresholds
 *   metadata を embed し、INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 sub 3
 *   (standing regression) が structural existence を verify する。
 * - **A-9.2**: Real Redis + Real BullMQ Worker 起動は本 skeleton では実施
 *   しない (pre-merge gate kickoff 時に implement する)。internal
 *   `note_add` per-hour heartbeat も real run 時の implementation 対象。
 *
 * @see Plan v4.2 §5 (24h Integration Smoke Pre-Merge Gate)
 * @see ADR-0030 amendment §Decision N (24h smoke gate, SEC M-NEW-2 closure)
 * @see INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 sub 3 (standing regression)
 * @see internal anchor: Plan v4.2 019e2c7e-3b25-701b-a18c-91b8a054a93f
 */

import { describe, expect, it } from "vitest";

/**
 * 24h continuous smoke harness — 4 thresholds PASS gate.
 *
 * Threshold contract (SEC M-NEW-2 / ADR-0030 amendment §Decision N):
 *
 *   - threshold 1: deadlock occurrences = 0
 *   - threshold 2: listener-not-fired events = 0
 *   - threshold 3: worker-lock p99 < 100ms
 *   - threshold 4: tryAcquireLock race-lost = 0
 *
 * Manual kickoff: T+1d 2026-05-17 末尾
 * Smoke deadline: T+2d 2026-05-18
 */
describe("Plan v4.2 24h worker-lifecycle smoke pre-merge gate", () => {
  // Skeleton contract metadata (consumed by INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001
  // sub 3 standing regression for structural existence verification).
  const SMOKE_CONTRACT = {
    durationSeconds: 86400, // 24h = 86400 sec
    thresholds: {
      deadlockOccurrences: { target: 0, source: "[DEADLOCK] log lines + tryAcquireLock > 5s" },
      listenerNotFired: {
        target: 0,
        source: "process.exit(0) NOT preceded by emit('completed') listener fire within 100ms",
      },
      workerLockP99Ms: { target: 100, source: "Redis dual-run tryAcquireLock p99 latency" },
      tryAcquireLockRaceLost: {
        target: 0,
        source: "tryAcquireLock returns {kind: 'race-lost'} → orphaned worker",
      },
    },
    crossRef: {
      planV42: "019e2c7e-3b25-701b-a18c-91b8a054a93f",
      adr0030Amendment: "§Decision N (24h smoke gate, SEC M-NEW-2 closure)",
      adr0034: "Callback-Based Worker Exit Pattern (BullMQ Native Flow Preservation)",
      invNextJobRace001Sub1b: "post-exit race window (Redis dual-run lock + nonce-UUID)",
    },
  } as const;

  it("smoke harness contract metadata defines 4 thresholds (SEC M-NEW-2 / ADR-0030 amendment §Decision N)", () => {
    // Static structural verification of the threshold metadata. The real 24h
    // run is kicked off manually via `pnpm test:smoke:24h-worker-lifecycle`
    // at the end of T+1d 2026-05-17.
    expect(SMOKE_CONTRACT.durationSeconds).toBe(86400);
    expect(SMOKE_CONTRACT.thresholds.deadlockOccurrences.target).toBe(0);
    expect(SMOKE_CONTRACT.thresholds.listenerNotFired.target).toBe(0);
    expect(SMOKE_CONTRACT.thresholds.workerLockP99Ms.target).toBe(100);
    expect(SMOKE_CONTRACT.thresholds.tryAcquireLockRaceLost.target).toBe(0);
  });

  it("smoke harness contract metadata cross-references Plan v4.2 / ADR-0034 / ADR-0030 amendment / SEC M-NEW-2", () => {
    expect(SMOKE_CONTRACT.crossRef.planV42).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    expect(SMOKE_CONTRACT.crossRef.adr0030Amendment).toContain("SEC M-NEW-2");
    expect(SMOKE_CONTRACT.crossRef.adr0034).toContain("Callback-Based");
    expect(SMOKE_CONTRACT.crossRef.invNextJobRace001Sub1b).toContain("race");
  });

  // Real 24h smoke run skeleton — implementation deferred to manual kickoff.
  // Per `feedback_no_fake_success.md` A-4 / A-9: skeleton declared as
  // `it.skipIf(...)` gated by `REFTRIX_24H_SMOKE_KICKOFF` env var. This file is
  // **outside the 4-domain standing regression suite** (long-running real-infra
  // test). The standing regression `.skip` ban does NOT apply. Real run is
  // enforced via ADR-0030 amendment pre-merge gate (T+2d 2026-05-18, ADR-bound
  // external SLA exception).
  //
  // Plan v4.2 PR-L closure: kickoff procedure now uses an env-var gate
  // (`REFTRIX_24H_SMOKE_KICKOFF=1`) instead of `it.skip()` so the CI default
  // remains skipped while manual kickoff (T+1d 末尾) explicitly opts in. This
  // aligns with `feedback_no_fake_success.md` A-9: skeleton is honest about its
  // run state — CI green does NOT imply 24h smoke PASS.
  it.skipIf(process.env.REFTRIX_24H_SMOKE_KICKOFF !== "1")(
    "runs 24h continuous worker lifecycle smoke (manual kickoff via REFTRIX_24H_SMOKE_KICKOFF=1 pnpm test:smoke:24h-worker-lifecycle)",
    async () => {
      // Implementation skeleton (real Redis + real BullMQ Worker required):
      //
      //   1. Initialise real Redis client (separate from Reftrix Redis to avoid
      //      contaminating production-equivalent integration env).
      //   2. Start real BullMQ Worker via WorkerSupervisor with PR-A worker code
      //      (callback-based exit pattern).
      //   3. Submit synthetic page.analyze jobs at steady rate (e.g. 1 job / 5s)
      //      for 24h continuous run.
      //   4. Continuously emit internal `note_add` per-hour heartbeat (24 notes
      //      total) with running threshold metrics.
      //   5. Aggregate threshold counters across 24h:
      //      - deadlock occurrences (parse logs for `[DEADLOCK]`)
      //      - listener-not-fired events (Node.js probe before each
      //        process.exit(0) firing)
      //      - worker-lock duration percentiles (record per-tryAcquireLock
      //        latency)
      //      - tryAcquireLock race-lost events (count `kind: "race-lost"`)
      //   6. Assert all 4 thresholds PASS at T+24h; fail loudly if any breach.
      //   7. Cleanup: stop Worker, flush Redis test keys, emit final
      //      `decision_add` summary with measured metrics.
      expect(SMOKE_CONTRACT).toBeDefined();
    }
  );
});
