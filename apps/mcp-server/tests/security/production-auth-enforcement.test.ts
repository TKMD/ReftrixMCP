// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP-AUTH-01: 本番環境での認証強制テスト
 *
 * セキュリティ要件:
 * - NODE_ENV=production かつ MCP_AUTH_ENABLED!==true の場合、起動失敗
 * - MCP_ALLOW_INSECURE_PRODUCTION=true で明示的に回避可能（非推奨）
 *
 * @module security/production-auth-enforcement.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  assertProductionAuthEnabled,
  isMcpAuthEnabled,
  isInsecureProductionAllowed,
  isProductionEnvironment,
  ProductionAuthRequiredError,
  ProductionCategoryRequiredError,
  assertProductionRequiredCategoriesInitialized,
  REQUIRED_CATEGORIES_FOR_PRODUCTION,
} from '../../src/services/production-guard';

// モックLogger（循環依存回避）
vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

describe('MCP-AUTH-01: 本番環境での認証強制', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isProductionEnvironment', () => {
    it('NODE_ENV=production の場合 true を返す', () => {
      process.env.NODE_ENV = 'production';
      expect(isProductionEnvironment()).toBe(true);
    });

    it('NODE_ENV=development の場合 false を返す', () => {
      process.env.NODE_ENV = 'development';
      expect(isProductionEnvironment()).toBe(false);
    });

    it('NODE_ENV が未設定の場合 false を返す', () => {
      delete process.env.NODE_ENV;
      expect(isProductionEnvironment()).toBe(false);
    });
  });

  describe('isMcpAuthEnabled', () => {
    it('MCP_AUTH_ENABLED=true の場合 true を返す', () => {
      process.env.MCP_AUTH_ENABLED = 'true';
      expect(isMcpAuthEnabled()).toBe(true);
    });

    it('MCP_AUTH_ENABLED=false の場合 false を返す', () => {
      process.env.MCP_AUTH_ENABLED = 'false';
      expect(isMcpAuthEnabled()).toBe(false);
    });

    it('MCP_AUTH_ENABLED が未設定の場合 false を返す', () => {
      delete process.env.MCP_AUTH_ENABLED;
      expect(isMcpAuthEnabled()).toBe(false);
    });

    it('MCP_AUTH_ENABLED=TRUE (大文字) の場合 false を返す（厳密比較）', () => {
      process.env.MCP_AUTH_ENABLED = 'TRUE';
      expect(isMcpAuthEnabled()).toBe(false);
    });
  });

  describe('isInsecureProductionAllowed', () => {
    it('MCP_ALLOW_INSECURE_PRODUCTION=true の場合 true を返す', () => {
      process.env.MCP_ALLOW_INSECURE_PRODUCTION = 'true';
      expect(isInsecureProductionAllowed()).toBe(true);
    });

    it('MCP_ALLOW_INSECURE_PRODUCTION が未設定の場合 false を返す', () => {
      delete process.env.MCP_ALLOW_INSECURE_PRODUCTION;
      expect(isInsecureProductionAllowed()).toBe(false);
    });
  });

  describe('assertProductionAuthEnabled', () => {
    describe('開発環境での動作', () => {
      it('NODE_ENV=development の場合は認証無効でもエラーにならない', () => {
        process.env.NODE_ENV = 'development';
        process.env.MCP_AUTH_ENABLED = 'false';

        expect(() => assertProductionAuthEnabled()).not.toThrow();
      });

      it('NODE_ENV が未設定の場合はエラーにならない', () => {
        delete process.env.NODE_ENV;
        delete process.env.MCP_AUTH_ENABLED;

        expect(() => assertProductionAuthEnabled()).not.toThrow();
      });
    });

    describe('本番環境での動作', () => {
      beforeEach(() => {
        process.env.NODE_ENV = 'production';
      });

      it('認証有効時はエラーにならない', () => {
        process.env.MCP_AUTH_ENABLED = 'true';

        expect(() => assertProductionAuthEnabled()).not.toThrow();
      });

      it('認証無効時は ProductionAuthRequiredError をスロー', () => {
        process.env.MCP_AUTH_ENABLED = 'false';

        expect(() => assertProductionAuthEnabled()).toThrow(ProductionAuthRequiredError);
      });

      it('認証未設定時は ProductionAuthRequiredError をスロー', () => {
        delete process.env.MCP_AUTH_ENABLED;

        expect(() => assertProductionAuthEnabled()).toThrow(ProductionAuthRequiredError);
      });

      it('MCP_ALLOW_INSECURE_PRODUCTION=true で回避可能', () => {
        process.env.MCP_AUTH_ENABLED = 'false';
        process.env.MCP_ALLOW_INSECURE_PRODUCTION = 'true';

        expect(() => assertProductionAuthEnabled()).not.toThrow();
      });

      it('回避オプションなしの場合は起動失敗', () => {
        process.env.MCP_AUTH_ENABLED = 'false';
        delete process.env.MCP_ALLOW_INSECURE_PRODUCTION;

        expect(() => assertProductionAuthEnabled()).toThrow(ProductionAuthRequiredError);
        expect(() => assertProductionAuthEnabled()).toThrow(
          'MCP authentication is required in production environment'
        );
      });
    });

    describe('エラーメッセージの検証', () => {
      it('ProductionAuthRequiredError のメッセージが正しいこと', () => {
        const error = new ProductionAuthRequiredError();
        expect(error.message).toBe('MCP authentication is required in production environment');
        expect(error.name).toBe('ProductionAuthRequiredError');
      });
    });
  });

  describe('セキュリティ統合テスト', () => {
    it('本番環境 + 認証無効 + 回避オプションなし = 起動失敗', () => {
      process.env.NODE_ENV = 'production';
      process.env.MCP_AUTH_ENABLED = 'false';
      delete process.env.MCP_ALLOW_INSECURE_PRODUCTION;

      expect(() => assertProductionAuthEnabled()).toThrow(ProductionAuthRequiredError);
    });

    it('本番環境 + 認証有効 = 起動成功', () => {
      process.env.NODE_ENV = 'production';
      process.env.MCP_AUTH_ENABLED = 'true';

      expect(() => assertProductionAuthEnabled()).not.toThrow();
    });

    it('開発環境 + 認証無効 = 起動成功（開発用）', () => {
      process.env.NODE_ENV = 'development';
      process.env.MCP_AUTH_ENABLED = 'false';

      expect(() => assertProductionAuthEnabled()).not.toThrow();
    });

    it('本番環境 + 認証無効 + 回避オプション = 警告付きで起動成功', () => {
      process.env.NODE_ENV = 'production';
      process.env.MCP_AUTH_ENABLED = 'false';
      process.env.MCP_ALLOW_INSECURE_PRODUCTION = 'true';

      // エラーにならないことを確認
      expect(() => assertProductionAuthEnabled()).not.toThrow();
    });
  });
});

