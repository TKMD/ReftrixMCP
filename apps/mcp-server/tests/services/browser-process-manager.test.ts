// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BrowserProcessManager テスト
 *
 * Playwrightブラウザプロセスの安全な終了と強制終了を担当するクラスのテスト
 *
 * TDD Phase: Red - まず失敗するテストを作成
 *
 * テストケース:
 * 1. getBrowserPid: PIDが取得できる
 * 2. safeClose: 正常終了時にclose()が呼ばれる
 * 3. safeClose: close()失敗時にforceKillが呼ばれる（forceKillOnTimeout=true）
 * 4. safeClose: close()失敗時にforceKillが呼ばれない（forceKillOnTimeout=false）
 * 5. closeWithTimeout: タイムアウト前に完了
 * 6. closeWithTimeout: タイムアウト後にforceKillが呼ばれる
 * 7. forceKill: SIGTERMが送信される
 * 8. forceKill: SIGTERM後にプロセスが生存していればSIGKILLが送信される
 * 9. isProcessAlive: プロセス存在確認が正しく動作
 * 10. killAllChildren: Linuxでpkillが呼ばれる
 *
 * @module tests/services/browser-process-manager.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Browser } from 'playwright';

// モックの設定
const mockProcessKill = vi.fn();
const mockExecSync = vi.fn();

// child_processモジュールをモック
vi.mock('child_process', () => ({
  execSync: (...args: Parameters<typeof import('child_process').execSync>) =>
    mockExecSync(...args),
  spawn: vi.fn(),
}));

// process.killをモック
const originalProcessKill = process.kill;
beforeEach(() => {
  // @ts-expect-error - モック用に上書き
  process.kill = mockProcessKill;
});
afterEach(() => {
  process.kill = originalProcessKill;
});

// loggerモック
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// =====================================================
// テストスイート
// =====================================================

