// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LlamaVisionAdapter - Vision CPU完走保証 Phase 2
 *
 * ImageOptimizer、HardwareDetector、OllamaVisionClientを統合したアダプター。
 * CPU推論時に画像を自動最適化し、推論時間を短縮する。
 *
 * 機能:
 * - HardwareDetectorによるGPU/CPU自動検出
 * - CPU時の画像自動最適化（ImageOptimizer）
 * - 動的タイムアウト計算（TimeoutCalculator）
 * - Graceful Degradation（最適化失敗時は元画像で続行）
 * - パフォーマンスメトリクス収集
 *
 * @see apps/mcp-server/tests/services/vision/llama-vision-adapter.test.ts
 */

import { HardwareDetector, HardwareType, type HardwareInfo } from './hardware-detector.js';
import { ImageOptimizer, type OptimizeResult } from './image-optimizer.js';
import { OllamaVisionClient, type HardwareDetectorLike } from './ollama-vision-client.js';

// =============================================================================
// 型定義
// =============================================================================

/**
 * Vision分析オプション
 */
export interface VisionAnalysisOptions {
  /** 最適化を有効にするか（デフォルト: true） */
  enableOptimization?: boolean;
  /** 元画像を強制使用するか（最適化をスキップ） */
  forceOriginal?: boolean;
}

/**
 * Vision分析結果のメトリクス
 */
export interface VisionAnalysisMetrics {
  /** ハードウェアタイプ（GPU/CPU） */
  hardwareType: HardwareType;
  /** 元の画像サイズ（バイト） */
  originalSizeBytes: number;
  /** 最適化後の画像サイズ（バイト、最適化された場合のみ） */
  optimizedSizeBytes?: number | undefined;
  /** 最適化が適用されたか */
  optimizationApplied: boolean;
  /** 最適化がスキップされた理由 */
  optimizationSkipReason?: string | undefined;
  /** 最適化エラー（失敗時） */
  optimizationError?: string | undefined;
  /** 最適化処理時間（ミリ秒） */
  optimizationTimeMs?: number | undefined;
  /** 圧縮率（最適化後サイズ / 元サイズ） */
  compressionRatio?: number | undefined;
  /** 合計処理時間（ミリ秒） */
  totalProcessingTimeMs: number;
  /** ハードウェア検出エラー */
  hardwareDetectionError?: string | undefined;
}

/**
 * Vision分析結果
 */
export interface VisionAnalysisResult<T = string> {
  /** 分析結果（テキストまたはJSON） */
  response: T;
  /** パフォーマンスメトリクス */
  metrics: VisionAnalysisMetrics;
}

/**
 * LlamaVisionAdapter設定
 */
export interface LlamaVisionAdapterConfig {
  /** 最適化を有効にするか（デフォルト: true） */
  enableOptimization?: boolean;
  /** 最適化対象の最大画像サイズ（バイト、デフォルト: なし = ImageOptimizerの閾値に従う） */
  maxImageSizeBytes?: number;
  /** Ollama API URL */
  ollamaUrl?: string;
  /** HardwareDetector（DI用） */
  hardwareDetector?: HardwareDetectorLike;
  /** ImageOptimizer（DI用） */
  imageOptimizer?: ImageOptimizerLike;
  /** OllamaVisionClient（DI用） */
  ollamaClient?: OllamaVisionClientLike;
}

/**
 * HardwareDetectorのインターフェース（テスト用モック対応）
 */
interface HardwareDetectorLikeInternal {
  detect(): Promise<HardwareInfo>;
  clearCache(): void;
}

/**
 * ImageOptimizerのインターフェース（テスト用モック対応）
 */
interface ImageOptimizerLike {
  optimizeForCPU(
    input: Buffer | string,
    options: { hardwareType: HardwareType; forceStrategy?: unknown }
  ): Promise<OptimizeResult>;
  selectStrategy?(hardwareType: HardwareType, imageSizeBytes: number): unknown;
  estimateOptimalSize?(imageSizeBytes: number, hardwareType: HardwareType): unknown;
}

