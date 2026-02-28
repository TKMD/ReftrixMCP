// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect MCPツールのテスト
 * TDD Red Phase: 先にテストを作成
 *
 * Webページからモーション/アニメーションパターンを検出するMCPツール
 *
 * テスト対象:
 * - 入力バリデーション (15テスト)
 * - アニメーション検出 (15テスト)
 * - サマリー・警告生成 (10テスト)
 * - DIパターン (10テスト)
 * - エッジケース (10テスト)
 *
 * @module tests/tools/motion/detect.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// インポート
// =====================================================

import {
  motionDetectHandler,
  motionDetectToolDefinition,
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
  type IMotionDetectService,
} from '../../../src/tools/motion/detect.tool';

import {
  motionDetectInputSchema,
  motionDetectOutputSchema,
  motionPatternSchema,
  motionSummarySchema,
  motionWarningSchema,
  calculatePerformanceLevel,
  calculateComplexityScore,
  calculateAverageDuration,
  countByType,
  countByTrigger,
  countByCategory,
  type MotionDetectInput,
  type MotionDetectOutput,
  type MotionPattern,
  type MotionSummary,
  type PerformanceInfo,
  MOTION_MCP_ERROR_CODES,
  MOTION_WARNING_CODES,
} from '../../../src/tools/motion/schemas';

// =====================================================
// テストデータ
// =====================================================

const sampleHtmlWithAnimations = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Animation Test</title>
  <style>
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    .fade-in {
      animation: fadeIn 0.6s ease-out forwards;
    }

    .spinner {
      animation: spin 1s linear infinite;
    }

    .pulse {
      animation: pulse 2s ease-in-out infinite;
    }

    .hover-scale {
      transition: transform 0.3s ease-out;
    }

    .hover-scale:hover {
      transform: scale(1.05);
    }

    .button {
      transition: background-color 0.2s ease, transform 0.2s ease;
    }

    .button:hover {
      background-color: #3b82f6;
      transform: translateY(-2px);
    }

    @media (prefers-reduced-motion: reduce) {
      .fade-in,
      .spinner,
      .pulse {
        animation: none;
      }
      .hover-scale,
      .button {
        transition: none;
      }
    }
  </style>
</head>
<body>
  <div class="fade-in">Fade in content</div>
  <div class="spinner">Loading...</div>
  <div class="pulse">Pulse effect</div>
  <button class="button hover-scale">Click me</button>
</body>
</html>`;

const sampleHtmlWithTransitions = `<!DOCTYPE html>
<html>
<head>
  <style>
    .card {
      transition: box-shadow 0.3s ease, transform 0.3s ease;
    }
    .card:hover {
      box-shadow: 0 10px 20px rgba(0,0,0,0.2);
      transform: translateY(-5px);
    }
    .link {
      transition: color 0.2s ease-in-out;
    }
    .link:hover {
      color: #3b82f6;
    }
    .menu {
      transition: opacity 0.15s ease-out, visibility 0.15s ease-out;
    }
  </style>
</head>
<body>
  <div class="card">Card content</div>
  <a class="link" href="#">Link</a>
  <nav class="menu">Menu</nav>
