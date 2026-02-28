// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Features Schema Validation Tests
 *
 * page.analyze レスポンスの visualFeatures フィールド用 Zod スキーマのバリデーションテスト
 *
 * テスト対象:
 * - visualFeaturesColorsSchema: 色抽出結果
 * - visualFeaturesThemeSchema: テーマ検出結果
 * - visualFeaturesDensitySchema: 密度計算結果
 * - visualFeaturesGradientSchema: グラデーション検出結果
 * - visualFeaturesMoodSchema: Vision AI ムード解析
 * - visualFeaturesBrandToneSchema: Vision AI ブランドトーン解析
 * - visualFeaturesSchema: 統合スキーマ
 *
 * @module tests/tools/page/visual-features-schema.test
 */

import { describe, it, expect } from 'vitest';
import {
  colorPaletteItemSchema,
  visualFeaturesColorsSchema,
  visualFeaturesThemeSchema,
  visualFeaturesDensitySchema,
  visualFeaturesGradientSchema,
  visualFeaturesMoodSchema,
  visualFeaturesBrandToneSchema,
  visualFeaturesSchema,
  layoutResultFullSchema,
  moodTypeSchema,
  brandToneTypeSchema,
} from '../../../src/tools/page/schemas';

// =============================================================================
// Test Data Factories
// =============================================================================

const createValidColorsData = () => ({
  dominant: ['#FF5733', '#33FF57', '#3357FF'],
  accent: ['#FFFF33', '#FF33FF'],
  palette: [
    { color: '#FF5733', percentage: 40 },
    { color: '#33FF57', percentage: 30 },
    { color: '#FFFFFF', percentage: 30 },
  ],
  source: 'deterministic' as const,
  confidence: 0.95,
});

const createValidThemeData = () => ({
  type: 'light' as const,
  backgroundColor: '#FFFFFF',
  textColor: '#212121',
  contrastRatio: 12.5,
  luminance: {
    background: 1.0,
    foreground: 0.04,
  },
  source: 'deterministic' as const,
  confidence: 0.92,
});

const createValidDensityData = () => ({
  contentDensity: 0.65,
  whitespaceRatio: 0.35,
  visualBalance: 78,
  regions: [
    {
      id: 'region-1',
      x: 0,
      y: 0,
      width: 1440,
      height: 800,
      density: 0.7,
      edgeIntensity: 0.5,
    },
  ],
  metrics: {
    totalPixels: 1152000,
    contentPixels: 748800,
    averageEdgeIntensity: 0.45,
    standardDeviation: 0.12,
  },
  source: 'deterministic' as const,
  confidence: 0.88,
});

const createValidGradientData = () => ({
  hasGradient: true,
  gradients: [
    {
      type: 'linear' as const,
      direction: 45,
      colorStops: [
        { color: '#FF5733', position: 0 },
        { color: '#33FF57', position: 1 },
      ],
      region: { x: 0, y: 0, width: 1440, height: 200 },
      confidence: 0.95,
    },
  ],
  dominantGradientType: 'linear' as const,
  confidence: 0.9,
  processingTimeMs: 45,
  source: 'deterministic' as const,
});

const createValidMoodData = () => ({
  primary: 'professional' as const,
  secondary: 'calm' as const,
  source: 'vision-ai' as const,
  confidence: 0.85,
});

const createValidBrandToneData = () => ({
  primary: 'corporate' as const,
  secondary: 'trustworthy' as const,
  source: 'vision-ai' as const,
  confidence: 0.82,
});

const createValidVisualFeaturesData = () => ({
  colors: createValidColorsData(),
  theme: createValidThemeData(),
  density: createValidDensityData(),
  gradient: createValidGradientData(),
  mood: createValidMoodData(),
  brandTone: createValidBrandToneData(),
  metadata: {
    mergedAt: '2026-01-19T06:00:00.000Z',
    deterministicAvailable: true,
    visionAiAvailable: true,
    overallConfidence: 0.88,
    completeness: 1.0, // 必須フィールド: 全5フィールドが有効
    warnings: [], // 必須フィールド: 警告配列
  },
});

// =============================================================================
// Color Palette Item Schema Tests
// =============================================================================

