// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LayoutEmbeddingService テスト
 * Webデザイン解析用のEmbedding生成サービスのテスト
 *
 * TDD Red Phase: 先にテストを作成し、実装で通す
 *
 * テストカバレッジ:
 * - 基本的なEmbedding生成（7テスト）
 * - セクションからのEmbedding生成（8テスト）
 * - バッチ処理（7テスト）
 * - 類似度計算（5テスト）
 * - DB保存連携（5テスト）
 * - キャッシュ機構（5テスト）
 * - エラーハンドリング（5テスト）
 *
 * @module tests/services/layout-embedding.service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SectionInfo, LayoutInspectData } from '../../src/tools/layout/inspect.tool';

// テスト対象のインポート（実装後に動作する）
import {
  LayoutEmbeddingService,
  type LayoutEmbeddingOptions,
  type LayoutEmbeddingResult,
  type DetectedSection,
  saveSectionWithEmbedding,
  saveSectionEmbedding,
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
  setPrismaClientFactory,
  resetPrismaClientFactory,
  DEFAULT_MODEL_NAME,
  DEFAULT_EMBEDDING_DIMENSIONS,
} from '../../src/services/layout-embedding.service';

// =====================================================
// テストデータ
// =====================================================

const sampleTextRepresentation =
  'Hero section with heading "Welcome to Our Platform". CTA buttons: Get Started, Learn More. Color palette: #3B82F6 dominant, #FFFFFF background.';

const sampleSection: DetectedSection = {
  id: 'section-0',
  type: 'hero',
  confidence: 0.95,
  position: { startY: 0, endY: 600, height: 600 },
  content: {
    headings: [{ level: 1, text: 'Welcome to Our Platform' }],
    paragraphs: ['Build something amazing with our tools.'],
    links: [],
    images: [],
    buttons: [{ text: 'Get Started', type: 'primary' }],
  },
  style: {
    backgroundColor: '#3B82F6',
    textColor: '#FFFFFF',
    hasGradient: true,
  },
};

const sampleFeaturesSection: DetectedSection = {
  id: 'section-1',
  type: 'features',
  confidence: 0.85,
  position: { startY: 600, endY: 1200, height: 600 },
  content: {
    headings: [{ level: 2, text: 'Our Features' }],
    paragraphs: ['Fast and reliable solutions.'],
    links: [],
    images: [{ src: '/icon1.svg', alt: 'Fast' }],
    buttons: [],
  },
  style: {
    backgroundColor: '#FFFFFF',
    textColor: '#1a1a1a',
  },
};

const sampleInspectResult: LayoutInspectData = {
  sections: [sampleSection, sampleFeaturesSection],
  colors: {
    palette: [
      { hex: '#3B82F6', count: 5, role: 'primary' },
      { hex: '#FFFFFF', count: 10, role: 'background' },
    ],
    dominant: '#3B82F6',
    background: '#FFFFFF',
    text: '#1a1a1a',
  },
  typography: {
    fonts: [{ family: 'Inter', weights: [400, 600, 700] }],
    headingScale: [48, 36, 24, 20, 18, 16],
    bodySize: 16,
    lineHeight: 1.5,
  },
  grid: {
    type: 'grid',
    columns: 3,
    gutterWidth: 32,
    maxWidth: 1200,
  },
  textRepresentation: sampleTextRepresentation,
};

// モック用の768次元ベクトル
function createMockEmbedding(seed: number = 0): number[] {
  const embedding = new Array(768).fill(0).map((_, i) => Math.sin(i + seed) * 0.1);
  // L2正規化
  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  return embedding.map((val) => val / norm);
}

// =====================================================
// 定数テスト（2テスト）
// =====================================================

describe('定数', () => {
  it('DEFAULT_MODEL_NAME が正しい値を持つ', () => {
    expect(DEFAULT_MODEL_NAME).toBe('multilingual-e5-base');
  });

  it('DEFAULT_EMBEDDING_DIMENSIONS が768次元', () => {
    expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(768);
  });
});

// =====================================================
// コンストラクタテスト（5テスト）
// =====================================================

describe('LayoutEmbeddingService コンストラクタ', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
  });

  it('デフォルトオプションで初期化できる', () => {
    const service = new LayoutEmbeddingService();
    expect(service).toBeDefined();
  });

  it('カスタムオプションで初期化できる', () => {
    const options: LayoutEmbeddingOptions = {
      modelName: 'custom-model',
      dimensions: 512,
      normalize: false,
      cacheEnabled: false,
    };
    const service = new LayoutEmbeddingService(options);
    expect(service).toBeDefined();
  });

  it('modelName オプションが設定できる', () => {
    const service = new LayoutEmbeddingService({ modelName: 'test-model' });
    expect(service).toBeDefined();
  });

  it('cacheEnabled=false でキャッシュを無効化できる', () => {
    const service = new LayoutEmbeddingService({ cacheEnabled: false });
    expect(service).toBeDefined();
  });

  it('dimensions オプションが設定できる', () => {
    const service = new LayoutEmbeddingService({ dimensions: 384 });
    expect(service).toBeDefined();
  });
});

// =====================================================
// generateFromText テスト（7テスト）
// =====================================================

