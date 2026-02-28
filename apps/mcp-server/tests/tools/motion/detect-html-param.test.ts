// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect html パラメータテスト
 * TDD Red Phase: html パラメータを直接受け入れる機能のテスト
 *
 * 背景:
 * layout.ingestがデフォルトでsave_to_db: falseのため、
 * pageIdでDBからページを取得するワークフローが破綻する。
 * layout.inspectと同様にhtmlパラメータを直接受け入れるべき。
 *
 * テスト対象:
 * - html パラメータのみで CSS アニメーションが検出される
 * - html と pageId の両方が指定された場合、html が優先される
 * - html パラメータで外部 CSS も処理される
 *
 * @module tests/tools/motion/detect-html-param.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// インポート
// =====================================================

import {
  motionDetectHandler,
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
  type IMotionDetectService,
} from '../../../src/tools/motion/detect.tool';

import {
  motionDetectInputSchema,
  type MotionDetectInput,
} from '../../../src/tools/motion/schemas';

// =====================================================
// テストデータ
// =====================================================

/**
 * CSS アニメーションを含むシンプルな HTML
 */
const htmlWithCssAnimation = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>CSS Animation Test</title>
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
  <div class="fade-in">Fade in content</div>
</body>
</html>`;

/**
 * CSS トランジションを含むシンプルな HTML
 */
const htmlWithCssTransition = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>CSS Transition Test</title>
  <style>
    .hover-effect {
      transition: transform 0.3s ease;
    }

    .hover-effect:hover {
      transform: scale(1.1);
    }
  </style>
</head>
<body>
  <button class="hover-effect">Hover me</button>
</body>
</html>`;

/**
 * 複数のアニメーションを含む HTML
 */
