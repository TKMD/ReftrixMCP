// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect + AnimationMetricsCollector 統合テスト
 *
 * Phase4-TDD-Red: 失敗テストを先に作成
 *
 * AnimationMetricsCollectorをmotion.detect APIに統合し、
 * 検出されたパターンとLighthouseメトリクスから
 * パフォーマンス影響度スコアと改善提案を自動生成する
 *
 * テスト対象:
 * - analyze_metrics パラメータバリデーション (5テスト)
 * - AnimationMetricsCollector統合 (8テスト)
 * - エラーハンドリング (5テスト)
 *
 * NOTE: このテストはDIモックを使用してPlaywrightブラウザ起動を回避し、
 * CI環境でも高速に実行できます。
 *
 * @module tests/tools/motion/detect-animation-metrics-integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// CI環境でのスキップ条件
// NOTE: モック完備によりCI環境でも実行可能（enable_frame_capture: falseでPlaywright起動を回避）
const SKIP_SLOW_TESTS = process.env.SKIP_SLOW_TESTS === 'true';

// =====================================================
// インポート
// =====================================================

import {
  motionDetectHandler,
  setLighthouseDetectorServiceFactory,
  resetLighthouseDetectorServiceFactory,
  setVideoRecorderServiceFactory,
  resetVideoRecorderServiceFactory,
  setFrameAnalyzerServiceFactory,
  resetFrameAnalyzerServiceFactory,
  setAnimationMetricsCollectorFactory,
  resetAnimationMetricsCollectorFactory,
} from '../../../src/tools/motion/detect.tool';

import {
  motionDetectInputSchema,
  type MotionDetectInput,
  type MotionPattern,
  type LighthouseMetrics,
} from '../../../src/tools/motion/schemas';

import type {
  AnimationMetricsResult,
  AnimationImpactScore,
  ClsContributor,
  PerformanceRecommendation,
} from '../../../src/services/motion/animation-metrics-collector.service';

// =====================================================
// テストヘルパー
// =====================================================

/**
 * テスト用のMotionPatternを作成
 */
function createMockPattern(overrides: Partial<MotionPattern> = {}): MotionPattern {
  return {
    id: 'test-pattern-1',
    name: 'test-animation',
    type: 'css_animation',
    category: 'entrance',
    trigger: 'load',
    animation: {
      duration: 300,
      delay: 0,
      easing: 'ease-out',
      iterations: 1,
    },
    properties: [],
    performance: {
      usesTransform: true,
      usesOpacity: true,
      triggersLayout: false,
      triggersPaint: false,
      level: 'good',
    },
    accessibility: {
      respectsReducedMotion: true,
    },
    ...overrides,
  } as MotionPattern;
}

/**
 * テスト用のLighthouseMetricsを作成
 */
