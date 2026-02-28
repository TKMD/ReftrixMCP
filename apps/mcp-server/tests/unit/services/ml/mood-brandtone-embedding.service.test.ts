// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mood/BrandTone Embedding Service テスト
 *
 * SectionPattern の mood/brandTone 埋め込み機能のテスト
 *
 * TDD Red Phase: 先にテストを作成し、実装で通す
 *
 * テストカバレッジ:
 * - 定数テスト（2テスト）
 * - コンストラクタテスト（5テスト）
 * - Mood埋め込み生成テスト（10テスト）
 * - BrandTone埋め込み生成テスト（10テスト）
 * - バッチ処理テスト（8テスト）
 * - 統合テスト（6テスト）
 * - エラーハンドリングテスト（5テスト）
 *
 * @module tests/unit/services/ml/mood-brandtone-embedding.service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// テスト対象のインポート（実装後に動作する）
import {
  MoodBrandToneEmbeddingService,
  type MoodBrandToneEmbeddingOptions,
  type MoodTextRepresentation,
  type BrandToneTextRepresentation,
  saveMoodBrandToneEmbedding,
  saveBatchMoodBrandToneEmbeddings,
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
  setPrismaClientFactory,
  resetPrismaClientFactory,
  DEFAULT_MODEL_NAME,
  DEFAULT_EMBEDDING_DIMENSIONS,
} from '../../../../src/services/ml/mood-brandtone-embedding.service';

// MoodBrandToneEmbeddingResult は saveMoodBrandToneEmbedding の戻り値として間接的にテストされる

// =====================================================
// テストデータ
// =====================================================

// Mood テキスト表現
const sampleMoodTextRepresentation: MoodTextRepresentation = {
  primary: 'professional',
  secondary: 'minimalist',
  description: 'Clean, corporate design with minimal decoration'
};

// BrandTone テキスト表現
const sampleBrandToneTextRepresentation: BrandToneTextRepresentation = {
  primary: 'corporate',
  secondary: 'innovative',
  description: 'Enterprise-focused with cutting-edge technology'
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

describe('MoodBrandToneEmbeddingService コンストラクタ', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
  });

  it('デフォルトオプションで初期化できる', () => {
    const service = new MoodBrandToneEmbeddingService();
    expect(service).toBeDefined();
  });

  it('カスタムオプションで初期化できる', () => {
    const options: MoodBrandToneEmbeddingOptions = {
      modelName: 'custom-model',
      dimensions: 512,
      normalize: false,
      cacheEnabled: false,
    };
    const service = new MoodBrandToneEmbeddingService(options);
    expect(service).toBeDefined();
  });

  it('modelName オプションが設定できる', () => {
    const service = new MoodBrandToneEmbeddingService({ modelName: 'test-model' });
    expect(service).toBeDefined();
  });

  it('cacheEnabled=false でキャッシュを無効化できる', () => {
    const service = new MoodBrandToneEmbeddingService({ cacheEnabled: false });
    expect(service).toBeDefined();
  });

  it('dimensions オプションが設定できる', () => {
    const service = new MoodBrandToneEmbeddingService({ dimensions: 384 });
    expect(service).toBeDefined();
  });
});

// =====================================================
// Mood埋め込み生成テスト（10テスト）
// =====================================================

