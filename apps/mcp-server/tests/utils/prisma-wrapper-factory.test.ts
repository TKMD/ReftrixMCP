// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prisma Wrapper Factory ユニットテスト
 *
 * 目的:
 * - createTableWrapper: 単一テーブルラッパー生成
 * - createPrismaWrapper: IPrismaClient互換ラッパー生成
 * - トランザクションサポート
 *
 * テスト対象: apps/mcp-server/src/utils/prisma-wrapper-factory.ts
 *
 * 制約:
 * - DB接続不要（すべてモック）
 * - Prismaクライアントをモックして検証
 *
 * @module tests/utils/prisma-wrapper-factory
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTableWrapper,
  createPrismaWrapper,
  type SupportedTableName,
  type PrismaWrapperConfig,
} from '../../src/utils/prisma-wrapper-factory';

// =============================================================================
// モック用型定義
// =============================================================================

/**
 * モックテーブルの型
 */
interface MockTable {
  create: ReturnType<typeof vi.fn>;
  createMany?: ReturnType<typeof vi.fn>;
  upsert?: ReturnType<typeof vi.fn>;
  deleteMany?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
  findMany?: ReturnType<typeof vi.fn>;
}

/**
 * モックPrismaクライアントの型
 */
interface MockPrismaClient {
  sectionPattern?: MockTable;
  sectionEmbedding?: MockTable;
  motionPattern?: MockTable;
  motionEmbedding?: MockTable;
  motionAnalysisResult?: MockTable;
  motionAnalysisEmbedding?: MockTable;
  webPage?: MockTable;
  qualityEvaluation?: MockTable;
  qualityBenchmark?: MockTable;
  jSAnimationPattern?: MockTable;
  jSAnimationEmbedding?: MockTable;
  $executeRawUnsafe: ReturnType<typeof vi.fn>;
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
  $transaction?: ReturnType<typeof vi.fn>;
}

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * 完全なモックテーブルを作成
 */
function createMockTable(): MockTable {
  return {
    create: vi.fn().mockResolvedValue({ id: 'mock-id-123' }),
    createMany: vi.fn().mockResolvedValue({ count: 5 }),
    upsert: vi.fn().mockResolvedValue({ id: 'mock-upsert-id' }),
    deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
    findUnique: vi.fn().mockResolvedValue({ id: 'mock-id', name: 'test' }),
    findMany: vi.fn().mockResolvedValue([{ id: 'item-1' }, { id: 'item-2' }]),
  };
}

/**
 * createのみのモックテーブルを作成（最小構成）
 */
function createMinimalMockTable(): MockTable {
  return {
    create: vi.fn().mockResolvedValue({ id: 'minimal-id' }),
  };
}

/**
 * モックPrismaクライアントを作成
 */
function createMockPrismaClient(options?: {
  withTransaction?: boolean;
  tables?: SupportedTableName[];
}): MockPrismaClient {
  const client: MockPrismaClient = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };

  // デフォルトテーブル
  const tables = options?.tables ?? ['sectionPattern', 'sectionEmbedding'];
  tables.forEach((tableName) => {
    (client as Record<string, unknown>)[tableName] = createMockTable();
  });

  // トランザクションサポート
  if (options?.withTransaction) {
    client.$transaction = vi.fn().mockImplementation(async (fn) => {
      // トランザクション内で新しいモッククライアントを使用
      const txClient = createMockPrismaClient({ tables });
      return fn(txClient);
    });
  }

  return client;
}

// =============================================================================
// createTableWrapper テスト
// =============================================================================

