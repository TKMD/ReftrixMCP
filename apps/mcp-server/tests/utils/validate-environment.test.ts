// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * validateEnvironment() 関数のテスト
 *
 * TDD Red フェーズ: 環境変数検証機能のテスト（実装前）
 *
 * セキュリティ要件:
 * - NODE_ENV が未設定または空文字の場合、明示的なエラーをスローして起動を阻止
 * - NODE_ENV が不正な値の場合、警告ログを出力するが起動は許可
 *
 * 対象ファイル: apps/mcp-server/src/utils/logger.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { validateEnvironment } from '../../src/utils/logger.js';

// =============================================================================
// 共通ヘルパー・ファクトリー（重複削減）
// =============================================================================

// 元の NODE_ENV を保存
const originalNodeEnv = process.env.NODE_ENV;

// 共通スパイ設定（重複削減）
const setupSpies = () => ({
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
});

const restoreSpies = (spies: { warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> }) => {
  spies.warn.mockRestore();
  spies.error.mockRestore();
};

// 警告ログ検証ヘルパー（重複削減）
const hasWarningLog = (spies: { warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> }) => {
  const warnCalled = spies.warn.mock.calls.length > 0;
  const errorCalled = spies.error.mock.calls.some((call) =>
    call.some((arg) => typeof arg === 'string' && arg.includes('WARN'))
  );
  return warnCalled || errorCalled;
};

// =============================================================================
// テストケース定義
// =============================================================================

describe('validateEnvironment - NODE_ENV環境変数の検証', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // ---------------------------------------------------------------------------
  // 異常系: エラーをスローするケース（パラメータ化・重複削減）
  // ---------------------------------------------------------------------------
  describe.each([
    { name: 'undefined', setup: () => delete process.env.NODE_ENV },
    { name: '空文字', setup: () => vi.stubEnv('NODE_ENV', '') },
    { name: '空白文字のみ', setup: () => vi.stubEnv('NODE_ENV', '   ') },
  ])('NODE_ENVが$nameの場合', ({ setup }) => {
    it('エラーをスローすること', () => {
      setup();
      expect(() => validateEnvironment()).toThrow();
    });
  });

  it('エラーメッセージに "NODE_ENV" が含まれること', () => {
    delete process.env.NODE_ENV;
    expect(() => validateEnvironment()).toThrowError(/NODE_ENV/);
  });

  // ---------------------------------------------------------------------------
  // 正常系: 有効な値の場合（パラメータ化・重複削減）
  // ---------------------------------------------------------------------------
  describe.each(['development', 'production', 'test'])('NODE_ENVが "%s" の場合', (env) => {
    it('正常に通過すること', () => {
      vi.stubEnv('NODE_ENV', env);
      expect(() => validateEnvironment()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 警告系: 不正な値だが起動は許可するケース（パラメータ化・重複削減）
  // ---------------------------------------------------------------------------
  describe.each([
    { value: 'staging', description: 'stagingの場合' },
    { value: 'dev', description: 'devの場合' },
    { value: 'prod', description: 'prodの場合' },
    { value: 'prodution', description: 'typo "prodution"の場合' },
    { value: 'developement', description: 'typo "developement"の場合' },
  ])('NODE_ENVが$description', ({ value }) => {
    it('警告ログを出すが正常に通過すること', () => {
      vi.stubEnv('NODE_ENV', value);
      const spies = setupSpies();

      expect(() => validateEnvironment()).not.toThrow();
      expect(hasWarningLog(spies)).toBe(true);

      restoreSpies(spies);
    });
  });

  // ---------------------------------------------------------------------------
  // 警告メッセージの検証
  // ---------------------------------------------------------------------------
  describe('警告メッセージの内容', () => {
    it('警告メッセージに NODE_ENV の値が含まれること', () => {
      const invalidValue = 'staging';
      vi.stubEnv('NODE_ENV', invalidValue);
      const spies = setupSpies();

      validateEnvironment();

      const hasValueInMessage = spies.error.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes(invalidValue))
      );
      expect(hasValueInMessage).toBe(true);

      restoreSpies(spies);
    });

    it('警告メッセージに有効な値のリストが含まれること', () => {
      vi.stubEnv('NODE_ENV', 'invalid');
      const spies = setupSpies();

      validateEnvironment();

      const hasValidValuesHint = spies.error.mock.calls.some((call) =>
        call.some((arg) =>
          typeof arg === 'string' &&
          (arg.includes('development') || arg.includes('production') || arg.includes('test'))
        )
      );
      expect(hasValidValuesHint).toBe(true);

      restoreSpies(spies);
    });
  });

  // ---------------------------------------------------------------------------
  // エッジケース（パラメータ化・重複削減）
  // ---------------------------------------------------------------------------
  describe('エッジケース', () => {
    it('NODE_ENV の前後に空白がある場合、trim()されて正常に処理されること', () => {
      vi.stubEnv('NODE_ENV', '  development  ');
      const spies = setupSpies();

      expect(() => validateEnvironment()).not.toThrow();
      expect(spies.warn).not.toHaveBeenCalled();

      restoreSpies(spies);
    });

    describe.each([
      { value: 'DEVELOPMENT', description: '大文字 "DEVELOPMENT"' },
      { value: '1', description: '数値文字列 "1"' },
    ])('NODE_ENVが$descriptionの場合', ({ value }) => {
      it('警告ログを出すが正常に通過すること', () => {
        vi.stubEnv('NODE_ENV', value);
        const spies = setupSpies();

        expect(() => validateEnvironment()).not.toThrow();
        expect(hasWarningLog(spies)).toBe(true);

        restoreSpies(spies);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 戻り値の検証
  // ---------------------------------------------------------------------------
  describe('戻り値の検証', () => {
    it('有効な値の場合、現在の環境を返すこと', () => {
      vi.stubEnv('NODE_ENV', 'development');
      expect(validateEnvironment()).toBe('development');
    });

    it('不正な値の場合、"production" を返すこと（安全なフォールバック）', () => {
      vi.stubEnv('NODE_ENV', 'invalid');
      vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(validateEnvironment()).toBe('production');
    });
  });
});

// =============================================================================
// TDD Red フェーズ確認テスト
// =============================================================================

describe('TDD Red: validateEnvironment関数の存在確認', () => {
  it('validateEnvironment 関数が定義されていること', () => {
    expect(validateEnvironment).toBeDefined();
    expect(typeof validateEnvironment).toBe('function');
  });
});
