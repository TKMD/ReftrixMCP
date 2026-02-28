// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.batch_ingest MCPツール
 * 複数URLを一括でインジェストし、レイアウト解析用データを準備
 *
 * 機能:
 * - 1-100件のURLを並列処理（並列数は設定可能、デフォルト5）
 * - 部分失敗時のskip/abortモード
 * - 処理進捗と結果サマリーを返却
 *
 * @see /docs/plans/webdesign/batch-ingest.md
 */

import { ZodError } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { prisma } from '@reftrix/database';
import { logger, isDevelopment } from '../../utils/logger';
import { validateExternalUrl } from '../../utils/url-validator';
import { normalizeUrlForStorage } from '../../utils/url-normalizer';
import { sanitizeHtml } from '../../utils/html-sanitizer';
import { pageIngestAdapter, type IngestResult } from '../../services/page-ingest-adapter';
import {
  formatZodError,
  createValidationErrorWithHints,
  formatMultipleDetailedErrors,
} from '../../utils/error-messages';
import {
  layoutBatchIngestInputSchema,
  LAYOUT_MCP_ERROR_CODES,
  type LayoutBatchIngestInput,
  type LayoutBatchIngestOutput,
  type BatchIngestResultItem,
} from './schemas';
import { createHash } from 'crypto';

// =============================================
// 型定義
// =============================================

export type { LayoutBatchIngestInput, LayoutBatchIngestOutput };

/**
 * 並列処理用のプロミスプール
 * 指定された並列数を超えないようにタスクを実行
 */
