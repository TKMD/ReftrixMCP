// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OllamaVisionClient - Vision API呼び出しの共通クライアント
 *
 * Phase 5 REFACTOR: MoodAnalyzerとBrandToneAnalyzerのOllama API呼び出しロジックを統合
 * Phase 1 完走保証: HardwareDetectorとTimeoutCalculatorによる動的タイムアウト対応
 *
 * 機能:
 * - Ollama Vision API呼び出し（タイムアウト付き）
 * - リトライロジック（指数バックオフ）
 * - 動的タイムアウト（GPU/CPUおよび画像サイズに基づく）
 * - 監査ログ
 * - 接続チェック
 *
 * 参照:
 * - apps/mcp-server/src/services/vision/mood.analyzer.ts
 * - apps/mcp-server/src/services/vision/brandtone.analyzer.ts
 * - apps/mcp-server/src/services/vision/hardware-detector.ts
 * - apps/mcp-server/src/services/vision/timeout-calculator.ts
 */

import { VisionAnalysisError } from './vision.errors.js';
import { type HardwareInfo } from './hardware-detector.js';
import { TimeoutCalculator } from './timeout-calculator.js';
import { logger } from '../../utils/logger';

// =============================================================================
// 定数
// =============================================================================

/**
 * デフォルトタイムアウト（60秒）
 *
 * Vision分析は画像処理を含むため、30秒では不足する場合がある。
 * LlamaVisionAdapterと同じ60秒に設定。
 *
 * @see apps/mcp-server/src/services/vision/llama-vision.adapter.ts
 */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * デフォルトモデル
 */
const DEFAULT_MODEL = 'llama3.2-vision';

/**
 * 最大リトライ回数
 */
const MAX_RETRIES = 3;

/**
 * リトライ間隔の基準（ミリ秒）
 *
 * GPU VRAM回復のため5秒を基準値とする。
 * 指数バックオフにより 5s → 10s → 20s の間隔でリトライする。
 */
const RETRY_BASE_DELAY_MS = 5000;

// =============================================================================
// 型定義
// =============================================================================

/**
 * HardwareDetectorインターフェース（動的タイムアウト用）
 */
export interface HardwareDetectorLike {
  detect(): Promise<HardwareInfo>;
  clearCache(): void;
}

/**
 * OllamaVisionClient設定
 */
export interface OllamaVisionClientConfig {
  /** Ollama API URL */
  ollamaUrl?: string | undefined;
  /** タイムアウト（ミリ秒） */
  timeout?: number | undefined;
  /** モデル名 */
  model?: string | undefined;
  /** リトライ有効化 */
  enableRetry?: boolean | undefined;
  /** 最大リトライ回数 */
  maxRetries?: number | undefined;
  /** HardwareDetector（動的タイムアウト用、Phase 1完走保証） */
  hardwareDetector?: HardwareDetectorLike | undefined;
}

/**
 * Ollama API レスポンス
 */
interface OllamaGenerateResponse {
  response?: string;
  done?: boolean;
  total_duration?: number;
  eval_count?: number;
}

// =============================================================================
// OllamaVisionClient クラス
// =============================================================================

/**
 * Ollama Vision API呼び出しを統合したクライアント
 */
export class OllamaVisionClient {
  private readonly ollamaUrl: string;
  private readonly timeout: number;
  private readonly model: string;
  private readonly enableRetry: boolean;
  private readonly maxRetries: number;
  private readonly hardwareDetector: HardwareDetectorLike | null;
  private readonly timeoutCalculator: TimeoutCalculator;

  constructor(config?: OllamaVisionClientConfig) {
    this.ollamaUrl = config?.ollamaUrl ?? 'http://localhost:11434';
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT_MS;
    this.model = config?.model ?? DEFAULT_MODEL;
    // P2タスク: リトライをデフォルトで有効化（Graceful Degradation対応）
    // Vision APIは一時的な接続問題やタイムアウトが発生しやすいため、
    // デフォルトでリトライを有効にして信頼性を向上させる
    this.enableRetry = config?.enableRetry ?? true;
    this.maxRetries = config?.maxRetries ?? MAX_RETRIES;
    // Phase 1完走保証: HardwareDetectorとTimeoutCalculator
    this.hardwareDetector = config?.hardwareDetector ?? null;
    this.timeoutCalculator = new TimeoutCalculator();
  }

