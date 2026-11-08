// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Browser Manager Tests
 *
 * SharedBrowserManager のユニットテスト
 * ブラウザライフサイクル管理の共通ロジックを検証する
 *
 * @module tests/services/responsive/shared-browser-manager.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Playwright のモック
vi.mock("playwright", () => {
  const mockPage = {
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(mockBrowser),
    },
  };
});

import { chromium, type Browser } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROBOTS_TXT, REFTRIXBOT_INFO_URL } from "@reftrixmcp/core";
import { SharedBrowserManager } from "../../../src/services/responsive/shared-browser-manager";

describe("SharedBrowserManager", () => {
  let manager: SharedBrowserManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SharedBrowserManager("TestService");
  });

  afterEach(async () => {
    await manager.close();
  });

  // ==========================================================================
  // getBrowser
  // ==========================================================================

  describe("getBrowser", () => {
    it("初回呼び出しでchromium.launch()が実行される", async () => {
      const browser = await manager.getBrowser();

      expect(chromium.launch).toHaveBeenCalledTimes(1);
      // launchChromium が送信先検査プロキシを付けて起動する (INV-SEC-SSRF-EGRESS-GUARD-001)
      // launchChromium adds the egress guard proxy
      expect(chromium.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          headless: true,
          args: expect.arrayContaining(["--no-sandbox", "--disable-setuid-sandbox"]),
          proxy: expect.objectContaining({ bypass: "<-loopback>" }),
        })
      );
      expect(browser).toBeDefined();
    });

    it("2回目の呼び出しではchromium.launch()が再実行されない（シングルトン）", async () => {
      const browser1 = await manager.getBrowser();
      const browser2 = await manager.getBrowser();

      expect(chromium.launch).toHaveBeenCalledTimes(1);
      expect(browser1).toBe(browser2);
    });
  });

  // ==========================================================================
  // resolveOrLaunch
  // ==========================================================================

  describe("resolveOrLaunch", () => {
    it("sharedBrowserが指定されていればそれを使用する", async () => {
      const mockShared = { close: vi.fn() } as unknown as Browser;
      const browser = await manager.resolveOrLaunch(mockShared);

      expect(browser).toBe(mockShared);
      expect(chromium.launch).not.toHaveBeenCalled();
      expect(manager.isUsingSharedBrowser).toBe(true);
    });

    it("sharedBrowserがundefinedならgetBrowser()を使用する", async () => {
      const browser = await manager.resolveOrLaunch(undefined);

      expect(browser).toBeDefined();
      expect(chromium.launch).toHaveBeenCalledTimes(1);
      expect(manager.isUsingSharedBrowser).toBe(false);
    });
  });

  // ==========================================================================
  // close
  // ==========================================================================

  describe("close", () => {
    it("自前で起動したブラウザはclose()で閉じる", async () => {
      const browser = await manager.getBrowser();
      await manager.close();

      expect(browser.close).toHaveBeenCalledTimes(1);
    });

    it("共有ブラウザの場合はclose()で閉じない", async () => {
      const mockShared = { close: vi.fn() } as unknown as Browser;
      await manager.resolveOrLaunch(mockShared);
      await manager.close();

      expect(mockShared.close).not.toHaveBeenCalled();
    });

    it("ブラウザ未起動時のclose()はエラーにならない", async () => {
      await expect(manager.close()).resolves.not.toThrow();
    });

    it("close()後にgetBrowser()で再起動できる", async () => {
      await manager.getBrowser();
      await manager.close();
      await manager.getBrowser();

      expect(chromium.launch).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // getUserAgent (CAP-L-02, INV-CRAWLER-UA-IDENTITY-001)
  // ==========================================================================

  describe("getUserAgent()", () => {
    const browser = { version: (): string => "156.0.7499.4" };
    const bot = `(compatible; ${ROBOTS_TXT.PRODUCT_TOKEN}/1.0; +${REFTRIXBOT_INFO_URL})`;

    it("INV-CRAWLER-UA-IDENTITY-001: mobile uses Chrome on Android with the running browser's version and the Mobile token", () => {
      const ua = SharedBrowserManager.getUserAgent("mobile", browser);
      expect(ua).toContain("(Linux; Android 10; K)");
      expect(ua).toContain("Chrome/156.0.7499.4 Mobile Safari/537.36");
      expect(ua.endsWith(bot)).toBe(true);
    });

    it("INV-CRAWLER-UA-IDENTITY-001: desktop, tablet and unknown names use the desktop form with the running browser's version", () => {
      for (const name of ["desktop", "tablet", "unknown"]) {
        const ua = SharedBrowserManager.getUserAgent(name, browser);
        expect(ua).toContain("Chrome/156.0.7499.4 Safari/537.36");
        expect(ua).not.toContain("Mobile");
        expect(ua.endsWith(bot)).toBe(true);
      }
    });

    it("INV-CRAWLER-UA-IDENTITY-001: no fixed browser versions and no other browser are claimed", () => {
      for (const name of ["mobile", "desktop"]) {
        const ua = SharedBrowserManager.getUserAgent(name, browser);
        expect(ua).not.toMatch(/Chrome\/120\.|iPhone|Version\/16|Windows NT/);
      }
    });

    it("INV-CRAWLER-UA-IDENTITY-001: getContextOptions adds isMobile/hasTouch only for mobile so the Client Hints agree with the UA", () => {
      const mobile = SharedBrowserManager.getContextOptions(
        { name: "mobile", width: 375, height: 812 },
        browser
      );
      expect(mobile).toEqual({
        viewport: { width: 375, height: 812 },
        userAgent: SharedBrowserManager.getUserAgent("mobile", browser),
        isMobile: true,
        hasTouch: true,
      });
      for (const name of ["desktop", "tablet"]) {
        expect(
          SharedBrowserManager.getContextOptions({ name, width: 1024, height: 768 }, browser)
        ).toEqual({
          viewport: { width: 1024, height: 768 },
          userAgent: SharedBrowserManager.getUserAgent(name, browser),
        });
      }
    });

    it("INV-CRAWLER-UA-IDENTITY-001: all three responsive services build their contexts with getContextOptions(viewport, browser)", () => {
      const dir = path.resolve(__dirname, "../../../src/services/responsive");
      for (const f of [
        "multi-device-capture.service.ts",
        "multi-viewport-capture.service.ts",
        "responsive-quality-evaluator.service.ts",
      ]) {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        expect(text, f).toContain("SharedBrowserManager.getContextOptions(viewport, browser)");
      }
    });

    it("INV-CRAWLER-UA-IDENTITY-001: an unreadable browser version falls back to the plain bot UA", () => {
      const broken = { version: (): string => "" };
      expect(SharedBrowserManager.getUserAgent("mobile", broken)).toBe(ROBOTS_TXT.USER_AGENT);
      expect(SharedBrowserManager.getUserAgent("desktop", broken)).toBe(ROBOTS_TXT.USER_AGENT);
    });
  });
});
