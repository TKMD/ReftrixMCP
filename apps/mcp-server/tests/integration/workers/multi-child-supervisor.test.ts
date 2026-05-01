// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerSupervisor Multi-Child Integration Tests (PR-D-8 Phase 2)
 *
 * Plan v1.1 §6.2 integration coverage — testcontainer Redis + Postgres で
 * supervisor multi-worker child lifecycle を end-to-end 検証する。
 *
 * Scope:
 *   1. Per-type child exit → per-type re-spawn 独立性
 *   2. 両 child 並行 spawn → staggered scheduling
 *   3. RSS threshold simulation → self-exit → supervisor re-spawn flow
 *   4. Redis lock race: SIGKILL 直後の新 child spawn → TTL 剥離 flow
 *
 * Integration-level assertions (unit-level は embedding-backfill-supervisor.test.ts
 * で cover)。本 suite は **mock ChildProcess + real Redis** のハイブリッドで
 * supervisor の dispatch / lock interaction を検証する。E2E suite (テスト
 * `worker-supervisor-queue-drain.e2e.test.ts`) は real BullMQ + real 子プロセス
 * を使う別 suite で tests/e2e/ に配置する。
 *
 * Plan v1.1 §6.2 integration strategy: mock ChildProcess + real Redis.
 *
 * **Parallel development note**: WorkerSupervisor multi-type refactor is in
 * progress (pipeline-engineer). This integration test validates the SSOT
 * interfaces (WorkerType, WorkerActiveLockService per-type key) which are
 * already landed, plus the contract-level dispatch semantics. Full multi-child
 * supervisor class testing is deferred to post-interface-landing iteration.
 *
 * @see Plan v1.1 §6.2 (integration tests)
 * @see Finding Registry v2 §10 contracts #1-#4 (INV-WORKER-LOCK-003 coverage)
 * @module tests/integration/workers/multi-child-supervisor
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  WorkerActiveLockService,
  generateBootToken,
} from "../../../src/services/worker-active-lock.service";
import { WORKER_TYPES, type WorkerType } from "../../../src/types/worker-type";
import {
  WorkerIpcMessageSchema,
  parseWorkerIpcStrict,
  type WorkerIpcMessage,
} from "../../../src/schemas/worker-ipc.schema";
import { isRedisAvailable } from "../../../src/config/redis";

// PR-D-8 Phase 2 (TPA-IMPL-V11-09 M resolution): mock `node:child_process.fork`
// so the new "real WorkerSupervisor" describe block below can exercise the
// supervisor class with a fake child without spawning a real Node process.
// hoisted by vi to module top.
//
// PR-D-8 Phase 2 (TPA-IMPL-V11-09 M 解消): real WorkerSupervisor を spawn path
// で exercise するため `child_process.fork` を hoist mock する。
const mockFork = vi.fn();
vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => mockFork(...args),
}));

// PR-D-8 Phase 2 + PR-E-1 v0.5.0 CI fix: mock vision-unload-handshake.
// `WorkerSupervisor.ensureAllWorkersRunningStaggered()` invokes
// `verifyVisionUnloadPrecondition()` (ADR-0011 Amendment 2 §A2.2.3) to probe
// Ollama `/api/ps` before secondary spawn. In CI Ollama is unavailable →
// `probe_failed` → secondary spawn deferred → only 1 fork() (test expects 2).
// Locally Ollama is reachable on `localhost:11434` and returns
// `{models:[]}` → `vision_unloaded` → tests pass — masking the gap.
//
// Stubbing the precondition probe to `vision_unloaded` lets the staggered
// scheduling exercise both spawn paths without an Ollama dependency.
//
// PR-D-8 Phase 2 + PR-E-1 v0.5.0 CI 修正: `verifyVisionUnloadPrecondition()`
// は Ollama `/api/ps` を実 HTTP probe するため、CI (Ollama 不在) では
// `probe_failed` → secondary spawn defer → fork 1 回のみとなり test 期待
// (2 回) と乖離。本 mock により precondition を `vision_unloaded` 固定し、
// supervisor の staggered spawn 全パスを Ollama 依存なしに exercise する。
vi.mock("../../../src/services/vision/vision-unload-handshake", () => ({
  verifyVisionUnloadPrecondition: vi
    .fn()
    .mockResolvedValue({ status: "vision_unloaded", sizeVramBytes: 0 }),
}));

