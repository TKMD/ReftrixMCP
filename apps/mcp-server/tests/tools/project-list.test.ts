// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * project.list MCPツールのテスト
 * TDD Red Phase: 先にテストを作成
 *
 * @module tests/tools/project-list.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// project.list MCPツールハンドラーとツール定義をインポート
// （実装後に動作するようになる）
import {
  projectListHandler,
  projectListToolDefinition,
} from '../../src/tools/project-list';
import {
  projectListInputSchema,
  type ProjectListInput,
} from '../../src/tools/schemas/project-schemas';

// =============================================================================
// テストデータ
// =============================================================================

const mockProjectList = [
  {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Test Project 1',
    slug: 'test-project-1',
    description: 'First test project',
    status: 'draft',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-05T00:00:00.000Z',
    // [DELETED Phase 1] pages removed (ProjectPage table deleted)
    brandSetting: null,
  },
  {
    id: '223e4567-e89b-12d3-a456-426614174001',
    name: 'Test Project 2',
    slug: 'test-project-2',
    description: 'Second test project',
    status: 'in_progress',
    createdAt: '2025-01-02T00:00:00.000Z',
    updatedAt: '2025-01-04T00:00:00.000Z',
    // [DELETED Phase 1] pages removed (ProjectPage table deleted)
    brandSetting: null,
  },
  {
    id: '323e4567-e89b-12d3-a456-426614174002',
    name: 'Test Project 3',
    slug: 'test-project-3',
    description: 'Third test project',
    status: 'completed',
    createdAt: '2025-01-03T00:00:00.000Z',
    updatedAt: '2025-01-03T00:00:00.000Z',
    // [DELETED Phase 1] pages removed (ProjectPage table deleted)
    brandSetting: null,
  },
];

const mockListResponse = {
  projects: mockProjectList,
  total: 3,
  limit: 10,
  offset: 0,
};

// =============================================================================
// 入力スキーマテスト
// =============================================================================

