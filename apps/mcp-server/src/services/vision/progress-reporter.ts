// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ProgressReporter - Vision分析進捗報告サービス
 *
 * Vision CPU完走保証 Phase 4: CPU推論時の長時間処理における進捗報告
 *
 * 機能:
 * - 推定時間報告（GPU 60s, CPU 180s-1200s）
 * - 段階的進捗通知（0%, 25%, 50%, 75%, 100%）
 * - 処理フェーズ報告（preparing, optimizing, analyzing, completing）
 *
 * @see apps/mcp-server/tests/services/vision/progress-reporter.test.ts
 */

import { logger } from '../../utils/logger';

// =============================================================================
// 型定義
// =============================================================================

/**
 * 処理フェーズ
 */
export enum ProgressPhase {
  PREPARING = 'preparing',
  OPTIMIZING = 'optimizing',
  ANALYZING = 'analyzing',
  COMPLETING = 'completing',
}

/**
 * 進捗イベント
 */
export interface ProgressEvent {
  /** 現在の処理フェーズ */
  phase: 'preparing' | 'optimizing' | 'analyzing' | 'completing';
  /** 進捗率（0-100） */
  progress: number;
  /** 推定残り時間（ミリ秒） */
  estimatedRemainingMs: number;
  /** 進捗メッセージ */
  message: string;
}

/**
 * 進捗コールバック関数型
 */
export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * ProgressReporter設定
 */
export interface ProgressReporterConfig {
  /** 進捗コールバック */
  onProgress?: ProgressCallback;
  /** 自動進捗報告間隔（ミリ秒、デフォルト: 5000） */
  reportInterval?: number;
  /** コンソールログを有効にするか（開発用、デフォルト: false） */
  enableConsoleLog?: boolean;
}

// =============================================================================
// 定数
// =============================================================================

/**
 * フェーズごとの進捗範囲
 */
const PHASE_PROGRESS_RANGES: Record<ProgressEvent['phase'], { min: number; max: number }> = {
  preparing: { min: 0, max: 10 },
  optimizing: { min: 10, max: 30 },
  analyzing: { min: 30, max: 90 },
  completing: { min: 90, max: 100 },
};

/**
 * フェーズごとのデフォルト進捗値
 */
const PHASE_DEFAULT_PROGRESS: Record<ProgressEvent['phase'], number> = {
  preparing: 5,
  optimizing: 20,
  analyzing: 50,
  completing: 95,
};

/**
 * フェーズごとのメッセージ
 */
const PHASE_MESSAGES: Record<ProgressEvent['phase'], string> = {
  preparing: '準備中: 画像を読み込んでいます...',
  optimizing: '最適化中: 画像を最適化しています...',
  analyzing: '分析中: Vision AI 推論を実行しています...',
  completing: '完了: 結果を処理しています...',
};

/**
 * デフォルト設定
 */
const DEFAULT_REPORT_INTERVAL = 5000; // 5秒

// =============================================================================
// ProgressReporter クラス
// =============================================================================

/**
 * Vision分析進捗報告クラス
 *
 * CPU推論時の長時間処理（最大20分）において、ユーザーに進捗を報告する。
 *
 * @example
 * ```typescript
 * const reporter = new ProgressReporter({
 *   onProgress: (event) => {
 *     console.log(`[${event.phase}] ${event.progress}% - ${event.message}`);
 *   },
 *   reportInterval: 5000, // 5秒ごと
 * });
 *
 * reporter.start(180000); // 推定3分
 * reporter.updatePhase('optimizing');
 * reporter.updatePhase('analyzing');
 * reporter.complete();
 * ```
 */
export class ProgressReporter {
  private readonly onProgress: ProgressCallback | undefined;
  private readonly reportInterval: number;
  private readonly enableConsoleLog: boolean;

  private startTime: number = 0;
  private estimatedTotalMs: number = 0;
  private currentPhase: ProgressEvent['phase'] = 'preparing';
  private currentProgress: number = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isStarted: boolean = false;
  private isCompleted: boolean = false;

  /**
   * ProgressReporterのコンストラクタ
   *
   * @param config - 設定オプション
   */
  constructor(config?: ProgressReporterConfig) {
    this.onProgress = config?.onProgress;
    this.reportInterval = config?.reportInterval ?? DEFAULT_REPORT_INTERVAL;
    this.enableConsoleLog = config?.enableConsoleLog ?? false;
  }

  // ===========================================================================
  // パブリックメソッド
  // ===========================================================================

  /**
   * 進捗報告を開始
   *
   * @param estimatedTotalMs - 推定合計時間（ミリ秒）
   */
  start(estimatedTotalMs: number): void {
    // 既存のインターバルをクリア
    this.clearInterval();

    // 状態を初期化
    this.startTime = Date.now();
    this.estimatedTotalMs = Math.max(0, estimatedTotalMs);
    this.currentPhase = 'preparing';
    // estimatedTotalMs が 0 の場合は進捗 0 から開始（推定時間不明）
    this.currentProgress = this.estimatedTotalMs > 0 ? PHASE_DEFAULT_PROGRESS.preparing : 0;
    this.isStarted = true;
    this.isCompleted = false;

    // 開始イベントを発火
    this.emitProgress();

    // 自動進捗報告のインターバルを設定
    this.startInterval();
  }

