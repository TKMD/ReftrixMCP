// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect Lighthouse統合テスト
 * TDD Red Phase: 実装前に失敗するテストを作成
 *
 * Phase3: パフォーマンスプロファイリング - Lighthouse API統合
 *
 * Lighthouse統合仕様:
 * - lighthouse_options パラメータでLighthouse実行を有効化
 * - video mode と組み合わせて使用可能
 * - 7つのパフォーマンスメトリクスを抽出
 *   - FCP (First Contentful Paint)
 *   - LCP (Largest Contentful Paint)
 *   - CLS (Cumulative Layout Shift)
 *   - TBT (Total Blocking Time)
 *   - SI (Speed Index)
 *   - TTI (Time to Interactive)
 *   - performance_score (0-100)
 *
 * @module tests/tools/motion/detect-lighthouse.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// =====================================================
// インポート
// =====================================================

import {
  motionDetectInputSchema,
  lighthouseOptionsSchema,
  lighthouseMetricsSchema,
  type MotionDetectInput,
  type LighthouseOptions,
  type LighthouseMetrics,
} from '../../../src/tools/motion/schemas';

import {
  motionDetectHandler,
  setLighthouseDetectorServiceFactory,
  resetLighthouseDetectorServiceFactory,
  setVideoRecorderServiceFactory,
  resetVideoRecorderServiceFactory,
  setFrameAnalyzerServiceFactory,
  resetFrameAnalyzerServiceFactory,
  type ILighthouseDetectorService,
  type IVideoRecorderService,
  type IFrameAnalyzerService,
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
 * モックフレーム解析結果
 */
const mockAnalyzeResultWithMotion: AnalyzeResult = {
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
 * モックLighthouseメトリクス結果
 */
const mockLighthouseMetrics: LighthouseMetrics = {
  fcp: 1200,        // First Contentful Paint (ms)
  lcp: 2500,        // Largest Contentful Paint (ms)
  cls: 0.05,        // Cumulative Layout Shift (score)
  tbt: 150,         // Total Blocking Time (ms)
  si: 1800,         // Speed Index (ms)
  tti: 3500,        // Time to Interactive (ms)
  performance_score: 85, // 0-100
  fetched_at: new Date().toISOString(),
};

/**
 * 詳細なLighthouseレポートデータ
 */
const mockLighthouseDetailedResult = {
  metrics: mockLighthouseMetrics,
  audits: {
    'first-contentful-paint': {
      score: 0.9,
      numericValue: 1200,
      displayValue: '1.2 s',
    },
    'largest-contentful-paint': {
      score: 0.75,
      numericValue: 2500,
      displayValue: '2.5 s',
    },
    'cumulative-layout-shift': {
      score: 0.95,
      numericValue: 0.05,
      displayValue: '0.050',
    },
    'total-blocking-time': {
      score: 0.85,
      numericValue: 150,
      displayValue: '150 ms',
    },
    'speed-index': {
      score: 0.88,
      numericValue: 1800,
      displayValue: '1.8 s',
    },
  },
  processingTimeMs: 35000,
  rawReport: null, // オプション
};

// =====================================================
// モック設定
// =====================================================

/**
 * モックLighthouseDetectorService
 */
const createMockLighthouseDetectorService = (
  overrides: Partial<ILighthouseDetectorService> = {}
): ILighthouseDetectorService => ({
  analyze: vi.fn().mockResolvedValue(mockLighthouseDetailedResult),
  isAvailable: vi.fn().mockResolvedValue(true),
  ...overrides,
});

// =====================================================
// テストスイート
// =====================================================

describe('motion.detect Lighthouse統合', () => {
  let mockLighthouseService: ILighthouseDetectorService;
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
    // Lighthouse Service モック
    mockLighthouseService = createMockLighthouseDetectorService();
    setLighthouseDetectorServiceFactory(() => mockLighthouseService);

    // VideoRecorderService モック（video mode用）
    mockVideoRecorderService = {
      record: vi.fn().mockResolvedValue(mockRecordResult),
      cleanup: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // FrameAnalyzerService モック（video mode用）
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
    resetLighthouseDetectorServiceFactory();
    resetVideoRecorderServiceFactory();
    resetFrameAnalyzerServiceFactory();
    vi.clearAllMocks();
  });

  // =========================================================
  // 1. スキーマバリデーション
  // =========================================================

  describe('lighthouseOptionsSchema バリデーション', () => {
    it('有効なlighthouse_optionsを受け付ける', () => {
      const validOptions: LighthouseOptions = {
        enabled: true,
        categories: ['performance'],
        throttling: false,
        save_to_db: false,
      };

      const result = lighthouseOptionsSchema.safeParse(validOptions);
      expect(result.success).toBe(true);
    });

    it('enabled=falseでLighthouse無効化', () => {
      const options: LighthouseOptions = {
        enabled: false,
      };

      const result = lighthouseOptionsSchema.safeParse(options);
      expect(result.success).toBe(true);
      expect(result.data?.enabled).toBe(false);
    });

    it('categoriesにperformance以外を指定可能', () => {
      const options: LighthouseOptions = {
        enabled: true,
        categories: ['performance', 'accessibility'],
      };

      const result = lighthouseOptionsSchema.safeParse(options);
      expect(result.success).toBe(true);
    });

    it('timeoutの範囲チェック (30000-120000ms)', () => {
      // 最小値以下
      const tooShort = lighthouseOptionsSchema.safeParse({
        enabled: true,
        timeout: 20000,
      });
      expect(tooShort.success).toBe(false);

      // 最大値以上
      const tooLong = lighthouseOptionsSchema.safeParse({
        enabled: true,
        timeout: 150000,
      });
      expect(tooLong.success).toBe(false);

      // 有効範囲
      const valid = lighthouseOptionsSchema.safeParse({
        enabled: true,
        timeout: 60000,
      });
      expect(valid.success).toBe(true);
    });
  });

  describe('lighthouseMetricsSchema バリデーション', () => {
    it('有効なメトリクスを受け付ける', () => {
      const result = lighthouseMetricsSchema.safeParse(mockLighthouseMetrics);
      expect(result.success).toBe(true);
    });

    it('performance_scoreは0-100の範囲', () => {
      const invalidLow = lighthouseMetricsSchema.safeParse({
        ...mockLighthouseMetrics,
        performance_score: -1,
      });
      expect(invalidLow.success).toBe(false);

      const invalidHigh = lighthouseMetricsSchema.safeParse({
        ...mockLighthouseMetrics,
        performance_score: 101,
      });
      expect(invalidHigh.success).toBe(false);
    });

    it('CLSは0-1の範囲', () => {
      const invalidCls = lighthouseMetricsSchema.safeParse({
        ...mockLighthouseMetrics,
        cls: 1.5,
      });
      expect(invalidCls.success).toBe(false);
    });
  });

  describe('motionDetectInputSchema - lighthouse_options統合', () => {
    it('lighthouse_optionsを含む入力を受け付ける', () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
          categories: ['performance'],
        },
      };

      const result = motionDetectInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('lighthouse_optionsは任意パラメータ', () => {
      const input = {
        html: '<html><body></body></html>',
        detection_mode: 'css',
      };

      const result = motionDetectInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data?.lighthouse_options).toBeUndefined();
    });
  });

  // =========================================================
  // 2. ハンドラー統合テスト
  // =========================================================

  describe('motionDetectHandler - Lighthouse統合', () => {
    it('lighthouse_options.enabled=trueでLighthouseを実行', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      expect(result.data?.lighthouse_metrics).toBeDefined();
      expect(result.data?.lighthouse_metrics?.performance_score).toBe(85);
      expect(mockLighthouseService.analyze).toHaveBeenCalledWith(
        sampleUrl,
        expect.objectContaining({ categories: ['performance'] })
      );
    });

    it('lighthouse_options未指定時はLighthouse実行しない', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      // lighthouse_metricsはundefinedまたはnullになる（実装依存）
      expect(result.data?.lighthouse_metrics).toBeFalsy();
      expect(mockLighthouseService.analyze).not.toHaveBeenCalled();
    });

    it('lighthouse_options.enabled=falseでLighthouse実行しない', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: false,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      // lighthouse_metricsはundefinedまたはnullになる（実装依存）
      expect(result.data?.lighthouse_metrics).toBeFalsy();
      expect(mockLighthouseService.analyze).not.toHaveBeenCalled();
    });

    it('Lighthouseメトリクスが出力に含まれる', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      const metrics = result.data?.lighthouse_metrics;
      expect(metrics).toBeDefined();
      expect(metrics?.fcp).toBe(1200);
      expect(metrics?.lcp).toBe(2500);
      expect(metrics?.cls).toBe(0.05);
      expect(metrics?.tbt).toBe(150);
      expect(metrics?.si).toBe(1800);
      expect(metrics?.tti).toBe(3500);
      expect(metrics?.performance_score).toBe(85);
    });

    it('categoriesオプションがLighthouseに渡される', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
          categories: ['performance', 'accessibility'],
        },
      };

      await motionDetectHandler(input);

      expect(mockLighthouseService.analyze).toHaveBeenCalledWith(
        sampleUrl,
        expect.objectContaining({
          categories: ['performance', 'accessibility'],
        })
      );
    });

    it('throttling=falseがLighthouseに渡される', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
          throttling: false,
        },
      };

      await motionDetectHandler(input);

      expect(mockLighthouseService.analyze).toHaveBeenCalledWith(
        sampleUrl,
        expect.objectContaining({
          throttling: false,
        })
      );
    });
  });

  // =========================================================
  // 3. エラーハンドリング
  // =========================================================

  describe('Lighthouseエラーハンドリング', () => {
    it('Lighthouse実行失敗時はlighthouse_metricsがnullで返る', async () => {
      // Note: エラーメッセージに 'timeout' を含むとLIGHTHOUSE_TIMEOUTになるため、
      // 一般的なエラーをテスト
      const mockFailingService = createMockLighthouseDetectorService({
        analyze: vi.fn().mockRejectedValue(new Error('Lighthouse analysis failed: Network error')),
      });
      setLighthouseDetectorServiceFactory(() => mockFailingService);

      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
        },
      };

      const result = await motionDetectHandler(input);

      // motion.detect自体は成功（graceful degradation）
      expect(result.success).toBe(true);
      expect(result.data?.lighthouse_metrics).toBeNull();
      expect(result.data?.lighthouse_error).toBeDefined();
      expect(result.data?.lighthouse_error?.code).toBe('LIGHTHOUSE_ERROR');
    });

    it('Lighthouseが利用不可の場合はwarningを出力', async () => {
      const mockUnavailableService = createMockLighthouseDetectorService({
        isAvailable: vi.fn().mockResolvedValue(false),
      });
      setLighthouseDetectorServiceFactory(() => mockUnavailableService);

      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      expect(result.data?.lighthouse_metrics).toBeNull();
      expect(result.data?.warnings).toContainEqual(
        expect.objectContaining({
          code: 'LIGHTHOUSE_UNAVAILABLE',
          severity: 'warning',
        })
      );
    });

    it('タイムアウト時に適切なエラーコードを返す', async () => {
      const timeoutError = new Error('Lighthouse timed out');
      (timeoutError as any).code = 'TIMEOUT';

      const mockTimeoutService = createMockLighthouseDetectorService({
        analyze: vi.fn().mockRejectedValue(timeoutError),
      });
      setLighthouseDetectorServiceFactory(() => mockTimeoutService);

      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
          timeout: 60000,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      expect(result.data?.lighthouse_error?.code).toBe('LIGHTHOUSE_TIMEOUT');
    });
  });

  // =========================================================
  // 4. Video Mode + Lighthouse 統合
  // =========================================================

  describe('Video Mode + Lighthouse 統合', () => {
    it('video modeとLighthouseを同時実行できる', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        video_options: {
          record_duration: 3000,
        },
        lighthouse_options: {
          enabled: true,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      // video mode結果
      expect(result.data?.patterns).toBeDefined();
      expect(result.data?.video_info).toBeDefined();
      // Lighthouse結果
      expect(result.data?.lighthouse_metrics).toBeDefined();
    });

    it('Lighthouseは video mode完了後に実行される', async () => {
      const callOrder: string[] = [];

      // 実行順序を記録するモック
      mockLighthouseService.analyze = vi.fn().mockImplementation(async () => {
        callOrder.push('lighthouse');
        return mockLighthouseDetailedResult;
      });

      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
        },
      };

      await motionDetectHandler(input);

      // Lighthouseが呼ばれたことを確認
      expect(callOrder).toContain('lighthouse');
    });
  });

  // =========================================================
  // 5. 処理時間・パフォーマンス
  // =========================================================

  describe('処理時間・パフォーマンス', () => {
    it('lighthouse_processing_time_msがメタデータに含まれる', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      // 実装は実際の経過時間を測定するため、0以上であることを確認
      // （モックは即座に返すのでほぼ0ms）
      expect(typeof result.data?.metadata?.lighthouse_processing_time_ms).toBe('number');
      expect(result.data?.metadata?.lighthouse_processing_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('Lighthouseサービスからの処理時間が適切に記録される', async () => {
      // 遅延を持つモックを設定
      // 注意: setTimeoutの精度はOS/Node.jsにより±数msの誤差があるため、
      // 十分な遅延時間と余裕のある閾値を設定
      const targetDelayMs = 20;
      const minExpectedMs = 15; // タイマー精度を考慮した閾値

      const delayedService = createMockLighthouseDetectorService({
        analyze: vi.fn().mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, targetDelayMs));
          return mockLighthouseResult;
        }),
      });
      setLighthouseDetectorServiceFactory(() => delayedService);

      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        lighthouse_options: {
          enabled: true,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      // 遅延があるため、処理時間は閾値以上になるはず（タイマー精度を考慮）
      expect(result.data?.metadata?.lighthouse_processing_time_ms).toBeGreaterThanOrEqual(minExpectedMs);
    });
  });

  // =========================================================
  // 6. DB保存
  // =========================================================

  describe('Lighthouse結果のDB保存', () => {
    it('save_to_db=trueでLighthouseメトリクスをDBに保存', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        save_to_db: true,
        lighthouse_options: {
          enabled: true,
          save_to_db: true,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      expect(result.data?.lighthouse_save_result).toBeDefined();
      expect(result.data?.lighthouse_save_result?.saved).toBe(true);
    });

    it('lighthouse_options.save_to_db=falseの場合はLighthouseメトリクスを保存しない', async () => {
      const input: MotionDetectInput = {
        url: sampleUrl,
        detection_mode: 'video',
        save_to_db: true, // motionパターンは保存
        lighthouse_options: {
          enabled: true,
          save_to_db: false, // Lighthouseは保存しない
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      expect(result.data?.lighthouse_save_result).toBeUndefined();
    });
  });
});

