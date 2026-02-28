// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect v0.1.0 include_perspective パラメータテスト
 * TDD Red Phase: 実装前に失敗するテストを作成
 *
 * include_perspective パラメータ仕様:
 * - false (デフォルト): 3D効果は検出しない（後方互換性）
 * - true: 3D効果（perspective, transform-style: preserve-3d, rotateX/Y/Z, translateZ）を検出
 *
 * 検出対象の3Dプロパティ:
 * - transform-style: preserve-3d
 * - perspective
 * - rotateX, rotateY, rotateZ (transform関数)
 * - translateZ (transform関数)
 * - perspective() (transform関数)
 *
 * @module tests/tools/motion/perspective.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
} from '../../../src/tools/motion/detect.tool';

// =====================================================
// テストデータ
// =====================================================

const sampleHtmlWith3DTransforms = `<!DOCTYPE html>
<html>
<head>
  <style>
    .card-container {
      perspective: 1000px;
    }

    .card {
      transform-style: preserve-3d;
      transition: transform 0.6s ease;
    }

    .card:hover {
      transform: rotateY(180deg);
    }

    @keyframes flip3D {
      0% { transform: rotateX(0deg); }
      50% { transform: rotateX(90deg); }
      100% { transform: rotateX(180deg); }
    }

    .flip-animation {
      animation: flip3D 1s ease-in-out;
    }
  </style>
</head>
<body>
  <div class="card-container">
    <div class="card">
      <div class="front">Front</div>
      <div class="back">Back</div>
    </div>
  </div>
  <div class="flip-animation">Flipping</div>
</body>
</html>`;

const sampleHtmlWithTranslateZ = `<!DOCTYPE html>
<html>
<head>
  <style>
    .parallax-layer {
      transform: translateZ(-1px) scale(2);
    }

    @keyframes zoomIn {
      from { transform: translateZ(-100px); }
      to { transform: translateZ(0); }
    }

    .zoom-element {
      animation: zoomIn 0.5s ease-out;
    }

    .hover-lift {
      transition: transform 0.3s ease;
    }

    .hover-lift:hover {
      transform: translateZ(20px) scale(1.05);
    }
  </style>
</head>
<body>
  <div class="parallax-layer">Parallax content</div>
  <div class="zoom-element">Zooming in</div>
  <div class="hover-lift">Lift on hover</div>
</body>
</html>`;

const sampleHtmlWithPerspectiveFunction = `<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes perspectiveRotate {
      0% { transform: perspective(500px) rotateX(0deg); }
      100% { transform: perspective(500px) rotateX(45deg); }
    }

    .perspective-animated {
      animation: perspectiveRotate 2s ease infinite alternate;
    }

    .perspective-hover {
      transition: transform 0.4s ease;
    }

    .perspective-hover:hover {
      transform: perspective(800px) rotateY(-15deg);
    }
  </style>
</head>
<body>
  <div class="perspective-animated">3D rotating</div>
  <div class="perspective-hover">Hover for 3D</div>
</body>
</html>`;

const sampleHtmlWith2DOnly = `<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes slideIn {
      from { transform: translateX(-100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    .slide-in {
      animation: slideIn 0.5s ease-out;
    }

    .rotate-2d {
      transition: transform 0.3s ease;
    }

    .rotate-2d:hover {
      transform: rotate(45deg) scale(1.1);
    }
  </style>
</head>
<body>
  <div class="slide-in">2D slide</div>
  <div class="rotate-2d">2D rotate</div>
</body>
</html>`;

const sampleHtmlWithComplex3D = `<!DOCTYPE html>
<html>
<head>
  <style>
    .scene {
      perspective: 600px;
      perspective-origin: 50% 50%;
    }

    .cube {
      transform-style: preserve-3d;
      animation: rotateCube 10s linear infinite;
    }

    @keyframes rotateCube {
      0% { transform: rotateX(0deg) rotateY(0deg) rotateZ(0deg); }
      25% { transform: rotateX(90deg) rotateY(90deg) rotateZ(0deg); }
      50% { transform: rotateX(180deg) rotateY(180deg) rotateZ(90deg); }
      75% { transform: rotateX(270deg) rotateY(270deg) rotateZ(180deg); }
      100% { transform: rotateX(360deg) rotateY(360deg) rotateZ(270deg); }
    }

    .face {
      backface-visibility: hidden;
    }

    .face-front { transform: translateZ(50px); }
    .face-back { transform: rotateY(180deg) translateZ(50px); }
    .face-left { transform: rotateY(-90deg) translateZ(50px); }
    .face-right { transform: rotateY(90deg) translateZ(50px); }
    .face-top { transform: rotateX(90deg) translateZ(50px); }
    .face-bottom { transform: rotateX(-90deg) translateZ(50px); }
  </style>
</head>
<body>
  <div class="scene">
    <div class="cube">
      <div class="face face-front">Front</div>
      <div class="face face-back">Back</div>
      <div class="face face-left">Left</div>
      <div class="face face-right">Right</div>
      <div class="face face-top">Top</div>
      <div class="face face-bottom">Bottom</div>
    </div>
  </div>
</body>
</html>`;