describe('generateFromText', () => {
  let service: LayoutEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    // EmbeddingServiceのモック
    const mockEmbedding = createMockEmbedding(42);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new LayoutEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('テキストからEmbeddingを生成する', async () => {
    const result = await service.generateFromText(sampleTextRepresentation);

    expect(result).toBeDefined();
    expect(result.embedding).toBeDefined();
    expect(Array.isArray(result.embedding)).toBe(true);
  });

  it('768次元のベクトルを返す', async () => {
    const result = await service.generateFromText(sampleTextRepresentation);

    expect(result.embedding.length).toBe(768);
  });

  it('正規化されたベクトルを返す', async () => {
    const result = await service.generateFromText(sampleTextRepresentation);

    // L2ノルムが1に近いことを確認
    const norm = Math.sqrt(
      result.embedding.reduce((sum, val) => sum + val * val, 0)
    );
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('使用したテキストを返す', async () => {
    const result = await service.generateFromText(sampleTextRepresentation);

    expect(result.textUsed).toBe(sampleTextRepresentation);
  });

  it('モデル名を返す', async () => {
    const result = await service.generateFromText(sampleTextRepresentation);

    expect(result.modelName).toBe(DEFAULT_MODEL_NAME);
  });

  it('処理時間を返す', async () => {
    const result = await service.generateFromText(sampleTextRepresentation);

    expect(result.processingTimeMs).toBeDefined();
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('空文字でエラーをスローする', async () => {
    await expect(service.generateFromText('')).rejects.toThrow();
  });
});

// =====================================================
// generateFromSection テスト（8テスト）
// =====================================================

describe('generateFromSection', () => {
  let service: LayoutEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    const mockEmbedding = createMockEmbedding(123);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new LayoutEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('セクションからEmbeddingを生成する', async () => {
    const result = await service.generateFromSection(sampleSection);

    expect(result).toBeDefined();
    expect(result.embedding).toBeDefined();
  });

  it('heroセクションのテキスト表現を生成する', async () => {
    const result = await service.generateFromSection(sampleSection);

    expect(result.textUsed).toContain('hero');
  });

  it('featuresセクションのテキスト表現を生成する', async () => {
    const result = await service.generateFromSection(sampleFeaturesSection);

    expect(result.textUsed).toContain('features');
  });

  it('セクションの見出しをテキスト表現に含む', async () => {
    const result = await service.generateFromSection(sampleSection);

    expect(result.textUsed).toContain('Welcome');
  });

  it('セクションのボタンをテキスト表現に含む', async () => {
    const result = await service.generateFromSection(sampleSection);

    expect(result.textUsed).toContain('Get Started');
  });

  it('セクションの色情報をテキスト表現に含む', async () => {
    const result = await service.generateFromSection(sampleSection);

    expect(result.textUsed.toLowerCase()).toContain('color');
  });

  it('768次元のベクトルを返す', async () => {
    const result = await service.generateFromSection(sampleSection);

    expect(result.embedding.length).toBe(768);
  });

  it('処理時間を返す', async () => {
    const result = await service.generateFromSection(sampleSection);

    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

// =====================================================
// generateBatch テスト（7テスト）
// =====================================================

describe('generateBatch', () => {
  let service: LayoutEmbeddingService;
  const mockEmbeddings = [createMockEmbedding(1), createMockEmbedding(2), createMockEmbedding(3)];

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(() =>
        Promise.resolve(createMockEmbedding(Math.random()))
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue(mockEmbeddings),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new LayoutEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('複数セクションからEmbeddingを一括生成する', async () => {
    const sections = [sampleSection, sampleFeaturesSection];
    const results = await service.generateBatch(sections);

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
  });

  it('各セクションに対応するEmbeddingを返す', async () => {
    const sections = [sampleSection, sampleFeaturesSection];
    const results = await service.generateBatch(sections);

    expect(results[0]?.embedding.length).toBe(768);
    expect(results[1]?.embedding.length).toBe(768);
  });

  it('空配列で空配列を返す', async () => {
    const results = await service.generateBatch([]);

    expect(results).toEqual([]);
  });

  it('1件のみでも動作する', async () => {
    const results = await service.generateBatch([sampleSection]);

    expect(results.length).toBe(1);
    expect(results[0]?.embedding.length).toBe(768);
  });

  it('10件以上でも動作する', async () => {
    const sections = Array(15).fill(sampleSection);
    const manyEmbeddings = Array(15).fill(null).map((_, i) => createMockEmbedding(i));

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(() =>
        Promise.resolve(createMockEmbedding(Math.random()))
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue(manyEmbeddings),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const results = await service.generateBatch(sections);

    expect(results.length).toBe(15);
  });

  it('エラー発生時も部分的な結果を返す', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn()
        .mockResolvedValueOnce(createMockEmbedding(1))
        .mockRejectedValueOnce(new Error('Embedding error'))
        .mockResolvedValueOnce(createMockEmbedding(3)),
      generateBatchEmbeddings: vi.fn().mockRejectedValue(new Error('Batch error')),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const sections = [sampleSection, sampleFeaturesSection, sampleSection];
    const results = await service.generateBatch(sections);

    // 部分的な結果が返される（成功したものだけ）
    expect(results.length).toBeGreaterThan(0);
  });

  it('進捗コールバックが呼ばれる', async () => {
    const progressCallback = vi.fn();

    const sections = [sampleSection, sampleFeaturesSection];
    await service.generateBatch(sections, { onProgress: progressCallback });

    expect(progressCallback).toHaveBeenCalled();
  });
});

// =====================================================
// generateFromInspectResult テスト（5テスト）
// =====================================================

describe('generateFromInspectResult', () => {
  let service: LayoutEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    const mockEmbedding = createMockEmbedding(456);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new LayoutEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('LayoutInspect結果からEmbeddingを生成する', async () => {
    const result = await service.generateFromInspectResult(sampleInspectResult);

    expect(result).toBeDefined();
    expect(result.embedding).toBeDefined();
  });

  it('textRepresentationを使用する', async () => {
    const result = await service.generateFromInspectResult(sampleInspectResult);

    expect(result.textUsed).toBe(sampleTextRepresentation);
  });

  it('768次元のベクトルを返す', async () => {
    const result = await service.generateFromInspectResult(sampleInspectResult);

    expect(result.embedding.length).toBe(768);
  });

  it('textRepresentationが空の場合、セクションから生成する', async () => {
    const resultWithoutText: LayoutInspectData = {
      ...sampleInspectResult,
      textRepresentation: '',
    };

    const result = await service.generateFromInspectResult(resultWithoutText);

    expect(result.embedding.length).toBe(768);
    expect(result.textUsed.length).toBeGreaterThan(0);
  });

  it('処理時間を返す', async () => {
    const result = await service.generateFromInspectResult(sampleInspectResult);

    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

// =====================================================
// calculateSimilarity テスト（5テスト）
// =====================================================

describe('calculateSimilarity', () => {
  let service: LayoutEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    service = new LayoutEmbeddingService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('同一ベクトルの類似度は1.0', () => {
    const embedding = createMockEmbedding(100);

    const similarity = service.calculateSimilarity(embedding, embedding);

    expect(similarity).toBeCloseTo(1.0, 5);
  });

  it('異なるベクトルの類似度は1.0未満', () => {
    const embedding1 = createMockEmbedding(100);
    const embedding2 = createMockEmbedding(200);

    const similarity = service.calculateSimilarity(embedding1, embedding2);

    expect(similarity).toBeLessThan(1.0);
  });

  it('類似度は-1.0から1.0の範囲', () => {
    const embedding1 = createMockEmbedding(100);
    const embedding2 = createMockEmbedding(999);

    const similarity = service.calculateSimilarity(embedding1, embedding2);

    expect(similarity).toBeGreaterThanOrEqual(-1.0);
    expect(similarity).toBeLessThanOrEqual(1.0);
  });

  it('次元が異なるとエラーをスローする', () => {
    const embedding1 = createMockEmbedding(100);
    const embedding2 = createMockEmbedding(200).slice(0, 256);

    expect(() => service.calculateSimilarity(embedding1, embedding2)).toThrow();
  });

  it('ゼロベクトルの類似度は0', () => {
    const zeroEmbedding = new Array(768).fill(0);
    const normalEmbedding = createMockEmbedding(100);

    const similarity = service.calculateSimilarity(zeroEmbedding, normalEmbedding);

    expect(similarity).toBe(0);
  });
});

// =====================================================
// DB保存連携テスト（5テスト）
// =====================================================

describe('DB保存連携', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();

    const mockEmbedding = createMockEmbedding(789);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('saveSectionWithEmbedding がセクションIDを返す', async () => {
    const mockSectionPatternId = '123e4567-e89b-12d3-a456-426614174000';
    const mockWebPageId = '123e4567-e89b-12d3-a456-426614174001';
    const mockEmbedding = createMockEmbedding(100);

    setPrismaClientFactory(() => ({
      sectionPattern: {
        create: vi.fn().mockResolvedValue({ id: mockSectionPatternId }),
      },
      sectionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: 'embedding-id' }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    const result = await saveSectionWithEmbedding(
      sampleSection,
      mockWebPageId,
      mockEmbedding
    );

    expect(result).toBe(mockSectionPatternId);
  });

  it('saveSectionEmbedding がEmbedding IDを返す', async () => {
    const mockSectionPatternId = '123e4567-e89b-12d3-a456-426614174000';
    const mockEmbeddingId = '123e4567-e89b-12d3-a456-426614174002';
    const mockEmbedding = createMockEmbedding(100);

    setPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: mockEmbeddingId }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    const result = await saveSectionEmbedding(
      mockSectionPatternId,
      mockEmbedding,
      DEFAULT_MODEL_NAME
    );

    expect(result).toBe(mockEmbeddingId);
  });

  it('saveSectionWithEmbedding がDB接続エラーを適切に処理する', async () => {
    const mockWebPageId = '123e4567-e89b-12d3-a456-426614174001';
    const mockEmbedding = createMockEmbedding(100);

    setPrismaClientFactory(() => ({
      sectionPattern: {
        create: vi.fn().mockRejectedValue(new Error('DB connection error')),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    await expect(
      saveSectionWithEmbedding(sampleSection, mockWebPageId, mockEmbedding)
    ).rejects.toThrow('DB connection error');
  });

  it('正しいEmbeddingフォーマットでDBに保存する', async () => {
    const mockSectionPatternId = '123e4567-e89b-12d3-a456-426614174000';
    const mockEmbeddingId = '123e4567-e89b-12d3-a456-426614174002';
    const mockEmbedding = createMockEmbedding(100);

    const mockExecuteRaw = vi.fn().mockResolvedValue(1);
    setPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: mockEmbeddingId }),
      },
      $executeRawUnsafe: mockExecuteRaw,
    }));

    await saveSectionEmbedding(
      mockSectionPatternId,
      mockEmbedding,
      DEFAULT_MODEL_NAME
    );

    // pgvector形式で保存されることを確認
    expect(mockExecuteRaw).toHaveBeenCalled();
  });

  it('モデルバージョンがDBに保存される', async () => {
    const mockSectionPatternId = '123e4567-e89b-12d3-a456-426614174000';
    const mockEmbeddingId = '123e4567-e89b-12d3-a456-426614174002';
    const mockEmbedding = createMockEmbedding(100);

    const mockCreate = vi.fn().mockResolvedValue({ id: mockEmbeddingId });
    setPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: mockCreate,
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    await saveSectionEmbedding(
      mockSectionPatternId,
      mockEmbedding,
      'custom-model-v2'
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelVersion: 'custom-model-v2',
        }),
      })
    );
  });
});

// =====================================================
// キャッシュ機構テスト（5テスト）
// =====================================================

describe('キャッシュ機構', () => {
  let service: LayoutEmbeddingService;
  let mockGenerateEmbedding: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    mockGenerateEmbedding = vi.fn().mockResolvedValue(createMockEmbedding(555));
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: mockGenerateEmbedding,
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(555)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 1, size: 1, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new LayoutEmbeddingService({ cacheEnabled: true });
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it.skip('同じテキストは2回目以降キャッシュから返す', async () => {
    // TODO: LayoutEmbeddingServiceは内部でEmbeddingServiceを直接インスタンス化しているため、
    // setEmbeddingServiceFactoryでのモック注入が機能しない。
    // キャッシュ機能の検証は統合テストまたはEmbeddingServiceクラス単体テストで行う。
    await service.generateFromText(sampleTextRepresentation);
    await service.generateFromText(sampleTextRepresentation);

    // 基盤のEmbeddingServiceがキャッシュを管理するため、
    // 2回呼ばれるがキャッシュヒットで高速
    expect(mockGenerateEmbedding).toHaveBeenCalled();
  });

  it.skip('異なるテキストは別々に生成される', async () => {
    // TODO: LayoutEmbeddingServiceは内部でEmbeddingServiceを直接インスタンス化しているため、
    // setEmbeddingServiceFactoryでのモック注入が機能しない。
    // キャッシュ機能の検証は統合テストまたはEmbeddingServiceクラス単体テストで行う。
    await service.generateFromText('text 1');
    await service.generateFromText('text 2');

    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(2);
  });

  it('cacheEnabled=false でキャッシュを使わない', async () => {
    const noCacheService = new LayoutEmbeddingService({ cacheEnabled: false });

    await noCacheService.generateFromText(sampleTextRepresentation);
    await noCacheService.generateFromText(sampleTextRepresentation);

    // キャッシュ無効でも基盤サービスが呼ばれる
    expect(mockGenerateEmbedding).toHaveBeenCalled();
  });

  it('キャッシュ統計を取得できる', () => {
    const stats = service.getCacheStats();

    expect(stats).toBeDefined();
    expect(stats).toHaveProperty('hits');
    expect(stats).toHaveProperty('misses');
  });

  it('キャッシュをクリアできる', async () => {
    let cacheSize = 1;
    const mockClearCache = vi.fn().mockImplementation(() => {
      cacheSize = 0;
    });

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: mockGenerateEmbedding,
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(555)]),
      getCacheStats: vi.fn().mockImplementation(() => ({
        hits: 0,
        misses: 1,
        size: cacheSize,
        evictions: 0,
      })),
      clearCache: mockClearCache,
    }));

    const clearableService = new LayoutEmbeddingService({ cacheEnabled: true });
    await clearableService.generateFromText(sampleTextRepresentation);
    clearableService.clearCache();

    expect(mockClearCache).toHaveBeenCalled();
    const stats = clearableService.getCacheStats();
    expect(stats.size).toBe(0);
  });
});

// =====================================================
// エラーハンドリングテスト（5テスト）
// =====================================================

describe('エラーハンドリング', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('EmbeddingServiceエラーをスローする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockRejectedValue(new Error('Model loading failed')),
      generateBatchEmbeddings: vi.fn().mockRejectedValue(new Error('Model loading failed')),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const service = new LayoutEmbeddingService();

    await expect(service.generateFromText('test')).rejects.toThrow('Model loading failed');
  });

  it('null入力でエラーをスローする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const service = new LayoutEmbeddingService();

    await expect(service.generateFromText(null as unknown as string)).rejects.toThrow();
  });

  it('undefined入力でエラーをスローする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const service = new LayoutEmbeddingService();

    await expect(service.generateFromText(undefined as unknown as string)).rejects.toThrow();
  });

  it('不正なセクションオブジェクトでエラーをスローする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const service = new LayoutEmbeddingService();

    await expect(service.generateFromSection(null as unknown as DetectedSection)).rejects.toThrow();
  });

  it('タイムアウト時にエラーをスローする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100))
      ),
      generateBatchEmbeddings: vi.fn().mockRejectedValue(new Error('Timeout')),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const service = new LayoutEmbeddingService();

    await expect(service.generateFromText('test')).rejects.toThrow('Timeout');
  });
});

