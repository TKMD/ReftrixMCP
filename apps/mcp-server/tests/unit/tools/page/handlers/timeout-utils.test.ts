// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * timeout-utils.ts ユニットテスト
 *
 * page.analyze のタイムアウト管理ユーティリティのテスト。
 * - PhaseTimeoutError: カスタムタイムアウトエラー
 * - withTimeout: タイムアウト付きPromise実行
 * - withTimeoutGraceful: Graceful Degradation対応タイムアウト
 * - distributeTimeout: 全体タイムアウトを各フェーズに分配
 * - getRemainingTimeout: 残り時間計算
 * - ExecutionStatusTracker: 分析実行状態の追跡
 * - withTimeoutAndTracking: Progressive/Strict戦略対応タイムアウト
 *
 * @module tests/unit/tools/page/handlers/timeout-utils
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// loggerとisDevelopmentをモック（開発環境ログを無効化）
vi.mock('../../../../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

import {
  PhaseTimeoutError,
  withTimeout,
  withTimeoutGraceful,
  distributeTimeout,
  getRemainingTimeout,
  ExecutionStatusTracker,
  withTimeoutAndTracking,
  PHASE_PRIORITY,
  type AnalysisPhase,
} from '../../../../../src/tools/page/handlers/timeout-utils';
import { PAGE_ANALYZE_ERROR_CODES, PAGE_ANALYZE_TIMEOUTS } from '../../../../../src/tools/page/schemas';

// =====================================================
// PhaseTimeoutError Tests
// =====================================================

describe('PhaseTimeoutError', () => {
  it('正しいプロパティでエラーを作成できること', () => {
    const error = new PhaseTimeoutError('layout analysis', 30000);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PhaseTimeoutError);
    expect(error.name).toBe('PhaseTimeoutError');
    expect(error.phase).toBe('layout analysis');
    expect(error.timeoutMs).toBe(30000);
    expect(error.message).toBe('layout analysis timed out after 30000ms');
  });

  it('異なるフェーズ名とタイムアウト値で作成できること', () => {
    const error = new PhaseTimeoutError('motion detection', 60000);

    expect(error.phase).toBe('motion detection');
    expect(error.timeoutMs).toBe(60000);
    expect(error.message).toBe('motion detection timed out after 60000ms');
  });

  it('Errorのスタックトレースを持つこと', () => {
    const error = new PhaseTimeoutError('quality evaluation', 15000);

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('PhaseTimeoutError');
  });
});

