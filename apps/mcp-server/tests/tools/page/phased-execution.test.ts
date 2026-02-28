// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase2-1: 段階的分析実装テスト
 *
 * 各フェーズ（Layout, Motion, Quality）を独立して実行し、
 * 部分成功を許容する段階的分析のテスト
 *
 * @module tests/tools/page/phased-execution.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PhasedExecutor,
  type PhaseResult,
  type PhasedExecutionResult,
  type PhasedExecutorOptions,
} from '../../../src/tools/page/handlers/phased-executor';
import { ExecutionStatusTracker } from '../../../src/tools/page/handlers/timeout-utils';

// テスト用の遅延関数
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// モック関数を作成
const createMockOptions = (overrides: Partial<PhasedExecutorOptions> = {}): PhasedExecutorOptions => {
  const tracker = new ExecutionStatusTracker({
    originalTimeoutMs: 60000,
    effectiveTimeoutMs: 60000,
    strategy: 'progressive',
    partialResultsEnabled: true,
  });

  return {
    html: '<html><body><h1>Test</h1></body></html>',
    url: 'https://example.com',
    features: { layout: true, motion: true, quality: true },
    tracker,
    phaseTimeouts: {
      layout: 10000,
      motion: 10000,
      quality: 10000,
    },
    // デフォルトのモック分析関数
    analyzeLayout: vi.fn().mockResolvedValue({
      success: true,
      pageId: 'test-page-id',
      sectionCount: 3,
      sectionTypes: { hero: 1, feature: 2 },
      processingTimeMs: 100,
    }),
    detectMotion: vi.fn().mockResolvedValue({
      success: true,
      patternCount: 5,
      categoryBreakdown: { animation: 3, transition: 2 },
      warningCount: 0,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: 200,
    }),
    evaluateQuality: vi.fn().mockResolvedValue({
      success: true,
      overallScore: 85,
      grade: 'A',
      axisScores: { originality: 80, craftsmanship: 90, contextuality: 85 },
      clicheCount: 0,
      processingTimeMs: 150,
    }),
    ...overrides,
  };
};

