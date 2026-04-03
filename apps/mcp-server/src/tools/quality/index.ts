// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.* MCP Tools
 * Webデザイン品質評価ツールのエントリポイント
 *
 * @module @reftrixmcp/mcp-server/tools/quality
 */

// スキーマ定義のエクスポート
export * from "./schemas";

// quality.evaluate ツールのエクスポート
export {
  qualityEvaluateHandler,
  qualityEvaluateToolDefinition,
  setQualityEvaluateServiceFactory,
  resetQualityEvaluateServiceFactory,
  type QualityEvaluateInput,
  type QualityEvaluateOutput,
  type IQualityEvaluateService,
} from "./evaluate.tool";

// [DELETED v0.1.0] quality.suggest_improvements は quality.evaluate に統合されました
// [REMOVED v0.3.0] quality.batch_evaluate / quality.getJobStatus — deprecated since v0.1.0, removed in v0.3.0
