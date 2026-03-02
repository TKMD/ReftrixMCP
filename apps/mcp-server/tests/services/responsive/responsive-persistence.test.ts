// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ResponsivePersistenceService Tests
 *
 * レスポンシブ解析結果のDB保存・取得サービスのユニットテスト
 * Prisma をモックして正常系・エラーケースを検証する
 *
 * @module tests/services/responsive/responsive-persistence.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Prisma モック
vi.mock('@reftrix/database', () => ({
  prisma: {
    responsiveAnalysis: {
      create: vi.fn(),
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  Prisma: {
    DbNull: Symbol('DbNull'),
  },
}));

// logger モック
vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: () => true,
}));

import { prisma, Prisma } from '@reftrix/database';
import { logger } from '../../../src/utils/logger';
import { ResponsivePersistenceService } from '../../../src/services/responsive/responsive-persistence.service';
import type { ResponsiveAnalysisResult } from '../../../src/services/responsive/types';

// ============================================================================
// ヘルパー
// ============================================================================

function createMockResult(
  overrides: Partial<ResponsiveAnalysisResult> = {}
): ResponsiveAnalysisResult {
  return {
    viewportsAnalyzed: [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile', width: 375, height: 812 },
    ],
    differences: [
      {
        element: 'nav',
        description: 'ナビゲーション変化',
        category: 'navigation',
        desktop: { type: 'horizontal-menu' },
        mobile: { type: 'hamburger-menu' },
      },
    ],
    breakpoints: ['768px', '1024px'],
    analysisTimeMs: 1234,
    ...overrides,
  };
}

const MOCK_WEB_PAGE_ID = '01912345-6789-7abc-8def-0123456789ab';
const MOCK_RECORD_ID = '01912345-aaaa-7bbb-8ccc-ddddeeeeeeee';

// ============================================================================
// Tests
// ============================================================================

