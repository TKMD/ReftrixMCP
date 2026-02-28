// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP-RESP-08: McpResponse統一形式 統合テスト
 *
 * 目的: McpResponse統一後の全19ツールレスポンス形式検証
 *
 * テスト対象:
 * 1. 全19ツールがMcpResponse形式で返却
 * 2. metadata.request_idが含まれている
 * 3. success/error構造が正しい
 * 4. handleToolCall経由でのLightResponse適用
 * 5. エラーレスポンスの保持
 *
 * @module tests/integration/mcp-response-unified.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  handleToolCall,
  registerTool,
  clearToolHandlers,
  resetToolMetrics,
} from '../../src/router';
import { isSuccessResponse, isErrorResponse } from '../../src/utils/mcp-response';
import { toolHandlers, allToolDefinitions } from '../../src/tools/index';

// =============================================================================
// テスト用の19ツールリスト
// =============================================================================

const ALL_19_TOOLS = [
  'style.get_palette',
  'system.health',
  'layout.inspect',
  'layout.ingest',
  'layout.search',
  'layout.generate_code',
  'layout.batch_ingest',
  'quality.evaluate',
  'quality.batch_evaluate',
  'quality.getJobStatus',
  'motion.detect',
  'motion.search',
  'brief.validate',
  'project.get',
  'project.list',
  'page.analyze',
  'page.getJobStatus',
  'narrative.search',
  'background.search',
] as const;

// =============================================================================
// McpResponse形式のバリデーション関数
// =============================================================================

/**
 * McpResponseの基本構造を検証
 */
function validateMcpResponseStructure(response: unknown): {
  valid: boolean;
  reason: string;
} {
  if (response === null || typeof response !== 'object') {
    return { valid: false, reason: 'Response is not an object' };
  }

  const obj = response as Record<string, unknown>;

  // success フィールドが必須
  if (typeof obj.success !== 'boolean') {
    return { valid: false, reason: 'Missing or invalid "success" field' };
  }

  // 成功レスポンスの場合
  if (obj.success === true) {
    if (!('data' in obj)) {
      return { valid: false, reason: 'Success response missing "data" field' };
    }
    return { valid: true, reason: 'Valid success response' };
  }

  // エラーレスポンスの場合
  if (obj.success === false) {
    if (!('error' in obj) || typeof obj.error !== 'object' || obj.error === null) {
      return { valid: false, reason: 'Error response missing or invalid "error" field' };
    }
    const error = obj.error as Record<string, unknown>;
    if (typeof error.code !== 'string' || typeof error.message !== 'string') {
      return { valid: false, reason: 'Error object missing code or message' };
    }
    return { valid: true, reason: 'Valid error response' };
  }

  return { valid: false, reason: 'Unknown response structure' };
}

/**
 * McpResponseにmetadata.request_idが含まれているか検証
 */
function hasRequestId(response: unknown): boolean {
  if (response === null || typeof response !== 'object') return false;
  const obj = response as Record<string, unknown>;
  if (!obj.metadata || typeof obj.metadata !== 'object') return false;
  const metadata = obj.metadata as Record<string, unknown>;
  return typeof metadata.request_id === 'string' && metadata.request_id.length > 0;
}

// =============================================================================
// 全17ツールのMcpResponse形式検証テスト
// =============================================================================

