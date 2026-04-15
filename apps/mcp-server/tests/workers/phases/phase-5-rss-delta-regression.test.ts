// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5 RSS Delta Monitoring — Regression Tests (v0.4.0 PR3)
 *
 * Stripe 事例で観測された「親 RSS が高いため子プロセスが即 self-kill する」
 * バグが、delta ベース監視への移行で再発しないことを検証する。
 *
 * Stripe バグ再現条件:
 *   - 親ワーカー Phase 0-4 完了時点の RSS: 4610 MB
 *   - 子プロセス fork 直後 (COW 継承): ~4610 MB
 *   - 子プロセス ONNX (e5-base) ロード後: ~5100 MB
 *   - 旧実装: 絶対値閾値 5120 MB 未超過だがマージン薄く即 self-kill 発動
 *   - 結果: Phase 5 embedding 0 件生成 (697 sections で 0 保存)
 *
 * v0.4.0 PR3 の delta ベース監視では、ベースライン (initialRssMb) を起動時
 * に記録し、以降は `currentRss - initialRss` で閾値判定する。親の RSS 継承
 * 分は delta=0 として除外されるため、上記シナリオでも self-kill は発動
 * しない。ONNX ロードによる delta (~500 MB) は warn 閾値 2048 MB、kill
 * 閾値 3072 MB を大きく下回る。
 *
 * Regression coverage for the Stripe bug where high parent RSS caused
 * immediate child self-kill. Verifies that delta-based monitoring prevents
 * recurrence by excluding inherited RSS from threshold comparisons.
 *
 * @module tests/workers/phases/phase-5-rss-delta-regression
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  startHeartbeat,
  stopHeartbeat,
  CHILD_RSS_WARN_DELTA_MB,
  CHILD_RSS_KILL_DELTA_MB,
} from "../../../src/workers/phases/phase-5-child-ipc";

/**
 * Collect all heartbeat-type messages pushed via process.send by the
 * startHeartbeat() tick loop.
 *
 * startHeartbeat() の tick ループが process.send で送信した heartbeat を収集する。
 */
interface HeartbeatPayload {
  type: string;
  rssMb?: number;
  rssDeltaMb?: number;
  phase?: string;
  message?: string;
}