async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];

  for (const task of tasks) {
    const promise = task().then((result) => {
      results.push(result);
    });

    const executingPromise = promise.then(() => {
      executing.splice(executing.indexOf(executingPromise), 1);
    });
    executing.push(executingPromise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

/**
 * 単一URLのインジェスト処理
 */
async function ingestSingleUrl(
  url: string,
  saveToDb: boolean,
  autoAnalyze: boolean
): Promise<BatchIngestResultItem> {
  // SSRF対策: URL検証
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    if (isDevelopment()) {
      logger.warn('[MCP Tool] layout.batch_ingest SSRF blocked', {
        url,
        reason: urlValidation.error,
      });
    }
    return {
      url,
      status: 'failed',
      error: `SSRF blocked: ${urlValidation.error ?? 'URL is blocked for security reasons'}`,
    };
  }

  try {
    // PageIngestAdapterを使用してページを取得
    const ingestResult: IngestResult = await pageIngestAdapter.ingest({
      url,
      fullPage: true,
      sourceType: 'user_provided',
      usageScope: 'inspiration_only',
      adaptiveWebGLWait: true,
    });

    if (!ingestResult.success) {
      return {
        url,
        status: 'failed',
        error: ingestResult.error ?? 'Page ingest failed',
      };
    }

    // HTMLサニタイズ
    const sanitizedHtml = sanitizeHtml(ingestResult.html);

    // DB保存処理
    let persistedId: string | undefined;
    let patternsExtracted = 0;

    if (saveToDb) {
      try {
        const htmlHash = createHash('sha256').update(sanitizedHtml).digest('hex');
        const normalizedUrl = normalizeUrlForStorage(urlValidation.normalizedUrl ?? url);

        const savedPage = await prisma.webPage.upsert({
          where: { url: normalizedUrl },
          create: {
            url: normalizedUrl,
            title: ingestResult.metadata.title || null,
            description: ingestResult.metadata.description || null,
            sourceType: ingestResult.source.type,
            usageScope: ingestResult.source.usageScope,
            htmlContent: sanitizedHtml,
            htmlHash,
            metadata: {
              favicon: ingestResult.metadata.favicon,
              ogImage: ingestResult.metadata.ogImage,
            },
            crawledAt: ingestResult.ingestedAt,
            analysisStatus: autoAnalyze ? 'pending' : 'completed',
          },
          update: {
            title: ingestResult.metadata.title || null,
            description: ingestResult.metadata.description || null,
            htmlContent: sanitizedHtml,
            htmlHash,
            metadata: {
              favicon: ingestResult.metadata.favicon,
              ogImage: ingestResult.metadata.ogImage,
            },
            crawledAt: ingestResult.ingestedAt,
            analysisStatus: autoAnalyze ? 'pending' : 'completed',
          },
          select: { id: true },
        });

        persistedId = savedPage.id;

        // auto_analyzeの場合はセクション数をカウント（実際の解析はバックグラウンドで）
        // Note: 完全な実装ではLayoutAnalyzerServiceを使用してセクション解析とEmbedding保存を行う
        // 現時点ではDB保存のみを行い、セクション数は0として返す
        patternsExtracted = 0;

        if (isDevelopment()) {
          logger.info('[MCP Tool] layout.batch_ingest saved to DB', {
            id: persistedId,
            url: normalizedUrl,
          });
        }
      } catch (dbError) {
        const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
        if (isDevelopment()) {
          logger.error('[MCP Tool] layout.batch_ingest DB save failed', {
            url,
            error: errorMessage,
          });
        }
        return {
          url,
          status: 'failed',
          error: `Failed to save to database: ${errorMessage}`,
        };
      }
    }

    return {
      url,
      status: 'success',
      page_id: persistedId,
      patterns_extracted: patternsExtracted,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isDevelopment()) {
      logger.error('[MCP Tool] layout.batch_ingest error', {
        url,
        error: errorMessage,
      });
    }
    return {
      url,
      status: 'failed',
      error: errorMessage,
    };
  }
}

// =============================================
// メインハンドラー
// =============================================

/**
 * layout.batch_ingest ツールハンドラー
 *
 * @param input - 入力パラメータ
 * @returns バッチインジェスト結果
 *
 * @example
 * ```typescript
 * const result = await layoutBatchIngestHandler({
 *   urls: ['https://example.com', 'https://example.org'],
 *   options: {
 *     concurrency: 5,
 *     on_error: 'skip',
 *     save_to_db: true,
 *     auto_analyze: true,
 *   },
 * });
 * ```
 */
export async function layoutBatchIngestHandler(
  input: unknown
): Promise<LayoutBatchIngestOutput> {
  const startTime = Date.now();

  // 開発環境でのログ出力
  if (isDevelopment()) {
    logger.info('[MCP Tool] layout.batch_ingest called', {
      urlCount: Array.isArray((input as Record<string, unknown>)?.urls)
        ? ((input as Record<string, unknown>).urls as unknown[]).length
        : 0,
    });
  }

  // 入力バリデーション
  let validated: LayoutBatchIngestInput;
  try {
    validated = layoutBatchIngestInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorWithHints = createValidationErrorWithHints(error, 'layout.batch_ingest');
      const detailedMessage = formatMultipleDetailedErrors(errorWithHints.errors);
      const formattedErrors = formatZodError(error);

      if (isDevelopment()) {
        logger.error('[MCP Tool] layout.batch_ingest validation error', {
          errors: errorWithHints.errors,
        });
      }

      return {
        success: false,
        error: {
          code: LAYOUT_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error:\n${detailedMessage}`,
          details: {
            errors: formattedErrors,
            detailedErrors: errorWithHints.errors,
          },
        },
      };
    }
    throw error;
  }

  // オプションの取得
  const concurrency = validated.options?.concurrency ?? 5;
  const onError = validated.options?.on_error ?? 'skip';
  const saveToDb = validated.options?.save_to_db ?? true;
  const autoAnalyze = validated.options?.auto_analyze ?? true;

  const jobId = uuidv7();
  const results: BatchIngestResultItem[] = [];
  let completed = 0;
  let failed = 0;
  let totalPatterns = 0;

  if (isDevelopment()) {
    logger.info('[MCP Tool] layout.batch_ingest starting', {
      jobId,
      urlCount: validated.urls.length,
      concurrency,
      onError,
      saveToDb,
      autoAnalyze,
    });
  }

  // on_error: 'abort' モードの場合は順次処理
  if (onError === 'abort') {
    for (const url of validated.urls) {
      const result = await ingestSingleUrl(url, saveToDb, autoAnalyze);
      results.push(result);

      if (result.status === 'success') {
        completed++;
        totalPatterns += result.patterns_extracted ?? 0;
      } else {
        failed++;
        // abortモードでは最初の失敗で中止
        const processingTimeMs = Date.now() - startTime;

        if (isDevelopment()) {
          logger.warn('[MCP Tool] layout.batch_ingest aborted', {
            jobId,
            failedUrl: url,
            error: result.error,
            completed,
            failed,
            processingTimeMs,
          });
        }

        return {
          success: false,
          error: {
            code: LAYOUT_MCP_ERROR_CODES.BATCH_ABORTED,
            message: `Batch processing aborted due to failure: ${url} - ${result.error}`,
            details: {
              job_id: jobId,
              completed,
              failed,
              results,
              processing_time_ms: processingTimeMs,
            },
          },
        };
      }
    }
  } else {
    // on_error: 'skip' モードの場合は並列処理
    const tasks = validated.urls.map((url) => async (): Promise<BatchIngestResultItem> => {
      return await ingestSingleUrl(url, saveToDb, autoAnalyze);
    });

    const batchResults = await runWithConcurrencyLimit(tasks, concurrency);

    for (const result of batchResults) {
      results.push(result);
      if (result.status === 'success') {
        completed++;
        totalPatterns += result.patterns_extracted ?? 0;
      } else {
        failed++;
      }
    }
  }

  const processingTimeMs = Date.now() - startTime;
  const successRate = validated.urls.length > 0
    ? Math.round((completed / validated.urls.length) * 10000) / 100
    : 0;

  if (isDevelopment()) {
    logger.info('[MCP Tool] layout.batch_ingest completed', {
      jobId,
      total: validated.urls.length,
      completed,
      failed,
      successRate,
      totalPatterns,
      processingTimeMs,
    });
  }

  return {
    success: true,
    data: {
      job_id: jobId,
      total: validated.urls.length,
      completed,
      failed,
      results,
      summary: {
        success_rate: successRate,
        total_patterns: totalPatterns,
        processing_time_ms: processingTimeMs,
      },
    },
  };
}

// =============================================
// ツール定義
// =============================================

/**
 * layout.batch_ingest MCPツール定義
 * MCP Protocol用のツール定義オブジェクト
 */
export const layoutBatchIngestToolDefinition = {
  name: 'layout.batch_ingest',
  description:
    'Batch ingest multiple URLs for layout analysis. Processes URLs in parallel with configurable concurrency. Supports skip/abort modes for error handling.',
  annotations: {
    title: 'Layout Batch Ingest',
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      urls: {
        type: 'array',
        description: 'Array of URLs to ingest (1-100 items)',
        items: {
          type: 'string',
          format: 'uri',
        },
        minItems: 1,
        maxItems: 100,
      },
      options: {
        type: 'object',
        description: 'Batch processing options',
        properties: {
          concurrency: {
            type: 'number',
            description: 'Number of concurrent requests (1-10, default: 5)',
            minimum: 1,
            maximum: 10,
            default: 5,
          },
          on_error: {
            type: 'string',
            enum: ['skip', 'abort'],
            description: 'Error handling mode: skip (continue on error) or abort (stop on first error). Default: skip',
            default: 'skip',
          },
          save_to_db: {
            type: 'boolean',
            description: 'Save to WebPage table (default: true)',
            default: true,
          },
          auto_analyze: {
            type: 'boolean',
            description: 'Auto-analyze HTML and save SectionPattern with embeddings (default: true)',
            default: true,
          },
        },
      },
    },
    required: ['urls'],
  },
};

// =============================================
// 開発環境ログ
// =============================================

if (isDevelopment()) {
  logger.debug('[layout.batch_ingest] Tool module loaded');
}
