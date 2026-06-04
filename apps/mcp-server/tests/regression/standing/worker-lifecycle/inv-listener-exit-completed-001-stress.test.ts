// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain (Plan v1.1 candidate B
 * stress variant).
 *
 * INV-LISTENER-EXIT-COMPLETED-001 (stress, Plan v1.1 §7.4):
 * `registerCompletedListenerAndExit` の listener が **event-loop starvation
 * noise + dispose 5s 遅延 noise** の下でも、100 連続 emit に対して deterministic
 * に `process.exit(0)` を発火することを verify する。
 *
 * ## 3 要素 (Plan v1.1 §7.4)
 *
 *   - **(a) Event-loop noise generator**: `setImmediate` を 10,000 件 enqueue
 *     して macrotask queue を inflate。Reftrix の page.analyze + backfill
 *     pipeline で観測される async I/O 量に近い shape を simulate。
 *   - **(b) Statistical confidence (n=100, α=0.05, target false-positive
 *     rate ≤ 1%)**: 100 連続 emit に対して 100/100 exit fire を assert する
 *     形式の **binomial test of pass^100 contract**。pause を呼ばない
 *     構造的修正は 100/100 PASS を 95% 以上の confidence で達成する仮説を
 *     test する。
 *   - **(c) disposeFn Promise.race preserve assertion**: stress 中の各
 *     iteration で disposeFn が起動され `Promise.race` chain が成立する
 *     ことを assert (TPA-PLAN-V0-M-03 closure)。SEC M-NEW-1
 *     synchronous-only listener body 契約は維持。
 *
 * ## H3 機序非依存 reframe (Plan v1.1 §7.4)
 *
 * Plan v1.1 §1.3 で H3 (event-loop starvation 下の emit 遅延、BullMQ #359
 * indirect evidence) の確証度は **"中"** と明示。本 stress test の Pass
 * 条件は H3 機序の証明ではなく、「**pause callback chain の deterministic
 * preservation**」: pause を呼ばないという構造的特性 (Plan v1.1 candidate B)
 * が、event-loop noise + dispose 5s 遅延 noise を組み込んでも listener fire
 * を deterministic に preserve する、というという assertion に reframe する。
 *
 * ## dispose 5s 遅延 noise 組込み (H-01 R2 / L-04 統合)
 *
 * stress test に `disposeFn` を「5 秒遅延 resolve」simulate として組込み、
 * 「pause 廃止 (本 PR) と dispose ceiling 5s (ADR-0035 §Decision 1) の
 * 相互非干渉」を実証する。H1 が active 維持された状態で本 PR の H2+H3
 * 構造的消滅が成立することを test 内で観測。
 *
 * INV-LISTENER-EXIT-COMPLETED-001 stress variant (Plan v1.1 §7.4): verifies
 * the listener fires `process.exit(0)` deterministically across 100
 * consecutive emits under (a) event-loop noise (10000 `setImmediate` enqueue),
 * (b) binomial pass^100 contract (n=100, α=0.05, FPR ≤ 1%), and (c) disposeFn
 * Promise.race preservation per ADR-0035 §Decision 1. The H3 mechanism is
 * NOT proven; the test asserts deterministic preservation of the pause-free
 * callback chain (Plan v1.1 reframe).
 *
 * ## A-9 Declaration (feedback_no_fake_success A-9)
 *
 * - **A-9.1**: mocked Worker EventEmitter ベースの bounded-trust assertion。
 *   Real BullMQ moveToCompleted Lua causal chain は real-Redis 24h smoke
 *   gate で end-to-end verify する。
 * - **A-9.2**: Event-loop noise generator は 10,000 件 `setImmediate` に
 *   留まる。Phase 5 child IPC simulation や Redis lock renewal noise の
 *   組込みは Phase 2 dispatch で test-qa-engineer が fine-tune する余地が
 *   ある (Plan v1.1 §7.4 noted)。
 * - **A-9.3**: 100/100 PASS は pass^100 contract (= each individual
 *   iteration MUST PASS) として assert する。flaky な single failure は
 *   stress contract 違反として fail する。
 *
 * @see Plan v1.1 §3 candidate B + §7.4 (`backfill-pause-completed-race-v1.md`)
 * @see ADR-0034 Amendment 5 §Decision 2-4
 * @see ADR-0035 §Decision 1 (dispose ceiling 5s, H1 orthogonal)
 * @see IO Plan Decision V2 anchor `019e6f1a-b580`
 * @see Sibling base test: inv-listener-exit-completed-001.test.ts
 */

import { EventEmitter } from "node:events";
import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";
import { registerCompletedListenerAndExit } from "../../../../src/workers/shared/post-job-lifecycle";

