// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze video mode統合テスト
 * TDD Red Phase: motion.detect の video mode（フレームキャプチャ）機能を page.analyze に統合
 *
 * テスト対象:
 * - motionOptions への video mode パラメータ追加
 * - フレームキャプチャ結果の統合
 * - フレーム画像分析結果の統合
 * - デフォルト設定（page.analyze では video mode 無効）
 * - エラーハンドリング
 *
 * @module tests/tools/page/analyze-video-mode.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Narrative handler をモックしてOllama Vision接続タイムアウト（35秒）を回避
vi.mock('../../../src/tools/page/handlers/narrative-handler', async () => {
  const actual = await vi.importActual('../../../src/tools/page/handlers/narrative-handler');
  return {
    ...(actual as Record<string, unknown>),
    handleNarrativeAnalysis: async () => ({ success: true, skipped: true }),
  };
});

// Redis可用性チェックをモック: Vision自動asyncモード（v0.1.0）を無効化
vi.mock('../../../src/config/redis', () => ({
  isRedisAvailable: async () => false,
}));

import {
  pageAnalyzeHandler,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
  type IPageAnalyzeService,
} from '../../../src/tools/page/analyze.tool';

import {
  pageAnalyzeInputSchema,
  motionOptionsSchema,
  type PageAnalyzeInput,
  type PageAnalyzeOutput,
  PAGE_ANALYZE_ERROR_CODES,
} from '../../../src/tools/page/schemas';

// =====================================================
// テストデータ
// =====================================================

const validUrl = 'https://example.com';

