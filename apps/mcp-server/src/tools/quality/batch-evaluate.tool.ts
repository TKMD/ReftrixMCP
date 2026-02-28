// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.batch_evaluate MCPツール
 * 複数ページの品質評価を一括処理します
 *
 * 機能:
 * - 複数ページの一括評価（最大100件）
 * - BullMQ/Redis使用時は非同期バッチ処理
 * - Redis未接続時はLRUストアにフォールバック
 * - ジョブステータスの管理
 * - エラーハンドリング（skip/abort）
 *
 * @module tools/quality/batch-evaluate.tool
 */

import { logger, isDevelopment } from '../../utils/logger';
import { LRUCache } from '../../services/cache';
import { isRedisAvailable } from '../../config/redis';
import {
  createBatchQualityQueue,
  addBatchQualityJob,
  closeBatchQualityQueue,
  type BatchQualityItem,
  type BatchQualityJobData,
} from '../../queues/batch-quality-queue';
import {
  createLowUsageToolDeprecationWarning,
  logDeprecationWarning,
} from '../../utils/deprecation-warning';

import {
  batchQualityEvaluateInputSchema,
  QUALITY_MCP_ERROR_CODES,
  type BatchQualityEvaluateInput,
  type BatchQualityEvaluateOutput,
  type BatchQualityJobStatus,
  type QualityEvaluateData,
} from './schemas';

// =====================================================
// 型定義
// =====================================================

export type { BatchQualityEvaluateInput, BatchQualityEvaluateOutput, BatchQualityJobStatus };

// =====================================================
// サービスインターフェース（DI用）
// =====================================================

export interface IBatchQualityEvaluateService {
  evaluatePage: (html: string) => Promise<QualityEvaluateData>;
  getPageById?: (pageId: string) => Promise<string | null>;
}

let serviceFactory: (() => IBatchQualityEvaluateService) | null = null;

export function setBatchQualityEvaluateServiceFactory(
  factory: () => IBatchQualityEvaluateService
): void {
  serviceFactory = factory;
}

export function resetBatchQualityEvaluateServiceFactory(): void {
  serviceFactory = null;
}

// =====================================================
// LRUキャッシュジョブストア（フォールバック用）
// =====================================================

// ジョブストア設定
const JOB_STORE_MAX_SIZE = 1000; // 最大1000ジョブ
const JOB_STORE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間TTL

// LRUキャッシュを使用したジョブストア（Redis未接続時のフォールバック）
const batchJobStore = new LRUCache<BatchQualityJobStatus>({
  maxSize: JOB_STORE_MAX_SIZE,
  ttlMs: JOB_STORE_TTL_MS,
});

export function clearBatchJobStore(): void {
  batchJobStore.clear();
}

export function addBatchJob(job: BatchQualityJobStatus): void {
  batchJobStore.set(job.job_id, job);
}

export function getBatchJob(jobId: string): BatchQualityJobStatus | undefined {
  return batchJobStore.get(jobId);
}

export function updateBatchJob(jobId: string, update: Partial<BatchQualityJobStatus>): void {
  const existing = batchJobStore.get(jobId);
  if (existing) {
    batchJobStore.set(jobId, { ...existing, ...update });
  }
}

export interface JobStoreStats {
  size: number;
  maxSize: number;
  hitRate: number;
}

export function getJobStoreStats(): JobStoreStats {
  const stats = batchJobStore.getStats();
  return {
    size: stats.size,
    maxSize: stats.maxSize,
    hitRate: stats.hitRate,
  };
}

// =====================================================
// 同期バッチ処理（LRUフォールバック用）
// =====================================================

/**
 * LRUストアベースの同期バッチ処理
 * Redis未接続時に使用される
 */