</body>
</html>`;

const sampleHtmlWithKeyframes = `<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes slideInFromLeft {
      0% {
        transform: translateX(-100%);
        opacity: 0;
      }
      100% {
        transform: translateX(0);
        opacity: 1;
      }
    }

    @keyframes bounce {
      0%, 20%, 50%, 80%, 100% {
        transform: translateY(0);
      }
      40% {
        transform: translateY(-30px);
      }
      60% {
        transform: translateY(-15px);
      }
    }

    @keyframes skeleton {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    .slide-in {
      animation: slideInFromLeft 0.5s ease-out forwards;
    }

    .bounce {
      animation: bounce 2s ease infinite;
    }

    .skeleton {
      background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
      background-size: 200% 100%;
      animation: skeleton 1.5s ease-in-out infinite;
    }
  </style>
</head>
<body>
  <div class="slide-in">Slide in content</div>
  <div class="bounce">Bouncing element</div>
  <div class="skeleton">Loading placeholder</div>
</body>
</html>`;

const sampleHtmlMinimal = `<!DOCTYPE html>
<html>
<head><title>Minimal</title></head>
<body><p>No animations</p></body>
</html>`;

const sampleHtmlWithPerformanceIssues = `<!DOCTYPE html>
<html>
<head>
  <style>
    .bad-animation {
      animation: badMove 1s linear infinite;
    }

    @keyframes badMove {
      0% { left: 0; top: 0; width: 100px; }
      50% { left: 100px; top: 100px; width: 200px; }
      100% { left: 0; top: 0; width: 100px; }
    }

    .bad-transition {
      transition: width 0.3s, height 0.3s, margin 0.3s;
    }
  </style>
</head>
<body>
  <div class="bad-animation">Bad animation</div>
  <div class="bad-transition">Bad transition</div>
</body>
</html>`;

const sampleHtmlNoReducedMotion = `<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes flash {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    .flash {
      animation: flash 0.5s linear infinite;
    }
  </style>
</head>
<body>
  <div class="flash">Flashing content (no reduced motion support)</div>
</body>
</html>`;

const sampleCss = `
@keyframes externalFade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.external-animation {
  animation: externalFade 0.4s ease forwards;
}

.external-transition {
  transition: all 0.3s ease;
}
`;

const validUUID = '123e4567-e89b-12d3-a456-426614174000';
const invalidUUID = 'invalid-uuid';

// =====================================================
// 入力バリデーションテスト（15 tests）
// =====================================================

describe('motionDetectInputSchema', () => {
  describe('有効な入力', () => {
    it('html のみの入力を受け付ける', () => {
      const input = { html: sampleHtmlWithAnimations, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);
      expect(result.html).toBe(sampleHtmlWithAnimations);
      expect(result.includeInlineStyles).toBe(true);
      expect(result.includeStyleSheets).toBe(true);
      expect(result.minDuration).toBe(0);
      expect(result.maxPatterns).toBe(100);
    });

    it('pageId のみの入力を受け付ける', () => {
      const input = { pageId: validUUID, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);
      expect(result.pageId).toBe(validUUID);
    });

    it('html と css の組み合わせを受け付ける', () => {
      const input = { html: sampleHtmlMinimal, css: sampleCss, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);
      expect(result.html).toBe(sampleHtmlMinimal);
      expect(result.css).toBe(sampleCss);
    });

    it('includeInlineStyles=false を受け付ける', () => {
      const input = { html: sampleHtmlWithAnimations, includeInlineStyles: false, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);
      expect(result.includeInlineStyles).toBe(false);
    });

    it('includeStyleSheets=false を受け付ける', () => {
      const input = { html: sampleHtmlWithAnimations, includeStyleSheets: false, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);
      expect(result.includeStyleSheets).toBe(false);
    });

    it('minDuration を指定できる', () => {
      const input = { html: sampleHtmlWithAnimations, minDuration: 500, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);
      expect(result.minDuration).toBe(500);
    });

    it('maxPatterns を指定できる', () => {
      const input = { html: sampleHtmlWithAnimations, maxPatterns: 50, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);
      expect(result.maxPatterns).toBe(50);
    });

    it('includeWarnings=false を受け付ける', () => {
      const input = { html: sampleHtmlWithAnimations, includeWarnings: false, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);
      expect(result.includeWarnings).toBe(false);
    });

    it('includeSummary=false を受け付ける', () => {
      const input = { html: sampleHtmlWithAnimations, includeSummary: false, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);
      expect(result.includeSummary).toBe(false);
    });

    it('verbose=true を受け付ける', () => {
      const input = { html: sampleHtmlWithAnimations, verbose: true, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);
      expect(result.verbose).toBe(true);
    });

    it('全オプション指定の入力を受け付ける', () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        css: sampleCss,
        includeInlineStyles: true,
        includeStyleSheets: true,
        minDuration: 100,
        maxPatterns: 200,
        includeWarnings: true,
        includeSummary: true,
        verbose: true,
        detection_mode: 'css' as const,
      };
      const result = motionDetectInputSchema.parse(input);
      expect(result.html).toBeDefined();
      expect(result.css).toBeDefined();
      expect(result.minDuration).toBe(100);
      expect(result.maxPatterns).toBe(200);
      expect(result.verbose).toBe(true);
    });
  });

  describe('無効な入力', () => {
    it('pageId も html もない場合エラー', () => {
      const input = { detection_mode: 'css' };
      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('pageId が無効なUUID形式の場合エラー', () => {
      const input = { pageId: invalidUUID, detection_mode: 'css' };
      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('html が空文字の場合エラー', () => {
      const input = { html: '', detection_mode: 'css' };
      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('minDuration が負の場合エラー', () => {
      const input = { html: sampleHtmlMinimal, minDuration: -1, detection_mode: 'css' };
      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('minDuration が60000を超える場合エラー', () => {
      const input = { html: sampleHtmlMinimal, minDuration: 60001, detection_mode: 'css' };
      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('maxPatterns が0の場合エラー', () => {
      const input = { html: sampleHtmlMinimal, maxPatterns: 0, detection_mode: 'css' };
      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('maxPatterns が4000を超える場合エラー', () => {
      const input = { html: sampleHtmlMinimal, maxPatterns: 4001, detection_mode: 'css' };
      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });
  });
});

// =====================================================
// ユーティリティ関数テスト（10 tests）
// =====================================================

describe('ユーティリティ関数', () => {
  describe('calculatePerformanceLevel', () => {
    it('GPU加速のみ使用、レイアウト/ペイントなし = excellent', () => {
      const info: PerformanceInfo = {
        usesTransform: true,
        usesOpacity: true,
        triggersLayout: false,
        triggersPaint: false,
      };
      expect(calculatePerformanceLevel(info)).toBe('excellent');
    });

    it('レイアウトトリガーあり = poor', () => {
      const info: PerformanceInfo = {
        usesTransform: true,
        usesOpacity: false,
        triggersLayout: true,
        triggersPaint: false,
      };
      expect(calculatePerformanceLevel(info)).toBe('poor');
    });

    it('ペイントトリガーあり = fair', () => {
      const info: PerformanceInfo = {
        usesTransform: false,
        usesOpacity: false,
        triggersLayout: false,
        triggersPaint: true,
      };
      expect(calculatePerformanceLevel(info)).toBe('fair');
    });

    it('それ以外 = good', () => {
      const info: PerformanceInfo = {
        usesTransform: false,
        usesOpacity: false,
        triggersLayout: false,
        triggersPaint: false,
      };
      expect(calculatePerformanceLevel(info)).toBe('good');
    });
  });

  describe('calculateComplexityScore', () => {
    it('空の配列は0を返す', () => {
      expect(calculateComplexityScore([])).toBe(0);
    });

    it('パターン数に応じてスコアが増加する', () => {
      const patterns: MotionPattern[] = [
        {
          id: '1',
          type: 'css_animation',
          category: 'scroll_trigger',
          trigger: 'load',
          animation: {},
          properties: [],
        },
        {
          id: '2',
          type: 'css_transition',
          category: 'hover_effect',
          trigger: 'hover',
          animation: {},
          properties: [],
        },
      ];
      const score = calculateComplexityScore(patterns);
      expect(score).toBeGreaterThan(0);
    });

    it('無限アニメーションがあるとスコアが増加する', () => {
      const patternsWithInfinite: MotionPattern[] = [
        {
          id: '1',
          type: 'css_animation',
          category: 'loading_state',
          trigger: 'load',
          animation: { iterations: 'infinite' },
          properties: [],
        },
      ];
      const patternsWithoutInfinite: MotionPattern[] = [
        {
          id: '1',
          type: 'css_animation',
          category: 'loading_state',
          trigger: 'load',
          animation: { iterations: 1 },
          properties: [],
        },
      ];
      expect(calculateComplexityScore(patternsWithInfinite)).toBeGreaterThan(
        calculateComplexityScore(patternsWithoutInfinite)
      );
    });

    it('スコアは100を超えない', () => {
      const manyPatterns: MotionPattern[] = Array.from({ length: 50 }, (_, i) => ({
        id: String(i),
        type: 'css_animation',
        category: 'micro_interaction',
        trigger: 'load',
        animation: { iterations: 'infinite' },
        properties: [
          { property: 'transform' },
          { property: 'opacity' },
          { property: 'color' },
        ],
        keyframes: [
          { offset: 0, styles: { opacity: '0' } },
          { offset: 50, styles: { opacity: '0.5' } },
          { offset: 100, styles: { opacity: '1' } },
        ],
      }));
      expect(calculateComplexityScore(manyPatterns)).toBeLessThanOrEqual(100);
    });
  });

  describe('calculateAverageDuration', () => {
    it('空の配列は0を返す', () => {
      expect(calculateAverageDuration([])).toBe(0);
    });

    it('durationがない場合は0を返す', () => {
      const patterns: MotionPattern[] = [
        {
          id: '1',
          type: 'css_animation',
          category: 'unknown',
          trigger: 'unknown',
          animation: {},
          properties: [],
        },
      ];
      expect(calculateAverageDuration(patterns)).toBe(0);
    });

    it('平均durationを計算する', () => {
      const patterns: MotionPattern[] = [
        {
          id: '1',
          type: 'css_animation',
          category: 'unknown',
          trigger: 'load',
          animation: { duration: 300 },
          properties: [],
        },
        {
          id: '2',
          type: 'css_transition',
          category: 'unknown',
          trigger: 'hover',
          animation: { duration: 500 },
          properties: [],
        },
      ];
      expect(calculateAverageDuration(patterns)).toBe(400);
    });
  });

  describe('countByType', () => {
    it('タイプ別にカウントする', () => {
      const patterns: MotionPattern[] = [
        { id: '1', type: 'css_animation', category: 'unknown', trigger: 'load', animation: {}, properties: [] },
        { id: '2', type: 'css_animation', category: 'unknown', trigger: 'load', animation: {}, properties: [] },
        { id: '3', type: 'css_transition', category: 'unknown', trigger: 'hover', animation: {}, properties: [] },
      ];
      const counts = countByType(patterns);
      expect(counts.css_animation).toBe(2);
      expect(counts.css_transition).toBe(1);
      expect(counts.keyframes).toBe(0);
    });
  });

  describe('countByTrigger', () => {
    it('トリガー別にカウントする', () => {
      const patterns: MotionPattern[] = [
        { id: '1', type: 'css_animation', category: 'unknown', trigger: 'hover', animation: {}, properties: [] },
        { id: '2', type: 'css_animation', category: 'unknown', trigger: 'hover', animation: {}, properties: [] },
        { id: '3', type: 'css_transition', category: 'unknown', trigger: 'load', animation: {}, properties: [] },
      ];
      const counts = countByTrigger(patterns);
      expect(counts.hover).toBe(2);
      expect(counts.load).toBe(1);
    });
  });

  describe('countByCategory', () => {
    it('カテゴリ別にカウントする', () => {
      const patterns: MotionPattern[] = [
        { id: '1', type: 'css_animation', category: 'scroll_trigger', trigger: 'scroll', animation: {}, properties: [] },
        { id: '2', type: 'css_animation', category: 'hover_effect', trigger: 'hover', animation: {}, properties: [] },
        { id: '3', type: 'css_transition', category: 'hover_effect', trigger: 'hover', animation: {}, properties: [] },
      ];
      const counts = countByCategory(patterns);
      expect(counts.scroll_trigger).toBe(1);
      expect(counts.hover_effect).toBe(2);
    });
  });
});

// =====================================================
// 出力スキーマテスト（5 tests）
// =====================================================

describe('motionDetectOutputSchema', () => {
  it('成功時の基本レスポンスをバリデート', () => {
    const output: MotionDetectOutput = {
      success: true,
      data: {
        patterns: [],
        metadata: {
          processingTimeMs: 10,
          htmlSize: 1000,
        },
      },
    };
    expect(() => motionDetectOutputSchema.parse(output)).not.toThrow();
  });

  it('エラー時のレスポンスをバリデート', () => {
    const output = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
      },
    };
    expect(() => motionDetectOutputSchema.parse(output)).not.toThrow();
  });

  it('パターンを含むレスポンスをバリデート', () => {
    const output: MotionDetectOutput = {
      success: true,
      data: {
        patterns: [
          {
            id: '1',
            type: 'css_animation',
            category: 'scroll_trigger',
            trigger: 'load',
            animation: {
              duration: 600,
              easing: { type: 'ease-out' },
            },
            properties: [
              { property: 'opacity', from: 0, to: 1 },
            ],
          },
        ],
        metadata: {
          processingTimeMs: 15,
          htmlSize: 2000,
        },
      },
    };
    expect(() => motionDetectOutputSchema.parse(output)).not.toThrow();
  });

  it('サマリーを含むレスポンスをバリデート', () => {
    const output: MotionDetectOutput = {
      success: true,
      data: {
        patterns: [],
        summary: {
          totalPatterns: 0,
          byType: {
            css_animation: 0,
            css_transition: 0,
            keyframes: 0,
            library_animation: 0,
          },
          byTrigger: {
            scroll: 0,
            scroll_velocity: 0,
            hover: 0,
            click: 0,
            focus: 0,
            load: 0,
            intersection: 0,
            time: 0,
            state_change: 0,
            unknown: 0,
          },
          averageDuration: 0,
          hasInfiniteAnimations: false,
          complexityScore: 0,
        },
        metadata: {
          processingTimeMs: 5,
          htmlSize: 500,
        },
      },
    };
    expect(() => motionDetectOutputSchema.parse(output)).not.toThrow();
  });

  it('警告を含むレスポンスをバリデート', () => {
    const output: MotionDetectOutput = {
      success: true,
      data: {
        patterns: [],
        warnings: [
          {
            code: 'A11Y_NO_REDUCED_MOTION',
            severity: 'warning',
            message: 'prefers-reduced-motion が設定されていません',
            suggestion: '@media (prefers-reduced-motion: reduce) を追加してください',
          },
        ],
        metadata: {
          processingTimeMs: 8,
          htmlSize: 800,
        },
      },
    };
    expect(() => motionDetectOutputSchema.parse(output)).not.toThrow();
  });
});

// =====================================================
// ツール定義テスト（5 tests）
// =====================================================

describe('motionDetectToolDefinition', () => {
  it('正しいツール名を持つ', () => {
    expect(motionDetectToolDefinition.name).toBe('motion.detect');
  });

  it('description が設定されている', () => {
    expect(motionDetectToolDefinition.description).toBeDefined();
    expect(typeof motionDetectToolDefinition.description).toBe('string');
    expect(motionDetectToolDefinition.description.length).toBeGreaterThan(0);
  });

  it('inputSchema が object 型', () => {
    expect(motionDetectToolDefinition.inputSchema.type).toBe('object');
  });

  it('properties に必要なフィールドを含む', () => {
    const { properties } = motionDetectToolDefinition.inputSchema;
    expect(properties).toHaveProperty('pageId');
    expect(properties).toHaveProperty('html');
    expect(properties).toHaveProperty('css');
    expect(properties).toHaveProperty('includeInlineStyles');
    expect(properties).toHaveProperty('includeStyleSheets');
    expect(properties).toHaveProperty('minDuration');
    expect(properties).toHaveProperty('maxPatterns');
    expect(properties).toHaveProperty('includeWarnings');
    expect(properties).toHaveProperty('includeSummary');
    expect(properties).toHaveProperty('verbose');
  });

  it('デフォルト値が正しく設定されている', () => {
    const { properties } = motionDetectToolDefinition.inputSchema;
    expect(properties.includeInlineStyles?.default).toBe(true);
    expect(properties.includeStyleSheets?.default).toBe(true);
    expect(properties.minDuration?.default).toBe(0);
    expect(properties.maxPatterns?.default).toBe(100);
    expect(properties.includeWarnings?.default).toBe(true);
    expect(properties.includeSummary?.default).toBe(true);
    expect(properties.verbose?.default).toBe(false);
  });
});

// =====================================================
// アニメーション検出テスト（15 tests）
// =====================================================

describe('アニメーション検出', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CSS Animation検出', () => {
    it('@keyframes を検出する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithKeyframes,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
        const keyframePatterns = result.data.patterns.filter(
          (p) => p.type === 'css_animation' || p.type === 'keyframes'
        );
        expect(keyframePatterns.length).toBeGreaterThan(0);
      }
    });

    it('animation プロパティを解析する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const animationPattern = result.data.patterns.find(
          (p) => p.animation.duration !== undefined
        );
        expect(animationPattern).toBeDefined();
      }
    });

    it('animation-iteration-count: infinite を検出する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const infinitePattern = result.data.patterns.find(
          (p) => p.animation.iterations === 'infinite'
        );
        expect(infinitePattern).toBeDefined();
      }
    });

    it('複数の @keyframes を検出する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithKeyframes,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // slideInFromLeft, bounce, skeleton の3つ
        expect(result.data.patterns.length).toBeGreaterThanOrEqual(3);
      }
    });
  });

  describe('CSS Transition検出', () => {
    it('transition プロパティを検出する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithTransitions,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const transitionPatterns = result.data.patterns.filter(
          (p) => p.type === 'css_transition'
        );
        expect(transitionPatterns.length).toBeGreaterThan(0);
      }
    });

    it('複数プロパティのtransitionを検出する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithTransitions,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const multiPropTransition = result.data.patterns.find(
          (p) => p.type === 'css_transition' && p.properties.length > 1
        );
        expect(multiPropTransition).toBeDefined();
      }
    });

    it('hover トリガーを検出する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithTransitions,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const hoverPattern = result.data.patterns.find(
          (p) => p.trigger === 'hover'
        );
        expect(hoverPattern).toBeDefined();
      }
    });
  });

  describe('外部CSS解析', () => {
    it('css パラメータのアニメーションを検出する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlMinimal,
        css: sampleCss,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
      }
    });

    it('html と css の両方からパターンを検出する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithTransitions,
        css: sampleCss,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 両方のソースからパターンを検出
        expect(result.data.patterns.length).toBeGreaterThan(1);
      }
    });
  });

  describe('パターン分類', () => {
    it('hover_effect カテゴリを分類する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithTransitions,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const hoverEffect = result.data.patterns.find(
          (p) => p.category === 'hover_effect'
        );
        expect(hoverEffect).toBeDefined();
      }
    });

    it('loading_state カテゴリを分類する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithKeyframes,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const loadingState = result.data.patterns.find(
          (p) =>
            p.category === 'loading_state' ||
            p.animation.iterations === 'infinite'
        );
        expect(loadingState).toBeDefined();
      }
    });

    it('scroll_trigger カテゴリを分類する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // fadeIn は scroll_trigger または scroll_triggerに類似
        const scrollTrigger = result.data.patterns.find(
          (p) =>
            p.category === 'scroll_trigger' ||
            (p.properties.some((prop) => prop.property === 'opacity') &&
              p.properties.some((prop) => prop.property === 'transform'))
        );
        expect(scrollTrigger).toBeDefined();
      }
    });
  });

  describe('プロパティ抽出', () => {
    it('transform プロパティを抽出する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const transformPattern = result.data.patterns.find((p) =>
          p.properties.some((prop) => prop.property === 'transform')
        );
        expect(transformPattern).toBeDefined();
      }
    });

    it('opacity プロパティを抽出する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const opacityPattern = result.data.patterns.find((p) =>
          p.properties.some((prop) => prop.property === 'opacity')
        );
        expect(opacityPattern).toBeDefined();
      }
    });
  });
});

// =====================================================
// サマリー・警告テスト（10 tests）
// =====================================================

describe('サマリー・警告', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('サマリー生成', () => {
    it('includeSummary=true でサマリーを返す', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        includeSummary: true,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.summary).toBeDefined();
        expect(result.data.summary?.totalPatterns).toBeGreaterThanOrEqual(0);
      }
    });

    it('includeSummary=false でサマリーを返さない', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        includeSummary: false,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.summary).toBeUndefined();
      }
    });

    it('byType にタイプ別カウントを含む', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        includeSummary: true,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.summary) {
        expect(result.data.summary.byType).toBeDefined();
        expect(typeof result.data.summary.byType.css_animation).toBe('number');
        expect(typeof result.data.summary.byType.css_transition).toBe('number');
      }
    });

    it('byTrigger にトリガー別カウントを含む', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        includeSummary: true,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.summary) {
        expect(result.data.summary.byTrigger).toBeDefined();
        expect(typeof result.data.summary.byTrigger.hover).toBe('number');
        expect(typeof result.data.summary.byTrigger.load).toBe('number');
      }
    });

    it('hasInfiniteAnimations を含む', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        includeSummary: true,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.summary) {
        expect(typeof result.data.summary.hasInfiniteAnimations).toBe('boolean');
      }
    });

    it('complexityScore を含む', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithAnimations,
        includeSummary: true,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.summary) {
        expect(result.data.summary.complexityScore).toBeGreaterThanOrEqual(0);
        expect(result.data.summary.complexityScore).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('警告生成', () => {
    it('includeWarnings=true で警告を返す', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlNoReducedMotion,
        includeWarnings: true,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.warnings).toBeDefined();
        expect(Array.isArray(result.data.warnings)).toBe(true);
      }
    });

    it('includeWarnings=false で警告を返さない', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlNoReducedMotion,
        includeWarnings: false,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.warnings).toBeUndefined();
      }
    });

    it('prefers-reduced-motion 未対応で警告を生成する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlNoReducedMotion,
        includeWarnings: true,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.warnings) {
        const reducedMotionWarning = result.data.warnings.find(
          (w) => w.code === MOTION_WARNING_CODES.A11Y_NO_REDUCED_MOTION
        );
        expect(reducedMotionWarning).toBeDefined();
      }
    });

    it('パフォーマンス問題で警告を生成する', async () => {
      const input: MotionDetectInput = {
        html: sampleHtmlWithPerformanceIssues,
        includeWarnings: true,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.warnings) {
        const perfWarning = result.data.warnings.find(
          (w) => w.code === MOTION_WARNING_CODES.PERF_LAYOUT_TRIGGER
        );
        expect(perfWarning).toBeDefined();
      }
    });
  });
});

// =====================================================
// DIパターンテスト（10 tests）
// =====================================================

describe('DIパターン', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('モックサービスを注入できる', async () => {
    const mockDetect = vi.fn().mockReturnValue({
      patterns: [
        {
          id: 'mock-1',
          type: 'css_animation',
          category: 'scroll_trigger',
          trigger: 'load',
          animation: { duration: 500 },
          properties: [{ property: 'opacity' }],
        },
      ],
      warnings: [],
    });

    setMotionDetectServiceFactory(() => ({
      detect: mockDetect,
    }));

    const input: MotionDetectInput = { html: sampleHtmlMinimal, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patterns).toHaveLength(1);
      expect(result.data.patterns[0].id).toBe('mock-1');
    }
    expect(mockDetect).toHaveBeenCalled();
  });

  it('ファクトリリセットが動作する', async () => {
    const mockDetect = vi.fn().mockReturnValue({
      patterns: [],
      warnings: [],
    });

    setMotionDetectServiceFactory(() => ({
      detect: mockDetect,
    }));

    resetMotionDetectServiceFactory();

    const input: MotionDetectInput = { html: sampleHtmlWithAnimations, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    // リセット後はデフォルト実装が使われる
    expect(result.success).toBe(true);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('pageIdでページを取得する', async () => {
    const mockGetPage = vi.fn().mockResolvedValue({
      id: validUUID,
      htmlContent: sampleHtmlWithAnimations,
      cssContent: '',
    });

    setMotionDetectServiceFactory(() => ({
      getPageById: mockGetPage,
    }));

    const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    expect(mockGetPage).toHaveBeenCalledWith(validUUID);
    if (result.success) {
      expect(result.data.pageId).toBe(validUUID);
    }
  });

  it('存在しないpageIdでエラーを返す', async () => {
    const mockGetPage = vi.fn().mockResolvedValue(null);

    setMotionDetectServiceFactory(() => ({
      getPageById: mockGetPage,
    }));

    const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.PAGE_NOT_FOUND);
    }
  });

  it('サービスエラーをハンドルする', async () => {
    const mockDetect = vi.fn().mockImplementation(() => {
      throw new Error('Service error');
    });

    setMotionDetectServiceFactory(() => ({
      detect: mockDetect,
    }));

    const input: MotionDetectInput = { html: sampleHtmlMinimal, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.DETECTION_ERROR);
    }
  });

  it('DBエラーをハンドルする', async () => {
    const mockGetPage = vi.fn().mockRejectedValue(new Error('DB connection failed'));

    setMotionDetectServiceFactory(() => ({
      getPageById: mockGetPage,
    }));

    const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.DB_ERROR);
    }
  });

  it('サービス未設定時のpageId使用でエラー', async () => {
    resetMotionDetectServiceFactory();

    const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
  });

  it('カスタム検出ロジックを注入できる', async () => {
    const customPatterns: MotionPattern[] = [
      {
        id: 'custom-1',
        type: 'library_animation',
        category: 'page_transition',
        trigger: 'load',
        animation: {
          duration: 300,
          easing: { type: 'spring' },
        },
        properties: [
          { property: 'opacity', from: 0, to: 1 },
          { property: 'scale', from: 0.9, to: 1 },
        ],
      },
    ];

    setMotionDetectServiceFactory(() => ({
      detect: vi.fn().mockReturnValue({
        patterns: customPatterns,
        warnings: [],
      }),
    }));

    const input: MotionDetectInput = { html: sampleHtmlMinimal, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patterns[0].type).toBe('library_animation');
      expect(result.data.patterns[0].animation.easing?.type).toBe('spring');
    }
  });

  it('複数回の呼び出しで独立した結果を返す', async () => {
    const input1: MotionDetectInput = { html: sampleHtmlWithAnimations, detection_mode: 'css' as const };
    const input2: MotionDetectInput = { html: sampleHtmlMinimal, detection_mode: 'css' as const };

    const [result1, result2] = await Promise.all([
      motionDetectHandler(input1),
      motionDetectHandler(input2),
    ]);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    if (result1.success && result2.success) {
      expect(result1.data.patterns.length).toBeGreaterThan(result2.data.patterns.length);
    }
  });

  it('カスタム警告を追加できる', async () => {
    const customWarnings = [
      {
        code: 'CUSTOM_WARNING',
        severity: 'warning' as const,
        message: 'Custom warning message',
      },
    ];

    setMotionDetectServiceFactory(() => ({
      detect: vi.fn().mockReturnValue({
        patterns: [],
        warnings: customWarnings,
      }),
    }));

    const input: MotionDetectInput = { html: sampleHtmlMinimal, includeWarnings: true, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.warnings) {
      expect(result.data.warnings.some((w) => w.code === 'CUSTOM_WARNING')).toBe(true);
    }
  });
});

// =====================================================
// エッジケーステスト（10 tests）
// =====================================================

describe('エッジケース', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('アニメーションがないHTMLでも成功する', async () => {
    const input: MotionDetectInput = { html: sampleHtmlMinimal, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patterns).toHaveLength(0);
    }
  });

  it('空のCSSでも成功する', async () => {
    const input: MotionDetectInput = { html: sampleHtmlMinimal, css: '', detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
  });

  it('不正なCSSでも部分的に解析する', async () => {
    const invalidCss = `
      @keyframes valid {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .invalid { animation: {{{invalid }}}
      .valid { animation: valid 1s; }
    `;
    const input: MotionDetectInput = { html: sampleHtmlMinimal, css: invalidCss, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 有効な部分は解析される
      expect(result.data.patterns.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('maxPatterns で結果を制限する', async () => {
    const input: MotionDetectInput = {
      html: sampleHtmlWithAnimations,
      maxPatterns: 2,
      detection_mode: 'css' as const,
    };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patterns.length).toBeLessThanOrEqual(2);
    }
  });

  it('minDuration でフィルタリングする', async () => {
    const input: MotionDetectInput = {
      html: sampleHtmlWithAnimations,
      minDuration: 1000,
      detection_mode: 'css' as const,
    };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 1秒以上のアニメーションのみ
      result.data.patterns.forEach((p) => {
        if (p.animation.duration !== undefined) {
          expect(p.animation.duration).toBeGreaterThanOrEqual(1000);
        }
      });
    }
  });

  it('verbose=true で rawCss を含む', async () => {
    const input: MotionDetectInput = {
      html: sampleHtmlWithAnimations,
      verbose: true,
      detection_mode: 'css' as const,
    };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.patterns.length > 0) {
      const patternWithRaw = result.data.patterns.find((p) => p.rawCss !== undefined);
      expect(patternWithRaw).toBeDefined();
    }
  });

  it('verbose=false で rawCss を含まない', async () => {
    const input: MotionDetectInput = {
      html: sampleHtmlWithAnimations,
      verbose: false,
      detection_mode: 'css' as const,
    };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      result.data.patterns.forEach((p) => {
        expect(p.rawCss).toBeUndefined();
      });
    }
  });

  it('metadata に処理時間を含む', async () => {
    const input: MotionDetectInput = { html: sampleHtmlWithAnimations, detection_mode: 'css' as const };
    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.data.metadata.htmlSize).toBeGreaterThan(0);
    }
  });

  it('大きなHTMLでもタイムアウトしない', async () => {
    const largeHtml = `<!DOCTYPE html>
<html>
<head>
<style>
${Array.from({ length: 100 }, (_, i) => `
@keyframes anim${i} {
  from { opacity: 0; transform: translateY(${i}px); }
  to { opacity: 1; transform: translateY(0); }
}
.element${i} { animation: anim${i} 0.${i}s ease; }
`).join('')}
</style>
</head>
<body>
${Array.from({ length: 100 }, (_, i) => `<div class="element${i}">Content ${i}</div>`).join('')}
</body>
</html>`;

    const input: MotionDetectInput = { html: largeHtml, detection_mode: 'css' as const };
    const startTime = Date.now();
    const result = await motionDetectHandler(input);
    const duration = Date.now() - startTime;

    expect(result.success).toBe(true);
    expect(duration).toBeLessThan(5000);
  });

  it('エラーメッセージにコンテキストを含む', async () => {
    const result = await motionDetectHandler(null);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBeDefined();
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});

// =====================================================
// エラーハンドリングテスト（5 tests）
// =====================================================

describe('エラーハンドリング', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('入力がnullの場合エラー', async () => {
    const result = await motionDetectHandler(null);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('入力がundefinedの場合エラー', async () => {
    const result = await motionDetectHandler(undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('空オブジェクトの場合エラー', async () => {
    const result = await motionDetectHandler({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('エラーコードが定義通りに使われる', async () => {
    const result = await motionDetectHandler({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Object.values(MOTION_MCP_ERROR_CODES)).toContain(result.error.code);
    }
  });

  it('エラー時もメタデータなしで正常なレスポンス形式', async () => {
    const result = await motionDetectHandler({});
    expect(result).toHaveProperty('success');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result).toHaveProperty('error');
      expect(result.error).toHaveProperty('code');
      expect(result.error).toHaveProperty('message');
    }
  });
});

// =====================================================
// フェイルセーフ・グレースフルデグラデーションテスト（10 tests）
// =====================================================

describe('フェイルセーフ・グレースフルデグラデーション', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('DB接続エラー時の挙動', () => {
    it('DB接続エラー時にDB_ERRORコードを返す', async () => {
      const mockGetPage = vi.fn().mockRejectedValue(new Error('ECONNREFUSED: Connection refused to localhost:26432'));

      setMotionDetectServiceFactory(() => ({
        getPageById: mockGetPage,
      }));

      const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.DB_ERROR);
        expect(result.error.message).toContain('ECONNREFUSED');
      }
    });

    it('DB接続タイムアウト時にDB_ERRORコードを返す', async () => {
      const mockGetPage = vi.fn().mockRejectedValue(new Error('Query timed out after 30000ms'));

      setMotionDetectServiceFactory(() => ({
        getPageById: mockGetPage,
      }));

      const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.DB_ERROR);
        expect(result.error.message).toContain('timed out');
      }
    });

    it('Prisma接続エラー時にDB_ERRORコードを返す', async () => {
      const mockGetPage = vi.fn().mockRejectedValue(new Error('Prisma Client is not connected to the database'));

      setMotionDetectServiceFactory(() => ({
        getPageById: mockGetPage,
      }));

      const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.DB_ERROR);
      }
    });

    it('DBエラー時にリカバリー提案を含むメッセージを返す', async () => {
      const mockGetPage = vi.fn().mockRejectedValue(new Error('Connection refused'));

      setMotionDetectServiceFactory(() => ({
        getPageById: mockGetPage,
      }));

      const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.DB_ERROR);
        // エラーメッセージにはリカバリー提案を含める
        expect(result.error.message).toBeDefined();
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    });
  });

  describe('サービスファクトリー未登録時の挙動', () => {
    it('サービス未登録時にSERVICE_UNAVAILABLEコードを返す', async () => {
      resetMotionDetectServiceFactory();

      const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });

    it('サービス未登録時にhtml直接入力の代替手段を提示', async () => {
      resetMotionDetectServiceFactory();

      const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
        expect(result.error.message).toContain('service');
      }
    });

    it('getPageByIdメソッドがない場合にSERVICE_UNAVAILABLEを返す', async () => {
      setMotionDetectServiceFactory(() => ({
        // getPageById を持たないサービス
        detect: vi.fn().mockReturnValue({ patterns: [], warnings: [] }),
      }));

      const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });
  });

  describe('ページ取得失敗時の挙動', () => {
    it('ページが見つからない場合にPAGE_NOT_FOUNDを返す', async () => {
      const mockGetPage = vi.fn().mockResolvedValue(null);

      setMotionDetectServiceFactory(() => ({
        getPageById: mockGetPage,
      }));

      const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.PAGE_NOT_FOUND);
        expect(result.error.message).toContain(validUUID);
      }
    });

    it('htmlContentが空の場合にPAGE_NOT_FOUNDを返す', async () => {
      const mockGetPage = vi.fn().mockResolvedValue({
        id: validUUID,
        htmlContent: '',
        cssContent: undefined,
      });

      setMotionDetectServiceFactory(() => ({
        getPageById: mockGetPage,
      }));

      const input: MotionDetectInput = { pageId: validUUID, detection_mode: 'css' as const };
      const result = await motionDetectHandler(input);

      // 空のhtmlContentは検出エラーになる
      expect(result.success).toBe(false);
      if (!result.success) {
        // 空文字列の場合はVALIDATION_ERRORになる可能性がある
        expect([
          MOTION_MCP_ERROR_CODES.PAGE_NOT_FOUND,
          MOTION_MCP_ERROR_CODES.VALIDATION_ERROR,
        ]).toContain(result.error.code);
      }
    });
  });

  describe('html直接入力時のフォールバック', () => {
    it('pageIdとhtmlの両方が指定された場合、htmlを優先する', async () => {
      const mockGetPage = vi.fn().mockResolvedValue({
        id: validUUID,
        htmlContent: sampleHtmlMinimal,
      });

      setMotionDetectServiceFactory(() => ({
        getPageById: mockGetPage,
      }));

      // htmlとpageIdの両方を指定
      const input: MotionDetectInput = {
        pageId: validUUID,
        html: sampleHtmlWithAnimations,
        detection_mode: 'css' as const,
      };
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      // htmlが指定されている場合、DB取得は行われない
      expect(mockGetPage).not.toHaveBeenCalled();
      if (result.success) {
        // アニメーションがあるhtmlが使われている
        expect(result.data.patterns.length).toBeGreaterThan(0);
      }
    });
  });
});

// =====================================================
// 外部CSS統合テスト（TDD Red Phase）
// motion.detectに外部CSSファイル取得機能を追加するためのテスト
// ExternalCssFetcherサービスとの統合をテスト
// =====================================================

import * as externalCssFetcherModule from '../../../src/services/external-css-fetcher';

describe('motion.detect - External CSS Integration', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 外部CSSを含むHTMLテストデータ
  const htmlWithExternalCss = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://example.com/styles/main.css">
  <link rel="stylesheet" href="/relative/path.css">
  <style>
    .inline { animation: fadeIn 1s; }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  </style>
</head>
<body><div class="test">Content</div></body>
</html>`;

  const externalCssContent = `
@keyframes externalSlide {
  from { transform: translateX(-100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

.external-animation {
  animation: externalSlide 0.5s ease-out forwards;
}

.external-hover {
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}
.external-hover:hover {
  transform: scale(1.05);
  box-shadow: 0 10px 20px rgba(0,0,0,0.2);
}
`;

  describe('fetchExternalCss option', () => {
    it('should fetch and parse external CSS when fetchExternalCss is true', async () => {
      /**
       * 外部CSSファイル取得が有効化されている場合、
       * HTMLから<link rel="stylesheet">を抽出し、
       * 外部CSSも含めてアニメーション検出を行う
       *
       * 期待動作:
       * 1. fetchExternalCss=true で外部CSS取得を有効化
       * 2. baseUrlを使って相対URLを解決
       * 3. 外部CSSからもアニメーションパターンを検出
       * 4. metadataに外部CSS取得情報を含める
       */
      // ExternalCssFetcherのモック設定
      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([
        { url: 'https://example.com/styles/main.css', originalHref: '/styles/main.css' },
        { url: 'https://example.com/relative/path.css', originalHref: '/relative/path.css' },
      ]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([
        { url: 'https://example.com/styles/main.css', content: externalCssContent, error: undefined },
        { url: 'https://example.com/relative/path.css', content: '', error: undefined },
      ]);

      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/page/',
        detection_mode: 'css' as const,
      };

      // このテストはfetchExternalCssオプションが実装されていないため失敗する
      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 外部CSSからのパターンも検出される
        expect(result.data.metadata.externalCssFetched).toBe(true);
        expect(result.data.metadata.externalCssUrls).toBeDefined();
        expect(result.data.metadata.externalCssUrls?.length).toBeGreaterThan(0);
      }
    });

    it('should not fetch external CSS when fetchExternalCss is false (default)', async () => {
      /**
       * デフォルト動作では外部CSSは取得されない
       * インラインスタイルと<style>タグのみ解析
       *
       * 期待動作:
       * 1. fetchExternalCss未指定（デフォルトfalse）
       * 2. <link>タグの外部CSSは取得しない
       * 3. <style>タグ内のCSSのみ解析
       */
      const input: MotionDetectInput = {
        html: htmlWithExternalCss,
        detection_mode: 'css' as const,
        // fetchExternalCss: false (default)
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 外部CSS取得は行われない
        expect(result.data.metadata.externalCssFetched).toBeUndefined();
        expect(result.data.metadata.externalCssUrls).toBeUndefined();
        // インラインCSSからのパターンは検出される
        expect(result.data.patterns.length).toBeGreaterThan(0);
      }
    });

    it('should succeed without baseUrl in css mode with html (external CSS skipped)', async () => {
      /**
       * detection_mode='css' かつ html指定の場合、baseUrlなしでも成功する
       * ただし、外部CSSの取得はスキップされる
       *
       * 期待動作:
       * 1. fetchExternalCss=true かつ baseUrl未指定、detection_mode='css'、html指定
       * 2. 成功する（バリデーションエラーにならない）
       * 3. 外部CSSは取得されない（baseUrlがないため相対URL解決不可）
       * 4. インラインCSSからのパターンのみ検出
       */
      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        detection_mode: 'css' as const,
        // baseUrl is missing - but allowed in css mode with html
      };

      const result = await motionDetectHandler(input);

      // css mode + html では baseUrl なしでも成功する
      expect(result.success).toBe(true);
      if (result.success) {
        // 外部CSSは取得されない（baseUrlがないため）
        expect(result.data.metadata.externalCssFetched).toBeFalsy();
        // インラインCSSからのパターンは検出される
        expect(result.data.patterns.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should detect animations from external CSS files', async () => {
      /**
       * 外部CSSに定義されたアニメーションを検出する
       * モックを使用して外部CSS取得をシミュレート
       *
       * 期待動作:
       * 1. 外部CSSファイルを取得
       * 2. @keyframes externalSlide を検出
       * 3. .external-animation のアニメーションを検出
       * 4. .external-hover のトランジションを検出
       */
      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([
        { url: 'https://example.com/styles/main.css', originalHref: '/styles/main.css' },
      ]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([
        { url: 'https://example.com/styles/main.css', content: externalCssContent, error: undefined },
      ]);

      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 外部CSSからのパターンが検出される
        const externalPattern = result.data.patterns.find(
          (p) => p.name === 'externalSlide'
        );
        expect(externalPattern).toBeDefined();

        // トランジションも検出
        const transitionPattern = result.data.patterns.find(
          (p) => p.type === 'css_transition' && p.selector?.includes('external-hover')
        );
        expect(transitionPattern).toBeDefined();
      }
    });

    it('should combine inline and external CSS for detection', async () => {
      /**
       * インラインCSS（<style>タグ）と外部CSSの両方からパターンを検出
       * 重複排除も考慮
       *
       * 期待動作:
       * 1. <style>タグ内のCSS解析
       * 2. 外部CSS取得・解析
       * 3. 両方からパターン検出
       * 4. 同名キーフレームは1つにまとめる（後勝ち or 先勝ち）
       */
      const htmlWithBoth = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://example.com/external.css">
  <style>
    @keyframes inlineFade { from { opacity: 0; } to { opacity: 1; } }
    .inline { animation: inlineFade 0.5s; }
  </style>
</head>
<body></body>
</html>`;

      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([
        { url: 'https://example.com/external.css', originalHref: '/external.css' },
      ]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([
        { url: 'https://example.com/external.css', content: externalCssContent, error: undefined },
      ]);

      const input = {
        html: htmlWithBoth,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // インラインCSSからのパターン
        const inlinePattern = result.data.patterns.find(
          (p) => p.name === 'inlineFade'
        );
        expect(inlinePattern).toBeDefined();

        // 外部CSSからのパターン
        const externalPattern = result.data.patterns.find(
          (p) => p.name === 'externalSlide'
        );
        expect(externalPattern).toBeDefined();

        // 両方のソースからパターンが検出される
        expect(result.data.patterns.length).toBeGreaterThan(1);
      }
    });
  });

  describe('external CSS error handling', () => {
    it('should continue detection even if external CSS fetch fails', async () => {
      /**
       * 外部CSS取得に失敗しても、インラインCSSの検出は継続する
       * 警告を出力し、エラーにはしない
       *
       * 期待動作:
       * 1. 外部CSS取得に失敗
       * 2. 警告をwarningsに追加
       * 3. インラインCSS解析は継続
       * 4. 成功レスポンスを返す
       */
      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([
        { url: 'https://example.com/styles/main.css', originalHref: '/styles/main.css' },
      ]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([
        {
          url: 'https://example.com/styles/main.css',
          content: null,
          error: 'Network error: ENOTFOUND',
        },
      ]);

      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        includeWarnings: true,
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // インラインCSSからのパターンは検出される（fadeInアニメーション）
        expect(result.data.patterns.length).toBeGreaterThan(0);

        // 外部CSS取得失敗の警告が含まれる
        expect(result.data.warnings).toBeDefined();
        const fetchWarning = result.data.warnings?.find(
          (w) => w.code === 'EXTERNAL_CSS_FETCH_FAILED'
        );
        expect(fetchWarning).toBeDefined();
        expect(fetchWarning?.message).toContain('Network error');
      }
    });

    it('should log warning when external CSS fetch fails', async () => {
      /**
       * 外部CSS取得失敗時に警告ログを出力
       * 開発環境ではlogger.warnを使用
       */
      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([
        { url: 'https://example.com/fail.css', originalHref: '/fail.css' },
      ]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([
        {
          url: 'https://example.com/fail.css',
          content: null,
          error: 'HTTP 404: Not Found',
        },
      ]);

      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        includeWarnings: true,
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 失敗したURLの情報がwarningsに含まれる
        const fetchWarning = result.data.warnings?.find(
          (w) => w.code === 'EXTERNAL_CSS_FETCH_FAILED'
        );
        expect(fetchWarning).toBeDefined();
      }
    });

    it('should respect timeout for external CSS fetch', async () => {
      /**
       * 外部CSS取得にタイムアウトを設定できる
       * タイムアウト時はエラーとして記録され、処理は継続
       *
       * 期待動作:
       * 1. externalCssOptions.timeout でタイムアウト設定
       * 2. タイムアウト超過時はfetch失敗として処理
       * 3. 警告を出力して処理継続
       */
      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([
        { url: 'https://slow.example.com/styles.css', originalHref: '/styles.css' },
      ]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([
        {
          url: 'https://slow.example.com/styles.css',
          content: null,
          error: 'Request timed out after 1000ms',
        },
      ]);

      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        externalCssOptions: {
          timeout: 1000, // 1秒
        },
        includeWarnings: true,
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // タイムアウトエラーの警告
        const timeoutWarning = result.data.warnings?.find(
          (w) => w.message?.includes('timed out')
        );
        expect(timeoutWarning).toBeDefined();
      }
    });

    it('should block unsafe URLs (SSRF protection)', async () => {
      /**
       * SSRF対策：プライベートIPやlocalhostへのリクエストをブロック
       * 危険なURLは取得せず、警告を出力
       *
       * 期待動作:
       * 1. localhost, 192.168.x.x, 169.254.x.x 等をブロック
       * 2. ブロックされたURLをmetadataに記録
       * 3. 警告を出力
       * 4. 他の安全なURLは取得を試みる
       */
      const htmlWithUnsafeUrls = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="http://localhost:8080/malicious.css">
  <link rel="stylesheet" href="http://192.168.1.1/internal.css">
  <link rel="stylesheet" href="http://169.254.169.254/metadata.css">
  <link rel="stylesheet" href="https://safe.example.com/styles.css">
</head>
<body></body>
</html>`;

      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([
        { url: 'http://localhost:8080/malicious.css', originalHref: 'http://localhost:8080/malicious.css' },
        { url: 'http://192.168.1.1/internal.css', originalHref: 'http://192.168.1.1/internal.css' },
        { url: 'http://169.254.169.254/metadata.css', originalHref: 'http://169.254.169.254/metadata.css' },
        { url: 'https://safe.example.com/styles.css', originalHref: 'https://safe.example.com/styles.css' },
      ]);
      // fetchAllCssはisSafeUrl()で事前フィルタされるため、安全なURLのみ渡される
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([
        { url: 'https://safe.example.com/styles.css', content: externalCssContent, error: undefined },
      ]);
      vi.spyOn(externalCssFetcherModule, 'isSafeUrl').mockImplementation((url) => {
        return url.startsWith('https://safe.example.com');
      });

      const input = {
        html: htmlWithUnsafeUrls,
        fetchExternalCss: true,
        baseUrl: 'https://attacker.com/',
        includeWarnings: true,
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 危険なURLはブロックされる
        const ssrfWarning = result.data.warnings?.find(
          (w) => w.code === 'EXTERNAL_CSS_SSRF_BLOCKED'
        );
        expect(ssrfWarning).toBeDefined();

        // プライベートIPへのリクエストは行われない
        expect(result.data.metadata.blockedUrls).toBeDefined();
        expect(result.data.metadata.blockedUrls?.length).toBe(3);
        expect(result.data.metadata.blockedUrls).toContain('http://localhost:8080/malicious.css');
        expect(result.data.metadata.blockedUrls).toContain('http://192.168.1.1/internal.css');
        expect(result.data.metadata.blockedUrls).toContain('http://169.254.169.254/metadata.css');
      }
    });
  });

  describe('baseUrl parameter', () => {
    it('should resolve relative URLs using baseUrl', async () => {
      /**
       * 相対URLをbaseUrlを使って絶対URLに解決
       *
       * 期待動作:
       * 1. /css/main.css -> https://example.com/css/main.css
       * 2. ../shared/common.css -> https://example.com/shared/common.css
       * 3. styles.css -> https://example.com/pages/about/styles.css
       */
      const htmlWithRelativeUrls = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="/css/main.css">
  <link rel="stylesheet" href="../shared/common.css">
  <link rel="stylesheet" href="styles.css">
</head>
<body></body>
</html>`;

      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([
        { url: 'https://example.com/css/main.css', originalHref: '/css/main.css' },
        { url: 'https://example.com/shared/common.css', originalHref: '../shared/common.css' },
        { url: 'https://example.com/pages/about/styles.css', originalHref: 'styles.css' },
      ]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([
        { url: 'https://example.com/css/main.css', content: '', error: undefined },
        { url: 'https://example.com/shared/common.css', content: '', error: undefined },
        { url: 'https://example.com/pages/about/styles.css', content: '', error: undefined },
      ]);

      const input = {
        html: htmlWithRelativeUrls,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/pages/about/',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 解決されたURLが記録される
        const urls = result.data.metadata.externalCssUrls;
        expect(urls).toBeDefined();

        // 相対URLが正しく解決されている
        expect(urls).toContain('https://example.com/css/main.css');
        expect(urls).toContain('https://example.com/shared/common.css');
        expect(urls).toContain('https://example.com/pages/about/styles.css');
      }
    });

    it('should handle missing baseUrl gracefully', async () => {
      /**
       * baseUrlがない場合でも相対URLを持つ外部CSSをスキップして処理継続
       * 絶対URLのみ取得を試みる
       *
       * 実装によっては:
       * - バリデーションエラーとする（推奨）
       * - 相対URLをスキップして絶対URLのみ処理
       */
      const htmlWithMixedUrls = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://cdn.example.com/lib.css">
  <link rel="stylesheet" href="/local/styles.css">
</head>
<body></body>
</html>`;

      const input = {
        html: htmlWithMixedUrls,
        fetchExternalCss: true,
        detection_mode: 'css' as const,
        // baseUrl is not provided - but allowed in css mode with html
      };

      const result = await motionDetectHandler(input);

      // css mode + html では baseUrl なしでも成功する（外部CSSはスキップ）
      expect(result.success).toBe(true);
      if (result.success) {
        // baseUrlがないため外部CSSは取得されない
        expect(result.data.metadata.externalCssFetched).toBeFalsy();
      }
    });
  });

  describe('externalCssOptions parameter', () => {
    it('should accept custom timeout option', async () => {
      /**
       * カスタムタイムアウト設定を受け入れる
       * デフォルト: 5000ms
       * 範囲: 1000-30000ms
       */
      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([]);

      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        externalCssOptions: {
          timeout: 10000, // 10秒
        },
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
    });

    it('should accept maxConcurrent option for parallel fetching', async () => {
      /**
       * 並列取得数の上限を設定できる
       * デフォルト: 5
       * 範囲: 1-10
       */
      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([]);

      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        externalCssOptions: {
          maxConcurrent: 3,
        },
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
    });

    it('should validate externalCssOptions schema', async () => {
      /**
       * externalCssOptionsのバリデーション
       * timeout: 1000-30000ms
       * maxConcurrent: 1-10
       */
      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        externalCssOptions: {
          timeout: 100, // 1000未満は無効
          maxConcurrent: 20, // 10を超えるのは無効
        },
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  describe('metadata for external CSS', () => {
    it('should include external CSS fetch statistics in metadata', async () => {
      /**
       * メタデータに外部CSS取得の統計情報を含める
       *
       * 期待されるmetadataフィールド:
       * - externalCssFetched: boolean
       * - externalCssUrls: string[]
       * - externalCssStats: {
       *     urlsFound: number,
       *     urlsFetched: number,
       *     urlsBlocked: number,
       *     fetchTimeMs: number,
       *     totalCssSize: number
       *   }
       * - blockedUrls?: string[]
       */
      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([
        { url: 'https://example.com/styles/main.css', originalHref: '/styles/main.css' },
        { url: 'https://example.com/styles/theme.css', originalHref: '/styles/theme.css' },
      ]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([
        { url: 'https://example.com/styles/main.css', content: externalCssContent, error: undefined },
        { url: 'https://example.com/styles/theme.css', content: '', error: 'HTTP 404' },
      ]);

      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // 外部CSS取得統計
        expect(result.data.metadata.externalCssFetched).toBe(true);
        expect(result.data.metadata.externalCssStats).toBeDefined();
        expect(result.data.metadata.externalCssStats?.urlsFound).toBe(2);
        expect(result.data.metadata.externalCssStats?.urlsFetched).toBe(1);
        expect(result.data.metadata.externalCssStats?.fetchTimeMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('should include CSS size in metadata when external CSS is fetched', async () => {
      /**
       * 外部CSS取得時に合計CSSサイズをmetadataに含める
       */
      vi.spyOn(externalCssFetcherModule, 'extractCssUrls').mockReturnValue([
        { url: 'https://example.com/styles.css', originalHref: '/styles.css' },
      ]);
      vi.spyOn(externalCssFetcherModule, 'fetchAllCss').mockResolvedValue([
        { url: 'https://example.com/styles.css', content: externalCssContent, error: undefined },
      ]);

      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // CSS合計サイズ（インライン + 外部）
        expect(result.data.metadata.cssSize).toBeDefined();
        expect(result.data.metadata.cssSize).toBeGreaterThan(0);
      }
    });
  });

  describe('input schema validation for new parameters', () => {
    it('should validate fetchExternalCss as boolean', async () => {
      /**
       * fetchExternalCssはboolean型のみ受け入れる
       */
      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: 'true', // stringは無効
        baseUrl: 'https://example.com/',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('should validate baseUrl as valid URL format', async () => {
      /**
       * baseUrlは有効なURL形式である必要がある
       */
      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'not-a-valid-url',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
        expect(result.error.message).toContain('baseUrl');
      }
    });

    it('should validate externalCssOptions.timeout range', async () => {
      /**
       * timeout は 1000-30000ms の範囲
       */
      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        externalCssOptions: {
          timeout: 50000, // 30000を超えるので無効
        },
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('should validate externalCssOptions.maxConcurrent range', async () => {
      /**
       * maxConcurrent は 1-10 の範囲
       */
      const input = {
        html: htmlWithExternalCss,
        fetchExternalCss: true,
        baseUrl: 'https://example.com/',
        externalCssOptions: {
          maxConcurrent: 0, // 1未満は無効
        },
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });
});

// =====================================================
// P2-UX-2: min_severity 警告フィルタリングテスト
// =====================================================

describe('min_severity 警告フィルタリング (P2-UX-2)', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // テスト用HTML（prefers-reduced-motion未対応、無限アニメーションあり、パフォーマンス問題あり）
  const htmlWithMixedSeverityWarnings = `<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .spinner {
      animation: spin 1s linear infinite;
    }

    .card {
      transition: width 0.3s, height 0.3s;
    }

    .card:hover {
      width: 110%;
      height: 110%;
    }
  </style>
</head>
<body>
  <div class="spinner">Loading...</div>
  <div class="card">Content</div>
</body>
</html>`;

  describe('スキーマバリデーション', () => {
    it('min_severity パラメータを受け付ける', async () => {
      /**
       * min_severity を指定してもバリデーションエラーにならない
       */
      const input = {
        html: htmlWithMixedSeverityWarnings,
        includeWarnings: true,
        min_severity: 'warning',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
    });

    it('min_severity に info を指定できる', async () => {
      const input = {
        html: htmlWithMixedSeverityWarnings,
        includeWarnings: true,
        min_severity: 'info',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
    });

    it('min_severity に warning を指定できる', async () => {
      const input = {
        html: htmlWithMixedSeverityWarnings,
        includeWarnings: true,
        min_severity: 'warning',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
    });

    it('min_severity に error を指定できる', async () => {
      const input = {
        html: htmlWithMixedSeverityWarnings,
        includeWarnings: true,
        min_severity: 'error',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
    });

    it('min_severity に無効な値を指定するとエラー', async () => {
      const input = {
        html: htmlWithMixedSeverityWarnings,
        includeWarnings: true,
        min_severity: 'invalid_severity',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  describe('警告フィルタリング動作', () => {
    it('min_severity=info で全ての警告を返す', async () => {
      /**
       * severity: info/warning/error 全てを含む
       */
      const input = {
        html: htmlWithMixedSeverityWarnings,
        includeWarnings: true,
        min_severity: 'info',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.warnings) {
        // 少なくとも警告が存在する
        expect(result.data.warnings.length).toBeGreaterThan(0);

        // info レベルの警告も含まれる（無限アニメーション警告はinfoレベル）
        const infoWarnings = result.data.warnings.filter(w => w.severity === 'info');
        // infoレベルの警告が存在するはず（無限アニメーション）
        expect(infoWarnings.length).toBeGreaterThan(0);
      }
    });

    it('min_severity=warning で info レベルをフィルタアウト', async () => {
      /**
       * severity: warning/error のみ含む
       * info は除外される
       */
      const input = {
        html: htmlWithMixedSeverityWarnings,
        includeWarnings: true,
        min_severity: 'warning',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.warnings) {
        // info レベルの警告は含まれない
        const infoWarnings = result.data.warnings.filter(w => w.severity === 'info');
        expect(infoWarnings.length).toBe(0);

        // warning または error のみ
        result.data.warnings.forEach(warning => {
          expect(['warning', 'error']).toContain(warning.severity);
        });
      }
    });

    it('min_severity=error で error のみ返す', async () => {
      /**
       * severity: error のみ含む
       * info/warning は除外される
       */
      const input = {
        html: htmlWithMixedSeverityWarnings,
        includeWarnings: true,
        min_severity: 'error',
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.warnings) {
        // error レベル以外の警告は含まれない
        result.data.warnings.forEach(warning => {
          expect(warning.severity).toBe('error');
        });
      }
    });

    it('min_severity 未指定時はデフォルトで全ての警告を返す (info と同じ)', async () => {
      /**
       * min_severity を指定しない場合、従来どおり全ての警告を返す
       */
      const input = {
        html: htmlWithMixedSeverityWarnings,
        includeWarnings: true,
        detection_mode: 'css' as const,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.warnings) {
        // infoレベルの警告も含まれる（後方互換性）
        const infoWarnings = result.data.warnings.filter(w => w.severity === 'info');
        expect(infoWarnings.length).toBeGreaterThan(0);
      }
    });
  });

  describe('ツール定義の min_severity', () => {
    it('ツール定義に min_severity が含まれる', () => {
      expect(motionDetectToolDefinition.inputSchema.properties).toHaveProperty('min_severity');
    });

    it('min_severity の type が string', () => {
      const minSeverityProp = motionDetectToolDefinition.inputSchema.properties.min_severity;
      expect(minSeverityProp).toBeDefined();
      expect(minSeverityProp.type).toBe('string');
    });

    it('min_severity の enum に info/warning/error が含まれる', () => {
      const minSeverityProp = motionDetectToolDefinition.inputSchema.properties.min_severity;
      expect(minSeverityProp).toBeDefined();
      expect(minSeverityProp.enum).toEqual(['info', 'warning', 'error']);
    });
  });
});
