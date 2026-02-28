// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core Types (Zod Schemas) Tests
 * TDD: Zodスキーマのバリデーションテスト
 *
 * テスト対象:
 * - searchQuerySchema: 検索クエリの型定義
 * - searchResultSchema: 検索結果の型定義
 * - licenseSchema: ライセンスの型定義
 * - categorySchema: カテゴリの型定義
 */

import { describe, it, expect } from 'vitest';
import {
  searchQuerySchema,
  searchResultSchema,
  licenseSchema,
  categorySchema,
  type SearchQuery,
  type SearchResult,
  type License,
  type Category,
} from '../src/types';

// 開発環境ログ出力
if (process.env.NODE_ENV === 'development') {
  console.log('[Test] Running: types.test.ts');
}

describe('searchQuerySchema', () => {
  describe('正常系テスト', () => {
    it('有効な検索クエリを受け入れる', () => {
      // Arrange
      const validQuery = {
        query: 'blue bird',
        limit: 20,
        offset: 0,
      };

      // Act
      const result = searchQuerySchema.safeParse(validQuery);

      // Assert
      expect(result.success).toBe(true);
    });

    it('デフォルト値が適用される', () => {
      // Arrange: limitとoffsetを省略
      const minimalQuery = { query: 'test' };

      // Act
      const result = searchQuerySchema.safeParse(minimalQuery);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
        expect(result.data.offset).toBe(0);
      }
    });

    it('フィルターオプションを受け入れる', () => {
      // Arrange
      const queryWithFilters = {
        query: 'icon',
        limit: 50,
        offset: 10,
        categoryIds: ['550e8400-e29b-41d4-a716-446655440000'],
        licenseIds: ['550e8400-e29b-41d4-a716-446655440001'],
        tags: ['flat', 'modern'],
      };

      // Act
      const result = searchQuerySchema.safeParse(queryWithFilters);

      // Assert
      expect(result.success).toBe(true);
    });

    it('最大limit値(100)を受け入れる', () => {
      // Arrange
      const maxLimitQuery = { query: 'test', limit: 100 };

      // Act
      const result = searchQuerySchema.safeParse(maxLimitQuery);

      // Assert
      expect(result.success).toBe(true);
    });

    it('日本語クエリを受け入れる', () => {
      // Arrange
      const japaneseQuery = { query: '青い鳥のアイコン' };

      // Act
      const result = searchQuerySchema.safeParse(japaneseQuery);

      // Assert
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('空のqueryを拒否する', () => {
      // Arrange
      const emptyQuery = { query: '' };

      // Act
      const result = searchQuerySchema.safeParse(emptyQuery);

      // Assert
      expect(result.success).toBe(false);
    });

    it('500文字を超えるqueryを拒否する', () => {
      // Arrange
      const longQuery = { query: 'a'.repeat(501) };

      // Act
      const result = searchQuerySchema.safeParse(longQuery);

      // Assert
      expect(result.success).toBe(false);
    });

    it('limitが0の場合を拒否する', () => {
      // Arrange
      const zeroLimitQuery = { query: 'test', limit: 0 };

      // Act
      const result = searchQuerySchema.safeParse(zeroLimitQuery);

      // Assert
      expect(result.success).toBe(false);
    });

    it('limitが100を超える場合を拒否する', () => {
      // Arrange
      const tooHighLimitQuery = { query: 'test', limit: 101 };

      // Act
      const result = searchQuerySchema.safeParse(tooHighLimitQuery);

      // Assert
      expect(result.success).toBe(false);
    });

    it('負のoffsetを拒否する', () => {
      // Arrange
      const negativeOffsetQuery = { query: 'test', offset: -1 };

      // Act
      const result = searchQuerySchema.safeParse(negativeOffsetQuery);

      // Assert
      expect(result.success).toBe(false);
    });

    it('小数のlimitを拒否する', () => {
      // Arrange
      const floatLimitQuery = { query: 'test', limit: 10.5 };

      // Act
      const result = searchQuerySchema.safeParse(floatLimitQuery);

      // Assert
      expect(result.success).toBe(false);
    });

    it('無効なUUID形式のcategoryIdsを拒否する', () => {
      // Arrange
      const invalidCategoryQuery = {
        query: 'test',
        categoryIds: ['invalid-uuid'],
      };

      // Act
      const result = searchQuerySchema.safeParse(invalidCategoryQuery);

      // Assert
      expect(result.success).toBe(false);
    });
  });
});

describe('searchResultSchema', () => {
  const validResultItem = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Test Item',
    similarity: 0.95,
  };

  describe('正常系テスト', () => {
    it('有効な検索結果を受け入れる', () => {
      // Arrange
      const validResult = {
        items: [validResultItem],
        total: 1,
        limit: 20,
        offset: 0,
      };

      // Act
      const result = searchResultSchema.safeParse(validResult);

      // Assert
      expect(result.success).toBe(true);
    });

    it('空のitems配列を受け入れる', () => {
      // Arrange
      const emptyResult = {
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      };

      // Act
      const result = searchResultSchema.safeParse(emptyResult);

      // Assert
      expect(result.success).toBe(true);
    });

    it('複数のアイテムを受け入れる', () => {
      // Arrange
      const multipleItemsResult = {
        items: [
          { ...validResultItem, id: '550e8400-e29b-41d4-a716-446655440001' },
          { ...validResultItem, id: '550e8400-e29b-41d4-a716-446655440002' },
          { ...validResultItem, id: '550e8400-e29b-41d4-a716-446655440003' },
        ],
        total: 100,
        limit: 3,
        offset: 0,
      };

      // Act
      const result = searchResultSchema.safeParse(multipleItemsResult);

      // Assert
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('items内に無効なアイテムがある場合を拒否する', () => {
      // Arrange
      const invalidItemResult = {
        items: [{ invalid: 'data' }],
        total: 1,
        limit: 20,
        offset: 0,
      };

      // Act
      const result = searchResultSchema.safeParse(invalidItemResult);

      // Assert
      expect(result.success).toBe(false);
    });

    it('totalが整数でない場合を拒否する', () => {
      // Arrange
      const floatTotalResult = {
        items: [],
        total: 1.5,
        limit: 20,
        offset: 0,
      };

      // Act
      const result = searchResultSchema.safeParse(floatTotalResult);

      // Assert
      expect(result.success).toBe(false);
    });
  });
});

describe('licenseSchema', () => {
  const validLicense = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'MIT License',
    spdxId: 'MIT',
    url: 'https://opensource.org/licenses/MIT',
    requiresAttribution: false,
    allowsCommercial: true,
    allowsModification: true,
  };

  describe('正常系テスト', () => {
    it('有効なライセンスデータを受け入れる', () => {
      // Arrange & Act
      const result = licenseSchema.safeParse(validLicense);

      // Assert
      expect(result.success).toBe(true);
    });

    it('オプションフィールドなしでも受け入れる', () => {
      // Arrange
      const minimalLicense = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Custom License',
      };

      // Act
      const result = licenseSchema.safeParse(minimalLicense);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        // デフォルト値の確認
        expect(result.data.requiresAttribution).toBe(false);
        expect(result.data.allowsCommercial).toBe(true);
        expect(result.data.allowsModification).toBe(true);
      }
    });

    it('Attribution必須ライセンスを受け入れる', () => {
      // Arrange
      const ccLicense = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'CC BY 4.0',
        spdxId: 'CC-BY-4.0',
        requiresAttribution: true,
        allowsCommercial: true,
        allowsModification: true,
      };

      // Act
      const result = licenseSchema.safeParse(ccLicense);

      // Assert
      expect(result.success).toBe(true);
    });

    it('商用利用禁止ライセンスを受け入れる', () => {
      // Arrange
      const ncLicense = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'CC BY-NC 4.0',
        spdxId: 'CC-BY-NC-4.0',
        requiresAttribution: true,
        allowsCommercial: false,
        allowsModification: true,
      };

      // Act
      const result = licenseSchema.safeParse(ncLicense);

      // Assert
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効なUUID形式のidを拒否する', () => {
      // Arrange
      const invalidIdLicense = { ...validLicense, id: 'invalid' };

      // Act
      const result = licenseSchema.safeParse(invalidIdLicense);

      // Assert
      expect(result.success).toBe(false);
    });

    it('空のnameを拒否する', () => {
      // Arrange
      const emptyNameLicense = { ...validLicense, name: '' };

      // Act
      const result = licenseSchema.safeParse(emptyNameLicense);

      // Assert
      expect(result.success).toBe(false);
    });

    it('100文字を超えるnameを拒否する', () => {
      // Arrange
      const longNameLicense = { ...validLicense, name: 'a'.repeat(101) };

      // Act
      const result = licenseSchema.safeParse(longNameLicense);

      // Assert
      expect(result.success).toBe(false);
    });

    it('無効なURL形式を拒否する', () => {
      // Arrange
      const invalidUrlLicense = { ...validLicense, url: 'not-a-url' };

      // Act
      const result = licenseSchema.safeParse(invalidUrlLicense);

      // Assert
      expect(result.success).toBe(false);
    });
  });
});

