// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion-db.service.ts ユニットテスト
 *
 * MotionDbService の動作検証
 * - ファクトリ登録の検証
 * - isAvailable() の動作確認
 * - saveAnimationZone() / saveLayoutShift() / saveMotionVector() の動作確認
 * - saveFrameAnalysis() バッチ保存の動作確認
 * - テキスト表現生成関数の動作確認
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MotionDbService,
  setMotionDbEmbeddingServiceFactory,
  setMotionDbPrismaClientFactory,
  resetMotionDbEmbeddingServiceFactory,
  resetMotionDbPrismaClientFactory,
  getMotionDbService,
  resetMotionDbService,
  animationZoneToTextRepresentation,
  layoutShiftToTextRepresentation,
  motionVectorToTextRepresentation,
  type IEmbeddingService,
  type IPrismaClient,
  RESULT_TYPES,
} from '../../../src/services/motion/motion-db.service';
import type {
  AnimationZone,
  LayoutShiftInfo,
  MotionVectorInfo,
  FrameImageAnalysisOutput,
} from '../../../src/services/motion/frame-image-analyzer.adapter';

// =====================================================
// テスト用モックデータ
// =====================================================

const createMockAnimationZone = (
  overrides?: Partial<AnimationZone>
): AnimationZone => ({
  frameStart: 'frame-0000',
  frameEnd: 'frame-0100',
  scrollStart: 0,
  scrollEnd: 1500,
  duration: 1500,
  avgDiff: '2.50',
  peakDiff: '5.00',
  animationType: 'fade/slide transition',
  ...overrides,
});

const createMockLayoutShift = (
  overrides?: Partial<LayoutShiftInfo>
): LayoutShiftInfo => ({
  frameRange: 'frame-0050 - frame-0060',
  scrollRange: '750px - 900px',
  impactFraction: '0.1234',
  boundingBox: { x: 100, y: 200, width: 300, height: 400 },
  ...overrides,
});

const createMockMotionVector = (
  overrides?: Partial<MotionVectorInfo>
): MotionVectorInfo => ({
  frameRange: 'frame-0070 - frame-0080',
  dx: 50,
  dy: -30,
  magnitude: '58.31',
  direction: 'right',
  angle: '-30.96',
  ...overrides,
});

const createMockFrameAnalysisOutput = (
  overrides?: Partial<FrameImageAnalysisOutput>
): FrameImageAnalysisOutput => ({
  metadata: {
    framesDir: '/tmp/test-frames',
    totalFrames: 200,
    analyzedPairs: 20,
    sampleInterval: 10,
    scrollPxPerFrame: 15,
    analysisTime: '5.00s',
    analyzedAt: '2025-01-01T00:00:00Z',
  },
  statistics: {
    averageDiffPercentage: '1.50',
    significantChangeCount: 10,
    significantChangePercentage: '50.00',
    layoutShiftCount: 2,
    motionVectorCount: 3,
  },
  animationZones: [createMockAnimationZone()],
  layoutShifts: [createMockLayoutShift()],
  motionVectors: [createMockMotionVector()],
  ...overrides,
});

// =====================================================
// モックファクトリ
// =====================================================

const createMockEmbeddingService = (): IEmbeddingService => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
});

const createMockPrismaClient = (): IPrismaClient => ({
  motionAnalysisResult: {
    create: vi.fn().mockResolvedValue({ id: 'mock-result-id' }),
  },
  motionAnalysisEmbedding: {
    create: vi.fn().mockResolvedValue({ id: 'mock-embedding-id' }),
  },
  $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  $transaction: vi.fn().mockImplementation((fn) => fn(createMockPrismaClient())),
});

// =====================================================
// テストスイート
// =====================================================

