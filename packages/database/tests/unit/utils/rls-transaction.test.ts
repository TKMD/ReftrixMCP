// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @file rls-transaction.test.ts
 * @description RLS Transaction ユーティリティのユニットテスト
 *
 * テスト対象:
 * - RLS_PROTECTED_MODELS: 保護対象モデル一覧
 * - isRlsProtectedModel(): モデルがRLS保護対象かどうかの判定
 * - withRlsContext(): RLSコンテキスト内での操作実行
 * - withRlsBypass(): 非推奨関数（エラーをスロー）
 *
 * Reference: SEC-RLS-004 (Fail-close behavior)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Prismaトランザクションのモック
const mockExecuteRawUnsafe = vi.fn();
const mockTransaction = vi.fn();

const mockPrismaClient = {
  $transaction: mockTransaction,
};

// モック設定
vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrismaClient),
  Prisma: {},
}));

describe('RLS Transaction Utilities', () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    mockExecuteRawUnsafe.mockReset();
    mockTransaction.mockReset();
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  describe('RLS_PROTECTED_MODELS', () => {
    it('Tier 1モデルが含まれていること', async () => {
      const { RLS_PROTECTED_MODELS } = await import('../../../src/utils/rls-transaction');

      // Tier 1: Direct user ownership
      expect(RLS_PROTECTED_MODELS).toContain('Project');
      // [DELETED OSS] ApiKey removed
    });

    it('Tier 2モデルが含まれていること', async () => {
      const { RLS_PROTECTED_MODELS } = await import('../../../src/utils/rls-transaction');

      // Tier 2: Indirect ownership (via Project)
      expect(RLS_PROTECTED_MODELS).toContain('ProjectBrandSetting');
    });

    it('[Phase 1] 削除されたモデルが含まれていないこと', async () => {
      const { RLS_PROTECTED_MODELS } = await import('../../../src/utils/rls-transaction');

      // Phase 1で削除されたモデル
      expect(RLS_PROTECTED_MODELS).not.toContain('Account');
      expect(RLS_PROTECTED_MODELS).not.toContain('Session');
      expect(RLS_PROTECTED_MODELS).not.toContain('ProjectPage');
      expect(RLS_PROTECTED_MODELS).not.toContain('ProjectBrief');
      expect(RLS_PROTECTED_MODELS).not.toContain('ProjectLayoutVersion');
      expect(RLS_PROTECTED_MODELS).not.toContain('ProjectLayoutScore');
      expect(RLS_PROTECTED_MODELS).not.toContain('ProjectCodeExport');
    });

    it('合計2モデルが定義されていること', async () => {
      const { RLS_PROTECTED_MODELS } = await import('../../../src/utils/rls-transaction');

      expect(RLS_PROTECTED_MODELS).toHaveLength(2);
    });
  });

  describe('isRlsProtectedModel', () => {
    it('RLS保護対象モデルに対してtrueを返すこと', async () => {
      const { isRlsProtectedModel } = await import('../../../src/utils/rls-transaction');

      expect(isRlsProtectedModel('Project')).toBe(true);
      expect(isRlsProtectedModel('ProjectBrandSetting')).toBe(true);
      // [DELETED OSS] ApiKey removed
    });

    it('RLS保護対象外のモデルに対してfalseを返すこと', async () => {
      const { isRlsProtectedModel } = await import('../../../src/utils/rls-transaction');

      expect(isRlsProtectedModel('User')).toBe(false);
      expect(isRlsProtectedModel('WebPage')).toBe(false);
      expect(isRlsProtectedModel('SectionPattern')).toBe(false);
      expect(isRlsProtectedModel('MotionPattern')).toBe(false);
    });

    it('undefinedに対してfalseを返すこと', async () => {
      const { isRlsProtectedModel } = await import('../../../src/utils/rls-transaction');

      expect(isRlsProtectedModel(undefined)).toBe(false);
    });

    it('空文字に対してfalseを返すこと', async () => {
      const { isRlsProtectedModel } = await import('../../../src/utils/rls-transaction');

      expect(isRlsProtectedModel('')).toBe(false);
    });

    it('大文字小文字を区別すること', async () => {
      const { isRlsProtectedModel } = await import('../../../src/utils/rls-transaction');

      expect(isRlsProtectedModel('project')).toBe(false);
      expect(isRlsProtectedModel('PROJECT')).toBe(false);
      expect(isRlsProtectedModel('Project')).toBe(true);
    });
  });

  describe('withRlsContext', () => {
    it('ユーザーIDが正しくSET LOCALで設定されること', async () => {
      const mockTx = {
        $executeRawUnsafe: mockExecuteRawUnsafe,
      };
      mockTransaction.mockImplementation(async (fn) => {
        return fn(mockTx);
      });

      const { withRlsContext } = await import('../../../src/utils/rls-transaction');

      await withRlsContext(mockPrismaClient as never, 'user-123', async () => 'result');

      expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
        "SET LOCAL app.current_user_id = 'user-123'"
      );
    });

    it('関数の結果が正しく返されること', async () => {
      const mockTx = {
        $executeRawUnsafe: mockExecuteRawUnsafe,
      };
      mockTransaction.mockImplementation(async (fn) => {
        return fn(mockTx);
      });

      const { withRlsContext } = await import('../../../src/utils/rls-transaction');

      const result = await withRlsContext(
        mockPrismaClient as never,
        'user-123',
        async () => ({ data: 'test' })
      );

      expect(result).toEqual({ data: 'test' });
    });

    it('nullのユーザーIDはfail-close動作（空文字設定）になること', async () => {
      const mockTx = {
        $executeRawUnsafe: mockExecuteRawUnsafe,
      };
      mockTransaction.mockImplementation(async (fn) => {
        return fn(mockTx);
      });

      const { withRlsContext } = await import('../../../src/utils/rls-transaction');

      await withRlsContext(mockPrismaClient as never, null, async () => 'result');

      // fail-close: 空文字が設定される
      expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
        "SET LOCAL app.current_user_id = ''"
      );
    });

    it('undefinedのユーザーIDはfail-close動作（空文字設定）になること', async () => {
      const mockTx = {
        $executeRawUnsafe: mockExecuteRawUnsafe,
      };
      mockTransaction.mockImplementation(async (fn) => {
        return fn(mockTx);
      });

      const { withRlsContext } = await import('../../../src/utils/rls-transaction');

      await withRlsContext(mockPrismaClient as never, undefined, async () => 'result');

      expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
        "SET LOCAL app.current_user_id = ''"
      );
    });

    it('シングルクォートを含むユーザーIDがエスケープされること（SQLインジェクション対策）', async () => {
      const mockTx = {
        $executeRawUnsafe: mockExecuteRawUnsafe,
      };
      mockTransaction.mockImplementation(async (fn) => {
        return fn(mockTx);
      });

      const { withRlsContext } = await import('../../../src/utils/rls-transaction');

      // SQLインジェクション試行
      await withRlsContext(
        mockPrismaClient as never,
        "user'; DROP TABLE users; --",
        async () => 'result'
      );

      // シングルクォートがダブルエスケープされていること
      expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
        "SET LOCAL app.current_user_id = 'user''; DROP TABLE users; --'"
      );
    });

    it('開発環境ではデバッグログが出力されること', async () => {
      process.env.NODE_ENV = 'development';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mockTx = {
        $executeRawUnsafe: mockExecuteRawUnsafe,
      };
      mockTransaction.mockImplementation(async (fn) => {
        return fn(mockTx);
      });

      const { withRlsContext } = await import('../../../src/utils/rls-transaction');

      await withRlsContext(mockPrismaClient as never, 'user-456', async () => 'result');

      expect(logSpy).toHaveBeenCalledWith('[RLS] Context set: user_id=user-456');

      logSpy.mockRestore();
    });

    it('開発環境で空ユーザーIDの場合はfail-closeログが出力されること', async () => {
      process.env.NODE_ENV = 'development';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mockTx = {
        $executeRawUnsafe: mockExecuteRawUnsafe,
      };
      mockTransaction.mockImplementation(async (fn) => {
        return fn(mockTx);
      });

      const { withRlsContext } = await import('../../../src/utils/rls-transaction');

      await withRlsContext(mockPrismaClient as never, '', async () => 'result');

      expect(logSpy).toHaveBeenCalledWith('[RLS] Context set: user_id=(empty - fail-close)');

      logSpy.mockRestore();
    });

    it('本番環境ではデバッグログが出力されないこと', async () => {
      process.env.NODE_ENV = 'production';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mockTx = {
        $executeRawUnsafe: mockExecuteRawUnsafe,
      };
      mockTransaction.mockImplementation(async (fn) => {
        return fn(mockTx);
      });

      const { withRlsContext } = await import('../../../src/utils/rls-transaction');

      await withRlsContext(mockPrismaClient as never, 'user-789', async () => 'result');

      expect(logSpy).not.toHaveBeenCalled();

      logSpy.mockRestore();
    });

    it('トランザクション内でエラーが発生した場合は再スローされること', async () => {
      const mockTx = {
        $executeRawUnsafe: mockExecuteRawUnsafe,
      };
      mockTransaction.mockImplementation(async (fn) => {
        return fn(mockTx);
      });

      const { withRlsContext } = await import('../../../src/utils/rls-transaction');

      const testError = new Error('Database operation failed');
      await expect(
        withRlsContext(mockPrismaClient as never, 'user-123', async () => {
          throw testError;
        })
      ).rejects.toThrow('Database operation failed');
    });
  });

  describe('withRlsBypass (deprecated)', () => {
    it('常にエラーをスローすること（SEC-RLS-001）', async () => {
      const { withRlsBypass } = await import('../../../src/utils/rls-transaction');

      await expect(
        withRlsBypass(mockPrismaClient as never, async () => 'result', 'test reason')
      ).rejects.toThrow('[SEC-RLS-001]');
    });

    it('エラーメッセージに代替手段（withAdminBypass）が記載されていること', async () => {
      const { withRlsBypass } = await import('../../../src/utils/rls-transaction');

      await expect(
        withRlsBypass(mockPrismaClient as never, async () => 'result', 'test reason')
      ).rejects.toThrow('withAdminBypass');
    });

    it('エラーメッセージにドキュメント参照が含まれていること', async () => {
      const { withRlsBypass } = await import('../../../src/utils/rls-transaction');

      await expect(
        withRlsBypass(mockPrismaClient as never, async () => 'result', 'test reason')
      ).rejects.toThrow('rls-implementation-plan.md');
    });
  });

  describe('RlsProtectedModel type', () => {
    it('型としてエクスポートされていること', async () => {
      // TypeScript型のテスト - インポートが成功すれば型は存在する
      const { RLS_PROTECTED_MODELS, isRlsProtectedModel } = await import(
        '../../../src/utils/rls-transaction'
      );

      // 型ガードとして正しく機能すること
      const modelName = 'Project';
      if (isRlsProtectedModel(modelName)) {
        // この型ガード内でmodelNameはRlsProtectedModel型
        expect(RLS_PROTECTED_MODELS.includes(modelName)).toBe(true);
      }
    });
  });
});
