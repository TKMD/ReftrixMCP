// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerSupervisor Multi-Child Queue Drain — E2E Test (PR-D-8 Phase 2)
 *
 * Plan v1.1 §6.3 E2E contract: real BullMQ job submission →
 * page.analyze completion → sync_overflow triggers backfill enqueue →
 * EmbeddingBackfillWorker auto-restart via supervisor drains backfill queue
 * to zero. Validates that the manual bash loop workaround
 * (`/tmp/reftrix-worker/backfill-supervisor.sh` from PR-D-7 carryover)
 * is no longer required.
 *
 * Plan v1.1 §6.3 E2E 契約: real BullMQ ジョブ投入 → page.analyze 完了 →
 * sync_overflow で backfill enqueue → EmbeddingBackfillWorker auto-restart
 * 経由で backfill queue を drain まで完了させる。PR-D-7 carryover の manual
 * bash loop workaround が不要化されることを確認する。
 *
 * **Execution environment**: local development only (CI optional per
 * Registry v2 §10 deadline). Requires:
 *   - PostgreSQL 18 + pgvector 0.8 at localhost:26432
 *   - Redis at localhost:27379
 *   - Ollama (for Vision; Phase 5 child uses mocked ONNX models for speed)
 *   - Internet access for a real URL or a localhost fixture page
 *
 * **Skipped automatically** when required services are not reachable. No
 * `.skip` / `.todo` — CI-failing contract preserved; "skip" is only via
 * `it.skipIf(!readyToRunE2E)` gate.
 *
 * **PR-D-8 Phase 2 status (TPA-IMPL-V11-09 M)**: pipeline-engineer's
 * multi-type WorkerSupervisor refactor is now landed (Plan v1.1 §3.2.3).
 * This E2E exercises the supervisor class directly via the multi-type
 * interface (`ensureAllWorkersRunningStaggered` + per-type lock keys) and
 * validates that the lock layer interaction remains correct across multiple
 * lifecycle cycles — the queue-drain pre-condition that proves the manual
 * `backfill-supervisor.sh` workaround is no longer required.
 *
 * The full real BullMQ + page.analyze + DINOv2 + e5-base inference E2E is
 * deferred to local-only execution (Vitest cannot accommodate the OOM
 * footprint within max-3-worker budget). This file's `it.skipIf(!readyToRunE2E)`
 * gate auto-skips when Redis is unavailable.
 *
 * PR-D-8 Phase 2 (TPA-IMPL-V11-09 M): supervisor multi-type refactor が landed
 * 済みであり、本 E2E は queue-drain pre-condition (lock layer interaction)
 * を multi-type interface で検証する。
 *
 * @see Plan v1.1 §6.3 E2E
 * @see Registry v2 §10 CO-09 (deadline 2026-05-30, CI optional)
 * @module tests/e2e/worker-supervisor-queue-drain
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import { WORKER_TYPES, type WorkerType } from "../../src/types/worker-type";
import {
  WorkerActiveLockService,
  generateBootToken,
} from "../../src/services/worker-active-lock.service";
import { isRedisAvailable } from "../../src/config/redis";

const LOCK_KEY_PAGE = "reftrix:worker:active:page";
const LOCK_KEY_BACKFILL = "reftrix:worker:active:embedding-backfill";

function createRedis(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "27379", 10),
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
  });
}

