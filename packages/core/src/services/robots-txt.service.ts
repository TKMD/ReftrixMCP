// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RobotsTxtService
 *
 * RFC 9309 (Robots Exclusion Protocol) 準拠のrobots.txtチェックサービス。
 * Webクローリング前にrobots.txtを取得・パースし、クロール許可を判定する。
 *
 * 設計方針:
 * - インメモリLRUキャッシュ（TTL 24h, 最大500エントリ）
 * - robots-parser (MIT) による RFC 9309 準拠パース
 * - フェッチ失敗時のコンサバティブフォールバック（deny）
 * - Feature flag (`REFTRIX_RESPECT_ROBOTS_TXT`) による即時無効化
 * - SSRF安全なfetch（validateExternalUrl相当のホスト検証）
 *
 * @module @reftrix/core/services/robots-txt
 * @see oss/docs/legal/ROBOTS_TXT_COMPLIANCE.md
 */

import robotsParser from "robots-parser";
import { logger } from "../utils/logger";
import { ROBOTS_TXT } from "../constants";
import type { RobotsTxtCheckResult } from "../types";

// =============================================================================
// Types
// =============================================================================

interface CachedRobotsTxt {
  /** Parsed robots.txt content (null if fetch failed) */
  robotsTxt: string | null;
  /** Timestamp when cached */
  cachedAt: number;
  /** Whether fetch was successful */
  fetchSuccess: boolean;
}

// =============================================================================
// RobotsTxtService
// =============================================================================

/**
 * Robots.txt準拠チェックサービス
 *
 * シングルトンとして使用し、インメモリキャッシュでrobots.txtをキャッシュする。
 * プロセス再起動時にキャッシュは消失するが、MCPサーバーは長時間稼働のため
 * 実用上の影響は軽微（再起動後に初回アクセス時のみ+数秒のレイテンシ）。
 */
