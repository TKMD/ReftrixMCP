// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Tools Export
 * WebDesign専用ツールハンドラーとツール定義のエクスポート
 *
 * Total: 19 tools
 * - Style: style.get_palette
 * - System: system.health
 * - Layout: layout.inspect, layout.ingest, layout.search, layout.generate_code, layout.batch_ingest
 * - Quality: quality.evaluate, quality.batch_evaluate, quality.getJobStatus
 * - Motion: motion.detect, motion.search
 * - Brief: brief.validate
 * - Project: project.get, project.list
 * - Page: page.analyze, page.getJobStatus
 * - Narrative: narrative.search
 * - Background: background.search
 */

// style系スキーマのエクスポート（style.get_palette用）
export {
  styleGetPaletteInputSchema,
  paletteModeSchema,
  type StyleGetPaletteInput,
} from './schemas/style-schemas';

// style.get_palette ツール（MCP Creative Tools）
export {
  styleGetPaletteHandler,
  styleGetPaletteToolDefinition,
} from './style-get-palette';

// system.health ツール（MCPサーバーヘルスチェック）
export {
  systemHealthHandler,
  systemHealthToolDefinition,
  type SystemHealthResponse,
} from './system-health';

// layout.inspect ツール（Phase 2-4 Webページレイアウト解析）
export {
  layoutInspectHandler,
  layoutInspectToolDefinition,
  layoutInspectInputSchema,
  layoutInspectOutputSchema,
  setLayoutInspectServiceFactory,
  resetLayoutInspectServiceFactory,
  type LayoutInspectInput,
  type LayoutInspectOutput,
  type SectionType,
  type SectionInfo,
  type ColorPaletteInfo,
  type TypographyInfo,
  type GridInfo,
} from './layout/inspect';

// layout.ingest ツール（Phase 2-1 Webページインジェスト）
export {
  layoutIngestHandler,
  layoutIngestToolDefinition,
} from './layout/ingest.tool';

// layout.search ツール（Phase 2-5 レイアウトセマンティック検索）
export {
  layoutSearchHandler,
  layoutSearchToolDefinition,
  setLayoutSearchServiceFactory,
  resetLayoutSearchServiceFactory,
  type ILayoutSearchService,
  type LayoutSearchInput,
  type LayoutSearchOutput,
} from './layout/search.tool';

// layout.generate_code ツール（Phase 2-6 レイアウトコード生成）
// v0.1.0: layout.to_code から layout.generate_code にリネーム
export {
  layoutGenerateCodeHandler,
  layoutGenerateCodeToolDefinition,
  // 後方互換性のためのエイリアス（非推奨）
  layoutToCodeHandler,
  layoutToCodeToolDefinition,
  setLayoutToCodeServiceFactory,
  resetLayoutToCodeServiceFactory,
  type ILayoutToCodeService,
  type LayoutToCodeInput,
  type LayoutToCodeOutput,
} from './layout/to-code.tool';

// layout.batch_ingest ツール（Phase 2-7 バッチインジェスト）
export {
  layoutBatchIngestHandler,
  layoutBatchIngestToolDefinition,
  type LayoutBatchIngestInput,
  type LayoutBatchIngestOutput,
} from './layout/batch-ingest.tool';

// quality.evaluate ツール（Phase 3-3 品質評価）
export {
  qualityEvaluateHandler,
  qualityEvaluateToolDefinition,
  setQualityEvaluateServiceFactory,
  resetQualityEvaluateServiceFactory,
  type IQualityEvaluateService,
} from './quality/evaluate.tool';

// [DELETED v0.1.0] quality.suggest_improvements は quality.evaluate に統合されました

// quality.batch_evaluate ツール（Phase 3-5 一括品質評価）
export {
  batchQualityEvaluateHandler,
  batchQualityEvaluateToolDefinition,
  setBatchQualityEvaluateServiceFactory,
  resetBatchQualityEvaluateServiceFactory,
  clearBatchJobStore,
  addBatchJob,
  getBatchJob,
  getJobStoreStats,
  type IBatchQualityEvaluateService,
  type BatchQualityEvaluateInput,
  type BatchQualityEvaluateOutput,
  type BatchQualityJobStatus,
} from './quality/batch-evaluate.tool';

