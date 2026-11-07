// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Tools Export
 * WebDesign専用ツールハンドラーとツール定義のエクスポート
 *
 * Total: 28 tools
 * - System: system.health
 * - Layout: layout.inspect, layout.ingest, layout.search, layout.generate_code
 * - Quality: quality.evaluate
 * - Motion: motion.detect, motion.search
 * - Page: page.analyze, page.getJobStatus (job_id | batch_id), page.batch_analyze
 * - Narrative: narrative.search
 * - Background: background.search
 * - Responsive: responsive.search, responsive.capture
 * - Part: part.search, part.inspect, part.compare
 * - Search: search.unified
 * - Design: design.search_by_image, design.similar_site, design.compare, design.verify_reproduction
 * - Data: data.delete, data.export
 * - Audit: audit.query
 * - Accessibility: accessibility.audit
 * - Performance: performance.evaluate
 */

// system.health ツール（MCPサーバーヘルスチェック）
export {
  systemHealthHandler,
  systemHealthToolDefinition,
  type SystemHealthResponse,
} from "./system-health";

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
} from "./layout/inspect";

// layout.ingest ツール（Phase 2-1 Webページインジェスト）
export { layoutIngestHandler, layoutIngestToolDefinition } from "./layout/ingest.tool";

// layout.search ツール（Phase 2-5 レイアウトセマンティック検索）
export {
  layoutSearchHandler,
  layoutSearchToolDefinition,
  setLayoutSearchServiceFactory,
  resetLayoutSearchServiceFactory,
  type ILayoutSearchService,
  type LayoutSearchInput,
  type LayoutSearchOutput,
} from "./layout/search.tool";

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
} from "./layout/to-code.tool";

// quality.evaluate ツール（Phase 3-3 品質評価）
export {
  qualityEvaluateHandler,
  qualityEvaluateToolDefinition,
  setQualityEvaluateServiceFactory,
  resetQualityEvaluateServiceFactory,
  type IQualityEvaluateService,
} from "./quality/evaluate.tool";

// [DELETED v0.1.0] quality.suggest_improvements は quality.evaluate に統合されました

// [REMOVED v0.3.0] quality.batch_evaluate / quality.getJobStatus — deprecated since v0.1.0, removed in v0.3.0

// motion.detect ツール（Phase 3-6 モーション検出）
export {
  motionDetectHandler,
  motionDetectToolDefinition,
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
  type IMotionDetectService,
} from "./motion/detect.tool";

// motion.search ツール（Phase 3-6 モーション検索）
export {
  motionSearchHandler,
  motionSearchToolDefinition,
  setMotionSearchServiceFactory,
  resetMotionSearchServiceFactory,
  type IMotionSearchService,
  type MotionSearchInput,
  type MotionSearchOutput,
} from "./motion/search.tool";

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
} from "./quality/schemas";

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
} from "./motion/schemas";

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
} from "./layout/schemas";

// [REMOVED v0.3.0] project.get / project.list — バックエンドAPI未実装のため削除
// project.get / project.list removed in v0.3.0 — backend API (localhost:24000) was never implemented. Source files deleted.

// page.analyze ツール（統合Web分析）
export {
  pageAnalyzeHandler,
  pageAnalyzeToolDefinition,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
  type IPageAnalyzeService,
  type PageAnalyzeInput,
  type PageAnalyzeOutput,
} from "./page";

// page.getJobStatus ツール（非同期ジョブステータス確認 Phase3-2）
export {
  pageGetJobStatusHandler,
  pageGetJobStatusToolDefinition,
  GET_JOB_STATUS_ERROR_CODES,
} from "./page";

// page.batch_analyze ツール（バッチ一括分析、v0.4.0）
export {
  pageBatchAnalyzeHandler,
  pageBatchAnalyzeToolDefinition,
  BATCH_ANALYZE_ERROR_CODES,
  type BatchAnalyzeInput,
  type BatchAnalyzeOutput,
} from "./page";

// page.getJobStatus の batch_id 経路（旧 page.getBatchStatus、2026-11-04 統合）
export {
  pageGetBatchStatusHandler,
  GET_BATCH_STATUS_ERROR_CODES,
  type GetBatchStatusInput,
  type GetBatchStatusCombinedOutput,
} from "./page";

// narrative.search ツール（世界観・レイアウト構成セマンティック検索）
export {
  narrativeSearchHandler,
  narrativeSearchToolDefinition,
  setNarrativeSearchServiceFactory,
  resetNarrativeSearchServiceFactory,
} from "./narrative/search.tool";

