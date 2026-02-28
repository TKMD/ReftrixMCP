// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase2-1: 段階的分析実行クラス
 *
 * 各フェーズ（Layout, Motion, Quality）を独立して実行し、
 * 部分成功を許容する段階的分析を実現する。
 *
 * 主な特徴:
 * - 各フェーズは独立して実行される（他のフェーズの失敗に影響されない）
 * - フェーズごとに成功/失敗/タイムアウトを個別管理
 * - 部分成功を許容（例: Layout成功、Motion失敗、Quality成功）
 * - 各フェーズ完了時にコールバックを呼び出し可能（DB保存用）
 * - ExecutionStatusTrackerと連携してステータスを追跡
 *
 * @module tools/page/handlers/phased-executor
 */

import { logger, isDevelopment } from '../../../utils/logger';
import {
  withTimeout,
  PhaseTimeoutError,
  type AnalysisPhase,
} from './timeout-utils';
import type { ExecutionStatusTracker } from './timeout-utils';
import type {
  LayoutServiceResult,
  MotionServiceResult,
  QualityServiceResult,
} from './types';
import type { PageAnalyzeInput } from '../schemas';

// =====================================================
// 型定義
// =====================================================

/**
 * フェーズの種類
 */
export type PhaseType = 'layout' | 'motion' | 'quality';

/**
 * 個別フェーズの実行結果
 */
export interface PhaseResult<T> {
  /** フェーズ名 */
  phase: PhaseType;
  /** 成功したかどうか */
  success: boolean;
  /** 結果データ（成功時のみ） */
  data?: T;
  /** エラーメッセージ（失敗時のみ） */
  error?: string;
  /** 実行時間（ms） */
  durationMs: number;
  /** タイムアウトしたかどうか */
  timedOut: boolean;
}

/**
 * 段階的実行の結果
 */
export interface PhasedExecutionResult {
  /** Layout フェーズ結果 */
  layout: PhaseResult<LayoutServiceResult>;
  /** Motion フェーズ結果 */
  motion: PhaseResult<MotionServiceResult>;
  /** Quality フェーズ結果 */
  quality: PhaseResult<QualityServiceResult>;
  /** 全フェーズが成功したか */
  overallSuccess: boolean;
  /** 1つ以上のフェーズが成功したか */
  partialSuccess: boolean;
  /** 完了したフェーズのリスト */
  completedPhases: PhaseType[];
  /** 失敗したフェーズのリスト（スキップは含まない） */
  failedPhases: PhaseType[];
}

/**
 * フェーズごとのタイムアウト設定
 */
export interface PhaseTimeouts {
  layout: number;
  motion: number;
  quality: number;
}

/**
 * PhasedExecutorのオプション
 */
export interface PhasedExecutorOptions {
  /** 解析対象のHTML */
  html: string;
  /** 解析対象のURL */
  url: string;
  /** 有効なフェーズ */
  features: {
    layout?: boolean;
    motion?: boolean;
    quality?: boolean;
  };
  /** 各フェーズのタイムアウト（ms） */
  phaseTimeouts: PhaseTimeouts;
  /** 実行状態トラッカー */
  tracker: ExecutionStatusTracker;
  /** Layout分析関数 */
  analyzeLayout: (
    html: string,
    options?: PageAnalyzeInput['layoutOptions']
  ) => Promise<LayoutServiceResult>;
  /** Motion検出関数 */
  detectMotion: (
    html: string,
    url: string,
    options?: PageAnalyzeInput['motionOptions']
  ) => Promise<MotionServiceResult>;
  /** Quality評価関数 */
  evaluateQuality: (
    html: string,
    options?: PageAnalyzeInput['qualityOptions']
  ) => Promise<QualityServiceResult>;
  /** Layoutオプション（オプション） */
  layoutOptions?: PageAnalyzeInput['layoutOptions'];
  /** Motionオプション（オプション） */
  motionOptions?: PageAnalyzeInput['motionOptions'];
  /** Qualityオプション（オプション） */
  qualityOptions?: PageAnalyzeInput['qualityOptions'];
  /** フェーズ完了時のコールバック（DB保存用） */
  onPhaseComplete?: (phase: PhaseType, result: PhaseResult<unknown>) => Promise<void>;
}

// =====================================================
// PhasedExecutor クラス
// =====================================================

/**
 * 段階的分析実行クラス
 *
 * 各フェーズ（Layout, Motion, Quality）を順次実行し、
 * 部分成功を許容する。
 */
export class PhasedExecutor {
  private options: PhasedExecutorOptions;

  constructor(options: PhasedExecutorOptions) {
    this.options = options;
  }

