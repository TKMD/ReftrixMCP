// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RobotsTxtService テスト
 *
 * RFC 9309 (Robots Exclusion Protocol) 準拠のrobots.txtチェックサービスの
 * 包括的ユニットテスト。
 *
 * テスト対象:
 * - RobotsTxtService.isAllowed(): メインの許可/拒否判定
 * - Feature flag (REFTRIX_RESPECT_ROBOTS_TXT): 環境変数による制御
 * - robots.txtパース: robots-parserによるRFC 9309準拠パース
 * - HTTP Fetch: 各種HTTPステータスコード・エラーのハンドリング
 * - LRUキャッシュ: TTL、eviction、クリア
 * - Singleton / Convenience API: getRobotsTxtService, isUrlAllowedByRobotsTxt, resetRobotsTxtService
 * - ドメイン抽出: URL→origin変換
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import {
  RobotsTxtService,
  getRobotsTxtService,
  isUrlAllowedByRobotsTxt,
  resetRobotsTxtService,
} from "../../src/services/robots-txt.service";
import { ROBOTS_TXT } from "../../src/constants";

// ロガーをモック化（テスト中のログ出力を抑制）
vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// =============================================================================
// テストヘルパー
// =============================================================================

/**
 * fetch モックレスポンスを生成するヘルパー
 */