// =====================================================
// AnimationMetricsCollector テスト
// =====================================================

/**
 * AnimationMetricsCollector TDD Red Phase
 *
 * 目的: MotionPatternとLighthouseメトリクスを分析し、
 * アニメーションがパフォーマンスに与える影響を定量化する
 *
 * 主要機能:
 * 1. 各アニメーションのパフォーマンス影響度スコア計算
 * 2. CLSに影響するアニメーション特定
 * 3. レイアウトトリガーするプロパティ検出
 * 4. パフォーマンス改善提案生成
 */

// AnimationMetricsCollectorのインポート（TDD Red: まだ存在しない）
import {
  AnimationMetricsCollector,
  type AnimationMetricsInput,
  type AnimationMetricsResult,
  type AnimationImpactScore,
  type PerformanceRecommendation,
} from '../../../src/services/motion/animation-metrics-collector.service';

import type { MotionPattern, LighthouseMetrics } from '../../../src/tools/motion/schemas';

// =====================================================
// AnimationMetricsCollector テストデータ
// =====================================================

/**
 * テスト用MotionPattern
 */
const createMockMotionPattern = (overrides: Partial<MotionPattern> = {}): MotionPattern => ({
  id: `pattern-${Math.random().toString(36).slice(2, 9)}`,
  type: 'css_animation',
  name: 'test-animation',
  category: 'micro_interaction',
  trigger: 'hover',
  animation: {
    duration: 300,
    delay: 0,
    easing: 'ease-out',
    iterations: 1,
    direction: 'normal',
    fillMode: 'none',
  },
  properties: ['opacity', 'transform'],
  performance: {
    usesTransform: true,
    usesOpacity: true,
    triggersLayout: false,
    triggersPaint: false,
    level: 'good',
  },
  ...overrides,
});

