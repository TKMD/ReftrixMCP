// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LlamaVisionAdapter Enhanced Tests (Phase 2: Mood & Brand Tone)
 *
 * TDD Red Phase: Enhanced mood/brand_tone capabilities with Phase 1 integration
 *
 * Phase 1 Services:
 * - ColorExtractor: dominant/accent color extraction
 * - ThemeDetector: light/dark/mixed theme detection
 * - DensityCalculator: density/whitespace calculation
 *
 * Phase 2 Enhancements:
 * - Enhanced mood detection (professional, playful, minimal, bold, elegant)
 * - Enhanced brand_tone extraction (corporate, friendly, luxury, tech-forward)
 * - Integration with Phase 1 deterministic results via includeColorContext option
 * - Confidence scores for mood and brand tone
 *
 * @module tests/services/vision-adapter/llama-vision-enhanced.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  VisionAnalysisOptions,
  // Phase 2 Enhanced Types
  MoodType,
  BrandToneType,
  EnhancedVisionAnalysisOptions,
  MoodAnalysisResult,
  EnhancedBrandToneResult,
  EnhancedAnalysisResult,
  ColorContextInput,
} from '@/services/vision-adapter/interface';

// Import the adapter (will be enhanced)
import {
  LlamaVisionAdapter,
  type LlamaVisionAdapterConfig,
} from '@/services/vision-adapter/llama-vision.adapter';

// Import Phase 1 services for context integration
import type { ColorExtractionResult } from '@/services/visual-extractor/color-extractor.service';
import type { ThemeDetectionResult } from '@/services/visual-extractor/theme-detector.service';
import type { DensityCalculationResult } from '@/services/visual-extractor/density-calculator.service';

// =============================================================================
// Mocks
// =============================================================================

const mockFetch = vi.fn();
global.fetch = mockFetch;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create test image buffer
 */
function createTestImageBuffer(size = 100): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = Buffer.alloc(size - header.length);
  return Buffer.concat([header, data]);
}

/**
 * Create mock Ollama /api/tags response
 */
function createTagsResponse(models: string[]) {
  return {
    ok: true,
    json: async () => ({
      models: models.map((name) => ({
        name,
        size: 4_000_000_000,
        modified_at: new Date().toISOString(),
      })),
    }),
  };
}

/**
 * Create mock Ollama /api/generate response
 */
function createGenerateResponse(response: string, totalDuration = 5000000000) {
  return {
    ok: true,
    json: async () => ({
      model: 'llama3.2-vision',
      response,
      done: true,
      total_duration: totalDuration,
      eval_count: 150,
    }),
  };
}

/**
 * Create mock Phase 1 color extraction result
 */
function createMockColorExtractionResult(): ColorExtractionResult {
  return {
    dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF'],
    accentColors: ['#F59E0B'],
    colorPalette: [
      { color: '#3B82F6', percentage: 40 },
      { color: '#FFFFFF', percentage: 35 },
      { color: '#1D4ED8', percentage: 15 },
      { color: '#F59E0B', percentage: 10 },
    ],
  };
}

/**
 * Create mock Phase 1 theme detection result
 */
function createMockThemeDetectionResult(): ThemeDetectionResult {
  return {
    theme: 'light',
    confidence: 0.92,
    backgroundColor: '#FFFFFF',
    textColor: '#212121',
    contrastRatio: 14.5,
    luminance: {
      background: 0.95,
      foreground: 0.05,
    },
  };
}

/**
 * Create mock Phase 1 density calculation result
 */
function createMockDensityCalculationResult(): DensityCalculationResult {
  return {
    contentDensity: 0.35,
    whitespaceRatio: 0.65,
    visualBalance: 85,
    regions: [],
    metrics: {
      totalPixels: 1920 * 1080,
      contentPixels: 672000,
      whitespacePixels: 1401600,
      edgePixelCount: 45000,
      averageEdgeDensity: 0.022,
    },
  };
}