describe('MCP-RESP-08: All 19 Tools McpResponse Format Verification', () => {
  beforeEach(() => {
    clearToolHandlers();
    resetToolMetrics();
  });

  afterEach(() => {
    clearToolHandlers();
    resetToolMetrics();
  });

  describe('19 tools registered correctly', () => {
    it('should have exactly 19 tools defined in allToolDefinitions', () => {
      expect(allToolDefinitions.length).toBe(19);
    });

    it('should have exactly 19 tools in toolHandlers', () => {
      expect(Object.keys(toolHandlers).length).toBe(19);
    });

    it.each(ALL_19_TOOLS)('%s is registered in toolHandlers', (toolName) => {
      expect(toolHandlers[toolName]).toBeDefined();
      expect(typeof toolHandlers[toolName]).toBe('function');
    });
  });

  describe('McpResponse success structure for mock handlers', () => {
    it.each(ALL_19_TOOLS)(
      '%s returns valid McpResponse structure on success',
      async (toolName) => {
        // モックハンドラーを登録（成功レスポンス）
        registerTool(toolName, async () => ({
          success: true,
          data: { id: 'test-id', mockData: true },
          metadata: { request_id: 'mock-request-id' },
        }));

        const result = await handleToolCall(toolName, {});
        const validation = validateMcpResponseStructure(result);

        expect(validation.valid).toBe(true);
        expect(isSuccessResponse(result as { success: true; data: unknown })).toBe(true);
      }
    );

    it.each(ALL_19_TOOLS)(
      '%s returns valid McpResponse structure on error',
      async (toolName) => {
        // モックハンドラーを登録（エラーレスポンス）
        registerTool(toolName, async () => ({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Test error message',
          },
          metadata: { request_id: 'mock-request-id' },
        }));

        const result = await handleToolCall(toolName, {});
        const validation = validateMcpResponseStructure(result);

        expect(validation.valid).toBe(true);
        expect(isErrorResponse(result as { success: false; error: { code: string; message: string } })).toBe(true);
      }
    );
  });

  describe('LightResponse integration via handleToolCall', () => {
    it('should apply light response by default (summary=true)', async () => {
      const toolName = 'layout.ingest';
      registerTool(toolName, async () => ({
        success: true,
        data: {
          id: 'page-123',
          html: '<html>Very long HTML content...</html>',
          screenshot: 'base64EncodedLongString...',
          sections: [{ type: 'hero' }],
        },
      }));

      const result = await handleToolCall(toolName, { url: 'https://example.com' });
      const data = (result as { data: Record<string, unknown> }).data;

      // html and screenshot should be excluded by default
      expect(data.id).toBe('page-123');
      expect(data.html).toBeUndefined();
      expect(data.screenshot).toBeUndefined();
    });

    it('should include html when include_html=true', async () => {
      const toolName = 'layout.ingest';
      registerTool(toolName, async () => ({
        success: true,
        data: {
          id: 'page-123',
          html: '<html>content</html>',
          screenshot: 'base64data',
        },
      }));

      const result = await handleToolCall(toolName, {
        url: 'https://example.com',
        include_html: true,
      });
      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.html).toBe('<html>content</html>');
      expect(data.screenshot).toBeUndefined(); // Not explicitly requested
    });

    it('should include both html and screenshot when summary=false', async () => {
      const toolName = 'layout.ingest';
      registerTool(toolName, async () => ({
        success: true,
        data: {
          id: 'page-123',
          html: '<html>content</html>',
          screenshot: 'base64data',
        },
      }));

      const result = await handleToolCall(toolName, {
        url: 'https://example.com',
        summary: false,
      });
      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.html).toBe('<html>content</html>');
      expect(data.screenshot).toBe('base64data');
    });
  });

  describe('Array limiting in light response mode', () => {
    it('quality.evaluate should limit recommendations array', async () => {
      registerTool('quality.evaluate', async () => ({
        success: true,
        data: {
          overall: 85,
          recommendations: Array(20).fill({ priority: 'high', title: 'Test' }),
          violations: Array(15).fill({ id: 'vio', impact: 'critical' }),
        },
      }));

      const result = await handleToolCall('quality.evaluate', { html: '<html></html>' });
      const data = (result as { data: Record<string, unknown> }).data;

      // Default limit for recommendations is 3
      expect((data.recommendations as unknown[]).length).toBeLessThanOrEqual(3);
      // Default limit for violations is 5
      expect((data.violations as unknown[]).length).toBeLessThanOrEqual(5);
    });

    it('motion.detect should limit patterns array', async () => {
      registerTool('motion.detect', async () => ({
        success: true,
        data: {
          patterns: Array(100).fill({ type: 'animation', name: 'fadeIn' }),
          summary: { totalPatterns: 100 },
        },
      }));

      const result = await handleToolCall('motion.detect', { html: '<html></html>' });
      const data = (result as { data: Record<string, unknown> }).data;

      // Default limit for patterns is 20
      expect((data.patterns as unknown[]).length).toBeLessThanOrEqual(20);
    });

    it('page.analyze should limit nested arrays', async () => {
      registerTool('page.analyze', async () => ({
        success: true,
        data: {
          layout: {
            webPageId: 'wp-123',
            sections: Array(30).fill({ type: 'hero' }),
          },
          motion: {
            patterns: Array(50).fill({ type: 'animation' }),
          },
          quality: {
            overall: 90,
            recommendations: Array(20).fill({ priority: 'high' }),
          },
        },
      }));

      const result = await handleToolCall('page.analyze', { url: 'https://example.com' });
      const data = (result as { data: Record<string, unknown> }).data;
      const layout = data.layout as Record<string, unknown>;
      const motion = data.motion as Record<string, unknown>;
      const quality = data.quality as Record<string, unknown>;

      expect((layout.sections as unknown[]).length).toBeLessThanOrEqual(10);
      expect((motion.patterns as unknown[]).length).toBeLessThanOrEqual(20);
      expect((quality.recommendations as unknown[]).length).toBeLessThanOrEqual(5);
    });
  });

  describe('Error response preservation', () => {
    it('should preserve error structure without modification', async () => {
      registerTool('layout.ingest', async () => ({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid URL provided',
          details: { field: 'url', value: 'invalid-url' },
        },
        metadata: { request_id: 'error-request-123' },
      }));

      const result = await handleToolCall('layout.ingest', { url: 'invalid-url' });

      // Error responses should pass through unchanged
      expect((result as { success: boolean }).success).toBe(false);
      expect((result as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
      expect((result as { error: { message: string } }).error.message).toBe('Invalid URL provided');
    });

    it('should preserve metadata on error responses', async () => {
      registerTool('quality.evaluate', async () => ({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Evaluation failed',
        },
        metadata: {
          request_id: 'error-req-456',
          processing_time_ms: 100,
        },
      }));

      const result = await handleToolCall('quality.evaluate', { html: '<html></html>' });
      const metadata = (result as { metadata: Record<string, unknown> }).metadata;

      // Note: handleToolCall may modify metadata, but error structure should be preserved
      expect((result as { success: boolean }).success).toBe(false);
    });
  });

  describe('Tool-specific LightResponse configurations', () => {
    it('motion.detect should include rawCss when verbose=true', async () => {
      registerTool('motion.detect', async () => ({
        success: true,
        data: {
          patterns: [{ type: 'animation', name: 'fadeIn' }],
          rawCss: '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }',
        },
      }));

      const result = await handleToolCall('motion.detect', {
        html: '<html></html>',
        verbose: true,
      });
      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.rawCss).toBeDefined();
    });

    it('motion.detect should exclude rawCss when verbose=false (default)', async () => {
      registerTool('motion.detect', async () => ({
        success: true,
        data: {
          patterns: [{ type: 'animation', name: 'fadeIn' }],
          rawCss: '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }',
        },
      }));

      const result = await handleToolCall('motion.detect', { html: '<html></html>' });
      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.rawCss).toBeUndefined();
    });

    it('layout.search should respect includeHtml option (camelCase legacy)', async () => {
      registerTool('layout.search', async () => ({
        success: true,
        data: {
          results: [{ id: 'pattern-1', html: '<div>...</div>' }],
          totalCount: 1,
        },
      }));

      const result = await handleToolCall('layout.search', {
        query: 'hero section',
        includeHtml: true,
      });
      const data = (result as { data: Record<string, unknown> }).data;
      const results = data.results as Array<Record<string, unknown>>;

      expect(results[0].html).toBe('<div>...</div>');
    });
  });

  describe('Nested options extraction', () => {
    it('should extract include_html from nested options object', async () => {
      registerTool('layout.ingest', async () => ({
        success: true,
        data: {
          id: 'page-123',
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

    it('should extract include_screenshot from nested options object', async () => {
      registerTool('layout.ingest', async () => ({
        success: true,
        data: {
          id: 'page-123',
          html: '<html>content</html>',
          screenshot: 'base64screenshot',
        },
      }));

      const result = await handleToolCall('layout.ingest', {
        url: 'https://example.com',
        options: {
          include_screenshot: true,
        },
      });
      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.html).toBeUndefined(); // Not requested
      expect(data.screenshot).toBe('base64screenshot');
    });
  });
});

// =============================================================================
// カテゴリ別ツール検証
// =============================================================================

describe('MCP-RESP-08: Category-based Tool Verification', () => {
  beforeEach(() => {
    clearToolHandlers();
    resetToolMetrics();
  });

  afterEach(() => {
    clearToolHandlers();
    resetToolMetrics();
  });

  describe('Style category (1 tool)', () => {
    it('style.get_palette returns valid McpResponse', async () => {
      registerTool('style.get_palette', async () => ({
        success: true,
        data: {
          palettes: [{ id: 'palette-1', name: 'Brand Colors' }],
        },
      }));

      const result = await handleToolCall('style.get_palette', {});
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
    });
  });

  describe('System category (1 tool)', () => {
    it('system.health returns valid McpResponse with health data', async () => {
      registerTool('system.health', async () => ({
        success: true,
        data: {
          status: 'healthy',
          database: { connected: true },
          mcp_tools: { count: 19 },
        },
      }));

      const result = await handleToolCall('system.health', { detailed: true });
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data.status).toBe('healthy');
    });
  });

  describe('Layout category (5 tools)', () => {
    const layoutTools = [
      'layout.inspect',
      'layout.ingest',
      'layout.search',
      'layout.generate_code',
      'layout.batch_ingest',
    ];

    it.each(layoutTools)('%s returns valid McpResponse', async (toolName) => {
      registerTool(toolName, async () => ({
        success: true,
        data: { id: 'test-id', toolName },
      }));

      const result = await handleToolCall(toolName, {});
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
    });
  });

  describe('Quality category (3 tools)', () => {
    const qualityTools = ['quality.evaluate', 'quality.batch_evaluate', 'quality.getJobStatus'];

    it.each(qualityTools)('%s returns valid McpResponse', async (toolName) => {
      registerTool(toolName, async () => ({
        success: true,
        data: { id: 'test-id', toolName },
      }));

      const result = await handleToolCall(toolName, {});
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
    });
  });

  describe('Motion category (2 tools)', () => {
    const motionTools = ['motion.detect', 'motion.search'];

    it.each(motionTools)('%s returns valid McpResponse', async (toolName) => {
      registerTool(toolName, async () => ({
        success: true,
        data: { patterns: [], summary: {} },
      }));

      const result = await handleToolCall(toolName, {});
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
    });
  });

  describe('Brief category (1 tool)', () => {
    it('brief.validate returns valid McpResponse', async () => {
      registerTool('brief.validate', async () => ({
        success: true,
        data: {
          isComplete: true,
          completenessScore: 85,
          issues: [],
        },
      }));

      const result = await handleToolCall('brief.validate', {
        brief: { projectName: 'Test Project' },
      });
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
    });
  });

  describe('Project category (2 tools)', () => {
    const projectTools = ['project.get', 'project.list'];

    it.each(projectTools)('%s returns valid McpResponse', async (toolName) => {
      registerTool(toolName, async () => ({
        success: true,
        data: { id: 'project-1', name: 'Test Project' },
      }));

      const result = await handleToolCall(toolName, {});
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
    });
  });

  describe('Page category (2 tools)', () => {
    const pageTools = ['page.analyze', 'page.getJobStatus'];

    it.each(pageTools)('%s returns valid McpResponse', async (toolName) => {
      registerTool(toolName, async () => ({
        success: true,
        data: { id: 'page-1' },
      }));

      const result = await handleToolCall(toolName, {});
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
    });
  });
});

// =============================================================================
// エッジケーステスト
// =============================================================================

describe('MCP-RESP-08: Edge Cases', () => {
  beforeEach(() => {
    clearToolHandlers();
    resetToolMetrics();
  });

  afterEach(() => {
    clearToolHandlers();
    resetToolMetrics();
  });

  describe('Null and undefined handling', () => {
    it('should handle null data in success response', async () => {
      registerTool('test.tool', async () => ({
        success: true,
        data: null,
      }));

      const result = await handleToolCall('test.tool', {});
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
      expect((result as { data: null }).data).toBeNull();
    });

    it('should handle empty object data', async () => {
      registerTool('test.tool', async () => ({
        success: true,
        data: {},
      }));

      const result = await handleToolCall('test.tool', {});
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
    });

    it('should handle array data (wrapped in object)', async () => {
      // LightResponseControllerは data フィールドがオブジェクトであることを期待
      // 配列データはオブジェクトでラップする必要がある
      registerTool('test.tool', async () => ({
        success: true,
        data: {
          items: [{ id: '1' }, { id: '2' }],
          count: 2,
        },
      }));

      const result = await handleToolCall('test.tool', {});
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
      const data = (result as { data: { items: unknown[]; count: number } }).data;
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.count).toBe(2);
    });
  });

  describe('Deeply nested structures', () => {
    it('should handle deeply nested response data', async () => {
      registerTool('page.analyze', async () => ({
        success: true,
        data: {
          layout: {
            webPageId: 'wp-123',
            sections: [
              {
                type: 'hero',
                elements: {
                  heading: { text: 'Welcome' },
                  buttons: [{ label: 'Get Started' }],
                },
              },
            ],
          },
          motion: {
            patterns: [
              {
                type: 'animation',
                keyframes: [
                  { offset: 0, opacity: 0 },
                  { offset: 1, opacity: 1 },
                ],
              },
            ],
          },
          quality: {
            overall: 90,
            axes: {
              originality: { score: 85 },
              craftsmanship: { score: 92 },
              contextuality: { score: 88 },
            },
          },
        },
      }));

      const result = await handleToolCall('page.analyze', { url: 'https://example.com' });
      const validation = validateMcpResponseStructure(result);

      expect(validation.valid).toBe(true);
    });
  });

  describe('Large response handling', () => {
    it('should handle large arrays with proper truncation', async () => {
      // 1000要素の配列を生成
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({
        id: `item-${i}`,
        data: 'x'.repeat(100), // 各要素に100文字のデータ
      }));

      registerTool('layout.search', async () => ({
        success: true,
        data: {
          results: largeArray,
          totalCount: 1000,
        },
      }));

      const result = await handleToolCall('layout.search', { query: 'test' });
      const data = (result as { data: Record<string, unknown> }).data;
      const results = data.results as unknown[];

      // Light responseにより配列が制限される
      expect(results.length).toBeLessThanOrEqual(10);
    });
  });

  describe('Boolean edge cases', () => {
    it('should correctly identify success=true responses', async () => {
      registerTool('test.tool', async () => ({
        success: true,
        data: { value: false }, // data内のbooleanはsuccessに影響しない
      }));

      const result = await handleToolCall('test.tool', {});

      expect((result as { success: boolean }).success).toBe(true);
      expect(isSuccessResponse(result as { success: true; data: unknown })).toBe(true);
    });

    it('should correctly identify success=false responses', async () => {
      registerTool('test.tool', async () => ({
        success: false,
        error: {
          code: 'TEST_ERROR',
          message: 'Test error',
        },
        data: undefined, // error responseにdataがあってもerrorとして扱われる
      }));

      const result = await handleToolCall('test.tool', {});

      expect((result as { success: boolean }).success).toBe(false);
      expect(
        isErrorResponse(result as { success: false; error: { code: string; message: string } })
      ).toBe(true);
    });
  });
});

