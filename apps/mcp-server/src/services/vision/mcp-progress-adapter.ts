// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCPProgressAdapter - MCP notifications/progress 統合
 *
 * Vision CPU完走保証 Phase 4: MCPツール進捗コールバック対応
 *
 * ProgressReporterの進捗イベントをMCP SDK の sendNotification を通じて
 * notifications/progress として送信するアダプター。
 *
 * MCP Protocol Specification:
 * - method: 'notifications/progress'
 * - params: { progressToken, progress, total?, message? }
 *
 * @see https://spec.modelcontextprotocol.io/specification/basic/utilities/progress/
 * @see apps/mcp-server/src/services/vision/progress-reporter.ts
 */

import type { ProgressEvent, ProgressCallback } from './progress-reporter.js';
import { logger } from '../../utils/logger';

// =============================================================================
// 型定義
// =============================================================================

/**
 * MCP Progress Notification 型
 *
 * MCP SDK の ProgressNotificationSchema に準拠
 */
export interface MCPProgressNotification {
  method: 'notifications/progress';
  params: {
    /** クライアントから提供された進捗トークン */
    progressToken: string | number;
    /** 現在の進捗値 */
    progress: number;
    /** 合計値（オプション、デフォルト100） */
    total?: number;
    /** 進捗メッセージ（オプション） */
    message?: string;
  };
}

/**
 * sendNotification 関数型
 *
 * MCP SDK の RequestHandlerExtra.sendNotification に準拠
 */
export type SendNotificationFn = (notification: MCPProgressNotification) => Promise<void>;

/**
 * MCPProgressAdapter オプション
 */
export interface MCPProgressOptions {
  /** MCP クライアントから提供された progressToken */
  progressToken: string | number | undefined;
  /** MCP SDK の sendNotification 関数 */
  sendNotification: SendNotificationFn | undefined;
  /** ログ出力を有効にするか（デフォルト: false） */
  enableLogging?: boolean;
}

// =============================================================================
// MCPProgressAdapter クラス
// =============================================================================

/**
 * MCP Progress Notification アダプター
 *
 * ProgressReporter の進捗イベントを MCP の notifications/progress に変換して送信。
 *
 * @example
 * ```typescript
 * const adapter = new MCPProgressAdapter({
 *   progressToken: request._meta?.progressToken,
 *   sendNotification: extra.sendNotification,
 * });
 *
 * const reporter = new ProgressReporter({
 *   onProgress: (event) => adapter.sendProgress(event),
 * });
 * ```
 */
export class MCPProgressAdapter {
  private readonly progressToken: string | number;
  private readonly sendNotification: SendNotificationFn;
  private readonly enableLogging: boolean;

  /**
   * MCPProgressAdapter のコンストラクタ
   *
   * @param options - アダプターオプション
   * @throws Error - progressToken または sendNotification が未定義の場合
   */
  constructor(options: MCPProgressOptions) {
    if (options.progressToken === undefined) {
      throw new Error('progressToken is required');
    }
    if (options.sendNotification === undefined) {
      throw new Error('sendNotification is required');
    }

    this.progressToken = options.progressToken;
    this.sendNotification = options.sendNotification;
    this.enableLogging = options.enableLogging ?? false;
  }

  /**
   * progressToken を取得
   *
   * @returns progressToken
   */
  getProgressToken(): string | number {
    return this.progressToken;
  }

  /**
   * アダプターが有効かどうか
   *
   * @returns 常に true（コンストラクタで検証済み）
   */
  isEnabled(): boolean {
    return true;
  }

  /**
   * 進捗を MCP notifications/progress として送信
   *
   * @param event - ProgressReporter からの進捗イベント
   */
  async sendProgress(event: ProgressEvent): Promise<void> {
    try {
      // 進捗値をクランプ（0-100）
      const clampedProgress = Math.max(0, Math.min(100, event.progress));

      // メッセージを構築（phase情報を含める）
      const message = this.buildMessage(event);

      const notification: MCPProgressNotification = {
        method: 'notifications/progress',
        params: {
          progressToken: this.progressToken,
          progress: clampedProgress,
          total: 100,
          message,
        },
      };

      await this.sendNotification(notification);

      if (this.enableLogging) {
        logger.info(`[MCPProgressAdapter] Sent progress: ${clampedProgress}% - ${message}`);
      }
    } catch (error) {
      // Graceful Degradation: 進捗送信失敗はエラーとして扱わない
      if (this.enableLogging) {
        console.warn('[MCPProgressAdapter] Failed to send progress notification:', error);
      }
    }
  }

  /**
   * 進捗メッセージを構築
   *
   * @param event - 進捗イベント
   * @returns フォーマットされたメッセージ
   */
  private buildMessage(event: ProgressEvent): string {
    const { phase, message } = event;

    // メッセージに既にphase情報が含まれている場合はそのまま返す
    if (message.toLowerCase().includes(phase)) {
      return message;
    }

    // phase情報を含める
    return `[${phase}] ${message}`;
  }
}

// =============================================================================
// ファクトリ関数
// =============================================================================

/**
 * ProgressReporter 用の MCP Progress Callback を作成
 *
 * progressToken または sendNotification が未定義の場合は null を返す。
 * これにより、進捗報告が利用不可の場合でも処理を続行できる（Graceful Degradation）。
 *
 * @param options - MCPProgressOptions
 * @returns ProgressCallback または null
 *
 * @example
 * ```typescript
 * const progressCallback = createMCPProgressCallback({
 *   progressToken: request._meta?.progressToken,
 *   sendNotification: extra.sendNotification,
 * });
 *
 * const reporter = new ProgressReporter({
 *   onProgress: progressCallback ?? undefined,
 * });
 * ```
 */
export function createMCPProgressCallback(
  options: MCPProgressOptions
): ProgressCallback | null {
  // progressToken または sendNotification が未定義の場合は null を返す
  if (options.progressToken === undefined || options.sendNotification === undefined) {
    return null;
  }

  const adapter = new MCPProgressAdapter(options);

  // 非同期処理を同期的に呼び出すラッパー（fire-and-forget）
  return (event: ProgressEvent): void => {
    // エラーは内部でハンドリングされるため、void として呼び出し
    void adapter.sendProgress(event);
  };
}
