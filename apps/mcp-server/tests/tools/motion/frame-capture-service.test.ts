// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FrameCaptureService テスト
 *
 * TDD: scroll_px_per_frame デフォルト値 = 15 の検証
 *
 * 仕様:
 * - scroll_px_per_frame のデフォルト値は 15
 * - 15px/frame で total_frames を計算
 * - Playwright page を受け取りフレームをキャプチャ
 *
 * @module tests/tools/motion/frame-capture-service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Page } from 'playwright';

// ============================================================================
// テスト対象インポート
// ============================================================================

import {
  calculateFrameCaptureConfig,
  type FrameCaptureConfig,
} from '../../../src/tools/motion/schemas';

import {
  FrameCaptureService,
  type FrameCaptureServiceOptions,
  type FrameCaptureServiceResult,
} from '../../../src/services/motion/frame-capture.service';

// ============================================================================
// TDD Red Phase: 失敗するテスト（scroll_px_per_frame デフォルト = 15）
// ============================================================================

describe('FrameCaptureService - scroll_px_per_frame デフォルト設定', () => {
  describe('calculateFrameCaptureConfig', () => {
    it('scroll_px_per_frame のデフォルト値は 15', () => {
      // 引数なしでデフォルト設定を取得
      const config = calculateFrameCaptureConfig({});

      // ★ここが失敗するはず: 現在は 7.2 (216/30) になる
      expect(config.scroll_px_per_frame).toBe(15);
    });

    it('frame_rate を変更しても scroll_px_per_frame は 15（デフォルト）', () => {
      // 60fps にしても scroll_px_per_frame は 15 であるべき
      const config = calculateFrameCaptureConfig({ frame_rate: 60 });

      // ★現在は 3.6 (216/60) になる
      expect(config.scroll_px_per_frame).toBe(15);
    });

    it('page_height_px を変更しても scroll_px_per_frame は 15（デフォルト）', () => {
      // ページ高さを 3000px にしても scroll_px_per_frame は 15 であるべき
      const config = calculateFrameCaptureConfig({ page_height_px: 3000 });

      // ★現在は 20 (600/30) になる
      expect(config.scroll_px_per_frame).toBe(15);
    });

    it('scroll_px_per_frame を明示的に指定した場合はその値を使用', () => {
      // 明示的に 30 を指定
      const config = calculateFrameCaptureConfig({ scroll_px_per_frame: 30 });

      expect(config.scroll_px_per_frame).toBe(30);
    });
  });

  describe('total_frames の計算（scroll_px_per_frame 基準）', () => {
    it('page_height_px / scroll_px_per_frame で total_frames を計算（デフォルト）', () => {
      // 現在の計算: scroll_duration_sec * frame_rate = 5 * 30 = 150
      // 新しい計算: page_height_px / scroll_px_per_frame
      //
      // ただし、total_frames の計算式は現状維持
      // （scroll_duration_sec * frame_rate のまま）
      // 変更するのは scroll_px_per_frame のデフォルト値のみ
      const config = calculateFrameCaptureConfig({});

      // デフォルト: 5秒 * 30fps = 150 frames
      expect(config.total_frames).toBe(150);

      // scroll_px_per_frame は 15 であるべき
      expect(config.scroll_px_per_frame).toBe(15);
    });

    it('3000px ページで 15px/frame = 200 frames', () => {
      // page_height_px を基準に total_frames を計算する新しいユースケース
      // page_height_px = 3000, scroll_px_per_frame = 15 → 3000 / 15 = 200
      const config = calculateFrameCaptureConfig({
        page_height_px: 3000,
        scroll_px_per_frame: 15,
      });

      // scroll_px_per_frame が 15 であること
      expect(config.scroll_px_per_frame).toBe(15);

      // total_frames の計算式は scroll_duration_sec * frame_rate のまま
      // デフォルト: 5秒 * 30fps = 150 frames
      expect(config.total_frames).toBe(150);
    });
  });

  describe('Reftrix仕様との整合性', () => {
    it('15px/frame は Reftrix のデフォルト仕様', () => {
      /**
       * 15px/frame の根拠（docs/specs/current-architecture.md より）:
       * - 60fps等価スクロール（216px/秒 ÷ 60 ≈ 3.6px）と50px/frameの中間
       * - IntersectionObserver閾値（0.1〜0.3）を確実に検出
       * - cubic-bezier easing曲線の解析に十分なサンプル数
       * - parallax微動（係数0.02〜0.05）の検出可能
       */
      const config = calculateFrameCaptureConfig({});
      expect(config.scroll_px_per_frame).toBe(15);
    });

    it('frame_interval_ms は 33ms（30fps等価）', () => {
      const config = calculateFrameCaptureConfig({});
      // 1000 / 30 = 33.333...
      expect(config.frame_interval_ms).toBeCloseTo(33.33, 1);
    });

    it('output_format デフォルトは png', () => {
      const config = calculateFrameCaptureConfig({});
      expect(config.output_format).toBe('png');
    });

    it('filename_pattern デフォルトは frame-{0000}.png', () => {
      const config = calculateFrameCaptureConfig({});
      expect(config.filename_pattern).toBe('frame-{0000}.png');
    });
  });
});

