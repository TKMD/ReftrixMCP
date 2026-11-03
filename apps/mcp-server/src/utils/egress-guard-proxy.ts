// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Egress guard proxy for Chromium (SSRF defense for every browser request)
 * Chromium 用の送信先検査プロキシ (ブラウザの全リクエストに対する SSRF 防御)
 *
 * 遷移前の URL 検査だけでは、リダイレクト先・iframe・サブリソース、および公開名で
 * 内部 IP に解決されるホストを止められない。Playwright の route はリダイレクトの 2 hop 目
 * 以降を捕捉できない。そこで launchChromium() は全ブラウザをこのプロキシ経由で起動し、
 * プロキシが接続のたびに名前を解決して、解決した全アドレスが公開アドレスの場合だけ、
 * その検査済みアドレスに接続する (検査と接続で同じ IP を使うので DNS rebinding も防ぐ)。
 *
 * URL checks before navigation cannot stop redirect targets, iframes, subresources, or
 * public names that resolve to internal IPs, and Playwright's route does not see the
 * second and later hops of a redirect. launchChromium() therefore starts every browser
 * behind this proxy. For each connection the proxy resolves the name and connects only
 * when every resolved address is public, and only to those checked addresses (so DNS
 * rebinding cannot swap them).
 *
 * 拒否はソケットの切断で返す (ブラウザ側は navigation error になり、空の 403 ページを
 * 成功として解析しない)。 / Refusals close the socket, so the browser sees a navigation
 * error instead of an empty 403 page that would be analysed as a success.
 *
 * 不変条件 / Invariant: INV-SEC-SSRF-EGRESS-GUARD-001. ADR-0054.
 *
 * @module utils/egress-guard-proxy
 */

import http from "node:http";
import net from "node:net";
import { pipeline } from "node:stream";
import type { Duplex } from "node:stream";
import { checkEgressHost, type ResolvedAddress } from "@reftrixmcp/core";
import { isBlockedHost } from "./url-validator";
import { logger } from "./logger";

/** 上流への接続・応答待ちのタイムアウト / Upstream connect and idle timeout */
const UPSTREAM_TIMEOUT_MS = 60_000;

/** トンネルの無通信タイムアウト / Tunnel idle timeout */
const TUNNEL_IDLE_TIMEOUT_MS = 120_000;

/** 同時接続の上限 (CWE-770) / Concurrent connection cap (CWE-770) */
const MAX_CONNECTIONS = 1024;

/** hop-by-hop ヘッダ (転送しない) / Hop-by-hop headers (never forwarded) */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// =============================================
// テスト用の許可リスト / Test-only allowlist
// =============================================

let testAllowlist: ReadonlySet<string> = new Set();

/**
 * テスト専用: `host:port` 完全一致で検査を通す (ローカルのテストサーバー用)。
 * テスト以外の実行では throw する。src から呼んではならない (INV-SEC-SSRF-EGRESS-GUARD-001)。
 *
 * Test-only: let exact `host:port` targets through (for local fixture servers).
 * Throws outside tests; never call from src (INV-SEC-SSRF-EGRESS-GUARD-001).
 */
export function setEgressGuardAllowlistForTesting(hostPorts: readonly string[]): void {
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
    throw new Error("setEgressGuardAllowlistForTesting is test-only");
  }
  testAllowlist = new Set(hostPorts.map((h) => h.toLowerCase()));
}

// =============================================
// 宛先の解決と検査 / Target resolution and check
// =============================================

/** 検査結果 / Check result */
export type EgressDecision =
  | { allowed: true; addresses: ResolvedAddress[] }
  | { allowed: false; reason: string };

/**
 * 宛先ホストを解決して検査する。許可時は接続に使ってよい検査済みアドレスを返す。
 * Resolve and check a target host; when allowed, returns the checked addresses to use.
 */
export async function resolveEgressTarget(host: string, port: number): Promise<EgressDecision> {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!bare) return { allowed: false, reason: "empty host" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { allowed: false, reason: "invalid port" };
  }
  if (testAllowlist.has(`${bare}:${port}`)) {
    const family = net.isIP(bare);
    return family !== 0
      ? { allowed: true, addresses: [{ address: bare, family: family === 6 ? 6 : 4 }] }
      : { allowed: false, reason: "allowlist entries must be IP literals" };
  }
  if (isBlockedHost(bare)) return { allowed: false, reason: "blocked host" };
  return checkEgressHost(bare);
}

