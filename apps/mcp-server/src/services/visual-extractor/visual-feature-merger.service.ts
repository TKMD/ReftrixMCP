// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Feature Merger Service
 *
 * Merges deterministic extraction results (color, theme, density) with
 * Vision AI analysis results (mood, brandTone) into a unified structure.
 *
 * Design principles:
 * - Deterministic results have higher confidence (0.9-1.0)
 * - Vision AI results have capped confidence (0.6-0.8)
 * - Graceful degradation when either source is unavailable
 * - Type-safe interfaces for all inputs and outputs
 * - Fallback values for mood/brandTone when empty or low confidence
 * - Completeness score to indicate data coverage
 * - Warnings for low confidence or fallback usage
 *
 * @module services/visual-extractor/visual-feature-merger.service
 */

import type { ColorExtractionResult } from './color-extractor.service';
import type { ThemeDetectionResult } from './theme-detector.service';
import type { DensityCalculationResult } from './density-calculator.service';
import type {
  MoodAnalysisResult,
  EnhancedBrandToneResult,
  MoodType,
  BrandToneType,
} from '../vision-adapter/interface';
import { logger, isDevelopment } from '../../utils/logger';

// =============================================================================
// Confidence Constants
// =============================================================================

/**
 * Minimum confidence for deterministic results
 */
const DETERMINISTIC_CONFIDENCE_MIN = 0.9;

/**
 * Maximum confidence for deterministic results
 */
const DETERMINISTIC_CONFIDENCE_MAX = 1.0;

/**
 * Minimum confidence for Vision AI results
 */
const VISION_AI_CONFIDENCE_MIN = 0.6;

/**
 * Maximum confidence for Vision AI results
 */
const VISION_AI_CONFIDENCE_MAX = 0.8;

/**
 * Confidence threshold below which warnings are logged
 */
const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Default fallback mood value
 */
const FALLBACK_MOOD: MoodType = 'neutral';

/**
 * Default fallback brand tone value
 */
const FALLBACK_BRAND_TONE: BrandToneType = 'neutral';

/**
 * Fallback confidence score (lower than normal Vision AI confidence)
 */
const FALLBACK_CONFIDENCE = 0.3;

// =============================================================================
// Warning Types
// =============================================================================

/**
 * Warning codes for visionAnalysis
 */
export type VisionAnalysisWarningCode =
  | 'MOOD_FALLBACK_USED'
  | 'BRAND_TONE_FALLBACK_USED'
  | 'VISION_AI_UNAVAILABLE'
  | 'LOW_CONFIDENCE'
  | 'DETERMINISTIC_EXTRACTION_PARTIAL';

/**
 * Warning structure for visionAnalysis
 */
export interface VisionAnalysisWarning {
  /** Warning code */
  code: VisionAnalysisWarningCode;
  /** Warning message */
  message: string;
  /** Related field */
  field?: string;
  /** Additional details */
  details?: Record<string, unknown>;
}

// =============================================================================
// Input Types
// =============================================================================

/**
 * Input from Phase 1 deterministic extraction services
 */
export interface DeterministicExtractionInput {
  /** Color extraction result (optional) */
  colors?: ColorExtractionResult;
  /** Theme detection result (optional) */
  theme?: ThemeDetectionResult;
  /** Density calculation result (optional) */
  density?: DensityCalculationResult;
}

/**
 * Input from Phase 2-1 Vision AI analysis
 */
export interface VisionAIAnalysisInput {
  /** Mood analysis result (optional) */
  mood?: MoodAnalysisResult;
  /** Brand tone analysis result (optional) */
  brandTone?: EnhancedBrandToneResult;
}

// =============================================================================
// Output Types
// =============================================================================

/**
 * Merged color data with source and confidence
 */
export interface MergedColorData {
  /** Dominant colors in HEX format */
  dominant: string[];
  /** Accent colors in HEX format */
  accent: string[];
  /** Color palette with percentages */
  palette: Array<{ color: string; percentage: number }>;
  /** Data source */
  source: 'deterministic';
  /** Confidence score (0.9-1.0) */
  confidence: number;
}

/**
 * Merged theme data with source and confidence
 */
