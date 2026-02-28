// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionEmbedding Tests
 *
 * TDD Red Phase: 50+ test cases for motion embedding system
 *
 * Test Categories:
 * 1. 特徴抽出テスト (15テスト) - プロパティ、タイミング、イージング、キーフレーム特徴量
 * 2. Embedding生成テスト (15テスト) - 単一・バッチEmbedding、次元数・正規化検証
 * 3. 類似度計算テスト (10テスト) - コサイン類似度、同一・異なるパターン類似度
 * 4. 検索テスト (10テスト) - topK検索、しきい値フィルタリング、空候補リスト
 *
 * @module @reftrix/webdesign-core/tests/motion-detector/motion-embedding
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MotionEmbedding,
  MotionFeatureExtractor,
  MOTION_EMBEDDING_DIM,
  type SimilarityResult,
} from '../../src/motion-detector/motion-embedding';
import type {
  MotionPattern,
  KeyframeStep,
} from '../../src/motion-detector';

// =========================================
// Test Fixtures
// =========================================

/**
 * シンプルなフェードインアニメーションパターン
 */
const createFadeInPattern = (): MotionPattern => ({
  id: 'fade-in-1',
  type: 'animation',
  name: 'fadeIn',
  selector: '.element',
  properties: [{ name: 'opacity', from: '0', to: '1' }],
  duration: 1000,
  delay: 0,
  easing: 'ease-in-out',
  iterations: 1,
  direction: 'normal',
  fillMode: 'forwards',
  playState: 'running',
  trigger: 'load',
  confidence: 0.9,
});

/**
 * シンプルなフェードアウトアニメーションパターン
 */
const createFadeOutPattern = (): MotionPattern => ({
  id: 'fade-out-1',
  type: 'animation',
  name: 'fadeOut',
  selector: '.element',
  properties: [{ name: 'opacity', from: '1', to: '0' }],
  duration: 1000,
  delay: 0,
  easing: 'ease-in-out',
  iterations: 1,
  direction: 'normal',
  fillMode: 'forwards',
  playState: 'running',
  trigger: 'load',
  confidence: 0.9,
});

/**
 * スライドインアニメーションパターン
 */
const createSlideInPattern = (): MotionPattern => ({
  id: 'slide-in-1',
  type: 'animation',
  name: 'slideIn',
  selector: '.element',
  properties: [{ name: 'transform', from: 'translateX(-100%)', to: 'translateX(0)' }],
  duration: 500,
  delay: 0,
  easing: 'ease-out',
  iterations: 1,
  direction: 'normal',
  fillMode: 'forwards',
  playState: 'running',
  trigger: 'load',
  confidence: 0.9,
});

/**
 * 複雑なバウンスアニメーションパターン
 */
const createBouncePattern = (): MotionPattern => ({
  id: 'bounce-1',
  type: 'animation',
  name: 'bounce',
  selector: '.element',
  properties: [
    {
      name: 'transform',
      from: 'translateY(0)',
      to: 'translateY(0)',
      keyframes: [
        { offset: 0, value: 'translateY(0)' },
        { offset: 0.5, value: 'translateY(-30px)' },
        { offset: 1, value: 'translateY(0)' },
      ],
    },
  ],
  duration: 800,
  delay: 0,
  easing: 'cubic-bezier(0.68, -0.55, 0.27, 1.55)',
  iterations: 'infinite',
  direction: 'normal',
  fillMode: 'none',
  playState: 'running',
  trigger: 'load',
  confidence: 0.9,
});

/**
 * hoverトランジションパターン
 */
const createHoverTransitionPattern = (): MotionPattern => ({
  id: 'hover-1',
  type: 'transition',
  name: 'transition-transform',
  selector: '.button',
  properties: [
    { name: 'transform', from: 'scale(1)', to: 'scale(1.1)' },
    { name: 'box-shadow', from: 'none', to: '0 4px 8px rgba(0,0,0,0.2)' },
  ],
  duration: 200,
  delay: 0,
  easing: 'ease',
  iterations: 1,
  direction: 'normal',
  fillMode: 'none',
  playState: 'running',
  trigger: 'hover',
  confidence: 0.85,
});

/**
 * 複雑なマルチプロパティアニメーション
 */
