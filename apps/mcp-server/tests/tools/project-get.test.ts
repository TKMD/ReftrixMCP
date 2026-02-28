// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * project.get MCPツールのテスト
 * TDD Red Phase: 先にテストを作成
 *
 * @module tests/tools/project-get.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// project.get MCPツールハンドラーとツール定義をインポート
// （実装後に動作するようになる）
import {
  projectGetHandler,
  projectGetToolDefinition,
} from '../../src/tools/project-get';
import {
  projectGetInputSchema,
  type ProjectGetInput,
} from '../../src/tools/schemas/project-schemas';

// =============================================================================
// テストデータ
// =============================================================================

const validProjectId = '123e4567-e89b-12d3-a456-426614174000';
const invalidProjectId = 'not-a-uuid';

const mockProjectResponse = {
  id: validProjectId,
  name: 'Test Project',
  slug: 'test-project',
  description: 'A test project for TDD',
  status: 'draft',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-02T00:00:00.000Z',
  // [DELETED Phase 1] pages removed (ProjectPage table deleted)
  brandSetting: {
    id: '789e0123-e89b-12d3-a456-426614174002',
    brandId: null,
    paletteId: null,
  },
};

// =============================================================================
// 入力スキーマテスト
// =============================================================================

describe('projectGetInputSchema', () => {
  describe('有効な入力', () => {
    // P1-PERF-3: LLM最適化のためsummaryデフォルトはtrue
    it('IDのみの入力を受け付ける', () => {
      const input = { id: validProjectId };
      const result = projectGetInputSchema.parse(input);
      expect(result.id).toBe(validProjectId);
      expect(result.summary).toBe(true); // デフォルト（LLM最適化）
    });

    it('summary=trueの入力を受け付ける', () => {
      const input = { id: validProjectId, summary: true };
      const result = projectGetInputSchema.parse(input);
      expect(result.id).toBe(validProjectId);
      expect(result.summary).toBe(true);
    });

    it('summary=falseの入力を受け付ける', () => {
      const input = { id: validProjectId, summary: false };
      const result = projectGetInputSchema.parse(input);
      expect(result.summary).toBe(false);
    });
  });

  describe('無効な入力', () => {
    it('idが空の場合エラー', () => {
      const input = { id: '' };
      expect(() => projectGetInputSchema.parse(input)).toThrow();
    });

    it('idがnullの場合エラー', () => {
      const input = { id: null };
      expect(() => projectGetInputSchema.parse(input)).toThrow();
    });

    it('idがundefinedの場合エラー', () => {
      const input = {};
      expect(() => projectGetInputSchema.parse(input)).toThrow();
    });

    it('idが無効なUUID形式の場合エラー', () => {
      const input = { id: invalidProjectId };
      expect(() => projectGetInputSchema.parse(input)).toThrow();
    });

    it('summaryが文字列の場合エラー', () => {
      const input = { id: validProjectId, summary: 'true' };
      expect(() => projectGetInputSchema.parse(input)).toThrow();
    });
  });
});

// =============================================================================
// ツール定義テスト
// =============================================================================

describe('projectGetToolDefinition', () => {
  it('正しいツール名を持つ', () => {
    expect(projectGetToolDefinition.name).toBe('project.get');
  });

  it('descriptionが設定されている', () => {
    expect(projectGetToolDefinition.description).toBeDefined();
    expect(typeof projectGetToolDefinition.description).toBe('string');
    expect(projectGetToolDefinition.description.length).toBeGreaterThan(0);
  });

  it('inputSchemaがobject型', () => {
    expect(projectGetToolDefinition.inputSchema.type).toBe('object');
  });

  it('idが必須プロパティ', () => {
    expect(projectGetToolDefinition.inputSchema.required).toContain('id');
  });

  it('プロパティを含む', () => {
    const { properties } = projectGetToolDefinition.inputSchema;
    expect(properties).toHaveProperty('id');
    expect(properties).toHaveProperty('summary');
  });

  it('idプロパティがUUID形式', () => {
    const { properties } = projectGetToolDefinition.inputSchema;
    expect(properties.id.format).toBe('uuid');
  });
});

// =============================================================================
// ハンドラーテスト
// =============================================================================