/**
 * OllamaVisionClientのインターフェース（テスト用モック対応）
 */
interface OllamaVisionClientLike {
  generate?(image: string, prompt: string): Promise<string>;
  generateJSON?<T = unknown>(image: string, prompt: string): Promise<T>;
  generateWithImageSize(image: string, prompt: string, imageSizeBytes: number): Promise<string>;
  generateJSONWithImageSize<T = unknown>(image: string, prompt: string, imageSizeBytes: number): Promise<T>;
  isAvailable(): Promise<boolean>;
}

// =============================================================================
// LlamaVisionAdapter クラス
// =============================================================================

/**
 * LlamaVisionAdapter - Vision CPU完走保証のためのアダプター
 *
 * @example
 * ```typescript
 * const adapter = new LlamaVisionAdapter();
 *
 * // 基本的な使用
 * const result = await adapter.analyze(imageBase64, 'Analyze this image');
 * console.log(result.response);
 * console.log(result.metrics.optimizationApplied);
 *
 * // JSON結果を取得
 * const jsonResult = await adapter.analyzeJSON<{ mood: string }>(imageBase64, 'Analyze mood');
 * console.log(jsonResult.response.mood);
 * ```
 */
export class LlamaVisionAdapter {
  private readonly enableOptimization: boolean;
  private readonly hardwareDetector: HardwareDetectorLikeInternal;
  private readonly imageOptimizer: ImageOptimizerLike;
  private readonly ollamaClient: OllamaVisionClientLike;

  /**
   * LlamaVisionAdapterのコンストラクタ
   *
   * @param config - 設定オプション
   */
  constructor(config?: LlamaVisionAdapterConfig) {
    this.enableOptimization = config?.enableOptimization ?? true;
    // Note: config.maxImageSizeBytes is accepted but not yet used
    // Reserved for future size-based preprocessing limits

    // 依存性注入（DI）対応
    this.hardwareDetector = (config?.hardwareDetector as HardwareDetectorLikeInternal) ??
      new HardwareDetector(config?.ollamaUrl ? { ollamaUrl: config.ollamaUrl } : undefined);
    this.imageOptimizer = config?.imageOptimizer ?? new ImageOptimizer();

    // OllamaVisionClientにはHardwareDetectorを注入（動的タイムアウト用）
    this.ollamaClient = config?.ollamaClient ?? new OllamaVisionClient({
      ollamaUrl: config?.ollamaUrl,
      hardwareDetector: this.hardwareDetector,
    });
  }

  // ===========================================================================
  // パブリックメソッド
  // ===========================================================================

  /**
   * 画像を分析してテキスト結果を返す
   *
   * @param image - Base64エンコードされた画像またはBuffer
   * @param prompt - プロンプト文字列
   * @param options - 分析オプション
   * @returns 分析結果とメトリクス
   */
  async analyze(
    image: Buffer | string,
    prompt: string,
    options?: VisionAnalysisOptions
  ): Promise<VisionAnalysisResult<string>> {
    const startTime = performance.now();

    // 画像をBase64文字列に変換
    const { imageBase64, originalSizeBytes, isEmpty } = this.prepareImage(image);

    // ハードウェア検出
    const hardwareInfo = await this.detectHardware();

    // 画像最適化の判定と実行
    const optimizationResult = await this.maybeOptimize(
      imageBase64,
      originalSizeBytes,
      hardwareInfo,
      options,
      isEmpty
    );

    // 使用する画像を決定
    const imageToAnalyze = optimizationResult.optimizedImage ?? imageBase64;
    const imageSizeForTimeout = optimizationResult.optimizedSizeBytes ?? originalSizeBytes;

    // Ollama Vision API呼び出し
    const response = await this.ollamaClient.generateWithImageSize(
      imageToAnalyze,
      prompt,
      imageSizeForTimeout
    );

    // メトリクス作成
    const totalProcessingTimeMs = Math.round(performance.now() - startTime);
    const metrics = this.createMetrics(
      hardwareInfo,
      originalSizeBytes,
      optimizationResult,
      totalProcessingTimeMs
    );

    return { response, metrics };
  }