// quality.getJobStatus ツール（Phase 3-5 一括評価ジョブステータス確認）
export {
  qualityGetJobStatusHandler,
  qualityGetJobStatusToolDefinition,
  GET_QUALITY_JOB_STATUS_ERROR_CODES,
  type QualityGetJobStatusInput,
  type QualityGetJobStatusOutput,
} from './quality/get-job-status.tool';

// motion.detect ツール（Phase 3-6 モーション検出）
export {
  motionDetectHandler,
  motionDetectToolDefinition,
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
  type IMotionDetectService,
} from './motion/detect.tool';

// motion.search ツール（Phase 3-6 モーション検索）
export {
  motionSearchHandler,
  motionSearchToolDefinition,
  setMotionSearchServiceFactory,
  resetMotionSearchServiceFactory,
  type IMotionSearchService,
  type MotionSearchInput,
  type MotionSearchOutput,
} from './motion/search.tool';

// [DELETED v0.1.0] motion.get_implementation は motion.search に統合されました

// quality.* スキーマのエクスポート
export {
  qualityEvaluateInputSchema,
  qualityEvaluateOutputSchema,
  weightsSchema,
  gradeSchema,
  axisScoreSchema,
  clicheDetectionSchema,
  recommendationSchema,
  qualityEvaluateDataSchema,
  scoreToGrade,
  calculateWeightedScore,
  QUALITY_MCP_ERROR_CODES,
  type QualityEvaluateInput,
  type QualityEvaluateOutput,
  type QualityEvaluateData,
  type Weights,
  type Grade,
  type AxisScore,
  type ClicheDetection,
  type Recommendation,
  type QualityMcpErrorCode,
} from './quality/schemas';

// motion.* スキーマのエクスポート
export {
  motionDetectInputSchema,
  motionDetectOutputSchema,
  motionPatternSchema,
  motionSummarySchema,
  motionWarningSchema,
  motionTypeSchema,
  motionCategorySchema,
  triggerTypeSchema,
  easingTypeSchema as motionEasingTypeSchema,
  easingConfigSchema,
  animatedPropertySchema,
  performanceInfoSchema,
  accessibilityInfoSchema,
  calculatePerformanceLevel,
  calculateComplexityScore,
  calculateAverageDuration,
  countByType,
  countByTrigger,
  countByCategory,
  MOTION_MCP_ERROR_CODES,
  MOTION_WARNING_CODES,
  type MotionDetectInput,
  type MotionDetectOutput,
  type MotionPattern,
  type MotionType,
  type MotionCategory,
  type TriggerType,
  type EasingType as MotionEasingType,
  type EasingConfig,
  type AnimatedProperty,
  type PerformanceInfo,
  type MotionSummary,
  type MotionWarning,
  type MotionMcpErrorCode,
  type MotionWarningCode,
} from './motion/schemas';

// layout.* スキーマのエクスポート
export {
  // layout.ingest スキーマ
  layoutIngestInputSchema,
  layoutIngestOutputSchema,
  layoutIngestDataSchema,
  layoutIngestSuccessOutputSchema,
  layoutIngestErrorOutputSchema,
  layoutIngestErrorInfoSchema,
  screenshotInfoSchema,
  pageMetadataOutputSchema,
  sourceInfoOutputSchema,
  // エラーコード
  LAYOUT_MCP_ERROR_CODES,
  // 型
  type LayoutIngestInput as LayoutIngestInputType,
  type LayoutIngestOutput as LayoutIngestOutputType,
  type LayoutIngestData,
  type LayoutIngestErrorInfo,
  type ScreenshotInfo,
  type PageMetadataOutput,
  type SourceInfoOutput,
  type LayoutMcpErrorCode,
} from './layout/schemas';

// brief.* スキーマのエクスポート（Phase 4 Design Brief）
export {
  // Enum schemas
  toneSchema,
  issueSeveritySchema,
  // Base schemas
  hexColorSchema as briefHexColorSchema,
  colorPreferencesSchema,
  referenceSchema,
  constraintsSchema,
  // Input schemas
  briefSchema,
  briefValidateInputSchema,
  // Output schemas
  briefIssueSchema,
  briefValidationResultSchema,
  briefValidateErrorSchema,
  briefValidateSuccessOutputSchema,
  briefValidateErrorOutputSchema,
  briefValidateOutputSchema,
  // Error codes
  BRIEF_MCP_ERROR_CODES,
  // MCP Tool definitions
  briefMcpTools,
  // Types
  type Tone,
  type IssueSeverity,
  type HexColor as BriefHexColor,
  type ColorPreferences,
  type Reference,
  type Constraints,
  type Brief,
  type BriefValidateInput,
  type BriefIssue,
  type BriefValidationResult,
  type BriefValidateError,
  type BriefValidateOutput,
  type BriefMcpErrorCode,
  type BriefMcpToolName,
} from './brief';