describe('generateMoodEmbedding', () => {
  let service: MoodBrandToneEmbeddingService;

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

    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('Mood テキスト表現からEmbeddingを生成する', async () => {
    const result = await service.generateMoodEmbedding(sampleMoodTextRepresentation);

    expect(result).toBeDefined();
    expect(result.embedding).toBeDefined();
    expect(Array.isArray(result.embedding)).toBe(true);
  });

  it('768次元のベクトルを返す', async () => {
    const result = await service.generateMoodEmbedding(sampleMoodTextRepresentation);

    expect(result.embedding.length).toBe(768);
  });

  it('正規化されたベクトルを返す', async () => {
    const result = await service.generateMoodEmbedding(sampleMoodTextRepresentation);

    // L2ノルムが1に近いことを確認
    const norm = Math.sqrt(
      result.embedding.reduce((sum, val) => sum + val * val, 0)
    );
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('使用したテキスト表現を返す', async () => {
    const result = await service.generateMoodEmbedding(sampleMoodTextRepresentation);

    expect(result.textRepresentation).toBeDefined();
    expect(result.textRepresentation).toContain('professional');
    expect(result.textRepresentation).toContain('minimalist');
  });

  it('モデル名を返す', async () => {
    const result = await service.generateMoodEmbedding(sampleMoodTextRepresentation);

    expect(result.modelName).toBe(DEFAULT_MODEL_NAME);
  });

  it('処理時間を返す', async () => {
    const result = await service.generateMoodEmbedding(sampleMoodTextRepresentation);

    expect(result.processingTimeMs).toBeDefined();
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('Mood タイプを返す', async () => {
    const result = await service.generateMoodEmbedding(sampleMoodTextRepresentation);

    expect(result.type).toBe('mood');
  });

  it('空の Mood テキストでエラーをスローする', async () => {
    const emptyMood: MoodTextRepresentation = {
      primary: '',
      secondary: '',
      description: ''
    };

    await expect(service.generateMoodEmbedding(emptyMood)).rejects.toThrow();
  });

  it('タイムアウトでエラーをスローする', async () => {
    // 短いタイムアウト（100ms）を設定したサービスで、長時間かかる処理をテスト
    const shortTimeoutService = new MoodBrandToneEmbeddingService({
      timeout: 100, // 100msでタイムアウト
    });

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(createMockEmbedding()), 500)) // 500ms待機
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding()]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    await expect(
      shortTimeoutService.generateMoodEmbedding(sampleMoodTextRepresentation)
    ).rejects.toThrow('timed out');
  });

  it('不正な形式の Mood テキストでエラーをスローする', async () => {
     
    const invalidMood = {
      primary: 'valid',
      secondary: 'also-valid',
      description: null,
    } as unknown as MoodTextRepresentation;

    await expect(service.generateMoodEmbedding(invalidMood)).rejects.toThrow();
  });
});

// =====================================================
// BrandTone埋め込み生成テスト（10テスト）
// =====================================================

describe('generateBrandToneEmbedding', () => {
  let service: MoodBrandToneEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    const mockEmbedding = createMockEmbedding(123);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('BrandTone テキスト表現からEmbeddingを生成する', async () => {
    const result = await service.generateBrandToneEmbedding(sampleBrandToneTextRepresentation);

    expect(result).toBeDefined();
    expect(result.embedding).toBeDefined();
    expect(Array.isArray(result.embedding)).toBe(true);
  });

  it('768次元のベクトルを返す', async () => {
    const result = await service.generateBrandToneEmbedding(sampleBrandToneTextRepresentation);

    expect(result.embedding.length).toBe(768);
  });

  it('正規化されたベクトルを返す', async () => {
    const result = await service.generateBrandToneEmbedding(sampleBrandToneTextRepresentation);

    const norm = Math.sqrt(
      result.embedding.reduce((sum, val) => sum + val * val, 0)
    );
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('使用したテキスト表現を返す', async () => {
    const result = await service.generateBrandToneEmbedding(sampleBrandToneTextRepresentation);

    expect(result.textRepresentation).toBeDefined();
    expect(result.textRepresentation).toContain('corporate');
    expect(result.textRepresentation).toContain('innovative');
  });

  it('モデル名を返す', async () => {
    const result = await service.generateBrandToneEmbedding(sampleBrandToneTextRepresentation);

    expect(result.modelName).toBe(DEFAULT_MODEL_NAME);
  });

  it('処理時間を返す', async () => {
    const result = await service.generateBrandToneEmbedding(sampleBrandToneTextRepresentation);

    expect(result.processingTimeMs).toBeDefined();
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('BrandTone タイプを返す', async () => {
    const result = await service.generateBrandToneEmbedding(sampleBrandToneTextRepresentation);

    expect(result.type).toBe('brandTone');
  });

  it('空の BrandTone テキストでエラーをスローする', async () => {
    const emptyBrandTone: BrandToneTextRepresentation = {
      primary: '',
      secondary: '',
      description: ''
    };

    await expect(service.generateBrandToneEmbedding(emptyBrandTone)).rejects.toThrow();
  });

  it('タイムアウトでエラーをスローする', async () => {
    // 短いタイムアウト（100ms）を設定したサービスで、長時間かかる処理をテスト
    const shortTimeoutService = new MoodBrandToneEmbeddingService({
      timeout: 100, // 100msでタイムアウト
    });

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(createMockEmbedding()), 500)) // 500ms待機
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding()]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    await expect(
      shortTimeoutService.generateBrandToneEmbedding(sampleBrandToneTextRepresentation)
    ).rejects.toThrow('timed out');
  });

  it('不正な形式の BrandTone テキストでエラーをスローする', async () => {
     
    const invalidBrandTone = {
      primary: 'valid',
      secondary: 'also-valid',
      description: null,
    } as unknown as BrandToneTextRepresentation;

    await expect(service.generateBrandToneEmbedding(invalidBrandTone)).rejects.toThrow();
  });
});

// =====================================================
// バッチ処理テスト（8テスト）
// =====================================================

describe('generateBatchMoodBrandTone', () => {
  let service: MoodBrandToneEmbeddingService;
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

    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('複数の Mood 埋め込みを一括生成する', async () => {
    const moods = [sampleMoodTextRepresentation, sampleMoodTextRepresentation];
    const results = await service.generateBatchMoodEmbeddings(moods);

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
  });

  it('複数の BrandTone 埋め込みを一括生成する', async () => {
    const brandTones = [sampleBrandToneTextRepresentation, sampleBrandToneTextRepresentation];
    const results = await service.generateBatchBrandToneEmbeddings(brandTones);

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
  });

  it('100件のバッチ処理を5秒以内に完了させる', async () => {
    const moods = Array(100).fill(sampleMoodTextRepresentation);
    const manyEmbeddings = Array(100).fill(null).map((_, i) => createMockEmbedding(i));

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(() =>
        Promise.resolve(createMockEmbedding(Math.random()))
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue(manyEmbeddings),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const startTime = Date.now();
    const results = await service.generateBatchMoodEmbeddings(moods);
    const duration = Date.now() - startTime;

    expect(results.length).toBe(100);
    expect(duration).toBeLessThan(5000);
  });

  it('空配列で空配列を返す', async () => {
    const results = await service.generateBatchMoodEmbeddings([]);

    expect(results).toEqual([]);
  });

  it('1件のみでも動作する', async () => {
    const results = await service.generateBatchMoodEmbeddings([sampleMoodTextRepresentation]);

    expect(results.length).toBe(1);
    expect(results[0]?.embedding.length).toBe(768);
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

    const moods = [sampleMoodTextRepresentation, sampleMoodTextRepresentation, sampleMoodTextRepresentation];
    const results = await service.generateBatchMoodEmbeddings(moods);

    // 部分的な結果が返される（成功したものだけ）
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('進捗コールバックが呼ばれる', async () => {
    const progressCallback = vi.fn();

    const moods = [sampleMoodTextRepresentation, sampleMoodTextRepresentation];
    await service.generateBatchMoodEmbeddings(moods, { onProgress: progressCallback });

    expect(progressCallback).toHaveBeenCalled();
  });
});

// =====================================================
// 統合テスト（6テスト）
// =====================================================

describe('SectionEmbedding DB 統合テスト', () => {
  let service: MoodBrandToneEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();

    const mockEmbedding = createMockEmbedding(456);
    const mockEmbedding2 = createMockEmbedding(789);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding, mockEmbedding2]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    // Prisma client のモック（型安全なモック定義）
    interface MockPrismaClient {
      sectionEmbedding: {
        create: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
        findUnique: ReturnType<typeof vi.fn>;
      };
      $transaction: ReturnType<typeof vi.fn>;
      $executeRawUnsafe: ReturnType<typeof vi.fn>;
    }

    const mockPrisma: MockPrismaClient = {
      sectionEmbedding: {
        create: vi.fn().mockResolvedValue({
          id: 'embedding-1',
          sectionPatternId: 'section-1',
          textEmbedding: createMockEmbedding(1),
          moodTextRepresentation: 'primary: professional, secondary: minimalist',
          moodEmbedding: createMockEmbedding(2),
        }),
        update: vi.fn().mockResolvedValue({
          id: 'embedding-1',
          sectionPatternId: 'section-1',
          moodEmbedding: createMockEmbedding(2),
        }),
        upsert: vi.fn().mockResolvedValue({
          id: 'embedding-1',
          sectionPatternId: 'section-1',
          textEmbedding: createMockEmbedding(1),
          moodTextRepresentation: 'primary: professional, secondary: minimalist',
          moodEmbedding: createMockEmbedding(2),
          brandToneTextRepresentation: 'primary: innovative, secondary: trustworthy',
          brandToneEmbedding: createMockEmbedding(3),
        }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn().mockImplementation((callback: (prisma: MockPrismaClient) => Promise<unknown>) => callback(mockPrisma)),
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    };

    setPrismaClientFactory(() => mockPrisma);

    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('Mood 埋め込みを SectionEmbedding に保存する', async () => {
    const result = await service.generateMoodEmbedding(sampleMoodTextRepresentation);
    const saved = await saveMoodBrandToneEmbedding('section-1', { mood: result });

    expect(saved).toBeDefined();
    expect(saved.id).toBe('embedding-1');
  });

  it('BrandTone 埋め込みを SectionEmbedding に保存する', async () => {
    const result = await service.generateBrandToneEmbedding(sampleBrandToneTextRepresentation);
    const saved = await saveMoodBrandToneEmbedding('section-1', { brandTone: result });

    expect(saved).toBeDefined();
  });

  it('Mood と BrandTone の両方を同時に保存する', async () => {
    const moodResult = await service.generateMoodEmbedding(sampleMoodTextRepresentation);
    const brandToneResult = await service.generateBrandToneEmbedding(sampleBrandToneTextRepresentation);

    const saved = await saveMoodBrandToneEmbedding('section-1', {
      mood: moodResult,
      brandTone: brandToneResult
    });

    expect(saved).toBeDefined();
  });

  it('既存の SectionEmbedding を Mood 埋め込みで更新する', async () => {
    const moodResult = await service.generateMoodEmbedding(sampleMoodTextRepresentation);
    const updated = await saveMoodBrandToneEmbedding('existing-section-1', { mood: moodResult });

    expect(updated).toBeDefined();
  });

  it('トランザクション内で複数の埋め込みを保存する', async () => {
    const moods = [sampleMoodTextRepresentation, sampleMoodTextRepresentation];
    const results = await service.generateBatchMoodEmbeddings(moods);

    const saved = await saveBatchMoodBrandToneEmbeddings(
      ['section-1', 'section-2'],
      results.map(r => ({ mood: r }))
    );

    expect(Array.isArray(saved)).toBe(true);
    expect(saved.length).toBeGreaterThan(0);
  });

  it('保存エラー時は適切にハンドルされる', async () => {
    const mockPrisma = {
      sectionEmbedding: {
        create: vi.fn().mockRejectedValue(new Error('DB error')),
        update: vi.fn().mockRejectedValue(new Error('DB error')),
        upsert: vi.fn().mockRejectedValue(new Error('DB error')),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn().mockRejectedValue(new Error('Transaction failed')),
    };

    setPrismaClientFactory(() => mockPrisma);
    service = new MoodBrandToneEmbeddingService();

    const moodResult = await service.generateMoodEmbedding(sampleMoodTextRepresentation);

    await expect(
      saveMoodBrandToneEmbedding('section-1', { mood: moodResult })
    ).rejects.toThrow();
  });
});

// =====================================================
// エラーハンドリングテスト（5テスト）
// =====================================================

describe('エラーハンドリング', () => {
  let service: MoodBrandToneEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('Embedding サービスのタイムアウトをキャッチする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockRejectedValue(new Error('Request timeout')),
      generateBatchEmbeddings: vi.fn().mockRejectedValue(new Error('Request timeout')),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new MoodBrandToneEmbeddingService();

    await expect(
      service.generateMoodEmbedding(sampleMoodTextRepresentation)
    ).rejects.toThrow();
  });

  it('不正な Embedding 結果をバリデートする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue([]), // 空のEmbedding
      generateBatchEmbeddings: vi.fn().mockResolvedValue([[]]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new MoodBrandToneEmbeddingService();

    await expect(
      service.generateMoodEmbedding(sampleMoodTextRepresentation)
    ).rejects.toThrow();
  });

  it('Embedding が正規化されていない場合はエラーをスローする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(Array(768).fill(1)), // 正規化されていない
      generateBatchEmbeddings: vi.fn().mockResolvedValue([Array(768).fill(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    // normalize: false でサービスを作成（正規化をスキップしてバリデーションエラーを発生させる）
    service = new MoodBrandToneEmbeddingService({ normalize: false });

    await expect(
      service.generateMoodEmbedding(sampleMoodTextRepresentation)
    ).rejects.toThrow();
  });

  it('null または undefined の入力をバリデートする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding()),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding()]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new MoodBrandToneEmbeddingService();

     
    await expect(
      service.generateMoodEmbedding(null as unknown as MoodTextRepresentation)
    ).rejects.toThrow();
  });

  it('Prisma transaction のロールバックをハンドルする', async () => {
    const mockPrisma = {
      sectionEmbedding: {
        create: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn().mockRejectedValue(new Error('Transaction rolled back')),
    };

    setPrismaClientFactory(() => mockPrisma);

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding()),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding()]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new MoodBrandToneEmbeddingService();
    const moodResult = await service.generateMoodEmbedding(sampleMoodTextRepresentation);

    await expect(
      saveMoodBrandToneEmbedding('section-1', { mood: moodResult })
    ).rejects.toThrow();
  });
});
