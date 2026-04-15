// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * applyPreReturnPauseAndMemoryGate — Unit Tests
 *
 * v0.4.0 PR7c: Pre-Return Pause + Memory-Gated Exit/Resume helper の動作検証。
 *
 * Verifies the Pre-Return Pause + memory-gated exit/resume helper introduced
 * in v0.4.0 PR7c.
 *
 * ## カバー範囲 / Coverage
 *
 * - `enabled=false` 経路（WORKER_MAX_JOBS_BEFORE_RESTART=0 相当）で pause/resume/exit が
 *   一切呼ばれないこと — M8 TC
 * - `enabled=true` + RSS 閾値未満 → pause → resume（exit なし）— バグ1 regression guard
 * - `enabled=true` + RSS 閾値超過 → pause → process.exit(0)（resume なし）
 * - pause() 例外が sanitizeErrorMessage 経由でログされること — M2 CWE-209
 * - resume() 例外が sanitizeErrorMessage 経由でログされること — M2 CWE-209
 * - workerRef=null 時に no-op となること
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Worker } from "bullmq";

import { applyPreReturnPauseAndMemoryGate } from "../../../src/workers/shared/post-job-lifecycle";

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

vi.mock("../../../src/utils/sanitize-error", () => ({
  sanitizeErrorMessage: vi.fn(
    (err: unknown) => `sanitized:${String((err as Error)?.message ?? err)}`
  ),
}));

import { shouldExitForMemory } from "../../../src/services/worker-memory-monitor.service";
import { logger } from "../../../src/utils/logger";
import { sanitizeErrorMessage } from "../../../src/utils/sanitize-error";

// ============================================================================
// Helpers
// ============================================================================

interface MockWorker {
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

function createMockWorker(overrides?: Partial<MockWorker>): Worker {
  const worker: MockWorker = {
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return worker as unknown as Worker;
}

// ============================================================================
// Tests
// ============================================================================

describe("applyPreReturnPauseAndMemoryGate", () => {
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
    it("enabled=false のとき pause/resume/exit が一切呼ばれないこと / should be a full no-op when disabled", async () => {
      const worker = createMockWorker();
      (shouldExitForMemory as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldExit: true,
        rssMb: 99_999,
      });

      await applyPreReturnPauseAndMemoryGate(worker, false, "[Test]");

      expect((worker as unknown as MockWorker).pause).not.toHaveBeenCalled();
      expect((worker as unknown as MockWorker).resume).not.toHaveBeenCalled();
      expect(shouldExitForMemory).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("workerRef=null のとき no-op となること / should be a no-op when workerRef is null", async () => {
      await applyPreReturnPauseAndMemoryGate(null, true, "[Test]");

      expect(shouldExitForMemory).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // バグ1 Regression: RSS 未満で resume が呼ばれること
  // ==========================================================================
  describe("Bug 1 regression: RSS below threshold → resume", () => {
    it("RSS 閾値未満で pause → resume が呼ばれ exit されないこと / should pause then resume and NOT exit when RSS is below threshold", async () => {
      const worker = createMockWorker();
      (shouldExitForMemory as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldExit: false,
        rssMb: 1024,
      });

      await applyPreReturnPauseAndMemoryGate(worker, true, "[Test]");

      const mockWorker = worker as unknown as MockWorker;
      expect(mockWorker.pause).toHaveBeenCalledWith(true);
      expect(mockWorker.resume).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();

      // pause 呼び出し順序: pause → shouldExitForMemory → resume
      const pauseOrder = mockWorker.pause.mock.invocationCallOrder[0]!;
      const resumeOrder = mockWorker.resume.mock.invocationCallOrder[0]!;
      expect(pauseOrder).toBeLessThan(resumeOrder);
    });
  });

  // ==========================================================================
  // RSS 閾値超過で exit が呼ばれること
  // ==========================================================================
  describe("RSS above threshold → process.exit(0)", () => {
    it("RSS 閾値超過で pause → process.exit(0) が呼ばれ resume されないこと / should pause then exit(0) and NOT resume when RSS exceeds threshold", async () => {
      const worker = createMockWorker();
      (shouldExitForMemory as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldExit: true,
        rssMb: 13_000,
      });

      await expect(applyPreReturnPauseAndMemoryGate(worker, true, "[Test]")).rejects.toThrow(
        "__process_exit__"
      );

      const mockWorker = worker as unknown as MockWorker;
      expect(mockWorker.pause).toHaveBeenCalledWith(true);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(mockWorker.resume).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // M2: sanitizeErrorMessage (CWE-209)
  // ==========================================================================
  describe("M2: CWE-209 error sanitization", () => {
    it("pause() 例外が sanitizeErrorMessage 経由でログされること / pause() exceptions must go through sanitizeErrorMessage", async () => {
      const pauseError = new Error("redis command EVALSHA failed: jobId 0192abcd...");
      const worker = createMockWorker({
        pause: vi.fn().mockRejectedValue(pauseError),
      });
      (shouldExitForMemory as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldExit: false,
        rssMb: 1024,
      });

      await applyPreReturnPauseAndMemoryGate(worker, true, "[Test]");

      expect(sanitizeErrorMessage).toHaveBeenCalledWith(pauseError);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Pre-return pause failed"),
        expect.objectContaining({
          error: expect.stringContaining("sanitized:"),
        })
      );
      // pause 失敗後も memory check + resume は続行される
      expect(shouldExitForMemory).toHaveBeenCalled();
      expect((worker as unknown as MockWorker).resume).toHaveBeenCalled();
    });

    it("resume() 例外が sanitizeErrorMessage 経由でログされること / resume() exceptions must go through sanitizeErrorMessage", async () => {
      const resumeError = new Error("redis SUBSCRIBE timeout: key bull:page-analyze:...");
      const worker = createMockWorker({
        resume: vi.fn().mockRejectedValue(resumeError),
      });
      (shouldExitForMemory as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldExit: false,
        rssMb: 1024,
      });

      await applyPreReturnPauseAndMemoryGate(worker, true, "[Test]");

      expect(sanitizeErrorMessage).toHaveBeenCalledWith(resumeError);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Worker resume failed"),
        expect.objectContaining({
          error: expect.stringContaining("sanitized:"),
        })
      );
    });
  });

  // ==========================================================================
  // Logger prefix propagation
  // ==========================================================================
  describe("loggerPrefix propagation", () => {
    it("loggerPrefix がログメッセージに含まれること / loggerPrefix must appear in log messages", async () => {
      const worker = createMockWorker({
        resume: vi.fn().mockRejectedValue(new Error("boom")),
      });
      (shouldExitForMemory as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldExit: false,
        rssMb: 1024,
      });

      await applyPreReturnPauseAndMemoryGate(worker, true, "[EmbeddingBackfillWorker]");

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[EmbeddingBackfillWorker]"),
        expect.any(Object)
      );
    });
  });
});
