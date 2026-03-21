// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Memory Monitor Service テスト
 *
 * ワーカープロセスのメモリ自己監視機能のテスト。
 * RSSメモリ使用量をチェックし、閾値超過時にgraceful exitする。
 *
 * テスト対象:
 * 1. shouldExitForMemory — RSS閾値チェック（正常系・超過系）
 * 2. performMemoryCheckAndExit — 閾値超過時のprocess.exit(0)呼び出し
 * 3. 環境変数オーバーライド — WORKER_SELF_EXIT_THRESHOLD_MB
 * 4. GCトリガー — global.gcが利用可能な場合の呼び出し
 *
 * @module tests/services/worker-memory-monitor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// モック設定
// ============================================================================

// loggerモック
vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// worker-memory-profileモック（resolveMemoryConfig）
vi.mock("../../src/services/worker-memory-profile", () => ({
  resolveMemoryConfig: vi.fn().mockReturnValue({
    totalMemoryMb: 32768,
    degradationThresholdMb: 12288,
    criticalThresholdMb: 14336,
    selfExitThresholdMb: 12288,
    maxOldSpaceSizeMb: 8192,
    embeddingChunkSize: 30,
    jsAnimationEmbeddingChunkSize: 50,
    dinov2ChunkSize: 15,
    partExtractionEnabled: true,
    partExtractionRssLimit: 16 * 1024 * 1024 * 1024,
    tier: "32gb",
  }),
  computeMemoryProfile: vi.fn().mockReturnValue({
    totalMemoryMb: 32768,
    degradationThresholdMb: 12288,
    criticalThresholdMb: 14336,
    selfExitThresholdMb: 12288,
    maxOldSpaceSizeMb: 8192,
    embeddingChunkSize: 30,
    jsAnimationEmbeddingChunkSize: 50,
    dinov2ChunkSize: 15,
    partExtractionEnabled: true,
    partExtractionRssLimit: 16 * 1024 * 1024 * 1024,
    tier: "32gb",
  }),
}));

// ============================================================================
// テストスイート
// ============================================================================

