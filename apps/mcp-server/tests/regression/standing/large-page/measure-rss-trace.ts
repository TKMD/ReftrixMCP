// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RSS Measurement Helper — PR-V3-T1a F-PLAN-V3-T1A-M-10 closure
 *
 * Per-chunk peak RSS measurement instrumentation for INV-PHASE5-RSS-BUDGET-001
 * (large-page domain). Provides 2-strategy sampling so tests can verify the
 * per-chunk RSS budget contract without depending on the full Phase 5 fork
 * harness:
 *
 *   1. **Polling-based trace** (`startPollingRssTrace`): periodic
 *      `process.memoryUsage().rss` snapshots at a configurable interval
 *      (default 50 ms). Suitable for in-process observation; misses
 *      sub-interval intra-chunk peaks.
 *   2. **Resource-usage peak** (`captureMaxRssDelta`): wraps an async
 *      operation and reports `process.resourceUsage().maxRSS` delta in MB.
 *      Captures intra-call peaks at OS granularity but only as a single
 *      end-of-call value.
 *
 * Trade-off (per F-PLAN-V3-T1A-M-10 design): polling miss windows ≤ 50 ms
 * are acceptable for INV-PHASE5-RSS-BUDGET-001 because the per-chunk budget
 * (1.5 GB) is large relative to typical sub-50 ms allocation amplitudes;
 * Cases that require true peak observation use `captureMaxRssDelta`.
 *
 * RSS measurement helpers for INV-PHASE5-RSS-BUDGET-001. Two strategies:
 * polling (50 ms interval, may miss sub-interval peaks) and resource-usage
 * delta (intra-call peak via `process.resourceUsage().maxRSS`).
 *
 * @see  F-PLAN-V3-T1A-M-10
 * @see  §3.2 C1
 * @see tests/regression/standing/large-page/inv-phase5-rss-budget-001.test.ts
 *
 * @module tests/regression/standing/large-page/measure-rss-trace
 */

const BYTES_PER_MB = 1024 * 1024;

/**
 * Polling-based RSS trace handle returned by `startPollingRssTrace()`.
 *
 * Polling-based RSS trace handle.
 */
export interface PollingRssTrace {
  /**
   * Stop the polling timer and return the collected samples (timestamps in
   * ms since trace start, RSS in MB).
   *
   * Stop polling and return collected samples.
   */
  stop: () => Array<{ tMs: number; rssMb: number }>;
  /** Peak RSS observed across all samples so far (MB). */
  peakRssMb: () => number;
  /** Number of samples collected so far. */
  sampleCount: () => number;
}

/**
 * Start a polling RSS trace at the given sampling interval (ms).
 *
 * Caller must call `.stop()` to release the timer; samples are returned at
 * stop time. Suitable for tests that exercise INV-PHASE5-RSS-BUDGET-001
 * Cases 1-3 (chunk-size sweep) where the per-chunk runtime is comfortably
 * larger than the polling interval.
 *
 * Start polling RSS trace; default 50 ms interval.
 *
 * @param intervalMs sampling interval in ms (default 50)
 */
export function startPollingRssTrace(intervalMs: number = 50): PollingRssTrace {
  // Defensive: clamp interval into a sane band so a NaN / Infinity / 0
  // argument doesn't burn CPU or never sample.
  const safeInterval =
    Number.isFinite(intervalMs) && intervalMs >= 1 && intervalMs <= 60_000 ? intervalMs : 50;
  const samples: Array<{ tMs: number; rssMb: number }> = [];
  const startedAt = Date.now();
  let peak = 0;
  const handle = setInterval(() => {
    const rssMb = Math.round(process.memoryUsage().rss / BYTES_PER_MB);
    const tMs = Date.now() - startedAt;
    samples.push({ tMs, rssMb });
    if (rssMb > peak) peak = rssMb;
  }, safeInterval);
  // Allow Node to exit even if the test forgot to stop the trace.
  if (typeof handle.unref === "function") handle.unref();
  return {
    stop: () => {
      clearInterval(handle);
      return samples.slice();
    },
    peakRssMb: () => peak,
    sampleCount: () => samples.length,
  };
}

/**
 * Capture the intra-call peak RSS delta (MB) of an async operation using
 * `process.resourceUsage().maxRSS`.
 *
 * `maxRSS` is reported in **kilobytes** by Node.js on Linux/macOS (per
 * `process.resourceUsage()` docs); we convert to MB. The delta is post − pre,
 * clamped to ≥ 0 (a negative delta could occur if the OS released pages
 * across the call boundary; clamp protects callers from sign confusion).
 *
 * Capture intra-call peak RSS delta (MB) via `process.resourceUsage().maxRSS`.
 *
 * @param fn async operation to measure
 * @returns object with `peakDeltaMb` and the resolved value of `fn()`
 */
export async function captureMaxRssDelta<T>(
  fn: () => Promise<T>
): Promise<{ peakDeltaMb: number; value: T }> {
  const preKb = process.resourceUsage().maxRSS;
  const value = await fn();
  const postKb = process.resourceUsage().maxRSS;
  // maxRSS is reported in KB on Linux/macOS; convert to MB.
  const deltaKb = Math.max(0, postKb - preKb);
  const peakDeltaMb = Math.round(deltaKb / 1024);
  return { peakDeltaMb, value };
}

/**
 * Convenience: run an async op and assert its peak delta stays under a
 * budget (MB). Throws an `Error` on overshoot. Used by the standing
 * regression test when wiring is straightforward; tests with multi-stage
 * tracking use `captureMaxRssDelta` directly.
 *
 * Run async op and assert peak RSS delta ≤ budget MB.
 */
export async function assertPeakRssDeltaUnderBudget<T>(
  fn: () => Promise<T>,
  budgetMb: number,
  label: string = "operation"
): Promise<T> {
  const { peakDeltaMb, value } = await captureMaxRssDelta(fn);
  if (peakDeltaMb > budgetMb) {
    throw new Error(
      `[measure-rss-trace] ${label}: peak RSS delta ${peakDeltaMb} MB > budget ${budgetMb} MB`
    );
  }
  return value;
}