/** 次のアドレスへの接続を始めるまでの待ち時間 (RFC 8305 の Connection Attempt Delay) */
/** Delay before starting the next address (RFC 8305 Connection Attempt Delay) */
export const CONNECTION_ATTEMPT_DELAY_MS = 250;

/** 1 回の接続で試すアドレスの上限 / Max addresses tried per connection */
export const MAX_CONNECT_ATTEMPTS = 8;

/** 接続が確立するまでの上限時間 / Time limit for establishing a connection */
export const CONNECT_TIMEOUT_MS = 15_000;

/** IPv6 と IPv4 を交互に並べる (先頭の family から) / Interleave families, first family first */
function interleaveFamilies(addresses: readonly ResolvedAddress[]): ResolvedAddress[] {
  const firstFamily = addresses[0]?.family;
  const a = addresses.filter((x) => x.family === firstFamily);
  const b = addresses.filter((x) => x.family !== firstFamily);
  const out: ResolvedAddress[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i]) out.push(a[i] as ResolvedAddress);
    if (b[i]) out.push(b[i] as ResolvedAddress);
  }
  return out;
}

/**
 * 検査済みアドレスだけに接続する (pinning)。RFC 8305 と同じく、接続待ちが
 * CONNECTION_ATTEMPT_DELAY_MS を超えたら前の試行を止めずに次のアドレスを並行して試し、
 * 最初に成功したソケットを使う。Node の autoSelectFamily は 250ms で前の試行を中断するため、
 * RTT が 250ms を超える相手では全アドレスを順に試して数秒かかっていた。
 *
 * Connect only to the checked addresses (pinning). As in RFC 8305, when an attempt has not
 * connected within CONNECTION_ATTEMPT_DELAY_MS the next address is tried in parallel without
 * abandoning earlier attempts; the first socket to connect wins. Node's autoSelectFamily
 * aborts each attempt after 250 ms, so peers with an RTT above 250 ms walked the whole list.
 */
export function connectToCheckedAddresses(
  addresses: readonly ResolvedAddress[],
  port: number,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<net.Socket> {
  const { signal, timeoutMs = CONNECT_TIMEOUT_MS } = options;
  // 試すアドレス数に上限を設ける (多数のアドレスで並行ソケットが増えすぎないように、CWE-770)
  // Cap the addresses tried, so a long record set cannot fan out into many sockets (CWE-770)
  const ordered = interleaveFamilies(addresses).slice(0, MAX_CONNECT_ATTEMPTS);
  return new Promise((resolve, reject) => {
    if (ordered.length === 0) {
      reject(Object.assign(new Error("no checked address"), { code: "ENOTFOUND" }));
      return;
    }
    if (signal?.aborted) {
      reject(Object.assign(new Error("connect aborted"), { code: "ABORT_ERR" }));
      return;
    }
    const attempts: net.Socket[] = [];
    let next = 0;
    let failed = 0;
    let settled = false;
    let delayTimer: NodeJS.Timeout | undefined;
    const finish = (winner: net.Socket | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(delayTimer);
      clearTimeout(overall);
      signal?.removeEventListener("abort", onAbort);
      for (const s of attempts) {
        if (s !== winner) s.destroy();
      }
      if (winner) resolve(winner);
      else reject(error ?? new Error("connect failed"));
    };
    const startNext = (): void => {
      if (settled || next >= ordered.length) return;
      const target = ordered[next] as ResolvedAddress;
      next += 1;
      const socket = net.connect({ host: target.address, port, family: target.family });
      attempts.push(socket);
      socket.once("connect", () => finish(socket));
      socket.once("error", (err) => {
        socket.destroy();
        failed += 1;
        if (failed === ordered.length) finish(null, err);
        else startNext();
      });
      clearTimeout(delayTimer);
      delayTimer = setTimeout(startNext, CONNECTION_ATTEMPT_DELAY_MS);
    };
    const overall = setTimeout(
      () => finish(null, Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })),
      timeoutMs
    );
    // 呼び出し元 (ブラウザ側の接続) が閉じたら全試行を止める / Stop every attempt when the client goes away
    const onAbort = (): void =>
      finish(null, Object.assign(new Error("connect aborted"), { code: "ABORT_ERR" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    startNext();
  });
}

/** `host:port` (CONNECT の authority) を分解 / Split a CONNECT authority */
function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = authority.match(/^\[([^\]]+)\]:(\d+)$/) ?? authority.match(/^([^:]+):(\d+)$/);
  if (!m?.[1] || !m[2]) return null;
  return { host: m[1], port: Number(m[2]) };
}

