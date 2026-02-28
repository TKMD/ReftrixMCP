// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionSearchService Unit Tests
 *
 * カバレッジ向上のための包括的テストスイート
 * - ヘルパー関数テスト（samplePatternToText, mapCategory, mapTrigger, mapEasingType）
 * - recordToMotionPattern変換テスト
 * - buildWhereClause詳細テスト
 * - フィルタ組み合わせテスト
 * - エッジケーステスト
 *
 * @module tests/services/motion-search.service.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MotionSearchService,
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
  setPrismaClientFactory,
  resetPrismaClientFactory,
  createMotionSearchServiceFactory,
  getMotionSearchService,
  resetMotionSearchService,
  // ヘルパー関数のインポート
  samplePatternToText,
  recordToMotionPattern,
  mapCategory,
  mapTrigger,
  mapEasingType,
  buildWhereClause,
  // 型のインポート
  type IEmbeddingService,
  type IPrismaClient,
  type MotionPatternRecord,
  type VectorSearchResult,
} from '../../src/services/motion-search.service';
import type { MotionSearchParams } from '../../src/tools/motion/search.tool';
import type { SamplePattern, MotionSearchFilters } from '../../src/tools/motion/schemas';

// =============================================================================
// 共通ファクトリー・ヘルパー（重複削減）
// =============================================================================

// 検索パラメータ生成ファクトリー
const createSearchParams = (overrides: Partial<MotionSearchParams> = {}): MotionSearchParams => ({
  query: 'test',
  limit: 10,
  minSimilarity: 0.5,
  ...overrides,
});

// EmbeddingService生成ファクトリー
const createMockEmbeddingService = (
  overrides?: Partial<IEmbeddingService>
): IEmbeddingService => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  ...overrides,
});

// PrismaClient生成ファクトリー
const createMockPrismaClient = (
  overrides?: Partial<{ queryRawResult: unknown; findManyResult: unknown[]; countResult: number }>
): IPrismaClient => ({
  motionPattern: {
    findMany: vi.fn().mockResolvedValue(overrides?.findManyResult ?? []),
    count: vi.fn().mockResolvedValue(overrides?.countResult ?? 0),
  },
  $queryRawUnsafe: vi.fn().mockResolvedValue(overrides?.queryRawResult ?? []),
});

// サービス初期化ヘルパー（重複削減）
const setupServices = (
  embeddingService?: IEmbeddingService,
  prismaClient?: IPrismaClient
): MotionSearchService => {
  if (embeddingService) setEmbeddingServiceFactory(() => embeddingService);
  if (prismaClient) setPrismaClientFactory(() => prismaClient);
  return new MotionSearchService();
};

// =============================================================================
// samplePatternToText ヘルパー関数テスト
// =============================================================================

describe('samplePatternToText', () => {
  describe('単一プロパティのテスト', () => {
    it('typeのみ指定した場合、typeとanimationを含む文字列を返すこと', () => {
      const pattern: SamplePattern = { type: 'animation' };
      const result = samplePatternToText(pattern);
      expect(result).toBe('animation animation');
    });

    it('durationのみ指定した場合、duration情報を含む文字列を返すこと', () => {
      const pattern: SamplePattern = { duration: 500 };
      const result = samplePatternToText(pattern);
      expect(result).toBe('duration 500ms');
    });

    it('easingのみ指定した場合、easing情報を含む文字列を返すこと', () => {
      const pattern: SamplePattern = { easing: 'ease-in-out' };
      const result = samplePatternToText(pattern);
      expect(result).toBe('easing ease-in-out');
    });

    it('propertiesのみ指定した場合、プロパティ一覧を含む文字列を返すこと', () => {
      const pattern: SamplePattern = { properties: ['opacity', 'transform'] };
      const result = samplePatternToText(pattern);
      expect(result).toBe('properties: opacity, transform');
    });
  });

  describe('複数プロパティの組み合わせテスト', () => {
    it('全てのプロパティを指定した場合、全情報を含む文字列を返すこと', () => {
      const pattern: SamplePattern = {
        type: 'transition',
        duration: 300,
        easing: 'ease-out',
        properties: ['opacity'],
      };
      const result = samplePatternToText(pattern);
      expect(result).toBe('transition animation, duration 300ms, easing ease-out, properties: opacity');
    });

    it('type + durationの場合、両方を含む文字列を返すこと', () => {
      const pattern: SamplePattern = { type: 'hover', duration: 200 };
      const result = samplePatternToText(pattern);
      expect(result).toBe('hover animation, duration 200ms');
    });

    it('type + easing + propertiesの場合、全て含む文字列を返すこと', () => {
      const pattern: SamplePattern = {
        type: 'scroll',
        easing: 'linear',
        properties: ['transform', 'scale'],
      };
      const result = samplePatternToText(pattern);
      expect(result).toBe('scroll animation, easing linear, properties: transform, scale');
    });
  });

  describe('エッジケース', () => {
    it('空のpatternの場合、デフォルト値を返すこと', () => {
      const pattern: SamplePattern = {};
      const result = samplePatternToText(pattern);
      expect(result).toBe('motion animation');
    });

    it('空のproperties配列の場合、propertiesを含まないこと', () => {
      const pattern: SamplePattern = { type: 'keyframe', properties: [] };
      const result = samplePatternToText(pattern);
      expect(result).toBe('keyframe animation');
    });

    it('duration 0の場合、duration情報を含むこと', () => {
      const pattern: SamplePattern = { duration: 0 };
      const result = samplePatternToText(pattern);
      expect(result).toBe('duration 0ms');
    });

    it('全タイプをカバーすること', () => {
      const types = ['animation', 'transition', 'transform', 'scroll', 'hover', 'keyframe'] as const;
      for (const type of types) {
        const pattern: SamplePattern = { type };
        const result = samplePatternToText(pattern);
        expect(result).toContain(`${type} animation`);
      }
    });
  });
});