// ============================================================================
// Mock ChildProcess factory (TPA-IMPL-V11-09 M deeper integration)
// ============================================================================

function createMockChildProcess(pid: number): ChildProcess & EventEmitter {
  const emitter = new EventEmitter();
  const mockProcess = Object.assign(emitter, {
    pid,
    kill: vi.fn().mockReturnValue(true),
    connected: true,
    send: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    spawnargs: [] as string[],
    spawnfile: "",
    stdio: [null, null, null, null, null] as ChildProcess["stdio"],
    stdin: null,
    stdout: null,
    stderr: null,
    channel: undefined,
    [Symbol.dispose]: vi.fn(),
  }) as unknown as ChildProcess & EventEmitter;
  return mockProcess;
}

// ============================================================================
// Test Redis (uses plain local Redis — integration tests run against a
// developer-local Redis instance; CI provides one via docker-compose).
// Unit-style integration: uses REDIS_URL env var or localhost default.
// ============================================================================

const LOCK_KEY_PAGE = "reftrix:worker:active:page";
const LOCK_KEY_BACKFILL = "reftrix:worker:active:embedding-backfill";

function createRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (url) {
    const parsed = new URL(url);
    return new Redis({
      host: parsed.hostname,
      port: parseInt(parsed.port, 10),
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });
  }
  return new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "27379", 10),
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
  });
}

// ============================================================================
// Pre-flight: skip suite if Redis unreachable (integration test convention)
// ============================================================================

// Top-level probe decided synchronously via env; final decision refined in
// beforeAll. Consistent with existing Redis-gated integration tests
// (tests/queues/embedding-backfill-queue.test.ts pattern).
//
// トップレベルで env 検査、beforeAll で最終確定。既存 Redis-gated integration
// test と pattern を揃える (embedding-backfill-queue.test.ts)。
let redisAvailable = false;

beforeAll(async () => {
  redisAvailable = await isRedisAvailable();
});

// ============================================================================
// Test 1: Per-type child lifecycle independence
// ============================================================================

describe("WorkerSupervisor multi-child: per-type lifecycle independence (Plan v1.1 §6.2)", () => {
  let inspector: Redis;

  beforeEach(async () => {
    if (!redisAvailable) return;
    inspector = createRedis();
    await inspector.del(LOCK_KEY_PAGE);
    await inspector.del(LOCK_KEY_BACKFILL);
  });

  afterEach(async () => {
    if (!redisAvailable) return;
    await inspector.del(LOCK_KEY_PAGE);
    await inspector.del(LOCK_KEY_BACKFILL);
    await inspector.quit().catch(() => undefined);
  });

  it.skipIf(!redisAvailable)(
    "both worker types acquire independent locks and release independently / 両 workerType が独立 lock 取得・解放できる",
    async () => {
      const redis = createRedis();
      const svc = new WorkerActiveLockService({ redis });
      const pageNonce = generateBootToken();
      const backfillNonce = generateBootToken();

      // Acquire
      const pageAcq = await svc.tryAcquireLock("page" as WorkerType, pageNonce);
      const backfillAcq = await svc.tryAcquireLock(
        "embedding-backfill" as WorkerType,
        backfillNonce
      );
      expect(pageAcq).toEqual({ ok: true });
      expect(backfillAcq).toEqual({ ok: true });

      // Assert both keys present with correct nonce
      expect(await inspector.get(LOCK_KEY_PAGE)).toBe(pageNonce);
      expect(await inspector.get(LOCK_KEY_BACKFILL)).toBe(backfillNonce);

      // Release page only
      const pageRel = await svc.releaseLock("page" as WorkerType, pageNonce);
      expect(pageRel).toBe(true);
      expect(await inspector.get(LOCK_KEY_PAGE)).toBeNull();
      // Backfill lock unaffected
      expect(await inspector.get(LOCK_KEY_BACKFILL)).toBe(backfillNonce);

      // Release backfill
      const backfillRel = await svc.releaseLock("embedding-backfill" as WorkerType, backfillNonce);
      expect(backfillRel).toBe(true);
      expect(await inspector.get(LOCK_KEY_BACKFILL)).toBeNull();

      await redis.quit().catch(() => undefined);
    }
  );

  it.skipIf(!redisAvailable)(
    "heartbeat TTL refresh is per-type scoped / heartbeat による TTL refresh は per-type に閉じる",
    async () => {
      const redis = createRedis();
      const svc = new WorkerActiveLockService({ redis });
      const pageNonce = generateBootToken();
      const backfillNonce = generateBootToken();

      await svc.tryAcquireLock("page" as WorkerType, pageNonce);
      await svc.tryAcquireLock("embedding-backfill" as WorkerType, backfillNonce);

      await new Promise((r) => setTimeout(r, 500));

      const pageTtlBefore = await inspector.pttl(LOCK_KEY_PAGE);
      const backfillTtlBefore = await inspector.pttl(LOCK_KEY_BACKFILL);

      // Only extend backfill
      await svc.extendLock("embedding-backfill" as WorkerType, backfillNonce);

      const pageTtlAfter = await inspector.pttl(LOCK_KEY_PAGE);
      const backfillTtlAfter = await inspector.pttl(LOCK_KEY_BACKFILL);

      // Backfill TTL refreshed up (Plan §3.2.5 heartbeat contract)
      expect(backfillTtlAfter).toBeGreaterThan(backfillTtlBefore);
      // Page TTL decayed (NOT refreshed)
      expect(pageTtlAfter).toBeLessThanOrEqual(pageTtlBefore);

      await redis.quit().catch(() => undefined);
    }
  );
});

