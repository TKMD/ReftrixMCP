// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.inspect モジュールのエントリーポイント
 *
 * @module tools/layout/inspect
 */

// スキーマと型定義
export * from './inspect.schemas';

// Visual Extractors スキーマ（v0.1.0 新機能）
export * from './visual-extractors.schemas';

// ユーティリティ関数
export {
  detectSections,
  extractSectionContent,
  extractSectionStyle,
  extractColors,
  analyzeTypography,
  detectGrid,
  generateTextRepresentation,
  getDefaultColorPalette,
  getDefaultTypography,
  getDefaultGrid,
} from './inspect.utils';

// Visual Extractors ユーティリティ（v0.1.0 新機能）
export {
  extractVisualFeatures,
  extractCSSVariables,
  extractTypographyFeatures,
  detectGradients,
  detectGradientsFromImage,
  resetVisualExtractorServices,
  type VisualExtractionResult,
  type VisualExtractionOptions,
} from './visual-extractors.utils';

// ツールハンドラーと定義
export {
  layoutInspectHandler,
  layoutInspectToolDefinition,
  setLayoutInspectServiceFactory,
  resetLayoutInspectServiceFactory,
  type ILayoutInspectService,
} from './inspect.tool';
