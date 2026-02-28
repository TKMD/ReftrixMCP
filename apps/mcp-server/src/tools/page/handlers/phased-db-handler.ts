// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PhasedDbHandler - 段階的分析のDB即時コミットハンドラー
 *
 * Phase2-2: 各フェーズ完了時に部分結果を即座にDBにコミットする機能
 * WebGL重いサイト（Linear, Vercel, Notion等）でタイムアウトしても部分結果を保持
 *
 * @module src/tools/page/handlers/phased-db-handler
 */

import type { PrismaClient, AnalysisPhaseStatus } from '@prisma/client';
import { logger } from '../../../utils/logger';

/**
 * フェーズ結果型（phased-executor.tsと共有）
 */
export interface PhaseResult<T> {
  phase: 'layout' | 'motion' | 'quality';
  success: boolean;
  data?: T;
  error?: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * PhasedDbHandlerのオプション
 */
export interface PhasedDbHandlerOptions {
  prisma: PrismaClient | MinimalPrismaClient;
  webPageId: string;
}

/**
 * 最小限のPrismaクライアントインターフェース（テスト用）
 */
export interface MinimalPrismaClient {
  webPage: {
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  $transaction?: <T>(fn: (tx: MinimalPrismaClient) => Promise<T>) => Promise<T>;
}

/**
 * フェーズに対応するAnalysisPhaseStatus
 */
const PHASE_STATUS_MAP: Record<'layout' | 'motion' | 'quality', AnalysisPhaseStatus> = {
  layout: 'layout_done',
  motion: 'motion_done',
  quality: 'quality_done',
};

/**
 * PhasedDbHandler
 *
 * 段階的分析の各フェーズ完了時にDBを即時更新するハンドラー
 * 部分成功を保持し、後続フェーズの失敗・タイムアウトに備える
 */
export class PhasedDbHandler {
  private options: PhasedDbHandlerOptions;

  constructor(options: PhasedDbHandlerOptions) {
    this.options = options;
  }

  /**
   * 分析開始をマーク
   * - analysisPhaseStatus: pending
   * - analysisStatus: processing（後方互換性）
   * - analysisStartedAt: 現在時刻
   * - analysisError: null（リセット）
   * - lastAnalyzedPhase: null（リセット）
   */
  async markAnalysisStarted(): Promise<void> {
    const now = new Date();

    await this.options.prisma.webPage.update({
      where: { id: this.options.webPageId },
      data: {
        analysisPhaseStatus: 'pending' as AnalysisPhaseStatus,
        analysisStatus: 'processing', // 後方互換性
        analysisStartedAt: now,
        analysisError: null,
        lastAnalyzedPhase: null,
      },
    });

    logger.debug(
      `[PhasedDbHandler] markAnalysisStarted: webPageId=${this.options.webPageId}, startedAt=${now.toISOString()}`
    );
  }

  /**
   * フェーズ結果をコミット
   * 成功時のみDBを更新、失敗時は更新しない（部分成功を保持）
   *
   * @param phase フェーズ名（layout, motion, quality）
   * @param result フェーズ結果
   */
  async commitPhaseResult(
    phase: 'layout' | 'motion' | 'quality',
    result: PhaseResult<unknown>
  ): Promise<void> {
    // 失敗時は更新しない（前のフェーズの成功状態を維持）
    if (!result.success) {
      logger.debug(
        `[PhasedDbHandler] commitPhaseResult: phase=${phase} failed, skipping DB update (error=${result.error}, timedOut=${result.timedOut})`
      );
      return;
    }

    const newStatus = PHASE_STATUS_MAP[phase];

    await this.options.prisma.webPage.update({
      where: { id: this.options.webPageId },
      data: {
        analysisPhaseStatus: newStatus,
        lastAnalyzedPhase: phase,
      },
    });

    logger.debug(
      `[PhasedDbHandler] commitPhaseResult: phase=${phase} success, analysisPhaseStatus=${newStatus}, durationMs=${result.durationMs}`
    );
  }

  /**
   * 分析完了をマーク
   *
   * @param overallSuccess 全フェーズ成功したか
   *   - true: analysisPhaseStatus = completed, analysisStatus = completed
   *   - false: analysisPhaseStatus は変更しない（部分成功状態を維持）、analysisStatus = completed
   */
  async markAnalysisCompleted(overallSuccess: boolean): Promise<void> {
    const now = new Date();

    const updateData: Record<string, unknown> = {
      analysisCompletedAt: now,
    };

    if (overallSuccess) {
      updateData.analysisPhaseStatus = 'completed' as AnalysisPhaseStatus;
      updateData.analysisStatus = 'completed'; // 後方互換性
    } else {
      // 部分成功時はanalysisPhaseStatusを変更しない
      // analysisStatusはcompletedに（処理自体は終了したため）
      // ただし、ステータスを明示的に部分成功として扱う
      // analysisPhaseStatus は最後に成功したフェーズのまま維持
      updateData.analysisStatus = 'completed'; // 後方互換性（処理終了を示す）
    }

    await this.options.prisma.webPage.update({
      where: { id: this.options.webPageId },
      data: updateData,
    });

    logger.debug(
      `[PhasedDbHandler] markAnalysisCompleted: webPageId=${this.options.webPageId}, overallSuccess=${overallSuccess}, completedAt=${now.toISOString()}`
    );
  }

  /**
   * 分析失敗をマーク
   *
   * @param error エラーメッセージ
   */
  async markAnalysisFailed(error: string): Promise<void> {
    const now = new Date();

    await this.options.prisma.webPage.update({
      where: { id: this.options.webPageId },
      data: {
        analysisPhaseStatus: 'failed' as AnalysisPhaseStatus,
        analysisStatus: 'failed', // 後方互換性
        analysisError: error,
        analysisCompletedAt: now,
      },
    });

    logger.debug(
      `[PhasedDbHandler] markAnalysisFailed: webPageId=${this.options.webPageId}, error=${error}, failedAt=${now.toISOString()}`
    );
  }
}