// =============================================================================
// mapCategory ヘルパー関数テスト
// =============================================================================

describe('mapCategory', () => {
  describe('有効なカテゴリマッピング', () => {
    it.each([
      ['scroll_trigger', 'scroll_trigger'],
      ['hover_effect', 'hover_effect'],
      ['page_transition', 'page_transition'],
      ['loading', 'loading_state'],
      ['loading_state', 'loading_state'],
      ['micro_interaction', 'micro_interaction'],
      ['attention_grabber', 'attention_grabber'],
      ['navigation', 'navigation'],
      ['feedback', 'feedback'],
    ])('"%s" を "%s" にマッピングすること', (input, expected) => {
      expect(mapCategory(input)).toBe(expected);
    });
  });

  describe('unknownフォールバック', () => {
    it.each([
      'invalid_category',
      'unknown_type',
      '',
      'SCROLL_TRIGGER', // 大文字小文字の違い
      'scroll-trigger', // ハイフン区切り
    ])('無効なカテゴリ "%s" の場合、"unknown" を返すこと', (invalidCategory) => {
      expect(mapCategory(invalidCategory)).toBe('unknown');
    });
  });
});

// =============================================================================
// mapTrigger ヘルパー関数テスト
// =============================================================================

describe('mapTrigger', () => {
  describe('有効なトリガーマッピング', () => {
    it.each([
      ['scroll', 'scroll'],
      ['hover', 'hover'],
      ['click', 'click'],
      ['focus', 'focus'],
      ['load', 'load'],
      ['intersection', 'intersection'],
      ['time', 'time'],
      ['state_change', 'state_change'],
    ])('"%s" を "%s" にマッピングすること', (input, expected) => {
      expect(mapTrigger(input)).toBe(expected);
    });
  });

  describe('unknownフォールバック', () => {
    it.each([
      'invalid_trigger',
      'custom',
      '',
      'SCROLL', // 大文字小文字の違い
      'on_click', // 異なる形式
    ])('無効なトリガー "%s" の場合、"unknown" を返すこと', (invalidTrigger) => {
      expect(mapTrigger(invalidTrigger)).toBe('unknown');
    });
  });
});

// =============================================================================
// mapEasingType ヘルパー関数テスト
// =============================================================================

describe('mapEasingType', () => {
  describe('標準イージング関数マッピング', () => {
    it.each([
      ['linear', 'linear'],
      ['ease', 'ease'],
      ['ease-in', 'ease-in'],
      ['ease-out', 'ease-out'],
      ['ease-in-out', 'ease-in-out'],
    ])('"%s" を "%s" にマッピングすること', (input, expected) => {
      expect(mapEasingType(input)).toBe(expected);
    });
  });

  describe('cubic-bezier検出', () => {
    it.each([
      'cubic-bezier(0.4, 0, 0.2, 1)',
      'cubic-bezier(0, 0, 1, 1)',
      'cubic-bezier(.4, 0, .2, 1)',
    ])('cubic-bezier関数 "%s" を "cubic-bezier" にマッピングすること', (input) => {
      expect(mapEasingType(input)).toBe('cubic-bezier');
    });
  });

  describe('steps検出', () => {
    it.each([
      'steps(4)',
      'steps(4, start)',
      'steps(10, end)',
      'steps(1, jump-both)',
    ])('steps関数 "%s" を "steps" にマッピングすること', (input) => {
      expect(mapEasingType(input)).toBe('steps');
    });
  });

  describe('unknownフォールバック', () => {
    it.each([
      'invalid-easing',
      'spring',
      'bounce',
      '',
      'LINEAR', // 大文字小文字の違い
    ])('未知のイージング "%s" の場合、"unknown" を返すこと', (invalidEasing) => {
      expect(mapEasingType(invalidEasing)).toBe('unknown');
    });
  });
});

// =============================================================================
// buildWhereClause ヘルパー関数テスト
// =============================================================================

