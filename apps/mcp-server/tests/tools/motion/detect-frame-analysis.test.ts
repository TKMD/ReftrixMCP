// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect Frame Image Analysis 統合テスト
 *
 * Phase5: Frame Image Analysis (Pixelmatch + Sharp) 統合
 *
 * テスト対象:
 * - analyze_frames パラメータでフレーム画像分析を有効化
 * - frame_analysis_options でオプション設定
 * - video mode と組み合わせて使用可能
 * - 分析結果の取得と出力
 *   - metadata (総フレーム数、分析ペア数、サンプル間隔等)
 *   - statistics (平均差分、有意な変化数、レイアウトシフト数等)
 *   - animationZones (アニメーションゾーン検出)
 *   - layoutShifts (CLS問題検出)
 *   - motionVectors (モーション方向・速度)
 *
 * @module tests/tools/motion/detect-frame-analysis.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// インポート
// =====================================================

import {
  motionDetectInputSchema,
  frameImageAnalysisInputOptionsSchema,
  type MotionDetectInput,
  type FrameImageAnalysisInputOptions,
} from '../../../src/tools/motion/schemas';

import {
  motionDetectHandler,
  setFrameImageAnalysisServiceFactory,
  resetFrameImageAnalysisServiceFactory,
  setVideoRecorderServiceFactory,
  resetVideoRecorderServiceFactory,
  setFrameAnalyzerServiceFactory,
  resetFrameAnalyzerServiceFactory,
  type IFrameImageAnalysisService,
  type IVideoRecorderService,
  type IFrameAnalyzerService,
  type FrameImageAnalysisOutput,
} from '../../../src/tools/motion/detect.tool';

import type { RecordResult } from '../../../src/services/page/video-recorder.service';
import type { AnalyzeResult, ExtractResult } from '../../../src/services/page/frame-analyzer.service';

// =====================================================
// テストデータ
// =====================================================

const sampleUrl = 'https://example.com/animated-page';

/**
 * モック録画結果（Video Mode用）
 */
const mockRecordResult: RecordResult = {
  videoPath: '/tmp/video-recorder-test/video.webm',
  durationMs: 5000,
  sizeBytes: 1024 * 100,
  title: 'Test Page',
  processingTimeMs: 3000,
};

/**
 * モックフレーム抽出結果
 */
const mockExtractResult: ExtractResult = {
  frames: [
    { index: 0, path: '/tmp/frames/frame-0000.png', timestampMs: 0 },
    { index: 1, path: '/tmp/frames/frame-0001.png', timestampMs: 100 },
  ],
  totalFrames: 50,
  fps: 10,
  durationMs: 5000,
  outputDir: '/tmp/frames',
  processingTimeMs: 200,
};

/**
 * モックフレーム解析結果（Video Mode用）
 */
const mockAnalyzeResult: AnalyzeResult = {
  diffs: [],
  totalFrames: 50,
  motionSegments: [
    {
      startMs: 500,
      endMs: 1500,
      durationMs: 1000,
      avgChangeRatio: 0.08,
      maxChangeRatio: 0.15,
      estimatedType: 'fade',
      estimatedEasing: 'ease-out',
    },
  ],
  motionCoverage: 0.20,
  durationMs: 5000,
  processingTimeMs: 500,
};

/**
 * モックFrame Image Analysis結果
 */
const mockFrameImageAnalysisResult: FrameImageAnalysisOutput = {
  metadata: {
    totalFrames: 200,
    analyzedPairs: 20,
    sampleInterval: 10,
    scrollPxPerFrame: 15,
    analysisTime: '1.5s',
    analyzedAt: new Date().toISOString(),
  },
  statistics: {
    averageDiffPercentage: 2.5,
    significantChangeCount: 8,
    significantChangePercentage: 40,
    layoutShiftCount: 2,
    motionVectorCount: 5,
  },
  animationZones: [
    {
      frameStart: 'frame-0050.png',
      frameEnd: 'frame-0100.png',
      scrollStart: 750,
      scrollEnd: 1500,
      avgDiff: 3.2,
      peakDiff: 8.5,
      duration: 750,
      animationType: 'scroll-linked animation',
    },
  ],
  layoutShifts: [
    {
      frameRange: 'frame-0150.png - frame-0160.png',
      scrollRange: '2250px - 2400px',
      impactFraction: 0.08,
      boundingBox: { x: 100, y: 200, width: 400, height: 150 },
    },
  ],
  motionVectors: [
    {
      frameRange: 'frame-0050.png - frame-0060.png',
      dx: 0,
      dy: 50,
      magnitude: 50,
      direction: 'down',
      angle: 90,
    },
  ],
};

