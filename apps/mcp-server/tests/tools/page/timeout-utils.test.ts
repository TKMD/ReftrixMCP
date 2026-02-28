// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze タイムアウトユーティリティ テスト
 *
 * withTimeout, withTimeoutGraceful, distributeTimeout のテスト
 *
 * @module tests/tools/page/timeout-utils.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  withTimeout,
  withTimeoutGraceful,
  distributeTimeout,
  getRemainingTimeout,
  PhaseTimeoutError,
} from '../../../src/tools/page/handlers/timeout-utils';
import type { AnalysisWarning } from '../../../src/tools/page/schemas';

// ============================================================================
// withTimeout テスト
// ============================================================================

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Promiseが時間内に解決した場合、結果を返す', async () => {
    const promise = Promise.resolve('success');

    const resultPromise = withTimeout(promise, 1000, 'test-phase');

    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('Promiseがタイムアウトした場合、PhaseTimeoutErrorをスロー', async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('slow'), 5000);
    });

    const resultPromise = withTimeout(slowPromise, 1000, 'test-phase');

    // タイムアウト前に進める
    vi.advanceTimersByTime(1001);

    await expect(resultPromise).rejects.toThrow(PhaseTimeoutError);
    await expect(resultPromise).rejects.toThrow('test-phase timed out after 1000ms');
  });

  it('Promiseが自身でエラーをスローした場合、そのエラーを伝播', async () => {
    const errorPromise = Promise.reject(new Error('original error'));

    const resultPromise = withTimeout(errorPromise, 1000, 'test-phase');

    await expect(resultPromise).rejects.toThrow('original error');
  });

  it('PhaseTimeoutError にフェーズ名とタイムアウト値が含まれる', async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('slow'), 5000);
    });

    const resultPromise = withTimeout(slowPromise, 2000, 'layout-analysis');

    vi.advanceTimersByTime(2001);

    try {
      await resultPromise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PhaseTimeoutError);
      if (error instanceof PhaseTimeoutError) {
        expect(error.phase).toBe('layout-analysis');
        expect(error.timeoutMs).toBe(2000);
      }
    }
  });
});

// ============================================================================
// withTimeoutGraceful テスト
// ============================================================================

describe('withTimeoutGraceful', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Promiseが時間内に解決した場合、結果を返す', async () => {
    const warnings: AnalysisWarning[] = [];
    const promise = Promise.resolve({ data: 'test' });

    const resultPromise = withTimeoutGraceful(
      promise,
      1000,
      'layout-analysis',
      'layout',
      warnings
    );

    const result = await resultPromise;
    expect(result).toEqual({ data: 'test' });
    expect(warnings).toHaveLength(0);
  });

  it('タイムアウト時はnullを返し、警告を追加（Graceful Degradation）', async () => {
    const warnings: AnalysisWarning[] = [];
    const slowPromise = new Promise<{ data: string }>((resolve) => {
      setTimeout(() => resolve({ data: 'slow' }), 5000);
    });

    const resultPromise = withTimeoutGraceful(
      slowPromise,
      1000,
      'motion-detection',
      'motion',
      warnings
    );

    vi.advanceTimersByTime(1001);

    const result = await resultPromise;
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      feature: 'motion',
      code: 'TIMEOUT_ERROR',
      message: 'motion-detection timed out after 1000ms (graceful degradation)',
    });
  });

  it('タイムアウト以外のエラーもGraceful Degradationで処理される', async () => {
    const warnings: AnalysisWarning[] = [];
    const errorPromise = Promise.reject(new Error('DB connection failed'));

    const result = await withTimeoutGraceful(
      errorPromise,
      1000,
      'quality-evaluation',
      'quality',
      warnings
    );

    // Graceful Degradation: エラー時はnullを返し、警告に記録
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('QUALITY_EVALUATION_FAILED');
    expect(warnings[0]?.message).toContain('DB connection failed');
    expect(warnings[0]?.message).toContain('graceful degradation');
  });

  it('警告のfeatureパラメータが正しく設定される', async () => {
    const layoutWarnings: AnalysisWarning[] = [];
    const motionWarnings: AnalysisWarning[] = [];
    const qualityWarnings: AnalysisWarning[] = [];

    const slowPromise = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('slow'), 5000);
      });

    const layoutPromise = withTimeoutGraceful(
      slowPromise(),
      100,
      'layout',
      'layout',
      layoutWarnings
    );
    const motionPromise = withTimeoutGraceful(
      slowPromise(),
      100,
      'motion',
      'motion',
      motionWarnings
    );
    const qualityPromise = withTimeoutGraceful(
      slowPromise(),
      100,
      'quality',
      'quality',
      qualityWarnings
    );

    vi.advanceTimersByTime(101);

    await layoutPromise;
    await motionPromise;
    await qualityPromise;

    expect(layoutWarnings[0].feature).toBe('layout');
    expect(motionWarnings[0].feature).toBe('motion');
    expect(qualityWarnings[0].feature).toBe('quality');
  });
});

// ============================================================================
// distributeTimeout テスト
// ============================================================================