describe('buildWhereClause', () => {
  describe('空のフィルタ', () => {
    it('フィルタが未定義の場合、空のWHERE句を返すこと', () => {
      const result = buildWhereClause(undefined);
      expect(result.clause).toBe('');
      expect(result.params).toEqual([]);
    });

    it('空のフィルタオブジェクトの場合、空のWHERE句を返すこと', () => {
      const result = buildWhereClause({});
      expect(result.clause).toBe('');
      expect(result.params).toEqual([]);
    });
  });

  describe('単一フィルタ条件', () => {
    describe('typeフィルタ', () => {
      it.each([
        ['animation', 'css_animation'],
        ['transition', 'page_transition'],
        ['transform', 'micro_interaction'],
        ['scroll', 'scroll_trigger'],
        ['hover', 'hover_effect'],
        ['keyframe', 'css_animation'],
      ])('type "%s" を category "%s" にマッピングしてWHERE句を生成すること', (inputType, expectedCategory) => {
        const filters: MotionSearchFilters = { type: inputType as MotionSearchFilters['type'] };
        const result = buildWhereClause(filters);
        expect(result.clause).toBe('WHERE mp.category = $1');
        expect(result.params).toEqual([expectedCategory]);
      });
    });

    describe('triggerフィルタ', () => {
      it.each([
        'load', 'hover', 'scroll', 'click', 'focus', 'custom'
      ])('trigger "%s" のWHERE句を生成すること', (trigger) => {
        const filters: MotionSearchFilters = { trigger: trigger as MotionSearchFilters['trigger'] };
        const result = buildWhereClause(filters);
        expect(result.clause).toBe('WHERE mp.trigger_type = $1');
        expect(result.params).toEqual([trigger]);
      });
    });

    describe('durationフィルタ', () => {
      it('minDurationのみ指定した場合、>=条件のWHERE句を生成すること', () => {
        const filters: MotionSearchFilters = { minDuration: 100 };
        const result = buildWhereClause(filters);
        expect(result.clause).toContain("(mp.animation->>'duration')::float >= $1");
        expect(result.params).toEqual([100]);
      });

      it('maxDurationのみ指定した場合、<=条件のWHERE句を生成すること', () => {
        const filters: MotionSearchFilters = { maxDuration: 1000 };
        const result = buildWhereClause(filters);
        expect(result.clause).toContain("(mp.animation->>'duration')::float <= $1");
        expect(result.params).toEqual([1000]);
      });

      it('minDuration=0の場合も条件を生成すること', () => {
        const filters: MotionSearchFilters = { minDuration: 0 };
        const result = buildWhereClause(filters);
        expect(result.clause).toContain("(mp.animation->>'duration')::float >= $1");
        expect(result.params).toEqual([0]);
      });
    });
  });

  describe('複合フィルタ条件', () => {
    it('type + trigger の場合、両方の条件をANDで結合すること', () => {
      const filters: MotionSearchFilters = { type: 'animation', trigger: 'hover' };
      const result = buildWhereClause(filters);
      expect(result.clause).toBe('WHERE mp.category = $1 AND mp.trigger_type = $2');
      expect(result.params).toEqual(['css_animation', 'hover']);
    });

    it('type + minDuration + maxDuration の場合、全条件をANDで結合すること', () => {
      const filters: MotionSearchFilters = { type: 'scroll', minDuration: 100, maxDuration: 500 };
      const result = buildWhereClause(filters);
      expect(result.clause).toContain('mp.category = $1');
      expect(result.clause).toContain("(mp.animation->>'duration')::float >= $2");
      expect(result.clause).toContain("(mp.animation->>'duration')::float <= $3");
      expect(result.params).toEqual(['scroll_trigger', 100, 500]);
    });

    it('全フィルタ指定の場合、4つの条件をANDで結合すること', () => {
      const filters: MotionSearchFilters = {
        type: 'hover',
        trigger: 'hover',
        minDuration: 200,
        maxDuration: 800,
      };
      const result = buildWhereClause(filters);
      expect(result.clause.match(/AND/g)?.length).toBe(3);
      expect(result.params).toEqual(['hover_effect', 'hover', 200, 800]);
    });
  });

  describe('パラメータインデックスの正確性', () => {
    it('複数パラメータの場合、正しい順序でインデックスが付与されること', () => {
      const filters: MotionSearchFilters = {
        type: 'animation',
        trigger: 'load',
        minDuration: 50,
        maxDuration: 2000,
      };
      const result = buildWhereClause(filters);
      expect(result.clause).toMatch(/\$1/);
      expect(result.clause).toMatch(/\$2/);
      expect(result.clause).toMatch(/\$3/);
      expect(result.clause).toMatch(/\$4/);
      expect(result.clause).not.toMatch(/\$5/);
    });
  });
});

// =============================================================================
// recordToMotionPattern 変換テスト
// =============================================================================

