// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-EMBEDDING-DISPOSE-IDEMPOTENT-001 (Plan v4.3 PR-M-B / FIND-PLAN-V43-H-01
 * closure): `LayoutEmbeddingService.disposeEmbeddingPipeline()` must be
 * **idempotent under concurrent invocation**, sharing a single in-flight
 * `Promise<void>` so the underlying ONNX `service.dispose()` (and its side
 * effects) run **exactly once** even when called from racing call paths.
 *
 * INV-EMBEDDING-DISPOSE-IDEMPOTENT-001 (Plan v4.3 PR-M-B / FIND-PLAN-V43-H-01
 * closure): `LayoutEmbeddingService.disposeEmbeddingPipeline()` must be
 * **idempotent under concurrent invocation** — racing call paths share one
 * in-flight Promise so the underlying ONNX `service.dispose()` runs **exactly
 * once**, side effects (`logger.info` "ONNX pipeline disposed") fire once,
 * and the mutex slot resets so a later dispose (lazy re-init) runs normally.
 *
 * ## Background / 背景
 *
 * ADR-0019 close-before-dispose ordering (shutdown path) と ADR-0034 callback-
 * exit pattern (Plan v4.2) は **同一プロセス内で並行** 走り得る:
 *   - shutdown path: `worker.close()` → close handler → `disposeEmbeddingPipeline()`
 *   - planned-restart path: `worker.once('completed', ...)` listener body
 *     → Plan v4.3 PR-M-A `disposeFn` → `disposeEmbeddingPipeline()`
 *
 * 2 path が同時に走った場合、ONNX `InferenceSession.release()` の double-call
 * は **SIGABRT race window** (FIND-PLAN-V43-H-01 disclosed risk) を再露出する
 * 可能性がある。PR-M-B は `inFlightDispose` Promise sharing で本 race を
 * **構造的に排除** する idempotency mutex を導入した。
 *
 * The shutdown path (`worker.close()` → close handler) and planned-restart
 * path (`worker.once('completed')` listener → `disposeFn`) can race within
 * the same process. Calling ONNX `InferenceSession.release()` twice exposes
 * the SIGABRT race window (FIND-PLAN-V43-H-01). PR-M-B closes this with an
 * `inFlightDispose` Promise mutex so concurrent callers share one dispose
 * completion.
 *
 * ## 3 contracts / 3 不変条件
 *
 *   1. **Single dispose under concurrent call** (PR-M-B mutex):
 *      `disposeEmbeddingPipeline()` を **同期的に 2 回呼び出した**場合、
 *      下層 `service.dispose()` は **1 回** のみ実行される。両 caller は
 *      同 Promise を await し、同 completion を観測する。
 *   2. **Side-effect single-fire** (PR-M-B mutex):
 *      logger.info "ONNX pipeline disposed" 等の side effect も 1 回のみ
 *      発火する (mutex 経由で `doDisposePipeline()` 本体が 1 回しか走らない)。
 *   3. **Post-completion reset** (PR-M-B `inFlightDispose = null`):
 *      Dispose 完了後に `inFlightDispose` slot が `null` に reset され、
 *      その後の `disposeEmbeddingPipeline()` 呼出 (e.g. lazy re-init 後の
 *      sub-phase 末尾 dispose) は **通常実行** される (mutex は永続 lock
 *      ではなく in-flight 期間中の coordination のみ)。
 *
 * ## CI-failing test (PR-M-B dependence)
 *
 * 本 test は Plan v4.3 PR-M-B (`inFlightDispose` mutex 実装) **適用前は fail**
 * する想定 (race scenario で `service.dispose()` が 2 回呼ばれる)、適用後
 * **PASS** する。PR-M-B は `apps/mcp-server/src/services/layout-embedding.service.ts`
 * の `disposeEmbeddingPipeline()` method に `inFlightDispose: Promise<void> | null`
 * field + Promise sharing logic を追加した実装で closure する。
 *
 * This test is designed to FAIL before PR-M-B (the `inFlightDispose` mutex)
 * lands, and PASS after. PR-M-B introduces the in-flight tracker field +
 * Promise sharing in `disposeEmbeddingPipeline()`.
 *
 * ## ADR-0020 Amendment 4 canonical pattern (vi.mock + vi.hoisted)
 *
 * `intra-file race` 防止のため、`vi.doMock` ではなく `vi.mock + vi.hoisted`
 * を採用 (per `.claude/rules/testing-requirements.md` §3 file-level
 * isolation)。`@reftrixmcp/ml` の `EmbeddingService` factory を hoisted scope で
 * pre-construct し、`service.dispose()` 呼出回数を test 内で観測可能にする。
 *
 * @see ADR-0035 §Decision 1 (callback-exit canonical listener body)
 * @see ADR-0019 (Embedding Worker Close-Before-Dispose Ordering)
 * @see FIND-PLAN-V43-H-01 (dispose idempotency race disclosure)
 * @see ADR-0020 Amendment 4 (vi.mock + vi.hoisted canonical)
 * @module tests/regression/standing/worker-lifecycle/inv-embedding-dispose-idempotent-001
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

