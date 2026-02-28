// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FrameEmbeddingService テスト
 * VideoModeで取得したフレーム解析結果（FrameImageAnalysisOutput）から
 * Embeddingを生成し、DBに保存するサービスのテスト
 *
 * TDD Red Phase: 失敗するテストを先に作成
 *
 * テストカバレッジ:
 * - 定数・型定義（2テスト）
 * - コンストラクタ（4テスト）
 * - AnimationZone → テキスト表現変換（6テスト）
 * - MotionVectorInfo → テキスト表現変換（5テスト）
 * - FrameImageAnalysisOutput → テキスト表現変換（5テスト）
 * - generateFromAnimationZone（6テスト）- 単体
 * - generateFromMotionVector（5テスト）- 単体
 * - generateFromAnimationZones（6テスト）- 配列バッチ処理
 * - generateFromMotionVectors（5テスト）- 配列バッチ処理
 * - generateFromAnalysis（7テスト）- 統合結果
 * - バッチ処理（5テスト）
 * - パフォーマンス（3テスト）
 * - 類似度計算（4テスト）
 * - DB保存連携（6テスト）
 * - エラーハンドリング（5テスト）
 * - キャッシュ機構（4テスト）
 *
 * @module tests/services/motion/frame-embedding.service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AnimationZone,
  MotionVectorInfo,
  FrameImageAnalysisOutput,
  AnimationType,
  MotionDirection,
} from '../../../src/services/motion/frame-image-analyzer.adapter';
import {
  FrameEmbeddingService,
  animationZoneToText,
  motionVectorToText,
  frameAnalysisToText,
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
  setPrismaClientFactory,
  resetPrismaClientFactory,
  saveMotionEmbedding,
  saveFrameAnalysisWithEmbeddings,
  DEFAULT_MODEL_NAME,
  DEFAULT_EMBEDDING_DIMENSIONS,
  type FrameEmbeddingResult,
  type EmbeddingResult,
  type IEmbeddingService,
  type IPrismaClient,
} from '../../../src/services/motion/frame-embedding.service';

// =====================================================
// テストデータ
// =====================================================

const sampleAnimationZone: AnimationZone = {
  frameStart: 'frame-0000.png',
  frameEnd: 'frame-0050.png',
  scrollStart: 500,
  scrollEnd: 1200,
  duration: 700,
  avgDiff: '15.5',
  peakDiff: '28.3',
  animationType: 'fade/slide transition',
};

const sampleMicroInteraction: AnimationZone = {
  frameStart: 'frame-0100.png',
  frameEnd: 'frame-0120.png',
  scrollStart: 100,
  scrollEnd: 400,
  duration: 300,
  avgDiff: '5.2',
  peakDiff: '12.1',
  animationType: 'micro-interaction',
};

const sampleScrollLinkedAnimation: AnimationZone = {
  frameStart: 'frame-0200.png',
  frameEnd: 'frame-0400.png',
  scrollStart: 1500,
  scrollEnd: 3500,
  duration: 2000,
  avgDiff: '22.8',
  peakDiff: '45.6',
  animationType: 'scroll-linked animation',
};

const sampleLongFormReveal: AnimationZone = {
  frameStart: 'frame-0500.png',
  frameEnd: 'frame-1000.png',
  scrollStart: 3000,
  scrollEnd: 7500,
  duration: 4500,
  avgDiff: '18.3',
  peakDiff: '35.7',
  animationType: 'long-form reveal',
};

const sampleMotionVectorDown: MotionVectorInfo = {
  frameRange: 'frame-0010.png - frame-0020.png',
  dx: 0,
  dy: 120,
  magnitude: '120.00',
  direction: 'down',
  angle: '90.00',
};

const sampleMotionVectorRight: MotionVectorInfo = {
  frameRange: 'frame-0030.png - frame-0040.png',
  dx: 85,
  dy: 0,
  magnitude: '85.00',
  direction: 'right',
  angle: '0.00',
};

const sampleMotionVectorDiagonal: MotionVectorInfo = {
  frameRange: 'frame-0050.png - frame-0060.png',
  dx: 50,
  dy: 50,
  magnitude: '70.71',
  direction: 'down',
  angle: '45.00',
};

