// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * performance.* MCP Tools
 * パフォーマンス評価ツールのエントリポイント
 *
 * @module @reftrixmcp/mcp-server/tools/performance
 */

export {
  performanceEvaluateHandler,
  performanceEvaluateToolDefinition,
  performanceEvaluateInputSchema,
  setCoreWebVitalsServiceFactory,
  resetCoreWebVitalsServiceFactory,
  setPerformanceEvaluationServiceFactory,
  resetPerformanceEvaluationServiceFactory,
  PERFORMANCE_MCP_ERROR_CODES,
  type PerformanceEvaluateInput,
  type PerformanceEvaluateOutput,
  type PerformanceMcpErrorCode,
} from "./evaluate.tool";
