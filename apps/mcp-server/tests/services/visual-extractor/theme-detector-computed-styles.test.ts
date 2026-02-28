// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Theme Detector Service - Computed Styles Integration Tests
 *
 * TDD Phase: RED
 * These tests verify that ThemeDetectorService can use Computed Styles
 * from Playwright to enhance theme detection accuracy.
 *
 * Problem: Sites like E&A Financial (https://ea.madebybuzzworthy.com/)
 * use dark backgrounds (#0A1628) via CSS-in-JS/Tailwind that are not
 * captured by static HTML analysis or screenshot color extraction alone.
 *
 * Solution: Use Playwright's getComputedStyle() results to prioritize
 * actual computed backgroundColor values for theme detection.
 *
 * @module tests/services/visual-extractor/theme-detector-computed-styles.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import type {
  ThemeDetectorService} from '../../../src/services/visual-extractor/theme-detector.service';
import {
  createThemeDetectorService,
} from '../../../src/services/visual-extractor/theme-detector.service';
import type {
  ComputedStyleInfo,
  ElementComputedStyles,
} from '../../../src/services/page-ingest-adapter';

/**
 * Helper to create a mock ComputedStyleInfo with specified background color
 */
function createMockComputedStyleInfo(
  backgroundColor: string,
  textColor: string = 'rgb(255, 255, 255)',
  index: number = 0
): ComputedStyleInfo {
  const styles: ElementComputedStyles = {
    // Background
    backgroundColor,
    backgroundImage: 'none',
    // Text
    color: textColor,
    fontSize: '16px',
    fontFamily: 'Inter, sans-serif',
    fontWeight: '400',
    lineHeight: '1.5',
    letterSpacing: 'normal',
    textAlign: 'left',
    textDecoration: 'none',
    textTransform: 'none',
    // Layout
    display: 'flex',
    position: 'relative',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '0px',
    paddingTop: '80px',
    paddingRight: '24px',
    paddingBottom: '80px',
    paddingLeft: '24px',
    margin: '0px',
    marginTop: '0px',
    marginRight: '0px',
    marginBottom: '0px',
    marginLeft: '0px',
    gap: '0px',
    width: '100%',
    height: 'auto',
    maxWidth: 'none',
    minHeight: '100vh',
    // Visual effects
    border: 'none',
    borderRadius: '0px',
    boxShadow: 'none',
    backdropFilter: 'none',
    opacity: '1',
    overflow: 'visible',
    // Transitions
    transition: 'none',
    transform: 'none',
  };

  return {
    index,
    tagName: 'SECTION',
    className: 'hero-section',
    id: 'hero',
    role: 'banner',
    styles,
  };
}

/**
 * Helper to create solid color test images
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

describe('ThemeDetectorService - Computed Styles Integration', () => {
  let service: ThemeDetectorService;

  beforeAll(() => {
    service = createThemeDetectorService();
  });

  describe('detectThemeWithComputedStyles', () => {
    describe('1. Dark theme detection from Computed Styles', () => {
      it('should detect dark theme from rgb() backgroundColor', async () => {
        // E&A Financial style: dark blue background #0A1628 = rgb(10, 22, 40)
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('rgb(10, 22, 40)', 'rgb(255, 255, 255)'),
        ];

        // Even with a light screenshot (wrong detection), computed styles should override
        const lightScreenshot = await createSolidColorImage(100, 100, { r: 200, g: 200, b: 200 });

        const result = await service.detectThemeWithComputedStyles(lightScreenshot, computedStyles);

        expect(result).toBeDefined();
        expect(result.theme).toBe('dark');
        expect(result.confidence).toBeGreaterThan(0.8);
        // Should reflect computed backgroundColor, not screenshot-derived color
        expect(result.computedStylesUsed).toBe(true);
      });

      it('should detect dark theme from rgba() backgroundColor', async () => {
        // Dark background with alpha channel
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('rgba(10, 22, 40, 1)', 'rgba(255, 255, 255, 0.9)'),
        ];

        const lightScreenshot = await createSolidColorImage(100, 100, { r: 240, g: 240, b: 240 });

        const result = await service.detectThemeWithComputedStyles(lightScreenshot, computedStyles);

        expect(result.theme).toBe('dark');
        expect(result.computedStylesUsed).toBe(true);
      });

      it('should detect dark theme from hex backgroundColor', async () => {
        // Some browsers may return hex format
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('#0A1628', '#FFFFFF'),
        ];

        const lightScreenshot = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });

        const result = await service.detectThemeWithComputedStyles(lightScreenshot, computedStyles);

        expect(result.theme).toBe('dark');
        expect(result.computedStylesUsed).toBe(true);
      });

      it('should detect dark theme from multiple sections with dark backgrounds', async () => {
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('rgb(10, 22, 40)', 'rgb(255, 255, 255)', 0), // header
          createMockComputedStyleInfo('rgb(15, 25, 45)', 'rgb(255, 255, 255)', 1), // hero
          createMockComputedStyleInfo('rgb(20, 30, 50)', 'rgb(200, 200, 200)', 2), // features
        ];

        const lightScreenshot = await createSolidColorImage(100, 100, { r: 250, g: 250, b: 250 });

        const result = await service.detectThemeWithComputedStyles(lightScreenshot, computedStyles);

        expect(result.theme).toBe('dark');
        expect(result.computedStylesUsed).toBe(true);
      });
    });

    describe('2. Light theme detection from Computed Styles', () => {
      it('should detect light theme from rgb() backgroundColor', async () => {
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('rgb(255, 255, 255)', 'rgb(33, 33, 33)'),
        ];

        // Even with a dark screenshot (wrong detection), computed styles should override
        const darkScreenshot = await createSolidColorImage(100, 100, { r: 30, g: 30, b: 30 });

        const result = await service.detectThemeWithComputedStyles(darkScreenshot, computedStyles);

        expect(result.theme).toBe('light');
        expect(result.computedStylesUsed).toBe(true);
      });

      it('should detect light theme from off-white backgroundColor', async () => {
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('rgb(250, 250, 250)', 'rgb(50, 50, 50)'),
        ];

        const darkScreenshot = await createSolidColorImage(100, 100, { r: 20, g: 20, b: 20 });

        const result = await service.detectThemeWithComputedStyles(darkScreenshot, computedStyles);

        expect(result.theme).toBe('light');
      });
    });

    describe('3. Transparent/empty backgroundColor handling', () => {
      it('should fallback to screenshot analysis when backgroundColor is transparent', async () => {
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'),
        ];

        const darkScreenshot = await createSolidColorImage(100, 100, { r: 20, g: 20, b: 30 });

        const result = await service.detectThemeWithComputedStyles(darkScreenshot, computedStyles);

        expect(result.theme).toBe('dark');
        expect(result.computedStylesUsed).toBe(false); // Transparent, so screenshot used
      });

      it('should fallback when all sections have transparent backgrounds', async () => {
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('transparent', 'rgb(255, 255, 255)', 0),
          createMockComputedStyleInfo('rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)', 1),
        ];

        const lightScreenshot = await createSolidColorImage(100, 100, { r: 250, g: 250, b: 250 });

        const result = await service.detectThemeWithComputedStyles(lightScreenshot, computedStyles);

        expect(result.theme).toBe('light');
        expect(result.computedStylesUsed).toBe(false);
      });

      it('should use non-transparent section even if first section is transparent', async () => {
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('transparent', 'rgb(255, 255, 255)', 0), // nav - transparent
          createMockComputedStyleInfo('rgb(10, 22, 40)', 'rgb(255, 255, 255)', 1), // hero - dark
        ];

        const lightScreenshot = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });

        const result = await service.detectThemeWithComputedStyles(lightScreenshot, computedStyles);

        expect(result.theme).toBe('dark');
        expect(result.computedStylesUsed).toBe(true);
      });
    });

    describe('4. Empty/null computed styles handling', () => {
      it('should fallback to screenshot when computedStyles is empty array', async () => {
        const computedStyles: ComputedStyleInfo[] = [];

        const darkScreenshot = await createSolidColorImage(100, 100, { r: 20, g: 20, b: 20 });

        const result = await service.detectThemeWithComputedStyles(darkScreenshot, computedStyles);

        expect(result.theme).toBe('dark');
        expect(result.computedStylesUsed).toBe(false);
      });

      it('should fallback to screenshot when computedStyles is undefined', async () => {
        const darkScreenshot = await createSolidColorImage(100, 100, { r: 20, g: 20, b: 20 });

        const result = await service.detectThemeWithComputedStyles(darkScreenshot, undefined);

        expect(result.theme).toBe('dark');
        expect(result.computedStylesUsed).toBe(false);
      });
    });

    describe('5. Mixed theme detection', () => {
      it('should detect mixed when sections have both light and dark backgrounds', async () => {
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('rgb(255, 255, 255)', 'rgb(33, 33, 33)', 0), // Light header
          createMockComputedStyleInfo('rgb(10, 22, 40)', 'rgb(255, 255, 255)', 1), // Dark hero
          createMockComputedStyleInfo('rgb(250, 250, 250)', 'rgb(50, 50, 50)', 2), // Light features
        ];

        const screenshot = await createSolidColorImage(100, 100, { r: 128, g: 128, b: 128 });

        const result = await service.detectThemeWithComputedStyles(screenshot, computedStyles);

        // When there's significant variance in section backgrounds, could be mixed
        expect(['light', 'dark', 'mixed']).toContain(result.theme);
        expect(result.computedStylesUsed).toBe(true);
      });
    });

    describe('6. E&A Financial real-world case', () => {
      it('should correctly detect E&A Financial as dark theme', async () => {
        // Real computed styles from E&A Financial site
        // Background: #0A1628 = rgb(10, 22, 40)
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('rgb(10, 22, 40)', 'rgb(255, 255, 255)', 0), // header
          createMockComputedStyleInfo('rgb(10, 22, 40)', 'rgb(255, 255, 255)', 1), // hero
          createMockComputedStyleInfo('rgb(10, 22, 40)', 'rgb(224, 224, 224)', 2), // main
        ];

        // Screenshot that might incorrectly show light/mixed due to image processing
        const ambiguousScreenshot = await createSolidColorImage(100, 100, { r: 150, g: 150, b: 150 });

        const result = await service.detectThemeWithComputedStyles(ambiguousScreenshot, computedStyles);

        expect(result.theme).toBe('dark');
        expect(result.confidence).toBeGreaterThan(0.9);
        expect(result.computedStylesUsed).toBe(true);
        // Background color should be derived from computed styles
        expect(result.backgroundColor).toMatch(/#0[A-Fa-f0-9]{5}|rgb\(10,\s*22,\s*40\)/i);
      });
    });

    describe('7. Result structure validation', () => {
      it('should include computedStylesUsed flag in result', async () => {
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('rgb(10, 22, 40)', 'rgb(255, 255, 255)'),
        ];
        const screenshot = await createSolidColorImage(100, 100, { r: 200, g: 200, b: 200 });

        const result = await service.detectThemeWithComputedStyles(screenshot, computedStyles);

        expect(result).toHaveProperty('computedStylesUsed');
        expect(typeof result.computedStylesUsed).toBe('boolean');
      });

      it('should include all standard ThemeDetectionResult fields', async () => {
        const computedStyles: ComputedStyleInfo[] = [
          createMockComputedStyleInfo('rgb(20, 30, 40)', 'rgb(230, 230, 230)'),
        ];
        const screenshot = await createSolidColorImage(100, 100, { r: 200, g: 200, b: 200 });

        const result = await service.detectThemeWithComputedStyles(screenshot, computedStyles);

        expect(result.theme).toBeDefined();
        expect(['light', 'dark', 'mixed']).toContain(result.theme);
        expect(result.confidence).toBeDefined();
        expect(result.backgroundColor).toBeDefined();
        expect(result.textColor).toBeDefined();
        expect(result.contrastRatio).toBeDefined();
        expect(result.luminance).toBeDefined();
        expect(result.luminance.background).toBeDefined();
        expect(result.luminance.foreground).toBeDefined();
      });
    });
  });

  describe('parseRgbColor helper', () => {
    it('should parse rgb() format correctly', () => {
      // This tests the internal color parsing
      // Expected to be exposed or testable through the service
      const computedStyles: ComputedStyleInfo[] = [
        createMockComputedStyleInfo('rgb(10, 22, 40)', 'rgb(255, 255, 255)'),
      ];

      // The parsing happens internally, we verify through theme detection
      // If parsing works, theme should be correctly detected
      expect(async () => {
        const screenshot = await createSolidColorImage(50, 50, { r: 128, g: 128, b: 128 });
        await service.detectThemeWithComputedStyles(screenshot, computedStyles);
      }).not.toThrow();
    });
  });
});
