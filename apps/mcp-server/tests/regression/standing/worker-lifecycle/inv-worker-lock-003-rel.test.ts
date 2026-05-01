// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-LOCK-003-REL: `releaseLock` は Lua atomic で **自 nonce 一致時のみ削除**。
 *   - own nonce: key 削除、return 1 (true)
 *   - 別 nonce: key 残存、return 0 (false)
 *   - lock 不在: return 0 (false)
 *
 * INV-WORKER-LOCK-003-REL: `releaseLock` is Lua-atomic and **deletes only on
 * own-nonce match**. Owner nonce → delete + return true; foreign nonce → no-op
 * + return false; absent lock → return false.
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
    throw new Error("[INV-WORKER-LOCK-003-REL] REDIS_URL not set by globalSetup");
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

describe("INV-WORKER-LOCK-003-REL: Lua-atomic release respects nonce ownership", () => {
  let inspector: Redis;

  beforeEach(async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LOCK-003-REL");
    inspector = createRealRedisClient();
    await inspector.del(LOCK_KEY);
  });

  afterEach(async () => {
    await inspector.del(LOCK_KEY);
    await inspector.quit();
  });

  it("INV-WORKER-LOCK-003-REL: 自 nonce で releaseLock すると key が削除され true を返す / own-nonce releaseLock deletes the key and returns true", async () => {
    const redis = createRealRedisClient();
    const lockService = new WorkerActiveLockService({ redis });
    const nonce = generateBootToken();

    const acquired = await lockService.tryAcquireLock("page", nonce);
    expect(acquired).toEqual({ ok: true });

    const released = await lockService.releaseLock("page", nonce);
    expect(released).toBe(true);

    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBeNull();

    await redis.quit();
  });

  it("INV-WORKER-LOCK-003-REL: 別 nonce で releaseLock すると key は削除されず false を返す / foreign-nonce releaseLock leaves the key intact and returns false", async () => {
    const ownerRedis = createRealRedisClient();
    const ownerService = new WorkerActiveLockService({ redis: ownerRedis });
    const ownerNonce = generateBootToken();

    const acquired = await ownerService.tryAcquireLock("page", ownerNonce);
    expect(acquired).toEqual({ ok: true });

    const intruderRedis = createRealRedisClient();
    const intruderService = new WorkerActiveLockService({ redis: intruderRedis });
    const intruderNonce = generateBootToken();
    expect(intruderNonce).not.toBe(ownerNonce);

    const released = await intruderService.releaseLock("page", intruderNonce);
    expect(released).toBe(false);

    // key は owner nonce のまま残存
    // key remains owned by the original nonce.
    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBe(ownerNonce);

    await ownerRedis.quit();
    await intruderRedis.quit();
  });

  it("INV-WORKER-LOCK-003-REL: 不在 lock の releaseLock は no-op で false を返す / releaseLock on an absent lock is a no-op returning false", async () => {
    const redis = createRealRedisClient();
    const lockService = new WorkerActiveLockService({ redis });

    const released = await lockService.releaseLock("page", generateBootToken());
    expect(released).toBe(false);

    const stored = await inspector.get(LOCK_KEY);
    expect(stored).toBeNull();

    await redis.quit();
  });
});
