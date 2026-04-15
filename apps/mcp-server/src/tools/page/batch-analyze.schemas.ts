// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.batch_analyze / page.getBatchStatus MCPツールのスキーマ定義
 * Batch API for multi-URL analysis
 *
 * @module @reftrixmcp/mcp-server/tools/page/batch-analyze.schemas
 */
import { z } from "zod";

// ============================================================================
// Error Codes
// ============================================================================

/** page.batch_analyze エラーコード / Error codes */
export const BATCH_ANALYZE_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SSRF_BLOCKED: "SSRF_BLOCKED",
  REDIS_UNAVAILABLE: "REDIS_UNAVAILABLE",
  BATCH_LIMIT_EXCEEDED: "BATCH_LIMIT_EXCEEDED",
  BATCH_ALREADY_RUNNING: "BATCH_ALREADY_RUNNING",
  BATCH_TIMEOUT: "BATCH_TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type BatchAnalyzeErrorCode =
  (typeof BATCH_ANALYZE_ERROR_CODES)[keyof typeof BATCH_ANALYZE_ERROR_CODES];

/** page.getBatchStatus エラーコード / Error codes */
export const GET_BATCH_STATUS_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  REDIS_UNAVAILABLE: "REDIS_UNAVAILABLE",
  BATCH_NOT_FOUND: "BATCH_NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type GetBatchStatusErrorCode =
  (typeof GET_BATCH_STATUS_ERROR_CODES)[keyof typeof GET_BATCH_STATUS_ERROR_CODES];

// ============================================================================
// Constants
// ============================================================================

/** バッチ最大URL数 / Max URLs per batch */
export const BATCH_MAX_URLS = 50;

/** バッチ最大同時実行数 / Max concurrency within batch */
export const BATCH_MAX_CONCURRENCY = 5;

/** バッチデフォルト同時実行数 / Default concurrency */
export const BATCH_DEFAULT_CONCURRENCY = 3;

/** バッチデフォルトタイムアウト（ms）— 30分 / Default batch timeout — 30 min */
export const BATCH_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** バッチキュー名 / Batch queue name */
export const BATCH_ANALYZE_QUEUE_NAME = "page-batch-analyze";

/** バッチジョブのRedisキープレフィックス / Redis key prefix for batch tracking */
export const BATCH_KEY_PREFIX = "reftrix:batch:";

/**
 * バッチメタデータ型（Redis保存用）/ Batch metadata type (stored in Redis)
 */
export interface BatchMetadata {
  jobIds: string[];
  urls: string[];
  skippedUrls: Array<{ url: string; reason: string }>;
  concurrency: number;
  timeout: number;
  onError: "skip" | "abort";
  startedAt: string;
  completedAt?: string;
  state: "waiting" | "active" | "completed" | "failed" | "partial";
  webPageIds: string[];
}

// ============================================================================
// Input Schemas
// ============================================================================

/**
 * page.batch_analyze 入力スキーマ
 * Batch analysis input schema
 */
export const batchAnalyzeInputSchema = z.object({
  /** 分析対象URL一覧 (1-50) / Target URLs (1-50) */
  urls: z
    .array(z.string().url())
    .min(1, "At least 1 URL is required")
    .max(BATCH_MAX_URLS, `Maximum ${BATCH_MAX_URLS} URLs allowed per batch`),

  /** バッチ内並列数 (1-5, default: 3) / Concurrency within batch */
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(BATCH_MAX_CONCURRENCY)
    .optional()
    .default(BATCH_DEFAULT_CONCURRENCY),

  /** バッチ全体タイムアウト (ms, default: 30分) / Batch-level timeout */
  timeout: z
    .number()
    .int()
    .min(60000)
    .max(60 * 60 * 1000)
    .optional()
    .default(BATCH_DEFAULT_TIMEOUT_MS),

  /** 全URL共通の分析オプション / Shared analysis options */
  features: z
    .object({
      layout: z.boolean().optional().default(true),
      motion: z.boolean().optional().default(true),
      quality: z.boolean().optional().default(true),
    })
    .optional()
    .default({ layout: true, motion: true, quality: true }),

  /** 全URL共通のレイアウトオプション / Shared layout options */
  layoutOptions: z
    .object({
      useVision: z.boolean().optional().default(true),
      saveToDb: z.boolean().optional().default(true),
      fullPage: z.boolean().optional().default(true),
      viewport: z
        .object({
          width: z.number().int().min(320).max(4096).optional().default(1440),
          height: z.number().int().min(240).max(16384).optional().default(900),
        })
        .optional(),
    })
    .optional(),

  /** robots.txt尊重 (default: true) / Respect robots.txt */
  respect_robots_txt: z.boolean().optional().default(true),

  /** 子ジョブ失敗時の動作 / Behavior on child job failure */
  on_error: z.enum(["skip", "abort"]).optional().default("skip"),
});

