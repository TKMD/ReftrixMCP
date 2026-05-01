// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-LOCK-003-ACQ: `tryAcquireLock` 成功時、Redis に
 * `reftrix:worker:active:page` key が SET NX で atomic に書き込まれ、
 * value が caller の nonce と一致し、`AcquireLockResult` が `{ ok: true }` を返す。
 *
 * INV-WORKER-LOCK-003-ACQ: `tryAcquireLock` success path — Redis key
 * `reftrix:worker:active:page` is set atomically (SET NX), value equals the
 * caller nonce, and `AcquireLockResult` is `{ ok: true }`.
 *
 * @see ADR-0016 § Invariants
 * @see ADR-0011 (Worker Dual-run Lock) — discriminated union API
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import {
  WorkerActiveLockService,
  generateBootToken,
} from "../../../../src/services/worker-active-lock.service";
import { tryAcquireLockWithRetry } from "../../../../src/services/worker-supervisor-helpers";
import { assertInvName } from "../_setup/inv-assert";

const LOCK_KEY = "reftrix:worker:active:page";

function createRealRedisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("[INV-WORKER-LOCK-003-ACQ] REDIS_URL not set by globalSetup");
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

describe("INV-WORKER-LOCK-003-ACQ: Redis dual-run lock acquisition", () => {
  let inspector: Redis;

  beforeEach(async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LOCK-003-ACQ");
    inspector = createRealRedisClient();
    await inspector.del(LOCK_KEY);
  });

  afterEach(async () => {
    await inspector.del(LOCK_KEY);
    await inspector.quit();
  });

  it("INV-WORKER-LOCK-003-ACQ: tryAcquireLock 成功時に Redis key が atomic に書き込まれ value が caller nonce と一致する / writes the Redis key atomically with the caller nonce on success", async () => {
    const redis = createRealRedisClient();
    const lockService = new WorkerActiveLockService({ redis });
    const nonce = generateBootToken();

    const result = await lockService.tryAcquireLock("page", nonce);
    expect(result).toEqual({ ok: true });

    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBe(nonce);

    const ttlMs = await inspector.pttl(LOCK_KEY);
    // LOCK_TTL_SECONDS = 60 (service constant). Allow slack for round-trip jitter.
    // LOCK_TTL_SECONDS = 60 (service constant)。RTT のジッタを許容して 50_000-60_500ms に絞る。
    expect(ttlMs).toBeGreaterThanOrEqual(50_000);
    expect(ttlMs).toBeLessThanOrEqual(60_500);

    await redis.quit();
  });

  it("INV-WORKER-LOCK-003-ACQ: 同一 caller の二回目 tryAcquireLock は SET NX により already_held を返す / second tryAcquireLock from the same caller returns already_held due to SET NX semantics", async () => {
    const redis = createRealRedisClient();
    const lockService = new WorkerActiveLockService({ redis });
    const nonce = generateBootToken();

    const first = await lockService.tryAcquireLock("page", nonce);
    expect(first).toEqual({ ok: true });

    // Same caller, second invocation — SET NX must reject because the key already exists.
    // 同一 caller で再度呼んでも SET NX により拒否される (key 既存)。
    const second = await lockService.tryAcquireLock("page", nonce);
    expect(second).toEqual({ ok: false, reason: "already_held" });

    // Underlying key is unchanged (still the original nonce).
    // Redis key 自体は変更されない (元の nonce のまま)。
    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBe(nonce);

    await redis.quit();
  });

  it("INV-WORKER-LOCK-003-ACQ: 空 nonce はバリデーションで throw して Redis を一切触らない / empty nonce throws on validation without touching Redis", async () => {
    const redis = createRealRedisClient();
    const lockService = new WorkerActiveLockService({ redis });

    await expect(lockService.tryAcquireLock("page", "")).rejects.toThrow(/nonce/);

    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBeNull();

    await redis.quit();
  });
});

// =============================================================================
// Item 3 (CO-31) — page worker fail-open recovery via tryAcquireLockWithRetry
// =============================================================================

