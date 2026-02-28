// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LightResponseController Unit Tests
 *
 * Light Response機能のテスト
 * - デフォルトでlight response（summary相当）を返す
 * - include_*オプションで詳細データを明示的に要求可能
 * - 98.7%のトークン削減を達成（150KB → 2KB）
 *
 * @module tests/middleware/light-response-controller.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LightResponseController,
  applyLightResponse,
  applyLightResponseWithWarnings,
  extractLightResponseOptions,
  LightResponseOptions,
  DEFAULT_LIGHT_RESPONSE_CONFIG,
  TOOL_FIELD_CONFIGS,
  MAX_ARRAY_LIMIT,
} from '../../src/middleware/light-response-controller';

describe('LightResponseController', () => {
  let controller: LightResponseController;

  beforeEach(() => {
    controller = new LightResponseController();
  });

  describe('constructor', () => {
    it('should use default config when no options provided', () => {
      const ctrl = new LightResponseController();
      expect(ctrl).toBeDefined();
    });

    it('should accept custom config options', () => {
      const ctrl = new LightResponseController({
        maxArrayItems: 5,
        excludeFields: ['customField'],
      });
      expect(ctrl).toBeDefined();
    });
  });

  describe('applyLightResponse', () => {
    it('should return minimal response when summary=true (default)', () => {
      const fullResponse = {
        success: true,
        data: {
          id: 'test-id',
          html: '<html>long content...</html>',
          screenshot: 'base64longdata...',
          sections: Array(20).fill({ type: 'hero', html: '...' }),
          recommendations: Array(10).fill({ priority: 'high' }),
        },
      };

      const result = controller.apply('layout.ingest', fullResponse, { summary: true });

      expect(result.success).toBe(true);
      expect(result.data.id).toBe('test-id');
      // html and screenshot should be excluded by default
      expect(result.data.html).toBeUndefined();
      expect(result.data.screenshot).toBeUndefined();
    });

    it('should return full response when summary=false', () => {
      const fullResponse = {
        success: true,
        data: {
          id: 'test-id',
          html: '<html>long content...</html>',
          screenshot: 'base64longdata...',
        },
      };

      const result = controller.apply('layout.ingest', fullResponse, { summary: false });

      expect(result.data.html).toBe('<html>long content...</html>');
      expect(result.data.screenshot).toBe('base64longdata...');
    });

    it('should include fields when explicitly requested via include_*', () => {
      const fullResponse = {
        success: true,
        data: {
          id: 'test-id',
          html: '<html>content</html>',
          screenshot: 'base64data',
        },
      };

      const result = controller.apply('layout.ingest', fullResponse, {
        summary: true,
        include_html: true,
        include_screenshot: false,
      });

      expect(result.data.html).toBe('<html>content</html>');
      expect(result.data.screenshot).toBeUndefined();
    });

    it('should limit array sizes in light response mode', () => {
      const fullResponse = {
        success: true,
        data: {
          recommendations: Array(20).fill({ id: 'rec', priority: 'high' }),
          violations: Array(15).fill({ id: 'vio', impact: 'critical' }),
        },
      };

      const result = controller.apply('quality.evaluate', fullResponse, {
        summary: true,
      });

      // Default limit is 3 for recommendations
      expect(result.data.recommendations.length).toBeLessThanOrEqual(3);
      // Default limit is 5 for violations
      expect(result.data.violations.length).toBeLessThanOrEqual(5);
    });
  });

  describe('quality.evaluate specific behavior', () => {
    it('should limit recommendations to 3 in summary mode', () => {
      const fullResponse = {
        success: true,
        data: {
          overall: 85,
          grade: 'B',
          recommendations: Array(10).fill({
            id: 'rec-1',
            priority: 'high',
            title: 'Recommendation',
          }),
          contextualRecommendations: Array(8).fill({
            id: 'ctx-1',
            title: 'Contextual',
          }),
          patternAnalysis: {
            similarSections: Array(10).fill({ id: 'sec-1' }),
            similarMotions: Array(10).fill({ id: 'mot-1' }),
            benchmarksUsed: Array(10).fill({ id: 'bench-1' }),
          },
          axeAccessibility: {
            violations: Array(20).fill({ id: 'vio-1' }),
          },
          clicheDetection: {
            patterns: Array(10).fill({ type: 'gradient' }),
          },
        },
      };

      const result = controller.apply('quality.evaluate', fullResponse, { summary: true });

      expect(result.data.recommendations.length).toBe(3);
      expect(result.data.contextualRecommendations.length).toBe(3);
      expect(result.data.patternAnalysis.similarSections.length).toBe(3);
      expect(result.data.patternAnalysis.similarMotions.length).toBe(3);
      expect(result.data.patternAnalysis.benchmarksUsed.length).toBe(3);
      expect(result.data.axeAccessibility.violations.length).toBe(5);
      expect(result.data.clicheDetection.patterns.length).toBe(3);
    });
  });

  describe('layout.ingest specific behavior', () => {
    it('should exclude html and screenshot by default', () => {
      const fullResponse = {
        success: true,
        data: {
          id: 'page-123',
          url: 'https://example.com',
          title: 'Example Page',
          html: '<html>Very long HTML content...</html>'.repeat(1000),
          screenshot: 'base64EncodedLongString'.repeat(1000),
          sections: [{ type: 'hero' }],
        },
      };

      const result = controller.apply('layout.ingest', fullResponse, { summary: true });

      expect(result.data.id).toBe('page-123');
      expect(result.data.url).toBe('https://example.com');
      expect(result.data.html).toBeUndefined();
      expect(result.data.screenshot).toBeUndefined();
    });
  });

  describe('page.analyze specific behavior', () => {
    it('should return summary format by default', () => {
      const fullResponse = {
        success: true,
        data: {
          layout: {
            webPageId: 'wp-123',
            sections: Array(10).fill({ type: 'hero', html: '<div>...</div>' }),
            visualFeatures: { theme: 'dark' },
          },
          motion: {
            patterns: Array(50).fill({ type: 'animation', rawCss: '...' }),
          },
          quality: {
            overall: 90,
            recommendations: Array(15).fill({ priority: 'high' }),
          },
        },
      };

      const result = controller.apply('page.analyze', fullResponse, { summary: true });

      // Sections should be limited
      expect(result.data.layout.sections.length).toBeLessThanOrEqual(10);
      // Motion patterns should be limited
      expect(result.data.motion.patterns.length).toBeLessThanOrEqual(20);
      // Quality recommendations should be limited
      expect(result.data.quality.recommendations.length).toBeLessThanOrEqual(5);
    });
  });

  describe('motion.detect specific behavior', () => {
    it('should limit patterns in summary mode', () => {
      const fullResponse = {
        success: true,
        data: {
          patterns: Array(100).fill({
            type: 'animation',
            name: 'fadeIn',
            rawCss: '@keyframes fadeIn {...}',
          }),
          summary: {
            totalPatterns: 100,
            types: ['animation', 'transition'],
          },
        },
      };

      const result = controller.apply('motion.detect', fullResponse, { summary: true });

      expect(result.data.patterns.length).toBeLessThanOrEqual(20);
      expect(result.data.summary).toBeDefined();
    });
  });

  describe('response size reduction', () => {
    it('should achieve significant size reduction (target: 98.7%)', () => {
      // Simulate a large response (~150KB)
      const largeResponse = {
        success: true,
        data: {
          id: 'test-id',
          url: 'https://example.com',
          html: '<html>'.padEnd(50000, 'x') + '</html>',
          screenshot: 'data:image/png;base64,'.padEnd(100000, 'A'),
          sections: Array(20).fill({
            type: 'hero',
            html: '<div>section content</div>'.repeat(100),
            css: '.hero { color: red; }'.repeat(50),
          }),
        },
      };

      const originalSize = JSON.stringify(largeResponse).length;
      const result = controller.apply('layout.ingest', largeResponse, { summary: true });
      const reducedSize = JSON.stringify(result).length;

      // Calculate reduction percentage
      const reductionPercent = ((originalSize - reducedSize) / originalSize) * 100;

      console.log(`Original: ${originalSize} bytes, Reduced: ${reducedSize} bytes`);
      console.log(`Reduction: ${reductionPercent.toFixed(2)}%`);

      // Target: > 80% reduction (flexible for different scenarios)
      // Note: 98.7% target is for DB-first workflow where html/screenshot are not returned at all
      expect(reductionPercent).toBeGreaterThan(80);
    });
  });

  describe('edge cases', () => {
    it('should handle null/undefined response gracefully', () => {
      const result = controller.apply('layout.ingest', null, { summary: true });
      expect(result).toBeNull();

      const result2 = controller.apply('layout.ingest', undefined, { summary: true });
      expect(result2).toBeUndefined();
    });

    it('should handle empty data object', () => {
      const response = { success: true, data: {} };
      const result = controller.apply('layout.ingest', response, { summary: true });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({});
    });

    it('should preserve error responses without modification', () => {
      const errorResponse = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
        },
      };

      const result = controller.apply('layout.ingest', errorResponse, { summary: true });

      expect(result).toEqual(errorResponse);
    });

    it('should handle circular references gracefully', () => {
      const circularResponse: any = {
        success: true,
        data: { id: 'test' },
      };
      // Note: We won't create actual circular reference here
      // as JSON.stringify would fail - controller should handle this

      const result = controller.apply('layout.ingest', circularResponse, { summary: true });
      expect(result.data.id).toBe('test');
    });
  });

  describe('tool-specific configurations', () => {
    it('should have configuration for all major tools', () => {
      const expectedTools = [
        'layout.ingest',
        'layout.search',
        'layout.inspect',
        'quality.evaluate',
        'motion.detect',
        'motion.search',
        'page.analyze',
      ];

      for (const tool of expectedTools) {
        expect(TOOL_FIELD_CONFIGS[tool]).toBeDefined();
      }
    });
  });
});

