// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * レスポンスサイズ警告ミドルウェア
 * MCPツールのレスポンスサイズを監視し、閾値超過時に警告を出力
 *
 * 機能:
 * - レスポンスサイズの計測（バイト単位）
 * - 警告閾値（デフォルト10KB）超過時にwarnログ出力
 * - クリティカル閾値（デフォルト50KB）超過時にerrorログ出力
 * - ツール別の最適化推奨メッセージ
 *
 * @module response-size-warning
 */

import type { ILogger } from '../utils/logger';
import { createLogger } from '../utils/logger';

/**
 * デフォルトの警告閾値（KB）
 */
export const DEFAULT_WARNING_THRESHOLD_KB = 10;

/**
 * デフォルトのクリティカル閾値（KB）
 */
export const DEFAULT_CRITICAL_THRESHOLD_KB = 50;

/**
 * ミドルウェア設定
 */
export interface ResponseSizeWarningOptions {
  /** 警告閾値（KB） */
  warningThresholdKB?: number;
  /** クリティカル閾値（KB） */
  criticalThresholdKB?: number;
}

/**
 * レスポンスサイズチェック結果
 */
export interface ResponseSizeResult {
  /** レスポンスサイズ（バイト） */
  sizeBytes: number;
  /** フォーマットされたサイズ文字列 */
  sizeFormatted: string;
  /** 警告閾値を超過したか */
  exceededWarning: boolean;
  /** クリティカル閾値を超過したか */
  exceededCritical: boolean;
  /** ツール名 */
  toolName: string;
  /** 最適化推奨メッセージ（閾値超過時のみ） */
  recommendation?: string;
}

/**
 * レスポンスオブジェクトのサイズを計算
 *
 * @param response - レスポンスオブジェクト
 * @returns サイズ（バイト）
 * @throws 循環参照がある場合はエラー
 */
export function calculateResponseSize(response: unknown): number {
  const jsonString = JSON.stringify(response);
  return jsonString.length;
}

/**
 * サイズをフォーマットされた文字列に変換
 *
 * @param bytes - サイズ（バイト）
 * @returns フォーマットされた文字列（例: "1.50 KB"）
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * ツール別の最適化パラメータマッピング（WebDesign専用）
 */
const OPTIMIZATION_RECOMMENDATIONS: Record<string, string> = {
  'layout.search': 'レスポンスサイズを削減するには includeHtml: false を使用してください',
  'layout.ingest': 'レスポンスサイズを削減するには include_html: false, include_screenshot: false を使用してください',
  'quality.evaluate': 'レスポンスサイズを削減するには includeRecommendations: false を使用してください',
  'motion.detect': 'レスポンスサイズを削減するには includeSummary: false, includeWarnings: false を使用してください',
};

/**
 * レスポンスサイズ警告ミドルウェア
 */
export class ResponseSizeWarning {
  private readonly logger: ILogger;
  private readonly warningThresholdBytes: number;
  private readonly criticalThresholdBytes: number;

  /**
   * コンストラクタ
   *
   * @param logger - ロガーインスタンス（省略時はデフォルトロガー）
   * @param options - ミドルウェア設定
   */
  constructor(
    logger?: ILogger,
    options: ResponseSizeWarningOptions = {}
  ) {
    this.logger = logger || createLogger('ResponseSize');
    this.warningThresholdBytes =
      (options.warningThresholdKB ?? DEFAULT_WARNING_THRESHOLD_KB) * 1024;
    this.criticalThresholdBytes =
      (options.criticalThresholdKB ?? DEFAULT_CRITICAL_THRESHOLD_KB) * 1024;
  }

  /**
   * レスポンスサイズをチェックし、閾値超過時に警告を出力
   *
   * @param toolName - MCPツール名
   * @param response - レスポンスオブジェクト
   * @returns チェック結果
   */
  checkResponseSize(toolName: string, response: unknown): ResponseSizeResult {
    const sizeBytes = calculateResponseSize(response);
    const sizeFormatted = formatSize(sizeBytes);
    const exceededWarning = sizeBytes > this.warningThresholdBytes;
    const exceededCritical = sizeBytes > this.criticalThresholdBytes;

    const result: ResponseSizeResult = {
      sizeBytes,
      sizeFormatted,
      exceededWarning,
      exceededCritical,
      toolName,
    };

    // クリティカル閾値超過
    if (exceededCritical) {
      const recommendation = this.getOptimizationRecommendation(toolName);
      result.recommendation = recommendation;

      this.logger.error(
        `[Response Size Critical] ${toolName} レスポンスサイズがクリティカル閾値を超過`,
        {
          sizeBytes,
          sizeFormatted,
          thresholdKB: DEFAULT_CRITICAL_THRESHOLD_KB,
          recommendation,
        }
      );
      return result;
    }

    // 警告閾値超過
    if (exceededWarning) {
      const recommendation = this.getOptimizationRecommendation(toolName);
      result.recommendation = recommendation;

      this.logger.warn(
        `[Response Size Warning] ${toolName} レスポンスサイズが警告閾値を超過`,
        {
          sizeBytes,
          sizeFormatted,
          thresholdKB: DEFAULT_WARNING_THRESHOLD_KB,
          recommendation,
        }
      );
      return result;
    }

    return result;
  }

  /**
   * ツール別の最適化推奨メッセージを取得
   *
   * @param toolName - MCPツール名
   * @returns 最適化推奨メッセージ
   */
  getOptimizationRecommendation(toolName: string): string {
    // 既知のツールに対する推奨
    if (OPTIMIZATION_RECOMMENDATIONS[toolName]) {
      return OPTIMIZATION_RECOMMENDATIONS[toolName];
    }

    // 未知のツールに対する汎用推奨
    return 'レスポンスサイズを削減するには limit パラメータや適切なフィルタリングを検討してください';
  }
}

/**
 * デフォルトのミドルウェアインスタンス
 */
export const responseSizeWarning = new ResponseSizeWarning();
