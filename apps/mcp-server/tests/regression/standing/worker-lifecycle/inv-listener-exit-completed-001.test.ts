// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain (Plan v1.1 candidate B).
 *
 * INV-LISTENER-EXIT-COMPLETED-001 (Plan v1.1 candidate B / ADR-0034
 * Amendment 5):
 * `registerCompletedListenerAndExit` でセットアップされた
 * `worker.once('completed', listener)` が、`emit('completed')` を 100 連続
 * 発火させた際に **100/100 で `process.exit(0)`** を発火することを mocked
 * Worker EventEmitter で verify する (deterministic preservation contract)。
 *
 * Plan v1.1 candidate B (Stage 2 `worker.pause(true)` formal removal) で、
 * 計画的再起動 (`WORKER_MAX_JOBS_BEFORE_RESTART=1`) は **listener exit のみ**
 * で担保される。本 INV はその担保が deterministic に成立することを 100 回
 * の連続 emit で確証する base assertion (statistical confidence は stress
 * variant `inv-listener-exit-completed-001-stress.test.ts` で n=100, α=0.05
 * の binomial test 形式で verify する)。
 *
 * INV-LISTENER-EXIT-COMPLETED-001 (Plan v1.1 candidate B / ADR-0034
 * Amendment 5): Verifies that the
 * `worker.once('completed', listener)` registered by
 * `registerCompletedListenerAndExit` fires `process.exit(0)` **100 / 100
 * times** under 100 consecutive `emit('completed')` invocations on a
 * mocked Worker EventEmitter (deterministic preservation contract).
 *
 * Under Plan v1.1 candidate B (Stage 2 `worker.pause(true)` formal
 * removal), the planned restart (`WORKER_MAX_JOBS_BEFORE_RESTART=1`) is
 * driven **exclusively by the listener exit**. This INV provides the
 * base assertion that the contract holds deterministically; statistical
 * confidence (n=100, α=0.05) lives in the sibling stress test
 * `inv-listener-exit-completed-001-stress.test.ts`.
 *
 * ## Listener body disposeFn Promise.race preservation
 *
 * `registerCompletedListenerAndExit({ disposeFn })` 指定時、listener body
 * 内で `Promise.race([disposeFn(), setTimeout(ceiling)])` が schedule され、
 * `.finally(() => process.exit(0))` で exit が発火する (ADR-0035 §Decision 1
 * canonical pattern、Plan v4.3 PR-M-A)。本 INV は SEC M-NEW-1 synchronous-only
 * listener body 契約と H1 (dispose ceiling 5s microtask race) 直交維持を
 * 100 連続 fire の中で preserve することを assert する。
 *
 * Listener body invokes `Promise.race([disposeFn(), setTimeout(ceiling)])`
 * scheduled inside a synchronous-only body (SEC M-NEW-1), with
 * `.finally(() => process.exit(0))` (ADR-0035 §Decision 1 canonical
 * pattern). H1 (dispose ceiling 5s microtask race) remains orthogonal +
 * preserved across the 100 consecutive emits.
 *
 * ## A-9 Declaration (feedback_no_fake_success A-9)
 *
 * - **A-9.1**: BullMQ Worker constructor は本 test では invoke しない
 *   (mocked EventEmitter で registration-order invocation semantic を
 *   verify)。Real BullMQ 5.66.5 の `emit('completed')` timing は
 *   moveToCompleted Lua transaction commit に依存する。Real-Redis 24h
 *   smoke (ADR-0030 amendment) で end-to-end verify する。
 * - **A-9.2**: H3 (event-loop starvation 下の emit 遅延、§1.3 H3 確証度
 *   "中") の機序確証は本 test では requires しない。本 test の Pass 条件
 *   は「listener fire が deterministic に起きる」 = "pause callback chain
 *   の deterministic preservation"。H3 機序の証明ではない (A-9 透明性
 *   宣言)。
 * - **A-9.3**: 100 連続 emit の statistical confidence (n=100, α=0.05,
 *   binomial test) は stress variant test で扱う。本 base test は
 *   deterministic preservation のみ scope。
 *
 * Mock-based bounded-trust assertion; H3 mechanism is NOT proven here;
 * 24h smoke + stress variant supplement.
 *
 * @see Plan v1.1 §3 candidate B + §7.3 (`backfill-pause-completed-race-v1.md`)
 * @see ADR-0034 Amendment 5 §Decision 2-4 (Stage 2 formal removal)
 * @see ADR-0035 §Decision 1 (dispose ceiling 5s, H1 active orthogonal)
 * @see SEC M-NEW-1 (synchronous-only listener body)
 * @see IO Plan Decision V2 anchor `019e6f1a-b580`
 */

import { EventEmitter } from "node:events";
import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";
import { registerCompletedListenerAndExit } from "../../../../src/workers/shared/post-job-lifecycle";

/**
 * Build a minimal mock Worker that behaves as an EventEmitter for
 * 'completed' but provides the `pause` / `resume` surface required by the
 * Worker type. Used to verify the listener fire contract without spinning
 * up a real BullMQ Worker (which requires Redis).
 */
