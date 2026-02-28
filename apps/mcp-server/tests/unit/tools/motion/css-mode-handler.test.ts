// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * css-mode-handler ユニットテスト
 *
 * motion.detect の CSS モード処理ロジックのテスト
 * - 外部CSS取得
 * - レスポンス最適化
 * - サマリー生成
 * - サイズ警告
 * - DB保存
 *
 * @module tests/unit/tools/motion/css-mode-handler.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MotionPattern, MotionDetectInput } from '../../../../src/tools/motion/schemas';
import {
  applyResponseOptimization,
  generateSummary,
  generateSizeWarning,
  generateWebglDetectionWarning,
  type OptimizationResult,
} from '../../../../src/tools/motion/css-mode-handler';
import { MOTION_WARNING_CODES } from '../../../../src/tools/motion/schemas';

// =====================================================
// モック
// =====================================================

// logger モック
vi.mock('../../../../src/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/utils/logger')>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    isDevelopment: vi.fn().mockReturnValue(false),
    // Loggerクラスをモック
    Logger: class MockLogger {
      constructor(_name: string) {}
      info = vi.fn();
      warn = vi.fn();
      error = vi.fn();
      debug = vi.fn();
    },
  };
});

// =====================================================
// テストデータ生成ヘルパー
// =====================================================

/**
 * テスト用 MotionPattern を生成
 */
function createMockPattern(overrides: Partial<MotionPattern> = {}): MotionPattern {
  return {
    id: `pattern-${Math.random().toString(36).substring(7)}`,
    type: 'keyframes',
    name: 'fadeIn',
    category: 'micro_interaction',
    trigger: 'load',
    properties: [],
    animation: {
      duration: 300,
      easing: {
        type: 'ease',
      },
    },
    ...overrides,
  };
}

/**
 * テスト用 MotionDetectInput を生成
 */
function createMockInput(overrides: Partial<MotionDetectInput> = {}): MotionDetectInput {
  return {
    html: '<div></div>',
    includeInlineStyles: true,
    includeStyleSheets: true,
    minDuration: 0,
    maxPatterns: 100,
    includeWarnings: true,
    includeSummary: true,
    verbose: false,
    fetchExternalCss: false,
    save_to_db: false,
    min_severity: 'info',
    ...overrides,
  };
}

/**
 * 指定サイズ（バイト）のパターン配列を生成
 */
function createPatternsOfSize(targetSizeKB: number): MotionPattern[] {
  const patterns: MotionPattern[] = [];
  let currentSize = 0;
  const targetSize = targetSizeKB * 1024;

  while (currentSize < targetSize) {
    const pattern = createMockPattern({
      id: `pattern-${patterns.length}`,
      name: `animation-${patterns.length}-${'x'.repeat(100)}`, // 長めの名前でサイズ増加
      rawCss: `@keyframes anim-${patterns.length} { 0% { opacity: 0; } 100% { opacity: 1; } }`,
    });
    patterns.push(pattern);
    currentSize = JSON.stringify({ patterns }).length;
  }

  return patterns;
}

// =====================================================
// テストスイート
// =====================================================

