// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS Variable Resolver Tests
 *
 * @module @reftrix/webdesign-core/tests/utils/css-variable-resolver
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CssVariableResolver,
  containsCssVariable,
  extractCssVariableNames,
  extractAndResolveColors,
  isValidColorValue,
} from '../../src/utils/css-variable-resolver';

describe('CssVariableResolver', () => {
  let resolver: CssVariableResolver;

  beforeEach(() => {
    resolver = new CssVariableResolver();
  });

  describe('containsCssVariable', () => {
    it('should detect CSS variable references', () => {
      expect(containsCssVariable('var(--color-bg)')).toBe(true);
      expect(containsCssVariable('var(--my-custom-var)')).toBe(true);
      expect(containsCssVariable('var( --spaced )')).toBe(true);
    });

    it('should return false for non-variable values', () => {
      expect(containsCssVariable('#ffffff')).toBe(false);
      expect(containsCssVariable('rgb(255, 255, 255)')).toBe(false);
      expect(containsCssVariable('red')).toBe(false);
      expect(containsCssVariable('transparent')).toBe(false);
    });

    it('should handle mixed values', () => {
      expect(containsCssVariable('linear-gradient(var(--color), #000)')).toBe(true);
      expect(containsCssVariable('1px solid var(--border-color)')).toBe(true);
    });
  });

  describe('extractCssVariableNames', () => {
    it('should extract variable names', () => {
      expect(extractCssVariableNames('var(--color-bg)')).toEqual(['--color-bg']);
      expect(extractCssVariableNames('var(--a) var(--b)')).toEqual(['--a', '--b']);
    });

    it('should handle fallback values', () => {
      expect(extractCssVariableNames('var(--color, #fff)')).toEqual(['--color']);
    });

    it('should return empty array for no variables', () => {
      expect(extractCssVariableNames('#ffffff')).toEqual([]);
    });
  });

  describe('setVariable and getVariable', () => {
    it('should set and get variables', () => {
      resolver.setVariable('--color-bg', '#ffffff');
      expect(resolver.getVariable('--color-bg')).toBe('#ffffff');
    });

    it('should handle variable names without -- prefix', () => {
      resolver.setVariable('color-bg', '#ffffff');
      expect(resolver.getVariable('color-bg')).toBe('#ffffff');
      expect(resolver.getVariable('--color-bg')).toBe('#ffffff');
    });

    it('should return undefined for non-existent variables', () => {
      expect(resolver.getVariable('--non-existent')).toBeUndefined();
    });
  });

  describe('setVariables', () => {
    it('should set multiple variables', () => {
      resolver.setVariables({
        '--color-bg': '#ffffff',
        '--color-text': '#000000',
      });

      expect(resolver.getVariable('--color-bg')).toBe('#ffffff');
      expect(resolver.getVariable('--color-text')).toBe('#000000');
    });
  });

  describe('getAllVariables', () => {
    it('should return all variables', () => {
      resolver.setVariable('--a', '1');
      resolver.setVariable('--b', '2');

      const all = resolver.getAllVariables();
      expect(all).toEqual({
        '--a': '1',
        '--b': '2',
      });
    });
  });

  describe('resolve', () => {
    beforeEach(() => {
      resolver.setVariables({
        '--color-bg': '#ffffff',
        '--color-text': '#000000',
        '--spacing-sm': '8px',
        '--spacing-md': 'var(--spacing-sm)',
        '--nested-a': 'var(--nested-b)',
        '--nested-b': 'var(--nested-c)',
        '--nested-c': 'final-value',
      });
    });

    it('should resolve simple variable', () => {
      const result = resolver.resolve('var(--color-bg)');
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toBe('#ffffff');
    });

    it('should return non-variable values unchanged', () => {
      const result = resolver.resolve('#ff0000');
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toBe('#ff0000');
    });

    it('should handle fallback values for undefined variables', () => {
      const result = resolver.resolve('var(--undefined-var, #fallback)');
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toBe('#fallback');
      expect(result.fallbackUsed).toBe(true);
    });

    it('should resolve nested variables', () => {
      const result = resolver.resolve('var(--spacing-md)');
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toBe('8px');
    });

    it('should resolve deeply nested variables', () => {
      const result = resolver.resolve('var(--nested-a)');
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toBe('final-value');
    });

    it('should handle mixed content', () => {
      const result = resolver.resolve('1px solid var(--color-text)');
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toBe('1px solid #000000');
    });

    it('should handle multiple variables in one value', () => {
      const result = resolver.resolve('var(--color-bg) var(--color-text)');
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toBe('#ffffff #000000');
    });

    it('should detect circular references', () => {
      resolver.setVariable('--circular-a', 'var(--circular-b)');
      resolver.setVariable('--circular-b', 'var(--circular-a)');

      const result = resolver.resolve('var(--circular-a)');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Circular reference');
    });

    it('should handle invalid input', () => {
      const result = resolver.resolve('');
      expect(result.success).toBe(false);
    });
  });

  describe('extractVariablesFromHtml', () => {
    it('should extract variables from style tags', () => {
      const html = `
        <html>
        <head>
          <style>
            :root {
              --color-bg: #fafafa;
              --color-text: #0a0a0a;
            }
          </style>
        </head>
        <body></body>
        </html>
      `;

      const count = resolver.extractVariablesFromHtml(html);
      expect(count).toBe(2);
      expect(resolver.getVariable('--color-bg')).toBe('#fafafa');
      expect(resolver.getVariable('--color-text')).toBe('#0a0a0a');
    });

    it('should extract variables from html selector', () => {
      const html = `
        <style>
          html {
            --primary: blue;
          }
        </style>
      `;

      resolver.extractVariablesFromHtml(html);
      expect(resolver.getVariable('--primary')).toBe('blue');
    });

    it('should extract variables from body selector', () => {
      const html = `
        <style>
          body {
            --body-bg: white;
          }
        </style>
      `;

      resolver.extractVariablesFromHtml(html);
      expect(resolver.getVariable('--body-bg')).toBe('white');
    });

    it('should handle multiple style tags', () => {
      const html = `
        <style>:root { --a: 1; }</style>
        <style>:root { --b: 2; }</style>
      `;

      resolver.extractVariablesFromHtml(html);
      expect(resolver.getVariable('--a')).toBe('1');
      expect(resolver.getVariable('--b')).toBe('2');
    });

    it('should handle empty HTML', () => {
      const count = resolver.extractVariablesFromHtml('');
      expect(count).toBe(0);
    });

    it('should override earlier definitions with later ones', () => {
      const html = `
        <style>
          :root { --color: red; }
          :root { --color: blue; }
        </style>
      `;

      resolver.extractVariablesFromHtml(html);
      expect(resolver.getVariable('--color')).toBe('blue');
    });
  });

  describe('extractVariablesFromCss', () => {
    it('should extract variables from CSS text', () => {
      const css = `
        :root {
          --font-size-base: 16px;
          --line-height: 1.5;
        }
      `;

      const count = resolver.extractVariablesFromCss(css);
      expect(count).toBe(2);
      expect(resolver.getVariable('--font-size-base')).toBe('16px');
      expect(resolver.getVariable('--line-height')).toBe('1.5');
    });

    it('should handle theme selectors', () => {
      const css = `
        .dark {
          --bg: #1a1a1a;
        }
        .light {
          --bg: #ffffff;
        }
      `;

      resolver.extractVariablesFromCss(css);
      // Note: both will be extracted, last one wins
      expect(resolver.getVariable('--bg')).toBeDefined();
    });
  });

  describe('size and clear', () => {
    it('should track variable count', () => {
      expect(resolver.size).toBe(0);
      resolver.setVariable('--a', '1');
      expect(resolver.size).toBe(1);
      resolver.setVariable('--b', '2');
      expect(resolver.size).toBe(2);
    });

    it('should clear all variables', () => {
      resolver.setVariable('--a', '1');
      resolver.setVariable('--b', '2');
      resolver.clear();
      expect(resolver.size).toBe(0);
    });
  });
});

