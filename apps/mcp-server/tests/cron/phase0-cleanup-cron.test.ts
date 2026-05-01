// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * schedulePhase0CleanupCron Tests (v0.4.0 PR7e PR-B / LCC-M3-03)
 *
 * Phase 0 cleanup cron の fake-timer 駆動テスト。
 *   - 間隔ごとに cleanupStaleFailedRows を発火する
 *   - runOnStart=true で起動直後に 1 回走る
 *   - NaN / 非正値 options → デフォルトへフォールバック
 *   - 前回実行が in-flight の場合、次 tick を skip (overlap 防止)
 *   - stop() が timer をクリアし以降の発火を止める
 *   - cleanup が throw しても cron 自体は継続する
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { schedulePhase0CleanupCron } from "../../src/cron/phase0-cleanup-cron";
import type { IPhase0CleanupService } from "../../src/services/phase0-cleanup.service";

function buildService(): {
  service: IPhase0CleanupService;
  cleanupSpy: ReturnType<typeof vi.fn>;
} {
  const cleanupSpy = vi.fn(async () => 3);
  const service: IPhase0CleanupService = {
    cleanupStaleFailedRows:
      cleanupSpy as unknown as IPhase0CleanupService["cleanupStaleFailedRows"],
  };
  return { service, cleanupSpy };
}

describe("schedulePhase0CleanupCron (v0.4.0 PR7e PR-B)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("invokes cleanupStaleFailedRows on every interval tick", async () => {
    const { service, cleanupSpy } = buildService();
    const intervalMs = 1000;
    const handle = schedulePhase0CleanupCron({
      service,
      intervalMs,
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      maxBatchSize: 500,
    });

    expect(cleanupSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(intervalMs + 10);
    await vi.advanceTimersByTimeAsync(0);

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1000, { maxBatchSize: 500 });

    handle.stop();
  });

  it("runs once immediately when runOnStart=true", async () => {
    const { service, cleanupSpy } = buildService();
    const handle = schedulePhase0CleanupCron({
      service,
      intervalMs: 10_000,
      runOnStart: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("does NOT run immediately when runOnStart is omitted (default false)", async () => {
    const { service, cleanupSpy } = buildService();
    const handle = schedulePhase0CleanupCron({
      service,
      intervalMs: 10_000,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cleanupSpy).not.toHaveBeenCalled();
    handle.stop();
  });

  it("falls back to defaults on NaN / non-positive options", async () => {
    const { service, cleanupSpy } = buildService();
    // Should not throw; uses defaults
    const handle = schedulePhase0CleanupCron({
      service,
      intervalMs: NaN,
      olderThanMs: -1,
      maxBatchSize: 0,
      runOnStart: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    // Default olderThanMs = 7 days, default maxBatchSize = 1000
    expect(cleanupSpy).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1000, { maxBatchSize: 1000 });
    handle.stop();
  });

  it("skips tick when previous run still in-flight (overlap prevention)", async () => {
    const { service, cleanupSpy } = buildService();
    // Make cleanup slow so next tick overlaps
    let resolveCleanup: (v: number) => void = () => undefined;
    cleanupSpy.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveCleanup = resolve;
        })
    );

    const intervalMs = 1000;
    const handle = schedulePhase0CleanupCron({
      service,
      intervalMs,
      runOnStart: true,
    });

    // runOnStart kicks off first invocation
    await Promise.resolve();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    // Tick again while first is still in-flight → should SKIP
    await vi.advanceTimersByTimeAsync(intervalMs + 10);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    // Now let the first one finish and advance again → should run
    resolveCleanup(0);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(intervalMs + 10);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("stop() prevents further cleanup invocations", async () => {
    const { service, cleanupSpy } = buildService();
    const intervalMs = 1000;
    const handle = schedulePhase0CleanupCron({ service, intervalMs });

    handle.stop();
    await vi.advanceTimersByTimeAsync(intervalMs * 5);
    await Promise.resolve();
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it("continues running after cleanup throws (non-fatal)", async () => {
    const { service, cleanupSpy } = buildService();
    cleanupSpy.mockRejectedValueOnce(new Error("transient DB error"));
    cleanupSpy.mockResolvedValueOnce(0);

    const intervalMs = 1000;
    const handle = schedulePhase0CleanupCron({ service, intervalMs, runOnStart: true });

    await Promise.resolve();
    await Promise.resolve();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(intervalMs + 10);
    await Promise.resolve();
    await Promise.resolve();
    // Should have run again after the throw
    expect(cleanupSpy).toHaveBeenCalledTimes(2);

    handle.stop();
  });
});
