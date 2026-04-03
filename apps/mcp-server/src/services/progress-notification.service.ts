// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ProgressNotificationService - MCP Streaming Progress Notifications
 *
 * v0.3.0 Tier 2: page.analyze等の長時間処理のリアルタイム進捗通知。
 * MCP progressToken + BullMQ progress eventsの統合。
 *
 * MCP Protocol Specification:
 * - method: 'notifications/progress'
 * - params: { progressToken, progress, total?, message? }
 *
 * 機能:
 * - フェーズ進捗の標準化（0-100%、フェーズ名、サブステップ）
 * - 通知頻度制御（最小間隔500ms、フラッド防止）
 * - BullMQ progressイベントからMCP通知への変換
 * - Graceful Degradation: progressToken未提供時は無操作
 *
 * @see https://spec.modelcontextprotocol.io/specification/basic/utilities/progress/
 * @module services/progress-notification.service
 */

import { logger } from "../utils/logger";

// =============================================================================
// 型定義 / Type Definitions
// =============================================================================

/**
 * パイプラインフェーズ情報 / Pipeline phase information
 */
export interface PipelinePhaseInfo {
  /** フェーズの表示ラベル / Display label for the phase */
  label: string;
  /** 全体進捗における開始パーセント / Start percent in overall progress */
  startPercent: number;
  /** 全体進捗における終了パーセント / End percent in overall progress */
  endPercent: number;
}

/**
 * 進捗通知イベント / Progress notification event
 */
export interface ProgressNotificationEvent {
  /** MCP notifications/progress method */
  method: "notifications/progress";
  /** 通知パラメータ / Notification parameters */
  params: {
    /** クライアントから提供された進捗トークン / Client-provided progress token */
    progressToken: string | number;
    /** 現在の進捗値（0-100） / Current progress value (0-100) */
    progress: number;
    /** 合計値（常に100） / Total value (always 100) */
    total: number;
    /** 進捗メッセージ / Progress message */
    message?: string;
  };
}

/**
 * SendNotification関数型 / SendNotification function type
 */
type SendNotificationFn = (notification: ProgressNotificationEvent) => Promise<void>;

/**
 * ProgressNotificationServiceオプション / Service options
 */
export interface ProgressNotificationOptions {
  /** MCP クライアントから提供された progressToken / Client-provided progress token */
  progressToken: string | number | undefined;
  /** MCP SDK の sendNotification 関数 / MCP SDK sendNotification function */
  sendNotification: SendNotificationFn | undefined;
  /** 最小通知間隔（ミリ秒、デフォルト: 500） / Minimum notification interval (ms, default: 500) */
  minIntervalMs?: number;
}

/**
 * BullMQ progressデータ型（詳細） / BullMQ detailed progress data
 */
interface BullMQDetailedProgress {
  overallProgress: number;
  currentPhase?: string;
  phases?: Record<string, unknown>;
}

// =============================================================================
// パイプラインフェーズ定数 / Pipeline Phase Constants
// =============================================================================

/**
 * page.analyze 5フェーズパイプラインの進捗マッピング
 *
 * PHASE_PROGRESS (phases/types.ts) と一致:
 *   Phase 0  (Ingest)     0-15
 *   Phase 1  (Layout)    15-45
 *   Phase 2.5 (ScrollVision) 45-63
 *   Phase 2  (Motion)    45-60 (within ScrollVision range, overlaps)
 *   Phase 3  (Quality)   63-73
 *   Phase 4  (Narrative) 73-83
 *   Phase 4.5 (Responsive) 83-90
 *   Phase 5  (Embedding) 90-100
 *
 * Pipeline phase definitions for MCP streaming progress.
 * Maps to PHASE_PROGRESS in phases/types.ts.
 */
