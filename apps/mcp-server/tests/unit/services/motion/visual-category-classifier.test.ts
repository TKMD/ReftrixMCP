// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Category Classifier Tests
 *
 * TDD: Red phase - Write failing tests first
 *
 * フレーム差分解析結果から視覚的な動きのカテゴリを分類するテスト
 *
 * カテゴリ:
 * - fade: フェードイン/アウト（opacity変化が主、位置変化なし）
 * - slide: スライド（一方向の移動が主、水平or垂直）
 * - scale: スケール（サイズ変化が主、中心からの拡大/縮小）
 * - rotate: 回転（回転変化が主）
 * - parallax: パララックス（複数レイヤーの異なる速度移動）
 * - reveal: 出現/消滅（要素の出現/消滅、クリッピング）
 * - morph: モーフィング（形状の変形）
 * - complex: 複合（複数カテゴリの組み合わせ）
 *
 * @module @reftrix/mcp-server/tests/unit/services/motion/visual-category-classifier.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  VisualCategoryClassifier,
  type VisualMotionCategory,
  type SlideDirection,
  type ScaleType,
  type FadeType,
  type BoundingBox,
  type MotionVector,
  type FrameDiffResult,
  type FrameAnalysisResult,
  type CategoryMetrics,
  type CategoryDetails,
  type CategoryClassificationResult,
  type VisualCategoryClassifierConfig,
} from '../../../../src/services/motion/visual-category-classifier.js';

// Re-export types for test fixtures
export type { VisualMotionCategory, SlideDirection, ScaleType, FadeType };

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * フェードイン用フレーム差分データを生成
 * 全体的なピクセル変化（透明度変化）、位置変化なし
 */
function createFadeInFrames(frameCount: number): FrameDiffResult[] {
  return Array.from({ length: frameCount }, (_, i) => ({
    frameIndex: i,
    // フェードインでは全体のピクセルが徐々に変化
    diffPercentage: (1 - i / (frameCount - 1)) * 0.8 + 0.05, // 85% -> 5%
    changedPixels: Math.round(((1 - i / (frameCount - 1)) * 0.8 + 0.05) * 100000),
    totalPixels: 100000,
    // フェードでは位置変化なし（全体的な変化）
    boundingBox: {
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
    },
    // モーションベクトルなし（位置移動なし）
    motionVectors: [],
  }));
}

/**
 * フェードアウト用フレーム差分データを生成
 */
function createFadeOutFrames(frameCount: number): FrameDiffResult[] {
  return Array.from({ length: frameCount }, (_, i) => ({
    frameIndex: i,
    // フェードアウトでは全体のピクセルが徐々に消失
    diffPercentage: (i / (frameCount - 1)) * 0.8 + 0.05, // 5% -> 85%
    changedPixels: Math.round(((i / (frameCount - 1)) * 0.8 + 0.05) * 100000),
    totalPixels: 100000,
    boundingBox: {
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
    },
    motionVectors: [],
  }));
}

/**
 * 水平スライド用フレーム差分データを生成
 */
function createHorizontalSlideFrames(frameCount: number): FrameDiffResult[] {
  const speed = 10; // px per frame
  return Array.from({ length: frameCount }, (_, i) => ({
    frameIndex: i,
    diffPercentage: 0.15, // 一定の変化率
    changedPixels: 15000,
    totalPixels: 100000,
    // 水平方向に移動するバウンディングボックス
    boundingBox: {
      x: i * speed,
      y: 100,
      width: 200,
      height: 200,
    },
    // 水平方向のモーションベクトル
    motionVectors: [
      { dx: speed, dy: 0, magnitude: speed },
    ],
  }));
}

/**
 * 垂直スライド用フレーム差分データを生成
 */
function createVerticalSlideFrames(frameCount: number): FrameDiffResult[] {
  const speed = 8;
  return Array.from({ length: frameCount }, (_, i) => ({
    frameIndex: i,
    diffPercentage: 0.12,
    changedPixels: 12000,
    totalPixels: 100000,
    boundingBox: {
      x: 100,
      y: i * speed,
      width: 200,
      height: 200,
    },
    motionVectors: [
      { dx: 0, dy: speed, magnitude: speed },
    ],
  }));
}

/**
 * 斜め方向スライド用フレーム差分データを生成
 */