  // ===========================================================================
  // パブリックメソッド
  // ===========================================================================

  /**
   * Ollama Vision APIでテキスト生成
   *
   * @param image - Base64エンコードされた画像
   * @param prompt - プロンプト文字列
   * @returns 生成されたテキスト
   * @throws VisionAnalysisError - タイムアウト、接続エラー、無効なレスポンス
   */
  async generate(image: string, prompt: string): Promise<string> {
    const startTime = Date.now();

    try {
      const response = await this.executeWithRetry(async () => {
        return this.callOllamaAPI(image, prompt);
      });

      // 成功時のログ
      logger.debug('[OllamaVisionClient] Vision API call success', {
        duration_ms: Date.now() - startTime,
        response_length: response.length,
        model: this.model,
      });

      return response;
    } catch (error) {
      // エラー時のログ
      console.error('[OllamaVisionClient] Vision API call failed', {
        duration_ms: Date.now() - startTime,
        error_code:
          error instanceof VisionAnalysisError ? error.code : 'UNKNOWN',
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Ollama Vision APIでJSON生成（パース付き）
   *
   * @param image - Base64エンコードされた画像
   * @param prompt - プロンプト文字列
   * @returns パースされたJSONオブジェクト
   * @throws VisionAnalysisError - タイムアウト、接続エラー、無効なレスポンス、JSON パースエラー
   */
  async generateJSON<T = unknown>(image: string, prompt: string): Promise<T> {
    const response = await this.generate(image, prompt);

    // JSONを抽出（括弧バランスを追跡して完全なJSONオブジェクトを取得）
    const jsonString = this.extractFirstJSON(response);
    if (!jsonString) {
      // デバッグログ追加
      if (process.env.NODE_ENV === 'development') {
        console.warn('[OllamaVisionClient] No JSON found in response', {
          responseLength: response.length,
          responsePreview: response.substring(0, 500),
        });
      }
      throw new VisionAnalysisError(
        'Response does not contain valid JSON',
        'INVALID_RESPONSE',
        false
      );
    }

    try {
      return JSON.parse(jsonString) as T;
    } catch {
      throw new VisionAnalysisError(
        'Failed to parse JSON response',
        'INVALID_RESPONSE',
        false
      );
    }
  }

  /**
   * Ollama Vision APIでテキスト生成（動的タイムアウト対応）
   *
   * Phase 1完走保証: HardwareDetectorを使用してGPU/CPUを検出し、
   * 画像サイズに基づいて適切なタイムアウトを動的に計算する。
   *
   * タイムアウト値:
   * - GPU: 60秒（画像サイズに関係なく）
   * - CPU小画像（<100KB）: 180秒
   * - CPU中画像（100KB-500KB）: 600秒
   * - CPUフルページ（>=500KB）: 1200秒
   *
   * @param image - Base64エンコードされた画像
   * @param prompt - プロンプト文字列
   * @param imageSizeBytes - 画像サイズ（バイト）
   * @returns 生成されたテキスト
   * @throws VisionAnalysisError - タイムアウト、接続エラー、無効なレスポンス
   */
  async generateWithImageSize(
    image: string,
    prompt: string,
    imageSizeBytes: number
  ): Promise<string> {
    const startTime = Date.now();

    try {
      // 動的タイムアウトを計算
      const dynamicTimeout = await this.calculateDynamicTimeout(imageSizeBytes);

      const response = await this.executeWithRetry(async () => {
        return this.callOllamaAPIWithTimeout(image, prompt, dynamicTimeout);
      });

      // 成功時のログ
      logger.debug('[OllamaVisionClient] Vision API call success (dynamic timeout)', {
        duration_ms: Date.now() - startTime,
        response_length: response.length,
        model: this.model,
        dynamic_timeout_ms: dynamicTimeout,
        image_size_bytes: imageSizeBytes,
      });

      return response;
    } catch (error) {
      // エラー時のログ
      console.error('[OllamaVisionClient] Vision API call failed (dynamic timeout)', {
        duration_ms: Date.now() - startTime,
        error_code:
          error instanceof VisionAnalysisError ? error.code : 'UNKNOWN',
        error_message: error instanceof Error ? error.message : String(error),
        image_size_bytes: imageSizeBytes,
      });
      throw error;
    }
  }

  /**
   * Ollama Vision APIでJSON生成（動的タイムアウト対応、パース付き）
   *
   * @param image - Base64エンコードされた画像
   * @param prompt - プロンプト文字列
   * @param imageSizeBytes - 画像サイズ（バイト）
   * @returns パースされたJSONオブジェクト
   * @throws VisionAnalysisError - タイムアウト、接続エラー、無効なレスポンス、JSONパースエラー
   */
  async generateJSONWithImageSize<T = unknown>(
    image: string,
    prompt: string,
    imageSizeBytes: number
  ): Promise<T> {
    const response = await this.generateWithImageSize(image, prompt, imageSizeBytes);

    // JSONを抽出（括弧バランスを追跡して完全なJSONオブジェクトを取得）
    const jsonString = this.extractFirstJSON(response);
    if (!jsonString) {
      // デバッグログ追加
      if (process.env.NODE_ENV === 'development') {
        console.warn('[OllamaVisionClient] No JSON found in response (with image size)', {
          responseLength: response.length,
          responsePreview: response.substring(0, 500),
          imageSizeBytes,
        });
      }
      throw new VisionAnalysisError(
        'Response does not contain valid JSON',
        'INVALID_RESPONSE',
        false
      );
    }

    try {
      return JSON.parse(jsonString) as T;
    } catch {
      throw new VisionAnalysisError(
        'Failed to parse JSON response',
        'INVALID_RESPONSE',
        false
      );
    }
  }

  /**
   * Ollama サービスの接続チェック
   *
   * @returns 接続可能な場合はtrue
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.ollamaUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * Ollama API呼び出し（タイムアウト付き）
   */
  private async callOllamaAPI(image: string, prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          images: [image],
          stream: false,
          format: 'json',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new VisionAnalysisError(
            `Model ${this.model} not found`,
            'OLLAMA_UNAVAILABLE',
            false
          );
        }
        throw new VisionAnalysisError(
          `Ollama API error: ${response.statusText}`,
          'OLLAMA_UNAVAILABLE',
          true
        );
      }

      const data = (await response.json()) as OllamaGenerateResponse;

      if (!data.response) {
        throw new VisionAnalysisError(
          'Empty response from Ollama',
          'INVALID_RESPONSE',
          false
        );
      }

      return data.response;
    } catch (error) {
      if (error instanceof VisionAnalysisError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new VisionAnalysisError(
            `Request timeout after ${this.timeout}ms`,
            'TIMEOUT',
            true
          );
        }

        // 接続エラー
        const lowerMessage = error.message.toLowerCase();
        if (
          lowerMessage.includes('econnrefused') ||
          lowerMessage.includes('connection refused') ||
          lowerMessage.includes('fetch failed') ||
          lowerMessage.includes('network') ||
          lowerMessage.includes('socket')
        ) {
          throw new VisionAnalysisError(
            'Cannot connect to Ollama service',
            'OLLAMA_UNAVAILABLE',
            true
          );
        }
      }

      throw new VisionAnalysisError(
        `Unknown error: ${error instanceof Error ? error.message : String(error)}`,
        'OLLAMA_UNAVAILABLE',
        true
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * リトライロジック（指数バックオフ）
   */
  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= (this.enableRetry ? this.maxRetries : 0); attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // リトライ不可能なエラーは即座に再throw
        if (
          error instanceof VisionAnalysisError &&
          !error.isRetryable
        ) {
          throw error;
        }

        // 最後の試行でも失敗した場合
        if (attempt >= this.maxRetries) {
          break;
        }

        // 指数バックオフで待機
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        logger.debug(`[OllamaVisionClient] Retry ${attempt + 1}/${this.maxRetries} after ${delay}ms`);
        await this.sleep(delay);
      }
    }

    throw lastError ?? new VisionAnalysisError('Unknown error', 'OLLAMA_UNAVAILABLE', false);
  }