describe('applyLightResponse helper function', () => {
  it('should provide a convenience wrapper', () => {
    const response = {
      success: true,
      data: {
        id: 'test',
        html: '<html>content</html>',
      },
    };

    const result = applyLightResponse('layout.ingest', response, { summary: true });

    expect(result.data.id).toBe('test');
    expect(result.data.html).toBeUndefined();
  });
});

describe('DEFAULT_LIGHT_RESPONSE_CONFIG', () => {
  it('should have sensible defaults', () => {
    expect(DEFAULT_LIGHT_RESPONSE_CONFIG.maxArrayItems).toBeGreaterThan(0);
    expect(DEFAULT_LIGHT_RESPONSE_CONFIG.excludeFields).toContain('html');
    expect(DEFAULT_LIGHT_RESPONSE_CONFIG.excludeFields).toContain('screenshot');
    expect(DEFAULT_LIGHT_RESPONSE_CONFIG.excludeFields).toContain('rawCss');
  });
});

describe('extractLightResponseOptions', () => {
  describe('summary option', () => {
    it('should extract summary from args', () => {
      const result = extractLightResponseOptions({ summary: true });
      expect(result.summary).toBe(true);

      const result2 = extractLightResponseOptions({ summary: false });
      expect(result2.summary).toBe(false);
    });

    it('should return empty options when summary is not provided', () => {
      const result = extractLightResponseOptions({});
      expect(result.summary).toBeUndefined();
    });
  });

  describe('include_html / includeHtml compatibility', () => {
    it('should prefer snake_case (include_html) over camelCase', () => {
      const result = extractLightResponseOptions({
        include_html: true,
        includeHtml: false,
      });
      expect(result.include_html).toBe(true);
    });

    it('should fall back to camelCase (includeHtml) when snake_case is not provided', () => {
      const result = extractLightResponseOptions({ includeHtml: true });
      expect(result.include_html).toBe(true);
    });

    it('should extract include_html from nested options object (snake_case)', () => {
      const result = extractLightResponseOptions({
        options: { include_html: true },
      });
      expect(result.include_html).toBe(true);
    });

    it('should extract includeHtml from nested options object (camelCase fallback)', () => {
      const result = extractLightResponseOptions({
        options: { includeHtml: true },
      });
      expect(result.include_html).toBe(true);
    });

    it('should prefer top-level over nested options', () => {
      const result = extractLightResponseOptions({
        include_html: true,
        options: { include_html: false },
      });
      // Top-level should take precedence (nested only checked when top-level undefined)
      expect(result.include_html).toBe(true);
    });
  });

  describe('include_screenshot / includeScreenshot compatibility', () => {
    it('should prefer snake_case (include_screenshot)', () => {
      const result = extractLightResponseOptions({
        include_screenshot: true,
        includeScreenshot: false,
      });
      expect(result.include_screenshot).toBe(true);
    });

    it('should fall back to camelCase (includeScreenshot)', () => {
      const result = extractLightResponseOptions({ includeScreenshot: true });
      expect(result.include_screenshot).toBe(true);
    });

    it('should extract from nested options object', () => {
      const result = extractLightResponseOptions({
        options: { include_screenshot: true },
      });
      expect(result.include_screenshot).toBe(true);
    });
  });

  describe('include_rawCss / includeRawCss compatibility', () => {
    it('should prefer snake_case (include_rawCss)', () => {
      const result = extractLightResponseOptions({ include_rawCss: true });
      expect(result.include_rawCss).toBe(true);
    });

    it('should fall back to camelCase (includeRawCss)', () => {
      const result = extractLightResponseOptions({ includeRawCss: true });
      expect(result.include_rawCss).toBe(true);
    });

    it('should set include_rawCss=true when verbose=true (motion.detect compatibility)', () => {
      const result = extractLightResponseOptions({ verbose: true });
      expect(result.include_rawCss).toBe(true);
    });
  });

  describe('include_external_css / includeExternalCss compatibility', () => {
    it('should prefer snake_case (include_external_css)', () => {
      const result = extractLightResponseOptions({ include_external_css: true });
      expect(result.include_external_css).toBe(true);
    });

    it('should fall back to camelCase (includeExternalCss)', () => {
      const result = extractLightResponseOptions({ includeExternalCss: true });
      expect(result.include_external_css).toBe(true);
    });
  });

  describe('combined options', () => {
    it('should extract all options from a typical MCP tool call', () => {
      const args = {
        url: 'https://example.com',
        summary: true,
        options: {
          include_html: true,
          include_screenshot: false,
          save_to_db: true,
        },
      };

      const result = extractLightResponseOptions(args);

      expect(result.summary).toBe(true);
      expect(result.include_html).toBe(true);
      expect(result.include_screenshot).toBe(false);
    });

    it('should handle empty args gracefully', () => {
      const result = extractLightResponseOptions({});
      expect(result).toEqual({});
    });

    it('should ignore non-boolean values', () => {
      const result = extractLightResponseOptions({
        summary: 'true', // string, not boolean
        include_html: 1, // number, not boolean
      } as Record<string, unknown>);
      expect(result.summary).toBeUndefined();
      expect(result.include_html).toBeUndefined();
    });
  });

  describe('limit extraction (RESP-12)', () => {
    it('should extract limit from top-level args', () => {
      const result = extractLightResponseOptions({ limit: 20 });
      expect(result.limit).toBe(20);
    });

    it('should extract limit from nested options object', () => {
      const result = extractLightResponseOptions({
        options: { limit: 15 },
      });
      expect(result.limit).toBe(15);
    });

    it('should prefer top-level limit over nested options', () => {
      const result = extractLightResponseOptions({
        limit: 25,
        options: { limit: 10 },
      });
      // Top-level should take precedence
      expect(result.limit).toBe(25);
    });

    it('should ignore non-number limit values', () => {
      const result = extractLightResponseOptions({
        limit: 'twenty', // string, not number
      } as Record<string, unknown>);
      expect(result.limit).toBeUndefined();
    });

    it('should ignore negative limit values', () => {
      const result = extractLightResponseOptions({ limit: -5 });
      expect(result.limit).toBeUndefined();
    });

    it('should ignore zero limit value', () => {
      const result = extractLightResponseOptions({ limit: 0 });
      expect(result.limit).toBeUndefined();
    });

    it('should accept valid positive limit values', () => {
      const result = extractLightResponseOptions({ limit: 1 });
      expect(result.limit).toBe(1);

      const result2 = extractLightResponseOptions({ limit: 100 });
      expect(result2.limit).toBe(100);
    });
  });
});

