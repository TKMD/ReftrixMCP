// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Tools Export
 * WebDesign専用ツールハンドラーとツール定義のエクスポート
 *
 * Total: 35 tools
 * - Style: style.get_palette
 * - System: system.health
 * - Layout: layout.inspect, layout.ingest, layout.search, layout.generate_code, layout.batch_ingest
 * - Quality: quality.evaluate
 * - Motion: motion.detect, motion.search
 * - Brief: brief.validate
 * - Page: page.analyze, page.getJobStatus
 * - Narrative: narrative.search
 * - Background: background.search
 * - Responsive: responsive.search, responsive.capture
 * - Preference: preference.hear, preference.get, preference.reset
 * - Part: part.search, part.inspect, part.compare
 * - Search: search.unified, search.facets
 * - Design: design.search_by_image, design.similar_site, design.compare, design.track_changes
 * - Data: data.delete, data.export
 * - Audit: audit.query
 * - Embedding: embedding.quality
 * - Accessibility: accessibility.audit
 * - Performance: performance.evaluate
 */

// style系スキーマのエクスポート（style.get_palette用）
export {
  styleGetPaletteInputSchema,
  paletteModeSchema,
  type StyleGetPaletteInput,
} from "./schemas/style-schemas";

// style.get_palette ツール（MCP Creative Tools）
export { styleGetPaletteHandler, styleGetPaletteToolDefinition } from "./style-get-palette";

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

// layout.batch_ingest ツール（Phase 2-7 バッチインジェスト）
export {
  layoutBatchIngestHandler,
  layoutBatchIngestToolDefinition,
  type LayoutBatchIngestInput,
  type LayoutBatchIngestOutput,
} from "./layout/batch-ingest.tool";

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
} from "./brief";

// brief.validate ツール（Phase 4-3 Design Brief Validation）
export {
  briefValidateHandler,
  briefValidateToolDefinition,
  setBriefValidateServiceFactory,
  resetBriefValidateServiceFactory,
  type IBriefValidateServiceFactory,
} from "./brief";

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

// preference.hear ツール（ユーザー嗜好ヒアリングセッション）
export {
  preferenceHearHandler,
  preferenceHearToolDefinition,
  setPreferenceHearServiceFactory,
  resetPreferenceHearServiceFactory,
  type IPreferenceService,
  type PreferenceSample,
  type SamplesResult,
  type FeedbackResult,
  type ProfileData,
  type ResetResult,
  type PreferenceHearOutput,
} from "./preference";

// preference.get ツール（プロファイル取得）
export {
  preferenceGetHandler,
  preferenceGetToolDefinition,
  setPreferenceGetServiceFactory,
  resetPreferenceGetServiceFactory,
  type PreferenceGetOutput,
} from "./preference";

// preference.reset ツール（プロファイルリセット）
export {
  preferenceResetHandler,
  preferenceResetToolDefinition,
  setPreferenceResetServiceFactory,
  resetPreferenceResetServiceFactory,
  type PreferenceResetOutput,
} from "./preference";

// preference.* スキーマのエクスポート
export {
  preferenceHearInputSchema,
  preferenceGetInputSchema,
  preferenceResetInputSchema,
  feedbackRatingSchema,
  feedbackItemSchema,
  PREFERENCE_MCP_ERROR_CODES,
  type PreferenceHearInput,
  type PreferenceGetInput,
  type PreferenceResetInput,
  type FeedbackRating,
  type FeedbackItem,
  type PreferenceMcpErrorCode,
} from "./preference";

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

// search.facets ツール（ファセット検索、v0.3.0 T2-FAC）
export {
  searchFacetsHandler,
  searchFacetsToolDefinition,
  searchFacetsInputSchema,
  SEARCH_FACETS_ERROR_CODES,
  type SearchFacetsInput,
  type SearchFacetsOutput,
} from "./search/facets.tool";

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

