// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @reftrix/core/webdesign
 * Webデザイン解析機能の型定義とZodスキーマ
 *
 * @module @reftrix/core/webdesign
 */

// Export all types and schemas from types.ts
export {
  // =========================================
  // Enum / Literal Types - Schemas
  // =========================================
  sourceTypeSchema,
  usageScopeSchema,
  awardSourceSchema,
  sectionTypeSchema,
  motionTypeSchema,
  analysisStatusSchema,
  codeTypeSchema,
  screenshotMimeTypeSchema,

  // =========================================
  // Enum / Literal Types - TypeScript Types
  // =========================================
  type SourceType,
  type UsageScope,
  type AwardSource,
  type SectionType,
  type MotionType,
  type AnalysisStatus,
  type CodeType,
  type ScreenshotMimeType,

  // =========================================
  // Interface Schemas
  // =========================================
  sourceInfoSchema,
  pageMetadataSchema,
  viewportInfoSchema,
  partialViewportInfoSchema,
  screenshotResultSchema,
  ingestOptionsSchema,
  ingestResultSchema,
  gridStructureSchema,
  componentNodeSchema,
  sectionPatternDataSchema,
  motionPatternDataSchema,
  qualityScoreSchema,
  layoutInspectResultSchema,
  codeGenerateOptionsSchema,
  generatedCodeResultSchema,

  // =========================================
  // Interface Types
  // =========================================
  type SourceInfo,
  type PageMetadata,
  type ViewportInfo,
  type PartialViewportInfo,
  type ScreenshotResult,
  type IngestOptions,
  type IngestResult,
  type GridStructure,
  type ComponentNode,
  type SectionPatternData,
  type MotionPatternData,
  type QualityScore,
  type LayoutInspectResult,
  type CodeGenerateOptions,
  type GeneratedCodeResult,

  // =========================================
  // Database Input Schemas & Types
  // =========================================
  webPageCreateInputSchema,
  sectionPatternCreateInputSchema,
  motionPatternCreateInputSchema,
  generatedCodeCreateInputSchema,
  type WebPageCreateInput,
  type SectionPatternCreateInput,
  type MotionPatternCreateInput,
  type GeneratedCodeCreateInput,
} from './types';
