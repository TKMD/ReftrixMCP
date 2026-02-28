// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.search auto_detect_context 機能テスト
 * REFTRIX-LAYOUT-02: クエリからコンテキストを自動推論し、検索結果をブースト
 *
 * @module tests/tools/layout/search-auto-detect-context.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  layoutSearchHandler,
  setLayoutSearchServiceFactory,
  resetLayoutSearchServiceFactory,
  type ILayoutSearchService,
} from '../../../src/tools/layout/search.tool';
import {
  QueryContextAnalyzer,
  type InferredContext,
} from '../../../src/services/query-context-analyzer';

// =====================================================
// テストデータ
// =====================================================

const mockSectionPatterns = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    webPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    sectionType: 'hero',
    sectionName: 'SaaS Hero Section',
    similarity: 0.85,
    layoutInfo: {
      type: 'hero',
      heading: 'Enterprise SaaS Platform',
      description: 'B2B software solution',
    },
    htmlSnippet: '<section class="hero">SaaS platform hero</section>',
    webPage: {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      url: 'https://example-saas.com',
      title: 'SaaS Platform',
      sourceType: 'award_gallery',
      usageScope: 'inspiration_only',
      screenshotDesktopUrl: 'https://example.com/screenshot1.png',
    },
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    webPageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    sectionType: 'hero',
    sectionName: 'E-commerce Hero',
    similarity: 0.80,
    layoutInfo: {
      type: 'hero',
      heading: 'Online Shopping',
      description: 'E-commerce store',
    },
    htmlSnippet: '<section class="hero">Shop now</section>',
    webPage: {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      url: 'https://example-shop.com',
      title: 'Online Store',
      sourceType: 'user_provided',
      usageScope: 'owned_asset',
      screenshotDesktopUrl: 'https://example.com/screenshot2.png',
    },
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    webPageId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    sectionType: 'hero',
    sectionName: 'Medical Hero',
    similarity: 0.75,
    layoutInfo: {
      type: 'hero',
      heading: 'Healthcare Solutions',
      description: 'Medical technology',
    },
    htmlSnippet: '<section class="hero">Healthcare platform</section>',
    webPage: {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      url: 'https://example-medical.com',
      title: 'Healthcare Platform',
      sourceType: 'award_gallery',
      usageScope: 'inspiration_only',
      screenshotDesktopUrl: null,
    },
  },
];

// =====================================================
// モックサービス
// =====================================================

function createMockService(
  overrides?: Partial<ILayoutSearchService>
): ILayoutSearchService {
  return {
    generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.15)),
    searchSectionPatterns: vi.fn().mockResolvedValue({
      results: mockSectionPatterns,
      total: 3,
    }),
    ...overrides,
  };
}

// =====================================================
// QueryContextAnalyzer 単体テスト
// =====================================================