function logBlocked(kind: string, host: string, reason: string): void {
  logger.warn("[egress-guard] Blocked browser request", { kind, host, reason });
}

// =============================================
// プロキシ本体 / Proxy server
// =============================================

function handleConnect(req: http.IncomingMessage, client: Duplex, head: Buffer): void {
  client.on("error", () => client.destroy());
  const target = parseAuthority(req.url ?? "");
  if (!target) {
    client.destroy();
    return;
  }
  void resolveEgressTarget(target.host, target.port).then(
    (decision) => {
      if (client.destroyed) return;
      if (!decision.allowed) {
        logBlocked("connect", target.host, decision.reason);
        client.destroy();
        return;
      }
      const abort = new AbortController();
      client.once("close", () => abort.abort());
      connectToCheckedAddresses(decision.addresses, target.port, { signal: abort.signal }).then(
        (upstream) => {
          if (client.destroyed) {
            upstream.destroy();
            return;
          }
          client.once("close", () => upstream.destroy());
          upstream.once("close", () => client.destroy());
          upstream.on("error", () => upstream.destroy());
          upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => upstream.destroy());
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        },
        () => client.destroy()
      );
    },
    () => client.destroy()
  );
}

function filterHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const connectionListed = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name) && !connectionListed.has(name) && value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    res.socket?.destroy();
    return;
  }
  if (target.protocol !== "http:") {
    res.socket?.destroy();
    return;
  }
  const port = target.port ? Number(target.port) : 80;
  void resolveEgressTarget(target.hostname, port).then(
    (decision) => {
      if (res.destroyed) return;
      if (!decision.allowed) {
        logBlocked("http", target.hostname, decision.reason);
        res.socket?.destroy();
        return;
      }
      const addresses = decision.addresses;
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      const requestOptions: http.RequestOptions = {
        host: target.hostname.replace(/^\[|\]$/g, ""),
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: filterHeaders(req.headers),
        // 検査済みアドレスだけに接続する / connect only to the checked addresses
        createConnection: (_opts, oncreate) => {
          connectToCheckedAddresses(addresses, port, { signal: abort.signal }).then(
            (socket) => oncreate(null, socket),
            (err: Error) => oncreate(err, undefined as unknown as net.Socket)
          );
          return undefined;
        },
        timeout: UPSTREAM_TIMEOUT_MS,
      };
      const upstream = http.request(requestOptions);
      res.once("close", () => upstream.destroy());
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("response", (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, filterHeaders(upRes.headers));
        // 途中で切れた応答を完全な応答として渡さない / Never pass a truncated body as complete
        pipeline(upRes, res, (err) => {
          if (err) res.destroy();
        });
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.socket?.destroy();
        res.destroy();
      });
      pipeline(req, upstream, (err) => {
        if (err) upstream.destroy();
      });
    },
    () => res.socket?.destroy()
  );
}

let proxyPromise: Promise<string> | null = null;

/**
 * プロセス内の検査プロキシを起動し (初回のみ)、`http://127.0.0.1:<port>` を返す。
 * 起動できなければ reject する (fail-closed: ブラウザは起動しない)。
 *
 * Start the in-process guard proxy (once) and return `http://127.0.0.1:<port>`.
 * Rejects if it cannot start (fail-closed: no browser is launched).
 */
export function getEgressGuardProxyServer(): Promise<string> {
  if (proxyPromise) return proxyPromise;
  const pending = new Promise<string>((resolve, reject) => {
    const server = http.createServer(handleHttp);
    server.maxConnections = MAX_CONNECTIONS;
    server.on("connect", handleConnect);
    // WebSocket 等の Upgrade は CONNECT 経由のみ許可 / Upgrades only via CONNECT
    server.on("upgrade", (_req, socket: Duplex) => socket.destroy());
    server.on("clientError", (_err, socket: Duplex) => socket.destroy());
    server.once("listening", () => {
      server.unref();
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("egress guard proxy has no TCP address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
    // listen 後のエラー (accept 失敗など) でプロセスを落とさない / Never crash on later errors
    server.on("error", (error) => {
      logger.error("[egress-guard] Proxy server error", { error: error.message });
      if (!server.listening) reject(error);
    });
    server.on("close", () => {
      proxyPromise = null;
    });
    server.listen(0, "127.0.0.1");
  });
  proxyPromise = pending;
  pending.catch(() => {
    proxyPromise = null;
  });
  return pending;
}