// embedding.quality ツール（Embedding品質監視、v0.3.0 T2-EMB）
export {
  embeddingQualityHandler,
  embeddingQualityToolDefinition,
  embeddingQualityInputSchema,
  setEmbeddingQualityServiceFactory,
  resetEmbeddingQualityServiceFactory,
  EMBEDDING_QUALITY_ERROR_CODES,
  type EmbeddingQualityInput,
  type EmbeddingQualityOutput,
  type EmbeddingQualityErrorCode,
} from "./embedding/quality.tool";

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
import { styleGetPaletteToolDefinition } from "./style-get-palette";
import { systemHealthToolDefinition } from "./system-health";
import { layoutInspectToolDefinition } from "./layout/inspect";
import { layoutIngestToolDefinition } from "./layout/ingest.tool";
import { layoutSearchToolDefinition } from "./layout/search.tool";
import { layoutGenerateCodeToolDefinition } from "./layout/to-code.tool";
import { layoutBatchIngestToolDefinition } from "./layout/batch-ingest.tool";
import { qualityEvaluateToolDefinition } from "./quality/evaluate.tool";
import { motionDetectToolDefinition } from "./motion/detect.tool";
import { motionSearchToolDefinition } from "./motion/search.tool";
import { briefValidateToolDefinition } from "./brief";
import { pageAnalyzeToolDefinition, pageGetJobStatusToolDefinition } from "./page";
import { narrativeSearchToolDefinition } from "./narrative/search.tool";
import { backgroundSearchToolDefinition } from "./background/search.tool";
import { responsiveSearchToolDefinition } from "./responsive/search.tool";
import {
  preferenceHearToolDefinition,
  preferenceGetToolDefinition,
  preferenceResetToolDefinition,
} from "./preference";
import { partSearchToolDefinition } from "./part/search.tool";
import { partInspectToolDefinition } from "./part/inspect.tool";
import { partCompareToolDefinition } from "./part/compare.tool";
import { searchUnifiedToolDefinition } from "./search-unified.tool";
import { searchFacetsToolDefinition } from "./search/facets.tool";
import { designSearchByImageToolDefinition } from "./design/search-by-image.tool";
import { designSimilarSiteToolDefinition } from "./design/similar-site.tool";
import { designCompareToolDefinition } from "./design/compare.tool";
import { auditQueryToolDefinition } from "./audit/query.tool";
import { dataDeleteToolDefinition, dataExportToolDefinition } from "./data/data.tool";
import { embeddingQualityToolDefinition } from "./embedding/quality.tool";
import { accessibilityAuditToolDefinition } from "./accessibility/audit.tool";
import { performanceEvaluateToolDefinition } from "./performance/evaluate.tool";
import { responsiveCaptureToolDefinition } from "./responsive/capture.tool";
import { designTrackChangesToolDefinition } from "./design/track-changes.tool";

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
  // [REMOVED v0.3.0] quality.batch_evaluate, quality.getJobStatus
  // motion.detect（Phase 3-6 モーション検出）
  motionDetectToolDefinition,
  // motion.search（Phase 3-6 モーション検索）
  motionSearchToolDefinition,
  // brief.validate（Phase 4-3 Design Brief Validation）
  briefValidateToolDefinition,
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
  // preference.hear（ユーザー嗜好ヒアリングセッション）
  preferenceHearToolDefinition,
  // preference.get（プロファイル取得）
  preferenceGetToolDefinition,
  // preference.reset（プロファイルリセット）
  preferenceResetToolDefinition,
  // part.search（パーツセマンティック検索）
  partSearchToolDefinition,
  // part.inspect（パーツ詳細情報取得）
  partInspectToolDefinition,
  // part.compare（パーツ並列比較）
  partCompareToolDefinition,
  // search.unified（コンポーネント横断検索）
  searchUnifiedToolDefinition,
  // search.facets（ファセット検索、v0.3.0 T2-FAC）
  searchFacetsToolDefinition,
  // design.search_by_image（画像からの類似デザイン検索）
  designSearchByImageToolDefinition,
  // design.similar_site（URL→類似サイト検索、v0.3.0 T2-2）
  designSimilarSiteToolDefinition,
  // design.compare（多次元デザイン比較、v0.3.0 T2-CMP）
  designCompareToolDefinition,
  // audit.query（監査ログ検索、GDPR Art.30）
  auditQueryToolDefinition,
  // data.delete（GDPR Art.17 データ完全削除）
  dataDeleteToolDefinition,
  // data.export（GDPR Art.20 データポータビリティ）
  dataExportToolDefinition,
  // embedding.quality（Embedding品質監視、v0.3.0 T2-EMB）
  embeddingQualityToolDefinition,
  // accessibility.audit（WCAG監査 + コントラストチェック、v0.3.0 T2-WCAG）
  accessibilityAuditToolDefinition,
  // performance.evaluate（Core Web Vitals + パフォーマンス評価、v0.3.0 T2-CWV）
  performanceEvaluateToolDefinition,
  // responsive.capture（3ビューポート同時キャプチャ + 差分分析、v0.3.0 T2-10）
  responsiveCaptureToolDefinition,
  // design.track_changes（デザイン変更時系列追跡、v0.3.0 T2-DCT）
  designTrackChangesToolDefinition,
];

// tool-names.ts の TOOL_NAMES/ALL_TOOL_NAMES を初期化
// ESM環境（Vitest等）では require("./index") が .ts を解決できないため、
// モジュール評価完了時に明示的に登録する
import { _registerToolDefinitions } from "./tool-names";
_registerToolDefinitions(allToolDefinitions);

/**
 * ツール名からハンドラーを取得するマップ
 */
