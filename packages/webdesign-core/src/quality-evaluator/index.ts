// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Quality Evaluator Module
 *
 * Provides tools for evaluating web design quality across multiple dimensions:
 *
 * 1. AntiAiClicheDetector: Detects AI-generated design cliches
 * 2. ScoringSystem: Evaluates designs on three axes (Originality, Craftsmanship, Contextuality)
 *
 * @module @reftrix/webdesign-core/quality-evaluator
 */

// Anti AI Cliche Detector
export {
  AntiAiClicheDetector,
  type ClichePattern,
  type ClicheDetectionResult,
  type DesignContext,
  // Renamed to avoid collision with ScoringSystem types
  type ClicheReport as AntiAiClicheReport,
  type LayoutInfo as ClicheLayoutInfo,
} from './anti-ai-cliche';

// Scoring System
export {
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
} from './scoring-system';
