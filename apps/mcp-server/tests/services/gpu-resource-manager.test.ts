// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GpuResourceManager テスト
 *
 * GPU リソースの排他的管理を行うサービスのテスト。
 * Vision (Ollama) と Embedding (ONNX) が同一GPUを共有する環境で、
 * VRAM競合を防止するためのリソースアービトレーション。
 *
 * テスト対象:
 * - シングルトンパターン（getInstance / resetInstance）
 * - GPU可用性検出（nvidia-smi）
 * - acquireForVision(): Vision用GPU確保
 * - acquireForEmbedding(): Embedding用GPU確保
 * - release(): GPU解放
 * - gpuModeSignal: 共有シグナルオブジェクト
 * - Graceful Degradation: GPU非搭載環境での安全な動作
 * - 状態遷移の一貫性テスト
 *
 * @module tests/services/gpu-resource-manager
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

// node:util の promisify をモック — promisify(execFile) の戻り値を制御
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
// ヘルパー: nvidia-smi モックレスポンス
// ============================================================================

/**
 * nvidia-smiの正常レスポンスをモック生成する
 * @param usedMb - VRAM使用量（MB）
 * @param totalMb - VRAM総量（MB）
 * @param freeMb - VRAM空き容量（MB）
 * @param utilization - GPU使用率（%）
 */
function mockNvidiaSmiSuccess(
  usedMb: number,
  totalMb: number,
  freeMb: number,
  utilization: number = 0
): void {
  mockExecFile.mockResolvedValue({
    stdout: `${usedMb}, ${totalMb}, ${freeMb}, ${utilization}\n`,
  });
}

/**
 * nvidia-smiがエラーを返すようモックする（GPU非搭載環境）
 */
function mockNvidiaSmiNotAvailable(): void {
  mockExecFile.mockRejectedValue(new Error('nvidia-smi not found'));
}

// ============================================================================
// テストスイート
// ============================================================================

