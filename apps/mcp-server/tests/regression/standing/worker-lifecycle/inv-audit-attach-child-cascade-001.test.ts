// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-AUDIT-ATTACH-CHILD-CASCADE-001 (Plan v4.5 PR3 Track 2 §5.6, U-7-c)
 *
 * IO Plan Decision V1 anchor: `019e4267-d21e-7775-b956-544df059d328`
 *
 * ## Contract / 不変条件
 *
 * For every sub-child (Layer 3) spawned via the embedding-backfill fork
 * orchestrator, the parent (Layer 2) MUST attach exactly 3 cascade hooks
 * (stdout / stderr / exit) BEFORE returning from spawn, AND a sub-child SIGABRT
 * (stderr "abort"/"Aborted") MUST cascade to the Layer 1 supervisor's
 * crash-report observability with sub-child PID + parent PID linkage within
 * 5 seconds.
 *
 * ## 4 falsification scenarios (§5.6)
 *
 *   1. hook count != 3 → detectable at orchestrator level (assert == 3)
 *   2. sub-child stderr "Aborted" line → cascaded to error-level with PID linkage
 *   3. sub-child non-clean exit (code/signal) → cascaded with PID linkage
 *   4. 5s SLA: the cascade fires synchronously on the stderr `data` event (no
 *      async batching delay) so Layer 1 observes within the SLA
 *
 * @see Plan v4.5 PR3 V1 §5.6 / §4.6 (dual fork hierarchy)
 * @see apps/mcp-server/src/workers/phases/embedding-backfill-fork-orchestrator.ts
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { assertInvName } from "../_setup/inv-assert";
import { attachSubChildCascadeHooks } from "../../../../src/workers/phases/embedding-backfill-fork-orchestrator";
import { logger } from "../../../../src/utils/logger";

/**
 * Minimal fake ChildProcess with separate stdout/stderr EventEmitters and a
 * pid, sufficient to exercise the cascade hooks.
 */
function createFakeChild(pid: number): {
  child: ChildProcess;
  stdout: EventEmitter;
  stderr: EventEmitter;
  exit: (code: number | null, signal: string | null) => void;
} {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.defineProperty(proc, "stdout", { value: stdout, configurable: true });
  Object.defineProperty(proc, "stderr", { value: stderr, configurable: true });
  Object.defineProperty(proc, "pid", { value: pid, configurable: true });
  const exit = (code: number | null, signal: string | null): void => {
    (proc as unknown as EventEmitter).emit("exit", code, signal);
  };
  return { child: proc, stdout, stderr, exit };
}

describe("INV-AUDIT-ATTACH-CHILD-CASCADE-001: sub-child stdout/stderr/exit cascade hooks (hook count == 3) + SIGABRT cascade with PID linkage (Plan v4.5 PR3 Track 2 §5.6)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-AUDIT-ATTACH-CHILD-CASCADE-001");
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined as unknown as void);
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as unknown as void);
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as unknown as void);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  // Scenario 1: hook count == 3.
  it("INV-AUDIT-ATTACH-CHILD-CASCADE-001: attachSubChildCascadeHooks returns 3 and registers exactly one stdout + one stderr + one exit listener", () => {
    const { child, stdout, stderr } = createFakeChild(4321);
    const count = attachSubChildCascadeHooks(child, "job-cascade-1");
    // Falsifier: a missing hook (e.g. stderr lost) would return < 3.
    expect(count).toBe(3);
    expect(stdout.listenerCount("data")).toBe(1);
    expect(stderr.listenerCount("data")).toBe(1);
    expect((child as unknown as EventEmitter).listenerCount("exit")).toBe(1);
  });

  // Scenario 2 + 4: SIGABRT stderr line cascades to error-level with PID linkage
  // synchronously on the data event (5s SLA satisfied — no async batching).
  it("INV-AUDIT-ATTACH-CHILD-CASCADE-001: sub-child stderr 'Aborted' line cascades to logger.error with subChildPid + parentPid linkage (5s SLA via synchronous emit)", () => {
    const { child, stderr } = createFakeChild(9876);
    attachSubChildCascadeHooks(child, "job-abort");
    const t0 = Date.now();
    stderr.emit("data", Buffer.from("terminate called recursively\nAborted (core dumped)\n"));
    const elapsed = Date.now() - t0;
    // Falsifier: an async-batched cascade would not have logged synchronously.
    expect(errorSpy).toHaveBeenCalled();
    expect(elapsed).toBeLessThan(5000); // 5s SLA
    const call = errorSpy.mock.calls.find((c) => String(c[0]).includes("abort-cascade"));
    expect(call).toBeDefined();
    const meta = call?.[1] as Record<string, unknown> | undefined;
    expect(meta?.["finding"]).toBe("INV-AUDIT-ATTACH-CHILD-CASCADE-001");
    expect(meta?.["subChildPid"]).toBe(9876);
    expect(meta?.["parentPid"]).toBe(process.pid);
  });

  it("INV-AUDIT-ATTACH-CHILD-CASCADE-001: non-abort stderr line is logged at warn (Layer 1 pipe observability preserved), NOT error", () => {
    const { child, stderr } = createFakeChild(111);
    attachSubChildCascadeHooks(child, "job-warn");
    stderr.emit("data", Buffer.from("loading model weights\n"));
    // Falsifier: routing benign lines to error would create false crash signals.
    expect(warnSpy).toHaveBeenCalled();
    const abortCall = errorSpy.mock.calls.find((c) => String(c[0]).includes("abort-cascade"));
    expect(abortCall).toBeUndefined();
  });

  // Scenario 3: non-clean exit cascades with PID linkage.
  it("INV-AUDIT-ATTACH-CHILD-CASCADE-001: sub-child non-clean exit (signal SIGABRT) cascades to logger.error with PID linkage; clean exit (code 0) is silent", () => {
    const { child, exit } = createFakeChild(222);
    attachSubChildCascadeHooks(child, "job-exit");

    // Clean exit → silent.
    exit(0, null);
    let cleanExitCall = errorSpy.mock.calls.find((c) => String(c[0]).includes(":exit]"));
    expect(cleanExitCall).toBeUndefined();

    // Re-attach a fresh child for the non-clean exit path (once() consumed).
    const fresh = createFakeChild(333);
    attachSubChildCascadeHooks(fresh.child, "job-exit-2");
    fresh.exit(null, "SIGABRT");
    cleanExitCall = errorSpy.mock.calls.find(
      (c) => String(c[0]).includes(":exit]") && String(c[0]).includes("job-exit-2".slice(0, 8))
    );
    // Falsifier: a silent non-clean exit would lose the sub-child crash signal.
    const exitCall = errorSpy.mock.calls.find((c) => String(c[0]).includes(":exit]"));
    expect(exitCall).toBeDefined();
    const meta = exitCall?.[1] as Record<string, unknown> | undefined;
    expect(meta?.["finding"]).toBe("INV-AUDIT-ATTACH-CHILD-CASCADE-001");
    expect(meta?.["subChildPid"]).toBe(333);
    expect(meta?.["parentPid"]).toBe(process.pid);
    expect(meta?.["signal"]).toBe("SIGABRT");
  });
});