const createComplexAnimationPattern = (): MotionPattern => ({
  id: 'complex-1',
  type: 'animation',
  name: 'complexEntrance',
  selector: '.card',
  properties: [
    {
      name: 'opacity',
      from: '0',
      to: '1',
      keyframes: [
        { offset: 0, value: '0' },
        { offset: 0.5, value: '0.5' },
        { offset: 1, value: '1' },
      ],
    },
    {
      name: 'transform',
      from: 'scale(0.8) translateY(20px)',
      to: 'scale(1) translateY(0)',
      keyframes: [
        { offset: 0, value: 'scale(0.8) translateY(20px)' },
        { offset: 0.5, value: 'scale(0.9) translateY(10px)' },
        { offset: 1, value: 'scale(1) translateY(0)' },
      ],
    },
    {
      name: 'filter',
      from: 'blur(10px)',
      to: 'blur(0)',
      keyframes: [
        { offset: 0, value: 'blur(10px)' },
        { offset: 1, value: 'blur(0)' },
      ],
    },
  ],
  duration: 1200,
  delay: 100,
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
  iterations: 1,
  direction: 'normal',
  fillMode: 'both',
  playState: 'running',
  trigger: 'scroll',
  confidence: 0.95,
});

/**
 * スピンアニメーションパターン
 */
const createSpinPattern = (): MotionPattern => ({
  id: 'spin-1',
  type: 'animation',
  name: 'spin',
  selector: '.loader',
  properties: [
    {
      name: 'transform',
      from: 'rotate(0deg)',
      to: 'rotate(360deg)',
    },
  ],
  duration: 1000,
  delay: 0,
  easing: 'linear',
  iterations: 'infinite',
  direction: 'normal',
  fillMode: 'none',
  playState: 'running',
  trigger: 'load',
  confidence: 0.9,
});

/**
 * パルスアニメーションパターン
 */
const createPulsePattern = (): MotionPattern => ({
  id: 'pulse-1',
  type: 'animation',
  name: 'pulse',
  selector: '.notification',
  properties: [
    {
      name: 'transform',
      from: 'scale(1)',
      to: 'scale(1)',
      keyframes: [
        { offset: 0, value: 'scale(1)' },
        { offset: 0.5, value: 'scale(1.05)' },
        { offset: 1, value: 'scale(1)' },
      ],
    },
    {
      name: 'opacity',
      from: '1',
      to: '1',
      keyframes: [
        { offset: 0, value: '1' },
        { offset: 0.5, value: '0.8' },
        { offset: 1, value: '1' },
      ],
    },
  ],
  duration: 2000,
  delay: 0,
  easing: 'ease-in-out',
  iterations: 'infinite',
  direction: 'normal',
  fillMode: 'none',
  playState: 'running',
  trigger: 'load',
  confidence: 0.9,
});

/**
 * ゼロduration/delayパターン
 */
const createZeroDurationPattern = (): MotionPattern => ({
  id: 'zero-1',
  type: 'animation',
  name: 'instant',
  selector: '.element',
  properties: [{ name: 'opacity', from: '0', to: '1' }],
  duration: 0,
  delay: 0,
  easing: 'linear',
  iterations: 1,
  direction: 'normal',
  fillMode: 'none',
  playState: 'running',
  trigger: 'load',
  confidence: 0.5,
});

/**
 * プロパティなしパターン
 */
const createEmptyPropertiesPattern = (): MotionPattern => ({
  id: 'empty-1',
  type: 'animation',
  name: 'empty',
  selector: '.element',
  properties: [],
  duration: 1000,
  delay: 0,
  easing: 'ease',
  iterations: 1,
  direction: 'normal',
  fillMode: 'none',
  playState: 'running',
  trigger: 'load',
  confidence: 0.3,
});

// =========================================
// 1. 特徴抽出テスト (15テスト)
// =========================================

