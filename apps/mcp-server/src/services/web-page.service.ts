// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebPageService
 * WebPageテーブルへのアクセスを提供するサービス
 *
 * motion.detectツールのgetPageById要件を満たす
 *
 * @module services/web-page.service
 */

import { prisma } from '@reftrix/database';
import { logger, isDevelopment } from '../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * WebPage取得結果（motion.detect互換）
 */
export interface WebPageResult {
  id: string;
  htmlContent: string;
  cssContent?: string;
}

/**
 * WebPage基本情報（URL検索用）
 */
export interface WebPageMinimal {
  id: string;
  url: string;
}

/**
 * findOrCreateByUrl結果
 */
export interface FindOrCreateResult {
  id: string;
  url: string;
  /** trueなら新規作成、falseなら既存レコードを使用 */
  created: boolean;
}

/**
 * WebPageサービスインターフェース
 */
export interface IWebPageService {
  getPageById(id: string): Promise<WebPageResult | null>;
  findByUrl(url: string): Promise<WebPageMinimal | null>;
  findOrCreateByUrl(url: string, options?: { sourceType?: string; usageScope?: string }): Promise<FindOrCreateResult>;
}

// =====================================================
// WebPageService 実装
// =====================================================

/**
 * WebPageサービス
 * Prismaを使用してWebPageテーブルにアクセス
 */
class WebPageService implements IWebPageService {
  /**
   * IDでWebPageを取得
   *
   * @param id - WebPage UUID
   * @returns WebPage情報（htmlContent含む）またはnull
   */
  async getPageById(id: string): Promise<WebPageResult | null> {
    try {
      if (isDevelopment()) {
        logger.info('[WebPageService] getPageById', { id });
      }

      const page = await prisma.webPage.findUnique({
        where: { id },
        select: {
          id: true,
          htmlContent: true,
          // CSS is not stored separately in WebPage, so we don't include it
        },
      });

      if (!page) {
        if (isDevelopment()) {
          logger.warn('[WebPageService] Page not found', { id });
        }
        return null;
      }

      if (!page.htmlContent) {
        if (isDevelopment()) {
          logger.warn('[WebPageService] Page has no HTML content', { id });
        }
        return null;
      }

      if (isDevelopment()) {
        logger.info('[WebPageService] Page found', {
          id: page.id,
          htmlLength: page.htmlContent.length,
        });
      }

      return {
        id: page.id,
        htmlContent: page.htmlContent,
        // cssContent is undefined as WebPage doesn't store CSS separately
      };
    } catch (error) {
      logger.error('[WebPageService] Error getting page by ID', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * URLでWebPageを検索
   *
   * @param url - 検索するURL（完全一致）
   * @returns WebPage基本情報またはnull
   */
  async findByUrl(url: string): Promise<WebPageMinimal | null> {
    try {
      if (isDevelopment()) {
        logger.info('[WebPageService] findByUrl', { url });
      }

      const page = await prisma.webPage.findUnique({
        where: { url },
        select: {
          id: true,
          url: true,
        },
      });

      if (!page) {
        if (isDevelopment()) {
          logger.debug('[WebPageService] Page not found by URL', { url });
        }
        return null;
      }

      if (isDevelopment()) {
        logger.info('[WebPageService] Page found by URL', {
          id: page.id,
          url: page.url,
        });
      }

      return {
        id: page.id,
        url: page.url,
      };
    } catch (error) {
      logger.error('[WebPageService] Error finding page by URL', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * URLでWebPageを検索し、存在しなければ新規作成
   *
   * motion.detect URL modeでWebPageレコードを自動作成するために使用。
   * HTMLコンテンツは後から更新可能（最小限のレコードのみ作成）。
   *
   * @param url - WebPageのURL
   * @param options - 作成オプション
   * @returns WebPage情報と作成フラグ
   */
  async findOrCreateByUrl(
    url: string,
    options?: { sourceType?: string; usageScope?: string }
  ): Promise<FindOrCreateResult> {
    const sourceType = options?.sourceType ?? 'user_provided';
    const usageScope = options?.usageScope ?? 'inspiration_only';

    try {
      if (isDevelopment()) {
        logger.info('[WebPageService] findOrCreateByUrl', { url, sourceType, usageScope });
      }

      // まず既存のレコードを検索
      const existing = await this.findByUrl(url);
      if (existing) {
        if (isDevelopment()) {
          logger.info('[WebPageService] Using existing WebPage', {
            id: existing.id,
            url: existing.url,
          });
        }
        return {
          id: existing.id,
          url: existing.url,
          created: false,
        };
      }

      // 存在しなければ新規作成（最小限の情報のみ）
      const created = await prisma.webPage.create({
        data: {
          url,
          sourceType,
          usageScope,
          // htmlContentは後から更新可能
          // titleは後から更新可能
        },
        select: {
          id: true,
          url: true,
        },
      });

      if (isDevelopment()) {
        logger.info('[WebPageService] Created new WebPage', {
          id: created.id,
          url: created.url,
          sourceType,
          usageScope,
        });
      }

      return {
        id: created.id,
        url: created.url,
        created: true,
      };
    } catch (error) {
      logger.error('[WebPageService] Error in findOrCreateByUrl', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

// =====================================================
// シングルトンインスタンス
// =====================================================

/**
 * WebPageServiceシングルトンインスタンス
 */
export const webPageService = new WebPageService();

// =====================================================
// ファクトリー関数
// =====================================================

/**
 * WebPageサービスファクトリー
 * DIパターン用のファクトリー関数
 */
export function createWebPageService(): IWebPageService {
  return webPageService;
}

// =====================================================
// 開発環境ログ
// =====================================================

if (isDevelopment()) {
  logger.debug('[WebPageService] Module loaded');
}