describe('categorySchema', () => {
  const validCategory = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Icons',
    slug: 'icons',
    description: 'General purpose icons',
    parentId: '550e8400-e29b-41d4-a716-446655440001',
  };

  describe('正常系テスト', () => {
    it('有効なカテゴリデータを受け入れる', () => {
      // Arrange & Act
      const result = categorySchema.safeParse(validCategory);

      // Assert
      expect(result.success).toBe(true);
    });

    it('オプションフィールドなしでも受け入れる', () => {
      // Arrange
      const minimalCategory = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Test',
        slug: 'test',
      };

      // Act
      const result = categorySchema.safeParse(minimalCategory);

      // Assert
      expect(result.success).toBe(true);
    });

    it('親カテゴリなしのルートカテゴリを受け入れる', () => {
      // Arrange
      const rootCategory = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Root Category',
        slug: 'root-category',
      };

      // Act
      const result = categorySchema.safeParse(rootCategory);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parentId).toBeUndefined();
      }
    });

    it('日本語のカテゴリ名を受け入れる', () => {
      // Arrange
      const japaneseCategory = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'アイコン',
        slug: 'icons',
        description: '汎用アイコンコレクション',
      };

      // Act
      const result = categorySchema.safeParse(japaneseCategory);

      // Assert
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('空のnameを拒否する', () => {
      // Arrange
      const emptyNameCategory = { ...validCategory, name: '' };

      // Act
      const result = categorySchema.safeParse(emptyNameCategory);

      // Assert
      expect(result.success).toBe(false);
    });

    it('100文字を超えるnameを拒否する', () => {
      // Arrange
      const longNameCategory = { ...validCategory, name: 'a'.repeat(101) };

      // Act
      const result = categorySchema.safeParse(longNameCategory);

      // Assert
      expect(result.success).toBe(false);
    });

    it('空のslugを拒否する', () => {
      // Arrange
      const emptySlugCategory = { ...validCategory, slug: '' };

      // Act
      const result = categorySchema.safeParse(emptySlugCategory);

      // Assert
      expect(result.success).toBe(false);
    });

    it('100文字を超えるslugを拒否する', () => {
      // Arrange
      const longSlugCategory = { ...validCategory, slug: 'a'.repeat(101) };

      // Act
      const result = categorySchema.safeParse(longSlugCategory);

      // Assert
      expect(result.success).toBe(false);
    });

    it('無効なUUID形式のparentIdを拒否する', () => {
      // Arrange
      const invalidParentCategory = { ...validCategory, parentId: 'invalid' };

      // Act
      const result = categorySchema.safeParse(invalidParentCategory);

      // Assert
      expect(result.success).toBe(false);
    });
  });
});

describe('型エクスポートの確認', () => {
  it('SearchQuery型が正しくエクスポートされている', () => {
    const query: SearchQuery = {
      query: 'test',
      limit: 20,
      offset: 0,
    };

    expect(query.query).toBeDefined();
  });

  it('SearchResult型が正しくエクスポートされている', () => {
    const result: SearchResult = {
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    };

    expect(result.items).toBeDefined();
  });

  it('License型が正しくエクスポートされている', () => {
    const license: License = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'MIT',
      requiresAttribution: false,
      allowsCommercial: true,
      allowsModification: true,
    };

    expect(license.name).toBeDefined();
  });

  it('Category型が正しくエクスポートされている', () => {
    const category: Category = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Test',
      slug: 'test',
    };

    expect(category.slug).toBeDefined();
  });
});