/**
 * INV-WORKER-LOCK-003: page worker fail-open recovery via
 * tryAcquireLockWithRetry on transient Redis failure.
 *
 * Plan v0.2 §4.4 SEC-03 L: stub-based fault injection (real Redis disconnect
 * is rejected — flaky risk + credential leak surface). Test wraps the real
 * `WorkerActiveLockService` and stubs only the `tryAcquireLock` method to
 * return `{ ok: false, reason: "redis_unavailable" }` on the first attempt
 * before delegating to the real implementation on retry, exercising the CO-31
 * retry path against a real Redis backend.
 *
 * INV-WORKER-LOCK-003: page worker の fail-open recovery を
 * `tryAcquireLockWithRetry` 経由で検証 (CO-31 closure)。
 *
 * @see ADR-0011 Amendment 5 §A5.1 (Acquire-side retry-with-backoff contract)
 * @see Plan v0.2 §4.4 (stub-based fault injection landing)
 */
describe("INV-WORKER-LOCK-003: page worker fail-open recovery via tryAcquireLockWithRetry on transient Redis failure", () => {
  let inspector: Redis;

  beforeEach(async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LOCK-003");
    inspector = createRealRedisClient();
    await inspector.del(LOCK_KEY);
  });

  afterEach(async () => {
    await inspector.del(LOCK_KEY);
    await inspector.quit();
    vi.restoreAllMocks();
  });

  it("INV-WORKER-LOCK-003: 1回目 redis_unavailable, 2回目 real success で retry-with-backoff が Redis に key を書き込む / retry-with-backoff writes the Redis key after transient redis_unavailable", async () => {
    const redis = createRealRedisClient();
    const lockService = new WorkerActiveLockService({ redis });
    const nonce = generateBootToken();

    // Stub-based fault injection per Plan v0.2 §4.4 SEC-03 L:
    // 1st attempt → redis_unavailable, 2nd attempt → delegate to real impl.
    // 1回目 redis_unavailable, 2回目以降は real impl にデリゲート。
    const realTryAcquireLock = lockService.tryAcquireLock.bind(lockService);
    const spy = vi
      .spyOn(lockService, "tryAcquireLock")
      .mockImplementationOnce(async () => ({
        ok: false,
        reason: "redis_unavailable",
        error: "stub injection",
      }))
      .mockImplementation((workerType, n) => realTryAcquireLock(workerType, n));

    const startedAt = Date.now();
    const outcome = await tryAcquireLockWithRetry(lockService, "page", nonce);
    const elapsed = Date.now() - startedAt;

    expect(outcome).toEqual({ ok: true, reason: "acquired", nonce });
    // Real Redis was actually written on the retry attempt.
    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBe(nonce);
    const ttlMs = await inspector.pttl(LOCK_KEY);
    expect(ttlMs).toBeGreaterThanOrEqual(50_000);
    expect(ttlMs).toBeLessThanOrEqual(60_500);
    // Spy invoked twice — retry path actually fired once.
    expect(spy).toHaveBeenCalledTimes(2);
    // Backoff before retry ≈ 100ms; allow CI jitter slack.
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThanOrEqual(800);

    await redis.quit();
  });

  it("INV-WORKER-LOCK-003: 3回連続 redis_unavailable で exhausted を返却し Redis key 不在 / 3 consecutive redis_unavailable exhaust retry budget without writing the key", async () => {
    const redis = createRealRedisClient();
    const lockService = new WorkerActiveLockService({ redis });
    const nonce = generateBootToken();

    const spy = vi.spyOn(lockService, "tryAcquireLock").mockResolvedValue({
      ok: false,
      reason: "redis_unavailable",
      error: "stub injection",
    });

    const startedAt = Date.now();
    const outcome = await tryAcquireLockWithRetry(lockService, "page", nonce);
    const elapsed = Date.now() - startedAt;

    expect(outcome).toEqual({ ok: false, reason: "exhausted" });
    // Redis side effect MUST be absent (stub blocked all attempts).
    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBeNull();
    expect(spy).toHaveBeenCalledTimes(3);
    // Backoff sequence: 100ms (after attempt 1) + 200ms (after attempt 2)
    // = 300ms minimum (3rd attempt exits without trailing sleep).
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThanOrEqual(1500);

    await redis.quit();
  });
});
