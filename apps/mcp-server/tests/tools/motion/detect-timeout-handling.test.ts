// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Motion検出タイムアウトハンドリングテスト
 *
 * TDD Green フェーズ: テストを通す実装
 *
 * 問題点の修正:
 * 1. motion.detectツールにtimeoutパラメータを追加 ✅
 * 2. タイムアウト時にgraceful degradationでCSS解析結果を返す ✅
 * 3. 警告（warning）にタイムアウト情報を含める ✅
 *
 * @module tests/tools/motion/detect-timeout-handling.test
 */

import { describe, it, expect } from 'vitest';

// =====================================================
// テスト: タイムアウトパラメータ
// =====================================================

describe('Motion検出タイムアウトハンドリング', () => {
  describe('タイムアウトパラメータ', () => {
    it('motion.detectツールがtimeoutパラメータを受け付ける', async () => {
      // 動的インポートでスキーマを確認
      const { motionDetectInputSchema } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      // timeoutパラメータがスキーマで受け付けられることを確認（parse成功）
      // detection_mode='css'を指定（html使用時は必須）
      const result = motionDetectInputSchema.safeParse({
        html: '<html><body></body></html>',
        timeout: 60000,
        detection_mode: 'css', // htmlを使用する場合はcssモード
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(60000);
      }

      // デフォルト値が設定されることを確認
      const resultDefault = motionDetectInputSchema.safeParse({
        html: '<html><body></body></html>',
        detection_mode: 'css', // htmlを使用する場合はcssモード
      });
      expect(resultDefault.success).toBe(true);
      if (resultDefault.success) {
        expect(resultDefault.data.timeout).toBe(180000); // 3 minutes default
      }
    });

    it('タイムアウトのデフォルト値は180秒（3分）', async () => {
      const { DEFAULT_MOTION_TIMEOUT } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      expect(DEFAULT_MOTION_TIMEOUT).toBe(180000); // 3 minutes
    });

    it('タイムアウトの最小値は30秒', async () => {
      const { MIN_MOTION_TIMEOUT } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      expect(MIN_MOTION_TIMEOUT).toBe(30000); // 30 seconds
    });

    it('タイムアウトの最小値未満はバリデーションエラー', async () => {
      const { motionDetectInputSchema } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      const result = motionDetectInputSchema.safeParse({
        html: '<html><body></body></html>',
        timeout: 1000, // 1秒 - 最小値30秒未満
        detection_mode: 'css',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('createTimeoutResponse関数', () => {
    it('タイムアウト時にエラーではなく成功レスポンスを返す', async () => {
      const { createTimeoutResponse, TimeoutWarningCode } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      // createTimeoutResponseは成功レスポンスを返す
      const result = createTimeoutResponse('css', 5000, []);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      // 警告にタイムアウト情報が含まれる
      const warnings = result.data?.warnings ?? [];
      const hasTimeoutWarning = warnings.some(
        (w) => w.code === TimeoutWarningCode.MOTION_DETECTION_TIMEOUT
      );
      expect(hasTimeoutWarning).toBe(true);
    });

    it('タイムアウト時でも部分的なパターンが返される', async () => {
      const { createTimeoutResponse, TimeoutWarningCode } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      // 部分的なパターンを渡す
      const partialPatterns = [
        {
          id: '019bcb47-638c-7531-a302-4a3af9c18aa1',
          type: 'keyframes' as const,
          name: 'fadeIn',
          animation: {
            duration: 300,
            delay: 0,
            iterations: 1,
            direction: 'normal' as const,
            fillMode: 'none' as const,
          },
          trigger: 'load' as const,
          keyframes: {
            steps: [
              { offset: 0, properties: { opacity: '0' } },
              { offset: 1, properties: { opacity: '1' } },
            ],
          },
        },
      ];

      const result = createTimeoutResponse('css', 5000, partialPatterns);

      expect(result.success).toBe(true);
      expect(result.data?.patterns.length).toBe(1);
      expect(result.data?.patterns[0].name).toBe('fadeIn');

      // PARTIAL_RESULT警告がある
      const warnings = result.data?.warnings ?? [];
      const hasPartialWarning = warnings.some(
        (w) => w.code === TimeoutWarningCode.PARTIAL_RESULT
      );
      expect(hasPartialWarning).toBe(true);
    });

    it('タイムアウト警告にはphase情報が含まれる', async () => {
      const { createTimeoutResponse } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      const result = createTimeoutResponse('video', 5000, []);

      const warnings = result.data?.warnings ?? [];
      const timeoutWarning = warnings.find(
        (w) => w.code?.includes('TIMEOUT')
      );

      // phase情報（どのフェーズでタイムアウトしたか）
      expect(timeoutWarning?.message).toMatch(/video/i);
    });

    it('タイムアウト警告には経過時間が含まれる', async () => {
      const { createTimeoutResponse } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      const result = createTimeoutResponse('css', 12345, []);

      const warnings = result.data?.warnings ?? [];
      const timeoutWarning = warnings.find(
        (w) => w.code?.includes('TIMEOUT')
      );

      // contextに経過時間情報がある
      expect(timeoutWarning?.context).toHaveProperty('elapsedMs', 12345);
    });

    it('メタデータにタイムアウト発生フラグが含まれる', async () => {
      const { createTimeoutResponse } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      const result = createTimeoutResponse('css', 5000, []);

      // メタデータにタイムアウトフラグ
      expect(result.data?.metadata?.had_timeout).toBe(true);
      expect(result.data?.metadata?.timeout_phase).toBe('css');
      expect(result.data?.metadata?.timeout_elapsed_ms).toBe(5000);
    });

    it('サマリーが正しく計算される', async () => {
      const { createTimeoutResponse } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      const patterns = [
        {
          id: '019bcb47-638c-7531-a302-4a3af9c18aa1',
          type: 'css_animation' as const,
          name: 'fadeIn',
          animation: { duration: 300, iterations: 1 },
          trigger: 'load' as const,
          keyframes: { steps: [] },
        },
        {
          id: '019bcb47-638c-7531-a302-4a3af9c18aa2',
          type: 'css_transition' as const,
          name: 'slideIn',
          animation: { duration: 500 },
          trigger: 'hover' as const,
          keyframes: { steps: [] },
        },
      ];

      const result = createTimeoutResponse('css', 5000, patterns);

      expect(result.data?.summary?.totalPatterns).toBe(2);
      expect(result.data?.summary?.hasInfiniteAnimations).toBe(false);
    });

    it('無限アニメーションの検出が正しく動作する', async () => {
      const { createTimeoutResponse } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      const patterns = [
        {
          id: '019bcb47-638c-7531-a302-4a3af9c18aa1',
          type: 'css_animation' as const,
          name: 'spin',
          animation: { duration: 1000, iterations: -1 }, // 無限アニメーション
          trigger: 'load' as const,
          keyframes: { steps: [] },
        },
      ];

      const result = createTimeoutResponse('css', 5000, patterns);

      expect(result.data?.summary?.hasInfiniteAnimations).toBe(true);
    });
  });

  describe('MotionTimeoutErrorクラス', () => {
    it('フェーズと経過時間を保持する', async () => {
      const { MotionTimeoutError } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      const error = new MotionTimeoutError('video', 5000);

      expect(error.phase).toBe('video');
      expect(error.elapsedMs).toBe(5000);
      expect(error.message).toContain('video');
      expect(error.message).toContain('5000');
    });
  });

  describe('withTimeout関数', () => {
    it('正常完了時は結果を返す', async () => {
      const { withTimeout } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      const startTime = Date.now();
      const promise = Promise.resolve('success');
      const result = await withTimeout(promise, 5000, 'test', startTime);

      expect(result).toBe('success');
    });

    it('タイムアウト時はMotionTimeoutErrorをスローする', async () => {
      const { withTimeout, MotionTimeoutError } = await import(
        '../../../src/tools/motion/detect.tool'
      );

      const startTime = Date.now();
      // 永遠に解決しないPromise
      const neverResolve = new Promise(() => {});

      await expect(
        withTimeout(neverResolve, 50, 'test', startTime)
      ).rejects.toThrow(MotionTimeoutError);
    });
  });
});
