// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BrowserProcessManager
 *
 * Playwrightブラウザプロセスの安全な終了と強制終了を管理するクラス
 *
 * WebGL重いサイト（Three.js使用サイト等）では、ブラウザがハングして
 * Playwright APIでのclose()が効かない場合があります。
 * このクラスは、タイムアウト時にブラウザプロセスを確実に強制終了する機能を提供します。
 *
 * ## 特徴
 * - SIGTERM -> SIGKILL の順序でグレースフルシャットダウンを優先
 * - プロセスが存在しない場合のエラー（ESRCH）を正常系として扱う
 * - 子プロセス（レンダラー、GPU等）の一括終了もサポート（Linux）
 *
 * ## 使用例
 * ```typescript
 * const browser = await chromium.launch({ ... });
 * const processManager = new BrowserProcessManager({
 *   browser,
 *   forceKillOnTimeout: true,
 *   killGracePeriodMs: 5000,
 * });
 *
 * // タイムアウト付きクローズ
 * const closed = await processManager.closeWithTimeout(10000);
 * if (!closed) {
 *   console.warn('Browser close timed out, force killed');
 * }
 * ```
 *
 * @module services/browser-process-manager
 */

import { type Browser } from 'playwright';
import { execSync } from 'child_process';
import { logger, isDevelopment } from '../utils/logger';

// =============================================
// 型定義
// =============================================

/**
 * BrowserProcessManager 設定オプション
 */
export interface BrowserProcessManagerOptions {
  /** Playwrightブラウザインスタンス */
  browser: Browser;
  /** タイムアウト時にプロセスを強制終了するかどうか */
  forceKillOnTimeout: boolean;
  /** SIGTERM送信後、SIGKILLまでの待機時間（ms）。デフォルト: 5000ms */
  killGracePeriodMs?: number;
}

// =============================================
// 定数
// =============================================

/**
 * デフォルトのグレース期間（ms）
 * SIGTERM送信後、プロセスが自発的に終了するまで待機する時間
 */
const DEFAULT_KILL_GRACE_PERIOD_MS = 5000;

// =============================================
// BrowserProcessManager クラス
// =============================================

/**
 * ブラウザプロセス管理クラス
 *
 * Playwrightブラウザの安全な終了と、必要に応じた強制終了を担当
 */
export class BrowserProcessManager {
  private browser: Browser;
  private forceKillOnTimeout: boolean;
  private killGracePeriodMs: number;
  private browserPid: number | null = null;

  /**
   * コンストラクタ
   *
   * @param options - 設定オプション
   */
  constructor(options: BrowserProcessManagerOptions) {
    this.browser = options.browser;
    this.forceKillOnTimeout = options.forceKillOnTimeout;
    this.killGracePeriodMs = options.killGracePeriodMs ?? DEFAULT_KILL_GRACE_PERIOD_MS;
    this.browserPid = this.getBrowserPid();

    if (isDevelopment()) {
      logger.debug('[BrowserProcessManager] Initialized', {
        pid: this.browserPid,
        forceKillOnTimeout: this.forceKillOnTimeout,
        killGracePeriodMs: this.killGracePeriodMs,
      });
    }
  }