describe('BrowserProcessManager', () => {
  let BrowserProcessManager: typeof import('../../src/services/browser-process-manager').BrowserProcessManager;

  // モックブラウザオブジェクト
  const createMockBrowser = (options: {
    pid?: number | null;
    closeResolves?: boolean;
    closeError?: Error;
  } = {}): Browser => {
    const { pid = 12345, closeResolves = true, closeError } = options;

    const mockBrowser = {
      close: vi.fn().mockImplementation(() => {
        if (closeError) {
          return Promise.reject(closeError);
        }
        return closeResolves ? Promise.resolve() : new Promise(() => {}); // 永続的にpending
      }),
      isConnected: vi.fn().mockReturnValue(true),
      // Playwrightの内部APIをモック
      _browserType: {
        _launchedProcess: pid !== null ? { pid } : undefined,
      },
    } as unknown as Browser;

    return mockBrowser;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProcessKill.mockReset();
    mockExecSync.mockReset();

    // モジュールを再インポート（モック状態をリセット）
    vi.resetModules();
    const module = await import('../../src/services/browser-process-manager');
    BrowserProcessManager = module.BrowserProcessManager;
  });

  // =====================================================
  // 1. getBrowserPid テスト
  // =====================================================

  describe('getBrowserPid', () => {
    it('should extract PID from browser process', () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // privateメソッドのテストにはアクセスが必要
      // @ts-expect-error - privateプロパティへのアクセス
      expect(manager.browserPid).toBe(12345);
    });

    it('should return null if PID is not available', () => {
      const mockBrowser = createMockBrowser({ pid: null });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // @ts-expect-error - privateプロパティへのアクセス
      expect(manager.browserPid).toBeNull();
    });

    it('should handle browser without internal API gracefully', () => {
      const mockBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
        // _browserType が存在しない
      } as unknown as Browser;

      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // @ts-expect-error - privateプロパティへのアクセス
      expect(manager.browserPid).toBeNull();
    });
  });

  // =====================================================
  // 2-4. safeClose テスト
  // =====================================================

  describe('safeClose', () => {
    it('should call browser.close() on normal termination', async () => {
      const mockBrowser = createMockBrowser();
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      await manager.safeClose();

      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
      expect(mockProcessKill).not.toHaveBeenCalled();
    });

    it('should call forceKill when close() fails and forceKillOnTimeout=true', async () => {
      const mockBrowser = createMockBrowser({
        pid: 12345,
        closeError: new Error('Browser close failed'),
      });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
        killGracePeriodMs: 100, // 短くしてテストを速くする
      });

      // SIGTERM送信後にプロセスがいない（ESRCH）としてモック
      mockProcessKill
        .mockImplementationOnce(() => {}) // SIGTERM成功
        .mockImplementationOnce(() => {
          // signal 0でプロセス確認 - ESRCHを投げる
          const error = new Error('No such process') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        });

      await manager.safeClose();

      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
      expect(mockProcessKill).toHaveBeenCalledWith(12345, 'SIGTERM');
    });

    it('should NOT call forceKill when close() fails and forceKillOnTimeout=false', async () => {
      const mockBrowser = createMockBrowser({
        pid: 12345,
        closeError: new Error('Browser close failed'),
      });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: false,
      });

      await manager.safeClose();

      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
      expect(mockProcessKill).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 5-6. closeWithTimeout テスト
  // =====================================================

  describe('closeWithTimeout', () => {
    it('should return true when close completes before timeout', async () => {
      const mockBrowser = createMockBrowser();
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      const result = await manager.closeWithTimeout(5000);

      expect(result).toBe(true);
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
      expect(mockProcessKill).not.toHaveBeenCalled();
    });

    it('should call forceKill and return false when close times out', async () => {
      // close()が永続的にpendingするブラウザをモック
      const mockBrowser = createMockBrowser({ pid: 12345, closeResolves: false });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
        killGracePeriodMs: 50,
      });

      // forceKill用のモック: SIGTERM後にプロセスがいない
      mockProcessKill.mockImplementation(() => {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

      const result = await manager.closeWithTimeout(100); // 100ms タイムアウト

      expect(result).toBe(false);
      expect(mockProcessKill).toHaveBeenCalledWith(12345, 'SIGTERM');
    }, 10000); // 10秒タイムアウト

    it('should not call forceKill when forceKillOnTimeout=false', async () => {
      const mockBrowser = createMockBrowser({ pid: 12345, closeResolves: false });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: false,
      });

      const result = await manager.closeWithTimeout(100);

      expect(result).toBe(false);
      expect(mockProcessKill).not.toHaveBeenCalled();
    }, 10000);
  });

  // =====================================================
  // 7-8. forceKill テスト
  // =====================================================

  describe('forceKill', () => {
    it('should send SIGTERM to browser process', async () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
        killGracePeriodMs: 50,
      });

      // signal 0でプロセスがいない（ESRCH）としてモック
      mockProcessKill
        .mockImplementationOnce(() => {}) // SIGTERM成功
        .mockImplementationOnce(() => {
          const error = new Error('No such process') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        });

      await manager.forceKill();

      expect(mockProcessKill).toHaveBeenCalledWith(12345, 'SIGTERM');
    });

    it('should send SIGKILL if process is still alive after SIGTERM', async () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
        killGracePeriodMs: 50,
      });

      // SIGTERM後もプロセスが生存 -> SIGKILL
      mockProcessKill
        .mockImplementationOnce(() => {}) // SIGTERM成功
        .mockImplementationOnce(() => {}) // signal 0 成功（まだ生存）
        .mockImplementationOnce(() => {}); // SIGKILL成功

      await manager.forceKill();

      expect(mockProcessKill).toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(mockProcessKill).toHaveBeenCalledWith(12345, 0); // isProcessAlive確認
      expect(mockProcessKill).toHaveBeenCalledWith(12345, 'SIGKILL');
    });

    it('should not send SIGKILL if process terminates after SIGTERM', async () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
        killGracePeriodMs: 50,
      });

      // SIGTERM後にプロセスが終了（ESRCH）
      mockProcessKill
        .mockImplementationOnce(() => {}) // SIGTERM成功
        .mockImplementationOnce(() => {
          const error = new Error('No such process') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        });

      await manager.forceKill();

      expect(mockProcessKill).toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(mockProcessKill).toHaveBeenCalledWith(12345, 0);
      // SIGKILLは呼ばれない
      expect(mockProcessKill).not.toHaveBeenCalledWith(12345, 'SIGKILL');
    });

    it('should handle no PID gracefully', async () => {
      const mockBrowser = createMockBrowser({ pid: null });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // エラーなしで完了するはず
      await expect(manager.forceKill()).resolves.toBeUndefined();
      expect(mockProcessKill).not.toHaveBeenCalled();
    });

    it('should handle ESRCH error gracefully (process already terminated)', async () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // 最初のSIGTERMでESRCH（プロセスが既に存在しない）
      mockProcessKill.mockImplementationOnce(() => {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

      // エラーなしで完了するはず
      await expect(manager.forceKill()).resolves.toBeUndefined();
    });
  });

  // =====================================================
  // 9. isProcessAlive テスト
  // =====================================================

  describe('isProcessAlive', () => {
    it('should return true if process exists', () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // signal 0が成功 = プロセス存在
      mockProcessKill.mockImplementation(() => {});

      // @ts-expect-error - privateメソッドへのアクセス
      const result = manager.isProcessAlive();

      expect(result).toBe(true);
      expect(mockProcessKill).toHaveBeenCalledWith(12345, 0);
    });

    it('should return false if process does not exist', () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // signal 0でESRCH = プロセス不在
      mockProcessKill.mockImplementation(() => {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

      // @ts-expect-error - privateメソッドへのアクセス
      const result = manager.isProcessAlive();

      expect(result).toBe(false);
    });

    it('should return false if PID is null', () => {
      const mockBrowser = createMockBrowser({ pid: null });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // @ts-expect-error - privateメソッドへのアクセス
      const result = manager.isProcessAlive();

      expect(result).toBe(false);
      expect(mockProcessKill).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 10. killAllChildren テスト
  // =====================================================

  describe('killAllChildren', () => {
    it('should call pkill on Linux', async () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // process.platformをLinuxに設定
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });

      mockExecSync.mockImplementation(() => Buffer.from(''));

      await manager.killAllChildren();

      // pkill -TERM と pkill -KILL が呼ばれる
      expect(mockExecSync).toHaveBeenCalledWith('pkill -TERM -P 12345 || true');
      expect(mockExecSync).toHaveBeenCalledWith('pkill -KILL -P 12345 || true');

      // プラットフォームを元に戻す
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should do nothing if no PID', async () => {
      const mockBrowser = createMockBrowser({ pid: null });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      await manager.killAllChildren();

      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('should handle pkill errors gracefully', async () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });

      mockExecSync.mockImplementation(() => {
        throw new Error('pkill failed');
      });

      // エラーなしで完了するはず
      await expect(manager.killAllChildren()).resolves.toBeUndefined();

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });

  // =====================================================
  // 統合テスト
  // =====================================================

  describe('Integration', () => {
    it('should use custom killGracePeriodMs', async () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
        killGracePeriodMs: 1000, // カスタム値
      });

      // @ts-expect-error - privateプロパティへのアクセス
      expect(manager.killGracePeriodMs).toBe(1000);
    });

    it('should default killGracePeriodMs to 5000ms', () => {
      const mockBrowser = createMockBrowser({ pid: 12345 });
      const manager = new BrowserProcessManager({
        browser: mockBrowser,
        forceKillOnTimeout: true,
      });

      // @ts-expect-error - privateプロパティへのアクセス
      expect(manager.killGracePeriodMs).toBe(5000);
    });
  });
});
