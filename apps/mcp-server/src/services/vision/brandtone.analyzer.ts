// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BrandToneAnalyzer - Vision AIによるブランドトーン分析サービス
 *
 * Phase 5: スクリーンショットからブランドトーン（ブランド雰囲気）を抽出
 *
 * 機能:
 * - Base64スクリーンショットからbrandTone（ブランド雰囲気）を抽出
 * - primary/secondary tone検出
 * - 各属性（professionalism, warmth, modernity, energy, targetAudience）検出
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
  getBrandToneAnalysisPrompt,
  getBrandToneAnalysisWithContextPrompt,
} from './vision.prompts.js';

// =============================================================================
// 定数
// =============================================================================

/**
 * 有効なBrandToneタイプ一覧
 */
export const VALID_BRAND_TONES = [
  'corporate',
  'friendly',
  'luxury',
  'tech-forward',
  'creative',
  'trustworthy',
  'innovative',
  'traditional',
] as const;

/**
 * Professionalism レベル
 */
export const PROFESSIONALISM_LEVELS = ['minimal', 'moderate', 'bold'] as const;

/**
 * Warmth レベル
 */
export const WARMTH_LEVELS = ['cold', 'neutral', 'warm'] as const;

/**
 * Modernity レベル
 */
export const MODERNITY_LEVELS = ['classic', 'contemporary', 'futuristic'] as const;

/**
 * Energy レベル
 */
export const ENERGY_LEVELS = ['calm', 'balanced', 'dynamic'] as const;

/**
 * Target Audience
 */
export const TARGET_AUDIENCES = ['enterprise', 'startup', 'creative', 'consumer'] as const;

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

export type BrandToneType = (typeof VALID_BRAND_TONES)[number];
export type ProfessionalismLevel = (typeof PROFESSIONALISM_LEVELS)[number];
export type WarmthLevel = (typeof WARMTH_LEVELS)[number];
export type ModernityLevel = (typeof MODERNITY_LEVELS)[number];
export type EnergyLevel = (typeof ENERGY_LEVELS)[number];
export type TargetAudienceType = (typeof TARGET_AUDIENCES)[number];

/**
 * BrandTone分析結果
 */
export interface BrandToneAnalysisResult {
  primaryTone: BrandToneType;
  secondaryTone?: BrandToneType | undefined;
  confidence: number;
  professionalism: ProfessionalismLevel;
  warmth: WarmthLevel;
  modernity: ModernityLevel;
  energy: EnergyLevel;
  targetAudience: TargetAudienceType;
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
 * BrandToneAnalyzer設定
 */
export interface BrandToneAnalyzerConfig {
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

const BrandToneAnalysisResultSchema = z.object({
  primaryTone: z.enum(VALID_BRAND_TONES),
  secondaryTone: z.enum(VALID_BRAND_TONES).optional(),
  confidence: z.number().min(0).max(1),
  professionalism: z.enum(PROFESSIONALISM_LEVELS),
  warmth: z.enum(WARMTH_LEVELS),
  modernity: z.enum(MODERNITY_LEVELS),
  energy: z.enum(ENERGY_LEVELS),
  targetAudience: z.enum(TARGET_AUDIENCES),
  indicators: z.array(z.string()),
  colorContextUsed: z.boolean(),
});

// =============================================================================
// BrandToneAnalyzer クラス
// =============================================================================

export class BrandToneAnalyzer {
  private readonly cache: VisionCache<string, BrandToneAnalysisResult>;
  private readonly client: OllamaVisionClient;

  constructor(config?: BrandToneAnalyzerConfig) {
    this.cache = new VisionCache<string, BrandToneAnalysisResult>({
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
   * スクリーンショットからブランドトーンを分析
   *
   * @param screenshot - Base64エンコードされたスクリーンショット
   * @returns BrandTone分析結果、または信頼度が低い/エラー時はnull
   * @throws Error - 入力が無効な場合
   */
  async analyze(screenshot: string): Promise<BrandToneAnalysisResult | null> {
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
      logger.info('[BrandToneAnalyzer] Ollama API call started');
      const prompt = getBrandToneAnalysisPrompt();
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
        console.error('[BrandToneAnalyzer] Error:', error);
      }
      return null;
    }
  }

  /**
   * カラーコンテキスト付きでスクリーンショットからブランドトーンを分析
   *
   * @param screenshot - Base64エンコードされたスクリーンショット
   * @param colorContext - カラーコンテキスト情報
   * @returns BrandTone分析結果、または信頼度が低い/エラー時はnull
   * @throws Error - 入力が無効な場合
   */
  async analyzeWithContext(
    screenshot: string,
    colorContext: ColorContext
  ): Promise<BrandToneAnalysisResult | null> {
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
      logger.info('[BrandToneAnalyzer] Ollama API call started');
      const prompt = getBrandToneAnalysisWithContextPrompt(colorContext);
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
        console.error('[BrandToneAnalyzer] Error:', error);
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
  ): BrandToneAnalysisResult | null {
    // 型チェック
    if (typeof rawResult !== 'object' || rawResult === null) {
      return null;
    }

    // Zodでバリデーション
    const parseResult = BrandToneAnalysisResultSchema.safeParse(rawResult);
    if (!parseResult.success) {
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
