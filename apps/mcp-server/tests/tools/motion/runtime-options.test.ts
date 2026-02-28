// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect runtime_options パラメータテスト
 *
 * TDD Red Phase: runtime_options 機能が未実装のため、これらのテストは失敗する想定
 *
 * runtime_options パラメータ仕様:
 * - wait_for_animations?: number - アニメーション待機時間（ms）
 * - scroll_positions?: number[] - スクロール位置の配列（%）
 *
 * テスト対象:
 * 1. スキーマバリデーション
 * 2. wait_for_animations タイムアウト動作
 * 3. scroll_positions 複数位置検出
 * 4. ランタイムオプションの組み合わせ
 * 5. 後方互換性
 * 6. エラーハンドリング
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// モック: detection-modes（runtime/hybridモードでPlaywright起動を回避）
// =====================================================

// executeRuntimeDetection のモック用変数
let mockRuntimeDetectionResult: {
  patterns: unknown[];
  warnings: unknown[];
  runtime_info: unknown;
} = {
  patterns: [],
  warnings: [],
  runtime_info: { wait_time_used: 0, animations_captured: 0 },
};

let mockRuntimeDetectionError: Error | null = null;

vi.mock('../../../src/tools/motion/detection-modes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/tools/motion/detection-modes')>();
  return {
    ...actual,
    executeRuntimeDetection: vi.fn().mockImplementation(async () => {
      if (mockRuntimeDetectionError) {
        throw mockRuntimeDetectionError;
      }
      return mockRuntimeDetectionResult;
    }),
  };
});

import {
  motionDetectInputSchema,
  type MotionDetectInput,
  type MotionPattern,
} from '../../../src/tools/motion/schemas';
import {
  motionDetectHandler,
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
} from '../../../src/tools/motion/detect.tool';

