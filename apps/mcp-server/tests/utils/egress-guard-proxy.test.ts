// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

import { clearEgressCacheForTesting, setEgressResolverForTesting } from "@reftrixmcp/core";
import {
  getEgressGuardProxyServer,
  resolveEgressTarget,
  setEgressGuardAllowlistForTesting,
} from "../../src/utils/egress-guard-proxy";

// 名前解決はテストで固定する / Name resolution is pinned in this file
const lookupMock = vi.fn();
beforeAll(() => setEgressResolverForTesting((h) => lookupMock(h)));
afterAll(() => setEgressResolverForTesting(null));

describe("resolveEgressTarget", () => {
  afterEach(() => {
    lookupMock.mockReset();
    clearEgressCacheForTesting();
    setEgressGuardAllowlistForTesting([]);
  });

  it("allows a public IP literal and connects to it", async () => {
    await expect(resolveEgressTarget("93.184.215.14", 443)).resolves.toEqual({
      allowed: true,
      addresses: [{ address: "93.184.215.14", family: 4 }],
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "169.254.169.254", "[::1]", "10.0.0.1", "localhost"])(
    "refuses %s",
    async (host) => {
      const d = await resolveEgressTarget(host, 80);
      expect(d.allowed).toBe(false);
    }
  );

  it("refuses a public name that resolves to an internal address", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const d = await resolveEgressTarget("rebind.example", 80);
    expect(d).toEqual({ allowed: false, reason: "resolves to a non-public address" });
  });

  it("refuses when any record of the set is internal", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    expect((await resolveEgressTarget("mixed.example", 443)).allowed).toBe(false);
  });

  it("returns every checked address for pinning", async () => {
    const records = [
      { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
      { address: "93.184.215.14", family: 4 },
    ];
    lookupMock.mockResolvedValue(records);
    await expect(resolveEgressTarget("public.example", 443)).resolves.toEqual({
      allowed: true,
      addresses: records,
    });
  });

  it("refuses when the lookup fails", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    expect(await resolveEgressTarget("nx.example", 80)).toEqual({
      allowed: false,
      reason: "dns lookup failed",
    });
  });

  it.each([0, 65536, 1.5, Number.NaN])("refuses port %s", async (port) => {
    expect((await resolveEgressTarget("93.184.215.14", port)).allowed).toBe(false);
  });

  it("lets only the exact allowlisted host:port through", async () => {
    setEgressGuardAllowlistForTesting(["127.0.0.1:4000"]);
    expect((await resolveEgressTarget("127.0.0.1", 4000)).allowed).toBe(true);
    expect((await resolveEgressTarget("127.0.0.1", 4001)).allowed).toBe(false);
  });

  it("retries a transient DNS failure once", async () => {
    lookupMock
      .mockRejectedValueOnce(Object.assign(new Error("EAI_AGAIN"), { code: "EAI_AGAIN" }))
      .mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }]);
    expect((await resolveEgressTarget("flaky.example", 443)).allowed).toBe(true);
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });
});

describe("egress guard proxy server", () => {
  let target: http.Server;
  let targetPort = 0;
  let targetHits = 0;
  let proxyPort = 0;

  beforeAll(async () => {
    target = http.createServer((_req, res) => {
      targetHits += 1;
      res.writeHead(200, { "content-type": "text/plain" }).end("INTERNAL");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    targetPort = (target.address() as AddressInfo).port;
    proxyPort = Number(new URL(await getEgressGuardProxyServer()).port);
  });

  afterAll(async () => {
    setEgressGuardAllowlistForTesting([]);
    await new Promise<void>((r) => target.close(() => r()));
  });

  afterEach(() => {
    setEgressGuardAllowlistForTesting([]);
    targetHits = 0;
  });

  function proxiedGet(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxyPort, method: "GET", path: url },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      // 拒否はソケットの切断 (status 0) / a refusal closes the socket (status 0)
      req.on("error", () => resolve({ status: 0, body: "" }));
      req.end();
    });
  }

  function connect(authority: string): Promise<string> {
    return new Promise((resolve) => {
      const s = net.connect(proxyPort, "127.0.0.1", () => {
        s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      s.once("data", (d: Buffer) => {
        resolve(d.toString().split("\r\n")[0] ?? "");
        s.destroy();
      });
      s.on("error", () => resolve("CLOSED"));
      s.on("close", () => resolve("CLOSED"));
    });
  }

  it("returns the same server on every call", async () => {
    expect(await getEgressGuardProxyServer()).toBe(`http://127.0.0.1:${proxyPort}`);
  });

  it("refuses a plain HTTP request to a loopback target by closing the socket", async () => {
    const r = await proxiedGet(`http://127.0.0.1:${targetPort}/`);
    expect(r.status).toBe(0);
    expect(r.body).not.toContain("INTERNAL");
    expect(targetHits).toBe(0);
  });

  it("refuses a CONNECT tunnel to a loopback target", async () => {
    expect(await connect(`127.0.0.1:${targetPort}`)).toBe("CLOSED");
    expect(await connect(`[::1]:${targetPort}`)).toBe("CLOSED");
    expect(targetHits).toBe(0);
  });

  it("refuses a CONNECT to a public name that resolves to loopback", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await connect(`rebind.example:${targetPort}`)).toBe("CLOSED");
    expect(targetHits).toBe(0);
  });

  it("closes the client when the allowed upstream refuses the connection", async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    setEgressGuardAllowlistForTesting([`127.0.0.1:${port}`]);
    expect(await connect(`127.0.0.1:${port}`)).toBe("CLOSED");
    expect((await proxiedGet(`http://127.0.0.1:${port}/`)).status).toBe(0);
  });

  it("forwards an allowed target", async () => {
    setEgressGuardAllowlistForTesting([`127.0.0.1:${targetPort}`]);
    const r = await proxiedGet(`http://127.0.0.1:${targetPort}/x?y=1`);
    expect(r).toEqual({ status: 200, body: "INTERNAL" });
    expect(targetHits).toBe(1);
    expect(await connect(`127.0.0.1:${targetPort}`)).toBe("HTTP/1.1 200 Connection Established");
  });

  it("connects a hostname target only to its checked address, without resolving it again", async () => {
    // 名前は公開アドレスに解決される。接続先を記録し、実際には手元の fixture へ繋ぐ
    // The name resolves to a public address; record the connect target and route it to the fixture
    lookupMock.mockReset();
    clearEgressCacheForTesting();
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    const realConnect = net.connect;
    const targets: string[] = [];
    const spy = vi.spyOn(net, "connect").mockImplementation(((opts: net.NetConnectOpts) => {
      const host = (opts as net.TcpNetConnectOpts).host ?? "";
      targets.push(host);
      return realConnect({ host: "127.0.0.1", port: targetPort });
    }) as unknown as typeof net.connect);
    try {
      const r = await proxiedGet(`http://pinned.example:${targetPort}/`);
      expect(r).toEqual({ status: 200, body: "INTERNAL" });
      expect(targets).toEqual(["93.184.215.14"]);
      expect(lookupMock).toHaveBeenCalledTimes(1);
      expect(lookupMock).toHaveBeenCalledWith("pinned.example");
    } finally {
      spy.mockRestore();
      lookupMock.mockReset();
      clearEgressCacheForTesting();
    }
  });

  it("rejects malformed requests", async () => {
    expect((await proxiedGet("/relative")).status).toBe(0);
    expect(await connect("no-port")).toBe("CLOSED");
  });
});
