// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GPU Pipeline Integration テスト
 *
 * Worker パイプライン内での GpuResourceManager の統合テスト。
 * page-analyze-worker.ts 内での Vision フェーズ・Embedding フェーズにおける
 * GPU リソース確保・解放・フォールバックの動作を検証する。
 *
 * テスト対象（page-analyze-worker.ts の実装パターン）:
 * - gpuModeSignal.onProviderSwitch コールバック接続
 * - Vision フェーズ: acquireForVision + OllamaReadinessProbe
 * - Embedding フェーズ: acquireForEmbedding + CPU フォールバック
 * - ジョブ完了後: release() 呼び出し
 * - エラーハンドリング: acquire/release 失敗時の graceful degradation
 * - シャットダウン時の GPU 解放
 *
 * NOTE: page-analyze-worker.ts 自体を直接テストするのではなく、
 * worker が使用する GpuResourceManager のインテグレーションパターンを
 * 単体テストレベルで検証する。
 *
 * @module tests/workers/gpu-pipeline-integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// モック設定
// ============================================================================

// child_process.execFile をモック（nvidia-smi 呼び出し用）
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// node:util の promisify をモック
vi.mock('util', async (importOriginal) => {
  const original = await importOriginal<typeof import('util')>();
  return {
    ...original,
    promisify: () => mockExecFile,
  };
});