// background.search ツール（BackgroundDesignセマンティック検索）
export {
  backgroundSearchHandler,
  backgroundSearchToolDefinition,
  setBackgroundSearchServiceFactory,
  resetBackgroundSearchServiceFactory,
  setBackgroundSearchPrismaClientFactory,
  resetBackgroundSearchPrismaClientFactory,
  type IBackgroundSearchService,
  type BackgroundSearchInput,
  type BackgroundSearchOutput,
  type BackgroundSearchResultItem,
} from "./background/search.tool";

// background.* スキーマのエクスポート
export {
  backgroundSearchInputSchema,
  backgroundDesignTypeSchema,
  BACKGROUND_MCP_ERROR_CODES,
  type BackgroundDesignType,
  type BackgroundMcpErrorCode,
} from "./background/schemas";

// responsive.search ツール（レスポンシブ分析セマンティック検索）
export {
  responsiveSearchHandler,
  responsiveSearchToolDefinition,
  setResponsiveSearchServiceFactory,
  resetResponsiveSearchServiceFactory,
  setResponsiveSearchPrismaClientFactory,
  resetResponsiveSearchPrismaClientFactory,
  type IResponsiveSearchService,
  type ResponsiveSearchInput,
  type ResponsiveSearchOutput,
  type ResponsiveSearchResultItem,
} from "./responsive/search.tool";

// responsive.* スキーマのエクスポート
export {
  responsiveSearchInputSchema,
  responsiveDiffCategorySchema,
  viewportPairSchema,
  RESPONSIVE_MCP_ERROR_CODES,
  type ResponsiveDiffCategory,
  type ViewportPair,
  type ResponsiveMcpErrorCode,
} from "./responsive/schemas";

// part.search ツール（パーツセマンティック検索）
export {
  partSearchHandler,
  partSearchToolDefinition,
  PART_SEARCH_ERROR_CODES,
  type PartSearchOutput,
  type PartSearchMcpResultItem,
} from "./part/search.tool";

// part.inspect ツール（パーツ詳細情報取得）
export {
  partInspectHandler,
  partInspectToolDefinition,
  setPartInspectPrismaClientFactory,
  resetPartInspectPrismaClientFactory,
  PART_INSPECT_ERROR_CODES,
  type PartInspectOutput,
  type PartInspectDetail,
  type PartInspectPrismaClient,
} from "./part/inspect.tool";

// part.compare ツール（パーツ並列比較）
export {
  partCompareHandler,
  partCompareToolDefinition,
  PART_COMPARE_ERROR_CODES,
  type PartCompareOutput,
} from "./part/compare.tool";

// search.unified ツール（コンポーネント横断検索）
export {
  searchUnifiedHandler,
  searchUnifiedToolDefinition,
  UNIFIED_SEARCH_ERROR_CODES,
  type SearchUnifiedInput,
  type SearchUnifiedOutput,
  type UnifiedSearchResultItem,
} from "./search-unified.tool";

// design.search_by_image ツール（画像からの類似デザイン検索）
export {
  designSearchByImageHandler,
  designSearchByImageToolDefinition,
  designSearchByImageInputSchema,
  setDesignSearchDINOv2ServiceFactory,
  resetDesignSearchDINOv2ServiceFactory,
  setDesignSearchEmbeddingServiceFactory,
  resetDesignSearchEmbeddingServiceFactory,
  setDesignSearchPrismaClientFactory,
  resetDesignSearchPrismaClientFactory,
  DESIGN_SEARCH_ERROR_CODES,
  type DesignSearchByImageInput,
  type DesignSearchByImageOutput,
  type DesignSearchResultItem,
} from "./design/search-by-image.tool";

// design.similar_site ツール（URL→類似サイト検索）
export {
  designSimilarSiteHandler,
  designSimilarSiteToolDefinition,
  designSimilarSiteInputSchema,
  SIMILAR_SITE_ERROR_CODES,
  type DesignSimilarSiteInput,
  type DesignSimilarSiteOutput,
} from "./design/similar-site.tool";

// design.verify_reproduction ツール（HTML/CSS 再現の検証）
export {
  designVerifyReproductionHandler,
  designVerifyReproductionToolDefinition,
  verifyReproductionInputSchema,
  setDesignVerifyReproductionDepsFactory,
  resetDesignVerifyReproductionDepsFactory,
  DESIGN_VERIFY_ERROR_CODES,
  type VerifyReproductionInput,
  type VerifyReproductionOutput,
} from "./design/verify-reproduction.tool";