import { styleGetPaletteHandler } from "./style-get-palette";
import { systemHealthHandler } from "./system-health";
import { layoutInspectHandler } from "./layout/inspect";
import { layoutIngestHandler } from "./layout/ingest.tool";
import { layoutSearchHandler } from "./layout/search.tool";
import { layoutGenerateCodeHandler } from "./layout/to-code.tool";
import { layoutBatchIngestHandler } from "./layout/batch-ingest.tool";
import { qualityEvaluateHandler } from "./quality/evaluate.tool";
import { motionDetectHandler } from "./motion/detect.tool";
import { motionSearchHandler } from "./motion/search.tool";
import { briefValidateHandler } from "./brief";
import { pageAnalyzeHandler, pageGetJobStatusHandler } from "./page";
import { narrativeSearchHandler } from "./narrative/search.tool";
import { backgroundSearchHandler } from "./background/search.tool";
import { responsiveSearchHandler } from "./responsive/search.tool";
import { preferenceHearHandler, preferenceGetHandler, preferenceResetHandler } from "./preference";
import { partSearchHandler } from "./part/search.tool";
import { partInspectHandler } from "./part/inspect.tool";
import { partCompareHandler } from "./part/compare.tool";
import { searchUnifiedHandler } from "./search-unified.tool";
import { searchFacetsHandler } from "./search/facets.tool";
import { designSearchByImageHandler } from "./design/search-by-image.tool";
import { designSimilarSiteHandler } from "./design/similar-site.tool";
import { designCompareHandler } from "./design/compare.tool";
import { auditQueryHandler } from "./audit/query.tool";
import { dataDeleteHandler, dataExportHandler } from "./data/data.tool";
import { embeddingQualityHandler } from "./embedding/quality.tool";
import { accessibilityAuditHandler } from "./accessibility/audit.tool";
import { performanceEvaluateHandler } from "./performance/evaluate.tool";
import { responsiveCaptureHandler } from "./responsive/capture.tool";
import { designTrackChangesHandler } from "./design/track-changes.tool";

export const toolHandlers: Record<string, (input: unknown) => Promise<unknown>> = {
  // style.get_palette（ブランドパレット取得）
  "style.get_palette": styleGetPaletteHandler,
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
  // layout.batch_ingest（Phase 2-7 バッチインジェスト）
  "layout.batch_ingest": layoutBatchIngestHandler,
  // quality.evaluate（Phase 3-3 品質評価）
  "quality.evaluate": qualityEvaluateHandler,
  // [REMOVED v0.3.0] quality.batch_evaluate, quality.getJobStatus
  // motion.detect（Phase 3-6 モーション検出）
  "motion.detect": motionDetectHandler,
  // motion.search（Phase 3-6 モーション検索）
  "motion.search": motionSearchHandler,
  // brief.validate（Phase 4-3 Design Brief Validation）
  "brief.validate": briefValidateHandler,
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
  // preference.hear（ユーザー嗜好ヒアリングセッション）
  "preference.hear": preferenceHearHandler,
  // preference.get（プロファイル取得）
  "preference.get": preferenceGetHandler,
  // preference.reset（プロファイルリセット）
  "preference.reset": preferenceResetHandler,
  // part.search（パーツセマンティック検索）
  "part.search": partSearchHandler,
  // part.inspect（パーツ詳細情報取得）
  "part.inspect": partInspectHandler,
  // part.compare（パーツ並列比較）
  "part.compare": partCompareHandler,
  // search.unified（コンポーネント横断検索）
  "search.unified": searchUnifiedHandler,
  // search.facets（ファセット検索、v0.3.0 T2-FAC）
  "search.facets": searchFacetsHandler,
  // design.search_by_image（画像からの類似デザイン検索）
  "design.search_by_image": designSearchByImageHandler,
  // design.similar_site（URL→類似サイト検索、v0.3.0 T2-2）
  "design.similar_site": designSimilarSiteHandler,
  // design.compare（多次元デザイン比較、v0.3.0 T2-CMP）
  "design.compare": designCompareHandler,
  // audit.query（監査ログ検索、GDPR Art.30）
  "audit.query": auditQueryHandler,
  // data.delete（GDPR Art.17 データ完全削除）
  "data.delete": dataDeleteHandler,
  // data.export（GDPR Art.20 データポータビリティ）
  "data.export": dataExportHandler,
  // embedding.quality（Embedding品質監視、v0.3.0 T2-EMB）
  "embedding.quality": embeddingQualityHandler,
  // accessibility.audit（WCAG監査 + コントラストチェック、v0.3.0 T2-WCAG）
  "accessibility.audit": accessibilityAuditHandler,
  // performance.evaluate（Core Web Vitals + パフォーマンス評価、v0.3.0 T2-CWV）
  "performance.evaluate": performanceEvaluateHandler,
  // responsive.capture（3ビューポート同時キャプチャ + 差分分析、v0.3.0 T2-10）
  "responsive.capture": responsiveCaptureHandler,
  // design.track_changes（デザイン変更時系列追跡、v0.3.0 T2-DCT）
  "design.track_changes": designTrackChangesHandler,
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
