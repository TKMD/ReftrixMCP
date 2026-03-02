// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ExecutionStatusTrackerV2 - 分析進捗状態リアルタイム追跡クラス
 *
 * Phase2-3: 分析の進捗状態をリアルタイムで追跡するExecutionStatusTrackerの拡張版
 *
 * 主な特徴:
 * - 各フェーズ（initializing, layout, motion, quality, finalizing）の状態を個別追跡
 * - 重み付き進捗計算（overallProgress）
 * - 完了予測時間計算（estimatedCompletion）
 * - コールバックによるリアルタイム通知（onStatusChange）
 * - PhasedExecutorとの統合
 *
 * @module tools/page/handlers/execution-status-tracker
 */

import { logger, isDevelopment } from '../../../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * 分析フェーズの種類（V2）
 */
export type AnalysisPhaseV2 = 'initializing' | 'layout' | 'motion' | 'quality' | 'narrative' | 'responsive' | 'finalizing';

/**
 * フェーズのステータス
 */
export type PhaseStatusType = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * 個別フェーズの状態
 */
export interface PhaseStatus {
  /** フェーズ名 */
  phase: AnalysisPhaseV2;
  /** 現在のステータス */
  status: PhaseStatusType;
  /** 開始時刻 */
  startedAt?: Date;
  /** 完了時刻 */
  completedAt?: Date;
  /** エラーメッセージ（失敗/スキップ時） */
  error?: string;
  /** 進捗（0-100） */
  progress?: number;
}

/**
 * 実行状態全体
 */
export interface ExecutionStatusV2 {
  /** WebページID */
  webPageId: string;
  /** 対象URL */
  url: string;
  /** 現在のフェーズ */
  currentPhase: AnalysisPhaseV2;
  /** 各フェーズの状態 */
  phases: Record<AnalysisPhaseV2, PhaseStatus>;
  /** 全体進捗（0-100） */
  overallProgress: number;
  /** 開始時刻 */
  startedAt: Date;
  /** 完了予測時刻 */
  estimatedCompletion?: Date;
  /** 最終更新時刻 */
  lastUpdatedAt: Date;
}

/**
 * ExecutionStatusTrackerV2のオプション
 */
export interface ExecutionStatusTrackerV2Options {
  /** WebページID */
  webPageId: string;
  /** 対象URL */
  url: string;
  /** 状態変更時のコールバック */
  onStatusChange?: (status: ExecutionStatusV2) => void;
}

// =====================================================
// 定数
// =====================================================

/**
 * 各フェーズの重み付け（%）
 * 合計が100になるように設定
 */
export const PHASE_WEIGHTS: Record<AnalysisPhaseV2, number> = {
  initializing: 5,   // 5%
  layout: 30,        // 30%
  motion: 20,        // 20%
  quality: 15,       // 15%
  narrative: 10,     // 10%
  responsive: 15,    // 15%
  finalizing: 5,     // 5%
};

/**
 * フェーズの順序
 */
const PHASE_ORDER: AnalysisPhaseV2[] = [
  'initializing',
  'layout',
  'motion',
  'quality',
  'narrative',
  'responsive',
  'finalizing',
];

// =====================================================
// ExecutionStatusTrackerV2 クラス
// =====================================================

/**
 * 分析進捗状態リアルタイム追跡クラス（V2）
 *
 * 分析の各フェーズの進捗状態を追跡し、
 * リアルタイムでステータスを通知する。
 */
export class ExecutionStatusTrackerV2 {
  private options: ExecutionStatusTrackerV2Options;
  private phases: Record<AnalysisPhaseV2, PhaseStatus>;
  private currentPhase: AnalysisPhaseV2;
  private startedAt: Date;
  private lastUpdatedAt: Date;
  private phaseCompletionTimes: Map<AnalysisPhaseV2, number> = new Map();

  constructor(options: ExecutionStatusTrackerV2Options) {
    this.options = options;
    this.currentPhase = 'initializing';
    this.startedAt = new Date();
    this.lastUpdatedAt = new Date();
    this.phases = this.createInitialPhases();
  }

