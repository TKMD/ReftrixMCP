// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.* MCP Tools
 * Webデザイン品質評価ツールのエントリポイント
 *
 * @module @reftrix/mcp-server/tools/quality
 */

// スキーマ定義のエクスポート
export * from './schemas';

// quality.evaluate ツールのエクスポート
export {
  qualityEvaluateHandler,
  qualityEvaluateToolDefinition,
  setQualityEvaluateServiceFactory,
  resetQualityEvaluateServiceFactory,
  type QualityEvaluateInput,
  type QualityEvaluateOutput,
  type IQualityEvaluateService,
} from './evaluate.tool';

// [DELETED v0.1.0] quality.suggest_improvements は quality.evaluate に統合されました

// quality.batch_evaluate ツールのエクスポート
export {
  batchQualityEvaluateHandler,
  batchQualityEvaluateToolDefinition,
  setBatchQualityEvaluateServiceFactory,
  resetBatchQualityEvaluateServiceFactory,
  clearBatchJobStore,
  addBatchJob,
  getBatchJob,
  type BatchQualityEvaluateInput,
  type BatchQualityEvaluateOutput,
  type BatchQualityJobStatus,
  type IBatchQualityEvaluateService,
} from './batch-evaluate.tool';

// quality.getJobStatus ツールのエクスポート
export {
  qualityGetJobStatusHandler,
  qualityGetJobStatusToolDefinition,
  GET_QUALITY_JOB_STATUS_ERROR_CODES,
  type QualityGetJobStatusInput,
  type QualityGetJobStatusOutput,
} from './get-job-status.tool';
