// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from "vitest";

const { launchMock, warnMock } = vi.hoisted(() => ({ launchMock: vi.fn(), warnMock: vi.fn() }));

vi.mock("playwright", () => ({
  chromium: { launch: launchMock },
}));

vi.mock("../../src/utils/logger", () => ({ logger: { warn: warnMock } }));
vi.mock("../../src/utils/egress-guard-proxy", () => ({
  getEgressGuardProxyServer: async () => "http://127.0.0.1:5555",
}));

import { launchChromium, BrowserNotInstalledError } from "../../src/utils/launch-chromium";
import { BROWSER_MISSING_MESSAGE } from "../../src/utils/browser-missing";

const RAW_MISSING =
  "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome\n" +
  "Call log:\n  - npx playwright install";

describe("launchChromium", () => {
  beforeEach(() => {
    launchMock.mockReset();
    warnMock.mockReset();
  });

  it("passes the options through behind the egress guard proxy on success", async () => {
    const browser = { isConnected: () => true };
    launchMock.mockResolvedValue(browser);
    const options = { headless: true, args: ["--disable-gpu"] };
    await expect(launchChromium(options)).resolves.toBe(browser);
    expect(launchMock).toHaveBeenCalledWith({
      headless: true,
      args: ["--disable-gpu", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      proxy: { server: "http://127.0.0.1:5555", bypass: "<-loopback>" },
    });
  });

  it.each([
    "--no-proxy-server",
    "--proxy-server=http://x:1",
    "--proxy-bypass-list=*",
    "--proxy-pac-url=http://x/p.pac",
    "--host-resolver-rules=MAP * 127.0.0.1",
    "--host-rules=MAP * 127.0.0.1",
    "--webrtc-ip-handling-policy=default",
  ])("refuses the guard-overriding switch %s", async (arg) => {
    await expect(launchChromium({ args: [arg] })).rejects.toThrow(/may not override/);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it.each([true, ["--proxy-server"]])("refuses ignoreDefaultArgs=%j", async (v) => {
    await expect(launchChromium({ ignoreDefaultArgs: v })).rejects.toThrow(/ignoreDefaultArgs/);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("refuses a caller-supplied proxy without launching", async () => {
    await expect(launchChromium({ proxy: { server: "http://evil.example:8080" } })).rejects.toThrow(
      /must not set a proxy/
    );
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("converts a browser-missing failure into BrowserNotInstalledError with the fixed message", async () => {
    launchMock.mockRejectedValue(new Error(RAW_MISSING));
    const err = await launchChromium({ headless: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserNotInstalledError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(BROWSER_MISSING_MESSAGE);
    expect((err as Error).message).not.toContain("ms-playwright");
    expect((err as Error).message).not.toContain("/home/");
    expect((err as Error).message).not.toContain("Call log");
    // raw text is kept server-side only
    expect(JSON.stringify(warnMock.mock.calls)).toContain("ms-playwright");
  });

  it("rethrows any other error unchanged (same object)", async () => {
    const other = new Error("Target closed: some other launch failure");
    launchMock.mockRejectedValue(other);
    await expect(launchChromium()).rejects.toBe(other);
  });

  it("does not treat missing host libraries (install-deps) as a missing browser", async () => {
    const deps = new Error("Host system is missing dependencies. Run: npx playwright install-deps");
    launchMock.mockRejectedValue(deps);
    await expect(launchChromium()).rejects.toBe(deps);
  });
});