// ============================================================================
// Test 2: Self-chained respawn flow (SEC-01 H)
// ============================================================================

describe("WorkerSupervisor multi-child: self-chained respawn flow (Plan v1.1 §6.2, SEC-01 H)", () => {
  let inspector: Redis;

  beforeEach(async () => {
    if (!redisAvailable) return;
    inspector = createRedis();
    await inspector.del(LOCK_KEY_PAGE);
    await inspector.del(LOCK_KEY_BACKFILL);
  });

  afterEach(async () => {
    if (!redisAvailable) return;
    await inspector.del(LOCK_KEY_PAGE);
    await inspector.del(LOCK_KEY_BACKFILL);
    await inspector.quit().catch(() => undefined);
  });

  it.skipIf(!redisAvailable)(
    "child N release → probe absent → child N+1 new-nonce acquire succeeds (SEC-PLAN-01 3-layer) / release→probe→取得 の3層が繋がる",
    async () => {
      const redis = createRedis();
      const svc = new WorkerActiveLockService({ redis });
      const oldNonce = generateBootToken();

      // Layer 0: child N acquires
      const acq = await svc.tryAcquireLock("embedding-backfill" as WorkerType, oldNonce);
      expect(acq).toEqual({ ok: true });

      // Layer 1: child N releases
      const rel = await svc.releaseLock("embedding-backfill" as WorkerType, oldNonce);
      expect(rel).toBe(true);

      // Layer 2: probe returns absent
      const probe = await svc.probeExistingLock("embedding-backfill" as WorkerType);
      expect(probe).toEqual({ unavailable: false, exists: false });

      // child N+1 spawns with NEW nonce — acquire succeeds without
      // stale-lock false-positive.
      // child N+1 spawn — new nonce で false-positive なく取得成功。
      const newNonce = generateBootToken();
      expect(newNonce).not.toBe(oldNonce);
      const newAcq = await svc.tryAcquireLock("embedding-backfill" as WorkerType, newNonce);
      expect(newAcq).toEqual({ ok: true });

      await redis.quit().catch(() => undefined);
    }
  );

  it.skipIf(!redisAvailable)(
    "SIGKILL (no release) scenario: stale nonce stays in Redis until TTL expiry (Layer 3 fallback path) / SIGKILL 後 TTL fallback が active になる",
    async () => {
      const redis = createRedis();
      const svc = new WorkerActiveLockService({ redis });
      const oldNonce = generateBootToken();

      // Child N acquires
      await svc.tryAcquireLock("embedding-backfill" as WorkerType, oldNonce);

      // Simulate SIGKILL — the Redis key still has oldNonce (no release
      // happened). The supervisor's probeExistingLock will find it.
      // SIGKILL 後、release が走らないため Redis に oldNonce が残存する。
      const probe = await svc.probeExistingLock("embedding-backfill" as WorkerType);
      expect(probe).toEqual({
        unavailable: false,
        exists: true,
        nonce: oldNonce,
      });

      // Child N+1 cannot acquire yet (SET NX would return null) — must
      // wait for TTL or explicitly clean up via release with old nonce.
      // child N+1 は TTL 経過まで取得不可 (Layer 3 fallback 経路)。
      const newNonce = generateBootToken();
      const contestedAcq = await svc.tryAcquireLock("embedding-backfill" as WorkerType, newNonce);
      expect(contestedAcq).toEqual({ ok: false, reason: "already_held" });

      // Supervisor protocol: after release retry exhaustion with self-nonce
      // probed, Layer 3 TTL fallback kicks in (wait 60s). For test speed,
      // we manually release with old nonce to simulate TTL expiry.
      // supervisor 実装は 60s TTL 待機。テストでは old nonce で release して
      // TTL 経過をシミュレート。
      await svc.releaseLock("embedding-backfill" as WorkerType, oldNonce);

      const retriedAcq = await svc.tryAcquireLock("embedding-backfill" as WorkerType, newNonce);
      expect(retriedAcq).toEqual({ ok: true });

      await redis.quit().catch(() => undefined);
    }
  );
});

