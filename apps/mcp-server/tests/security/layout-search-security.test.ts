// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.search セキュリティテスト
 *
 * Phase 4-SEC: 検索API入力バリデーション検証
 *
 * 検証項目:
 * 1. SQLインジェクション対策（Zod + Prisma）
 * 2. XSS対策（入力サニタイズ）
 * 3. HEXカラー形式検証
 * 4. 数値範囲検証（colorTolerance, minContrastRatio等）
 * 5. UUIDインジェクション防止
 * 6. DoS対策（過大入力制限）
 * 7. Vision検索パラメータ検証
 *
 * @module tests/security/layout-search-security.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// テスト対象のスキーマをインポート
import {
  layoutSearchInputSchema,
  visualFeaturesFilterSchema,
  visualFeaturesColorsFilterSchema,
  visualFeaturesThemeFilterSchema,
  visualFeaturesDensityFilterSchema,
  visionSearchQuerySchema,
  visionSearchOptionsSchema,
  type LayoutSearchInput,
  type VisualFeaturesFilter,
} from '../../src/tools/layout/schemas';

// ============================================================================
// Part 1: SQLインジェクション対策テスト
// ============================================================================

describe('layout.search SQLインジェクション対策', () => {
  describe('dominantColorフィールドのSQLインジェクション防止', () => {
    it('SQLインジェクション文字列をdominantColorとして拒否すること', () => {
      const maliciousInput = {
        query: 'hero',
        filters: {
          visualFeatures: {
            colors: {
              dominantColor: "'; DROP TABLE section_patterns; --",
            },
          },
        },
      };

      const result = layoutSearchInputSchema.safeParse(maliciousInput);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some((e) => e.message.includes('#RRGGBB'))).toBe(true);
      }
    });

    it('UNIONベースのSQLインジェクションを拒否すること', () => {
      const maliciousInput = {
        query: 'hero',
        filters: {
          visualFeatures: {
            colors: {
              dominantColor: "#FF0000' UNION SELECT * FROM users --",
            },
          },
        },
      };

      const result = layoutSearchInputSchema.safeParse(maliciousInput);
      expect(result.success).toBe(false);
    });

    it('コメント文字列を含むインジェクションを拒否すること', () => {
      const maliciousInput = {
        query: 'hero',
        filters: {
          visualFeatures: {
            colors: {
              dominantColor: '#FF0000/*comment*/',
            },
          },
        },
      };

      const result = layoutSearchInputSchema.safeParse(maliciousInput);
      expect(result.success).toBe(false);
    });

    it('二重引用符インジェクションを拒否すること', () => {
      const maliciousInput = {
        query: 'hero',
        filters: {
          visualFeatures: {
            colors: {
              dominantColor: '#FF0000"; DELETE FROM section_patterns; --',
            },
          },
        },
      };

      const result = layoutSearchInputSchema.safeParse(maliciousInput);
      expect(result.success).toBe(false);
    });

    it('OR条件インジェクションを拒否すること', () => {
      const maliciousInput = {
        query: 'hero',
        filters: {
          visualFeatures: {
            colors: {
              dominantColor: "#FF0000' OR '1'='1",
            },
          },
        },
      };

      const result = layoutSearchInputSchema.safeParse(maliciousInput);
      expect(result.success).toBe(false);
    });
  });

  describe('queryフィールドのSQLインジェクション防止', () => {
    it('クエリ文字列へのSQLインジェクションを無害化（Zodは通過するがパラメータ化で安全）', () => {
      const maliciousInput = {
        query: "hero'; DROP TABLE section_patterns; --",
      };

      // Zodはクエリを文字列として通過させる（長さ制限内）
      // 実際のセキュリティはPrismaのパラメータ化で担保
      const result = layoutSearchInputSchema.safeParse(maliciousInput);
      expect(result.success).toBe(true);
      // 入力値がそのまま保持されることを確認（サニタイズはDB層で）
    });
  });
});

// ============================================================================
// Part 2: XSS対策テスト
// ============================================================================