describe('extractAndResolveColors', () => {
  it('should extract and resolve background colors', () => {
    const html = `
      <style>
        :root {
          --bg-primary: #f0f0f0;
          --bg-secondary: #e0e0e0;
        }
      </style>
      <div style="background-color: var(--bg-primary)"></div>
      <div style="background: var(--bg-secondary)"></div>
    `;

    const result = extractAndResolveColors(html);
    expect(result.backgroundColors).toContain('#f0f0f0');
    expect(result.backgroundColors).toContain('#e0e0e0');
  });

  it('should extract and resolve text colors', () => {
    const html = `
      <style>
        :root {
          --text-primary: #333333;
        }
      </style>
      <p style="color: var(--text-primary)"></p>
    `;

    const result = extractAndResolveColors(html);
    expect(result.textColors).toContain('#333333');
  });

  it('should handle fallback values', () => {
    const html = `
      <div style="background-color: var(--undefined, #999999)"></div>
    `;

    const result = extractAndResolveColors(html);
    expect(result.backgroundColors).toContain('#999999');
  });

  it('should include CSS content in extraction', () => {
    const html = '<div style="background: var(--external-color)"></div>';
    const css = ':root { --external-color: navy; }';

    const result = extractAndResolveColors(html, css);
    expect(result.backgroundColors).toContain('navy');
  });

  it('should return resolver instance', () => {
    const result = extractAndResolveColors('<div></div>');
    expect(result.resolver).toBeInstanceOf(CssVariableResolver);
  });
});

