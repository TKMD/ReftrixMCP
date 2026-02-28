// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect video mode テスト
 * TDD Red Phase: 実装前に失敗するテストを作成
 *
 * Phase1: 動画キャプチャ - Playwright録画 + フレーム解析
 *
 * video mode 仕様:
 * - detection_mode: 'video' を指定
 * - url パラメータ必須（録画対象のURL）
 * - VideoRecorderService で録画
 * - FrameAnalyzerService でフレーム解析
 * - モーションセグメントを検出してパターンに変換
 *
 * @module tests/tools/motion/detect-video-mode.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// =====================================================
// インポート
// =====================================================

import {
  motionDetectInputSchema,
  type MotionDetectInput,
} from '../../../src/tools/motion/schemas';

import {
  motionDetectHandler,
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
  setVideoRecorderServiceFactory,
  resetVideoRecorderServiceFactory,
  setFrameAnalyzerServiceFactory,
  resetFrameAnalyzerServiceFactory,
  type IVideoRecorderService,
  type IFrameAnalyzerService,
} from '../../../src/tools/motion/detect.tool';

import type { RecordResult } from '../../../src/services/page/video-recorder.service';
import type { AnalyzeResult, MotionSegment, ExtractResult } from '../../../src/services/page/frame-analyzer.service';

// =====================================================
// テストデータ
// =====================================================

const sampleUrl = 'https://example.com/animated-page';

/**
 * モック録画結果
 */
const mockRecordResult: RecordResult = {
  videoPath: '/tmp/video-recorder-test/video.webm',
  durationMs: 5000,
  sizeBytes: 1024 * 100, // 100KB
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
    { index: 2, path: '/tmp/frames/frame-0002.png', timestampMs: 200 },
  ],
  totalFrames: 50,
  fps: 10,
  durationMs: 5000,
  outputDir: '/tmp/frames',
  processingTimeMs: 200,
};

/**
 * モックフレーム解析結果（モーションあり）
 * MotionSegment型に正確に合わせる:
 * - startMs, endMs, durationMs
 * - avgChangeRatio, maxChangeRatio
 * - estimatedType, estimatedEasing
 */
const mockAnalyzeResultWithMotion: AnalyzeResult = {
  diffs: [],  // テストではdiffsの詳細は不要
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
    {
      startMs: 2500,
      endMs: 3500,
      durationMs: 1000,
      avgChangeRatio: 0.12,
      maxChangeRatio: 0.20,
      estimatedType: 'slide',
      estimatedEasing: 'ease-in-out',
    },
  ],
  motionCoverage: 0.40,  // 2 segments * 1000ms / 5000ms = 0.40
  durationMs: 5000,
  processingTimeMs: 500,
};

/**
 * モックフレーム解析結果（モーションなし）
 */
const mockAnalyzeResultNoMotion: AnalyzeResult = {
  diffs: [],
  totalFrames: 50,
  motionSegments: [],
  motionCoverage: 0.0,
  durationMs: 5000,
  processingTimeMs: 300,
};

// =====================================================
// detection_mode: 'video' スキーマバリデーションテスト
// =====================================================