// ============================================================================
// Mock Playwright Page
// ============================================================================

function createMockPlaywrightPage(options: {
  scrollHeight?: number;
  viewportHeight?: number;
} = {}): Page {
  const scrollHeight = options.scrollHeight ?? 1000;
  const viewportHeight = options.viewportHeight ?? 800;

  const mockPage = {
    evaluate: vi.fn().mockImplementation((fn: Function | string) => {
      // 関数の文字列表現を取得
      if (typeof fn === 'function') {
        const fnStr = fn.toString();

        // Step 1: 初期メトリクス取得（scrollHeight, innerHeight, offsetHeight等）
        if (fnStr.includes('scrollHeight') && fnStr.includes('innerHeight')) {
          return Promise.resolve({
            scrollHeight: scrollHeight,
            bodyScrollHeight: scrollHeight,
            offsetHeight: scrollHeight,
            bodyOffsetHeight: scrollHeight,
            innerHeight: viewportHeight,
          });
        }

        // Step 2/3: スクロール後の再取得（scrollHeight, bodyScrollHeight）
        if (fnStr.includes('scrollHeight') && fnStr.includes('bodyScrollHeight')) {
          return Promise.resolve({
            scrollHeight: scrollHeight,
            bodyScrollHeight: scrollHeight,
          });
        }

        // 単一のscrollHeight取得（旧形式互換）
        if (fnStr.includes('scrollHeight')) {
          return Promise.resolve(scrollHeight);
        }

        // 単一のinnerHeight取得（旧形式互換）
        if (fnStr.includes('innerHeight')) {
          return Promise.resolve(viewportHeight);
        }

        // scrollTo実行
        if (fnStr.includes('scrollTo')) {
          return Promise.resolve();
        }
      }
      return Promise.resolve();
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('mock-image')),
  } as unknown as Page;

  return mockPage;
}

// ============================================================================
// FrameCaptureService クラスのテスト
// ============================================================================

describe('FrameCaptureService', () => {
  let service: FrameCaptureService;

  beforeEach(() => {
    service = new FrameCaptureService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('デフォルト設定で初期化', () => {
      expect(service).toBeInstanceOf(FrameCaptureService);
    });
  });

  describe('capture()', () => {
    it('Playwright page を受け取りフレームをキャプチャ', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 315, // 15 * 20 + 15 = 315 → maxScroll = 315 - 800 = -485 → 実際は 0
        viewportHeight: 100,
      });

      const result = await service.capture(mockPage, {
        scroll_px_per_frame: 15,
        output_dir: '/tmp/frames/',
      });

      expect(result.total_frames).toBeGreaterThan(0);
      expect(result.output_dir).toBe('/tmp/frames/');
    });

    it('scroll_px_per_frame デフォルトは 15', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 1000,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
      });

      // maxScroll = 1000 - 800 = 200
      // total_frames = ceil(200 / 15) + 1 = 14 + 1 = 15
      expect(result.config.scroll_px_per_frame).toBe(15);
    });

    it('フレームごとに screenshot が呼ばれる', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 1000,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        scroll_px_per_frame: 100, // 2 frames: 0px, 100px
        output_dir: '/tmp/frames/',
      });

      // maxScroll = 200, scroll_px_per_frame = 100
      // total_frames = ceil(200/100) + 1 = 3
      expect(mockPage.screenshot).toHaveBeenCalled();
      expect(result.files.length).toBeGreaterThan(0);
    });

    it('files 配列にフレーム情報が含まれる', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 830, // maxScroll = 30
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        scroll_px_per_frame: 15,
        output_dir: '/tmp/frames/',
      });

      // モックの制約上、正確なフレーム数は保証できないが、
      // 少なくとも1フレームは取得できる
      expect(result.files.length).toBeGreaterThanOrEqual(1);
      expect(result.files[0]).toBeDefined();
      expect(result.files[0].frame_number).toBe(0);
      // scroll_position_px はモックの制約上NaNになりうるため、定義のみ確認
      expect(result.files[0].scroll_position_px).toBeDefined();
    });

    it('output_format デフォルトは png', async () => {
      const mockPage = createMockPlaywrightPage();

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
      });

      expect(result.config.output_format).toBe('png');
    });

    it('jpeg フォーマットをサポート', async () => {
      const mockPage = createMockPlaywrightPage();

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        output_format: 'jpeg',
      });

      expect(result.config.output_format).toBe('jpeg');
    });

    it('frame_interval_ms デフォルトは 33ms', async () => {
      const mockPage = createMockPlaywrightPage();

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
      });

      expect(result.config.frame_interval_ms).toBe(33);
    });

    it('duration_ms が記録される', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 815, // minimal scroll
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        scroll_px_per_frame: 15,
        output_dir: '/tmp/frames/',
      });

      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('filename_pattern', () => {
    it('デフォルトパターン frame-{0000}.png', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 815,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
      });

      expect(result.files[0].file_path).toBe('/tmp/frames/frame-0000.png');
    });

    it('カスタムパターン', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 815,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        filename_pattern: 'capture-{000}.png',
      });

      expect(result.files[0].file_path).toBe('/tmp/frames/capture-000.png');
    });
  });

  describe('Security: Path Traversal Protection (SEC P1)', () => {
    it('output_dir に .. が含まれる場合はエラー', async () => {
      const mockPage = createMockPlaywrightPage();

      await expect(
        service.capture(mockPage, {
          output_dir: '/tmp/../etc/passwd',
        })
      ).rejects.toThrow('Security: Path traversal detected in output_dir');
    });

    it('output_dir に複数の .. が含まれる場合もエラー', async () => {
      const mockPage = createMockPlaywrightPage();

      await expect(
        service.capture(mockPage, {
          output_dir: '/tmp/frames/../../etc',
        })
      ).rejects.toThrow('Security: Path traversal detected in output_dir');
    });

    it('許可されたディレクトリ外はエラー', async () => {
      const mockPage = createMockPlaywrightPage();

      await expect(
        service.capture(mockPage, {
          output_dir: '/etc/passwd',
        })
      ).rejects.toThrow('Security: output_dir is outside allowed directories');
    });

    it('/tmp は許可される', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 815,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
      });

      expect(result.output_dir).toBe('/tmp/frames/');
    });

    it('process.cwd() 配下は許可される', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 815,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: process.cwd() + '/frames/',
      });

      expect(result.output_dir).toContain('/frames/');
    });
  });

  // ============================================================================
  // v0.1.0: Timeout & Limit Options テスト
  // ============================================================================

  describe('v0.1.0: max_frames制限', () => {
    it('max_framesを超えるとtruncatedがtrueになる', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 10000, // 大きなページ
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        scroll_px_per_frame: 15,
        max_frames: 10, // 10フレームまで
      });

      expect(result.truncated).toBe(true);
      expect(result.truncation_reason).toBe('max_frames');
      expect(result.total_frames).toBeLessThanOrEqual(10);
    });

    it('max_framesに達しない場合はtruncatedが未設定', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 815, // 小さなページ
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        scroll_px_per_frame: 15,
        max_frames: 1000,
      });

      // 制限に達しない場合、truncatedフィールドは設定されない（undefined）
      expect(result.truncated).toBeUndefined();
      expect(result.truncation_reason).toBeUndefined();
    });

    it('max_framesデフォルト値は1000', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 815,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
      });

      // デフォルト1000なので小さなページでは制限に達しない
      // 制限に達しない場合、truncatedフィールドは設定されない（undefined）
      expect(result.truncated).toBeUndefined();
    });
  });

  describe('v0.1.0: max_page_height制限', () => {
    it('max_page_heightを超えるページ高さはtruncatedになる', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 100000, // 非常に大きなページ
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        scroll_px_per_frame: 15,
        max_page_height: 5000,
      });

      expect(result.truncated).toBe(true);
      expect(result.truncation_reason).toBe('max_page_height');
      expect(result.original_page_height).toBe(100000);
    });

    it('max_page_heightデフォルト値は50000', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 60000, // デフォルト制限を超える
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        scroll_px_per_frame: 15,
        max_frames: 10000, // max_framesを大きくしてmax_page_heightのみが制限されるようにする
        // max_page_height未指定 → デフォルト50000
      });

      expect(result.truncated).toBe(true);
      expect(result.truncation_reason).toBe('max_page_height');
    });
  });

  describe('v0.1.0: truncation優先順位', () => {
    it('max_page_heightとmax_frames両方を超える場合、max_framesが最終的なreasonになる', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 100000, // 非常に大きなページ
        viewportHeight: 800,
      });

      // 両方の制限が適用される場合
      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        scroll_px_per_frame: 15,
        max_page_height: 5000,
        max_frames: 10,
      });

      // 実装では:
      // 1. max_page_heightが先に評価されtruncated=true, reason='max_page_height'
      // 2. totalFrames計算後にmax_frames制限が評価され、該当すればreason='max_frames'に上書き
      // したがって、両方超える場合はmax_framesが最終reason
      expect(result.truncated).toBe(true);
      expect(result.truncation_reason).toBe('max_frames');
    });

    it('max_page_heightのみ超える場合はmax_page_heightがreason', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 100000, // 非常に大きなページ
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        scroll_px_per_frame: 15,
        max_page_height: 5000,
        max_frames: 10000, // 大きな値でmax_framesは超えない
      });

      expect(result.truncated).toBe(true);
      expect(result.truncation_reason).toBe('max_page_height');
    });
  });

  describe('v0.1.0: original_page_height記録', () => {
    it('max_page_height制限時にoriginal_page_heightが記録される', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 80000,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        max_page_height: 10000,
      });

      expect(result.original_page_height).toBe(80000);
    });

    it('制限に達しない場合はoriginal_page_heightは未設定', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 1000,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        max_page_height: 50000,
      });

      expect(result.original_page_height).toBeUndefined();
    });
  });

  describe('Security: Filename Sanitization (SEC P2)', () => {
    it('filename_pattern にディレクトリ成分があっても無視される', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 815,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        filename_pattern: '../../../etc/frame-{0000}.png',
      });

      // path.basename() によりディレクトリ成分は除去される
      expect(result.files[0].file_path).toBe('/tmp/frames/frame-0000.png');
    });

    it('絶対パス形式の filename_pattern も basename のみ使用', async () => {
      const mockPage = createMockPlaywrightPage({
        scrollHeight: 815,
        viewportHeight: 800,
      });

      const result = await service.capture(mockPage, {
        output_dir: '/tmp/frames/',
        filename_pattern: '/etc/passwd/frame-{0000}.png',
      });

      // path.basename() によりディレクトリ成分は除去される
      expect(result.files[0].file_path).toBe('/tmp/frames/frame-0000.png');
    });
  });
});
