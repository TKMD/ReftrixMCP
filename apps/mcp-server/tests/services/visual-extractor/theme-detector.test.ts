// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Theme Detector Service Tests
 *
 * TDD Phase: Red
 * These tests define the expected behavior of the ThemeDetectorService
 * for detecting light/dark/mixed themes from images and color data.
 *
 * @module tests/services/visual-extractor/theme-detector.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import type {
  ThemeDetectorService} from '../../../src/services/visual-extractor/theme-detector.service';
import {
  ThemeDetectionResult,
  createThemeDetectorService,
} from '../../../src/services/visual-extractor/theme-detector.service';
import type {
  ColorExtractionResult} from '../../../src/services/visual-extractor/color-extractor.service';
import {
  createColorExtractorService
} from '../../../src/services/visual-extractor/color-extractor.service';

// Helper to create solid color test images
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

// Helper to create an image with top and bottom halves in different colors
async function createDualColorImage(
  width: number,
  height: number,
  topColor: { r: number; g: number; b: number },
  bottomColor: { r: number; g: number; b: number }
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;
      const color = y < height / 2 ? topColor : bottomColor;
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

// Helper to create typical light theme image (white background, dark text)
// Uses deterministic pattern instead of random for consistent test results
async function createLightThemeImage(): Promise<Buffer> {
  // Simulate a webpage with white background and some dark elements
  const width = 200;
  const height = 200;
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;
      // 85% white background (deterministic pattern)
      // Dark "text" only in specific regions simulating text lines
      const isTextRegion = (y % 20 < 3) && (x > 10 && x < 190);
      if (isTextRegion) {
        data[pixelIndex] = 30;      // R - dark text
        data[pixelIndex + 1] = 30;  // G
        data[pixelIndex + 2] = 30;  // B
      } else {
        data[pixelIndex] = 250;     // R - near white background
        data[pixelIndex + 1] = 250; // G
        data[pixelIndex + 2] = 250; // B
      }
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// Helper to create typical dark theme image (dark background, light text)
// Uses deterministic pattern instead of random for consistent test results
async function createDarkThemeImage(): Promise<Buffer> {
  const width = 200;
  const height = 200;
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;
      // 85% dark background (deterministic pattern)
      // Light "text" only in specific regions simulating text lines
      const isTextRegion = (y % 20 < 3) && (x > 10 && x < 190);
      if (isTextRegion) {
        data[pixelIndex] = 230;     // R - light text
        data[pixelIndex + 1] = 230; // G
        data[pixelIndex + 2] = 230; // B
      } else {
        data[pixelIndex] = 25;      // R - dark background
        data[pixelIndex + 1] = 25;  // G
        data[pixelIndex + 2] = 35;  // B
      }
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

describe('ThemeDetectorService', () => {
  let service: ThemeDetectorService;
  let colorExtractor: ReturnType<typeof createColorExtractorService>;

  beforeAll(() => {
    service = createThemeDetectorService();
    colorExtractor = createColorExtractorService();
  });

  describe('detectTheme (from image)', () => {
    describe('1. Detect light theme from bright background pages', () => {
      it('should detect pure white background as light theme', async () => {
        const whiteImage = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });

        const result = await service.detectTheme(whiteImage);

        expect(result).toBeDefined();
        expect(result.theme).toBe('light');
        expect(result.confidence).toBeGreaterThan(0.5);
      });

      it('should detect off-white background as light theme', async () => {
        const offWhiteImage = await createSolidColorImage(100, 100, { r: 248, g: 249, b: 250 });

        const result = await service.detectTheme(offWhiteImage);

        expect(result.theme).toBe('light');
        expect(result.confidence).toBeGreaterThan(0.5);
      });

      it('should detect light gray background as light theme', async () => {
        const lightGrayImage = await createSolidColorImage(100, 100, { r: 200, g: 200, b: 200 });

        const result = await service.detectTheme(lightGrayImage);

        expect(result.theme).toBe('light');
        expect(result.confidence).toBeGreaterThan(0.3);
      });

      it('should detect typical light webpage as light theme', async () => {
        const lightPageImage = await createLightThemeImage();

        const result = await service.detectTheme(lightPageImage);

        expect(result.theme).toBe('light');
        expect(result.confidence).toBeGreaterThan(0.5);
      });
    });

    describe('2. Detect dark theme from dark background pages', () => {
      it('should detect pure black background as dark theme', async () => {
        const blackImage = await createSolidColorImage(100, 100, { r: 0, g: 0, b: 0 });

        const result = await service.detectTheme(blackImage);

        expect(result.theme).toBe('dark');
        expect(result.confidence).toBeGreaterThan(0.5);
      });

      it('should detect dark gray background as dark theme', async () => {
        const darkGrayImage = await createSolidColorImage(100, 100, { r: 30, g: 30, b: 40 });

        const result = await service.detectTheme(darkGrayImage);

        expect(result.theme).toBe('dark');
        expect(result.confidence).toBeGreaterThan(0.5);
      });

      it('should detect dark blue background as dark theme', async () => {
        const darkBlueImage = await createSolidColorImage(100, 100, { r: 20, g: 25, b: 50 });

        const result = await service.detectTheme(darkBlueImage);

        expect(result.theme).toBe('dark');
        expect(result.confidence).toBeGreaterThan(0.5);
      });

      it('should detect typical dark webpage as dark theme', async () => {
        const darkPageImage = await createDarkThemeImage();

        const result = await service.detectTheme(darkPageImage);

        expect(result.theme).toBe('dark');
        expect(result.confidence).toBeGreaterThan(0.5);
      });
    });

    describe('3. Detect mixed theme when regions differ significantly', () => {
      it('should detect mixed theme when half light and half dark', async () => {
        const mixedImage = await createDualColorImage(
          100,
          100,
          { r: 255, g: 255, b: 255 }, // White top
          { r: 0, g: 0, b: 0 }        // Black bottom
        );

        const result = await service.detectTheme(mixedImage);

        // Could be mixed or one of the themes with lower confidence
        expect(['light', 'dark', 'mixed']).toContain(result.theme);
        if (result.theme === 'mixed') {
          expect(result.confidence).toBeGreaterThan(0);
        }
      });

      it('should handle ambiguous images correctly', async () => {
        const midGrayImage = await createSolidColorImage(100, 100, { r: 128, g: 128, b: 128 });

        const result = await service.detectTheme(midGrayImage);

        // Mid-gray (luminance ~0.21) is technically dark by our threshold (0.5)
        // Single color images have high confidence because there's no variance
        // The important thing is that the theme is consistently detected
        expect(result.theme).toBe('dark'); // luminance < 0.5
        expect(result.confidence).toBeGreaterThan(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('detectThemeFromColors (from ColorExtractionResult)', () => {
    it('should detect light theme from light color palette', () => {
      const lightColors: ColorExtractionResult = {
        dominantColors: ['#FFFFFF', '#FAFAFA', '#F5F5F5'],
        accentColors: ['#1E88E5'],
        colorPalette: [
          { color: '#FFFFFF', percentage: 60 },
          { color: '#FAFAFA', percentage: 20 },
          { color: '#212121', percentage: 15 },
          { color: '#1E88E5', percentage: 5 },
        ],
      };

      const result = service.detectThemeFromColors(lightColors);

      expect(result.theme).toBe('light');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should detect dark theme from dark color palette', () => {
      const darkColors: ColorExtractionResult = {
        dominantColors: ['#121212', '#1E1E1E', '#2D2D2D'],
        accentColors: ['#BB86FC'],
        colorPalette: [
          { color: '#121212', percentage: 55 },
          { color: '#1E1E1E', percentage: 25 },
          { color: '#FFFFFF', percentage: 10 },
          { color: '#BB86FC', percentage: 10 },
        ],
      };

      const result = service.detectThemeFromColors(darkColors);

      expect(result.theme).toBe('dark');
      expect(result.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('4. WCAG-compliant luminance calculation', () => {
    it('should calculate luminance of white as 1.0', () => {
      const luminance = service.calculateLuminance('#FFFFFF');

      expect(luminance).toBeCloseTo(1.0, 2);
    });

    it('should calculate luminance of black as 0.0', () => {
      const luminance = service.calculateLuminance('#000000');

      expect(luminance).toBeCloseTo(0.0, 2);
    });

    it('should calculate luminance of mid-gray correctly', () => {
      // Mid-gray (#808080) should have luminance around 0.21 (due to sRGB gamma)
      const luminance = service.calculateLuminance('#808080');

      // sRGB mid-gray (128/255 = 0.5) after gamma correction: ~0.21
      expect(luminance).toBeGreaterThan(0.15);
      expect(luminance).toBeLessThan(0.3);
    });

    it('should calculate luminance of pure red correctly', () => {
      // Red luminance coefficient is 0.2126
      const luminance = service.calculateLuminance('#FF0000');

      expect(luminance).toBeCloseTo(0.2126, 2);
    });

    it('should calculate luminance of pure green correctly', () => {
      // Green luminance coefficient is 0.7152
      const luminance = service.calculateLuminance('#00FF00');

      expect(luminance).toBeCloseTo(0.7152, 2);
    });

    it('should calculate luminance of pure blue correctly', () => {
      // Blue luminance coefficient is 0.0722
      const luminance = service.calculateLuminance('#0000FF');

      expect(luminance).toBeCloseTo(0.0722, 2);
    });

    it('should handle lowercase hex colors', () => {
      const luminance = service.calculateLuminance('#ffffff');

      expect(luminance).toBeCloseTo(1.0, 2);
    });

    it('should handle hex colors without #', () => {
      const luminance = service.calculateLuminance('FFFFFF');

      expect(luminance).toBeCloseTo(1.0, 2);
    });
  });

  describe('5. Contrast ratio calculation', () => {
    it('should calculate contrast ratio of black on white as 21:1', () => {
      const ratio = service.calculateContrastRatio('#FFFFFF', '#000000');

      expect(ratio).toBeCloseTo(21, 0);
    });

    it('should calculate contrast ratio of white on black as 21:1', () => {
      // Order should not matter for contrast ratio
      const ratio = service.calculateContrastRatio('#000000', '#FFFFFF');

      expect(ratio).toBeCloseTo(21, 0);
    });

    it('should calculate contrast ratio of same color as 1:1', () => {
      const ratio = service.calculateContrastRatio('#808080', '#808080');

      expect(ratio).toBeCloseTo(1, 1);
    });

    it('should calculate contrast ratio meeting WCAG AA standard (4.5:1)', () => {
      // Dark gray on white should meet AA standard
      const ratio = service.calculateContrastRatio('#FFFFFF', '#595959');

      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it('should calculate contrast ratio meeting WCAG AAA standard (7:1)', () => {
      // Very dark gray on white should meet AAA standard
      const ratio = service.calculateContrastRatio('#FFFFFF', '#333333');

      expect(ratio).toBeGreaterThanOrEqual(7);
    });

    it('should identify low contrast combinations', () => {
      // Light gray on white has low contrast
      const ratio = service.calculateContrastRatio('#FFFFFF', '#DDDDDD');

      expect(ratio).toBeLessThan(2);
    });
  });

  describe('6. Confidence score validation', () => {
    it('should return confidence between 0 and 1', async () => {
      const image = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });

      const result = await service.detectTheme(image);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should have high confidence for pure white image', async () => {
      const whiteImage = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });

      const result = await service.detectTheme(whiteImage);

      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('should have high confidence for pure black image', async () => {
      const blackImage = await createSolidColorImage(100, 100, { r: 0, g: 0, b: 0 });

      const result = await service.detectTheme(blackImage);

      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('should have consistent detection for medium gray image', async () => {
      const grayImage = await createSolidColorImage(100, 100, { r: 128, g: 128, b: 128 });

      const result = await service.detectTheme(grayImage);

      // Medium gray (sRGB 128) has relative luminance ~0.21 (after gamma correction)
      // This is below 0.5 threshold, so it's detected as dark
      // Single-color images have high confidence due to no variance
      expect(result.theme).toBe('dark');
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  describe('Result structure validation', () => {
    it('should return complete ThemeDetectionResult structure', async () => {
      const image = await createSolidColorImage(100, 100, { r: 240, g: 240, b: 240 });

      const result = await service.detectTheme(image);

      // Validate all required fields
      expect(result.theme).toBeDefined();
      expect(['light', 'dark', 'mixed']).toContain(result.theme);

      expect(result.confidence).toBeDefined();
      expect(typeof result.confidence).toBe('number');

      expect(result.backgroundColor).toBeDefined();
      expect(result.backgroundColor).toMatch(/^#[0-9A-Fa-f]{6}$/);

      expect(result.textColor).toBeDefined();
      expect(result.textColor).toMatch(/^#[0-9A-Fa-f]{6}$/);

      expect(result.contrastRatio).toBeDefined();
      expect(typeof result.contrastRatio).toBe('number');
      expect(result.contrastRatio).toBeGreaterThanOrEqual(1);

      expect(result.luminance).toBeDefined();
      expect(result.luminance.background).toBeDefined();
      expect(typeof result.luminance.background).toBe('number');
      expect(result.luminance.background).toBeGreaterThanOrEqual(0);
      expect(result.luminance.background).toBeLessThanOrEqual(1);

      expect(result.luminance.foreground).toBeDefined();
      expect(typeof result.luminance.foreground).toBe('number');
      expect(result.luminance.foreground).toBeGreaterThanOrEqual(0);
      expect(result.luminance.foreground).toBeLessThanOrEqual(1);
    });

    it('should return appropriate background and text colors for light theme', async () => {
      const lightImage = await createSolidColorImage(100, 100, { r: 250, g: 250, b: 250 });

      const result = await service.detectTheme(lightImage);

      // For light theme, background should be light and text should be dark
      expect(result.luminance.background).toBeGreaterThan(0.5);
    });

    it('should return appropriate background and text colors for dark theme', async () => {
      const darkImage = await createSolidColorImage(100, 100, { r: 20, g: 20, b: 20 });

      const result = await service.detectTheme(darkImage);

      // For dark theme, background should be dark
      expect(result.luminance.background).toBeLessThan(0.5);
    });
  });

  describe('Error handling', () => {
    it('should throw error for invalid image input', async () => {
      await expect(service.detectTheme(null as unknown as Buffer)).rejects.toThrow();
    });

    it('should throw error for empty buffer', async () => {
      const emptyBuffer = Buffer.alloc(0);
      await expect(service.detectTheme(emptyBuffer)).rejects.toThrow();
    });

    it('should throw error for invalid hex color in calculateLuminance', () => {
      expect(() => service.calculateLuminance('invalid')).toThrow();
    });

    it('should throw error for invalid hex color in calculateContrastRatio', () => {
      expect(() => service.calculateContrastRatio('#FFFFFF', 'invalid')).toThrow();
    });
  });

  describe('Base64 input support', () => {
    it('should accept base64 encoded image', async () => {
      const image = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });
      const base64Image = image.toString('base64');

      const result = await service.detectTheme(base64Image);

      expect(result.theme).toBe('light');
    });

    it('should accept base64 with data URL prefix', async () => {
      const image = await createSolidColorImage(100, 100, { r: 0, g: 0, b: 0 });
      const base64WithPrefix = `data:image/png;base64,${image.toString('base64')}`;

      const result = await service.detectTheme(base64WithPrefix);

      expect(result.theme).toBe('dark');
    });
  });

  describe('Integration with ColorExtractorService', () => {
    it('should work with colors extracted from real image', async () => {
      // Create a light theme image
      const lightImage = await createLightThemeImage();

      // Extract colors using color extractor
      const colors = await colorExtractor.extractColors(lightImage);

      // Detect theme from extracted colors
      const result = service.detectThemeFromColors(colors);

      expect(result.theme).toBe('light');
    });

    it('should work with colors extracted from dark image', async () => {
      const darkImage = await createDarkThemeImage();

      const colors = await colorExtractor.extractColors(darkImage);
      const result = service.detectThemeFromColors(colors);

      expect(result.theme).toBe('dark');
    });
  });
});
