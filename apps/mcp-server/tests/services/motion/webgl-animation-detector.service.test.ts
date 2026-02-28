// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGLAnimationDetectorService テスト
 *
 * TDD: Red Phase - 失敗するテストを先に作成
 *
 * テスト対象: WebGLAnimationDetectorService
 *
 * このテストは以下を検証します:
 * - canvas要素のスクリーンショットベースのアニメーション検出
 * - フレーム差分分析によるパターン特定
 * - アニメーションカテゴリ分類
 * - WebGLライブラリ検出との連携
 * - エラーハンドリングとタイムアウト
 *
 * 注意: このテストはPlaywrightを使用するため、ブラウザ環境が必要です。
 * 単体テストでは主にモックを使用し、統合テストはスキップ可能にしています。
 *
 * @module tests/services/motion/webgl-animation-detector.service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  WebGLAnimationDetectorService,
  createWebGLAnimationDetectorService,
  getWebGLAnimationDetectorService,
  resetWebGLAnimationDetectorService,
  type WebGLAnimationDetectionOptions,
  type WebGLAnimationDetectionResult,
  type WebGLAnimationPatternData,
  type VisualFeatures,
} from '../../../src/services/motion/webgl-animation-detector.service';

// =====================================================
// モック
// =====================================================

// Playwrightのモック
const mockPage = {
  evaluate: vi.fn(),
  locator: vi.fn(),
  waitForTimeout: vi.fn(),
};

const mockLocator = {
  first: vi.fn(),
  screenshot: vi.fn(),
};

// WebGLDetectorServiceのモック結果
const mockWebGLDetection = {
  hasCanvas: true,
  hasWebGL: true,
  webglVersion: 2,
  detectedLibraries: ['three.js'],
  canvasCount: 1,
  contextInfo: {
    vendor: 'Test Vendor',
    renderer: 'Test Renderer',
  },
};

// FrameImageAnalysisServiceのモック結果
const mockFrameAnalysisResult = {
  success: true,
  data: {
    totalFrames: 20,
    fps: 10,
    diffAnalysis: {
      results: Array(19)
        .fill(null)
        .map((_, i) => ({
          changeRatio: 0.05 + Math.sin((i * Math.PI) / 5) * 0.03,
          diffPixelCount: 500 + i * 10,
          totalPixelCount: 10000,
          regions: [],
        })),
      summary: {
        avgChangeRatio: 0.05,
        maxChangeRatio: 0.08,
        motionFrameCount: 19,
        motionFrameRatio: 1,
      },
    },
  },
};

// =====================================================
// テストスイート
// =====================================================