function createDiagonalSlideFrames(frameCount: number): FrameDiffResult[] {
  const speedX = 5;
  const speedY = 5;
  const magnitude = Math.sqrt(speedX * speedX + speedY * speedY);
  return Array.from({ length: frameCount }, (_, i) => ({
    frameIndex: i,
    diffPercentage: 0.18,
    changedPixels: 18000,
    totalPixels: 100000,
    boundingBox: {
      x: 100 + i * speedX,
      y: 100 + i * speedY,
      width: 200,
      height: 200,
    },
    motionVectors: [
      { dx: speedX, dy: speedY, magnitude },
    ],
  }));
}

/**
 * スケール拡大用フレーム差分データを生成
 */
function createScaleExpandFrames(frameCount: number): FrameDiffResult[] {
  const centerX = 500;
  const centerY = 500;
  const startSize = 100;
  const endSize = 400;

  return Array.from({ length: frameCount }, (_, i) => {
    const ratio = i / (frameCount - 1);
    const currentSize = startSize + (endSize - startSize) * ratio;
    const halfSize = currentSize / 2;

    return {
      frameIndex: i,
      diffPercentage: 0.1 + ratio * 0.3, // サイズ変化による差分増加
      changedPixels: Math.round((0.1 + ratio * 0.3) * 100000),
      totalPixels: 100000,
      // 中心から拡大するバウンディングボックス
      boundingBox: {
        x: centerX - halfSize,
        y: centerY - halfSize,
        width: currentSize,
        height: currentSize,
      },
      // スケールではモーションベクトルは放射状
      motionVectors: [
        { dx: ratio * 2, dy: ratio * 2, magnitude: ratio * Math.sqrt(8) },
        { dx: -ratio * 2, dy: ratio * 2, magnitude: ratio * Math.sqrt(8) },
        { dx: ratio * 2, dy: -ratio * 2, magnitude: ratio * Math.sqrt(8) },
        { dx: -ratio * 2, dy: -ratio * 2, magnitude: ratio * Math.sqrt(8) },
      ],
    };
  });
}

/**
 * スケール縮小用フレーム差分データを生成
 */
function createScaleShrinkFrames(frameCount: number): FrameDiffResult[] {
  const centerX = 500;
  const centerY = 500;
  const startSize = 400;
  const endSize = 100;

  return Array.from({ length: frameCount }, (_, i) => {
    const ratio = i / (frameCount - 1);
    const currentSize = startSize + (endSize - startSize) * ratio;
    const halfSize = currentSize / 2;

    return {
      frameIndex: i,
      diffPercentage: 0.4 - ratio * 0.3,
      changedPixels: Math.round((0.4 - ratio * 0.3) * 100000),
      totalPixels: 100000,
      boundingBox: {
        x: centerX - halfSize,
        y: centerY - halfSize,
        width: currentSize,
        height: currentSize,
      },
      motionVectors: [
        { dx: -ratio * 2, dy: -ratio * 2, magnitude: ratio * Math.sqrt(8) },
        { dx: ratio * 2, dy: -ratio * 2, magnitude: ratio * Math.sqrt(8) },
        { dx: -ratio * 2, dy: ratio * 2, magnitude: ratio * Math.sqrt(8) },
        { dx: ratio * 2, dy: ratio * 2, magnitude: ratio * Math.sqrt(8) },
      ],
    };
  });
}

/**
 * パララックス用フレーム差分データを生成（2レイヤー）
 */
function createParallaxFrames(frameCount: number): FrameDiffResult[] {
  // 背景レイヤー: 遅い動き
  const bgSpeed = 3;
  // 前景レイヤー: 速い動き
  const fgSpeed = 8;

  return Array.from({ length: frameCount }, (_, i) => ({
    frameIndex: i,
    diffPercentage: 0.25,
    changedPixels: 25000,
    totalPixels: 100000,
    // 複合領域
    boundingBox: {
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
    },
    // 異なる速度のモーションベクトル（パララックスの特徴）
    motionVectors: [
      { dx: bgSpeed, dy: 0, magnitude: bgSpeed },  // 背景
      { dx: fgSpeed, dy: 0, magnitude: fgSpeed },  // 前景
    ],
  }));
}

/**
 * 複合動き用フレーム差分データを生成（フェード + スライド）
 */
