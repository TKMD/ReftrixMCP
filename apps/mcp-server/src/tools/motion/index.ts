// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.* MCP Tools エクスポート
 * モーション/アニメーションパターン検出・検索・実装生成ツール
 *
 * @module @reftrix/mcp-server/tools/motion
 */

// motion.detect ツール
export {
  motionDetectHandler,
  motionDetectToolDefinition,
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
  setMotionPersistenceServiceFactory,
  resetMotionPersistenceServiceFactory,
  setRuntimeAnimationDetectorFactory,
  resetRuntimeAnimationDetectorFactory,
  type IMotionDetectService,
  type MotionDetectInput,
  type MotionDetectOutput,
} from './detect.tool';

// motion.search ツール
export {
  motionSearchHandler,
  motionSearchToolDefinition,
  setMotionSearchServiceFactory,
  resetMotionSearchServiceFactory,
  type IMotionSearchService,
  type MotionSearchInput,
  type MotionSearchOutput,
  type MotionSearchParams,
  type MotionSearchResult,
} from './search.tool';

// [DELETED v0.1.0] motion.get_implementation は motion.search に統合されました

// motion.analyze_frames ツール
export {
  motionAnalyzeFramesHandler,
  motionAnalyzeFramesToolDefinition,
  setFrameAnalysisServiceFactory,
  resetFrameAnalysisServiceFactory,
  type IFrameAnalysisService,
  type FrameAnalysisServiceInput,
  type FrameAnalysisServiceOutput,
  type AnalyzeFramesInput,
  type AnalyzeFramesOutput,
} from './analyze-frames.handler';

// スキーマエクスポート
export {
  // motion.detect 入力スキーマ
  motionDetectInputSchema,
  // motion.detect 出力スキーマ
  motionDetectOutputSchema,
  motionDetectDataSchema,
  motionDetectSuccessOutputSchema,
  motionDetectErrorOutputSchema,
  motionDetectErrorSchema,
  // motion.search 入力スキーマ
  motionSearchInputSchema,
  samplePatternSchema,
  motionSearchFiltersSchema,
  motionSearchTypeSchema,
  motionSearchTriggerSchema,
  // motion.search 出力スキーマ
  motionSearchOutputSchema,
  motionSearchDataSchema,
  motionSearchSuccessOutputSchema,
  motionSearchErrorOutputSchema,
  motionSearchErrorSchema,
  motionSearchResultItemSchema,
  motionSearchSourceSchema,
  motionSearchQueryInfoSchema,
  // パターン関連スキーマ
  motionPatternSchema,
  motionTypeSchema,
  motionCategorySchema,
  triggerTypeSchema,
  easingTypeSchema,
  easingConfigSchema,
  animatedPropertySchema,
  keyframeStepSchema,
  performanceInfoSchema,
  accessibilityInfoSchema,
  performanceLevelSchema,
  // サマリー・警告スキーマ
  motionSummarySchema,
  motionWarningSchema,
  warningSeveritySchema,
  motionMetadataSchema,
  // フレームキャプチャスキーマ (video mode)
  frameCaptureOptionsSchema,
  frameCaptureResultSchema,
  frameFileInfoSchema,
  // フレームキャプチャユーティリティ関数 (video mode)
  calculateFrameCaptureConfig,
  generateFrameFileInfos,
  // ユーティリティ関数
  calculatePerformanceLevel,
  calculateComplexityScore,
  calculateAverageDuration,
  countByType,
  countByTrigger,
  countByCategory,
  // エラーコード
  MOTION_MCP_ERROR_CODES,
  MOTION_WARNING_CODES,
  MOTION_SEARCH_ERROR_CODES,
  // MCP Tool定義
  motionMcpTools,
  // 型エクスポート
  type MotionDetectData,
  type MotionDetectError,
  type MotionPattern,
  type MotionType,
  type MotionCategory,
  type TriggerType,
  type EasingType,
  type EasingConfig,
  type AnimatedProperty,
  type KeyframeStep,
  type PerformanceInfo,
  type PerformanceLevel,
  type AccessibilityInfo,
  type MotionSummary,
  type MotionWarning,
  type WarningSeverity,
  type MotionMetadata,
  type MotionMcpErrorCode,
  type MotionWarningCode,
  type MotionMcpToolName,
  // フレームキャプチャ型 (video mode)
  type FrameCaptureOptions,
  type FrameCaptureResult,
  type FrameFileInfo,
  type FrameCaptureConfig,
  // motion.search 型エクスポート
  type MotionSearchType,
  type MotionSearchTrigger,
  type SamplePattern,
  type MotionSearchFilters,
  type MotionSearchData,
  type MotionSearchError,
  type MotionSearchResultItem,
  type MotionSearchSource,
  type MotionSearchQueryInfo,
  type MotionSearchErrorCode,
  // motion.get_implementation スキーマ
  motionGetImplementationInputSchema,
  motionGetImplementationOutputSchema,
  motionGetImplementationDataSchema,
  motionGetImplementationSuccessOutputSchema,
  motionGetImplementationErrorOutputSchema,
  motionPatternInputSchema,
  implementationFormatSchema,
  implementationOptionsSchema,
  implementationMetadataSchema,
  implementationPropertySchema,
  keyframeOffsetSchema,
  motionPatternTypeSchema,
  // motion.get_implementation 型エクスポート
  type MotionGetImplementationData,
  type MotionPatternInput,
  type ImplementationFormat,
  type ImplementationOptions,
  type ImplementationMetadata,
  type ImplementationProperty,
  type KeyframeOffset,
  type MotionPatternType,
} from './schemas';

// motion.analyze_frames スキーマエクスポート
export {
  // 入力スキーマ
  analyzeFramesInputSchema,
  analyzeOptionsSchema,
  analysisTypeSchema,
  // 出力スキーマ
  analyzeFramesOutputSchema,
  analyzeFramesDataSchema,
  analyzeFramesSuccessOutputSchema,
  analyzeFramesErrorOutputSchema,
  analyzeFramesErrorSchema,
  // 結果スキーマ
  analysisResultsSchema,
  frameDiffResultSchema,
  frameDiffSummarySchema,
  changeRegionSchema,
  layoutShiftResultSchema,
  layoutShiftSummarySchema,
  colorChangeResultSchema,
  colorChangeEventSchema,
  motionVectorResultSchema,
  motionVectorSummarySchema,
  elementVisibilityResultSchema,
  visibilityEventSchema,
  // タイムラインスキーマ
  timelineEntrySchema,
  // MCPツール定義
  analyzeFramesMcpTool,
  // エラーコード
  ANALYZE_FRAMES_ERROR_CODES,
  // 定数
  MAX_ANALYSIS_FRAMES,
  MIN_ANALYSIS_FRAMES,
  // 型エクスポート
  type AnalysisType,
  type AnalyzeOptions,
  type AnalyzeFramesData,
  type AnalyzeFramesError,
  type AnalysisResults,
  type FrameDiffResult,
  type FrameDiffSummary,
  type ChangeRegion,
  type LayoutShiftResult,
  type LayoutShiftSummary,
  type ColorChangeResult,
  type ColorChangeEvent,
  type MotionVectorResult,
  type MotionVectorSummary,
  type ElementVisibilityResult,
  type VisibilityEvent,
  type TimelineEntry,
} from './analyze-frames.schema';