describe('QueryContextAnalyzer', () => {
  let analyzer: QueryContextAnalyzer;

  beforeEach(() => {
    analyzer = new QueryContextAnalyzer();
  });

  describe('業界推論', () => {
    it('SaaS関連クエリから技術業界を推論する', () => {
      const context = analyzer.inferContext('SaaS landing page hero section');
      expect(context.industry).toBe('technology');
      expect(context.confidence).toBeGreaterThan(0.5);
    });

    it('E-commerce関連クエリから小売業界を推論する', () => {
      const context = analyzer.inferContext('e-commerce product showcase');
      expect(context.industry).toBe('ecommerce');
      expect(context.confidence).toBeGreaterThan(0.5);
    });

    it('医療関連クエリからヘルスケア業界を推論する', () => {
      const context = analyzer.inferContext('healthcare dashboard UI');
      expect(context.industry).toBe('healthcare');
      expect(context.confidence).toBeGreaterThan(0.5);
    });

    it('金融関連クエリから金融業界を推論する', () => {
      const context = analyzer.inferContext('fintech banking app interface');
      expect(context.industry).toBe('finance');
      expect(context.confidence).toBeGreaterThan(0.5);
    });

    it('教育関連クエリから教育業界を推論する', () => {
      const context = analyzer.inferContext('online course learning platform');
      expect(context.industry).toBe('education');
      expect(context.confidence).toBeGreaterThan(0.5);
    });

    it('日本語クエリからも業界を推論する', () => {
      const context = analyzer.inferContext('SaaS ヒーローセクション モダン');
      expect(context.industry).toBe('technology');
      expect(context.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('スタイル推論', () => {
    it('モダン/ミニマルスタイルを推論する', () => {
      const context = analyzer.inferContext('modern minimal hero clean design');
      expect(context.style).toBe('minimal');
      expect(context.confidence).toBeGreaterThan(0.5);
    });

    it('ボールド/ドラマチックスタイルを推論する', () => {
      const context = analyzer.inferContext('bold dramatic gradient hero');
      expect(context.style).toBe('bold');
      expect(context.confidence).toBeGreaterThan(0.5);
    });

    it('企業向け/プロフェッショナルスタイルを推論する', () => {
      const context = analyzer.inferContext('corporate professional business');
      expect(context.style).toBe('corporate');
      expect(context.confidence).toBeGreaterThan(0.5);
    });

    it('遊び心のあるスタイルを推論する', () => {
      const context = analyzer.inferContext('playful fun colorful vibrant');
      expect(context.style).toBe('playful');
      expect(context.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('複合推論', () => {
    it('業界とスタイル両方を推論する', () => {
      const context = analyzer.inferContext('SaaS minimal dashboard enterprise');
      expect(context.industry).toBe('technology');
      expect(context.style).toBe('minimal');
      expect(context.confidence).toBeGreaterThan(0.6);
    });

    it('コンテキストが不明確な場合はnullを返す', () => {
      const context = analyzer.inferContext('hero section');
      // 一般的なクエリでは業界/スタイルはnull
      expect(context.industry).toBeNull();
      expect(context.style).toBeNull();
      expect(context.confidence).toBeLessThan(0.5);
    });
  });

  describe('キーワード抽出', () => {
    it('推論に使用したキーワードを返す', () => {
      const context = analyzer.inferContext('SaaS minimal dashboard');
      expect(context.detectedKeywords).toContain('saas');
      expect(context.detectedKeywords).toContain('minimal');
    });
  });
});

// =====================================================
// layout.search auto_detect_context 統合テスト
// =====================================================

describe('layout.search auto_detect_context', () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
  });

  afterEach(() => {
    resetLayoutSearchServiceFactory();
  });

  describe('auto_detect_context=true（デフォルト）', () => {
    it('デフォルトでauto_detect_contextが有効になっている', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const result = await layoutSearchHandler({
        query: 'SaaS hero section',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // inferred_contextがレスポンスに含まれる
        expect(result.data.inferred_context).toBeDefined();
        expect(result.data.inferred_context?.industry).toBe('technology');
      }
    });

    it('推論されたコンテキストに基づいて結果がソートされる', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const result = await layoutSearchHandler({
        query: 'SaaS landing page hero',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // SaaS関連の結果が上位に来る
        const results = result.data.results;
        expect(results.length).toBeGreaterThan(0);
        // context_boost_appliedフラグが設定される
        expect(result.data.context_boost_applied).toBe(true);
      }
    });

    it('inferred_contextには業界・スタイル・信頼度が含まれる', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const result = await layoutSearchHandler({
        query: 'SaaS minimal dashboard design',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const ctx = result.data.inferred_context;
        expect(ctx).toBeDefined();
        expect(ctx?.industry).toBe('technology');
        expect(ctx?.style).toBe('minimal');
        expect(ctx?.confidence).toBeGreaterThan(0.5);
        expect(ctx?.detected_keywords).toContain('saas');
      }
    });
  });

  describe('auto_detect_context=false', () => {
    it('auto_detect_context=falseで推論を無効化できる', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const result = await layoutSearchHandler({
        query: 'SaaS hero section',
        auto_detect_context: false,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // inferred_contextがレスポンスに含まれない
        expect(result.data.inferred_context).toBeUndefined();
        expect(result.data.context_boost_applied).toBe(false);
      }
    });
  });

  describe('コンテキストブースト計算', () => {
    it('業界マッチでsimilarityがブーストされる', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const result = await layoutSearchHandler({
        query: 'SaaS enterprise platform',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // SaaS結果のsimilarityが他より高くなる
        const saasResult = result.data.results.find(
          r => r.preview.heading?.toLowerCase().includes('saas') ||
               r.source.url.includes('saas')
        );
        if (saasResult) {
          expect(saasResult.context_boost).toBeGreaterThan(0);
        }
      }
    });

    it('ブースト後もsimilarityは1.0を超えない', async () => {
      const mockService = createMockService({
        searchSectionPatterns: vi.fn().mockResolvedValue({
          results: [{
            ...mockSectionPatterns[0],
            similarity: 0.98,
          }],
          total: 1,
        }),
      });
      setLayoutSearchServiceFactory(() => mockService);

      const result = await layoutSearchHandler({
        query: 'SaaS enterprise dashboard',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        result.data.results.forEach(r => {
          expect(r.similarity).toBeLessThanOrEqual(1.0);
        });
      }
    });
  });

  describe('既存project_contextとの互換性', () => {
    it('project_contextとauto_detect_contextを併用できる', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      const result = await layoutSearchHandler({
        query: 'SaaS hero section',
        project_context: {
          enabled: true,
          project_path: '/home/user/my-project',
        },
        auto_detect_context: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // 両方のコンテキストが適用される
        expect(result.data.inferred_context).toBeDefined();
      }
    });
  });

  describe('エッジケース', () => {
    it('空のクエリでもエラーにならない', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      // 空クエリはバリデーションエラーになる
      const result = await layoutSearchHandler({
        query: '',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('コンテキスト推論に失敗しても検索は続行される', async () => {
      const mockService = createMockService();
      setLayoutSearchServiceFactory(() => mockService);

      // 一般的なクエリでコンテキスト推論が低信頼度（特定の業界/スタイルキーワードを含まない）
      const result = await layoutSearchHandler({
        query: 'hero section with button',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // 結果は返される（ブーストなし）
        expect(result.data.results.length).toBeGreaterThan(0);
        expect(result.data.context_boost_applied).toBe(false);
      }
    });
  });
});
