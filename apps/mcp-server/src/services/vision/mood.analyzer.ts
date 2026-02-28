// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MoodAnalyzer - Vision AIによるムード分析サービス
 *
 * Phase 5: スクリーンショットからムード（雰囲気）を抽出
 *
 * 機能:
 * - Base64スクリーンショットからmood（雰囲気）を抽出
 * - primary/secondary mood検出
 * - confidence スコア検証（0.6以上が有効）
 * - Ollama未接続時のgraceful degradation
 * - LRUキャッシュ検証
 * - セキュリティ検証（サイズ制限、入力バリデーション）
 *
 * Phase 5 REFACTOR:
 * - OllamaVisionClientを使用してAPIロジック統合
 * - VisionAnalysisErrorを使用してエラーハンドリング統一
 * - vision.promptsからプロンプトを取得
 *
 * 参照:
 * -  (page.analyze visualFeatures)
 * - apps/mcp-server/src/services/vision-adapter/interface.ts
 */

import { logger } from '../../utils/logger';
import { z } from 'zod';
import { VisionCache } from './vision.cache.js';
import { OllamaVisionClient } from './ollama-vision-client.js';
import { VisionAnalysisError } from './vision.errors.js';
import {
  getMoodAnalysisPrompt,
  getMoodAnalysisWithContextPrompt,
} from './vision.prompts.js';

// =============================================================================
// 定数
// =============================================================================

/**
 * 有効なMoodタイプ一覧
 */
export const VALID_MOODS = [
  'professional',
  'playful',
  'minimal',
  'bold',
  'elegant',
  'modern',
  'classic',
  'energetic',
  'calm',
  'luxurious',
] as const;

/**
 * 入力サイズ制限（5MB）
 */
const MAX_INPUT_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * デフォルトタイムアウト（30秒）
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 最小信頼度閾値
 */
const MIN_CONFIDENCE_THRESHOLD = 0.6;

// =============================================================================
// 型定義
// =============================================================================

export type MoodType = (typeof VALID_MOODS)[number];

/**
 * Mood分析結果
 */
export interface MoodAnalysisResult {
  primaryMood: MoodType;
  secondaryMood?: MoodType | undefined;
  confidence: number;
  indicators: string[];
  colorContextUsed: boolean;
}

/**
 * カラーコンテキスト（オプション）
 */
export interface ColorContext {
  dominantColors: string[];
  theme: 'light' | 'dark';
  contentDensity: number;
}

/**
 * MoodAnalyzer設定
 */
export interface MoodAnalyzerConfig {
  ollamaUrl?: string;
  timeout?: number;
  cacheCapacity?: number;
  cacheTTL?: number;
  /** リトライを有効化（デフォルト: true） */
  enableRetry?: boolean;
}

// =============================================================================
// Zodスキーマ
// =============================================================================

const MoodAnalysisResultSchema = z.object({
  primaryMood: z.enum(VALID_MOODS),
  secondaryMood: z.enum(VALID_MOODS).optional(),
  confidence: z.number().min(0).max(1),
  indicators: z.array(z.string()),
  colorContextUsed: z.boolean(),
});

// =============================================================================
// MoodAnalyzer クラス
// =============================================================================

export class MoodAnalyzer {
  private readonly cache: VisionCache<string, MoodAnalysisResult>;
  private readonly client: OllamaVisionClient;

  constructor(config?: MoodAnalyzerConfig) {
    this.cache = new VisionCache<string, MoodAnalysisResult>({
      capacity: config?.cacheCapacity ?? 100,
      ttlMs: config?.cacheTTL ?? 5 * 60 * 1000, // 5分
    });
    this.client = new OllamaVisionClient({
      ollamaUrl: config?.ollamaUrl,
      timeout: config?.timeout ?? DEFAULT_TIMEOUT_MS,
      enableRetry: config?.enableRetry ?? true,
    });
  }

  // ===========================================================================
  // パブリックメソッド
  // ===========================================================================