/**
 * Create valid enhanced mood/brand tone JSON response
 */
function createEnhancedAnalysisJson() {
  return JSON.stringify({
    mood: {
      primaryMood: 'professional',
      secondaryMood: 'modern',
      confidence: 0.87,
      indicators: [
        'blue color scheme',
        'high whitespace ratio',
        'clean typography',
        'structured grid layout',
      ],
    },
    brandTone: {
      primaryTone: 'tech-forward',
      secondaryTone: 'trustworthy',
      confidence: 0.82,
      professionalism: 'moderate',
      warmth: 'neutral',
      modernity: 'contemporary',
      energy: 'balanced',
      targetAudience: 'startup',
      indicators: [
        'blue primary color (trust)',
        'generous whitespace',
        'modern sans-serif typography',
        'structured hero section',
      ],
    },
  });
}

/**
 * Create enhanced analysis JSON with color context reference
 */
function createEnhancedAnalysisWithContextJson() {
  return JSON.stringify({
    mood: {
      primaryMood: 'minimal',
      secondaryMood: 'elegant',
      confidence: 0.91,
      indicators: [
        'light theme detected (0.95 luminance)',
        '65% whitespace ratio',
        'cool blue dominant colors (#3B82F6)',
        'high contrast ratio (14.5)',
      ],
    },
    brandTone: {
      primaryTone: 'corporate',
      secondaryTone: 'innovative',
      confidence: 0.88,
      professionalism: 'bold',
      warmth: 'cold',
      modernity: 'contemporary',
      energy: 'calm',
      targetAudience: 'enterprise',
      indicators: [
        'light theme with high-contrast text',
        'balanced content density (35%)',
        'professional blue palette',
        'ample breathing room',
      ],
    },
  });
}

// =============================================================================
// Test Cases
// =============================================================================

