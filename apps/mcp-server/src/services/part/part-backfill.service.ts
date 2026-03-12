// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Embedding Backfill Service
 *
 * 既存のページ（Part-Level Analysis導入前に分析済み）に対して、
 * セクションからパーツ抽出をバッチ実行するサービス。
 *
 * For existing pages that were analyzed before Part-Level Analysis was added.
 * Iterates over section_patterns, extracts parts, generates embeddings, saves to DB.
 *
 * 設計:
 * - チャンク単位で処理（メモリ安全）
 * - dry-runモードでプレビュー可能
 * - skipExistingでパーツ既存セクションをスキップ
 * - 現時点ではパーツ抽出のみ（Embedding生成はPhase 5.1で別途対応）
 *
 * Design:
 * - Processes in chunks (memory-safe)
 * - Preview with dry-run mode
 * - Skip sections with existing parts via skipExisting
 * - Currently extraction only (embedding generation is Phase 5.1)
 *
 * @module services/part/part-backfill.service
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../../utils/logger';
import { truncateId } from './schemas';
import { extractPartsFromSection } from './part-extraction.service';
import { saveExtractedParts } from './part-db.service';
import { DEFAULT_PART_EXTRACTION_CONFIG } from './types';
import type { PartExtractionConfig } from './types';

// ============================================================================
// Types / 型定義
// ============================================================================

/**
 * バックフィルオプション
 * Backfill options
 */
export interface BackfillOptions {
  /** チャンクサイズ（デフォルト: 5） / Chunk size (default: 5) */
  chunkSize: number;
  /** ドライランモード / Dry-run mode */
  dryRun: boolean;
  /** 特定WebページIDのみ処理 / Process single page only */
  webPageId?: string;
  /** パーツ既存セクションをスキップ（デフォルト: true） / Skip sections with existing parts (default: true) */
  skipExisting: boolean;
}

/**
 * バックフィル結果
 * Backfill result
 */
export interface BackfillResult {
  /** 処理されたページ数 / Number of pages processed */
  pagesProcessed: number;
  /** 処理されたセクション数 / Number of sections processed */
  sectionsProcessed: number;
  /** 抽出されたパーツ数 / Number of parts extracted */
  partsExtracted: number;
  /** 生成されたEmbedding数（現在は0） / Embeddings generated (currently 0) */
  embeddingsGenerated: number;
  /** エラー一覧 / Error list */
  errors: string[];
  /** 処理時間（ミリ秒） / Duration (milliseconds) */
  durationMs: number;
}

/**
 * DB行型（セクション + WebページURL）
 * DB row type (section + web page URL)
 */
interface SectionRow {
  id: string;
  webPageId: string;
  sectionType: string;
  htmlContent: string | null;
  webPageUrl: string;
}

// ============================================================================
// Default Options / デフォルトオプション
// ============================================================================

const DEFAULT_BACKFILL_OPTIONS: BackfillOptions = {
  chunkSize: 5,
  dryRun: false,
  skipExisting: true,
};

// ============================================================================
// Public Functions / 公開関数
// ============================================================================

/**
 * 既存ページに対してパーツ抽出をバックフィル実行する
 * Backfill part extraction for existing pages
 *
 * @param prisma - Prismaクライアント / Prisma client
 * @param userOptions - バックフィルオプション / Backfill options
 * @returns バックフィル結果 / Backfill result
 */