// =====================================================
// include_perspective スキーマバリデーションテスト
// =====================================================

describe('motionDetectInputSchema include_perspective', () => {
  describe('有効な入力', () => {
    it('include_perspective を指定しない場合、デフォルトで false になる', () => {
      // v0.1.0 新機能: include_perspective パラメータのデフォルト値
      const input = { html: sampleHtmlWith3DTransforms, detection_mode: 'css' };
      const result = motionDetectInputSchema.parse(input);

      // デフォルト値 false が設定されることを期待
      expect(result.include_perspective).toBe(false);
    });

    it('include_perspective: true を受け付ける', () => {
      // v0.1.0 新機能: 3D効果検出を有効化
      const input = {
        html: sampleHtmlWith3DTransforms,
        detection_mode: 'css',
        include_perspective: true,
      };
      const result = motionDetectInputSchema.parse(input);

      expect(result.include_perspective).toBe(true);
    });

    it('include_perspective: false を受け付ける', () => {
      // v0.1.0: 明示的に無効化
      const input = {
        html: sampleHtmlWith3DTransforms,
        detection_mode: 'css',
        include_perspective: false,
      };
      const result = motionDetectInputSchema.parse(input);

      expect(result.include_perspective).toBe(false);
    });

    it('include_perspective と detection_mode を組み合わせて使用できる', () => {
      // v0.1.0: 複数の新パラメータを併用
      // hybrid モードでは url が必須
      const input = {
        url: 'https://example.com',
        include_perspective: true,
        detection_mode: 'hybrid',
      };
      const result = motionDetectInputSchema.parse(input);

      expect(result.include_perspective).toBe(true);
      expect(result.detection_mode).toBe('hybrid');
    });

    it('include_perspective と他のオプションを組み合わせて使用できる', () => {
      // v0.1.0: 既存オプションとの組み合わせ
      const input = {
        html: sampleHtmlWith3DTransforms,
        detection_mode: 'css',
        include_perspective: true,
        verbose: true,
        maxPatterns: 50,
        includeWarnings: true,
      };
      const result = motionDetectInputSchema.parse(input);

      expect(result.include_perspective).toBe(true);
      expect(result.verbose).toBe(true);
      expect(result.maxPatterns).toBe(50);
    });
  });

  describe('無効な入力', () => {
    it('include_perspective が文字列の場合エラー', () => {
      const input = {
        html: sampleHtmlWith3DTransforms,
        detection_mode: 'css',
        include_perspective: 'true',
      };

      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });

    it('include_perspective が数値の場合エラー', () => {
      const input = {
        html: sampleHtmlWith3DTransforms,
        detection_mode: 'css',
        include_perspective: 1,
      };

      expect(() => motionDetectInputSchema.parse(input)).toThrow();
    });
  });
});

// =====================================================
// include_perspective 機能テスト
// =====================================================