// fetch をモック（Ollama API 呼び出し用）
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// logger をモック
vi.mock('../../src/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ============================================================================
// ヘルパー
// ============================================================================

/**
 * nvidia-smiの正常レスポンスをモック（GPU搭載環境）
 */
function mockGpuAvailable(
  freeMb: number = 10288,
  totalMb: number = 12288,
  usedMb: number = 2000,
): void {
  mockExecFile.mockResolvedValue({
    stdout: `${usedMb}, ${totalMb}, ${freeMb}, 20\n`,
  });
}

/**
 * nvidia-smiがエラーを返すようモック（GPU非搭載環境）
 */
function mockNoGpu(): void {
  mockExecFile.mockRejectedValue(new Error('nvidia-smi not found'));
}

/**
 * Ollama unload API の成功レスポンスをモック
 */
function mockOllamaUnloadSuccess(): void {
  mockFetch.mockResolvedValue({ ok: true });
}

/**
 * Ollama unload API の失敗をモック
 */
function mockOllamaUnloadFailure(): void {
  mockFetch.mockRejectedValue(new Error('Connection refused'));
}

// ============================================================================
// テストスイート
// ============================================================================

describe('GPU Pipeline Integration', () => {
  // 動的インポート用の型
  let GpuResourceManager: typeof import('../../src/services/gpu-resource-manager').GpuResourceManager;
  let gpuModeSignal: typeof import('../../src/services/gpu-resource-manager').gpuModeSignal;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const module = await import('../../src/services/gpu-resource-manager');
    GpuResourceManager = module.GpuResourceManager;
    gpuModeSignal = module.gpuModeSignal;

    GpuResourceManager.resetInstance();
    gpuModeSignal.requestedProvider = 'cpu';
    gpuModeSignal.onProviderSwitch = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // gpuModeSignal.onProviderSwitch コールバック接続
  // ==========================================================================

  describe('gpuModeSignal コールバック接続パターン', () => {
    it('onProviderSwitch("cuda") 時に switchProvider("cuda") が呼ばれる', async () => {
      // Arrange: page-analyze-worker.ts のパターンを再現
      // gpuModeSignal.onProviderSwitch = async (provider) => {
      //   if (provider === 'cuda') await embeddingService.switchProvider('cuda');
      //   else await embeddingService.releaseGpu();
      // };
      const mockSwitchProvider = vi.fn().mockResolvedValue(true);
      const mockReleaseGpu = vi.fn().mockResolvedValue(undefined);

      gpuModeSignal.onProviderSwitch = async (provider: 'cpu' | 'cuda'): Promise<void> => {
        if (provider === 'cuda') {
          await mockSwitchProvider('cuda');
        } else {
          await mockReleaseGpu();
        }
      };

      mockGpuAvailable();
      mockOllamaUnloadSuccess();
      const manager = GpuResourceManager.getInstance();

      // Act: Embedding を acquire すると onProviderSwitch('cuda') が呼ばれる
      await manager.acquireForEmbedding();

      // Assert
      expect(mockSwitchProvider).toHaveBeenCalledWith('cuda');
      expect(mockReleaseGpu).not.toHaveBeenCalled();
    });

    it('onProviderSwitch("cpu") 時に releaseGpu() が呼ばれる', async () => {
      // Arrange
      const mockSwitchProvider = vi.fn().mockResolvedValue(true);
      const mockReleaseGpu = vi.fn().mockResolvedValue(undefined);

      gpuModeSignal.onProviderSwitch = async (provider: 'cpu' | 'cuda'): Promise<void> => {
        if (provider === 'cuda') {
          await mockSwitchProvider('cuda');
        } else {
          await mockReleaseGpu();
        }
      };

      mockGpuAvailable();
      mockOllamaUnloadSuccess();
      const manager = GpuResourceManager.getInstance();

      // Embedding が GPU を所有
      await manager.acquireForEmbedding();
      mockSwitchProvider.mockClear();
      mockReleaseGpu.mockClear();

      // Act: release すると onProviderSwitch('cpu') → releaseGpu() が呼ばれる
      await manager.release();

      // Assert
      expect(mockReleaseGpu).toHaveBeenCalledTimes(1);
      expect(mockSwitchProvider).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Vision フェーズ → acquireForVision
  // ==========================================================================

  describe('Vision フェーズ GPU 確保', () => {
    it('Vision フェーズ開始時に acquireForVision() が呼ばれる', async () => {
      // Arrange: page-analyze-worker.ts L1871 のパターンを再現
      mockGpuAvailable();
      const manager = GpuResourceManager.getInstance();

      // Act: Vision フェーズ開始
      const result = await manager.acquireForVision();

      // Assert
      expect(result.acquired).toBe(true);
      expect(manager.getCurrentOwner()).toBe('vision');
    });

    it('acquireForVision 失敗時もパイプラインは継続する（graceful degradation）', async () => {
      // Arrange: page-analyze-worker.ts L1873-1878 のパターンを再現
      // GPU acquire 失敗 → logger.warn → 処理継続
      mockNoGpu();
      const manager = GpuResourceManager.getInstance();

      // Act: Vision フェーズ — GPU 確保に失敗
      const result = await manager.acquireForVision();

      // Assert: 失敗するが例外は投げない
      expect(result.acquired).toBe(false);

      // パイプラインは継続する
      // （実際の worker ではこの後 OllamaReadinessProbe → analyzeScrollCaptures が実行される）
    });

    it('acquireForVision が例外を投げてもキャッチされる（worker のパターン）', async () => {
      // Arrange: worker は try-catch で acquireForVision のエラーをキャッチ
      mockGpuAvailable();
      const manager = GpuResourceManager.getInstance();

      // 内部エラーをシミュレート（通常は発生しないが防御的テスト）
      // manager.isGpuAvailable をオーバーライドしてエラーを投げる
      vi.spyOn(manager, 'isGpuAvailable').mockRejectedValueOnce(new Error('Unexpected GPU error'));

      // Act & Assert: worker のパターン — try-catch でラップ
      let gpuAcquired = false;
      try {
        const visionResult = await manager.acquireForVision();
        gpuAcquired = visionResult.acquired;
      } catch {
        // worker では logger.warn して継続
        gpuAcquired = false;
      }

      expect(gpuAcquired).toBe(false);
    });
  });

  // ==========================================================================
  // Embedding フェーズ → acquireForEmbedding
  // ==========================================================================

  describe('Embedding フェーズ GPU 確保', () => {
    it('Embedding フェーズ開始時に acquireForEmbedding() が呼ばれる', async () => {
      // Arrange: page-analyze-worker.ts L2321 のパターン
      mockGpuAvailable();
      mockOllamaUnloadSuccess();
      const manager = GpuResourceManager.getInstance();

      // Vision フェーズ完了後（GPU は Vision が所有）
      await manager.acquireForVision();

      // Act: Embedding フェーズ開始
      const result = await manager.acquireForEmbedding();

      // Assert
      expect(result.acquired).toBe(true);
      expect(result.previousOwner).toBe('vision');
      expect(result.fallbackToCpu).toBe(false);
      expect(manager.getCurrentOwner()).toBe('embedding');
    });

    it('acquireForEmbedding 失敗時は CPU フォールバックで処理継続', async () => {
      // Arrange: page-analyze-worker.ts L2326-2331 のパターン
      // GPU acquire 失敗 → logger.warn → CPU モードで Embedding 実行
      mockGpuAvailable();
      const manager = GpuResourceManager.getInstance();
      await manager.acquireForVision();

      // Ollama unload 失敗 → CPU フォールバック
      mockOllamaUnloadFailure();

      // Act
      const result = await manager.acquireForEmbedding();

      // Assert
      expect(result.acquired).toBe(false);
      expect(result.fallbackToCpu).toBe(true);
      // パイプラインは CPU モードで継続
    });

    it('GPU 非搭載環境では自動的に CPU フォールバック', async () => {
      // Arrange: GPU なし
      mockNoGpu();
      const manager = GpuResourceManager.getInstance();

      // Act
      const result = await manager.acquireForEmbedding();

      // Assert
      expect(result.acquired).toBe(false);
      expect(result.fallbackToCpu).toBe(true);
    });

    it('acquireForEmbedding が例外を投げてもキャッチされる（worker のパターン）', async () => {
      // Arrange
      mockGpuAvailable();
      mockOllamaUnloadSuccess();
      const manager = GpuResourceManager.getInstance();

      // 内部エラーをシミュレート
      vi.spyOn(manager, 'isGpuAvailable').mockRejectedValueOnce(new Error('GPU query failed'));

      // Act & Assert: worker のパターン — try-catch でラップ
      let gpuAcquired = false;
      try {
        const embeddingResult = await manager.acquireForEmbedding();
        gpuAcquired = embeddingResult.acquired;
      } catch {
        // worker では logger.warn して CPU で継続
        gpuAcquired = false;
      }

      expect(gpuAcquired).toBe(false);
    });
  });

  // ==========================================================================
  // ジョブ完了後 → release
  // ==========================================================================

  describe('ジョブ完了後の GPU 解放', () => {
    it('Embedding フェーズ完了後に release() が呼ばれる', async () => {
      // Arrange: page-analyze-worker.ts L2381-2388 のパターン
      mockGpuAvailable();
      mockOllamaUnloadSuccess();
      const manager = GpuResourceManager.getInstance();

      // Vision → Embedding
      await manager.acquireForVision();
      await manager.acquireForEmbedding();
      expect(manager.getCurrentOwner()).toBe('embedding');

      // Act: ジョブ完了 → release
      await manager.release();

      // Assert
      expect(manager.getCurrentOwner()).toBe('none');
    });

    it('release() 失敗時もジョブは正常完了する（non-fatal）', async () => {
      // Arrange: page-analyze-worker.ts L2384-2388 のパターン
      // release 失敗は logger.warn のみ、ジョブ結果には影響しない
      mockGpuAvailable();
      mockOllamaUnloadSuccess();

      const mockOnProviderSwitch = vi.fn().mockRejectedValue(new Error('Release callback failed'));
      gpuModeSignal.onProviderSwitch = mockOnProviderSwitch;
      const manager = GpuResourceManager.getInstance();

      // Embedding が GPU を所有
      await manager.acquireForEmbedding();
      mockOnProviderSwitch.mockClear();

      // 再度 reject するよう設定
      gpuModeSignal.onProviderSwitch = vi.fn().mockRejectedValue(new Error('Release callback failed'));

      // Act & Assert: release のエラーは伝播しない
      // worker は try-catch でラップしている
      let releaseError: Error | null = null;
      try {
        await manager.release();
      } catch (error) {
        releaseError = error as Error;
      }

      // release() 自体は例外を投げない（内部で catch している）
      expect(releaseError).toBeNull();
      expect(manager.getCurrentOwner()).toBe('none');
    });

    it('Embedding 未使用時も release() は安全（no-op）', async () => {
      // Arrange: Embedding フェーズがスキップされた場合
      mockGpuAvailable();
      const manager = GpuResourceManager.getInstance();

      // Vision のみ使用
      await manager.acquireForVision();
      await manager.release();

      // Act: 再度 release（既に none）
      await manager.release();

      // Assert: no-op で安全に完了
      expect(manager.getCurrentOwner()).toBe('none');
    });
  });

  // ==========================================================================
  // フル パイプライン シナリオ
  // ==========================================================================

  describe('フルパイプラインシナリオ', () => {
    it('正常フロー: Vision → [release] → Embedding → release', async () => {
      // Arrange: page-analyze-worker.ts の完全な GPU 管理フロー
      mockGpuAvailable();
      mockOllamaUnloadSuccess();

      const mockSwitchProvider = vi.fn().mockResolvedValue(true);
      const mockReleaseGpu = vi.fn().mockResolvedValue(undefined);
      gpuModeSignal.onProviderSwitch = async (provider: 'cpu' | 'cuda'): Promise<void> => {
        if (provider === 'cuda') {
          await mockSwitchProvider('cuda');
        } else {
          await mockReleaseGpu();
        }
      };

      const manager = GpuResourceManager.getInstance();

      // Phase 2.5: Vision
      const visionResult = await manager.acquireForVision();
      expect(visionResult.acquired).toBe(true);
      expect(manager.getCurrentOwner()).toBe('vision');

      // Phase 5: Embedding（Vision → Embedding 切り替え）
      const embeddingResult = await manager.acquireForEmbedding();
      expect(embeddingResult.acquired).toBe(true);
      expect(embeddingResult.previousOwner).toBe('vision');
      expect(manager.getCurrentOwner()).toBe('embedding');
      expect(mockSwitchProvider).toHaveBeenCalledWith('cuda');

      // ジョブ完了: release
      await manager.release();
      expect(manager.getCurrentOwner()).toBe('none');
      expect(mockReleaseGpu).toHaveBeenCalledTimes(1);
    });

    it('GPU 非搭載フロー: 全フェーズが CPU フォールバック', async () => {
      // Arrange: GPU 非搭載環境
      mockNoGpu();
      const manager = GpuResourceManager.getInstance();

      // Phase 2.5: Vision — GPU なし
      const visionResult = await manager.acquireForVision();
      expect(visionResult.acquired).toBe(false);

      // Phase 5: Embedding — CPU フォールバック
      const embeddingResult = await manager.acquireForEmbedding();
      expect(embeddingResult.acquired).toBe(false);
      expect(embeddingResult.fallbackToCpu).toBe(true);

      // release — no-op
      await manager.release();
      expect(manager.getCurrentOwner()).toBe('none');
    });

    it('Ollama 障害フロー: Vision 成功 → Embedding CPU フォールバック', async () => {
      // Arrange: GPU 利用可能だが Ollama が応答しない
      mockGpuAvailable();
      const manager = GpuResourceManager.getInstance();

      // Vision 成功
      const visionResult = await manager.acquireForVision();
      expect(visionResult.acquired).toBe(true);

      // Ollama unload 失敗 → Embedding は CPU フォールバック
      mockOllamaUnloadFailure();
      const embeddingResult = await manager.acquireForEmbedding();
      expect(embeddingResult.fallbackToCpu).toBe(true);

      // release
      await manager.release();
      expect(manager.getCurrentOwner()).toBe('none');
    });

    it('連続ジョブ: 1つ目完了 → 2つ目開始のリソース再利用', async () => {
      // Arrange: 2つのジョブを連続処理（WorkerSupervisor パターン）
      mockGpuAvailable();
      mockOllamaUnloadSuccess();
      const manager = GpuResourceManager.getInstance();

      // ジョブ 1: Vision → Embedding → release
      await manager.acquireForVision();
      await manager.acquireForEmbedding();
      await manager.release();
      expect(manager.getCurrentOwner()).toBe('none');

      // ジョブ 2: 新しいジョブで GPU を再利用
      const v2 = await manager.acquireForVision();
      expect(v2.acquired).toBe(true);
      expect(v2.previousOwner).toBe('none');

      await manager.acquireForEmbedding();
      await manager.release();
      expect(manager.getCurrentOwner()).toBe('none');
    });
  });

  // ==========================================================================
  // シャットダウン時の GPU 解放
  // ==========================================================================

  describe('シャットダウン時の GPU 解放', () => {
    it('worker シャットダウン時に GPU リソースが解放される', async () => {
      // Arrange: page-analyze-worker.ts L2691-2697 のパターン
      // Worker 終了時に gpuResourceManager.release() を呼ぶ
      mockGpuAvailable();
      mockOllamaUnloadSuccess();

      const mockReleaseGpu = vi.fn().mockResolvedValue(undefined);
      gpuModeSignal.onProviderSwitch = async (provider: 'cpu' | 'cuda'): Promise<void> => {
        if (provider === 'cpu') {
          await mockReleaseGpu();
        }
      };

      const manager = GpuResourceManager.getInstance();
      await manager.acquireForEmbedding();

      // Act: シャットダウン
      await manager.release();

      // Assert: GPU リソースが解放された
      expect(manager.getCurrentOwner()).toBe('none');
      expect(mockReleaseGpu).toHaveBeenCalledTimes(1);
    });

    it('シャットダウン中の release 失敗は無視される', async () => {
      // Arrange: page-analyze-worker.ts L2695-2696 のパターン
      // release() 失敗は catch で無視（shutdown は best-effort）
      mockGpuAvailable();
      mockOllamaUnloadSuccess();

      const mockReleaseGpu = vi.fn().mockRejectedValue(new Error('Release failed during shutdown'));
      gpuModeSignal.onProviderSwitch = async (provider: 'cpu' | 'cuda'): Promise<void> => {
        if (provider === 'cpu') {
          await mockReleaseGpu();
        }
      };

      const manager = GpuResourceManager.getInstance();
      await manager.acquireForEmbedding();

      // Act & Assert: エラーは伝播しない
      await expect(manager.release()).resolves.toBeUndefined();
    });

    it('Embedding 未使用のまま shutdown しても安全', async () => {
      // Arrange: Vision のみ使用して shutdown
      mockGpuAvailable();
      const manager = GpuResourceManager.getInstance();
      await manager.acquireForVision();

      // Act
      await manager.release();

      // Assert
      expect(manager.getCurrentOwner()).toBe('none');
    });
  });

  // ==========================================================================
  // gpuModeSignal の requestedProvider 状態追跡
  // ==========================================================================

  describe('requestedProvider 状態追跡', () => {
    it('パイプライン全体で requestedProvider が正しく遷移する', async () => {
      // Arrange
      mockGpuAvailable();
      mockOllamaUnloadSuccess();
      const manager = GpuResourceManager.getInstance();

      // 初期状態
      expect(gpuModeSignal.requestedProvider).toBe('cpu');

      // Vision フェーズ: provider は変わらない
      await manager.acquireForVision();
      expect(gpuModeSignal.requestedProvider).toBe('cpu');

      // Embedding フェーズ: cuda に切り替え
      await manager.acquireForEmbedding();
      expect(gpuModeSignal.requestedProvider).toBe('cuda');

      // release: cpu に戻す
      await manager.release();
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
    });

    it('CPU フォールバック時は requestedProvider が cpu のまま', async () => {
      // Arrange: GPU なし
      mockNoGpu();
      const manager = GpuResourceManager.getInstance();

      // Act
      await manager.acquireForVision();
      await manager.acquireForEmbedding();

      // Assert: GPU 確保失敗のため cuda には遷移しない
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
    });

    it('Ollama unload 失敗時も requestedProvider は cpu のまま', async () => {
      // Arrange: GPU あるが Ollama 接続不可
      mockGpuAvailable();
      const manager = GpuResourceManager.getInstance();
      await manager.acquireForVision();

      mockOllamaUnloadFailure();

      // Act: Embedding acquire 失敗（CPU フォールバック）
      await manager.acquireForEmbedding();

      // Assert: cuda に切り替わっていない
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
    });
  });

  // ==========================================================================
  // シングルトンの一貫性
  // ==========================================================================

  describe('シングルトンの一貫性', () => {
    it('worker 内で複数箇所から getInstance() しても同一インスタンス', () => {
      // Arrange & Act: page-analyze-worker.ts L116 のパターン
      const instance1 = GpuResourceManager.getInstance();
      const instance2 = GpuResourceManager.getInstance();

      // Assert: 同一参照
      expect(instance1).toBe(instance2);
    });

    it('状態が複数箇所の参照間で共有される', async () => {
      // Arrange: 2つの参照で同じ状態を共有
      mockGpuAvailable();
      const ref1 = GpuResourceManager.getInstance();
      const ref2 = GpuResourceManager.getInstance();

      // Act: ref1 で acquire
      await ref1.acquireForVision();

      // Assert: ref2 でも状態が反映
      expect(ref2.getCurrentOwner()).toBe('vision');
    });
  });
});
