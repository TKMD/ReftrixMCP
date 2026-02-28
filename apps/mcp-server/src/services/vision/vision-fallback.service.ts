// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisionFallbackService - Vision CPU完走保証 Phase 3
 *
 * Graceful Degradation強化: Vision分析が失敗またはタイムアウトした場合に
 * HTML分析のみにフォールバックするサービス。
 *
 * 3つのフォールバック戦略:
 * 1. Vision timeout → HTML analysis only (warning logged)
 * 2. Vision failure (e.g., Ollama not running) → HTML analysis only (warning logged)
 * 3. No image → HTML analysis only (no warning, expected behavior)
 *
 * @see apps/mcp-server/tests/services/vision/vision-fallback.service.test.ts
 */

import type { DetectedSection, SectionDetector } from '@reftrix/webdesign-core';
import type { LlamaVisionAdapter, VisionAnalysisResult } from './llama-vision-adapter.js';

// =============================================================================
// 型定義
// =============================================================================

/**
 * VisionFallbackServiceオプション
 */
export interface VisionFallbackOptions {
  /** Vision分析のタイムアウト（ミリ秒、デフォルト: 30000） */
  visionTimeoutMs?: number;
  /** Vision分析を強制するか（タイムアウト/エラー時にフォールバックせずエラーを返す） */
  forceVision?: boolean;
  /** Vision分析のプロンプト（オプション） */
  visionPrompt?: string;
}

/**
 * HTML分析結果
 */
export interface HTMLAnalysisResult {
  /** 検出されたセクション */
  sections: DetectedSection[];
  /** HTML分析のエラー（発生した場合） */
  error?: string;
}

/**
 * フォールバック結果
 */
export interface FallbackResult {
  /** 処理が成功したか */
  success: boolean;
  /** Vision分析が使用されたか */
  visionUsed: boolean;
  /** フォールバック理由（Vision未使用時） */
  fallbackReason?: string;
  /** HTML分析のみで処理されたか */
  htmlAnalysisOnly: boolean;
  /** Vision分析結果（成功時） */
  visionAnalysis?: VisionAnalysisResult<string>;
  /** HTML分析結果 */
  htmlAnalysis: HTMLAnalysisResult;
  /** パフォーマンスメトリクス */
  metrics: {
    /** 合計処理時間（ミリ秒） */
    totalTimeMs: number;
    /** Vision分析の試行時間（ミリ秒、試行した場合のみ） */
    visionAttemptTimeMs?: number;
    /** Visionがタイムアウトしたか */
    visionTimedOut: boolean;
  };
}

/**
 * VisionFallbackService設定
 */
export interface VisionFallbackServiceConfig {
  /** LlamaVisionAdapter（DI用） */
  visionAdapter?: LlamaVisionAdapter;
  /** SectionDetector（DI用） */
  sectionDetector?: SectionDetector;
  /** デフォルトタイムアウト（ミリ秒） */
  defaultTimeoutMs?: number;
}

// =============================================================================
// VisionFallbackService クラス
// =============================================================================

/**
 * VisionFallbackService - Graceful Degradation付きVision分析
 *
 * @example
 * ```typescript
 * const service = new VisionFallbackService();
 *
 * // 基本的な使用
 * const result = await service.analyzeWithFallback(imageBase64, html, {});
 *
 * if (result.visionUsed) {
 *   console.log('Vision analysis:', result.visionAnalysis);
 * } else {
 *   console.log('Fallback reason:', result.fallbackReason);
 * }
 *
 * // HTML分析は常に利用可能
 * console.log('Sections:', result.htmlAnalysis.sections);
 * ```
 */
export class VisionFallbackService {
  private readonly visionAdapter: LlamaVisionAdapter | undefined;
  private readonly sectionDetector: SectionDetector | undefined;
  private readonly defaultTimeoutMs: number;

  /**
   * VisionFallbackServiceのコンストラクタ
   *
   * @param config - 設定オプション
   */
  constructor(config?: VisionFallbackServiceConfig) {
    this.visionAdapter = config?.visionAdapter;
    this.sectionDetector = config?.sectionDetector;
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 30000;
  }

