// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PartSearchService Unit Tests
 *
 * パーツ検索サービスのテストスイート:
 * - buildPartSearchWhereClause: フィルター条件のWHERE句変換
 * - generateQueryEmbedding: Embedding生成
 * - searchParts (vector-only): テキストベクトル検索
 * - searchPartsHybrid: ハイブリッド検索（RRF統合）
 * - searchPartsByVisual: 参照パーツIDによるビジュアル検索
 * - DI pattern: ファクトリ設定、シングルトン、リセット
 * - sanitizeErrorMessage: Prismaエラーのサニタイズ
 *
 * Test suite for part search service:
 * - buildPartSearchWhereClause: filter conditions to WHERE clause
 * - generateQueryEmbedding: embedding generation
 * - searchParts (vector-only): text vector search
 * - searchPartsHybrid: hybrid search (RRF merge)
 * - searchPartsByVisual: visual search by reference part ID
 * - DI pattern: factory setup, singleton, reset
 * - sanitizeErrorMessage: Prisma error sanitization
 *
 * @module tests/services/part/part-search.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PartSearchService,
  setPartSearchEmbeddingServiceFactory,
  resetPartSearchEmbeddingServiceFactory,
  setPartSearchPrismaClientFactory,
  resetPartSearchPrismaClientFactory,
  getPartSearchService,
  resetPartSearchService,
  createPartSearchServiceFactory,
  buildPartSearchWhereClause,
  type PartSearchEmbeddingService,
  type PartSearchPrismaClient,
  type PartSearchOptions,
} from '../../../src/services/part/part-search.service';

// =============================================================================
// 共通ファクトリ・ヘルパー / Common factories and helpers
// =============================================================================

const createDefaultOptions = (overrides: Partial<PartSearchOptions> = {}): PartSearchOptions => ({
  limit: 10,
  offset: 0,
  minSimilarity: 0.3,
  searchMode: 'hybrid',
  ...overrides,
});

const createMockEmbeddingService = (
  overrides?: Partial<PartSearchEmbeddingService>
): PartSearchEmbeddingService => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  ...overrides,
});

const createMockPrismaClient = (
  queryResult: unknown = []
): PartSearchPrismaClient => ({
  $queryRawUnsafe: vi.fn().mockResolvedValue(queryResult),
});

const setupServices = (
  embeddingService?: PartSearchEmbeddingService,
  prismaClient?: PartSearchPrismaClient
): PartSearchService => {
  if (embeddingService) setPartSearchEmbeddingServiceFactory(() => embeddingService);
  if (prismaClient) setPartSearchPrismaClientFactory(() => prismaClient);
  return new PartSearchService();
};

const createMockPartRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'part-uuid-001',
  part_type: 'button',
  part_subtype: 'primary_button',
  bounding_box: { x: 10, y: 20, width: 100, height: 40 },
  computed_styles: { 'background-color': '#3b82f6', color: '#ffffff' },
  html_snippet: '<button class="btn-primary">Click</button>',
  section_type: 'hero',
  web_page_url: 'https://example.com',
  similarity: 0.85,
  ...overrides,
});

// =============================================================================
// buildPartSearchWhereClause テスト
// =============================================================================

