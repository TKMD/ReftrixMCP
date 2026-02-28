// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @file client.test.ts
 * @description Prismaクライアントシングルトンのユニットテスト
 *
 * テスト対象:
 * - Prismaクライアントのシングルトンパターン
 * - 環境変数による設定の切り替え
 * - グローバル変数へのキャッシュ
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// PrismaClientのモック
vi.mock('@prisma/client', () => {
  const mockPrismaClient = vi.fn(() => ({
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  }));

  return {
    PrismaClient: mockPrismaClient,
    Prisma: {
      ModelName: {},
    },
  };
});

describe('Prisma Client Singleton', () => {
  // 各テスト前に環境をリセット
  beforeEach(() => {
    vi.resetModules();
    // globalThisのprismaをクリア
    const globalForPrisma = globalThis as unknown as {
      prisma: unknown | undefined;
    };
    globalForPrisma.prisma = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('開発環境での動作', () => {
    it('開発環境ではPrismaClientにquery, error, warnログが設定されること', async () => {
      // 開発環境を設定
      vi.stubEnv('NODE_ENV', 'development');

      // モジュールを動的にインポート
      const { PrismaClient } = await import('@prisma/client');

      // client.tsを再インポートしてPrismaClientが呼ばれることを確認
      await import('../../src/client');

      // PrismaClientが呼ばれたことを確認
      expect(PrismaClient).toHaveBeenCalled();

      // 呼び出し時の引数を確認
      const callArgs = (PrismaClient as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(callArgs).toBeDefined();
      expect(callArgs.log).toEqual(['query', 'error', 'warn']);
    });

    it('開発環境ではglobalThisにprismaがキャッシュされること', async () => {
      vi.stubEnv('NODE_ENV', 'development');

      const { prisma } = await import('../../src/client');

      const globalForPrisma = globalThis as unknown as {
        prisma: unknown | undefined;
      };

      expect(globalForPrisma.prisma).toBeDefined();
      expect(globalForPrisma.prisma).toBe(prisma);
    });
  });

  describe('本番環境での動作', () => {
    it('本番環境ではPrismaClientにerrorログのみが設定されること', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const { PrismaClient } = await import('@prisma/client');

      await import('../../src/client');

      expect(PrismaClient).toHaveBeenCalled();

      const callArgs = (PrismaClient as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(callArgs).toBeDefined();
      expect(callArgs.log).toEqual(['error']);
    });

    it('本番環境ではglobalThisにprismaがキャッシュされないこと', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      await import('../../src/client');

      const globalForPrisma = globalThis as unknown as {
        prisma: unknown | undefined;
      };

      // 本番環境ではグローバルにキャッシュされない
      // ただしモジュールキャッシュにより同じインスタンスが返される
      expect(globalForPrisma.prisma).toBeUndefined();
    });
  });

  describe('シングルトンパターン', () => {
    it('同一モジュールからの複数インポートで同じインスタンスが返されること', async () => {
      vi.stubEnv('NODE_ENV', 'development');

      const { prisma: prisma1 } = await import('../../src/client');
      const { prisma: prisma2 } = await import('../../src/client');

      // 同一インスタンスであることを確認
      expect(prisma1).toBe(prisma2);
    });

    it('globalThis.prismaが既に存在する場合は再利用されること', async () => {
      vi.stubEnv('NODE_ENV', 'development');

      // グローバルに既存のprismaインスタンスを設定
      const existingPrisma = { existing: true };
      const globalForPrisma = globalThis as unknown as {
        prisma: unknown | undefined;
      };
      globalForPrisma.prisma = existingPrisma;

      const { prisma } = await import('../../src/client');

      // 既存のインスタンスが再利用されることを確認
      expect(prisma).toBe(existingPrisma);
    });
  });

  describe('エクスポート', () => {
    it('PrismaClient型がエクスポートされていること', async () => {
      const clientModule = await import('../../src/client');

      // Prismaもエクスポートされていることを確認
      expect(clientModule.Prisma).toBeDefined();
    });

    it('prismaインスタンスがエクスポートされていること', async () => {
      const { prisma } = await import('../../src/client');

      expect(prisma).toBeDefined();
    });
  });
});