async function processJobSync(
  jobId: string,
  items: BatchQualityItem[],
  options: {
    batchSize: number;
    onError: 'skip' | 'abort';
    weights?: unknown;
    strict: boolean;
  }
): Promise<void> {
  const service = serviceFactory ? serviceFactory() : null;

  // ジョブを処理中に更新
  updateBatchJob(jobId, {
    status: 'processing',
  });

  let processedItems = 0;
  let successItems = 0;
  let failedItems = 0;
  const results: QualityEvaluateData[] = [];
  const errors: Array<{ index: number; error: { code: string; message: string } }> = [];

  try {
    for (const item of items) {
      try {
        let html: string | null = null;

        if (item.html) {
          html = item.html;
        } else if (item.pageId && service?.getPageById) {
          html = await service.getPageById(item.pageId);
        }

        if (!html) {
          throw new Error(`Cannot resolve HTML for item at index ${item.index}`);
        }

        if (!service) {
          throw new Error('Service factory not configured');
        }

        const result = await service.evaluatePage(html);
        results.push(result);
        successItems++;
      } catch (error) {
        failedItems++;
        errors.push({
          index: item.index,
          error: {
            code: 'EVALUATION_ERROR',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        });

        if (options.onError === 'abort') {
          break;
        }
      }

      processedItems++;

      // 進捗更新
      updateBatchJob(jobId, {
        processed_items: processedItems,
        success_items: successItems,
        failed_items: failedItems,
        progress_percent: Math.round((processedItems / items.length) * 100),
      });
    }

    // 完了更新
    updateBatchJob(jobId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    // ジョブ全体の失敗
    updateBatchJob(jobId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      errors: [
        {
          index: -1,
          error: {
            code: 'BATCH_PROCESSING_ERROR',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
      ],
    });
  }
}

// =====================================================
// ハンドラー
// =====================================================

/**
 * quality.batch_evaluate ツールハンドラー
 */
export async function batchQualityEvaluateHandler(
  input: unknown
): Promise<BatchQualityEvaluateOutput> {
  // 非推奨警告を作成・ログ出力
  const deprecationWarning = createLowUsageToolDeprecationWarning('quality.batch_evaluate');
  logDeprecationWarning(deprecationWarning);

  if (isDevelopment()) {
    logger.info('[MCP Tool] quality.batch_evaluate called', {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: BatchQualityEvaluateInput;
  try {
    validated = batchQualityEvaluateInputSchema.parse(input);
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] quality.batch_evaluate validation error', { error });
    }
    return {
      success: false,
      error: {
        code: QUALITY_MCP_ERROR_CODES.VALIDATION_ERROR,
        message: error instanceof Error ? error.message : 'Invalid input',
      },
    };
  }

  // サービスファクトリーチェック（オプション）
  // サービスが設定されていなくても、HTMLで直接指定されたアイテムは評価可能
  const hasPageIdItems = validated.items.some((item) => item.pageId !== undefined);
  if (hasPageIdItems && !serviceFactory) {
    if (isDevelopment()) {
      logger.warn('[MCP Tool] quality.batch_evaluate service factory not set, pageId items will be skipped');
    }
  }

  try {
    // ジョブIDを生成
    const jobId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // アイテムを変換（indexを追加）
    // exactOptionalPropertyTypes対応: undefinedを除外
    const items: BatchQualityItem[] = validated.items.map((item, index) => {
      const result: BatchQualityItem = { index };
      if (item.pageId !== undefined) {
        result.pageId = item.pageId;
      }
      if (item.html !== undefined) {
        result.html = item.html;
      }
      return result;
    });

    // Redis利用可能かチェック
    const redisAvailable = await isRedisAvailable();

    let queueUsed = false;

    if (redisAvailable) {
      // BullMQキューにジョブを追加
      const queue = createBatchQualityQueue();
      try {
        // exactOptionalPropertyTypes対応: undefinedを除外
        const jobData: Omit<BatchQualityJobData, 'createdAt'> = {
          jobId,
          items,
          batchSize: validated.batch_size,
          onError: validated.on_error,
          strict: validated.strict,
        };
        if (validated.weights !== undefined) {
          jobData.weights = validated.weights;
        }
        await addBatchQualityJob(queue, jobData);
        queueUsed = true;

        if (isDevelopment()) {
          logger.info('[MCP Tool] quality.batch_evaluate job added to BullMQ queue', {
            jobId,
            totalItems: validated.items.length,
          });
        }
      } finally {
        await closeBatchQualityQueue(queue);
      }
    }

    // ジョブステータスを初期化してLRUストアにも保存（フォールバック時やステータス確認用）
    const jobStatus: BatchQualityJobStatus = {
      job_id: jobId,
      status: 'pending',
      total_items: validated.items.length,
      processed_items: 0,
      success_items: 0,
      failed_items: 0,
      progress_percent: 0,
      created_at: createdAt,
    };

    batchJobStore.set(jobId, jobStatus);

    // Redis未接続時は同期処理を開始（バックグラウンドで実行）
    if (!queueUsed) {
      if (isDevelopment()) {
        logger.info('[MCP Tool] quality.batch_evaluate falling back to LRU store (Redis unavailable)', {
          jobId,
          totalItems: validated.items.length,
        });
      }

      // 非同期で処理を開始（awaitしない）
      processJobSync(jobId, items, {
        batchSize: validated.batch_size,
        onError: validated.on_error,
        weights: validated.weights,
        strict: validated.strict,
      }).catch((error) => {
        logger.error('[MCP Tool] quality.batch_evaluate sync processing error', {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (isDevelopment()) {
      logger.info('[MCP Tool] quality.batch_evaluate job created', {
        jobId,
        totalItems: validated.items.length,
        batchSize: validated.batch_size,
        onError: validated.on_error,
        queueUsed,
      });
    }

    // 非推奨警告をラップしてレスポンス
    const responseData = {
      job_id: jobId,
      status: 'pending' as const,
      total_items: validated.items.length,
      batch_size: validated.batch_size,
      on_error: validated.on_error,
      created_at: createdAt,
      message: `バッチ評価ジョブを開始しました。${validated.items.length}件のページを${validated.batch_size}件ずつ評価します。${queueUsed ? '(Redis/BullMQ)' : '(LRUストア)'}`,
    };

    return {
      success: true,
      data: responseData,
      deprecation_warning: deprecationWarning,
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] quality.batch_evaluate error', { error });
    }
    return {
      success: false,
      error: {
        code: QUALITY_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Batch evaluation failed',
      },
    };
  }
}

// =====================================================
// ツール定義
// =====================================================

export const batchQualityEvaluateToolDefinition = {
  name: 'quality.batch_evaluate',
  description:
    '[DEPRECATED v0.1.0] 複数ページの品質を一括評価します。最大100件まで対応。' +
    'バックグラウンドで処理され、ジョブIDで進捗確認できます。Use Loop with quality.evaluate instead.',
  deprecated: true,
  annotations: {
    title: 'Quality Batch Evaluate',
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      items: {
        type: 'array',
        description: '評価するアイテムの配列（1-100件）',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          properties: {
            pageId: {
              type: 'string',
              format: 'uuid',
              description: 'ページID（UUID形式、htmlと排他）',
            },
            html: {
              type: 'string',
              minLength: 1,
              maxLength: 10000000,
              description: 'HTMLコンテンツ（直接指定、pageIdと排他）',
            },
          },
        },
      },
      batch_size: {
        type: 'integer',
        description: 'バッチサイズ（1-50、デフォルト10）',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      on_error: {
        type: 'string',
        enum: ['skip', 'abort'],
        description: 'エラー時の動作（skip: スキップして続行、abort: 中止）',
        default: 'skip',
      },
      weights: {
        type: 'object',
        description: '評価軸の重み付け（合計1.0）',
        properties: {
          originality: { type: 'number', minimum: 0, maximum: 1 },
          craftsmanship: { type: 'number', minimum: 0, maximum: 1 },
          contextuality: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
      strict: {
        type: 'boolean',
        description: 'strictモード: AIクリシェに厳しい（デフォルトfalse）',
        default: false,
      },
    },
    required: ['items'],
  },
};

// =====================================================
// 開発環境ログ
// =====================================================

if (isDevelopment()) {
  logger.debug('[quality.batch_evaluate] Tool module loaded');
}
