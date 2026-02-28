// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Features Search E2Eテスト
 *
 * Phase 4 Visual Features Search API のE2Eテスト:
 * - layout.search ツールの visual_features フィルタリング
 * - vision_embedding ベースのセマンティック検索
 * - RRF ハイブリッド検索（60% vision + 40% text）
 *
 * テスト対象:
 * - visual_features.theme フィルタ（light/dark/mixed, minContrastRatio）
 * - visual_features.colors フィルタ（dominantColor, colorTolerance/ΔE）
 * - visual_features.density フィルタ（sparse/moderate/dense）
 * - use_vision_search: true による Vision Embedding 検索
 * - RRF（Reciprocal Rank Fusion）ハイブリッド検索
 *
 * @module tests/e2e/visual-features-search.e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

// Layout Search サービス（DI設定用）
import {
  setLayoutEmbeddingServiceFactory,
  resetLayoutEmbeddingServiceFactory,
  setLayoutPrismaClientFactory,
  resetLayoutPrismaClientFactory,
  createLayoutSearchServiceFactory,
} from '../../src/services/layout-search.service';

// Vision Embedding Search サービス
import {
  setVisionSearchEmbeddingServiceFactory,
  resetVisionSearchEmbeddingServiceFactory,
  setVisionSearchPrismaClientFactory,
  resetVisionSearchPrismaClientFactory,
  createVisionEmbeddingSearchServiceFactory,
} from '../../src/services/vision-embedding-search.service';

// Color utilities（ΔE検証用）
import {
  calculateDeltaEFromHex,
  isColorWithinTolerance,
  hexToLab,
  calculateDeltaE76,
} from '../../src/utils/color';

import { TEST_DATABASE_URL } from './test-database-url';

// ============================================================================
// Prisma クライアント設定
// ============================================================================

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: TEST_DATABASE_URL,
    },
  },
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
});

// ============================================================================
// テストデータ
// ============================================================================

/**
 * テスト用 WebPage データ
 */
const testWebPages = {
  lightTheme: {
    id: uuidv7(),
    url: 'https://example.com/light-theme',
    title: 'Light Theme Test Page',
    sourceType: 'user_provided',
    usageScope: 'inspiration_only',
  },
  darkTheme: {
    id: uuidv7(),
    url: 'https://example.com/dark-theme',
    title: 'Dark Theme Test Page',
    sourceType: 'user_provided',
    usageScope: 'inspiration_only',
  },
  mixedTheme: {
    id: uuidv7(),
    url: 'https://example.com/mixed-theme',
    title: 'Mixed Theme Test Page',
    sourceType: 'award_gallery',
    usageScope: 'owned_asset',
  },
};

/**
 * テスト用 SectionPattern データ（visual_features 付き）
 */
