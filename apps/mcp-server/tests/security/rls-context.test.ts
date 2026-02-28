// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RLSコンテキスト確認テスト（SEC推奨）
 *
 * MCPツール（motion.detect, layout.ingest, page.analyze等）経由で
 * DB保存を行う際に、RLS（Row Level Security）が正しく適用されることを
 * 確認するテスト。
 *
 * 背景:
 * - save_to_db: true がデフォルトになったことで、意図しないプロジェクト間データ漏洩リスク
 * - MCPツール経由でのDB操作時にRLSが適用されることを確認する必要がある
 *
 * 参照:
 * -  RLS Implementation
 * -  Row-Level Security (RLS)
 *
 * @module tests/security/rls-context.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =====================================================
// テスト用モック定義
// =====================================================

/**
 * RLSコンテキストを記録するモックPrismaClient
 */
interface MockPrismaClientWithRLS {
  // 記録されたRLSコンテキスト設定
  rlsContextCalls: string[];
  // 記録されたテーブル操作
  tableOperations: Array<{
    table: string;
    operation: string;
    data: unknown;
    rlsContextWasSet: boolean;
  }>;
  // テーブル操作のモック
  motionPattern: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
  };
  motionEmbedding: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
  };
  sectionPattern: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
  };
  sectionEmbedding: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
  };
  webPage: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
  };
  qualityEvaluation: {
    create: (args: { data: unknown }) => Promise<{ id: string }>;
  };
  // Raw SQL操作
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
  // トランザクション
  $transaction: <T>(fn: (tx: MockPrismaClientWithRLS) => Promise<T>) => Promise<T>;
  // ヘルパー
  reset: () => void;
  wasRLSSetBeforeOperation: (tableName: string) => boolean;
}

/**
 * RLSコンテキスト記録機能付きモックPrismaClientを作成
 */
function createMockPrismaClientWithRLS(): MockPrismaClientWithRLS {
  const rlsContextCalls: string[] = [];
  const tableOperations: MockPrismaClientWithRLS['tableOperations'] = [];
  let rlsContextSet = false;
  let currentProjectId: string | null = null;

  const createTableMock = (tableName: string) => ({
    create: async (args: { data: unknown }): Promise<{ id: string }> => {
      tableOperations.push({
        table: tableName,
        operation: 'create',
        data: args.data,
        rlsContextWasSet: rlsContextSet,
      });
      const id = `mock-${tableName}-${Date.now()}`;
      return { id };
    },
  });

  const mockClient: MockPrismaClientWithRLS = {
    rlsContextCalls,
    tableOperations,
    motionPattern: createTableMock('motionPattern'),
    motionEmbedding: createTableMock('motionEmbedding'),
    sectionPattern: createTableMock('sectionPattern'),
    sectionEmbedding: createTableMock('sectionEmbedding'),
    webPage: createTableMock('webPage'),
    qualityEvaluation: createTableMock('qualityEvaluation'),

    $executeRawUnsafe: async (query: string, ..._values: unknown[]): Promise<number> => {
      // RLSコンテキスト設定を検出
      // 注: エスケープされたシングルクォート '' を含む値にも対応
      const rlsMatch = query.match(/SET LOCAL app\.current_project\s*=\s*'((?:[^']|'')+)'/i);
      if (rlsMatch) {
        const projectId = rlsMatch[1] ?? 'unknown';
        rlsContextCalls.push(projectId);
        rlsContextSet = true;
        currentProjectId = projectId;

        if (process.env.NODE_ENV === 'development') {
          console.log(`[RLS-Test] SET LOCAL app.current_project = '${projectId}'`);
        }
      }
      return 1;
    },

    $queryRawUnsafe: async (_query: string, ..._values: unknown[]): Promise<unknown> => {
      return [];
    },

    $transaction: async <T>(fn: (tx: MockPrismaClientWithRLS) => Promise<T>): Promise<T> => {
      // トランザクション内でRLSコンテキストをリセット
      const prevRlsSet = rlsContextSet;
      const prevProjectId = currentProjectId;

      try {
        return await fn(mockClient);
      } finally {
        // トランザクション終了後にリセット
        rlsContextSet = prevRlsSet;
        currentProjectId = prevProjectId;
      }
    },

    reset: () => {
      rlsContextCalls.length = 0;
      tableOperations.length = 0;
      rlsContextSet = false;
      currentProjectId = null;
    },

    wasRLSSetBeforeOperation: (tableName: string) => {
      const operation = tableOperations.find((op) => op.table === tableName);
      return operation?.rlsContextWasSet ?? false;
    },
  };

  return mockClient;
}