describe('MotionDbService', () => {
  beforeEach(() => {
    // 各テスト前にファクトリをリセット
    resetMotionDbEmbeddingServiceFactory();
    resetMotionDbPrismaClientFactory();
    resetMotionDbService();
  });

  afterEach(() => {
    // 各テスト後にファクトリをリセット
    resetMotionDbEmbeddingServiceFactory();
    resetMotionDbPrismaClientFactory();
    resetMotionDbService();
  });

  // =====================================================
  // ファクトリ登録
  // =====================================================
  describe('ファクトリ登録', () => {
    it('ファクトリ未登録時、isAvailable() は false を返す', () => {
      const service = new MotionDbService();
      expect(service.isAvailable()).toBe(false);
    });

    it('PrismaClientファクトリのみ登録時、isAvailable() は true を返す', () => {
      setMotionDbPrismaClientFactory(createMockPrismaClient);
      const service = new MotionDbService();
      expect(service.isAvailable()).toBe(true);
    });

    it('両方のファクトリ登録時、isAvailable() は true を返す', () => {
      setMotionDbEmbeddingServiceFactory(createMockEmbeddingService);
      setMotionDbPrismaClientFactory(createMockPrismaClient);
      const service = new MotionDbService();
      expect(service.isAvailable()).toBe(true);
    });
  });

  // =====================================================
  // シングルトン
  // =====================================================
  describe('getMotionDbService シングルトン', () => {
    it('同じインスタンスを返す', () => {
      const service1 = getMotionDbService();
      const service2 = getMotionDbService();
      expect(service1).toBe(service2);
    });

    it('resetMotionDbService() 後は新しいインスタンスを返す', () => {
      const service1 = getMotionDbService();
      resetMotionDbService();
      const service2 = getMotionDbService();
      expect(service1).not.toBe(service2);
    });
  });

  // =====================================================
  // saveAnimationZone
  // =====================================================
  describe('saveAnimationZone', () => {
    it('ファクトリ未登録時、エラーをスローする', async () => {
      const service = new MotionDbService();
      const zone = createMockAnimationZone();

      await expect(service.saveAnimationZone({ zone })).rejects.toThrow(
        'PrismaClient not initialized'
      );
    });

    it('正常に保存できる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const zone = createMockAnimationZone();

      const result = await service.saveAnimationZone({ zone });

      expect(result.resultId).toBeDefined();
      expect(result.embeddingId).toBeDefined();
      expect(mockPrisma.motionAnalysisResult.create).toHaveBeenCalled();
      expect(mockPrisma.motionAnalysisEmbedding.create).toHaveBeenCalled();
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();
    });

    it('resultType が animation_zone で保存される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const zone = createMockAnimationZone();

      await service.saveAnimationZone({ zone });

      const createCall = (
        mockPrisma.motionAnalysisResult.create as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(createCall[0].data.resultType).toBe(RESULT_TYPES.ANIMATION_ZONE);
    });

    it('webPageId と sourceUrl が正しく保存される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const zone = createMockAnimationZone();

      await service.saveAnimationZone({
        zone,
        webPageId: 'test-webpage-id',
        sourceUrl: 'https://example.com',
      });

      const createCall = (
        mockPrisma.motionAnalysisResult.create as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(createCall[0].data.webPageId).toBe('test-webpage-id');
      expect(createCall[0].data.sourceUrl).toBe('https://example.com');
    });

    it('提供されたEmbeddingを使用する', async () => {
      const mockPrisma = createMockPrismaClient();
      // EmbeddingServiceは使用されない
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const zone = createMockAnimationZone();
      const providedEmbedding = new Array(768).fill(0.5);

      await service.saveAnimationZone({ zone, embedding: providedEmbedding });

      const executeCall = (
        mockPrisma.$executeRawUnsafe as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(executeCall[1]).toContain('0.5');
    });
  });

  // =====================================================
  // saveLayoutShift
  // =====================================================
  describe('saveLayoutShift', () => {
    it('正常に保存できる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const layoutShift = createMockLayoutShift();

      const result = await service.saveLayoutShift({ layoutShift });

      expect(result.resultId).toBeDefined();
      expect(result.embeddingId).toBeDefined();
      expect(mockPrisma.motionAnalysisResult.create).toHaveBeenCalled();
    });

    it('resultType が layout_shift で保存される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const layoutShift = createMockLayoutShift();

      await service.saveLayoutShift({ layoutShift });

      const createCall = (
        mockPrisma.motionAnalysisResult.create as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(createCall[0].data.resultType).toBe(RESULT_TYPES.LAYOUT_SHIFT);
    });

    it('affectedRegions に boundingBox が含まれる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const layoutShift = createMockLayoutShift();

      await service.saveLayoutShift({ layoutShift });

      const createCall = (
        mockPrisma.motionAnalysisResult.create as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(createCall[0].data.affectedRegions).toEqual([
        layoutShift.boundingBox,
      ]);
    });
  });

  // =====================================================
  // saveMotionVector
  // =====================================================
  describe('saveMotionVector', () => {
    it('正常に保存できる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const vector = createMockMotionVector();

      const result = await service.saveMotionVector({ vector });

      expect(result.resultId).toBeDefined();
      expect(result.embeddingId).toBeDefined();
      expect(mockPrisma.motionAnalysisResult.create).toHaveBeenCalled();
    });

    it('resultType が motion_vector で保存される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const vector = createMockMotionVector();

      await service.saveMotionVector({ vector });

      const createCall = (
        mockPrisma.motionAnalysisResult.create as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(createCall[0].data.resultType).toBe(RESULT_TYPES.MOTION_VECTOR);
    });

    it('resultData に dx/dy/magnitude が含まれる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const vector = createMockMotionVector({ dx: 100, dy: -50 });

      await service.saveMotionVector({ vector });

      const createCall = (
        mockPrisma.motionAnalysisResult.create as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(createCall[0].data.resultData.dx).toBe(100);
      expect(createCall[0].data.resultData.dy).toBe(-50);
    });

    it('direction が motionType にマッピングされる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();

      // up -> slide_up
      await service.saveMotionVector({
        vector: createMockMotionVector({ direction: 'up' }),
      });
      let createCall = (
        mockPrisma.motionAnalysisResult.create as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(createCall[0].data.resultData.motionType).toBe('slide_up');

      // down -> slide_down
      vi.clearAllMocks();
      await service.saveMotionVector({
        vector: createMockMotionVector({ direction: 'down' }),
      });
      createCall = (
        mockPrisma.motionAnalysisResult.create as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(createCall[0].data.resultData.motionType).toBe('slide_down');

      // stationary -> static
      vi.clearAllMocks();
      await service.saveMotionVector({
        vector: createMockMotionVector({ direction: 'stationary' }),
      });
      createCall = (
        mockPrisma.motionAnalysisResult.create as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(createCall[0].data.resultData.motionType).toBe('static');
    });
  });

  // =====================================================
  // saveFrameAnalysis（バッチ保存）
  // =====================================================
  describe('saveFrameAnalysis', () => {
    it('空の入力の場合、savedCount は 0 を返す', async () => {
      const mockPrisma = createMockPrismaClient();
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const input = createMockFrameAnalysisOutput({
        animationZones: [],
        layoutShifts: [],
        motionVectors: [],
      });

      const result = await service.saveFrameAnalysis(input);

      expect(result.saved).toBe(false);
      expect(result.savedCount).toBe(0);
      expect(result.reason).toBe('No items to save');
    });

    it('複数アイテムを保存できる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const input = createMockFrameAnalysisOutput({
        animationZones: [
          createMockAnimationZone({ frameStart: 'frame-0000' }),
          createMockAnimationZone({ frameStart: 'frame-0200' }),
        ],
        layoutShifts: [createMockLayoutShift()],
        motionVectors: [createMockMotionVector()],
      });

      const result = await service.saveFrameAnalysis(input);

      expect(result.saved).toBe(true);
      expect(result.savedCount).toBe(4);
      expect(result.resultIds).toHaveLength(4);
      expect(result.embeddingIds).toHaveLength(4);
      expect(result.byCategory).toEqual({
        animationZones: 2,
        layoutShifts: 1,
        motionVectors: 1,
      });
    });

    it('webPageId と sourceUrl がすべてのアイテムに渡される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const input = createMockFrameAnalysisOutput({
        animationZones: [createMockAnimationZone()],
        layoutShifts: [],
        motionVectors: [],
      });

      await service.saveFrameAnalysis(input, {
        webPageId: 'batch-webpage-id',
        sourceUrl: 'https://batch.example.com',
      });

      const createCall = (
        mockPrisma.motionAnalysisResult.create as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(createCall[0].data.webPageId).toBe('batch-webpage-id');
      expect(createCall[0].data.sourceUrl).toBe('https://batch.example.com');
    });

    it('continueOnError=true の場合、エラーがあっても続行する', async () => {
      let callCount = 0;
      const mockPrisma: IPrismaClient = {
        motionAnalysisResult: {
          create: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 2) {
              throw new Error('Mock error on second item');
            }
            return Promise.resolve({ id: `mock-result-id-${callCount}` });
          }),
        },
        motionAnalysisEmbedding: {
          create: vi.fn().mockResolvedValue({ id: 'mock-embedding-id' }),
        },
        $executeRawUnsafe: vi.fn().mockResolvedValue(1),
        $transaction: vi.fn().mockImplementation((fn) => fn(mockPrisma)),
      };
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const input = createMockFrameAnalysisOutput({
        animationZones: [
          createMockAnimationZone({ frameStart: 'frame-0000' }),
          createMockAnimationZone({ frameStart: 'frame-0100' }), // エラー
          createMockAnimationZone({ frameStart: 'frame-0200' }),
        ],
        layoutShifts: [],
        motionVectors: [],
      });

      const result = await service.saveFrameAnalysis(input, {
        continueOnError: true,
      });

      expect(result.saved).toBe(true);
      expect(result.savedCount).toBe(2);
      expect(result.byCategory?.animationZones).toBe(2);
    });

    it('continueOnError=false の場合、エラー発生時に例外をスローする', async () => {
      const mockPrisma: IPrismaClient = {
        motionAnalysisResult: {
          create: vi.fn().mockRejectedValue(new Error('Database error')),
        },
        motionAnalysisEmbedding: {
          create: vi.fn().mockResolvedValue({ id: 'mock-embedding-id' }),
        },
        $executeRawUnsafe: vi.fn().mockResolvedValue(1),
        $transaction: vi.fn().mockImplementation((fn) => fn(mockPrisma)),
      };

      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const input = createMockFrameAnalysisOutput();

      await expect(
        service.saveFrameAnalysis(input, { continueOnError: false })
      ).rejects.toThrow('Database error');
    });
  });

  // =====================================================
  // テキスト表現生成関数
  // =====================================================
  describe('animationZoneToTextRepresentation', () => {
    it('基本的なAnimationZoneでテキスト表現を生成する', () => {
      const zone = createMockAnimationZone();
      const result = animationZoneToTextRepresentation(zone);

      expect(result).toContain('fade/slide transition animation zone');
      expect(result).toContain('scroll range: 0px to 1500px');
      expect(result).toContain('duration: 1500px scroll distance');
      expect(result).toContain('average change: 2.50%');
      expect(result).toContain('peak change: 5.00%');
      expect(result).toContain('frames: frame-0000 to frame-0100');
      expect(result.endsWith('.')).toBe(true);
    });

    it('異なるanimationTypeでも正しく生成する', () => {
      const zone = createMockAnimationZone({ animationType: 'micro-interaction' });
      const result = animationZoneToTextRepresentation(zone);

      expect(result).toContain('micro-interaction animation zone');
    });
  });

  describe('layoutShiftToTextRepresentation', () => {
    it('基本的なLayoutShiftでテキスト表現を生成する', () => {
      const layoutShift = createMockLayoutShift();
      const result = layoutShiftToTextRepresentation(layoutShift);

      expect(result).toContain('layout shift detected (CLS issue)');
      expect(result).toContain('frame range: frame-0050 - frame-0060');
      expect(result).toContain('scroll range: 750px - 900px');
      expect(result).toContain('impact fraction: 0.1234');
      expect(result).toContain('bounding box: x=100, y=200, width=300, height=400');
      expect(result.endsWith('.')).toBe(true);
    });
  });

  describe('motionVectorToTextRepresentation', () => {
    it('基本的なMotionVectorでテキスト表現を生成する', () => {
      const vector = createMockMotionVector();
      const result = motionVectorToTextRepresentation(vector);

      expect(result).toContain('motion vector detected');
      expect(result).toContain('direction: right');
      expect(result).toContain('frame range: frame-0070 - frame-0080');
      expect(result).toContain('displacement: dx=50px, dy=-30px');
      expect(result).toContain('magnitude: 58.31px');
      expect(result).toContain('angle: -30.96 degrees');
      expect(result.endsWith('.')).toBe(true);
    });

    it('異なるdirectionでも正しく生成する', () => {
      const vector = createMockMotionVector({ direction: 'up' });
      const result = motionVectorToTextRepresentation(vector);

      expect(result).toContain('direction: up');
    });
  });

  // =====================================================
  // Embedding ベクトル検証（セキュリティ対応）
  // =====================================================
  describe('Embedding ベクトル検証（セキュリティ対応）', () => {
    describe('NaN値の検出', () => {
      it('EmbeddingServiceがNaN値を返した場合、エラーをスローすること', async () => {
        const vectorWithNaN = new Array(768).fill(0.1);
        vectorWithNaN[0] = NaN;

        const mockEmbeddingWithNaN: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionDbEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
        setMotionDbPrismaClientFactory(() => mockPrisma);

        const service = new MotionDbService();
        const zone = createMockAnimationZone();

        await expect(service.saveAnimationZone({ zone })).rejects.toThrow();
      });

      it('NaN値が検出された場合、$executeRawUnsafeは呼ばれないこと', async () => {
        const vectorWithNaN = new Array(768).fill(0.1);
        vectorWithNaN[383] = NaN;

        const mockEmbeddingWithNaN: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionDbEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
        setMotionDbPrismaClientFactory(() => mockPrisma);

        const service = new MotionDbService();
        const zone = createMockAnimationZone();

        try {
          await service.saveAnimationZone({ zone });
        } catch {
          // エラーは期待どおり
        }

        expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
      });
    });

    describe('Infinity値の検出', () => {
      it('EmbeddingServiceがInfinity値を返した場合、エラーをスローすること', async () => {
        const vectorWithInfinity = new Array(768).fill(0.1);
        vectorWithInfinity[0] = Infinity;

        const mockEmbeddingWithInfinity: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithInfinity),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionDbEmbeddingServiceFactory(() => mockEmbeddingWithInfinity);
        setMotionDbPrismaClientFactory(() => mockPrisma);

        const service = new MotionDbService();
        const layoutShift = createMockLayoutShift();

        await expect(
          service.saveLayoutShift({ layoutShift })
        ).rejects.toThrow();
      });
    });

    describe('次元数の検証', () => {
      it('768次元未満のベクトルを拒否すること', async () => {
        const shortVector = new Array(767).fill(0.1);

        const mockEmbeddingWithShortVector: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(shortVector),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionDbEmbeddingServiceFactory(() => mockEmbeddingWithShortVector);
        setMotionDbPrismaClientFactory(() => mockPrisma);

        const service = new MotionDbService();
        const vector = createMockMotionVector();

        await expect(service.saveMotionVector({ vector })).rejects.toThrow();
      });

      it('768次元を超えるベクトルを拒否すること', async () => {
        const longVector = new Array(769).fill(0.1);

        const mockEmbeddingWithLongVector: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(longVector),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionDbEmbeddingServiceFactory(() => mockEmbeddingWithLongVector);
        setMotionDbPrismaClientFactory(() => mockPrisma);

        const service = new MotionDbService();
        const zone = createMockAnimationZone();

        await expect(service.saveAnimationZone({ zone })).rejects.toThrow();
      });
    });
  });

  // =====================================================
  // Embedding生成エラー時の動作
  // =====================================================
  describe('Embedding生成エラー時の動作', () => {
    it('Embedding生成エラー時も保存は成功する（embedding空）', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbeddingWithError: IEmbeddingService = {
        generateEmbedding: vi
          .fn()
          .mockRejectedValue(new Error('Embedding service unavailable')),
      };

      setMotionDbEmbeddingServiceFactory(() => mockEmbeddingWithError);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const zone = createMockAnimationZone();

      const result = await service.saveAnimationZone({ zone });

      expect(result.resultId).toBeDefined();
      expect(result.embeddingId).toBeDefined();
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('EmbeddingServiceファクトリ未登録時も保存は成功する', async () => {
      const mockPrisma = createMockPrismaClient();
      // EmbeddingServiceファクトリは登録しない
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const zone = createMockAnimationZone();

      const result = await service.saveAnimationZone({ zone });

      expect(result.resultId).toBeDefined();
      expect(result.embeddingId).toBeDefined();
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // UUIDv7形式検証
  // =====================================================
  describe('UUIDv7形式', () => {
    it('resultId がUUID形式であること', async () => {
      // UUIDv7の正規表現パターン
      const uuidv7Pattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      // カスタムモック: IDを実際に生成
      const mockPrisma: IPrismaClient = {
        motionAnalysisResult: {
          create: vi.fn().mockImplementation((args) => {
            return Promise.resolve({ id: args.data.id });
          }),
        },
        motionAnalysisEmbedding: {
          create: vi.fn().mockImplementation((args) => {
            return Promise.resolve({ id: args.data.id });
          }),
        },
        $executeRawUnsafe: vi.fn().mockResolvedValue(1),
        $transaction: vi.fn().mockImplementation((fn) => fn(mockPrisma)),
      };
      const mockEmbedding = createMockEmbeddingService();

      setMotionDbEmbeddingServiceFactory(() => mockEmbedding);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const zone = createMockAnimationZone();

      const result = await service.saveAnimationZone({ zone });

      expect(result.resultId).toMatch(uuidv7Pattern);
      expect(result.embeddingId).toMatch(uuidv7Pattern);
    });
  });

  // =====================================================
  // pgvector形式検証
  // =====================================================
  describe('pgvector形式', () => {
    it('vectorString が正しいpgvector形式で生成される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockVector = new Array(768).fill(0.123);
      const mockEmbeddingService: IEmbeddingService = {
        generateEmbedding: vi.fn().mockResolvedValue(mockVector),
      };

      setMotionDbEmbeddingServiceFactory(() => mockEmbeddingService);
      setMotionDbPrismaClientFactory(() => mockPrisma);

      const service = new MotionDbService();
      const zone = createMockAnimationZone();

      await service.saveAnimationZone({ zone });

      const executeCall = (
        mockPrisma.$executeRawUnsafe as ReturnType<typeof vi.fn>
      ).mock.calls[0];

      // クエリ形式確認
      expect(executeCall[0]).toBe(
        'UPDATE motion_analysis_embeddings SET embedding = $1::vector WHERE id = $2::uuid'
      );
      // ベクトル文字列形式確認
      expect(executeCall[1]).toMatch(/^\[[\d.,]+\]$/);
      expect(executeCall[1]).toContain('0.123');
    });
  });
});