describe('createTableWrapper - 単一テーブルラッパー生成', () => {
  describe('正常系', () => {
    it('createメソッドが正しくラップされること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({ tables: ['sectionPattern'] });
      const tableName: SupportedTableName = 'sectionPattern';

      // Act
      const wrapper = createTableWrapper(mockClient, tableName);
      const result = await wrapper.create({ data: { name: 'test' } });

      // Assert
      expect(result).toEqual({ id: 'mock-id-123' });
      expect(mockClient.sectionPattern?.create).toHaveBeenCalledWith({
        data: { name: 'test' },
      });
    });

    it('createManyメソッドが正しくラップされること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({ tables: ['motionPattern'] });

      // Act
      const wrapper = createTableWrapper(mockClient, 'motionPattern');
      const result = await wrapper.createMany?.({
        data: [{ name: 'item1' }, { name: 'item2' }],
      });

      // Assert
      expect(result).toEqual({ count: 5 });
      expect(mockClient.motionPattern?.createMany).toHaveBeenCalled();
    });

    it('upsertメソッドが正しくラップされること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({ tables: ['webPage'] });

      // Act
      const wrapper = createTableWrapper(mockClient, 'webPage');
      const result = await wrapper.upsert?.({
        where: { id: 'existing-id' },
        create: { url: 'https://example.com' },
        update: { url: 'https://updated.com' },
      });

      // Assert
      expect(result).toEqual({ id: 'mock-upsert-id' });
      expect(mockClient.webPage?.upsert).toHaveBeenCalled();
    });

    it('deleteManyメソッドが正しくラップされること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['qualityEvaluation'],
      });

      // Act
      const wrapper = createTableWrapper(mockClient, 'qualityEvaluation');
      const result = await wrapper.deleteMany?.({
        where: { webPageId: 'page-id' },
      });

      // Assert
      expect(result).toEqual({ count: 3 });
      expect(mockClient.qualityEvaluation?.deleteMany).toHaveBeenCalled();
    });

    it('findUniqueメソッドが正しくラップされること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['qualityBenchmark'],
      });

      // Act
      const wrapper = createTableWrapper(mockClient, 'qualityBenchmark');
      const result = await wrapper.findUnique?.({
        where: { id: 'benchmark-id' },
      });

      // Assert
      expect(result).toEqual({ id: 'mock-id', name: 'test' });
      expect(mockClient.qualityBenchmark?.findUnique).toHaveBeenCalled();
    });

    it('findManyメソッドが正しくラップされること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['jSAnimationPattern'],
      });

      // Act
      const wrapper = createTableWrapper(mockClient, 'jSAnimationPattern');
      const result = await wrapper.findMany?.({
        where: { libraryType: 'gsap' },
      });

      // Assert
      expect(result).toEqual([{ id: 'item-1' }, { id: 'item-2' }]);
      expect(mockClient.jSAnimationPattern?.findMany).toHaveBeenCalled();
    });
  });

  describe('サポートされているテーブル', () => {
    const supportedTables: SupportedTableName[] = [
      'sectionPattern',
      'sectionEmbedding',
      'motionPattern',
      'motionEmbedding',
      'motionAnalysisResult',
      'motionAnalysisEmbedding',
      'webPage',
      'qualityEvaluation',
      'qualityBenchmark',
      'jSAnimationPattern',
      'jSAnimationEmbedding',
    ];

    supportedTables.forEach((tableName) => {
      it(`${tableName}テーブルのラッパーが作成できること`, () => {
        // Arrange
        const mockClient = createMockPrismaClient({ tables: [tableName] });

        // Act & Assert
        expect(() => createTableWrapper(mockClient, tableName)).not.toThrow();
      });
    });
  });

  describe('最小構成テーブル', () => {
    it('createのみのテーブルでもラッパーが作成できること', async () => {
      // Arrange
      const mockClient: MockPrismaClient = {
        sectionPattern: createMinimalMockTable(),
        $executeRawUnsafe: vi.fn(),
        $queryRawUnsafe: vi.fn(),
      };

      // Act
      const wrapper = createTableWrapper(mockClient, 'sectionPattern');
      const result = await wrapper.create({ data: { name: 'test' } });

      // Assert
      expect(result).toEqual({ id: 'minimal-id' });
      expect(wrapper.createMany).toBeUndefined();
      expect(wrapper.upsert).toBeUndefined();
      expect(wrapper.deleteMany).toBeUndefined();
    });
  });

  describe('異常系', () => {
    it('存在しないテーブルでエラーがスローされること', () => {
      // Arrange
      const mockClient = createMockPrismaClient({ tables: ['sectionPattern'] });

      // Act & Assert
      expect(() =>
        createTableWrapper(mockClient, 'motionPattern')
      ).toThrowError("Table 'motionPattern' not found in PrismaClient");
    });
  });
});

