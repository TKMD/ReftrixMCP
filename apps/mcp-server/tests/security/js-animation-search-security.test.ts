// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSAnimationSearchService セキュリティテスト
 *
 * SEC Medium項目の修正確認テスト:
 * 1. offset変数のパラメータ化（SQLインジェクション対策）
 * 2. findSimilarメソッドのUUIDv7検証
 *
 * @module tests/security/js-animation-search-security.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JSAnimationSearchService,
  resetJSAnimationSearchService,
  type IPrismaClient,
  type JSAnimationSearchParams,
} from '../../src/services/motion/js-animation-search.service';

// ============================================================================
// Mock Prisma Client
// ============================================================================

function createMockPrismaClient(): IPrismaClient {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
}

// ============================================================================
// Helper: 768次元のダミーEmbedding生成
// ============================================================================

function createDummyEmbedding(dimensions: number = 768): number[] {
  return Array.from({ length: dimensions }, () => Math.random());
}

// ============================================================================
// Part 1: offset パラメータ化テスト（SQLインジェクション対策）
// ============================================================================

describe('JSAnimationSearchService: offset パラメータ化（SEC Medium修正）', () => {
  let mockPrisma: IPrismaClient;
  let service: JSAnimationSearchService;

  beforeEach(() => {
    resetJSAnimationSearchService();
    mockPrisma = createMockPrismaClient();
    service = new JSAnimationSearchService({ prisma: mockPrisma });
  });

  afterEach(() => {
    resetJSAnimationSearchService();
    vi.clearAllMocks();
  });

  describe('正常系: 有効なoffset値', () => {
    it('offset=0 で正常にクエリ実行されること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: 0,
        limit: 10,
      };

      // モックが配列とカウントを返す
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([]) // results
        .mockResolvedValueOnce([{ count: 0 }]); // count

      await service.search(params);

      // $queryRawUnsafe が呼ばれていること
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();

      // 最初の呼び出し（メインクエリ）でoffsetがパラメータとして渡されていること
      const firstCall = (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      // パラメータ: query, vector, minSimilarity, limit, offset, ...filterValues
      expect(firstCall[4]).toBe(0); // offset は5番目のパラメータ
    });

    it('offset=100 で正常にクエリ実行されること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: 100,
        limit: 10,
      };

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      await service.search(params);

      const firstCall = (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(firstCall[4]).toBe(100);
    });

    it('offset=10000（大きな値）で正常にクエリ実行されること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: 10000,
        limit: 10,
      };

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      await service.search(params);

      const firstCall = (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(firstCall[4]).toBe(10000);
    });
  });

  describe('異常系: 不正なoffset値（SQLインジェクション試行）', () => {
    it('負のoffset値でエラーになること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: -1,
        limit: 10,
      };

      await expect(service.search(params)).rejects.toThrow('offset must be between 0 and 100000');
    });

    it('上限を超えるoffset値でエラーになること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: 100001,
        limit: 10,
      };

      await expect(service.search(params)).rejects.toThrow('offset must be between 0 and 100000');
    });

    it('小数のoffset値でエラーになること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: 10.5,
        limit: 10,
      };

      await expect(service.search(params)).rejects.toThrow('offset must be an integer');
    });

    it('NaNのoffset値でエラーになること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: NaN,
        limit: 10,
      };

      await expect(service.search(params)).rejects.toThrow('offset must be an integer');
    });

    it('Infinityのoffset値でエラーになること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: Infinity,
        limit: 10,
      };

      await expect(service.search(params)).rejects.toThrow('offset must be an integer');
    });
  });

  describe('異常系: 不正なlimit値', () => {
    it('負のlimit値でエラーになること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: 0,
        limit: -1,
      };

      await expect(service.search(params)).rejects.toThrow('limit must be between 1 and 100');
    });

    it('0のlimit値でエラーになること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: 0,
        limit: 0,
      };

      await expect(service.search(params)).rejects.toThrow('limit must be between 1 and 100');
    });

    it('上限を超えるlimit値でエラーになること', async () => {
      const params: JSAnimationSearchParams = {
        queryEmbedding: createDummyEmbedding(),
        offset: 0,
        limit: 101,
      };

      await expect(service.search(params)).rejects.toThrow('limit must be between 1 and 100');
    });
  });
});

// ============================================================================
// Part 2: findSimilar UUIDv7検証テスト
// ============================================================================

