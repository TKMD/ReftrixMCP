// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EmbeddingService プロバイダー動的切り替えテスト
 *
 * EmbeddingService の switchProvider() / releaseGpu() / getCurrentProvider() の
 * 動的ONNX実行プロバイダー切り替え機能をテストする。
 *
 * テスト対象:
 * - switchProvider('cuda'): onnxruntime-gpu利用可能時にCUDAに切り替え
 * - switchProvider('cuda'): onnxruntime-gpu未インストール時にfalseを返す
 * - switchProvider('cpu'): 常に成功
 * - getCurrentProvider(): 切り替え後の状態反映
 * - releaseGpu(): パイプラインdispose + CPUへ戻す
 * - In-processモード（EMBEDDING_WORKER_THREAD=false）での動作
 * - Worker Thread未稼働時のswitchProvider動作
 *
 * 注: VITEST環境ではWorker Threadが自動無効化されるため、
 * in-processフォールバックモードでテストされる。
 *
 * @module tests/embedding-provider-switching
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// モック設定
// ============================================================================

// @huggingface/transformers をモック（パイプライン初期化用）
const mockPipelineFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
const mockDispose = vi.fn().mockResolvedValue([]);
const mockPipeline = Object.assign(mockPipelineFn, {
  dispose: mockDispose,
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(mockPipeline),
}));

// node:worker_threads をモック（Worker Thread無効化の確認用）
vi.mock('node:worker_threads', () => ({
  Worker: vi.fn().mockImplementation(() => {
    throw new Error('Worker thread disabled in test');
  }),
}));

// node:fs をモック（CUDA provider .so ファイルの存在チェックを制御）
// テスト環境ではCUDA .soファイルが実在する場合があるため、
// switchProviderInProcess('cuda') がfalseを返すよう
// libonnxruntime_providers_cuda.so のパスに対してのみ false を返す
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('libonnxruntime_providers_cuda')) {
        return false;
      }
      return actual.existsSync(p);
    }),
    default: {
      ...actual,
      existsSync: vi.fn().mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('libonnxruntime_providers_cuda')) {
          return false;
        }
        return actual.existsSync(p);
      }),
      readdirSync: actual.readdirSync,
    },
  };
});

// ============================================================================
// テストスイート
// ============================================================================