describe('colorPaletteItemSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid HEX color and percentage', () => {
      const result = colorPaletteItemSchema.safeParse({
        color: '#FF5733',
        percentage: 40,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.color).toBe('#FF5733');
        expect(result.data.percentage).toBe(40);
      }
    });

    it('should accept lowercase HEX color', () => {
      const result = colorPaletteItemSchema.safeParse({
        color: '#ff5733',
        percentage: 25.5,
      });
      expect(result.success).toBe(true);
    });

    it('should accept percentage at boundaries (0 and 100)', () => {
      expect(colorPaletteItemSchema.safeParse({ color: '#000000', percentage: 0 }).success).toBe(true);
      expect(colorPaletteItemSchema.safeParse({ color: '#FFFFFF', percentage: 100 }).success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject invalid HEX color format (missing #)', () => {
      const result = colorPaletteItemSchema.safeParse({
        color: 'FF5733',
        percentage: 40,
      });
      expect(result.success).toBe(false);
    });

    it('should reject 3-digit HEX color', () => {
      const result = colorPaletteItemSchema.safeParse({
        color: '#F53',
        percentage: 40,
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid HEX characters', () => {
      const result = colorPaletteItemSchema.safeParse({
        color: '#GGGGGG',
        percentage: 40,
      });
      expect(result.success).toBe(false);
    });

    it('should reject percentage below 0', () => {
      const result = colorPaletteItemSchema.safeParse({
        color: '#FF5733',
        percentage: -5,
      });
      expect(result.success).toBe(false);
    });

    it('should reject percentage above 100', () => {
      const result = colorPaletteItemSchema.safeParse({
        color: '#FF5733',
        percentage: 150,
      });
      expect(result.success).toBe(false);
    });

    it('should reject potential JSON injection in color field', () => {
      const maliciousInputs = [
        '#FF5733", "malicious": "data',
        '#FF5733\n"injected": true',
        '{"color": "#FF5733"}',
      ];

      maliciousInputs.forEach((malicious) => {
        const result = colorPaletteItemSchema.safeParse({
          color: malicious,
          percentage: 40,
        });
        expect(result.success).toBe(false);
      });
    });
  });
});

// =============================================================================
// Visual Features Colors Schema Tests
// =============================================================================

describe('visualFeaturesColorsSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid color extraction result', () => {
      const result = visualFeaturesColorsSchema.safeParse(createValidColorsData());
      expect(result.success).toBe(true);
    });

    it('should accept empty arrays for dominant and accent colors', () => {
      const result = visualFeaturesColorsSchema.safeParse({
        dominant: [],
        accent: [],
        palette: [],
        source: 'deterministic',
        confidence: 0.5,
      });
      expect(result.success).toBe(true);
    });

    it('should accept maximum 5 dominant colors', () => {
      const result = visualFeaturesColorsSchema.safeParse({
        dominant: ['#111111', '#222222', '#333333', '#444444', '#555555'],
        accent: [],
        palette: [],
        source: 'deterministic',
        confidence: 0.9,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject more than 5 dominant colors', () => {
      const result = visualFeaturesColorsSchema.safeParse({
        dominant: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'],
        accent: [],
        palette: [],
        source: 'deterministic',
        confidence: 0.9,
      });
      expect(result.success).toBe(false);
    });

    it('should reject more than 3 accent colors', () => {
      const result = visualFeaturesColorsSchema.safeParse({
        dominant: [],
        accent: ['#111111', '#222222', '#333333', '#444444'],
        palette: [],
        source: 'deterministic',
        confidence: 0.9,
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid source value', () => {
      const result = visualFeaturesColorsSchema.safeParse({
        ...createValidColorsData(),
        source: 'invalid-source',
      });
      expect(result.success).toBe(false);
    });

    it('should reject confidence outside 0-1 range', () => {
      expect(visualFeaturesColorsSchema.safeParse({ ...createValidColorsData(), confidence: -0.1 }).success).toBe(false);
      expect(visualFeaturesColorsSchema.safeParse({ ...createValidColorsData(), confidence: 1.1 }).success).toBe(false);
    });
  });
});

// =============================================================================
// Visual Features Theme Schema Tests
// =============================================================================