export type BatchAnalyzeInput = z.infer<typeof batchAnalyzeInputSchema>;

/**
 * page.getBatchStatus 入力スキーマ
 * Batch status query input schema
 */
export const getBatchStatusInputSchema = z.object({
  /** バッチジョブID / Batch job ID */
  batch_id: z.string().min(1, "batch_id is required"),
});

export type GetBatchStatusInput = z.infer<typeof getBatchStatusInputSchema>;

// ============================================================================
// Output Schemas
// ============================================================================

/** 個別ジョブ結果 / Individual job result */
export const batchJobItemSchema = z.object({
  /** URL */
  url: z.string(),
  /** ジョブID / Job ID */
  jobId: z.string(),
  /** ジョブ状態 / Job state */
  state: z.enum(["waiting", "active", "completed", "failed", "skipped"]),
  /** WebPage ID（成功時）/ WebPage ID (on success) */
  webPageId: z.string().optional(),
  /** エラーメッセージ（失敗時）/ Error message (on failure) */
  error: z.string().optional(),
  /** 処理時間（ms）/ Processing time */
  processingTimeMs: z.number().optional(),
});

export type BatchJobItem = z.infer<typeof batchJobItemSchema>;

/** バッチサマリー / Batch summary */
export const batchSummarySchema = z.object({
  /** 総URL数 / Total URL count */
  total: z.number(),
  /** 完了数 / Completed count */
  completed: z.number(),
  /** 失敗数 / Failed count */
  failed: z.number(),
  /** スキップ数（SSRF等）/ Skipped count (SSRF, etc.) */
  skipped: z.number(),
  /** 進行中 / Active count */
  active: z.number(),
  /** 待機中 / Waiting count */
  waiting: z.number(),
});

export type BatchSummary = z.infer<typeof batchSummarySchema>;

/** page.batch_analyze 非同期出力 / Async output */
export const batchAnalyzeAsyncOutputSchema = z.object({
  success: z.literal(true),
  data: z.object({
    /** バッチジョブID / Batch job ID */
    batchId: z.string(),
    /** 投入URL数 / Submitted URL count */
    totalUrls: z.number(),
    /** SSRF検証でスキップされたURL数 / Skipped by SSRF validation */
    skippedUrls: z.number(),
    /** 投入されたジョブID一覧 / Submitted job IDs */
    jobIds: z.array(z.string()),
    /** メッセージ / Message */
    message: z.string(),
  }),
  metadata: z.record(z.unknown()).optional(),
});

export type BatchAnalyzeAsyncOutput = z.infer<typeof batchAnalyzeAsyncOutputSchema>;

/** page.batch_analyze エラー出力 / Error output */
export const batchAnalyzeErrorOutputSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  metadata: z.record(z.unknown()).optional(),
});

export type BatchAnalyzeErrorOutput = z.infer<typeof batchAnalyzeErrorOutputSchema>;

/** page.batch_analyze 出力（Union）/ Combined output */
export type BatchAnalyzeOutput = BatchAnalyzeAsyncOutput | BatchAnalyzeErrorOutput;

/** page.getBatchStatus 出力 / Batch status output */
export const getBatchStatusOutputSchema = z.object({
  success: z.literal(true),
  data: z.object({
    /** バッチジョブID / Batch job ID */
    batchId: z.string(),
    /** バッチ状態 / Batch state */
    state: z.enum(["waiting", "active", "completed", "failed", "partial"]),
    /** 進捗率 (0-100) / Progress percentage */
    progress: z.number().min(0).max(100),
    /** サマリー / Summary */
    summary: batchSummarySchema,
    /** 個別ジョブ結果 / Individual job results */
    jobs: z.array(batchJobItemSchema),
    /** 開始時刻 / Started at */
    startedAt: z.string().optional(),
    /** 完了時刻 / Completed at */
    completedAt: z.string().optional(),
    /** 経過時間（ms）/ Elapsed time */
    elapsedMs: z.number().optional(),
  }),
  metadata: z.record(z.unknown()).optional(),
});

export type GetBatchStatusOutput = z.infer<typeof getBatchStatusOutputSchema>;

/** page.getBatchStatus エラー出力 / Error output */
export type GetBatchStatusErrorOutput = {
  success: false;
  error: { code: string; message: string };
  metadata?: Record<string, unknown>;
};

/** page.getBatchStatus 統合出力 / Combined output */
export type GetBatchStatusCombinedOutput = GetBatchStatusOutput | GetBatchStatusErrorOutput;