// =====================================================
// P1-SEC-INIT-01: 本番環境での全必須カテゴリ初期化強制テスト
// =====================================================

describe('P1-SEC-INIT-01: 本番環境での全必須カテゴリ初期化強制', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('REQUIRED_CATEGORIES_FOR_PRODUCTION', () => {
    it('必須カテゴリが正しく定義されていること', () => {
      expect(REQUIRED_CATEGORIES_FOR_PRODUCTION).toContain('motion');
      expect(REQUIRED_CATEGORIES_FOR_PRODUCTION).toContain('layout');
      expect(REQUIRED_CATEGORIES_FOR_PRODUCTION).toContain('quality');
      expect(REQUIRED_CATEGORIES_FOR_PRODUCTION).toContain('page');
      expect(REQUIRED_CATEGORIES_FOR_PRODUCTION).toHaveLength(4);
    });
  });

  describe('ProductionCategoryRequiredError', () => {
    it('エラーメッセージが正しいこと', () => {
      const error = new ProductionCategoryRequiredError(['motion', 'layout']);
      expect(error.message).toBe('Production requires all categories: missing motion, layout');
      expect(error.name).toBe('ProductionCategoryRequiredError');
      expect(error.missingCategories).toEqual(['motion', 'layout']);
    });

    it('単一カテゴリのエラーメッセージが正しいこと', () => {
      const error = new ProductionCategoryRequiredError(['quality']);
      expect(error.message).toBe('Production requires all categories: missing quality');
      expect(error.missingCategories).toEqual(['quality']);
    });
  });

  describe('assertProductionRequiredCategoriesInitialized', () => {
    describe('開発環境での動作', () => {
      it('開発環境では必須カテゴリ不足でもエラーにならない', () => {
        process.env.NODE_ENV = 'development';

        expect(() =>
          assertProductionRequiredCategoriesInitialized(['motion'])
        ).not.toThrow();
      });

      it('開発環境で空のカテゴリリストでもエラーにならない', () => {
        process.env.NODE_ENV = 'development';

        expect(() =>
          assertProductionRequiredCategoriesInitialized([])
        ).not.toThrow();
      });

      it('NODE_ENV未設定の場合はエラーにならない', () => {
        delete process.env.NODE_ENV;

        expect(() =>
          assertProductionRequiredCategoriesInitialized(['motion'])
        ).not.toThrow();
      });
    });

    describe('本番環境での動作', () => {
      beforeEach(() => {
        process.env.NODE_ENV = 'production';
      });

      it('全必須カテゴリが初期化されていればエラーにならない', () => {
        const allCategories = ['motion', 'layout', 'quality', 'page'];

        expect(() =>
          assertProductionRequiredCategoriesInitialized(allCategories)
        ).not.toThrow();
      });

      it('追加カテゴリがあっても必須カテゴリが揃っていればエラーにならない', () => {
        const categoriesWithExtra = ['motion', 'layout', 'quality', 'page', 'system', 'project'];

        expect(() =>
          assertProductionRequiredCategoriesInitialized(categoriesWithExtra)
        ).not.toThrow();
      });

      it('motionカテゴリが欠けている場合はエラー', () => {
        const missingMotion = ['layout', 'quality', 'page'];

        expect(() =>
          assertProductionRequiredCategoriesInitialized(missingMotion)
        ).toThrow(ProductionCategoryRequiredError);

        try {
          assertProductionRequiredCategoriesInitialized(missingMotion);
        } catch (e) {
          expect((e as ProductionCategoryRequiredError).missingCategories).toEqual(['motion']);
        }
      });

      it('layoutカテゴリが欠けている場合はエラー', () => {
        const missingLayout = ['motion', 'quality', 'page'];

        expect(() =>
          assertProductionRequiredCategoriesInitialized(missingLayout)
        ).toThrow(ProductionCategoryRequiredError);

        try {
          assertProductionRequiredCategoriesInitialized(missingLayout);
        } catch (e) {
          expect((e as ProductionCategoryRequiredError).missingCategories).toEqual(['layout']);
        }
      });

      it('qualityカテゴリが欠けている場合はエラー', () => {
        const missingQuality = ['motion', 'layout', 'page'];

        expect(() =>
          assertProductionRequiredCategoriesInitialized(missingQuality)
        ).toThrow(ProductionCategoryRequiredError);

        try {
          assertProductionRequiredCategoriesInitialized(missingQuality);
        } catch (e) {
          expect((e as ProductionCategoryRequiredError).missingCategories).toEqual(['quality']);
        }
      });

      it('pageカテゴリが欠けている場合はエラー', () => {
        const missingPage = ['motion', 'layout', 'quality'];

        expect(() =>
          assertProductionRequiredCategoriesInitialized(missingPage)
        ).toThrow(ProductionCategoryRequiredError);

        try {
          assertProductionRequiredCategoriesInitialized(missingPage);
        } catch (e) {
          expect((e as ProductionCategoryRequiredError).missingCategories).toEqual(['page']);
        }
      });

      it('複数カテゴリが欠けている場合は全て報告される', () => {
        const missingMultiple = ['motion'];

        expect(() =>
          assertProductionRequiredCategoriesInitialized(missingMultiple)
        ).toThrow(ProductionCategoryRequiredError);

        try {
          assertProductionRequiredCategoriesInitialized(missingMultiple);
        } catch (e) {
          const error = e as ProductionCategoryRequiredError;
          expect(error.missingCategories).toContain('layout');
          expect(error.missingCategories).toContain('quality');
          expect(error.missingCategories).toContain('page');
          expect(error.missingCategories).toHaveLength(3);
        }
      });

      it('空のカテゴリリストはエラー', () => {
        expect(() =>
          assertProductionRequiredCategoriesInitialized([])
        ).toThrow(ProductionCategoryRequiredError);

        try {
          assertProductionRequiredCategoriesInitialized([]);
        } catch (e) {
          const error = e as ProductionCategoryRequiredError;
          expect(error.missingCategories).toHaveLength(4);
        }
      });

      it('エラーメッセージに欠けているカテゴリが含まれる', () => {
        const missingMultiple = ['motion'];

        expect(() =>
          assertProductionRequiredCategoriesInitialized(missingMultiple)
        ).toThrow(/missing.*layout.*quality.*page/i);
      });
    });
  });

  describe('セキュリティ統合テスト', () => {
    it('本番環境 + 部分初期化 = 起動失敗', () => {
      process.env.NODE_ENV = 'production';

      // motion と layout のみ初期化
      expect(() =>
        assertProductionRequiredCategoriesInitialized(['motion', 'layout'])
      ).toThrow(ProductionCategoryRequiredError);
    });

    it('本番環境 + 全カテゴリ初期化 = 起動成功', () => {
      process.env.NODE_ENV = 'production';

      const allCategories = [...REQUIRED_CATEGORIES_FOR_PRODUCTION];
      expect(() =>
        assertProductionRequiredCategoriesInitialized(allCategories)
      ).not.toThrow();
    });

    it('開発環境 + 部分初期化 = 警告のみで起動成功', () => {
      process.env.NODE_ENV = 'development';

      // motion のみ初期化（開発環境では許可）
      expect(() =>
        assertProductionRequiredCategoriesInitialized(['motion'])
      ).not.toThrow();
    });

    it('開発環境 + 空初期化 = 警告のみで起動成功', () => {
      process.env.NODE_ENV = 'development';

      // 何も初期化されていない（開発環境では許可）
      expect(() =>
        assertProductionRequiredCategoriesInitialized([])
      ).not.toThrow();
    });

    it('本番環境でのカテゴリ名は大文字小文字を区別する', () => {
      process.env.NODE_ENV = 'production';

      // 大文字カテゴリは認識されない
      expect(() =>
        assertProductionRequiredCategoriesInitialized(['Motion', 'Layout', 'Quality', 'Page'])
      ).toThrow(ProductionCategoryRequiredError);
    });
  });
});