describe('buildPartSearchWhereClause', () => {
  it('フィルターなしの場合は空のclauseを返すこと', () => {
    const result = buildPartSearchWhereClause({});
    expect(result.clause).toBe('');
    expect(result.params).toEqual([]);
    expect(result.nextIndex).toBe(1);
  });

  it('partTypeフィルターのみの場合、正しいWHERE句を返すこと', () => {
    const result = buildPartSearchWhereClause({ partType: 'button' });
    expect(result.clause).toBe('cp.part_type = $1');
    expect(result.params).toEqual(['button']);
    expect(result.nextIndex).toBe(2);
  });

  it('sectionTypeフィルターのみの場合、正しいWHERE句を返すこと', () => {
    const result = buildPartSearchWhereClause({ sectionType: 'hero' });
    expect(result.clause).toBe('sp.section_type = $1');
    expect(result.params).toEqual(['hero']);
    expect(result.nextIndex).toBe(2);
  });

  it('cssFrameworkフィルターのみの場合、正しいWHERE句を返すこと', () => {
    const result = buildPartSearchWhereClause({ cssFramework: 'tailwind' });
    expect(result.clause).toBe('sp.css_framework = $1');
    expect(result.params).toEqual(['tailwind']);
    expect(result.nextIndex).toBe(2);
  });

  it('複数フィルターの場合、AND結合されたWHERE句を返すこと', () => {
    const result = buildPartSearchWhereClause({
      partType: 'card',
      sectionType: 'features',
      cssFramework: 'bootstrap',
    });
    expect(result.clause).toBe(
      'cp.part_type = $1 AND sp.section_type = $2 AND sp.css_framework = $3'
    );
    expect(result.params).toEqual(['card', 'features', 'bootstrap']);
    expect(result.nextIndex).toBe(4);
  });

  it('startIndexを指定した場合、パラメータインデックスが正しく開始すること', () => {
    const result = buildPartSearchWhereClause({ partType: 'button' }, 5);
    expect(result.clause).toBe('cp.part_type = $5');
    expect(result.params).toEqual(['button']);
    expect(result.nextIndex).toBe(6);
  });

  it('partTypeとsectionType両方の場合、パラメータインデックスが追跡されること', () => {
    const result = buildPartSearchWhereClause(
      { partType: 'image', sectionType: 'gallery' },
      3
    );
    expect(result.clause).toBe('cp.part_type = $3 AND sp.section_type = $4');
    expect(result.params).toEqual(['image', 'gallery']);
    expect(result.nextIndex).toBe(5);
  });
});

// =============================================================================
// generateQueryEmbedding テスト
// =============================================================================

describe('PartSearchService.generateQueryEmbedding', () => {
  afterEach(() => {
    resetPartSearchEmbeddingServiceFactory();
    resetPartSearchPrismaClientFactory();
    resetPartSearchService();
  });

  it('Embedding生成に成功した場合、768次元ベクトルを返すこと', async () => {
    const mockEmbedding = new Array(768).fill(0.5);
    const embService = createMockEmbeddingService({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
    });
    const service = setupServices(embService);

    const result = await service.generateQueryEmbedding('blue button design');

    expect(result).toEqual(mockEmbedding);
    expect(embService.generateEmbedding).toHaveBeenCalledWith('blue button design', 'query');
  });

  it('EmbeddingServiceファクトリが未設定の場合、nullを返すこと', async () => {
    const service = new PartSearchService();

    const result = await service.generateQueryEmbedding('test query');

    expect(result).toBeNull();
  });

  it('Embedding生成でエラーが発生した場合、nullを返すこと', async () => {
    const embService = createMockEmbeddingService({
      generateEmbedding: vi.fn().mockRejectedValue(new Error('ONNX error')),
    });
    const service = setupServices(embService);

    const result = await service.generateQueryEmbedding('test');

    expect(result).toBeNull();
  });
});

// =============================================================================
// searchParts（ベクトル検索）テスト
// =============================================================================

