// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCPProgressAdapter - MCP notifications/progress 統合テスト
 *
 * Vision CPU完走保証 Phase 4: MCPツール進捗コールバック対応
 *
 * ProgressReporterの進捗イベントをMCP SDK の sendNotification を通じて
 * notifications/progress として送信するアダプター。
 *
 * @see apps/mcp-server/src/services/vision/mcp-progress-adapter.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 実装予定のモジュールをインポート
import {
  MCPProgressAdapter,
  createMCPProgressCallback,
  type MCPProgressOptions,
  type SendNotificationFn,
} from '../../../src/services/vision/mcp-progress-adapter.js';

import type { ProgressEvent } from '../../../src/services/vision/progress-reporter.js';

describe('MCPProgressAdapter', () => {
  // モックのsendNotification関数
  let mockSendNotification: SendNotificationFn;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSendNotification = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // コンストラクタ・初期化テスト
  // ===========================================================================

  describe('constructor', () => {
    it('should create adapter with valid progressToken and sendNotification', () => {
      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token-123',
        sendNotification: mockSendNotification,
      });

      expect(adapter).toBeDefined();
      expect(adapter.getProgressToken()).toBe('test-token-123');
    });

    it('should accept string progressToken', () => {
      const adapter = new MCPProgressAdapter({
        progressToken: 'string-token',
        sendNotification: mockSendNotification,
      });

      expect(adapter.getProgressToken()).toBe('string-token');
    });

    it('should accept number progressToken', () => {
      const adapter = new MCPProgressAdapter({
        progressToken: 12345,
        sendNotification: mockSendNotification,
      });

      expect(adapter.getProgressToken()).toBe(12345);
    });

    it('should throw error if progressToken is undefined', () => {
      expect(() => {
        new MCPProgressAdapter({
          progressToken: undefined as unknown as string,
          sendNotification: mockSendNotification,
        });
      }).toThrow('progressToken is required');
    });

    it('should throw error if sendNotification is undefined', () => {
      expect(() => {
        new MCPProgressAdapter({
          progressToken: 'test-token',
          sendNotification: undefined as unknown as SendNotificationFn,
        });
      }).toThrow('sendNotification is required');
    });
  });

  // ===========================================================================
  // sendProgress テスト
  // ===========================================================================

  describe('sendProgress', () => {
    it('should send progress notification with correct format', async () => {
      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      // メッセージにphase情報が含まれている場合
      const event: ProgressEvent = {
        phase: 'analyzing',
        progress: 50,
        estimatedRemainingMs: 30000,
        message: 'analyzing: Vision AI 推論を実行しています...',
      };

      await adapter.sendProgress(event);

      expect(mockSendNotification).toHaveBeenCalledTimes(1);
      expect(mockSendNotification).toHaveBeenCalledWith({
        method: 'notifications/progress',
        params: {
          progressToken: 'test-token',
          progress: 50,
          total: 100,
          message: 'analyzing: Vision AI 推論を実行しています...',
        },
      });
    });

    it('should include phase in message if not already present', async () => {
      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      const event: ProgressEvent = {
        phase: 'preparing',
        progress: 5,
        estimatedRemainingMs: 60000,
        message: '画像を読み込んでいます',
      };

      await adapter.sendProgress(event);

      // メッセージにphase情報が含まれることを確認
      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.message).toContain('preparing');
    });

    it('should handle progress value at 0%', async () => {
      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      const event: ProgressEvent = {
        phase: 'preparing',
        progress: 0,
        estimatedRemainingMs: 120000,
        message: '開始中...',
      };

      await adapter.sendProgress(event);

      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.progress).toBe(0);
      expect(call.params.total).toBe(100);
    });

    it('should handle progress value at 100%', async () => {
      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      const event: ProgressEvent = {
        phase: 'completing',
        progress: 100,
        estimatedRemainingMs: 0,
        message: '完了しました',
      };

      await adapter.sendProgress(event);

      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.progress).toBe(100);
      expect(call.params.total).toBe(100);
    });

    it('should clamp progress value above 100 to 100', async () => {
      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      const event: ProgressEvent = {
        phase: 'completing',
        progress: 150,
        estimatedRemainingMs: 0,
        message: 'テスト',
      };

      await adapter.sendProgress(event);

      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.progress).toBe(100);
    });

    it('should clamp progress value below 0 to 0', async () => {
      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      const event: ProgressEvent = {
        phase: 'preparing',
        progress: -10,
        estimatedRemainingMs: 0,
        message: 'テスト',
      };

      await adapter.sendProgress(event);

      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.progress).toBe(0);
    });
  });

  // ===========================================================================
  // エラーハンドリング テスト
  // ===========================================================================

  describe('error handling', () => {
    it('should not throw when sendNotification fails', async () => {
      const failingNotification = vi.fn().mockRejectedValue(new Error('Network error'));

      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: failingNotification,
      });

      const event: ProgressEvent = {
        phase: 'analyzing',
        progress: 50,
        estimatedRemainingMs: 30000,
        message: 'テスト',
      };

      // エラーがスローされないことを確認（Graceful Degradation）
      await expect(adapter.sendProgress(event)).resolves.not.toThrow();
    });

    it('should log warning when sendNotification fails', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failingNotification = vi.fn().mockRejectedValue(new Error('Network error'));

      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: failingNotification,
        enableLogging: true,
      });

      const event: ProgressEvent = {
        phase: 'analyzing',
        progress: 50,
        estimatedRemainingMs: 30000,
        message: 'テスト',
      };

      await adapter.sendProgress(event);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MCPProgressAdapter]'),
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });
  });

  // ===========================================================================
  // createMCPProgressCallback ファクトリ関数テスト
  // ===========================================================================

  describe('createMCPProgressCallback', () => {
    it('should return a ProgressCallback function', () => {
      const callback = createMCPProgressCallback({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      expect(typeof callback).toBe('function');
    });

    it('should call sendNotification when callback is invoked', async () => {
      const callback = createMCPProgressCallback({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      const event: ProgressEvent = {
        phase: 'analyzing',
        progress: 50,
        estimatedRemainingMs: 30000,
        message: '分析中...',
      };

      callback(event);

      // 非同期処理を待つ
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSendNotification).toHaveBeenCalledTimes(1);
    });

    it('should return null if progressToken is not provided', () => {
      const callback = createMCPProgressCallback({
        progressToken: undefined,
        sendNotification: mockSendNotification,
      });

      expect(callback).toBeNull();
    });

    it('should return null if sendNotification is not provided', () => {
      const callback = createMCPProgressCallback({
        progressToken: 'test-token',
        sendNotification: undefined,
      });

      expect(callback).toBeNull();
    });
  });

  // ===========================================================================
  // isProgressEnabled ユーティリティテスト
  // ===========================================================================

  describe('isProgressEnabled', () => {
    it('should return true when progressToken and sendNotification are provided', () => {
      const adapter = new MCPProgressAdapter({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      expect(adapter.isEnabled()).toBe(true);
    });
  });

  // ===========================================================================
  // 統合テスト: ProgressReporterとの連携
  // ===========================================================================

  describe('integration with ProgressReporter', () => {
    it('should work as ProgressReporter callback', async () => {
      const callback = createMCPProgressCallback({
        progressToken: 'test-token',
        sendNotification: mockSendNotification,
      });

      // ProgressReporterに渡すのと同じ形式でコールバックを呼び出し
      const events: ProgressEvent[] = [
        { phase: 'preparing', progress: 5, estimatedRemainingMs: 60000, message: '準備中' },
        { phase: 'optimizing', progress: 20, estimatedRemainingMs: 50000, message: '最適化中' },
        { phase: 'analyzing', progress: 50, estimatedRemainingMs: 30000, message: '分析中' },
        { phase: 'completing', progress: 100, estimatedRemainingMs: 0, message: '完了' },
      ];

      for (const event of events) {
        callback!(event);
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(mockSendNotification).toHaveBeenCalledTimes(4);

      // 各呼び出しの進捗値を検証
      const calls = mockSendNotification.mock.calls;
      expect(calls[0][0].params.progress).toBe(5);
      expect(calls[1][0].params.progress).toBe(20);
      expect(calls[2][0].params.progress).toBe(50);
      expect(calls[3][0].params.progress).toBe(100);
    });
  });
});
