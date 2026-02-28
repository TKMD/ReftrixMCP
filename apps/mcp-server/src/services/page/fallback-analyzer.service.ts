// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FallbackAnalyzerService
 *
 * WebGLを多用する重いサイト（例: lbproject.dev）の分析時に、
 * タイムアウトを防ぐため3段階のフォールバック戦略を実装する。
 *
 * フォールバックレベル:
 * - Level 1: 標準分析（timeout: 30s, waitUntil: 'load'）
 * - Level 2: 軽量分析（timeout: 60s, waitUntil: 'domcontentloaded', disableJavaScript: true）
 * - Level 3: 最小分析（timeout: 120s, waitUntil: 'domcontentloaded', disableWebGL: true）
 *
 * 全レベル失敗時:
 * - success: true, partial: true で部分結果を返す
 * - warnings に失敗情報を含める
 *
 * @module services/page/fallback-analyzer.service
 */

import { logger } from '../../utils/logger';

// ============================================================================
// Types
// ============================================================================

/** フォールバックレベル (1, 2, 3) */
export type FallbackLevel = 1 | 2 | 3;

/** 警告情報 */
export interface FallbackWarning {
  code: string;
  message: string;
  level: 'info' | 'warning' | 'error';
}

/** レベル試行結果 */
export interface LevelAttempt {
  level: FallbackLevel;
  success: boolean;
  durationMs: number;
  error?: string;
}

/** レイアウト結果 */
export interface LayoutResult {
  success: boolean;
  sectionCount: number;
  sectionTypes: Record<string, number>;
  processingTimeMs: number;
}

/** モーション結果 */
export interface MotionResult {
  success: boolean;
  patternCount: number;
  categoryBreakdown: Record<string, number>;
  warningCount: number;
  processingTimeMs: number;
}

/** 品質結果 */
export interface QualityResult {
  success: boolean;
  overallScore: number;
  grade: string;
  axisScores: {
    originality: number;
    craftsmanship: number;
    contextuality: number;
  };
  processingTimeMs: number;
}

/** 分析機能フラグ */
export interface FallbackFeatures {
  layout?: boolean;
  motion?: boolean;
  quality?: boolean;
}

/** フォールバック分析オプション */
export interface FallbackAnalyzeOptions {
  url: string;
  features?: FallbackFeatures;
  timeoutMultiplier?: number;
}

/** フォールバック分析結果（成功時） */
export interface FallbackAnalyzeSuccessResult {
  success: true;
  partial?: boolean | undefined;
  warnings?: FallbackWarning[] | undefined;
  webPageId?: string | undefined;
  url?: string | undefined;
  appliedLevel?: number | undefined;
  appliedLevelDescription?: string | undefined;
  layout?: LayoutResult | undefined;
  motion?: MotionResult | undefined;
  quality?: QualityResult | undefined;
  totalProcessingTimeMs?: number | undefined;
  analyzedAt?: string | undefined;
  levelAttempts?: LevelAttempt[] | undefined;
}

/** フォールバック分析結果（エラー時） */
export interface FallbackAnalyzeErrorResult {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

/** フォールバック分析結果 */
export type FallbackAnalyzeResult =
  | FallbackAnalyzeSuccessResult
  | FallbackAnalyzeErrorResult;

/** フォールバックレベル設定 */
export interface FallbackLevelConfig {
  level: FallbackLevel;
  timeout: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
  disableJavaScript: boolean;
  disableWebGL: boolean;
  description: string;
}

/** ページ分析サービスインターフェース */
export interface IPageAnalyzeService {
  analyze: (
    options: FallbackAnalyzeOptions & {
      level: FallbackLevel;
      timeout: number;
      waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
      disableJavaScript: boolean;
      disableWebGL: boolean;
      features: FallbackFeatures;
    }
  ) => Promise<FallbackAnalyzeResult>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * フォールバックレベル定義
 *
 * Level 1: 標準分析
 * Level 2: 軽量分析（JavaScript無効）
 * Level 3: 最小分析（WebGL無効）
 */
export const FALLBACK_LEVELS: Record<FallbackLevel, FallbackLevelConfig> = {
  1: {
    level: 1,
    timeout: 30000,
    waitUntil: 'load',
    disableJavaScript: false,
    disableWebGL: false,
    description: 'Standard analysis',
  },
  2: {
    level: 2,
    timeout: 60000,
    waitUntil: 'domcontentloaded',
    disableJavaScript: true,
    disableWebGL: false,
    description: 'Lightweight analysis (JavaScript disabled)',
  },
  3: {
    level: 3,
    timeout: 120000,
    waitUntil: 'domcontentloaded',
    disableJavaScript: true,
    disableWebGL: true,
    description: 'Minimal analysis (WebGL disabled)',
  },
};

// SSRFブロック対象のプライベートIP/ホスト
const SSRF_BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
];

const SSRF_BLOCKED_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fe80:/i,
];

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * FallbackAnalyzerService
 *
 * 段階的フォールバック戦略でWebページを分析するサービス
 */
export class FallbackAnalyzerService {
  private pageAnalyzeService: IPageAnalyzeService | null = null;

  /**
   * ページ分析サービスを設定
   */
  setPageAnalyzeService(service: IPageAnalyzeService): void {
    this.pageAnalyzeService = service;
  }

