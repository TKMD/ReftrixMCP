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