// data.delete ツール（GDPR Art.17 データ完全削除）
export {
  dataDeleteHandler,
  dataDeleteToolDefinition,
  dataDeleteInputSchema,
  setDataDeleteServiceFactory,
  resetDataDeleteServiceFactory,
  DATA_MCP_ERROR_CODES,
  type DataDeleteInput,
  type DataDeleteOutput,
} from "./data/data.tool";

// data.export ツール（GDPR Art.20 データポータビリティ）
export {
  dataExportHandler,
  dataExportToolDefinition,
  dataExportInputSchema,
  setDataExportServiceFactory,
  resetDataExportServiceFactory,
  type DataExportInput,
  type DataExportOutput,
} from "./data/data.tool";

// audit.query ツール（監査ログ検索、GDPR Art.30）
export {
  auditQueryHandler,
  auditQueryToolDefinition,
  auditQueryInputSchema,
  setAuditQueryServiceFactory,
  resetAuditQueryServiceFactory,
  AUDIT_QUERY_ERROR_CODES,
  type AuditQueryInput,
  type AuditQueryOutput,
  type AuditQueryErrorCode,
} from "./audit/query.tool";

// accessibility.audit ツール（WCAG監査 + コントラストチェック、v0.3.0 T2-WCAG）
export {
  accessibilityAuditHandler,
  accessibilityAuditToolDefinition,
  accessibilityAuditInputSchema,
  setAccessibilityAuditServiceFactory,
  resetAccessibilityAuditServiceFactory,
  setContrastCheckServiceFactory,
  resetContrastCheckServiceFactory,
  ACCESSIBILITY_AUDIT_ERROR_CODES,
  type AccessibilityAuditInput,
  type AccessibilityAuditOutput,
  type AccessibilityAuditErrorCode,
} from "./accessibility/audit.tool";

// performance.evaluate ツール（Core Web Vitals + パフォーマンス評価、v0.3.0 T2-CWV）
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
} from "./performance/evaluate.tool";

// responsive.capture ツール（3ビューポート同時キャプチャ + 差分分析、v0.3.0 T2-10）
export {
  responsiveCaptureHandler,
  responsiveCaptureToolDefinition,
  setResponsiveCaptureServiceFactory,
  resetResponsiveCaptureServiceFactory,
  RESPONSIVE_CAPTURE_ERROR_CODES,
  type ResponsiveCaptureInput,
  type ResponsiveCaptureOutput,
} from "./responsive/capture.tool";

// responsive.capture スキーマのエクスポート
export {
  responsiveCaptureInputSchema,
  viewportDefSchema,
  type ViewportDef,
  type ResponsiveCaptureErrorCode,
} from "./responsive/capture.schemas";

// [REMOVED v0.3.0] project.* スキーマのエクスポートは登録解除済み（ソースファイルは保持）
// project.* schema exports removed from registration. Source files retained for future use.

/**
 * 全ツール定義の配列
 * MCP Server初期化時に使用
 */
import { systemHealthToolDefinition } from "./system-health";
import { layoutInspectToolDefinition } from "./layout/inspect";
import { layoutIngestToolDefinition } from "./layout/ingest.tool";
import { layoutSearchToolDefinition } from "./layout/search.tool";
import { layoutGenerateCodeToolDefinition } from "./layout/to-code.tool";
import { qualityEvaluateToolDefinition } from "./quality/evaluate.tool";
import { motionDetectToolDefinition } from "./motion/detect.tool";
import { motionSearchToolDefinition } from "./motion/search.tool";
import {
  pageAnalyzeToolDefinition,
  pageGetJobStatusToolDefinition,
  pageBatchAnalyzeToolDefinition,
} from "./page";
import { narrativeSearchToolDefinition } from "./narrative/search.tool";
import { backgroundSearchToolDefinition } from "./background/search.tool";
import { responsiveSearchToolDefinition } from "./responsive/search.tool";
import { partSearchToolDefinition } from "./part/search.tool";
import { partInspectToolDefinition } from "./part/inspect.tool";
import { partCompareToolDefinition } from "./part/compare.tool";
import { searchUnifiedToolDefinition } from "./search-unified.tool";
import { designSearchByImageToolDefinition } from "./design/search-by-image.tool";
import { designSimilarSiteToolDefinition } from "./design/similar-site.tool";
import { designCompareToolDefinition } from "./design/compare.tool";
import { designVerifyReproductionToolDefinition } from "./design/verify-reproduction.tool";
import { auditQueryToolDefinition } from "./audit/query.tool";
import { dataDeleteToolDefinition, dataExportToolDefinition } from "./data/data.tool";
import { accessibilityAuditToolDefinition } from "./accessibility/audit.tool";
import { performanceEvaluateToolDefinition } from "./performance/evaluate.tool";
import { responsiveCaptureToolDefinition } from "./responsive/capture.tool";

