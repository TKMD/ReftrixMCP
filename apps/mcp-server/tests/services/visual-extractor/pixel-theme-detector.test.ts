// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pixel Theme Detector Service Tests
 *
 * TDD Phase: Red
 * These tests define the expected behavior of the PixelThemeDetectorService
 * for detecting light/dark/mixed themes from screenshot images using
 * WCAG-compliant luminance calculation on actual pixel data.
 *
 * Background:
 * - Current theme detection (theme-detector.service.ts) relies on color palette analysis
 * - This approach fails for sites like E&A Financial (dark blue #0A1628) that get
 *   incorrectly detected as "Light/Mixed" due to class name inference
 * - Pixel-based detection directly analyzes screenshot luminance for accuracy
 *
 * @module tests/services/visual-extractor/pixel-theme-detector.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import type {
  PixelThemeDetectorService} from '../../../src/services/visual-extractor/pixel-theme-detector.service';
import {
  PixelThemeDetectionResult,
  createPixelThemeDetectorService,
  DARK_THRESHOLD,
  LIGHT_THRESHOLD,
} from '../../../src/services/visual-extractor/pixel-theme-detector.service';

// ============================================================================
// Test Image Helpers
// ============================================================================

/**
 * Create a solid color test image
 */
async function createSolidColorImage(
  width: number,
  height: number,
  color: { r: number; g: number; b: number }
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

/**
 * Create an image with three regions (top/middle/bottom) in different colors
 * Used to test region-based analysis
 */
async function createThreeRegionImage(
  width: number,
  height: number,
  topColor: { r: number; g: number; b: number },
  middleColor: { r: number; g: number; b: number },
  bottomColor: { r: number; g: number; b: number }
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  const regionHeight = Math.floor(height / 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;
      let color: { r: number; g: number; b: number };

      if (y < regionHeight) {
        color = topColor;
      } else if (y < regionHeight * 2) {
        color = middleColor;
      } else {
        color = bottomColor;
      }

      data[pixelIndex] = color.r;
      data[pixelIndex + 1] = color.g;
      data[pixelIndex + 2] = color.b;
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

/**
 * Create E&A Financial style dark blue background
 * This is the specific case that was being incorrectly detected
 */
async function createEAFinancialStyleImage(): Promise<Buffer> {
  // E&A Financial uses dark blue #0A1628 (RGB: 10, 22, 40)
  // Expected relative luminance: ~0.014 (well below 0.3 threshold)
  return createSolidColorImage(200, 200, { r: 10, g: 22, b: 40 });
}

/**
 * Create a gradient image (dark to light, top to bottom)
 */
async function createVerticalGradientImage(
  width: number,
  height: number,
  startColor: { r: number; g: number; b: number },
  endColor: { r: number; g: number; b: number }
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    const ratio = y / (height - 1);
    const r = Math.round(startColor.r + (endColor.r - startColor.r) * ratio);
    const g = Math.round(startColor.g + (endColor.g - startColor.g) * ratio);
    const b = Math.round(startColor.b + (endColor.b - startColor.b) * ratio);

    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;
      data[pixelIndex] = r;
      data[pixelIndex + 1] = g;
      data[pixelIndex + 2] = b;
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// ============================================================================
// Test Suite
// ============================================================================

describe('PixelThemeDetectorService', () => {
  let service: PixelThemeDetectorService;

  beforeAll(() => {
    service = createPixelThemeDetectorService();
  });

  // ==========================================================================
  // 1. Core Theme Detection
  // ==========================================================================

  describe('1. Core Theme Detection', () => {
    describe('Dark Theme Detection (luminance < 0.3)', () => {
      it('should detect pure black as dark theme', async () => {
        const blackImage = await createSolidColorImage(100, 100, { r: 0, g: 0, b: 0 });

        const result = await service.detectTheme(blackImage);

        expect(result.theme).toBe('dark');
        expect(result.averageLuminance).toBeLessThan(DARK_THRESHOLD);
        expect(result.confidence).toBeGreaterThan(0.8);
      });

      it('should detect dark gray (#1E1E1E) as dark theme', async () => {
        const darkGrayImage = await createSolidColorImage(100, 100, { r: 30, g: 30, b: 30 });

        const result = await service.detectTheme(darkGrayImage);

        expect(result.theme).toBe('dark');
        expect(result.averageLuminance).toBeLessThan(DARK_THRESHOLD);
      });

      it('should detect E&A Financial dark blue (#0A1628) as dark theme', async () => {
        // This is the critical test case that was failing before
        const eaFinancialImage = await createEAFinancialStyleImage();

        const result = await service.detectTheme(eaFinancialImage);

        expect(result.theme).toBe('dark');
        expect(result.averageLuminance).toBeLessThan(DARK_THRESHOLD);
        expect(result.confidence).toBeGreaterThan(0.7);
        // Verify region analysis
        expect(result.analysis.topRegionTheme).toBe('dark');
        expect(result.analysis.middleRegionTheme).toBe('dark');
        expect(result.analysis.bottomRegionTheme).toBe('dark');
      });

      it('should detect dark purple (#1A1A2E) as dark theme', async () => {
        const darkPurpleImage = await createSolidColorImage(100, 100, { r: 26, g: 26, b: 46 });

        const result = await service.detectTheme(darkPurpleImage);

        expect(result.theme).toBe('dark');
        expect(result.averageLuminance).toBeLessThan(DARK_THRESHOLD);
      });

      it('should detect GitHub dark mode style (#0D1117) as dark theme', async () => {
        const githubDarkImage = await createSolidColorImage(100, 100, { r: 13, g: 17, b: 23 });

        const result = await service.detectTheme(githubDarkImage);

        expect(result.theme).toBe('dark');
        expect(result.averageLuminance).toBeLessThan(DARK_THRESHOLD);
      });
    });

    describe('Light Theme Detection (luminance > 0.7)', () => {
      it('should detect pure white as light theme', async () => {
        const whiteImage = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });

        const result = await service.detectTheme(whiteImage);

        expect(result.theme).toBe('light');
        expect(result.averageLuminance).toBeGreaterThan(LIGHT_THRESHOLD);
        expect(result.confidence).toBeGreaterThan(0.8);
      });

      it('should detect off-white (#FAFAFA) as light theme', async () => {
        const offWhiteImage = await createSolidColorImage(100, 100, { r: 250, g: 250, b: 250 });

        const result = await service.detectTheme(offWhiteImage);

        expect(result.theme).toBe('light');
        expect(result.averageLuminance).toBeGreaterThan(LIGHT_THRESHOLD);
      });

      it('should detect light gray (#E0E0E0) as light theme', async () => {
        const lightGrayImage = await createSolidColorImage(100, 100, { r: 224, g: 224, b: 224 });

        const result = await service.detectTheme(lightGrayImage);

        expect(result.theme).toBe('light');
        expect(result.averageLuminance).toBeGreaterThan(LIGHT_THRESHOLD);
      });

      it('should detect cream/beige (#F5F5DC) as light theme', async () => {
        const creamImage = await createSolidColorImage(100, 100, { r: 245, g: 245, b: 220 });

        const result = await service.detectTheme(creamImage);

        expect(result.theme).toBe('light');
        expect(result.averageLuminance).toBeGreaterThan(LIGHT_THRESHOLD);
      });
    });

    describe('Mixed Theme Detection (0.3 <= luminance <= 0.7)', () => {
      it('should detect lighter gray (#A0A0A0) as mixed theme', async () => {
        // #808080 has WCAG luminance of 0.216 (dark), so we use #A0A0A0 (luminance ~0.35)
        const mixedGrayImage = await createSolidColorImage(100, 100, { r: 160, g: 160, b: 160 });

        const result = await service.detectTheme(mixedGrayImage);

        expect(result.theme).toBe('mixed');
        expect(result.averageLuminance).toBeGreaterThanOrEqual(DARK_THRESHOLD);
        expect(result.averageLuminance).toBeLessThanOrEqual(LIGHT_THRESHOLD);
      });

      it('should detect medium blue (#6495ED) as mixed theme', async () => {
        // Cornflower blue - not clearly light or dark
        const mediumBlueImage = await createSolidColorImage(100, 100, { r: 100, g: 149, b: 237 });

        const result = await service.detectTheme(mediumBlueImage);

        expect(result.theme).toBe('mixed');
        expect(result.averageLuminance).toBeGreaterThanOrEqual(DARK_THRESHOLD);
        expect(result.averageLuminance).toBeLessThanOrEqual(LIGHT_THRESHOLD);
      });
    });
  });

  // ==========================================================================
  // 2. Region-Based Analysis
  // ==========================================================================

  describe('2. Region-Based Analysis', () => {
    it('should correctly analyze three regions with same color', async () => {
      const uniformDarkImage = await createSolidColorImage(100, 300, { r: 20, g: 20, b: 20 });

      const result = await service.detectTheme(uniformDarkImage);

      expect(result.analysis.topRegionTheme).toBe('dark');
      expect(result.analysis.middleRegionTheme).toBe('dark');
      expect(result.analysis.bottomRegionTheme).toBe('dark');
    });

    it('should detect different themes in different regions', async () => {
      // Top: dark, Middle: dark, Bottom: light
      const mixedRegionsImage = await createThreeRegionImage(
        100,
        300,
        { r: 20, g: 20, b: 20 },   // Dark top
        { r: 30, g: 30, b: 30 },   // Dark middle
        { r: 240, g: 240, b: 240 } // Light bottom
      );

      const result = await service.detectTheme(mixedRegionsImage);

      expect(result.analysis.topRegionTheme).toBe('dark');
      expect(result.analysis.middleRegionTheme).toBe('dark');
      expect(result.analysis.bottomRegionTheme).toBe('light');
    });

    it('should detect light top with dark bottom (hero section pattern)', async () => {
      const heroPatternImage = await createThreeRegionImage(
        100,
        300,
        { r: 250, g: 250, b: 250 }, // Light top (header)
        { r: 20, g: 20, b: 20 },    // Dark middle (hero)
        { r: 20, g: 20, b: 20 }     // Dark bottom (content)
      );

      const result = await service.detectTheme(heroPatternImage);

      expect(result.analysis.topRegionTheme).toBe('light');
      expect(result.analysis.middleRegionTheme).toBe('dark');
      expect(result.analysis.bottomRegionTheme).toBe('dark');
    });

    it('should handle gradient images correctly', async () => {
      // Dark at top, light at bottom
      const gradientImage = await createVerticalGradientImage(
        100,
        300,
        { r: 20, g: 20, b: 20 },    // Dark start
        { r: 240, g: 240, b: 240 }  // Light end
      );

      const result = await service.detectTheme(gradientImage);

      // Top should be dark, bottom should be light
      expect(result.analysis.topRegionTheme).toBe('dark');
      expect(result.analysis.bottomRegionTheme).toBe('light');
      // Overall theme depends on average
      expect(['dark', 'mixed']).toContain(result.theme);
    });
  });

  // ==========================================================================
  // 3. WCAG-Compliant Luminance Calculation
  // ==========================================================================

  describe('3. WCAG-Compliant Luminance Calculation', () => {
    it('should calculate white luminance as 1.0', async () => {
      const whiteImage = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });

      const result = await service.detectTheme(whiteImage);

      expect(result.averageLuminance).toBeCloseTo(1.0, 2);
    });

    it('should calculate black luminance as 0.0', async () => {
      const blackImage = await createSolidColorImage(100, 100, { r: 0, g: 0, b: 0 });

      const result = await service.detectTheme(blackImage);

      expect(result.averageLuminance).toBeCloseTo(0.0, 2);
    });

    it('should calculate E&A Financial #0A1628 luminance correctly', async () => {
      // RGB(10, 22, 40) -> Expected luminance ~0.014
      const eaImage = await createSolidColorImage(100, 100, { r: 10, g: 22, b: 40 });

      const result = await service.detectTheme(eaImage);

      // WCAG relative luminance formula:
      // L = 0.2126 * R + 0.7152 * G + 0.0722 * B (after gamma correction)
      expect(result.averageLuminance).toBeLessThan(0.02);
      expect(result.averageLuminance).toBeGreaterThan(0);
    });

    it('should calculate pure red luminance as ~0.2126', async () => {
      const redImage = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });

      const result = await service.detectTheme(redImage);

      expect(result.averageLuminance).toBeCloseTo(0.2126, 2);
    });

    it('should calculate pure green luminance as ~0.7152', async () => {
      const greenImage = await createSolidColorImage(100, 100, { r: 0, g: 255, b: 0 });

      const result = await service.detectTheme(greenImage);

      expect(result.averageLuminance).toBeCloseTo(0.7152, 2);
    });

    it('should calculate pure blue luminance as ~0.0722', async () => {
      const blueImage = await createSolidColorImage(100, 100, { r: 0, g: 0, b: 255 });

      const result = await service.detectTheme(blueImage);

      expect(result.averageLuminance).toBeCloseTo(0.0722, 2);
    });

    it('should apply gamma correction correctly for mid-gray', async () => {
      // Mid-gray (128, 128, 128) should have luminance ~0.214 after gamma correction
      // NOT 0.5 (which would be linear)
      const midGrayImage = await createSolidColorImage(100, 100, { r: 128, g: 128, b: 128 });

      const result = await service.detectTheme(midGrayImage);

      // After sRGB gamma correction, (128/255)^2.4 ≈ 0.214
      expect(result.averageLuminance).toBeGreaterThan(0.15);
      expect(result.averageLuminance).toBeLessThan(0.3);
    });
  });

  // ==========================================================================
  // 4. Confidence Score
  // ==========================================================================

  describe('4. Confidence Score', () => {
    it('should return confidence between 0 and 1', async () => {
      const image = await createSolidColorImage(100, 100, { r: 100, g: 100, b: 100 });

      const result = await service.detectTheme(image);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should have high confidence for very dark images', async () => {
      const veryDarkImage = await createSolidColorImage(100, 100, { r: 10, g: 10, b: 10 });

      const result = await service.detectTheme(veryDarkImage);

      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('should have high confidence for very light images', async () => {
      const veryLightImage = await createSolidColorImage(100, 100, { r: 250, g: 250, b: 250 });

      const result = await service.detectTheme(veryLightImage);

      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('should have lower confidence for mixed regions', async () => {
      // Image with contrasting regions
      const mixedImage = await createThreeRegionImage(
        100,
        300,
        { r: 255, g: 255, b: 255 }, // Light
        { r: 128, g: 128, b: 128 }, // Mid
        { r: 0, g: 0, b: 0 }        // Dark
      );

      const result = await service.detectTheme(mixedImage);

      // Mixed regions should have lower confidence
      expect(result.confidence).toBeLessThan(0.8);
    });

    it('should have higher confidence when all regions agree', async () => {
      const uniformImage = await createSolidColorImage(100, 300, { r: 20, g: 20, b: 20 });

      const result = await service.detectTheme(uniformImage);

      expect(result.confidence).toBeGreaterThan(0.7);
    });
  });

  // ==========================================================================
  // 5. Dominant Colors Extraction
  // ==========================================================================

  describe('5. Dominant Colors Extraction', () => {
    it('should extract dominant colors as HEX array', async () => {
      const solidColorImage = await createSolidColorImage(100, 100, { r: 10, g: 22, b: 40 });

      const result = await service.detectTheme(solidColorImage);

      expect(result.dominantColors).toBeDefined();
      expect(Array.isArray(result.dominantColors)).toBe(true);
      expect(result.dominantColors.length).toBeGreaterThan(0);
      // Each color should be valid HEX
      result.dominantColors.forEach((color) => {
        expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      });
    });

    it('should include the primary background color in dominant colors', async () => {
      // Create a mostly solid dark blue image
      const darkBlueImage = await createSolidColorImage(100, 100, { r: 10, g: 22, b: 40 });

      const result = await service.detectTheme(darkBlueImage);

      // The dominant color should be close to #0A1628
      const hasMatchingColor = result.dominantColors.some((color) => {
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        // Allow some tolerance for quantization
        return Math.abs(r - 10) < 20 && Math.abs(g - 22) < 20 && Math.abs(b - 40) < 20;
      });

      expect(hasMatchingColor).toBe(true);
    });
  });

  // ==========================================================================
  // 6. Result Structure
  // ==========================================================================

  describe('6. Result Structure', () => {
    it('should return complete PixelThemeDetectionResult structure', async () => {
      const image = await createSolidColorImage(100, 100, { r: 100, g: 100, b: 100 });

      const result = await service.detectTheme(image);

      // Validate all required fields
      expect(result.theme).toBeDefined();
      expect(['light', 'dark', 'mixed']).toContain(result.theme);

      expect(result.confidence).toBeDefined();
      expect(typeof result.confidence).toBe('number');

      expect(result.averageLuminance).toBeDefined();
      expect(typeof result.averageLuminance).toBe('number');
      expect(result.averageLuminance).toBeGreaterThanOrEqual(0);
      expect(result.averageLuminance).toBeLessThanOrEqual(1);

      expect(result.dominantColors).toBeDefined();
      expect(Array.isArray(result.dominantColors)).toBe(true);

      expect(result.analysis).toBeDefined();
      expect(result.analysis.topRegionTheme).toBeDefined();
      expect(result.analysis.middleRegionTheme).toBeDefined();
      expect(result.analysis.bottomRegionTheme).toBeDefined();
      expect(['light', 'dark']).toContain(result.analysis.topRegionTheme);
      expect(['light', 'dark']).toContain(result.analysis.middleRegionTheme);
      expect(['light', 'dark']).toContain(result.analysis.bottomRegionTheme);
    });
  });

  // ==========================================================================
  // 7. Input Handling
  // ==========================================================================

  describe('7. Input Handling', () => {
    it('should accept Buffer input', async () => {
      const bufferImage = await createSolidColorImage(100, 100, { r: 0, g: 0, b: 0 });

      const result = await service.detectTheme(bufferImage);

      expect(result).toBeDefined();
      expect(result.theme).toBe('dark');
    });

    it('should accept base64 string input', async () => {
      const imageBuffer = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });
      const base64String = imageBuffer.toString('base64');

      const result = await service.detectTheme(base64String);

      expect(result).toBeDefined();
      expect(result.theme).toBe('light');
    });

    it('should accept base64 with data URL prefix', async () => {
      const imageBuffer = await createSolidColorImage(100, 100, { r: 0, g: 0, b: 0 });
      const dataUrl = `data:image/png;base64,${imageBuffer.toString('base64')}`;

      const result = await service.detectTheme(dataUrl);

      expect(result).toBeDefined();
      expect(result.theme).toBe('dark');
    });
  });

  // ==========================================================================
  // 8. Error Handling
  // ==========================================================================

  describe('8. Error Handling', () => {
    it('should throw error for null input', async () => {
      await expect(service.detectTheme(null as unknown as Buffer)).rejects.toThrow();
    });

    it('should throw error for undefined input', async () => {
      await expect(service.detectTheme(undefined as unknown as Buffer)).rejects.toThrow();
    });

    it('should throw error for empty buffer', async () => {
      const emptyBuffer = Buffer.alloc(0);
      await expect(service.detectTheme(emptyBuffer)).rejects.toThrow();
    });

    it('should throw error for invalid base64 string', async () => {
      await expect(service.detectTheme('not-valid-base64!!!')).rejects.toThrow();
    });

    it('should throw error for non-image data', async () => {
      const textBuffer = Buffer.from('This is not an image');
      await expect(service.detectTheme(textBuffer)).rejects.toThrow();
    });
  });

  // ==========================================================================
  // 9. Performance (Security Limits)
  // ==========================================================================

  describe('9. Performance and Security', () => {
    it('should process small images quickly', async () => {
      const smallImage = await createSolidColorImage(50, 50, { r: 100, g: 100, b: 100 });

      const startTime = Date.now();
      await service.detectTheme(smallImage);
      const elapsed = Date.now() - startTime;

      // Should complete in under 500ms for small images
      expect(elapsed).toBeLessThan(500);
    });

    it('should handle large images by downscaling', async () => {
      // Create a 2000x2000 image (would be 12MB raw)
      const largeImage = await createSolidColorImage(2000, 2000, { r: 50, g: 50, b: 50 });

      const startTime = Date.now();
      const result = await service.detectTheme(largeImage);
      const elapsed = Date.now() - startTime;

      // Should still detect correctly
      expect(result.theme).toBe('dark');
      // Should complete in reasonable time due to downscaling
      expect(elapsed).toBeLessThan(5000);
    });
  });

  // ==========================================================================
  // 10. Real-World Test Cases
  // ==========================================================================

  describe('10. Real-World Test Cases', () => {
    it('should detect Stripe-style dark blue (#0A2540) as dark', async () => {
      const stripeImage = await createSolidColorImage(100, 100, { r: 10, g: 37, b: 64 });

      const result = await service.detectTheme(stripeImage);

      expect(result.theme).toBe('dark');
    });

    it('should detect Linear-style dark purple (#171717) as dark', async () => {
      const linearImage = await createSolidColorImage(100, 100, { r: 23, g: 23, b: 23 });

      const result = await service.detectTheme(linearImage);

      expect(result.theme).toBe('dark');
    });

    it('should detect Apple-style light gray (#F5F5F7) as light', async () => {
      const appleImage = await createSolidColorImage(100, 100, { r: 245, g: 245, b: 247 });

      const result = await service.detectTheme(appleImage);

      expect(result.theme).toBe('light');
    });

    it('should detect Notion-style warm white (#FFFFFF) as light', async () => {
      const notionImage = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });

      const result = await service.detectTheme(notionImage);

      expect(result.theme).toBe('light');
    });
  });
});
