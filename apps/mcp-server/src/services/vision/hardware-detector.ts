// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HardwareDetector - GPU/CPU検出機能
 *
 * Vision CPU完走保証 Phase 1: Ollama /api/ps からハードウェア情報を取得
 *
 * 機能:
 * - Ollama /api/ps エンドポイントからモデル情報取得
 * - size_vram > 0 でGPU検出、それ以外はCPU
 * - 5分間キャッシュ（HARDWARE_CACHE_TTL_MS = 300000）
 * - Ollama未起動時はCPUフォールバック（Graceful Degradation）
 * - 並行リクエスト時のデデュプリケーション
 * - VISION_FORCE_CPU_MODE=true で強制CPUモード（NVMLドライバ不整合対策）
 *
 * @see apps/mcp-server/tests/services/vision/hardware-detector.test.ts
 */

// =============================================================================
// 定数
// =============================================================================

/**
 * ハードウェアキャッシュTTL（5分）
 */
export const HARDWARE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * デフォルトOllama URL
 */
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/**
 * API呼び出しタイムアウト（5秒）
 */
const API_TIMEOUT_MS = 5000;

/**
 * 環境変数: 強制CPUモード
 *
 * NVMLドライバ/ライブラリバージョン不整合などでGPUが物理的に存在するが
 * 実際にはCPUで推論が行われる場合に使用。
 *
 * 設定方法:
 * - 環境変数: VISION_FORCE_CPU_MODE=true
 * - コンストラクタオプション: { forceCpuMode: true }
 */
const ENV_FORCE_CPU_MODE = 'VISION_FORCE_CPU_MODE';

// =============================================================================
// 型定義
// =============================================================================

/**
 * ハードウェアタイプ列挙型
 */
export enum HardwareType {
  GPU = 'GPU',
  CPU = 'CPU',
}

/**
 * GPUベンダー列挙型
 */
export enum GpuVendor {
  NVIDIA = 'NVIDIA',
  APPLE_METAL = 'APPLE_METAL',
  UNKNOWN = 'UNKNOWN',
}

/**
 * ハードウェア情報
 */
export interface HardwareInfo {
  /** ハードウェアタイプ（GPU/CPU） */
  type: HardwareType;
  /** VRAM使用量（バイト） */
  vramBytes: number;
  /** GPUが利用可能かどうか */
  isGpuAvailable: boolean;
  /** GPUベンダー（GPU検出時のみ設定） */
  gpuVendor?: GpuVendor;
  /** エラーメッセージ（Ollama未起動時等） */
  error?: string;
}

/**
 * HardwareDetector設定
 */
export interface HardwareDetectorConfig {
  /** Ollama API URL */
  ollamaUrl?: string;
  /**
   * 強制CPUモード
   *
   * trueの場合、Ollama APIの結果に関わらずCPUとして検出する。
   * NVMLドライバ/ライブラリバージョン不整合などでGPUが使用できない場合に有効。
   *
   * 優先順位:
   * 1. コンストラクタオプション (forceCpuMode)
   * 2. 環境変数 (VISION_FORCE_CPU_MODE=true)
   */
  forceCpuMode?: boolean;
}

/**
 * Ollama /api/ps レスポンス型
 */
interface OllamaPsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    size_vram?: number;
  }> | null;
}

/**
 * キャッシュエントリ
 */
interface CacheEntry {
  info: HardwareInfo;
  timestamp: number;
}

// =============================================================================
// HardwareDetector クラス
// =============================================================================

/**
 * ハードウェア検出クラス
 *
 * Ollama /api/ps エンドポイントを使用してGPU/CPUを検出。
 * 結果は5分間キャッシュされ、並行リクエスト時はデデュプリケーションを行う。
 *
 * @example
 * ```typescript
 * const detector = new HardwareDetector();
 * const info = await detector.detect();
 * if (info.type === HardwareType.GPU) {
 *   console.log('GPU detected with', info.vramBytes, 'bytes VRAM');
 * }
 * ```
 */
export class HardwareDetector {
  /**
   * Apple Silicon（macOS arm64）かどうかを判定
   *
   * process.platform/process.archのみ使用（外部コマンド実行なし）
   *
   * @returns Apple Silicon環境の場合true
   */
  static isAppleSilicon(): boolean {
    return process.platform === 'darwin' && process.arch === 'arm64';
  }

  private readonly ollamaUrl: string;
  private readonly forceCpuMode: boolean;
  private cache: CacheEntry | null = null;
  private pendingRequest: Promise<HardwareInfo> | null = null;