export interface MergedThemeData {
  /** Theme type: light, dark, or mixed */
  type: 'light' | 'dark' | 'mixed';
  /** Background color in HEX format */
  backgroundColor: string;
  /** Text color in HEX format */
  textColor: string;
  /** WCAG contrast ratio */
  contrastRatio: number;
  /** Data source */
  source: 'deterministic';
  /** Confidence score (0.9-1.0) */
  confidence: number;
}

/**
 * Merged density data with source and confidence
 */
export interface MergedDensityData {
  /** Content density (0-1) */
  contentDensity: number;
  /** Whitespace ratio (0-1) */
  whitespaceRatio: number;
  /** Visual balance score (0-100) */
  visualBalance: number;
  /** Data source */
  source: 'deterministic';
  /** Confidence score (0.9-1.0) */
  confidence: number;
}

/**
 * Merged mood data with source and confidence
 */
export interface MergedMoodData {
  /** Primary mood */
  primary: MoodType;
  /** Secondary mood (optional) */
  secondary?: MoodType | undefined;
  /** Data source */
  source: 'vision-ai' | 'fallback';
  /** Confidence score (0.6-0.8 for vision-ai, 0.3 for fallback) */
  confidence: number;
}

/**
 * Merged brand tone data with source and confidence
 */
export interface MergedBrandToneData {
  /** Primary brand tone */
  primary: BrandToneType;
  /** Secondary brand tone (optional) */
  secondary?: BrandToneType | undefined;
  /** Data source */
  source: 'vision-ai' | 'fallback';
  /** Confidence score (0.6-0.8 for vision-ai, 0.3 for fallback) */
  confidence: number;
}

/**
 * Metadata for merged visual features
 */
export interface MergeMetadata {
  /** ISO 8601 timestamp of merge operation */
  mergedAt: string;
  /** Whether deterministic data was available */
  deterministicAvailable: boolean;
  /** Whether Vision AI data was available */
  visionAiAvailable: boolean;
  /** Overall confidence score (0-1) */
  overallConfidence: number;
  /**
   * Completeness score (0-1)
   *
   * Indicates the coverage of required fields (colors, theme, density, mood, brandTone).
   * - 1.0: All required fields have valid data
   * - 0.8: 4/5 fields have valid data
   * - Fallback values count as 0.5 for the field
   */
  completeness: number;
  /** Warnings array */
  warnings: VisionAnalysisWarning[];
}

/**
 * Complete merged visual features structure
 *
 * Combines deterministic extraction (colors, theme, density) with
 * Vision AI analysis (mood, brandTone) into a unified interface.
 */