describe('GpuResourceManager', () => {
  // 動的インポート用の型
  let GpuResourceManager: typeof import('../../src/services/gpu-resource-manager').GpuResourceManager;
  let gpuModeSignal: typeof import('../../src/services/gpu-resource-manager').gpuModeSignal;
  type GpuModeSignal = import('../../src/services/gpu-resource-manager').GpuModeSignal;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // 動的インポートで新鮮なモジュールを取得
    const module = await import('../../src/services/gpu-resource-manager');
    GpuResourceManager = module.GpuResourceManager;
    gpuModeSignal = module.gpuModeSignal;

    // シングルトンをリセット
    GpuResourceManager.resetInstance();

    // gpuModeSignal をクリーンな状態に戻す
    gpuModeSignal.requestedProvider = 'cpu';
    gpuModeSignal.onProviderSwitch = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // シングルトンパターン
  // ==========================================================================

  describe('シングルトンパターン', () => {
    it('getInstance() は同一インスタンスを返す', () => {
      // Arrange & Act
      const instance1 = GpuResourceManager.getInstance();
      const instance2 = GpuResourceManager.getInstance();

      // Assert: 同一参照であること
      expect(instance1).toBe(instance2);
    });

    it('resetInstance() 後は新しいインスタンスが返される', () => {
      // Arrange
      const instance1 = GpuResourceManager.getInstance();

      // Act
      GpuResourceManager.resetInstance();
      const instance2 = GpuResourceManager.getInstance();

      // Assert: 異なるインスタンスであること
      expect(instance1).not.toBe(instance2);
    });

    it('getInstance() にconfigを渡すと初回のみ適用される', () => {
      // Arrange & Act
      const instance1 = GpuResourceManager.getInstance({ ollamaUrl: 'http://custom:11434' });
      const instance2 = GpuResourceManager.getInstance({ ollamaUrl: 'http://other:11434' });

      // Assert: 2回目のconfigは無視、同一インスタンス
      expect(instance1).toBe(instance2);
    });
  });

  // ==========================================================================
  // GPU可用性検出
  // ==========================================================================

  describe('isGpuAvailable()', () => {
    it('nvidia-smi成功時はtrueを返す', async () => {
      // Arrange: GPU搭載環境をシミュレート（RTX 3060 12GB）
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // Act
      const available = await manager.isGpuAvailable();

      // Assert
      expect(available).toBe(true);
    });

    it('nvidia-smi失敗時はfalseを返す', async () => {
      // Arrange: GPU非搭載環境をシミュレート
      mockNvidiaSmiNotAvailable();
      const manager = GpuResourceManager.getInstance();

      // Act
      const available = await manager.isGpuAvailable();

      // Assert
      expect(available).toBe(false);
    });

    it('結果がキャッシュされる（nvidia-smiは1回のみ呼ばれる）', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // Act: 2回呼ぶ
      await manager.isGpuAvailable();
      await manager.isGpuAvailable();

      // Assert: nvidia-smi呼び出しは1回のみ（キャッシュ有効）
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('キャッシュされたfalse結果も1回のみの呼び出しで返される', async () => {
      // Arrange
      mockNvidiaSmiNotAvailable();
      const manager = GpuResourceManager.getInstance();

      // Act
      await manager.isGpuAvailable();
      await manager.isGpuAvailable();
      await manager.isGpuAvailable();

      // Assert
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('nvidia-smiの出力が不正な場合はfalseを返す', async () => {
      // Arrange: 不正な出力
      mockExecFile.mockResolvedValue({ stdout: 'invalid output\n' });
      const manager = GpuResourceManager.getInstance();

      // Act
      const available = await manager.isGpuAvailable();

      // Assert
      expect(available).toBe(false);
    });

    it('nvidia-smiの出力が空の場合はfalseを返す', async () => {
      // Arrange
      mockExecFile.mockResolvedValue({ stdout: '' });
      const manager = GpuResourceManager.getInstance();

      // Act
      const available = await manager.isGpuAvailable();

      // Assert
      expect(available).toBe(false);
    });

    it('nvidia-smiの出力にNaN値がある場合はfalseを返す', async () => {
      // Arrange
      mockExecFile.mockResolvedValue({ stdout: 'NaN, 12288, NaN, 0\n' });
      const manager = GpuResourceManager.getInstance();

      // Act
      const available = await manager.isGpuAvailable();

      // Assert
      expect(available).toBe(false);
    });
  });

  // ==========================================================================
  // acquireForVision()
  // ==========================================================================

  describe('acquireForVision()', () => {
    it('GPU利用可能で所有者なしの場合、acquired=trueを返す', async () => {
      // Arrange: GPU利用可能、十分なVRAM（>= 8192MB）
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // Act
      const result = await manager.acquireForVision();

      // Assert
      expect(result.acquired).toBe(true);
      expect(result.previousOwner).toBe('none');
    });

    it('acquireForVision後にcurrentOwnerが"vision"になる', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // Act
      await manager.acquireForVision();

      // Assert
      expect(manager.getCurrentOwner()).toBe('vision');
    });

    it('Embeddingから切り替え時にonProviderSwitch("cpu")が呼ばれる', async () => {
      // Arrange: GPU利用可能
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const onProviderSwitch = vi.fn().mockResolvedValue(undefined);
      gpuModeSignal.onProviderSwitch = onProviderSwitch;
      const manager = GpuResourceManager.getInstance();

      // まずEmbeddingが所有（Ollama unload成功のモック）
      mockFetch.mockResolvedValueOnce({ ok: true });
      await manager.acquireForEmbedding();
      onProviderSwitch.mockClear();

      // VRAMチェック用: 十分な空き
      mockNvidiaSmiSuccess(2000, 12288, 10288);

      // Act: Visionに切り替え
      await manager.acquireForVision();

      // Assert: EmbeddingをCPUに切り替えるコールバック
      expect(onProviderSwitch).toHaveBeenCalledWith('cpu');
    });

    it('Embeddingからの切り替え時にgpuModeSignal.requestedProviderが"cpu"になる', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // EmbeddingがGPUを所有
      mockFetch.mockResolvedValueOnce({ ok: true });
      await manager.acquireForEmbedding();
      expect(gpuModeSignal.requestedProvider).toBe('cuda');

      // VRAMチェック用
      mockNvidiaSmiSuccess(2000, 12288, 10288);

      // Act: Visionに切り替え
      await manager.acquireForVision();

      // Assert
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
    });

    it('onProviderSwitch未設定でもEmbeddingからの切り替えが動作する', async () => {
      // Arrange: コールバック未設定
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      gpuModeSignal.onProviderSwitch = undefined;
      const manager = GpuResourceManager.getInstance();

      // EmbeddingがGPUを所有
      mockFetch.mockResolvedValueOnce({ ok: true });
      await manager.acquireForEmbedding();

      // VRAMチェック用
      mockNvidiaSmiSuccess(2000, 12288, 10288);

      // Act & Assert: エラーなし
      const result = await manager.acquireForVision();
      expect(result.acquired).toBe(true);
    });

    it('onProviderSwitchがエラーを投げても処理が続行する', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      gpuModeSignal.onProviderSwitch = vi.fn().mockRejectedValue(new Error('switch failed'));
      const manager = GpuResourceManager.getInstance();

      // EmbeddingがGPUを所有
      mockFetch.mockResolvedValueOnce({ ok: true });
      await manager.acquireForEmbedding();

      // VRAMチェック用
      mockNvidiaSmiSuccess(2000, 12288, 10288);

      // Act: エラーが投げられてもacquire続行
      const result = await manager.acquireForVision();

      // Assert: VRAM十分なら成功
      expect(result.acquired).toBe(true);
    });

    it('VRAM >= 8192MBになるまでポーリングで待機する', async () => {
      // Arrange: GPU利用可能だがVRAM不足 → 十分に解放
      const manager = GpuResourceManager.getInstance();

      // 1回目: isGpuAvailable → GPU検出
      // 2回目: waitForVram → VRAM不足
      // 3回目: waitForVram → VRAM十分
      mockExecFile
        .mockResolvedValueOnce({ stdout: '10000, 12288, 2288, 80\n' }) // isGpuAvailable
        .mockResolvedValueOnce({ stdout: '10000, 12288, 2288, 80\n' }) // 1回目のVRAMポーリング: 不足
        .mockResolvedValueOnce({ stdout: '2000, 12288, 10288, 20\n' }); // 2回目: 十分

      // Act
      const resultPromise = manager.acquireForVision();

      // タイマーを進めてポーリング間隔をシミュレート
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      // Assert
      expect(result.acquired).toBe(true);
    });

    it('VRAMポーリングタイムアウト（30秒）後はacquired=falseを返す', async () => {
      // Arrange: GPU利用可能だがVRAMが常に不足
      const manager = GpuResourceManager.getInstance();

      // nvidia-smi: 常にVRAM不足（8192MB未満）
      mockExecFile.mockResolvedValue({
        stdout: '10000, 12288, 2288, 80\n',
      });

      // Act
      const resultPromise = manager.acquireForVision();

      // 30秒以上進める
      await vi.advanceTimersByTimeAsync(35000);
      const result = await resultPromise;

      // Assert
      expect(result.acquired).toBe(false);
    });

    it('GPU非搭載環境ではacquired=falseを返す', async () => {
      // Arrange
      mockNvidiaSmiNotAvailable();
      const manager = GpuResourceManager.getInstance();

      // Act
      const result = await manager.acquireForVision();

      // Assert
      expect(result.acquired).toBe(false);
      expect(result.previousOwner).toBe('none');
    });

    it('既にVisionが所有している場合もacquired=trueを返す', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // Visionが既に所有
      await manager.acquireForVision();

      // Act: 再度acquireForVision（currentOwnerが'vision'のため embedding分岐に入らない）
      const result = await manager.acquireForVision();

      // Assert: 成功
      expect(result.acquired).toBe(true);
      expect(result.previousOwner).toBe('none');
    });

    it('VRAMポーリング中にnvidia-smiが利用不可になるとbest-effortでtrue', async () => {
      // Arrange
      const manager = GpuResourceManager.getInstance();

      // 1回目: isGpuAvailable → GPU検出
      // 2回目: waitForVram → nvidia-smi失敗（best-effort続行）
      mockExecFile
        .mockResolvedValueOnce({ stdout: '2000, 12288, 10288, 10\n' }) // isGpuAvailable: GPU検出
        .mockRejectedValueOnce(new Error('nvidia-smi unavailable')); // waitForVram: 利用不可

      // Act
      const result = await manager.acquireForVision();

      // Assert: best-effortで続行
      expect(result.acquired).toBe(true);
    });
  });

  // ==========================================================================
  // acquireForEmbedding()
  // ==========================================================================

  describe('acquireForEmbedding()', () => {
    it('GPU利用可能で所有者なしの場合、acquired=trueを返す', async () => {
      // Arrange: VRAM十分（>= 2048MB）
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      // Ollama unload（所有者なしでもunload試行される）
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = GpuResourceManager.getInstance();

      // Act
      const result = await manager.acquireForEmbedding();

      // Assert
      expect(result.acquired).toBe(true);
      expect(result.fallbackToCpu).toBe(false);
    });

    it('Visionからの切り替え時にOllama unload APIが正しく呼ばれる', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // VisionがGPUを所有
      await manager.acquireForVision();
      mockFetch.mockClear();

      // Ollama unload成功 + VRAM十分
      mockFetch.mockResolvedValueOnce({ ok: true });
      mockExecFile.mockResolvedValue({
        stdout: '2000, 12288, 10288, 10\n',
      });

      // Act
      await manager.acquireForEmbedding();

      // Assert: Ollama unload APIが正しいパラメータで呼ばれた
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/generate'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('keep_alive'),
        })
      );

      // body に llama3.2-vision モデル名と keep_alive: '0' が含まれることを検証
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.model).toBe('llama3.2-vision');
      expect(body.keep_alive).toBe('0');
    });

    it('VRAM解放後にonProviderSwitch("cuda")が呼ばれる', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const onProviderSwitch = vi.fn().mockResolvedValue(undefined);
      gpuModeSignal.onProviderSwitch = onProviderSwitch;
      const manager = GpuResourceManager.getInstance();

      // Ollama unload成功
      mockFetch.mockResolvedValueOnce({ ok: true });

      // Act
      await manager.acquireForEmbedding();

      // Assert: ONNX をCUDAモードに切り替えるコールバック
      expect(onProviderSwitch).toHaveBeenCalledWith('cuda');
    });

    it('acquireForEmbedding後にgpuModeSignal.requestedProviderが"cuda"になる', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = GpuResourceManager.getInstance();

      // Act
      await manager.acquireForEmbedding();

      // Assert
      expect(gpuModeSignal.requestedProvider).toBe('cuda');
    });

    it('VRAM >= 2048MBになるまで待機する', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // VisionがGPUを所有
      await manager.acquireForVision();
      mockFetch.mockClear();

      // Ollama unload成功
      mockFetch.mockResolvedValueOnce({ ok: true });

      // 1回目: VRAM不足、2回目: VRAM十分（>= 2048MB）
      mockExecFile
        .mockResolvedValueOnce({ stdout: '11000, 12288, 1288, 90\n' }) // VRAM不足
        .mockResolvedValueOnce({ stdout: '4000, 12288, 8288, 30\n' }); // VRAM十分

      // Act
      const resultPromise = manager.acquireForEmbedding();
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      // Assert
      expect(result.acquired).toBe(true);
      expect(result.fallbackToCpu).toBe(false);
    });

    it('Ollama unload失敗時はfallbackToCpu=trueを返す', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // VisionがGPUを所有
      await manager.acquireForVision();
      mockFetch.mockClear();

      // Ollama unload失敗（接続エラー）
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      // Act
      const result = await manager.acquireForEmbedding();

      // Assert: CPUフォールバック
      expect(result.acquired).toBe(false);
      expect(result.fallbackToCpu).toBe(true);
    });

    it('Ollama unload APIが非200レスポンスの場合もfallbackToCpu=trueを返す', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // Ollama unload → HTTP 500
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      // Act
      const result = await manager.acquireForEmbedding();

      // Assert: CPUフォールバック
      expect(result.acquired).toBe(false);
      expect(result.fallbackToCpu).toBe(true);
    });

    it('VRAM解放タイムアウト時はfallbackToCpu=trueを返す', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // VisionがGPUを所有
      await manager.acquireForVision();
      mockFetch.mockClear();

      // Ollama unload成功
      mockFetch.mockResolvedValueOnce({ ok: true });

      // VRAMが永久に不足
      mockExecFile.mockResolvedValue({
        stdout: '11000, 12288, 1288, 90\n',
      });

      // Act
      const resultPromise = manager.acquireForEmbedding();
      await vi.advanceTimersByTimeAsync(35000);
      const result = await resultPromise;

      // Assert: CPUフォールバック
      expect(result.acquired).toBe(false);
      expect(result.fallbackToCpu).toBe(true);
    });

    it('GPU非搭載環境ではfallbackToCpu=trueを返す', async () => {
      // Arrange
      mockNvidiaSmiNotAvailable();
      const manager = GpuResourceManager.getInstance();

      // Act
      const result = await manager.acquireForEmbedding();

      // Assert
      expect(result.acquired).toBe(false);
      expect(result.fallbackToCpu).toBe(true);
      expect(result.previousOwner).toBe('none');
    });

    it('onProviderSwitchがエラーを投げるとfallbackToCpu=trueを返す', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      gpuModeSignal.onProviderSwitch = vi.fn().mockRejectedValue(new Error('switch failed'));
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = GpuResourceManager.getInstance();

      // Act
      const result = await manager.acquireForEmbedding();

      // Assert: onProviderSwitchエラー → CPUフォールバック
      expect(result.acquired).toBe(false);
      expect(result.fallbackToCpu).toBe(true);
      // gpuModeSignalはCPUに戻る
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
    });

    it('onProviderSwitch未設定でもacquireForEmbeddingが動作する', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      gpuModeSignal.onProviderSwitch = undefined;
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = GpuResourceManager.getInstance();

      // Act
      const result = await manager.acquireForEmbedding();

      // Assert: コールバック未設定でも成功
      expect(result.acquired).toBe(true);
      expect(result.fallbackToCpu).toBe(false);
      expect(gpuModeSignal.requestedProvider).toBe('cuda');
    });
  });

  // ==========================================================================
  // release()
  // ==========================================================================

  describe('release()', () => {
    it('currentOwnerを"none"に設定する', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();
      await manager.acquireForVision();
      expect(manager.getCurrentOwner()).toBe('vision');

      // Act
      await manager.release();

      // Assert: 現在の所有者が"none"
      expect(manager.getCurrentOwner()).toBe('none');
    });

    it('Embeddingが所有中の場合、release時にonProviderSwitch("cpu")が呼ばれる', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const onProviderSwitch = vi.fn().mockResolvedValue(undefined);
      gpuModeSignal.onProviderSwitch = onProviderSwitch;
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = GpuResourceManager.getInstance();

      // EmbeddingがGPUを所有
      await manager.acquireForEmbedding();
      onProviderSwitch.mockClear();

      // Act
      await manager.release();

      // Assert
      expect(onProviderSwitch).toHaveBeenCalledWith('cpu');
    });

    it('Embedding release後にgpuModeSignal.requestedProviderが"cpu"になる', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = GpuResourceManager.getInstance();

      await manager.acquireForEmbedding();
      expect(gpuModeSignal.requestedProvider).toBe('cuda');

      // Act
      await manager.release();

      // Assert
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
    });

    it('所有者が"none"の場合はno-op', async () => {
      // Arrange
      const onProviderSwitch = vi.fn();
      gpuModeSignal.onProviderSwitch = onProviderSwitch;
      const manager = GpuResourceManager.getInstance();

      // Act: 所有者なし状態でrelease
      await manager.release();

      // Assert: コールバックは呼ばれない
      expect(onProviderSwitch).not.toHaveBeenCalled();
      expect(manager.getCurrentOwner()).toBe('none');
    });

    it('Visionが所有中の場合もrelease可能（onProviderSwitchは呼ばれない）', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const onProviderSwitch = vi.fn();
      gpuModeSignal.onProviderSwitch = onProviderSwitch;
      const manager = GpuResourceManager.getInstance();
      await manager.acquireForVision();
      onProviderSwitch.mockClear();

      // Act
      await manager.release();

      // Assert: Vision release時はonProviderSwitchは呼ばれない
      // （Ollama の GPU 解放は Ollama 自身のライフサイクルで管理）
      expect(onProviderSwitch).not.toHaveBeenCalled();
      expect(manager.getCurrentOwner()).toBe('none');
    });

    it('release中にonProviderSwitchがエラーを投げても処理完了する', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      gpuModeSignal.onProviderSwitch = vi.fn().mockRejectedValue(new Error('switch failed'));
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = GpuResourceManager.getInstance();

      await manager.acquireForEmbedding();

      // Act & Assert: エラーが伝播しない
      await expect(manager.release()).resolves.toBeUndefined();
      expect(manager.getCurrentOwner()).toBe('none');
    });
  });

  // ==========================================================================
  // getCurrentOwner()
  // ==========================================================================

  describe('getCurrentOwner()', () => {
    it('初期状態は"none"', () => {
      // Arrange & Act
      const manager = GpuResourceManager.getInstance();

      // Assert
      expect(manager.getCurrentOwner()).toBe('none');
    });

    it('acquireForVision後は"vision"', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // Act
      await manager.acquireForVision();

      // Assert
      expect(manager.getCurrentOwner()).toBe('vision');
    });

    it('acquireForEmbedding後は"embedding"', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = GpuResourceManager.getInstance();

      // Act
      await manager.acquireForEmbedding();

      // Assert
      expect(manager.getCurrentOwner()).toBe('embedding');
    });

    it('release後は"none"に戻る', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();
      await manager.acquireForVision();

      // Act
      await manager.release();

      // Assert
      expect(manager.getCurrentOwner()).toBe('none');
    });
  });

  // ==========================================================================
  // gpuModeSignal 共有シグナル
  // ==========================================================================

  describe('gpuModeSignal', () => {
    it('初期値はrequested​Provider="cpu"', () => {
      // Assert
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
    });

    it('onProviderSwitchは初期状態でundefined', () => {
      // Assert（beforeEachでリセット済み）
      expect(gpuModeSignal.onProviderSwitch).toBeUndefined();
    });

    it('acquireForEmbedding成功後にrequested​Providerが"cuda"になる', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });
      GpuResourceManager.getInstance();

      // Act
      const manager = GpuResourceManager.getInstance();
      await manager.acquireForEmbedding();

      // Assert
      expect(gpuModeSignal.requestedProvider).toBe('cuda');
    });

    it('release後にrequested​Providerが"cpu"に戻る', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = GpuResourceManager.getInstance();
      await manager.acquireForEmbedding();

      // Act
      await manager.release();

      // Assert
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
    });
  });

  // ==========================================================================
  // Graceful Degradation
  // ==========================================================================

  describe('Graceful Degradation', () => {
    it('nvidia-smi未搭載でもすべてのメソッドがエラーなく動作する', async () => {
      // Arrange: GPU非搭載環境
      mockNvidiaSmiNotAvailable();
      const manager = GpuResourceManager.getInstance();

      // Act & Assert: エラーなし
      const available = await manager.isGpuAvailable();
      expect(available).toBe(false);

      const visionResult = await manager.acquireForVision();
      expect(visionResult.acquired).toBe(false);

      const embeddingResult = await manager.acquireForEmbedding();
      expect(embeddingResult.fallbackToCpu).toBe(true);

      // release はエラーなし
      await expect(manager.release()).resolves.toBeUndefined();
    });

    it('Ollama未起動でもacquireForVisionが動作する', async () => {
      // Arrange: GPU利用可能だがOllama未起動
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // Act & Assert: Visionは取得可能
      // （GpuResourceManagerはVRAMの管理のみ、Ollamaの接続チェックはしない）
      const visionResult = await manager.acquireForVision();
      expect(visionResult.acquired).toBe(true);

      // release はエラーなし
      await expect(manager.release()).resolves.toBeUndefined();
    });

    it('Ollama未起動でacquireForEmbeddingはfallbackToCpuを返す', async () => {
      // Arrange: GPU利用可能だがOllama未起動
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockRejectedValue(new Error('Connection refused'));
      const manager = GpuResourceManager.getInstance();

      // VisionがGPUを所有
      await manager.acquireForVision();

      // Act: Embeddingに切り替え — Ollama unload失敗
      const result = await manager.acquireForEmbedding();

      // Assert: CPUフォールバック
      expect(result.fallbackToCpu).toBe(true);
    });

    it('GPU検出失敗はキャッシュされ再クエリしない', async () => {
      // Arrange
      mockNvidiaSmiNotAvailable();
      const manager = GpuResourceManager.getInstance();

      // Act: 複数回呼び出し
      await manager.isGpuAvailable();
      await manager.isGpuAvailable();
      await manager.isGpuAvailable();

      // Assert: nvidia-smiは1回のみ
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // 状態遷移の一貫性
  // ==========================================================================

  describe('状態遷移の一貫性', () => {
    it('Vision → Embedding → Vision の連続切り替えが正しく動作する', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const onProviderSwitch = vi.fn().mockResolvedValue(undefined);
      gpuModeSignal.onProviderSwitch = onProviderSwitch;
      const manager = GpuResourceManager.getInstance();

      // Ollama unload成功のモック（acquireForEmbeddingで使用）
      mockFetch.mockResolvedValue({ ok: true });

      // Act: Vision → Embedding → Vision
      const v1 = await manager.acquireForVision();
      expect(v1.acquired).toBe(true);
      expect(manager.getCurrentOwner()).toBe('vision');

      const e1 = await manager.acquireForEmbedding();
      expect(e1.acquired).toBe(true);
      expect(manager.getCurrentOwner()).toBe('embedding');

      const v2 = await manager.acquireForVision();
      expect(v2.acquired).toBe(true);
      expect(v2.previousOwner).toBe('embedding');
      expect(manager.getCurrentOwner()).toBe('vision');
    });

    it('release後に再度acquireできる', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();

      // Act: acquire → release → acquire
      await manager.acquireForVision();
      await manager.release();
      const result = await manager.acquireForVision();

      // Assert
      expect(result.acquired).toBe(true);
      expect(manager.getCurrentOwner()).toBe('vision');
    });

    it('Embedding → release → Embedding の連続操作が正しく動作する', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValue({ ok: true });
      const manager = GpuResourceManager.getInstance();

      // Act
      const e1 = await manager.acquireForEmbedding();
      expect(e1.acquired).toBe(true);

      await manager.release();
      expect(manager.getCurrentOwner()).toBe('none');

      const e2 = await manager.acquireForEmbedding();
      expect(e2.acquired).toBe(true);
      expect(e2.previousOwner).toBe('none');
      expect(manager.getCurrentOwner()).toBe('embedding');
    });

    it('Vision → Embedding → Release → Vision フルサイクルが正しく動作する', async () => {
      // Arrange: GPU搭載環境のフルサイクルテスト
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValue({ ok: true });
      const onProviderSwitch = vi.fn().mockResolvedValue(undefined);
      gpuModeSignal.onProviderSwitch = onProviderSwitch;
      const manager = GpuResourceManager.getInstance();

      // Phase 1: Vision 確保
      const v1 = await manager.acquireForVision();
      expect(v1.acquired).toBe(true);
      expect(v1.previousOwner).toBe('none');
      expect(manager.getCurrentOwner()).toBe('vision');
      expect(gpuModeSignal.requestedProvider).toBe('cpu'); // Vision は signal を変えない

      // Phase 2: Embedding に切り替え（Ollama unload → CUDA モード）
      const e1 = await manager.acquireForEmbedding();
      expect(e1.acquired).toBe(true);
      expect(e1.previousOwner).toBe('vision');
      expect(e1.fallbackToCpu).toBe(false);
      expect(manager.getCurrentOwner()).toBe('embedding');
      expect(gpuModeSignal.requestedProvider).toBe('cuda');

      // Phase 3: Release（ONNX dispose → CPU モード）
      onProviderSwitch.mockClear();
      await manager.release();
      expect(manager.getCurrentOwner()).toBe('none');
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
      expect(onProviderSwitch).toHaveBeenCalledWith('cpu');

      // Phase 4: 再度 Vision 確保
      const v2 = await manager.acquireForVision();
      expect(v2.acquired).toBe(true);
      expect(v2.previousOwner).toBe('none');
      expect(manager.getCurrentOwner()).toBe('vision');
    });

    it('GPU非搭載環境でのフルサイクルはすべてフォールバックする', async () => {
      // Arrange
      mockNvidiaSmiNotAvailable();
      const manager = GpuResourceManager.getInstance();

      // Vision 確保 → GPU なし
      const vResult = await manager.acquireForVision();
      expect(vResult.acquired).toBe(false);
      expect(manager.getCurrentOwner()).toBe('none');

      // Embedding 確保 → CPU フォールバック
      const eResult = await manager.acquireForEmbedding();
      expect(eResult.acquired).toBe(false);
      expect(eResult.fallbackToCpu).toBe(true);
      expect(manager.getCurrentOwner()).toBe('none');

      // Release は何もしない
      await manager.release();
      expect(manager.getCurrentOwner()).toBe('none');

      // fetch は一度も呼ばれない（GPU がないため Ollama unload 不要）
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // エッジケース
  // ==========================================================================

  describe('エッジケース', () => {
    it('release を連続で呼んでもエラーにならない', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      const manager = GpuResourceManager.getInstance();
      await manager.acquireForVision();

      // Act & Assert: 2回連続 release でエラーなし
      await expect(manager.release()).resolves.toBeUndefined();
      await expect(manager.release()).resolves.toBeUndefined();
      expect(manager.getCurrentOwner()).toBe('none');
    });

    it('Embedding 所有中に acquireForEmbedding を呼ぶと Ollama unload をスキップする', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValue({ ok: true });
      const manager = GpuResourceManager.getInstance();

      // 最初の acquireForEmbedding で Ollama unload
      await manager.acquireForEmbedding();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      mockFetch.mockClear();

      // Act: 2回目は currentOwner === 'embedding' なので unload 不要
      const result = await manager.acquireForEmbedding();

      // Assert: Ollama API は呼ばれない
      // (ソースの if (this.currentOwner === 'vision' || this.currentOwner === 'none') を検証)
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.acquired).toBe(true);
      expect(manager.getCurrentOwner()).toBe('embedding');
    });

    it('カスタム visionMinVramMb で低い VRAM 閾値を設定できる', async () => {
      // Arrange: 3000MB 空きで、閾値 2000MB
      mockExecFile.mockResolvedValue({
        stdout: '9288, 12288, 3000, 75\n',
      });

      const manager = new GpuResourceManager({
        visionMinVramMb: 2000,
      });

      // Act: 3000MB > 2000MB なので成功
      const result = await manager.acquireForVision();

      // Assert
      expect(result.acquired).toBe(true);
    });

    it('カスタム embeddingMinVramMb で低い VRAM 閾値を設定できる', async () => {
      // Arrange: 1500MB 空きで、閾値 1000MB
      mockExecFile.mockResolvedValue({
        stdout: '10788, 12288, 1500, 87\n',
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      const manager = new GpuResourceManager({
        embeddingMinVramMb: 1000,
      });

      // Act: 1500MB > 1000MB なので成功
      const result = await manager.acquireForEmbedding();

      // Assert
      expect(result.acquired).toBe(true);
      expect(result.fallbackToCpu).toBe(false);
    });
  });

  // ==========================================================================
  // カスタム設定
  // ==========================================================================

  describe('カスタム設定', () => {
    it('ollamaUrlをカスタム設定できる（localhostのみ許可）', async () => {
      // Arrange: localhost上のカスタムポートを指定
      vi.useRealTimers();
      mockExecFile.mockReset();
      mockFetch.mockReset();

      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const config = { ollamaUrl: 'http://localhost:12345' };
      const manager = new GpuResourceManager(config);

      // Act: acquireForEmbeddingはunloadOllamaModel → fetchを呼ぶ
      await manager.acquireForEmbedding();

      // Assert: カスタムポートのURLでfetchが呼ばれた
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:12345/api/generate',
        expect.anything()
      );

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('SSRF防止: 非localhostのURLはデフォルトにフォールバックする', async () => {
      // Arrange: 外部ホストを指定（SSRF攻撃のシミュレート）
      vi.useRealTimers();
      mockExecFile.mockReset();
      mockFetch.mockReset();

      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const config = { ollamaUrl: 'http://evil-server.com:11434' };
      const manager = new GpuResourceManager(config);

      // Act
      await manager.acquireForEmbedding();

      // Assert: デフォルトlocalhost URLにフォールバック（SSRF防止）
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.anything()
      );

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('SSRF防止: 127.0.0.1 は許可される', async () => {
      // Arrange
      vi.useRealTimers();
      mockExecFile.mockReset();
      mockFetch.mockReset();

      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const config = { ollamaUrl: 'http://127.0.0.1:11434' };
      const manager = new GpuResourceManager(config);

      // Act
      await manager.acquireForEmbedding();

      // Assert: 127.0.0.1 はブロックされない
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:11434/api/generate',
        expect.anything()
      );

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('SSRF防止: [::1] (IPv6 localhost) は brackets 付きホスト名のためデフォルトにフォールバック', async () => {
      // Arrange: Node.js の URL parser は IPv6 を brackets 付きで返す
      // new URL('http://[::1]:11434').hostname === '[::1]' (not '::1')
      // allowedHosts に '::1' はあるが '[::1]' はないためフォールバック
      vi.useRealTimers();
      mockExecFile.mockReset();
      mockFetch.mockReset();

      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const config = { ollamaUrl: 'http://[::1]:11434' };
      const manager = new GpuResourceManager(config);

      // Act
      await manager.acquireForEmbedding();

      // Assert: デフォルト localhost にフォールバック（SSRF防止の副作用だが安全側）
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('localhost'),
        expect.anything()
      );

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('SSRF防止: メタデータサービスURL (169.254.169.254) はブロックされる', async () => {
      // Arrange: クラウドメタデータサービスへのSSRF
      vi.useRealTimers();
      mockExecFile.mockReset();
      mockFetch.mockReset();

      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const config = { ollamaUrl: 'http://169.254.169.254:11434' };
      const manager = new GpuResourceManager(config);

      // Act
      await manager.acquireForEmbedding();

      // Assert: デフォルトlocalhost URLにフォールバック
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.anything()
      );

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('SSRF防止: 不正なURLはデフォルトにフォールバックする', async () => {
      // Arrange: パース不可能なURL
      vi.useRealTimers();
      mockExecFile.mockReset();
      mockFetch.mockReset();

      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const config = { ollamaUrl: 'not-a-valid-url' };
      const manager = new GpuResourceManager(config);

      // Act
      await manager.acquireForEmbedding();

      // Assert: デフォルトlocalhost URLにフォールバック
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.anything()
      );

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('SSRF防止: プライベートIP (10.0.0.1) はブロックされる', async () => {
      // Arrange: プライベートネットワークへのSSRF
      vi.useRealTimers();
      mockExecFile.mockReset();
      mockFetch.mockReset();

      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const config = { ollamaUrl: 'http://10.0.0.1:11434' };
      const manager = new GpuResourceManager(config);

      // Act
      await manager.acquireForEmbedding();

      // Assert: デフォルトlocalhost URLにフォールバック
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.anything()
      );

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('vramPollTimeoutMsをカスタム設定できる', async () => {
      // Arrange: 短いタイムアウト（5秒）
      const manager = new GpuResourceManager({
        vramPollTimeoutMs: 5000,
      });

      // 常にVRAM不足
      mockExecFile.mockResolvedValue({
        stdout: '10000, 12288, 2288, 80\n',
      });

      // Act
      const resultPromise = manager.acquireForVision();
      await vi.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;

      // Assert: 5秒でタイムアウト
      expect(result.acquired).toBe(false);
    });

    it('デフォルトollamaUrlはlocalhost:11434', async () => {
      // Arrange: デフォルト設定
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = new GpuResourceManager();

      // Act
      await manager.acquireForEmbedding();

      // Assert: デフォルトURLが使用される
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.anything()
      );
    });
  });

  // ==========================================================================
  // gpuModeSignal コンストラクタインジェクション（Task 1b）
  // ==========================================================================

  describe('gpuModeSignal コンストラクタインジェクション', () => {
    /**
     * テスト用の独立した GpuModeSignal を生成する
     */
    function createTestSignal(): GpuModeSignal {
      return { requestedProvider: 'cpu' };
    }

    it('コンストラクタに signal を渡すと、モジュールスコープの gpuModeSignal を使わない', async () => {
      // Arrange: 独立したシグナルを注入
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const testSignal = createTestSignal();
      const manager = new GpuResourceManager(undefined, testSignal);

      // Act: acquireForEmbedding → testSignal.requestedProvider が 'cuda' に変わる
      await manager.acquireForEmbedding();

      // Assert: 注入されたシグナルが更新される
      expect(testSignal.requestedProvider).toBe('cuda');
      // モジュールスコープのシグナルは変更されない
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
    });

    it('signal 未指定時はデフォルトのモジュールスコープ gpuModeSignal を使用する', async () => {
      // Arrange: signal なし（デフォルト動作）
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });
      const manager = new GpuResourceManager();

      // Act
      await manager.acquireForEmbedding();

      // Assert: モジュールスコープのシグナルが更新される
      expect(gpuModeSignal.requestedProvider).toBe('cuda');
    });

    it('getInstance() に signal を渡すと初回のみ適用される', async () => {
      // Arrange
      const testSignal = createTestSignal();
      const instance1 = GpuResourceManager.getInstance(undefined, testSignal);

      // Act: 2回目は別シグナルでも無視される（シングルトン）
      const otherSignal = createTestSignal();
      const instance2 = GpuResourceManager.getInstance(undefined, otherSignal);

      // Assert: 同一インスタンス
      expect(instance1).toBe(instance2);
    });

    it('注入されたシグナルの onProviderSwitch が呼ばれる', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const testSignal = createTestSignal();
      const onProviderSwitch = vi.fn().mockResolvedValue(undefined);
      testSignal.onProviderSwitch = onProviderSwitch;

      const manager = new GpuResourceManager(undefined, testSignal);

      // Act
      await manager.acquireForEmbedding();

      // Assert: 注入シグナルの onProviderSwitch が呼ばれる
      expect(onProviderSwitch).toHaveBeenCalledWith('cuda');
    });

    it('release() 時に注入シグナルの requestedProvider が "cpu" に戻る', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const testSignal = createTestSignal();
      const onProviderSwitch = vi.fn().mockResolvedValue(undefined);
      testSignal.onProviderSwitch = onProviderSwitch;

      const manager = new GpuResourceManager(undefined, testSignal);
      await manager.acquireForEmbedding();
      expect(testSignal.requestedProvider).toBe('cuda');

      // Act
      await manager.release();

      // Assert
      expect(testSignal.requestedProvider).toBe('cpu');
      expect(onProviderSwitch).toHaveBeenCalledWith('cpu');
    });

    it('Vision → Embedding 切り替え時に注入シグナルが正しく更新される', async () => {
      // Arrange
      mockNvidiaSmiSuccess(2000, 12288, 10288);
      mockFetch.mockResolvedValue({ ok: true });

      const testSignal = createTestSignal();
      const onProviderSwitch = vi.fn().mockResolvedValue(undefined);
      testSignal.onProviderSwitch = onProviderSwitch;

      const manager = new GpuResourceManager(undefined, testSignal);

      // Act: Vision → Embedding
      await manager.acquireForVision();
      expect(testSignal.requestedProvider).toBe('cpu');

      await manager.acquireForEmbedding();
      expect(testSignal.requestedProvider).toBe('cuda');

      // Embedding → Vision: onProviderSwitch('cpu') が呼ばれる
      onProviderSwitch.mockClear();
      await manager.acquireForVision();

      // Assert
      expect(testSignal.requestedProvider).toBe('cpu');
      expect(onProviderSwitch).toHaveBeenCalledWith('cpu');
      // モジュールスコープは影響を受けない
      expect(gpuModeSignal.requestedProvider).toBe('cpu');
    });
  });
});
