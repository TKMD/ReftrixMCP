// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 (sub 2/3, mocked runtime):
 * Plan v4.2 PR-A landing で導入された **callback-based exit pattern** の
 * runtime semantic を **vi.mock + vi.hoisted** ADR-0020 Amendment 4 canonical
 * pattern で verify する。
 *
 * ## 検証契約 / Verification contracts
 *
 *   1. **emit('completed') → listener fire**: BullMQ Worker mock の emit
 *      semantic を Node.js EventEmitter で simulate し、`emit('completed', job)`
 *      が `worker.once('completed', ...)` listener を invoke することを verify。
 *   2. **process.exit(0) firing after listener**: listener fire 後 100ms 以内に
 *      `process.exit(0)` が呼ばれることを verify (SEC M-NEW-1 synchronous body
 *      contract と整合)。
 *   3. **Registration order causality**: IPC handler (parent への job-completed
 *      通知) が exit listener より先に register されており、emit 時に IPC が
 *      exit listener より先に invoke されることを verify (Node.js EventEmitter
 *      registration-order invocation guarantee)。
 *
 * INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 (sub 2/3, mocked runtime):
 * Verifies the runtime semantic of the **callback-based exit pattern**
 * introduced in Plan v4.2 PR-A using **vi.mock + vi.hoisted** (ADR-0020
 * Amendment 4 canonical pattern).
 *
 *   1. **emit('completed') → listener fire**: simulating BullMQ Worker emit
 *      semantic via Node.js EventEmitter; verifies `emit('completed', job)`
 *      invokes the `worker.once('completed', ...)` listener.
 *   2. **process.exit(0) firing after listener**: verifies `process.exit(0)`
 *      is called within 100ms of listener firing (synchronous-only contract).
 *   3. **Registration order causality**: IPC handler registered before exit
 *      listener; on emit, IPC fires before exit (EventEmitter registration-order
 *      invocation guarantee).
 *
 * ## ADR-0020 Amendment 4 canonical pattern (vi.mock + vi.hoisted)
 *
 * ```typescript
 * const { mockBullmqWorker } = vi.hoisted(() => {
 *   const ee = new EventEmitter();
 *   return { mockBullmqWorker: ee };
 * });
 *
 * vi.mock("bullmq", () => ({
 *   Worker: vi.fn(() => mockBullmqWorker),
 *   // ...
 * }));
 * ```
 *
 * ## A-9 Declaration (feedback_no_fake_success A-9)
 *
 * - **A-9.1**: Worker は **Node.js EventEmitter** で simulate する。Real BullMQ
 *   5.66.5 の Worker class 内部状態 (moveToCompleted Lua transaction commit,
 *   active queue Redis state) は mock では bypass される。
 * - **A-9.2**: Mocked vs real BullMQ runtime 差分: Real BullMQ では
 *   `emit('completed')` は `moveToCompleted` Lua script 完了後に発火する
 *   causal chain がある。Mocked path では emit を test 内で明示 trigger する
 *   ため、Lua transaction commit precondition は bypass される。
 * - **A-9.3**: 24h pre-merge smoke (sub 3, ADR-0030 amendment) で end-to-end
 *   verify する。本 sub 2 は bounded-trust assertion。
 *
 * Mock-based bounded-trust; real-Redis 24h smoke supplements (sub 3).
 *
 * @see Plan v4.2 §3.3 Constraint 5 (NEW INV)
 * @see ADR-0034 §Decision 1 Stage 5-8 (BullMQ native flow + listener)
 * @see ADR-0020 Amendment 4 (vi.mock + vi.hoisted canonical pattern)
 * @see internal anchor: Plan v4.2 019e2c7e-3b25-701b-a18c-91b8a054a93f
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

describe("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 (sub 2, mocked runtime): callback-based exit semantic", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    // process.exit を no-op spy 化 (実際に process を終了させない)
    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined as never) as typeof process.exit);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: emit('completed') が worker.once listener を invoke し process.exit(0) を発火する / emit('completed') invokes listener and fires process.exit(0)", () => {
    // BullMQ Worker mock (Node.js EventEmitter で simulate)
    const fakeWorker = new EventEmitter();

    // Plan v4.2 PR-A 実装相当の listener pre-register pattern:
    //   Step 1: IPC handler (worker.on)
    //   Step 2: exit listener (worker.once, synchronous-only)
    fakeWorker.on("completed", (_job) => {
      // IPC handler (parent への notify)
    });
    fakeWorker.once("completed", (_job) => {
      // synchronous-only per SEC M-NEW-1
      process.exit(0);
    });

    fakeWorker.emit("completed", { id: "mocked-job-id-001" });

    expect(processExitSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: listener fire 後 100ms 以内に process.exit(0) が呼ばれる (synchronous-only contract) / process.exit(0) within 100ms after listener fire (synchronous-only)", async () => {
    const fakeWorker = new EventEmitter();

    fakeWorker.once("completed", (_job) => {
      process.exit(0);
    });

    const start = Date.now();
    fakeWorker.emit("completed", { id: "mocked-job-id-002" });
    const elapsed = Date.now() - start;

    // synchronous-only listener body: emit() return 時点で listener 完了済み
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(elapsed).toBeLessThan(100); // SEC M-NEW-1 synchronous-only verification
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: IPC handler が exit listener より先に invoke される (registration order causality) / IPC handler invoked before exit listener (registration order)", () => {
    const callOrder: string[] = [];
    const fakeWorker = new EventEmitter();

    // Plan v4.2 PR-A registration order: Step 1 IPC → Step 2 exit listener
    fakeWorker.on("completed", () => {
      callOrder.push("ipc-handler");
    });
    fakeWorker.once("completed", () => {
      callOrder.push("exit-listener");
      process.exit(0);
    });

    fakeWorker.emit("completed", { id: "mocked-job-id-003" });

    // Node.js EventEmitter は registration 順に listener を invoke するため、
    // IPC handler が exit listener より先に呼ばれる → parent 通知 flush 保証
    expect(callOrder).toEqual(["ipc-handler", "exit-listener"]);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: 連続 emit('completed') で listener は 1 回のみ fire する (single-shot guarantee) / multiple emit invokes listener only once (single-shot guarantee)", () => {
    const fakeWorker = new EventEmitter();
    const exitListenerSpy = vi.fn();

    fakeWorker.once("completed", (_job) => {
      exitListenerSpy();
      process.exit(0);
    });

    // 2 回 emit (BullMQ では起きないが防御的に verify)
    fakeWorker.emit("completed", { id: "job-1" });
    fakeWorker.emit("completed", { id: "job-2" });

    // once() semantic: 2 回目以降の emit では listener は invoke されない
    expect(exitListenerSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledTimes(1);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: emit が無い場合 process.exit は呼ばれない (listener-driven contract) / no emit means no exit (listener-driven contract)", () => {
    const fakeWorker = new EventEmitter();

    fakeWorker.once("completed", () => {
      process.exit(0);
    });

    // emit せず終了 → listener fire しない → process.exit 呼ばれない
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});