describe('JSAnimationSearchService: findSimilar UUIDv7検証（SEC Medium修正）', () => {
  let mockPrisma: IPrismaClient;
  let service: JSAnimationSearchService;

  beforeEach(() => {
    resetJSAnimationSearchService();
    mockPrisma = createMockPrismaClient();
    service = new JSAnimationSearchService({ prisma: mockPrisma });
  });

  afterEach(() => {
    resetJSAnimationSearchService();
    vi.clearAllMocks();
  });

  describe('正常系: 有効なUUIDv7', () => {
    it('正しいUUIDv7形式で正常にクエリ実行されること', async () => {
      // UUIDv7形式: バージョン7（4桁目が7）、バリアント（5桁目が8/9/a/b）
      const validUUIDv7 = '01936abc-def0-7123-8456-789abcdef012';

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.findSimilar(validUUIDv7, 5, 0.7);

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
      const call = (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1]).toBe(validUUIDv7);
    });

    it('バリアント9のUUIDv7で正常に動作すること', async () => {
      const validUUIDv7 = '01936abc-def0-7123-9456-789abcdef012';

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.findSimilar(validUUIDv7, 5, 0.7);

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
    });

    it('バリアントaのUUIDv7で正常に動作すること', async () => {
      const validUUIDv7 = '01936abc-def0-7123-a456-789abcdef012';

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.findSimilar(validUUIDv7, 5, 0.7);

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
    });

    it('バリアントbのUUIDv7で正常に動作すること', async () => {
      const validUUIDv7 = '01936abc-def0-7123-b456-789abcdef012';

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.findSimilar(validUUIDv7, 5, 0.7);

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
    });
  });

  describe('異常系: 不正なUUID形式', () => {
    it('空文字列でエラーになること', async () => {
      await expect(service.findSimilar('', 5, 0.7)).rejects.toThrow(
        'Invalid patternId: must be a valid UUIDv7 format'
      );
    });

    it('ランダムな文字列でエラーになること', async () => {
      await expect(service.findSimilar('not-a-uuid', 5, 0.7)).rejects.toThrow(
        'Invalid patternId: must be a valid UUIDv7 format'
      );
    });

    it('UUIDv4形式でエラーになること（バージョン4）', async () => {
      // UUIDv4: バージョン4（4桁目が4）
      const uuidV4 = '550e8400-e29b-41d4-a716-446655440000';

      await expect(service.findSimilar(uuidV4, 5, 0.7)).rejects.toThrow(
        'Invalid patternId: must be a valid UUIDv7 format'
      );
    });

    it('UUIDv1形式でエラーになること（バージョン1）', async () => {
      // UUIDv1: バージョン1（4桁目が1）
      const uuidV1 = '550e8400-e29b-11d4-a716-446655440000';

      await expect(service.findSimilar(uuidV1, 5, 0.7)).rejects.toThrow(
        'Invalid patternId: must be a valid UUIDv7 format'
      );
    });

    it('不正なバリアント（c）のUUIDでエラーになること', async () => {
      // バージョン7だがバリアントがc（無効）
      const invalidVariant = '01936abc-def0-7123-c456-789abcdef012';

      await expect(service.findSimilar(invalidVariant, 5, 0.7)).rejects.toThrow(
        'Invalid patternId: must be a valid UUIDv7 format'
      );
    });

    it('短すぎるUUID形式でエラーになること', async () => {
      await expect(service.findSimilar('01936abc-def0-7123', 5, 0.7)).rejects.toThrow(
        'Invalid patternId: must be a valid UUIDv7 format'
      );
    });

    it('長すぎるUUID形式でエラーになること', async () => {
      await expect(
        service.findSimilar('01936abc-def0-7123-8456-789abcdef012-extra', 5, 0.7)
      ).rejects.toThrow('Invalid patternId: must be a valid UUIDv7 format');
    });
  });

  describe('異常系: SQLインジェクション試行', () => {
    it('SQLインジェクション文字列（基本）が拒否されること', async () => {
      const injection = "'; DROP TABLE js_animation_patterns; --";

      await expect(service.findSimilar(injection, 5, 0.7)).rejects.toThrow(
        'Invalid patternId: must be a valid UUIDv7 format'
      );
    });

    it('SQLインジェクション文字列（UNION）が拒否されること', async () => {
      const injection = "' UNION SELECT * FROM users --";

      await expect(service.findSimilar(injection, 5, 0.7)).rejects.toThrow(
        'Invalid patternId: must be a valid UUIDv7 format'
      );
    });

    it('SQLインジェクション文字列（コメント）が拒否されること', async () => {
      const injection = '01936abc-def0-7123-8456-789abcdef012/**/OR/**/1=1';

      await expect(service.findSimilar(injection, 5, 0.7)).rejects.toThrow(
        'Invalid patternId: must be a valid UUIDv7 format'
      );
    });

    it('NULL文字を含む入力が拒否されること', async () => {
      const injection = '01936abc-def0-7123-8456-789abc\x00ef012';

      await expect(service.findSimilar(injection, 5, 0.7)).rejects.toThrow(
        'Invalid patternId: must be a valid UUIDv7 format'
      );
    });
  });

  describe('異常系: findSimilar のパラメータ検証', () => {
    const validUUIDv7 = '01936abc-def0-7123-8456-789abcdef012';

    it('負のlimit値でエラーになること', async () => {
      await expect(service.findSimilar(validUUIDv7, -1, 0.7)).rejects.toThrow(
        'limit must be between 1 and 50'
      );
    });

    it('0のlimit値でエラーになること', async () => {
      await expect(service.findSimilar(validUUIDv7, 0, 0.7)).rejects.toThrow(
        'limit must be between 1 and 50'
      );
    });

    it('上限を超えるlimit値でエラーになること', async () => {
      await expect(service.findSimilar(validUUIDv7, 51, 0.7)).rejects.toThrow(
        'limit must be between 1 and 50'
      );
    });

    it('負のminSimilarity値でエラーになること', async () => {
      await expect(service.findSimilar(validUUIDv7, 5, -0.1)).rejects.toThrow(
        'minSimilarity must be between 0 and 1'
      );
    });

    it('1を超えるminSimilarity値でエラーになること', async () => {
      await expect(service.findSimilar(validUUIDv7, 5, 1.1)).rejects.toThrow(
        'minSimilarity must be between 0 and 1'
      );
    });

    it('NaNのminSimilarity値でエラーになること', async () => {
      await expect(service.findSimilar(validUUIDv7, 5, NaN)).rejects.toThrow(
        'minSimilarity must be between 0 and 1'
      );
    });
  });
});
