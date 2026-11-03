// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// INV-SEC-SSRF-EGRESS-GUARD-001 (Node fetch path)

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import {
  checkEgressHost,
  EgressBlockedError,
  isNonPublicAddress,
  safeFetch,
  setEgressResolverForTesting,
  clearEgressCacheForTesting,
} from "../../src/net/egress";

const lookupMock = vi.fn();
beforeAll(() => setEgressResolverForTesting((h) => lookupMock(h)));
afterAll(() => setEgressResolverForTesting(null));
afterEach(() => {
  lookupMock.mockReset();
  clearEgressCacheForTesting();
  vi.unstubAllGlobals();
});

describe("isNonPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:0:127.0.0.1",
    "::ffff:0:7f00:1",
    "::7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "2002:7f00:1::",
    "2001:db8::1",
    "3fff::1",
    "5f00::1",
    "not-an-ip",
    "",
  ])("treats %s as non-public", (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.215.14",
    "172.32.0.1",
    "2606:4700:4700::1111",
    // NAT64 で公開 IPv4 を指すアドレスは公開 / NAT64 to a public IPv4 is public
    "64:ff9b::808:808",
  ])("treats %s as public", (ip) => {
    expect(isNonPublicAddress(ip)).toBe(false);
  });
});

describe("checkEgressHost", () => {
  it.each(["localhost", "LOCALHOST.", "foo.localhost", "metadata.google.internal", "x.internal"])(
    "refuses %s by name without resolving",
    async (host) => {
      expect((await checkEgressHost(host)).allowed).toBe(false);
      expect(lookupMock).not.toHaveBeenCalled();
    }
  );

  it("refuses a name that resolves to a metadata address", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    expect(await checkEgressHost("rebind.example")).toEqual({
      allowed: false,
      reason: "resolves to a non-public address",
    });
  });

  it("refuses when one record of several is private", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
      { address: "fd00::1", family: 6 },
    ]);
    expect((await checkEgressHost("mixed.example")).allowed).toBe(false);
  });

  it("allows a public name and returns all its addresses", async () => {
    const recs = [{ address: "93.184.215.14", family: 4 }];
    lookupMock.mockResolvedValue(recs);
    expect(await checkEgressHost("public.example")).toEqual({ allowed: true, addresses: recs });
  });

  it("shares one lookup for concurrent checks and caches only allowed results", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    await Promise.all([checkEgressHost("c.example"), checkEgressHost("c.example")]);
    await checkEgressHost("c.example");
    expect(lookupMock).toHaveBeenCalledTimes(1);
    lookupMock.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    expect((await checkEgressHost("d.example")).allowed).toBe(false);
    expect((await checkEgressHost("d.example")).allowed).toBe(false);
    expect(lookupMock).toHaveBeenCalledTimes(3);
  });

  it("refuses an empty answer and a failed lookup", async () => {
    lookupMock.mockResolvedValueOnce([]);
    expect((await checkEgressHost("empty.example")).allowed).toBe(false);
    lookupMock.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
    expect((await checkEgressHost("nx.example")).allowed).toBe(false);
  });
});

describe("safeFetch", () => {
  function redirect(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  it("follows a public redirect chain and reports the final URL", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect("/next"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await safeFetch("https://a.example/start");
    expect(await res.text()).toBe("ok");
    expect(res.url).toBe("https://a.example/next");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses a redirect to an internal IP without requesting it", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect("http://169.254.169.254/latest"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetch("https://a.example/")).rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a name that resolves inside", async () => {
    lookupMock.mockImplementation(async (h: string) =>
      h === "inside.example"
        ? [{ address: "10.0.0.5", family: 4 }]
        : [{ address: "93.184.215.14", family: 4 }]
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect("https://inside.example/admin"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetch("https://a.example/")).rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses the first hop when the name resolves inside", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetch("http://evil.example/")).rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses non-http protocols, credentials in the URL and too many redirects", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => redirect("/again"))
    );
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(EgressBlockedError);
    // 認証情報付き URL は部品から組み立てる (secret scan に生の literal を残さない)
    // Build the credentialed URL from parts (no raw credential literal for the secret scan)
    const withCredentials = new URL("https://a.example/");
    withCredentials.username = "u";
    withCredentials.password = "p";
    expect(withCredentials.password).toBe("p");
    await expect(safeFetch(withCredentials.href)).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(safeFetch("https://a.example/", { maxRedirects: 2 })).rejects.toThrow(
      EgressBlockedError
    );
  });

  it("switches POST to GET on 303", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect("/done", 303))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await safeFetch("https://a.example/", { method: "POST", body: "x" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET", body: null });
  });
});

describe("INV-SEC-SSRF-EGRESS-GUARD-001: DNS rebinding on the Node fetch path", () => {
  it("never connects to an internal address that the second lookup returns", async () => {
    const http = await import("node:http");
    let hits = 0;
    const server = http.createServer((_q, r) => {
      hits += 1;
      r.end("INTERNAL");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    // 許可キャッシュが毎回失効する状況 (検査と接続の間に TTL が切れた場合) を再現する
    // Make the allowed cache expire every time (TTL ran out between check and connect)
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 60_000));
    // 1 回目は公開、以降は loopback を返す (TTL 0 の rebinding) / public first, then loopback
    let calls = 0;
    lookupMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? [{ address: "93.184.215.14", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    });
    try {
      await expect(safeFetch(`http://rebind.test:${port}/`)).rejects.toThrow();
      // 接続時の名前解決も検査を通った (2 回目の解決が起きた) / the connect-time lookup ran
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(hits).toBe(0);
    } finally {
      clock.mockRestore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("pins the connection to the cached checked addresses", async () => {
    const { egressLookup } = await import("../../src/net/egress");
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect((await checkEgressHost("pin.example")).allowed).toBe(true);
    const got = await new Promise<unknown>((resolve, reject) =>
      egressLookup("pin.example", { all: true }, (err, addrs) =>
        err ? reject(err) : resolve(addrs)
      )
    );
    expect(got).toEqual([{ address: "93.184.215.14", family: 4 }]);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });
});
