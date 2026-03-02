// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ResponsivePersistenceService
 * レスポンシブ解析結果をDBに保存・取得するサービス
 *
 * @module services/responsive/responsive-persistence.service
 */

import { prisma, Prisma } from '@reftrix/database';
import { isDevelopment, logger } from '../../utils/logger';
import type { ResponsiveAnalysisResult, ViewportDiffResult } from './types';

/**
 * DB保存用の入力型
 */
export interface ResponsivePersistenceInput {
  webPageId: string;
  result: ResponsiveAnalysisResult;
}

/**
 * DBから取得した ResponsiveAnalysis レコード
 */
export interface ResponsiveAnalysisRecord {
  id: string;
  webPageId: string;
  viewportsAnalyzed: unknown;
  differences: unknown;
  breakpoints: unknown;
  screenshotDiffs: unknown;
  qualityMetrics: unknown;
  analysisTimeMs: number;
  createdAt: Date;
}

/**
 * ResponsivePersistenceService
 * responsive_analyses テーブルへの保存・取得を管理
 */
export class ResponsivePersistenceService {
  /**
   * レスポンシブ解析結果をDBに保存
   *
   * @param webPageId - 対象WebPageのID
   * @param result - レスポンシブ解析結果
   * @returns 保存されたレコードのID
   */
  async save(webPageId: string, result: ResponsiveAnalysisResult): Promise<string> {
    if (isDevelopment()) {
      logger.info('[ResponsivePersistence] Saving responsive analysis', {
        webPageId,
        viewportsAnalyzed: result.viewportsAnalyzed.length,
        differencesFound: result.differences.length,
      });
    }

    // viewportDiffs から screenshotDiffs 用の JSONB データを構築
    const screenshotDiffs: Prisma.InputJsonValue | typeof Prisma.DbNull = result.viewportDiffs
      ? result.viewportDiffs.map((diff: ViewportDiffResult) => ({
          viewport1: diff.viewport1,
          viewport2: diff.viewport2,
          diffPercentage: diff.diffPercentage,
          diffPixelCount: diff.diffPixelCount,
          totalPixels: diff.totalPixels,
          comparedWidth: diff.comparedWidth,
          comparedHeight: diff.comparedHeight,
          // diffImageBuffer はバイナリなので DB には保存しない
        }))
      : Prisma.DbNull;

    // clean-slate: 同一webPageIdの既存レコードを削除（CASCADE DELETEでembeddingも削除）
    const deleted = await prisma.responsiveAnalysis.deleteMany({
      where: { webPageId },
    });

    if (isDevelopment() && deleted.count > 0) {
      logger.info('[ResponsivePersistence] Deleted existing records (clean-slate)', {
        webPageId,
        deletedCount: deleted.count,
      });
    }

    // viewportsAnalyzed を JSONB 形式で保存
    // DB スキーマは [{name, width, height}] 形式を期待
    // result.viewportsAnalyzed は ResponsiveViewport[] なのでそのまま渡す
    // NOTE: width/height はプリセット値（RESPONSIVE_VIEWPORTS定義）であり、
    // 実際のユーザーデバイス解像度ではない。フィンガープリンティングリスクなし。
    const record = await prisma.responsiveAnalysis.create({
      data: {
        webPageId,
        viewportsAnalyzed: result.viewportsAnalyzed.map((v) => ({
          name: v.name,
          width: v.width,
          height: v.height,
        })),
        differences: result.differences as unknown as object[],
        breakpoints: result.breakpoints.map((bp: string) => ({ name: bp })),
        screenshotDiffs: screenshotDiffs,
        analysisTimeMs: result.analysisTimeMs,
      },
      select: { id: true },
    });

    if (isDevelopment()) {
      logger.info('[ResponsivePersistence] Responsive analysis saved', {
        id: record.id,
        webPageId,
      });
    }

    return record.id;
  }

  /**
   * WebPage IDに紐づく最新のレスポンシブ解析結果を取得
   *
   * @param webPageId - 対象WebPageのID
   * @returns レスポンシブ解析レコード（存在しない場合は null）
   */
  async findByWebPageId(webPageId: string): Promise<ResponsiveAnalysisRecord | null> {
    const record = await prisma.responsiveAnalysis.findFirst({
      where: { webPageId },
      orderBy: { createdAt: 'desc' },
    });

    return record;
  }
}

// シングルトンインスタンス
export const responsivePersistenceService = new ResponsivePersistenceService();
