// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// 検査済みアドレスへの接続 (RFC 8305 の並行試行) / Connecting to checked addresses (RFC 8305)

import { EventEmitter } from "node:events";
import net from "node:net";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CONNECT_TIMEOUT_MS,
  CONNECTION_ATTEMPT_DELAY_MS,
  MAX_CONNECT_ATTEMPTS,
  connectToCheckedAddresses,
} from "../../src/utils/egress-guard-proxy";

class FakeSocket extends EventEmitter {
  destroyed = false;
  constructor(public readonly host: string) {
    super();
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

let sockets: FakeSocket[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  vi.spyOn(net, "connect").mockImplementation(((opts: { host: string }) => {
    const s = new FakeSocket(opts.host);
    sockets.push(s);
    return s as unknown as net.Socket;
  }) as unknown as typeof net.connect);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const v4 = (a: string): { address: string; family: 4 } => ({ address: a, family: 4 });
const v6 = (a: string): { address: string; family: 6 } => ({ address: a, family: 6 });

describe("connectToCheckedAddresses", () => {
  it("keeps a slow first attempt alive and uses it when it connects first", async () => {
    const p = connectToCheckedAddresses([v4("203.0.113.1"), v4("203.0.113.2")], 443);
    await vi.advanceTimersByTimeAsync(CONNECTION_ATTEMPT_DELAY_MS);
    // 2 本目を並行で開始しても 1 本目は中断しない / the first attempt is not aborted
    expect(sockets.map((s) => s.host)).toEqual(["203.0.113.1", "203.0.113.2"]);
    expect(sockets[0]?.destroyed).toBe(false);
    sockets[0]?.emit("connect");
    const winner = (await p) as unknown as FakeSocket;
    expect(winner.host).toBe("203.0.113.1");
    expect(sockets[1]?.destroyed).toBe(true);
  });

  it("does not walk the whole list for a peer slower than the attempt delay", async () => {
    const addrs = Array.from({ length: 12 }, (_, i) => v4(`203.0.113.${i + 1}`));
    const p = connectToCheckedAddresses(addrs, 443);
    await vi.advanceTimersByTimeAsync(270);
    sockets[0]?.emit("connect");
    await p;
    expect(sockets.length).toBe(2);
  });

  it("moves on immediately when an attempt fails", async () => {
    const p = connectToCheckedAddresses([v4("203.0.113.1"), v4("203.0.113.2")], 80);
    sockets[0]?.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    expect(sockets.length).toBe(2);
    sockets[1]?.emit("connect");
    expect(((await p) as unknown as FakeSocket).host).toBe("203.0.113.2");
  });

  it("rejects when every attempt fails", async () => {
    const p = connectToCheckedAddresses([v4("203.0.113.1")], 80);
    sockets[0]?.emit("error", new Error("refused"));
    await expect(p).rejects.toThrow("refused");
  });

  it("rejects on the overall timeout and closes every attempt", async () => {
    const p = connectToCheckedAddresses([v4("203.0.113.1"), v4("203.0.113.2")], 80, {
      timeoutMs: 1_000,
    });
    const check = expect(p).rejects.toThrow("connect timeout");
    await vi.advanceTimersByTimeAsync(1_000);
    await check;
    expect(sockets.every((s) => s.destroyed)).toBe(true);
  });

  it("alternates address families and connects only to the given addresses", async () => {
    const p = connectToCheckedAddresses(
      [v6("2001:4860::1"), v6("2001:4860::2"), v4("203.0.113.1")],
      443
    );
    await vi.advanceTimersByTimeAsync(CONNECTION_ATTEMPT_DELAY_MS * 2);
    expect(sockets.map((s) => s.host)).toEqual(["2001:4860::1", "203.0.113.1", "2001:4860::2"]);
    sockets[2]?.emit("connect");
    await p;
  });

  it("rejects an empty address list", async () => {
    await expect(connectToCheckedAddresses([], 80)).rejects.toThrow("no checked address");
    expect(sockets.length).toBe(0);
  });

  it("tries at most MAX_CONNECT_ATTEMPTS addresses of a long record set", async () => {
    const addrs = Array.from({ length: 100 }, (_, i) => v4(`203.0.113.${i % 250}`));
    const p = connectToCheckedAddresses(addrs, 443);
    const check = expect(p).rejects.toThrow("connect timeout");
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await check;
    expect(sockets.length).toBe(MAX_CONNECT_ATTEMPTS);
    expect(sockets.every((s) => s.destroyed)).toBe(true);
  });

  it("stops every attempt when the caller aborts", async () => {
    const abort = new AbortController();
    const p = connectToCheckedAddresses([v4("203.0.113.1"), v4("203.0.113.2")], 443, {
      signal: abort.signal,
    });
    const check = expect(p).rejects.toThrow("connect aborted");
    await vi.advanceTimersByTimeAsync(CONNECTION_ATTEMPT_DELAY_MS);
    abort.abort();
    await check;
    expect(sockets.length).toBe(2);
    expect(sockets.every((s) => s.destroyed)).toBe(true);
    // 中断後は新しい試行を始めない / no new attempts after the abort
    await vi.advanceTimersByTimeAsync(CONNECTION_ATTEMPT_DELAY_MS * 4);
    expect(sockets.length).toBe(2);
  });

  it("does not connect when the signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      connectToCheckedAddresses([v4("203.0.113.1")], 443, { signal: abort.signal })
    ).rejects.toThrow("connect aborted");
    expect(sockets.length).toBe(0);
  });
});