describe('LlamaVisionAdapter Enhanced (Phase 2: Mood & Brand Tone)', () => {
  let adapter: LlamaVisionAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new LlamaVisionAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Enhanced Mood Detection Tests
  // ===========================================================================

  describe('Enhanced Mood Detection', () => {
    describe('analyzeWithColorContext method', () => {
      it('should be defined on the adapter', () => {
        // TDD Red Phase: Method does not exist yet
        expect(typeof (adapter as any).analyzeWithColorContext).toBe('function');
      });

      it('should return MoodAnalysisResult with primaryMood and confidence', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createEnhancedAnalysisJson())
        );

        const options: EnhancedVisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
          includeColorContext: false,
        };

        const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext(options);

        expect(result.success).toBe(true);
        expect(result.mood).toBeDefined();
        expect(result.mood?.primaryMood).toBe('professional');
        expect(result.mood?.confidence).toBeGreaterThanOrEqual(0);
        expect(result.mood?.confidence).toBeLessThanOrEqual(1);
        expect(result.mood?.colorContextUsed).toBe(false);
      });

      it('should include secondaryMood when applicable', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createEnhancedAnalysisJson())
        );

        const options: EnhancedVisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        };

        const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext(options);

        expect(result.mood?.secondaryMood).toBe('modern');
      });

      it('should include mood indicators', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createEnhancedAnalysisJson())
        );

        const options: EnhancedVisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        };

        const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext(options);

        expect(result.mood?.indicators).toBeDefined();
        expect(Array.isArray(result.mood?.indicators)).toBe(true);
        expect(result.mood?.indicators.length).toBeGreaterThan(0);
      });

      it('should detect all mood types correctly', async () => {
        const moodTypes: MoodType[] = [
          'professional',
          'playful',
          'minimal',
          'bold',
          'elegant',
          'modern',
          'classic',
          'energetic',
          'calm',
          'luxurious',
        ];

        for (const mood of moodTypes) {
          const response = JSON.stringify({
            mood: {
              primaryMood: mood,
              confidence: 0.85,
              indicators: [`${mood} design detected`],
            },
            brandTone: {
              primaryTone: 'corporate',
              confidence: 0.8,
              professionalism: 'moderate',
              warmth: 'neutral',
              modernity: 'contemporary',
              energy: 'balanced',
              targetAudience: 'startup',
              indicators: [],
            },
          });

          mockFetch.mockResolvedValueOnce(createGenerateResponse(response));

          const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
            imageBuffer: createTestImageBuffer(),
            mimeType: 'image/png',
          });

          expect(result.mood?.primaryMood).toBe(mood);
        }
      });
    });

    describe('includeColorContext option', () => {
      it('should use Phase 1 results when includeColorContext is true', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createEnhancedAnalysisWithContextJson())
        );

        // ColorContextInput is a flattened structure from Phase 1 results
        const colorContext: ColorContextInput = {
          dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF'],
          accentColors: ['#F59E0B'],
          theme: 'light',
          themeConfidence: 0.92,
          backgroundColor: '#FFFFFF',
          contentDensity: 0.35,
          whitespaceRatio: 0.65,
        };

        const options: EnhancedVisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
          includeColorContext: true,
          colorContext,
        };

        const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext(options);

        expect(result.success).toBe(true);
        expect(result.mood?.colorContextUsed).toBe(true);
        expect(result.colorContext).toBeDefined();
        expect(result.colorContext?.dominantColors).toEqual(['#3B82F6', '#1D4ED8', '#FFFFFF']);
        expect(result.colorContext?.theme).toBe('light');
        expect(result.colorContext?.density).toBeCloseTo(0.35, 2);
      });

      it('should include color context in the prompt when enabled', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createEnhancedAnalysisWithContextJson())
        );

        const colorContext: ColorContextInput = {
          dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF'],
          accentColors: ['#F59E0B'],
          theme: 'light',
          themeConfidence: 0.92,
          backgroundColor: '#FFFFFF',
          contentDensity: 0.35,
          whitespaceRatio: 0.65,
        };

        const options: EnhancedVisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
          includeColorContext: true,
          colorContext,
        };

        await (adapter as any).analyzeWithColorContext(options);

        // Verify the prompt includes color context
        const callArgs = mockFetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);

        // Template uses "Dominant colors" (lowercase c)
        expect(body.prompt).toContain('Dominant colors');
        expect(body.prompt).toContain('#3B82F6');
        expect(body.prompt).toContain('light');
        expect(body.prompt).toContain('0.65'); // whitespace ratio
      });

      it('should work without colorContext when includeColorContext is false', async () => {
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createEnhancedAnalysisJson())
        );

        const options: EnhancedVisionAnalysisOptions = {
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
          includeColorContext: false,
        };

        const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext(options);

        expect(result.success).toBe(true);
        expect(result.mood?.colorContextUsed).toBe(false);
        expect(result.colorContext).toBeUndefined();
      });

      it('should improve confidence when using color context', async () => {
        // Without color context
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(JSON.stringify({
            mood: {
              primaryMood: 'professional',
              confidence: 0.75,
              indicators: ['blue colors', 'clean layout'],
            },
            brandTone: {
              primaryTone: 'corporate',
              confidence: 0.70,
              professionalism: 'moderate',
              warmth: 'neutral',
              modernity: 'contemporary',
              energy: 'balanced',
              targetAudience: 'startup',
              indicators: [],
            },
          }))
        );

        const resultWithout: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
          includeColorContext: false,
        });

        // With color context - higher confidence expected
        mockFetch.mockResolvedValueOnce(
          createGenerateResponse(createEnhancedAnalysisWithContextJson())
        );

        const colorContext: ColorContextInput = {
          dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF'],
          accentColors: ['#F59E0B'],
          theme: 'light',
          themeConfidence: 0.92,
          backgroundColor: '#FFFFFF',
          contentDensity: 0.35,
          whitespaceRatio: 0.65,
        };

        const resultWith: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
          includeColorContext: true,
          colorContext,
        });

        // Confidence should be higher with color context
        expect(resultWith.mood?.confidence).toBeGreaterThan(resultWithout.mood?.confidence ?? 0);
      });
    });
  });

  // ===========================================================================
  // Enhanced Brand Tone Tests
  // ===========================================================================

  describe('Enhanced Brand Tone Detection', () => {
    it('should return EnhancedBrandToneResult with primaryTone and confidence', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createEnhancedAnalysisJson())
      );

      const options: EnhancedVisionAnalysisOptions = {
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      };

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext(options);

      expect(result.brandTone).toBeDefined();
      expect(result.brandTone?.primaryTone).toBe('tech-forward');
      expect(result.brandTone?.confidence).toBeGreaterThanOrEqual(0);
      expect(result.brandTone?.confidence).toBeLessThanOrEqual(1);
    });

    it('should include secondaryTone when applicable', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createEnhancedAnalysisJson())
      );

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.brandTone?.secondaryTone).toBe('trustworthy');
    });

    it('should detect all brand tone types correctly', async () => {
      const toneTypes: BrandToneType[] = [
        'corporate',
        'friendly',
        'luxury',
        'tech-forward',
        'creative',
        'trustworthy',
        'innovative',
        'traditional',
      ];

      for (const tone of toneTypes) {
        const response = JSON.stringify({
          mood: {
            primaryMood: 'professional',
            confidence: 0.85,
            indicators: [],
          },
          brandTone: {
            primaryTone: tone,
            confidence: 0.85,
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'contemporary',
            energy: 'balanced',
            targetAudience: 'startup',
            indicators: [`${tone} tone detected`],
          },
        });

        mockFetch.mockResolvedValueOnce(createGenerateResponse(response));

        const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
          imageBuffer: createTestImageBuffer(),
          mimeType: 'image/png',
        });

        expect(result.brandTone?.primaryTone).toBe(tone);
      }
    });

    it('should include all dimension values', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createEnhancedAnalysisJson())
      );

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.brandTone?.professionalism).toBe('moderate');
      expect(result.brandTone?.warmth).toBe('neutral');
      expect(result.brandTone?.modernity).toBe('contemporary');
      expect(result.brandTone?.energy).toBe('balanced');
      expect(result.brandTone?.targetAudience).toBe('startup');
    });

    it('should include brand tone indicators', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createEnhancedAnalysisJson())
      );

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.brandTone?.indicators).toBeDefined();
      expect(Array.isArray(result.brandTone?.indicators)).toBe(true);
      expect(result.brandTone?.indicators.length).toBeGreaterThan(0);
    });

    it('should use color context in brand tone analysis when enabled', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createEnhancedAnalysisWithContextJson())
      );

      const colorContext: ColorContextInput = {
        dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF'],
        accentColors: ['#F59E0B'],
        theme: 'light',
        themeConfidence: 0.92,
        backgroundColor: '#FFFFFF',
        contentDensity: 0.35,
        whitespaceRatio: 0.65,
      };

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
        includeColorContext: true,
        colorContext,
      });

      expect(result.brandTone?.colorContextUsed).toBe(true);
      // With color context, should have higher confidence
      expect(result.brandTone?.confidence).toBeGreaterThanOrEqual(0.85);
    });
  });

  // ===========================================================================
  // Backward Compatibility Tests
  // ===========================================================================

  describe('Backward Compatibility', () => {
    it('should maintain existing analyze() method functionality', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(JSON.stringify({
          features: [
            {
              type: 'layout_structure',
              confidence: 0.85,
              data: {
                type: 'layout_structure',
                gridType: 'two-column',
                mainAreas: ['header', 'main'],
                description: 'Two column layout',
              },
            },
          ],
          summary: 'Test analysis',
        }))
      );

      const result = await adapter.analyze({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.features.length).toBeGreaterThan(0);
      expect(result.modelName).toBe('llama3.2-vision');
    });

    it('should maintain existing detectBrandTone() method functionality', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(JSON.stringify({
          features: [
            {
              type: 'brand_tone',
              confidence: 0.85,
              data: {
                type: 'brand_tone',
                professionalism: 'moderate',
                warmth: 'neutral',
                modernity: 'contemporary',
                energy: 'balanced',
                targetAudience: 'startup',
                indicators: ['test indicator'],
              },
            },
          ],
        }))
      );

      const result = await adapter.detectBrandTone({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.professionalism).toBe('moderate');
    });

    it('should maintain existing generateTextRepresentation() method', () => {
      const text = adapter.generateTextRepresentation({
        success: true,
        features: [
          {
            type: 'layout_structure',
            confidence: 0.9,
            data: {
              type: 'layout_structure',
              gridType: 'two-column',
              mainAreas: ['header', 'main'],
              description: 'Two column layout',
            },
          },
        ],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision',
      });

      expect(text).toContain('Layout');
      expect(text).toContain('two-column');
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('Error Handling', () => {
    it('should handle connection errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.mood).toBeUndefined();
      expect(result.brandTone).toBeUndefined();
    });

    // v0.1.0: Invalid JSON now returns success=true with fallback values
    it('should handle invalid JSON response gracefully', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse('This is not valid JSON')
      );

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      // v0.1.0: Returns success with fallback values instead of error
      expect(result.success).toBe(true);
      expect(result.fallbackUsed).toBe(true);
      expect(result.mood).toBeDefined();
      expect(result.mood?.primaryMood).toBe('professional'); // fallback value
      expect(result.brandTone).toBeDefined();
      expect(result.brandTone?.primaryTone).toBe('corporate'); // fallback value
      expect(result.warnings?.some(w => w.code === 'PARSE_WARNING')).toBe(true);
    });

    // v0.1.0: Missing mood now returns fallback value instead of undefined
    it('should handle missing mood data in response', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(JSON.stringify({
          brandTone: {
            primaryTone: 'corporate',
            confidence: 0.85,
            professionalism: 'moderate',
            warmth: 'neutral',
            modernity: 'contemporary',
            energy: 'balanced',
            targetAudience: 'startup',
            indicators: ['clean design'],
          },
        }))
      );

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      // v0.1.0: Uses fallback value for mood
      expect(result.mood).toBeDefined();
      expect(result.mood?.primaryMood).toBe('professional'); // fallback value
      expect(result.mood?.confidence).toBe(0.3); // fallback confidence
      expect(result.fallbackUsed).toBe(true);
      expect(result.warnings?.some(w => w.code === 'MOOD_FALLBACK_USED')).toBe(true);
      // brandTone from response
      expect(result.brandTone).toBeDefined();
      expect(result.brandTone?.primaryTone).toBe('corporate');
    });

    // v0.1.0: Missing brandTone now returns fallback value instead of undefined
    it('should handle missing brandTone data in response', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(JSON.stringify({
          mood: {
            primaryMood: 'professional',
            confidence: 0.85,
            indicators: ['clean layout'],
          },
        }))
      );

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      // mood from response
      expect(result.mood).toBeDefined();
      expect(result.mood?.primaryMood).toBe('professional');
      // v0.1.0: Uses fallback value for brandTone
      expect(result.brandTone).toBeDefined();
      expect(result.brandTone?.primaryTone).toBe('corporate'); // fallback value
      expect(result.brandTone?.confidence).toBe(0.3); // fallback confidence
      expect(result.fallbackUsed).toBe(true);
      expect(result.warnings?.some(w => w.code === 'BRAND_TONE_FALLBACK_USED')).toBe(true);
    });

    it('should handle empty image buffer', async () => {
      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: Buffer.alloc(0),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle timeout gracefully', async () => {
      const timeoutAdapter = new LlamaVisionAdapter({
        requestTimeout: 50,
        maxRetries: 0,
      });

      const abortError = new Error('Timeout');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      const result: EnhancedAnalysisResult = await (timeoutAdapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.error?.toLowerCase()).toContain('timeout');
    });
  });

  // ===========================================================================
  // Prompt Construction Tests
  // ===========================================================================

  describe('Prompt Construction', () => {
    it('should construct enhanced mood/brandTone prompt', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createEnhancedAnalysisJson())
      );

      await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      // Should include mood-related keywords
      expect(body.prompt).toContain('mood');
      // Should include brand tone keywords
      expect(body.prompt).toContain('brand');
    });

    it('should include color context section in prompt when enabled', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createEnhancedAnalysisWithContextJson())
      );

      const colorContext: ColorContextInput = {
        dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF'],
        accentColors: ['#F59E0B'],
        theme: 'light',
        themeConfidence: 0.92,
        backgroundColor: '#FFFFFF',
        contentDensity: 0.35,
        whitespaceRatio: 0.65,
      };

      await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
        includeColorContext: true,
        colorContext,
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      // Check for color context section (template uses lowercase)
      expect(body.prompt).toContain('Dominant colors');
      expect(body.prompt).toContain('Theme');
      expect(body.prompt).toContain('Whitespace');
    });
  });

  // ===========================================================================
  // Processing Time Tests
  // ===========================================================================

  describe('Processing Time', () => {
    it('should record processing time', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createEnhancedAnalysisJson())
      );

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should include model name in result', async () => {
      mockFetch.mockResolvedValueOnce(
        createGenerateResponse(createEnhancedAnalysisJson())
      );

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.modelName).toBe('llama3.2-vision');
    });
  });
});