const sampleFrameAnalysisOutput: FrameImageAnalysisOutput = {
  metadata: {
    framesDir: '/tmp/reftrix-frames',
    totalFrames: 200,
    analyzedPairs: 20,
    sampleInterval: 10,
    scrollPxPerFrame: 15,
    analysisTime: '2.5s',
    analyzedAt: '2025-12-31T00:00:00.000Z',
  },
  statistics: {
    averageDiffPercentage: '12.34',
    significantChangeCount: 8,
    significantChangePercentage: '40.00',
    layoutShiftCount: 2,
    motionVectorCount: 5,
  },
  animationZones: [sampleAnimationZone, sampleMicroInteraction],
  layoutShifts: [
    {
      frameRange: 'frame-0070.png - frame-0080.png',
      scrollRange: '1050px - 1200px',
      impactFraction: '0.0823',
      boundingBox: { x: 100, y: 200, width: 300, height: 150 },
    },
  ],
  motionVectors: [sampleMotionVectorDown, sampleMotionVectorRight],
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
// AnimationZone → テキスト表現変換テスト（6テスト）
// =====================================================

describe('animationZoneToText', () => {
  it('fade/slide transitionのテキスト表現を生成する', () => {
    const text = animationZoneToText(sampleAnimationZone);

    expect(text).toContain('fade/slide transition');
    expect(text).toContain('500px');
    expect(text).toContain('1200px');
    expect(text).toContain('700');
    expect(text).toContain('15.5%');
  });

  it('micro-interactionのテキスト表現を生成する', () => {
    const text = animationZoneToText(sampleMicroInteraction);

    expect(text).toContain('micro-interaction');
    expect(text).toContain('100px');
    expect(text).toContain('400px');
    expect(text).toContain('300');
  });

  it('scroll-linked animationのテキスト表現を生成する', () => {
    const text = animationZoneToText(sampleScrollLinkedAnimation);

    expect(text).toContain('scroll-linked animation');
    expect(text).toContain('1500px');
    expect(text).toContain('3500px');
    expect(text).toContain('2000');
  });

  it('long-form revealのテキスト表現を生成する', () => {
    const text = animationZoneToText(sampleLongFormReveal);

    expect(text).toContain('long-form reveal');
    expect(text).toContain('3000px');
    expect(text).toContain('7500px');
    expect(text).toContain('4500');
  });

  it('peakDiff情報を含める', () => {
    const text = animationZoneToText(sampleAnimationZone);

    expect(text).toContain('peak');
    expect(text).toContain('28.3');
  });

  it('フレーム範囲情報を含める', () => {
    const text = animationZoneToText(sampleAnimationZone);

    expect(text).toContain('frame-0000');
    expect(text).toContain('frame-0050');
  });
});

// =====================================================
// MotionVectorInfo → テキスト表現変換テスト（5テスト）
// =====================================================

describe('motionVectorToText', () => {
  it('downward motionのテキスト表現を生成する', () => {
    const text = motionVectorToText(sampleMotionVectorDown);

    expect(text).toContain('down');
    expect(text).toContain('120');
    expect(text).toContain('90');
  });

  it('rightward motionのテキスト表現を生成する', () => {
    const text = motionVectorToText(sampleMotionVectorRight);

    expect(text).toContain('right');
    expect(text).toContain('85');
    expect(text).toContain('0');
  });

  it('diagonal motionのテキスト表現を生成する', () => {
    const text = motionVectorToText(sampleMotionVectorDiagonal);

    expect(text).toContain('down');
    expect(text).toContain('70.71');
    expect(text).toContain('45');
  });

  it('magnitude情報を含める', () => {
    const text = motionVectorToText(sampleMotionVectorDown);

    expect(text.toLowerCase()).toContain('magnitude');
    expect(text).toContain('120');
  });

  it('フレーム範囲情報を含める', () => {
    const text = motionVectorToText(sampleMotionVectorDown);

    expect(text).toContain('frame-0010');
    expect(text).toContain('frame-0020');
  });
});

// =====================================================
// FrameImageAnalysisOutput → テキスト表現変換テスト（5テスト）
// =====================================================

describe('frameAnalysisToText', () => {
  it('完全なFrameImageAnalysisOutputからテキスト表現を生成する', () => {
    const text = frameAnalysisToText(sampleFrameAnalysisOutput);

    expect(text.length).toBeGreaterThan(0);
  });

  it('アニメーションゾーン情報を含める', () => {
    const text = frameAnalysisToText(sampleFrameAnalysisOutput);

    expect(text).toContain('animation');
    expect(text).toContain('zone');
  });

  it('モーションベクトル情報を含める', () => {
    const text = frameAnalysisToText(sampleFrameAnalysisOutput);

    expect(text.toLowerCase()).toContain('motion');
    expect(text.toLowerCase()).toContain('vector');
  });

  it('統計情報を含める', () => {
    const text = frameAnalysisToText(sampleFrameAnalysisOutput);

    expect(text).toContain('200'); // totalFrames
    expect(text).toContain('12.34'); // averageDiffPercentage
  });

  it('レイアウトシフト情報を含める', () => {
    const text = frameAnalysisToText(sampleFrameAnalysisOutput);

    expect(text.toLowerCase()).toContain('layout');
    expect(text.toLowerCase()).toContain('shift');
  });
});

// =====================================================
// コンストラクタテスト（4テスト）
// =====================================================

describe('FrameEmbeddingService コンストラクタ', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
  });

  it('デフォルトオプションで初期化できる', () => {
    const service = new FrameEmbeddingService();
    expect(service).toBeDefined();
  });

  it('カスタムEmbeddingServiceを注入できる', () => {
    const mockService: IEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    };

    const service = new FrameEmbeddingService({ embeddingService: mockService });
    expect(service).toBeDefined();
  });

  it('modelNameオプションが設定できる', () => {
    const service = new FrameEmbeddingService({ modelName: 'test-model' });
    expect(service).toBeDefined();
  });

  it('normalizeオプションが設定できる', () => {
    const service = new FrameEmbeddingService({ normalize: false });
    expect(service).toBeDefined();
  });
});