// =====================================================
// withTimeout Tests
// =====================================================

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('タイムアウト前に完了するPromiseは結果を返すこと', async () => {
    const promise = Promise.resolve('success');

    const resultPromise = withTimeout(promise, 1000, 'test phase');

    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result).toBe('success');
  });

  it('タイムアウト時にPhaseTimeoutErrorをスローすること', async () => {
    // 永遠に解決しないPromise
    const promise = new Promise<string>(() => {});

    const resultPromise = withTimeout(promise, 100, 'slow phase');

    vi.advanceTimersByTime(100);

    await expect(resultPromise).rejects.toThrow(PhaseTimeoutError);
    await expect(resultPromise).rejects.toMatchObject({
      phase: 'slow phase',
      timeoutMs: 100,
    });
  });

  it('Promiseがエラーを投げた場合はそのエラーを伝播すること', async () => {
    const error = new Error('Original error');
    const promise = Promise.reject(error);

    const resultPromise = withTimeout(promise, 1000, 'error phase');

    await expect(resultPromise).rejects.toThrow('Original error');
  });

  it('タイムアウト後もタイマーがクリアされること', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const promise = new Promise<string>(() => {});

    const resultPromise = withTimeout(promise, 100, 'timeout phase');

    vi.advanceTimersByTime(100);

    try {
      await resultPromise;
    } catch {
      // Expected to throw
    }

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('成功時もタイマーがクリアされること', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const promise = Promise.resolve('success');

    await withTimeout(promise, 1000, 'success phase');

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

// =====================================================
// withTimeoutGraceful Tests
// =====================================================

describe('withTimeoutGraceful', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('正常完了時は結果を返すこと', async () => {
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = Promise.resolve({ data: 'test' });

    const resultPromise = withTimeoutGraceful(
      promise,
      1000,
      'layout analysis',
      'layout',
      warnings
    );

    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result).toEqual({ data: 'test' });
    expect(warnings).toHaveLength(0);
  });

  it('タイムアウト時はnullを返し警告を追加すること', async () => {
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = new Promise<string>(() => {});

    const resultPromise = withTimeoutGraceful(
      promise,
      100,
      'slow layout',
      'layout',
      warnings
    );

    vi.advanceTimersByTime(100);
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      feature: 'layout',
      code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
    });
    expect(warnings[0].message).toContain('timed out after 100ms');
    expect(warnings[0].message).toContain('graceful degradation');
  });

  it('motion featureでのタイムアウトが正しく処理されること', async () => {
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = new Promise<string>(() => {});

    const resultPromise = withTimeoutGraceful(
      promise,
      200,
      'motion detection',
      'motion',
      warnings
    );

    vi.advanceTimersByTime(200);
    await resultPromise;

    expect(warnings[0].feature).toBe('motion');
  });

  it('quality featureでのタイムアウトが正しく処理されること', async () => {
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = new Promise<string>(() => {});

    const resultPromise = withTimeoutGraceful(
      promise,
      150,
      'quality evaluation',
      'quality',
      warnings
    );

    vi.advanceTimersByTime(150);
    await resultPromise;

    expect(warnings[0].feature).toBe('quality');
  });

  it('タイムアウト以外のエラーもGraceful Degradationで処理されること', async () => {
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = Promise.reject(new Error('Connection failed'));

    const result = await withTimeoutGraceful(
      promise,
      1000,
      'layout analysis',
      'layout',
      warnings
    );

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(PAGE_ANALYZE_ERROR_CODES.LAYOUT_ANALYSIS_FAILED);
    expect(warnings[0].message).toContain('Connection failed');
  });

  it('motion featureのエラーは正しいエラーコードを使用すること', async () => {
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = Promise.reject(new Error('Detection error'));

    await withTimeoutGraceful(
      promise,
      1000,
      'motion detection',
      'motion',
      warnings
    );

    expect(warnings[0].code).toBe(PAGE_ANALYZE_ERROR_CODES.MOTION_DETECTION_FAILED);
  });

  it('quality featureのエラーは正しいエラーコードを使用すること', async () => {
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = Promise.reject(new Error('Evaluation error'));

    await withTimeoutGraceful(
      promise,
      1000,
      'quality evaluation',
      'quality',
      warnings
    );

    expect(warnings[0].code).toBe(PAGE_ANALYZE_ERROR_CODES.QUALITY_EVALUATION_FAILED);
  });

  it('非Errorオブジェクトのエラーも処理できること', async () => {
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = Promise.reject('string error');

    await withTimeoutGraceful(
      promise,
      1000,
      'layout analysis',
      'layout',
      warnings
    );

    expect(warnings[0].message).toContain('string error');
  });
});

// =====================================================
// distributeTimeout Tests
// =====================================================

