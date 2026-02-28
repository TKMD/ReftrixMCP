// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Background Design DB Service
 *
 * BackgroundDesign テーブルへのCRUD操作を提供するサービス。
 * page.analyze パイプラインからの背景デザイン検出結果をDBに保存する。
 *
 * パターン:
 * - クリーンスレート（deleteMany → createMany）でSectionPatternと同様
 * - UUIDv7 によるID生成
 * - Graceful Degradation（保存失敗時もpage.analyzeは継続）
 *
 * @module services/background/background-design-db.service
 */

import { v7 as uuidv7 } from 'uuid';
import { logger, isDevelopment } from '../../utils/logger';

// =============================================================================
// Types
// =============================================================================

/**
 * DB保存用の背景デザインデータ（exactOptionalPropertyTypes対応）
 */
export interface BackgroundDesignForSave {
  name: string;
  designType: string;
  cssValue: string;
  selector?: string | undefined;
  positionIndex: number;
  colorInfo: Record<string, unknown>;
  gradientInfo?: Record<string, unknown> | undefined;
  visualProperties: Record<string, unknown>;
  animationInfo?: Record<string, unknown> | undefined;
  cssImplementation?: string | undefined;
  performance: Record<string, unknown>;
  confidence?: number | undefined;
  sourceUrl?: string | undefined;
  usageScope?: string | undefined;
  tags?: string[] | undefined;
}

/**
 * 保存結果
 */
export interface SaveBackgroundDesignsResult {
  success: boolean;
  count: number;
  ids: string[];
  /** name → DB UUIDv7 のマッピング（Embedding生成で使用） */
  idMapping: Map<string, string>;
  error?: string | undefined;
}

/**
 * Prismaクライアントインターフェース（背景デザイン保存用）
 *
 * テスト可能にするための最小インターフェース
 */
export interface BackgroundDesignPrismaClient {
  backgroundDesign: {
    deleteMany: (args: { where: { webPageId: string } }) => Promise<{ count: number }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * 背景デザイン検出結果をDBに保存
 *
 * 1. 既存のBackgroundDesignsを削除（クリーンスレート、SectionPatternと同パターン）
 * 2. 新しいBackgroundDesignレコードをバッチ作成（createMany）
 *
 * @param prisma - Prismaクライアント（backgroundDesignモデルを含む）
 * @param webPageId - 対象WebPageのID
 * @param backgrounds - 保存する背景デザインデータ配列
 * @returns 保存結果
 */
export async function saveBackgroundDesigns(
  prisma: BackgroundDesignPrismaClient,
  webPageId: string,
  backgrounds: BackgroundDesignForSave[]
): Promise<SaveBackgroundDesignsResult> {
  // 空配列の場合はDB操作をスキップ
  if (backgrounds.length === 0) {
    return { success: true, count: 0, ids: [], idMapping: new Map() };
  }

  try {
    // 1. 既存レコードを削除（クリーンスレート）
    await prisma.backgroundDesign.deleteMany({
      where: { webPageId },
    });

    if (isDevelopment()) {
      logger.debug('[BackgroundDesignDB] Existing records deleted', { webPageId });
    }

    // 2. UUIDv7を生成してデータを準備
    const ids: string[] = [];
    const idMapping = new Map<string, string>();
    const data = backgrounds.map((bg) => {
      const id = uuidv7();
      ids.push(id);
      idMapping.set(bg.name, id); // Use original name for mapping lookups

      // Truncate fields to fit DB column limits
      const truncatedName = bg.name.length > 200
        ? bg.name.slice(0, 200)
        : bg.name;
      const truncatedSelector = bg.selector !== undefined && bg.selector.length > 500
        ? bg.selector.slice(0, 500)
        : bg.selector;

      if (bg.name.length > 200 || (bg.selector !== undefined && bg.selector.length > 500)) {
        logger.debug('[BackgroundDesignDB] Truncated fields', {
          webPageId,
          originalName: bg.name.length > 200 ? `${bg.name.length} chars → 200` : undefined,
          originalSelector: bg.selector !== undefined && bg.selector.length > 500
            ? `${bg.selector.length} chars → 500`
            : undefined,
        });
      }

      // exactOptionalPropertyTypes対応: undefinedのフィールドは含めない
      const record: Record<string, unknown> = {
        id,
        webPageId,
        name: truncatedName,
        designType: bg.designType,
        cssValue: bg.cssValue,
        positionIndex: bg.positionIndex,
        colorInfo: bg.colorInfo,
        visualProperties: bg.visualProperties,
        performance: bg.performance,
        usageScope: bg.usageScope ?? 'inspiration_only',
        tags: bg.tags ?? [],
        metadata: {},
      };

      // オプショナルフィールドは存在する場合のみ設定
      if (truncatedSelector !== undefined) {
        record.selector = truncatedSelector;
      }
      if (bg.gradientInfo !== undefined) {
        record.gradientInfo = bg.gradientInfo;
      }
      if (bg.animationInfo !== undefined) {
        record.animationInfo = bg.animationInfo;
      }
      if (bg.cssImplementation !== undefined) {
        record.cssImplementation = bg.cssImplementation;
      }
      if (bg.confidence !== undefined) {
        record.confidence = bg.confidence;
      }
      if (bg.sourceUrl !== undefined) {
        record.sourceUrl = bg.sourceUrl;
      }

      return record;
    });

    // 3. バッチインサート
    const result = await prisma.backgroundDesign.createMany({ data });

    if (isDevelopment()) {
      logger.info('[BackgroundDesignDB] Saved background designs', {
        webPageId,
        count: result.count,
        idCount: ids.length,
      });
    }

    return {
      success: true,
      count: result.count,
      ids,
      idMapping,
    };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : 'Failed to save background designs';

    if (isDevelopment()) {
      logger.error('[BackgroundDesignDB] Save failed', {
        webPageId,
        error: errorMessage,
      });
    }

    return {
      success: false,
      count: 0,
      ids: [],
      idMapping: new Map(),
      error: errorMessage,
    };
  }
}
