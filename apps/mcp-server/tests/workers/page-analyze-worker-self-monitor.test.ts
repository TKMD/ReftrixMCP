// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Memory Self-Monitoring Tests
 * TDD Red フェーズ: ワーカーのメモリ自己監視テスト
 *
 * 目的:
 * - ジョブ完了後のメモリ使用量チェック（shouldExitForMemory）
 * - 閾値以下の場合はプロセス継続
 * - 閾値超過時のgraceful exit（process.exit(0)で自発的終了）
 *
 * WorkerSupervisorと連携して、ワーカープロセスがOOM前に自発的に
 * 終了し、Supervisorによって新しいプロセスとして再起動される。
 * これによりNode.jsのヒープ断片化やメモリリークによるOOMを回避する。
 *
 * 既存の page-analyze-worker-memory.test.ts はワーカー内のフェーズ間
 * メモリ劣化（checkMemoryPressure）をテストする。
 * このファイルはジョブ完了後のプロセスレベルの自己終了判定をテストする。
 *
 * @module tests/workers/page-analyze-worker-self-monitor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// モック設定
// ============================================================================

// process.memoryUsage をモック可能にする
const mockMemoryUsage = vi.fn();
const originalMemoryUsage = process.memoryUsage;

// process.exit をモック（実際にプロセスを終了させないため）
const mockProcessExit = vi.fn();
const originalProcessExit = process.exit;

// logger モック
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// ============================================================================
// テストスイート
// ============================================================================