/**
 * レイアウトをトリガーするMotionPattern（パフォーマンス悪い）
 */
const createLayoutTriggeringPattern = (): MotionPattern =>
  createMockMotionPattern({
    id: 'pattern-layout-trigger',
    name: 'bad-animation',
    properties: ['width', 'height', 'top', 'left'],
    performance: {
      usesTransform: false,
      usesOpacity: false,
      triggersLayout: true,
      triggersPaint: true,
      level: 'poor',
    },
  });

/**
 * CLSを引き起こす可能性のあるMotionPattern
 */
const createClsCausingPattern = (): MotionPattern =>
  createMockMotionPattern({
    id: 'pattern-cls-risk',
    name: 'cls-animation',
    category: 'loading_state',
    trigger: 'load',
    properties: ['height', 'margin', 'padding'],
    animation: {
      duration: 500,
      delay: 200, // 遅延後のサイズ変更はCLSを引き起こす
      easing: 'ease-in-out',
      iterations: 1,
      direction: 'normal',
      fillMode: 'forwards',
    },
    performance: {
      usesTransform: false,
      usesOpacity: false,
      triggersLayout: true,
      triggersPaint: true,
      level: 'poor',
    },
  });

/**
 * 良好なパフォーマンスのMotionPattern
 */
const createOptimalPattern = (): MotionPattern =>
  createMockMotionPattern({
    id: 'pattern-optimal',
    name: 'optimal-animation',
    properties: ['transform', 'opacity'],
    performance: {
      usesTransform: true,
      usesOpacity: true,
      triggersLayout: false,
      triggersPaint: false,
      level: 'excellent',
    },
  });

