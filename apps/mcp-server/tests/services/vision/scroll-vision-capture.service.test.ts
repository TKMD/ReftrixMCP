// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ScrollVisionCaptureService テスト
 *
 * スクロール位置ベースのビューポートキャプチャサービスのユニットテスト
 *
 * テスト対象:
 * - セクション境界からスクロール位置の算出・重複除去
 * - maxCaptures制限による均等サンプリング
 * - ページ先頭・末尾の自動追加
 * - SSRF検証
 * - ブラウザエラーのgraceful handling
 *
 * @module tests/services/vision/scroll-vision-capture.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Playwright モック
const mockScreenshot = vi.fn().mockResolvedValue(Buffer.from('fake-screenshot'));
const mockEvaluate = vi.fn();
const mockGoto = vi.fn().mockResolvedValue({ status: () => 200 });
const mockWaitForTimeout = vi.fn().mockResolvedValue(undefined);
const mockPageClose = vi.fn().mockResolvedValue(undefined);
const mockContextClose = vi.fn().mockResolvedValue(undefined);
const mockBrowserClose = vi.fn().mockResolvedValue(undefined);
const mockNewPage = vi.fn();
const mockNewContext = vi.fn();
const mockLaunch = vi.fn();

vi.mock('playwright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunch(...args),
  },
}));

// URL validator モック
vi.mock('../../../src/utils/url-validator.js', () => ({
  validateExternalUrl: vi.fn().mockReturnValue({ valid: true, normalizedUrl: 'https://example.com' }),
}));

// Logger モック
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  computeScrollPositions,
  samplePositions,
  captureScrollPositions,
  type SectionBoundary,
  type ScrollCaptureOptions,
} from '../../../src/services/vision/scroll-vision-capture.service.js';

import { validateExternalUrl } from '../../../src/utils/url-validator.js';

// =============================================================================
// computeScrollPositions テスト
// =============================================================================

describe('computeScrollPositions', () => {
  it('ページ先頭(0)を常に含む', () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 500, endY: 1000 },
    ];
    const positions = computeScrollPositions(boundaries, 2000, 900);

    expect(positions[0]?.scrollY).toBe(0);
  });

  it('ページ末尾(maxScroll)を含む', () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 500, endY: 1000 },
    ];
    const totalScrollHeight = 2000;
    const viewportHeight = 900;
    const maxScroll = totalScrollHeight - viewportHeight; // 1100

    const positions = computeScrollPositions(boundaries, totalScrollHeight, viewportHeight);
    const lastPosition = positions[positions.length - 1];

    expect(lastPosition?.scrollY).toBe(maxScroll);
  });

  it('scrollYでソートされる', () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 2, startY: 1500, endY: 2000 },
      { sectionIndex: 0, startY: 200, endY: 500 },
      { sectionIndex: 1, startY: 800, endY: 1200 },
    ];

    const positions = computeScrollPositions(boundaries, 3000, 900);

    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr.scrollY).toBeGreaterThanOrEqual(prev.scrollY);
      }
    }
  });

  it('50px以内のスクロール位置はマージされる', () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 500, endY: 800 },
      { sectionIndex: 1, startY: 530, endY: 900 }, // 500から30px → マージ対象
    ];

    const positions = computeScrollPositions(boundaries, 3000, 900);

    // 500と530が1つにマージされるはず
    const positionsAt500Area = positions.filter(
      (p) => p.scrollY >= 490 && p.scrollY <= 540
    );
    expect(positionsAt500Area.length).toBe(1);
  });

  it('50pxを超える距離の位置はマージされない', () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 500, endY: 800 },
      { sectionIndex: 1, startY: 600, endY: 900 }, // 500から100px → マージされない
    ];

    const positions = computeScrollPositions(boundaries, 3000, 900);

    const positionsInRange = positions.filter(
      (p) => p.scrollY >= 500 && p.scrollY <= 600
    );
    expect(positionsInRange.length).toBe(2);
  });

  it('空のboundariesでもページ先頭と末尾を含む', () => {
    const positions = computeScrollPositions([], 2000, 900);

    expect(positions.length).toBeGreaterThanOrEqual(2);
    expect(positions[0]?.scrollY).toBe(0);
    const lastPosition = positions[positions.length - 1];
    expect(lastPosition?.scrollY).toBe(1100); // 2000 - 900
  });

  it('startYがmaxScrollを超える場合はクランプされる', () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 5000, endY: 6000 },
    ];
    const totalScrollHeight = 2000;
    const viewportHeight = 900;
    const maxScroll = totalScrollHeight - viewportHeight; // 1100

    const positions = computeScrollPositions(boundaries, totalScrollHeight, viewportHeight);

    for (const pos of positions) {
      expect(pos.scrollY).toBeLessThanOrEqual(maxScroll);
    }
  });

  it('負のstartYは0にクランプされる', () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: -100, endY: 500 },
    ];

    const positions = computeScrollPositions(boundaries, 2000, 900);

    for (const pos of positions) {
      expect(pos.scrollY).toBeGreaterThanOrEqual(0);
    }
  });

  it('viewportがtotalScrollHeight以上の場合、maxScrollは0', () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 200, endY: 500 },
    ];

    // viewportHeight >= totalScrollHeight → maxScroll = 0
    const positions = computeScrollPositions(boundaries, 900, 1000);

    // すべてのポジションが0にクランプされる
    for (const pos of positions) {
      expect(pos.scrollY).toBe(0);
    }
  });
});