describe('distributeTimeout', () => {
  it('フレームキャプチャ・JSアニメーション無効時の分配が正しいこと', () => {
    const result = distributeTimeout(120000, false, false);

    expect(result.fetchHtml).toBeGreaterThan(0);
    expect(result.layoutAnalysis).toBeGreaterThan(0);
    expect(result.motionDetection).toBeGreaterThan(0);
    expect(result.qualityEvaluation).toBeGreaterThan(0);
    expect(result.frameCapture).toBeGreaterThan(0);
    expect(result.jsAnimationDetection).toBeGreaterThan(0);
    expect(result.dbSave).toBeGreaterThan(0);
  });

  it('フレームキャプチャ有効時はモーション検出タイムアウトが増加すること', () => {
    const withoutFrame = distributeTimeout(300000, false, false);
    const withFrame = distributeTimeout(300000, true, false);

    expect(withFrame.motionDetection).toBeGreaterThanOrEqual(withoutFrame.motionDetection);
  });

  it('JSアニメーション有効時はモーション検出タイムアウトが増加すること', () => {
    const withoutJs = distributeTimeout(300000, false, false);
    const withJs = distributeTimeout(300000, false, true);

    expect(withJs.motionDetection).toBeGreaterThanOrEqual(withoutJs.motionDetection);
  });

  it('フレームキャプチャ + JSアニメーション両方有効時は最大タイムアウトとなること', () => {
    const bothEnabled = distributeTimeout(600000, true, true);
    const frameOnly = distributeTimeout(600000, true, false);
    const jsOnly = distributeTimeout(600000, false, true);

    expect(bothEnabled.motionDetection).toBeGreaterThanOrEqual(frameOnly.motionDetection);
    expect(bothEnabled.motionDetection).toBeGreaterThanOrEqual(jsOnly.motionDetection);
  });

  it('WebGL検出時にモーション検出タイムアウトが延長されること', () => {
    const withoutWebgl = distributeTimeout(300000, false, true);
    const withWebgl = distributeTimeout(300000, false, true, { detected: true, multiplier: 1.5 });

    expect(withWebgl.motionDetection).toBeGreaterThan(withoutWebgl.motionDetection);
  });

  it('WebGL乗数がJSアニメーション無効時は適用されないこと', () => {
    const withoutJs = distributeTimeout(300000, false, false, { detected: true, multiplier: 2.0 });
    const withoutWebgl = distributeTimeout(300000, false, false);

    // JSアニメーション無効時はWebGL乗数は適用されない
    expect(withoutJs.motionDetection).toBe(withoutWebgl.motionDetection);
  });

  it('短いoverallTimeoutでも最小モーションタイムアウトが保証されること', () => {
    const result = distributeTimeout(10000, false, false);

    // 最小30秒保証
    expect(result.motionDetection).toBeGreaterThanOrEqual(30000);
  });

  it('フレームキャプチャ有効時の最小モーションタイムアウトが保証されること', () => {
    const result = distributeTimeout(10000, true, false);

    // 最小120秒（2分）保証
    expect(result.motionDetection).toBeGreaterThanOrEqual(120000);
  });

  it('WebGL + JSアニメーション有効時の最小モーションタイムアウトが保証されること', () => {
    const result = distributeTimeout(10000, false, true, { detected: true, multiplier: 1.5 });

    // 最小180秒（3分）保証
    expect(result.motionDetection).toBeGreaterThanOrEqual(180000);
  });

  it('ratioが1を超えないこと', () => {
    // 非常に大きなoverallTimeout
    const result = distributeTimeout(10000000, false, false);

    // 各タイムアウトはデフォルト値以下であるべき
    expect(result.fetchHtml).toBeLessThanOrEqual(PAGE_ANALYZE_TIMEOUTS.FETCH_HTML);
    expect(result.layoutAnalysis).toBeLessThanOrEqual(PAGE_ANALYZE_TIMEOUTS.LAYOUT_ANALYSIS);
    expect(result.qualityEvaluation).toBeLessThanOrEqual(PAGE_ANALYZE_TIMEOUTS.QUALITY_EVALUATION);
    expect(result.dbSave).toBeLessThanOrEqual(PAGE_ANALYZE_TIMEOUTS.DB_SAVE);
  });

  it('すべての返却値が正の整数であること', () => {
    const result = distributeTimeout(180000, true, true);

    Object.values(result).forEach(value => {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    });
  });
});

// =====================================================
// getRemainingTimeout Tests
// =====================================================

