// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GpuResourceManager - GPU リソース割り当て管理サービス
 *
 * Ollama Vision (llama3.2-vision: ~9.3GB VRAM) と ONNX Embedding
 * (multilingual-e5-base CUDA: ~2GB VRAM) 間の GPU リソースを動的に切り替える。
 *
 * page.analyze ワーカーパイプラインでは1サイト処理中に以下の切り替えが発生する:
 * - Vision フェーズ (Phase 1.5/2.5): Ollama が GPU を使用
 * - Embedding フェーズ (Phase 5): ONNX CUDA が GPU を使用
 *
 * 従来は Ollama がジョブ全体で GPU を保持し、ONNX は CPU で実行していた
 * (大規模サイトで 8 分以上)。本サービスにより GPU を動的にスイッチし、
 * Embedding フェーズも CUDA で高速化する。
 *
 * @module services/gpu-resource-manager
 */

import { createLogger } from '../utils/logger.js';
import { queryVram } from './vision/vram-utils.js';

const logger = createLogger('GpuResourceManager');

// =============================================================================
// 定数
// =============================================================================

/** Ollama Vision (llama3.2-vision) に必要な最小 VRAM (MB) */
const VISION_MIN_VRAM_MB = 8192;

/** ONNX Embedding CUDA に必要な最小 VRAM (MB) */
const EMBEDDING_MIN_VRAM_MB = 2048;

/** VRAM ポーリング間隔 (ms) — 指数バックオフの初期値 */
const VRAM_POLL_INITIAL_MS = 2000;

/** VRAM ポーリングの最大待機時間 (ms) */
const VRAM_POLL_TIMEOUT_MS = 30_000;

/** Ollama API タイムアウト (ms) */
const OLLAMA_API_TIMEOUT_MS = 10_000;

/** Ollama のデフォルト URL */
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Ollama Vision モデル名 */
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? 'llama3.2-vision';

// =============================================================================
// 型定義
// =============================================================================

/** GPU リソースの現在のオーナー */
export type GpuOwner = 'vision' | 'embedding' | 'none';

/** acquireForVision() の戻り値 */
export interface VisionAcquireResult {
  acquired: boolean;
  previousOwner: 'embedding' | 'none';
}

/** acquireForEmbedding() の戻り値 */
export interface EmbeddingAcquireResult {
  acquired: boolean;
  previousOwner: 'vision' | 'none';
  fallbackToCpu: boolean;
}

/**
 * ONNX GPU モードシグナル
 *
 * EmbeddingService がインポートして参照する共有シグナルオブジェクト。
 * GpuResourceManager が requestedProvider を変更し、
 * EmbeddingService が次回パイプライン初期化時にこの値を使用する。
 */
export interface GpuModeSignal {
  /** 要求された実行プロバイダ */
  requestedProvider: 'cpu' | 'cuda';
  /**
   * プロバイダ切り替え時のコールバック。
   * EmbeddingService が設定し、GpuResourceManager が呼び出す。
   * パイプラインの dispose + 再初期化をトリガーする。
   */
  onProviderSwitch?: ((provider: 'cpu' | 'cuda') => Promise<void>) | undefined;
}

/** GpuResourceManager 設定 */
export interface GpuResourceManagerConfig {
  /** Ollama API URL */
  ollamaUrl?: string | undefined;
  /** Vision に必要な最小 VRAM (MB) */
  visionMinVramMb?: number | undefined;
  /** Embedding CUDA に必要な最小 VRAM (MB) */
  embeddingMinVramMb?: number | undefined;
  /** VRAM ポーリングタイムアウト (ms) */
  vramPollTimeoutMs?: number | undefined;
}

// =============================================================================
// 共有シグナルオブジェクト (モジュールスコープ singleton)
// =============================================================================

/**
 * EmbeddingService が参照する GPU モードシグナル。
 *
 * @example
 * ```typescript
 * import { gpuModeSignal } from '../services/gpu-resource-manager.js';
 *
 * // EmbeddingService 側
 * gpuModeSignal.onProviderSwitch = async (provider) => {
 *   await embeddingService.dispose();
 *   // 次回 init で provider を使用
 * };
 * ```
 */
export const gpuModeSignal: GpuModeSignal = {
  requestedProvider: 'cpu',
};

// =============================================================================
// GpuResourceManager クラス
// =============================================================================

/** シングルトンインスタンス */
let singletonInstance: GpuResourceManager | null = null;

/**
 * GPU リソース割り当てマネージャ
 *
 * シングルトンパターンで運用。ワーカープロセス内で1インスタンスのみ生成し、
 * Vision フェーズと Embedding フェーズ間の GPU 切り替えを協調制御する。
 */
export class GpuResourceManager {
  private readonly ollamaUrl: string;
  private readonly visionMinVramMb: number;
  private readonly embeddingMinVramMb: number;
  private readonly vramPollTimeoutMs: number;
  private readonly signal: GpuModeSignal;

  private currentOwner: GpuOwner = 'none';
  private gpuAvailable: boolean | null = null;