// =============================================================================
// samplePositions テスト
// =============================================================================

describe('samplePositions', () => {
  it('maxCaptures以下の場合はそのまま返す', () => {
    const positions = [
      { scrollY: 0, sectionIndex: -1 },
      { scrollY: 500, sectionIndex: 0 },
      { scrollY: 1100, sectionIndex: 1 },
    ];

    const result = samplePositions(positions, 10);
    expect(result.length).toBe(3);
  });

  it('maxCapturesを超える場合は均等サンプリングされる', () => {
    const positions = Array.from({ length: 20 }, (_, i) => ({
      scrollY: i * 100,
      sectionIndex: i,
    }));

    const result = samplePositions(positions, 5);
    expect(result.length).toBe(5);
  });

  it('先頭と末尾を必ず含む', () => {
    const positions = Array.from({ length: 20 }, (_, i) => ({
      scrollY: i * 100,
      sectionIndex: i,
    }));

    const result = samplePositions(positions, 5);

    // 先頭
    expect(result[0]?.scrollY).toBe(0);
    // 末尾
    expect(result[result.length - 1]?.scrollY).toBe(1900);
  });

  it('maxCaptures=1の場合は先頭のみ', () => {
    const positions = [
      { scrollY: 0, sectionIndex: -1 },
      { scrollY: 500, sectionIndex: 0 },
      { scrollY: 1000, sectionIndex: 1 },
    ];

    const result = samplePositions(positions, 1);
    expect(result.length).toBe(1);
    expect(result[0]?.scrollY).toBe(0);
  });

  it('maxCaptures=2の場合は先頭と末尾', () => {
    const positions = Array.from({ length: 10 }, (_, i) => ({
      scrollY: i * 100,
      sectionIndex: i,
    }));

    const result = samplePositions(positions, 2);
    expect(result.length).toBe(2);
    expect(result[0]?.scrollY).toBe(0);
    expect(result[1]?.scrollY).toBe(900);
  });
});

// =============================================================================
// captureScrollPositions テスト
// =============================================================================