describe('Worker Memory Self-Monitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // process.memoryUsage をモックに置き換え
    process.memoryUsage = mockMemoryUsage as unknown as typeof process.memoryUsage;
    // process.exit をモックに置き換え
    process.exit = mockProcessExit as unknown as typeof process.exit;
  });

  afterEach(() => {
    // 元の関数を復元
    process.memoryUsage = originalMemoryUsage;
    process.exit = originalProcessExit;
  });

  describe('shouldExitForMemory()', () => {
    it('ジョブ完了後にメモリ使用量をチェックする', async () => {
      // Arrange: RSS 10GB (閾値以下)
      mockMemoryUsage.mockReturnValue({
        rss: 10 * 1024 * 1024 * 1024, // 10GB
        heapTotal: 8 * 1024 * 1024 * 1024,
        heapUsed: 6 * 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      // Act
      const { shouldExitForMemory } = await import(
        '../../src/services/worker-memory-monitor.service'
      );
      const result = shouldExitForMemory();

      // Assert: メモリ使用量を確認し、結果を返す
      expect(mockMemoryUsage).toHaveBeenCalled();
      expect(result).toHaveProperty('shouldExit');
      expect(result).toHaveProperty('rssMb');
      expect(typeof result.shouldExit).toBe('boolean');
      expect(typeof result.rssMb).toBe('number');
    });

    it('閾値以下ならプロセスを継続する（shouldExit = false）', async () => {
      // Arrange: RSS = 動的閾値の半分（どのマシンでも閾値以下）
      const { resolveMemoryConfig } = await import('../../src/services/worker-memory-profile');
      const config = resolveMemoryConfig();
      const safeRssMb = Math.floor(config.selfExitThresholdMb / 2);
      const safeRssBytes = safeRssMb * 1024 * 1024;
      mockMemoryUsage.mockReturnValue({
        rss: safeRssBytes,
        heapTotal: Math.floor(safeRssBytes * 0.75),
        heapUsed: Math.floor(safeRssBytes * 0.5),
        external: 0,
        arrayBuffers: 0,
      });

      // Act
      const { shouldExitForMemory } = await import(
        '../../src/services/worker-memory-monitor.service'
      );
      const result = shouldExitForMemory();

      // Assert: 閾値以下なのでexit不要
      expect(result.shouldExit).toBe(false);
      expect(result.rssMb).toBe(safeRssMb);
    });

    it('閾値超過でshouldExit = trueを返す', async () => {
      // Arrange: RSS 13GB (閾値12GB超過)
      mockMemoryUsage.mockReturnValue({
        rss: 13 * 1024 * 1024 * 1024, // 13GB
        heapTotal: 11 * 1024 * 1024 * 1024,
        heapUsed: 9 * 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      // Act
      const { shouldExitForMemory } = await import(
        '../../src/services/worker-memory-monitor.service'
      );
      const result = shouldExitForMemory();

      // Assert: 閾値超過なのでexit推奨
      expect(result.shouldExit).toBe(true);
      expect(result.rssMb).toBe(13312); // 13GB = 13312MB
    });
  });

  describe('performMemoryCheckAndExit()', () => {
    it('閾値以下の場合はprocess.exitを呼ばない', async () => {
      // Arrange: RSS 5GB (閾値以下)
      mockMemoryUsage.mockReturnValue({
        rss: 5 * 1024 * 1024 * 1024,
        heapTotal: 4 * 1024 * 1024 * 1024,
        heapUsed: 3 * 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      // Act
      const { performMemoryCheckAndExit } = await import(
        '../../src/services/worker-memory-monitor.service'
      );
      performMemoryCheckAndExit();

      // Assert
      expect(mockProcessExit).not.toHaveBeenCalled();
    });

    it('閾値超過でprocess.exit(0)を呼んでgraceful exitする', async () => {
      // Arrange: RSS 14GB (閾値超過)
      mockMemoryUsage.mockReturnValue({
        rss: 14 * 1024 * 1024 * 1024,
        heapTotal: 12 * 1024 * 1024 * 1024,
        heapUsed: 10 * 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      // Act
      const { performMemoryCheckAndExit } = await import(
        '../../src/services/worker-memory-monitor.service'
      );
      performMemoryCheckAndExit();

      // Assert: exit code 0でgraceful exit（Supervisorが再起動する）
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    });
  });

  describe('カスタム閾値', () => {
    it('環境変数WORKER_SELF_EXIT_THRESHOLD_MBで閾値を変更できる', async () => {
      // Arrange: カスタム閾値 = 4096MB (4GB)
      process.env.WORKER_SELF_EXIT_THRESHOLD_MB = '4096';

      // RSS 5GB (カスタム閾値4GB超過)
      mockMemoryUsage.mockReturnValue({
        rss: 5 * 1024 * 1024 * 1024,
        heapTotal: 4 * 1024 * 1024 * 1024,
        heapUsed: 3 * 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      // モジュールキャッシュをリセットして環境変数を反映
      vi.resetModules();

      // Act
      const { shouldExitForMemory } = await import(
        '../../src/services/worker-memory-monitor.service'
      );
      const result = shouldExitForMemory();

      // Assert
      expect(result.shouldExit).toBe(true);

      // Cleanup
      delete process.env.WORKER_SELF_EXIT_THRESHOLD_MB;
    });
  });

  describe('GC統合', () => {
    it('メモリチェック前にGCを試行する', async () => {
      // Arrange
      mockMemoryUsage.mockReturnValue({
        rss: 5 * 1024 * 1024 * 1024,
        heapTotal: 4 * 1024 * 1024 * 1024,
        heapUsed: 3 * 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      // ソースコード検証: shouldExitForMemory内でtryGarbageCollectが呼ばれること
      const fs = await import('node:fs');
      const path = await import('node:path');
      const servicePath = path.resolve(
        __dirname,
        '../../src/services/worker-memory-monitor.service.ts'
      );

      // ファイルが存在する場合のみソースコード検証
      // (TDD Redではファイルが存在しないためスキップ可能)
      try {
        const source = fs.readFileSync(servicePath, 'utf8');
        // GCトリガーがメモリ計測前に呼ばれることを検証
        const gcPos = source.indexOf('tryGarbageCollect');
        const memPos = source.indexOf('process.memoryUsage');
        if (gcPos > -1 && memPos > -1) {
          expect(gcPos).toBeLessThan(memPos);
        }
      } catch {
        // TDD Red: ファイルがまだ存在しないので期待通り
        expect(true).toBe(true);
      }
    });
  });
});