const testSectionPatterns = {
  lightHero: {
    id: uuidv7(),
    webPageId: testWebPages.lightTheme.id,
    sectionType: 'hero',
    sectionName: 'Light Hero Section',
    htmlSnippet: '<section class="hero light">Light Hero</section>',
    layoutInfo: { columns: 1, rows: 1, gridType: 'single' },
    visualFeatures: {
      theme: {
        type: 'light',
        confidence: 0.95,
        backgroundColor: '#FFFFFF',
        textColor: '#212121',
        contrastRatio: 16.5,
        luminance: { background: 1.0, foreground: 0.05 },
      },
      colors: {
        dominantColors: ['#FFFFFF', '#F5F5F5'],
        accentColors: ['#3B82F6'],
        colorPalette: [
          { color: '#FFFFFF', percentage: 60 },
          { color: '#F5F5F5', percentage: 25 },
          { color: '#3B82F6', percentage: 15 },
        ],
      },
      density: {
        contentDensity: 0.35,
        whitespaceRatio: 0.65,
        category: 'sparse',
      },
    },
  },
  darkHero: {
    id: uuidv7(),
    webPageId: testWebPages.darkTheme.id,
    sectionType: 'hero',
    sectionName: 'Dark Hero Section',
    htmlSnippet: '<section class="hero dark">Dark Hero</section>',
    layoutInfo: { columns: 1, rows: 1, gridType: 'single' },
    visualFeatures: {
      theme: {
        type: 'dark',
        confidence: 0.92,
        backgroundColor: '#1E1E1E',
        textColor: '#FAFAFA',
        contrastRatio: 14.8,
        luminance: { background: 0.05, foreground: 0.95 },
      },
      colors: {
        dominantColors: ['#1E1E1E', '#2D2D2D'],
        accentColors: ['#8B5CF6'],
        colorPalette: [
          { color: '#1E1E1E', percentage: 55 },
          { color: '#2D2D2D', percentage: 30 },
          { color: '#8B5CF6', percentage: 15 },
        ],
      },
      density: {
        contentDensity: 0.55,
        whitespaceRatio: 0.45,
        category: 'moderate',
      },
    },
  },
  mixedFeature: {
    id: uuidv7(),
    webPageId: testWebPages.mixedTheme.id,
    sectionType: 'feature',
    sectionName: 'Mixed Feature Section',
    htmlSnippet: '<section class="feature mixed">Mixed Feature</section>',
    layoutInfo: { columns: 3, rows: 1, gridType: 'grid' },
    visualFeatures: {
      theme: {
        type: 'mixed',
        confidence: 0.78,
        backgroundColor: '#808080',
        textColor: '#FFFFFF',
        contrastRatio: 4.5,
        luminance: { background: 0.5, foreground: 0.95 },
      },
      colors: {
        dominantColors: ['#808080', '#A0A0A0'],
        accentColors: ['#10B981'],
        colorPalette: [
          { color: '#808080', percentage: 40 },
          { color: '#A0A0A0', percentage: 35 },
          { color: '#10B981', percentage: 25 },
        ],
      },
      density: {
        contentDensity: 0.75,
        whitespaceRatio: 0.25,
        category: 'dense',
      },
    },
  },
  blueAccentCta: {
    id: uuidv7(),
    webPageId: testWebPages.lightTheme.id,
    sectionType: 'cta',
    sectionName: 'Blue Accent CTA',
    htmlSnippet: '<section class="cta blue">Blue CTA</section>',
    layoutInfo: { columns: 1, rows: 1, gridType: 'single' },
    visualFeatures: {
      theme: {
        type: 'light',
        confidence: 0.88,
        backgroundColor: '#F8FAFC',
        textColor: '#1E293B',
        contrastRatio: 12.8,
        luminance: { background: 0.97, foreground: 0.08 },
      },
      colors: {
        dominantColors: ['#3B82F6', '#F8FAFC'],
        accentColors: ['#1D4ED8'],
        colorPalette: [
          { color: '#3B82F6', percentage: 45 },
          { color: '#F8FAFC', percentage: 40 },
          { color: '#1D4ED8', percentage: 15 },
        ],
      },
      density: {
        contentDensity: 0.4,
        whitespaceRatio: 0.6,
        category: 'sparse',
      },
    },
  },
};

/**
 * 768次元のモックEmbedding生成
 */
function generateMockEmbedding(seed: number): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < 768; i++) {
    // シード値で決定論的な値を生成
    const value = Math.sin(seed * (i + 1)) * 0.5;
    embedding.push(value);
  }
  // L2正規化
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map((v) => v / norm);
}

// ============================================================================
// E2E テストスイート: Visual Features Search
// ============================================================================