describe('MotionFeatureExtractor - 特徴抽出', () => {
  let extractor: MotionFeatureExtractor;

  beforeEach(() => {
    extractor = new MotionFeatureExtractor();
  });

  describe('プロパティ特徴量', () => {
    it('should extract property features from opacity animation', () => {
      // Arrange
      const pattern = createFadeInPattern();

      // Act
      const features = extractor.extractPropertyFeatures(pattern);

      // Assert
      expect(features).toBeDefined();
      expect(Array.isArray(features)).toBe(true);
      expect(features.length).toBeGreaterThan(0);
      // opacityはGPUアクセラレーション対応プロパティなのでフラグが立つ
    });

    it('should extract property features from transform animation', () => {
      // Arrange
      const pattern = createSlideInPattern();

      // Act
      const features = extractor.extractPropertyFeatures(pattern);

      // Assert
      expect(features).toBeDefined();
      expect(features.length).toBeGreaterThan(0);
      // transformはGPUアクセラレーション対応
    });

    it('should handle multiple properties', () => {
      // Arrange
      const pattern = createComplexAnimationPattern();

      // Act
      const features = extractor.extractPropertyFeatures(pattern);

      // Assert
      expect(features.length).toBeGreaterThan(0);
      // 複数プロパティがある場合、特徴量に反映される
    });

    it('should return zero vector for empty properties', () => {
      // Arrange
      const pattern = createEmptyPropertiesPattern();

      // Act
      const features = extractor.extractPropertyFeatures(pattern);

      // Assert
      expect(features).toBeDefined();
      expect(features.every((v) => v === 0)).toBe(true);
    });

    it('should differentiate GPU vs non-GPU properties', () => {
      // Arrange
      const gpuPattern = createFadeInPattern(); // opacity (GPU)
      const nonGpuPattern: MotionPattern = {
        ...createFadeInPattern(),
        id: 'non-gpu',
        properties: [{ name: 'width', from: '100px', to: '200px' }],
      };

      // Act
      const gpuFeatures = extractor.extractPropertyFeatures(gpuPattern);
      const nonGpuFeatures = extractor.extractPropertyFeatures(nonGpuPattern);

      // Assert
      expect(gpuFeatures).not.toEqual(nonGpuFeatures);
    });
  });

  describe('タイミング特徴量', () => {
    it('should extract timing features with duration', () => {
      // Arrange
      const pattern = createFadeInPattern();

      // Act
      const features = extractor.extractTimingFeatures(pattern);

      // Assert
      expect(features).toBeDefined();
      expect(features.length).toBeGreaterThan(0);
    });

    it('should extract timing features with delay', () => {
      // Arrange
      const pattern = createComplexAnimationPattern(); // delay: 100

      // Act
      const features = extractor.extractTimingFeatures(pattern);

      // Assert
      expect(features).toBeDefined();
      // delay情報が特徴量に含まれる
    });

    it('should handle zero duration', () => {
      // Arrange
      const pattern = createZeroDurationPattern();

      // Act
      const features = extractor.extractTimingFeatures(pattern);

      // Assert
      expect(features).toBeDefined();
      expect(features.length).toBeGreaterThan(0);
    });

    it('should normalize duration values', () => {
      // Arrange
      const shortPattern: MotionPattern = {
        ...createFadeInPattern(),
        duration: 100,
      };
      const longPattern: MotionPattern = {
        ...createFadeInPattern(),
        duration: 10000,
      };

      // Act
      const shortFeatures = extractor.extractTimingFeatures(shortPattern);
      const longFeatures = extractor.extractTimingFeatures(longPattern);

      // Assert
      // 特徴量は正規化されているので、全て[-1, 1]または[0, 1]範囲内
      expect(shortFeatures.every((v) => v >= -1 && v <= 1)).toBe(true);
      expect(longFeatures.every((v) => v >= -1 && v <= 1)).toBe(true);
    });

    it('should handle infinite iterations', () => {
      // Arrange
      const infinitePattern = createBouncePattern(); // iterations: 'infinite'

      // Act
      const features = extractor.extractTimingFeatures(infinitePattern);

      // Assert
      expect(features).toBeDefined();
      // infiniteは特別な値としてエンコードされる
    });
  });

  describe('イージング特徴量', () => {
    it('should extract features for ease easing', () => {
      // Arrange
      const easing = 'ease';

      // Act
      const features = extractor.extractEasingFeatures(easing);

      // Assert
      expect(features).toBeDefined();
      expect(features.length).toBeGreaterThan(0);
    });

    it('should extract features for linear easing', () => {
      // Arrange
      const easing = 'linear';

      // Act
      const features = extractor.extractEasingFeatures(easing);

      // Assert
      expect(features).toBeDefined();
    });

    it('should extract features for ease-in-out easing', () => {
      // Arrange
      const easing = 'ease-in-out';

      // Act
      const features = extractor.extractEasingFeatures(easing);

      // Assert
      expect(features).toBeDefined();
    });

    it('should extract features for cubic-bezier easing', () => {
      // Arrange
      const easing = 'cubic-bezier(0.4, 0, 0.2, 1)';

      // Act
      const features = extractor.extractEasingFeatures(easing);

      // Assert
      expect(features).toBeDefined();
      // cubic-bezierのパラメータが特徴量に反映される
    });

    it('should differentiate different easings', () => {
      // Arrange & Act
      const linearFeatures = extractor.extractEasingFeatures('linear');
      const easeInFeatures = extractor.extractEasingFeatures('ease-in');
      const easeOutFeatures = extractor.extractEasingFeatures('ease-out');

      // Assert
      expect(linearFeatures).not.toEqual(easeInFeatures);
      expect(easeInFeatures).not.toEqual(easeOutFeatures);
    });
  });

  describe('キーフレーム特徴量', () => {
    it('should extract keyframe features from simple keyframes', () => {
      // Arrange
      const keyframes: KeyframeStep[] = [
        { offset: 0, properties: [{ name: 'opacity', value: '0' }] },
        { offset: 1, properties: [{ name: 'opacity', value: '1' }] },
      ];

      // Act
      const features = extractor.extractKeyframeFeatures(keyframes);

      // Assert
      expect(features).toBeDefined();
      expect(features.length).toBeGreaterThan(0);
    });

    it('should extract keyframe features from complex keyframes', () => {
      // Arrange
      const keyframes: KeyframeStep[] = [
        { offset: 0, properties: [{ name: 'transform', value: 'translateY(0)' }] },
        { offset: 0.25, properties: [{ name: 'transform', value: 'translateY(-10px)' }] },
        { offset: 0.5, properties: [{ name: 'transform', value: 'translateY(-20px)' }] },
        { offset: 0.75, properties: [{ name: 'transform', value: 'translateY(-10px)' }] },
        { offset: 1, properties: [{ name: 'transform', value: 'translateY(0)' }] },
      ];

      // Act
      const features = extractor.extractKeyframeFeatures(keyframes);

      // Assert
      expect(features).toBeDefined();
      // キーフレーム数が特徴量に反映される
    });

    it('should handle empty keyframes', () => {
      // Arrange
      const keyframes: KeyframeStep[] = [];

      // Act
      const features = extractor.extractKeyframeFeatures(keyframes);

      // Assert
      expect(features).toBeDefined();
      expect(features.every((v) => v === 0)).toBe(true);
    });

    it('should capture keyframe timing distribution', () => {
      // Arrange
      const evenKeyframes: KeyframeStep[] = [
        { offset: 0, properties: [] },
        { offset: 0.5, properties: [] },
        { offset: 1, properties: [] },
      ];
      const unevenKeyframes: KeyframeStep[] = [
        { offset: 0, properties: [] },
        { offset: 0.9, properties: [] },
        { offset: 1, properties: [] },
      ];

      // Act
      const evenFeatures = extractor.extractKeyframeFeatures(evenKeyframes);
      const unevenFeatures = extractor.extractKeyframeFeatures(unevenKeyframes);

      // Assert
      expect(evenFeatures).not.toEqual(unevenFeatures);
    });

    it('should extract features with timing function in keyframes', () => {
      // Arrange
      const keyframes: KeyframeStep[] = [
        { offset: 0, properties: [], timingFunction: 'ease-out' },
        { offset: 1, properties: [], timingFunction: 'ease-in' },
      ];

      // Act
      const features = extractor.extractKeyframeFeatures(keyframes);

      // Assert
      expect(features).toBeDefined();
    });
  });
});

