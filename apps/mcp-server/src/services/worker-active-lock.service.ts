// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerActiveLockService — Redis-based active-worker detection (v0.4.0 PR7d-2)
 *
 * Prevents two BullMQ Worker processes (MCP-server fork-supervised vs. manual
 * `pnpm worker:start:page`) from concurrently consuming the same page-analyze
 * Queue, which previously caused jobId race and lock-handoff corruption.
 *
 * v0.4.0 PR7d-2: MCP サーバー fork-supervised Worker と手動 `pnpm worker:start:page`
 * が同一 page-analyze Queue を並列消費することで発生していた jobId race / lock 奪取
 * を防止するための Redis ベース active-worker 検出機構。
 *
 * Design:
 *   - Key:   `reftrix:worker:active:<workerType>` where workerType ∈
 *            {`page`, `embedding-backfill`} (PR-D-8: per-type extension).
 *            Each WorkerType has its own independent lock so the two
 *            supervised children never collide on lock state.
 *   - Value: UUID nonce (process-unique boot token)
 *   - TTL:   60 seconds (refreshed every 30s via `extendLock()`)
 *   - acquire: `SET key nonce EX 60 NX` (atomic acquire-or-fail)
 *   - release: Lua script — delete only if current value matches our nonce
 *              (prevents accidental deletion of a later owner's lock)
 *
 * 設計:
 *   - キー:   `reftrix:worker:active:<workerType>` (workerType ∈
 *            {`page`, `embedding-backfill`}、PR-D-8 で per-type 拡張)。
 *            各 WorkerType 独立の lock を持ち、2 子 process 間で状態が衝突しない。
 *   - 値:     UUID nonce (プロセス固有の boot token)
 *   - TTL:    60 秒 (30 秒ごとに `extendLock()` で延長)
 *   - acquire: `SET key nonce EX 60 NX` (atomic 取得 or 失敗)
 *   - release: Lua script — 現在値が自 nonce と一致する場合のみ削除
 *              (後続 owner の lock を誤削除しない)
 *
 * NOT a distributed mutex: single-owner detection only. Does not coordinate
 * multi-node BullMQ Workers (BullMQ handles that via Redis lists). This service
 * is strictly for preventing accidental dual-process concurrency on one host.
 *
 * 分散 mutex ではない: 単一 owner 検出のみ。マルチノード BullMQ Worker の調停は
 * BullMQ 本体 (Redis lists) が行う。本サービスは単一ホスト上の偶発的な二重起動
 * 防止に特化する。
 *
 * @module services/worker-active-lock
 */

import { createHash, randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { createRedisClient } from "../config/redis";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
// PR-D-8 Phase 2 — migrate to WorkerType SSOT (§3.2.1, TDA-01 H resolution).
// Previously this file declared `export type WorkerType = "page"` inline,
// creating a 3-way SSOT collision with start-workers.ts and informal uses.
// PR-D-8 Phase 2: WorkerType SSOT へ移行し 3-way collision を解消する。
import type { WorkerType } from "../types/worker-type";

// Re-export WorkerType so consumers of this service (e.g. WorkerSupervisor,
// start-workers.ts) can continue importing from here during the 1-cycle
// migration window. New code SHOULD import directly from `types/worker-type`.
// WorkerType を re-export し、1 release cycle の移行期間中は既存 importer
// (WorkerSupervisor, start-workers.ts) が壊れないよう配慮する。新コードは
// `types/worker-type` から直接 import すること。
export type { WorkerType } from "../types/worker-type";

// ============================================================================
// Constants
// ============================================================================

/** Redis key prefix for active-worker lock keys. */
const LOCK_KEY_PREFIX = "reftrix:worker:active:";

/** Lock TTL in seconds (refreshed every LOCK_HEARTBEAT_INTERVAL_MS). */
const LOCK_TTL_SECONDS = 60;

/** Heartbeat interval in ms (half of TTL for safety). */
export const LOCK_HEARTBEAT_INTERVAL_MS = 30_000;

// ============================================================================
// Plan v4.5 PR3 Track 2: Per-job sub-child lock — namespace + rate-limit
// (SEC M-01 CWE-770 ≥500ms boundary, ADR-0011 Amendment 3 Redis TIME pin)
// ============================================================================

/**
 * Per-job sub-child lock key prefix. Per-job lock keys are namespaced under the
 * embedding-backfill per-type lock as
 * `reftrix:worker:active:embedding-backfill:job:<jobId>` so the supervisor
 * orphan-cleanup scan can enumerate them via a single `SCAN MATCH` pattern.
 *
 * Per-job sub-child lock の key prefix。`embedding-backfill` per-type lock 配下に
 * namespace。
 */
export const PER_JOB_LOCK_KEY_NAMESPACE = `${LOCK_KEY_PREFIX}embedding-backfill:job:`;

/**
 * Rate-limit companion key for the per-job spawn ≥500ms interval (SEC M-01).
 * Stores the last sub-child spawn timestamp (Redis server-side `TIME` ms).
 *
 * Per-job spawn ≥500ms 間隔 rate-limit の companion key (SEC M-01)。
 */
const PER_JOB_RATE_LIMIT_KEY = `${LOCK_KEY_PREFIX}embedding-backfill:rate`;

/**
 * Minimum interval between two sub-child spawns (ms). SEC M-01 / CWE-770
 * boundary. The interval is measured against Redis server-side
 * `redis.call('TIME')` (NOT caller-process `Date.now()` / `process.hrtime`)
 * per ADR-0011 Amendment 3, so caller clock skew / NTP step / SIGSTOP cannot
 * bypass the rate-limit.
 *
 * 2 spawn 間の最小間隔 (ms)。SEC M-01 / CWE-770 boundary。Redis server-side
 * `TIME` を基準とし caller clock skew で bypass されない。
 */
export const PER_JOB_SPAWN_MIN_INTERVAL_MS = 500;

/** Per-job lock TTL (ms). Independent of the per-type 60s TTL. */
export const PER_JOB_LOCK_TTL_MS = 60_000;

/**
 * Lua script — release the per-job sub-child lock only if BOTH the stored
 * `nonce` AND `bootEpoch` match the caller's. CWE-367 TOCTOU race closure
 * (§4.2.2 OrphanCleanupContract): a supervisor restart with a fresh bootEpoch
 * MUST NOT delete a live owner's lock (own-supervisor origin only).
 *
 * 自 nonce AND bootEpoch の双方一致時のみ per-job lock を削除する Lua
 * (CWE-367 TOCTOU race closure, §4.2.2)。
 *
 * KEYS[1] = job_lock_key, ARGV[1] = nonce, ARGV[2] = bootEpoch
 */
const PER_JOB_RELEASE_LUA = `
local stored = redis.call('GET', KEYS[1])
if not stored then
  return 0
end
local ok, payload = pcall(cjson.decode, stored)
if not ok then
  return 0
end
if payload.nonce == ARGV[1] and payload.bootEpoch == ARGV[2] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Lua script — atomic per-job lock acquire with server-side monotonic
 * rate-limit. Pins the clock via `redis.call('TIME')` (ADR-0011 Amendment 3,
 * CWE-770) so the ≥500ms spawn interval cannot be bypassed by caller clock
 * manipulation. Returns a 3-element array `{status, reason, payload}`:
 *   - {1, 'ok', <payload json>}        — acquired
 *   - {0, 'rate_limited', <retryMs>}   — < min interval since last spawn
 *   - {0, 'race_lost', <existing>}     — SET NX lost (another owner holds it)
 *
 * KEYS[1] = rate_limit_key, KEYS[2] = job_lock_key
 * ARGV[1] = nonce, ARGV[2] = bootEpoch, ARGV[3] = ttlMs, ARGV[4] = minIntervalMs
 *
 * Per-job lock の atomic acquire + server-side monotonic rate-limit Lua。
 */
const PER_JOB_LOCK_LUA = `
local rate_limit_key = KEYS[1]
local job_lock_key   = KEYS[2]
local nonce          = ARGV[1]
local boot_epoch     = ARGV[2]
local ttl_ms         = tonumber(ARGV[3])
local min_interval_ms = tonumber(ARGV[4])

local time_arr = redis.call('TIME')
local now_ms = (tonumber(time_arr[1]) * 1000) + math.floor(tonumber(time_arr[2]) / 1000)

local last_spawn_ms = tonumber(redis.call('GET', rate_limit_key) or '0')
local elapsed = now_ms - last_spawn_ms
if elapsed >= 0 and elapsed < min_interval_ms then
  return {0, 'rate_limited', tostring(min_interval_ms - elapsed)}
end

local payload = cjson.encode({nonce = nonce, bootEpoch = boot_epoch, acquiredAtMs = now_ms})
local ok = redis.call('SET', job_lock_key, payload, 'NX', 'PX', ttl_ms)
if ok then
  -- Redis 'PX' requires a strictly-positive expiry. With min_interval_ms = 0
  -- (test injection / rate-limit disabled) the companion key expiry floors to
  -- 1ms so 'SET ... PX 0' never errors and aborts the atomic acquire.
  local rate_px = min_interval_ms * 2
  if rate_px < 1 then rate_px = 1 end
  redis.call('SET', rate_limit_key, tostring(now_ms), 'PX', rate_px)
  return {1, 'ok', payload}
end
return {0, 'race_lost', redis.call('GET', job_lock_key)}
`;

/**
 * Boot-time SHA1 derivation (SSOT, §4.4 Lua SCRIPT LOAD pinning). Derived via
 * `createHash("sha1").update(script).digest("hex")` at module load — NOT a
 * hardcoded literal — so coupling drift between the script body and its SHA is
 * impossible (canonical pattern per Wave 5 LCC anchor `019df7ab-2f5a`).
 * INV-WORKER-LUA-SHA-PIN-001 §5.5 AST sweep gates this contract.
 *
 * Lua script の boot-time SHA1 (§4.4)。hardcoded literal 禁止、module load 時に
 * derive することで script body と SHA の coupling drift を構造的に排除する。
 */
export const PER_JOB_RELEASE_SHA: string = createHash("sha1")
  .update(PER_JOB_RELEASE_LUA)
  .digest("hex");
export const PER_JOB_LOCK_SHA: string = createHash("sha1").update(PER_JOB_LOCK_LUA).digest("hex");

/**
 * Lua script — release lock only if value matches our nonce.
 * Prevents accidentally deleting a lock owned by a later process.
 * Key-agnostic (works for any per-type key under `reftrix:worker:active:`).
 *
 * 自 nonce と一致する場合のみ lock を削除する Lua スクリプト。
 * 後続プロセスの lock を誤って削除しないように保護する。
 * key に依存せず、`reftrix:worker:active:` 配下の全 per-type key で動作する。
 */
const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

// ============================================================================
// Types
// ============================================================================

/**
 * Options for {@link WorkerActiveLockService}.
 *
 * {@link WorkerActiveLockService} のオプション。
 */
export interface WorkerActiveLockServiceOptions {
  /**
   * Redis client. When omitted, a new `client`-purpose client is created.
   *
   * Redis クライアント。未指定時は新規 `client` purpose クライアントを生成する。
   */
  redis?: Redis;
}

/**
 * Result of {@link WorkerActiveLockService.acquireLock} — discriminated union
 * distinguishing race-lost (`already_held`) from Redis-unreachable
 * (`redis_unavailable`). Callers should fail-closed on `already_held` and
 * fail-open on `redis_unavailable` to match ADR-0011's documented intent.
 *
 * {@link WorkerActiveLockService.acquireLock} の結果 — race 敗北
 * (`already_held`) と Redis 到達不能 (`redis_unavailable`) を区別する
 * discriminated union。呼び出し側は `already_held` では fail-closed、
 * `redis_unavailable` では fail-open することで ADR-0011 の設計意図と整合する。
 *
 * v0.4.0 PR7d-3 (SEC M-1): fail-closed vs fail-open 判別を呼び出し側に委ねる
 * ために導入。従来の `boolean` 戻り値では両ケースが共に `false` で区別不能だった。
 */
export type AcquireLockResult =
  | { ok: true }
  | { ok: false; reason: "already_held" }
  | { ok: false; reason: "redis_unavailable"; error: string };

/**
 * Result of {@link WorkerActiveLockService.checkExistingLock} — discriminated
 * union distinguishing "lock absent" (`exists: false`) from
 * "Redis unreachable" (`unavailable: true`).
 *
 * {@link WorkerActiveLockService.checkExistingLock} の結果 — lock 不在
 * (`exists: false`) と Redis 到達不能 (`unavailable: true`) を区別する
 * discriminated union。
 *
 * v0.4.0 PR7d-3 (SEC M-1): 同上。
 */
export type CheckExistingLockResult =
  | { unavailable: false; exists: false }
  | { unavailable: false; exists: true; nonce: string }
  | { unavailable: true; error: string };

/**
 * Result of {@link WorkerActiveLockService.acquirePerJobSubChildLock} — a
 * discriminated union distinguishing fail-open (`redis_unreachable`) from
 * fail-closed (`rate_limited` / `race_lost`) semantics at the type level
 * (Plan v4.5 PR3 V1 §4.2.1, SEC M-1 PR7d-3 pattern inheritance).
 *
 * | reason             | failOpen | action                                          |
 * | ------------------ | -------- | ----------------------------------------------- |
 * | (ok)               | n/a      | spawn sub-child                                 |
 * | rate_limited       | false    | fail-closed: BullMQ retry (delayed retryAfterMs)|
 * | race_lost          | false    | fail-closed: BullMQ retry (no spawn)            |
 * | redis_unreachable  | true     | fail-open: proceed without lock (SEC-M-3)       |
 *
 * Callers MUST handle every case via an exhaustive `switch` (`never`-narrowing
 * gives a compile-time exhaustiveness gate).
 *
 * {@link WorkerActiveLockService.acquirePerJobSubChildLock} の discriminated
 * union (§4.2.1)。fail-open / fail-closed を型 level で区別する。
 */
export type PerJobAcquireLockResult =
  | { ok: true; key: string; nonce: string; bootEpoch: string; sha: string; ttlMs: number }
  | { ok: false; reason: "rate_limited"; failOpen: false; retryAfterMs: number }
  | { ok: false; reason: "race_lost"; failOpen: false; existingPayload: string | null }
  | { ok: false; reason: "redis_unreachable"; failOpen: true; error: string };

/**
 * One per-job lock entry observed during an orphan-cleanup scan. The decoded
 * `nonce` + `bootEpoch` allow the supervisor to release ONLY its own orphaned
 * locks (§4.2.2 OrphanCleanupContract, CWE-367 closure).
 *
 * Orphan-cleanup scan で観測される per-job lock 1 件 (§4.2.2)。
 */
export interface OrphanLockEntry {
  /** Full Redis key (`reftrix:worker:active:embedding-backfill:job:<jobId>`). */
  key: string;
  /** Lock owner nonce decoded from the JSON payload (null if undecodable). */
  nonce: string | null;
  /** Lock owner bootEpoch decoded from the JSON payload (null if undecodable). */
  bootEpoch: string | null;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Redis-based worker-active lock manager.
 *
 * Redis ベースの worker-active lock マネージャ。
 */
export class WorkerActiveLockService {
  private readonly redis: Redis;
  private readonly ownedRedis: boolean;

  constructor(options: WorkerActiveLockServiceOptions = {}) {
    if (options.redis) {
      this.redis = options.redis;
      this.ownedRedis = false;
    } else {
      this.redis = createRedisClient({ purpose: "client" });
      this.ownedRedis = true;
    }
  }

  // ==========================================================================
  // Key Derivation
  // ==========================================================================

  /**
   * Compute the Redis key for a given worker type.
   *
   * Per-type keys: `reftrix:worker:active:page` /
   * `reftrix:worker:active:embedding-backfill`. Each WorkerType is an
   * independent lock namespace (PR-D-8 §3.2.1).
   *
   * WorkerType ごとの Redis キーを計算する。WorkerType ごとに完全独立な lock
   * namespace を持つ (PR-D-8 §3.2.1)。
   *
   * @internal exposed for tests
   */
  static keyFor(workerType: WorkerType): string {
    return `${LOCK_KEY_PREFIX}${workerType}`;
  }

  // ==========================================================================
  // Lock Operations
  // ==========================================================================

  /**
   * Atomically acquire the active-worker lock for the given worker type.
   *
   * 指定 worker type の active lock を atomic に取得する。
   *
   * **Deprecated戻り値**: 単純な `boolean` は race-lost と Redis 不可到達を
   * 区別できないため、SEC M-1 (PR7d-3) で {@link tryAcquireLock} が追加された。
   * 新規コードは {@link tryAcquireLock} を使うこと。
   *
   * **Legacy return**: simple `boolean` cannot tell race-lost from
   * Redis-unreachable; SEC M-1 (PR7d-3) added {@link tryAcquireLock}. New
   * code should use {@link tryAcquireLock}.
   *
   * @param workerType - Worker type (e.g. `"page"`)
   * @param nonce - Unique boot token for the caller (typically `crypto.randomUUID()`)
   * @returns `true` if acquired, `false` if another owner already holds it OR Redis is unreachable
   */
  async acquireLock(workerType: WorkerType, nonce: string): Promise<boolean> {
    const result = await this.tryAcquireLock(workerType, nonce);
    return result.ok;
  }

  /**
   * Atomically acquire the active-worker lock and return a discriminated union
   * so callers can distinguish race-lost from Redis-unreachable conditions.
   *
   * v0.4.0 PR7d-3 (SEC M-1): ADR-0011 は Redis 到達不能時を fail-open 挙動と
   * 記載していたが、`acquireLock()` が両ケースを共に `false` として返していた
   * ため、呼び出し側が fail-closed 扱いするしかなかった。本メソッドで両者を
   * 明示的に区別する。
   *
   * ADR-0011 documents Redis-unreachable as fail-open, but the legacy
   * `acquireLock()` returned `false` for both race-lost and Redis-unreachable,
   * forcing callers into fail-closed behaviour. This method surfaces the
   * distinction.
   *
   * @param workerType - Worker type (e.g. `"page"`)
   * @param nonce - Unique boot token for the caller
   * @returns Discriminated union (ok / already_held / redis_unavailable)
   */
  async tryAcquireLock(workerType: WorkerType, nonce: string): Promise<AcquireLockResult> {
    if (typeof nonce !== "string" || nonce.length === 0) {
      // Never set an empty-string lock value — would make release impossible.
      // 空文字列を値に入れない（release 不能になる）。
      throw new Error("WorkerActiveLockService.acquireLock: nonce must be a non-empty string");
    }

    const key = WorkerActiveLockService.keyFor(workerType);
    try {
      const result = await this.redis.set(key, nonce, "EX", LOCK_TTL_SECONDS, "NX");
      if (result === "OK") {
        return { ok: true };
      }
      return { ok: false, reason: "already_held" };
    } catch (error) {
      const sanitized = sanitizeErrorMessage(error);
      logger.warn("[WorkerActiveLock] acquireLock failed (redis unavailable)", {
        workerType,
        error: sanitized,
      });
      return { ok: false, reason: "redis_unavailable", error: sanitized };
    }
  }

  /**
   * Refresh the TTL on a lock we own. No-op if the lock no longer exists or
   * is owned by a different nonce.
   *
   * 所有している lock の TTL を延長する。lock が既に消滅している場合、
   * または別 nonce が所有している場合は no-op。
   *
   * @returns `true` if the TTL was refreshed, `false` otherwise
   */
  async extendLock(workerType: WorkerType, nonce: string): Promise<boolean> {
    const key = WorkerActiveLockService.keyFor(workerType);
    try {
      // Check ownership then PEXPIRE in a single round trip via Lua for atomicity.
      // 所有確認 → PEXPIRE を Lua で atomic 実行。
      const script = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("PEXPIRE", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;
      const result = await this.redis.eval(script, 1, key, nonce, String(LOCK_TTL_SECONDS * 1000));
      return result === 1;
    } catch (error) {
      logger.warn("[WorkerActiveLock] extendLock failed (non-fatal)", {
        workerType,
        error: sanitizeErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Release the lock we own. If another nonce currently holds the key, the
   * release is refused (we never delete someone else's lock).
   *
   * 所有する lock を解放する。別 nonce が保持している場合は削除を拒否する
   * (他者の lock は絶対に消さない)。
   *
   * @returns `true` if the lock was released, `false` if we did not own it
   */
  async releaseLock(workerType: WorkerType, nonce: string): Promise<boolean> {
    const key = WorkerActiveLockService.keyFor(workerType);
    try {
      const result = await this.redis.eval(RELEASE_LUA, 1, key, nonce);
      return result === 1;
    } catch (error) {
      logger.warn("[WorkerActiveLock] releaseLock failed (non-fatal)", {
        workerType,
        error: sanitizeErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Inspect whether a lock is currently held (and by which nonce).
   *
   * 現在 lock が保持されているか (およびその nonce) を確認する。
   *
   * **Deprecated戻り値**: 単純な `string | null` は lock 不在と Redis 不可到達を
   * 区別できないため、SEC M-1 (PR7d-3) で {@link probeExistingLock} が追加された。
   * 新規コードは {@link probeExistingLock} を使うこと。
   *
   * **Legacy return**: `string | null` cannot tell lock-absent from
   * Redis-unreachable; SEC M-1 (PR7d-3) added {@link probeExistingLock}.
   *
   * @returns The current owner's nonce, or `null` if no owner OR Redis is unreachable
   */
  async checkExistingLock(workerType: WorkerType): Promise<string | null> {
    const result = await this.probeExistingLock(workerType);
    if (result.unavailable) return null;
    return result.exists ? result.nonce : null;
  }

  /**
   * Inspect the current lock state and return a discriminated union so callers
   * can distinguish "no lock" from "Redis unreachable".
   *
   * v0.4.0 PR7d-3 (SEC M-1): `checkExistingLock()` が両ケースを共に `null` で
   * 返していたため、呼び出し側は Redis 障害時に fail-open できなかった。本
   * メソッドで明示的に区別する。
   *
   * @returns Discriminated union (unavailable / exists / no-exist)
   */
  async probeExistingLock(workerType: WorkerType): Promise<CheckExistingLockResult> {
    const key = WorkerActiveLockService.keyFor(workerType);
    try {
      const value = await this.redis.get(key);
      if (value === null) {
        return { unavailable: false, exists: false };
      }
      return { unavailable: false, exists: true, nonce: value };
    } catch (error) {
      const sanitized = sanitizeErrorMessage(error);
      logger.warn("[WorkerActiveLock] checkExistingLock failed (redis unavailable)", {
        workerType,
        error: sanitized,
      });
      return { unavailable: true, error: sanitized };
    }
  }

  // ==========================================================================
  // Per-job sub-child lock (Plan v4.5 PR3 Track 2)
  // ==========================================================================

  /**
   * Boot-time pin both per-job Lua scripts via `SCRIPT LOAD`, then assert they
   * are resident via `SCRIPT EXISTS`. Runtime acquire/release use `EVALSHA`
   * only (CWE-829 / CWE-94 closure, §4.4). Throws if pinning fails so a
   * misconfigured Redis surfaces at boot rather than on first job.
   *
   * 起動時に per-job Lua script を SCRIPT LOAD で pin し、SCRIPT EXISTS で
   * 常駐確認する (§4.4)。runtime は EVALSHA のみ。pin 失敗時は throw。
   *
   * @throws Error when boot-time SCRIPT LOAD invariant is violated
   */
  async pinLuaScripts(): Promise<void> {
    await this.redis.script("LOAD", PER_JOB_RELEASE_LUA);
    await this.redis.script("LOAD", PER_JOB_LOCK_LUA);
    const loaded = (await this.redis.script(
      "EXISTS",
      PER_JOB_RELEASE_SHA,
      PER_JOB_LOCK_SHA
    )) as number[];
    if (!Array.isArray(loaded) || !loaded.every((x) => x === 1)) {
      throw new Error("Lua script pinning failed (boot-time SCRIPT LOAD invariant violated)");
    }
  }

  /**
   * Atomically acquire a per-job sub-child spawn lock with a server-side
   * monotonic ≥500ms rate-limit (SEC M-01 / CWE-770, ADR-0011 Amendment 3).
   * Uses `EVALSHA` only; on `NOSCRIPT` re-pins exactly once
   * (`worker_lua_script_reload` transparency), then surfaces persistent
   * failures as `redis_unreachable` (fail-open).
   *
   * Per-job sub-child spawn lock を server-side monotonic ≥500ms rate-limit
   * 付きで atomic 取得する (SEC M-01 / CWE-770)。EVALSHA のみ使用、NOSCRIPT 時は
   * 1 回だけ re-pin。
   *
   * @param jobId    - BullMQ job id (namespaced into the per-job lock key)
   * @param nonce    - Caller-unique boot token (non-empty)
   * @param bootEpoch- Supervisor boot epoch (UUIDv7) for orphan double-verify
   * @param opts     - Optional ttlMs / minIntervalMs overrides (test injection)
   * @returns Discriminated union (ok / rate_limited / race_lost / redis_unreachable)
   */
  async acquirePerJobSubChildLock(
    jobId: string,
    nonce: string,
    bootEpoch: string,
    opts: { ttlMs?: number; minIntervalMs?: number } = {}
  ): Promise<PerJobAcquireLockResult> {
    validatePerJobLockInputs(jobId, nonce, bootEpoch);

    // NaN/Infinity defense on numeric overrides (Standards §NaN/Infinity 防御).
    const ttlMs = resolveFinite(opts.ttlMs, PER_JOB_LOCK_TTL_MS);
    const minIntervalMs = resolveFinite(opts.minIntervalMs, PER_JOB_SPAWN_MIN_INTERVAL_MS);
    const jobLockKey = `${PER_JOB_LOCK_KEY_NAMESPACE}${jobId}`;

    try {
      const raw = await this.evalShaPerJobLock(jobLockKey, nonce, bootEpoch, ttlMs, minIntervalMs);
      return this.interpretPerJobLockResult(
        raw,
        jobLockKey,
        nonce,
        bootEpoch,
        ttlMs,
        minIntervalMs
      );
    } catch (error) {
      const sanitized = sanitizeErrorMessage(error);
      logger.warn("[WorkerActiveLock] acquirePerJobSubChildLock failed (redis unavailable)", {
        error: sanitized,
      });
      return { ok: false, reason: "redis_unreachable", failOpen: true, error: sanitized };
    }
  }

  /**
   * Run the per-job lock Lua via `EVALSHA`. On `NOSCRIPT` (SHA cache evicted)
   * re-pins exactly once then retries (§4.4 NOSCRIPT-recovery). Persistent
   * NOSCRIPT propagates to the caller's catch (→ `redis_unreachable`).
   *
   * @internal
   */
  private async evalShaPerJobLock(
    jobLockKey: string,
    nonce: string,
    bootEpoch: string,
    ttlMs: number,
    minIntervalMs: number
  ): Promise<unknown> {
    const args = [
      PER_JOB_RATE_LIMIT_KEY,
      jobLockKey,
      nonce,
      bootEpoch,
      String(ttlMs),
      String(minIntervalMs),
    ];
    try {
      return await this.redis.evalsha(PER_JOB_LOCK_SHA, 2, ...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("NOSCRIPT")) {
        // Transparent re-pin (observability via worker_lua_script_reload at the
        // caller layer). Re-pin once, then retry; a second NOSCRIPT throws.
        logger.warn("[WorkerActiveLock] Lua SHA cache evicted, re-pinning (NOSCRIPT recovery)");
        await this.redis.script("LOAD", PER_JOB_LOCK_LUA);
        return await this.redis.evalsha(PER_JOB_LOCK_SHA, 2, ...args);
      }
      throw error;
    }
  }

  /**
   * Map the Lua `{status, reason, payload}` array to the discriminated union.
   *
   * @internal
   */
  private interpretPerJobLockResult(
    raw: unknown,
    jobLockKey: string,
    nonce: string,
    bootEpoch: string,
    ttlMs: number,
    minIntervalMs: number
  ): PerJobAcquireLockResult {
    if (!Array.isArray(raw) || raw.length < 2) {
      // Defensive: unexpected shape treated as fail-open (do not block job).
      return {
        ok: false,
        reason: "redis_unreachable",
        failOpen: true,
        error: "per-job lock returned unexpected shape",
      };
    }
    const status = Number(raw[0]);
    const reason = String(raw[1]);
    if (status === 1) {
      return { ok: true, key: jobLockKey, nonce, bootEpoch, sha: PER_JOB_LOCK_SHA, ttlMs };
    }
    if (reason === "rate_limited") {
      const parsed = Number(raw[2]);
      const retryAfterMs = Number.isFinite(parsed) ? parsed : minIntervalMs;
      return { ok: false, reason: "rate_limited", failOpen: false, retryAfterMs };
    }
    // race_lost (or any other fail-closed status from the Lua).
    return {
      ok: false,
      reason: "race_lost",
      failOpen: false,
      existingPayload: raw[2] !== undefined && raw[2] !== null ? String(raw[2]) : null,
    };
  }

  /**
   * Release a per-job sub-child lock — deletes ONLY if BOTH the stored nonce
   * AND bootEpoch match the caller's (CWE-367 double-verify, §4.2.2). Uses
   * `EVALSHA` with NOSCRIPT re-pin recovery.
   *
   * Per-job lock を release — nonce AND bootEpoch 双方一致時のみ削除 (§4.2.2)。
   *
   * @returns `true` if released, `false` if not owned / unreachable
   */
  async releasePerJobSubChildLock(
    jobId: string,
    nonce: string,
    bootEpoch: string
  ): Promise<boolean> {
    const jobLockKey = `${PER_JOB_LOCK_KEY_NAMESPACE}${jobId}`;
    try {
      const result = await this.evalShaPerJobRelease(jobLockKey, nonce, bootEpoch);
      return Number(result) === 1;
    } catch (error) {
      logger.warn("[WorkerActiveLock] releasePerJobSubChildLock failed (non-fatal)", {
        error: sanitizeErrorMessage(error),
      });
      return false;
    }
  }

  /** @internal `EVALSHA` per-job release with NOSCRIPT re-pin recovery. */
  private async evalShaPerJobRelease(
    jobLockKey: string,
    nonce: string,
    bootEpoch: string
  ): Promise<unknown> {
    try {
      return await this.redis.evalsha(PER_JOB_RELEASE_SHA, 1, jobLockKey, nonce, bootEpoch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("NOSCRIPT")) {
        await this.redis.script("LOAD", PER_JOB_RELEASE_LUA);
        return await this.redis.evalsha(PER_JOB_RELEASE_SHA, 1, jobLockKey, nonce, bootEpoch);
      }
      throw error;
    }
  }

  /**
   * Scan all per-job sub-child locks under the namespace and decode each
   * payload's `nonce` + `bootEpoch` so the supervisor can reconcile orphans
   * against its own boot epoch (§4.2.2). Uses non-blocking `SCAN` (not `KEYS`)
   * to avoid Redis main-thread stalls.
   *
   * Namespace 配下の全 per-job lock を SCAN で列挙し payload を decode する
   * (§4.2.2 orphan cleanup)。`KEYS` ではなく `SCAN` で Redis stall を回避。
   *
   * @returns Decoded lock entries (empty array on Redis-unreachable, fail-open)
   */
  async scanOrphanPerJobLocks(): Promise<OrphanLockEntry[]> {
    const matchPattern = `${PER_JOB_LOCK_KEY_NAMESPACE}*`;
    const entries: OrphanLockEntry[] = [];
    try {
      let cursor = "0";
      do {
        const [nextCursor, keys] = (await this.redis.scan(
          cursor,
          "MATCH",
          matchPattern,
          "COUNT",
          100
        )) as [string, string[]];
        cursor = nextCursor;
        for (const key of keys) {
          const value = await this.redis.get(key);
          entries.push(this.decodeOrphanEntry(key, value));
        }
      } while (cursor !== "0");
    } catch (error) {
      logger.warn("[WorkerActiveLock] scanOrphanPerJobLocks failed (fail-open, returning none)", {
        error: sanitizeErrorMessage(error),
      });
      return [];
    }
    return entries;
  }

  /** @internal Decode a per-job lock JSON payload into an OrphanLockEntry. */
  private decodeOrphanEntry(key: string, value: string | null): OrphanLockEntry {
    if (value === null) {
      return { key, nonce: null, bootEpoch: null };
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as { nonce?: unknown; bootEpoch?: unknown };
        return {
          key,
          nonce: typeof obj.nonce === "string" ? obj.nonce : null,
          bootEpoch: typeof obj.bootEpoch === "string" ? obj.bootEpoch : null,
        };
      }
    } catch {
      // Undecodable payload — leave nonce/bootEpoch null (treated conservatively
      // as NOT own-origin so it is never auto-deleted by mistake).
    }
    return { key, nonce: null, bootEpoch: null };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Close the underlying Redis connection (only if this service owns it).
   *
   * 所有する Redis 接続を閉じる (自前生成時のみ)。
   */
  async close(): Promise<void> {
    if (this.ownedRedis) {
      try {
        await this.redis.quit();
      } catch {
        // Best-effort close.
      }
    }
  }
}

// ============================================================================
// Convenience helpers
// ============================================================================

/**
 * Generate a fresh boot-token nonce for lock ownership.
 *
 * Lock 所有用の新しい boot-token nonce を生成する。
 */
export function generateBootToken(): string {
  return randomUUID();
}

/**
 * Validate the per-job lock string inputs (non-empty). Extracted so
 * {@link WorkerActiveLockService.acquirePerJobSubChildLock} stays under the
 * cyclomatic-complexity cap (TDA helper-extract).
 *
 * @internal
 */
function validatePerJobLockInputs(jobId: string, nonce: string, bootEpoch: string): void {
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new Error("acquirePerJobSubChildLock: nonce must be a non-empty string");
  }
  if (typeof bootEpoch !== "string" || bootEpoch.length === 0) {
    throw new Error("acquirePerJobSubChildLock: bootEpoch must be a non-empty string");
  }
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new Error("acquirePerJobSubChildLock: jobId must be a non-empty string");
  }
}

/**
 * Resolve a numeric override with NaN/Infinity defense, falling back to a
 * default when the value is absent or non-finite (Standards §NaN/Infinity 防御).
 *
 * @internal
 */
function resolveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}
