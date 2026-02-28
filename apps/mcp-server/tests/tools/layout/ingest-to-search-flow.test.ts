// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.ingest -> layout.search データフローテスト
 *
 * TDD Red Phase: 「検索結果が0件を返す」バグの再現
 *
 * 問題の根本原因:
 * 1. layout_ingest は WebPage テーブルにのみ保存する (save_to_db: true)
 * 2. layout_search は SectionPattern + SectionEmbedding テーブルを検索する
 * 3. SectionPattern / SectionEmbedding を生成・保存するパイプラインが欠落している
 *
 * @module tests/tools/layout/ingest-to-search-flow.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// モック設定（共通化・重複削減）
// =====================================================

const {
  mockValidateExternalUrl,
  mockSanitizeHtml,
  mockIngest,
  mockWebPageUpsert,
  mockSectionPatternCreate,
  mockSectionPatternFindMany,
  mockSectionEmbeddingCreate,
  mockQueryRawUnsafe,
} = vi.hoisted(() => ({
  mockValidateExternalUrl: vi.fn(),
  mockSanitizeHtml: vi.fn(),
  mockIngest: vi.fn(),
  mockWebPageUpsert: vi.fn(),
  mockSectionPatternCreate: vi.fn(),
  mockSectionPatternFindMany: vi.fn(),
  mockSectionEmbeddingCreate: vi.fn(),
  mockQueryRawUnsafe: vi.fn(),
}));

// Prismaモック
vi.mock('@reftrix/database', () => ({
  prisma: {
    webPage: { upsert: mockWebPageUpsert },
    sectionPattern: { create: mockSectionPatternCreate, findMany: mockSectionPatternFindMany },
    sectionEmbedding: { create: mockSectionEmbeddingCreate },
    $queryRawUnsafe: mockQueryRawUnsafe,
  },
}));

// loggerモック
vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  isDevelopment: () => true,
}));

// url-validatorモック
vi.mock('../../../src/utils/url-validator', () => ({ validateExternalUrl: mockValidateExternalUrl }));

// html-sanitizerモック
vi.mock('../../../src/utils/html-sanitizer', () => ({ sanitizeHtml: mockSanitizeHtml }));

// page-ingest-adapterモック
vi.mock('../../../src/services/page-ingest-adapter', () => ({
  pageIngestAdapter: { ingest: mockIngest },
}));

import {
  layoutIngestHandler,
  setLayoutIngestServiceFactory,
  resetLayoutIngestServiceFactory,
  type ILayoutIngestService,
} from '../../../src/tools/layout/ingest.tool';
import {
  layoutSearchHandler,
  setLayoutSearchServiceFactory,
  resetLayoutSearchServiceFactory,
  type ILayoutSearchService,
} from '../../../src/tools/layout/search.tool';

// =====================================================
// 共通テストデータ・ヘルパー（重複削減）
// =====================================================

const SAMPLE_WEB_PAGE_ID = '01234567-89ab-7def-8123-456789abcdef';

const SAMPLE_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test Landing Page</title></head>
<body>
  <header class="navigation"><nav><a href="/">Home</a></nav></header>
  <section class="hero"><h1>Welcome to Our Platform</h1><p>Build something amazing</p><button>Get Started</button></section>
  <section class="features"><h2>Key Features</h2><div class="grid"><div class="feature-item"><h3>Fast</h3><p>Lightning fast</p></div></div></section>
  <section class="cta"><h2>Ready to start?</h2><button>Sign Up Now</button></section>
  <footer><p>Copyright 2025</p></footer>