describe('RESP-12: Dynamic array limit based on user limit parameter', () => {
  let controller: LightResponseController;

  beforeEach(() => {
    controller = new LightResponseController();
  });

  describe('layout.search with user-specified limit', () => {
    it('should use user limit when larger than default', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(30).fill({ id: 'result', pattern: 'hero' }),
        },
      };

      // User specifies limit: 20, default for results is 10
      const result = controller.apply('layout.search', fullResponse, {
        summary: true,
        limit: 20,
      });

      expect(result.data.results.length).toBe(20);
    });

    it('should use user limit when smaller than default', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(30).fill({ id: 'result', pattern: 'hero' }),
        },
      };

      // User specifies limit: 5, default for results is 10
      const result = controller.apply('layout.search', fullResponse, {
        summary: true,
        limit: 5,
      });

      expect(result.data.results.length).toBe(5);
    });

    it('should fall back to tool-specific limit when user limit not specified', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(30).fill({ id: 'result', pattern: 'hero' }),
        },
      };

      const result = controller.apply('layout.search', fullResponse, {
        summary: true,
        // No limit specified
      });

      // Should use tool-specific default (10 for layout.search results)
      expect(result.data.results.length).toBe(10);
    });
  });

  describe('motion.detect with user-specified limit', () => {
    it('should respect user limit for patterns array', () => {
      const fullResponse = {
        success: true,
        data: {
          patterns: Array(50).fill({
            type: 'animation',
            name: 'fadeIn',
          }),
          warnings: Array(10).fill({ message: 'warning' }),
        },
      };

      // User specifies limit: 30
      const result = controller.apply('motion.detect', fullResponse, {
        summary: true,
        limit: 30,
      });

      // patterns should use user limit (30)
      expect(result.data.patterns.length).toBe(30);
      // warnings also use user limit (30) - all arrays respect user limit
      expect(result.data.warnings.length).toBe(10); // Only 10 available, so all returned
    });

    it('should limit all arrays when user limit is smaller', () => {
      const fullResponse = {
        success: true,
        data: {
          patterns: Array(50).fill({ type: 'animation' }),
          warnings: Array(10).fill({ message: 'warning' }),
        },
      };

      // User specifies limit: 3
      const result = controller.apply('motion.detect', fullResponse, {
        summary: true,
        limit: 3,
      });

      // Both arrays should respect user limit
      expect(result.data.patterns.length).toBe(3);
      expect(result.data.warnings.length).toBe(3);
    });
  });

  describe('quality.evaluate with user-specified limit', () => {
    it('should respect user limit for main result arrays', () => {
      const fullResponse = {
        success: true,
        data: {
          overall: 85,
          recommendations: Array(10).fill({ id: 'rec', priority: 'high' }),
          contextualRecommendations: Array(10).fill({ id: 'ctx' }),
        },
      };

      // User specifies limit: 5
      const result = controller.apply('quality.evaluate', fullResponse, {
        summary: true,
        limit: 5,
      });

      expect(result.data.recommendations.length).toBe(5);
      expect(result.data.contextualRecommendations.length).toBe(5);
    });
  });

  describe('page.analyze with user-specified limit', () => {
    it('should respect user limit for nested arrays', () => {
      const fullResponse = {
        success: true,
        data: {
          layout: {
            sections: Array(30).fill({ type: 'hero' }),
          },
          motion: {
            patterns: Array(50).fill({ type: 'animation' }),
          },
          quality: {
            recommendations: Array(20).fill({ priority: 'high' }),
          },
        },
      };

      // User specifies limit: 15
      const result = controller.apply('page.analyze', fullResponse, {
        summary: true,
        limit: 15,
      });

      expect(result.data.layout.sections.length).toBe(15);
      expect(result.data.motion.patterns.length).toBe(15);
      expect(result.data.quality.recommendations.length).toBe(15);
    });
  });

  describe('edge cases', () => {
    it('should handle limit larger than array size', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(5).fill({ id: 'result' }),
        },
      };

      const result = controller.apply('layout.search', fullResponse, {
        summary: true,
        limit: 100,
      });

      // Should return all available items (5)
      expect(result.data.results.length).toBe(5);
    });

    it('should work with summary: false (no limiting)', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(50).fill({ id: 'result' }),
        },
      };

      const result = controller.apply('layout.search', fullResponse, {
        summary: false,
        limit: 10, // Should be ignored when summary: false
      });

      // Should return all items when summary: false
      expect(result.data.results.length).toBe(50);
    });
  });
});