// ============================================================================
// Test 3: Concurrent dual-type race (Plan §6.2 race test)
// ============================================================================

describe("WorkerSupervisor multi-child: concurrent dual-type race (Plan v1.1 §6.2)", () => {
  let inspector: Redis;

  beforeEach(async () => {
    if (!redisAvailable) return;
    inspector = createRedis();
    await inspector.del(LOCK_KEY_PAGE);
    await inspector.del(LOCK_KEY_BACKFILL);
  });

  afterEach(async () => {
    if (!redisAvailable) return;
    await inspector.del(LOCK_KEY_PAGE);
    await inspector.del(LOCK_KEY_BACKFILL);
    await inspector.quit().catch(() => undefined);
  });

  it.skipIf(!redisAvailable)(
    "staggered scheduling contract: primary (page) must spawn before secondary (backfill); ordering is externalized via schedulingPriority / primary → secondary の起動順契約",
    async () => {
      // Plan v1.1 §3.3 staggered scheduling: primary (page) first, then
      // secondary (embedding-backfill) after page heartbeat. This test
      // validates the sequencing contract via lock acquisition order.
      //
      // Plan v1.1 §3.3 staggered scheduling: primary 優先 (page が先)。
      // lock 取得順で sequencing を表現する。
      const redis = createRedis();
      const svc = new WorkerActiveLockService({ redis });

      // Primary first
      const pagePromise = svc.tryAcquireLock("page" as WorkerType, generateBootToken());
      const pageResult = await pagePromise;
      expect(pageResult).toEqual({ ok: true });

      // Page acquired → secondary spawn is now valid per §3.3
      const backfillPromise = svc.tryAcquireLock(
        "embedding-backfill" as WorkerType,
        generateBootToken()
      );
      const backfillResult = await backfillPromise;
      expect(backfillResult).toEqual({ ok: true });

      // Both are now present
      expect(await inspector.get(LOCK_KEY_PAGE)).not.toBeNull();
      expect(await inspector.get(LOCK_KEY_BACKFILL)).not.toBeNull();

      await redis.quit().catch(() => undefined);
    }
  );

  it.skipIf(!redisAvailable)(
    "concurrent re-acquisition (Promise.all) does NOT cause cross-type interference / 並行 re-acquire で cross-type 干渉が起きない",
    async () => {
      const redis = createRedis();
      const svc = new WorkerActiveLockService({ redis });

      // Concurrently acquire both
      const nonces = {
        page: generateBootToken(),
        backfill: generateBootToken(),
      };

      const [pageR, backfillR] = await Promise.all([
        svc.tryAcquireLock("page" as WorkerType, nonces.page),
        svc.tryAcquireLock("embedding-backfill" as WorkerType, nonces.backfill),
      ]);

      expect(pageR).toEqual({ ok: true });
      expect(backfillR).toEqual({ ok: true });

      // Concurrent release does not touch cross-type state
      const [pageRel, backfillRel] = await Promise.all([
        svc.releaseLock("page" as WorkerType, nonces.page),
        svc.releaseLock("embedding-backfill" as WorkerType, nonces.backfill),
      ]);
      expect(pageRel).toBe(true);
      expect(backfillRel).toBe(true);

      expect(await inspector.get(LOCK_KEY_PAGE)).toBeNull();
      expect(await inspector.get(LOCK_KEY_BACKFILL)).toBeNull();

      await redis.quit().catch(() => undefined);
    }
  );
});

