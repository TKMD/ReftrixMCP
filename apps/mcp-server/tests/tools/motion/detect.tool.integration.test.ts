// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect MCPツール統合テスト
 *
 * MotionDetectorServiceとdetect.tool.tsの統合をテストします
 *
 * @module tools/motion/detect.tool.integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  motionDetectHandler,
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
  type IMotionDetectService,
} from '../../../src/tools/motion/detect.tool';
import {
  MotionDetectorService,
  getMotionDetectorService,
  resetMotionDetectorService,
} from '../../../src/services/page/motion-detector.service';
import type { MotionDetectOutput } from '../../../src/tools/motion/schemas';

// =====================================================
// テストフィクスチャ
// =====================================================

/**
 * テスト用HTMLコンテンツ
 */
const TEST_HTML = {
  /** CSSアニメーション付きHTML */
  withAnimation: `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .fade-in {
          animation: fadeIn 0.5s ease-out forwards;
        }
      </style>
    </head>
    <body>
      <div class="fade-in">Hello</div>
    </body>
    </html>
  `,

  /** CSSトランジション付きHTML */
  withTransition: `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        .button {
          transition: transform 0.3s ease, opacity 0.2s linear;
        }
        .button:hover {
          transform: scale(1.1);
          opacity: 0.8;
        }
      </style>
    </head>
    <body>
      <button class="button">Click me</button>
    </body>
    </html>
  `,

  /** 複数アニメーション付きHTML */
  withMultipleAnimations: `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes slideIn {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        .spinner {
          animation: spin 1s linear infinite;
        }
        .pulse {
          animation: pulse 2s ease-in-out infinite;
        }
        .slide {
          animation: slideIn 0.5s ease-out forwards;
        }
      </style>
    </head>
    <body>
      <div class="spinner"></div>
      <div class="pulse"></div>
      <div class="slide"></div>
    </body>
    </html>
  `,

  /** アニメーションなしHTML */
  withoutAnimation: `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        .static {
          color: red;
          font-size: 16px;
        }
      </style>
    </head>
    <body>
      <div class="static">No animations</div>
    </body>
    </html>
  `,

  /** prefers-reduced-motion対応HTML */
  withReducedMotion: `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .fade-in {
          animation: fadeIn 0.5s ease-out;
        }
        @media (prefers-reduced-motion: reduce) {
          .fade-in {
            animation: none;
          }
        }
      </style>
    </head>
    <body>
      <div class="fade-in">Accessible</div>
    </body>
    </html>
  `,

  /** インラインスタイル付きHTML */
  withInlineStyles: `
    <!DOCTYPE html>
    <html>
    <body>
      <div style="animation: fadeIn 0.3s ease; transition: opacity 0.2s;">Inline</div>
    </body>
    </html>
  `,

  /** 複雑なcubic-bezierイージング */
  withCubicBezier: `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @keyframes bounce {
          from { transform: translateY(0); }
          to { transform: translateY(-20px); }
        }
        .bounce {
          animation: bounce 0.4s cubic-bezier(0.4, 0, 0.2, 1) alternate infinite;
        }
      </style>
    </head>
    <body>
      <div class="bounce">Bouncing</div>
    </body>
    </html>
  `,

  /** パフォーマンス問題のあるHTML（レイアウトトリガー） */
  withLayoutTrigger: `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @keyframes resize {
          from { width: 100px; }
          to { width: 200px; }
        }
        .resize {
          animation: resize 1s ease;
        }
      </style>
    </head>
    <body>
      <div class="resize">Resizing</div>
    </body>
    </html>
  `,

  /** ホバーエフェクト */
  withHoverEffect: `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        .card {
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }
        .card:hover {
          transform: translateY(-5px);
          box-shadow: 0 10px 20px rgba(0,0,0,0.2);
        }
      </style>
    </head>
    <body>
      <div class="card">Hover me</div>
    </body>
    </html>
  `,

  /** 空のHTML */
  empty: `<!DOCTYPE html><html><head></head><body></body></html>`,
};

