// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Browser Manager
 * ブラウザライフサイクル管理の共通ユーティリティ
 *
 * レスポンシブ解析サービス間で重複していたブラウザ起動/終了/共有ブラウザ選択ロジックを集約。
 * MultiViewportCaptureService, ResponsiveQualityEvaluatorService 等が利用する。
 *
 * @module services/responsive/shared-browser-manager
 */

import { chromium, type Browser } from 'playwright';
import { ROBOTS_TXT } from '@reftrix/core';
import { logger, isDevelopment } from '../../utils/logger';

/**
 * ReftrixBot 識別子
 * robots.txt 確認時と同一の識別子を Playwright UA に付与し、法的整合性を保つ。
 * constants.ts の PRODUCT_TOKEN と同期。
 */
const BOT_SUFFIX = `${ROBOTS_TXT.PRODUCT_TOKEN}/1.0 (+https://reftrix.dev/bot)`;

/**
 * ユーザーエージェント定数
 * モバイル/デスクトップのUA文字列を定義
 * 末尾に ReftrixBot 識別子を付与し、robots.txt 確認時の UA と整合させる
 */
export const USER_AGENTS = {
  MOBILE:
    `Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1 ${BOT_SUFFIX}`,
  DESKTOP:
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ${BOT_SUFFIX}`,
} as const;

/**
 * Shared Browser Manager
 * Playwright ブラウザインスタンスのライフサイクル管理を提供する。
 *
 * - シングルトンパターンでブラウザインスタンスを保持
 * - Worker pipeline からの共有ブラウザ（sharedBrowser）対応
 * - 共有ブラウザ使用時は close() でブラウザを閉じない（所有者が管理）
 */
export class SharedBrowserManager {
  private browser: Browser | null = null;
  private usingSharedBrowser = false;
  private readonly serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
  }

  /**
   * 共有ブラウザを使用中かどうか
   */
  get isUsingSharedBrowser(): boolean {
    return this.usingSharedBrowser;
  }

  /**
   * ブラウザを取得（シングルトン）
   * ブラウザが未起動の場合は chromium.launch() で起動する。
   */
  async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      if (isDevelopment()) {
        logger.debug(`[${this.serviceName}] Browser launched`);
      }
    }
    return this.browser;
  }

  /**
   * 共有ブラウザまたは自前ブラウザを解決する
   *
   * sharedBrowser が指定されていればそれを使用し、
   * 未指定の場合は getBrowser() で自前起動する。
   *
   * @param sharedBrowser - 外部から提供される共有ブラウザインスタンス（Worker pipeline用）
   * @returns 使用するブラウザインスタンス
   */
  async resolveOrLaunch(sharedBrowser?: Browser): Promise<Browser> {
    if (sharedBrowser) {
      this.browser = sharedBrowser;
      this.usingSharedBrowser = true;
      return sharedBrowser;
    }
    this.usingSharedBrowser = false;
    return this.getBrowser();
  }

  /**
   * ブラウザを終了
   * 共有ブラウザの場合はブラウザを閉じない（所有者が管理）
   */
  async close(): Promise<void> {
    if (this.browser && !this.usingSharedBrowser) {
      await this.browser.close();
      this.browser = null;
      if (isDevelopment()) {
        logger.debug(`[${this.serviceName}] Browser closed`);
      }
    }
  }

  /**
   * viewport name に応じたUserAgent文字列を返す
   *
   * @param viewportName - ビューポート名 ('mobile' | 'desktop' | 'tablet' 等)
   * @returns UserAgent文字列
   */
  static getUserAgent(viewportName: string): string {
    return viewportName === 'mobile' ? USER_AGENTS.MOBILE : USER_AGENTS.DESKTOP;
  }
}
