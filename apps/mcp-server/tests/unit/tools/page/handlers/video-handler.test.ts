// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video Handler Unit Tests
 *
 * video-handler.ts のユニットテスト
 * DB依存なし、外部サービス（Playwright、Frame Capture）はモック化
 *
 * カバレッジ目標:
 * - Statement: > 80%
 * - Branch: > 70%
 * - Function: > 85%
 *
 * @module tests/unit/tools/page/handlers/video-handler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// モック定義（vi.mockはホイスティングされるため、先に定義）
vi.mock('../../../../../src/tools/motion/detect.tool', () => ({
  executeFrameCapture: vi.fn(),
  getFrameImageAnalysisService: vi.fn(),
}));

vi.mock('../../../../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// インポート（モック定義後）
import { executeVideoMode } from '../../../../../src/tools/page/handlers/video-handler';
import { executeFrameCapture, getFrameImageAnalysisService } from '../../../../../src/tools/motion/detect.tool';
import { isDevelopment } from '../../../../../src/utils/logger';

// モック参照取得
const mockExecuteFrameCapture = vi.mocked(executeFrameCapture);
const mockGetFrameImageAnalysisService = vi.mocked(getFrameImageAnalysisService);
const mockIsDevelopment = vi.mocked(isDevelopment);

// =====================================================
// テスト用データ
// =====================================================

const TEST_URL = 'https://example.com';

const MOCK_FRAME_CAPTURE_RESULT = {
  total_frames: 100,
  output_dir: '/tmp/reftrix-frames/',
  config: {
    scroll_px_per_frame: 15,
    frame_interval_ms: 33,
    output_format: 'png' as const,
    output_dir: '/tmp/reftrix-frames/',
    filename_pattern: 'frame-{0000}.png',
  },
  files: [
    { frame_number: 0, scroll_position_px: 0, timestamp_ms: 0, file_path: '/tmp/reftrix-frames/frame-0000.png' },
    { frame_number: 1, scroll_position_px: 15, timestamp_ms: 33, file_path: '/tmp/reftrix-frames/frame-0001.png' },
  ],
  duration_ms: 3300,
};

const MOCK_FRAME_ANALYSIS_RESULT = {
  metadata: {
    totalFrames: 100,
    analyzedPairs: 99,
    analysisStartTime: '2026-01-30T00:00:00Z',
    analysisEndTime: '2026-01-30T00:00:05Z',
    frameDirectory: '/tmp/reftrix-frames/',
  },
  statistics: {
    averageDiffPercentage: '5.5%',
    layoutShiftCount: 2,
    significantChangeCount: 10,
  },
  animationZones: [
    {
      frameStart: 'frame-0010.png',
      frameEnd: 'frame-0020.png',
      avgDiff: '8.5%',
      peakDiff: '15.0%',
      type: 'fade',
    },
    {
      frameStart: 'frame-0050.png',
      frameEnd: 'frame-0060.png',
      avgDiff: '12.0%',
      peakDiff: '20.0%',
      type: 'slide',
    },
  ],
  layoutShifts: [
    { frameRange: '0010-0015', impactFraction: '0.05' },
    { frameRange: '0055-0058', impactFraction: '0.08' },
  ],
  motionVectors: [
    // frameRangeはframe-0010.pngを含む必要がある（includes()でマッチング）
    { frameRange: 'frame-0010.png to frame-0020.png', dx: 10, dy: 0, magnitude: '10.0', direction: 'right' },
  ],
};

// =====================================================
// テストスイート
// =====================================================

describe('Video Handler Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDevelopment.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================
  // Frame Capture Disabled Tests
  // =====================================================

  describe('Frame Capture Disabled', () => {
    it('should return empty result when enable_frame_capture is false', async () => {
      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: false,
      });

      // Assert
      expect(result).toEqual({});
      expect(mockExecuteFrameCapture).not.toHaveBeenCalled();
    });

    it('should return empty result when enable_frame_capture is undefined', async () => {
      // Act
      const result = await executeVideoMode(TEST_URL, {});

      // Assert
      expect(result).toEqual({});
      expect(mockExecuteFrameCapture).not.toHaveBeenCalled();
    });

    it('should return empty result when options is undefined', async () => {
      // Act
      const result = await executeVideoMode(TEST_URL);

      // Assert
      expect(result).toEqual({});
      expect(mockExecuteFrameCapture).not.toHaveBeenCalled();
    });

    it('should log info in development mode when frame capture is disabled', async () => {
      // Arrange
      mockIsDevelopment.mockReturnValue(true);
      const { logger } = await import('../../../../../src/utils/logger');
      const mockLoggerInfo = vi.mocked(logger.info);

      // Act
      await executeVideoMode(TEST_URL, { enable_frame_capture: false });

      // Assert
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        '[video-handler] Frame capture disabled, skipping video mode'
      );
    });
  });

  // =====================================================
  // Frame Capture Enabled Tests
  // =====================================================

  describe('Frame Capture Enabled', () => {
    it('should execute frame capture when enabled', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue(null);

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(mockExecuteFrameCapture).toHaveBeenCalledWith(TEST_URL, expect.objectContaining({
        scroll_px_per_frame: 15,
        frame_interval_ms: 33,
        output_dir: '/tmp/reftrix-frames/',
        output_format: 'png',
        filename_pattern: 'frame-{0000}.png',
      }));
      expect(result.frame_capture).toBeDefined();
      expect(result.frame_capture?.total_frames).toBe(100);
    });

    it('should use custom frame capture options when provided', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue({
        ...MOCK_FRAME_CAPTURE_RESULT,
        config: {
          ...MOCK_FRAME_CAPTURE_RESULT.config,
          scroll_px_per_frame: 30,
          output_dir: '/custom/path/',
        },
      });
      mockGetFrameImageAnalysisService.mockReturnValue(null);

      // Act
      await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
        frame_capture_options: {
          scroll_px_per_frame: 30,
          frame_interval_ms: 50,
          output_dir: '/custom/path/',
          output_format: 'jpeg',
          filename_pattern: 'capture-{0000}.jpg',
        },
      });

      // Assert
      expect(mockExecuteFrameCapture).toHaveBeenCalledWith(TEST_URL, expect.objectContaining({
        scroll_px_per_frame: 30,
        frame_interval_ms: 50,
        output_dir: '/custom/path/',
        output_format: 'jpeg',
        filename_pattern: 'capture-{0000}.jpg',
      }));
    });

    it('should handle frame capture error gracefully', async () => {
      // Arrange
      mockExecuteFrameCapture.mockRejectedValue(new Error('Playwright not available'));

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(result.frame_capture_error).toBeDefined();
      expect(result.frame_capture_error?.code).toBe('FRAME_CAPTURE_ERROR');
      expect(result.frame_capture_error?.message).toBe('Playwright not available');
    });

    it('should handle non-Error thrown from frame capture', async () => {
      // Arrange
      mockExecuteFrameCapture.mockRejectedValue('Unknown error');

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(result.frame_capture_error).toBeDefined();
      expect(result.frame_capture_error?.code).toBe('FRAME_CAPTURE_ERROR');
      expect(result.frame_capture_error?.message).toBe('Frame capture failed');
    });
  });

  // =====================================================
  // Frame Analysis Tests
  // =====================================================

  describe('Frame Analysis', () => {
    it('should execute frame analysis when analyze_frames is true (default)', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      const mockAnalyze = vi.fn().mockResolvedValue(MOCK_FRAME_ANALYSIS_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: mockAnalyze,
      });

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(mockAnalyze).toHaveBeenCalled();
      expect(result.frame_analysis).toBeDefined();
      expect(result.frame_analysis?.summary.total_layout_shifts).toBe(2);
    });

    it('should skip frame analysis when analyze_frames is false', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      const mockAnalyze = vi.fn();
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: mockAnalyze,
      });

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
        analyze_frames: false,
      });

      // Assert
      expect(mockAnalyze).not.toHaveBeenCalled();
      expect(result.frame_analysis).toBeUndefined();
    });

    it('should return error when frame analysis service is not configured', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue(null);

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
        analyze_frames: true,
      });

      // Assert
      expect(result.frame_analysis_error).toBeDefined();
      expect(result.frame_analysis_error?.code).toBe('FRAME_ANALYSIS_UNAVAILABLE');
      expect(result.frame_analysis_error?.message).toContain('not configured');
    });

    it('should return error when frame analysis service is not available', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => false,
        analyze: vi.fn(),
      });

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
        analyze_frames: true,
      });

      // Assert
      expect(result.frame_analysis_error).toBeDefined();
      expect(result.frame_analysis_error?.code).toBe('FRAME_ANALYSIS_UNAVAILABLE');
      expect(result.frame_analysis_error?.message).toContain('not available');
    });

    it('should pass frame analysis options to service', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      const mockAnalyze = vi.fn().mockResolvedValue(MOCK_FRAME_ANALYSIS_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: mockAnalyze,
      });

      // Act
      await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
        frame_analysis_options: {
          sample_interval: 5,
          diff_threshold: 0.05,
          cls_threshold: 0.2,
          motion_threshold: 10,
          output_diff_images: true,
          parallel: false,
        },
      });

      // Assert
      expect(mockAnalyze).toHaveBeenCalledWith(
        '/tmp/reftrix-frames/',
        expect.objectContaining({
          sampleInterval: 5,
          diffThreshold: 0.05,
          clsThreshold: 0.2,
          motionThreshold: 10,
          outputDiffImages: true,
          parallel: false,
        })
      );
    });

    it('should use default analysis options when not provided', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      const mockAnalyze = vi.fn().mockResolvedValue(MOCK_FRAME_ANALYSIS_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: mockAnalyze,
      });

      // Act
      await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(mockAnalyze).toHaveBeenCalledWith(
        '/tmp/reftrix-frames/',
        expect.objectContaining({
          sampleInterval: 1,
          diffThreshold: 0.01,
          clsThreshold: 0.1,
          motionThreshold: 5,
          outputDiffImages: false,
          parallel: true,
          scrollPxPerFrame: 15,
          maxFrames: 100, // キャプチャされたフレーム数
        })
      );
    });

    it('should handle frame analysis error gracefully', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: vi.fn().mockRejectedValue(new Error('Analysis failed')),
      });

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(result.frame_analysis_error).toBeDefined();
      expect(result.frame_analysis_error?.code).toBe('FRAME_ANALYSIS_ERROR');
      expect(result.frame_analysis_error?.message).toBe('Analysis failed');
    });

    it('should handle non-Error thrown from frame analysis', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: vi.fn().mockRejectedValue('Unknown error'),
      });

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(result.frame_analysis_error).toBeDefined();
      expect(result.frame_analysis_error?.code).toBe('FRAME_ANALYSIS_ERROR');
      expect(result.frame_analysis_error?.message).toBe('Frame analysis failed');
    });
  });

  // =====================================================
  // Result Transformation Tests
  // =====================================================

  describe('Result Transformation', () => {
    it('should correctly transform frame capture result', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue(null);

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(result.frame_capture).toEqual({
        total_frames: 100,
        output_dir: '/tmp/reftrix-frames/',
        config: {
          scroll_px_per_frame: 15,
          frame_interval_ms: 33,
          output_format: 'png',
          output_dir: '/tmp/reftrix-frames/',
          filename_pattern: 'frame-{0000}.png',
        },
        files: [
          { frame_number: 0, scroll_position_px: 0, timestamp_ms: 0, file_path: '/tmp/reftrix-frames/frame-0000.png' },
          { frame_number: 1, scroll_position_px: 15, timestamp_ms: 33, file_path: '/tmp/reftrix-frames/frame-0001.png' },
        ],
        duration_ms: 3300,
      });
    });

    it('should correctly calculate CLS score from layout shifts', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      const mockAnalyze = vi.fn().mockResolvedValue(MOCK_FRAME_ANALYSIS_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: mockAnalyze,
      });

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      // CLS = 0.05 + 0.08 = 0.13
      expect(result.frame_analysis?.summary.cls_score).toBeCloseTo(0.13, 2);
    });

    it('should correctly extract max_diff from animation zones', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      const mockAnalyze = vi.fn().mockResolvedValue(MOCK_FRAME_ANALYSIS_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: mockAnalyze,
      });

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      // max_diff = 20.0% = 0.20
      expect(result.frame_analysis?.summary.max_diff).toBeCloseTo(0.20, 2);
    });

    it('should correctly calculate avg_diff from statistics', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      const mockAnalyze = vi.fn().mockResolvedValue(MOCK_FRAME_ANALYSIS_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: mockAnalyze,
      });

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      // avg_diff = 5.5% = 0.055
      expect(result.frame_analysis?.summary.avg_diff).toBeCloseTo(0.055, 3);
    });

    it('should include motion vectors in timeline when present', async () => {
      // Arrange
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      const mockAnalyze = vi.fn().mockResolvedValue(MOCK_FRAME_ANALYSIS_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: mockAnalyze,
      });

      // Act
      const result = await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      // frame-0010.png has a motion vector
      const timelineEntry = result.frame_analysis?.timeline[0];
      expect(timelineEntry?.motion_vectors).toBeDefined();
      expect(timelineEntry?.motion_vectors).toHaveLength(1);
      expect(timelineEntry?.motion_vectors?.[0]).toEqual({
        x: 10,
        y: 0,
        magnitude: 10.0,
      });
    });
  });

  // =====================================================
  // Development Mode Logging Tests
  // =====================================================

  describe('Development Mode Logging', () => {
    it('should log frame capture start in development mode', async () => {
      // Arrange
      mockIsDevelopment.mockReturnValue(true);
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue(null);
      const { logger } = await import('../../../../../src/utils/logger');
      const mockLoggerInfo = vi.mocked(logger.info);

      // Act
      await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        '[video-handler] Starting frame capture (video mode)',
        expect.any(Object)
      );
    });

    it('should log frame capture completion in development mode', async () => {
      // Arrange
      mockIsDevelopment.mockReturnValue(true);
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue(null);
      const { logger } = await import('../../../../../src/utils/logger');
      const mockLoggerInfo = vi.mocked(logger.info);

      // Act
      await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        '[video-handler] Frame capture completed',
        expect.objectContaining({
          total_frames: 100,
          duration_ms: 3300,
        })
      );
    });

    it('should log frame capture error in development mode', async () => {
      // Arrange
      mockIsDevelopment.mockReturnValue(true);
      mockExecuteFrameCapture.mockRejectedValue(new Error('Capture failed'));
      const { logger } = await import('../../../../../src/utils/logger');
      const mockLoggerError = vi.mocked(logger.error);

      // Act
      await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(mockLoggerError).toHaveBeenCalledWith(
        '[video-handler] Frame capture failed',
        expect.any(Object)
      );
    });

    it('should log frame analysis completion in development mode', async () => {
      // Arrange
      mockIsDevelopment.mockReturnValue(true);
      mockExecuteFrameCapture.mockResolvedValue(MOCK_FRAME_CAPTURE_RESULT);
      const mockAnalyze = vi.fn().mockResolvedValue(MOCK_FRAME_ANALYSIS_RESULT);
      mockGetFrameImageAnalysisService.mockReturnValue({
        isAvailable: () => true,
        analyze: mockAnalyze,
      });
      const { logger } = await import('../../../../../src/utils/logger');
      const mockLoggerInfo = vi.mocked(logger.info);

      // Act
      await executeVideoMode(TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        '[video-handler] Frame image analysis completed',
        expect.objectContaining({
          totalFrames: 100,
          analyzedPairs: 99,
          layoutShiftCount: 2,
          animationZones: 2,
        })
      );
    });
  });
});
