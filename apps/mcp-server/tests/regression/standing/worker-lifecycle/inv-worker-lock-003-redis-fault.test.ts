// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-LOCK-003-RACE / INV-WORKER-LOCK-003-UNREACH:
 *
 * - **RACE (fail-closed)**: 後発 `tryAcquireLock` は `{ ok: false, reason:
 *   "already_held" }` を返し、先発のみ job consume 権を保持する。`probeExistingLock`
 *   は `{ unavailable: false, exists: true, nonce: <ownerNonce> }` を返す。
 *
 * - **UNREACH (fail-open)**: Redis 到達不能時、`tryAcquireLock` は
 *   `{ ok: false, reason: "redis_unavailable", error: <string> }`、
 *   `probeExistingLock` は `{ unavailable: true, error: <string> }` を返す。
 *   呼び出し側はこの discriminated union により race-lost (fail-closed) と
 *   Redis 不可到達 (fail-open) を明示的に区別できる (PR7d-3 SEC M-1)。
 *
 * INV-WORKER-LOCK-003-RACE / INV-WORKER-LOCK-003-UNREACH:
 *
 * - RACE (fail-closed): the late `tryAcquireLock` returns
 *   `{ ok: false, reason: "already_held" }`; only the early caller may consume
 *   jobs. `probeExistingLock` reports the existing owner.
 * - UNREACH (fail-open): on Redis unreachability, `tryAcquireLock` returns
 *   `{ ok: false, reason: "redis_unavailable" }` and `probeExistingLock`
 *   returns `{ unavailable: true }`. The discriminated union (PR7d-3 SEC M-1)
 *   lets callers distinguish race-lost from Redis-unreachable.
 *
 * @see ADR-0016 § Invariants
 * @see ADR-0011 (Worker Dual-run Lock) — discriminated union API + PR7d-3 SEC M-1
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  WorkerActiveLockService,
  generateBootToken,
} from "../../../../src/services/worker-active-lock.service";
import { assertInvName } from "../_setup/inv-assert";

const LOCK_KEY = "reftrix:worker:active:page";

function createRealRedisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("[INV-WORKER-LOCK-003-RACE] REDIS_URL not set by globalSetup");
  }
  const parsed = new URL(url);
  return new Redis({
    host: parsed.hostname,
    port: parseInt(parsed.port, 10),
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    lazyConnect: false,
  });
}

/**
 * Construct a Redis client that points at an unroutable port so any command
 * deterministically fails with a transport error. We prefer the IANA-blackholed
 * `127.0.0.1:1` (TCPMUX historical) for a fast ECONNREFUSED on Linux/macOS CI
 * runners. fail-fast settings (3 retries / no offline queue) ensure each call
 * resolves quickly within standing-suite timeouts.
 *
 * 到達不能 Redis を作るため、ECONNREFUSED が確定する 127.0.0.1:1 を指す client を
 * 用意する。fail-fast 設定で standing suite の timeout 内に必ず resolve する。
 */
function createUnreachableRedisClient(): Redis {
  return new Redis({
    host: "127.0.0.1",
    port: 1,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
    connectTimeout: 1_000,
    retryStrategy: (): null => null, // never retry
  });
}

