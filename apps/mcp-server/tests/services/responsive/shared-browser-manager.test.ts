// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Browser Manager Tests
 *
 * SharedBrowserManager のユニットテスト
 * ブラウザライフサイクル管理の共通ロジックを検証する
 *
 * @module tests/services/responsive/shared-browser-manager.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Playwright のモック
vi.mock('playwright', () => {
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

import { chromium, type Browser } from 'playwright';
import {
  SharedBrowserManager,
  USER_AGENTS,
} from '../../../src/services/responsive/shared-browser-manager';

describe('SharedBrowserManager', () => {
  let manager: SharedBrowserManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SharedBrowserManager('TestService');
  });

  afterEach(async () => {
    await manager.close();
  });

  // ==========================================================================
  // getBrowser
  // ==========================================================================

  describe('getBrowser', () => {
    it('初回呼び出しでchromium.launch()が実行される', async () => {
      const browser = await manager.getBrowser();

      expect(chromium.launch).toHaveBeenCalledTimes(1);
      expect(chromium.launch).toHaveBeenCalledWith({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      expect(browser).toBeDefined();
    });

    it('2回目の呼び出しではchromium.launch()が再実行されない（シングルトン）', async () => {
      const browser1 = await manager.getBrowser();
      const browser2 = await manager.getBrowser();

      expect(chromium.launch).toHaveBeenCalledTimes(1);
      expect(browser1).toBe(browser2);
    });
  });

  // ==========================================================================
  // resolveOrLaunch
  // ==========================================================================

  describe('resolveOrLaunch', () => {
    it('sharedBrowserが指定されていればそれを使用する', async () => {
      const mockShared = { close: vi.fn() } as unknown as Browser;
      const browser = await manager.resolveOrLaunch(mockShared);

      expect(browser).toBe(mockShared);
      expect(chromium.launch).not.toHaveBeenCalled();
      expect(manager.isUsingSharedBrowser).toBe(true);
    });

    it('sharedBrowserがundefinedならgetBrowser()を使用する', async () => {
      const browser = await manager.resolveOrLaunch(undefined);

      expect(browser).toBeDefined();
      expect(chromium.launch).toHaveBeenCalledTimes(1);
      expect(manager.isUsingSharedBrowser).toBe(false);
    });
  });

  // ==========================================================================
  // close
  // ==========================================================================

  describe('close', () => {
    it('自前で起動したブラウザはclose()で閉じる', async () => {
      const browser = await manager.getBrowser();
      await manager.close();

      expect(browser.close).toHaveBeenCalledTimes(1);
    });

    it('共有ブラウザの場合はclose()で閉じない', async () => {
      const mockShared = { close: vi.fn() } as unknown as Browser;
      await manager.resolveOrLaunch(mockShared);
      await manager.close();

      expect(mockShared.close).not.toHaveBeenCalled();
    });

    it('ブラウザ未起動時のclose()はエラーにならない', async () => {
      await expect(manager.close()).resolves.not.toThrow();
    });

    it('close()後にgetBrowser()で再起動できる', async () => {
      await manager.getBrowser();
      await manager.close();
      await manager.getBrowser();

      expect(chromium.launch).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // USER_AGENTS
  // ==========================================================================

  describe('USER_AGENTS 定数', () => {
    it('MOBILE が iPhone のUserAgent文字列を含む', () => {
      expect(USER_AGENTS.MOBILE).toContain('iPhone');
      expect(USER_AGENTS.MOBILE).toContain('Mobile');
    });

    it('DESKTOP が Windows NT のUserAgent文字列を含む', () => {
      expect(USER_AGENTS.DESKTOP).toContain('Windows NT');
      expect(USER_AGENTS.DESKTOP).toContain('Chrome');
    });

    it('getUserAgent() が viewport name に応じた正しいUA文字列を返す', () => {
      expect(SharedBrowserManager.getUserAgent('mobile')).toBe(USER_AGENTS.MOBILE);
      expect(SharedBrowserManager.getUserAgent('desktop')).toBe(USER_AGENTS.DESKTOP);
      expect(SharedBrowserManager.getUserAgent('tablet')).toBe(USER_AGENTS.DESKTOP);
      expect(SharedBrowserManager.getUserAgent('unknown')).toBe(USER_AGENTS.DESKTOP);
    });
  });
});