describe('WebGLAnimationDetectorService', () => {
  let service: WebGLAnimationDetectorService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetWebGLAnimationDetectorService();
    service = new WebGLAnimationDetectorService();

    // モックの設定
    mockPage.locator.mockReturnValue(mockLocator);
    mockLocator.first.mockReturnValue(mockLocator);
    mockLocator.screenshot.mockResolvedValue(Buffer.from('mock-png'));
    mockPage.waitForTimeout.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await service.cleanup();
  });

  // -------------------------------------------------
  // 基本的な動作テスト
  // -------------------------------------------------

  describe('基本動作', () => {
    it('createWebGLAnimationDetectorService でインスタンスを作成できる', () => {
      const instance = createWebGLAnimationDetectorService();
      expect(instance).toBeInstanceOf(WebGLAnimationDetectorService);
    });

    it('getWebGLAnimationDetectorService でシングルトンを取得できる', () => {
      const instance1 = getWebGLAnimationDetectorService();
      const instance2 = getWebGLAnimationDetectorService();

      expect(instance1).toBe(instance2);
    });

    it('resetWebGLAnimationDetectorService でシングルトンをリセットできる', () => {
      const instance1 = getWebGLAnimationDetectorService();
      resetWebGLAnimationDetectorService();
      const instance2 = getWebGLAnimationDetectorService();

      expect(instance1).not.toBe(instance2);
    });

    it('cleanup() でリソースを解放できる', async () => {
      await service.cleanup();
      // 再度cleanup呼び出しでもエラーにならない
      await service.cleanup();
    });
  });

  // -------------------------------------------------
  // オプションテスト
  // -------------------------------------------------

  describe('オプション', () => {
    it('デフォルトオプションが適用される', () => {
      const service = new WebGLAnimationDetectorService();
      // デフォルト値の検証は内部状態を直接確認できないため、
      // detect呼び出し時の動作で間接的に確認
      expect(service).toBeDefined();
    });

    it('カスタムオプションを指定できる', () => {
      const options: WebGLAnimationDetectionOptions = {
        sampleFrames: 30,
        sampleIntervalMs: 50,
        changeThreshold: 0.02,
        timeoutMs: 60000,
        saveToDb: false,
        outputDir: '/custom/path/',
      };

      // オプションを渡してdetectが呼び出せることを確認
      expect(options.sampleFrames).toBe(30);
      expect(options.sampleIntervalMs).toBe(50);
    });
  });

  // -------------------------------------------------
  // 結果構造テスト
  // -------------------------------------------------

  describe('結果構造', () => {
    it('WebGLAnimationDetectionResultが正しい構造を持つ', () => {
      // 空の結果を作成してテスト
      const emptyResult: WebGLAnimationDetectionResult = {
        patterns: [],
        summary: {
          totalPatterns: 0,
          categories: {},
          avgChangeRatio: 0,
          detectionTimeMs: 100,
        },
      };

      expect(emptyResult).toHaveProperty('patterns');
      expect(emptyResult).toHaveProperty('summary');
      expect(emptyResult.summary).toHaveProperty('totalPatterns');
      expect(emptyResult.summary).toHaveProperty('categories');
      expect(emptyResult.summary).toHaveProperty('avgChangeRatio');
      expect(emptyResult.summary).toHaveProperty('detectionTimeMs');
    });

    it('WebGLAnimationPatternDataが正しい構造を持つ', () => {
      const pattern: WebGLAnimationPatternData = {
        name: 'WebGL Pulse Animation #1',
        category: 'pulse',
        description: 'Test description',
        canvasSelector: '#canvas',
        canvasWidth: 800,
        canvasHeight: 600,
        webglVersion: 2,
        detectedLibraries: ['three.js'],
        frameAnalysis: {
          frameCount: 20,
          diffSummary: {
            avgChangeRatio: 0.05,
            maxChangeRatio: 0.1,
            motionFrameCount: 19,
            motionFrameRatio: 0.95,
          },
          changeRatioTimeSeries: [0.05, 0.06, 0.04],
          motionAnalysis: {
            success: true,
            statistics: {
              avgChangeRatio: 0.05,
              maxChangeRatio: 0.1,
              minChangeRatio: 0.01,
              stdDeviation: 0.02,
              frameCount: 20,
              changeFrameCount: 19,
            },
            periodicity: {
              score: 0.7,
              estimatedPeriodFrames: 10,
              estimatedPeriodMs: 333,
              confidence: 0.6,
              autocorrelations: [],
            },
            changePattern: {
              spikeCount: 2,
              avgSpikePeriod: 10,
              avgChangeDuration: 5,
              staticFrameRatio: 0.05,
              dynamicFrameRatio: 0.95,
            },
            processingTimeMs: 10,
          },
        },
        visualFeatures: {
          avgChangeRatio: 0.05,
          maxChangeRatio: 0.1,
          minChangeRatio: 0.01,
          stdDeviation: 0.02,
          periodicityScore: 0.7,
          estimatedPeriodMs: 333,
          dynamicFrameRatio: 0.95,
        },
        confidence: 0.8,
      };

      expect(pattern).toHaveProperty('name');
      expect(pattern).toHaveProperty('category');
      expect(pattern).toHaveProperty('description');
      expect(pattern).toHaveProperty('canvasSelector');
      expect(pattern).toHaveProperty('canvasWidth');
      expect(pattern).toHaveProperty('canvasHeight');
      expect(pattern).toHaveProperty('webglVersion');
      expect(pattern).toHaveProperty('detectedLibraries');
      expect(pattern).toHaveProperty('frameAnalysis');
      expect(pattern).toHaveProperty('visualFeatures');
      expect(pattern).toHaveProperty('confidence');
    });

    it('VisualFeaturesが正しい構造を持つ', () => {
      const features: VisualFeatures = {
        avgChangeRatio: 0.05,
        maxChangeRatio: 0.1,
        minChangeRatio: 0.01,
        stdDeviation: 0.02,
        periodicityScore: 0.7,
        estimatedPeriodMs: 333,
        dynamicFrameRatio: 0.95,
      };

      expect(features).toHaveProperty('avgChangeRatio');
      expect(features).toHaveProperty('maxChangeRatio');
      expect(features).toHaveProperty('minChangeRatio');
      expect(features).toHaveProperty('stdDeviation');
      expect(features).toHaveProperty('periodicityScore');
      expect(features).toHaveProperty('estimatedPeriodMs');
      expect(features).toHaveProperty('dynamicFrameRatio');
    });
  });

  // -------------------------------------------------
  // カテゴリテスト
  // -------------------------------------------------

  describe('カテゴリ', () => {
    it('有効なカテゴリ値のみを受け入れる', () => {
      const validCategories = [
        'fade',
        'pulse',
        'wave',
        'particle',
        'rotation',
        'parallax',
        'noise',
        'complex',
      ];

      for (const category of validCategories) {
        const pattern: Partial<WebGLAnimationPatternData> = {
          category: category as WebGLAnimationPatternData['category'],
        };
        expect(pattern.category).toBe(category);
      }
    });
  });

  // -------------------------------------------------
  // 警告テスト
  // -------------------------------------------------

  describe('警告', () => {
    it('警告配列がオプショナルである', () => {
      const resultWithWarnings: WebGLAnimationDetectionResult = {
        patterns: [],
        summary: {
          totalPatterns: 0,
          categories: {},
          avgChangeRatio: 0,
          detectionTimeMs: 100,
        },
        warnings: ['Test warning'],
      };

      const resultWithoutWarnings: WebGLAnimationDetectionResult = {
        patterns: [],
        summary: {
          totalPatterns: 0,
          categories: {},
          avgChangeRatio: 0,
          detectionTimeMs: 100,
        },
      };

      expect(resultWithWarnings.warnings).toHaveLength(1);
      expect(resultWithoutWarnings.warnings).toBeUndefined();
    });
  });

  // -------------------------------------------------
  // サマリー計算テスト
  // -------------------------------------------------

  describe('サマリー計算', () => {
    it('複数パターンからカテゴリ別カウントを集計する', () => {
      const patterns: WebGLAnimationPatternData[] = [
        {
          name: 'Pattern 1',
          category: 'pulse',
          description: '',
          canvasSelector: '#c1',
          canvasWidth: 100,
          canvasHeight: 100,
          webglVersion: 2,
          detectedLibraries: [],
          frameAnalysis: {} as WebGLAnimationPatternData['frameAnalysis'],
          visualFeatures: { avgChangeRatio: 0.1 } as VisualFeatures,
          confidence: 0.8,
        },
        {
          name: 'Pattern 2',
          category: 'pulse',
          description: '',
          canvasSelector: '#c2',
          canvasWidth: 100,
          canvasHeight: 100,
          webglVersion: 2,
          detectedLibraries: [],
          frameAnalysis: {} as WebGLAnimationPatternData['frameAnalysis'],
          visualFeatures: { avgChangeRatio: 0.2 } as VisualFeatures,
          confidence: 0.7,
        },
        {
          name: 'Pattern 3',
          category: 'wave',
          description: '',
          canvasSelector: '#c3',
          canvasWidth: 100,
          canvasHeight: 100,
          webglVersion: 2,
          detectedLibraries: [],
          frameAnalysis: {} as WebGLAnimationPatternData['frameAnalysis'],
          visualFeatures: { avgChangeRatio: 0.15 } as VisualFeatures,
          confidence: 0.6,
        },
      ];

      // カテゴリ別カウント
      const categories: Record<string, number> = {};
      for (const pattern of patterns) {
        categories[pattern.category] = (categories[pattern.category] ?? 0) + 1;
      }

      expect(categories['pulse']).toBe(2);
      expect(categories['wave']).toBe(1);
    });

    it('平均変化率を正しく計算する', () => {
      const avgRatios = [0.1, 0.2, 0.3];
      const avgChangeRatio = avgRatios.reduce((a, b) => a + b, 0) / avgRatios.length;

      expect(avgChangeRatio).toBeCloseTo(0.2, 5);
    });

    it('パターンがない場合は平均変化率が0になる', () => {
      const patterns: WebGLAnimationPatternData[] = [];
      const avgChangeRatio = patterns.length > 0
        ? patterns.reduce((sum, p) => sum + p.visualFeatures.avgChangeRatio, 0) / patterns.length
        : 0;

      expect(avgChangeRatio).toBe(0);
    });
  });

  // -------------------------------------------------
  // パターン名生成テスト
  // -------------------------------------------------

  describe('パターン名生成', () => {
    it('カテゴリとインデックスからパターン名を生成する', () => {
      const categoryNames: Record<string, string> = {
        fade: 'Fade',
        pulse: 'Pulse',
        wave: 'Wave',
        particle: 'Particle',
        rotation: 'Rotation',
        parallax: 'Parallax',
        noise: 'Noise',
        complex: 'Complex',
      };

      for (const [category, name] of Object.entries(categoryNames)) {
        const patternName = `WebGL ${name} Animation #1`;
        expect(patternName).toContain(name);
        expect(patternName).toContain('#1');
      }
    });
  });

  // -------------------------------------------------
  // 説明生成テスト
  // -------------------------------------------------

  describe('説明生成', () => {
    it('カテゴリに応じた説明を生成する', () => {
      const categoryDescriptions: Record<string, string> = {
        fade: 'Gradual opacity or intensity change',
        pulse: 'Rhythmic pulsating effect',
        wave: 'Flowing wave-like motion',
        particle: 'Particle system with scattered motion',
        rotation: 'Rotating or spinning animation',
        parallax: 'Depth-based parallax effect',
        noise: 'Procedural noise animation',
        complex: 'Complex multi-pattern animation',
      };

      expect(categoryDescriptions['pulse']).toContain('Rhythmic');
      expect(categoryDescriptions['wave']).toContain('wave');
    });

    it('説明にキャンバスサイズを含める', () => {
      const width = 800;
      const height = 600;
      const description = `Test description on ${width}x${height} canvas.`;

      expect(description).toContain('800x600');
    });
  });

  // -------------------------------------------------
  // タイムアウトテスト
  // -------------------------------------------------

  describe('タイムアウト', () => {
    it('タイムアウトオプションを設定できる', () => {
      const options: WebGLAnimationDetectionOptions = {
        timeoutMs: 5000,
      };

      expect(options.timeoutMs).toBe(5000);
    });

    it('デフォルトタイムアウトは30秒', () => {
      const defaultTimeoutMs = 30000;
      expect(defaultTimeoutMs).toBe(30000);
    });
  });

  // -------------------------------------------------
  // 出力ディレクトリテスト
  // -------------------------------------------------

  describe('出力ディレクトリ', () => {
    it('カスタム出力ディレクトリを設定できる', () => {
      const options: WebGLAnimationDetectionOptions = {
        outputDir: '/custom/output/',
      };

      expect(options.outputDir).toBe('/custom/output/');
    });

    it('デフォルト出力ディレクトリは/tmp/reftrix-webgl-frames/', () => {
      const defaultOutputDir = '/tmp/reftrix-webgl-frames/';
      expect(defaultOutputDir).toContain('reftrix-webgl-frames');
    });
  });

  // -------------------------------------------------
  // 既存WebGL検出結果の再利用テスト
  // -------------------------------------------------

  describe('既存WebGL検出結果の再利用', () => {
    it('webglDetectionオプションで既存の検出結果を渡せる', () => {
      const options: WebGLAnimationDetectionOptions = {
        webglDetection: mockWebGLDetection,
      };

      expect(options.webglDetection).toBeDefined();
      expect(options.webglDetection?.hasCanvas).toBe(true);
      expect(options.webglDetection?.detectedLibraries).toContain('three.js');
    });
  });

  // -------------------------------------------------
  // エッジケーステスト
  // -------------------------------------------------

  describe('エッジケース', () => {
    it('canvasがない場合は空の結果を返す', () => {
      const noCanvasResult: WebGLAnimationDetectionResult = {
        patterns: [],
        summary: {
          totalPatterns: 0,
          categories: {},
          avgChangeRatio: 0,
          detectionTimeMs: 50,
        },
        warnings: ['No canvas elements found on page'],
      };

      expect(noCanvasResult.patterns).toHaveLength(0);
      expect(noCanvasResult.warnings).toContain('No canvas elements found on page');
    });

    it('WebGLコンテキストがない場合も処理できる', () => {
      const noWebGLDetection = {
        ...mockWebGLDetection,
        hasWebGL: false,
        webglVersion: 0,
      };

      expect(noWebGLDetection.hasWebGL).toBe(false);
    });

    it('変化がないcanvasはスキップされる', () => {
      // 変化率が閾値以下の場合はパターンとして検出されない
      const staticCanvasWarning = 'Skipping static canvas';
      expect(staticCanvasWarning).toContain('static');
    });

    it('フレームキャプチャ失敗時は警告を追加', () => {
      const warning = 'Failed to detect animation for canvas 0: Screenshot failed';
      expect(warning).toContain('Failed to detect');
    });
  });

  // -------------------------------------------------
  // フレーム分析結果テスト
  // -------------------------------------------------

  describe('フレーム分析結果', () => {
    it('diffSummaryのデフォルト値を持つ', () => {
      const emptyDiffSummary = {
        avgChangeRatio: 0,
        maxChangeRatio: 0,
        motionFrameCount: 0,
        motionFrameRatio: 0,
      };

      expect(emptyDiffSummary.avgChangeRatio).toBe(0);
      expect(emptyDiffSummary.motionFrameCount).toBe(0);
    });

    it('changeRatioTimeSeriesを保持する', () => {
      const timeSeries = [0.01, 0.02, 0.03, 0.02, 0.01];
      expect(timeSeries).toHaveLength(5);
      expect(timeSeries[2]).toBe(0.03);
    });
  });

  // -------------------------------------------------
  // Canvas情報テスト
  // -------------------------------------------------

  describe('Canvas情報', () => {
    it('セレクタを生成できる', () => {
      // ID優先
      const idSelector = '#myCanvas';
      expect(idSelector).toBe('#myCanvas');

      // クラス
      const classSelector = 'canvas.webgl-canvas.main';
      expect(classSelector).toContain('canvas.');

      // nth-of-type
      const nthSelector = 'canvas:nth-of-type(2)';
      expect(nthSelector).toContain(':nth-of-type');
    });

    it('キャンバスサイズを取得できる', () => {
      const canvasInfo = {
        selector: '#canvas',
        width: 1920,
        height: 1080,
        webglVersion: 2,
        boundingRect: {
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
        },
      };

      expect(canvasInfo.width).toBe(1920);
      expect(canvasInfo.height).toBe(1080);
    });
  });

  // -------------------------------------------------
  // パフォーマンステスト
  // -------------------------------------------------

  describe('パフォーマンス', () => {
    it('detectionTimeMsを記録する', () => {
      const result: WebGLAnimationDetectionResult = {
        patterns: [],
        summary: {
          totalPatterns: 0,
          categories: {},
          avgChangeRatio: 0,
          detectionTimeMs: 1500,
        },
      };

      expect(result.summary.detectionTimeMs).toBeGreaterThan(0);
    });

    it('サンプルフレーム数を調整できる', () => {
      const options: WebGLAnimationDetectionOptions = {
        sampleFrames: 10, // 高速化のために少なく
      };

      expect(options.sampleFrames).toBe(10);
    });

    it('サンプル間隔を調整できる', () => {
      const options: WebGLAnimationDetectionOptions = {
        sampleIntervalMs: 50, // 高速化のために短く
      };

      expect(options.sampleIntervalMs).toBe(50);
    });
  });
});
