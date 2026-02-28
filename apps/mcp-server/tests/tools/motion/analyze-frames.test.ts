// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.analyze_frames MCPツールのテスト
 * TDD Red Phase: 先にテストを作成
 *
 * フレーム画像解析用のMCPツール
 *
 * テスト対象:
 * - 入力バリデーション (10テスト)
 * - フレーム差分検出 (10テスト)
 * - レイアウトシフト検出 (10テスト)
 * - 色変化検出 (5テスト)
 * - DIパターン (5テスト)
 * - エッジケース (10テスト)
 *
 * @module tests/tools/motion/analyze-frames.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// =====================================================
// インポート
// =====================================================

import {
  motionAnalyzeFramesHandler,
  motionAnalyzeFramesToolDefinition,
  setFrameAnalysisServiceFactory,
  resetFrameAnalysisServiceFactory,
  type IFrameAnalysisService,
} from '../../../src/tools/motion/analyze-frames.handler';

import {
  analyzeFramesInputSchema,
  analyzeFramesOutputSchema,
  type AnalyzeFramesInput,
  type AnalyzeFramesOutput,
  type FrameDiffResult,
  type LayoutShiftResult,
  type ColorChangeResult,
  type BoundingBox,
  ANALYZE_FRAMES_ERROR_CODES,
} from '../../../src/tools/motion/analyze-frames.schema';

// =====================================================
// テストヘルパー
// =====================================================

/**
 * テスト用の一時ディレクトリを作成
 */