  /**
   * 処理フェーズを更新
   *
   * @param phase - 新しいフェーズ
   */
  updatePhase(phase: ProgressEvent['phase']): void {
    this.currentPhase = phase;
    this.currentProgress = PHASE_DEFAULT_PROGRESS[phase];

    this.emitProgress();
  }

  /**
   * 進捗を手動更新
   *
   * @param progress - 進捗率（0-100）
   */
  updateProgress(progress: number): void {
    // 進捗を0-100にクランプ
    this.currentProgress = Math.max(0, Math.min(100, progress));

    this.emitProgress();
  }

  /**
   * 処理完了
   */
  complete(): void {
    if (this.isCompleted) {
      return;
    }

    this.isCompleted = true;
    this.currentPhase = 'completing';
    this.currentProgress = 100;

    // インターバルをクリア
    this.clearInterval();

    // 完了イベントを発火
    const event: ProgressEvent = {
      phase: 'completing',
      progress: 100,
      estimatedRemainingMs: 0,
      message: '完了しました',
    };

    this.emitProgressEvent(event);
  }

  /**
   * 処理を中断
   */
  abort(): void {
    this.clearInterval();
    this.isCompleted = true;
  }

  /**
   * 現在の進捗状態を取得
   *
   * @returns 現在の進捗イベント
   */
  getCurrentProgress(): ProgressEvent {
    return {
      phase: this.currentPhase,
      progress: this.currentProgress,
      estimatedRemainingMs: this.calculateRemainingMs(),
      message: this.generateMessage(),
    };
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * 自動進捗報告インターバルを開始
   */
  private startInterval(): void {
    this.intervalId = setInterval(() => {
      if (!this.isCompleted) {
        // 時間経過に基づいて進捗を更新
        this.updateProgressBasedOnTime();
        this.emitProgress();
      }
    }, this.reportInterval);
  }

  /**
   * インターバルをクリア
   */
  private clearInterval(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * 時間経過に基づいて進捗を更新
   */
  private updateProgressBasedOnTime(): void {
    if (this.estimatedTotalMs <= 0) {
      return;
    }

    const elapsedMs = Date.now() - this.startTime;
    const timeBasedProgress = Math.min(99, (elapsedMs / this.estimatedTotalMs) * 100);

    // 現在のフェーズの範囲内で進捗を更新
    const range = PHASE_PROGRESS_RANGES[this.currentPhase];
    const phaseProgress = Math.min(range.max, Math.max(range.min, timeBasedProgress));

    // 進捗が減少しないようにする
    if (phaseProgress > this.currentProgress) {
      this.currentProgress = phaseProgress;
    }
  }

  /**
   * 進捗イベントを発火
   */
  private emitProgress(): void {
    const event = this.getCurrentProgress();
    this.emitProgressEvent(event);
  }

  /**
   * 進捗イベントを発火（内部）
   */
  private emitProgressEvent(event: ProgressEvent): void {
    // コンソールログ
    if (this.enableConsoleLog) {
      logger.info(`[ProgressReporter] [${event.phase}] ${event.progress}% - ${event.message}`);
    }

    // コールバック呼び出し
    if (this.onProgress) {
      try {
        this.onProgress(event);
      } catch (error) {
        // コールバックエラーは無視して処理を継続
        if (this.enableConsoleLog) {
          console.error('[ProgressReporter] Callback error:', error);
        }
      }
    }
  }

  /**
   * 推定残り時間を計算
   *
   * @returns 推定残り時間（ミリ秒）
   */
  private calculateRemainingMs(): number {
    if (!this.isStarted || this.estimatedTotalMs <= 0) {
      return 0;
    }

    if (this.isCompleted) {
      return 0;
    }

    const elapsedMs = Date.now() - this.startTime;
    const remaining = this.estimatedTotalMs - elapsedMs;

    return Math.max(0, remaining);
  }

  /**
   * 進捗メッセージを生成
   *
   * @returns 進捗メッセージ
   */
  private generateMessage(): string {
    if (this.isCompleted) {
      return '完了しました';
    }

    const baseMessage = PHASE_MESSAGES[this.currentPhase];
    const remainingMs = this.calculateRemainingMs();

    if (remainingMs > 0) {
      const remainingSec = Math.ceil(remainingMs / 1000);
      const remainingMin = Math.floor(remainingSec / 60);
      const sec = remainingSec % 60;

      if (remainingMin > 0) {
        return `${baseMessage} (残り約${remainingMin}分${sec}秒)`;
      } else {
        return `${baseMessage} (残り約${sec}秒)`;
      }
    }

    return baseMessage;
  }
}
