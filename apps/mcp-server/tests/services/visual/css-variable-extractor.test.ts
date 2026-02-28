// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS Variable Extractor Service Tests
 *
 * TDD Phase: Red
 * These tests define the expected behavior of the CSSVariableExtractor
 * for extracting CSS custom properties, clamp(), calc() from HTML/CSS.
 *
 * @module tests/services/visual/css-variable-extractor.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type {
  CSSVariableExtractorService} from '../../../src/services/visual/css-variable-extractor.service';
import {
  CSSVariableExtractionResult,
  CSSVariable,
  ClampValue,
  CalcExpression,
  DesignTokensInfo,
  createCSSVariableExtractorService,
} from '../../../src/services/visual/css-variable-extractor.service';

describe('CSSVariableExtractorService', () => {
  let service: CSSVariableExtractorService;

  beforeAll(() => {
    service = createCSSVariableExtractorService();
  });

  describe('extractFromCSS', () => {
    describe('1. CSS Custom Properties extraction', () => {
      it('should extract basic CSS variables from :root', () => {
        const css = `
          :root {
            --color-primary: #3B82F6;
            --color-secondary: #10B981;
            --spacing-lg: 32px;
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.variables).toHaveLength(3);
        expect(result.variables.find(v => v.name === '--color-primary')).toEqual({
          name: '--color-primary',
          value: '#3B82F6',
          category: 'color',
          scope: ':root',
        });
        expect(result.variables.find(v => v.name === '--spacing-lg')).toEqual({
          name: '--spacing-lg',
          value: '32px',
          category: 'spacing',
          scope: ':root',
        });
      });

      it('should extract CSS variables from multiple selectors', () => {
        const css = `
          :root {
            --color-bg: #ffffff;
          }
          .dark {
            --color-bg: #1a1a1a;
          }
          [data-theme="dark"] {
            --color-text: #ffffff;
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.variables).toHaveLength(3);
        expect(result.variables.find(v => v.scope === '.dark')).toBeDefined();
        expect(result.variables.find(v => v.scope === '[data-theme="dark"]')).toBeDefined();
      });

      it('should categorize CSS variables by naming pattern', () => {
        const css = `
          :root {
            --color-primary: #3B82F6;
            --font-size-lg: 1.25rem;
            --spacing-md: 16px;
            --border-radius-sm: 4px;
            --shadow-lg: 0 10px 15px rgba(0,0,0,0.1);
            --z-index-modal: 1000;
            --transition-fast: 150ms ease;
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.variables.find(v => v.name === '--color-primary')?.category).toBe('color');
        expect(result.variables.find(v => v.name === '--font-size-lg')?.category).toBe('typography');
        expect(result.variables.find(v => v.name === '--spacing-md')?.category).toBe('spacing');
        expect(result.variables.find(v => v.name === '--border-radius-sm')?.category).toBe('border');
        expect(result.variables.find(v => v.name === '--shadow-lg')?.category).toBe('shadow');
        expect(result.variables.find(v => v.name === '--z-index-modal')?.category).toBe('layout');
        expect(result.variables.find(v => v.name === '--transition-fast')?.category).toBe('animation');
      });

      it('should extract CSS variables with var() references', () => {
        const css = `
          :root {
            --color-base: #3B82F6;
            --color-primary: var(--color-base);
            --spacing-unit: 8px;
            --spacing-lg: calc(var(--spacing-unit) * 4);
          }
        `;

        const result = service.extractFromCSS(css);

        const primaryVar = result.variables.find(v => v.name === '--color-primary');
        expect(primaryVar?.value).toBe('var(--color-base)');
        expect(primaryVar?.references).toContain('--color-base');
      });
    });

    describe('2. clamp() value extraction', () => {
      it('should extract clamp() values for responsive typography', () => {
        const css = `
          h1 {
            font-size: clamp(1.5rem, 2vw + 1rem, 3rem);
          }
          h2 {
            font-size: clamp(1.25rem, 1.5vw + 0.875rem, 2rem);
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.clampValues).toHaveLength(2);
        expect(result.clampValues[0]).toEqual({
          property: 'font-size',
          selector: 'h1',
          min: '1.5rem',
          preferred: '2vw + 1rem',
          max: '3rem',
          raw: 'clamp(1.5rem, 2vw + 1rem, 3rem)',
        });
      });

      it('should extract clamp() values for responsive spacing', () => {
        const css = `
          .container {
            padding: clamp(16px, 4vw, 64px);
            gap: clamp(1rem, 2vw, 2rem);
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.clampValues).toHaveLength(2);
        expect(result.clampValues.find(c => c.property === 'padding')?.min).toBe('16px');
        expect(result.clampValues.find(c => c.property === 'gap')?.max).toBe('2rem');
      });

      it('should extract clamp() within CSS variables', () => {
        const css = `
          :root {
            --text-xl: clamp(1.25rem, 1rem + 1.25vw, 1.75rem);
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.clampValues).toHaveLength(1);
        expect(result.clampValues[0]?.selector).toBe(':root');
        expect(result.clampValues[0]?.property).toBe('--text-xl');
      });
    });

    describe('3. calc() expression extraction', () => {
      it('should extract calc() expressions', () => {
        const css = `
          .sidebar {
            width: calc(100% - 280px);
          }
          .content {
            height: calc(100vh - 64px);
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.calcExpressions).toHaveLength(2);
        expect(result.calcExpressions[0]).toEqual({
          property: 'width',
          selector: '.sidebar',
          expression: '100% - 280px',
          raw: 'calc(100% - 280px)',
        });
      });

      it('should extract nested calc() expressions', () => {
        const css = `
          .element {
            margin: calc(var(--spacing-unit) * 2);
            padding: calc(var(--spacing-unit) / 2);
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.calcExpressions).toHaveLength(2);
        expect(result.calcExpressions[0]?.expression).toBe('var(--spacing-unit) * 2');
      });
    });

    describe('4. Design Tokens detection', () => {
      it('should detect Tailwind CSS design tokens', () => {
        const css = `
          :root {
            --tw-ring-offset-width: 0px;
            --tw-ring-color: rgb(59 130 246 / 0.5);
          }
          .text-primary {
            color: rgb(var(--color-primary) / var(--tw-text-opacity));
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.designTokens.framework).toBe('tailwind');
        expect(result.designTokens.confidence).toBeGreaterThan(0.5);
        expect(result.designTokens.evidence).toContain('tw- prefix variables');
      });

      it('should detect CSS-in-JS / Styled Components patterns', () => {
        const css = `
          .sc-bdVaJa {
            color: var(--token-color-primary);
          }
          .emotion-0 {
            background: var(--chakra-colors-gray-100);
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.designTokens.framework).toBe('css-in-js');
        expect(result.designTokens.evidence.length).toBeGreaterThan(0);
      });

      it('should detect standard CSS custom properties design system', () => {
        const css = `
          :root {
            --color-primary-50: #eff6ff;
            --color-primary-100: #dbeafe;
            --color-primary-200: #bfdbfe;
            --color-primary-500: #3b82f6;
            --color-primary-900: #1e3a8a;
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.designTokens.framework).toBe('css-variables');
        expect(result.designTokens.evidence).toContain('color scale pattern (50-900)');
      });

      it('should detect Open Props design tokens', () => {
        const css = `
          :root {
            --size-1: 0.25rem;
            --size-2: 0.5rem;
            --font-sans: system-ui;
            --gray-1: hsl(0 0% 99%);
          }
        `;

        const result = service.extractFromCSS(css);

        expect(result.designTokens.framework).toBe('open-props');
        expect(result.designTokens.confidence).toBeGreaterThan(0.5);
      });
    });
  });

  describe('extractFromHTML', () => {
    it('should extract CSS variables from inline styles', () => {
      const html = `
        <div style="--custom-color: #ff0000; color: var(--custom-color)">
          Content
        </div>
      `;

      const result = service.extractFromHTML(html);

      expect(result.variables.length).toBeGreaterThan(0);
      expect(result.variables.find(v => v.name === '--custom-color')).toBeDefined();
    });

    it('should extract CSS from <style> tags', () => {
      const html = `
        <html>
        <head>
          <style>
            :root {
              --bg-color: #fafafa;
              --text-color: #1a1a1a;
            }
          </style>
        </head>
        <body>
          <p>Content</p>
        </body>
        </html>
      `;

      const result = service.extractFromHTML(html);

      expect(result.variables).toHaveLength(2);
      expect(result.variables.find(v => v.name === '--bg-color')?.value).toBe('#fafafa');
    });

    it('should handle multiple <style> tags', () => {
      const html = `
        <style>:root { --color-a: #111; }</style>
        <style>:root { --color-b: #222; }</style>
      `;

      const result = service.extractFromHTML(html);

      expect(result.variables).toHaveLength(2);
    });
  });

  describe('extract (combined HTML + CSS)', () => {
    it('should extract from both HTML and external CSS', () => {
      const html = `
        <style>:root { --from-html: #111; }</style>
        <div>Content</div>
      `;
      const externalCss = `
        :root { --from-external: #222; }
      `;

      const result = service.extract(html, externalCss);

      expect(result.variables.find(v => v.name === '--from-html')).toBeDefined();
      expect(result.variables.find(v => v.name === '--from-external')).toBeDefined();
    });

    it('should deduplicate variables from multiple sources', () => {
      const html = `<style>:root { --color: #111; }</style>`;
      const externalCss = `:root { --color: #222; }`;

      const result = service.extract(html, externalCss);

      // External CSS should take precedence (loaded later)
      const colorVars = result.variables.filter(v => v.name === '--color');
      expect(colorVars).toHaveLength(1);
      expect(colorVars[0]?.value).toBe('#222');
    });
  });

  describe('Result structure validation', () => {
    it('should return complete CSSVariableExtractionResult structure', () => {
      const css = `
        :root {
          --color: #333;
          --size: clamp(1rem, 2vw, 2rem);
          --width: calc(100% - 20px);
        }
      `;

      const result = service.extractFromCSS(css);

      expect(result.variables).toBeDefined();
      expect(Array.isArray(result.variables)).toBe(true);

      expect(result.clampValues).toBeDefined();
      expect(Array.isArray(result.clampValues)).toBe(true);

      expect(result.calcExpressions).toBeDefined();
      expect(Array.isArray(result.calcExpressions)).toBe(true);

      expect(result.designTokens).toBeDefined();
      expect(result.designTokens.framework).toBeDefined();
      expect(result.designTokens.confidence).toBeDefined();
      expect(result.designTokens.evidence).toBeDefined();

      expect(result.processingTimeMs).toBeDefined();
      expect(typeof result.processingTimeMs).toBe('number');
    });
  });

  describe('Error handling', () => {
    it('should handle empty CSS gracefully', () => {
      const result = service.extractFromCSS('');

      expect(result.variables).toHaveLength(0);
      expect(result.clampValues).toHaveLength(0);
      expect(result.calcExpressions).toHaveLength(0);
    });

    it('should handle invalid CSS gracefully', () => {
      const css = `
        :root {
          --color: #333
          /* missing semicolon */
          --size: 16px;
        }
      `;

      // Should not throw, should extract what it can
      const result = service.extractFromCSS(css);
      expect(result).toBeDefined();
    });

    it('should handle malformed clamp() gracefully', () => {
      const css = `
        .element {
          font-size: clamp(1rem);
          /* missing parameters */
        }
      `;

      const result = service.extractFromCSS(css);
      // Should not include malformed clamp
      expect(result.clampValues.filter(c => c.min && c.preferred && c.max)).toHaveLength(0);
    });

    it('should handle null/undefined inputs', () => {
      expect(() => service.extractFromCSS(null as unknown as string)).not.toThrow();
      expect(() => service.extractFromHTML(undefined as unknown as string)).not.toThrow();
    });
  });

  describe('Performance', () => {
    it('should process large CSS files within reasonable time', () => {
      // Generate large CSS
      let css = ':root {\n';
      for (let i = 0; i < 1000; i++) {
        css += `  --color-${i}: #${i.toString(16).padStart(6, '0')};\n`;
      }
      css += '}';

      const start = Date.now();
      const result = service.extractFromCSS(css);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000); // Should process within 1 second
      expect(result.variables).toHaveLength(1000);
    });
  });
});
