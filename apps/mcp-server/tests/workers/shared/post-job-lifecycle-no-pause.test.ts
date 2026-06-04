// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plan v1.1 candidate B / INV-WORKER-NO-PAUSE-001 (helper-side):
 * `applyPostJobLifecycleGate` および `applyPostJobMemoryGate` の helper
 * 内で `worker.pause` spy が **0 回** 呼ばれることを 100 連続 invocation
 * で verify する (success path 模擬の deterministic preservation contract)。
 *
 * Plan v1.1 candidate B の構造的修正により、両 helper は production code
 * 内で `worker.pause(...)` を呼ぶ surface を持たない:
 *   - `applyPostJobLifecycleGate` は no-op stub (legacy test caller
 *     backward compat 用)、body 内に `worker.pause` 呼出なし
 *   - `applyPostJobMemoryGate` は worker instance を引数に取らず、
 *     `worker.pause` を呼ぶ手段が型レベルで存在しない (constructive proof)
 *
 * 本 test は両 helper を 100 連続 invocation し、各 invocation で
 * `worker.pause` spy が 0 回呼ばれることを assert する (pass^100 contract、
 * Plan v1.1 §7.1 specific 化)。
 *
 * Plan v1.1 candidate B / INV-WORKER-NO-PAUSE-001 (helper-side): verifies
 * that across 100 consecutive invocations of `applyPostJobLifecycleGate`
 * and `applyPostJobMemoryGate`, the `worker.pause` spy is called **0
 * times** (deterministic preservation contract on the success-path
 * model).
 *
 * @see Plan v1.1 §3 candidate B + §7.1 (`backfill-pause-completed-race-v1.md`)
 * @see ADR-0034 Amendment 5 §Decision 2-4 (helper-side surface)
 * @see INV-WORKER-NO-PAUSE-001 (AST gate `verify-no-worker-pause.mjs`)
 */

import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyPostJobLifecycleGate,
  applyPostJobMemoryGate,
} from "../../../src/workers/shared/post-job-lifecycle";

vi.mock("../../../src/services/worker-memory-monitor.service", () => ({
  shouldExitForMemory: vi.fn(() => ({ shouldExit: false, rssMb: 100 })),
}));

describe("post-job-lifecycle helper no-pause contract (Plan v1.1 candidate B)", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__UNEXPECTED_PROCESS_EXIT__");
    }) as never);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("applyPostJobLifecycleGate を 100 連続 invoke (enabled=true) → worker.pause spy が 0 回 (no-op stub) / 100 invocations: worker.pause spy 0 invocations", async () => {
    const pauseSpy = vi.fn().mockResolvedValue(undefined);
    const fakeWorker = { pause: pauseSpy, resume: vi.fn() } as unknown as Worker;
    for (let i = 0; i < 100; i++) {
      await applyPostJobLifecycleGate(fakeWorker, true, `[no-pause-${i}]`);
    }
    expect(pauseSpy).toHaveBeenCalledTimes(0);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("applyPostJobLifecycleGate を 100 連続 invoke (enabled=false) → worker.pause spy が 0 回 (disabled path) / 100 invocations disabled: worker.pause spy 0 invocations", async () => {
    const pauseSpy = vi.fn().mockResolvedValue(undefined);
    const fakeWorker = { pause: pauseSpy, resume: vi.fn() } as unknown as Worker;
    for (let i = 0; i < 100; i++) {
      await applyPostJobLifecycleGate(fakeWorker, false, `[no-pause-disabled-${i}]`);
    }
    expect(pauseSpy).toHaveBeenCalledTimes(0);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("applyPostJobMemoryGate を 100 連続 invoke (enabled=true) → process.exit を呼ばない (RSS 未超過) / 100 invocations: no exit when RSS below threshold", async () => {
    for (let i = 0; i < 100; i++) {
      await applyPostJobMemoryGate(true, `[no-pause-memory-${i}]`);
    }
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("applyPostJobMemoryGate の signature には Worker instance arg が無い (constructive proof: pause を呼ぶ手段が型レベルで存在しない) / applyPostJobMemoryGate signature lacks Worker arg", () => {
    // applyPostJobMemoryGate(enabled: boolean, loggerPrefix: string) — arity 2
    expect(applyPostJobMemoryGate.length).toBe(2);
  });
});