// =============================================================================
// createPrismaWrapper テスト
// =============================================================================

describe('createPrismaWrapper - IPrismaClient互換ラッパー生成', () => {
  describe('正常系', () => {
    it('複数テーブルのラッパーが生成されること', () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['sectionPattern', 'sectionEmbedding', 'motionPattern'],
      });
      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern', 'sectionEmbedding', 'motionPattern'],
        supportsTransaction: false,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);

      // Assert
      expect(wrapper.sectionPattern).toBeDefined();
      expect(wrapper.sectionEmbedding).toBeDefined();
      expect(wrapper.motionPattern).toBeDefined();
    });

    it('$executeRawUnsafeがバインドされること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({ tables: ['sectionPattern'] });
      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern'],
        supportsTransaction: false,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);
      await (wrapper.$executeRawUnsafe as Function)(
        'SELECT 1',
        'param1',
        'param2'
      );

      // Assert
      expect(mockClient.$executeRawUnsafe).toHaveBeenCalledWith(
        'SELECT 1',
        'param1',
        'param2'
      );
    });

    it('$queryRawUnsafeがバインドされること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({ tables: ['sectionPattern'] });
      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern'],
        supportsTransaction: false,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);
      await (wrapper.$queryRawUnsafe as Function)('SELECT * FROM test');

      // Assert
      expect(mockClient.$queryRawUnsafe).toHaveBeenCalledWith(
        'SELECT * FROM test'
      );
    });
  });

  describe('トランザクションサポート', () => {
    it('supportsTransaction=falseの場合、$transactionが存在しないこと', () => {
      // Arrange
      const mockClient = createMockPrismaClient({ tables: ['sectionPattern'] });
      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern'],
        supportsTransaction: false,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);

      // Assert
      expect(wrapper.$transaction).toBeUndefined();
    });

    it('supportsTransaction=trueの場合、$transactionが存在すること', () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['motionPattern'],
        withTransaction: true,
      });
      const config: PrismaWrapperConfig = {
        tables: ['motionPattern'],
        supportsTransaction: true,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);

      // Assert
      expect(wrapper.$transaction).toBeDefined();
      expect(typeof wrapper.$transaction).toBe('function');
    });

    it('トランザクション内でテーブル操作ができること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['motionPattern', 'motionEmbedding'],
        withTransaction: true,
      });
      const config: PrismaWrapperConfig = {
        tables: ['motionPattern', 'motionEmbedding'],
        supportsTransaction: true,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);
      let txWrapperReceived: Record<string, unknown> | null = null;

      await (wrapper.$transaction as Function)(async (txWrapper: Record<string, unknown>) => {
        txWrapperReceived = txWrapper;
        return 'transaction-result';
      });

      // Assert
      expect(txWrapperReceived).not.toBeNull();
      expect(txWrapperReceived!.motionPattern).toBeDefined();
      expect(txWrapperReceived!.motionEmbedding).toBeDefined();
      expect(txWrapperReceived!.$executeRawUnsafe).toBeDefined();
      expect(txWrapperReceived!.$queryRawUnsafe).toBeDefined();
    });

    it('ネストされたトランザクションがエラーになること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['sectionPattern'],
        withTransaction: true,
      });
      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern'],
        supportsTransaction: true,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);

      // Assert
      await (wrapper.$transaction as Function)(async (txWrapper: Record<string, unknown>) => {
        await expect(
          (txWrapper.$transaction as Function)(async () => {})
        ).rejects.toThrowError('Nested transactions not supported');
      });
    });

    it('$transaction非対応クライアントでエラーがスローされること', async () => {
      // Arrange
      const mockClient: MockPrismaClient = {
        sectionPattern: createMockTable(),
        $executeRawUnsafe: vi.fn(),
        $queryRawUnsafe: vi.fn(),
        // $transactionが存在しない
      };
      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern'],
        supportsTransaction: true,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);

      // Assert
      await expect(
        (wrapper.$transaction as Function)(async () => {})
      ).rejects.toThrowError('PrismaClient does not support transactions');
    });
  });

  describe('Layout用設定（トランザクションなし）', () => {
    it('Layout用ラッパーが正しく生成されること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['sectionPattern', 'sectionEmbedding'],
      });
      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern', 'sectionEmbedding'],
        supportsTransaction: false,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);

      // Assert
      expect(wrapper.sectionPattern).toBeDefined();
      expect(wrapper.sectionEmbedding).toBeDefined();
      expect(wrapper.$transaction).toBeUndefined();

      // テーブル操作
      const createResult = await (
        wrapper.sectionPattern as { create: Function }
      ).create({
        data: { type: 'hero', html_snippet: '<div>' },
      });
      expect(createResult).toEqual({ id: 'mock-id-123' });
    });
  });

  describe('Motion用設定（トランザクションあり）', () => {
    it('Motion用ラッパーが正しく生成されること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['motionPattern', 'motionEmbedding'],
        withTransaction: true,
      });
      const config: PrismaWrapperConfig = {
        tables: ['motionPattern', 'motionEmbedding'],
        supportsTransaction: true,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);

      // Assert
      expect(wrapper.motionPattern).toBeDefined();
      expect(wrapper.motionEmbedding).toBeDefined();
      expect(wrapper.$transaction).toBeDefined();
    });
  });

  describe('JSAnimationPattern用設定', () => {
    it('JSAnimation用ラッパーが正しく生成されること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['jSAnimationPattern', 'jSAnimationEmbedding'],
        withTransaction: true,
      });
      const config: PrismaWrapperConfig = {
        tables: ['jSAnimationPattern', 'jSAnimationEmbedding'],
        supportsTransaction: true,
      };

      // Act
      const wrapper = createPrismaWrapper(mockClient, config);

      // Assert
      expect(wrapper.jSAnimationPattern).toBeDefined();
      expect(wrapper.jSAnimationEmbedding).toBeDefined();
    });
  });
});