export interface MergedVisualFeatures {
  /** Merged color data (null if unavailable) */
  colors: MergedColorData | null;
  /** Merged theme data (null if unavailable) */
  theme: MergedThemeData | null;
  /** Merged density data (null if unavailable) */
  density: MergedDensityData | null;
  /** Merged mood data (null if unavailable, uses fallback if empty/low confidence) */
  mood: MergedMoodData | null;
  /** Merged brand tone data (null if unavailable, uses fallback if empty/low confidence) */
  brandTone: MergedBrandToneData | null;
  /** Merge operation metadata */
  metadata: MergeMetadata;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Options for merge operation
 */
export interface MergeOptions {
  /** Apply fallback values for mood/brandTone when empty or low confidence */
  applyFallbacks?: boolean;
  /** Force Vision AI unavailable (for testing) */
  forceVisionUnavailable?: boolean;
}

/**
 * Visual Feature Merger Service interface
 */
export interface VisualFeatureMergerService {
  /**
   * Merge deterministic extraction and Vision AI analysis results
   *
   * @param deterministicInput - Phase 1 deterministic extraction results (can be null)
   * @param visionAIInput - Phase 2-1 Vision AI analysis results (can be null)
   * @param options - Merge options
   * @returns Merged visual features with metadata
   * @throws Error if both inputs are null
   */
  merge(
    deterministicInput: DeterministicExtractionInput | null,
    visionAIInput: VisionAIAnalysisInput | null,
    options?: MergeOptions
  ): Promise<MergedVisualFeatures>;
}

// =============================================================================
// Service Implementation
// =============================================================================

/**
 * Internal implementation of VisualFeatureMergerService
 */
class VisualFeatureMergerServiceImpl implements VisualFeatureMergerService {
  /**
   * Merge deterministic extraction and Vision AI analysis results
   */
  async merge(
    deterministicInput: DeterministicExtractionInput | null,
    visionAIInput: VisionAIAnalysisInput | null,
    options: MergeOptions = {}
  ): Promise<MergedVisualFeatures> {
    const { applyFallbacks = false, forceVisionUnavailable = false } = options;
    const warnings: VisionAnalysisWarning[] = [];

    // Validate that at least one input is provided
    if (deterministicInput === null && visionAIInput === null) {
      throw new Error('At least one input source must be provided');
    }

    // Determine availability
    const deterministicAvailable = this.hasDeterministicData(deterministicInput);
    const visionAiAvailable = forceVisionUnavailable
      ? false
      : this.hasVisionAIData(visionAIInput);

    // Track partial deterministic extraction
    if (deterministicInput !== null) {
      const missingFields: string[] = [];
      if (deterministicInput.colors === undefined) missingFields.push('colors');
      if (deterministicInput.theme === undefined) missingFields.push('theme');
      if (deterministicInput.density === undefined) missingFields.push('density');

      const availableCount = 3 - missingFields.length;
      if (availableCount > 0 && availableCount < 3) {
        warnings.push({
          code: 'DETERMINISTIC_EXTRACTION_PARTIAL',
          message: `Only ${availableCount}/3 deterministic extraction fields available`,
          details: {
            hasColors: deterministicInput.colors !== undefined,
            hasTheme: deterministicInput.theme !== undefined,
            hasDensity: deterministicInput.density !== undefined,
            missingFields,
          },
        });
      }
    }

    // Add Vision AI unavailable warning if applicable
    if (!visionAiAvailable && !forceVisionUnavailable && visionAIInput === null) {
      warnings.push({
        code: 'VISION_AI_UNAVAILABLE',
        message: 'Vision AI analysis was not available. Mood and brandTone may use fallback values.',
      });
    }

    // Merge each component
    const colors = this.mergeColors(deterministicInput?.colors);
    const theme = this.mergeTheme(deterministicInput?.theme);
    const density = this.mergeDensity(deterministicInput?.density);

    // Merge mood with fallback support
    const moodResult = this.mergeMoodWithFallback(
      visionAIInput?.mood,
      applyFallbacks,
      warnings
    );

    // Merge brandTone with fallback support
    const brandToneResult = this.mergeBrandToneWithFallback(
      visionAIInput?.brandTone,
      applyFallbacks,
      warnings
    );

    // Calculate overall confidence
    const overallConfidence = this.calculateOverallConfidence(
      colors,
      theme,
      density,
      moodResult,
      brandToneResult,
      deterministicAvailable,
      visionAiAvailable
    );

    // Calculate completeness score
    const completeness = this.calculateCompleteness(
      colors,
      theme,
      density,
      moodResult,
      brandToneResult
    );

    // Log warning for low overall confidence
    if (overallConfidence < LOW_CONFIDENCE_THRESHOLD) {
      const warningMsg = `Overall confidence is low (${overallConfidence.toFixed(2)})`;
      warnings.push({
        code: 'LOW_CONFIDENCE',
        message: warningMsg,
        details: {
          overallConfidence,
          threshold: LOW_CONFIDENCE_THRESHOLD,
        },
      });

      if (isDevelopment()) {
        logger.warn(`[VisualFeatureMerger] ${warningMsg}`, {
          overallConfidence,
          deterministicAvailable,
          visionAiAvailable,
        });
      }
    }

    // Build metadata
    const metadata: MergeMetadata = {
      mergedAt: new Date().toISOString(),
      deterministicAvailable,
      visionAiAvailable,
      overallConfidence,
      completeness,
      warnings,
    };

    if (isDevelopment()) {
      logger.info('[VisualFeatureMerger] Merge completed', {
        deterministicAvailable,
        visionAiAvailable,
        overallConfidence: overallConfidence.toFixed(3),
        completeness: completeness.toFixed(3),
        hasColors: colors !== null,
        hasTheme: theme !== null,
        hasDensity: density !== null,
        hasMood: moodResult !== null,
        hasBrandTone: brandToneResult !== null,
        moodSource: moodResult?.source,
        brandToneSource: brandToneResult?.source,
        warningCount: warnings.length,
      });
    }

    return {
      colors,
      theme,
      density,
      mood: moodResult,
      brandTone: brandToneResult,
      metadata,
    };
  }

