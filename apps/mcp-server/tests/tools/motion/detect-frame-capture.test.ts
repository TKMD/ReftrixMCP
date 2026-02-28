// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect フレームキャプチャ機能のテスト
 * TDD Green/Refactor Phase: スキーマからユーティリティ関数をインポート
 *
 * フレームキャプチャ機能は、ページをスクロールしながらフレームを連続撮影し、
 * video mode用の素材を生成する機能です。
 *
 * テスト対象:
 * - フレームキャプチャスキーマ (8テスト)
 * - 計算式検証 (4テスト)
 * - 出力形式検証 (5テスト)
 * - エッジケース (3テスト)
 *
 * @module tests/tools/motion/detect-frame-capture.test
 */

import { describe, it, expect } from 'vitest';

// =====================================================
// インポート
// =====================================================

import {
  motionDetectInputSchema,
  type MotionDetectInput,
  // フレームキャプチャユーティリティ関数
  calculateFrameCaptureConfig,
  generateFrameFileInfos,
} from '../../../src/tools/motion/schemas';

// =====================================================
// テスト: フレームキャプチャスキーマ
// =====================================================

describe('motion.detect フレームキャプチャ機能', () => {
  describe('フレームキャプチャスキーマ', () => {
    it('enable_frame_capture: false の場合、frame_capture が undefined', () => {
      const input: MotionDetectInput = {
        detection_mode: 'video',
        url: 'https://example.com',
        enable_frame_capture: false,
      };

      // スキーマバリデーション
      const parsed = motionDetectInputSchema.parse(input);
      expect(parsed.enable_frame_capture).toBe(false);

      // frame_capture_options は未定義または無視される
      expect(parsed.frame_capture_options).toBeUndefined();
    });

    it('enable_frame_capture: true でデフォルト設定が適用される', () => {
      const input: MotionDetectInput = {
        detection_mode: 'video',
        url: 'https://example.com',
        enable_frame_capture: true,
      };

      const parsed = motionDetectInputSchema.parse(input);
      expect(parsed.enable_frame_capture).toBe(true);

      // frame_capture_options が未指定の場合はデフォルト値が適用される
      const config = calculateFrameCaptureConfig(parsed.frame_capture_options);

      // デフォルト値の検証
      expect(config.frame_rate).toBe(30);
      expect(config.frame_interval_ms).toBeCloseTo(33.33, 1);
      expect(config.scroll_speed_px_per_sec).toBe(216); // 1080 / 5
      // scroll_px_per_frame は固定デフォルト値 15（Reftrix仕様）
      expect(config.scroll_px_per_frame).toBe(15);
      expect(config.output_format).toBe('png');
      expect(config.output_dir).toBe('/tmp/reftrix-frames/');
      expect(config.filename_pattern).toBe('frame-{0000}.png');
      expect(config.page_height_px).toBe(1080);
      expect(config.scroll_duration_sec).toBe(5);
    });

    it('カスタム frame_rate (60fps) が正しく計算される', () => {
      const input: MotionDetectInput = {
        detection_mode: 'video',
        url: 'https://example.com',
        enable_frame_capture: true,
        frame_capture_options: {
          frame_rate: 60,
        },
      };

      const parsed = motionDetectInputSchema.parse(input);
      const config = calculateFrameCaptureConfig(parsed.frame_capture_options);

      // 60fps の場合の計算
      expect(config.frame_rate).toBe(60);
      expect(config.frame_interval_ms).toBeCloseTo(16.67, 1); // 1000 / 60
      // scroll_px_per_frame は固定デフォルト値 15（frame_rate に依存しない）
      expect(config.scroll_px_per_frame).toBe(15);
      expect(config.total_frames).toBe(300); // 5 * 60
    });

    it('カスタム scroll_duration_sec が正しく計算される', () => {
      const input: MotionDetectInput = {
        detection_mode: 'video',
        url: 'https://example.com',
        enable_frame_capture: true,
        frame_capture_options: {
          scroll_duration_sec: 10,
        },
      };

      const parsed = motionDetectInputSchema.parse(input);
      const config = calculateFrameCaptureConfig(parsed.frame_capture_options);

      // 10秒スクロールの場合
      expect(config.scroll_duration_sec).toBe(10);
      expect(config.scroll_speed_px_per_sec).toBe(108); // 1080 / 10
      // scroll_px_per_frame は固定デフォルト値 15（scroll_duration_sec に依存しない）
      expect(config.scroll_px_per_frame).toBe(15);
      expect(config.total_frames).toBe(300); // 10 * 30
    });

    it('カスタム page_height_px が正しく計算される', () => {
      const input: MotionDetectInput = {
        detection_mode: 'video',
        url: 'https://example.com',
        enable_frame_capture: true,
        frame_capture_options: {
          page_height_px: 2160, // 2K
        },
      };

      const parsed = motionDetectInputSchema.parse(input);
      const config = calculateFrameCaptureConfig(parsed.frame_capture_options);

      // 2160px の場合
      expect(config.page_height_px).toBe(2160);
      expect(config.scroll_speed_px_per_sec).toBe(432); // 2160 / 5
      // scroll_px_per_frame は固定デフォルト値 15（page_height_px に依存しない）
      expect(config.scroll_px_per_frame).toBe(15);
    });

    it('output_format: jpeg が正しく適用される', () => {
      const input: MotionDetectInput = {
        detection_mode: 'video',
        url: 'https://example.com',
        enable_frame_capture: true,
        frame_capture_options: {
          output_format: 'jpeg',
        },
      };

      const parsed = motionDetectInputSchema.parse(input);
      const config = calculateFrameCaptureConfig(parsed.frame_capture_options);

      expect(config.output_format).toBe('jpeg');
    });

    it('カスタム filename_pattern が正しく適用される', () => {
      const input: MotionDetectInput = {
        detection_mode: 'video',
        url: 'https://example.com',
        enable_frame_capture: true,
        frame_capture_options: {
          filename_pattern: 'capture-{000}.png',
        },
      };

      const parsed = motionDetectInputSchema.parse(input);
      const config = calculateFrameCaptureConfig(parsed.frame_capture_options);

      expect(config.filename_pattern).toBe('capture-{000}.png');
    });

    it('カスタム output_dir が正しく適用される', () => {
      const input: MotionDetectInput = {
        detection_mode: 'video',
        url: 'https://example.com',
        enable_frame_capture: true,
        frame_capture_options: {
          output_dir: '/tmp/frames/',
        },
      };

      const parsed = motionDetectInputSchema.parse(input);
      const config = calculateFrameCaptureConfig(parsed.frame_capture_options);

      expect(config.output_dir).toBe('/tmp/frames/');
    });
  });

  describe('計算式検証', () => {
    it('frame_interval_ms = 1000 / frame_rate', () => {
      // 30fps
      const config30 = calculateFrameCaptureConfig({ frame_rate: 30 });
      expect(config30.frame_interval_ms).toBeCloseTo(1000 / 30, 5);

      // 60fps
      const config60 = calculateFrameCaptureConfig({ frame_rate: 60 });
      expect(config60.frame_interval_ms).toBeCloseTo(1000 / 60, 5);

      // 24fps
      const config24 = calculateFrameCaptureConfig({ frame_rate: 24 });
      expect(config24.frame_interval_ms).toBeCloseTo(1000 / 24, 5);
    });

    it('scroll_speed_px_per_sec = page_height_px / scroll_duration_sec', () => {
      // デフォルト: 1080px / 5sec = 216
      const configDefault = calculateFrameCaptureConfig();
      expect(configDefault.scroll_speed_px_per_sec).toBe(1080 / 5);

      // カスタム: 2160px / 10sec = 216
      const configCustom = calculateFrameCaptureConfig({
        page_height_px: 2160,
        scroll_duration_sec: 10,
      });
      expect(configCustom.scroll_speed_px_per_sec).toBe(2160 / 10);
    });

    it('scroll_px_per_frame は固定デフォルト値 15（Reftrix仕様）', () => {
      // デフォルト: 15（旧仕様: 216 / 30 = 7.2 から変更）
      const configDefault = calculateFrameCaptureConfig();
      expect(configDefault.scroll_px_per_frame).toBe(15);

      // 60fps でも 15（旧仕様: 216 / 60 = 3.6 から変更）
      const config60fps = calculateFrameCaptureConfig({ frame_rate: 60 });
      expect(config60fps.scroll_px_per_frame).toBe(15);

      // 明示的に指定した場合はその値を使用
      const configCustom = calculateFrameCaptureConfig({ scroll_px_per_frame: 30 });
      expect(configCustom.scroll_px_per_frame).toBe(30);
    });

    it('total_frames = scroll_duration_sec * frame_rate', () => {
      // デフォルト: 5 * 30 = 150
      const configDefault = calculateFrameCaptureConfig();
      expect(configDefault.total_frames).toBe(150);

      // 10sec * 60fps = 600
      const configCustom = calculateFrameCaptureConfig({
        scroll_duration_sec: 10,
        frame_rate: 60,
      });
      expect(configCustom.total_frames).toBe(600);
    });
  });

  describe('出力形式検証', () => {
    it('generateFrameFileInfos が正しい配列を生成する', () => {
      const config = calculateFrameCaptureConfig({
        frame_rate: 10,
        scroll_duration_sec: 1,
      });

      const files = generateFrameFileInfos(config);

      expect(files).toHaveLength(10); // 1 * 10
      expect(files[0]).toEqual({
        frame_number: 0,
        scroll_position_px: 0,
        timestamp_ms: 0,
        file_path: '/tmp/reftrix-frames/frame-0000.png',
      });
    });

    it('filename_pattern が正しく置換される', () => {
      const config = calculateFrameCaptureConfig({
        frame_rate: 10,
        scroll_duration_sec: 1,
        filename_pattern: 'shot-{000}.png',
      });

      const files = generateFrameFileInfos(config);

      expect(files[0].file_path).toBe('/tmp/reftrix-frames/shot-000.png');
      expect(files[5].file_path).toBe('/tmp/reftrix-frames/shot-005.png');
      expect(files[9].file_path).toBe('/tmp/reftrix-frames/shot-009.png');
    });

    it('output_format が jpeg の場合、ファイル拡張子が正しい', () => {
      const config = calculateFrameCaptureConfig({
        frame_rate: 10,
        scroll_duration_sec: 1,
        output_format: 'jpeg',
        filename_pattern: 'frame-{0000}.jpeg',
      });

      const files = generateFrameFileInfos(config);

      expect(files[0].file_path).toBe('/tmp/reftrix-frames/frame-0000.jpeg');
    });

    it('scroll_position_px が page_height_px を超えない', () => {
      const config = calculateFrameCaptureConfig({
        frame_rate: 100,
        scroll_duration_sec: 1,
        page_height_px: 500,
      });

      const files = generateFrameFileInfos(config);

      // 最後のフレームの位置がページ高さを超えないことを確認
      for (const file of files) {
        expect(file.scroll_position_px).toBeLessThanOrEqual(500);
      }
    });

    it('timestamp_ms が正しく計算される', () => {
      const config = calculateFrameCaptureConfig({
        frame_rate: 10,
        scroll_duration_sec: 1,
      });

      const files = generateFrameFileInfos(config);

      // frame_interval_ms = 1000 / 10 = 100
      expect(files[0].timestamp_ms).toBe(0);
      expect(files[1].timestamp_ms).toBe(100);
      expect(files[5].timestamp_ms).toBe(500);
      expect(files[9].timestamp_ms).toBe(900);
    });
  });

  describe('エッジケース', () => {
    it('frame_rate が 1 の場合', () => {
      const config = calculateFrameCaptureConfig({
        frame_rate: 1,
        scroll_duration_sec: 5,
      });

      expect(config.frame_interval_ms).toBe(1000);
      expect(config.total_frames).toBe(5);
      // scroll_px_per_frame は固定デフォルト値 15（frame_rate に依存しない）
      expect(config.scroll_px_per_frame).toBe(15);
    });

    it('scroll_duration_sec が 0.5 の場合', () => {
      const config = calculateFrameCaptureConfig({
        frame_rate: 30,
        scroll_duration_sec: 0.5,
      });

      expect(config.total_frames).toBe(15); // ceil(0.5 * 30)
      expect(config.scroll_speed_px_per_sec).toBe(2160); // 1080 / 0.5
    });

    it('非常に大きな page_height_px (10000px) の場合', () => {
      const config = calculateFrameCaptureConfig({
        page_height_px: 10000,
        scroll_duration_sec: 10,
        frame_rate: 30,
      });

      expect(config.scroll_speed_px_per_sec).toBe(1000); // 10000 / 10
      // scroll_px_per_frame は固定デフォルト値 15（page_height_px に依存しない）
      expect(config.scroll_px_per_frame).toBe(15);
      expect(config.total_frames).toBe(300); // 10 * 30
    });
  });
});