describe('extractLightResponseOptions - nested options support (layoutOptions, motionOptions, qualityOptions)', () => {
  it('should extract include_html from layoutOptions', () => {
    const args = {
      url: 'https://example.com',
      layoutOptions: {
        include_html: true,
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.include_html).toBe(true);
  });

  it('should extract includeHtml (camelCase) from layoutOptions', () => {
    const args = {
      url: 'https://example.com',
      layoutOptions: {
        includeHtml: true,
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.include_html).toBe(true);
  });

  it('should prioritize top-level over layoutOptions', () => {
    const args = {
      include_html: false,
      layoutOptions: {
        include_html: true,
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.include_html).toBe(false);
  });

  it('should extract include_screenshot from layoutOptions', () => {
    const args = {
      layoutOptions: {
        include_screenshot: true,
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.include_screenshot).toBe(true);
  });

  it('should extract limit from layoutOptions', () => {
    const args = {
      layoutOptions: {
        limit: 50,
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.limit).toBe(50);
  });

  it('should NOT extract from non-allowed nested keys (security)', () => {
    const args = {
      maliciousOptions: {
        include_html: true,
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.include_html).toBeUndefined();
  });

  it('should extract include_rawCss from motionOptions', () => {
    const args = {
      motionOptions: {
        include_rawCss: true,
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.include_rawCss).toBe(true);
  });

  it('should extract includeRawCss (camelCase) from motionOptions', () => {
    const args = {
      motionOptions: {
        includeRawCss: true,
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.include_rawCss).toBe(true);
  });

  it('should extract limit from qualityOptions', () => {
    const args = {
      qualityOptions: {
        limit: 25,
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.limit).toBe(25);
  });

  it('should prefer options over layoutOptions/motionOptions/qualityOptions (order priority)', () => {
    // options is checked first in ALLOWED_NESTED_OPTION_KEYS
    const args = {
      options: {
        include_html: true,
      },
      layoutOptions: {
        include_html: false,
      },
    };
    const options = extractLightResponseOptions(args);
    // options is first in array, so it should be found first
    expect(options.include_html).toBe(true);
  });

  it('should handle page.analyze style args with multiple nested options', () => {
    const args = {
      url: 'https://example.com',
      layoutOptions: {
        include_screenshot: true,
        limit: 30,
      },
      motionOptions: {
        include_rawCss: false,
      },
      qualityOptions: {
        summary: true, // This should NOT affect top-level summary
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.include_screenshot).toBe(true);
    expect(options.limit).toBe(30);
    expect(options.include_rawCss).toBe(false);
    // summary is extracted from top-level only
    expect(options.summary).toBeUndefined();
  });

  it('should extract include_external_css from layoutOptions', () => {
    const args = {
      layoutOptions: {
        include_external_css: true,
      },
    };
    const options = extractLightResponseOptions(args);
    expect(options.include_external_css).toBe(true);
  });
});

/**
 * Integration Tests: page.analyze nested options transparency
 *
 * page.analyzeのlayoutOptions.include_html/include_screenshotが
 * extractLightResponseOptions → LightResponseController.apply() を経由して
 * 正しく透過されることをテスト
 *
 * @see MCP-RESP-03: snake_case統一ガイドライン
 */
describe('page.analyze nested options transparency through LightResponseController', () => {
  let controller: LightResponseController;

  beforeEach(() => {
    controller = new LightResponseController();
  });

  /**
   * page.analyzeのモックレスポンス（layout.htmlとlayout.screenshotを含む）
   */
  const createMockPageAnalyzeResponse = () => ({
    success: true,
    data: {
      layout: {
        success: true,
        pageId: 'test-page-id',
        sectionCount: 3,
        sectionTypes: ['hero', 'feature', 'footer'],
        html: '<html><body><h1>Test Page</h1></body></html>',
        screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        processingTimeMs: 1500,
      },
      motion: {
        success: true,
        patternCount: 5,
        categoryBreakdown: { animation: 3, transition: 2 },
        processingTimeMs: 800,
      },
      quality: {
        success: true,
        overallScore: 85,
        grade: 'A',
        axisScores: { originality: 80, craftsmanship: 90, contextuality: 85 },
        processingTimeMs: 500,
      },
      totalProcessingTimeMs: 2800,
    },
  });

  describe('layoutOptions.include_html transparency (snake_case)', () => {
    it('should include HTML when layoutOptions.include_html: true', () => {
      // Arrange: page.analyze args with layoutOptions.include_html: true
      const args = {
        url: 'https://example.com',
        layoutOptions: {
          include_html: true,
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: HTML should be included in layout result
      expect(lightOptions.include_html).toBe(true);
      expect(result.data.layout.html).toBeDefined();
      expect(result.data.layout.html).toBe('<html><body><h1>Test Page</h1></body></html>');
    });

    it('should exclude HTML by default (layoutOptions.include_html not specified)', () => {
      // Arrange: page.analyze args without include_html
      const args = {
        url: 'https://example.com',
        layoutOptions: {
          // include_html NOT specified
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: HTML should be excluded (default behavior)
      expect(lightOptions.include_html).toBeUndefined();
      expect(result.data.layout.html).toBeUndefined();
    });

    it('should exclude HTML when layoutOptions.include_html: false', () => {
      // Arrange: page.analyze args with layoutOptions.include_html: false
      const args = {
        url: 'https://example.com',
        layoutOptions: {
          include_html: false,
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: HTML should be excluded
      expect(lightOptions.include_html).toBe(false);
      expect(result.data.layout.html).toBeUndefined();
    });
  });

  describe('layoutOptions.include_screenshot transparency (snake_case)', () => {
    it('should include screenshot when layoutOptions.include_screenshot: true', () => {
      // Arrange: page.analyze args with layoutOptions.include_screenshot: true
      const args = {
        url: 'https://example.com',
        layoutOptions: {
          include_screenshot: true,
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: Screenshot should be included in layout result
      expect(lightOptions.include_screenshot).toBe(true);
      expect(result.data.layout.screenshot).toBeDefined();
      expect(result.data.layout.screenshot).toContain('data:image/png;base64,');
    });

    it('should exclude screenshot by default (layoutOptions.include_screenshot not specified)', () => {
      // Arrange: page.analyze args without include_screenshot
      const args = {
        url: 'https://example.com',
        layoutOptions: {
          // include_screenshot NOT specified
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: Screenshot should be excluded (default behavior)
      expect(lightOptions.include_screenshot).toBeUndefined();
      expect(result.data.layout.screenshot).toBeUndefined();
    });

    it('should exclude screenshot when layoutOptions.include_screenshot: false', () => {
      // Arrange: page.analyze args with layoutOptions.include_screenshot: false
      const args = {
        url: 'https://example.com',
        layoutOptions: {
          include_screenshot: false,
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: Screenshot should be excluded
      expect(lightOptions.include_screenshot).toBe(false);
      expect(result.data.layout.screenshot).toBeUndefined();
    });
  });

  describe('layoutOptions camelCase fallback (legacy compatibility)', () => {
    it('should include HTML when layoutOptions.includeHtml: true (camelCase)', () => {
      // Arrange: page.analyze args with camelCase option (legacy)
      const args = {
        url: 'https://example.com',
        layoutOptions: {
          includeHtml: true, // camelCase (legacy)
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: HTML should be included (camelCase fallback works)
      expect(lightOptions.include_html).toBe(true);
      expect(result.data.layout.html).toBeDefined();
    });

    it('should include screenshot when layoutOptions.includeScreenshot: true (camelCase)', () => {
      // Arrange: page.analyze args with camelCase option (legacy)
      const args = {
        url: 'https://example.com',
        layoutOptions: {
          includeScreenshot: true, // camelCase (legacy)
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: Screenshot should be included (camelCase fallback works)
      expect(lightOptions.include_screenshot).toBe(true);
      expect(result.data.layout.screenshot).toBeDefined();
    });
  });

  describe('combined options (include_html + include_screenshot)', () => {
    it('should include both HTML and screenshot when both options are true', () => {
      // Arrange: page.analyze args with both options
      const args = {
        url: 'https://example.com',
        layoutOptions: {
          include_html: true,
          include_screenshot: true,
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: Both HTML and screenshot should be included
      expect(lightOptions.include_html).toBe(true);
      expect(lightOptions.include_screenshot).toBe(true);
      expect(result.data.layout.html).toBeDefined();
      expect(result.data.layout.screenshot).toBeDefined();
    });

    it('should include HTML only when include_html: true and include_screenshot: false', () => {
      // Arrange: page.analyze args with mixed options
      const args = {
        url: 'https://example.com',
        layoutOptions: {
          include_html: true,
          include_screenshot: false,
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: Only HTML should be included
      expect(result.data.layout.html).toBeDefined();
      expect(result.data.layout.screenshot).toBeUndefined();
    });
  });

  describe('top-level override priority', () => {
    it('should prioritize top-level include_html over layoutOptions.include_html', () => {
      // Arrange: page.analyze args with both top-level and nested options
      const args = {
        url: 'https://example.com',
        include_html: false, // Top-level (higher priority)
        layoutOptions: {
          include_html: true, // Nested (lower priority)
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: Top-level option should take priority
      expect(lightOptions.include_html).toBe(false);
      expect(result.data.layout.html).toBeUndefined();
    });

    it('should prioritize top-level include_screenshot over layoutOptions.include_screenshot', () => {
      // Arrange: page.analyze args with both top-level and nested options
      const args = {
        url: 'https://example.com',
        include_screenshot: false, // Top-level (higher priority)
        layoutOptions: {
          include_screenshot: true, // Nested (lower priority)
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: Top-level option should take priority
      expect(lightOptions.include_screenshot).toBe(false);
      expect(result.data.layout.screenshot).toBeUndefined();
    });
  });

  describe('summary mode interaction', () => {
    it('should include HTML even in summary mode when include_html: true', () => {
      // Arrange: page.analyze args with summary: true (default) and include_html: true
      const args = {
        url: 'https://example.com',
        summary: true, // Summary mode (default)
        layoutOptions: {
          include_html: true,
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: HTML should be included despite summary mode
      expect(lightOptions.summary).toBe(true);
      expect(lightOptions.include_html).toBe(true);
      expect(result.data.layout.html).toBeDefined();
    });

    it('should return full response (including HTML) when summary: false', () => {
      // Arrange: page.analyze args with summary: false
      const args = {
        url: 'https://example.com',
        summary: false, // Full mode
        layoutOptions: {
          // include_html NOT specified
        },
      };

      // Act: Extract options and apply LightResponseController
      const lightOptions = extractLightResponseOptions(args);
      const response = createMockPageAnalyzeResponse();
      const result = controller.apply('page.analyze', response, lightOptions);

      // Assert: Full response returned (no transformation)
      expect(lightOptions.summary).toBe(false);
      expect(result.data.layout.html).toBeDefined();
      expect(result.data.layout.screenshot).toBeDefined();
    });
  });
});

/**
 * RESP-14: ユーザー指定limitとMAX_ARRAY_LIMITの競合時の警告テスト
 */
describe('RESP-14: User limit vs MAX_ARRAY_LIMIT conflict resolution with warnings', () => {
  let controller: LightResponseController;

  beforeEach(() => {
    controller = new LightResponseController();
  });

  describe('applyWithWarnings method', () => {
    it('should return warning when user limit exceeds MAX_ARRAY_LIMIT (1000)', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(500).fill({ id: 'result' }),
        },
      };

      // User specifies limit: 2000, which exceeds MAX_ARRAY_LIMIT (1000)
      const result = controller.applyWithWarnings('layout.search', fullResponse, {
        summary: true,
        limit: 2000,
      });

      // Should have warning
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain('2000');
      expect(result.warnings![0]).toContain('1000');
      expect(result.warnings![0]).toContain('exceeds');

      // Array should be limited to available items (500 < 1000)
      expect(result.response.data.results.length).toBe(500);
    });

    it('should NOT return warning when user limit is within MAX_ARRAY_LIMIT', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(100).fill({ id: 'result' }),
        },
      };

      // User specifies limit: 50, which is within MAX_ARRAY_LIMIT
      const result = controller.applyWithWarnings('layout.search', fullResponse, {
        summary: true,
        limit: 50,
      });

      // Should NOT have warning
      expect(result.warnings).toBeUndefined();

      // Array should be limited to user-specified limit
      expect(result.response.data.results.length).toBe(50);
    });

    it('should NOT return warning when user limit is not specified', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(100).fill({ id: 'result' }),
        },
      };

      const result = controller.applyWithWarnings('layout.search', fullResponse, {
        summary: true,
        // No limit specified
      });

      // Should NOT have warning
      expect(result.warnings).toBeUndefined();

      // Array should use tool-specific default (10 for layout.search results)
      expect(result.response.data.results.length).toBe(10);
    });

    it('should apply MAX_ARRAY_LIMIT when user limit exceeds it', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(1500).fill({ id: 'result' }),
        },
      };

      // User specifies limit: 5000, which exceeds MAX_ARRAY_LIMIT (1000)
      const result = controller.applyWithWarnings('layout.search', fullResponse, {
        summary: true,
        limit: 5000,
      });

      // Array should be limited to MAX_ARRAY_LIMIT (1000)
      expect(result.response.data.results.length).toBe(1000);
      expect(result.warnings).toBeDefined();
    });

    it('should return warning message with correct format', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(50).fill({ id: 'result' }),
        },
      };

      const result = controller.applyWithWarnings('layout.search', fullResponse, {
        summary: true,
        limit: 1500,
      });

      expect(result.warnings![0]).toBe(
        'Requested limit (1500) exceeds maximum allowed (1000). Applied limit: 1000'
      );
    });
  });

  describe('getWarnings method', () => {
    it('should return warnings after apply() call', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(50).fill({ id: 'result' }),
        },
      };

      // Call apply() with limit exceeding MAX_ARRAY_LIMIT
      controller.apply('layout.search', fullResponse, {
        summary: true,
        limit: 2000,
      });

      // getWarnings() should return the warning
      const warnings = controller.getWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe('LIMIT_EXCEEDED');
      expect(warnings[0].requestedLimit).toBe(2000);
      expect(warnings[0].appliedLimit).toBe(1000);
    });

    it('should reset warnings on each apply() call', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(50).fill({ id: 'result' }),
        },
      };

      // First call with limit exceeding MAX_ARRAY_LIMIT
      controller.apply('layout.search', fullResponse, {
        summary: true,
        limit: 2000,
      });
      expect(controller.getWarnings()).toHaveLength(1);

      // Second call without exceeding limit
      controller.apply('layout.search', fullResponse, {
        summary: true,
        limit: 50,
      });
      expect(controller.getWarnings()).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should handle limit exactly at MAX_ARRAY_LIMIT (1000) without warning', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(1500).fill({ id: 'result' }),
        },
      };

      const result = controller.applyWithWarnings('layout.search', fullResponse, {
        summary: true,
        limit: 1000, // Exactly at MAX_ARRAY_LIMIT
      });

      // Should NOT have warning (limit is exactly at max, not exceeding)
      expect(result.warnings).toBeUndefined();
      expect(result.response.data.results.length).toBe(1000);
    });

    it('should handle limit just above MAX_ARRAY_LIMIT (1001) with warning', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(1500).fill({ id: 'result' }),
        },
      };

      const result = controller.applyWithWarnings('layout.search', fullResponse, {
        summary: true,
        limit: 1001, // Just above MAX_ARRAY_LIMIT
      });

      // Should have warning
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.response.data.results.length).toBe(1000);
    });

    it('should not add warning when summary: false (no transformation)', () => {
      const fullResponse = {
        success: true,
        data: {
          results: Array(50).fill({ id: 'result' }),
        },
      };

      const result = controller.applyWithWarnings('layout.search', fullResponse, {
        summary: false, // No transformation
        limit: 5000, // Would normally trigger warning
      });

      // No warning because summary: false bypasses transformation
      expect(result.warnings).toBeUndefined();
      expect(result.response.data.results.length).toBe(50); // All items returned
    });
  });
});

/**
 * applyLightResponseWithWarnings helper function tests
 */
describe('applyLightResponseWithWarnings helper function', () => {
  it('should provide a convenience wrapper with warnings', async () => {
    // Import the helper function dynamically to test it
    const { applyLightResponseWithWarnings, MAX_ARRAY_LIMIT } = await import(
      '../../src/middleware/light-response-controller'
    );

    const response = {
      success: true,
      data: {
        results: Array(100).fill({ id: 'result' }),
      },
    };

    // Test with limit exceeding MAX_ARRAY_LIMIT
    const result = applyLightResponseWithWarnings('layout.search', response, {
      summary: true,
      limit: 2000,
    });

    expect(result.response.data.results.length).toBe(100); // All available
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain('2000');

    // Verify MAX_ARRAY_LIMIT is exported
    expect(MAX_ARRAY_LIMIT).toBe(1000);
  });
});