describe('projectGetHandler', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('正常系: プロジェクト取得', () => {
    // P1-PERF-3: デフォルトsummary=trueなので、フル詳細取得時はsummary=falseを明示
    it('有効なIDでプロジェクト詳細を取得する', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockProjectResponse }),
      });

      // Act - summary=false を明示的に指定してフル詳細取得
      const input: ProjectGetInput = { id: validProjectId, summary: false };
      const result = await projectGetHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.id).toBe(validProjectId);
        expect(result.data.name).toBe('Test Project');
        expect(result.data.slug).toBe('test-project');
        expect(result.data.description).toBe('A test project for TDD');
        expect(result.data.status).toBe('draft');
        expect(result.data.createdAt).toBe('2025-01-01T00:00:00.000Z');
        expect(result.data.updatedAt).toBe('2025-01-02T00:00:00.000Z');
        // [DELETED Phase 1] pages assertion removed (ProjectPage table deleted)
        expect(result.data.brandSetting).toBeDefined();
      }
    });

    it('summary=trueで軽量レスポンスを返す', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockProjectResponse }),
      });

      // Act
      const input: ProjectGetInput = { id: validProjectId, summary: true };
      const result = await projectGetHandler(input);

      // Assert - summaryモードではid, name, statusのみ
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.id).toBe(validProjectId);
        expect(result.data.name).toBe('Test Project');
        expect(result.data.status).toBe('draft');
        expect((result.data as { _summary_mode?: boolean })._summary_mode).toBe(true);

        // summaryモードでは詳細情報が含まれない
        expect((result.data as { pages?: unknown }).pages).toBeUndefined();
        expect((result.data as { brandSetting?: unknown }).brandSetting).toBeUndefined();
        expect((result.data as { description?: unknown }).description).toBeUndefined();
      }
    });

    it('summary=falseでフルレスポンスを返す', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockProjectResponse }),
      });

      // Act
      const input: ProjectGetInput = { id: validProjectId, summary: false };
      const result = await projectGetHandler(input);

      // Assert - フルレスポンス
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.id).toBe(validProjectId);
        expect(result.data.name).toBe('Test Project');
        // [DELETED Phase 1] pages assertion removed (ProjectPage table deleted)
        expect(result.data.brandSetting).toBeDefined();
        expect((result.data as { _summary_mode?: boolean })._summary_mode).toBeUndefined();
      }
    });
  });

  describe('異常系: バリデーションエラー', () => {
    it('無効なUUID形式の場合エラーレスポンスを返す', async () => {
      const input = { id: invalidProjectId };
      const result = await projectGetHandler(input);

      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(result.error.message).toMatch(/入力バリデーションエラー/);
      }
    });

    it('idが空の場合エラーレスポンスを返す', async () => {
      const input = { id: '' };
      const result = await projectGetHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('入力がnullの場合エラーレスポンスを返す', async () => {
      const result = await projectGetHandler(null);
      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
    });

    it('入力がundefinedの場合エラーレスポンスを返す', async () => {
      const result = await projectGetHandler(undefined);
      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
    });
  });

  describe('異常系: 存在しないプロジェクト', () => {
    it('存在しないIDの場合エラーレスポンスを返す', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { code: 'NOT_FOUND' } }),
      });

      // Act
      const input: ProjectGetInput = { id: validProjectId };
      const result = await projectGetHandler(input);

      // Assert
      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('PROJECT_NOT_FOUND');
        expect(result.error.message).toMatch(/プロジェクトが見つかりません/);
      }
    });
  });

  describe('異常系: 認証エラー', () => {
    it('認証されていない場合エラーレスポンスを返す', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }),
      });

      // Act
      const input: ProjectGetInput = { id: validProjectId };
      const result = await projectGetHandler(input);

      // Assert
      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('UNAUTHORIZED');
        expect(result.error.message).toMatch(/認証が必要です/);
      }
    });
  });

  describe('異常系: APIエラー', () => {
    it('サーバーエラーの場合エラーレスポンスを返す', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      // Act
      const input: ProjectGetInput = { id: validProjectId };
      const result = await projectGetHandler(input);

      // Assert
      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('INTERNAL_ERROR');
        expect(result.error.message).toMatch(/エラーが発生しました/);
      }
    });

    it('ネットワークエラーの場合エラーレスポンスを返す', async () => {
      // Arrange
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      // Act
      const input: ProjectGetInput = { id: validProjectId };
      const result = await projectGetHandler(input);

      // Assert
      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('INTERNAL_ERROR');
      }
    });
  });
});

// =============================================================================
// 統合テスト
// =============================================================================

describe('project.get 統合テスト', () => {
  it('ツール定義とハンドラーが一致する', () => {
    // ツール定義のプロパティ名がハンドラーで使用される入力と一致
    const { properties } = projectGetToolDefinition.inputSchema;
    const propNames = Object.keys(properties);

    // 必須のプロパティ
    expect(propNames).toContain('id');

    // オプションプロパティ
    expect(propNames).toContain('summary');
  });

  it('Zodスキーマとツール定義のrequiredが一致する', () => {
    // ツール定義の必須フィールド
    const toolRequired = projectGetToolDefinition.inputSchema.required;

    // Zodスキーマで必須のフィールドはidのみ
    expect(toolRequired).toContain('id');
    expect(toolRequired).not.toContain('summary'); // オプション
  });
});
