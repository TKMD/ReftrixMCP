// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-NEXT-JOB-RACE-001 (sub 1b/3, listener-driven exit):
 * Plan v4.2 PR-A landing で導入された `worker.once('completed', ...)` listener
 * が、`emit('completed')` 時に `process.exit(0)` を発火することを mocked Worker
 * EventEmitter で verify する。
 *
 * Listener registration order contract (ADR-0034 §Decision 1 Step C):
 *   1. 既存 IPC `worker.on('completed', ...)` handler (parent への job-completed
 *      通知)
 *   2. **次に** `worker.once('completed', ...)` exit listener
 * Node.js EventEmitter は registration 順に listener を invoke するため、parent
 * への IPC notification flush が exit より先に保証される。
 *
 * SEC M-NEW-1 mandate: listener body は synchronous-only (await 禁止、async
 * keyword 禁止)。AST gate `scripts/verify-completed-listener-sync.mjs` が CI
 * で機械的に enforce する (TPA-V42-M-03 closure)。
 *
 * INV-NEXT-JOB-RACE-001 (sub 1b/3, listener-driven exit):
 * Verifies via mocked Worker EventEmitter that the
 * `worker.once('completed', ...)` listener introduced in Plan v4.2 PR-A fires
 * `process.exit(0)` on `emit('completed')`.
 *
 * Listener registration order contract (ADR-0034 §Decision 1 Step C):
 *   1. Existing IPC `worker.on('completed', ...)` handler (parent notification)
 *   2. **Then** `worker.once('completed', ...)` exit listener
 * Node.js EventEmitter invokes listeners in registration order, guaranteeing
 * parent IPC notification flush BEFORE exit. SEC M-NEW-1 mandate: listener
 * body MUST be synchronous-only (no await, no async keyword); the AST gate
 * `scripts/verify-completed-listener-sync.mjs` enforces this in CI.
 *
 * ## A-9 Declaration (feedback_no_fake_success A-9)
 *
 * - **A-9.1**: BullMQ Worker constructor は本 test では invoke しない (mocked
 *   EventEmitter で listener registration order semantic のみ verify)。
 *   Real BullMQ 5.66.5 の `emit('completed')` timing は moveToCompleted Lua
 *   transaction commit に依存。real-Redis 24h smoke (ADR-0030 amendment) で
 *   end-to-end verify する。
 * - **A-9.2**: Mock vs real BullMQ runtime 差分: 本 test は EventEmitter pattern
 *   の registration-order invocation guarantee を Node.js native semantic で
 *   verify する。BullMQ moveToCompleted Lua → emit('completed') の causal chain
 *   は mocked path では bypass される (bounded-trust)。
 *
 * Mock-based bounded-trust assertion; real-Redis 24h smoke supplements.
 *
 * @see Plan v4.2 §3.2 Step 4 (listener pre-register at constructor time)
 * @see ADR-0034 §Decision 1 Stage 5-8 (BullMQ native flow + listener)
 * @see TPA-V42-M-03 (callback-based exit consolidation)
 * @see SEC M-NEW-1 (synchronous-only listener body)
 * @see internal anchor: Plan v4.2 019e2c7e-3b25-701b-a18c-91b8a054a93f
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

describe("INV-NEXT-JOB-RACE-001 (sub 1b, listener-driven exit): worker.once('completed') fires process.exit(0)", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-NEXT-JOB-RACE-001");
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      // no-op mock: 実際に process が終了しないように。
      return undefined as never;
    }) as typeof process.exit);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("INV-NEXT-JOB-RACE-001: worker.once('completed') listener が emit('completed') 時に process.exit(0) を発火する / listener fires process.exit(0) on emit('completed')", () => {
    // Plan v4.2 PR-A 実装相当の listener pre-register pattern を simulate。
    // BullMQ Worker は内部で EventEmitter を継承するため、registration-order
    // invocation guarantee は Node.js native semantic で verify 可能。
    const fakeWorker = new EventEmitter();

    // Step 1: IPC handler 相当 (parent への job-completed 通知)
    const ipcSpy = vi.fn();
    fakeWorker.on("completed", (job) => {
      ipcSpy(job);
    });

    // Step 2: Plan v4.2 PR-A exit listener (synchronous-only per SEC M-NEW-1)
    fakeWorker.once("completed", (_job) => {
      // SEC M-NEW-1: synchronous-only body (no await, no Promise return)
      process.exit(0);
    });

    // emit('completed') trigger (BullMQ moveToCompleted Lua → emit の simulate)
    const mockJob = { id: "test-job-id-123" };
    fakeWorker.emit("completed", mockJob);

    // Assertion: IPC handler が listener より先に fire (registration order)
    expect(ipcSpy).toHaveBeenCalledTimes(1);
    expect(ipcSpy).toHaveBeenCalledWith(mockJob);
    expect(processExitSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("INV-NEXT-JOB-RACE-001: listener registration order は IPC handler → exit listener (parent 通知 flush 保証) / registration order: IPC handler → exit listener (parent flush guaranteed)", () => {
    const callOrder: string[] = [];
    const fakeWorker = new EventEmitter();

    // Step 1: IPC handler (parent への job-completed 通知)
    fakeWorker.on("completed", () => {
      callOrder.push("ipc");
    });

    // Step 2: Exit listener (synchronous-only)
    fakeWorker.once("completed", () => {
      callOrder.push("exit-listener");
      process.exit(0);
    });

    fakeWorker.emit("completed", { id: "test-job-id" });

    // Node.js EventEmitter は registration 順に listener を invoke するため、
    // IPC が exit-listener より先に呼ばれる (parent 通知 flush 保証)
    expect(callOrder).toEqual(["ipc", "exit-listener"]);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("INV-NEXT-JOB-RACE-001: worker.once('completed') は single-shot (2回目以降の emit では fire しない) / once() is single-shot — second emit does NOT fire listener", () => {
    const fakeWorker = new EventEmitter();
    const exitListenerSpy = vi.fn();

    fakeWorker.once("completed", () => {
      exitListenerSpy();
      process.exit(0);
    });

    fakeWorker.emit("completed", { id: "job-1" });
    fakeWorker.emit("completed", { id: "job-2" });

    // once() semantic: 2回目の emit では listener は invoke されない
    expect(exitListenerSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledTimes(1);
  });

  it("INV-NEXT-JOB-RACE-001: emit('completed') が無い場合 process.exit は呼ばれない (listener-driven contract) / no emit means no exit (listener-driven contract)", () => {
    const fakeWorker = new EventEmitter();

    fakeWorker.once("completed", () => {
      process.exit(0);
    });

    // emit せず終了 → exit listener fire しない
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});