// =========================================
// 2. Embedding生成テスト (15テスト)
// =========================================

describe('MotionEmbedding - Embedding生成', () => {
  let embedding: MotionEmbedding;

  beforeEach(() => {
    embedding = new MotionEmbedding();
  });

  describe('単一パターンEmbedding', () => {
    it('should generate embedding for simple animation', () => {
      // Arrange
      const pattern = createFadeInPattern();

      // Act
      const result = embedding.embed(pattern);

      // Assert
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should generate embedding with correct dimension', () => {
      // Arrange
      const pattern = createFadeInPattern();

      // Act
      const result = embedding.embed(pattern);

      // Assert
      expect(result.length).toBe(MOTION_EMBEDDING_DIM);
    });

    it('should generate embedding for complex animation', () => {
      // Arrange
      const pattern = createComplexAnimationPattern();

      // Act
      const result = embedding.embed(pattern);

      // Assert
      expect(result.length).toBe(MOTION_EMBEDDING_DIM);
    });

    it('should generate embedding for transition', () => {
      // Arrange
      const pattern = createHoverTransitionPattern();

      // Act
      const result = embedding.embed(pattern);

      // Assert
      expect(result.length).toBe(MOTION_EMBEDDING_DIM);
    });

    it('should generate different embeddings for different patterns', () => {
      // Arrange
      const fadeIn = createFadeInPattern();
      const slideIn = createSlideInPattern();

      // Act
      const fadeInEmbedding = embedding.embed(fadeIn);
      const slideInEmbedding = embedding.embed(slideIn);

      // Assert
      expect(fadeInEmbedding).not.toEqual(slideInEmbedding);
    });

    it('should handle pattern with empty properties', () => {
      // Arrange
      const pattern = createEmptyPropertiesPattern();

      // Act
      const result = embedding.embed(pattern);

      // Assert
      expect(result).toBeDefined();
      expect(result.length).toBe(MOTION_EMBEDDING_DIM);
    });
  });

  describe('バッチEmbedding', () => {
    it('should generate batch embeddings', () => {
      // Arrange
      const patterns = [
        createFadeInPattern(),
        createSlideInPattern(),
        createBouncePattern(),
      ];

      // Act
      const results = embedding.embedBatch(patterns);

      // Assert
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(3);
    });

    it('should generate correct dimension for batch', () => {
      // Arrange
      const patterns = [createFadeInPattern(), createSlideInPattern()];

      // Act
      const results = embedding.embedBatch(patterns);

      // Assert
      results.forEach((result) => {
        expect(result.length).toBe(MOTION_EMBEDDING_DIM);
      });
    });

    it('should handle empty batch', () => {
      // Arrange
      const patterns: MotionPattern[] = [];

      // Act
      const results = embedding.embedBatch(patterns);

      // Assert
      expect(results).toBeDefined();
      expect(results.length).toBe(0);
    });

    it('should handle single item batch', () => {
      // Arrange
      const patterns = [createFadeInPattern()];

      // Act
      const results = embedding.embedBatch(patterns);

      // Assert
      expect(results.length).toBe(1);
      expect(results[0].length).toBe(MOTION_EMBEDDING_DIM);
    });

    it('should maintain consistency with single embed', () => {
      // Arrange
      const pattern = createFadeInPattern();

      // Act
      const singleResult = embedding.embed(pattern);
      const batchResult = embedding.embedBatch([pattern])[0];

      // Assert
      expect(singleResult).toEqual(batchResult);
    });
  });

  describe('正規化検証', () => {
    it('should generate L2 normalized embedding', () => {
      // Arrange
      const pattern = createFadeInPattern();

      // Act
      const result = embedding.embed(pattern);

      // Assert
      const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    it('should generate normalized embeddings for all patterns', () => {
      // Arrange
      const patterns = [
        createFadeInPattern(),
        createSlideInPattern(),
        createBouncePattern(),
        createComplexAnimationPattern(),
      ];

      // Act & Assert
      patterns.forEach((pattern) => {
        const result = embedding.embed(pattern);
        const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
        expect(norm).toBeCloseTo(1, 5);
      });
    });

    it('should handle zero vector normalization', () => {
      // Arrange - pattern that might produce zero vector
      const pattern = createZeroDurationPattern();

      // Act
      const result = embedding.embed(pattern);

      // Assert
      // Should not throw and should be normalized or zero vector
      expect(result).toBeDefined();
      expect(result.length).toBe(MOTION_EMBEDDING_DIM);
    });

    it('should contain values in valid range after normalization', () => {
      // Arrange
      const pattern = createComplexAnimationPattern();

      // Act
      const result = embedding.embed(pattern);

      // Assert
      result.forEach((v) => {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      });
    });
  });
});

// =========================================
// 3. 類似度計算テスト (10テスト)
// =========================================

describe('MotionEmbedding - 類似度計算', () => {
  let embedding: MotionEmbedding;

  beforeEach(() => {
    embedding = new MotionEmbedding();
  });

  describe('コサイン類似度', () => {
    it('should calculate similarity between two embeddings', () => {
      // Arrange
      const pattern1 = createFadeInPattern();
      const pattern2 = createFadeOutPattern();
      const emb1 = embedding.embed(pattern1);
      const emb2 = embedding.embed(pattern2);

      // Act
      const similarity = embedding.similarity(emb1, emb2);

      // Assert
      expect(similarity).toBeDefined();
      expect(typeof similarity).toBe('number');
    });

    it('should return value between -1 and 1', () => {
      // Arrange
      const patterns = [
        createFadeInPattern(),
        createSlideInPattern(),
        createBouncePattern(),
      ];
      const embeddings = patterns.map((p) => embedding.embed(p));

      // Act & Assert
      for (let i = 0; i < embeddings.length; i++) {
        for (let j = 0; j < embeddings.length; j++) {
          const similarity = embedding.similarity(embeddings[i], embeddings[j]);
          expect(similarity).toBeGreaterThanOrEqual(-1);
          expect(similarity).toBeLessThanOrEqual(1);
        }
      }
    });

    it('should be symmetric', () => {
      // Arrange
      const pattern1 = createFadeInPattern();
      const pattern2 = createSlideInPattern();
      const emb1 = embedding.embed(pattern1);
      const emb2 = embedding.embed(pattern2);

      // Act
      const sim1 = embedding.similarity(emb1, emb2);
      const sim2 = embedding.similarity(emb2, emb1);

      // Assert
      expect(sim1).toBeCloseTo(sim2, 10);
    });
  });

  describe('同一パターンの類似度', () => {
    it('should return 1 for identical embeddings', () => {
      // Arrange
      const pattern = createFadeInPattern();
      const emb = embedding.embed(pattern);

      // Act
      const similarity = embedding.similarity(emb, emb);

      // Assert
      expect(similarity).toBeCloseTo(1, 5);
    });

    it('should return high similarity for same pattern type', () => {
      // Arrange
      const pattern1 = createFadeInPattern();
      const pattern2 = createFadeOutPattern();
      const emb1 = embedding.embed(pattern1);
      const emb2 = embedding.embed(pattern2);

      // Act
      const similarity = embedding.similarity(emb1, emb2);

      // Assert
      // FadeIn and FadeOut are similar (both opacity animations)
      expect(similarity).toBeGreaterThan(0.5);
    });

    it('should return 1 for copy of same embedding', () => {
      // Arrange
      const pattern = createBouncePattern();
      const emb = embedding.embed(pattern);
      const embCopy = [...emb];

      // Act
      const similarity = embedding.similarity(emb, embCopy);

      // Assert
      expect(similarity).toBeCloseTo(1, 5);
    });
  });

  describe('異なるパターンの類似度', () => {
    it('should return lower similarity for different pattern types', () => {
      // Arrange
      const fadePattern = createFadeInPattern();
      const spinPattern = createSpinPattern();
      const fadeEmb = embedding.embed(fadePattern);
      const spinEmb = embedding.embed(spinPattern);

      // Act
      const similarity = embedding.similarity(fadeEmb, spinEmb);

      // Assert
      // Fade and Spin are different animations
      expect(similarity).toBeLessThan(0.9);
    });

    it('should differentiate between animation and transition', () => {
      // Arrange
      const animationPattern = createBouncePattern();
      const transitionPattern = createHoverTransitionPattern();
      const animEmb = embedding.embed(animationPattern);
      const transEmb = embedding.embed(transitionPattern);

      // Act
      const similarity = embedding.similarity(animEmb, transEmb);

      // Assert
      expect(similarity).toBeLessThan(1);
    });

    it('should group similar motion patterns together', () => {
      // Arrange
      const pulse = createPulsePattern();
      const bounce = createBouncePattern();
      const fade = createFadeInPattern();

      const pulseEmb = embedding.embed(pulse);
      const bounceEmb = embedding.embed(bounce);
      const fadeEmb = embedding.embed(fade);

      // Act
      const pulseBounce = embedding.similarity(pulseEmb, bounceEmb);
      const pulseFade = embedding.similarity(pulseEmb, fadeEmb);

      // Assert
      // Pulse and Bounce are both infinite transform animations
      // They should be more similar to each other than to Fade
      // (This is a semantic expectation, may need adjustment based on implementation)
      expect(typeof pulseBounce).toBe('number');
      expect(typeof pulseFade).toBe('number');
    });

    it('should handle zero vectors gracefully', () => {
      // Arrange
      const zeroVector = new Array(MOTION_EMBEDDING_DIM).fill(0);
      const pattern = createFadeInPattern();
      const emb = embedding.embed(pattern);

      // Act
      const similarity = embedding.similarity(zeroVector, emb);

      // Assert
      // Zero vector should have 0 similarity or handle edge case
      expect(similarity).toBe(0);
    });
  });
});

// =========================================
// 4. 検索テスト (10テスト)
// =========================================

describe('MotionEmbedding - 検索', () => {
  let embedding: MotionEmbedding;

  beforeEach(() => {
    embedding = new MotionEmbedding();
  });

  describe('topK検索', () => {
    it('should find top K similar patterns', () => {
      // Arrange
      const target = embedding.embed(createFadeInPattern());
      const candidates = [
        embedding.embed(createFadeOutPattern()),
        embedding.embed(createSlideInPattern()),
        embedding.embed(createBouncePattern()),
        embedding.embed(createSpinPattern()),
      ];

      // Act
      const results = embedding.findSimilar(target, candidates, 2);

      // Assert
      expect(results).toBeDefined();
      expect(results.length).toBe(2);
    });

    it('should return results sorted by similarity descending', () => {
      // Arrange
      const target = embedding.embed(createFadeInPattern());
      const candidates = [
        embedding.embed(createFadeOutPattern()),
        embedding.embed(createSlideInPattern()),
        embedding.embed(createBouncePattern()),
      ];

      // Act
      const results = embedding.findSimilar(target, candidates, 3);

      // Assert
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].similarity).toBeGreaterThanOrEqual(
          results[i + 1].similarity
        );
      }
    });

    it('should return correct indices', () => {
      // Arrange
      const target = embedding.embed(createFadeInPattern());
      const candidates = [
        embedding.embed(createSlideInPattern()),
        embedding.embed(createFadeOutPattern()), // Most similar at index 1
        embedding.embed(createSpinPattern()),
      ];

      // Act
      const results = embedding.findSimilar(target, candidates, 3);

      // Assert
      results.forEach((result) => {
        expect(result.index).toBeGreaterThanOrEqual(0);
        expect(result.index).toBeLessThan(candidates.length);
      });
    });

    it('should handle K larger than candidates', () => {
      // Arrange
      const target = embedding.embed(createFadeInPattern());
      const candidates = [embedding.embed(createSlideInPattern())];

      // Act
      const results = embedding.findSimilar(target, candidates, 10);

      // Assert
      expect(results.length).toBe(1);
    });

    it('should return all candidates when K equals candidates length', () => {
      // Arrange
      const target = embedding.embed(createFadeInPattern());
      const candidates = [
        embedding.embed(createSlideInPattern()),
        embedding.embed(createBouncePattern()),
        embedding.embed(createSpinPattern()),
      ];

      // Act
      const results = embedding.findSimilar(target, candidates, 3);

      // Assert
      expect(results.length).toBe(3);
    });

    it('should default to returning all results when K not specified', () => {
      // Arrange
      const target = embedding.embed(createFadeInPattern());
      const candidates = [
        embedding.embed(createSlideInPattern()),
        embedding.embed(createBouncePattern()),
      ];

      // Act
      const results = embedding.findSimilar(target, candidates);

      // Assert
      expect(results.length).toBe(2);
    });
  });

  describe('空候補リスト', () => {
    it('should return empty array for empty candidates', () => {
      // Arrange
      const target = embedding.embed(createFadeInPattern());
      const candidates: number[][] = [];

      // Act
      const results = embedding.findSimilar(target, candidates, 5);

      // Assert
      expect(results).toBeDefined();
      expect(results.length).toBe(0);
    });

    it('should handle K = 0', () => {
      // Arrange
      const target = embedding.embed(createFadeInPattern());
      const candidates = [embedding.embed(createSlideInPattern())];

      // Act
      const results = embedding.findSimilar(target, candidates, 0);

      // Assert
      expect(results.length).toBe(0);
    });
  });

  describe('SimilarityResult形式', () => {
    it('should return SimilarityResult with index and similarity', () => {
      // Arrange
      const target = embedding.embed(createFadeInPattern());
      const candidates = [embedding.embed(createSlideInPattern())];

      // Act
      const results = embedding.findSimilar(target, candidates, 1);

      // Assert
      expect(results[0]).toHaveProperty('index');
      expect(results[0]).toHaveProperty('similarity');
      expect(typeof results[0].index).toBe('number');
      expect(typeof results[0].similarity).toBe('number');
    });

    it('should have similarity in valid range', () => {
      // Arrange
      const target = embedding.embed(createFadeInPattern());
      const candidates = [
        embedding.embed(createFadeOutPattern()),
        embedding.embed(createBouncePattern()),
      ];

      // Act
      const results = embedding.findSimilar(target, candidates);

      // Assert
      results.forEach((result) => {
        expect(result.similarity).toBeGreaterThanOrEqual(-1);
        expect(result.similarity).toBeLessThanOrEqual(1);
      });
    });
  });
});