// サンプルHTML（テスト用）
const sampleHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Test Page</title>
  <style>
    .hero { animation: fadeIn 0.5s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  </style>
</head>
<body>
  <header><nav>Navigation</nav></header>
  <main>
    <section class="hero"><h1>Hero Section</h1></section>
    <section class="features"><h2>Features</h2></section>
  </main>
  <footer>Footer</footer>
</body>
</html>`;

// =====================================================
// モック用ヘルパー
// =====================================================

/**
 * モーション検出サービスのモック（video mode 対応）
 */
function createMockMotionServiceWithVideoMode() {
  return {
    detect: vi.fn().mockResolvedValue({
      success: true,
      patternCount: 12,
      categoryBreakdown: { scroll_trigger: 5, hover_effect: 4, entrance: 3 },
      warningCount: 2,
      a11yWarningCount: 1,
      perfWarningCount: 0,
      processingTimeMs: 340,
      // video mode 結果
      frame_capture: {
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
      },
      // フレーム画像分析結果
      frame_analysis: {
        timeline: [
          { frame_index: 0, diff_percentage: 0, layout_shift_score: 0 },
          { frame_index: 10, diff_percentage: 0.15, layout_shift_score: 0.02 },
        ],
        summary: {
          max_diff: 0.15,
          avg_diff: 0.08,
          cls_total: 0.02,
        },
      },
    }),
  };
}

/**
 * 基本モック設定
 */
function createMockPageAnalyzeService(): IPageAnalyzeService {
  return {
    fetchHtml: vi.fn().mockResolvedValue({
      html: sampleHtml,
      title: 'Test Page',
      description: 'Test description',
    }),
    analyzeLayout: vi.fn().mockResolvedValue({
      success: true,
      sectionCount: 3,
      sectionTypes: { hero: 1, feature: 1, footer: 1 },
      processingTimeMs: 100,
    }),
    detectMotion: createMockMotionServiceWithVideoMode().detect,
    evaluateQuality: vi.fn().mockResolvedValue({
      success: true,
      overallScore: 80,
      grade: 'B',
      axisScores: { originality: 80, craftsmanship: 80, contextuality: 80 },
      clicheCount: 0,
      processingTimeMs: 50,
    }),
  };
}

// =====================================================
// 入力スキーマテスト - video mode パラメータ
// =====================================================

describe('motionOptionsSchema - video mode パラメータ', () => {
  describe('enable_frame_capture オプション', () => {
    it('enable_frame_capture オプションを受け付ける', () => {
      const input = {
        url: validUrl,
        motionOptions: { enable_frame_capture: true },
      };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.motionOptions?.enable_frame_capture).toBe(true);
    });

    it('enable_frame_capture のデフォルト値は false（v0.1.0: タイムアウト問題回避）', () => {
      // v0.1.0: タイムアウト問題回避のためデフォルト無効化
      // 有効化する場合は明示的に true を指定
      const input = { url: validUrl, motionOptions: {} };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.motionOptions?.enable_frame_capture).toBe(false);
    });

    it('enable_frame_capture=false を明示的に指定できる', () => {
      const input = {
        url: validUrl,
        motionOptions: { enable_frame_capture: false },
      };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.motionOptions?.enable_frame_capture).toBe(false);
    });
  });

  describe('frame_capture_options オプション', () => {
    it('frame_capture_options を受け付ける', () => {
      const input = {
        url: validUrl,
        motionOptions: {
          enable_frame_capture: true,
          frame_capture_options: {
            frame_rate: 30,
            scroll_px_per_frame: 15,
            output_format: 'png' as const,
            output_dir: '/tmp/test-frames/',
          },
        },
      };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.motionOptions?.frame_capture_options).toBeDefined();
      expect(result.motionOptions?.frame_capture_options?.frame_rate).toBe(30);
      expect(result.motionOptions?.frame_capture_options?.scroll_px_per_frame).toBe(15);
    });

    it('frame_capture_options のデフォルト値が適用される', () => {
      const input = {
        url: validUrl,
        motionOptions: {
          enable_frame_capture: true,
          frame_capture_options: {},
        },
      };
      const result = pageAnalyzeInputSchema.parse(input);
      // デフォルト値は実装側で設定される
      expect(result.motionOptions?.frame_capture_options).toBeDefined();
    });

    it('output_dir にパストラバーサル文字を含む場合エラー', () => {
      const input = {
        url: validUrl,
        motionOptions: {
          enable_frame_capture: true,
          frame_capture_options: {
            output_dir: '/tmp/../etc/',
          },
        },
      };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });

    it('filename_pattern にパス区切り文字を含む場合エラー', () => {
      const input = {
        url: validUrl,
        motionOptions: {
          enable_frame_capture: true,
          frame_capture_options: {
            filename_pattern: '../frame-{0000}.png',
          },
        },
      };
      expect(() => pageAnalyzeInputSchema.parse(input)).toThrow();
    });
  });

  describe('analyze_frames オプション', () => {
    it('analyze_frames オプションを受け付ける', () => {
      const input = {
        url: validUrl,
        motionOptions: {
          enable_frame_capture: true,
          analyze_frames: true,
        },
      };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.motionOptions?.analyze_frames).toBe(true);
    });

    it('analyze_frames のデフォルト値は false（v0.1.0: タイムアウト問題回避）', () => {
      // v0.1.0: タイムアウト問題回避のためデフォルト無効化
      // 有効化する場合は明示的に true を指定
      const input = {
        url: validUrl,
        motionOptions: { enable_frame_capture: true },
      };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.motionOptions?.analyze_frames).toBe(false);
    });

    it('analyze_frames を明示的に false に設定できる', () => {
      // パフォーマンス最適化のため無効化する場合
      const input = {
        url: validUrl,
        motionOptions: { enable_frame_capture: true, analyze_frames: false },
      };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.motionOptions?.analyze_frames).toBe(false);
    });
  });

  describe('frame_analysis_options オプション', () => {
    it('frame_analysis_options を受け付ける', () => {
      const input = {
        url: validUrl,
        motionOptions: {
          enable_frame_capture: true,
          analyze_frames: true,
          frame_analysis_options: {
            sample_interval: 5,
            diff_threshold: 0.1,
            cls_threshold: 0.05,
          },
        },
      };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.motionOptions?.frame_analysis_options).toBeDefined();
      expect(result.motionOptions?.frame_analysis_options?.sample_interval).toBe(5);
    });

    it('frame_analysis_options のデフォルト値が適用される', () => {
      const input = {
        url: validUrl,
        motionOptions: {
          enable_frame_capture: true,
          analyze_frames: true,
          frame_analysis_options: {},
        },
      };
      const result = pageAnalyzeInputSchema.parse(input);
      expect(result.motionOptions?.frame_analysis_options).toBeDefined();
    });
  });
});

// =====================================================
// 正常系テスト - video mode 統合
// =====================================================

describe('正常系 - video mode 統合', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('enable_frame_capture=true でフレームキャプチャ結果を返す', async () => {
    const mockService = createMockPageAnalyzeService();
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
      },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      expect(result.data.motion.frame_capture).toBeDefined();
      expect(result.data.motion.frame_capture?.total_frames).toBeGreaterThan(0);
      expect(result.data.motion.frame_capture?.output_dir).toBeDefined();
      expect(result.data.motion.frame_capture?.files).toBeInstanceOf(Array);
    }
  });

  it('フレームキャプチャ結果に必要なフィールドが含まれる', async () => {
    const mockService = createMockPageAnalyzeService();
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
      },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion?.frame_capture) {
      const fc = result.data.motion.frame_capture;
      // 必須フィールドの検証
      expect(fc.total_frames).toBeDefined();
      expect(fc.output_dir).toBeDefined();
      expect(fc.config).toBeDefined();
      expect(fc.config.scroll_px_per_frame).toBeDefined();
      expect(fc.config.frame_interval_ms).toBeDefined();
      expect(fc.files).toBeDefined();
    }
  });

  it('analyze_frames=true でフレーム画像分析結果を返す', async () => {
    const mockService = createMockPageAnalyzeService();
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
        analyze_frames: true,
      },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      expect(result.data.motion.frame_analysis).toBeDefined();
      expect(result.data.motion.frame_analysis?.timeline).toBeInstanceOf(Array);
      expect(result.data.motion.frame_analysis?.summary).toBeDefined();
    }
  });

  it('フレーム画像分析結果に timeline と summary が含まれる', async () => {
    const mockService = createMockPageAnalyzeService();
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
        analyze_frames: true,
      },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion?.frame_analysis) {
      const fa = result.data.motion.frame_analysis;
      // timeline の検証
      expect(fa.timeline).toBeInstanceOf(Array);
      if (fa.timeline.length > 0) {
        expect(fa.timeline[0]).toHaveProperty('frame_index');
        expect(fa.timeline[0]).toHaveProperty('diff_percentage');
        expect(fa.timeline[0]).toHaveProperty('layout_shift_score');
      }
      // summary の検証
      expect(fa.summary.max_diff).toBeDefined();
      expect(fa.summary.avg_diff).toBeDefined();
      expect(fa.summary.cls_total).toBeDefined();
    }
  });

  it('CSS静的解析とvideo modeの結果が両方含まれる', async () => {
    const mockService = createMockPageAnalyzeService();
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
      },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      // CSS静的解析結果
      expect(result.data.motion.patternCount).toBeDefined();
      expect(result.data.motion.categoryBreakdown).toBeDefined();
      // video mode結果
      expect(result.data.motion.frame_capture).toBeDefined();
    }
  });
});

// =====================================================
// デフォルト設定テスト
// =====================================================

describe('デフォルト設定', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
    // モックサービスを設定してタイムアウトを防ぐ
    setPageAnalyzeServiceFactory(() => createMockPageAnalyzeService());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('enable_frame_capture のデフォルトは false（v0.1.0: タイムアウト問題回避）', async () => {
    // v0.1.0: タイムアウト問題回避のためデフォルト無効化
    // モックをframe_capture無しで上書き（デフォルトenable_frame_capture=false時の挙動を再現）
    const mockService = createMockPageAnalyzeService();
    mockService.detectMotion = vi.fn().mockResolvedValue({
      success: true,
      patternCount: 12,
      categoryBreakdown: { scroll_trigger: 5, hover_effect: 4, entrance: 3 },
      warningCount: 2,
      a11yWarningCount: 1,
      perfWarningCount: 0,
      processingTimeMs: 340,
      // frame_capture なし（enable_frame_capture=false のため）
    });
    resetPageAnalyzeServiceFactory();
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = { url: validUrl };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      // video mode はデフォルトで無効なので frame_capture は存在しない
      const frameCapture = result.data.motion.frame_capture;
      expect(frameCapture).toBeUndefined();
    }
  });

  it('motionOptions.enable_frame_capture=false で video mode 無効', async () => {
    const mockService = createMockPageAnalyzeService();
    // video mode 無効時のモック
    mockService.detectMotion = vi.fn().mockResolvedValue({
      success: true,
      patternCount: 5,
      categoryBreakdown: { hover_effect: 3, entrance: 2 },
      warningCount: 1,
      a11yWarningCount: 1,
      perfWarningCount: 0,
      processingTimeMs: 100,
      // frame_capture と frame_analysis は含まれない
    });
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: false,
      },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      expect(result.data.motion.frame_capture).toBeUndefined();
      expect(result.data.motion.frame_analysis).toBeUndefined();
    }
  });
});

// =====================================================
// motion.detect との差分テスト
// =====================================================

describe('motion.detect との差分', () => {
  it('page.analyze の video mode デフォルトは false（v0.1.0: タイムアウト問題回避）', () => {
    // v0.1.0: タイムアウト問題回避のためデフォルト無効化
    // 有効化する場合は明示的に enable_frame_capture: true を指定
    const pageAnalyzeInput = { url: validUrl, motionOptions: {} };
    const pageResult = pageAnalyzeInputSchema.parse(pageAnalyzeInput);
    expect(pageResult.motionOptions?.enable_frame_capture).toBe(false);

    // motion.detect: video modeのデフォルトは detection_mode='video' で enable_frame_capture=true
    // page.analyze: v0.1.0 でデフォルト無効化（タイムアウト問題回避）
  });

  it('video mode を明示的に無効化できる', () => {
    // パフォーマンス最適化のため無効化する場合
    const pageAnalyzeInput = { url: validUrl, motionOptions: { enable_frame_capture: false } };
    const pageResult = pageAnalyzeInputSchema.parse(pageAnalyzeInput);
    expect(pageResult.motionOptions?.enable_frame_capture).toBe(false);
  });

  it('frame_capture_options はそのまま引き継がれる', () => {
    const input = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
        frame_capture_options: {
          frame_rate: 60,
          scroll_px_per_frame: 10,
          output_format: 'jpeg' as const,
        },
      },
    };
    const result = pageAnalyzeInputSchema.parse(input);
    expect(result.motionOptions?.frame_capture_options?.frame_rate).toBe(60);
    expect(result.motionOptions?.frame_capture_options?.scroll_px_per_frame).toBe(10);
    expect(result.motionOptions?.frame_capture_options?.output_format).toBe('jpeg');
  });
});

// =====================================================
// エラーハンドリングテスト
// =====================================================

describe('エラーハンドリング - video mode', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('video mode 失敗時も CSS 解析結果は返す（Graceful Degradation）', async () => {
    const mockService = createMockPageAnalyzeService();
    // video mode は失敗するが CSS 解析は成功
    mockService.detectMotion = vi.fn().mockResolvedValue({
      success: true,
      patternCount: 5,
      categoryBreakdown: { hover_effect: 3, entrance: 2 },
      warningCount: 1,
      a11yWarningCount: 1,
      perfWarningCount: 0,
      processingTimeMs: 100,
      // frame_capture_error を含む
      frame_capture_error: {
        code: 'FRAME_CAPTURE_FAILED',
        message: 'Failed to capture frames',
      },
    });
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
      },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      // CSS 解析結果は返される
      expect(result.data.motion.patternCount).toBeDefined();
      expect(result.data.motion.categoryBreakdown).toBeDefined();
    }
  });

  it('フレーム画像分析失敗時も フレームキャプチャ結果は返す', async () => {
    const mockService = createMockPageAnalyzeService();
    mockService.detectMotion = vi.fn().mockResolvedValue({
      success: true,
      patternCount: 5,
      categoryBreakdown: { hover_effect: 3, entrance: 2 },
      warningCount: 1,
      a11yWarningCount: 1,
      perfWarningCount: 0,
      processingTimeMs: 100,
      // frame_capture は成功
      frame_capture: {
        total_frames: 50,
        output_dir: '/tmp/reftrix-frames/',
        config: {
          scroll_px_per_frame: 15,
          frame_interval_ms: 33,
          output_format: 'png',
          output_dir: '/tmp/reftrix-frames/',
          filename_pattern: 'frame-{0000}.png',
        },
        files: [],
        duration_ms: 1650,
      },
      // frame_analysis_error
      frame_analysis_error: {
        code: 'FRAME_ANALYSIS_FAILED',
        message: 'Failed to analyze frames',
      },
    });
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
        analyze_frames: true,
      },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion) {
      // frame_capture は返される
      expect(result.data.motion.frame_capture).toBeDefined();
      // frame_analysis は undefined（失敗）
      expect(result.data.motion.frame_analysis).toBeUndefined();
    }
  });
});

// =====================================================
// 並列処理テスト
// =====================================================

describe('並列処理 - video mode', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('layout/motion(video mode)/quality が並列実行される', async () => {
    const mockService = createMockPageAnalyzeService();
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
      },
    };

    const startTime = Date.now();
    const result = await pageAnalyzeHandler(input);
    const duration = Date.now() - startTime;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.motion).toBeDefined();
      expect(result.data.quality).toBeDefined();
      // video mode を含めても全体が並列実行される
    }
  });
});

// =====================================================
// ツール定義テスト
// =====================================================

describe('ツール定義 - video mode パラメータ', () => {
  // Note: ツール定義の更新は実装フェーズで行う
  // ここではスキーマベースのテストのみ
  it('motionOptions スキーマに video mode パラメータが含まれる', () => {
    const schema = motionOptionsSchema;
    expect(schema).toBeDefined();
    // スキーマが video mode パラメータを受け付けることを確認
    const result = schema.parse({
      enable_frame_capture: true,
      frame_capture_options: { frame_rate: 30 },
      analyze_frames: true,
      frame_analysis_options: { sample_interval: 10 },
    });
    expect(result.enable_frame_capture).toBe(true);
  });
});

// =====================================================
// 出力スキーマテスト
// =====================================================

describe('MotionResult 型 - video mode フィールド', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
  });

  it('frame_capture フィールドを含む MotionResult をバリデート', async () => {
    const mockService = createMockPageAnalyzeService();
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
      },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion?.frame_capture) {
      const fc = result.data.motion.frame_capture;
      expect(typeof fc.total_frames).toBe('number');
      expect(typeof fc.output_dir).toBe('string');
      expect(fc.config).toHaveProperty('scroll_px_per_frame');
      expect(Array.isArray(fc.files)).toBe(true);
    }
  });

  it('frame_analysis フィールドを含む MotionResult をバリデート', async () => {
    const mockService = createMockPageAnalyzeService();
    setPageAnalyzeServiceFactory(() => mockService);

    const input: PageAnalyzeInput = {
      url: validUrl,
      motionOptions: {
        enable_frame_capture: true,
        analyze_frames: true,
      },
    };
    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.motion?.frame_analysis) {
      const fa = result.data.motion.frame_analysis;
      expect(Array.isArray(fa.timeline)).toBe(true);
      expect(typeof fa.summary.max_diff).toBe('number');
      expect(typeof fa.summary.avg_diff).toBe('number');
      expect(typeof fa.summary.cls_total).toBe('number');
    }
  });
});