// =============================================================================
// Integration Tests (Phase 1 + Phase 2)
// =============================================================================

describe('LlamaVisionAdapter Phase 1 + Phase 2 Integration', () => {
  let adapter: LlamaVisionAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new LlamaVisionAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should complete full workflow with color context integration', async () => {
    // Step 1: Check availability
    mockFetch.mockResolvedValueOnce(createTagsResponse(['llama3.2-vision']));
    const isAvailable = await adapter.isAvailable();
    expect(isAvailable).toBe(true);

    // Step 2: Run enhanced analysis with color context
    mockFetch.mockResolvedValueOnce(
      createGenerateResponse(createEnhancedAnalysisWithContextJson())
    );

    const colorContext: ColorContextInput = {
      dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF'],
      accentColors: ['#F59E0B'],
      theme: 'light',
      themeConfidence: 0.92,
      backgroundColor: '#FFFFFF',
      contentDensity: 0.35,
      whitespaceRatio: 0.65,
    };

    const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
      imageBuffer: createTestImageBuffer(),
      mimeType: 'image/png',
      includeColorContext: true,
      colorContext,
    });

    expect(result.success).toBe(true);
    expect(result.mood).toBeDefined();
    expect(result.brandTone).toBeDefined();
    expect(result.colorContext).toBeDefined();
    expect(result.mood?.colorContextUsed).toBe(true);
    expect(result.brandTone?.colorContextUsed).toBe(true);
  });

  it('should gracefully degrade when Phase 1 data is unavailable', async () => {
    mockFetch.mockResolvedValueOnce(createTagsResponse(['llama3.2-vision']));
    await adapter.isAvailable();

    // Run without color context
    mockFetch.mockResolvedValueOnce(
      createGenerateResponse(createEnhancedAnalysisJson())
    );

    const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
      imageBuffer: createTestImageBuffer(),
      mimeType: 'image/png',
      includeColorContext: false,
    });

    expect(result.success).toBe(true);
    expect(result.mood).toBeDefined();
    expect(result.brandTone).toBeDefined();
    expect(result.mood?.colorContextUsed).toBe(false);
    expect(result.brandTone?.colorContextUsed).toBe(false);
  });
});

