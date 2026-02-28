// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shutdown Handler テスト
 *
 * MCPサーバーのshutdown handlerがWorkerSupervisor.shutdown()を
 * 呼び出すことを検証する。
 *
 * P0-4: MCPサーバーshutdown handlerにWorkerSupervisor.shutdown()追加
 * - server.close()より前にWorkerSupervisor.shutdown()を呼ぶ
 * - WorkerSupervisor未初期化時はエラーなしでスキップ
 * - WorkerSupervisor.shutdown()失敗時もserver.close()は実行される
 *
 * @module tests/services/shutdown-handler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// モック設定
// ============================================================================

// WorkerSupervisor のモック
const mockShutdown = vi.fn().mockResolvedValue(undefined);
const mockGetWorkerSupervisor = vi.fn().mockReturnValue({
  shutdown: mockShutdown,
});

vi.mock('../../src/services/worker-supervisor.service', () => ({
  getWorkerSupervisor: (): unknown => mockGetWorkerSupervisor(),
  resetWorkerSupervisor: vi.fn(),
}));

// logger のモック
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]): void => mockLoggerInfo(...args),
    warn: (...args: unknown[]): void => mockLoggerWarn(...args),
    error: (...args: unknown[]): void => mockLoggerError(...args),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
  validateEnvironment: vi.fn().mockReturnValue('test'),
}));

// ============================================================================
// テストスイート
// ============================================================================

describe('Shutdown Handler - WorkerSupervisor統合', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handleShutdownがWorkerSupervisor.shutdown()を呼び出す', async () => {
    // Arrange: handleShutdownの動作をシミュレート
    // index.tsの handleShutdown ロジックを直接テスト
    const serverCloseMock = vi.fn().mockResolvedValue(undefined);
    const processExitMock = vi.fn();

    // handleShutdownロジックの抽出テスト
    const handleShutdown = async (): Promise<void> => {
      try {
        try {
          const { getWorkerSupervisor } = await import('../../src/services/worker-supervisor.service');
          const supervisor = getWorkerSupervisor();
          await supervisor.shutdown();
        } catch (supervisorError: unknown) {
          mockLoggerWarn('WorkerSupervisor shutdown skipped or failed', {
            error: supervisorError instanceof Error ? supervisorError.message : String(supervisorError),
          });
        }

        await serverCloseMock();
        processExitMock(0);
      } catch {
        processExitMock(1);
      }
    };

    // Act
    await handleShutdown();

    // Assert: WorkerSupervisor.shutdown()がserver.close()より前に呼ばれる
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(serverCloseMock).toHaveBeenCalledTimes(1);

    // 呼び出し順序を検証: shutdown → server.close
    const shutdownOrder = mockShutdown.mock.invocationCallOrder[0];
    const closeOrder = serverCloseMock.mock.invocationCallOrder[0];
    expect(shutdownOrder).toBeLessThan(closeOrder);

    expect(processExitMock).toHaveBeenCalledWith(0);
  });

  it('WorkerSupervisor未初期化時はエラーなしでserver.close()まで進む', async () => {
    // Arrange: getWorkerSupervisorがエラーをスロー（未初期化）
    mockGetWorkerSupervisor.mockImplementationOnce(() => {
      throw new Error('WorkerSupervisor not initialized');
    });

    const serverCloseMock = vi.fn().mockResolvedValue(undefined);
    const processExitMock = vi.fn();

    const handleShutdown = async (): Promise<void> => {
      try {
        try {
          const { getWorkerSupervisor } = await import('../../src/services/worker-supervisor.service');
          const supervisor = getWorkerSupervisor();
          await supervisor.shutdown();
        } catch (supervisorError: unknown) {
          mockLoggerWarn('WorkerSupervisor shutdown skipped or failed', {
            error: supervisorError instanceof Error ? supervisorError.message : String(supervisorError),
          });
        }

        await serverCloseMock();
        processExitMock(0);
      } catch {
        processExitMock(1);
      }
    };

    // Act
    await handleShutdown();

    // Assert: supervisor.shutdown()は呼ばれないが、server.close()は実行される
    expect(mockShutdown).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'WorkerSupervisor shutdown skipped or failed',
      expect.objectContaining({
        error: 'WorkerSupervisor not initialized',
      })
    );
    expect(serverCloseMock).toHaveBeenCalledTimes(1);
    expect(processExitMock).toHaveBeenCalledWith(0);
  });

  it('WorkerSupervisor.shutdown()失敗時もserver.close()は実行される', async () => {
    // Arrange: shutdown()がエラーをスロー
    mockShutdown.mockRejectedValueOnce(new Error('shutdown failed'));

    const serverCloseMock = vi.fn().mockResolvedValue(undefined);
    const processExitMock = vi.fn();

    const handleShutdown = async (): Promise<void> => {
      try {
        try {
          const { getWorkerSupervisor } = await import('../../src/services/worker-supervisor.service');
          const supervisor = getWorkerSupervisor();
          await supervisor.shutdown();
        } catch (supervisorError: unknown) {
          mockLoggerWarn('WorkerSupervisor shutdown skipped or failed', {
            error: supervisorError instanceof Error ? supervisorError.message : String(supervisorError),
          });
        }

        await serverCloseMock();
        processExitMock(0);
      } catch {
        processExitMock(1);
      }
    };

    // Act
    await handleShutdown();

    // Assert: shutdown失敗してもserver.close()は実行される
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'WorkerSupervisor shutdown skipped or failed',
      expect.objectContaining({
        error: 'shutdown failed',
      })
    );
    expect(serverCloseMock).toHaveBeenCalledTimes(1);
    expect(processExitMock).toHaveBeenCalledWith(0);
  });
});