describe('include_perspective 機能テスト', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('include_perspective: false (デフォルト)', () => {
    it('3D効果を含むアニメーションでも perspective 情報は含まれない', async () => {
      // v0.1.0: デフォルトでは3D情報は検出対象外（後方互換性）
      const mockDetect = vi.fn().mockResolvedValue({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'flip3D',
            category: 'micro_interaction',
            trigger: 'load',
            animation: { duration: 1000, easing: { type: 'ease-in-out' } },
            properties: [{ property: 'transform' }],
            // perspective 情報は含まれない
          },
        ],
        warnings: [],
        summary: { totalPatterns: 1 },
        metadata: { processingTimeMs: 10, htmlSize: 500 },
      });

      setMotionDetectServiceFactory(() => ({
        detect: mockDetect,
      }));

      const input: MotionDetectInput = {
        html: sampleHtmlWith3DTransforms,
        detection_mode: 'css' as const,
        include_perspective: false,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
        // perspective 情報は含まれていない
        expect(result.data.patterns[0].perspective).toBeUndefined();
      }
    });

    it('2Dアニメーションのみの場合、通常通り検出される', async () => {
      // v0.1.0: 2Dアニメーションは include_perspective に関係なく検出
      const mockDetect = vi.fn().mockResolvedValue({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'slideIn',
            category: 'entrance',
            trigger: 'load',
            animation: { duration: 500 },
            properties: [
              { property: 'transform' },
              { property: 'opacity' },
            ],
          },
        ],
        warnings: [],
        summary: { totalPatterns: 1 },
        metadata: { processingTimeMs: 10, htmlSize: 300 },
      });

      setMotionDetectServiceFactory(() => ({
        detect: mockDetect,
      }));

      const input: MotionDetectInput = {
        html: sampleHtmlWith2DOnly,
        detection_mode: 'css' as const,
        include_perspective: false,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
      }
    });
  });

  describe('include_perspective: true', () => {
    it('rotateX/Y/Z を含むアニメーションで perspective 情報が含まれる', async () => {
      // v0.1.0 新機能: 3D回転の検出
      const mockDetect = vi.fn().mockResolvedValue({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'flip3D',
            category: 'micro_interaction',
            trigger: 'load',
            animation: { duration: 1000, easing: { type: 'ease-in-out' } },
            properties: [{ property: 'transform' }],
            // v0.1.0: perspective 情報
            perspective: {
              type: '3d_rotation',
              axes: ['X'],
              rotationRange: { min: 0, max: 180 },
              uses3DTransform: true,
            },
          },
        ],
        warnings: [],
        summary: {
          totalPatterns: 1,
          // v0.1.0: 3D関連サマリー
          has3DEffects: true,
          perspective3DCount: 1,
        },
        metadata: { processingTimeMs: 15, htmlSize: 500 },
      });

      setMotionDetectServiceFactory(() => ({
        detect: mockDetect,
      }));

      const input: MotionDetectInput = {
        html: sampleHtmlWith3DTransforms,
        detection_mode: 'css' as const,
        include_perspective: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
        // v0.1.0: perspective 情報が含まれる
        expect(result.data.patterns[0].perspective).toBeDefined();
        expect(result.data.patterns[0].perspective?.uses3DTransform).toBe(true);
      }
    });

    it('translateZ を含むアニメーションで z軸移動情報が検出される', async () => {
      // v0.1.0 新機能: Z軸移動の検出
      const mockDetect = vi.fn().mockResolvedValue({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'zoomIn',
            category: 'entrance',
            trigger: 'load',
            animation: { duration: 500, easing: { type: 'ease-out' } },
            properties: [{ property: 'transform' }],
            perspective: {
              type: 'z_translation',
              axes: ['Z'],
              translationRange: { min: -100, max: 0 },
              uses3DTransform: true,
            },
          },
        ],
        warnings: [],
        summary: { totalPatterns: 1, has3DEffects: true },
        metadata: { processingTimeMs: 12, htmlSize: 400 },
      });

      setMotionDetectServiceFactory(() => ({
        detect: mockDetect,
      }));

      const input: MotionDetectInput = {
        html: sampleHtmlWithTranslateZ,
        detection_mode: 'css' as const,
        include_perspective: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
        expect(result.data.patterns[0].perspective?.type).toBe('z_translation');
        expect(result.data.patterns[0].perspective?.axes).toContain('Z');
      }
    });

    it('perspective() 関数を含むアニメーションが検出される', async () => {
      // v0.1.0 新機能: perspective() transform関数の検出
      const mockDetect = vi.fn().mockResolvedValue({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'perspectiveRotate',
            category: 'micro_interaction',
            trigger: 'load',
            animation: { duration: 2000, iterations: 'infinite' },
            properties: [{ property: 'transform' }],
            perspective: {
              type: 'perspective_function',
              perspectiveValue: 500,
              axes: ['X'],
              uses3DTransform: true,
            },
          },
        ],
        warnings: [],
        summary: { totalPatterns: 1, has3DEffects: true },
        metadata: { processingTimeMs: 12, htmlSize: 350 },
      });

      setMotionDetectServiceFactory(() => ({
        detect: mockDetect,
      }));

      const input: MotionDetectInput = {
        html: sampleHtmlWithPerspectiveFunction,
        detection_mode: 'css' as const,
        include_perspective: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
        expect(result.data.patterns[0].perspective?.type).toBe('perspective_function');
        expect(result.data.patterns[0].perspective?.perspectiveValue).toBe(500);
      }
    });

    it('perspective CSS プロパティが検出される', async () => {
      // v0.1.0 新機能: perspective CSSプロパティの検出
      const mockDetect = vi.fn().mockResolvedValue({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'flip3D',
            category: 'micro_interaction',
            trigger: 'hover',
            animation: { duration: 600, easing: { type: 'ease' } },
            properties: [{ property: 'transform' }],
            perspective: {
              type: '3d_rotation',
              parentPerspective: 1000, // perspective プロパティの値
              axes: ['Y'],
              uses3DTransform: true,
              transformStyle: 'preserve-3d',
            },
          },
        ],
        warnings: [],
        summary: { totalPatterns: 1, has3DEffects: true },
        metadata: { processingTimeMs: 15, htmlSize: 600 },
      });

      setMotionDetectServiceFactory(() => ({
        detect: mockDetect,
      }));

      const input: MotionDetectInput = {
        html: sampleHtmlWith3DTransforms,
        detection_mode: 'css' as const,
        include_perspective: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
        expect(result.data.patterns[0].perspective?.parentPerspective).toBe(1000);
        expect(result.data.patterns[0].perspective?.transformStyle).toBe('preserve-3d');
      }
    });

    it('transform-style: preserve-3d が検出される', async () => {
      // v0.1.0 新機能: transform-style の検出
      const mockDetect = vi.fn().mockResolvedValue({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'rotateCube',
            category: 'attention_grabber',
            trigger: 'load',
            animation: { duration: 10000, iterations: 'infinite' },
            properties: [{ property: 'transform' }],
            perspective: {
              type: 'complex_3d',
              axes: ['X', 'Y', 'Z'],
              uses3DTransform: true,
              transformStyle: 'preserve-3d',
              parentPerspective: 600,
              hasBackfaceVisibility: true,
            },
          },
        ],
        warnings: [],
        summary: { totalPatterns: 1, has3DEffects: true },
        metadata: { processingTimeMs: 20, htmlSize: 1200 },
      });

      setMotionDetectServiceFactory(() => ({
        detect: mockDetect,
      }));

      const input: MotionDetectInput = {
        html: sampleHtmlWithComplex3D,
        detection_mode: 'css' as const,
        include_perspective: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
        expect(result.data.patterns[0].perspective?.transformStyle).toBe('preserve-3d');
      }
    });

    it('複合3D変換（複数軸の回転）が検出される', async () => {
      // v0.1.0 新機能: 複数軸を使った3D変換の検出
      const mockDetect = vi.fn().mockResolvedValue({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'rotateCube',
            category: 'attention_grabber',
            trigger: 'load',
            animation: { duration: 10000, iterations: 'infinite' },
            properties: [{ property: 'transform' }],
            perspective: {
              type: 'complex_3d',
              axes: ['X', 'Y', 'Z'],
              rotationAngles: {
                X: { from: 0, to: 360 },
                Y: { from: 0, to: 360 },
                Z: { from: 0, to: 270 },
              },
              uses3DTransform: true,
            },
          },
        ],
        warnings: [],
        summary: { totalPatterns: 1, has3DEffects: true },
        metadata: { processingTimeMs: 25, htmlSize: 1200 },
      });

      setMotionDetectServiceFactory(() => ({
        detect: mockDetect,
      }));

      const input: MotionDetectInput = {
        html: sampleHtmlWithComplex3D,
        detection_mode: 'css' as const,
        include_perspective: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
        const perspective = result.data.patterns[0].perspective;
        expect(perspective?.axes).toContain('X');
        expect(perspective?.axes).toContain('Y');
        expect(perspective?.axes).toContain('Z');
        expect(perspective?.axes?.length).toBe(3);
      }
    });
  });

  describe('サマリー情報', () => {
    it('include_perspective: true の場合、サマリーに3D効果情報が含まれる', async () => {
      // v0.1.0 新機能: サマリーへの3D情報追加
      const mockDetect = vi.fn().mockResolvedValue({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'flip3D',
            category: 'micro_interaction',
            trigger: 'load',
            animation: { duration: 1000 },
            properties: [{ property: 'transform' }],
            perspective: { type: '3d_rotation', uses3DTransform: true },
          },
          {
            id: 'pattern-2',
            type: 'css_animation',
            name: 'slideIn',
            category: 'entrance',
            trigger: 'load',
            animation: { duration: 500 },
            properties: [{ property: 'transform' }],
            // 2Dのみ
          },
        ],
        warnings: [],
        summary: {
          totalPatterns: 2,
          has3DEffects: true,
          perspective3DCount: 1,
          // v0.1.0: 3D効果の詳細統計
          perspectiveStats: {
            rotationCount: 1,
            translationZCount: 0,
            perspectiveFunctionCount: 0,
          },
        },
        metadata: { processingTimeMs: 20, htmlSize: 800 },
      });

      setMotionDetectServiceFactory(() => ({
        detect: mockDetect,
      }));

      const input: MotionDetectInput = {
        html: sampleHtmlWith3DTransforms,
        detection_mode: 'css' as const,
        include_perspective: true,
        includeSummary: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.summary).toBeDefined();
        expect(result.data.summary?.has3DEffects).toBe(true);
        expect(result.data.summary?.perspective3DCount).toBe(1);
      }
    });
  });

  describe('警告', () => {
    it('3Dエフェクトがある場合、パフォーマンス警告が出る場合がある', async () => {
      // v0.1.0: 3D効果のパフォーマンス警告
      const mockDetect = vi.fn().mockResolvedValue({
        patterns: [
          {
            id: 'pattern-1',
            type: 'css_animation',
            name: 'rotateCube',
            category: 'attention_grabber',
            trigger: 'load',
            animation: { duration: 10000, iterations: 'infinite' },
            properties: [{ property: 'transform' }],
            perspective: { type: 'complex_3d', axes: ['X', 'Y', 'Z'], uses3DTransform: true },
          },
        ],
        warnings: [
          {
            code: 'PERF_3D_TRANSFORM',
            severity: 'info',
            message: '3D transforms detected. Ensure hardware acceleration is enabled.',
            suggestion: 'Use will-change: transform for better performance',
          },
        ],
        summary: { totalPatterns: 1, has3DEffects: true },
        metadata: { processingTimeMs: 25, htmlSize: 1200 },
      });

      setMotionDetectServiceFactory(() => ({
        detect: mockDetect,
      }));

      const input: MotionDetectInput = {
        html: sampleHtmlWithComplex3D,
        detection_mode: 'css' as const,
        include_perspective: true,
        includeWarnings: true,
      };

      const result = await motionDetectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.warnings).toBeDefined();
        expect(result.data.warnings?.some(w => w.code === 'PERF_3D_TRANSFORM')).toBe(true);
      }
    });
  });
});