describe('visualFeaturesThemeSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid theme detection result', () => {
      const result = visualFeaturesThemeSchema.safeParse(createValidThemeData());
      expect(result.success).toBe(true);
    });

    it('should accept all valid theme types', () => {
      const themeTypes = ['light', 'dark', 'mixed'] as const;
      themeTypes.forEach((type) => {
        const result = visualFeaturesThemeSchema.safeParse({
          ...createValidThemeData(),
          type,
        });
        expect(result.success).toBe(true);
      });
    });

    it('should accept contrast ratio at boundaries (1 and 21)', () => {
      expect(visualFeaturesThemeSchema.safeParse({ ...createValidThemeData(), contrastRatio: 1 }).success).toBe(true);
      expect(visualFeaturesThemeSchema.safeParse({ ...createValidThemeData(), contrastRatio: 21 }).success).toBe(true);
    });

    it('should accept luminance at boundaries (0 and 1)', () => {
      const result = visualFeaturesThemeSchema.safeParse({
        ...createValidThemeData(),
        luminance: { background: 0, foreground: 1 },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject invalid theme type', () => {
      const result = visualFeaturesThemeSchema.safeParse({
        ...createValidThemeData(),
        type: 'invalid-type',
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid HEX color for backgroundColor', () => {
      const result = visualFeaturesThemeSchema.safeParse({
        ...createValidThemeData(),
        backgroundColor: 'white',
      });
      expect(result.success).toBe(false);
    });

    it('should reject contrast ratio below 1', () => {
      const result = visualFeaturesThemeSchema.safeParse({
        ...createValidThemeData(),
        contrastRatio: 0.5,
      });
      expect(result.success).toBe(false);
    });

    it('should reject contrast ratio above 21', () => {
      const result = visualFeaturesThemeSchema.safeParse({
        ...createValidThemeData(),
        contrastRatio: 25,
      });
      expect(result.success).toBe(false);
    });

    it('should reject luminance outside 0-1 range', () => {
      expect(
        visualFeaturesThemeSchema.safeParse({
          ...createValidThemeData(),
          luminance: { background: -0.1, foreground: 0.5 },
        }).success
      ).toBe(false);

      expect(
        visualFeaturesThemeSchema.safeParse({
          ...createValidThemeData(),
          luminance: { background: 0.5, foreground: 1.5 },
        }).success
      ).toBe(false);
    });
  });
});

// =============================================================================
// Visual Features Density Schema Tests
// =============================================================================