  /**
   * Check if deterministic input has any data
   */
  private hasDeterministicData(input: DeterministicExtractionInput | null): boolean {
    if (input === null) return false;
    return (
      input.colors !== undefined ||
      input.theme !== undefined ||
      input.density !== undefined
    );
  }

  /**
   * Check if Vision AI input has any data
   */
  private hasVisionAIData(input: VisionAIAnalysisInput | null): boolean {
    if (input === null) return false;
    return input.mood !== undefined || input.brandTone !== undefined;
  }

  /**
   * Merge color extraction result
   */
  private mergeColors(
    colors: ColorExtractionResult | undefined
  ): MergedColorData | null {
    if (colors === undefined) {
      return null;
    }

    return {
      dominant: colors.dominantColors,
      accent: colors.accentColors,
      palette: colors.colorPalette.map((p) => ({
        color: p.color,
        percentage: p.percentage,
      })),
      source: 'deterministic',
      confidence: this.calculateDeterministicConfidence(),
    };
  }

  /**
   * Merge theme detection result
   */
  private mergeTheme(
    theme: ThemeDetectionResult | undefined
  ): MergedThemeData | null {
    if (theme === undefined) {
      return null;
    }

    return {
      type: theme.theme,
      backgroundColor: theme.backgroundColor,
      textColor: theme.textColor,
      contrastRatio: theme.contrastRatio,
      source: 'deterministic',
      confidence: this.calculateDeterministicConfidence(theme.confidence),
    };
  }

  /**
   * Merge density calculation result
   */
  private mergeDensity(
    density: DensityCalculationResult | undefined
  ): MergedDensityData | null {
    if (density === undefined) {
      return null;
    }

    return {
      contentDensity: density.contentDensity,
      whitespaceRatio: density.whitespaceRatio,
      visualBalance: density.visualBalance,
      source: 'deterministic',
      confidence: this.calculateDeterministicConfidence(),
    };
  }

  /**
   * Merge mood analysis result with fallback support
   *
   * If mood is undefined or has low confidence, apply fallback value.
   */
  private mergeMoodWithFallback(
    mood: MoodAnalysisResult | undefined,
    applyFallbacks: boolean,
    warnings: VisionAnalysisWarning[]
  ): MergedMoodData | null {
    // Check if mood data is valid
    const hasValidMood = mood !== undefined && mood.primaryMood !== undefined;
    const hasLowConfidence = mood !== undefined && mood.confidence < LOW_CONFIDENCE_THRESHOLD;

    // If valid mood, use it (even with low confidence, but add warning)
    if (hasValidMood) {
      // Add warning for low confidence
      if (hasLowConfidence) {
        warnings.push({
          code: 'LOW_CONFIDENCE',
          message: `Mood analysis has low confidence (${mood!.confidence.toFixed(2)})`,
          field: 'mood',
          details: {
            confidence: mood!.confidence,
            threshold: LOW_CONFIDENCE_THRESHOLD,
          },
        });

        if (isDevelopment()) {
          logger.warn(`[VisualFeatureMerger] Low confidence mood: ${mood!.confidence.toFixed(2)}`, {
            primaryMood: mood!.primaryMood,
            confidence: mood!.confidence,
          });
        }
      }

      return {
        primary: mood!.primaryMood,
        secondary: mood!.secondaryMood,
        source: 'vision-ai',
        confidence: this.calculateVisionAIConfidence(mood!.confidence),
      };
    }

    // Apply fallback if enabled (only when no valid mood)
    if (applyFallbacks) {
      warnings.push({
        code: 'MOOD_FALLBACK_USED',
        message: `Mood analysis empty. Using fallback value: ${FALLBACK_MOOD}`,
        field: 'mood',
        details: {
          originalConfidence: mood?.confidence,
          fallbackValue: FALLBACK_MOOD,
        },
      });

      if (isDevelopment()) {
        logger.warn(`[VisualFeatureMerger] Mood fallback used: empty result`, {
          fallbackValue: FALLBACK_MOOD,
        });
      }

      return {
        primary: FALLBACK_MOOD,
        secondary: undefined,
        source: 'fallback',
        confidence: FALLBACK_CONFIDENCE,
      };
    }

    // No fallback, return null
    return null;
  }

