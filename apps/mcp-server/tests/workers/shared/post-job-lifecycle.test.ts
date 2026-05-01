// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * applyPostJobMemoryGate — Unit Tests
 *
 * v0.4.0 PR7e-β2 hotfix + β2 audit carryover: pause/resume 経路を完全削除し、
 * RSS 閾値ゲートのみを残した実装の動作検証。関数名も
 * `applyPreReturnPauseAndMemoryGate` → `applyPostJobMemoryGate` にリネームし、
 * `workerRef` 引数も削除したため、シグネチャは `(enabled, loggerPrefix)` の
 * 2 引数に簡略化された。BullMQ 5.66.5 `Worker.resume()` の silent no-op race
 * を避けるため、Worker 側の pause/resume はもはや呼び出さない。
 *
 * Verifies the hotfix + β2 audit carryover that removed the pause/resume path
 * entirely, renamed the helper to `applyPostJobMemoryGate`, and dropped the
 * `workerRef` argument (signature simplified to `(enabled, loggerPrefix)`).
 * Avoids the BullMQ 5.66.5 `Worker.resume()` silent no-op race by never
 * calling pause/resume from the Worker side.
 *
 * ## カバー範囲 / Coverage
 *
 * - `enabled=false` 経路（WORKER_MAX_JOBS_BEFORE_RESTART=0 相当）で memCheck も
 *   exit も呼ばれないこと — M8 TC
 * - `enabled=true` + RSS 閾値未満 → no-op（shouldExitForMemory は呼ばれるが exit はしない）
 * - `enabled=true` + RSS 閾値超過 → `process.exit(0)`
 * - exit ログに loggerPrefix が含まれること
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { applyPostJobMemoryGate } from "../../../src/workers/shared/post-job-lifecycle";

// ============================================================================
// Mocks
// ============================================================================

vi.mock("../../../src/services/worker-memory-monitor.service", () => ({
  shouldExitForMemory: vi.fn(),
}));

vi.mock("../../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  isDevelopment: vi.fn(() => false),
}));

import { shouldExitForMemory } from "../../../src/services/worker-memory-monitor.service";
import { logger } from "../../../src/utils/logger";

// ============================================================================
// Tests
// ============================================================================

describe("applyPostJobMemoryGate (v0.4.0 PR7e-β2 hotfix + audit carryover)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // process.exit を stub してテストプロセスが落ちないようにする
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__process_exit__");
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  // ==========================================================================
  // M8: enabled=false 経路（WORKER_MAX_JOBS_BEFORE_RESTART=0 相当）
  // ==========================================================================
  describe("M8: enabled=false (WORKER_MAX_JOBS_BEFORE_RESTART=0)", () => {
    it("enabled=false のとき memCheck/exit が一切呼ばれないこと / should be a full no-op when disabled", async () => {
      (shouldExitForMemory as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldExit: true,
        rssMb: 99_999,
      });

      await applyPostJobMemoryGate(false, "[Test]");

      expect(shouldExitForMemory).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // RSS 閾値未満: shouldExitForMemory は呼ばれるが exit はしない
  // ==========================================================================
  describe("RSS below threshold → no-op (BullMQ 5.66.5 resume race guard)", () => {
    it("RSS 閾値未満で exit されず shouldExitForMemory のみ呼ばれること / should NOT exit when RSS is below threshold, but shouldExitForMemory must be consulted", async () => {
      (shouldExitForMemory as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldExit: false,
        rssMb: 1024,
      });

      await applyPostJobMemoryGate(true, "[Test]");

      // pause/resume を呼ぶと BullMQ 5.66.5 resume() race で silent no-op になるため
      //   根本的に呼ばない設計に変更。mainLoop が自然に次ジョブを fetch する。
      //   ヘルパー側にはもはや pause/resume を呼ぶコードパスが存在しないため、
      //   ここでは shouldExitForMemory が呼ばれた上で exit されないことだけを確認する。
      expect(shouldExitForMemory).toHaveBeenCalledTimes(1);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // RSS 閾値超過: process.exit(0) のみ
  // ==========================================================================
  describe("RSS above threshold → process.exit(0)", () => {
    it("RSS 閾値超過で process.exit(0) が呼ばれること / should exit(0) when RSS exceeds threshold", async () => {
      (shouldExitForMemory as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldExit: true,
        rssMb: 13_000,
      });

      await expect(applyPostJobMemoryGate(true, "[Test]")).rejects.toThrow("__process_exit__");

      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  // ==========================================================================
  // Logger prefix propagation
  // ==========================================================================
  describe("loggerPrefix propagation", () => {
    it("loggerPrefix が exit ログメッセージに含まれること / loggerPrefix must appear in exit log messages", async () => {
      (shouldExitForMemory as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldExit: true,
        rssMb: 13_000,
      });

      await expect(applyPostJobMemoryGate(true, "[EmbeddingBackfillWorker]")).rejects.toThrow(
        "__process_exit__"
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[EmbeddingBackfillWorker]"),
        expect.objectContaining({
          rssMb: 13_000,
        })
      );
    });
  });
});