describe('projectListInputSchema', () => {
  describe('有効な入力', () => {
    // P1-PERF-3: LLM最適化のためsummaryデフォルトはtrue
    it('空のオブジェクトを受け付ける（すべてオプション）', () => {
      const input = {};
      const result = projectListInputSchema.parse(input);
      expect(result.limit).toBe(10); // デフォルト
      expect(result.offset).toBe(0); // デフォルト
      expect(result.sortBy).toBe('updatedAt'); // デフォルト
      expect(result.sortOrder).toBe('desc'); // デフォルト
      expect(result.summary).toBe(true); // デフォルト（LLM最適化）
      expect(result.status).toBeUndefined();
    });

    it('statusフィルタを受け付ける（draft）', () => {
      const input = { status: 'draft' };
      const result = projectListInputSchema.parse(input);
      expect(result.status).toBe('draft');
    });

    it('statusフィルタを受け付ける（in_progress）', () => {
      const input = { status: 'in_progress' };
      const result = projectListInputSchema.parse(input);
      expect(result.status).toBe('in_progress');
    });

    it('statusフィルタを受け付ける（review）', () => {
      const input = { status: 'review' };
      const result = projectListInputSchema.parse(input);
      expect(result.status).toBe('review');
    });

    it('statusフィルタを受け付ける（completed）', () => {
      const input = { status: 'completed' };
      const result = projectListInputSchema.parse(input);
      expect(result.status).toBe('completed');
    });

    it('statusフィルタを受け付ける（archived）', () => {
      const input = { status: 'archived' };
      const result = projectListInputSchema.parse(input);
      expect(result.status).toBe('archived');
    });

    it('limit=1を受け付ける（最小値）', () => {
      const input = { limit: 1 };
      const result = projectListInputSchema.parse(input);
      expect(result.limit).toBe(1);
    });

    it('limit=50を受け付ける（最大値）', () => {
      const input = { limit: 50 };
      const result = projectListInputSchema.parse(input);
      expect(result.limit).toBe(50);
    });

    it('offset=0を受け付ける', () => {
      const input = { offset: 0 };
      const result = projectListInputSchema.parse(input);
      expect(result.offset).toBe(0);
    });

    it('offset=100を受け付ける', () => {
      const input = { offset: 100 };
      const result = projectListInputSchema.parse(input);
      expect(result.offset).toBe(100);
    });

    it('sortBy=createdAtを受け付ける', () => {
      const input = { sortBy: 'createdAt' };
      const result = projectListInputSchema.parse(input);
      expect(result.sortBy).toBe('createdAt');
    });

    it('sortBy=updatedAtを受け付ける', () => {
      const input = { sortBy: 'updatedAt' };
      const result = projectListInputSchema.parse(input);
      expect(result.sortBy).toBe('updatedAt');
    });

    it('sortBy=nameを受け付ける', () => {
      const input = { sortBy: 'name' };
      const result = projectListInputSchema.parse(input);
      expect(result.sortBy).toBe('name');
    });

    it('sortOrder=ascを受け付ける', () => {
      const input = { sortOrder: 'asc' };
      const result = projectListInputSchema.parse(input);
      expect(result.sortOrder).toBe('asc');
    });

    it('sortOrder=descを受け付ける', () => {
      const input = { sortOrder: 'desc' };
      const result = projectListInputSchema.parse(input);
      expect(result.sortOrder).toBe('desc');
    });

    it('summary=trueを受け付ける', () => {
      const input = { summary: true };
      const result = projectListInputSchema.parse(input);
      expect(result.summary).toBe(true);
    });

    it('全パラメータ指定を受け付ける', () => {
      const input = {
        status: 'draft',
        limit: 20,
        offset: 10,
        sortBy: 'name',
        sortOrder: 'asc',
        summary: true,
      };
      const result = projectListInputSchema.parse(input);
      expect(result.status).toBe('draft');
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(10);
      expect(result.sortBy).toBe('name');
      expect(result.sortOrder).toBe('asc');
      expect(result.summary).toBe(true);
    });
  });

  describe('無効な入力', () => {
    it('無効なstatus値はエラー', () => {
      const input = { status: 'invalid_status' };
      expect(() => projectListInputSchema.parse(input)).toThrow();
    });

    it('limit=0はエラー（最小値は1）', () => {
      const input = { limit: 0 };
      expect(() => projectListInputSchema.parse(input)).toThrow();
    });

    it('limit=51はエラー（最大値は50）', () => {
      const input = { limit: 51 };
      expect(() => projectListInputSchema.parse(input)).toThrow();
    });

    it('負のlimitはエラー', () => {
      const input = { limit: -1 };
      expect(() => projectListInputSchema.parse(input)).toThrow();
    });

    it('負のoffsetはエラー', () => {
      const input = { offset: -1 };
      expect(() => projectListInputSchema.parse(input)).toThrow();
    });

    it('無効なsortBy値はエラー', () => {
      const input = { sortBy: 'invalid' };
      expect(() => projectListInputSchema.parse(input)).toThrow();
    });

    it('無効なsortOrder値はエラー', () => {
      const input = { sortOrder: 'invalid' };
      expect(() => projectListInputSchema.parse(input)).toThrow();
    });

    it('summaryが文字列の場合エラー', () => {
      const input = { summary: 'true' };
      expect(() => projectListInputSchema.parse(input)).toThrow();
    });
  });
});

// =============================================================================
// ツール定義テスト
// =============================================================================