  /**
   * 段階的分析を実行
   *
   * @returns 全フェーズの実行結果
   */
  async execute(): Promise<PhasedExecutionResult> {
    const results: PhasedExecutionResult = {
      layout: this.createSkippedResult('layout'),
      motion: this.createSkippedResult('motion'),
      quality: this.createSkippedResult('quality'),
      overallSuccess: false,
      partialSuccess: false,
      completedPhases: [],
      failedPhases: [],
    };

    // Phase 1: Layout（最重要、最初に実行）
    if (this.options.features.layout !== false) {
      results.layout = await this.executePhase(
        'layout',
        () => this.options.analyzeLayout(
          this.options.html,
          this.options.layoutOptions
        ),
        this.options.phaseTimeouts.layout
      );

      if (results.layout.success) {
        await this.callOnPhaseComplete('layout', results.layout);
      }
    }

    // Phase 2: Motion
    if (this.options.features.motion !== false) {
      results.motion = await this.executePhase(
        'motion',
        () => this.options.detectMotion(
          this.options.html,
          this.options.url,
          this.options.motionOptions
        ),
        this.options.phaseTimeouts.motion
      );

      if (results.motion.success) {
        await this.callOnPhaseComplete('motion', results.motion);
      }
    }

    // Phase 3: Quality
    if (this.options.features.quality !== false) {
      results.quality = await this.executePhase(
        'quality',
        () => this.options.evaluateQuality(
          this.options.html,
          this.options.qualityOptions
        ),
        this.options.phaseTimeouts.quality
      );

      if (results.quality.success) {
        await this.callOnPhaseComplete('quality', results.quality);
      }
    }

    // 結果集計
    this.aggregateResults(results);

    return results;
  }

  /**
   * スキップされたフェーズ用の結果を作成
   */
  private createSkippedResult<T>(phase: PhaseType): PhaseResult<T> {
    return {
      phase,
      success: false,
      error: 'Phase skipped',
      durationMs: 0,
      timedOut: false,
    };
  }

  /**
   * 個別フェーズを実行
   *
   * @param phase - フェーズ名
   * @param executor - 実行する関数
   * @param timeoutMs - タイムアウト時間（ms）
   * @returns フェーズ結果
   */
  private async executePhase<T>(
    phase: PhaseType,
    executor: () => Promise<T>,
    timeoutMs: number
  ): Promise<PhaseResult<T>> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.debug(`[PhasedExecutor] Starting ${phase} phase`, {
        timeoutMs,
      });
    }

    try {
      const data = await withTimeout(
        executor(),
        timeoutMs,
        `${phase}-analysis`
      );

      const durationMs = Date.now() - startTime;

      // Trackerに成功を記録
      this.options.tracker.markCompleted(phase as AnalysisPhase);

      if (isDevelopment()) {
        logger.debug(`[PhasedExecutor] ${phase} phase completed`, {
          durationMs,
          timeoutMs,
        });
      }

      return {
        phase,
        success: true,
        data,
        durationMs,
        timedOut: false,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const isTimeout = error instanceof PhaseTimeoutError;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Trackerに失敗を記録
      this.options.tracker.markFailed(phase as AnalysisPhase, isTimeout);

      if (isDevelopment()) {
        logger.warn(`[PhasedExecutor] ${phase} phase failed`, {
          error: errorMessage,
          isTimeout,
          durationMs,
          timeoutMs,
        });
      }

      return {
        phase,
        success: false,
        error: errorMessage,
        durationMs,
        timedOut: isTimeout,
      };
    }
  }

  /**
   * onPhaseCompleteコールバックを呼び出す
   * エラーが発生しても処理は継続する
   */
  private async callOnPhaseComplete(
    phase: PhaseType,
    result: PhaseResult<unknown>
  ): Promise<void> {
    if (!this.options.onPhaseComplete) {
      return;
    }

    try {
      await this.options.onPhaseComplete(phase, result);

      if (isDevelopment()) {
        logger.debug(`[PhasedExecutor] onPhaseComplete callback executed`, {
          phase,
        });
      }
    } catch (error) {
      // コールバックのエラーは無視して継続
      if (isDevelopment()) {
        logger.warn(`[PhasedExecutor] onPhaseComplete callback failed`, {
          phase,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * 結果を集計
   */
  private aggregateResults(results: PhasedExecutionResult): void {
    const phases: PhaseType[] = ['layout', 'motion', 'quality'];

    // 完了したフェーズを抽出
    results.completedPhases = phases.filter(phase => {
      const result = results[phase];
      return result.success;
    });

    // 失敗したフェーズを抽出（スキップは含まない）
    results.failedPhases = phases.filter(phase => {
      const result = results[phase];
      // 有効化されていて、失敗した（スキップ以外）
      const isEnabled = this.options.features[phase] !== false;
      return isEnabled && !result.success && result.error !== 'Phase skipped';
    });

    // 全フェーズ成功かどうか
    results.overallSuccess = results.failedPhases.length === 0 && results.completedPhases.length > 0;

    // 部分成功かどうか（少なくとも1つのフェーズが成功）
    results.partialSuccess = results.completedPhases.length > 0;

    if (isDevelopment()) {
      logger.debug(`[PhasedExecutor] Aggregation completed`, {
        overallSuccess: results.overallSuccess,
        partialSuccess: results.partialSuccess,
        completedPhases: results.completedPhases,
        failedPhases: results.failedPhases,
      });
    }
  }
}