describe('visualFeaturesDensitySchema', () => {
  describe('valid inputs', () => {
    it('should accept valid density calculation result', () => {
      const result = visualFeaturesDensitySchema.safeParse(createValidDensityData());
      expect(result.success).toBe(true);
    });

    it('should accept minimal density data without optional fields', () => {
      const result = visualFeaturesDensitySchema.safeParse({
        contentDensity: 0.5,
        whitespaceRatio: 0.5,
        visualBalance: 50,
        source: 'deterministic',
        confidence: 0.8,
      });
      expect(result.success).toBe(true);
    });

    it('should accept density values at boundaries', () => {
      const result = visualFeaturesDensitySchema.safeParse({
        contentDensity: 0,
        whitespaceRatio: 1,
        visualBalance: 0,
        source: 'deterministic',
        confidence: 0,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject contentDensity outside 0-1 range', () => {
      expect(visualFeaturesDensitySchema.safeParse({ ...createValidDensityData(), contentDensity: -0.1 }).success).toBe(
        false
      );
      expect(visualFeaturesDensitySchema.safeParse({ ...createValidDensityData(), contentDensity: 1.1 }).success).toBe(
        false
      );
    });

    it('should reject whitespaceRatio outside 0-1 range', () => {
      expect(visualFeaturesDensitySchema.safeParse({ ...createValidDensityData(), whitespaceRatio: -0.1 }).success).toBe(
        false
      );
      expect(visualFeaturesDensitySchema.safeParse({ ...createValidDensityData(), whitespaceRatio: 1.1 }).success).toBe(
        false
      );
    });

    it('should reject visualBalance outside 0-100 range', () => {
      expect(visualFeaturesDensitySchema.safeParse({ ...createValidDensityData(), visualBalance: -1 }).success).toBe(
        false
      );
      expect(visualFeaturesDensitySchema.safeParse({ ...createValidDensityData(), visualBalance: 101 }).success).toBe(
        false
      );
    });
  });
});

// =============================================================================
// Visual Features Gradient Schema Tests
// =============================================================================

describe('visualFeaturesGradientSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid gradient detection result', () => {
      const result = visualFeaturesGradientSchema.safeParse(createValidGradientData());
      expect(result.success).toBe(true);
    });

    it('should accept result with no gradients detected', () => {
      const result = visualFeaturesGradientSchema.safeParse({
        hasGradient: false,
        gradients: [],
        confidence: 0.95,
        processingTimeMs: 20,
        source: 'deterministic',
      });
      expect(result.success).toBe(true);
    });

    it('should accept all gradient types', () => {
      const gradientTypes = ['linear', 'radial', 'conic'] as const;
      gradientTypes.forEach((type) => {
        const result = visualFeaturesGradientSchema.safeParse({
          ...createValidGradientData(),
          dominantGradientType: type,
        });
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid inputs', () => {
    it('should reject invalid gradient type', () => {
      const result = visualFeaturesGradientSchema.safeParse({
        ...createValidGradientData(),
        dominantGradientType: 'invalid-type',
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative processingTimeMs', () => {
      const result = visualFeaturesGradientSchema.safeParse({
        ...createValidGradientData(),
        processingTimeMs: -10,
      });
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Mood Type Schema Tests
// =============================================================================

describe('moodTypeSchema', () => {
  it('should accept all valid mood types', () => {
    const validMoods = [
      'calm',
      'energetic',
      'professional',
      'playful',
      'luxurious',
      'minimalist',
      'bold',
      'elegant',
      'friendly',
      'serious',
    ] as const;

    validMoods.forEach((mood) => {
      const result = moodTypeSchema.safeParse(mood);
      expect(result.success).toBe(true);
    });
  });

  it('should reject invalid mood types', () => {
    const invalidMoods = ['happy', 'sad', 'angry', 'invalid', ''];
    invalidMoods.forEach((mood) => {
      const result = moodTypeSchema.safeParse(mood);
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Brand Tone Type Schema Tests
// =============================================================================

describe('brandToneTypeSchema', () => {
  it('should accept all valid brand tone types', () => {
    const validBrandTones = [
      'corporate',
      'startup',
      'luxury',
      'eco-friendly',
      'tech-forward',
      'traditional',
      'innovative',
      'trustworthy',
      'creative',
      'accessible',
    ] as const;

    validBrandTones.forEach((tone) => {
      const result = brandToneTypeSchema.safeParse(tone);
      expect(result.success).toBe(true);
    });
  });

  it('should reject invalid brand tone types', () => {
    const invalidTones = ['professional', 'cool', 'trendy', 'invalid', ''];
    invalidTones.forEach((tone) => {
      const result = brandToneTypeSchema.safeParse(tone);
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Visual Features Mood Schema Tests
// =============================================================================

describe('visualFeaturesMoodSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid mood data', () => {
      const result = visualFeaturesMoodSchema.safeParse(createValidMoodData());
      expect(result.success).toBe(true);
    });

    it('should accept mood data without secondary', () => {
      const result = visualFeaturesMoodSchema.safeParse({
        primary: 'calm',
        source: 'vision-ai',
        confidence: 0.7,
      });
      expect(result.success).toBe(true);
    });

    it('should accept null value (nullable)', () => {
      const result = visualFeaturesMoodSchema.safeParse(null);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject invalid primary mood', () => {
      const result = visualFeaturesMoodSchema.safeParse({
        ...createValidMoodData(),
        primary: 'invalid-mood',
      });
      expect(result.success).toBe(false);
    });

    it('should reject wrong source value', () => {
      const result = visualFeaturesMoodSchema.safeParse({
        ...createValidMoodData(),
        source: 'deterministic',
      });
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Visual Features Brand Tone Schema Tests
// =============================================================================

describe('visualFeaturesBrandToneSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid brand tone data', () => {
      const result = visualFeaturesBrandToneSchema.safeParse(createValidBrandToneData());
      expect(result.success).toBe(true);
    });

    it('should accept brand tone data without secondary', () => {
      const result = visualFeaturesBrandToneSchema.safeParse({
        primary: 'startup',
        source: 'vision-ai',
        confidence: 0.75,
      });
      expect(result.success).toBe(true);
    });

    it('should accept null value (nullable)', () => {
      const result = visualFeaturesBrandToneSchema.safeParse(null);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject invalid primary brand tone', () => {
      const result = visualFeaturesBrandToneSchema.safeParse({
        ...createValidBrandToneData(),
        primary: 'invalid-tone',
      });
      expect(result.success).toBe(false);
    });

    it('should reject wrong source value', () => {
      const result = visualFeaturesBrandToneSchema.safeParse({
        ...createValidBrandToneData(),
        source: 'deterministic',
      });
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Visual Features (Unified) Schema Tests
// =============================================================================

describe('visualFeaturesSchema', () => {
  describe('valid inputs', () => {
    it('should accept complete visual features data', () => {
      const result = visualFeaturesSchema.safeParse(createValidVisualFeaturesData());
      expect(result.success).toBe(true);
    });

    it('should accept partial visual features (only colors)', () => {
      const result = visualFeaturesSchema.safeParse({
        colors: createValidColorsData(),
      });
      expect(result.success).toBe(true);
    });

    it('should accept visual features with null fields (graceful degradation)', () => {
      const result = visualFeaturesSchema.safeParse({
        colors: null,
        theme: null,
        density: null,
        gradient: null,
        mood: null,
        brandTone: null,
      });
      expect(result.success).toBe(true);
    });

    it('should accept empty object (all fields optional)', () => {
      const result = visualFeaturesSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept mixed deterministic and vision-ai sources', () => {
      const result = visualFeaturesSchema.safeParse({
        colors: createValidColorsData(), // deterministic
        theme: createValidThemeData(), // deterministic
        mood: createValidMoodData(), // vision-ai
        brandTone: createValidBrandToneData(), // vision-ai
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject invalid colors data', () => {
      const result = visualFeaturesSchema.safeParse({
        colors: {
          ...createValidColorsData(),
          dominant: ['invalid-color'],
        },
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid theme data', () => {
      const result = visualFeaturesSchema.safeParse({
        theme: {
          ...createValidThemeData(),
          type: 'invalid-type',
        },
      });
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Integration with layoutResultFullSchema
// =============================================================================

describe('layoutResultFullSchema integration', () => {
  const createValidLayoutResult = () => ({
    success: true,
    pageId: '550e8400-e29b-41d4-a716-446655440000',
    sectionCount: 5,
    sectionTypes: { hero: 1, feature: 2, cta: 1, testimonial: 1 },
    processingTimeMs: 1500,
  });

  it('should accept layout result with visualFeatures', () => {
    const result = layoutResultFullSchema.safeParse({
      ...createValidLayoutResult(),
      visualFeatures: createValidVisualFeaturesData(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visualFeatures).toBeDefined();
      expect(result.data.visualFeatures?.colors?.dominant).toHaveLength(3);
    }
  });

  it('should accept layout result without visualFeatures', () => {
    const result = layoutResultFullSchema.safeParse(createValidLayoutResult());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visualFeatures).toBeUndefined();
    }
  });

  it('should accept layout result with partial visualFeatures', () => {
    const result = layoutResultFullSchema.safeParse({
      ...createValidLayoutResult(),
      visualFeatures: {
        colors: createValidColorsData(),
        theme: null,
        density: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it('should distinguish visualFeatures from visionFeatures', () => {
    const result = layoutResultFullSchema.safeParse({
      ...createValidLayoutResult(),
      // visionFeatures: Vision API analysis (existing field)
      visionFeatures: {
        success: true,
        features: [],
        processingTimeMs: 500,
        modelName: 'llama3.2-vision',
      },
      // visualFeatures: Phase 1/2 integrated extraction (new field)
      visualFeatures: createValidVisualFeaturesData(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visionFeatures).toBeDefined();
      expect(result.data.visualFeatures).toBeDefined();
      // They are separate fields with different structures
      expect(result.data.visionFeatures).not.toBe(result.data.visualFeatures);
    }
  });
});

// =============================================================================
// Security: JSON Injection Protection Tests
// =============================================================================

describe('JSON Injection Protection', () => {
  const maliciousColorInputs = [
    '#FF5733", "malicious": "data',
    '#FF5733\n"injected": true',
    '{"color": "#FF5733"}',
    '#FF5733<script>alert("xss")</script>',
    '#FF5733; DROP TABLE colors;--',
  ];

  it('should reject JSON injection attempts in dominant colors', () => {
    maliciousColorInputs.forEach((malicious) => {
      const result = visualFeaturesColorsSchema.safeParse({
        ...createValidColorsData(),
        dominant: [malicious],
      });
      expect(result.success).toBe(false);
    });
  });

  it('should reject JSON injection attempts in accent colors', () => {
    maliciousColorInputs.forEach((malicious) => {
      const result = visualFeaturesColorsSchema.safeParse({
        ...createValidColorsData(),
        accent: [malicious],
      });
      expect(result.success).toBe(false);
    });
  });

  it('should reject JSON injection attempts in theme backgroundColor', () => {
    maliciousColorInputs.forEach((malicious) => {
      const result = visualFeaturesThemeSchema.safeParse({
        ...createValidThemeData(),
        backgroundColor: malicious,
      });
      expect(result.success).toBe(false);
    });
  });

  it('should reject JSON injection attempts in gradient colors', () => {
    const result = visualFeaturesGradientSchema.safeParse({
      ...createValidGradientData(),
      gradients: [
        {
          type: 'linear',
          colors: ['#FF5733", "inject": "true'],
          angle: 45,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