describe('projectListToolDefinition', () => {
  it('正しいツール名を持つ', () => {
    expect(projectListToolDefinition.name).toBe('project.list');
  });

  it('descriptionが設定されている', () => {
    expect(projectListToolDefinition.description).toBeDefined();
    expect(typeof projectListToolDefinition.description).toBe('string');
    expect(projectListToolDefinition.description.length).toBeGreaterThan(0);
  });

  it('inputSchemaがobject型', () => {
    expect(projectListToolDefinition.inputSchema.type).toBe('object');
  });

  it('必須プロパティがない（すべてオプション）', () => {
    expect(projectListToolDefinition.inputSchema.required).toBeUndefined();
  });

  it('プロパティを含む', () => {
    const { properties } = projectListToolDefinition.inputSchema;
    expect(properties).toHaveProperty('status');
    expect(properties).toHaveProperty('limit');
    expect(properties).toHaveProperty('offset');
    expect(properties).toHaveProperty('sortBy');
    expect(properties).toHaveProperty('sortOrder');
    expect(properties).toHaveProperty('summary');
  });

  it('statusプロパティがenum値を持つ', () => {
    const { properties } = projectListToolDefinition.inputSchema;
    expect(properties.status.enum).toContain('draft');
    expect(properties.status.enum).toContain('in_progress');
    expect(properties.status.enum).toContain('review');
    expect(properties.status.enum).toContain('completed');
    expect(properties.status.enum).toContain('archived');
  });

  it('limitプロパティが適切な範囲を持つ', () => {
    const { properties } = projectListToolDefinition.inputSchema;
    expect(properties.limit.minimum).toBe(1);
    expect(properties.limit.maximum).toBe(50);
    expect(properties.limit.default).toBe(10);
  });

  it('offsetプロパティが適切な範囲を持つ', () => {
    const { properties } = projectListToolDefinition.inputSchema;
    expect(properties.offset.minimum).toBe(0);
    expect(properties.offset.default).toBe(0);
  });

  it('sortByプロパティがenum値を持つ', () => {
    const { properties } = projectListToolDefinition.inputSchema;
    expect(properties.sortBy.enum).toContain('createdAt');
    expect(properties.sortBy.enum).toContain('updatedAt');
    expect(properties.sortBy.enum).toContain('name');
  });

  it('sortOrderプロパティがenum値を持つ', () => {
    const { properties } = projectListToolDefinition.inputSchema;
    expect(properties.sortOrder.enum).toContain('asc');
    expect(properties.sortOrder.enum).toContain('desc');
  });
});

// =============================================================================
// ハンドラーテスト
// =============================================================================

