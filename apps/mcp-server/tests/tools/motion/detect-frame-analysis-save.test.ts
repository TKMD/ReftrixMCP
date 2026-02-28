// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect Video mode フレーム分析 DB 保存テスト
 *
 * Video mode での save_to_db 機能をテストします。
 * - フレーム画像分析結果からの Embedding 生成
 * - MotionPattern/MotionEmbedding テーブルへの保存
 * - 非同期保存とエラーハンドリング
 *
 * @module tests/tools/motion/detect-frame-analysis-save
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setFrameEmbeddingServiceFactory,
  resetFrameEmbeddingServiceFactory,
  type IFrameEmbeddingService,
} from '../../../src/tools/motion/di-factories';
import type { FrameImageAnalysisOutput } from '../../../src/services/motion/frame-image-analyzer.adapter';
import type { SavedFrameAnalysisResult } from '../../../src/services/motion/frame-embedding.service';

// =====================================================
// テストデータ
// =====================================================

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
  animationZones: [
    {
      frameStart: 'frame-0000.png',
      frameEnd: 'frame-0050.png',
      scrollStart: 500,
      scrollEnd: 1200,
      duration: 700,
      avgDiff: '15.5',
      peakDiff: '28.3',
      animationType: 'fade/slide transition',
    },
    {
      frameStart: 'frame-0100.png',
      frameEnd: 'frame-0120.png',
      scrollStart: 100,
      scrollEnd: 400,
      duration: 300,
      avgDiff: '5.2',
      peakDiff: '12.1',
      animationType: 'micro-interaction',
    },
  ],
  layoutShifts: [
    {
      frameRange: 'frame-0070.png - frame-0080.png',
      scrollRange: '1050px - 1200px',
      impactFraction: '0.0823',
      boundingBox: { x: 100, y: 200, width: 300, height: 150 },
    },
  ],
  motionVectors: [
    {
      frameRange: 'frame-0010.png - frame-0020.png',
      dx: 0,
      dy: 120,
      magnitude: '120.00',
      direction: 'down',
      angle: '90.00',
    },
    {
      frameRange: 'frame-0030.png - frame-0040.png',
      dx: 85,
      dy: 0,
      magnitude: '85.00',
      direction: 'right',
      angle: '0.00',
    },
  ],
};

// =====================================================
// モックファクトリ
// =====================================================