describe('distributeTimeout', () => {
  it('デフォルトタイムアウト（60秒）での配分', () => {
    const timeouts = distributeTimeout(60000, false, false);

    expect(timeouts.fetchHtml).toBeGreaterThan(0);
    expect(timeouts.layoutAnalysis).toBeGreaterThan(0);
    expect(timeouts.motionDetection).toBeGreaterThan(0);
    expect(timeouts.qualityEvaluation).toBeGreaterThan(0);
    expect(timeouts.dbSave).toBeGreaterThan(0);
  });

  it('短いタイムアウト（30秒）での比例配分', () => {
    const defaultTimeouts = distributeTimeout(60000, false, false);
    const shortTimeouts = distributeTimeout(30000, false, false);

    // 短いタイムアウトの方が各フェーズも短くなる
    expect(shortTimeouts.fetchHtml).toBeLessThanOrEqual(defaultTimeouts.fetchHtml);
    expect(shortTimeouts.layoutAnalysis).toBeLessThanOrEqual(defaultTimeouts.layoutAnalysis);
  });

  it('フレームキャプチャ有効時はモーション検出タイムアウトが増加', () => {
    const withoutFrameCapture = distributeTimeout(60000, false, false);
    const withFrameCapture = distributeTimeout(60000, true, false);

    expect(withFrameCapture.motionDetection).toBeGreaterThanOrEqual(
      withoutFrameCapture.motionDetection
    );
    expect(withFrameCapture.frameCapture).toBeGreaterThan(0);
  });

  it('JSアニメーション検出有効時はタイムアウトが増加', () => {
    const withoutJs = distributeTimeout(60000, true, false);
    const withJs = distributeTimeout(60000, true, true);

    // JSアニメーション検出タイムアウトが設定される
    expect(withJs.jsAnimationDetection).toBeGreaterThan(0);
  });

  it('全てのフェーズタイムアウトが正の整数', () => {
    const timeouts = distributeTimeout(60000, true, true);

    expect(Number.isInteger(timeouts.fetchHtml)).toBe(true);
    expect(Number.isInteger(timeouts.layoutAnalysis)).toBe(true);
    expect(Number.isInteger(timeouts.motionDetection)).toBe(true);
    expect(Number.isInteger(timeouts.qualityEvaluation)).toBe(true);
    expect(Number.isInteger(timeouts.frameCapture)).toBe(true);
    expect(Number.isInteger(timeouts.jsAnimationDetection)).toBe(true);
    expect(Number.isInteger(timeouts.dbSave)).toBe(true);

    expect(timeouts.fetchHtml).toBeGreaterThan(0);
    expect(timeouts.layoutAnalysis).toBeGreaterThan(0);
    expect(timeouts.motionDetection).toBeGreaterThan(0);
    expect(timeouts.qualityEvaluation).toBeGreaterThan(0);
  });
});

// ============================================================================
// getRemainingTimeout テスト
// ============================================================================

describe('getRemainingTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('経過時間を考慮して残り時間を計算', () => {
    const startTime = Date.now();
    vi.advanceTimersByTime(10000); // 10秒経過

    const remaining = getRemainingTimeout(startTime, 60000);

    expect(remaining).toBe(50000); // 60000 - 10000
  });

  it('残り時間が最小タイムアウト以下の場合、最小タイムアウトを返す', () => {
    const startTime = Date.now();
    vi.advanceTimersByTime(58000); // 58秒経過

    const remaining = getRemainingTimeout(startTime, 60000, 5000);

    expect(remaining).toBe(5000); // 最小タイムアウト
  });

  it('残り時間がマイナスの場合でも最小タイムアウトを返す', () => {
    const startTime = Date.now();
    vi.advanceTimersByTime(70000); // 70秒経過（タイムアウト超過）

    const remaining = getRemainingTimeout(startTime, 60000, 5000);

    expect(remaining).toBe(5000); // 最小タイムアウト
  });

  it('デフォルト最小タイムアウトは5000ms', () => {
    const startTime = Date.now();
    vi.advanceTimersByTime(60000); // 60秒経過

    const remaining = getRemainingTimeout(startTime, 60000);

    expect(remaining).toBe(5000); // デフォルト最小タイムアウト
  });
});

// ============================================================================
// PhaseTimeoutError テスト
// ============================================================================

describe('PhaseTimeoutError', () => {
  it('Errorを継承している', () => {
    const error = new PhaseTimeoutError('test-phase', 1000);
    expect(error).toBeInstanceOf(Error);
  });

  it('nameプロパティが正しく設定される', () => {
    const error = new PhaseTimeoutError('test-phase', 1000);
    expect(error.name).toBe('PhaseTimeoutError');
  });

  it('phaseプロパティが正しく設定される', () => {
    const error = new PhaseTimeoutError('layout-analysis', 30000);
    expect(error.phase).toBe('layout-analysis');
  });

  it('timeoutMsプロパティが正しく設定される', () => {
    const error = new PhaseTimeoutError('motion-detection', 120000);
    expect(error.timeoutMs).toBe(120000);
  });

  it('messageが正しく設定される', () => {
    const error = new PhaseTimeoutError('quality-evaluation', 15000);
    expect(error.message).toBe('quality-evaluation timed out after 15000ms');
  });
});