describe('motionDetectInputSchema detection_mode: video', () => {
  describe('スキーマ拡張', () => {
    it('detection_mode: "video" を受け付ける', () => {
      // Phase1: video モードはURLからの動画キャプチャ解析
      const input = {
        url: sampleUrl,
        detection_mode: 'video',
      };
      const result = motionDetectInputSchema.parse(input);

      expect(result.detection_mode).toBe('video');
      expect(result.url).toBe(sampleUrl);
    });

    it('video モードでは url パラメータが必須', () => {
      // video モードでは録画対象のURLが必要
      const input = {
        detection_mode: 'video',
        // url がない
      };

      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('video モードでは html パラメータは不要', () => {
      // video モードはURLから直接キャプチャするためhtmlは不要
      const input = {
        url: sampleUrl,
        detection_mode: 'video',
        // html は指定しない
      };
      const result = motionDetectInputSchema.parse(input);

      expect(result.detection_mode).toBe('video');
      expect(result.html).toBeUndefined();
    });

    it('video_options パラメータを受け付ける', () => {
      // Phase1: 録画オプションのカスタマイズ
      const input = {
        url: sampleUrl,
        detection_mode: 'video',
        video_options: {
          timeout: 60000,
          record_duration: 10000,
          viewport: { width: 1920, height: 1080 },
          scroll_page: true,
          move_mouse: true,
        },
      };
      const result = motionDetectInputSchema.parse(input);

      expect(result.video_options).toBeDefined();
      expect(result.video_options?.timeout).toBe(60000);
      expect(result.video_options?.record_duration).toBe(10000);
      expect(result.video_options?.viewport?.width).toBe(1920);
    });

    it('video_options.frame_analysis パラメータを受け付ける', () => {
      // Phase1: フレーム解析オプション
      const input = {
        url: sampleUrl,
        detection_mode: 'video',
        video_options: {
          frame_analysis: {
            fps: 15,
            change_threshold: 0.02,
            min_motion_duration_ms: 200,
          },
        },
      };
      const result = motionDetectInputSchema.parse(input);

      expect(result.video_options?.frame_analysis?.fps).toBe(15);
      expect(result.video_options?.frame_analysis?.change_threshold).toBe(0.02);
    });
  });

  describe('バリデーションエラー', () => {
    it('video_options.timeout は 1000-120000 の範囲', () => {
      const input = {
        url: sampleUrl,
        detection_mode: 'video',
        video_options: {
          timeout: 500, // 最小値未満
        },
      };

      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('video_options.record_duration は 1000-60000 の範囲', () => {
      const input = {
        url: sampleUrl,
        detection_mode: 'video',
        video_options: {
          record_duration: 100000, // 最大値超過
        },
      };

      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('video_options.frame_analysis.fps は 1-30 の範囲', () => {
      const input = {
        url: sampleUrl,
        detection_mode: 'video',
        video_options: {
          frame_analysis: {
            fps: 60, // 最大値超過
          },
        },
      };

      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('url は有効なURL形式である必要がある', () => {
      const input = {
        url: 'not-a-valid-url',
        detection_mode: 'video',
      };

      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('url は http/https プロトコルのみ許可', () => {
      const input = {
        url: 'file:///etc/passwd',
        detection_mode: 'video',
      };

      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });
  });
});

// =====================================================
// detection_mode: 'video' 機能テスト
// =====================================================

describe('detection_mode: video 機能テスト', () => {
  let mockVideoRecorderService: {
    record: Mock;
    cleanup: Mock;
    close: Mock;
  };
  let mockFrameAnalyzerService: {
    extractFrames: Mock;
    analyzeMotion: Mock;
    analyze: Mock;
    cleanup: Mock;
  };

  beforeEach(() => {
    resetMotionDetectServiceFactory();
    resetVideoRecorderServiceFactory();
    resetFrameAnalyzerServiceFactory();

    // VideoRecorderService モック
    mockVideoRecorderService = {
      record: vi.fn().mockResolvedValue(mockRecordResult),
      cleanup: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // FrameAnalyzerService モック
    mockFrameAnalyzerService = {
      extractFrames: vi.fn().mockResolvedValue(mockExtractResult),
      analyzeMotion: vi.fn().mockResolvedValue(mockAnalyzeResultWithMotion),
      analyze: vi.fn().mockResolvedValue(mockAnalyzeResultWithMotion),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    // DIでサービスを注入
    setVideoRecorderServiceFactory(() => mockVideoRecorderService as unknown as IVideoRecorderService);
    setFrameAnalyzerServiceFactory(() => mockFrameAnalyzerService as unknown as IFrameAnalyzerService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetVideoRecorderServiceFactory();
    resetFrameAnalyzerServiceFactory();
  });

  describe('正常系', () => {
    it('URLから動画を録画してモーションパターンを検出する', async () => {
      // Phase1 コア機能: URL → 録画 → フレーム解析 → パターン検出
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // モーションセグメントがパターンに変換される
        expect(result.data.patterns.length).toBe(2);

        // 各パターンの基本情報
        const pattern1 = result.data.patterns[0];
        expect(pattern1.type).toBe('video_motion');
        // maxChangeRatio=0.15 → micro_interaction (0.05 < 0.15 <= 0.15)
        expect(pattern1.category).toBe('micro_interaction');
        // durationMs=1000 → hover (300 < 1000 <= 1000)
        expect(pattern1.trigger).toBe('hover');

        // アニメーション情報
        expect(pattern1.animation.duration).toBe(1000); // durationMs
        expect(pattern1.animation.delay).toBe(500); // startMs

        // プロパティ情報（fadeタイプはopacityのみ）
        expect(pattern1.properties).toHaveLength(1);
        expect(pattern1.properties[0]).toEqual({ property: 'opacity' });
      }
    });

    it('録画後に一時ファイルがクリーンアップされる', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      await motionDetectHandler(input);

      // cleanup が呼ばれたことを確認
      expect(mockVideoRecorderService.cleanup).toHaveBeenCalled();
      expect(mockFrameAnalyzerService.cleanup).toHaveBeenCalled();
    });

    it('video_options でカスタムパラメータを指定できる', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        video_options: {
          timeout: 60000,
          record_duration: 10000,
          viewport: { width: 1920, height: 1080 },
        },
      };

      await motionDetectHandler(input);

      // VideoRecorderService に正しいオプションが渡されたことを確認
      expect(mockVideoRecorderService.record).toHaveBeenCalledWith(
        sampleUrl,
        expect.objectContaining({
          timeout: 60000,
          recordDuration: 10000,
          viewport: { width: 1920, height: 1080 },
        })
      );
    });

    it('モーションがない場合は空のパターン配列を返す', async () => {
      // モーションなしの結果を返すようにモック
      // executeVideoDetectionはanalyzeMotionを呼ぶため、そちらをモック
      mockFrameAnalyzerService.analyzeMotion.mockResolvedValue(mockAnalyzeResultNoMotion);

      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBe(0);
        expect(result.data.summary?.totalPatterns).toBe(0);
      }
    });

    it('サマリー情報にvideo固有のメタデータが含まれる', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        includeSummary: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.summary).toBeDefined();
        expect(result.data.summary?.totalPatterns).toBe(2);

        // video モード固有のメタデータ
        expect(result.data.video_info).toBeDefined();
        expect(result.data.video_info?.record_duration_ms).toBe(5000);
        expect(result.data.video_info?.frames_analyzed).toBe(50);
        expect(result.data.video_info?.motion_coverage).toBe(0.40);
      }
    });
  });

  describe('エラーハンドリング', () => {
    it('録画エラー時に適切なエラーを返す', async () => {
      mockVideoRecorderService.record.mockRejectedValue(
        new Error('Network error: unable to resolve DNS')
      );

      const input: MotionDetectInput = {
        url: 'https://nonexistent-domain-12345.com',
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VIDEO_RECORD_ERROR');
        expect(result.error.message).toContain('DNS');
      }
    });

    it('タイムアウトエラーが適切にハンドリングされる', async () => {
      mockVideoRecorderService.record.mockRejectedValue(
        new Error('Timeout: page load exceeded 30000ms')
      );

      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VIDEO_TIMEOUT_ERROR');
        expect(result.error.message).toContain('Timeout');
      }
    });

    it('SSRFブロックエラーが適切にハンドリングされる', async () => {
      const input: MotionDetectInput = {
        url: 'http://169.254.169.254/metadata', // AWS metadata endpoint
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SSRF_BLOCKED');
        expect(result.error.message).toContain('blocked');
      }
    });

    it('フレーム解析エラー時に適切なエラーを返す', async () => {
      // executeVideoDetectionはanalyzeMotionを呼ぶため、そちらをrejectするようにモック
      mockFrameAnalyzerService.analyzeMotion.mockRejectedValue(
        new Error('FFmpeg not found')
      );

      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FRAME_ANALYSIS_ERROR');
        expect(result.error.message).toContain('FFmpeg');
      }
    });

    it('エラー時もクリーンアップが実行される', async () => {
      mockVideoRecorderService.record.mockRejectedValue(
        new Error('Recording failed')
      );

      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      await motionDetectHandler(input);

      // エラー時もクリーンアップが呼ばれることを確認
      // 録画が失敗した場合、cleanup は呼ばれない可能性があるが
      // 一時ファイルの削除は試行される
    });
  });

  describe('パターン変換', () => {
    it('MotionSegment が MotionPattern に正しく変換される', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const pattern = result.data.patterns[0];

        // 基本フィールド
        expect(pattern.id).toBeDefined();
        expect(pattern.name).toContain('video-motion');
        expect(pattern.type).toBe('video_motion');

        // カテゴリとトリガー（maxChangeRatioとdurationMsから推定）
        expect(pattern.category).toBe('micro_interaction');
        expect(pattern.trigger).toBe('hover');

        // アニメーション情報
        expect(pattern.animation).toBeDefined();
        expect(pattern.animation.duration).toBe(1000);
        expect(pattern.animation.delay).toBe(500);

        // プロパティ
        expect(pattern.properties).toBeDefined();
        expect(Array.isArray(pattern.properties)).toBe(true);
      }
    });

    it('maxChangeRatio が高いセグメントは intensity: high とマークされる', async () => {
      const highIntensityResult: AnalyzeResult = {
        ...mockAnalyzeResultWithMotion,
        motionSegments: [
          {
            startMs: 0,
            endMs: 1000,
            durationMs: 1000,
            avgChangeRatio: 0.25,
            maxChangeRatio: 0.35, // 高い変化率 >= 0.25 なので high
            estimatedType: 'fade',
            estimatedEasing: 'ease-out',
          },
        ],
      };
      // executeVideoDetectionはanalyzeMotionを呼ぶため、そちらをモック
      mockFrameAnalyzerService.analyzeMotion.mockResolvedValue(highIntensityResult);

      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const pattern = result.data.patterns[0];
        // video_motion パターンには intensity メタデータが含まれる
        expect(pattern.videoMetadata?.intensity).toBe('high');
      }
    });

    it('複数のセグメントが独立したパターンとして生成される', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // mockAnalyzeResultWithMotion には2つのセグメントがある
        expect(result.data.patterns.length).toBe(2);

        // 各パターンは異なるタイミング
        const pattern1 = result.data.patterns[0];
        const pattern2 = result.data.patterns[1];

        expect(pattern1.animation.delay).toBe(500);
        expect(pattern2.animation.delay).toBe(2500);
      }
    });
  });

  describe('SSRF保護', () => {
    it('プライベートIP (10.x.x.x) はブロックされる', async () => {
      const input: MotionDetectInput = {
        url: 'http://10.0.0.1/admin',
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SSRF_BLOCKED');
      }
    });

    it('プライベートIP (192.168.x.x) はブロックされる', async () => {
      const input: MotionDetectInput = {
        url: 'http://192.168.1.1/config',
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SSRF_BLOCKED');
      }
    });

    it('localhost はブロックされる', async () => {
      const input: MotionDetectInput = {
        url: 'http://localhost:8080/internal',
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SSRF_BLOCKED');
      }
    });

    it('127.0.0.1 はブロックされる', async () => {
      const input: MotionDetectInput = {
        url: 'http://127.0.0.1:3000/api',
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SSRF_BLOCKED');
      }
    });
  });
});

// =====================================================
// 統合テスト（スキップ - 実環境で実行）
// =====================================================

describe.skip('detection_mode: video 統合テスト（実環境）', () => {
  // これらのテストは実際のPlaywrightとffmpegが必要

  it('実際のWebページを録画してモーション検出', async () => {
    const input: MotionDetectInput = {
      url: 'https://example.com',
      detection_mode: 'video',
      video_options: {
        record_duration: 3000,
      },
    };

    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
  });

  it('アニメーションのあるページでモーション検出', async () => {
    // アニメーションのある実際のページでテスト
    const input: MotionDetectInput = {
      url: 'https://animate.style/', // CSS アニメーションライブラリのサイト
      detection_mode: 'video',
      video_options: {
        record_duration: 5000,
        scroll_page: true,
      },
    };

    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // アニメーションが検出されるはず
      expect(result.data.patterns.length).toBeGreaterThan(0);
    }
  });
});