// brief.validate ツール（Phase 4-3 Design Brief Validation）
export {
  briefValidateHandler,
  briefValidateToolDefinition,
  setBriefValidateServiceFactory,
  resetBriefValidateServiceFactory,
  type IBriefValidateServiceFactory,
} from './brief';

// project.get ツール（Studio プロジェクト取得）
export {
  projectGetHandler,
  projectGetToolDefinition,
} from './project-get';

// project.list ツール（Studio プロジェクト一覧）
export {
  projectListHandler,
  projectListToolDefinition,
} from './project-list';

// page.analyze ツール（統合Web分析）
export {
  pageAnalyzeHandler,
  pageAnalyzeToolDefinition,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
  type IPageAnalyzeService,
  type PageAnalyzeInput,
  type PageAnalyzeOutput,
} from './page';

// page.getJobStatus ツール（非同期ジョブステータス確認 Phase3-2）
export {
  pageGetJobStatusHandler,
  pageGetJobStatusToolDefinition,
  GET_JOB_STATUS_ERROR_CODES,
} from './page';

// narrative.search ツール（世界観・レイアウト構成セマンティック検索）
export {
  narrativeSearchHandler,
  narrativeSearchToolDefinition,
  setNarrativeSearchServiceFactory,
  resetNarrativeSearchServiceFactory,
} from './narrative/search.tool';

// background.search ツール（BackgroundDesignセマンティック検索）
export {
  backgroundSearchHandler,
  backgroundSearchToolDefinition,
  setBackgroundSearchServiceFactory,
  resetBackgroundSearchServiceFactory,
  type IBackgroundSearchService,
  type BackgroundSearchInput,
  type BackgroundSearchOutput,
  type BackgroundSearchResultItem,
} from './background/search.tool';

// background.* スキーマのエクスポート
export {
  backgroundSearchInputSchema,
  backgroundDesignTypeSchema,
  BACKGROUND_MCP_ERROR_CODES,
  type BackgroundDesignType,
  type BackgroundMcpErrorCode,
} from './background/schemas';

// project.* スキーマのエクスポート
export {
  // project.get スキーマ
  projectGetInputSchema,
  projectGetOutputSchema,
  projectGetSummaryOutputSchema,
  brandSettingInfoSchema,
  type ProjectGetInput,
  type ProjectGetOutput,
  type ProjectGetSummaryOutput,
  type BrandSettingInfo,
  // project.list スキーマ
  projectListInputSchema,
  projectListOutputSchema,
  projectListSummaryOutputSchema,
  projectListItemSchema,
  projectListItemSummarySchema,
  projectStatusSchema,
  projectSortBySchema,
  projectSortOrderSchema,
  type ProjectListInput,
  type ProjectListOutput,
  type ProjectListSummaryOutput,
  type ProjectListItem,
  type ProjectListItemSummary,
  type ProjectStatus,
  type ProjectSortBy,
  type ProjectSortOrder,
} from './schemas/project-schemas';

/**
 * 全ツール定義の配列
 * MCP Server初期化時に使用
 */
import { styleGetPaletteToolDefinition } from './style-get-palette';
import { systemHealthToolDefinition } from './system-health';
import { layoutInspectToolDefinition } from './layout/inspect';
import { layoutIngestToolDefinition } from './layout/ingest.tool';
import { layoutSearchToolDefinition } from './layout/search.tool';
import { layoutGenerateCodeToolDefinition } from './layout/to-code.tool';
import { layoutBatchIngestToolDefinition } from './layout/batch-ingest.tool';
import { qualityEvaluateToolDefinition } from './quality/evaluate.tool';
import { batchQualityEvaluateToolDefinition } from './quality/batch-evaluate.tool';
import { qualityGetJobStatusToolDefinition } from './quality/get-job-status.tool';
import { motionDetectToolDefinition } from './motion/detect.tool';
import { motionSearchToolDefinition } from './motion/search.tool';
import { briefValidateToolDefinition } from './brief';
import { projectGetToolDefinition } from './project-get';
import { projectListToolDefinition } from './project-list';
import { pageAnalyzeToolDefinition, pageGetJobStatusToolDefinition } from './page';
import { narrativeSearchToolDefinition } from './narrative/search.tool';
import { backgroundSearchToolDefinition } from './background/search.tool';