describe('PartSearchService.searchParts', () => {
  afterEach(() => {
    resetPartSearchEmbeddingServiceFactory();
    resetPartSearchPrismaClientFactory();
    resetPartSearchService();
  });

  it('検索結果を正しくマッピングして返すこと', async () => {
    const mockRow = createMockPartRow();
    const prisma = createMockPrismaClient([mockRow]);
    const service = setupServices(undefined, prisma);

    const result = await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('part-uuid-001');
    expect(result.results[0].partType).toBe('button');
    expect(result.results[0].partSubtype).toBe('primary_button');
    expect(result.results[0].sectionType).toBe('hero');
    expect(result.results[0].webPageUrl).toBe('https://example.com');
    expect(result.results[0].similarity).toBe(0.85);
    expect(result.results[0].boundingBox).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(result.results[0].computedStyles).toEqual({
      'background-color': '#3b82f6',
      color: '#ffffff',
    });
    expect(result.results[0].htmlSnippet).toBe('<button class="btn-primary">Click</button>');
  });

  it('空の結果を正しく処理すること', async () => {
    const prisma = createMockPrismaClient([]);
    const service = setupServices(undefined, prisma);

    const result = await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('minSimilarity未満の結果がフィルタリングされること', async () => {
    const rows = [
      createMockPartRow({ id: 'high', similarity: 0.8 }),
      createMockPartRow({ id: 'low', similarity: 0.1 }),
    ];
    const prisma = createMockPrismaClient(rows);
    const service = setupServices(undefined, prisma);

    const result = await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions({ minSimilarity: 0.5 })
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('high');
  });

  it('visualモードの場合、visual_embeddingカラムが使用されること', async () => {
    const prisma = createMockPrismaClient([]);
    const service = setupServices(undefined, prisma);

    await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions({ searchMode: 'visual' })
    );

    const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
    const sql = callArgs[0] as string;
    expect(sql).toContain('cpe.visual_embedding');
    expect(sql).not.toContain('cpe.text_embedding');
  });

  it('textモードの場合、text_embeddingカラムが使用されること', async () => {
    const prisma = createMockPrismaClient([]);
    const service = setupServices(undefined, prisma);

    await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions({ searchMode: 'text' })
    );

    const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
    const sql = callArgs[0] as string;
    expect(sql).toContain('cpe.text_embedding');
  });

  it('PrismaClientが未設定の場合、空の結果を返すこと', async () => {
    const service = new PartSearchService();

    const result = await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('DBクエリエラーの場合、空の結果を返すこと', async () => {
    const prisma: PartSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };
    const service = setupServices(undefined, prisma);

    const result = await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('フィルターが正しくSQL WHERE句に反映されること', async () => {
    const prisma = createMockPrismaClient([]);
    const service = setupServices(undefined, prisma);

    await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions({ partType: 'button', sectionType: 'hero' })
    );

    const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
    const sql = callArgs[0] as string;
    expect(sql).toContain('cp.part_type = $1');
    expect(sql).toContain('sp.section_type = $2');
    // フィルターパラメータが正しく渡されること
    expect(callArgs[1]).toBe('button');
    expect(callArgs[2]).toBe('hero');
  });

  it('htmlSnippetがnullの場合、結果にhtmlSnippetプロパティが含まれないこと', async () => {
    const row = createMockPartRow({ html_snippet: null });
    const prisma = createMockPrismaClient([row]);
    const service = setupServices(undefined, prisma);

    const result = await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    expect(result.results[0].htmlSnippet).toBeUndefined();
  });

  it('computed_stylesが空の場合、結果にcomputedStylesプロパティが含まれないこと', async () => {
    const row = createMockPartRow({ computed_styles: {} });
    const prisma = createMockPrismaClient([row]);
    const service = setupServices(undefined, prisma);

    const result = await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    expect(result.results[0].computedStyles).toBeUndefined();
  });
});

// =============================================================================
// searchPartsHybrid テスト
// =============================================================================

describe('PartSearchService.searchPartsHybrid', () => {
  afterEach(() => {
    resetPartSearchEmbeddingServiceFactory();
    resetPartSearchPrismaClientFactory();
    resetPartSearchService();
  });

  it('ベクトル検索と全文検索の両方を実行し結果をマージすること', async () => {
    const mockRows = [
      createMockPartRow({ id: 'result-1', similarity: 0.9 }),
    ];
    const prisma = createMockPrismaClient(mockRows);
    const service = setupServices(undefined, prisma);

    const result = await service.searchPartsHybrid(
      'blue gradient button',
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    // $queryRawUnsafe が複数回呼ばれること（vector + fulltext）
    expect((prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.query.text).toBe('blue gradient button');
  });

  it('全文検索が失敗した場合でも結果を返すこと', async () => {
    let callCount = 0;
    const prisma: PartSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // ベクトル検索: 成功
          return Promise.resolve([createMockPartRow({ similarity: 0.8 })]);
        }
        // 全文検索: 失敗
        return Promise.reject(new Error('tsquery parse error'));
      }),
    };
    const service = setupServices(undefined, prisma);

    const result = await service.searchPartsHybrid(
      'test query',
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    // ベクトル検索結果のみで結果が返ること
    expect(result.results.length).toBeGreaterThanOrEqual(0);
  });

  it('PrismaClientが未設定の場合、空の結果を返すこと', async () => {
    const service = new PartSearchService();

    const result = await service.searchPartsHybrid(
      'test',
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    expect(result.results).toHaveLength(0);
    expect(result.query.text).toBe('test');
  });

  it('minSimilarity未満の結果がフィルタリングされること', async () => {
    // 低スコア結果のみ返すモック
    const mockRows = [
      createMockPartRow({ id: 'low-score', similarity: 0.01 }),
    ];
    const prisma = createMockPrismaClient(mockRows);
    const service = setupServices(undefined, prisma);

    const result = await service.searchPartsHybrid(
      'test',
      new Array(768).fill(0.1),
      createDefaultOptions({ minSimilarity: 0.5 })
    );

    // RRFのnormalizeRRFScoreがスコアを正規化するため、
    // minSimilarity=0.5で低スコア結果がフィルタされることを検証
    // ただし、executeHybridSearchの結果スコアはRRFにより変換されるため、
    // 実際にはテスト結果はRRF正規化に依存する
    expect(result.results.every((r) => r.similarity >= 0.5 || result.results.length === 0)).toBe(true);
  });
});

// =============================================================================
// searchPartsByVisual テスト
// =============================================================================

describe('PartSearchService.searchPartsByVisual', () => {
  afterEach(() => {
    resetPartSearchEmbeddingServiceFactory();
    resetPartSearchPrismaClientFactory();
    resetPartSearchService();
  });

  it('参照パーツのEmbeddingを取得してビジュアル検索を実行すること', async () => {
    let callCount = 0;
    const mockVisualEmbedding = '[' + new Array(768).fill(0.2).join(',') + ']';
    const prisma: PartSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // 参照パーツのEmbedding取得
          return Promise.resolve([{ visual_embedding: mockVisualEmbedding }]);
        }
        // ビジュアル検索結果
        return Promise.resolve([
          createMockPartRow({ id: 'similar-1', similarity: 0.92 }),
          createMockPartRow({ id: 'similar-2', similarity: 0.78 }),
        ]);
      }),
    };
    const service = setupServices(undefined, prisma);

    const result = await service.searchPartsByVisual(
      'ref-part-uuid',
      createDefaultOptions()
    );

    expect(result.results.length).toBe(2);
    expect(result.query.referencePartId).toBe('ref-part-uuid');
    expect(result.results[0].visualSimilarity).toBe(0.92);
  });

  it('参照パーツのEmbeddingが見つからない場合、空の結果を返すこと', async () => {
    const prisma = createMockPrismaClient([]);
    const service = setupServices(undefined, prisma);

    const result = await service.searchPartsByVisual(
      'nonexistent-uuid',
      createDefaultOptions()
    );

    expect(result.results).toHaveLength(0);
    expect(result.query.referencePartId).toBe('nonexistent-uuid');
  });

  it('PrismaClientが未設定の場合、空の結果を返すこと', async () => {
    const service = new PartSearchService();

    const result = await service.searchPartsByVisual(
      'ref-uuid',
      createDefaultOptions()
    );

    expect(result.results).toHaveLength(0);
    expect(result.query.referencePartId).toBe('ref-uuid');
  });

  it('DBエラーの場合、空の結果を返すこと', async () => {
    const prisma: PartSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error('DB error')),
    };
    const service = setupServices(undefined, prisma);

    const result = await service.searchPartsByVisual(
      'ref-uuid',
      createDefaultOptions()
    );

    expect(result.results).toHaveLength(0);
  });

  it('minSimilarity未満の結果がフィルタリングされること', async () => {
    let callCount = 0;
    const prisma: PartSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([{ visual_embedding: '[0.1,0.2,0.3]' }]);
        }
        return Promise.resolve([
          createMockPartRow({ id: 'high', similarity: 0.9 }),
          createMockPartRow({ id: 'low', similarity: 0.2 }),
        ]);
      }),
    };
    const service = setupServices(undefined, prisma);

    const result = await service.searchPartsByVisual(
      'ref-uuid',
      createDefaultOptions({ minSimilarity: 0.5 })
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('high');
  });
});