function buildMockWorker(): { worker: Worker; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  const mock = {
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return { worker: mock as unknown as Worker, emitter };
}

describe("INV-LISTENER-EXIT-COMPLETED-001 (Plan v1.1 candidate B): deterministic listener exit preservation", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-LISTENER-EXIT-COMPLETED-001");
    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined as never) as typeof process.exit);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("INV-LISTENER-EXIT-COMPLETED-001: registerCompletedListenerAndExit (no disposeFn) で emit('completed') 1 回 → process.exit(0) 1 回 (legacy synchronous path) / synchronous path: 1 emit → 1 exit", () => {
    const { worker, emitter } = buildMockWorker();
    registerCompletedListenerAndExit(worker, "embedding-backfill");
    // Synthetic Job stub: `id` is the only field consumed by the listener.
    emitter.emit("completed", { id: "job-001" });
    expect(processExitSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("INV-LISTENER-EXIT-COMPLETED-001: registerCompletedListenerAndExit (no disposeFn) を 100 連続 fresh worker で emit('completed') → 100/100 で process.exit(0) (deterministic preservation) / 100 consecutive iterations: 100/100 exit fires", () => {
    let fireCount = 0;
    let exitCount = 0;
    const localExitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      exitCount++;
      return undefined as never;
    }) as typeof process.exit);
    try {
      for (let i = 0; i < 100; i++) {
        const { worker, emitter } = buildMockWorker();
        registerCompletedListenerAndExit(worker, "embedding-backfill");
        emitter.emit("completed", { id: `job-${i.toString().padStart(3, "0")}` });
        fireCount++;
      }
      expect(fireCount).toBe(100);
      expect(exitCount).toBe(100);
    } finally {
      localExitSpy.mockRestore();
    }
  });

  it("INV-LISTENER-EXIT-COMPLETED-001: registerCompletedListenerAndExit (with disposeFn) で listener body 内 Promise.race が schedule され .finally で exit が発火する (ADR-0035 §Decision 1 canonical pattern preserve) / disposeFn path: Promise.race scheduled + .finally exits", async () => {
    const disposeFn = vi.fn().mockResolvedValue(undefined);
    const { worker, emitter } = buildMockWorker();
    registerCompletedListenerAndExit(worker, "embedding-backfill", { disposeFn, ceilingMs: 100 });
    emitter.emit("completed", { id: "job-dispose-001" });
    // disposeFn は listener body 内で起動される (synchronous-only body 内で
    // Promise.race の microtask scheduling)。listener return 直後に disposeFn
    // が schedule されているはず → 1 tick 待って Promise.race resolve + exit。
    expect(disposeFn).toHaveBeenCalledTimes(1);
    // Microtask + setTimeout race の resolve を待つ。
    await new Promise((r) => setTimeout(r, 50));
    expect(processExitSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("INV-LISTENER-EXIT-COMPLETED-001: listener body 内 disposeFn Promise.race preserve assertion (TPA-PLAN-V0-M-03 / Plan v1.1 §7.4 (c) closure) — disposeFn 指定時に listener body 内で Promise.race が起動することを assert / disposeFn Promise.race start assertion", () => {
    // Plan v1.1 §7.3 / §7.4 (c) closure: listener body 内で disposeFn が
    // 指定されている場合、Promise.race([disposeFn(), setTimeout(ceiling)])
    // が起動することを assert する (SEC M-NEW-1 synchronous-only listener
    // body 契約 preserve)。
    const disposeFn = vi.fn().mockResolvedValue(undefined);
    const { worker, emitter } = buildMockWorker();
    registerCompletedListenerAndExit(worker, "page-analyze", { disposeFn, ceilingMs: 200 });
    emitter.emit("completed", { id: "job-race-001" });
    // Synchronously after emit: disposeFn must have been invoked
    // (Promise.race race-arm started inside the listener body).
    expect(disposeFn).toHaveBeenCalledTimes(1);
  });

  it("INV-LISTENER-EXIT-COMPLETED-001: 100 連続 fresh worker (with disposeFn) → 100/100 で process.exit(0) (deterministic preservation under disposeFn path) / 100 consecutive iterations with disposeFn: 100/100 exit fires", async () => {
    let exitCount = 0;
    const localExitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      exitCount++;
      return undefined as never;
    }) as typeof process.exit);
    try {
      const disposeFn = vi.fn().mockResolvedValue(undefined);
      for (let i = 0; i < 100; i++) {
        const { worker, emitter } = buildMockWorker();
        registerCompletedListenerAndExit(worker, "embedding-backfill", {
          disposeFn,
          ceilingMs: 50,
        });
        emitter.emit("completed", { id: `job-disp-${i.toString().padStart(3, "0")}` });
      }
      // Wait for all microtask races to resolve (50ms ceiling per iteration,
      // but Promise.race resolves on disposeFn success which is immediate).
      await new Promise((r) => setTimeout(r, 200));
      expect(exitCount).toBe(100);
      expect(disposeFn).toHaveBeenCalledTimes(100);
    } finally {
      localExitSpy.mockRestore();
    }
  });
});
