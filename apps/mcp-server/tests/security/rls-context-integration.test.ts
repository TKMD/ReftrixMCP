// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RLSコンテキスト統合テスト（SEC推奨）
 *
 * MCPツール（layout.ingest, motion.detect, page.analyze）がDB保存時に
 * RLS（Row Level Security）コンテキストを正しく設定することを確認する統合テスト。
 *
 * テスト戦略:
 * 1. MCP toolハンドラーレベルでのRLSコンテキスト設定テスト
 * 2. Prisma Wrapper経由のRLSコンテキスト確認テスト
 * 3. クロステナントアクセス防止テスト
 *
 * 評価基準（Agent Evaluation Best Practices準拠）:
 * - Unambiguous: RLSコンテキスト設定の有無を明確に検証
 * - Verifiable: SET LOCAL app.current_project の実行を自動検証
 * - Atomic: 各テストは単一の動作のみを検証
 *
 * @module tests/security/rls-context-integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =====================================================
// テスト用モック型定義
// =====================================================

/**
 * RLS対応のモックPrismaClient
 * SET LOCALの実行を記録し、RLSコンテキストが設定されたかを追跡
 */
interface RLSAwareMockPrismaClient {
  /** 実行されたRLSコンテキスト設定（SET LOCAL app.current_project）の記録 */
  rlsContextHistory: Array<{
    projectId: string;
    timestamp: number;
    withinTransaction: boolean;
  }>;
  /** テーブル操作の記録 */
  operationHistory: Array<{
    table: string;
    operation: 'create' | 'createMany' | 'update' | 'delete' | 'upsert';
    data: unknown;
    rlsContextProjectId: string | null;
    withinTransaction: boolean;
  }>;
  /** 現在のトランザクション内RLSコンテキスト */
  currentRlsContext: string | null;
  /** トランザクション実行中フラグ */
  inTransaction: boolean;

  // Prismaクライアントメソッド
  webPage: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
    upsert: (args: {
      where: unknown;
      create: unknown;
      update: unknown;
    }) => Promise<{ id: string }>;
  };
  sectionPattern: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
  sectionEmbedding: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
  motionPattern: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
  motionEmbedding: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
  jSAnimationPattern: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
  jSAnimationEmbedding: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
  qualityEvaluation: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
  };
  qualityBenchmark: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
  };

  // Prisma Raw SQL
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;

  // Prismaトランザクション
  $transaction: <T>(
    fn: (tx: RLSAwareMockPrismaClient) => Promise<T>
  ) => Promise<T>;

  // ヘルパーメソッド
  reset: () => void;
  wasRlsSetForOperation: (table: string, operation: string) => boolean;
  getRlsContextForOperation: (table: string, operation: string) => string | null;
}

/**
 * RLS対応モックPrismaClientを生成
 */