  /**
   * ブラウザプロセスのPIDを取得
   *
   * Playwrightの内部APIを使用してPIDを取得します。
   * 内部APIが利用できない場合はnullを返します。
   *
   * @returns ブラウザプロセスのPID、または取得できない場合はnull
   */
  private getBrowserPid(): number | null {
    try {
      // Playwrightの内部APIを使用
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const browserAny = this.browser as any;
      const launchedProcess = browserAny._browserType?._launchedProcess;
      return launchedProcess?.pid ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 安全なブラウザ終了を試みる
   *
   * まず通常のclose()を試行し、失敗した場合は
   * forceKillOnTimeoutが有効であれば強制終了を行います。
   */
  async safeClose(): Promise<void> {
    try {
      // まず通常のclose()を試行
      await this.browser.close();

      if (isDevelopment()) {
        logger.debug('[BrowserProcessManager] browser.close() succeeded');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (isDevelopment()) {
        logger.warn('[BrowserProcessManager] browser.close() failed', {
          error: errorMessage,
          forceKillOnTimeout: this.forceKillOnTimeout,
          pid: this.browserPid,
        });
      }

      if (this.forceKillOnTimeout && this.browserPid) {
        await this.forceKill();
      }
    }
  }

  /**
   * タイムアウト付きブラウザクローズ
   *
   * 指定時間内にclose()が完了しない場合、タイムアウトとして扱い、
   * forceKillOnTimeoutが有効であれば強制終了を行います。
   *
   * @param timeoutMs - タイムアウト時間（ms）
   * @returns 正常に終了した場合true、タイムアウトまたは強制終了した場合false
   */
  async closeWithTimeout(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let resolved = false;

      const timeout = setTimeout(async () => {
        if (resolved) return;
        resolved = true;

        if (isDevelopment()) {
          logger.warn(`[BrowserProcessManager] close() timed out after ${timeoutMs}ms`, {
            forceKillOnTimeout: this.forceKillOnTimeout,
            pid: this.browserPid,
          });
        }

        if (this.forceKillOnTimeout && this.browserPid) {
          await this.forceKill();
        }

        resolve(false);
      }, timeoutMs);

      this.browser
        .close()
        .then(() => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);

          if (isDevelopment()) {
            logger.debug('[BrowserProcessManager] close() completed within timeout');
          }

          resolve(true);
        })
        .catch(async () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);

          if (this.forceKillOnTimeout && this.browserPid) {
            await this.forceKill();
          }

          resolve(false);
        });
    });
  }

  /**
   * プロセスを強制終了
   *
   * SIGTERM -> SIGKILL の順序でグレースフルシャットダウンを試みます。
   * SIGTERMを送信後、killGracePeriodMs待機し、プロセスがまだ存在する場合は
   * SIGKILLを送信します。
   *
   * プロセスが既に存在しない場合（ESRCH）は正常系として扱います。
   */
  async forceKill(): Promise<void> {
    if (!this.browserPid) {
      if (isDevelopment()) {
        logger.warn('[BrowserProcessManager] No PID available for force kill');
      }
      return;
    }

    try {
      // SIGTERM を送信（グレースフルシャットダウン試行）
      if (isDevelopment()) {
        logger.debug(`[BrowserProcessManager] Sending SIGTERM to PID ${this.browserPid}`);
      }
      process.kill(this.browserPid, 'SIGTERM');

      // グレースフルシャットダウンを待機
      await new Promise((resolve) => setTimeout(resolve, this.killGracePeriodMs));

      // プロセスがまだ存在するか確認
      if (this.isProcessAlive()) {
        // SIGKILL を送信（強制終了）
        if (isDevelopment()) {
          logger.warn(
            `[BrowserProcessManager] SIGTERM failed, sending SIGKILL to PID ${this.browserPid}`
          );
        }
        process.kill(this.browserPid, 'SIGKILL');
      }

      if (isDevelopment()) {
        logger.info(
          `[BrowserProcessManager] Successfully killed browser process PID ${this.browserPid}`
        );
      }
    } catch (error) {
      // ESRCH: プロセスが存在しない（既に終了している）
      const errnoError = error as { code?: string };
      if (errnoError.code !== 'ESRCH') {
        if (isDevelopment()) {
          logger.error('[BrowserProcessManager] forceKill error', {
            error: error instanceof Error ? error.message : String(error),
            pid: this.browserPid,
          });
        }
      } else if (isDevelopment()) {
        logger.debug(
          `[BrowserProcessManager] Process ${this.browserPid} already terminated (ESRCH)`
        );
      }
    }
  }

  /**
   * プロセスが生存しているか確認
   *
   * signal 0を送信することでプロセスの存在を確認します。
   * 成功すればプロセスが存在、ESRCHエラーならプロセスが存在しません。
   *
   * @returns プロセスが生存している場合true
   */
  private isProcessAlive(): boolean {
    if (!this.browserPid) return false;

    try {
      process.kill(this.browserPid, 0); // シグナル0はプロセス存在確認
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 子プロセス（レンダラー、GPU等）も含めて全て終了
   *
   * Linuxではpkillを使用して、指定PIDの子プロセスも全て終了します。
   * SIGTERM -> SIGKILL の順序で処理します。
   *
   * 注意: Windows対応は不要（Reftrixはリサンプル環境）
   */
  async killAllChildren(): Promise<void> {
    if (!this.browserPid) return;

    try {
      // Linuxではpkillを使用して子プロセスも終了
      if (process.platform === 'linux') {
        if (isDevelopment()) {
          logger.debug(`[BrowserProcessManager] Killing child processes of PID ${this.browserPid}`);
        }

        // SEC-H3: execSync with PID interpolation
        // セキュリティ: browserPidはPlaywright内部API由来のnumber型であり、
        // ユーザー入力を含まない。コマンドインジェクションのリスクは存在しない。
        // stdio: デフォルト（pipe）のため、子プロセス出力は親に流れない。
        execSync(`pkill -TERM -P ${this.browserPid} || true`);

        // 待機
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // SIGKILL を子プロセスに送信
        execSync(`pkill -KILL -P ${this.browserPid} || true`);

        if (isDevelopment()) {
          logger.debug('[BrowserProcessManager] Child processes killed');
        }
      }
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[BrowserProcessManager] killAllChildren error', {
          error: error instanceof Error ? error.message : String(error),
          pid: this.browserPid,
        });
      }
    }
  }
}