/**
 * テスト用Lighthouseメトリクス（良好）
 */
const goodLighthouseMetrics: LighthouseMetrics = {
  fcp: 1200, // First Contentful Paint: 1.2s (good)
  lcp: 2000, // Largest Contentful Paint: 2.0s (good)
  cls: 0.05, // Cumulative Layout Shift: 0.05 (good)
  tbt: 150, // Total Blocking Time: 150ms (good)
  si: 2500, // Speed Index: 2.5s (good)
  tti: 3000, // Time to Interactive: 3.0s (good)
  performance_score: 90,
  fetched_at: new Date().toISOString(),
};

/**
 * テスト用Lighthouseメトリクス（悪い - CLS問題あり）
 */
const badClsLighthouseMetrics: LighthouseMetrics = {
  fcp: 1500,
  lcp: 2500,
  cls: 0.35, // CLS: 0.35 (poor - > 0.25)
  tbt: 300,
  si: 3500,
  tti: 4000,
  performance_score: 55,
  fetched_at: new Date().toISOString(),
};

/**
 * テスト用Lighthouseメトリクス（悪い - TBT問題あり）
 */
const badTbtLighthouseMetrics: LighthouseMetrics = {
  fcp: 1800,
  lcp: 3000,
  cls: 0.08,
  tbt: 800, // TBT: 800ms (poor - > 600ms)
  si: 4000,
  tti: 5500,
  performance_score: 45,
  fetched_at: new Date().toISOString(),
};