  /**
   * 初期状態のフェーズを作成
   */
  private createInitialPhases(): Record<AnalysisPhaseV2, PhaseStatus> {
    return {
      initializing: { phase: 'initializing', status: 'pending' },
      layout: { phase: 'layout', status: 'pending' },
      motion: { phase: 'motion', status: 'pending' },
      quality: { phase: 'quality', status: 'pending' },
      narrative: { phase: 'narrative', status: 'pending' },
      responsive: { phase: 'responsive', status: 'pending' },
      finalizing: { phase: 'finalizing', status: 'pending' },
    };
  }

  /**
   * トラッカーを初期化
   */
  initialize(): void {
    this.startedAt = new Date();
    this.lastUpdatedAt = new Date();
    this.currentPhase = 'initializing';
    this.phases = this.createInitialPhases();

    if (isDevelopment()) {
      logger.debug('[ExecutionStatusTrackerV2] Initialized', {
        webPageId: this.options.webPageId,
        url: this.options.url,
        startedAt: this.startedAt.toISOString(),
      });
    }

    this.notifyStatusChange();
  }

  /**
   * フェーズを開始
   *
   * @param phase - 開始するフェーズ
   */
  startPhase(phase: AnalysisPhaseV2): void {
    const now = new Date();
    this.currentPhase = phase;
    this.phases[phase] = {
      ...this.phases[phase],
      status: 'running',
      startedAt: now,
      progress: 0,
    };
    this.lastUpdatedAt = now;

    if (isDevelopment()) {
      logger.debug('[ExecutionStatusTrackerV2] Phase started', {
        phase,
        startedAt: now.toISOString(),
      });
    }

    this.notifyStatusChange();
  }

  /**
   * フェーズの進捗を更新
   *
   * @param phase - 更新するフェーズ
   * @param progress - 進捗（0-100）
   */
  updatePhaseProgress(phase: AnalysisPhaseV2, progress: number): void {
    // 0-100の範囲に丸める
    const normalizedProgress = Math.max(0, Math.min(100, progress));

    this.phases[phase] = {
      ...this.phases[phase],
      progress: normalizedProgress,
    };
    this.lastUpdatedAt = new Date();

    if (isDevelopment()) {
      logger.debug('[ExecutionStatusTrackerV2] Phase progress updated', {
        phase,
        progress: normalizedProgress,
      });
    }

    this.notifyStatusChange();
  }

  /**
   * フェーズを完了
   *
   * @param phase - 完了するフェーズ
   */
  completePhase(phase: AnalysisPhaseV2): void {
    const now = new Date();
    const startedAt = this.phases[phase].startedAt;

    this.phases[phase] = {
      ...this.phases[phase],
      status: 'completed',
      completedAt: now,
      progress: 100,
    };
    this.lastUpdatedAt = now;

    // 完了時間を記録（予測計算用）
    if (startedAt) {
      const duration = now.getTime() - startedAt.getTime();
      this.phaseCompletionTimes.set(phase, duration);
    }

    if (isDevelopment()) {
      logger.debug('[ExecutionStatusTrackerV2] Phase completed', {
        phase,
        completedAt: now.toISOString(),
        durationMs: startedAt ? now.getTime() - startedAt.getTime() : undefined,
      });
    }

    this.notifyStatusChange();
  }

  /**
   * フェーズを失敗としてマーク
   *
   * @param phase - 失敗したフェーズ
   * @param error - エラーメッセージ
   */
  failPhase(phase: AnalysisPhaseV2, error: string): void {
    const now = new Date();

    this.phases[phase] = {
      ...this.phases[phase],
      status: 'failed',
      completedAt: now,
      error,
    };
    this.lastUpdatedAt = now;

    if (isDevelopment()) {
      logger.debug('[ExecutionStatusTrackerV2] Phase failed', {
        phase,
        error,
        failedAt: now.toISOString(),
      });
    }

    this.notifyStatusChange();
  }

  /**
   * フェーズをスキップ
   *
   * @param phase - スキップするフェーズ
   * @param reason - スキップ理由（オプション）
   */
  skipPhase(phase: AnalysisPhaseV2, reason?: string): void {
    const now = new Date();

    const updatedPhase: PhaseStatus = {
      ...this.phases[phase],
      status: 'skipped',
      completedAt: now,
    };
    // reasonが提供された場合のみerrorを設定
    if (reason !== undefined) {
      updatedPhase.error = reason;
    }
    this.phases[phase] = updatedPhase;
    this.lastUpdatedAt = now;

    if (isDevelopment()) {
      logger.debug('[ExecutionStatusTrackerV2] Phase skipped', {
        phase,
        reason,
        skippedAt: now.toISOString(),
      });
    }

    this.notifyStatusChange();
  }