// =============================================================================
// Validation, Fallback, and Warning Tests (v0.1.0)
// =============================================================================

describe('LlamaVisionAdapter Validation and Warnings (v0.1.0)', () => {
  let adapter: LlamaVisionAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new LlamaVisionAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Fallback values', () => {
    it('should use fallback mood when extraction fails', async () => {
      // Response with invalid mood data
      const invalidMoodResponse = JSON.stringify({
        mood: { invalid: 'data' },
        brandTone: {
          primaryTone: 'corporate',
          confidence: 0.8,
          professionalism: 'moderate',
          warmth: 'neutral',
          modernity: 'contemporary',
          energy: 'balanced',
          targetAudience: 'enterprise',
          indicators: ['clean design'],
        },
      });

      mockFetch.mockResolvedValueOnce(createGenerateResponse(invalidMoodResponse));

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.mood).toBeDefined();
      expect(result.mood?.primaryMood).toBe('professional'); // Fallback value
      expect(result.mood?.confidence).toBe(0.3); // Low fallback confidence
      expect(result.fallbackUsed).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.code === 'MOOD_FALLBACK_USED')).toBe(true);
    });

    it('should use fallback brandTone when extraction fails', async () => {
      // Response with invalid brandTone data
      const invalidBrandToneResponse = JSON.stringify({
        mood: {
          primaryMood: 'professional',
          confidence: 0.85,
          indicators: ['clean layout'],
        },
        brandTone: null,
      });

      mockFetch.mockResolvedValueOnce(createGenerateResponse(invalidBrandToneResponse));

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.brandTone).toBeDefined();
      expect(result.brandTone?.primaryTone).toBe('corporate'); // Fallback value
      expect(result.brandTone?.confidence).toBe(0.3); // Low fallback confidence
      expect(result.fallbackUsed).toBe(true);
      expect(result.warnings?.some(w => w.code === 'BRAND_TONE_FALLBACK_USED')).toBe(true);
    });

    it('should use fallback values when JSON parsing fails', async () => {
      // Invalid JSON response
      mockFetch.mockResolvedValueOnce(createGenerateResponse('This is not valid JSON'));

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.mood).toBeDefined();
      expect(result.brandTone).toBeDefined();
      expect(result.mood?.primaryMood).toBe('professional');
      expect(result.brandTone?.primaryTone).toBe('corporate');
      expect(result.fallbackUsed).toBe(true);
      expect(result.warnings?.some(w => w.code === 'PARSE_WARNING')).toBe(true);
    });
  });

  describe('Low confidence warnings', () => {
    it('should warn when mood confidence is below threshold', async () => {
      const lowConfidenceResponse = JSON.stringify({
        mood: {
          primaryMood: 'professional',
          confidence: 0.3, // Below threshold (0.5)
          indicators: ['some indicator'],
        },
        brandTone: {
          primaryTone: 'corporate',
          confidence: 0.9, // Above threshold
          professionalism: 'moderate',
          warmth: 'neutral',
          modernity: 'contemporary',
          energy: 'balanced',
          targetAudience: 'enterprise',
          indicators: ['clean design'],
        },
      });

      mockFetch.mockResolvedValueOnce(createGenerateResponse(lowConfidenceResponse));

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.code === 'LOW_CONFIDENCE_MOOD')).toBe(true);
      expect(result.warnings?.find(w => w.code === 'LOW_CONFIDENCE_MOOD')?.threshold).toBe(0.5);
    });

    it('should warn when brandTone confidence is below threshold', async () => {
      const lowConfidenceResponse = JSON.stringify({
        mood: {
          primaryMood: 'professional',
          confidence: 0.9, // Above threshold
          indicators: ['clean layout'],
        },
        brandTone: {
          primaryTone: 'corporate',
          confidence: 0.4, // Below threshold (0.5)
          professionalism: 'moderate',
          warmth: 'neutral',
          modernity: 'contemporary',
          energy: 'balanced',
          targetAudience: 'enterprise',
          indicators: ['minimal decoration'],
        },
      });

      mockFetch.mockResolvedValueOnce(createGenerateResponse(lowConfidenceResponse));

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.code === 'LOW_CONFIDENCE_BRAND_TONE')).toBe(true);
    });
  });

  describe('Missing indicators warnings', () => {
    it('should warn when mood indicators are empty', async () => {
      const emptyIndicatorsResponse = JSON.stringify({
        mood: {
          primaryMood: 'professional',
          confidence: 0.8,
          indicators: [], // Empty indicators
        },
        brandTone: {
          primaryTone: 'corporate',
          confidence: 0.8,
          professionalism: 'moderate',
          warmth: 'neutral',
          modernity: 'contemporary',
          energy: 'balanced',
          targetAudience: 'enterprise',
          indicators: ['clean design'],
        },
      });

      mockFetch.mockResolvedValueOnce(createGenerateResponse(emptyIndicatorsResponse));

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(
        w => w.code === 'MISSING_INDICATORS' && w.field === 'mood.indicators'
      )).toBe(true);
    });

    it('should warn when brandTone indicators are empty', async () => {
      const emptyIndicatorsResponse = JSON.stringify({
        mood: {
          primaryMood: 'professional',
          confidence: 0.8,
          indicators: ['clean layout'],
        },
        brandTone: {
          primaryTone: 'corporate',
          confidence: 0.8,
          professionalism: 'moderate',
          warmth: 'neutral',
          modernity: 'contemporary',
          energy: 'balanced',
          targetAudience: 'enterprise',
          indicators: [], // Empty indicators
        },
      });

      mockFetch.mockResolvedValueOnce(createGenerateResponse(emptyIndicatorsResponse));

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(
        w => w.code === 'MISSING_INDICATORS' && w.field === 'brandTone.indicators'
      )).toBe(true);
    });
  });

  describe('Combined scenarios', () => {
    it('should return multiple warnings when multiple issues present', async () => {
      const multipleIssuesResponse = JSON.stringify({
        mood: {
          primaryMood: 'professional',
          confidence: 0.3, // Low confidence
          indicators: [], // Empty indicators
        },
        brandTone: {
          primaryTone: 'corporate',
          confidence: 0.4, // Low confidence
          professionalism: 'moderate',
          warmth: 'neutral',
          modernity: 'contemporary',
          energy: 'balanced',
          targetAudience: 'enterprise',
          indicators: [], // Empty indicators
        },
      });

      mockFetch.mockResolvedValueOnce(createGenerateResponse(multipleIssuesResponse));

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.length).toBeGreaterThanOrEqual(4); // 2 low confidence + 2 missing indicators
    });

    it('should return no warnings when all data is valid and high confidence', async () => {
      const validResponse = JSON.stringify({
        mood: {
          primaryMood: 'professional',
          secondaryMood: 'minimal',
          confidence: 0.85,
          indicators: ['clean layout', 'generous whitespace', 'professional colors'],
        },
        brandTone: {
          primaryTone: 'corporate',
          secondaryTone: 'trustworthy',
          confidence: 0.9,
          professionalism: 'bold',
          warmth: 'neutral',
          modernity: 'contemporary',
          energy: 'balanced',
          targetAudience: 'enterprise',
          indicators: ['structured layout', 'professional typography', 'corporate color palette'],
        },
      });

      mockFetch.mockResolvedValueOnce(createGenerateResponse(validResponse));

      const result: EnhancedAnalysisResult = await (adapter as any).analyzeWithColorContext({
        imageBuffer: createTestImageBuffer(),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.warnings).toBeUndefined();
      expect(result.fallbackUsed).toBeUndefined();
    });
  });
});