// =============================================================================
// 統合テスト: 実際のユースケース
// =============================================================================

describe('実際のユースケース', () => {
  describe('セクション保存フロー', () => {
    it('SectionPatternとSectionEmbeddingを連続して保存できること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['sectionPattern', 'sectionEmbedding'],
      });
      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern', 'sectionEmbedding'],
        supportsTransaction: false,
      };
      const wrapper = createPrismaWrapper(mockClient, config);

      // Act
      const patternResult = await (
        wrapper.sectionPattern as { create: Function }
      ).create({
        data: {
          type: 'hero',
          html_snippet: '<section class="hero">...</section>',
          web_page_id: 'page-123',
        },
      });

      const embeddingResult = await (
        wrapper.sectionEmbedding as { create: Function }
      ).create({
        data: {
          section_pattern_id: patternResult.id,
          embedding: Array(768).fill(0.1),
          text_representation: 'hero section with...',
        },
      });

      // Assert
      expect(patternResult.id).toBe('mock-id-123');
      expect(embeddingResult.id).toBe('mock-id-123');
    });
  });

  describe('モーション保存フロー（トランザクション）', () => {
    it('トランザクション内でMotionPatternとEmbeddingを保存できること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['motionPattern', 'motionEmbedding'],
        withTransaction: true,
      });
      const config: PrismaWrapperConfig = {
        tables: ['motionPattern', 'motionEmbedding'],
        supportsTransaction: true,
      };
      const wrapper = createPrismaWrapper(mockClient, config);

      // Act
      const result = await (wrapper.$transaction as Function)(
        async (tx: Record<string, unknown>) => {
          const pattern = await (tx.motionPattern as { create: Function }).create({
            data: {
              name: 'fadeIn',
              type: 'keyframe',
              duration: 300,
            },
          });

          const embedding = await (tx.motionEmbedding as { create: Function }).create({
            data: {
              motion_pattern_id: pattern.id,
              embedding: Array(768).fill(0.05),
            },
          });

          return { pattern, embedding };
        }
      );

      // Assert
      expect(result.pattern.id).toBeDefined();
      expect(result.embedding.id).toBeDefined();
    });
  });

  describe('ベクトル検索クエリ', () => {
    it('$queryRawUnsafeでベクトル検索ができること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['sectionPattern', 'sectionEmbedding'],
      });
      mockClient.$queryRawUnsafe.mockResolvedValue([
        { id: 'result-1', similarity: 0.95 },
        { id: 'result-2', similarity: 0.89 },
      ]);

      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern', 'sectionEmbedding'],
        supportsTransaction: false,
      };
      const wrapper = createPrismaWrapper(mockClient, config);

      // Act
      const queryVector = Array(768).fill(0.1);
      const results = await (wrapper.$queryRawUnsafe as Function)(
        `SELECT id, 1 - (embedding <=> $1::vector) as similarity
         FROM section_embeddings
         ORDER BY embedding <=> $1::vector
         LIMIT 10`,
        JSON.stringify(queryVector)
      );

      // Assert
      expect(results).toHaveLength(2);
      expect(results[0].similarity).toBe(0.95);
    });
  });

  describe('RLS設定', () => {
    it('$executeRawUnsafeでRLSコンテキストを設定できること', async () => {
      // Arrange
      const mockClient = createMockPrismaClient({
        tables: ['sectionPattern'],
        withTransaction: true,
      });
      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern'],
        supportsTransaction: true,
      };
      const wrapper = createPrismaWrapper(mockClient, config);

      // Act
      await (wrapper.$transaction as Function)(async (tx: Record<string, unknown>) => {
        await (tx.$executeRawUnsafe as Function)(
          `SET LOCAL app.current_project = 'project-uuid'`
        );

        await (tx.sectionPattern as { create: Function }).create({
          data: { type: 'feature' },
        });
      });

      // Assert - トランザクションが正常に完了すること
      expect(mockClient.$transaction).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// エッジケース
// =============================================================================

describe('エッジケース', () => {
  it('空のテーブル配列でもラッパーが生成できること', () => {
    // Arrange
    const mockClient: MockPrismaClient = {
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    };
    const config: PrismaWrapperConfig = {
      tables: [],
      supportsTransaction: false,
    };

    // Act
    const wrapper = createPrismaWrapper(mockClient, config);

    // Assert
    expect(wrapper.$executeRawUnsafe).toBeDefined();
    expect(wrapper.$queryRawUnsafe).toBeDefined();
  });

  it('createがnullを返した場合でも処理されること', async () => {
    // Arrange
    const mockClient: MockPrismaClient = {
      sectionPattern: {
        create: vi.fn().mockResolvedValue({ id: null }),
      },
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    };

    // Act
    const wrapper = createTableWrapper(mockClient, 'sectionPattern');
    const result = await wrapper.create({ data: {} });

    // Assert
    expect(result).toEqual({ id: null });
  });

  it('createがエラーをスローした場合、エラーが伝播すること', async () => {
    // Arrange
    const mockClient: MockPrismaClient = {
      sectionPattern: {
        create: vi.fn().mockRejectedValue(new Error('Database error')),
      },
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    };

    // Act & Assert
    const wrapper = createTableWrapper(mockClient, 'sectionPattern');
    await expect(wrapper.create({ data: {} })).rejects.toThrowError(
      'Database error'
    );
  });
});