function createComplexFadeSlideFrames(frameCount: number): FrameDiffResult[] {
  const speed = 6;
  return Array.from({ length: frameCount }, (_, i) => {
    const ratio = i / (frameCount - 1);
    return {
      frameIndex: i,
      // フェード成分（変化率が徐々に減少）+ スライド成分
      diffPercentage: (1 - ratio) * 0.5 + 0.15,
      changedPixels: Math.round(((1 - ratio) * 0.5 + 0.15) * 100000),
      totalPixels: 100000,
      // スライド成分（位置移動）
      boundingBox: {
        x: i * speed,
        y: 100,
        width: 200,
        height: 200,
      },
      // スライドのモーションベクトル
      motionVectors: [
        { dx: speed, dy: 0, magnitude: speed },
      ],
    };
  });
}

/**
 * 静的フレーム差分データを生成（変化なし）
 */
function createStaticFrames(frameCount: number): FrameDiffResult[] {
  return Array.from({ length: frameCount }, (_, i) => ({
    frameIndex: i,
    diffPercentage: 0.001, // ほぼ変化なし
    changedPixels: 100,
    totalPixels: 100000,
    boundingBox: undefined,
    motionVectors: [],
  }));
}

/**
 * 曖昧な動きのフレーム差分データを生成
 */
function createAmbiguousFrames(frameCount: number): FrameDiffResult[] {
  return Array.from({ length: frameCount }, (_, i) => ({
    frameIndex: i,
    diffPercentage: 0.05 + Math.random() * 0.1, // ランダムな小さい変化
    changedPixels: Math.round((0.05 + Math.random() * 0.1) * 100000),
    totalPixels: 100000,
    boundingBox: {
      x: 100 + Math.round(Math.random() * 20),
      y: 100 + Math.round(Math.random() * 20),
      width: 200,
      height: 200,
    },
    motionVectors: [
      {
        dx: Math.random() * 5 - 2.5,
        dy: Math.random() * 5 - 2.5,
        magnitude: Math.random() * 3,
      },
    ],
  }));
}

/**
 * FrameAnalysisResultを生成
 */