  /**
   * 画像を分析してJSON結果を返す
   *
   * @param image - Base64エンコードされた画像またはBuffer
   * @param prompt - プロンプト文字列
   * @param options - 分析オプション
   * @returns 分析結果とメトリクス
   */
  async analyzeJSON<T = unknown>(
    image: Buffer | string,
    prompt: string,
    options?: VisionAnalysisOptions
  ): Promise<VisionAnalysisResult<T>> {
    const startTime = performance.now();

    // 画像をBase64文字列に変換
    const { imageBase64, originalSizeBytes, isEmpty } = this.prepareImage(image);

    // ハードウェア検出
    const hardwareInfo = await this.detectHardware();

    // 画像最適化の判定と実行
    const optimizationResult = await this.maybeOptimize(
      imageBase64,
      originalSizeBytes,
      hardwareInfo,
      options,
      isEmpty
    );

    // 使用する画像を決定
    const imageToAnalyze = optimizationResult.optimizedImage ?? imageBase64;
    const imageSizeForTimeout = optimizationResult.optimizedSizeBytes ?? originalSizeBytes;

    // Ollama Vision API呼び出し（JSON）
    const response = await this.ollamaClient.generateJSONWithImageSize<T>(
      imageToAnalyze,
      prompt,
      imageSizeForTimeout
    );

    // メトリクス作成
    const totalProcessingTimeMs = Math.round(performance.now() - startTime);
    const metrics = this.createMetrics(
      hardwareInfo,
      originalSizeBytes,
      optimizationResult,
      totalProcessingTimeMs
    );

    return { response, metrics };
  }