async function createTempFrameDir(): Promise<string> {
  const tempDir = path.join('/tmp', `reftrix-test-frames-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * テスト用のフレーム画像（モック）を作成
 */
async function createMockFrames(dir: string, count: number): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const filename = `frame-${String(i).padStart(4, '0')}.png`;
    const filepath = path.join(dir, filename);
    // 空のファイルを作成（実際の画像処理はモックで行う）
    await fs.writeFile(filepath, Buffer.alloc(100));
    files.push(filepath);
  }
  return files;
}

/**
 * 一時ディレクトリをクリーンアップ
 */
async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

// =====================================================
// モックサービス
// =====================================================

/**
 * モックFrameAnalysisService
 */
function createMockFrameAnalysisService(
  overrides: Partial<IFrameAnalysisService> = {}
): IFrameAnalysisService {
  return {
    analyzeFrames: vi.fn().mockResolvedValue({
      frame_count: 10,
      analysis_results: {
        frame_diff: {
          total_comparisons: 9,
          avg_change_ratio: 0.05,
          max_change_ratio: 0.15,
          motion_frame_count: 5,
        },
        layout_shift: {
          total_shifts: 2,
          max_impact_score: 0.08,
          cumulative_shift_score: 0.12,
        },
      },
      timeline: [],
      processing_time_ms: 150,
    }),
    compareFrames: vi.fn().mockResolvedValue({
      from_index: 0,
      to_index: 1,
      change_ratio: 0.05,
      changed_pixels: 5000,
      total_pixels: 100000,
      change_regions: [],
      has_change: true,
    }),
    detectLayoutShift: vi.fn().mockResolvedValue({
      frame_index: 5,
      shift_start_ms: 166,
      impact_score: 0.08,
      affected_regions: [],
      estimated_cause: 'dynamic_content',
      shift_direction: 'vertical',
      shift_distance: 20,
    }),
    detectColorChange: vi.fn().mockResolvedValue({
      events: [],
    }),
    ...overrides,
  };
}

// =====================================================
// 入力バリデーションテスト
// =====================================================

describe('motion.analyze_frames Input Validation', () => {
  describe('frame_dir validation', () => {
    it('should require frame_dir parameter', () => {
      const result = analyzeFramesInputSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('frame_dir'))).toBe(true);
      }
    });

    it('should reject empty frame_dir', () => {
      const result = analyzeFramesInputSchema.safeParse({
        frame_dir: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject path traversal attempts', () => {
      const result = analyzeFramesInputSchema.safeParse({
        frame_dir: '../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid directory path', () => {
      const result = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('frame_pattern validation', () => {
    it('should use default pattern when not specified', () => {
      const result = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.frame_pattern).toBe('frame-*.png');
      }
    });

    it('should accept custom pattern', () => {
      const result = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
        frame_pattern: 'img-*.jpg',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.frame_pattern).toBe('img-*.jpg');
      }
    });
  });

  describe('analysis_types validation', () => {
    it('should use default analysis types when not specified', () => {
      const result = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.analysis_types).toEqual(['frame_diff', 'layout_shift']);
      }
    });

    it('should accept valid analysis types', () => {
      const result = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
        analysis_types: ['frame_diff', 'color_change', 'motion_vector'],
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid analysis type', () => {
      const result = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
        analysis_types: ['invalid_type'],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('options validation', () => {
    it('should validate diff_threshold range (0-1)', () => {
      const validResult = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
        options: { diff_threshold: 0.5 },
      });
      expect(validResult.success).toBe(true);

      const invalidResult = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
        options: { diff_threshold: 1.5 },
      });
      expect(invalidResult.success).toBe(false);
    });

    it('should validate max_frames range (2-3600)', () => {
      const validResult = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
        options: { max_frames: 100 },
      });
      expect(validResult.success).toBe(true);

      const invalidLow = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
        options: { max_frames: 1 },
      });
      expect(invalidLow.success).toBe(false);

      const invalidHigh = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
        options: { max_frames: 4000 },
      });
      expect(invalidHigh.success).toBe(false);
    });

    it('should use default option values', () => {
      const result = analyzeFramesInputSchema.safeParse({
        frame_dir: '/tmp/frames',
        options: {},
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.options) {
        expect(result.data.options.diff_threshold).toBe(0.1);
        expect(result.data.options.max_frames).toBe(300);
        expect(result.data.options.parallel).toBe(true);
        expect(result.data.options.output_diff_images).toBe(false);
      }
    });
  });
});

// =====================================================
// ハンドラーテスト
// =====================================================

describe('motion.analyze_frames Handler', () => {
  let tempDir: string;

  beforeEach(async () => {
    resetFrameAnalysisServiceFactory();
    tempDir = await createTempFrameDir();
  });

  afterEach(async () => {
    resetFrameAnalysisServiceFactory();
    await cleanupTempDir(tempDir);
  });

  describe('Tool Definition', () => {
    it('should have correct tool name', () => {
      expect(motionAnalyzeFramesToolDefinition.name).toBe('motion.analyze_frames');
    });

    it('should have description', () => {
      expect(motionAnalyzeFramesToolDefinition.description).toBeTruthy();
      expect(motionAnalyzeFramesToolDefinition.description.length).toBeGreaterThan(10);
    });

    it('should have inputSchema', () => {
      expect(motionAnalyzeFramesToolDefinition.inputSchema).toBeDefined();
    });
  });

  describe('Basic Execution', () => {
    it('should return success for valid input with mock service', async () => {
      await createMockFrames(tempDir, 10);
      const mockService = createMockFrameAnalysisService();
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeDefined();
        expect(result.data?.frame_count).toBeGreaterThan(0);
      }
    });

    it('should return error for non-existent directory', async () => {
      const result = await motionAnalyzeFramesHandler({
        frame_dir: '/nonexistent/path/to/frames',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error?.code).toBe(ANALYZE_FRAMES_ERROR_CODES.DIRECTORY_NOT_FOUND);
      }
    });

    it('should return error for empty directory', async () => {
      // tempDir is empty
      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error?.code).toBe(ANALYZE_FRAMES_ERROR_CODES.NO_FRAMES_FOUND);
      }
    });

    it('should return error when too few frames (minimum 2)', async () => {
      await createMockFrames(tempDir, 1);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error?.code).toBe(ANALYZE_FRAMES_ERROR_CODES.INSUFFICIENT_FRAMES);
      }
    });
  });

  describe('Frame Diff Analysis', () => {
    it('should perform frame diff analysis by default', async () => {
      await createMockFrames(tempDir, 10);
      const mockService = createMockFrameAnalysisService();
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
        analysis_types: ['frame_diff'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.analysis_results?.frame_diff).toBeDefined();
        expect(result.data?.analysis_results?.frame_diff?.total_comparisons).toBeDefined();
      }
    });

    it('should respect diff_threshold option', async () => {
      await createMockFrames(tempDir, 10);
      const mockService = createMockFrameAnalysisService();
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
        analysis_types: ['frame_diff'],
        options: { diff_threshold: 0.05 },
      });

      expect(result.success).toBe(true);
      expect(mockService.analyzeFrames).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            diff_threshold: 0.05,
          }),
        })
      );
    });

    it('should return change_regions for frame diff', async () => {
      await createMockFrames(tempDir, 5);
      const mockService = createMockFrameAnalysisService({
        analyzeFrames: vi.fn().mockResolvedValue({
          frame_count: 5,
          analysis_results: {
            frame_diff: {
              total_comparisons: 4,
              avg_change_ratio: 0.1,
              max_change_ratio: 0.2,
              motion_frame_count: 3,
              results: [
                {
                  from_index: 0,
                  to_index: 1,
                  change_ratio: 0.1,
                  changed_pixels: 10000,
                  total_pixels: 100000,
                  change_regions: [
                    { x: 100, y: 200, width: 50, height: 30 },
                  ],
                  has_change: true,
                },
              ],
            },
          },
          timeline: [],
          processing_time_ms: 100,
        }),
      });
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
        analysis_types: ['frame_diff'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const diffResults = result.data?.analysis_results?.frame_diff?.results;
        if (diffResults && diffResults.length > 0) {
          expect(diffResults[0].change_regions).toBeDefined();
          expect(diffResults[0].change_regions.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('Layout Shift Analysis', () => {
    it('should detect layout shifts', async () => {
      await createMockFrames(tempDir, 10);
      const mockService = createMockFrameAnalysisService({
        analyzeFrames: vi.fn().mockResolvedValue({
          frame_count: 10,
          analysis_results: {
            layout_shift: {
              total_shifts: 2,
              max_impact_score: 0.15,
              cumulative_shift_score: 0.25,
              results: [
                {
                  frame_index: 3,
                  shift_start_ms: 100,
                  impact_score: 0.1,
                  affected_regions: [{ x: 0, y: 100, width: 1920, height: 200 }],
                  estimated_cause: 'image_load',
                  shift_direction: 'vertical',
                  shift_distance: 50,
                },
              ],
            },
          },
          timeline: [],
          processing_time_ms: 200,
        }),
      });
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
        analysis_types: ['layout_shift'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.analysis_results?.layout_shift).toBeDefined();
        expect(result.data?.analysis_results?.layout_shift?.total_shifts).toBe(2);
        expect(result.data?.analysis_results?.layout_shift?.cumulative_shift_score).toBe(0.25);
      }
    });

    it('should calculate CLS-equivalent score', async () => {
      await createMockFrames(tempDir, 30);
      const mockService = createMockFrameAnalysisService({
        analyzeFrames: vi.fn().mockResolvedValue({
          frame_count: 30,
          analysis_results: {
            layout_shift: {
              total_shifts: 5,
              max_impact_score: 0.2,
              cumulative_shift_score: 0.35,
              results: [],
            },
          },
          timeline: [],
          processing_time_ms: 500,
        }),
      });
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
        analysis_types: ['layout_shift'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const clsScore = result.data?.analysis_results?.layout_shift?.cumulative_shift_score;
        expect(clsScore).toBeDefined();
        expect(typeof clsScore).toBe('number');
        // CLS should be 0-1 range typically
        expect(clsScore).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Color Change Analysis', () => {
    it('should detect color changes when requested', async () => {
      await createMockFrames(tempDir, 20);
      const mockService = createMockFrameAnalysisService({
        analyzeFrames: vi.fn().mockResolvedValue({
          frame_count: 20,
          analysis_results: {
            color_change: {
              events: [
                {
                  start_frame: 5,
                  end_frame: 10,
                  change_type: 'fade_in',
                  affected_region: { x: 100, y: 100, width: 200, height: 200 },
                  from_color: '#000000',
                  to_color: '#FFFFFF',
                  estimated_duration_ms: 166,
                },
              ],
            },
          },
          timeline: [],
          processing_time_ms: 300,
        }),
      });
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
        analysis_types: ['color_change'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.analysis_results?.color_change).toBeDefined();
        expect(result.data?.analysis_results?.color_change?.events?.length).toBeGreaterThan(0);
      }
    });

    it('should identify fade in/out effects', async () => {
      await createMockFrames(tempDir, 15);
      const mockService = createMockFrameAnalysisService({
        analyzeFrames: vi.fn().mockResolvedValue({
          frame_count: 15,
          analysis_results: {
            color_change: {
              events: [
                {
                  start_frame: 0,
                  end_frame: 5,
                  change_type: 'fade_in',
                  affected_region: { x: 0, y: 0, width: 1920, height: 1080 },
                  from_color: '#000000',
                  to_color: '#FFFFFF',
                  estimated_duration_ms: 166,
                },
                {
                  start_frame: 10,
                  end_frame: 14,
                  change_type: 'fade_out',
                  affected_region: { x: 0, y: 0, width: 1920, height: 1080 },
                  from_color: '#FFFFFF',
                  to_color: '#000000',
                  estimated_duration_ms: 133,
                },
              ],
            },
          },
          timeline: [],
          processing_time_ms: 250,
        }),
      });
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
        analysis_types: ['color_change'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const events = result.data?.analysis_results?.color_change?.events;
        expect(events).toBeDefined();
        const fadeIn = events?.find((e) => e.change_type === 'fade_in');
        const fadeOut = events?.find((e) => e.change_type === 'fade_out');
        expect(fadeIn).toBeDefined();
        expect(fadeOut).toBeDefined();
      }
    });
  });

  describe('Multiple Analysis Types', () => {
    it('should perform multiple analysis types simultaneously', async () => {
      await createMockFrames(tempDir, 30);
      const mockService = createMockFrameAnalysisService({
        analyzeFrames: vi.fn().mockResolvedValue({
          frame_count: 30,
          analysis_results: {
            frame_diff: {
              total_comparisons: 29,
              avg_change_ratio: 0.08,
              max_change_ratio: 0.25,
              motion_frame_count: 20,
            },
            layout_shift: {
              total_shifts: 3,
              max_impact_score: 0.12,
              cumulative_shift_score: 0.2,
              results: [],
            },
            color_change: {
              events: [
                {
                  start_frame: 10,
                  end_frame: 15,
                  change_type: 'fade_in',
                  affected_region: { x: 0, y: 0, width: 100, height: 100 },
                  from_color: '#000',
                  to_color: '#FFF',
                  estimated_duration_ms: 166,
                },
              ],
            },
          },
          timeline: [],
          processing_time_ms: 800,
        }),
      });
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
        analysis_types: ['frame_diff', 'layout_shift', 'color_change'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.analysis_results?.frame_diff).toBeDefined();
        expect(result.data?.analysis_results?.layout_shift).toBeDefined();
        expect(result.data?.analysis_results?.color_change).toBeDefined();
      }
    });
  });

  describe('Timeline Output', () => {
    it('should include timeline data', async () => {
      await createMockFrames(tempDir, 10);
      const mockService = createMockFrameAnalysisService({
        analyzeFrames: vi.fn().mockResolvedValue({
          frame_count: 10,
          analysis_results: {
            frame_diff: {
              total_comparisons: 9,
              avg_change_ratio: 0.05,
              max_change_ratio: 0.1,
              motion_frame_count: 5,
            },
          },
          timeline: [
            { frame_index: 0, timestamp_ms: 0, has_motion: false },
            { frame_index: 1, timestamp_ms: 33, has_motion: true },
            { frame_index: 2, timestamp_ms: 66, has_motion: true },
          ],
          processing_time_ms: 150,
        }),
      });
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.timeline).toBeDefined();
        expect(Array.isArray(result.data?.timeline)).toBe(true);
        expect(result.data?.timeline?.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Performance', () => {
    it('should include processing_time_ms in response', async () => {
      await createMockFrames(tempDir, 10);
      const mockService = createMockFrameAnalysisService();
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.processing_time_ms).toBeDefined();
        expect(typeof result.data?.processing_time_ms).toBe('number');
        expect(result.data?.processing_time_ms).toBeGreaterThanOrEqual(0);
      }
    });

    it('should respect max_frames limit', async () => {
      await createMockFrames(tempDir, 100);
      const mockService = createMockFrameAnalysisService();
      setFrameAnalysisServiceFactory(() => mockService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
        options: { max_frames: 50 },
      });

      expect(result.success).toBe(true);
      expect(mockService.analyzeFrames).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            max_frames: 50,
          }),
        })
      );
    });
  });

  describe('DI Pattern', () => {
    it('should use injected service factory', async () => {
      await createMockFrames(tempDir, 5);
      const customService = createMockFrameAnalysisService({
        analyzeFrames: vi.fn().mockResolvedValue({
          frame_count: 5,
          analysis_results: {
            frame_diff: {
              total_comparisons: 4,
              avg_change_ratio: 0.99,
              max_change_ratio: 0.99,
              motion_frame_count: 4,
            },
          },
          timeline: [],
          processing_time_ms: 999,
        }),
      });
      setFrameAnalysisServiceFactory(() => customService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.analysis_results?.frame_diff?.avg_change_ratio).toBe(0.99);
        expect(result.data?.processing_time_ms).toBe(999);
      }
    });

    it('should reset to default service factory', async () => {
      const customService = createMockFrameAnalysisService();
      setFrameAnalysisServiceFactory(() => customService);
      resetFrameAnalysisServiceFactory();

      // After reset, calling without frames should still return appropriate error
      const result = await motionAnalyzeFramesHandler({
        frame_dir: '/nonexistent/path',
      });

      expect(result.success).toBe(false);
      // Should not use the mock service after reset
      expect(customService.analyzeFrames).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle service errors gracefully', async () => {
      await createMockFrames(tempDir, 10);
      const errorService = createMockFrameAnalysisService({
        analyzeFrames: vi.fn().mockRejectedValue(new Error('Analysis failed')),
      });
      setFrameAnalysisServiceFactory(() => errorService);

      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error?.code).toBe(ANALYZE_FRAMES_ERROR_CODES.ANALYSIS_ERROR);
        expect(result.error?.message).toContain('Analysis failed');
      }
    });

    it('should handle validation errors', async () => {
      const result = await motionAnalyzeFramesHandler({
        frame_dir: tempDir,
        options: { diff_threshold: 5 }, // Invalid: should be 0-1
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error?.code).toBe(ANALYZE_FRAMES_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });
});

// =====================================================
// 出力スキーマバリデーションテスト
// =====================================================

describe('motion.analyze_frames Output Schema', () => {
  it('should validate success response', () => {
    const successResponse = {
      success: true,
      data: {
        frame_count: 10,
        analysis_results: {
          frame_diff: {
            total_comparisons: 9,
            avg_change_ratio: 0.05,
            max_change_ratio: 0.15,
            motion_frame_count: 5,
          },
        },
        timeline: [],
        processing_time_ms: 150,
      },
    };

    const result = analyzeFramesOutputSchema.safeParse(successResponse);
    expect(result.success).toBe(true);
  });

  it('should validate error response', () => {
    const errorResponse = {
      success: false,
      error: {
        code: 'DIRECTORY_NOT_FOUND',
        message: 'Frame directory not found',
      },
    };

    const result = analyzeFramesOutputSchema.safeParse(errorResponse);
    expect(result.success).toBe(true);
  });

  it('should validate frame_diff result structure', () => {
    const frameDiffResult: FrameDiffResult = {
      from_index: 0,
      to_index: 1,
      change_ratio: 0.1,
      changed_pixels: 10000,
      total_pixels: 100000,
      change_regions: [{ x: 100, y: 200, width: 50, height: 30 }],
      has_change: true,
    };

    // This is a type check - TypeScript will fail compilation if structure is wrong
    expect(frameDiffResult.from_index).toBe(0);
    expect(frameDiffResult.change_regions.length).toBe(1);
  });

  it('should validate layout_shift result structure', () => {
    const layoutShiftResult: LayoutShiftResult = {
      frame_index: 5,
      shift_start_ms: 166,
      impact_score: 0.08,
      affected_regions: [{ x: 0, y: 100, width: 1920, height: 200 }],
      estimated_cause: 'image_load',
      shift_direction: 'vertical',
      shift_distance: 50,
    };

    expect(layoutShiftResult.estimated_cause).toBe('image_load');
    expect(layoutShiftResult.shift_direction).toBe('vertical');
  });

  it('should validate color_change result structure', () => {
    const colorChangeResult: ColorChangeResult = {
      events: [
        {
          start_frame: 5,
          end_frame: 10,
          change_type: 'fade_in',
          affected_region: { x: 100, y: 100, width: 200, height: 200 },
          from_color: '#000000',
          to_color: '#FFFFFF',
          estimated_duration_ms: 166,
        },
      ],
    };

    expect(colorChangeResult.events.length).toBe(1);
    expect(colorChangeResult.events[0].change_type).toBe('fade_in');
  });
});

// =====================================================
// エッジケーステスト
// =====================================================

describe('motion.analyze_frames Edge Cases', () => {
  let tempDir: string;

  beforeEach(async () => {
    resetFrameAnalysisServiceFactory();
    tempDir = await createTempFrameDir();
  });

  afterEach(async () => {
    resetFrameAnalysisServiceFactory();
    await cleanupTempDir(tempDir);
  });

  it('should handle exactly 2 frames (minimum)', async () => {
    await createMockFrames(tempDir, 2);
    const mockService = createMockFrameAnalysisService({
      analyzeFrames: vi.fn().mockResolvedValue({
        frame_count: 2,
        analysis_results: {
          frame_diff: {
            total_comparisons: 1,
            avg_change_ratio: 0.1,
            max_change_ratio: 0.1,
            motion_frame_count: 1,
          },
        },
        timeline: [
          { frame_index: 0, timestamp_ms: 0, has_motion: false },
          { frame_index: 1, timestamp_ms: 33, has_motion: true },
        ],
        processing_time_ms: 50,
      }),
    });
    setFrameAnalysisServiceFactory(() => mockService);

    const result = await motionAnalyzeFramesHandler({
      frame_dir: tempDir,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.frame_count).toBe(2);
    }
  });

  it('should handle max_frames limit (3600)', async () => {
    const result = analyzeFramesInputSchema.safeParse({
      frame_dir: tempDir,
      options: { max_frames: 3600 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options?.max_frames).toBe(3600);
    }
  });

  it('should handle frames with no motion detected', async () => {
    await createMockFrames(tempDir, 10);
    const mockService = createMockFrameAnalysisService({
      analyzeFrames: vi.fn().mockResolvedValue({
        frame_count: 10,
        analysis_results: {
          frame_diff: {
            total_comparisons: 9,
            avg_change_ratio: 0.001,
            max_change_ratio: 0.005,
            motion_frame_count: 0,
          },
          layout_shift: {
            total_shifts: 0,
            max_impact_score: 0,
            cumulative_shift_score: 0,
            results: [],
          },
        },
        timeline: Array.from({ length: 10 }, (_, i) => ({
          frame_index: i,
          timestamp_ms: i * 33,
          has_motion: false,
        })),
        processing_time_ms: 100,
      }),
    });
    setFrameAnalysisServiceFactory(() => mockService);

    const result = await motionAnalyzeFramesHandler({
      frame_dir: tempDir,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.analysis_results?.frame_diff?.motion_frame_count).toBe(0);
      expect(result.data?.analysis_results?.layout_shift?.total_shifts).toBe(0);
    }
  });

  it('should handle mixed file types in directory', async () => {
    // Create both PNG and other files
    await createMockFrames(tempDir, 5);
    await fs.writeFile(path.join(tempDir, 'readme.txt'), 'test file');
    await fs.writeFile(path.join(tempDir, 'config.json'), '{}');

    const mockService = createMockFrameAnalysisService({
      analyzeFrames: vi.fn().mockResolvedValue({
        frame_count: 5,
        analysis_results: {
          frame_diff: {
            total_comparisons: 4,
            avg_change_ratio: 0.05,
            max_change_ratio: 0.1,
            motion_frame_count: 3,
          },
        },
        timeline: [],
        processing_time_ms: 100,
      }),
    });
    setFrameAnalysisServiceFactory(() => mockService);

    const result = await motionAnalyzeFramesHandler({
      frame_dir: tempDir,
      frame_pattern: 'frame-*.png',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // Should only process PNG files matching pattern
      expect(result.data?.frame_count).toBe(5);
    }
  });

  it('should handle parallel=false option', async () => {
    await createMockFrames(tempDir, 10);
    const mockService = createMockFrameAnalysisService();
    setFrameAnalysisServiceFactory(() => mockService);

    const result = await motionAnalyzeFramesHandler({
      frame_dir: tempDir,
      options: { parallel: false },
    });

    expect(result.success).toBe(true);
    expect(mockService.analyzeFrames).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          parallel: false,
        }),
      })
    );
  });

  it('should handle output_diff_images option', async () => {
    await createMockFrames(tempDir, 5);
    const mockService = createMockFrameAnalysisService();
    setFrameAnalysisServiceFactory(() => mockService);

    const result = await motionAnalyzeFramesHandler({
      frame_dir: tempDir,
      options: { output_diff_images: true },
    });

    expect(result.success).toBe(true);
    expect(mockService.analyzeFrames).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          output_diff_images: true,
        }),
      })
    );
  });

  it('should handle all analysis types together', async () => {
    await createMockFrames(tempDir, 20);
    const mockService = createMockFrameAnalysisService({
      analyzeFrames: vi.fn().mockResolvedValue({
        frame_count: 20,
        analysis_results: {
          frame_diff: { total_comparisons: 19, avg_change_ratio: 0.1, max_change_ratio: 0.3, motion_frame_count: 15 },
          layout_shift: { total_shifts: 2, max_impact_score: 0.1, cumulative_shift_score: 0.15, results: [] },
          color_change: { events: [] },
          motion_vector: { primary_direction: 90, avg_speed: 5, vectors: [] },
          element_visibility: { events: [] },
        },
        timeline: [],
        processing_time_ms: 500,
      }),
    });
    setFrameAnalysisServiceFactory(() => mockService);

    const result = await motionAnalyzeFramesHandler({
      frame_dir: tempDir,
      analysis_types: ['frame_diff', 'layout_shift', 'color_change', 'motion_vector', 'element_visibility'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.analysis_results?.frame_diff).toBeDefined();
      expect(result.data?.analysis_results?.layout_shift).toBeDefined();
      expect(result.data?.analysis_results?.color_change).toBeDefined();
    }
  });
});
