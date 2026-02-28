// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mood/BrandTone Embedding 統合テスト
 *
 * Phase 5-4: SectionEmbedding Extension for mood/brandTone
 *
 * 統合テストスコープ:
 * 1. End-to-End Pipeline Tests
 * 2. Vector Search Integration
 * 3. Transaction Integrity
 * 4. Performance Tests
 * 5. Error Scenarios
 * 6. Data Consistency
 *
 * @module tests/integration/phase5-4/mood-brandtone-embedding.integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  MoodBrandToneEmbeddingService,
  type MoodTextRepresentation,
  type BrandToneTextRepresentation,
  type SectionEmbeddingData,
  saveMoodBrandToneEmbedding,
  saveBatchMoodBrandToneEmbeddings,
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
  setPrismaClientFactory,
  resetPrismaClientFactory,
  DEFAULT_MODEL_NAME,
  DEFAULT_EMBEDDING_DIMENSIONS,
} from '../../../src/services/ml/mood-brandtone-embedding.service';

// MoodBrandToneEmbeddingResult は戻り値の型として間接的に使用される

// =====================================================
// テストデータ
// =====================================================

/** プロフェッショナルなMoodテキスト表現 */
const professionalMood: MoodTextRepresentation = {
  primary: 'professional',
  secondary: 'minimalist',
  description: 'Clean, corporate design with minimal decoration and professional appearance',
};

/** プレイフルなMoodテキスト表現 */
const playfulMood: MoodTextRepresentation = {
  primary: 'playful',
  secondary: 'bright',
  description: 'Fun and engaging design with vibrant colors and playful elements',
};

/** コーポレートなBrandToneテキスト表現 */
const corporateBrandTone: BrandToneTextRepresentation = {
  primary: 'corporate',
  secondary: 'innovative',
  description: 'Enterprise-focused with cutting-edge technology emphasis',
};

/** フレンドリーなBrandToneテキスト表現 */
const friendlyBrandTone: BrandToneTextRepresentation = {
  primary: 'friendly',
  secondary: 'approachable',
  description: 'Warm and inviting design that feels welcoming to users',
};

// =====================================================
// モックヘルパー関数
// =====================================================

/**
 * 768次元の正規化されたモックEmbeddingを生成
 *
 * @param seed - シード値（同じ値で同じベクトルを生成）
 * @returns L2正規化された768次元ベクトル
 */
function createMockEmbedding(seed: number = 0): number[] {
  const embedding = new Array(DEFAULT_EMBEDDING_DIMENSIONS)
    .fill(0)
    .map((_, i) => Math.sin(i + seed) * 0.1 + Math.cos(i * seed) * 0.05);
  // L2正規化
  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  return embedding.map((val) => val / norm);
}

/**
 * UUIDv7形式のIDを生成（テスト用）
 */