export const allToolDefinitions = [
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
  // quality.evaluate（Phase 3-3 品質評価）
  qualityEvaluateToolDefinition,
  // [REMOVED v0.3.0] quality.batch_evaluate, quality.getJobStatus
  // motion.detect（Phase 3-6 モーション検出）
  motionDetectToolDefinition,
  // motion.search（Phase 3-6 モーション検索）
  motionSearchToolDefinition,
  // [REMOVED v0.3.0] project.get / project.list — バックエンドAPI未実装のため登録解除
  // page.analyze（統合Web分析）
  pageAnalyzeToolDefinition,
  // page.getJobStatus（非同期ジョブステータス確認 Phase3-2）
  pageGetJobStatusToolDefinition,
  // narrative.search（世界観・レイアウト構成セマンティック検索）
  narrativeSearchToolDefinition,
  // background.search（BackgroundDesignセマンティック検索）
  backgroundSearchToolDefinition,
  // responsive.search（レスポンシブ分析セマンティック検索）
  responsiveSearchToolDefinition,
  // part.search（パーツセマンティック検索）
  partSearchToolDefinition,
  // part.inspect（パーツ詳細情報取得）
  partInspectToolDefinition,
  // part.compare（パーツ並列比較）
  partCompareToolDefinition,
  // search.unified（コンポーネント横断検索）
  searchUnifiedToolDefinition,
  // design.search_by_image（画像からの類似デザイン検索）
  designSearchByImageToolDefinition,
  // design.similar_site（URL→類似サイト検索、v0.3.0 T2-2）
  designSimilarSiteToolDefinition,
  // design.compare（多次元デザイン比較、v0.3.0 T2-CMP）
  designCompareToolDefinition,
  // design.verify_reproduction（HTML/CSS 再現の検証）
  designVerifyReproductionToolDefinition,
  // audit.query（監査ログ検索、GDPR Art.30）
  auditQueryToolDefinition,
  // data.delete（GDPR Art.17 データ完全削除）
  dataDeleteToolDefinition,
  // data.export（GDPR Art.20 データポータビリティ）
  dataExportToolDefinition,
  // accessibility.audit（WCAG監査 + コントラストチェック、v0.3.0 T2-WCAG）
  accessibilityAuditToolDefinition,
  // performance.evaluate（Core Web Vitals + パフォーマンス評価、v0.3.0 T2-CWV）
  performanceEvaluateToolDefinition,
  // responsive.capture（3ビューポート同時キャプチャ + 差分分析、v0.3.0 T2-10）
  responsiveCaptureToolDefinition,
  // page.batch_analyze（バッチ一括分析、v0.4.0）
  pageBatchAnalyzeToolDefinition,
];

// tool-names.ts の TOOL_NAMES/ALL_TOOL_NAMES を初期化
// ESM環境（Vitest等）では require("./index") が .ts を解決できないため、
// モジュール評価完了時に明示的に登録する
import { _registerToolDefinitions } from "./tool-names";
_registerToolDefinitions(allToolDefinitions);

/**
 * ツール名からハンドラーを取得するマップ
 */
import { systemHealthHandler } from "./system-health";
import { layoutInspectHandler } from "./layout/inspect";
import { layoutIngestHandler } from "./layout/ingest.tool";
import { layoutSearchHandler } from "./layout/search.tool";
import { layoutGenerateCodeHandler } from "./layout/to-code.tool";
import { qualityEvaluateHandler } from "./quality/evaluate.tool";
import { motionDetectHandler } from "./motion/detect.tool";
import { motionSearchHandler } from "./motion/search.tool";
import { pageAnalyzeHandler, pageGetJobStatusHandler, pageBatchAnalyzeHandler } from "./page";
import { narrativeSearchHandler } from "./narrative/search.tool";
import { backgroundSearchHandler } from "./background/search.tool";
import { responsiveSearchHandler } from "./responsive/search.tool";
import { partSearchHandler } from "./part/search.tool";
import { partInspectHandler } from "./part/inspect.tool";
import { partCompareHandler } from "./part/compare.tool";
import { searchUnifiedHandler } from "./search-unified.tool";
import { designSearchByImageHandler } from "./design/search-by-image.tool";
import { designSimilarSiteHandler } from "./design/similar-site.tool";
import { designCompareHandler } from "./design/compare.tool";
import { designVerifyReproductionHandler } from "./design/verify-reproduction.tool";
import { auditQueryHandler } from "./audit/query.tool";
import { dataDeleteHandler, dataExportHandler } from "./data/data.tool";
import { accessibilityAuditHandler } from "./accessibility/audit.tool";
import { performanceEvaluateHandler } from "./performance/evaluate.tool";
import { responsiveCaptureHandler } from "./responsive/capture.tool";