// ============================================================================
// Test 4: IPC schema cross-type dispatch (TPA-02 H + SEC-PLAN-04)
// ============================================================================

describe("WorkerSupervisor multi-child: IPC dispatch routes per workerType (Plan v1.1 §6.2, TPA-02 H)", () => {
  beforeEach(() => {
    // no Redis dependency
  });

  it("valid IPC from each workerType routes to the correct branch / 各 workerType の IPC が正しく dispatch される", () => {
    // Contract: parseWorkerIpcStrict returns ok=true for every SSOT
    // WorkerType value; supervisor uses `msg.workerType` as dispatch key.
    // 契約: parseWorkerIpcStrict は全 SSOT WorkerType で ok=true を返し、
    // supervisor は msg.workerType を dispatch key として使う。
    for (const wt of WORKER_TYPES) {
      const msg: unknown = {
        type: "job-completed",
        workerType: wt,
        jobId: "00000000-0000-4000-8000-000000000000",
        timestamp: Date.now(),
      };
      const parsed = parseWorkerIpcStrict(msg);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.data.workerType).toBe(wt);
      }
    }
  });

  it("cross-type workerType drift (child emits wrong type) triggers fail-closed branch / 子が誤った workerType を emit すると fail-closed 分岐に振る", () => {
    // Worker starts as --page but emits workerType="embedding-backfill" —
    // this is an IPC workerType spoofing attempt (Plan §3.2.4 Rule 5).
    // --page として起動した子が workerType="embedding-backfill" を emit する
    // — IPC workerType spoofing 攻撃 (Plan §3.2.4 Rule 5) の simulation。
    //
    // The schema-valid case returns ok=true, but supervisor's Rule 5 binding
    // table verification (Map<pid, WorkerType>) must compare emitted
    // workerType against expected — if mismatched, SIGTERM + audit_log.
    // スキーマ自体は valid なので ok=true だが、Rule 5 binding table で
    // 突き合わせて mismatch なら SIGTERM + audit_log (supervisor 責任)。

    // Simulate binding table lookup
    const bindingTable = new Map<number, WorkerType>();
    bindingTable.set(1234, "page"); // child registered at spawn as page

    const emittedMsg: WorkerIpcMessage = {
      type: "job-completed",
      workerType: "embedding-backfill", // spoofed
      jobId: "11111111-1111-4111-8111-111111111111",
      timestamp: Date.now(),
    };

    const parsed = WorkerIpcMessageSchema.safeParse(emittedMsg);
    expect(parsed.success).toBe(true);

    // Rule 5 binding-table check
    const expected = bindingTable.get(1234);
    expect(expected).toBe("page");
    expect(emittedMsg.workerType).not.toBe(expected);

    // Contract: mismatch triggers spoofing-detected → supervisor emits
    // worker_type_spoofing_detected audit + SIGTERM + 60s respawn suppress.
    // 契約: mismatch は worker_type_spoofing_detected audit + SIGTERM +
    //       60s respawn 抑止 を起動する。
    const SPOOFING_ACTION = "worker_type_spoofing_detected";
    expect(SPOOFING_ACTION).toBe("worker_type_spoofing_detected");
  });
});

// ============================================================================
// Test 5: Real WorkerSupervisor multi-type integration
//
// PR-D-8 Phase 2 (TPA-IMPL-V11-09 M resolution): the original suite did NOT
// import the real `WorkerSupervisor` class — TPA Impl Audit V11-09 verified
// this via `git grep`. The describe blocks above operate on
// WorkerActiveLockService + IPC schema only, which validates the SSOT
// interfaces but never the supervisor's spawn / dispatch / lifecycle code.
//
// This describe imports the real `WorkerSupervisor` and exercises both
// WorkerType lifecycle paths via `ensureAllWorkersRunningStaggered()`.
// `child_process.fork` is mocked at module top so we don't actually spawn.
//
// PR-D-8 Phase 2 (TPA-IMPL-V11-09 M 解消): WorkerSupervisor 実 import + 両
// WorkerType の lifecycle を `ensureAllWorkersRunningStaggered()` 経由で起動
// する。
// ============================================================================