  constructor(config?: GpuResourceManagerConfig, signal?: GpuModeSignal) {
    this.ollamaUrl = GpuResourceManager.validateOllamaUrl(config?.ollamaUrl ?? DEFAULT_OLLAMA_URL);
    this.visionMinVramMb = config?.visionMinVramMb ?? VISION_MIN_VRAM_MB;
    this.embeddingMinVramMb = config?.embeddingMinVramMb ?? EMBEDDING_MIN_VRAM_MB;
    this.vramPollTimeoutMs = config?.vramPollTimeoutMs ?? VRAM_POLL_TIMEOUT_MS;
    this.signal = signal ?? gpuModeSignal;
  }

  /**
   * Ollama URL を検証（SSRF 防止）
   *
   * SEC: Ollama は常にローカルホストで実行される前提。
   * 外部 URL への接続を防止し、SSRF 攻撃を阻止する。
   */
  private static validateOllamaUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const allowedHosts = ['localhost', '127.0.0.1', '::1'];
      if (!allowedHosts.includes(parsed.hostname)) {
        logger.warn('Ollama URL rejected: must point to localhost', { url: parsed.hostname });
        return DEFAULT_OLLAMA_URL;
      }
      return url;
    } catch {
      logger.warn('Invalid Ollama URL, falling back to default', { url });
      return DEFAULT_OLLAMA_URL;
    }
  }

  // ===========================================================================
  // シングルトン管理
  // ===========================================================================

  /**
   * シングルトンインスタンスを取得
   */
  static getInstance(config?: GpuResourceManagerConfig, signal?: GpuModeSignal): GpuResourceManager {
    if (!singletonInstance) {
      singletonInstance = new GpuResourceManager(config, signal);
    }
    return singletonInstance;
  }

  /**
   * シングルトンインスタンスをリセット（テスト用）
   */
  static resetInstance(): void {
    singletonInstance = null;
  }

  // ===========================================================================
  // パブリック API
  // ===========================================================================

  /**
   * Vision フェーズ用に GPU を確保
   *
   * ONNX が GPU を使用中の場合、パイプラインを dispose して GPU を解放する。
   * VRAM に十分な空きができるまでポーリングで待機する。
   *
   * @returns 確保結果
   */
  async acquireForVision(): Promise<VisionAcquireResult> {
    const hasGpu = await this.isGpuAvailable();

    if (!hasGpu) {
      logger.info('No GPU available, Vision will use CPU-based Ollama');
      return { acquired: false, previousOwner: 'none' };
    }

    const previousOwner = this.currentOwner === 'embedding' ? 'embedding' as const : 'none' as const;

    // ONNX Embedding が GPU を使用中の場合: dispose して GPU を解放
    if (this.currentOwner === 'embedding') {
      logger.info('Switching GPU: embedding → vision');

      // EmbeddingService にパイプライン dispose を要求
      if (this.signal.onProviderSwitch) {
        try {
          await this.signal.onProviderSwitch('cpu');
        } catch (error) {
          logger.warn('Failed to signal ONNX provider switch to CPU', error);
        }
      }
      this.signal.requestedProvider = 'cpu';
    }

    // VRAM 空き容量を待機
    const vramReady = await this.waitForVram(this.visionMinVramMb);

    if (!vramReady) {
      logger.warn('Failed to acquire sufficient VRAM for Vision', {
        requiredMb: this.visionMinVramMb,
      });
      return { acquired: false, previousOwner };
    }

    this.currentOwner = 'vision';
    logger.info('GPU acquired for Vision', { previousOwner });
    return { acquired: true, previousOwner };
  }

  /**
   * Embedding フェーズ用に GPU を確保
   *
   * Ollama モデルを VRAM からアンロードし、ONNX CUDA に十分な VRAM を確保する。
   * VRAM 確保に失敗した場合は CPU フォールバックを指示する。
   *
   * @returns 確保結果
   */
  async acquireForEmbedding(): Promise<EmbeddingAcquireResult> {
    const hasGpu = await this.isGpuAvailable();

    if (!hasGpu) {
      logger.info('No GPU available, Embedding will use CPU');
      return { acquired: false, previousOwner: 'none', fallbackToCpu: true };
    }

    const previousOwner = this.currentOwner === 'vision' ? 'vision' as const : 'none' as const;

    // Ollama Vision モデルを VRAM からアンロード
    if (this.currentOwner === 'vision' || this.currentOwner === 'none') {
      logger.info('Switching GPU: vision → embedding (unloading Ollama model)');

      const unloaded = await this.unloadOllamaModel();
      if (!unloaded) {
        logger.warn('Failed to unload Ollama model, falling back to CPU for Embedding');
        return { acquired: false, previousOwner, fallbackToCpu: true };
      }
    }

    // VRAM 空き容量を待機
    const vramReady = await this.waitForVram(this.embeddingMinVramMb);

    if (!vramReady) {
      logger.warn('Insufficient VRAM for ONNX CUDA after Ollama unload, falling back to CPU');
      this.signal.requestedProvider = 'cpu';
      return { acquired: false, previousOwner, fallbackToCpu: true };
    }

    // ONNX を CUDA モードに切り替え
    this.signal.requestedProvider = 'cuda';
    if (this.signal.onProviderSwitch) {
      try {
        await this.signal.onProviderSwitch('cuda');
      } catch (error) {
        logger.warn('Failed to signal ONNX provider switch to CUDA, falling back to CPU', error);
        this.signal.requestedProvider = 'cpu';
        return { acquired: false, previousOwner, fallbackToCpu: true };
      }
    }

    this.currentOwner = 'embedding';
    logger.info('GPU acquired for Embedding (CUDA)', { previousOwner });
    return { acquired: true, previousOwner, fallbackToCpu: false };
  }

  /**
   * GPU リソースを解放
   *
   * ONNX パイプラインを dispose して GPU を解放する。
   * Ollama は自身のライフサイクルで管理するためアンロードしない。
   */
  async release(): Promise<void> {
    if (this.currentOwner === 'none') {
      return;
    }

    logger.info('Releasing GPU resources', { currentOwner: this.currentOwner });

    if (this.currentOwner === 'embedding') {
      // ONNX パイプラインを dispose
      if (this.signal.onProviderSwitch) {
        try {
          await this.signal.onProviderSwitch('cpu');
        } catch (error) {
          logger.warn('Failed to signal ONNX provider switch during release', error);
        }
      }
      this.signal.requestedProvider = 'cpu';
    }

    this.currentOwner = 'none';
    logger.info('GPU resources released');
  }

  /**
   * 現在の GPU オーナーを取得
   */
  getCurrentOwner(): GpuOwner {
    return this.currentOwner;
  }

  /**
   * GPU が利用可能かチェック
   *
   * nvidia-smi が実行可能であれば GPU ありと判定。
   * 結果はキャッシュされる（プロセスライフタイム中は不変）。
   */
  async isGpuAvailable(): Promise<boolean> {
    if (this.gpuAvailable !== null) {
      return this.gpuAvailable;
    }

    const vram = await queryVram();
    this.gpuAvailable = vram !== null;

    if (this.gpuAvailable) {
      logger.info('GPU detected', {
        totalMb: vram!.totalMb,
        freeMb: vram!.freeMb,
      });
    } else {
      logger.info('No GPU detected (nvidia-smi not available)');
    }

    return this.gpuAvailable;
  }

  // ===========================================================================
  // VRAM 監視
  // ===========================================================================

  /**
   * VRAM 空き容量が閾値を満たすまでポーリング待機
   *
   * 指数バックオフ: 2s → 4s → 8s → 16s
   * タイムアウト: 30 秒
   *
   * @param requiredFreeMb - 必要な空き VRAM (MB)
   * @returns 閾値を満たした場合 true
   */
  private async waitForVram(requiredFreeMb: number): Promise<boolean> {
    const startTime = Date.now();
    let delay = VRAM_POLL_INITIAL_MS;

    while (Date.now() - startTime < this.vramPollTimeoutMs) {
      const vram = await queryVram();

      // nvidia-smi 利用不可: VRAM チェック不能、best-effort で続行
      if (vram === null) {
        logger.info('nvidia-smi unavailable during VRAM wait, proceeding with best-effort');
        return true;
      }

      if (vram.freeMb >= requiredFreeMb) {
        logger.info('VRAM requirement met', {
          freeMb: vram.freeMb,
          requiredFreeMb,
          waitedMs: Date.now() - startTime,
        });
        return true;
      }

      logger.info('Waiting for VRAM', {
        freeMb: vram.freeMb,
        requiredFreeMb,
        nextPollMs: delay,
      });

      await this.sleep(delay);

      // 指数バックオフ（上限 16s）
      delay = Math.min(delay * 2, 16_000);
    }

    // タイムアウト
    const finalVram = await queryVram();
    logger.warn('VRAM wait timeout', {
      freeMb: finalVram?.freeMb ?? 'unknown',
      requiredFreeMb,
      timeoutMs: this.vramPollTimeoutMs,
    });
    return false;
  }

  // ===========================================================================
  // Ollama モデル管理
  // ===========================================================================

  /**
   * Ollama Vision モデルを VRAM からアンロード
   *
   * `keep_alive: '0'` を指定することで、Ollama にモデルを即座に
   * VRAM からアンロードするよう指示する。
   *
   * @returns アンロード成功時 true
   */
  private async unloadOllamaModel(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_VISION_MODEL,
          keep_alive: '0',
          prompt: '',
        }),
        signal: AbortSignal.timeout(OLLAMA_API_TIMEOUT_MS),
      });

      if (!response.ok) {
        logger.warn('Ollama model unload request failed', {
          status: response.status,
          statusText: response.statusText,
        });
        return false;
      }

      logger.info('Ollama model unloaded from VRAM', { model: OLLAMA_VISION_MODEL });
      return true;
    } catch (error) {
      // Ollama 未起動やネットワークエラー: 警告のみ
      logger.warn('Failed to unload Ollama model (service may be unavailable)', error);
      return false;
    }
  }

  // ===========================================================================
  // ユーティリティ
  // ===========================================================================

  /**
   * 指定ミリ秒だけスリープ
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