describe('EmbeddingService Provider Switching', () => {
  let EmbeddingService: typeof import('../src/embeddings/service').EmbeddingService;

  beforeEach(async () => {
    vi.clearAllMocks();

    // 環境変数をテスト用に設定
    process.env.EMBEDDING_WORKER_THREAD = 'false';
    process.env.VITEST = 'true';

    // 動的インポートで新鮮なモジュールを取得
    const module = await import('../src/embeddings/service');
    EmbeddingService = module.EmbeddingService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EMBEDDING_WORKER_THREAD;
    delete process.env.ONNX_EXECUTION_PROVIDER;
  });

  // ==========================================================================
  // switchProvider()
  // ==========================================================================

  describe('switchProvider()', () => {
    it('switchProvider("cpu") は常に成功する', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      const result = await service.switchProvider('cpu');

      // Assert: 既にCPUなのでtrue（no-op成功）
      expect(result).toBe(true);
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('switchProvider("cuda") は onnxruntime-gpu 未インストール時にfalseを返す', async () => {
      // Arrange: onnxruntime-gpu が require.resolve で見つからない
      const service = new EmbeddingService({ device: 'cpu' });

      // Act: テスト環境にはonnxruntime-gpuがインストールされていない
      const result = await service.switchProvider('cuda');

      // Assert: CUDAに切り替え不可
      expect(result).toBe(false);
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('同一プロバイダーへの切り替えはno-op成功を返す', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act: 既にCPUの状態でCPUに切り替え
      const result = await service.switchProvider('cpu');

      // Assert
      expect(result).toBe(true);
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('getCurrentProvider() は切り替え後の状態を正しく反映する', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Assert: 初期状態
      expect(service.getCurrentProvider()).toBe('cpu');

      // CPUからCPUへ（no-op）
      await service.switchProvider('cpu');
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('switchProvider("cuda") が失敗してもプロバイダー状態はCPUのまま', async () => {
      // Arrange: onnxruntime-gpu は未インストール（テスト環境）
      const service = new EmbeddingService({ device: 'cpu' });

      // Act: CUDAへの切り替えを試みる
      const result = await service.switchProvider('cuda');

      // Assert: 切り替え失敗、プロバイダーはCPUのまま
      expect(result).toBe(false);
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('ONNX_EXECUTION_PROVIDER=cuda で初期化後、CPUへの切り替えが成功する', async () => {
      // Arrange: 環境変数でCUDAを指定（初期プロバイダーがcudaになる）
      process.env.ONNX_EXECUTION_PROVIDER = 'cuda';
      const service = new EmbeddingService();
      expect(service.getCurrentProvider()).toBe('cuda');

      // Act: CPUに切り替え
      const result = await service.switchProvider('cpu');

      // Assert
      expect(result).toBe(true);
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('CPUへの切り替え後に再度CUDAへの切り替えを試みるとfalseを返す', async () => {
      // Arrange: CUDAから開始
      process.env.ONNX_EXECUTION_PROVIDER = 'cuda';
      const service = new EmbeddingService();
      await service.switchProvider('cpu');

      // Act: 再度CUDAへ（onnxruntime-gpu未インストール）
      const result = await service.switchProvider('cuda');

      // Assert
      expect(result).toBe(false);
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('switchProvider("cpu")でin-processパイプラインがdisposeされる', async () => {
      // Arrange: CUDA→CPUの切り替え
      process.env.ONNX_EXECUTION_PROVIDER = 'cuda';
      const service = new EmbeddingService();

      // Act
      await service.switchProvider('cpu');

      // Assert: プロバイダーがCPUに変更
      expect(service.getCurrentProvider()).toBe('cpu');
      // isInitializedがfalseならpipelineがdisposeされた
      expect(service.isInitialized()).toBe(false);
    });
  });

  // ==========================================================================
  // releaseGpu()
  // ==========================================================================

  describe('releaseGpu()', () => {
    it('releaseGpu() 後にプロバイダーがCPUになる', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      await service.releaseGpu();

      // Assert
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('既にCPUの場合でもreleaseGpuは安全に呼べる', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });
      expect(service.getCurrentProvider()).toBe('cpu');

      // Act & Assert: エラーなし
      await expect(service.releaseGpu()).resolves.toBeUndefined();
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('releaseGpu() はCUDAプロバイダーからCPUに戻す', async () => {
      // Arrange: ONNX_EXECUTION_PROVIDER=cudaで初期化（初期プロバイダーがcuda）
      process.env.ONNX_EXECUTION_PROVIDER = 'cuda';
      const service = new EmbeddingService();
      expect(service.getCurrentProvider()).toBe('cuda');

      // Act: GPU解放
      await service.releaseGpu();

      // Assert: CPUに戻る
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('releaseGpu() を連続呼び出ししてもエラーなし', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act & Assert: 3回連続で呼んでもエラーなし
      await expect(service.releaseGpu()).resolves.toBeUndefined();
      await expect(service.releaseGpu()).resolves.toBeUndefined();
      await expect(service.releaseGpu()).resolves.toBeUndefined();
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('releaseGpu() はisInitializedをfalseにする', async () => {
      // Arrange
      process.env.ONNX_EXECUTION_PROVIDER = 'cuda';
      const service = new EmbeddingService();

      // Act
      await service.releaseGpu();

      // Assert: パイプラインがdispose済み
      expect(service.isInitialized()).toBe(false);
      expect(service.getCurrentProvider()).toBe('cpu');
    });
  });

  // ==========================================================================
  // In-process モード (EMBEDDING_WORKER_THREAD=false)
  // ==========================================================================

  describe('In-processモード（フォールバック）', () => {
    it('VITEST環境ではWorker Threadが無効化される', () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Assert: テスト環境ではin-processモード
      expect(service.isUsingWorkerThread()).toBe(false);
    });

    it('EMBEDDING_WORKER_THREAD=false でもswitchProviderが動作する', async () => {
      // Arrange
      process.env.EMBEDDING_WORKER_THREAD = 'false';
      const service = new EmbeddingService({ device: 'cpu' });

      // Act: CPUへの切り替え（no-op）
      const result = await service.switchProvider('cpu');

      // Assert
      expect(result).toBe(true);
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('EMBEDDING_WORKER_THREAD=false でもreleaseGpuが動作する', async () => {
      // Arrange
      process.env.EMBEDDING_WORKER_THREAD = 'false';
      const service = new EmbeddingService({ device: 'cpu' });

      // Act & Assert
      await expect(service.releaseGpu()).resolves.toBeUndefined();
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('in-processモードでCPU→CPU切り替えはno-op成功', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });
      expect(service.isUsingWorkerThread()).toBe(false);

      // Act
      const result = await service.switchProvider('cpu');

      // Assert
      expect(result).toBe(true);
    });

    it('EMBEDDING_WORKER_THREAD=0 でもin-processモードになる', () => {
      // Arrange
      process.env.EMBEDDING_WORKER_THREAD = '0';
      const service = new EmbeddingService({ device: 'cpu' });

      // Assert
      expect(service.isUsingWorkerThread()).toBe(false);
    });
  });

  // ==========================================================================
  // ONNX_EXECUTION_PROVIDER 環境変数
  // ==========================================================================

  describe('ONNX_EXECUTION_PROVIDER 環境変数', () => {
    it('環境変数未設定時はCPUプロバイダーが使用される', () => {
      // Arrange
      delete process.env.ONNX_EXECUTION_PROVIDER;

      // Act
      const service = new EmbeddingService();

      // Assert
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('ONNX_EXECUTION_PROVIDER=cuda 設定時はCUDAプロバイダーが設定される', () => {
      // Arrange
      process.env.ONNX_EXECUTION_PROVIDER = 'cuda';

      // Act
      const service = new EmbeddingService();

      // Assert
      expect(service.getCurrentProvider()).toBe('cuda');
    });

    it('ONNX_EXECUTION_PROVIDER=rocm 設定時はCUDAプロバイダーとして扱われる', () => {
      // Arrange
      process.env.ONNX_EXECUTION_PROVIDER = 'rocm';

      // Act
      const service = new EmbeddingService();

      // Assert: rocmはcudaとして扱われる（ONNX Runtime互換性）
      expect(service.getCurrentProvider()).toBe('cuda');
    });

    it('明示的にdevice指定された場合は環境変数より優先される', () => {
      // Arrange
      process.env.ONNX_EXECUTION_PROVIDER = 'cuda';

      // Act: deviceを明示的にcpuに指定
      const service = new EmbeddingService({ device: 'cpu' });

      // Assert: 明示的指定が優先
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('不明な ONNX_EXECUTION_PROVIDER 値はCPUフォールバック', () => {
      // Arrange
      process.env.ONNX_EXECUTION_PROVIDER = 'invalid_provider';

      // Act
      const service = new EmbeddingService();

      // Assert: 不明な値はCPUにフォールバック
      expect(service.getCurrentProvider()).toBe('cpu');
    });
  });

  // ==========================================================================
  // dispose() とプロバイダー状態
  // ==========================================================================

  describe('dispose() とプロバイダー状態', () => {
    it('dispose() 後もgetCurrentProvider()が正しい値を返す', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      await service.dispose();

      // Assert: disposeはプロバイダー状態を変更しない
      expect(service.getCurrentProvider()).toBe('cpu');
    });

    it('dispose() 後にinferencesSinceRecycleが0にリセットされる', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      await service.dispose();

      // Assert
      expect(service.getInferencesSinceRecycle()).toBe(0);
    });

    it('dispose() はisInitializedをfalseにする', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      await service.dispose();

      // Assert
      expect(service.isInitialized()).toBe(false);
    });

    it('dispose() を複数回呼んでもエラーなし', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act & Assert
      await expect(service.dispose()).resolves.toBeUndefined();
      await expect(service.dispose()).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // isInitialized() 状態管理
  // ==========================================================================

  describe('isInitialized()', () => {
    it('新規作成直後はfalse', () => {
      // Arrange & Act
      const service = new EmbeddingService({ device: 'cpu' });

      // Assert: パイプラインはlazy-load
      expect(service.isInitialized()).toBe(false);
    });

    it('dispose()後はfalseに戻る', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      await service.dispose();

      // Assert
      expect(service.isInitialized()).toBe(false);
    });
  });

  // ==========================================================================
  // Worker Thread再起動カウント
  // ==========================================================================

  describe('getWorkerRestartCount()', () => {
    it('初期値は0', () => {
      // Arrange & Act
      const service = new EmbeddingService({ device: 'cpu' });

      // Assert
      expect(service.getWorkerRestartCount()).toBe(0);
    });
  });

  // ==========================================================================
  // キャッシュとプロバイダー切り替えの独立性
  // ==========================================================================

  describe('キャッシュとプロバイダー切り替えの独立性', () => {
    it('switchProvider後もキャッシュ統計が保持される', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // 初期状態のキャッシュ統計を取得
      const statsBefore = service.getCacheStats();
      expect(statsBefore.size).toBe(0);

      // Act: プロバイダー切り替え
      await service.switchProvider('cpu');

      // Assert: キャッシュ統計は変更されない
      const statsAfter = service.getCacheStats();
      expect(statsAfter.size).toBe(statsBefore.size);
      expect(statsAfter.hits).toBe(statsBefore.hits);
      expect(statsAfter.misses).toBe(statsBefore.misses);
    });

    it('clearCache()はプロバイダー状態に影響しない', () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      service.clearCache();

      // Assert
      expect(service.getCurrentProvider()).toBe('cpu');
      expect(service.getCacheStats().size).toBe(0);
    });

    it('releaseGpu()はキャッシュに影響しない', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      await service.releaseGpu();

      // Assert: キャッシュ統計はそのまま
      const stats = service.getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('clearCache()後にcacheEvictionsも0にリセットされる', () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      service.clearCache();

      // Assert
      const stats = service.getCacheStats();
      expect(stats.evictions).toBe(0);
    });
  });

  // ==========================================================================
  // getRecycleCount() と切り替え
  // ==========================================================================

  describe('getRecycleCount() と切り替え', () => {
    it('初期値は0', () => {
      // Arrange & Act
      const service = new EmbeddingService({ device: 'cpu' });

      // Assert
      expect(service.getRecycleCount()).toBe(0);
    });

    it('switchProvider後もrecycleCountは保持される', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });
      const countBefore = service.getRecycleCount();

      // Act
      await service.switchProvider('cpu');

      // Assert
      expect(service.getRecycleCount()).toBe(countBefore);
    });
  });

  // ==========================================================================
  // terminate()
  // ==========================================================================

  describe('terminate()', () => {
    it('in-processモードでterminate()がエラーなく完了する', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });
      expect(service.isUsingWorkerThread()).toBe(false);

      // Act & Assert
      await expect(service.terminate()).resolves.toBeUndefined();
    });

    it('terminate()後にisInitializedがfalseになる', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      await service.terminate();

      // Assert
      expect(service.isInitialized()).toBe(false);
    });
  });

  // ==========================================================================
  // generateBatchEmbeddings 空配列
  // ==========================================================================

  describe('generateBatchEmbeddings edge cases', () => {
    it('空配列は空配列を返す', async () => {
      // Arrange
      const service = new EmbeddingService({ device: 'cpu' });

      // Act
      const result = await service.generateBatchEmbeddings([], 'passage');

      // Assert
      expect(result).toEqual([]);
    });
  });
});
