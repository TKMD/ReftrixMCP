// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @file palette-seed.test.ts
 * @description パレットシード関数のユニットテスト
 *
 * テスト対象:
 * - seedPalettes関数の動作
 * - BrandPaletteとColorTokenの作成
 * - upsert（再実行可能）な動作
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// seedPalettes関数をインポートする前にモックを設定
// モック用のPrismaClient型
type MockPrismaClient = {
  brandPalette: {
    upsert: ReturnType<typeof vi.fn>;
  };
  colorToken: {
    deleteMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

describe('seedPalettes', () => {
  let mockPrisma: MockPrismaClient;

  beforeEach(() => {
    // PrismaClientのモック作成
    mockPrisma = {
      brandPalette: {
        upsert: vi.fn(),
      },
      colorToken: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };

    // console.logをモック化（シード実行時のログを抑制）
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('基本動作', () => {
    it('2つのパレット（standard, dark）が作成されること', async () => {
      // モックの戻り値を設定
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'standard-palette-id',
        name: 'Reftrix Standard',
        slug: 'reftrix-standard',
      });
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'dark-palette-id',
        name: 'Reftrix Dark',
        slug: 'reftrix-dark',
      });
      mockPrisma.colorToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.colorToken.create.mockResolvedValue({});

      // 関数を動的にインポート
      const { seedPalettes } = await import('../../../src/seed/palette-seed');

      // シード実行
      const result = await seedPalettes(mockPrisma as unknown as PrismaClient);

      // brandPalette.upsertが2回呼ばれたことを確認
      expect(mockPrisma.brandPalette.upsert).toHaveBeenCalledTimes(2);

      // 戻り値の確認
      expect(result).toHaveProperty('standardPalette');
      expect(result).toHaveProperty('darkPalette');
      expect(result.standardPalette.name).toBe('Reftrix Standard');
      expect(result.darkPalette.name).toBe('Reftrix Dark');
    });

    it('各パレットに8つのカラートークンが作成されること', async () => {
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'standard-palette-id',
        name: 'Reftrix Standard',
        slug: 'reftrix-standard',
      });
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'dark-palette-id',
        name: 'Reftrix Dark',
        slug: 'reftrix-dark',
      });
      mockPrisma.colorToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.colorToken.create.mockResolvedValue({});

      const { seedPalettes } = await import('../../../src/seed/palette-seed');
      await seedPalettes(mockPrisma as unknown as PrismaClient);

      // 8トークン × 2パレット = 16回
      expect(mockPrisma.colorToken.create).toHaveBeenCalledTimes(16);
    });

    it('既存トークンが削除されてから新規作成されること', async () => {
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'standard-palette-id',
        name: 'Reftrix Standard',
        slug: 'reftrix-standard',
      });
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'dark-palette-id',
        name: 'Reftrix Dark',
        slug: 'reftrix-dark',
      });
      mockPrisma.colorToken.deleteMany.mockResolvedValue({ count: 5 });
      mockPrisma.colorToken.create.mockResolvedValue({});

      const { seedPalettes } = await import('../../../src/seed/palette-seed');
      await seedPalettes(mockPrisma as unknown as PrismaClient);

      // deleteManyが各パレットに対して呼ばれたことを確認
      expect(mockPrisma.colorToken.deleteMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.colorToken.deleteMany).toHaveBeenCalledWith({
        where: { paletteId: 'standard-palette-id' },
      });
      expect(mockPrisma.colorToken.deleteMany).toHaveBeenCalledWith({
        where: { paletteId: 'dark-palette-id' },
      });
    });
  });

  describe('Standardパレットの設定', () => {
    it('lightモードでデフォルトパレットとして設定されること', async () => {
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'standard-palette-id',
        name: 'Reftrix Standard',
        slug: 'reftrix-standard',
      });
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'dark-palette-id',
        name: 'Reftrix Dark',
        slug: 'reftrix-dark',
      });
      mockPrisma.colorToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.colorToken.create.mockResolvedValue({});

      const { seedPalettes } = await import('../../../src/seed/palette-seed');
      await seedPalettes(mockPrisma as unknown as PrismaClient);

      // 最初のupsert呼び出しの引数を確認
      const firstCall = mockPrisma.brandPalette.upsert.mock.calls[0][0];
      expect(firstCall.where).toEqual({ slug: 'reftrix-standard' });
      expect(firstCall.create.mode).toBe('light');
      expect(firstCall.create.isDefault).toBe(true);
    });

    it('適切なカラーロールが設定されること', async () => {
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'standard-palette-id',
        name: 'Reftrix Standard',
        slug: 'reftrix-standard',
      });
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'dark-palette-id',
        name: 'Reftrix Dark',
        slug: 'reftrix-dark',
      });
      mockPrisma.colorToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.colorToken.create.mockResolvedValue({});

      const { seedPalettes } = await import('../../../src/seed/palette-seed');
      await seedPalettes(mockPrisma as unknown as PrismaClient);

      // Standard パレットのトークン作成呼び出しを取得（最初の8回）
      const standardTokenCalls = mockPrisma.colorToken.create.mock.calls.slice(0, 8);

      // 各ロールが存在することを確認
      const roles = standardTokenCalls.map((call) => call[0].data.role);
      expect(roles).toContain('primary');
      expect(roles).toContain('secondary');
      expect(roles).toContain('accent');
      expect(roles).toContain('neutral');
      expect(roles.filter((r) => r === 'semantic')).toHaveLength(4);
    });
  });

  describe('Darkパレットの設定', () => {
    it('darkモードで非デフォルトパレットとして設定されること', async () => {
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'standard-palette-id',
        name: 'Reftrix Standard',
        slug: 'reftrix-standard',
      });
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'dark-palette-id',
        name: 'Reftrix Dark',
        slug: 'reftrix-dark',
      });
      mockPrisma.colorToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.colorToken.create.mockResolvedValue({});

      const { seedPalettes } = await import('../../../src/seed/palette-seed');
      await seedPalettes(mockPrisma as unknown as PrismaClient);

      // 2番目のupsert呼び出しの引数を確認
      const secondCall = mockPrisma.brandPalette.upsert.mock.calls[1][0];
      expect(secondCall.where).toEqual({ slug: 'reftrix-dark' });
      expect(secondCall.create.mode).toBe('dark');
      expect(secondCall.create.isDefault).toBe(false);
    });
  });

  describe('OKLCHカラースペース', () => {
    it('カラートークンにOKLCH値が含まれること', async () => {
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'standard-palette-id',
        name: 'Reftrix Standard',
        slug: 'reftrix-standard',
      });
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'dark-palette-id',
        name: 'Reftrix Dark',
        slug: 'reftrix-dark',
      });
      mockPrisma.colorToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.colorToken.create.mockResolvedValue({});

      const { seedPalettes } = await import('../../../src/seed/palette-seed');
      await seedPalettes(mockPrisma as unknown as PrismaClient);

      // 任意のトークン作成呼び出しを確認
      const firstTokenCall = mockPrisma.colorToken.create.mock.calls[0][0];
      const tokenData = firstTokenCall.data;

      // OKLCH値が含まれていることを確認
      expect(tokenData).toHaveProperty('oklchL');
      expect(tokenData).toHaveProperty('oklchC');
      expect(tokenData).toHaveProperty('oklchH');
      expect(tokenData).toHaveProperty('hex');

      // OKLCH値が有効な範囲内であることを確認
      expect(tokenData.oklchL).toBeGreaterThanOrEqual(0);
      expect(tokenData.oklchL).toBeLessThanOrEqual(1);
      expect(tokenData.oklchC).toBeGreaterThanOrEqual(0);
      expect(tokenData.oklchH).toBeGreaterThanOrEqual(0);
      expect(tokenData.oklchH).toBeLessThanOrEqual(360);
    });
  });

  describe('セマンティックカラー', () => {
    it('success, error, warning, infoのセマンティックカラーが設定されること', async () => {
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'standard-palette-id',
        name: 'Reftrix Standard',
        slug: 'reftrix-standard',
      });
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'dark-palette-id',
        name: 'Reftrix Dark',
        slug: 'reftrix-dark',
      });
      mockPrisma.colorToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.colorToken.create.mockResolvedValue({});

      const { seedPalettes } = await import('../../../src/seed/palette-seed');
      await seedPalettes(mockPrisma as unknown as PrismaClient);

      // Standard パレットのトークン作成呼び出しを取得
      const standardTokenCalls = mockPrisma.colorToken.create.mock.calls.slice(0, 8);

      // セマンティックトークンのみ抽出
      const semanticTokens = standardTokenCalls
        .map((call) => call[0].data)
        .filter((data) => data.role === 'semantic');

      // 4つのセマンティックカラーが存在することを確認
      const semanticMeanings = semanticTokens.map((t) => t.semanticMeaning);
      expect(semanticMeanings).toContain('success');
      expect(semanticMeanings).toContain('error');
      expect(semanticMeanings).toContain('warning');
      expect(semanticMeanings).toContain('info');
    });
  });

  describe('sortOrder', () => {
    it('トークンにsortOrderが正しく設定されること', async () => {
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'standard-palette-id',
        name: 'Reftrix Standard',
        slug: 'reftrix-standard',
      });
      mockPrisma.brandPalette.upsert.mockResolvedValueOnce({
        id: 'dark-palette-id',
        name: 'Reftrix Dark',
        slug: 'reftrix-dark',
      });
      mockPrisma.colorToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.colorToken.create.mockResolvedValue({});

      const { seedPalettes } = await import('../../../src/seed/palette-seed');
      await seedPalettes(mockPrisma as unknown as PrismaClient);

      // Standard パレットのトークン作成呼び出しを取得
      const standardTokenCalls = mockPrisma.colorToken.create.mock.calls.slice(0, 8);

      // sortOrderが0から7まで設定されていることを確認
      const sortOrders = standardTokenCalls.map((call) => call[0].data.sortOrder);
      expect(sortOrders).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });
  });
});