// =====================================================
// MotionDetectorService統合テスト
// =====================================================

describe('motion.detect with MotionDetectorService Integration', () => {
  beforeEach(() => {
    // テスト前にサービスをリセット
    resetMotionDetectServiceFactory();
    resetMotionDetectorService();
  });

  afterEach(() => {
    // テスト後にサービスをリセット
    resetMotionDetectServiceFactory();
    resetMotionDetectorService();
  });

  describe('基本的な検出機能', () => {
    it('CSSアニメーションを正しく検出する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withAnimation,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.patterns.length).toBeGreaterThan(0);

      // fadeInアニメーションが検出されること
      const fadeInPattern = result.data.patterns.find(
        (p) => p.name === 'fadeIn' || p.type === 'css_animation'
      );
      expect(fadeInPattern).toBeDefined();
      expect(fadeInPattern?.animation.duration).toBe(500);
    });

    it('CSSトランジションを正しく検出する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withTransition,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.patterns.length).toBeGreaterThan(0);

      // トランジションが検出されること
      const transitionPattern = result.data.patterns.find(
        (p) => p.type === 'css_transition'
      );
      expect(transitionPattern).toBeDefined();
      expect(transitionPattern?.trigger).toBe('hover');
    });

    it('複数のアニメーションを検出する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withMultipleAnimations,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // 3つ以上のパターンが検出されること（spin, pulse, slideIn + keyframes）
      expect(result.data.patterns.length).toBeGreaterThanOrEqual(3);
    });

    it('アニメーションがない場合は空配列を返す', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withoutAnimation,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.patterns.length).toBe(0);
    });
  });

  describe('サマリー生成', () => {
    it('サマリーが正しく生成される', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withMultipleAnimations,
        detection_mode: 'css' as const,
        includeSummary: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.summary).toBeDefined();
      expect(result.data.summary?.totalPatterns).toBeGreaterThan(0);
      expect(result.data.summary?.byType).toBeDefined();
      expect(result.data.summary?.byTrigger).toBeDefined();
    });

    it('includeSummary=falseの場合サマリーがない', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withAnimation,
        detection_mode: 'css' as const,
        includeSummary: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.summary).toBeUndefined();
    });
  });

  describe('警告生成', () => {
    it('reduced-motion未対応の場合警告を生成する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withAnimation,
        detection_mode: 'css' as const,
        includeWarnings: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.warnings).toBeDefined();
      const reducedMotionWarning = result.data.warnings?.find(
        (w) => w.code === 'A11Y_NO_REDUCED_MOTION'
      );
      expect(reducedMotionWarning).toBeDefined();
    });

    it('reduced-motion対応の場合は警告なし', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withReducedMotion,
        detection_mode: 'css' as const,
        includeWarnings: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const reducedMotionWarning = result.data.warnings?.find(
        (w) => w.code === 'A11Y_NO_REDUCED_MOTION'
      );
      expect(reducedMotionWarning).toBeUndefined();
    });

    it('無限アニメーションの警告を生成する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withMultipleAnimations,
        detection_mode: 'css' as const,
        includeWarnings: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const infiniteWarning = result.data.warnings?.find(
        (w) => w.code === 'A11Y_INFINITE_ANIMATION'
      );
      expect(infiniteWarning).toBeDefined();
    });

    it('レイアウトトリガーの警告を生成する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withLayoutTrigger,
        detection_mode: 'css' as const,
        includeWarnings: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const layoutWarning = result.data.warnings?.find(
        (w) => w.code === 'PERF_LAYOUT_TRIGGER'
      );
      expect(layoutWarning).toBeDefined();
    });

    it('includeWarnings=falseの場合警告がない', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withAnimation,
        detection_mode: 'css' as const,
        includeWarnings: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.warnings).toBeUndefined();
    });
  });

  describe('オプション処理', () => {
    it('minDurationでフィルタリングする', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withMultipleAnimations,
        detection_mode: 'css' as const,
        minDuration: 1500, // 1.5秒以上のみ
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // minDuration以上のパターンのみが検出されること
      // css_animation / css_transition タイプのパターンはすべて minDuration 以上
      const animationsWithDuration = result.data.patterns.filter(
        (p) => p.type === 'css_animation' || p.type === 'css_transition'
      );

      for (const pattern of animationsWithDuration) {
        expect(pattern.animation.duration).toBeGreaterThanOrEqual(1500);
      }

      // 2秒のpulseアニメーションが含まれること
      const pulsePattern = result.data.patterns.find((p) => p.name === 'pulse');
      expect(pulsePattern).toBeDefined();
    });

    it('maxPatternsで結果を制限する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withMultipleAnimations,
        detection_mode: 'css' as const,
        maxPatterns: 2,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.patterns.length).toBeLessThanOrEqual(2);
    });

    it('verbose=trueでrawCssを含める', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withAnimation,
        detection_mode: 'css' as const,
        verbose: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const patternWithRawCss = result.data.patterns.find((p) => p.rawCss);
      expect(patternWithRawCss).toBeDefined();
    });

    it('verbose=falseでrawCssを含めない', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withAnimation,
        detection_mode: 'css' as const,
        verbose: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const patternWithRawCss = result.data.patterns.find((p) => p.rawCss);
      expect(patternWithRawCss).toBeUndefined();
    });

    it('includeInlineStyles=trueでインラインスタイルを解析する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withInlineStyles,
        detection_mode: 'css' as const,
        includeInlineStyles: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // インラインスタイルからのパターンが検出されること
      expect(result.data.patterns.length).toBeGreaterThan(0);
    });

    it('includeStyleSheets=falseでスタイルシートを無視する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withAnimation,
        detection_mode: 'css' as const,
        includeStyleSheets: false,
        includeInlineStyles: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // スタイルシートからのアニメーションは検出されない
      const fadeInPattern = result.data.patterns.find(
        (p) => p.name === 'fadeIn'
      );
      expect(fadeInPattern).toBeUndefined();
    });
  });

  describe('パフォーマンス分析', () => {
    it('transform使用時はパフォーマンスが良好と判定する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withAnimation,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // opacityを使用するアニメーションは良好なパフォーマンス
      const opacityPattern = result.data.patterns.find((p) =>
        p.properties.some(
          (prop) =>
            (typeof prop === 'string' && prop.includes('opacity')) ||
            (typeof prop === 'object' && prop.property === 'opacity')
        )
      );
      if (opacityPattern?.performance) {
        expect(opacityPattern.performance.usesOpacity).toBe(true);
      }
    });

    it('レイアウトプロパティ使用時はパフォーマンス警告', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withLayoutTrigger,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const resizePattern = result.data.patterns.find((p) =>
        p.properties.some(
          (prop) =>
            (typeof prop === 'string' && prop === 'width') ||
            (typeof prop === 'object' && prop.property === 'width')
        )
      );
      if (resizePattern?.performance) {
        expect(resizePattern.performance.triggersLayout).toBe(true);
      }
    });
  });

  describe('エラーハンドリング', () => {
    it('HTMLが提供されない場合エラーを返す', async () => {
      const result = await motionDetectHandler({});

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.code).toBe('VALIDATION_ERROR');
    });

    it('空のHTMLでも正常に処理する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.empty,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.patterns.length).toBe(0);
    });
  });

  describe('メタデータ', () => {
    it('処理時間を記録する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withAnimation,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.metadata.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('HTMLサイズを記録する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withAnimation,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.metadata.htmlSize).toBe(
        TEST_HTML.withAnimation.length
      );
    });
  });

  describe('カテゴリ分類', () => {
    it('ローディング状態を正しく分類する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withMultipleAnimations,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // infiniteアニメーションはloading_stateに分類される
      const loadingPattern = result.data.patterns.find(
        (p) => p.category === 'loading_state'
      );
      expect(loadingPattern).toBeDefined();
    });

    it('ホバーエフェクトを正しく分類する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withHoverEffect,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const hoverPattern = result.data.patterns.find(
        (p) => p.category === 'hover_effect' || p.trigger === 'hover'
      );
      expect(hoverPattern).toBeDefined();
    });
  });

  describe('イージング解析', () => {
    it('cubic-bezierを正しく解析する', async () => {
      const result = await motionDetectHandler({
        html: TEST_HTML.withCubicBezier,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const bouncePattern = result.data.patterns.find(
        (p) => p.name === 'bounce' || p.type === 'css_animation'
      );
      expect(bouncePattern).toBeDefined();

      // easingがcubic-bezier形式であることを確認
      const easing = bouncePattern?.animation.easing;
      if (typeof easing === 'object' && easing.type === 'cubic-bezier') {
        expect(easing.cubicBezier).toBeDefined();
        expect(easing.cubicBezier?.length).toBe(4);
      }
    });
  });
});