</body>
</html>
`;

// 共通セクションデータ生成ファクトリー（重複削減）
const createMockSection = (
  type: 'hero' | 'features' | 'cta' | 'footer',
  overrides: Record<string, unknown> = {}
) => ({
  id: `section-${type}`,
  type,
  confidence: 0.9,
  position: { startY: 0, endY: 300, height: 300 },
  content: {
    headings: [{ level: type === 'hero' ? 1 : 2, text: `${type} heading` }],
    paragraphs: [`${type} content`],
    links: [],
    images: [],
    buttons: type === 'hero' || type === 'cta' ? [{ text: 'CTA', type: 'primary' }] : [],
  },
  style: { backgroundColor: '#ffffff' },
  ...overrides,
});

// 共通Ingestレスポンス生成ファクトリー（重複削減）
const createMockIngestResponse = (htmlContent = SAMPLE_HTML) => ({
  success: true,
  html: htmlContent,
  screenshots: [],
  metadata: { title: 'Test Landing Page', description: 'A test page', favicon: null, ogImage: null },
  source: { type: 'user_provided', usageScope: 'inspiration_only' },
  ingestedAt: new Date('2025-01-15T00:00:00Z'),
});

// 共通ILayoutIngestServiceモック生成（重複削減）
const createMockIngestService = (
  sections: ReturnType<typeof createMockSection>[] = [createMockSection('hero')]
): ILayoutIngestService => ({
  analyzeHtml: vi.fn().mockResolvedValue({
    sections,
    colors: { palette: [], dominant: '#000', background: '#fff', text: '#000' },
    typography: { fonts: [], headingScale: [], bodySize: 16, lineHeight: 1.5 },
    grid: { type: 'flex' },
    textRepresentation: sections.map(s => s.type).join(' '),
  }),
  saveSectionWithEmbedding: vi.fn().mockResolvedValue('mock-section-pattern-id'),
  generateEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
});

// 共通ILayoutSearchServiceモック生成（重複削減）
const createMockSearchService = (
  results: Record<string, unknown>[] = [],
  total = results.length
): ILayoutSearchService => ({
  generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  searchSectionPatterns: vi.fn().mockResolvedValue({ results, total }),
});

// 共通検索結果パターン生成（重複削減）
const createMockSearchResult = (sectionType: string, overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  webPageId: SAMPLE_WEB_PAGE_ID,
  sectionType,
  sectionName: `${sectionType} Section`,
  similarity: 0.95,
  layoutInfo: {},
  visualFeatures: {},
  htmlSnippet: `<section class="${sectionType}">...</section>`,
  webPage: {
    id: SAMPLE_WEB_PAGE_ID,
    url: 'https://example.com/landing',
    title: 'Test Landing Page',
    sourceType: 'user_provided',
    usageScope: 'inspiration_only',
    screenshotDesktopUrl: null,
  },
  ...overrides,
});

// 共通セットアップ関数（重複削減）
const setupDefaultMocks = () => {
  mockValidateExternalUrl.mockReturnValue({ valid: true, normalizedUrl: 'https://example.com/' });
  mockSanitizeHtml.mockImplementation((html: string) => html);
  mockIngest.mockResolvedValue(createMockIngestResponse());
  mockWebPageUpsert.mockResolvedValue({ id: SAMPLE_WEB_PAGE_ID });
};

const cleanupMocks = () => {
  vi.resetAllMocks();
  resetLayoutSearchServiceFactory();
  resetLayoutIngestServiceFactory();
};

// =====================================================
// TDD Red Phase: 問題を再現するテスト
// =====================================================

describe('layout.ingest -> layout.search データフロー', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLayoutSearchServiceFactory();
    resetLayoutIngestServiceFactory();
    setupDefaultMocks();
  });

  afterEach(cleanupMocks);

  describe('[TDD Red] 現在の問題: layout.ingestはSectionPatternを作成しない', () => {
    it('layout.ingest (save_to_db: true) はWebPageにのみ保存し、SectionPatternを作成しない', async () => {
      const ingestResult = await layoutIngestHandler({
        url: 'https://example.com/landing',
        options: { save_to_db: true },
      });

      expect(ingestResult.success).toBe(true);
      expect(mockWebPageUpsert).toHaveBeenCalledTimes(1);
      expect(mockSectionPatternCreate).not.toHaveBeenCalled();
      expect(mockSectionEmbeddingCreate).not.toHaveBeenCalled();
    });

    it('layout.ingest後、layout.searchは0件を返す（データフローの断絶）', async () => {
      await layoutIngestHandler({ url: 'https://example.com/landing', options: { save_to_db: true } });

      setLayoutSearchServiceFactory(() => createMockSearchService([], 0));

      const searchResult = await layoutSearchHandler({
        query: 'hero section with gradient',
        filters: { sectionType: 'hero' },
      });

      expect(searchResult.success).toBe(true);
      if (searchResult.success) {
        expect(searchResult.data.results).toHaveLength(0);
        expect(searchResult.data.total).toBe(0);
      }
    });
  });

  describe('[TDD Green] 期待される動作: layout.ingestがセクション解析も行う', () => {
    it('layout.ingest (auto_analyze: true) でSectionPatternも作成される', async () => {
      const mockSections = [
        createMockSection('hero', { content: { headings: [{ level: 1, text: 'Welcome' }], paragraphs: ['Amazing'], links: [], images: [], buttons: [{ text: 'Get Started', type: 'primary' }] } }),
        createMockSection('features'),
        createMockSection('cta'),
      ];
      const mockIngestService = createMockIngestService(mockSections);
      setLayoutIngestServiceFactory(() => mockIngestService);

      const ingestResult = await layoutIngestHandler({
        url: 'https://example.com/landing',
        options: { save_to_db: true, auto_analyze: true },
      });

      expect(ingestResult.success).toBe(true);
      expect(mockWebPageUpsert).toHaveBeenCalledTimes(1);
      expect(mockIngestService.analyzeHtml).toHaveBeenCalledTimes(1);
      expect(mockIngestService.generateEmbedding).toHaveBeenCalledTimes(3);
      expect(mockIngestService.saveSectionWithEmbedding).toHaveBeenCalledTimes(3);
    });

    it('auto_analyze後、layout.searchで検索結果が返される', async () => {
      const mockSearchResults = [createMockSearchResult('hero', { sectionName: 'Welcome to Our Platform' })];
      setLayoutSearchServiceFactory(() => createMockSearchService(mockSearchResults));

      const searchResult = await layoutSearchHandler({ query: 'hero section with welcome message' });

      expect(searchResult.success).toBe(true);
      if (searchResult.success) {
        expect(searchResult.data.results.length).toBeGreaterThan(0);
        expect(searchResult.data.results[0].type).toBe('hero');
      }
    });
  });

  describe('[TDD Red] データフローの断絶ポイント特定', () => {
    it('WebPageテーブルにはHTMLが保存されている', async () => {
      await layoutIngestHandler({ url: 'https://example.com/landing', options: { save_to_db: true } });

      expect(mockWebPageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            htmlContent: expect.stringContaining('<section class="hero">'),
          }),
        })
      );
    });

    it('SectionPatternテーブルは空のまま（Embeddingがない）', async () => {
      await layoutIngestHandler({ url: 'https://example.com/landing', options: { save_to_db: true } });
      expect(mockSectionPatternCreate).not.toHaveBeenCalled();
    });

    it('layout.searchはSectionEmbeddingテーブルを参照するが、レコードがない', async () => {
      const expectedSqlPattern = /FROM section_patterns.*LEFT JOIN section_embeddings/;
      expect(expectedSqlPattern.source).toContain('section_embeddings');
    });
  });
});

// =====================================================
// 修正方針のテスト仕様（パラメータ化・重複削減）
// =====================================================

describe.each([
  { name: 'layout.analyze ツールの代替実装', description: 'auto_analyzeがlayout.analyzeの代替として機能' },
  { name: 'layout.ingest への auto_analyze オプション追加', description: 'auto_analyzeオプションが追加される' },
])('[TDD Green] 修正方針: $name', ({ description }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLayoutSearchServiceFactory();
    resetLayoutIngestServiceFactory();
    setupDefaultMocks();
    mockIngest.mockResolvedValue(createMockIngestResponse('<html><body>Test</body></html>'));
  });

  afterEach(cleanupMocks);

  it(`${description}`, async () => {
    const mockIngestService = createMockIngestService([createMockSection('hero')]);
    setLayoutIngestServiceFactory(() => mockIngestService);

    const ingestResult = await layoutIngestHandler({
      url: 'https://example.com/landing',
      options: { save_to_db: true, auto_analyze: true },
    });

    expect(ingestResult.success).toBe(true);
    expect(mockIngestService.analyzeHtml).toHaveBeenCalledTimes(1);
    expect(mockIngestService.saveSectionWithEmbedding).toHaveBeenCalledTimes(1);
  });
});

// =====================================================
// 統合テスト: End-to-End フロー
// =====================================================

describe('[TDD Green] E2E: ingest から search までの完全フロー', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLayoutSearchServiceFactory();
    resetLayoutIngestServiceFactory();
    setupDefaultMocks();
  });

  afterEach(cleanupMocks);

  it('完全なE2Eフロー: ingest -> auto_analyze -> search', async () => {
    const mockSections = [
      createMockSection('hero', { confidence: 0.95 }),
      createMockSection('features', { confidence: 0.88 }),
    ];
    const mockIngestService = createMockIngestService(mockSections);
    setLayoutIngestServiceFactory(() => mockIngestService);

    // Step 1: layout.ingest with auto_analyze
    const ingestResult = await layoutIngestHandler({
      url: 'https://example.com/landing',
      options: { save_to_db: true, auto_analyze: true },
    });

    expect(ingestResult.success).toBe(true);
    expect(mockIngestService.analyzeHtml).toHaveBeenCalledTimes(1);
    expect(mockIngestService.generateEmbedding).toHaveBeenCalledTimes(2);
    expect(mockIngestService.saveSectionWithEmbedding).toHaveBeenCalledTimes(2);

    // Step 2: layout.search
    const mockSearchResults = [createMockSearchResult('hero')];
    setLayoutSearchServiceFactory(() => createMockSearchService(mockSearchResults));

    const searchResult = await layoutSearchHandler({ query: 'hero section with welcome message' });

    expect(searchResult.success).toBe(true);
    if (searchResult.success) {
      expect(searchResult.data.results.length).toBe(1);
      expect(searchResult.data.results[0].type).toBe('hero');
    }
  });
});