// =====================================================
// 後方互換性テスト
// =====================================================

describe('include_perspective 後方互換性', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('include_perspective を指定しない場合、既存の出力形式と互換', async () => {
    // v0.1.0: デフォルト false は既存動作と完全互換
    const mockDetect = vi.fn().mockResolvedValue({
      patterns: [
        {
          id: 'pattern-1',
          type: 'css_animation',
          name: 'flip3D',
          category: 'micro_interaction',
          trigger: 'load',
          animation: { duration: 1000, easing: { type: 'ease-in-out' } },
          properties: [{ property: 'transform' }],
          // perspective フィールドなし（既存形式）
        },
      ],
      warnings: [],
      summary: {
        totalPatterns: 1,
        // has3DEffects フィールドなし（既存形式）
      },
      metadata: { processingTimeMs: 10, htmlSize: 500 },
    });

    setMotionDetectServiceFactory(() => ({
      detect: mockDetect,
    }));

    // include_perspective を指定しない（既存のAPI）
    const input: MotionDetectInput = {
      html: sampleHtmlWith3DTransforms,
      detection_mode: 'css' as const,
    };

    const result = await motionDetectHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 既存形式と同じ
      expect(result.data.patterns[0].perspective).toBeUndefined();
      expect(result.data.summary?.has3DEffects).toBeUndefined();
    }
  });
});