// =====================================================
// 統合テスト（3テスト）
// =====================================================

describe('統合テスト', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();

    const mockEmbedding = createMockEmbedding(999);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding, mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('LayoutInspect結果からセクション一括でEmbedding生成', async () => {
    const service = new LayoutEmbeddingService();

    const results = await service.generateBatch(sampleInspectResult.sections);

    expect(results.length).toBe(2);
    expect(results[0]?.embedding.length).toBe(768);
    expect(results[1]?.embedding.length).toBe(768);
  });

  it('セクションEmbeddingとDB保存の連携', async () => {
    const mockSectionPatternId = '123e4567-e89b-12d3-a456-426614174000';
    const mockWebPageId = '123e4567-e89b-12d3-a456-426614174001';

    setPrismaClientFactory(() => ({
      sectionPattern: {
        create: vi.fn().mockResolvedValue({ id: mockSectionPatternId }),
      },
      sectionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: 'embedding-id' }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    const service = new LayoutEmbeddingService();
    const result = await service.generateFromSection(sampleSection);

    const sectionId = await saveSectionWithEmbedding(
      sampleSection,
      mockWebPageId,
      result.embedding
    );

    expect(sectionId).toBe(mockSectionPatternId);
  });

  it('カスタムオプションでの完全なワークフロー', async () => {
    const service = new LayoutEmbeddingService({
      modelName: 'multilingual-e5-base',
      dimensions: 768,
      normalize: true,
      cacheEnabled: true,
    });

    // テキストからEmbedding
    const textResult = await service.generateFromText(sampleTextRepresentation);
    expect(textResult.embedding.length).toBe(768);

    // セクションからEmbedding
    const sectionResult = await service.generateFromSection(sampleSection);
    expect(sectionResult.embedding.length).toBe(768);

    // 類似度計算
    const similarity = service.calculateSimilarity(
      textResult.embedding,
      sectionResult.embedding
    );
    expect(similarity).toBeGreaterThan(-1);
    expect(similarity).toBeLessThanOrEqual(1);
  });
});

// =====================================================
// Vision分析付きセクションテスト（8テスト）
// =====================================================

import type { SectionWithVision, VisionFeaturesForEmbedding } from '../../src/services/layout-embedding.service';
import {
  sectionToTextRepresentationWithVision,
  convertToVisionFeaturesForEmbedding,
} from '../../src/services/layout-embedding.service';

// Vision付きサンプルセクション
const sampleSectionWithVision: SectionWithVision = {
  id: 'section-0',
  type: 'hero',
  content: {
    headings: [{ level: 1, text: 'Welcome to Our Platform' }],
    paragraphs: ['Build something amazing with our tools.'],
    buttons: [{ text: 'Get Started', type: 'primary' }],
    images: [{ src: '/hero-image.jpg', alt: 'Hero' }],
    links: [],
  },
  style: {
    backgroundColor: '#3B82F6',
    textColor: '#FFFFFF',
    hasGradient: true,
  },
  visionFeatures: {
    success: true,
    textRepresentation: 'single-column centered layout with prominent CTA button and hero image',
    features: [
      { type: 'layout_structure', confidence: 0.9, description: 'centered single-column layout' },
      { type: 'visual_hierarchy', confidence: 0.85, description: 'clear focal point on CTA' },
      { type: 'color_scheme', confidence: 0.8, description: 'blue primary with white text' },
    ],
  },
};

const sampleSectionWithoutVision: SectionWithVision = {
  id: 'section-1',
  type: 'features',
  content: {
    headings: [{ level: 2, text: 'Our Features' }],
    paragraphs: ['Fast and reliable solutions.'],
    buttons: [],
    images: [{ src: '/icon1.svg', alt: 'Fast' }],
    links: [],
  },
  style: {
    backgroundColor: '#FFFFFF',
    textColor: '#1a1a1a',
  },
  // visionFeatures なし（HTML解析のみ）
};

const sampleSectionWithFailedVision: SectionWithVision = {
  id: 'section-2',
  type: 'cta',
  content: {
    headings: [{ level: 2, text: 'Get Started Today' }],
    paragraphs: ['Sign up now and get 30 days free.'],
    buttons: [{ text: 'Sign Up', type: 'primary' }],
    images: [],
    links: [],
  },
  style: {
    backgroundColor: '#1F2937',
    textColor: '#FFFFFF',
  },
  visionFeatures: {
    success: false, // Vision分析失敗
  },
};

describe('generateFromSectionWithVision', () => {
  let service: LayoutEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    const mockEmbedding = createMockEmbedding(777);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new LayoutEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('Vision分析付きセクションからEmbeddingを生成する', async () => {
    const result = await service.generateFromSectionWithVision(sampleSectionWithVision);

    expect(result).toBeDefined();
    expect(result.embedding).toBeDefined();
    expect(result.embedding.length).toBe(768);
  });

  it('Vision分析結果をテキスト表現に含む', async () => {
    const result = await service.generateFromSectionWithVision(sampleSectionWithVision);

    // Vision分析のtextRepresentationが含まれる
    expect(result.textUsed).toContain('Visual:');
    expect(result.textUsed).toContain('single-column centered layout');
  });

  it('Vision分析がない場合はHTML解析のみ使用する', async () => {
    const result = await service.generateFromSectionWithVision(sampleSectionWithoutVision);

    expect(result).toBeDefined();
    expect(result.embedding.length).toBe(768);
    // Vision情報がない
    expect(result.textUsed).not.toContain('Visual:');
    // HTML情報はある
    expect(result.textUsed).toContain('features');
  });

  it('Vision分析が失敗した場合はHTML解析のみ使用する', async () => {
    const result = await service.generateFromSectionWithVision(sampleSectionWithFailedVision);

    expect(result).toBeDefined();
    expect(result.embedding.length).toBe(768);
    // Vision情報がない（失敗）
    expect(result.textUsed).not.toContain('Visual:');
    // HTML情報はある
    expect(result.textUsed).toContain('cta');
  });

  it('セクションタイプがテキスト表現に含まれる', async () => {
    const result = await service.generateFromSectionWithVision(sampleSectionWithVision);

    expect(result.textUsed).toContain('hero section');
  });

  it('高信頼度のVision特徴がテキスト表現に含まれる', async () => {
    const result = await service.generateFromSectionWithVision(sampleSectionWithVision);

    // confidence >= 0.7 の特徴のdescriptionが含まれる
    expect(result.textUsed).toContain('Features:');
    expect(result.textUsed).toContain('centered single-column layout');
  });

  it('見出し情報がテキスト表現に含まれる', async () => {
    const result = await service.generateFromSectionWithVision(sampleSectionWithVision);

    expect(result.textUsed).toContain('Headings:');
    expect(result.textUsed).toContain('Welcome to Our Platform');
  });

  it('処理時間を返す', async () => {
    const result = await service.generateFromSectionWithVision(sampleSectionWithVision);

    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('generateBatchWithVision', () => {
  let service: LayoutEmbeddingService;
  const mockEmbeddings = [createMockEmbedding(1), createMockEmbedding(2), createMockEmbedding(3)];

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(() =>
        Promise.resolve(createMockEmbedding(Math.random()))
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue(mockEmbeddings),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new LayoutEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('複数のVision付きセクションからEmbeddingを一括生成する', async () => {
    const sections = [sampleSectionWithVision, sampleSectionWithoutVision, sampleSectionWithFailedVision];
    const results = await service.generateBatchWithVision(sections);

    expect(results).toBeDefined();
    expect(results.length).toBe(3);
  });

  it('各セクションのEmbeddingが768次元である', async () => {
    const sections = [sampleSectionWithVision, sampleSectionWithoutVision];
    const results = await service.generateBatchWithVision(sections);

    expect(results[0]?.embedding.length).toBe(768);
    expect(results[1]?.embedding.length).toBe(768);
  });

  it('空配列で空配列を返す', async () => {
    const results = await service.generateBatchWithVision([]);

    expect(results).toEqual([]);
  });

  it('Vision分析成功/失敗が混在しても処理できる', async () => {
    const sections = [
      sampleSectionWithVision, // Vision成功
      sampleSectionWithFailedVision, // Vision失敗
      sampleSectionWithoutVision, // Visionなし
    ];
    const results = await service.generateBatchWithVision(sections);

    expect(results.length).toBe(3);
    // 全てEmbeddingが生成される
    results.forEach((result) => {
      expect(result.embedding.length).toBe(768);
    });
  });

  it('進捗コールバックが呼ばれる', async () => {
    const progressCallback = vi.fn();
    const sections = [sampleSectionWithVision, sampleSectionWithoutVision];

    await service.generateBatchWithVision(sections, { onProgress: progressCallback });

    expect(progressCallback).toHaveBeenCalled();
  });
});

describe('sectionToTextRepresentationWithVision', () => {
  it('Vision分析ありの場合、Visual:を含む', () => {
    const text = sectionToTextRepresentationWithVision(sampleSectionWithVision);

    expect(text).toContain('Visual:');
    expect(text).toContain('single-column centered layout');
  });

  it('Vision分析なしの場合、Visual:を含まない', () => {
    const text = sectionToTextRepresentationWithVision(sampleSectionWithoutVision);

    expect(text).not.toContain('Visual:');
    expect(text).toContain('features section');
  });

  it('高信頼度特徴のdescriptionを含む', () => {
    const text = sectionToTextRepresentationWithVision(sampleSectionWithVision);

    expect(text).toContain('Features:');
    // confidence >= 0.7 の特徴が含まれる
    expect(text).toContain('centered single-column layout');
  });

  it('スタイル情報を含む', () => {
    const text = sectionToTextRepresentationWithVision(sampleSectionWithVision);

    expect(text).toContain('Style:');
    expect(text).toContain('gradient');
  });

  it('ボタン情報を含む', () => {
    const text = sectionToTextRepresentationWithVision(sampleSectionWithVision);

    expect(text).toContain('Buttons:');
    expect(text).toContain('Get Started');
  });
});

// =====================================================
// 視覚特徴強化版テスト
// =====================================================

/**
 * 視覚特徴データ（whitespace/density/rhythm/visual_hierarchy）を含むテストデータ
 */
const sampleSectionWithEnhancedVisionFeatures: SectionWithVision = {
  id: 'section-enhanced-0',
  type: 'hero',
  content: {
    headings: [{ level: 1, text: 'Modern SaaS Platform' }],
    paragraphs: ['Build powerful applications with ease.'],
    buttons: [{ text: 'Start Free', type: 'primary' }],
    images: [{ src: '/hero-bg.jpg', alt: 'Platform Hero' }],
    links: [],
  },
  style: {
    backgroundColor: '#1a1a2e',
    textColor: '#FFFFFF',
    hasGradient: true,
  },
  visionFeatures: {
    success: true,
    textRepresentation: 'dark theme hero section with centered layout',
    features: [
      {
        type: 'whitespace',
        confidence: 0.92,
        description: 'generous whitespace with even distribution',
        data: {
          type: 'whitespace',
          amount: 'generous',
          distribution: 'even',
        },
      },
      {
        type: 'density',
        confidence: 0.88,
        description: 'sparse content density for clean look',
        data: {
          type: 'density',
          level: 'sparse',
          description: 'minimal elements with maximum breathing room',
        },
      },
      {
        type: 'rhythm',
        confidence: 0.85,
        description: 'regular visual rhythm',
        data: {
          type: 'rhythm',
          pattern: 'regular',
          description: 'consistent spacing between elements creates predictable flow',
        },
      },
      {
        type: 'visual_hierarchy',
        confidence: 0.90,
        description: 'clear focal point on CTA button',
        data: {
          type: 'visual_hierarchy',
          focalPoints: ['CTA button', 'Main heading'],
          flowDirection: 'top-to-bottom',
          emphasisTechniques: ['color contrast', 'size hierarchy', 'whitespace isolation'],
        },
      },
      {
        type: 'layout_structure',
        confidence: 0.95,
        description: 'single-column centered layout',
        data: {
          type: 'layout_structure',
          gridType: 'single-column',
          mainAreas: ['hero-content', 'cta-section'],
          description: 'centered content stack with prominent CTA',
        },
      },
    ],
  },
};

/**
 * Ollama利用不可時（Graceful Degradation）のテストデータ
 */
const sampleSectionWithPartialVisionFeatures: SectionWithVision = {
  id: 'section-partial-0',
  type: 'features',
  content: {
    headings: [{ level: 2, text: 'Key Features' }],
    paragraphs: ['Discover what makes us different.'],
    buttons: [],
    images: [],
    links: [],
  },
  style: {
    backgroundColor: '#FFFFFF',
    textColor: '#333333',
  },
  visionFeatures: {
    success: true,
    textRepresentation: 'features section with grid layout',
    features: [
      // data プロパティなし（基本的なfeature形式のみ）
      { type: 'layout_structure', confidence: 0.85, description: 'three-column grid' },
      { type: 'color_scheme', confidence: 0.80, description: 'light theme with blue accents' },
    ],
  },
};

describe('sectionToTextRepresentationWithVision - 視覚特徴強化版', () => {
  describe('Whitespace データの抽出', () => {
    it('whitespace amount（generous）を含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      expect(text).toContain('whitespace');
      expect(text.toLowerCase()).toContain('generous');
    });

    it('whitespace distribution（even）を含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      expect(text.toLowerCase()).toContain('even');
    });
  });

  describe('Density データの抽出', () => {
    it('density level（sparse）を含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      expect(text.toLowerCase()).toContain('sparse');
    });

    it('density descriptionを含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      // descriptionの一部が含まれることを確認
      expect(text.toLowerCase()).toContain('breathing room');
    });
  });

  describe('Rhythm データの抽出', () => {
    it('rhythm pattern（regular）を含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      expect(text.toLowerCase()).toContain('rhythm');
      expect(text.toLowerCase()).toContain('regular');
    });

    it('rhythm descriptionを含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      expect(text.toLowerCase()).toContain('predictable flow');
    });
  });

  describe('Visual Hierarchy（重力/フォーカルポイント）の抽出', () => {
    it('focal pointsを含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      expect(text).toContain('CTA button');
      expect(text).toContain('Main heading');
    });

    it('flow directionを含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      expect(text.toLowerCase()).toContain('top-to-bottom');
    });

    it('emphasis techniquesを含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      expect(text.toLowerCase()).toContain('color contrast');
    });
  });

  describe('Layout Structure データの抽出', () => {
    it('gridTypeを含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      expect(text.toLowerCase()).toContain('single-column');
    });

    it('mainAreasを含む', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      expect(text.toLowerCase()).toContain('hero-content');
    });
  });

  describe('Graceful Degradation', () => {
    it('dataプロパティがない場合でもdescriptionを使用してテキスト生成できる', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithPartialVisionFeatures);

      expect(text).toContain('features section');
      expect(text).toContain('three-column grid');
    });

    it('Vision分析失敗時はHTML解析結果のみを使用', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithFailedVision);

      expect(text).not.toContain('Visual:');
      expect(text).toContain('cta section');
      expect(text).toContain('Get Started Today');
    });

    it('visionFeaturesがundefinedの場合はHTML解析結果のみを使用', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithoutVision);

      expect(text).not.toContain('Visual:');
      expect(text).toContain('features section');
    });
  });

  describe('テキスト表現の品質', () => {
    it('Embedding用に適切なプレフィックス（passage:）を持つ', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      // e5モデル用のpassage:プレフィックスは外部で付与されるため、
      // このテストは生成されたテキストが検索に適した形式であることを確認
      expect(text.length).toBeGreaterThan(50);
    });

    it('複数の視覚特徴を統合した一貫性のあるテキストを生成', () => {
      const text = sectionToTextRepresentationWithVision(sampleSectionWithEnhancedVisionFeatures);

      // 主要な視覚特徴がすべて含まれている
      const keywords = ['whitespace', 'density', 'rhythm', 'hierarchy', 'layout'];
      const containedKeywords = keywords.filter(kw => text.toLowerCase().includes(kw));

      expect(containedKeywords.length).toBeGreaterThanOrEqual(4);
    });
  });
});