export const allToolDefinitions = [
  // style.get_palette（ブランドパレット取得）
  styleGetPaletteToolDefinition,
  // system.health（MCPサーバーヘルスチェック）
  systemHealthToolDefinition,
  // layout.inspect（Phase 2-4 Webページレイアウト解析）
  layoutInspectToolDefinition,
  // layout.ingest（Phase 2-1 Webページインジェスト）
  layoutIngestToolDefinition,
  // layout.search（Phase 2-5 レイアウトセマンティック検索）
  layoutSearchToolDefinition,
  // layout.generate_code（Phase 2-6 レイアウトコード生成）
  // v0.1.0: layout.to_code から layout.generate_code にリネーム
  layoutGenerateCodeToolDefinition,
  // layout.batch_ingest（Phase 2-7 バッチインジェスト）
  layoutBatchIngestToolDefinition,
  // quality.evaluate（Phase 3-3 品質評価）
  qualityEvaluateToolDefinition,
  // quality.batch_evaluate（Phase 3-5 一括品質評価）
  batchQualityEvaluateToolDefinition,
  // quality.getJobStatus（Phase 3-5 一括評価ジョブステータス確認）
  qualityGetJobStatusToolDefinition,
  // motion.detect（Phase 3-6 モーション検出）
  motionDetectToolDefinition,
  // motion.search（Phase 3-6 モーション検索）
  motionSearchToolDefinition,
  // brief.validate（Phase 4-3 Design Brief Validation）
  briefValidateToolDefinition,
  // project.get（Studio プロジェクト取得）
  projectGetToolDefinition,
  // project.list（Studio プロジェクト一覧）
  projectListToolDefinition,
  // page.analyze（統合Web分析）
  pageAnalyzeToolDefinition,
  // page.getJobStatus（非同期ジョブステータス確認 Phase3-2）
  pageGetJobStatusToolDefinition,
  // narrative.search（世界観・レイアウト構成セマンティック検索）
  narrativeSearchToolDefinition,
  // background.search（BackgroundDesignセマンティック検索）
  backgroundSearchToolDefinition,
];

/**
 * ツール名からハンドラーを取得するマップ
 */
import { styleGetPaletteHandler } from './style-get-palette';
import { systemHealthHandler } from './system-health';
import { layoutInspectHandler } from './layout/inspect';
import { layoutIngestHandler } from './layout/ingest.tool';
import { layoutSearchHandler } from './layout/search.tool';
import { layoutGenerateCodeHandler } from './layout/to-code.tool';
import { layoutBatchIngestHandler } from './layout/batch-ingest.tool';
import { qualityEvaluateHandler } from './quality/evaluate.tool';
import { batchQualityEvaluateHandler } from './quality/batch-evaluate.tool';
import { qualityGetJobStatusHandler } from './quality/get-job-status.tool';
import { motionDetectHandler } from './motion/detect.tool';
import { motionSearchHandler } from './motion/search.tool';
import { briefValidateHandler } from './brief';
import { projectGetHandler } from './project-get';
import { projectListHandler } from './project-list';
import { pageAnalyzeHandler, pageGetJobStatusHandler } from './page';
import { narrativeSearchHandler } from './narrative/search.tool';
import { backgroundSearchHandler } from './background/search.tool';

export const toolHandlers: Record<
  string,
  (input: unknown) => Promise<unknown>
