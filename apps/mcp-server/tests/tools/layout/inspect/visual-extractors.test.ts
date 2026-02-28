// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Extractors Integration Tests
 *
 * Tests for the unified visual extraction utilities that integrate
 * CSSVariableExtractor, TypographyExtractor, and GradientDetector.
 *
 * @module tests/tools/layout/inspect/visual-extractors.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  extractVisualFeatures,
  extractCSSVariables,
  extractTypographyFeatures,
  detectGradients,
  resetVisualExtractorServices,
  type VisualExtractionResult,
  type VisualExtractionOptions,
} from '../../../../src/tools/layout/inspect/visual-extractors.utils';

describe('Visual Extractors Integration', () => {
  beforeEach(() => {
    // Reset services before each test for clean state
    resetVisualExtractorServices();
  });

  afterEach(() => {
    resetVisualExtractorServices();
  });

  describe('extractVisualFeatures', () => {
    it('should extract all visual features from HTML', async () => {
      const html = `
        <html>
        <head>
          <style>
            :root {
              --color-primary: #3b82f6;
              --font-sans: 'Inter', system-ui, sans-serif;
              --spacing-lg: 2rem;
            }
            body {
              font-family: var(--font-sans);
              font-size: 16px;
              line-height: 1.6;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            h1 {
              font-size: 2.5rem;
              font-weight: 700;
            }
          </style>
        </head>
        <body>
          <h1>Hello World</h1>
        </body>
        </html>
      `;

      const result = await extractVisualFeatures(html);

      // Verify structure
      expect(result).toBeDefined();
      expect(result.totalProcessingTimeMs).toBeGreaterThanOrEqual(0);

      // CSS Variables
      expect(result.cssVariables).toBeDefined();
      expect(result.cssVariables?.variables.length).toBeGreaterThan(0);
      expect(result.cssVariables?.variables.some(v => v.name === '--color-primary')).toBe(true);

      // Typography
      expect(result.typography).toBeDefined();
      expect(result.typography?.fontFamilies.length).toBeGreaterThan(0);

      // Gradients
      expect(result.gradients).toBeDefined();
      expect(result.gradients?.hasGradient).toBe(true);
      expect(result.gradients?.gradients.length).toBeGreaterThan(0);
    });

    it('should respect extraction options', async () => {
      const html = `
        <style>
          :root { --color: #000; }
          body { font-size: 16px; background: linear-gradient(red, blue); }
        </style>
      `;

      const options: VisualExtractionOptions = {
        extractCSSVariables: true,
        extractTypography: false,
        detectGradients: false,
      };

      const result = await extractVisualFeatures(html, options);

      expect(result.cssVariables).toBeDefined();
      expect(result.typography).toBeUndefined();
      expect(result.gradients).toBeUndefined();
    });

    it('should handle external CSS', async () => {
      const html = '<div>Content</div>';
      const externalCss = `
        :root {
          --spacing: 1rem;
          --font-heading: 'Playfair Display', serif;
        }
        body {
          font-family: var(--font-heading);
          font-size: 18px;
        }
      `;

      const result = await extractVisualFeatures(html, { externalCss });

      expect(result.cssVariables?.variables.some(v => v.name === '--spacing')).toBe(true);
      expect(result.typography?.fontFamilies.length).toBeGreaterThan(0);
    });

    it('should run extractions in parallel', async () => {
      const html = `
        <style>
          :root { --color: blue; }
          body { font-size: 16px; background: radial-gradient(circle, red, blue); }
        </style>
      `;

      const startTime = Date.now();
      const result = await extractVisualFeatures(html);
      const elapsedTime = Date.now() - startTime;

      // Should complete quickly since extractions run in parallel
      expect(elapsedTime).toBeLessThan(500);
      expect(result.cssVariables).toBeDefined();
      expect(result.typography).toBeDefined();
      expect(result.gradients).toBeDefined();
    });

    it('should handle empty HTML gracefully', async () => {
      const result = await extractVisualFeatures('');

      expect(result).toBeDefined();
      expect(result.totalProcessingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle HTML without any visual features', async () => {
      const html = '<div>Plain text content</div>';

      const result = await extractVisualFeatures(html);

      expect(result).toBeDefined();
      expect(result.cssVariables?.variables.length).toBe(0);
      expect(result.typography?.fontFamilies.length).toBe(0);
    });
  });

  describe('extractCSSVariables', () => {
    it('should extract CSS variables from HTML', () => {
      const html = `
        <style>
          :root {
            --primary-color: #007bff;
            --secondary-color: #6c757d;
            --font-size-base: 1rem;
          }
        </style>
      `;

      const result = extractCSSVariables(html);

      expect(result.variables.length).toBe(3);
      expect(result.variables.some(v => v.name === '--primary-color')).toBe(true);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should extract clamp() values', () => {
      const html = `
        <style>
          h1 {
            font-size: clamp(1.5rem, 4vw, 3rem);
          }
        </style>
      `;

      const result = extractCSSVariables(html);

      expect(result.clampValues.length).toBeGreaterThan(0);
      expect(result.clampValues[0]?.min).toBe('1.5rem');
      expect(result.clampValues[0]?.max).toBe('3rem');
    });

    it('should detect design token systems', () => {
      const html = `
        <style>
          :root {
            --tw-ring-color: rgba(59, 130, 246, 0.5);
            --tw-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          }
        </style>
      `;

      const result = extractCSSVariables(html);

      // Design tokens detection uses 'framework' field, not 'system'
      expect(result.designTokens?.framework).toBe('tailwind');
      expect(result.designTokens?.confidence).toBeGreaterThan(0);
    });
  });

  describe('extractTypographyFeatures', () => {
    it('should extract font families', () => {
      const html = `
        <style>
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          }
          h1 {
            font-family: 'Playfair Display', Georgia, serif;
          }
        </style>
      `;

      const result = extractTypographyFeatures(html);

      expect(result.fontFamilies.length).toBe(2);
      expect(result.fontFamilies.some(f => f.primary === 'Inter')).toBe(true);
      expect(result.fontFamilies.some(f => f.primary === 'Playfair Display')).toBe(true);
    });

    it('should extract font size hierarchy', () => {
      const html = `
        <style>
          h1 { font-size: 2.5rem; }
          h2 { font-size: 2rem; }
          h3 { font-size: 1.75rem; }
          p { font-size: 1rem; }
        </style>
      `;

      const result = extractTypographyFeatures(html);

      expect(result.fontSizeHierarchy.h1).toBe('2.5rem');
      expect(result.fontSizeHierarchy.h2).toBe('2rem');
      expect(result.fontSizeHierarchy.h3).toBe('1.75rem');
      expect(result.fontSizeHierarchy.body).toBe('1rem');
    });

    it('should detect responsive typography', () => {
      const html = `
        <style>
          h1 {
            font-size: clamp(2rem, 5vw, 4rem);
          }
        </style>
      `;

      const result = extractTypographyFeatures(html);

      expect(result.responsiveTypography.length).toBeGreaterThan(0);
      expect(result.responsiveTypography[0]?.isResponsive).toBe(true);
    });
  });

  describe('detectGradients', () => {
    it('should detect linear gradients', () => {
      const css = `
        .hero {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
      `;

      const result = detectGradients(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients.length).toBeGreaterThan(0);
      expect(result.gradients[0]?.type).toBe('linear');
    });

    it('should detect radial gradients', () => {
      const css = `
        .circle {
          background: radial-gradient(circle at center, #fff 0%, #000 100%);
        }
      `;

      const result = detectGradients(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients.some(g => g.type === 'radial')).toBe(true);
    });

    it('should detect conic gradients', () => {
      const css = `
        .pie {
          background: conic-gradient(red 0deg, yellow 90deg, green 180deg, blue 270deg, red 360deg);
        }
      `;

      const result = detectGradients(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients.some(g => g.type === 'conic')).toBe(true);
    });

    it('should detect gradient animations', () => {
      const css = `
        .animated {
          background: linear-gradient(90deg, red, blue);
          animation: gradient-shift 3s ease infinite;
        }
      `;

      const result = detectGradients(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0]?.animation).toBeDefined();
      expect(result.gradients[0]?.animation?.name).toBe('gradient-shift');
    });

    it('should detect gradient transitions', () => {
      const css = `
        .hover-gradient {
          background: linear-gradient(to right, #ff6b6b, #4ecdc4);
          transition: background 0.3s ease-in-out;
        }
      `;

      const result = detectGradients(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0]?.transition).toBeDefined();
      expect(result.gradients[0]?.transition?.duration).toBe('0.3s');
    });

    it('should return empty for CSS without gradients', () => {
      const css = `
        .solid {
          background-color: #fff;
        }
      `;

      const result = detectGradients(css);

      expect(result.hasGradient).toBe(false);
      expect(result.gradients.length).toBe(0);
    });
  });

  describe('Service Lifecycle', () => {
    it('should reset services correctly', async () => {
      const html = `<style>:root { --test: #000; }</style>`;

      // First extraction
      const result1 = await extractVisualFeatures(html);
      expect(result1.cssVariables?.variables.length).toBe(1);

      // Reset and extract again
      resetVisualExtractorServices();

      const result2 = await extractVisualFeatures(html);
      expect(result2.cssVariables?.variables.length).toBe(1);
    });
  });
});