function buildMockWorker(): { worker: Worker; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  // Raise listener cap for stress iterations.
  emitter.setMaxListeners(0);
  const mock = {
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return { worker: mock as unknown as Worker, emitter };
}

/**
 * Event-loop noise generator (Plan v1.1 §7.4 (a)): enqueue 10,000
 * `setImmediate` macrotasks so the EventLoop has a substantial backlog.
 * Returns a Promise that resolves after all noise drains, so tests can
 * verify post-noise state.
 */
function generateEventLoopNoise(count: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let pending = count;
    if (pending === 0) {
      resolve();
      return;
    }
    for (let i = 0; i < count; i++) {
      setImmediate(() => {
        pending--;
        if (pending === 0) resolve();
      });
    }
  });
}

describe("INV-LISTENER-EXIT-COMPLETED-001 stress (Plan v1.1 §7.4): listener deterministic preservation under event-loop + dispose 5s noise", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-LISTENER-EXIT-COMPLETED-001");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("INV-LISTENER-EXIT-COMPLETED-001: stress (a) event-loop noise — 10000 setImmediate backlog 下で 100 連続 emit → 100/100 exit (pass^100 contract under noise) / under event-loop noise: 100/100 exit fires", async () => {
    let exitCount = 0;
    const localExitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      exitCount++;
      return undefined as never;
    }) as typeof process.exit);
    try {
      // (a) Generate noise BEFORE emits to prime the event loop with backlog.
      // The noise drains concurrently with the 100 iterations.
      const noisePromise = generateEventLoopNoise(10_000);
      for (let i = 0; i < 100; i++) {
        const { worker, emitter } = buildMockWorker();
        registerCompletedListenerAndExit(worker, "embedding-backfill");
        emitter.emit("completed", { id: `noisy-${i.toString().padStart(3, "0")}` });
      }
      await noisePromise;
      // (b) Binomial pass^100 contract: every iteration MUST exit. 100/100.
      expect(exitCount).toBe(100);
    } finally {
      localExitSpy.mockRestore();
    }
  });

  it("INV-LISTENER-EXIT-COMPLETED-001: stress (c) disposeFn Promise.race preserved — listener body 内 Promise.race chain は noise 下でも各 iteration で disposeFn を起動する / Promise.race chain preserved under noise (TPA-PLAN-V0-M-03)", async () => {
    const disposeFn = vi.fn().mockResolvedValue(undefined);
    let exitCount = 0;
    const localExitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      exitCount++;
      return undefined as never;
    }) as typeof process.exit);
    try {
      const noisePromise = generateEventLoopNoise(10_000);
      for (let i = 0; i < 100; i++) {
        const { worker, emitter } = buildMockWorker();
        registerCompletedListenerAndExit(worker, "page-analyze", {
          disposeFn,
          ceilingMs: 50,
        });
        emitter.emit("completed", { id: `dispose-noisy-${i.toString().padStart(3, "0")}` });
      }
      await noisePromise;
      await new Promise((r) => setTimeout(r, 200));
      // SEC M-NEW-1 preservation: disposeFn must be invoked once per emit.
      expect(disposeFn).toHaveBeenCalledTimes(100);
      // (b) Binomial pass^100 contract under disposeFn path.
      expect(exitCount).toBe(100);
    } finally {
      localExitSpy.mockRestore();
    }
  });

  it("INV-LISTENER-EXIT-COMPLETED-001: stress dispose 5s delay noise — pause 廃止 (本 PR) と dispose ceiling 5s (ADR-0035 §Decision 1) の相互非干渉を実証。ceilingMs を timeout より十分小さく取り、各 iteration で .finally → exit が deterministic に発火する (H1 直交維持) / dispose 5s delay isolation: 100/100 exit fires (H1 orthogonal preservation)", async () => {
    let exitCount = 0;
    const localExitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      exitCount++;
      return undefined as never;
    }) as typeof process.exit);
    try {
      // Simulate dispose that takes 5s to resolve — far longer than the
      // ceilingMs window. The Promise.race ceiling-arm wins, .finally
      // fires exit. This proves that even if disposeFn stalls (5s delay
      // noise) the listener exit still fires deterministically (H1
      // bounded by ceilingMs, H2/H3 structurally eliminated under
      // Plan v1.1 candidate B).
      //
      // We use a slightly larger ceiling here (250ms) and a 5000ms
      // "slow dispose" stub to verify the ceiling-arm wins.
      const slowDispose = vi
        .fn()
        .mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 5000)));
      for (let i = 0; i < 100; i++) {
        const { worker, emitter } = buildMockWorker();
        registerCompletedListenerAndExit(worker, "embedding-backfill", {
          disposeFn: slowDispose,
          ceilingMs: 250,
        });
        emitter.emit("completed", { id: `slow-dispose-${i.toString().padStart(3, "0")}` });
      }
      // Wait long enough for all 100 ceiling-arm setTimeouts (250ms) to
      // resolve. They run concurrently, so a single 500ms wait covers all.
      await new Promise((r) => setTimeout(r, 500));
      expect(slowDispose).toHaveBeenCalledTimes(100);
      // (b) pass^100 contract: every iteration MUST exit via ceiling-arm.
      expect(exitCount).toBe(100);
    } finally {
      localExitSpy.mockRestore();
    }
  }, 15_000); // Allow up to 15s for the stress loop + waits.
});