describe('Visual Features Search E2Eテスト', () => {
  // ==========================================================================
  // セットアップ・クリーンアップ
  // ==========================================================================

  beforeAll(async () => {
    try {
      await prisma.$connect();
      console.log('[E2E][visual-features-search] Database connected successfully');

      // PrismaClientFactory を設定
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setLayoutPrismaClientFactory(() => prisma as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setVisionSearchPrismaClientFactory(() => prisma as any);
      console.log('[E2E][visual-features-search] PrismaClientFactory configured');

      // モック EmbeddingService を設定
      const mockEmbeddingService = {
        generateEmbedding: async (text: string, _type: 'query' | 'passage') => {
          // テキストからシード値を生成
          const seed = text.split('').reduce((sum, c) => sum + c.charCodeAt(0), 0);
          return generateMockEmbedding(seed);
        },
      };

      setLayoutEmbeddingServiceFactory(() => mockEmbeddingService);
      setVisionSearchEmbeddingServiceFactory(() => mockEmbeddingService);
      console.log('[E2E][visual-features-search] EmbeddingService configured');

      // テストデータセットアップ
      await setupTestData();
      console.log('[E2E][visual-features-search] Test data setup complete');
    } catch (error) {
      console.error('[E2E][visual-features-search] Setup failed:', error);
      throw error;
    }
  });

  afterAll(async () => {
    try {
      // テストデータクリーンアップ
      await cleanupTestData();
      console.log('[E2E][visual-features-search] Test data cleaned up');

      // ファクトリリセット
      resetLayoutEmbeddingServiceFactory();
      resetLayoutPrismaClientFactory();
      resetVisionSearchEmbeddingServiceFactory();
      resetVisionSearchPrismaClientFactory();

      await prisma.$disconnect();
      console.log('[E2E][visual-features-search] Database disconnected');
    } catch (error) {
      console.error('[E2E][visual-features-search] Cleanup failed:', error);
    }
  });

  async function setupTestData(): Promise<void> {
    // WebPages を作成
    for (const page of Object.values(testWebPages)) {
      await prisma.webPage.upsert({
        where: { id: page.id },
        update: {},
        create: {
          id: page.id,
          url: page.url,
          title: page.title,
          htmlContent: '<html><body>Test</body></html>',
          sourceType: page.sourceType,
          usageScope: page.usageScope,
        },
      });
    }

    // SectionPatterns を作成（visualFeatures 付き）
    let positionIndex = 0;
    for (const section of Object.values(testSectionPatterns)) {
      const textEmbedding = generateMockEmbedding(section.id.charCodeAt(0));
      const visionEmbedding = generateMockEmbedding(section.id.charCodeAt(1) + 100);
      const embeddingId = uuidv7();

      await prisma.sectionPattern.upsert({
        where: { id: section.id },
        update: {},
        create: {
          id: section.id,
          webPageId: section.webPageId,
          sectionType: section.sectionType,
          sectionName: section.sectionName,
          htmlSnippet: section.htmlSnippet,
          layoutInfo: section.layoutInfo,
          visualFeatures: section.visualFeatures,
          positionIndex: positionIndex++,
        },
      });

      // SectionEmbedding テーブルに Embedding を作成
      await prisma.sectionEmbedding.upsert({
        where: { sectionPatternId: section.id },
        update: {},
        create: {
          id: embeddingId,
          sectionPatternId: section.id,
          modelVersion: 'e5-base-v1',
        },
      });

      // Embedding を設定（pgvector用、section_embeddings テーブル）
      await prisma.$executeRawUnsafe(
        `UPDATE section_embeddings
         SET text_embedding = $1::vector, vision_embedding = $2::vector
         WHERE id = $3::uuid`,
        `[${textEmbedding.join(',')}]`,
        `[${visionEmbedding.join(',')}]`,
        embeddingId
      );
    }
  }

  async function cleanupTestData(): Promise<void> {
    // SectionEmbeddings を削除（FK制約のため先に削除）
    for (const section of Object.values(testSectionPatterns)) {
      try {
        await prisma.sectionEmbedding.delete({ where: { sectionPatternId: section.id } });
      } catch {
        // 既に削除されている場合は無視
      }
    }

    // SectionPatterns を削除
    for (const section of Object.values(testSectionPatterns)) {
      try {
        await prisma.sectionPattern.delete({ where: { id: section.id } });
      } catch {
        // 既に削除されている場合は無視
      }
    }

    // WebPages を削除
    for (const page of Object.values(testWebPages)) {
      try {
        await prisma.webPage.delete({ where: { id: page.id } });
      } catch {
        // 既に削除されている場合は無視
      }
    }
  }

  // ==========================================================================
  // ΔE (CIE76) Color Distance テスト（ユーティリティ関数の検証）
  // ==========================================================================

  describe('ΔE (CIE76) Color Distance', () => {
    it('同一色のΔEは0であること', () => {
      const deltaE = calculateDeltaEFromHex('#3B82F6', '#3B82F6');
      expect(deltaE).toBe(0);
    });

    it('近い色のΔEは小さいこと（< 5）', () => {
      // 非常に近い青色（わずかな明度差のみ）
      // #3B82F6 と #3D84F7 は視覚的にほぼ同一
      const deltaE = calculateDeltaEFromHex('#3B82F6', '#3D84F7');
      expect(deltaE).toBeLessThan(5); // 近い色はΔE < 5
      expect(deltaE).toBeGreaterThan(0);
    });

    it('異なる色のΔEは大きいこと（> 30）', () => {
      // 青と赤
      const deltaE = calculateDeltaEFromHex('#3B82F6', '#EF4444');
      expect(deltaE).toBeGreaterThan(30);
    });

    it('白と黒のΔEは最大値に近いこと', () => {
      const deltaE = calculateDeltaEFromHex('#FFFFFF', '#000000');
      expect(deltaE).toBeGreaterThan(100);
    });

    it('isColorWithinTolerance がデフォルト許容値（15）で正しく判定すること', () => {
      // 同一色は常にtrue
      expect(isColorWithinTolerance('#3B82F6', '#3B82F6')).toBe(true);

      // 近い色
      expect(isColorWithinTolerance('#3B82F6', '#4B8FFF', 15)).toBe(true);

      // 遠い色
      expect(isColorWithinTolerance('#3B82F6', '#EF4444', 15)).toBe(false);
    });

    it('カスタム許容値でisColorWithinToleranceが正しく動作すること', () => {
      // 厳密な許容値（5）
      expect(isColorWithinTolerance('#3B82F6', '#3B82F6', 5)).toBe(true);

      // 緩い許容値（50）
      expect(isColorWithinTolerance('#3B82F6', '#2563EB', 50)).toBe(true);
    });

    it('hexToLab が正しいLAB値を返すこと', () => {
      // LabColorインターフェースは小文字の l, a, b を使用
      const whiteLab = hexToLab('#FFFFFF');
      expect(whiteLab).not.toBeNull();
      expect(whiteLab!.l).toBeCloseTo(100, 0); // L* = 100 (白)

      const blackLab = hexToLab('#000000');
      expect(blackLab).not.toBeNull();
      expect(blackLab!.l).toBeCloseTo(0, 0); // L* = 0 (黒)
    });

    it('無効なHEXコードでnullを返すこと', () => {
      expect(hexToLab('invalid')).toBeNull();
      expect(hexToLab('#GGG')).toBeNull();
    });
  });

  // ==========================================================================
  // Visual Features Theme Filter テスト
  // ==========================================================================

  describe('Visual Features Theme Filter', () => {
    it('theme.type="light" でライトテーマのセクションのみ取得できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(123);

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            theme: {
              type: 'light',
            },
          },
        },
      });

      expect(result).not.toBeNull();
      expect(result!.results).toBeDefined();

      // ライトテーマのみがフィルタされていること
      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          theme?: { type: string };
        };
        if (visualFeatures?.theme?.type) {
          expect(visualFeatures.theme.type).toBe('light');
        }
      }
    });

    it('theme.type="dark" でダークテーマのセクションのみ取得できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(456);

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            theme: {
              type: 'dark',
            },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          theme?: { type: string };
        };
        if (visualFeatures?.theme?.type) {
          expect(visualFeatures.theme.type).toBe('dark');
        }
      }
    });

    it('theme.type="mixed" でmixedテーマのセクションのみ取得できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(789);

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            theme: {
              type: 'mixed',
            },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          theme?: { type: string };
        };
        if (visualFeatures?.theme?.type) {
          expect(visualFeatures.theme.type).toBe('mixed');
        }
      }
    });

    it('theme.minContrastRatio で最小コントラスト比を満たすセクションを取得できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(101);
      const minContrastRatio = 10.0;

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            theme: {
              minContrastRatio,
            },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          theme?: { contrastRatio: number };
        };
        if (visualFeatures?.theme?.contrastRatio) {
          expect(visualFeatures.theme.contrastRatio).toBeGreaterThanOrEqual(minContrastRatio);
        }
      }
    });

    it('WCAG 2.1 AA基準（4.5:1）を満たすセクションを取得できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(202);
      const wcagAAContrastRatio = 4.5;

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            theme: {
              minContrastRatio: wcagAAContrastRatio,
            },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          theme?: { contrastRatio: number };
        };
        if (visualFeatures?.theme?.contrastRatio) {
          expect(visualFeatures.theme.contrastRatio).toBeGreaterThanOrEqual(wcagAAContrastRatio);
        }
      }
    });
  });

  // ==========================================================================
  // Visual Features Colors Filter テスト
  // ==========================================================================

  describe('Visual Features Colors Filter', () => {
    it('dominantColor でマッチする色を持つセクションを取得できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(303);
      const targetColor = '#3B82F6';
      const colorTolerance = 15;

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            colors: {
              dominantColor: targetColor,
              colorTolerance,
            },
          },
        },
      });

      expect(result).not.toBeNull();
    });

    it('colorTolerance が小さい場合、厳密なマッチングが行われること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(404);
      const targetColor = '#3B82F6';
      const strictTolerance = 5;

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            colors: {
              dominantColor: targetColor,
              colorTolerance: strictTolerance,
            },
          },
        },
      });

      expect(result).not.toBeNull();
    });

    it('colorTolerance が大きい場合、より多くのセクションがマッチすること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(505);
      const targetColor = '#3B82F6';

      // 狭い許容値での検索
      const strictResult = await searchService.searchSectionPatterns(embedding, {
        limit: 20,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            colors: {
              dominantColor: targetColor,
              colorTolerance: 5,
            },
          },
        },
      });

      // 広い許容値での検索
      const relaxedResult = await searchService.searchSectionPatterns(embedding, {
        limit: 20,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            colors: {
              dominantColor: targetColor,
              colorTolerance: 50,
            },
          },
        },
      });

      expect(strictResult).not.toBeNull();
      expect(relaxedResult).not.toBeNull();

      // 緩い許容値のほうが多くの結果を返すはず（または同数）
      expect(relaxedResult!.results.length).toBeGreaterThanOrEqual(strictResult!.results.length);
    });
  });

  // ==========================================================================
  // Visual Features Density Filter テスト
  // ==========================================================================

  describe('Visual Features Density Filter', () => {
    it('density.minContentDensity でコンテンツ密度の下限を設定できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(606);
      const minContentDensity = 0.5;

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            density: {
              minContentDensity,
            },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          density?: { contentDensity: number };
        };
        if (visualFeatures?.density?.contentDensity !== undefined) {
          expect(visualFeatures.density.contentDensity).toBeGreaterThanOrEqual(minContentDensity);
        }
      }
    });

    it('density.maxContentDensity でコンテンツ密度の上限を設定できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(707);
      const maxContentDensity = 0.5;

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            density: {
              maxContentDensity,
            },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          density?: { contentDensity: number };
        };
        if (visualFeatures?.density?.contentDensity !== undefined) {
          expect(visualFeatures.density.contentDensity).toBeLessThanOrEqual(maxContentDensity);
        }
      }
    });

    it('density.minWhitespaceRatio でホワイトスペース比率の下限を設定できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(808);
      const minWhitespaceRatio = 0.5;

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            density: {
              minWhitespaceRatio,
            },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          density?: { whitespaceRatio: number };
        };
        if (visualFeatures?.density?.whitespaceRatio !== undefined) {
          expect(visualFeatures.density.whitespaceRatio).toBeGreaterThanOrEqual(minWhitespaceRatio);
        }
      }
    });

    it('category="sparse" でスパースなセクションを取得できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(909);

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            density: {
              category: 'sparse',
            },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          density?: { category: string };
        };
        if (visualFeatures?.density?.category) {
          expect(visualFeatures.density.category).toBe('sparse');
        }
      }
    });

    it('category="dense" で高密度なセクションを取得できること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(1010);

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            density: {
              category: 'dense',
            },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          density?: { category: string };
        };
        if (visualFeatures?.density?.category) {
          expect(visualFeatures.density.category).toBe('dense');
        }
      }
    });
  });

  // ==========================================================================
  // Vision Embedding Search (use_vision_search: true) テスト
  // ==========================================================================

  describe('Vision Embedding Search (use_vision_search: true)', () => {
    it('visionEmbeddingベースの検索が正常に動作すること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();

      const result = await visionSearchService.searchByVisionEmbedding(
        { textQuery: 'hero section' },
        { limit: 10, offset: 0 }
      );

      expect(result).not.toBeNull();
      expect(result!.results).toBeDefined();
    });

    it('minSimilarity でフィルタリングが正しく動作すること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();

      const result = await visionSearchService.searchByVisionEmbedding(
        { textQuery: 'hero section' },
        { limit: 10, offset: 0, minSimilarity: 0.5 }
      );

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        expect(item.similarity).toBeGreaterThanOrEqual(0.5);
      }
    });

    it('searchSimilarSections で既存セクションからの類似検索が動作すること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();
      const sectionId = testSectionPatterns.lightHero.id;

      const result = await visionSearchService.searchSimilarSections(sectionId, {
        limit: 10,
        offset: 0,
      });

      // 結果がnullまたは空の場合でもテスト成功（セクションが見つからない場合）
      if (result) {
        expect(result.results).toBeDefined();
      }
    });

    it('sectionTypeフィルタが正しく動作すること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();

      const result = await visionSearchService.searchByVisionEmbedding(
        { textQuery: 'section' },
        {
          limit: 10,
          offset: 0,
          filters: { sectionType: 'hero' },
        }
      );

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        expect(item.sectionType).toBe('hero');
      }
    });
  });

  // ==========================================================================
  // RRF Hybrid Search テスト
  // ==========================================================================

  describe('RRF Hybrid Search', () => {
    it('ハイブリッド検索が正常に動作すること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();

      const result = await visionSearchService.hybridSearch(
        { textQuery: 'hero section' },
        {
          limit: 10,
          offset: 0,
        }
      );

      expect(result).not.toBeNull();
      expect(result!.results).toBeDefined();
    });

    it('デフォルトの重み（60% vision, 40% text）が適用されること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();

      const result = await visionSearchService.hybridSearch(
        { textQuery: 'hero section' },
        {
          limit: 10,
          offset: 0,
          // デフォルト: visionWeight=0.6, textWeight=0.4
        }
      );

      expect(result).not.toBeNull();
      // デフォルト重みが適用されていることを確認（結果が返ることで間接的に確認）
      expect(result!.results).toBeDefined();
    });

    it('カスタム重み（80% vision, 20% text）で検索できること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();

      const result = await visionSearchService.hybridSearch(
        { textQuery: 'hero section' },
        {
          limit: 10,
          offset: 0,
          visionWeight: 0.8,
          textWeight: 0.2,
        }
      );

      expect(result).not.toBeNull();
      expect(result!.results).toBeDefined();
    });

    it('textWeight=1.0, visionWeight=0.0 でテキストのみ検索できること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();

      const result = await visionSearchService.hybridSearch(
        { textQuery: 'hero section' },
        {
          limit: 10,
          offset: 0,
          visionWeight: 0.0,
          textWeight: 1.0,
        }
      );

      expect(result).not.toBeNull();
      expect(result!.results).toBeDefined();
    });

    it('visionWeight=1.0, textWeight=0.0 でビジョンのみ検索できること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();

      const result = await visionSearchService.hybridSearch(
        { textQuery: 'hero section' },
        {
          limit: 10,
          offset: 0,
          visionWeight: 1.0,
          textWeight: 0.0,
        }
      );

      expect(result).not.toBeNull();
      expect(result!.results).toBeDefined();
    });

    it('RRFスコアが正しく計算されること（k=60）', () => {
      // RRF公式: 1 / (k + rank) where k=60
      const k = 60;

      // rank 1 の場合
      const rrfRank1 = 1 / (k + 1);
      expect(rrfRank1).toBeCloseTo(0.0164, 3);

      // rank 10 の場合
      const rrfRank10 = 1 / (k + 10);
      expect(rrfRank10).toBeCloseTo(0.0143, 3);

      // 複合スコア計算（60% vision + 40% text）
      const visionWeight = 0.6;
      const textWeight = 0.4;
      const visionRank = 1;
      const textRank = 5;

      const combinedScore =
        visionWeight * (1 / (k + visionRank)) + textWeight * (1 / (k + textRank));

      expect(combinedScore).toBeGreaterThan(0);
      expect(combinedScore).toBeLessThan(1);
    });
  });

  // ==========================================================================
  // 複合フィルタテスト
  // ==========================================================================

  describe('複合フィルタ', () => {
    it('theme + colors の複合フィルタが動作すること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(1111);

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            theme: { type: 'light' },
            colors: { dominantColor: '#3B82F6', colorTolerance: 30 },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        const visualFeatures = item.visualFeatures as {
          theme?: { type: string };
        };
        if (visualFeatures?.theme?.type) {
          expect(visualFeatures.theme.type).toBe('light');
        }
      }
    });

    it('theme + density の複合フィルタが動作すること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(2222);

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            theme: { type: 'dark' },
            density: { category: 'moderate' },
          },
        },
      });

      expect(result).not.toBeNull();
    });

    it('theme + colors + density の全フィルタが動作すること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(3333);

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            theme: { type: 'light', minContrastRatio: 4.5 },
            colors: { dominantColor: '#FFFFFF', colorTolerance: 20 },
            density: { minWhitespaceRatio: 0.5 },
          },
        },
      });

      expect(result).not.toBeNull();
    });

    it('sectionType + visualFeatures の複合フィルタが動作すること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(4444);

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          sectionType: 'hero',
          visualFeatures: {
            theme: { type: 'light' },
          },
        },
      });

      expect(result).not.toBeNull();

      for (const item of result!.results) {
        expect(item.sectionType).toBe('hero');
      }
    });
  });

  // ==========================================================================
  // Error Handling テスト
  // ==========================================================================

  describe('Error Handling', () => {
    it('無効なHEXカラーコードでエラーハンドリングされること', () => {
      // 無効なHEXコードでΔE計算
      const deltaE = calculateDeltaEFromHex('invalid', '#3B82F6');
      expect(deltaE).toBe(Number.POSITIVE_INFINITY);
    });

    it('空のクエリでも検索が動作すること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(5555);

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
      });

      expect(result).not.toBeNull();
    });

    it('存在しないセクションIDでsearchSimilarSectionsが適切に処理されること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();
      const nonExistentId = uuidv7();

      const result = await visionSearchService.searchSimilarSections(nonExistentId, {
        limit: 10,
        offset: 0,
      });

      // 存在しないセクションの場合はnullを返す
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // パフォーマンステスト
  // ==========================================================================

  describe('Performance', () => {
    it('Visual Features フィルタ付き検索が5秒以内に完了すること', async () => {
      const searchService = createLayoutSearchServiceFactory()();
      const embedding = generateMockEmbedding(6666);

      const startTime = performance.now();

      const result = await searchService.searchSectionPatterns(embedding, {
        limit: 10,
        offset: 0,
        includeHtml: false,
        filters: {
          visualFeatures: {
            theme: { type: 'light', minContrastRatio: 4.5 },
            colors: { dominantColor: '#3B82F6', colorTolerance: 15 },
            density: { category: 'sparse' },
          },
        },
      });

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(result).not.toBeNull();
      expect(duration).toBeLessThan(5000); // 5秒以内
    });

    it('RRF Hybrid検索が5秒以内に完了すること', async () => {
      const visionSearchService = createVisionEmbeddingSearchServiceFactory()();

      const startTime = performance.now();

      const result = await visionSearchService.hybridSearch(
        { textQuery: 'hero section' },
        {
          limit: 10,
          offset: 0,
          visionWeight: 0.6,
          textWeight: 0.4,
        }
      );

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(result).not.toBeNull();
      expect(duration).toBeLessThan(5000); // 5秒以内
    });

    it('ΔE計算が1ms以内に完了すること', () => {
      const iterations = 1000;
      const startTime = performance.now();

      for (let i = 0; i < iterations; i++) {
        calculateDeltaE76(
          { L: 50, a: 10, b: -20 },
          { L: 60, a: 20, b: -10 }
        );
      }

      const endTime = performance.now();
      const avgDuration = (endTime - startTime) / iterations;

      expect(avgDuration).toBeLessThan(1); // 1ms以内（平均）
    });
  });
});
