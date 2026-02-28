// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page/ ツールモジュール
 * @module tools/page
 */

// === Schemas ===
export {
  // Error codes
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeErrorCode,

  // Enums
  sourceTypeSchema,
  usageScopeSchema,
  waitUntilSchema,
  gradeSchema,
  type SourceType,
  type UsageScope,
  type WaitUntil,
  type Grade,

  // Features & Options
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

  // Input
  pageAnalyzeInputSchema,
  type PageAnalyzeInput,

  // Output - Layout
  layoutResultSummarySchema,
  layoutResultFullSchema,
  sectionDetailSchema,
  screenshotSchema,
  cssFrameworkResultSchema,
  type LayoutResultSummary,
  type LayoutResultFull,
  type LayoutResult,
  type CssFrameworkResult,

  // Output - Motion
  motionResultSummarySchema,
  motionResultFullSchema,
  patternDetailSchema,
  warningDetailSchema,
  type MotionResultSummary,
  type MotionResultFull,
  type MotionResult,

  // Output - Quality
  qualityResultSummarySchema,
  qualityResultFullSchema,
  axisScoresSchema,
  axisGradesSchema,
  axisDetailsSchema,
  clicheDetailSchema,
  recommendationSchema,
  type QualityResultSummary,
  type QualityResultFull,
  type QualityResult,

  // Output - Metadata & Response
  pageMetadataSchema,
  sourceInfoSchema,
  analysisWarningSchema,
  pageAnalyzeDataSchema,
  pageAnalyzeErrorSchema,
  pageAnalyzeSuccessOutputSchema,
  pageAnalyzeErrorOutputSchema,
  pageAnalyzeOutputSchema,
  type PageMetadata,
  type SourceInfo,
  type AnalysisWarning,
  type PageAnalyzeData,
  type PageAnalyzeError,
  type PageAnalyzeOutput,
  type PageAnalyzeSuccessOutput,
  type PageAnalyzeErrorOutput,

  // Utilities
  scoreToGrade,
} from './schemas';

// === Tool Handler ===
export {
  pageAnalyzeHandler,
  pageAnalyzeToolDefinition,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
  setPageAnalyzePrismaClientFactory,
  resetPageAnalyzePrismaClientFactory,
  type IPageAnalyzeService,
  type IPageAnalyzePrismaClient,
} from './analyze.tool';

// === Async Mode (Phase3-2) ===
export {
  pageGetJobStatusHandler,
  pageGetJobStatusToolDefinition,
  GET_JOB_STATUS_ERROR_CODES,
} from './get-job-status.tool';

// Async mode schemas
export {
  pageAnalyzeAsyncOutputSchema,
  pageGetJobStatusInputSchema,
  pageGetJobStatusOutputSchema,
  pageGetJobStatusFoundOutputSchema,
  pageGetJobStatusNotFoundOutputSchema,
  jobStateSchema,
  jobResultSummarySchema,
  redisUnavailableErrorSchema,
  type PageAnalyzeAsyncOutput,
  type PageGetJobStatusInput,
  type PageGetJobStatusOutput,
  type PageGetJobStatusFoundOutput,
  type PageGetJobStatusNotFoundOutput,
  type JobState,
  type JobResultSummary,
  type RedisUnavailableError,
} from './schemas';

// === Phased Executor ===
export {
  PhasedExecutor,
  type PhaseResult,
  type PhasedExecutionResult,
  type PhasedExecutorOptions,
  type PhaseTimeouts,
  type PhaseType,
} from './handlers/phased-executor';