describe('recordToMotionPattern', () => {
  describe('MotionPatternRecord形式の入力', () => {
    it('基本的なレコードを正しくMotionPatternに変換すること', () => {
      const record: MotionPatternRecord = {
        id: 'test-id-1',
        name: 'Fade In Animation',
        category: 'scroll_trigger',
        triggerType: 'scroll',
        animation: { duration: 300, easing: 'ease-out' },
        properties: [{ property: 'opacity', from: 0, to: 1 }],
        sourceUrl: 'https://example.com',
        webPageId: null,
      };

      const result = recordToMotionPattern(record);

      expect(result.id).toBe('test-id-1');
      expect(result.name).toBe('Fade In Animation');
      expect(result.category).toBe('scroll_trigger');
      expect(result.trigger).toBe('scroll');
      expect(result.animation.duration).toBe(300);
      expect(result.animation.easing?.type).toBe('ease-out');
      expect(result.properties).toHaveLength(1);
      // v0.1.0: selectorはnameから生成される（kebab-case）
      expect(result.selector).toBe('.fade-in-animation');
    });

    it('embeddingプロパティがあっても正しく変換すること', () => {
      const record: MotionPatternRecord = {
        id: 'test-id-2',
        name: 'Slide Up',
        category: 'micro_interaction',
        triggerType: 'click',
        animation: { duration: 200 },
        properties: [],
        sourceUrl: null,
        webPageId: 'page-1',
        embedding: {
          embedding: [0.1, 0.2, 0.3],
          textRepresentation: 'slide up animation',
        },
      };

      const result = recordToMotionPattern(record);

      expect(result.id).toBe('test-id-2');
      expect(result.category).toBe('micro_interaction');
      expect(result.trigger).toBe('click');
      // v0.1.0: sourceUrlがnullでもnameから生成される
      expect(result.selector).toBe('.slide-up');
    });
  });

  describe('VectorSearchResult形式の入力', () => {
    it('ベクトル検索結果を正しくMotionPatternに変換すること', () => {
      const record: VectorSearchResult = {
        id: 'vector-id-1',
        name: 'Hover Effect',
        category: 'hover_effect',
        trigger_type: 'hover',
        animation: { duration: 150, delay: 50, easing: 'ease-in' },
        properties: [{ property: 'transform' }],
        source_url: 'https://test.com/page',
        web_page_id: 'web-page-1',
        similarity: 0.95,
      };

      const result = recordToMotionPattern(record);

      expect(result.id).toBe('vector-id-1');
      expect(result.name).toBe('Hover Effect');
      expect(result.category).toBe('hover_effect');
      expect(result.trigger).toBe('hover');
      expect(result.animation.duration).toBe(150);
      expect(result.animation.delay).toBe(50);
      expect(result.animation.easing?.type).toBe('ease-in');
      // v0.1.0: selectorはnameから生成される（kebab-case）
      expect(result.selector).toBe('.hover-effect');
    });
  });

  describe('animation/propertiesの型変換', () => {
    it('animationがnullの場合、空オブジェクトとして扱うこと', () => {
      const record: MotionPatternRecord = {
        id: 'test-1',
        name: 'Test',
        category: 'unknown',
        triggerType: 'unknown',
        animation: null as unknown,
        properties: [],
        sourceUrl: null,
        webPageId: null,
      };

      const result = recordToMotionPattern(record);

      expect(result.animation.duration).toBeUndefined();
      expect(result.animation.delay).toBeUndefined();
    });

    it('propertiesが配列でない場合、空配列として扱うこと', () => {
      const record: MotionPatternRecord = {
        id: 'test-2',
        name: 'Test',
        category: 'unknown',
        triggerType: 'unknown',
        animation: {},
        properties: 'not-an-array' as unknown,
        sourceUrl: null,
        webPageId: null,
      };

      const result = recordToMotionPattern(record);

      expect(result.properties).toEqual([]);
    });

    it('propertiesの要素がオブジェクトでない場合、文字列として処理すること', () => {
      const record: MotionPatternRecord = {
        id: 'test-3',
        name: 'Test',
        category: 'unknown',
        triggerType: 'unknown',
        animation: {},
        properties: ['opacity', 'transform'],
        sourceUrl: null,
        webPageId: null,
      };

      const result = recordToMotionPattern(record);

      expect(result.properties).toHaveLength(2);
      expect(result.properties[0]).toEqual({ property: 'opacity' });
      expect(result.properties[1]).toEqual({ property: 'transform' });
    });

    it('animation.iterationsを正しく変換すること', () => {
      const record: MotionPatternRecord = {
        id: 'test-4',
        name: 'Test',
        category: 'unknown',
        triggerType: 'unknown',
        animation: { iterations: 'infinite' },
        properties: [],
        sourceUrl: null,
        webPageId: null,
      };

      const result = recordToMotionPattern(record);

      expect(result.animation.iterations).toBe('infinite');
    });

    it('animation.directionを正しく変換すること', () => {
      const record: MotionPatternRecord = {
        id: 'test-5',
        name: 'Test',
        category: 'unknown',
        triggerType: 'unknown',
        animation: { direction: 'alternate' },
        properties: [],
        sourceUrl: null,
        webPageId: null,
      };

      const result = recordToMotionPattern(record);

      expect(result.animation.direction).toBe('alternate');
    });

    it('animation.fill_modeをfillModeに変換すること', () => {
      const record: MotionPatternRecord = {
        id: 'test-6',
        name: 'Test',
        category: 'unknown',
        triggerType: 'unknown',
        animation: { fill_mode: 'forwards' },
        properties: [],
        sourceUrl: null,
        webPageId: null,
      };

      const result = recordToMotionPattern(record);

      expect(result.animation.fillMode).toBe('forwards');
    });
  });

  describe('null/undefinedハンドリング', () => {
    it('sourceUrlがnullの場合、selectorはundefinedになること', () => {
      const record: MotionPatternRecord = {
        id: 'test-null',
        name: 'Test',
        category: 'unknown',
        triggerType: 'unknown',
        animation: {},
        properties: [],
        sourceUrl: null,
        webPageId: null,
      };

      const result = recordToMotionPattern(record);

      // v0.1.0: sourceUrlがnullでもnameから生成される
      expect(result.selector).toBe('.test');
    });

    it('durationが数値でない場合、undefinedになること', () => {
      const record: MotionPatternRecord = {
        id: 'test-invalid-duration',
        name: 'Test',
        category: 'unknown',
        triggerType: 'unknown',
        animation: { duration: 'invalid' },
        properties: [],
        sourceUrl: null,
        webPageId: null,
      };

      const result = recordToMotionPattern(record);

      expect(result.animation.duration).toBeUndefined();
    });

    it('easingがundefinedの場合、easing設定もundefinedになること', () => {
      const record: MotionPatternRecord = {
        id: 'test-no-easing',
        name: 'Test',
        category: 'unknown',
        triggerType: 'unknown',
        animation: { duration: 300 },
        properties: [],
        sourceUrl: null,
        webPageId: null,
      };

      const result = recordToMotionPattern(record);

      expect(result.animation.easing).toBeUndefined();
    });
  });
});

// =============================================================================
// MotionSearchService クラステスト
// =============================================================================