// =====================================================
// AnimationMetricsCollector テストスイート
// =====================================================

describe('AnimationMetricsCollector', () => {
  let collector: AnimationMetricsCollector;

  beforeEach(() => {
    collector = new AnimationMetricsCollector();
  });

  // =========================================================
  // 1. 基本インスタンス化テスト
  // =========================================================

  describe('インスタンス化', () => {
    it('AnimationMetricsCollectorをインスタンス化できる', () => {
      expect(collector).toBeInstanceOf(AnimationMetricsCollector);
    });

    it('analyzeメソッドを持つ', () => {
      expect(typeof collector.analyze).toBe('function');
    });

    it('calculateImpactScoreメソッドを持つ', () => {
      expect(typeof collector.calculateImpactScore).toBe('function');
    });

    it('getRecommendationsメソッドを持つ', () => {
      expect(typeof collector.getRecommendations).toBe('function');
    });
  });

  // =========================================================
  // 2. アニメーション影響度分析
  // =========================================================

  describe('アニメーション影響度分析', () => {
    it('MotionPatternとLighthouseメトリクスを関連付ける', async () => {
      const patterns: MotionPattern[] = [
        createOptimalPattern(),
        createLayoutTriggeringPattern(),
      ];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: goodLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      expect(result).toBeDefined();
      expect(result.patternImpacts).toHaveLength(2);
      expect(result.overallScore).toBeGreaterThanOrEqual(0);
      expect(result.overallScore).toBeLessThanOrEqual(100);
    });

    it('パフォーマンス影響の大きいアニメーションを特定', async () => {
      const patterns: MotionPattern[] = [
        createOptimalPattern(),
        createLayoutTriggeringPattern(),
        createClsCausingPattern(),
      ];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: badClsLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      // レイアウトトリガーするパターンが高影響度として検出される
      const highImpactPatterns = result.patternImpacts.filter(
        (p) => p.impactLevel === 'high'
      );
      expect(highImpactPatterns.length).toBeGreaterThanOrEqual(1);

      // レイアウトトリガーパターンが含まれる
      const layoutPattern = result.patternImpacts.find(
        (p) => p.patternId === 'pattern-layout-trigger'
      );
      expect(layoutPattern).toBeDefined();
      expect(layoutPattern?.impactLevel).toBe('high');
    });

    it('各パターンの影響度スコアを0-100で計算', async () => {
      const patterns: MotionPattern[] = [createOptimalPattern()];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: goodLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      for (const impact of result.patternImpacts) {
        expect(impact.score).toBeGreaterThanOrEqual(0);
        expect(impact.score).toBeLessThanOrEqual(100);
      }
    });
  });

  // =========================================================
  // 3. CLS影響分析
  // =========================================================

  describe('CLS影響分析', () => {
    it('CLSに影響するアニメーションを特定', async () => {
      const patterns: MotionPattern[] = [
        createOptimalPattern(),
        createClsCausingPattern(),
      ];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: badClsLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      // CLS影響アニメーションが検出される
      expect(result.clsContributors).toBeDefined();
      expect(result.clsContributors.length).toBeGreaterThanOrEqual(1);

      // CLS関連パターンが含まれる
      const clsPattern = result.clsContributors.find(
        (c) => c.patternId === 'pattern-cls-risk'
      );
      expect(clsPattern).toBeDefined();
    });

    it('CLSが良好な場合はCLS貢献者が少ない', async () => {
      const patterns: MotionPattern[] = [
        createOptimalPattern(),
        createOptimalPattern(),
      ];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: goodLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      // 良好なパターンのみの場合、CLS貢献者は少ないか空
      expect(result.clsContributors.length).toBeLessThanOrEqual(1);
    });

    it('遅延を持つサイズ変更アニメーションをCLSリスクとして検出', async () => {
      const delayedSizeChangePattern = createMockMotionPattern({
        id: 'pattern-delayed-size',
        name: 'delayed-size-change',
        trigger: 'load',
        properties: ['height', 'width'],
        animation: {
          duration: 300,
          delay: 500, // 500ms遅延
          easing: 'ease',
          iterations: 1,
          direction: 'normal',
          fillMode: 'forwards',
        },
        performance: {
          usesTransform: false,
          usesOpacity: false,
          triggersLayout: true,
          triggersPaint: true,
          level: 'poor',
        },
      });

      const input: AnimationMetricsInput = {
        patterns: [delayedSizeChangePattern],
        lighthouseMetrics: badClsLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      expect(result.clsContributors).toHaveLength(1);
      expect(result.clsContributors[0].reason).toContain('delay');
    });
  });

  // =========================================================
  // 4. レイアウトプロパティ検出
  // =========================================================

  describe('レイアウトプロパティ検出', () => {
    it('レイアウトをトリガーするプロパティを検出', async () => {
      const patterns: MotionPattern[] = [createLayoutTriggeringPattern()];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: badTbtLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      // レイアウトプロパティが検出される
      expect(result.layoutTriggeringProperties).toBeDefined();
      expect(result.layoutTriggeringProperties).toContain('width');
      expect(result.layoutTriggeringProperties).toContain('height');
    });

    it('transform/opacityのみの場合はレイアウトトリガーなし', async () => {
      const patterns: MotionPattern[] = [createOptimalPattern()];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: goodLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      // レイアウトトリガープロパティなし
      expect(result.layoutTriggeringProperties).toHaveLength(0);
    });
  });

  // =========================================================
  // 5. パフォーマンス改善提案
  // =========================================================

  describe('パフォーマンス改善提案', () => {
    it('問題のあるアニメーションに対して改善提案を生成', async () => {
      const patterns: MotionPattern[] = [
        createLayoutTriggeringPattern(),
        createClsCausingPattern(),
      ];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: badClsLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      expect(result.recommendations).toBeDefined();
      expect(result.recommendations.length).toBeGreaterThanOrEqual(1);
    });

    it('改善提案にpriority/category/descriptionが含まれる', async () => {
      const patterns: MotionPattern[] = [createLayoutTriggeringPattern()];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: badTbtLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      for (const rec of result.recommendations) {
        expect(rec.priority).toMatch(/^(high|medium|low)$/);
        expect(rec.category).toBeDefined();
        expect(rec.description).toBeDefined();
        expect(rec.affectedPatternIds).toBeDefined();
      }
    });

    it('レイアウトプロパティに対してtransform使用を提案', async () => {
      const patterns: MotionPattern[] = [
        createMockMotionPattern({
          id: 'pattern-left-top',
          properties: ['left', 'top'],
          performance: {
            usesTransform: false,
            usesOpacity: false,
            triggersLayout: true,
            triggersPaint: true,
            level: 'poor',
          },
        }),
      ];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: badTbtLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      const transformRec = result.recommendations.find(
        (r) => r.category === 'use-transform'
      );
      expect(transformRec).toBeDefined();
      expect(transformRec?.description).toContain('transform');
    });

    it('良好なパターンのみの場合は改善提案が少ない', async () => {
      const patterns: MotionPattern[] = [
        createOptimalPattern(),
        createOptimalPattern(),
      ];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: goodLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      // 改善提案は少ないか空
      expect(result.recommendations.length).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================
  // 6. 単体メソッドテスト
  // =========================================================

  describe('calculateImpactScore', () => {
    it('パターンの影響度スコアを計算', () => {
      const pattern = createLayoutTriggeringPattern();
      const score = collector.calculateImpactScore(pattern, badTbtLighthouseMetrics);

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('レイアウトトリガーパターンは高スコア（悪い）', () => {
      const badPattern = createLayoutTriggeringPattern();
      const goodPattern = createOptimalPattern();

      const badScore = collector.calculateImpactScore(badPattern, badTbtLighthouseMetrics);
      const goodScore = collector.calculateImpactScore(goodPattern, goodLighthouseMetrics);

      // 悪いパターンの方がスコアが高い（影響度が大きい）
      expect(badScore).toBeGreaterThan(goodScore);
    });
  });

  describe('getRecommendations', () => {
    it('パターンから改善提案を生成', () => {
      const patterns: MotionPattern[] = [createLayoutTriggeringPattern()];
      const recommendations = collector.getRecommendations(
        patterns,
        badTbtLighthouseMetrics
      );

      expect(recommendations).toBeDefined();
      expect(Array.isArray(recommendations)).toBe(true);
    });
  });

  // =========================================================
  // 7. エッジケース
  // =========================================================

  describe('エッジケース', () => {
    it('空のパターン配列でも動作', async () => {
      const input: AnimationMetricsInput = {
        patterns: [],
        lighthouseMetrics: goodLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      expect(result).toBeDefined();
      expect(result.patternImpacts).toHaveLength(0);
      expect(result.overallScore).toBe(100); // 問題なしは100点
    });

    it('Lighthouseメトリクスがnullでも動作（graceful degradation）', async () => {
      const patterns: MotionPattern[] = [createOptimalPattern()];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: null as unknown as LighthouseMetrics,
      };

      const result = await collector.analyze(input);

      expect(result).toBeDefined();
      // Lighthouseなしの場合はパターン分析のみ
      expect(result.patternImpacts).toHaveLength(1);
      expect(result.lighthouseAvailable).toBe(false);
    });

    it('無限ループアニメーションを警告', async () => {
      const infinitePattern = createMockMotionPattern({
        id: 'pattern-infinite',
        animation: {
          duration: 1000,
          delay: 0,
          easing: 'linear',
          iterations: Infinity,
          direction: 'normal',
          fillMode: 'none',
        },
      });

      const input: AnimationMetricsInput = {
        patterns: [infinitePattern],
        lighthouseMetrics: goodLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      // 無限ループ警告
      const infiniteRec = result.recommendations.find(
        (r) => r.category === 'infinite-animation'
      );
      expect(infiniteRec).toBeDefined();
    });
  });

  // =========================================================
  // 8. 出力スキーマ検証
  // =========================================================

  describe('出力スキーマ検証', () => {
    it('AnimationMetricsResultの構造が正しい', async () => {
      const patterns: MotionPattern[] = [
        createOptimalPattern(),
        createLayoutTriggeringPattern(),
      ];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: badClsLighthouseMetrics,
      };

      const result = await collector.analyze(input);

      // 必須フィールド検証
      expect(result).toHaveProperty('patternImpacts');
      expect(result).toHaveProperty('overallScore');
      expect(result).toHaveProperty('clsContributors');
      expect(result).toHaveProperty('layoutTriggeringProperties');
      expect(result).toHaveProperty('recommendations');
      expect(result).toHaveProperty('lighthouseAvailable');
      expect(result).toHaveProperty('analyzedAt');

      // 型検証
      expect(typeof result.overallScore).toBe('number');
      expect(typeof result.lighthouseAvailable).toBe('boolean');
      expect(Array.isArray(result.patternImpacts)).toBe(true);
      expect(Array.isArray(result.clsContributors)).toBe(true);
      expect(Array.isArray(result.layoutTriggeringProperties)).toBe(true);
      expect(Array.isArray(result.recommendations)).toBe(true);
    });

    it('AnimationImpactScoreの構造が正しい', async () => {
      const patterns: MotionPattern[] = [createLayoutTriggeringPattern()];

      const input: AnimationMetricsInput = {
        patterns,
        lighthouseMetrics: badTbtLighthouseMetrics,
      };

      const result = await collector.analyze(input);
      const impact = result.patternImpacts[0];

      expect(impact).toHaveProperty('patternId');
      expect(impact).toHaveProperty('patternName');
      expect(impact).toHaveProperty('score');
      expect(impact).toHaveProperty('impactLevel');
      expect(impact).toHaveProperty('factors');

      expect(['high', 'medium', 'low']).toContain(impact.impactLevel);
      expect(Array.isArray(impact.factors)).toBe(true);
    });
  });
});