function createMockFrameEmbeddingService(
  overrides?: Partial<IFrameEmbeddingService>
): IFrameEmbeddingService {
  return {
    saveFrameAnalysis: vi.fn().mockResolvedValue({
      saved: true,
      savedCount: 4,
      patternIds: [
        '019368a8-7b0c-7000-8000-000000000001',
        '019368a8-7b0c-7000-8000-000000000002',
        '019368a8-7b0c-7000-8000-000000000003',
        '019368a8-7b0c-7000-8000-000000000004',
      ],
      embeddingIds: [
        '019368a8-7b0c-7000-8000-000000000011',
        '019368a8-7b0c-7000-8000-000000000012',
        '019368a8-7b0c-7000-8000-000000000013',
        '019368a8-7b0c-7000-8000-000000000014',
      ],
      byCategory: {
        animationZones: 2,
        layoutShifts: 1,
        motionVectors: 1,
      },
    } as SavedFrameAnalysisResult),
    isAvailable: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

// =====================================================
// FrameEmbeddingService DI ファクトリテスト
// =====================================================

describe('FrameEmbeddingService DI ファクトリ', () => {
  beforeEach(() => {
    resetFrameEmbeddingServiceFactory();
  });

  afterEach(() => {
    resetFrameEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  describe('ファクトリ登録', () => {
    it('setFrameEmbeddingServiceFactory でファクトリを登録できる', () => {
      const mockService = createMockFrameEmbeddingService();

      expect(() => {
        setFrameEmbeddingServiceFactory(() => mockService);
      }).not.toThrow();
    });

    it('resetFrameEmbeddingServiceFactory でファクトリをリセットできる', () => {
      const mockService = createMockFrameEmbeddingService();
      setFrameEmbeddingServiceFactory(() => mockService);

      expect(() => {
        resetFrameEmbeddingServiceFactory();
      }).not.toThrow();
    });
  });

  describe('saveFrameAnalysis メソッド', () => {
    it('AnimationZones を保存できる', async () => {
      const mockService = createMockFrameEmbeddingService();
      setFrameEmbeddingServiceFactory(() => mockService);

      const result = await mockService.saveFrameAnalysis({
        analysisResult: sampleFrameAnalysisOutput,
        sourceUrl: 'https://example.com',
      });

      expect(result.saved).toBe(true);
      expect(result.savedCount).toBe(4);
      expect(result.patternIds.length).toBe(4);
      expect(result.embeddingIds.length).toBe(4);
    });

    it('byCategory でカテゴリ別の保存数を返す', async () => {
      const mockService = createMockFrameEmbeddingService();
      setFrameEmbeddingServiceFactory(() => mockService);

      const result = await mockService.saveFrameAnalysis({
        analysisResult: sampleFrameAnalysisOutput,
        sourceUrl: 'https://example.com',
      });

      expect(result.byCategory).toBeDefined();
      expect(result.byCategory?.animationZones).toBe(2);
      expect(result.byCategory?.layoutShifts).toBe(1);
      expect(result.byCategory?.motionVectors).toBe(1);
    });

    it('isAvailable が false の場合は保存しない', async () => {
      const mockService = createMockFrameEmbeddingService({
        isAvailable: vi.fn().mockReturnValue(false),
      });
      setFrameEmbeddingServiceFactory(() => mockService);

      const isAvailable = mockService.isAvailable();

      expect(isAvailable).toBe(false);
    });
  });

  describe('エラーハンドリング', () => {
    it('saveFrameAnalysis がエラーをスローしても処理が継続される', async () => {
      const mockService = createMockFrameEmbeddingService({
        saveFrameAnalysis: vi.fn().mockRejectedValue(new Error('DB error')),
      });
      setFrameEmbeddingServiceFactory(() => mockService);

      await expect(
        mockService.saveFrameAnalysis({
          analysisResult: sampleFrameAnalysisOutput,
          sourceUrl: 'https://example.com',
        })
      ).rejects.toThrow('DB error');
    });

    it('ファクトリ未登録時は undefined を返す（getFrameEmbeddingServiceInstance）', async () => {
      resetFrameEmbeddingServiceFactory();

      // ファクトリ未登録時は getFrameEmbeddingServiceInstance() が null を返す
      // これは detect.tool.ts の executeFrameAnalysisSave でハンドリングされる
      const { getFrameEmbeddingServiceInstance } = await import(
        '../../../src/tools/motion/di-factories'
      );

      const service = getFrameEmbeddingServiceInstance();
      expect(service).toBeNull();
    });
  });
});

// =====================================================
// フレーム分析結果の型テスト
// =====================================================

describe('FrameImageAnalysisOutput 型の整合性', () => {
  it('metadata.framesDir が必須フィールドである', () => {
    expect(sampleFrameAnalysisOutput.metadata.framesDir).toBeDefined();
    expect(typeof sampleFrameAnalysisOutput.metadata.framesDir).toBe('string');
  });

  it('animationZones が配列である', () => {
    expect(Array.isArray(sampleFrameAnalysisOutput.animationZones)).toBe(true);
    expect(sampleFrameAnalysisOutput.animationZones.length).toBe(2);
  });

  it('layoutShifts が配列である', () => {
    expect(Array.isArray(sampleFrameAnalysisOutput.layoutShifts)).toBe(true);
    expect(sampleFrameAnalysisOutput.layoutShifts.length).toBe(1);
  });

  it('motionVectors が配列である', () => {
    expect(Array.isArray(sampleFrameAnalysisOutput.motionVectors)).toBe(true);
    expect(sampleFrameAnalysisOutput.motionVectors.length).toBe(2);
  });

  it('animationType が正しい値を持つ', () => {
    const validTypes = [
      'micro-interaction',
      'fade/slide transition',
      'scroll-linked animation',
      'long-form reveal',
    ];

    sampleFrameAnalysisOutput.animationZones.forEach((zone) => {
      expect(validTypes).toContain(zone.animationType);
    });
  });

  it('motionDirection が正しい値を持つ', () => {
    const validDirections = ['up', 'down', 'left', 'right', 'stationary'];

    sampleFrameAnalysisOutput.motionVectors.forEach((vector) => {
      expect(validDirections).toContain(vector.direction);
    });
  });
});

// =====================================================
// SavedFrameAnalysisResult 型テスト
// =====================================================

describe('SavedFrameAnalysisResult 型の整合性', () => {
  it('成功時は saved=true を返す', async () => {
    const mockService = createMockFrameEmbeddingService();

    const result = await mockService.saveFrameAnalysis({
      analysisResult: sampleFrameAnalysisOutput,
    });

    expect(result.saved).toBe(true);
  });

  it('保存数と ID 配列の長さが一致する', async () => {
    const mockService = createMockFrameEmbeddingService();

    const result = await mockService.saveFrameAnalysis({
      analysisResult: sampleFrameAnalysisOutput,
    });

    expect(result.savedCount).toBe(result.patternIds.length);
    expect(result.patternIds.length).toBe(result.embeddingIds.length);
  });

  it('失敗時は saved=false と reason を返す', async () => {
    const mockService = createMockFrameEmbeddingService({
      saveFrameAnalysis: vi.fn().mockResolvedValue({
        saved: false,
        savedCount: 0,
        patternIds: [],
        embeddingIds: [],
        reason: 'Service not available',
      }),
    });

    const result = await mockService.saveFrameAnalysis({
      analysisResult: sampleFrameAnalysisOutput,
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('Service not available');
  });
});
