// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ProgressReporter Unit Tests
 *
 * Vision CPU完走保証 Phase 4: CPU推論時の長時間処理における進捗報告サービス
 *
 * TDD RED Phase: 失敗するテストを先に作成
 *
 * @see apps/mcp-server/src/services/vision/progress-reporter.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProgressReporter,
  type ProgressEvent,
  type ProgressCallback,
  type ProgressReporterConfig,
  ProgressPhase,
} from '../../../src/services/vision/progress-reporter.js';

// =============================================================================
// テスト用ヘルパー
// =============================================================================

/**
 * ProgressEventの期待値を作成
 */
function expectProgressEvent(
  event: ProgressEvent,
  expectedPhase: ProgressEvent['phase'],
  expectedProgressRange: { min: number; max: number }
): void {
  expect(event.phase).toBe(expectedPhase);
  expect(event.progress).toBeGreaterThanOrEqual(expectedProgressRange.min);
  expect(event.progress).toBeLessThanOrEqual(expectedProgressRange.max);
  expect(event.estimatedRemainingMs).toBeGreaterThanOrEqual(0);
  expect(event.message).toBeTruthy();
}

// =============================================================================
// ProgressReporter テスト
// =============================================================================

describe('ProgressReporter', () => {
  let reporter: ProgressReporter;
  let progressCallback: ProgressCallback;
  let receivedEvents: ProgressEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    receivedEvents = [];
    progressCallback = vi.fn((event: ProgressEvent) => {
      receivedEvents.push(event);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    reporter?.abort();
  });

  // ===========================================================================
  // 初期化テスト
  // ===========================================================================

  describe('constructor', () => {
    it('should create instance with default config', () => {
      reporter = new ProgressReporter();
      expect(reporter).toBeInstanceOf(ProgressReporter);
    });

    it('should create instance with custom config', () => {
      reporter = new ProgressReporter({
        onProgress: progressCallback,
        reportInterval: 10000,
        enableConsoleLog: true,
      });
      expect(reporter).toBeInstanceOf(ProgressReporter);
    });

    it('should accept undefined config values', () => {
      reporter = new ProgressReporter({
        onProgress: undefined,
        reportInterval: undefined,
        enableConsoleLog: undefined,
      });
      expect(reporter).toBeInstanceOf(ProgressReporter);
    });
  });

  // ===========================================================================
  // start() テスト
  // ===========================================================================

  describe('start', () => {
    it('should emit preparing phase on start', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });

      reporter.start(60000);

      expect(progressCallback).toHaveBeenCalledTimes(1);
      expectProgressEvent(receivedEvents[0], 'preparing', { min: 0, max: 10 });
    });

    it('should set estimatedTotalMs correctly', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });

      reporter.start(180000);

      const event = receivedEvents[0];
      // 開始直後は推定残り時間 ≈ 推定合計時間
      expect(event.estimatedRemainingMs).toBeLessThanOrEqual(180000);
      expect(event.estimatedRemainingMs).toBeGreaterThan(0);
    });

    it('should emit message with estimated time', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });

      reporter.start(600000); // 10分

      expect(receivedEvents[0].message).toMatch(/準備中|preparing|10/i);
    });

    it('should handle zero estimatedTotalMs', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });

      expect(() => reporter.start(0)).not.toThrow();
      expect(receivedEvents[0].progress).toBe(0);
    });

    it('should handle negative estimatedTotalMs', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });

      expect(() => reporter.start(-1000)).not.toThrow();
    });

    it('should not emit if no callback provided', () => {
      reporter = new ProgressReporter(); // No callback

      expect(() => reporter.start(60000)).not.toThrow();
    });
  });

  // ===========================================================================
  // updatePhase() テスト
  // ===========================================================================

  describe('updatePhase', () => {
    beforeEach(() => {
      reporter = new ProgressReporter({ onProgress: progressCallback });
      reporter.start(60000);
      receivedEvents = [];
      vi.mocked(progressCallback).mockClear();
    });

    it('should emit progress event on phase change', () => {
      reporter.updatePhase('optimizing');

      expect(progressCallback).toHaveBeenCalledTimes(1);
      expectProgressEvent(receivedEvents[0], 'optimizing', { min: 10, max: 30 });
    });

    it('should calculate correct progress for preparing phase (0-10%)', () => {
      reporter.updatePhase('preparing');

      expectProgressEvent(receivedEvents[0], 'preparing', { min: 0, max: 10 });
    });

    it('should calculate correct progress for optimizing phase (10-30%)', () => {
      reporter.updatePhase('optimizing');

      expectProgressEvent(receivedEvents[0], 'optimizing', { min: 10, max: 30 });
    });

    it('should calculate correct progress for analyzing phase (30-90%)', () => {
      reporter.updatePhase('analyzing');

      expectProgressEvent(receivedEvents[0], 'analyzing', { min: 30, max: 90 });
    });

    it('should calculate correct progress for completing phase (90-100%)', () => {
      reporter.updatePhase('completing');

      expectProgressEvent(receivedEvents[0], 'completing', { min: 90, max: 100 });
    });

    it('should emit message specific to each phase', () => {
      reporter.updatePhase('analyzing');

      expect(receivedEvents[0].message).toMatch(/分析|analyzing|推論|inference/i);
    });

    it('should track current phase internally', () => {
      reporter.updatePhase('analyzing');

      const currentProgress = reporter.getCurrentProgress();
      expect(currentProgress.phase).toBe('analyzing');
    });
  });

  // ===========================================================================
  // updateProgress() テスト
  // ===========================================================================

  describe('updateProgress', () => {
    beforeEach(() => {
      reporter = new ProgressReporter({ onProgress: progressCallback });
      reporter.start(60000);
      receivedEvents = [];
      vi.mocked(progressCallback).mockClear();
    });

    it('should emit event with specified progress value', () => {
      reporter.updateProgress(50);

      expect(progressCallback).toHaveBeenCalledTimes(1);
      expect(receivedEvents[0].progress).toBe(50);
    });

    it('should clamp progress to 0-100 range', () => {
      reporter.updateProgress(150);
      expect(receivedEvents[0].progress).toBe(100);

      vi.mocked(progressCallback).mockClear();
      receivedEvents = [];

      reporter.updateProgress(-10);
      expect(receivedEvents[0].progress).toBe(0);
    });

    it('should update estimatedRemainingMs based on progress', () => {
      reporter.updateProgress(50);

      // 50% 完了時、推定残り時間は初期の約半分
      expect(receivedEvents[0].estimatedRemainingMs).toBeLessThanOrEqual(60000);
    });

    it('should keep current phase when updating progress', () => {
      reporter.updatePhase('analyzing');
      vi.mocked(progressCallback).mockClear();
      receivedEvents = [];

      reporter.updateProgress(60);

      expect(receivedEvents[0].phase).toBe('analyzing');
    });
  });

  // ===========================================================================
  // 推定時間計算テスト
  // ===========================================================================

  describe('progress calculation', () => {
    beforeEach(() => {
      reporter = new ProgressReporter({ onProgress: progressCallback });
    });

    it('should calculate estimatedRemainingMs based on elapsed time', () => {
      reporter.start(60000);

      // 30秒経過をシミュレート
      vi.advanceTimersByTime(30000);

      // 手動で進捗更新
      reporter.updateProgress(50);

      const event = receivedEvents[receivedEvents.length - 1];
      // 50%完了、残り約30秒
      expect(event.estimatedRemainingMs).toBeLessThanOrEqual(30000);
    });

    it('should return 0 when estimatedRemainingMs goes negative', () => {
      reporter.start(60000);

      // 推定時間を超過（90秒経過）
      vi.advanceTimersByTime(90000);

      // 進捗は80%（未完了状態）
      reporter.updateProgress(80);

      const event = receivedEvents[receivedEvents.length - 1];
      expect(event.estimatedRemainingMs).toBeGreaterThanOrEqual(0);
    });

    it('should decrease estimatedRemainingMs as time progresses', () => {
      reporter.start(60000);
      const initialRemaining = receivedEvents[0].estimatedRemainingMs;

      vi.advanceTimersByTime(10000);
      reporter.updateProgress(20);
      const laterRemaining = receivedEvents[receivedEvents.length - 1].estimatedRemainingMs;

      expect(laterRemaining).toBeLessThanOrEqual(initialRemaining);
    });
  });

  // ===========================================================================
  // 自動進捗報告テスト
  // ===========================================================================

  describe('automatic progress reporting', () => {
    it('should emit progress events at reportInterval', () => {
      reporter = new ProgressReporter({
        onProgress: progressCallback,
        reportInterval: 5000, // 5秒ごと
      });

      reporter.start(60000);
      vi.mocked(progressCallback).mockClear();
      receivedEvents = [];

      // 5秒経過
      vi.advanceTimersByTime(5000);
      expect(progressCallback).toHaveBeenCalledTimes(1);

      // さらに5秒経過（合計10秒）
      vi.advanceTimersByTime(5000);
      expect(progressCallback).toHaveBeenCalledTimes(2);
    });

    it('should use default reportInterval of 5000ms', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });

      reporter.start(60000);
      vi.mocked(progressCallback).mockClear();

      // デフォルト5秒経過
      vi.advanceTimersByTime(5000);
      expect(progressCallback).toHaveBeenCalledTimes(1);
    });

    it('should stop interval on abort', () => {
      reporter = new ProgressReporter({
        onProgress: progressCallback,
        reportInterval: 1000,
      });

      reporter.start(60000);
      reporter.abort();

      vi.mocked(progressCallback).mockClear();

      // abort後はイベントが発火しない
      vi.advanceTimersByTime(5000);
      expect(progressCallback).not.toHaveBeenCalled();
    });

    it('should stop interval on complete', () => {
      reporter = new ProgressReporter({
        onProgress: progressCallback,
        reportInterval: 1000,
      });

      reporter.start(60000);
      reporter.complete();

      vi.mocked(progressCallback).mockClear();

      // complete後はイベントが発火しない
      vi.advanceTimersByTime(5000);
      expect(progressCallback).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // complete() テスト
  // ===========================================================================

  describe('complete', () => {
    beforeEach(() => {
      reporter = new ProgressReporter({ onProgress: progressCallback });
      reporter.start(60000);
      receivedEvents = [];
      vi.mocked(progressCallback).mockClear();
    });

    it('should emit completing phase at 100%', () => {
      reporter.complete();

      expect(progressCallback).toHaveBeenCalledTimes(1);
      expectProgressEvent(receivedEvents[0], 'completing', { min: 100, max: 100 });
    });

    it('should clear interval', () => {
      reporter.complete();

      vi.mocked(progressCallback).mockClear();
      receivedEvents = [];

      vi.advanceTimersByTime(10000);
      expect(progressCallback).not.toHaveBeenCalled();
    });

    it('should set estimatedRemainingMs to 0', () => {
      reporter.complete();

      expect(receivedEvents[0].estimatedRemainingMs).toBe(0);
    });

    it('should emit completion message', () => {
      reporter.complete();

      expect(receivedEvents[0].message).toMatch(/完了|complete/i);
    });

    it('should be idempotent (multiple calls should not throw)', () => {
      expect(() => {
        reporter.complete();
        reporter.complete();
        reporter.complete();
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // abort() テスト
  // ===========================================================================

  describe('abort', () => {
    beforeEach(() => {
      reporter = new ProgressReporter({ onProgress: progressCallback });
      reporter.start(60000);
      vi.mocked(progressCallback).mockClear();
      receivedEvents = [];
    });

    it('should stop interval', () => {
      reporter.abort();

      vi.advanceTimersByTime(10000);
      expect(progressCallback).not.toHaveBeenCalled();
    });

    it('should not emit further events', () => {
      reporter.abort();

      expect(progressCallback).not.toHaveBeenCalled();
    });

    it('should be safe to call before start', () => {
      const freshReporter = new ProgressReporter({ onProgress: progressCallback });

      expect(() => freshReporter.abort()).not.toThrow();
    });

    it('should be idempotent (multiple calls should not throw)', () => {
      expect(() => {
        reporter.abort();
        reporter.abort();
        reporter.abort();
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // getCurrentProgress() テスト
  // ===========================================================================

  describe('getCurrentProgress', () => {
    it('should return initial state before start', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });

      const progress = reporter.getCurrentProgress();

      expect(progress.phase).toBe('preparing');
      expect(progress.progress).toBe(0);
      expect(progress.estimatedRemainingMs).toBe(0);
      expect(progress.message).toBeTruthy();
    });

    it('should return current state after start', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });
      reporter.start(60000);

      const progress = reporter.getCurrentProgress();

      expect(progress.phase).toBe('preparing');
      expect(progress.progress).toBeGreaterThanOrEqual(0);
      expect(progress.estimatedRemainingMs).toBeGreaterThan(0);
    });

    it('should reflect phase updates', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });
      reporter.start(60000);
      reporter.updatePhase('analyzing');

      const progress = reporter.getCurrentProgress();

      expect(progress.phase).toBe('analyzing');
    });

    it('should reflect progress updates', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });
      reporter.start(60000);
      reporter.updateProgress(75);

      const progress = reporter.getCurrentProgress();

      expect(progress.progress).toBe(75);
    });

    it('should return completion state after complete', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });
      reporter.start(60000);
      reporter.complete();

      const progress = reporter.getCurrentProgress();

      expect(progress.phase).toBe('completing');
      expect(progress.progress).toBe(100);
      expect(progress.estimatedRemainingMs).toBe(0);
    });
  });

  // ===========================================================================
  // コンソールログテスト
  // ===========================================================================

  describe('console logging', () => {
    it('should log to console when enableConsoleLog is true', async () => {
      const { logger } = await import('../../../src/utils/logger.js');
      const loggerSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

      reporter = new ProgressReporter({
        onProgress: progressCallback,
        enableConsoleLog: true,
      });

      reporter.start(60000);

      expect(loggerSpy).toHaveBeenCalled();

      loggerSpy.mockRestore();
    });

    it('should not log to console when enableConsoleLog is false', async () => {
      const { logger } = await import('../../../src/utils/logger.js');
      const loggerSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

      reporter = new ProgressReporter({
        onProgress: progressCallback,
        enableConsoleLog: false,
      });

      reporter.start(60000);

      expect(loggerSpy).not.toHaveBeenCalled();

      loggerSpy.mockRestore();
    });
  });

  // ===========================================================================
  // ProgressPhase 列挙型テスト
  // ===========================================================================

  describe('ProgressPhase enum', () => {
    it('should export ProgressPhase enum', () => {
      expect(ProgressPhase).toBeDefined();
    });

    it('should have all required phases', () => {
      expect(ProgressPhase.PREPARING).toBe('preparing');
      expect(ProgressPhase.OPTIMIZING).toBe('optimizing');
      expect(ProgressPhase.ANALYZING).toBe('analyzing');
      expect(ProgressPhase.COMPLETING).toBe('completing');
    });
  });

  // ===========================================================================
  // 境界値テスト
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle very large estimatedTotalMs', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });

      expect(() => reporter.start(Number.MAX_SAFE_INTEGER)).not.toThrow();
    });

    it('should handle rapid phase changes', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });
      reporter.start(60000);

      expect(() => {
        reporter.updatePhase('optimizing');
        reporter.updatePhase('analyzing');
        reporter.updatePhase('completing');
      }).not.toThrow();
    });

    it('should handle start called multiple times', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });

      reporter.start(60000);
      reporter.start(120000);

      // 最新の設定が適用される
      expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle callback that throws error', () => {
      const throwingCallback = vi.fn(() => {
        throw new Error('Callback error');
      });

      reporter = new ProgressReporter({ onProgress: throwingCallback });

      // コールバックエラーはキャッチされ、処理は継続
      expect(() => reporter.start(60000)).not.toThrow();
    });
  });

  // ===========================================================================
  // メッセージ国際化テスト
  // ===========================================================================

  describe('message localization', () => {
    it('should provide meaningful messages for each phase', () => {
      reporter = new ProgressReporter({ onProgress: progressCallback });

      reporter.start(60000);
      expect(receivedEvents[0].message.length).toBeGreaterThan(0);

      reporter.updatePhase('optimizing');
      expect(receivedEvents[receivedEvents.length - 1].message.length).toBeGreaterThan(0);

      reporter.updatePhase('analyzing');
      expect(receivedEvents[receivedEvents.length - 1].message.length).toBeGreaterThan(0);

      reporter.complete();
      expect(receivedEvents[receivedEvents.length - 1].message.length).toBeGreaterThan(0);
    });
  });
});
