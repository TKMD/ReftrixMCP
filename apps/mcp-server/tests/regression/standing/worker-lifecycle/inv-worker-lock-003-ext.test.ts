// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-LOCK-003-EXT: `extendLock` は **自 nonce 一致時のみ** PEXPIRE で
 * TTL を 60 秒に refresh する (LOCK_TTL_SECONDS = 60、heartbeat 30s 間隔)。
 *
 *   - own nonce: TTL を 60s に refresh、return true
 *   - 別 nonce: TTL 維持 (refresh しない)、return false
 *   - lock 不在: return false
 *
 * INV-WORKER-LOCK-003-EXT: `extendLock` PEXPIRE refreshes TTL to 60s **only on
 * own-nonce match** (LOCK_TTL_SECONDS = 60, 30s heartbeat cadence).
 *
 * @see ADR-0016 § Invariants
 * @see ADR-0011 (Worker Dual-run Lock)
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
    throw new Error("[INV-WORKER-LOCK-003-EXT] REDIS_URL not set by globalSetup");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("INV-WORKER-LOCK-003-EXT: heartbeat-based TTL extension via Lua PEXPIRE", () => {
  let inspector: Redis;

  beforeEach(async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LOCK-003-EXT");
    inspector = createRealRedisClient();
    await inspector.del(LOCK_KEY);
  });

  afterEach(async () => {
    await inspector.del(LOCK_KEY);
    await inspector.quit();
  });

  it("INV-WORKER-LOCK-003-EXT: 自 nonce extendLock は TTL を 60s に refresh して true を返す / own-nonce extendLock refreshes TTL to 60s and returns true", async () => {
    const redis = createRealRedisClient();
    const lockService = new WorkerActiveLockService({ redis });
    const nonce = generateBootToken();

    await lockService.tryAcquireLock("page", nonce);
    // Wait so the TTL has measurably decreased before extend.
    // TTL が測定可能に減ってから extend するため少し待つ。
    await sleep(250);
    const ttlBeforeExtend = await inspector.pttl(LOCK_KEY);
    expect(ttlBeforeExtend).toBeGreaterThan(0);
    expect(ttlBeforeExtend).toBeLessThan(60_000);

    const extended = await lockService.extendLock("page", nonce);
    expect(extended).toBe(true);

    const ttlAfterExtend = await inspector.pttl(LOCK_KEY);
    expect(ttlAfterExtend).toBeGreaterThanOrEqual(50_000);
    expect(ttlAfterExtend).toBeLessThanOrEqual(60_500);
    // Refresh が確実に上向きであることを assert (前後比較)。
    // Strict refresh assertion: post >= pre + buffer.
    expect(ttlAfterExtend).toBeGreaterThan(ttlBeforeExtend);

    await redis.quit();
  });

  it("INV-WORKER-LOCK-003-EXT: 別 nonce extendLock は TTL を refresh せず false を返す / foreign-nonce extendLock leaves TTL unchanged and returns false", async () => {
    const ownerRedis = createRealRedisClient();
    const ownerService = new WorkerActiveLockService({ redis: ownerRedis });
    const ownerNonce = generateBootToken();
    await ownerService.tryAcquireLock("page", ownerNonce);

    await sleep(250);
    const ttlBefore = await inspector.pttl(LOCK_KEY);
    expect(ttlBefore).toBeGreaterThan(0);

    const intruderRedis = createRealRedisClient();
    const intruderService = new WorkerActiveLockService({ redis: intruderRedis });
    const extended = await intruderService.extendLock("page", generateBootToken());
    expect(extended).toBe(false);

    const ttlAfter = await inspector.pttl(LOCK_KEY);
    // 別 nonce では PEXPIRE が呼ばれないため TTL は減るのみ。refresh されない。
    // No PEXPIRE for foreign nonce — TTL must continue to decay, never refresh.
    expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);

    // owner nonce 自体も維持される。
    // Owner nonce remains the value.
    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBe(ownerNonce);

    await ownerRedis.quit();
    await intruderRedis.quit();
  });

  it("INV-WORKER-LOCK-003-EXT: 不在 lock の extendLock は no-op で false を返す / extendLock on an absent lock is a no-op returning false", async () => {
    const redis = createRealRedisClient();
    const lockService = new WorkerActiveLockService({ redis });

    const extended = await lockService.extendLock("page", generateBootToken());
    expect(extended).toBe(false);

    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBeNull();

    await redis.quit();
  });
});