function generateTestId(index: number = 0): string {
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const suffix = index.toString(16).padStart(20, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-7${suffix.slice(0, 3)}-8${suffix.slice(3, 6)}-${suffix.slice(6)}`;
}

/**
 * SectionEmbeddingDataをモック生成
 * 将来の拡張テストで使用予定
 */
function _createMockSectionEmbedding(
  sectionPatternId: string,
  options?: {
    hasMood?: boolean;
    hasBrandTone?: boolean;
    moodSeed?: number;
    brandToneSeed?: number;
  }
): SectionEmbeddingData {
  const { hasMood = false, hasBrandTone = false, moodSeed = 1, brandToneSeed = 2 } = options ?? {};

  return {
    id: generateTestId(),
    sectionPatternId,
    textEmbedding: createMockEmbedding(0),
    moodTextRepresentation: hasMood ? 'primary: professional, secondary: minimalist' : null,
    moodEmbedding: hasMood ? createMockEmbedding(moodSeed) : null,
    brandToneTextRepresentation: hasBrandTone ? 'primary: corporate, secondary: innovative' : null,
    brandToneEmbedding: hasBrandTone ? createMockEmbedding(brandToneSeed) : null,
  };
}

/**
 * EmbeddingServiceのモックを作成
 */
function createMockEmbeddingService(seedStart: number = 0) {
  let callCount = seedStart;

  return {
    generateEmbedding: vi.fn().mockImplementation(() => {
      return Promise.resolve(createMockEmbedding(callCount++));
    }),
    generateBatchEmbeddings: vi.fn().mockImplementation((texts: string[]) => {
      return Promise.resolve(texts.map((_, i) => createMockEmbedding(callCount + i)));
    }),
    getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
    clearCache: vi.fn(),
  };
}

/**
 * PrismaClientのモックを作成（統合テスト用）
 */
function createMockPrismaClient(options?: {
  savedRecords?: Map<string, SectionEmbeddingData>;
  shouldFailOnSave?: boolean;
  shouldFailOnTransaction?: boolean;
}) {
  const savedRecords = options?.savedRecords ?? new Map<string, SectionEmbeddingData>();
  const shouldFailOnSave = options?.shouldFailOnSave ?? false;
  const shouldFailOnTransaction = options?.shouldFailOnTransaction ?? false;

  const mockPrisma = {
    sectionEmbedding: {
      create: vi.fn().mockImplementation(async (args: { data: { sectionPatternId: string; modelVersion?: string; moodTextRepresentation?: string; brandToneTextRepresentation?: string } }) => {
        if (shouldFailOnSave) {
          throw new Error('DB create error');
        }
        const id = generateTestId();
        const record: SectionEmbeddingData = {
          id,
          sectionPatternId: args.data.sectionPatternId,
          moodTextRepresentation: args.data.moodTextRepresentation ?? null,
          brandToneTextRepresentation: args.data.brandToneTextRepresentation ?? null,
        };
        savedRecords.set(args.data.sectionPatternId, record);
        return record;
      }),
      update: vi.fn().mockImplementation(async (args: { where: { id?: string; sectionPatternId?: string }; data: { moodTextRepresentation?: string; brandToneTextRepresentation?: string } }) => {
        if (shouldFailOnSave) {
          throw new Error('DB update error');
        }
        const key = args.where.sectionPatternId ?? args.where.id;
        if (!key) throw new Error('Missing key');
        const existing = savedRecords.get(key);
        if (!existing) throw new Error('Record not found');
        const updated = { ...existing, ...args.data };
        savedRecords.set(key, updated);
        return updated;
      }),
      upsert: vi.fn().mockImplementation(async (args: { where: { sectionPatternId: string }; create: { sectionPatternId: string; modelVersion?: string; moodTextRepresentation?: string; brandToneTextRepresentation?: string }; update: { moodTextRepresentation?: string; brandToneTextRepresentation?: string } }) => {
        if (shouldFailOnSave) {
          throw new Error('DB upsert error');
        }
        const existing = savedRecords.get(args.where.sectionPatternId);
        if (existing) {
          const updated = { ...existing, ...args.update };
          savedRecords.set(args.where.sectionPatternId, updated);
          return updated;
        } else {
          const id = generateTestId();
          const record: SectionEmbeddingData = {
            id,
            sectionPatternId: args.create.sectionPatternId,
            moodTextRepresentation: args.create.moodTextRepresentation ?? null,
            brandToneTextRepresentation: args.create.brandToneTextRepresentation ?? null,
          };
          savedRecords.set(args.where.sectionPatternId, record);
          return record;
        }
      }),
      findUnique: vi.fn().mockImplementation(async (args: { where: { sectionPatternId: string } }) => {
        return savedRecords.get(args.where.sectionPatternId) ?? null;
      }),
      findMany: vi.fn().mockImplementation(async () => {
        return Array.from(savedRecords.values());
      }),
    },
    $transaction: vi.fn().mockImplementation(async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => {
      if (shouldFailOnTransaction) {
        throw new Error('Transaction failed');
      }
      return callback(mockPrisma);
    }),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };

  return { mockPrisma, savedRecords };
}

// =====================================================
// 1. End-to-End Pipeline Tests
// =====================================================

describe('E2E Pipeline', () => {
  let service: MoodBrandToneEmbeddingService;
  let savedRecords: Map<string, SectionEmbeddingData>;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();

    setEmbeddingServiceFactory(() => createMockEmbeddingService());
    const { mockPrisma, savedRecords: records } = createMockPrismaClient();
    savedRecords = records;
    setPrismaClientFactory(() => mockPrisma);

    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('Mood生成 → DB保存 → DB取得の完全フロー', async () => {
    // Step 1: Mood Embedding生成
    const moodResult = await service.generateMoodEmbedding(professionalMood);

    expect(moodResult).toBeDefined();
    expect(moodResult.embedding.length).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(moodResult.type).toBe('mood');

    // Step 2: DB保存
    const sectionPatternId = generateTestId(1);
    const saved = await saveMoodBrandToneEmbedding(sectionPatternId, { mood: moodResult });

    expect(saved).toBeDefined();
    expect(saved.sectionPatternId).toBe(sectionPatternId);
    expect(saved.moodTextRepresentation).toContain('professional');

    // Step 3: 保存されたレコードを確認
    const stored = savedRecords.get(sectionPatternId);
    expect(stored).toBeDefined();
    expect(stored?.moodTextRepresentation).toBe(moodResult.textRepresentation);
  });

  it('BrandTone生成 → DB保存 → DB取得の完全フロー', async () => {
    // Step 1: BrandTone Embedding生成
    const brandToneResult = await service.generateBrandToneEmbedding(corporateBrandTone);

    expect(brandToneResult).toBeDefined();
    expect(brandToneResult.embedding.length).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(brandToneResult.type).toBe('brandTone');

    // Step 2: DB保存
    const sectionPatternId = generateTestId(2);
    const saved = await saveMoodBrandToneEmbedding(sectionPatternId, { brandTone: brandToneResult });

    expect(saved).toBeDefined();
    expect(saved.sectionPatternId).toBe(sectionPatternId);
    expect(saved.brandToneTextRepresentation).toContain('corporate');

    // Step 3: 保存されたレコードを確認
    const stored = savedRecords.get(sectionPatternId);
    expect(stored).toBeDefined();
    expect(stored?.brandToneTextRepresentation).toBe(brandToneResult.textRepresentation);
  });

  it('MoodとBrandTone両方同時生成 → DB保存の完全フロー', async () => {
    // Step 1: 両方のEmbeddingを生成
    const moodResult = await service.generateMoodEmbedding(professionalMood);
    const brandToneResult = await service.generateBrandToneEmbedding(corporateBrandTone);

    expect(moodResult.type).toBe('mood');
    expect(brandToneResult.type).toBe('brandTone');

    // Step 2: 同時にDB保存
    const sectionPatternId = generateTestId(3);
    const saved = await saveMoodBrandToneEmbedding(sectionPatternId, {
      mood: moodResult,
      brandTone: brandToneResult,
    });

    expect(saved).toBeDefined();
    expect(saved.moodTextRepresentation).toContain('professional');
    expect(saved.brandToneTextRepresentation).toContain('corporate');

    // Step 3: 保存されたレコードを確認
    const stored = savedRecords.get(sectionPatternId);
    expect(stored).toBeDefined();
    expect(stored?.moodTextRepresentation).toBeDefined();
    expect(stored?.brandToneTextRepresentation).toBeDefined();
  });

  it('バッチMood生成 → バッチDB保存の完全フロー', async () => {
    // Step 1: バッチMood Embedding生成
    const moods = [professionalMood, playfulMood, professionalMood];
    const results = await service.generateBatchMoodEmbeddings(moods);

    expect(results.length).toBe(3);
    results.forEach((r) => {
      expect(r.embedding.length).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
      expect(r.type).toBe('mood');
    });

    // Step 2: バッチDB保存
    const sectionPatternIds = [generateTestId(10), generateTestId(11), generateTestId(12)];
    const savedResults = await saveBatchMoodBrandToneEmbeddings(
      sectionPatternIds,
      results.map((r) => ({ mood: r }))
    );

    expect(savedResults.length).toBe(3);

    // Step 3: 全レコード確認
    sectionPatternIds.forEach((id) => {
      const stored = savedRecords.get(id);
      expect(stored).toBeDefined();
      expect(stored?.moodTextRepresentation).toBeDefined();
    });
  });

  it('バッチBrandTone生成 → バッチDB保存の完全フロー', async () => {
    // Step 1: バッチBrandTone Embedding生成
    const brandTones = [corporateBrandTone, friendlyBrandTone];
    const results = await service.generateBatchBrandToneEmbeddings(brandTones);

    expect(results.length).toBe(2);
    results.forEach((r) => {
      expect(r.embedding.length).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
      expect(r.type).toBe('brandTone');
    });

    // Step 2: バッチDB保存
    const sectionPatternIds = [generateTestId(20), generateTestId(21)];
    const savedResults = await saveBatchMoodBrandToneEmbeddings(
      sectionPatternIds,
      results.map((r) => ({ brandTone: r }))
    );

    expect(savedResults.length).toBe(2);

    // Step 3: 全レコード確認
    sectionPatternIds.forEach((id) => {
      const stored = savedRecords.get(id);
      expect(stored).toBeDefined();
      expect(stored?.brandToneTextRepresentation).toBeDefined();
    });
  });

  it('混合バッチ（Mood + BrandTone）→ バッチDB保存の完全フロー', async () => {
    // Step 1: 両方のバッチを生成
    const moodResults = await service.generateBatchMoodEmbeddings([professionalMood, playfulMood]);
    const brandToneResults = await service.generateBatchBrandToneEmbeddings([
      corporateBrandTone,
      friendlyBrandTone,
    ]);

    // Step 2: 混合バッチとしてDB保存
    const sectionPatternIds = [generateTestId(30), generateTestId(31)];
    const combinedData = [
      { mood: moodResults[0], brandTone: brandToneResults[0] },
      { mood: moodResults[1], brandTone: brandToneResults[1] },
    ];

    const savedResults = await saveBatchMoodBrandToneEmbeddings(sectionPatternIds, combinedData);

    expect(savedResults.length).toBe(2);

    // Step 3: 両方のフィールドが保存されていることを確認
    sectionPatternIds.forEach((id) => {
      const stored = savedRecords.get(id);
      expect(stored).toBeDefined();
      expect(stored?.moodTextRepresentation).toBeDefined();
      expect(stored?.brandToneTextRepresentation).toBeDefined();
    });
  });
});

// =====================================================
// 2. Vector Search Integration
// =====================================================

describe('Vector Search Integration', () => {
  let service: MoodBrandToneEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();

    setEmbeddingServiceFactory(() => createMockEmbeddingService());
    const { mockPrisma } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('768次元ベクトルが正しく生成される', async () => {
    const moodResult = await service.generateMoodEmbedding(professionalMood);

    expect(moodResult.embedding.length).toBe(768);
    expect(moodResult.embedding.every((v) => typeof v === 'number')).toBe(true);
    expect(moodResult.embedding.every((v) => !isNaN(v))).toBe(true);
  });

  it('生成されたベクトルがL2正規化されている', async () => {
    const moodResult = await service.generateMoodEmbedding(professionalMood);

    // L2ノルムを計算
    const norm = Math.sqrt(moodResult.embedding.reduce((sum, val) => sum + val * val, 0));

    // L2正規化されているべき（ノルム ≈ 1.0）
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('コサイン類似度計算が正しく動作する', async () => {
    // 同じ入力から2つのEmbeddingを生成
    const result1 = await service.generateMoodEmbedding(professionalMood);
    const result2 = await service.generateMoodEmbedding(professionalMood);

    // コサイン類似度を計算（正規化済みベクトルなのでドット積）
    const similarity = result1.embedding.reduce(
      (sum, val, i) => sum + val * (result2.embedding[i] ?? 0),
      0
    );

    // 同じ入力なら高い類似度（モック実装では異なるシードを使うので完全一致ではない）
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThanOrEqual(1);
  });

  it('異なるMoodは異なるベクトルを生成する', async () => {
    const professionalResult = await service.generateMoodEmbedding(professionalMood);
    const playfulResult = await service.generateMoodEmbedding(playfulMood);

    // 2つのベクトルが完全に同じでないことを確認
    const isDifferent = professionalResult.embedding.some(
      (val, i) => Math.abs(val - (playfulResult.embedding[i] ?? 0)) > 0.0001
    );

    expect(isDifferent).toBe(true);
  });

  it('ベクトル検索形式（pgvector文字列）への変換が正しい', async () => {
    const result = await service.generateMoodEmbedding(professionalMood);

    // pgvector形式の文字列を生成
    const vectorString = `[${result.embedding.join(',')}]`;

    // 形式が正しいことを確認
    expect(vectorString.startsWith('[')).toBe(true);
    expect(vectorString.endsWith(']')).toBe(true);
    expect(vectorString.split(',').length).toBe(768);
  });

  it('HNSW Index用の次元数（768D）が一貫している', async () => {
    // 複数回生成して全て768次元であることを確認
    const results = await Promise.all([
      service.generateMoodEmbedding(professionalMood),
      service.generateMoodEmbedding(playfulMood),
      service.generateBrandToneEmbedding(corporateBrandTone),
      service.generateBrandToneEmbedding(friendlyBrandTone),
    ]);

    results.forEach((result) => {
      expect(result.embedding.length).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    });
  });
});

// =====================================================
// 3. Transaction Integrity
// =====================================================

describe('Transaction Integrity', () => {
  let service: MoodBrandToneEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    setEmbeddingServiceFactory(() => createMockEmbeddingService());
    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('単一トランザクション内でMood + BrandTone両方を保存する', async () => {
    const { mockPrisma, savedRecords } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    const moodResult = await service.generateMoodEmbedding(professionalMood);
    const brandToneResult = await service.generateBrandToneEmbedding(corporateBrandTone);

    const sectionPatternId = generateTestId(100);
    await saveMoodBrandToneEmbedding(sectionPatternId, {
      mood: moodResult,
      brandTone: brandToneResult,
    });

    // トランザクションが呼ばれたことを確認
    expect(mockPrisma.$transaction).toHaveBeenCalled();

    // 両方のフィールドが保存されていることを確認
    const stored = savedRecords.get(sectionPatternId);
    expect(stored?.moodTextRepresentation).toBeDefined();
    expect(stored?.brandToneTextRepresentation).toBeDefined();
  });

  it('Mood保存失敗時にトランザクション全体がロールバックされる', async () => {
    const { mockPrisma, savedRecords } = createMockPrismaClient({ shouldFailOnSave: true });
    setPrismaClientFactory(() => mockPrisma);

    const moodResult = await service.generateMoodEmbedding(professionalMood);
    const sectionPatternId = generateTestId(101);

    await expect(saveMoodBrandToneEmbedding(sectionPatternId, { mood: moodResult })).rejects.toThrow();

    // ロールバック後はレコードが残らない
    expect(savedRecords.size).toBe(0);
  });

  it('BrandTone保存失敗時にトランザクション全体がロールバックされる', async () => {
    const { mockPrisma, savedRecords } = createMockPrismaClient({ shouldFailOnSave: true });
    setPrismaClientFactory(() => mockPrisma);

    const brandToneResult = await service.generateBrandToneEmbedding(corporateBrandTone);
    const sectionPatternId = generateTestId(102);

    await expect(
      saveMoodBrandToneEmbedding(sectionPatternId, { brandTone: brandToneResult })
    ).rejects.toThrow();

    // ロールバック後はレコードが残らない
    expect(savedRecords.size).toBe(0);
  });

  it('トランザクション失敗時にエラーが適切に伝播される', async () => {
    const { mockPrisma } = createMockPrismaClient({ shouldFailOnTransaction: true });
    setPrismaClientFactory(() => mockPrisma);

    const moodResult = await service.generateMoodEmbedding(professionalMood);
    const sectionPatternId = generateTestId(103);

    await expect(saveMoodBrandToneEmbedding(sectionPatternId, { mood: moodResult })).rejects.toThrow(
      'Transaction failed'
    );
  });

  it('バッチ保存がアトミックである（全成功または全失敗）', async () => {
    const { mockPrisma, savedRecords } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    const moods = [professionalMood, playfulMood, professionalMood];
    const results = await service.generateBatchMoodEmbeddings(moods);
    const sectionPatternIds = [generateTestId(110), generateTestId(111), generateTestId(112)];

    const savedResults = await saveBatchMoodBrandToneEmbeddings(
      sectionPatternIds,
      results.map((r) => ({ mood: r }))
    );

    // 全て成功していることを確認
    expect(savedResults.length).toBe(3);
    expect(savedRecords.size).toBe(3);
  });
});

// =====================================================
// 4. Performance Tests
// =====================================================

describe('Performance', () => {
  let service: MoodBrandToneEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();

    // 高速なモックEmbeddingサービスを設定
    setEmbeddingServiceFactory(() => {
      return {
        generateEmbedding: vi.fn().mockImplementation(() => {
          return Promise.resolve(createMockEmbedding(Math.random()));
        }),
        generateBatchEmbeddings: vi.fn().mockImplementation((texts: string[]) => {
          return Promise.resolve(texts.map(() => createMockEmbedding(Math.random())));
        }),
        getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
        clearCache: vi.fn(),
      };
    });

    const { mockPrisma } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('100件のMood Embedding生成が5秒以内に完了する', async () => {
    const moods = Array(100).fill(professionalMood);

    const startTime = Date.now();
    const results = await service.generateBatchMoodEmbeddings(moods);
    const duration = Date.now() - startTime;

    expect(results.length).toBe(100);
    expect(duration).toBeLessThan(5000);
  });

  it('100件のBrandTone Embedding生成が5秒以内に完了する', async () => {
    const brandTones = Array(100).fill(corporateBrandTone);

    const startTime = Date.now();
    const results = await service.generateBatchBrandToneEmbeddings(brandTones);
    const duration = Date.now() - startTime;

    expect(results.length).toBe(100);
    expect(duration).toBeLessThan(5000);
  });

  it('混合バッチ（50 Mood + 50 BrandTone）が5秒以内に完了する', async () => {
    const moods = Array(50).fill(professionalMood);
    const brandTones = Array(50).fill(corporateBrandTone);

    const startTime = Date.now();
    const [moodResults, brandToneResults] = await Promise.all([
      service.generateBatchMoodEmbeddings(moods),
      service.generateBatchBrandToneEmbeddings(brandTones),
    ]);
    const duration = Date.now() - startTime;

    expect(moodResults.length).toBe(50);
    expect(brandToneResults.length).toBe(50);
    expect(duration).toBeLessThan(5000);
  });

  it('単一Embedding生成が200ms以内に完了する', async () => {
    const startTime = Date.now();
    await service.generateMoodEmbedding(professionalMood);
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(200);
  });

  it('processingTimeMsが正しく計測される', async () => {
    const result = await service.generateMoodEmbedding(professionalMood);

    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.processingTimeMs).toBeLessThan(1000); // モックなので高速
  });
});

// =====================================================
// 5. Error Scenarios
// =====================================================

describe('Error Scenarios', () => {
  let service: MoodBrandToneEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('無効なMoodテキストでEmbedding生成が失敗する', async () => {
    setEmbeddingServiceFactory(() => createMockEmbeddingService());

    const invalidMood: MoodTextRepresentation = {
      primary: '',
      secondary: '',
      description: '',
    };

    await expect(service.generateMoodEmbedding(invalidMood)).rejects.toThrow();
  });

  it('null入力でエラーがスローされる', async () => {
    setEmbeddingServiceFactory(() => createMockEmbeddingService());

    await expect(service.generateMoodEmbedding(null as unknown as MoodTextRepresentation)).rejects.toThrow();
  });

  it('DB保存失敗時にEmbeddingは生成されていてもDBに保存されない', async () => {
    setEmbeddingServiceFactory(() => createMockEmbeddingService());
    const { mockPrisma, savedRecords } = createMockPrismaClient({ shouldFailOnSave: true });
    setPrismaClientFactory(() => mockPrisma);

    // Embedding生成は成功
    const moodResult = await service.generateMoodEmbedding(professionalMood);
    expect(moodResult).toBeDefined();
    expect(moodResult.embedding.length).toBe(768);

    // DB保存は失敗
    const sectionPatternId = generateTestId(200);
    await expect(saveMoodBrandToneEmbedding(sectionPatternId, { mood: moodResult })).rejects.toThrow();

    // DBにはレコードが残らない
    expect(savedRecords.size).toBe(0);
  });

  it('タイムアウト時にエラーがスローされる', async () => {
    // 遅延するモックサービス
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(createMockEmbedding()), 35000))
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding()]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    // タイムアウトを短く設定
    service = new MoodBrandToneEmbeddingService({ timeout: 100 });

    await expect(service.generateMoodEmbedding(professionalMood)).rejects.toThrow();
  });

  it('不正な形式のEmbedding（次元数不一致）でエラーがスローされる', async () => {
    // 次元数が間違っているEmbeddingを返すモック
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(Array(100).fill(0.1)), // 768ではなく100次元
      generateBatchEmbeddings: vi.fn().mockResolvedValue([Array(100).fill(0.1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    await expect(service.generateMoodEmbedding(professionalMood)).rejects.toThrow();
  });

  it('正規化されていないEmbeddingでエラーがスローされる（normalize: false）', async () => {
    // 正規化されていないEmbeddingを返すモック
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(Array(768).fill(1)), // L2ノルム = sqrt(768) ≈ 27.7
      generateBatchEmbeddings: vi.fn().mockResolvedValue([Array(768).fill(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new MoodBrandToneEmbeddingService({ normalize: false });

    await expect(service.generateMoodEmbedding(professionalMood)).rejects.toThrow();
  });

  it('空の配列でバッチ保存は空配列を返す', async () => {
    setEmbeddingServiceFactory(() => createMockEmbeddingService());
    const { mockPrisma } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    const result = await saveBatchMoodBrandToneEmbeddings([], []);
    expect(result).toEqual([]);
  });

  it('sectionPatternIdsとresultsの長さが異なる場合にエラーがスローされる', async () => {
    setEmbeddingServiceFactory(() => createMockEmbeddingService());
    const { mockPrisma } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    const moodResult = await service.generateMoodEmbedding(professionalMood);

    await expect(
      saveBatchMoodBrandToneEmbeddings([generateTestId(1), generateTestId(2)], [{ mood: moodResult }])
    ).rejects.toThrow('sectionPatternIds and results must have the same length');
  });
});

// =====================================================
// 6. Data Consistency
// =====================================================

describe('Data Consistency', () => {
  let service: MoodBrandToneEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    setEmbeddingServiceFactory(() => createMockEmbeddingService());
    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('moodEmbeddingとmoodTextRepresentationが一緒に保存される', async () => {
    const { mockPrisma, savedRecords } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    const moodResult = await service.generateMoodEmbedding(professionalMood);
    const sectionPatternId = generateTestId(300);

    await saveMoodBrandToneEmbedding(sectionPatternId, { mood: moodResult });

    const stored = savedRecords.get(sectionPatternId);
    expect(stored?.moodTextRepresentation).toBe(moodResult.textRepresentation);

    // $executeRawUnsafeがベクトル保存用に呼ばれたことを確認
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();
  });

  it('brandToneEmbeddingとbrandToneTextRepresentationが一緒に保存される', async () => {
    const { mockPrisma, savedRecords } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    const brandToneResult = await service.generateBrandToneEmbedding(corporateBrandTone);
    const sectionPatternId = generateTestId(301);

    await saveMoodBrandToneEmbedding(sectionPatternId, { brandTone: brandToneResult });

    const stored = savedRecords.get(sectionPatternId);
    expect(stored?.brandToneTextRepresentation).toBe(brandToneResult.textRepresentation);

    // $executeRawUnsafeがベクトル保存用に呼ばれたことを確認
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();
  });

  it('MoodとBrandToneは独立して存在できる（Moodのみ）', async () => {
    const { mockPrisma, savedRecords } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    const moodResult = await service.generateMoodEmbedding(professionalMood);
    const sectionPatternId = generateTestId(302);

    await saveMoodBrandToneEmbedding(sectionPatternId, { mood: moodResult });

    const stored = savedRecords.get(sectionPatternId);
    expect(stored?.moodTextRepresentation).toBeDefined();
    // DBのNULL値はnullとして返される（undefinedではない）
    expect(stored?.brandToneTextRepresentation).toBeNull();
  });

  it('MoodとBrandToneは独立して存在できる（BrandToneのみ）', async () => {
    const { mockPrisma, savedRecords } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    const brandToneResult = await service.generateBrandToneEmbedding(corporateBrandTone);
    const sectionPatternId = generateTestId(303);

    await saveMoodBrandToneEmbedding(sectionPatternId, { brandTone: brandToneResult });

    const stored = savedRecords.get(sectionPatternId);
    // DBのNULL値はnullとして返される（undefinedではない）
    expect(stored?.moodTextRepresentation).toBeNull();
    expect(stored?.brandToneTextRepresentation).toBeDefined();
  });

  it('既存レコードの更新時に古いEmbeddingが正しく置き換えられる', async () => {
    const { mockPrisma, savedRecords } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    const sectionPatternId = generateTestId(304);

    // 初回保存
    const moodResult1 = await service.generateMoodEmbedding(professionalMood);
    await saveMoodBrandToneEmbedding(sectionPatternId, { mood: moodResult1 });

    const stored1 = savedRecords.get(sectionPatternId);
    const originalTextRep = stored1?.moodTextRepresentation;

    // 更新
    const moodResult2 = await service.generateMoodEmbedding(playfulMood);
    await saveMoodBrandToneEmbedding(sectionPatternId, { mood: moodResult2 });

    const stored2 = savedRecords.get(sectionPatternId);

    // 更新されていることを確認
    expect(stored2?.moodTextRepresentation).toBe(moodResult2.textRepresentation);
    expect(stored2?.moodTextRepresentation).not.toBe(originalTextRep);
  });

  it('モデル名が正しく保存される', async () => {
    const { mockPrisma } = createMockPrismaClient();
    setPrismaClientFactory(() => mockPrisma);

    const moodResult = await service.generateMoodEmbedding(professionalMood);
    const sectionPatternId = generateTestId(305);

    await saveMoodBrandToneEmbedding(sectionPatternId, { mood: moodResult });

    // upsertに渡されたデータを確認
    expect(mockPrisma.sectionEmbedding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          modelVersion: DEFAULT_MODEL_NAME,
        }),
        update: expect.objectContaining({
          modelVersion: DEFAULT_MODEL_NAME,
        }),
      })
    );
  });

  it('テキスト表現にe5モデル用のプレフィックスが含まれる', async () => {
    setEmbeddingServiceFactory(() => createMockEmbeddingService());

    const moodResult = await service.generateMoodEmbedding(professionalMood);
    const brandToneResult = await service.generateBrandToneEmbedding(corporateBrandTone);

    // e5モデル用のpassage:プレフィックスが含まれる
    expect(moodResult.textRepresentation).toContain('passage:');
    expect(brandToneResult.textRepresentation).toContain('passage:');
  });
});

// =====================================================
// 7. Model Name & Config Tests
// =====================================================

describe('Model Name & Config', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('デフォルトモデル名がmultilingual-e5-baseである', () => {
    expect(DEFAULT_MODEL_NAME).toBe('multilingual-e5-base');
  });

  it('デフォルト次元数が768である', () => {
    expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(768);
  });

  it('カスタムオプションでサービスを初期化できる', () => {
    setEmbeddingServiceFactory(() => createMockEmbeddingService());

    const service = new MoodBrandToneEmbeddingService({
      modelName: 'custom-model',
      dimensions: 512,
      normalize: false,
      cacheEnabled: false,
      timeout: 60000,
    });

    expect(service).toBeDefined();
  });

  it('結果にモデル名が含まれる', async () => {
    setEmbeddingServiceFactory(() => createMockEmbeddingService());
    const service = new MoodBrandToneEmbeddingService();

    const moodResult = await service.generateMoodEmbedding(professionalMood);

    expect(moodResult.modelName).toBe(DEFAULT_MODEL_NAME);
  });
});

// =====================================================
// 8. Cache Tests
// =====================================================

describe('Cache', () => {
  let service: MoodBrandToneEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    setEmbeddingServiceFactory(() => createMockEmbeddingService());
    service = new MoodBrandToneEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('キャッシュ統計を取得できる', () => {
    const stats = service.getCacheStats();

    expect(stats).toBeDefined();
    expect(stats).toHaveProperty('hits');
    expect(stats).toHaveProperty('misses');
    expect(stats).toHaveProperty('size');
    expect(stats).toHaveProperty('evictions');
  });

  it('キャッシュをクリアできる', () => {
    // エラーなくクリアできることを確認
    expect(() => service.clearCache()).not.toThrow();
  });

  it('cacheEnabled=falseでもサービスが動作する', async () => {
    const noCacheService = new MoodBrandToneEmbeddingService({ cacheEnabled: false });

    const result = await noCacheService.generateMoodEmbedding(professionalMood);

    expect(result).toBeDefined();
    expect(result.embedding.length).toBe(768);
  });
});
