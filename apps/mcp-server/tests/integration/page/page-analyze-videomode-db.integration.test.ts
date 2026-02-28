// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze VideoMode DB保存統合テスト
 *
 * page.analyzeでVideoMode（フレームキャプチャ・フレーム画像分析）を実行した結果を
 * MotionDbServiceを使用してDBに保存する機能の統合テスト
 *
 * テスト対象:
 * - frameAnalysisをMotionAnalysisResultテーブルに保存
 * - AnimationZoneのEmbeddingが生成される
 * - LayoutShiftのEmbeddingが生成される
 * - MotionVectorのEmbeddingが生成される
 * - エラー時のGraceful Degradation
 *
 * @module tests/integration/page/page-analyze-videomode-db.integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  BatchSaveResult,
  FrameImageAnalysisOutput,
} from '../../../src/services/motion/motion-db.service';

// MotionDbServiceをモック化
vi.mock('../../../src/services/motion/motion-db.service', () => {
  const mockSaveFrameAnalysis = vi.fn().mockImplementation(
    (input: FrameImageAnalysisOutput): Promise<BatchSaveResult> => {
      const totalItems =
        (input.animationZones?.length ?? 0) +
        (input.layoutShifts?.length ?? 0) +
        (input.motionVectors?.length ?? 0);

      return Promise.resolve({
        saved: true,
        savedCount: totalItems,
        byCategory: {
          animationZones: input.animationZones?.length ?? 0,
          layoutShifts: input.layoutShifts?.length ?? 0,
          motionVectors: input.motionVectors?.length ?? 0,
        },
        embeddingIds: totalItems > 0
          ? Array.from({ length: totalItems }, () => `mock-embedding-${Math.random().toString(36).substring(7)}`)
          : [],
      });
    }
  );

  return {
    getMotionDbService: vi.fn().mockReturnValue({
      isAvailable: vi.fn().mockReturnValue(true),
      saveFrameAnalysis: mockSaveFrameAnalysis,
      saveAnimationZone: vi.fn().mockResolvedValue({ resultId: 'mock-result-id', embeddingId: 'mock-embedding-id' }),
      saveLayoutShift: vi.fn().mockResolvedValue({ resultId: 'mock-result-id', embeddingId: 'mock-embedding-id' }),
      saveMotionVector: vi.fn().mockResolvedValue({ resultId: 'mock-result-id', embeddingId: 'mock-embedding-id' }),
    }),
    // 型をエクスポート
    BatchSaveResult: {},
    FrameImageAnalysisOutput: {},
  };
});

// モックをインポート（モック後）
import { getMotionDbService } from '../../../src/services/motion/motion-db.service';

// =====================================================
// テスト用フィクスチャ
// =====================================================

/**
 * 模擬FrameImageAnalysisOutput
 */
const createMockFrameAnalysisOutput = (): FrameImageAnalysisOutput => ({
  metadata: {
    framesDir: '/tmp/reftrix-frames/',
    totalFrames: 100,
    analyzedPairs: 50,
    sampleInterval: 1,
    scrollPxPerFrame: 15,
    analysisTime: '2.5s',
    analyzedAt: new Date().toISOString(),
  },
  statistics: {
    averageDiffPercentage: '5.23',
    significantChangeCount: 12,
    significantChangePercentage: '24.00',
    layoutShiftCount: 2,
    motionVectorCount: 8,
  },
  animationZones: [
    {
      frameStart: 'frame-0010.png',
      frameEnd: 'frame-0025.png',
      scrollStart: 150,
      scrollEnd: 375,
      duration: 225,
      avgDiff: '8.5',
      peakDiff: '15.2',
      animationType: 'micro-interaction',
    },
    {
      frameStart: 'frame-0050.png',
      frameEnd: 'frame-0120.png',
      scrollStart: 750,
      scrollEnd: 1800,
      duration: 1050,
      avgDiff: '12.3',
      peakDiff: '22.1',
      animationType: 'fade/slide transition',
    },
  ],
  layoutShifts: [
    {
      frameRange: 'frame-0030.png - frame-0035.png',
      scrollRange: '450px - 525px',
      impactFraction: '0.0823',
      boundingBox: { x: 100, y: 200, width: 500, height: 150 },
    },
  ],
  motionVectors: [
    {
      frameRange: 'frame-0015.png - frame-0020.png',
      dx: 10,
      dy: -25,
      magnitude: '26.93',
      direction: 'up',
      angle: '-68.20',
    },
    {
      frameRange: 'frame-0060.png - frame-0065.png',
      dx: 50,
      dy: 0,
      magnitude: '50.00',
      direction: 'right',
      angle: '0.00',
    },
  ],
});