describe('getRemainingTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('経過時間が0の場合、全体タイムアウトを返すこと', () => {
    const startTime = Date.now();
    const remaining = getRemainingTimeout(startTime, 60000);

    expect(remaining).toBe(60000);
  });

  it('経過時間を差し引いた残り時間を返すこと', () => {
    const startTime = Date.now();

    vi.advanceTimersByTime(10000);

    const remaining = getRemainingTimeout(startTime, 60000);

    expect(remaining).toBe(50000);
  });

  it('残り時間が最小値を下回る場合、最小値を返すこと', () => {
    const startTime = Date.now();

    vi.advanceTimersByTime(58000); // 2秒残り（デフォルト最小5秒より少ない）

    const remaining = getRemainingTimeout(startTime, 60000);

    expect(remaining).toBe(5000); // デフォルト最小値
  });

  it('カスタム最小タイムアウトを使用できること', () => {
    const startTime = Date.now();

    vi.advanceTimersByTime(55000); // 5秒残り

    const remaining = getRemainingTimeout(startTime, 60000, 10000);

    expect(remaining).toBe(10000); // カスタム最小値
  });

  it('全体タイムアウトを超過した場合、最小値を返すこと', () => {
    const startTime = Date.now();

    vi.advanceTimersByTime(70000); // 10秒超過

    const remaining = getRemainingTimeout(startTime, 60000);

    expect(remaining).toBe(5000); // 最小値
  });
});

// =====================================================
// PHASE_PRIORITY Tests
// =====================================================

describe('PHASE_PRIORITY', () => {
  it('htmlが最高優先度であること', () => {
    expect(PHASE_PRIORITY.html).toBe(1);
  });

  it('screenshotがhtmlの次の優先度であること', () => {
    expect(PHASE_PRIORITY.screenshot).toBe(2);
    expect(PHASE_PRIORITY.screenshot).toBeGreaterThan(PHASE_PRIORITY.html);
  });

  it('layoutがscreenshotの次の優先度であること', () => {
    expect(PHASE_PRIORITY.layout).toBe(3);
    expect(PHASE_PRIORITY.layout).toBeGreaterThan(PHASE_PRIORITY.screenshot);
  });

  it('motionがlayoutの次の優先度であること', () => {
    expect(PHASE_PRIORITY.motion).toBe(4);
    expect(PHASE_PRIORITY.motion).toBeGreaterThan(PHASE_PRIORITY.layout);
  });

  it('qualityが最低優先度であること', () => {
    expect(PHASE_PRIORITY.quality).toBe(5);
    expect(PHASE_PRIORITY.quality).toBeGreaterThan(PHASE_PRIORITY.motion);
  });
});

// =====================================================
// ExecutionStatusTracker Tests
// =====================================================

