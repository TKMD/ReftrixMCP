// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * scheduleScreenshotCleanupCron Tests (v0.4.0 PR6)
 *
 * setInterval ベースの cron を fake timers で駆動し、`cleanupExpired` の
 * 呼び出しタイミング、オーバーラップ防止、NaN ガード、stop() を検証する。
 *
 * Unit tests for the setInterval-based cron using fake timers — validates
 * `cleanupExpired` invocation cadence, overlap prevention, NaN guards, and
 * stop() behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scheduleScreenshotCleanupCron } from "../../src/cron/screenshot-cleanup-cron";
import type { IScreenshotPersistenceService } from "../../src/services/screenshot-persistence.service";

function buildService(): {
  service: IScreenshotPersistenceService;
  cleanupSpy: ReturnType<typeof vi.fn>;
} {
  const cleanupSpy = vi.fn(async () => 3);
  const service = {
    saveScreenshot: vi.fn(),
    getScreenshotPath: vi.fn(),
    deleteScreenshot: vi.fn(),
    cleanupExpired: cleanupSpy,
  } as unknown as IScreenshotPersistenceService;
  return { service, cleanupSpy };
}

describe("scheduleScreenshotCleanupCron (v0.4.0 PR6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("invokes cleanupExpired on every interval tick", async () => {
    const { service, cleanupSpy } = buildService();
    const intervalMs = 1000;
    const handle = scheduleScreenshotCleanupCron({
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
    const handle = scheduleScreenshotCleanupCron({
      service,
      intervalMs: 10_000,
      runOnStart: true,
    });
    // flush the void promise
    await Promise.resolve();
    await Promise.resolve();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("falls back to defaults on NaN / non-positive options", async () => {
    const { service } = buildService();
    // Should not throw; uses defaults
    const handle = scheduleScreenshotCleanupCron({
      service,
      intervalMs: Number.NaN,
      olderThanMs: -1,
      maxBatchSize: 0,
    });
    expect(handle.stop).toBeTypeOf("function");
    handle.stop();
  });

  it("stop() prevents subsequent ticks from running", async () => {
    const { service, cleanupSpy } = buildService();
    const handle = scheduleScreenshotCleanupCron({
      service,
      intervalMs: 500,
    });
    handle.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it("skips overlapping ticks when previous run is still in flight", async () => {
    const service = {
      saveScreenshot: vi.fn(),
      getScreenshotPath: vi.fn(),
      deleteScreenshot: vi.fn(),
      cleanupExpired: vi.fn(
        () => new Promise<number>((resolve) => setTimeout(() => resolve(0), 2000))
      ),
    } as unknown as IScreenshotPersistenceService;

    const handle = scheduleScreenshotCleanupCron({
      service,
      intervalMs: 300,
    });
    // First tick fires, starts long-running cleanup
    await vi.advanceTimersByTimeAsync(350);
    await Promise.resolve();
    // Second tick fires while previous still running → should skip
    await vi.advanceTimersByTimeAsync(350);
    expect(service.cleanupExpired).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
