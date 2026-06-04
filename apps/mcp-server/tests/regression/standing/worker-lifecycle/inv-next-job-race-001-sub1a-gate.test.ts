// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-NEXT-JOB-RACE-001 (sub 1a/3, no-pause gate-only invocation):
 * Plan v1.1 candidate B / ADR-0034 Amendment 5 (2026-05-28) で
 * `applyPostJobLifecycleGate` の Stage 2 `await worker.pause(true)` は
 * **formal removal** された。本 helper は `Promise<void>` no-op stub として
 * legacy test caller の backward compat 用にのみ retain される (IO Plan
 * Decision V1 §Conflict 2 ruling (a) TPA backward compat 優先)。
 *
 * 本 INV-* (sub 1a) は assertion を Plan v1 v0 baseline から **反転**:
 *   - 旧: enabled=true で `worker.pause(true)` が 1 回呼ばれる
 *   - 新: enabled=true でも `worker.pause` は 0 回しか呼ばれない (no-op stub)
 *
 * helper 内で `process.exit(0)` も呼ばない点は Plan v4.2 PR-A の callback-based
 * exit pattern と整合 (継続)。
 *
 * INV-NEXT-JOB-RACE-001 (sub 1a/3, no-pause gate-only invocation):
 * Plan v1.1 candidate B / ADR-0034 Amendment 5 (2026-05-28) **formally
 * removes** the Stage 2 `await worker.pause(true)` from
 * `applyPostJobLifecycleGate`. The helper is retained as a `Promise<void>`
 * **no-op stub** for legacy test-caller backward compat (IO Plan Decision
 * V1 §Conflict 2 ruling (a) = TPA backward compat preference).
 *
 * This INV (sub 1a) **inverts** the assertion from Plan v1 v0 baseline:
 *   - Old: enabled=true → `worker.pause(true)` called once
 *   - New: enabled=true → `worker.pause` is NEVER called (no-op stub)
 *
 * The helper still does NOT invoke `process.exit(0)`, preserving Plan v4.2
 * PR-A callback-based exit pattern.
 *
 * ## A-9 Declaration (feedback_no_fake_success A-9)
 *
 * - **A-9.1**: mock-based test, real BullMQ Worker behaviour で verify されない
 * - **A-9.2**: the structural "no pause" property is **also enforced statically**
 *   by the AST gate `scripts/verify-no-worker-pause.mjs` (INV-WORKER-NO-PAUSE-001).
 *   Real-Redis 24h smoke supplements (ADR-0030 amendment).
 * - **A-9.3**: callback-based exit listener firing 自体は sub 1b で verify。
 *   本 sub 1a は no-pause gate-only contract に scope を絞る。
 *
 * Mock-based bounded-trust assertion; AST gate
 * `scripts/verify-no-worker-pause.mjs` + real-Redis 24h smoke supplement.
 *
 * @see Plan v1.1 §3 candidate B (`backfill-pause-completed-race-v1.md`)
 * @see ADR-0034 Amendment 5 §Decision 2-4 (Stage 2 formal removal)
 * @see IO Plan Decision V1 anchor `019e6f1a-b580`
 * @see INV-WORKER-NO-PAUSE-001 (AST gate `verify-no-worker-pause.mjs`)
 */

import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

import { applyPostJobLifecycleGate } from "../../../../src/workers/shared/post-job-lifecycle";

describe("INV-NEXT-JOB-RACE-001 (sub 1a, no-pause gate-only invocation): applyPostJobLifecycleGate is a no-op stub", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-NEXT-JOB-RACE-001");
    // process.exit を spy 化。Plan v1.1 candidate B no-op stub は呼ばない想定。
    // throw する形にして万一呼ばれた場合に test を fail させる。
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__UNEXPECTED_PROCESS_EXIT__");
    }) as never);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("INV-NEXT-JOB-RACE-001: enabled=true でも worker.pause は 0 回 (no-op stub) かつ process.exit は呼ばれない / enabled=true: pause called 0 times (no-op stub), exit never invoked", async () => {
    const pauseSpy = vi.fn().mockResolvedValue(undefined);
    const fakeWorker = {
      pause: pauseSpy,
      resume: vi.fn(),
    } as unknown as Worker;

    await applyPostJobLifecycleGate(fakeWorker, true, "[INV-NEXT-JOB-RACE-001-sub1a]");

    // Plan v1.1 candidate B no-pause contract: pause は呼ばない、exit も呼ばない
    expect(pauseSpy).toHaveBeenCalledTimes(0);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("INV-NEXT-JOB-RACE-001: enabled=false でも pause も exit も呼ばれず正常 return する (disabled gate-only) / enabled=false: neither pause nor exit invoked, returns normally", async () => {
    const pauseSpy = vi.fn().mockResolvedValue(undefined);
    const fakeWorker = {
      pause: pauseSpy,
      resume: vi.fn(),
    } as unknown as Worker;

    await applyPostJobLifecycleGate(fakeWorker, false, "[INV-NEXT-JOB-RACE-001-sub1a]");

    expect(pauseSpy).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("INV-NEXT-JOB-RACE-001: applyPostJobLifecycleGate は Promise<void> で resolve する (type-level guarantee, no-op stub) / applyPostJobLifecycleGate resolves to Promise<void>", async () => {
    const pauseSpy = vi.fn().mockResolvedValue(undefined);
    const fakeWorker = {
      pause: pauseSpy,
      resume: vi.fn(),
    } as unknown as Worker;

    // Plan v1.1 candidate B no-op stub: signature 維持 (TPA backward compat)
    const result = await applyPostJobLifecycleGate(
      fakeWorker,
      true,
      "[INV-NEXT-JOB-RACE-001-sub1a]"
    );

    expect(result).toBeUndefined();
  });

  it("INV-NEXT-JOB-RACE-001: no-op stub は side-effect なし (callOrder=[]、pause も exit も呼ばれない) / no-op stub has no side effects (callOrder=[], neither pause nor exit invoked)", async () => {
    const callOrder: string[] = [];
    const pauseSpy = vi.fn().mockImplementation(async () => {
      callOrder.push("pause");
    });
    const fakeWorker = {
      pause: pauseSpy,
      resume: vi.fn(),
    } as unknown as Worker;

    await applyPostJobLifecycleGate(fakeWorker, true, "[INV-NEXT-JOB-RACE-001-sub1a]");

    // Plan v1.1 candidate B no-op stub: pause は呼ばれない、callOrder は空
    expect(callOrder).toEqual([]);
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});
