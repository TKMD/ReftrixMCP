// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-SSRF-EGRESS-GUARD-001
 *
 * launchChromium() で起動したブラウザは、リダイレクト先・iframe・サブリソースを含む
 * すべてのリクエストで非公開アドレスに接続しない (SSRF via redirect の回帰防止)。
 * 静的には、src がテスト用許可リストや独自 proxy 指定で検査を外していないことを確認する。
 *
 * A browser started by launchChromium() never connects to a non-public address, for any
 * request including redirect hops, iframes and subresources (regression guard for SSRF
 * via redirect). Statically, src must not bypass the guard with the test allowlist or a
 * proxy of its own.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser } from "playwright";
import { launchChromium } from "../../src/utils/launch-chromium";
import { setEgressGuardAllowlistForTesting } from "../../src/utils/egress-guard-proxy";

const SRC_DIR = path.resolve(__dirname, "../../src");

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listTs(p);
    return e.isFile() && p.endsWith(".ts") ? [p] : [];
  });
}

describe("INV-SEC-SSRF-EGRESS-GUARD-001 (static)", () => {
  const files = listTs(SRC_DIR);
  const rel = (f: string): string => path.relative(SRC_DIR, f).split(path.sep).join("/");

  it("src never calls the test-only allowlist", () => {
    const offenders = files
      .filter((f) => rel(f) !== "utils/egress-guard-proxy.ts")
      .filter((f) => fs.readFileSync(f, "utf8").includes("setEgressGuardAllowlistForTesting"));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("src sets no browser proxy outside launch-chromium.ts", () => {
    const offenders = files
      .filter((f) => rel(f) !== "utils/launch-chromium.ts")
      .filter((f) => /\bproxy\s*:/.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("Node-side fetches of page-controlled URLs go through the egress check", () => {
    const read = (p: string): string => fs.readFileSync(path.resolve(SRC_DIR, p), "utf8");
    expect(read("services/external-css-fetcher.ts")).toMatch(/await safeFetch\(url/);
    expect(read("tools/accessibility/audit.tool.ts")).toMatch(/await safeFetch\(validated\.url/);
    expect(read("tools/design/search-by-image.tool.ts")).toContain("await checkEgressHost(");
    const preflight = fs.readFileSync(
      path.resolve(
        SRC_DIR,
        "../../../packages/webdesign-core/src/services/preflight-probe.service.ts"
      ),
      "utf8"
    );
    expect(preflight).not.toMatch(/await fetch\(/);
    const robots = fs.readFileSync(
      path.resolve(SRC_DIR, "../../../packages/core/src/services/robots-txt.service.ts"),
      "utf8"
    );
    expect((robots.match(/checkEgressHost\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((robots.match(/getEgressDispatcher\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(read("tools/design/search-by-image.tool.ts")).toContain("getEgressDispatcher()");
    const egress = fs.readFileSync(
      path.resolve(SRC_DIR, "../../../packages/core/src/net/egress.ts"),
      "utf8"
    );
    expect(egress).toContain("dispatcher: getEgressDispatcher()");
  });

  it("launchChromium routes every launch through the guard", () => {
    const text = fs.readFileSync(path.join(SRC_DIR, "utils/launch-chromium.ts"), "utf8");
    expect(text).toContain("buildGuardedLaunchOptions(options)");
    expect(text).toContain('bypass: "<-loopback>"');
    expect(text).toMatch(/chromium\.launch\(guarded\)/);
  });
});

describe("INV-SEC-SSRF-EGRESS-GUARD-001 (real Chromium)", () => {
  let internal: http.Server;
  let attacker: http.Server;
  let internalHits = 0;
  // TCP 接続の数 (HTTP 以外の ws・https の CONNECT も数える) / TCP connections (also counts ws and https)
  let internalConns = 0;
  let udpHits = 0;
  let udp: dgram.Socket;
  let udpPort = 0;
  let attackerHits = 0;
  let attackerPort = 0;
  let internalUrl = "";
  let attackerOrigin = "";
  let browser: Browser;

  beforeAll(async () => {
    // 内部サービス役 (到達してはならない) / Internal service (must never be reached)
    internal = http.createServer((_req, res) => {
      internalHits += 1;
      res.writeHead(200, { "content-type": "text/html" }).end("<p>INTERNAL-SECRET</p>");
    });
    internal.on("connection", () => {
      internalConns += 1;
    });
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
    const internalPort = (internal.address() as AddressInfo).port;
    internalUrl = `http://127.0.0.1:${internalPort}/`;

    // WebRTC の STUN が届くかを見る UDP ソケット / UDP socket that would receive WebRTC STUN
    udp = dgram.createSocket("udp4");
    udp.on("message", () => {
      udpHits += 1;
    });
    await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
    udpPort = udp.address().port;

    // 攻撃者の公開サイト役 (テスト用許可リストで通す) / Attacker's "public" site (allowlisted)
    attacker = http.createServer((req, res) => {
      attackerHits += 1;
      if (req.url === "/redirect") {
        res.writeHead(302, { location: internalUrl }).end();
      } else if (req.url === "/chain") {
        res.writeHead(302, { location: "/redirect" }).end();
      } else if (req.url === "/https-redirect") {
        res.writeHead(302, { location: `https://127.0.0.1:${internalPort}/` }).end();
      } else if (req.url === "/jsfetch") {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            `<script>fetch(${JSON.stringify(internalUrl)},{mode:"no-cors"}).catch(()=>{});` +
              `navigator.sendBeacon(${JSON.stringify(internalUrl + "beacon")},"x");</script>`
          );
      } else if (req.url === "/ws") {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(`<script>new WebSocket("ws://127.0.0.1:${internalPort}/");</script>`);
      } else if (req.url === "/webrtc") {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            `<script>const pc=new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${udpPort}"}]});` +
              `pc.createDataChannel("x");pc.createOffer().then(o=>pc.setLocalDescription(o));</script>`
          );
      } else if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "text/html" }).end("<p>OK</p>");
      } else if (req.url === "/iframe") {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(`<iframe src="${internalUrl}"></iframe><img src="${internalUrl}img.png">`);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => attacker.listen(0, "127.0.0.1", r));
    attackerPort = (attacker.address() as AddressInfo).port;
    attackerOrigin = `http://127.0.0.1:${attackerPort}`;
    setEgressGuardAllowlistForTesting([`127.0.0.1:${attackerPort}`]);

    browser = await launchChromium({ headless: true });
  }, 60_000);

  afterAll(async () => {
    setEgressGuardAllowlistForTesting([]);
    await browser?.close();
    await new Promise<void>((r) => internal.close(() => r()));
    await new Promise<void>((r) => attacker.close(() => r()));
    await new Promise<void>((r) => udp.close(() => r()));
  });

  async function visit(pathname: string, settleMs = 500): Promise<string> {
    const page = await browser.newPage();
    try {
      await page.goto(`${attackerOrigin}${pathname}`, { timeout: 15_000 }).catch(() => null);
      await page.waitForTimeout(settleMs);
      const frames = await Promise.all(page.frames().map((f) => f.content().catch(() => "")));
      return frames.join("\n");
    } finally {
      await page.close();
    }
  }

  it("does not follow a redirect to an internal address", async () => {
    const before = attackerHits;
    const html = await visit("/redirect");
    // 許可された側には届いている (全通信の拒否で偽の合格にならない) / the allowed side was reached
    expect(attackerHits).toBeGreaterThan(before);
    expect(html).not.toContain("INTERNAL-SECRET");
    expect(internalHits).toBe(0);
  });

  it("does not follow a multi-hop redirect to an internal address", async () => {
    const html = await visit("/chain");
    expect(html).not.toContain("INTERNAL-SECRET");
    expect(internalHits).toBe(0);
  });

  it("does not load internal iframes or subresources", async () => {
    const html = await visit("/iframe");
    expect(html).not.toContain("INTERNAL-SECRET");
    expect(internalHits).toBe(0);
  });

  it("refuses a direct navigation to an internal address", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(internalUrl, { timeout: 15_000 }).catch(() => null);
      await page.waitForTimeout(500);
      const html = await page.content().catch(() => "");
      expect(html).not.toContain("INTERNAL-SECRET");
    } finally {
      await page.close();
    }
    expect(internalHits).toBe(0);
  });

  it("does not let page scripts reach internal addresses with fetch or sendBeacon", async () => {
    const before = attackerHits;
    await visit("/jsfetch", 1500);
    expect(attackerHits).toBeGreaterThan(before);
    expect(internalHits).toBe(0);
    expect(internalConns).toBe(0);
  });

  it("does not open a WebSocket to an internal address", async () => {
    await visit("/ws", 1500);
    expect(internalConns).toBe(0);
  });

  it("does not follow a redirect to an internal https address (CONNECT path)", async () => {
    await visit("/https-redirect");
    expect(internalConns).toBe(0);
  });

  it("does not send WebRTC UDP outside the proxy", async () => {
    await visit("/webrtc", 2000);
    expect(udpHits).toBe(0);
  });

  it("does not fall back to a direct connection after refusals", async () => {
    // 拒否を重ねてから、許可リストを外した公開サイト役に行く。DIRECT に落ちていれば届いてしまう
    // After repeated refusals, visit the "public" site with the allowlist removed: a DIRECT
    // fallback would reach it.
    await visit("/redirect");
    await visit("/redirect");
    expect(internalConns).toBe(0);
    setEgressGuardAllowlistForTesting([]);
    const before = attackerHits;
    try {
      await visit("/ok");
      expect(attackerHits).toBe(before);
    } finally {
      setEgressGuardAllowlistForTesting([`127.0.0.1:${attackerPort}`]);
    }
  });
});