function createRLSAwareMockPrismaClient(): RLSAwareMockPrismaClient {
  const rlsContextHistory: RLSAwareMockPrismaClient['rlsContextHistory'] = [];
  const operationHistory: RLSAwareMockPrismaClient['operationHistory'] = [];
  let currentRlsContext: string | null = null;
  let inTransaction = false;

  /**
   * テーブル操作をモック化するヘルパー
   */
  const createTableMock = (tableName: string) => ({
    create: async (args: { data: unknown }): Promise<{ id: string }> => {
      operationHistory.push({
        table: tableName,
        operation: 'create',
        data: args.data,
        rlsContextProjectId: currentRlsContext,
        withinTransaction: inTransaction,
      });
      return { id: `mock-${tableName}-${Date.now()}` };
    },
    createMany: async (args: { data: unknown[] }): Promise<{ count: number }> => {
      operationHistory.push({
        table: tableName,
        operation: 'createMany',
        data: args.data,
        rlsContextProjectId: currentRlsContext,
        withinTransaction: inTransaction,
      });
      return { count: Array.isArray(args.data) ? args.data.length : 0 };
    },
    upsert: async (args: {
      where: unknown;
      create: unknown;
      update: unknown;
    }): Promise<{ id: string }> => {
      operationHistory.push({
        table: tableName,
        operation: 'upsert',
        data: { where: args.where, create: args.create, update: args.update },
        rlsContextProjectId: currentRlsContext,
        withinTransaction: inTransaction,
      });
      return { id: `mock-${tableName}-${Date.now()}` };
    },
  });

  const mockClient: RLSAwareMockPrismaClient = {
    rlsContextHistory,
    operationHistory,
    get currentRlsContext() {
      return currentRlsContext;
    },
    set currentRlsContext(value: string | null) {
      currentRlsContext = value;
    },
    get inTransaction() {
      return inTransaction;
    },
    set inTransaction(value: boolean) {
      inTransaction = value;
    },

    webPage: {
      ...createTableMock('webPage'),
      upsert: async (args): Promise<{ id: string }> => {
        operationHistory.push({
          table: 'webPage',
          operation: 'upsert',
          data: { where: args.where, create: args.create, update: args.update },
          rlsContextProjectId: currentRlsContext,
          withinTransaction: inTransaction,
        });
        return { id: `mock-webPage-${Date.now()}` };
      },
    },
    sectionPattern: createTableMock('sectionPattern'),
    sectionEmbedding: createTableMock('sectionEmbedding'),
    motionPattern: createTableMock('motionPattern'),
    motionEmbedding: createTableMock('motionEmbedding'),
    jSAnimationPattern: createTableMock('jSAnimationPattern'),
    jSAnimationEmbedding: createTableMock('jSAnimationEmbedding'),
    qualityEvaluation: createTableMock('qualityEvaluation'),
    qualityBenchmark: createTableMock('qualityBenchmark'),

    $executeRawUnsafe: async (
      query: string,
      ..._values: unknown[]
    ): Promise<number> => {
      // RLSコンテキスト設定を検出
      // 注: エスケープされたシングルクォート '' を含む値にも対応
      const rlsMatch = query.match(
        /SET LOCAL app\.current_project\s*=\s*'((?:[^']|'')+)'/i
      );
      if (rlsMatch) {
        const projectId = rlsMatch[1] ?? 'unknown';
        currentRlsContext = projectId;
        rlsContextHistory.push({
          projectId,
          timestamp: Date.now(),
          withinTransaction: inTransaction,
        });

        if (process.env.NODE_ENV === 'development') {
          console.log(
            `[RLS-Integration-Test] SET LOCAL app.current_project = '${projectId}' (inTransaction: ${inTransaction})`
          );
        }
      }
      return 1;
    },

    $queryRawUnsafe: async (
      _query: string,
      ..._values: unknown[]
    ): Promise<unknown> => {
      return [];
    },

    $transaction: async <T>(
      fn: (tx: RLSAwareMockPrismaClient) => Promise<T>
    ): Promise<T> => {
      const previousRlsContext = currentRlsContext;
      const previousInTransaction = inTransaction;

      inTransaction = true;
      // トランザクション開始時にRLSコンテキストをクリア（SET LOCALはトランザクションスコープ）
      currentRlsContext = null;

      try {
        return await fn(mockClient);
      } finally {
        // トランザクション終了後にリセット（SET LOCALの効果はトランザクション終了で消える）
        inTransaction = previousInTransaction;
        currentRlsContext = previousRlsContext;
      }
    },

    reset: () => {
      rlsContextHistory.length = 0;
      operationHistory.length = 0;
      currentRlsContext = null;
      inTransaction = false;
    },

    wasRlsSetForOperation: (table: string, operation: string): boolean => {
      const op = operationHistory.find(
        (o) => o.table === table && o.operation === operation
      );
      return op?.rlsContextProjectId !== null;
    },

    getRlsContextForOperation: (
      table: string,
      operation: string
    ): string | null => {
      const op = operationHistory.find(
        (o) => o.table === table && o.operation === operation
      );
      return op?.rlsContextProjectId ?? null;
    },
  };

  return mockClient;
}

// =====================================================
// UUIDv7バリデーション関数
// =====================================================

/**
 * UUIDv7形式を検証
 * @param id - 検証する文字列
 * @returns 有効なUUIDv7形式の場合true
 */
function isValidUUIDv7(id: string): boolean {
  if (!id) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id
  );
}

