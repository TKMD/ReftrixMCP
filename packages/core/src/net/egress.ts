// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Egress checks shared by every outbound fetch (SSRF defense)
 * 外部への取得すべてで共有する送信先検査 (SSRF 防御)
 *
 * - isNonPublicAddress: IP が公開アドレスでなければ true / true when an IP is not public
 * - checkEgressHost: ホスト名を解決し、全アドレスが公開なら許可 / resolve a host; allow only
 *   when every resolved address is public
 * - safeFetch: global fetch をリダイレクト手動追従で包み、各 hop の宛先を検査する /
 *   wraps global fetch with manual redirects and checks the destination of every hop
 *
 * 接続先の固定 (pinning): safeFetch と getEgressDispatcher() の dispatcher は、接続時の名前解決
 * そのものを checkEgressHost で行い、検査を通ったアドレスだけに接続する。検査と接続の間に
 * DNS の答えが変わっても (rebinding) 内部には接続しない。ブラウザ経路は mcp-server の
 * egress guard proxy が同じ方式で固定する。
 *
 * Pinning: the dispatcher used by safeFetch and getEgressDispatcher() performs the
 * connection-time lookup itself through checkEgressHost and connects only to the checked
 * addresses, so a DNS answer that changes between check and connect (rebinding) never
 * reaches inside. The browser path is pinned the same way by the egress guard proxy.
 *
 * 不変条件 / Invariant: INV-SEC-SSRF-EGRESS-GUARD-001.
 *
 * @module net/egress
 */

import net from "node:net";
import type { LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";
import { Agent, type Dispatcher } from "undici";

// =============================================
// アドレス分類 / Address classification
// =============================================

/** 公開でない IPv4 レンジ / Non-public IPv4 ranges (IANA special-purpose registry) */
const NON_PUBLIC_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/**
 * 公開でない IPv6 レンジ / Non-public IPv6 ranges.
 * NAT64 (64:ff9b::/96) と IPv4-mapped/compatible/SIIT は埋め込み IPv4 で判定する (下の embeddedIPv4)。
 * NAT64 (64:ff9b::/96) and IPv4-mapped/compatible/SIIT are judged by the embedded IPv4.
 */
const NON_PUBLIC_V6: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

const nonPublicList = new net.BlockList();
for (const [address, prefix] of NON_PUBLIC_V4) nonPublicList.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of NON_PUBLIC_V6) nonPublicList.addSubnet(address, prefix, "ipv6");

/** IPv6 を 8 個の 16bit 値に展開 (失敗時 null) / Expand IPv6 to eight 16-bit groups */
function expandIPv6(ipv6: string): number[] | null {
  let text = ipv6.toLowerCase().replace(/%.*$/, "");
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) {
    const o = dotted[1].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = o;
    text =
      text.slice(0, -dotted[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  return out.some(Number.isNaN) ? null : out;
}

/**
 * IPv4 を埋め込んだ IPv6 から IPv4 を取り出す (無ければ null)。
 * IPv4-compatible (::/96)、IPv4-mapped (::ffff:0:0/96)、SIIT (::ffff:0:0:0/96)、NAT64 (64:ff9b::/96)。
 * Extract the IPv4 embedded in an IPv6 address (null if none).
 */
function embeddedIPv4(ipv6: string): string | null {
  const g = expandIPv6(ipv6);
  if (!g) return null;
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = g;
  const zeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  const compatible = zeroHead && g4 === 0 && g5 === 0;
  const mapped = zeroHead && g4 === 0 && g5 === 0xffff;
  const siit = zeroHead && g4 === 0xffff && g5 === 0;
  const nat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (!(compatible || mapped || siit || nat64)) return null;
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

/**
 * IP リテラルが公開アドレスでない (= 接続を拒否すべき) なら true。IP でない文字列も true (fail-closed)。
 * True when the IP literal is not a public address. A non-IP string is also true (fail-closed).
 */
export function isNonPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = net.isIP(bare);
  if (family === 4) return nonPublicList.check(bare, "ipv4");
  if (family === 6) {
    const v4 = embeddedIPv4(bare);
    if (v4 !== null) return nonPublicList.check(v4, "ipv4");
    return nonPublicList.check(bare, "ipv6");
  }
  return true;
}

// =============================================
// ホスト検査 / Host check
// =============================================

/** 名前で拒否するホスト / Hosts refused by name */
const BLOCKED_NAMES = new Set(["localhost", "metadata.google.internal", "kubernetes.default.svc"]);

/** 1 回の名前解決の上限時間 / Timeout for one lookup */
const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * 同時に走らせる名前解決の上限。libuv threadpool (既定 4) より小さくし、他の fs / zlib /
 * 名前解決のスレッドを残す。slot は実際の名前解決が終わるまで保持する (タイムアウトで呼び出し元に
 * 先に返しても、裏の getaddrinfo が終わるまでは解放しない)。
 * Concurrent lookup cap, below the libuv threadpool size (default 4). A slot is held until the
 * underlying lookup settles, even when the caller has already timed out.
 */
const LOOKUP_CONCURRENCY = 3;

let activeLookups = 0;
const lookupQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeLookups < LOOKUP_CONCURRENCY) {
    activeLookups += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) =>
    lookupQueue.push(() => {
      activeLookups += 1;
      resolve();
    })
  );
}