export class RobotsTxtService {
  private cache: Map<string, CachedRobotsTxt> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startPeriodicCleanup();
  }

  /**
   * URLがrobots.txtで許可されているか確認
   *
   * @param url - チェック対象のURL
   * @param productToken - クローラー識別子（デフォルト: ReftrixBot）
   * @param respectRobotsTxt - robots.txtを尊重するかのオーバーライド（undefinedの場合はenv flagを参照）
   * @returns チェック結果
   */
  async isAllowed(
    url: string,
    productToken?: string,
    respectRobotsTxt?: boolean,
  ): Promise<RobotsTxtCheckResult> {
    const token = productToken ?? ROBOTS_TXT.PRODUCT_TOKEN;

    // Per-tool override チェック（最優先）
    if (respectRobotsTxt === false) {
      return {
        allowed: true,
        domain: this.extractDomain(url),
        cached: false,
        reason: "override",
      };
    }

    // Feature flag チェック（環境変数）
    if (!this.isFeatureEnabled()) {
      return {
        allowed: true,
        domain: this.extractDomain(url),
        cached: false,
        reason: "feature_disabled",
      };
    }

    const domain = this.extractDomain(url);

    // キャッシュ確認
    const cached = this.getFromCache(domain);
    if (cached !== null) {
      return this.checkWithRobotsTxt(url, domain, cached, token, true);
    }

    // robots.txtを取得
    const robotsTxtContent = await this.fetchRobotsTxt(domain);

    // キャッシュに保存
    this.setCache(domain, robotsTxtContent);

    return this.checkWithRobotsTxt(url, domain, robotsTxtContent, token, false);
  }

  /**
   * キャッシュをクリア
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * キャッシュエントリ数を取得
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * サービスのシャットダウン
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Feature flagが有効かどうか判定（環境変数のみ参照）
   *
   * Per-toolオーバーライドは `isAllowed()` で先に処理されるため、
   * ここでは環境変数のみを確認する。
   *
   * 判定:
   * - 環境変数 REFTRIX_RESPECT_ROBOTS_TXT=false|0 → 無効
   * - 環境変数未設定 → デフォルト有効
   */
  private isFeatureEnabled(): boolean {
    const envValue = process.env[ROBOTS_TXT.ENV_FLAG];
    if (envValue !== undefined) {
      return envValue.toLowerCase() !== "false" && envValue !== "0";
    }

    // デフォルト: 有効
    return true;
  }

  /**
   * URLからドメインを抽出
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return url;
    }
  }

  /**
   * キャッシュからrobots.txt取得
   */
  private getFromCache(domain: string): string | null {
    const entry = this.cache.get(domain);
    if (!entry) {
      return null;
    }

    // TTL チェック
    if (Date.now() - entry.cachedAt > ROBOTS_TXT.CACHE_TTL_MS) {
      this.cache.delete(domain);
      return null;
    }

    // フェッチ失敗エントリの場合はnullを返す（再取得を促す）
    // ただしnullもキャッシュされている場合は"コンサバティブdeny"
    if (!entry.fetchSuccess) {
      return null;
    }

    return entry.robotsTxt;
  }

  /**
   * キャッシュにrobots.txtを保存（LRU eviction付き）
   */
  private setCache(domain: string, content: string | null): void {
    // LRU eviction: 最大エントリ数を超えた場合、最も古いエントリを削除
    if (this.cache.size >= ROBOTS_TXT.MAX_CACHE_ENTRIES && !this.cache.has(domain)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(domain, {
      robotsTxt: content,
      cachedAt: Date.now(),
      fetchSuccess: content !== null,
    });
  }

  /**
   * robots.txtをHTTP経由で取得
   *
   * セキュリティ:
   * - SSRF保護: プライベートIP・メタデータサービスをブロック
   * - リダイレクト: manual mode でリダイレクト先もSSRF検証
   * - タイムアウト: 5秒
   * - 最大サイズ: 1MB
   * - HTTPS優先（HTTPも許容）
   *
   * フォールバック:
   * - 404: "" → allow（robots.txtなし = 制限なし）
   * - 5xx/timeout: null → deny（コンサバティブ）
   */
  private async fetchRobotsTxt(domain: string): Promise<string | null> {
    const robotsUrl = `${domain}/robots.txt`;

    // SSRF保護: ドメインのホスト名を検証
    if (this.isBlockedDomain(robotsUrl)) {
      logger.warn("[RobotsTxtService] SSRF blocked for robots.txt fetch", { domain });
      return null;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        ROBOTS_TXT.FETCH_TIMEOUT_MS,
      );

      try {
        // リダイレクト先のSSRFバイパスを防ぐため manual mode
        let response = await fetch(robotsUrl, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "User-Agent": ROBOTS_TXT.USER_AGENT,
            Accept: "text/plain",
          },
          redirect: "manual",
        });

        // リダイレクト処理（最大3回、リダイレクト先もSSRF検証）
        let redirectCount = 0;
        const MAX_REDIRECTS = 3;
        while (redirectCount < MAX_REDIRECTS && response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            break;
          }

          // リダイレクト先のURLを解決
          const redirectUrl = new URL(location, robotsUrl).href;

          // リダイレクト先のSSRF検証
          if (this.isBlockedDomain(redirectUrl)) {
            logger.warn("[RobotsTxtService] SSRF blocked redirect target", { domain, redirectUrl });
            return null;
          }

          response = await fetch(redirectUrl, {
            method: "GET",
            signal: controller.signal,
            headers: {
              "User-Agent": ROBOTS_TXT.USER_AGENT,
              Accept: "text/plain",
            },
            redirect: "manual",
          });
          redirectCount++;
        }

        clearTimeout(timeoutId);

        // 404: robots.txt doesn't exist → allow everything
        if (response.status === 404) {
          logger.info("[RobotsTxtService] No robots.txt found (404)", { domain });
          return "";
        }

        // 4xx (non-404): treat as no restrictions
        if (response.status >= 400 && response.status < 500) {
          logger.warn("[RobotsTxtService] robots.txt returned client error", {
            domain,
            status: response.status,
          });
          return "";
        }

        // 5xx: server error → conservative deny
        if (response.status >= 500) {
          logger.warn("[RobotsTxtService] robots.txt returned server error", {
            domain,
            status: response.status,
          });
          return null;
        }

        // Content-Type チェック（textでない場合は無視）
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType && !contentType.includes("text/")) {
          logger.warn("[RobotsTxtService] robots.txt returned non-text content", {
            domain,
            contentType,
          });
          return "";
        }

        // サイズチェック
        const contentLength = response.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > ROBOTS_TXT.MAX_FILE_SIZE) {
          logger.warn("[RobotsTxtService] robots.txt too large, treating as deny", {
            domain,
            size: contentLength,
          });
          return null;
        }

        const text = await response.text();

        // 実際のサイズ再チェック（Content-Lengthがない場合）
        if (text.length > ROBOTS_TXT.MAX_FILE_SIZE) {
          logger.warn("[RobotsTxtService] robots.txt body too large, treating as deny", {
            domain,
            size: text.length,
          });
          return null;
        }

        return text;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // AbortError = timeout
      if (error instanceof Error && error.name === "AbortError") {
        logger.warn("[RobotsTxtService] robots.txt fetch timed out", { domain });
      } else {
        logger.warn("[RobotsTxtService] Failed to fetch robots.txt", {
          domain,
          error: errorMessage,
        });
      }

      // フェッチ失敗 → コンサバティブ deny
      return null;
    }
  }

  // ===========================================================================
  // SSRF Protection
  // ===========================================================================

  /**
   * ブロック対象ホスト名一覧
   * localhost、メタデータサービス、Kubernetesサービスディスカバリ
   */
  private static readonly BLOCKED_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "[::1]",
    "169.254.169.254",
    "metadata.google.internal",
    "169.254.0.0",
    "kubernetes.default.svc",
  ]);

  /**
   * ブロック対象IPv4レンジ
   * プライベートIP、ループバック、リンクローカル
   */
  private static readonly BLOCKED_IP_RANGES: readonly RegExp[] = [
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^127\./,
    /^0\./,
    /^169\.254\./,
  ];

  /**
   * URLのホスト名がSSRFブロック対象かどうか判定
   *
   * @param url - 検証するURL
   * @returns ブロック対象の場合true
   */
  private isBlockedDomain(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // ブロックホスト一覧との直接一致
      if (RobotsTxtService.BLOCKED_HOSTS.has(hostname)) {
        return true;
      }

      // メタデータサービスの部分一致
      if (hostname.includes("metadata.google.internal")) {
        return true;
      }

      // プライベートIPレンジチェック
      for (const range of RobotsTxtService.BLOCKED_IP_RANGES) {
        if (range.test(hostname)) {
          return true;
        }
      }

      return false;
    } catch {
      // URL解析失敗 → ブロック（コンサバティブ）
      return true;
    }
  }

  /**
   * robots-parserでURLの許可/拒否を判定
   */
  private checkWithRobotsTxt(
    url: string,
    domain: string,
    robotsTxtContent: string | null,
    productToken: string,
    cached: boolean,
  ): RobotsTxtCheckResult {
    // フェッチ失敗（null） → コンサバティブ deny
    if (robotsTxtContent === null) {
      return {
        allowed: false,
        domain,
        cached,
        reason: "fetch_error",
      };
    }

    // 空文字列（404等） → 制限なし
    if (robotsTxtContent === "") {
      return {
        allowed: true,
        domain,
        cached,
        reason: "allowed",
      };
    }

    // robots-parserでパース・チェック
    const robotsUrl = `${domain}/robots.txt`;
    const robot = robotsParser(robotsUrl, robotsTxtContent);
    const isAllowed = robot.isAllowed(url, productToken);
    const crawlDelay = robot.getCrawlDelay(productToken);

    // isAllowed returns undefined when no matching rule found → treat as allowed
    const allowed = isAllowed !== false;

    const result: RobotsTxtCheckResult = {
      allowed,
      domain,
      cached,
      reason: allowed ? "allowed" : "disallowed",
    };

    if (crawlDelay !== undefined) {
      result.crawlDelay = crawlDelay;
    }

    return result;
  }

  /**
   * 定期的にTTL切れキャッシュをクリーンアップ
   */
  private startPeriodicCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [domain, entry] of this.cache) {
        if (now - entry.cachedAt > ROBOTS_TXT.CACHE_TTL_MS) {
          this.cache.delete(domain);
        }
      }
    }, ROBOTS_TXT.CLEANUP_INTERVAL_MS);

    // タイマーがプロセス終了をブロックしないようにする
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }
}

// =============================================================================
// Singleton & Convenience API
// =============================================================================

let instance: RobotsTxtService | null = null;

/**
 * RobotsTxtServiceのシングルトンインスタンスを取得
 */
export function getRobotsTxtService(): RobotsTxtService {
  if (!instance) {
    instance = new RobotsTxtService();
  }
  return instance;
}

/**
 * URLがrobots.txtで許可されているか簡易チェック
 *
 * @param url - チェック対象のURL
 * @param respectRobotsTxt - robots.txtを尊重するかのオーバーライド
 * @returns チェック結果
 */
export async function isUrlAllowedByRobotsTxt(
  url: string,
  respectRobotsTxt?: boolean,
): Promise<RobotsTxtCheckResult> {
  return getRobotsTxtService().isAllowed(url, undefined, respectRobotsTxt);
}

/**
 * シングルトンインスタンスをリセット（テスト用）
 */
export function resetRobotsTxtService(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
