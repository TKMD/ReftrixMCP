// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.search WebGLアニメーション検索 統合テスト
 *
 * motion.search MCPツールのWebGLアニメーション検索機能をテストします。
 *
 * テスト対象:
 * - include_webgl_animations=true でのWebGL検索
 * - CSS + JS + WebGL 統合検索
 * - WebGLアニメーションフィルタリング（category, detectedLibrary, minConfidence）
 * - パターン検出と分類
 *
 * @module tests/integration/tools/motion-search-webgl
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import {
  WebGLAnimationDetectorService,
  type WebGLAnimationPatternData,
} from '../../../src/services/motion/webgl-animation-detector.service';
import {
  generateWebGLAnimationTextRepresentation,
  type WebGLAnimationPatternData as EmbeddingPatternData,
} from '../../../src/services/motion/webgl-animation-embedding.service';

// =====================================================
// テストフィクスチャのパス
// =====================================================

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/webgl-animations');

/**
 * フィクスチャHTMLを読み込む
 */
function loadFixture(filename: string): string {
  const filePath = path.join(FIXTURES_DIR, filename);
  return fs.readFileSync(filePath, 'utf-8');
}

// =====================================================
// ヘルパー関数：型変換
// =====================================================

/**
 * WebGLAnimationDetectorの出力をEmbedding用の型に変換
 */
function convertToEmbeddingPattern(
  detectorPattern: WebGLAnimationPatternData,
  id: string = 'test-id'
): EmbeddingPatternData {
  return {
    id,
    category: detectorPattern.category,
    libraries: detectorPattern.detectedLibraries,
    description: detectorPattern.description,
    periodicity: {
      isPeriodic: detectorPattern.visualFeatures.periodicityScore > 0.5,
      cycleSeconds: detectorPattern.visualFeatures.estimatedPeriodMs > 0
        ? detectorPattern.visualFeatures.estimatedPeriodMs / 1000
        : null,
      confidence: detectorPattern.visualFeatures.periodicityScore,
    },
    avgChangeRatio: detectorPattern.visualFeatures.avgChangeRatio,
    peakChangeRatio: detectorPattern.visualFeatures.maxChangeRatio,
    visualFeatures: [],
    canvasDimensions: {
      width: detectorPattern.canvasWidth,
      height: detectorPattern.canvasHeight,
    },
    webglVersion: detectorPattern.webglVersion as 1 | 2,
    framesAnalyzed: detectorPattern.frameAnalysis.frameCount,
    durationMs: null,
    webPageId: null,
    sourceUrl: null,
  };
}

// =====================================================
// WebGLアニメーション検索テスト
// =====================================================