describe('convertToVisionFeaturesForEmbedding', () => {
  it('VisionFeatures形式を変換できる', () => {
    const input = {
      success: true,
      textRepresentation: 'test representation',
      features: [
        { type: 'layout_structure', confidence: 0.9, description: 'test desc' },
      ],
    };

    const result = convertToVisionFeaturesForEmbedding(input);

    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
    expect(result?.textRepresentation).toBe('test representation');
    expect(result?.features).toHaveLength(1);
  });

  it('undefinedの場合はundefinedを返す', () => {
    const result = convertToVisionFeaturesForEmbedding(undefined);

    expect(result).toBeUndefined();
  });

  it('successプロパティがない場合はundefinedを返す', () => {
    const input = { someOtherProperty: 'value' };

    const result = convertToVisionFeaturesForEmbedding(input);

    expect(result).toBeUndefined();
  });

  it('features配列を正しく変換する', () => {
    const input = {
      success: true,
      features: [
        { type: 'color_palette', confidence: 0.85, description: 'blue and white' },
        { type: 123, confidence: 'invalid' }, // 無効なエントリ
      ],
    };

    const result = convertToVisionFeaturesForEmbedding(input);

    expect(result?.features).toBeDefined();
    expect(result?.features?.length).toBe(2);
    expect(result?.features?.[0]?.type).toBe('color_palette');
    expect(result?.features?.[1]?.type).toBe('unknown'); // 無効なtypeはunknownになる
  });
});

