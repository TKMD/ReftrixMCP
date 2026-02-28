// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Server Services層エクスポート
 * MCPツール用Service関数をエクスポート
 *
 * @module services
 */

// ====================================================
// Page Analyze Service
// ====================================================

export {
  executePageAnalyze,
  type PageAnalyzeInput,
  type PageAnalyzeOutput,
  type PageAnalyzeData,
  type PageAnalyzeError,
  type LayoutResult,
  type MotionResult,
  type QualityResult,
  type PageMetadata,
  type AnalysisWarning,
  // Enums
  sourceTypeSchema,
  usageScopeSchema,
  waitUntilSchema,
  gradeSchema,
  type SourceType,
  type UsageScope,
  type WaitUntil,
  type Grade,
  // Schemas
  pageAnalyzeInputSchema,
  pageAnalyzeOutputSchema,
  analysisFeaturesSchema,
  viewportSchema,
  layoutOptionsSchema,
  motionOptionsSchema,
  qualityOptionsSchema,
  type AnalysisFeatures,
  type Viewport,
  type LayoutOptions,
  type MotionOptions,
  type QualityOptions,
  // Error codes
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeErrorCode,
} from './page-analyze-service';

// ====================================================
// Layout Search Service
// ====================================================

export {
  executeLayoutSearch,
  type LayoutSearchInput,
  type LayoutSearchOutput,
  type LayoutSearchData,
  type LayoutSearchErrorInfo,
  type LayoutSearchResultItem,
  type LayoutSearchFilters,
  type LayoutSearchPreview,
  type LayoutSearchSource,
} from './layout-search-service-export';

// ====================================================
// Motion Search Service
// ====================================================

export {
  executeMotionSearch,
  type MotionSearchInput,
  type MotionSearchOutput,
  type MotionSearchParams,
  type MotionSearchResult,
  type MotionSearchData,
  type MotionSearchError,
  type MotionSearchResultItem,
  type MotionSearchFilters,
  type MotionSearchType,
  type MotionSearchTrigger,
  type MotionSearchSource,
  type MotionSearchQueryInfo,
} from './motion-search-service';

// ====================================================
// Palette Service
// ====================================================

export {
  executeGetPalette,
  type GetPaletteInput,
  type GetPaletteResult,
  type GetPaletteOptions,
  type PaletteDetail,
  type PaletteListItem,
  type ColorTokenApi,
  type GradientApi,
} from './palette-service-export';

// ====================================================
// Layout Generate Code Service
// ====================================================

export {
  executeLayoutGenerateCode,
  setPrismaClientFactory,
  type LayoutToCodeInput,
  type LayoutToCodeOutput,
  type LayoutToCodeData,
  type LayoutToCodeOptions,
  type LayoutToCodeErrorInfo,
  type Framework,
} from './layout-generate-code-service-export';

// ====================================================
// Quality Evaluate Service
// ====================================================

export {
  executeQualityEvaluate,
  resetQualityEvaluateService,
  type QualityEvaluateInput,
  type QualityEvaluateOutput,
  type QualityEvaluateData,
  type QualityEvaluateErrorInfo,
  type QualityEvaluatorOptions,
  type QualityEvaluatorResult,
} from './quality-evaluate-service-export';

// ====================================================
// Motion Detect Service
// ====================================================

export {
  executeMotionDetect,
  resetMotionDetectService,
  type MotionDetectInput,
  type MotionDetectOutput,
  type MotionDetectData,
  type MotionDetectOptions,
  type MotionDetectErrorInfo,
  type MotionPatternApi,
  type MotionWarningApi,
  // Re-exported types from service
  type MotionPattern,
  type MotionWarning,
  type MotionDetectionResult,
  type MotionDetectionOptions,
} from './motion-detect-service-export';

// ====================================================
// CSS Analysis Cache Service
// ====================================================

export {
  CSSAnalysisCacheService,
  createCSSAnalysisCacheService,
  getCSSAnalysisCacheService,
  resetCSSAnalysisCacheService,
  type ICSSAnalysisCacheService,
  type CSSAnalysisCacheOptions,
  type CSSAnalysisResult,
  type MotionAnalysisResult,
  type CSSAnalysisCacheStats,
} from './css-analysis-cache.service';
