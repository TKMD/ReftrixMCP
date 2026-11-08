// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
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

import { type Browser, type BrowserContextOptions } from "playwright";
import { logger, isDevelopment } from "../../utils/logger";
import { launchChromium } from "../../utils/launch-chromium";
import { browserUserAgent } from "../../utils/browser-user-agent";

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
   * ブラウザが未起動の場合は launchChromium() で起動する。
   */
  async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await launchChromium({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
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
   * viewport に付ける User-Agent。起動中のブラウザの実際のバージョンを使い、`mobile` だけ
   * Android 版 Chrome の形にする (固定のバージョンや別ブラウザは名乗らない、CAP-L-02)。
   *
   * The User-Agent for a viewport: the running browser's real version; `mobile` uses the Chrome on
   * Android form (no fixed versions, never another browser; CAP-L-02). INV-CRAWLER-UA-IDENTITY-001.
   *
   * @param viewportName - ビューポート名 ('mobile' | 'desktop' | 'tablet' 等)
   * @param browser - context を作るブラウザ / the browser the context is created on
   */
  static getUserAgent(viewportName: string, browser: Pick<Browser, "version">): string {
    return browserUserAgent(browser, { mobile: viewportName === "mobile" });
  }
  /**
   * viewport 用の BrowserContext オプション。`mobile` は UA に加えて `isMobile` / `hasTouch` を付け、
   * Client Hints (`Sec-CH-UA-Mobile`、`navigator.userAgentData.mobile`) を UA と揃える。meta viewport の
   * 無いページは実機と同じく約 980px のレイアウトで描画される。ブランド (`HeadlessChrome`) は変えない。
   *
   * Context options for a viewport. `mobile` also sets `isMobile` / `hasTouch` so the Client Hints
   * agree with the UA; a page without a meta viewport lays out at about 980px, as on a real phone.
   * The brands (`HeadlessChrome`) are left as they are.
   */
  static getContextOptions(
    viewport: { name: string; width: number; height: number },
    browser: Pick<Browser, "version">
  ): BrowserContextOptions {
    const mobile = viewport.name === "mobile";
    return {
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: SharedBrowserManager.getUserAgent(viewport.name, browser),
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    };
  }
}