describe('projectListHandler', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('正常系: プロジェクト一覧取得', () => {
    // P1-PERF-3: limit/offset確認にはsummary=false必須
    it('デフォルトパラメータでプロジェクト一覧を取得する', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockListResponse }),
      });

      // Act - summary=falseでフル詳細取得（limit/offset確認のため）
      const input: ProjectListInput = { summary: false };
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toHaveLength(3);
        expect(result.data.total).toBe(3);
        expect(result.data.limit).toBe(10);
        expect(result.data.offset).toBe(0);
      }
    });

    it('statusフィルタでプロジェクトを絞り込む', async () => {
      // Arrange
      const filteredResponse = {
        projects: [mockProjectList[0]], // draft only
        total: 1,
        limit: 10,
        offset: 0,
      };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: filteredResponse }),
      });

      // Act
      const input: ProjectListInput = { status: 'draft' };
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toHaveLength(1);
        expect(result.data.projects[0].status).toBe('draft');
        expect(result.data.total).toBe(1);
      }
    });

    // P1-PERF-3: limit確認にはsummary=false必須
    it('limitでプロジェクト数を制限する', async () => {
      // Arrange
      const limitedResponse = {
        projects: mockProjectList.slice(0, 2),
        total: 3,
        limit: 2,
        offset: 0,
      };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: limitedResponse }),
      });

      // Act - summary=falseでフル詳細取得（limit確認のため）
      const input: ProjectListInput = { limit: 2, summary: false };
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toHaveLength(2);
        expect(result.data.limit).toBe(2);
        expect(result.data.total).toBe(3); // totalは全件数
      }
    });

    // P1-PERF-3: offset確認にはsummary=false必須
    it('offsetでページネーションする', async () => {
      // Arrange
      const offsetResponse = {
        projects: mockProjectList.slice(1), // skip first
        total: 3,
        limit: 10,
        offset: 1,
      };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: offsetResponse }),
      });

      // Act - summary=falseでフル詳細取得（offset確認のため）
      const input: ProjectListInput = { offset: 1, summary: false };
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toHaveLength(2);
        expect(result.data.offset).toBe(1);
      }
    });

    // P1-PERF-3: createdAtを参照するのでsummary=false必須
    it('sortBy + sortOrderでソートする（createdAt, asc）', async () => {
      // Arrange
      const sortedProjects = [...mockProjectList].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      const sortedResponse = {
        projects: sortedProjects,
        total: 3,
        limit: 10,
        offset: 0,
      };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: sortedResponse }),
      });

      // Act - summary=falseでフル詳細取得（createdAt参照のため）
      const input: ProjectListInput = { sortBy: 'createdAt', sortOrder: 'asc', summary: false };
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toHaveLength(3);
        // 最初のプロジェクトが最も古い日付
        expect(result.data.projects[0].createdAt).toBe('2025-01-01T00:00:00.000Z');
      }
    });

    it('sortBy + sortOrderでソートする（name, desc）', async () => {
      // Arrange
      const sortedProjects = [...mockProjectList].sort((a, b) =>
        b.name.localeCompare(a.name)
      );
      const sortedResponse = {
        projects: sortedProjects,
        total: 3,
        limit: 10,
        offset: 0,
      };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: sortedResponse }),
      });

      // Act
      const input: ProjectListInput = { sortBy: 'name', sortOrder: 'desc' };
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toHaveLength(3);
      }
    });

    it('summary=trueで軽量レスポンスを返す', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockListResponse }),
      });

      // Act
      const input: ProjectListInput = { summary: true };
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        // summaryモードではid, name, statusのみ
        expect(result.data.projects).toHaveLength(3);
        expect(result.data.projects[0].id).toBeDefined();
        expect(result.data.projects[0].name).toBeDefined();
        expect(result.data.projects[0].status).toBeDefined();
        expect((result.data as { _summary_mode?: boolean })._summary_mode).toBe(true);

        // summaryモードでは詳細情報が含まれない
        expect(
          (result.data.projects[0] as { description?: unknown }).description
        ).toBeUndefined();
        expect(
          (result.data.projects[0] as { slug?: unknown }).slug
        ).toBeUndefined();
        // [DELETED Phase 1] pages assertion removed (ProjectPage table deleted)
      }
    });

    it('summary=falseでフルレスポンスを返す', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockListResponse }),
      });

      // Act
      const input: ProjectListInput = { summary: false };
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toHaveLength(3);
        expect(result.data.projects[0].id).toBeDefined();
        expect(result.data.projects[0].name).toBeDefined();
        expect(result.data.projects[0].slug).toBeDefined();
        expect(result.data.projects[0].description).toBeDefined();
        expect(result.data.projects[0].status).toBeDefined();
        expect((result.data as { _summary_mode?: boolean })._summary_mode).toBeUndefined();
      }
    });

    // P1-PERF-3: limit/offset確認にはsummary=false必須
    it('複数パラメータの組み合わせ', async () => {
      // Arrange
      const combinedResponse = {
        projects: [mockProjectList[0]],
        total: 1,
        limit: 5,
        offset: 0,
      };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: combinedResponse }),
      });

      // Act
      const input: ProjectListInput = {
        status: 'draft',
        limit: 5,
        offset: 0,
        sortBy: 'name',
        sortOrder: 'asc',
        summary: false, // limit/offsetを確認するためフルレスポンス必要
      };
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toHaveLength(1);
        expect(result.data.limit).toBe(5);
      }
    });

    it('空の結果を正しく処理する', async () => {
      // Arrange
      const emptyResponse = {
        projects: [],
        total: 0,
        limit: 10,
        offset: 0,
      };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: emptyResponse }),
      });

      // Act
      const input: ProjectListInput = { status: 'archived' };
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toHaveLength(0);
        expect(result.data.total).toBe(0);
      }
    });
  });

  describe('異常系: バリデーションエラー', () => {
    it('無効なstatus値の場合エラーレスポンスを返す', async () => {
      const input = { status: 'invalid_status' };
      const result = await projectListHandler(input);

      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(result.error.message).toMatch(/入力バリデーションエラー/);
      }
    });

    it('limit=0の場合エラーレスポンスを返す', async () => {
      const input = { limit: 0 };
      const result = await projectListHandler(input);

      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('limit=51の場合エラーレスポンスを返す', async () => {
      const input = { limit: 51 };
      const result = await projectListHandler(input);

      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('負のoffsetの場合エラーレスポンスを返す', async () => {
      const input = { offset: -1 };
      const result = await projectListHandler(input);

      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('無効なsortBy値の場合エラーレスポンスを返す', async () => {
      const input = { sortBy: 'invalid_field' };
      const result = await projectListHandler(input);

      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('無効なsortOrder値の場合エラーレスポンスを返す', async () => {
      const input = { sortOrder: 'invalid_order' };
      const result = await projectListHandler(input);

      expect(result.success).toBe(false);
      expect(result.metadata?.request_id).toBeDefined();
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('入力がnullの場合正常に処理（デフォルト値適用）', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockListResponse }),
      });

      // Act - nullを渡しても空オブジェクトとして処理
      const result = await projectListHandler(null);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toBeDefined();
      }
    });

    it('入力がundefinedの場合正常に処理（デフォルト値適用）', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: mockListResponse }),
      });

      // Act
      const result = await projectListHandler(undefined);

      // Assert - 統一レスポンス形式
      expect(result.success).toBe(true);
      expect(result.metadata?.request_id).toBeDefined();
      if (result.success) {
        expect(result.data.projects).toBeDefined();
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
          JSON.stringify({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          }),
      });

      // Act
      const input: ProjectListInput = {};
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
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
      const input: ProjectListInput = {};
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
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
      const input: ProjectListInput = {};
      const result = await projectListHandler(input);

      // Assert - 統一レスポンス形式
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

describe('project.list 統合テスト', () => {
  it('ツール定義とハンドラーが一致する', () => {
    // ツール定義のプロパティ名がハンドラーで使用される入力と一致
    const { properties } = projectListToolDefinition.inputSchema;
    const propNames = Object.keys(properties);

    // オプションプロパティ
    expect(propNames).toContain('status');
    expect(propNames).toContain('limit');
    expect(propNames).toContain('offset');
    expect(propNames).toContain('sortBy');
    expect(propNames).toContain('sortOrder');
    expect(propNames).toContain('summary');
  });

  it('Zodスキーマとツール定義のrequiredが一致する', () => {
    // ツール定義に必須フィールドがない（すべてオプション）
    expect(projectListToolDefinition.inputSchema.required).toBeUndefined();
  });

  it('ツール定義のenum値がZodスキーマと一致する', () => {
    const { properties } = projectListToolDefinition.inputSchema;

    // status enum
    const statusEnum = properties.status.enum as string[];
    expect(statusEnum).toContain('draft');
    expect(statusEnum).toContain('in_progress');
    expect(statusEnum).toContain('review');
    expect(statusEnum).toContain('completed');
    expect(statusEnum).toContain('archived');

    // sortBy enum
    const sortByEnum = properties.sortBy.enum as string[];
    expect(sortByEnum).toContain('createdAt');
    expect(sortByEnum).toContain('updatedAt');
    expect(sortByEnum).toContain('name');

    // sortOrder enum
    const sortOrderEnum = properties.sortOrder.enum as string[];
    expect(sortOrderEnum).toContain('asc');
    expect(sortOrderEnum).toContain('desc');
  });
});
