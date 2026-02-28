// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Services
 *
 * @module @reftrix/webdesign-core/services
 */

export {
  PreflightProbeService,
  preflightProbeService,
  analyzeComplexity,
  calculateMultiplier,
  BASE_TIMEOUT,
  MAX_TIMEOUT,
  DEFAULT_TIMEOUT,
  PROBE_TIMEOUT,
  PROBE_VERSION,
  type ProbeResult,
  type ComplexityAnalysis,
  type IPreflightProbeService,
} from './preflight-probe.service';

// Element Visibility Detector
export {
  ElementVisibilityDetector,
  createElementVisibilityDetector,
  type ElementVisibilityDetectorOptions,
  type ElementVisibilityEvent,
  type ElementVisibilityResult,
  type ElementVisibilityError,
  type FrameData,
  type BoundingBox,
  type VisibilityEventType,
} from './element-visibility-detector';