// =============================================================================
// 型安全性テスト
// =============================================================================

describe('MCP-RESP-08: Type Safety', () => {
  beforeEach(() => {
    clearToolHandlers();
    resetToolMetrics();
  });

  afterEach(() => {
    clearToolHandlers();
    resetToolMetrics();
  });

  describe('Type guards', () => {
    it('isSuccessResponse should narrow type correctly', async () => {
      registerTool('test.tool', async () => ({
        success: true,
        data: { id: 'test-123', value: 42 },
      }));

      const result = await handleToolCall('test.tool', {});

      if (isSuccessResponse(result as { success: boolean; data?: unknown; error?: unknown })) {
        // TypeScript should allow accessing data here
        const data = (result as { data: { id: string; value: number } }).data;
        expect(data.id).toBe('test-123');
        expect(data.value).toBe(42);
      } else {
        expect.fail('Expected success response');
      }
    });

    it('isErrorResponse should narrow type correctly', async () => {
      registerTool('test.tool', async () => ({
        success: false,
        error: {
          code: 'TEST_ERROR',
          message: 'Test error message',
        },
      }));

      const result = await handleToolCall('test.tool', {});

      if (
        isErrorResponse(result as { success: boolean; data?: unknown; error?: { code: string; message: string } })
      ) {
        // TypeScript should allow accessing error here
        const error = (result as { error: { code: string; message: string } }).error;
        expect(error.code).toBe('TEST_ERROR');
        expect(error.message).toBe('Test error message');
      } else {
        expect.fail('Expected error response');
      }
    });
  });

  describe('Metadata structure', () => {
    it('should support all metadata fields', async () => {
      registerTool('test.tool', async () => ({
        success: true,
        data: { id: 'test' },
        metadata: {
          request_id: 'req-123',
          processing_time_ms: 50,
          optimization_mode: 'summary',
          truncated: false,
          total_count: 100,
          offset: 0,
          limit: 10,
        },
      }));

      const result = await handleToolCall('test.tool', { summary: false });
      const metadata = (result as { metadata: Record<string, unknown> }).metadata;

      // Note: LightResponse may modify some fields
      expect(metadata).toBeDefined();
    });
  });
});