export const PIPELINE_PHASES: Record<string, PipelinePhaseInfo> = {
  ingest: { label: "Ingest", startPercent: 0, endPercent: 15 },
  layout: { label: "Layout", startPercent: 15, endPercent: 45 },
  scrollVision: { label: "ScrollVision", startPercent: 45, endPercent: 63 },
  motion: { label: "Motion", startPercent: 45, endPercent: 60 },
  quality: { label: "Quality", startPercent: 63, endPercent: 73 },
  narrative: { label: "Narrative", startPercent: 73, endPercent: 83 },
  responsive: { label: "Responsive", startPercent: 83, endPercent: 90 },
  embedding: { label: "Embedding", startPercent: 90, endPercent: 100 },
} as const;

/** フェーズキーの型 / Phase key type */
export type PipelinePhaseKey = keyof typeof PIPELINE_PHASES;

// =============================================================================
// ProgressNotificationService クラス / Class
// =============================================================================

/**
 * MCP Streaming Progress通知サービス
 *
 * page.analyze等の長時間処理においてMCPクライアントにリアルタイムで進捗を通知する。
 * progressTokenが未提供の場合は全操作が無操作（Graceful Degradation）。
 *
 * Provides real-time progress notifications to MCP clients during long-running
 * operations like page.analyze. All operations are no-ops when progressToken
 * is not provided (Graceful Degradation).
 *
 * @example
 * ```typescript
 * const progressService = new ProgressNotificationService({
 *   progressToken: request._meta?.progressToken,
 *   sendNotification: extra.sendNotification,
 * });
 *
 * await progressService.notifyPhaseStart("ingest");
 * await progressService.notifySubProgress("ingest", 50, "Fetching HTML...");
 * await progressService.notifyPhaseComplete("ingest");
 * ```
 */
export class ProgressNotificationService {
  private readonly progressToken: string | number | undefined;
  private readonly sendNotification: SendNotificationFn | undefined;
  private readonly minIntervalMs: number;
  private lastNotificationTime: number = 0;

  constructor(options: ProgressNotificationOptions) {
    this.progressToken = options.progressToken;
    this.sendNotification = options.sendNotification;
    this.minIntervalMs = options.minIntervalMs ?? 500;
  }

  /**
   * サービスが有効かどうか / Whether the service is enabled
   *
   * progressTokenとsendNotificationの両方が設定されている場合のみtrue。
   *
   * @returns true if both progressToken and sendNotification are available
   */
  isEnabled(): boolean {
    return this.progressToken !== undefined && this.sendNotification !== undefined;
  }

  /**
   * フェーズ開始通知（マイルストーン — スロットリング無視）
   *
   * Notify phase start (milestone — bypasses throttling).
   *
   * @param phase - パイプラインフェーズキー / Pipeline phase key
   */
  async notifyPhaseStart(phase: string): Promise<void> {
    const phaseInfo = PIPELINE_PHASES[phase];
    if (!phaseInfo) return;

    await this.sendMilestoneNotification(
      phaseInfo.startPercent,
      `[${phaseInfo.label}] Phase started`
    );
  }

  /**
   * フェーズ完了通知（マイルストーン — スロットリング無視）
   *
   * Notify phase complete (milestone — bypasses throttling).
   *
   * @param phase - パイプラインフェーズキー / Pipeline phase key
   */
  async notifyPhaseComplete(phase: string): Promise<void> {
    const phaseInfo = PIPELINE_PHASES[phase];
    if (!phaseInfo) return;

    await this.sendMilestoneNotification(
      phaseInfo.endPercent,
      `[${phaseInfo.label}] Phase complete`
    );
  }

  /**
   * フェーズ失敗通知（マイルストーン — スロットリング無視）
   *
   * Notify phase failed (milestone — bypasses throttling).
   *
   * @param phase - パイプラインフェーズキー / Pipeline phase key
   * @param _reason - 失敗理由（メッセージに含まれないが将来の拡張用） / Failure reason
   */
  async notifyPhaseFailed(phase: string, _reason?: string): Promise<void> {
    const phaseInfo = PIPELINE_PHASES[phase];
    if (!phaseInfo) return;

    await this.sendMilestoneNotification(
      phaseInfo.startPercent,
      `[${phaseInfo.label}] Phase failed`
    );
  }