describe('PhasedExecutor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('基本的な実行', () => {
    it('全フェーズが成功した場合、overallSuccess=trueを返す', async () => {
      const options = createMockOptions();
      const executor = new PhasedExecutor(options);

      // Promiseを取得
      const resultPromise = executor.execute();

      // タイマーを進める
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(result.overallSuccess).toBe(true);
      expect(result.partialSuccess).toBe(true);
      expect(result.completedPhases).toEqual(['layout', 'motion', 'quality']);
      expect(result.failedPhases).toEqual([]);
      expect(result.layout.success).toBe(true);
      expect(result.motion.success).toBe(true);
      expect(result.quality.success).toBe(true);
    });

    it('各フェーズのdurationMsが記録される', async () => {
      const options = createMockOptions();
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.layout.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.motion.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.quality.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('フェーズの独立性', () => {
    it('Layoutが失敗してもMotionとQualityは実行される', async () => {
      const options = createMockOptions({
        analyzeLayout: vi.fn().mockRejectedValue(new Error('Layout analysis failed')),
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.overallSuccess).toBe(false);
      expect(result.partialSuccess).toBe(true);
      expect(result.layout.success).toBe(false);
      expect(result.layout.error).toBe('Layout analysis failed');
      expect(result.motion.success).toBe(true);
      expect(result.quality.success).toBe(true);
      expect(result.completedPhases).toEqual(['motion', 'quality']);
      expect(result.failedPhases).toEqual(['layout']);
    });

    it('Motionが失敗してもLayoutとQualityは成功を維持する', async () => {
      const options = createMockOptions({
        detectMotion: vi.fn().mockRejectedValue(new Error('Motion detection failed')),
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.overallSuccess).toBe(false);
      expect(result.partialSuccess).toBe(true);
      expect(result.layout.success).toBe(true);
      expect(result.motion.success).toBe(false);
      expect(result.motion.error).toBe('Motion detection failed');
      expect(result.quality.success).toBe(true);
      expect(result.completedPhases).toEqual(['layout', 'quality']);
      expect(result.failedPhases).toEqual(['motion']);
    });

    it('Qualityが失敗してもLayoutとMotionは成功を維持する', async () => {
      const options = createMockOptions({
        evaluateQuality: vi.fn().mockRejectedValue(new Error('Quality evaluation failed')),
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.overallSuccess).toBe(false);
      expect(result.partialSuccess).toBe(true);
      expect(result.layout.success).toBe(true);
      expect(result.motion.success).toBe(true);
      expect(result.quality.success).toBe(false);
      expect(result.quality.error).toBe('Quality evaluation failed');
      expect(result.completedPhases).toEqual(['layout', 'motion']);
      expect(result.failedPhases).toEqual(['quality']);
    });

    it('全フェーズが失敗した場合、partialSuccess=falseを返す', async () => {
      const options = createMockOptions({
        analyzeLayout: vi.fn().mockRejectedValue(new Error('Layout failed')),
        detectMotion: vi.fn().mockRejectedValue(new Error('Motion failed')),
        evaluateQuality: vi.fn().mockRejectedValue(new Error('Quality failed')),
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.overallSuccess).toBe(false);
      expect(result.partialSuccess).toBe(false);
      expect(result.completedPhases).toEqual([]);
      expect(result.failedPhases).toEqual(['layout', 'motion', 'quality']);
    });
  });

  describe('タイムアウト処理', () => {
    it('Layoutがタイムアウトした場合、timedOut=trueが設定される', async () => {
      vi.useRealTimers(); // タイムアウトテストでは実際のタイマーを使用

      const options = createMockOptions({
        phaseTimeouts: {
          layout: 50, // 50ms
          motion: 10000,
          quality: 10000,
        },
        analyzeLayout: vi.fn().mockImplementation(() => delay(200)), // 200ms（タイムアウトする）
      });
      const executor = new PhasedExecutor(options);

      const result = await executor.execute();

      expect(result.layout.success).toBe(false);
      expect(result.layout.timedOut).toBe(true);
      expect(result.layout.error).toContain('timed out');
    });

    it('Motionがタイムアウトしても他のフェーズは正常に完了する', async () => {
      vi.useRealTimers();

      const options = createMockOptions({
        phaseTimeouts: {
          layout: 10000,
          motion: 50, // 50ms
          quality: 10000,
        },
        detectMotion: vi.fn().mockImplementation(() => delay(200)), // タイムアウトする
      });
      const executor = new PhasedExecutor(options);

      const result = await executor.execute();

      expect(result.layout.success).toBe(true);
      expect(result.motion.success).toBe(false);
      expect(result.motion.timedOut).toBe(true);
      expect(result.quality.success).toBe(true);
      expect(result.partialSuccess).toBe(true);
    });
  });

  describe('featuresオプション', () => {
    it('layout=falseの場合、Layoutフェーズはスキップされる', async () => {
      const options = createMockOptions({
        features: { layout: false, motion: true, quality: true },
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.layout.success).toBe(false);
      expect(result.layout.error).toBe('Phase skipped');
      expect(result.motion.success).toBe(true);
      expect(result.quality.success).toBe(true);
      expect(result.completedPhases).toEqual(['motion', 'quality']);
      expect(result.failedPhases).toEqual([]); // スキップはfailではない
      expect(options.analyzeLayout).not.toHaveBeenCalled();
    });

    it('motion=falseの場合、Motionフェーズはスキップされる', async () => {
      const options = createMockOptions({
        features: { layout: true, motion: false, quality: true },
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.layout.success).toBe(true);
      expect(result.motion.success).toBe(false);
      expect(result.motion.error).toBe('Phase skipped');
      expect(result.quality.success).toBe(true);
      expect(result.completedPhases).toEqual(['layout', 'quality']);
      expect(options.detectMotion).not.toHaveBeenCalled();
    });

    it('quality=falseの場合、Qualityフェーズはスキップされる', async () => {
      const options = createMockOptions({
        features: { layout: true, motion: true, quality: false },
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.layout.success).toBe(true);
      expect(result.motion.success).toBe(true);
      expect(result.quality.success).toBe(false);
      expect(result.quality.error).toBe('Phase skipped');
      expect(result.completedPhases).toEqual(['layout', 'motion']);
      expect(options.evaluateQuality).not.toHaveBeenCalled();
    });
  });

  describe('onPhaseCompleteコールバック', () => {
    it('フェーズ成功時にonPhaseCompleteが呼ばれる', async () => {
      const onPhaseComplete = vi.fn();
      const options = createMockOptions({ onPhaseComplete });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(onPhaseComplete).toHaveBeenCalledTimes(3);
      expect(onPhaseComplete).toHaveBeenNthCalledWith(1, 'layout', expect.objectContaining({
        phase: 'layout',
        success: true,
      }));
      expect(onPhaseComplete).toHaveBeenNthCalledWith(2, 'motion', expect.objectContaining({
        phase: 'motion',
        success: true,
      }));
      expect(onPhaseComplete).toHaveBeenNthCalledWith(3, 'quality', expect.objectContaining({
        phase: 'quality',
        success: true,
      }));
    });

    it('フェーズ失敗時にはonPhaseCompleteは呼ばれない', async () => {
      const onPhaseComplete = vi.fn();
      const options = createMockOptions({
        onPhaseComplete,
        detectMotion: vi.fn().mockRejectedValue(new Error('Motion failed')),
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      await resultPromise;

      // Layout と Quality のみ成功
      expect(onPhaseComplete).toHaveBeenCalledTimes(2);
      expect(onPhaseComplete).toHaveBeenCalledWith('layout', expect.any(Object));
      expect(onPhaseComplete).toHaveBeenCalledWith('quality', expect.any(Object));
      // Motion は呼ばれない
      expect(onPhaseComplete).not.toHaveBeenCalledWith('motion', expect.any(Object));
    });

    it('onPhaseCompleteでエラーが発生しても処理は継続する', async () => {
      const onPhaseComplete = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Callback error'))
        .mockResolvedValueOnce(undefined);
      const options = createMockOptions({ onPhaseComplete });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      // コールバックエラーがあっても全フェーズ成功
      expect(result.overallSuccess).toBe(true);
      expect(onPhaseComplete).toHaveBeenCalledTimes(3);
    });
  });

  describe('ExecutionStatusTrackerとの連携', () => {
    it('完了したフェーズがTrackerに記録される', async () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });
      const options = createMockOptions({ tracker });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      await resultPromise;

      const status = tracker.toExecutionStatus();
      expect(status.completed_phases).toContain('layout');
      expect(status.completed_phases).toContain('motion');
      expect(status.completed_phases).toContain('quality');
    });

    it('失敗したフェーズがTrackerに記録される', async () => {
      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });
      const options = createMockOptions({
        tracker,
        detectMotion: vi.fn().mockRejectedValue(new Error('Motion failed')),
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      await resultPromise;

      const status = tracker.toExecutionStatus();
      expect(status.completed_phases).toContain('layout');
      expect(status.failed_phases).toContain('motion');
      expect(status.completed_phases).toContain('quality');
    });

    it('タイムアウト発生時はtimeout_occurred=trueが設定される', async () => {
      vi.useRealTimers();

      const tracker = new ExecutionStatusTracker({
        originalTimeoutMs: 60000,
        effectiveTimeoutMs: 60000,
        strategy: 'progressive',
        partialResultsEnabled: true,
      });
      const options = createMockOptions({
        tracker,
        phaseTimeouts: {
          layout: 50,
          motion: 10000,
          quality: 10000,
        },
        analyzeLayout: vi.fn().mockImplementation(() => delay(200)),
      });
      const executor = new PhasedExecutor(options);

      await executor.execute();

      const status = tracker.toExecutionStatus();
      expect(status.timeout_occurred).toBe(true);
    });
  });

  describe('データの受け渡し', () => {
    it('各フェーズの結果データが正しく格納される', async () => {
      const layoutData = {
        success: true,
        pageId: 'test-page-123',
        sectionCount: 5,
        sectionTypes: { hero: 1, feature: 3, cta: 1 },
        processingTimeMs: 100,
      };
      const motionData = {
        success: true,
        patternCount: 10,
        categoryBreakdown: { animation: 7, transition: 3 },
        warningCount: 2,
        a11yWarningCount: 1,
        perfWarningCount: 1,
        processingTimeMs: 200,
      };
      const qualityData = {
        success: true,
        overallScore: 92,
        grade: 'A' as const,
        axisScores: { originality: 90, craftsmanship: 95, contextuality: 90 },
        clicheCount: 0,
        processingTimeMs: 150,
      };

      const options = createMockOptions({
        analyzeLayout: vi.fn().mockResolvedValue(layoutData),
        detectMotion: vi.fn().mockResolvedValue(motionData),
        evaluateQuality: vi.fn().mockResolvedValue(qualityData),
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.layout.data).toEqual(layoutData);
      expect(result.motion.data).toEqual(motionData);
      expect(result.quality.data).toEqual(qualityData);
    });
  });

  describe('順次実行（シーケンシャルモード）', () => {
    it('デフォルトでは各フェーズが順次実行される', async () => {
      const callOrder: string[] = [];
      const options = createMockOptions({
        analyzeLayout: vi.fn().mockImplementation(async () => {
          callOrder.push('layout-start');
          await Promise.resolve();
          callOrder.push('layout-end');
          return { success: true, sectionCount: 1, sectionTypes: {}, processingTimeMs: 100 };
        }),
        detectMotion: vi.fn().mockImplementation(async () => {
          callOrder.push('motion-start');
          await Promise.resolve();
          callOrder.push('motion-end');
          return { success: true, patternCount: 1, categoryBreakdown: {}, warningCount: 0, a11yWarningCount: 0, perfWarningCount: 0, processingTimeMs: 100 };
        }),
        evaluateQuality: vi.fn().mockImplementation(async () => {
          callOrder.push('quality-start');
          await Promise.resolve();
          callOrder.push('quality-end');
          return { success: true, overallScore: 85, grade: 'A' as const, axisScores: { originality: 85, craftsmanship: 85, contextuality: 85 }, clicheCount: 0, processingTimeMs: 100 };
        }),
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      await resultPromise;

      // 順次実行されることを確認
      expect(callOrder).toEqual([
        'layout-start', 'layout-end',
        'motion-start', 'motion-end',
        'quality-start', 'quality-end',
      ]);
    });
  });

  describe('エッジケース', () => {
    it('空のHTMLでも処理できる', async () => {
      const options = createMockOptions({
        html: '',
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      await resultPromise;

      // 分析関数が呼ばれることを確認（空でも処理される）
      // layoutOptionsはundefinedで渡される
      expect(options.analyzeLayout).toHaveBeenCalledWith('', undefined);
    });

    it('分析関数がundefinedを返した場合でもエラーにならない', async () => {
      const options = createMockOptions({
        analyzeLayout: vi.fn().mockResolvedValue(undefined),
      });
      const executor = new PhasedExecutor(options);

      const resultPromise = executor.execute();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.layout.success).toBe(true);
      expect(result.layout.data).toBeUndefined();
    });
  });
});

describe('PhaseResult型', () => {
  it('PhaseResultが正しい構造を持つ', () => {
    const phaseResult: PhaseResult<{ test: string }> = {
      phase: 'layout',
      success: true,
      data: { test: 'value' },
      durationMs: 100,
      timedOut: false,
    };

    expect(phaseResult.phase).toBe('layout');
    expect(phaseResult.success).toBe(true);
    expect(phaseResult.data).toEqual({ test: 'value' });
    expect(phaseResult.durationMs).toBe(100);
    expect(phaseResult.timedOut).toBe(false);
  });

  it('失敗時のPhaseResultが正しい構造を持つ', () => {
    const phaseResult: PhaseResult<{ test: string }> = {
      phase: 'motion',
      success: false,
      error: 'Something went wrong',
      durationMs: 50,
      timedOut: true,
    };

    expect(phaseResult.phase).toBe('motion');
    expect(phaseResult.success).toBe(false);
    expect(phaseResult.error).toBe('Something went wrong');
    expect(phaseResult.data).toBeUndefined();
    expect(phaseResult.timedOut).toBe(true);
  });
});

describe('PhasedExecutionResult型', () => {
  it('PhasedExecutionResultが正しい構造を持つ', () => {
    const result: PhasedExecutionResult = {
      layout: { phase: 'layout', success: true, durationMs: 100, timedOut: false },
      motion: { phase: 'motion', success: true, durationMs: 200, timedOut: false },
      quality: { phase: 'quality', success: true, durationMs: 150, timedOut: false },
      overallSuccess: true,
      partialSuccess: true,
      completedPhases: ['layout', 'motion', 'quality'],
      failedPhases: [],
    };

    expect(result.overallSuccess).toBe(true);
    expect(result.partialSuccess).toBe(true);
    expect(result.completedPhases).toHaveLength(3);
    expect(result.failedPhases).toHaveLength(0);
  });
});

// =============================================================================
// Per-Phase Timeout Tests (v0.1.0)
// =============================================================================

describe('ExecutionStatusTracker - per-phase timeout tracking', () => {
  it('タイムアウトしたフェーズを個別に追跡する', () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
      phaseTimeouts: { layout: 30000, motion: 120000, quality: 15000 },
    });

    // layoutがタイムアウト
    tracker.markFailed('layout', true);
    // motionは成功
    tracker.markCompleted('motion');
    // qualityがタイムアウト
    tracker.markFailed('quality', true);

    const status = tracker.toExecutionStatus();

    expect(status.timeout_occurred).toBe(true);
    expect(status.timedout_phases).toEqual(['layout', 'quality']);
    expect(status.completed_phases).toContain('motion');
    expect(status.failed_phases).toContain('layout');
    expect(status.failed_phases).toContain('quality');
  });

  it('phaseTimeoutsをExecutionStatusに含める', () => {
    const phaseTimeouts = { layout: 30000, motion: 120000, quality: 15000 };
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
      phaseTimeouts,
    });

    tracker.markCompleted('layout');
    tracker.markCompleted('motion');
    tracker.markCompleted('quality');

    const status = tracker.toExecutionStatus();

    expect(status.phase_timeouts).toEqual(phaseTimeouts);
    expect(status.timedout_phases).toBeUndefined();
  });

  it('setPhaseTimeoutsで後から設定可能', () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
    });

    // 初期状態ではphaseTimeoutsなし
    let status = tracker.toExecutionStatus();
    expect(status.phase_timeouts).toBeUndefined();

    // 後から設定
    const phaseTimeouts = { layout: 30000, motion: 120000, quality: 15000 };
    tracker.setPhaseTimeouts(phaseTimeouts);

    status = tracker.toExecutionStatus();
    expect(status.phase_timeouts).toEqual(phaseTimeouts);
  });

  it('タイムアウトフェーズは優先順位でソートされる', () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
    });

    // 逆順でタイムアウトを記録
    tracker.markFailed('quality', true);
    tracker.markFailed('motion', true);
    tracker.markFailed('layout', true);

    const status = tracker.toExecutionStatus();

    // 優先順位順（layout -> motion -> quality）にソートされている
    expect(status.timedout_phases).toEqual(['layout', 'motion', 'quality']);
  });

  it('完了したフェーズはタイムアウトリストから削除される', () => {
    const tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
    });

    // 最初にタイムアウトとして記録
    tracker.markFailed('layout', true);

    // その後成功として記録（リトライ成功など）
    tracker.markCompleted('layout');

    const status = tracker.toExecutionStatus();

    expect(status.timedout_phases).toBeUndefined();
    expect(status.completed_phases).toContain('layout');
    expect(status.failed_phases).not.toContain('layout');
  });
});