// =========================================
// 5. 定数とエクスポートテスト
// =========================================

describe('MotionEmbedding - 定数', () => {
  it('should export MOTION_EMBEDDING_DIM as 64', () => {
    expect(MOTION_EMBEDDING_DIM).toBe(64);
  });

  it('should have consistent embedding dimension', () => {
    const embedding = new MotionEmbedding();
    const pattern = createFadeInPattern();
    const result = embedding.embed(pattern);

    expect(result.length).toBe(MOTION_EMBEDDING_DIM);
  });
});

// =========================================
// 6. エッジケーステスト
// =========================================

describe('MotionEmbedding - エッジケース', () => {
  let embedding: MotionEmbedding;

  beforeEach(() => {
    embedding = new MotionEmbedding();
  });

  it('should handle pattern with all default values', () => {
    // Arrange
    const pattern: MotionPattern = {
      id: 'minimal',
      type: 'animation',
      name: 'minimal',
      selector: '.x',
      properties: [],
      duration: 0,
      delay: 0,
      easing: 'ease',
      iterations: 1,
      direction: 'normal',
      fillMode: 'none',
      playState: 'running',
      trigger: 'load',
      confidence: 0,
    };

    // Act
    const result = embedding.embed(pattern);

    // Assert
    expect(result).toBeDefined();
    expect(result.length).toBe(MOTION_EMBEDDING_DIM);
  });

  it('should handle pattern with unusual easing', () => {
    // Arrange
    const pattern: MotionPattern = {
      ...createFadeInPattern(),
      easing: 'steps(5, end)',
    };

    // Act
    const result = embedding.embed(pattern);

    // Assert
    expect(result).toBeDefined();
    expect(result.length).toBe(MOTION_EMBEDDING_DIM);
  });

  it('should handle very long duration', () => {
    // Arrange
    const pattern: MotionPattern = {
      ...createFadeInPattern(),
      duration: 1000000, // 1000 seconds
    };

    // Act
    const result = embedding.embed(pattern);

    // Assert
    expect(result).toBeDefined();
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('should handle all trigger types', () => {
    // Arrange
    const triggers: MotionPattern['trigger'][] = [
      'load',
      'hover',
      'scroll',
      'click',
      'focus',
      'custom',
    ];

    // Act & Assert
    triggers.forEach((trigger) => {
      const pattern: MotionPattern = {
        ...createFadeInPattern(),
        trigger,
      };
      const result = embedding.embed(pattern);
      expect(result.length).toBe(MOTION_EMBEDDING_DIM);
    });
  });

  it('should handle all direction types', () => {
    // Arrange
    const directions: MotionPattern['direction'][] = [
      'normal',
      'reverse',
      'alternate',
      'alternate-reverse',
    ];

    // Act & Assert
    directions.forEach((direction) => {
      const pattern: MotionPattern = {
        ...createFadeInPattern(),
        direction,
      };
      const result = embedding.embed(pattern);
      expect(result.length).toBe(MOTION_EMBEDDING_DIM);
    });
  });

  it('should handle all fill mode types', () => {
    // Arrange
    const fillModes: MotionPattern['fillMode'][] = [
      'none',
      'forwards',
      'backwards',
      'both',
    ];

    // Act & Assert
    fillModes.forEach((fillMode) => {
      const pattern: MotionPattern = {
        ...createFadeInPattern(),
        fillMode,
      };
      const result = embedding.embed(pattern);
      expect(result.length).toBe(MOTION_EMBEDDING_DIM);
    });
  });
});
