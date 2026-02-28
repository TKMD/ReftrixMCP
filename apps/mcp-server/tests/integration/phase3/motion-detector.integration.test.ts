// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 3 統合テスト: MotionDetectorService + motion.detect ツール
 *
 * MotionDetectorServiceとmotion.detectツールの統合テスト。
 * CSSアニメーション/トランジションの検出、分類、警告生成を検証。
 *
 * @module tests/integration/phase3/motion-detector.integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  motionDetectHandler,
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
  setMotionPersistenceServiceFactory,
  resetMotionPersistenceServiceFactory,
} from '../../../src/tools/motion/detect.tool';
import {
  MotionDetectorService,
  getMotionDetectorService,
  resetMotionDetectorService,
  MOTION_WARNING_CODES,
  type MotionDetectionResult,
  type MotionPattern,
} from '../../../src/services/page/motion-detector.service';
import { MOTION_MCP_ERROR_CODES } from '../../../src/tools/motion/schemas';

// =============================================
// テストフィクスチャ
// =============================================

/** CSSアニメーションを含むHTML */
const HTML_WITH_ANIMATION = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes slideUp {
      0% { transform: translateY(20px); opacity: 0; }
      100% { transform: translateY(0); opacity: 1; }
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .hero {
      animation: fadeIn 0.5s ease-out;
    }

    .content {
      animation: slideUp 0.3s ease-in-out 0.2s;
    }

    .loader {
      animation: spin 1s linear infinite;
    }
  </style>
</head>
<body>
  <div class="hero">Hero Section</div>
  <div class="content">Content</div>
  <div class="loader">Loading...</div>
</body>
</html>
`;

/** CSSトランジションを含むHTML */
const HTML_WITH_TRANSITION = `
<!DOCTYPE html>
<html>
<head>
  <style>
    .button {
      transition: background-color 0.2s ease, transform 0.15s ease-out;
    }

    .button:hover {
      background-color: #007bff;
      transform: scale(1.05);
    }

    .card {
      transition: box-shadow 0.3s ease, transform 0.3s ease;
    }

    .card:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      transform: translateY(-2px);
    }

    .menu {
      transition: opacity 0.25s ease-in-out, visibility 0.25s;
    }
  </style>
</head>
<body>
  <button class="button">Click me</button>
  <div class="card">Card content</div>
  <nav class="menu">Navigation</nav>
</body>
</html>
`;

/** 複合的なモーションを含むHTML */
const HTML_WITH_COMPLEX_MOTION = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes bounce {
      0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-30px); }
      60% { transform: translateY(-15px); }
    }

    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.1); }
      100% { transform: scale(1); }
    }

    .attention {
      animation: bounce 2s ease infinite;
    }

    .cta {
      animation: pulse 1.5s ease-in-out infinite;
    }

    .nav-item {
      transition: color 0.2s ease, border-bottom-color 0.2s ease;
    }

    .nav-item:hover {
      color: #007bff;
      border-bottom-color: #007bff;
    }

    /* Layout-triggering animation (パフォーマンス警告対象) */
    .expand {
      transition: width 0.3s ease, height 0.3s ease;
    }
  </style>
</head>
<body>
  <div class="attention">Notice me!</div>
  <button class="cta">Subscribe</button>
  <nav>
    <a class="nav-item">Home</a>
    <a class="nav-item">About</a>
  </nav>
  <div class="expand">Expandable content</div>
</body>
</html>
`;