  /**
   * スクリーンショットからムードを分析
   *
   * @param screenshot - Base64エンコードされたスクリーンショット
   * @returns Mood分析結果、または信頼度が低い/エラー時はnull
   * @throws Error - 入力が無効な場合
   */
  async analyze(screenshot: string): Promise<MoodAnalysisResult | null> {
    // 入力バリデーション
    this.validateInput(screenshot);

    // キャッシュチェック
    const cacheKey = VisionCache.generateKey(screenshot);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Ollama API呼び出し（OllamaVisionClient経由）
      logger.info('[MoodAnalyzer] Ollama API call started');
      const prompt = getMoodAnalysisPrompt();
      const rawResult = await this.client.generateJSON<unknown>(
        screenshot,
        prompt
      );

      // 結果のバリデーション
      const result = this.validateAndSanitizeResult(rawResult);
      if (!result) {
        return null;
      }

      // 信頼度チェック
      if (result.confidence < MIN_CONFIDENCE_THRESHOLD) {
        return null;
      }

      // キャッシュに保存
      this.cache.set(cacheKey, result);

      return result;
    } catch (error) {
      // Graceful degradation: エラー時はnullを返す
      if (process.env.NODE_ENV === 'development') {
        console.error('[MoodAnalyzer] Error:', error);
      }
      return null;
    }
  }

  /**
   * カラーコンテキスト付きでスクリーンショットからムードを分析
   *
   * @param screenshot - Base64エンコードされたスクリーンショット
   * @param colorContext - カラーコンテキスト情報
   * @returns Mood分析結果、または信頼度が低い/エラー時はnull
   * @throws Error - 入力が無効な場合
   */
  async analyzeWithContext(
    screenshot: string,
    colorContext: ColorContext
  ): Promise<MoodAnalysisResult | null> {
    // 入力バリデーション
    this.validateInput(screenshot);

    // キャッシュキーにカラーコンテキストを含める
    const cacheKey = VisionCache.generateKey(
      screenshot + JSON.stringify(colorContext)
    );
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Ollama API呼び出し（OllamaVisionClient経由）
      logger.info('[MoodAnalyzer] Ollama API call started');
      const prompt = getMoodAnalysisWithContextPrompt(colorContext);
      const rawResult = await this.client.generateJSON<unknown>(
        screenshot,
        prompt
      );

      // 結果のバリデーション
      const result = this.validateAndSanitizeResult(rawResult);
      if (!result) {
        return null;
      }

      // 信頼度チェック
      if (result.confidence < MIN_CONFIDENCE_THRESHOLD) {
        return null;
      }

      // キャッシュに保存
      this.cache.set(cacheKey, result);

      return result;
    } catch (error) {
      // Graceful degradation: エラー時はnullを返す
      if (process.env.NODE_ENV === 'development') {
        console.error('[MoodAnalyzer] Error:', error);
      }
      return null;
    }
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * 入力バリデーション
   * @throws VisionAnalysisError - 入力が無効な場合
   */
  private validateInput(screenshot: string): void {
    // 空チェック
    if (!screenshot || screenshot.length === 0) {
      throw new VisionAnalysisError(
        'Screenshot is required',
        'INPUT_VALIDATION',
        false
      );
    }

    // Base64バリデーション
    if (!this.isValidBase64(screenshot)) {
      throw new VisionAnalysisError(
        'Invalid Base64 input',
        'INPUT_VALIDATION',
        false
      );
    }

    // サイズチェック
    const sizeBytes = Buffer.byteLength(screenshot, 'base64');
    if (sizeBytes > MAX_INPUT_SIZE_BYTES) {
      throw new VisionAnalysisError(
        'Input exceeds 5MB limit',
        'INPUT_VALIDATION',
        false,
        { sizeBytes, maxSizeBytes: MAX_INPUT_SIZE_BYTES }
      );
    }
  }

  /**
   * Base64文字列の検証
   */
  private isValidBase64(str: string): boolean {
    // Base64正規表現パターン
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(str)) {
      return false;
    }

    try {
      // 実際にデコードして検証
      Buffer.from(str, 'base64');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 結果のバリデーションとサニタイズ
   */
  private validateAndSanitizeResult(
    rawResult: unknown
  ): MoodAnalysisResult | null {
    // 型チェック
    if (typeof rawResult !== 'object' || rawResult === null) {
      return null;
    }

    // Zodでバリデーション
    const parseResult = MoodAnalysisResultSchema.safeParse(rawResult);
    if (!parseResult.success) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[MoodAnalyzer] Validation failed:', parseResult.error);
      }
      return null;
    }

    const result = parseResult.data;

    // indicatorsのサニタイズ
    const sanitizedIndicators = result.indicators.map((indicator) =>
      this.sanitizeString(indicator)
    );

    return {
      ...result,
      indicators: sanitizedIndicators,
    };
  }

  /**
   * 文字列のサニタイズ（XSS対策）
   */
  private sanitizeString(str: string): string {
    return str
      .replace(/<[^>]*>/g, '') // HTMLタグ除去
      .replace(/[<>"'&]/g, '') // 特殊文字除去
      .trim()
      .slice(0, 200); // 長さ制限
  }
}