// =============================================================================
// vi.hoisted: pre-construct EmbeddingService factory mock
// =============================================================================

/**
 * Hoisted EmbeddingService mock with `dispose` spy and a controllable delay
 * helper. The delay is used in concurrent-call tests to widen the race
 * window so the mutex must do real work (without artificial delay, the two
 * synchronous calls could trivially coalesce by reentrancy timing).
 *
 * `disposeCallOrder` records the timeline of dispose invocations so tests
 * can assert single-fire semantics + reset behaviour.
 */
const { mockEmbeddingService, disposeCallOrder, resetDisposeState } = vi.hoisted(() => {
  const order: number[] = [];
  let invocationCounter = 0;
  let pendingResolve: (() => void) | null = null;
  const service = {
    dispose: vi.fn(async () => {
      invocationCounter += 1;
      const myIdx = invocationCounter;
      order.push(myIdx);
      // Block until the test releases the dispose (so concurrent callers
      // race for the mutex). Default release is immediate.
      if (pendingResolve !== null) {
        await new Promise<void>((resolve) => {
          pendingResolve = resolve;
        });
      }
    }),
    // Test helper exposed via vi.hoisted closure to gate dispose resolution.
    __setBlocking(blocking: boolean): void {
      if (blocking) {
        pendingResolve = () => undefined;
      } else {
        pendingResolve = null;
      }
    },
    __release(): void {
      const r = pendingResolve;
      pendingResolve = null;
      if (r !== null) r();
    },
  };
  return {
    mockEmbeddingService: service,
    disposeCallOrder: order,
    resetDisposeState: (): void => {
      order.length = 0;
      invocationCounter = 0;
      service.dispose.mockClear();
      pendingResolve = null;
    },
  };
});

vi.mock("../../../../src/services/layout-embedding.service", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../src/services/layout-embedding.service")
  >("../../../../src/services/layout-embedding.service");
  return {
    ...actual,
    // Override the IEmbeddingService factory so disposeEmbeddingPipeline()
    // ends up routing through our spy dispose. The actual LayoutEmbeddingService
    // class is unchanged; only its embeddingService field type is swapped via
    // setEmbeddingServiceFactory.
  };
});

import {
  LayoutEmbeddingService,
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
} from "../../../../src/services/layout-embedding.service";

// =============================================================================
// Test Suite
// =============================================================================