  /**
   * 現在のステータスを取得
   *
   * @returns 現在の実行状態
   */
  getStatus(): ExecutionStatusV2 {
    const result: ExecutionStatusV2 = {
      webPageId: this.options.webPageId,
      url: this.options.url,
      currentPhase: this.currentPhase,
      phases: { ...this.phases },
      overallProgress: this.calculateOverallProgress(),
      startedAt: this.startedAt,
      lastUpdatedAt: this.lastUpdatedAt,
    };

    // estimatedCompletionは計算可能な場合のみ追加
    const estimated = this.estimateCompletion();
    if (estimated !== undefined) {
      result.estimatedCompletion = estimated;
    }

    return result;
  }

  /**
   * 全体進捗を計算（重み付き）
   *
   * @returns 全体進捗（0-100）
   */
  private calculateOverallProgress(): number {
    let totalProgress = 0;

    for (const phase of PHASE_ORDER) {
      const phaseStatus = this.phases[phase];
      const weight = PHASE_WEIGHTS[phase];

      if (phaseStatus.status === 'completed' || phaseStatus.status === 'skipped') {
        // 完了またはスキップ済みフェーズは100%として扱う
        totalProgress += weight;
      } else if (phaseStatus.status === 'running' && phaseStatus.progress !== undefined) {
        // 進行中のフェーズは進捗率に応じた重みを加算
        totalProgress += (weight * phaseStatus.progress) / 100;
      } else if (phaseStatus.status === 'failed') {
        // 失敗したフェーズは0%として扱う
        // 何も加算しない
      }
      // pendingは0%
    }

    return Math.round(totalProgress);
  }

  /**
   * 完了予測時間を計算
   *
   * 過去のフェーズ完了時間から残りフェーズの所要時間を推測し、
   * 全体の完了予測時刻を返す。
   *
   * @returns 完了予測時刻（推測不可の場合はundefined）
   */
  private estimateCompletion(): Date | undefined {
    // 十分なフェーズ履歴がない場合は予測不可
    if (this.phaseCompletionTimes.size < 2) {
      return undefined;
    }

    // 完了済みフェーズの平均時間を計算
    let totalDuration = 0;
    let completedWeight = 0;

    for (const [phase, duration] of this.phaseCompletionTimes) {
      const weight = PHASE_WEIGHTS[phase];
      totalDuration += duration;
      completedWeight += weight;
    }

    if (completedWeight === 0) {
      return undefined;
    }

    // 重み1%あたりの平均所要時間
    const avgTimePerWeight = totalDuration / completedWeight;

    // 残りフェーズの重みを計算
    let remainingWeight = 0;
    for (const phase of PHASE_ORDER) {
      const phaseStatus = this.phases[phase];
      if (phaseStatus.status === 'pending' || phaseStatus.status === 'running') {
        const weight = PHASE_WEIGHTS[phase];
        if (phaseStatus.status === 'running' && phaseStatus.progress !== undefined) {
          // 進行中のフェーズは残り進捗分の重みを加算
          remainingWeight += weight * (1 - phaseStatus.progress / 100);
        } else {
          remainingWeight += weight;
        }
      }
    }

    // 残り時間を推測
    const estimatedRemainingMs = avgTimePerWeight * remainingWeight;

    // 現在時刻から完了予測時刻を計算
    const now = new Date();
    return new Date(now.getTime() + estimatedRemainingMs);
  }

  /**
   * 状態変更をコールバックに通知
   *
   * コールバックでのエラーは無視して処理を継続する。
   */
  private notifyStatusChange(): void {
    if (!this.options.onStatusChange) {
      return;
    }

    try {
      // 同期的に呼び出す（非同期処理をブロックしない）
      this.options.onStatusChange(this.getStatus());
    } catch (error) {
      // コールバックのエラーは無視して処理を継続
      if (isDevelopment()) {
        logger.warn('[ExecutionStatusTrackerV2] onStatusChange callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
