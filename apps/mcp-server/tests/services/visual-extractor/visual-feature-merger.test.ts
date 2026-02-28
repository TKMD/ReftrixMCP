// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Feature Merger Service Tests
 *
 * TDD Phase: Red
 * Tests for merging deterministic extraction results with Vision AI analysis results.
 *
 * @module tests/services/visual-extractor/visual-feature-merger.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ColorExtractionResult } from '../../../src/services/visual-extractor/color-extractor.service';
import type { ThemeDetectionResult } from '../../../src/services/visual-extractor/theme-detector.service';
import type { DensityCalculationResult } from '../../../src/services/visual-extractor/density-calculator.service';
import type {
  MoodAnalysisResult,
  EnhancedBrandToneResult,
} from '../../../src/services/vision-adapter/interface';
import {
  createVisualFeatureMerger,
  type VisualFeatureMergerService,
  type MergedVisualFeatures,
  type DeterministicExtractionInput,
  type VisionAIAnalysisInput,
} from '../../../src/services/visual-extractor/visual-feature-merger.service';

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create mock color extraction result
 */
function createMockColorExtractionResult(
  overrides?: Partial<ColorExtractionResult>
): ColorExtractionResult {
  return {
    dominantColors: ['#3B82F6', '#1E40AF', '#FFFFFF'],
    accentColors: ['#F59E0B', '#10B981'],
    colorPalette: [
      { color: '#3B82F6', percentage: 40 },
      { color: '#1E40AF', percentage: 25 },
      { color: '#FFFFFF', percentage: 20 },
      { color: '#F59E0B', percentage: 10 },
      { color: '#10B981', percentage: 5 },
    ],
    ...overrides,
  };
}

/**
 * Create mock theme detection result
 */
function createMockThemeDetectionResult(
  overrides?: Partial<ThemeDetectionResult>
): ThemeDetectionResult {
  return {
    theme: 'light',
    confidence: 0.95,
    backgroundColor: '#FFFFFF',
    textColor: '#1F2937',
    contrastRatio: 12.63,
    luminance: {
      background: 1.0,
      foreground: 0.117,
    },
    ...overrides,
  };
}

/**
 * Create mock density calculation result
 */
function createMockDensityCalculationResult(
  overrides?: Partial<DensityCalculationResult>
): DensityCalculationResult {
  return {
    contentDensity: 0.45,
    whitespaceRatio: 0.55,
    visualBalance: 85,
    regions: [
      { row: 0, col: 0, density: 0.3, dominantColor: '#FFFFFF' },
      { row: 0, col: 1, density: 0.5, dominantColor: '#3B82F6' },
      { row: 1, col: 0, density: 0.6, dominantColor: '#1E40AF' },
      { row: 1, col: 1, density: 0.4, dominantColor: '#FFFFFF' },
    ],
    metrics: {
      edgeDensity: 0.32,
      colorVariance: 0.18,
      symmetryScore: 0.78,
    },
    ...overrides,
  };
}

/**
 * Create mock mood analysis result
 */
function createMockMoodAnalysisResult(
  overrides?: Partial<MoodAnalysisResult>
): MoodAnalysisResult {
  return {
    primaryMood: 'professional',
    secondaryMood: 'modern',
    confidence: 0.75,
    indicators: ['clean typography', 'blue color scheme', 'structured layout'],
    colorContextUsed: true,
    ...overrides,
  };
}

/**
 * Create mock brand tone result
 */