describe('ExecutionStatusTracker', () => {
  describe('constructor', () => {
    it('デフォルト値で初期化できること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      const status = tracker.toExecutionStatus();

      expect(status.completed_phases).toEqual([]);
      expect(status.failed_phases).toEqual([]);
      expect(status.timeout_occurred).toBe(false);
      expect(status.webgl_detected).toBe(false);
      expect(status.timeout_extended).toBe(false);
    });

    it('WebGL検出オプションで初期化できること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 90000,
        strategy: 'progressive',
        partialResultsEnabled: true,
        webglDetected: true,
        timeoutExtended: true,
      });

      const status = tracker.toExecutionStatus();

      expect(status.webgl_detected).toBe(true);
      expect(status.timeout_extended).toBe(true);
      expect(status.original_timeout_ms).toBe(60000);
      expect(status.effective_timeout_ms).toBe(90000);
    });

    it('フェーズタイムアウト設定で初期化できること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
        phaseTimeouts: { layout: 30000, motion: 60000, quality: 15000 },
      });

      const status = tracker.toExecutionStatus();

      expect(status.phase_timeouts).toEqual({
        layout: 30000,
        motion: 60000,
        quality: 15000,
      });
    });
  });

  describe('markCompleted', () => {
    it('フェーズを完了としてマークできること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.markCompleted('html');
      tracker.markCompleted('layout');

      const status = tracker.toExecutionStatus();

      expect(status.completed_phases).toContain('html');
      expect(status.completed_phases).toContain('layout');
    });

    it('完了フェーズは優先順位でソートされること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      // 逆順で追加
      tracker.markCompleted('quality');
      tracker.markCompleted('html');
      tracker.markCompleted('layout');

      const status = tracker.toExecutionStatus();

      expect(status.completed_phases).toEqual(['html', 'layout', 'quality']);
    });

    it('完了としてマークすると失敗リストから削除されること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.markFailed('layout');
      expect(tracker.toExecutionStatus().failed_phases).toContain('layout');

      tracker.markCompleted('layout');
      expect(tracker.toExecutionStatus().failed_phases).not.toContain('layout');
      expect(tracker.toExecutionStatus().completed_phases).toContain('layout');
    });
  });

  describe('markFailed', () => {
    it('フェーズを失敗としてマークできること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.markFailed('motion');

      const status = tracker.toExecutionStatus();

      expect(status.failed_phases).toContain('motion');
    });

    it('タイムアウトフラグを設定できること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.markFailed('layout', true);

      const status = tracker.toExecutionStatus();

      expect(status.timeout_occurred).toBe(true);
      expect(status.timedout_phases).toContain('layout');
    });

    it('失敗フェーズは優先順位でソートされること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      // 逆順で追加
      tracker.markFailed('quality');
      tracker.markFailed('motion');
      tracker.markFailed('layout');

      const status = tracker.toExecutionStatus();

      expect(status.failed_phases).toEqual(['layout', 'motion', 'quality']);
    });
  });

  describe('setWebGLDetected', () => {
    it('WebGL検出状態を更新できること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.setWebGLDetected(true, true);

      const status = tracker.toExecutionStatus();

      expect(status.webgl_detected).toBe(true);
      expect(status.timeout_extended).toBe(true);
    });
  });

  describe('updateEffectiveTimeout', () => {
    it('有効タイムアウトを更新できること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
        timeoutExtended: true,
      });

      tracker.updateEffectiveTimeout(90000);

      const status = tracker.toExecutionStatus();

      expect(status.effective_timeout_ms).toBe(90000);
    });
  });

  describe('setPhaseTimeouts', () => {
    it('フェーズごとのタイムアウトを設定できること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.setPhaseTimeouts({ layout: 25000, motion: 50000, quality: 12000 });

      const status = tracker.toExecutionStatus();

      expect(status.phase_timeouts).toEqual({
        layout: 25000,
        motion: 50000,
        quality: 12000,
      });
    });
  });

  describe('shouldReturnPartialResults', () => {
    it('strict戦略では常にfalseを返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'strict',
        partialResultsEnabled: true,
      });

      tracker.markCompleted('html');

      expect(tracker.shouldReturnPartialResults()).toBe(false);
    });

    it('partialResultsEnabled=falseではfalseを返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: false,
      });

      tracker.markCompleted('html');

      expect(tracker.shouldReturnPartialResults()).toBe(false);
    });

    it('HTML未取得ではfalseを返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      expect(tracker.shouldReturnPartialResults()).toBe(false);
    });

    it('progressive + partialResults + HTML取得済みではtrueを返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.markCompleted('html');

      expect(tracker.shouldReturnPartialResults()).toBe(true);
    });
  });

  describe('isFullyCompleted', () => {
    it('すべてのフェーズが完了している場合にtrueを返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.markCompleted('html');
      tracker.markCompleted('screenshot');
      tracker.markCompleted('layout');
      tracker.markCompleted('motion');
      tracker.markCompleted('quality');

      expect(tracker.isFullyCompleted()).toBe(true);
    });

    it('一部のフェーズが未完了の場合にfalseを返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.markCompleted('html');
      tracker.markCompleted('layout');

      expect(tracker.isFullyCompleted()).toBe(false);
    });
  });

  describe('getElapsedTime', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('経過時間を正しく返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      vi.advanceTimersByTime(5000);

      expect(tracker.getElapsedTime()).toBe(5000);
    });
  });

  describe('hasTimedOut', () => {
    it('タイムアウト発生前はfalseを返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      expect(tracker.hasTimedOut()).toBe(false);
    });

    it('タイムアウト発生後はtrueを返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.markFailed('layout', true);

      expect(tracker.hasTimedOut()).toBe(true);
    });
  });

  describe('getStrategy', () => {
    it('progressive戦略を返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      expect(tracker.getStrategy()).toBe('progressive');
    });

    it('strict戦略を返すこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'strict',
        partialResultsEnabled: true,
      });

      expect(tracker.getStrategy()).toBe('strict');
    });
  });

  describe('toExecutionStatus', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('actual_duration_msが正しく計算されること', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      vi.advanceTimersByTime(3000);

      const status = tracker.toExecutionStatus();

      expect(status.actual_duration_ms).toBe(3000);
    });

    it('タイムアウト延長されていない場合はoriginal/effective_timeout_msが含まれないこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
        timeoutExtended: false,
      });

      const status = tracker.toExecutionStatus();

      expect(status.original_timeout_ms).toBeUndefined();
      expect(status.effective_timeout_ms).toBeUndefined();
    });

    it('タイムアウトしたフェーズがない場合はtimedout_phasesが含まれないこと', () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });

      tracker.markFailed('layout', false); // タイムアウトではない失敗

      const status = tracker.toExecutionStatus();

      expect(status.timedout_phases).toBeUndefined();
    });
  });
});