describe('MotionSearchService', () => {
  let mockEmbeddingService: IEmbeddingService;
  let mockPrismaClient: IPrismaClient;

  beforeEach(() => {
    mockEmbeddingService = createMockEmbeddingService();
    mockPrismaClient = createMockPrismaClient();
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetMotionSearchService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetMotionSearchService();
    vi.clearAllMocks();
  });

  describe('createMotionSearchServiceFactory', () => {
    it('ファクトリ関数がIMotionSearchServiceを返すこと', () => {
      const factory = createMotionSearchServiceFactory();
      const service = factory();
      expect(service).toBeDefined();
      expect(typeof service.search).toBe('function');
    });
  });

  describe('getMotionSearchService', () => {
    it('シングルトンインスタンスを返すこと', () => {
      const service1 = getMotionSearchService();
      const service2 = getMotionSearchService();
      expect(service1).toBe(service2);
    });

    it('リセット後は新しいインスタンスを返すこと', () => {
      const service1 = getMotionSearchService();
      resetMotionSearchService();
      const service2 = getMotionSearchService();
      expect(service1).not.toBe(service2);
    });
  });

  describe('search', () => {
    // パラメータ化テスト: サービス未設定ケース
    it.each([
      { desc: '両方未設定', embedService: false, prisma: false, query: 'fade in animation', checkQuery: true },
      { desc: 'EmbeddingServiceのみ', embedService: true, prisma: false, query: 'hover effect', checkQuery: false },
    ])('$desc の場合、空の結果を返すこと', async ({ embedService, prisma, query, checkQuery }) => {
      const service = setupServices(
        embedService ? mockEmbeddingService : undefined,
        prisma ? mockPrismaClient : undefined
      );

      const result = await service.search(createSearchParams({ query }));

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
      if (checkQuery) expect(result.query?.text).toBe(query);
    });

    it('両方のサービスが設定されている場合、検索を実行すること', async () => {
      const mockResults: VectorSearchResult[] = [{
        id: 'test-id-1', name: 'Fade In', category: 'scroll_trigger', trigger_type: 'scroll',
        animation: { duration: 300, easing: 'ease-out' }, properties: [{ property: 'opacity', from: 0, to: 1 }],
        source_url: null, web_page_id: null, similarity: 0.85,
      }];
      (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

      const service = setupServices(mockEmbeddingService, mockPrismaClient);
      const result = await service.search(createSearchParams({ query: 'fade in' }));

      expect(result.results.length).toBe(1);
      expect(result.results[0]?.pattern.name).toBe('Fade In');
      expect(result.results[0]?.similarity).toBe(0.85);
      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledWith('fade in', 'query');
    });

    it('samplePatternを使用した検索が動作すること', async () => {
      const service = setupServices(mockEmbeddingService, mockPrismaClient);
      await service.search(createSearchParams({
        query: undefined,
        samplePattern: { type: 'animation', duration: 500, easing: 'ease-in-out', properties: ['opacity', 'transform'] },
      }));

      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledWith(expect.stringContaining('animation'), 'query');
    });

    it('フィルターが適用されること', async () => {
      const service = setupServices(mockEmbeddingService, mockPrismaClient);
      await service.search(createSearchParams({
        filters: { type: 'hover', minDuration: 100, maxDuration: 1000, trigger: 'hover' },
      }));

      expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalled();
      const query = ((mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string) || '';
      expect(query).toContain('category');
      expect(query).toContain('trigger_type');
    });

    // パラメータ化テスト: エラーケース
    it.each([
      {
        desc: 'Embedding生成に失敗した場合',
        embedFactory: () => createMockEmbeddingService({
          generateEmbedding: vi.fn().mockRejectedValue(new Error('Embedding failed')),
        }),
        prismaFactory: () => mockPrismaClient,
      },
      {
        desc: 'データベースエラーの場合',
        embedFactory: () => mockEmbeddingService,
        prismaFactory: () => createMockPrismaClient() as IPrismaClient & {
          $queryRawUnsafe: ReturnType<typeof vi.fn>;
        },
        setupExtra: (prisma: IPrismaClient) => {
          (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
        },
      },
    ])('$desc 、空の結果を返すこと', async ({ embedFactory, prismaFactory, setupExtra }) => {
      const embedService = embedFactory();
      const prisma = prismaFactory();
      setupExtra?.(prisma);

      const service = setupServices(embedService, prisma);
      const result = await service.search(createSearchParams());

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
    });

    describe('エッジケース', () => {
      it('queryもsamplePatternも未指定の場合、エラーをスローすること', async () => {
        const service = setupServices(mockEmbeddingService, mockPrismaClient);

        await expect(
          service.search({ limit: 10, minSimilarity: 0.5 } as MotionSearchParams)
        ).rejects.toThrow('query or samplePattern is required');
      });

      it('極端なminSimilarity値 0 が正しく処理されること', async () => {
        const service = setupServices(mockEmbeddingService, mockPrismaClient);
        const result = await service.search(createSearchParams({ minSimilarity: 0 }));

        expect(result).toBeDefined();
        expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalled();
      });

      it('極端なminSimilarity値 1 が正しく処理されること', async () => {
        const service = setupServices(mockEmbeddingService, mockPrismaClient);
        const result = await service.search(createSearchParams({ minSimilarity: 1 }));

        expect(result).toBeDefined();
      });

      it('極端なlimit値 1 が正しく処理されること', async () => {
        const service = setupServices(mockEmbeddingService, mockPrismaClient);
        const result = await service.search(createSearchParams({ limit: 1 }));

        expect(result).toBeDefined();
      });

      it('極端なlimit値 50 が正しく処理されること', async () => {
        const service = setupServices(mockEmbeddingService, mockPrismaClient);
        const result = await service.search(createSearchParams({ limit: 50 }));

        expect(result).toBeDefined();
      });

      it('web_page_idがある場合、sourceにpageIdを含めること', async () => {
        const mockResults: VectorSearchResult[] = [{
          id: 'test-id',
          name: 'Test Animation',
          category: 'scroll_trigger',
          trigger_type: 'scroll',
          animation: { duration: 300 },
          properties: [],
          source_url: 'https://example.com/page',
          web_page_id: 'page-uuid-123',
          similarity: 0.9,
        }];
        (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

        const service = setupServices(mockEmbeddingService, mockPrismaClient);
        const result = await service.search(createSearchParams());

        expect(result.results[0]?.source?.pageId).toBe('page-uuid-123');
        expect(result.results[0]?.source?.url).toBe('https://example.com/page');
      });

      it('web_page_idがnullの場合、sourceはundefinedになること', async () => {
        const mockResults: VectorSearchResult[] = [{
          id: 'test-id',
          name: 'Test Animation',
          category: 'scroll_trigger',
          trigger_type: 'scroll',
          animation: { duration: 300 },
          properties: [],
          source_url: null,
          web_page_id: null,
          similarity: 0.9,
        }];
        (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

        const service = setupServices(mockEmbeddingService, mockPrismaClient);
        const result = await service.search(createSearchParams());

        expect(result.results[0]?.source).toBeUndefined();
      });
    });
  });

  describe('フィルタ組み合わせテスト', () => {
    describe('type単独フィルタ', () => {
      it.each([
        'animation', 'transition', 'transform', 'scroll', 'hover', 'keyframe'
      ])('type=%s で検索が実行されること', async (type) => {
        const service = setupServices(mockEmbeddingService, mockPrismaClient);
        const result = await service.search(createSearchParams({
          filters: { type: type as MotionSearchFilters['type'] },
        }));

        expect(result).toBeDefined();
        expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalled();
      });
    });

    describe('trigger単独フィルタ', () => {
      it.each([
        'load', 'hover', 'scroll', 'click', 'focus', 'custom'
      ])('trigger=%s で検索が実行されること', async (trigger) => {
        const service = setupServices(mockEmbeddingService, mockPrismaClient);
        const result = await service.search(createSearchParams({
          filters: { trigger: trigger as MotionSearchFilters['trigger'] },
        }));

        expect(result).toBeDefined();
        expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalled();
      });
    });

    describe('duration境界値テスト', () => {
      it.each([
        { minDuration: 0, maxDuration: 100, desc: '最小範囲' },
        { minDuration: 1000, maxDuration: 60000, desc: '最大範囲' },
        { minDuration: 500, maxDuration: 500, desc: '同一値' },
      ])('$desc (minDuration=$minDuration, maxDuration=$maxDuration) で検索が実行されること', async ({ minDuration, maxDuration }) => {
        const service = setupServices(mockEmbeddingService, mockPrismaClient);
        const result = await service.search(createSearchParams({
          filters: { minDuration, maxDuration },
        }));

        expect(result).toBeDefined();
        expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalled();
      });
    });

    describe('複合フィルタ', () => {
      it('type + trigger + duration範囲 で検索が実行されること', async () => {
        const service = setupServices(mockEmbeddingService, mockPrismaClient);
        const result = await service.search(createSearchParams({
          filters: {
            type: 'animation',
            trigger: 'load',
            minDuration: 200,
            maxDuration: 800,
          },
        }));

        expect(result).toBeDefined();
        const query = ((mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string) || '';
        expect(query).toContain('category');
        expect(query).toContain('trigger_type');
        expect(query).toContain('duration');
      });
    });
  });

  describe('getEmbedding', () => {
    it('EmbeddingServiceが設定されている場合、Embeddingを返すこと', async () => {
      const service = setupServices(mockEmbeddingService);
      const embedding = await service.getEmbedding?.('test query');

      expect(embedding).toBeDefined();
      expect(embedding?.length).toBe(768);
      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledWith('test query', 'query');
    });

    it('EmbeddingServiceが未設定の場合、エラーをスローすること', async () => {
      const service = new MotionSearchService();
      await expect(service.getEmbedding?.('test')).rejects.toThrow('EmbeddingService not initialized');
    });
  });
});

// =============================================================================
// DI ファクトリ関数テスト
// =============================================================================

describe('DI Factory Functions', () => {
  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetMotionSearchService();
  });

  describe('setEmbeddingServiceFactory / resetEmbeddingServiceFactory', () => {
    it('ファクトリを設定後、サービスで使用できること', async () => {
      const mockService = createMockEmbeddingService();
      setEmbeddingServiceFactory(() => mockService);

      const service = new MotionSearchService();
      const embedding = await service.getEmbedding?.('test');

      expect(embedding).toBeDefined();
    });

    it('リセット後は使用できないこと', async () => {
      const mockService = createMockEmbeddingService();
      setEmbeddingServiceFactory(() => mockService);
      resetEmbeddingServiceFactory();

      const service = new MotionSearchService();
      await expect(service.getEmbedding?.('test')).rejects.toThrow();
    });
  });

  describe('setPrismaClientFactory / resetPrismaClientFactory', () => {
    it('ファクトリを設定後、サービスで使用できること', async () => {
      const mockEmbedding = createMockEmbeddingService();
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbedding);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();
      const result = await service.search(createSearchParams());

      expect(result).toBeDefined();
    });

    it('リセット後は空の結果を返すこと', async () => {
      const mockEmbedding = createMockEmbeddingService();
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbedding);
      setPrismaClientFactory(() => mockPrisma);
      resetPrismaClientFactory();

      const service = new MotionSearchService();
      const result = await service.search(createSearchParams());

      expect(result.results).toEqual([]);
    });
  });

  describe('キャッシング動作', () => {
    it('同一サービスインスタンスでは同じEmbeddingServiceを再利用すること', async () => {
      const mockService = createMockEmbeddingService();
      const factoryFn = vi.fn().mockReturnValue(mockService);
      setEmbeddingServiceFactory(factoryFn);

      const service = new MotionSearchService();
      await service.getEmbedding?.('test1');
      await service.getEmbedding?.('test2');

      // ファクトリは1回だけ呼ばれる（キャッシングが機能している）
      expect(factoryFn).toHaveBeenCalledTimes(1);
    });

    it('同一サービスインスタンスでは同じPrismaClientを再利用すること', async () => {
      const mockEmbedding = createMockEmbeddingService();
      const mockPrisma = createMockPrismaClient();
      const prismaFactoryFn = vi.fn().mockReturnValue(mockPrisma);

      setEmbeddingServiceFactory(() => mockEmbedding);
      setPrismaClientFactory(prismaFactoryFn);

      const service = new MotionSearchService();
      await service.search(createSearchParams());
      await service.search(createSearchParams());

      // ファクトリは1回だけ呼ばれる
      expect(prismaFactoryFn).toHaveBeenCalledTimes(1);
    });
  });
});

// =============================================================================
// クエリEmbedding検証テスト（Phase6-SEC-2）
// セキュリティレビューで指摘された問題への対応テスト
// =============================================================================

describe('MotionSearchService - クエリEmbedding検証（セキュリティ対応）', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetMotionSearchService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    resetMotionSearchService();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------
  // NaN値の検出
  // -----------------------------------------------------
  describe('NaN値の検出', () => {
    it('クエリEmbeddingにNaN値が含まれる場合、エラーをスローすること', async () => {
      // Arrange: NaNを含むEmbeddingを返すモックサービス
      const vectorWithNaN = new Array(768).fill(0.1);
      vectorWithNaN[0] = NaN;

      const mockEmbeddingWithNaN = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: 検索がエラーをスローすること
      await expect(service.search(createSearchParams())).rejects.toThrow();
    });

    it('クエリEmbeddingにNaN値がある場合、SQLクエリは実行されないこと', async () => {
      // Arrange: NaNを含むEmbeddingを返すモックサービス
      const vectorWithNaN = new Array(768).fill(0.1);
      vectorWithNaN[383] = NaN; // 中間位置

      const mockEmbeddingWithNaN = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act: 検索を実行（エラーを無視）
      try {
        await service.search(createSearchParams());
      } catch {
        // エラーは期待どおり
      }

      // Assert: SQLクエリは実行されないこと
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('末尾位置にNaNがある場合も検出すること', async () => {
      // Arrange: 末尾にNaNを含むEmbedding
      const vectorWithNaN = new Array(768).fill(0.1);
      vectorWithNaN[767] = NaN;

      const mockEmbeddingWithNaN = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーがスローされること
      await expect(service.search(createSearchParams())).rejects.toThrow();
    });
  });

  // -----------------------------------------------------
  // Infinity値の検出
  // -----------------------------------------------------
  describe('Infinity値の検出', () => {
    it('クエリEmbeddingに正のInfinity値が含まれる場合、エラーをスローすること', async () => {
      // Arrange: Infinityを含むEmbeddingを返すモックサービス
      const vectorWithInfinity = new Array(768).fill(0.1);
      vectorWithInfinity[0] = Infinity;

      const mockEmbeddingWithInfinity = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithInfinity),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithInfinity);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーがスローされること
      await expect(service.search(createSearchParams())).rejects.toThrow();
    });

    it('クエリEmbeddingに負のInfinity値が含まれる場合、エラーをスローすること', async () => {
      // Arrange: -Infinityを含むEmbeddingを返すモックサービス
      const vectorWithNegativeInfinity = new Array(768).fill(0.1);
      vectorWithNegativeInfinity[100] = -Infinity;

      const mockEmbeddingWithNegativeInfinity = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithNegativeInfinity),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithNegativeInfinity);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーがスローされること
      await expect(service.search(createSearchParams())).rejects.toThrow();
    });

    it('Infinity値が検出された場合、SQLクエリは実行されないこと', async () => {
      // Arrange: Infinityを含むEmbedding
      const vectorWithInfinity = new Array(768).fill(0.1);
      vectorWithInfinity[500] = Infinity;

      const mockEmbeddingWithInfinity = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithInfinity),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithInfinity);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act: 検索を実行（エラーを無視）
      try {
        await service.search(createSearchParams());
      } catch {
        // エラーは期待どおり
      }

      // Assert: SQLクエリは実行されないこと
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------
  // 次元数の検証
  // -----------------------------------------------------
  describe('次元数の検証', () => {
    it('768次元未満のEmbeddingを拒否すること', async () => {
      // Arrange: 767次元のベクトルを返すモックサービス
      const shortVector = new Array(767).fill(0.1);

      const mockEmbeddingWithShortVector = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(shortVector),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithShortVector);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーがスローされること
      await expect(service.search(createSearchParams())).rejects.toThrow();
    });

    it('768次元を超えるEmbeddingを拒否すること', async () => {
      // Arrange: 769次元のベクトルを返すモックサービス
      const longVector = new Array(769).fill(0.1);

      const mockEmbeddingWithLongVector = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(longVector),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithLongVector);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーがスローされること
      await expect(service.search(createSearchParams())).rejects.toThrow();
    });
  });

  // -----------------------------------------------------
  // 型の検証
  // -----------------------------------------------------
  describe('型の検証', () => {
    it('文字列要素を含むEmbeddingを拒否すること', async () => {
      // Arrange: 文字列を含むベクトルを返すモックサービス
      const vectorWithString = new Array(768).fill(0.1);
      (vectorWithString as unknown[])[0] = '0.1';

      const mockEmbeddingWithString = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithString),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithString);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーがスローされること
      await expect(service.search(createSearchParams())).rejects.toThrow();
    });

    it('null要素を含むEmbeddingを拒否すること', async () => {
      // Arrange: nullを含むベクトルを返すモックサービス
      const vectorWithNull = new Array(768).fill(0.1);
      (vectorWithNull as unknown[])[50] = null;

      const mockEmbeddingWithNull = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithNull),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithNull);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーがスローされること
      await expect(service.search(createSearchParams())).rejects.toThrow();
    });

    it('undefined要素を含むEmbeddingを拒否すること', async () => {
      // Arrange: undefinedを含むベクトルを返すモックサービス
      const vectorWithUndefined = new Array(768).fill(0.1);
      (vectorWithUndefined as unknown[])[100] = undefined;

      const mockEmbeddingWithUndefined = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithUndefined),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithUndefined);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーがスローされること
      await expect(service.search(createSearchParams())).rejects.toThrow();
    });
  });

  // -----------------------------------------------------
  // getEmbedding メソッドの検証
  // -----------------------------------------------------
  describe('getEmbedding メソッドの検証', () => {
    it('getEmbeddingがNaN値を含むベクトルを返した場合、エラーをスローすること', async () => {
      // Arrange: NaNを含むEmbeddingを返すモックサービス
      const vectorWithNaN = new Array(768).fill(0.1);
      vectorWithNaN[0] = NaN;

      const mockEmbeddingWithNaN = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
      });

      setEmbeddingServiceFactory(() => mockEmbeddingWithNaN);

      const service = new MotionSearchService();

      // Act & Assert: エラーがスローされること
      await expect(service.getEmbedding?.('test query')).rejects.toThrow();
    });

    it('getEmbeddingがInfinity値を含むベクトルを返した場合、エラーをスローすること', async () => {
      // Arrange: Infinityを含むEmbeddingを返すモックサービス
      const vectorWithInfinity = new Array(768).fill(0.1);
      vectorWithInfinity[0] = Infinity;

      const mockEmbeddingWithInfinity = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithInfinity),
      });

      setEmbeddingServiceFactory(() => mockEmbeddingWithInfinity);

      const service = new MotionSearchService();

      // Act & Assert: エラーがスローされること
      await expect(service.getEmbedding?.('test query')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------
  // エラーメッセージの品質
  // -----------------------------------------------------
  describe('エラーメッセージの品質', () => {
    it('NaN検出時に位置情報を含むエラーメッセージを生成すること', async () => {
      // Arrange: インデックス42にNaNを含むベクトル
      const vectorWithNaN = new Array(768).fill(0.1);
      vectorWithNaN[42] = NaN;

      const mockEmbeddingWithNaN = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーメッセージにインデックス情報が含まれること
      await expect(service.search(createSearchParams())).rejects.toThrow(/42|NaN/);
    });

    it('Infinity検出時に位置情報を含むエラーメッセージを生成すること', async () => {
      // Arrange: インデックス100にInfinityを含むベクトル
      const vectorWithInfinity = new Array(768).fill(0.1);
      vectorWithInfinity[100] = Infinity;

      const mockEmbeddingWithInfinity = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithInfinity),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithInfinity);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーメッセージにインデックス情報が含まれること
      await expect(service.search(createSearchParams())).rejects.toThrow(/100|Infinity/);
    });

    it('次元数エラー時に期待される次元数を含むエラーメッセージを生成すること', async () => {
      // Arrange: 384次元のベクトル（半分の次元数）
      const halfDimensionVector = new Array(384).fill(0.1);

      const mockEmbeddingWithHalfDimension = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(halfDimensionVector),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithHalfDimension);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: エラーメッセージに期待される次元数が含まれること
      await expect(service.search(createSearchParams())).rejects.toThrow(/768|dimension/i);
    });
  });

  // -----------------------------------------------------
  // samplePattern を使用した検索の検証
  // -----------------------------------------------------
  describe('samplePattern を使用した検索の検証', () => {
    it('samplePatternによる検索でNaN値が検出された場合、エラーをスローすること', async () => {
      // Arrange: NaNを含むEmbeddingを返すモックサービス
      const vectorWithNaN = new Array(768).fill(0.1);
      vectorWithNaN[0] = NaN;

      const mockEmbeddingWithNaN = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
      });
      const mockPrisma = createMockPrismaClient();

      setEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
      setPrismaClientFactory(() => mockPrisma);

      const service = new MotionSearchService();

      // Act & Assert: samplePatternを使用した検索でもエラーがスローされること
      await expect(
        service.search(createSearchParams({
          query: undefined,
          samplePattern: { type: 'animation', duration: 500 },
        }))
      ).rejects.toThrow();
    });
  });
});