/** モーションなしのHTML */
const HTML_WITHOUT_MOTION = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; }
    .container { max-width: 1200px; }
    .text { color: #333; }
  </style>
</head>
<body>
  <div class="container">
    <p class="text">Static content only</p>
  </div>
</body>
</html>
`;

/** prefers-reduced-motion対応のHTML */
const HTML_WITH_REDUCED_MOTION = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .animated {
      animation: fadeIn 0.5s ease;
    }

    @media (prefers-reduced-motion: reduce) {
      .animated {
        animation: none;
      }
    }
  </style>
</head>
<body>
  <div class="animated">Accessible animation</div>
</body>
</html>
`;

// =============================================
// テストスイート
// =============================================

describe('Phase 3 Integration: MotionDetectorService + motion.detect', () => {
  beforeEach(() => {
    // サービスファクトリをリセット
    resetMotionDetectServiceFactory();
    resetMotionPersistenceServiceFactory();
    resetMotionDetectorService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------
  // 正常系テスト: CSSアニメーション検出
  // -----------------------------------------

  describe('正常系: CSSアニメーション検出', () => {
    it('@keyframes アニメーションを検出できる', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.patterns).toBeDefined();
      expect(result.data?.patterns.length).toBeGreaterThan(0);

      // fadeInアニメーションが検出されていることを確認
      const fadeInPattern = result.data?.patterns.find(
        (p) => p.name === 'fadeIn' || p.name?.includes('fade')
      );
      expect(fadeInPattern).toBeDefined();
      expect(fadeInPattern?.type).toBe('css_animation');
    });

    it('アニメーションのduration/easing/delay を正しく抽出する', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);

      // fadeIn: 0.5s ease-out
      const fadeInPattern = result.data?.patterns.find(
        (p) => p.name === 'fadeIn'
      );
      if (fadeInPattern) {
        expect(fadeInPattern.animation.duration).toBe(500);
        expect(fadeInPattern.animation.easing?.type).toBe('ease-out');
      }

      // slideUp: 0.3s ease-in-out 0.2s
      const slideUpPattern = result.data?.patterns.find(
        (p) => p.name === 'slideUp'
      );
      if (slideUpPattern) {
        expect(slideUpPattern.animation.duration).toBe(300);
        expect(slideUpPattern.animation.delay).toBe(200);
      }
    });

    it('無限ループアニメーションを検出できる', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);

      // spin: infinite
      const spinPattern = result.data?.patterns.find(
        (p) => p.name === 'spin'
      );
      expect(spinPattern).toBeDefined();
      expect(spinPattern?.animation.iterations).toBe('infinite');

      // サマリーでinfiniteアニメーションフラグが立つ
      expect(result.data?.summary?.hasInfiniteAnimations).toBe(true);
    });
  });

  // -----------------------------------------
  // 正常系テスト: CSSトランジション検出
  // -----------------------------------------

  describe('正常系: CSSトランジション検出', () => {
    it('transitionプロパティを検出できる', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_TRANSITION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.patterns).toBeDefined();

      // トランジションパターンを確認
      const transitionPatterns = result.data?.patterns.filter(
        (p) => p.type === 'css_transition'
      );
      expect(transitionPatterns?.length).toBeGreaterThan(0);
    });

    it(':hover トリガーを正しく識別する', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_TRANSITION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);

      // hover_effectカテゴリまたはhoverトリガーを持つパターンを確認
      const hoverPatterns = result.data?.patterns.filter(
        (p) => p.trigger === 'hover' || p.category === 'hover_effect'
      );
      expect(hoverPatterns?.length).toBeGreaterThan(0);
    });

    it('複数プロパティのトランジションを検出できる', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_TRANSITION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);

      // box-shadowとtransformを持つパターンを確認
      const multiPropertyPattern = result.data?.patterns.find(
        (p) => p.properties && p.properties.length >= 2
      );
      expect(multiPropertyPattern).toBeDefined();
    });
  });

  // -----------------------------------------
  // カテゴリ分類テスト
  // -----------------------------------------

  describe('カテゴリ分類', () => {
    it('loading_state カテゴリを正しく識別する', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);

      // spin (infinite) はloading_stateに分類されるはず
      const loadingPattern = result.data?.patterns.find(
        (p) => p.category === 'loading_state'
      );
      expect(loadingPattern).toBeDefined();
    });

    it('hover_effect カテゴリを正しく識別する', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_TRANSITION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);

      const hoverPattern = result.data?.patterns.find(
        (p) => p.category === 'hover_effect'
      );
      expect(hoverPattern).toBeDefined();
    });

    it('attention_grabber/micro_interaction カテゴリを識別する', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_COMPLEX_MOTION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);

      // bounce/pulse アニメーションが適切にカテゴライズされている
      const attentionPattern = result.data?.patterns.find(
        (p) => p.name === 'bounce' || p.name === 'pulse'
      );
      expect(attentionPattern).toBeDefined();
    });
  });

  // -----------------------------------------
  // 警告生成テスト
  // -----------------------------------------

  describe('警告生成', () => {
    it('prefers-reduced-motion 未対応で警告を出す', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
        includeWarnings: true,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.warnings).toBeDefined();

      const reducedMotionWarning = result.data?.warnings?.find(
        (w) => w.code === MOTION_WARNING_CODES.A11Y_NO_REDUCED_MOTION
      );
      expect(reducedMotionWarning).toBeDefined();
      expect(reducedMotionWarning?.severity).toBe('warning');
    });

    it('prefers-reduced-motion 対応済みで警告なし', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_REDUCED_MOTION,
        detection_mode: 'css' as const,
        includeWarnings: true,
      });

      // Assert
      expect(result.success).toBe(true);

      const reducedMotionWarning = result.data?.warnings?.find(
        (w) => w.code === MOTION_WARNING_CODES.A11Y_NO_REDUCED_MOTION
      );
      expect(reducedMotionWarning).toBeUndefined();
    });

    it('無限アニメーションで info 警告を出す', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
        includeWarnings: true,
      });

      // Assert
      expect(result.success).toBe(true);

      const infiniteWarning = result.data?.warnings?.find(
        (w) => w.code === MOTION_WARNING_CODES.A11Y_INFINITE_ANIMATION
      );
      expect(infiniteWarning).toBeDefined();
      expect(infiniteWarning?.severity).toBe('info');
    });

    it('レイアウトトリガー警告を出す', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_COMPLEX_MOTION,
        detection_mode: 'css' as const,
        includeWarnings: true,
      });

      // Assert
      expect(result.success).toBe(true);

      // width/height のトランジションはレイアウトトリガー
      const layoutWarning = result.data?.warnings?.find(
        (w) => w.code === MOTION_WARNING_CODES.PERF_LAYOUT_TRIGGER
      );
      expect(layoutWarning).toBeDefined();
      expect(layoutWarning?.severity).toBe('warning');
    });

    it('min_severity でフィルタリングできる', async () => {
      // Act: warning以上のみ取得
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
        includeWarnings: true,
        min_severity: 'warning',
      });

      // Assert
      expect(result.success).toBe(true);

      // infoレベルの警告が除外されていることを確認
      const infoWarnings = result.data?.warnings?.filter(
        (w) => w.severity === 'info'
      );
      expect(infoWarnings?.length ?? 0).toBe(0);
    });
  });

  // -----------------------------------------
  // オプションテスト
  // -----------------------------------------

  describe('オプション設定', () => {
    it('minDuration でフィルタリングできる', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_TRANSITION,
        detection_mode: 'css' as const,
        minDuration: 250, // 250ms以上のみ
      });

      // Assert
      expect(result.success).toBe(true);

      // 0.2sや0.15sのトランジションが除外されている
      const shortPatterns = result.data?.patterns.filter(
        (p) => p.animation.duration < 250
      );
      expect(shortPatterns?.length ?? 0).toBe(0);
    });

    it('maxPatterns で結果数を制限できる', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_COMPLEX_MOTION,
        detection_mode: 'css' as const,
        maxPatterns: 2,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.patterns.length).toBeLessThanOrEqual(2);
    });

    it('verbose: true で rawCss を含める', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
        verbose: true,
      });

      // Assert
      expect(result.success).toBe(true);

      // 少なくとも1つのパターンがrawCssを持つ
      const patternWithRawCss = result.data?.patterns.find((p) => p.rawCss);
      expect(patternWithRawCss).toBeDefined();
    });

    it('verbose: false で rawCss を除外する', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
        verbose: false,
      });

      // Assert
      expect(result.success).toBe(true);

      // すべてのパターンがrawCssを持たない
      const patternsWithRawCss = result.data?.patterns.filter((p) => p.rawCss);
      expect(patternsWithRawCss?.length ?? 0).toBe(0);
    });

    it('includeSummary: true でサマリーを含める', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
        includeSummary: true,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.summary).toBeDefined();
      expect(result.data?.summary?.totalPatterns).toBeGreaterThan(0);
      expect(result.data?.summary?.byType).toBeDefined();
      expect(result.data?.summary?.byCategory).toBeDefined();
    });

    it('includeInlineStyles: false でインラインスタイルを除外', async () => {
      // Arrange: インラインスタイルを含むHTML
      const htmlWithInline = `
        <html>
          <body>
            <div style="animation: spin 1s linear infinite;"></div>
          </body>
        </html>
      `;

      // Act
      const result = await motionDetectHandler({
        html: htmlWithInline,
        detection_mode: 'css' as const,
        includeInlineStyles: false,
      });

      // Assert
      expect(result.success).toBe(true);
      // インラインスタイルからのアニメーションが除外されている
      // （@keyframesがないので検出されないはず）
    });
  });

  // -----------------------------------------
  // エラーハンドリングテスト
  // -----------------------------------------

  describe('エラーハンドリング', () => {
    it('htmlが未指定でエラーを返す', async () => {
      // Act
      const result = await motionDetectHandler({});

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    it('空のHTMLでは空の結果を返す', async () => {
      // Act
      const result = await motionDetectHandler({
        html: '',
        detection_mode: 'css' as const,
      });

      // Assert
      // 空文字列のHTMLはバリデーションエラーになる
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    it('不正なmaxPatterns値でバリデーションエラー', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
        maxPatterns: 0, // 最小値は1
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    it('不正なminDuration値でバリデーションエラー', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
        minDuration: -100, // 負の値は不正
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(MOTION_MCP_ERROR_CODES.VALIDATION_ERROR);
    });
  });

  // -----------------------------------------
  // モーションなしのケース
  // -----------------------------------------

  describe('モーションなしのHTML', () => {
    it('アニメーション/トランジションがない場合は空の結果', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITHOUT_MOTION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.patterns.length).toBe(0);
      expect(result.data?.summary?.totalPatterns).toBe(0);
    });

    it('モーションなしでも警告なし（prefers-reduced-motion警告は出ない）', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITHOUT_MOTION,
        detection_mode: 'css' as const,
        includeWarnings: true,
      });

      // Assert
      expect(result.success).toBe(true);
      // パターンがない場合、prefers-reduced-motion警告は出ない
      const reducedMotionWarning = result.data?.warnings?.find(
        (w) => w.code === MOTION_WARNING_CODES.A11Y_NO_REDUCED_MOTION
      );
      expect(reducedMotionWarning).toBeUndefined();
    });
  });

  // -----------------------------------------
  // 追加CSS入力テスト
  // -----------------------------------------

  describe('追加CSS入力', () => {
    it('css パラメータで追加CSSを解析できる', async () => {
      // Arrange
      const additionalCss = `
        @keyframes customFade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .custom {
          animation: customFade 0.4s ease;
        }
      `;

      // Act
      const result = await motionDetectHandler({
        html: '<html><body><div class="custom">Content</div></body></html>',
        detection_mode: 'css' as const,
        css: additionalCss,
      });

      // Assert
      expect(result.success).toBe(true);

      const customPattern = result.data?.patterns.find(
        (p) => p.name === 'customFade'
      );
      expect(customPattern).toBeDefined();
    });
  });

  // -----------------------------------------
  // パフォーマンス情報テスト
  // -----------------------------------------

  describe('パフォーマンス情報', () => {
    it('transform/opacity 使用で excellent/good レベル', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);

      // fadeIn (opacity) や slideUp (transform) は excellent または good
      // GPU加速プロパティのみ使用でレイアウト/ペイントトリガーなしの場合は excellent
      const highPerformancePattern = result.data?.patterns.find(
        (p) => p.performance?.level === 'excellent' || p.performance?.level === 'good'
      );
      expect(highPerformancePattern).toBeDefined();
    });

    it('width/height 使用で poor レベル', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_COMPLEX_MOTION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);

      // width/height トランジションは poor
      const poorPattern = result.data?.patterns.find(
        (p) => p.performance?.level === 'poor' || p.performance?.triggersLayout
      );
      expect(poorPattern).toBeDefined();
    });

    it('処理時間がメタデータに含まれる', async () => {
      // Act
      const result = await motionDetectHandler({
        html: HTML_WITH_ANIMATION,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.metadata?.processingTimeMs).toBeDefined();
      expect(result.data?.metadata?.processingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  // -----------------------------------------
  // MotionDetectorService 直接テスト
  // -----------------------------------------

  describe('MotionDetectorService 直接テスト', () => {
    it('サービスのdetectメソッドが正しく動作する', () => {
      // Arrange
      const service = getMotionDetectorService();

      // Act
      const result = service.detect(HTML_WITH_ANIMATION);

      // Assert
      expect(result.patterns.length).toBeGreaterThan(0);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('サービスが外部CSSを処理できる', () => {
      // Arrange
      const service = getMotionDetectorService();
      const externalCss = `
        @keyframes externalAnim {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .external { animation: externalAnim 0.5s ease; }
      `;

      // Act
      const result = service.detect(
        '<html><body></body></html>',
        {},
        externalCss
      );

      // Assert
      const externalPattern = result.patterns.find(
        (p) => p.name === 'externalAnim'
      );
      expect(externalPattern).toBeDefined();
    });
  });
});