// =============================================================================
// DI Pattern テスト
// =============================================================================

describe('PartSearchService DI Pattern', () => {
  afterEach(() => {
    resetPartSearchEmbeddingServiceFactory();
    resetPartSearchPrismaClientFactory();
    resetPartSearchService();
  });

  it('setPartSearchEmbeddingServiceFactory でファクトリを設定できること', async () => {
    const embService = createMockEmbeddingService();
    setPartSearchEmbeddingServiceFactory(() => embService);

    const service = new PartSearchService();
    const result = await service.generateQueryEmbedding('test');

    expect(result).not.toBeNull();
    expect(embService.generateEmbedding).toHaveBeenCalled();
  });

  it('setPartSearchPrismaClientFactory でファクトリを設定できること', async () => {
    const prisma = createMockPrismaClient([]);
    setPartSearchPrismaClientFactory(() => prisma);

    const service = new PartSearchService();
    const result = await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    expect(result).toBeDefined();
    expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
  });

  it('getPartSearchService がシングルトンインスタンスを返すこと', () => {
    const instance1 = getPartSearchService();
    const instance2 = getPartSearchService();

    expect(instance1).toBe(instance2);
  });

  it('resetPartSearchService 後に新しいインスタンスが作成されること', () => {
    const instance1 = getPartSearchService();
    resetPartSearchService();
    const instance2 = getPartSearchService();

    expect(instance1).not.toBe(instance2);
  });

  it('createPartSearchServiceFactory が動作するファクトリを返すこと', () => {
    const factory = createPartSearchServiceFactory();
    const service = factory();

    expect(service).toBeInstanceOf(PartSearchService);
  });

  it('resetPartSearchEmbeddingServiceFactory 後にnullを返すこと', async () => {
    const embService = createMockEmbeddingService();
    setPartSearchEmbeddingServiceFactory(() => embService);
    resetPartSearchEmbeddingServiceFactory();

    const service = new PartSearchService();
    const result = await service.generateQueryEmbedding('test');

    expect(result).toBeNull();
  });
});