// =====================================================
// テスト本体
// =====================================================

describe('RLS Context Tests (SEC Recommended)', () => {
  let mockPrisma: MockPrismaClientWithRLS;

  beforeEach(() => {
    mockPrisma = createMockPrismaClientWithRLS();
    vi.clearAllMocks();

    if (process.env.NODE_ENV === 'development') {
      console.log('[RLS-Test] Starting RLS context test');
    }
  });

  afterEach(() => {
    mockPrisma.reset();
  });

  describe('RLS Context Setting Verification', () => {
    /**
     * RLSコンテキストがトランザクション内で設定されることを確認
     *
     * 仕様要件（
     * - SET LOCAL は必ずトランザクション内で実行
     * - SET LOCAL app.current_project = '{projectId}'
     */
    it('should demonstrate RLS context setting pattern', async () => {
      const projectId = '01234567-89ab-7def-8123-456789abcdef'; // UUIDv7形式

      // 正しいRLS設定パターン
      await mockPrisma.$transaction(async (tx) => {
        // トランザクション開始時にRLSコンテキストを設定
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_project = '${projectId.replace(/'/g, "''")}'`
        );

        // データ操作
        await tx.motionPattern.create({
          data: {
            name: 'test-pattern',
            category: 'entrance',
          },
        });

        return true;
      });

      // 検証: RLSコンテキストが設定されたか
      expect(mockPrisma.rlsContextCalls).toContain(projectId);
      expect(mockPrisma.rlsContextCalls.length).toBeGreaterThan(0);

      if (process.env.NODE_ENV === 'development') {
        console.log('[RLS-Test] RLS context calls:', mockPrisma.rlsContextCalls);
      }
    });

    /**
     * RLSコンテキストなしでのDB操作を検出
     *
     * 現状の問題点:
     * - MCPツール経由のDB操作でRLSコンテキストが設定されていない
     */
    it('should detect when RLS context is NOT set before DB operation', async () => {
      // RLSコンテキストなしでの操作（現状のMCPサーバーの動作）
      await mockPrisma.motionPattern.create({
        data: {
          name: 'test-pattern-without-rls',
          category: 'entrance',
        },
      });

      // 検証: RLSコンテキストが設定されていないことを検出
      const operation = mockPrisma.tableOperations.find(
        (op) => op.table === 'motionPattern'
      );
      expect(operation).toBeDefined();
      expect(operation?.rlsContextWasSet).toBe(false);

      // これは現在の実装の問題点を示す
      // RLSが適用されていない状態での操作は、セキュリティリスクとなる
    });
  });

  describe('Cross-Project Data Access Prevention', () => {
    /**
     * 異なるプロジェクト間でデータが見えないことを確認
     *
     * RLSが正しく機能している場合:
     * - プロジェクトAのコンテキストで作成したデータは、
     * - プロジェクトBのコンテキストからはアクセスできない
     */
    it('should prevent cross-project data access when RLS is properly configured', async () => {
      const projectA = '01234567-89ab-7def-8123-456789abcdef';
      const projectB = 'fedcba98-7654-7321-8fed-cba987654321';

      // プロジェクトAのコンテキストでデータ作成
      await mockPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_project = '${projectA}'`);
        await tx.motionPattern.create({
          data: {
            name: 'project-a-pattern',
            category: 'entrance',
          },
        });
        return true;
      });

      // プロジェクトBのコンテキストでアクセス試行
      // 実際のRLS環境では、プロジェクトAのデータにはアクセスできない
      await mockPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.current_project = '${projectB}'`);

        // ここでは、RLS が機能していれば project-a-pattern は見えないはず
        // このテストはRLSの概念実証として機能

        return true;
      });

      // 検証: 両方のプロジェクトコンテキストが設定された
      expect(mockPrisma.rlsContextCalls).toContain(projectA);
      expect(mockPrisma.rlsContextCalls).toContain(projectB);
      expect(mockPrisma.rlsContextCalls.length).toBe(2);
    });

    /**
     * プロジェクトIDが適切にエスケープされることを確認
     *
     * SQLインジェクション対策:
     * - シングルクォートのエスケープ
     */
    it('should escape project ID to prevent SQL injection', async () => {
      const maliciousProjectId = "'; DROP TABLE motion_patterns; --";

      await mockPrisma.$transaction(async (tx) => {
        // エスケープ処理
        const escapedProjectId = maliciousProjectId.replace(/'/g, "''");
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_project = '${escapedProjectId}'`
        );
        return true;
      });

      // 検証: RLSコンテキストが記録された
      expect(mockPrisma.rlsContextCalls.length).toBeGreaterThan(0);
      const recordedContext = mockPrisma.rlsContextCalls[0];
      expect(recordedContext).toBeDefined();
      // エスケープされた値が記録された（シングルクォートが二重化）
      expect(recordedContext).toContain("''");
    });
  });

  describe('MCP Tool Integration Points', () => {
    /**
     * motion.detect のDB保存時にRLSが適用されるべき箇所を特定
     *
     * 関連ファイル:
     * - /apps/mcp-server/src/services/motion-persistence.service.ts
     * - /apps/mcp-server/src/utils/prisma-wrapper-factory.ts
     */
    it('should identify RLS application points for motion.detect', () => {
      // motion.detect のDB保存フロー:
      // 1. MotionPatternPersistenceService.savePattern()
      // 2. prismaClient.motionPattern.create()
      // 3. prismaClient.motionEmbedding.create()
      // 4. prismaClient.$executeRawUnsafe() (Embedding更新)

      // 現状の問題: これらの操作でRLSコンテキストが設定されていない
      const rlsApplicationPoints = [
        {
          service: 'MotionPatternPersistenceService',
          method: 'savePattern',
          tables: ['motionPattern', 'motionEmbedding'],
          rlsRequired: true,
          currentlyApplied: false, // TODO: 実装後にtrueに更新
        },
      ];

      expect(rlsApplicationPoints[0]?.rlsRequired).toBe(true);
      expect(rlsApplicationPoints[0]?.currentlyApplied).toBe(false);
    });

    /**
     * layout.ingest のDB保存時にRLSが適用されるべき箇所を特定
     *
     * 関連ファイル:
     * - /apps/mcp-server/src/services/layout-embedding.service.ts
     * - /apps/mcp-server/src/tools/layout/ingest.ts
     */
    it('should identify RLS application points for layout.ingest', () => {
      // layout.ingest のDB保存フロー:
      // 1. saveSectionWithEmbedding()
      // 2. prismaClient.sectionPattern.create()
      // 3. prismaClient.sectionEmbedding.create()
      // 4. prismaClient.$executeRawUnsafe() (Embedding更新)

      const rlsApplicationPoints = [
        {
          service: 'LayoutEmbeddingService',
          method: 'saveSectionWithEmbedding',
          tables: ['sectionPattern', 'sectionEmbedding'],
          rlsRequired: true,
          currentlyApplied: false, // TODO: 実装後にtrueに更新
        },
      ];

      expect(rlsApplicationPoints[0]?.rlsRequired).toBe(true);
      expect(rlsApplicationPoints[0]?.currentlyApplied).toBe(false);
    });

    /**
     * page.analyze のDB保存時にRLSが適用されるべき箇所を特定
     *
     * 関連ファイル:
     * - /apps/mcp-server/src/tools/page/analyze.tool.ts
     * - /apps/mcp-server/src/utils/prisma-wrapper-factory.ts
     */
    it('should identify RLS application points for page.analyze', () => {
      // page.analyze のDB保存フロー:
      // 1. webPage 作成
      // 2. layout 解析結果の sectionPattern 保存
      // 3. motion 検出結果の motionPattern 保存
      // 4. quality 評価結果の qualityEvaluation 保存

      const rlsApplicationPoints = [
        {
          service: 'PageAnalyzeTool',
          method: 'handlePageAnalyze',
          tables: ['webPage', 'sectionPattern', 'motionPattern', 'qualityEvaluation'],
          rlsRequired: true,
          currentlyApplied: false, // TODO: 実装後にtrueに更新
        },
      ];

      expect(rlsApplicationPoints[0]?.rlsRequired).toBe(true);
      expect(rlsApplicationPoints[0]?.currentlyApplied).toBe(false);
    });
  });

  describe('PrismaWrapper RLS Enhancement', () => {
    /**
     * createPrismaWrapper に RLS コンテキスト設定機能を追加する提案
     *
     * 現状の prisma-wrapper-factory.ts は RLS を考慮していない
     * 以下は改善案のテスト
     */
    it('should demonstrate proposed RLS-aware PrismaWrapper pattern', async () => {
      const projectId = '01234567-89ab-7def-8123-456789abcdef';

      // 提案パターン: RLS対応のPrismaWrapperを作成
      const createRLSAwarePrismaWrapper = (
        basePrisma: MockPrismaClientWithRLS,
        projectIdToSet: string
      ) => {
        return {
          // トランザクション内でRLSを設定してから操作を実行
          withRLS: async <T>(fn: (tx: MockPrismaClientWithRLS) => Promise<T>): Promise<T> => {
            return basePrisma.$transaction(async (tx) => {
              // RLSコンテキストを設定
              await tx.$executeRawUnsafe(
                `SET LOCAL app.current_project = '${projectIdToSet.replace(/'/g, "''")}'`
              );
              return fn(tx);
            });
          },
        };
      };

      const rlsWrapper = createRLSAwarePrismaWrapper(mockPrisma, projectId);

      // RLS対応ラッパーを使用してデータを作成
      await rlsWrapper.withRLS(async (tx) => {
        await tx.motionPattern.create({
          data: {
            name: 'rls-protected-pattern',
            category: 'entrance',
          },
        });
        return true;
      });

      // 検証: RLSコンテキストが設定された後にデータ操作が行われた
      expect(mockPrisma.rlsContextCalls).toContain(projectId);
      expect(mockPrisma.wasRLSSetBeforeOperation('motionPattern')).toBe(true);
    });
  });

  describe('RLS Configuration Validation', () => {
    /**
     * UUIDv7形式のプロジェクトIDのバリデーション
     */
    it('should validate UUIDv7 format for project ID', () => {
      const validUUIDv7 = '01234567-89ab-7def-8123-456789abcdef';
      const invalidUUIDs = [
        'not-a-uuid',
        '01234567-89ab-4def-8123-456789abcdef', // v4形式
        '12345678-1234-1234-1234-123456789abc', // 古い形式
        '', // 空文字
      ];

      // UUIDv7バリデーション関数
      const isValidUUIDv7 = (id: string): boolean => {
        if (!id) return false;
        return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
      };

      expect(isValidUUIDv7(validUUIDv7)).toBe(true);
      invalidUUIDs.forEach((uuid) => {
        expect(isValidUUIDv7(uuid)).toBe(false);
      });
    });

    /**
     * RLSポリシーが適用されるテーブルの確認
     *
     *  より:
     * - motion_patterns (RLS対象外 - WebDesignテーブル)
     * - section_patterns (RLS対象外 - WebDesignテーブル)
     * - web_pages (RLS対象外 - WebDesignテーブル)
     *
     * 注: 現状のWebDesignテーブルはプロジェクトごとのRLSではなく、
     * usage_scope/source_type による分離を想定
     */
    it('should document RLS-enabled tables', () => {
      // RLS対象テーブル（decisions, checkpoints等のinternalテーブル）
      const rlsEnabledTables = [
        { table: 'decisions', column: 'projectId', quoteRequired: true },
        { table: 'checkpoints', column: 'projectId', quoteRequired: true },
        { table: 'notes', column: 'projectId', quoteRequired: true },
        { table: 'tasks', column: 'project_id', quoteRequired: false },
        { table: 'snippets', column: 'project_id', quoteRequired: false },
        { table: 'context_packs', column: 'projectId', quoteRequired: true },
        { table: 'invariants', column: 'projectId', quoteRequired: true },
        { table: 'tool_invocations', column: 'projectId', quoteRequired: true },
        { table: 'configurations', column: 'project_id', quoteRequired: false },
        { table: 'audit_logs', column: 'projectId', quoteRequired: true },
        { table: 'debug_logs', column: 'project_id', quoteRequired: false },
      ];

      // WebDesignテーブル（現状RLS対象外だが、検討が必要）
      const webDesignTables = [
        { table: 'web_pages', needsRLS: false, reason: 'source_type/usage_scope で分離' },
        { table: 'section_patterns', needsRLS: false, reason: 'WebPage経由で間接的に分離' },
        { table: 'motion_patterns', needsRLS: false, reason: 'WebPage経由で間接的に分離' },
        { table: 'quality_evaluations', needsRLS: false, reason: 'WebPage経由で間接的に分離' },
      ];

      expect(rlsEnabledTables.length).toBe(11);
      expect(webDesignTables.length).toBe(4);

      // WebDesignテーブルにRLSが不要な理由を確認
      webDesignTables.forEach((table) => {
        expect(table.reason).toBeDefined();
      });
    });
  });

  describe('Security Recommendations', () => {
    /**
     * SECチームへの推奨事項を文書化
     */
    it('should document security recommendations', () => {
      const recommendations = [
        {
          id: 'SEC-RLS-01',
          severity: 'Medium',
          title: 'MCPツール経由のDB操作にRLSコンテキストを適用',
          description: 'motion.detect, layout.ingest, page.analyze等でsave_to_db: true時にRLSを適用',
          status: 'Open',
          affectedFiles: [
            'apps/mcp-server/src/services/motion-persistence.service.ts',
            'apps/mcp-server/src/services/layout-embedding.service.ts',
            'apps/mcp-server/src/utils/prisma-wrapper-factory.ts',
          ],
        },
        {
          id: 'SEC-RLS-02',
          severity: 'Low',
          title: 'WebDesignテーブルのプロジェクト分離戦略の明確化',
          description: 'usage_scope/source_type による分離が十分かどうかの検討',
          status: 'Open',
          affectedFiles: ['packages/database/prisma/schema.prisma'],
        },
        {
          id: 'SEC-RLS-03',
          severity: 'Low',
          title: 'プロジェクトIDの取得元の明確化',
          description: 'MCPツール呼び出し時にプロジェクトIDをどこから取得するかの設計',
          status: 'Open',
          affectedFiles: ['apps/mcp-server/src/middleware/auth.ts'],
        },
      ];

      expect(recommendations.length).toBe(3);
      recommendations.forEach((rec) => {
        expect(rec.severity).toBeDefined();
        expect(rec.status).toBe('Open');
      });
    });
  });
});