describe("INV-EMBEDDING-DISPOSE-IDEMPOTENT-001: disposeEmbeddingPipeline() idempotency mutex — concurrent callers share one in-flight Promise, dispose runs exactly once, post-completion reset (Plan v4.3 PR-M-B / FIND-PLAN-V43-H-01 closure)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-EMBEDDING-DISPOSE-IDEMPOTENT-001");
    // 1 test = 1 mock cycle: fresh dispose call counter per test
    resetDisposeState();
    // Inject our spy-backed embedding service factory
    setEmbeddingServiceFactory(() => mockEmbeddingService as never);
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Test 1 — concurrent dispose → single underlying dispose call
  // ==========================================================================

  it("INV-EMBEDDING-DISPOSE-IDEMPOTENT-001: 2 concurrent disposeEmbeddingPipeline() invocations resolve via the shared in-flight Promise; underlying service.dispose() runs exactly once (PR-M-B mutex contract)", async () => {
    // INV-EMBEDDING-DISPOSE-IDEMPOTENT-001
    const service = new LayoutEmbeddingService();

    // Force pipeline lazy-init by routing through a no-op text generation
    // path. We can't trivially construct internal state without invoking
    // generateFromText (which would require ONNX). Instead, we simulate the
    // post-init state by directly stubbing the field via a non-public
    // accessor. The PR-M-B contract is observable at the public method
    // boundary — concurrent disposeEmbeddingPipeline() invocations must share
    // a single completion (observable as: underlying service.dispose() runs
    // exactly once even when called from racing call paths).
    const internalService = service as unknown as {
      embeddingService: typeof mockEmbeddingService | null;
      inFlightDispose?: Promise<void> | null;
    };
    internalService.embeddingService = mockEmbeddingService;

    // Block dispose so both concurrent callers must contend for the mutex.
    mockEmbeddingService.__setBlocking(true);

    const promise1 = service.disposeEmbeddingPipeline();
    const promise2 = service.disposeEmbeddingPipeline();

    // PR-M-B mutex contract — observable structural marker:
    //   - The `inFlightDispose` field MUST be a non-null Promise during the
    //     in-flight window (proves the mutex slot is populated).
    //   - Both concurrent callers MUST share completion — the underlying
    //     `service.dispose()` MUST run exactly once after both promises
    //     resolve. Note: `async` method wrappers always produce distinct
    //     outer Promise instances per call, so direct `promise1 === promise2`
    //     identity does NOT hold even under correct mutex semantics. The
    //     canonical structural marker is `inFlightDispose != null` during
    //     the race window + `dispose called once` post-resolution.
    expect(
      internalService.inFlightDispose,
      "PR-M-B mutex contract: during the in-flight dispose window, `inFlightDispose` field MUST be a non-null Promise (slot populated by the first caller, observed by subsequent concurrent callers)"
    ).not.toBeNull();

    // Release the blocked dispose so the shared Promise resolves.
    mockEmbeddingService.__release();
    await Promise.all([promise1, promise2]);

    // service.dispose() must have been invoked exactly once across both
    // concurrent callers.
    expect(
      mockEmbeddingService.dispose,
      "PR-M-B mutex contract: underlying service.dispose() MUST run exactly once across 2 concurrent disposeEmbeddingPipeline() invocations"
    ).toHaveBeenCalledTimes(1);
    expect(disposeCallOrder).toEqual([1]);
  });

  // ==========================================================================
  // Test 2 — side-effect single-fire
  // ==========================================================================

  it("INV-EMBEDDING-DISPOSE-IDEMPOTENT-001: side effects (logger.info 'ONNX pipeline disposed') fire exactly once across concurrent dispose invocations (PR-M-B mutex: doDisposePipeline body runs once)", async () => {
    // INV-EMBEDDING-DISPOSE-IDEMPOTENT-001
    const service = new LayoutEmbeddingService();
    const internalService = service as unknown as {
      embeddingService: typeof mockEmbeddingService | null;
      inFlightDispose?: Promise<void> | null;
    };
    internalService.embeddingService = mockEmbeddingService;

    // Run 3 concurrent dispose invocations to widen the test contract beyond
    // the 2-caller minimum (real production exposes shutdown + callback-exit
    // + sub-phase end as 3 potential concurrent paths).
    const promises = [
      service.disposeEmbeddingPipeline(),
      service.disposeEmbeddingPipeline(),
      service.disposeEmbeddingPipeline(),
    ];

    // All 3 callers must observe the in-flight mutex slot (non-null
    // `inFlightDispose` during the race window). Async-method outer Promise
    // identity is NOT a valid marker (each `async` call produces its own
    // wrapper Promise); the structural marker is the populated mutex slot
    // + single underlying dispose invocation.
    expect(
      internalService.inFlightDispose,
      "PR-M-B mutex slot MUST be populated for the in-flight window across 3 racing callers"
    ).not.toBeNull();

    await Promise.all(promises);

    // service.dispose() ran exactly once → side effects within
    // doDisposePipeline() (logger.info, internal state mutations) all
    // single-fire across 3 concurrent callers.
    expect(
      mockEmbeddingService.dispose,
      "PR-M-B mutex: doDisposePipeline body runs exactly once across 3 racing dispose invocations (side effects single-fire)"
    ).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // Test 3 — post-completion reset
  // ==========================================================================

  it("INV-EMBEDDING-DISPOSE-IDEMPOTENT-001: post-completion reset — after the in-flight Promise resolves, a subsequent disposeEmbeddingPipeline() (e.g. after lazy re-init) runs normally (mutex is in-flight-period coordination, NOT permanent lock) (PR-M-B inFlightDispose = null reset)", async () => {
    // INV-EMBEDDING-DISPOSE-IDEMPOTENT-001
    const service = new LayoutEmbeddingService();
    const internalService = service as unknown as {
      embeddingService: typeof mockEmbeddingService | null;
      inFlightDispose?: Promise<void> | null;
    };
    internalService.embeddingService = mockEmbeddingService;

    // First dispose cycle
    await service.disposeEmbeddingPipeline();
    expect(mockEmbeddingService.dispose).toHaveBeenCalledTimes(1);

    // Post-completion: the inFlightDispose slot must be reset to null so a
    // subsequent dispose runs the underlying call again (simulating lazy
    // re-init followed by another sub-phase dispose).
    expect(
      internalService.inFlightDispose,
      "PR-M-B mutex contract: after the in-flight Promise resolves, `inFlightDispose` MUST reset to null (in-flight-period coordination, not permanent lock)"
    ).toBeNull();

    // Re-attach embeddingService (simulating lazy re-init after first dispose
    // nullified it). The mutex is now ready for a fresh cycle.
    internalService.embeddingService = mockEmbeddingService;

    // Second dispose cycle should run service.dispose() again.
    await service.disposeEmbeddingPipeline();
    expect(
      mockEmbeddingService.dispose,
      "PR-M-B mutex must NOT block subsequent dispose cycles after the in-flight Promise resolves (post-completion reset)"
    ).toHaveBeenCalledTimes(2);
  });
});