function createMockBrandToneResult(
  overrides?: Partial<EnhancedBrandToneResult>
): EnhancedBrandToneResult {
  return {
    primaryTone: 'corporate',
    secondaryTone: 'trustworthy',
    confidence: 0.72,
    professionalism: 'bold',
    warmth: 'neutral',
    modernity: 'contemporary',
    energy: 'balanced',
    targetAudience: 'enterprise',
    indicators: ['formal color palette', 'clean design'],
    colorContextUsed: true,
    ...overrides,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('VisualFeatureMergerService', () => {
  let service: VisualFeatureMergerService;

  beforeEach(() => {
    service = createVisualFeatureMerger();
  });

  // ===========================================================================
  // Basic Functionality Tests
  // ===========================================================================

  describe('merge()', () => {
    describe('with all inputs available', () => {
      it('should merge deterministic and Vision AI results', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result).toBeDefined();
        expect(result.colors).toBeDefined();
        expect(result.theme).toBeDefined();
        expect(result.density).toBeDefined();
        expect(result.mood).toBeDefined();
        expect(result.brandTone).toBeDefined();
        expect(result.metadata).toBeDefined();
      });

      it('should set correct source for deterministic results', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.colors.source).toBe('deterministic');
        expect(result.theme.source).toBe('deterministic');
        expect(result.density.source).toBe('deterministic');
      });

      it('should set correct source for Vision AI results', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.mood.source).toBe('vision-ai');
        expect(result.brandTone.source).toBe('vision-ai');
      });

      it('should preserve color extraction data', async () => {
        const colorResult = createMockColorExtractionResult();
        const deterministicInput: DeterministicExtractionInput = {
          colors: colorResult,
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.colors.dominant).toEqual(colorResult.dominantColors);
        expect(result.colors.accent).toEqual(colorResult.accentColors);
        expect(result.colors.palette).toEqual(
          colorResult.colorPalette.map((p) => ({
            color: p.color,
            percentage: p.percentage,
          }))
        );
      });

      it('should preserve theme detection data', async () => {
        const themeResult = createMockThemeDetectionResult();
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: themeResult,
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.theme.type).toBe(themeResult.theme);
        expect(result.theme.backgroundColor).toBe(themeResult.backgroundColor);
        expect(result.theme.textColor).toBe(themeResult.textColor);
        expect(result.theme.contrastRatio).toBe(themeResult.contrastRatio);
      });

      it('should preserve density calculation data', async () => {
        const densityResult = createMockDensityCalculationResult();
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: densityResult,
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.density.contentDensity).toBe(densityResult.contentDensity);
        expect(result.density.whitespaceRatio).toBe(densityResult.whitespaceRatio);
        expect(result.density.visualBalance).toBe(densityResult.visualBalance);
      });

      it('should preserve mood analysis data', async () => {
        const moodResult = createMockMoodAnalysisResult();
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: moodResult,
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.mood.primary).toBe(moodResult.primaryMood);
        expect(result.mood.secondary).toBe(moodResult.secondaryMood);
      });

      it('should preserve brand tone analysis data', async () => {
        const brandToneResult = createMockBrandToneResult();
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: brandToneResult,
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.brandTone.primary).toBe(brandToneResult.primaryTone);
        expect(result.brandTone.secondary).toBe(brandToneResult.secondaryTone);
      });
    });
  });

  // ===========================================================================
  // Confidence Scoring Tests
  // ===========================================================================

  describe('confidence scoring', () => {
    it('should assign 0.9-1.0 confidence for deterministic results', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult({ confidence: 0.95 }),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      // Deterministic sources should have confidence >= 0.9
      expect(result.colors.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.colors.confidence).toBeLessThanOrEqual(1.0);
      expect(result.theme.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.theme.confidence).toBeLessThanOrEqual(1.0);
      expect(result.density.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.density.confidence).toBeLessThanOrEqual(1.0);
    });

    it('should assign 0.6-0.8 confidence for Vision AI results', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult({ confidence: 0.75 }),
        brandTone: createMockBrandToneResult({ confidence: 0.72 }),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      // Vision AI sources should have confidence capped at 0.6-0.8
      expect(result.mood.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.mood.confidence).toBeLessThanOrEqual(0.8);
      expect(result.brandTone.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.brandTone.confidence).toBeLessThanOrEqual(0.8);
    });

    it('should cap high Vision AI confidence at 0.8', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult({ confidence: 0.95 }), // High confidence
        brandTone: createMockBrandToneResult({ confidence: 0.92 }), // High confidence
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      expect(result.mood.confidence).toBeLessThanOrEqual(0.8);
      expect(result.brandTone.confidence).toBeLessThanOrEqual(0.8);
    });

    it('should set low Vision AI confidence to 0.6 minimum', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult({ confidence: 0.3 }), // Low confidence
        brandTone: createMockBrandToneResult({ confidence: 0.2 }), // Low confidence
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      expect(result.mood.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.brandTone.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it('should calculate overall confidence correctly', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult({ confidence: 0.95 }),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult({ confidence: 0.75 }),
        brandTone: createMockBrandToneResult({ confidence: 0.72 }),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      // Overall confidence should be calculated from all components
      expect(result.metadata.overallConfidence).toBeGreaterThan(0);
      expect(result.metadata.overallConfidence).toBeLessThanOrEqual(1.0);
    });
  });

  // ===========================================================================
  // Graceful Degradation Tests
  // ===========================================================================

  describe('graceful degradation', () => {
    describe('when Vision AI is unavailable', () => {
      it('should return valid result with only deterministic data', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const result = await service.merge(deterministicInput, null);

        expect(result).toBeDefined();
        expect(result.colors).toBeDefined();
        expect(result.theme).toBeDefined();
        expect(result.density).toBeDefined();
        expect(result.metadata.deterministicAvailable).toBe(true);
        expect(result.metadata.visionAiAvailable).toBe(false);
      });

      it('should provide null mood when Vision AI unavailable', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const result = await service.merge(deterministicInput, null);

        expect(result.mood).toBeNull();
        expect(result.brandTone).toBeNull();
      });

      it('should set lower overall confidence when Vision AI unavailable', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const fullResult = await service.merge(deterministicInput, visionAIInput);
        const partialResult = await service.merge(deterministicInput, null);

        // Partial result should have slightly lower overall confidence
        expect(partialResult.metadata.overallConfidence).toBeLessThanOrEqual(
          fullResult.metadata.overallConfidence
        );
      });
    });

    describe('when deterministic extraction is unavailable', () => {
      it('should return valid result with only Vision AI data', async () => {
        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(null, visionAIInput);

        expect(result).toBeDefined();
        expect(result.mood).toBeDefined();
        expect(result.brandTone).toBeDefined();
        expect(result.metadata.deterministicAvailable).toBe(false);
        expect(result.metadata.visionAiAvailable).toBe(true);
      });

      it('should provide null colors/theme/density when deterministic unavailable', async () => {
        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(null, visionAIInput);

        expect(result.colors).toBeNull();
        expect(result.theme).toBeNull();
        expect(result.density).toBeNull();
      });
    });

    describe('when both sources are unavailable', () => {
      it('should throw an error when both inputs are null', async () => {
        await expect(service.merge(null, null)).rejects.toThrow(
          'At least one input source must be provided'
        );
      });
    });

    describe('partial Vision AI availability', () => {
      it('should handle missing mood', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: undefined,
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.mood).toBeNull();
        expect(result.brandTone).toBeDefined();
      });

      it('should handle missing brandTone', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: undefined,
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.mood).toBeDefined();
        expect(result.brandTone).toBeNull();
      });
    });

    describe('partial deterministic availability', () => {
      it('should handle missing colors', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: undefined,
          theme: createMockThemeDetectionResult(),
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.colors).toBeNull();
        expect(result.theme).toBeDefined();
        expect(result.density).toBeDefined();
      });

      it('should handle missing theme', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: undefined,
          density: createMockDensityCalculationResult(),
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.colors).toBeDefined();
        expect(result.theme).toBeNull();
        expect(result.density).toBeDefined();
      });

      it('should handle missing density', async () => {
        const deterministicInput: DeterministicExtractionInput = {
          colors: createMockColorExtractionResult(),
          theme: createMockThemeDetectionResult(),
          density: undefined,
        };

        const visionAIInput: VisionAIAnalysisInput = {
          mood: createMockMoodAnalysisResult(),
          brandTone: createMockBrandToneResult(),
        };

        const result = await service.merge(deterministicInput, visionAIInput);

        expect(result.colors).toBeDefined();
        expect(result.theme).toBeDefined();
        expect(result.density).toBeNull();
      });
    });
  });

  // ===========================================================================
  // Metadata Tests
  // ===========================================================================

  describe('metadata', () => {
    it('should include mergedAt timestamp', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const beforeMerge = new Date().toISOString();
      const result = await service.merge(deterministicInput, visionAIInput);
      const afterMerge = new Date().toISOString();

      expect(result.metadata.mergedAt).toBeDefined();
      expect(result.metadata.mergedAt >= beforeMerge).toBe(true);
      expect(result.metadata.mergedAt <= afterMerge).toBe(true);
    });

    it('should indicate deterministicAvailable correctly', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const fullResult = await service.merge(deterministicInput, visionAIInput);
      expect(fullResult.metadata.deterministicAvailable).toBe(true);

      const visionOnlyResult = await service.merge(null, visionAIInput);
      expect(visionOnlyResult.metadata.deterministicAvailable).toBe(false);
    });

    it('should indicate visionAiAvailable correctly', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const fullResult = await service.merge(deterministicInput, visionAIInput);
      expect(fullResult.metadata.visionAiAvailable).toBe(true);

      const deterministicOnlyResult = await service.merge(deterministicInput, null);
      expect(deterministicOnlyResult.metadata.visionAiAvailable).toBe(false);
    });
  });

  // ===========================================================================
  // Type Safety Tests
  // ===========================================================================

  describe('type safety', () => {
    it('should return MergedVisualFeatures type', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      // Type assertions to verify structure
      const _colors: MergedVisualFeatures['colors'] = result.colors!;
      const _theme: MergedVisualFeatures['theme'] = result.theme!;
      const _density: MergedVisualFeatures['density'] = result.density!;
      const _mood: MergedVisualFeatures['mood'] = result.mood!;
      const _brandTone: MergedVisualFeatures['brandTone'] = result.brandTone!;
      const _metadata: MergedVisualFeatures['metadata'] = result.metadata;

      // Verify non-null assertions compile
      expect(_colors).toBeDefined();
      expect(_theme).toBeDefined();
      expect(_density).toBeDefined();
      expect(_mood).toBeDefined();
      expect(_brandTone).toBeDefined();
      expect(_metadata).toBeDefined();
    });
  });

  // ===========================================================================
  // Edge Cases Tests
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle empty color arrays', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult({
          dominantColors: [],
          accentColors: [],
          colorPalette: [],
        }),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      expect(result.colors).toBeDefined();
      expect(result.colors!.dominant).toEqual([]);
      expect(result.colors!.accent).toEqual([]);
      expect(result.colors!.palette).toEqual([]);
    });

    it('should handle extreme confidence values in theme detection', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult({ confidence: 0.01 }),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      // Even with low source confidence, deterministic should have >= 0.9 confidence
      expect(result.theme!.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should handle mixed theme type', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult({ theme: 'mixed' }),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      expect(result.theme!.type).toBe('mixed');
    });

    it('should handle missing secondary mood', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult({ secondaryMood: undefined }),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      expect(result.mood!.secondary).toBeUndefined();
    });

    it('should handle missing secondary brand tone', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult({ secondaryTone: undefined }),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      expect(result.brandTone!.secondary).toBeUndefined();
    });

    it('should handle zero density values', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult({
          contentDensity: 0,
          whitespaceRatio: 1.0,
          visualBalance: 0,
        }),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      expect(result.density!.contentDensity).toBe(0);
      expect(result.density!.whitespaceRatio).toBe(1.0);
      expect(result.density!.visualBalance).toBe(0);
    });

    it('should handle maximum density values', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult({
          contentDensity: 1.0,
          whitespaceRatio: 0,
          visualBalance: 100,
        }),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      expect(result.density!.contentDensity).toBe(1.0);
      expect(result.density!.whitespaceRatio).toBe(0);
      expect(result.density!.visualBalance).toBe(100);
    });
  });

  // ===========================================================================
  // Completeness Score Tests (REFTRIX-VISION-01)
  // ===========================================================================

  describe('completeness scoring', () => {
    it('should calculate completeness = 1.0 when all fields are present', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      expect(result.metadata.completeness).toBe(1.0);
    });

    it('should calculate completeness = 0.6 when only deterministic fields are present', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const result = await service.merge(deterministicInput, null);

      // 3 deterministic fields / 5 total = 0.6
      expect(result.metadata.completeness).toBe(0.6);
    });

    it('should calculate completeness = 0.4 when only Vision AI fields are present', async () => {
      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(null, visionAIInput);

      // 2 Vision AI fields / 5 total = 0.4
      expect(result.metadata.completeness).toBe(0.4);
    });

    it('should calculate partial completeness with missing fields', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: undefined,
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: undefined,
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      // 2 deterministic + 1 Vision AI = 3 fields / 5 total = 0.6
      expect(result.metadata.completeness).toBe(0.6);
    });

    it('should include completeness in metadata', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const result = await service.merge(deterministicInput, null);

      expect(result.metadata).toHaveProperty('completeness');
      expect(typeof result.metadata.completeness).toBe('number');
      expect(result.metadata.completeness).toBeGreaterThanOrEqual(0);
      expect(result.metadata.completeness).toBeLessThanOrEqual(1);
    });
  });

  // ===========================================================================
  // Fallback Tests (REFTRIX-VISION-01)
  // ===========================================================================

  describe('fallback handling', () => {
    it('should apply fallback mood when applyFallbacks is enabled and Vision AI unavailable', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const result = await service.merge(deterministicInput, null, { applyFallbacks: true });

      expect(result.mood).toBeDefined();
      expect(result.mood!.primary).toBe('neutral');
      expect(result.mood!.source).toBe('fallback');
      expect(result.mood!.confidence).toBe(0.3);
    });

    it('should apply fallback brandTone when applyFallbacks is enabled and Vision AI unavailable', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const result = await service.merge(deterministicInput, null, { applyFallbacks: true });

      expect(result.brandTone).toBeDefined();
      expect(result.brandTone!.primary).toBe('neutral');
      expect(result.brandTone!.source).toBe('fallback');
      expect(result.brandTone!.confidence).toBe(0.3);
    });

    it('should NOT apply fallback when applyFallbacks is false (default)', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const result = await service.merge(deterministicInput, null);

      expect(result.mood).toBeNull();
      expect(result.brandTone).toBeNull();
    });

    it('should apply fallback to missing mood when partial Vision AI available', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: undefined,
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput, { applyFallbacks: true });

      expect(result.mood).toBeDefined();
      expect(result.mood!.primary).toBe('neutral');
      expect(result.mood!.source).toBe('fallback');
      expect(result.brandTone!.source).toBe('vision-ai');
    });

    it('should apply fallback to missing brandTone when partial Vision AI available', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: undefined,
      };

      const result = await service.merge(deterministicInput, visionAIInput, { applyFallbacks: true });

      expect(result.mood!.source).toBe('vision-ai');
      expect(result.brandTone).toBeDefined();
      expect(result.brandTone!.primary).toBe('neutral');
      expect(result.brandTone!.source).toBe('fallback');
    });

    it('should calculate lower completeness for fallback fields (0.5 instead of 1.0)', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      // With fallbacks enabled
      const withFallback = await service.merge(deterministicInput, null, { applyFallbacks: true });
      // 3 deterministic (1.0 each) + 2 fallback (0.5 each) = 4.0 / 5 = 0.8
      expect(withFallback.metadata.completeness).toBe(0.8);
    });
  });

  // ===========================================================================
  // Warnings Tests (REFTRIX-VISION-01)
  // ===========================================================================

  describe('warnings', () => {
    it('should include warnings array in metadata', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const result = await service.merge(deterministicInput, null);

      expect(result.metadata).toHaveProperty('warnings');
      expect(Array.isArray(result.metadata.warnings)).toBe(true);
    });

    it('should generate VISION_AI_UNAVAILABLE warning when Vision AI is null', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const result = await service.merge(deterministicInput, null);

      const visionUnavailableWarning = result.metadata.warnings.find(
        (w) => w.code === 'VISION_AI_UNAVAILABLE'
      );
      expect(visionUnavailableWarning).toBeDefined();
      expect(visionUnavailableWarning!.message).toBeTruthy();
    });

    it('should generate LOW_CONFIDENCE warning when mood confidence < 0.5', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult({ confidence: 0.3 }),
        brandTone: createMockBrandToneResult({ confidence: 0.8 }),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      const lowConfidenceWarning = result.metadata.warnings.find(
        (w) => w.code === 'LOW_CONFIDENCE' && w.field === 'mood'
      );
      expect(lowConfidenceWarning).toBeDefined();
      expect(lowConfidenceWarning!.details).toHaveProperty('confidence', 0.3);
    });

    it('should generate LOW_CONFIDENCE warning when brandTone confidence < 0.5', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult({ confidence: 0.8 }),
        brandTone: createMockBrandToneResult({ confidence: 0.2 }),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      const lowConfidenceWarning = result.metadata.warnings.find(
        (w) => w.code === 'LOW_CONFIDENCE' && w.field === 'brandTone'
      );
      expect(lowConfidenceWarning).toBeDefined();
      expect(lowConfidenceWarning!.details).toHaveProperty('confidence', 0.2);
    });

    it('should NOT generate LOW_CONFIDENCE warning when confidence >= 0.5', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult({ confidence: 0.75 }),
        brandTone: createMockBrandToneResult({ confidence: 0.72 }),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      const lowConfidenceWarning = result.metadata.warnings.find(
        (w) => w.code === 'LOW_CONFIDENCE'
      );
      expect(lowConfidenceWarning).toBeUndefined();
    });

    it('should generate MOOD_FALLBACK_USED warning when fallback is applied', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const result = await service.merge(deterministicInput, null, { applyFallbacks: true });

      const fallbackWarning = result.metadata.warnings.find(
        (w) => w.code === 'MOOD_FALLBACK_USED'
      );
      expect(fallbackWarning).toBeDefined();
      expect(fallbackWarning!.field).toBe('mood');
    });

    it('should generate BRAND_TONE_FALLBACK_USED warning when fallback is applied', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: createMockThemeDetectionResult(),
        density: createMockDensityCalculationResult(),
      };

      const result = await service.merge(deterministicInput, null, { applyFallbacks: true });

      const fallbackWarning = result.metadata.warnings.find(
        (w) => w.code === 'BRAND_TONE_FALLBACK_USED'
      );
      expect(fallbackWarning).toBeDefined();
      expect(fallbackWarning!.field).toBe('brandTone');
    });

    it('should generate DETERMINISTIC_EXTRACTION_PARTIAL warning when some deterministic fields are missing', async () => {
      const deterministicInput: DeterministicExtractionInput = {
        colors: createMockColorExtractionResult(),
        theme: undefined,
        density: undefined,
      };

      const visionAIInput: VisionAIAnalysisInput = {
        mood: createMockMoodAnalysisResult(),
        brandTone: createMockBrandToneResult(),
      };

      const result = await service.merge(deterministicInput, visionAIInput);

      const partialWarning = result.metadata.warnings.find(
        (w) => w.code === 'DETERMINISTIC_EXTRACTION_PARTIAL'
      );
      expect(partialWarning).toBeDefined();
      expect(partialWarning!.details).toHaveProperty('missingFields');
      expect((partialWarning!.details as { missingFields: string[] }).missingFields).toContain('theme');
      expect((partialWarning!.details as { missingFields: string[] }).missingFields).toContain('density');
    });
  });
});
