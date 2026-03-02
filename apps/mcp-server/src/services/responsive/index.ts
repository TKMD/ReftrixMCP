// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Analysis Services
 * レスポンシブ解析関連サービスのエクスポート
 *
 * @module services/responsive
 */

// Types
export * from './types';

// Shared utilities
export {
  SharedBrowserManager,
  USER_AGENTS,
} from './shared-browser-manager';

// Services
export {
  ResponsiveAnalysisService,
  responsiveAnalysisService,
  DEFAULT_VIEWPORTS,
} from './responsive-analysis.service';

export {
  MultiViewportCaptureService,
  multiViewportCaptureService,
} from './multi-viewport-capture.service';

export {
  DifferenceDetectorService,
  differenceDetectorService,
  type DifferenceDetectionResult,
  type DifferenceSummary,
} from './difference-detector.service';

export {
  ViewportDiffService,
  viewportDiffService,
  type ViewportDiffOptions,
} from './viewport-diff.service';

export {
  ResponsivePersistenceService,
  responsivePersistenceService,
  type ResponsivePersistenceInput,
  type ResponsiveAnalysisRecord,
} from './responsive-persistence.service';

export {
  ResponsiveQualityEvaluatorService,
  responsiveQualityEvaluatorService,
} from './responsive-quality-evaluator.service';

// Embedding
export {
  generateResponsiveAnalysisTextRepresentation,
  generateResponsiveAnalysisEmbeddings,
  setResponsiveEmbeddingServiceFactory,
  resetResponsiveEmbeddingServiceFactory,
  setResponsivePrismaClientFactory,
  resetResponsivePrismaClientFactory,
  type ResponsiveAnalysisForText,
  type ResponsiveAnalysisEmbeddingResult,
} from './responsive-analysis-embedding.service';