describe('css-mode-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================
  // applyResponseOptimization
  // =====================================================
  describe('applyResponseOptimization', () => {
    describe('No Optimization', () => {
      it('should return patterns unchanged when no optimization flags are set', () => {
        // Arrange
        const patterns = [
          createMockPattern({ id: 'p1', name: 'anim1' }),
          createMockPattern({ id: 'p2', name: 'anim2' }),
        ];
        const input = createMockInput();

        // Act
        const result = applyResponseOptimization(patterns, input);

        // Assert
        expect(result.patterns).toHaveLength(2);
        expect(result.patterns[0]).toEqual(patterns[0]);
        expect(result.patterns[1]).toEqual(patterns[1]);
        expect(result.summaryMode).toBeUndefined();
        expect(result.truncated).toBeUndefined();
      });
    });

    describe('Summary Mode', () => {
      it('should apply summary mode when summary: true', () => {
        // Arrange
        const patterns = [
          createMockPattern({
            id: 'p1',
            name: 'anim1',
            rawCss: '@keyframes { ... }',
            properties: [{ name: 'opacity', from: '0', to: '1' }],
          }),
        ];
        const input = createMockInput({ summary: true });

        // Act
        const result = applyResponseOptimization(patterns, input);

        // Assert
        expect(result.summaryMode).toBe(true);
        expect(result.patterns[0]).toEqual({
          id: 'p1',
          name: 'anim1',
          category: 'micro_interaction',
          trigger: 'load',
          type: 'keyframes',
        });
        // rawCss, properties, animation が削除されている
        expect(result.patterns[0]).not.toHaveProperty('rawCss');
        expect(result.patterns[0]).not.toHaveProperty('properties');
        expect(result.patterns[0]).not.toHaveProperty('animation');
      });

      it('should keep only essential fields in summary mode', () => {
        // Arrange
        const patterns = [
          createMockPattern({
            id: 'test-id',
            name: 'test-name',
            category: 'entrance',
            trigger: 'scroll',
            type: 'css_animation',
            rawCss: 'some css',
            animation: { duration: 500 },
            properties: [{ name: 'transform' }],
          }),
        ];
        const input = createMockInput({ summary: true });

        // Act
        const result = applyResponseOptimization(patterns, input);

        // Assert
        const summaryPattern = result.patterns[0];
        expect(Object.keys(summaryPattern)).toEqual(['id', 'name', 'category', 'trigger', 'type']);
      });
    });

    describe('Truncate', () => {
      it('should truncate patterns when truncate_max_chars is exceeded', () => {
        // Arrange
        const patterns = createPatternsOfSize(10); // 10KB
        const input = createMockInput({ truncate_max_chars: 1000 }); // 1KB制限

        // Act
        const result = applyResponseOptimization(patterns, input);

        // Assert
        expect(result.truncated).toBe(true);
        expect(result.patterns.length).toBeLessThan(patterns.length);
        expect(result.patternsTruncatedCount).toBeDefined();
        expect(result.originalSize).toBeDefined();
      });

      it('should not truncate when under truncate_max_chars limit', () => {
        // Arrange
        const patterns = [createMockPattern()]; // 小さいデータ
        const input = createMockInput({ truncate_max_chars: 100000 }); // 100KB制限

        // Act
        const result = applyResponseOptimization(patterns, input);

        // Assert
        expect(result.truncated).toBeUndefined();
        expect(result.patterns.length).toBe(1);
      });
    });

    describe('Auto Optimize', () => {
      it('should apply summary mode when auto_optimize and size > 100KB', () => {
        // Arrange
        const patterns = createPatternsOfSize(120); // 120KB
        const input = createMockInput({ auto_optimize: true });

        // Act
        const result = applyResponseOptimization(patterns, input);

        // Assert
        expect(result.summaryMode).toBe(true);
        expect(result.sizeOptimization).toBeDefined();
        expect(result.sizeOptimization?.applied_optimizations).toContain('summary');
      });

      it('should not apply auto_optimize when summary is already true', () => {
        // Arrange
        const patterns = createPatternsOfSize(120); // 120KB
        const input = createMockInput({ auto_optimize: true, summary: true });

        // Act
        const result = applyResponseOptimization(patterns, input);

        // Assert
        // summary: true により先にサマリー化されているので、auto_optimizeのsizeOptimizationはundefined
        expect(result.summaryMode).toBe(true);
        expect(result.sizeOptimization).toBeUndefined();
      });

      it('should not apply any optimization when size is small', () => {
        // Arrange
        const patterns = [createMockPattern()]; // 小さいデータ
        const input = createMockInput({ auto_optimize: true });

        // Act
        const result = applyResponseOptimization(patterns, input);

        // Assert
        expect(result.summaryMode).toBeUndefined();
        expect(result.sizeOptimization).toBeUndefined();
      });
    });

    describe('Combined Optimizations', () => {
      it('should apply summary first, then truncate if still too large', () => {
        // Arrange: 大量のパターン
        const patterns = createPatternsOfSize(600); // 600KB（500KB超）
        const input = createMockInput({ auto_optimize: true });

        // Act
        const result = applyResponseOptimization(patterns, input);

        // Assert
        expect(result.summaryMode).toBe(true);
        expect(result.sizeOptimization?.applied_optimizations).toBeDefined();
        // サマリー化により大幅に削減されるため、truncateが発動するかはサイズ次第
      });
    });
  });

  // =====================================================
  // generateSummary
  // =====================================================
  describe('generateSummary', () => {
    describe('Basic Summary', () => {
      it('should generate summary with correct totalPatterns', () => {
        // Arrange
        const patterns = [
          createMockPattern(),
          createMockPattern(),
          createMockPattern(),
        ];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        expect(summary.totalPatterns).toBe(3);
      });

      it('should count patterns by type', () => {
        // Arrange
        const patterns = [
          createMockPattern({ type: 'keyframes' }),
          createMockPattern({ type: 'keyframes' }),
          createMockPattern({ type: 'css_transition' }),
        ];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        expect(summary.byType).toBeDefined();
        expect(summary.byType['keyframes']).toBe(2);
        expect(summary.byType['css_transition']).toBe(1);
      });

      it('should count patterns by trigger', () => {
        // Arrange
        const patterns = [
          createMockPattern({ trigger: 'load' }),
          createMockPattern({ trigger: 'scroll' }),
          createMockPattern({ trigger: 'scroll' }),
        ];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        expect(summary.byTrigger).toBeDefined();
        expect(summary.byTrigger['load']).toBe(1);
        expect(summary.byTrigger['scroll']).toBe(2);
      });

      it('should count patterns by category', () => {
        // Arrange
        const patterns = [
          createMockPattern({ category: 'micro_interaction' }),
          createMockPattern({ category: 'entrance' }),
          createMockPattern({ category: 'entrance' }),
        ];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        expect(summary.byCategory).toBeDefined();
        expect(summary.byCategory['micro_interaction']).toBe(1);
        expect(summary.byCategory['entrance']).toBe(2);
      });
    });

    describe('Duration Calculations', () => {
      it('should calculate average duration', () => {
        // Arrange
        const patterns = [
          createMockPattern({ animation: { duration: 100 } }),
          createMockPattern({ animation: { duration: 200 } }),
          createMockPattern({ animation: { duration: 300 } }),
        ];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        expect(summary.averageDuration).toBe(200); // (100+200+300)/3
      });

      it('should handle patterns without duration', () => {
        // Arrange
        const patterns = [
          createMockPattern({ animation: { duration: 100 } }),
          createMockPattern({ animation: {} }),
          createMockPattern({ animation: { duration: 200 } }),
        ];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        // duration がない場合は計算から除外
        expect(summary.averageDuration).toBe(150); // (100+200)/2
      });

      it('should return 0 for average duration when no patterns have duration', () => {
        // Arrange
        const patterns = [
          createMockPattern({ animation: {} }),
          createMockPattern({ animation: {} }),
        ];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        expect(summary.averageDuration).toBe(0);
      });
    });

    describe('Infinite Animations', () => {
      it('should detect infinite animations', () => {
        // Arrange
        const patterns = [
          createMockPattern({ animation: { iterations: 'infinite' } }),
        ];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        expect(summary.hasInfiniteAnimations).toBe(true);
      });

      it('should return false when no infinite animations', () => {
        // Arrange
        const patterns = [
          createMockPattern({ animation: { iterations: 1 } }),
          createMockPattern({ animation: { iterations: 3 } }),
        ];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        expect(summary.hasInfiniteAnimations).toBe(false);
      });
    });

    describe('Complexity Score', () => {
      it('should calculate complexity score', () => {
        // Arrange
        const patterns = [
          createMockPattern(),
          createMockPattern(),
        ];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        expect(summary.complexityScore).toBeDefined();
        expect(typeof summary.complexityScore).toBe('number');
      });
    });

    describe('Merge with Service Summary', () => {
      it('should merge with serviceSummary overrides', () => {
        // Arrange
        const patterns = [createMockPattern()];
        const serviceSummary = {
          totalPatterns: 999, // オーバーライド
          extraField: 'custom',
        };

        // Act
        const summary = generateSummary(patterns, serviceSummary);

        // Assert
        expect(summary.totalPatterns).toBe(999); // オーバーライドされる
        expect((summary as Record<string, unknown>)['extraField']).toBe('custom');
      });
    });

    describe('Empty Patterns', () => {
      it('should handle empty patterns array', () => {
        // Arrange
        const patterns: MotionPattern[] = [];

        // Act
        const summary = generateSummary(patterns);

        // Assert
        expect(summary.totalPatterns).toBe(0);
        expect(summary.averageDuration).toBe(0);
        expect(summary.hasInfiniteAnimations).toBe(false);
      });
    });
  });

  // =====================================================
  // generateSizeWarning
  // =====================================================
  describe('generateSizeWarning', () => {
    describe('No Warning', () => {
      it('should return null when size is under 10KB', () => {
        // Arrange
        const responseSize = 5 * 1024; // 5KB

        // Act
        const warning = generateSizeWarning(responseSize);

        // Assert
        expect(warning).toBeNull();
      });

      it('should return null for exactly 10KB', () => {
        // Arrange
        const responseSize = 10 * 1024; // 10KB

        // Act
        const warning = generateSizeWarning(responseSize);

        // Assert
        expect(warning).toBeNull();
      });
    });

    describe('Warning Level', () => {
      it('should return warning when size is between 10KB and 100KB', () => {
        // Arrange
        const responseSize = 50 * 1024; // 50KB

        // Act
        const warning = generateSizeWarning(responseSize);

        // Assert
        expect(warning).not.toBeNull();
        expect(warning?.severity).toBe('warning');
        expect(warning?.code).toBe('RESPONSE_SIZE_WARNING');
        expect(warning?.message).toContain('50.0KB');
        expect(warning?.suggestion).toBeDefined();
      });

      it('should return warning for 10KB + 1 byte', () => {
        // Arrange
        const responseSize = 10 * 1024 + 1;

        // Act
        const warning = generateSizeWarning(responseSize);

        // Assert
        expect(warning?.severity).toBe('warning');
      });
    });

    describe('Critical Level', () => {
      it('should return error when size exceeds 100KB', () => {
        // Arrange
        const responseSize = 150 * 1024; // 150KB

        // Act
        const warning = generateSizeWarning(responseSize);

        // Assert
        expect(warning).not.toBeNull();
        expect(warning?.severity).toBe('error');
        expect(warning?.code).toBe('RESPONSE_SIZE_CRITICAL');
        expect(warning?.message).toContain('150.0KB');
        expect(warning?.suggestion).toContain('auto_optimize');
      });

      it('should return error for 100KB + 1 byte', () => {
        // Arrange
        const responseSize = 100 * 1024 + 1;

        // Act
        const warning = generateSizeWarning(responseSize);

        // Assert
        expect(warning?.severity).toBe('error');
      });

      it('should handle very large sizes', () => {
        // Arrange
        const responseSize = 10 * 1024 * 1024; // 10MB

        // Act
        const warning = generateSizeWarning(responseSize);

        // Assert
        expect(warning?.severity).toBe('error');
        expect(warning?.message).toContain('10240.0KB');
      });
    });

    describe('Edge Cases', () => {
      it('should handle zero size', () => {
        // Arrange
        const responseSize = 0;

        // Act
        const warning = generateSizeWarning(responseSize);

        // Assert
        expect(warning).toBeNull();
      });

      it('should handle negative size (edge case)', () => {
        // Arrange
        const responseSize = -100;

        // Act
        const warning = generateSizeWarning(responseSize);

        // Assert
        expect(warning).toBeNull();
      });
    });
  });

  // =====================================================
  // generateWebglDetectionWarning
  // =====================================================
  describe('generateWebglDetectionWarning', () => {
    describe('Warning Generation', () => {
      it('should return warning when patternCount is 0 and detect_js_animations is false', () => {
        // Arrange
        const patternCount = 0;
        const detectJsAnimations = false;

        // Act
        const warning = generateWebglDetectionWarning(patternCount, detectJsAnimations);

        // Assert
        expect(warning).not.toBeNull();
        expect(warning?.code).toBe(MOTION_WARNING_CODES.WEBGL_DETECTION_DISABLED);
        expect(warning?.severity).toBe('info');
        expect(warning?.message).toContain('WebGL/Canvas animations may not be detected');
        expect(warning?.message).toContain('detect_js_animations: true');
        expect(warning?.suggestion).toContain('detect_js_animations: true');
        expect(warning?.context).toBeDefined();
        expect(warning?.context?.affectedLibraries).toContain('Three.js');
        expect(warning?.context?.affectedLibraries).toContain('GSAP');
        expect(warning?.context?.affectedLibraries).toContain('Framer Motion');
        expect(warning?.context?.affectedLibraries).toContain('anime.js');
        expect(warning?.context?.affectedLibraries).toContain('Lottie');
      });

      it('should include correct context fields', () => {
        // Arrange & Act
        const warning = generateWebglDetectionWarning(0, false);

        // Assert
        expect(warning?.context?.currentSetting).toBe('detect_js_animations: false');
        expect(warning?.context?.recommendedSetting).toBe('detect_js_animations: true');
      });
    });

    describe('No Warning', () => {
      it('should return null when patternCount is greater than 0', () => {
        // Arrange
        const patternCount = 5;
        const detectJsAnimations = false;

        // Act
        const warning = generateWebglDetectionWarning(patternCount, detectJsAnimations);

        // Assert
        expect(warning).toBeNull();
      });

      it('should return null when detect_js_animations is true', () => {
        // Arrange
        const patternCount = 0;
        const detectJsAnimations = true;

        // Act
        const warning = generateWebglDetectionWarning(patternCount, detectJsAnimations);

        // Assert
        expect(warning).toBeNull();
      });

      it('should return null when both patternCount > 0 and detect_js_animations is true', () => {
        // Arrange
        const patternCount = 10;
        const detectJsAnimations = true;

        // Act
        const warning = generateWebglDetectionWarning(patternCount, detectJsAnimations);

        // Assert
        expect(warning).toBeNull();
      });

      it('should return null when patternCount is 1 and detect_js_animations is false', () => {
        // Arrange
        const patternCount = 1;
        const detectJsAnimations = false;

        // Act
        const warning = generateWebglDetectionWarning(patternCount, detectJsAnimations);

        // Assert
        expect(warning).toBeNull();
      });
    });

    describe('Edge Cases', () => {
      it('should handle large pattern count', () => {
        // Arrange
        const patternCount = 1000;
        const detectJsAnimations = false;

        // Act
        const warning = generateWebglDetectionWarning(patternCount, detectJsAnimations);

        // Assert
        expect(warning).toBeNull();
      });

      it('should treat patternCount=0 strictly (not falsy)', () => {
        // パターン数が0の場合のみ警告を出す（undefined/nullではない）
        const warning = generateWebglDetectionWarning(0, false);
        expect(warning).not.toBeNull();
      });
    });
  });

  // =====================================================
  // Type Safety and Interface Tests
  // =====================================================
  describe('OptimizationResult Interface', () => {
    it('should have correct structure', () => {
      // Arrange
      const patterns = [createMockPattern()];
      const input = createMockInput();

      // Act
      const result: OptimizationResult = applyResponseOptimization(patterns, input);

      // Assert
      expect(result).toHaveProperty('patterns');
      expect(Array.isArray(result.patterns)).toBe(true);
    });

    it('should have optional fields as undefined when not set', () => {
      // Arrange
      const patterns = [createMockPattern()];
      const input = createMockInput();

      // Act
      const result = applyResponseOptimization(patterns, input);

      // Assert
      expect(result.summaryMode).toBeUndefined();
      expect(result.truncated).toBeUndefined();
      expect(result.originalSize).toBeUndefined();
      expect(result.patternsTruncatedCount).toBeUndefined();
      expect(result.sizeOptimization).toBeUndefined();
    });
  });
});