  /**
   * Merge brand tone analysis result with fallback support
   *
   * If brandTone is undefined or has low confidence, apply fallback value.
   */
  private mergeBrandToneWithFallback(
    brandTone: EnhancedBrandToneResult | undefined,
    applyFallbacks: boolean,
    warnings: VisionAnalysisWarning[]
  ): MergedBrandToneData | null {
    // Check if brandTone data is valid
    const hasValidBrandTone =
      brandTone !== undefined && brandTone.primaryTone !== undefined;
    const hasLowConfidence =
      brandTone !== undefined && brandTone.confidence < LOW_CONFIDENCE_THRESHOLD;

    // If valid brandTone, use it (even with low confidence, but add warning)
    if (hasValidBrandTone) {
      // Add warning for low confidence
      if (hasLowConfidence) {
        warnings.push({
          code: 'LOW_CONFIDENCE',
          message: `Brand tone analysis has low confidence (${brandTone!.confidence.toFixed(2)})`,
          field: 'brandTone',
          details: {
            confidence: brandTone!.confidence,
            threshold: LOW_CONFIDENCE_THRESHOLD,
          },
        });

        if (isDevelopment()) {
          logger.warn(`[VisualFeatureMerger] Low confidence brandTone: ${brandTone!.confidence.toFixed(2)}`, {
            primaryTone: brandTone!.primaryTone,
            confidence: brandTone!.confidence,
          });
        }
      }

      return {
        primary: brandTone!.primaryTone,
        secondary: brandTone!.secondaryTone,
        source: 'vision-ai',
        confidence: this.calculateVisionAIConfidence(brandTone!.confidence),
      };
    }

    // Apply fallback if enabled (only when no valid brandTone)
    if (applyFallbacks) {
      warnings.push({
        code: 'BRAND_TONE_FALLBACK_USED',
        message: `Brand tone analysis empty. Using fallback value: ${FALLBACK_BRAND_TONE}`,
        field: 'brandTone',
        details: {
          originalConfidence: brandTone?.confidence,
          fallbackValue: FALLBACK_BRAND_TONE,
        },
      });

      if (isDevelopment()) {
        logger.warn(`[VisualFeatureMerger] BrandTone fallback used: empty result`, {
          fallbackValue: FALLBACK_BRAND_TONE,
        });
      }

      return {
        primary: FALLBACK_BRAND_TONE,
        secondary: undefined,
        source: 'fallback',
        confidence: FALLBACK_CONFIDENCE,
      };
    }

    // No fallback, return null
    return null;
  }

  /**
   * Calculate confidence for deterministic results (0.9-1.0)
   *
   * Uses the source confidence as a base and maps it to the deterministic range.
   */
  private calculateDeterministicConfidence(sourceConfidence?: number): number {
    if (sourceConfidence === undefined) {
      // Default to high confidence for deterministic results
      return 0.95;
    }

    // Map source confidence (0-1) to deterministic range (0.9-1.0)
    const range = DETERMINISTIC_CONFIDENCE_MAX - DETERMINISTIC_CONFIDENCE_MIN;
    return DETERMINISTIC_CONFIDENCE_MIN + sourceConfidence * range;
  }