  /**
   * 待機
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * レスポンスから最初の完全なJSONオブジェクトを抽出
   *
   * 括弧のバランスを追跡し、ネストされたオブジェクトも正しく処理する。
   * 文字列内の括弧は無視する。
   *
   * @param text - 抽出元のテキスト
   * @returns 抽出されたJSON文字列、見つからない場合はnull
   */
  private extractFirstJSON(text: string): string | null {
    const startIndex = text.indexOf('{');
    if (startIndex === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          return text.substring(startIndex, i + 1);
        }
      }
    }

    return null;
  }

  /**
   * 動的タイムアウトを計算
   *
   * HardwareDetectorを使用してGPU/CPUを検出し、
   * TimeoutCalculatorで適切なタイムアウトを計算する。
   * HardwareDetectorがない場合や検出に失敗した場合はデフォルトタイムアウトを返す。
   *
   * @param imageSizeBytes - 画像サイズ（バイト）
   * @returns タイムアウト（ミリ秒）
   */
  private async calculateDynamicTimeout(imageSizeBytes: number): Promise<number> {
    // HardwareDetectorがない場合はデフォルトタイムアウト
    if (!this.hardwareDetector) {
      return this.timeout;
    }

    try {
      const hardwareInfo = await this.hardwareDetector.detect();
      const dynamicTimeout = this.timeoutCalculator.calculateFromHardwareInfo(
        hardwareInfo,
        imageSizeBytes
      );

      logger.debug('[OllamaVisionClient] Dynamic timeout calculated', {
        hardware_type: hardwareInfo.type,
        is_gpu_available: hardwareInfo.isGpuAvailable,
        vram_bytes: hardwareInfo.vramBytes,
        image_size_bytes: imageSizeBytes,
        image_size_class: this.timeoutCalculator.classifyImageSize(imageSizeBytes),
        timeout_ms: dynamicTimeout,
        timeout_formatted: this.timeoutCalculator.formatTimeout(dynamicTimeout),
      });

      return dynamicTimeout;
    } catch (error) {
      // HardwareDetectorエラー時はデフォルトタイムアウト（Graceful Degradation）
      if (process.env.NODE_ENV === 'development') {
        console.warn('[OllamaVisionClient] HardwareDetector failed, using default timeout', {
          error: error instanceof Error ? error.message : String(error),
          default_timeout_ms: this.timeout,
        });
      }
      return this.timeout;
    }
  }

  /**
   * Ollama API呼び出し（指定タイムアウト付き）
   */
  private async callOllamaAPIWithTimeout(
    image: string,
    prompt: string,
    timeoutMs: number
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          images: [image],
          stream: false,
          format: 'json',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new VisionAnalysisError(
            `Model ${this.model} not found`,
            'OLLAMA_UNAVAILABLE',
            false
          );
        }
        throw new VisionAnalysisError(
          `Ollama API error: ${response.statusText}`,
          'OLLAMA_UNAVAILABLE',
          true
        );
      }

      const data = (await response.json()) as OllamaGenerateResponse;

      if (!data.response) {
        throw new VisionAnalysisError(
          'Empty response from Ollama',
          'INVALID_RESPONSE',
          false
        );
      }

      return data.response;
    } catch (error) {
      if (error instanceof VisionAnalysisError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new VisionAnalysisError(
            `Request timeout after ${timeoutMs}ms`,
            'TIMEOUT',
            true
          );
        }

        // 接続エラー
        const lowerMessage = error.message.toLowerCase();
        if (
          lowerMessage.includes('econnrefused') ||
          lowerMessage.includes('connection refused') ||
          lowerMessage.includes('fetch failed') ||
          lowerMessage.includes('network') ||
          lowerMessage.includes('socket')
        ) {
          throw new VisionAnalysisError(
            'Cannot connect to Ollama service',
            'OLLAMA_UNAVAILABLE',
            true
          );
        }
      }

      throw new VisionAnalysisError(
        `Unknown error: ${error instanceof Error ? error.message : String(error)}`,
        'OLLAMA_UNAVAILABLE',
        true
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