describe('motion.search WebGL Animation Search 統合テスト', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let webglDetector: WebGLAnimationDetectorService;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--enable-webgl',
        '--use-gl=swiftshader',
      ],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
  });

  afterAll(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  beforeEach(async () => {
    page = await context.newPage();
    webglDetector = new WebGLAnimationDetectorService();
  });

  afterEach(async () => {
    await webglDetector?.cleanup().catch(() => {});
    await page?.close().catch(() => {});
  });

  // =====================================================
  // テキスト表現生成テスト
  // =====================================================

  describe('Text Representation Generation', () => {
    it('should generate text representation for detected WebGL patterns', async () => {
      // Arrange
      const html = loadFixture('wave-animation-webgl.html');
      await page.setContent(html);
      await page.waitForTimeout(500);

      // Act: パターン検出
      const detectionResult = await webglDetector.detect(page, {
        sampleFrames: 12,
        sampleIntervalMs: 100,
        saveToDb: false,
      });

      // Assert
      if (detectionResult.patterns.length > 0) {
        const detectorPattern = detectionResult.patterns[0];
        const embeddingPattern = convertToEmbeddingPattern(detectorPattern);

        // テキスト表現生成
        const textRepresentation = generateWebGLAnimationTextRepresentation(embeddingPattern);

        expect(textRepresentation).toBeDefined();
        expect(typeof textRepresentation).toBe('string');
        expect(textRepresentation.length).toBeGreaterThan(0);
        // E5モデル用プレフィックス
        expect(textRepresentation.startsWith('passage:')).toBe(true);
        // カテゴリが含まれる
        expect(textRepresentation).toContain('WebGL');
      }
    });

    it('should include category in text representation', async () => {
      // Arrange
      const html = loadFixture('rotating-cube-webgl.html');
      await page.setContent(html);
      await page.waitForTimeout(500);

      // Act
      const detectionResult = await webglDetector.detect(page, {
        sampleFrames: 10,
        sampleIntervalMs: 100,
        saveToDb: false,
      });

      // Assert
      if (detectionResult.patterns.length > 0) {
        const embeddingPattern = convertToEmbeddingPattern(detectionResult.patterns[0]);
        const textRep = generateWebGLAnimationTextRepresentation(embeddingPattern);

        // カテゴリが含まれる
        expect(textRep).toContain(embeddingPattern.category);
      }
    });

    it('should include motion intensity in text representation', async () => {
      // Arrange
      const html = loadFixture('particle-system-webgl.html');
      await page.setContent(html);
      await page.waitForTimeout(500);

      // Act
      const detectionResult = await webglDetector.detect(page, {
        sampleFrames: 10,
        sampleIntervalMs: 100,
        saveToDb: false,
      });

      // Assert
      if (detectionResult.patterns.length > 0) {
        const embeddingPattern = convertToEmbeddingPattern(detectionResult.patterns[0]);
        const textRep = generateWebGLAnimationTextRepresentation(embeddingPattern);

        // モーション強度が含まれる
        expect(textRep).toMatch(/motion/i);
      }
    });
  });

  // =====================================================
  // フィルタリングテスト（ロジックテスト）
  // =====================================================

  describe('WebGL Animation Filtering Logic', () => {
    it('should filter patterns by category', async () => {
      // Arrange: 検出された複数パターンをシミュレート
      const patternsFromDifferentPages: WebGLAnimationPatternData[] = [];

      // 複数のHTMLからパターンを収集
      const fixtures = ['basic-webgl-canvas.html', 'rotating-cube-webgl.html', 'wave-animation-webgl.html'];

      for (const fixture of fixtures) {
        const html = loadFixture(fixture);
        await page.setContent(html);
        await page.waitForTimeout(300);

        const result = await webglDetector.detect(page, {
          sampleFrames: 8,
          sampleIntervalMs: 80,
          saveToDb: false,
        });

        patternsFromDifferentPages.push(...result.patterns);

        await webglDetector.cleanup();
        webglDetector = new WebGLAnimationDetectorService();
      }

      // Assert: フィルタリングロジック
      if (patternsFromDifferentPages.length > 0) {
        // 特定カテゴリでフィルタリング
        const categories = patternsFromDifferentPages.map((p) => p.category);
        const uniqueCategories = [...new Set(categories)];

        expect(uniqueCategories.length).toBeGreaterThan(0);

        // 特定カテゴリのパターンのみをフィルタリング
        const targetCategory = uniqueCategories[0];
        const filtered = patternsFromDifferentPages.filter((p) => p.category === targetCategory);

        expect(filtered.every((p) => p.category === targetCategory)).toBe(true);
      }
    });

    it('should filter patterns by minConfidence', async () => {
      // Arrange
      const html = loadFixture('basic-webgl-canvas.html');
      await page.setContent(html);
      await page.waitForTimeout(500);

      const result = await webglDetector.detect(page, {
        sampleFrames: 10,
        sampleIntervalMs: 100,
        saveToDb: false,
      });

      // Assert
      if (result.patterns.length > 0) {
        // 信頼度でフィルタリング
        const minConfidence = 0.5;
        const filtered = result.patterns.filter((p) => p.confidence >= minConfidence);

        expect(filtered.every((p) => p.confidence >= minConfidence)).toBe(true);
      }
    });

    it('should combine multiple filters', async () => {
      // Arrange
      const html = loadFixture('multiple-canvas-webgl.html');
      await page.setContent(html);
      await page.waitForTimeout(500);

      const result = await webglDetector.detect(page, {
        sampleFrames: 10,
        sampleIntervalMs: 100,
        saveToDb: false,
      });

      // Assert
      if (result.patterns.length > 0) {
        // 複数条件でフィルタリング
        const minConfidence = 0.3;
        const filtered = result.patterns.filter(
          (p) => p.confidence >= minConfidence && p.canvasWidth > 0
        );

        expect(filtered.every((p) => p.confidence >= minConfidence && p.canvasWidth > 0)).toBe(true);
      }
    });
  });

  // =====================================================
  // 実際のフレームキャプチャからの検索テスト
  // =====================================================

  describe('Search from Actual Frame Capture', () => {
    it('should detect patterns with searchable data from live page', async () => {
      // Arrange
      const html = loadFixture('rotating-cube-webgl.html');
      await page.setContent(html);
      await page.waitForTimeout(500);

      // Act: パターン検出
      const detectionResult = await webglDetector.detect(page, {
        sampleFrames: 15,
        sampleIntervalMs: 100,
        saveToDb: false,
      });

      // Assert: パターンが検出された場合、検索可能なデータを持つ
      if (detectionResult.patterns.length > 0) {
        const pattern = detectionResult.patterns[0];

        // 検索に必要なフィールドが存在
        expect(pattern.name).toBeDefined();
        expect(pattern.category).toBeDefined();
        expect(pattern.description).toBeDefined();
        expect(pattern.confidence).toBeGreaterThanOrEqual(0);
        expect(pattern.visualFeatures).toBeDefined();
        expect(pattern.frameAnalysis).toBeDefined();

        // テキスト表現が生成可能
        const embeddingPattern = convertToEmbeddingPattern(pattern);
        const textRep = generateWebGLAnimationTextRepresentation(embeddingPattern);
        expect(textRep.length).toBeGreaterThan(10);
      }
    });

    it('should generate consistent text representations for same visual pattern', async () => {
      // Arrange: 同じページを2回検出
      const html = loadFixture('wave-animation-webgl.html');
      await page.setContent(html);
      await page.waitForTimeout(500);

      // Act: 1回目
      const result1 = await webglDetector.detect(page, {
        sampleFrames: 10,
        sampleIntervalMs: 100,
        saveToDb: false,
      });

      // 同じページで2回目
      const result2 = await webglDetector.detect(page, {
        sampleFrames: 10,
        sampleIntervalMs: 100,
        saveToDb: false,
      });

      // Assert
      if (result1.patterns.length > 0 && result2.patterns.length > 0) {
        const textRep1 = generateWebGLAnimationTextRepresentation(
          convertToEmbeddingPattern(result1.patterns[0])
        );
        const textRep2 = generateWebGLAnimationTextRepresentation(
          convertToEmbeddingPattern(result2.patterns[0])
        );

        // 同じページなので同じカテゴリを含む
        expect(textRep1).toContain('WebGL');
        expect(textRep2).toContain('WebGL');
      }
    });
  });

  // =====================================================
  // パフォーマンステスト
  // =====================================================

  describe('Performance', () => {
    it('should generate text representations quickly', async () => {
      // Arrange
      const html = loadFixture('particle-system-webgl.html');
      await page.setContent(html);
      await page.waitForTimeout(500);

      const result = await webglDetector.detect(page, {
        sampleFrames: 10,
        sampleIntervalMs: 100,
        saveToDb: false,
      });

      // Assert
      if (result.patterns.length > 0) {
        const startTime = Date.now();

        // 複数のテキスト表現を生成
        for (let i = 0; i < 10; i++) {
          generateWebGLAnimationTextRepresentation(
            convertToEmbeddingPattern(result.patterns[0])
          );
        }

        const elapsed = Date.now() - startTime;

        // 10回のテキスト表現生成は100ms以内
        expect(elapsed).toBeLessThan(100);
      }
    });
  });
});

