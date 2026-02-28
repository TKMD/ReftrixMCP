// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @file admin-operation.test.ts
 * @description Admin Operation ユーティリティのユニットテスト
 *
 * テスト対象:
 * - withAdminBypass(): RLSバイパスでの管理者操作
 * - isAdminConnectionAvailable(): 管理者接続の可用性チェック
 * - getAdminPrismaClient(): 管理者Prismaクライアント取得
 *
 * Reference: SEC-RLS-001
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// PrismaClientのモック
const mockExecuteRaw = vi.fn();
const mockPrismaClient = vi.fn(() => ({
  $executeRaw: mockExecuteRaw,
  $connect: vi.fn(),
  $disconnect: vi.fn(),
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: mockPrismaClient,
}));

describe('Admin Operation Utilities', () => {
  // 元の環境変数を保存
  let originalAdminDbUrl: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    // グローバル変数をクリア
    const globalForPrismaAdmin = globalThis as unknown as {
      prismaAdmin: unknown | undefined;
    };
    globalForPrismaAdmin.prismaAdmin = undefined;

    // 環境変数を保存
    originalAdminDbUrl = process.env.ADMIN_DATABASE_URL;
    originalNodeEnv = process.env.NODE_ENV;

    // モックをリセット
    mockExecuteRaw.mockReset();
    mockPrismaClient.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // 環境変数を復元
    if (originalAdminDbUrl !== undefined) {
      process.env.ADMIN_DATABASE_URL = originalAdminDbUrl;
    } else {
      delete process.env.ADMIN_DATABASE_URL;
    }
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  describe('isAdminConnectionAvailable', () => {
    it('ADMIN_DATABASE_URLが設定されている場合はtrueを返すこと', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';

      const { isAdminConnectionAvailable } = await import('../../../src/utils/admin-operation');

      expect(isAdminConnectionAvailable()).toBe(true);
    });

    it('ADMIN_DATABASE_URLが設定されていない場合はfalseを返すこと', async () => {
      delete process.env.ADMIN_DATABASE_URL;

      const { isAdminConnectionAvailable } = await import('../../../src/utils/admin-operation');

      expect(isAdminConnectionAvailable()).toBe(false);
    });

    it('ADMIN_DATABASE_URLが空文字の場合はfalseを返すこと', async () => {
      process.env.ADMIN_DATABASE_URL = '';

      const { isAdminConnectionAvailable } = await import('../../../src/utils/admin-operation');

      expect(isAdminConnectionAvailable()).toBe(false);
    });
  });

  describe('getAdminPrismaClient', () => {
    it('ADMIN_DATABASE_URLが設定されていない場合はエラーをスローすること', async () => {
      delete process.env.ADMIN_DATABASE_URL;

      const { getAdminPrismaClient } = await import('../../../src/utils/admin-operation');

      expect(() => getAdminPrismaClient()).toThrow('[SEC-RLS-001]');
      expect(() => getAdminPrismaClient()).toThrow('ADMIN_DATABASE_URL is not configured');
    });

    it('ADMIN_DATABASE_URLが設定されている場合はPrismaClientを返すこと', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';

      const { getAdminPrismaClient } = await import('../../../src/utils/admin-operation');

      const client = getAdminPrismaClient();

      expect(client).toBeDefined();
      expect(mockPrismaClient).toHaveBeenCalled();
    });

    it('同一クライアントがシングルトンとしてキャッシュされること', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';

      const { getAdminPrismaClient } = await import('../../../src/utils/admin-operation');

      const client1 = getAdminPrismaClient();
      const client2 = getAdminPrismaClient();

      expect(client1).toBe(client2);
      // PrismaClientは1回だけ呼ばれる
      expect(mockPrismaClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('withAdminBypass', () => {
    it('ADMIN_DATABASE_URLが設定されていない場合はエラーをスローすること', async () => {
      delete process.env.ADMIN_DATABASE_URL;
      // コンソール警告を抑制
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { withAdminBypass } = await import('../../../src/utils/admin-operation');

      await expect(
        withAdminBypass('test_op', 'test reason', async () => 'result')
      ).rejects.toThrow('[SEC-RLS-001]');

      warnSpy.mockRestore();
    });

    it('成功した操作の結果を返し、監査ログを記録すること', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // DB書き込みはエラーになる可能性があるのでモック
      mockExecuteRaw.mockRejectedValue(new Error('audit_logs not exist'));

      const { withAdminBypass } = await import('../../../src/utils/admin-operation');

      const result = await withAdminBypass(
        'test_operation',
        'Test reason for bypass',
        async () => 'success_result'
      );

      expect(result).toBe('success_result');
      // 操作開始のログが記録されていること
      expect(warnSpy).toHaveBeenCalledWith(
        '[ADMIN_BYPASS] Operation started',
        expect.objectContaining({
          operation: 'test_operation',
          reason: 'Test reason for bypass',
        })
      );
      // 成功ログが記録されていること
      expect(warnSpy).toHaveBeenCalledWith(
        '[ADMIN_BYPASS]',
        expect.stringContaining('"status":"success"')
      );

      warnSpy.mockRestore();
    });

    it('関数内でエラーが発生した場合は再スローし、エラーログを記録すること', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // DB書き込みはエラーになる可能性があるのでモック
      mockExecuteRaw.mockRejectedValue(new Error('audit_logs not exist'));

      const { withAdminBypass } = await import('../../../src/utils/admin-operation');

      const testError = new Error('Test operation failed');
      await expect(
        withAdminBypass('failing_operation', 'Test failure', async () => {
          throw testError;
        })
      ).rejects.toThrow('Test operation failed');

      // エラーログが記録されていること
      expect(errorSpy).toHaveBeenCalledWith(
        '[ADMIN_BYPASS]',
        expect.stringContaining('"status":"error"')
      );
      expect(errorSpy).toHaveBeenCalledWith(
        '[ADMIN_BYPASS]',
        expect.stringContaining('Test operation failed')
      );

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('非Errorオブジェクトがスローされた場合もエラーハンドリングされること', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockExecuteRaw.mockRejectedValue(new Error('audit_logs not exist'));

      const { withAdminBypass } = await import('../../../src/utils/admin-operation');

      // 非Errorオブジェクトをスロー
      await expect(
        withAdminBypass('string_error_op', 'Test with string error', async () => {
          throw 'string error';
        })
      ).rejects.toBe('string error');

      // Unknown errorとしてログされること
      expect(errorSpy).toHaveBeenCalledWith(
        '[ADMIN_BYPASS]',
        expect.stringContaining('Unknown error')
      );

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('開発環境でDB監査ログ書き込み失敗時に警告ログが出力されること', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';
      process.env.NODE_ENV = 'development';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // DB書き込み失敗をシミュレート
      mockExecuteRaw.mockRejectedValue(new Error('relation "audit_logs" does not exist'));

      const { withAdminBypass } = await import('../../../src/utils/admin-operation');

      await withAdminBypass('test_op', 'reason', async () => 'result');

      // DB書き込み失敗の警告ログを確認
      expect(warnSpy).toHaveBeenCalledWith(
        '[ADMIN] Failed to write audit log to database:',
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });

    it('本番環境でDB監査ログ書き込み失敗時は警告ログが出力されないこと', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';
      process.env.NODE_ENV = 'production';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockExecuteRaw.mockRejectedValue(new Error('relation "audit_logs" does not exist'));

      const { withAdminBypass } = await import('../../../src/utils/admin-operation');

      await withAdminBypass('test_op', 'reason', async () => 'result');

      // DB失敗警告は本番では出力されない
      expect(warnSpy).not.toHaveBeenCalledWith(
        '[ADMIN] Failed to write audit log to database:',
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });

    it('操作時間（durationMs）が正しく計測されること', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockExecuteRaw.mockRejectedValue(new Error('audit_logs not exist'));

      const { withAdminBypass } = await import('../../../src/utils/admin-operation');

      // 処理に少し時間がかかる操作
      await withAdminBypass('timed_operation', 'timing test', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'done';
      });

      // durationMsが記録されていることを確認
      const successLogCall = warnSpy.mock.calls.find(
        (call) => call[0] === '[ADMIN_BYPASS]' && typeof call[1] === 'string' && call[1].includes('"status":"success"')
      );
      expect(successLogCall).toBeDefined();
      const logData = JSON.parse(successLogCall![1] as string);
      expect(logData.durationMs).toBeGreaterThanOrEqual(40); // 処理時間が記録されている

      warnSpy.mockRestore();
    });
  });

  describe('PrismaClient設定', () => {
    it('開発環境ではquery, error, warnログが設定されること', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';
      process.env.NODE_ENV = 'development';

      const { getAdminPrismaClient } = await import('../../../src/utils/admin-operation');

      getAdminPrismaClient();

      expect(mockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          log: ['query', 'error', 'warn'],
        })
      );
    });

    it('本番環境ではerrorログのみが設定されること', async () => {
      process.env.ADMIN_DATABASE_URL = 'postgresql://admin:pass@localhost:5432/test';
      process.env.NODE_ENV = 'production';

      const { getAdminPrismaClient } = await import('../../../src/utils/admin-operation');

      getAdminPrismaClient();

      expect(mockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          log: ['error'],
        })
      );
    });

    it('datasources.db.urlにADMIN_DATABASE_URLが設定されること', async () => {
      const adminUrl = 'postgresql://admin:secret@localhost:5432/admindb';
      process.env.ADMIN_DATABASE_URL = adminUrl;

      const { getAdminPrismaClient } = await import('../../../src/utils/admin-operation');

      getAdminPrismaClient();

      expect(mockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          datasources: {
            db: { url: adminUrl },
          },
        })
      );
    });
  });
});