  /**
   * フェーズ内サブステップ進捗通知（スロットリング対象）
   *
   * Notify sub-step progress within a phase (subject to throttling).
   *
   * @param phase - パイプラインフェーズキー / Pipeline phase key
   * @param subPercent - フェーズ内進捗（0-100） / Progress within phase (0-100)
   * @param message - 進捗メッセージ / Progress message
   */
  async notifySubProgress(phase: string, subPercent: number, message: string): Promise<void> {
    if (!this.isEnabled()) return;

    // スロットリングチェック / Throttling check
    const now = Date.now();
    if (now - this.lastNotificationTime < this.minIntervalMs) {
      return;
    }

    const phaseInfo = PIPELINE_PHASES[phase];
    if (!phaseInfo) return;

    // サブパーセントを0-100にクランプ / Clamp sub-percent to 0-100
    const clampedSub = Math.max(0, Math.min(100, subPercent));

    // フェーズ範囲内の進捗値を計算 / Calculate progress within phase range
    const range = phaseInfo.endPercent - phaseInfo.startPercent;
    const interpolated = Math.round(phaseInfo.startPercent + (range * clampedSub) / 100);

    // 0-100にクランプ / Clamp to 0-100
    const progress = Math.max(0, Math.min(100, interpolated));

    await this.sendThrottledNotification(progress, `[${phaseInfo.label}] ${message}`);
  }

  /**
   * BullMQ progressイベントからMCP通知に変換
   *
   * Convert BullMQ progress event to MCP notification.
   *
   * @param progressData - BullMQ progress data (number or detailed object)
   */
  async fromBullMQProgress(progressData: number | BullMQDetailedProgress): Promise<void> {
    if (!this.isEnabled()) return;

    if (typeof progressData === "number") {
      // NaN/Infinity防御 / NaN/Infinity defense
      if (!Number.isFinite(progressData)) return;

      const progress = Math.max(0, Math.min(100, Math.round(progressData)));
      await this.sendThrottledNotification(progress, `Pipeline progress: ${progress}%`);
      return;
    }

    // 詳細progressデータ / Detailed progress data
    const { overallProgress, currentPhase } = progressData;
    if (!Number.isFinite(overallProgress)) return;

    const progress = Math.max(0, Math.min(100, Math.round(overallProgress)));
    const phaseLabel = currentPhase ? ` (${currentPhase})` : "";
    await this.sendThrottledNotification(progress, `Pipeline progress: ${progress}%${phaseLabel}`);
  }

  // ===========================================================================
  // プライベートメソッド / Private Methods
  // ===========================================================================

  /**
   * マイルストーン通知送信（スロットリング無視）
   *
   * Send milestone notification (bypasses throttling).
   */
  private async sendMilestoneNotification(progress: number, message: string): Promise<void> {
    if (!this.isEnabled()) return;

    await this.doSendNotification(progress, message);
    this.lastNotificationTime = Date.now();
  }

  /**
   * スロットリング付き通知送信
   *
   * Send notification with throttling.
   */
  private async sendThrottledNotification(progress: number, message: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastNotificationTime < this.minIntervalMs) {
      return;
    }

    await this.doSendNotification(progress, message);
    this.lastNotificationTime = now;
  }

  /**
   * 実際の通知送信処理
   *
   * Actual notification send logic.
   */
  private async doSendNotification(progress: number, message: string): Promise<void> {
    if (this.progressToken === undefined || this.sendNotification === undefined) return;

    const notification: ProgressNotificationEvent = {
      method: "notifications/progress",
      params: {
        progressToken: this.progressToken,
        progress: Math.max(0, Math.min(100, progress)),
        total: 100,
        message,
      },
    };

    try {
      await this.sendNotification(notification);
    } catch (error) {
      // Graceful Degradation: 進捗送信失敗はエラーとして扱わない
      // Graceful Degradation: progress send failure is non-fatal
      logger.warn("[ProgressNotificationService] Failed to send progress notification", {
        error: error instanceof Error ? error.message : String(error),
        progress,
      });
    }
  }
}