describe("WorkerMemoryMonitor", () => {
  let originalEnv: string | undefined;
  let originalGc: typeof global.gc;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // 環境変数のバックアップ
    originalEnv = process.env.WORKER_SELF_EXIT_THRESHOLD_MB;
    delete process.env.WORKER_SELF_EXIT_THRESHOLD_MB;
    // global.gcのバックアップ
    originalGc = global.gc;
    // process.exitのモック（実際にプロセスを終了させない）
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    // 環境変数の復元
    if (originalEnv !== undefined) {
      process.env.WORKER_SELF_EXIT_THRESHOLD_MB = originalEnv;
    } else {
      delete process.env.WORKER_SELF_EXIT_THRESHOLD_MB;
    }
    // global.gcの復元
    global.gc = originalGc;
    exitSpy.mockRestore();
    vi.resetModules();
  });

  // ==========================================================================
  // shouldExitForMemory
  // ==========================================================================

  describe("shouldExitForMemory", () => {
    it("RSSが閾値以下の場合、shouldExit=falseを返す", async () => {
      // Arrange: RSSを500MBにモック（閾値12288MBより十分低い）
      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 500 * 1024 * 1024, // 500MB
        heapTotal: 200 * 1024 * 1024,
        heapUsed: 150 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      const result = shouldExitForMemory();

      // Assert
      expect(result.shouldExit).toBe(false);
      expect(result.rssMb).toBe(500);

      memUsageSpy.mockRestore();
    });

    it("RSSが閾値を超えた場合、shouldExit=trueを返す", async () => {
      // Arrange: RSSを13000MBにモック（閾値12288MBを超過）
      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 13000 * 1024 * 1024, // 13000MB
        heapTotal: 10000 * 1024 * 1024,
        heapUsed: 9500 * 1024 * 1024,
        external: 1000 * 1024 * 1024,
        arrayBuffers: 500 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      const result = shouldExitForMemory();

      // Assert
      expect(result.shouldExit).toBe(true);
      expect(result.rssMb).toBe(13000);

      memUsageSpy.mockRestore();
    });

    it("RSSが閾値と一致する場合、shouldExit=falseを返す（> 条件のため）", async () => {
      // Arrange: RSSを12288MBにモック（閾値と一致）
      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 12288 * 1024 * 1024, // 12288MB（閾値と同じ）
        heapTotal: 8000 * 1024 * 1024,
        heapUsed: 7500 * 1024 * 1024,
        external: 1000 * 1024 * 1024,
        arrayBuffers: 500 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      const result = shouldExitForMemory();

      // Assert: > threshold が条件なので、= では false
      expect(result.shouldExit).toBe(false);
      expect(result.rssMb).toBe(12288);

      memUsageSpy.mockRestore();
    });

    it("rssMbはMB単位で四捨五入された値を返す", async () => {
      // Arrange: 1.5GBをバイト換算で設定（端数テスト）
      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 1536 * 1024 * 1024, // 1536MB (1.5GB)
        heapTotal: 500 * 1024 * 1024,
        heapUsed: 400 * 1024 * 1024,
        external: 50 * 1024 * 1024,
        arrayBuffers: 20 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      const result = shouldExitForMemory();

      // Assert
      expect(result.rssMb).toBe(1536);

      memUsageSpy.mockRestore();
    });

    it("global.gcが利用可能な場合、チェック前にGCを実行する", async () => {
      // Arrange
      const mockGc = vi.fn();
      global.gc = mockGc;

      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 500 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        heapUsed: 150 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      shouldExitForMemory();

      // Assert: GCが呼ばれた
      expect(mockGc).toHaveBeenCalledTimes(1);

      memUsageSpy.mockRestore();
    });

    it("global.gcが利用不可能でもエラーにならない", async () => {
      // Arrange: global.gcを削除
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).gc = undefined;

      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 500 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        heapUsed: 150 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act & Assert: エラーなしで結果を返す
      const result = shouldExitForMemory();
      expect(result.shouldExit).toBe(false);
      expect(result.rssMb).toBe(500);

      memUsageSpy.mockRestore();
    });
  });

  // ==========================================================================
  // performMemoryCheckAndExit
  // ==========================================================================

  describe("performMemoryCheckAndExit", () => {
    it("閾値以下の場合、process.exitを呼ばない", async () => {
      // Arrange: RSSを500MBにモック
      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 500 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        heapUsed: 150 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const { performMemoryCheckAndExit } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      performMemoryCheckAndExit();

      // Assert
      expect(exitSpy).not.toHaveBeenCalled();

      memUsageSpy.mockRestore();
    });

    it("閾値超過時にprocess.exit(0)を呼ぶ（graceful exit）", async () => {
      // Arrange: RSSを15000MBにモック
      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 15000 * 1024 * 1024,
        heapTotal: 10000 * 1024 * 1024,
        heapUsed: 9500 * 1024 * 1024,
        external: 2000 * 1024 * 1024,
        arrayBuffers: 1000 * 1024 * 1024,
      });

      const { performMemoryCheckAndExit } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      performMemoryCheckAndExit();

      // Assert: exit code 0 で呼ばれる（OOMキラーではなくgraceful exit）
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(exitSpy).toHaveBeenCalledTimes(1);

      memUsageSpy.mockRestore();
    });

    it("ログに現在のRSS値と閾値が含まれる", async () => {
      const { logger } = await import("../../src/utils/logger");
      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 500 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        heapUsed: 150 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const { performMemoryCheckAndExit } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      performMemoryCheckAndExit();

      // Assert: infoログにrssMbとthresholdMbが含まれる
      expect(logger.info).toHaveBeenCalledWith(
        "[WorkerMemoryMonitor] Memory check",
        expect.objectContaining({
          rssMb: 500,
          shouldExit: false,
        })
      );

      memUsageSpy.mockRestore();
    });

    it("閾値超過時にwarnログを出力する", async () => {
      const { logger } = await import("../../src/utils/logger");
      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 15000 * 1024 * 1024,
        heapTotal: 10000 * 1024 * 1024,
        heapUsed: 9500 * 1024 * 1024,
        external: 2000 * 1024 * 1024,
        arrayBuffers: 1000 * 1024 * 1024,
      });

      const { performMemoryCheckAndExit } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      performMemoryCheckAndExit();

      // Assert: warnログが出力される
      expect(logger.warn).toHaveBeenCalledWith(
        "[WorkerMemoryMonitor] Memory threshold exceeded, graceful exit",
        expect.objectContaining({
          rssMb: 15000,
        })
      );

      memUsageSpy.mockRestore();
    });
  });

  // ==========================================================================
  // 環境変数オーバーライド
  // ==========================================================================

  describe("環境変数オーバーライド（WORKER_SELF_EXIT_THRESHOLD_MB）", () => {
    it("環境変数で閾値を低く設定するとexitが発生する", async () => {
      // Arrange: 環境変数で閾値を300MBに設定
      process.env.WORKER_SELF_EXIT_THRESHOLD_MB = "300";

      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 500 * 1024 * 1024, // 500MB（デフォルト12288MB以下だが300MB超過）
        heapTotal: 200 * 1024 * 1024,
        heapUsed: 150 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      const result = shouldExitForMemory();

      // Assert: 環境変数の閾値300MBを超過しているのでtrue
      expect(result.shouldExit).toBe(true);
      expect(result.rssMb).toBe(500);

      memUsageSpy.mockRestore();
    });

    it("環境変数で閾値を高く設定するとexitが発生しない", async () => {
      // Arrange: 環境変数で閾値を20000MBに設定
      process.env.WORKER_SELF_EXIT_THRESHOLD_MB = "20000";

      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 15000 * 1024 * 1024, // 15000MB（デフォルト12288MB超過だが20000MB以下）
        heapTotal: 10000 * 1024 * 1024,
        heapUsed: 9500 * 1024 * 1024,
        external: 2000 * 1024 * 1024,
        arrayBuffers: 1000 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      const result = shouldExitForMemory();

      // Assert: 環境変数の閾値20000MB以下なのでfalse
      expect(result.shouldExit).toBe(false);
      expect(result.rssMb).toBe(15000);

      memUsageSpy.mockRestore();
    });

    it("環境変数が空文字列の場合、デフォルト閾値を使用する", async () => {
      // Arrange
      process.env.WORKER_SELF_EXIT_THRESHOLD_MB = "";

      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 500 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        heapUsed: 150 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      const result = shouldExitForMemory();

      // Assert: デフォルト閾値12288MB以下なのでfalse
      expect(result.shouldExit).toBe(false);

      memUsageSpy.mockRestore();
    });

    it("環境変数が非数値の場合、デフォルト閾値を使用する", async () => {
      // Arrange
      process.env.WORKER_SELF_EXIT_THRESHOLD_MB = "not-a-number";

      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 500 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        heapUsed: 150 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      const result = shouldExitForMemory();

      // Assert: デフォルト閾値を使用
      expect(result.shouldExit).toBe(false);

      memUsageSpy.mockRestore();
    });

    it("環境変数が0以下の場合、デフォルト閾値を使用する", async () => {
      // Arrange
      process.env.WORKER_SELF_EXIT_THRESHOLD_MB = "-100";

      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 500 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        heapUsed: 150 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      const result = shouldExitForMemory();

      // Assert: デフォルト閾値を使用（負数は無視）
      expect(result.shouldExit).toBe(false);

      memUsageSpy.mockRestore();
    });
  });

  // ==========================================================================
  // MemoryCheckResult型
  // ==========================================================================

  describe("MemoryCheckResult型", () => {
    it("shouldExitとrssMbの両方がMemoryCheckResultに含まれる", async () => {
      const memUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 1024 * 1024 * 1024, // 1GB
        heapTotal: 500 * 1024 * 1024,
        heapUsed: 400 * 1024 * 1024,
        external: 50 * 1024 * 1024,
        arrayBuffers: 20 * 1024 * 1024,
      });

      const { shouldExitForMemory } =
        await import("../../src/services/worker-memory-monitor.service");

      // Act
      const result = shouldExitForMemory();

      // Assert: 戻り値の構造を検証
      expect(result).toHaveProperty("shouldExit");
      expect(result).toHaveProperty("rssMb");
      expect(typeof result.shouldExit).toBe("boolean");
      expect(typeof result.rssMb).toBe("number");
      expect(result.rssMb).toBe(1024);

      memUsageSpy.mockRestore();
    });
  });
});