  /**
   * HardwareDetectorのコンストラクタ
   *
   * @param config - 設定オプション
   */
  constructor(config?: HardwareDetectorConfig) {
    this.ollamaUrl = config?.ollamaUrl ?? DEFAULT_OLLAMA_URL;
    // 強制CPUモード: コンストラクタオプション > 環境変数
    this.forceCpuMode =
      config?.forceCpuMode ??
      process.env[ENV_FORCE_CPU_MODE]?.toLowerCase() === 'true';
  }

  // ===========================================================================
  // パブリックメソッド
  // ===========================================================================

  /**
   * ハードウェア情報を検出
   *
   * - 強制CPUモードが有効な場合は即座にCPUを返却
   * - キャッシュが有効な場合はキャッシュから返却
   * - 並行リクエストがある場合は同一リクエストを共有
   * - Ollama未起動時はCPUフォールバック
   *
   * @returns ハードウェア情報
   */
  async detect(): Promise<HardwareInfo> {
    // 強制CPUモードチェック（NVMLドライバ不整合対策）
    if (this.forceCpuMode) {
      return this.createCpuFallback(
        'Force CPU mode enabled (VISION_FORCE_CPU_MODE=true)'
      );
    }

    // キャッシュチェック
    const cachedInfo = this.getCachedInfo();
    if (cachedInfo) {
      return cachedInfo;
    }

    // 並行リクエストのデデュプリケーション
    if (this.pendingRequest) {
      return this.pendingRequest;
    }

    // 新しいリクエストを開始
    this.pendingRequest = this.fetchHardwareInfo();

    try {
      const info = await this.pendingRequest;
      this.cacheInfo(info);
      return info;
    } finally {
      this.pendingRequest = null;
    }
  }

  /**
   * キャッシュをクリア
   */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * 強制CPUモードが有効かどうかを返す
   *
   * @returns 強制CPUモードが有効な場合true
   */
  isForceCpuModeEnabled(): boolean {
    return this.forceCpuMode;
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * キャッシュからハードウェア情報を取得
   */
  private getCachedInfo(): HardwareInfo | null {
    if (!this.cache) {
      return null;
    }

    const now = Date.now();
    const elapsed = now - this.cache.timestamp;

    if (elapsed > HARDWARE_CACHE_TTL_MS) {
      this.cache = null;
      return null;
    }

    return this.cache.info;
  }

  /**
   * ハードウェア情報をキャッシュに保存
   */
  private cacheInfo(info: HardwareInfo): void {
    this.cache = {
      info,
      timestamp: Date.now(),
    };
  }

  /**
   * Ollama APIからハードウェア情報を取得
   */
  private async fetchHardwareInfo(): Promise<HardwareInfo> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      try {
        const response = await fetch(`${this.ollamaUrl}/api/ps`, {
          method: 'GET',
          signal: controller.signal,
        });

        if (!response.ok) {
          return this.createCpuFallback(
            `Ollama API error: ${response.status} ${response.statusText}`
          );
        }

        const data = (await response.json()) as OllamaPsResponse;
        return this.parseOllamaResponse(data);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      return this.createCpuFallback(
        `Ollama connection failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Ollama /api/ps レスポンスをパース
   */
  private parseOllamaResponse(data: OllamaPsResponse): HardwareInfo {
    // models配列が存在しないか空の場合はCPU
    const models = data.models;
    if (!models || !Array.isArray(models) || models.length === 0) {
      return this.createCpuFallback();
    }

    // 最大VRAM使用量を検出
    let maxVram = 0;
    for (const model of models) {
      const vram = model.size_vram ?? 0;
      if (vram > maxVram) {
        maxVram = vram;
      }
    }

    // VRAM > 0 ならGPU、それ以外はCPU
    if (maxVram > 0) {
      return {
        type: HardwareType.GPU,
        vramBytes: maxVram,
        isGpuAvailable: true,
        gpuVendor: HardwareDetector.isAppleSilicon()
          ? GpuVendor.APPLE_METAL
          : GpuVendor.NVIDIA,
      };
    }

    return this.createCpuFallback();
  }

  /**
   * CPUフォールバック情報を作成
   */
  private createCpuFallback(error?: string): HardwareInfo {
    return {
      type: HardwareType.CPU,
      vramBytes: 0,
      isGpuAvailable: false,
      ...(error && { error }),
    };
  }
}