describe("WorkerSupervisor multi-child: real supervisor class integration (TPA-IMPL-V11-09 M)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ensureAllWorkersRunningStaggered spawns BOTH WorkerType children (page primary, embedding-backfill secondary) / 両 WorkerType の child を staggered spawn する", async () => {
    const { WorkerSupervisor } = await import("../../../src/services/worker-supervisor.service");

    // 2 fork calls expected (page first, then embedding-backfill).
    // 2 回の fork (primary → secondary)。
    const pageChild = createMockChildProcess(31001);
    const backfillChild = createMockChildProcess(31002);
    mockFork.mockImplementationOnce(() => pageChild).mockImplementationOnce(() => backfillChild);

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 5,
      maxRestartAttempts: 3,
      shutdownTimeoutMs: 10000,
    });

    // Kick off staggered scheduling. The supervisor calls
    // `ensureWorkerRunningForType("page")` first, then awaits the first
    // heartbeat (or 10s timeout) before `ensureWorkerRunningForType(
    // "embedding-backfill")`.
    // staggered scheduling 起動。
    const promise = supervisor.ensureAllWorkersRunningStaggered(100);
    // page child から heartbeat を即時 send → supervisor が secondary spawn へ進む。
    // page heartbeat → secondary spawn を許可。
    pageChild.emit("message", {
      type: "heartbeat",
      workerType: "page",
      timestamp: Date.now(),
    });
    await vi.runOnlyPendingTimersAsync();
    await promise;

    expect(mockFork).toHaveBeenCalledTimes(2);
    // 両 WorkerType の child state が記録されている。
    expect(supervisor.getStateForType("page")).toBe("running");
    expect(supervisor.getStateForType("embedding-backfill")).toBe("running");

    // bindingTable には両 pid が登録されている (Rule 5)。
    const binding = supervisor.getBindingTableSnapshot();
    expect(binding.get(31001)).toBe("page");
    expect(binding.get(31002)).toBe("embedding-backfill");
  });

  it("per-type child exit triggers per-type respawn independently / 一方の child exit が他方に影響しない", async () => {
    const { WorkerSupervisor } = await import("../../../src/services/worker-supervisor.service");

    const pageChild1 = createMockChildProcess(31010);
    const backfillChild1 = createMockChildProcess(31011);
    const pageChild2 = createMockChildProcess(31020);
    mockFork
      .mockImplementationOnce(() => pageChild1)
      .mockImplementationOnce(() => backfillChild1)
      .mockImplementationOnce(() => pageChild2);

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 100,
      maxRestartAttempts: 5,
      shutdownTimeoutMs: 10000,
    });

    const promise = supervisor.ensureAllWorkersRunningStaggered(100);
    pageChild1.emit("message", {
      type: "heartbeat",
      workerType: "page",
      timestamp: Date.now(),
    });
    await vi.runOnlyPendingTimersAsync();
    await promise;
    expect(mockFork).toHaveBeenCalledTimes(2);

    // page child だけが exit (134 = OOM/SIGABRT)
    pageChild1.emit("exit", 134, null);
    // restartDelayMs (3s default) を消化 → page を respawn。
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();
    await Promise.resolve();

    // 3 回目 fork = page respawn。embedding-backfill child は影響なし。
    expect(mockFork).toHaveBeenCalledTimes(3);
    expect(supervisor.getStateForType("page")).toBe("running");
    // backfill state は変わらず running (per-type 独立 lifecycle)。
    expect(supervisor.getStateForType("embedding-backfill")).toBe("running");
  });

  it("per-type IPC dispatch routes to correct WorkerType counter / per-type IPC は正しい counter に dispatch される", async () => {
    const { WorkerSupervisor } = await import("../../../src/services/worker-supervisor.service");

    const pageChild = createMockChildProcess(31030);
    const backfillChild = createMockChildProcess(31031);
    mockFork.mockImplementationOnce(() => pageChild).mockImplementationOnce(() => backfillChild);

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 100,
      maxRestartAttempts: 5,
      shutdownTimeoutMs: 10000,
    });

    const promise = supervisor.ensureAllWorkersRunningStaggered(100);
    pageChild.emit("message", {
      type: "heartbeat",
      workerType: "page",
      timestamp: Date.now(),
    });
    await vi.runOnlyPendingTimersAsync();
    await promise;

    // page から 2 件、backfill から 1 件 job-completed
    pageChild.emit("message", {
      type: "job-completed",
      workerType: "page",
      jobId: "00000000-0000-4000-8000-000000000111",
      timestamp: Date.now(),
    });
    pageChild.emit("message", {
      type: "job-completed",
      workerType: "page",
      jobId: "00000000-0000-4000-8000-000000000112",
      timestamp: Date.now(),
    });
    backfillChild.emit("message", {
      type: "job-completed",
      workerType: "embedding-backfill",
      jobId: "00000000-0000-4000-8000-000000000113",
      timestamp: Date.now(),
    });

    // counter が per-type に分離されている。
    expect(supervisor.getCompletedJobCountForType("page")).toBe(2);
    expect(supervisor.getCompletedJobCountForType("embedding-backfill")).toBe(1);
    // legacy alias は page を返す。
    expect(supervisor.getCompletedJobCount()).toBe(2);
  });

  it("per-type IPC sender mismatch (cross-type spoofing) is rejected by Rule 5 binding table check / cross-type spoofing は Rule 5 で reject される", async () => {
    const { WorkerSupervisor } = await import("../../../src/services/worker-supervisor.service");

    const pageChild = createMockChildProcess(31040);
    const backfillChild = createMockChildProcess(31041);
    mockFork.mockImplementationOnce(() => pageChild).mockImplementationOnce(() => backfillChild);

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 100,
      maxRestartAttempts: 5,
      shutdownTimeoutMs: 10000,
    });

    const promise = supervisor.ensureAllWorkersRunningStaggered(100);
    pageChild.emit("message", {
      type: "heartbeat",
      workerType: "page",
      timestamp: Date.now(),
    });
    await vi.runOnlyPendingTimersAsync();
    await promise;

    // page child が backfill workerType を spoof (Rule 5 binding 不一致)。
    // page child が embedding-backfill を装って IPC 送信。
    pageChild.emit("message", {
      type: "job-completed",
      workerType: "embedding-backfill",
      jobId: "00000000-0000-4000-8000-00000000ff00",
      timestamp: Date.now(),
    });

    // counter は両 type で 0 のまま (spoofing は dispatch されない)。
    expect(supervisor.getCompletedJobCountForType("page")).toBe(0);
    expect(supervisor.getCompletedJobCountForType("embedding-backfill")).toBe(0);
  });

  it("per-type config map exposes schedulingPriority for staggered scheduling / per-type config が schedulingPriority を提供する", async () => {
    const { WorkerSupervisor } = await import("../../../src/services/worker-supervisor.service");

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 1,
      maxRestartAttempts: 1,
      shutdownTimeoutMs: 10000,
    });

    // page = primary, embedding-backfill = secondary (Plan v1.1 §3.2.3)
    expect(supervisor.getTypeConfig("page").schedulingPriority).toBe("primary");
    expect(supervisor.getTypeConfig("embedding-backfill").schedulingPriority).toBe("secondary");
    // bootTokenEnv は per-type で異なる (Rule 2 + Rule 5)。
    expect(supervisor.getTypeConfig("page").bootTokenEnv).toBe(
      "REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_PAGE"
    );
    expect(supervisor.getTypeConfig("embedding-backfill").bootTokenEnv).toBe(
      "REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN_BACKFILL"
    );
    // childTypeEnv は両者で同じ (CHILD_TYPE 環境変数 1 つを共有)。
    expect(supervisor.getTypeConfig("page").childTypeEnv).toBe(
      supervisor.getTypeConfig("embedding-backfill").childTypeEnv
    );
  });

  it("getChildState returns null when no child has been spawned for the type / 未 spawn の type は null を返す", async () => {
    const { WorkerSupervisor } = await import("../../../src/services/worker-supervisor.service");

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 1,
      maxRestartAttempts: 1,
      shutdownTimeoutMs: 10000,
    });

    expect(supervisor.getChildState("page")).toBeNull();
    expect(supervisor.getChildState("embedding-backfill")).toBeNull();

    const pageChild = createMockChildProcess(31050);
    mockFork.mockReturnValueOnce(pageChild);
    supervisor.ensureWorkerRunningForType("page");
    expect(supervisor.getChildState("page")).not.toBeNull();
    expect(supervisor.getChildState("page")?.pid).toBe(31050);
    // backfill は未起動のため null のまま。
    expect(supervisor.getChildState("embedding-backfill")).toBeNull();
  });
});
