// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prisma Wrapper Factory テスト
 *
 * TDD Red Phase: 失敗するテストを先に作成
 *
 * @module tests/unit/utils/prisma-wrapper-factory.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// TDD Red: まだ実装されていない関数をインポート
// これらは現時点では存在しないため、テストは失敗する
import {
  createTableWrapper,
  createPrismaWrapper,
  type TableWrapperConfig,
  type PrismaWrapperConfig,
  type WrappedTable,
} from '../../../src/utils/prisma-wrapper-factory';

describe('Prisma Wrapper Factory', () => {
  // モックPrismaClient
  const mockPrisma = {
    sectionPattern: {
      create: vi.fn().mockResolvedValue({ id: 'section-123', name: 'test' }),
    },
    sectionEmbedding: {
      create: vi.fn().mockResolvedValue({ id: 'embedding-456', patternId: 'section-123' }),
    },
    motionPattern: {
      create: vi.fn().mockResolvedValue({ id: 'motion-789', category: 'hover' }),
    },
    motionEmbedding: {
      create: vi.fn().mockResolvedValue({ id: 'motion-emb-012', patternId: 'motion-789' }),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn().mockImplementation(async (fn) => fn(mockPrisma)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createTableWrapper', () => {
    it('テーブル名からcreateメソッドラッパーを生成する', async () => {
      const wrapper = createTableWrapper(mockPrisma, 'sectionPattern');

      expect(wrapper).toBeDefined();
      expect(wrapper.create).toBeDefined();
      expect(typeof wrapper.create).toBe('function');
    });

    it('createメソッドはidのみを返す', async () => {
      const wrapper = createTableWrapper(mockPrisma, 'sectionPattern');

      const result = await wrapper.create({
        data: { webPageId: 'page-1', sectionType: 'hero', positionIndex: 0, layoutInfo: {} },
      });

      expect(result).toEqual({ id: 'section-123' });
      expect(mockPrisma.sectionPattern.create).toHaveBeenCalledWith({
        data: { webPageId: 'page-1', sectionType: 'hero', positionIndex: 0, layoutInfo: {} },
      });
    });

    it('motionPatternテーブルにも対応する', async () => {
      const wrapper = createTableWrapper(mockPrisma, 'motionPattern');

      const result = await wrapper.create({
        data: {
          name: 'fadeIn',
          category: 'entrance',
          triggerType: 'load',
          animation: {},
          properties: {},
        },
      });

      expect(result).toEqual({ id: 'motion-789' });
    });

    it('Embeddingテーブルにも対応する', async () => {
      const sectionEmbWrapper = createTableWrapper(mockPrisma, 'sectionEmbedding');
      const motionEmbWrapper = createTableWrapper(mockPrisma, 'motionEmbedding');

      const sectionResult = await sectionEmbWrapper.create({
        data: { sectionPatternId: 'section-123', modelVersion: 'v1' },
      });
      const motionResult = await motionEmbWrapper.create({
        data: { motionPatternId: 'motion-789', modelVersion: 'v1' },
      });

      expect(sectionResult).toEqual({ id: 'embedding-456' });
      expect(motionResult).toEqual({ id: 'motion-emb-012' });
    });
  });

  describe('createPrismaWrapper', () => {
    describe('Layout用ラッパー（トランザクションなし）', () => {
      it('ILayoutPrismaClient互換のラッパーを生成する', () => {
        const config: PrismaWrapperConfig = {
          tables: ['sectionPattern', 'sectionEmbedding'],
          supportsTransaction: false,
        };

        const wrapper = createPrismaWrapper(mockPrisma, config);

        expect(wrapper.sectionPattern).toBeDefined();
        expect(wrapper.sectionEmbedding).toBeDefined();
        expect(wrapper.$executeRawUnsafe).toBeDefined();
        expect(wrapper.$transaction).toBeUndefined();
      });

      it('$executeRawUnsafeが正しくバインドされる', async () => {
        const config: PrismaWrapperConfig = {
          tables: ['sectionPattern', 'sectionEmbedding'],
          supportsTransaction: false,
        };

        const wrapper = createPrismaWrapper(mockPrisma, config);

        await wrapper.$executeRawUnsafe('UPDATE table SET col = $1', 'value');

        expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
          'UPDATE table SET col = $1',
          'value'
        );
      });
    });

    describe('Motion用ラッパー（トランザクションあり）', () => {
      it('IMotionPrismaClient互換のラッパーを生成する', () => {
        const config: PrismaWrapperConfig = {
          tables: ['motionPattern', 'motionEmbedding'],
          supportsTransaction: true,
        };

        const wrapper = createPrismaWrapper(mockPrisma, config);

        expect(wrapper.motionPattern).toBeDefined();
        expect(wrapper.motionEmbedding).toBeDefined();
        expect(wrapper.$executeRawUnsafe).toBeDefined();
        expect(wrapper.$transaction).toBeDefined();
      });

      it('$transactionが正しく動作する', async () => {
        const config: PrismaWrapperConfig = {
          tables: ['motionPattern', 'motionEmbedding'],
          supportsTransaction: true,
        };

        const wrapper = createPrismaWrapper(mockPrisma, config);

        const result = await wrapper.$transaction(async (tx) => {
          const pattern = await tx.motionPattern.create({
            data: {
              name: 'test',
              category: 'test',
              triggerType: 'load',
              animation: {},
              properties: {},
            },
          });
          return pattern;
        });

        expect(result).toEqual({ id: 'motion-789' });
      });

      it('ネストされたトランザクションはエラーをスローする', async () => {
        const config: PrismaWrapperConfig = {
          tables: ['motionPattern', 'motionEmbedding'],
          supportsTransaction: true,
        };

        const wrapper = createPrismaWrapper(mockPrisma, config);

        await expect(
          wrapper.$transaction(async (tx) => {
            await tx.$transaction(async () => {
              // ネストされたトランザクション
            });
          })
        ).rejects.toThrow('Nested transactions not supported');
      });
    });
  });

  describe('型安全性', () => {
    it('TableWrapperConfig型が正しく定義されている', () => {
      const config: TableWrapperConfig = {
        tableName: 'sectionPattern',
      };
      expect(config.tableName).toBe('sectionPattern');
    });

    it('PrismaWrapperConfig型が正しく定義されている', () => {
      const config: PrismaWrapperConfig = {
        tables: ['sectionPattern', 'sectionEmbedding'],
        supportsTransaction: false,
      };
      expect(config.tables).toHaveLength(2);
      expect(config.supportsTransaction).toBe(false);
    });

    it('WrappedTable型がcreateメソッドを持つ', () => {
      const wrapped: WrappedTable = {
        create: async () => ({ id: 'test' }),
      };
      expect(wrapped.create).toBeDefined();
    });
  });
});