describe('PhasedExecutor - per-phase timeout integration', () => {
  it('個別のphaseTimeoutsが各フェーズに適用される', async () => {
    const options = createMockOptions({
      phaseTimeouts: {
        layout: 5000,   // レイアウトは5秒
        motion: 10000,  // モーションは10秒
        quality: 3000,  // 品質は3秒
      },
    });

    const executor = new PhasedExecutor(options);
    const result = await executor.execute();

    expect(result.overallSuccess).toBe(true);
    expect(result.completedPhases).toHaveLength(3);
  });

  it('短いタイムアウトでレイアウトのみ失敗し、他のフェーズは成功', async () => {
    const slowLayoutFn = vi.fn().mockImplementation(async () => {
      await delay(200); // 200ms遅延
      return { success: true, sectionCount: 1 };
    });

    const options = createMockOptions({
      phaseTimeouts: {
        layout: 50,    // 50ms - タイムアウトする
        motion: 10000, // 10秒 - 十分
        quality: 10000, // 10秒 - 十分
      },
      analyzeLayout: slowLayoutFn,
    });

    const executor = new PhasedExecutor(options);
    const result = await executor.execute();

    // レイアウトはタイムアウト
    expect(result.layout.success).toBe(false);
    expect(result.layout.timedOut).toBe(true);

    // モーション、品質は成功
    expect(result.motion.success).toBe(true);
    expect(result.quality.success).toBe(true);

    // 部分成功
    expect(result.partialSuccess).toBe(true);
    expect(result.overallSuccess).toBe(false);
    expect(result.completedPhases).toEqual(['motion', 'quality']);
    expect(result.failedPhases).toEqual(['layout']);
  });
});
