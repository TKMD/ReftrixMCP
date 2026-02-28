// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze Smoke Test
 *
 * 目的: page.analyze ツールの基本動作を確認
 *
 * このテストは以下を検証:
 * - ツール定義が正しい
 * - 入力スキーマが正しい
 * - モック使用でハンドラーが呼び出し可能
 *
 * 注意: 実際のPlaywright起動やネットワークアクセスは行わない
 *
 * @see src/tools/page/analyze.tool.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  pageAnalyzeToolDefinition,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
} from '../../src/tools/page';

describe('page.analyze Smoke Test', () => {
  afterEach(() => {
    resetPageAnalyzeServiceFactory();
    vi.restoreAllMocks();
  });

  describe('ツール定義', () => {
    it('ツール名が page.analyze である', () => {
      expect(pageAnalyzeToolDefinition.name).toBe('page.analyze');
    });

    it('description が定義されている', () => {
      expect(pageAnalyzeToolDefinition.description).toBeDefined();
      expect(pageAnalyzeToolDefinition.description.length).toBeGreaterThan(10);
    });

    it('inputSchema が object 型である', () => {
      expect(pageAnalyzeToolDefinition.inputSchema.type).toBe('object');
    });

    it('url が必須パラメータである', () => {
      const required = pageAnalyzeToolDefinition.inputSchema.required;
      expect(required).toContain('url');
    });
  });

  describe('入力スキーマ構造', () => {
    const properties = pageAnalyzeToolDefinition.inputSchema
      .properties as Record<string, unknown>;

    it('url プロパティが定義されている', () => {
      expect(properties.url).toBeDefined();
    });

    it('summary プロパティが定義されている', () => {
      expect(properties.summary).toBeDefined();
    });

    it('timeout プロパティが定義されている', () => {
      expect(properties.timeout).toBeDefined();
    });

    it('features プロパティが定義されている', () => {
      expect(properties.features).toBeDefined();
    });

    it('layoutOptions プロパティが定義されている', () => {
      expect(properties.layoutOptions).toBeDefined();
    });

    it('motionOptions プロパティが定義されている', () => {
      expect(properties.motionOptions).toBeDefined();
    });

    it('qualityOptions プロパティが定義されている', () => {
      expect(properties.qualityOptions).toBeDefined();
    });
  });

  describe('モックサービスでのハンドラー呼び出し', () => {
    it('モックサービスを設定できる', () => {
      const mockService = {
        analyze: vi.fn().mockResolvedValue({
          success: true,
          url: 'https://example.com',
          analyzedAt: new Date().toISOString(),
          processingTimeMs: 1000,
          data: {
            layout: { sections: [], patterns: [] },
            motion: { patterns: [], summary: { total: 0 } },
            quality: { overall: 80, grade: 'B' },
          },
        }),
      };

      // サービスファクトリを設定（エラーなく完了すればOK）
      expect(() => {
        setPageAnalyzeServiceFactory(() => mockService as any);
      }).not.toThrow();
    });
  });

  describe('page.getJobStatus ツール定義', () => {
    // page.getJobStatus も同じモジュールからエクスポートされる
    it('page.getJobStatus がエクスポートされている', async () => {
      const { pageGetJobStatusToolDefinition } = await import(
        '../../src/tools/page'
      );
      expect(pageGetJobStatusToolDefinition).toBeDefined();
      expect(pageGetJobStatusToolDefinition.name).toBe('page.getJobStatus');
    });
  });
});