describe("INV-WORKER-LOCK-003-RACE: dual-run race-lost is reported as already_held", () => {
  let inspector: Redis;

  beforeEach(async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LOCK-003-RACE");
    inspector = createRealRedisClient();
    await inspector.del(LOCK_KEY);
  });

  afterEach(async () => {
    await inspector.del(LOCK_KEY);
    await inspector.quit();
  });

  it("INV-WORKER-LOCK-003-RACE: 後発 tryAcquireLock は ok=false, reason='already_held' を返す / late tryAcquireLock returns ok=false reason='already_held' (fail-closed)", async () => {
    const winnerRedis = createRealRedisClient();
    const winnerService = new WorkerActiveLockService({ redis: winnerRedis });
    const winnerNonce = generateBootToken();

    const winResult = await winnerService.tryAcquireLock("page", winnerNonce);
    expect(winResult).toEqual({ ok: true });

    const loserRedis = createRealRedisClient();
    const loserService = new WorkerActiveLockService({ redis: loserRedis });
    const loserNonce = generateBootToken();
    expect(loserNonce).not.toBe(winnerNonce);

    const loseResult = await loserService.tryAcquireLock("page", loserNonce);
    expect(loseResult).toEqual({ ok: false, reason: "already_held" });

    // probeExistingLock returns the winner nonce (not unavailable).
    // probeExistingLock は winner の nonce を返す (unavailable ではない)。
    const probe = await loserService.probeExistingLock("page");
    expect(probe).toEqual({ unavailable: false, exists: true, nonce: winnerNonce });

    // Underlying Redis still owned by winner.
    // Redis 上 key は winner の nonce のまま。
    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBe(winnerNonce);

    await winnerRedis.quit();
    await loserRedis.quit();
  });

  it("INV-WORKER-LOCK-003-RACE: legacy boolean acquireLock も同条件で false を返す (互換性) / legacy boolean acquireLock returns false under the same race (compat)", async () => {
    const winnerRedis = createRealRedisClient();
    const winnerService = new WorkerActiveLockService({ redis: winnerRedis });
    const winnerNonce = generateBootToken();
    await winnerService.tryAcquireLock("page", winnerNonce);

    const loserRedis = createRealRedisClient();
    const loserService = new WorkerActiveLockService({ redis: loserRedis });

    // Legacy boolean API — must still report false on race-lost.
    // 後方互換 boolean API は race-lost 時 false を返す。
    const legacy = await loserService.acquireLock("page", generateBootToken());
    expect(legacy).toBe(false);

    await winnerRedis.quit();
    await loserRedis.quit();
  });
});

describe("INV-WORKER-LOCK-003-UNREACH: Redis-unreachable is reported as redis_unavailable / unavailable", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LOCK-003-UNREACH");
  });

  it("INV-WORKER-LOCK-003-UNREACH: tryAcquireLock は redis_unavailable を返し fail-open シグナルを与える / tryAcquireLock returns redis_unavailable as a fail-open signal", async () => {
    const unreachable = createUnreachableRedisClient();
    const lockService = new WorkerActiveLockService({ redis: unreachable });

    const result = await lockService.tryAcquireLock("page", generateBootToken());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("redis_unavailable");
      // Sanitized error string is included so callers can log it (no internal leakage).
      // sanitize 済みエラー文字列が含まれる (内部状態は漏洩しない)。
      expect(typeof (result as { error?: unknown }).error).toBe("string");
    }

    unreachable.disconnect();
  });

  it("INV-WORKER-LOCK-003-UNREACH: probeExistingLock は unavailable=true を返し fail-open vs fail-closed を呼び出し側に明示する / probeExistingLock returns unavailable=true so callers can distinguish fail-open from fail-closed", async () => {
    const unreachable = createUnreachableRedisClient();
    const lockService = new WorkerActiveLockService({ redis: unreachable });

    const probe = await lockService.probeExistingLock("page");
    expect(probe.unavailable).toBe(true);
    if (probe.unavailable === true) {
      expect(typeof probe.error).toBe("string");
    }

    unreachable.disconnect();
  });

  it("INV-WORKER-LOCK-003-UNREACH: legacy checkExistingLock は null を返す (discriminated union 化前の semantics 維持) / legacy checkExistingLock returns null preserving pre-discriminated semantics", async () => {
    const unreachable = createUnreachableRedisClient();
    const lockService = new WorkerActiveLockService({ redis: unreachable });

    // Legacy collapsing API: lock-absent と Redis-unreachable をどちらも null に潰す。
    // Legacy API collapses lock-absent and Redis-unreachable to null — kept for
    // backward compatibility but new code should use probeExistingLock.
    const legacy = await lockService.checkExistingLock("page");
    expect(legacy).toBeNull();

    unreachable.disconnect();
  });
});
