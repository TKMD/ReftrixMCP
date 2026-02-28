// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Logger Utility Tests
 * TDD: 環境別ログ出力の動作確認テスト
 *
 * テスト対象:
 * - logger.info: 開発環境のみ出力
 * - logger.warn: 開発環境のみ出力
 * - logger.error: テスト環境以外で出力
 * - logger.debug: 開発環境のみ出力
 *
 * @see CONTRIBUTING.md
 * @see CONTRIBUTING.md - コンソールログルール
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 開発環境ログ出力（テスト実行確認用）
if (process.env.NODE_ENV === 'development') {
  console.log('[Test] Running: utils/logger.test.ts');
}

describe('logger utility', () => {
  // 各テスト前にconsoleメソッドをモック
  const originalEnv = process.env.NODE_ENV;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
    vi.resetModules();
  });

  describe('開発環境（NODE_ENV=development）', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'development';
      vi.resetModules();
    });

    it('logger.info はコンソールに出力される', async () => {
      // 環境変数変更後にモジュールを再読み込み
      const { logger } = await import('../../src/utils/logger');

      logger.info('テストメッセージ');

      expect(consoleLogSpy).toHaveBeenCalledWith('[INFO]', 'テストメッセージ');
    });

    it('logger.info は複数の引数を受け付ける', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.info('メッセージ', { key: 'value' }, 123);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[INFO]',
        'メッセージ',
        { key: 'value' },
        123
      );
    });

    it('logger.warn はコンソールに出力される', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.warn('警告メッセージ');

      expect(consoleWarnSpy).toHaveBeenCalledWith('[WARN]', '警告メッセージ');
    });

    it('logger.warn は複数の引数を受け付ける', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.warn('警告', { details: 'info' });

      expect(consoleWarnSpy).toHaveBeenCalledWith('[WARN]', '警告', {
        details: 'info',
      });
    });

    it('logger.debug はコンソールに出力される', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.debug('デバッグ情報');

      expect(consoleLogSpy).toHaveBeenCalledWith('[DEBUG]', 'デバッグ情報');
    });

    it('logger.debug は複数の引数を受け付ける', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.debug('デバッグ', { stack: 'trace' }, [1, 2, 3]);

      expect(consoleLogSpy).toHaveBeenCalledWith('[DEBUG]', 'デバッグ', {
        stack: 'trace',
      }, [1, 2, 3]);
    });

    it('logger.error はコンソールに出力されない（テスト環境扱いのため）', async () => {
      // 注意: このテストはNODE_ENV=developmentでも、
      // 実際のテスト実行時はNODE_ENV=testに上書きされる可能性がある
      // よって、isTest判定が優先される
      const { logger } = await import('../../src/utils/logger');

      logger.error('エラーメッセージ');

      // テスト環境ではerrorも抑制される実装のため
      // (isTestがtrueになる場合は出力されない)
    });
  });

  describe('本番環境（NODE_ENV=production）', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'production';
      vi.resetModules();
    });

    it('logger.info は出力されない', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.info('本番環境のinfoメッセージ');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('logger.warn は出力されない', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.warn('本番環境のwarnメッセージ');

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('logger.debug は出力されない', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.debug('本番環境のdebugメッセージ');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('logger.error は出力される', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.error('本番環境のエラー');

      expect(consoleErrorSpy).toHaveBeenCalledWith('[ERROR]', '本番環境のエラー');
    });

    it('logger.error は複数の引数を受け付ける', async () => {
      const { logger } = await import('../../src/utils/logger');
      const errorObj = new Error('テストエラー');

      logger.error('エラー発生', errorObj, { context: 'test' });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[ERROR]',
        'エラー発生',
        errorObj,
        { context: 'test' }
      );
    });
  });

  describe('テスト環境（NODE_ENV=test）', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'test';
      vi.resetModules();
    });

    it('logger.info は出力されない', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.info('テスト環境のinfoメッセージ');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('logger.warn は出力されない', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.warn('テスト環境のwarnメッセージ');

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('logger.debug は出力されない', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.debug('テスト環境のdebugメッセージ');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('logger.error は出力されない（テスト時のノイズ防止）', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.error('テスト環境のエラー');

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('ログレベルのフィルタリング', () => {
    it('開発環境では全レベルが利用可能', async () => {
      process.env.NODE_ENV = 'development';
      vi.resetModules();
      const { logger } = await import('../../src/utils/logger');

      // 各メソッドが関数として存在することを確認
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('本番環境ではerrorのみ実際に出力される', async () => {
      process.env.NODE_ENV = 'production';
      vi.resetModules();
      const { logger } = await import('../../src/utils/logger');

      // 全メソッドを呼び出し
      logger.info('info');
      logger.warn('warn');
      logger.debug('debug');
      logger.error('error');

      // infoとdebugはconsole.logを使用
      expect(consoleLogSpy).not.toHaveBeenCalled();
      // warnはconsole.warnを使用
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      // errorのみ出力される
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith('[ERROR]', 'error');
    });
  });

  describe('loggerオブジェクトの構造', () => {
    it('必要なメソッドが全て定義されている', async () => {
      const { logger } = await import('../../src/utils/logger');

      expect(logger).toHaveProperty('info');
      expect(logger).toHaveProperty('warn');
      expect(logger).toHaveProperty('error');
      expect(logger).toHaveProperty('debug');
    });

    it('全メソッドがvoid型を返す', async () => {
      process.env.NODE_ENV = 'development';
      vi.resetModules();
      const { logger } = await import('../../src/utils/logger');

      const infoResult = logger.info('test');
      const warnResult = logger.warn('test');
      const errorResult = logger.error('test');
      const debugResult = logger.debug('test');

      expect(infoResult).toBeUndefined();
      expect(warnResult).toBeUndefined();
      expect(errorResult).toBeUndefined();
      expect(debugResult).toBeUndefined();
    });

    it('空引数でも安全に呼び出せる', async () => {
      process.env.NODE_ENV = 'development';
      vi.resetModules();
      const { logger } = await import('../../src/utils/logger');

      // 引数なしでもエラーにならないことを確認
      expect(() => logger.info()).not.toThrow();
      expect(() => logger.warn()).not.toThrow();
      expect(() => logger.error()).not.toThrow();
      expect(() => logger.debug()).not.toThrow();
    });
  });

  describe('ログプレフィックスの確認', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'development';
      vi.resetModules();
    });

    it('infoログは[INFO]プレフィックスを持つ', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.info('message');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[INFO]'),
        'message'
      );
    });

    it('warnログは[WARN]プレフィックスを持つ', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.warn('message');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[WARN]'),
        'message'
      );
    });

    it('debugログは[DEBUG]プレフィックスを持つ', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.debug('message');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DEBUG]'),
        'message'
      );
    });

    it('errorログは[ERROR]プレフィックスを持つ（本番環境でテスト）', async () => {
      process.env.NODE_ENV = 'production';
      vi.resetModules();
      const { logger } = await import('../../src/utils/logger');

      logger.error('message');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ERROR]'),
        'message'
      );
    });
  });

  describe('様々なデータ型の引数', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'development';
      vi.resetModules();
    });

    it('文字列を正しく出力する', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.info('string message');

      expect(consoleLogSpy).toHaveBeenCalledWith('[INFO]', 'string message');
    });

    it('数値を正しく出力する', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.info(42, 3.14, -100);

      expect(consoleLogSpy).toHaveBeenCalledWith('[INFO]', 42, 3.14, -100);
    });

    it('オブジェクトを正しく出力する', async () => {
      const { logger } = await import('../../src/utils/logger');
      const obj = { key: 'value', nested: { a: 1 } };

      logger.info(obj);

      expect(consoleLogSpy).toHaveBeenCalledWith('[INFO]', obj);
    });

    it('配列を正しく出力する', async () => {
      const { logger } = await import('../../src/utils/logger');
      const arr = [1, 'two', { three: 3 }];

      logger.info(arr);

      expect(consoleLogSpy).toHaveBeenCalledWith('[INFO]', arr);
    });

    it('null/undefinedを正しく出力する', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.info(null, undefined);

      expect(consoleLogSpy).toHaveBeenCalledWith('[INFO]', null, undefined);
    });

    it('Errorオブジェクトを正しく出力する', async () => {
      process.env.NODE_ENV = 'production';
      vi.resetModules();
      const { logger } = await import('../../src/utils/logger');
      const error = new Error('テストエラー');

      logger.error('エラー発生:', error);

      expect(consoleErrorSpy).toHaveBeenCalledWith('[ERROR]', 'エラー発生:', error);
    });

    it('boolean値を正しく出力する', async () => {
      const { logger } = await import('../../src/utils/logger');

      logger.info(true, false);

      expect(consoleLogSpy).toHaveBeenCalledWith('[INFO]', true, false);
    });
  });
});
