// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.verify_reproduction keeps ONE resident DINOv2 instance (idle dispose) instead of loading
 * and disposing the model on every call: measured on the dev DB, per-call load grew the process
 * RSS by ~400 MB per call (689 -> 3472 MB over 8 calls); a reused instance stayed at ~770 MB.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DINOV2_RESIDENT_IDLE_MS,
  createResidentDinov2,
  type VerifyDinov2,
} from "../../../src/services/design/reproduction-verify.service";

function fakeDino(): VerifyDinov2 & { dispose: ReturnType<typeof vi.fn> } {
  return {
    initialized: true,
    initialize: vi.fn(async () => undefined),
    generateEmbedding: vi.fn(async () => [0.1]),
    dispose: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createResidentDinov2", () => {
  it("reuses one instance across calls and does not dispose between them", async () => {
    const made: ReturnType<typeof fakeDino>[] = [];
    const r = createResidentDinov2(() => {
      const d = fakeDino();
      made.push(d);
      return d;
    });
    for (let i = 0; i < 5; i++) {
      const d = r.get();
      expect(d).not.toBeNull();
      await r.release(d as VerifyDinov2, false);
    }
    expect(made).toHaveLength(1);
    expect(made[0]?.dispose).not.toHaveBeenCalled();
    await r.shutdown();
  });

  it("disposes after the idle period and loads again on the next call", async () => {
    vi.useFakeTimers();
    const made: ReturnType<typeof fakeDino>[] = [];
    const r = createResidentDinov2(() => {
      const d = fakeDino();
      made.push(d);
      return d;
    });
    await r.release(r.get() as VerifyDinov2, false);
    await vi.advanceTimersByTimeAsync(DINOV2_RESIDENT_IDLE_MS + 10);
    expect(made[0]?.dispose).toHaveBeenCalledOnce();
    r.get();
    expect(made).toHaveLength(2);
    await r.shutdown();
  });

  it("drops a broken instance immediately", async () => {
    const made: ReturnType<typeof fakeDino>[] = [];
    const r = createResidentDinov2(() => {
      const d = fakeDino();
      made.push(d);
      return d;
    });
    await r.release(r.get() as VerifyDinov2, true);
    expect(made[0]?.dispose).toHaveBeenCalledOnce();
    r.get();
    expect(made).toHaveLength(2);
    await r.shutdown();
  });
});