describe('isValidColorValue', () => {
  describe('hex colors', () => {
    it('should validate hex colors', () => {
      expect(isValidColorValue('#fff')).toBe(true);
      expect(isValidColorValue('#ffffff')).toBe(true);
      expect(isValidColorValue('#FFFFFF')).toBe(true);
      expect(isValidColorValue('#ff000080')).toBe(true); // with alpha
    });

    it('should reject invalid hex', () => {
      expect(isValidColorValue('#ff')).toBe(false);
      expect(isValidColorValue('#gggggg')).toBe(false);
    });
  });

  describe('rgb/rgba colors', () => {
    it('should validate rgb/rgba', () => {
      expect(isValidColorValue('rgb(255, 255, 255)')).toBe(true);
      expect(isValidColorValue('rgba(255, 255, 255, 0.5)')).toBe(true);
      expect(isValidColorValue('RGB(0, 0, 0)')).toBe(true);
    });
  });

  describe('hsl/hsla colors', () => {
    it('should validate hsl/hsla', () => {
      expect(isValidColorValue('hsl(0, 100%, 50%)')).toBe(true);
      expect(isValidColorValue('hsla(0, 100%, 50%, 0.5)')).toBe(true);
    });
  });

  describe('modern color formats', () => {
    it('should validate oklch', () => {
      expect(isValidColorValue('oklch(0.7 0.15 180)')).toBe(true);
    });

    it('should validate oklab', () => {
      expect(isValidColorValue('oklab(0.7 -0.1 0.1)')).toBe(true);
    });

    it('should validate lab', () => {
      expect(isValidColorValue('lab(50% 50 -50)')).toBe(true);
    });

    it('should validate lch', () => {
      expect(isValidColorValue('lch(50% 50 180)')).toBe(true);
    });

    it('should validate hwb', () => {
      expect(isValidColorValue('hwb(180 10% 10%)')).toBe(true);
    });

    it('should validate color()', () => {
      expect(isValidColorValue('color(display-p3 1 0 0)')).toBe(true);
    });
  });

  describe('named colors', () => {
    it('should validate common named colors', () => {
      expect(isValidColorValue('red')).toBe(true);
      expect(isValidColorValue('blue')).toBe(true);
      expect(isValidColorValue('green')).toBe(true);
      expect(isValidColorValue('white')).toBe(true);
      expect(isValidColorValue('black')).toBe(true);
    });

    it('should validate extended named colors', () => {
      expect(isValidColorValue('rebeccapurple')).toBe(true);
      expect(isValidColorValue('cornflowerblue')).toBe(true);
      expect(isValidColorValue('lightgoldenrodyellow')).toBe(true);
    });
  });

  describe('invalid values', () => {
    it('should reject empty and special values', () => {
      expect(isValidColorValue('')).toBe(false);
      expect(isValidColorValue('inherit')).toBe(false);
      expect(isValidColorValue('initial')).toBe(false);
      expect(isValidColorValue('unset')).toBe(false);
      expect(isValidColorValue('transparent')).toBe(false);
      expect(isValidColorValue('currentColor')).toBe(false);
    });

    it('should reject unresolved CSS variables', () => {
      expect(isValidColorValue('var(--color)')).toBe(false);
      expect(isValidColorValue('var(--color, red)')).toBe(false);
    });

    it('should reject invalid input types', () => {
      expect(isValidColorValue(null as unknown as string)).toBe(false);
      expect(isValidColorValue(undefined as unknown as string)).toBe(false);
    });

    it('should reject random strings', () => {
      expect(isValidColorValue('not-a-color')).toBe(false);
      expect(isValidColorValue('123')).toBe(false);
      expect(isValidColorValue('hello world')).toBe(false);
    });
  });
});

