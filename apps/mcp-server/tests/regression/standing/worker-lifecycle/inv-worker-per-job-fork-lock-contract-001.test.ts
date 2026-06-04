// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001 (Plan v4.5 PR3 Track 2 §5.1)
 *
 * IO Plan Decision V1 anchor: `019e4267-d21e-7775-b956-544df059d328`
 *
 * ## Contract / 不変条件
 *
 * For every job dispatched to the per-job fork-only backfill worker,
 * `acquirePerJobSubChildLock` MUST:
 *   - return success with a unique Redis key matching
 *     `reftrix:worker:active:embedding-backfill:job:<jobId>`;
 *   - reject a 2nd spawn within 500ms (Redis server-side TIME, SEC M-01) as
 *     `rate_limited` (fail-closed);
 *   - reject a `race_lost` (SET NX lost) as fail-closed;
 *   - release explicitly only when BOTH nonce AND bootEpoch match (§4.2.2
 *     CWE-367 double-verify); auto-release via TTL when the holder dies;
 *   - exit-0 / Lua-release race-window timing (TDA-PR3-04): release-after-exit
 *     never deletes a later owner's lock.
 *
 * @see Plan v4.5 PR3 V1 §5.1 / §4.2.1 / §4.2.2 / §4.5
 * @see ADR-0011 Amendment 3 (Redis TIME server-side monotonic pin)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  WorkerActiveLockService,
  PER_JOB_LOCK_KEY_NAMESPACE,
  generateBootToken,
} from "../../../../src/services/worker-active-lock.service";
import { assertInvName } from "../_setup/inv-assert";

function createRealRedisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("[INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001] REDIS_URL not set by globalSetup");
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

async function cleanupPerJobKeys(inspector: Redis): Promise<void> {
  const keys = await inspector.keys(`${PER_JOB_LOCK_KEY_NAMESPACE}*`);
  if (keys.length > 0) await inspector.del(...keys);
  await inspector.del("reftrix:worker:active:embedding-backfill:rate");
}