function createFrameAnalysisResult(frames: FrameDiffResult[]): FrameAnalysisResult {
  const diffPercentages = frames.map(f => f.diffPercentage);
  return {
    frames,
    summary: {
      avgDiffPercentage: diffPercentages.reduce((a, b) => a + b, 0) / frames.length,
      maxDiffPercentage: Math.max(...diffPercentages),
      totalFrames: frames.length,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('VisualCategoryClassifier', () => {
  // Note: TDD Green Phase - 実装済み

  describe('constructor', () => {
    it('should create instance with default config', () => {
      // TDD Green: インスタンスが正常に作成される
      const classifier = new VisualCategoryClassifier();
      expect(classifier).toBeDefined();
    });

    it('should accept custom config', () => {
      const config: VisualCategoryClassifierConfig = {
        fade_threshold: 0.15,
        slide_consistency_threshold: 0.8,
        scale_threshold: 0.2,
        min_confidence_threshold: 0.6,
      };
      const classifier = new VisualCategoryClassifier(config);
      expect(classifier).toBeDefined();
    });
  });

  describe('fade detection', () => {
    describe('fade in', () => {
      it('should detect fade in pattern with high confidence', () => {
        const frames = createFadeInFrames(30);
        const input = createFrameAnalysisResult(frames);

        // TDD Red: 実装がないためこのテストは失敗する
        // 期待される動作: opacity変化が主で位置変化なし → fade_in 検出
        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.primary_category).toBe('fade');
        expect(result.confidence).toBeGreaterThan(0.8);
        expect(result.details?.fade?.type).toBe('in');
      });

      it('should calculate fade in duration correctly', () => {
        const frames = createFadeInFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.details?.fade?.duration_frames).toBe(30);
      });

      it('should estimate opacity change', () => {
        const frames = createFadeInFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.details?.fade?.start_opacity).toBeLessThan(result.details?.fade?.end_opacity ?? 0);
      });
    });

    describe('fade out', () => {
      it('should detect fade out pattern', () => {
        const frames = createFadeOutFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.primary_category).toBe('fade');
        expect(result.details?.fade?.type).toBe('out');
      });

      it('should distinguish fade out from fade in', () => {
        const fadeOutFrames = createFadeOutFrames(30);
        const fadeInFrames = createFadeInFrames(30);

        const classifier = new VisualCategoryClassifier();

        const fadeOutResult = classifier.classify(createFrameAnalysisResult(fadeOutFrames));
        const fadeInResult = classifier.classify(createFrameAnalysisResult(fadeInFrames));

        expect(fadeOutResult.details?.fade?.type).toBe('out');
        expect(fadeInResult.details?.fade?.type).toBe('in');
      });
    });

    describe('partial fade', () => {
      it('should detect regional fade (part of frame)', () => {
        // 部分的なフェード（フレームの一部のみ）
        const frames = createFadeInFrames(30).map(f => ({
          ...f,
          boundingBox: {
            x: 300,
            y: 300,
            width: 400,
            height: 400,
          },
        }));
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.primary_category).toBe('fade');
        expect(result.metrics.affected_area_ratio).toBeLessThan(0.5);
      });
    });
  });

  describe('slide detection', () => {
    describe('horizontal slide', () => {
      it('should detect horizontal slide pattern', () => {
        const frames = createHorizontalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.primary_category).toBe('slide');
        expect(result.details?.slide?.direction).toBe('horizontal');
      });

      it('should calculate horizontal movement angle', () => {
        const frames = createHorizontalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        // 水平方向は0度または180度
        expect([0, 180]).toContain(Math.round(result.details?.slide?.angle_degrees ?? -1));
      });

      it('should calculate slide distance', () => {
        const frames = createHorizontalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        // 10px/frame * 29 frames = 290px
        expect(result.details?.slide?.distance_px).toBeGreaterThan(200);
      });
    });

    describe('vertical slide', () => {
      it('should detect vertical slide pattern', () => {
        const frames = createVerticalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.primary_category).toBe('slide');
        expect(result.details?.slide?.direction).toBe('vertical');
      });

      it('should calculate vertical movement angle', () => {
        const frames = createVerticalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        // 垂直方向は90度または270度
        expect([90, 270]).toContain(Math.round(result.details?.slide?.angle_degrees ?? -1));
      });
    });

    describe('diagonal slide', () => {
      it('should detect diagonal slide pattern', () => {
        const frames = createDiagonalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.primary_category).toBe('slide');
        expect(result.details?.slide?.direction).toBe('diagonal');
      });

      it('should calculate diagonal angle correctly', () => {
        const frames = createDiagonalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        // 45度方向の斜め移動
        expect(result.details?.slide?.angle_degrees).toBeGreaterThan(40);
        expect(result.details?.slide?.angle_degrees).toBeLessThan(50);
      });
    });

    describe('slide consistency', () => {
      it('should have high confidence for consistent direction', () => {
        const frames = createHorizontalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.confidence).toBeGreaterThan(0.85);
      });
    });
  });

  describe('scale detection', () => {
    describe('scale expand', () => {
      it('should detect scale expand pattern', () => {
        const frames = createScaleExpandFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.primary_category).toBe('scale');
        expect(result.details?.scale?.type).toBe('expand');
      });

      it('should calculate scale ratio', () => {
        const frames = createScaleExpandFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.details?.scale?.start_scale).toBeLessThan(result.details?.scale?.end_scale ?? 0);
        // 100 -> 400 = 4x scale
        expect((result.details?.scale?.end_scale ?? 0) / (result.details?.scale?.start_scale ?? 1)).toBeCloseTo(4, 0);
      });
    });

    describe('scale shrink', () => {
      it('should detect scale shrink pattern', () => {
        const frames = createScaleShrinkFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.primary_category).toBe('scale');
        expect(result.details?.scale?.type).toBe('shrink');
      });

      it('should distinguish shrink from expand', () => {
        const expandFrames = createScaleExpandFrames(30);
        const shrinkFrames = createScaleShrinkFrames(30);

        const classifier = new VisualCategoryClassifier();

        const expandResult = classifier.classify(createFrameAnalysisResult(expandFrames));
        const shrinkResult = classifier.classify(createFrameAnalysisResult(shrinkFrames));

        expect(expandResult.details?.scale?.type).toBe('expand');
        expect(shrinkResult.details?.scale?.type).toBe('shrink');
      });
    });

    describe('aspect ratio', () => {
      it('should detect aspect ratio maintained scaling', () => {
        const frames = createScaleExpandFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.details?.scale?.aspect_ratio_maintained).toBe(true);
      });

      it('should detect aspect ratio change', () => {
        // アスペクト比が変わるスケール（幅のみ拡大、高さは固定）
        // 中心座標が固定のまま、幅だけが拡大する
        const centerX = 500;
        const centerY = 500;
        const fixedHeight = 100;
        const startWidth = 100;
        const endWidth = 400;
        const frameCount = 30;

        const frames: FrameDiffResult[] = Array.from({ length: frameCount }, (_, i) => {
          const ratio = i / (frameCount - 1);
          const currentWidth = startWidth + (endWidth - startWidth) * ratio;

          return {
            frameIndex: i,
            diffPercentage: 0.1 + ratio * 0.3,
            changedPixels: Math.round((0.1 + ratio * 0.3) * 100000),
            totalPixels: 100000,
            // 中心座標を固定して、幅のみ変化
            boundingBox: {
              x: centerX - currentWidth / 2,  // 中心Xが500になるように
              y: centerY - fixedHeight / 2,   // 中心Yが500で固定
              width: currentWidth,            // 100 -> 400
              height: fixedHeight,            // 100で固定
            },
            // モーションベクトルなし（純粋なスケール）
            motionVectors: [],
          };
        });
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.details?.scale?.aspect_ratio_maintained).toBe(false);
      });
    });
  });

  describe('parallax detection', () => {
    it('should detect parallax pattern with multiple layers', () => {
      const frames = createParallaxFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.primary_category).toBe('parallax');
    });

    it('should calculate layer count', () => {
      const frames = createParallaxFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.details?.parallax?.layer_count).toBeGreaterThanOrEqual(2);
    });

    it('should calculate speed ratios between layers', () => {
      const frames = createParallaxFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      const speedRatios = result.details?.parallax?.speed_ratios ?? [];
      expect(speedRatios.length).toBeGreaterThanOrEqual(2);

      // 速度比が異なることを確認
      const uniqueRatios = new Set(speedRatios.map(r => Math.round(r * 10)));
      expect(uniqueRatios.size).toBeGreaterThan(1);
    });

    it('should estimate depth order', () => {
      const frames = createParallaxFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.details?.parallax?.depth_order).toBeDefined();
      expect(result.details?.parallax?.depth_order?.length).toBeGreaterThanOrEqual(2);
    });

    it('should distinguish parallax from simple slide', () => {
      const parallaxFrames = createParallaxFrames(30);
      const slideFrames = createHorizontalSlideFrames(30);

      const classifier = new VisualCategoryClassifier();

      const parallaxResult = classifier.classify(createFrameAnalysisResult(parallaxFrames));
      const slideResult = classifier.classify(createFrameAnalysisResult(slideFrames));

      expect(parallaxResult.primary_category).toBe('parallax');
      expect(slideResult.primary_category).toBe('slide');
    });
  });

  describe('complex motion detection', () => {
    it('should detect complex pattern (fade + slide)', () => {
      const frames = createComplexFadeSlideFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.primary_category).toBe('complex');
    });

    it('should include secondary categories for complex motion', () => {
      const frames = createComplexFadeSlideFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.secondary_categories).toBeDefined();
      expect(result.secondary_categories?.length).toBeGreaterThanOrEqual(2);
    });

    it('should weight secondary categories', () => {
      const frames = createComplexFadeSlideFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      const categories = result.secondary_categories ?? [];
      const hasSlide = categories.some(c => c.category === 'slide');
      const hasFade = categories.some(c => c.category === 'fade');

      expect(hasSlide).toBe(true);
      expect(hasFade).toBe(true);

      // 重みの合計は1に近いはず
      const totalWeight = categories.reduce((sum, c) => sum + c.weight, 0);
      expect(totalWeight).toBeCloseTo(1, 1);
    });

    it('should calculate confidence for complex pattern', () => {
      const frames = createComplexFadeSlideFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      // 複合パターンでも信頼度は一定以上
      expect(result.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('confidence calculation', () => {
    it('should have high confidence (>0.8) for clear patterns', () => {
      const frames = createHorizontalSlideFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('should have low confidence (<0.5) for ambiguous patterns', () => {
      const frames = createAmbiguousFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.confidence).toBeLessThan(0.5);
    });

    it('should return unknown for very low confidence', () => {
      const frames = createAmbiguousFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier({ min_confidence_threshold: 0.4 });
      const result = classifier.classify(input);

      // 信頼度が閾値未満の場合はunknown
      if (result.confidence < 0.4) {
        expect(result.primary_category).toBe('unknown');
      }
    });

    it('should have confidence between 0 and 1', () => {
      const testCases = [
        createFadeInFrames(30),
        createHorizontalSlideFrames(30),
        createScaleExpandFrames(30),
        createParallaxFrames(30),
        createComplexFadeSlideFrames(30),
        createStaticFrames(30),
        createAmbiguousFrames(30),
      ];

      const classifier = new VisualCategoryClassifier();

      for (const frames of testCases) {
        const result = classifier.classify(createFrameAnalysisResult(frames));
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('metrics calculation', () => {
    describe('dominant_direction', () => {
      it('should calculate dominant direction for slide', () => {
        const frames = createHorizontalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.metrics.dominant_direction).toBeDefined();
        // 水平右方向は0度
        expect(result.metrics.dominant_direction).toBeCloseTo(0, 0);
      });

      it('should calculate dominant direction for vertical slide', () => {
        const frames = createVerticalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        // 下方向は90度
        expect(result.metrics.dominant_direction).toBeCloseTo(90, 0);
      });

      it('should not have dominant direction for fade', () => {
        const frames = createFadeInFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        // フェードは方向がない
        expect(result.metrics.dominant_direction).toBeUndefined();
      });
    });

    describe('movement_intensity', () => {
      it('should calculate normalized movement intensity (0-1)', () => {
        const frames = createHorizontalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.metrics.movement_intensity).toBeGreaterThanOrEqual(0);
        expect(result.metrics.movement_intensity).toBeLessThanOrEqual(1);
      });

      it('should have low intensity for static frames', () => {
        const frames = createStaticFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.metrics.movement_intensity).toBeLessThan(0.1);
      });

      it('should have higher intensity for fast movement', () => {
        const slowFrames = createHorizontalSlideFrames(30);
        // 速いスライド（モーションベクトルを大きく）
        const fastFrames = createHorizontalSlideFrames(30).map(f => ({
          ...f,
          motionVectors: f.motionVectors?.map(v => ({
            ...v,
            dx: v.dx * 3,
            magnitude: v.magnitude * 3,
          })),
        }));

        const classifier = new VisualCategoryClassifier();
        const slowResult = classifier.classify(createFrameAnalysisResult(slowFrames));
        const fastResult = classifier.classify(createFrameAnalysisResult(fastFrames));

        expect(fastResult.metrics.movement_intensity).toBeGreaterThan(slowResult.metrics.movement_intensity);
      });
    });

    describe('affected_area_ratio', () => {
      it('should calculate affected area ratio correctly', () => {
        const frames = createHorizontalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.metrics.affected_area_ratio).toBeGreaterThanOrEqual(0);
        expect(result.metrics.affected_area_ratio).toBeLessThanOrEqual(1);
      });

      it('should have high affected area ratio for full-frame changes', () => {
        const frames = createFadeInFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        // フェードは全体に影響
        expect(result.metrics.affected_area_ratio).toBeGreaterThan(0.8);
      });

      it('should have low affected area ratio for localized changes', () => {
        // 小さい領域のみ変化
        const frames = createHorizontalSlideFrames(30).map(f => ({
          ...f,
          boundingBox: {
            x: 450,
            y: 450,
            width: 100,
            height: 100,
          },
        }));
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        // 1000x1000のうち100x100 = 1%
        expect(result.metrics.affected_area_ratio).toBeLessThan(0.1);
      });
    });

    describe('velocity_variance', () => {
      it('should calculate velocity variance for motion', () => {
        const frames = createHorizontalSlideFrames(30);
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        // 一定速度なので分散は低い
        expect(result.metrics.velocity_variance).toBeDefined();
        expect(result.metrics.velocity_variance).toBeLessThan(0.1);
      });

      it('should have high variance for accelerating motion', () => {
        // 加速するスライド
        const frames = createHorizontalSlideFrames(30).map((f, i) => ({
          ...f,
          motionVectors: f.motionVectors?.map(v => ({
            ...v,
            dx: v.dx * (1 + i / 10), // 徐々に加速
            magnitude: v.magnitude * (1 + i / 10),
          })),
        }));
        const input = createFrameAnalysisResult(frames);

        const classifier = new VisualCategoryClassifier();
        const result = classifier.classify(input);

        expect(result.metrics.velocity_variance).toBeGreaterThan(0);
      });
    });
  });

  describe('static detection', () => {
    it('should detect static (no motion) pattern', () => {
      const frames = createStaticFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.primary_category).toBe('static');
    });

    it('should have high confidence for truly static frames', () => {
      const frames = createStaticFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.confidence).toBeGreaterThan(0.9);
    });
  });

  describe('edge cases', () => {
    it('should handle empty frame array', () => {
      const input: FrameAnalysisResult = {
        frames: [],
        summary: {
          avgDiffPercentage: 0,
          maxDiffPercentage: 0,
          totalFrames: 0,
        },
      };

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.primary_category).toBe('static');
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('should handle single frame', () => {
      const input: FrameAnalysisResult = {
        frames: [{
          frameIndex: 0,
          diffPercentage: 0,
          changedPixels: 0,
          totalPixels: 100000,
        }],
        summary: {
          avgDiffPercentage: 0,
          maxDiffPercentage: 0,
          totalFrames: 1,
        },
      };

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.primary_category).toBe('static');
    });

    it('should handle frames without boundingBox', () => {
      const frames: FrameDiffResult[] = Array.from({ length: 30 }, (_, i) => ({
        frameIndex: i,
        diffPercentage: 0.1,
        changedPixels: 10000,
        totalPixels: 100000,
        // boundingBoxなし
      }));
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();

      expect(() => classifier.classify(input)).not.toThrow();
    });

    it('should handle frames without motionVectors', () => {
      const frames: FrameDiffResult[] = Array.from({ length: 30 }, (_, i) => ({
        frameIndex: i,
        diffPercentage: 0.1,
        changedPixels: 10000,
        totalPixels: 100000,
        boundingBox: { x: 100, y: 100, width: 200, height: 200 },
        // motionVectorsなし
      }));
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();

      expect(() => classifier.classify(input)).not.toThrow();
    });

    it('should handle very long frame sequences', () => {
      const frames = createHorizontalSlideFrames(1000);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const startTime = performance.now();
      const result = classifier.classify(input);
      const elapsed = performance.now() - startTime;

      expect(result).toBeDefined();
      expect(elapsed).toBeLessThan(5000); // 5秒以内
    });
  });

  describe('classifyFrameSequence method', () => {
    it('should accept FrameDiffResult array directly', () => {
      const frames = createHorizontalSlideFrames(30);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classifyFrameSequence(frames);

      expect(result.primary_category).toBe('slide');
    });
  });

  describe('processing time', () => {
    it('should include processing time in result', () => {
      const frames = createHorizontalSlideFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.processing_time_ms).toBeDefined();
      expect(result.processing_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('should process 100 frames in under 1 second', () => {
      const frames = createHorizontalSlideFrames(100);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier();
      const result = classifier.classify(input);

      expect(result.processing_time_ms).toBeLessThan(1000);
    });
  });

  describe('configuration', () => {
    it('should respect fade_threshold config', () => {
      const frames = createFadeInFrames(30).map(f => ({
        ...f,
        diffPercentage: f.diffPercentage * 0.3, // 低い変化率
      }));
      const input = createFrameAnalysisResult(frames);

      // 低い閾値では検出される
      const lowThresholdClassifier = new VisualCategoryClassifier({ fade_threshold: 0.05 });
      const lowResult = lowThresholdClassifier.classify(input);

      // 高い閾値では検出されない可能性
      const highThresholdClassifier = new VisualCategoryClassifier({ fade_threshold: 0.5 });
      const highResult = highThresholdClassifier.classify(input);

      // 低い閾値の方が fade として検出される可能性が高い
      if (lowResult.primary_category === 'fade') {
        expect(highResult.primary_category).not.toBe('fade');
      }
    });

    it('should respect min_confidence_threshold config', () => {
      const frames = createAmbiguousFrames(30);
      const input = createFrameAnalysisResult(frames);

      const classifier = new VisualCategoryClassifier({ min_confidence_threshold: 0.8 });
      const result = classifier.classify(input);

      // 閾値未満なら unknown
      if (result.confidence < 0.8) {
        expect(result.primary_category).toBe('unknown');
      }
    });
  });
});