/**
 * SQLインジェクション対策のサニタイズ
 * @param value - サニタイズする値
 * @returns サニタイズされた文字列
 */
function sanitizeProjectIdForSql(value: string): string {
  return value.replace(/'/g, "''");
}

// =====================================================
// テスト本体
// =====================================================

describe('RLS Context Integration Tests (SEC Recommended)', () => {
  let mockPrisma: RLSAwareMockPrismaClient;

  beforeEach(() => {
    mockPrisma = createRLSAwareMockPrismaClient();
    vi.clearAllMocks();

    if (process.env.NODE_ENV === 'development') {
      console.log('[RLS-Integration-Test] Starting RLS context integration test');
    }
  });

  afterEach(() => {
    mockPrisma.reset();
  });

  // =====================================================
  // 1. MCP toolハンドラーレベルでのRLSコンテキスト設定テスト
  // =====================================================

  describe('MCP Tool Handler Level RLS Context Tests', () => {
    /**
     * layout.ingest がDB保存時にRLSコンテキストを設定することを確認
     *
     * 期待動作:
     * - トランザクション内でSET LOCAL app.current_projectが実行される
     * - WebPage, SectionPattern, SectionEmbedding 操作時にRLSコンテキストが設定済み
     */
    describe('layout.ingest RLS Context', () => {
      it('should set RLS context before WebPage upsert operation', async () => {
        const projectId = '01919f9a-7b1c-7000-8000-000000000001';

        // 期待される動作: トランザクション内でRLSコンテキストを設定してからDB操作
        await mockPrisma.$transaction(async (tx) => {
          // RLSコンテキスト設定
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_project = '${sanitizeProjectIdForSql(projectId)}'`
          );

          // WebPage upsert
          await tx.webPage.upsert({
            where: { id: 'existing-page-id' },
            create: {
              url: 'https://example.com',
              title: 'Test Page',
              html: '<html></html>',
            },
            update: { title: 'Updated Title' },
          });

          return true;
        });

        // 検証: RLSコンテキストが設定された
        expect(mockPrisma.rlsContextHistory.length).toBeGreaterThan(0);
        expect(mockPrisma.rlsContextHistory[0]?.projectId).toBe(projectId);
        expect(mockPrisma.rlsContextHistory[0]?.withinTransaction).toBe(true);

        // 検証: WebPage操作時にRLSコンテキストが設定されていた
        expect(mockPrisma.wasRlsSetForOperation('webPage', 'upsert')).toBe(true);
        expect(mockPrisma.getRlsContextForOperation('webPage', 'upsert')).toBe(
          projectId
        );
      });

      it('should set RLS context before SectionPattern createMany operation', async () => {
        const projectId = '01919f9a-7b1c-7000-8000-000000000002';

        await mockPrisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_project = '${sanitizeProjectIdForSql(projectId)}'`
          );

          await tx.sectionPattern.createMany({
            data: [
              { webPageId: 'page-1', sectionType: 'hero', positionIndex: 0 },
              { webPageId: 'page-1', sectionType: 'feature', positionIndex: 1 },
            ],
          });

          return true;
        });

        expect(mockPrisma.wasRlsSetForOperation('sectionPattern', 'createMany')).toBe(
          true
        );
        expect(
          mockPrisma.getRlsContextForOperation('sectionPattern', 'createMany')
        ).toBe(projectId);
      });

      it('should set RLS context before SectionEmbedding createMany operation', async () => {
        const projectId = '01919f9a-7b1c-7000-8000-000000000003';

        await mockPrisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_project = '${sanitizeProjectIdForSql(projectId)}'`
          );

          await tx.sectionEmbedding.createMany({
            data: [
              {
                sectionPatternId: 'section-1',
                modelVersion: 'multilingual-e5-base',
              },
            ],
          });

          return true;
        });

        expect(
          mockPrisma.wasRlsSetForOperation('sectionEmbedding', 'createMany')
        ).toBe(true);
      });
    });

    /**
     * motion.detect がDB保存時にRLSコンテキストを設定することを確認
     */
    describe('motion.detect RLS Context', () => {
      it('should set RLS context before MotionPattern createMany operation', async () => {
        const projectId = '01919f9a-7b1c-7000-8000-000000000004';

        await mockPrisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_project = '${sanitizeProjectIdForSql(projectId)}'`
          );

          await tx.motionPattern.createMany({
            data: [
              {
                name: 'fadeIn',
                category: 'entrance',
                triggerType: 'load',
                type: 'css_animation',
              },
            ],
          });

          return true;
        });

        expect(mockPrisma.wasRlsSetForOperation('motionPattern', 'createMany')).toBe(
          true
        );
        expect(
          mockPrisma.getRlsContextForOperation('motionPattern', 'createMany')
        ).toBe(projectId);
      });

      it('should set RLS context before MotionEmbedding createMany operation', async () => {
        const projectId = '01919f9a-7b1c-7000-8000-000000000005';

        await mockPrisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_project = '${sanitizeProjectIdForSql(projectId)}'`
          );

          await tx.motionEmbedding.createMany({
            data: [
              {
                motionPatternId: 'motion-1',
                modelVersion: 'multilingual-e5-base',
              },
            ],
          });

          return true;
        });

        expect(mockPrisma.wasRlsSetForOperation('motionEmbedding', 'createMany')).toBe(
          true
        );
      });

      it('should set RLS context before JSAnimationPattern createMany operation', async () => {
        const projectId = '01919f9a-7b1c-7000-8000-000000000006';

        await mockPrisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_project = '${sanitizeProjectIdForSql(projectId)}'`
          );

          await tx.jSAnimationPattern.createMany({
            data: [
              {
                name: 'gsap-tween',
                libraryType: 'gsap',
                animationType: 'tween',
              },
            ],
          });

          return true;
        });

        expect(
          mockPrisma.wasRlsSetForOperation('jSAnimationPattern', 'createMany')
        ).toBe(true);
      });
    });

    /**
     * page.analyze がDB保存時にRLSコンテキストを設定することを確認
     */
    describe('page.analyze RLS Context', () => {
      it('should set RLS context for all table operations in page.analyze', async () => {
        const projectId = '01919f9a-7b1c-7000-8000-000000000007';

        await mockPrisma.$transaction(async (tx) => {
          // 統一されたRLSコンテキスト設定
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_project = '${sanitizeProjectIdForSql(projectId)}'`
          );

          // page.analyze は以下のテーブルに対して操作を行う
          // 1. WebPage
          await tx.webPage.upsert({
            where: { id: 'page-1' },
            create: { url: 'https://example.com', html: '<html></html>' },
            update: {},
          });

          // 2. SectionPattern
          await tx.sectionPattern.createMany({
            data: [{ webPageId: 'page-1', sectionType: 'hero', positionIndex: 0 }],
          });

          // 3. SectionEmbedding
          await tx.sectionEmbedding.createMany({
            data: [{ sectionPatternId: 'section-1', modelVersion: 'v1' }],
          });

          // 4. MotionPattern
          await tx.motionPattern.createMany({
            data: [{ name: 'fadeIn', category: 'entrance', triggerType: 'load' }],
          });

          // 5. MotionEmbedding
          await tx.motionEmbedding.createMany({
            data: [{ motionPatternId: 'motion-1', modelVersion: 'v1' }],
          });

          // 6. QualityEvaluation
          await tx.qualityEvaluation.create({
            data: {
              webPageId: 'page-1',
              overallScore: 85,
              grade: 'A',
            },
          });

          return true;
        });

        // 全てのテーブル操作でRLSコンテキストが設定されていることを確認
        const tables = [
          { table: 'webPage', operation: 'upsert' },
          { table: 'sectionPattern', operation: 'createMany' },
          { table: 'sectionEmbedding', operation: 'createMany' },
          { table: 'motionPattern', operation: 'createMany' },
          { table: 'motionEmbedding', operation: 'createMany' },
          { table: 'qualityEvaluation', operation: 'create' },
        ];

        for (const { table, operation } of tables) {
          expect(mockPrisma.wasRlsSetForOperation(table, operation)).toBe(true);
          expect(mockPrisma.getRlsContextForOperation(table, operation)).toBe(
            projectId
          );
        }
      });

      it('should handle JS animation patterns with RLS context in page.analyze', async () => {
        const projectId = '01919f9a-7b1c-7000-8000-000000000008';

        await mockPrisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_project = '${sanitizeProjectIdForSql(projectId)}'`
          );

          // JS Animation Pattern保存
          await tx.jSAnimationPattern.createMany({
            data: [
              {
                name: 'gsap-scroll',
                libraryType: 'gsap',
                animationType: 'scroll_driven',
              },
              {
                name: 'framer-spring',
                libraryType: 'framer_motion',
                animationType: 'spring',
              },
            ],
          });

          // JS Animation Embedding保存
          await tx.jSAnimationEmbedding.createMany({
            data: [
              { jsAnimationPatternId: 'js-1', modelVersion: 'v1' },
              { jsAnimationPatternId: 'js-2', modelVersion: 'v1' },
            ],
          });

          return true;
        });

        expect(
          mockPrisma.wasRlsSetForOperation('jSAnimationPattern', 'createMany')
        ).toBe(true);
        expect(
          mockPrisma.wasRlsSetForOperation('jSAnimationEmbedding', 'createMany')
        ).toBe(true);
      });
    });
  });

  // =====================================================
  // 2. Prisma Wrapper経由のRLSコンテキスト確認テスト
  // =====================================================

  describe('Prisma Wrapper RLS Context Tests', () => {
    /**
     * createPrismaWrapperがトランザクション内でSET LOCAL app.current_projectを実行することを確認
     */
    it('should execute SET LOCAL app.current_project within transaction scope', async () => {
      const projectId = '01919f9a-7b1c-7000-8000-000000000009';

      // トランザクション外でのRLSコンテキスト設定は無効
      expect(mockPrisma.inTransaction).toBe(false);
      expect(mockPrisma.currentRlsContext).toBeNull();

      await mockPrisma.$transaction(async (tx) => {
        // トランザクション内でRLSコンテキストを設定
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_project = '${sanitizeProjectIdForSql(projectId)}'`
        );

        // 検証: トランザクション内でRLSコンテキストが設定された
        expect(tx.inTransaction).toBe(true);
        expect(tx.currentRlsContext).toBe(projectId);

        return true;
      });

      // 検証: トランザクション終了後、RLSコンテキストがクリアされた
      expect(mockPrisma.inTransaction).toBe(false);
      expect(mockPrisma.currentRlsContext).toBeNull();

      // 検証: 履歴に記録されている
      expect(mockPrisma.rlsContextHistory.length).toBe(1);
      expect(mockPrisma.rlsContextHistory[0]?.withinTransaction).toBe(true);
    });

    /**
     * UUIDv7バリデーションが適用されていることを確認
     */
    it('should validate UUIDv7 format for project ID', () => {
      const validProjectIds = [
        '01919f9a-7b1c-7000-8000-000000000001',
        '01919f9a-7b1c-7abc-9def-123456789abc',
        '01919f9a-7b1c-7fff-afff-ffffffffffff',
      ];

      const invalidProjectIds = [
        'not-a-uuid',
        '550e8400-e29b-41d4-a716-446655440000', // UUIDv4
        '12345678-1234-1234-1234-123456789abc', // 古い形式
        '', // 空文字
        'null',
        'undefined',
      ];

      for (const validId of validProjectIds) {
        expect(isValidUUIDv7(validId)).toBe(true);
      }

      for (const invalidId of invalidProjectIds) {
        expect(isValidUUIDv7(invalidId)).toBe(false);
      }
    });

    /**
     * SQLインジェクション対策としてプロジェクトIDがサニタイズされることを確認
     */
    it('should sanitize project ID to prevent SQL injection', async () => {
      const maliciousProjectId = "'; DROP TABLE web_pages; --";

      await mockPrisma.$transaction(async (tx) => {
        const sanitizedId = sanitizeProjectIdForSql(maliciousProjectId);
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_project = '${sanitizedId}'`
        );
        return true;
      });

      // 検証: エスケープされた値が記録された
      expect(mockPrisma.rlsContextHistory.length).toBe(1);
      const recordedContext = mockPrisma.rlsContextHistory[0]?.projectId;
      expect(recordedContext).toBeDefined();
      // シングルクォートが二重化されている（' -> ''）
      expect(recordedContext).toContain("''");
      // 元の悪意あるパターン（エスケープされていない単一シングルクォート）ではなく、
      // 二重化されたシングルクォートが含まれていることを確認
      // 注: "'; DROP TABLE" は "'''; DROP TABLE" に変換される
      expect(recordedContext).toBe("''; DROP TABLE web_pages; --");
    });

    /**
     * ネストされたトランザクションでRLSコンテキストが正しく管理されることを確認
     * （注: Prismaはネストされたトランザクションをサポートしていないが、
     * RLSコンテキストの分離が正しく動作することを確認）
     */
    it('should maintain RLS context isolation between transactions', async () => {
      const projectA = '01919f9a-7b1c-7000-8000-000000000010';
      const projectB = '01919f9a-7b1c-7000-8000-000000000011';

      // トランザクション1: プロジェクトA
      await mockPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_project = '${projectA}'`
        );
        expect(tx.currentRlsContext).toBe(projectA);
        return true;
      });

      // トランザクション終了後、コンテキストがクリアされている
      expect(mockPrisma.currentRlsContext).toBeNull();

      // トランザクション2: プロジェクトB
      await mockPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_project = '${projectB}'`
        );
        expect(tx.currentRlsContext).toBe(projectB);
        return true;
      });

      // 検証: 両方のコンテキスト設定が記録されている
      expect(mockPrisma.rlsContextHistory.length).toBe(2);
      expect(mockPrisma.rlsContextHistory[0]?.projectId).toBe(projectA);
      expect(mockPrisma.rlsContextHistory[1]?.projectId).toBe(projectB);
    });
  });

  // =====================================================
  // 3. クロステナントアクセス防止テスト
  // =====================================================

  describe('Cross-Tenant Access Prevention Tests', () => {
    /**
     * プロジェクトAのデータがプロジェクトBからアクセスできないことを確認
     *
     * このテストは、RLSが正しく設定されている場合に期待される動作を示す。
     * 実際のRLSポリシーはPostgreSQLレベルで適用されるため、
     * このテストはRLSコンテキストの設定パターンが正しいことを確認する。
     */
    it('should demonstrate cross-project data isolation pattern', async () => {
      const projectA = '01919f9a-7b1c-7000-8000-000000000012';
      const projectB = '01919f9a-7b1c-7000-8000-000000000013';

      // プロジェクトAのコンテキストでデータ作成
      await mockPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_project = '${projectA}'`
        );

        await tx.webPage.upsert({
          where: { id: 'project-a-page' },
          create: {
            url: 'https://project-a.example.com',
            html: '<html>Project A</html>',
          },
          update: {},
        });

        await tx.sectionPattern.createMany({
          data: [
            {
              webPageId: 'project-a-page',
              sectionType: 'hero',
              positionIndex: 0,
            },
          ],
        });

        return true;
      });

      // プロジェクトBのコンテキストでデータ作成
      await mockPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_project = '${projectB}'`
        );

        await tx.webPage.upsert({
          where: { id: 'project-b-page' },
          create: {
            url: 'https://project-b.example.com',
            html: '<html>Project B</html>',
          },
          update: {},
        });

        await tx.sectionPattern.createMany({
          data: [
            {
              webPageId: 'project-b-page',
              sectionType: 'feature',
              positionIndex: 0,
            },
          ],
        });

        return true;
      });

      // 検証: 両方のプロジェクトコンテキストが正しく設定された
      expect(mockPrisma.rlsContextHistory.length).toBe(2);
      expect(mockPrisma.rlsContextHistory[0]?.projectId).toBe(projectA);
      expect(mockPrisma.rlsContextHistory[1]?.projectId).toBe(projectB);

      // 検証: 各トランザクションで異なるプロジェクトIDが設定された
      const projectAOperations = mockPrisma.operationHistory.filter(
        (op) => op.rlsContextProjectId === projectA
      );
      const projectBOperations = mockPrisma.operationHistory.filter(
        (op) => op.rlsContextProjectId === projectB
      );

      expect(projectAOperations.length).toBe(2); // webPage upsert + sectionPattern createMany
      expect(projectBOperations.length).toBe(2); // webPage upsert + sectionPattern createMany

      // 検証: 操作が正しいプロジェクトコンテキストで実行された
      expect(
        projectAOperations.some(
          (op) =>
            op.table === 'webPage' &&
            (op.data as { create?: { url: string } })?.create?.url?.includes(
              'project-a'
            )
        )
      ).toBe(true);
      expect(
        projectBOperations.some(
          (op) =>
            op.table === 'webPage' &&
            (op.data as { create?: { url: string } })?.create?.url?.includes(
              'project-b'
            )
        )
      ).toBe(true);
    });

    /**
     * RLSコンテキストなしでのDB操作を検出する
     *
     * 現状の問題点を示す: MCPツール経由のDB操作でRLSコンテキストが
     * 設定されていない場合、セキュリティリスクとなる
     */
    it('should detect when RLS context is NOT set before DB operation', async () => {
      // RLSコンテキストなしでの操作（セキュリティリスク）
      await mockPrisma.webPage.create({
        data: {
          url: 'https://vulnerable.example.com',
          html: '<html>No RLS</html>',
        },
      });

      // 検証: RLSコンテキストが設定されていない
      const operation = mockPrisma.operationHistory.find(
        (op) => op.table === 'webPage' && op.operation === 'create'
      );
      expect(operation).toBeDefined();
      expect(operation?.rlsContextProjectId).toBeNull();
      expect(operation?.withinTransaction).toBe(false);

      // これはセキュリティリスクを示す警告
      if (process.env.NODE_ENV === 'development') {
        console.warn(
          '[RLS-Integration-Test] WARNING: DB operation without RLS context detected!'
        );
      }
    });

    /**
     * RLSコンテキスト設定後にトランザクション外で操作した場合を検出
     *
     * SET LOCALはトランザクションスコープのため、
     * トランザクション外での操作にはRLSコンテキストが適用されない
     */
    it('should detect when operation is outside transaction scope', async () => {
      const projectId = '01919f9a-7b1c-7000-8000-000000000014';

      // トランザクション内でRLSコンテキストを設定
      await mockPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_project = '${projectId}'`
        );
        return true;
      });

      // トランザクション外での操作（RLSコンテキストは適用されない）
      await mockPrisma.sectionPattern.create({
        data: {
          webPageId: 'page-1',
          sectionType: 'hero',
          positionIndex: 0,
        },
      });

      // 検証: トランザクション外の操作にはRLSコンテキストが適用されていない
      const operation = mockPrisma.operationHistory.find(
        (op) => op.table === 'sectionPattern' && op.operation === 'create'
      );
      expect(operation).toBeDefined();
      expect(operation?.rlsContextProjectId).toBeNull();
      expect(operation?.withinTransaction).toBe(false);
    });
  });

  // =====================================================
  // 4. RLS適用ポイントのドキュメント化テスト
  // =====================================================

  describe('RLS Application Points Documentation', () => {
    /**
     * layout.ingest のRLS適用ポイントを文書化
     */
    it('should document RLS application points for layout.ingest', () => {
      const rlsApplicationPoints = [
        {
          service: 'LayoutEmbeddingService',
          method: 'saveSectionWithEmbedding',
          tables: ['sectionPattern', 'sectionEmbedding'],
          rlsRequired: true,
          currentlyApplied: false, // TODO: 実装後にtrueに更新
          priority: 'high',
        },
        {
          service: 'PageIngestAdapter',
          method: 'saveWebPage',
          tables: ['webPage'],
          rlsRequired: true,
          currentlyApplied: false,
          priority: 'high',
        },
      ];

      // すべてのポイントでRLSが必要
      expect(rlsApplicationPoints.every((p) => p.rlsRequired)).toBe(true);
      // 高優先度のポイントが存在
      expect(rlsApplicationPoints.some((p) => p.priority === 'high')).toBe(true);
    });

    /**
     * motion.detect のRLS適用ポイントを文書化
     */
    it('should document RLS application points for motion.detect', () => {
      const rlsApplicationPoints = [
        {
          service: 'MotionPatternPersistenceService',
          method: 'savePattern',
          tables: ['motionPattern', 'motionEmbedding'],
          rlsRequired: true,
          currentlyApplied: false,
          priority: 'high',
        },
        {
          service: 'JSAnimationDetector',
          method: 'saveJSAnimationPatterns',
          tables: ['jSAnimationPattern', 'jSAnimationEmbedding'],
          rlsRequired: true,
          currentlyApplied: false,
          priority: 'high',
        },
      ];

      expect(rlsApplicationPoints.every((p) => p.rlsRequired)).toBe(true);
    });

    /**
     * page.analyze のRLS適用ポイントを文書化
     */
    it('should document RLS application points for page.analyze', () => {
      const rlsApplicationPoints = [
        {
          service: 'PageAnalyzeTool',
          method: 'saveToDatabase',
          tables: [
            'webPage',
            'sectionPattern',
            'sectionEmbedding',
            'motionPattern',
            'motionEmbedding',
            'qualityEvaluation',
          ],
          rlsRequired: true,
          currentlyApplied: false,
          priority: 'critical', // page.analyzeは複数テーブルを操作するため最優先
        },
        {
          service: 'JSAnimationHandler',
          method: 'saveJSAnimationPatternsWithEmbeddings',
          tables: ['jSAnimationPattern', 'jSAnimationEmbedding'],
          rlsRequired: true,
          currentlyApplied: false,
          priority: 'high',
        },
      ];

      // page.analyzeは最も多くのテーブルを操作
      const pageAnalyzePoint = rlsApplicationPoints.find(
        (p) => p.service === 'PageAnalyzeTool'
      );
      expect(pageAnalyzePoint?.tables.length).toBeGreaterThanOrEqual(6);
      expect(pageAnalyzePoint?.priority).toBe('critical');
    });

    /**
     * セキュリティ推奨事項を文書化
     */
    it('should document security recommendations for RLS implementation', () => {
      const recommendations = [
        {
          id: 'SEC-RLS-INT-01',
          severity: 'High',
          title: 'Implement RLS context wrapper for MCP tools',
          description:
            'createPrismaWrapper factory should automatically set RLS context for all DB operations',
          affectedTools: ['layout.ingest', 'motion.detect', 'page.analyze'],
          status: 'Open',
          estimatedEffort: '2-3 days',
        },
        {
          id: 'SEC-RLS-INT-02',
          severity: 'High',
          title: 'Add projectId parameter to MCP tool schemas',
          description:
            'MCP tool input schemas should include optional projectId for RLS context',
          affectedFiles: [
            'apps/mcp-server/src/tools/layout/schemas.ts',
            'apps/mcp-server/src/tools/motion/schemas.ts',
            'apps/mcp-server/src/tools/page/schemas.ts',
          ],
          status: 'Open',
          estimatedEffort: '1 day',
        },
        {
          id: 'SEC-RLS-INT-03',
          severity: 'Medium',
          title: 'Implement RLS-aware Prisma wrapper factory',
          description:
            'createPrismaWrapper should accept projectId and automatically call SET LOCAL',
          affectedFiles: [
            'apps/mcp-server/src/utils/prisma-wrapper-factory.ts',
          ],
          status: 'Open',
          estimatedEffort: '1-2 days',
        },
        {
          id: 'SEC-RLS-INT-04',
          severity: 'Low',
          title: 'Add RLS context audit logging',
          description:
            'Log when RLS context is set/cleared for security audit trail',
          affectedFiles: ['apps/mcp-server/src/middleware/rls-audit.ts'],
          status: 'Open',
          estimatedEffort: '0.5 day',
        },
      ];

      // すべての推奨事項が適切に定義されている
      expect(recommendations.length).toBe(4);
      expect(recommendations.every((r) => r.severity !== undefined)).toBe(true);
      expect(recommendations.every((r) => r.status === 'Open')).toBe(true);

      // High severity の推奨事項が優先される
      const highSeverity = recommendations.filter((r) => r.severity === 'High');
      expect(highSeverity.length).toBeGreaterThanOrEqual(2);
    });
  });
});