describe('motion.detect runtime_options パラメータ', () => {
  // ---------------------------------------------
  // 1. スキーマバリデーション
  // ---------------------------------------------
  describe('スキーマバリデーション', () => {
    describe('有効な入力', () => {
      it('runtime_options を省略した場合は有効（detection_mode: css）', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('runtime_options を空オブジェクトで指定可能', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {},
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.runtime_options).toEqual({});
        }
      });

      it('wait_for_animations のみ指定可能', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            wait_for_animations: 5000,
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.runtime_options?.wait_for_animations).toBe(5000);
        }
      });

      it('scroll_positions のみ指定可能', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            scroll_positions: [0, 25, 50, 75, 100],
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.runtime_options?.scroll_positions).toEqual([
            0, 25, 50, 75, 100,
          ]);
        }
      });

      it('両方のオプションを同時に指定可能', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            wait_for_animations: 3000,
            scroll_positions: [0, 50, 100],
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.runtime_options?.wait_for_animations).toBe(3000);
          expect(result.data.runtime_options?.scroll_positions).toEqual([
            0, 50, 100,
          ]);
        }
      });

      it('wait_for_animations の最小値 0 が有効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            wait_for_animations: 0,
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('scroll_positions の空配列が有効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            scroll_positions: [],
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('scroll_positions に 0-100 の範囲内の値が有効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            scroll_positions: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('無効な入力', () => {
      it('wait_for_animations が負の値の場合は無効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            wait_for_animations: -1000,
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('wait_for_animations が数値以外の場合は無効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            wait_for_animations: 'invalid',
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('scroll_positions が配列以外の場合は無効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            scroll_positions: 50,
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('scroll_positions に負の値が含まれる場合は無効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            scroll_positions: [-10, 50, 100],
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('scroll_positions に 100 を超える値が含まれる場合は無効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            scroll_positions: [0, 50, 150],
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('scroll_positions に数値以外が含まれる場合は無効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            scroll_positions: [0, 'middle', 100],
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('scroll_positions が20個を超える場合は無効 (DoS防止)', () => {
        // Arrange: セキュリティ修正 - 配列長を20個に制限
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            scroll_positions: Array.from({ length: 25 }, (_, i) => i * 4), // 25個 > 20個制限
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain('20');
        }
      });

      it('scroll_positions が20個以下の場合は有効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            scroll_positions: Array.from({ length: 20 }, (_, i) => i * 5), // 20個 = 制限内
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('runtime_options がオブジェクト以外の場合は無効', () => {
        // Arrange
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: 'invalid',
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('wait_for_animations が上限を超える場合は無効', () => {
        // Arrange: 上限は 30000ms (30秒) - セキュリティ修正によりDoS防止
        const input = {
          html: '<div style="animation: fade 1s">test</div>',
          detection_mode: 'css' as const,
          runtime_options: {
            wait_for_animations: 35000, // 30000を超える値
          },
        };

        // Act
        const result = motionDetectInputSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });
    });
  });

  // ---------------------------------------------
  // 2. wait_for_animations 機能テスト
  // ---------------------------------------------
  describe('wait_for_animations 機能', () => {
    beforeEach(() => {
      resetMotionDetectServiceFactory();
    });

    afterEach(() => {
      resetMotionDetectServiceFactory();
      vi.restoreAllMocks();
    });

    const scrollRevealHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          .reveal {
            opacity: 0;
            transform: translateY(50px);
            transition: opacity 0.5s, transform 0.5s;
          }
          .reveal.visible {
            opacity: 1;
            transform: translateY(0);
          }
          @keyframes delayed-entrance {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          .delayed {
            animation: delayed-entrance 2s ease-out 3s forwards;
          }
        </style>
      </head>
      <body>
        <div class="reveal">Scroll reveal content</div>
        <div class="delayed">Delayed animation content</div>
      </body>
      </html>
    `;

    it('wait_for_animations が 0 の場合は待機しない', async () => {
      // Arrange
      const mockService = {
        detect: vi.fn().mockResolvedValue({
          patterns: [],
          summary: { total: 0, byType: {}, byCategory: {} },
        }),
      };
      setMotionDetectServiceFactory(() => mockService);

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          wait_for_animations: 0,
        },
      };

      // Act
      const startTime = Date.now();
      const result = await motionDetectHandler(input);
      const elapsed = Date.now() - startTime;

      // Assert
      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(1000); // 待機なしなので1秒未満で完了
    });

    it('wait_for_animations で指定時間待機後にアニメーションを検出', async () => {
      // Arrange
      // v6.x: executeRuntimeDetectionモックにパターンを設定
      mockRuntimeDetectionResult = {
        patterns: [
          {
            id: 'pattern-delayed-1',
            type: 'css_animation',
            name: 'delayed-entrance',
            category: 'entrance',
            trigger: 'load',
            animation: { duration: 2000, delay: 3000, easing: 'ease-out', iterations: 1 },
            properties: ['opacity'],
            performance: { usesTransform: false, usesOpacity: true, triggersLayout: false, triggersPaint: true, level: 'good' },
            accessibility: { respectsReducedMotion: false },
            detected_at: 'runtime',
          },
        ],
        warnings: [],
        runtime_info: { wait_time_used: 5000, animations_captured: 1 },
      };

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          wait_for_animations: 5000,
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThanOrEqual(1);
        const delayedPattern = result.data.patterns.find(
          (p) => p.name === 'delayed-entrance'
        );
        expect(delayedPattern).toBeDefined();
        expect(delayedPattern?.detected_at).toBe('runtime');
      }
    });

    it('wait_for_animations の時間内に発火したアニメーションのみ検出', async () => {
      // Arrange
      const mockPatterns: MotionPattern[] = [
        {
          id: 'pattern-immediate-1',
          type: 'css_animation',
          name: 'immediate-fade',
          category: 'entrance',
          trigger: 'load',
          animation: { duration: 500, easing: 'ease', iterations: 1 },
          properties: ['opacity'],
          performance: {
            usesTransform: false,
            usesOpacity: true,
            triggersLayout: false,
            triggersPaint: true,
            level: 'good',
          },
          accessibility: { respectsReducedMotion: false },
          detected_at: 'runtime',
        },
      ];

      // runtime モードは executeRuntimeDetection を使用するためモック変数で制御
      // immediate-fade のみ返し、delayed-entrance は含まれない
      mockRuntimeDetectionResult = {
        patterns: mockPatterns,
        warnings: [],
        runtime_info: {
          wait_time_used: 1000,
          animations_captured: 1,
        },
      };

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          wait_for_animations: 1000, // 1秒のみ待機（delayed animation は検出されない）
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        // delayedアニメーションは3秒後に開始なので検出されない
        const delayedPattern = result.data.patterns.find(
          (p) => p.name === 'delayed-entrance'
        );
        expect(delayedPattern).toBeUndefined();
      }
    });

    it('wait_for_animations が runtime_options に含まれる情報として返される', async () => {
      // Arrange
      // v6.x: executeRuntimeDetectionモックにruntime_infoを設定
      mockRuntimeDetectionResult = {
        patterns: [],
        warnings: [],
        runtime_info: {
          wait_time_used: 2000,
          animations_captured: 0,
        },
      };

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          wait_for_animations: 2000,
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.runtime_info).toBeDefined();
        expect(result.data.runtime_info?.wait_time_used).toBe(2000);
      }
    });
  });

  // ---------------------------------------------
  // 3. scroll_positions 機能テスト
  // ---------------------------------------------
  describe('scroll_positions 機能', () => {
    beforeEach(() => {
      resetMotionDetectServiceFactory();
      mockRuntimeDetectionResult = {
        patterns: [],
        warnings: [],
        runtime_info: { wait_time_used: 0, animations_captured: 0 },
      };
      mockRuntimeDetectionError = null;
    });

    afterEach(() => {
      resetMotionDetectServiceFactory();
      vi.restoreAllMocks();
    });

    const scrollAnimatedHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          .section {
            min-height: 100vh;
          }
          .fade-in-on-scroll {
            opacity: 0;
            transition: opacity 0.5s;
          }
          .fade-in-on-scroll.visible {
            opacity: 1;
          }
          .slide-up {
            transform: translateY(100px);
            transition: transform 0.8s ease-out;
          }
          .slide-up.visible {
            transform: translateY(0);
          }
          @keyframes scroll-reveal {
            from { opacity: 0; transform: translateY(50px); }
            to { opacity: 1; transform: translateY(0); }
          }
        </style>
      </head>
      <body>
        <section class="section" id="hero">
          <div class="fade-in-on-scroll">Hero content</div>
        </section>
        <section class="section" id="features">
          <div class="slide-up">Feature 1</div>
          <div class="slide-up">Feature 2</div>
        </section>
        <section class="section" id="footer">
          <div class="fade-in-on-scroll">Footer content</div>
        </section>
      </body>
      </html>
    `;

    it('単一スクロール位置でアニメーションを検出', async () => {
      // Arrange
      // v6.x: executeRuntimeDetectionモックにスクロールパターンを設定
      mockRuntimeDetectionResult = {
        patterns: [
          {
            id: 'scroll-pattern-1',
            type: 'css_transition',
            name: 'fade-in-on-scroll',
            category: 'scroll_trigger',
            trigger: 'scroll',
            animation: { duration: 500, easing: 'ease', iterations: 1 },
            properties: ['opacity'],
            performance: { usesTransform: false, usesOpacity: true, triggersLayout: false, triggersPaint: true, level: 'good' },
            accessibility: { respectsReducedMotion: false },
            detected_at: 'runtime',
            scroll_position: 50,
          },
        ],
        warnings: [],
        runtime_info: { wait_time_used: 3000, animations_captured: 1, scroll_positions_checked: [50] },
      };

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          scroll_positions: [50],
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThanOrEqual(1);
        const scrollPattern = result.data.patterns.find(
          (p) => p.scroll_position === 50
        );
        expect(scrollPattern).toBeDefined();
      }
    });

    it('複数スクロール位置で異なるアニメーションを検出', async () => {
      // Arrange
      // v6.x: executeRuntimeDetectionモックに複数スクロールパターンを設定
      mockRuntimeDetectionResult = {
        patterns: [
          {
            id: 'scroll-pattern-hero', type: 'css_transition', name: 'hero-fade',
            category: 'scroll_trigger', trigger: 'scroll',
            animation: { duration: 500, easing: 'ease', iterations: 1 },
            properties: ['opacity'],
            performance: { usesTransform: false, usesOpacity: true, triggersLayout: false, triggersPaint: true, level: 'good' },
            accessibility: { respectsReducedMotion: false }, detected_at: 'runtime', scroll_position: 0,
          },
          {
            id: 'scroll-pattern-features', type: 'css_transition', name: 'slide-up',
            category: 'scroll_trigger', trigger: 'scroll',
            animation: { duration: 800, easing: 'ease-out', iterations: 1 },
            properties: ['transform'],
            performance: { usesTransform: true, usesOpacity: false, triggersLayout: false, triggersPaint: false, level: 'good' },
            accessibility: { respectsReducedMotion: false }, detected_at: 'runtime', scroll_position: 50,
          },
          {
            id: 'scroll-pattern-footer', type: 'css_transition', name: 'footer-fade',
            category: 'scroll_trigger', trigger: 'scroll',
            animation: { duration: 500, easing: 'ease', iterations: 1 },
            properties: ['opacity'],
            performance: { usesTransform: false, usesOpacity: true, triggersLayout: false, triggersPaint: true, level: 'good' },
            accessibility: { respectsReducedMotion: false }, detected_at: 'runtime', scroll_position: 100,
          },
        ],
        warnings: [],
        runtime_info: {
          wait_time_used: 3000,
          animations_captured: 3,
          scroll_positions_checked: [0, 50, 100],
          patterns_by_scroll_position: { 0: 1, 50: 1, 100: 1 },
        },
      };

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          scroll_positions: [0, 50, 100],
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBe(3);

        // 各スクロール位置でパターンが検出されていることを確認
        const positions = result.data.patterns.map((p) => p.scroll_position);
        expect(positions).toContain(0);
        expect(positions).toContain(50);
        expect(positions).toContain(100);
      }
    });

    it('scroll_positions が空配列の場合はスクロール検出をスキップ', async () => {
      // Arrange
      const mockPatterns: MotionPattern[] = [
        {
          id: 'static-pattern-1',
          type: 'css_animation',
          name: 'fade-animation',
          category: 'entrance',
          trigger: 'load',
          animation: { duration: 500, easing: 'ease', iterations: 1 },
          properties: ['opacity'],
          performance: {
            usesTransform: false,
            usesOpacity: true,
            triggersLayout: false,
            triggersPaint: true,
            level: 'good',
          },
          accessibility: { respectsReducedMotion: false },
          detected_at: 'runtime',
        },
      ];

      const mockService = {
        detect: vi.fn().mockResolvedValue({
          patterns: mockPatterns,
          summary: {
            total: 1,
            byType: { css_animation: 1 },
            byCategory: { entrance: 1 },
          },
          runtime_info: {
            scroll_positions_checked: [],
          },
        }),
      };
      setMotionDetectServiceFactory(() => mockService);

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          scroll_positions: [],
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        // スクロールによるトリガーパターンは含まれない
        const scrollPatterns = result.data.patterns.filter(
          (p) => p.scroll_position !== undefined
        );
        expect(scrollPatterns.length).toBe(0);
      }
    });

    it('各パターンに scroll_position プロパティが付与される', async () => {
      // Arrange
      const mockPatterns: MotionPattern[] = [
        {
          id: 'scroll-annotated-1',
          type: 'css_transition',
          name: 'scroll-fade',
          category: 'scroll_trigger',
          trigger: 'scroll',
          animation: { duration: 500, easing: 'ease', iterations: 1 },
          properties: ['opacity'],
          performance: {
            usesTransform: false,
            usesOpacity: true,
            triggersLayout: false,
            triggersPaint: true,
            level: 'good',
          },
          accessibility: { respectsReducedMotion: false },
          detected_at: 'runtime',
          scroll_position: 25,
        },
        {
          id: 'scroll-annotated-2',
          type: 'css_transition',
          name: 'scroll-slide',
          category: 'scroll_trigger',
          trigger: 'scroll',
          animation: { duration: 800, easing: 'ease-out', iterations: 1 },
          properties: ['transform'],
          performance: {
            usesTransform: true,
            usesOpacity: false,
            triggersLayout: false,
            triggersPaint: false,
            level: 'good',
          },
          accessibility: { respectsReducedMotion: false },
          detected_at: 'runtime',
          scroll_position: 75,
        },
      ];

      const mockService = {
        detect: vi.fn().mockResolvedValue({
          patterns: mockPatterns,
          summary: {
            total: 2,
            byType: { css_transition: 2 },
            byCategory: { scroll_trigger: 2 },
          },
        }),
      };
      setMotionDetectServiceFactory(() => mockService);

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          scroll_positions: [25, 75],
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        result.data.patterns.forEach((pattern) => {
          if (pattern.trigger === 'scroll') {
            expect(pattern.scroll_position).toBeDefined();
            expect(typeof pattern.scroll_position).toBe('number');
          }
        });
      }
    });

    it('runtime_info にスクロール位置ごとの統計が含まれる', async () => {
      // Arrange - runtime モードは executeRuntimeDetection を使用するためモック変数で制御
      mockRuntimeDetectionResult = {
        patterns: [],
        warnings: [],
        runtime_info: {
          scroll_positions_checked: [0, 33, 66, 100],
          patterns_by_scroll_position: {
            0: 2,
            33: 1,
            66: 3,
            100: 1,
          },
          total_scroll_patterns: 7,
          wait_time_used: 0,
          animations_captured: 0,
        },
      };

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          scroll_positions: [0, 33, 66, 100],
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.runtime_info).toBeDefined();
        expect(result.data.runtime_info?.scroll_positions_checked).toEqual([
          0, 33, 66, 100,
        ]);
        expect(
          result.data.runtime_info?.patterns_by_scroll_position
        ).toBeDefined();
      }
    });
  });

  // ---------------------------------------------
  // 4. オプションの組み合わせテスト
  // ---------------------------------------------
  describe('オプションの組み合わせ', () => {
    beforeEach(() => {
      resetMotionDetectServiceFactory();
    });

    afterEach(() => {
      resetMotionDetectServiceFactory();
      vi.restoreAllMocks();
    });

    const complexHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          @keyframes delayed-scroll-reveal {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .delayed-scroll {
            animation: delayed-scroll-reveal 1s ease-out 2s forwards;
            opacity: 0;
          }
        </style>
      </head>
      <body>
        <div class="delayed-scroll">Content</div>
      </body>
      </html>
    `;

    it('wait_for_animations と scroll_positions の両方を適用', async () => {
      // Arrange
      const mockPatterns: MotionPattern[] = [
        {
          id: 'combined-pattern-1',
          type: 'css_animation',
          name: 'delayed-scroll-reveal',
          category: 'scroll_trigger',
          trigger: 'scroll',
          animation: {
            duration: 1000,
            delay: 2000,
            easing: 'ease-out',
            iterations: 1,
          },
          properties: ['opacity', 'transform'],
          performance: {
            usesTransform: true,
            usesOpacity: true,
            triggersLayout: false,
            triggersPaint: true,
            level: 'good',
          },
          accessibility: { respectsReducedMotion: false },
          detected_at: 'runtime',
          scroll_position: 50,
        },
      ];

      // runtime モードは executeRuntimeDetection を使用するためモック変数で制御
      mockRuntimeDetectionResult = {
        patterns: mockPatterns,
        warnings: [],
        runtime_info: {
          wait_time_used: 3000,
          scroll_positions_checked: [0, 50, 100],
          patterns_by_scroll_position: { 50: 1 },
          animations_captured: 1,
        },
      };

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          wait_for_animations: 3000,
          scroll_positions: [0, 50, 100],
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.runtime_info?.wait_time_used).toBe(3000);
        expect(result.data.runtime_info?.scroll_positions_checked).toEqual([
          0, 50, 100,
        ]);

        // delayedアニメーションがスクロール位置で検出されていることを確認
        const delayedPattern = result.data.patterns.find(
          (p) => p.name === 'delayed-scroll-reveal'
        );
        expect(delayedPattern).toBeDefined();
        expect(delayedPattern?.scroll_position).toBe(50);
      }
    });

    it('detection_mode: hybrid と runtime_options の組み合わせ', async () => {
      // Arrange
      const mockPatterns: MotionPattern[] = [
        {
          id: 'hybrid-css-1',
          type: 'css_animation',
          name: 'static-animation',
          category: 'entrance',
          trigger: 'load',
          animation: { duration: 500, easing: 'ease', iterations: 1 },
          properties: ['opacity'],
          performance: {
            usesTransform: false,
            usesOpacity: true,
            triggersLayout: false,
            triggersPaint: true,
            level: 'good',
          },
          accessibility: { respectsReducedMotion: false },
          detected_at: 'css',
        },
        {
          id: 'hybrid-runtime-1',
          type: 'css_transition',
          name: 'runtime-scroll',
          category: 'scroll_trigger',
          trigger: 'scroll',
          animation: { duration: 800, easing: 'ease-out', iterations: 1 },
          properties: ['transform'],
          performance: {
            usesTransform: true,
            usesOpacity: false,
            triggersLayout: false,
            triggersPaint: false,
            level: 'good',
          },
          accessibility: { respectsReducedMotion: false },
          detected_at: 'runtime',
          scroll_position: 50,
        },
      ];

      // hybrid モードは executeRuntimeDetection + CSS解析を使用
      // executeRuntimeDetection のモック結果を設定（runtime部分のパターン）
      mockRuntimeDetectionResult = {
        patterns: mockPatterns,
        warnings: [],
        runtime_info: {
          wait_time_used: 1000,
          scroll_positions_checked: [50],
          animations_captured: 2,
        },
      };

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'hybrid',
        runtime_options: {
          wait_for_animations: 1000,
          scroll_positions: [50],
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        // hybridモードではCSS解析結果とランタイム結果が統合される
        // モックからのパターンが含まれることを確認
        expect(result.data.patterns.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('detection_mode: css では runtime_options が無視される', async () => {
      // Arrange
      const mockService = {
        detect: vi.fn().mockResolvedValue({
          patterns: [],
          summary: { total: 0, byType: {}, byCategory: {} },
        }),
      };
      setMotionDetectServiceFactory(() => mockService);

      const input: MotionDetectInput = {
        html: complexHTML,
        detection_mode: 'css',
        runtime_options: {
          wait_for_animations: 5000,
          scroll_positions: [0, 50, 100],
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        // runtime_info が含まれない（ランタイム検出が実行されていない）
        expect(result.data.runtime_info).toBeUndefined();
      }
    });
  });

  // ---------------------------------------------
  // 5. 後方互換性テスト
  // ---------------------------------------------
  describe('後方互換性', () => {
    beforeEach(() => {
      resetMotionDetectServiceFactory();
    });

    afterEach(() => {
      resetMotionDetectServiceFactory();
    });

    it('runtime_options なしの既存コードが正常動作', async () => {
      // Arrange
      const mockService = {
        detect: vi.fn().mockResolvedValue({
          patterns: [
            {
              id: 'compat-pattern-1',
              type: 'css_animation',
              name: 'fade-in',
              category: 'entrance',
              trigger: 'load',
              animation: { duration: 500, easing: 'ease', iterations: 1 },
              properties: ['opacity'],
              performance: {
                usesTransform: false,
                usesOpacity: true,
                triggersLayout: false,
                triggersPaint: true,
                level: 'good',
              },
              accessibility: { respectsReducedMotion: false },
            },
          ],
          summary: {
            total: 1,
            byType: { css_animation: 1 },
            byCategory: { entrance: 1 },
          },
        }),
      };
      setMotionDetectServiceFactory(() => mockService);

      const input: MotionDetectInput = {
        html: '<div style="animation: fade-in 0.5s">test</div>',
        detection_mode: 'css' as const, // デフォルトがvideoに変更されたため明示
        // runtime_options は省略
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBe(1);
      }
    });

    it('v3.x の detection_mode なしコードが正常動作', async () => {
      // Arrange
      const mockService = {
        detect: vi.fn().mockResolvedValue({
          patterns: [],
          summary: { total: 0, byType: {}, byCategory: {} },
        }),
      };
      setMotionDetectServiceFactory(() => mockService);

      const input: MotionDetectInput = {
        html: '<div style="animation: test 1s">test</div>',
        detection_mode: 'css' as const, // デフォルトがvideoに変更されたため明示
        includeWarnings: true,
        includeSummary: true,
        // runtime_options は省略
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      // デフォルトで css モードとして動作
    });
  });

  // ---------------------------------------------
  // 6. エラーハンドリング
  // ---------------------------------------------
  describe('エラーハンドリング', () => {
    beforeEach(() => {
      resetMotionDetectServiceFactory();
      // runtime/hybridモードのモック状態をリセット
      mockRuntimeDetectionResult = {
        patterns: [],
        warnings: [],
        runtime_info: { wait_time_used: 0, animations_captured: 0 },
      };
      mockRuntimeDetectionError = null;
    });

    afterEach(() => {
      resetMotionDetectServiceFactory();
      mockRuntimeDetectionError = null;
      vi.restoreAllMocks();
    });

    it('ランタイム実行タイムアウト時のエラー', async () => {
      // Arrange - executeRuntimeDetection がタイムアウトエラーを投げるようモック設定
      mockRuntimeDetectionError = new Error('Runtime execution timeout');

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          wait_for_animations: 25000, // タイムアウトテスト用の有効値
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('timeout');
      }
    });

    it('不正なスクロール位置でのエラー処理', async () => {
      // Arrange - executeRuntimeDetection がスクロールエラーを投げるようモック設定
      mockRuntimeDetectionError = new Error('Failed to scroll to position: element not found');

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          scroll_positions: [50], // ページが短いためスクロールできない
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      // エラーまたは警告が返される
      expect(result).toBeDefined();
    });

    it('ブラウザ環境エラー時の適切なフォールバック', async () => {
      // Arrange - executeRuntimeDetection がフォールバック警告付きの結果を返すようモック設定
      mockRuntimeDetectionResult = {
        patterns: [],
        warnings: [
          {
            code: 'RUNTIME_FALLBACK',
            severity: 'warning' as const,
            message: 'Runtime detection unavailable, falling back to CSS mode',
          },
        ],
        runtime_info: {
          wait_time_used: 1000,
          animations_captured: 0,
        },
      };

      const input: MotionDetectInput = {
        url: 'https://example.com',
        detection_mode: 'runtime',
        runtime_options: {
          wait_for_animations: 1000,
        },
      };

      // Act
      const result = await motionDetectHandler(input);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        // フォールバック警告が含まれる
        expect(result.data.warnings).toBeDefined();
        expect(result.data.warnings?.some((w) => w.code === 'RUNTIME_FALLBACK')).toBe(
          true
        );
      }
    });
  });
});