function releaseSlot(): void {
  activeLookups -= 1;
  lookupQueue.shift()?.();
}

/** 解決済みアドレス / A resolved address */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** 解決関数 (テストで差し替え可能) / Resolver (replaceable in tests) */
export type EgressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultResolver: EgressResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

let resolver: EgressResolver = defaultResolver;

/**
 * テスト専用: 名前解決を差し替える (null で既定に戻す)。テスト以外では throw する。
 * Test-only: replace name resolution (null restores the default). Throws outside tests.
 */
export function setEgressResolverForTesting(fn: EgressResolver | null): void {
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
    throw new Error("setEgressResolverForTesting is test-only");
  }
  resolver = fn ?? defaultResolver;
  allowedCache.clear();
}

/** 検査結果 / Check result */
export type EgressHostDecision =
  | { allowed: true; addresses: ResolvedAddress[] }
  | { allowed: false; reason: string };

function isTransientDnsError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "EAI_AGAIN";
}

/** 待ち行列の待ち時間を含めて LOOKUP_TIMEOUT_MS で打ち切る / Timeout covers queueing too */
async function resolveWithTimeout(hostname: string): Promise<ResolvedAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("lookup timeout"), { code: "ETIMEOUT" })),
      LOOKUP_TIMEOUT_MS
    );
  });
  const work = acquireSlot().then(() => {
    const running = resolver(hostname);
    // slot は名前解決が終わるまで保持 / hold the slot until the lookup settles
    running.then(releaseSlot, releaseSlot);
    return running;
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ホスト名を検査する。名前で拒否・IP リテラル判定・名前解決の結果に非公開が 1 つでもあれば拒否。
 * 一時的な DNS 失敗 (EAI_AGAIN) は 1 回だけ再試行する。
 *
 * Check a host: refused by name, by IP literal, or when any resolved address is non-public.
 * A transient DNS failure (EAI_AGAIN) is retried once.
 */
export async function checkEgressHost(host: string): Promise<EgressHostDecision> {
  const bare = host
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!bare) return { allowed: false, reason: "empty host" };
  if (BLOCKED_NAMES.has(bare) || bare.endsWith(".localhost") || bare.endsWith(".internal")) {
    return { allowed: false, reason: "blocked host" };
  }
  const family = net.isIP(bare);
  if (family !== 0) {
    return isNonPublicAddress(bare)
      ? { allowed: false, reason: "non-public address" }
      : { allowed: true, addresses: [{ address: bare, family: family === 6 ? 6 : 4 }] };
  }

  const cached = allowedCache.get(bare);
  if (cached && cached.expiresAt > Date.now())
    return { allowed: true, addresses: cached.addresses };
  const pending = inFlight.get(bare);
  if (pending) return pending;
  const check = resolveAndClassify(bare).finally(() => inFlight.delete(bare));
  inFlight.set(bare, check);
  return check;
}

/**
 * 許可した結果だけを短時間キャッシュする (接続は常にキャッシュした検査済みアドレスに固定されるので
 * 防御は弱まらない)。同じホストへの同時の検査は 1 回の名前解決に合流する。
 * Only allowed results are cached briefly (connections are always pinned to the cached,
 * checked addresses, so the defense is not weakened). Concurrent checks of one host share
 * one lookup.
 */
const ALLOWED_CACHE_TTL_MS = 30_000;
/** undici の接続試行ごとの待ち時間 / Per-attempt wait for undici connections */
export const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 1_000;
const ALLOWED_CACHE_MAX = 1_000;
const allowedCache = new Map<string, { addresses: ResolvedAddress[]; expiresAt: number }>();
const inFlight = new Map<string, Promise<EgressHostDecision>>();

/** テスト専用: キャッシュを消す / Test-only: clear the cache */
export function clearEgressCacheForTesting(): void {
  allowedCache.clear();
}

async function resolveAndClassify(bare: string): Promise<EgressHostDecision> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolveWithTimeout(bare);
  } catch (error) {
    if (!isTransientDnsError(error)) return { allowed: false, reason: "dns lookup failed" };
    try {
      await new Promise((r) => setTimeout(r, 300));
      addresses = await resolveWithTimeout(bare);
    } catch {
      return { allowed: false, reason: "dns lookup failed" };
    }
  }
  if (addresses.length === 0 || addresses.some((a) => isNonPublicAddress(a.address))) {
    return { allowed: false, reason: "resolves to a non-public address" };
  }
  if (allowedCache.size >= ALLOWED_CACHE_MAX) {
    const oldest = allowedCache.keys().next().value;
    if (oldest !== undefined) allowedCache.delete(oldest);
  }
  allowedCache.set(bare, { addresses, expiresAt: Date.now() + ALLOWED_CACHE_TTL_MS });
  return { allowed: true, addresses };
}