  /**
   * 段階的フォールバックで分析を実行
   *
   * @param options - 分析オプション
   * @returns 分析結果
   */
  async analyzeWithFallback(
    options: FallbackAnalyzeOptions
  ): Promise<FallbackAnalyzeResult> {
    const startTime = Date.now();

    // バリデーション
    const validationError = this.validateOptions(options);
    if (validationError) {
      return validationError;
    }

    // サービス未設定チェック
    if (!this.pageAnalyzeService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_NOT_CONFIGURED',
          message: 'Page analyze service is not configured',
        },
      };
    }

    const warnings: FallbackWarning[] = [];
    const levelAttempts: LevelAttempt[] = [];
    const timeoutMultiplier = options.timeoutMultiplier ?? 1;
    const features = options.features ?? {
      layout: true,
      motion: true,
      quality: true,
    };

    // Level 1, 2, 3 の順に試行
    for (const level of [1, 2, 3] as FallbackLevel[]) {
      const levelConfig = FALLBACK_LEVELS[level];
      const levelStartTime = Date.now();

      // Level 3ではmotionを強制無効化
      const levelFeatures =
        level === 3
          ? { ...features, motion: false }
          : { ...features };

      const analyzeOptions = {
        ...options,
        level,
        timeout: Math.round(levelConfig.timeout * timeoutMultiplier),
        waitUntil: levelConfig.waitUntil,
        disableJavaScript: levelConfig.disableJavaScript,
        disableWebGL: levelConfig.disableWebGL,
        features: levelFeatures,
      };

      logger.debug(`[FallbackAnalyzer] Attempting Level ${level}`, {
        url: options.url,
        timeout: analyzeOptions.timeout,
        waitUntil: analyzeOptions.waitUntil,
      });

      try {
        const result = await this.pageAnalyzeService.analyze(analyzeOptions);
        const levelDurationMs = Date.now() - levelStartTime;

        levelAttempts.push({
          level,
          success: true,
          durationMs: levelDurationMs,
        });

        if (result.success) {
          // 成功時: 警告とメタデータを追加して返す
          return {
            ...result,
            appliedLevel: level,
            appliedLevelDescription: levelConfig.description,
            warnings: warnings.length > 0 ? warnings : undefined,
            totalProcessingTimeMs: Date.now() - startTime,
            levelAttempts,
          };
        }
      } catch (error) {
        const levelDurationMs = Date.now() - levelStartTime;
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        levelAttempts.push({
          level,
          success: false,
          durationMs: levelDurationMs,
          error: errorMessage,
        });

        // 失敗警告を記録
        warnings.push({
          code: `LEVEL_${level}_FAILED`,
          message: `Level ${level} analysis failed: ${errorMessage}`,
          level: 'info',
        });

        logger.debug(`[FallbackAnalyzer] Level ${level} failed`, {
          error: errorMessage,
          durationMs: levelDurationMs,
        });
      }
    }

    // 全レベル失敗時: 部分結果を返す
    warnings.push({
      code: 'ALL_LEVELS_FAILED',
      message: 'All fallback levels failed for this URL',
      level: 'error',
    });

    logger.debug('[FallbackAnalyzer] All levels failed', {
      url: options.url,
      warnings,
    });

    return {
      success: true,
      partial: true,
      url: options.url,
      warnings,
      appliedLevel: 0,
      appliedLevelDescription: 'All levels failed',
      layout: undefined,
      motion: undefined,
      quality: undefined,
      webPageId: undefined,
      totalProcessingTimeMs: Date.now() - startTime,
      analyzedAt: new Date().toISOString(),
      levelAttempts,
    };
  }

  /**
   * オプションのバリデーション
   */
  private validateOptions(
    options: FallbackAnalyzeOptions
  ): FallbackAnalyzeErrorResult | null {
    // URL必須チェック
    if (!options.url || options.url.trim() === '') {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'URL is required',
        },
      };
    }

    // URL形式チェック
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(options.url);
    } catch {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid URL format',
        },
      };
    }

    // プロトコルチェック
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Only http:// and https:// protocols are allowed',
        },
      };
    }

    // SSRFチェック
    const hostname = parsedUrl.hostname.toLowerCase();
    if (SSRF_BLOCKED_HOSTS.includes(hostname)) {
      return {
        success: false,
        error: {
          code: 'SSRF_BLOCKED',
          message: 'Access to local/private hosts is blocked',
        },
      };
    }

    for (const pattern of SSRF_BLOCKED_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return {
          success: false,
          error: {
            code: 'SSRF_BLOCKED',
            message: 'Access to private IP addresses is blocked',
          },
        };
      }
    }

    return null;
  }
}

// ============================================================================
// Singleton Factory
// ============================================================================

let instance: FallbackAnalyzerService | null = null;

/**
 * FallbackAnalyzerServiceのシングルトンインスタンスを取得
 */
export function createFallbackAnalyzerService(): FallbackAnalyzerService {
  if (!instance) {
    instance = new FallbackAnalyzerService();
  }
  return instance;
}

/**
 * シングルトンインスタンスをリセット
 */
export function resetFallbackAnalyzerService(): void {
  instance = null;
}
