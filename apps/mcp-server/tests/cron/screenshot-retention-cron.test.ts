// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the screenshot retention cron driver.
 * スクリーンショット保持期限 cron のユニットテスト
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SCREENSHOT_RETENTION_CRON_DRY_RUN_ENV,
  SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS,
  SCREENSHOT_RETENTION_INTERVAL_ENV,
  SCREENSHOT_RETENTION_MAX_INTERVAL_MS,
  SCREENSHOT_RETENTION_MIN_INTERVAL_MS,
  resolveRetentionCronDryRun,
  resolveRetentionIntervalMs,
  scheduleScreenshotRetentionCron,
} from "../../src/cron/screenshot-retention-cron";
import { SCREENSHOT_RETENTION_MAX_DAYS } from "../../src/services/screenshot-retention.service";
import type {
  IScreenshotRetentionService,
  RetentionCycleOptions,
  RetentionCycleResult,
} from "../../src/services/screenshot-retention.service";
import { logger } from "../../src/utils/logger";

function result(over: Partial<RetentionCycleResult> = {}): RetentionCycleResult {
  return {
    dryRun: false,
    retentionDays: 7,
    aborted: null,
    scannedCount: 0,
    deletedCount: 0,
    absentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    invalidPathCount: 0,
    reclaimableFileCount: 0,
    batches: 0,
    capped: false,
    reclaimableBytes: 0,
    durationMs: 0,
    ...over,
  };
}

describe("screenshot retention cron", () => {
  let calls: RetentionCycleOptions[];
  let service: IScreenshotRetentionService;
  let release: (() => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    calls = [];
    release = null;
    service = {
      runRetentionCycle: async (o) => {
        calls.push(o);
        return result();
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fires once on start by default (the worker restarts every few jobs), then on every interval", async () => {
    const h = scheduleScreenshotRetentionCron({ service, env: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    h.stop();
  });

  it("runOnStart:false waits for the first interval", async () => {
    const h = scheduleScreenshotRetentionCron({ service, env: {}, runOnStart: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    h.stop();
  });

  it("passes the retention days from the env and enforces (dryRun false) by default", async () => {
    const h = scheduleScreenshotRetentionCron({
      service,
      env: { REFTRIX_SCREENSHOT_RETENTION_DAYS: "14" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]).toMatchObject({ retentionDays: 14, dryRun: false });
    h.stop();
  });

  it("the dry-run switch reaches the cycle, and warns on EVERY cycle in all environments (never an invisible switch-off)", async () => {
    const h = scheduleScreenshotRetentionCron({
      service,
      env: { [SCREENSHOT_RETENTION_CRON_DRY_RUN_ENV]: "true" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.dryRun)).toBe(true);
    const dryRunWarnings = vi
      .mocked(logger.warn)
      .mock.calls.filter(([message]) => String(message).includes("DRY-RUN is set"));
    expect(dryRunWarnings).toHaveLength(2);
    expect(String(dryRunWarnings[0]![0])).toContain("retention period is NOT met");
    h.stop();
  });

  it("without the switch there is no dry-run warning and the cycle enforces", async () => {
    const h = scheduleScreenshotRetentionCron({ service, env: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]!.dryRun).toBe(false);
    expect(
      vi.mocked(logger.warn).mock.calls.filter(([m]) => String(m).includes("DRY-RUN"))
    ).toHaveLength(0);
    h.stop();
  });

  it("the interval env sets the cadence of the schedule", async () => {
    const h = scheduleScreenshotRetentionCron({
      service,
      env: { [SCREENSHOT_RETENTION_INTERVAL_ENV]: String(SCREENSHOT_RETENTION_MIN_INTERVAL_MS) },
      runOnStart: false,
    });
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_MIN_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_MIN_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    h.stop();
  });

  it("an invalid retention days env: not scheduled, an error is logged, nothing runs (no silent fallback)", async () => {
    for (const bad of ["7days", "0", "-1", "abc"]) {
      const h = scheduleScreenshotRetentionCron({
        service,
        env: { REFTRIX_SCREENSHOT_RETENTION_DAYS: bad },
      });
      await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS * 2);
      await h.runOnce();
      expect(h.scheduled).toBe(false);
      h.stop();
    }
    expect(calls).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a retention days value above the maximum is clamped to the maximum and the cycle receives it", async () => {
    const h = scheduleScreenshotRetentionCron({
      service,
      env: { REFTRIX_SCREENSHOT_RETENTION_DAYS: "365" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduled).toBe(true);
    expect(calls[0]!.retentionDays).toBe(SCREENSHOT_RETENTION_MAX_DAYS);
    h.stop();
  });

  it("the dry-run switch parser: only 'true' pauses; an invalid value keeps retention enforced (with a warning)", () => {
    expect(resolveRetentionCronDryRun({ [SCREENSHOT_RETENTION_CRON_DRY_RUN_ENV]: "true" })).toBe(
      true
    );
    expect(resolveRetentionCronDryRun({})).toBe(false);
    expect(resolveRetentionCronDryRun({ [SCREENSHOT_RETENTION_CRON_DRY_RUN_ENV]: "yes" })).toBe(
      false
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
  it("interval env: bounded 5min..24h, invalid falls back to 1h with a warning", () => {
    const e = (v: string): Record<string, string> => ({ [SCREENSHOT_RETENTION_INTERVAL_ENV]: v });
    expect(resolveRetentionIntervalMs({})).toBe(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS);
    expect(resolveRetentionIntervalMs(e(String(SCREENSHOT_RETENTION_MIN_INTERVAL_MS)))).toBe(
      SCREENSHOT_RETENTION_MIN_INTERVAL_MS
    );
    expect(resolveRetentionIntervalMs(e(String(SCREENSHOT_RETENTION_MAX_INTERVAL_MS)))).toBe(
      SCREENSHOT_RETENTION_MAX_INTERVAL_MS
    );
    for (const bad of ["1", "0", "-5", "abc", "99999999999", "3600000ms"]) {
      expect(resolveRetentionIntervalMs(e(bad))).toBe(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS);
    }
    expect(logger.warn).toHaveBeenCalledTimes(6);
  });

  it("skips a tick while the previous run is still in flight (no overlap in the process)", async () => {
    service = {
      runRetentionCycle: async (o) => {
        calls.push(o);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return result();
      },
    };
    const h = scheduleScreenshotRetentionCron({ service, env: {}, runOnStart: false });
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    release?.();
    h.stop();
  });

  it("a failing cycle is non-fatal (warn) and the next tick still runs", async () => {
    let n = 0;
    service = {
      runRetentionCycle: async (o) => {
        calls.push(o);
        n += 1;
        if (n === 1) throw new Error("boom");
        return result();
      },
    };
    const h = scheduleScreenshotRetentionCron({ service, env: {}, runOnStart: false });
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalled();
    h.stop();
  });

  it("stop() clears the timer, and shouldStop turns true so an in-flight run stops between rows", async () => {
    let observed: (() => boolean) | undefined;
    service = {
      runRetentionCycle: async (o) => {
        observed = o.shouldStop;
        return result();
      },
    };
    const h = scheduleScreenshotRetentionCron({ service, env: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(observed?.()).toBe(false);
    h.stop();
    expect(observed?.()).toBe(true);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_RETENTION_DEFAULT_INTERVAL_MS * 3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