export const toolHandlers: Record<string, (input: unknown) => Promise<unknown>> = {
  // system.health（MCPサーバーヘルスチェック）
  "system.health": systemHealthHandler,
  // layout.inspect（Phase 2-4 Webページレイアウト解析）
  "layout.inspect": layoutInspectHandler,
  // layout.ingest（Phase 2-1 Webページインジェスト）
  "layout.ingest": layoutIngestHandler,
  // layout.search（Phase 2-5 レイアウトセマンティック検索）
  "layout.search": layoutSearchHandler,
  // layout.generate_code（Phase 2-6 レイアウトコード生成）
  // v0.1.0: layout.to_code から layout.generate_code にリネーム
  "layout.generate_code": layoutGenerateCodeHandler,
  // quality.evaluate（Phase 3-3 品質評価）
  "quality.evaluate": qualityEvaluateHandler,
  // [REMOVED v0.3.0] quality.batch_evaluate, quality.getJobStatus
  // motion.detect（Phase 3-6 モーション検出）
  "motion.detect": motionDetectHandler,
  // motion.search（Phase 3-6 モーション検索）
  "motion.search": motionSearchHandler,
  // [REMOVED v0.3.0] project.get / project.list — バックエンドAPI未実装のため登録解除
  // page.analyze（統合Web分析）
  "page.analyze": pageAnalyzeHandler,
  // page.getJobStatus（非同期ジョブステータス確認 Phase3-2）
  "page.getJobStatus": pageGetJobStatusHandler,
  // narrative.search（世界観・レイアウト構成セマンティック検索）
  "narrative.search": narrativeSearchHandler,
  // background.search（BackgroundDesignセマンティック検索）
  "background.search": backgroundSearchHandler,
  // responsive.search（レスポンシブ分析セマンティック検索）
  "responsive.search": responsiveSearchHandler,
  // part.search（パーツセマンティック検索）
  "part.search": partSearchHandler,
  // part.inspect（パーツ詳細情報取得）
  "part.inspect": partInspectHandler,
  // part.compare（パーツ並列比較）
  "part.compare": partCompareHandler,
  // search.unified（コンポーネント横断検索）
  "search.unified": searchUnifiedHandler,
  // design.search_by_image（画像からの類似デザイン検索）
  "design.search_by_image": designSearchByImageHandler,
  // design.similar_site（URL→類似サイト検索、v0.3.0 T2-2）
  "design.similar_site": designSimilarSiteHandler,
  // design.compare（多次元デザイン比較、v0.3.0 T2-CMP）
  "design.compare": designCompareHandler,
  // design.verify_reproduction（HTML/CSS 再現の検証）
  "design.verify_reproduction": designVerifyReproductionHandler,
  // audit.query（監査ログ検索、GDPR Art.30）
  "audit.query": auditQueryHandler,
  // data.delete（GDPR Art.17 データ完全削除）
  "data.delete": dataDeleteHandler,
  // data.export（GDPR Art.20 データポータビリティ）
  "data.export": dataExportHandler,
  // accessibility.audit（WCAG監査 + コントラストチェック、v0.3.0 T2-WCAG）
  "accessibility.audit": accessibilityAuditHandler,
  // performance.evaluate（Core Web Vitals + パフォーマンス評価、v0.3.0 T2-CWV）
  "performance.evaluate": performanceEvaluateHandler,
  // responsive.capture（3ビューポート同時キャプチャ + 差分分析、v0.3.0 T2-10）
  "responsive.capture": responsiveCaptureHandler,
  // page.batch_analyze（バッチ一括分析、v0.4.0）
  "page.batch_analyze": pageBatchAnalyzeHandler,
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

  const missingHandlers = definedTools.filter((t) => !handlerTools.includes(t));
  const extraHandlers = handlerTools.filter((t) => !definedTools.includes(t));

  return {
    isConsistent: missingHandlers.length === 0 && extraHandlers.length === 0,
    definedTools,
    handlerTools,
    missingHandlers,
    extraHandlers,
  };
}
