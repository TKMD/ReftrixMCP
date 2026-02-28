// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision Adapter - 公開エクスポート
 *
 * ビジョン解析アダプタの型定義、インターフェース、型ガード関数をエクスポートします。
 *
 * @module vision-adapter
 * @see docs/plans/webdesign/00-overview.md
 */

// インターフェース
export type {
  IVisionAnalyzer,
  VisionAdapterFactory,
} from './interface';

// 入力オプション
export type { VisionAnalysisOptions } from './interface';

// 結果型
export type {
  VisionAnalysisResult,
  VisionFeature,
  VisionFeatureType,
  VisionFeatureData,
} from './interface';

// 各特徴データ型
export type {
  LayoutStructureData,
  ColorPaletteData,
  TypographyData,
  VisualHierarchyData,
  WhitespaceData,
  DensityData,
  RhythmData,
  SectionBoundariesData,
} from './interface';

// 型ガード関数
export {
  isLayoutStructureData,
  isColorPaletteData,
  isTypographyData,
  isVisualHierarchyData,
  isWhitespaceData,
  isDensityData,
  isRhythmData,
  isSectionBoundariesData,
} from './interface';

// Zodスキーマ
export {
  visionAnalysisOptionsSchema,
  visionAnalysisResultSchema,
  visionFeatureSchema,
  visionFeatureTypeSchema,
} from './interface';

// MockVisionAdapter
export { MockVisionAdapter, type MockVisionAdapterConfig } from './mock.adapter';

// LlamaVisionAdapter
export {
  LlamaVisionAdapter,
  type LlamaVisionAdapterConfig,
} from './llama-vision.adapter';

// LocalVisionAdapter (OSS-based, no external LLM dependency)
export {
  LocalVisionAdapter,
  type LocalVisionAdapterConfig,
  type ColorExtractionOptions,
  type DensityAnalysisOptions,
} from './local.adapter';