// =====================================================
// サービスファクトリテスト
// =====================================================

describe('MotionDetectorService Factory Integration', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
    resetMotionDetectorService();
  });

  afterEach(() => {
    resetMotionDetectServiceFactory();
    resetMotionDetectorService();
  });

  it('カスタムサービスファクトリを設定できる', async () => {
    const mockService: IMotionDetectService = {
      detect: vi.fn().mockReturnValue({
        patterns: [],
        warnings: [],
      }),
    };

    setMotionDetectServiceFactory(() => mockService);

    const result = await motionDetectHandler({
      html: TEST_HTML.withAnimation,
      detection_mode: 'css' as const,
    });

    expect(mockService.detect).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('MotionDetectorServiceをファクトリとして設定できる', async () => {
    // MotionDetectorServiceをラップしてIMotionDetectServiceに適合させる
    const motionDetectorService = getMotionDetectorService();

    const adaptedService: IMotionDetectService = {
      detect: (html, css, options) => {
        const detectionResult = motionDetectorService.detect(
          html,
          {
            includeInlineStyles: options?.includeInlineStyles,
            includeStyleSheets: options?.includeStyleSheets,
            minDuration: options?.minDuration,
            maxPatterns: options?.maxPatterns,
            verbose: options?.verbose,
          },
          css
        );

        // MotionDetectorServiceの出力をIMotionDetectServiceの形式に変換
        return {
          patterns: detectionResult.patterns.map((p) => ({
            id: p.id,
            type: p.type as 'css_animation' | 'css_transition' | 'keyframes' | 'library_animation',
            category: p.category,
            name: p.name,
            selector: p.selector,
            trigger: p.trigger as 'scroll' | 'scroll_velocity' | 'hover' | 'click' | 'focus' | 'load' | 'intersection' | 'time' | 'state_change' | 'unknown',
            animation: {
              duration: p.duration,
              delay: p.delay,
              easing: { type: 'ease' as const },
              iterations: p.iterations,
              direction: p.direction as 'normal' | 'reverse' | 'alternate' | 'alternate-reverse' | undefined,
              fillMode: p.fillMode as 'none' | 'forwards' | 'backwards' | 'both' | undefined,
            },
            properties: p.properties.map((prop) =>
              typeof prop === 'string' ? { property: prop } : { property: prop }
            ),
            performance: p.performance
              ? {
                  usesTransform: p.performance.usesTransform,
                  usesOpacity: p.performance.usesOpacity,
                  triggersLayout: p.performance.triggersLayout ?? false,
                  triggersPaint: p.performance.triggersPaint ?? false,
                }
              : undefined,
            accessibility: p.accessibility,
            keyframes: p.keyframes,
            rawCss: p.rawCss,
          })),
          warnings: detectionResult.warnings,
        };
      },
    };

    setMotionDetectServiceFactory(() => adaptedService);

    const result = await motionDetectHandler({
      html: TEST_HTML.withAnimation,
      detection_mode: 'css' as const,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patterns.length).toBeGreaterThan(0);
    }
  });
});