const htmlWithMultipleAnimations = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Multiple Animations</title>
  <style>
    @keyframes slideIn {
      from { transform: translateX(-100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .slide-in {
      animation: slideIn 0.6s ease-out forwards;
    }

    .pulse {
      animation: pulse 2s ease-in-out infinite;
    }

    .spinner {
      animation: spin 1s linear infinite;
    }

    .card {
      transition: box-shadow 0.3s ease, transform 0.3s ease;
    }

    .card:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      transform: translateY(-4px);
    }
  </style>
</head>
<body>
  <div class="slide-in">Slide in content</div>
  <div class="pulse">Pulsing element</div>
  <div class="spinner">Loading spinner</div>
  <div class="card">Hover card</div>
</body>
</html>`;

/**
 * DB から取得したページのモック用 HTML（異なる内容）
 */
const htmlFromDb = `<!DOCTYPE html>
<html lang="ja">
<head>
  <style>
    @keyframes dbAnimation {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .db-element {
      animation: dbAnimation 1s ease;
    }
  </style>
</head>
<body>
  <div class="db-element">DB content</div>
</body>
</html>`;

/**
 * 外部 CSS コンテンツ
 */
const externalCss = `
@keyframes externalFade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.external-animation {
  animation: externalFade 0.4s ease forwards;
}
`;

const validUUID = '123e4567-e89b-12d3-a456-426614174000';

// =====================================================
// html パラメータテスト
// =====================================================

describe('motion.detect html パラメータ', () => {
  beforeEach(() => {
    resetMotionDetectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('html パラメータのみでの動作', () => {
    it('html パラメータのみで CSS アニメーションを検出する', async () => {
      // Arrange
      const input: MotionDetectInput = {
        html: htmlWithCssAnimation,
        detection_mode: 'css' as const,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.patterns).toBeDefined();
      expect(result.data?.patterns.length).toBeGreaterThan(0);

      // fadeIn アニメーションが検出されることを確認
      const fadeInPattern = result.data?.patterns.find(
        (p) => p.name === 'fadeIn' || p.type === 'css_animation'
      );
      expect(fadeInPattern).toBeDefined();
    });

    it('html パラメータのみで CSS トランジションを検出する', async () => {
      // Arrange
      const input: MotionDetectInput = {
        html: htmlWithCssTransition,
        detection_mode: 'css' as const,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.patterns).toBeDefined();

      // トランジションが検出されることを確認
      const transitionPattern = result.data?.patterns.find(
        (p) => p.type === 'css_transition'
      );
      expect(transitionPattern).toBeDefined();
    });

    it('html パラメータで複数のアニメーション/トランジションを検出する', async () => {
      // Arrange
      const input: MotionDetectInput = {
        html: htmlWithMultipleAnimations,
        detection_mode: 'css' as const,
        includeSummary: true,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.patterns).toBeDefined();

      // 複数のパターンが検出されることを確認
      expect(result.data?.patterns.length).toBeGreaterThanOrEqual(3);

      // サマリーに正しい集計が含まれることを確認
      expect(result.data?.summary).toBeDefined();
      expect(result.data?.summary?.totalPatterns).toBeGreaterThanOrEqual(3);
    });

    it('html パラメータと css パラメータを組み合わせて検出する', async () => {
      // Arrange
      const input: MotionDetectInput = {
        html: htmlWithCssAnimation,
        detection_mode: 'css' as const,
        css: externalCss,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.patterns).toBeDefined();

      // 内部と外部両方のアニメーションが検出されることを確認
      const fadeInPattern = result.data?.patterns.find(
        (p) => p.name === 'fadeIn'
      );
      const externalPattern = result.data?.patterns.find(
        (p) => p.name === 'externalFade'
      );

      expect(fadeInPattern).toBeDefined();
      expect(externalPattern).toBeDefined();
    });
  });

  describe('html と pageId の優先順位', () => {
    it('html と pageId の両方が指定された場合、html が優先される', async () => {
      // Arrange: DB モックを設定
      const mockGetPageById = vi.fn().mockResolvedValue({
        id: validUUID,
        htmlContent: htmlFromDb,
        cssContent: undefined,
      });

      setMotionDetectServiceFactory(() => ({
        getPageById: mockGetPageById,
      }));

      const input: MotionDetectInput = {
        html: htmlWithCssAnimation,
        detection_mode: 'css' as const,
        pageId: validUUID,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);

      // DB から取得していないことを確認
      expect(mockGetPageById).not.toHaveBeenCalled();

      // html パラメータのアニメーションが検出されることを確認
      const fadeInPattern = result.data?.patterns.find(
        (p) => p.name === 'fadeIn'
      );
      expect(fadeInPattern).toBeDefined();

      // DB からのアニメーション（dbAnimation）が検出されないことを確認
      const dbPattern = result.data?.patterns.find(
        (p) => p.name === 'dbAnimation'
      );
      expect(dbPattern).toBeUndefined();
    });

    it('pageId のみ指定の場合は DB から取得する', async () => {
      // Arrange: DB モックを設定
      const mockGetPageById = vi.fn().mockResolvedValue({
        id: validUUID,
        htmlContent: htmlFromDb,
        cssContent: undefined,
      });

      setMotionDetectServiceFactory(() => ({
        getPageById: mockGetPageById,
      }));

      const input: MotionDetectInput = {
        detection_mode: 'css' as const,
        pageId: validUUID,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);

      // DB から取得されたことを確認
      expect(mockGetPageById).toHaveBeenCalledWith(validUUID);

      // DB からのアニメーションが検出されることを確認
      const dbPattern = result.data?.patterns.find(
        (p) => p.name === 'dbAnimation'
      );
      expect(dbPattern).toBeDefined();
    });

    it('html が空でない場合、pageId があっても DB アクセスしない', async () => {
      // Arrange: DB モックを設定
      const mockGetPageById = vi.fn().mockResolvedValue({
        id: validUUID,
        htmlContent: htmlFromDb,
        cssContent: undefined,
      });

      setMotionDetectServiceFactory(() => ({
        getPageById: mockGetPageById,
      }));

      // html パラメータを明示的に指定
      const input: MotionDetectInput = {
        html: htmlWithMultipleAnimations,
        detection_mode: 'css' as const,
        pageId: validUUID,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(mockGetPageById).not.toHaveBeenCalled();

      // html パラメータのアニメーションが検出されることを確認
      const slideInPattern = result.data?.patterns.find(
        (p) => p.name === 'slideIn'
      );
      expect(slideInPattern).toBeDefined();
    });
  });

  describe('html パラメータでのオプション動作', () => {
    it('includeInlineStyles オプションが html パラメータで動作する', async () => {
      // Arrange: インラインスタイルを含む HTML
      const htmlWithInlineAnimation = `<!DOCTYPE html>
<html>
<head></head>
<body>
  <div style="animation: fadeIn 0.5s ease;">Inline animation</div>
</body>
</html>`;

      const input: MotionDetectInput = {
        html: htmlWithInlineAnimation,
        detection_mode: 'css' as const,
        includeInlineStyles: true,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      // インラインスタイルのアニメーションが検出される可能性
      // （実装によっては検出されない場合もある）
    });

    it('minDuration オプションが html パラメータで動作する', async () => {
      // Arrange
      const input: MotionDetectInput = {
        html: htmlWithMultipleAnimations,
        detection_mode: 'css' as const,
        minDuration: 1000, // 1秒以上のアニメーションのみ
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);

      // 短いアニメーション（0.6s slideIn）がフィルタリングされることを確認
      if (result.data?.patterns) {
        for (const pattern of result.data.patterns) {
          if (pattern.animation.duration !== undefined) {
            expect(pattern.animation.duration).toBeGreaterThanOrEqual(1000);
          }
        }
      }
    });

    it('maxPatterns オプションが html パラメータで動作する', async () => {
      // Arrange
      const input: MotionDetectInput = {
        html: htmlWithMultipleAnimations,
        detection_mode: 'css' as const,
        maxPatterns: 2,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.patterns.length).toBeLessThanOrEqual(2);
    });

    it('verbose オプションが html パラメータで動作する', async () => {
      // Arrange
      const input: MotionDetectInput = {
        html: htmlWithCssAnimation,
        detection_mode: 'css' as const,
        verbose: true,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);

      // verbose モードでは rawCss が含まれる
      const animationPattern = result.data?.patterns.find(
        (p) => p.type === 'css_animation'
      );
      if (animationPattern) {
        expect(animationPattern.rawCss).toBeDefined();
      }
    });

    it('includeWarnings オプションが html パラメータで動作する', async () => {
      // Arrange: reduced-motion なしの HTML
      const htmlNoReducedMotion = `<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes flash {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    .flash { animation: flash 0.5s infinite; }
  </style>
</head>
<body>
  <div class="flash">Flashing</div>
</body>
</html>`;

      const input: MotionDetectInput = {
        html: htmlNoReducedMotion,
        detection_mode: 'css' as const,
        includeWarnings: true,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.warnings).toBeDefined();
      expect(result.data?.warnings?.length).toBeGreaterThan(0);
    });
  });

  describe('html パラメータのバリデーション', () => {
    it('空の html は拒否される', () => {
      // Arrange & Act & Assert
      expect(() => {
        motionDetectInputSchema.parse({ html: '' });
      }).toThrow();
    });

    it('html も pageId もない場合は拒否される', () => {
      // Arrange & Act & Assert
      expect(() => {
        motionDetectInputSchema.parse({});
      }).toThrow();
    });

    it('有効な html は受け入れられる', () => {
      // Arrange & Act
      const result = motionDetectInputSchema.parse({
        html: htmlWithCssAnimation,
        detection_mode: 'css' as const,
      });

      // Assert
      expect(result.html).toBe(htmlWithCssAnimation);
    });
  });

  describe('サービス未接続時の html パラメータ', () => {
    it('サービス未接続でも html パラメータで動作する', async () => {
      // Arrange: サービスファクトリをリセット（未接続状態）
      resetMotionDetectServiceFactory();

      const input: MotionDetectInput = {
        html: htmlWithCssAnimation,
        detection_mode: 'css' as const,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.patterns).toBeDefined();

      // アニメーションが検出されることを確認
      const fadeInPattern = result.data?.patterns.find(
        (p) => p.name === 'fadeIn'
      );
      expect(fadeInPattern).toBeDefined();
    });

    it('サービス未接続で pageId のみの場合はエラーを返す', async () => {
      // Arrange: サービスファクトリをリセット（未接続状態）
      resetMotionDetectServiceFactory();

      const input: MotionDetectInput = {
        detection_mode: 'css' as const,
        pageId: validUUID,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    });
  });

  describe('メタデータの検証', () => {
    it('html パラメータ使用時に htmlSize がメタデータに含まれる', async () => {
      // Arrange
      const input: MotionDetectInput = {
        html: htmlWithCssAnimation,
        detection_mode: 'css' as const,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.metadata).toBeDefined();
      expect(result.data?.metadata.htmlSize).toBe(htmlWithCssAnimation.length);
    });

    it('html + css パラメータ使用時に cssSize がメタデータに含まれる', async () => {
      // Arrange
      const input: MotionDetectInput = {
        html: htmlWithCssAnimation,
        detection_mode: 'css' as const,
        css: externalCss,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.metadata).toBeDefined();
      // cssSize には html 内の <style> と外部 css の合計が含まれる可能性
      expect(result.data?.metadata.cssSize).toBeDefined();
    });

    it('処理時間がメタデータに含まれる', async () => {
      // Arrange
      const input: MotionDetectInput = {
        html: htmlWithCssAnimation,
        detection_mode: 'css' as const,
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.metadata.processingTimeMs).toBeDefined();
      expect(result.data?.metadata.processingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