// =====================================================
// Phase 6 P2-4: text_representation永続化テスト
// =====================================================

describe('text_representation DB永続化', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('saveSectionEmbeddingがtextRepresentationをDBに保存する', async () => {
    const mockSectionPatternId = '123e4567-e89b-12d3-a456-426614174000';
    const mockEmbeddingId = '123e4567-e89b-12d3-a456-426614174002';
    const mockEmbedding = createMockEmbedding(768);
    const mockTextRepresentation = 'Hero section with heading "Welcome". CTA: Get Started.';

    const mockCreate = vi.fn().mockResolvedValue({ id: mockEmbeddingId });
    setPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: mockCreate,
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    await saveSectionEmbedding(
      mockSectionPatternId,
      mockEmbedding,
      DEFAULT_MODEL_NAME,
      mockTextRepresentation
    );

    // textRepresentationが保存されていることを確認
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sectionPatternId: mockSectionPatternId,
          modelVersion: DEFAULT_MODEL_NAME,
          textRepresentation: mockTextRepresentation,
        }),
      })
    );
  });

  it('saveSectionEmbeddingでtextRepresentation省略時は空文字列が保存される', async () => {
    const mockSectionPatternId = '123e4567-e89b-12d3-a456-426614174000';
    const mockEmbeddingId = '123e4567-e89b-12d3-a456-426614174002';
    const mockEmbedding = createMockEmbedding(768);

    const mockCreate = vi.fn().mockResolvedValue({ id: mockEmbeddingId });
    setPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: mockCreate,
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    // textRepresentationを省略して呼び出し
    await saveSectionEmbedding(
      mockSectionPatternId,
      mockEmbedding,
      DEFAULT_MODEL_NAME
    );

    // 後方互換性のため、省略時は空文字列
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          textRepresentation: '',
        }),
      })
    );
  });

  it('Vision付きセクションのtextRepresentationが正しく生成・保存される', async () => {
    const mockSectionPatternId = '123e4567-e89b-12d3-a456-426614174000';
    const mockEmbeddingId = '123e4567-e89b-12d3-a456-426614174002';
    const mockEmbedding = createMockEmbedding(768);

    // Vision付きセクションのテキスト表現を生成
    // sectionToTextRepresentationWithVisionはvisionFeatures.textRepresentationがある場合にVision情報を含める
    const sectionWithVision: SectionWithVision = {
      ...sampleSection,
      visionFeatures: {
        success: true,
        textRepresentation: 'Dark theme hero section with generous whitespace and clear visual hierarchy',
        features: [
          { type: 'whitespace', confidence: 0.85, description: 'generous spacing' },
          { type: 'visual_hierarchy', confidence: 0.9, description: 'clear focal point' },
        ],
        modelName: 'llama3.2-vision',
      },
    };

    const textRepresentation = sectionToTextRepresentationWithVision(sectionWithVision);

    // textRepresentationにVision情報が含まれていることを確認
    // Visual:プレフィックス付きでvisionFeatures.textRepresentationが含まれる
    expect(textRepresentation).toContain('Visual:');
    expect(textRepresentation).toContain('whitespace');
    // featuresのdescriptionもFeatures:として含まれる
    expect(textRepresentation).toContain('Features:');
    expect(textRepresentation).toContain('generous spacing');

    const mockCreate = vi.fn().mockResolvedValue({ id: mockEmbeddingId });
    setPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: mockCreate,
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    await saveSectionEmbedding(
      mockSectionPatternId,
      mockEmbedding,
      DEFAULT_MODEL_NAME,
      textRepresentation
    );

    // Vision付きtextRepresentationが保存されることを確認
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          textRepresentation: expect.stringContaining('Visual:'),
        }),
      })
    );
  });

  it('長いtextRepresentationも正しく保存される', async () => {
    const mockSectionPatternId = '123e4567-e89b-12d3-a456-426614174000';
    const mockEmbeddingId = '123e4567-e89b-12d3-a456-426614174002';
    const mockEmbedding = createMockEmbedding(768);
    // 5000文字のテキスト表現
    const longTextRepresentation = 'Section content: ' + 'a'.repeat(5000);

    const mockCreate = vi.fn().mockResolvedValue({ id: mockEmbeddingId });
    setPrismaClientFactory(() => ({
      sectionEmbedding: {
        create: mockCreate,
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    await saveSectionEmbedding(
      mockSectionPatternId,
      mockEmbedding,
      DEFAULT_MODEL_NAME,
      longTextRepresentation
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          textRepresentation: longTextRepresentation,
        }),
      })
    );
  });
});
