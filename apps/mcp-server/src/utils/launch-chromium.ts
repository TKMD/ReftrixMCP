// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Chromium launch wrapper (the only Playwright launch site in src)
 * Chromium 起動 wrapper (src で Playwright の launch を呼ぶ唯一の箇所)
 *
 * Chromium 未導入で `chromium.launch()` が reject すると、エラー本文に内部 path
 * (`~/.cache/ms-playwright/...`) と Call log が含まれる。呼び出し元ごとに catch すると
 * 取りこぼすため、起動点で型付きエラー (固定文言のみ) に変換する (CWE-209)。
 * それ以外のエラーは変更せず再 throw する。
 * 静的な不変条件: INV-SEC-BROWSER-LAUNCH-WRAPPER-002。
 *
 * 全ブラウザを送信先検査プロキシ (utils/egress-guard-proxy) 経由で起動する。リダイレクト先や
 * サブリソースを含む全リクエストの宛先 IP がプロキシで検査される (SSRF、
 * INV-SEC-SSRF-EGRESS-GUARD-001)。呼び出し元が proxy を指定することは許さない。
 *
 * A missing Chromium makes `chromium.launch()` reject with an error body that includes
 * internal paths and a call log. Catching per caller misses sites, so the launch point
 * converts it into a typed error carrying only the fixed message (CWE-209). Any other
 * error is rethrown unchanged.
 *
 * Every browser is started behind the egress guard proxy (utils/egress-guard-proxy), so
 * the destination IP of every request, including redirect hops and subresources, is
 * checked (SSRF, INV-SEC-SSRF-EGRESS-GUARD-001). Callers may not set a proxy.
 *
 * @module utils/launch-chromium
 */

import type { Browser, LaunchOptions } from "playwright";
import { BrowserNotInstalledError, isBrowserMissingError } from "./browser-missing";
import { getEgressGuardProxyServer } from "./egress-guard-proxy";
import { logger } from "./logger";

export { BrowserNotInstalledError };

/**
 * WebRTC の UDP はプロキシを通らないため、プロキシ外の UDP を禁止する。
 * WebRTC UDP bypasses the proxy, so non-proxied UDP is disabled.
 */
const EGRESS_GUARD_ARGS = ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] as const;

/**
 * ガードを上書きできる Chromium 引数 (呼び出し元の args は Playwright の proxy 引数より後ろに並び、後勝ち)。
 * Chromium switches that could override the guard (caller args come after Playwright's proxy
 * switches and win).
 */
export const GUARD_OVERRIDE_ARG =
  /^--(no-proxy-server|proxy-|host-resolver-rules|host-rules|force-webrtc-ip-handling-policy|webrtc-ip-handling-policy)/;

/**
 * 検査プロキシを強制した起動オプションを作る / Build launch options that force the guard proxy.
 * `bypass: "<-loopback>"` で loopback も必ずプロキシを通す (Playwright の env による無効化も効かない)。
 * `bypass: "<-loopback>"` sends loopback through the proxy too, regardless of Playwright's env opt-out.
 */
export async function buildGuardedLaunchOptions(options?: LaunchOptions): Promise<LaunchOptions> {
  if (options?.proxy !== undefined) {
    throw new Error("launchChromium: callers must not set a proxy (the egress guard owns it)");
  }
  if (options?.ignoreDefaultArgs !== undefined && options.ignoreDefaultArgs !== false) {
    // true / 配列はプロキシ引数を消せる / true or a list can drop the proxy switches
    throw new Error(
      "launchChromium: ignoreDefaultArgs is not allowed (the egress guard needs them)"
    );
  }
  const overriding = (options?.args ?? []).find((arg) => GUARD_OVERRIDE_ARG.test(arg));
  if (overriding !== undefined) {
    throw new Error(
      "launchChromium: args may not override the proxy, host resolver or WebRTC policy"
    );
  }
  const server = await getEgressGuardProxyServer();
  return {
    ...options,
    args: [...(options?.args ?? []), ...EGRESS_GUARD_ARGS],
    proxy: { server, bypass: "<-loopback>" },
  };
}

/**
 * Launch Chromium. On a browser-missing failure, throws BrowserNotInstalledError
 * (fixed message, no raw Playwright text); other errors pass through unchanged.
 */
export async function launchChromium(options?: LaunchOptions): Promise<Browser> {
  const guarded = await buildGuardedLaunchOptions(options);
  const { chromium } = await import("playwright");
  try {
    return await chromium.launch(guarded);
  } catch (error) {
    if (isBrowserMissingError(error)) {
      // raw (path 入り) は server-side log にだけ残す / raw text (with paths) stays server-side only
      logger.warn("[launchChromium] Browser executable is missing", {
        error: (error as Error).message,
      });
      throw new BrowserNotInstalledError({ cause: error });
    }
    throw error;
  }
}