> = {
  // style.get_palette（ブランドパレット取得）
  'style.get_palette': styleGetPaletteHandler,
  // system.health（MCPサーバーヘルスチェック）
  'system.health': systemHealthHandler,
  // layout.inspect（Phase 2-4 Webページレイアウト解析）
  'layout.inspect': layoutInspectHandler,
  // layout.ingest（Phase 2-1 Webページインジェスト）
  'layout.ingest': layoutIngestHandler,
  // layout.search（Phase 2-5 レイアウトセマンティック検索）
  'layout.search': layoutSearchHandler,
  // layout.generate_code（Phase 2-6 レイアウトコード生成）
  // v0.1.0: layout.to_code から layout.generate_code にリネーム
  'layout.generate_code': layoutGenerateCodeHandler,
  // layout.batch_ingest（Phase 2-7 バッチインジェスト）
  'layout.batch_ingest': layoutBatchIngestHandler,
  // quality.evaluate（Phase 3-3 品質評価）
  'quality.evaluate': qualityEvaluateHandler,
  // quality.batch_evaluate（Phase 3-5 一括品質評価）
  'quality.batch_evaluate': batchQualityEvaluateHandler,
  // quality.getJobStatus（Phase 3-5 一括評価ジョブステータス確認）
  'quality.getJobStatus': qualityGetJobStatusHandler,
  // motion.detect（Phase 3-6 モーション検出）
  'motion.detect': motionDetectHandler,
  // motion.search（Phase 3-6 モーション検索）
  'motion.search': motionSearchHandler,
  // brief.validate（Phase 4-3 Design Brief Validation）
  'brief.validate': briefValidateHandler,
  // project.get（Studio プロジェクト取得）
  'project.get': projectGetHandler,
  // project.list（Studio プロジェクト一覧）
  'project.list': projectListHandler,
  // page.analyze（統合Web分析）
  'page.analyze': pageAnalyzeHandler,
  // page.getJobStatus（非同期ジョブステータス確認 Phase3-2）
  'page.getJobStatus': pageGetJobStatusHandler,
  // narrative.search（世界観・レイアウト構成セマンティック検索）
  'narrative.search': narrativeSearchHandler,
  // background.search（BackgroundDesignセマンティック検索）
  'background.search': backgroundSearchHandler,
};

/**
 * ツール定義の型
 */
export type ToolDefinition = (typeof allToolDefinitions)[number];

/**
 * ツール名からツール定義を取得
 */
export function getToolDefinition(toolName: string): ToolDefinition | undefined {
  return allToolDefinitions.find((tool) => tool.name === toolName);
}

/**
 * ツール名からハンドラーを取得
 */
export function getToolHandler(
  toolName: string
): ((input: unknown) => Promise<unknown>) | undefined {
  return toolHandlers[toolName];
}

// =====================================================
// ツール定義一致チェック（MCP-SSoT-02）
// =====================================================

/**
 * ツール定義とハンドラーの一致チェック結果
 *
 * @property isConsistent - 一致しているかどうか
 * @property definedTools - allToolDefinitionsで定義されているツール名
 * @property handlerTools - toolHandlersで定義されているツール名
 * @property missingHandlers - 定義あり、ハンドラなしのツール
 * @property extraHandlers - ハンドラあり、定義なしのツール
 */
export interface ToolConsistencyCheckResult {
  isConsistent: boolean;
  definedTools: string[];
  handlerTools: string[];
  missingHandlers: string[];
  extraHandlers: string[];
}

/**
 * ツール定義とハンドラーの一致をチェック
 *
 * allToolDefinitions と toolHandlers の間で不一致がないかを検証します。
 * 起動時に呼び出すことで、手動二重管理による登録漏れを防止します。
 *
 * @returns 一致チェック結果
 *
 * @example
 * ```typescript
 * const result = checkToolConsistency();
 * if (!result.isConsistent) {
 *   console.error('Missing handlers:', result.missingHandlers);
 *   console.error('Extra handlers:', result.extraHandlers);
 * }
 * ```
 */
export function checkToolConsistency(): ToolConsistencyCheckResult {
  const definedTools = allToolDefinitions.map((t) => t.name);
  const handlerTools = Object.keys(toolHandlers);

  const missingHandlers = definedTools.filter(
    (t) => !handlerTools.includes(t)
  );
  const extraHandlers = handlerTools.filter(
    (t) => !definedTools.includes(t)
  );

  return {
    isConsistent: missingHandlers.length === 0 && extraHandlers.length === 0,
    definedTools,
    handlerTools,
    missingHandlers,
    extraHandlers,
  };
}
