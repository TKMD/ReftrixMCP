// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.* MCP Tools
 * Webデザインレイアウト解析ツールのエントリポイント
 *
 * @module @reftrix/mcp-server/tools/layout
 */

// スキーマ定義のエクスポート
export * from './schemas';

// layout.ingest ツールのエクスポート
export {
  layoutIngestHandler,
  layoutIngestToolDefinition,
  setLayoutIngestServiceFactory,
  resetLayoutIngestServiceFactory,
  type LayoutIngestInput,
  type LayoutIngestOutput,
  type ILayoutIngestService,
} from './ingest.tool';

// layout.search ツールのエクスポート
export {
  layoutSearchHandler,
  layoutSearchToolDefinition,
  setLayoutSearchServiceFactory,
  resetLayoutSearchServiceFactory,
  preprocessQuery,
  type LayoutSearchInput,
  type LayoutSearchOutput,
  type ILayoutSearchService,
} from './search.tool';

// layout.generate_code ツールのエクスポート (v0.1.0 リネーム)
export {
  // 新しいプライマリエクスポート
  layoutGenerateCodeHandler,
  layoutGenerateCodeToolDefinition,
  // 後方互換性のための旧名エイリアス
  layoutToCodeHandler,
  layoutToCodeToolDefinition,
  // サービスファクトリー
  setLayoutToCodeServiceFactory,
  resetLayoutToCodeServiceFactory,
  // 型定義
  type LayoutToCodeInput,
  type LayoutToCodeOutput,
  type ILayoutToCodeService,
  type SectionPattern,
  type GeneratedCode,
  type CodeGeneratorOptions,
} from './to-code.tool';

// layout.inspect ツールのエクスポート
export {
  layoutInspectHandler,
  layoutInspectToolDefinition,
  setLayoutInspectServiceFactory,
  resetLayoutInspectServiceFactory,
  type ILayoutInspectService,
} from './inspect';

// layout.batch_ingest ツールのエクスポート
export {
  layoutBatchIngestHandler,
  layoutBatchIngestToolDefinition,
  type LayoutBatchIngestInput,
  type LayoutBatchIngestOutput,
} from './batch-ingest.tool';