describe('real-world scenarios', () => {
  it('should handle ax1.vc-style CSS variables', () => {
    // ax1.vcで使用されているような実際のCSS変数パターン
    const html = `
      <html>
      <head>
        <style>
          :root {
            --color-bg: oklch(0.98 0 0);
            --color-text: oklch(0.2 0 0);
            --color-primary: oklch(0.6 0.2 250);
            --spacing-base: 1rem;
            --spacing-lg: calc(var(--spacing-base) * 2);
          }
        </style>
      </head>
      <body style="background: var(--color-bg); color: var(--color-text);">
        <header style="background-color: var(--color-primary)"></header>
      </body>
      </html>
    `;

    const result = extractAndResolveColors(html);

    // 背景色が正しく解決される
    expect(result.backgroundColors).toContain('oklch(0.98 0 0)');
    expect(result.backgroundColors).toContain('oklch(0.6 0.2 250)');

    // テキスト色が正しく解決される
    expect(result.textColors).toContain('oklch(0.2 0 0)');
  });

  it('should handle Tailwind CSS-style dark mode variables', () => {
    const html = `
      <style>
        :root {
          --background: 0 0% 100%;
          --foreground: 222.2 84% 4.9%;
        }
        .dark {
          --background: 222.2 84% 4.9%;
          --foreground: 210 40% 98%;
        }
      </style>
      <div style="background-color: hsl(var(--background))"></div>
    `;

    const resolver = new CssVariableResolver();
    resolver.extractVariablesFromHtml(html);

    // 変数が抽出される（最後の定義が優先）
    expect(resolver.size).toBeGreaterThan(0);
  });

  it('should handle complex nested variables', () => {
    const html = `
      <style>
        :root {
          --color-blue-500: #3b82f6;
          --color-primary: var(--color-blue-500);
          --button-bg: var(--color-primary);
        }
      </style>
      <button style="background: var(--button-bg)"></button>
    `;

    const result = extractAndResolveColors(html);
    expect(result.backgroundColors).toContain('#3b82f6');
  });

  it('should handle variables with fallbacks in nested contexts', () => {
    const html = `
      <style>
        :root {
          --base-color: navy;
        }
      </style>
      <div style="background: var(--custom-color, var(--base-color))"></div>
    `;

    const result = extractAndResolveColors(html);
    expect(result.backgroundColors).toContain('navy');
  });
});
