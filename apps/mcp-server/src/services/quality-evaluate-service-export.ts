// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Quality Evaluate Service Export
 * 外部モジュールから直接使用可能なQuality評価サービス
 *
 * @module services/quality-evaluate-service-export
 */

import type {
  QualityEvaluatorService,
  QualityEvaluatorOptions,
  QualityEvaluatorResult,
} from './page/quality-evaluator.service';
import { getQualityEvaluatorService } from './page/quality-evaluator.service';
import { logger } from '../utils/logger';

// =====================================================
// Types
// =====================================================

/**
 * 品質評価のオプション（外部呼び出し用、undefinedプロパティ許容）
 */
export interface QualityEvaluateOptions {
  /** strictモード */
  strict?: boolean | undefined;
  /** 重み付け */
  weights?: {
    originality?: number | undefined;
    craftsmanship?: number | undefined;
    contextuality?: number | undefined;
  } | undefined;
  /** 業界 */
  targetIndustry?: string | undefined;
  /** ターゲットオーディエンス */
  targetAudience?: string | undefined;
  /** 推奨事項を含める */
  includeRecommendations?: boolean | undefined;
}

/**
 * 品質評価の入力
 */
export interface QualityEvaluateInput {
  /** 評価対象のHTML */
  html: string;
  /** 評価オプション（undefinedプロパティ許容） */
  options?: QualityEvaluateOptions | undefined;
}

/**
 * 品質評価の出力
 */
export interface QualityEvaluateOutput {
  success: boolean;
  data?: QualityEvaluateData;
  error?: QualityEvaluateErrorInfo;
}

/**
 * 品質評価データ
 */
export interface QualityEvaluateData {
  /** 総合スコア (0-100) */
  overallScore: number;
  /** グレード (A-F) */
  grade: string;
  /** 3軸スコア */
  axisScores: {
    originality: number;
    craftsmanship: number;
    contextuality: number;
  };
  /** 3軸グレード */
  axisGrades?: {
    originality: string;
    craftsmanship: string;
    contextuality: string;
  };
  /** 3軸詳細 */
  axisDetails?: {
    originality: string[];
    craftsmanship: string[];
    contextuality: string[];
  };
  /** AIクリシェ数 */
  clicheCount: number;
  /** 検出されたクリシェ */
  cliches?: Array<{
    type: string;
    description: string;
    severity: 'high' | 'medium' | 'low';
  }>;
  /** 推奨事項 */
  recommendations?: Array<{
    id: string;
    category: string;
    priority: 'high' | 'medium' | 'low';
    title: string;
    description: string;
  }>;
  /** 処理時間(ms) */
  processingTimeMs: number;
}

/**
 * 品質評価エラー情報
 */
export interface QualityEvaluateErrorInfo {
  code: string;
  message: string;
}

// =====================================================
// Re-export types from service
// =====================================================

export type {
  QualityEvaluatorOptions,
  QualityEvaluatorResult,
};

// =====================================================
// Service singleton
// =====================================================

let serviceInstance: QualityEvaluatorService | null = null;

/**
 * サービスインスタンスを取得
 */
function getServiceInstance(): QualityEvaluatorService {
  if (!serviceInstance) {
    serviceInstance = getQualityEvaluatorService();
  }
  return serviceInstance;
}

// =====================================================
// Execute function
// =====================================================

/**
 * 品質評価を実行
 *
 * QualityEvaluatorServiceを使用してHTMLの品質を評価する
 *
 * @param input - 評価入力
 * @returns 評価結果
 *
 * @example
 * ```typescript
 * const result = await executeQualityEvaluate({
 *   html: '<div>...</div>',
 *   options: {
 *     strict: true,
 *     targetIndustry: 'technology',
 *     includeRecommendations: true,
 *   },
 * });
 * ```
 */
export async function executeQualityEvaluate(
  input: QualityEvaluateInput
): Promise<QualityEvaluateOutput> {
  logger.debug('[executeQualityEvaluate] Called', {
    htmlLength: input.html.length,
    options: input.options,
  });

  try {
    const service = getServiceInstance();

    // undefinedプロパティを除外してQualityEvaluatorOptionsに変換
    const cleanOptions: QualityEvaluatorOptions | undefined = input.options ? ((): QualityEvaluatorOptions | undefined => {
      const opts: QualityEvaluatorOptions = {};
      if (input.options!.strict !== undefined) opts.strict = input.options!.strict;
      if (input.options!.includeRecommendations !== undefined) opts.includeRecommendations = input.options!.includeRecommendations;
      if (input.options!.targetIndustry !== undefined) opts.targetIndustry = input.options!.targetIndustry;
      if (input.options!.targetAudience !== undefined) opts.targetAudience = input.options!.targetAudience;
      if (input.options!.weights !== undefined) {
        const w: NonNullable<QualityEvaluatorOptions['weights']> = {};
        if (input.options!.weights.originality !== undefined) w.originality = input.options!.weights.originality;
        if (input.options!.weights.craftsmanship !== undefined) w.craftsmanship = input.options!.weights.craftsmanship;
        if (input.options!.weights.contextuality !== undefined) w.contextuality = input.options!.weights.contextuality;
        if (Object.keys(w).length > 0) opts.weights = w;
      }
      return Object.keys(opts).length > 0 ? opts : undefined;
    })() : undefined;

    const result = await service.evaluate(input.html, cleanOptions);

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? {
          code: 'QUALITY_EVALUATION_FAILED',
          message: 'Quality evaluation failed',
        },
      };
    }

    // 成功結果をQualityEvaluateDataに変換
    const data: QualityEvaluateData = {
      overallScore: result.overallScore,
      grade: result.grade,
      axisScores: result.axisScores,
      clicheCount: result.clicheCount,
      processingTimeMs: result.processingTimeMs,
    };

    // オプショナルフィールド
    if (result.axisGrades) {
      data.axisGrades = result.axisGrades;
    }

    if (result.axisDetails) {
      data.axisDetails = result.axisDetails;
    }

    if (result.cliches) {
      data.cliches = result.cliches;
    }

    if (result.recommendations) {
      data.recommendations = result.recommendations;
    }

    logger.debug('[executeQualityEvaluate] Success', {
      overallScore: data.overallScore,
      grade: data.grade,
      clicheCount: data.clicheCount,
    });

    return {
      success: true,
      data,
    };
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[executeQualityEvaluate] Error', error);
    }

    return {
      success: false,
      error: {
        code: 'QUALITY_EVALUATION_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
}

/**
 * サービスインスタンスをリセット（テスト用）
 */
export function resetQualityEvaluateService(): void {
  serviceInstance = null;
}