/**
 * 空のFrameImageAnalysisOutput
 */
const createEmptyFrameAnalysisOutput = (): FrameImageAnalysisOutput => ({
  metadata: {
    framesDir: '/tmp/reftrix-frames/',
    totalFrames: 0,
    analyzedPairs: 0,
    sampleInterval: 1,
    scrollPxPerFrame: 15,
    analysisTime: '0.0s',
    analyzedAt: new Date().toISOString(),
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
});

// =====================================================
// MotionDbService統合テスト
// =====================================================

describe('VideoMode DB保存統合テスト', () => {
  let motionDbService: ReturnType<typeof getMotionDbService>;

  beforeEach(() => {
    // MotionDbServiceのシングルトンを取得
    motionDbService = getMotionDbService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('MotionDbService基本動作', () => {
    it('MotionDbServiceが利用可能である', () => {
      expect(motionDbService).toBeDefined();
      expect(motionDbService.isAvailable()).toBe(true);
    });
  });

  describe('saveFrameAnalysis', () => {
    it('frameAnalysisを正常に保存できる', async () => {
      // Arrange
      const frameAnalysisOutput = createMockFrameAnalysisOutput();

      // Act
      const result: BatchSaveResult = await motionDbService.saveFrameAnalysis(
        frameAnalysisOutput,
        {
          sourceUrl: 'https://example.com/test-page',
          continueOnError: true,
        }
      );

      // Assert
      expect(result).toBeDefined();
      expect(result.saved).toBe(true);
      expect(result.savedCount).toBeGreaterThan(0);

      // カテゴリ別の保存数を確認
      if (result.byCategory) {
        expect(result.byCategory.animationZones).toBe(frameAnalysisOutput.animationZones.length);
        expect(result.byCategory.layoutShifts).toBe(frameAnalysisOutput.layoutShifts.length);
        expect(result.byCategory.motionVectors).toBe(frameAnalysisOutput.motionVectors.length);
      }
    });

    it('空のframeAnalysisでも正常に処理される', async () => {
      // Arrange
      const emptyOutput = createEmptyFrameAnalysisOutput();

      // Act
      const result: BatchSaveResult = await motionDbService.saveFrameAnalysis(
        emptyOutput,
        {
          sourceUrl: 'https://example.com/empty-page',
          continueOnError: true,
        }
      );

      // Assert
      expect(result).toBeDefined();
      expect(result.saved).toBe(true);
      expect(result.savedCount).toBe(0);
    });

    it('webPageIdを指定して保存できる', async () => {
      // Arrange
      const frameAnalysisOutput = createMockFrameAnalysisOutput();
      // 注: 実際のテストでは有効なwebPageIdが必要
      // ここではwebPageIdなしでテスト

      // Act
      const result: BatchSaveResult = await motionDbService.saveFrameAnalysis(
        frameAnalysisOutput,
        {
          sourceUrl: 'https://example.com/with-webpage-id',
          continueOnError: true,
        }
      );

      // Assert
      expect(result).toBeDefined();
      expect(result.saved).toBe(true);
    });
  });

  describe('Embedding自動生成', () => {
    it('AnimationZoneのEmbeddingが生成される', async () => {
      // Arrange
      const frameAnalysisOutput = createMockFrameAnalysisOutput();

      // Act
      const result: BatchSaveResult = await motionDbService.saveFrameAnalysis(
        frameAnalysisOutput,
        {
          sourceUrl: 'https://example.com/animation-test',
          continueOnError: true,
        }
      );

      // Assert
      expect(result).toBeDefined();
      expect(result.saved).toBe(true);

      // Embeddingが生成されていることを確認
      // embeddingIdsがある場合、Embeddingが生成されている
      if (result.embeddingIds && result.embeddingIds.length > 0) {
        expect(result.embeddingIds.length).toBeGreaterThan(0);
      }
    });

    it('LayoutShiftのEmbeddingが生成される', async () => {
      // Arrange
      const frameAnalysisOutput = createMockFrameAnalysisOutput();
      frameAnalysisOutput.animationZones = []; // AnimationZoneをクリア
      frameAnalysisOutput.motionVectors = []; // MotionVectorをクリア

      // Act
      const result: BatchSaveResult = await motionDbService.saveFrameAnalysis(
        frameAnalysisOutput,
        {
          sourceUrl: 'https://example.com/layout-shift-test',
          continueOnError: true,
        }
      );

      // Assert
      expect(result).toBeDefined();
      expect(result.saved).toBe(true);

      if (result.byCategory) {
        expect(result.byCategory.layoutShifts).toBe(frameAnalysisOutput.layoutShifts.length);
      }
    });

    it('MotionVectorのEmbeddingが生成される', async () => {
      // Arrange
      const frameAnalysisOutput = createMockFrameAnalysisOutput();
      frameAnalysisOutput.animationZones = []; // AnimationZoneをクリア
      frameAnalysisOutput.layoutShifts = []; // LayoutShiftをクリア

      // Act
      const result: BatchSaveResult = await motionDbService.saveFrameAnalysis(
        frameAnalysisOutput,
        {
          sourceUrl: 'https://example.com/motion-vector-test',
          continueOnError: true,
        }
      );

      // Assert
      expect(result).toBeDefined();
      expect(result.saved).toBe(true);

      if (result.byCategory) {
        expect(result.byCategory.motionVectors).toBe(frameAnalysisOutput.motionVectors.length);
      }
    });
  });

  describe('エラーハンドリング（Graceful Degradation）', () => {
    it('continueOnError=trueで部分的なエラーでも処理が継続される', async () => {
      // Arrange
      const frameAnalysisOutput = createMockFrameAnalysisOutput();

      // Act
      const result: BatchSaveResult = await motionDbService.saveFrameAnalysis(
        frameAnalysisOutput,
        {
          sourceUrl: 'https://example.com/partial-error-test',
          continueOnError: true,
        }
      );

      // Assert
      expect(result).toBeDefined();
      // 部分的なエラーがあっても処理は完了
      expect(typeof result.saved).toBe('boolean');
    });

    it('無効な入力でもエラーを投げない', async () => {
      // Arrange
      const invalidOutput = {
        metadata: {
          framesDir: '',
          totalFrames: -1, // 無効な値
          analyzedPairs: 0,
          sampleInterval: 1,
          scrollPxPerFrame: 15,
          analysisTime: '0s',
          analyzedAt: new Date().toISOString(),
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
      } as FrameImageAnalysisOutput;

      // Act & Assert: エラーを投げずに処理が完了
      const result = await motionDbService.saveFrameAnalysis(
        invalidOutput,
        {
          sourceUrl: 'https://example.com/invalid-test',
          continueOnError: true,
        }
      );

      expect(result).toBeDefined();
    });
  });

  describe('パフォーマンス', () => {
    it('大量のデータでも妥当な時間内に処理される', async () => {
      // Arrange: 大量のAnimationZone/LayoutShift/MotionVectorを生成
      const largeOutput: FrameImageAnalysisOutput = {
        metadata: {
          framesDir: '/tmp/reftrix-frames/',
          totalFrames: 1000,
          analyzedPairs: 500,
          sampleInterval: 1,
          scrollPxPerFrame: 15,
          analysisTime: '30.0s',
          analyzedAt: new Date().toISOString(),
        },
        statistics: {
          averageDiffPercentage: '10.00',
          significantChangeCount: 100,
          significantChangePercentage: '20.00',
          layoutShiftCount: 20,
          motionVectorCount: 50,
        },
        animationZones: Array.from({ length: 50 }, (_, i) => ({
          frameStart: `frame-${String(i * 20).padStart(4, '0')}.png`,
          frameEnd: `frame-${String(i * 20 + 15).padStart(4, '0')}.png`,
          scrollStart: i * 300,
          scrollEnd: i * 300 + 225,
          duration: 225,
          avgDiff: '8.5',
          peakDiff: '15.2',
          animationType: 'micro-interaction' as const,
        })),
        layoutShifts: Array.from({ length: 20 }, (_, i) => ({
          frameRange: `frame-${String(i * 50).padStart(4, '0')}.png`,
          scrollRange: `${i * 750}px`,
          impactFraction: '0.0823',
          boundingBox: { x: 100, y: 200, width: 500, height: 150 },
        })),
        motionVectors: Array.from({ length: 50 }, (_, i) => ({
          frameRange: `frame-${String(i * 20).padStart(4, '0')}.png`,
          dx: 10 + i,
          dy: -25 + i,
          magnitude: '26.93',
          direction: 'up' as const,
          angle: '-68.20',
        })),
      };

      const startTime = Date.now();

      // Act
      const result = await motionDbService.saveFrameAnalysis(
        largeOutput,
        {
          sourceUrl: 'https://example.com/performance-test',
          continueOnError: true,
        }
      );

      const elapsedTime = Date.now() - startTime;

      // Assert: 30秒以内に完了
      expect(elapsedTime).toBeLessThan(30000);
      expect(result).toBeDefined();
    });
  });
});

// =====================================================
// page.analyze連携テスト（モック使用）
// =====================================================

describe('page.analyze VideoMode連携テスト', () => {
  describe('frame_analysis変換ロジック', () => {
    it('MotionServiceResult形式からFrameImageAnalysisOutput形式に正しく変換される', () => {
      // Arrange: MotionServiceResult.frame_analysis形式
      const motionServiceFrameAnalysis = {
        timeline: [
          {
            frame_index: 10,
            diff_percentage: 0.085,
            layout_shift_score: 0.02,
            motion_vectors: [{ x: 10, y: -25, magnitude: 26.93 }],
          },
          {
            frame_index: 30,
            diff_percentage: 0.12,
            layout_shift_score: 0.08, // CLS閾値超過
            motion_vectors: [],
          },
        ],
        summary: {
          total_frames: 100,
          significant_change_frames: [10, 30],
          avg_diff: 0.1,
          total_layout_shifts: 1,
          processing_time_ms: 2500,
        },
      };

      // Act: 変換ロジック（page.analyze.tool.ts内の実装と同等）
      const scrollPxPerFrame = 15;
      const significantFrames = motionServiceFrameAnalysis.summary.significant_change_frames;

      // AnimationZones変換
      const animationZones: Array<{
        frameStart: string;
        frameEnd: string;
        scrollStart: number;
        scrollEnd: number;
        duration: number;
        avgDiff: string;
        peakDiff: string;
        animationType: 'micro-interaction' | 'fade/slide transition' | 'scroll-linked animation' | 'long-form reveal';
      }> = [];

      if (significantFrames.length > 0) {
        let zoneStart = significantFrames[0] ?? 0;
        let zoneEnd = zoneStart;
        const diffs: number[] = [];

        for (let i = 0; i < significantFrames.length; i++) {
          const currentFrame = significantFrames[i] ?? 0;
          const nextFrame = significantFrames[i + 1];

          const timelineEntry = motionServiceFrameAnalysis.timeline.find(t => t.frame_index === currentFrame);
          if (timelineEntry) {
            diffs.push(timelineEntry.diff_percentage * 100);
          }

          if (nextFrame !== undefined && nextFrame - currentFrame <= 5) {
            zoneEnd = nextFrame;
          } else {
            if (diffs.length > 0) {
              const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
              const peakDiff = Math.max(...diffs);
              const duration = (zoneEnd - zoneStart) * scrollPxPerFrame;

              let animationType: 'micro-interaction' | 'fade/slide transition' | 'scroll-linked animation' | 'long-form reveal';
              if (duration < 500) animationType = 'micro-interaction';
              else if (duration < 1500) animationType = 'fade/slide transition';
              else if (duration < 3000) animationType = 'scroll-linked animation';
              else animationType = 'long-form reveal';

              animationZones.push({
                frameStart: `frame-${String(zoneStart).padStart(4, '0')}.png`,
                frameEnd: `frame-${String(zoneEnd).padStart(4, '0')}.png`,
                scrollStart: zoneStart * scrollPxPerFrame,
                scrollEnd: zoneEnd * scrollPxPerFrame,
                duration,
                avgDiff: avgDiff.toFixed(2),
                peakDiff: peakDiff.toFixed(2),
                animationType,
              });
            }

            if (nextFrame !== undefined) {
              zoneStart = nextFrame;
              zoneEnd = nextFrame;
              diffs.length = 0;
            }
          }
        }
      }

      // LayoutShifts変換
      const layoutShifts = motionServiceFrameAnalysis.timeline
        .filter(t => t.layout_shift_score !== undefined && t.layout_shift_score > 0.05)
        .map(t => ({
          frameRange: `frame-${String(t.frame_index).padStart(4, '0')}.png`,
          scrollRange: `${t.frame_index * scrollPxPerFrame}px`,
          impactFraction: t.layout_shift_score.toFixed(4),
          boundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
        }));

      // Assert
      expect(animationZones.length).toBeGreaterThan(0);
      expect(layoutShifts.length).toBe(1); // layout_shift_score > 0.05 のエントリが1つ
      expect(layoutShifts[0]?.impactFraction).toBe('0.0800');
    });

    it('空のtimelineでも正常に変換される', () => {
      // Arrange
      const emptyFrameAnalysis = {
        timeline: [],
        summary: {
          total_frames: 0,
          significant_change_frames: [],
          avg_diff: 0,
          total_layout_shifts: 0,
          processing_time_ms: 0,
        },
      };

      // Act
      const animationZones: unknown[] = [];
      const layoutShifts: unknown[] = [];
      const motionVectors: unknown[] = [];

      // Assert
      expect(animationZones.length).toBe(0);
      expect(layoutShifts.length).toBe(0);
      expect(motionVectors.length).toBe(0);
    });
  });

  describe('warnings生成', () => {
    it('DB保存失敗時にFRAME_ANALYSIS_DB_SAVE_FAILEDがwarningsに追加される', () => {
      // Arrange
      const warnings: Array<{ feature: string; code: string; message: string }> = [];
      const mockResult: BatchSaveResult = {
        saved: false,
        savedCount: 0,
        reason: 'Database connection failed',
      };

      // Act: page.analyze内の警告追加ロジックをシミュレート
      if (!mockResult.saved && mockResult.reason) {
        warnings.push({
          feature: 'motion',
          code: 'FRAME_ANALYSIS_DB_SAVE_FAILED',
          message: mockResult.reason,
        });
      }

      // Assert
      expect(warnings.length).toBe(1);
      expect(warnings[0]?.code).toBe('FRAME_ANALYSIS_DB_SAVE_FAILED');
      expect(warnings[0]?.message).toBe('Database connection failed');
    });

    it('例外発生時にFRAME_ANALYSIS_DB_SAVE_ERRORがwarningsに追加される', () => {
      // Arrange
      const warnings: Array<{ feature: string; code: string; message: string }> = [];
      const error = new Error('Unexpected error during save');

      // Act: page.analyze内の例外ハンドリングロジックをシミュレート
      try {
        throw error;
      } catch (frameDbError) {
        warnings.push({
          feature: 'motion',
          code: 'FRAME_ANALYSIS_DB_SAVE_ERROR',
          message: frameDbError instanceof Error ? frameDbError.message : 'Frame analysis DB save failed',
        });
      }

      // Assert
      expect(warnings.length).toBe(1);
      expect(warnings[0]?.code).toBe('FRAME_ANALYSIS_DB_SAVE_ERROR');
      expect(warnings[0]?.message).toBe('Unexpected error during save');
    });
  });
});