// =============================================
// safeFetch
// =============================================

/** 送信先検査で拒否したときの error / Thrown when the egress check refuses a hop */
export class EgressBlockedError extends Error {
  override readonly name = "EgressBlockedError";
  constructor(readonly reason: string) {
    super("The request target is not allowed");
  }
}

/**
 * 接続時の名前解決を checkEgressHost で行う lookup。検査を通ったアドレスだけを返す (pinning)。
 * A connection-time lookup that goes through checkEgressHost and returns only checked addresses.
 */
export const egressLookup: LookupFunction = (hostname, options, callback) => {
  void checkEgressHost(hostname).then(
    (decision) => {
      if (!decision.allowed) {
        callback(
          Object.assign(new EgressBlockedError(decision.reason), { code: "EGRESS_BLOCKED" }),
          "",
          4
        );
        return;
      }
      const first = decision.addresses[0];
      if (!first) {
        callback(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "", 4);
        return;
      }
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, [
          ...decision.addresses,
        ]);
      } else {
        callback(null, first.address, first.family);
      }
    },
    (error: unknown) => callback(error as NodeJS.ErrnoException, "", 4)
  );
};

let egressDispatcher: Dispatcher | null = null;

/**
 * 接続先を固定した undici dispatcher (プロセスで 1 つ)。Node の fetch に `dispatcher` として渡す。
 * The pinned undici dispatcher (one per process); pass it to Node's fetch as `dispatcher`.
 */
export function getEgressDispatcher(): Dispatcher {
  // 試行ごとの待ち時間を既定の 250ms から延ばす (RTT が 250ms を超える相手で全アドレスを順に
  // 試して数秒かかるのを避ける) / Longer per-attempt wait than the 250 ms default, so peers with
  // an RTT above 250 ms do not walk the whole address list.
  egressDispatcher ??= new Agent({
    connect: {
      lookup: egressLookup,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
    },
  });
  return egressDispatcher;
}

/** 別 origin への hop で落とすヘッダ / Headers dropped on a cross-origin hop */
const CROSS_ORIGIN_DROPPED_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/** safeFetch のオプション / safeFetch options */
export interface SafeFetchInit extends Omit<RequestInit, "redirect"> {
  /** 追従するリダイレクトの最大数 (既定 5) / Max redirects to follow (default 5) */
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * global fetch をリダイレクト手動追従で実行し、各 hop の宛先を checkEgressHost で検査する。
 * http/https 以外、拒否された hop、リダイレクト数の超過は EgressBlockedError。
 * 返す Response の `url` は最後の hop の URL。
 *
 * Run global fetch with manual redirects, checking each hop with checkEgressHost.
 * Non-http(s) URLs, refused hops and too many redirects throw EgressBlockedError.
 * The returned Response's `url` is the final hop's URL.
 */
export async function safeFetch(input: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  const { maxRedirects = 5, ...rest } = init;
  let current = new URL(String(input));
  let method = (rest.method ?? "GET").toUpperCase();
  let body: BodyInit | null = rest.body ?? null;
  const headers = new Headers(rest.headers);
  const origin = current.origin;

  for (let hop = 0; ; hop += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new EgressBlockedError("unsupported protocol");
    }
    if (current.username || current.password) {
      throw new EgressBlockedError("credentials in URL");
    }
    const decision = await checkEgressHost(current.hostname);
    if (!decision.allowed) throw new EgressBlockedError(decision.reason);

    // dispatcher が接続時にもう一度検査し、検査済みアドレスだけに接続する (rebinding 対策)
    // The dispatcher checks again at connect time and connects only to checked addresses
    const requestInit = {
      ...rest,
      headers,
      method,
      body,
      redirect: "manual" as const,
      dispatcher: getEgressDispatcher(),
    };
    const response = await fetch(current.href, requestInit as RequestInit);
    const location = REDIRECT_STATUSES.has(response.status)
      ? response.headers.get("location")
      : null;
    if (!location) {
      Object.defineProperty(response, "url", { value: current.href });
      return response;
    }
    if (hop >= maxRedirects) {
      await response.body?.cancel().catch(() => undefined);
      throw new EgressBlockedError("too many redirects");
    }
    await response.body?.cancel().catch(() => undefined);
    current = new URL(location, current);
    if (current.origin !== origin) {
      for (const name of CROSS_ORIGIN_DROPPED_HEADERS) headers.delete(name);
    }
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = null;
    }
  }
}
