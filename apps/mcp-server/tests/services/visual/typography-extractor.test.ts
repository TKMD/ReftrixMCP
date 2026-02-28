// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typography Extractor Service Tests
 *
 * TDD Phase: Red
 * These tests define the expected behavior of the TypographyExtractor
 * for extracting font families, sizes, line-height, letter-spacing from HTML/CSS.
 *
 * @module tests/services/visual/typography-extractor.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type {
  TypographyExtractorService} from '../../../src/services/visual/typography-extractor.service';
import {
  TypographyExtractionResult,
  FontFamily,
  FontSizeHierarchy,
  TypographyStyle,
  createTypographyExtractorService,
} from '../../../src/services/visual/typography-extractor.service';

describe('TypographyExtractorService', () => {
  let service: TypographyExtractorService;

  beforeAll(() => {
    service = createTypographyExtractorService();
  });

  describe('extractFromCSS', () => {
    describe('1. Font family extraction', () => {
      it('should extract font-family declarations', () => {
        const css = `
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          }
          h1, h2, h3 {
            font-family: 'Playfair Display', Georgia, serif;
          }
          code {
            font-family: 'JetBrains Mono', 'Fira Code', monospace;
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.fontFamilies).toHaveLength(3);

        const bodyFont = result.fontFamilies.find(f => f.selector === 'body');
        expect(bodyFont?.primary).toBe('Inter');
        expect(bodyFont?.fallbacks).toContain('-apple-system');
        expect(bodyFont?.category).toBe('sans-serif');

        const headingFont = result.fontFamilies.find(f => f.selector === 'h1, h2, h3');
        expect(headingFont?.primary).toBe('Playfair Display');
        expect(headingFont?.category).toBe('serif');

        const codeFont = result.fontFamilies.find(f => f.selector === 'code');
        expect(codeFont?.primary).toBe('JetBrains Mono');
        expect(codeFont?.category).toBe('monospace');
      });

      it('should detect system font stacks', () => {
        const css = `
          body {
            font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          }
        `;

        const result = service.extractFromCSS(css);

        const bodyFont = result.fontFamilies.find(f => f.selector === 'body');
        expect(bodyFont?.isSystemFont).toBe(true);
        expect(bodyFont?.primary).toBe('system-ui');
      });

      it('should detect Google Fonts patterns', () => {
        const css = `
          body {
            font-family: 'Roboto', sans-serif;
          }
          h1 {
            font-family: 'Montserrat', sans-serif;
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.fontFamilies.some(f => f.isGoogleFont)).toBe(true);
      });

      it('should extract font-family from CSS variables', () => {
        const css = `
          :root {
            --font-sans: 'Inter', system-ui, sans-serif;
            --font-mono: 'Fira Code', monospace;
          }
          body {
            font-family: var(--font-sans);
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.fontFamilies.find(f => f.selector === ':root')?.primary).toBe('Inter');
      });
    });

    describe('2. Font size hierarchy extraction', () => {
      it('should extract heading font sizes (h1-h6)', () => {
        const css = `
          h1 { font-size: 3rem; }
          h2 { font-size: 2.25rem; }
          h3 { font-size: 1.875rem; }
          h4 { font-size: 1.5rem; }
          h5 { font-size: 1.25rem; }
          h6 { font-size: 1rem; }
          p { font-size: 1rem; }
        `;

        const result = service.extractFromCSS(css);

        expect(result.fontSizeHierarchy.h1).toBe('3rem');
        expect(result.fontSizeHierarchy.h2).toBe('2.25rem');
        expect(result.fontSizeHierarchy.h3).toBe('1.875rem');
        expect(result.fontSizeHierarchy.h4).toBe('1.5rem');
        expect(result.fontSizeHierarchy.h5).toBe('1.25rem');
        expect(result.fontSizeHierarchy.h6).toBe('1rem');
        expect(result.fontSizeHierarchy.body).toBe('1rem');
      });

      it('should detect scale ratio from hierarchy', () => {
        const css = `
          h1 { font-size: 2.488rem; }
          h2 { font-size: 2.074rem; }
          h3 { font-size: 1.728rem; }
          h4 { font-size: 1.44rem; }
          h5 { font-size: 1.2rem; }
          h6 { font-size: 1rem; }
        `;

        const result = service.extractFromCSS(css);

        // Minor Third scale (1.2) - Standard typographic scale
        // Note: Major Third is 1.25, Minor Third is 1.2
        expect(result.scaleRatio).toBeCloseTo(1.2, 1);
        expect(result.scaleName).toBe('Minor Third');
      });

      it('should extract responsive font sizes with clamp()', () => {
        const css = `
          h1 {
            font-size: clamp(2rem, 5vw, 4rem);
          }
          h2 {
            font-size: clamp(1.5rem, 3vw, 2.5rem);
          }
          p {
            font-size: clamp(1rem, 1.5vw, 1.25rem);
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.responsiveTypography).toHaveLength(3);

        const h1 = result.responsiveTypography.find(r => r.selector === 'h1');
        expect(h1?.min).toBe('2rem');
        expect(h1?.preferred).toBe('5vw');
        expect(h1?.max).toBe('4rem');
        expect(h1?.isResponsive).toBe(true);
      });
    });

    describe('3. Line-height extraction', () => {
      it('should extract line-height values', () => {
        const css = `
          body {
            line-height: 1.6;
          }
          h1 {
            line-height: 1.2;
          }
          .compact {
            line-height: 1.4;
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.styles.find(s => s.selector === 'body')?.lineHeight).toBe('1.6');
        expect(result.styles.find(s => s.selector === 'h1')?.lineHeight).toBe('1.2');
      });

      it('should handle different line-height formats', () => {
        const css = `
          .a { line-height: 1.5; }
          .b { line-height: 24px; }
          .c { line-height: 150%; }
          .d { line-height: normal; }
        `;

        const result = service.extractFromCSS(css);

        expect(result.styles.find(s => s.selector === '.a')?.lineHeight).toBe('1.5');
        expect(result.styles.find(s => s.selector === '.b')?.lineHeight).toBe('24px');
        expect(result.styles.find(s => s.selector === '.c')?.lineHeight).toBe('150%');
        expect(result.styles.find(s => s.selector === '.d')?.lineHeight).toBe('normal');
      });
    });

    describe('4. Letter-spacing extraction', () => {
      it('should extract letter-spacing values', () => {
        const css = `
          h1 {
            letter-spacing: -0.02em;
          }
          .uppercase {
            letter-spacing: 0.1em;
          }
          body {
            letter-spacing: normal;
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.styles.find(s => s.selector === 'h1')?.letterSpacing).toBe('-0.02em');
        expect(result.styles.find(s => s.selector === '.uppercase')?.letterSpacing).toBe('0.1em');
        expect(result.styles.find(s => s.selector === 'body')?.letterSpacing).toBe('normal');
      });
    });

    describe('5. Font-weight extraction', () => {
      it('should extract font-weight values', () => {
        const css = `
          body { font-weight: 400; }
          h1 { font-weight: 700; }
          strong { font-weight: bold; }
          .light { font-weight: 300; }
        `;

        const result = service.extractFromCSS(css);

        expect(result.styles.find(s => s.selector === 'body')?.fontWeight).toBe('400');
        expect(result.styles.find(s => s.selector === 'h1')?.fontWeight).toBe('700');
        expect(result.styles.find(s => s.selector === 'strong')?.fontWeight).toBe('bold');
        expect(result.styles.find(s => s.selector === '.light')?.fontWeight).toBe('300');
      });

      it('should detect font weight range for variable fonts', () => {
        const css = `
          @font-face {
            font-family: 'Inter';
            font-weight: 100 900;
            src: url('inter-var.woff2') format('woff2');
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.variableFonts).toContain('Inter');
        expect(result.fontWeightRange?.min).toBe(100);
        expect(result.fontWeightRange?.max).toBe(900);
      });
    });

    describe('6. Combined typography style extraction', () => {
      it('should extract complete typography styles', () => {
        const css = `
          body {
            font-family: 'Inter', sans-serif;
            font-size: 16px;
            font-weight: 400;
            line-height: 1.6;
            letter-spacing: normal;
          }
        `;

        const result = service.extractFromCSS(css);

        const bodyStyle = result.styles.find(s => s.selector === 'body');
        expect(bodyStyle).toEqual({
          selector: 'body',
          fontFamily: "'Inter', sans-serif",
          fontSize: '16px',
          fontWeight: '400',
          lineHeight: '1.6',
          letterSpacing: 'normal',
        });
      });
    });
  });

  describe('extractFromHTML', () => {
    it('should extract typography from <style> tags', () => {
      const html = `
        <html>
        <head>
          <style>
            body { font-family: 'Roboto', sans-serif; font-size: 16px; }
            h1 { font-size: 2.5rem; font-weight: 700; }
          </style>
        </head>
        <body><h1>Title</h1></body>
        </html>
      `;

      const result = service.extractFromHTML(html);

      expect(result.fontFamilies).toHaveLength(1);
      expect(result.fontSizeHierarchy.h1).toBe('2.5rem');
    });

    it('should extract inline font styles', () => {
      const html = `
        <div style="font-family: Georgia, serif; font-size: 18px; line-height: 1.8;">
          Content
        </div>
      `;

      const result = service.extractFromHTML(html);

      expect(result.inlineStyles).toHaveLength(1);
      expect(result.inlineStyles[0]?.fontFamily).toBe('Georgia, serif');
      expect(result.inlineStyles[0]?.fontSize).toBe('18px');
    });

    it('should detect Google Fonts link tags', () => {
      const html = `
        <html>
        <head>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
          <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
        </head>
        </html>
      `;

      const result = service.extractFromHTML(html);

      expect(result.googleFontsUsed).toContain('Inter');
      expect(result.googleFontsUsed).toContain('Playfair Display');
      expect(result.googleFontsWeights?.['Inter']).toContain('400');
      expect(result.googleFontsWeights?.['Inter']).toContain('700');
    });
  });

  describe('extract (combined HTML + CSS)', () => {
    it('should merge typography from HTML and external CSS', () => {
      const html = `
        <style>body { font-family: 'Inter', sans-serif; }</style>
      `;
      const externalCss = `
        h1 { font-size: 3rem; font-weight: 700; }
      `;

      const result = service.extract(html, externalCss);

      expect(result.fontFamilies.find(f => f.primary === 'Inter')).toBeDefined();
      expect(result.fontSizeHierarchy.h1).toBe('3rem');
    });
  });

  describe('Result structure validation', () => {
    it('should return complete TypographyExtractionResult structure', () => {
      const css = `
        body {
          font-family: 'Inter', sans-serif;
          font-size: 16px;
          line-height: 1.6;
        }
        h1 { font-size: 2rem; }
      `;

      const result = service.extractFromCSS(css);

      expect(result.fontFamilies).toBeDefined();
      expect(Array.isArray(result.fontFamilies)).toBe(true);

      expect(result.fontSizeHierarchy).toBeDefined();
      expect(typeof result.fontSizeHierarchy).toBe('object');

      expect(result.styles).toBeDefined();
      expect(Array.isArray(result.styles)).toBe(true);

      expect(result.responsiveTypography).toBeDefined();
      expect(Array.isArray(result.responsiveTypography)).toBe(true);

      expect(result.processingTimeMs).toBeDefined();
      expect(typeof result.processingTimeMs).toBe('number');
    });
  });

  describe('Error handling', () => {
    it('should handle empty CSS gracefully', () => {
      const result = service.extractFromCSS('');

      expect(result.fontFamilies).toHaveLength(0);
      expect(result.styles).toHaveLength(0);
    });

    it('should handle invalid CSS gracefully', () => {
      const css = `
        body {
          font-family: 'Inter' sans-serif
          /* missing comma */
        }
      `;

      const result = service.extractFromCSS(css);
      expect(result).toBeDefined();
    });

    it('should handle null/undefined inputs', () => {
      expect(() => service.extractFromCSS(null as unknown as string)).not.toThrow();
      expect(() => service.extractFromHTML(undefined as unknown as string)).not.toThrow();
    });
  });

  describe('Scale ratio detection', () => {
    it('should detect Minor Second scale (1.067)', () => {
      const css = `
        h1 { font-size: 1.383rem; }
        h2 { font-size: 1.296rem; }
        h3 { font-size: 1.215rem; }
        h4 { font-size: 1.138rem; }
        h5 { font-size: 1.067rem; }
        h6 { font-size: 1rem; }
      `;

      const result = service.extractFromCSS(css);
      expect(result.scaleName).toBe('Minor Second');
    });

    it('should detect Perfect Fourth scale (1.333)', () => {
      const css = `
        h1 { font-size: 4.209rem; }
        h2 { font-size: 3.157rem; }
        h3 { font-size: 2.369rem; }
        h4 { font-size: 1.777rem; }
        h5 { font-size: 1.333rem; }
        h6 { font-size: 1rem; }
      `;

      const result = service.extractFromCSS(css);
      expect(result.scaleName).toBe('Perfect Fourth');
    });

    it('should detect Golden Ratio scale (1.618)', () => {
      const css = `
        h1 { font-size: 6.854rem; }
        h2 { font-size: 4.236rem; }
        h3 { font-size: 2.618rem; }
        h4 { font-size: 1.618rem; }
        h5 { font-size: 1rem; }
        h6 { font-size: 0.618rem; }
      `;

      const result = service.extractFromCSS(css);
      expect(result.scaleName).toBe('Golden Ratio');
    });
  });

  describe('Performance', () => {
    it('should process large CSS within reasonable time', () => {
      let css = '';
      for (let i = 0; i < 500; i++) {
        css += `.class-${i} { font-size: ${12 + (i % 10)}px; font-family: 'Font ${i}', sans-serif; }\n`;
      }

      const start = Date.now();
      const result = service.extractFromCSS(css);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
      expect(result.fontFamilies.length).toBeGreaterThan(0);
    });
  });
});