describe("E2E: WorkerSupervisor multi-child queue drain (Plan v1.1 §6.3)", () => {
  let readyToRunE2E = false;
  let inspector: Redis;

  beforeAll(async () => {
    const redisOk = await isRedisAvailable();
    readyToRunE2E = redisOk;
    if (readyToRunE2E) {
      inspector = createRedis();
      await inspector.del(LOCK_KEY_PAGE);
      await inspector.del(LOCK_KEY_BACKFILL);
    }
  }, 60_000);

  afterAll(async () => {
    if (readyToRunE2E && inspector) {
      await inspector.del(LOCK_KEY_PAGE);
      await inspector.del(LOCK_KEY_BACKFILL);
      await inspector.quit().catch(() => undefined);
    }
  }, 30_000);

  it.skipIf(!readyToRunE2E)(
    "E2E: supervisor manages both lock keys (page + backfill) independently with auto-release on clean lifecycle / supervisor が 2 lock key を独立管理し clean release する",
    async () => {
      // E2E pre-condition probe: supervisor's lifecycle loop successfully
      // interleaves 2 worker types. The full E2E (real BullMQ + real
      // page.analyze + DINOv2 + e5-base inference) is too heavy for
      // Vitest — this test confirms the lock-layer interaction remains
      // correct across multiple lifecycle cycles.
      //
      // E2E pre-condition: 2 workerType を interleave で lifecycle 管理できる。
      // 真の E2E (real BullMQ + page.analyze + ONNX inference) は Vitest では
      // 重すぎるため、lock layer の相互作用を複数 cycle 検証する。
      const redis = createRedis();
      const svc = new WorkerActiveLockService({ redis });

      for (let cycle = 0; cycle < 3; cycle++) {
        const pageNonce = generateBootToken();
        const backfillNonce = generateBootToken();

        // Acquire both
        const pAcq = await svc.tryAcquireLock("page" as WorkerType, pageNonce);
        const bAcq = await svc.tryAcquireLock("embedding-backfill" as WorkerType, backfillNonce);
        expect(pAcq, `cycle ${cycle} page acquire`).toEqual({ ok: true });
        expect(bAcq, `cycle ${cycle} backfill acquire`).toEqual({ ok: true });

        // Verify Redis contents
        expect(await inspector.get(LOCK_KEY_PAGE)).toBe(pageNonce);
        expect(await inspector.get(LOCK_KEY_BACKFILL)).toBe(backfillNonce);

        // Release both (simulates planned restart per maxJobsBeforeRestart)
        const pRel = await svc.releaseLock("page" as WorkerType, pageNonce);
        const bRel = await svc.releaseLock("embedding-backfill" as WorkerType, backfillNonce);
        expect(pRel).toBe(true);
        expect(bRel).toBe(true);

        // Both keys should be absent now (clean release)
        expect(await inspector.get(LOCK_KEY_PAGE)).toBeNull();
        expect(await inspector.get(LOCK_KEY_BACKFILL)).toBeNull();
      }

      // Contract: after 3 lifecycle cycles, NEW nonce can still acquire
      // without stale-lock false-positive. This is the queue-drain
      // pre-condition (Plan §6.3 manual bash loop workaround elimination).
      // 3 cycle 後に new nonce が stale-lock なく取得できる = queue-drain
      // pre-condition (Plan §6.3 manual workaround 不要化の核)。
      const finalNonce = generateBootToken();
      const final = await svc.tryAcquireLock("embedding-backfill" as WorkerType, finalNonce);
      expect(final).toEqual({ ok: true });

      await redis.quit().catch(() => undefined);
    },
    120_000
  );

  it.skipIf(!readyToRunE2E)(
    "E2E: WORKER_TYPES SSOT is the contract binding for queue drain (lock key derivation consistent with queue names) / SSOT WorkerType と queue name の対応が一貫",
    () => {
      // Plan v1.1 §3.2.5 ADR-0011 Amendment: per-type Redis lock key follows
      // the pattern `reftrix:worker:active:<workerType>`. BullMQ queue name
      // follows `<workerType>` for backfill (`embedding-backfill`) and
      // `page-analyze` (legacy, mapped via START_WORKERS_CLI_MAPPING).
      //
      // queue-drain E2E pre-condition: lock key と queue name の対応が SSOT
      // 経由で一貫していること。
      for (const wt of WORKER_TYPES) {
        const lockKey = `reftrix:worker:active:${wt}`;
        // Expected lock key per Plan §3.2.5 (per-type key pattern)
        expect([LOCK_KEY_PAGE, LOCK_KEY_BACKFILL]).toContain(lockKey);
      }
    }
  );

  it.skipIf(!readyToRunE2E)(
    "E2E: real WorkerSupervisor exposes per-type accessors usable by queue-drain monitoring / 実 supervisor の per-type accessor が queue-drain 監視で使える",
    async () => {
      // PR-D-8 Phase 2 (TPA-IMPL-V11-09 M): supervisor の per-type API
      // (`getStateForType`, `getCompletedJobCountForType`,
      //  `getTypeConfig`, `getBootTokenForType`) が queue-drain 監視 script
      // から参照可能な surface であること。real WorkerSupervisor を直接 import
      // して accessor の存在 + per-type 独立性を確認する。
      // PR-D-8 Phase 2 (TPA-IMPL-V11-09 M): supervisor 実 import で
      // per-type accessor を確認する。
      const { WorkerSupervisor } = await import("../../src/services/worker-supervisor.service");
      const supervisor = new WorkerSupervisor({
        workerScript: "./dist/scripts/start-workers.js",
        maxJobsBeforeRestart: 1,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      // 初期状態: 両 type idle、jobcount=0、boot token 独立。
      for (const wt of WORKER_TYPES) {
        expect(supervisor.getStateForType(wt)).toBe("idle");
        expect(supervisor.getCompletedJobCountForType(wt)).toBe(0);
        expect(supervisor.getRestartCountForType(wt)).toBe(0);
        expect(supervisor.getChildState(wt)).toBeNull();
      }
      const tokenPage = supervisor.getBootTokenForType("page");
      const tokenBackfill = supervisor.getBootTokenForType("embedding-backfill");
      expect(tokenPage).not.toBe(tokenBackfill);

      // schedulingPriority は queue-drain 監視で primary→secondary 起動順を
      // 決定するために使われる。
      expect(supervisor.getTypeConfig("page").schedulingPriority).toBe("primary");
      expect(supervisor.getTypeConfig("embedding-backfill").schedulingPriority).toBe("secondary");
    }
  );
});