export async function backfillPartEmbeddings(
  prisma: PrismaClient,
  userOptions?: Partial<BackfillOptions>,
): Promise<BackfillResult> {
  const options: BackfillOptions = {
    ...DEFAULT_BACKFILL_OPTIONS,
    ...userOptions,
  };

  const startTime = Date.now();
  const result: BackfillResult = {
    pagesProcessed: 0,
    sectionsProcessed: 0,
    partsExtracted: 0,
    embeddingsGenerated: 0,
    errors: [],
    durationMs: 0,
  };

  logger.info('[part-backfill] Starting backfill', {
    chunkSize: options.chunkSize,
    dryRun: options.dryRun,
    skipExisting: options.skipExisting,
    webPageId: options.webPageId ? truncateId(options.webPageId) : 'all',
  });

  try {
    // セクション一覧を取得 / Get section list
    const sections = await fetchSections(prisma, options);

    logger.info('[part-backfill] Sections to process', {
      totalSections: sections.length,
    });

    if (sections.length === 0) {
      logger.info('[part-backfill] No sections to process');
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // ページIDを追跡 / Track page IDs
    const processedPageIds = new Set<string>();

    // チャンク単位で処理 / Process in chunks
    const extractionConfig: PartExtractionConfig = {
      ...DEFAULT_PART_EXTRACTION_CONFIG,
    };

    for (let i = 0; i < sections.length; i += options.chunkSize) {
      const chunk = sections.slice(i, i + options.chunkSize);

      for (const section of chunk) {
        try {
          processedPageIds.add(section.webPageId);

          if (!section.htmlContent) {
            logger.info('[part-backfill] Section has no HTML content, skipping', {
              sectionId: truncateId(section.id),
            });
            continue;
          }

          if (options.dryRun) {
            // ドライラン: カウントのみ / Dry-run: count only
            logger.info('[part-backfill] [DRY RUN] Would process section', {
              sectionId: truncateId(section.id),
              sectionType: section.sectionType,
              webPageUrl: section.webPageUrl,
            });
            result.sectionsProcessed++;
            continue;
          }

          // パーツ抽出 / Extract parts
          const extractionResult = await extractPartsFromSection({
            sectionHtml: section.htmlContent,
            sectionIndex: 0,
            config: extractionConfig,
            computedStylesMap: new Map(),
            sectionBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
            sourceUrl: section.webPageUrl,
          });

          if (extractionResult.parts.length > 0) {
            // パーツ保存 / Save parts
            const saveResult = await saveExtractedParts(
              prisma,
              section.webPageId,
              section.id,
              extractionResult.parts,
              section.webPageUrl,
            );

            result.partsExtracted += saveResult.savedCount;

            logger.info('[part-backfill] Section processed', {
              sectionId: truncateId(section.id),
              partsExtracted: extractionResult.parts.length,
              savedCount: saveResult.savedCount,
              skippedDuplicates: saveResult.skippedDuplicates,
            });
          }

          result.sectionsProcessed++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors.push(
            `Section ${truncateId(section.id)}: ${errorMessage}`
          );
          logger.warn('[part-backfill] Section processing error', {
            sectionId: truncateId(section.id),
            error: errorMessage,
          });
        }
      }
    }

    result.pagesProcessed = processedPageIds.size;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(`Fatal: ${errorMessage}`);
    logger.error('[part-backfill] Fatal error', { error: errorMessage });
  }

  result.durationMs = Date.now() - startTime;

  logger.info('[part-backfill] Backfill completed', {
    pagesProcessed: result.pagesProcessed,
    sectionsProcessed: result.sectionsProcessed,
    partsExtracted: result.partsExtracted,
    embeddingsGenerated: result.embeddingsGenerated,
    errorCount: result.errors.length,
    durationMs: result.durationMs,
    dryRun: (userOptions ?? {}).dryRun ?? false,
  });

  return result;
}

// ============================================================================
// Internal Functions / 内部関数
// ============================================================================

/**
 * 処理対象セクション一覧を取得
 * Fetch sections to process
 *
 * skipExisting=trueの場合、既にComponentPartを持つセクションを除外する。
 * When skipExisting=true, excludes sections that already have ComponentParts.
 */
async function fetchSections(
  prisma: PrismaClient,
  options: BackfillOptions,
): Promise<SectionRow[]> {
  // WebページIDフィルタ / Web page ID filter
  const webPageFilter = options.webPageId
    ? { webPageId: options.webPageId }
    : {};

  if (options.skipExisting) {
    // パーツが存在しないセクションのみ取得
    // Only fetch sections without existing parts
    const sections = await prisma.sectionPattern.findMany({
      where: {
        ...webPageFilter,
        componentParts: { none: {} },
      },
      select: {
        id: true,
        webPageId: true,
        sectionType: true,
        webPage: { select: { url: true, htmlContent: true } },
      },
      orderBy: { webPageId: 'asc' },
    });

    return sections.map((s) => ({
      id: s.id,
      webPageId: s.webPageId,
      sectionType: s.sectionType,
      htmlContent: s.webPage.htmlContent,
      webPageUrl: s.webPage.url,
    }));
  }

  // 全セクションを取得 / Fetch all sections
  const sections = await prisma.sectionPattern.findMany({
    where: webPageFilter,
    select: {
      id: true,
      webPageId: true,
      sectionType: true,
      webPage: { select: { url: true, htmlContent: true } },
    },
    orderBy: { webPageId: 'asc' },
  });

  return sections.map((s) => ({
    id: s.id,
    webPageId: s.webPageId,
    sectionType: s.sectionType,
    htmlContent: s.webPage.htmlContent,
    webPageUrl: s.webPage.url,
  }));
}
