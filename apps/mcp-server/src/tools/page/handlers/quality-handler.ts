// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze 品質評価ハンドラー
 * QualityEvaluatorService を使用した品質評価
 *
 * @module tools/page/handlers/quality-handler
 */

import { logger, isDevelopment } from '../../../utils/logger';
import { getQualityEvaluatorService } from '../../../services/page/quality-evaluator.service';
import {
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeInput,
} from '../schemas';
import { type QualityServiceResult } from './types';

/**
 * デフォルトの品質評価
 *
 * QualityEvaluatorService を使用して品質評価を行う
 */
export async function defaultEvaluateQuality(
  html: string,
  options?: PageAnalyzeInput['qualityOptions']
): Promise<QualityServiceResult> {
  const startTime = Date.now();

  try {
    // QualityEvaluatorService で評価
    const evaluatorService = getQualityEvaluatorService();

    // exactOptionalPropertyTypes対応: undefinedを含まないオブジェクトを構築
    const evaluatorOptions: Parameters<typeof evaluatorService.evaluate>[1] = {};
    if (options?.strict !== undefined) {
      evaluatorOptions.strict = options.strict;
    }
    if (options?.weights !== undefined) {
      evaluatorOptions.weights = options.weights;
    }
    if (options?.targetIndustry !== undefined) {
      evaluatorOptions.targetIndustry = options.targetIndustry;
    }
    if (options?.targetAudience !== undefined) {
      evaluatorOptions.targetAudience = options.targetAudience;
    }
    if (options?.includeRecommendations !== undefined) {
      evaluatorOptions.includeRecommendations = options.includeRecommendations;
    }

    const evaluatorResult = await evaluatorService.evaluate(html, evaluatorOptions);

    if (isDevelopment()) {
      logger.info('[page.analyze] Quality evaluation completed via QualityEvaluatorService', {
        overallScore: evaluatorResult.overallScore,
        grade: evaluatorResult.grade,
        clicheCount: evaluatorResult.clicheCount,
        processingTimeMs: evaluatorResult.processingTimeMs,
      });
    }

    // QualityServiceResult の形式に変換
    const result: QualityServiceResult = {
      success: evaluatorResult.success,
      overallScore: evaluatorResult.overallScore,
      grade: evaluatorResult.grade,
      axisScores: evaluatorResult.axisScores,
      clicheCount: evaluatorResult.clicheCount,
      processingTimeMs: evaluatorResult.processingTimeMs,
    };

    // オプショナルフィールド
    if (evaluatorResult.axisGrades) {
      result.axisGrades = evaluatorResult.axisGrades;
    }

    if (evaluatorResult.axisDetails) {
      result.axisDetails = evaluatorResult.axisDetails;
    }

    if (evaluatorResult.cliches) {
      result.cliches = evaluatorResult.cliches;
    }

    if (evaluatorResult.recommendations) {
      result.recommendations = evaluatorResult.recommendations;
    }

    if (evaluatorResult.error) {
      result.error = evaluatorResult.error;
    }

    return result;
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[page.analyze] Quality evaluation failed', { error });
    }

    return {
      success: false,
      overallScore: 0,
      grade: 'F',
      axisScores: {
        originality: 0,
        craftsmanship: 0,
        contextuality: 0,
      },
      clicheCount: 0,
      processingTimeMs: Date.now() - startTime,
      error: {
        code: PAGE_ANALYZE_ERROR_CODES.QUALITY_EVALUATION_FAILED,
        message: error instanceof Error ? error.message : 'Quality evaluation failed',
      },
    };
  }
}
