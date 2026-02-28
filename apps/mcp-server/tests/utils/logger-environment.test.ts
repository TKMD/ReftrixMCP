// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 環境判定関数のセキュリティ強化テスト
 *
 * TDD Red フェーズ: NODE_ENV 未設定/無効値時のセキュリティリスクを検出
 *
 * セキュリティリスク:
 * - NODE_ENV 未設定時に development にフォールバックすると、本番サーバーで
 *   テスト用APIキーが有効になる（auth.ts:261）
 * - NODE_ENV に typo があると同様の問題（例: "prodution"）
 *
 * 期待される動作:
 * - NODE_ENV 未設定/無効値の場合は production 相当の安全なフォールバック
 * - isDevelopment() は明示的に 'development' の場合のみ true を返す
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isDevelopment,
  isTest,
  // 注: isProductionEnvironment は現在未実装
  // 将来の実装で追加される予定
} from '../../src/utils/logger.js';

describe('環境判定関数 - セキュリティ強化テスト', () => {
  // 元の NODE_ENV を保存
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    // 各テスト前に環境変数をクリア
    vi.resetModules();
  });

  afterEach(() => {
    // テスト後に環境変数を復元
    process.env.NODE_ENV = originalNodeEnv;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe('NODE_ENV フォールバック動作テスト', () => {
    describe('正常な値の場合', () => {
      it('NODE_ENV="production" の場合、isDevelopment() は false を返すこと', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');

        // モジュールを再読み込みして環境変数の変更を反映
        const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

        // Act
        const result = isDev();

        // Assert
        expect(result).toBe(false);
      });

      it('NODE_ENV="production" の場合、isTest() は false を返すこと', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');

        const { isTest: isTestEnv } = await import('../../src/utils/logger.js');

        // Act
        const result = isTestEnv();

        // Assert
        expect(result).toBe(false);
      });

      it('NODE_ENV="development" の場合、isDevelopment() は true を返すこと', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'development');

        const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

        // Act
        const result = isDev();

        // Assert
        expect(result).toBe(true);
      });

      it('NODE_ENV="test" の場合、isTest() は true を返すこと', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'test');

        const { isTest: isTestEnv } = await import('../../src/utils/logger.js');

        // Act
        const result = isTestEnv();

        // Assert
        expect(result).toBe(true);
      });

      it('NODE_ENV="test" の場合、isDevelopment() は false を返すこと', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'test');

        const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

        // Act
        const result = isDev();

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('未設定の場合（セキュリティクリティカル）', () => {
      it('NODE_ENV 未設定時、isDevelopment() は false を返すこと（安全なフォールバック）', async () => {
        // Arrange
        // NODE_ENV を完全に削除
        delete process.env.NODE_ENV;

        const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

        // Act
        const result = isDev();

        // Assert
        // セキュリティ要件: 未設定時は development として扱わない
        // 現在の実装では development にフォールバックするため、このテストは失敗する
        expect(result).toBe(false);
      });

      it('NODE_ENV 未設定時、isTest() は false を返すこと', async () => {
        // Arrange
        delete process.env.NODE_ENV;

        const { isTest: isTestEnv } = await import('../../src/utils/logger.js');

        // Act
        const result = isTestEnv();

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('空文字列の場合（セキュリティクリティカル）', () => {
      it('NODE_ENV="" の場合、isDevelopment() は false を返すこと（安全なフォールバック）', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', '');

        const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

        // Act
        const result = isDev();

        // Assert
        // セキュリティ要件: 空文字列は development として扱わない
        // 現在の実装では development にフォールバックするため、このテストは失敗する
        expect(result).toBe(false);
      });

      it('NODE_ENV="" の場合、isTest() は false を返すこと', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', '');

        const { isTest: isTestEnv } = await import('../../src/utils/logger.js');

        // Act
        const result = isTestEnv();

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('無効な値の場合（セキュリティクリティカル）', () => {
      // 無効な値のパターン
      const invalidValues = [
        'prodution', // typo: production
        'developement', // typo: development
        'dev',
        'prod',
        'staging',
        'PRODUCTION', // 大文字
        'DEVELOPMENT', // 大文字
        'Production', // 先頭大文字
        ' production', // 先頭スペース
        'production ', // 末尾スペース
        'unknown',
        '1',
        'true',
        'false',
      ];

      it.each(invalidValues)(
        'NODE_ENV="%s" の場合、isDevelopment() は false を返すこと（安全なフォールバック）',
        async (invalidValue) => {
          // Arrange
          vi.stubEnv('NODE_ENV', invalidValue);

          const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

          // Act
          const result = isDev();

          // Assert
          // セキュリティ要件: 無効な値は development として扱わない
          // 現在の実装では development にフォールバックするため、このテストは失敗する
          expect(result).toBe(false);
        }
      );

      it.each(invalidValues)(
        'NODE_ENV="%s" の場合、isTest() は false を返すこと',
        async (invalidValue) => {
          // Arrange
          vi.stubEnv('NODE_ENV', invalidValue);

          const { isTest: isTestEnv } = await import('../../src/utils/logger.js');

          // Act
          const result = isTestEnv();

          // Assert
          expect(result).toBe(false);
        }
      );
    });
  });

  describe('セキュリティ検証テスト', () => {
    describe('本番環境でのテスト用APIキー無効化', () => {
      it('NODE_ENV 未設定時、テスト用APIキーが無効化されること（isDevelopment() = false）', async () => {
        // Arrange
        delete process.env.NODE_ENV;

        const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

        // Act
        const isDevMode = isDev();

        // Assert
        // auth.ts:261 で isDevelopment() が true の場合にテスト用APIキーが有効になる
        // 本番サーバーでNODE_ENV未設定の場合、テスト用APIキーを無効化する必要がある
        expect(isDevMode).toBe(false);
        // このテストが失敗する = セキュリティリスクが存在
      });

      it('NODE_ENV 無効値時、テスト用APIキーが無効化されること（isDevelopment() = false）', async () => {
        // Arrange
        // よくある typo: "prodution" (c が抜けている)
        vi.stubEnv('NODE_ENV', 'prodution');

        const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

        // Act
        const isDevMode = isDev();

        // Assert
        // typo があっても production 相当として扱い、テスト用APIキーを無効化する
        expect(isDevMode).toBe(false);
        // 現在の実装では development にフォールバックするため、このテストは失敗する
      });

      it('NODE_ENV 大文字/小文字の違いでテスト用APIキーが有効にならないこと', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'DEVELOPMENT');

        const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

        // Act
        const isDevMode = isDev();

        // Assert
        // 'DEVELOPMENT' は 'development' ではないので development として扱わない
        expect(isDevMode).toBe(false);
        // 現在の実装では development にフォールバックするため、このテストは失敗する
      });
    });

    describe('本番環境判定の堅牢性', () => {
      it('NODE_ENV="production" のみが本番環境として認識されること', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');

        const { isDevelopment: isDev, isTest: isTestEnv } = await import('../../src/utils/logger.js');

        // Act
        const isDevMode = isDev();
        const isTestMode = isTestEnv();

        // Assert
        expect(isDevMode).toBe(false);
        expect(isTestMode).toBe(false);
        // production 環境では isDevelopment も isTest も false
      });

      it('開発環境は明示的な "development" のみで有効になること', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'development');

        const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

        // Act
        const isDevMode = isDev();

        // Assert
        expect(isDevMode).toBe(true);
        // 明示的な 'development' のみが開発環境として認識される
      });

      it('テスト環境は明示的な "test" のみで有効になること', async () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'test');

        const { isTest: isTestEnv, isDevelopment: isDev } = await import('../../src/utils/logger.js');

        // Act
        const isTestMode = isTestEnv();
        const isDevMode = isDev();

        // Assert
        expect(isTestMode).toBe(true);
        expect(isDevMode).toBe(false);
        // 明示的な 'test' のみがテスト環境として認識される
      });
    });
  });

  describe('エッジケースと境界値テスト', () => {
    it('NODE_ENV に null 相当の文字列 "null" が設定された場合、isDevelopment() は false', async () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'null');

      const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

      // Act
      const result = isDev();

      // Assert
      expect(result).toBe(false);
    });

    it('NODE_ENV に undefined 相当の文字列 "undefined" が設定された場合、isDevelopment() は false', async () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'undefined');

      const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

      // Act
      const result = isDev();

      // Assert
      expect(result).toBe(false);
    });

    it('NODE_ENV に空白文字のみが設定された場合、isDevelopment() は false', async () => {
      // Arrange
      vi.stubEnv('NODE_ENV', '   ');

      const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

      // Act
      const result = isDev();

      // Assert
      // 空白文字のみは development として扱わない
      expect(result).toBe(false);
    });

    it('NODE_ENV の前後にタブ文字がある場合、trim() されて development として扱われる', async () => {
      // Arrange
      vi.stubEnv('NODE_ENV', '\tdevelopment\t');

      const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

      // Act
      const result = isDev();

      // Assert
      // 前後のタブは trim() で除去されるため、development として扱われる
      // これは一般的なプラクティスであり、セキュリティ上問題なし
      expect(result).toBe(true);
    });

    it('NODE_ENV の後ろに改行文字がある場合、trim() されて development として扱われる', async () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'development\n');

      const { isDevelopment: isDev } = await import('../../src/utils/logger.js');

      // Act
      const result = isDev();

      // Assert
      // 後ろの改行は trim() で除去されるため、development として扱われる
      // これは一般的なプラクティスであり、セキュリティ上問題なし
      expect(result).toBe(true);
    });
  });

  describe('isProductionEnvironment() 関数テスト', () => {
    it('NODE_ENV="production" の場合、isProductionEnvironment() は true を返すこと', async () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');

      const { isProductionEnvironment } = await import('../../src/utils/logger.js');

      // Act
      const result = isProductionEnvironment();

      // Assert
      expect(result).toBe(true);
    });

    it('NODE_ENV 未設定の場合、isProductionEnvironment() は true を返すこと（安全なフォールバック）', async () => {
      // Arrange
      delete process.env.NODE_ENV;

      const { isProductionEnvironment } = await import('../../src/utils/logger.js');

      // Act
      const result = isProductionEnvironment();

      // Assert
      // セキュリティ要件: 未設定時は production として扱う
      expect(result).toBe(true);
    });

    it('NODE_ENV 無効値の場合、isProductionEnvironment() は true を返すこと（安全なフォールバック）', async () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'invalid');

      const { isProductionEnvironment } = await import('../../src/utils/logger.js');

      // Act
      const result = isProductionEnvironment();

      // Assert
      // セキュリティ要件: 無効値は production として扱う
      expect(result).toBe(true);
    });
  });
});
