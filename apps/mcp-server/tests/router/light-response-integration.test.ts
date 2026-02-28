// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Router Light Response Integration Tests
 *
 * handleToolCall関数でのLight Response統合テスト
 * - applyLightResponseがrouter.ts経由で適用されることを確認
 * - include_html/includeHtml両対応の確認
 * - summary=true/falseの動作確認
 *
 * @module tests/router/light-response-integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleToolCall,
  registerTool,
  clearToolHandlers,
  resetToolMetrics,
} from '../../src/router';

describe('Router Light Response Integration', () => {
  beforeEach(() => {
    clearToolHandlers();
    resetToolMetrics();
  });

  afterEach(() => {
    clearToolHandlers();
    resetToolMetrics();
  });

  describe('summary mode (default)', () => {
    it('should apply light response by default (summary=true)', async () => {
      // Mock tool that returns data with html and screenshot
      registerTool('layout.ingest', async () => ({
        success: true,
        data: {
          id: 'test-id',
          url: 'https://example.com',
          html: '<html>Very long HTML content...</html>',
          screenshot: 'base64EncodedLongString...',
          sections: [{ type: 'hero' }],
        },
      }));

      // Call without summary option (default behavior)
      const result = await handleToolCall('layout.ingest', {
        url: 'https://example.com',
      });

      const data = (result as { data: Record<string, unknown> }).data;

      // html and screenshot should be excluded by default
      expect(data.id).toBe('test-id');
      expect(data.url).toBe('https://example.com');
      expect(data.html).toBeUndefined();
      expect(data.screenshot).toBeUndefined();
      expect(data.sections).toBeDefined();
    });

    it('should return full response when summary=false', async () => {
      registerTool('layout.ingest', async () => ({
        success: true,
        data: {
          id: 'test-id',
          html: '<html>content</html>',
          screenshot: 'base64data',
        },
      }));

      const result = await handleToolCall('layout.ingest', {
        url: 'https://example.com',
        summary: false,
      });

      const data = (result as { data: Record<string, unknown> }).data;

      // Should include html and screenshot when summary=false
      expect(data.html).toBe('<html>content</html>');
      expect(data.screenshot).toBe('base64data');
    });
  });

  describe('include_html / includeHtml compatibility', () => {
    it('should include html when include_html=true (snake_case)', async () => {
      registerTool('layout.ingest', async () => ({
        success: true,
        data: {
          id: 'test-id',
          html: '<html>content</html>',
          screenshot: 'base64data',
        },
      }));

      const result = await handleToolCall('layout.ingest', {
        url: 'https://example.com',
        include_html: true,
      });

      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.html).toBe('<html>content</html>');
      expect(data.screenshot).toBeUndefined(); // Not explicitly requested
    });

    it('should include html when includeHtml=true (camelCase legacy)', async () => {
      registerTool('layout.ingest', async () => ({
        success: true,
        data: {
          id: 'test-id',
          html: '<html>content</html>',
        },
      }));

      const result = await handleToolCall('layout.ingest', {
        url: 'https://example.com',
        includeHtml: true,
      });

      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.html).toBe('<html>content</html>');
    });

    it('should include html when options.include_html=true (nested)', async () => {
      registerTool('layout.ingest', async () => ({
        success: true,
        data: {
          id: 'test-id',
          html: '<html>nested option content</html>',
        },
      }));

      const result = await handleToolCall('layout.ingest', {
        url: 'https://example.com',
        options: {
          include_html: true,
        },
      });

      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.html).toBe('<html>nested option content</html>');
    });
  });

  describe('include_screenshot / includeScreenshot compatibility', () => {
    it('should include screenshot when include_screenshot=true', async () => {
      registerTool('layout.ingest', async () => ({
        success: true,
        data: {
          id: 'test-id',
          html: '<html>content</html>',
          screenshot: 'base64screenshot',
        },
      }));

      const result = await handleToolCall('layout.ingest', {
        url: 'https://example.com',
        include_screenshot: true,
      });

      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.html).toBeUndefined(); // Not requested
      expect(data.screenshot).toBe('base64screenshot');
    });

    it('should include screenshot when includeScreenshot=true (camelCase)', async () => {
      registerTool('layout.ingest', async () => ({
        success: true,
        data: {
          id: 'test-id',
          screenshot: 'base64screenshot',
        },
      }));

      const result = await handleToolCall('layout.ingest', {
        url: 'https://example.com',
        includeScreenshot: true,
      });

      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.screenshot).toBe('base64screenshot');
    });
  });

  describe('verbose mode (motion.detect compatibility)', () => {
    it('should include rawCss when verbose=true', async () => {
      registerTool('motion.detect', async () => ({
        success: true,
        data: {
          patterns: [{ type: 'animation', name: 'fadeIn' }],
          rawCss: '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }',
        },
      }));

      const result = await handleToolCall('motion.detect', {
        html: '<html>content</html>',
        verbose: true,
      });

      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.rawCss).toBeDefined();
    });
  });

  describe('array limits', () => {
    it('should limit arrays in light response mode', async () => {
      registerTool('quality.evaluate', async () => ({
        success: true,
        data: {
          overall: 85,
          recommendations: Array(20).fill({ priority: 'high', title: 'Test' }),
        },
      }));

      const result = await handleToolCall('quality.evaluate', {
        html: '<html>content</html>',
      });

      const data = (result as { data: Record<string, unknown> }).data;

      // Default limit for recommendations is 3
      expect((data.recommendations as unknown[]).length).toBeLessThanOrEqual(3);
    });
  });

  describe('error responses', () => {
    it('should preserve error responses without modification', async () => {
      registerTool('layout.ingest', async () => ({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid URL',
          details: { url: 'not-a-valid-url' },
        },
      }));

      const result = await handleToolCall('layout.ingest', {
        url: 'not-a-valid-url',
      });

      // Error responses should pass through unchanged
      expect((result as { success: boolean }).success).toBe(false);
      expect((result as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
      expect((result as { error: { details: { url: string } } }).error.details.url).toBe('not-a-valid-url');
    });
  });

  describe('page.analyze integration', () => {
    it('should apply light response to page.analyze nested structure', async () => {
      registerTool('page.analyze', async () => ({
        success: true,
        data: {
          layout: {
            webPageId: 'wp-123',
            html: '<html>long content...</html>',
            screenshot: 'base64...',
            sections: Array(20).fill({ type: 'hero', html: '<div>...</div>' }),
          },
          motion: {
            patterns: Array(50).fill({ type: 'animation', rawCss: '...' }),
          },
          quality: {
            overall: 90,
            recommendations: Array(15).fill({ priority: 'high' }),
          },
        },
      }));

      const result = await handleToolCall('page.analyze', {
        url: 'https://example.com',
      });

      const data = (result as { data: Record<string, unknown> }).data;
      const layout = data.layout as Record<string, unknown>;
      const motion = data.motion as Record<string, unknown>;
      const quality = data.quality as Record<string, unknown>;

      // html and screenshot should be excluded from layout
      expect(layout.html).toBeUndefined();
      expect(layout.screenshot).toBeUndefined();

      // Arrays should be limited
      expect((layout.sections as unknown[]).length).toBeLessThanOrEqual(10);
      expect((motion.patterns as unknown[]).length).toBeLessThanOrEqual(20);
      expect((quality.recommendations as unknown[]).length).toBeLessThanOrEqual(5);
    });
  });
});
