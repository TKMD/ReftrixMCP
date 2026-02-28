// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Motion Detect Service Export
 * 外部モジュールから直接使用可能なMotion検出サービス
 *
 * @module services/motion-detect-service-export
 */

import type {
  MotionPattern,
  MotionWarning,
  MotionDetectionResult,
  MotionDetectionOptions,
} from './page/motion-detector.service';
import { MotionDetectorService } from './page/motion-detector.service';
import { logger } from '../utils/logger';

// =====================================================
// Types
// =====================================================

/**
 * モーション検出のオプション（外部呼び出し用、undefinedプロパティ許容）
 */
export interface MotionDetectOptions {
  /** インラインスタイルを含める */
  includeInlineStyles?: boolean | undefined;
  /** スタイルシートを含める */
  includeStyleSheets?: boolean | undefined;
  /** 最小duration（ms） */
  minDuration?: number | undefined;
  /** 最大パターン数 */
  maxPatterns?: number | undefined;
  /** 詳細モード（rawCssを含める） */
  verbose?: boolean | undefined;
}

/**
 * モーション検出の入力
 */
export interface MotionDetectInput {
  /** 検出対象のHTML */
  html: string;
  /** 外部CSS（オプション） */
  externalCss?: string | undefined;
  /** 検出オプション（undefinedプロパティ許容） */
  options?: MotionDetectOptions | undefined;
}

/**
 * モーション検出の出力
 */
export interface MotionDetectOutput {
  success: boolean;
  data?: MotionDetectData;
  error?: MotionDetectErrorInfo;
}

/**
 * モーション検出データ
 */
export interface MotionDetectData {
  /** 検出されたモーションパターン */
  patterns: MotionPatternApi[];
  /** 警告 */
  warnings: MotionWarningApi[];
  /** 処理時間(ms) */
  processingTimeMs: number;
  /** パターン数サマリ */
  summary: {
    totalPatterns: number;
    byType: Record<string, number>;
    byCategory: Record<string, number>;
    byTrigger: Record<string, number>;
  };
}

/**
 * モーションパターン（API用）
 */
export interface MotionPatternApi {
  id: string;
  name: string;
  type: string;
  category: string;
  trigger: string;
  selector?: string | undefined;
  duration: number;
  easing: string;
  delay?: number | undefined;
  iterations?: number | 'infinite' | undefined;
  direction?: string | undefined;
  fillMode?: string | undefined;
  properties: string[];
  performance: {
    level: string;
    usesTransform: boolean;
    usesOpacity: boolean;
    triggersLayout: boolean;
    triggersPaint: boolean;
  };
  accessibility: {
    respectsReducedMotion: boolean;
  };
  rawCss?: string | undefined;
}

/**
 * モーション警告（API用）
 */
export interface MotionWarningApi {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestion?: string | undefined;
}

/**
 * モーション検出エラー情報
 */
export interface MotionDetectErrorInfo {
  code: string;
  message: string;
}

// =====================================================
// Re-export types from service
// =====================================================

export type {
  MotionPattern,
  MotionWarning,
  MotionDetectionResult,
  MotionDetectionOptions,
};

// =====================================================
// Service singleton
// =====================================================

let serviceInstance: MotionDetectorService | null = null;

/**
 * サービスインスタンスを取得
 */
function getServiceInstance(): MotionDetectorService {
  if (!serviceInstance) {
    serviceInstance = new MotionDetectorService();
  }
  return serviceInstance;
}

// =====================================================
// Execute function
// =====================================================

/**
 * モーション検出を実行
 *
 * MotionDetectorServiceを使用してHTML/CSSからモーションパターンを検出する
 *
 * @param input - 検出入力
 * @returns 検出結果
 *
 * @example
 * ```typescript
 * const result = await executeMotionDetect({
 *   html: '<div style="animation: fadeIn 1s">...</div>',
 *   options: {
 *     includeInlineStyles: true,
 *     verbose: false,
 *   },
 * });
 * ```
 */
export function executeMotionDetect(
  input: MotionDetectInput
): MotionDetectOutput {
  logger.debug('[executeMotionDetect] Called', {
    htmlLength: input.html.length,
    hasExternalCss: !!input.externalCss,
    options: input.options,
  });

  try {
    const service = getServiceInstance();

    // undefinedプロパティを除外してMotionDetectionOptionsに変換
    const cleanOptions: MotionDetectionOptions | undefined = input.options ? ((): MotionDetectionOptions | undefined => {
      const opts: MotionDetectionOptions = {};
      if (input.options!.includeInlineStyles !== undefined) opts.includeInlineStyles = input.options!.includeInlineStyles;
      if (input.options!.includeStyleSheets !== undefined) opts.includeStyleSheets = input.options!.includeStyleSheets;
      if (input.options!.minDuration !== undefined) opts.minDuration = input.options!.minDuration;
      if (input.options!.maxPatterns !== undefined) opts.maxPatterns = input.options!.maxPatterns;
      if (input.options!.verbose !== undefined) opts.verbose = input.options!.verbose;
      return Object.keys(opts).length > 0 ? opts : undefined;
    })() : undefined;

    const result = service.detect(input.html, cleanOptions, input.externalCss);

    // パターンをAPI形式に変換
    const patternsApi: MotionPatternApi[] = result.patterns.map(p => ({
      id: p.id,
      name: p.name,
      type: p.type,
      category: p.category,
      trigger: p.trigger,
      selector: p.selector,
      duration: p.duration,
      easing: p.easing,
      delay: p.delay,
      iterations: p.iterations,
      direction: p.direction,
      fillMode: p.fillMode,
      properties: p.properties,
      performance: {
        level: p.performance.level,
        usesTransform: p.performance.usesTransform,
        usesOpacity: p.performance.usesOpacity,
        triggersLayout: p.performance.triggersLayout,
        triggersPaint: p.performance.triggersPaint,
      },
      accessibility: {
        respectsReducedMotion: p.accessibility.respectsReducedMotion,
      },
      rawCss: p.rawCss,
    }));

    // 警告をAPI形式に変換
    const warningsApi: MotionWarningApi[] = result.warnings.map(w => ({
      code: w.code,
      severity: w.severity,
      message: w.message,
      suggestion: w.suggestion,
    }));

    // サマリを生成
    const summary = generateSummary(result.patterns);

    const data: MotionDetectData = {
      patterns: patternsApi,
      warnings: warningsApi,
      processingTimeMs: result.processingTimeMs,
      summary,
    };

    logger.debug('[executeMotionDetect] Success', {
      patternCount: data.patterns.length,
      warningCount: data.warnings.length,
      processingTimeMs: data.processingTimeMs,
    });

    return {
      success: true,
      data,
    };
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[executeMotionDetect] Error', error);
    }

    return {
      success: false,
      error: {
        code: 'MOTION_DETECTION_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
}

/**
 * パターンのサマリを生成
 */
function generateSummary(patterns: MotionPattern[]): MotionDetectData['summary'] {
  const byType: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byTrigger: Record<string, number> = {};

  for (const p of patterns) {
    byType[p.type] = (byType[p.type] || 0) + 1;
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
    byTrigger[p.trigger] = (byTrigger[p.trigger] || 0) + 1;
  }

  return {
    totalPatterns: patterns.length,
    byType,
    byCategory,
    byTrigger,
  };
}

/**
 * サービスインスタンスをリセット（テスト用）
 */
export function resetMotionDetectService(): void {
  serviceInstance = null;
}