// =====================================================
// モックサービス
// =====================================================

/**
 * モックVideoRecorderService
 */
function createMockVideoRecorderService(): IVideoRecorderService {
  return {
    record: vi.fn().mockResolvedValue(mockRecordResult),
    cleanup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * モックFrameAnalyzerService
 */
function createMockFrameAnalyzerService(): IFrameAnalyzerService {
  return {
    extractFrames: vi.fn().mockResolvedValue(mockExtractResult),
    analyzeMotion: vi.fn().mockResolvedValue(mockAnalyzeResult),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * モックFrameImageAnalysisService（成功ケース）
 */
function createMockFrameImageAnalysisService(
  result: FrameImageAnalysisOutput = mockFrameImageAnalysisResult
): IFrameImageAnalysisService {
  return {
    analyze: vi.fn().mockResolvedValue(result),
    isAvailable: vi.fn().mockReturnValue(true),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * モックFrameImageAnalysisService（利用不可ケース）
 */
function createMockUnavailableFrameImageAnalysisService(): IFrameImageAnalysisService {
  return {
    analyze: vi.fn(),
    isAvailable: vi.fn().mockReturnValue(false),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * モックFrameImageAnalysisService（エラーケース）
 */
function createMockErrorFrameImageAnalysisService(
  errorMessage: string = 'Analysis failed'
): IFrameImageAnalysisService {
  return {
    analyze: vi.fn().mockRejectedValue(new Error(errorMessage)),
    isAvailable: vi.fn().mockReturnValue(true),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

// =====================================================
// テストスイート
// =====================================================

describe('motion.detect Frame Image Analysis (Phase5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // ファクトリをリセット
    resetFrameImageAnalysisServiceFactory();
    resetVideoRecorderServiceFactory();
    resetFrameAnalyzerServiceFactory();
  });

  // =====================================================
  // スキーマバリデーションテスト
  // =====================================================

  describe('Schema Validation', () => {
    it('should accept analyze_frames=true', () => {
      const input: Partial<MotionDetectInput> = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: true,
      };

      const result = motionDetectInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.analyze_frames).toBe(true);
      }
    });

    it('should default analyze_frames to true (video mode enabled by default)', () => {
      // video modeはデフォルトで有効（current-architecture.md準拠）
      // パフォーマンス最適化のため無効化する場合は明示的に analyze_frames: false を指定
      const input: Partial<MotionDetectInput> = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      const result = motionDetectInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.analyze_frames).toBe(true);
      }
    });

    it('should allow explicit disabling of analyze_frames', () => {
      const input: Partial<MotionDetectInput> = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: false,
      };

      const result = motionDetectInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.analyze_frames).toBe(false);
      }
    });

    it('should accept frame_analysis_options with all parameters', () => {
      const options: FrameImageAnalysisInputOptions = {
        frame_dir: 'custom-frames/',
        sample_interval: 5,
        diff_threshold: 0.15,
        cls_threshold: 0.1,
        motion_threshold: 100,
        output_diff_images: true,
        parallel: false,
      };

      const result = frameImageAnalysisInputOptionsSchema.safeParse(options);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.frame_dir).toBe('custom-frames/');
        expect(result.data.sample_interval).toBe(5);
        expect(result.data.diff_threshold).toBe(0.15);
        expect(result.data.cls_threshold).toBe(0.1);
        expect(result.data.motion_threshold).toBe(100);
        expect(result.data.output_diff_images).toBe(true);
        expect(result.data.parallel).toBe(false);
      }
    });

    it('should apply defaults for frame_analysis_options', () => {
      const options = {};

      const result = frameImageAnalysisInputOptionsSchema.safeParse(options);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sample_interval).toBe(10);
        expect(result.data.diff_threshold).toBe(0.1);
        expect(result.data.cls_threshold).toBe(0.05);
        expect(result.data.motion_threshold).toBe(50);
        expect(result.data.output_diff_images).toBe(false);
        expect(result.data.parallel).toBe(true);
      }
    });

    it('should reject frame_dir with path traversal', () => {
      const options = {
        frame_dir: '../../../etc/passwd',
      };

      const result = frameImageAnalysisInputOptionsSchema.safeParse(options);
      expect(result.success).toBe(false);
    });

    it('should validate sample_interval range (1-100)', () => {
      // 0は無効
      expect(
        frameImageAnalysisInputOptionsSchema.safeParse({ sample_interval: 0 }).success
      ).toBe(false);

      // 101は無効
      expect(
        frameImageAnalysisInputOptionsSchema.safeParse({ sample_interval: 101 }).success
      ).toBe(false);

      // 1は有効
      expect(
        frameImageAnalysisInputOptionsSchema.safeParse({ sample_interval: 1 }).success
      ).toBe(true);

      // 100は有効
      expect(
        frameImageAnalysisInputOptionsSchema.safeParse({ sample_interval: 100 }).success
      ).toBe(true);
    });

    it('should validate diff_threshold range (0-1)', () => {
      expect(
        frameImageAnalysisInputOptionsSchema.safeParse({ diff_threshold: -0.1 }).success
      ).toBe(false);

      expect(
        frameImageAnalysisInputOptionsSchema.safeParse({ diff_threshold: 1.1 }).success
      ).toBe(false);

      expect(
        frameImageAnalysisInputOptionsSchema.safeParse({ diff_threshold: 0 }).success
      ).toBe(true);

      expect(
        frameImageAnalysisInputOptionsSchema.safeParse({ diff_threshold: 1 }).success
      ).toBe(true);
    });
  });

  // =====================================================
  // 正常系テスト
  // =====================================================

  describe('Successful Analysis', () => {
    it('should return frame_analysis when analyze_frames=true', async () => {
      // セットアップ
      const mockVideoRecorder = createMockVideoRecorderService();
      const mockFrameAnalyzer = createMockFrameAnalyzerService();
      const mockFrameImageAnalysis = createMockFrameImageAnalysisService();

      setVideoRecorderServiceFactory(() => mockVideoRecorder);
      setFrameAnalyzerServiceFactory(() => mockFrameAnalyzer);
      setFrameImageAnalysisServiceFactory(() => mockFrameImageAnalysis);

      // 実行
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: true,
      };

      const result = await motionDetectHandler(input);

      // 検証
      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.frame_analysis).toBeDefined();
        expect(result.data.frame_analysis?.metadata).toBeDefined();
        expect(result.data.frame_analysis?.statistics).toBeDefined();
        expect(result.data.frame_analysis?.animationZones).toBeDefined();
        expect(result.data.frame_analysis?.layoutShifts).toBeDefined();
        expect(result.data.frame_analysis?.motionVectors).toBeDefined();

        // メタデータの検証
        expect(result.data.frame_analysis?.metadata.totalFrames).toBe(200);
        expect(result.data.frame_analysis?.metadata.analyzedPairs).toBe(20);
        expect(result.data.frame_analysis?.metadata.sampleInterval).toBe(10);
        expect(result.data.frame_analysis?.metadata.scrollPxPerFrame).toBe(15);

        // 統計の検証
        expect(result.data.frame_analysis?.statistics.layoutShiftCount).toBe(2);
        expect(result.data.frame_analysis?.statistics.motionVectorCount).toBe(5);

        // frame_analysis_errorがないことを確認
        expect(result.data.frame_analysis_error).toBeUndefined();
      }
    });

    it('should pass custom options to analysis service', async () => {
      // セットアップ
      const mockVideoRecorder = createMockVideoRecorderService();
      const mockFrameAnalyzer = createMockFrameAnalyzerService();
      const mockFrameImageAnalysis = createMockFrameImageAnalysisService();

      setVideoRecorderServiceFactory(() => mockVideoRecorder);
      setFrameAnalyzerServiceFactory(() => mockFrameAnalyzer);
      setFrameImageAnalysisServiceFactory(() => mockFrameImageAnalysis);

      // 実行
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: true,
        frame_analysis_options: {
          frame_dir: 'custom-frames/',
          sample_interval: 5,
          diff_threshold: 0.2,
          cls_threshold: 0.1,
          motion_threshold: 100,
          output_diff_images: true,
          parallel: false,
        },
      };

      await motionDetectHandler(input);

      // サービスに正しいオプションが渡されたことを確認
      expect(mockFrameImageAnalysis.analyze).toHaveBeenCalledWith(
        'custom-frames/',
        expect.objectContaining({
          sampleInterval: 5,
          diffThreshold: 0.2,
          clsThreshold: 0.1,
          motionThreshold: 100,
          outputDiffImages: true,
          parallel: false,
          scrollPxPerFrame: 15, // Reftrix default
        })
      );
    });

    it('should use frame_capture_options.output_dir when frame_dir not specified', async () => {
      // セットアップ
      const mockVideoRecorder = createMockVideoRecorderService();
      const mockFrameAnalyzer = createMockFrameAnalyzerService();
      const mockFrameImageAnalysis = createMockFrameImageAnalysisService();

      setVideoRecorderServiceFactory(() => mockVideoRecorder);
      setFrameAnalyzerServiceFactory(() => mockFrameAnalyzer);
      setFrameImageAnalysisServiceFactory(() => mockFrameImageAnalysis);

      // 実行
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: true,
        frame_capture_options: {
          output_dir: 'captured-frames/',
        },
      };

      await motionDetectHandler(input);

      // frame_capture_options.output_dirが使用されたことを確認
      // validateAndNormalizeOutputDirにより絶対パスに変換される
      expect(mockFrameImageAnalysis.analyze).toHaveBeenCalledWith(
        expect.stringContaining('captured-frames/'),
        expect.any(Object)
      );
    });

    it('should include frame_analysis_processing_time_ms in metadata', async () => {
      // セットアップ
      const mockVideoRecorder = createMockVideoRecorderService();
      const mockFrameAnalyzer = createMockFrameAnalyzerService();
      const mockFrameImageAnalysis = createMockFrameImageAnalysisService();

      setVideoRecorderServiceFactory(() => mockVideoRecorder);
      setFrameAnalyzerServiceFactory(() => mockFrameAnalyzer);
      setFrameImageAnalysisServiceFactory(() => mockFrameImageAnalysis);

      // 実行
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: true,
      };

      const result = await motionDetectHandler(input);

      // 検証
      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.metadata?.frame_analysis_processing_time_ms).toBeDefined();
        expect(typeof result.data.metadata?.frame_analysis_processing_time_ms).toBe('number');
      }
    });
  });

  // =====================================================
  // Graceful Degradationテスト
  // =====================================================

  describe('Graceful Degradation', () => {
    it('should add warning when service is unavailable', async () => {
      // セットアップ
      const mockVideoRecorder = createMockVideoRecorderService();
      const mockFrameAnalyzer = createMockFrameAnalyzerService();
      const mockFrameImageAnalysis = createMockUnavailableFrameImageAnalysisService();

      setVideoRecorderServiceFactory(() => mockVideoRecorder);
      setFrameAnalyzerServiceFactory(() => mockFrameAnalyzer);
      setFrameImageAnalysisServiceFactory(() => mockFrameImageAnalysis);

      // 実行
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: true,
      };

      const result = await motionDetectHandler(input);

      // 検証
      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // frame_analysisはnullまたはundefined
        expect(result.data.frame_analysis).toBeFalsy();

        // 警告が含まれていること
        const warning = result.data.warnings?.find(
          (w) => w.code === 'FRAME_ANALYSIS_UNAVAILABLE'
        );
        expect(warning).toBeDefined();
        expect(warning?.severity).toBe('warning');
      }
    });

    it('should use default implementation when factory not configured', async () => {
      // セットアップ（FrameImageAnalysisFactoryは設定しない）
      // v0.1.0以降: デフォルト実装（FrameImageAnalyzerAdapter）が使用される
      const mockVideoRecorder = createMockVideoRecorderService();
      const mockFrameAnalyzer = createMockFrameAnalyzerService();

      setVideoRecorderServiceFactory(() => mockVideoRecorder);
      setFrameAnalyzerServiceFactory(() => mockFrameAnalyzer);
      // setFrameImageAnalysisServiceFactory は呼び出さない
      // → デフォルト実装（FrameImageAnalyzerAdapter）が使用される

      // 実行
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: true,
      };

      const result = await motionDetectHandler(input);

      // 検証: 成功するが、フレームディレクトリが存在しないためエラーになる
      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // デフォルト実装が使用されるため、以下のいずれかになる:
        // 1. frame_analysis が返される（成功時）
        // 2. frame_analysis_error が返される（フレームディレクトリが存在しない場合）
        // 3. 警告が含まれる（サービスが利用不可と判定された場合）

        // フレームディレクトリが存在しないため、エラーまたは警告になることを確認
        const hasFrameAnalysis = result.data.frame_analysis != null;
        const hasFrameAnalysisError = result.data.frame_analysis_error != null;
        const hasWarning = result.data.warnings?.some(
          (w) => w.code === 'FRAME_ANALYSIS_UNAVAILABLE' || w.code === 'FRAME_ANALYSIS_ERROR'
        );

        // いずれかの状態になっていることを確認
        expect(hasFrameAnalysis || hasFrameAnalysisError || hasWarning).toBe(true);
      }
    });

    it('should return frame_analysis_error on analysis failure', async () => {
      // セットアップ
      const mockVideoRecorder = createMockVideoRecorderService();
      const mockFrameAnalyzer = createMockFrameAnalyzerService();
      const mockFrameImageAnalysis = createMockErrorFrameImageAnalysisService(
        'Frame loading failed: invalid PNG file'
      );

      setVideoRecorderServiceFactory(() => mockVideoRecorder);
      setFrameAnalyzerServiceFactory(() => mockFrameAnalyzer);
      setFrameImageAnalysisServiceFactory(() => mockFrameImageAnalysis);

      // 実行
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: true,
      };

      const result = await motionDetectHandler(input);

      // 検証
      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // frame_analysisはnull
        expect(result.data.frame_analysis).toBeFalsy();

        // frame_analysis_errorが含まれていること
        expect(result.data.frame_analysis_error).toBeDefined();
        expect(result.data.frame_analysis_error?.code).toBe('FRAME_ANALYSIS_ERROR');
        expect(result.data.frame_analysis_error?.message).toContain('Frame loading failed');
      }
    });

    it('should detect timeout errors', async () => {
      // セットアップ
      const mockVideoRecorder = createMockVideoRecorderService();
      const mockFrameAnalyzer = createMockFrameAnalyzerService();
      const mockFrameImageAnalysis = createMockErrorFrameImageAnalysisService(
        'Analysis timed out after 30000ms'
      );

      setVideoRecorderServiceFactory(() => mockVideoRecorder);
      setFrameAnalyzerServiceFactory(() => mockFrameAnalyzer);
      setFrameImageAnalysisServiceFactory(() => mockFrameImageAnalysis);

      // 実行
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: true,
      };

      const result = await motionDetectHandler(input);

      // 検証
      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.frame_analysis_error).toBeDefined();
        // タイムアウトエラーはFRAME_ANALYSIS_ERRORとして返される
        expect(result.data.frame_analysis_error?.code).toBe('FRAME_ANALYSIS_ERROR');
      }
    });
  });

  // =====================================================
  // analyze_frames=false のテスト
  // =====================================================

  describe('Disabled Frame Analysis', () => {
    it('should not call analysis service when analyze_frames=false', async () => {
      // セットアップ
      const mockVideoRecorder = createMockVideoRecorderService();
      const mockFrameAnalyzer = createMockFrameAnalyzerService();
      const mockFrameImageAnalysis = createMockFrameImageAnalysisService();

      setVideoRecorderServiceFactory(() => mockVideoRecorder);
      setFrameAnalyzerServiceFactory(() => mockFrameAnalyzer);
      setFrameImageAnalysisServiceFactory(() => mockFrameImageAnalysis);

      // 実行
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: false,
      };

      const result = await motionDetectHandler(input);

      // 検証
      expect(result.success).toBe(true);
      expect(mockFrameImageAnalysis.analyze).not.toHaveBeenCalled();
      expect(mockFrameImageAnalysis.isAvailable).not.toHaveBeenCalled();

      if (result.success && result.data) {
        // analyze_frames=false の場合、frame_analysisはnullまたはundefined
        expect(result.data.frame_analysis).toBeFalsy();
        expect(result.data.frame_analysis_error).toBeFalsy();
      }
    });

    it('should not include frame_analysis_processing_time_ms when disabled', async () => {
      // セットアップ
      const mockVideoRecorder = createMockVideoRecorderService();
      const mockFrameAnalyzer = createMockFrameAnalyzerService();

      setVideoRecorderServiceFactory(() => mockVideoRecorder);
      setFrameAnalyzerServiceFactory(() => mockFrameAnalyzer);

      // 実行
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        analyze_frames: false,
      };

      const result = await motionDetectHandler(input);

      // 検証
      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.metadata?.frame_analysis_processing_time_ms).toBeUndefined();
      }
    });
  });
});
