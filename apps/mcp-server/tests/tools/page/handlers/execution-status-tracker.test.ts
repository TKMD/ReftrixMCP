// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ExecutionStatusTracker - 分析進捗状態リアルタイム追跡のテスト
 * TDD Red Phase: 失敗するテストを先に書く
 *
 * Phase2-3: 分析の進捗状態をリアルタイムで追跡するExecutionStatusTrackerの拡張
 *
 * @module tests/tools/page/handlers/execution-status-tracker.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  ExecutionStatusTrackerV2,
  type AnalysisPhaseV2,
  type PhaseStatus,
  type ExecutionStatusV2,
  type ExecutionStatusTrackerV2Options,
  PHASE_WEIGHTS,
} from '../../../../src/tools/page/handlers/execution-status-tracker';

// =====================================================
// テストヘルパー
// =====================================================

/**
 * デフォルトのトラッカーオプションを作成
 */
function createDefaultOptions(): ExecutionStatusTrackerV2Options {
  return {
    webPageId: uuidv7(),
    url: 'https://example.com/test-page',
  };
}

/**
 * 時間を進める（モック用）
 */
function advanceTime(ms: number): void {
  vi.advanceTimersByTime(ms);
}

// =====================================================
// テストスイート
// =====================================================

describe('ExecutionStatusTrackerV2', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-17T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------
  // initialize() テスト
  // ---------------------------------------------------
  describe('initialize()', () => {
    it('初期化時に全フェーズがpending状態になる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      const status = tracker.getStatus();

      expect(status.phases.initializing.status).toBe('pending');
      expect(status.phases.layout.status).toBe('pending');
      expect(status.phases.motion.status).toBe('pending');
      expect(status.phases.quality.status).toBe('pending');
      expect(status.phases.narrative.status).toBe('pending');
      expect(status.phases.finalizing.status).toBe('pending');
    });

    it('初期化時にstartedAtが設定される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      const status = tracker.getStatus();

      expect(status.startedAt).toEqual(new Date('2026-01-17T10:00:00.000Z'));
    });

    it('初期化時にcurrentPhaseがinitializingになる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      const status = tracker.getStatus();

      expect(status.currentPhase).toBe('initializing');
    });

    it('初期化時にoverallProgressが0になる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      const status = tracker.getStatus();

      expect(status.overallProgress).toBe(0);
    });

    it('初期化時にwebPageIdとurlが正しく設定される', () => {
      const options = createDefaultOptions();
      const tracker = new ExecutionStatusTrackerV2(options);
      tracker.initialize();

      const status = tracker.getStatus();

      expect(status.webPageId).toBe(options.webPageId);
      expect(status.url).toBe(options.url);
    });

    it('初期化時にlastUpdatedAtが設定される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      const status = tracker.getStatus();

      expect(status.lastUpdatedAt).toEqual(new Date('2026-01-17T10:00:00.000Z'));
    });
  });

  // ---------------------------------------------------
  // startPhase() テスト
  // ---------------------------------------------------
  describe('startPhase()', () => {
    it('フェーズ開始時にcurrentPhaseが更新される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.startPhase('layout');

      const status = tracker.getStatus();
      expect(status.currentPhase).toBe('layout');
    });

    it('フェーズ開始時にstatusがrunningになる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.startPhase('layout');

      const status = tracker.getStatus();
      expect(status.phases.layout.status).toBe('running');
    });

    it('フェーズ開始時にstartedAtが設定される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      advanceTime(1000); // 1秒後
      tracker.startPhase('layout');

      const status = tracker.getStatus();
      expect(status.phases.layout.startedAt).toEqual(new Date('2026-01-17T10:00:01.000Z'));
    });

    it('フェーズ開始時にprogressが0になる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.startPhase('layout');

      const status = tracker.getStatus();
      expect(status.phases.layout.progress).toBe(0);
    });

    it('フェーズ開始時にlastUpdatedAtが更新される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      advanceTime(1000);
      tracker.startPhase('layout');

      const status = tracker.getStatus();
      expect(status.lastUpdatedAt).toEqual(new Date('2026-01-17T10:00:01.000Z'));
    });

    it('フェーズ開始時にonStatusChangeが呼び出される', () => {
      const onStatusChange = vi.fn();
      const tracker = new ExecutionStatusTrackerV2({
        ...createDefaultOptions(),
        onStatusChange,
      });
      tracker.initialize();

      tracker.startPhase('layout');

      expect(onStatusChange).toHaveBeenCalled();
      const calledStatus = onStatusChange.mock.calls[onStatusChange.mock.calls.length - 1][0];
      expect(calledStatus.currentPhase).toBe('layout');
    });
  });

  // ---------------------------------------------------
  // updatePhaseProgress() テスト
  // ---------------------------------------------------
  describe('updatePhaseProgress()', () => {
    it('進捗更新時にprogressが更新される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('layout');

      tracker.updatePhaseProgress('layout', 50);

      const status = tracker.getStatus();
      expect(status.phases.layout.progress).toBe(50);
    });

    it('進捗更新時にlastUpdatedAtが更新される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('layout');

      advanceTime(500);
      tracker.updatePhaseProgress('layout', 50);

      const status = tracker.getStatus();
      expect(status.lastUpdatedAt).toEqual(new Date('2026-01-17T10:00:00.500Z'));
    });

    it('進捗更新時にonStatusChangeが呼び出される', () => {
      const onStatusChange = vi.fn();
      const tracker = new ExecutionStatusTrackerV2({
        ...createDefaultOptions(),
        onStatusChange,
      });
      tracker.initialize();
      tracker.startPhase('layout');
      onStatusChange.mockClear();

      tracker.updatePhaseProgress('layout', 75);

      expect(onStatusChange).toHaveBeenCalled();
    });

    it('0-100の範囲外の値は丸められる（0未満は0）', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('layout');

      tracker.updatePhaseProgress('layout', -10);

      const status = tracker.getStatus();
      expect(status.phases.layout.progress).toBe(0);
    });

    it('0-100の範囲外の値は丸められる（100超は100）', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('layout');

      tracker.updatePhaseProgress('layout', 150);

      const status = tracker.getStatus();
      expect(status.phases.layout.progress).toBe(100);
    });

    it('overallProgressが正しく計算される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('layout');

      // layout は重み 40%
      tracker.updatePhaseProgress('layout', 50);

      const status = tracker.getStatus();
      // initializing (5%) + layout (40% * 50% = 20%) = 25%... ではなく
      // 現在進行中のフェーズまでの進捗を計算
      // 期待値: layout 50% * 40 = 20 (layoutの進捗分)
      expect(status.overallProgress).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------
  // completePhase() テスト
  // ---------------------------------------------------
  describe('completePhase()', () => {
    it('フェーズ完了時にstatusがcompletedになる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('layout');

      tracker.completePhase('layout');

      const status = tracker.getStatus();
      expect(status.phases.layout.status).toBe('completed');
    });

    it('フェーズ完了時にcompletedAtが設定される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('layout');

      advanceTime(2000);
      tracker.completePhase('layout');

      const status = tracker.getStatus();
      expect(status.phases.layout.completedAt).toEqual(new Date('2026-01-17T10:00:02.000Z'));
    });

    it('フェーズ完了時にprogressが100になる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('layout');

      tracker.completePhase('layout');

      const status = tracker.getStatus();
      expect(status.phases.layout.progress).toBe(100);
    });

    it('フェーズ完了時にlastUpdatedAtが更新される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('layout');

      advanceTime(1500);
      tracker.completePhase('layout');

      const status = tracker.getStatus();
      expect(status.lastUpdatedAt).toEqual(new Date('2026-01-17T10:00:01.500Z'));
    });

    it('フェーズ完了時にonStatusChangeが呼び出される', () => {
      const onStatusChange = vi.fn();
      const tracker = new ExecutionStatusTrackerV2({
        ...createDefaultOptions(),
        onStatusChange,
      });
      tracker.initialize();
      tracker.startPhase('layout');
      onStatusChange.mockClear();

      tracker.completePhase('layout');

      expect(onStatusChange).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------
  // failPhase() テスト
  // ---------------------------------------------------
  describe('failPhase()', () => {
    it('フェーズ失敗時にstatusがfailedになる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('motion');

      tracker.failPhase('motion', 'Timeout occurred');

      const status = tracker.getStatus();
      expect(status.phases.motion.status).toBe('failed');
    });

    it('フェーズ失敗時にerrorが設定される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('motion');

      tracker.failPhase('motion', 'WebGL detection failed');

      const status = tracker.getStatus();
      expect(status.phases.motion.error).toBe('WebGL detection failed');
    });

    it('フェーズ失敗時にcompletedAtが設定される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('motion');

      advanceTime(3000);
      tracker.failPhase('motion', 'Error');

      const status = tracker.getStatus();
      expect(status.phases.motion.completedAt).toEqual(new Date('2026-01-17T10:00:03.000Z'));
    });

    it('フェーズ失敗時にlastUpdatedAtが更新される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('motion');

      advanceTime(2500);
      tracker.failPhase('motion', 'Error');

      const status = tracker.getStatus();
      expect(status.lastUpdatedAt).toEqual(new Date('2026-01-17T10:00:02.500Z'));
    });

    it('フェーズ失敗時にonStatusChangeが呼び出される', () => {
      const onStatusChange = vi.fn();
      const tracker = new ExecutionStatusTrackerV2({
        ...createDefaultOptions(),
        onStatusChange,
      });
      tracker.initialize();
      tracker.startPhase('motion');
      onStatusChange.mockClear();

      tracker.failPhase('motion', 'Error');

      expect(onStatusChange).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------
  // skipPhase() テスト
  // ---------------------------------------------------
  describe('skipPhase()', () => {
    it('フェーズスキップ時にstatusがskippedになる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.skipPhase('motion');

      const status = tracker.getStatus();
      expect(status.phases.motion.status).toBe('skipped');
    });

    it('スキップ理由が指定された場合はerrorに設定される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.skipPhase('motion', 'Feature disabled by user');

      const status = tracker.getStatus();
      expect(status.phases.motion.error).toBe('Feature disabled by user');
    });

    it('スキップ理由なしでもエラーにならない', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      expect(() => tracker.skipPhase('motion')).not.toThrow();

      const status = tracker.getStatus();
      expect(status.phases.motion.error).toBeUndefined();
    });

    it('フェーズスキップ時にlastUpdatedAtが更新される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      advanceTime(500);
      tracker.skipPhase('motion');

      const status = tracker.getStatus();
      expect(status.lastUpdatedAt).toEqual(new Date('2026-01-17T10:00:00.500Z'));
    });

    it('フェーズスキップ時にonStatusChangeが呼び出される', () => {
      const onStatusChange = vi.fn();
      const tracker = new ExecutionStatusTrackerV2({
        ...createDefaultOptions(),
        onStatusChange,
      });
      tracker.initialize();
      onStatusChange.mockClear();

      tracker.skipPhase('motion');

      expect(onStatusChange).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------
  // getStatus() テスト
  // ---------------------------------------------------
  describe('getStatus()', () => {
    it('正しいステータスが返される', () => {
      const options = createDefaultOptions();
      const tracker = new ExecutionStatusTrackerV2(options);
      tracker.initialize();

      const status = tracker.getStatus();

      expect(status).toMatchObject({
        webPageId: options.webPageId,
        url: options.url,
        currentPhase: 'initializing',
        overallProgress: 0,
      });
      expect(status.phases).toBeDefined();
      expect(status.startedAt).toBeDefined();
      expect(status.lastUpdatedAt).toBeDefined();
    });

    it('複数フェーズの進行状況が正しく反映される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      // initializingを完了
      tracker.startPhase('initializing');
      tracker.completePhase('initializing');

      // layoutを開始
      tracker.startPhase('layout');
      tracker.updatePhaseProgress('layout', 50);

      const status = tracker.getStatus();

      expect(status.phases.initializing.status).toBe('completed');
      expect(status.phases.layout.status).toBe('running');
      expect(status.phases.layout.progress).toBe(50);
      expect(status.currentPhase).toBe('layout');
    });
  });

  // ---------------------------------------------------
  // calculateOverallProgress() テスト（内部メソッドの動作確認）
  // ---------------------------------------------------
  describe('overallProgress計算（重み付き）', () => {
    it('PHASE_WEIGHTSが正しく定義されている', () => {
      expect(PHASE_WEIGHTS.initializing).toBe(5);
      expect(PHASE_WEIGHTS.layout).toBe(35);
      expect(PHASE_WEIGHTS.motion).toBe(25);
      expect(PHASE_WEIGHTS.quality).toBe(15);
      expect(PHASE_WEIGHTS.narrative).toBe(15);
      expect(PHASE_WEIGHTS.finalizing).toBe(5);

      // 合計が100%になること
      const total = Object.values(PHASE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
      expect(total).toBe(100);
    });

    it('initializingのみ完了時のoverallProgressが正しい', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('initializing');
      tracker.completePhase('initializing');

      const status = tracker.getStatus();
      expect(status.overallProgress).toBe(5); // initializing = 5%
    });

    it('initializing + layout完了時のoverallProgressが正しい', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.startPhase('initializing');
      tracker.completePhase('initializing');
      tracker.startPhase('layout');
      tracker.completePhase('layout');

      const status = tracker.getStatus();
      expect(status.overallProgress).toBe(40); // 5 + 35 = 40%
    });

    it('全フェーズ完了時のoverallProgressが100', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      // 全フェーズを完了
      const phases: AnalysisPhaseV2[] = ['initializing', 'layout', 'motion', 'quality', 'narrative', 'finalizing'];
      for (const phase of phases) {
        tracker.startPhase(phase);
        tracker.completePhase(phase);
      }

      const status = tracker.getStatus();
      expect(status.overallProgress).toBe(100);
    });

    it('スキップされたフェーズは完了として扱われる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.startPhase('initializing');
      tracker.completePhase('initializing');
      tracker.startPhase('layout');
      tracker.completePhase('layout');
      tracker.skipPhase('motion'); // motionをスキップ
      tracker.startPhase('quality');
      tracker.completePhase('quality');
      tracker.startPhase('narrative');
      tracker.completePhase('narrative');
      tracker.startPhase('finalizing');
      tracker.completePhase('finalizing');

      const status = tracker.getStatus();
      expect(status.overallProgress).toBe(100); // スキップも完了扱い
    });

    it('進行中のフェーズの進捗が反映される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.startPhase('initializing');
      tracker.completePhase('initializing'); // +5%
      tracker.startPhase('layout');
      tracker.updatePhaseProgress('layout', 50); // +35% * 50% = +17.5%

      const status = tracker.getStatus();
      expect(status.overallProgress).toBe(23); // 5 + 17.5 = 22.5 → Math.round = 23
    });
  });

  // ---------------------------------------------------
  // estimateCompletion() テスト（完了予測時間計算）
  // ---------------------------------------------------
  describe('estimatedCompletion計算', () => {
    it('十分なフェーズ履歴がない場合はundefined', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      const status = tracker.getStatus();
      expect(status.estimatedCompletion).toBeUndefined();
    });

    it('複数フェーズ完了後に完了予測時間が計算される', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      // initializing: 1秒
      tracker.startPhase('initializing');
      advanceTime(1000);
      tracker.completePhase('initializing');

      // layout: 10秒
      tracker.startPhase('layout');
      advanceTime(10000);
      tracker.completePhase('layout');

      const status = tracker.getStatus();
      // 2フェーズ完了後は予測可能
      expect(status.estimatedCompletion).toBeDefined();
    });

    it('完了予測時間は現在時刻より後', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.startPhase('initializing');
      advanceTime(1000);
      tracker.completePhase('initializing');

      tracker.startPhase('layout');
      advanceTime(10000);
      tracker.completePhase('layout');

      tracker.startPhase('motion');

      const status = tracker.getStatus();
      const now = new Date();

      if (status.estimatedCompletion) {
        expect(status.estimatedCompletion.getTime()).toBeGreaterThan(now.getTime());
      }
    });
  });

  // ---------------------------------------------------
  // onStatusChangeコールバックテスト
  // ---------------------------------------------------
  describe('onStatusChangeコールバック', () => {
    it('initialize時にonStatusChangeが呼び出される', () => {
      const onStatusChange = vi.fn();
      const tracker = new ExecutionStatusTrackerV2({
        ...createDefaultOptions(),
        onStatusChange,
      });

      tracker.initialize();

      expect(onStatusChange).toHaveBeenCalled();
    });

    it('複数回の状態変更で毎回呼び出される', () => {
      const onStatusChange = vi.fn();
      const tracker = new ExecutionStatusTrackerV2({
        ...createDefaultOptions(),
        onStatusChange,
      });

      tracker.initialize();          // 1回目
      tracker.startPhase('layout');  // 2回目
      tracker.updatePhaseProgress('layout', 50); // 3回目
      tracker.completePhase('layout'); // 4回目

      expect(onStatusChange).toHaveBeenCalledTimes(4);
    });

    it('コールバックが同期的に呼び出される（非同期処理をブロックしない）', () => {
      const onStatusChange = vi.fn().mockImplementation((_status) => {
        // 非同期処理をシミュレート（Promiseを返す）
        return new Promise((resolve) => setTimeout(resolve, 100));
      });

      const tracker = new ExecutionStatusTrackerV2({
        ...createDefaultOptions(),
        onStatusChange,
      });

      tracker.initialize();
      tracker.startPhase('layout');

      // コールバックが同期的に呼び出されることを確認
      // （非同期処理の完了を待たずに次の操作が実行される）
      expect(onStatusChange).toHaveBeenCalledTimes(2);
    });

    it('コールバックでエラーが発生してもトラッカーは動作を継続', () => {
      const onStatusChange = vi.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });

      const tracker = new ExecutionStatusTrackerV2({
        ...createDefaultOptions(),
        onStatusChange,
      });

      // エラーがスローされてもトラッカーは動作を継続
      expect(() => {
        tracker.initialize();
        tracker.startPhase('layout');
      }).not.toThrow();

      const status = tracker.getStatus();
      expect(status.currentPhase).toBe('layout');
    });
  });

  // ---------------------------------------------------
  // エッジケーステスト
  // ---------------------------------------------------
  describe('エッジケース', () => {
    it('初期化前にgetStatusを呼び出してもエラーにならない', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());

      // 初期化前
      expect(() => tracker.getStatus()).not.toThrow();
    });

    it('同じフェーズを複数回startしても問題ない', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.startPhase('layout');
      tracker.startPhase('layout'); // 再度開始

      const status = tracker.getStatus();
      expect(status.phases.layout.status).toBe('running');
    });

    it('完了済みフェーズを再度完了しても問題ない', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();
      tracker.startPhase('layout');
      tracker.completePhase('layout');

      // 再度完了
      tracker.completePhase('layout');

      const status = tracker.getStatus();
      expect(status.phases.layout.status).toBe('completed');
    });

    it('開始していないフェーズを完了してもstatusがcompletedになる', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      // 開始せずに完了
      tracker.completePhase('layout');

      const status = tracker.getStatus();
      expect(status.phases.layout.status).toBe('completed');
    });
  });

  // ---------------------------------------------------
  // 統合シナリオテスト
  // ---------------------------------------------------
  describe('統合シナリオ', () => {
    it('フル分析フロー：全フェーズ成功', () => {
      const onStatusChange = vi.fn();
      const tracker = new ExecutionStatusTrackerV2({
        ...createDefaultOptions(),
        onStatusChange,
      });

      tracker.initialize();

      // Initializing
      tracker.startPhase('initializing');
      advanceTime(500);
      tracker.completePhase('initializing');

      // Layout
      tracker.startPhase('layout');
      advanceTime(2000);
      tracker.updatePhaseProgress('layout', 50);
      advanceTime(2000);
      tracker.completePhase('layout');

      // Motion
      tracker.startPhase('motion');
      advanceTime(3000);
      tracker.completePhase('motion');

      // Quality
      tracker.startPhase('quality');
      advanceTime(1500);
      tracker.completePhase('quality');

      // Narrative
      tracker.startPhase('narrative');
      advanceTime(1000);
      tracker.completePhase('narrative');

      // Finalizing
      tracker.startPhase('finalizing');
      advanceTime(300);
      tracker.completePhase('finalizing');

      const status = tracker.getStatus();

      expect(status.currentPhase).toBe('finalizing');
      expect(status.overallProgress).toBe(100);
      expect(status.phases.initializing.status).toBe('completed');
      expect(status.phases.layout.status).toBe('completed');
      expect(status.phases.motion.status).toBe('completed');
      expect(status.phases.quality.status).toBe('completed');
      expect(status.phases.narrative.status).toBe('completed');
      expect(status.phases.finalizing.status).toBe('completed');
    });

    it('部分成功フロー：Motion失敗', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      // Initializing成功
      tracker.startPhase('initializing');
      tracker.completePhase('initializing');

      // Layout成功
      tracker.startPhase('layout');
      tracker.completePhase('layout');

      // Motion失敗
      tracker.startPhase('motion');
      advanceTime(5000);
      tracker.failPhase('motion', 'WebGL detection timeout');

      // Quality成功
      tracker.startPhase('quality');
      tracker.completePhase('quality');

      // Narrative成功
      tracker.startPhase('narrative');
      tracker.completePhase('narrative');

      // Finalizing成功
      tracker.startPhase('finalizing');
      tracker.completePhase('finalizing');

      const status = tracker.getStatus();

      expect(status.phases.initializing.status).toBe('completed');
      expect(status.phases.layout.status).toBe('completed');
      expect(status.phases.motion.status).toBe('failed');
      expect(status.phases.motion.error).toBe('WebGL detection timeout');
      expect(status.phases.quality.status).toBe('completed');
      expect(status.phases.narrative.status).toBe('completed');
      expect(status.phases.finalizing.status).toBe('completed');

      // 失敗したフェーズがあっても完了した分は計算される
      // initializing(5) + layout(35) + motion(0, failed) + quality(15) + narrative(15) + finalizing(5) = 75%
      expect(status.overallProgress).toBe(75);
    });

    it('スキップフロー：Motion無効化', () => {
      const tracker = new ExecutionStatusTrackerV2(createDefaultOptions());
      tracker.initialize();

      tracker.startPhase('initializing');
      tracker.completePhase('initializing');

      tracker.startPhase('layout');
      tracker.completePhase('layout');

      // Motionをスキップ
      tracker.skipPhase('motion', 'features.motion = false');

      tracker.startPhase('quality');
      tracker.completePhase('quality');

      tracker.startPhase('narrative');
      tracker.completePhase('narrative');

      tracker.startPhase('finalizing');
      tracker.completePhase('finalizing');

      const status = tracker.getStatus();

      expect(status.phases.motion.status).toBe('skipped');
      expect(status.phases.motion.error).toBe('features.motion = false');
      expect(status.overallProgress).toBe(100); // スキップは完了扱い
    });
  });
});
