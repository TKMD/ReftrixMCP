// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * narrative.* MCP Tools Export
 *
 * Webデザインの世界観（WorldView）とレイアウト構成（LayoutStructure）分析ツール
 *
 * @module @reftrix/mcp-server/tools/narrative
 *
 * 対応ツール:
 * - narrative.analyze: URLまたはHTMLから世界観・レイアウト構成を分析
 * - narrative.search: 世界観・レイアウト構成でセマンティック検索
 */

// ============================================================================
// Schema Exports
// ============================================================================

export {
  // Enum schemas
  moodCategorySchema,
  colorHarmonySchema,
  gridTypeSchema,
  sectionFlowSchema,
  narrativeSearchModeSchema,

  // narrative.analyze schemas
  narrativeAnalyzeOptionsSchema,
  narrativeAnalyzeInputSchema,
  worldViewSchema,
  layoutStructureSchema,
  narrativeAnalyzeDataSchema,
  narrativeAnalyzeWarningSchema,
  narrativeAnalyzeErrorInfoSchema,
  narrativeAnalyzeSuccessOutputSchema,
  narrativeAnalyzeErrorOutputSchema,
  narrativeAnalyzeOutputSchema,

  // narrative.search schemas
  narrativeSearchFiltersSchema,
  narrativeSearchOptionsSchema,
  narrativeSearchInputSchema,
  narrativeSearchResultItemSchema,
  narrativeSearchInfoSchema,
  narrativeSearchDataSchema,
  narrativeSearchErrorInfoSchema,
  narrativeSearchSuccessOutputSchema,
  narrativeSearchErrorOutputSchema,
  narrativeSearchOutputSchema,

  // page.analyze integration schema
  pageAnalyzeNarrativeOptionsSchema,

  // Sub-schemas (for advanced usage)
  colorImpressionSchema,
  typographyPersonalitySchema,
  motionEmotionSchema,
  overallToneSchema,
  gridSystemSchema,
  visualHierarchySchema,
  spacingRhythmSchema,
  sectionRelationshipSchema,
  graphicElementsSchema,
  confidenceScoreSchema,
  confidenceBreakdownSchema,

  // Error codes
  NARRATIVE_MCP_ERROR_CODES,

  // MCP Tool definitions
  narrativeMcpTools,

  // Types
  type MoodCategory,
  type ColorHarmony,
  type GridType,
  type SectionFlow,
  type NarrativeSearchMode,
  type NarrativeAnalyzeOptions,
  type NarrativeAnalyzeInput,
  type WorldView,
  type LayoutStructure,
  type NarrativeAnalyzeData,
  type NarrativeAnalyzeWarning,
  type NarrativeAnalyzeErrorInfo,
  type NarrativeAnalyzeOutput,
  type NarrativeSearchFilters,
  type NarrativeSearchOptions,
  type NarrativeSearchInput,
  type NarrativeSearchResultItem,
  type NarrativeSearchInfo,
  type NarrativeSearchData,
  type NarrativeSearchErrorInfo,
  type NarrativeSearchOutput,
  type PageAnalyzeNarrativeOptions,
  type ColorImpression,
  type TypographyPersonality,
  type MotionEmotion,
  type OverallTone,
  type GridSystem,
  type VisualHierarchy,
  type SpacingRhythm,
  type SectionRelationship,
  type GraphicElements,
  type ConfidenceScore,
  type ConfidenceBreakdown,
  type NarrativeMcpErrorCode,
  type NarrativeMcpToolName,
} from './schemas';

// ============================================================================
// Handler Exports
// ============================================================================

export {
  narrativeAnalyzeHandler,
  narrativeAnalyzeToolDefinition,
  setNarrativeAnalyzeServiceFactory,
  resetNarrativeAnalyzeServiceFactory,
  type INarrativeAnalyzeServiceFactory,
} from './analyze.tool.js';

export {
  narrativeSearchHandler,
  narrativeSearchToolDefinition,
  setNarrativeSearchServiceFactory,
  resetNarrativeSearchServiceFactory,
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
  getEmbeddingService,
  type INarrativeSearchServiceFactory,
} from './search.tool.js';
