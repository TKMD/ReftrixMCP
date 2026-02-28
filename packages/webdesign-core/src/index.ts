// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Webdesign Core
 * Web design analysis core library for Reftrix
 *
 * @module @reftrix/webdesign-core
 */

// Types
export * from './types';

// Section Detector
export { SectionDetector } from './section-detector';

// Section Classifier
export {
  SectionClassifier,
  type ClassificationRule,
  type ClassificationCondition,
  type ClassificationResult,
  type ContextualClassificationResult,
  type RangeValue,
} from './section-classifier';

// Text Representation Generator
export {
  TextRepresentationGenerator,
  type TextRepresentationOptions,
  type TextRepresentationResult,
  type ColorInfo,
  type TypographyInfo,
  type GridInfo,
  type LayoutInspectOutput,
} from './text-representation';

// Code Generator
export {
  CodeGenerator,
  type CodeGeneratorOptions,
  type GeneratedCode,
} from './code-generator';

// Quality Evaluator
export {
  // Anti AI Cliche Detector
  AntiAiClicheDetector,
  type ClichePattern,
  type ClicheDetectionResult,
  type DesignContext,
  type AntiAiClicheReport,
  type ClicheLayoutInfo,
  // Scoring System
  ScoringSystem,
  type ScoringWeights,
  type ScoringContext,
  type QualityScore,
  type AxisScore,
  type ScoreBreakdown,
  type ClicheReport,
  type DetectedCliche,
  type LayoutInfo,
  type LayoutSpacing,
  type ResponsiveInfo,
} from './quality-evaluator';

// Motion Detector
export {
  MotionDetector,
  type MotionPattern,
  type MotionProperty,
  type MotionDetectionResult,
  type MotionWarning,
  type MotionDetectorOptions,
  type KeyframeDefinition,
  type KeyframeStep,
  type CSSStyleProperties,
  // Motion Embedding
  MotionEmbedding,
  MotionFeatureExtractor,
  MOTION_EMBEDDING_DIM,
  type SimilarityResult,
} from './motion-detector';

// CSS Variable Resolver
export {
  CssVariableResolver,
  containsCssVariable,
  extractCssVariableNames,
  extractAndResolveColors,
  isValidColorValue,
  type CssVariableDefinition,
  type CssVariableResolutionResult,
  type CssVariableMap,
  type CssVariableResolverOptions,
} from './utils/css-variable-resolver';

// Pre-flight Probe Service
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
} from './services';

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
} from './services';