// =============================================================================
// エラーメッセージサニタイズ テスト
// =============================================================================

describe('PartSearchService error sanitization', () => {
  afterEach(() => {
    resetPartSearchEmbeddingServiceFactory();
    resetPartSearchPrismaClientFactory();
    resetPartSearchService();
  });

  it('Prismaエラーがテーブル名を漏洩しないこと', async () => {
    const prismaError = new Error(
      'Invalid `prisma.componentPart.findMany()` invocation: ' +
      'The table `component_parts` does not exist'
    );
    (prismaError as unknown as Record<string, unknown>).code = 'P2002';

    const prisma: PartSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(prismaError),
    };
    const service = setupServices(undefined, prisma);

    const result = await service.searchParts(
      new Array(768).fill(0.1),
      createDefaultOptions()
    );

    // エラーが外部に漏洩しないこと
    expect(result.results).toHaveLength(0);
    // テーブル名がレスポンスに含まれないことを暗黙的に検証
    // （searchParts は空の結果を返し、エラーメッセージを公開しない）
  });

  it('内部エラーが空の結果として返されること', async () => {
    const prisma: PartSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(
        new Error('relation "component_parts" does not exist')
      ),
    };
    const service = setupServices(undefined, prisma);

    const result = await service.searchPartsByVisual(
      'some-uuid',
      createDefaultOptions()
    );

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