  /**
   * Calculate confidence for Vision AI results (0.6-0.8)
   *
   * Clamps the source confidence to the Vision AI confidence range.
   */
  private calculateVisionAIConfidence(sourceConfidence: number): number {
    // Map source confidence (0-1) to Vision AI range (0.6-0.8)
    const range = VISION_AI_CONFIDENCE_MAX - VISION_AI_CONFIDENCE_MIN;
    const mappedConfidence = VISION_AI_CONFIDENCE_MIN + sourceConfidence * range;

    // Clamp to the valid range
    return Math.max(
      VISION_AI_CONFIDENCE_MIN,
      Math.min(VISION_AI_CONFIDENCE_MAX, mappedConfidence)
    );
  }

  /**
   * Calculate overall confidence based on available components
   */
  private calculateOverallConfidence(
    colors: MergedColorData | null,
    theme: MergedThemeData | null,
    density: MergedDensityData | null,
    mood: MergedMoodData | null,
    brandTone: MergedBrandToneData | null,
    deterministicAvailable: boolean,
    visionAiAvailable: boolean
  ): number {
    const confidences: number[] = [];
    const weights: number[] = [];

    // Deterministic components have higher weight
    if (colors !== null) {
      confidences.push(colors.confidence);
      weights.push(1.2); // Higher weight for deterministic
    }
    if (theme !== null) {
      confidences.push(theme.confidence);
      weights.push(1.2);
    }
    if (density !== null) {
      confidences.push(density.confidence);
      weights.push(1.2);
    }

    // Vision AI components have standard weight
    // Fallback sources get reduced weight
    if (mood !== null) {
      const weight = mood.source === 'fallback' ? 0.5 : 1.0;
      confidences.push(mood.confidence);
      weights.push(weight);
    }
    if (brandTone !== null) {
      const weight = brandTone.source === 'fallback' ? 0.5 : 1.0;
      confidences.push(brandTone.confidence);
      weights.push(weight);
    }

    if (confidences.length === 0) {
      return 0;
    }

    // Weighted average
    let totalWeight = 0;
    let weightedSum = 0;
    for (let i = 0; i < confidences.length; i++) {
      weightedSum += confidences[i]! * weights[i]!;
      totalWeight += weights[i]!;
    }

    let overallConfidence = weightedSum / totalWeight;

    // Apply penalty if only one source is available
    if (!deterministicAvailable || !visionAiAvailable) {
      overallConfidence *= 0.9; // 10% penalty for partial data
    }

    return Math.min(1.0, overallConfidence);
  }

  /**
   * Calculate completeness score based on available fields
   *
   * Required fields: colors, theme, density, mood, brandTone
   * - Valid data = 1.0 for that field
   * - Fallback data = 0.5 for that field
   * - Null/missing = 0.0 for that field
   *
   * @returns Completeness score (0-1)
   */
  private calculateCompleteness(
    colors: MergedColorData | null,
    theme: MergedThemeData | null,
    density: MergedDensityData | null,
    mood: MergedMoodData | null,
    brandTone: MergedBrandToneData | null
  ): number {
    const TOTAL_FIELDS = 5;
    let score = 0;

    // Deterministic fields (full score if present)
    if (colors !== null) score += 1.0;
    if (theme !== null) score += 1.0;
    if (density !== null) score += 1.0;

    // Vision AI fields (reduced score for fallback)
    if (mood !== null) {
      score += mood.source === 'fallback' ? 0.5 : 1.0;
    }
    if (brandTone !== null) {
      score += brandTone.source === 'fallback' ? 0.5 : 1.0;
    }

    return score / TOTAL_FIELDS;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new VisualFeatureMergerService instance
 *
 * @returns VisualFeatureMergerService instance
 *
 * @example
 * ```typescript
 * const merger = createVisualFeatureMerger();
 *
 * // With Vision AI data
 * const result = await merger.merge(
 *   { colors, theme, density },
 *   { mood, brandTone }
 * );
 *
 * // Without Vision AI data (uses fallbacks)
 * const resultWithFallbacks = await merger.merge(
 *   { colors, theme, density },
 *   null
 * );
 *
 * // Check completeness
 * console.log(result.metadata.completeness); // 0.85
 * console.log(result.metadata.warnings); // []
 * ```
 */
export function createVisualFeatureMerger(): VisualFeatureMergerService {
  return new VisualFeatureMergerServiceImpl();
}
