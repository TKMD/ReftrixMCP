// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BackgroundSearchService ユニットテスト
 *
 * createBackgroundSearchService() のすべてのメソッドを検証:
 * - generateQueryEmbedding: Embedding生成（正常系 / エラー時null返却）
 * - searchBackgroundDesigns: ベクトル検索（フィルタ / ページネーション / COUNTクエリ発行条件）
 * - searchBackgroundDesignsHybrid: ハイブリッド検索（正常 / fulltext失敗 / 全体失敗フォールバック）
 *
 * DI Factory:
 * - createBackgroundSearchServiceFromFactories: factory設定済み→サービス返却 / 未設定→null
 *
 * ヘルパー:
 * - mapRowToResult: snake_case → camelCase マッピング
 * - buildWhereClause: フィルタ条件の組み立て
 *
 * SEC M-4: BackgroundSearchService ユニットテスト追加
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createBackgroundSearchService,
  createBackgroundSearchServiceFromFactories,
  setBackgroundSearchPrismaClientFactory,
  setBackgroundSearchEmbeddingServiceFactory,
  type IBackgroundSearchPrismaClient,
  type IBackgroundSearchEmbeddingService,
  type BackgroundSearchServiceConfig,
} from '../../../src/services/background-search.service';

// =====================================================
// production-guard モック（isDevelopmentEnvironment → false）
// =====================================================
vi.mock('../../../src/services/production-guard', () => ({
  isDevelopmentEnvironment: (): boolean => false,
}));

// =====================================================
// logger モック（テスト時のログ出力抑制）
// =====================================================
vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// =====================================================
// テスト用ヘルパー
// =====================================================

/** 768次元の固定ベクトルを生成 */
function createMockEmbedding(fill = 0.01): number[] {
  return new Array(768).fill(fill);
}

/** テスト用のBackgroundSearchRow（DBから返されるsnake_case形式） */
function createMockRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'bg-001',
    web_page_id: 'wp-001',
    name: 'Gradient Hero Background',
    design_type: 'linear_gradient',
    css_value: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    selector: '.hero-bg',
    color_info: { primary: '#667eea', secondary: '#764ba2' },
    text_representation: 'purple blue gradient background',
    similarity: 0.93,
    ...overrides,
  };
}

/** モックPrismaClient作成 */
function createMockPrisma(): IBackgroundSearchPrismaClient {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
}

/** モックEmbeddingService作成 */
function createMockEmbeddingService(): IBackgroundSearchEmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding()),
  };
}

/** サービスとモックをセットで生成するヘルパー */
function createTestService(overrides?: Partial<BackgroundSearchServiceConfig>): {
  service: ReturnType<typeof createBackgroundSearchService>;
  prisma: IBackgroundSearchPrismaClient;
  embeddingService: IBackgroundSearchEmbeddingService;
} {
  const prisma = overrides?.prisma ?? createMockPrisma();
  const embeddingService = overrides?.embeddingService ?? createMockEmbeddingService();
  const service = createBackgroundSearchService({ prisma, embeddingService });
  return { service, prisma, embeddingService };
}

// =====================================================
// テスト
// =====================================================