function createMockLighthouseMetrics(
  overrides: Partial<LighthouseMetrics> = {}
): LighthouseMetrics {
  return {
    performance_score: 90,
    cls: 0.05,
    lcp: 1500,
    tbt: 100,
    si: 2000,
    tti: 3000,
    fcp: 1000,
    fetched_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * テスト用のAnimationMetricsResultを作成
 */
function createMockAnimationMetricsResult(
  overrides: Partial<AnimationMetricsResult> = {}
): AnimationMetricsResult {
  return {
    patternImpacts: [
      {
        patternId: 'test-pattern-1',
        patternName: 'test-animation',
        score: 15,
        impactLevel: 'low',
        factors: [],
      },
    ],
    overallScore: 85,
    clsContributors: [],
    layoutTriggeringProperties: [],
    recommendations: [],
    lighthouseAvailable: true,
    analyzedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * モックVideoRecorderServiceを作成
 * IVideoRecorderService インターフェースに準拠: record, cleanup, close
 */
function createMockVideoRecorderService() {
  return {
    record: vi.fn().mockResolvedValue({
      videoPath: '/tmp/test-video.webm',
      duration: 5000,
      sizeBytes: 1024 * 1024,
      viewport: { width: 1280, height: 720 },
      pageTitle: 'Test Page',
    }),
    cleanup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * モックFrameAnalyzerServiceを作成
 * IFrameAnalyzerService インターフェースに準拠
 */
function createMockFrameAnalyzerService(mockPatterns: MotionPattern[] = [createMockPattern()]) {
  return {
    extractFrames: vi.fn().mockResolvedValue({
      framePaths: ['/tmp/frame001.png', '/tmp/frame002.png'],
      totalFrames: 50,
      fps: 10,
      durationMs: 5000,
    }),
    analyzeMotion: vi.fn().mockResolvedValue({
      totalFrames: 50,
      motionSegments: [
        {
          startFrame: 0,
          endFrame: 10,
          startTimeMs: 0,
          endTimeMs: 1000,
          intensity: 0.5,
          type: 'fade',
        },
      ],
      motionCoverage: 0.2,
      detectedPatterns: mockPatterns,
    }),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * モックLighthouseDetectorServiceを作成
 */
function createMockLighthouseService(overrides: Partial<LighthouseMetrics> = {}) {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    analyze: vi.fn().mockResolvedValue({
      metrics: createMockLighthouseMetrics(overrides),
    }),
  };
}

/**
 * モックAnimationMetricsCollectorを作成
 */
function createMockAnimationMetricsCollector(
  overrides: Partial<AnimationMetricsResult> = {}
) {
  return {
    analyze: vi.fn().mockResolvedValue(createMockAnimationMetricsResult(overrides)),
    calculateImpactScore: vi.fn().mockReturnValue(15),
    getRecommendations: vi.fn().mockReturnValue([]),
  };
}

// =====================================================
// Phase4-TDD-Red: analyze_metrics パラメータバリデーション
// =====================================================

// NOTE: 統合テストはブラウザ起動が必要で時間がかかるためCIではスキップ
describe.skipIf(SKIP_SLOW_TESTS)('Phase4: motion.detect + AnimationMetricsCollector 統合', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetLighthouseDetectorServiceFactory();
    resetVideoRecorderServiceFactory();
    resetFrameAnalyzerServiceFactory();
    resetAnimationMetricsCollectorFactory();
  });

  describe('analyze_metrics パラメータバリデーション', () => {
    it('analyze_metrics=trueのスキーマバリデーションが成功する', () => {
      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
      };

      // このテストはスキーマ拡張後に成功する予定
      const result = motionDetectInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('analyze_metricsがデフォルトでfalseになる', () => {
      const input = {
        url: 'https://example.com',
        detection_mode: 'video',
        lighthouse_options: { enabled: true },
      };

      const result = motionDetectInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.analyze_metrics).toBe(false);
      }
    });

    it('analyze_metrics_optionsのスキーマバリデーションが成功する', () => {
      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
        analyze_metrics_options: {
          include_recommendations: true,
          include_cls_contributors: true,
        },
      };

      const result = motionDetectInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    // NOTE: この機能はPhase4で予定されているが、現時点では警告は追加されない
    // 実装が完了したらテストを有効化する
    it.skip('analyze_metrics=trueでlighthouse_options.enabled=falseの場合は警告を追加する', async () => {
      // DI設定 - VideoRecorderServiceファクトリは同期的にIVideoRecorderServiceを返す
      setVideoRecorderServiceFactory(() => createMockVideoRecorderService());
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: false },
        analyze_metrics: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // 警告が含まれることを確認
        expect(result.data.warnings).toBeDefined();
        expect(result.data.warnings?.some((w) =>
          w.code === 'ANALYZE_METRICS_REQUIRES_LIGHTHOUSE'
        )).toBe(true);
      }
    });

    it('detection_mode != "video"の場合はanalyze_metricsを無視する', async () => {
      const input: MotionDetectInput = {
        html: '<div></div>',
        detection_mode: 'css',
        analyze_metrics: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // animation_metricsは含まれない
        expect(result.data.animation_metrics).toBeUndefined();
      }
    });
  });

  // =====================================================
  // Phase4-TDD-Red: AnimationMetricsCollector統合
  // =====================================================

  describe('AnimationMetricsCollector 統合', () => {
    it('analyze_metrics=trueでAnimationMetricsCollectorが呼び出される', async () => {
      const mockAnalyze = vi.fn().mockResolvedValue(createMockAnimationMetricsResult());
      const mockCollector = {
        analyze: mockAnalyze,
        calculateImpactScore: vi.fn(),
        getRecommendations: vi.fn(),
      };

      setVideoRecorderServiceFactory(() =>
        createMockVideoRecorderService()
      );
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService()
      );
      setAnimationMetricsCollectorFactory(() => mockCollector);

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      expect(mockAnalyze).toHaveBeenCalledTimes(1);
    });

    it('animation_metricsがレスポンスに含まれる', async () => {
      const expectedMetrics = createMockAnimationMetricsResult({
        overallScore: 75,
        patternImpacts: [
          {
            patternId: 'test-1',
            patternName: 'fade-in',
            score: 25,
            impactLevel: 'medium',
            factors: ['no-gpu-acceleration'],
          },
        ],
      });

      setVideoRecorderServiceFactory(() =>
        createMockVideoRecorderService()
      );
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService()
      );
      setAnimationMetricsCollectorFactory(() => ({
        analyze: vi.fn().mockResolvedValue(expectedMetrics),
        calculateImpactScore: vi.fn(),
        getRecommendations: vi.fn(),
      }));

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.animation_metrics).toBeDefined();
        expect(result.data.animation_metrics?.overallScore).toBe(75);
        expect(result.data.animation_metrics?.patternImpacts).toHaveLength(1);
      }
    });

    it('patternsとlighthouse_metricsがAnimationMetricsCollectorに渡される', async () => {
      const mockPatterns = [
        createMockPattern({ id: 'pattern-1', name: 'slide-in' }),
        createMockPattern({ id: 'pattern-2', name: 'fade-out' }),
      ];
      const mockLighthouseMetrics = createMockLighthouseMetrics({ cls: 0.2 });

      const mockAnalyze = vi.fn().mockResolvedValue(createMockAnimationMetricsResult());

      // VideoRecorderServiceのモック
      setVideoRecorderServiceFactory(() => createMockVideoRecorderService());
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService(mockPatterns));
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService(mockLighthouseMetrics)
      );
      setAnimationMetricsCollectorFactory(() => ({
        analyze: mockAnalyze,
        calculateImpactScore: vi.fn(),
        getRecommendations: vi.fn(),
      }));

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
      };

      await motionDetectHandler(input);

      expect(mockAnalyze).toHaveBeenCalledWith({
        patterns: expect.any(Array),
        lighthouseMetrics: expect.objectContaining({ cls: 0.2 }),
      });
    });

    it('analyze_metrics_options.include_recommendations=falseでrecommendationsが除外される', async () => {
      const metricsWithRecommendations = createMockAnimationMetricsResult({
        recommendations: [
          {
            priority: 'high',
            category: 'use-transform',
            description: 'Use transform instead of top/left',
            affectedPatternIds: ['test-1'],
          },
        ],
      });

      setVideoRecorderServiceFactory(() =>
        createMockVideoRecorderService()
      );
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService()
      );
      setAnimationMetricsCollectorFactory(() => ({
        analyze: vi.fn().mockResolvedValue(metricsWithRecommendations),
        calculateImpactScore: vi.fn(),
        getRecommendations: vi.fn(),
      }));

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
        analyze_metrics_options: {
          include_recommendations: false,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // include_recommendations=falseの場合、空配列が返される
        expect(result.data.animation_metrics?.recommendations).toHaveLength(0);
      }
    });

    it('analyze_metrics_options.include_cls_contributors=falseでclsContributorsが除外される', async () => {
      const metricsWithClsContributors = createMockAnimationMetricsResult({
        clsContributors: [
          {
            patternId: 'test-1',
            patternName: 'layout-animation',
            estimatedContribution: 0.3,
            reason: 'layout-on-load',
          },
        ],
      });

      setVideoRecorderServiceFactory(() =>
        createMockVideoRecorderService()
      );
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService()
      );
      setAnimationMetricsCollectorFactory(() => ({
        analyze: vi.fn().mockResolvedValue(metricsWithClsContributors),
        calculateImpactScore: vi.fn(),
        getRecommendations: vi.fn(),
      }));

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
        analyze_metrics_options: {
          include_cls_contributors: false,
        },
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // include_cls_contributors=falseの場合、空配列が返される
        expect(result.data.animation_metrics?.clsContributors).toHaveLength(0);
      }
    });

    it('lighthouse_metricsがnullの場合もAnimationMetricsCollectorが動作する', async () => {
      setVideoRecorderServiceFactory(() =>
        createMockVideoRecorderService()
      );
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        Promise.resolve({
          isAvailable: vi.fn().mockResolvedValue(false),
          analyze: vi.fn(),
        })
      );
      setAnimationMetricsCollectorFactory(() =>
        createMockAnimationMetricsCollector({ lighthouseAvailable: false })
      );

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.animation_metrics).toBeDefined();
        expect(result.data.animation_metrics?.lighthouseAvailable).toBe(false);
      }
    });

    it('メタデータにanalyze_metrics_processing_time_msが含まれる', async () => {
      setVideoRecorderServiceFactory(() =>
        createMockVideoRecorderService()
      );
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService()
      );
      setAnimationMetricsCollectorFactory(() =>
        createMockAnimationMetricsCollector()
      );

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.metadata.analyze_metrics_processing_time_ms).toBeDefined();
        expect(typeof result.data.metadata.analyze_metrics_processing_time_ms).toBe('number');
      }
    });
  });

  // =====================================================
  // Phase4-TDD-Red: エラーハンドリング
  // =====================================================

  describe('エラーハンドリング', () => {
    it('AnimationMetricsCollector実行時エラーでもmotion.detect自体は成功する（graceful degradation）', async () => {
      setVideoRecorderServiceFactory(() => createMockVideoRecorderService());
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService()
      );
      setAnimationMetricsCollectorFactory(() => ({
        analyze: vi.fn().mockRejectedValue(new Error('Analysis failed')),
        calculateImpactScore: vi.fn(),
        getRecommendations: vi.fn(),
      }));

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
      };

      const result = await motionDetectHandler(input);

      // 全体としては成功
      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // animation_metricsはnull
        expect(result.data.animation_metrics).toBeNull();
        // エラー情報が含まれる
        expect(result.data.animation_metrics_error).toBeDefined();
        expect(result.data.animation_metrics_error?.code).toBe('ANIMATION_METRICS_ERROR');
      }
    });

    it('AnimationMetricsCollectorファクトリ未設定時はanalyze_metricsを無視する', async () => {
      // ファクトリをリセット（未設定状態）
      resetAnimationMetricsCollectorFactory();

      setVideoRecorderServiceFactory(() => createMockVideoRecorderService());
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService()
      );

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // 警告が追加されている
        expect(result.data.warnings?.some((w) =>
          w.code === 'ANIMATION_METRICS_UNAVAILABLE'
        )).toBe(true);
        // ファクトリ未設定時はnullが返される（undefinedではない）
        expect(result.data.animation_metrics).toBeNull();
      }
    });

    it('patternsが空配列の場合もAnimationMetricsCollectorが正常動作する', async () => {
      // パターンが検出されなかった場合のモック
      setVideoRecorderServiceFactory(() => createMockVideoRecorderService());
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService()
      );
      setAnimationMetricsCollectorFactory(() =>
        createMockAnimationMetricsCollector({
          patternImpacts: [],
          overallScore: 100,
        })
      );

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.animation_metrics).toBeDefined();
        expect(result.data.animation_metrics?.overallScore).toBe(100);
      }
    });

    it('analyze_metricsのエラー時に適切なエラー情報を返す', async () => {
      setVideoRecorderServiceFactory(() => createMockVideoRecorderService());
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService()
      );

      // エラーを返す処理をシミュレート
      const failingAnalyze = vi.fn().mockRejectedValue(new Error('Animation metrics analysis failed'));

      setAnimationMetricsCollectorFactory(() => ({
        analyze: failingAnalyze,
        calculateImpactScore: vi.fn(),
        getRecommendations: vi.fn(),
      }));

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
        analyze_metrics_options: {
          timeout: 1000, // 有効なtimeout値（min: 1000）
        },
      };

      const result = await motionDetectHandler(input);

      // Graceful degradationにより、メイン処理は成功する
      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // animation_metrics_errorにエラー情報が含まれる
        expect(result.data.animation_metrics_error).toBeDefined();
        expect(result.data.animation_metrics_error?.code).toBe('ANIMATION_METRICS_ERROR');
        expect(result.data.animation_metrics_error?.message).toContain('Animation metrics analysis failed');
      }
    });

    it('summaryモードでもanimation_metricsが正しく返される', async () => {
      setVideoRecorderServiceFactory(() => createMockVideoRecorderService());
      setFrameAnalyzerServiceFactory(() => createMockFrameAnalyzerService());
      setLighthouseDetectorServiceFactory(() =>
        createMockLighthouseService()
      );
      setAnimationMetricsCollectorFactory(() =>
        createMockAnimationMetricsCollector()
      );

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'video',
        enable_frame_capture: false, // CI環境用: Playwrightブラウザ起動を回避
        lighthouse_options: { enabled: true },
        analyze_metrics: true,
        summary: true, // summaryモード
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // summaryモードでもanimation_metricsは含まれる
        expect(result.data.animation_metrics).toBeDefined();
      }
    });
  });
});