// =====================================================
// generateFromAnimationZone テスト（6テスト）
// =====================================================

describe('generateFromAnimationZone', () => {
  let service: FrameEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    const mockEmbedding = createMockEmbedding(42);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new FrameEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('AnimationZoneからEmbeddingを生成する', async () => {
    const result = await service.generateFromAnimationZone(sampleAnimationZone);

    expect(result).toBeDefined();
    expect(result.embedding).toBeDefined();
    expect(Array.isArray(result.embedding)).toBe(true);
  });

  it('768次元のベクトルを返す', async () => {
    const result = await service.generateFromAnimationZone(sampleAnimationZone);

    expect(result.embedding.length).toBe(768);
  });

  it('L2正規化されたベクトルを返す', async () => {
    const result = await service.generateFromAnimationZone(sampleAnimationZone);

    const norm = Math.sqrt(
      result.embedding.reduce((sum, val) => sum + val * val, 0)
    );
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('使用したテキスト表現を返す', async () => {
    const result = await service.generateFromAnimationZone(sampleAnimationZone);

    expect(result.textUsed).toContain('fade/slide transition');
  });

  it('モデル名を返す', async () => {
    const result = await service.generateFromAnimationZone(sampleAnimationZone);

    expect(result.modelName).toBe(DEFAULT_MODEL_NAME);
  });

  it('処理時間を返す', async () => {
    const result = await service.generateFromAnimationZone(sampleAnimationZone);

    expect(result.processingTimeMs).toBeDefined();
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

// =====================================================
// generateFromMotionVector テスト（5テスト）
// =====================================================

describe('generateFromMotionVector', () => {
  let service: FrameEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    const mockEmbedding = createMockEmbedding(123);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new FrameEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('MotionVectorInfoからEmbeddingを生成する', async () => {
    const result = await service.generateFromMotionVector(sampleMotionVectorDown);

    expect(result).toBeDefined();
    expect(result.embedding).toBeDefined();
  });

  it('768次元のベクトルを返す', async () => {
    const result = await service.generateFromMotionVector(sampleMotionVectorDown);

    expect(result.embedding.length).toBe(768);
  });

  it('使用したテキスト表現を返す', async () => {
    const result = await service.generateFromMotionVector(sampleMotionVectorDown);

    expect(result.textUsed).toContain('down');
    expect(result.textUsed).toContain('120');
  });

  it('処理時間を返す', async () => {
    const result = await service.generateFromMotionVector(sampleMotionVectorDown);

    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('異なる方向のベクトルも処理できる', async () => {
    const resultRight = await service.generateFromMotionVector(sampleMotionVectorRight);

    expect(resultRight.textUsed).toContain('right');
  });
});

// =====================================================
// generateFromFrameAnalysis テスト（6テスト）
// =====================================================

describe('generateFromFrameAnalysis', () => {
  let service: FrameEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    const mockEmbedding = createMockEmbedding(456);
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([mockEmbedding]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new FrameEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('FrameImageAnalysisOutputからEmbeddingを生成する', async () => {
    const result = await service.generateFromFrameAnalysis(sampleFrameAnalysisOutput);

    expect(result).toBeDefined();
    expect(result.embedding).toBeDefined();
  });

  it('768次元のベクトルを返す', async () => {
    const result = await service.generateFromFrameAnalysis(sampleFrameAnalysisOutput);

    expect(result.embedding.length).toBe(768);
  });

  it('L2正規化されたベクトルを返す', async () => {
    const result = await service.generateFromFrameAnalysis(sampleFrameAnalysisOutput);

    const norm = Math.sqrt(
      result.embedding.reduce((sum, val) => sum + val * val, 0)
    );
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('総合的なテキスト表現を生成する', async () => {
    const result = await service.generateFromFrameAnalysis(sampleFrameAnalysisOutput);

    expect(result.textUsed.length).toBeGreaterThan(100);
  });

  it('アニメーションゾーンとモーションベクトルの両方を含む', async () => {
    const result = await service.generateFromFrameAnalysis(sampleFrameAnalysisOutput);

    expect(result.textUsed.toLowerCase()).toContain('animation');
    expect(result.textUsed.toLowerCase()).toContain('motion');
  });

  it('空の分析結果でも処理できる', async () => {
    const emptyAnalysis: FrameImageAnalysisOutput = {
      metadata: {
        framesDir: '/tmp',
        totalFrames: 0,
        analyzedPairs: 0,
        sampleInterval: 10,
        scrollPxPerFrame: 15,
        analysisTime: '0s',
        analyzedAt: '2025-12-31T00:00:00.000Z',
      },
      statistics: {
        averageDiffPercentage: '0.00',
        significantChangeCount: 0,
        significantChangePercentage: '0.00',
        layoutShiftCount: 0,
        motionVectorCount: 0,
      },
      animationZones: [],
      layoutShifts: [],
      motionVectors: [],
    };

    const result = await service.generateFromFrameAnalysis(emptyAnalysis);

    expect(result.embedding.length).toBe(768);
  });
});

// =====================================================
// generateFromAnimationZones テスト（配列版）（6テスト）
// =====================================================

describe('generateFromAnimationZones', () => {
  let service: FrameEmbeddingService;
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

    service = new FrameEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('AnimationZone配列からEmbeddingResult配列を生成する', async () => {
    const zones = [sampleAnimationZone, sampleMicroInteraction];
    const results = await service.generateFromAnimationZones(zones);

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
  });

  it('各EmbeddingResultが768次元ベクトルを含む', async () => {
    const zones = [sampleAnimationZone, sampleMicroInteraction];
    const results = await service.generateFromAnimationZones(zones);

    expect(results[0]?.embedding.length).toBe(768);
    expect(results[1]?.embedding.length).toBe(768);
  });

  it('空配列で空配列を返す', async () => {
    const results = await service.generateFromAnimationZones([]);

    expect(results).toEqual([]);
  });

  it('10件以上でも効率的に処理する', async () => {
    const zones = Array(15).fill(sampleAnimationZone);
    const manyEmbeddings = Array(15).fill(null).map((_, i) => createMockEmbedding(i));

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(() =>
        Promise.resolve(createMockEmbedding(Math.random()))
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue(manyEmbeddings),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const results = await service.generateFromAnimationZones(zones);

    expect(results.length).toBe(15);
  });

  it('各結果にtextUsedが含まれる', async () => {
    const zones = [sampleAnimationZone];
    const results = await service.generateFromAnimationZones(zones);

    expect(results[0]?.textUsed).toBeDefined();
    expect(results[0]?.textUsed).toContain('fade/slide transition');
  });

  it('4種類のanimationTypeをすべて処理できる', async () => {
    const zones = [
      sampleMicroInteraction,      // micro-interaction
      sampleAnimationZone,          // fade/slide transition
      sampleScrollLinkedAnimation,  // scroll-linked animation
      sampleLongFormReveal,         // long-form reveal
    ];

    const fourEmbeddings = zones.map((_, i) => createMockEmbedding(i));
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(() =>
        Promise.resolve(createMockEmbedding(Math.random()))
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue(fourEmbeddings),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const results = await service.generateFromAnimationZones(zones);

    expect(results.length).toBe(4);
  });
});

// =====================================================
// generateFromMotionVectors テスト（配列版）（5テスト）
// =====================================================

describe('generateFromMotionVectors', () => {
  let service: FrameEmbeddingService;
  const mockEmbeddings = [createMockEmbedding(10), createMockEmbedding(20), createMockEmbedding(30)];

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

    service = new FrameEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('MotionVectorInfo配列からEmbeddingResult配列を生成する', async () => {
    const vectors = [sampleMotionVectorDown, sampleMotionVectorRight];
    const results = await service.generateFromMotionVectors(vectors);

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
  });

  it('各EmbeddingResultが768次元ベクトルを含む', async () => {
    const vectors = [sampleMotionVectorDown, sampleMotionVectorRight];
    const results = await service.generateFromMotionVectors(vectors);

    expect(results[0]?.embedding.length).toBe(768);
    expect(results[1]?.embedding.length).toBe(768);
  });

  it('空配列で空配列を返す', async () => {
    const results = await service.generateFromMotionVectors([]);

    expect(results).toEqual([]);
  });

  it('各結果にtextUsedが含まれる', async () => {
    const vectors = [sampleMotionVectorDown];
    const results = await service.generateFromMotionVectors(vectors);

    expect(results[0]?.textUsed).toBeDefined();
    expect(results[0]?.textUsed).toContain('down');
  });

  it('すべてのdirection種類を処理できる', async () => {
    // up, down, left, right, stationary
    const vectorUp: MotionVectorInfo = { ...sampleMotionVectorDiagonal, dy: -50, direction: 'up' };
    const vectorDown: MotionVectorInfo = { ...sampleMotionVectorDown };
    const vectorLeft: MotionVectorInfo = { ...sampleMotionVectorRight, dx: -85, direction: 'left' };
    const vectorRight: MotionVectorInfo = { ...sampleMotionVectorRight };
    const vectorStationary: MotionVectorInfo = {
      frameRange: 'frame-0000.png - frame-0010.png',
      dx: 0,
      dy: 0,
      magnitude: '0.00',
      direction: 'stationary',
      angle: '0.00',
    };

    const vectors = [vectorUp, vectorDown, vectorLeft, vectorRight, vectorStationary];
    const fiveEmbeddings = vectors.map((_, i) => createMockEmbedding(i));
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(() =>
        Promise.resolve(createMockEmbedding(Math.random()))
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue(fiveEmbeddings),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const results = await service.generateFromMotionVectors(vectors);

    expect(results.length).toBe(5);
  });
});

// =====================================================
// generateFromAnalysis テスト（統合結果）（7テスト）
// =====================================================

describe('generateFromAnalysis', () => {
  let service: FrameEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(() =>
        Promise.resolve(createMockEmbedding(Math.random() * 1000))
      ),
      generateBatchEmbeddings: vi.fn().mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map((_, i) => createMockEmbedding(i + 200)))
      ),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new FrameEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('FrameImageAnalysisOutputからFrameEmbeddingResultを生成する', async () => {
    const result = await service.generateFromAnalysis(sampleFrameAnalysisOutput);

    expect(result).toBeDefined();
    expect(result.zoneEmbeddings).toBeDefined();
    expect(result.vectorEmbeddings).toBeDefined();
    expect(result.summaryEmbedding).toBeDefined();
  });

  it('animationZonesからzoneEmbeddingsを生成する', async () => {
    const result = await service.generateFromAnalysis(sampleFrameAnalysisOutput);

    // sampleFrameAnalysisOutputには2つのanimationZonesがある
    expect(result.zoneEmbeddings.length).toBe(2);
    result.zoneEmbeddings.forEach((embed: EmbeddingResult) => {
      expect(embed.embedding.length).toBe(768);
    });
  });

  it('motionVectorsからvectorEmbeddingsを生成する', async () => {
    const result = await service.generateFromAnalysis(sampleFrameAnalysisOutput);

    // sampleFrameAnalysisOutputには2つのmotionVectorsがある
    expect(result.vectorEmbeddings.length).toBe(2);
    result.vectorEmbeddings.forEach((embed: EmbeddingResult) => {
      expect(embed.embedding.length).toBe(768);
    });
  });

  it('サマリーEmbeddingを生成する', async () => {
    const result = await service.generateFromAnalysis(sampleFrameAnalysisOutput);

    expect(result.summaryEmbedding).toBeDefined();
    expect(result.summaryEmbedding.embedding.length).toBe(768);
  });

  it('サマリーに統計情報を含む', async () => {
    const result = await service.generateFromAnalysis(sampleFrameAnalysisOutput);

    const summaryText = result.summaryEmbedding.textUsed;
    // 統計情報を含むことを確認
    expect(summaryText).toMatch(/zone|animation|vector|motion|frame/i);
  });

  it('空のanalysisでも動作する', async () => {
    const emptyAnalysis: FrameImageAnalysisOutput = {
      metadata: {
        framesDir: '/tmp',
        totalFrames: 0,
        analyzedPairs: 0,
        sampleInterval: 10,
        scrollPxPerFrame: 15,
        analysisTime: '0s',
        analyzedAt: '2025-12-31T00:00:00.000Z',
      },
      statistics: {
        averageDiffPercentage: '0.00',
        significantChangeCount: 0,
        significantChangePercentage: '0.00',
        layoutShiftCount: 0,
        motionVectorCount: 0,
      },
      animationZones: [],
      layoutShifts: [],
      motionVectors: [],
    };

    const result = await service.generateFromAnalysis(emptyAnalysis);

    expect(result.zoneEmbeddings).toEqual([]);
    expect(result.vectorEmbeddings).toEqual([]);
    // サマリーは生成される
    expect(result.summaryEmbedding).toBeDefined();
    expect(result.summaryEmbedding.embedding.length).toBe(768);
  });

  it('メタデータ情報を返す', async () => {
    const result = await service.generateFromAnalysis(sampleFrameAnalysisOutput);

    expect(result.metadata).toBeDefined();
    expect(result.metadata.totalFrames).toBe(200);
    expect(result.metadata.analyzedPairs).toBe(20);
  });
});

// =====================================================
// バッチ処理テスト（5テスト）
// =====================================================

describe('generateBatchFromAnimationZones', () => {
  let service: FrameEmbeddingService;
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

    service = new FrameEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('複数のAnimationZoneから一括でEmbeddingを生成する', async () => {
    const zones = [sampleAnimationZone, sampleMicroInteraction];
    const results = await service.generateBatchFromAnimationZones(zones);

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
  });

  it('各ゾーンに対応するEmbeddingを返す', async () => {
    const zones = [sampleAnimationZone, sampleMicroInteraction];
    const results = await service.generateBatchFromAnimationZones(zones);

    expect(results[0]?.embedding.length).toBe(768);
    expect(results[1]?.embedding.length).toBe(768);
  });

  it('空配列で空配列を返す', async () => {
    const results = await service.generateBatchFromAnimationZones([]);

    expect(results).toEqual([]);
  });

  it('10件以上でも動作する', async () => {
    const zones = Array(15).fill(sampleAnimationZone);
    const manyEmbeddings = Array(15).fill(null).map((_, i) => createMockEmbedding(i));

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockImplementation(() =>
        Promise.resolve(createMockEmbedding(Math.random()))
      ),
      generateBatchEmbeddings: vi.fn().mockResolvedValue(manyEmbeddings),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const results = await service.generateBatchFromAnimationZones(zones);

    expect(results.length).toBe(15);
  });

  it('進捗コールバックが呼ばれる', async () => {
    const progressCallback = vi.fn();

    const zones = [sampleAnimationZone, sampleMicroInteraction];
    await service.generateBatchFromAnimationZones(zones, { onProgress: progressCallback });

    expect(progressCallback).toHaveBeenCalled();
  });
});

// =====================================================
// パフォーマンステスト（3テスト）
// =====================================================

describe('パフォーマンス', () => {
  let service: FrameEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();

    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn().mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map((_, i) => createMockEmbedding(i)))
      ),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    service = new FrameEmbeddingService();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('単一Embedding生成が200ms未満で完了する（モック）', async () => {
    const start = Date.now();
    await service.generateFromAnimationZone(sampleAnimationZone);
    const elapsed = Date.now() - start;

    // モックなので実際の推論時間はない
    expect(elapsed).toBeLessThan(200);
  });

  it('バッチ10件が2秒未満で完了する（モック）', async () => {
    const zones = Array(10).fill(sampleAnimationZone);

    const start = Date.now();
    await service.generateBatchFromAnimationZones(zones);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
  });

  it('処理時間が結果に含まれる', async () => {
    const result = await service.generateFromFrameAnalysis(sampleFrameAnalysisOutput);

    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

// =====================================================
// 類似度計算テスト（4テスト）
// =====================================================

describe('calculateSimilarity', () => {
  let service: FrameEmbeddingService;

  beforeEach(() => {
    resetEmbeddingServiceFactory();
    service = new FrameEmbeddingService();
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

    const service = new FrameEmbeddingService();

    await expect(
      service.generateFromAnimationZone(sampleAnimationZone)
    ).rejects.toThrow('Model loading failed');
  });

  it('null AnimationZoneでエラーをスローする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const service = new FrameEmbeddingService();

    await expect(
      service.generateFromAnimationZone(null as unknown as AnimationZone)
    ).rejects.toThrow();
  });

  it('null MotionVectorInfoでエラーをスローする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const service = new FrameEmbeddingService();

    await expect(
      service.generateFromMotionVector(null as unknown as MotionVectorInfo)
    ).rejects.toThrow();
  });

  it('null FrameImageAnalysisOutputでエラーをスローする', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const service = new FrameEmbeddingService();

    await expect(
      service.generateFromFrameAnalysis(null as unknown as FrameImageAnalysisOutput)
    ).rejects.toThrow();
  });

  it('バッチ処理中のエラーでも部分的な結果を返す', async () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn()
        .mockResolvedValueOnce(createMockEmbedding(1))
        .mockRejectedValueOnce(new Error('Embedding error'))
        .mockResolvedValueOnce(createMockEmbedding(3)),
      generateBatchEmbeddings: vi.fn().mockRejectedValue(new Error('Batch error')),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));

    const zones = [sampleAnimationZone, sampleMicroInteraction, sampleScrollLinkedAnimation];
    const service = new FrameEmbeddingService();
    const results = await service.generateBatchFromAnimationZones(zones, { continueOnError: true });

    // 部分的な結果が返される（成功したものだけ）
    expect(results.length).toBeGreaterThan(0);
  });
});

// =====================================================
// キャッシュ機構テスト（4テスト）
// =====================================================

describe('キャッシュ機構', () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it('キャッシュ統計を取得できる', () => {
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 5, misses: 10, size: 15, evictions: 2 }),
      clearCache: vi.fn(),
    }));

    const service = new FrameEmbeddingService();
    const stats = service.getCacheStats();

    expect(stats).toBeDefined();
    expect(stats.hits).toBe(5);
    expect(stats.misses).toBe(10);
  });

  it('キャッシュをクリアできる', () => {
    const mockClearCache = vi.fn();
    setEmbeddingServiceFactory(() => ({
      generateEmbedding: vi.fn().mockResolvedValue(createMockEmbedding(1)),
      generateBatchEmbeddings: vi.fn().mockResolvedValue([createMockEmbedding(1)]),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: mockClearCache,
    }));

    const service = new FrameEmbeddingService();
    service.clearCache();

    expect(mockClearCache).toHaveBeenCalled();
  });

  it('EmbeddingServiceが未初期化でもキャッシュ統計を返す', () => {
    const service = new FrameEmbeddingService();
    const stats = service.getCacheStats();

    expect(stats).toBeDefined();
    expect(stats).toHaveProperty('hits');
    expect(stats).toHaveProperty('misses');
    expect(stats).toHaveProperty('size');
    expect(stats).toHaveProperty('evictions');
  });

  it('EmbeddingServiceが未初期化でもclearCacheがエラーしない', () => {
    const service = new FrameEmbeddingService();

    expect(() => service.clearCache()).not.toThrow();
  });
});

// =====================================================
// DB保存連携テスト（6テスト）
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

  it('saveMotionEmbedding がMotionPattern IDを返す', async () => {
    const mockMotionPatternId = '019368a8-7b0c-7000-8000-000000000001';
    const mockEmbeddingId = '019368a8-7b0c-7000-8000-000000000002';
    const mockEmbedding = createMockEmbedding(100);

    setPrismaClientFactory(() => ({
      motionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: mockEmbeddingId }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    const result = await saveMotionEmbedding(
      mockMotionPatternId,
      mockEmbedding,
      DEFAULT_MODEL_NAME
    );

    expect(result).toBe(mockEmbeddingId);
  });

  it('saveFrameAnalysisWithEmbeddings が完全な結果を返す', async () => {
    const mockWebPageId = '019368a8-7b0c-7000-8000-000000000003';
    const mockMotionPatternId = '019368a8-7b0c-7000-8000-000000000004';
    const mockEmbeddingId = '019368a8-7b0c-7000-8000-000000000005';
    const mockEmbedding = createMockEmbedding(100);

    const mockPrisma: IPrismaClient = {
      motionPattern: {
        create: vi.fn().mockResolvedValue({ id: mockMotionPatternId }),
      },
      motionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: mockEmbeddingId }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    };

    setPrismaClientFactory(() => mockPrisma);

    const service = new FrameEmbeddingService();
    const embeddingResult = await service.generateFromAnalysis(sampleFrameAnalysisOutput);

    const result = await saveFrameAnalysisWithEmbeddings(
      mockWebPageId,
      sampleFrameAnalysisOutput,
      embeddingResult
    );

    expect(result).toBeDefined();
    expect(result.savedPatternIds).toBeDefined();
    expect(Array.isArray(result.savedPatternIds)).toBe(true);
  });

  it('saveMotionEmbedding がDB接続エラーを適切に処理する', async () => {
    const mockMotionPatternId = '019368a8-7b0c-7000-8000-000000000001';
    const mockEmbedding = createMockEmbedding(100);

    setPrismaClientFactory(() => ({
      motionEmbedding: {
        create: vi.fn().mockRejectedValue(new Error('DB connection error')),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    await expect(
      saveMotionEmbedding(mockMotionPatternId, mockEmbedding, DEFAULT_MODEL_NAME)
    ).rejects.toThrow('DB connection error');
  });

  it('正しいEmbeddingフォーマット（pgvector）でDBに保存する', async () => {
    const mockMotionPatternId = '019368a8-7b0c-7000-8000-000000000001';
    const mockEmbeddingId = '019368a8-7b0c-7000-8000-000000000002';
    const mockEmbedding = createMockEmbedding(100);

    const mockExecuteRaw = vi.fn().mockResolvedValue(1);
    setPrismaClientFactory(() => ({
      motionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: mockEmbeddingId }),
      },
      $executeRawUnsafe: mockExecuteRaw,
    }));

    await saveMotionEmbedding(
      mockMotionPatternId,
      mockEmbedding,
      DEFAULT_MODEL_NAME
    );

    // pgvector形式で保存されることを確認
    expect(mockExecuteRaw).toHaveBeenCalled();
    const callArgs = mockExecuteRaw.mock.calls[0];
    // ベクトル文字列が含まれることを確認
    expect(callArgs?.[0]).toContain('vector');
  });

  it('モデルバージョンがDBに保存される', async () => {
    const mockMotionPatternId = '019368a8-7b0c-7000-8000-000000000001';
    const mockEmbeddingId = '019368a8-7b0c-7000-8000-000000000002';
    const mockEmbedding = createMockEmbedding(100);

    const mockCreate = vi.fn().mockResolvedValue({ id: mockEmbeddingId });
    setPrismaClientFactory(() => ({
      motionEmbedding: {
        create: mockCreate,
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    await saveMotionEmbedding(
      mockMotionPatternId,
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

  it('AnimationZoneからMotionPatternを生成してDBに保存する', async () => {
    const mockWebPageId = '019368a8-7b0c-7000-8000-000000000003';
    const mockMotionPatternId = '019368a8-7b0c-7000-8000-000000000004';
    const mockEmbeddingId = '019368a8-7b0c-7000-8000-000000000005';
    const mockEmbedding = createMockEmbedding(100);

    const mockPatternCreate = vi.fn().mockResolvedValue({ id: mockMotionPatternId });
    const mockEmbeddingCreate = vi.fn().mockResolvedValue({ id: mockEmbeddingId });

    setPrismaClientFactory(() => ({
      motionPattern: {
        create: mockPatternCreate,
      },
      motionEmbedding: {
        create: mockEmbeddingCreate,
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    const service = new FrameEmbeddingService();
    const embeddingResult = await service.generateFromAnimationZone(sampleAnimationZone);

    const result = await saveFrameAnalysisWithEmbeddings(
      mockWebPageId,
      {
        ...sampleFrameAnalysisOutput,
        animationZones: [sampleAnimationZone],
        motionVectors: [],
      },
      {
        zoneEmbeddings: [embeddingResult],
        vectorEmbeddings: [],
        summaryEmbedding: embeddingResult,
        metadata: sampleFrameAnalysisOutput.metadata,
        processingTimeMs: 100,
      }
    );

    // MotionPatternが作成されたことを確認
    expect(mockPatternCreate).toHaveBeenCalled();
    // AnimationType情報が含まれることを確認
    const createCall = mockPatternCreate.mock.calls[0];
    expect(createCall?.[0]?.data?.type).toContain('animation');
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
      generateBatchEmbeddings: vi.fn().mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map((_, i) => createMockEmbedding(i + 1000)))
      ),
      getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: vi.fn(),
    }));
  });

  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  it('FrameImageAnalysisOutputからEmbedding生成とDB保存の連携', async () => {
    const mockWebPageId = '019368a8-7b0c-7000-8000-000000000010';
    const mockMotionPatternId = '019368a8-7b0c-7000-8000-000000000011';
    const mockEmbeddingId = '019368a8-7b0c-7000-8000-000000000012';

    setPrismaClientFactory(() => ({
      motionPattern: {
        create: vi.fn().mockResolvedValue({ id: mockMotionPatternId }),
      },
      motionEmbedding: {
        create: vi.fn().mockResolvedValue({ id: mockEmbeddingId }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    }));

    const service = new FrameEmbeddingService();
    const embeddingResult = await service.generateFromAnalysis(sampleFrameAnalysisOutput);

    // Embeddingが正しく生成されていることを確認
    expect(embeddingResult.zoneEmbeddings.length).toBe(2);
    expect(embeddingResult.vectorEmbeddings.length).toBe(2);
    expect(embeddingResult.summaryEmbedding.embedding.length).toBe(768);

    // DB保存
    const saveResult = await saveFrameAnalysisWithEmbeddings(
      mockWebPageId,
      sampleFrameAnalysisOutput,
      embeddingResult
    );

    expect(saveResult).toBeDefined();
    expect(saveResult.savedPatternIds.length).toBeGreaterThan(0);
  });

  it('複数AnimationTypeを含む分析結果の処理', async () => {
    const multiTypeAnalysis: FrameImageAnalysisOutput = {
      ...sampleFrameAnalysisOutput,
      animationZones: [
        sampleMicroInteraction,
        sampleAnimationZone,
        sampleScrollLinkedAnimation,
        sampleLongFormReveal,
      ],
      motionVectors: [
        sampleMotionVectorDown,
        sampleMotionVectorRight,
        sampleMotionVectorDiagonal,
      ],
    };

    const service = new FrameEmbeddingService();
    const result = await service.generateFromAnalysis(multiTypeAnalysis);

    // すべてのAnimationTypeが処理されていることを確認
    expect(result.zoneEmbeddings.length).toBe(4);
    expect(result.vectorEmbeddings.length).toBe(3);

    // 各タイプのテキスト表現が含まれていることを確認
    const allZoneTexts = result.zoneEmbeddings.map((e: EmbeddingResult) => e.textUsed).join(' ');
    expect(allZoneTexts).toContain('micro-interaction');
    expect(allZoneTexts).toContain('fade/slide transition');
    expect(allZoneTexts).toContain('scroll-linked animation');
    expect(allZoneTexts).toContain('long-form reveal');
  });

  it('カスタムオプションでの完全なワークフロー', async () => {
    const mockService: IEmbeddingService = {
      generateEmbedding: vi.fn().mockImplementation(() =>
        Promise.resolve(createMockEmbedding(Math.random() * 1000))
      ),
      generateBatchEmbeddings: vi.fn().mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map((_, i) => createMockEmbedding(i + 5000)))
      ),
      getCacheStats: vi.fn().mockReturnValue({ hits: 10, misses: 5, size: 15, evictions: 0 }),
      clearCache: vi.fn(),
    };

    const service = new FrameEmbeddingService({
      embeddingService: mockService,
      modelName: 'custom-e5-model',
      normalize: true,
    });

    // 単一AnimationZoneからEmbedding
    const zoneResult = await service.generateFromAnimationZone(sampleAnimationZone);
    expect(zoneResult.embedding.length).toBe(768);

    // 単一MotionVectorからEmbedding
    const vectorResult = await service.generateFromMotionVector(sampleMotionVectorDown);
    expect(vectorResult.embedding.length).toBe(768);

    // 完全なFrameAnalysisからEmbedding
    const analysisResult = await service.generateFromAnalysis(sampleFrameAnalysisOutput);
    expect(analysisResult.summaryEmbedding.embedding.length).toBe(768);

    // 類似度計算
    const similarity = service.calculateSimilarity(
      zoneResult.embedding,
      vectorResult.embedding
    );
    expect(similarity).toBeGreaterThan(-1);
    expect(similarity).toBeLessThanOrEqual(1);

    // キャッシュ統計
    const stats = service.getCacheStats();
    expect(stats.hits).toBe(10);
    expect(stats.misses).toBe(5);
  });
});