  /**
   * Vision分析をフォールバック付きで実行
   *
   * @param image - Base64エンコードされた画像（空文字または未定義の場合はHTML分析のみ）
   * @param html - 分析対象のHTML
   * @param options - 分析オプション
   * @returns フォールバック結果
   */
  async analyzeWithFallback(
    image: string | undefined,
    html: string,
    options: VisionFallbackOptions
  ): Promise<FallbackResult> {
    const startTime = performance.now();
    const timeoutMs = options.visionTimeoutMs ?? this.defaultTimeoutMs;

    // Strategy 3: No image → HTML analysis only (no warning, expected behavior)
    const hasImage = image !== undefined && image !== '';
    if (!hasImage) {
      const htmlAnalysis = await this.runHtmlAnalysis(html);
      const endTime = performance.now();

      return {
        success: !htmlAnalysis.error,
        visionUsed: false,
        htmlAnalysisOnly: true,
        // No fallbackReason for no-image case (expected behavior)
        htmlAnalysis,
        metrics: {
          totalTimeMs: endTime - startTime,
          visionTimedOut: false,
        },
      };
    }

    // Check if Vision adapter is available
    if (!this.visionAdapter) {
      const htmlAnalysis = await this.runHtmlAnalysis(html);
      const endTime = performance.now();

      if (options.forceVision) {
        return {
          success: false,
          visionUsed: false,
          htmlAnalysisOnly: false,
          fallbackReason: 'forceVision is true but Vision adapter is not configured',
          htmlAnalysis,
          metrics: {
            totalTimeMs: endTime - startTime,
            visionTimedOut: false,
          },
        };
      }

      return {
        success: !htmlAnalysis.error,
        visionUsed: false,
        htmlAnalysisOnly: true,
        fallbackReason: 'Vision adapter is not configured',
        htmlAnalysis,
        metrics: {
          totalTimeMs: endTime - startTime,
          visionTimedOut: false,
        },
      };
    }

    // Strategy 2: Check if Ollama is available
    const isOllamaAvailable = await this.visionAdapter.isAvailable();
    if (!isOllamaAvailable) {
      const htmlAnalysis = await this.runHtmlAnalysis(html);
      const endTime = performance.now();

      if (options.forceVision) {
        return {
          success: false,
          visionUsed: false,
          htmlAnalysisOnly: false,
          fallbackReason: 'forceVision is true but Ollama is not available',
          htmlAnalysis,
          metrics: {
            totalTimeMs: endTime - startTime,
            visionTimedOut: false,
          },
        };
      }

      return {
        success: !htmlAnalysis.error,
        visionUsed: false,
        htmlAnalysisOnly: true,
        fallbackReason: 'Ollama is not available',
        htmlAnalysis,
        metrics: {
          totalTimeMs: endTime - startTime,
          visionTimedOut: false,
        },
      };
    }

    // Attempt Vision analysis with timeout
    const visionStartTime = performance.now();
    let visionResult: VisionAnalysisResult<string> | undefined;
    let visionError: Error | undefined;
    let visionTimedOut = false;

    try {
      visionResult = await this.runVisionWithTimeout(image, timeoutMs, options.visionPrompt);
    } catch (error) {
      visionError = error instanceof Error ? error : new Error(String(error));
      // Check if it was a timeout
      visionTimedOut = visionError.message.includes('timeout') ||
                       visionError.message.includes('Timeout') ||
                       visionError.message.includes('timed out');
    }

    const visionAttemptTimeMs = performance.now() - visionStartTime;

    // Run HTML analysis in parallel or after Vision
    const htmlAnalysis = await this.runHtmlAnalysis(html);

    const endTime = performance.now();

    // Strategy 1 & 2: Vision failed (timeout or error) → Fallback to HTML analysis
    if (visionError) {
      if (options.forceVision) {
        return {
          success: false,
          visionUsed: false,
          htmlAnalysisOnly: false,
          fallbackReason: visionTimedOut
            ? 'forceVision is true but Vision analysis timed out'
            : `forceVision is true but Vision analysis error: ${visionError.message}`,
          htmlAnalysis,
          metrics: {
            totalTimeMs: endTime - startTime,
            visionAttemptTimeMs,
            visionTimedOut,
          },
        };
      }

      // Check if both Vision and HTML analysis failed
      if (htmlAnalysis.error) {
        return {
          success: false,
          visionUsed: false,
          htmlAnalysisOnly: false,
          fallbackReason: `Vision error: ${visionError.message}; HTML error: ${htmlAnalysis.error}`,
          htmlAnalysis,
          metrics: {
            totalTimeMs: endTime - startTime,
            visionAttemptTimeMs,
            visionTimedOut,
          },
        };
      }

      return {
        success: true,
        visionUsed: false,
        htmlAnalysisOnly: true,
        fallbackReason: visionTimedOut
          ? `Vision analysis timeout (${timeoutMs}ms)`
          : `Vision analysis error: ${visionError.message}`,
        htmlAnalysis,
        metrics: {
          totalTimeMs: endTime - startTime,
          visionAttemptTimeMs,
          visionTimedOut,
        },
      };
    }

    // Success case: Vision and HTML analysis both succeeded
    // At this point, visionResult is guaranteed to be defined (no visionError)
    return {
      success: true,
      visionUsed: true,
      htmlAnalysisOnly: false,
      visionAnalysis: visionResult!,
      htmlAnalysis,
      metrics: {
        totalTimeMs: endTime - startTime,
        visionAttemptTimeMs,
        visionTimedOut: false,
      },
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Vision分析をタイムアウト付きで実行
   */
  private async runVisionWithTimeout(
    image: string,
    timeoutMs: number,
    prompt?: string
  ): Promise<VisionAnalysisResult<string>> {
    if (!this.visionAdapter) {
      throw new Error('Vision adapter is not configured');
    }

    const actualPrompt = prompt ?? 'Describe the layout and visual structure of this webpage screenshot.';
    const visionPromise = this.visionAdapter.analyze(image, actualPrompt);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Vision analysis timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    return Promise.race([visionPromise, timeoutPromise]);
  }

  /**
   * HTML分析を実行
   */
  private async runHtmlAnalysis(html: string): Promise<HTMLAnalysisResult> {
    if (!this.sectionDetector) {
      return {
        sections: [],
        error: 'Section detector is not configured',
      };
    }

    try {
      const sections = await this.sectionDetector.detect(html);
      return { sections };
    } catch (error) {
      return {
        sections: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
