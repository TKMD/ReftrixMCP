// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * system.health Smoke Test
 *
 * 目的: system.health ツールが正常に応答することを確認
 *
 * このテストは以下を検証:
 * - ハンドラーが正常に呼び出し可能
 * - レスポンス構造が正しい（McpResponse形式）
 * - 必須フィールドが含まれる
 *
 * @see src/tools/system-health.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  systemHealthHandler,
  systemHealthToolDefinition,
} from '../../src/tools/system-health';

describe('system.health Smoke Test', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    // fetchをモックして外部依存を排除
    originalFetch = global.fetch;
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', version: '0.1.0' }),
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('ハンドラー呼び出し', () => {
    it('systemHealthHandler が正常に呼び出し可能', async () => {
      const result = await systemHealthHandler();
      expect(result).toBeDefined();
    });

    it('McpResponse形式で返却される', async () => {
      const result = await systemHealthHandler();
      // McpResponse形式の検証
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.metadata).toBeDefined();
      expect(result.metadata.request_id).toBeDefined();
    });

    it('レスポンスに status フィールドが含まれる', async () => {
      const result = await systemHealthHandler();
      expect(result.success).toBe(true);
      expect(result.data?.status).toBeDefined();
      expect(['healthy', 'unhealthy', 'degraded']).toContain(result.data?.status);
    });

    it('レスポンスに timestamp フィールドが含まれる', async () => {
      const result = await systemHealthHandler();
      expect(result.success).toBe(true);
      expect(result.data?.timestamp).toBeDefined();
      expect(() => new Date(result.data!.timestamp)).not.toThrow();
    });

    it('レスポンスに services オブジェクトが含まれる', async () => {
      const result = await systemHealthHandler();
      expect(result.success).toBe(true);
      expect(result.data?.services).toBeDefined();
      expect(typeof result.data?.services).toBe('object');
    });

  });

  describe('ツール定義', () => {
    it('ツール名が system.health である', () => {
      expect(systemHealthToolDefinition.name).toBe('system.health');
    });

    it('description が定義されている', () => {
      expect(systemHealthToolDefinition.description).toBeDefined();
      expect(systemHealthToolDefinition.description.length).toBeGreaterThan(10);
    });

    it('inputSchema が object 型である', () => {
      expect(systemHealthToolDefinition.inputSchema.type).toBe('object');
    });

    it('必須パラメータがない（オプショナル）', () => {
      expect(systemHealthToolDefinition.inputSchema.required).toEqual([]);
    });
  });

});