describe("INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001: per-job sub-child lock acquire / rate-limit / race-lost / nonce+bootEpoch release (Plan v4.5 PR3 Track 2 §5.1)", () => {
  let inspector: Redis;
  let svc: WorkerActiveLockService;
  let redis: Redis;

  beforeEach(async () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001"
    );
    inspector = createRealRedisClient();
    await cleanupPerJobKeys(inspector);
    redis = createRealRedisClient();
    svc = new WorkerActiveLockService({ redis });
    await svc.pinLuaScripts();
  });

  afterEach(async () => {
    await cleanupPerJobKeys(inspector);
    await svc.close();
    await redis.quit();
    await inspector.quit();
  });

  it("INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001: acquire returns ok with the per-job namespaced key and stores nonce+bootEpoch payload", async () => {
    const jobId = "job-A1";
    const nonce = generateBootToken();
    const bootEpoch = generateBootToken();
    const r = await svc.acquirePerJobSubChildLock(jobId, nonce, bootEpoch);
    // Falsifier: if the key were not job-namespaced, two jobs would collide.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.key).toBe(`${PER_JOB_LOCK_KEY_NAMESPACE}${jobId}`);
      expect(r.nonce).toBe(nonce);
      expect(r.bootEpoch).toBe(bootEpoch);
    }
    const stored = await inspector.get(`${PER_JOB_LOCK_KEY_NAMESPACE}${jobId}`);
    expect(stored).not.toBeNull();
    const payload = JSON.parse(stored as string) as { nonce: string; bootEpoch: string };
    expect(payload.nonce).toBe(nonce);
    expect(payload.bootEpoch).toBe(bootEpoch);
  });

  it("INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001: 2 spawns within 500ms → 2nd is rate_limited (fail-closed, Redis server-side TIME)", async () => {
    const bootEpoch = generateBootToken();
    const first = await svc.acquirePerJobSubChildLock("job-rl-1", generateBootToken(), bootEpoch);
    expect(first.ok).toBe(true);
    // Immediately attempt a different job (< 500ms elapsed) → rate_limited.
    const second = await svc.acquirePerJobSubChildLock("job-rl-2", generateBootToken(), bootEpoch);
    // Falsifier: a caller-clock-based rate-limit could be bypassed by skew; the
    // Redis server-side TIME pin MUST reject the immediate 2nd spawn.
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("rate_limited");
      expect(second.failOpen).toBe(false);
      expect(Number.isFinite(second.retryAfterMs)).toBe(true);
    }
  });

  it("INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001: race_lost when the same jobId key is already held by another owner (fail-closed)", async () => {
    const jobId = "job-race";
    // Pre-acquire with a 0ms rate-limit so the 2nd acquire is NOT rate-limited
    // and instead hits SET NX race-lost on the same key.
    const r1 = await svc.acquirePerJobSubChildLock(
      "seed",
      generateBootToken(),
      generateBootToken(),
      {
        minIntervalMs: 0,
      }
    );
    expect(r1.ok).toBe(true);
    const owner = await svc.acquirePerJobSubChildLock(
      jobId,
      generateBootToken(),
      generateBootToken(),
      {
        minIntervalMs: 0,
      }
    );
    expect(owner.ok).toBe(true);
    const contender = await svc.acquirePerJobSubChildLock(
      jobId,
      generateBootToken(),
      generateBootToken(),
      { minIntervalMs: 0 }
    );
    // Falsifier: without SET NX, the contender would overwrite the live owner.
    expect(contender.ok).toBe(false);
    if (!contender.ok) {
      expect(contender.reason).toBe("race_lost");
      expect(contender.failOpen).toBe(false);
    }
  });

  it("INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001: release deletes ONLY when BOTH nonce AND bootEpoch match (§4.2.2 CWE-367 double-verify)", async () => {
    const jobId = "job-rel";
    const nonce = generateBootToken();
    const bootEpoch = generateBootToken();
    const r = await svc.acquirePerJobSubChildLock(jobId, nonce, bootEpoch, { minIntervalMs: 0 });
    expect(r.ok).toBe(true);

    // Wrong nonce → MUST NOT release (foreign owner protection).
    const wrongNonce = await svc.releasePerJobSubChildLock(jobId, generateBootToken(), bootEpoch);
    expect(wrongNonce).toBe(false);
    // Wrong bootEpoch (e.g. a restarted supervisor) → MUST NOT release a live owner.
    const wrongEpoch = await svc.releasePerJobSubChildLock(jobId, nonce, generateBootToken());
    expect(wrongEpoch).toBe(false);
    // Key MUST still exist after both refused releases.
    expect(await inspector.get(`${PER_JOB_LOCK_KEY_NAMESPACE}${jobId}`)).not.toBeNull();

    // Correct nonce + bootEpoch → releases.
    const ok = await svc.releasePerJobSubChildLock(jobId, nonce, bootEpoch);
    // Falsifier: a nonce-only check would have let the wrong-bootEpoch release
    // delete a later owner's lock (the CWE-367 race this closes).
    expect(ok).toBe(true);
    expect(await inspector.get(`${PER_JOB_LOCK_KEY_NAMESPACE}${jobId}`)).toBeNull();
  });

  it("INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001: exit-0/Lua-release race window (TDA-PR3-04) — release after holder churn never deletes a NEW owner's lock", async () => {
    const jobId = "job-window";
    const epochA = generateBootToken();
    const nonceA = generateBootToken();
    // Owner A acquires.
    const a = await svc.acquirePerJobSubChildLock(jobId, nonceA, epochA, { minIntervalMs: 0 });
    expect(a.ok).toBe(true);
    // Owner A releases (exit 0).
    expect(await svc.releasePerJobSubChildLock(jobId, nonceA, epochA)).toBe(true);
    // A NEW owner B acquires the same jobId key (post-A churn).
    const epochB = generateBootToken();
    const nonceB = generateBootToken();
    const b = await svc.acquirePerJobSubChildLock(jobId, nonceB, epochB, { minIntervalMs: 0 });
    expect(b.ok).toBe(true);
    // A LATE release from A (race window) MUST be a no-op against B's lock.
    const lateA = await svc.releasePerJobSubChildLock(jobId, nonceA, epochA);
    // Falsifier: a key-only DEL would delete B's lock here (the race window bug).
    expect(lateA).toBe(false);
    expect(await inspector.get(`${PER_JOB_LOCK_KEY_NAMESPACE}${jobId}`)).not.toBeNull();
  });
});