// =====================================================
// withTimeoutAndTracking Tests
// =====================================================

describe('withTimeoutAndTracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('正常完了時は結果を返しtrackerを更新すること', async () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
    });
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = Promise.resolve({ data: 'test' });

    const resultPromise = withTimeoutAndTracking(
      promise,
      1000,
      'layout analysis',
      'layout',
      tracker,
      warnings
    );

    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result).toEqual({ data: 'test' });
    expect(warnings).toHaveLength(0);
    expect(tracker.toExecutionStatus().completed_phases).toContain('layout');
  });

  it('Progressive戦略でタイムアウト時はnullを返し警告を追加すること', async () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
    });
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = new Promise<string>(() => {});

    const resultPromise = withTimeoutAndTracking(
      promise,
      100,
      'slow phase',
      'motion',
      tracker,
      warnings
    );

    vi.advanceTimersByTime(100);
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR);
    expect(tracker.hasTimedOut()).toBe(true);
    expect(tracker.toExecutionStatus().failed_phases).toContain('motion');
  });

  it('Strict戦略でタイムアウト時は例外をスローすること', async () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'strict',
      partialResultsEnabled: true,
    });
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = new Promise<string>(() => {});

    const resultPromise = withTimeoutAndTracking(
      promise,
      100,
      'strict phase',
      'layout',
      tracker,
      warnings
    );

    vi.advanceTimersByTime(100);

    await expect(resultPromise).rejects.toThrow(PhaseTimeoutError);
    expect(tracker.toExecutionStatus().failed_phases).toContain('layout');
  });

  it('Progressive戦略で非タイムアウトエラー時はnullを返すこと', async () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
    });
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = Promise.reject(new Error('Connection error'));

    const result = await withTimeoutAndTracking(
      promise,
      1000,
      'error phase',
      'quality',
      tracker,
      warnings
    );

    expect(result).toBeNull();
    expect(warnings[0].code).toBe(PAGE_ANALYZE_ERROR_CODES.QUALITY_EVALUATION_FAILED);
    expect(tracker.toExecutionStatus().failed_phases).toContain('quality');
  });

  it('Strict戦略で非タイムアウトエラー時は例外を再スローすること', async () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'strict',
      partialResultsEnabled: true,
    });
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = Promise.reject(new Error('Fatal error'));

    await expect(
      withTimeoutAndTracking(
        promise,
        1000,
        'error phase',
        'motion',
        tracker,
        warnings
      )
    ).rejects.toThrow('Fatal error');
  });

  it('htmlフェーズはlayout featureとして警告が記録されること', async () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
    });
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = new Promise<string>(() => {});

    const resultPromise = withTimeoutAndTracking(
      promise,
      100,
      'html fetch',
      'html',
      tracker,
      warnings
    );

    vi.advanceTimersByTime(100);
    await resultPromise;

    expect(warnings[0].feature).toBe('layout');
  });

  it('screenshotフェーズはlayout featureとして警告が記録されること', async () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
    });
    const warnings: { feature: string; code: string; message: string }[] = [];
    const promise = Promise.reject(new Error('Screenshot failed'));

    await withTimeoutAndTracking(
      promise,
      1000,
      'screenshot capture',
      'screenshot',
      tracker,
      warnings
    );

    expect(warnings[0].feature).toBe('layout');
  });
});