describe('captureScrollPositions', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // 1回目はtotalScrollHeight、2回目以降はscrollTo
    mockEvaluate.mockReset();
    mockEvaluate
      .mockResolvedValueOnce(3000) // totalScrollHeight
      .mockResolvedValue(undefined); // scrollTo calls

    mockGoto.mockResolvedValue({ status: () => 200 });
    mockScreenshot.mockResolvedValue(Buffer.from('fake-screenshot'));
    mockPageClose.mockResolvedValue(undefined);
    mockContextClose.mockResolvedValue(undefined);
    mockBrowserClose.mockResolvedValue(undefined);
    mockWaitForTimeout.mockResolvedValue(undefined);

    // Mock chain setup
    mockNewPage.mockResolvedValue({
      goto: mockGoto,
      evaluate: mockEvaluate,
      screenshot: mockScreenshot,
      waitForTimeout: mockWaitForTimeout,
      close: mockPageClose,
    });

    mockNewContext.mockResolvedValue({
      newPage: mockNewPage,
      close: mockContextClose,
    });

    mockLaunch.mockResolvedValue({
      newContext: mockNewContext,
      close: mockBrowserClose,
    });
  });

  it('正常にキャプチャ結果を返す', async () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 500, endY: 1000 },
      { sectionIndex: 1, startY: 1500, endY: 2000 },
    ];

    const result = await captureScrollPositions('https://example.com', boundaries);

    expect(result.url).toBe('https://example.com');
    expect(result.captures.length).toBeGreaterThan(0);
    expect(result.totalScrollHeight).toBe(3000);
    expect(result.captureTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('各キャプチャにスクリーンショットBufferが含まれる', async () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 500, endY: 1000 },
    ];

    const result = await captureScrollPositions('https://example.com', boundaries);

    for (const capture of result.captures) {
      expect(Buffer.isBuffer(capture.screenshot)).toBe(true);
      expect(capture.screenshot.length).toBeGreaterThan(0);
      expect(capture.viewportHeight).toBe(900);
      expect(capture.timestamp).toBeGreaterThan(0);
    }
  });

  it('SSRF検証で拒否された場合はエラーをスロー', async () => {
    vi.mocked(validateExternalUrl).mockReturnValueOnce({
      valid: false,
      error: 'Private IP blocked',
    });

    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 0, endY: 500 },
    ];

    await expect(
      captureScrollPositions('http://192.168.1.1', boundaries)
    ).rejects.toThrow('SSRF blocked');
  });

  it('HTTP 4xxエラーの場合はエラーをスロー', async () => {
    mockGoto.mockResolvedValueOnce({ status: () => 404 });

    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 0, endY: 500 },
    ];

    await expect(
      captureScrollPositions('https://example.com/notfound', boundaries)
    ).rejects.toThrow('HTTP error 404');
  });

  it('maxCapturesオプションが適用される', async () => {
    const boundaries: SectionBoundary[] = Array.from({ length: 20 }, (_, i) => ({
      sectionIndex: i,
      startY: i * 200,
      endY: (i + 1) * 200,
    }));

    const options: ScrollCaptureOptions = { maxCaptures: 3 };
    const result = await captureScrollPositions('https://example.com', boundaries, options);

    expect(result.captures.length).toBeLessThanOrEqual(3);
  });

  it('ブラウザ/コンテキスト/ページがfinallyでクリーンアップされる', async () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 500, endY: 1000 },
    ];

    await captureScrollPositions('https://example.com', boundaries);

    expect(mockPageClose).toHaveBeenCalled();
    expect(mockContextClose).toHaveBeenCalled();
    expect(mockBrowserClose).toHaveBeenCalled();
  });

  it('エラー時もリソースがクリーンアップされる', async () => {
    mockGoto.mockRejectedValueOnce(new Error('Navigation failed'));

    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 0, endY: 500 },
    ];

    await expect(
      captureScrollPositions('https://example.com', boundaries)
    ).rejects.toThrow('Navigation failed');

    expect(mockBrowserClose).toHaveBeenCalled();
  });

  it('カスタムviewportオプションが適用される', async () => {
    const boundaries: SectionBoundary[] = [
      { sectionIndex: 0, startY: 500, endY: 1000 },
    ];

    const options: ScrollCaptureOptions = {
      viewport: { width: 1920, height: 1080 },
    };

    await captureScrollPositions('https://example.com', boundaries, options);

    expect(mockNewContext).toHaveBeenCalledWith(
      expect.objectContaining({
        viewport: { width: 1920, height: 1080 },
      })
    );
  });
});
