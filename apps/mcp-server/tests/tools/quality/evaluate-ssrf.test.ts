// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.evaluate SSRF対策テスト
 * responsive_evaluation.url パラメータのSSRF攻撃パターンをブロックすることを検証
 *
 * quality.evaluate SSRF prevention tests
 * Validates that SSRF attack patterns in responsive_evaluation.url are blocked
 *
 * @module tests/tools/quality/evaluate-ssrf.test
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// モジュールモック（evaluate-engine.ts 内部で使用される依存）
// Module mocks (dependencies used inside evaluate-engine.ts)
vi.mock("../../../src/utils/url-validator", () => ({
  validateExternalUrl: vi.fn(),
}));

vi.mock("@reftrix/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@reftrix/core")>();
  return {
    ...actual,
    isUrlAllowedByRobotsTxt: vi.fn(),
  };
});

import {
  evaluateCraftsmanshipWithAxe,
  type CraftsmanshipOptions,
} from "../../../src/tools/quality/evaluate-engine";

import { validateExternalUrl } from "../../../src/utils/url-validator";

import type { AxeAccessibilityService } from "../../../src/services/quality/axe-accessibility.service";

// =====================================================
// テストデータ / Test Data
// =====================================================

const minimalValidHtml = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>Test</title></head>
<body><main><h1>テスト</h1><p>コンテンツ</p></main></body>
</html>`;

/**
 * 最小限のAxeAccessibilityServiceモック
 * Minimal AxeAccessibilityService mock
 */
function createMockAxeService(): AxeAccessibilityService {
  return {
    analyze: vi.fn().mockResolvedValue({
      violations: [],
      passes: [],
      incomplete: [],
      inapplicable: [],
      testEngine: { name: "mock", version: "0.0.0" },
      testRunner: { name: "mock" },
      testEnvironment: { userAgent: "mock", windowWidth: 1920, windowHeight: 1080 },
      timestamp: new Date().toISOString(),
      url: "about:blank",
      toolOptions: {},
    }),
  } as unknown as AxeAccessibilityService;
}

// =====================================================
// テスト / Tests
// =====================================================

describe("quality.evaluate SSRF対策 / SSRF Prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * SSRFテストヘルパー: responsive_evaluation.url に攻撃パターンを設定し、
   * evaluateCraftsmanshipWithAxe がブロックすることを検証
   *
   * SSRF test helper: Sets attack pattern in responsive_evaluation.url and verifies
   * evaluateCraftsmanshipWithAxe blocks it
   */
  async function expectSsrfBlocked(url: string, errorMessage: string): Promise<void> {
    (validateExternalUrl as Mock).mockReturnValue({
      valid: false,
      error: errorMessage,
    });

    const options: CraftsmanshipOptions = {
      responsive_evaluation: {
        enabled: true,
        url,
        timeout: 30000,
      },
    };

    const result = await evaluateCraftsmanshipWithAxe(minimalValidHtml, options, {
      axeService: createMockAxeService(),
      playwrightAxeService: null,
    });

    // SSRF URL で validateExternalUrl が呼ばれたことを確認
    expect(validateExternalUrl).toHaveBeenCalledWith(url);

    // 評価自体は成功する（responsive evaluation がスキップされるだけ）
    expect(result.score).toBeGreaterThanOrEqual(0);

    // レスポンシブ評価結果は undefined（スキップ）
    expect(result.responsiveResult).toBeUndefined();

    // details にスキップメッセージが含まれる
    expect(result.details.some((d: string) => d.includes("レスポンシブ評価スキップ"))).toBe(true);
  }

  it("localhost をブロックする / blocks localhost", async () => {
    await expectSsrfBlocked("https://localhost:3000", "URL is blocked: localhost is not allowed");
  });

  it("127.0.0.1 (ループバック) をブロックする / blocks 127.0.0.1 loopback", async () => {
    await expectSsrfBlocked(
      "http://127.0.0.1:8080/admin",
      "URL is blocked: 127.0.0.1 is not allowed"
    );
  });

  it("AWS メタデータサービス (169.254.169.254) をブロックする / blocks metadata service", async () => {
    await expectSsrfBlocked(
      "http://169.254.169.254/latest/meta-data/",
      "URL is blocked: metadata service is not allowed"
    );
  });

  it("プライベートIP (10.x, 172.16.x, 192.168.x) をブロックする / blocks private IPs", async () => {
    const privateUrls = [
      { url: "http://10.0.0.1/internal", error: "URL is blocked: private IP 10.0.0.1" },
      { url: "http://172.16.0.1/api", error: "URL is blocked: private IP 172.16.0.1" },
      { url: "http://192.168.1.1/admin", error: "URL is blocked: private IP 192.168.1.1" },
    ];

    for (const { url, error } of privateUrls) {
      vi.clearAllMocks();
      await expectSsrfBlocked(url, error);
    }
  });

  it("IPv6 ループバック (::1) をブロックする / blocks IPv6 loopback", async () => {
    await expectSsrfBlocked("http://[::1]:8080/", "URL is blocked: IPv6 loopback is not allowed");
  });

  it("無効なプロトコル (file://) をブロックする / blocks invalid protocol", async () => {
    await expectSsrfBlocked(
      "file:///etc/passwd",
      "Invalid protocol: only http and https are allowed"
    );
  });

  it("responsive_evaluation が無効の場合は SSRF チェックをスキップする / skips SSRF check when disabled", async () => {
    const options: CraftsmanshipOptions = {
      responsive_evaluation: {
        enabled: false,
        url: "http://127.0.0.1",
        timeout: 30000,
      },
    };

    const result = await evaluateCraftsmanshipWithAxe(minimalValidHtml, options, {
      axeService: createMockAxeService(),
      playwrightAxeService: null,
    });

    // enabled: false なので validateExternalUrl は呼ばれない
    expect(validateExternalUrl).not.toHaveBeenCalled();
    expect(result.responsiveResult).toBeUndefined();
  });

  it("responsive_evaluation.url が未指定の場合は SSRF チェックをスキップする / skips when url is undefined", async () => {
    const options: CraftsmanshipOptions = {
      responsive_evaluation: {
        enabled: true,
        timeout: 30000,
      },
    };

    const result = await evaluateCraftsmanshipWithAxe(minimalValidHtml, options, {
      axeService: createMockAxeService(),
      playwrightAxeService: null,
    });

    // url 未指定なので validateExternalUrl は呼ばれない
    expect(validateExternalUrl).not.toHaveBeenCalled();
    expect(result.responsiveResult).toBeUndefined();
  });
});
