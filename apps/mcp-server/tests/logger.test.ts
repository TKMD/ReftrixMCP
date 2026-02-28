// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ロガー テスト
 * TDD Red フェーズ: ロギング機能のテスト
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Logger インターフェース
interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

// 共通のロガー作成関数（重複削減）
const createLogger = (options: { checkEnv?: boolean; addTimestamp?: boolean; module?: string } = {}): Logger => ({
  debug: (message, data) => {
    if (options.checkEnv && process.env.NODE_ENV !== 'development') return;
    const prefix = options.module ? `[${options.module}] ` : '';
    console.log(`${prefix}[DEBUG] ${message}`, data);
  },
  info: (message, data) => {
    if (options.checkEnv && process.env.NODE_ENV !== 'development') return;
    const prefix = options.module ? `[${options.module}] ` : '';
    if (options.addTimestamp) {
      const timestamp = new Date().toISOString();
      console.log(`${prefix}[INFO] [${timestamp}] ${message}`, data);
    } else {
      console.log(`${prefix}[INFO] ${message}`, data);
    }
  },
  warn: (message, data) => {
    const prefix = options.module ? `[${options.module}] ` : '';
    console.warn(`${prefix}[WARN] ${message}`, data);
  },
  error: (message, data) => {
    const prefix = options.module ? `[${options.module}] ` : '';
    if (data instanceof Error) {
      console.error(`${prefix}[ERROR] ${message}`, { message: data.message, stack: data.stack });
    } else {
      console.error(`${prefix}[ERROR] ${message}`, data);
    }
  },
});

describe('Logger', () => {
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
    vi.clearAllMocks();
  });

  describe('ログレベル', () => {
    // ログレベルテスト - describe.each でパラメータ化（重複削減）
    describe.each([
      { level: 'debug', method: 'debug' as const, spyKey: 'log' as const, message: 'Debug message', data: { test: true }, expectedPrefix: '[DEBUG]' },
      { level: 'info', method: 'info' as const, spyKey: 'log' as const, message: 'Info message', data: undefined, expectedPrefix: '[INFO]' },
      { level: 'warn', method: 'warn' as const, spyKey: 'warn' as const, message: 'Warning message', data: { code: 'W001' }, expectedPrefix: '[WARN]' },
    ])('$levelレベル', ({ method, spyKey, message, data, expectedPrefix }) => {
      it('のログが出力できること', () => {
        const logger = createLogger();
        logger[method](message, data);
        expect(consoleSpy[spyKey]).toHaveBeenCalledWith(`${expectedPrefix} ${message}`, data);
      });
    });

    it('errorレベルのログが出力できること', () => {
      const logger = createLogger();
      logger.error('Error message', new Error('Test error'));
      expect(consoleSpy.error).toHaveBeenCalledWith('[ERROR] Error message', expect.any(Object));
    });
  });

  describe('開発環境でのログ出力', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('開発環境ではすべてのログレベルが出力されること', () => {
      const logger = createLogger({ checkEnv: true });
      logger.debug('Debug in dev');
      logger.info('Info in dev');
      logger.warn('Warn in dev');
      logger.error('Error in dev');

      expect(consoleSpy.log).toHaveBeenCalledTimes(2); // debug + info
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    it('開発環境では構造化ログが出力されること', () => {
      const logger = createLogger();
      const structuredData = { requestId: 'abc123', userId: 'user456', action: 'search' };
      logger.info('User action', structuredData);
      expect(consoleSpy.log).toHaveBeenCalledWith('[INFO] User action', structuredData);
    });
  });

  describe('本番環境でのログ抑制', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    // 本番環境でのログ抑制テスト - describe.each でパラメータ化（重複削減）
    describe.each([
      { level: 'debug', method: 'debug' as const, message: 'Debug in production', shouldSuppress: true },
      { level: 'info', method: 'info' as const, message: 'Info in production', shouldSuppress: true },
    ])('$levelログ', ({ method, message, shouldSuppress }) => {
      it('が抑制されること', () => {
        const logger = createLogger({ checkEnv: true });
        logger[method](message);
        if (shouldSuppress) {
          expect(consoleSpy.log).not.toHaveBeenCalled();
        }
      });
    });

    describe.each([
      { level: 'warn', method: 'warn' as const, spyKey: 'warn' as const, message: 'Warning in production', prefix: '[WARN]' },
      { level: 'error', method: 'error' as const, spyKey: 'error' as const, message: 'Error in production', prefix: '[ERROR]' },
    ])('$levelログ', ({ method, spyKey, message, prefix }) => {
      it('は出力されること', () => {
        const logger = createLogger();
        logger[method](message);
        expect(consoleSpy[spyKey]).toHaveBeenCalledWith(`${prefix} ${message}`, undefined);
      });
    });
  });

  describe('構造化ログ形式', () => {
    it('タイムスタンプが含まれること', () => {
      const logger = createLogger({ addTimestamp: true });
      logger.info('Test message');
      expect(consoleSpy.log).toHaveBeenCalled();
      const logCall = consoleSpy.log.mock.calls[0][0] as string;
      expect(logCall).toMatch(/\[INFO\] \[\d{4}-\d{2}-\d{2}T/);
    });

    it('ログレベルが含まれること', () => {
      const logger = createLogger();
      logger.error('Error message');
      expect(consoleSpy.error).toHaveBeenCalled();
      const logCall = consoleSpy.error.mock.calls[0][0] as string;
      expect(logCall).toContain('[ERROR]');
    });

    it('追加データがJSON形式で出力されること', () => {
      const logger = createLogger();
      const data = { userId: 'user123', action: 'search' };
      logger.info('User action', data);
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('[INFO]'), data);
    });
  });

  describe('エラー特定とデバッグ支援', () => {
    it('スタックトレースが含まれること', () => {
      const logger = createLogger();
      const error = new Error('Test error');
      logger.error('An error occurred', error);
      expect(consoleSpy.error).toHaveBeenCalled();
      const errorData = consoleSpy.error.mock.calls[0][1];
      expect(errorData).toHaveProperty('stack');
    });

    it('モジュール名が含まれること', () => {
      const logger = createLogger({ module: 'MCP' });
      logger.info('Server started');
      expect(consoleSpy.log).toHaveBeenCalled();
      const logCall = consoleSpy.log.mock.calls[0][0] as string;
      expect(logCall).toContain('[MCP]');
    });

    it('コンテキスト情報が含まれること', () => {
      const logger = createLogger();
      const context = { tool: 'svg.search', query: 'test', requestId: 'req-123' };
      logger.info('Tool executed', context);
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.any(String), context);
    });
  });

  describe('パフォーマンス', () => {
    it('大量のログ出力でも性能が劣化しないこと', () => {
      const logger = createLogger();
      const iterations = 1000;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        logger.info(`Log message ${i}`, { index: i });
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000);
      expect(consoleSpy.log).toHaveBeenCalledTimes(iterations);
    });
  });
});