describe('ResponsivePersistenceService', () => {
  let service: ResponsivePersistenceService;

  beforeEach(() => {
    service = new ResponsivePersistenceService();
    vi.clearAllMocks();
    // デフォルト: deleteMany は 0 件削除を返す
    vi.mocked(prisma.responsiveAnalysis.deleteMany).mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ==========================================================================
  // save()
  // ==========================================================================

  describe('save', () => {
    it('解析結果をDBに保存しレコードIDを返す', async () => {
      const result = createMockResult();

      vi.mocked(prisma.responsiveAnalysis.create).mockResolvedValue({
        id: MOCK_RECORD_ID,
      } as never);

      const id = await service.save(MOCK_WEB_PAGE_ID, result);

      expect(id).toBe(MOCK_RECORD_ID);
      expect(prisma.responsiveAnalysis.create).toHaveBeenCalledTimes(1);

      const callArgs = vi.mocked(prisma.responsiveAnalysis.create).mock.calls[0]![0] as {
        data: Record<string, unknown>;
        select: Record<string, boolean>;
      };

      expect(callArgs.data.webPageId).toBe(MOCK_WEB_PAGE_ID);
      expect(callArgs.data.analysisTimeMs).toBe(1234);
      expect(callArgs.select).toEqual({ id: true });
    });

    it('viewportsAnalyzed を [{name, width, height}] 形式で保存する', async () => {
      const result = createMockResult({
        viewportsAnalyzed: [
          { name: 'desktop', width: 1440, height: 900 },
          { name: 'mobile', width: 375, height: 812 },
        ],
      });

      vi.mocked(prisma.responsiveAnalysis.create).mockResolvedValue({
        id: MOCK_RECORD_ID,
      } as never);

      await service.save(MOCK_WEB_PAGE_ID, result);

      const callArgs = vi.mocked(prisma.responsiveAnalysis.create).mock.calls[0]![0] as {
        data: { viewportsAnalyzed: unknown };
      };

      expect(callArgs.data.viewportsAnalyzed).toEqual([
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'mobile', width: 375, height: 812 },
      ]);
    });

    it('breakpoints を [{name}] 形式で保存する', async () => {
      const result = createMockResult({
        breakpoints: ['480px', '768px', '1024px'],
      });

      vi.mocked(prisma.responsiveAnalysis.create).mockResolvedValue({
        id: MOCK_RECORD_ID,
      } as never);

      await service.save(MOCK_WEB_PAGE_ID, result);

      const callArgs = vi.mocked(prisma.responsiveAnalysis.create).mock.calls[0]![0] as {
        data: { breakpoints: unknown };
      };

      expect(callArgs.data.breakpoints).toEqual([
        { name: '480px' },
        { name: '768px' },
        { name: '1024px' },
      ]);
    });

    it('viewportDiffs がある場合 screenshotDiffs に変換して保存する', async () => {
      const result = createMockResult({
        viewportDiffs: [
          {
            viewport1: 'desktop',
            viewport2: 'mobile',
            diffPercentage: 45.2,
            diffPixelCount: 50000,
            totalPixels: 110400,
            comparedWidth: 375,
            comparedHeight: 294,
          },
        ],
      });

      vi.mocked(prisma.responsiveAnalysis.create).mockResolvedValue({
        id: MOCK_RECORD_ID,
      } as never);

      await service.save(MOCK_WEB_PAGE_ID, result);

      const callArgs = vi.mocked(prisma.responsiveAnalysis.create).mock.calls[0]![0] as {
        data: { screenshotDiffs: unknown };
      };

      const diffs = callArgs.data.screenshotDiffs as Array<Record<string, unknown>>;
      expect(Array.isArray(diffs)).toBe(true);
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toEqual({
        viewport1: 'desktop',
        viewport2: 'mobile',
        diffPercentage: 45.2,
        diffPixelCount: 50000,
        totalPixels: 110400,
        comparedWidth: 375,
        comparedHeight: 294,
      });
    });

    it('viewportDiffs がない場合 screenshotDiffs に Prisma.DbNull を設定', async () => {
      const result = createMockResult();
      // viewportDiffs は undefined

      vi.mocked(prisma.responsiveAnalysis.create).mockResolvedValue({
        id: MOCK_RECORD_ID,
      } as never);

      await service.save(MOCK_WEB_PAGE_ID, result);

      const callArgs = vi.mocked(prisma.responsiveAnalysis.create).mock.calls[0]![0] as {
        data: { screenshotDiffs: unknown };
      };

      expect(callArgs.data.screenshotDiffs).toBe(Prisma.DbNull);
    });

    it('diffImageBuffer はDBに保存されない', async () => {
      const result = createMockResult({
        viewportDiffs: [
          {
            viewport1: 'desktop',
            viewport2: 'mobile',
            diffPercentage: 10,
            diffPixelCount: 1000,
            totalPixels: 10000,
            comparedWidth: 100,
            comparedHeight: 100,
            diffImageBuffer: Buffer.from('fake-image-data'),
          },
        ],
      });

      vi.mocked(prisma.responsiveAnalysis.create).mockResolvedValue({
        id: MOCK_RECORD_ID,
      } as never);

      await service.save(MOCK_WEB_PAGE_ID, result);

      const callArgs = vi.mocked(prisma.responsiveAnalysis.create).mock.calls[0]![0] as {
        data: { screenshotDiffs: unknown };
      };

      const diffs = callArgs.data.screenshotDiffs as Array<Record<string, unknown>>;
      expect(diffs[0]).not.toHaveProperty('diffImageBuffer');
    });

    it('Prisma エラー時に例外をスローする', async () => {
      const result = createMockResult();

      vi.mocked(prisma.responsiveAnalysis.create).mockRejectedValue(
        new Error('Foreign key constraint failed') as never
      );

      await expect(service.save(MOCK_WEB_PAGE_ID, result)).rejects.toThrow(
        'Foreign key constraint failed'
      );
    });

    // ========================================================================
    // clean-slate パターン
    // ========================================================================

    it('clean-slate: create 前に deleteMany を呼ぶ', async () => {
      const result = createMockResult();
      const callOrder: string[] = [];

      vi.mocked(prisma.responsiveAnalysis.deleteMany).mockImplementation(async () => {
        callOrder.push('deleteMany');
        return { count: 0 };
      });
      vi.mocked(prisma.responsiveAnalysis.create).mockImplementation(async () => {
        callOrder.push('create');
        return { id: MOCK_RECORD_ID } as never;
      });

      await service.save(MOCK_WEB_PAGE_ID, result);

      expect(callOrder).toEqual(['deleteMany', 'create']);
      expect(prisma.responsiveAnalysis.deleteMany).toHaveBeenCalledWith({
        where: { webPageId: MOCK_WEB_PAGE_ID },
      });
    });

    it('clean-slate: 既存レコード削除時にログが出力される', async () => {
      const result = createMockResult();

      vi.mocked(prisma.responsiveAnalysis.deleteMany).mockResolvedValue({ count: 2 });
      vi.mocked(prisma.responsiveAnalysis.create).mockResolvedValue({
        id: MOCK_RECORD_ID,
      } as never);

      await service.save(MOCK_WEB_PAGE_ID, result);

      expect(logger.info).toHaveBeenCalledWith(
        '[ResponsivePersistence] Deleted existing records (clean-slate)',
        { webPageId: MOCK_WEB_PAGE_ID, deletedCount: 2 }
      );
    });

    it('clean-slate: 既存レコードがない場合は削除ログを出力しない', async () => {
      const result = createMockResult();

      vi.mocked(prisma.responsiveAnalysis.deleteMany).mockResolvedValue({ count: 0 });
      vi.mocked(prisma.responsiveAnalysis.create).mockResolvedValue({
        id: MOCK_RECORD_ID,
      } as never);

      await service.save(MOCK_WEB_PAGE_ID, result);

      const infoCalls = vi.mocked(logger.info).mock.calls;
      const deletionLogCalls = infoCalls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('clean-slate')
      );
      expect(deletionLogCalls).toHaveLength(0);
    });

    it('clean-slate: deleteMany のエラー時に例外がスローされる', async () => {
      const result = createMockResult();

      vi.mocked(prisma.responsiveAnalysis.deleteMany).mockRejectedValue(
        new Error('Database connection lost') as never
      );

      await expect(service.save(MOCK_WEB_PAGE_ID, result)).rejects.toThrow(
        'Database connection lost'
      );
      // create は呼ばれない
      expect(prisma.responsiveAnalysis.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // findByWebPageId()
  // ==========================================================================

  describe('findByWebPageId', () => {
    it('最新のレコードを返す', async () => {
      const mockRecord = {
        id: MOCK_RECORD_ID,
        webPageId: MOCK_WEB_PAGE_ID,
        viewportsAnalyzed: [{ name: 'desktop' }, { name: 'mobile' }],
        differences: [{ element: 'nav', category: 'navigation' }],
        breakpoints: [{ name: '768px' }],
        screenshotDiffs: null,
        qualityMetrics: null,
        analysisTimeMs: 1500,
        createdAt: new Date('2026-03-01T00:00:00Z'),
      };

      vi.mocked(prisma.responsiveAnalysis.findFirst).mockResolvedValue(
        mockRecord as never
      );

      const result = await service.findByWebPageId(MOCK_WEB_PAGE_ID);

      expect(result).toEqual(mockRecord);
      expect(prisma.responsiveAnalysis.findFirst).toHaveBeenCalledWith({
        where: { webPageId: MOCK_WEB_PAGE_ID },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('レコードが存在しない場合 null を返す', async () => {
      vi.mocked(prisma.responsiveAnalysis.findFirst).mockResolvedValue(
        null as never
      );

      const result = await service.findByWebPageId('non-existent-id');

      expect(result).toBeNull();
    });

    it('createdAt desc で最新レコードを取得する', async () => {
      vi.mocked(prisma.responsiveAnalysis.findFirst).mockResolvedValue(
        null as never
      );

      await service.findByWebPageId(MOCK_WEB_PAGE_ID);

      expect(prisma.responsiveAnalysis.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        })
      );
    });

    it('Prisma エラー時に例外をスローする', async () => {
      vi.mocked(prisma.responsiveAnalysis.findFirst).mockRejectedValue(
        new Error('Connection refused') as never
      );

      await expect(
        service.findByWebPageId(MOCK_WEB_PAGE_ID)
      ).rejects.toThrow('Connection refused');
    });
  });
});