describe('BackgroundSearchService', () => {
  // -------------------------------------------------
  // generateQueryEmbedding
  // -------------------------------------------------
  describe('generateQueryEmbedding', () => {
    it('正常系: embeddingServiceが呼ばれ結果のベクトルを返すこと', async () => {
      // Arrange
      const expectedVector = createMockEmbedding(0.05);
      const embeddingService = createMockEmbeddingService();
      (embeddingService.generateEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue(expectedVector);
      const { service } = createTestService({ embeddingService });

      // Act
      const result = await service.generateQueryEmbedding('gradient background');

      // Assert
      expect(embeddingService.generateEmbedding).toHaveBeenCalledOnce();
      expect(embeddingService.generateEmbedding).toHaveBeenCalledWith('gradient background', 'query');
      expect(result).toBe(expectedVector);
      expect(result).toHaveLength(768);
    });

    it('エラー時: nullを返し例外をスローしないこと', async () => {
      // Arrange
      const embeddingService = createMockEmbeddingService();
      (embeddingService.generateEmbedding as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('ONNX session failed')
      );
      const { service } = createTestService({ embeddingService });

      // Act
      const result = await service.generateQueryEmbedding('test query');

      // Assert: nullを返し、例外はスローされない
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------
  // searchBackgroundDesigns (vector-only)
  // -------------------------------------------------
  describe('searchBackgroundDesigns', () => {
    it('正常検索: 正しいSQLとパラメータで$queryRawUnsafeが呼ばれること', async () => {
      // Arrange
      const mockRows = [createMockRow(), createMockRow({ id: 'bg-002', similarity: 0.85 })];
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows);
      const { service } = createTestService({ prisma });

      const embedding = createMockEmbedding();

      // Act
      const result = await service.searchBackgroundDesigns(embedding, {
        limit: 10,
        offset: 0,
      });

      // Assert: SQLが呼ばれた
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledOnce();

      const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      const sql = callArgs[0] as string;

      // SQL構造の検証
      expect(sql).toContain('background_designs');
      expect(sql).toContain('background_design_embeddings');
      expect(sql).toContain('bde.embedding <=> $1::vector');
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');

      // パラメータの検証: [vectorString, limit, offset]
      const vectorString = callArgs[1];
      expect(vectorString).toBe(`[${embedding.join(',')}]`);

      // 結果の検証
      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe('bg-001');
      // offset=0でrows.length < limit なのでCOUNTクエリは発行されない
      expect(result.total).toBe(2);
    });

    it('designTypeフィルタ: WHERE条件にdesign_typeが含まれること', async () => {
      // Arrange
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([createMockRow()]);
      const { service } = createTestService({ prisma });

      // Act
      await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 0,
        filters: { designType: 'linear_gradient' },
      });

      // Assert
      const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      const sql = callArgs[0] as string;
      expect(sql).toContain('bd.design_type::text = $2');
      // designType パラメータが含まれる
      expect(callArgs).toContain('linear_gradient');
    });

    it('webPageIdフィルタ: WHERE条件にweb_page_idが含まれること', async () => {
      // Arrange
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([createMockRow()]);
      const { service } = createTestService({ prisma });

      // Act
      await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 0,
        filters: { webPageId: '019c0000-0000-7000-8000-000000000001' },
      });

      // Assert
      const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      const sql = callArgs[0] as string;
      expect(sql).toContain('bd.web_page_id = $2');
      expect(callArgs).toContain('019c0000-0000-7000-8000-000000000001');
    });

    it('両フィルタ同時: designTypeとwebPageId両方のWHERE条件が含まれること', async () => {
      // Arrange
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([createMockRow()]);
      const { service } = createTestService({ prisma });

      // Act
      await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 0,
        filters: {
          designType: 'glassmorphism',
          webPageId: '019c0000-0000-7000-8000-000000000002',
        },
      });

      // Assert
      const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      const sql = callArgs[0] as string;
      // designType は $2、webPageId は $3
      expect(sql).toContain('bd.design_type::text = $2');
      expect(sql).toContain('bd.web_page_id = $3');
      expect(callArgs).toContain('glassmorphism');
      expect(callArgs).toContain('019c0000-0000-7000-8000-000000000002');
    });

    it('ページネーション: limit/offsetパラメータが正しく渡されること', async () => {
      // Arrange
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const { service } = createTestService({ prisma });

      // Act
      await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 5,
        offset: 20,
      });

      // Assert: フィルタなしの場合 limit=$2, offset=$3
      const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      const sql = callArgs[0] as string;
      expect(sql).toContain('LIMIT $2');
      expect(sql).toContain('OFFSET $3');
      // パラメータ: [vectorString, limit, offset]
      expect(callArgs[2]).toBe(5);
      expect(callArgs[3]).toBe(20);
    });

    it('COUNTクエリ: offset=0かつrows.length >= limitのとき発行されること', async () => {
      // Arrange
      const limit = 2;
      const mockRows = [
        createMockRow({ id: 'bg-001' }),
        createMockRow({ id: 'bg-002' }),
      ];
      const prisma = createMockPrisma();
      // 1回目: メイン検索 → limit件ちょうど返す（COUNTトリガー）
      // 2回目: COUNTクエリ → total返却
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockRows)
        .mockResolvedValueOnce([{ total: BigInt(42) }]);

      const { service } = createTestService({ prisma });

      // Act
      const result = await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit,
        offset: 0,
      });

      // Assert: $queryRawUnsafe が2回呼ばれる（メイン + COUNT）
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);

      const countSql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
      expect(countSql).toContain('COUNT(*)');
      expect(countSql).toContain('background_designs');

      // total が COUNT 結果から取得されている
      expect(result.total).toBe(42);
      expect(result.results).toHaveLength(2);
    });

    it('COUNTクエリ: offset > 0のときは発行されないこと', async () => {
      // Arrange
      const prisma = createMockPrisma();
      const mockRows = [createMockRow(), createMockRow({ id: 'bg-002' })];
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows);
      const { service } = createTestService({ prisma });

      // Act
      const result = await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 2,
        offset: 5, // offset > 0
      });

      // Assert: メインクエリのみ（COUNT は発行されない）
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledOnce();
      expect(result.total).toBe(2); // rows.length がそのまま total
    });

    it('COUNTクエリ: rows.length < limitのときは発行されないこと', async () => {
      // Arrange
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([createMockRow()]);
      const { service } = createTestService({ prisma });

      // Act
      const result = await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10, // 10件要求
        offset: 0,
      });

      // Assert: 1件しか返ってこない（< limit）のでCOUNT不要
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledOnce();
      expect(result.total).toBe(1);
    });
  });

  // -------------------------------------------------
  // searchBackgroundDesignsHybrid
  // -------------------------------------------------
  describe('searchBackgroundDesignsHybrid', () => {
    it('正常ハイブリッド検索: vector + fulltext が両方呼ばれRRFマージされること', async () => {
      // Arrange
      const vectorRows = [
        createMockRow({ id: 'vec-001', similarity: 0.95 }),
        createMockRow({ id: 'vec-002', similarity: 0.85 }),
      ];
      const fulltextRows = [
        createMockRow({ id: 'ft-001', similarity: 0.9 }),
        createMockRow({ id: 'vec-001', similarity: 0.8 }), // vectorと重複
      ];

      const prisma = createMockPrisma();
      // 1回目: vector検索、2回目: fulltext検索（Promise.allで並列実行）
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(vectorRows)
        .mockResolvedValueOnce(fulltextRows);

      const { service } = createTestService({ prisma });

      // Act
      const result = await service.searchBackgroundDesignsHybrid(
        'gradient background',
        createMockEmbedding(),
        { limit: 10, offset: 0 }
      );

      // Assert: $queryRawUnsafe が2回呼ばれる（vector + fulltext）
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);

      // 結果が返ること（RRFマージにより少なくとも1件）
      expect(result.results.length).toBeGreaterThan(0);
      // totalはハイブリッド結果のユニークID数
      expect(result.total).toBeGreaterThan(0);
    });

    it('fulltext検索失敗時: vector結果のみでRRFマージされること', async () => {
      // Arrange
      const vectorRows = [
        createMockRow({ id: 'vec-001', similarity: 0.95 }),
      ];

      const prisma = createMockPrisma();
      // 1回目: vector検索 → 成功
      // 2回目: fulltext検索 → 失敗
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(vectorRows)
        .mockRejectedValueOnce(new Error('Full-text index not available'));

      const { service } = createTestService({ prisma });

      // Act
      const result = await service.searchBackgroundDesignsHybrid(
        'gradient',
        createMockEmbedding(),
        { limit: 10, offset: 0 }
      );

      // Assert: fulltext失敗しても結果は返る（vector結果のみ）
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.total).toBeGreaterThan(0);
    });

    it('ハイブリッド全体失敗時: searchBackgroundDesignsにフォールバックすること', async () => {
      // Arrange
      const fallbackRows = [createMockRow({ id: 'fallback-001', similarity: 0.80 })];

      const prisma = createMockPrisma();
      // ハイブリッド検索で両方の $queryRawUnsafe が失敗するようにする
      // → vector検索関数自体が例外を投げる → catch で searchBackgroundDesigns にフォールバック
      let callCount = 0;
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
        callCount++;
        const sql = args[0] as string;
        // ハイブリッド内のvector検索はLIMITのみ(OFFSETなし)で区別可能
        // フォールバック先のsearchBackgroundDesignsはOFFSETを含む
        if (callCount <= 1) {
          // ハイブリッド内のvector検索 → 失敗
          return Promise.reject(new Error('Database connection lost'));
        }
        // フォールバック: searchBackgroundDesigns
        return Promise.resolve(fallbackRows);
      });

      const { service } = createTestService({ prisma });

      // Act
      const result = await service.searchBackgroundDesignsHybrid(
        'gradient',
        createMockEmbedding(),
        { limit: 10, offset: 0 }
      );

      // Assert: フォールバックにより結果が返る
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('fallback-001');
    });

    it('フィルタ付きハイブリッド検索: ベースWHERE句が正しく構築されること', async () => {
      // Arrange
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([createMockRow()])
        .mockResolvedValueOnce([createMockRow()]);

      const { service } = createTestService({ prisma });

      // Act
      await service.searchBackgroundDesignsHybrid(
        'gradient query',
        createMockEmbedding(),
        {
          limit: 10,
          offset: 0,
          filters: { designType: 'linear_gradient', webPageId: 'wp-001' },
        }
      );

      // Assert: 両方の検索SQLにフィルタ条件が含まれる
      const calls = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(2);

      // vector検索SQL
      const vecSql = calls[0][0] as string;
      expect(vecSql).toContain('bd.design_type::text');
      expect(vecSql).toContain('bd.web_page_id');

      // fulltext検索SQL
      const ftSql = calls[1][0] as string;
      expect(ftSql).toContain('bd.design_type::text');
      expect(ftSql).toContain('bd.web_page_id');
    });

    it('ハイブリッド検索: offset/limitによるスライスが正しいこと', async () => {
      // Arrange: 多数の結果を返す
      const manyRows = Array.from({ length: 10 }, (_, i) =>
        createMockRow({ id: `bg-${String(i).padStart(3, '0')}`, similarity: 0.9 - i * 0.01 })
      );

      const prisma = createMockPrisma();
      // vector検索とfulltext検索の両方から結果を返す
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(manyRows)
        .mockResolvedValueOnce([]); // fulltext は空

      const { service } = createTestService({ prisma });

      // Act: offset=2, limit=3 でスライス
      const result = await service.searchBackgroundDesignsHybrid(
        'gradient',
        createMockEmbedding(),
        { limit: 3, offset: 2 }
      );

      // Assert: スライスされた結果
      expect(result.results.length).toBeLessThanOrEqual(3);
      // total はスライス前の全ハイブリッド結果数
      expect(result.total).toBe(10);
    });
  });

  // -------------------------------------------------
  // DI Factory
  // -------------------------------------------------
  describe('createBackgroundSearchServiceFromFactories', () => {
    beforeEach(() => {
      // DI Factoryをリセット（モジュールレベルの状態）
      // factory を null にするため、未設定の factory を上書き
      setBackgroundSearchPrismaClientFactory(createMockPrisma);
      setBackgroundSearchEmbeddingServiceFactory(createMockEmbeddingService);
    });

    it('factory設定済みの場合: サービスオブジェクトが返ること', () => {
      // Arrange: beforeEach で設定済み

      // Act
      const service = createBackgroundSearchServiceFromFactories();

      // Assert
      expect(service).not.toBeNull();
      expect(service).toHaveProperty('generateQueryEmbedding');
      expect(service).toHaveProperty('searchBackgroundDesigns');
      expect(service).toHaveProperty('searchBackgroundDesignsHybrid');
    });

    it('prismaClientFactory未設定の場合: nullが返ること', () => {
      // Arrange: prisma factory を null にリセット
      // モジュール変数を直接リセットできないため、新しいimportが必要
      // 代替: factory に null をセットする方法は公開されていないので、
      // テストの順序に依存しないようモジュールをリロードする必要がある
      // → vi.resetModules() + 動的 import で対応
    });
  });

  // -------------------------------------------------
  // DI Factory（モジュールリロード版）
  // -------------------------------------------------
  describe('createBackgroundSearchServiceFromFactories (モジュールリロード)', () => {
    it('factory未設定の場合: nullが返ること', async () => {
      // Arrange: モジュールをリロードして初期状態（factory=null）にする
      vi.resetModules();

      // production-guard と logger のモックを再設定
      vi.doMock('../../../src/services/production-guard', () => ({
        isDevelopmentEnvironment: (): boolean => false,
      }));
      vi.doMock('../../../src/utils/logger', () => ({
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      }));

      const freshModule = await import('../../../src/services/background-search.service');

      // Act: factory 未設定のまま呼び出し
      const service = freshModule.createBackgroundSearchServiceFromFactories();

      // Assert
      expect(service).toBeNull();
    });

    it('embeddingServiceFactory のみ未設定の場合: nullが返ること', async () => {
      // Arrange: モジュールをリロード
      vi.resetModules();

      vi.doMock('../../../src/services/production-guard', () => ({
        isDevelopmentEnvironment: (): boolean => false,
      }));
      vi.doMock('../../../src/utils/logger', () => ({
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      }));

      const freshModule = await import('../../../src/services/background-search.service');

      // prismaClientFactory のみ設定
      freshModule.setBackgroundSearchPrismaClientFactory(createMockPrisma);
      // embeddingServiceFactory は未設定

      // Act
      const service = freshModule.createBackgroundSearchServiceFromFactories();

      // Assert
      expect(service).toBeNull();
    });
  });

  // -------------------------------------------------
  // ヘルパー: mapRowToResult
  // -------------------------------------------------
  describe('mapRowToResult（searchBackgroundDesigns経由で間接検証）', () => {
    it('snake_case→camelCaseマッピングが正しいこと', async () => {
      // Arrange
      const row = createMockRow({
        id: 'map-001',
        web_page_id: 'wp-map',
        name: 'Test Background',
        design_type: 'radial_gradient',
        css_value: 'radial-gradient(circle, #fff, #000)',
        selector: '#main-bg',
        color_info: { dominant: '#ffffff' },
        text_representation: 'white to black radial',
        similarity: 0.88,
      });

      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([row]);
      const { service } = createTestService({ prisma });

      // Act
      const result = await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 5, // offset > 0 で COUNT を避ける
      });

      // Assert: camelCase にマッピングされている
      const item = result.results[0];
      expect(item.id).toBe('map-001');
      expect(item.webPageId).toBe('wp-map');
      expect(item.name).toBe('Test Background');
      expect(item.designType).toBe('radial_gradient');
      expect(item.cssValue).toBe('radial-gradient(circle, #fff, #000)');
      expect(item.selector).toBe('#main-bg');
      expect(item.colorInfo).toEqual({ dominant: '#ffffff' });
      expect(item.textRepresentation).toBe('white to black radial');
      expect(item.similarity).toBe(0.88);
    });

    it('selector が null の場合も正しくマッピングされること', async () => {
      // Arrange
      const row = createMockRow({ selector: null });
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([row]);
      const { service } = createTestService({ prisma });

      // Act
      const result = await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 5,
      });

      // Assert
      expect(result.results[0].selector).toBeNull();
    });

    it('color_info が null の場合にデフォルト空オブジェクトになること', async () => {
      // Arrange
      const row = createMockRow({ color_info: null });
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([row]);
      const { service } = createTestService({ prisma });

      // Act
      const result = await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 5,
      });

      // Assert: null → {} にフォールバック
      expect(result.results[0].colorInfo).toEqual({});
    });

    it('text_representation が null の場合にデフォルト空文字列になること', async () => {
      // Arrange
      const row = createMockRow({ text_representation: null });
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([row]);
      const { service } = createTestService({ prisma });

      // Act
      const result = await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 5,
      });

      // Assert: null → '' にフォールバック
      expect(result.results[0].textRepresentation).toBe('');
    });
  });

  // -------------------------------------------------
  // ヘルパー: buildWhereClause（searchBackgroundDesigns経由で間接検証）
  // -------------------------------------------------
  describe('buildWhereClause（searchBackgroundDesigns経由で間接検証）', () => {
    it('フィルタなし: bde.embedding IS NOT NULL のみのWHERE句', async () => {
      // Arrange
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const { service } = createTestService({ prisma });

      // Act
      await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 0,
      });

      // Assert
      const sql = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sql).toContain('bde.embedding IS NOT NULL');
      // フィルタ条件がない
      expect(sql).not.toContain('bd.design_type::text');
      expect(sql).not.toContain('bd.web_page_id =');
    });

    it('designTypeのみ: $2にdesignTypeがバインドされること', async () => {
      // Arrange
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const { service } = createTestService({ prisma });

      // Act
      await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 0,
        filters: { designType: 'mesh_gradient' },
      });

      // Assert
      const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      const sql = callArgs[0] as string;
      expect(sql).toContain('bd.design_type::text = $2');
      // パラメータ: [vectorString, designType, limit, offset]
      expect(callArgs[2]).toBe('mesh_gradient');
    });

    it('webPageIdのみ: $2にwebPageIdがバインドされること', async () => {
      // Arrange
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const { service } = createTestService({ prisma });

      // Act
      await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 0,
        filters: { webPageId: 'wp-123' },
      });

      // Assert
      const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      const sql = callArgs[0] as string;
      expect(sql).toContain('bd.web_page_id = $2');
      expect(callArgs[2]).toBe('wp-123');
    });

    it('両方のフィルタ: パラメータインデックスが正しくインクリメントされること', async () => {
      // Arrange
      const prisma = createMockPrisma();
      (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const { service } = createTestService({ prisma });

      // Act
      await service.searchBackgroundDesigns(createMockEmbedding(), {
        limit: 10,
        offset: 0,
        filters: { designType: 'solid_color', webPageId: 'wp-456' },
      });

      // Assert
      const callArgs = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      const sql = callArgs[0] as string;
      // designType=$2, webPageId=$3, limit=$4, offset=$5
      expect(sql).toContain('bd.design_type::text = $2');
      expect(sql).toContain('bd.web_page_id = $3');
      expect(sql).toContain('LIMIT $4');
      expect(sql).toContain('OFFSET $5');
      // パラメータ: [vectorString, designType, webPageId, limit, offset]
      expect(callArgs[1]).toBe(`[${createMockEmbedding().join(',')}]`);
      expect(callArgs[2]).toBe('solid_color');
      expect(callArgs[3]).toBe('wp-456');
      expect(callArgs[4]).toBe(10);
      expect(callArgs[5]).toBe(0);
    });
  });
});
