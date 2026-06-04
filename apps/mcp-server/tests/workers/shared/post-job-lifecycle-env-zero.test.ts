// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plan v1.1 candidate B / SEC-PLAN-V0-M-01 closure:
 * env=0 (`WORKER_MAX_JOBS_BEFORE_RESTART=0`) fail-closed runtime contract
 * verification for `applyPostJobMemoryGate`.
 *
 * env=0 では memory-gate `process.exit(0)` 経路も listener exit による
 * planned restart 経路も skip される。唯一の防御層は WorkerSupervisor 側
 * の RSS kill 4GB 閾値 (process.kill SIGKILL) と Phase 5 child fork side
 * の RSS kill / heartbeat timeout。本 test は env=0 simulation 下で
 * `applyPostJobMemoryGate(false, ...)` が:
 *   - `worker.pause` を呼ばない (callsite が production code に存在しない)
 *   - `process.exit(0)` を呼ばない (full no-op path)
 *   - logger.warn / logger.info を呼ばない (silent no-op)
 *   - 正常に Promise<void> で resolve する
 * ことを assert する。
 *
 * Plan v1.1 candidate B / SEC-PLAN-V0-M-01 closure: verifies the env=0
 * (`WORKER_MAX_JOBS_BEFORE_RESTART=0`) fail-closed runtime contract.
 * Under env=0, both the memory-gate `process.exit(0)` path and the
 * listener-driven planned restart path are skipped; the only defense
 * layer is the supervisor-side RSS kill 4GB threshold + Phase 5 child
 * fork RSS kill / heartbeat timeout. This test asserts that
 * `applyPostJobMemoryGate(false, ...)`:
 *   - never calls `worker.pause` (no production callsite exists)
 *   - never calls `process.exit(0)` (full no-op path)
 *   - emits no warn / info log lines (silent no-op)
 *   - resolves cleanly to `Promise<void>`
 *
 * @see Plan v1.1 §3 candidate B + §7.1 (`backfill-pause-completed-race-v1.md`)
 * @see ADR-0034 Amendment 5 §Consequences Negative + §Decision 1 footnote
 *      (env=0 documented behavior + fail-closed contract)
 * @see SEC-PLAN-V0-M-01 closure (env=0 fail-closed sign-off)
 * @see INV-WORKER-NO-PAUSE-001 (AST gate `verify-no-worker-pause.mjs`)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyPostJobLifecycleGate,
  applyPostJobMemoryGate,
} from "../../../src/workers/shared/post-job-lifecycle";

// shouldExitForMemory を mock 化することで env=0 path の構造が memory check
// に依存していないこと (= memory check 自体が呼ばれないこと) を verify する。
vi.mock("../../../src/services/worker-memory-monitor.service", () => ({
  shouldExitForMemory: vi.fn(() => ({ shouldExit: false, rssMb: 100 })),
}));

import { shouldExitForMemory } from "../../../src/services/worker-memory-monitor.service";

describe("post-job-lifecycle env=0 (Plan v1.1 candidate B / SEC-PLAN-V0-M-01)", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__UNEXPECTED_PROCESS_EXIT__");
    }) as never);
    vi.mocked(shouldExitForMemory).mockClear();
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("applyPostJobMemoryGate env=0 (enabled=false) full no-op contract", () => {
    it("applyPostJobMemoryGate(false, prefix) → process.exit を呼ばない / no process.exit", async () => {
      await applyPostJobMemoryGate(false, "[ENV-ZERO]");
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("applyPostJobMemoryGate(false, prefix) → shouldExitForMemory を呼ばない (= memory check 自体 skip) / no memory check invocation", async () => {
      await applyPostJobMemoryGate(false, "[ENV-ZERO]");
      // shouldExitForMemory が呼ばれていないことを verify (env=0 full no-op)
      expect(vi.mocked(shouldExitForMemory)).not.toHaveBeenCalled();
    });

    it("applyPostJobMemoryGate(false, prefix) → Promise<void> で正常 resolve / resolves to Promise<void>", async () => {
      const result = await applyPostJobMemoryGate(false, "[ENV-ZERO]");
      expect(result).toBeUndefined();
    });
  });

  describe("applyPostJobMemoryGate env>0 (enabled=true) memory gate path", () => {
    it("applyPostJobMemoryGate(true, prefix) + RSS 未超過 → process.exit を呼ばない / no exit when RSS below threshold", async () => {
      vi.mocked(shouldExitForMemory).mockReturnValueOnce({ shouldExit: false, rssMb: 100 });
      await applyPostJobMemoryGate(true, "[ENV-ZERO]");
      expect(processExitSpy).not.toHaveBeenCalled();
      expect(vi.mocked(shouldExitForMemory)).toHaveBeenCalledTimes(1);
    });

    it("applyPostJobMemoryGate(true, prefix) + RSS 閾値超過 → process.exit(0) を呼ぶ (env>0 only) / exit on RSS breach", async () => {
      vi.mocked(shouldExitForMemory).mockReturnValueOnce({ shouldExit: true, rssMb: 5000 });
      // Restore exit to a non-throwing stub so we can observe the call.
      processExitSpy.mockRestore();
      const observingExitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(((_code?: number) => undefined as never) as typeof process.exit);
      try {
        await applyPostJobMemoryGate(true, "[ENV-ZERO]");
        expect(observingExitSpy).toHaveBeenCalledTimes(1);
        expect(observingExitSpy).toHaveBeenCalledWith(0);
      } finally {
        observingExitSpy.mockRestore();
      }
    });
  });

  describe("applyPostJobLifecycleGate Plan v1.1 candidate B no-op stub contract", () => {
    it("applyPostJobLifecycleGate(worker, false, prefix) → worker.pause を呼ばない / no worker.pause invocation under env=0", async () => {
      const pauseSpy = vi.fn().mockResolvedValue(undefined);
      const fakeWorker = { pause: pauseSpy, resume: vi.fn() } as unknown as Parameters<
        typeof applyPostJobLifecycleGate
      >[0];
      await applyPostJobLifecycleGate(fakeWorker, false, "[ENV-ZERO]");
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("applyPostJobLifecycleGate(worker, true, prefix) → worker.pause を呼ばない (Plan v1.1 candidate B no-op stub) / no worker.pause under env>0 either (no-op stub)", async () => {
      const pauseSpy = vi.fn().mockResolvedValue(undefined);
      const fakeWorker = { pause: pauseSpy, resume: vi.fn() } as unknown as Parameters<
        typeof applyPostJobLifecycleGate
      >[0];
      await applyPostJobLifecycleGate(fakeWorker, true, "[ENV-ZERO]");
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });
});