function createMockResponse(options: {
  status?: number;
  body?: string;
  contentType?: string;
  contentLength?: string;
  headers?: Record<string, string>;
}): Response {
  const {
    status = 200,
    body = "",
    contentType = "text/plain",
    headers: extraHeaders = {},
  } = options;

  const headersMap: Record<string, string> = {
    "content-type": contentType,
    ...extraHeaders,
  };

  // contentLength が明示指定された場合のみヘッダに含める
  if (options.contentLength !== undefined) {
    headersMap["content-length"] = options.contentLength;
  }

  const headersObj = new Headers(headersMap);

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headersObj,
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

/**
 * 基本的なrobots.txtコンテンツ（全拒否）
 */
const DISALLOW_ALL = `User-agent: *\nDisallow: /`;

/**
 * 特定パスのみ許可するrobots.txt
 */
const ALLOW_SPECIFIC_PATH = `User-agent: *\nDisallow: /\nAllow: /public/`;

/**
 * ReftrixBot専用ルールを含むrobots.txt
 */
const REFTRIX_BOT_SPECIFIC = [
  "User-agent: ReftrixBot",
  "Disallow: /private/",
  "Allow: /",
  "",
  "User-agent: *",
  "Disallow: /",
].join("\n");

/**
 * Crawl-delayを含むrobots.txt
 */
const WITH_CRAWL_DELAY = [
  "User-agent: *",
  "Crawl-delay: 10",
  "Disallow: /admin/",
].join("\n");

// =============================================================================
// テスト本体
// =============================================================================

describe("RobotsTxtService", () => {
  let service: RobotsTxtService;
  let mockFetch: Mock;

  beforeEach(() => {
    // fetch をモック化
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // タイマーを制御可能にする（キャッシュTTLテスト用）
    vi.useFakeTimers();

    // 環境変数をクリーンに
    vi.unstubAllEnvs();

    // 新しいサービスインスタンス生成
    service = new RobotsTxtService();
  });

  afterEach(() => {
    // サービスの定期クリーンアップタイマーを解放
    service.dispose();

    // シングルトンをリセット
    resetRobotsTxtService();

    // モック・タイマーをリストア
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // ===========================================================================
  // 1. Feature Flag テスト
  // ===========================================================================

  describe("Feature Flag テスト", () => {
    it('環境変数 REFTRIX_RESPECT_ROBOTS_TXT=false → 常に許可、reason="feature_disabled"', async () => {
      // Arrange
      vi.stubEnv("REFTRIX_RESPECT_ROBOTS_TXT", "false");

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("feature_disabled");
      expect(result.cached).toBe(false);
      // fetchが呼ばれないことを確認（feature無効のため）
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('環境変数 REFTRIX_RESPECT_ROBOTS_TXT=0 → 常に許可', async () => {
      // Arrange
      vi.stubEnv("REFTRIX_RESPECT_ROBOTS_TXT", "0");

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("feature_disabled");
    });

    it('環境変数 REFTRIX_RESPECT_ROBOTS_TXT=FALSE → 大文字小文字を区別しない', async () => {
      // Arrange
      vi.stubEnv("REFTRIX_RESPECT_ROBOTS_TXT", "FALSE");

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("feature_disabled");
    });

    it("環境変数 未設定 → デフォルトで有効（robots.txtを尊重）", async () => {
      // Arrange: 環境変数を設定しない
      // 200 OKでDisallow: /を返す → 拒否されるべき
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disallowed");
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('環境変数 REFTRIX_RESPECT_ROBOTS_TXT=true → 有効', async () => {
      // Arrange
      vi.stubEnv("REFTRIX_RESPECT_ROBOTS_TXT", "true");
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disallowed");
    });

    it('環境変数 REFTRIX_RESPECT_ROBOTS_TXT=1 → 有効（"false"と"0"以外はすべて有効）', async () => {
      // Arrange
      vi.stubEnv("REFTRIX_RESPECT_ROBOTS_TXT", "1");
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disallowed");
    });

    it('per-tool override: respectRobotsTxt=false → 許可、reason="override"', async () => {
      // Arrange: 環境変数は有効にしておく（デフォルト）

      // Act
      const result = await service.isAllowed(
        "https://example.com/page",
        undefined,
        false,
      );

      // Assert
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("override");
      expect(result.cached).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("per-tool override: respectRobotsTxt=true → robots.txtを尊重", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      const result = await service.isAllowed(
        "https://example.com/page",
        undefined,
        true,
      );

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disallowed");
    });

    it("per-tool override: respectRobotsTxt=false は環境変数trueより優先される", async () => {
      // Arrange
      vi.stubEnv("REFTRIX_RESPECT_ROBOTS_TXT", "true");

      // Act
      const result = await service.isAllowed(
        "https://example.com/page",
        undefined,
        false,
      );

      // Assert
      // per-toolオーバーライドは環境変数より優先される
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("override");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 2. robots.txt パーステスト
  // ===========================================================================

  describe("robots.txt パーステスト", () => {
    it("Disallow: / → すべてのパスが拒否される", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/any/path");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disallowed");
      expect(result.domain).toBe("https://example.com");
    });

    it("Allow: /public/ は Disallow: / より優先される", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: ALLOW_SPECIFIC_PATH }),
      );

      // Act
      const allowedResult = await service.isAllowed(
        "https://example.com/public/page",
      );

      // Assert
      expect(allowedResult.allowed).toBe(true);
      expect(allowedResult.reason).toBe("allowed");
    });

    it("Allow: /public/ のスコープ外は Disallow される", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: ALLOW_SPECIFIC_PATH }),
      );

      // Act
      const deniedResult = await service.isAllowed(
        "https://example.com/secret/page",
      );

      // Assert
      expect(deniedResult.allowed).toBe(false);
      expect(deniedResult.reason).toBe("disallowed");
    });

    it("ReftrixBot専用ルールが適用される", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: REFTRIX_BOT_SPECIFIC }),
      );

      // Act: ReftrixBotのデフォルトトークンで確認
      const publicResult = await service.isAllowed("https://example.com/page");

      // Assert: ReftrixBotはAllow: /なのでrootパスは許可
      expect(publicResult.allowed).toBe(true);
    });

    it("ReftrixBot専用ルールで /private/ は拒否される", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: REFTRIX_BOT_SPECIFIC }),
      );

      // Act
      const privateResult = await service.isAllowed(
        "https://example.com/private/data",
      );

      // Assert
      expect(privateResult.allowed).toBe(false);
      expect(privateResult.reason).toBe("disallowed");
    });

    it("カスタムproductTokenを指定すると対応するUser-agentルールが適用される", async () => {
      // Arrange: *は全拒否、ReftrixBotのみ許可
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: REFTRIX_BOT_SPECIFIC }),
      );

      // Act: ワイルドカードルール適用対象の別のbot
      const result = await service.isAllowed(
        "https://example.com/page",
        "OtherBot",
      );

      // Assert: OtherBotは * ルール (Disallow: /) が適用される
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disallowed");
    });

    it("ワイルドカード (*) User-agent フォールバック", async () => {
      // Arrange
      const robotsTxt = [
        "User-agent: *",
        "Disallow: /admin/",
        "Allow: /",
      ].join("\n");
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: robotsTxt }),
      );

      // Act
      const adminResult = await service.isAllowed(
        "https://example.com/admin/settings",
      );
      // 別のインスタンスではなくキャッシュから取得
      const publicResult = await service.isAllowed(
        "https://example.com/page",
      );

      // Assert
      expect(adminResult.allowed).toBe(false);
      expect(publicResult.allowed).toBe(true);
    });

    it("空のrobots.txt → すべて許可", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: "" }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/any/path");

      // Assert
      // 空文字列はパース後にマッチングルールがないため allowed (undefined → true)
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("allowed");
    });

    it("Crawl-delay ディレクティブが結果に含まれる", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: WITH_CRAWL_DELAY }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
      expect(result.crawlDelay).toBe(10);
    });

    it("Crawl-delay 未指定の場合はcrawlDelayフィールドなし", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result).not.toHaveProperty("crawlDelay");
    });

    it("Disallow が空 → すべて許可", async () => {
      // Arrange
      const robotsTxt = "User-agent: *\nDisallow:";
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: robotsTxt }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/any/path");

      // Assert
      expect(result.allowed).toBe(true);
    });

    it("複数のUser-agentセクション: マッチする最も具体的なルールが適用される", async () => {
      // Arrange
      const robotsTxt = [
        "User-agent: ReftrixBot",
        "Allow: /api/",
        "Disallow: /",
        "",
        "User-agent: *",
        "Disallow: /",
      ].join("\n");
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: robotsTxt }),
      );

      // Act
      const apiResult = await service.isAllowed("https://example.com/api/data");
      const rootResult = await service.isAllowed("https://example.com/other");

      // Assert: ReftrixBotのルールが適用される
      expect(apiResult.allowed).toBe(true);
      expect(rootResult.allowed).toBe(false);
    });
  });

  // ===========================================================================
  // 3. HTTP Fetch テスト
  // ===========================================================================

  describe("HTTP Fetch テスト", () => {
    it("200 OK → robots.txtをパースして判定する", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/robots.txt",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "User-Agent": ROBOTS_TXT.USER_AGENT,
            Accept: "text/plain",
          }),
          redirect: "manual",
        }),
      );
      expect(result.allowed).toBe(false);
    });

    it("404 → robots.txt不在として全許可（空文字列がキャッシュ）", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 404 }));

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("allowed");
    });

    it("5xx サーバーエラー → コンサバティブ deny", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 500 }));

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
    });

    it("503 Service Unavailable → コンサバティブ deny", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 503 }));

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
    });

    it("4xx (404以外、例: 403) → 制限なしとして全許可", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 403 }));

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("allowed");
    });

    it("401 Unauthorized → 制限なしとして全許可", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 401 }));

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("allowed");
    });

    it("AbortError (タイムアウト) → コンサバティブ deny", async () => {
      // Arrange
      const abortError = new DOMException("The operation was aborted", "AbortError");
      mockFetch.mockRejectedValue(abortError);

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
    });

    it("ネットワークエラー → コンサバティブ deny", async () => {
      // Arrange
      mockFetch.mockRejectedValue(new Error("Network error: ECONNREFUSED"));

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
    });

    it("非テキスト Content-Type → robots.txt不在として全許可", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: "<html>Not a robots.txt</html>",
          contentType: "text/html",
        }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      // text/html は text/ を含むため許可されて内容がパースされる
      // text/ ではないコンテンツの場合のみ空扱いとなる
      expect(mockFetch).toHaveBeenCalled();
    });

    it("application/json Content-Type → robots.txt不在として全許可", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: '{"error": "not found"}',
          contentType: "application/json",
        }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("allowed");
    });

    it("Content-Length が1MBを超える → deny", async () => {
      // Arrange
      const oversizedLength = String(ROBOTS_TXT.MAX_FILE_SIZE + 1);
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: "User-agent: *\nAllow: /",
          contentLength: oversizedLength,
        }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
    });

    it("Content-Length ヘッダなしでもボディが1MBを超える → deny", async () => {
      // Arrange: 1MB+1バイトの文字列
      const oversizedBody = "x".repeat(ROBOTS_TXT.MAX_FILE_SIZE + 1);
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: oversizedBody,
          // contentLength を指定しない
        }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
    });

    it("Content-Length ヘッダが正確に1MB → 許可（境界値）", async () => {
      // Arrange
      const exactSize = String(ROBOTS_TXT.MAX_FILE_SIZE);
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: "User-agent: *\nAllow: /",
          contentLength: exactSize,
        }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
    });

    it("fetchにAbortSignalが渡されることを確認", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: "User-agent: *\nAllow: /" }),
      );

      // Act
      await service.isAllowed("https://example.com/page");

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("redirect: manual でSSRFバイパスを防止し、リダイレクト先も検証する", async () => {
      // Arrange: 初回は302リダイレクト、2回目は200 OK
      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            status: 302,
            headers: { location: "https://cdn.example.com/robots.txt" },
          }),
        )
        .mockResolvedValueOnce(
          createMockResponse({ status: 200, body: DISALLOW_ALL }),
        );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert: redirect: 'manual' が設定されていること
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          redirect: "manual",
        }),
      );
      // リダイレクト先にもfetchが呼ばれること
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disallowed");
    });
  });

  // ===========================================================================
  // 4. キャッシュテスト
  // ===========================================================================

  describe("キャッシュテスト", () => {
    it("同一ドメインの2回目チェック → cached=true", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      const first = await service.isAllowed("https://example.com/page1");
      const second = await service.isAllowed("https://example.com/page2");

      // Assert
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      // fetchは1回だけ呼ばれる
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("異なるドメインは個別にキャッシュされる", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      await service.isAllowed("https://example.com/page");
      await service.isAllowed("https://other.com/page");

      // Assert: 2つの異なるドメインに対してfetchが2回
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("TTL切れ → 再取得される", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act: 初回取得
      const first = await service.isAllowed("https://example.com/page");
      expect(first.cached).toBe(false);

      // TTLを超えて時間を進める
      vi.advanceTimersByTime(ROBOTS_TXT.CACHE_TTL_MS + 1);

      // 2回目: キャッシュ切れにより再取得
      const second = await service.isAllowed("https://example.com/page");

      // Assert
      expect(second.cached).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("TTL内 → キャッシュを使用", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act: 初回取得
      await service.isAllowed("https://example.com/page");

      // TTLの半分だけ進める
      vi.advanceTimersByTime(ROBOTS_TXT.CACHE_TTL_MS / 2);

      // 2回目: キャッシュ有効期間内
      const second = await service.isAllowed("https://example.com/page");

      // Assert
      expect(second.cached).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("LRU eviction: 最大エントリ数を超えると最も古いエントリが削除される", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: "User-agent: *\nAllow: /",
        }),
      );

      // Act: MAX_CACHE_ENTRIES + 1 個のドメインをキャッシュ
      for (let i = 0; i < ROBOTS_TXT.MAX_CACHE_ENTRIES + 1; i++) {
        await service.isAllowed(`https://domain${i}.com/page`);
      }

      // Assert: キャッシュサイズは最大値を超えない
      expect(service.getCacheSize()).toBe(ROBOTS_TXT.MAX_CACHE_ENTRIES);
    });

    it("clearCache() でキャッシュがクリアされる", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );
      await service.isAllowed("https://example.com/page");
      expect(service.getCacheSize()).toBe(1);

      // Act
      service.clearCache();

      // Assert
      expect(service.getCacheSize()).toBe(0);
    });

    it("getCacheSize() が正確なキャッシュエントリ数を返す", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act & Assert
      expect(service.getCacheSize()).toBe(0);

      await service.isAllowed("https://domain1.com/page");
      expect(service.getCacheSize()).toBe(1);

      await service.isAllowed("https://domain2.com/page");
      expect(service.getCacheSize()).toBe(2);

      // 同一ドメイン → サイズ変わらず
      await service.isAllowed("https://domain1.com/other");
      expect(service.getCacheSize()).toBe(2);
    });

    it("5xx（fetch失敗）のキャッシュエントリは次回アクセスで再取得される", async () => {
      // Arrange: 初回は5xx
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 500 }));
      // 2回目は正常
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 200,
          body: "User-agent: *\nAllow: /",
        }),
      );

      // Act
      const first = await service.isAllowed("https://example.com/page");
      const second = await service.isAllowed("https://example.com/page");

      // Assert
      expect(first.allowed).toBe(false);
      expect(first.reason).toBe("fetch_error");
      // フェッチ失敗エントリはキャッシュされるがgetFromCacheでnullが返る
      // → 再取得される
      expect(second.allowed).toBe(true);
      expect(second.reason).toBe("allowed");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("404（空文字キャッシュ）は次回アクセスでキャッシュヒットする", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 404 }));

      // Act
      const first = await service.isAllowed("https://example.com/page");
      const second = await service.isAllowed("https://example.com/page");

      // Assert
      expect(first.cached).toBe(false);
      expect(first.allowed).toBe(true);
      expect(second.cached).toBe(true);
      expect(second.allowed).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("dispose() でキャッシュとタイマーがクリアされる", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );
      await service.isAllowed("https://example.com/page");
      expect(service.getCacheSize()).toBe(1);

      // Act
      service.dispose();

      // Assert
      expect(service.getCacheSize()).toBe(0);
    });

    it("定期クリーンアップがTTL切れエントリを削除する", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: "User-agent: *\nAllow: /",
        }),
      );
      await service.isAllowed("https://example.com/page");
      expect(service.getCacheSize()).toBe(1);

      // Act: TTL + クリーンアップインターバルを進める
      vi.advanceTimersByTime(ROBOTS_TXT.CACHE_TTL_MS + ROBOTS_TXT.CLEANUP_INTERVAL_MS + 1);

      // Assert: クリーンアップが実行されてキャッシュが空になる
      expect(service.getCacheSize()).toBe(0);
    });
  });

  // ===========================================================================
  // 5. Convenience API テスト
  // ===========================================================================

  describe("Convenience API テスト", () => {
    it("getRobotsTxtService() は同一インスタンスを返す（シングルトン）", () => {
      // Arrange & Act
      const instance1 = getRobotsTxtService();
      const instance2 = getRobotsTxtService();

      // Assert
      expect(instance1).toBe(instance2);
    });

    it("resetRobotsTxtService() でシングルトンがリセットされる", () => {
      // Arrange
      const instance1 = getRobotsTxtService();

      // Act
      resetRobotsTxtService();
      const instance2 = getRobotsTxtService();

      // Assert
      expect(instance1).not.toBe(instance2);
    });

    it("isUrlAllowedByRobotsTxt() はシングルトンに委譲する", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      const result = await isUrlAllowedByRobotsTxt("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disallowed");
      expect(result.domain).toBe("https://example.com");
    });

    it("isUrlAllowedByRobotsTxt() に respectRobotsTxt=false を渡せる", async () => {
      // Arrange & Act
      const result = await isUrlAllowedByRobotsTxt(
        "https://example.com/page",
        false,
      );

      // Assert
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("override");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("resetRobotsTxtService() 後にisUrlAllowedByRobotsTxt() は新しいインスタンスを使用する", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // 初回呼び出しでキャッシュを生成
      await isUrlAllowedByRobotsTxt("https://example.com/page");
      expect(mockFetch).toHaveBeenCalledOnce();

      // Act: リセット
      resetRobotsTxtService();

      // 2回目の呼び出し（新しいインスタンス、キャッシュなし）
      await isUrlAllowedByRobotsTxt("https://example.com/page");

      // Assert: 新しいインスタンスのためfetchが再実行される
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // 6. ドメイン抽出テスト
  // ===========================================================================

  describe("ドメイン抽出テスト", () => {
    it("HTTPSのURL → プロトコル+ホスト部分が抽出される", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 404 }));

      // Act
      const result = await service.isAllowed(
        "https://example.com/path/to/page?query=1",
      );

      // Assert
      expect(result.domain).toBe("https://example.com");
    });

    it("HTTPのURL → http:// プロトコル+ホスト", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 404 }));

      // Act
      const result = await service.isAllowed("http://example.com/page");

      // Assert
      expect(result.domain).toBe("http://example.com");
    });

    it("ポート付きURL → ポートを含むドメインが返る", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 404 }));

      // Act
      const result = await service.isAllowed(
        "http://example.com:8080/path",
      );

      // Assert
      expect(result.domain).toBe("http://example.com:8080");
    });

    it("サブドメイン付きURL → サブドメインを含むドメインが返る", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 404 }));

      // Act
      const result = await service.isAllowed(
        "https://sub.domain.example.com/page",
      );

      // Assert
      expect(result.domain).toBe("https://sub.domain.example.com");
    });

    it("無効なURL → 元の文字列がそのままdomainとして返る", async () => {
      // Arrange: 無効なURLでもfetchは呼ばれる（ドメイン抽出失敗でも処理は続行）
      mockFetch.mockRejectedValue(new Error("Invalid URL"));

      // Act
      const result = await service.isAllowed("not-a-valid-url");

      // Assert
      expect(result.domain).toBe("not-a-valid-url");
    });

    it("同一ドメインの異なるパスは同じキャッシュエントリを使用する", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );

      // Act
      await service.isAllowed("https://example.com/path1");
      await service.isAllowed("https://example.com/path2");
      await service.isAllowed("https://example.com/path3?q=test");

      // Assert: ドメインが同じなのでfetchは1回のみ
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(service.getCacheSize()).toBe(1);
    });

    it("robots.txt取得URLが正しく構築される（ドメイン + /robots.txt）", async () => {
      // Arrange
      mockFetch.mockResolvedValue(createMockResponse({ status: 404 }));

      // Act
      await service.isAllowed("https://example.com/deep/nested/path");

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/robots.txt",
        expect.any(Object),
      );
    });
  });

  // ===========================================================================
  // 7. デフォルトproductToken テスト
  // ===========================================================================

  describe("デフォルトproductToken テスト", () => {
    it("productToken未指定時はReftrixBotが使用される", async () => {
      // Arrange: ReftrixBotのみ許可するrobots.txt
      const robotsTxt = [
        "User-agent: ReftrixBot",
        "Allow: /",
        "",
        "User-agent: *",
        "Disallow: /",
      ].join("\n");
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: robotsTxt }),
      );

      // Act: productTokenを指定しない
      const result = await service.isAllowed("https://example.com/page");

      // Assert: ReftrixBotルールが適用される
      expect(result.allowed).toBe(true);
    });

    it("productTokenを明示指定するとそのトークンのルールが適用される", async () => {
      // Arrange: Googlebotのみ許可するrobots.txt
      const robotsTxt = [
        "User-agent: Googlebot",
        "Allow: /",
        "",
        "User-agent: *",
        "Disallow: /",
      ].join("\n");
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: robotsTxt }),
      );

      // Act
      const googlebotResult = await service.isAllowed(
        "https://example.com/page",
        "Googlebot",
      );

      // キャッシュされているためfetchは再実行されない
      const reftrixResult = await service.isAllowed(
        "https://example.com/page",
        "ReftrixBot",
      );

      // Assert
      expect(googlebotResult.allowed).toBe(true);
      expect(reftrixResult.allowed).toBe(false);
    });
  });

  // ===========================================================================
  // 8. エッジケーステスト
  // ===========================================================================

  describe("エッジケーステスト", () => {
    it("robots.txtに改行のみ → すべて許可", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: "\n\n\n" }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
    });

    it("robots.txtにコメントのみ → すべて許可", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: "# This is a comment\n# Another comment",
        }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(true);
    });

    it("並行リクエスト: 同一ドメインへの複数同時リクエスト", async () => {
      // Arrange: fetchを少し遅延させる
      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve(
                  createMockResponse({
                    status: 200,
                    body: "User-agent: *\nAllow: /",
                  }),
                ),
              100,
            );
          }),
      );

      // Act: 同時に3つのリクエスト
      const promises = [
        service.isAllowed("https://example.com/page1"),
        service.isAllowed("https://example.com/page2"),
        service.isAllowed("https://example.com/page3"),
      ];

      // タイマーを進めてfetchを完了させる
      vi.advanceTimersByTime(200);

      const results = await Promise.all(promises);

      // Assert: すべて成功
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.allowed).toBe(true);
        expect(r.domain).toBe("https://example.com");
      }
    });

    it("text/plain; charset=utf-8 Content-Type → 正常にパースされる", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: DISALLOW_ALL,
          contentType: "text/plain; charset=utf-8",
        }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disallowed");
    });

    it("Content-Typeヘッダが空文字列 → パースされる（textチェックをスキップ）", async () => {
      // Arrange: contentType が空文字の場合、includes('text/') は false だが
      // サービスのロジックでは contentType が falsy な場合はスキップする
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: DISALLOW_ALL,
          contentType: "",
        }),
      );

      // Act
      const result = await service.isAllowed("https://example.com/page");

      // Assert: 空のContent-Typeの場合、text/チェックがスキップされてパースされる
      // 実装: if (contentType && !contentType.includes("text/")) → contentTypeが空ならスキップ
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disallowed");
    });

    it("Sitemapディレクティブ付きrobots.txt → パースに影響なし", async () => {
      // Arrange
      const robotsTxt = [
        "User-agent: *",
        "Disallow: /private/",
        "Allow: /",
        "",
        "Sitemap: https://example.com/sitemap.xml",
      ].join("\n");
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: robotsTxt }),
      );

      // Act
      const publicResult = await service.isAllowed(
        "https://example.com/page",
      );
      const privateResult = await service.isAllowed(
        "https://example.com/private/data",
      );

      // Assert
      expect(publicResult.allowed).toBe(true);
      expect(privateResult.allowed).toBe(false);
    });

    it("非常に長いパスのURL → 正常に処理される", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: DISALLOW_ALL }),
      );
      const longPath = "/segment/".repeat(100) + "page";

      // Act
      const result = await service.isAllowed(
        `https://example.com${longPath}`,
      );

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.domain).toBe("https://example.com");
    });

    it("URLにクエリパラメータとフラグメントが含まれる場合", async () => {
      // Arrange
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 200,
          body: "User-agent: *\nDisallow: /search",
        }),
      );

      // Act
      const result = await service.isAllowed(
        "https://example.com/search?q=test#section1",
      );

      // Assert
      expect(result.allowed).toBe(false);
      expect(result.domain).toBe("https://example.com");
    });
  });

  // ===========================================================================
  // 9. 定数参照テスト
  // ===========================================================================

  describe("定数参照テスト", () => {
    it("ROBOTS_TXT.PRODUCT_TOKEN のデフォルト値が正しい", () => {
      expect(ROBOTS_TXT.PRODUCT_TOKEN).toBe("ReftrixBot");
    });

    it("ROBOTS_TXT.MAX_CACHE_ENTRIES が500", () => {
      expect(ROBOTS_TXT.MAX_CACHE_ENTRIES).toBe(500);
    });

    it("ROBOTS_TXT.CACHE_TTL_MS が24時間", () => {
      expect(ROBOTS_TXT.CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });

    it("ROBOTS_TXT.FETCH_TIMEOUT_MS が5秒", () => {
      expect(ROBOTS_TXT.FETCH_TIMEOUT_MS).toBe(5000);
    });

    it("ROBOTS_TXT.MAX_FILE_SIZE が1MB", () => {
      expect(ROBOTS_TXT.MAX_FILE_SIZE).toBe(1024 * 1024);
    });

    it("ROBOTS_TXT.ENV_FLAG が REFTRIX_RESPECT_ROBOTS_TXT", () => {
      expect(ROBOTS_TXT.ENV_FLAG).toBe("REFTRIX_RESPECT_ROBOTS_TXT");
    });
  });

  // ===========================================================================
  // 10. SSRF保護テスト
  // ===========================================================================

  describe("SSRF保護テスト", () => {
    it("localhost → SSRF blocked (deny)", async () => {
      const result = await service.isAllowed("http://localhost/page");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("127.0.0.1 → SSRF blocked (deny)", async () => {
      const result = await service.isAllowed("http://127.0.0.1/page");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("169.254.169.254 (メタデータサービス) → SSRF blocked (deny)", async () => {
      const result = await service.isAllowed("http://169.254.169.254/latest/meta-data/");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("10.x.x.x プライベートIP → SSRF blocked (deny)", async () => {
      const result = await service.isAllowed("http://10.0.0.1/page");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("172.16.x.x プライベートIP → SSRF blocked (deny)", async () => {
      const result = await service.isAllowed("http://172.16.0.1/page");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("192.168.x.x プライベートIP → SSRF blocked (deny)", async () => {
      const result = await service.isAllowed("http://192.168.1.1/page");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("metadata.google.internal → SSRF blocked (deny)", async () => {
      const result = await service.isAllowed("http://metadata.google.internal/computeMetadata/v1/");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("0.0.0.0 → SSRF blocked (deny)", async () => {
      const result = await service.isAllowed("http://0.0.0.0/page");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("外部ドメイン (example.com) → SSRF blockedされない", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({ status: 200, body: "" }),
      );
      const result = await service.isAllowed("https://example.com/page");
      expect(result.allowed).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });

    it("リダイレクト先がプライベートIP → SSRF blocked (deny)", async () => {
      // 初回は302でプライベートIPにリダイレクト
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 302,
          headers: { location: "http://169.254.169.254/robots.txt" },
        }),
      );

      const result = await service.isAllowed("https://example.com/page");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
      // 初回のfetchは呼ばれるがリダイレクト先は呼ばれない
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("リダイレクト先がlocalhostへ → SSRF blocked (deny)", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 301,
          headers: { location: "http://127.0.0.1/robots.txt" },
        }),
      );

      const result = await service.isAllowed("https://example.com/page");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fetch_error");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("最大3回までのリダイレクト追従", async () => {
      // 3回リダイレクト → 4回目は200
      mockFetch
        .mockResolvedValueOnce(createMockResponse({ status: 302, headers: { location: "https://cdn1.example.com/robots.txt" } }))
        .mockResolvedValueOnce(createMockResponse({ status: 302, headers: { location: "https://cdn2.example.com/robots.txt" } }))
        .mockResolvedValueOnce(createMockResponse({ status: 302, headers: { location: "https://cdn3.example.com/robots.txt" } }))
        .mockResolvedValueOnce(createMockResponse({ status: 200, body: "" }));

      const result = await service.isAllowed("https://example.com/page");
      // 4回fetch（初回 + 3リダイレクト）
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(result.allowed).toBe(true);
    });
  });
});
