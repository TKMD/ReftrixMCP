// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Queue Cleanup Service テスト
 * TDD Red フェーズ: バッチ投入前のキュー自動クリーンアップ機構テスト
 *
 * 目的:
 * - failed/delayed のみ選択的にクリア（waiting/completed は保護）
 * - orphaned active job の検出・クリーンアップ
 * - クリーンアップ結果のログ出力
 * - エラーハンドリング
 *
 * Note: obliterate は使用しない。waiting/completed ジョブを巻き込み
 * page.getJobStatus との不整合を引き起こすため。
 *
 * @module tests/services/queue-cleanup
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// logger をモック
vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

import {
  cleanupQueue,
  ORPHAN_THRESHOLD_MS,
  type CleanupResult,
  type CleanupOptions,
  type QueueAdapter,
  type JobInfo,
} from "../../src/services/queue-cleanup.service";

// ============================================================================
// ヘルパー: モック QueueAdapter 生成
// ============================================================================

/**
 * テスト用のモック JobInfo を生成する
 */
function createMockJobInfo(overrides?: Partial<JobInfo>): JobInfo {
  return {
    id: "job-1",
    processedOn: Date.now() - 60_000, // 1分前（orphanedではない）
    progress: 50,
    moveToCompleted: vi.fn().mockResolvedValue(undefined),
    moveToFailed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * テスト用のモック QueueAdapter を生成する
 */
function createMockQueueAdapter(overrides?: Partial<QueueAdapter>): QueueAdapter {
  return {
    getJobCounts: vi.fn().mockResolvedValue({
      active: 0,
      waiting: 0,
      failed: 0,
      delayed: 0,
      completed: 0,
      prioritized: 0,
      paused: 0,
      "waiting-children": 0,
    }),
    clean: vi.fn().mockResolvedValue([]),
    getJobs: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ============================================================================
// テストスイート
// ============================================================================

describe("QueueCleanupService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // active = 0 のケース: 選択的クリア（failed/delayed のみ）
  // ==========================================================================

  describe("active job が 0件の場合", () => {
    it("failed/delayed のみクリアし、waiting/completed は保護する", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 0,
          waiting: 5,
          failed: 3,
          delayed: 1,
          completed: 10,
          prioritized: 2,
          paused: 0,
          "waiting-children": 0,
        }),
        clean: vi
          .fn()
          .mockResolvedValueOnce(["job1", "job2", "job3"]) // failed
          .mockResolvedValueOnce(["job4"]), // delayed
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert: selective 戦略で failed/delayed のみクリア
      expect(result.success).toBe(true);
      expect(result.strategy).toBe("selective");
      expect(mockAdapter.clean).toHaveBeenCalledWith(0, 0, "failed");
      expect(mockAdapter.clean).toHaveBeenCalledWith(0, 0, "delayed");
      expect(mockAdapter.clean).not.toHaveBeenCalledWith(0, 0, "completed");
      expect(result.totalCleaned).toBe(4); // 3 failed + 1 delayed
      expect(result.beforeCounts.waiting).toBe(5);
      expect(result.beforeCounts.failed).toBe(3);
      expect(result.beforeCounts.delayed).toBe(1);
      expect(result.beforeCounts.completed).toBe(10);
    });

    it("全ステータスが0件の場合はクリーンアップをスキップする", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 0,
          waiting: 0,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert
      expect(mockAdapter.clean).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.strategy).toBe("skipped");
      expect(result.totalCleaned).toBe(0);
    });

    it("waiting/completed のみ存在する場合は clean を呼ばない（保護）", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 0,
          waiting: 5,
          failed: 0,
          delayed: 0,
          completed: 10,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert: waiting/completed は保護される
      expect(mockAdapter.clean).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.strategy).toBe("selective");
      expect(result.totalCleaned).toBe(0);
    });
  });

  // ==========================================================================
  // active > 0 のケース: 選択的クリア
  // ==========================================================================

  describe("active job が残っている場合", () => {
    it("failed/delayed のみクリアし、active/waiting/completed は触らない", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 2,
          waiting: 5,
          failed: 3,
          delayed: 1,
          completed: 8,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        clean: vi
          .fn()
          .mockResolvedValueOnce(["job1", "job2", "job3"]) // failed
          .mockResolvedValueOnce(["job4"]), // delayed
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert: cleanが呼ばれる（failed, delayed のみ。completedは呼ばれない）
      expect(mockAdapter.clean).toHaveBeenCalledWith(0, 0, "failed");
      expect(mockAdapter.clean).toHaveBeenCalledWith(0, 0, "delayed");
      expect(mockAdapter.clean).not.toHaveBeenCalledWith(0, 0, "completed");

      expect(result.success).toBe(true);
      expect(result.strategy).toBe("selective");
      expect(result.beforeCounts.active).toBe(2);
    });

    it("waiting のみ存在する場合はクリーンアップをスキップする（waiting は保護）", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 1,
          waiting: 3,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert: clean は呼ばれない
      expect(mockAdapter.clean).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.strategy).toBe("selective");
    });

    it("failed のみ存在する場合は clean(failed) のみ実行する", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 1,
          waiting: 0,
          failed: 5,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        clean: vi.fn().mockResolvedValue(["j1", "j2", "j3", "j4", "j5"]),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert
      expect(mockAdapter.clean).toHaveBeenCalledWith(0, 0, "failed");
      expect(mockAdapter.clean).toHaveBeenCalledTimes(1); // failed のみ
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // CleanupResult の検証
  // ==========================================================================

  describe("CleanupResult", () => {
    it("active=0 で failed/delayed あり時の結果が正しいフォーマットである", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 0,
          waiting: 10,
          failed: 5,
          delayed: 2,
          completed: 20,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        clean: vi
          .fn()
          .mockResolvedValueOnce(["j1", "j2", "j3", "j4", "j5"]) // failed
          .mockResolvedValueOnce(["j6", "j7"]), // delayed
      });

      // Act
      const result: CleanupResult = await cleanupQueue(mockAdapter);

      // Assert: CleanupResult の全フィールドを検証
      expect(result).toMatchObject({
        success: true,
        strategy: "selective",
        beforeCounts: {
          active: 0,
          waiting: 10,
          failed: 5,
          delayed: 2,
          completed: 20,
        },
        totalCleaned: 7, // 5 failed + 2 delayed
      });
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("selective クリーンアップ時の結果が正しいフォーマットである", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 3,
          waiting: 2,
          failed: 1,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        clean: vi.fn().mockResolvedValue(["j1"]),
      });

      // Act
      const result: CleanupResult = await cleanupQueue(mockAdapter);

      // Assert
      expect(result).toMatchObject({
        success: true,
        strategy: "selective",
        beforeCounts: {
          active: 3,
          waiting: 2,
          failed: 1,
          delayed: 0,
          completed: 0,
        },
      });
    });
  });

  // ==========================================================================
  // エラーハンドリング
  // ==========================================================================

  describe("エラーハンドリング", () => {
    it("getJobCounts がエラーを投げた場合は success: false を返す", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockRejectedValue(new Error("Redis connection refused")),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain("Redis connection refused");
      expect(result.strategy).toBe("none");
    });

    it("clean がエラーを投げた場合は success: false を返す", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 1,
          waiting: 0,
          failed: 5,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        clean: vi.fn().mockRejectedValue(new Error("Clean failed")),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain("Clean failed");
    });
  });

  // ==========================================================================
  // ログ出力
  // ==========================================================================

  describe("ログ出力", () => {
    it("selective 実行時（active=0）にクリーンアップ結果をログ出力する", async () => {
      // Arrange
      const { logger } = await import("../../src/utils/logger");
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 0,
          waiting: 5,
          failed: 3,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        clean: vi.fn().mockResolvedValue(["j1", "j2", "j3"]),
      });

      // Act
      await cleanupQueue(mockAdapter);

      // Assert: ログ出力が呼ばれている
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("[QueueCleanup]"),
        expect.objectContaining({
          strategy: "selective",
        })
      );
    });

    it("selective 実行時（active>0）にクリーンアップ結果をログ出力する", async () => {
      // Arrange
      const { logger } = await import("../../src/utils/logger");
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 2,
          waiting: 3,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
      });

      // Act
      await cleanupQueue(mockAdapter);

      // Assert
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("[QueueCleanup]"),
        expect.objectContaining({
          strategy: "selective",
        })
      );
    });

    it("スキップ時にもログ出力する", async () => {
      // Arrange
      const { logger } = await import("../../src/utils/logger");
      const mockAdapter = createMockQueueAdapter();

      // Act
      await cleanupQueue(mockAdapter);

      // Assert
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("[QueueCleanup]"),
        expect.objectContaining({
          strategy: "skipped",
        })
      );
    });

    it("エラー時にerrorログを出力する", async () => {
      // Arrange
      const { logger } = await import("../../src/utils/logger");
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockRejectedValue(new Error("Connection timeout")),
      });

      // Act
      await cleanupQueue(mockAdapter);

      // Assert
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[QueueCleanup]"),
        expect.objectContaining({
          error: expect.stringContaining("Connection timeout"),
        })
      );
    });
  });

  // ==========================================================================
  // createQueueAdapter ヘルパー
  // ==========================================================================

  describe("createQueueAdapter", () => {
    it("BullMQ Queue から QueueAdapter を生成できる", async () => {
      const { createQueueAdapter } = await import("../../src/services/queue-cleanup.service");

      // BullMQ Queue のモック
      const mockQueue = {
        getJobCounts: vi.fn().mockResolvedValue({
          active: 0,
          waiting: 0,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        clean: vi.fn().mockResolvedValue([]),
        getJobs: vi.fn().mockResolvedValue([]),
      };

      // Act
      const adapter = createQueueAdapter(
        mockQueue as unknown as Parameters<typeof createQueueAdapter>[0]
      );

      // Assert: adapter が QueueAdapter インターフェースを満たしている
      expect(typeof adapter.getJobCounts).toBe("function");
      expect(typeof adapter.clean).toBe("function");
      expect(typeof adapter.getJobs).toBe("function");
    });

    it("getJobs が BullMQ Job を JobInfo にマッピングする", async () => {
      const { createQueueAdapter } = await import("../../src/services/queue-cleanup.service");

      const mockJob = {
        id: "test-job-1",
        processedOn: 1700000000000,
        progress: 42,
        moveToCompleted: vi.fn().mockResolvedValue(undefined),
        moveToFailed: vi.fn().mockResolvedValue(undefined),
      };

      const mockQueue = {
        getJobCounts: vi.fn(),
        clean: vi.fn(),
        getJobs: vi.fn().mockResolvedValue([mockJob]),
      };

      // Act
      const adapter = createQueueAdapter(
        mockQueue as unknown as Parameters<typeof createQueueAdapter>[0]
      );
      const jobs = await adapter.getJobs("active", 0, -1);

      // Assert
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.id).toBe("test-job-1");
      expect(jobs[0]!.processedOn).toBe(1700000000000);
      expect(jobs[0]!.progress).toBe(42);
      expect(typeof jobs[0]!.moveToCompleted).toBe("function");
      expect(typeof jobs[0]!.moveToFailed).toBe("function");
    });
  });

  // ==========================================================================
  // Orphaned Active Job 検出・クリーンアップ
  // ==========================================================================

  describe("orphaned active job 検出", () => {
    it("processedOn が120分以上前かつ progress < 90 の active job を failed に移動する", async () => {
      // Arrange
      const orphanedJob = createMockJobInfo({
        id: "orphaned-1",
        processedOn: Date.now() - 8_000_000, // 120分以上前
        progress: 30,
      });

      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 1,
          waiting: 0,
          failed: 2,
          delayed: 0,
          completed: 5,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        getJobs: vi.fn().mockResolvedValue([orphanedJob]),
        clean: vi.fn().mockResolvedValue([]),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert
      expect(orphanedJob.moveToFailed).toHaveBeenCalledTimes(1);
      expect(orphanedJob.moveToFailed).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Orphaned active job") }),
        "0",
        false
      );
      expect(orphanedJob.moveToCompleted).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.orphanedActivesCleaned).toBe(1);
    });

    it("progress >= 90 の orphaned active job を completed に移動する", async () => {
      // Arrange
      const orphanedJobHighProgress = createMockJobInfo({
        id: "orphaned-high",
        processedOn: Date.now() - 8_000_000, // 120分以上前
        progress: 95,
      });

      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 1,
          waiting: 0,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        getJobs: vi.fn().mockResolvedValue([orphanedJobHighProgress]),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert
      expect(orphanedJobHighProgress.moveToCompleted).toHaveBeenCalledTimes(1);
      expect(orphanedJobHighProgress.moveToCompleted).toHaveBeenCalledWith(
        { orphanRecovered: true },
        "0",
        false
      );
      expect(orphanedJobHighProgress.moveToFailed).not.toHaveBeenCalled();
      expect(result.orphanedActivesCleaned).toBe(1);
    });

    it("orphaned active job を全てクリア後も selective 戦略を維持する", async () => {
      // Arrange
      const orphanedJob = createMockJobInfo({
        id: "orphaned-only",
        processedOn: Date.now() - 8_000_000, // 120分以上前
        progress: 20,
      });

      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 1,
          waiting: 3,
          failed: 2,
          delayed: 0,
          completed: 5,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        getJobs: vi.fn().mockResolvedValue([orphanedJob]),
        clean: vi.fn().mockResolvedValue(["f1", "f2"]),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert: selective 戦略を維持（obliterate には切り替わらない）
      expect(result.strategy).toBe("selective");
      expect(result.orphanedActivesCleaned).toBe(1);
      // failed のみクリア、waiting/completed は保護
      expect(mockAdapter.clean).toHaveBeenCalledWith(0, 0, "failed");
      expect(mockAdapter.clean).not.toHaveBeenCalledWith(0, 0, "completed");
    });

    it("processedOn が undefined の active job を orphaned と判定する", async () => {
      // Arrange
      const undefinedProcessedJob = createMockJobInfo({
        id: "undefined-processedOn",
        processedOn: undefined,
        progress: 50,
      });

      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 1,
          waiting: 0,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        getJobs: vi.fn().mockResolvedValue([undefinedProcessedJob]),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert
      expect(undefinedProcessedJob.moveToFailed).toHaveBeenCalledTimes(1);
      expect(result.orphanedActivesCleaned).toBe(1);
    });

    it("processedOn が60分以内の active job は保護する（orphanedではない）", async () => {
      // Arrange
      const recentJob = createMockJobInfo({
        id: "recent-active",
        processedOn: Date.now() - 60_000, // 1分前
        progress: 50,
      });

      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 1,
          waiting: 0,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        getJobs: vi.fn().mockResolvedValue([recentJob]),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert: 保護される（moveToFailed/moveToCompleted 呼ばれない）
      expect(recentJob.moveToFailed).not.toHaveBeenCalled();
      expect(recentJob.moveToCompleted).not.toHaveBeenCalled();
      expect(result.orphanedActivesCleaned).toBe(0);
      expect(result.strategy).toBe("selective");
    });

    it("orphanedActivesCleaned が CleanupResult に含まれる", async () => {
      // Arrange: orphaned job なし
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 0,
          waiting: 5,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
      });

      // Act
      const result: CleanupResult = await cleanupQueue(mockAdapter);

      // Assert: orphanedActivesCleaned が常に含まれる
      expect(result).toHaveProperty("orphanedActivesCleaned");
      expect(result.orphanedActivesCleaned).toBe(0);
    });

    it("getJobs がエラーを投げた場合は orphaned 検出をスキップし既存の selective を続行する", async () => {
      // Arrange
      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 1,
          waiting: 3,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        getJobs: vi.fn().mockRejectedValue(new Error("getJobs failed")),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert: selective戦略が成功で完了する
      expect(result.success).toBe(true);
      expect(result.strategy).toBe("selective");
      expect(result.orphanedActivesCleaned).toBe(0);
    });

    it("カスタム閾値（orphanThresholdMs）でorphaned判定を変更できる", async () => {
      // Arrange: 5分前のjob。デフォルト閾値(120分)ではorphanedではないが、
      // カスタム閾値(1分)ではorphanedと判定される
      const fiveMinAgoJob = createMockJobInfo({
        id: "custom-threshold",
        processedOn: Date.now() - 300_000, // 5分前
        progress: 50,
      });

      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 1,
          waiting: 0,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        getJobs: vi.fn().mockResolvedValue([fiveMinAgoJob]),
      });

      // Act: カスタム閾値 60_000ms (1分) を指定
      const result = await cleanupQueue(mockAdapter, { orphanThresholdMs: 60_000 });

      // Assert: 5分前のjobは1分閾値でorphanedと判定される
      expect(fiveMinAgoJob.moveToFailed).toHaveBeenCalledTimes(1);
      expect(result.orphanedActivesCleaned).toBe(1);
    });

    it("orphaned active と non-orphaned active が混在する場合、orphanedのみクリアする", async () => {
      // Arrange
      const orphanedJob = createMockJobInfo({
        id: "orphaned-mix",
        processedOn: Date.now() - 8_000_000, // 120分以上前
        progress: 40,
      });
      const activeJob = createMockJobInfo({
        id: "active-mix",
        processedOn: Date.now() - 60_000, // 1分前
        progress: 60,
      });

      const mockAdapter = createMockQueueAdapter({
        getJobCounts: vi.fn().mockResolvedValue({
          active: 2,
          waiting: 1,
          failed: 0,
          delayed: 0,
          completed: 0,
          prioritized: 0,
          paused: 0,
          "waiting-children": 0,
        }),
        getJobs: vi.fn().mockResolvedValue([orphanedJob, activeJob]),
      });

      // Act
      const result = await cleanupQueue(mockAdapter);

      // Assert: orphanedのみクリア、activeは保護
      expect(orphanedJob.moveToFailed).toHaveBeenCalledTimes(1);
      expect(activeJob.moveToFailed).not.toHaveBeenCalled();
      expect(activeJob.moveToCompleted).not.toHaveBeenCalled();
      expect(result.orphanedActivesCleaned).toBe(1);
      expect(result.strategy).toBe("selective");
    });
  });

  // ==========================================================================
  // ORPHAN_THRESHOLD_MS 定数
  // ==========================================================================

  describe("ORPHAN_THRESHOLD_MS", () => {
    it("デフォルト値が 7,200,000ms（120分）である", () => {
      expect(ORPHAN_THRESHOLD_MS).toBe(7_200_000);
    });
  });
});