describe("Phase 5 RSS Delta Monitoring — Regression Tests (v0.4.0 PR3)", () => {
  let originalMemoryUsage: typeof process.memoryUsage;
  let originalSend: typeof process.send;
  let originalExit: typeof process.exit;
  let sentMessages: HeartbeatPayload[];
  let rssBytesQueue: number[];
  let exitCalls: Array<number | string | null | undefined>;

  beforeEach(() => {
    vi.useFakeTimers();

    originalMemoryUsage = process.memoryUsage;
    originalSend = process.send;
    originalExit = process.exit;

    sentMessages = [];
    rssBytesQueue = [];
    exitCalls = [];

    // Stub process.memoryUsage to return a scripted RSS sequence.
    // Each call shifts a value off rssBytesQueue (fallback: last value).
    const stubbedMemoryUsage = ((): NodeJS.MemoryUsage => {
      const next = rssBytesQueue.length > 1 ? rssBytesQueue.shift()! : (rssBytesQueue[0] ?? 0);
      return {
        rss: next,
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        arrayBuffers: 0,
      };
    }) as typeof process.memoryUsage;
    // memoryUsage.rss の単独関数プロパティも維持する / preserve rss() helper
    (stubbedMemoryUsage as { rss?: () => number }).rss = (): number => rssBytesQueue[0] ?? 0;
    process.memoryUsage = stubbedMemoryUsage;

    // Stub process.send so we can assert on emitted heartbeats.
    // Also invoke the optional completion callback synchronously so that
    // sendToParentAndFlush() resolves immediately under fake timers.
    // sendToParentAndFlush() が fake timer 下でも即解決するように、
    // 任意のコールバックを同期的に呼び出す。
    process.send = ((msg: HeartbeatPayload, ...rest: unknown[]): boolean => {
      sentMessages.push(msg);
      // The Node signature is send(msg, sendHandle?, options?, callback?).
      // We locate the function argument (last callback-style arg) regardless
      // of its position and invoke it on success.
      const callback = rest.find(
        (arg): arg is (err?: Error | null) => void => typeof arg === "function"
      );
      if (callback) callback(null);
      return true;
    }) as typeof process.send;

    // Stub process.exit so self-kill does not tear down the Vitest runner.
    // We record the call but do NOT throw — otherwise an asynchronous .finally
    // callback (sendToParentAndFlush().finally(() => process.exit(1))) would
    // raise an unhandled rejection that fails the Vitest worker.
    // .finally 内で呼ばれた場合に unhandled rejection にならないよう throw しない。
    process.exit = ((code?: number | string | null): never => {
      exitCalls.push(code);
      return undefined as never;
    }) as typeof process.exit;
  });

  afterEach(() => {
    stopHeartbeat();
    vi.useRealTimers();
    process.memoryUsage = originalMemoryUsage;
    process.send = originalSend;
    process.exit = originalExit;
  });

  // ==========================================================================
  // Stripe Bug Reproduction: high parent RSS must NOT trigger child self-kill
  // ==========================================================================
  describe("Stripe バグ再現 / Stripe bug reproduction", () => {
    it("親 RSS 4610MB + 子 ONNX +500MB の条件で self-kill が発動しないこと / does NOT self-kill when child inherits high parent RSS and adds ~500MB via ONNX", () => {
      // Inherited from parent (COW): 4610 MB → initial baseline
      // After ONNX load: 4610 + 500 = 5110 MB → delta = 500 MB
      const parentInheritedRssMb = 4610;
      const onnxAddedRssMb = 500;
      const childRssAfterOnnxMb = parentInheritedRssMb + onnxAddedRssMb;

      rssBytesQueue = [
        parentInheritedRssMb * 1024 * 1024, // initial baseline capture
        childRssAfterOnnxMb * 1024 * 1024, // first tick (immediate, inside startHeartbeat)
        childRssAfterOnnxMb * 1024 * 1024, // subsequent interval ticks
      ];

      startHeartbeat("text-embedding");

      // The immediate tick emits 1 heartbeat; run the 10s interval a few times.
      vi.advanceTimersByTime(30_000);

      // Assertion 1: self-kill must NOT be invoked.
      expect(exitCalls).toHaveLength(0);

      // Assertion 2: delta reported to parent is onnxAddedRssMb (not absolute).
      const heartbeats = sentMessages.filter((m) => m.type === "heartbeat");
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
      for (const hb of heartbeats) {
        expect(hb.rssDeltaMb).toBe(onnxAddedRssMb);
        expect(hb.rssMb).toBe(childRssAfterOnnxMb);
      }

      // Assertion 3: delta remains well below kill threshold (3072MB by default).
      expect(onnxAddedRssMb).toBeLessThan(CHILD_RSS_KILL_DELTA_MB);
      expect(onnxAddedRssMb).toBeLessThan(CHILD_RSS_WARN_DELTA_MB);
    });
  });

  // ==========================================================================
  // Genuine leak: delta crossing kill threshold MUST trigger self-kill
  // ==========================================================================
  describe("真のリーク検知 / Genuine leak detection", () => {
    it("delta が kill 閾値を超えた場合に self-kill が発動すること / self-kills when RSS delta exceeds kill threshold", async () => {
      const baselineRssMb = 4000;
      // Above kill threshold: baseline + killThreshold + 100 safety margin
      const leakyRssMb = baselineRssMb + CHILD_RSS_KILL_DELTA_MB + 100;

      rssBytesQueue = [
        baselineRssMb * 1024 * 1024, // initial baseline
        leakyRssMb * 1024 * 1024, // first immediate tick triggers self-kill
      ];

      startHeartbeat("visual-embedding");

      // sendToParentAndFlush uses a Promise with .finally(process.exit(1)).
      // Flush microtasks + pending timers so the self-kill callback runs.
      // sendToParentAndFlush は Promise + .finally(process.exit(1)) を使うため、
      // microtask と pending timer を明示的にフラッシュして self-kill を起動させる。
      for (let i = 0; i < 4; i++) {
        await Promise.resolve();
      }
      await vi.runOnlyPendingTimersAsync();

      // self-kill path must have called process.exit(1)
      expect(exitCalls).toContain(1);

      // An rss-kill error message must have been sent to the parent.
      const errorMessages = sentMessages.filter((m) => m.type === "error");
      expect(errorMessages.length).toBeGreaterThanOrEqual(1);
      expect(errorMessages[0]?.phase).toBe("visual-embedding-rss-kill");
      expect(errorMessages[0]?.message).toMatch(/RSS self-kill/);
    });

    it("delta が warn 閾値を超え kill 閾値未満の場合は self-kill しないこと / warn-only path does NOT self-kill", () => {
      const baselineRssMb = 3000;
      // Between warn and kill
      const warnishRssMb = baselineRssMb + CHILD_RSS_WARN_DELTA_MB + 100;

      rssBytesQueue = [
        baselineRssMb * 1024 * 1024,
        warnishRssMb * 1024 * 1024,
        warnishRssMb * 1024 * 1024,
      ];

      startHeartbeat("text-embedding");
      vi.advanceTimersByTime(20_000);

      expect(exitCalls).toHaveLength(0);

      const heartbeats = sentMessages.filter((m) => m.type === "heartbeat");
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
      for (const hb of heartbeats) {
        expect(hb.rssDeltaMb).toBeGreaterThan(CHILD_RSS_WARN_DELTA_MB);
        expect(hb.rssDeltaMb).toBeLessThan(CHILD_RSS_KILL_DELTA_MB);
      }
    });
  });

  // ==========================================================================
  // Baseline semantics: ticks always report delta relative to initial RSS
  // ==========================================================================
  describe("ベースラインの不変性 / baseline immutability", () => {
    it("initialRssMb は最初の tick で固定され、後続の tick で更新されないこと / baseline is captured once at startHeartbeat and never updated", () => {
      const initial = 2000;
      const after1 = 2500;
      const after2 = 2800;

      rssBytesQueue = [
        initial * 1024 * 1024, // baseline (captured once)
        after1 * 1024 * 1024, // immediate tick
        after2 * 1024 * 1024, // second interval tick
      ];

      startHeartbeat("text-embedding");
      vi.advanceTimersByTime(10_000);

      const heartbeats = sentMessages.filter((m) => m.type === "heartbeat");
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      expect(heartbeats[0]?.rssDeltaMb).toBe(after1 - initial);
      expect(heartbeats[1]?.rssDeltaMb).toBe(after2 - initial);
    });

    it("stopHeartbeat 後に startHeartbeat を再度呼ぶと新しいベースラインが記録されること / stopHeartbeat + startHeartbeat re-captures baseline (TDA M-2)", () => {
      // Session 1
      rssBytesQueue = [1000 * 1024 * 1024, 1200 * 1024 * 1024];
      startHeartbeat("text-embedding");
      vi.advanceTimersByTime(0);
      stopHeartbeat();
      const firstBatch = sentMessages.filter((m) => m.type === "heartbeat").length;
      expect(firstBatch).toBeGreaterThanOrEqual(1);

      // Session 2 with different baseline
      sentMessages.length = 0;
      rssBytesQueue = [3000 * 1024 * 1024, 3100 * 1024 * 1024];
      startHeartbeat("visual-embedding");
      vi.advanceTimersByTime(0);

      const secondHeartbeats = sentMessages.filter((m) => m.type === "heartbeat");
      expect(secondHeartbeats.length).toBeGreaterThanOrEqual(1);
      expect(secondHeartbeats[0]?.rssDeltaMb).toBe(100);
      expect(secondHeartbeats[0]?.rssMb).toBe(3100);
      expect(secondHeartbeats[0]?.phase).toBe("visual-embedding");
    });
  });

  // ==========================================================================
  // SEC M-2: Non-COW environment detection
  // ==========================================================================
  describe("非 COW 環境検知 / non-COW environment detection (SEC M-2)", () => {
    it("initialRssMb < 100 の場合に警告が出力されること / logs warning when initial RSS is unexpectedly low", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        // Simulate a non-COW environment where the child did NOT inherit the
        // parent's RSS — baseline is suspiciously low (< 100 MB threshold).
        const suspiciouslyLowBaselineMb = 50;
        rssBytesQueue = [
          suspiciouslyLowBaselineMb * 1024 * 1024, // baseline capture
          suspiciouslyLowBaselineMb * 1024 * 1024, // first tick
        ];

        startHeartbeat("text-embedding");
        vi.advanceTimersByTime(0);

        // Assertion: a non-COW warning must be emitted.
        const nonCowWarnings = warnSpy.mock.calls.filter((call) => {
          const firstArg = call[0];
          return (
            typeof firstArg === "string" &&
            firstArg.includes("Unexpectedly low initial RSS") &&
            firstArg.includes("non-COW environment")
          );
        });
        expect(nonCowWarnings.length).toBeGreaterThanOrEqual(1);

        // The warning must carry the observed initialRssMb in the structured
        // payload (second argument) for operator diagnostics.
        const firstWarning = nonCowWarnings[0];
        const secondArg = firstWarning?.[1];
        expect(secondArg).toEqual({ initialRssMb: suspiciouslyLowBaselineMb });

        // Graceful degradation: heartbeat must still be sent (warning is log-only).
        const heartbeats = sentMessages.filter((m) => m.type === "heartbeat");
        expect(heartbeats.length).toBeGreaterThanOrEqual(1);

        // Self-kill MUST NOT be triggered by the warning.
        expect(exitCalls).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("initialRssMb >= 100 の場合は警告が出力されないこと / no warning when initial RSS is in the expected COW-inherited range", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        // Typical COW-inherited baseline: well above 100 MB.
        const normalBaselineMb = 1500;
        rssBytesQueue = [normalBaselineMb * 1024 * 1024, normalBaselineMb * 1024 * 1024];

        startHeartbeat("text-embedding");
        vi.advanceTimersByTime(0);

        const nonCowWarnings = warnSpy.mock.calls.filter((call) => {
          const firstArg = call[0];
          return typeof firstArg === "string" && firstArg.includes("Unexpectedly low initial RSS");
        });
        expect(nonCowWarnings).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ==========================================================================
  // Default thresholds sanity check
  // ==========================================================================
  describe("デフォルト閾値 / default thresholds", () => {
    it("デフォルトで warnDelta=2048MB / killDelta=3072MB であること / default values match design", () => {
      // When no env override is present, the module-level constants should
      // land on the documented defaults.
      expect(CHILD_RSS_WARN_DELTA_MB).toBe(2048);
      expect(CHILD_RSS_KILL_DELTA_MB).toBe(3072);
    });

    it("kill 閾値が warn 閾値より大きいこと / kill > warn invariant", () => {
      expect(CHILD_RSS_KILL_DELTA_MB).toBeGreaterThan(CHILD_RSS_WARN_DELTA_MB);
    });
  });
});