  /**
   * Ollamaサービスが利用可能かどうかをチェック
   *
   * @returns 利用可能な場合はtrue
   */
  async isAvailable(): Promise<boolean> {
    return this.ollamaClient.isAvailable();
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * 画像をBase64文字列に変換し、サイズを計算
   */
  private prepareImage(image: Buffer | string): {
    imageBase64: string;
    originalSizeBytes: number;
    isEmpty: boolean;
  } {
    if (Buffer.isBuffer(image)) {
      return {
        imageBase64: image.toString('base64'),
        originalSizeBytes: image.length,
        isEmpty: image.length === 0,
      };
    }

    // Base64文字列の場合、デコードしてサイズを計算
    // data:image/...;base64, プレフィックスがある場合は除去
    const base64Data = image.replace(/^data:image\/[a-z]+;base64,/, '');
    const sizeBytes = Math.ceil((base64Data.length * 3) / 4);

    return {
      imageBase64: base64Data,
      originalSizeBytes: sizeBytes,
      isEmpty: base64Data.length === 0,
    };
  }

  /**
   * ハードウェア情報を検出
   */
  private async detectHardware(): Promise<HardwareInfo> {
    try {
      return await this.hardwareDetector.detect();
    } catch (error) {
      // ハードウェア検出失敗時はCPUフォールバック
      if (process.env.NODE_ENV === 'development') {
        console.warn('[LlamaVisionAdapter] Hardware detection failed, falling back to CPU', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 最適化結果の型
   */
  private async maybeOptimize(
    imageBase64: string,
    _originalSizeBytes: number, // Reserved for future use (e.g., size-based strategy selection)
    hardwareInfo: HardwareInfo,
    options?: VisionAnalysisOptions,
    isEmpty?: boolean
  ): Promise<OptimizationState> {
    // 空画像の場合はエラーを返す
    if (isEmpty) {
      return {
        applied: false,
        error: 'Empty image provided',
      };
    }

    // 最適化を無効にする条件をチェック
    if (!this.shouldOptimize(hardwareInfo, options)) {
      const skipReason = this.getOptimizationSkipReason(hardwareInfo, options);
      return {
        applied: false,
        skipReason,
      };
    }

    // ImageOptimizerで最適化を実行
    try {
      const result = await this.imageOptimizer.optimizeForCPU(imageBase64, {
        hardwareType: hardwareInfo.type,
      });

      // 最適化がスキップされた場合
      if (result.skipped) {
        return {
          applied: false,
          skipReason: result.reason,
          error: result.error,
        };
      }

      // 最適化成功
      return {
        applied: true,
        optimizedImage: result.buffer.toString('base64'),
        optimizedSizeBytes: result.optimizedSizeBytes,
        compressionRatio: result.compressionRatio,
        optimizationTimeMs: result.processingTimeMs,
      };
    } catch (error) {
      // 最適化失敗時はGraceful Degradation
      if (process.env.NODE_ENV === 'development') {
        console.warn('[LlamaVisionAdapter] Image optimization failed, using original image', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return {
        applied: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 最適化を実行すべきかどうかを判定
   */
  private shouldOptimize(
    hardwareInfo: HardwareInfo,
    options?: VisionAnalysisOptions
  ): boolean {
    // グローバル設定で無効化されている場合
    if (!this.enableOptimization) {
      return false;
    }

    // オプションで無効化されている場合
    if (options?.enableOptimization === false) {
      return false;
    }

    // forceOriginalオプションが指定されている場合
    if (options?.forceOriginal) {
      return false;
    }

    // GPUの場合は最適化不要
    if (hardwareInfo.type === HardwareType.GPU) {
      return false;
    }

    return true;
  }

  /**
   * 最適化をスキップする理由を取得
   */
  private getOptimizationSkipReason(
    hardwareInfo: HardwareInfo,
    options?: VisionAnalysisOptions
  ): string | undefined {
    if (!this.enableOptimization) {
      return 'Optimization disabled in config';
    }
    if (options?.enableOptimization === false) {
      return 'Optimization disabled by option';
    }
    if (options?.forceOriginal) {
      return 'forceOriginal option set';
    }
    if (hardwareInfo.type === HardwareType.GPU) {
      return 'GPU detected, no optimization needed';
    }
    return undefined;
  }

  /**
   * メトリクスを作成
   */
  private createMetrics(
    hardwareInfo: HardwareInfo,
    originalSizeBytes: number,
    optimizationResult: OptimizationState,
    totalProcessingTimeMs: number
  ): VisionAnalysisMetrics {
    const metrics: VisionAnalysisMetrics = {
      hardwareType: hardwareInfo.type,
      originalSizeBytes,
      optimizationApplied: optimizationResult.applied,
      totalProcessingTimeMs,
    };

    // ハードウェア検出エラーがある場合
    if (hardwareInfo.error) {
      metrics.hardwareDetectionError = hardwareInfo.error;
    }

    // 最適化がスキップされた理由
    if (optimizationResult.skipReason) {
      metrics.optimizationSkipReason = optimizationResult.skipReason;
    }

    // 最適化エラー
    if (optimizationResult.error) {
      metrics.optimizationError = optimizationResult.error;
    }

    // 最適化が適用された場合の追加メトリクス
    if (optimizationResult.applied) {
      metrics.optimizedSizeBytes = optimizationResult.optimizedSizeBytes;
      metrics.compressionRatio = optimizationResult.compressionRatio;
      metrics.optimizationTimeMs = optimizationResult.optimizationTimeMs;
    }

    return metrics;
  }
}

/**
 * 最適化状態の内部型
 */
interface OptimizationState {
  /** 最適化が適用されたか */
  applied: boolean;
  /** スキップ理由 */
  skipReason?: string | undefined;
  /** エラー */
  error?: string | undefined;
  /** 最適化後の画像（Base64） */
  optimizedImage?: string | undefined;
  /** 最適化後のサイズ（バイト） */
  optimizedSizeBytes?: number | undefined;
  /** 圧縮率 */
  compressionRatio?: number | undefined;
  /** 最適化処理時間（ミリ秒） */
  optimizationTimeMs?: number | undefined;
}