describe('layout.search XSS対策', () => {
  describe('クエリフィールドのXSS対策', () => {
    it('スクリプトタグを含むクエリは長さ制限内なら通過（表示時にエスケープ）', () => {
      const xssInput = {
        query: '<script>alert("XSS")</script>hero',
      };

      // 入力バリデーションは通過（長さ制限内）
      // 出力時のエスケープで対策
      const result = layoutSearchInputSchema.safeParse(xssInput);
      expect(result.success).toBe(true);
    });

    it('イベントハンドラ属性を含むクエリは長さ制限内なら通過', () => {
      const xssInput = {
        query: '<img src=x onerror=alert(1)>hero',
      };

      const result = layoutSearchInputSchema.safeParse(xssInput);
      expect(result.success).toBe(true);
    });

    it('JavaScript URLプロトコルを含むクエリは長さ制限内なら通過', () => {
      const xssInput = {
        query: 'javascript:alert("XSS")',
      };

      const result = layoutSearchInputSchema.safeParse(xssInput);
      expect(result.success).toBe(true);
    });
  });

  describe('textQueryフィールドのXSS対策（Vision検索）', () => {
    it('スクリプトタグを含むtextQueryは長さ制限内なら通過', () => {
      const xssInput = {
        query: 'hero',
        use_vision_search: true,
        vision_search_query: {
          textQuery: '<script>alert("XSS")</script>modern design',
        },
      };

      const result = layoutSearchInputSchema.safeParse(xssInput);
      expect(result.success).toBe(true);
    });

    it('SVGベースのXSSを含むtextQueryは長さ制限内なら通過', () => {
      const xssInput = {
        query: 'hero',
        use_vision_search: true,
        vision_search_query: {
          textQuery: '<svg onload="alert(1)">minimal layout',
        },
      };

      const result = layoutSearchInputSchema.safeParse(xssInput);
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// Part 3: HEXカラー形式検証テスト
// ============================================================================

describe('layout.search HEXカラー形式検証', () => {
  describe('dominantColor HEXカラーパターン', () => {
    it('有効な大文字HEXカラーを受け入れること', () => {
      // visualFeaturesColorsFilterSchemaは直接 dominantColor を持つ
      const validInput = {
        dominantColor: '#FF0000',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('有効な小文字HEXカラーを受け入れること', () => {
      const validInput = {
        dominantColor: '#aabbcc',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('有効な混合ケースHEXカラーを受け入れること', () => {
      const validInput = {
        dominantColor: '#AaBbCc',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('色名（red）を拒否すること', () => {
      const invalidInput = {
        dominantColor: 'red',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('不正な文字（GGG）を含むHEXを拒否すること', () => {
      const invalidInput = {
        dominantColor: '#GGG000',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('5文字のHEXを拒否すること', () => {
      const invalidInput = {
        dominantColor: '#12345',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('7文字のHEXを拒否すること', () => {
      const invalidInput = {
        dominantColor: '#1234567',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('3文字のショートHEXを拒否すること', () => {
      const invalidInput = {
        dominantColor: '#FFF',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('#なしのHEXを拒否すること', () => {
      const invalidInput = {
        dominantColor: 'FF0000',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('RGBカラー形式を拒否すること', () => {
      const invalidInput = {
        dominantColor: 'rgb(255, 0, 0)',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('空文字列を拒否すること', () => {
      const invalidInput = {
        dominantColor: '',
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Part 4: 数値範囲検証テスト
// ============================================================================

describe('layout.search 数値範囲検証', () => {
  describe('colorTolerance範囲検証（0-100）', () => {
    it('colorTolerance=0を受け入れること', () => {
      // visualFeaturesColorsFilterSchemaは直接 colorTolerance を持つ
      const validInput = {
        dominantColor: '#FFFFFF',
        colorTolerance: 0,
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('colorTolerance=100を受け入れること', () => {
      const validInput = {
        dominantColor: '#FFFFFF',
        colorTolerance: 100,
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('colorTolerance=50（中間値）を受け入れること', () => {
      const validInput = {
        dominantColor: '#FFFFFF',
        colorTolerance: 50,
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('colorTolerance=-1を拒否すること', () => {
      const invalidInput = {
        dominantColor: '#FFFFFF',
        colorTolerance: -1,
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('colorTolerance=101を拒否すること', () => {
      const invalidInput = {
        dominantColor: '#FFFFFF',
        colorTolerance: 101,
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('colorTolerance=-100（大きな負の値）を拒否すること', () => {
      const invalidInput = {
        dominantColor: '#FFFFFF',
        colorTolerance: -100,
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('colorTolerance=1000（大きな正の値）を拒否すること', () => {
      const invalidInput = {
        dominantColor: '#FFFFFF',
        colorTolerance: 1000,
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('minContrastRatio範囲検証（1-21）', () => {
    it('minContrastRatio=1を受け入れること', () => {
      const validInput = {
        theme: {
          minContrastRatio: 1,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('minContrastRatio=21を受け入れること', () => {
      const validInput = {
        theme: {
          minContrastRatio: 21,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('minContrastRatio=4.5（WCAG AA）を受け入れること', () => {
      const validInput = {
        theme: {
          minContrastRatio: 4.5,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('minContrastRatio=7（WCAG AAA）を受け入れること', () => {
      const validInput = {
        theme: {
          minContrastRatio: 7,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('minContrastRatio=0を拒否すること', () => {
      const invalidInput = {
        theme: {
          minContrastRatio: 0,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('minContrastRatio=22を拒否すること', () => {
      const invalidInput = {
        theme: {
          minContrastRatio: 22,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('minContrastRatio=-1を拒否すること', () => {
      const invalidInput = {
        theme: {
          minContrastRatio: -1,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('density範囲検証（0-1）', () => {
    it('minContentDensity=0を受け入れること', () => {
      const validInput = {
        density: {
          minContentDensity: 0,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('minContentDensity=1を受け入れること', () => {
      const validInput = {
        density: {
          minContentDensity: 1,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('minContentDensity=0.5を受け入れること', () => {
      const validInput = {
        density: {
          minContentDensity: 0.5,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('minContentDensity=-0.1を拒否すること', () => {
      const invalidInput = {
        density: {
          minContentDensity: -0.1,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('minContentDensity=1.1を拒否すること', () => {
      const invalidInput = {
        density: {
          minContentDensity: 1.1,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('maxContentDensity=-0.1を拒否すること', () => {
      const invalidInput = {
        density: {
          maxContentDensity: -0.1,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('maxContentDensity=1.1を拒否すること', () => {
      const invalidInput = {
        density: {
          maxContentDensity: 1.1,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('minWhitespaceRatio=-0.1を拒否すること', () => {
      const invalidInput = {
        density: {
          minWhitespaceRatio: -0.1,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('minWhitespaceRatio=1.1を拒否すること', () => {
      const invalidInput = {
        density: {
          minWhitespaceRatio: 1.1,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Part 5: Vision検索パラメータ検証テスト
// ============================================================================

describe('layout.search Vision検索パラメータ検証', () => {
  describe('sectionPatternId UUID検証', () => {
    it('有効なUUIDを受け入れること', () => {
      const validInput = {
        sectionPatternId: '550e8400-e29b-41d4-a716-446655440000',
      };

      const result = visionSearchQuerySchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('有効なUUIDv7を受け入れること', () => {
      const validInput = {
        sectionPatternId: '01936abc-def0-7123-8456-789abcdef012',
      };

      const result = visionSearchQuerySchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('不正なUUID（not-a-uuid）を拒否すること', () => {
      const invalidInput = {
        sectionPatternId: 'not-a-uuid',
      };

      const result = visionSearchQuerySchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('SQLインジェクション文字列を拒否すること', () => {
      const invalidInput = {
        sectionPatternId: "'; DROP TABLE section_patterns; --",
      };

      const result = visionSearchQuerySchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('パストラバーサルを拒否すること', () => {
      const invalidInput = {
        sectionPatternId: '../../../etc/passwd',
      };

      const result = visionSearchQuerySchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('空文字列を拒否すること', () => {
      const invalidInput = {
        sectionPatternId: '',
      };

      const result = visionSearchQuerySchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('UUIDに似た不正な形式を拒否すること', () => {
      const invalidInput = {
        sectionPatternId: '550e8400-e29b-41d4-a716-44665544000g', // 末尾がg
      };

      const result = visionSearchQuerySchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('短すぎるUUIDを拒否すること', () => {
      const invalidInput = {
        sectionPatternId: '550e8400-e29b-41d4',
      };

      const result = visionSearchQuerySchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('visionWeight/textWeight範囲検証（0-1）', () => {
    it('visionWeight=0を受け入れること', () => {
      const validInput = {
        visionWeight: 0,
      };

      const result = visionSearchOptionsSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('visionWeight=1を受け入れること', () => {
      const validInput = {
        visionWeight: 1,
      };

      const result = visionSearchOptionsSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('visionWeight=0.6（デフォルト）を受け入れること', () => {
      const validInput = {
        visionWeight: 0.6,
      };

      const result = visionSearchOptionsSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('visionWeight=-0.1を拒否すること', () => {
      const invalidInput = {
        visionWeight: -0.1,
      };

      const result = visionSearchOptionsSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('visionWeight=1.5を拒否すること', () => {
      const invalidInput = {
        visionWeight: 1.5,
      };

      const result = visionSearchOptionsSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('textWeight=-0.1を拒否すること', () => {
      const invalidInput = {
        textWeight: -0.1,
      };

      const result = visionSearchOptionsSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('textWeight=1.1を拒否すること', () => {
      const invalidInput = {
        textWeight: 1.1,
      };

      const result = visionSearchOptionsSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('minSimilarity範囲検証（0-1）', () => {
    it('minSimilarity=0を受け入れること', () => {
      const validInput = {
        minSimilarity: 0,
      };

      const result = visionSearchOptionsSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('minSimilarity=1を受け入れること', () => {
      const validInput = {
        minSimilarity: 1,
      };

      const result = visionSearchOptionsSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('minSimilarity=0.5（デフォルト）を受け入れること', () => {
      const validInput = {
        minSimilarity: 0.5,
      };

      const result = visionSearchOptionsSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('minSimilarity=-0.1を拒否すること', () => {
      const invalidInput = {
        minSimilarity: -0.1,
      };

      const result = visionSearchOptionsSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('minSimilarity=1.1を拒否すること', () => {
      const invalidInput = {
        minSimilarity: 1.1,
      };

      const result = visionSearchOptionsSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('textQuery長さ検証（1-500）', () => {
    it('textQuery=1文字を受け入れること', () => {
      const validInput = {
        textQuery: 'a',
      };

      const result = visionSearchQuerySchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('textQuery=500文字を受け入れること', () => {
      const validInput = {
        textQuery: 'a'.repeat(500),
      };

      const result = visionSearchQuerySchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('空のtextQueryを拒否すること', () => {
      const invalidInput = {
        textQuery: '',
      };

      const result = visionSearchQuerySchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('textQuery=501文字を拒否すること', () => {
      const invalidInput = {
        textQuery: 'a'.repeat(501),
      };

      const result = visionSearchQuerySchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Part 6: DoS対策テスト
// ============================================================================

describe('layout.search DoS対策', () => {
  describe('クエリ長さ制限（1-500）', () => {
    it('query=1文字を受け入れること', () => {
      const validInput = {
        query: 'a',
      };

      const result = layoutSearchInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('query=500文字を受け入れること', () => {
      const validInput = {
        query: 'a'.repeat(500),
      };

      const result = layoutSearchInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('空のqueryを拒否すること', () => {
      const invalidInput = {
        query: '',
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('query=501文字を拒否すること', () => {
      const invalidInput = {
        query: 'a'.repeat(501),
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('query=10001文字を拒否すること', () => {
      const invalidInput = {
        query: 'a'.repeat(10001),
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('limit範囲制限（1-50）', () => {
    it('limit=1を受け入れること', () => {
      const validInput = {
        query: 'hero',
        limit: 1,
      };

      const result = layoutSearchInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('limit=50を受け入れること', () => {
      const validInput = {
        query: 'hero',
        limit: 50,
      };

      const result = layoutSearchInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('limit=0を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        limit: 0,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('limit=51を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        limit: 51,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('limit=-1を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        limit: -1,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('limit=1000を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        limit: 1000,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('offset範囲制限（0以上）', () => {
    it('offset=0を受け入れること', () => {
      const validInput = {
        query: 'hero',
        offset: 0,
      };

      const result = layoutSearchInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('offset=100を受け入れること', () => {
      const validInput = {
        query: 'hero',
        offset: 100,
      };

      const result = layoutSearchInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('offset=-1を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        offset: -1,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('offset=-100を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        offset: -100,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Part 7: テーマタイプ検証テスト
// ============================================================================

describe('layout.search テーマタイプ検証', () => {
  describe('テーマタイプenum検証', () => {
    it('type=lightを受け入れること', () => {
      const validInput = {
        theme: {
          type: 'light',
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('type=darkを受け入れること', () => {
      const validInput = {
        theme: {
          type: 'dark',
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('type=mixedを受け入れること', () => {
      const validInput = {
        theme: {
          type: 'mixed',
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('type=invalidを拒否すること', () => {
      const invalidInput = {
        theme: {
          type: 'invalid',
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('type=LIGHT（大文字）を拒否すること', () => {
      const invalidInput = {
        theme: {
          type: 'LIGHT',
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('SQLインジェクション文字列をtypeとして拒否すること', () => {
      const invalidInput = {
        theme: {
          type: "light'; DROP TABLE section_patterns; --",
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Part 8: 統合検証テスト（有効な入力）
// ============================================================================

describe('layout.search 有効な入力の受け入れ', () => {
  it('完全なフィルター付き検索リクエストを受け入れること', () => {
    const validInput: LayoutSearchInput = {
      query: 'modern hero section with gradient background',
      filters: {
        sectionType: 'hero',
        sourceType: 'award_gallery',
        usageScope: 'inspiration_only',
        visualFeatures: {
          theme: {
            type: 'dark',
            minContrastRatio: 4.5,
          },
          colors: {
            dominantColor: '#1A1A2E',
            colorTolerance: 20,
          },
          density: {
            minContentDensity: 0.3,
            maxContentDensity: 0.7,
            minWhitespaceRatio: 0.3,
          },
        },
      },
      limit: 20,
      offset: 0,
      includeHtml: false,
    };

    const result = layoutSearchInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('Vision検索パラメータ付きリクエストを受け入れること', () => {
    const validInput = {
      query: 'minimal light theme hero',
      use_vision_search: true,
      vision_search_query: {
        textQuery: 'clean minimal design with lots of whitespace',
        visualFeatures: {
          theme: 'light',
          density: 'sparse',
          mood: 'professional',
        },
      },
      vision_search_options: {
        minSimilarity: 0.6,
        visionWeight: 0.7,
        textWeight: 0.3,
      },
      limit: 10,
    };

    const result = layoutSearchInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('最小限のリクエストを受け入れること', () => {
    const validInput = {
      query: 'hero',
    };

    const result = layoutSearchInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('日本語クエリを受け入れること', () => {
    const validInput = {
      query: 'モダンなヒーローセクション グラデーション背景',
    };

    const result = layoutSearchInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Part 9: 型強制攻撃テスト
// ============================================================================

describe('layout.search 型強制攻撃対策', () => {
  describe('数値フィールドへの文字列注入', () => {
    it('limitに文字列を渡した場合を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        limit: '10' as any,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('offsetに文字列を渡した場合を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        offset: '0' as any,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('colorToleranceに文字列を渡した場合を拒否すること', () => {
      // visualFeaturesColorsFilterSchemaは直接colorToleranceを持つ
      const invalidInput = {
        dominantColor: '#FFFFFF',
        colorTolerance: '15' as any,
      };

      const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('minContrastRatioに文字列を渡した場合を拒否すること', () => {
      const invalidInput = {
        theme: {
          minContrastRatio: '4.5' as any,
        },
      };

      const result = visualFeaturesFilterSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('ブール値フィールドへの不正値注入', () => {
    it('includeHtmlに文字列を渡した場合を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        includeHtml: 'true' as any,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('use_vision_searchに文字列を渡した場合を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        use_vision_search: 'true' as any,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('includeHtmlに数値を渡した場合を拒否すること', () => {
      const invalidInput = {
        query: 'hero',
        includeHtml: 1 as any,
      };

      const result = layoutSearchInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });
  });

  describe('配列フィールドへの不正値注入', () => {
    it('filtersにnullを渡した場合を適切に処理すること', () => {
      const inputWithNull = {
        query: 'hero',
        filters: null as any,
      };

      // filtersはオプショナルなのでnullは受け入れられない可能性
      const result = layoutSearchInputSchema.safeParse(inputWithNull);
      // 実装に依存するため結果を確認
      if (result.success) {
        expect(result.data.filters).toBeUndefined();
      }
    });
  });
});

// ============================================================================
// Part 10: NaN/Infinity対策テスト
// ============================================================================

describe('layout.search NaN/Infinity対策', () => {
  it('limitにNaNを渡した場合を拒否すること', () => {
    const invalidInput = {
      query: 'hero',
      limit: NaN,
    };

    const result = layoutSearchInputSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  it('limitにInfinityを渡した場合を拒否すること', () => {
    const invalidInput = {
      query: 'hero',
      limit: Infinity,
    };

    const result = layoutSearchInputSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  it('offsetにNaNを渡した場合を拒否すること', () => {
    const invalidInput = {
      query: 'hero',
      offset: NaN,
    };

    const result = layoutSearchInputSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  it('colorToleranceにNaNを渡した場合を拒否すること', () => {
    // visualFeaturesColorsFilterSchemaは直接colorToleranceを持つ
    const invalidInput = {
      dominantColor: '#FFFFFF',
      colorTolerance: NaN,
    };

    const result = visualFeaturesColorsFilterSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  it('visionWeightにInfinityを渡した場合を拒否すること', () => {
    const invalidInput = {
      visionWeight: Infinity,
    };

    const result = visionSearchOptionsSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  it('minSimilarityに-Infinityを渡した場合を拒否すること', () => {
    const invalidInput = {
      minSimilarity: -Infinity,
    };

    const result = visionSearchOptionsSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });
});