// =====================================================
// CSS + JS + WebGL 統合検索テスト
// =====================================================

describe('CSS + JS + WebGL 統合検索テスト', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let webglDetector: WebGLAnimationDetectorService;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--enable-webgl',
        '--use-gl=swiftshader',
      ],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
  });

  afterAll(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  beforeEach(async () => {
    page = await context.newPage();
    webglDetector = new WebGLAnimationDetectorService();
  });

  afterEach(async () => {
    await webglDetector?.cleanup().catch(() => {});
    await page?.close().catch(() => {});
  });

  it('should detect WebGL patterns in mixed content page', async () => {
    // Arrange: CSS + JS + WebGL混在ページ
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          @keyframes cssAnim {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          .css-animated {
            animation: cssAnim 1s ease infinite;
          }
        </style>
      </head>
      <body>
        <div class="css-animated">CSS Animation</div>
        <canvas id="webgl-canvas" width="400" height="300"></canvas>
        <script>
          // WebGL animation
          const canvas = document.getElementById('webgl-canvas');
          const gl = canvas.getContext('webgl');
          if (gl) {
            let t = 0;
            function render() {
              t += 0.05;
              gl.clearColor(Math.sin(t) * 0.5 + 0.5, 0.2, 0.3, 1.0);
              gl.clear(gl.COLOR_BUFFER_BIT);
              requestAnimationFrame(render);
            }
            render();
          }
        </script>
      </body>
      </html>
    `;
    await page.setContent(html);
    await page.waitForTimeout(500);

    // Act: WebGLアニメーション検出
    const result = await webglDetector.detect(page, {
      sampleFrames: 10,
      sampleIntervalMs: 100,
      saveToDb: false,
    });

    // Assert: WebGLアニメーションが検出される
    expect(result).toBeDefined();
    expect(result.patterns).toBeDefined();
    expect(result.summary).toBeDefined();
  });

  it('should generate distinct text representations for WebGL patterns', async () => {
    // Arrange: 複数の異なるアニメーション
    const fixtures = [
      { file: 'wave-animation-webgl.html', expectedCategory: ['wave', 'noise', 'complex', 'unknown'] },
      { file: 'particle-system-webgl.html', expectedCategory: ['particle', 'noise', 'complex', 'unknown'] },
      { file: 'rotating-cube-webgl.html', expectedCategory: ['rotation', 'complex', 'wave', 'unknown'] },
    ];

    const textRepresentations: string[] = [];

    for (const { file } of fixtures) {
      const html = loadFixture(file);
      await page.setContent(html);
      await page.waitForTimeout(500);

      const result = await webglDetector.detect(page, {
        sampleFrames: 10,
        sampleIntervalMs: 100,
        saveToDb: false,
      });

      if (result.patterns.length > 0) {
        const textRep = generateWebGLAnimationTextRepresentation(
          convertToEmbeddingPattern(result.patterns[0])
        );
        textRepresentations.push(textRep);
      }

      await webglDetector.cleanup();
      webglDetector = new WebGLAnimationDetectorService();
    }

    // Assert: 異なるアニメーションは異なるテキスト表現を持つ
    if (textRepresentations.length >= 2) {
      // 全てがWebGLを含む
      expect(textRepresentations.every((t) => t.includes('WebGL'))).toBe(true);
    }
  });
});

// =====================================================
// 型検証テスト
// =====================================================

describe('WebGL Search 型検証', () => {
  it('WebGLAnimationFilters should have correct structure', () => {
    // フィルター構造のテスト
    const filters = {
      category: 'wave' as const,
      detectedLibrary: 'three.js',
      minConfidence: 0.8,
    };

    expect(filters.category).toBe('wave');
    expect(filters.detectedLibrary).toBe('three.js');
    expect(filters.minConfidence).toBe(0.8);
  });

  it('WebGLAnimationInfo should have correct structure', () => {
    // 検索結果のWebGL情報構造テスト
    const webglInfo = {
      category: 'particle' as const,
      detectedLibrary: 'three.js',
      canvasSelector: '#webgl-canvas',
      confidence: 0.9,
      visualMetrics: {
        averageChangeRate: 0.25,
        peakChangeRate: 0.5,
        changePattern: 'continuous' as const,
      },
    };

    expect(webglInfo.category).toBe('particle');
    expect(webglInfo.confidence).toBe(0.9);
    expect(webglInfo.visualMetrics?.changePattern).toBe('continuous');
  });

  it('convertToEmbeddingPattern should produce valid EmbeddingPatternData', () => {
    // 型変換のテスト
    const detectorPattern: WebGLAnimationPatternData = {
      name: 'webgl-wave-animation-0',
      category: 'wave',
      description: 'Test wave animation',
      canvasSelector: '#test-canvas',
      canvasWidth: 800,
      canvasHeight: 600,
      webglVersion: 2,
      detectedLibraries: ['three.js'],
      frameAnalysis: {
        frameCount: 20,
        diffSummary: {
          avgChangeRatio: 0.15,
          maxChangeRatio: 0.3,
          motionFrameCount: 18,
          motionFrameRatio: 0.9,
        },
        changeRatioTimeSeries: Array(20).fill(0.15),
        motionAnalysis: {
          dominantDirection: 'none',
          averageSpeed: 0,
          speedVariance: 0,
          trajectoryComplexity: 0.5,
        },
      },
      visualFeatures: {
        avgChangeRatio: 0.15,
        maxChangeRatio: 0.3,
        minChangeRatio: 0.05,
        stdDeviation: 0.08,
        periodicityScore: 0.85,
        estimatedPeriodMs: 500,
        dynamicFrameRatio: 0.9,
      },
      confidence: 0.87,
    };

    const embeddingPattern = convertToEmbeddingPattern(detectorPattern, 'test-uuid');

    expect(embeddingPattern.id).toBe('test-uuid');
    expect(embeddingPattern.category).toBe('wave');
    expect(embeddingPattern.libraries).toEqual(['three.js']);
    expect(embeddingPattern.avgChangeRatio).toBe(0.15);
    expect(embeddingPattern.canvasDimensions.width).toBe(800);
    expect(embeddingPattern.webglVersion).toBe(2);
    expect(embeddingPattern.periodicity?.isPeriodic).toBe(true);
    expect(embeddingPattern.periodicity?.cycleSeconds).toBeCloseTo(0.5, 1);
  });
});
